import { APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import { ApiError as GoogleApiError } from "@google/genai";

/**
 * One error type across both vendors, carrying an HTTP status the callers can
 * branch on.
 *
 * The status codes are kept deliberately stable across the OpenRouter
 * migration — 401 / 402 / 404 / 429 mean the same things they meant before,
 * and the repo-scan stages still key their short-circuits off them. What
 * changed is where those numbers come from: OpenRouter reported one status
 * for every provider, and now each vendor reports its own, with 402 in
 * particular being synthesised (see `statusFromAnthropic`).
 */
export class LlmRequestError extends Error {
  status: number;
  /**
   * What the provider itself said, kept next to the message we show. The two
   * are deliberately separate: `message` is written for whoever hit the
   * failure, `detail` is the vendor's own words. Dropping the second is what
   * let a revoked key present as "the model backend is unavailable".
   */
  detail: string;

  constructor(status: number, message: string, detail = "") {
    super(message);
    this.name = "LlmRequestError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Logged verbatim on any 401, from every call path.
 *
 * A rejected key does not look like an auth problem from the outside. Every
 * call fails at once, in a few hundred milliseconds, across every model —
 * which is the same shape as an upstream outage or a dead model id, and reads
 * as either. This line exists so the log says which one it is instead of
 * leaving it to be worked out by replaying requests by hand.
 */
export function authFailureLog(provider: string, envVar: string): string {
  return [
    `[llm] 401 from ${provider} — the API key was rejected. It is expired, revoked, or from a`,
    "deleted account. This is not a model fault, not a network fault, and no retry will fix it.",
    `Check ${envVar}. Verify a key without spending tokens:`,
    provider === "anthropic"
      ? '  curl -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" https://api.anthropic.com/v1/models'
      : '  curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY"',
  ].join("\n");
}

/**
 * Anthropic has no 402.
 *
 * OpenRouter returned a clean `402 Payment Required` when the account was out
 * of credit, and the whole pipeline was built around that: `budget.creditsExhausted`
 * stops the scan, and the report names billing as the cause. Anthropic reports
 * the same condition as a **400** whose message says the credit balance is too
 * low, so it is translated back to 402 here rather than leaving every stage to
 * pattern-match a sentence. Getting this wrong is not cosmetic — a
 * misclassified billing failure reads as "the model backend is unavailable"
 * and sends the reader looking for an outage that isn't happening.
 */
const ANTHROPIC_BILLING_MARKERS = [
  "credit balance is too low",
  "billing",
  "insufficient funds",
  "purchase credits",
];

function statusFromAnthropic(err: APIError): number {
  const status = typeof err.status === "number" ? err.status : 502;
  if (status === 400) {
    const message = (err.message ?? "").toLowerCase();
    if (ANTHROPIC_BILLING_MARKERS.some((marker) => message.includes(marker))) {
      return 402;
    }
  }
  return status;
}

/**
 * Google reports quota exhaustion as 429 `RESOURCE_EXHAUSTED`, which covers
 * both "too many requests this minute" (retryable) and "this project has no
 * billing / free-tier quota left" (not). Only the second is a 402 in the
 * sense the scan means, so the message has to be read.
 */
const GOOGLE_BILLING_MARKERS = [
  "billing",
  "quota exceeded",
  "exceeded your current quota",
  "free tier",
];

function statusFromGoogle(err: GoogleApiError): number {
  const status = typeof err.status === "number" ? err.status : 502;
  if (status === 429) {
    const message = (err.message ?? "").toLowerCase();
    if (GOOGLE_BILLING_MARKERS.some((marker) => message.includes(marker))) {
      return 402;
    }
  }
  return status;
}

/**
 * Turns whatever a vendor SDK threw into an `LlmRequestError`.
 *
 * An aborted request is rethrown untouched — the scan pipeline distinguishes
 * "we cancelled this" from "it failed" by checking `signal.aborted`, and
 * wrapping the abort in a request error would make a user-cancelled scan
 * report an upstream fault.
 */
export function normalizeLlmError(err: unknown, model: string): never {
  if (err instanceof APIUserAbortError) throw err;
  if (err instanceof LlmRequestError) throw err;

  if (err instanceof APIError) {
    throw new LlmRequestError(statusFromAnthropic(err), err.message, err.message);
  }

  if (err instanceof GoogleApiError) {
    throw new LlmRequestError(statusFromGoogle(err), err.message, err.message);
  }

  // A DOMException named AbortError is what `fetch` raises when the caller's
  // signal fires, and the Google SDK surfaces it unchanged.
  if (err instanceof Error && err.name === "AbortError") throw err;

  throw new LlmRequestError(
    502,
    `The ${model} request failed before a response was returned.`,
    err instanceof Error ? err.message : String(err),
  );
}
