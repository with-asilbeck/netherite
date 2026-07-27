"use client";

import { useState } from "react";
import Link from "next/link";

export function GuestBanner() {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-border bg-muted px-4 py-2.5 text-center text-[13px] leading-[1.5] text-muted-foreground"
    >
      <span>
        This conversation isn&apos;t saved — sign in to keep your chat
        history.
      </span>
      <Link
        href="/login"
        className="font-medium underline underline-offset-2 hover:opacity-70"
      >
        Sign in
      </Link>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        ✕
      </button>
    </div>
  );
}
