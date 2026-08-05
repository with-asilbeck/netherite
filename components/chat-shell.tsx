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
  headerRight,
  children,
}: {
  sidebar: ReactNode;
  /**
   * The upgrade CTA. Passed in as a node rather than built here so the tier
   * stays a server-side concern: this is a client component, and anything it
   * computed about a plan would have to be handed to the browser first.
   *
   * Rendered in two places with different placement, from the same node: in
   * the mobile bar it sits inline after the wordmark, and on desktop it is
   * floated centre-top over the transcript. The name is a leftover from when
   * both were right-aligned in a header row.
   *
   * **The `headerRight &&` guards below depend on UpgradeButton staying a
   * server component.** It returns `null` on pro and max, and because it is
   * rendered on the server before crossing into this client component, what
   * arrives here is `null` — so the guards short-circuit and the wrapper is
   * never emitted. Add `"use client"` to it and this prop becomes a truthy
   * React element that merely *renders* nothing, at which point pro and max
   * users get an empty blurred pill floating over their transcript.
   */
  headerRight?: ReactNode;
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
          {/* max-w keeps a visible backdrop to tap on the narrowest phones,
              where a flat 280px drawer covers 87% of a 320px screen. */}
          <div className="relative z-50 h-full w-[280px] max-w-[85vw] shadow-xl">
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
            // 44px: this is a touch-only control (the wrapper is md:hidden),
            // so it gets a full-size tap target rather than the 32px the
            // desktop toggle uses with a cursor.
            className="-ml-2 flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
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
          {/* min-w-0 + truncate so the wordmark yields instead of forcing
              the row wider than the viewport — the button beside it is
              shrink-0, and text in a flex child defaults to min-width:auto,
              which is how a header like this ends up scrolling sideways on
              a 320px screen. */}
          <span className="text-[22px] min-w-0 truncate leading-none translate-y-[0.11em] font-brand">
            NETHERITE
          </span>
          {headerRight && <div className="ml-auto pl-3">{headerRight}</div>}
        </div>

        {/* Desktop upgrade CTA, floated centre-top over the transcript rather
            than occupying a row of its own.

            This was previously a real row, specifically so that nothing
            scrolled underneath it. Floating it back reclaims that vertical
            space and accepts the overlap: the transcript owns the full height
            of this pane, so message bubbles now pass behind the button. It
            stays readable because it is opaque (`bg-foreground`) and sits
            above them — the trade is that a bubble can be briefly occluded
            mid-scroll, which is a deliberate choice, not an oversight.

            The blur is a pill around the button, not a strip across the pane:
            a full-width bar would be the header block again in everything but
            name. It exists because the button is opaque and would otherwise
            butt straight up against a line of text mid-sentence — the halo
            gives it an edge to sit on without reserving any layout height.

            `backdrop-blur` rather than a translucent fill: an alpha modifier
            on a semantic colour (`bg-background/80`) silently resolves to a
            solid here, because those tokens go through two levels of var
            indirection — the same limitation noted above --border-strong in
            globals.css. Blur needs no colour at all.

            `pointer-events-none` on the positioned layer, re-enabled on the
            button, keeps the rest of the top edge clickable — without it the
            full-width layer would swallow clicks meant for the messages. */}
        {headerRight && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 hidden justify-center pt-3 md:flex">
            <div className="pointer-events-auto rounded-full p-1 backdrop-blur-md">
              {headerRight}
            </div>
          </div>
        )}

        <main className="min-h-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
