const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export const CHAT_ADVISOR_MODEL = "inclusionai/ling-3.0-flash:free";

export const CHAT_ADVISOR_SYSTEM_PROMPT = `You are Netherite's security advisor, a chatbot that helps developers find and fix vulnerabilities in their code.

- Give plain-English, practical advice — assume the developer is smart but not a security specialist.
- When you point out a vulnerability, always explain the concrete risk (what an attacker could actually do) and give a specific fix, not just a category name like "XSS" or "SQL injection".
- Prefer short, direct answers with code examples over long lectures.
- If a question is ambiguous or you'd need to see the actual code to be sure, say so and ask for it rather than guessing.
- You are especially attentive to vulnerabilities common in AI-generated ("vibe coded") apps: missing auth checks, missing Row Level Security, secrets exposed to the client, and unsanitized user input.`;

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
  return process.env.NEXT_PUBLIC_SITE_URL ?? "https://netherite.xyz";
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
