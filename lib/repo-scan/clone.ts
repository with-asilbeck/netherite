import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GitHubRepoRef } from "@/lib/github-repo";
import { redactToken, type InstallationToken } from "@/lib/github/app";
import { CLONE_TIMEOUT_MS } from "./config";
import { assertResolvesToPublicGitHub } from "./ssrf";

export class CloneError extends Error {
  /** True when retrying is pointless (private repo, bad ref, missing repo). */
  readonly permanent: boolean;

  constructor(message: string, permanent = true) {
    super(message);
    this.name = "CloneError";
    this.permanent = permanent;
  }
}

export type Clone = {
  dir: string;
  cleanup: () => Promise<void>;
};

/**
 * Shallow-clones a validated GitHub repo into a fresh temp directory.
 *
 * Safety properties, all deliberate:
 * - **No shell.** `spawn` with an argv array and no `shell` option, so
 *   nothing in owner/repo/ref can be interpreted as a command. Those values
 *   are already restricted to `[A-Za-z0-9._-]` by parseGitHubRepoUrl, but
 *   argv is what makes that irrelevant rather than load-bearing.
 * - **URL is reconstructed, not echoed.** Built from validated segments.
 * - **DNS checked first** (see ssrf.ts) so a tampered resolution can't send
 *   the clone at localhost or a metadata endpoint.
 * - **`core.symlinks=false`.** A repo can contain a symlink pointing at
 *   `/etc/passwd` or `../../`; with this set git writes the link target as
 *   plain file text instead of creating a link, so the file walker cannot be
 *   walked out of the clone directory.
 * - **No hooks, no submodules, no credential helpers, no user/system
 *   config.** Nothing from the repo or the host's git config runs.
 * - **`GIT_TERMINAL_PROMPT=0`.** A repo we hold no credential for fails
 *   immediately with "Authentication failed" instead of blocking forever on a
 *   username prompt.
 *
 * ## Cloning a private repository
 *
 * Pass `auth` and the clone authenticates as a GitHub App installation. Three
 * rules govern how that credential is handled, and all three are structural
 * rather than conventional:
 *
 * 1. **Never in argv.** `-c http.extraHeader=…` would work and is what most
 *    examples show, but process arguments are world-readable on Linux via
 *    `/proc/<pid>/cmdline` — any other process on the box could read the
 *    token while the clone runs. It goes through `GIT_CONFIG_COUNT` /
 *    `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` instead, so it lives in the
 *    child's environment, which is readable only by the same user.
 *
 * 2. **Never in the URL.** `https://x-access-token:TOKEN@github.com/…` is the
 *    other common recipe. It puts the credential in argv *and* in git's own
 *    error messages, and git writes remote URLs into `.git/config` — which
 *    would mean the token landing on disk inside the clone directory.
 *
 * 3. **Scoped to one URL prefix.** The config key is
 *    `http.https://github.com/.extraHeader`, not the bare `http.extraHeader`.
 *    Git only sends a URL-matched header to URLs under that prefix, so if a
 *    redirect ever pointed the clone at another host, the credential would
 *    not follow it. The bare form would.
 *
 * The token is also scrubbed out of git's stderr before that text reaches an
 * error message or a log line.
 */
export async function shallowClone(
  repo: GitHubRepoRef,
  outerSignal?: AbortSignal,
  auth?: InstallationToken,
): Promise<Clone> {
  await assertResolvesToPublicGitHub(new URL(repo.canonicalUrl).hostname);

  const dir = await mkdtemp(path.join(tmpdir(), "netherite-scan-"));

  /**
   * Removes the working copy. Called from `scanRepository`'s `finally`, so it
   * runs on success, error, timeout, abort and client disconnect alike.
   *
   * Retried once, and loud on failure. The previous version swallowed errors
   * silently, which was defensible when every clone was public code that is
   * already on the internet. It is not defensible for a private repository:
   * "the working copy could not be deleted" is the single most important
   * thing an operator could be told, and it must not be the one line that
   * gets discarded. A transient Windows/AV file lock is the common cause,
   * hence the retry before giving up.
   */
  const cleanup = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch (err) {
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        console.error(
          `[repo-scan] FAILED TO DELETE WORKING COPY at ${dir} — remove it manually:`,
          err,
        );
      }
    }
  };

  const args = buildCloneArgs(repo, dir);

  try {
    await runGit(args, outerSignal, auth);
  } catch (err) {
    await cleanup();
    throw err;
  }

  return { dir, cleanup };
}

/**
 * The exact argv handed to `git`. Exported so scripts/private-scan-test.mjs
 * can assert on the real array rather than on a reading of this file — the
 * property being checked ("no credential is ever in argv") is only meaningful
 * against what actually gets passed to spawn.
 */
