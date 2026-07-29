"use client";

import { useRouter } from "next/navigation";
import { newConversationId } from "@/lib/conversations";

export function NewChatButton() {
  const router = useRouter();

  // This used to post a server action that awaited `auth.getUser()` and an
  // INSERT before it was allowed to redirect — two serial Supabase round
  // trips, with the button sitting disabled behind them. Now the id is minted
  // locally and we navigate on the click itself; the row is created with the
  // first message (see lib/conversations.ts#ensureConversation).
  //
  // As a bonus this stops littering the sidebar with empty conversations
  // every time someone clicks "New chat" and then changes their mind.
  function startNewChat() {
    router.push(`/chat/${newConversationId()}`);
  }

  return (
    <div className="px-3 pt-4">
      <button
        type="button"
        onClick={startNewChat}
        className="flex w-full items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card"
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
        New chat
      </button>
    </div>
  );
}
