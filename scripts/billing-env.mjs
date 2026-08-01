// Shared plumbing for the billing verification scripts: reads .env.local,
// talks to Supabase over REST with the service-role key, and keeps a tally
// of assertions.
//
// These scripts run against the *real* Supabase project and the *real*
// Lemon Squeezy test-mode store. Nothing here is mocked — that is the
// point of them. Every row they create is namespaced to a throwaway auth
// user and removed at the end.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = join(here, "..");

/** Minimal .env parser — no dotenv dependency for a script. */
export function loadEnv() {
  const raw = readFileSync(join(projectRoot, ".env.local"), "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

export const env = loadEnv();

export const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
export const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

const serviceHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

/** PostgREST select. Returns an array of rows. */
export async function selectRows(table, query = "") {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: serviceHeaders,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`select ${table} failed (${response.status}): ${text}`);
  }
  return JSON.parse(text);
}

export async function deleteRows(table, query) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: "DELETE",
    headers: serviceHeaders,
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`delete ${table} failed (${response.status}): ${await response.text()}`);
  }
}

/** Supabase Auth admin API — used to make and remove the throwaway user. */
export async function createAuthUser(email) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: serviceHeaders,
    body: JSON.stringify({ email, email_confirm: true }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`create user failed: ${JSON.stringify(body)}`);
  return body.id;
}

export async function deleteAuthUser(userId) {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: serviceHeaders,
  });
}

// ── Assertions ──────────────────────────────────────────────────────────

let passed = 0;
const failures = [];

export function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  [32mPASS[0m ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(name);
    console.log(`  [31mFAIL[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

export function checkEqual(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Timestamps come back from PostgREST in a different format than they go in. */
export function checkSameInstant(name, actual, expected) {
  const a = actual ? new Date(actual).getTime() : null;
  const b = expected ? new Date(expected).getTime() : null;
  check(name, a === b, `expected ${expected}, got ${actual}`);
}

export function section(title) {
  console.log(`\n[1m${title}[0m`);
}

export function summarise() {
  console.log(`\n${"─".repeat(60)}`);
  if (failures.length === 0) {
    console.log(`[32mAll ${passed} assertions passed.[0m`);
    return 0;
  }
  console.log(`[31m${failures.length} failed[0m, ${passed} passed:`);
  for (const failure of failures) console.log(`  - ${failure}`);
  return 1;
}
