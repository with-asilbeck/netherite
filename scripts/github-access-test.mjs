// The GitHub ownership gate, checked branch by branch against the real
// decision function rather than a restatement of it.
//
// This is the check that matters most in the repo-scan feature: it is the
// only thing standing between "a user pasted a URL" and "this server cloned
// somebody else's repository on their behalf". It is written against
// decideRepoAccess(), the pure half of lib/github/access.ts, so every branch
// — including the ones that need a dead token or a rate-limited GitHub — can
// be reproduced exactly, with no network, no database, and no real OAuth
// credential.
//
//   node scripts/github-access-test.mjs

import { register } from "node:module";

import { check, checkEqual, section, summarise } from "./billing-env.mjs";

register("./ts-alias-hook.mjs", import.meta.url);

const { decideRepoAccess, oversizeRefusal } = await import("../lib/github/access.ts");
const { MAX_FILE_BYTES, MAX_REPO_SIZE_KB, MAX_TOTAL_BYTES, PRIORITY_KEYWORDS } = await import(
  "../lib/repo-scan/config.ts"
);
const { GITHUB_OAUTH_SCOPES } = await import("../lib/github/scopes.ts");
const { parseGitHubRepoUrl } = await import("../lib/github-repo.ts");
const { byRisk } = await import("../lib/repo-scan/collect.ts");
const { assessOutcome } = await import("../lib/repo-scan/index.ts");

// The connected user for every case below: GitHub account "alice", id 4242.
const ALICE = { githubUsername: "alice", githubUserId: 4242 };

const ok = (data) => ({ ok: true, data });
const fail = (kind, extra = {}) => ({ ok: false, failure: { kind, ...extra } });

function repo({ ownerLogin, ownerId, ownerType = "User", push, isPrivate = false, size = 1024 }) {
  return ok({
    full_name: `${ownerLogin}/thing`,
    private: isPrivate,
    size,
    owner: { login: ownerLogin, id: ownerId, type: ownerType },
    ...(push === undefined ? {} : { permissions: { push, pull: true } }),
  });
}

// ── 1. The allow cases ──────────────────────────────────────────────────

section("Allowed: repositories the user owns or can push to");

const ownRepo = decideRepoAccess(
  ALICE,
  repo({ ownerLogin: "alice", ownerId: 4242 }),
  "alice/thing",
);
check("a repo owned by the connected account is allowed", ownRepo.allowed === true);
checkEqual("…and is attributed to ownership", ownRepo.via, "owner");

// The immutable id is what ownership rests on, so a user who renamed their
// GitHub login since connecting still owns their own repositories.
const renamed = decideRepoAccess(
  ALICE,
  repo({ ownerLogin: "alice-new", ownerId: 4242 }),
  "alice-new/thing",
);
check("a renamed login still matches on the immutable account id", renamed.allowed === true);

// The reverse: somebody else who has *taken over* the freed login must not
// inherit ownership from the stale username.
const impostor = decideRepoAccess(
  ALICE,
  repo({ ownerLogin: "alice", ownerId: 9999, push: false }),
  "alice/thing",
);
check(
  "a different account now holding the old login is NOT treated as the owner",
  impostor.allowed === false,
);

const orgWithPush = decideRepoAccess(
  ALICE,
  repo({ ownerLogin: "acme", ownerId: 77, ownerType: "Organization", push: true }),
  "acme/thing",
);
check("an org repo with push access is allowed", orgWithPush.allowed === true);
checkEqual("…and is attributed to push access", orgWithPush.via, "push");

// ── 2. The refusals ─────────────────────────────────────────────────────

section("Refused: repositories the user neither owns nor can push to");

const notMine = decideRepoAccess(
  ALICE,
  repo({ ownerLogin: "torvalds", ownerId: 1, push: false }),
  "torvalds/linux",
);
check("a public repo owned by somebody else is refused", notMine.allowed === false);
checkEqual("…with 403", notMine.status, 403);
check(
  "…and the message names the real owner rather than a generic failure",
  notMine.message.includes("torvalds"),
  notMine.message,
);
check(
  "…and offers no reconnect affordance, which would not help",
  notMine.action === undefined,
);

