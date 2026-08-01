"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type RecentConversation = { id: string; label: string };

type ChatSessionValue = {
  /** The Recents list, as currently shown. */
  conversations: RecentConversation[];
  /**
   * Adds a conversation that was just created by sending the first message in
   * a draft. The draft never navigated anywhere, so nothing else would put it
   * in the sidebar until the next full page load.
   */
  addConversation: (conversation: RecentConversation) => void;
  removeConversation: (id: string) => void;
  renameConversation: (id: string, label: string) => void;
  /**
   * Bumped every time "New chat" is pressed. The draft view watches it and
   * clears itself — pressing "New chat" while already looking at a draft is a
   * no-op as far as routing is concerned, so a navigation alone wouldn't
   * reset anything.
   */
  draftResetToken: number;
  startNewDraft: () => void;
};

// Defaults, not a null check: `/try` renders the same ChatView for guests
// without this provider above it, and reading the context there should be
// harmless rather than a crash.
const ChatSessionContext = createContext<ChatSessionValue>({
  conversations: [],
  addConversation: () => {},
  removeConversation: () => {},
  renameConversation: () => {},
  draftResetToken: 0,
  startNewDraft: () => {},
});

export function ChatSessionProvider({
  initialConversations,
  children,
}: {
  initialConversations: RecentConversation[];
  children: ReactNode;
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const [draftResetToken, setDraftResetToken] = useState(0);

  const addConversation = useCallback((conversation: RecentConversation) => {
    setConversations((prev) => {
      // A reload can hand back a list that already contains it — replace
      // rather than duplicate, so the row doesn't appear twice.
      if (prev.some((c) => c.id === conversation.id)) {
        return prev.map((c) => (c.id === conversation.id ? conversation : c));
      }
      return [conversation, ...prev];
    });
  }, []);

  const removeConversation = useCallback((id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const renameConversation = useCallback((id: string, label: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, label } : c)));
  }, []);

  const startNewDraft = useCallback(() => {
    setDraftResetToken((token) => token + 1);
  }, []);

  const value = useMemo(
    () => ({
      conversations,
      addConversation,
      removeConversation,
      renameConversation,
      draftResetToken,
      startNewDraft,
    }),
    [
      conversations,
      addConversation,
      removeConversation,
      renameConversation,
      draftResetToken,
      startNewDraft,
    ],
  );

  return (
    <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>
  );
}

export function useChatSession() {
  return useContext(ChatSessionContext);
}
