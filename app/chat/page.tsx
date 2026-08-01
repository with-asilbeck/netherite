import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ChatView } from "@/app/chat/chat-view";

/**
 * The draft chat: an empty chat UI with no conversation id, no database row
 * and no token behind it. This is where logging in lands, and where "New
 * chat" goes.
 *
 * It used to redirect to the most recent conversation, creating one first if
 * there were none — so signing in wrote a row whether or not the user went on
 * to say anything. Nothing here touches the database: the conversation is
 * created by the first message the user sends (app/api/chat/route.ts).
 */
export default async function ChatIndexPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const userLabel = user.email?.split("@")[0] ?? "there";

  return <ChatView userLabel={userLabel} userId={user.id} />;
}
