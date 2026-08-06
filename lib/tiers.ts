// The tier catalogue: what each plan is allowed to do and how much of it.
//
// This is the single source of truth for both halves of entitlement —
// volume (how many) and features (which capabilities) — and it is the only
// file where those numbers and flags are written down. `lib/usage/tiers.ts`
// derives its per-action caps from here rather than keeping a second copy,
// because a displayed limit and an enforced limit that can drift apart is
// how a user ends up blocked at a number the UI never showed them.
//
// Nothing here reads a request, a header, or a cookie. Everything is keyed
// on a `Tier` that the caller resolved server-side from the `subscriptions`
// table — see lib/usage/index.ts#getUserTier. There is deliberately no
// function in this file that takes a tier name as a string from anywhere
// else.

/**
 * Cheapest to most expensive. `nextTier` walks this order and
 * `resolveEffectiveTier` compares indexes into it, so it must stay sorted.
 */
export const TIERS = ["free", "basic", "pro", "max"] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

/**
 * Every user without an entitling subscription is on this tier. It is also
 * what every fail-closed path resolves to: an unreadable row, an unknown
 * status, a corrupt tier string. Being the strictest tier is what makes
 * that safe.
 */
export const DEFAULT_TIER: Tier = "free";

/** Which pair of models the scan pipeline uses. See MODEL_TIERS. */
export type ModelTier = "fast" | "best";

export type TierLimits = {
  /**
   * Messages per UTC day.
   *
   * On every paid tier this is a fair-use ceiling, not a product limit —
   * the plans are marketed as unlimited messages, and nobody sending a
   * normal volume will ever see it. It exists so a scripted client cannot
   * run the advisor bill up without bound. `messagesCapIsVisible` below is
   * what decides whether hitting it produces an upgrade prompt or a
   * generic "try again later", and it must never be displayed as a number
   * on a tier where it is invisible.
   *
   * On `free` it is a real, advertised limit and is shown.
   */
  messages_daily_cap: number;

  /**
   * Advisor messages per calendar month, UTC — a second fair-use ceiling
   * behind the daily one, or `null` where the daily cap is the whole story.
   *
   * It exists because the two limits stop different things. The daily cap
   * bounds a burst; a month of sustained daily-cap usage is still 30x what
   * the plan is priced for, and only a monthly total catches that. Like the
   * daily cap on a paid tier it is never advertised and never rendered —
   * `messagesCapIsVisible` governs both.
   *
   * Unlike the daily cap, this one is **not** enforced atomically: see
   * reserveUsage in lib/usage/index.ts. It is a soft ceiling by design, and
   * a handful of messages either side of it is not worth a second write path.
   */
  messages_monthly_soft_cap: number | null;

  /** Snippet analyses per calendar month, UTC. User-facing on every tier. */
  snippets_monthly: number;

  /** Repository scans per calendar month, UTC. User-facing on every tier. */
  repo_scans_monthly: number;

  /** Which models the scan pipeline uses for the triage and deep passes. */
  model_tier: ModelTier;

  /**
   * Structured, exportable findings instead of the plain narrative report.
   * Applies to both repo scans and snippet analysis.
   */
  vulnerability_report: boolean;

  /**
   * Ask the model to work out how a flaw would actually be chained into a
   * real compromise, rather than only naming it.
   */
  deep_exploit_analysis: boolean;

  /** Scans jump the admission queue ahead of free and basic. */
  priority_queue: boolean;

  /**
   * Scanning private repositories through the GitHub App installation.
   *
   * Paid-only, and the gate is drawn at "pays us anything" rather than at a
   * capability level: a private scan pulls somebody's unpublished source onto
   * our disk and through two model vendors, so the account behind it should
   * be one with a billing relationship and an identity attached. It is
   * deliberately the only feature in this table whose reason is accountability
   * rather than cost or capability.
   */
  private_repo_scanning: boolean;
};

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: {
    messages_daily_cap: 50,
    messages_monthly_soft_cap: null,
    snippets_monthly: 10,
    repo_scans_monthly: 2,
    model_tier: "fast",
    vulnerability_report: false,
    deep_exploit_analysis: false,
    priority_queue: false,
    private_repo_scanning: false,
  },
  basic: {
    messages_daily_cap: 100,
    messages_monthly_soft_cap: 700,
    snippets_monthly: 100,
    repo_scans_monthly: 10,
    model_tier: "fast",
    vulnerability_report: false,
    deep_exploit_analysis: false,
    priority_queue: false,
    private_repo_scanning: true,
  },
  pro: {
    messages_daily_cap: 2_000,
    messages_monthly_soft_cap: null,
    snippets_monthly: 200,
    repo_scans_monthly: 50,
    model_tier: "fast",
    vulnerability_report: true,
    deep_exploit_analysis: true,
    priority_queue: true,
    private_repo_scanning: true,
  },
  max: {
    messages_daily_cap: 5_000,
    messages_monthly_soft_cap: null,
    snippets_monthly: 500,
    repo_scans_monthly: 200,
    model_tier: "best",
    vulnerability_report: true,
    deep_exploit_analysis: true,
    priority_queue: true,
    private_repo_scanning: true,
  },
};

