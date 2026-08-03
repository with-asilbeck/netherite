// Tier limits enforced end to end: real signed-in sessions, real routes,
// real usage rows in Supabase.
//
// The config suite proves the rules; this proves the wiring. It signs in as
// a throwaway user, puts that user on a tier by writing the subscriptions
// row the webhook would have written, pre-loads the usage ledger to the
// exact edge of a cap, and then asks the actual HTTP endpoints what
// happens — including what they do when the request body lies about the
// caller's plan.
//
// Needs the dev server up:  node scripts/tier-enforcement-test.mjs

import { register } from "node:module";

import {
  check,
  checkEqual,
  deleteAuthUser,
  deleteRows,
  env,
  section,
  selectRows,
  summarise,
  SUPABASE_URL,
  SERVICE_KEY,
} from "./billing-env.mjs";

register("./ts-alias-hook.mjs", import.meta.url);
const { TIER_LIMITS } = await import("../lib/tiers.ts");

const BASE_URL = process.env.BILLING_TEST_BASE_URL ?? "http://localhost:3000";
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split(".")[0];
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`;

const service = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "resolution=merge-duplicates",
};

const created = [];

// ── Session plumbing ────────────────────────────────────────────────────

/**
 * Builds the cookie @supabase/ssr expects, so these requests are
 * indistinguishable from a browser's.
 *
 * The format is `base64-` + base64url(JSON.stringify(session)), split into
 * `.0`, `.1`, … chunks once the URL-encoded value passes 3180 characters —
 * read out of node_modules/@supabase/ssr/dist/main/cookies.js rather than
 * guessed, because a subtly wrong cookie would make every request look
 * anonymous and every assertion below would "pass" for the wrong reason.
 */
const MAX_CHUNK_SIZE = 3180;

function sessionCookieHeader(session) {
  const value = `base64-${Buffer.from(JSON.stringify(session), "utf8").toString("base64url")}`;

  if (encodeURIComponent(value).length <= MAX_CHUNK_SIZE) {
    return `${COOKIE_NAME}=${encodeURIComponent(value)}`;
  }

  const chunks = [];
  let rest = value;
  while (rest.length > 0) {
    // Conservative slice: chunking is on the *encoded* length, and this
    // payload is plain base64url, so a fixed character count is safe here.
    chunks.push(rest.slice(0, 2000));
    rest = rest.slice(2000);
  }
  return chunks
    .map((chunk, i) => `${COOKIE_NAME}.${i}=${encodeURIComponent(chunk)}`)
    .join("; ");
}

async function createUserSession(email, password) {
  const create = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: service,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const user = await create.json();
  if (!create.ok) throw new Error(`create user failed: ${JSON.stringify(user)}`);

  const signIn = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const session = await signIn.json();
  if (!signIn.ok) throw new Error(`sign in failed: ${JSON.stringify(session)}`);

  created.push(user.id);
  return { userId: user.id, cookie: sessionCookieHeader(session) };
}

// ── Fixtures ────────────────────────────────────────────────────────────

async function setTier(userId, tier) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions`, {
    method: "POST",
    headers: service,
    body: JSON.stringify({
      user_id: userId,
      lemonsqueezy_subscription_id: `sub_tier_${userId.slice(0, 8)}`,
      tier,
      billing_period: "monthly",
      status: "active",
      current_period_end: new Date(Date.now() + 30 * 86400_000).toISOString(),
    }),
  });
  if (!response.ok) throw new Error(`setTier failed: ${await response.text()}`);
}

/** Writes `count` usage rows for an action, at a chosen time. */
async function fillUsage(userId, action, count, createdAt = new Date().toISOString()) {
  if (count === 0) return;
  const rows = Array.from({ length: count }, () => ({
    user_id: userId,
    action_type: action,
    created_at: createdAt,
  }));
  const response = await fetch(`${SUPABASE_URL}/rest/v1/usage_events`, {
    method: "POST",
    headers: { ...service, Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!response.ok) throw new Error(`fillUsage failed: ${await response.text()}`);
}

async function usageCount(userId, action) {
  const rows = await selectRows(
    "usage_events",
    `user_id=eq.${userId}&action_type=eq.${action}&select=id`,
  );
  return rows.length;
}

// ── Requests ────────────────────────────────────────────────────────────

function post(path, cookie, body) {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: BASE_URL,
    },
    body: JSON.stringify(body),
  });
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

