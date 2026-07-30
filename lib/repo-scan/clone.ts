import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GitHubRepoRef } from "@/lib/github-repo";
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
 * - **`GIT_TERMINAL_PROMPT=0`.** A private repo fails immediately with
 *   "Authentication failed" instead of blocking forever on a username prompt.
 */
export async function shallowClone(
  repo: GitHubRepoRef,
  outerSignal?: AbortSignal,
): Promise<Clone> {
  await assertResolvesToPublicGitHub(new URL(repo.canonicalUrl).hostname);

  const dir = await mkdtemp(path.join(tmpdir(), "netherite-scan-"));
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  const url = `${repo.canonicalUrl}.git`;
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
  args.push("--", url, dir);

  try {
    await runGit(args, outerSignal);
  } catch (err) {
    await cleanup();
    throw err;
  }

  return { dir, cleanup };
}

function runGit(args: string[], outerSignal?: AbortSignal): Promise<void> {
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
      if (stderr.length < 8_000) stderr += chunk.toString();
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
      finish(() => reject(new CloneError(explainGitFailure(stderr))));
    });
  });
}

/** Turns git's stderr into something a user can act on. */
function explainGitFailure(stderr: string): string {
  const text = stderr.toLowerCase();

  if (text.includes("repository not found") || text.includes("could not read from remote")) {
    return "That repository doesn't exist or is private. Only public GitHub repositories can be scanned.";
  }
  if (text.includes("authentication failed") || text.includes("could not read username")) {
    return "That repository is private — this scanner has no GitHub credentials and only reads public repositories.";
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
