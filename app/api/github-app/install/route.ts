import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";

import { getUserEntitlement } from "@/lib/get-user-tier";
import { fetchAppSlug, installUrl } from "@/lib/github/app";
import { createClient } from "@/lib/supabase/server";

// Starts the GitHub App installation flow.
//
// A route rather than a plain link on the account page, for two reasons:
//
//   1. **The tier is checked server-side before the redirect.** A link is
//      just a URL; anybody could paste GitHub's install URL directly. This
//      does not *enforce* anything on its own — the callback and the scan
//      route both re-check — but it means the flow a free user can reach
//      never starts, rather than starting and failing at the end.
//
//   2. **It mints the CSRF state.** A random nonce goes into an httpOnly
//      cookie and travels to GitHub as `state`, which GitHub hands back on
//      the callback. Without it, a third party could feed a user a callback
//      URL carrying an installation id of their choosing.

export const runtime = "nodejs";

export const INSTALL_STATE_COOKIE = "netherite_gh_install_state";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.redirect(new URL("/login", process.env.NEXT_PUBLIC_SITE_URL), 303);
  }

  const entitlement = await getUserEntitlement(user.id);
  if (!entitlement.privateRepoScanning) {
    return Response.redirect(
      new URL("/account?private_scan=upgrade_required", process.env.NEXT_PUBLIC_SITE_URL),
      303,
    );
  }

  const slug = await fetchAppSlug();
  if (!slug) {
    return Response.redirect(
      new URL("/account?private_scan=unconfigured", process.env.NEXT_PUBLIC_SITE_URL),
      303,
    );
  }

  const state = randomBytes(32).toString("base64url");

  const store = await cookies();
  store.set(INSTALL_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // Long enough to read GitHub's repository picker, short enough that a
    // stale nonce on a shared machine is not lying around for a day.
    maxAge: 15 * 60,
  });

  return Response.redirect(installUrl(slug, state), 303);
}
