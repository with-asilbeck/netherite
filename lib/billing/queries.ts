import { createClient } from "@/lib/supabase/server";
import { getUserTier } from "@/lib/get-user-tier";
import type { PaymentHistoryRow } from "@/lib/supabase/billing-schema";

import type { SubscriptionRecord } from "./entitlement";
import type { Tier } from "@/lib/usage/tiers";

/**
 * The signed-in user's own billing state, read through the *user's* client
 * rather than the service-role one — the same rule lib/usage/queries.ts
 * follows. RLS is what scopes these queries to their own rows, so the page
 * that renders them never holds a key capable of reading anyone else's.
 *
 * lib/billing/store.ts keeps the service-role versions of these reads. They
 * exist for the webhook, which has no user session to read through.
 */

export type OwnBilling = {
  tier: Tier;
  /** True when the plan is cancelled but the paid period hasn't run out. */
  cancellingSoon: boolean;
  subscription: SubscriptionRecord | null;
  payments: PaymentHistoryRow[];
};

export async function getOwnBilling(): Promise<OwnBilling | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // The tier and the subscription row both come from the one resolver.
  // This page used to read `subscriptions` itself and resolve the tier
  // separately; that was a second lookup of the same thing, and a second
  // lookup is a second thing to keep in step. Payment history still goes
  // through the *user's* client, so RLS scopes what this page renders.
  const [resolved, { data: payments, error: paymentsError }] = await Promise.all([
    getUserTier(user.id),
    supabase
      .from("payment_history")
      .select("*")
      .eq("user_id", user.id)
      .order("paid_at", { ascending: false })
      .limit(24),
  ]);

  if (paymentsError) throw paymentsError;

  return {
    // Already resolved, never the raw column: a cancelled or refunded row
    // can still hold "pro" while granting nothing, and the account page
    // must show what the caps actually are.
    tier: resolved.tier,
    cancellingSoon: resolved.cancellingSoon,
    subscription: resolved.subscription,
    payments: (payments ?? []) as PaymentHistoryRow[],
  };
}
