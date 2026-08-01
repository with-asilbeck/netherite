"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  BILLING_PERIODS,
  PLANS,
  formatPrice,
  monthlyEquivalent,
  yearlySavingPercent,
  type BillingPeriod,
  type PaidTier,
} from "@/lib/billing/plans";
import { FEATURE_LABELS, TIER_FEATURES, hasFeature } from "@/lib/tiers";
import {
  ACTION_LABELS,
  ACTION_TYPES,
  ACTION_WINDOWS,
  TIER_LIMITS,
  capIsVisible,
  formatCount,
} from "@/lib/usage/tiers";

/**
 * The pricing table, with the monthly/yearly toggle.
 *
 * Everything shown here is display only. Clicking a plan posts nothing but
 * `{ tier, period }` — no price, no variant id, no user id — because the
 * server resolves all three itself. Editing this component in a browser
 * therefore changes what you *see*, and nothing about what you are charged
 * or what you get.
 */
export function PricingTable({ signedIn }: { signedIn: boolean }) {
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const [pending, setPending] = useState<PaidTier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function startCheckout(tier: PaidTier) {
    if (pending) return;

    if (!signedIn) {
      // The API would 401 anyway; sending them to log in first is the
      // useful version of that. No `next` parameter: the OAuth callback
      // has a fixed post-login destination today, and threading a
      // caller-supplied return path through it is how open redirects get
      // introduced. They land in the app and can click Pricing again.
      router.push("/login");
      return;
    }

    setPending(tier);
    setError(null);

    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier, period }),
      });

      const data = (await response.json().catch(() => null)) as
        | { url?: string; error?: string }
        | null;

      if (!response.ok || !data?.url) {
        setError(data?.error ?? "We couldn't start the checkout. Please try again.");
        setPending(null);
        return;
      }

      // Full navigation, not router.push — the checkout is on Lemon
      // Squeezy's domain. `assign` rather than setting `location.href`
      // because react-hooks/immutability treats the assignment as mutating
      // a value defined outside the component.
      window.location.assign(data.url);
    } catch {
      setError("We couldn't reach the checkout. Check your connection and try again.");
      setPending(null);
    }
  }

  return (
    <div>
      <div className="flex justify-center">
        <div
          role="radiogroup"
          aria-label="Billing period"
          className="inline-flex rounded-full border border-border bg-card p-1"
        >
          {BILLING_PERIODS.map((option) => {
            const active = period === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setPeriod(option)}
                className={`rounded-full px-5 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {option === "monthly" ? "Monthly" : "Yearly"}
                {option === "yearly" && (
                  <span className={`ml-2 text-xs ${active ? "opacity-80" : "opacity-70"}`}>
                    save {yearlySavingPercent(PLANS[0])}%
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="mx-auto mt-6 max-w-md rounded-lg border border-error-border bg-error-bg px-4 py-3 text-center text-sm text-error-foreground"
        >
          {error}
        </p>
      )}

      <div className="mt-10 grid gap-6 md:grid-cols-3">
        {PLANS.map((plan) => {
          const price = plan.price[period];
          const busy = pending === plan.tier;

          return (
            <div
              key={plan.tier}
              className={`flex flex-col rounded-xl border bg-card p-6 sm:p-7 ${
                plan.highlight ? "border-border-strong" : "border-border"
              }`}
            >
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold tracking-tight">{plan.name}</h2>
                {plan.highlight && (
                  <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                    Most popular
                  </span>
                )}
              </div>

              <p className="mt-2 min-h-[42px] text-sm leading-[1.5] text-muted-foreground">
                {plan.tagline}
              </p>

              <div className="mt-5 flex items-baseline gap-1.5">
                <span className="text-[34px] font-semibold leading-none tracking-[-0.02em] tabular-nums">
                  {formatPrice(price)}
                </span>
                <span className="text-sm text-muted-foreground">
                  /{period === "monthly" ? "month" : "year"}
                </span>
              </div>

              {/* Reserved whether or not it renders, so the three cards'
                  buttons stay on one line as the toggle flips. */}
              <p className="mt-1.5 min-h-[18px] text-xs text-muted-foreground">
                {period === "yearly"
                  ? `${formatPrice(monthlyEquivalent(plan))}/month, billed annually`
                  : ""}
              </p>

              <button
                type="button"
                onClick={() => startCheckout(plan.tier)}
                disabled={busy}
                className={`mt-6 h-11 w-full rounded-lg text-sm font-medium transition-opacity disabled:opacity-60 ${
                  plan.highlight
                    ? "bg-foreground text-background hover:opacity-90"
                    : "border border-border-strong hover:bg-muted"
                }`}
              >
                {busy ? "Starting checkout…" : `Choose ${plan.name}`}
              </button>

              <ul className="mt-7 space-y-2.5 text-sm">
                {ACTION_TYPES.map((action) => {
                  // Every paid plan is sold as unlimited messages. The
                  // fair-use ceiling behind that is real and enforced, but
                  // it is not a number anybody was sold, so it is never
                  // printed here — see messagesCapIsVisible.
                  const unlimited = !capIsVisible(plan.tier, action);
                  return (
                    <li key={action} className="flex gap-2.5">
                      <Check />
                      <span>
                        {unlimited ? (
                          <>
                            <span>Unlimited</span>{" "}
                            <span className="text-muted-foreground">
                              {ACTION_LABELS[action].toLowerCase()}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="tabular-nums">
                              {formatCount(TIER_LIMITS[plan.tier][action])}
                            </span>{" "}
                            <span className="text-muted-foreground">
                              {ACTION_LABELS[action].toLowerCase()} /{" "}
                              {ACTION_WINDOWS[action] === "day" ? "day" : "month"}
                            </span>
                          </>
                        )}
                      </span>
                    </li>
                  );
                })}

                {/* Rendered from the same flags the server enforces, so this
                    list cannot promise a capability the API withholds. */}
                {TIER_FEATURES.filter((feature) => hasFeature(plan.tier, feature)).map(
                  (feature) => (
                    <li key={feature} className="flex gap-2.5">
                      <Check />
                      <span className="text-muted-foreground">{FEATURE_LABELS[feature]}</span>
                    </li>
                  ),
                )}

                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2.5">
                    <Check />
                    <span className="text-muted-foreground">{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Check() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="mt-[3px] h-3.5 w-3.5 shrink-0 text-muted-foreground"
    >
      <path
        d="M3 8.5l3.2 3.2L13 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
