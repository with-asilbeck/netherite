// The tier catalogue, the feature gates, the prompt assembly, the model
// selection, the report renderer, and the scan queue's ordering — all
// checked against the real modules rather than a restatement of them.
//
// The first section is deliberately a transcription of the specified table.
// It looks redundant next to lib/tiers.ts, and that is the point: it is the
// thing that fails if somebody edits a cap or flips a flag without meaning
// to, which is exactly the change that would otherwise ship silently.
//
//   node scripts/tier-config-test.mjs

import { register } from "node:module";

import { check, checkEqual, section, summarise } from "./billing-env.mjs";

register("./ts-alias-hook.mjs", import.meta.url);

const { TIER_LIMITS, TIERS, hasFeature, lowestTierWith, messagesCapIsVisible } = await import(
  "../lib/tiers.ts"
);
const { entitlementFor, GUEST_ENTITLEMENT, withFeaturePrompts } = await import(
  "../lib/tier-features.ts"
);
const { buildDeepSystemPrompt } = await import("../lib/repo-scan/deep-scan.ts");
const {
  ACTION_WINDOWS,
  capIsVisible,
  invisibleCapMessage,
  limitFor,
  secondsUntilWindowReset,
  upgradeMessage,
} = await import("../lib/usage/tiers.ts");
const { SCAN_BEST_MODEL, SCAN_DEEP_MODEL, SCAN_TRIAGE_MODEL } = await import(
  "../lib/openrouter.ts"
);
const queue = await import("../lib/repo-scan/queue.ts");

// ── 1. The specified table, transcribed ─────────────────────────────────

const SPEC = {
  free: {
    messages_daily_cap: 200,
    snippets_monthly: 10,
    repo_scans_monthly: 2,
    model_tier: "fast",
    vulnerability_report: false,
    deep_exploit_analysis: false,
    priority_queue: false,
  },
  basic: {
    messages_daily_cap: 1000,
    snippets_monthly: 150,
    repo_scans_monthly: 25,
    model_tier: "fast",
    vulnerability_report: false,
    deep_exploit_analysis: false,
    priority_queue: false,
  },
  pro: {
    messages_daily_cap: 2000,
    snippets_monthly: 750,
    repo_scans_monthly: 150,
    model_tier: "fast",
    vulnerability_report: true,
    deep_exploit_analysis: true,
    priority_queue: true,
  },
  max: {
    messages_daily_cap: 5000,
    snippets_monthly: 3000,
    repo_scans_monthly: 500,
    model_tier: "best",
    vulnerability_report: true,
    deep_exploit_analysis: true,
    priority_queue: true,
  },
};

section("1. The tier table matches the specification exactly");

checkEqual("the tiers are free/basic/pro/max in order", TIERS.join(","), "free,basic,pro,max");

for (const [tier, expected] of Object.entries(SPEC)) {
  for (const [key, value] of Object.entries(expected)) {
    checkEqual(`${tier}.${key}`, TIER_LIMITS[tier][key], value);
  }
}

section("2. The per-action projection keeps the same numbers");

for (const [tier, expected] of Object.entries(SPEC)) {
  checkEqual(`${tier} chat cap`, limitFor(tier, "chat"), expected.messages_daily_cap);
  checkEqual(`${tier} snippet cap`, limitFor(tier, "snippet"), expected.snippets_monthly);
  checkEqual(`${tier} repo_scan cap`, limitFor(tier, "repo_scan"), expected.repo_scans_monthly);
}

checkEqual("messages are capped per day", ACTION_WINDOWS.chat, "day");
checkEqual("snippets are capped per month", ACTION_WINDOWS.snippet, "month");
checkEqual("repo scans are capped per month", ACTION_WINDOWS.repo_scan, "month");

section("3. The message ceiling is invisible on every paid tier");

checkEqual("free's message cap is advertised", messagesCapIsVisible("free"), true);
for (const tier of ["basic", "pro", "max"]) {
  checkEqual(`${tier}'s message cap is a fair-use ceiling`, messagesCapIsVisible(tier), false);
  checkEqual(`  and capIsVisible agrees`, capIsVisible(tier, "chat"), false);
  checkEqual(`  snippets stay visible on ${tier}`, capIsVisible(tier, "snippet"), true);
  checkEqual(`  repo scans stay visible on ${tier}`, capIsVisible(tier, "repo_scan"), true);
}

