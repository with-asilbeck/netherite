import { createClient } from "@/lib/supabase/server";
import {
  OpenRouterRequestError,
  readChatCompletionDeltas,
  requestChatCompletionStream,
  type ChatMessage,
} from "@/lib/openrouter";

// Conversation ids are nanoid() tokens: 21 chars, URL-safe alphabet.
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{21}$/;

const MAX_MESSAGES = 50;
const MAX_MESSAGE_LENGTH = 6000;
const MAX_CONTEXT_MESSAGES = 30;

type ChatRequestBody = {
  conversationId?: unknown;
  messages?: unknown;
};

function validateMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) {
    return null;
  }

  const messages: ChatMessage[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }

    const role = (entry as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") {
      return null;
    }

    const content = (entry as { content?: unknown }).content;
    if (
      typeof content !== "string" ||
      content.length === 0 ||
      content.length > MAX_MESSAGE_LENGTH
    ) {
      return null;
    }

    messages.push({ role, content });
  }

  if (messages[messages.length - 1].role !== "user") {
    return null;
  }

  return messages;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json(
      { error: "Please log in to use the security advisor." },
      { status: 401 },
    );
  }

  let body: ChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (
    typeof body.conversationId !== "string" ||
    !CONVERSATION_ID_RE.test(body.conversationId)
  ) {
    return Response.json(
      { error: "Invalid or missing conversationId." },
      { status: 400 },
    );
  }
  const conversationId = body.conversationId;

  const messages = validateMessages(body.messages);
  if (!messages) {
    console.error("[chat] rejected messages payload:", JSON.stringify(body.messages));
    return Response.json({ error: "Invalid messages." }, { status: 400 });
  }

  const lastMessage = messages[messages.length - 1];

  const userInsertPayload = {
    user_id: user.id,
    conversation_id: conversationId,
    role: "user" as const,
    content: lastMessage.content,
  };
  console.log("[chat] inserting user message:", JSON.stringify(userInsertPayload));

  const { error: insertUserError } = await supabase
    .from("chat_messages")
    .insert(userInsertPayload);

  if (insertUserError) {
    console.error("[chat] Supabase insert (user message) failed:", insertUserError);
    return Response.json(
      { error: "Couldn't save your message. Please try again." },
      { status: 500 },
    );
  }

  const contextMessages = messages.slice(-MAX_CONTEXT_MESSAGES);
  console.log(
    "[chat] sending to OpenRouter:",
    JSON.stringify(contextMessages.map((m) => ({ role: m.role, length: m.content.length }))),
  );

  let openRouterBody: ReadableStream<Uint8Array>;
  try {
    openRouterBody = await requestChatCompletionStream(contextMessages);
  } catch (err) {
    if (err instanceof OpenRouterRequestError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json(
      { error: "The security advisor is temporarily unavailable. Please try again shortly." },
      { status: 502 },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let fullText = "";

      try {
        for await (const delta of readChatCompletionDeltas(openRouterBody)) {
          fullText += delta;
          controller.enqueue(encoder.encode(`${JSON.stringify({ delta })}\n`));
        }
      } catch {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              error: "Lost connection to the security advisor. Please try again.",
            })}\n`,
          ),
        );
      }

      if (fullText.trim().length > 0) {
        const { error: insertAssistantError } = await supabase
          .from("chat_messages")
          .insert({
            user_id: user.id,
            conversation_id: conversationId,
            role: "assistant",
            content: fullText,
          });

        if (insertAssistantError) {
          console.error(
            "[chat] Supabase insert (assistant message) failed:",
            insertAssistantError,
          );
        }
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
