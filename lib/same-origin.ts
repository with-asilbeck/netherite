/**
 * True when the request came from this site's own pages.
 *
 * Browsers set `Origin` on every cross-origin POST and cannot be talked out
 * of it, so a missing header means a non-browser client (curl, a server) —
 * which has no ambient cookies to abuse and is therefore not the thing CSRF
 * is about. A *present* header that doesn't match is refused.
 *
 * Supabase's SSR cookies are already `SameSite=Lax`, which stops a cross-site
 * POST from carrying the session at all. This is the explicit second lock,
 * and it costs nothing. It matters most for endpoints whose whole job is to
 * record that a human agreed to something: a consent row written by a
 * cross-site request is worse than no consent row, because it looks like
 * agreement.
 *
 * Extracted from app/api/checkout/route.ts, which had the only copy. Two
 * definitions of "is this request from us" is one more than a codebase should
 * have — they drift, and the one that drifts is the one nobody re-reads.
 */
export function isSameOrigin(request: Request): boolean {
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
