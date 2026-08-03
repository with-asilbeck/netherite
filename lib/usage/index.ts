import { createAdminClient } from "@/lib/supabase/admin";
import { getUserTier } from "@/lib/get-user-tier";
import { monthlySoftCapFor } from "@/lib/tiers";
import {
  ACTION_WINDOWS,
  capIsVisible,
  invisibleCapMessage,
  limitFor,
  secondsUntilReset,
  secondsUntilWindowReset,
  upgradeMessage,
  type ActionType,
  type Tier,
} from "./tiers";

export * from "./tiers";

/**
 * Server-side usage metering. The contract every caller must follow:
 *
 *   1. `reserveUsage(userId, action)` **before** the LLM call. It both
 *      checks and consumes a unit, atomically, so two parallel requests
 *      cannot spend the same last unit.
 *   2. If the call fails before doing any real work, `releaseUsage()` so
 *      the user isn't billed a unit for an upstream outage.
 *   3. `recordUsageCost()` when the call finishes, to attach the real token
 *      and dollar numbers derived in lib/llm (token counts x MODEL_PRICING).
 *
 * `userId` must always be the id from `supabase.auth.getUser()` on the
 * server. It must never come from a request body, header, query parameter,
 * or client-supplied JWT claim — that is the whole bypass surface for this
 * feature, and passing anything else here defeats it.
 */

export type ReserveResult =
  | { ok: true; eventId: string; tier: Tier; used: number; limit: number }
  | {
      ok: false;
      reason: "limit_exceeded";
      tier: Tier;
      used: number;
      limit: number;
      message: string;
      /**
       * False when the cap the caller hit is an internal fair-use ceiling
       * rather than an advertised limit — currently only the message cap on
       * a paid tier. Routes use it to choose between an upgrade prompt and
       * a generic "try again later", and `message` is already written to
       * match, so a route that ignores this still can't leak the number.
       */
      visible: boolean;
      /** Seconds until this cap's window rolls over, for Retry-After. */
      retryAfterSeconds: number;
    }
  | { ok: false; reason: "unavailable"; message: string };

/** Start of the current UTC month, the window the monthly soft cap counts over. */
function monthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function reserveUsage(
  userId: string,
  action: ActionType,
): Promise<ReserveResult> {
  let tier: Tier;
  let limit: number;

  try {
    // The one tier lookup in the app. Request-memoised, so a route that
    // also asks getUserEntitlement() for feature flags costs one query, not
    // two — see lib/get-user-tier.ts.
    ({ tier } = await getUserTier(userId));
    limit = limitFor(tier, action);

    const admin = createAdminClient();

    // The monthly message ceiling, where a tier has one. It is checked here
    // rather than inside reserve_usage because that function reserves
    // against exactly one window: a second call would insert a second row
    // and double-count every message. Checking first is therefore a read,
    // not a reservation, and two simultaneous requests can both pass it —
    // which is why the field is named a *soft* cap. Being a few messages
    // over an invisible fair-use ceiling costs nothing; a second write path
    // through the ledger, or a migration to a two-window reserve, would cost
    // considerably more than it protects.
    //
    // The daily cap below is unaffected and stays atomic.
    const softCap = action === "chat" ? monthlySoftCapFor(tier) : null;
    if (softCap !== null) {
      const { count, error: countError } = await admin
        .from("usage_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("action_type", "chat")
        .gte("created_at", monthStart().toISOString());

      if (countError) throw countError;

      const usedThisMonth = count ?? 0;
      if (usedThisMonth >= softCap) {
        // Never `visible`: a monthly ceiling only exists on tiers sold as
        // unlimited messages, so it gets the same say-nothing copy the
        // daily one does. The retry window is the month, not the day —
        // tomorrow would not help.
        return {
          ok: false,
          reason: "limit_exceeded",
          tier,
          used: usedThisMonth,
          limit: softCap,
          message: invisibleCapMessage(),
          visible: false,
          retryAfterSeconds: secondsUntilReset("month"),
        };
      }
    }
    const { data, error } = await admin.rpc("reserve_usage", {
      p_user_id: userId,
      p_action_type: action,
      p_limit: limit,
      // Declared alongside the cap in ACTION_WINDOWS, never inferred in the
      // database, so the window a limit is enforced against is the same one
      // the dashboard counts and the copy describes.
      p_window: ACTION_WINDOWS[action],
    });

    if (error) throw error;

    // The function returns a single row; supabase-js surfaces set-returning
    // functions as an array.
    const row = (Array.isArray(data) ? data[0] : data) as
      | { allowed?: unknown; used?: unknown; event_id?: unknown }
      | null
      | undefined;

    if (!row || typeof row.allowed !== "boolean") {
      throw new Error("reserve_usage returned an unreadable row");
    }

    const used = typeof row.used === "number" ? row.used : 0;

    if (!row.allowed) {
      // Which cap was hit decides what the user is told. An advertised
      // limit gets the specific upgrade prompt; the fair-use ceiling on a
      // plan sold as unlimited gets a message that names no number, because
      // telling a paying customer they exceeded a limit they were told did
      // not exist is worse than being vague.
      const visible = capIsVisible(tier, action);
      return {
        ok: false,
        reason: "limit_exceeded",
        tier,
        used,
        limit,
        message: visible ? upgradeMessage(tier, action, limit) : invisibleCapMessage(),
        visible,
        retryAfterSeconds: secondsUntilWindowReset(action),
      };
    }

    if (typeof row.event_id !== "string") {
      throw new Error("reserve_usage allowed the call but returned no event id");
    }

    return { ok: true, eventId: row.event_id, tier, used, limit };
  } catch (err) {
    // Fail closed. Letting the call through when the ledger is unreachable
    // would make "break the usage check" the cheapest way to get unmetered
    // LLM calls, which is exactly the bypass this feature exists to stop.
    //
    // This costs less availability than it looks like: every one of these
    // routes already requires Supabase to be reachable for
    // `auth.getUser()`, so there is no scenario where the app is otherwise
    // healthy and only the ledger is down.
    console.error(`[usage] reserve failed for action=${action}:`, err);
    return {
      ok: false,
      reason: "unavailable",
      message:
        "We couldn't verify your usage allowance just now, so this request was stopped rather than run unmetered. Please try again in a moment.",
    };
  }
}

/**
 * Hands a reserved unit back. Best-effort: a failure here over-counts by
 * one, which is the safe direction to be wrong in, so it never propagates.
 */
export async function releaseUsage(eventId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("usage_events").delete().eq("id", eventId);
    if (error) throw error;
  } catch (err) {
    console.error("[usage] couldn't release reservation:", eventId, err);
  }
}

export type UsageCost = {
  tokensUsed: number | null;
  costUsd: number | null;
  model: string | null;
};

/**
 * Attaches real cost data to an already-reserved row. Also best-effort:
 * the quota decision was made at reservation time and does not depend on
 * this succeeding — losing it costs a row of cost reporting, not enforcement.
 */
export async function recordUsageCost(eventId: string, cost: UsageCost): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("usage_events")
      .update({
        tokens_used: cost.tokensUsed,
        estimated_cost_usd: cost.costUsd,
        model: cost.model,
      })
      .eq("id", eventId);
    if (error) throw error;
  } catch (err) {
    console.error("[usage] couldn't record cost for:", eventId, err);
  }
}
