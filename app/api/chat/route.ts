import { createClient } from "@/lib/supabase/server";
import {
  CONVERSATION_ID_RE,
  createConversationWithFirstMessage,
} from "@/lib/conversations";
import { checkGuestChatRateLimit } from "@/lib/rate-limit";
import {
  CHAT_ADVISOR_MODEL,
  CHAT_ADVISOR_SYSTEM_PROMPT,
  EMPTY_USAGE,
  OpenRouterRequestError,
  readChatCompletionDeltas,
  requestChatCompletionStream,
  type ChatMessage,
  type CompletionUsage,
} from "@/lib/openrouter";
import { getUserEntitlement } from "@/lib/get-user-tier";
import { GUEST_ENTITLEMENT, withFeaturePrompts } from "@/lib/tier-features";
import { recordUsageCost, releaseUsage, reserveUsage } from "@/lib/usage";

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
  //
  // For a signed-in user it is now optional as well: a draft chat has no
  // conversation until its first message, and this is the request that
  // creates it. Absent means "create one"; present must still be a
  // well-formed id, so a malformed one is a rejection rather than a silent
  // extra conversation.
  let conversationId: string | null = null;
  if (user && body.conversationId !== undefined && body.conversationId !== null) {
    if (
      typeof body.conversationId !== "string" ||
      !CONVERSATION_ID_RE.test(body.conversationId)
    ) {
      return Response.json({ error: "Invalid conversationId." }, { status: 400 });
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

  // ── Tier enforcement ──────────────────────────────────────────────────
  // Runs after validation (so a malformed request can't burn a unit) and
  // before both persistence and the model call (so a blocked request costs
  // nothing and leaves nothing behind).
  //
  // `user.id` comes from supabase.auth.getUser() above — a cookie-backed,
  // server-verified session. Nothing here reads a tier, a user id, or a
  // count from the request body, so there is no field a client can add to
  // this POST that changes the outcome.
  //
  // Guests are deliberately unmetered: there is no account to attribute
  // usage to. They're bounded by checkGuestChatRateLimit above and can't
  // reach the authenticated message-length ceiling either.
  let usageEventId: string | null = null;

  // Guests get the free tier's behaviour and nothing better — see
  // GUEST_ENTITLEMENT. Reassigned below once a session's tier is known.
  let entitlement = GUEST_ENTITLEMENT;

  if (user) {
    const reservation = await reserveUsage(user.id, "chat");
    if (!reservation.ok) {
      if (reservation.reason === "limit_exceeded" && !reservation.visible) {
        // The daily message ceiling on a plan sold as unlimited. It is a
        // fair-use backstop, not a product limit, so this deliberately
        // reads as a temporary failure and names no number: `message` is
        // already the generic copy, and 429 + Retry-After says "later"
        // rather than 402's "pay us". Nobody sending a human volume of
        // messages will ever see it.
        console.warn(
          `[chat] fair-use ceiling reached: user=${user.id} tier=${reservation.tier} used=${reservation.used}/${reservation.limit}`,
        );
        return Response.json(
          { error: reservation.message },
          { status: 429, headers: { "Retry-After": String(reservation.retryAfterSeconds) } },
        );
      }

      return Response.json(
        { error: reservation.message },
        // 402 for a real, advertised cap (the fix is to upgrade), 503 when
        // we simply couldn't check (the fix is to retry).
        { status: reservation.reason === "limit_exceeded" ? 402 : 503 },
      );
    }
    usageEventId = reservation.eventId;

    // Same resolver the reservation went through, memoised for this
    // request — one database read, not two. This decides whether the
    // advisor is asked for exploit chains and structured findings, and it
    // takes only the session user id, never anything from the request.
    entitlement = await getUserEntitlement(user.id);
  }

  // Persistence requires a verified session — guests have none, so none of
  // this runs for them and their messages are never stored.
  //
  // Set when this request is the first message of a draft chat, so the
  // response can tell the client which conversation it just created. The
  // client has no way to know otherwise: it sent no id.
  let createdConversationId: string | null = null;

  if (user && !conversationId) {
    // First message in a draft. The conversation row and this message are
    // written together (one transaction, see lib/conversations.ts) — a
    // conversation that exists without its first message is the empty row
    // this whole change exists to stop creating.
    //
    // Creating a conversation therefore costs a chat unit, because it can
    // only happen as part of sending a message that has already been
    // reserved above. Spamming this endpoint to fill the table with
    // conversations runs into the caller's monthly chat cap first.
    const created = await createConversationWithFirstMessage(
      supabase,
      lastMessage.content,
    );

    if ("error" in created) {
      // Nothing was sent to the model and nothing was written, so hand the
      // unit back.
      if (usageEventId) await releaseUsage(usageEventId);
      return Response.json({ error: created.error }, { status: 500 });
    }

    conversationId = created.id;
    createdConversationId = created.id;
  } else if (user && conversationId) {
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
      // Nothing was sent to the model, so hand the unit back.
      if (usageEventId) await releaseUsage(usageEventId);
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

  // Tells a draft chat which conversation this request created, so the client
  // can swap its URL to /chat/<id> and keep using it for the next message. On
  // the error paths below it matters just as much: the conversation and the
  // user's message are already saved, so the client has to adopt the id even
  // though the reply failed — otherwise the next attempt would start a second
  // conversation.
  const createdHeaders: Record<string, string> = createdConversationId
    ? { "X-Conversation-Id": createdConversationId }
    : {};

  let openRouterBody: ReadableStream<Uint8Array>;
  try {
    openRouterBody = await requestChatCompletionStream(
      contextMessages,
      withFeaturePrompts(CHAT_ADVISOR_SYSTEM_PROMPT, entitlement),
    );
  } catch (err) {
    // Upstream refused before generating anything — an outage shouldn't
    // cost the user a message from their monthly allowance.
    if (usageEventId) await releaseUsage(usageEventId);
    if (err instanceof OpenRouterRequestError) {
      return Response.json(
        { error: err.message },
        { status: err.status, headers: createdHeaders },
      );
    }
    return Response.json(
      { error: "The security advisor is temporarily unavailable. Please try again shortly." },
      { status: 502, headers: createdHeaders },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let fullText = "";
      // Filled from the final SSE message. Stays EMPTY_USAGE (nulls, not
      // zeros) if the stream dies first — the row then reads "cost unknown"
      // rather than falsely reading "cost nothing".
      let usage: CompletionUsage = EMPTY_USAGE;

      try {
        for await (const delta of readChatCompletionDeltas(openRouterBody, (u) => {
          usage = u;
        })) {
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

      // The unit was already spent at reservation time; this only attaches
      // what it cost. The reservation deliberately isn't released when the
      // stream fails partway — the tokens were still billed upstream.
      if (usageEventId) {
        await recordUsageCost(usageEventId, {
          tokensUsed: usage.tokensUsed,
          costUsd: usage.costUsd,
          model: CHAT_ADVISOR_MODEL,
        });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      ...createdHeaders,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
