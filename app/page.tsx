import Image from "next/image";
import Link from "next/link";
import type { CSSProperties } from "react";

import { ChatEntryLink } from "@/components/chat-entry-link";
import { LiveFeed } from "@/components/landing/live-feed";
import { ParticleField } from "@/components/landing/particle-field";
import { Reveal } from "@/components/landing/reveal";
import { ThemeSwitcher } from "@/components/landing/theme-switcher";
import { PLANS, formatPrice, type PaidTier } from "@/lib/billing/plans";
import { jetbrainsMono, spaceGrotesk } from "@/lib/fonts";
import { FEATURE_LABELS, TIER_FEATURES, TIERS, hasFeature } from "@/lib/tiers";
import { TIER_LIMITS, formatCount } from "@/lib/usage/tiers";

type IconVariant = "square" | "diamond" | "ring" | "hex";

const features: { title: string; body: string; icon: IconVariant }[] = [
  {
    title: "Full-Repo Context",
    body: "No snippets, no sampling — Netherite reads across your whole codebase, not one file at a time.",
    icon: "square",
  },
  {
    title: "Exploit Reasoning",
    body: "Findings come with the attack chain spelled out, not just a rule name and a line number.",
    icon: "diamond",
  },
  {
    title: "Fixes, Not Tickets",
    body: "Every finding ships with a concrete patch you can apply, so triage doesn't become a backlog.",
    icon: "ring",
  },
  {
    title: "Rescan On Demand",
    body: "Re-run a scan after any commit and see what moved — drift is caught in minutes, not sprints.",
    icon: "hex",
  },
  {
    title: "Built For Vibe-Coded Apps",
    body: "Tuned for the failure modes AI-generated code actually ships: missing authz, leaked keys, raw SQL.",
    icon: "square",
  },
  {
    title: "An Advisor That Answers",
    body: "Ask about an endpoint, paste a snippet, or query an open finding — in plain language.",
    icon: "diamond",
  },
];

const navLinks = [
  { label: "Product", href: "#features" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
];

const footerColumns: {
  heading: string;
  links: { label: string; href: string }[];
}[] = [
  {
    heading: "PRODUCT",
    links: [
      { label: "Features", href: "#features" },
      { label: "Pricing", href: "/pricing" },
    ],
  },
  {
    heading: "COMPANY",
    links: [
      { label: "About", href: "/about" },
      { label: "Log in", href: "/login" },
    ],
  },
  {
    heading: "RESOURCES",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "Getting started", href: "/docs/getting-started" },
    ],
  },
  {
    heading: "LEGAL",
    links: [
      { label: "Privacy Policy", href: "/policy" },
      { label: "Cookie Policy", href: "/cookie" },
    ],
  },
];

/**
 * The cap lines a plan buys, read from the same table the API enforces, so
 * the landing page cannot advertise a number the scanner won't honour.
 */
function capLines(tier: (typeof TIERS)[number]): string[] {
  return [
    `${formatCount(TIER_LIMITS[tier].repo_scan)} repository scans / month`,
    `${formatCount(TIER_LIMITS[tier].snippet)} snippet analyses / month`,
  ];
}

/** Gated capabilities this tier adds over the one below it. */
function newCapabilities(tier: PaidTier): string[] {
  const previous = TIERS[TIERS.indexOf(tier) - 1];
  return TIER_FEATURES.filter(
    (feature) => hasFeature(tier, feature) && !hasFeature(previous, feature),
  ).map((feature) => FEATURE_LABELS[feature]);
}

type PricingCard = {
  name: string;
  price: string;
  period: string;
  tagline: string;
  highlights: string[];
  cta: string;
  /** `null` routes through <ChatEntryLink>, which owns the auth-aware entry. */
  href: string | null;
  highlight: boolean;
};

// Four cards, driven by the real catalogue rather than by copy: the prices
// are the display strings billing already checks against the live Lemon
// Squeezy variants, and the bullets come out of lib/tiers.ts.
const pricingCards: PricingCard[] = [
  {
    name: "Free",
    price: "$0",
    period: "",
    tagline: "For a first look at what's hiding in your repo.",
    highlights: [
      ...capLines("free"),
      `${formatCount(TIER_LIMITS.free.chat)} advisor messages / day`,
    ],
    cta: "Start free",
    href: null,
    highlight: false,
  },
  ...PLANS.map(
    (plan): PricingCard => ({
      name: plan.name,
      price: formatPrice(plan.price.monthly),
      period: "/ mo",
      tagline: plan.tagline,
      highlights: [
        ...capLines(plan.tier),
        ...newCapabilities(plan.tier),
        ...plan.features,
      ].slice(0, 4),
      cta: `Choose ${plan.name}`,
      href: "/pricing",
      highlight: plan.highlight === true,
    }),
  ),
];

