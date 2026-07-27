import { nanoid } from "nanoid";
import type { createClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

// Conversation ids are nanoid() tokens: 21 chars, URL-safe alphabet.
export const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{21}$/;

export type CreateConversationResult = { id: string } | { error: string };

export async function insertNewConversation(
  supabase: SupabaseServerClient,
  userId: string,
): Promise<CreateConversationResult> {
  const id = nanoid();

  const { error } = await supabase.from("conversations").insert({
    id,
    user_id: userId,
  });

  if (error) {
    console.error("[chat] Supabase insert (conversation) failed:", error);
    return { error: "Couldn't start a new chat. Please try again." };
  }

  return { id };
}
