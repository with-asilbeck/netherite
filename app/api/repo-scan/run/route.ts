import { createClient } from "@/lib/supabase/server";
import { CONVERSATION_ID_RE } from "@/lib/conversations";
import { checkRepoScanRunRateLimit } from "@/lib/rate-limit";
import { MAX_REPO_URL_LENGTH, parseGitHubRepoUrl } from "@/lib/github-repo";
import { scanRepository, type ScanProgress } from "@/lib/repo-scan";

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

  const conversationId =
    typeof body.conversationId === "string" && CONVERSATION_ID_RE.test(body.conversationId)
      ? body.conversationId
      : null;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ScanProgress) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      let markdown: string | null = null;

      // The scan replaces the /api/chat round trip for this message, so this
      // route owns persisting both sides of it — otherwise the user's own
      // message would vanish on reload.
      if (userMessage && conversationId) {
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
        for await (const event of scanRepository(repo, request.signal)) {
          send(event);
          if (event.type === "report") markdown = event.report.markdown;
        }
      } catch (err) {
        console.error("[repo-scan] stream failed:", err);
        send({ type: "error", message: "The scan stopped unexpectedly." });
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
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
