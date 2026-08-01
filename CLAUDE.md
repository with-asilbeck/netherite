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
- Payments: Lemon Squeezy (merchant of record — it handles VAT/sales tax)
  - Tiers are `free / basic / pro / max`, monthly or yearly, one Lemon
    Squeezy variant per combination (`LEMONSQUEEZY_VARIANT_*`).
  - `subscriptions` is the source of truth for what a user is entitled to,
    and it is written **only** by the signature-verified webhook route.
    `user_tiers` survives as a manual comp override that can only raise a
    tier, never lower one.
  - `subscription_payment_success` must never change tier or status — it
    fires on every renewal and says nothing about entitlement. Enforced by
    `ENTITLEMENT_EVENTS` in `lib/billing/events.ts`.
  - Checkout `custom_data` is not private: Lemon Squeezy accepts it as
    query parameters on public buy URLs, so `user_id` travels with a keyed
    digest (`uid_sig`) and is ignored without one.
  - Verify with `npm run verify:billing` (needs `npm run dev` running).
- OAuth: Google, GitHub
- Domain: netherite.uz (Namecheap)

## Tiers and limits
- `lib/tiers.ts` is the single source of truth for both halves of
  entitlement: per-tier caps and per-tier feature flags. `lib/usage/tiers.ts`
  projects the caps into the ledger's per-action shape rather than keeping a
  second copy — never write a number in two places.
- Messages are capped **per UTC day**, snippets and repo scans **per month**
  (`ACTION_WINDOWS`). The day/month choice is passed to `reserve_usage` so
  the database can't disagree with the app about the window.
- The daily message cap is an invisible fair-use ceiling on every paid tier —
  those plans are sold as unlimited messages. Hitting it must return a
  generic 429 that names no number, never a 402 upgrade prompt, and it must
  never be rendered in the UI. `messagesCapIsVisible` / `capIsVisible` decide
  this; free's 200/day is advertised and does show.
- Feature gating goes through `hasFeature(tier, feature)` and
  `entitlementFor(tier)`. Both take a `Tier`, and the only producer of a
  `Tier` is `getUserTier(userId)` — a service-role read of `subscriptions`.
  There is deliberately no function that accepts a flag, plan name, or model
  id from a caller, so a route physically cannot feed one from a request body.
- Verify with `npm run verify:tiers` (needs `npm run dev` running).

## LLM usage
- All LLM calls go through OpenRouter (single API, multiple models)
- Model for deep analysis: anthropic/claude-sonnet-4.6
- Model for fast/surface scans: google/gemini-2.5-flash
- Model for the Max tier's `best` model tier: anthropic/claude-opus-5, used
  for **both** scan stages. Confirmed present in `/api/v1/models`. Note this
  runs on the triage pass too (~38 calls per scan), so a Max scan costs
  roughly an order of magnitude more than a `fast` one — see the margin note
  in PROGRESS.md before widening it to another tier.
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