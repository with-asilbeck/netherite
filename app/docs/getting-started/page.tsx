import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Getting started — Netherite Docs",
  description: "Connect a repository or paste a snippet to run your first scan.",
};

export default function GettingStartedPage() {
  return (
    <div>
      <div className="mb-4 text-sm font-medium text-[oklch(0.45_0_0)]">
        Documentation
      </div>
      <h1 className="m-0 text-[clamp(28px,4vw,44px)] font-semibold leading-[1.15] tracking-[-0.02em]">
        Getting started
      </h1>
      <p className="mt-6 max-w-[560px] text-lg leading-[1.6] text-[oklch(0.4_0_0)]">
        Connect a repository or paste a snippet to run your first scan.
      </p>
    </div>
  );
}
