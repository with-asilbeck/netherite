// Parsing and narrowing of Lemon Squeezy webhook payloads.
//
// The body has already been proven authentic by the time anything here
// runs (the route verifies the signature against the raw bytes first), so
// this file is not a trust boundary — it is a shape boundary. Its job is to
// turn a loosely typed JSON blob into a small closed set of events, and to
// refuse anything it does not recognise instead of guessing, so that a
// payload change on their side shows up as a rejected event in the log
// rather than as a wrong tier in the database.

import { planForVariant, webhookSecret, type PlanIdentity } from "./config";
import { verifyCheckoutUserId } from "./signature";

export const HANDLED_EVENTS = [
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_expired",
  "subscription_payment_failed",
  "subscription_payment_success",
  "subscription_payment_refunded",
] as const;

export type HandledEvent = (typeof HANDLED_EVENTS)[number];

/**
 * The events that are allowed to change a user's tier or status.
 *
 * `subscription_payment_success` is deliberately absent, and this is the
 * single place that fact is encoded. It fires on the first payment *and* on
 * every renewal, and on renewal it carries no information about what the
 * customer is currently entitled to — acting on it would re-grant a tier
 * that `subscription_cancelled` or `subscription_payment_refunded` had
 * already taken away, at whatever moment the renewal invoice happened to be
 * issued. Payment success writes to payment_history and nothing else.
 *
 * The webhook route asserts membership of this set before performing any
 * entitlement write, so adding an event to the handler is not enough to
 * give it that power — it has to be listed here too.
 */
export const ENTITLEMENT_EVENTS = [
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_expired",
  "subscription_payment_failed",
  "subscription_payment_refunded",
] as const;

export type EntitlementEvent = (typeof ENTITLEMENT_EVENTS)[number];

export function isHandledEvent(value: unknown): value is HandledEvent {
  return typeof value === "string" && (HANDLED_EVENTS as readonly string[]).includes(value);
}

export function changesEntitlement(event: HandledEvent): event is EntitlementEvent {
  return (ENTITLEMENT_EVENTS as readonly string[]).includes(event);
}

/**
 * The two payload families Lemon Squeezy actually sends, which do not line
 * up with the event names in the obvious way: `subscription_payment_failed`
 * is *not* a subscription payload. All four `subscription_payment_*` events
 * carry a `subscription-invoices` object whose `attributes.subscription_id`
 * points back at the subscription — so the failed-payment handler has to
 * resolve the subscription indirectly, like the refund handler does.
 */
type InvoiceEventName = Extract<
  HandledEvent,
  "subscription_payment_success" | "subscription_payment_failed" | "subscription_payment_refunded"
>;

const INVOICE_EVENTS: ReadonlySet<string> = new Set<InvoiceEventName>([
  "subscription_payment_success",
  "subscription_payment_failed",
  "subscription_payment_refunded",
]);

function isInvoiceEvent(name: HandledEvent): name is InvoiceEventName {
  return INVOICE_EVENTS.has(name);
}

/** A subscription lifecycle event: created / updated / cancelled / expired. */
export type SubscriptionEvent = {
  kind: "subscription";
  name: Extract<
    HandledEvent,
    | "subscription_created"
    | "subscription_updated"
    | "subscription_cancelled"
    | "subscription_expired"
  >;
  /** Lemon Squeezy's subscription id — our join key for every later event. */
  subscriptionId: string;
  customerId: string | null;
  orderId: string | null;
  variantId: string | null;
  /** Resolved from variantId through the env-var mapping; null if unknown. */
  plan: PlanIdentity | null;
  /** Lemon Squeezy's own status string, e.g. active / cancelled / expired. */
  lemonStatus: string | null;
  /** When paid access ends: `ends_at` once cancelled, otherwise `renews_at`. */
  currentPeriodEnd: string | null;
  /** `meta.custom_data.user_id`, set by our own checkout. */
  customUserId: string | null;
  testMode: boolean;
};

/** A subscription invoice event: payment success / failure / refund. */
export type InvoiceEvent = {
  kind: "invoice";
  name: Extract<
    HandledEvent,
    "subscription_payment_success" | "subscription_payment_failed" | "subscription_payment_refunded"
  >;
  invoiceId: string;
  subscriptionId: string | null;
  customerId: string | null;
  /** Cents. */
  amount: number;
  currency: string;
  paidAt: string;
  refunded: boolean;
  refundedAt: string | null;
  customUserId: string | null;
  testMode: boolean;
};

export type BillingEvent = SubscriptionEvent | InvoiceEvent;

