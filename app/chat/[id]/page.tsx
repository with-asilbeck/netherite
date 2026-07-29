import { notFound, redirect } from "next/navigation";
import { createClient, getCachedUser } from "@/lib/supabase/server";
import { CONVERSATION_ID_RE } from "@/lib/conversations";
import { ChatView } from "@/app/chat/chat-view";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Anything that isn't a well-formed conversation token can't be a real
  // conversation and can't become one — reject it before touching the DB.
  if (!CONVERSATION_ID_RE.test(id)) {
    notFound();
  }

  const [supabase, user] = await Promise.all([createClient(), getCachedUser()]);

  if (!user) {
    redirect("/login");
  }

  // These two used to run back to back, so the page paid two serial Supabase
  // round trips. They don't depend on each other: the messages query is
  // independently gated by RLS (chat_messages_select_own joins to
  // conversations.user_id), so it returns zero rows for a conversation this
  // user doesn't own regardless of what the ownership check concludes.
  // Running them together halves the wall-clock cost without widening access.
  const [{ data: conversation }, { data: messageRows }] = await Promise.all([
    // Explicit ownership filter alongside RLS — never rely on RLS alone. A
    // conversation that exists but belongs to someone else comes back as no
    // row, same as one that doesn't exist at all. That's intentional: it
    // never reveals which case it is.
    supabase
      .from("conversations")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("chat_messages")
      .select("id, role, content")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true }),
  ]);

  // A missing row is no longer a 404. Conversations are created lazily on the
  // first message (lib/conversations.ts#ensureConversation) so "New chat" can
  // navigate instantly instead of waiting on an insert — which means a
  // brand-new conversation is legitimately reachable here before its row
  // exists. It renders as the empty state, exactly like a real new chat.
  //
  // This reveals nothing it didn't before: an unowned id and an unused id
  // render identically, and neither returns messages (RLS). Writing to an
  // unowned id still fails — ensureConversation cannot claim an id that
  // already belongs to someone else, and the chat_messages insert policy
  // rejects the message when its join to conversations.user_id doesn't match.
  const initialMessages = conversation
    ? (messageRows ?? []).map((row) => ({
        id: row.id,
        role: row.role as "user" | "assistant",
        content: row.content,
      }))
    : [];

  const userLabel = user.email?.split("@")[0] ?? "there";

  return (
    <ChatView
      // Keyed by conversation so switching chats remounts with the right
      // history. ChatView seeds its message state from initialMessages via
      // useState, which only reads its argument on mount — without this key
      // React can reuse the instance across a switch and keep rendering the
      // previous conversation's messages.
      key={id}
      userLabel={userLabel}
      conversationId={id}
      initialMessages={initialMessages}
    />
  );
}
