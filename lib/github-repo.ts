// Shared GitHub repo URL parsing/validation. Imported by both the client
// (app/chat/chat-view.tsx, to reject obvious typos before a round trip) and
// the server (app/api/repo-scan/route.ts, which is the real check — the
// client's copy is a convenience, never a boundary). Keeping one
// implementation means the two can't drift apart.
//
// Deliberately pure string work: nothing here fetches, resolves, or clones
// anything. When real repo scanning lands, that code must treat these
// fields as untrusted data — pass `owner`/`repo`/`ref` as separate argv
// entries to git, never interpolated into a shell string.

export const MAX_REPO_URL_LENGTH = 300;

export type GitHubRepoRef = {
  owner: string;
  repo: string;
  /**
   * Branch/tag from a `…/tree/<ref>` URL, when it's unambiguous. A longer
   * path (`…/tree/main/src/app`) can't be split into ref vs subdirectory
   * without asking GitHub which branches exist, so those resolve to null
   * (the default branch) rather than guessing wrong.
   */
  ref: string | null;
  /** `owner/repo` — built from validated segments, safe to render. */
  slug: string;
  /** Normalized `https://github.com/owner/repo` — never the raw input. */
  canonicalUrl: string;
};

const ALLOWED_HOSTS = new Set(["github.com", "www.github.com"]);

// GitHub account names: alphanumeric plus single (non-consecutive,
// non-trailing) hyphens, 39 chars max.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._-]{1,100}$/;

// First-path-segment routes on github.com that are site pages, not accounts
// — so "github.com/features/copilot" isn't read as owner=features.
const RESERVED_OWNERS = new Set([
  "about",
  "apps",
  "codespaces",
  "collections",
  "contact",
  "enterprise",
  "explore",
  "features",
  "issues",
  "join",
  "login",
  "logout",
  "marketplace",
  "new",
  "notifications",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "security",
  "settings",
  "signup",
  "sponsors",
  "topics",
  "trending",
]);

/**
 * Parses a user-pasted GitHub repo URL. Returns null for anything that
 * isn't clearly a repo on github.com — callers should treat null as
 * "invalid input", with no partial result to fall back on.
 */
export function parseGitHubRepoUrl(input: string): GitHubRepoRef | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_REPO_URL_LENGTH) return null;

  // A scheme-less "github.com/owner/repo" paste is common enough to accept.
  // SSH/git forms (`git@github.com:owner/repo.git`, `git://…`) are not —
  // this app has no git credentials and couldn't use them anyway; they fail
  // the host check below rather than being silently rewritten.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  // Embedded credentials or a custom port in something claiming to be a
  // GitHub link is never a real repo URL — it's how a hostile URL gets
  // dressed up to read like one. Reject rather than normalize away.
  if (url.username || url.password || url.port) return null;

  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;

  // Note: pathname keeps percent-encoding intact and this never decodes it,
  // so an encoded traversal attempt ("%2e%2e") stays literal and gets
  // rejected by the character allow-lists below.
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");

  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null;
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  // REPO_RE permits dots, so these two have to be excluded by name.
  if (repo === "." || repo === "..") return null;

  let ref: string | null = null;
  if (
    segments.length === 4 &&
    segments[2].toLowerCase() === "tree" &&
    REF_RE.test(segments[3]) &&
    segments[3] !== "." &&
    segments[3] !== ".."
  ) {
    ref = segments[3];
  }

  return {
    owner,
    repo,
    ref,
    slug: `${owner}/${repo}`,
    canonicalUrl: `https://github.com/${owner}/${repo}`,
  };
}
