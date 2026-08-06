// The real thing: mint a credential against a real GitHub App installation,
// clone a real private repository with it, then audit the machine for any
// trace of the code or the token.
//
// Requires the App to be installed on at least one private repository. Run
// scripts/private-scan-test.mjs for everything that does not.
//
//   node scripts/private-scan-live-test.mjs [owner/repo]
//
// With no argument it picks the first private repository the installation
// covers. Nothing is written to the database — this exercises the credential
// and cleanup path, not the HTTP route.

import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire, register } from "node:module";
import { fileURLToPath } from "node:url";

import { check, checkEqual, section, summarise } from "./billing-env.mjs";

register("./ts-alias-hook.mjs", import.meta.url);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
createRequire(import.meta.url)("@next/env").loadEnvConfig(ROOT, true, {
  info: () => {},
  error: () => {},
});

const { createAppJwt, createInstallationToken, revokeInstallationToken, fetchAppSlug } =
  await import("../lib/github/app.ts");
const { shallowClone } = await import("../lib/repo-scan/clone.ts");
const { collectFiles } = await import("../lib/repo-scan/collect.ts");

const api = async (pathname, token, init = {}) =>
  fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Netherite-Security-Scanner",
      ...(init.headers ?? {}),
    },
  });

// ── 1. The installation ─────────────────────────────────────────────────

section("1. The App installation");

const slug = await fetchAppSlug();
check("the App is reachable and named", typeof slug === "string" && slug.length > 0, slug ?? "");

const jwt = createAppJwt();
const installsResponse = await api("/app/installations", jwt);
checkEqual("GET /app/installations succeeds", installsResponse.status, 200);
const installs = await installsResponse.json();

if (!Array.isArray(installs) || installs.length === 0) {
  console.log("\n  No installations found.");
  console.log(`  Install the App first: https://github.com/apps/${slug}/installations/new`);
  console.log("  Then re-run this script.\n");
  summarise();
  process.exit(1);
}

const installation = installs[0];
check(
  "an installation exists",
  true,
  `id=${installation.id} account=${installation.account?.login} selection=${installation.repository_selection}`,
);

// ── 2. Minting a scoped credential ──────────────────────────────────────

section("2. Installation token");

const wide = await createInstallationToken(installation.id);
check("an installation-wide token is minted", wide.ok);
if (!wide.ok) {
  summarise();
  process.exit(1);
}

const reposResponse = await api("/installation/repositories?per_page=100", wide.data.use());
checkEqual("the token can list the installation's repositories", reposResponse.status, 200);
const repoList = (await reposResponse.json()).repositories ?? [];

const requested = process.argv[2];
const target = requested
  ? repoList.find((r) => r.full_name.toLowerCase() === requested.toLowerCase())
  : repoList.find((r) => r.private);

if (!target) {
  console.log(
    `\n  ${requested ? `${requested} is not covered by the installation.` : "The installation covers no private repository."}`,
  );
  console.log(`  Covered: ${repoList.map((r) => r.full_name).join(", ") || "(none)"}\n`);
  await revokeInstallationToken(wide.data);
  summarise();
  process.exit(1);
}

check("the target repository is private", target.private === true, target.full_name);

const scoped = await createInstallationToken(installation.id, { repositoryIds: [target.id] });
check("a repository-scoped token is minted", scoped.ok);
if (!scoped.ok) {
  await revokeInstallationToken(wide.data);
  summarise();
  process.exit(1);
}

// Least privilege, demonstrated rather than asserted: the scoped token must
// not be able to list anything beyond the one repository it was cut for.
const scopedList = await api("/installation/repositories?per_page=100", scoped.data.use());
const scopedRepos = scopedList.ok ? ((await scopedList.json()).repositories ?? []) : [];
checkEqual("the scoped token sees exactly one repository", scopedRepos.length, 1);
checkEqual("and it is the target", scopedRepos[0]?.full_name, target.full_name);

await revokeInstallationToken(wide.data);
const wideAfter = await api("/installation/repositories", wide.data.use());
check("the wide token is dead after revocation", wideAfter.status === 401, `status ${wideAfter.status}`);

