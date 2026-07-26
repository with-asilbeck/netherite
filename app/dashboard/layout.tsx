import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { inter } from "@/lib/fonts";
import { logout } from "./actions";

export default function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div
      className={`${inter.variable} flex min-h-screen w-full flex-col bg-[#F8F3D9] font-sans text-[oklch(0.15_0_0)]`}
    >
      <header className="flex items-center justify-between border-b border-[oklch(0.9_0_0)] px-6 py-7 sm:px-14">
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

        <form action={logout}>
          <button
            type="submit"
            className="rounded-[10px] border border-[oklch(0.85_0_0)] px-[18px] py-[9px] text-sm font-medium transition-colors hover:bg-[oklch(0.92_0_0)]"
          >
            Log out
          </button>
        </form>
      </header>

      <main className="flex-1 px-6 py-16 sm:px-14">{children}</main>
    </div>
  );
}
