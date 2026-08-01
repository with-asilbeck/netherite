// Table-driven check of the entitlement rules, importing the real
// lib/billing/entitlement.ts rather than restating it.
//
// The webhook harness proves what lands in the database. This proves what
// the app *grants* for a given row — the time-dependent half (cancelled
// until the period ends, past_due through a grace window, refunded
// immediately) that a database assertion can't reach on its own.
//
//   node scripts/billing-entitlement-test.mjs

import { register } from "node:module";

import { check, section, summarise } from "./billing-env.mjs";

register("./ts-alias-hook.mjs", import.meta.url);

const { effectiveTier, resolveEffectiveTier, PAST_DUE_GRACE_DAYS } = await import(
  "../lib/billing/entitlement.ts"
);

const NOW = new Date("2026-08-01T12:00:00Z");
const days = (n) => new Date(NOW.getTime() + n * 86400_000).toISOString();

function row(overrides) {
  return { tier: "pro", status: "active", current_period_end: days(20), ...overrides };
}

const cases = [
  // [name, row, expected tier]
  ["no subscription row is free", null, "free"],
  ["active grants its tier", row({}), "pro"],
  ["active grants max", row({ tier: "max" }), "max"],
  ["active with a tier of free grants free", row({ tier: "free" }), "free"],

  ["cancelled keeps the tier until the period ends", row({ status: "cancelled" }), "pro"],
  [
    "cancelled the day before the period ends still grants it",
    row({ status: "cancelled", current_period_end: days(1) }),
    "pro",
  ],
  [
    "cancelled after the period has ended grants free",
    row({ status: "cancelled", current_period_end: days(-1) }),
    "free",
  ],
  [
    "cancelled with no end date grants free",
    row({ status: "cancelled", current_period_end: null }),
    "free",
  ],

  [
    "past_due keeps the tier inside the grace window",
    row({ status: "past_due", current_period_end: days(-1) }),
    "pro",
  ],
  [
    `past_due grants free past the ${PAST_DUE_GRACE_DAYS}-day grace window`,
    row({ status: "past_due", current_period_end: days(-(PAST_DUE_GRACE_DAYS + 1)) }),
    "free",
  ],
  [
    "past_due with no end date grants free",
    row({ status: "past_due", current_period_end: null }),
    "free",
  ],

  ["expired grants free", row({ status: "expired" }), "free"],
  [
    "expired grants free even with a future period end",
    row({ status: "expired", current_period_end: days(300) }),
    "free",
  ],

  ["refunded grants free", row({ status: "refunded" }), "free"],
  [
    "refunded grants free even with a future period end",
    row({ status: "refunded", current_period_end: days(300) }),
    "free",
  ],
  [
    "refunded on the top tier still grants free",
    row({ tier: "max", status: "refunded", current_period_end: days(300) }),
    "free",
  ],

  // Fail-closed cases: nothing unrecognised may resolve upward.
  ["an unknown status grants free", row({ status: "trialing" }), "free"],
  ["an unknown tier grants free", row({ tier: "enterprise" }), "free"],
  ["an unparseable period end grants free once cancelled", row({ status: "cancelled", current_period_end: "soon" }), "free"],
  ["a null status grants free", row({ status: null }), "free"],
  ["a null tier grants free", row({ tier: null }), "free"],
];

section("effectiveTier");
for (const [name, subscription, expected] of cases) {
  const actual = effectiveTier(subscription, NOW);
  check(name, actual === expected, `expected ${expected}, got ${actual}`);
}

section("resolveEffectiveTier — the manual override may only raise");
const overrideCases = [
  ["no subscription, no override is free", null, null, "free"],
  ["no subscription, a comped override applies", null, "pro", "pro"],
  ["override raises a lower subscription", row({ tier: "basic" }), "max", "max"],
  ["override does not lower a paid subscription", row({ tier: "max" }), "basic", "max"],
  ["a stale free override never demotes a subscriber", row({ tier: "pro" }), "free", "pro"],
  ["an override cannot revive a refunded subscription beyond its own grant", row({ tier: "max", status: "refunded" }), "basic", "basic"],
  ["garbage in the override column is ignored", row({ tier: "pro" }), "enterprise", "pro"],
];

for (const [name, subscription, override, expected] of overrideCases) {
  const actual = resolveEffectiveTier(subscription, override, NOW);
  check(name, actual === expected, `expected ${expected}, got ${actual}`);
}

process.exit(summarise());
