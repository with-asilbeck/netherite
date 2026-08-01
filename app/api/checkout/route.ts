import { createClient } from "@/lib/supabase/server";
import { createCheckoutUrl } from "@/lib/billing/lemonsqueezy";
import { isBillingPeriod, isPaidTier } from "@/lib/billing/plans";
import { checkCheckoutRateLimit } from "@/lib/rate-limit";

// Starts a Lemon Squeezy hosted checkout for the signed-in user.
//
// The only things this route takes from the client are a tier name and a
// billing period, and both are checked against a closed list before they
// are used. Everything that decides *who* is buying and *what it costs* —
// the user id, the email, the variant id, the price — is resolved on the
// server. That is the whole design: there is no field in this request that
// can be edited to change what somebody is charged or which account gets
// the plan.

const MAX_REQUEST_BYTES = 1024;

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "Request is too large." }, { status: 413 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Please log in to subscribe." }, { status: 401 });
  }

  // Same-origin check. Supabase's SSR cookies are SameSite=Lax, which
  // already stops a cross-site POST from carrying the session — this is the
  // explicit second lock, and it costs nothing.
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

  // Keyed by the verified session user id, never a client-supplied header.
  const rateLimit = checkCheckoutRateLimit(user.id);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Too many checkout attempts. Please wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  let body: { tier?: unknown; period?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Closed-list validation, not a cast. `tier` reaches variantIdFor(), which
  // builds an env var name from it — an unchecked string there would be a
  // way to probe the process environment.
  if (!isPaidTier(body.tier)) {
    return Response.json(
      { error: "Choose a plan: basic, pro, or max." },
      { status: 400 },
    );
  }
  if (!isBillingPeriod(body.period)) {
    return Response.json(
      { error: "Choose a billing period: monthly or yearly." },
      { status: 400 },
    );
  }

  // Sessions always carry an email in this app (both providers are OAuth),
  // but the type allows undefined and an empty prefill is harmless.
  const email = user.email ?? "";

  try {
    const url = await createCheckoutUrl({
      tier: body.tier,
      period: body.period,
      // From the verified session. Never from the body — that would let
      // anyone buy a plan for, or bill a plan to, another account.
      userId: user.id,
      email,
      redirectUrl: successUrl(request),
    });

    // The client redirects; a 3xx here would be followed by fetch() and the
    // opaque result is harder to handle than a URL in a body.
    return Response.json({ url });
  } catch (err) {
    console.error("[billing] checkout creation failed:", err);
    return Response.json(
      { error: "We couldn't start the checkout just now. Please try again in a moment." },
      { status: 502 },
    );
  }
}

/**
 * Where Lemon Squeezy sends the customer after paying.
 *
 * Built from a configured origin, never from a client-supplied value: a
 * caller-chosen redirect would turn this endpoint into an open redirect
 * with our store's branding on it. `NEXT_PUBLIC_SITE_URL` is the
 * deployment's own origin; the request URL is the local-dev fallback.
 */
/**
 * True when the request came from this site's own pages.
 *
 * Browsers set `Origin` on every cross-origin POST and cannot be talked out
 * of it, so a missing header means a non-browser client (curl, a server) —
 * which has no ambient cookies to abuse and is therefore not the thing CSRF
 * is about. A *present* header that doesn't match is refused.
 */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  const allowed = new Set<string>();
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    try {
      allowed.add(new URL(configured).origin);
    } catch {
      /* misconfigured; the request origin below still applies */
    }
  }
  allowed.add(new URL(request.url).origin);

  return allowed.has(origin);
}

function successUrl(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const origin = configured || new URL(request.url).origin;
  return new URL("/account?checkout=success", origin).toString();
}