// The default when GitHub returns no permissions block at all: refuse.
const noPermissions = decideRepoAccess(
  ALICE,
  repo({ ownerLogin: "acme", ownerId: 77, ownerType: "Organization" }),
  "acme/thing",
);
check("an org repo with no permissions block is refused", noPermissions.allowed === false);

const readOnly = decideRepoAccess(
  ALICE,
  repo({ ownerLogin: "acme", ownerId: 77, ownerType: "Organization", push: false }),
  "acme/thing",
);
check("read-only access to an org repo is refused", readOnly.allowed === false);

// ── 3. Connection state ─────────────────────────────────────────────────

section("Connection problems are distinguishable and recoverable");

const noConnection = decideRepoAccess(null, fail("unavailable"), "alice/thing");
check("no connection at all is refused", noConnection.allowed === false);
checkEqual("…and asks the user to connect", noConnection.action, "connect");

const deadToken = decideRepoAccess(ALICE, fail("auth"), "alice/thing");
check("an expired or revoked token is refused", deadToken.allowed === false);
checkEqual("…with 401", deadToken.status, 401);
checkEqual("…and asks the user to reconnect", deadToken.action, "reconnect");

// ── 4. Every failure mode gets its own message ──────────────────────────

section("Distinct messages, no generic fallback hiding the cause");

const failures = {
  auth: decideRepoAccess(ALICE, fail("auth"), "alice/thing"),
  not_found: decideRepoAccess(ALICE, fail("not_found"), "alice/thing"),
  rate_limited: decideRepoAccess(ALICE, fail("rate_limited", { retryAfterSeconds: 60 }), "alice/thing"),
  forbidden: decideRepoAccess(ALICE, fail("forbidden"), "alice/thing"),
  unavailable: decideRepoAccess(ALICE, fail("unavailable"), "alice/thing"),
};

const statuses = Object.fromEntries(
  Object.entries(failures).map(([kind, verdict]) => [kind, verdict.status]),
);
checkEqual("401 for a dead token", statuses.auth, 401);
checkEqual("404 for a repo that isn't visible", statuses.not_found, 404);
checkEqual("429 for GitHub rate limiting", statuses.rate_limited, 429);
checkEqual("403 for an SSO-blocked org", statuses.forbidden, 403);
checkEqual("502 when GitHub can't be reached", statuses.unavailable, 502);

const messages = Object.values(failures).map((v) => v.message);
check(
  "all five failure messages are distinct",
  new Set(messages).size === messages.length,
  messages.join(" | "),
);
check("every failure is refused", Object.values(failures).every((v) => v.allowed === false));

// The 404 message must not claim the repo doesn't exist, since with
// public_repo scope a private repo is indistinguishable from a missing one.
check(
  "the 404 message admits the private-repo possibility instead of guessing",
  /private/i.test(failures.not_found.message),
  failures.not_found.message,
);

// ── 5. Scope minimality ─────────────────────────────────────────────────

section("Requested OAuth scopes stay minimal");

check(
  "public_repo is requested (needed for the permissions block)",
  GITHUB_OAUTH_SCOPES.includes("public_repo"),
  GITHUB_OAUTH_SCOPES,
);
check(
  "read:user is requested (needed to bind the connection to an account)",
  GITHUB_OAUTH_SCOPES.includes("read:user"),
  GITHUB_OAUTH_SCOPES,
);
check(
  "the blanket `repo` scope is NOT requested — it would grant write access to every private repo",
  !/(^|\s)repo(\s|$)/.test(GITHUB_OAUTH_SCOPES),
  GITHUB_OAUTH_SCOPES,
);

// ── 6. The gate's input can't be smuggled past the URL parser ───────────

section("Only github.com repo URLs reach the gate at all");

