"use client";

import { Suspense, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { inter } from "@/lib/fonts";
import { createClient } from "@/lib/supabase/client";

const ERROR_MESSAGES = new Map<string, string>([
  ["access_denied", "Sign-in was cancelled. You can try again below."],
  ["no_code", "That sign-in link was invalid or expired. Please try again."],
  [
    "exchange_failed",
    "We couldn't complete sign-in. Please try again in a moment.",
  ],
]);

function LoginErrorFromQuery() {
  const searchParams = useSearchParams();
  const error = searchParams.get("error");

  if (!error) return null;

  return (
    <p
      role="alert"
      className="mb-6 max-w-[360px] rounded-lg border border-error-border bg-error-bg px-4 py-3 text-sm text-error-foreground"
    >
      {ERROR_MESSAGES.get(error) ??
        "Something went wrong signing you in. Please try again."}
    </p>
  );
}

function OAuthButtons() {
  const [pendingProvider, setPendingProvider] = useState<
    "google" | "github" | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn(provider: "google" | "github") {
    setError(null);
    setPendingProvider(provider);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setError(error.message);
      setPendingProvider(null);
    }
  }

  return (
    // w-full + a max cap rather than a fixed width: at 320px a hard
    // `w-[320px]` plus the page's px-6 made the document 368px wide, so the
    // whole login page scrolled sideways on the smallest phones.
    <div className="flex w-full max-w-[320px] flex-col gap-3">
      {error && (
        <p
          role="alert"
          className="max-w-[360px] rounded-lg border border-error-border bg-error-bg px-4 py-3 text-sm text-error-foreground"
        >
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={pendingProvider !== null}
        onClick={() => handleSignIn("google")}
        className="flex h-12 w-full items-center justify-center rounded-xl border border-border bg-card text-sm font-medium text-card-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pendingProvider === "google"
          ? "Redirecting…"
          : "Continue with Google"}
      </button>

      <button
        type="button"
        disabled={pendingProvider !== null}
        onClick={() => handleSignIn("github")}
        className="flex h-12 w-full items-center justify-center rounded-xl bg-accent text-sm font-medium text-accent-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pendingProvider === "github"
          ? "Redirecting…"
          : "Continue with GitHub"}
      </button>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div
      className={`${inter.variable} flex min-h-screen w-full flex-col items-center bg-sidebar font-sans text-foreground`}
    >
      <header className="flex w-full items-center px-6 py-7 sm:px-14">
        <Link href="/" className="flex items-center gap-3">
          <Image
            src="/netherite-mark.png"
            alt="Netherite"
            width={34}
            height={34}
            className="h-[34px] w-[34px] object-contain dark:invert"
          />
          <span className="text-lg font-semibold tracking-tight">
            NETHERITE
          </span>
        </Link>
      </header>

      {/* w-full matters here: the parent centres with `items-center`, so
          without it `main` is sized to its content and any fixed-width child
          pushes the whole document wider than the viewport. */}
      <main className="flex w-full flex-1 flex-col items-center justify-center px-6 text-center">
        <h1 className="m-0 text-[clamp(28px,4vw,40px)] font-semibold tracking-[-0.02em]">
          Log in to Netherite
        </h1>
        <p className="mt-4 max-w-[360px] text-base leading-[1.6] text-muted-foreground">
          Sign in to scan your repos and get vulnerability reports.
        </p>

        <div className="mt-10 w-full max-w-[320px]">
          <Suspense fallback={null}>
            <LoginErrorFromQuery />
          </Suspense>
          <OAuthButtons />
        </div>
      </main>
    </div>
  );
}
