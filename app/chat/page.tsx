import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { insertNewConversation } from "@/lib/conversations";

export default async function ChatIndexPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const result = await insertNewConversation(supabase, user.id);

  if ("error" in result) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[oklch(0.4_0_0)]">
        {result.error}
      </div>
    );
  }

  redirect(`/chat/${result.id}`);
}
