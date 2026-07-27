"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { label: "Overview", href: "/docs" },
  { label: "Getting started", href: "/docs/getting-started" },
  { label: "Scanning a repo", href: "/docs/scanning-a-repo" },
  { label: "Reading a report", href: "/docs/reading-a-report" },
  { label: "The chat advisor", href: "/docs/chat-advisor" },
];

export function DocsSidebar() {
  const pathname = usePathname();

  return (
    <nav className="w-1/5 shrink-0 border-r border-border px-6 py-16 sm:px-8">
      <div className="flex flex-col gap-1">
        {links.map(({ label, href }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`rounded-lg px-3 py-2 text-sm transition-colors ${
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
