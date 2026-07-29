import { createClient } from "@/lib/supabase/server";
import { CONVERSATION_ID_RE, ensureConversation } from "@/lib/conversations";
import { checkGuestChatRateLimit } from "@/lib/rate-limit";
import {
  OpenRouterRequestError,
  readChatCompletionDeltas,
  requestChatCompletionStream,
  type ChatMessage,
} from "@/lib/openrouter";

const MAX_MESSAGES = 50;
const MAX_CONTEXT_MESSAGES = 30;

// Guests get a strict, small cap — anonymous and IP-rate-limited only.
// Authenticated users get a much larger one so an attached file's text
// (see app/api/attachments/route.ts, capped at 20k chars there) plus a
// normal question comfortably fits as one message. This never loosens the
// guest-facing limit — it only raises the ceiling once there's a real,
// verified account behind the request.
const MAX_MESSAGE_LENGTH_GUEST = 6000;
const MAX_MESSAGE_LENGTH_AUTHENTICATED = 30000;

type ChatRequestBody = {
  conversationId?: unknown;
  messages?: unknown;
};

function validateMessages(raw: unknown, maxMessageLength: number): ChatMessage[] | null {
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
      content.length > maxMessageLength
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

  // No login gate: guests can chat too (message content just isn't
  // persisted — see below). Being public-facing, unauthenticated requests
  // are rate limited per IP instead.
  if (!user) {
    const rateLimit = checkGuestChatRateLimit(request);
    if (!rateLimit.allowed) {
      return Response.json(
        {
          error:
            "You've reached the guest message limit. Sign in for unlimited access, or try again later.",
        },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
        },
      );
    }
  }

  let body: ChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  // conversationId only means anything for a persisted, authenticated
  // conversation — guests never have one, so it's neither required nor
  // trusted from the request body unless there's a real session.
  let conversationId: string | null = null;
  if (user) {
    if (
      typeof body.conversationId !== "string" ||
      !CONVERSATION_ID_RE.test(body.conversationId)
    ) {
      return Response.json(
        { error: "Invalid or missing conversationId." },
        { status: 400 },
      );
    }
    conversationId = body.conversationId;
  }

  const messages = validateMessages(
    body.messages,
    user ? MAX_MESSAGE_LENGTH_AUTHENTICATED : MAX_MESSAGE_LENGTH_GUEST,
  );
  if (!messages) {
    console.error("[chat] rejected messages payload:", JSON.stringify(body.messages));
    return Response.json({ error: "Invalid messages." }, { status: 400 });
  }

  const lastMessage = messages[messages.length - 1];

  // Persistence requires both a verified session and a validated
  // conversation — guests get neither, so this never runs for them.
  if (user && conversationId) {
    // "New chat" now mints its id in the browser and navigates immediately,
    // so the very first message of a conversation is the point at which its
    // row has to exist. Idempotent: a no-op for every later message, and it
    // cannot claim an id that already belongs to somebody else (ON CONFLICT
    // DO NOTHING). The chat_messages insert below is what actually enforces
    // ownership — its RLS policy joins to conversations.user_id, so a
    // request aimed at another user's conversation fails there.
    const ensured = await ensureConversation(supabase, user.id, conversationId);
    if (ensured.error) {
      return Response.json({ error: ensured.error }, { status: 500 });
    }

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

      if (user && conversationId && fullText.trim().length > 0) {
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
