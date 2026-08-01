// Proves the join between billing and the usage caps: that the resolver
// — the function every metered route calls before spending money on an LLM
// — reads the `subscriptions` table and honours its status.
//
// The entitlement suite tests the rules in isolation and the webhook suite
// tests what lands in the database. This is the seam between them, and it
// runs the real lib/get-user-tier.ts against the real database.
//
//   node scripts/billing-enforcement-test.mjs

import { register } from "node:module";

import {
  check,
  createAuthUser,
  deleteAuthUser,
  deleteRows,
  env,
  section,
  summarise,
  SUPABASE_URL,
  SERVICE_KEY,
} from "./billing-env.mjs";

for (const [key, value] of Object.entries(env)) process.env[key] ??= value;

register("./ts-alias-hook.mjs", import.meta.url);

// The uncached resolver: this script has no React request scope, and each
// assertion below deliberately wants a fresh read after changing the row.
const { resolveUserTier } = await import("../lib/get-user-tier.ts");
const { TIER_LIMITS } = await import("../lib/usage/tiers.ts");

const service = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "resolution=merge-duplicates",
};

let userId = null;

const future = new Date(Date.now() + 30 * 86400_000).toISOString();
const past = new Date(Date.now() - 30 * 86400_000).toISOString();
const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString();

async function upsertSubscription(fields) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions`, {
    method: "POST",
    headers: service,
    body: JSON.stringify({
      user_id: userId,
      lemonsqueezy_subscription_id: `sub_enf_${userId.slice(0, 8)}`,
      billing_period: "monthly",
      ...fields,
    }),
  });
  if (!response.ok) throw new Error(`upsert failed: ${await response.text()}`);
}

async function setOverride(tier) {
  await fetch(`${SUPABASE_URL}/rest/v1/user_tiers`, {
    method: "POST",
    headers: service,
    body: JSON.stringify({ user_id: userId, tier }),
  });
}

async function expectTier(label, expected) {
  const { tier: actual } = await resolveUserTier(userId);
  check(label, actual === expected, `expected ${expected}, got ${actual}`);
  return actual;
}

async function main() {
  userId = await createAuthUser(`enforcement-probe-${Date.now()}@netherite-verify.invalid`);
  console.log(`Throwaway user: ${userId}\n`);

  section("the resolver reads the subscriptions table");

  await expectTier("a user with no subscription row is free", "free");

  await upsertSubscription({ tier: "pro", status: "active", current_period_end: future });
  await expectTier("an active pro subscription grants pro", "pro");

  await upsertSubscription({ tier: "max", status: "active", current_period_end: future });
  await expectTier("upgrading the row grants max", "max");

  section("status gates access, not just the tier column");

  await upsertSubscription({ tier: "max", status: "cancelled", current_period_end: future });
  await expectTier("cancelled but still inside the period keeps max", "max");

  await upsertSubscription({ tier: "max", status: "cancelled", current_period_end: past });
  await expectTier("cancelled and past the period drops to free", "free");

  // `past` is 30 days ago, which is well outside the 8-day grace window —
  // so the two past_due cases need different dates. Getting this wrong is
  // what made this assertion fail the first time it ran.
  await upsertSubscription({ tier: "max", status: "past_due", current_period_end: twoDaysAgo });
  await expectTier("past_due inside the grace window keeps max", "max");

  await upsertSubscription({ tier: "max", status: "past_due", current_period_end: past });
  await expectTier("past_due long past the grace window drops to free", "free");

  await upsertSubscription({ tier: "max", status: "expired", current_period_end: future });
  await expectTier("expired is free even with time left on the clock", "free");

  await upsertSubscription({ tier: "max", status: "refunded", current_period_end: future });
  await expectTier("refunded is free immediately", "free");

  section("the caps that follow from it");

  await upsertSubscription({ tier: "basic", status: "active", current_period_end: future });
  const { tier: basic } = await resolveUserTier(userId);
  check(
    "a basic subscriber gets basic repo-scan caps, not free ones",
    TIER_LIMITS[basic].repo_scan === TIER_LIMITS.basic.repo_scan &&
      TIER_LIMITS[basic].repo_scan !== TIER_LIMITS.free.repo_scan,
    `repo_scan=${TIER_LIMITS[basic].repo_scan} (free is ${TIER_LIMITS.free.repo_scan})`,
  );

  section("the user_tiers override may only raise");

  await setOverride("max");
  await expectTier("a comped override raises basic to max", "max");

  await upsertSubscription({ tier: "pro", status: "active", current_period_end: future });
  await setOverride("free");
  await expectTier("a stale free override cannot demote a paying pro user", "pro");

  await deleteRows("subscriptions", `user_id=eq.${userId}`);
  await setOverride("pro");
  await expectTier("an override alone still works with no subscription", "pro");
}

const exitCode = await main()
  .then(() => summarise())
  .catch((err) => {
    console.error("\nHarness error:", err);
    return 1;
  })
  .finally(async () => {
    if (userId) {
      await deleteAuthUser(userId);
      console.log(`\nCleaned up throwaway user ${userId}.`);
    }
  });

process.exit(exitCode);
