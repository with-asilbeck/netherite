import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Docs — Netherite",
  description: "Documentation for integrating and using Netherite.",
};

export default function DocsPage() {
  return (
    <div>
      <div className="mb-4 text-sm font-medium text-muted-foreground">
        Documentation
      </div>
      <h1 className="m-0 text-[clamp(32px,4.5vw,56px)] font-semibold leading-[1.1] tracking-[-0.02em]">
        Docs
      </h1>
      <p className="mt-6 max-w-[560px] text-lg leading-[1.6] text-muted-foreground">
        Pick a topic from the sidebar to get started.
      </p>
    </div>
  );
}
