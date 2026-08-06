/**
 * Storage for everything private scanning needs to remember: the App
 * installation, the consent, and the audit trail.
 *
 * Service-role only, for the same reason lib/github/connection.ts is: the
 * `authenticated` role has no insert, update or delete policy on any of these
 * three tables, so this module is the only door. lib/supabase/admin.ts throws
 * at import time if it is ever bundled for the browser.
 *
 * Note what is *not* here: any function that writes an installation access
 * token. There is no column for one and no code path that could. Tokens are
 * minted per scan in lib/github/app.ts and dropped when the clone ends.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { PRIVATE_SCAN_CONSENT_VERSION } from "./consent";

export type StoredInstallation = {
  userId: string;
  installationId: number;
  accountLogin: string;
  accountId: number;
  installedAt: string;
};

export async function getInstallation(userId: string): Promise<StoredInstallation | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("github_app_installations")
    .select("user_id, installation_id, account_login, account_id, installed_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[private-scan] couldn't read the installation:", error);
    return null;
  }
  if (!data) return null;

  const row = data as {
    user_id: string;
    installation_id: number;
    account_login: string;
    account_id: number;
    installed_at: string;
  };
  return {
    userId: row.user_id,
    installationId: row.installation_id,
    accountLogin: row.account_login,
    accountId: row.account_id,
    installedAt: row.installed_at,
  };
}

/**
 * Records a completed installation.
 *
 * The caller must already have verified with GitHub that this installation
 * belongs to the session user's own GitHub account — see the callback route.
 * This function does not re-check, so it must never be called with an
 * installation id that merely arrived in a query string.
 */
export async function saveInstallation(
  installation: Omit<StoredInstallation, "installedAt">,
): Promise<boolean> {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { error } = await admin.from("github_app_installations").upsert(
    {
      user_id: installation.userId,
      installation_id: installation.installationId,
      account_login: installation.accountLogin,
      account_id: installation.accountId,
      installed_at: now,
      updated_at: now,
    },
    { onConflict: "user_id" },
  );

  if (error) {
    console.error("[private-scan] couldn't save the installation:", error);
    return false;
  }
  return true;
}

export async function deleteInstallation(userId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("github_app_installations").delete().eq("user_id", userId);
  if (error) console.error("[private-scan] couldn't delete the installation:", error);
}

// ── Consent ────────────────────────────────────────────────────────────

export type StoredConsent = {
  consentGivenAt: string;
  consentVersion: number;
};

export async function getConsent(userId: string): Promise<StoredConsent | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("private_scan_consents")
    .select("consent_given_at, consent_version")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[private-scan] couldn't read consent:", error);
    return null;
  }
  if (!data) return null;

  const row = data as { consent_given_at: string; consent_version: number };
  return { consentGivenAt: row.consent_given_at, consentVersion: row.consent_version };
}

/**
 * Whether this user has agreed to the terms **as they currently stand**.
 *
 * Version-aware on purpose: a consent recorded against version 1 is not
 * consent to version 2, and the version is bumped whenever the meaning
 * changes — including when the Gemini billing tier changes what the user is
 * being told. An out-of-date consent is treated exactly like no consent.
 *
 * Fails closed. A read error returns false, which re-asks — annoying, and the
 * right direction.
 */
export async function hasCurrentConsent(userId: string): Promise<boolean> {
  const consent = await getConsent(userId);
  return consent !== null && consent.consentVersion >= PRIVATE_SCAN_CONSENT_VERSION;
}

export async function saveConsent(
  userId: string,
  context: { userAgent: string | null; ipAddress: string | null },
): Promise<boolean> {
  const admin = createAdminClient();
  const { error } = await admin.from("private_scan_consents").upsert(
    {
      user_id: userId,
      consent_given_at: new Date().toISOString(),
      consent_version: PRIVATE_SCAN_CONSENT_VERSION,
      user_agent: context.userAgent,
      ip_address: context.ipAddress,
    },
    { onConflict: "user_id" },
  );

  if (error) {
    console.error("[private-scan] couldn't save consent:", error);
    return false;
  }
  return true;
}

export async function revokeConsent(userId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("private_scan_consents").delete().eq("user_id", userId);
  if (error) console.error("[private-scan] couldn't revoke consent:", error);
}

// ── Audit ──────────────────────────────────────────────────────────────

export type ScanOutcome = "started" | "completed" | "failed";

/**
 * Records that a private repository was accessed.
 *
 * Deliberately separate from the scan report: the report is a product the
 * user reads and can delete along with the conversation, while this is a
 * record of access that has to survive that. Written *before* the clone, with
 * outcome `started`, so a scan that crashes the process still leaves evidence
 * that the code was pulled.
 *
 * Returns the row id so the outcome can be settled later. A failure to write
 * the audit row is fatal to the scan by design — see the call site. An
 * unlogged private clone is exactly what this table exists to prevent.
 */
export async function recordPrivateScanStarted(entry: {
  userId: string;
  repoFullName: string;
  installationId: number;
  usageEventId: string | null;
}): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("private_scan_audit")
    .insert({
      user_id: entry.userId,
      repo_full_name: entry.repoFullName,
      installation_id: entry.installationId,
      outcome: "started",
      usage_event_id: entry.usageEventId,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[private-scan] couldn't write the audit row:", error);
    return null;
  }
  return (data as { id: string }).id;
}

/** Settles an audit row once the scan ends. Best-effort: the `started` row is
 *  already the durable record, and an unsettled one is readable as a crash. */
export async function settlePrivateScanAudit(
  auditId: string,
  outcome: Exclude<ScanOutcome, "started">,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("private_scan_audit")
    .update({ outcome })
    .eq("id", auditId);
  if (error) console.error("[private-scan] couldn't settle the audit row:", error);
}
