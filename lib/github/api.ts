/**
 * Minimal GitHub REST client — only the two calls this app makes.
 *
 * Every request here is authenticated with a *user's* OAuth token, so the
 * rules are narrow on purpose:
 *
 * - The base URL is a module constant. `owner`/`repo` arrive already
 *   validated by parseGitHubRepoUrl (lib/github-repo.ts) against a strict
 *   character allow-list, and are percent-encoded again here — so no
 *   user-controlled string can move the request off api.github.com or add a
 *   path segment.
 * - Every call has a timeout. A hung GitHub request must not hold a scan
 *   slot or a serverless invocation open.
 * - Failures are classified, never collapsed. "Your token expired",
 *   "that repo doesn't exist", and "GitHub is rate limiting us" lead to
 *   three different things the user can do, and CLAUDE.md's error rule
 *   forbids hiding which one happened.
 */

const GITHUB_API = "https://api.github.com";

const REQUEST_TIMEOUT_MS = 10_000;

/** How a GitHub call failed, when it wasn't a clean answer about a repo. */
export type GitHubFailure =
  /** 401 — the stored token is expired, revoked, or was never valid. */
  | { kind: "auth" }
  /** 404 — repo doesn't exist, or isn't visible to this token. */
  | { kind: "not_found" }
  /** 403 with a rate-limit signal, or 429. */
  | { kind: "rate_limited"; retryAfterSeconds: number | null }
  /** 403 without a rate-limit signal — usually an unauthorized SSO org. */
  | { kind: "forbidden" }
  /** Network error, timeout, 5xx, or an unparseable body. */
  | { kind: "unavailable" };

export type GitHubResult<T> = { ok: true; data: T } | { ok: false; failure: GitHubFailure };

export type GitHubUser = {
  login: string;
  id: number;
};

export type GitHubRepo = {
  full_name: string;
  private: boolean;
  /**
   * Repository size in KB, as GitHub reports it. Used as a pre-clone bound
   * on how much disk a scan can consume — see MAX_REPO_SIZE_KB. Nullable
   * because it is advisory: a response without it must not be read as zero.
   */
  size: number | null;
  owner: {
    login: string;
    id: number;
    type: string;
  };
  /**
   * Only present when the token can see the repo's permission set, which is
   * the case for any authenticated `GET /repos` response. `push` is the one
   * that matters: it is GitHub's own answer to "may this user write here",
   * and it covers org repos and collaborator grants without this app having
   * to model teams.
   */
  permissions?: {
    admin?: boolean;
    push?: boolean;
    pull?: boolean;
  };
};

async function githubFetch(path: string, token: string): Promise<GitHubResult<unknown>> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        // GitHub rejects unidentified clients on some endpoints.
        "User-Agent": "Netherite-Security-Scanner",
      },
      // No caching: this is an authorization decision, and a cached "yes"
      // would outlive the access that justified it.
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, failure: { kind: "unavailable" } };
  }

  if (response.status === 401) {
    return { ok: false, failure: { kind: "auth" } };
  }

  if (response.status === 404) {
    return { ok: false, failure: { kind: "not_found" } };
  }

  if (response.status === 429 || response.status === 403) {
    // GitHub signals rate limiting as a 403 with the remaining count at
    // zero, which is otherwise indistinguishable from a plain authorization
    // failure — and the two need different messages.
    const remaining = response.headers.get("x-ratelimit-remaining");
    const retryAfter = Number(response.headers.get("retry-after"));
    if (response.status === 429 || remaining === "0") {
      return {
        ok: false,
        failure: {
          kind: "rate_limited",
          retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
        },
      };
    }
    return { ok: false, failure: { kind: "forbidden" } };
  }

  if (!response.ok) {
    return { ok: false, failure: { kind: "unavailable" } };
  }

  try {
    return { ok: true, data: await response.json() };
  } catch {
    return { ok: false, failure: { kind: "unavailable" } };
  }
}

/** `GET /user` — who the token belongs to. */
export async function fetchGitHubUser(token: string): Promise<GitHubResult<GitHubUser>> {
  const result = await githubFetch("/user", token);
  if (!result.ok) return result;

  const body = result.data as Partial<GitHubUser> | null;
  if (typeof body?.login !== "string" || typeof body?.id !== "number") {
    return { ok: false, failure: { kind: "unavailable" } };
  }
  return { ok: true, data: { login: body.login, id: body.id } };
}

/** `GET /repos/{owner}/{repo}` — the call the ownership gate is built on. */
export async function fetchGitHubRepo(
  token: string,
  owner: string,
  repo: string,
): Promise<GitHubResult<GitHubRepo>> {
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const result = await githubFetch(path, token);
  if (!result.ok) return result;

  const body = result.data as Partial<GitHubRepo> | null;
  if (
    typeof body?.full_name !== "string" ||
    typeof body?.owner?.login !== "string" ||
    typeof body?.owner?.id !== "number"
  ) {
    return { ok: false, failure: { kind: "unavailable" } };
  }

  return {
    ok: true,
    data: {
      full_name: body.full_name,
      private: Boolean(body.private),
      size: typeof body.size === "number" && Number.isFinite(body.size) ? body.size : null,
      owner: {
        login: body.owner.login,
        id: body.owner.id,
        type: typeof body.owner.type === "string" ? body.owner.type : "User",
      },
      permissions: body.permissions,
    },
  };
}