const rejected = [
  "https://gitlab.com/alice/thing",
  "https://github.com.evil.tld/alice/thing",
  "https://user:pass@github.com/alice/thing",
  "https://github.com:8080/alice/thing",
  "http://127.0.0.1/alice/thing",
  "https://raw.githubusercontent.com/alice/thing",
  "file:///etc/passwd",
  "https://github.com/settings/admin",
];
for (const url of rejected) {
  check(`rejected before any GitHub call: ${url}`, parseGitHubRepoUrl(url) === null);
}

const accepted = parseGitHubRepoUrl("https://github.com/alice/thing");
check("a real repo URL parses", accepted !== null);
checkEqual(
  "…and is rebuilt canonically rather than passed through",
  accepted?.canonicalUrl,
  "https://github.com/alice/thing",
);

// ── 7. The pre-clone size gate ──────────────────────────────────────────

section("Oversized repositories are refused before anything is cloned");

check("a normal repo passes the size gate", oversizeRefusal(1024) === null);
check("a repo exactly at the limit passes", oversizeRefusal(MAX_REPO_SIZE_KB) === null);
check("one KB over the limit is refused", oversizeRefusal(MAX_REPO_SIZE_KB + 1) !== null);

// A missing size must not make a legitimate repo unscannable.
check("an unreported size is not treated as oversized", oversizeRefusal(null) === null);

const refusal = oversizeRefusal(MAX_REPO_SIZE_KB * 4);
check(
  "the refusal states the actual size and the limit rather than failing vaguely",
  /GB/.test(refusal) && /limit/i.test(refusal),
  refusal,
);
check(
  "…and says the repo was refused outright, not partly scanned",
  /rather than partly scanned/.test(refusal),
);

// The size verdict has to be carried out of the access check, or the routes
// have nothing to enforce against.
const sized = decideRepoAccess(
  ALICE,
  repo({ ownerLogin: "alice", ownerId: 4242, size: 999 }),
  "alice/thing",
);
checkEqual("an allowed verdict carries the repo size through", sized.sizeKb, 999);

// ── 8. Filtering caps and priority keywords ─────────────────────────────

section("Collection caps match the specified figures");

checkEqual("per-file ceiling is 500KB", MAX_FILE_BYTES, 500 * 1024);
checkEqual("total content held is 20MB", MAX_TOTAL_BYTES, 20 * 1024 * 1024);

// The specified priority list, transcribed — this fails if somebody edits
// the keywords without meaning to, which is the change that would otherwise
// silently stop protecting auth/payment files from the cap.
const SPEC_KEYWORDS = [
  "auth",
  "admin",
  "payment",
  "user",
  "config",
  "env",
  "api",
  "migration",
];
checkEqual(
  "priority keywords are exactly the specified set",
  [...PRIORITY_KEYWORDS].sort().join(","),
  SPEC_KEYWORDS.sort().join(","),
);

// ── 9. Ranking tiers ────────────────────────────────────────────────────

section("Sample code and tests never outrank real source");

const file = (relPath, score, demoted) => ({ relPath, score, demoted });

// The concrete regression: on a real repo, `examples/auth/*` scored higher
// than the library's own source and would have consumed the entire
// twelve-file deep-review budget.
const ranked = [
  file("examples/auth/index.js", 42, true),
  file("lib/application.js", 4, false),
  file("test/acceptance/auth.js", 30, true),
  file("lib/request.js", 3, false),
].sort(byRisk);

checkEqual("the highest-scoring demo file does not rank first", ranked[0].relPath, "lib/application.js");
check(
  "every non-demoted file ranks above every demoted one, regardless of score",
  ranked.findIndex((f) => f.demoted) > ranked.map((f) => f.demoted).lastIndexOf(false),
  ranked.map((f) => `${f.demoted ? "d" : " "}${f.score} ${f.relPath}`).join(" | "),
);
checkEqual("within the real-source tier, score still orders", ranked[1].relPath, "lib/request.js");
checkEqual("within the demoted tier, score still orders", ranked[2].relPath, "examples/auth/index.js");

