import Link from "next/link";

import { nextTier, TIERS, TIER_LABELS, type Tier } from "@/lib/tiers";

/**
 * The highest tier that still sees the CTA. Everything above it — `pro` and
 * `max` — gets no button at all.
 *
 * Expressed as a position in `TIERS` rather than a `tier === "pro"` check so
 * the rule stays "up to and including Basic" if a tier is ever inserted into
 * the ladder. An equality check would silently start showing the CTA to a new
 * tier slotted above Basic.
 */
const LAST_TIER_WITH_CTA: Tier = "basic";

function showsUpgradeCta(tier: Tier): boolean {
  return TIERS.indexOf(tier) <= TIERS.indexOf(LAST_TIER_WITH_CTA);
}

/**
 * The "Upgrade" call to action on the chat screen.
 *
 * Server component — the tier is resolved on the server (see
 * lib/get-user-tier.ts) and only the rendered markup reaches the browser, so
 * this never gives the client a plan value to work from.
 *
 * Renders for `free` and `basic` only. On `max` there is nothing above to sell
 * and a dead button is worse than none; on `pro` there is, but someone already
 * paying at that level is not the audience for an upsell pinned over every
 * chat screen. This is a presentation rule, not an entitlement one, so it
 * lives here rather than in lib/tiers.ts — it grants and withholds nothing.
 */
export function UpgradeButton({ tier }: { tier: Tier }) {
  const next = nextTier(tier);
  // `next` is non-null for both tiers that pass the check; the guard is kept
  // so the label below can't be indexed with null if the ceiling ever moves.
  if (!next || !showsUpgradeCta(tier)) return null;

  return (
    <Link
      href="/pricing"
      // The label names the next tier rather than saying a bare "Upgrade",
      // so the button says what it costs a click to find out.
      title={`See plans — ${TIER_LABELS[next]} and above`}
      className="inline-flex h-8 shrink-0 items-center rounded-lg bg-foreground px-3 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
    >
      {/* The full label needs ~110px, which is most of what's left on a
          320px phone once the menu button and the wordmark have taken
          theirs. Below `sm` it drops to the verb alone rather than risking
          the header row overflowing — the `title` above still carries the
          detail, and the pricing page says the rest. */}
      <span className="sm:hidden">Upgrade</span>
      <span className="hidden sm:inline">Upgrade to {TIER_LABELS[next]}</span>
    </Link>
  );
}
