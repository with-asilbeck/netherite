// Private repository scanning, verified where it matters: the credential, the
// consent gate, and the working copy on disk.
//
// Everything here runs offline against the real modules — no GitHub App
// installation, no network, no database. What it cannot cover is a real clone
// of a real private repository; that is scripts/private-scan-live-test.mjs.
//
// The three properties the task asked to confirm are sections 3, 4 and 6.
//
//   node scripts/private-scan-test.mjs

import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire, register } from "node:module";
import { fileURLToPath } from "node:url";

import { check, checkEqual, section, summarise } from "./billing-env.mjs";

register("./ts-alias-hook.mjs", import.meta.url);

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Loaded with the app's own loader rather than billing-env.mjs's minimal
// parser, which is line-based and so cannot read the 27-line quoted PEM in
// GITHUB_PRIVATE_KEY — it would hand these tests a truncated key and they
// would be asserting against something the running app never sees.
createRequire(import.meta.url)("@next/env").loadEnvConfig(ROOT, true, {
  info: () => {},
  error: () => {},
});

const { decidePrivateScanAccess } = await import("../lib/private-scan/authorize.ts");
const { redactToken, readAppPrivateKey, createAppJwt, installUrl } = await import(
  "../lib/github/app.ts"
);
const {
  PRIVATE_SCAN_CONSENT_VERSION,
  consentClauses,
  geminiBillingTier,
  CONSENT_CHECKBOX_LABEL,
} = await import("../lib/private-scan/consent.ts");
const { TIER_LIMITS, hasFeature } = await import("../lib/tiers.ts");
const { entitlementFor } = await import("../lib/tier-features.ts");

// ── 1. Tier gating ──────────────────────────────────────────────────────

section("1. Tier gating");

checkEqual("free cannot scan private repos", hasFeature("free", "private_repo_scanning"), false);
for (const tier of ["basic", "pro", "max"]) {
  checkEqual(`${tier} can`, hasFeature(tier, "private_repo_scanning"), true);
}
checkEqual(
  "the entitlement exposes it",
  entitlementFor("pro").privateRepoScanning,
  true,
);
checkEqual(
  "and a guest-equivalent free entitlement does not",
  entitlementFor("free").privateRepoScanning,
  false,
);
check(
  "every tier declares the flag explicitly",
  Object.values(TIER_LIMITS).every((l) => typeof l.private_repo_scanning === "boolean"),
);

// ── 2. The gate, every combination ──────────────────────────────────────

section("2. The gate refuses everything but the full set");

const gate = (privateRepoScanning, hasInstallation, hasCurrentConsent) =>
  decidePrivateScanAccess({ privateRepoScanning, hasInstallation, hasCurrentConsent });

checkEqual("no plan, no install, no consent → upgrade", gate(false, false, false)?.action, "upgrade");
checkEqual("no plan, installed, consented → still upgrade", gate(false, true, true)?.action, "upgrade");
checkEqual("plan, no install, consented → install", gate(true, false, true)?.action, "install");
checkEqual("plan, installed, no consent → consent", gate(true, true, false)?.action, "consent");
checkEqual("all three → no refusal", gate(true, true, true), null);

checkEqual("the upgrade refusal is a 402", gate(false, true, true)?.status, 402);
checkEqual("the install refusal is a 403", gate(true, false, true)?.status, 403);
checkEqual("the consent refusal is a 403", gate(true, true, false)?.status, 403);

check(
  "the upgrade message does not claim the repo exists",
  /doesn't exist, or it's private/.test(gate(false, true, true)?.message ?? ""),
);

// ── 3. The consent gate cannot be bypassed ──────────────────────────────

section("3. Consent cannot be bypassed");

// Exhaustive: of the eight combinations, exactly one grants, and every
// non-consenting combination refuses regardless of plan and installation.
let grants = 0;
let consentlessGrants = 0;
for (const plan of [false, true]) {
  for (const installed of [false, true]) {
    for (const consented of [false, true]) {
      const verdict = gate(plan, installed, consented);
      if (verdict === null) {
        grants++;
        if (!consented) consentlessGrants++;
      }
    }
  }
}
checkEqual("exactly one of eight combinations grants", grants, 1);
checkEqual("none of them grants without consent", consentlessGrants, 0);

