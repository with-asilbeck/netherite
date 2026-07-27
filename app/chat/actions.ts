"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CONVERSATION_ID_RE, insertNewConversation } from "@/lib/conversations";

const MAX_TITLE_LENGTH = 200;
const GENERIC_ERROR = "Something went wrong. Please try again.";

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export type CreateConversationState = { error?: string };

export async function createConversationAction(
  _prevState: CreateConversationState,
): Promise<CreateConversationState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const result = await insertNewConversation(supabase, user.id);
  if ("error" in result) {
    return { error: result.error };
  }

  redirect(`/chat/${result.id}`);
}

export type DeleteConversationResult = { error?: string };

export async function deleteConversationAction(
  conversationId: string,
): Promise<DeleteConversationResult> {
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    return { error: "Invalid conversation." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Explicit ownership check — never rely on RLS as the only safeguard.
  const { data: conversation, error: fetchError } = await supabase
    .from("conversations")
    .select("id, user_id")
    .eq("id", conversationId)
    .maybeSingle();

  if (fetchError) {
    console.error("[chat] Supabase select (conversation ownership check) failed:", fetchError);
    return { error: GENERIC_ERROR };
  }

  if (!conversation) {
    // Already deleted (or never existed) — deleting is idempotent, so this
    // is a success, not an error. Prevents a crash on double-delete.
    return {};
  }

  if (conversation.user_id !== user.id) {
    // Same generic error as any other failure — never reveal that the id
    // belongs to a different user.
    return { error: GENERIC_ERROR };
  }

  // Messages are cleaned up via ON DELETE CASCADE (chat_messages.conversation_id
  // references conversations.id on delete cascade) — no separate delete needed,
  // and chat_messages has no delete RLS policy of its own to run one against.
  const { error: deleteError } = await supabase
    .from("conversations")
    .delete()
    .eq("id", conversationId)
    .eq("user_id", user.id); // belt-and-suspenders alongside the check above

  if (deleteError) {
    console.error("[chat] Supabase delete (conversation) failed:", deleteError);
    return { error: GENERIC_ERROR };
  }

  return {};
}

export type RenameConversationResult = { error?: string; title?: string };

export async function renameConversationAction(
  conversationId: string,
  title: string,
): Promise<RenameConversationResult> {
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    return { error: "Invalid conversation." };
  }

  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LENGTH) {
    return { error: `Title must be between 1 and ${MAX_TITLE_LENGTH} characters.` };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Explicit ownership check — never rely on RLS as the only safeguard.
  const { data: conversation, error: fetchError } = await supabase
    .from("conversations")
    .select("id, user_id")
    .eq("id", conversationId)
    .maybeSingle();

  if (fetchError) {
    console.error("[chat] Supabase select (conversation ownership check) failed:", fetchError);
    return { error: GENERIC_ERROR };
  }

  if (!conversation || conversation.user_id !== user.id) {
    // Same generic error whether it's missing or owned by someone else.
    return { error: GENERIC_ERROR };
  }

  const { error: updateError } = await supabase
    .from("conversations")
    .update({ title: trimmed })
    .eq("id", conversationId)
    .eq("user_id", user.id); // belt-and-suspenders alongside the check above

  if (updateError) {
    console.error("[chat] Supabase update (conversation title) failed:", updateError);
    return { error: GENERIC_ERROR };
  }

  return { title: trimmed };
}
