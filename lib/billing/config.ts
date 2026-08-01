import {
  BILLING_PERIODS,
  PAID_TIERS,
  type BillingPeriod,
  type PaidTier,
} from "./plans";

// Server-only billing configuration: the API key, the store, and the
// variant↔plan mapping.
//
// The guard below is the same one lib/supabase/admin.ts uses, for the same
// reason. None of these vars are `NEXT_PUBLIC_`-prefixed, so Next would
// inline them as `undefined` in a client bundle rather than leaking them —
// this turns that silent `undefined` into a loud throw at module scope, so
// a bad import is found immediately instead of as a mystery config error.
// (The `server-only` package would be the other way to do this; it isn't a
// dependency of this project.)
if (typeof window !== "undefined") {
  throw new Error(
    "lib/billing/config.ts was imported in the browser. It reads the Lemon Squeezy API key and must stay server-side. Import lib/billing/plans.ts instead — it holds everything the UI needs.",
  );
}

/**
 * The env var is expected to be a bare numeric store id, but a store id is
 * also the last path segment of the store's admin URL, and pasting the URL
 * is an easy mistake to make — `LEMONSQUEEZY_STORE_ID` is in fact currently
 * set to `https://netherite.lemonsqueezy.com/443272`. Accepting both costs
 * one regex and turns a 404 from the checkout API into a non-event.
 *
 * Anything that isn't a bare id or a URL ending in one throws, rather than
 * being silently coerced to a wrong-but-plausible number.
 */
export function normalizeStoreId(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;

  const fromPath = trimmed.match(/(\d+)\/?$/);
  if (fromPath) return fromPath[1];

  throw new Error(
    `LEMONSQUEEZY_STORE_ID is "${raw}", which contains no store id. Expected a number like 443272.`,
  );
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is not set — Lemon Squeezy billing is not configured.`);
  }
  return value.trim();
}

export function apiKey(): string {
  return required("LEMONSQUEEZY_API_KEY");
}

export function storeId(): string {
  return normalizeStoreId(required("LEMONSQUEEZY_STORE_ID"));
}

export function webhookSecret(): string {
  return required("LEMONSQUEEZY_WEBHOOK_SECRET");
}

/** `LEMONSQUEEZY_VARIANT_PRO_YEARLY` for ("pro", "yearly"). */
function variantEnvName(tier: PaidTier, period: BillingPeriod): string {
  return `LEMONSQUEEZY_VARIANT_${tier.toUpperCase()}_${period.toUpperCase()}`;
}

export function variantIdFor(tier: PaidTier, period: BillingPeriod): string {
  const name = variantEnvName(tier, period);
  const value = required(name);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} is "${value}", which is not a Lemon Squeezy variant id.`);
  }
  return value;
}

export type PlanIdentity = { tier: PaidTier; period: BillingPeriod };

/**
 * The reverse mapping, variant id → plan. This is the only thing that
 * decides what a purchase entitles somebody to: the webhook reads the
 * variant id out of the (signature-verified) event and looks it up here,
 * rather than trusting any tier name that might travel in custom data.
 *
 * Built per call instead of at module scope so a missing env var surfaces
 * as a request-time error with a name in it, not as a blank page at boot.
 */
export function variantPlanMap(): Map<string, PlanIdentity> {
  const map = new Map<string, PlanIdentity>();
  for (const tier of PAID_TIERS) {
    for (const period of BILLING_PERIODS) {
      const id = variantIdFor(tier, period);
      const existing = map.get(id);
      if (existing) {
        // Two tiers sharing a variant id would mean a Basic purchase could
        // grant Max. Refuse to run rather than resolve it arbitrarily.
        throw new Error(
          `Variant id ${id} is configured for both ${existing.tier}/${existing.period} and ${tier}/${period}.`,
        );
      }
      map.set(id, { tier, period });
    }
  }
  return map;
}

export function planForVariant(variantId: string | number): PlanIdentity | null {
  return variantPlanMap().get(String(variantId)) ?? null;
}

/** True when every var billing needs is present, used to hide UI that can't work. */
export function billingConfigured(): boolean {
  try {
    apiKey();
    storeId();
    webhookSecret();
    variantPlanMap();
    return true;
  } catch {
    return false;
  }
}