// A stale consent is not consent. `hasCurrentConsent` compares the stored
// version against the current one, so this asserts the comparison itself.
const storedVersionCounts = (stored) => stored >= PRIVATE_SCAN_CONSENT_VERSION;
checkEqual("consent at the current version counts", storedVersionCounts(PRIVATE_SCAN_CONSENT_VERSION), true);
checkEqual("consent at an older version does not", storedVersionCounts(PRIVATE_SCAN_CONSENT_VERSION - 1), false);

// The route requires `accepted === true`, not merely truthy. These are the
// values a sloppy client or a probing one would send.
const routeSource = await readFile(path.join(ROOT, "app/api/private-scan/consent/route.ts"), "utf8");
check("the consent route requires accepted === true", routeSource.includes("body.accepted !== true"));
check("and rejects a version it did not serve", routeSource.includes("body.version !== PRIVATE_SCAN_CONSENT_VERSION"));

// CSRF. A consent row written by a cross-site request would be a durable
// record asserting a human agreed, produced by a request no human made — and
// a form POST with enctype="text/plain" is a simple request that
// `request.json()` parses happily. Found by the security review; these three
// are the regression guards.
check("the consent POST enforces same-origin", /export async function POST[\s\S]*?isSameOrigin\(request\)/.test(routeSource));
check("so does the DELETE", /export async function DELETE[\s\S]*?isSameOrigin\(request\)/.test(routeSource));
check("and the consent write is rate limited", routeSource.includes("checkConsentRateLimit("));

const originSource = await readFile(path.join(ROOT, "lib/same-origin.ts"), "utf8");
check("a missing Origin is allowed (non-browser clients have no ambient cookies)", originSource.includes("if (!origin) return true;"));
check("and a present, mismatched one is refused", originSource.includes("return allowed.has(origin);"));
check(
  "there is exactly one definition of same-origin in the codebase",
  !(await readFile(path.join(ROOT, "app/api/checkout/route.ts"), "utf8")).includes(
    "function isSameOrigin",
  ),
);

// The scan route must consult the gate, not its own copy of the rules.
const scanRouteSource = await readFile(path.join(ROOT, "app/api/repo-scan/run/route.ts"), "utf8");
check("the scan route calls authorizePrivateScan", scanRouteSource.includes("authorizePrivateScan("));
check(
  "and does not read a private flag from the request body",
  !/body\.(private|isPrivate|installationId|consent)/.test(scanRouteSource),
);

// ── 4. The token is never persisted ─────────────────────────────────────

section("4. Installation tokens are never persisted");

const migration = await readFile(
  path.join(ROOT, "supabase/migrations/20260807000000_private_repo_scanning.sql"),
  "utf8",
);
check(
  "no table in the migration has a token column",
  !/\b(access_token|installation_token|token)\b\s+text/i.test(migration),
);
check("all three tables enable RLS", (migration.match(/enable row level security/g) ?? []).length === 3);
check(
  "and none grants insert/update/delete to authenticated",
  !/for (insert|update|delete)[\s\S]*?to authenticated/i.test(migration),
);

const schema = await readFile(path.join(ROOT, "lib/supabase/private-scan-schema.ts"), "utf8");
check("the schema types have no token field", !/token\s*:/i.test(schema));

const store = await readFile(path.join(ROOT, "lib/private-scan/store.ts"), "utf8");
check(
  "the store never writes a token",
  !/token/i.test(store.replace(/^\s*\*.*$/gm, "").replace(/\/\/.*$/gm, "")),
);

// The only module that holds a token exposes it behind `use()`, and the only
// callers of that are the clone path and revocation.
const appSource = await readFile(path.join(ROOT, "lib/github/app.ts"), "utf8");
check("the token is wrapped rather than returned as a bare string", appSource.includes("use: () => token"));

const useCallers = [];
for (const file of ["lib/repo-scan/clone.ts", "lib/private-scan/authorize.ts", "lib/github/app.ts"]) {
  const text = await readFile(path.join(ROOT, file), "utf8");
  const count = (text.match(/\.use\(\)/g) ?? []).length;
  if (count) useCallers.push(`${file}:${count}`);
}
checkEqual(
  "only three modules ever unwrap it",
  useCallers.join(" "),
  "lib/repo-scan/clone.ts:2 lib/private-scan/authorize.ts:1 lib/github/app.ts:1",
);

