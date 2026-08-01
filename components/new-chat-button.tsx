"use client";

import { useRouter } from "next/navigation";
import { CHAT_APP_PATH } from "@/lib/chat-entry";
import { useChatSession } from "@/components/chat-session";

export function NewChatButton() {
  const router = useRouter();
  const { startNewDraft } = useChatSession();

  // Creates nothing. This used to submit a server action that inserted a
  // conversations row and redirected to it, so five presses left five empty
  // conversations behind; now it only clears the view back to an empty draft,
  // and the row is written when the first message is sent.
  //
  // Both halves are needed. The navigation covers coming from an existing
  // conversation, and the reset covers pressing it while already on a draft —
  // where the route doesn't change, so a navigation on its own would leave
  // whatever had been typed (or already sent) sitting there.
  function handleClick() {
    startNewDraft();
    router.push(CHAT_APP_PATH);
  }

  return (
    <div className="px-3 pt-4">
      <button
        type="button"
        onClick={handleClick}
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
