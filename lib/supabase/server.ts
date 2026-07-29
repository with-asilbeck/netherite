import { cache } from "react";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component — safe to ignore because the
            // proxy (proxy.ts) refreshes the session on every request.
          }
        },
      },
    },
  );
}

/**
 * `supabase.auth.getUser()` is a network round trip to the Supabase auth
 * server on every call — it validates the JWT remotely rather than decoding
 * it locally (that's `getSession()`, which we deliberately don't use here).
 *
 * A single chat navigation renders both `app/chat/layout.tsx` and
 * `app/chat/[id]/page.tsx`, and each used to call it independently, paying
 * that round trip twice for the exact same answer. React's `cache()` dedupes
 * them per render pass, so the auth server is hit once per request instead.
 *
 * This is purely a de-duplication — the check itself is unchanged and still
 * runs server-side on every request. Callers must keep handling `null`.
 */
export const getCachedUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});
