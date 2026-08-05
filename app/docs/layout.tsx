import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { DocsSidebar } from "@/components/docs-sidebar";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex min-h-screen w-full flex-col bg-sidebar font-sans text-foreground"
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
          <span className="text-[34px] leading-none translate-y-[0.11em] font-brand">
            NETHERITE
          </span>
        </Link>

        <Link
          href="/"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Back home
        </Link>
      </header>

      {/* Stacked on phones so the nav is a strip above the content, side by
          side from md up. */}
      <div className="flex flex-1 flex-col md:flex-row">
        <DocsSidebar />
        <main className="min-w-0 flex-1 px-6 py-10 sm:px-14 md:py-16">{children}</main>
      </div>

      <footer className="border-t border-border px-6 py-8 text-xs text-muted-foreground sm:px-14">
        © 2026 <span className="inline-block translate-y-[0.22em] text-[1.6em] leading-none font-brand">NETHERITE</span>
      </footer>
    </div>
  );
}
