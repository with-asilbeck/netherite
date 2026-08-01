import { createAdminClient } from "@/lib/supabase/admin";
import type { SubscriptionRow } from "@/lib/supabase/billing-schema";
import type { Tier } from "@/lib/usage/tiers";

import { changesEntitlement, type HandledEvent, type InvoiceEvent, type SubscriptionEvent } from "./events";
import { effectiveTier, type SubscriptionStatus } from "./entitlement";
import type { BillingPeriod } from "./plans";

// Every database write billing makes. It all runs through the service-role
// client, because these are precisely the rows a user must not be able to
// write themselves (see the RLS notes in the migration).
//
// The only caller of the write functions is the webhook route, and the only
// way into that route is past a verified signature.

export type ApplyResult = {
  /** False means the event was authentic but there was nothing to do. */
  applied: boolean;
  detail: string;
};

/**
 * The one function that is allowed to change a user's entitlement.
 *
 * The guard is not decoration. The spec's hardest requirement is that
 * `subscription_payment_success` can never move a tier or a status, and the
 * way to make that true is for there to be exactly one write path and for
 * that path to refuse any event not on the entitlement list. A future
 * handler that tries to reuse this from the payment-success branch throws
 * instead of quietly working.
 */
async function writeEntitlement(
  event: HandledEvent,
  userId: string,
  patch: Partial<Pick<SubscriptionRow,
    | "tier"
    | "status"
    | "billing_period"
    | "current_period_end"
    | "lemonsqueezy_customer_id"
    | "lemonsqueezy_subscription_id"
    | "license_key"
  >>,
): Promise<void> {
  if (!changesEntitlement(event)) {
    throw new Error(
      `[billing] ${event} attempted an entitlement write. Only ENTITLEMENT_EVENTS may change tier or status.`,
    );
  }

  const admin = createAdminClient();
  const { error } = await admin.from("subscriptions").update(patch).eq("user_id", userId);
  if (error) throw error;
}

/**
 * The insert half of the same rule. `subscription_created` needs an upsert
 * rather than an update, so it gets its own entry point — but it goes
 * through the identical guard, so there is still no way to establish a paid
 * row from a non-entitlement event.
 */
async function upsertEntitlement(
  event: HandledEvent,
  row: SubscriptionRow | Omit<SubscriptionRow, "created_at" | "updated_at">,
): Promise<void> {
  if (!changesEntitlement(event)) {
    throw new Error(
      `[billing] ${event} attempted an entitlement write. Only ENTITLEMENT_EVENTS may change tier or status.`,
    );
  }

  const admin = createAdminClient();
  const { error } = await admin.from("subscriptions").upsert(row, { onConflict: "user_id" });
  if (error) throw error;
}

