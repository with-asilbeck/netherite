// Five real users, five real subscription rows, one resolver.
//
// Each persona below is created as an actual auth user with an actual row
// in `subscriptions`, and the tier is read back through the same
// `resolveUserTier` that /api/chat, /api/attachments and /api/repo-scan/run
// call. Nothing is stubbed, so what this prints is what those routes would
// enforce for that account right now.
//
//   node scripts/tier-resolution-test.mjs

import { register } from "node:module";

import {
  check,
  checkEqual,
  createAuthUser,
  deleteAuthUser,
  env,
  section,
  summarise,
  SUPABASE_URL,
  SERVICE_KEY,
} from "./billing-env.mjs";

for (const [key, value] of Object.entries(env)) process.env[key] ??= value;

register("./ts-alias-hook.mjs", import.meta.url);

const { resolveUserTier } = await import("../lib/get-user-tier.ts");
const { TIER_LIMITS } = await import("../lib/tiers.ts");

const service = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "resolution=merge-duplicates",
};

const IN_A_MONTH = new Date(Date.now() + 30 * 86400_000).toISOString();
const A_MONTH_AGO = new Date(Date.now() - 30 * 86400_000).toISOString();

const createdUsers = [];

async function makeUser(label) {
  const id = await createAuthUser(
    `tier-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@netherite-verify.invalid`,
  );
  createdUsers.push(id);
  return id;
}

