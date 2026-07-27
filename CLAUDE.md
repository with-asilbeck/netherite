@AGENTS.md
# Project: Netherite — AI Security Specialist

An AI-powered security advisor that scans GitHub repos, analyzes code snippets,
and acts as a chatbot advisor to help developers find and fix vulnerabilities
in their code — with a focus on AI-generated ("vibe coded") apps.

## Stack

- Framework: Next.js (App Router) + React + TypeScript
- Styling: Tailwind CSS
- Database / Auth: Supabase
- Hosting: Vercel
- Payments: Stripe
- OAuth: Google, GitHub
- Domain: netherite.xyz (Namecheap)

## LLM usage
- All LLM calls go through OpenRouter (single API, multiple models)
- Model for deep analysis: anthropic/claude-sonnet-4.6
- Model for fast/surface scans: google/gemini-2.0-flash-001
- API key: OPENROUTER_API_KEY only — no direct Anthropic or Google API keys needed

## Core features (build in this order)

1. Code snippet analysis — user pastes code, gets vulnerability + fix
2. GitHub repo scanning — clone repo server-side, scan files, return report
3. Security advisor chatbot — Q&A on security best practices

## Conventions

- API routes handle all DB/LLM calls — never query Supabase directly from client components
- File structure: `app/` for routes, `lib/` for Supabase + LLM clients, `components/` for UI
- All async operations show loading states; all API routes handle errors gracefully

## Security rules (non-negotiable)

- Every Supabase table must have RLS enabled. Never suggest `USING (true)` as a fix.
- Never expose `service_role` keys or LLM API keys to the client. Server-side only.
- Never put secrets in `NEXT_PUBLIC_`-prefixed env vars.
- Auth checks must be enforced server-side (middleware/API routes), never client-only.
- Rate-limit the repo-cloning endpoint — it's public-facing and abusable.
- Sanitize any user-submitted code before rendering it (no `dangerouslySetInnerHTML`).

## What NOT to do

- Don't auto-commit changes without letting me review them first.
- Don't touch `.env.local`.
- Don't weaken a security check just to make an error go away — flag it instead and ask.

## Workflow

- After every feature is built, update `PROGRESS.md` with what changed and what's next.
- Don't start the next phase until the current one is verified working, not just "looks done."