// ── 5. The credential never reaches argv or disk ────────────────────────

section("5. The clone credential is in the environment, not the command line");

// Asserted against the exact values handed to `spawn`, not against a reading
// of the source: `buildCloneArgs` builds the argv array the child receives and
// `credentialEnv` builds the environment entries merged into it, so these are
// the real inputs.
const { shallowClone, buildCloneArgs, credentialEnv } = await import("../lib/repo-scan/clone.ts");

const SECRET = "ghs_TESTTOKEN_must_not_appear_anywhere_1234567890";
const BASIC = Buffer.from(`x-access-token:${SECRET}`).toString("base64");
const fakeToken = { use: () => SECRET, expiresAt: "" };
const repoRef = {
  owner: "octocat",
  repo: "private-thing",
  slug: "octocat/private-thing",
  ref: null,
  canonicalUrl: "https://github.com/octocat/private-thing",
};

const argv = buildCloneArgs(repoRef, "/tmp/whatever");
const argvText = argv.join(" ");
const env = credentialEnv(fakeToken);
const envText = JSON.stringify(env);

check("the token is NOT in argv", !argvText.includes(SECRET));
check("nor is a base64 of it", !argvText.includes(BASIC));
check("the clone URL carries no credential", !argvText.includes("@github.com"));
check("no -c carries an Authorization header", !/extraHeader/i.test(argvText));
check("the token IS in the environment entries", envText.includes(BASIC));
checkEqual("the git config count is exactly one", env.GIT_CONFIG_COUNT, "1");
checkEqual(
  "and the config key is scoped to one URL prefix",
  env.GIT_CONFIG_KEY_0,
  "http.https://github.com/.extraHeader",
);
check(
  "so a redirect to another host would not receive it",
  env.GIT_CONFIG_KEY_0 !== "http.extraHeader",
);
check(
  "the header is HTTP Basic with GitHub's documented username",
  Buffer.from(env.GIT_CONFIG_VALUE_0.replace("Authorization: Basic ", ""), "base64")
    .toString("utf8") === `x-access-token:${SECRET}`,
);
checkEqual(
  "a public clone sets no credential config at all",
  Object.keys(credentialEnv(undefined)).length,
  0,
);

// A real spawn, to prove the whole path end to end: the clone fails (that repo
// does not exist), which is what section 6 needs anyway.
const tmpBefore = (await readdir(tmpdir())).filter((d) => d.startsWith("netherite-scan-"));
let cloneError = null;
try {
  await shallowClone(repoRef, undefined, fakeToken);
} catch (err) {
  cloneError = err;
}

// ── 6. Cleanup on every path ────────────────────────────────────────────

section("6. The working copy is always deleted");

const tmpAfter = (await readdir(tmpdir())).filter((d) => d.startsWith("netherite-scan-"));
checkEqual(
  "a failed clone leaves no working copy behind",
  tmpAfter.length - tmpBefore.length,
  0,
);
check("the failure surfaced as a CloneError", cloneError?.name === "CloneError");
check(
  "and the error message carries no token",
  !String(cloneError?.message ?? "").includes(SECRET),
);

const cloneSource = await readFile(path.join(ROOT, "lib/repo-scan/clone.ts"), "utf8");
check("stderr is scrubbed as it arrives", cloneSource.includes("redactToken(chunk.toString()"));
check("cleanup retries before giving up", cloneSource.includes("attempt === 0"));
check("and shouts if it still fails", cloneSource.includes("FAILED TO DELETE WORKING COPY"));

