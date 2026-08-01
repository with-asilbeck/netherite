import Link from "next/link";

import { nextTier, TIER_LABELS, type Tier } from "@/lib/tiers";

/**
 * The "Upgrade" call to action in the chat header.
 *
 * Server component — the tier is resolved on the server (see
 * lib/get-user-tier.ts) and only the rendered markup reaches the browser, so
 * this never gives the client a plan value to work from.
 *
 * Renders nothing on `max`: there is nothing above it, and a dead upgrade
 * button on the most expensive plan is worse than no button.
 */
export function UpgradeButton({ tier }: { tier: Tier }) {
  const next = nextTier(tier);
  if (!next) return null;

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
