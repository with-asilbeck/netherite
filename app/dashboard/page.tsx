import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div>
      <div className="mb-4 text-sm font-medium text-[oklch(0.45_0_0)]">
        Dashboard
      </div>
      <h1 className="m-0 text-[clamp(28px,4vw,44px)] font-semibold tracking-[-0.02em]">
        You&apos;re signed in
      </h1>
      <p className="mt-6 text-lg leading-[1.6] text-[oklch(0.4_0_0)]">
        Signed in as{" "}
        <span className="font-medium text-[oklch(0.15_0_0)]">
          {user.email}
        </span>
      </p>
    </div>
  );
}
