/**
 * Schema types for the billing tables, in the same hand-written style and
 * for the same reason as usage-schema.ts: an untyped supabase-js client
 * infers `never` for `.update()`, so without these every webhook write
 * would be a cast and a renamed column would only be found at runtime.
 *
 * Keep in sync with supabase/migrations/20260801020000_lemonsqueezy_billing.sql.
 */

import type { BillingPeriod } from "@/lib/billing/plans";
import type { SubscriptionStatus } from "@/lib/billing/entitlement";
import type { Tier } from "@/lib/usage/tiers";

export type SubscriptionRow = {
  user_id: string;
  lemonsqueezy_customer_id: string | null;
  lemonsqueezy_subscription_id: string | null;
  tier: Tier;
  billing_period: BillingPeriod | null;
  status: SubscriptionStatus;
  current_period_end: string | null;
  license_key: string | null;
  created_at: string;
  updated_at: string;
};

export type PaymentStatus = "success" | "refunded" | "failed";

export type PaymentHistoryRow = {
  id: string;
  user_id: string;
  subscription_id: string | null;
  lemonsqueezy_invoice_id: string | null;
  lemonsqueezy_order_id: string | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  paid_at: string;
  refunded: boolean;
  created_at: string;
};

export type BillingTables = {
  subscriptions: {
    Row: SubscriptionRow;
    Insert: Omit<SubscriptionRow, "created_at" | "updated_at"> &
      Partial<Pick<SubscriptionRow, "created_at" | "updated_at">>;
    Update: Partial<SubscriptionRow>;
    Relationships: [];
  };
  payment_history: {
    Row: PaymentHistoryRow;
    Insert: Omit<PaymentHistoryRow, "id" | "created_at"> &
      Partial<Pick<PaymentHistoryRow, "id" | "created_at">>;
    Update: Partial<PaymentHistoryRow>;
    Relationships: [];
  };
};
