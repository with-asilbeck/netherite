import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { CHAT_APP_PATH } from "@/lib/chat-entry";

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

  // Always a fresh draft, never the most recent conversation — and never a
  // newly created one. Signing in no longer writes anything.
  return NextResponse.redirect(`${origin}${CHAT_APP_PATH}`);
}
