/**
 * The gate for private repository scanning. Four independent things must all
 * be true before a single byte of unpublished source reaches this server, and
 * this is the only place they are checked together.
 *
 *   1. **The plan allows it.** `entitlement.privateRepoScanning`, which comes
 *      from `getUserEntitlement(userId)` — a service-role read of the
 *      subscriptions table keyed on the session user id. No request field
 *      reaches it.
 *   2. **An installation exists for this user**, written by the callback
 *      route only after GitHub confirmed the installation belongs to that
 *      user's own GitHub account.
 *   3. **Consent is on file, at the current version.** Out-of-date consent
 *      counts as none.
 *   4. **GitHub says the installation can read that repository.** Not our
 *      opinion — the installation token either resolves the repo or it does
 *      not.
 *
 * Any one of them failing refuses the scan, and each produces a distinct
 * `action` so the client can offer the matching fix (upgrade / install /
 * consent) rather than a generic error.
 *
 * ## Why the token is minted twice
 *
 * A token can only be narrowed to a repository by id, and the id is not known
 * until the repo has been resolved — which itself needs a token. So an
 * installation-wide token is minted, used for exactly one metadata call, and
 * revoked; then a second token scoped to that one repository id is minted for
 * the clone. The clone credential therefore cannot read any other repository
 * in the installation, even though the installation may cover dozens.
 *
 * The alternative — one installation-wide token used for both — is one fewer
 * network call and a credential that could read everything the user owns for
 * as long as the clone runs. The extra call is worth it.
 */

import type { GitHubRepoRef } from "@/lib/github-repo";
import { fetchGitHubRepo } from "@/lib/github/api";
import {
  createInstallationToken,
  revokeInstallationToken,
  type InstallationToken,
} from "@/lib/github/app";
import { oversizeRefusal } from "@/lib/github/access";
import type { Entitlement } from "@/lib/tier-features";
import { getInstallation, hasCurrentConsent } from "./store";

export type PrivateScanRefusal = {
  allowed: false;
  status: number;
  message: string;
  /** What the client should offer as the fix. */
  action?: "upgrade" | "install" | "consent";
};

export type PrivateScanGrant = {
  allowed: true;
  /**
   * The clone credential, scoped to this one repository. The caller **must**
   * revoke it in a `finally` — see `withPrivateScanCredential`, which is the
   * supported way to use this.
   */
  token: InstallationToken;
  installationId: number;
  repoFullName: string;
  sizeKb: number | null;
};

export type PrivateScanVerdict = PrivateScanGrant | PrivateScanRefusal;

/**
 * The first three conditions as a pure function of what is already known,
 * with no database, no network and no clock.
 *
 * Split out for the same reason `decideRepoAccess` is in lib/github/access.ts:
 * these are the rules, and rules that can only be exercised by standing up a
 * subscription row, an installation row and a consent row are rules that in
 * practice get exercised once. Every branch here is asserted directly by
 * scripts/private-scan-test.mjs — including, specifically, that no
 * combination of tier and installation produces a grant without consent.
 *
 * Returns null when the first three gates pass and only GitHub's answer is
 * still outstanding.
 */
export function decidePrivateScanAccess(input: {
  privateRepoScanning: boolean;
  hasInstallation: boolean;
  hasCurrentConsent: boolean;
}): PrivateScanRefusal | null {
  if (!input.privateRepoScanning) {
    // Worded for both cases it actually covers. GitHub returns 404 for a
    // private repository and for one that does not exist, and this app cannot
    // tell them apart — so telling a user with a typo in their URL to upgrade
    // would be wrong. The message names both possibilities and the client
    // still gets `action: "upgrade"` to render the option.
    return {
      allowed: false,
      status: 402,
      message:
        "That repository doesn't exist, or it's private. Scanning private repositories is available on paid plans.",
      action: "upgrade",
    };
  }

  if (!input.hasInstallation) {
    return {
      allowed: false,
      status: 403,
      message:
        "Install the Netherite GitHub App on the repositories you want scanned, then try again.",
      action: "install",
    };
  }

  // Deliberately before the repo is resolved: asking GitHub about somebody's
  // private repository is itself an access, and there is no reason to perform
  // one for a user who has not agreed to the terms.
  if (!input.hasCurrentConsent) {
    return {
      allowed: false,
      status: 403,
      message:
        "Before scanning a private repository, please review and accept the data-handling terms.",
      action: "consent",
    };
  }

  return null;
}

