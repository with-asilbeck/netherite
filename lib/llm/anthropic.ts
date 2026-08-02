import Anthropic from "@anthropic-ai/sdk";
import { LlmRequestError, normalizeLlmError } from "./errors";
import { finiteOrNull, usageFrom, type ChatMessage, type CompletionUsage } from "./types";

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new LlmRequestError(
      500,
      "Scanning isn't configured yet — missing ANTHROPIC_API_KEY.",
    );
  }
  // Memoised across requests: the client is a thin wrapper over `fetch` with
  // no per-request state, and rebuilding it on every call throws away the
  // agent's connection pool.
  if (!client) client = new Anthropic({ apiKey });
  return client;
}

/**
 * Models that think unless told not to.
 *
 * This is the sharpest edge in the migration. On Claude Opus 5 thinking is
 * **on by default** — omitting the parameter runs adaptive thinking, unlike
 * Sonnet 4.6 where omitting it means no thinking at all. `max_tokens` caps
 * thinking *plus* reply together, so the Max tier's triage pass, which asks
 * for 500 tokens of JSON, would spend the entire budget reasoning and return
 * a truncated answer. Every call here is a filter or a report with a known
 * output shape, so thinking is switched off explicitly and the token budgets
 * keep meaning what the callers think they mean.
 */
const THINKS_BY_DEFAULT = new Set(["claude-opus-5"]);

/**
 * Appended when thinking is disabled on a model that would otherwise think.
 *
 * With thinking off, Claude Opus 5 can leak `<thinking>` tags into the
 * visible response. The instruction is deliberately generic: naming the tags
 * is measurably *less* effective than this phrasing, and an instruction
 * telling the model not to reason makes the leakage worse rather than better.
 */
const NO_INTERNAL_TAGS =
  "\n\nDo not include internal or system XML tags in your response.";

export async function anthropicCompletion({
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
}): Promise<{ content: string; usage: CompletionUsage }> {
  const thinksByDefault = THINKS_BY_DEFAULT.has(model);

  try {
    const response = await anthropic().messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: thinksByDefault ? system + NO_INTERNAL_TAGS : system,
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        // Only sent where it is needed. Sonnet 4.6 does not think unless
        // asked, so it gets no `thinking` field at all.
        ...(thinksByDefault ? { thinking: { type: "disabled" as const } } : {}),
        // No `temperature`. It was `0` under OpenRouter, but sampling
        // parameters are removed on Claude Opus 5 and sending one is a 400 —
        // determinism comes from the prompts instead.
      },
      { signal },
    );

    // `content` is a discriminated union; a thinking or tool block would not
    // have `.text`, so the text blocks are selected rather than indexed.
    const content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    if (!content) {
      // A refusal lands here rather than as a thrown error: the HTTP call
      // succeeded and the model declined, which is a content outcome.
      if (response.stop_reason === "refusal") {
        throw new LlmRequestError(
          502,
          "The model declined to analyze this input.",
          `stop_reason=refusal category=${response.stop_details?.category ?? "unknown"}`,
        );
      }
      throw new LlmRequestError(502, "The model returned an unreadable response.");
    }

    return {
      content,
      usage: usageFrom(
        model,
        finiteOrNull(response.usage?.input_tokens),
        finiteOrNull(response.usage?.output_tokens),
      ),
    };
  } catch (err) {
    normalizeLlmError(err, model);
  }
}
