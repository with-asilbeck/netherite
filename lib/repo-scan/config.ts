// Hard limits for the repo-scan pipeline. Every one of these exists so a
// scan terminates with a clear message instead of hanging or running the
// bill up — a public-facing endpoint that clones arbitrary repos has to
// assume it will eventually be pointed at a huge or hostile one.

/** Per-file size ceiling. Anything larger is excluded, not truncated. */
export const MAX_FILE_BYTES = 500 * 1024;

/** Files kept after filtering. Beyond this, the lowest-risk tail is dropped. */
export const MAX_FILES = 400;

/** Total bytes of source we're willing to hold and reason about. */
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

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
 */
export type ScanBudget = { creditsExhausted: boolean };

export function newScanBudget(): ScanBudget {
  return { creditsExhausted: false };
}

export const OUT_OF_CREDITS_NOTE =
  "Skipped — the scanner ran out of OpenRouter credits earlier in this scan.";

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
