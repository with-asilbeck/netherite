import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveChatEntryPath } from "@/lib/chat-entry";

export default async function ChatIndexPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const result = await resolveChatEntryPath(supabase, user.id);

  if ("error" in result) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {result.error}
      </div>
    );
  }

  redirect(result.path);
}
