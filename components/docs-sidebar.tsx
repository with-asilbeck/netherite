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
    // Below md this is a full-width strip under the header that scrolls
    // sideways if the links don't fit; from md up it's the original vertical
    // column. As a `w-1/5` column it was 64px wide on a 320px phone — 16px of
    // content once padding was taken off — which wrapped every link to one
    // character per line. `min-w` keeps it usable on tablets, where a fifth of
    // 768px is still too narrow for "Getting started".
    <nav className="shrink-0 border-b border-border px-4 py-3 md:w-1/5 md:min-w-[196px] md:border-b-0 md:border-r md:px-8 md:py-16">
      <div className="flex gap-1 overflow-x-auto md:flex-col md:overflow-x-visible">
        {links.map(({ label, href }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors md:shrink md:whitespace-normal ${
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
