const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export const CHAT_ADVISOR_MODEL = "inclusionai/ling-3.0-flash:free";

// Repo scanning uses the split CLAUDE.md assigns: a cheap model for the Tier
// 1 yes/no triage pass over every candidate file, and the strong one only for
// the handful of files Tier 1 flags.
//
// Both ids are the ones CLAUDE.md specifies — see the reasoning recorded
// there before changing either. In short: the triage model replaced
// `google/gemini-2.0-flash-001`, which is retired and 404s on OpenRouter
// ("No endpoints found"), silently escalating every file instead of filtering
// it; and `gemini-2.5-flash-lite` is not a substitute, having contradicted
// itself on a trivial SQL injection probe.
export const SCAN_TRIAGE_MODEL = "google/gemini-2.5-flash";
export const SCAN_DEEP_MODEL = "anthropic/claude-sonnet-4.6";

/**
 * The strongest model available on OpenRouter, used for both scan stages on
 * the Max tier's `best` model tier. Confirmed present in
 * `GET /api/v1/models` before being written here, as CLAUDE.md requires.
 *
 * Worth knowing before raising anyone else to `best`: this runs on the
 * *triage* pass too, which is ~38 calls over 150 files per scan, so a Max
 * scan costs roughly an order of magnitude more than a `fast` one. That is
 * a deliberate product decision recorded in lib/tiers.ts, not an accident
 * of configuration.
 */
export const SCAN_BEST_MODEL = "anthropic/claude-opus-5";

/**
 * Which model each scan stage uses, per tier's `model_tier`.
 *
 * `fast` is the split CLAUDE.md describes: a cheap model filters every
 * candidate file, the strong one reviews only what the filter flags.
 * `best` drops the cheap filter entirely and runs the strongest model over
 * both stages — the point being that the surface pass stops being a filter
 * that can miss things and becomes a review in its own right.
 */
export const MODEL_TIERS = {
  fast: { triage: SCAN_TRIAGE_MODEL, deep: SCAN_DEEP_MODEL },
  best: { triage: SCAN_BEST_MODEL, deep: SCAN_BEST_MODEL },
} as const satisfies Record<string, { triage: string; deep: string }>;

export type ScanModels = { triage: string; deep: string };

export const CHAT_ADVISOR_SYSTEM_PROMPT = `You are the Netherite Security Advisor — a specialized AI assistant focused
exclusively on application security, secure coding practices, and
vulnerability remediation for developers.

## Scope
You help with:
- Identifying and explaining security vulnerabilities (SQLi, XSS, IDOR,
  broken auth, CSRF, insecure deserialization, exposed secrets, misconfigured
  RLS/access controls, etc.)
- Reviewing code snippets for security issues
- Explaining security concepts, CVEs, and attack patterns in plain English
- Recommending secure patterns and providing corrected code
- Answering questions about authentication, authorization, encryption,
  API security, dependency risks, and secure architecture
- General secure development best practices (input validation, least
  privilege, secrets management, secure defaults)

## Out of scope
You do not help with:
- Topics unrelated to security or software development (general chit-chat,
  personal advice, unrelated technical support, creative writing, etc.)
- Writing offensive/exploit tooling intended for unauthorized use against
  systems the user doesn't own or have explicit permission to test
- Anything that isn't defensive security, secure coding, or vulnerability
  understanding/remediation

If a request falls outside this scope, politely redirect: acknowledge
what they asked, explain you're focused specifically on security and
secure development, and ask if they have a security-related question
instead. Don't be preachy about it — one sentence, then move on.

## Tone and format
- Plain English first, jargon explained when used, not assumed
- When identifying a vulnerability: state the risk in one sentence, then
  give a concrete fix (code block if applicable)
- Be direct and practical — developers want the fix, not a lecture
- If something is ambiguous or you need more code/context to give a
  confident answer, ask for it rather than guessing
- Never fabricate a CVE number, vulnerability class, or fix if you're
  not confident — say what you don't know

## Boundaries on offensive use
You can explain how a vulnerability could be exploited (this is necessary
to convey risk and is standard in security education), but you do not
write ready-to-run exploit code, malware, or attack tooling targeting
systems the user hasn't confirmed they own or are authorized to test. If
someone asks you to attack a specific third-party system, decline and
explain you only help secure systems the person controls.`;

// ── Feature-gated prompt fragments ──────────────────────────────────────
//
// Appended to a base system prompt when the caller's tier includes the
// feature. They are additive fragments rather than alternate whole prompts
// so the shared instructions have one definition, and so a tier can never
// end up with a prompt that silently lost the scope or safety sections.
//
// Every caller assembles these from a `Tier` that came out of the
// subscriptions table. There is no code path where a request body chooses
// which fragments are included.

export const DEEP_EXPLOIT_ANALYSIS_INSTRUCTIONS = `
## Exploit-chain analysis

Do not stop at naming a vulnerability. For each real issue, work out how it
would actually be used against this code:

- The concrete first move — the request, input, or file an attacker sends,
  written out specifically enough to be reproduced.
- What that single step gains them (data read, state changed, check skipped).
- What it lets them reach next: chain it with anything else visible in the
  code, including issues that would be minor on their own.
- The realistic worst outcome of the full chain, and what an attacker would
  still need that they don't have.

Stay grounded in the code you were given. If a chain depends on something you
cannot see — another service, a deployment detail, a permission model — say
which assumption it rests on rather than asserting it. A short chain you can
actually justify is worth more than a long speculative one.`;

