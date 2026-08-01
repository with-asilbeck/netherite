/**
 * Minimal schema type for the tables and functions the service-role client
 * touches. Hand-written rather than generated because it covers only the
 * usage-tracking surface — supabase-js infers `never` for `.update()` and
 * `undefined` for `.rpc()` args on an untyped client, so the alternative
 * would be casting every call and losing the checks that catch a renamed
 * column at build time.
 *
 * Keep in sync with the migrations under supabase/migrations/ that touch
 * these objects — currently 20260731000000_usage_tracking.sql and
 * 20260731010000_drop_admin_usage_summary.sql.
 *
 * The billing tables are declared in ./billing-schema.ts and mixed in
 * below. They share this type because they share one service-role client;
 * they live in their own file because they belong to a different feature
 * and a different migration.
 */

import type { BillingTables } from "./billing-schema";
import type { ActionType, Tier } from "@/lib/usage/tiers";

export type UsageEventRow = {
  id: string;
  user_id: string;
  action_type: ActionType;
  tokens_used: number | null;
  estimated_cost_usd: number | null;
  model: string | null;
  created_at: string;
};

export type UserTierRow = {
  user_id: string;
  tier: Tier;
  updated_at: string;
};

export type UsageDatabase = {
  public: {
    Tables: {
      usage_events: {
        Row: UsageEventRow;
        Insert: Omit<UsageEventRow, "id" | "created_at"> &
          Partial<Pick<UsageEventRow, "id" | "created_at">>;
        Update: Partial<UsageEventRow>;
        Relationships: [];
      };
      user_tiers: {
        Row: UserTierRow;
        Insert: Omit<UserTierRow, "updated_at"> & Partial<Pick<UserTierRow, "updated_at">>;
        Update: Partial<UserTierRow>;
        Relationships: [];
      };
    } & BillingTables;
    Views: Record<never, never>;
    Functions: {
      reserve_usage: {
        Args: {
          p_user_id: string;
          p_action_type: ActionType;
          p_limit: number;
          /** 'day' or 'month' — see ACTION_WINDOWS in lib/usage/tiers.ts. */
          p_window: "day" | "month";
        };
        Returns: { allowed: boolean; used: number; event_id: string | null }[];
      };
      current_usage: {
        Args: Record<never, never>;
        Returns: {
          action_type: ActionType;
          /** Count within this action's enforcement window (day or month). */
          window_count: number;
          /** Count within the calendar month, for the cost table. */
          month_count: number;
          tokens_used: number;
          cost_usd: number;
        }[];
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
