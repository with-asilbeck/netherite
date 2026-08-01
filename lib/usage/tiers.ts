// The metering vocabulary: the three actions that consume quota, the window
// each one is counted over, and the copy shown when somebody runs out.
//
// The numbers themselves are NOT here. They live in lib/tiers.ts, which is
// the single source of truth for both volume and feature entitlement, and
// this file projects them into the per-action shape the usage ledger works
// in. Keeping one copy is the whole point: the enforcement path, the usage
// dashboard, and the pricing page all read the same integers, so a
// displayed limit and an enforced limit cannot drift apart.

import {
  TIER_LIMITS as TIER_CONFIG,
  TIER_LABELS,
  TIERS,
  DEFAULT_TIER,
  isTier,
  messagesCapIsVisible,
  nextTier,
  type Tier,
} from "@/lib/tiers";

export { TIERS, TIER_LABELS, DEFAULT_TIER, isTier, nextTier, messagesCapIsVisible };
export type { Tier };

export const ACTION_TYPES = ["chat", "snippet", "repo_scan"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export function isActionType(value: unknown): value is ActionType {
  return typeof value === "string" && (ACTION_TYPES as readonly string[]).includes(value);
}

/**
 * The window each cap is counted over.
 *
 * Messages are capped per day and the scan actions per month, which is not
 * an implementation detail — it is what makes "unlimited messages, fair-use
 * ceiling" expressible at all. A monthly message cap would either be so
 * large it stops nothing or so small a heavy day exhausts the month.
 *
 * `reserve_usage` in the database takes this as an argument, so the window
 * used to enforce a cap is always the one declared here.
 */
export const ACTION_WINDOWS: Record<ActionType, "day" | "month"> = {
  chat: "day",
  snippet: "month",
  repo_scan: "month",
};

/** Per-action caps, projected out of the tier catalogue. */
export const TIER_LIMITS: Record<Tier, Record<ActionType, number>> = Object.fromEntries(
  TIERS.map((tier) => [
    tier,
    {
      chat: TIER_CONFIG[tier].messages_daily_cap,
      snippet: TIER_CONFIG[tier].snippets_monthly,
      repo_scan: TIER_CONFIG[tier].repo_scans_monthly,
    },
  ]),
) as Record<Tier, Record<ActionType, number>>;

export const ACTION_LABELS: Record<ActionType, string> = {
  chat: "Advisor messages",
  snippet: "Snippet analyses",
  repo_scan: "Repository scans",
};

export function limitFor(tier: Tier, action: ActionType): number {
  return TIER_LIMITS[tier][action];
}

/**
 * Whether a cap is one the user was sold, or an internal ceiling.
 *
 * Only the message cap is ever invisible, and only on paid tiers — see
 * messagesCapIsVisible. This is what decides between an upgrade prompt and
 * a deliberately vague "try again later", so it is checked at the point of
 * refusal rather than being inferred from the status code.
 */
export function capIsVisible(tier: Tier, action: ActionType): boolean {
  return action === "chat" ? messagesCapIsVisible(tier) : true;
}

/**
 * Thousands-separated count. The locale is pinned because a bare
 * `toLocaleString()` follows the *server's* ICU default, not the reader's —
 * which rendered "2 000" (narrow no-break space) inside otherwise
 * English copy. Every string here is English, so the grouping should be too.
 */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * The message a blocked user sees when the cap is one they can see.
 * Deliberately specific — which limit, what the cap was, and what upgrading
 * would buy — rather than a generic "quota exceeded", so the response is
 * actionable instead of just a wall.
 *
 * Never called for an invisible cap; `invisibleCapMessage` is.
 */
export function upgradeMessage(tier: Tier, action: ActionType, limit: number): string {
  const period = ACTION_WINDOWS[action] === "day" ? "today" : "this month";
  const resets =
    ACTION_WINDOWS[action] === "day"
      ? "Your limit resets at midnight UTC"
      : "Your limit resets at the start of next month";

  const noun = {
    chat: `${formatCount(limit)} advisor messages`,
    snippet: `${formatCount(limit)} snippet analyses`,
    repo_scan: `${formatCount(limit)} repository scan${limit === 1 ? "" : "s"}`,
  }[action];

  const next = nextTier(tier);
  if (!next) {
    return `You've used all ${noun} included in your ${TIER_LABELS[tier]} plan ${period}. ${resets} — get in touch if you need a higher ceiling before then.`;
  }

  const nextLimit = TIER_LIMITS[next][action];
  const nextDescription =
    action === "chat" && !messagesCapIsVisible(next)
      ? `Upgrade to ${TIER_LABELS[next]} for unlimited messages`
      : `Upgrade to ${TIER_LABELS[next]} for ${formatCount(nextLimit)} per month`;

  return `You've used all ${noun} included in your ${TIER_LABELS[tier]} plan ${period}. ${nextDescription}, or wait — ${resets.toLowerCase()}.`;
}

/**
 * What a paying customer sees if they somehow reach the fair-use ceiling on
 * a plan sold as unlimited.
 *
 * It names no limit and no number on purpose. They were promised unlimited
 * messages; the honest-but-useless options are to say nothing about a cap
 * or to contradict the thing they bought. This says the request couldn't be
 * served right now, which is true, and points at support for the case where
 * it is a genuine workload rather than a runaway script.
 */
export function invisibleCapMessage(): string {
  return "We couldn't process that message right now. Please try again in a little while — if this keeps happening, get in touch and we'll sort it out.";
}

/** Seconds until the current window rolls over, for a Retry-After header. */
export function secondsUntilWindowReset(action: ActionType, now: Date = new Date()): number {
  if (ACTION_WINDOWS[action] === "day") {
    const midnight = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
    return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
  }

  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((nextMonth - now.getTime()) / 1000));
}