function FeatureIcon({ variant }: { variant: IconVariant }) {
  const shapes: Record<IconVariant, CSSProperties> = {
    square: {
      borderRadius: 8,
      background: "var(--nether-glow-tile)",
      border: "1px solid var(--nether-glow-edge-strong)",
    },
    diamond: {
      background:
        "linear-gradient(135deg, var(--nether-glow), var(--nether-violet))",
      clipPath: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
    },
    ring: {
      borderRadius: "50%",
      border: "2px solid var(--nether-glow)",
    },
    hex: {
      background:
        "linear-gradient(135deg, var(--nether-violet), var(--nether-glow))",
      clipPath:
        "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
    },
  };

  return (
    <div aria-hidden="true" className="h-[38px] w-[38px]" style={shapes[variant]} />
  );
}

function Wordmark({ size }: { size: number }) {
  return (
    <Image
      src="/netherite-mark.png"
      alt="Netherite"
      width={size}
      height={size}
      /* The mark is dark artwork on transparent: it stands on its own over
         the light theme's cream, and is inverted to white for the dark one. */
      className="object-contain dark:invert"
      style={{ width: size, height: size }}
    />
  );
}

export default function Home() {
  return (
    <div
      className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} nether-surface relative min-h-screen w-full overflow-x-hidden bg-nether-void font-display text-nether-fg`}
    >
      <ParticleField />

      {/* Three tracks: the outer two share the leftover width equally
          (flex-1 basis-0), which is what keeps the section links centred on
          the viewport rather than on the gap between the two end blocks. */}
      <nav className="sticky top-0 z-50 flex items-center gap-4 border-b border-nether-line bg-nether-scrim px-6 py-4 backdrop-blur-xl sm:px-12">
        <div className="flex flex-1 basis-0 items-center gap-2.5">
          <Wordmark size={34} />
          <span className="font-code text-[15px] font-semibold tracking-[0.12em]">
            NETHERITE
          </span>
        </div>

        <div className="hidden items-center gap-6 font-code text-[13px] text-nether-muted md:flex lg:gap-9">
          {navLinks.map(({ label, href }) => (
            <Link
              key={label}
              href={href}
              className="transition-colors hover:text-nether-fg"
            >
              {label}
            </Link>
          ))}
        </div>

        <div className="flex flex-1 basis-0 items-center justify-end gap-4 font-code text-[13px] text-nether-muted lg:gap-6">
          {/* Hidden on the narrowest screens, where the row is already just
              wordmark + CTA. Nothing is lost there: with no choice stored,
              the page follows the device's own light/dark setting. */}
          <div className="hidden sm:block">
            <ThemeSwitcher />
          </div>
          <Link
            href="/login"
            className="hidden transition-colors hover:text-nether-fg md:block"
          >
            Log in
          </Link>
          <ChatEntryLink className="rounded-lg border border-nether-glow-edge bg-nether-glow-wash px-[18px] py-2.5 whitespace-nowrap text-nether-glow-soft transition-colors hover:bg-nether-glow-wash-strong">
            Try Netherite
          </ChatEntryLink>
        </div>
      </nav>

      <section
        id="hero"
        className="relative z-[2] mx-auto flex max-w-[1200px] flex-col items-center px-6 pt-24 pb-28 text-center sm:px-12 sm:pt-[120px] sm:pb-[140px]"
      >
        <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-nether-line bg-nether-surface px-4 py-1.5 font-code text-xs tracking-[0.1em] whitespace-nowrap text-nether-glow">
          <span className="nether-pulse h-1.5 w-1.5 rounded-full bg-nether-glow" />
          AI SECURITY SPECIALIST
        </div>

        <h1 className="max-w-[880px] text-[clamp(42px,8vw,76px)] leading-[1.03] font-bold tracking-[-0.03em]">
          Break in
          <br />
          before they do.
        </h1>

        <p className="mt-7 max-w-[560px] text-[17px] leading-[1.6] text-nether-dim sm:text-[19px]">
          Netherite reads your codebase like an attacker, shows you how each
          flaw would actually be exploited, and hands you the fix.
        </p>

        <div className="mt-10 flex flex-wrap justify-center gap-4">
          <ChatEntryLink className="rounded-[10px] bg-nether-glow px-7 py-3.5 text-[15px] font-semibold text-nether-on-glow transition-opacity hover:opacity-90">
            Try Netherite
          </ChatEntryLink>
          <Link
            href="/docs"
            className="rounded-[10px] border border-nether-line-strong px-7 py-3.5 text-[15px] font-medium text-nether-fg-soft transition-colors hover:border-nether-line-loud"
          >
            View the docs
          </Link>
        </div>
      </section>

      <Reveal
        id="features"
        className="relative z-[2] mx-auto max-w-[1200px] scroll-mt-24 px-6 pt-8 pb-28 sm:px-12 sm:pb-[140px]"
      >
        <div className="mb-12 text-center sm:mb-16">
          <div className="mb-3.5 font-code text-xs tracking-[0.15em] text-nether-violet">
            CAPABILITIES
          </div>
          <h2 className="text-[clamp(30px,5vw,42px)] font-semibold tracking-[-0.02em]">
            Built to think like an attacker.
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-[22px] sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-[18px] border border-nether-line bg-nether-surface px-6.5 py-7.5 backdrop-blur-md transition-colors hover:border-nether-line-strong hover:bg-nether-surface-hover"
            >
              <FeatureIcon variant={feature.icon} />
              <h3 className="mt-5 mb-2 text-[17px] font-semibold">
                {feature.title}
              </h3>
              <p className="text-sm leading-[1.6] text-nether-dim">
                {feature.body}
              </p>
            </div>
          ))}
        </div>
      </Reveal>

      <Reveal
        id="live"
        className="relative z-[2] mx-auto grid max-w-[1200px] grid-cols-1 items-center gap-12 px-6 pb-28 sm:px-12 sm:pb-[140px] lg:grid-cols-[1fr_1.3fr] lg:gap-14"
      >
        <div>
          <div className="mb-3.5 font-code text-xs tracking-[0.15em] text-nether-glow">
            LIVE DETECTION
          </div>
          <h2 className="mb-5 text-[clamp(28px,4.5vw,38px)] font-semibold tracking-[-0.02em]">
            Watch it hunt.
          </h2>
          <p className="mb-9 max-w-[420px] text-[15.5px] leading-[1.7] text-nether-dim">
            A simulated feed from Netherite&apos;s detection engine — every
            finding is triaged, ranked by exploitability, and routed straight to
            a fix.
          </p>
          <div className="flex flex-wrap gap-9">
            <div>
              <div className="font-code text-[28px] font-semibold text-nether-fg-soft">
                {formatCount(TIER_LIMITS.max.repo_scan)}
              </div>
              <div className="mt-1 text-[12.5px] text-nether-faint">
                repository scans a month on Max
              </div>
            </div>
            <div>
              <div className="font-code text-[28px] font-semibold text-nether-fg-soft">
                {formatCount(TIER_LIMITS.max.snippet)}
              </div>
              <div className="mt-1 text-[12.5px] text-nether-faint">
                snippet analyses a month on Max
              </div>
            </div>
          </div>
        </div>

        <LiveFeed />
      </Reveal>

      <Reveal
        id="pricing"
        className="relative z-[2] mx-auto max-w-[1200px] scroll-mt-24 px-6 pb-28 sm:px-12 sm:pb-[140px]"
      >
        <div className="mb-12 text-center sm:mb-16">
          <div className="mb-3.5 font-code text-xs tracking-[0.15em] text-nether-glow">
            PRICING
          </div>
          <h2 className="text-[clamp(30px,5vw,42px)] font-semibold tracking-[-0.02em]">
            Start free. Scale when ready.
          </h2>
        </div>

        <div className="grid grid-cols-1 items-stretch gap-5 sm:grid-cols-2 xl:grid-cols-4">
          {pricingCards.map((card) => (
            <div
              key={card.name}
              className={`flex flex-col rounded-[20px] border px-7 py-9 backdrop-blur-lg ${
                card.highlight
                  ? "border-nether-glow-edge-strong bg-linear-160 from-nether-glow-glass to-nether-glass-to shadow-[0_30px_60px_-20px_var(--nether-glow-shadow)] xl:-translate-y-2"
                  : "border-nether-line bg-linear-160 from-nether-glass-from to-nether-glass-to"
              }`}
            >
              {card.highlight && (
                <div className="mb-4.5 inline-block self-start rounded-full bg-nether-glow-wash-strong px-3 py-1.5 font-code text-[11px] tracking-[0.08em] text-nether-glow-soft">
                  MOST POPULAR
                </div>
              )}

              <h3 className="mb-2 text-xl font-semibold">{card.name}</h3>

              <div className="mb-3.5 flex items-baseline gap-1.5">
                <span className="text-4xl font-bold tabular-nums">
                  {card.price}
                </span>
                <span className="text-[13px] text-nether-faint">
                  {card.period}
                </span>
              </div>

              <p className="mb-6 text-[13.5px] leading-[1.6] text-nether-dim">
                {card.tagline}
              </p>

              <div className="mb-7 flex flex-col gap-3">
                {card.highlights.map((highlight) => (
                  <div
                    key={highlight}
                    className="flex items-baseline gap-2.5 text-[13.5px] text-nether-muted"
                  >
                    <span aria-hidden="true" className="text-nether-glow">
                      →
                    </span>
                    {highlight}
                  </div>
                ))}
              </div>

              {card.href ? (
                <Link
                  href={card.href}
                  className={ctaClassName(card.highlight)}
                >
                  {card.cta}
                </Link>
              ) : (
                <ChatEntryLink className={ctaClassName(card.highlight)}>
                  {card.cta}
                </ChatEntryLink>
              )}
            </div>
          ))}
        </div>
      </Reveal>

      <section
        id="access"
        className="relative z-[2] mx-auto max-w-[1200px] px-6 pb-24 sm:px-12"
      >
        <div className="nether-float rounded-[28px] border border-nether-line bg-linear-135 from-nether-cta-from to-nether-cta-to px-6 py-14 text-center backdrop-blur-2xl sm:px-12 sm:py-[72px]">
          <h2 className="mb-4 text-[clamp(28px,4.5vw,38px)] font-semibold tracking-[-0.02em]">
            Ready to see what&apos;s hiding in your repo?
          </h2>
          <p className="mb-8 text-[15.5px] text-nether-dim">
            Point Netherite at a repository and read the first findings in
            minutes — no card required.
          </p>
          <ChatEntryLink className="inline-block rounded-[10px] bg-nether-glow px-8 py-4 text-[15px] font-semibold whitespace-nowrap text-nether-on-glow transition-opacity hover:opacity-90">
            Try Netherite
          </ChatEntryLink>
        </div>
      </section>

      <footer className="relative z-[2] mx-auto flex max-w-[1200px] flex-wrap items-start justify-between gap-10 border-t border-nether-line px-6 py-12 sm:px-12">
        <div>
          <div className="mb-3 flex items-center gap-2.5">
            <Wordmark size={28} />
            <span className="font-code text-[13px] font-semibold tracking-[0.1em]">
              NETHERITE
            </span>
          </div>
          <div className="flex items-center gap-2 font-code text-xs text-nether-faint">
            <span className="nether-pulse h-1.5 w-1.5 rounded-full bg-nether-glow" />
            all systems nominal · © 2026 Netherite
          </div>
        </div>

        <div className="flex flex-wrap gap-10 text-[13.5px] sm:gap-16">
          {footerColumns.map((column) => (
            <div key={column.heading} className="flex flex-col gap-2.5">
              <span className="mb-1 text-[11.5px] tracking-[0.1em] text-nether-faint">
                {column.heading}
              </span>
              {column.links.map(({ label, href }) => (
                <Link
                  key={label}
                  href={href}
                  className="text-nether-dim transition-colors hover:text-nether-glow"
                >
                  {label}
                </Link>
              ))}
            </div>
          ))}
        </div>
      </footer>
    </div>
  );
}

function ctaClassName(highlight: boolean): string {
  return `mt-auto rounded-[10px] px-5 py-3.5 text-center text-sm font-semibold transition-opacity hover:opacity-90 ${
    highlight
      ? "bg-nether-glow text-nether-on-glow"
      : "border border-nether-line-strong text-nether-fg-soft"
  }`;
}
