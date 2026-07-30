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
- Domain: netherite.uz (Namecheap)

## LLM usage
- All LLM calls go through OpenRouter (single API, multiple models)
- Model for deep analysis: anthropic/claude-sonnet-4.6
- Model for fast/surface scans: google/gemini-2.5-flash
  - Was `google/gemini-2.0-flash-001`; that id is retired and OpenRouter 404s
    it ("No endpoints found"), which made every triaged file escalate instead
    of being filtered. Don't set it back.
  - Not `gemini-2.5-flash-lite`: on a trivial SQL injection probe it answered
    verdict "no" with the reason "SQL injection vulnerability", which is
    useless in a filter that gates the deep pass.
- Model for the advisor chatbot: inclusionai/ling-3.0-flash:free
  - **Text input only** — OpenRouter reports its input modalities as
    `["text"]`. This is why image attachments aren't offered in the composer:
    the upload backend exists but the model would never see the image. Wiring
    image attachments up requires switching this model to one that accepts
    image input first (both scan models above already do).
- API key: OPENROUTER_API_KEY only — no direct Anthropic or Google API keys needed
- Before changing any model id, confirm it exists:
  `GET https://openrouter.ai/api/v1/models` with the OpenRouter key, and check
  `architecture.input_modalities` if the change depends on non-text input.

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