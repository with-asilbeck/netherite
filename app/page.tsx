import Image from "next/image";
import Link from "next/link";
import { inter } from "@/lib/fonts";
import { ScrollLink } from "@/components/scroll-link";
import { ChatEntryLink } from "@/components/chat-entry-link";

const stats = [
  {
    value: "61%",
    label: "of AI-generated apps ship with a critical vulnerability",
  },
  {
    value: "2.3M",
    label: "records leaked from vibe-coded apps in the past year",
  },
  { value: "1 in 4", label: "indie SaaS launches suffer a breach in month one" },
  { value: "$4.9M", label: "average cost of a startup data breach" },
  { value: "80%", label: "of leaked API keys found in public repos" },
];

const steps = [
  {
    number: "01",
    title: "Connect your repo",
    body: "NETHERITE ingests your codebase and maps every entry point, dependency, and data flow.",
  },
  {
    number: "02",
    title: "AI probes for weaknesses",
    body: "It reasons like an attacker — chaining flaws the way a real penetration tester would.",
  },
  {
    number: "03",
    title: "Get a clear report",
    body: "Every finding comes with proof of exploit and a concrete fix — no noise, no false positives.",
  },
];

const navLinks: { label: string; href: string | null }[] = [
  { label: "Docs", href: "/docs" },
  { label: "How it works", href: null },
  { label: "Pricing", href: "/pricing" },
  { label: "Partnership", href: "#" },
];

const navLinkClassName =
  "text-sm text-muted-foreground transition-colors hover:text-foreground";

const chatMessages = [
  {
    from: "user" as const,
    text: "Is our /api/user/:id endpoint exposed to IDOR?",
  },
  {
    from: "assistant" as const,
    text: (
      <>
        Yes — it doesn&apos;t verify the requester owns{" "}
        <code className="font-mono">:id</code>. Any authenticated user can
        read another account&apos;s profile. Add an ownership check before
        the query. I can generate the patch.
      </>
    ),
  },
  { from: "user" as const, text: "Yes, generate it." },
];

function StatItem({ value, label }: { value: string; label: string }) {
  return (
    <span className="whitespace-nowrap text-[15px] text-muted-foreground">
      <b className="text-foreground">{value}</b> {label}
    </span>
  );
}