// ── 10. A broken scan can never read as a clean one ─────────────────────

section("Scan outcome distinguishes 'found nothing' from 'never looked'");

const verdict = (relPath, inconclusive) => ({
  relPath,
  flagged: true,
  reason: inconclusive ? "Triage call failed — escalated for review." : "Handles user input.",
  inconclusive,
});
const deep = (relPath, { report = null, error = null } = {}) => ({ relPath, report, error });

// The real failure: OpenRouter 402, every triage batch dead, every deep
// review skipped. Zero findings here must never render as a clean result.
const allDead = assessOutcome({
  verdicts: [verdict("a.ts", true), verdict("b.ts", true)],
  deepResults: [deep("a.ts", { error: "out of credits" }), deep("b.ts", { error: "out of credits" })],
  failures: [
    { relPath: "a.ts", error: "out of credits" },
    { relPath: "b.ts", error: "out of credits" },
  ],
  deepSkipped: 0,
});
checkEqual("a scan where nothing was reviewed is 'failed'", allDead.status, "failed");
check(
  "…and says plainly that no verdict exists for any file",
  allDead.notes.some((n) => /No verdict was produced for any/.test(n)),
  allDead.notes.join(" | "),
);

// Triage died, but the deep pass reviewed every escalated file. Coverage is
// total — this must NOT claim incomplete coverage. Found by running it: the
// first version of this rule keyed off "did a stage fail" and reported
// "coverage is incomplete" on a scan whose own table showed 8 of 8 reviewed.
const escalatedButCovered = assessOutcome({
  verdicts: [verdict("a.ts", true), verdict("b.ts", true)],
  deepResults: [deep("a.ts", { report: "XSS" }), deep("b.ts")],
  failures: [],
  deepSkipped: 0,
});
checkEqual(
  "triage failure with full deep coverage is 'complete', not 'degraded'",
  escalatedButCovered.status,
  "complete",
);
check(
  "…but still reports the outage, since it multiplies cost",
  escalatedButCovered.notes.some((n) => /Triage was unavailable/.test(n)),
  escalatedButCovered.notes.join(" | "),
);

// The same shape with one file left uncovered is genuinely partial.
const partlyCovered = assessOutcome({
  verdicts: [verdict("a.ts", true), verdict("b.ts", true)],
  deepResults: [deep("a.ts", { report: "XSS" })],
  failures: [],
  deepSkipped: 1,
});
checkEqual("one uncovered file makes it 'degraded'", partlyCovered.status, "degraded");

// A genuinely clean scan must not be tarred by the new status.
const healthy = assessOutcome({
  verdicts: [verdict("a.ts", false), verdict("b.ts", false)],
  deepResults: [deep("a.ts"), deep("b.ts")],
  failures: [],
  deepSkipped: 0,
});
checkEqual("a scan that ran fully is 'complete'", healthy.status, "complete");
checkEqual("…with nothing to warn about", healthy.notes.length, 0);

// A healthy scan that simply hit the deep-review budget is still complete —
// the budget is the design, not a fault.
const budgeted = assessOutcome({
  verdicts: [verdict("a.ts", false), verdict("b.ts", false)],
  deepResults: [deep("a.ts")],
  failures: [],
  deepSkipped: 30,
});
checkEqual("hitting the deep-review budget is not a failure", budgeted.status, "complete");

// Partial failure keeps real findings while admitting the gap.
const partial = assessOutcome({
  verdicts: [verdict("a.ts", false), verdict("b.ts", true)],
  deepResults: [deep("a.ts", { report: "SQLi" }), deep("b.ts", { error: "timeout" })],
  failures: [{ relPath: "b.ts", error: "timeout" }],
  deepSkipped: 0,
});
checkEqual("a partly-failed scan is 'degraded', not 'failed'", partial.status, "degraded");
check(
  "…and reports both the triage and deep-review gaps",
  partial.notes.length === 2,
  partial.notes.join(" | "),
);

summarise();
