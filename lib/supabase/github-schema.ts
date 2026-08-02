/**
 * Schema type for the GitHub connection table. Mixed into `UsageDatabase`
 * (./usage-schema.ts) because it shares the one service-role client; kept in
 * its own file because it belongs to a different feature and a different
 * migration — the same split billing-schema.ts uses.
 *
 * Keep in sync with supabase/migrations/20260801040000_github_connections.sql.
 */

export type GitHubConnectionRow = {
  user_id: string;
  github_username: string;
  /**
   * GitHub's immutable numeric account id. This, not the login, is what
   * ownership checks compare against — logins can be renamed, and a renamed
   * login is otherwise free to be claimed by somebody else.
   */
  github_user_id: number;
  /**
   * The OAuth access token. Present in this type because the service-role
   * client reads it; the `authenticated` role has no SELECT privilege on the
   * column at all, so it cannot be read with a user's own client.
   */
  access_token: string;
  connected_at: string;
  updated_at: string;
};

/** What a client is ever allowed to learn about a connection. */
export type GitHubConnectionSummary = {
  connected: boolean;
  username: string | null;
  /**
   * Whether the Supabase account already has a linked GitHub identity. The
   * connect button branches on it: an account with no GitHub identity links
   * one, an account that has one but no stored token has to re-authorize to
   * mint a fresh `provider_token`.
   */
  hasGitHubIdentity: boolean;
};

export type GitHubTables = {
  github_connections: {
    Row: GitHubConnectionRow;
    Insert: Omit<GitHubConnectionRow, "connected_at" | "updated_at"> &
      Partial<Pick<GitHubConnectionRow, "connected_at" | "updated_at">>;
    Update: Partial<GitHubConnectionRow>;
    Relationships: [];
  };
};
