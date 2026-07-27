import Image from "next/image";
import Link from "next/link";
import { logout } from "@/app/chat/actions";
import { NewChatButton } from "@/components/new-chat-button";

type RecentConversation = { id: string; label: string };

export function ChatSidebar({
  userEmail,
  conversations,
}: {
  userEmail?: string | null;
  conversations: RecentConversation[];
}) {
  const initial = userEmail?.trim()?.[0]?.toUpperCase() ?? "?";

  return (
    <div className="flex h-full flex-col bg-[#F8F3D9] text-[oklch(0.15_0_0)]">
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
        <div className="px-2 pb-2 text-xs font-medium tracking-wide text-[oklch(0.5_0_0)]">
          Recents
        </div>
        {conversations.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-[oklch(0.55_0_0)]">
            No conversations yet
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {conversations.map(({ id, label }) => (
              <li key={id}>
                <Link
                  href={`/chat/${id}`}
                  className="block truncate rounded-lg px-2 py-1.5 text-sm text-[oklch(0.3_0_0)] transition-colors hover:bg-[oklch(0_0_0/0.06)]"
                >
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-[oklch(0_0_0/0.08)] px-3 py-3">
        <div className="flex items-center gap-2.5 px-1">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[oklch(0.15_0_0)] text-sm font-medium text-white">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              {userEmail ?? "Signed in"}
            </div>
          </div>
          <form action={logout}>
            <button
              type="submit"
              aria-label="Log out"
              title="Log out"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[oklch(0.45_0_0)] transition-colors hover:bg-[oklch(0_0_0/0.08)] hover:text-[oklch(0.15_0_0)]"
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
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="M16 17l5-5-5-5" />
                <path d="M21 12H9" />
              </svg>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
