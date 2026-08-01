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
      // The label is the bare verb at every width, so the tier name lives in
      // the tooltip and on the pricing page instead. That also drops the
      // responsive two-span label this used to need to fit a 320px header.
      title={`See plans — ${TIER_LABELS[next]} and above`}
      // `cta-glow` (app/globals.css) supplies the warm accent halo and its
      // pulse; the pill radius keeps the edges soft under it.
      className="cta-glow inline-flex h-8 shrink-0 items-center rounded-full bg-foreground px-4 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
    >
      Upgrade
    </Link>
  );
}