export default function Home() {
  return (
    <div
      className={`${inter.variable} flex min-h-screen w-full flex-col bg-sidebar font-sans text-foreground`}
    >
      <header className="flex items-center justify-between border-b border-border px-6 py-7 sm:px-14">
        <div className="flex items-center gap-3">
          <Image
            src="/netherite-mark.png"
            alt="Netherite"
            width={34}
            height={34}
            className="h-[34px] w-[34px] object-contain dark:invert"
          />
          <span className="text-lg font-semibold tracking-tight">
            NETHERITE
          </span>
        </div>

        <nav className="hidden items-center gap-8 md:flex">
          {navLinks.map(({ label, href }) =>
            href ? (
              <Link key={label} href={href} className={navLinkClassName}>
                {label}
              </Link>
            ) : (
              <ScrollLink
                key={label}
                targetId="how-it-works"
                className={navLinkClassName}
              >
                {label}
              </ScrollLink>
            ),
          )}
        </nav>

        <div className="flex items-center gap-6">
          <Link
            href="/login"
            className="text-sm text-foreground transition-opacity hover:opacity-60"
          >
            Log in
          </Link>
          <ChatEntryLink className="rounded-[10px] bg-accent px-[18px] py-[9px] text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90">
            Try Netherite
          </ChatEntryLink>
        </div>
      </header>

      <main className="flex flex-1 flex-wrap items-center gap-10 px-6 py-14 sm:gap-16 sm:px-14 sm:py-20">
        <div className="min-w-0 flex-1 basis-80 text-left">
          <div className="mb-6 text-sm font-medium text-muted-foreground">
            AI Penetration Tester
          </div>

          <h1 className="m-0 text-[clamp(40px,5.5vw,72px)] font-semibold leading-[1.05] tracking-[-0.03em]">
            Find the exploit before it finds you.
          </h1>

          <p className="mt-6 max-w-[520px] text-[17px] leading-[1.6] text-muted-foreground sm:mt-7 sm:text-[19px]">
            NETHERITE is an AI security specialist that scans your codebase,
            finds vulnerabilities, and shows you exactly how they&apos;d be
            exploited.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-4 sm:mt-11 sm:gap-6">
            <ChatEntryLink className="rounded-xl bg-accent px-7 py-[14px] text-base font-medium text-accent-foreground transition-opacity hover:opacity-90">
              Try Netherite
            </ChatEntryLink>
          </div>
        </div>

        <div
          className="flex min-w-0 flex-1 basis-80 items-center justify-center rounded-2xl border border-border"
          style={{
            aspectRatio: "16/10",
            background:
              "repeating-linear-gradient(135deg, var(--muted), var(--muted) 10px, var(--border) 10px, var(--border) 20px)",
          }}
        >
          <span className="font-mono text-[13px] tracking-wide text-muted-foreground">
            product demo video
          </span>
        </div>
      </main>

      <div className="overflow-hidden border-y border-border py-7">
        <div className="marquee-track flex w-max gap-16">
          {[0, 1].map((copy) => (
            <div key={copy} className="flex shrink-0 gap-16">
              {stats.map((stat) => (
                <StatItem key={`${copy}-${stat.value}`} {...stat} />
              ))}
            </div>
          ))}
        </div>
      </div>

      <section
        id="how-it-works"
        className="flex min-h-screen items-center border-t border-border px-6 py-14 sm:px-14"
      >
        <div className="mx-auto w-full max-w-[1100px]">
          <div className="mb-[72px] text-center">
            <div className="mb-4 text-sm font-medium text-muted-foreground">
              How it works
            </div>
            <h2 className="m-0 text-[clamp(30px,4vw,44px)] font-semibold tracking-[-0.02em]">
              Three steps to a hardened codebase
            </h2>
          </div>

          <div className="grid grid-cols-1 gap-12 sm:grid-cols-3">
            {steps.map((step) => (
              <div key={step.number}>
                <div className="mb-4 text-sm font-medium text-muted-foreground">
                  {step.number}
                </div>
                <h3 className="mb-3 text-xl font-semibold tracking-[-0.01em]">
                  {step.title}
                </h3>
                <p className="text-base leading-[1.6] text-muted-foreground">
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="flex min-h-screen items-center border-t border-border bg-muted px-6 py-14 sm:px-14">
        <div className="mx-auto flex w-full max-w-[1100px] flex-wrap items-center gap-10 sm:gap-16">
          <div className="min-w-0 flex-1 basis-[380px] text-left">
            <div className="mb-4 text-sm font-medium text-muted-foreground">
              Ask Netherite
            </div>
            <h2 className="m-0 mb-5 text-[clamp(30px,4vw,44px)] font-semibold tracking-[-0.02em]">
              Talk to your security specialist directly.
            </h2>
            <p className="m-0 max-w-[460px] text-[17px] leading-[1.6] text-muted-foreground">
              Ask about a specific endpoint, paste a snippet, or query an
              open finding — NETHERITE&apos;s chat explains the risk in
              plain language and suggests the fix.
            </p>
          </div>

          {/* The whole preview is the affordance, not decoration: it routes
              through the same entry point as the "Try Netherite" buttons. */}
          <ChatEntryLink
            aria-label="Open the Netherite chat advisor"
            className="group block min-w-0 flex-1 basis-[380px] overflow-hidden rounded-2xl border border-border bg-card shadow-[0_20px_40px_rgb(0_0_0/0.06)] transition duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-1 hover:border-border-strong hover:shadow-[0_28px_56px_rgb(0_0_0/0.10)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent active:translate-y-0 active:scale-[0.995] motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100"
          >
            <div className="flex items-center gap-2 border-b border-border px-[18px] py-[14px]">
              <span className="h-2 w-2 rounded-full bg-muted-foreground" />
              <span className="h-2 w-2 rounded-full bg-muted-foreground" />
              <span className="h-2 w-2 rounded-full bg-muted-foreground" />
              <span className="ml-2 font-mono text-[13px] text-muted-foreground">
                netherite-chat
              </span>
            </div>

            <div className="flex flex-col gap-4 p-6">
              {chatMessages.map((message, i) =>
                message.from === "user" ? (
                  <div
                    key={i}
                    className="max-w-[80%] self-end rounded-tl-[14px] rounded-tr-[14px] rounded-br-[2px] rounded-bl-[14px] bg-accent px-4 py-3 text-sm leading-[1.5] text-accent-foreground"
                  >
                    {message.text}
                  </div>
                ) : (
                  <div
                    key={i}
                    className="max-w-[85%] self-start rounded-tl-[14px] rounded-tr-[14px] rounded-br-[14px] rounded-bl-[2px] bg-muted px-4 py-3 text-sm leading-[1.5] text-foreground"
                  >
                    {message.text}
                  </div>
                ),
              )}
            </div>

            <div className="flex gap-[10px] px-6 pb-6 pt-4">
              <div className="flex-1 rounded-[10px] border border-border px-[14px] py-[11px] text-sm text-muted-foreground transition-colors duration-300 group-hover:border-border-strong">
                Ask about your codebase…
              </div>
              <div className="h-10 w-10 shrink-0 rounded-[10px] bg-accent" />
            </div>
          </ChatEntryLink>
        </div>
      </section>

      {/* This footer is intentionally a fixed dark brand block, not theme-
          reactive like the rest of the page — same idea as the existing
          cream-body / dark-footer contrast, now drawn from the palette. */}
      <footer className="bg-black-500 px-6 pb-8 pt-[72px] text-black-800 sm:px-14">
        <div className="mx-auto max-w-[1100px]">
          <div className="grid grid-cols-1 gap-10 sm:grid-cols-[1.4fr_1fr_1fr_1fr]">
            <div>
              <div className="mb-4 flex items-center gap-[10px]">
                <Image
                  src="/netherite-mark.png"
                  alt="Netherite"
                  width={26}
                  height={26}
                  className="h-[26px] w-[26px] object-contain invert"
                />
                <span className="text-base font-semibold tracking-tight text-almond_cream-900">
                  NETHERITE
                </span>
              </div>
              <p className="m-0 max-w-[260px] text-sm leading-[1.6] text-black-700">
                AI security specialist that finds exploits before attackers
                do.
              </p>
            </div>

            <div>
              <div className="mb-4 text-[13px] font-semibold text-almond_cream-800">
                Products
              </div>
              <div className="flex flex-col gap-3">
                {["Code scanning", "Exploit simulation", "Pricing"].map(
                  (label) => (
                    <a
                      key={label}
                      href="#"
                      className="text-sm text-black-700 transition-colors hover:text-almond_cream-800"
                    >
                      {label}
                    </a>
                  ),
                )}
              </div>
            </div>

            <div>
              <div className="mb-4 text-[13px] font-semibold text-almond_cream-800">
                Company
              </div>
              <div className="flex flex-col gap-3">
                {["About", "Docs", "Contact"].map((label) => (
                  <a
                    key={label}
                    href="#"
                    className="text-sm text-black-700 transition-colors hover:text-almond_cream-800"
                  >
                    {label}
                  </a>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-4 text-[13px] font-semibold text-almond_cream-800">
                Legal
              </div>
              <div className="flex flex-col gap-3">
                {["Privacy Policy", "Terms & Conditions", "Security"].map(
                  (label) => (
                    <a
                      key={label}
                      href="#"
                      className="text-sm text-black-700 transition-colors hover:text-almond_cream-800"
                    >
                      {label}
                    </a>
                  ),
                )}
              </div>
            </div>
          </div>

          <div className="mt-14 border-t border-black-600 pt-6 text-[13px] text-black-700">
            © 2026 NETHERITE
          </div>
        </div>
      </footer>
    </div>
  );
}