export function buildCloneArgs(repo: GitHubRepoRef, dir: string): string[] {
  const args = [
    "-c",
    "core.symlinks=false",
    "-c",
    "core.hooksPath=",
    "-c",
    "credential.helper=",
    "-c",
    "advice.detachedHead=false",
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--no-tags",
    "--no-recurse-submodules",
    "--quiet",
  ];
  if (repo.ref) args.push("--branch", repo.ref);
  // The URL is rebuilt from validated segments and carries no credential —
  // see rule 2 in shallowClone's doc comment.
  args.push("--", `${repo.canonicalUrl}.git`, dir);
  return args;
}

/**
 * The credential, as environment entries rather than arguments. See rule 1 in
 * `shallowClone`'s doc comment for why this is not `-c`.
 *
 * GitHub's documented scheme for an installation token over HTTPS is HTTP
 * Basic with the literal username `x-access-token` and the token as the
 * password.
 *
 * Exported for the same reason `buildCloneArgs` is.
 */
export function credentialEnv(auth: InstallationToken | undefined): Record<string, string> {
  if (!auth) return {};
  const basic = Buffer.from(`x-access-token:${auth.use()}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    // URL-scoped, so the header cannot follow a redirect to another host.
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

function runGit(
  args: string[],
  outerSignal?: AbortSignal,
  auth?: InstallationToken,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        // No interactive auth: fail fast instead of waiting on a prompt.
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        // Ignore host git config so a developer's or image's settings
        // (aliases, insteadOf rewrites, proxies) can't alter this clone.
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        ...credentialEnv(auth),
      },
    });

    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onAbort);
      fn();
    };

    child.stderr.on("data", (chunk) => {
      // Bounded: a hostile remote could otherwise stream stderr forever.
      // Scrubbed as it arrives rather than at the point of use, so there is
      // no window in which the raw token sits in a string that some later
      // edit might log.
      if (stderr.length < 8_000) {
        stderr += auth ? redactToken(chunk.toString(), auth.use()) : chunk.toString();
      }
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new CloneError(
            `Cloning took longer than ${Math.round(
              CLONE_TIMEOUT_MS / 1000,
            )}s and was stopped. The repository is probably too large to scan.`,
          ),
        ),
      );
    }, CLONE_TIMEOUT_MS);

    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => reject(new CloneError("Scan cancelled.", false)));
    };
    outerSignal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      const missingGit = (err as NodeJS.ErrnoException).code === "ENOENT";
      finish(() =>
        reject(
          new CloneError(
            missingGit
              ? "git isn't available on this server, so repositories can't be cloned here."
              : `Couldn't start git: ${err.message}`,
          ),
        ),
      );
    });

    child.on("close", (code) => {
      if (code === 0) return finish(resolve);
      finish(() => reject(new CloneError(explainGitFailure(stderr, Boolean(auth)))));
    });
  });
}

/**
 * Turns git's stderr into something a user can act on.
 *
 * `authenticated` changes what the same git error means. Without a credential,
 * "repository not found" means "public repos only". With an installation
 * token it means the installation does not cover that repository — a
 * different problem with a different fix, and telling a paying customer to
 * make their repo public would be nonsense.
 */
function explainGitFailure(stderr: string, authenticated: boolean): string {
  const text = stderr.toLowerCase();

  if (text.includes("repository not found") || text.includes("could not read from remote")) {
    return authenticated
      ? "That repository isn't covered by your GitHub App installation. Open your installation settings on GitHub and grant Netherite access to it, then try again."
      : "That repository doesn't exist or is private. Only public GitHub repositories can be scanned.";
  }
  if (text.includes("authentication failed") || text.includes("could not read username")) {
    return authenticated
      ? "GitHub rejected the installation credential for that repository. It may have been uninstalled — reconnect private repository scanning from your account page."
      : "That repository is private — this scanner has no GitHub credentials and only reads public repositories.";
  }
  if (text.includes("remote branch") && text.includes("not found")) {
    return "That branch or tag doesn't exist in the repository.";
  }
  if (text.includes("empty repository") || text.includes("you appear to have cloned an empty")) {
    return "That repository is empty — there's nothing to scan.";
  }
  if (text.includes("could not resolve host") || text.includes("network is unreachable")) {
    return "Couldn't reach github.com from this server.";
  }

  const firstLine = stderr.split("\n").find((l) => l.trim().length > 0)?.trim();
  console.error("[repo-scan] unrecognized git failure:", stderr.slice(0, 500));
  return firstLine
    ? `Cloning failed: ${firstLine.slice(0, 200)}`
    : "Cloning failed for an unknown reason.";
}
