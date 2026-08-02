import { addUsage, EMPTY_USAGE, type CompletionUsage } from "@/lib/llm";

// Hard limits for the repo-scan pipeline. Every one of these exists so a
// scan terminates with a clear message instead of hanging or running the
// bill up — a public-facing endpoint that clones arbitrary repos has to
// assume it will eventually be pointed at a huge or hostile one.

/** Per-file size ceiling. Anything larger is excluded, not truncated. */
export const MAX_FILE_BYTES = 500 * 1024;

/** Files kept after filtering. Beyond this, the lowest-risk tail is dropped. */
export const MAX_FILES = 400;

/** Total bytes of source we're willing to hold and reason about. */
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/**
 * Ceiling on the repository itself, checked *before* cloning.
 *
 * MAX_TOTAL_BYTES bounds what we keep after filtering, which is a different
 * thing from what lands on disk: a repo can be gigabytes of media and
 * generated output that the filter then discards, and by the time it does,
 * the clone has already happened. Until this existed the only bound on a
 * hostile or merely enormous repository was CLONE_TIMEOUT_MS, which is a
 * time limit, not a disk limit — a fast fetch of a huge repo would fill the
 * function's temp space and fail with ENOSPC halfway through.
 *
 * GitHub reports `size` in KB on the same `GET /repos` response the
 * ownership check already makes, so enforcing this costs no extra API call.
 * The figure covers full history rather than a shallow checkout, so it
 * overestimates what `--depth 1` actually fetches — hence a ceiling set for
 * disk safety rather than one derived from MAX_TOTAL_BYTES, which would
 * reject ordinary repositories with long histories.
 */
export const MAX_REPO_SIZE_KB = 500 * 1024;

/** Directory entries walked before giving up — guards against pathological trees. */
export const MAX_WALK_ENTRIES = 50_000;

/** Files sent through Tier 1 triage. */
export const MAX_TRIAGE_FILES = 150;

/** Files sent through Tier 2 deep review, however many Tier 1 flags. */
export const MAX_DEEP_FILES = 12;

/** Files per Tier 1 request. Small batches: fewer calls, still one verdict each. */
export const TRIAGE_BATCH_SIZE = 4;

export const TRIAGE_CONCURRENCY = 5;
export const DEEP_CONCURRENCY = 3;

/** Characters of a single file handed to a model. Longer files are truncated. */
export const MAX_FILE_CHARS_FOR_TRIAGE = 6_000;
export const MAX_FILE_CHARS_FOR_DEEP = 14_000;

export const CLONE_TIMEOUT_MS = 90_000;

/** Whole-scan ceiling, below the route's maxDuration so we abort ourselves first. */
export const SCAN_TIMEOUT_MS = 240_000;

/**
 * Per-scan mutable state shared by the model-calling stages. Once upstream
 * reports the account is out of credits (HTTP 402), every remaining call in
 * this scan will fail the same way — so the stages stop asking and say so
 * once, instead of burning a dozen requests to collect a dozen copies of the
 * same error. Created per scan, never module-level: it must not leak between
 * requests.
 *
 * `usage` accumulates what every stage actually cost. A scan is dozens of
 * model calls across two models, so the single usage_events row the route
 * writes needs the total, not any one call's figure.
 *
 * `modelCalls` counts completions that actually came back, and is tracked
 * separately from `usage` on purpose. The route uses it to decide whether a
 * scan did any billable work at all, and that decision must not depend on
 * whether upstream reported cost numbers: a provider that returns no
 * `usage` object would otherwise make every scan look free and refund
 * itself.
 */
export type ScanBudget = {
  creditsExhausted: boolean;
  /**
   * Set when upstream rejected the API key (HTTP 401). Same reasoning as
   * `creditsExhausted` and deliberately a separate flag rather than a shared
   * "stop calling" boolean: the two have different causes, different fixes,
   * and different notes in the report, and merging them would put "out of
   * credits" in front of someone whose key was revoked.
   */
  authFailed: boolean;
  usage: CompletionUsage;
  modelCalls: number;
};

export function newScanBudget(): ScanBudget {
  return { creditsExhausted: false, authFailed: false, usage: EMPTY_USAGE, modelCalls: 0 };
}

/**
 * Folds one completed call into the running per-scan totals. Called only
 * after a model actually responded — a request that threw was never billed.
 */
export function addScanUsage(budget: ScanBudget, usage: CompletionUsage) {
  budget.usage = addUsage(budget.usage, usage);
  budget.modelCalls += 1;
}

/**
 * The one thing that stopped a scan dead, when something did.
 *
 * Both values are account-level faults rather than anything about the
 * repository, and both make every remaining call fail identically — which is
 * exactly why the report has to name them. Without this the banner could say
 * only *that* no file was reviewed, and the cause sat in a collapsed details
 * list at the bottom, so the reader's next move was to re-run the scan rather
 * than to go add credits or replace a key.
 */
export type ScanBlocker = "credits" | "auth" | null;

export function blockerFor(budget: ScanBudget): ScanBlocker {
  if (budget.authFailed) return "auth";
  if (budget.creditsExhausted) return "credits";
  return null;
}

export const OUT_OF_CREDITS_NOTE =
  "Skipped — the scanner's model provider ran out of credit or quota earlier in this scan.";

/**
 * Says "rejected", not "unavailable". The distinction is the whole point: an
 * outage is worth retrying and a revoked key never is, and a note that blurs
 * them sends the reader back around the same investigation.
 */
export const AUTH_FAILED_NOTE =
  "Skipped — the scanner's model API key was rejected (401) earlier in this scan. Every remaining call would fail identically.";

/**
 * Path/content keywords that mark a file as security-relevant. Files matching
 * on **path** form the never-skipped tier; a content match only raises a
 * file's rank. That split is deliberate: a substring like `user` or `api`
 * appears in the body of nearly every file in a typical web app, so treating
 * content matches as never-skippable would make every cap unenforceable.
 */
export const PRIORITY_KEYWORDS = [
  "auth",
  "admin",
  "payment",
  "user",
  "config",
  "env",
  "api",
  "migration",
] as const;
