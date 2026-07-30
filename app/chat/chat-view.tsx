"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { MessageContent } from "@/components/message-content";
import { MAX_REPO_URL_LENGTH, parseGitHubRepoUrl } from "@/lib/github-repo";

type Message = {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  streaming?: boolean;
};

type PendingAttachment =
  | {
      kind: "file";
      storagePath: string;
      filename: string;
      text: string;
      truncated: boolean;
    }
  | {
      kind: "repo";
      slug: string;
      canonicalUrl: string;
      ref: string | null;
      /** False until repo scanning exists — see app/api/repo-scan/route.ts. */
      scanAvailable: boolean;
    };

const SUGGESTIONS = [
  "Scan a code snippet for vulnerabilities",
  "Explain a CVE in plain English",
  "Review my auth middleware",
  "Harden my Supabase RLS policies",
];

// Client-side hint only — the server independently enforces the real
// allow-list (app/api/attachments/route.ts) and never trusts this.
const ATTACHMENT_ACCEPT =
  ".js,.jsx,.ts,.tsx,.py,.go,.rb,.php,.java,.json,.yaml,.yml,.env.example,.sql,.md,.txt";

const DEFAULT_ATTACHMENT_QUESTION = "Please review this file for security issues.";
const DEFAULT_REPO_QUESTION = "Please review this repository for security issues.";

// Single source of truth for the chat column. Everything in the conversation —
// the message list, the composer, and the empty-state column — uses this, so
// they line up exactly at every viewport.
//
// It replaces three values that had drifted apart: a 720px message list, a
// 680px empty-state column, and a composer at `w-[90%]` of whichever parent it
// landed in (605px on desktop). That's why the composer looked inset from the
// bubbles and why the column changed width after the first message.
//
// `max-w-4xl` (896px) over the old 720px: wide enough for the code blocks and
// tables scan reports produce, still short enough to keep prose lines
// readable. Gutters scale down on small screens so narrow viewports use the
// space they have without text reaching the edge.
const CHAT_COLUMN = "mx-auto w-full max-w-4xl px-4 sm:px-6";

// Picks a fence longer than any run of backticks in the text, so file
// content can't terminate its own code block early. A file containing "```"
// would otherwise split out of the fence and land next to the user's
// question as ordinary prose — i.e. attacker-authored text in a file the
// user asked us to review would read as instructions rather than as quoted
// code. This keeps the quoting structurally intact; it is not a claim that
// the model can't be talked out of anything by content inside the fence.
function fenceFor(text: string): string {
  const longestRun = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longestRun + 1));
}

// Folds a pending attachment into the message text so it travels through the
// existing /api/chat pipeline as one ordinary message — same prompt, same
// route, no parallel LLM path. Attached file text is inert content here: it
// is never evaluated, only quoted.
function buildMessageContent(trimmed: string, attachment: PendingAttachment | null): string {
  if (!attachment) return trimmed;

  if (attachment.kind === "file") {
    const question = trimmed || DEFAULT_ATTACHMENT_QUESTION;
    const fence = fenceFor(attachment.text);
    return `[Attached file: ${attachment.filename}]\n${fence}\n${attachment.text}\n${fence}\n\n${question}`;
  }

  const question = trimmed || DEFAULT_REPO_QUESTION;
  const branch = attachment.ref ? `\n[Branch/tag: ${attachment.ref}]` : "";

  // Repo scanning doesn't exist yet, so the model gets the URL plus an
  // explicit statement that it has seen none of the code. Without that it
  // will happily produce a confident-sounding "scan report" for a repo
  // nobody read — worse than saying the feature isn't ready. Kept to one
  // line because this text is visible in the user's own message bubble.
  if (!attachment.scanAvailable) {
    return (
      `[Attached GitHub repo: ${attachment.canonicalUrl}]${branch}\n` +
      `[Repo scanning isn't built yet — none of its files were read, so you ` +
      `have not seen this code. Don't report findings you can't have.]\n\n${question}`
    );
  }

  return `[Attached GitHub repo: ${attachment.canonicalUrl}]${branch}\n\n${question}`;
}