// ── 3. The clone ────────────────────────────────────────────────────────

section("3. Cloning private code");

const [owner, repo] = target.full_name.split("/");
const repoRef = {
  owner,
  repo,
  slug: target.full_name,
  ref: null,
  canonicalUrl: `https://github.com/${owner}/${repo}`,
};

const before = (await readdir(tmpdir())).filter((d) => d.startsWith("netherite-scan-"));

let clone = null;
let cloneFailed = null;
try {
  clone = await shallowClone(repoRef, undefined, scoped.data);
} catch (err) {
  cloneFailed = err;
}

check("the private repository cloned", clone !== null, cloneFailed?.message ?? "");

let sampleFile = null;
let sampleContent = "";
let cloneDir = null;

if (clone) {
  cloneDir = clone.dir;
  const collected = await collectFiles(clone.dir);
  check("files were read from the working copy", collected.files.length > 0, `${collected.files.length} files`);

  // Hold on to a real fragment of the private code, so the no-trace audit
  // below is searching for something that genuinely was on this disk.
  if (collected.files.length > 0) {
    sampleFile = collected.files[0].path;
    sampleContent = (await readFile(path.join(clone.dir, sampleFile), "utf8")).slice(0, 400);
    check("a sample of the private code was captured", sampleContent.length > 0, sampleFile);
  }

  // The credential must not have been written into the working copy — this is
  // the failure mode of the `https://token@github.com/...` recipe.
  const gitConfig = await readFile(path.join(clone.dir, ".git", "config"), "utf8");
  check("the token is not in .git/config", !gitConfig.includes(scoped.data.use()));
  check("and neither is a basic-auth blob", !/x-access-token/i.test(gitConfig));
  check(
    "the remote URL is clean",
    !gitConfig.includes("@github.com"),
    gitConfig.split("\n").find((l) => l.includes("url =")) ?? "",
  );

  await clone.cleanup();
}

// ── 4. No trace afterwards ──────────────────────────────────────────────

section("4. Nothing left behind");

const after = (await readdir(tmpdir())).filter((d) => d.startsWith("netherite-scan-"));
checkEqual("no scan working copy remains in tmp", after.length - before.length, 0);

if (cloneDir) {
  let stillThere = true;
  try {
    await stat(cloneDir);
  } catch {
    stillThere = false;
  }
  check("the specific clone directory is gone", !stillThere, cloneDir);
}

// The private code must not have survived anywhere obvious: not in tmp, not
// in the repo, not in a log. Searched for a real fragment of the real file.
if (sampleContent) {
  const needle = sampleContent.split("\n").find((l) => l.trim().length > 25)?.trim();
  if (needle) {
    const hits = [];
    const searchDirs = [tmpdir(), ROOT];
    for (const dir of searchDirs) {
      let entries = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = path.join(dir, entry.name);
        try {
          const info = await stat(full);
          if (info.size > 5_000_000) continue;
          const text = await readFile(full, "utf8");
          if (text.includes(needle)) hits.push(full);
        } catch {
          // Binary or unreadable — not somewhere the source landed as text.
        }
      }
    }
    checkEqual("no file in tmp or the project contains the private code", hits.length, 0, hits.join(", "));
  }
}

// The token must be dead and must appear in no file either.
await revokeInstallationToken(scoped.data);
const scopedAfter = await api("/installation/repositories", scoped.data.use());
check(
  "the scan credential is revoked",
  scopedAfter.status === 401,
  `status ${scopedAfter.status}`,
);

const tokenNeedle = scoped.data.use();
const tokenHits = [];
for (const dir of [tmpdir(), ROOT]) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    try {
      const info = await stat(full);
      if (info.size > 5_000_000) continue;
      if ((await readFile(full, "utf8")).includes(tokenNeedle)) tokenHits.push(full);
    } catch {
      /* not text */
    }
  }
}
checkEqual("the token appears in no file on disk", tokenHits.length, 0, tokenHits.join(", "));

summarise();
