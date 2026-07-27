import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "The chat advisor — Netherite Docs",
  description:
    "Ask about a specific endpoint or finding and get an answer grounded in your code.",
};

export default function ChatAdvisorPage() {
  return (
    <div>
      <div className="mb-4 text-sm font-medium text-muted-foreground">
        Documentation
      </div>
      <h1 className="m-0 text-[clamp(28px,4vw,44px)] font-semibold leading-[1.15] tracking-[-0.02em]">
        The chat advisor
      </h1>
      <p className="mt-6 max-w-[560px] text-lg leading-[1.6] text-muted-foreground">
        Ask about a specific endpoint or finding and get an answer grounded
        in your code.
      </p>
    </div>
  );
}