export const TIER_LABELS: Record<Tier, string> = {
  free: "Free",
  basic: "Basic",
  pro: "Pro",
  max: "Max",
};

/** The gated capabilities, as a list, for iterating in the UI and in tests. */
export const TIER_FEATURES = [
  "vulnerability_report",
  "deep_exploit_analysis",
  "priority_queue",
  "private_repo_scanning",
] as const;

export type TierFeature = (typeof TIER_FEATURES)[number];

export const FEATURE_LABELS: Record<TierFeature, string> = {
  vulnerability_report: "Structured, exportable vulnerability reports",
  deep_exploit_analysis: "Realistic exploit-chain analysis",
  priority_queue: "Priority scan queue",
  private_repo_scanning: "Private repository scanning",
};

/**
 * The one function anything should use to ask "is this allowed".
 *
 * It takes a `Tier`, which only ever comes from `getUserTier` — a
 * service-role read of the `subscriptions` table. There is no overload that
 * accepts a feature flag, a plan name, or an "isPro" boolean from a
 * request: a caller with a request body in hand physically cannot use this
 * to grant themselves anything.
 */
export function hasFeature(tier: Tier, feature: TierFeature): boolean {
  return TIER_LIMITS[tier][feature] === true;
}

export function limitsFor(tier: Tier): TierLimits {
  return TIER_LIMITS[tier];
}

export function modelTierFor(tier: Tier): ModelTier {
  return TIER_LIMITS[tier].model_tier;
}

/**
 * The monthly advisor-message ceiling, or null where there isn't one.
 *
 * Read by the reservation path only. Nothing renders it: it sits behind the
 * same "unlimited messages" claim the daily cap does, so
 * `messagesCapIsVisible` applies to it unchanged.
 */
export function monthlySoftCapFor(tier: Tier): number | null {
  return TIER_LIMITS[tier].messages_monthly_soft_cap;
}

/**
 * Whether the daily message ceiling is something the user was sold, or an
 * internal fair-use backstop.
 *
 * Free's 200/day is advertised, so hitting it should say so and offer the
 * upgrade. Every paid tier is marketed as unlimited messages, so hitting
 * its ceiling must produce a generic, temporary-sounding refusal — telling
 * a paying customer they have exceeded a limit they were told did not exist
 * is worse than saying nothing useful at all.
 */
export function messagesCapIsVisible(tier: Tier): boolean {
  return tier === "free";
}

/** The next tier up, or null at the top. Drives every upgrade message. */
export function nextTier(tier: Tier): Tier | null {
  const index = TIERS.indexOf(tier);
  return index >= 0 && index < TIERS.length - 1 ? TIERS[index + 1] : null;
}

/** The cheapest tier that includes a given feature, for "upgrade to X" copy. */
export function lowestTierWith(feature: TierFeature): Tier | null {
  return TIERS.find((tier) => hasFeature(tier, feature)) ?? null;
}
