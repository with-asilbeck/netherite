"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ConsentClause } from "@/lib/private-scan/consent";

/**
 * The account page's private-repository-scanning panel: the consent screen
 * and the App install entry point.
 *
 * **Rendered only for tiers that have the feature.** The server decides that
 * — app/account/page.tsx does not render this component at all for a free
 * account, so there is no client-side flag to flip. This component being
 * mounted is itself evidence the check passed; it does not re-derive it.
 *
 * The consent copy is not written here. It comes from
 * lib/private-scan/consent.ts, where each statement is recorded against the
 * vendor documentation it was checked against — see the header of that file
 * for why the terms are data rather than JSX.
 */

type ConsentState = {
  version: number;
  clauses: ConsentClause[];
  checkboxLabel: string;
  granted: boolean;
  grantedAt: string | null;
  grantedVersion: number | null;
};

const STATUS_MESSAGES: Record<string, { tone: "ok" | "warn"; text: string }> = {
  installed: { tone: "ok", text: "GitHub App installed. You can now scan your private repositories." },
  upgrade_required: {
    tone: "warn",
    text: "Scanning private repositories is available on paid plans.",
  },
  unconfigured: {
    tone: "warn",
    text: "Private repository scanning isn't configured on this server yet.",
  },
  state_mismatch: {
    tone: "warn",
    text: "That installation link didn't match this browser session. Please start again.",
  },
  approval_pending: {
    tone: "warn",
    text: "Your installation request was sent to the organization owner for approval.",
  },
  missing_installation: {
    tone: "warn",
    text: "GitHub didn't return an installation. Please try installing again.",
  },
  github_unavailable: { tone: "warn", text: "Couldn't reach GitHub. Please try again." },
  connect_github_first: {
    tone: "warn",
    text: "Connect your GitHub account first, then install the App.",
  },
  org_not_supported: {
    tone: "warn",
    text: "Organization installations aren't supported yet — install on your personal account.",
  },
  account_mismatch: {
    tone: "warn",
    text: "That installation belongs to a different GitHub account than the one connected here.",
  },
  save_failed: { tone: "warn", text: "Couldn't save the installation. Please try again." },
  rate_limited: {
    tone: "warn",
    text: "Too many installation attempts. Please wait a few minutes and try again.",
  },
};

/**
 * `consent` arrives as a prop from the server component rather than being
 * fetched on mount. Two reasons: the panel renders in its final state on the
 * first paint instead of flashing a loading line, and — the one that matters
 * — whether somebody has consented is an authorization fact, so it is read
 * with the same server-side call the scan route uses rather than assembled in
 * the browser. Mutations round-trip through the API and then `router.refresh()`
 * re-renders the server component, so the displayed state always came from
 * the database and never from optimistic local state.
 */
export function PrivateScanPanel({
  installed,
  accountLogin,
  status,
  consent,
}: {
  installed: boolean;
  accountLogin: string | null;
  status: string | null;
  consent: ConsentState;
}) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    if (!checked) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/private-scan/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accepted: true, version: consent.version }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Couldn't record your consent.");
        return;
      }
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const withdraw = async () => {
    setSaving(true);
    setError(null);
    try {
      await fetch("/api/private-scan/consent", { method: "DELETE" });
      setChecked(false);
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  // `Object.hasOwn`, not a bare index: `status` comes from the query string,
  // so `?private_scan=constructor` would otherwise resolve up the prototype
  // chain and hand this a function to destructure. Harmless as rendered
  // today, but "attacker-chosen key into an object literal" is a shape worth
  // never having.
  const banner = status && Object.hasOwn(STATUS_MESSAGES, status) ? STATUS_MESSAGES[status] : null;
  // An agreement to an older version is not consent to the current one, and
  // saying so is more useful than silently showing the form again.
  const staleConsent =
    !consent.granted &&
    consent.grantedVersion !== null &&
    consent.grantedVersion < consent.version;

  return (
    <section className="mt-10 rounded-xl border border-border bg-card p-6 sm:p-8">
      <h2 className="text-sm font-semibold text-muted-foreground">Private repository scanning</h2>

      {banner && (
        <p
          className={`mt-4 rounded-lg border px-4 py-3 text-sm ${
            banner.tone === "ok"
              ? "border-border bg-muted text-foreground"
              : "border-border-strong bg-muted text-muted-foreground"
          }`}
        >
          {banner.text}
        </p>
      )}

      {consent.granted ? (
        <>
          <p className="mt-4 text-sm leading-[1.6] text-muted-foreground">
            You agreed to the data-handling terms
            {consent.grantedAt
              ? ` on ${new Date(consent.grantedAt).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}`
              : ""}
            .
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            {installed ? (
              <>
                <span className="inline-flex h-11 items-center rounded-lg border border-border px-4 text-sm text-muted-foreground">
                  Installed{accountLogin ? ` on ${accountLogin}` : ""}
                </span>
                <a
                  href="/api/github-app/install"
                  className="inline-flex h-11 items-center rounded-lg border border-border-strong px-4 text-sm font-medium transition-colors hover:bg-muted"
                >
                  Manage repositories
                </a>
              </>
            ) : (
              <a
                href="/api/github-app/install"
                className="inline-flex h-11 items-center rounded-lg bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90"
              >
                Enable private repo scanning
              </a>
            )}
            <button
              type="button"
              onClick={() => void withdraw()}
              disabled={saving}
              className="text-sm text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground disabled:opacity-50"
            >
              Withdraw consent
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-4 text-sm leading-[1.6] text-muted-foreground">
            {staleConsent
              ? "These terms have changed since you last agreed. Please read them again."
              : "Before scanning a private repository, read where your code goes."}
          </p>

          <ul className="mt-5 space-y-3">
            {consent.clauses.map((clause) => (
              <li
                key={clause.id}
                className={`rounded-lg border px-4 py-3 text-sm leading-[1.6] ${
                  clause.emphasis
                    ? "border-border-strong bg-muted text-foreground"
                    : "border-border text-muted-foreground"
                }`}
              >
                {clause.text}
                {clause.sourceUrl && (
                  <>
                    {" "}
                    <a
                      href={clause.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-4 hover:text-foreground"
                    >
                      {clause.sourceLabel}
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>

          <label className="mt-5 flex cursor-pointer items-start gap-3 text-sm leading-[1.6]">
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 accent-foreground"
            />
            <span>{consent.checkboxLabel}</span>
          </label>

          {error && <p className="mt-4 text-sm text-muted-foreground">{error}</p>}

          <button
            type="button"
            onClick={() => void accept()}
            disabled={!checked || saving}
            className="mt-5 inline-flex h-11 items-center rounded-lg bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Saving…" : "I understand — continue"}
          </button>
        </>
      )}
    </section>
  );
}