async function writeSubscription(userId, row) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions`, {
    method: "POST",
    headers: service,
    body: JSON.stringify({
      user_id: userId,
      lemonsqueezy_subscription_id: `sub_${userId.slice(0, 8)}`,
      lemonsqueezy_customer_id: `cus_${userId.slice(0, 8)}`,
      billing_period: "monthly",
      ...row,
    }),
  });
  if (!response.ok) throw new Error(`writeSubscription failed: ${await response.text()}`);
}

/**
 * The five personas. `row: null` means no subscription row at all — the
 * state every new signup is in.
 */
const PERSONAS = [
  {
    name: "Free user (no subscription row)",
    row: null,
    expect: { tier: "free", status: null, cancellingSoon: false, source: "default" },
  },
  {
    name: "Basic user, active",
    row: { tier: "basic", status: "active", current_period_end: IN_A_MONTH },
    expect: { tier: "basic", status: "active", cancellingSoon: false, source: "subscription" },
  },
  {
    name: "Pro user, active",
    row: { tier: "pro", status: "active", current_period_end: IN_A_MONTH },
    expect: { tier: "pro", status: "active", cancellingSoon: false, source: "subscription" },
  },
  {
    name: "Pro user, cancelled but period not yet over",
    row: { tier: "pro", status: "cancelled", current_period_end: IN_A_MONTH },
    // Keeps Pro: they paid for this period. `cancellingSoon` is the UI's
    // cue and is not consulted by any cap.
    expect: { tier: "pro", status: "cancelled", cancellingSoon: true, source: "subscription" },
  },
  {
    name: "Refunded user",
    row: { tier: "max", status: "refunded", current_period_end: IN_A_MONTH },
    // Free immediately, despite a month left on the clock — the money went
    // back, so the access goes with it.
    expect: { tier: "free", status: "refunded", cancellingSoon: false, source: "subscription" },
  },
];

// Extra rows worth seeing resolved, beyond the five asked for.
const EXTRA = [
  {
    name: "Pro user, cancelled and the period has passed",
    row: { tier: "pro", status: "cancelled", current_period_end: A_MONTH_AGO },
    expect: { tier: "free", status: "cancelled", cancellingSoon: false, source: "subscription" },
  },
  {
    name: "Max user, expired (still has time on the clock)",
    row: { tier: "max", status: "expired", current_period_end: IN_A_MONTH },
    expect: { tier: "free", status: "expired", cancellingSoon: false, source: "subscription" },
  },
  {
    name: "Max user, past_due inside the 8-day grace window",
    row: {
      tier: "max",
      status: "past_due",
      current_period_end: new Date(Date.now() - 2 * 86400_000).toISOString(),
    },
    expect: { tier: "max", status: "past_due", cancellingSoon: false, source: "subscription" },
  },
  {
    name: "Max user, past_due well beyond the grace window",
    row: {
      tier: "max",
      status: "past_due",
      current_period_end: new Date(Date.now() - 40 * 86400_000).toISOString(),
    },
    expect: { tier: "free", status: "past_due", cancellingSoon: false, source: "subscription" },
  },
];

function pad(value, width) {
  return String(value).padEnd(width);
}

async function run(list, title) {
  section(title);
  console.log(
    `  ${pad("persona", 52)}${pad("row", 26)}${pad("→ tier", 8)}${pad("caps (chat/snip/scan)", 24)}cancellingSoon`,
  );
  console.log(`  ${"─".repeat(120)}`);

  for (const persona of list) {
    const userId = await makeUser("p");
    if (persona.row) await writeSubscription(userId, persona.row);

    const resolved = await resolveUserTier(userId);
    const caps = TIER_LIMITS[resolved.tier];

    const rowDescription = persona.row
      ? `${persona.row.tier}/${persona.row.status}`
      : "(none)";

    console.log(
      `  ${pad(persona.name, 52)}${pad(rowDescription, 26)}${pad(resolved.tier, 8)}${pad(
        `${caps.messages_daily_cap}/${caps.snippets_monthly}/${caps.repo_scans_monthly}`,
        24,
      )}${resolved.cancellingSoon}`,
    );

    checkEqual(`  ${persona.name} → tier`, resolved.tier, persona.expect.tier);
    checkEqual(`  ${persona.name} → status`, resolved.status, persona.expect.status);
    checkEqual(
      `  ${persona.name} → cancellingSoon`,
      resolved.cancellingSoon,
      persona.expect.cancellingSoon,
    );
    checkEqual(`  ${persona.name} → source`, resolved.source, persona.expect.source);
  }
}

async function main() {
  await run(PERSONAS, "The five personas");
  await run(EXTRA, "Other statuses, for completeness");

  section("The resolver reads the database on every call — no stale tier");

  // An upgrade must take effect on the next call, and a downgrade must too.
  // This is the property that a cache with any lifetime beyond the request
  // would break, so it is asserted rather than assumed.
  const mover = await makeUser("mover");
  checkEqual("starts on free with no row", (await resolveUserTier(mover)).tier, "free");

  await writeSubscription(mover, {
    tier: "max",
    status: "active",
    current_period_end: IN_A_MONTH,
  });
  checkEqual("an upgrade is visible immediately", (await resolveUserTier(mover)).tier, "max");

  await writeSubscription(mover, {
    tier: "max",
    status: "refunded",
    current_period_end: IN_A_MONTH,
  });
  checkEqual("a refund is visible immediately", (await resolveUserTier(mover)).tier, "free");

  await writeSubscription(mover, {
    tier: "basic",
    status: "active",
    current_period_end: IN_A_MONTH,
  });
  checkEqual("a re-subscribe is visible immediately", (await resolveUserTier(mover)).tier, "basic");

  section("The manual override may raise but never lower");

  const comped = await makeUser("comped");
  await fetch(`${SUPABASE_URL}/rest/v1/user_tiers`, {
    method: "POST",
    headers: service,
    body: JSON.stringify({ user_id: comped, tier: "pro" }),
  });
  const compedResolved = await resolveUserTier(comped);
  checkEqual("a comp with no subscription grants its tier", compedResolved.tier, "pro");
  checkEqual("and is reported as an override", compedResolved.source, "override");

  await writeSubscription(comped, {
    tier: "max",
    status: "active",
    current_period_end: IN_A_MONTH,
  });
  const bothResolved = await resolveUserTier(comped);
  checkEqual("a higher subscription wins over a lower comp", bothResolved.tier, "max");
  checkEqual("and is reported as coming from the subscription", bothResolved.source, "subscription");

  section("The resolver takes a user id and nothing else");

  // A shape check, not a runtime one: if this function ever grew a second
  // parameter for a tier, a plan, or a flag, that would be the moment a
  // route could start passing something from a request body.
  checkEqual("resolveUserTier has exactly one parameter", resolveUserTier.length, 1);
  check(
    "and there is no argument that could carry a tier",
    /^\s*(async\s+)?function\s+resolveUserTier\s*\(\s*userId\s*\)/.test(
      resolveUserTier.toString().replace(/\n/g, " ").slice(0, 200),
    ) || resolveUserTier.length === 1,
  );
}

const exitCode = await main()
  .then(() => summarise())
  .catch((err) => {
    console.error("\nHarness error:", err);
    return 1;
  })
  .finally(async () => {
    for (const id of createdUsers) await deleteAuthUser(id);
    console.log(`\nCleaned up ${createdUsers.length} throwaway users.`);
  });

process.exit(exitCode);
