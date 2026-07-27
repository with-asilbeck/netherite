"use client";

import { useEffect, useRef, useState, useTransition, type KeyboardEvent } from "react";
import Link from "next/link";
import { deleteConversationAction, renameConversationAction } from "@/app/chat/actions";

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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(label);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
    <li className="group relative">
      <Link
        href={`/chat/${id}`}
        className="block truncate rounded-lg px-2 py-1.5 pr-7 text-sm text-foreground/85 transition-colors hover:bg-muted"
      >
        {label}
      </Link>

      <div ref={containerRef} className="absolute right-1 top-1/2 -translate-y-1/2">
        <button
          type="button"
          aria-label="Conversation options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          className={`flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted ${
            menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          }`}
        >
          <ThreeDotsIcon />
        </button>

        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg"
          >
            <button
              type="button"
              role="menuitem"
              onClick={startRename}
              className="block w-full px-3 py-1.5 text-left text-sm text-card-foreground transition-colors hover:bg-muted"
            >
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={isPending}
              onClick={handleDeleteClick}
              className={`block w-full px-3 py-1.5 text-left text-sm transition-colors disabled:opacity-50 ${
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
          className="absolute right-0 top-full z-20 mt-1 w-48 rounded-lg border border-error-border bg-error-bg px-3 py-1.5 text-xs leading-[1.4] text-error-foreground"
        >
          {error}
        </p>
      )}
    </li>
  );
}
