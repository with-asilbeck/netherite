import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { UsageDatabase } from "./usage-schema";

/**
 * Service-role Supabase client. Bypasses RLS entirely, so it exists for
 * exactly one reason: writing rows that the user themselves must not be
 * able to write — the usage ledger and tier assignments.
 *
 * Never import this from a client component. Three things keep it off the
 * browser:
 *   1. `SUPABASE_SERVICE_ROLE_KEY` has no `NEXT_PUBLIC_` prefix, so Next
 *      never inlines it into a client bundle — it would be `undefined`
 *      there even if the import slipped through.
 *   2. The `typeof window` guard below turns that silent `undefined` into
 *      a loud throw at module scope.
 *   3. Callers are route handlers and server components only.
 *
 * CLAUDE.md's rule — service_role keys are server-side only — is what all
 * three are enforcing.
 */
if (typeof window !== "undefined") {
  throw new Error(
    "lib/supabase/admin.ts was imported in the browser. It holds the service-role key and must stay server-side.",
  );
}

let cached: ReturnType<typeof createSupabaseClient<UsageDatabase>> | null = null;

export function createAdminClient() {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    // Fails loudly rather than degrading: callers use this to enforce
    // spending limits, and a silently missing client would mean either
    // unmetered LLM calls or a confusing generic 500.
    throw new Error(
      "Usage tracking isn't configured — SUPABASE_SERVICE_ROLE_KEY (and NEXT_PUBLIC_SUPABASE_URL) must be set.",
    );
  }

  cached = createSupabaseClient<UsageDatabase>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