const chatBody = (extra = {}) => ({
  messages: [{ role: "user", content: "What is an IDOR vulnerability?" }],
  ...extra,
});

// ── The run ─────────────────────────────────────────────────────────────

async function main() {
  try {
    await fetch(BASE_URL, { method: "HEAD" });
  } catch {
    console.error(`\nCan't reach ${BASE_URL}. Start the dev server first: npm run dev`);
    process.exit(2);
  }

  const stamp = Date.now();
  const password = `Pw-${stamp}-${Math.random().toString(36).slice(2)}`;

  section("0. The forged session is actually a session");

  const probe = await createUserSession(`tier-probe-${stamp}@netherite-verify.invalid`, password);
  // If the cookie were wrong every request would look anonymous, and the
  // cap assertions below would pass for entirely the wrong reason. This is
  // the control: an anonymous repo-scan request is 401, an authenticated
  // one is not.
  const anonScan = await post("/api/repo-scan/run", "", {
    repoUrl: "https://github.com/octocat/Hello-World",
  });
  checkEqual("an anonymous repo scan is 401", anonScan.status, 401);

  await setTier(probe.userId, "free");
  await fillUsage(probe.userId, "repo_scan", TIER_LIMITS.free.repo_scans_monthly);
  const authedScan = await post("/api/repo-scan/run", probe.cookie, {
    repoUrl: "https://github.com/octocat/Hello-World",
  });
  check(
    "the same request with a session is recognised (not 401)",
    authedScan.status !== 401,
    `HTTP ${authedScan.status}`,
  );
  checkEqual("and is refused at the free repo-scan cap", authedScan.status, 402);

  section("1. Monthly caps are visible and name the upgrade");

  const scanBody = await readJson(authedScan);
  check(
    "the repo-scan refusal names the cap",
    String(scanBody.error).includes(String(TIER_LIMITS.free.repo_scans_monthly)),
    scanBody.error,
  );
  check(
    "and points at the next plan",
    /upgrade/i.test(String(scanBody.error)),
    scanBody.error,
  );
  check("and sets Retry-After", Boolean(authedScan.headers.get("retry-after")));
  checkEqual(
    "a refused scan spends no unit",
    await usageCount(probe.userId, "repo_scan"),
    TIER_LIMITS.free.repo_scans_monthly,
  );

  section("2. The free message cap is advertised — 402 and the number");

  const freeChat = await createUserSession(
    `tier-free-chat-${stamp}@netherite-verify.invalid`,
    password,
  );
  await setTier(freeChat.userId, "free");
  await fillUsage(freeChat.userId, "chat", TIER_LIMITS.free.messages_daily_cap);

  const freeBlocked = await post("/api/chat", freeChat.cookie, chatBody());
  checkEqual("a free user at the daily cap gets 402", freeBlocked.status, 402);
  const freeBody = await readJson(freeBlocked);
  check(
    "the message names the cap",
    String(freeBody.error).includes("200"),
    freeBody.error,
  );
  check("and offers the upgrade", /upgrade/i.test(String(freeBody.error)), freeBody.error);

  section("3. The paid message ceiling is invisible — 429 and no number");

  const proChat = await createUserSession(
    `tier-pro-chat-${stamp}@netherite-verify.invalid`,
    password,
  );
  await setTier(proChat.userId, "pro");
  await fillUsage(proChat.userId, "chat", TIER_LIMITS.pro.messages_daily_cap);

  const proBlocked = await post("/api/chat", proChat.cookie, chatBody());
  checkEqual("a pro user at the fair-use ceiling gets 429, not 402", proBlocked.status, 429);
  check("with a Retry-After", Boolean(proBlocked.headers.get("retry-after")));

  const proBody = await readJson(proBlocked);
  const proMessage = String(proBody.error);
  check("the message names no number", !/\d/.test(proMessage), proMessage);
  check(
    "and says nothing about limits, quotas, plans or upgrading",
    !/limit|quota|upgrade|plan|cap\b|unlimited/i.test(proMessage),
    proMessage,
  );
  check("and reads as temporary", /try again/i.test(proMessage), proMessage);

  section("3b. The monthly ceiling fires even on a quiet day");

  // Basic carries two invisible ceilings: 100 a day and 700 a month. One
  // user, two requests, in this order on purpose — served first, then the
  // month backfilled underneath them. Every backfilled row is dated earlier
  // in the month, so today's count stays at one and the daily cap cannot be
  // what refuses. Which ceiling fired is readable from Retry-After: the
  // daily window is at most 86400 seconds away, the monthly one is days.
  const softCap = TIER_LIMITS.basic.messages_monthly_soft_cap;
  const basicChat = await createUserSession(
    `tier-basic-month-${stamp}@netherite-verify.invalid`,
    password,
  );
  await setTier(basicChat.userId, "basic");

  const basicAllowed = await post("/api/chat", basicChat.cookie, chatBody());
  check(
    "a basic user under both ceilings is served",
    basicAllowed.status === 200,
    `HTTP ${basicAllowed.status}`,
  );
  await basicAllowed.text();

  const now = new Date();
  const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12));
  await fillUsage(basicChat.userId, "chat", softCap, firstOfMonth.toISOString());

  const monthCeiling = await post("/api/chat", basicChat.cookie, chatBody());
  checkEqual("a basic user at the monthly ceiling gets 429, not 402", monthCeiling.status, 429);

  const monthMessage = String((await readJson(monthCeiling)).error);
  check(
    "the refusal names neither the daily nor the monthly ceiling",
    !monthMessage.includes(String(softCap)) &&
      !monthMessage.includes(String(TIER_LIMITS.basic.messages_daily_cap)),
    monthMessage,
  );
  check("and names no number at all", !/\d/.test(monthMessage), monthMessage);

  const retryAfter = Number(monthCeiling.headers.get("retry-after"));
  if (now.getUTCDate() === 1) {
    // The backdated rows landed today, so the daily cap got there first. The
    // refusal above is still correct, just not the one under test.
    console.log("  SKIP  monthly Retry-After (today is the 1st — see comment)");
  } else {
    check(
      "and Retry-After points at the month, not tonight's midnight",
      retryAfter > 86400,
      `retry-after=${retryAfter}`,
    );
  }

  section("4. Caps are counted over the right window");

  const windows = await createUserSession(
    `tier-window-${stamp}@netherite-verify.invalid`,
    password,
  );
  await setTier(windows.userId, "free");

  // Yesterday's messages must not count against today's daily cap.
  const yesterday = new Date(Date.now() - 26 * 3600_000).toISOString();
  await fillUsage(windows.userId, "chat", TIER_LIMITS.free.messages_daily_cap, yesterday);

  const afterMidnight = await post("/api/chat", windows.cookie, chatBody());
  check(
    "yesterday's messages don't count against today's daily cap",
    afterMidnight.status !== 402,
    `HTTP ${afterMidnight.status}`,
  );
  // That request went through to the model; drain and discard the stream.
  await afterMidnight.text();

  // Earlier this month's scans DO count against the monthly cap.
  const earlierThisMonth = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1, 12),
  ).toISOString();
  await fillUsage(
    windows.userId,
    "repo_scan",
    TIER_LIMITS.free.repo_scans_monthly,
    earlierThisMonth,
  );
  const monthlyBlocked = await post("/api/repo-scan/run", windows.cookie, {
    repoUrl: "https://github.com/octocat/Hello-World",
  });
  checkEqual("earlier-this-month scans do count monthly", monthlyBlocked.status, 402);

  section("5. The request body cannot buy a tier");

  // Every field a client might try. The user is free and at their cap, so
  // any of these being read would turn a 402 into a 200.
  const escalations = [
    { name: "tier", body: chatBody({ tier: "max" }) },
    { name: "plan", body: chatBody({ plan: "max", subscription: { tier: "max" } }) },
    {
      name: "feature flags",
      body: chatBody({
        features: {
          vulnerability_report: true,
          deep_exploit_analysis: true,
          priority_queue: true,
        },
      }),
    },
    {
      name: "a whole entitlement object",
      body: chatBody({
        entitlement: {
          tier: "max",
          structuredReport: true,
          exploitAnalysis: true,
          priorityQueue: true,
          models: { triage: "anthropic/claude-opus-5", deep: "anthropic/claude-opus-5" },
        },
      }),
    },
    { name: "a model override", body: chatBody({ model: "anthropic/claude-opus-5" }) },
    { name: "a limit override", body: chatBody({ messages_daily_cap: 999999, limit: 999999 }) },
    { name: "another user's id", body: chatBody({ userId: proChat.userId, user_id: proChat.userId }) },
  ];

  for (const attempt of escalations) {
    const response = await post("/api/chat", freeChat.cookie, attempt.body);
    checkEqual(`"${attempt.name}" in the body does not lift the cap`, response.status, 402);
    const body = await readJson(response);
    check(
      `  and the refusal is still the free-tier one`,
      String(body.error).includes("200"),
      String(body.error).slice(0, 90),
    );
  }

  // The same, against the scan endpoint — the one with the gated features.
  const scanEscalations = [
    { name: "priority_queue", extra: { priority_queue: true, priority: "high" } },
    { name: "vulnerability_report", extra: { vulnerability_report: true, format: "structured" } },
    { name: "deep_exploit_analysis", extra: { deep_exploit_analysis: true } },
    { name: "model", extra: { model: "anthropic/claude-opus-5", model_tier: "best" } },
    { name: "tier", extra: { tier: "max" } },
  ];

  // A fresh user per attempt. checkRepoScanRunRateLimit allows 3 scan
  // requests per hour per user and runs *before* the tier check, so reusing
  // one account here would start returning 429 on the fourth attempt — a
  // pass that proves nothing about tier enforcement, because the request
  // never reached it.
  for (const attempt of scanEscalations) {
    const attacker = await createUserSession(
      `tier-esc-${stamp}-${attempt.name.replace(/\W/g, "")}@netherite-verify.invalid`,
      password,
    );
    await setTier(attacker.userId, "free");
    await fillUsage(attacker.userId, "repo_scan", TIER_LIMITS.free.repo_scans_monthly);

    const response = await post("/api/repo-scan/run", attacker.cookie, {
      repoUrl: "https://github.com/octocat/Hello-World",
      ...attempt.extra,
    });
    checkEqual(
      `"${attempt.name}" in a scan body does not lift the cap`,
      response.status,
      402,
    );
  }

  section("6. Snippet cap");

  const snippets = await createUserSession(
    `tier-snippet-${stamp}@netherite-verify.invalid`,
    password,
  );
  await setTier(snippets.userId, "free");
  await fillUsage(snippets.userId, "snippet", TIER_LIMITS.free.snippets_monthly);

  const form = new FormData();
  form.append("kind", "file");
  form.append("file", new Blob(["const a = 1;\n"], { type: "text/plain" }), "probe.ts");

  const snippetBlocked = await fetch(`${BASE_URL}/api/attachments`, {
    method: "POST",
    headers: { Cookie: snippets.cookie },
    body: form,
  });
  checkEqual("a free user at the snippet cap gets 402", snippetBlocked.status, 402);
  const snippetBody = await readJson(snippetBlocked);
  check(
    "the snippet refusal names the cap",
    String(snippetBody.error).includes(String(TIER_LIMITS.free.snippets_monthly)),
    snippetBody.error,
  );
  checkEqual(
    "and spends no unit",
    await usageCount(snippets.userId, "snippet"),
    TIER_LIMITS.free.snippets_monthly,
  );

  section("7. A higher tier really does get more");

  const maxUser = await createUserSession(`tier-max-${stamp}@netherite-verify.invalid`, password);
  await setTier(maxUser.userId, "max");
  // Well past every free and basic cap, comfortably inside max's.
  await fillUsage(maxUser.userId, "repo_scan", TIER_LIMITS.basic.repo_scans_monthly + 1);

  const maxScan = await post("/api/repo-scan/run", maxUser.cookie, {
    repoUrl: "https://github.com/octocat/Hello-World",
  });
  check(
    "a max user past basic's scan cap is not blocked",
    maxScan.status !== 402,
    `HTTP ${maxScan.status}`,
  );
  await maxScan.text();

  // And the same usage on a downgraded row is blocked — proving the tier
  // came from the table and not from anything about the request.
  await setTier(maxUser.userId, "basic");
  const downgraded = await post("/api/repo-scan/run", maxUser.cookie, {
    repoUrl: "https://github.com/octocat/Hello-World",
  });
  checkEqual(
    "downgrading the subscription row immediately blocks the same request",
    downgraded.status,
    402,
  );
}

const exitCode = await main()
  .then(() => summarise())
  .catch((err) => {
    console.error("\nHarness error:", err);
    return 1;
  })
  .finally(async () => {
    for (const id of created) {
      await deleteRows("usage_events", `user_id=eq.${id}`);
      await deleteAuthUser(id);
    }
    console.log(`\nCleaned up ${created.length} throwaway users.`);
  });

process.exit(exitCode);
