/**
 * Storage for GitHub OAuth connections.
 *
 * Every function here runs under the service-role client, because the
 * `authenticated` role deliberately cannot write this table and cannot read
 * the token column at all (see the migration). That makes this module the
 * only door to a stored token, and it is a server-side one:
 * lib/supabase/admin.ts throws at import time if it is ever bundled for the
 * browser.
 *
 * Note the split between `getGitHubConnection` and
 * `getGitHubConnectionSummary`. The first returns the token and is for the
 * verifier; the second returns what a browser may know and is what the API
 * route serves. Keeping them as two functions rather than one with a flag
 * means a route cannot accidentally serve the token by passing the wrong
 * argument — the shape it gets back simply doesn't contain one.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type {
  GitHubConnectionRow,
  GitHubConnectionSummary,
} from "@/lib/supabase/github-schema";

export type StoredGitHubConnection = {
  userId: string;
  githubUsername: string;
  githubUserId: number;
  accessToken: string;
};

/**
 * The full row, token included. Server-side callers only — the return value
 * of this function must never be spread into a Response.
 */
export async function getGitHubConnection(
  userId: string,
): Promise<StoredGitHubConnection | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("github_connections")
    .select("user_id, github_username, github_user_id, access_token")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[github] couldn't read the connection:", error);
    return null;
  }
  if (!data) return null;

  const row = data as Pick<
    GitHubConnectionRow,
    "user_id" | "github_username" | "github_user_id" | "access_token"
  >;

  return {
    userId: row.user_id,
    githubUsername: row.github_username,
    githubUserId: row.github_user_id,
    accessToken: row.access_token,
  };
}

/** What the browser is allowed to know. No token in the return type. */
export async function getGitHubConnectionSummary(
  userId: string,
  hasGitHubIdentity: boolean,
): Promise<GitHubConnectionSummary> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("github_connections")
    .select("github_username")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[github] couldn't read the connection summary:", error);
    return { connected: false, username: null, hasGitHubIdentity };
  }

  const username = (data as { github_username: string } | null)?.github_username ?? null;
  return { connected: Boolean(username), username, hasGitHubIdentity };
}

/**
 * Upserts the connection after a completed OAuth exchange.
 *
 * The caller must already have verified that `accessToken` really belongs to
 * `githubUserId` by calling GitHub with it — see the callback route. This
 * function does not re-check, so it must not be called with a token that
 * merely arrived alongside a claim about whose it is.
 */
export async function saveGitHubConnection(connection: StoredGitHubConnection): Promise<boolean> {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { error } = await admin.from("github_connections").upsert(
    {
      user_id: connection.userId,
      github_username: connection.githubUsername,
      github_user_id: connection.githubUserId,
      access_token: connection.accessToken,
      connected_at: now,
      updated_at: now,
    },
    { onConflict: "user_id" },
  );

  if (error) {
    console.error("[github] couldn't save the connection:", error);
    return false;
  }
  return true;
}

/**
 * Removes the stored connection.
 *
 * Called both when a user disconnects and when GitHub tells us the token is
 * dead (401). Deleting on 401 is what turns "your token expired" into a
 * recoverable state: the next request sees no connection and the UI offers
 * to reconnect, instead of retrying a credential that will never work again.
 */
export async function deleteGitHubConnection(userId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("github_connections").delete().eq("user_id", userId);
  if (error) {
    console.error("[github] couldn't delete the connection:", error);
  }
}
