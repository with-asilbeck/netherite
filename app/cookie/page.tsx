import type { Metadata } from "next";
import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";

import { inter } from "@/lib/fonts";

/**
 * PLACEHOLDERS — confirm both before this page is treated as published legal
 * text. Nothing in the codebase defines a support address today (only
 * `NEXT_PUBLIC_SITE_URL` exists in the env), so the contact line is left
 * deliberately unfilled rather than invented.
 */
const EFFECTIVE_DATE = "[INSERT DATE — drafted 08.03.2026]";
const CONTACT_EMAIL = "[INSERT CONTACT EMAIL]";

export const metadata: Metadata = {
  title: "Cookie Policy — Netherite",
  description:
    "How Netherite uses cookies and similar technologies, which ones are strictly necessary, and how to control them.",
};

type CookieCategory = {
  category: string;
  purpose: string;
  /** `null` renders the italic "Not currently in use" cell. */
  examples: string | null;
  consent: string;
};

const cookieCategories: CookieCategory[] = [
  {
    category: "Strictly Necessary",
    purpose:
      "Required for core site functionality, security, and to keep you logged in. The site cannot function properly without these.",
    examples:
      "Supabase authentication/session cookies (Google & GitHub OAuth login, session persistence)",
    consent: "No — these are exempt under applicable law",
  },
  {
    category: "Functional",
    purpose: "Remember your preferences to improve your experience.",
    examples: "Theme preference (light/dark/system mode)",
    consent:
      "Typically no consent banner required, but you may disable via browser settings",
  },
  {
    category: "Analytics / Performance",
    purpose:
      "Help us understand how users interact with our service so we can improve it.",
    examples: null,
    consent: "Would require consent if added",
  },
  {
    category: "Advertising / Marketing",
    purpose: "Used to deliver or measure targeted advertising.",
    examples: null,
    consent: "Would require consent if added",
  },
];

const browserGuides = [
  { label: "Chrome", href: "https://support.google.com/chrome/answer/95647" },
  {
    label: "Firefox",
    href: "https://support.mozilla.org/en-US/kb/enhanced-tracking-protection-firefox-desktop",
  },
  { label: "Safari", href: "https://support.apple.com/en-us/HT201265" },
  { label: "Edge", href: "https://support.microsoft.com/en-us/microsoft-edge" },
];

/** Numbered rule between sections, matching the border-led rhythm elsewhere. */
function Section({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-border pt-10">
      <h2 className="m-0 flex items-baseline gap-3 text-xl font-semibold tracking-[-0.01em] sm:text-2xl">
        <span
          aria-hidden
          className="shrink-0 font-mono text-base text-muted-foreground"
        >
          {number}
        </span>
        <span>{title}</span>
      </h2>
      <div className="mt-5 flex flex-col gap-4 text-base leading-[1.7] text-muted-foreground">
        {children}
      </div>
    </section>
  );
}

function Bullets({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5">{children}</ul>;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-4 transition-colors hover:text-foreground"
    >
      {children}
    </a>
  );
}

