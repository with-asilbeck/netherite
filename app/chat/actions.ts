"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { insertNewConversation } from "@/lib/conversations";

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
