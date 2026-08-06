/**
 * Schema types for the three private-scanning tables. Mixed into
 * `UsageDatabase` (./usage-schema.ts) because they share the one service-role
 * client; kept in their own file for the same reason github-schema.ts and
 * billing-schema.ts are — a different feature and a different migration.
 *
 * Keep in sync with
 * supabase/migrations/20260807000000_private_repo_scanning.sql.
 *
 * There is deliberately no token column in any of these types, because there
 * is none in the tables. Installation access tokens are minted per scan and
 * never persisted — see lib/github/app.ts.
 */

export type GitHubAppInstallationRow = {
  user_id: string;
  /** GitHub's numeric installation id. Useless without the App private key. */
  installation_id: number;
  account_login: string;
  /** Immutable numeric account id, which is what ownership is compared on. */
  account_id: number;
  installed_at: string;
  updated_at: string;
};

export type PrivateScanConsentRow = {
  user_id: string;
  consent_given_at: string;
  /**
   * Which version of the terms was agreed to. A stored version below
   * PRIVATE_SCAN_CONSENT_VERSION is treated as no consent at all.
   */
  consent_version: number;
  /** Dispute-resolution context. Not SELECT-able by the authenticated role. */
  user_agent: string | null;
  ip_address: string | null;
};

export type PrivateScanAuditRow = {
  id: string;
  user_id: string;
  repo_full_name: string;
  installation_id: number;
  scanned_at: string;
  outcome: "started" | "completed" | "failed";
  usage_event_id: string | null;
};

export type PrivateScanTables = {
  github_app_installations: {
    Row: GitHubAppInstallationRow;
    Insert: Omit<GitHubAppInstallationRow, "installed_at" | "updated_at"> &
      Partial<Pick<GitHubAppInstallationRow, "installed_at" | "updated_at">>;
    Update: Partial<GitHubAppInstallationRow>;
    Relationships: [];
  };
  private_scan_consents: {
    Row: PrivateScanConsentRow;
    Insert: Omit<PrivateScanConsentRow, "consent_given_at"> &
      Partial<Pick<PrivateScanConsentRow, "consent_given_at">>;
    Update: Partial<PrivateScanConsentRow>;
    Relationships: [];
  };
  private_scan_audit: {
    Row: PrivateScanAuditRow;
    Insert: Omit<PrivateScanAuditRow, "id" | "scanned_at"> &
      Partial<Pick<PrivateScanAuditRow, "id" | "scanned_at">>;
    Update: Partial<PrivateScanAuditRow>;
    Relationships: [];
  };
};
