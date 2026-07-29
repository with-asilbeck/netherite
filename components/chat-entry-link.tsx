import type { ReactNode } from "react";
import Link from "next/link";
import { CHAT_ENTRY_PATH } from "@/lib/chat-entry";

/**
 * The only way the marketing site links into chat. Every entry point (header
 * button, hero button, preview card) renders this, so the destination and the
 * auth-aware routing behind it are defined once rather than per-button.
 */
export function ChatEntryLink({
  className,
  children,
  "aria-label": ariaLabel,
}: {
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
}) {
  return (
    <Link href={CHAT_ENTRY_PATH} className={className} aria-label={ariaLabel}>
      {children}
    </Link>
  );
}