export async function subscriptionByLemonId(
  lemonsqueezySubscriptionId: string,
): Promise<SubscriptionRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("subscriptions")
    .select("*")
    .eq("lemonsqueezy_subscription_id", lemonsqueezySubscriptionId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

export async function subscriptionByUserId(userId: string): Promise<SubscriptionRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

/**
 * Lemon Squeezy's subscription statuses mapped onto ours.
 *
 * Theirs has states ours does not (`on_trial`, `paused`, `unpaid`), so the
 * mapping is explicit and anything unrecognised returns null — the caller
 * then leaves the existing status alone rather than inventing one. Guessing
 * here would mean guessing about access.
 */
export function mapLemonStatus(lemonStatus: string | null): SubscriptionStatus | null {
  switch (lemonStatus) {
    case "active":
    case "on_trial":
      return "active";
    case "past_due":
      return "past_due";
    case "cancelled":
    // A paused subscription will not renew but has usually paid for the
    // period it is in — the same shape as a cancellation, so it gets the
    // same status and keeps access until current_period_end.
    case "paused":
      return "cancelled";
    case "expired":
    case "unpaid":
      return "expired";
    default:
      return null;
  }
}

/**
 * subscription_created — the first event of a paid subscription.
 *
 * Attribution comes from `meta.custom_data.user_id`, which our checkout
 * route put there. Without it the purchase cannot be tied to an account, so
 * this refuses rather than picking a user by email: a wrong match here
 * hands one person's paid plan to another.
 */
export async function applySubscriptionCreated(
  event: SubscriptionEvent,
  licenseKey: string | null,
): Promise<ApplyResult> {
  if (!event.customUserId) {
    return { applied: false, detail: "no custom_data.user_id — cannot attribute this subscription" };
  }
  if (!event.plan) {
    // An env var is missing or points at the wrong variant. Throwing gives
    // the route a 500, which makes Lemon Squeezy retry — and a retry after
    // the config is fixed actually succeeds.
    throw new Error(
      `[billing] variant ${event.variantId} is not mapped to any plan; check LEMONSQUEEZY_VARIANT_* env vars`,
    );
  }

  // Defence in depth behind the signed attribution in events.ts. Even with
  // a valid signature, a *second* subscription must not silently replace a
  // live one — that upsert is what would let a cheap purchase overwrite an
  // expensive plan. Resubscribing after a lapse still works, because a
  // lapsed row grants nothing and so is safe to replace.
  const current = await subscriptionByUserId(event.customUserId);
  if (
    current &&
    current.lemonsqueezy_subscription_id &&
    current.lemonsqueezy_subscription_id !== event.subscriptionId &&
    effectiveTier(current) !== "free"
  ) {
    console.error(
      `[billing] refusing to replace live subscription ${current.lemonsqueezy_subscription_id} ` +
        `for user ${event.customUserId} with ${event.subscriptionId} — resolve by hand`,
    );
    return {
      applied: false,
      detail: `user already has a live subscription (${current.lemonsqueezy_subscription_id})`,
    };
  }

  const row = {
    user_id: event.customUserId,
    lemonsqueezy_customer_id: event.customerId,
    lemonsqueezy_subscription_id: event.subscriptionId,
    tier: event.plan.tier as Tier,
    billing_period: event.plan.period as BillingPeriod,
    // The spec fixes this at active. Lemon Squeezy can report `on_trial`
    // here, which maps to active anyway; anything stranger is still a
    // subscription that was just created and paid for.
    status: "active" as SubscriptionStatus,
    current_period_end: event.currentPeriodEnd,
    // Keep whatever we already have if this delivery couldn't fetch one.
    // Lemon Squeezy retries `subscription_created`, and a transient failure
    // in the license-key lookup must not erase a key stored by an earlier
    // attempt.
    license_key: licenseKey ?? current?.license_key ?? null,
  };

  // Upsert on user_id: one row per user (see the migration). A user who
  // cancelled and came back overwrites their old row, which is what makes
  // the *old* subscription's later events find nothing and be ignored.
  await upsertEntitlement(event.name, row);

  return {
    applied: true,
    detail: `${event.plan.tier}/${event.plan.period} active for ${event.customUserId}`,
  };
}

/**
 * subscription_updated — upgrades, downgrades, plan switches, and any
 * status change Lemon Squeezy reports for a subscription we already know.
 */
export async function applySubscriptionUpdated(event: SubscriptionEvent): Promise<ApplyResult> {
  const existing = await subscriptionByLemonId(event.subscriptionId);

  if (!existing) {
    // Self-heal: if `subscription_created` was missed (a webhook outage, a
    // subscription made before the integration existed) this can still
    // establish the row — but only when the event carries our own
    // custom_data *and* the user has no other subscription on file. If
    // they do, this event belongs to a superseded subscription and acting
    // on it would downgrade a paying customer.
    if (!event.customUserId || !event.plan) {
      return { applied: false, detail: "unknown subscription and not enough data to create one" };
    }
    const forUser = await subscriptionByUserId(event.customUserId);
    if (forUser && forUser.lemonsqueezy_subscription_id !== event.subscriptionId) {
      return {
        applied: false,
        detail: `superseded subscription ${event.subscriptionId}; user is on ${forUser.lemonsqueezy_subscription_id}`,
      };
    }
    return applySubscriptionCreated(event, null);
  }

  // A refunded subscription is terminal. Lemon Squeezy keeps sending
  // `subscription_updated` for it (status `active` right up until it
  // expires), and honouring those would undo the refund's revocation.
  if (existing.status === "refunded") {
    return { applied: false, detail: "subscription is refunded; entitlement is terminal" };
  }

  const status = mapLemonStatus(event.lemonStatus);
  const patch: Parameters<typeof writeEntitlement>[2] = {
    current_period_end: event.currentPeriodEnd,
    lemonsqueezy_customer_id: event.customerId ?? existing.lemonsqueezy_customer_id,
  };

  // Plan switches: the variant is the only thing that says what they are
  // on now, so tier and period move together or not at all.
  if (event.plan) {
    patch.tier = event.plan.tier;
    patch.billing_period = event.plan.period;
  }

  if (status) {
    patch.status = status;
    // A subscription that came back from the dead — reactivated after a
    // failed payment, say — must not keep a tier of free from whatever
    // expired it. Restore the tier its variant says it is.
    if (status === "active" && event.plan) patch.tier = event.plan.tier;
  }

  await writeEntitlement(event.name, existing.user_id, patch);
  return {
    applied: true,
    detail: `synced ${event.subscriptionId}: tier=${patch.tier ?? existing.tier} status=${patch.status ?? existing.status}`,
  };
}

/**
 * subscription_cancelled — will not renew. Access continues to
 * `current_period_end`; see effectiveTier.
 */
export async function applySubscriptionCancelled(event: SubscriptionEvent): Promise<ApplyResult> {
  const existing = await subscriptionByLemonId(event.subscriptionId);
  if (!existing) return { applied: false, detail: "unknown subscription; ignored" };
  if (existing.status === "refunded") {
    return { applied: false, detail: "already refunded; entitlement is terminal" };
  }

  await writeEntitlement(event.name, existing.user_id, {
    status: "cancelled",
    // Tier deliberately untouched — they keep what they paid for until the
    // period ends.
    current_period_end: event.currentPeriodEnd ?? existing.current_period_end,
  });

  return { applied: true, detail: `cancelled ${event.subscriptionId}, access until ${event.currentPeriodEnd}` };
}

/** subscription_expired — the period is over. Back to free, immediately. */
export async function applySubscriptionExpired(event: SubscriptionEvent): Promise<ApplyResult> {
  const existing = await subscriptionByLemonId(event.subscriptionId);
  if (!existing) return { applied: false, detail: "unknown subscription; ignored" };

  await writeEntitlement(event.name, existing.user_id, {
    tier: "free",
    status: "expired",
    billing_period: null,
    current_period_end: event.currentPeriodEnd ?? existing.current_period_end,
  });

  return { applied: true, detail: `expired ${event.subscriptionId}; tier=free` };
}

/**
 * subscription_payment_failed — a charge did not go through. Status only:
 * the tier stays put so the customer keeps working while Lemon Squeezy
 * retries the card. `subscription_expired` is what eventually revokes it,
 * with PAST_DUE_GRACE_DAYS as the backstop if that never arrives.
 */
export async function applyPaymentFailed(event: InvoiceEvent): Promise<ApplyResult> {
  if (!event.subscriptionId) {
    return { applied: false, detail: "invoice has no subscription_id" };
  }

  const existing = await subscriptionByLemonId(event.subscriptionId);
  if (!existing) return { applied: false, detail: "unknown subscription; ignored" };
  if (existing.status === "refunded") {
    return { applied: false, detail: "already refunded; entitlement is terminal" };
  }

  await writeEntitlement(event.name, existing.user_id, { status: "past_due" });
  return { applied: true, detail: `past_due ${event.subscriptionId}; tier unchanged (${existing.tier})` };
}

/**
 * subscription_payment_success — money arrived, on the first payment and on
 * every renewal.
 *
 * This writes one row to payment_history and touches nothing else. It does
 * not call writeEntitlement, and it could not if it tried: `event.name` is
 * not on the entitlement list, so that function throws. See the comment on
 * ENTITLEMENT_EVENTS for why acting on this event would be wrong.
 */
export async function recordPaymentSuccess(event: InvoiceEvent): Promise<ApplyResult> {
  const userId = await resolveInvoiceUser(event);
  if (!userId) {
    return { applied: false, detail: "could not attribute invoice to a user" };
  }

  const admin = createAdminClient();
  const row = {
    user_id: userId,
    subscription_id: event.subscriptionId,
    lemonsqueezy_invoice_id: event.invoiceId,
    lemonsqueezy_order_id: null,
    amount: event.amount,
    currency: event.currency,
    status: "success" as const,
    paid_at: event.paidAt,
    refunded: false,
  };

  // Idempotent on the invoice id: Lemon Squeezy retries deliveries, and a
  // retried renewal must not show up as two payments. `ignoreDuplicates`
  // also means a redelivery cannot flip an already-refunded row back to
  // success.
  const { error } = await admin
    .from("payment_history")
    .upsert(row, { onConflict: "lemonsqueezy_invoice_id", ignoreDuplicates: true });
  if (error) throw error;

  return { applied: true, detail: `recorded ${event.amount} ${event.currency} for ${userId}` };
}

/**
 * subscription_payment_refunded — the money went back.
 *
 * Revokes immediately rather than waiting for `subscription_cancelled` or
 * for the period to end, and marks the matching payment row refunded.
 */
export async function applyPaymentRefunded(event: InvoiceEvent): Promise<ApplyResult> {
  const admin = createAdminClient();

  const existing = event.subscriptionId
    ? await subscriptionByLemonId(event.subscriptionId)
    : null;

  if (existing) {
    await writeEntitlement(event.name, existing.user_id, {
      tier: "free",
      status: "refunded",
      billing_period: null,
    });
  }

  const userId = existing?.user_id ?? (await resolveInvoiceUser(event));
  if (!userId) {
    return {
      applied: Boolean(existing),
      detail: "revoked access but could not attribute the invoice to a user",
    };
  }

  // Upsert rather than update: a refund can arrive for an invoice whose
  // success event we never saw (an outage, or a payment made before this
  // integration shipped), and the history should still show it.
  const { error } = await admin.from("payment_history").upsert(
    {
      user_id: userId,
      subscription_id: event.subscriptionId,
      lemonsqueezy_invoice_id: event.invoiceId,
      lemonsqueezy_order_id: null,
      amount: event.amount,
      currency: event.currency,
      status: "refunded" as const,
      paid_at: event.paidAt,
      refunded: true,
    },
    { onConflict: "lemonsqueezy_invoice_id" },
  );
  if (error) throw error;

  return {
    applied: true,
    detail: existing
      ? `refunded ${event.subscriptionId}; tier=free, invoice ${event.invoiceId} marked refunded`
      : `marked invoice ${event.invoiceId} refunded (no subscription row to revoke)`,
  };
}

/**
 * Which user an invoice belongs to. The subscription row is preferred over
 * the event's custom data because it is our own record; custom data is the
 * fallback for the first payment, which can race ahead of
 * `subscription_created`.
 */
async function resolveInvoiceUser(event: InvoiceEvent): Promise<string | null> {
  if (event.subscriptionId) {
    const row = await subscriptionByLemonId(event.subscriptionId);
    if (row) return row.user_id;
  }
  return event.customUserId;
}