// The copy is the actual control here — a route that ignored `visible`
// would still not leak a number, because the message it echoes has none.
const generic = invisibleCapMessage();
for (const tier of ["basic", "pro", "max"]) {
  const cap = String(SPEC[tier].messages_daily_cap);
  check(
    `the ${tier} fair-use message names no cap`,
    !generic.includes(cap) && !generic.includes(cap.replace(/(\d)(?=(\d{3})+$)/g, "$1,")),
    generic,
  );
}
check(
  "the fair-use message says nothing about limits or upgrading",
  !/limit|quota|upgrade|plan|cap\b/i.test(generic),
  generic,
);
check(
  "free's message cap message does name the number and the upgrade",
  upgradeMessage("free", "chat", 200).includes("200") &&
    /upgrade/i.test(upgradeMessage("free", "chat", 200)),
  upgradeMessage("free", "chat", 200),
);
check(
  "and free's message copy points at a plan sold as unlimited",
  /unlimited/i.test(upgradeMessage("free", "chat", 200)),
  upgradeMessage("free", "chat", 200),
);

section("4. Window reset arithmetic");

const midMonth = new Date("2026-08-15T23:00:00Z");
checkEqual(
  "a daily window resets at the next UTC midnight",
  secondsUntilWindowReset("chat", midMonth),
  3600,
);
checkEqual(
  "a monthly window resets at the start of next month",
  secondsUntilWindowReset("repo_scan", new Date("2026-08-31T23:00:00Z")),
  3600,
);
check(
  "reset seconds are always positive",
  secondsUntilWindowReset("chat", new Date("2026-08-15T23:59:59.999Z")) >= 1,
);

// ── 5. Feature gating ───────────────────────────────────────────────────

section("5. Gated features are off below their tier");

const GATED = ["vulnerability_report", "deep_exploit_analysis", "priority_queue"];
for (const feature of GATED) {
  checkEqual(`free has no ${feature}`, hasFeature("free", feature), false);
  checkEqual(`basic has no ${feature}`, hasFeature("basic", feature), false);
  checkEqual(`pro has ${feature}`, hasFeature("pro", feature), true);
  checkEqual(`max has ${feature}`, hasFeature("max", feature), true);
  checkEqual(`the cheapest tier with ${feature} is pro`, lowestTierWith(feature), "pro");
}

section("6. Entitlements derived from a tier");

for (const tier of ["free", "basic"]) {
  const e = entitlementFor(tier);
  checkEqual(`${tier} gets no structured report`, e.structuredReport, false);
  checkEqual(`${tier} gets no exploit analysis`, e.exploitAnalysis, false);
  checkEqual(`${tier} gets no queue priority`, e.priorityQueue, false);
  checkEqual(`${tier} triages with the cheap model`, e.models.triage, SCAN_TRIAGE_MODEL);
  checkEqual(`${tier} deep-scans with sonnet`, e.models.deep, SCAN_DEEP_MODEL);
}

const pro = entitlementFor("pro");
checkEqual("pro gets the structured report", pro.structuredReport, true);
checkEqual("pro gets exploit analysis", pro.exploitAnalysis, true);
checkEqual("pro gets queue priority", pro.priorityQueue, true);
checkEqual("pro still triages with the cheap model", pro.models.triage, SCAN_TRIAGE_MODEL);
checkEqual("pro deep-scans with sonnet", pro.models.deep, SCAN_DEEP_MODEL);

const max = entitlementFor("max");
checkEqual("max triages with the best model", max.models.triage, SCAN_BEST_MODEL);
checkEqual("max deep-scans with the best model", max.models.deep, SCAN_BEST_MODEL);
check(
  "max uses the best model on BOTH stages, not just deep",
  max.models.triage === max.models.deep && max.models.deep === SCAN_BEST_MODEL,
  `${max.models.triage} / ${max.models.deep}`,
);

checkEqual("a guest is treated as free", GUEST_ENTITLEMENT.tier, "free");
checkEqual("a guest gets no gated feature", GUEST_ENTITLEMENT.structuredReport, false);
checkEqual("and none of the deep analysis", GUEST_ENTITLEMENT.exploitAnalysis, false);

section("7. Prompts carry only what the tier bought");

const BASE = "BASE PROMPT SENTINEL";
const EXPLOIT_MARKER = "Exploit-chain analysis";
const STRUCTURED_MARKER = "Structured report format";

for (const tier of ["free", "basic"]) {
  const prompt = withFeaturePrompts(BASE, entitlementFor(tier));
  check(`${tier}'s advisor prompt keeps the base`, prompt.includes(BASE));
  check(`${tier}'s advisor prompt has no exploit section`, !prompt.includes(EXPLOIT_MARKER));
  check(`${tier}'s advisor prompt has no structured section`, !prompt.includes(STRUCTURED_MARKER));
}

