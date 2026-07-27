"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

type Message = {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  streaming?: boolean;
};

const SUGGESTIONS = [
  "Scan a code snippet for vulnerabilities",
  "Explain a CVE in plain English",
  "Review my auth middleware",
  "Harden my Supabase RLS policies",
];

export function ChatView({
  userLabel,
  conversationId,
  initialMessages = [],
}: {
  userLabel: string;
  conversationId: string;
  initialMessages?: Pick<Message, "id" | "role" | "content">[];
}) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

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

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isResponding) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
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

  const composer = (
    <form
      onSubmit={handleSubmit}
      className="flex w-full items-end gap-2 rounded-2xl border border-[oklch(0_0_0/0.1)] bg-white px-4 py-3 shadow-sm"
    >
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
        className="max-h-[200px] flex-1 resize-none bg-transparent text-[15px] leading-[1.5] text-[oklch(0.15_0_0)] outline-none placeholder:text-[oklch(0.55_0_0)]"
      />
      <button
        type="submit"
        disabled={!input.trim() || isResponding}
        aria-label="Send message"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[oklch(0.15_0_0)] text-white transition-opacity disabled:opacity-30"
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
  );

  if (!hasMessages) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6">
        <div className="w-full max-w-[680px]">
          <h1 className="mb-6 text-center text-[clamp(24px,3.4vw,32px)] font-semibold tracking-[-0.02em] text-[oklch(0.15_0_0)]">
            Hi {userLabel}, how can I help?
          </h1>

          {composer}

          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => sendMessage(suggestion)}
                className="rounded-full border border-[oklch(0_0_0/0.1)] px-3.5 py-1.5 text-sm text-[oklch(0.35_0_0)] transition-colors hover:bg-[oklch(0_0_0/0.05)]"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
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
                <div className="max-w-[75%] rounded-2xl bg-[oklch(0.95_0.01_90)] px-4 py-2.5 text-[15px] leading-[1.6] text-[oklch(0.15_0_0)]">
                  {message.content}
                </div>
              )}

              {message.role === "assistant" && (
                <div className="max-w-[85%] whitespace-pre-wrap text-[15px] leading-[1.6] text-[oklch(0.2_0_0)]">
                  {message.content}
                  {message.streaming && !message.content && (
                    <span className="flex items-center gap-1.5 py-1">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[oklch(0.6_0_0)] [animation-delay:-0.2s]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[oklch(0.6_0_0)] [animation-delay:-0.1s]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[oklch(0.6_0_0)]" />
                    </span>
                  )}
                </div>
              )}

              {message.role === "error" && (
                <div
                  role="alert"
                  className="max-w-[85%] rounded-lg border border-[oklch(0.85_0_0.06_30)] bg-[oklch(0.95_0.03_30)] px-4 py-2.5 text-[15px] leading-[1.6] text-[oklch(0.35_0.1_30)]"
                >
                  {message.content}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="mx-auto w-full max-w-[720px] px-6 pb-6">{composer}</div>
    </div>
  );
}
