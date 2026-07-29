import { nanoid } from "nanoid";
import type { createClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

// Conversation ids are nanoid() tokens: 21 chars, URL-safe alphabet.
export const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{21}$/;

/**
 * Mints a conversation id without touching the database.
 *
 * Safe to call from the browser: ids are opaque, unguessable routing tokens,
 * never an authorization claim. Holding one grants nothing — every read and
 * write is still gated by RLS on `conversations.user_id = auth.uid()`. This
 * is what lets "New chat" navigate on the click itself instead of waiting
 * out a server round trip for an insert.
 */
export function newConversationId() {
  return nanoid();
}

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

/**
 * Creates the conversation row for a client-minted id, idempotently.
 *
 * Called on the first message of a new chat rather than when "New chat" is
 * clicked, so the click costs no network at all. Re-sending into an existing
 * conversation is a no-op.
 *
 * `ignoreDuplicates` makes this `INSERT ... ON CONFLICT DO NOTHING`, which is
 * what keeps it safe: a colliding id belonging to another user is left
 * completely untouched — there's no UPDATE path, so this can never reassign
 * an existing conversation's owner. The caller must still not treat success
 * here as proof of ownership; the authority on that is the RLS policy on the
 * subsequent chat_messages insert, which joins to conversations.user_id.
 */
export async function ensureConversation(
  supabase: SupabaseServerClient,
  userId: string,
  conversationId: string,
): Promise<{ error?: string }> {
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    return { error: "Invalid conversation." };
  }

  const { error } = await supabase
    .from("conversations")
    .upsert(
      { id: conversationId, user_id: userId },
      { onConflict: "id", ignoreDuplicates: true },
    );

  if (error) {
    console.error("[chat] Supabase upsert (conversation) failed:", error);
    return { error: "Couldn't start a new chat. Please try again." };
  }

  return {};
}
