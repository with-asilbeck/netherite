// Shown the instant a chat link is clicked, while the conversation renders
// on the server.
//
// This file is doing more than showing a spinner. `/chat/[id]` is a dynamic
// route, and Next.js skips prefetching dynamic routes entirely unless a
// loading boundary exists — so without this, clicking a conversation did
// nothing at all until the full server response arrived (~1-2s), which read
// as a frozen UI. With it, the shared layout and this skeleton are prefetched
// and swapped in immediately, and the messages stream in behind it.
//
// Deliberately mirrors the real message list geometry (same max-width, gutters
// and bubble shapes) so the swap to actual content doesn't shift the layout.

const SKELETON_ROWS = [
  { align: "end", widths: ["w-48"] },
  { align: "start", widths: ["w-full", "w-[92%]", "w-[64%]"] },
  { align: "end", widths: ["w-64"] },
  { align: "start", widths: ["w-[88%]", "w-full", "w-[45%]"] },
] as const;

export default function ConversationLoading() {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading conversation…</span>

      <div className="flex-1 overflow-hidden">
        <div className="mx-auto flex w-full max-w-[720px] animate-pulse flex-col gap-6 px-6 py-8">
          {SKELETON_ROWS.map((row, i) => (
            <div
              key={i}
              className={row.align === "end" ? "flex justify-end" : "flex justify-start"}
            >
              <div
                className={`space-y-2 rounded-2xl px-4 py-3 ${
                  row.align === "end"
                    ? "w-auto bg-accent/25"
                    : "w-[85%] bg-muted"
                }`}
              >
                {row.widths.map((w, j) => (
                  <div key={j} className={`h-3.5 rounded bg-foreground/10 ${w}`} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Composer placeholder — keeps the input anchored where it will land. */}
      <div className="mx-auto w-full max-w-[720px] px-6 pb-2">
        <div className="mx-auto w-[90%]">
          <div className="flex items-center gap-2.5">
            <div className="h-[50px] w-[50px] shrink-0 rounded-2xl bg-muted" />
            <div className="h-[50px] flex-1 rounded-full border border-border bg-card" />
            <div className="h-[50px] w-[50px] shrink-0 rounded-2xl bg-muted" />
          </div>
          <p className="mt-[18px] px-1 text-center text-xs text-muted-foreground">
            Netherite is an AI and can make mistakes. Check important info.
          </p>
        </div>
      </div>
    </div>
  );
}
