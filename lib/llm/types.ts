import { computeCostUsd } from "./models";

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

/**
 * How hard the model should think before answering, named for the *stage's*
 * need rather than either vendor's spelling of it (Google: `thinkingLevel`,
 * Anthropic: `thinking`).
 *
 * Only two values, because the app only has two kinds of call: a filter with
 * a fixed output shape that wants an answer in ~1s (`minimal`), and a review
 * that is the product itself and can afford to reason (`high`). Anything in
 * between would be a knob nobody is in a position to tune.
 *
 * Honoured by the Google client only. The Anthropic client decides thinking
 * per model id — see THINKS_BY_DEFAULT in anthropic.ts — and nothing calls it
 * while the deep stage is on Gemini.
 */
export type ReasoningEffort = "minimal" | "high";

/**
 * What one call cost, in tokens and dollars.
 *
 * The shape is unchanged from the OpenRouter era so the usage ledger and the
 * cost dashboard keep working, but `costUsd` now means something different:
 * OpenRouter reported the amount it actually charged, and this is *derived*
 * from token counts and the price table in models.ts. A model missing from
 * that table yields null, not zero — see `computeCostUsd`.
 */
export type CompletionUsage = {
  tokensUsed: number | null;
  costUsd: number | null;
};

export const EMPTY_USAGE: CompletionUsage = { tokensUsed: null, costUsd: null };

/**
 * Builds a usage record from a vendor's token counts.
 *
 * `tokensUsed` stays a single total because that is what the `usage_events`
 * row stores; the input/output split only survives long enough to be priced,
 * since the two have different rates and a total alone cannot be costed.
 */
export function usageFrom(
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
): CompletionUsage {
  const total =
    inputTokens === null && outputTokens === null
      ? null
      : (inputTokens ?? 0) + (outputTokens ?? 0);
  return {
    tokensUsed: total,
    costUsd: computeCostUsd(model, inputTokens, outputTokens),
  };
}

export function addUsage(a: CompletionUsage, b: CompletionUsage): CompletionUsage {
  // null + null stays null ("we never learned"), but null + number is the
  // number: a partial total is more useful than discarding what we do know.
  const sum = (x: number | null, y: number | null) =>
    x === null && y === null ? null : (x ?? 0) + (y ?? 0);
  return {
    tokensUsed: sum(a.tokensUsed, b.tokensUsed),
    costUsd: sum(a.costUsd, b.costUsd),
  };
}

/** Defensive read of a number a vendor may or may not have sent. */
export function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
