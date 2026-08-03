"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Fades and lifts a section into place the first time it scrolls into view.
 *
 * The hidden state is a class (`.nether-reveal` in globals.css), not React
 * state: the observer then toggles one class on one element instead of
 * re-rendering the section, and the reduced-motion opt-out is a media query
 * rather than a branch. If there is no IntersectionObserver at all the class
 * is applied on mount, so the content is never left stranded at opacity 0.
 */
export function Reveal({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const element = sectionRef.current;
    if (!element) return;

    const reveal = () => element.classList.add("is-revealed");

    if (typeof IntersectionObserver === "undefined") {
      reveal();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          reveal();
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={sectionRef} id={id} className={`nether-reveal ${className ?? ""}`}>
      {children}
    </section>
  );
}
