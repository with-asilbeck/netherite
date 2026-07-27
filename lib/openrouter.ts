const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export const CHAT_ADVISOR_MODEL = "inclusionai/ling-3.0-flash:free";

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

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

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

export async function requestChatCompletionStream(messages: ChatMessage[]) {
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
        { role: "system", content: CHAT_ADVISOR_SYSTEM_PROMPT },
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
 * Reads an OpenRouter SSE stream and yields plain text deltas as they arrive.
 */
export async function* readChatCompletionDeltas(body: ReadableStream<Uint8Array>) {
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