export function ChatView({
  userLabel,
  conversationId,
  initialMessages = [],
  banner,
}: {
  userLabel: string;
  conversationId?: string;
  initialMessages?: Pick<Message, "id" | "role" | "content">[];
  banner?: ReactNode;
}) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const [attachment, setAttachment] = useState<PendingAttachment | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [isAttaching, setIsAttaching] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [repoInputOpen, setRepoInputOpen] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const repoInputRef = useRef<HTMLInputElement>(null);

  // Uploads require a real account (Supabase Storage RLS is scoped to
  // auth.uid()) — guests never see the attach button at all.
  const canAttach = Boolean(conversationId);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    if (!menuOpen) return;

    function handlePointerDown(e: PointerEvent) {
      if (
        menuContainerRef.current &&
        !menuContainerRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    }
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  function resizeTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  function markAssistantError(assistantId: string, message: string) {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== assistantId) return m;
        if (m.content) {
          return {
            ...m,
            content: `${m.content}\n\n⚠️ ${message}`,
            streaming: false,
          };
        }
        return { ...m, role: "error", content: message, streaming: false };
      }),
    );
  }

  function openFilePicker() {
    setMenuOpen(false);
    setRepoInputOpen(false);
    setAttachError(null);
    fileInputRef.current?.click();
  }

  function openRepoInput() {
    setMenuOpen(false);
    setAttachError(null);
    setRepoInputOpen(true);
    // The input mounts in the same commit this state change triggers, so
    // focus has to wait for it to exist.
    requestAnimationFrame(() => repoInputRef.current?.focus());
  }

  function closeRepoInput() {
    setRepoInputOpen(false);
    setRepoUrl("");
    setAttachError(null);
  }

  async function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow selecting the same file again later
    if (!file) return;

    setAttachError(null);
    setIsAttaching(true);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("kind", "file");

      const res = await fetch("/api/attachments", {
        method: "POST",
        body: formData,
      });

      let data: {
        storagePath?: string;
        filename?: string;
        text?: string;
        truncated?: boolean;
        error?: string;
      } = {};
      try {
        data = await res.json();
      } catch {
        // Fall through to the generic error below.
      }

      if (!res.ok || !data.storagePath || typeof data.text !== "string") {
        setAttachError(data.error ?? "Couldn't attach that file. Please try again.");
        return;
      }

      setRepoInputOpen(false);
      setRepoUrl("");
      // Replacing an attachment drops the previous upload's only reference —
      // delete it rather than leaving an orphan behind. Safe to read from the
      // closure: the "+" button is disabled while a request is in flight, so
      // this can't have changed underneath us.
      discardStoredAttachment(attachment);
      setAttachment({
        kind: "file",
        storagePath: data.storagePath,
        filename: data.filename ?? file.name,
        text: data.text,
        truncated: Boolean(data.truncated),
      });
    } catch {
      setAttachError("Couldn't attach that file. Please try again.");
    } finally {
      setIsAttaching(false);
    }
  }

  async function handleRepoSubmit(e: FormEvent) {
    e.preventDefault();
    if (isAttaching) return;

    // Client-side check so an obvious typo doesn't need a round trip. The
    // server re-validates the same URL with the same parser and is the only
    // check that counts — this one is skippable by anyone who wants to.
    const parsed = parseGitHubRepoUrl(repoUrl);
    if (!parsed) {
      setAttachError(
        "That doesn't look like a GitHub repository URL. Example: https://github.com/owner/repo.",
      );
      return;
    }

    setAttachError(null);
    setIsAttaching(true);

    try {
      const res = await fetch("/api/repo-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl }),
      });

      let data: {
        slug?: string;
        canonicalUrl?: string;
        ref?: string | null;
        scanAvailable?: boolean;
        error?: string;
      } = {};
      try {
        data = await res.json();
      } catch {
        // Fall through to the generic error below.
      }

      if (!res.ok || !data.slug || !data.canonicalUrl) {
        setAttachError(data.error ?? "Couldn't attach that repository. Please try again.");
        return;
      }

      // Trust the server's normalized values over the locally parsed ones.
      setRepoInputOpen(false);
      setRepoUrl("");
      discardStoredAttachment(attachment);
      setAttachment({
        kind: "repo",
        slug: data.slug,
        canonicalUrl: data.canonicalUrl,
        ref: data.ref ?? null,
        scanAvailable: Boolean(data.scanAvailable),
      });
    } catch {
      setAttachError("Couldn't attach that repository. Please try again.");
    } finally {
      setIsAttaching(false);
    }
  }

  // Best-effort cleanup of an uploaded object that's no longer referenced.
  // Nothing user-visible depends on it succeeding, so failures stay quiet.
  // A repo attachment stores nothing, so there's never anything to delete.
  function discardStoredAttachment(previous: PendingAttachment | null) {
    if (previous?.kind !== "file") return;
    fetch("/api/attachments", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storagePath: previous.storagePath }),
    }).catch(() => {});
  }

  function removeAttachment() {
    const current = attachment;
    if (!current) return;
    setAttachment(null);
    setAttachError(null);
    discardStoredAttachment(current);
  }

  // Streams a real repo scan into the assistant bubble: progress lines while
  // the pipeline runs, then the finished report. Separate from the chat
  // stream because this isn't a chat completion — it's clone → filter →
  // triage → deep review on the server (app/api/repo-scan/run/route.ts).
  async function runRepoScan(
    assistantId: string,
    repo: Extract<PendingAttachment, { kind: "repo" }>,
    userMessage: string,
  ) {
    const steps: string[] = [];
    const showProgress = () => {
      const body = steps.map((step) => `_${step}_`).join("\n\n");
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, content: body } : m)),
      );
    };

    try {
      const res = await fetch("/api/repo-scan/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: repo.canonicalUrl,
          conversationId,
          userMessage,
        }),
      });

      if (!res.ok || !res.body) {
        let message = "The scanner is temporarily unavailable. Please try again.";
        try {
          const data = await res.json();
          if (typeof data?.error === "string") message = data.error;
        } catch {
          // Non-JSON error body — keep the generic message.
        }
        markAssistantError(assistantId, message);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;

          let event: {
            type?: string;
            message?: string;
            filesScanned?: number;
            skipped?: number;
            flagged?: number;
            total?: number;
            report?: { markdown?: string };
          };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          if (event.type === "error") {
            markAssistantError(
              assistantId,
              event.message ?? "The scan failed. Please try again.",
            );
            return;
          }

          if (event.type === "status" && event.message) {
            steps.push(event.message);
            showProgress();
          } else if (event.type === "collected") {
            steps.push(
              `${event.filesScanned} reviewable file(s) after filtering, ${event.skipped} excluded.`,
            );
            showProgress();
          } else if (event.type === "triaged") {
            steps.push(`Triage flagged ${event.flagged} of ${event.total} file(s).`);
            showProgress();
          } else if (event.type === "report" && event.report?.markdown) {
            const markdown = event.report.markdown;
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: markdown } : m)),
            );
          }
        }
      }
    } catch {
      markAssistantError(
        assistantId,
        "Lost connection to the scanner. Please try again.",
      );
    }
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    const pendingAttachment = attachment;
    if ((!trimmed && !pendingAttachment) || isResponding) return;

    const content = buildMessageContent(trimmed, pendingAttachment);

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content,
    };
    const assistantId = crypto.randomUUID();
    // Exclude "error" placeholders from the context sent to the server —
    // they were never persisted server-side and aren't a valid role there.
    const history = [...messages, userMessage].filter((m) => m.role !== "error");

    setMessages((prev) => [
      ...prev,
      userMessage,
      { id: assistantId, role: "assistant", content: "", streaming: true },
    ]);
    setInput("");
    setAttachment(null);
    setRepoInputOpen(false);
    setRepoUrl("");
    requestAnimationFrame(resizeTextarea);
    setIsResponding(true);

    // A repo attachment runs the scan pipeline instead of a chat completion.
    if (pendingAttachment?.kind === "repo") {
      try {
        await runRepoScan(assistantId, pendingAttachment, content);
      } finally {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
        );
        setIsResponding(false);
      }
      return;
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          messages: history.map(({ role, content }) => ({ role, content })),
        }),
      });

      if (!res.ok || !res.body) {
        let message =
          "The security advisor is temporarily unavailable. Please try again.";
        try {
          const data = await res.json();
          if (typeof data?.error === "string") message = data.error;
        } catch {
          // Non-JSON error body — fall back to the generic message.
        }
        markAssistantError(assistantId, message);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;

          let parsed: { delta?: string; error?: string };
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }

          if (parsed.error) {
            markAssistantError(assistantId, parsed.error);
            return;
          }

          if (parsed.delta) {
            const delta = parsed.delta;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: m.content + delta }
                  : m,
              ),
            );
          }
        }
      }
    } catch {
      markAssistantError(
        assistantId,
        "Lost connection to the security advisor. Please try again.",
      );
    } finally {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
      );
      setIsResponding(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    sendMessage(input);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  const hasMessages = messages.length > 0;
  const canSubmit = (Boolean(input.trim()) || Boolean(attachment)) && !isResponding;

  const composer = (
    // Width and gutters come from the parent's CHAT_COLUMN, so the composer is
    // always exactly as wide as the messages above it.
    <div className="w-full">
      {attachment && (
        <div className="mb-2 flex items-center gap-2 rounded-full border border-border bg-muted py-1.5 pl-3 pr-2 text-sm text-foreground">
          {attachment.kind === "file" ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="shrink-0"
              aria-hidden="true"
            >
              <path d="M12 2a10 10 0 00-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 015 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0012 2z" />
            </svg>
          )}
          <span className="min-w-0 truncate">
            {attachment.kind === "file" ? attachment.filename : attachment.slug}
          </span>
          {attachment.kind === "file" && attachment.truncated && (
            <span className="shrink-0 text-xs text-muted-foreground">
              (truncated)
            </span>
          )}
          {attachment.kind === "repo" && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {attachment.ref ? `(${attachment.ref}) ` : ""}
              {attachment.scanAvailable ? "" : "· not scanned yet"}
            </span>
          )}
          <button
            type="button"
            onClick={removeAttachment}
            aria-label="Remove attachment"
            className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-border hover:text-foreground"
          >
            ✕
          </button>
        </div>
      )}

      {repoInputOpen && (
        <form onSubmit={handleRepoSubmit} className="mb-2 flex items-center gap-2">
          <input
            ref={repoInputRef}
            type="text"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeRepoInput();
            }}
            maxLength={MAX_REPO_URL_LENGTH}
            spellCheck={false}
            autoComplete="off"
            aria-label="GitHub repository URL"
            placeholder="https://github.com/owner/repo"
            className="min-w-0 flex-1 rounded-full border border-border bg-card px-4 py-2 text-sm text-card-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            type="submit"
            disabled={isAttaching || !repoUrl.trim()}
            className="shrink-0 rounded-full bg-accent px-4 py-2 text-sm text-accent-foreground transition-opacity disabled:opacity-30"
          >
            {isAttaching ? "Attaching…" : "Attach"}
          </button>
          <button
            type="button"
            onClick={closeRepoInput}
            aria-label="Cancel attaching a repository"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            ✕
          </button>
        </form>
      )}

      {attachError && (
        <p role="alert" className="mb-2 px-1 text-xs text-error-foreground">
          {attachError}
        </p>
      )}

      <form onSubmit={handleSubmit}>
        {/* Both controls sit inside the input pill rather than beside it. Two
            50px buttons plus two gaps outside the field cost ~120px of a
            390px viewport, which is what made the input feel cramped on
            mobile. `items-end` keeps them pinned to the last line as the
            textarea grows. */}
        <div
          className={`flex items-end gap-1.5 rounded-3xl border border-border bg-card py-1.5 pr-1.5 shadow-sm ${
            canAttach ? "pl-1.5" : "pl-4"
          }`}
        >
          {canAttach && (
            <div ref={menuContainerRef} className="relative shrink-0">
              <button
                type="button"
                aria-label="Add attachment"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
                disabled={isAttaching}
                // 40px on mobile, 36px from sm up: smaller than the old 50px
                // as asked, but not so small on touch that it becomes a
                // hard-to-hit target.
                className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-accent-foreground transition-opacity disabled:opacity-30 sm:h-9 sm:w-9"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>

              {menuOpen && (
                <div
                  role="menu"
                  className="absolute bottom-full left-0 z-20 mb-2 w-48 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={openFilePicker}
                    className="block w-full px-3 py-2 text-left text-sm text-card-foreground transition-colors hover:bg-muted"
                  >
                    Upload file
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={openRepoInput}
                    className="block w-full px-3 py-2 text-left text-sm text-card-foreground transition-colors hover:bg-muted"
                  >
                    Attach GitHub repo
                  </button>
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept={ATTACHMENT_ACCEPT}
                onChange={handleFileSelected}
                className="hidden"
              />
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              resizeTextarea();
            }}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder="Message Netherite…"
            className="max-h-[200px] min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-left text-[15px] leading-[1.5] text-card-foreground outline-none placeholder:text-[15px] placeholder:text-muted-foreground"
          />

          <button
            type="submit"
            disabled={!canSubmit}
            aria-label="Send message"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground transition-opacity disabled:opacity-30 sm:h-9 sm:w-9"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </form>

      <p className="mt-[18px] px-1 text-center text-xs text-muted-foreground">
        Netherite is an AI and can make mistakes. Check important info.
      </p>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {banner}

      {!hasMessages ? (
        <div className="flex flex-1 flex-col items-center justify-center">
          <div className={CHAT_COLUMN}>
            <h1 className="mb-12 text-center text-[clamp(24px,3.4vw,32px)] font-semibold tracking-[-0.02em] text-foreground">
              Hi {userLabel}, how can I help?
            </h1>

            {composer}

            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => sendMessage(suggestion)}
                  className="rounded-full border border-border text-muted-foreground transition-colors hover:bg-muted px-3.5 py-1.5 text-sm"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className={`${CHAT_COLUMN} flex flex-col gap-6 py-8`}>
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={
                    message.role === "user" ? "flex justify-end" : "flex justify-start"
                  }
                >
                  {message.role === "user" && (
                    <div className="max-w-[88%] rounded-2xl bg-accent px-4 py-2.5 text-[15px] leading-[1.6] text-accent-foreground sm:max-w-[75%]">
                      <MessageContent content={message.content} />
                    </div>
                  )}

                  {message.role === "assistant" && (
                    <div className="max-w-full min-w-0 rounded-2xl bg-muted px-4 py-2.5 text-[15px] leading-[1.6] text-foreground sm:max-w-[85%]">
                      <MessageContent content={message.content} />
                      {message.streaming && !message.content && (
                        <span className="flex items-center gap-1.5 py-1">
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.2s]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.1s]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
                        </span>
                      )}
                    </div>
                  )}

                  {message.role === "error" && (
                    <div
                      role="alert"
                      className="max-w-full rounded-lg border border-error-border bg-error-bg px-4 py-2.5 text-[15px] leading-[1.6] text-error-foreground sm:max-w-[85%]"
                    >
                      {message.content}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className={`${CHAT_COLUMN} pb-2`}>{composer}</div>
        </>
      )}
    </div>
  );
}
