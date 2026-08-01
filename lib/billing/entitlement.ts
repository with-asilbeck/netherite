// What a subscription row actually entitles somebody to.
//
// Pure functions over a plain object, with no database and no env access,
// so the rules can be read in one place and exercised directly by
// scripts/billing-webhook-test.mjs. Every caps decision in the app resolves
// through `effectiveTier` — see lib/usage/index.ts.

import { DEFAULT_TIER, isTier, TIERS, type Tier } from "@/lib/usage/tiers";
import { type BillingPeriod } from "./plans";

export const SUBSCRIPTION_STATUSES = [
  "active",
  "cancelled",
  "past_due",
  "expired",
  "refunded",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
  );
}

export type SubscriptionRecord = {
  user_id: string;
  lemonsqueezy_customer_id: string | null;
  lemonsqueezy_subscription_id: string | null;
  tier: Tier;
  billing_period: BillingPeriod | null;
  status: SubscriptionStatus;
  current_period_end: string | null;
  license_key: string | null;
};

/**
 * How long a `past_due` subscription keeps its tier after the period it
 * paid for has run out.
 *
 * The spec says a failed payment must not revoke access immediately, and
 * Lemon Squeezy retries a failed charge over roughly a week before giving
 * up and sending `subscription_expired`. The grace window exists so that if
 * that final event is never delivered — a webhook outage, a URL that moved
 * — the entitlement still lapses on its own instead of granting a paid tier
 * forever. It is a backstop for a missing event, not the primary mechanism.
 */
export const PAST_DUE_GRACE_DAYS = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The tier a subscription row grants right now, or `free`.
 *
 * Unknown statuses, unknown tiers, and unparseable dates all resolve to
 * `free`. That direction is not arbitrary: this function is the last thing
 * between a corrupt row and free usage of a paid product, so anything it
 * cannot positively justify has to be the cheapest tier, never the most
 * generous one.
 */
export function effectiveTier(
  subscription: Pick<SubscriptionRecord, "tier" | "status" | "current_period_end"> | null,
  now: Date = new Date(),
): Tier {
  if (!subscription) return DEFAULT_TIER;

  const { tier, status } = subscription;
  if (!isTier(tier) || !isSubscriptionStatus(status)) return DEFAULT_TIER;
  if (tier === "free") return DEFAULT_TIER;

  switch (status) {
    // Paid and current.
    case "active":
      return tier;

    // Cancelled means "will not renew", not "is over". The customer paid
    // for the period they are in, so they keep the tier until it ends.
    case "cancelled":
      return periodStillOpen(subscription.current_period_end, now, 0) ? tier : DEFAULT_TIER;

    // A charge failed and Lemon Squeezy is retrying. Keep access through
    // the grace window — see PAST_DUE_GRACE_DAYS.
    case "past_due":
      return periodStillOpen(subscription.current_period_end, now, PAST_DUE_GRACE_DAYS)
        ? tier
        : DEFAULT_TIER;

    // Both terminal, both immediate. `refunded` in particular must not
    // wait for a period to run out: the money went back, so the access
    // goes with it.
    case "expired":
    case "refunded":
      return DEFAULT_TIER;
  }
}

/**
 * The final tier, combining a subscription with the optional manual
 * override in `user_tiers`.
 *
 * The override can only raise the result. A comped account must not lose
 * its grant when it has no subscription, and — more importantly — a stale
 * or forgotten override row must never *lower* the tier of somebody who is
 * actually paying. Both the enforcement path (lib/usage/index.ts) and the
 * dashboard (lib/usage/queries.ts) call this, so what is displayed and what
 * is enforced cannot disagree.
 */
export function resolveEffectiveTier(
  subscription: Pick<SubscriptionRecord, "tier" | "status" | "current_period_end"> | null,
  overrideTier: unknown,
  now: Date = new Date(),
): Tier {
  const subscribed = effectiveTier(subscription, now);
  const override = isTier(overrideTier) ? overrideTier : DEFAULT_TIER;
  return TIERS.indexOf(override) > TIERS.indexOf(subscribed) ? override : subscribed;
}

function periodStillOpen(
  currentPeriodEnd: string | null,
  now: Date,
  graceDays: number,
): boolean {
  // No end date and a non-active status means there is nothing to say the
  // access is still good. Fail closed.
  if (!currentPeriodEnd) return false;

  const end = new Date(currentPeriodEnd);
  if (Number.isNaN(end.getTime())) return false;

  return now.getTime() < end.getTime() + graceDays * DAY_MS;
}

/** Copy for the account page: what the current status means for the user. */
export function statusDescription(
  subscription: Pick<SubscriptionRecord, "status" | "current_period_end"> | null,
): string | null {
  if (!subscription) return null;

  const ends = subscription.current_period_end
    ? formatDate(subscription.current_period_end)
    : null;

  switch (subscription.status) {
    case "active":
      return ends ? `Renews on ${ends}.` : "Active.";
    case "cancelled":
      return ends
        ? `Cancelled — your plan stays active until ${ends}, then reverts to Free.`
        : "Cancelled.";
    case "past_due":
      return "We couldn't take your last payment. Update your card to keep your plan — access continues for now.";
    case "expired":
      return "Your subscription has ended. You're on the Free plan.";
    case "refunded":
      return "This subscription was refunded and access has ended.";
    default:
      return null;
  }
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
