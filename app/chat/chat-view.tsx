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

type Message = {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  streaming?: boolean;
};

type PendingAttachment = {
  storagePath: string;
  filename: string;
  text: string;
  truncated: boolean;
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
  const [isUploading, setIsUploading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);

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
    fileInputRef.current?.click();
  }

  async function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow selecting the same file again later
    if (!file) return;

    setAttachError(null);
    setIsUploading(true);

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

      setAttachment({
        storagePath: data.storagePath,
        filename: data.filename ?? file.name,
        text: data.text,
        truncated: Boolean(data.truncated),
      });
    } catch {
      setAttachError("Couldn't attach that file. Please try again.");
    } finally {
      setIsUploading(false);
    }
  }

  function removeAttachment() {
    const current = attachment;
    if (!current) return;
    setAttachment(null);
    setAttachError(null);
    // Best-effort cleanup — nothing user-visible depends on this succeeding,
    // so a failure here doesn't need to surface an error.
    fetch("/api/attachments", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storagePath: current.storagePath }),
    }).catch(() => {});
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    const pendingAttachment = attachment;
    if ((!trimmed && !pendingAttachment) || isResponding) return;

    const typedText = trimmed || (pendingAttachment ? DEFAULT_ATTACHMENT_QUESTION : "");
    const content = pendingAttachment
      ? `[Attached file: ${pendingAttachment.filename}]\n\`\`\`\n${pendingAttachment.text}\n\`\`\`\n\n${typedText}`
      : typedText;

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
    requestAnimationFrame(resizeTextarea);
    setIsResponding(true);

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
    <div className="mx-auto w-[90%]">
      {attachment && (
        <div className="mb-2 flex items-center gap-2 rounded-full border border-border bg-muted py-1.5 pl-3 pr-2 text-sm text-foreground">
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
          <span className="min-w-0 truncate">{attachment.filename}</span>
          {attachment.truncated && (
            <span className="shrink-0 text-xs text-muted-foreground">
              (truncated)
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

      {attachError && (
        <p role="alert" className="mb-2 px-1 text-xs text-error-foreground">
          {attachError}
        </p>
      )}

      <form onSubmit={handleSubmit} className="flex items-center gap-2.5">
        {canAttach && (
          <div ref={menuContainerRef} className="relative shrink-0">
            <button
              type="button"
              aria-label="Add attachment"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              disabled={isUploading}
              className="flex h-[50px] w-[50px] items-center justify-center rounded-2xl bg-accent text-accent-foreground transition-opacity disabled:opacity-30"
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

        <div className="flex flex-1 items-center rounded-full border border-border bg-card px-5 py-3.5 shadow-sm">
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
            className="max-h-[200px] w-full resize-none bg-transparent text-left text-[15px] leading-[1.5] text-card-foreground outline-none placeholder:text-[15px] placeholder:text-muted-foreground"
          />
        </div>
        <button
          type="submit"
          disabled={!canSubmit}
          aria-label="Send message"
          className="flex h-[50px] w-[50px] shrink-0 items-center justify-center rounded-2xl bg-accent text-accent-foreground transition-opacity disabled:opacity-30"
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
        <div className="flex flex-1 flex-col items-center justify-center px-6">
          <div className="w-full max-w-[680px]">
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
            <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-6 py-8">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={
                    message.role === "user" ? "flex justify-end" : "flex justify-start"
                  }
                >
                  {message.role === "user" && (
                    <div className="max-w-[75%] rounded-2xl bg-accent px-4 py-2.5 text-[15px] leading-[1.6] text-accent-foreground">
                      <MessageContent content={message.content} />
                    </div>
                  )}

                  {message.role === "assistant" && (
                    <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-[15px] leading-[1.6] text-foreground">
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
                      className="max-w-[85%] rounded-lg border border-error-border bg-error-bg px-4 py-2.5 text-[15px] leading-[1.6] text-error-foreground"
                    >
                      {message.content}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="mx-auto w-full max-w-[720px] px-6 pb-2">{composer}</div>
        </>
      )}
    </div>
  );
}
