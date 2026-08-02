import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { CHAT_APP_PATH } from "@/lib/chat-entry";
import { fetchGitHubUser } from "@/lib/github/api";
import { saveGitHubConnection } from "@/lib/github/connection";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const providerError = searchParams.get("error");

  if (providerError) {
    return NextResponse.redirect(`${origin}/login?error=access_denied`);
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=no_code`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }

  // This is the only moment a GitHub access token is ever available to us:
  // Supabase surfaces `provider_token` on the session it mints from the
  // code exchange and does not persist it. If it isn't captured here it is
  // gone until the user authorizes again.
  //
  // Best-effort by design — a GitHub capture that fails must not block
  // signing in. The failure surfaces later as "not connected", which the
  // composer already knows how to recover from.
  const connected = await captureGitHubToken(user, data.session?.provider_token ?? null);

  return NextResponse.redirect(`${origin}${destinationFor(searchParams, connected)}`);
}

/**
 * Stores the GitHub token if — and only if — it demonstrably belongs to the
 * GitHub identity linked to this Supabase account.
 *
 * The verification matters more than it looks. `provider_token` is whatever
 * provider the user just authenticated with, so on a Google sign-in it is a
 * *Google* token; storing it unchecked would put a foreign credential in the
 * GitHub column, where the ownership gate would then present it to GitHub
 * and get nonsense. Calling `GET /user` with it answers both questions at
 * once: is this a GitHub token at all, and whose is it. The id it returns
 * must match the linked identity, so a token for some other GitHub account
 * cannot be attached to this user either.
 *
 * @returns whether a connection is now stored.
 */
async function captureGitHubToken(user: User, providerToken: string | null): Promise<boolean> {
  if (!providerToken) return false;

  const githubIdentity = (user.identities ?? []).find(
    (identity) => identity.provider === "github",
  );
  if (!githubIdentity) return false;

  const result = await fetchGitHubUser(providerToken);
  if (!result.ok) return false;

  // `identity.id` is the provider's own user id, as a string.
  if (String(result.data.id) !== String(githubIdentity.id)) {
    console.error(
      "[github] provider_token belongs to a different GitHub account than the linked identity — not stored.",
    );
    return false;
  }

  return saveGitHubConnection({
    userId: user.id,
    githubUsername: result.data.login,
    githubUserId: result.data.id,
    accessToken: providerToken,
  });
}

/**
 * Where to land after sign-in.
 *
 * `next` exists so connecting GitHub from the composer returns to the
 * composer with the repo input already open, rather than dumping the user on
 * a fresh chat with no memory of what they were doing. It is restricted to
 * same-site absolute paths: an attacker-supplied `next` is otherwise an open
 * redirect, and `//evil.com` is a protocol-relative URL that `startsWith("/")`
 * alone would happily accept.
 */
function destinationFor(searchParams: URLSearchParams, connected: boolean): string {
  const requested = searchParams.get("next");
  const safe =
    requested && requested.startsWith("/") && !requested.startsWith("//")
      ? requested
      : CHAT_APP_PATH;

  // Signals the outcome to the composer so it can either open the repo input
  // or explain that the connection didn't stick.
  if (searchParams.get("next")) {
    const separator = safe.includes("?") ? "&" : "?";
    return `${safe}${separator}github=${connected ? "connected" : "failed"}`;
  }

  return safe;
}
