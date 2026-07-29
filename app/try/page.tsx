import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { inter } from "@/lib/fonts";
import { createClient } from "@/lib/supabase/server";
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

  // Already signed in — guest mode doesn't apply, send them to their real,
  // persisted chat instead.
  if (user) {
    redirect("/chat");
  }

  return (
    <div
      className={`${inter.variable} flex h-screen w-full flex-col bg-background font-sans`}
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
          <span className="text-base font-semibold tracking-tight text-foreground">
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