/**
 * Decides whether `userId` may scan `repo` privately, and if so mints the
 * credential to do it.
 *
 * Runs before any usage reservation and before any clone, so a refused scan
 * costs nothing and touches no disk.
 */
export async function authorizePrivateScan(
  userId: string,
  repo: GitHubRepoRef,
  entitlement: Entitlement,
): Promise<PrivateScanVerdict> {
  // 1–3, in one place, with no I/O. The reads below feed it; the rules live
  // in the pure function so they can be tested without them.
  const installation = await getInstallation(userId);
  const refusal = decidePrivateScanAccess({
    privateRepoScanning: entitlement.privateRepoScanning,
    hasInstallation: installation !== null,
    // Short-circuits: an unentitled or uninstalled user is refused without a
    // consent read, and `hasCurrentConsent` fails closed on a read error.
    hasCurrentConsent:
      entitlement.privateRepoScanning && installation !== null
        ? await hasCurrentConsent(userId)
        : false,
  });
  if (refusal) return refusal;

  // TypeScript cannot see that `decidePrivateScanAccess` returning null
  // implies an installation; the check is redundant at runtime and free.
  if (!installation) {
    return {
      allowed: false,
      status: 403,
      message:
        "Install the Netherite GitHub App on the repositories you want scanned, then try again.",
      action: "install",
    };
  }

  // 4. GitHub's own answer.
  const broad = await createInstallationToken(installation.installationId);
  if (!broad.ok) {
    return {
      allowed: false,
      status: broad.failure.kind === "config" ? 503 : 502,
      message:
        broad.failure.kind === "config"
          ? broad.failure.message
          : broad.failure.kind === "not_found"
            ? "Your GitHub App installation no longer exists. Reinstall it from your account page."
            : "Couldn't reach GitHub to authorize the scan. Please try again.",
      ...(broad.failure.kind === "not_found" ? { action: "install" as const } : {}),
    };
  }

  let found;
  try {
    found = await fetchGitHubRepo(broad.data.use(), repo.owner, repo.repo);
  } finally {
    // The wide credential's whole life is the call above.
    await revokeInstallationToken(broad.data);
  }

  if (!found.ok) {
    return {
      allowed: false,
      status: found.failure.kind === "not_found" ? 404 : 502,
      message:
        found.failure.kind === "not_found"
          ? `${repo.slug} isn't covered by your GitHub App installation. Open the installation on GitHub and grant access to it, then try again.`
          : "Couldn't reach GitHub to authorize the scan. Please try again.",
      ...(found.failure.kind === "not_found" ? { action: "install" as const } : {}),
    };
  }

  // A public repository does not need any of this, and must not consume a
  // private-scan audit row or a credential. The caller falls back to the
  // ordinary unauthenticated path.
  if (!found.data.private) {
    return {
      allowed: false,
      status: 409,
      message: "That repository is public — scan it without the private-repo path.",
    };
  }

  const oversize = oversizeRefusal(found.data.size);
  if (oversize) return { allowed: false, status: 413, message: oversize };

  if (found.data.id === null) {
    // Refusing rather than falling back to an installation-wide token: the
    // narrow scope is a security property, not an optimization.
    return {
      allowed: false,
      status: 502,
      message: "GitHub didn't identify that repository properly. Please try again.",
    };
  }

  const scoped = await createInstallationToken(installation.installationId, {
    repositoryIds: [found.data.id],
  });
  if (!scoped.ok) {
    return {
      allowed: false,
      status: 502,
      message: "Couldn't obtain a credential for that repository. Please try again.",
    };
  }

  return {
    allowed: true,
    token: scoped.data,
    installationId: installation.installationId,
    repoFullName: found.data.full_name,
    sizeKb: found.data.size,
  };
}

/**
 * Runs `body` with the clone credential and guarantees the credential is
 * revoked afterwards, on every path including a throw.
 *
 * This exists so no call site has to remember the `finally`. A token that
 * outlives its scan because somebody returned early is precisely the failure
 * this feature cannot afford, and a helper that cannot be used incorrectly is
 * better than a comment asking callers to be careful.
 */
export async function withPrivateScanCredential<T>(
  grant: PrivateScanGrant,
  body: (token: InstallationToken) => Promise<T>,
): Promise<T> {
  try {
    return await body(grant.token);
  } finally {
    await revokeInstallationToken(grant.token);
  }
}
