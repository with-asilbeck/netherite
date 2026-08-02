/**
 * The ownership gate. Nothing clones a repository until this says yes.
 *
 * The rule (CLAUDE.md's feature spec): a scan is allowed only if the
 * requesting user *owns* the repo, or GitHub reports they have push access
 * to it. Both halves of that come from GitHub itself via `GET /repos`, using
 * the user's own OAuth token — this app never decides for itself who owns
 * what, and never trusts a claim from the request body.
 *
 * Why this cannot be bypassed by pasting someone else's URL: the only input
 * from the caller is `owner`/`repo`. The token is loaded from
 * github_connections keyed by the *session* user id, and the verdict comes
 * from what GitHub says that token can do with that repo. Substituting a
 * different URL just asks GitHub about a different repo, and gets a no.
 *
 * Ownership is compared on GitHub's numeric account id, not the login. The
 * feature spec says "owner.login matches their github_username", and that is
 * the intent — but logins are renameable and a freed login can be claimed by
 * somebody else, so a stored username goes stale in a way that hands the
 * next holder of that name ownership of everything under it. The immutable
 * id is the same check without that window. `github_username` is kept for
 * display only, which is why nothing here reads it.
 */

import type { GitHubRepoRef } from "@/lib/github-repo";
import { MAX_REPO_SIZE_KB } from "@/lib/repo-scan/config";
import {
  fetchGitHubRepo,
  type GitHubFailure,
  type GitHubRepo,
  type GitHubResult,
} from "./api";
import { deleteGitHubConnection, getGitHubConnection } from "./connection";

export type RepoAccessVerdict =
  | {
      allowed: true;
      via: "owner" | "push";
      isPrivate: boolean;
      /** Repo size in KB per GitHub, for the pre-clone size gate. */
      sizeKb: number | null;
    }
  | {
      allowed: false;
      /** HTTP status the route should return. */
      status: number;
      message: string;
      /**
       * The client turns these into the two different recovery affordances:
       * a first-time "Connect GitHub" panel, or a "Reconnect" prompt after a
       * token died. Anything else is not a connection problem and gets
       * neither.
       */
      action?: "connect" | "reconnect";
    };

function failureVerdict(failure: GitHubFailure, slug: string): RepoAccessVerdict {
  switch (failure.kind) {
    case "auth":
      return {
        allowed: false,
        status: 401,
        message:
          "Your GitHub connection has expired or been revoked. Reconnect GitHub to scan repositories again.",
        action: "reconnect",
      };
    case "not_found":
      // With `public_repo` scope a private repo is indistinguishable from a
      // nonexistent one — GitHub returns 404 for both rather than leaking
      // existence. So the message has to cover both, honestly.
      return {
        allowed: false,
        status: 404,
        message: `${slug} doesn't exist, or your GitHub account can't see it. Netherite requests access to public repositories only, so private repositories can't be scanned.`,
      };
    case "rate_limited":
      return {
        allowed: false,
        status: 429,
        message:
          "GitHub is rate limiting this account right now. Please try again in a few minutes.",
      };
    case "forbidden":
      return {
        allowed: false,
        status: 403,
        message: `GitHub refused access to ${slug}. If it belongs to an organization with SAML SSO, authorize your token for that organization and try again.`,
      };
    case "unavailable":
      return {
        allowed: false,
        status: 502,
        message: "Couldn't reach GitHub to verify access to that repository. Please try again.",
      };
  }
}

/** The identity half of a connection — everything the decision needs, and
 *  deliberately not the token, so the rule below can be tested without one. */
export type ConnectionIdentity = {
  githubUsername: string;
  githubUserId: number;
};

/**
 * The rule itself, as a pure function of "who is asking" and "what GitHub
 * said". Split out from `verifyRepoAccess` so every branch — owner, org with
 * push, org without push, expired token, 404, rate limit — can be exercised
 * directly by scripts/github-access-test.mjs without a database, a network,
 * or a real OAuth token. The I/O wrapper below is what the routes call.
 */
export function decideRepoAccess(
  connection: ConnectionIdentity | null,
  result: GitHubResult<GitHubRepo>,
  slug: string,
): RepoAccessVerdict {
  if (!connection) {
    return {
      allowed: false,
      status: 403,
      message: "Connect your GitHub account to scan repositories.",
      action: "connect",
    };
  }

  if (!result.ok) return failureVerdict(result.failure, slug);

  const found = result.data;

  // Ownership is the numeric account id and nothing else. There is
  // deliberately no fallback to comparing logins: a login is renameable, and
  // once freed it can be registered by somebody else — so a stale username
  // in our table would hand that person ownership of every repo under the
  // name. The id has no such window, and it is always present on a `User`
  // owner, so the fallback would add risk without adding reach. An
  // Organization owner is never the user, and is handled by push access below.
  const isOwner = found.owner.type === "User" && found.owner.id === connection.githubUserId;

  if (isOwner) {
    return { allowed: true, via: "owner", isPrivate: found.private, sizeKb: found.size };
  }

  if (found.permissions?.push === true) {
    return { allowed: true, via: "push", isPrivate: found.private, sizeKb: found.size };
  }

  return {
    allowed: false,
    status: 403,
    message: `You can only scan repositories you own or have write access to. ${slug} belongs to ${found.owner.login}, and GitHub reports you don't have push access to it.`,
  };
}

/**
 * Decides whether `userId` may scan `repo`.
 *
 * Runs before any billing reservation and before any clone, so a rejected
 * scan costs the user nothing and touches no disk.
 */
export async function verifyRepoAccess(
  userId: string,
  repo: GitHubRepoRef,
): Promise<RepoAccessVerdict> {
  const connection = await getGitHubConnection(userId);
  if (!connection) return decideRepoAccess(null, NO_RESULT, repo.slug);

  const result = await fetchGitHubRepo(connection.accessToken, repo.owner, repo.repo);

  if (!result.ok && result.failure.kind === "auth") {
    // The credential is dead, not merely unlucky. Drop it so the next
    // request presents a connect prompt rather than retrying it forever.
    await deleteGitHubConnection(userId);
  }

  return decideRepoAccess(connection, result, repo.slug);
}

/**
 * The pre-clone size gate, kept separate from the access decision because it
 * answers a different question — not "may you scan this", but "can this
 * server survive scanning it". Both routes run it immediately after access
 * is granted, using the size from the same GitHub response.
 *
 * Returns a refusal message, or null when the repo is within bounds. A
 * missing size (`null`) is not treated as oversized: GitHub omitting the
 * field must not make a legitimate repo unscannable, and CLONE_TIMEOUT_MS
 * still bounds the fetch.
 */
export function oversizeRefusal(sizeKb: number | null): string | null {
  if (sizeKb === null || sizeKb <= MAX_REPO_SIZE_KB) return null;

  const gb = (sizeKb / (1024 * 1024)).toFixed(1);
  const limitGb = (MAX_REPO_SIZE_KB / (1024 * 1024)).toFixed(1);
  return `That repository is about ${gb} GB, which is over the ${limitGb} GB scanning limit. Scanning clones the repository to disk first, so repositories this large are refused rather than partly scanned. Try scanning a specific branch, or a smaller repository.`;
}

/** Placeholder for the no-connection path, which never inspects the result. */
const NO_RESULT: GitHubResult<GitHubRepo> = {
  ok: false,
  failure: { kind: "unavailable" },
};
