import crypto from "node:crypto";

// Webhook signature verification. This is the only thing standing between
// "Lemon Squeezy said this user paid" and "anyone with the URL said this
// user paid", so it is deliberately small, has no options, and has no
// success path that skips the comparison.

/**
 * Lemon Squeezy signs the **raw** request body with HMAC-SHA256 keyed on
 * the store's webhook secret, and sends it hex-encoded in `X-Signature`.
 *
 * Two things matter here and are easy to get wrong:
 *
 *  - The digest must be computed over the exact bytes that were sent. Any
 *    `JSON.parse` → `JSON.stringify` round trip re-orders keys and drops
 *    whitespace, which changes the digest and would make every real event
 *    fail (or, worse, invite someone to "fix" it by weakening the check).
 *    Callers must pass `await request.text()` and parse only afterwards.
 *
 *  - The comparison must be time-safe. `===` on a hex string leaks how many
 *    leading characters matched via its timing, which is enough to forge a
 *    signature byte by byte given enough attempts.
 *
 * Returns a boolean rather than throwing: the caller's only correct
 * reaction is a 401 either way, and an exception type is one more thing
 * that could be caught too broadly upstream.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  if (!secret) return false;

  // Hex of a SHA-256 digest: exactly 64 characters, nothing else. Checking
  // the shape first means `timingSafeEqual` is never handed buffers of
  // different lengths (it throws in that case) and a garbage header can't
  // reach it at all.
  const provided = signatureHeader.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(provided, "hex"),
  );
}

// ── Checkout attribution ────────────────────────────────────────────────
//
// A verified webhook signature proves the event came from Lemon Squeezy. It
// does *not* prove the checkout behind it came from us — and the difference
// matters, because `meta.custom_data` is not private.
//
// Lemon Squeezy accepts custom data as query parameters on a product's
// public buy URL:
//
//   https://<store>.lemonsqueezy.com/checkout/buy/<uuid>?checkout[custom][user_id]=<anything>
//
// (Verified against this store: the value lands in the checkout's state and
// comes back in the webhook.) Anyone who can find that link can therefore
// choose which account a purchase is attributed to. With `user_id` alone as
// the attribution key, somebody could buy the cheapest plan in another
// user's name — overwriting that user's subscription row — and then request
// a refund, which would drop the victim to `free`/`refunded`. A Max
// customer knocked down to Free for the price of a refundable $9.99.
//
// So the id travels with a keyed digest of itself. An attacker can copy a
// pair out of their own checkout, but cannot produce a valid one for a
// user id they don't already have a signature for.
//
// The key is the webhook secret with a domain-separation prefix, so reusing
// it here can never collide with a body signature.

const ATTRIBUTION_PREFIX = "netherite:checkout-attribution:v1:";

export function signCheckoutUserId(userId: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(ATTRIBUTION_PREFIX + userId, "utf8")
    .digest("hex");
}

export function verifyCheckoutUserId(
  userId: string,
  provided: string | null | undefined,
  secret: string,
): boolean {
  if (!provided || !secret) return false;

  const candidate = provided.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(candidate)) return false;

  return crypto.timingSafeEqual(
    Buffer.from(signCheckoutUserId(userId, secret), "hex"),
    Buffer.from(candidate, "hex"),
  );
}
