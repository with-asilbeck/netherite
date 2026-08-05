import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { UsageMeter } from "@/components/usage-meter";
import { ACTION_LABELS, TIER_LABELS, nextTier } from "@/lib/usage/tiers";
import { formatMonth, getOwnUsage } from "@/lib/usage/queries";

export const metadata: Metadata = {
  title: "Usage — Netherite",
  description: "Your Netherite usage and plan limits for this month.",
};

export default async function UsagePage() {
  const usage = await getOwnUsage();

  // The proxy already gates this path, so this is the belt to its braces —
  // an auth check in the page itself, not only in middleware, per CLAUDE.md.
  if (!usage) redirect("/login");

  const upgrade = nextTier(usage.tier);

  // Only caps the user can actually see count toward the upgrade nudge. The
  // fair-use message ceiling is invisible by design, so hitting it must not
  // put a "you've hit a limit" banner on a page that says Unlimited two
  // inches above it.
  const anyExhausted = usage.actions.some((a) => a.visible && a.used >= a.limit);

  return (
    <div
      className="flex min-h-screen w-full flex-col bg-background font-sans text-foreground"
    >
      <header className="flex items-center justify-between border-b border-border px-6 py-7 sm:px-14">
        <Link href="/" className="flex items-center gap-3">
          <Image
            src="/netherite-mark.png"
            alt="Netherite"
            width={34}
            height={34}
            className="h-[34px] w-[34px] object-contain dark:invert"
          />
          <span className="text-[34px] leading-none translate-y-[0.11em] font-brand">NETHERITE</span>
        </Link>
        <Link
          href="/chat"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Back to chat
        </Link>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10 sm:px-8 md:py-16">
        <div className="mb-4 text-sm font-medium text-muted-foreground">
          {formatMonth(usage.monthStart)}
        </div>
        <h1 className="m-0 text-[clamp(28px,4vw,44px)] font-semibold leading-[1.1] tracking-[-0.02em]">
          Your usage
        </h1>
        <p className="mt-4 max-w-[560px] text-base leading-[1.6] text-muted-foreground">
          You&apos;re on the{" "}
          <span className="font-medium text-foreground">{TIER_LABELS[usage.tier]}</span> plan.
          Scan and snippet allowances reset at the start of each month (UTC).
        </p>

        <section className="mt-10 space-y-7 rounded-xl border border-border bg-card p-6 sm:p-8">
          {usage.actions.map((action) => (
            <UsageMeter
              key={action.action}
              label={ACTION_LABELS[action.action]}
              used={action.used}
              limit={action.limit}
              period={action.window === "day" ? "per day" : "per month"}
              // `visible` is resolved server-side in lib/usage/queries.ts
              // from the tier. UsageMeter is a server component, so when
              // this is false the ceiling is never rendered and never
              // crosses into the browser — it isn't merely hidden with CSS.
              unlimited={!action.visible}
            />
          ))}
        </section>

        {anyExhausted && upgrade && (
          <p className="mt-6 rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
            You&apos;ve hit a limit on the {TIER_LABELS[usage.tier]} plan. Upgrading to{" "}
            <span className="font-medium text-foreground">{TIER_LABELS[upgrade]}</span> raises every
            allowance above.
          </p>
        )}

        <section className="mt-10">
          <h2 className="text-sm font-semibold">This month&apos;s cost</h2>
          <p className="mt-2 text-sm leading-[1.6] text-muted-foreground">
            What your activity actually cost to serve, as reported by the model provider —
            not an estimate.
          </p>

          {/* Scrolls inside itself rather than pushing the page sideways on
              a narrow screen. */}
          <div className="mt-4 overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[420px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Action</th>
                  <th className="px-4 py-3 text-right font-medium">Used</th>
                  <th className="px-4 py-3 text-right font-medium">Tokens</th>
                  <th className="px-4 py-3 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.actions.map((action) => (
                  <tr key={action.action} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">{ACTION_LABELS[action.action]}</td>
                    {/* Month-to-date, not the cap window — this table is
                        about what the month cost, and messages are now
                        capped per day. */}
                    <td className="px-4 py-3 text-right tabular-nums">
                      {action.monthCount.toLocaleString("en-US")}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {action.tokensUsed.toLocaleString("en-US")}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {formatUsd(action.costUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-medium">
                  <td className="px-4 py-3" colSpan={3}>
                    Total
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatUsd(usage.totalCostUsd)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      </main>

      <footer className="border-t border-border px-6 py-8 text-xs text-muted-foreground sm:px-14">
        © 2026 <span className="inline-block translate-y-[0.22em] text-[1.6em] leading-none font-brand">NETHERITE</span>
      </footer>
    </div>
  );
}

function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  // Sub-cent amounts are normal here — a triage call costs a fraction of a
  // cent, and rounding them all to $0.00 would make the column useless.
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}
