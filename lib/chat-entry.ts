import type { createClient } from "@/lib/supabase/server";
import { insertNewConversation } from "@/lib/conversations";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Where every "start chatting" affordance on the marketing site points. Entry
 * points link here instead of branching on auth themselves — `/try` does the
 * check server-side, so no two entry points can drift apart.
 */
export const CHAT_ENTRY_PATH = "/try";

export type ChatEntryResult = { path: string } | { error: string };

/**
 * The single place that decides where a signed-in user lands when they enter
 * chat from outside it: their most recent conversation, or a freshly created
 * one if they have none. Used by `/try`, `/chat`, and the OAuth callback so
 * all three agree.
 */
export async function resolveChatEntryPath(
  supabase: SupabaseServerClient,
  userId: string,
): Promise<ChatEntryResult> {
  // Explicit ownership filter alongside RLS — never rely on RLS alone.
  const { data: recent, error } = await supabase
    .from("conversations")
    .select("id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("[chat-entry] Supabase select (conversations) failed:", error);
    return { error: "Couldn't open your chat. Please try again." };
  }

  if (recent && recent.length > 0) {
    return { path: `/chat/${recent[0].id}` };
  }

  const created = await insertNewConversation(supabase, userId);
  if ("error" in created) {
    return { error: created.error };
  }

  return { path: `/chat/${created.id}` };
}
