import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ChatView } from "@/app/chat/chat-view";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // RLS scopes this to auth.uid() = user_id — a conversation that exists but
  // belongs to someone else comes back as no row, same as one that doesn't
  // exist at all. That's intentional: it never reveals which case it is.
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .maybeSingle();

  if (!conversation) {
    notFound();
  }

  const { data: messageRows } = await supabase
    .from("chat_messages")
    .select("id, role, content")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });

  const initialMessages = (messageRows ?? []).map((row) => ({
    id: row.id,
    role: row.role as "user" | "assistant",
    content: row.content,
  }));

  const userLabel = user.email?.split("@")[0] ?? "there";

  return (
    <ChatView
      userLabel={userLabel}
      conversationId={id}
      initialMessages={initialMessages}
    />
  );
}
