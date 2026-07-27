import type { ReactNode } from "react";
import { inter } from "@/lib/fonts";
import { createClient } from "@/lib/supabase/server";
import { ChatSidebar } from "@/components/chat-sidebar";
import { ChatShell } from "@/components/chat-shell";

const MAX_RECENTS = 30;
const TITLE_TRUNCATE_LENGTH = 40;

function truncate(text: string, length: number) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > length ? `${trimmed.slice(0, length).trimEnd()}…` : trimmed;
}

async function loadRecentConversations(
  supabase: Awaited<ReturnType<typeof createClient>>,
) {
  const { data: conversations } = await supabase
    .from("conversations")
    .select("id, title")
    .order("created_at", { ascending: false })
    .limit(MAX_RECENTS);

  if (!conversations || conversations.length === 0) return [];

  const untitledIds = conversations
    .filter((c) => !c.title?.trim())
    .map((c) => c.id);

  const firstMessageByConversation = new Map<string, string>();
  if (untitledIds.length > 0) {
    const { data: firstMessages } = await supabase
      .from("chat_messages")
      .select("conversation_id, content")
      .in("conversation_id", untitledIds)
      .eq("role", "user")
      .order("created_at", { ascending: true })
      .limit(200);

    for (const row of firstMessages ?? []) {
      if (!firstMessageByConversation.has(row.conversation_id)) {
        firstMessageByConversation.set(row.conversation_id, row.content);
      }
    }
  }

  return conversations.map((c) => {
    const title = c.title?.trim();
    const firstMessage = firstMessageByConversation.get(c.id);
    const label = title
      ? truncate(title, TITLE_TRUNCATE_LENGTH)
      : firstMessage
        ? truncate(firstMessage, TITLE_TRUNCATE_LENGTH)
        : "New chat";
    return { id: c.id, label };
  });
}

export default async function ChatLayout({
  children,
}: {
  children: ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const conversations = user ? await loadRecentConversations(supabase) : [];

  return (
    <div className={`${inter.variable} h-screen w-full font-sans`}>
      <ChatShell
        sidebar={
          <ChatSidebar userEmail={user?.email} conversations={conversations} />
        }
      >
        {children}
      </ChatShell>
    </div>
  );
}
