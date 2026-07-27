import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Scanning a repo — Netherite Docs",
  description:
    "How Netherite ingests a codebase and maps entry points, dependencies, and data flow.",
};

export default function ScanningARepoPage() {
  return (
    <div>
      <div className="mb-4 text-sm font-medium text-muted-foreground">
        Documentation
      </div>
      <h1 className="m-0 text-[clamp(28px,4vw,44px)] font-semibold leading-[1.15] tracking-[-0.02em]">
        Scanning a repo
      </h1>
      <p className="mt-6 max-w-[560px] text-lg leading-[1.6] text-muted-foreground">
        How Netherite ingests a codebase and maps entry points, dependencies,
        and data flow.
      </p>
    </div>
  );
}
