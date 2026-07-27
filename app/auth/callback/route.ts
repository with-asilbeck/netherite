import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { insertNewConversation } from "@/lib/conversations";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const providerError = searchParams.get("error");

  if (providerError) {
    return NextResponse.redirect(`${origin}/login?error=access_denied`);
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=no_code`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }

  // Explicit ownership filter alongside RLS — never rely on RLS alone.
  const { data: recentConversations, error: fetchError } = await supabase
    .from("conversations")
    .select("id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1);

  if (fetchError) {
    console.error("[auth/callback] Supabase select (conversations) failed:", fetchError);
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }

  if (recentConversations && recentConversations.length > 0) {
    return NextResponse.redirect(`${origin}/chat/${recentConversations[0].id}`);
  }

  const result = await insertNewConversation(supabase, user.id);
  if ("error" in result) {
    console.error("[auth/callback] Failed to create first conversation:", result.error);
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }

  return NextResponse.redirect(`${origin}/chat/${result.id}`);
}
