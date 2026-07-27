import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { inter } from "@/lib/fonts";
import { DocsSidebar } from "@/components/docs-sidebar";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className={`${inter.variable} flex min-h-screen w-full flex-col bg-sidebar font-sans text-foreground`}
    >
      <header className="flex items-center justify-between border-b border-border px-6 py-7 sm:px-14">
        <Link href="/" className="flex items-center gap-3">
          <Image
            src="/netherite-mark.png"
            alt="Netherite"
            width={34}
            height={34}
            className="h-[34px] w-[34px] object-contain"
          />
          <span className="text-lg font-semibold tracking-tight">
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

      <div className="flex flex-1">
        <DocsSidebar />
        <main className="min-w-0 flex-1 px-6 py-16 sm:px-14">{children}</main>
      </div>

      <footer className="border-t border-border px-6 py-8 text-xs text-muted-foreground sm:px-14">
        © 2026 NETHERITE
      </footer>
    </div>
  );
}
