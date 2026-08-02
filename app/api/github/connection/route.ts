import { createClient } from "@/lib/supabase/server";
import {
  deleteGitHubConnection,
  getGitHubConnectionSummary,
} from "@/lib/github/connection";

// Connection status for the composer's "Attach GitHub repo" flow.
//
// The response shape is `GitHubConnectionSummary`, which has no token field
// — that is the point of it being a separate type from the stored row. The
// token column is additionally not readable by the `authenticated` role at
// all (see the migration), so even a future bug that selected `*` with the
// user's own client would get a permission error rather than a leak.

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Please log in." }, { status: 401 });
  }

  // Whether the Supabase account already has a GitHub identity decides which
  // button the client shows: link a new identity, or re-authorize an
  // existing one to mint a fresh provider_token.
  const hasGitHubIdentity = (user.identities ?? []).some(
    (identity) => identity.provider === "github",
  );

  const summary = await getGitHubConnectionSummary(user.id, hasGitHubIdentity);
  return Response.json(summary, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Please log in." }, { status: 401 });
  }

  // Only ever the caller's own row — the id comes from the verified session,
  // never from the request.
  await deleteGitHubConnection(user.id);
  return Response.json({ connected: false, username: null });
}
