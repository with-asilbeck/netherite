/**
 * OAuth scopes requested from GitHub. One definition, imported by both the
 * login page and the composer's connect button, so the two can't drift into
 * asking for different access.
 *
 * Deliberately minimal:
 *
 * - `read:user` — reads the account's login and numeric id, which is how a
 *   connection is bound to a specific GitHub account and how ownership is
 *   later compared.
 * - `public_repo` — lets `GET /repos` return the `permissions` block for
 *   public repositories, which is what distinguishes "you have push access
 *   to this org repo" from "you can merely see it".
 *
 * Notably absent is `repo`, which would grant read *and write* access to
 * every private repository the user has. Scanning is public-only
 * (lib/repo-scan/clone.ts passes no credentials to git), so requesting it
 * would buy nothing and put a far more dangerous credential in the
 * database. The cost of this choice is that a private repo is
 * indistinguishable from a nonexistent one — GitHub 404s both — which
 * lib/github/access.ts states plainly in its message rather than guessing.
 *
 * This file is safe to import from client components: it contains no
 * secrets and pulls in nothing server-side.
 */
export const GITHUB_OAUTH_SCOPES = "read:user public_repo";
