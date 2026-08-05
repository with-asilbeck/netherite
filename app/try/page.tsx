import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CHAT_APP_PATH } from "@/lib/chat-entry";
import { ChatView } from "@/app/chat/chat-view";
import { GuestBanner } from "@/components/guest-banner";

export const metadata: Metadata = {
  title: "Try Netherite — AI Security Advisor",
  description:
    "Chat with the Netherite security advisor without an account. Sign in anytime to save your conversation.",
};

export default async function TryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Already signed in — guest mode doesn't apply, so send them to the real,
  // persisted chat: a fresh draft, with their history in the sidebar.
  if (user) {
    redirect(CHAT_APP_PATH);
  }

  return (
    <div
      className="flex h-screen w-full flex-col bg-background font-sans"
    >
      <header className="flex shrink-0 items-center px-6 py-5 sm:px-14">
        <Link href="/" className="flex items-center gap-3">
          <Image
            src="/netherite-mark.png"
            alt="Netherite"
            width={28}
            height={28}
            className="h-7 w-7 object-contain dark:invert"
          />
          <span className="text-[28px] text-foreground leading-none translate-y-[0.11em] font-brand">
            NETHERITE
          </span>
        </Link>
      </header>

      <main className="min-h-0 flex-1">
        <ChatView userLabel="there" banner={<GuestBanner />} />
      </main>
    </div>
  );
}
