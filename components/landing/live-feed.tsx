"use client";

import { useEffect, useState } from "react";

/**
 * An illustration of the detection engine's output, not a window onto it —
 * the section copy says so, and nothing here talks to the scanner. Kept as
 * plausible findings rather than invented CVE numbers.
 */
const FEED = [
  {
    tag: "SSRF",
    text: "webhook_handler.py:118 — exploit confirmed, patch opened",
    tone: "alert",
  },
  { tag: "PATCH", text: "PR #482 merged — SSRF closed in 6m", tone: "good" },
  {
    tag: "AUTH",
    text: "auth/session.go:44 — broken access control detected",
    tone: "alert",
  },
  { tag: "SCAN", text: "412 files re-indexed after commit 8f2a1c", tone: "quiet" },
  {
    tag: "SQLI",
    text: "reports/query_builder.rb:91 — injection vector found",
    tone: "alert",
  },
  {
    tag: "PATCH",
    text: "PR #483 opened — parameterized query fix ready",
    tone: "good",
  },
  {
    tag: "DEPS",
    text: "lodash@4.17.11 reachable from api/ — known prototype pollution",
    tone: "note",
  },
  { tag: "CLEAR", text: "payments/ passed full exploit simulation", tone: "good" },
] as const;

const TONE_CLASS: Record<(typeof FEED)[number]["tone"], string> = {
  alert: "text-nether-alert",
  good: "text-nether-glow",
  quiet: "text-nether-muted",
  note: "text-nether-violet",
};

const VISIBLE = 6;
const INTERVAL_MS = 2400;

type Entry = (typeof FEED)[number] & { id: number };

export function LiveFeed() {
  // Seeded from the front of the list rather than at random: the first paint
  // has to match what the server rendered, and a random pick wouldn't.
  const [entries, setEntries] = useState<Entry[]>(() =>
    FEED.slice(0, VISIBLE).map((entry, index) => ({ ...entry, id: index })),
  );

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Cycled rather than picked at random: the pool is deliberately larger
    // than the window, so walking it means the six visible lines are always
    // six different findings.
    let next = VISIBLE;
    const timer = setInterval(() => {
      const entry = FEED[next % FEED.length];
      setEntries((current) => [
        { ...entry, id: next++ },
        ...current.slice(0, VISIBLE - 1),
      ]);
    }, INTERVAL_MS);

    return () => clearInterval(timer);
  }, []);

  return (
    <div className="overflow-hidden rounded-[20px] border border-nether-line bg-linear-160 from-nether-glass-from to-nether-glass-to shadow-[0_30px_80px_-30px_var(--nether-shadow)] backdrop-blur-2xl">
      <div className="flex items-center gap-2 border-b border-nether-line px-5 py-3.5 font-code text-xs text-nether-dim">
        <span className="nether-pulse h-1.5 w-1.5 rounded-full bg-nether-glow" />
        live feed
      </div>

      <div className="flex min-h-[280px] flex-col gap-3 px-5 py-4.5 font-code text-[13px]">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="nether-log-in flex items-baseline gap-2.5 border-b border-nether-line-faint pb-3"
          >
            <span
              className={`min-w-[52px] font-semibold ${TONE_CLASS[entry.tone]}`}
            >
              {entry.tag}
            </span>
            <span className="text-nether-muted">{entry.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
