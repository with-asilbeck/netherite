import type { ReactNode } from "react";
import { inter } from "@/lib/fonts";
import { createClient } from "@/lib/supabase/server";
import { conversationLabel } from "@/lib/conversations";
import { ChatSidebar } from "@/components/chat-sidebar";
import { ChatShell } from "@/components/chat-shell";
import { ChatSessionProvider } from "@/components/chat-session";
import { UpgradeButton } from "@/components/upgrade-button";
import { getUserTier } from "@/lib/get-user-tier";
import { DEFAULT_TIER } from "@/lib/tiers";

const MAX_RECENTS = 30;

// How many of a conversation's earliest messages to look at when deriving its
// label. Only the first message with role 'user' is used; anything past that
// is wasted rows. Reading a few rather than exactly one leaves room for a
// conversation that somehow opens with an assistant message without falling
// back to a meaningless label.
const FIRST_MESSAGE_PROBE = 3;

type ConversationRow = {
  id: string;
  title: string | null;
  chat_messages: { role: string; content: string }[];
};

async function loadRecentConversations(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
) {
  // `chat_messages!inner(...)` makes this an inner join, so a conversation
  // with no messages is never returned at all.
  //
  // That is a defensive check, not the mechanism: conversations are created
  // together with their first message (lib/conversations.ts), so an empty one
  // shouldn't exist. If a future change reintroduces one, it stays out of the
  // sidebar instead of showing up as a phantom "New chat" the user can't get
  // rid of. Doing it in the join rather than by filtering afterwards means the
  // limit of 30 counts real conversations.
  //
  // The embedded limit applies per conversation, so this reads at most
  // 3 messages each — not every message of all 30.
  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, chat_messages!inner(role, content)")
    .eq("user_id", userId) // defense in depth alongside RLS — never rely on RLS alone
    .order("created_at", { ascending: false })
    .order("created_at", { referencedTable: "chat_messages", ascending: true })
    .limit(MAX_RECENTS)
    .limit(FIRST_MESSAGE_PROBE, { referencedTable: "chat_messages" });

  if (error) {
    console.error("[chat] Supabase select (recent conversations) failed:", error);
    return [];
  }

  const conversations = (data ?? []) as unknown as ConversationRow[];

  return conversations.map((c) => {
    const firstUserMessage = c.chat_messages.find((m) => m.role === "user")?.content;
    return { id: c.id, label: conversationLabel(c.title, firstUserMessage) };
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

  // Both reads happen server-side. The tier goes through the one resolver
  // (lib/get-user-tier.ts), which is request-memoised — so this costs
  // nothing extra on a request whose route also checks a cap.
  const [conversations, tier] = await Promise.all([
    user ? loadRecentConversations(supabase, user.id) : Promise.resolve([]),
    user ? getUserTier(user.id).then((resolved) => resolved.tier) : Promise.resolve(DEFAULT_TIER),
  ]);

  return (
    <div className={`${inter.variable} h-screen w-full font-sans`}>
      {/* Wraps the sidebar and the chat view together: sending the first
          message in a draft has to add a row to Recents, and pressing
          "New chat" in the sidebar has to clear the view. */}
      <ChatSessionProvider initialConversations={conversations}>
        <ChatShell
          sidebar={<ChatSidebar userEmail={user?.email} />}
          // Renders nothing on the top tier — see UpgradeButton.
          headerRight={user ? <UpgradeButton tier={tier} /> : null}
        >
          {children}
        </ChatShell>
      </ChatSessionProvider>
    </div>
  );
}
