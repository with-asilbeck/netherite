"use client";

import { useEffect, useRef } from "react";

type Particle = { x: number; y: number; vx: number; vy: number };

const LINK_DISTANCE = 130;
const CURSOR_DISTANCE = 180;
/** One particle per this many CSS pixels of viewport. */
const AREA_PER_PARTICLE = 22_000;

/**
 * The drifting node graph behind the landing page: particles that bounce
 * around the viewport, thread lines to their near neighbours, and reach for
 * the cursor.
 *
 * Purely decorative, so it is hidden from assistive tech, and a reader who
 * asked for reduced motion gets a single static frame instead of a
 * permanently animating background.
 */
export function ParticleField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    // Capped at 2: past that the pixel count grows faster than the extra
    // sharpness is worth on a full-viewport canvas.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let particles: Particle[] = [];
    let cursorX = -Infinity;
    let cursorY = -Infinity;
    let frame = 0;

    // Read as channel triplets ("150 235 210") rather than finished colors,
    // because every line is drawn at its own distance-based alpha. Re-read
    // when next-themes swaps the class on <html>, or the field would keep
    // painting the previous theme's ink.
    let dotRgb = "150 235 210";
    let linkRgb = "140 220 200";

    const readPalette = () => {
      const styles = getComputedStyle(canvas);
      dotRgb = styles.getPropertyValue("--nether-particle-rgb").trim() || dotRgb;
      linkRgb = styles.getPropertyValue("--nether-link-rgb").trim() || linkRgb;
    };

    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      const count = Math.round(
        (window.innerWidth * window.innerHeight) / AREA_PER_PARTICLE,
      );
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.35 * dpr,
        vy: (Math.random() - 0.5) * 0.35 * dpr,
      }));
      if (still) draw();
    };

    const onPointerMove = (event: PointerEvent) => {
      cursorX = event.clientX * dpr;
      cursorY = event.clientY * dpr;
    };

    function draw() {
      if (!canvas || !ctx) return;
      const linkDistance = LINK_DISTANCE * dpr;
      const cursorDistance = CURSOR_DISTANCE * dpr;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = `rgb(${dotRgb} / 0.72)`;
      for (const particle of particles) {
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, 1.4 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.lineWidth = 1;
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];

        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          const distance = Math.hypot(a.x - b.x, a.y - b.y);
          if (distance >= linkDistance) continue;
          ctx.strokeStyle = `rgb(${linkRgb} / ${
            0.159 * (1 - distance / linkDistance)
          })`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }

        const toCursor = Math.hypot(a.x - cursorX, a.y - cursorY);
        if (toCursor < cursorDistance) {
          ctx.strokeStyle = `rgb(${dotRgb} / ${
            0.333 * (1 - toCursor / cursorDistance)
          })`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(cursorX, cursorY);
          ctx.stroke();
        }
      }
    }

    const tick = () => {
      for (const particle of particles) {
        particle.x += particle.vx;
        particle.y += particle.vy;
        if (particle.x < 0 || particle.x > canvas.width) particle.vx *= -1;
        if (particle.y < 0 || particle.y > canvas.height) particle.vy *= -1;
      }
      draw();
      frame = requestAnimationFrame(tick);
    };

    readPalette();
    resize();
    window.addEventListener("resize", resize);

    // The animated field picks the new ink up on its next frame; the static
    // one has to be told to repaint.
    const themeWatcher = new MutationObserver(() => {
      readPalette();
      if (still) draw();
    });
    themeWatcher.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    if (still) {
      return () => {
        window.removeEventListener("resize", resize);
        themeWatcher.disconnect();
      };
    }

    window.addEventListener("pointermove", onPointerMove);
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      themeWatcher.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 h-full w-full opacity-70"
    />
  );
}
