import { cache } from "react";

import {
  effectiveTier,
  isSubscriptionStatus,
  resolveEffectiveTier,
  type SubscriptionRecord,
  type SubscriptionStatus,
} from "@/lib/billing/entitlement";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_TIER, type Tier } from "@/lib/tiers";
import { entitlementFor, type Entitlement } from "@/lib/tier-features";

// The single place a user's tier is resolved.
//
// Everything that needs to know what somebody is entitled to — the three
// metered routes, the feature gates, the usage dashboard, the account page
// — comes through here. Nothing else queries `subscriptions` to work out a
// tier, and nothing else calls `effectiveTier`, with one deliberate
// exception noted at the bottom of this comment.
//
// Three properties this file exists to guarantee:
//
//   1. **It always reads the database.** There is no parameter for a tier,
//      a plan name, or a feature flag, so no caller can pass one in — the
//      only input is a user id, and every caller takes that from
//      `supabase.auth.getUser()` on the server. A request body cannot
//      influence the result of this function even by accident.
//
//   2. **It is memoised per request, never across them.** `cache()` from
//      React is scoped to a single request and keyed on the argument, so
//      two calls for the same user in one request hit the database once,
//      and a later request — or a different user in the same one — never
//      sees another's answer. That matters more than the saved round trip:
//      an upgrade or a downgrade must take effect on the very next request,
//      and a cache with any lifetime beyond the request would mean serving
//      a plan the customer no longer has, or withholding one they just
//      bought.
//
//   3. **It fails closed.** An unreadable row, an unknown status, a corrupt
//      tier string, an unparseable date — all resolve to `free`. This is
//      the last thing between a bad row and free use of a paid product.
//
// The one place that still calls `effectiveTier` directly is
// `lib/billing/store.ts`, in the guard that refuses to let a new
// subscription overwrite one that is still granting access. That is the
// webhook reasoning about a row it has already fetched, inside the writer
// itself — not a second way of answering "what is this user's tier" for a
// request. It uses the same rule function, so it cannot drift.

/**
 * What a user is entitled to right now, and why.
 *
 * `tier` is the only field enforcement may act on. `status`,
 * `cancellingSoon`, and `currentPeriodEnd` are context for the UI and for
 * logs — see the note on `cancellingSoon`.
 */
export type ResolvedTier = {
  /** The tier to enforce. Already accounts for status and period end. */
  tier: Tier;

  /** The raw subscription status, or null when there is no subscription row. */
  status: SubscriptionStatus | null;

  /**
   * True when the plan is cancelled but the paid period has not run out, so
   * the user still has their tier and will lose it on `currentPeriodEnd`.
   *
   * **For display only.** It is deliberately not an input to any cap or
   * feature decision — `tier` already reflects the access this user has, and
   * a second flag that enforcement also consulted would be a second source
   * of truth. It exists so the account page can say "cancelled, active
   * until the 30th" instead of just "Pro".
   */
  cancellingSoon: boolean;

  /** When paid access ends. Null when there is no subscription. */
  currentPeriodEnd: string | null;

  /**
   * Where the tier came from. `override` means a manual comp in
   * `user_tiers` outranked the subscription; useful when a support question
   * is "why does this account have Pro".
   */
  source: "subscription" | "override" | "default";

  /**
   * The subscription row itself, so callers that also need billing detail
   * (period, portal id, license key) don't perform a second read — and,
   * more to the point, don't end up with their own copy of the lookup.
   */
  subscription: SubscriptionRecord | null;
};

/**
 * The uncached implementation. Exported for tests and for any context with
 * no React request scope (the verification scripts, a future background
 * job). Application code should call `getUserTier`.
 */
export async function resolveUserTier(userId: string): Promise<ResolvedTier> {
  const admin = createAdminClient();

  const [subscription, manual] = await Promise.all([
    admin.from("subscriptions").select("*").eq("user_id", userId).maybeSingle(),
    admin.from("user_tiers").select("tier").eq("user_id", userId).maybeSingle(),
  ]);

  // Thrown, not defaulted. Free would be the safe answer, but the caller
  // (reserveUsage) turns a throw into a "couldn't verify your allowance"
  // refusal, which is honest — silently downgrading somebody because a
  // read failed would look identical to a billing bug.
  if (subscription.error) throw subscription.error;
  if (manual.error) throw manual.error;

  const row = (subscription.data as SubscriptionRecord | null) ?? null;
  const overrideValue = (manual.data as { tier?: unknown } | null)?.tier;

  // The rules live in lib/billing/entitlement.ts and are shared with the
  // webhook's own guard, so there is one definition of what each status
  // grants. `resolveEffectiveTier` layers the manual `user_tiers` override
  // on top, and that override may only ever *raise* the tier — a stale row
  // there must not demote somebody who is paying.
  const fromSubscription = effectiveTier(row);
  const tier = resolveEffectiveTier(row, overrideValue);

  // Since the override can only raise, a result above the subscription's
  // own answer is proof it was the override that decided.
  const overrideWins = tier !== fromSubscription;

  const status = isSubscriptionStatus(row?.status) ? row.status : null;

  return {
    tier,
    status,
    // Cancelled *and* still holding the tier is exactly "cancelling soon".
    // Derived from the resolved tier rather than from the date, so it can
    // never claim access the enforcement path is not actually granting.
    cancellingSoon: status === "cancelled" && fromSubscription !== DEFAULT_TIER,
    currentPeriodEnd: row?.current_period_end ?? null,
    source: overrideWins ? "override" : row ? "subscription" : "default",
    subscription: row,
  };
}

/**
 * Resolve a user's tier, memoised for the duration of the current request.
 *
 * This is the function application code should call. Two calls for the same
 * user id within one request perform one database read; nothing is shared
 * between requests or between users.
 *
 * If it is ever called outside a React request scope, `cache` degrades to
 * calling straight through — which costs an extra query and is never
 * stale, so the failure mode is slower, not wrong.
 */
export const getUserTier = cache(resolveUserTier);

/**
 * Tier plus everything derived from it: the caps and the feature flags.
 *
 * This is the whole chain the routes need in one call —
 * `getUserEntitlement(userId)` → tier → `TIER_LIMITS[tier]` → caps and
 * flags — so a route never has to hold a tier string and look things up
 * itself. Memoised alongside `getUserTier`, and backed by the same single
 * database read.
 */
export const getUserEntitlement = cache(
  async (userId: string): Promise<ResolvedTier & Entitlement> => {
    const resolved = await getUserTier(userId);
    return { ...resolved, ...entitlementFor(resolved.tier) };
  },
);
