"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";

/**
 * Light / Dark / System, as three inline segments rather than a two-state
 * flip: `system` is the app's default, and a binary toggle is a one-way door
 * out of it — once you pick a side there is no way back to "follow the OS".
 * Same three options the chat sidebar offers, so the choice means the same
 * thing wherever it is made (next-themes persists it for the whole app).
 */
const THEME_OPTIONS = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "system", label: "System", Icon: SystemIcon },
] as const;

/**
 * False during SSR and the first client render, true afterwards.
 *
 * The selected theme is only knowable in the browser, so the segments have to
 * render unselected until hydration or the markup won't match. This reads that
 * as external state instead of a `setState` in an effect, which would be a
 * cascading render for a value that never changes again.
 */
function useMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex items-center gap-0.5 rounded-full border border-nether-line bg-nether-surface p-0.5"
    >
      {THEME_OPTIONS.map(({ value, label, Icon }) => {
        const active = mounted && theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={`rounded-full p-1.5 transition-colors ${
              active
                ? "bg-nether-glow-wash-strong text-nether-glow-soft"
                : "text-nether-faint hover:text-nether-fg"
            }`}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}

function iconProps(): React.SVGProps<SVGSVGElement> {
  return {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
}

function SunIcon() {
  return (
    <svg {...iconProps()}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg {...iconProps()}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}