for (const tier of ["pro", "max"]) {
  const prompt = withFeaturePrompts(BASE, entitlementFor(tier));
  check(`${tier}'s advisor prompt keeps the base`, prompt.includes(BASE));
  check(`${tier}'s advisor prompt adds the exploit section`, prompt.includes(EXPLOIT_MARKER));
  check(`${tier}'s advisor prompt adds the structured section`, prompt.includes(STRUCTURED_MARKER));
  check(
    `${tier}'s base prompt still comes first`,
    prompt.indexOf(BASE) < prompt.indexOf(EXPLOIT_MARKER),
  );
}

section("8. The scan prompt is gated the same way");

const UNTRUSTED_RULE = "untrusted data";
for (const tier of TIERS) {
  const prompt = buildDeepSystemPrompt(entitlementFor(tier));
  const gated = tier === "pro" || tier === "max";
  check(`${tier}'s scan prompt keeps the untrusted-input rule`, prompt.includes(UNTRUSTED_RULE));
  checkEqual(`${tier}'s scan prompt exploit section`, prompt.includes(EXPLOIT_MARKER), gated);
  checkEqual(`${tier}'s scan prompt structured section`, prompt.includes(STRUCTURED_MARKER), gated);
}

// ── 9. Queue ordering ───────────────────────────────────────────────────

section("9. Priority queue serves pro/max before free/basic");

queue.resetScanQueueForTests();

const order = [];
const releases = [];

// Fill every slot so the next arrivals must queue.
for (let i = 0; i < queue.MAX_CONCURRENT_SCANS; i++) {
  releases.push(await queue.acquireScanSlot(queue.PRIORITY_NORMAL));
}
checkEqual("the queue is saturated", queue.scanQueueStats().running, queue.MAX_CONCURRENT_SCANS);

// Each waiter records its turn and immediately hands the slot back, so
// freeing one slot drains the whole queue in admission order — which is the
// order under test.
const enqueue = (priority, name) =>
  queue.acquireScanSlot(priority).then((release) => {
    order.push(name);
    release();
  });

// Three free/basic waiters arrive first, then one pro. The pro must be
// admitted before all three despite arriving last.
const waiters = [
  enqueue(queue.PRIORITY_NORMAL, "normal-1"),
  enqueue(queue.PRIORITY_NORMAL, "normal-2"),
  enqueue(queue.PRIORITY_NORMAL, "normal-3"),
];
// Yield so the three above are definitely enqueued before the priority one.
await new Promise((resolve) => setImmediate(resolve));
waiters.push(enqueue(queue.PRIORITY_HIGH, "HIGH"));
await new Promise((resolve) => setImmediate(resolve));

checkEqual("four scans are queued", queue.scanQueueStats().queued, 4);
checkEqual("one of them is high priority", queue.scanQueueStats().queuedByPriority.high, 1);

// Free one slot and let the queue drain through it.
releases[0]();
await Promise.all(waiters);

checkEqual("the pro/max scan is admitted first", order[0], "HIGH");
checkEqual(
  "equal priorities keep first-come-first-served",
  order.slice(1).join(","),
  "normal-1,normal-2,normal-3",
);
releases[1]();

queue.resetScanQueueForTests();
checkEqual("the queue drains back to empty", queue.scanQueueStats().running, 0);

section("10. The queue is bounded");

queue.resetScanQueueForTests();
const held = [];
for (let i = 0; i < queue.MAX_CONCURRENT_SCANS; i++) {
  held.push(await queue.acquireScanSlot(queue.PRIORITY_NORMAL));
}
const queued = [];
for (let i = 0; i < queue.MAX_QUEUE_DEPTH; i++) {
  queued.push(queue.acquireScanSlot(queue.PRIORITY_NORMAL).catch(() => "rejected"));
}
await new Promise((resolve) => setImmediate(resolve));

let overflowed = false;
try {
  await queue.acquireScanSlot(queue.PRIORITY_NORMAL);
} catch (err) {
  overflowed = err instanceof queue.ScanQueueFullError;
}
check("a full queue rejects rather than growing without bound", overflowed);

// A released slot must not be returned twice — otherwise concurrency
// creeps above the cap over the life of the process.
const doubleRelease = held[0];
doubleRelease();
doubleRelease();
await new Promise((resolve) => setImmediate(resolve));
check(
  "releasing a slot twice does not raise the concurrency ceiling",
  queue.scanQueueStats().running <= queue.MAX_CONCURRENT_SCANS,
  `running=${queue.scanQueueStats().running}`,
);

queue.resetScanQueueForTests();
await Promise.allSettled(queued);
for (const release of held.slice(1)) release();

process.exit(summarise());
