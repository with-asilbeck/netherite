"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { MessageContent } from "@/components/message-content";
import { CopyButton } from "@/components/copy-button";
import { MAX_REPO_URL_LENGTH, parseGitHubRepoUrl } from "@/lib/github-repo";
import { CONVERSATION_ID_RE, conversationLabel } from "@/lib/conversations";
import { CHAT_APP_PATH } from "@/lib/chat-entry";
import { useChatSession } from "@/components/chat-session";
import { createClient } from "@/lib/supabase/client";
import { GITHUB_OAUTH_SCOPES } from "@/lib/github/scopes";
import type { GitHubConnectionSummary } from "@/lib/supabase/github-schema";

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

// Where a draft chat's unsent text is kept so a refresh before sending
// doesn't throw it away. Keyed by user id: on a shared browser, signing in as
// somebody else must not surface the previous account's half-written message.
// Guests have no id and get no entry — their chat isn't persisted anywhere
// else either.
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

function draftStorageKey(userId: string | undefined): string | null {
  return userId ? `netherite:chat-draft:${userId}` : null;
}

function readStoredDraft(key: string | null): string {
  if (!key) return "";
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    // Private browsing, disabled storage, quota — a draft that can't be
    // restored isn't worth breaking the chat over.
    return "";
  }
}

