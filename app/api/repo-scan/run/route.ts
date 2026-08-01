import { createClient } from "@/lib/supabase/server";
import {
  CONVERSATION_ID_RE,
  createConversationWithFirstMessage,
} from "@/lib/conversations";
import { checkRepoScanRunRateLimit } from "@/lib/rate-limit";
import { MAX_REPO_URL_LENGTH, parseGitHubRepoUrl } from "@/lib/github-repo";
import {
  acquireScanSlot,
  newScanBudget,
  PRIORITY_HIGH,
  PRIORITY_NORMAL,
  scanRepository,
  ScanQueueFullError,
  ScanQueueTimeoutError,
  type ScanProgress,
} from "@/lib/repo-scan";
import { getUserEntitlement } from "@/lib/get-user-tier";
import { recordUsageCost, releaseUsage, reserveUsage } from "@/lib/usage";

// Cloning and the file walk need real Node APIs (child_process, fs), so this
// route can't run on the edge runtime.
export const runtime = "nodejs";

// Above lib/repo-scan/config.ts's SCAN_TIMEOUT_MS (240s) so the pipeline
// reaches its own deadline and returns a report, rather than the platform
// killing the request mid-scan.
export const maxDuration = 300;

const MAX_REQUEST_BYTES = 4 * 1024;

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "Request is too large." }, { status: 413 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Please log in to scan a repository." }, { status: 401 });
  }

  const rateLimit = checkRepoScanRunRateLimit(user.id);
  if (!rateLimit.allowed) {
    return Response.json(
      {
        error:
          "You've reached the repository scan limit for now. Scans are expensive, so they're capped — please try again later.",
      },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  let body: { repoUrl?: unknown; conversationId?: unknown; userMessage?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Same authenticated ceiling app/api/chat/route.ts enforces.
  const MAX_USER_MESSAGE_LENGTH = 30_000;
  const userMessage =
    typeof body.userMessage === "string" &&
    body.userMessage.length > 0 &&
    body.userMessage.length <= MAX_USER_MESSAGE_LENGTH
      ? body.userMessage
      : null;

  if (typeof body.repoUrl !== "string" || body.repoUrl.length > MAX_REPO_URL_LENGTH) {
    return Response.json(
      { error: "Enter a GitHub repository URL, like https://github.com/owner/repo." },
      { status: 400 },
    );
  }

  // The only gate between a user-supplied string and a server-side clone.
  // Everything downstream uses the rebuilt canonical URL, never this input —
  // and shallowClone independently re-checks that github.com resolves to a
  // public address before any network call (lib/repo-scan/ssrf.ts).
  const repo = parseGitHubRepoUrl(body.repoUrl);
  if (!repo) {
    return Response.json(
      {
        error:
          "That isn't a valid GitHub repository URL. Only public repositories on github.com can be scanned — example: https://github.com/owner/repo.",
      },
      { status: 400 },
    );
  }

  let conversationId =
    typeof body.conversationId === "string" && CONVERSATION_ID_RE.test(body.conversationId)
      ? body.conversationId
      : null;

  // ── Tier enforcement: `repo_scan` ─────────────────────────────────────
  // Last gate before the expensive work starts, and the most important one
  // of the three: a scan is a clone plus dozens of model calls across two
  // models, including the Sonnet deep pass. Everything cheap and
  // rejectable (size, auth, rate limit, URL validation) has already run, so
  // a unit is only ever spent on a request that is actually going to scan.
  //
  // Reserved before the ReadableStream is constructed rather than inside
  // it: `start()` runs after the 200 has been committed, which would make
  // a 402 impossible to send.
  const reservation = await reserveUsage(user.id, "repo_scan");
  if (!reservation.ok) {
    return Response.json(
      { error: reservation.message },
      {
        status: reservation.reason === "limit_exceeded" ? 402 : 503,
        ...(reservation.reason === "limit_exceeded"
          ? { headers: { "Retry-After": String(reservation.retryAfterSeconds) } }
          : {}),
      },
    );
  }
  const usageEventId = reservation.eventId;

  // ── Feature gating ────────────────────────────────────────────────────
  // Same resolver the reservation above went through, memoised for this
  // request — so this is the caps and the feature flags from that one
  // database read, not a second lookup. Everything the scan does
  // differently for a paying customer (which models it calls, whether the
  // deep pass is asked for exploit chains, which report renderer runs,
  // where it sits in the queue) comes from here.
  //
  // Nothing in the request body reaches this. The only argument is a user
  // id taken from the verified session, so there is no field a client can
  // add to unlock a feature.
  const entitlement = await getUserEntitlement(user.id);

  // Priority admission. Pro and Max are served before free and basic when
  // slots are contended; see lib/repo-scan/queue.ts for what that does and
  // does not guarantee.
  let releaseSlot: () => void;
  try {
    releaseSlot = await acquireScanSlot(
      entitlement.priorityQueue ? PRIORITY_HIGH : PRIORITY_NORMAL,
      request.signal,
    );
  } catch (err) {
    // Never admitted, so nothing was scanned — the unit goes back.
    await releaseUsage(usageEventId);
    const message =
      err instanceof ScanQueueFullError || err instanceof ScanQueueTimeoutError
        ? err.message
        : "The scanner is busy right now. Please try again in a few minutes.";
    return Response.json({ error: message }, { status: 503, headers: { "Retry-After": "120" } });
  }

  // A scan can be the first thing sent in a draft chat, in which case this
  // request is what creates the conversation — same rule as /api/chat: the
  // conversation row and the user's message are written together, never a
  // conversation on its own. With no user message there is nothing to pair a
  // conversation with, so the scan runs unsaved, as it already did.
  //
  // After the reservation, not before: a request that gets turned away at the
  // cap shouldn't leave a new conversation in the sidebar as a souvenir.
  let createdConversationId: string | null = null;
  if (!conversationId && userMessage) {
    const created = await createConversationWithFirstMessage(supabase, userMessage);
    if ("error" in created) {
      // Nothing has been scanned yet, so the unit and the slot both go back.
      await releaseUsage(usageEventId);
      releaseSlot();
      return Response.json({ error: created.error }, { status: 500 });
    }
    conversationId = created.id;
    createdConversationId = created.id;
  }

  // Owned here so the accumulated cost of every model call the pipeline
  // makes can be read back once the scan drains.
  const budget = newScanBudget();

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ScanProgress) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      let markdown: string | null = null;

      // The scan replaces the /api/chat round trip for this message, so this
      // route owns persisting both sides of it — otherwise the user's own
      // message would vanish on reload. Skipped when the conversation was
      // just created above, which already stored this message as part of the
      // same transaction.
      if (userMessage && conversationId && !createdConversationId) {
        const { error } = await supabase.from("chat_messages").insert({
          user_id: user.id,
          conversation_id: conversationId,
          role: "user",
          content: userMessage,
        });
        if (error) {
          console.error("[repo-scan] couldn't persist the user message:", error);
        }
      }

      try {
        for await (const event of scanRepository(repo, entitlement, request.signal, budget)) {
          send(event);
          if (event.type === "report") markdown = event.report.markdown;
        }
      } catch (err) {
        console.error("[repo-scan] stream failed:", err);
        send({ type: "error", message: "The scan stopped unexpectedly." });
      } finally {
        // Before the persistence and accounting below, not after: those are
        // database writes that don't need a scan slot, and holding one
        // through them would stall the next waiter for no reason. Release
        // is idempotent, so the outer close path can't double-free it.
        releaseSlot();
      }

      // Record what the scan cost, or hand the unit back if it never got as
      // far as calling a model — a repo that failed to clone, or was
      // filtered down to nothing, burned no credits and shouldn't burn a
      // scan from a free-tier user's allowance of two. A scan that made
      // even one call keeps the unit: partial work still costs money.
      //
      // Keyed on the call count, not on whether cost numbers came back —
      // "upstream didn't report usage" must never be a free scan.
      if (budget.modelCalls > 0) {
        await recordUsageCost(usageEventId, {
          tokensUsed: budget.usage.tokensUsed,
          costUsd: budget.usage.costUsd,
          // Two models per scan; record the pair rather than pick one. On
          // the `best` tier both stages use the same model and this reads
          // as a doubled id, which is accurate and worth seeing on the cost
          // dashboard — that tier is where the money goes.
          model: `${entitlement.models.triage} + ${entitlement.models.deep}`,
        });
      } else {
        await releaseUsage(usageEventId);
      }

      // Persist the finished report like any other assistant message, so it
      // survives a reload. Best-effort: a failed insert must not discard the
      // report the user is already reading.
      if (markdown && conversationId) {
        const { error } = await supabase.from("chat_messages").insert({
          user_id: user.id,
          conversation_id: conversationId,
          role: "assistant",
          content: markdown,
        });
        if (error) {
          console.error("[repo-scan] couldn't persist report:", error);
        }
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      // Same contract as /api/chat: present only when this request created
      // the conversation, so a draft knows what it just became.
      ...(createdConversationId ? { "X-Conversation-Id": createdConversationId } : {}),
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
