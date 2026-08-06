import { cookies } from "next/headers";

import { getUserEntitlement } from "@/lib/get-user-tier";
import { getGitHubConnection } from "@/lib/github/connection";
import { fetchInstallation, safeEqual } from "@/lib/github/app";
import { saveInstallation } from "@/lib/private-scan/store";
import { checkGitHubAppCallbackRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { INSTALL_STATE_COOKIE } from "../install/route";

// Where GitHub sends the user after they install the App.
//
// GitHub appends `installation_id`, `setup_action` and the `state` we sent.
// **None of that is trusted.** `installation_id` is an integer in a query
// string that anybody can type, so the only thing this route does with it is
// ask GitHub who it belongs to, and then compare that against the GitHub
// account this Netherite user has already proven they control.
//
// The attack this defends against is concrete: without the ownership check,
// user A could complete this callback carrying user B's installation id and
// have Netherite mint clone credentials for B's private repositories on A's
// behalf, forever. The unique index on installation_id is the second line of
// defence — two users cannot both claim one installation even if the first
// check were somehow bypassed.
//
// Ownership is compared on GitHub's immutable numeric account id, never the
// login, for the same reason lib/github/access.ts does: logins are renameable
// and a freed login can be claimed by somebody else.

export const runtime = "nodejs";

const ACCOUNT = "/account";

function back(status: string): Response {
  const url = new URL(ACCOUNT, process.env.NEXT_PUBLIC_SITE_URL);
  url.searchParams.set("private_scan", status);
  return Response.redirect(url, 303);
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.redirect(new URL("/login", process.env.NEXT_PUBLIC_SITE_URL), 303);
  }

  const entitlement = await getUserEntitlement(user.id);
  if (!entitlement.privateRepoScanning) {
    return back("upgrade_required");
  }

  // Every hit below costs two authenticated GitHub API calls against the
  // App's own quota, which is shared by every customer of this deployment.
  // Keyed by the verified session user id, never a header.
  if (!checkGitHubAppCallbackRateLimit(user.id).allowed) {
    return back("rate_limited");
  }

  const params = new URL(request.url).searchParams;

  // CSRF: the nonce we minted must come back. Consumed either way, so a
  // replayed callback cannot reuse it.
  const store = await cookies();
  const expected = store.get(INSTALL_STATE_COOKIE)?.value ?? "";
  const received = params.get("state") ?? "";
  store.delete(INSTALL_STATE_COOKIE);

  if (!expected || !received || !safeEqual(expected, received)) {
    return back("state_mismatch");
  }

  // GitHub sends `setup_action=request` when the user asked an org owner for
  // approval instead of installing. There is no installation yet, and telling
  // them "installed" would be a lie.
  if (params.get("setup_action") === "request") {
    return back("approval_pending");
  }

  const rawId = params.get("installation_id");
  const installationId = Number(rawId);
  if (!rawId || !Number.isSafeInteger(installationId) || installationId <= 0) {
    return back("missing_installation");
  }

  // Who does GitHub say this installation belongs to?
  const installation = await fetchInstallation(installationId);
  if (!installation.ok) {
    return back(installation.failure.kind === "config" ? "unconfigured" : "github_unavailable");
  }

  // Who has this user proven they are on GitHub? The OAuth connection is the
  // proof, and it is required — without it there is nothing to compare the
  // installation against, and "trust the query string" is not an option.
  const connection = await getGitHubConnection(user.id);
  if (!connection) {
    return back("connect_github_first");
  }

  const account = installation.data.account;

  // Organization installations are refused for now, deliberately rather than
  // by omission. Proving that a user may act for an organization needs an org
  // membership/role check this app does not currently make, and the failure
  // mode of guessing is granting one employee read access to every private
  // repository their employer owns. A personal installation is provably the
  // user's own account; an org one is not, yet.
  if (account.type !== "User") {
    return back("org_not_supported");
  }

  if (account.id !== connection.githubUserId) {
    return back("account_mismatch");
  }

  const saved = await saveInstallation({
    userId: user.id,
    installationId,
    accountLogin: account.login,
    accountId: account.id,
  });

  if (!saved) return back("save_failed");

  return back("installed");
}
