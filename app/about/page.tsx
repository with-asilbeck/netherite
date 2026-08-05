import type { Metadata } from "next";
import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";


/**
 * PLACEHOLDER — same reason as the cookie page: nothing in the codebase
 * defines a support address today, so the closing contact line is left
 * deliberately unfilled rather than invented. Set this to a `mailto:` (or a
 * contact page path) and the link renders itself.
 */
const CONTACT_HREF: string | null = null;

export const metadata: Metadata = {
  title: "About — Netherite",
  description:
    "AI wrote your code. Netherite is the security specialist that checks it — stack-aware scanning for the vulnerabilities generic scanners miss.",
};

const capabilities = [
  {
    title: "Deep, stack-aware scanning",
    body: "Not generic pattern matching. We check for the specific misconfigurations that show up in Supabase and Next.js apps: missing RLS policies, exposed keys, insecure auth flows, and more.",
  },
  {
    title: "A chatbot that actually knows security",
    body: "Ask questions, paste code, get a straight answer grounded in real vulnerability analysis, not vague generalities.",
  },
  {
    title: "Agent-native fixes",
    body: "When we find a problem, we don’t just flag it. We format the fix as a prompt ready to hand to Claude Code, Cursor, or whatever you’re already building with.",
  },
  {
    title: "Built for how you actually ship",
    body: "Live scans, fast triage, and a report you can act on immediately, not a PDF you’ll read next week.",
  },
];

const principles = [
  {
    term: "Specific",
    body: "not generic — built around the real stacks people are shipping with today",
  },
  {
    term: "Fast",
    body: "not a bottleneck — security should fit into how you already work, not slow you down",
  },
  {
    term: "Actionable",
    body: "not just informative — a report that tells you what’s wrong but not how to fix it isn’t finished",
  },
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

export default function AboutPage() {
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
          href="/"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Back home
        </Link>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-14 sm:px-8 md:py-20">
        <div className="mb-4 text-sm font-medium text-muted-foreground">
          About Netherite
        </div>
        <h1 className="m-0 text-[clamp(30px,4.5vw,46px)] font-semibold leading-[1.1] tracking-[-0.02em]">
          AI wrote your code. Who&rsquo;s checking it for vulnerabilities?
        </h1>

        <div className="mt-7 flex flex-col gap-5 text-lg leading-[1.6] text-muted-foreground">
          <p>
            AI coding tools have made it faster than ever to ship an app — but
            speed has a cost. Exposed Supabase keys. Missing row-level security.
            Auth flows that look right but aren&rsquo;t. These aren&rsquo;t
            hypothetical risks: they&rsquo;re the real breaches happening right
            now in &ldquo;vibe coded&rdquo; apps, the same class of mistakes that
            led to incidents like the Lovable CVE and the Moltbook leak.
          </p>
          <p>
            Generic security scanners weren&rsquo;t built for this problem. They
            check for the same textbook OWASP issues regardless of your stack,
            and they miss the specific ways modern AI-assisted apps — built fast
            on Supabase, Next.js, and similar frameworks — actually break.
          </p>
          <p className="text-foreground">
            Netherite was built to close that gap.
          </p>
        </div>

        <div className="mt-14 flex flex-col gap-10">
          <Section number="01" title="What we do">
            <p>
              Netherite is a security specialist for developers building with
              AI. Connect a GitHub repo, paste a snippet, or just ask a question
              — Netherite scans your code for real, stack-specific
              vulnerabilities and explains not just <em>what&rsquo;s</em> wrong,
              but <em>why</em> it matters and <em>how</em> to fix it.
            </p>

            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {capabilities.map(({ title, body }) => (
                <li
                  key={title}
                  className="rounded-xl border border-border p-5 leading-[1.7]"
                >
                  <span className="font-semibold text-foreground">{title}</span>{" "}
                  — {body}
                </li>
              ))}
            </ul>
          </Section>

          <Section number="02" title="Why it matters">
            <p>
              The tools that made it easy to build an app didn&rsquo;t make it
              easy to secure one. As AI-generated code becomes the default way
              software gets written, the gap between &ldquo;it works&rdquo; and
              &ldquo;it&rsquo;s safe&rdquo; is only going to widen. Netherite
              exists to close that gap — one repo, one scan, one fix at a time.
            </p>
          </Section>

          <Section number="03" title="Our approach">
            <p>We believe security tooling should be:</p>
            <ul className="list-disc space-y-2 pl-5">
              {principles.map(({ term, body }) => (
                <li key={term} className="pl-1">
                  <span className="font-semibold text-foreground">{term}</span>,{" "}
                  {body}
                </li>
              ))}
            </ul>
          </Section>
        </div>

        <div className="mt-14 border-t border-border pt-8 text-sm italic leading-[1.7] text-muted-foreground">
          Netherite is in active development. Have feedback or found something
          we missed?{" "}
          {CONTACT_HREF ? (
            <a
              href={CONTACT_HREF}
              className="underline underline-offset-4 transition-colors hover:text-foreground"
            >
              Get in touch
            </a>
          ) : (
            "Get in touch"
          )}
          .
        </div>
      </main>

      <footer className="border-t border-border px-6 py-8 text-xs text-muted-foreground sm:px-14">
        © 2026 <span className="inline-block translate-y-[0.22em] text-[1.6em] leading-none font-brand">NETHERITE</span>
      </footer>
    </div>
  );
}
