"use client";

import type { ReactNode } from "react";

export function ScrollLink({
  targetId,
  className,
  children,
}: {
  targetId: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() =>
        document
          .getElementById(targetId)
          ?.scrollIntoView({ behavior: "smooth" })
      }
      className={className}
    >
      {children}
    </button>
  );
}
