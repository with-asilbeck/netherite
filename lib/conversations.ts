import { nanoid } from "nanoid";
// Type-only, and it must stay that way: this module is imported by client
// components, and lib/supabase/server.ts reaches for next/headers at runtime.
import type { createClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

// Conversation ids are nanoid() tokens: 21 chars, URL-safe alphabet. The same
// shape is re-checked inside create_conversation_with_message()
// (supabase/migrations/20260801000000_...), since conversations.id is plain
// text and would otherwise accept anything.
export const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{21}$/;

export const TITLE_TRUNCATE_LENGTH = 40;

function truncate(text: string, length: number) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > length ? `${trimmed.slice(0, length).trimEnd()}…` : trimmed;
}

/**
 * The label a conversation gets in the Recents list: its title if it has been
 * renamed, otherwise the opening words of the first message.
 *
 * Shared by the server-rendered sidebar and the client, which adds a row the
 * moment a draft becomes a real conversation — they have to agree, or a
 * freshly created chat would visibly rename itself on the next page load.
 */
export function conversationLabel(
  title: string | null | undefined,
  firstMessage: string | null | undefined,
): string {
  const trimmedTitle = title?.trim();
  if (trimmedTitle) return truncate(trimmedTitle, TITLE_TRUNCATE_LENGTH);

  const trimmedMessage = firstMessage?.trim();
  if (trimmedMessage) return truncate(trimmedMessage, TITLE_TRUNCATE_LENGTH);

  // Only reachable for a conversation with no messages, which the Recents
  // query filters out — kept so the type stays a plain string.
  return "New chat";
}

export type CreateConversationResult = { id: string } | { error: string };

/**
 * Creates a conversation and its first message together, as one transaction.
 *
 * This is the only way a conversations row is created. Nothing creates one on
 * login or on "New chat" any more: a draft chat has no id and no row until
 * the user actually sends something, which is what keeps Recents free of
 * empty conversations.
 *
 * Both rows are written by create_conversation_with_message(), a plpgsql
 * function running as the caller — see the migration for why it isn't two
 * inserts from here. The user id is taken from auth.uid() inside the
 * function, never passed in, so the caller can't attribute a conversation to
 * anyone else.
 */
export async function createConversationWithFirstMessage(
  supabase: SupabaseServerClient,
  content: string,
): Promise<CreateConversationResult> {
  const id = nanoid();

  const { error } = await supabase.rpc("create_conversation_with_message", {
    p_conversation_id: id,
    p_content: content,
  });

  if (error) {
    console.error("[chat] create_conversation_with_message failed:", error);
    return { error: "Couldn't start a new chat. Please try again." };
  }

  return { id };
}
