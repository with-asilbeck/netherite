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

type CopyState = "idle" | "copied" | "failed";

/**
 * The copy-and-confirm behaviour, shared by both buttons in this file: write,
 * flip to the confirmation, revert on a timer, and cancel that timer if the
 * button goes away first. A message list that re-renders or a "New chat"
 * press would otherwise set state on an unmounted component.
 */
function useCopy(text: string) {
  const [state, setState] = useState<CopyState>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const copy = useCallback(async () => {
    const ok = await writeToClipboard(text);
    setState(ok ? "copied" : "failed");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState("idle"), COPIED_FEEDBACK_MS);
  }, [text]);

  return { state, copy };
}

function CheckIcon() {
  return (
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
  );
}

/**
 * Where the button is sitting, which decides its colors. `code` is for the
 * fenced-code surface, which is dark on *both* themes -- the default's
 * `text-muted-foreground` is a mid stone brown that all but disappears on it.
 *
 * `code-prominent` is the same surface but for a button that has to be found
 * without hovering: an outlined chip that reads as a control at rest, and
 * inverts to a solid fill on hover so the interaction is unmistakable.
 *
 * **It is built from the `code-*` tokens rather than `accent` on purpose.**
 * `--accent` flips per theme, and its light value is `#5e503f` -- a dark brown
 * that lands on the near-black code surface at about 2.6:1, i.e. an accent
 * button would be *harder* to see in light mode than the muted one it
 * replaced. `--code-muted` and `--code-hover` are single values chosen for
 * this dark surface, so they hold in both themes.
 *
 * This is a prop rather than something the caller passes through `className`
 * because every tone sets `color`, and Tailwind resolves competing utilities
 * by their order in the generated stylesheet, not by the order they appear in
 * the class attribute. An override passed in would win or lose at random.
 */
type Tone = "default" | "code" | "code-prominent";

const TONE_CLASSES: Record<Tone, string> = {
  default: "text-muted-foreground hover:bg-muted hover:text-foreground",
  code: "text-code-muted hover:bg-code-hover hover:text-code-foreground",
  "code-prominent":
    "border border-code-muted bg-code-hover text-code-foreground hover:bg-code-foreground hover:text-code",
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
  const { state, copy } = useCopy(text);
  const copied = state === "copied";

  return (
    <button
      type="button"
      onClick={() => void copy()}
      // The label carries the result too, so a screen reader gets the same
      // confirmation the checkmark gives everyone else.
      aria-label={copied ? "Copied" : state === "failed" ? "Couldn't copy" : label}
      title={copied ? "Copied" : label}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${TONE_CLASSES[tone]} ${className}`}
    >
      {copied ? (
        <CheckIcon />
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

/**
 * Copies a finding as an instruction for an AI coding agent, rather than as
 * code. It never replaces `CopyButton` — the two copy different things, and
 * somebody who only wants the corrected lines to paste into their editor
 * still has the plain button in the block's header.
 *
 * **Always visible, and below the code rather than in the header strip.** It
 * started out beside the copy icon in that strip, which is revealed on hover
 * from `sm` up — so on a desktop the feature was invisible until the pointer
 * happened to cross a specific code block, and nobody found it. A hover to
 * discover is fine for a duplicate of something obvious (copy); it is not
 * fine for the only route to a feature. See CodeBlock for the placement.
 *
 * Labelled rather than icon-only, for the same reason: "this copies a
 * paragraph of instructions addressed to a different program" is not a
 * universally understood glyph. The prompt itself is built in
 * lib/fix-prompt.ts.
 */
export function CopyFixPromptButton({
  prompt,
  tone = "code-prominent",
  className = "",
}: {
  prompt: string;
  tone?: Tone;
  className?: string;
}) {
  const { state, copy } = useCopy(prompt);
  const copied = state === "copied";

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={
        copied
          ? "Fix prompt copied"
          : state === "failed"
            ? "Couldn't copy the fix prompt"
            : "Copy fix prompt"
      }
      title={
        copied
          ? "Copied"
          : "Copy this finding as an instruction for an AI coding agent"
      }
      className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs leading-none font-medium whitespace-nowrap transition-colors ${TONE_CLASSES[tone]} ${className}`}
    >
      {copied ? (
        <CheckIcon />
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
          {/* A prompt going somewhere else: a chat bubble with a spark. */}
          <path d="M21 11.5a8.4 8.4 0 01-9 8.4 9 9 0 01-3.9-.9L3 20.5l1.5-4.4A8.4 8.4 0 0112 3a8.4 8.4 0 019 8.5z" />
          <path d="M12 8l.9 2.1 2.1.9-2.1.9L12 14l-.9-2.1-2.1-.9 2.1-.9z" />
        </svg>
      )}
      <span aria-hidden="true">{copied ? "Copied!" : "Copy fix prompt"}</span>
      <span role="status" aria-live="polite" className="sr-only">
        {copied
          ? "Fix prompt copied to clipboard"
          : state === "failed"
            ? "Copy failed"
            : ""}
      </span>
    </button>
  );
}
