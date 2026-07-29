import Image from "next/image";
import Link from "next/link";
import { inter } from "@/lib/fonts";

/**
 * Root 404. Catches unmatched URLs across the whole app, and also renders for
 * any `notFound()` thrown in a segment without its own not-found boundary
 * (today: a conversation that doesn't exist or isn't yours).
 *
 * No `metadata` export here — Next only reads it from layout/page and
 * global-not-found, so the title falls through to the root layout's. Next
 * injects `noindex` on 404 responses on its own.
 */
export default function NotFound() {
  return (
    <div
      className={`${inter.variable} flex min-h-screen w-full flex-col bg-sidebar font-sans text-foreground`}
    >
      <header className="flex w-full items-center px-6 py-7 sm:px-14">
        <Link href="/" className="flex items-center gap-3">
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
        </Link>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
        {/* Decorative, and the reason this page needs no illustration: the
            code itself is the visual. The heading below carries the message. */}
        <div
          aria-hidden
          className="font-mono text-[clamp(72px,14vw,150px)] font-semibold leading-none tracking-[-0.04em] text-border-strong"
        >
          404
        </div>

        <h1 className="mt-8 text-[clamp(28px,4vw,40px)] font-semibold tracking-[-0.02em]">
          Page not found
        </h1>

        <p className="mt-4 max-w-[420px] text-base leading-[1.6] text-muted-foreground">
          This page doesn&apos;t exist, or it moved somewhere else. The link
          that brought you here is out of date.
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/"
            className="rounded-xl bg-accent px-7 py-[14px] text-base font-medium text-accent-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
          >
            Back home
          </Link>
          <Link
            href="/docs"
            className="rounded-xl border border-border bg-card px-7 py-[14px] text-base font-medium text-card-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
          >
            Read the docs
          </Link>
        </div>
      </main>

      <footer className="border-t border-border px-6 py-8 text-xs text-muted-foreground sm:px-14">
        © 2026 NETHERITE
      </footer>
    </div>
  );
}
