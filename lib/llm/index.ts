/**
 * The app's LLM surface.
 *
 * Every model call goes through here. Callers name a model and this picks the
 * vendor client for it — nothing upstream knows whether a stage is served by
 * Anthropic or Google, which is what lets `MODEL_TIERS` move a tier from one
 * to the other without touching the pipeline.
 *
 * Replaces lib/openrouter.ts. The exported shapes are deliberately unchanged
 * from that module so the migration stayed inside this directory; what
 * changed underneath is that there are now two vendors, two keys, and cost is
 * computed from a price table rather than reported by a broker.
 */

import { anthropicCompletion } from "./anthropic";
import { LlmRequestError, authFailureLog } from "./errors";
import { googleCompletion, googleCompletionStream, readGoogleDeltas } from "./google";
import { providerFor } from "./models";
import type { ChatMessage, CompletionUsage, ReasoningEffort } from "./types";
import { CHAT_ADVISOR_MODEL } from "./models";

export {
  CHAT_ADVISOR_MODEL,
  MODEL_PRICING,
  MODEL_TIERS,
  SCAN_BEST_MODEL,
  SCAN_DEEP_MODEL,
  SCAN_TRIAGE_MODEL,
  computeCostUsd,
  providerFor,
  type ModelPricing,
  type Provider,
  type ScanModels,
} from "./models";

export {
  CHAT_ADVISOR_SYSTEM_PROMPT,
  DEEP_EXPLOIT_ANALYSIS_INSTRUCTIONS,
  STRUCTURED_REPORT_INSTRUCTIONS,
} from "./prompts";

export {
  EMPTY_USAGE,
  addUsage,
  usageFrom,
  type ChatMessage,
  type ChatRole,
  type CompletionUsage,
  type ReasoningEffort,
} from "./types";

export { LlmRequestError } from "./errors";

/**
 * The five statuses worth distinguishing, in the scanner's words.
 *
 * Each has a different fix, and collapsing them into "unavailable" sent a real
 * credit exhaustion, a real dead model id, and a real revoked key to the same
 * unhelpful message. 402 is synthesised for both vendors — see
 * lib/llm/errors.ts, since neither reports billing failure as a bare 402 the
 * way OpenRouter did.
 */
function scanFailureMessage(status: number, model: string): string {
  if (status === 401) {
    return "The scanner's API key was rejected (401) — it's expired, revoked, or from a deleted account. Nothing was scanned. This needs a new key, not a retry.";
  }
  if (status === 402) {
    return "The scanner's model account is out of credit or over quota. Findings already produced are still valid, but the remaining files weren't reviewed.";
  }
  if (status === 429) {
    return "The scanner is being rate limited upstream. Please try again in a moment.";
  }
  if (status === 404) {
    return `The scanner is configured with a model that no longer exists (${model}). This needs a code change, not a retry.`;
  }
  return "The scanner's model backend is unavailable right now.";
}

function chatFailureMessage(status: number): string {
  if (status === 401) {
    return "The security advisor's API key was rejected — it's expired or revoked. This needs a new key, not a retry.";
  }
  if (status === 402) {
    return "The security advisor's model account is out of credit or over quota.";
  }
  if (status === 429) {
    return "The security advisor is getting a lot of requests right now. Please try again in a moment.";
  }
  if (status === 404) {
    // Added after a live 404 on a retired model id read to the user as
    // "temporarily unavailable" — advice to wait, for a fault that waiting
    // cannot fix. The scan path already distinguished this; chat did not.
    return "The security advisor is pointed at a model that no longer exists. This needs a code change, not a retry.";
  }
  return "The security advisor is temporarily unavailable. Please try again shortly.";
}

const KEY_ENV_VAR = { anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY" } as const;

/**
 * Rewrites a vendor error into the caller's vocabulary, logging the vendor's
 * own words first. A 500 from a missing key is passed through untouched —
 * it already names the variable to set.
 */
function rethrow(err: unknown, model: string, surface: "scan" | "chat"): never {
  if (!(err instanceof LlmRequestError)) throw err;
  if (err.status === 500) throw err;

  const tag = surface === "scan" ? "[repo-scan]" : "[chat]";
  console.error(`${tag} model call failed:`, model, err.status, err.detail);

  if (err.status === 401) {
    console.error(authFailureLog(providerFor(model), KEY_ENV_VAR[providerFor(model)]));
  }

  throw new LlmRequestError(
    err.status,
    surface === "scan" ? scanFailureMessage(err.status, model) : chatFailureMessage(err.status),
    err.detail,
  );
}

/**
 * Non-streaming completion, for the repo-scan pipeline: it makes many small
 * calls whose full text is needed before the next step can run, so there's
 * nothing to stream to.
 */
export async function requestChatCompletion({
  model,
  system,
  messages,
  maxTokens,
  signal,
  // Defaults to `minimal`, which is what triage and chat have always sent.
  // Only the Google client acts on it: Anthropic's thinking is decided per
  // model id inside anthropic.ts, and a stage asking for `high` there today
  // would be asking a model it cannot reach. Wire it through when
  // ANTHROPIC_API_KEY lands — see TODO(anthropic-swap-back) in models.ts.
  reasoning,
}: {
  model: string;
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  signal?: AbortSignal;
  reasoning?: ReasoningEffort;
}): Promise<{ content: string; usage: CompletionUsage }> {
  try {
    return providerFor(model) === "anthropic"
      ? await anthropicCompletion({ model, system, messages, maxTokens, signal })
      : await googleCompletion({ model, system, messages, maxTokens, signal, reasoning });
  } catch (err) {
    rethrow(err, model, "scan");
  }
}

/**
 * `systemPrompt` is required rather than defaulted. The caller assembles it
 * from the tier's features (lib/tier-features.ts#withFeaturePrompts), and a
 * default here would mean a route that forgot to pass one silently served
 * the wrong tier's behaviour instead of failing to compile.
 */
export async function requestChatCompletionStream(
  messages: ChatMessage[],
  systemPrompt: string,
) {
  try {
    return await googleCompletionStream({
      model: CHAT_ADVISOR_MODEL,
      system: systemPrompt,
      messages,
      maxTokens: 2048,
    });
  } catch (err) {
    rethrow(err, CHAT_ADVISOR_MODEL, "chat");
  }
}

export function readChatCompletionDeltas(
  stream: Awaited<ReturnType<typeof requestChatCompletionStream>>,
  onUsage?: (usage: CompletionUsage) => void,
) {
  return readGoogleDeltas(stream, CHAT_ADVISOR_MODEL, onUsage);
}
