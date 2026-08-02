import {
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentConfig,
  type GenerateContentResponse,
} from "@google/genai";
import { LlmRequestError, normalizeLlmError } from "./errors";
import {
  finiteOrNull,
  usageFrom,
  type ChatMessage,
  type CompletionUsage,
  type ReasoningEffort,
} from "./types";

let client: GoogleGenAI | null = null;

function google(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new LlmRequestError(
      500,
      "The model backend isn't configured yet — missing GEMINI_API_KEY.",
    );
  }
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

/**
 * Gemini calls the assistant side of a conversation `model`, not `assistant`.
 *
 * Sending the OpenAI-shaped role straight through is accepted by the request
 * validator and then silently mis-attributes prior turns, so the mapping is
 * explicit rather than a cast.
 */
function toContents(messages: ChatMessage[]) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));
}

/**
 * Gemini Flash thinks by default, and thinking tokens are billed as output
 * and counted against `maxOutputTokens`.
 *
 * **`thinkingLevel`, not `thinkingBudget`.** The numeric `thinkingBudget: 0`
 * that disables thinking on Gemini 2.x is rejected outright by some 3.x
 * models (`400 Request contains an invalid argument`) and silently ignored by
 * others — measured on `gemini-3.5-flash`, where it left thinking fully on
 * and turned a 44-token verdict into a 29-second call. `MINIMAL` is the
 * control that actually works; `thoughtsTokenCount: 0` on the response is how
 * to confirm it took effect.
 *
 * Triage and chat both have a known output shape — a JSON verdict per file,
 * or a chat reply — so `minimal` keeps token budgets meaning what the callers
 * intend and keeps triage fast enough to run ~38 times per scan.
 *
 * `high` exists for the deep-review stage, which is the opposite case: its
 * output *is* the product, and while the deep stage is served by the same
 * Flash model as triage (see the TODO in models.ts), reasoning depth is the
 * only lever left that still separates the two passes. Its cost is real —
 * thinking tokens are billed as output and counted against `maxOutputTokens`,
 * so a caller asking for `high` must budget for them. deep-scan.ts does.
 */
const THINKING: Record<ReasoningEffort, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  high: ThinkingLevel.HIGH,
};

function baseConfig(
  system: string,
  maxTokens: number,
  signal?: AbortSignal,
  reasoning: ReasoningEffort = "minimal",
): GenerateContentConfig {
  return {
    systemInstruction: system,
    maxOutputTokens: maxTokens,
    // Unlike Anthropic, Google still accepts sampling parameters, and the
    // triage stage genuinely wants the most deterministic verdict it can get.
    temperature: 0,
    thinkingConfig: { thinkingLevel: THINKING[reasoning] },
    abortSignal: signal,
  };
}

/**
 * Thinking tokens are output tokens, and `candidatesTokenCount` does not
 * include them.
 *
 * The SDK is explicit that `totalTokenCount` is the *sum* of prompt,
 * candidates, tool-use and thoughts — so the two are disjoint, and Google
 * bills thoughts at the output rate. Counting candidates alone was harmless
 * for as long as every call sent `thinkingLevel: MINIMAL` and came back with
 * `thoughtsTokenCount: 0`. The deep-review stage now asks for `high`, where a
 * measured call returned 6 candidate tokens against 584 thought tokens — a
 * ~97× understatement of what that call cost, silently, on the spend
 * dashboard. Adding them keeps the invariant models.ts claims: output tokens
 * are where thinking is paid for.
 */
function usageOf(model: string, response: GenerateContentResponse | undefined): CompletionUsage {
  const meta = response?.usageMetadata;
  const candidates = finiteOrNull(meta?.candidatesTokenCount);
  const thoughts = finiteOrNull(meta?.thoughtsTokenCount);
  // null only when neither was reported — a present zero is a real zero, and
  // must not be turned back into "we never learned" by the addition.
  const output =
    candidates === null && thoughts === null ? null : (candidates ?? 0) + (thoughts ?? 0);

  return usageFrom(model, finiteOrNull(meta?.promptTokenCount), output);
}

export async function googleCompletion({
  model,
  system,
  messages,
  maxTokens,
  signal,
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
    const response = await google().models.generateContent({
      model,
      contents: toContents(messages),
      config: baseConfig(system, maxTokens, signal, reasoning),
    });

    const content = response.text;
    if (typeof content !== "string" || content.length === 0) {
      throw new LlmRequestError(
        502,
        "The model returned an unreadable response.",
        `finishReason=${response.candidates?.[0]?.finishReason ?? "unknown"}`,
      );
    }

    return { content, usage: usageOf(model, response) };
  } catch (err) {
    normalizeLlmError(err, model);
  }
}

/**
 * Opens the stream and returns it without reading a token.
 *
 * The split between opening and reading is load-bearing for the chat route:
 * everything that can fail with a status — a rejected key, a rate limit —
 * fails on this call, which happens *before* the route commits a 200 and
 * starts its `ReadableStream`. Once reading begins there is no longer a way
 * to send an error status, only a message inside the body.
 */
export async function googleCompletionStream({
  model,
  system,
  messages,
  maxTokens,
  signal,
}: {
  model: string;
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  signal?: AbortSignal;
}): Promise<AsyncGenerator<GenerateContentResponse>> {
  try {
    return await google().models.generateContentStream({
      model,
      contents: toContents(messages),
      config: baseConfig(system, maxTokens, signal),
    });
  } catch (err) {
    normalizeLlmError(err, model);
  }
}

/**
 * Yields plain text deltas as they arrive.
 *
 * `onUsage` receives the token counts from the final chunk, which is where
 * Gemini reports them for a stream. It stays a callback rather than a return
 * value because the caller consumes this as an async iterator, and a
 * generator's return value isn't visible to `for await`.
 */
export async function* readGoogleDeltas(
  stream: AsyncGenerator<GenerateContentResponse>,
  model: string,
  onUsage?: (usage: CompletionUsage) => void,
): AsyncGenerator<string> {
  let last: GenerateContentResponse | undefined;

  for await (const chunk of stream) {
    // Every chunk carries cumulative usage on Gemini, so the last one seen is
    // the total — tracked outside the loop rather than summed.
    if (chunk.usageMetadata) last = chunk;

    const delta = chunk.text;
    if (typeof delta === "string" && delta.length > 0) {
      yield delta;
    }
  }

  if (onUsage) onUsage(usageOf(model, last));
}