export const STRUCTURED_REPORT_INSTRUCTIONS = `
## Structured report format

Present findings as a structured report that can be exported and handed to
somebody else. For each issue, use exactly this shape:

### <ID> — <title>

| | |
|---|---|
| **Severity** | Critical / High / Medium / Low |
| **Class** | e.g. SQL injection, IDOR, broken auth |
| **Location** | \`<path>\`:<line> |
| **Confidence** | Confirmed / Likely |

**Risk:** <one sentence, plain English, what an attacker actually gains.>

**Detail:** <what is wrong and why the code allows it.>

**Fix:**
\`\`\`<language>
<the complete corrected function or block, ready to drop in>
\`\`\`

Number IDs sequentially from 1 as \`NTH-001\`, \`NTH-002\`, and so on. Order
findings by severity, highest first. Assign severity from real impact on this
code, not from the vulnerability class in the abstract. Use **Confidence:
Likely** whenever you cannot point at the exact line that proves it.

Close with a \`### Summary\` section: a one-line count by severity, then the
single thing you would fix first and why.`;

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

/**
 * Real cost data, as reported by OpenRouter rather than estimated from a
 * hardcoded price table. OpenRouter returns a `usage` object on every
 * response (its usage-accounting docs: no request parameter is needed, and
 * for streams it arrives in the final SSE message).
 *
 * `costUsd` is what OpenRouter actually charged the account for the call.
 * Both fields are nullable because a model or a proxy hop can omit them,
 * and a missing number must degrade to "unknown", never to zero — a zero
 * would quietly understate real spend on the dashboard.
 */
export type CompletionUsage = {
  tokensUsed: number | null;
  costUsd: number | null;
};

/** Defensive read of the `usage` object — any field may be missing. */
export function parseUsage(raw: unknown): CompletionUsage {
  const usage = raw as { total_tokens?: unknown; cost?: unknown } | null | undefined;
  const tokens = usage?.total_tokens;
  const cost = usage?.cost;
  return {
    tokensUsed: typeof tokens === "number" && Number.isFinite(tokens) ? tokens : null,
    costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
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

export const EMPTY_USAGE: CompletionUsage = { tokensUsed: null, costUsd: null };

export class OpenRouterRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "OpenRouterRequestError";
    this.status = status;
  }
}

function siteUrl() {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.netherite.uz";
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
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new OpenRouterRequestError(
      500,
      "The security advisor isn't configured yet — missing OPENROUTER_API_KEY.",
    );
  }

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": siteUrl(),
      "X-Title": "Netherite",
    },
    body: JSON.stringify({
      model: CHAT_ADVISOR_MODEL,
      stream: true,
      max_tokens: 2048,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
    }),
  });

  if (!response.ok || !response.body) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body?.error?.message ?? "";
    } catch {
      // Response wasn't JSON — fall through to the generic message below.
    }

    if (detail) {
      console.error("OpenRouter request failed:", response.status, detail);
    }

    if (response.status === 429) {
      throw new OpenRouterRequestError(
        429,
        "The security advisor is getting a lot of requests right now. Please try again in a moment.",
      );
    }

    throw new OpenRouterRequestError(
      response.status || 502,
      "The security advisor is temporarily unavailable. Please try again shortly.",
    );
  }

  return response.body;
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
  temperature = 0,
  signal,
}: {
  model: string;
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<{ content: string; usage: CompletionUsage }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new OpenRouterRequestError(
      500,
      "Scanning isn't configured yet — missing OPENROUTER_API_KEY.",
    );
  }

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": siteUrl(),
      "X-Title": "Netherite",
    },
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body?.error?.message ?? "";
    } catch {
      // Not JSON — the status alone has to carry the message.
    }
    console.error("[repo-scan] OpenRouter call failed:", model, response.status, detail);

    // These three are worth distinguishing: each has a different fix, and
    // collapsing them into "unavailable" sent a real credit exhaustion and a
    // real dead model id to the same unhelpful message.
    let message: string;
    if (response.status === 402) {
      message =
        "The scanner ran out of OpenRouter credits mid-scan. Top up at openrouter.ai/settings/credits — findings already produced are still valid, but the remaining files weren't reviewed.";
    } else if (response.status === 429) {
      message = "The scanner is being rate limited upstream. Please try again in a moment.";
    } else if (response.status === 404) {
      message = `The scanner is configured with a model that no longer exists (${model}). This needs a code change, not a retry.`;
    } else {
      message = "The scanner's model backend is unavailable right now.";
    }

    throw new OpenRouterRequestError(response.status || 502, message);
  }

  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new OpenRouterRequestError(502, "The model returned an unreadable response.");
  }
  return { content, usage: parseUsage(body?.usage) };
}

/**
 * Reads an OpenRouter SSE stream and yields plain text deltas as they arrive.
 *
 * `onUsage` receives the cost figures from the final SSE message, which is
 * where OpenRouter puts them for streamed responses. It's a callback rather
 * than a return value because the caller consumes this as an async iterator
 * and a generator's return value isn't visible to `for await`.
 */
export async function* readChatCompletionDeltas(
  body: ReadableStream<Uint8Array>,
  onUsage?: (usage: CompletionUsage) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const payload = trimmed.slice("data:".length).trim();
        if (payload === "[DONE]") return;

        try {
          const parsed = JSON.parse(payload);

          // Usage rides on the last message, which typically carries no
          // delta of its own — so check for it before the content branch
          // rather than inside it.
          if (parsed?.usage && onUsage) {
            onUsage(parseUsage(parsed.usage));
          }

          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            yield delta;
          }
        } catch {
          // Ignore malformed/partial SSE chunks (e.g. keep-alive comments).
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
