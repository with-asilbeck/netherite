"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// How long the checkmark stays up before reverting to the copy icon.
const COPIED_FEEDBACK_MS = 1600;

/**
 * `navigator.clipboard` only exists in a secure context (https or localhost).
 * On a plain-http origin it is undefined, so fall back to the old selection
 * trick rather than leaving the button silently dead. The textarea is
 * off-screen and removed immediately, so nothing is ever visible.
 */
async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or a non-focused document — try the fallback.
  }

  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.top = "-9999px";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Where the button is sitting, which decides its colors. `code` is for the
 * fenced-code surface, which is dark on *both* themes -- the default's
 * `text-muted-foreground` is a mid stone brown that all but disappears on it.
 *
 * This is a prop rather than something the caller passes through `className`
 * because both tones set `color`, and Tailwind resolves competing utilities
 * by their order in the generated stylesheet, not by the order they appear in
 * the class attribute. An override passed in would win or lose at random.
 */
type Tone = "default" | "code";

const TONE_CLASSES: Record<Tone, string> = {
  default: "text-muted-foreground hover:bg-muted hover:text-foreground",
  code: "text-code-muted hover:bg-code-hover hover:text-code-foreground",
};

/**
 * Copies a message's text. Used under both sides of the chat transcript, so
 * it stays visually neutral and inherits its alignment from the parent.
 */
export function CopyButton({
  text,
  label = "Copy message",
  tone = "default",
  className = "",
}: {
  text: string;
  label?: string;
  tone?: Tone;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The reset is on a timer, so it can outlive the button — a message list
  // that re-renders or a "New chat" press would otherwise set state on an
  // unmounted component.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    const ok = await writeToClipboard(text);
    setState(ok ? "copied" : "failed");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState("idle"), COPIED_FEEDBACK_MS);
  }, [text]);

  const copied = state === "copied";

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      // The label carries the result too, so a screen reader gets the same
      // confirmation the checkmark gives everyone else.
      aria-label={copied ? "Copied" : state === "failed" ? "Couldn't copy" : label}
      title={copied ? "Copied" : label}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${TONE_CLASSES[tone]} ${className}`}
    >
      {copied ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? "Copied to clipboard" : state === "failed" ? "Copy failed" : ""}
      </span>
    </button>
  );
}