export type ParseResult =
  | { ok: true; event: BillingEvent }
  | { ok: false; reason: string; eventName: string | null };

export function parseWebhookEvent(payload: unknown): ParseResult {
  const root = asRecord(payload);
  if (!root) return { ok: false, reason: "body is not an object", eventName: null };

  const meta = asRecord(root.meta);
  const eventName = meta ? asString(meta.event_name) : null;

  if (!isHandledEvent(eventName)) {
    return { ok: false, reason: "unhandled event name", eventName };
  }

  const data = asRecord(root.data);
  const attributes = data ? asRecord(data.attributes) : null;
  if (!data || !attributes) {
    return { ok: false, reason: "missing data.attributes", eventName };
  }

  // JSON:API says `data.id` is a string; accept a number too rather than
  // rejecting a valid event over a serialisation detail.
  const id = asIdString(data.id);
  if (!id) return { ok: false, reason: "missing data.id", eventName };

  // Set by createCheckoutUrl. Present on the events for a subscription
  // bought through our own checkout; absent for one created by hand in the
  // Lemon Squeezy dashboard, which is why it is only ever a fallback.
  const customUserId = readCustomUserId(meta);
  const testMode = attributes.test_mode === true;

  if (isInvoiceEvent(eventName)) {
    // Subscription invoices have no `paid_at`; `created_at` is when the
    // invoice — and so the charge attempt — happened.
    const paidAt = asString(attributes.created_at);
    const total = asNumber(attributes.total);

    if (total === null) {
      return { ok: false, reason: "invoice has no total", eventName };
    }
    if (!paidAt) {
      return { ok: false, reason: "invoice has no created_at", eventName };
    }

    return {
      ok: true,
      event: {
        kind: "invoice",
        name: eventName,
        invoiceId: id,
        subscriptionId: asIdString(attributes.subscription_id),
        customerId: asIdString(attributes.customer_id),
        amount: Math.max(0, Math.round(total)),
        // Normalised to an ISO 4217 code here rather than trusted through
        // to the account page: `Intl.NumberFormat` throws a RangeError on
        // anything that isn't one, and that would be a 500 on the billing
        // page of whoever the bad row belongs to.
        currency: normaliseCurrency(attributes.currency),
        paidAt,
        refunded: attributes.refunded === true,
        refundedAt: asString(attributes.refunded_at),
        customUserId,
        testMode,
      },
    };
  }

  const variantId = asIdString(attributes.variant_id);

  return {
    ok: true,
    event: {
      kind: "subscription",
      name: eventName,
      subscriptionId: id,
      customerId: asIdString(attributes.customer_id),
      orderId: asIdString(attributes.order_id),
      variantId,
      // Resolved here rather than in the handler so that "what did they
      // buy" has exactly one implementation, and so an unrecognised
      // variant is visible as `null` instead of defaulting to a tier.
      plan: variantId ? planForVariant(variantId) : null,
      lemonStatus: asString(attributes.status),
      // `ends_at` is populated once a subscription is cancelled or has
      // expired, and is the date access actually stops. `renews_at` is the
      // next charge date while it is still running. Preferring ends_at
      // when present is what lets a cancelled plan stay usable until the
      // period the customer already paid for runs out.
      currentPeriodEnd: asString(attributes.ends_at) ?? asString(attributes.renews_at),
      customUserId,
      testMode,
    },
  };
}

/**
 * The user id a checkout was started for — but only if it can be proven.
 *
 * Two checks, and both must pass:
 *
 *   1. It is shaped like a UUID, before it is ever used in a query.
 *   2. It comes with a valid `uid_sig`, which only our own checkout route
 *      can produce. Custom data is *not* private — Lemon Squeezy lets
 *      anyone set it through query parameters on a public buy URL — so the
 *      id by itself proves nothing about whose purchase this is. See
 *      lib/billing/signature.ts for the attack this closes.
 *
 * Returning null on failure is what makes this safe: an unattributable
 * event becomes a logged no-op, never a write against a guessed user.
 */
function readCustomUserId(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const custom = asRecord(meta.custom_data);
  if (!custom) return null;

  const value = asString(custom.user_id);
  if (!value) return null;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return null;
  }

  if (!verifyCheckoutUserId(value, asString(custom.uid_sig), webhookSecret())) {
    console.warn(
      "[billing] custom_data.user_id has no valid signature; refusing to attribute this event",
    );
    return null;
  }

  return value;
}

/** ISO 4217 is three letters and nothing else. Anything else becomes USD. */
function normaliseCurrency(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(code) ? code : "USD";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Ids arrive as numbers in attributes and as strings in `data.id`. */
function asIdString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
