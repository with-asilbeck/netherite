"use client";

import { useActionState } from "react";
import {
  createConversationAction,
  type CreateConversationState,
} from "@/app/chat/actions";

const initialState: CreateConversationState = {};

export function NewChatButton() {
  const [state, formAction, isPending] = useActionState(
    createConversationAction,
    initialState,
  );

  return (
    <div className="px-3 pt-4">
      <form action={formAction}>
        <button
          type="submit"
          disabled={isPending}
          className="flex w-full items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card disabled:opacity-60"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="shrink-0"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          {isPending ? "Starting…" : "New chat"}
        </button>
      </form>
      {state?.error && (
        <p className="mt-2 px-1 text-xs text-error-foreground">
          {state.error}
        </p>
      )}
    </div>
  );
}
