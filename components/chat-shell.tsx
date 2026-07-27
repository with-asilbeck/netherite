"use client";

import { useState, type ReactNode } from "react";

function SidebarToggleIcon() {
  return (
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
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}

export function ChatShell({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <aside
        className={`hidden shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out md:block ${
          sidebarHidden ? "w-0" : "w-[260px]"
        }`}
      >
        <div className="relative h-full w-[260px]">
          {sidebar}
          <button
            type="button"
            aria-label="Hide sidebar"
            title="Hide sidebar"
            onClick={() => setSidebarHidden(true)}
            className="absolute right-2 top-4 flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted"
          >
            <SidebarToggleIcon />
          </button>
        </div>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            aria-label="Close menu"
            className="absolute inset-0 bg-black-500/30"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative z-50 h-full w-[280px] shadow-xl">
            {sidebar}
          </div>
        </div>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        {sidebarHidden && (
          <button
            type="button"
            aria-label="Show sidebar"
            title="Show sidebar"
            onClick={() => setSidebarHidden(false)}
            className="absolute left-2 top-4 z-10 hidden h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted md:flex"
          >
            <SidebarToggleIcon />
          </button>
        )}

        <div className="flex items-center gap-3 border-b border-border px-4 py-3 md:hidden">
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setMobileOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
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
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
          </button>
          <span className="text-sm font-semibold tracking-tight">
            NETHERITE
          </span>
        </div>

        <main className="min-h-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