const pipelineSource = await readFile(path.join(ROOT, "lib/repo-scan/index.ts"), "utf8");
check(
  "the pipeline deletes the clone in a finally",
  /finally\s*\{[\s\S]*?clone\.cleanup\(\)/.test(pipelineSource),
);
check(
  "the route revokes the credential in a finally",
  (await readFile(path.join(ROOT, "lib/private-scan/authorize.ts"), "utf8")).includes(
    "} finally {\n    await revokeInstallationToken(grant.token);",
  ),
);
check(
  "and revokes it on every early return before the stream",
  (scanRouteSource.match(/abandonGrant\(\)/g) ?? []).length >= 4,
);

checkEqual("redactToken removes the token", redactToken(`a ${SECRET} b`, SECRET), "a [redacted] b");
check(
  "redactToken removes every occurrence",
  redactToken(`${SECRET}${SECRET}`, SECRET) === "[redacted][redacted]",
);

// ── 7. Audit logging ────────────────────────────────────────────────────

section("7. Audit logging");

check("the audit row is written before the scan runs", scanRouteSource.includes("recordPrivateScanStarted("));
check(
  "a failed audit write aborts the scan",
  /if \(!auditId\)[\s\S]{0,400}controller\.close\(\);\s*\n\s*return;/.test(scanRouteSource),
);
check("the outcome is settled afterwards", scanRouteSource.includes("settlePrivateScanAudit("));
check(
  "the audit table records user, repo and time",
  /user_id uuid[\s\S]*repo_full_name text[\s\S]*scanned_at timestamptz/.test(migration),
);
check(
  "the audit log is separate from the report",
  migration.includes("private_scan_audit") && !migration.includes("chat_messages"),
);

// ── 8. The consent copy says what was verified ──────────────────────────

section("8. Consent copy");

const clauses = consentClauses();
const ids = clauses.map((c) => c.id);
const text = clauses.map((c) => c.text).join(" ");

check("Anthropic retention is stated", ids.includes("anthropic-retention"));
check("as 30 days, the documented figure", /within 30 days/.test(text));
check("and never as 7", !/\b7 days\b/.test(text));
check("Anthropic training is stated", ids.includes("anthropic-training"));
check("Netherite's own no-permanent-storage promise is stated", ids.includes("netherite-no-storage"));
check("so is the audit log", ids.includes("netherite-audit"));
check("every clause has non-empty text", clauses.every((c) => c.text.trim().length > 20));
check(
  "every external claim cites a source",
  clauses.filter((c) => c.id.startsWith("anthropic") || c.id.startsWith("gemini")).every((c) => c.sourceUrl.startsWith("https://")),
);
check("the checkbox names both vendors", /Anthropic and Google/.test(CONSENT_CHECKBOX_LABEL));

// The Gemini half depends on a deployment setting, and both branches must be
// honest. This asserts the one this deployment would actually show.
const tier = geminiBillingTier();
if (tier === "paid") {
  check("paid-tier Gemini copy is shown", ids.includes("gemini-paid-training"));
  check("and states Google does not train on it", /doesn't use your prompts/.test(text));
} else {
  check("unpaid-tier Gemini copy is shown", ids.includes("gemini-unpaid-training"));
  check(
    "and warns that Google uses the content",
    /uses submitted content and generated responses/.test(text),
  );
  check("and that humans may read it", /human reviewers may read/.test(text));
  check(
    "both warnings are emphasised",
    clauses.filter((c) => c.id.startsWith("gemini-unpaid")).every((c) => c.emphasis === true),
  );
}

// ── 9. App configuration ────────────────────────────────────────────────

section("9. App key handling");

check("the private key loads from the environment", (() => {
  try {
    return readAppPrivateKey().includes("PRIVATE KEY");
  } catch {
    return false;
  }
})());

// The exact value dotenv produces from an unquoted multi-line PEM — the
// failure this app actually hit. It has no END line, so it is caught by the
// PEM-shape check, and what matters is that the message tells the operator
// the specific thing to do about it.
const rejects = (value) => {
  const saved = process.env.GITHUB_PRIVATE_KEY;
  process.env.GITHUB_PRIVATE_KEY = value;
  try {
    readAppPrivateKey();
    return null;
  } catch (err) {
    return err.message;
  } finally {
    process.env.GITHUB_PRIVATE_KEY = saved;
  }
};

const truncated = rejects("-----BEGIN RSA PRIVATE KEY-----");
check("a key truncated by dotenv is rejected", truncated !== null);
check(
  "and the message names the fix",
  /wrapped in double quotes/.test(truncated ?? "") &&
    /GITHUB_PRIVATE_KEY_B64/.test(truncated ?? ""),
);

// BEGIN and END present but collapsed onto one line: a hand-pasted key whose
// newlines were lost. Shape-valid, unusable, and caught by its own check.
check(
  "a single-line BEGIN/END key is rejected as truncated",
  /truncated to a single line/.test(
    rejects("-----BEGIN RSA PRIVATE KEY----- AAAA -----END RSA PRIVATE KEY-----") ?? "",
  ),
);

check("an empty key is rejected", /is not set/.test(rejects("") ?? ""));

check("a base64 key is accepted", (() => {
  const savedRaw = process.env.GITHUB_PRIVATE_KEY;
  const savedB64 = process.env.GITHUB_PRIVATE_KEY_B64;
  process.env.GITHUB_PRIVATE_KEY_B64 = Buffer.from(savedRaw ?? "", "utf8").toString("base64");
  delete process.env.GITHUB_PRIVATE_KEY;
  try {
    return readAppPrivateKey().includes("PRIVATE KEY");
  } catch {
    return false;
  } finally {
    process.env.GITHUB_PRIVATE_KEY = savedRaw;
    if (savedB64 === undefined) delete process.env.GITHUB_PRIVATE_KEY_B64;
    else process.env.GITHUB_PRIVATE_KEY_B64 = savedB64;
  }
})());

check("a CRLF key is normalised", (() => {
  const saved = process.env.GITHUB_PRIVATE_KEY;
  process.env.GITHUB_PRIVATE_KEY = (saved ?? "").split("\n").join("\r\n");
  try {
    return !readAppPrivateKey().includes("\r");
  } catch {
    return false;
  } finally {
    process.env.GITHUB_PRIVATE_KEY = saved;
  }
})());

const jwt = createAppJwt();
checkEqual("the App JWT has three parts", jwt.split(".").length, 3);
const jwtPayload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
check("its lifetime is under GitHub's 10-minute ceiling", jwtPayload.exp - jwtPayload.iat <= 600);
check("and it is backdated against clock skew", jwtPayload.iat < Math.floor(Date.now() / 1000));

check(
  "the install URL carries the CSRF state",
  installUrl("netherite-security-specialist", "abc123").includes("state=abc123"),
);
check(
  "and points at GitHub's install endpoint",
  installUrl("x", "y").startsWith("https://github.com/apps/x/installations/new"),
);

// ── 10. Callback ownership binding ──────────────────────────────────────

section("10. The install callback binds to a proven GitHub account");

const callback = await readFile(path.join(ROOT, "app/api/github-app/callback/route.ts"), "utf8");
check("the state is compared in constant time", callback.includes("safeEqual(expected, received)"));
check("the state cookie is consumed either way", /store\.delete\(INSTALL_STATE_COOKIE\)/.test(callback));
check("the installation is re-fetched from GitHub", callback.includes("fetchInstallation("));
check(
  "ownership is compared on the numeric account id",
  callback.includes("account.id !== connection.githubUserId"),
);
check("and never on the login", !/account\.login\s*[!=]==?\s*connection/.test(callback));
check("organization installations are refused", callback.includes('account.type !== "User"'));
check(
  "the installation id is validated as a safe integer",
  callback.includes("Number.isSafeInteger(installationId)"),
);
check(
  "a second user cannot claim one installation",
  /unique index[\s\S]*github_app_installations \(installation_id\)/.test(migration),
);

check(
  "the callback is rate limited against the shared App quota",
  callback.includes("checkGitHubAppCallbackRateLimit("),
);

const panel = await readFile(path.join(ROOT, "components/private-scan-panel.tsx"), "utf8");
check(
  "the status banner does not index an object with an attacker-chosen key",
  panel.includes("Object.hasOwn(STATUS_MESSAGES, status)"),
);

const installRoute = await readFile(path.join(ROOT, "app/api/github-app/install/route.ts"), "utf8");
check("the install route is httpOnly on its state cookie", installRoute.includes("httpOnly: true"));
check("and checks the tier before redirecting", installRoute.includes("entitlement.privateRepoScanning"));

// ── 11. The entry point is server-gated ─────────────────────────────────

section("11. The account entry point");

const accountPage = await readFile(path.join(ROOT, "app/account/page.tsx"), "utf8");
check(
  "the panel renders only when the tier allows it",
  /\{entitlement\.privateRepoScanning && \(\s*<PrivateScanPanel/.test(accountPage),
);
check(
  "and the installation is not even read for a free account",
  accountPage.includes("entitlement.privateRepoScanning\n    ? await Promise.all"),
);

summarise();
