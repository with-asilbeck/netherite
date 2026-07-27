"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { logout, createConversationAction } from "@/app/chat/actions";
import { NewChatButton } from "@/components/new-chat-button";
import { ConversationRow } from "@/components/conversation-row";

type RecentConversation = { id: string; label: string };

const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

function ProfileMenu({ userEmail }: { userEmail?: string | null }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const initial = userEmail?.trim()?.[0]?.toUpperCase() ?? "?";

  useEffect(() => {
    if (!menuOpen) return;

    function handlePointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
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

  return (
    <div ref={containerRef} className="relative border-t border-border px-3 py-3">
      <button
        type="button"
        aria-label="Profile menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-lg px-1 py-1 text-left transition-colors hover:bg-muted"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-medium text-accent-foreground">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {userEmail ?? "Signed in"}
          </div>
        </div>
      </button>

      {menuOpen && (
        <div
          role="menu"
          className="absolute bottom-full left-3 right-3 z-20 mb-2 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg"
        >
          <div className="px-3 pb-1 pt-2 text-xs font-medium tracking-wide text-muted-foreground">
            Theme
          </div>
          {THEME_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={theme === value}
              onClick={() => {
                setTheme(value);
                setMenuOpen(false);
              }}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-card-foreground transition-colors hover:bg-muted"
            >
              {label}
              {theme === value && <CheckIcon />}
            </button>
          ))}

          <div className="my-1 border-t border-border" />

          <form action={logout}>
            <button
              type="submit"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-card-foreground transition-colors hover:bg-muted"
            >
              <LogoutIcon />
              Log out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

export function ChatSidebar({
  userEmail,
  conversations: initialConversations,
}: {
  userEmail?: string | null;
  conversations: RecentConversation[];
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const pathname = usePathname();
  const router = useRouter();
  const [, startTransition] = useTransition();

  function handleDeleted(id: string) {
    const next = conversations.filter((c) => c.id !== id);
    setConversations(next);

    if (pathname !== `/chat/${id}`) return;

    // The user was viewing the conversation they just deleted — send them
    // to the next most recent one, or spin up a new one if none remain.
    if (next.length > 0) {
      router.push(`/chat/${next[0].id}`);
    } else {
      startTransition(async () => {
        await createConversationAction({});
      });
    }
  }

  function handleRenamed(id: string, title: string) {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, label: title } : c)),
    );
  }

  return (
    <div className="flex h-full flex-col bg-sidebar text-foreground">
      <div className="flex items-center gap-2.5 px-4 pt-5 pb-2">
        <Image
          src="/netherite-mark.png"
          alt="Netherite"
          width={24}
          height={24}
          className="h-6 w-6 object-contain"
        />
        <span className="text-sm font-semibold tracking-tight">
          NETHERITE
        </span>
      </div>

      <NewChatButton />

      <div className="mt-6 flex-1 overflow-y-auto px-3">
        <div className="px-2 pb-2 text-xs font-medium tracking-wide text-muted-foreground">
          Recents
        </div>
        {conversations.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            No conversations yet
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {conversations.map(({ id, label }) => (
              <ConversationRow
                key={id}
                id={id}
                label={label}
                onDeleted={handleDeleted}
                onRenamed={handleRenamed}
              />
            ))}
          </ul>
        )}
      </div>

      <ProfileMenu userEmail={userEmail} />
    </div>
  );
}
