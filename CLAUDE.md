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

- Calls go **direct to each vendor** through `lib/llm` — there is no broker.
  `lib/llm/models.ts` is the single place that maps a stage to a model, a
  model to a provider, and a model to its price.
- Model ids are **provider-native**. The `vendor/model` form
  (`anthropic/claude-sonnet-4.6`) is OpenRouter routing syntax and 404s
  against the vendor API.
- Model for deep analysis: `claude-sonnet-4-6` (Anthropic)
- Model for fast/surface scans: `gemini-3.6-flash` (Google)
- Model for the Max tier's `best` model tier: `claude-opus-5` (Anthropic), used
  for **both** scan stages. Note this runs on the triage pass too (~38 calls
  per scan), so a Max scan costs roughly an order of magnitude more than a
  `fast` one — see the margin note in PROGRESS.md before widening it.
  - **Claude Opus 5 thinks by default**, and `max_tokens` caps thinking plus
    reply together, so a 500-token triage budget would be spent reasoning and
    return nothing. `lib/llm/anthropic.ts` disables thinking explicitly and
    appends a no-internal-XML-tags line, which is the documented mitigation
    for tag leakage when thinking is off.
  - **Do not send `temperature`** to Anthropic. Sampling parameters are
    removed on Opus 5 and a request carrying one is a 400.
- Model for the advisor chatbot: `gemini-3.6-flash` (Google)
  - Was `inclusionai/ling-3.0-flash:free`, which existed only on OpenRouter.
    It is gone, and with it the "free" in the advisor's cost model — chat is
    now billed per token like everything else.
  - It accepts **image input**, unlike the model it replaced. The composer
    attachment note that used to live here no longer applies: the blocker was
    the old model's text-only modality, and it is gone.
- **Gemini thinking is controlled by `thinkingLevel`, not `thinkingBudget`.**
  The numeric `thinkingBudget: 0` that works on Gemini 2.x is rejected by some
  3.x models and silently ignored by others — on `gemini-3.5-flash` it left
  thinking fully on and turned a 44-token verdict into a 29-second call.
  Confirm it took effect with `thoughtsTokenCount: 0` on the response.
- API keys: `ANTHROPIC_API_KEY` and `GEMINI_API_KEY`. `OPENROUTER_API_KEY` is
  no longer read by anything.
- **Cost is computed, not reported.** OpenRouter returned the amount it
  charged; the vendor APIs return token counts only, so `MODEL_PRICING` in
  `lib/llm/models.ts` prices them. A model missing from that table records a
  null cost, never zero — add a row when adding a model.
- Before changing any model id, confirm it is **callable**, not merely listed.
  `gemini-2.5-flash` appears in Google's `GET /v1beta/models` and then returns
  `404 … no longer available to new users` from `generateContent`. Make a real
  one-token call with the project's own key.

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