export default function CookiePolicyPage() {
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
          href="/"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Back home
        </Link>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-14 sm:px-8 md:py-20">
        <div className="mb-4 text-sm font-medium text-muted-foreground">Legal</div>
        <h1 className="m-0 text-[clamp(30px,4.5vw,46px)] font-semibold leading-[1.1] tracking-[-0.02em]">
          Cookie Policy
        </h1>
        <p className="mt-5 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Effective date:</span>{" "}
          {EFFECTIVE_DATE}
        </p>
        <p className="mt-6 text-lg leading-[1.6] text-muted-foreground">
          This Cookie Policy explains how Netherite (&ldquo;we,&rdquo; &ldquo;us,&rdquo;
          or &ldquo;our&rdquo;), available at netherite.uz, uses cookies and similar
          tracking technologies when you visit our website or use our services.
        </p>

        <div className="mt-14 flex flex-col gap-10">
          <Section number="01" title="What are cookies?">
            <p>
              Cookies are small text files placed on your device by a website you
              visit. They are widely used to make websites function, work more
              efficiently, and to provide information to the site owners. This
              policy also covers similar technologies such as local storage, which
              we use in the same way as cookies for the purposes described below.
            </p>
          </Section>

          <Section number="02" title="Cookies we use">
            <p>
              We aim to use as few cookies as possible. The table below reflects
              the categories currently in use on Netherite.
            </p>

            {/* Scrolls inside itself rather than pushing the page sideways on a
                narrow screen. */}
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                <caption className="sr-only">
                  Categories of cookies used on Netherite, their purpose, examples,
                  and whether consent is required.
                </caption>
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th scope="col" className="px-4 py-3 font-medium">
                      Category
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Purpose
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Examples on Netherite
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Consent required?
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cookieCategories.map((row) => (
                    <tr
                      key={row.category}
                      className="border-b border-border align-top last:border-0"
                    >
                      <th
                        scope="row"
                        className="px-4 py-3 text-left font-semibold text-foreground"
                      >
                        {row.category}
                      </th>
                      <td className="px-4 py-3">{row.purpose}</td>
                      <td className="px-4 py-3">
                        {row.examples ?? (
                          <em className="italic">Not currently in use</em>
                        )}
                      </td>
                      <td className="px-4 py-3">{row.consent}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p>
              We do not currently use any advertising, retargeting, or third-party
              analytics cookies. If this changes, we will update this policy and,
              where required, request your consent before such cookies are set.
            </p>
          </Section>

          <Section number="03" title="Why we use necessary cookies">
            <Bullets>
              <li className="pl-1">
                <span className="font-medium text-foreground">Authentication:</span>{" "}
                To keep you securely signed in to your account via Google or GitHub
                OAuth, and to maintain your session as you navigate the site.
              </li>
              <li className="pl-1">
                <span className="font-medium text-foreground">Security:</span> To
                help protect your account and prevent unauthorized access.
              </li>
            </Bullets>
            <p>
              Because these cookies are essential to the operation of the service,
              they cannot be switched off in our systems. You can block or delete
              them via your browser settings, but doing so may prevent you from
              logging in or using core features.
            </p>
          </Section>

          <Section number="04" title="Why we use functional cookies and storage">
            <Bullets>
              <li className="pl-1">
                <span className="font-medium text-foreground">
                  Theme preference:
                </span>{" "}
                To remember whether you&rsquo;ve selected light mode, dark mode, or
                system default, so you don&rsquo;t have to reselect it on each
                visit.
              </li>
            </Bullets>
          </Section>

          <Section number="05" title="Third-party cookies">
            <p>
              Some cookies may be set by third-party services we rely on to operate
              Netherite, including:
            </p>
            <Bullets>
              <li className="pl-1">
                <span className="font-medium text-foreground">Supabase</span> —
                authentication and session management
              </li>
              <li className="pl-1">
                <span className="font-medium text-foreground">Google</span> — OAuth
                sign-in
              </li>
              <li className="pl-1">
                <span className="font-medium text-foreground">GitHub</span> — OAuth
                sign-in and repository connection
              </li>
            </Bullets>
            <p>
              These providers may set their own cookies subject to their own privacy
              and cookie policies. We do not control these cookies directly.
            </p>
          </Section>

          <Section number="06" title="How to control cookies">
            <p>Most browsers let you:</p>
            <Bullets>
              <li className="pl-1">
                View what cookies are stored and delete them individually
              </li>
              <li className="pl-1">Block third-party cookies</li>
              <li className="pl-1">Block cookies from specific or all sites</li>
              <li className="pl-1">Delete all cookies when you close your browser</li>
            </Bullets>
            <p>
              Please note that blocking strictly necessary cookies (such as
              authentication cookies) will likely prevent you from logging in or
              using Netherite as intended.
            </p>
            <p>You can manage cookie settings through your browser:</p>
            <Bullets>
              {browserGuides.map(({ label, href }) => (
                <li key={label} className="pl-1">
                  <ExternalLink href={href}>{label}</ExternalLink>
                </li>
              ))}
            </Bullets>
          </Section>

          <Section number="07" title="Changes to this Cookie Policy">
            <p>
              We may update this Cookie Policy from time to time, particularly if we
              add analytics, advertising, or other tracking technologies. Any changes
              will be posted on this page with an updated effective date.
            </p>
          </Section>

          <Section number="08" title="Contact us">
            <p>
              If you have questions about this Cookie Policy, please contact us at{" "}
              <span className="font-medium text-foreground">{CONTACT_EMAIL}</span>.
            </p>
          </Section>
        </div>
      </main>

      <footer className="border-t border-border px-6 py-8 text-xs text-muted-foreground sm:px-14">
        © 2026 NETHERITE
      </footer>
    </div>
  );
}
