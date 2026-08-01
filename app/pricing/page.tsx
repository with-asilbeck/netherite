import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { PricingTable } from "@/components/pricing-table";
import { inter } from "@/lib/fonts";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Pricing — Netherite",
  description: "Plans for scanning repositories, analysing snippets, and asking the advisor.",
};

export default async function PricingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Only used to decide whether the buttons go to checkout or to login.
  // It is not an authorization decision — /api/checkout re-checks the
  // session server-side, and would 401 regardless of what this says.
  const signedIn = Boolean(user);

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
          href={signedIn ? "/account" : "/login"}
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          {signedIn ? "Account" : "Log in"}
        </Link>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-14 sm:px-8 md:py-20">
        <div className="text-center">
          <h1 className="m-0 text-[clamp(30px,4.5vw,46px)] font-semibold leading-[1.1] tracking-[-0.02em]">
            Pricing
          </h1>
          <p className="mx-auto mt-4 max-w-[520px] text-base leading-[1.6] text-muted-foreground">
            Every plan includes the full scanner, the advisor, and fixes for what it finds.
            The difference is how much you can run each month.
          </p>
        </div>

        <div className="mt-12">
          <PricingTable signedIn={signedIn} />
        </div>

        <p className="mt-10 text-center text-sm text-muted-foreground">
          Limits reset at the start of each month (UTC). Cancel any time — your plan stays
          active until the end of the period you&apos;ve paid for.
        </p>
      </main>

      <footer className="border-t border-border px-6 py-8 text-xs text-muted-foreground sm:px-14">
        © 2026 NETHERITE
      </footer>
    </div>
  );
}
