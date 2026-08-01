import { createClient } from "@/lib/supabase/server";
import { getUserTier } from "@/lib/get-user-tier";
import { limitsFor, type TierLimits } from "@/lib/tiers";
import {
  ACTION_TYPES,
  ACTION_WINDOWS,
  capIsVisible,
  TIER_LIMITS,
  type ActionType,
  type Tier,
} from "./tiers";

/** Start of the current UTC month — the window the cost table is summed over. */
export function currentMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function formatMonth(date: Date): string {
  return date.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export type ActionUsage = {
  action: ActionType;
  /** Used within this action's own cap window — today for chat, the month otherwise. */
  used: number;
  limit: number;
  window: "day" | "month";
  /**
   * False for a fair-use ceiling the user was never sold — currently the
   * message cap on a paid plan. The dashboard must render those as
   * "Unlimited" and must not put the number on the page: the plans are
   * marketed as unlimited messages, and printing a ceiling next to that
   * claim contradicts it.
   */
  visible: boolean;
  /** Month-to-date, for the cost table, regardless of the cap window. */
  monthCount: number;
  tokensUsed: number;
  costUsd: number;
};

export type OwnUsage = {
  tier: Tier;
  limits: TierLimits;
  monthStart: Date;
  actions: ActionUsage[];
  totalCostUsd: number;
};

/**
 * The signed-in user's own usage. Reads through the *user's* client, not the
 * service-role one, so RLS is what scopes this to their own rows — a page
 * that only ever shows you your own data has no business holding a key that
 * could show it anyone else's.
 *
 * The tier is resolved with the same function the enforcement path uses, so
 * what this page shows and what the caps actually allow cannot disagree.
 */
export async function getOwnUsage(): Promise<OwnUsage | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // The tier comes from the one resolver rather than a lookup of this
  // page's own — that is what stops the dashboard showing a plan the caps
  // don't actually grant. The usage counts still go through the *user's*
  // client, so RLS is what scopes the rows this page renders.
  const [resolved, { data: usageRows, error }] = await Promise.all([
    getUserTier(user.id),
    supabase.rpc("current_usage"),
  ]);

  if (error) throw error;

  const tier = resolved.tier;

  const byAction = new Map<
    string,
    { windowCount: number; monthCount: number; tokens: number; cost: number }
  >();
  for (const row of (usageRows ?? []) as {
    action_type: string;
    window_count: number | string;
    month_count: number | string;
    tokens_used: number | string;
    cost_usd: number | string;
  }[]) {
    byAction.set(row.action_type, {
      windowCount: Number(row.window_count) || 0,
      monthCount: Number(row.month_count) || 0,
      tokens: Number(row.tokens_used) || 0,
      cost: Number(row.cost_usd) || 0,
    });
  }

  const actions: ActionUsage[] = ACTION_TYPES.map((action) => {
    const row = byAction.get(action);
    return {
      action,
      used: row?.windowCount ?? 0,
      limit: TIER_LIMITS[tier][action],
      window: ACTION_WINDOWS[action],
      visible: capIsVisible(tier, action),
      monthCount: row?.monthCount ?? 0,
      tokensUsed: row?.tokens ?? 0,
      costUsd: row?.cost ?? 0,
    };
  });

  return {
    tier,
    limits: limitsFor(tier),
    monthStart: currentMonthStart(),
    actions,
    totalCostUsd: actions.reduce((sum, a) => sum + a.costUsd, 0),
  };
}
