import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";

import { formatDate, statusDescription } from "@/lib/billing/entitlement";
import { customerPortalUrl } from "@/lib/billing/lemonsqueezy";
import { formatPrice } from "@/lib/billing/plans";
import { getOwnBilling } from "@/lib/billing/queries";
import { inter } from "@/lib/fonts";
import { createClient } from "@/lib/supabase/server";
import { TIER_LABELS } from "@/lib/usage/tiers";

export const metadata: Metadata = {
  title: "Account — Netherite",
  description: "Your plan, billing, and payment history.",
};

// The customer portal URL is signed and expires after 24 hours, so this
// page must never be served from a cache.
export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Belt to the proxy's braces — an auth check in the page itself, not only
  // in middleware, per CLAUDE.md.
  if (!user) redirect("/login");

  const billing = await getOwnBilling();
  if (!billing) redirect("/login");

  const { tier, cancellingSoon, subscription, payments } = billing;
  const status = statusDescription(subscription);

  // Fetched per request, never stored — see customerPortalUrl.
  const portalUrl = subscription?.lemonsqueezy_subscription_id
    ? await customerPortalUrl(subscription.lemonsqueezy_subscription_id)
    : null;

  return (
    <div
      className={`${inter.variable} flex min-h-screen w-full flex-col bg-background font-sans text-foreground`}
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
          <span className="text-lg font-semibold tracking-tight">NETHERITE</span>
        </Link>
        <Link
          href="/chat"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Back to chat
        </Link>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10 sm:px-8 md:py-16">
        <h1 className="m-0 text-[clamp(28px,4vw,44px)] font-semibold leading-[1.1] tracking-[-0.02em]">
          Account
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">{user.email}</p>

        <section className="mt-10 rounded-xl border border-border bg-card p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground">Current plan</h2>
              <p className="mt-1 flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
                {TIER_LABELS[tier]}
                {/* Display only. `tier` above already reflects the access
                    this account actually has — see the note on
                    cancellingSoon in lib/get-user-tier.ts. */}
                {cancellingSoon && (
                  <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                    Cancelling
                  </span>
                )}
              </p>
              {subscription?.billing_period && tier !== "free" && (
                <p className="mt-1 text-sm text-muted-foreground">
                  Billed {subscription.billing_period === "monthly" ? "monthly" : "yearly"}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-3">
              {portalUrl && (
                <a
                  href={portalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-11 items-center rounded-lg border border-border-strong px-4 text-sm font-medium transition-colors hover:bg-muted"
                >
                  Manage billing
                </a>
              )}
              <Link
                href="/pricing"
                className="inline-flex h-11 items-center rounded-lg bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90"
              >
                {tier === "free" ? "Choose a plan" : "Change plan"}
              </Link>
            </div>
          </div>

          {status && <p className="mt-5 text-sm leading-[1.6] text-muted-foreground">{status}</p>}

          {subscription?.lemonsqueezy_subscription_id && !portalUrl && (
            <p className="mt-5 rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
              The billing portal isn&apos;t reachable right now. Please try again shortly.
            </p>
          )}

          <p className="mt-5 text-sm text-muted-foreground">
            <Link href="/usage" className="underline underline-offset-4 hover:text-foreground">
              See what you&apos;ve used this month
            </Link>
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-sm font-semibold">Billing history</h2>

          {payments.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No payments yet.</p>
          ) : (
            // Scrolls inside itself rather than pushing the page sideways
            // on a narrow screen.
            <div className="mt-4 overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[420px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Date</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((payment) => (
                    <tr key={payment.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3">{formatDate(payment.paid_at)}</td>
                      <td className="px-4 py-3">
                        {payment.refunded ? (
                          <span className="text-muted-foreground">Refunded</span>
                        ) : (
                          "Paid"
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <span className={payment.refunded ? "line-through opacity-60" : undefined}>
                          {formatPrice(payment.amount, payment.currency)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      <footer className="border-t border-border px-6 py-8 text-xs text-muted-foreground sm:px-14">
        © 2026 NETHERITE
      </footer>
    </div>
  );
}
