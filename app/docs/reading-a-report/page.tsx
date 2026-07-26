import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Reading a report — Netherite Docs",
  description:
    "Every finding pairs a plain-English risk explanation with a complete fix.",
};

export default function ReadingAReportPage() {
  return (
    <div>
      <div className="mb-4 text-sm font-medium text-[oklch(0.45_0_0)]">
        Documentation
      </div>
      <h1 className="m-0 text-[clamp(28px,4vw,44px)] font-semibold leading-[1.15] tracking-[-0.02em]">
        Reading a report
      </h1>
      <p className="mt-6 max-w-[560px] text-lg leading-[1.6] text-[oklch(0.4_0_0)]">
        Every finding pairs a plain-English risk explanation with a complete
        fix.
      </p>
    </div>
  );
}
