// Plan catalogue — the display half of billing. Deliberately free of any
// `process.env` access so it can be imported by client components (the
// pricing table is interactive) without dragging a secret into the bundle.
// Everything that needs an API key or a variant id lives in ./config.ts,
// which is server-only.
//
// Prices here are for *display*. The amount actually charged is whatever
// the Lemon Squeezy variant says; these strings are checked against the
// live variants by scripts/billing-verify-variants.mjs so the two cannot
// drift silently.

import { TIER_LIMITS, type Tier } from "@/lib/usage/tiers";

export const PAID_TIERS = ["basic", "pro", "max"] as const;
export type PaidTier = (typeof PAID_TIERS)[number];

export const BILLING_PERIODS = ["monthly", "yearly"] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export function isPaidTier(value: unknown): value is PaidTier {
  return typeof value === "string" && (PAID_TIERS as readonly string[]).includes(value);
}

export function isBillingPeriod(value: unknown): value is BillingPeriod {
  return typeof value === "string" && (BILLING_PERIODS as readonly string[]).includes(value);
}

export type Plan = {
  tier: PaidTier;
  name: string;
  tagline: string;
  /** Cents, matching the Lemon Squeezy variant price. */
  price: Record<BillingPeriod, number>;
  /** Extra selling points beyond the usage caps, which are rendered from TIER_LIMITS. */
  features: string[];
  highlight?: boolean;
};

// The `features` strings are marketing copy, but the gated ones are not
// invented here — they are rendered from TIER_FEATURES in lib/tiers.ts by
// the pricing table, which is what stops the page promising a capability
// the enforcement code doesn't grant. Only claims with no flag behind them
// (support channels, and so on) are free text.
export const PLANS: Plan[] = [
  {
    tier: "basic",
    name: "Basic",
    tagline: "For one developer keeping a side project honest.",
    price: { monthly: 999, yearly: 9900 },
    features: ["Unlimited advisor messages", "Findings with ready-to-use fixes", "Email support"],
  },
  {
    tier: "pro",
    name: "Pro",
    tagline: "For a team shipping to real users every week.",
    price: { monthly: 3500, yearly: 35000 },
    features: ["Everything in Basic"],
    highlight: true,
  },
  {
    tier: "max",
    name: "Max",
    tagline: "For continuous scanning across a whole codebase.",
    price: { monthly: 12900, yearly: 129000 },
    features: ["Everything in Pro", "Strongest model on every scan stage", "Direct support channel"],
  },
];

export function planFor(tier: PaidTier): Plan {
  const plan = PLANS.find((p) => p.tier === tier);
  if (!plan) throw new Error(`No plan defined for tier "${tier}"`);
  return plan;
}

/**
 * Whole dollars where the price is whole, cents where it isn't — "$9.99"
 * and "$100", never "$100.00". Pinned locale for the same reason
 * lib/usage/tiers.ts pins it: the server's ICU default is not the reader's.
 *
 * `currency` is validated rather than passed straight through:
 * `Intl.NumberFormat` throws a `RangeError` on anything that isn't a
 * well-formed ISO 4217 code, and this renders a value that originated in a
 * webhook payload. One malformed row would otherwise take out the whole
 * billing page for that user — a server component throwing is a 500, not a
 * blank cell. Normalising at the boundary (lib/billing/events.ts) should
 * already prevent it; this is the second half of the same guard, so a row
 * written by hand can't reintroduce it.
 */
export function formatPrice(cents: number, currency = "USD"): string {
  const code = /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : "USD";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/** What a yearly plan works out to per month, for the "billed annually" line. */
export function monthlyEquivalent(plan: Plan): number {
  return Math.round(plan.price.yearly / 12);
}

/** Percentage saved by paying yearly, rounded down so the claim is never overstated. */
export function yearlySavingPercent(plan: Plan): number {
  const yearOfMonthly = plan.price.monthly * 12;
  return Math.floor(((yearOfMonthly - plan.price.yearly) / yearOfMonthly) * 100);
}

/** The usage caps a plan buys, read from the same table enforcement reads. */
export function capsFor(tier: Tier) {
  return TIER_LIMITS[tier];
}
