import { webhookSecret } from "@/lib/billing/config";
import { parseWebhookEvent, type BillingEvent } from "@/lib/billing/events";
import { licenseKeyForOrder } from "@/lib/billing/lemonsqueezy";
import { verifyWebhookSignature } from "@/lib/billing/signature";
import {
  applyPaymentFailed,
  applyPaymentRefunded,
  applySubscriptionCancelled,
  applySubscriptionCreated,
  applySubscriptionExpired,
  applySubscriptionUpdated,
  recordPaymentSuccess,
  type ApplyResult,
} from "@/lib/billing/store";

// Lemon Squeezy webhook receiver. This is the only thing in the app that
// can change what a user is entitled to.
//
// The order of operations below is load-bearing and must not be
// rearranged:
//
//   1. Read the body as raw text.
//   2. Verify X-Signature over exactly those bytes.
//   3. Only then parse the JSON and act on it.
//
// Reading the parsed body first and re-serialising it to check the digest
// is the classic way to break this — key order and whitespace change, every
// signature fails, and the temptation is to relax the check rather than fix
// the cause. There is no branch here that reaches step 3 without step 2
// returning true: no debug flag, no test-mode exemption, no "skip if the
// secret isn't set". A missing secret throws, which is a 500, which is a
// refusal.

// Signature verification needs the exact bytes; nothing may buffer, parse,
// or re-encode the body before this handler sees it.
export const dynamic = "force-dynamic";

// Guards against a body large enough to be a denial-of-service on the HMAC
// rather than a real event. Real payloads are a few kilobytes.
const MAX_BODY_BYTES = 512 * 1024;

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return Response.json({ error: "Payload too large." }, { status: 413 });
  }

  let secret: string;
  try {
    secret = webhookSecret();
  } catch (err) {
    // Fail closed. An unset secret must never mean "accept everything".
    console.error("[billing] webhook secret is not configured:", err);
    return Response.json({ error: "Webhook not configured." }, { status: 500 });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return Response.json({ error: "Payload too large." }, { status: 413 });
  }

  const signature = request.headers.get("x-signature");
  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    // No detail in the response: which part failed is exactly the feedback
    // a forger wants. The log has it.
    console.warn("[billing] rejected webhook with an invalid signature");
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = parseWebhookEvent(payload);
  if (!parsed.ok) {
    // 200, not an error: the delivery was authentic and well-formed enough
    // to identify. Events we don't subscribe to shouldn't sit in Lemon
    // Squeezy's retry queue forever.
    console.info(`[billing] ignoring webhook (${parsed.reason}):`, parsed.eventName);
    return Response.json({ received: true, handled: false, reason: parsed.reason });
  }

  const event = parsed.event;

  try {
    const result = await handle(event);
    console.info(
      `[billing] ${event.name}: ${result.applied ? "applied" : "no-op"} — ${result.detail}`,
    );
    // 202 when the event was authentic but there was nothing to do, so the
    // two cases are distinguishable in Lemon Squeezy's delivery log without
    // triggering a retry.
    return Response.json(
      { received: true, handled: result.applied, detail: result.detail },
      { status: result.applied ? 200 : 202 },
    );
  } catch (err) {
    // 500 so Lemon Squeezy retries. Everything that throws in the handlers
    // is a transient failure or a fixable misconfiguration, both of which a
    // retry can resolve; swallowing it would silently lose a paid upgrade.
    console.error(`[billing] ${event.name} failed:`, err);
    return Response.json({ error: "Webhook handler failed." }, { status: 500 });
  }
}

async function handle(event: BillingEvent): Promise<ApplyResult> {
  // Read before the switch: once every case is covered TypeScript narrows
  // `event` to `never` at the bottom of the function.
  const name = event.name;

  switch (event.name) {
    case "subscription_created": {
      if (event.kind !== "subscription") break;
      // Best-effort and non-blocking: products without license keys enabled
      // simply return null, and a lookup failure must not cost the customer
      // their subscription.
      const licenseKey = event.orderId ? await licenseKeyForOrder(event.orderId) : null;
      return applySubscriptionCreated(event, licenseKey);
    }

    case "subscription_updated":
      if (event.kind !== "subscription") break;
      return applySubscriptionUpdated(event);

    case "subscription_cancelled":
      if (event.kind !== "subscription") break;
      return applySubscriptionCancelled(event);

    case "subscription_expired":
      if (event.kind !== "subscription") break;
      return applySubscriptionExpired(event);

    case "subscription_payment_failed":
      if (event.kind !== "invoice") break;
      return applyPaymentFailed(event);

    // Payment history only. This branch calls nothing that can write to
    // `subscriptions` — see recordPaymentSuccess, and see ENTITLEMENT_EVENTS
    // in lib/billing/events.ts for why that separation exists.
    case "subscription_payment_success":
      if (event.kind !== "invoice") break;
      return recordPaymentSuccess(event);

    case "subscription_payment_refunded":
      if (event.kind !== "invoice") break;
      return applyPaymentRefunded(event);
  }

  // Reached only if a payload arrives in the wrong shape for its event
  // name — a subscription body on an invoice event or vice versa. Ignored
  // rather than coerced.
  return { applied: false, detail: `unexpected payload shape for ${name}` };
}
