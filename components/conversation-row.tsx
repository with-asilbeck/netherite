"use client";

import { useEffect, useRef, useState, useTransition, type KeyboardEvent } from "react";
import Link from "next/link";
import { deleteConversationAction, renameConversationAction } from "@/app/chat/actions";

// Roughly the menu's height (two items plus padding) at the mobile sizing,
// used only to decide which way to open. Overestimating is the safe direction:
// it flips upward slightly early rather than opening into a clipped gap.
const ESTIMATED_MENU_HEIGHT = 96;

/**
 * Nearest scrolling ancestor, found by computed style rather than by class
 * name so it keeps working if the sidebar's markup changes.
 */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let parent = el?.parentElement ?? null;
  while (parent) {
    const overflowY = getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return parent;
    parent = parent.parentElement;
  }
  return null;
}

function ThreeDotsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <circle cx="12" cy="19" r="1.75" />
    </svg>
  );
}

export function ConversationRow({
  id,
  label,
  onDeleted,
  onRenamed,
}: {
  id: string;
  label: string;
  onDeleted: (id: string) => void;
  onRenamed: (id: string, title: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(label);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // The recents list is a scroll container, which clips absolutely positioned
  // children. For rows near the bottom, a menu opening downward lands entirely
  // outside it — Rename and Delete become unreachable, not just ugly. So pick
  // the direction that actually has room before opening.
  function toggleMenu() {
    if (menuOpen) {
      setMenuOpen(false);
      setConfirmingDelete(false);
      return;
    }

    const scroller = findScrollParent(buttonRef.current);
    if (buttonRef.current && scroller) {
      const button = buttonRef.current.getBoundingClientRect();
      const bounds = scroller.getBoundingClientRect();
      const spaceBelow = bounds.bottom - button.bottom;
      const spaceAbove = button.top - bounds.top;
      setDropUp(spaceBelow < ESTIMATED_MENU_HEIGHT && spaceAbove > spaceBelow);
    } else {
      setDropUp(false);
    }

    setMenuOpen(true);
  }

  useEffect(() => {
    if (!menuOpen) return;

    function handlePointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirmingDelete(false);
      }
    }
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setConfirmingDelete(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (isRenaming) inputRef.current?.select();
  }, [isRenaming]);

  function handleDeleteClick() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await deleteConversationAction(id);
      if (result.error) {
        setError(result.error);
        setConfirmingDelete(false);
        return;
      }
      setMenuOpen(false);
      onDeleted(id);
    });
  }

  function startRename() {
    setMenuOpen(false);
    setConfirmingDelete(false);
    setError(null);
    setRenameValue(label);
    setIsRenaming(true);
  }

  function submitRename() {
    if (isPending) return;
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === label) {
      setIsRenaming(false);
      return;
    }
    startTransition(async () => {
      const result = await renameConversationAction(id, trimmed);
      if (result.error) {
        setError(result.error);
        setIsRenaming(false);
        return;
      }
      onRenamed(id, result.title ?? trimmed);
      setIsRenaming(false);
    });
  }

  function handleRenameKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      submitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setIsRenaming(false);
    }
  }

  if (isRenaming) {
    return (
      <li>
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={submitRename}
          maxLength={200}
          disabled={isPending}
          className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-card-foreground outline-none disabled:opacity-60"
        />
      </li>
    );
  }

  return (
    // The open menu (and the error popover) must paint above the rows below
    // this one. They can't do it on their own: the button's wrapper uses
    // `-translate-y-1/2`, and a transform creates a stacking context, so the
    // menu's own `z-20` only applies *inside* that context. The context itself
    // has `z-index: auto`, so later positioned siblings win on DOM order — the
    // menu ended up behind the next row's title, with both texts overlapping.
    // Lifting the whole row while it's open is what actually escapes that.
    <li className={`group relative ${menuOpen || error ? "z-30" : ""}`}>
      <Link
        href={`/chat/${id}`}
        // Extra right padding on mobile to clear the larger touch target.
        className="block truncate rounded-lg px-2 py-1.5 pr-10 text-sm text-foreground/85 transition-colors hover:bg-muted md:pr-7"
      >
        {label}
      </Link>

      <div ref={containerRef} className="absolute right-1 top-1/2 -translate-y-1/2">
        <button
          ref={buttonRef}
          type="button"
          aria-label="Conversation options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={toggleMenu}
          // Always visible below md: touch devices have no hover, so the
          // hover-to-reveal treatment made this button undiscoverable and
          // untappable on a phone. Desktop keeps reveal-on-hover.
          // 32px on mobile vs 24px on desktop — 24px is far too small to hit
          // reliably with a thumb, but it still has to fit the row's height.
          className={`flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted md:h-6 md:w-6 ${
            menuOpen
              ? "opacity-100"
              : "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
          }`}
        >
          <ThreeDotsIcon />
        </button>

        {menuOpen && (
          <div
            role="menu"
            className={`absolute right-0 z-20 w-40 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg ${
              dropUp ? "bottom-full mb-1" : "top-full mt-1"
            }`}
          >
            <button
              type="button"
              role="menuitem"
              onClick={startRename}
              className="block w-full px-3 py-2.5 text-left text-sm text-card-foreground transition-colors hover:bg-muted md:py-1.5"
            >
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={isPending}
              onClick={handleDeleteClick}
              className={`block w-full px-3 py-2.5 text-left text-sm transition-colors disabled:opacity-50 md:py-1.5 ${
                confirmingDelete
                  ? "text-error-foreground hover:bg-error-bg"
                  : "text-card-foreground hover:bg-muted"
              }`}
            >
              {confirmingDelete ? "Click again to confirm" : "Delete"}
            </button>
          </div>
        )}
      </div>

      {error && (
        <p
          role="alert"
          // Same clipping problem as the menu, same fix.
          className={`absolute right-0 z-20 w-48 rounded-lg border border-error-border bg-error-bg px-3 py-1.5 text-xs leading-[1.4] text-error-foreground ${
            dropUp ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          {error}
        </p>
      )}
    </li>
  );
}