function writeStoredDraft(key: string | null, value: string) {
  if (!key) return;
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // As above: best effort.
  }
}

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
  userId,
  conversationId: initialConversationId,
  initialMessages = [],
  banner,
}: {
  userLabel: string;
  /** Present for signed-in users only. Guests on /try get none. */
  userId?: string;
  /**
   * Absent means this is a draft: no conversation exists yet, and none will
   * until the first message is sent.
   */
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
  // GitHub connection state for the repo-attach flow. `null` means "not
  // asked yet" — distinct from a loaded summary saying `connected: false`,
  // because the first opens the panel and the second is simply unknown.
  const [githubConnection, setGithubConnection] =
    useState<GitHubConnectionSummary | null>(null);
  const [connectPanelOpen, setConnectPanelOpen] = useState(false);
  // "reconnect" only after a stored token turned out to be dead, so the copy
  // can say what happened instead of implying the user never connected.
  const [connectMode, setConnectMode] = useState<"connect" | "reconnect">("connect");
  const [isConnecting, setIsConnecting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const repoInputRef = useRef<HTMLInputElement>(null);

  const { addConversation, draftResetToken } = useChatSession();

  // Whether this view was mounted as the draft route (/chat) rather than a
  // conversation (/chat/[id]). Fixed for the life of the mount — unlike the
  // id below, which starts empty on a draft and fills in once the first
  // message creates the conversation.
  const isDraftRoute = initialConversationId === undefined;

  const [conversationId, setConversationId] = useState<string | undefined>(
    initialConversationId,
  );

  // The attachment as of right now, for the paths that have to clean up an
  // upload from outside a render (replacing one, resetting the draft) and
  // can't rely on what their closure captured.
  const attachmentRef = useRef<PendingAttachment | null>(null);
  // Lets "New chat" cut off a reply that's still streaming into a draft the
  // user has just walked away from.
  const sendAbortRef = useRef<AbortController | null>(null);

  const draftKey = draftStorageKey(userId);
  // Only a real draft stores unsent text. Once the conversation exists the
  // composer belongs to it, and /chat/[id] never had a draft to begin with.
  const isDraft = isDraftRoute && conversationId === undefined;

  // Uploads require a real account (Supabase Storage RLS is scoped to
  // auth.uid()) — guests never see the attach button at all. A draft chat
  // can attach: the upload is stored per user, not per conversation.
  const canAttach = Boolean(userId);

  function updateAttachment(next: PendingAttachment | null) {
    attachmentRef.current = next;
    setAttachment(next);
  }

  // Stable identity (it only touches a ref), so the effects and callbacks
  // below can depend on it without being rebuilt every render.
  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // Restore whatever was typed but never sent.
  //
  // In an effect rather than in the initial state because localStorage only
  // exists on the client: reading it during render would make the first
  // client render disagree with the server-rendered empty textarea. This is
  // the one-shot read of an external store that a mount effect is for — it
  // runs once, and the composer is empty until it does, so the extra render
  // is the intended two-pass hydration rather than a cascade.
  useEffect(() => {
    if (!isDraft) return;
    const saved = readStoredDraft(draftKey);
    if (!saved) return;
    // Only if nothing has been typed in the meantime, so a restore can never
    // overwrite the user.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above: a one-time restore on mount, not a subscription
    setInput((current) => current || saved);
    requestAnimationFrame(resizeTextarea);
    // Deliberately only on mount / when the key changes: this is a restore,
    // not a subscription. `isDraft` is excluded on purpose — it flips to
    // false the moment the conversation is created, and re-running then would
    // do nothing useful.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, resizeTextarea]);

  /**
   * Reads connection status. Returns `undefined` when the request itself
   * failed, which is deliberately not the same as a summary saying "not
   * connected": a network blip must not be mistaken for "you never connected
   * GitHub", so the caller falls through to the URL input and lets the
   * server — the only real boundary — decide.
   */
  const loadGitHubConnection = useCallback(async (): Promise<
    GitHubConnectionSummary | undefined
  > => {
    try {
      const res = await fetch("/api/github/connection", { cache: "no-store" });
      if (!res.ok) return undefined;
      const summary = (await res.json()) as GitHubConnectionSummary;
      setGithubConnection(summary);
      return summary;
    } catch {
      return undefined;
    }
  }, []);

  // Coming back from GitHub authorization.
  //
  // The connect flow is a full-page redirect, so "show the URL input in the
  // same spot without reopening the menu" has to survive a navigation — the
  // callback appends `?github=` and this picks it up on mount. The parameter
  // is stripped immediately so a later reload doesn't reopen the input.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("github");
    if (!status) return;

    const url = new URL(window.location.href);
    url.searchParams.delete("github");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);

    if (status === "connected") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a one-shot handoff from the OAuth redirect, not a subscription: the query parameter is consumed and stripped above, so this cannot run twice
      void loadGitHubConnection();
      setRepoInputOpen(true);
      requestAnimationFrame(() => repoInputRef.current?.focus());
    } else {
      setAttachError(
        "GitHub authorization didn't complete, so no connection was saved. Please try again.",
      );
    }
  }, [loadGitHubConnection]);

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
    setConnectPanelOpen(false);
    setAttachError(null);
    fileInputRef.current?.click();
  }

  function showRepoInput() {
    setConnectPanelOpen(false);
    setRepoInputOpen(true);
    // The input mounts in the same commit this state change triggers, so
    // focus has to wait for it to exist.
    requestAnimationFrame(() => repoInputRef.current?.focus());
  }

  async function openRepoInput() {
    setMenuOpen(false);
    setAttachError(null);

    // Cached after the first look: the menu can be opened repeatedly, and
    // this shouldn't be a round trip every time.
    const summary = githubConnection ?? (await loadGitHubConnection());

    // `undefined` is the request-failed case described above — proceed to
    // the input rather than falsely claiming they aren't connected.
    if (summary && !summary.connected) {
      setConnectMode("connect");
      setRepoInputOpen(false);
      setConnectPanelOpen(true);
      return;
    }

    showRepoInput();
  }

  function closeRepoInput() {
    setRepoInputOpen(false);
    setConnectPanelOpen(false);
    setRepoUrl("");
    setAttachError(null);
  }

  /**
   * Starts the GitHub authorization round trip.
   *
   * Two different calls, because the account is in one of two states and
   * only one of them can be fixed by linking:
   *
   * - No GitHub identity on the Supabase account (signed up with Google):
   *   `linkIdentity` attaches one.
   * - A GitHub identity exists but no usable token is stored — they signed
   *   up with GitHub before this feature, or their token was dropped after
   *   GitHub rejected it. Linking would fail ("identity already exists"), so
   *   this re-runs sign-in, whose only purpose here is to mint a fresh
   *   `provider_token` for the callback to capture.
   *
   * `next` carries the current path so the callback returns here with the
   * repo input already open, rather than to a blank chat.
   */
  /**
   * Turns a server's `action` hint into the matching recovery UI. Ignores
   * anything else, so a rejection like "you don't have push access" — which
   * reconnecting would not fix — doesn't get a misleading connect button.
   */
  function showConnectPanelFor(action: string | undefined) {
    if (action !== "connect" && action !== "reconnect") return;

    // The stored token is gone or was never there; reflect that locally so
    // the next attach attempt doesn't reuse a stale "connected" summary.
    setGithubConnection((prev) =>
      prev ? { ...prev, connected: false, username: null } : prev,
    );
    setConnectMode(action);
    setRepoInputOpen(false);
    setConnectPanelOpen(true);
  }

  async function handleConnectGitHub() {
    if (isConnecting) return;
    setIsConnecting(true);
    setAttachError(null);

    const supabase = createClient();
    const next = encodeURIComponent(window.location.pathname);
    const options = {
      redirectTo: `${window.location.origin}/auth/callback?next=${next}`,
      scopes: GITHUB_OAUTH_SCOPES,
    };

    const { error } = githubConnection?.hasGitHubIdentity
      ? await supabase.auth.signInWithOAuth({ provider: "github", options })
      : await supabase.auth.linkIdentity({ provider: "github", options });

    // On success the browser is already navigating to GitHub, so there is no
    // state left to reset — only the failure path returns here.
    if (error) {
      setAttachError(error.message || "Couldn't start GitHub authorization. Please try again.");
      setIsConnecting(false);
    }
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
      // delete it rather than leaving an orphan behind.
      discardStoredAttachment(attachmentRef.current);
      updateAttachment({
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
        action?: string;
      } = {};
      try {
        data = await res.json();
      } catch {
        // Fall through to the generic error below.
      }

      if (!res.ok || !data.slug || !data.canonicalUrl) {
        // A connection problem, as opposed to a bad URL or a repo they don't
        // own, is recoverable right here — swap the input for the connect
        // panel instead of leaving them with an error and nothing to press.
        showConnectPanelFor(data.action);
        setAttachError(data.error ?? "Couldn't attach that repository. Please try again.");
        return;
      }

      // Trust the server's normalized values over the locally parsed ones.
      setRepoInputOpen(false);
      setRepoUrl("");
      discardStoredAttachment(attachmentRef.current);
      updateAttachment({
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

  function removeAttachment() {
    const current = attachmentRef.current;
    if (!current) return;
    updateAttachment(null);
    setAttachError(null);
    discardStoredAttachment(current);
  }

  /**
   * Back to an empty draft: no messages, nothing typed, no conversation id,
   * nothing saved. Called when "New chat" is pressed — including when it's
   * pressed while already looking at a draft, where nothing navigates and
   * this is the only thing that happens.
   *
   * Creates nothing. The next conversation comes into existence when the
   * next message is sent, not here.
   */
  const resetToDraft = useCallback(() => {
    // A reply still streaming into the view being abandoned would otherwise
    // keep running (and keep the composer disabled) after the reset.
    sendAbortRef.current?.abort();
    sendAbortRef.current = null;

    discardStoredAttachment(attachmentRef.current);
    attachmentRef.current = null;

    setMessages([]);
    setInput("");
    setAttachment(null);
    setAttachError(null);
    setRepoInputOpen(false);
    setRepoUrl("");
    setMenuOpen(false);
    setIsResponding(false);
    setConversationId(undefined);
    writeStoredDraft(draftKey, "");
    requestAnimationFrame(resizeTextarea);
  }, [draftKey, resizeTextarea]);

  // "New chat" bumps a counter in ChatSessionProvider; this is the view
  // reacting to it. Only the draft route listens: from /chat/[id] the button
  // navigates away, and resetting a real conversation's view on the way out
  // would just make it flash empty first.
  const seenResetToken = useRef(draftResetToken);
  useEffect(() => {
    if (!isDraftRoute) return;
    if (seenResetToken.current === draftResetToken) return;
    seenResetToken.current = draftResetToken;
    resetToDraft();
  }, [draftResetToken, isDraftRoute, resetToDraft]);

  /**
   * Adopts the conversation the server created for a draft's first message.
   *
   * The id is generated server-side, so this is how the client finds out
   * about it: the URL becomes /chat/<id>, the sidebar gains a row, and the
   * saved draft text is dropped now that it has been sent and stored.
   *
   * `history.replaceState` rather than a router navigation on purpose — this
   * runs while the reply is still streaming into the view, and navigating
   * would tear it down mid-response. It's the documented way to change the
   * URL without one, and `usePathname` follows it.
   */
  function adoptCreatedConversation(response: Response, firstMessage: string) {
    const created = response.headers.get("X-Conversation-Id");
    if (!created || !CONVERSATION_ID_RE.test(created)) return;

    setConversationId(created);
    window.history.replaceState(null, "", `${CHAT_APP_PATH}/${created}`);
    addConversation({ id: created, label: conversationLabel(null, firstMessage) });
    writeStoredDraft(draftKey, "");
  }

  // Streams a real repo scan into the assistant bubble: progress lines while
  // the pipeline runs, then the finished report. Separate from the chat
  // stream because this isn't a chat completion — it's clone → filter →
  // triage → deep review on the server (app/api/repo-scan/run/route.ts).
  async function runRepoScan(
    assistantId: string,
    repo: Extract<PendingAttachment, { kind: "repo" }>,
    userMessage: string,
    signal: AbortSignal,
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
        signal,
        body: JSON.stringify({
          repoUrl: repo.canonicalUrl,
          // Absent on a draft — the scan request then creates the
          // conversation, and reports the id back in a header.
          conversationId: conversationId ?? null,
          userMessage,
        }),
      });

      adoptCreatedConversation(res, userMessage);

      if (!res.ok || !res.body) {
        let message = "The scanner is temporarily unavailable. Please try again.";
        try {
          const data = await res.json();
          if (typeof data?.error === "string") message = data.error;
          // A token that died between attaching and sending lands here.
          // Offer the reconnect panel alongside the message in the transcript.
          showConnectPanelFor(typeof data?.action === "string" ? data.action : undefined);
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
    const pendingAttachment = attachmentRef.current;
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

    // Lets "New chat" abandon this request if it's pressed before the reply
    // finishes. Not stored per message: only one send is ever in flight,
    // since the composer is disabled while `isResponding`.
    const abortController = new AbortController();
    sendAbortRef.current = abortController;

    setMessages((prev) => [
      ...prev,
      userMessage,
      { id: assistantId, role: "assistant", content: "", streaming: true },
    ]);
    setInput("");
    updateAttachment(null);
    setRepoInputOpen(false);
    setRepoUrl("");
    requestAnimationFrame(resizeTextarea);
    setIsResponding(true);
    // The draft entry is deliberately NOT cleared here. It's cleared once the
    // conversation actually exists (adoptCreatedConversation) — if this send
    // fails before that, a refresh should still bring the text back.

    // A repo attachment runs the scan pipeline instead of a chat completion.
    if (pendingAttachment?.kind === "repo") {
      try {
        await runRepoScan(assistantId, pendingAttachment, content, abortController.signal);
      } finally {
        if (sendAbortRef.current === abortController) sendAbortRef.current = null;
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
        signal: abortController.signal,
        body: JSON.stringify({
          // Absent on a draft: this request is what creates the conversation,
          // and the id comes back in a header.
          conversationId: conversationId ?? null,
          messages: history.map(({ role, content }) => ({ role, content })),
        }),
      });

      // Before the ok check — a failed reply still creates the conversation
      // and saves the user's message, and the client has to know that so the
      // next attempt continues it instead of starting another one.
      adoptCreatedConversation(res, content);

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
      // An abort lands here too, but "New chat" has already cleared the
      // message this would attach itself to, so the map below finds nothing
      // and no stray error appears in the fresh draft.
      markAssistantError(
        assistantId,
        "Lost connection to the security advisor. Please try again.",
      );
    } finally {
      if (sendAbortRef.current === abortController) sendAbortRef.current = null;
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

  // Saving from the change handler rather than an effect on `input` is
  // deliberate: an effect would also fire on the render where the restore
  // above sets the text, and on the render where sending clears it — both of
  // which would write over the entry with a value the user never typed.
  function handleInputChange(value: string) {
    setInput(value);
    if (isDraft) writeStoredDraft(draftKey, value);
    resizeTextarea();
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

      {/* Occupies the same slot as the repo URL input below, and is mutually
          exclusive with it: until a GitHub account is connected there is no
          point asking for a URL, because every scan would be refused at the
          ownership check. */}
      {connectPanelOpen && (
        <div className="mb-2 rounded-2xl border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-card-foreground">
                {connectMode === "reconnect"
                  ? "Reconnect GitHub to scan your repos"
                  : "Connect GitHub to scan your repos"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {connectMode === "reconnect"
                  ? "Your previous authorization expired or was revoked. Reconnecting takes a moment and restores scanning."
                  : "Netherite scans repositories you own or have write access to. It asks GitHub for read access to your public repositories only — never write access, and never your private code."}
              </p>
            </div>
            <button
              type="button"
              onClick={closeRepoInput}
              aria-label="Dismiss the GitHub connection panel"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              ✕
            </button>
          </div>

          <button
            type="button"
            onClick={handleConnectGitHub}
            disabled={isConnecting}
            className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-accent-foreground transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            {isConnecting
              ? "Opening GitHub…"
              : githubConnection?.hasGitHubIdentity
                ? "Reconnect GitHub"
                : "Connect GitHub"}
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
                    onClick={() => void openRepoInput()}
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
            onChange={(e) => handleInputChange(e.target.value)}
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
                  // A column so the copy button can sit under the bubble;
                  // `items-*` keeps the same left/right placement the old
                  // `justify-*` gave the bubble itself.
                  className={`group flex flex-col ${
                    message.role === "user" ? "items-end" : "items-start"
                  }`}
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

                  {/* Nothing to copy from an empty or still-streaming reply,
                      and a button that appears mid-stream would shift the
                      text under the pointer. Errors get none — the text is a
                      status line, not content the user wrote or asked for.
                      Visible by default on touch, where there is no hover to
                      reveal it with. */}
                  {message.role !== "error" &&
                    Boolean(message.content) &&
                    !message.streaming && (
                      <CopyButton
                        text={message.content}
                        label={
                          message.role === "user"
                            ? "Copy your message"
                            : "Copy response"
                        }
                        className="mt-1 opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                      />
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
