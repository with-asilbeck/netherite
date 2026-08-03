# Progress

## 2026-08-01 — One tier resolver

`lib/get-user-tier.ts` is now the only place a user's tier is worked out.
Everything that needs to know what somebody is entitled to goes through it:
the three metered routes, the feature gates, the usage dashboard, and the
account page.

**What moved.** `getUserTier` used to live in `lib/usage/index.ts`, and two
pages did their own lookup on top of it — `lib/usage/queries.ts` and
`lib/billing/queries.ts` each read `subscriptions` themselves and called
`resolveEffectiveTier` separately. The *rules* were already shared, so
nothing could disagree about what a status meant, but there were three
places that fetched the row and three places that could drift. There is now
one.

**The rules did not change.** No row → free; active → the row's tier;
cancelled → the tier until `current_period_end`, then free; past_due → the
tier through the 8-day grace window; expired and refunded → free
immediately, regardless of time left on the clock. Unknown status, unknown
tier, and unparseable dates all fail closed to free.

**Return shape.** `{ tier, status, cancellingSoon, currentPeriodEnd, source,
subscription }`. Only `tier` is an enforcement input. `cancellingSoon` is
for the account page's "Cancelling" pill and is deliberately not consulted
by any cap — `tier` already reflects the access the account has, and a
second flag that enforcement also read would be a second source of truth.
`source` (`subscription` / `override` / `default`) exists so "why does this
account have Pro" is answerable from a log line.

**Caching.** `cache()` from React, which the bundled Next docs confirm is
scoped to one request with no sharing between requests, keyed on the user
id. Two calls for one user in a request cost one query; an upgrade or a
downgrade takes effect on the very next request. That property is asserted,
not assumed — the resolution suite writes a row, reads, rewrites it, and
reads again.

**Deliberately left alone:** `lib/billing/store.ts:166` still calls
`effectiveTier` directly, in the guard that stops a new subscription
overwriting one still granting access. That is the webhook reasoning about a
row it has already fetched, inside the writer — not a second answer to
"what is this user's tier". It uses the same rule function, so it cannot
drift.

**Verified — 483 assertions across nine suites, all passing** once
`20260801030000_usage_windows.sql` was applied. The new
resolution suite creates real users with real subscription rows and reads
the tier back through the same resolver the routes call: free (no row) →
free, basic/active → basic, pro/active → pro, pro/cancelled with the period
still open → **pro** with `cancellingSoon: true`, max/refunded → **free**.
Plus cancelled-and-expired, expired-with-time-left, past_due inside and
outside the grace window, the override direction, and the no-stale-tier
property. `tsc --noEmit`, `eslint`, and `next build` clean.

**Two false alarms during verification, both in the tests rather than the
code**, recorded because the first one wasted a real debugging pass:

- `/api/repo-scan/run` returned 404 for every request, including anonymous
  ones that should have been 401 — while `/api/repo-scan` and `/api/chat`
  worked, `next build` listed the route, and `tsc` was clean. It was a
  stale Turbopack cache in `.next`; deleting it and restarting `next dev`
  fixed it with no code change. Worth knowing that a dev-server 404 on one
  route is not evidence about that route's code.
- Three "request body can't buy a tier" assertions failed with 429 instead
  of 402. `checkRepoScanRunRateLimit` allows 3 scans per hour per user and
  runs *before* the tier check, so reusing one account meant the fourth
  attempt never reached enforcement at all. Each attempt now gets its own
  user — otherwise the assertion would have been passing on the strength of
  a rate limiter rather than the thing it claims to test.

## 2026-08-01 — Lemon Squeezy billing

Paid plans, end to end: checkout, webhooks, the pricing page, an account page,
and the wiring that makes a subscription actually change what a user can do.
Lemon Squeezy rather than the Stripe named in CLAUDE.md (now updated) — it is
merchant of record, so VAT and sales tax are its problem, not ours.

**Tiers are `free / basic / pro / max`.** The entry paid tier was called
`standard` in `lib/usage/tiers.ts`; the products in the store are called Basic.
Renamed in the migration rather than mapped, because two names for one tier is
how a cap eventually gets read from the wrong row. `user_tiers` was empty in
production, so nothing moved.

**`subscriptions` is the source of truth, and only the webhook writes it.**
Both new tables are readable by their owner and writable by nobody holding the
anon key — no insert/update/delete policy at all, which with RLS on is a
denial. `user_tiers` survives as a manual comp override that can only ever
*raise* a tier, so a forgotten row there can't demote somebody who is paying.

**`subscription_payment_success` cannot change a tier or a status.** It fires
on the first payment and on every renewal, and on renewal it says nothing
about entitlement — acting on it would re-grant a plan that a cancellation or
a refund had already taken away. There is one function that writes
entitlement and it throws for any event not in `ENTITLEMENT_EVENTS`, so the
property is structural rather than a convention. Payment success writes a
`payment_history` row and nothing else.

**Security review found one real vulnerability, confirmed against the live
store rather than reasoned about.** Lemon Squeezy accepts custom data as
query parameters on a product's *public* buy URL —
`?checkout[custom][user_id]=<anyone>` lands in the checkout state and comes
back in a genuinely signed webhook. Since `subscription_created` upserts on
`user_id`, anybody could have bought Basic in another user's name,
overwritten their subscription row, then asked for a refund: a Max customer
dropped to Free for the price of a refundable $9.99. Signature verification
does not catch this, because the event really is from Lemon Squeezy. Fixed by
sending a keyed digest of the user id alongside it (`uid_sig`) and refusing to
attribute any event without a valid one; plus a second guard that refuses to
replace a subscription that is still granting access. Three tests in the
webhook suite are that attack.

Three smaller findings, all fixed: `/api/checkout` had no rate limit (a
signed-in user could exhaust the *store's* Lemon Squeezy API quota, ~100/min,
and stop everyone else paying — now 20/hour per user, plus an `Origin`
check); `formatPrice` passed a webhook-supplied currency straight to
`Intl.NumberFormat`, which throws `RangeError` on anything that isn't ISO 4217
and would have 500'd a user's whole billing page (normalised at the boundary
*and* at render); and a real account's uuid had ended up in a committed test
script.

**Verified — 260 assertions across six suites, against the real test-mode
store and the real database.** `npm run verify:billing`, with `npm run dev` up.

- **Entitlement (28)** — imports the real module, not a copy. Cancelled keeps
  its tier until the period ends and not a day longer; past_due keeps it
  through an 8-day grace window; expired and refunded grant nothing even with
  time left on the clock; unknown status, unknown tier, unparseable date and
  null row all resolve to free.
- **Variants (31)** — all six env ids resolve to the right published product,
  bill on the right interval, and charge exactly the price in `plans.ts`.
  Also asserts the API key is a test-mode key.
- **Checkout (86)** — creates all six real hosted checkouts, loads each page
  (200, test mode, right price, prefilled email), and confirms each carries a
  valid attribution signature that does *not* validate for any other user id.
  `/api/checkout` refuses anonymous callers, ignores injected
  `userId`/`price`/`variantId`, and rejects a `tier` crafted to build an env
  var name (`../../SUPABASE_SERVICE_ROLE_KEY`).
- **Webhooks (79)** — every event posted with a real HMAC signature at the
  running route, every assertion read back out of Supabase. Five bypass
  attempts refused, including a *valid* signature over a tampered body — the
  case a re-serialise-then-compare implementation lets through. Then each
  event's exact row effect, idempotent redelivery, a renewal payment while
  cancelled leaving the plan untouched, a refund revoking immediately and
  marking only its own invoice, and a superseded subscription's events being
  ignored.
- **RLS (23)** — with two real user JWTs, not the service role. A user reads
  their own row and gets zero rows for anyone else's; cannot promote
  themselves, cannot blanket-update every row, cannot insert, cannot delete,
  cannot rewrite their own payment history, cannot write `user_tiers`.
  Anonymous gets nothing.
- **Enforcement (13)** — `getUserTier`, the function every metered route calls
  before spending money, against the live database: status gates access, not
  just the tier column.

`tsc --noEmit`, `eslint`, and `next build` all clean.

**One false alarm worth recording,** in the spirit of the note at the bottom of
this file: the enforcement suite first reported "past_due inside the grace
window keeps max" as failing. The assertion was wrong, not the code — it used
a period end 30 days in the past against an 8-day window, so `free` was the
right answer. Now tested at both two days and thirty.

**Not done, and deliberately.** Nobody has typed a card into one of those
checkout pages: that needs a browser, and real webhook delivery needs a public
URL, so the event verification above is signed replay rather than Lemon
Squeezy's own delivery. The handler and its database effects are fully
covered; what is not covered is Lemon Squeezy actually sending the request.
Before going live: register the production webhook URL in the store, subscribe
it to the seven handled events, switch to a live-mode API key, and make one
real purchase. `LEMONSQUEEZY_STORE_ID` is currently the store *URL* rather
than a bare id — `normalizeStoreId` handles both, but it is worth fixing at
the source.

## 2026-08-01 — Lazy chat creation

A conversation is now created by the first message sent in it, not before.
Logging in and pressing "New chat" write nothing.

**Before**, both created a row up front. Five presses of "New chat" without
sending anything left five unused conversations, plus one more from the login
redirect — measured, not assumed: 6 rows, 0 messages, and after a refresh a
Recents list of six identical "New chat" entries. **After**: 0 rows, and
Recents stays empty.

**The draft state.** `/chat` renders an empty chat view that owns no
conversation id, no database row and no nanoid token. It is where the OAuth
callback lands, where `/try` sends an already-signed-in user, and where "New
chat" goes.

- `app/chat/page.tsx`: was a redirect to the most recent conversation
  (creating one first if there were none); now renders the draft. Touches the
  database only to read the session.
- `lib/chat-entry.ts`: `resolveChatEntryPath()` is gone — there is nothing
  left to resolve. It exported the "create a conversation if the user has
  none" behaviour that made simply signing in write a row. Replaced by
  `CHAT_APP_PATH`, a constant, so `/try` and `/auth/callback` agree by
  construction.
- `components/new-chat-button.tsx`: no longer a form posting a server action.
  It navigates to `/chat` **and** bumps a reset token, because pressing it
  while already on a draft changes no route — a navigation alone would leave
  what was typed sitting there.
- `app/chat/actions.ts`: `createConversationAction` deleted. An action whose
  job is to create an empty conversation is the thing that caused this.

**Creation on first send.** `POST /api/chat` (and `/api/repo-scan/run`) now
accept a missing `conversationId` from a signed-in user, meaning "this is a
draft". They generate the nanoid, write the conversation and the first
message, and return the id in an `X-Conversation-Id` response header. The
client swaps its URL to `/chat/<token>` with `history.replaceState` — not a
router navigation, which would tear down the view while the reply is still
streaming into it — and adds the row to Recents.

The two inserts go through `create_conversation_with_message()`, a plpgsql
function running as the caller, so they share one transaction: a conversation
that exists without its first message is exactly the empty row this change
exists to stop creating, and two round trips from the route would leave a
window for one. It is `SECURITY INVOKER` and takes no user id — it reads
`auth.uid()` — so RLS still applies and a caller can't attribute a
conversation to anyone else.

Creating a conversation therefore costs a chat unit, because it can only
happen as part of a message that has already passed tier enforcement.
Hammering the endpoint to fill the table now runs into the monthly chat cap
first, which the old server action had no equivalent of.

**Unsent drafts** survive a refresh: the composer's text is written to
`localStorage` under `netherite:chat-draft:<user id>` as it's typed, restored
on mount, and cleared once the conversation has actually been created.
Deliberately *not* cleared at the moment of sending — if the send fails before
the conversation exists, a refresh should still bring the text back. Keyed by
user id so a shared browser never shows one account's half-written message to
the next.

**Recents** only lists conversations that have at least one message
(`chat_messages!inner(...)` in `app/chat/layout.tsx`). That is a defensive
check rather than the mechanism: with creation now tied to the first message,
an empty conversation shouldn't exist, and if a future change makes one it
stays out of the sidebar instead of appearing as a phantom the user can't get
rid of. Doing it in the join means the limit of 30 counts real conversations.

**New files**

- `components/chat-session.tsx`: holds the Recents list and the "New chat"
  reset token, wrapping the sidebar and the chat view together. The list moved
  here from `ChatSidebar` because sending the first message in a draft has to
  add a row without navigating anywhere. Reading it without the provider
  (guests on `/try`) yields no-ops rather than a crash.
- `supabase/migrations/20260801000000_create_conversation_with_message.sql`
- `supabase/migrations/20260801010000_delete_empty_conversations.sql`: the
  one-time cleanup. Not a trigger and not scheduled — standing cleanup logic
  would quietly paper over a regression.

**Verified** against the live database, on a production build (port 3111,
leaving the dev server on 3000 alone), driving a real browser with a real
session:

- **"New chat" ×5 → 0 rows**, Recents empty, before and after a refresh. The
  same script against the pre-change build produced 6 rows.
- The Recents query, run as the signed-in user so RLS applied: a conversation
  with messages comes back with its first user message, one with **no**
  messages does not come back at all, and the embedded limit is per
  conversation (a conversation with 8 messages still yields 3, and doesn't
  starve the others). 7/7.
- Regressions, 9/9: an existing conversation still loads its history and
  appends without creating a second one or changing the URL; deleting the last
  conversation lands on an empty draft rather than creating a replacement; a
  guest on `/try` still gets a reply and still persists nothing.
- Unsent text is written to `localStorage` and comes back after a refresh,
  with no row created by typing.
- The failure path releases its reserved usage unit: two sends that failed
  (against a database without the new function yet) left `usage_events`
  untouched at 0.

**Both migrations applied and verified.**

- The cleanup deleted exactly one row — the empty conversation on the real
  account — and kept the one with messages. Zero empty conversations remain.
- **First-message flow, 19/19** in a browser: landing creates no row; unsent
  text survives a refresh without creating one; sending creates exactly one
  conversation whose id matches the token in the URL, saves exactly one user
  message, clears the stored draft, and adds one row to Recents labelled from
  the message; a second message joins the *same* conversation; "New chat"
  returns to an empty draft and creates nothing.
- **`create_conversation_with_message()` probed directly through PostgREST
  with a real user JWT, 16/16** — the Next app bypassed entirely, the way
  someone manipulating requests would. Anonymous callers are refused
  (`42501`). The conversation and message are attributed to the caller's own
  `auth.uid()`. An extra `p_user_id` argument isn't accepted (`PGRST202`) —
  there is no parameter to point at another account. A malformed id, a junk
  id (`'; drop table conversations; --`) and empty content are all rejected,
  and no rejected call left a row behind. A duplicate id fails and rolls back
  *both* inserts, leaving the original with one message. Being
  `SECURITY INVOKER` holds up: the caller still can't read another account's
  conversation, and can't post into one (`42501`).
- **Edge cases, 12/12**: the URL the client swapped in with `replaceState` is
  a genuine route — hard-reloading it returns HTTP 200 with the conversation
  and both messages from the database. Pressing "New chat" while the first
  reply is still streaming resets the draft, doesn't strand or duplicate the
  conversation that was already created, leaves it readable with its message,
  and doesn't leave the composer stuck disabled.
- The 5-click test and the 9/9 regressions were both re-run after the
  migrations: still 0 rows from five clicks.

All probe data removed; the project holds one conversation, with messages,
and no empty ones.

## 2026-07-31 — Usage tracking and tier enforcement

Every LLM call is now metered against a per-month, per-tier cap before it
runs, recorded with the real cost OpenRouter reports, and visible to the user
on `/usage`.

**Caps** (`lib/usage/tiers.ts`, the single source of truth — enforcement and
the dashboard read the same table):

| tier | chat/mo | snippet/mo | repo_scan/mo |
| --- | --- | --- | --- |
| free | 200 | 10 | 2 |
| standard | 2,000 | 150 | 25 |
| pro | 8,000 | 750 | 100 |
| max | 40,000 | 5,000 | 500 |

Chat is a high number rather than `null` on purpose: the dashboard always has
a denominator and no code path has unbounded cost.

**What changed**

- `supabase/migrations/20260731000000_usage_tracking.sql` (new): `usage_events`
  (user_id, action_type, tokens_used, estimated_cost_usd, model, created_at)
  and `user_tiers`. **Both are RLS-enabled with a select-own policy and no
  insert/update/delete policy at all** — a missing policy under RLS is a
  denial, so nobody holding the anon key can write either table. Every write
  goes through the service-role key. That is what stops the two obvious
  attacks: setting your own tier to `max`, and deleting your own usage rows
  to reset the month.
- `reserve_usage(user_id, action_type, limit)`: counts and inserts under a
  `pg_advisory_xact_lock` keyed on (user, action). Counting in the app and
  then inserting would let N parallel requests all read "9 used of 10" and
  all proceed — trivially reachable on purpose, and worth real money on
  `repo_scan`. `SECURITY INVOKER` and `EXECUTE` revoked from anon/authenticated,
  so even a mistaken grant leaves the insert blocked by RLS.
- `lib/supabase/admin.ts` (new): service-role client, guarded by a
  `typeof window` throw and a non-`NEXT_PUBLIC_` env var.
- `lib/usage/index.ts` (new): `reserveUsage` / `releaseUsage` /
  `recordUsageCost`. **Fails closed** — if the ledger can't be reached the
  request is refused, because otherwise "break the usage check" becomes the
  cheapest route to unmetered calls. Costs little availability: these routes
  already need Supabase up for `auth.getUser()`.
- `lib/openrouter.ts`: reads the `usage` object OpenRouter returns on every
  call (`cost`, `total_tokens`) — real billed cost, not a hardcoded price
  table, which is the point of the feature. Streaming carries it in the final
  SSE message, hence the `onUsage` callback. Missing figures stay `null`, never
  `0`, so "unknown" can't masquerade as "free".
- `app/api/chat/route.ts`, `app/api/attachments/route.ts`,
  `app/api/repo-scan/run/route.ts`: reserve after validation and before the
  model call; release on failures that did no work; record cost after. The
  user id is always the one from `supabase.auth.getUser()` — no route reads a
  user id, tier, or count from a request body.
- `lib/repo-scan/config.ts`: `ScanBudget` accumulates usage plus a
  `modelCalls` counter. A scan is dozens of calls across two models, so the
  route writes one row with the total. The refund decision keys on
  `modelCalls`, **not** on whether cost came back — otherwise a provider that
  omits `usage` would make every scan free.
- `app/usage/page.tsx` (new): own quota and cost. Reads through the *user's*
  client so RLS scopes it — a page that only shows you your own data has no
  business holding a service-role key.
- `lib/supabase/middleware.ts`: `/usage` added to `PROTECTED_PATHS` — an
  anonymous request is redirected to login rather than reaching the page.

**Removed same day**

- The owner-facing `/admin/usage` dashboard and its supports:
  `app/admin/usage/page.tsx`, `lib/usage/admin-access.ts` (the
  `ADMIN_USER_IDS` gate), and `getAdminUsage`/`AdminUsageRow`/`AdminUsage`
  plus the email and tier lookups in `lib/usage/queries.ts`. `ADMIN_USER_IDS`
  is no longer read anywhere, so it does not need setting in any environment.
- `supabase/migrations/20260731010000_drop_admin_usage_summary.sql` (new)
  drops the `admin_usage_summary` SQL function, and its type is gone from
  `lib/supabase/usage-schema.ts`. It was already inert — `SECURITY INVOKER`,
  `EXECUTE` revoked from anon and authenticated, granted only to
  `service_role` — but an unused function that returns every user's activity
  isn't worth leaving for a grant to be widened by accident later. Written as
  a follow-up rather than by editing `20260731000000`, which has already been
  applied and should keep recording what was actually run.
- Not dropped: `reserve_usage()` (the enforcement path) and
  `current_month_usage()` (powers `/usage`).
- Untouched: metering itself. Every LLM route still reserves, releases, and
  records cost, and `/usage` still shows the user their own numbers.

**Deployment**

1. `20260731000000_usage_tracking.sql` applied to the live project ✅
2. `20260731010000_drop_admin_usage_summary.sql` applied ✅ — verified against
   the live database: `admin_usage_summary` now returns PGRST202 ("could not
   find the function") even to `service_role`, which was the only role that
   ever had `EXECUTE`. `reserve_usage()` still allows under the cap and blocks
   at it, `current_month_usage()` still answers for a signed-in user, and the
   RLS denials on `usage_events` are unchanged (no insert, no delete, own-row
   read still works). `/usage` renders correctly for a signed-in user and
   still 307s to `/login` anonymously.
3. **Still to do:** `SUPABASE_SERVICE_ROLE_KEY` needs to exist in the Vercel
   environment. It was already in `.env.local` but had never been used by any
   code before this. If it is missing in production every metered action
   returns 503 rather than running unmetered — the safe direction, but the app
   is down until it is set.

**Verified**

- `tsc --noEmit`, `eslint` on all touched files, and `next build` clean.
- `/usage` builds as dynamic (`ƒ`), not prerendered.
- **`/usage` is not reachable anonymously, and is guarded twice.** An
  anonymous GET returns `307 → /login`. So does every middleware-bypass shape
  tried: trailing slash, an RSC payload request (`RSC: 1` + `?_rsc=`), and
  `x-middleware-subrequest: proxy` / `: middleware` (CVE-2025-29927 — 16.2.11
  is patched). Then, to check the page does not merely inherit protection
  from the proxy, `PROTECTED_PATHS` was temporarily cut to `["/chat"]` and
  rebuilt: an anonymous GET `/usage` **still** returned `307 → /login`, from
  the page's own `if (!usage) redirect("/login")`. `PROTECTED_PATHS` was
  restored and rebuilt afterwards. The middleware entry is convenience; the
  page-level check is the boundary, which is the arrangement CLAUDE.md asks
  for.
- **20/20 against the live database**, driving raw PostgREST with a real
  authenticated JWT — i.e. bypassing the Next.js app entirely, which is what
  "manipulating requests directly" actually means. With a genuine user token
  it is not possible to: insert a usage row (own or someone else's), delete
  or backdate own rows, insert or update own tier to `max`, call
  `reserve_usage` with an inflated limit, call `admin_usage_summary`, or read
  another user's rows. Reading own rows still works, so the dashboard
  functions.
- **The race is real and the lock holds**: 20 parallel reservations against a
  limit of 5 allowed exactly 5, with exactly 5 rows in the ledger afterwards
  and no errors.
- **10/10 end-to-end** against a running dev server with a forged-but-valid
  SSR session cookie: an allowed chat writes exactly one row with real
  figures (`tokens=622, cost=0` — the advisor model is `:free`, so zero is
  correct and is a *reported* zero, not a missing one); at the cap the route
  returns 402 with the upgrade message and writes neither a usage row nor a
  chat message; flipping the tier to `standard` lets the same user straight
  through; `repo_scan` blocks before any clone; and adding
  `tier`/`user_id`/`limit`/`skipUsageCheck` to the request body changes
  nothing.
- Test users and rows were removed afterwards; `usage_events` and
  `user_tiers` confirmed empty.
- **`/usage` driven in a real browser** (Playwright, production build on
  :3111). 4,202 seeded events across five users on all four tiers, light and
  dark, 1440px and 390px. All 200, **0px horizontal page overflow
  everywhere**. `/usage` read through RLS agreed exactly with a service-role
  rollup of the same data ($1.46, 412/88/31 for the same user), which is the
  cross-check that matters — two different code paths, two different key
  scopes, same numbers. All three meter states render: normal, near-limit
  (amber, "3 left this month"), exhausted (red, "Limit reached") plus the
  upgrade callout.
- Seeded users and rows removed again afterwards; both tables back to 0.
- **8/8 on the `snippet` path** (`POST /api/attachments`, real multipart
  upload, real session): a valid code file spends exactly one snippet unit and
  no other kind; a rejected file (disallowed extension) leaves the count
  unchanged, so the release path works; at 10/10 the route returns 402 naming
  the snippet limit and the upgrade. Storage object cleaned up.
- **4/4 on the scan refund branch**: a valid GitHub URL for a repo that
  doesn't exist reserves, fails to clone, makes zero model calls, and refunds
  the unit — twice in a row, with the free tier's 2 scans still intact
  afterwards. This is the branch with real quota consequences (a bug here
  would mean every scan is free), which is why it was worth triggering
  deterministically rather than reasoning about.

**Still not verified**

- **A successful scan's cost aggregation.** The `modelCalls > 0` branch —
  summing tokens and dollars across dozens of calls spanning two models into
  one `usage_events` row — has never run. It is reporting, not enforcement: a
  bug there produces wrong numbers on `/usage`, not free scans. Testing it
  costs real OpenRouter credits and a few minutes, so it's left for a real
  scan rather than done unilaterally.
- **`releaseUsage` when OpenRouter fails mid-chat-request.** Needs an induced
  upstream failure to reach.
- **Anything on Vercel.** Nothing has been deployed; see Deployment above.

**Fixed during verification**

- `toLocaleString()` with no locale follows the *server's* ICU default, not
  the reader's, and rendered "Upgrade to Standard for 2 000 per month" — a
  narrow no-break space inside otherwise English copy. All call sites now pin
  `en-US` via `formatCount()`.

**Open, from the security review**

- Guest chat stays unmetered by design (no account to attribute to), so
  logging out is a way around the `chat` cap specifically: 15/hour per IP
  ≈ 10,800/month versus a free tier's 200. Zero cost exposure today because
  the advisor model is `:free`, but that stops being true the moment that
  model id changes.
- Pasting code into the composer spends a `chat` unit rather than a `snippet`
  one; the server can't reliably tell a pasted snippet from a question. No
  path is unmetered, it's the wrong allowance. Closing it properly needs the
  dedicated snippet endpoint from CLAUDE.md's feature list.
- A scan that fails before any model call (bad URL, clone failure, no
  reviewable files) refunds its unit, so clone-only cost isn't charged
  against quota — bounded only by the existing 3/hour limiter. Deliberate: a
  typo'd URL otherwise costs a free user half their monthly allowance.

## 2026-07-29 — Clickable chat preview + one shared chat-entry path

Made the landing page's "Ask Netherite" preview card a real entry point, and
collapsed the auth-check-and-redirect behind every chat entry point into one
shared function.

**What changed**

- `lib/chat-entry.ts` (new): `resolveChatEntryPath(supabase, userId)` — the
  single source of truth for where a signed-in user lands when entering chat
  from outside it: **most recent conversation, or a freshly created one if
  they have none**. Also exports `CHAT_ENTRY_PATH` (`/try`).
- `components/chat-entry-link.tsx` (new): the only way the marketing site
  links into chat. Header button, hero button, and the preview card all
  render this, so the destination is defined once instead of per-button.
- `app/page.tsx`: the whole `netherite-chat` preview card is now wrapped in
  `ChatEntryLink` (an `<a>`, with an `aria-label` since the sample chat
  inside would otherwise become its accessible name). Both existing "Try
  Netherite" buttons were switched from hardcoded `<Link href="/try">` to
  the same component.
- `app/try/page.tsx`, `app/chat/page.tsx`, `app/auth/callback/route.ts`: all
  three now call `resolveChatEntryPath` instead of each doing their own
  thing. This removed a genuine duplicate — `auth/callback` already had the
  most-recent-else-create query inline, and `/chat` had a *different*
  behaviour (always created a brand-new conversation on every visit).
  **Behaviour change:** visiting `/chat` directly now resumes your most
  recent conversation rather than silently spawning a new one. Nothing
  linked to `/chat` expecting "new chat" — the sidebar's New chat button
  goes through `createConversationAction`, which is untouched.
- `app/globals.css`: added a `--border-strong` semantic token (light
  `khaki_beige-400`, dark `jet_black-600`) for hover/active borders on
  interactive surfaces. Needed because Tailwind's alpha modifiers
  (`border-accent/50`) silently compile to a *solid* color here — it can't
  resolve alpha through the two-level `--color-accent: var(--accent)`
  indirection these semantic tokens use. Verified in the compiled CSS, not
  assumed; `color-mix()` in an arbitrary value collapsed the same way.

**Note on shape:** the request suggested a client hook (`useChatEntryRedirect`).
That was not built, deliberately — auth checks must stay server-side per the
security rules in CLAUDE.md, and the "Try Netherite" button never had any
client-side auth logic to extract (it was a plain `<Link href="/try">`; the
branching has always lived in the `/try` route). The shared function is
therefore server-side, and the two entry points share it by construction:
they render the same component pointing at the same route.

**Verified (not just "looks done")**

- `npx tsc --noEmit` and `eslint` on all changed files: clean.
- Created a real Supabase auth user with a real session cookie (minted via
  `@supabase/ssr` itself, so the cookie format matches exactly what the app
  reads) and drove real Chrome over CDP. Full matrix, **all three entry
  points clicked for real** (preview card, header button, hero button):
  - logged out: all three land on `/try`, guest banner present.
  - logged in: all three land on the *same* `/chat/<most-recent-id>`.
- Confirmed the "no conversations yet" branch creates exactly one
  conversation, and that hitting the entry points twice more reuses it
  rather than creating more (checked row counts via the service-role client,
  bypassing RLS: `count=1` after 3 hits). Then inserted a newer conversation
  and confirmed both entry points switch to it.
- Hover/active states read out of `getComputedStyle` with CDP
  `CSS.forcePseudoState`, in **both** themes:
  - dark: border `#1b282f` -> `#40606f`, `translate: 0 -4px`, shadow
    `0 20px 40px /.06` -> `0 28px 56px /.10`; `:active` drops the lift and
    applies `scale(0.995)`.
  - light: border `#d2bda5` -> `#b08b62`, same lift.
  - `motion-reduce:` variants confirmed to be wrapped in a real
    `@media (prefers-reduced-motion: reduce)` block in the compiled CSS.
- Test user and its conversations deleted afterwards (cascade verified:
  2 rows -> 0).

**What's next**

- The OAuth callback path was refactored but not exercised through a real
  provider round-trip (still needs a live Google/GitHub sign-in to confirm
  end-to-end). The query it now calls is the same one it ran inline before.
- `.marquee-track` still animates unconditionally; it has no
  `prefers-reduced-motion` guard. Pre-existing, untouched here.

## 2026-07-28 — Guest chat mode

Added a temporary, unauthenticated "guest chat" experience behind the
"Try Netherite" CTA on the landing page.

**What changed**

- `app/try/page.tsx` (new): guest chat route. Redirects already-signed-in
  users to `/chat`; otherwise renders the chat UI with no login required.
  Sits outside the `/chat` prefix specifically so the proxy's
  `PROTECTED_PATHS` auth gate (`lib/supabase/middleware.ts`) never touches it
  — no changes were made to that gate.
- `app/chat/chat-view.tsx`: `conversationId` is now optional and there's a
  new optional `banner` slot, rendered persistently above the composer in
  both the empty and in-conversation states. Reused as-is for both
  authenticated and guest chat rather than forking a second copy of the
  streaming/composer logic.
- `components/guest-banner.tsx` (new): dismissible "This conversation isn't
  saved — sign in to keep your chat history" banner with a sign-in link.
  Dismissal is local `useState` only — refreshing brings it back, which is
  correct since guests have no persistence layer to remember it in.
- `app/api/chat/route.ts`: no longer requires auth. Persistence (both the
  user-message and assistant-message inserts into `chat_messages`) is now
  gated on `user && conversationId` together — guests have neither, so
  those inserts never run for them, under any code path. `conversationId`
  is likewise only required/validated when `user` is present.
- `lib/rate-limit.ts` (new): in-memory, per-IP fixed-window limiter — 15
  guest messages/hour, keyed off `@vercel/functions`'s `ipAddress()` helper
  (reads `x-real-ip`, which Vercel's own proxy computes and sets — not
  something a client can hand it a fake value for; NextRequest lost
  `.ip`/`.geo` in v15, per the bundled Next docs). Only applied to
  unauthenticated `/api/chat` requests; logged-in users are untouched.
  **Known limitation, called out in the code and in the security review
  below: this is per-server-instance.** It resets on redeploy/cold start and
  a distributed attacker hitting multiple concurrent Vercel instances can
  exceed the configured limit in aggregate. No Redis/Vercel KV exists in
  this repo yet, so this is the pragmatic default for a temporary feature —
  swap in a shared store if guest chat becomes permanent.
- Landing page's two "Try Netherite" buttons now link to `/try` instead of
  `href="#"`.

**Verified (not just "looks done")**

- `npx tsc --noEmit` and `eslint` on all changed files: clean.
- Loaded `/try` in a real (headless Chromium) browser: banner, header, hero,
  and streamed chat all render correctly with no console errors —
  screenshots taken before/after sending a message and after dismissing the
  banner.
- Sent a real guest message through the live dev server and confirmed via
  the Supabase REST API (service role, bypassing RLS) that its exact content
  never appears anywhere in `chat_messages` — zero rows, not just "should be
  gated by code."
- Hit `/api/chat` directly with synthetic per-IP `X-Real-Ip` headers: 15
  requests allowed, 16th+ return `429` with `Retry-After: 3600`; a second,
  independent IP is unaffected by the first one's limit. Also confirmed a
  fake `X-Forwarded-For` alone (no `X-Real-Ip`) has zero effect on the
  limit post-fix — the old spoofable path is dead.
- Did **not** live-test the "already-authenticated user visiting `/try`
  redirects to `/chat`" and "signing in mid-guest-chat lands in the normal
  authenticated experience" paths against a real OAuth session (would have
  required creating a real Supabase auth user). Both rest on the same
  `if (user) redirect(...)` idiom already used and working in
  `app/chat/page.tsx`, `app/chat/actions.ts`, and `app/auth/callback/route.ts`
  — not new/novel logic.
- Ran the `security-code-review` skill against the new rate-limiting logic
  specifically (`lib/rate-limit.ts` + the auth/persistence branching in
  `app/api/chat/route.ts`). The auth/persistence branching in route.ts came
  back clean. Two findings in rate-limit.ts, both fixed:
  - Unbounded growth of the in-memory IP map (no cap on distinct tracked
    IPs) — added a hard cap (`MAX_TRACKED_IPS`) that fails closed for
    new/unrecognized visitors once full, rather than growing forever.
  - `getClientIp` trusted the first `X-Forwarded-For` entry, which is
    attacker-settable on the request itself — a guest could fake a new IP
    on every message and bypass the per-IP cap entirely. Switched to
    `@vercel/functions`'s `ipAddress()` (added as a dependency): reading its
    source confirmed it deliberately ignores `x-forwarded-for` and only
    reads `x-real-ip`, the header Vercel's own proxy computes itself. Old
    hand-rolled header parsing removed entirely rather than kept as a
    fallback, so there's no lingering spoofable path.

**Next**

- No shared rate-limit store yet — revisit if guest chat stays around
  past the "temporary" stage or abuse shows up in practice.
- Guest → sign-in flow was not migration-tested end to end with a real
  account (see above); worth a manual pass with a real login next time
  someone's testing this by hand.

## 2026-07-28 — File attachments (authenticated chat only)

Added a "+" attach button (mirrors the send button's style) to the left of
the composer, with a dropdown for "Upload file". Guests don't get this —
uploads require a real account since Storage RLS is scoped to `auth.uid()`.

Scope note: **"Attach GitHub repo" and "Upload image" were explicitly cut
from this pass.** There's no repo-cloning/scanning pipeline anywhere in this
app yet (only the chatbot — feature #2 on CLAUDE.md's roadmap doesn't exist)
to hook a repo-attach button into; building one for real is a much bigger,
separate, security-sensitive feature (arbitrary server-side git cloning),
not "a different entry point into existing logic." Image upload's backend
(Storage, validation, magic-byte sniffing) is fully built and reusable, but
it isn't wired into the UI — whether the configured OpenRouter model
(`inclusionai/ling-3.0-flash:free`) actually supports image/vision input
couldn't be confirmed, and shipping an "attach image" button that silently
doesn't get seen by the model would be a broken, not just incomplete,
feature.

**What changed**

- `supabase/migrations/20260728000000_chat_attachments_storage.sql` (new):
  private `chat-attachments` Storage bucket + RLS policies scoping every
  select/insert/delete to `(storage.foldername(name))[1] = auth.uid()`.
  Objects are keyed `{user_id}/{uuid}-{sanitized filename}` — the user_id
  prefix is always server-set, never client-chosen, so there's no way for a
  crafted filename to land outside the uploader's own scope.
- `app/api/attachments/route.ts` (new): `POST` validates extension
  allow-list + 2MB cap (files) / 4MB cap + magic-byte sniff (images, backend
  only — see above), rejects oversized requests by `Content-Length` before
  parsing the body, rate-limits per user id, uploads to Storage, decodes
  and returns (truncated-if-needed) text. `DELETE` removes an attachment a
  user cancels before sending, with an explicit owner-prefix check
  alongside RLS.
- `lib/rate-limit.ts`: added `checkUploadRateLimit(userId)` — 20
  uploads/hour, sharing the same fixed-window limiter class the guest-chat
  limiter uses. Keyed by verified user id, not a header, so (unlike the
  guest limiter) there's no spoofing concern here at all.
- `app/api/chat/route.ts`: per-message length cap is now auth-aware
  (`MAX_MESSAGE_LENGTH_GUEST = 6000`, unchanged; `MAX_MESSAGE_LENGTH_AUTHENTICATED = 30000`)
  so an attached file's text comfortably fits as one message without
  loosening anything for guests.
- `app/chat/chat-view.tsx`: attach button, dropdown, upload handling,
  dismissible chip with remove button. On send, the file's text gets folded
  into that message's content client-side (`[Attached file: x]` + fenced
  block + the question) and sent/persisted like any normal message — no
  second LLM pipeline, reuses `/api/chat` exactly as asked.

**Verified (not just "looks done")**

- `npx tsc --noEmit` and `eslint`: clean throughout.
- Created disposable Supabase auth users via the admin API (service role
  key) and signed in as them using the real `@supabase/ssr` code path
  (so the session cookie is byte-for-byte what a browser would get),
  injected into a headless-Chromium context to drive the actual
  authenticated UI. All test users and their storage objects were deleted
  afterward — nothing left behind in the real project.
- Live, end-to-end in a real browser: `.exe` rejected, 3MB file rejected
  (2MB cap), valid `.ts` file accepted → chip appears → removed → chip
  gone → re-attached and sent → real streamed LLM response that
  substantively engaged with the attached code's actual content.
- Confirmed via the Storage REST API (service role) that uploads land at
  `{user_id}/...`, and — the important one — that a **second, unrelated
  test user's request for the first user's file came back 404** (RLS
  hides it entirely) while the owner's own request succeeded.
- Confirmed per-user upload rate limiting live (cumulative across test
  runs, correctly attributed per user id).
- Found and fixed one real issue in the `security-code-review` pass:
  `POST`/`DELETE` parsed the full request body before any size check ran,
  so an authenticated user could send an oversized payload to burn server
  memory before being rejected. Added an early `Content-Length` guard;
  re-verified live — a genuine 6MB body now gets a fast `413`.
- One real gap surfaced during testing, not a security issue: "remove
  attachment" fires a fire-and-forget `DELETE` that can be interrupted if
  the user navigates away/closes the tab immediately after clicking it,
  leaving an orphaned (but still correctly access-controlled) Storage
  object. Low-stakes — accepted as-is rather than reaching for
  `navigator.sendBeacon` for this one edge case.
- The migration required a manual step: no `supabase` CLI link or DB
  connection string is available in this environment, so the RLS policies
  had to be applied by hand via the SQL editor (same limitation as the
  pre-existing `chat_messages` migration) before live-testing could
  proceed — the bucket itself was created via the Storage API, which
  doesn't need raw SQL.

**Next**

- Revisit "Attach GitHub repo" once real repo scanning exists as its own
  feature.
- Revisit image upload once vision support for the configured model (or a
  swap to one that has it) is confirmed — the upload/storage side is
  already done.

## 2026-07-30 - 404 page

Added a custom not-found page so unmatched URLs land on something that looks
like the rest of the site instead of Next's default black-and-white 404.

**What changed**

- `app/not-found.tsx` (new): root 404, built from the same shell every other
  standalone page uses (`inter.variable` + `bg-sidebar` + `font-sans`), the
  same logo header as `/login`, and the same footer as the docs layout. Large
  mono `404` as the visual (`text-border-strong`, `aria-hidden` since the
  heading already says it), `Page not found` heading at the same clamp scale
  as the login heading, and two CTAs reusing the existing button treatments -
  accent-filled "Back home" and bordered "Read the docs".
- No `metadata` export: Next only reads it from layout/page and
  `global-not-found`, so the title falls through to the root layout's. Next
  injects `noindex` on 404 responses itself.
- Not using the experimental `globalNotFound` flag - it exists for apps with
  multiple root layouts or a top-level dynamic segment, and this app has
  neither, so plain `app/not-found.tsx` is the right convention here.

**Verified**

- `npx tsc --noEmit` and `eslint app/not-found.tsx`: clean.
- Live against the running dev server: `GET /this-route-does-not-exist`
  returns HTTP **404** (not a 200 soft-404) and the rendered HTML contains the
  new page's heading and both CTAs.

**Note**

- `app/chat/[id]/page.tsx` calls `notFound()` for a conversation that doesn't
  exist or isn't yours. That has no not-found boundary in its own segment, so
  it now renders this root page full-screen rather than anything inside the
  chat shell. Correct, but if that should instead render inside the chat
  sidebar layout, it needs its own `app/chat/[id]/not-found.tsx`.

## 2026-07-30 — "Attach GitHub repo" (the half cut from the 2026-07-28 pass)

The `+` menu now has both options it was always specified to have: **Upload
file** (shipped 2026-07-28) and **Attach GitHub repo**. Repo scanning itself
still doesn't exist, so this captures and validates the URL and stubs the
scan call — the UI is finished and the endpoint is the seam the real scanner
plugs into.

The important design call: the model is told, in the message itself, that no
files were read. Attaching a repo and letting the advisor produce a
confident-sounding "scan report" for code nobody looked at would be worse
than not shipping the button — for a security tool, a fabricated clean bill
of health is the most damaging possible output. Verified live that it
declines instead: *"I haven't read any files from that repo … I won't report
findings I can't have."*

**What changed**

- `lib/github-repo.ts` (new): one `parseGitHubRepoUrl` shared by client and
  server so the two can't drift. Host allow-list (`github.com`,
  `www.github.com`), rejects embedded credentials, non-default ports, and
  non-http(s) schemes (so `git@github.com:…` and `javascript:` are out),
  never percent-decodes (an encoded `%2e%2e` stays literal and fails the
  character allow-list), and validates owner/repo against GitHub's own
  naming rules. Returns a normalized `canonicalUrl` built only from
  validated segments — never the raw input. A `…/tree/<ref>` URL keeps the
  ref only when unambiguous; a deeper path can't be split into ref vs
  subdirectory without asking GitHub, so it falls back to the default branch
  rather than guessing.
- `app/api/repo-scan/route.ts` (new): auth-gated, rate-limited, re-validates
  the URL server-side, returns `scanAvailable: false`. Does **no** outbound
  request — resolving an attacker-supplied URL server-side would be an SSRF
  sink, and that's exactly the decision the real scanner has to make
  deliberately rather than inherit. The stub call site is marked, with a note
  that repo values must reach git as separate argv entries, never a shell
  string.
- `lib/rate-limit.ts`: `checkRepoScanRateLimit` — 10/hour per verified user
  id, its own limiter rather than sharing the upload bucket, since real
  cloning will cost far more per request than a string parse and raising the
  file-upload allowance later shouldn't loosen it.
- `app/chat/chat-view.tsx`: second menu item, inline URL field (Enter to
  submit, Escape to cancel, disabled until non-empty), chip showing
  `owner/repo`, the branch when known, and `· not scanned yet`.
  `PendingAttachment` is now a discriminated union, and the message-folding
  logic moved into `buildMessageContent`.

**Verified (not just "looks done")**

- `npx tsc --noEmit` and `eslint`: clean (one pre-existing `_prevState`
  warning in `app/chat/actions.ts`, untouched).
- URL parser: 49 cases, 0 failures — 14 accepted (including `.git` suffixes,
  scheme-less pastes, `/tree/<branch>`, mixed case) and 35 rejected,
  covering lookalike hosts (`github.com.evil.com`), credential smuggling
  (`https://evil.com@github.com/…`), custom ports, SSH/`git://`/`javascript:`
  /`data:` schemes, percent-encoded traversal, shell metacharacters in the
  path, and github.com site routes (`/features/copilot`).
- Endpoint, live against a real Supabase session: 15 checks, 0 failures —
  401 unauthenticated, 200 + normalization on valid input, 400 for hostile
  URLs / non-string / malformed JSON, 413 for a 1MB body against the 4KB cap
  (with a 3KB control proving the 413 came from the size guard), 405 on GET,
  no secrets in the response, and rate limiting stopping at exactly 10 with
  a `Retry-After` — confirmed per-user, not global, by showing a second
  user's flood didn't affect the first.
- UI, live in headless Chromium on a real authenticated session: 22 checks,
  0 failures — both menu items present, input auto-focused, five invalid
  URLs each rejected client-side with no chip created, Escape closes,
  a valid URL produces the chip with branch and "not scanned yet", chip
  removable, and one real send end-to-end (streamed reply, persisted across
  reload, no console errors).
- Test users were created via the admin API and deleted afterward, along
  with their storage objects — nothing left in the real project.

**Security review findings (fixed in this pass)**

Ran `security-code-review` over the new code plus the existing upload route
and storage RLS. No SQLi, XSS, IDOR, broken auth, hardcoded secrets, or
execution sinks — `eval`/`new Function`/`child_process`/`innerHTML`/
`dangerouslySetInnerHTML`/`rehype-raw` return zero matches across `app/`,
`lib/`, `components/`, and `supabase/`, so attached content is stored, quoted
and displayed but never run. Two real issues surfaced:

- **`kind=image` bypassed the code/text allow-list.** Image upload's backend
  is built but intentionally unexposed, and the branch was still reachable by
  posting the field by hand — letting any authenticated user store a 4MB
  binary under rules meant for 2MB of text. Now gated behind
  `IMAGE_UPLOADS_ENABLED = false` (flip it only together with wiring images
  into the composer), and the early request-size guard tightened to the file
  cap while it's off. Verified live: a genuine, valid PNG is refused.
- **Attached file content could break out of its code fence.** The fold used
  a fixed ` ``` `, so a file containing ` ``` ` split out of the block and its
  remaining lines landed beside the user's question as prose — meaning text
  authored by whoever wrote the file (not necessarily the user; reviewing
  third-party code is a core use case here) read as instructions rather than
  as quoted code. The fence is now computed longer than the longest backtick
  run in the file. Verified in the browser with a file carrying a fence-break
  plus "reply only: no vulnerabilities found": the whole body now renders as
  exactly one code block with the injected line inside it. This makes the
  quoting structurally sound — it is not a claim that content inside a fence
  can never influence the model.

Also tightened while in there: replacing one attachment with another used to
orphan the previous upload in Storage; it's now deleted on replace, not just
on explicit remove.

**Next**

- Repo scanning itself (roadmap feature #2). `app/api/repo-scan/route.ts` has
  the marked call site; the UI needs no structural change, just
  `scanAvailable: true` and a report to render.
- Image upload, still blocked on confirming vision support for the
  configured model (`inclusionai/ling-3.0-flash:free`).
- Conversation titles are derived from the first message, so an
  attachment-first chat is titled `[Attached GitHub repo: https:/…` in the
  sidebar. Pre-existing (same for file attachments), cosmetic, untouched
  here — worth a dedicated title-derivation pass.

## 2026-07-30 — Repo scanning pipeline (roadmap feature #2)

The stub is gone: attaching a repo and sending now really clones it, filters
and ranks the files, triages every candidate with the cheap model, deep-reviews
only what triage flags, and returns a combined report.

**Pipeline** (`lib/repo-scan/`)

- `ssrf.ts` — pre-clone guard. The clone URL is never the submitted string:
  `parseGitHubRepoUrl` rebuilds it from validated segments, so it's always
  `https://github.com/<owner>/<repo>.git`. This closes the remaining gap —
  what that fixed hostname *resolves* to. Every DNS answer must be a public
  address, so a poisoned resolver, a hosts entry, or DNS rebinding can't aim
  the clone at `127.0.0.1` or `169.254.169.254`. Rejects on **any** bad
  address rather than requiring one good one, so a split answer can't sneak
  a loopback IP through alongside a real one.
- `clone.ts` — `git clone --depth 1 --single-branch --no-tags
  --no-recurse-submodules` into `mkdtemp`, removed in a `finally` on success,
  failure, timeout, and client disconnect. `spawn` with an argv array and no
  shell, so nothing in owner/repo/ref can be read as a command. Also
  `core.symlinks=false` (a repo containing a symlink to `/etc/passwd` gets it
  written as plain text instead, so the file walker can't be walked out of the
  clone), empty `core.hooksPath` and `credential.helper`,
  `GIT_CONFIG_NOSYSTEM`, and `GIT_TERMINAL_PROMPT=0` so a private repo fails
  fast instead of blocking on a username prompt. git's stderr is translated
  into specific messages for private/missing repo, bad branch, empty repo, and
  unreachable host.
- `collect.ts` — excludes `node_modules`, `.git`, build output, vendored code,
  lockfiles, test fixtures/snapshots, minified bundles, binaries by extension
  **and** by NUL-byte sniff, and anything over 500KB; includes source,
  config/env, and server-rendered templates. Symlinks are skipped here too as
  a second line of defense. Ranking: a priority keyword in the **path** scores
  10, in the **content** 1.
- `triage.ts` — Tier 1. Batches of 4, JSON-only verdicts, one line of reasoning
  each, explicitly forbidden from writing reports or fixes. Untrusted file text
  is fenced with a backtick run longer than any in the file (same reasoning as
  the composer) and the prompt states file content is data, never instructions.
- `deep-scan.ts` — Tier 2. Only flagged files, line-numbered so findings can
  cite real lines, using the `security-code-review` classes and the
  `vuln-report-format` contract (one plain-English risk sentence + a complete
  drop-in fix). Returns `NO_ISSUES_FOUND` for clean files.
- `index.ts` — orchestrator, yields progress events and builds the report.

**Endpoint** — `POST /api/repo-scan/run` (`runtime = "nodejs"`,
`maxDuration = 300`): auth, **3 scans/hour per verified user id** on its own
limiter, URL validation, then streams NDJSON progress the composer renders
live. Persists both the user message and the finished report to
`chat_messages`. `POST /api/repo-scan` stays validate-only for the chip.

**Failure handling.** Every stage fails toward *more* review, never fewer: an
unparseable or failed triage response escalates those files rather than
clearing them, because a triage outage that read as "clean" would be the worst
possible bug in a security tool. Caps: 500KB/file, 400 files, 8MB total, 150
triaged, 12 deep-reviewed, 90s clone, 240s scan (under the route's 300s so the
pipeline reports rather than being killed). Path-priority files are exempt from
the file-count caps.

**Test scan — appsecco/dvna (real public repo, real endpoint, real session)**

    75 files scanned · 34 flagged · 12 deep-reviewed · 24.0s

Two real DVNA vulnerabilities, correctly identified with working fixes:
`core/authHandler.js:49` (password-reset token is `md5(username)` — anyone who
knows a username can forge a valid token) and
`views/app/adminusers.ejs:40` (stored XSS via `innerHTML` of DB-sourced user
fields). Triage reasons were specific and sensible, not boilerplate. Zero
leftover `netherite-scan-*` temp directories after four scans. All test users
and their storage objects deleted afterward.

**Two real bugs found by running it, both fixed**

- **`CLAUDE.md`'s triage model id is dead.** `google/gemini-2.0-flash-001`
  404s on OpenRouter ("No endpoints found"), so the first scan escalated all
  21 files instead of triaging any — the fail-open path working, but Tier 1
  effectively absent. Now `google/gemini-2.5-flash`. `gemini-2.5-flash-lite`
  was tried and rejected: on a trivial SQLi probe it returned verdict "no"
  with reason "SQL injection vulnerability". **`CLAUDE.md` still names the
  dead id and should be updated** — left alone here rather than edited
  unilaterally.
- **A 402 read as a generic outage.** The OpenRouter key is free-tier and its
  balance ran out mid-scan; 10 of 12 deep reviews failed with "the model
  backend is unavailable", which points at the wrong problem entirely. 402,
  429, and 404 now produce distinct, actionable messages, and the first 402
  sets a per-scan flag so the remaining calls skip instead of collecting a
  dozen copies of the same error (verified: the deep stage went from 37s of
  doomed calls to 0.4s).

**Next**

- **Blocked on credits:** a single run with *both* working triage and all 12
  deep reviews succeeding needs an OpenRouter top-up — Sonnet headroom is
  ~335 tokens against the ~2000 a report needs. Triage (Gemini) still runs
  fine. Nothing in the pipeline is waiting on code.
- **Won't run on Vercel as-is.** Serverless functions have no `git` binary.
  Options: swap `clone.ts` for a codeload tarball fetch (same interface, one
  file), or host this route somewhere with a real filesystem and git.
- Rate-limit state is still per-instance and in-memory (pre-existing
  limitation, now applied to a much more expensive endpoint) — worth backing
  with Redis/Vercel KV before this is public.

## 2026-07-30 — Model ids documented; image-upload question answered

Recorded all three configured models in `CLAUDE.md` instead of two, after the
scan pipeline turned up a retired id sitting in the doc unnoticed. Each is
verified present in `GET https://openrouter.ai/api/v1/models`, and the doc now
says to run that check before changing an id.

- Triage model corrected to `google/gemini-2.5-flash`, with the reasoning kept
  next to it so the retired `gemini-2.0-flash-001` doesn't get restored and
  `flash-lite` doesn't get substituted.
- Added the advisor chatbot's model (`inclusionai/ling-3.0-flash:free`), which
  `CLAUDE.md` never mentioned at all even though it's what feature #3 runs on
  — the same blind spot that let the dead triage id go unnoticed.
- `lib/openrouter.ts`'s comment used to assert that `CLAUDE.md` named the
  retired id; that became false when the doc was fixed, so it now defers to
  `CLAUDE.md` rather than contradicting it.

**The open image-upload question is settled: no.** OpenRouter reports
`inclusionai/ling-3.0-flash:free` with input modalities `["text"]`, so the
advisor cannot see images at all. That's been the blocker on wiring up image
attachments since 2026-07-28, and it was never a matter of testing — it's a
property of the model. Image upload therefore stays off (`IMAGE_UPLOADS_ENABLED
= false` in `app/api/attachments/route.ts`) until the advisor model is swapped
for one accepting image input; both scan models already do
(`claude-sonnet-4.6`: `["text","image","file"]`, `gemini-2.5-flash`:
`["file","image","text","audio","video"]`). Noted in `CLAUDE.md` next to the
model id so the constraint is found before the work is attempted, not after.

## 2026-07-30 — Chat column widened and unified

The chat column felt narrow, and measuring it turned up a second problem: three
different widths were in play, so the composer sat visibly inset from the
message bubbles and the column changed width after the first message.

**Before → after** (measured in a real browser, 1440x900):

| Element | Before | After |
| --- | --- | --- |
| Message column | 720px | 896px |
| Composer row | 605px | 848px |
| Empty-state composer | 612px | 848px |
| Assistant bubble | 571px | 721px |

**What changed** — all in `app/chat/chat-view.tsx`:

- Added `CHAT_COLUMN` (`mx-auto w-full max-w-4xl px-4 sm:px-6`) as the single
  source of truth, used by the message list, the composer wrapper in both
  states, and the empty-state column. Replaces `max-w-[720px]` (list),
  `max-w-[680px]` (empty state), and the composer's own `w-[90%]` — that last
  one was the actual cause of the misalignment, since 90% of whatever parent it
  landed in never matched the list's width.
- `max-w-4xl` (896px) rather than wider: enough for the code blocks and tables
  scan reports produce, still short enough that prose lines stay readable.
- Gutters are `px-4` under 640px and `px-6` above, so narrow viewports use the
  space they have without text touching the edge.
- Bubbles are now responsive: user `max-w-[88%] sm:max-w-[75%]`, assistant and
  error `max-w-full sm:max-w-[85%]`. On a 390px screen the user bubble went
  257px → 315px and the assistant bubble 291px → 358px, which is where the
  "too narrow" feeling was worst.
- Added `min-w-0` to the assistant bubble so a wide code block can't push it
  past its cap as a flex child.

**Verified** — `tsc --noEmit` and `eslint` clean. Screenshots and DOM
measurements at 1440px, 768px (sidebar open), and 390px, on a seeded
conversation containing a long prose line, a code block with a deliberately
long line, and a table:

- Composer width now equals the message column's content width at every
  viewport tested (848/848 at 1440, 460/460 at 768, 358/358 at 390).
- Code blocks still scroll inside their bubble (`scrollWidth > clientWidth`)
  rather than stretching the column.
- `documentElement.scrollWidth === innerWidth` at all three sizes — no
  horizontal page scroll.
- Empty state and message state now render the composer at identical widths.

Test data was seeded directly through the service role (no LLM calls, since
OpenRouter credits are exhausted) and the user was deleted afterward.

**Correction to an earlier note in this entry:** the dark circle overlapping
the bottom-left of the composer in the mobile screenshots was first written up
here as the sidebar's user-avatar chip needing a fix in `chat-shell.tsx`. That
was wrong. `document.elementFromPoint` resolves it to `nextjs-portal` (an open
shadow root), i.e. the **Next.js dev-mode indicator** — and on mobile
`sidebarWidth` is 0 with the email chip not laid out at all
(`getBoundingClientRect()` at 0,0, zero width). It's a `next dev` artifact that
doesn't exist in a production build, so there's nothing to fix in
`chat-shell.tsx`.

## 2026-07-30 — Composer buttons moved inside the input

The `+` and send buttons were two 50px squares sitting outside the input field.
On a 390px screen those plus their gaps cost ~120px, leaving the textarea about
198px — which is why the input felt small on mobile. Both now sit inside the
input pill, and they're smaller.

**Before → after:**

| | Mobile 390px | Desktop 1440px |
| --- | --- | --- |
| Textarea width | 198px → **252px** (+27%) | 688px → **750px** (+9%) |
| Button size | 50x50 → **40x40** | 50x50 → **36x36** |
| Composer height | ~51px → **54px** | ~51px → **53px** |

The "after" numbers are measured in a browser; the "before" textarea widths are
**derived from the removed classes, not measured.** The old markup was
`flex gap-2.5` with two `h-[50px] w-[50px]` buttons around a `flex-1` pill at
`px-5`, so on mobile: 358 − 50 − 10 − 50 − 10 = 238px of pill, less 40px of
padding = 198px; desktop is the same arithmetic from 848px. Stating it plainly
because this pass reused the previous pass's screenshot filename label and
overwrote its "after" images, so there is no before/after image pair for this
change — only for the width change above.

**What changed** — `app/chat/chat-view.tsx`, composer only:

- One `rounded-3xl` pill contains the `+` button, the textarea, and the send
  button. The old layout was `flex gap-2.5` with the pill as the middle child.
- Buttons are `h-10 w-10 sm:h-9 sm:w-9` — smaller than the old 50px as asked,
  but deliberately 40px rather than 36px on touch, so the tap target doesn't
  get too small on the viewport where it matters most.
- Buttons became `rounded-full` (from `rounded-2xl`) to sit properly inside a
  pill.
- `items-end` on the pill, so the buttons stay anchored to the last line as the
  textarea grows rather than floating mid-height.
- Left padding is conditional: `pl-1.5` when the `+` button is present,
  `pl-4` when it isn't (guests, who don't get attachments) so the placeholder
  isn't flush against the border.
- `rounded-3xl` (24px) rather than `rounded-full`: at ~53px tall it still reads
  as a pill on one line, but it degrades gracefully when the textarea grows
  instead of bulging into an oval.

**Verified**

- `tsc --noEmit` and `eslint` clean.
- Measured at 390px and 1440px: both buttons confirmed inside the pill
  (`pill.contains(button)`), pill spans the column's full content width
  (358px / 848px), no horizontal page overflow.
- Multi-line growth: pill grows 54px → 188px on mobile and 53px → 75px on
  desktop, with the buttons staying 40/36px and anchored to the bottom.
- The attach menu still opens and both items render, now that the button that
  triggers it lives inside the pill.
- Hit-tested the `+` button's centre with `elementFromPoint` — resolves to the
  button, so nothing overlaps the control itself.

## 2026-07-30 — Responsive audit across device resolutions

Audited every route at seven real device widths (320, 360, 390, 414, 430, 768,
1024) with a script that measures the DOM rather than eyeballing screenshots:
horizontal page overflow, elements escaping the viewport, elements wider than
their own parent, touch targets under 44px, and text under 12px. Elements inside
a deliberate `overflow-x` scroller are excluded, since those are meant to
scroll.

**Baseline: 198 problems → 14, all 14 confirmed benign.**

**Real defects found and fixed**

- **`/login` scrolled sideways on 320px and 360px phones.** The OAuth buttons
  were `w-[320px]` fixed, and `main` had no `w-full` — with `items-center` on
  the parent, `main` sized itself to its widest child, so the document became
  368px on a 320px screen. Buttons are now `w-full` inside a
  `w-full max-w-[320px]` wrapper, and `main` is `w-full`. `scrollWidth` at
  320px went 344 → 320.
- **The docs sidebar was unusable on phones.** `w-1/5` meant 64px at 320px, and
  `px-6` left **16px of content** — every nav link wrapped to one character per
  line (measured: 24px links inside a 15px parent, on all five docs routes at
  every viewport). It's now a full-width strip under the header that scrolls
  sideways if needed, becoming the vertical column from `md` up, with
  `md:min-w-[196px]` so a fifth of a 768px tablet doesn't reproduce the same
  squeeze. `app/docs/layout.tsx` stacks with `flex-col md:flex-row`.
- **Code text rendered at 11.7px.** `code` used `text-[0.9em]`, which compounded
  against the `pre`'s 13px inside fenced blocks. Now an absolute `text-[13px]`,
  so inline and block code match wherever they appear — this affects every scan
  report, which is mostly code.
- **Mobile menu button was a 32px tap target.** Now `h-11 w-11` (44px). It's
  `md:hidden`, so it's touch-only and doesn't need to match the desktop
  toggle's 32px.
- **Mobile drawer covered 87% of a 320px screen** at a flat `w-[280px]`, leaving
  almost no backdrop to tap. Added `max-w-[85vw]`.

**Spacing rescaled by width** (landing page had no overflow — its `sm:`
breakpoints were already in place — but its spacing didn't scale down): hero
`gap-16`→`gap-10 sm:gap-16`, `py-20`→`py-14 sm:py-20`, body copy
`text-[19px]`→`text-[17px] sm:text-[19px]`, CTA row `mt-11 gap-6`→
`mt-9 gap-4 sm:mt-11 sm:gap-6`; the chat-preview section's `gap-16` likewise.
Docs `main` `py-16`→`py-10 md:py-16`.

**Verified**

- `tsc --noEmit` and `eslint` clean.
- Final pass, 7 viewports x 10 routes: **0 pages scroll horizontally, 0 elements
  escape the viewport, 0 text under 12px.** `scrollWidth === innerWidth` at
  320px on `/login`, `/docs/getting-started`, `/`, and an authenticated chat.

**The 14 remaining flags are both false positives, deliberately left**

- 7x the landing marquee reported as "wider than parent" (4159px in a 320-1024px
  box). It's an infinite ticker inside `overflow-hidden` — that's how it works,
  and it causes no page overflow (`pageOverflowsX` is false on landing at every
  width).
- 7x a console error on the 404 route: the page's own HTTP 404 response. My
  filter for it has a regex bug (`(Not Found)` parsed as a group), so it still
  shows up in output; the underlying behaviour is correct.

**Noted, not changed:** the composer's `+` and send buttons are 40x40 on mobile,
under the 44px guidance. That was a deliberate call in the previous entry —
44px would cost 8px of textarea width on a 320px screen. Flagging it as a known
trade-off rather than silently leaving it unmentioned.

## 2026-07-30 — Conversation row menu fixed on mobile

Reported as "problem with delete and rename buttons on mobile view of sidebar",
with a screenshot showing the menu's "Rename" label and a conversation title
drawn on top of each other. Three defects, one of them severe.

**1. The menu painted behind the rows below it.** The `⋮` button's wrapper uses
`-translate-y-1/2`, and a transform creates a stacking context — so the menu's
`z-20` only applied *inside* that context, which itself has `z-index: auto`.
Later positioned `<li>` siblings then won on DOM order and painted their titles
over the menu, which is exactly the overlap in the screenshot. Fixed by lifting
the whole row (`z-30`) while its menu or error popover is open, since that's what
escapes the trapped context.

**2. Rename and Delete were completely unreachable for the bottom rows.** The
recents list is `overflow-y-auto`, and `overflow-y: auto` makes `overflow-x`
compute to `auto` too, so the container clips absolutely positioned children.
Measured with 30 conversations at 390x844: the bottom row's menu rendered at
top 783 / bottom 873 against a scroller ending at 779 — entirely outside it,
`elementFromPoint` returning nothing belonging to the menu at either its middle
or its last item. The menu now opens upward when there isn't room below,
choosing direction from the button's position within its nearest scrolling
ancestor (found by computed `overflow-y`, not by class name). Re-measured: top
653 / bottom 743, inside the scroller, both items hittable.

**3. The `⋮` button was invisible and tiny on touch.** `opacity-0` with
`group-hover:opacity-100` never reveals on a device with no hover, so the menu
was undiscoverable; and at `h-6 w-6` it was a 24px target. Now always visible
below `md` (desktop keeps reveal-on-hover) and 32px on mobile, 24px from `md`
up, with the row's right padding widened to `pr-10 md:pr-7` to clear it. Menu
items went to `py-2.5 md:py-1.5` so each is ~40px tall to tap.

**Verified**

- `tsc --noEmit` and `eslint` clean.
- Mobile viewport (390x844, `hasTouch`, `isMobile`), 30 conversations: `⋮`
  computed `opacity: 1` with no hover, target 32x32; open menu is the topmost
  element at its own coordinates at three sampled points; menu background
  confirmed fully opaque; bottom row's menu not clipped and both items
  reachable.
- Rename and Delete driven with real taps and **verified against the database**
  over the REST API: the new title was present on the row, and the conversation
  count dropped by exactly one after confirming delete. Delete still requires
  the two-tap confirm.

**Note on two false alarms in my own testing:** an earlier version of the test
reported rename and delete as broken. Both were bad assertions, not bugs — the
delete check compared DOM row counts, but the sidebar caps at `MAX_RECENTS = 30`
and that user had 34 conversations, so deleting one simply backfilled the list
and the count never moved. The database check is the one that actually proves
the behaviour.

## 2026-08-02 — 401 given its own error path; key audit

Repo scans were failing in ~2.2s at both stages. The cause was outside the
code: the OpenRouter key in `.env.local` had been revoked, and every call —
scan *and* chat — came back `401 {"error":{"message":"User not found."}}`.

What made that take a full investigation is the part worth fixing. `401` was
the one status with no branch in `requestChatCompletion`, so it fell through
to "The scanner's model backend is unavailable right now." A revoked key fails
every model at once in a few hundred milliseconds, which is the same shape as
an upstream outage, so the message was actively pointing the wrong way.

- **401 now has its own branch** in both `requestChatCompletion` and
  `requestChatCompletionStream`, saying the key was rejected and that this
  needs a new `OPENROUTER_API_KEY` rather than a retry.
- **`OpenRouterRequestError` carries `detail`** — upstream's own text
  alongside the message we show. `"User not found."` was being logged and then
  dropped; both scan stages now record it as a field.
- **`budget.authFailed`** mirrors `creditsExhausted`: after one 401 the scan
  stops calling instead of firing ~38 more requests to collect 38 copies of
  the same error. Every file ends `inconclusive`, so `assessOutcome` reports
  `failed` and the report carries the "do not read this as a clean result"
  banner. `modelCalls` stays 0, so the route hands the usage unit back.
- **`deepScanFile`'s logging** matches triage's — explicit fields including
  `status`, rather than handing the Error to `console.error`, which prints the
  class and message and drops the status.

**A trap worth recording:** `GET /api/v1/models` returns **200 for any key**,
including a made-up one. Checking model ids against it and concluding the
credentials were fine is exactly the wrong turn this cost. `GET /api/v1/key`
is the endpoint that answers the question, and `AUTH_FAILURE_LOG` says so.

**Audited, no change needed**

- Only `lib/openrouter.ts:229` and `:305` read a key, both
  `process.env.OPENROUTER_API_KEY`. No second or differently-named variable.
  (`GEMINI_API_KEY` sits unused in `.env.local` — nothing reads it.)
- Both calls already send `Authorization`, `HTTP-Referer`, and
  `X-Title: "Netherite"`. They are the only two OpenRouter callers in the
  codebase, and `git log -S '"X-Title"'` shows the scan helper was born with
  the header in e88c094. No call is missing it; the activity log's "Unknown"
  entry did not come from here.

**Verified**

- `tsc --noEmit` clean.
- `lib/openrouter.ts` compiled standalone and driven against a deliberately
  invalid key: all three scan models and the chat stream return
  `status: 401`, `detail: "User not found."`, and the new message. Unsetting
  the variable still returns the 500 config error.
- All three configured model ids present in `GET /api/v1/models` (337 models).

**Next:** the replacement key is valid (`/api/v1/key` → 200) but the account
behind it holds almost no credit — triage 402s at `max_tokens: 500` ("can only
afford 175"), deep at 2000 ("can only afford 29"), and `is_free_tier: true`.
Scans stay blocked until that account is topped up. The 402 path already
reports this correctly, so no code change is pending on it.

## 2026-08-02 — Repo-scan failure traced to an empty OpenRouter balance

Re-investigated from scratch after the key replacement did not fix scanning.
This time end-to-end at runtime, not from a standalone script: a second
`next dev` on port 3100 with the outbound request and raw upstream response
logged from inside the server process, driven by a real authenticated POST to
`/api/repo-scan/run` (real Supabase session, real GitHub connection, real
clone). Instrumentation has been removed; the findings are below.

**Root cause: the OpenRouter account has no credit balance.** Not the key, not
the code.

```
GET /api/v1/credits → {"total_credits":0,"total_usage":0.19780678}

POST /chat/completions  model=google/gemini-2.5-flash  → 402 Payment Required
  "You requested up to 500 tokens, but can only afford 175.
   ...upgrade to a paid account"   limit_source: openrouter_credits
```

**Why "chat still works" was never evidence that scanning could.** The advisor
runs on `inclusionai/ling-3.0-flash:free`, priced by OpenRouter at
`prompt=$0, completion=$0`. Free models need no balance. Every scan model is
paid — `gemini-2.5-flash`, `claude-sonnet-4.6`, `claude-opus-5`. So a healthy
chat and a dead scanner are the expected result of a zero balance, and the
$0.20 of recorded usage is history, not headroom.

**Ruled out with runtime evidence, not by reading the code**

- Not a stale process or `.env` precedence. A temporary route reported the
  *running* server's `process.env`: `first8=sk-or-v1 last4=7e2a len=73`,
  identical to `.env.local`, in both the pre-existing dev server (pid 11796)
  and the diagnostic one. `.env.local` is the only env file.
- Not the request. Logged in full: correct URL, `Authorization`,
  `HTTP-Referer: https://www.netherite.uz`, `X-Title: Netherite`, and a
  well-formed body. Requests reach OpenRouter — Cloudflare `cf-ray` headers
  and a `user_id` in the error body come back.
- Not the model ids. All three present in `GET /api/v1/models`.

**Fixed: the report never named the cause.** A scan blocked on billing
produced a banner saying only that no verdict was produced for any file, with
"ran out of credits" buried in a collapsed list at the bottom — so the
reader's next move was to re-run the scan rather than to add credits.

- `ScanBlocker` (`"credits" | "auth" | null`) is derived from the budget and
  threaded into `assessOutcome`, which now puts the cause **first** in
  `outcome.notes`, ahead of its effects, and names the remedy.
- Triage's escalation reason names the cause too, so the per-file list agrees
  with the banner instead of a bare "Triage call failed".

**Verified** — `tsc --noEmit` and `eslint` clean, plus a real scan of
`with-asilbeck/node-authentication` (12 files, 7.4s) whose report now leads
with:

> The OpenRouter account ran out of credits (HTTP 402), so the model calls in
> this scan were rejected before any code was read. Add credits at
> openrouter.ai/settings/credits, then run the scan again.

**Next:** scanning stays blocked until credits are added — no code change can
substitute. Once topped up, re-run the same scan; a pass that reaches the
models will report `outcome.status: complete` instead of `failed`.

## 2026-08-02 — Off OpenRouter, onto direct vendor APIs

The OpenRouter account was deleted, so every model call moved to the vendor
APIs. `lib/openrouter.ts` is gone, replaced by `lib/llm/` — `models.ts` maps
stage → model → provider → price, `anthropic.ts` and `google.ts` are the two
clients, and `index.ts` dispatches on the model id. Nothing upstream knows
which vendor serves a stage, which is what lets `MODEL_TIERS` move one.

**Models now**

| Stage | Model | Provider |
|---|---|---|
| Chat advisor | `gemini-3.6-flash` | Google |
| Scan triage (`fast`) | `gemini-3.6-flash` | Google |
| Scan deep (`fast`) | `claude-sonnet-4-6` | Anthropic |
| Both stages (`best`) | `claude-opus-5` | Anthropic |

**Four things that would each have shipped a broken scanner**

- **`gemini-2.5-flash` is dead for new keys.** Google's `GET /v1beta/models`
  still lists it; `generateContent` answers `404 … no longer available to new
  users`. The same shape as the `gemini-2.0-flash-001` retirement, and the
  same lesson: a listing is not an entitlement. `gemini-3.6-flash` was picked
  by re-running the SQL-injection probe CLAUDE.md records — correct `yes`
  verdict in ~1s. `gemini-2.5-flash-lite` is still ruled out.
- **`thinkingBudget: 0` does not disable thinking on Gemini 3.x.** It is a
  hard 400 on `gemini-3.6-flash` and silently ignored on `gemini-3.5-flash`,
  where it left a 44-token verdict taking **28.9s**. At ~38 triage calls per
  scan that alone exceeds `SCAN_TIMEOUT_MS`. `thinkingLevel: MINIMAL` is the
  control that works — measured 28.9s → 1.0s, `thoughtsTokenCount: 0`.
- **Claude Opus 5 thinks by default** and `max_tokens` bounds thinking plus
  reply together, so the Max tier's 500-token triage budget would have been
  spent reasoning. Disabled explicitly, with the no-internal-XML-tags line
  that is the documented mitigation for tag leakage when thinking is off.
- **`temperature: 0` is a 400 on Opus 5.** Sampling parameters are removed on
  that model. Dropped for Anthropic; kept for Google, which still takes it and
  where triage genuinely wants determinism.

**Cost changed shape.** OpenRouter reported what it charged; the vendors
return token counts only, so `MODEL_PRICING` prices them and `usage_events`
gets a derived number. An unpriced model records **null**, never zero.

**Error mapping.** 401/402/404/429 still mean what they meant, so the
`creditsExhausted` / `authFailed` short-circuits and the report banner are
untouched — but 402 is now synthesised: Anthropic reports billing failure as a
400 naming the credit balance, Google as a 429, and `lib/llm/errors.ts`
translates both. Chat also gained a 404 branch, added after a live 404 on a
retired model id read to the user as "temporarily unavailable" — advice to
wait, for a fault waiting cannot fix.

**Verified**

- `tsc --noEmit` and `eslint` clean.
- `lib/llm` compiled and run against the live APIs: triage returned a correct
  JSON verdict in 1437ms with `{"tokensUsed":139,"costUsd":0.0004785}`; the
  chat stream assembled 223 chars of deltas with usage and cost attached;
  `providerFor` threw on an unregistered id as intended.
- **Not verified: the Anthropic path.** There is no `ANTHROPIC_API_KEY` in
  `.env.local`, so both Claude stages returned the 500 config error and were
  never exercised against the live API.

**Next**

1. Add `ANTHROPIC_API_KEY` to `.env.local` and Vercel; drop
   `OPENROUTER_API_KEY`, which nothing reads. Then re-run a real scan — the
   deep pass has not yet made a live call.
2. Reconsider the triage model on cost. `gemini-3.6-flash` is $1.50/$7.50 per
   MTok — five times the input price of the retired `gemini-2.5-flash`, and
   **dearer than `claude-haiku-4-5` at $1/$5**. Switching is one row in
   `MODEL_PRICING` plus one id in `models.ts`, but re-run the SQL-injection
   probe first.
3. Image attachments in the composer are now unblocked — the advisor model
   accepts image input, which is what the old one could not do.

## 2026-08-02 — Deep scan moved to Gemini as a stopgap (TEMPORARY)

The deep-review stage was failing with `missing ANTHROPIC_API_KEY` — the
"Not verified: the Anthropic path" item from the entry above, reached by a
real scan. There is still no Anthropic key, so **Tier 2 now runs on Gemini**
until there is one. This entry is written to be read by whoever reverts it.

**Everything here is temporary. Grep `anthropic-swap-back`** — six sites
across `lib/llm/models.ts`, `lib/llm/index.ts` and `lib/repo-scan/deep-scan.ts`.

| Stage | Was | Is now |
|---|---|---|
| Scan deep (`fast`) | `claude-sonnet-4-6` | `gemini-3.6-flash` |
| Both stages (`best`) | `claude-opus-5` | `gemini-3.6-flash` |
| Scan triage (`fast`) | `gemini-3.6-flash` | unchanged |
| Chat advisor | `gemini-3.6-flash` | unchanged |

The prompts did not change. `DEEP_SYSTEM_PROMPT`, the security-code-review
vulnerability classes, the vuln-report-format output contract and the
per-tier fragments are byte-identical — only the backend moved, which is
what `lib/llm`'s stage → model → provider indirection exists for.

**The requested models are not merely unavailable, they are closed.** The ask
was `gemini-2.5-pro`, falling back to `gemini-2.5-flash`. Checked with real
`generateContent` calls, per the rule in CLAUDE.md:

```
gemini-2.5-pro         → 429  quotaValue: 0   (…RequestsPerMinutePerProjectPerModel-FreeTier)
gemini-pro-latest      → 429  quotaValue: 0
gemini-3-pro-preview   → 429  quotaValue: 0
gemini-3.1-pro-preview → 429  quotaValue: 0
gemini-2.5-flash       → 404  no longer available to new users
```

A `limit: 0` is an entitlement answer, not congestion — no backoff reaches
these, and a 429 that looks like a rate limit is the misleading part. The
free tier grants Pro models nothing at all. That leaves the Flash line, of
which `3.6` is the newest callable member.

**So the step-up between the stages is reasoning depth, not model class.**
Triage and deep review now share one model id, which would have made the two
passes identical. Instead triage keeps `thinkingLevel: MINIMAL` and deep
review asks for `HIGH`, threaded through as a new provider-neutral
`ReasoningEffort` (`lib/llm/types.ts`) that only the Google client acts on —
Anthropic decides thinking per model id in `anthropic.ts`, and nothing calls
it today. This is a genuine difference in what the model does and a **smaller
one than Flash → Sonnet was. Treat deep-review quality as degraded until this
is reverted.**

**`best` is currently a tier in name only.** Both its slots resolve to the
same id the free tier triages with, so Max buyers get `fast`'s models plus
their non-model entitlements (exploit chains, structured report, priority
queue). The order-of-magnitude cost premium that made a Max scan expensive
was Opus on the ~38-call triage pass; it is suspended along with the model,
and returns the moment that line does.

**A cost bug this introduced, and the fix — keep it on the way back.** Gemini
reports thinking tokens in `usageMetadata.thoughtsTokenCount`, *outside*
`candidatesTokenCount`; the SDK documents `totalTokenCount` as the sum of the
two. `usageOf` counted candidates only, which was correct for as long as
every call sent `MINIMAL` and came back with `thoughtsTokenCount: 0`, and
became an understatement the moment the deep stage asked for `HIGH`.
Measured on one call: 6 candidate tokens against 584 thought tokens. This is
the failure mode `MODEL_PRICING` exists to prevent — spend quietly reported
low — so `usageOf` now folds thoughts into the output count.

`MAX_FILE_CHARS_FOR_DEEP` needed a companion for the same reason: thinking is
billed against `maxOutputTokens`, so `THINKING_HEADROOM` (2000) is added to
the deep budget. Without it, `high` reasoning spends the report's own ceiling
on thinking and returns a truncated report — the same trap CLAUDE.md records
for Opus 5's triage budget.

**Verified** — `tsc --noEmit` and `eslint` clean, plus a real end-to-end scan
of `with-asilbeck/jizzakh-qidiruvdagilar` driven through the app's own
`scanRepository()`:

```
tier=free  models={"triage":"gemini-3.6-flash","deep":"gemini-3.6-flash"}
11 files collected, 17 excluded → 11 triaged → 2 flagged → 2 deep-reviewed
outcome=complete  modelCalls=5  tokensUsed=6894  costUsd=0.011979  53.3s
```

Both previously-failing files — `src/firebaseConfig.js` and
`src/components/Section/Section.jsx` — now complete deep review instead of
erroring on the missing key. The token/cost fix was confirmed separately:
`tokensUsed=267` against Google's own `total=267`, where the old arithmetic
would have reported 52; at `minimal` it is unchanged, so triage and chat
accounting is untouched.

**The scan found nothing, and that is the part worth arguing about.** Both
flagged files came back `NO_ISSUES_FOUND`, including the Firebase config
holding an `AIzaSy…` key. That was checked for a sentinel bug — three raw
runs printed before `deepScanFile`'s `NO_ISSUES_FOUND` check, all three the
model's literal output — so it is a real verdict, not swallowed text.

It is also defensible: a Firebase Web API key is a public client identifier,
shipped in every client bundle by design, and access control lives in
Firestore rules rather than in the key. "Hardcoded secret" is arguably the
wrong class for it. Less comfortable is the same scan clearing
`Section.jsx`, which reads a `wanted` collection unauthenticated — whether
that is exposure depends on rules this static pass cannot see. **No prompt
was tuned to force a finding.** Whether a stronger reviewer would have
written the nuanced version of this cannot be answered without an Anthropic
key to compare against.

**New blocker, replacing OpenRouter credits.** `gemini-3.6-flash` on this key
allows **20 requests per day** (`quotaValue: 20`,
`GenerateRequestsPerDayPerProjectPerModel-FreeTier`). One 11-file scan is ~5
calls, so roughly **four scans a day** before everything 402s — hit partway
through this session's testing, which is why one Max-tier run shows a file
failing on quota. Error mapping handled it correctly: Google's 429-with-quota
was synthesised to 402 and the report named billing as the cause.

**Next**

1. Add `ANTHROPIC_API_KEY`, then revert via `anthropic-swap-back`: two model
   ids, the `reasoning: "high"` argument, and `THINKING_HEADROOM`. The Claude
   rows were deliberately left in `MODEL_PROVIDERS` and `MODEL_PRICING` so
   the revert cannot fail on a missing provider or a null cost. **Keep the
   `usageOf` thinking-token fix** — it is not part of the stopgap.
2. Re-run this same scan afterwards and compare the two reports on
   `firebaseConfig.js` directly. That comparison is the only way to separate
   "correct verdict" from "weaker reviewer", and it is worth recording.
3. A paid Gemini tier would lift both the 20/day cap and the Pro `limit: 0`,
   if the deep stage is ever meant to stay on Gemini rather than move back.

---

## 2026-08-03 — Cookie Policy page at `/cookie`

`app/cookie/page.tsx`, a static server component. There is no `/privacy` or
`/terms` route to mirror, so the structure is taken from `app/pricing/page.tsx`
— the closest existing static page with its own header and footer — minus the
Supabase call, since nothing on this page depends on a session. Header uses the
docs layout's "Back home" link rather than pricing's Account/Log in, which keeps
the page fully static.

Prose is hand-authored JSX, not `react-markdown`: the policy is fixed text, and
routing it through `MessageContent` would inherit chat bubble typography. Body
copy sits in `text-muted-foreground` with headings in `foreground`, matching the
lead-paragraph treatment on `/docs` and `/pricing`. Sections are numbered
`01`–`08` and separated by `border-t border-border`, following the same
border-led rhythm used elsewhere.

The cookie-category comparison is a real `<table>`, styled from the one in
`app/usage/page.tsx`: wrapped in `overflow-x-auto rounded-xl border`, with
`min-w-[720px]` so four columns of prose scroll inside their own container
instead of pushing the page sideways on a phone. Category names are `<th
scope="row">`, so the table is navigable rather than just visually gridded.

**Theming needed no new code.** Every color is a semantic token, so the page
follows next-themes through the root provider like the rest of the site. No
toggle was added — the only theme toggle in the app lives in the chat sidebar,
and `/pricing`, `/docs`, and `/404` all inherit silently the same way.

Footer discoverability: the landing page's Legal column was a bare string array
mapped to `href="#"`. It is now `legalLinks`, using the `href: string | null`
convention already established by `navLinks` in the same file, rendering `Link`
for real routes and the `#` placeholder otherwise. Privacy Policy, Terms &
Conditions, and Security stay `null` — those pages still don't exist.

**Two placeholders are deliberate and must be filled before this counts as
published legal text.** `EFFECTIVE_DATE` and `CONTACT_EMAIL` are named
constants at the top of the file. No support address exists anywhere in the
repo — `.env.local` defines only `NEXT_PUBLIC_SITE_URL` — so none was invented.
The effective date was left as a placeholder carrying the drafted date rather
than committed, since the page shouldn't claim an effective date before it goes
live.

Verified with `tsc --noEmit` and `eslint` clean, and a dev render: `/cookie`
returns 200 with the correct `<title>`/meta description, one `<table>` with a
header row plus four category rows, all four browser-settings links intact, and
`/` returns 200 with `href="/cookie"` present in the footer.

**Next**

1. Fill `EFFECTIVE_DATE` and `CONTACT_EMAIL`. If a support address is going to
   be referenced by more than this page, put it in a shared constant rather
   than inlining it here.
2. `/privacy`, `/terms`, and `/security` are still `href="#"`. When they get
   built, `app/cookie/page.tsx` is the template — the `Section`, `Bullets`, and
   `ExternalLink` helpers are local to it and worth lifting into
   `components/` at the second legal page, not before.

---

## 2026-08-03 — Landing page rebuilt from the Claude Design import

`app/page.tsx` is now the dark "Break in before they do." composition from the
Claude Design project (`Netherite.dc.html`), replacing the cream/marquee page.
Nav → hero → capabilities → live detection → pricing → CTA → footer, on
`#08090c` with an emerald accent, Space Grotesk for display and JetBrains Mono
for the labels and the feed.

**It is dark on both themes, deliberately.** Every color on this page is a
literal, and the landing palette (`--color-nether-*`) is registered in
`@theme inline` *separately* from the semantic tokens, which are the ones that
swap under `.dark`. A reader on the light theme sees the same page. Because the
landing tokens are literals rather than the two-level `var()` indirection the
semantic set uses, alpha modifiers work here — `bg-nether-void/55` compiles to a
real alpha, unlike `bg-accent/50` (see the warning above `--border-strong`).

**Fonts are page-scoped.** `spaceGrotesk` and `jetbrainsMono` join `inter` in
`lib/fonts.ts` and are applied on the landing wrapper, not in the root layout,
so the rest of the app stays on Geist and only this route downloads them. The
design's `<link>` to `fonts.googleapis.com` is not carried over — `next/font`
self-hosts, which is also what keeps the CSP-free page free of a third-party
request.

**Three client islands, everything else server-rendered:**

- `components/landing/particle-field.tsx` — the drifting node graph. Capped at
  `devicePixelRatio` 2, one particle per 22,000 px² of viewport, and it draws a
  single static frame with no rAF loop when `prefers-reduced-motion` is set.
- `components/landing/live-feed.tsx` — the simulated findings ticker. Seeded
  from the front of the pool so the first paint matches SSR (a random pick would
  be a hydration mismatch), then **cycled**, not re-randomised — the pool is
  larger than the six-line window, so the visible lines are always six different
  findings. The design's invented `CVE-2026-1183` was replaced with a real,
  checkable claim about `lodash@4.17.11`.
- `components/landing/reveal.tsx` — scroll reveal. The hidden state is the
  `.nether-reveal` class, not React state, so the observer toggles one class
  instead of re-rendering the section, reduced motion is a media query, and a
  browser with no `IntersectionObserver` reveals on mount. Content is never left
  stranded at `opacity: 0`.

**Pricing is rendered from the real catalogue, not from the mockup's copy.**
The design shipped Solo/Team/Max/Enterprise at Free/$49/$129/Custom, none of
which exist. The four cards are now Free plus `PLANS`, with prices from
`formatPrice(plan.price.monthly)` — the same display strings
`billing-verify-variants.mjs` checks against the live Lemon Squeezy variants —
and bullets derived from `TIER_LIMITS` and `FEATURE_LABELS`, so the page cannot
advertise a cap or a capability the API withholds. The "18,400+ exploit
patterns / <45ms per file" stat pair was likewise replaced with Max's real
monthly scan and snippet caps. Paid CTAs route to `/pricing`, where the real
checkout table lives; Free goes through `ChatEntryLink` like every other entry
point.

**Nav and footer keep the real routes.** The mockup's nav had no login link;
it is back, next to Product/Pricing/Docs. Footer columns map to `/about`,
`/docs`, `/docs/getting-started`, `/policy`, `/cookie` — no `href="#"`
placeholders were introduced.

**The hero's cursor-following glow was cut.** The mockup put a 700px radial
gradient behind the hero that tracked the pointer; inside a `max-w-[1200px]`
section it clipped to a hard-edged rectangle on wide viewports, which read as a
rendering bug rather than an effect. The hero is a plain `<section>` again and
`components/landing/spotlight.tsx` is gone. The canvas still draws its faint
lines toward the cursor — that is the particle field, not the glow.

The mark is the existing `public/netherite-mark.png` under a plain `invert`
(it is dark artwork on transparent, the same reason the old page used
`dark:invert`); no new asset was imported.

`.marquee-track` also picked up the reduced-motion guard it was missing, noted
earlier in this file.

Verified: `tsc --noEmit` and `eslint` clean on the changed files, `next build`
green, and a dev render driven through CDP at 390 / 1024 / 1440 px —
`scrollWidth === clientWidth` at every width (no horizontal overflow), grids
collapsing 3→2→1, and the generated CSS carrying the new utilities with their
alpha intact.

**Next**

1. `components/scroll-link.tsx` and the `.marquee-track` keyframes are now
   unreferenced — the old landing page was their only consumer. Delete them at
   the next cleanup unless something else is about to want them.
2. The page is dark while `body` still paints the themed background behind it;
   only overscroll shows it. If that ever reads as a flash, the fix is a
   route-scoped background, not a global one.
3. The feed, the capability copy, and the "all systems nominal" line are
   marketing text with nothing behind them. If a real status endpoint ever
   exists, that footer line should read from it or lose the dot.

---

## 2026-08-04 — Landing page follows the theme

The landing page was a fixed dark composition; it now has a light theme and
follows next-themes like every other page. No toggle was added — `/pricing`,
`/docs`, and `/404` all inherit silently too, and the only toggle in the app
still lives in the chat sidebar.

**Light is the same page on paper, not an inverted one.** The background is the
app's warm cream (`almond_cream-800`), the same value `--background` uses, so
moving between `/` and `/pricing` isn't a temperature jump and the overscroll
area matches. Text steps down through the stone_brown scale instead of the cool
260-hue one. The emerald deepens from `oklch(0.78 0.16 165)` to
`oklch(0.52 0.12 165)`: the dark theme's accent is a *light* green, and light
green text on cream is around 1.8:1.

**Two things could not be a straight swap.** A filled emerald button keeps a
deep fill in both themes, so its label can't be the page background — it is now
`--nether-on-glow`, dark on the dark theme and near-white on the light one,
where `text-nether-void` used to work by coincidence. And the raised surfaces
were `white/[0.025]`-style overlays, which are invisible on cream; on the light
theme the cards go *lighter* than the page (near-white on cream) rather than
adding white to a void.

**Every translucent step is now a named token, not a `/NN` modifier.** There
are ~28 of them (`--nether-line-faint` … `--nether-glow-edge-strong`), each
carrying its own alpha, and the reason is mechanical: the values have to move
into `:root` / `.dark` blocks to swap with the theme, and an alpha modifier
can't survive that var indirection — the same limitation already documented
above `--border-strong`. Baking the alpha in also lets the light theme change
an overlay's *color*, which is what the surface inversion above needs. The
`@theme inline` block registers each as a Tailwind color, so the markup reads
`bg-nether-surface` / `border-nether-line` instead of `bg-white/[0.025]`.

**The canvas reads the palette instead of hardcoding it.** `--nether-particle-rgb`
and `--nether-link-rgb` are channel triplets rather than colors, because every
line is stroked at its own distance-based alpha (`rgb(${triplet} / ${a})`). A
`MutationObserver` on `<html class>` re-reads them when the theme flips, so the
field repaints in place — verified by flipping the class with no reload and
confirming both the repaint and that `getComputedStyle` on the canvas returns
the dark triplet. The static reduced-motion frame is redrawn explicitly on that
event, since it has no loop to pick the change up on.

**The mark.** `invert` became `dark:invert` — it is dark artwork on
transparent, so it stands on its own over cream and inverts to white over the
void. Same file, both themes, no second asset.

Also: `--nether-glow-tile` exists as its own step because the 38px square
capability icon sits next to solid-filled shapes, and the 24% badge wash it
shared reads as washed out against them on white.

Verified: `eslint` and `tsc --noEmit` clean, `next build` green, and CDP renders
at 1440px under both `prefers-color-scheme` values plus a live class flip —
dark is pixel-unchanged from before this entry, and neither theme has
horizontal overflow.

**Theme switcher in the navbar** (`components/landing/theme-switcher.tsx`).
Three inline segments — Light / Dark / System — not a two-state flip, because
`system` is the app's default and a binary toggle is a one-way door out of it:
once you pick a side there would be no way back to "follow the OS". Same three
options the chat sidebar's profile menu offers, and it writes through the same
next-themes store, so a choice made on the marketing page is the choice the app
opens with. `role="radiogroup"` with three `role="radio"` buttons, matching the
billing-period control in `components/pricing-table.tsx`.

The selected theme is only knowable in the browser, so the segments render
unselected until hydration. That reads through `useSyncExternalStore(subscribe,
() => true, () => false)` rather than the usual `setMounted(true)` in an effect
— `react-hooks/set-state-in-effect` rejects the latter, and this is a value
that never changes again after the first client render.

Hidden below `sm`, where the row is already just wordmark + CTA. Nothing is
lost there: with no stored choice the page follows the device setting.

Verified by driving it over CDP: a fresh load with `prefers-color-scheme:
light` and nothing in localStorage selects System and renders light; clicking
Dark puts `dark` on `<html>`, writes `theme=dark`, and the canvas re-reads the
dark triplet without a reload; clicking System clears back to the OS setting.

---

## 2026-08-04 — New tier limits, and a second message ceiling

`lib/tiers.ts` is the only place the numbers changed; everything that renders
or enforces them reads from there, so the landing page, `/pricing`, the usage
dashboard, and the API all moved together.

| tier  | repo scans / mo | snippets / mo | messages          |
| ----- | --------------- | ------------- | ----------------- |
| free  | 2 (unchanged)   | 10 (unchanged)| 200 / day, shown  |
| basic | 25 → **15**     | 150 → **100** | 1000/day → **100/day + 700/month** |
| pro   | 150 → **50**    | 750 → **200** | 2000 / day        |
| max   | 500 → **200**   | 3000 → **500**| 5000 / day        |

Pro's "structured reports and attack-chain explanation" and Max's "everything
in Pro plus the strongest model on every scan stage" needed no change —
`vulnerability_report`, `deep_exploit_analysis` and `model_tier: "best"`
already say exactly that, and the pricing surfaces already render those labels.
`priority_queue` was left on for pro/max: it wasn't in the new spec, but it
wasn't struck from it either, and it is a capability those plans have today.

**The monthly message ceiling is new machinery, not a new number.**
`messages_monthly_soft_cap` is the first cap that doesn't match its action's
declared window — `chat` is enforced per day, and this one is per month.

It is deliberately *not* enforced in `reserve_usage`. That function reserves
against exactly one window, and calling it twice would insert two rows and
double-count every message. So the monthly ceiling is a **read** in
`reserveUsage` before the reservation: two simultaneous requests can both pass
it, which is why the field says *soft*. Being a few messages over an invisible
fair-use ceiling costs nothing; a second write path through the ledger, or a
migration to a two-window reserve, would cost more than it protects. The daily
cap is untouched and still atomic under the advisory lock.

Both ceilings stay invisible — `messagesCapIsVisible` governs the pair, so a
basic user who reaches either gets the same 429 and the same say-nothing copy.
The only difference is `Retry-After`, which points at the month rather than
tonight's midnight; `secondsUntilReset(window)` was split out of
`secondsUntilWindowReset(action)` for that, since the action's own window is
the wrong answer here.

**Verification.** `node scripts/tier-config-test.mjs` — 148/148, with the SPEC
table retranscribed to the new numbers and a new section 3b asserting the
monthly ceiling is invisible, that it can bind before 31 days of daily ones
(700 < 100 x 31 — a monthly cap above that could never fire), and that the
refusal copy names neither number.

`node scripts/tier-enforcement-test.mjs` — a new end-to-end section 3b puts one
user on basic, confirms they are served, backdates 700 chat rows to the 1st of
the month so today's count stays at one, and asserts the next request is 429
with no number and a Retry-After measured in days rather than hours. That last
assertion is what proves the *monthly* ceiling fired rather than the daily one.

Two repairs the suites needed before any of that could run:

- `scripts/ts-alias-hook.mjs` resolved `@/lib/llm` to the *directory* (its
  `existsSync` was true for it) and handed Node a directory to read as source —
  EISDIR, before a single assertion. It now checks for a file, so the
  `/index.ts` candidate it already had can be reached.
- `tier-config-test.mjs` still imported `../lib/openrouter.ts`, deleted when
  the clients moved to `lib/llm`. Pointed at `lib/llm/models.ts`.

**Pre-existing failures the enforcement suite still reports (12), none of them
tier-limit related:**

1. Eleven repo-scan assertions expect 402 and get **403 "Connect your GitHub
   account to scan repositories."** The ownership gate in
   `app/api/repo-scan/run/route.ts` runs *before* `reserveUsage` — deliberately,
   so a refused scan costs no quota — and the suite's throwaway users have no
   GitHub connection, so those requests never reach the cap. The suite predates
   that gate. Fixing it means seeding a `github_connections` row and stubbing
   the GitHub call, which is its own change.
2. One chat assertion expects 200 and gets **401**, and it is the only
   assertion in the file that needs a *successful* model call. The advisor is
   down in this environment: `GEMINI_API_KEY` in `.env.local` is rejected by
   Google with `401 UNAUTHENTICATED` on a direct one-token call, and
   `app/api/chat/route.ts:278` forwards the upstream status verbatim. Nothing to
   do with tiers; see below.

**Next**

1. **The advisor is returning 401 right now.** The Gemini key is invalid, not
   rate-limited (`ACCESS_TOKEN_TYPE_UNSUPPORTED`, not a 429). Every chat request
   that gets past the caps fails. Rotate the key.
2. **"Unlimited advisor messages" is now a weaker claim than it was.** At
   1000/day the fair-use ceiling was unreachable by a human; 700/month is about
   23/day, which an engaged user can hit in a busy week — and what they get is
   a deliberately vague "try again later" that reads as a bug, because the copy
   was written for a ceiling nobody would meet. Either raise the monthly number
   or make it visible and advertised, in which case
   `messagesCapIsVisible("basic")` and the copy path change with it.
3. `components/pricing-table.tsx` renders "Unlimited advisor messages" twice on
   Basic — once from the cap row, once from `PLANS.basic.features`, which the
   plans file's own comment says is for selling points *beyond* the caps.
   Pre-existing, now more visible next to the shorter cap list. Removing the
   string from `PLANS` is the fix, but it also drops the line from the landing
   card, which has no cap row for chat — worth deciding deliberately rather
   than in passing.

---

## 2026-08-04 — Free's message cap cut, Pro and Max repriced

Free: **200 → 50 advisor messages a day**. It is free's one advertised cap, so
unlike the paid ceilings it is rendered and named in the refusal — the copy
path picks the new number up on its own (`upgradeMessage` formats whatever
`limitFor` returns). The config suite's assertion on that copy now reads the
cap from SPEC instead of restating `200`, so the next change to it can't leave
the test checking a number nothing enforces.

Prices, monthly and yearly, in `lib/billing/plans.ts`:

| plan  | monthly       | yearly           | yearly discount |
| ----- | ------------- | ---------------- | --------------- |
| Basic | $9.99 (same)  | $99.00 (same)    | 17%             |
| Pro   | $20 → **$35** | $219 → **$350**  | 16.7%           |
| Max   | $100 → **$129** | $1,079 → **$1,290** | 16.7%      |

Only the monthly figures were specified; yearly was set to ten months of the
new monthly price, which lands both paid tiers within a rounding point of
Basic's existing 17% rather than leaving them at the 48% and 30% implied
discounts that keeping the old yearly prices would have created.

**These are display values. Nothing has been charged differently.**
`node scripts/billing-verify-variants.mjs` now fails four assertions, which is
the file doing its job — the live variants still charge the old amounts:

| variant | env var | charges | should charge |
| ------- | ------- | ------- | ------------- |
| 1969700 | `LEMONSQUEEZY_VARIANT_PRO_MONTHLY` | $20 | $35 |
| 1969703 | `LEMONSQUEEZY_VARIANT_PRO_YEARLY`  | $219 | $350 |
| 1969701 | `LEMONSQUEEZY_VARIANT_MAX_MONTHLY` | $100 | $129 |
| 1969705 | `LEMONSQUEEZY_VARIANT_MAX_YEARLY`  | $1,079 | $1,290 |

Until those are edited in the Lemon Squeezy dashboard, the pricing page quotes
$35 and the checkout takes $20. Basic's two variants still match and were left
alone.

**The yearly-savings badge was quietly lying, and this made it worse.** One
badge sits above three plans with different discounts and it quoted
`PLANS[0]` — Basic's. With the old numbers that advertised 17% over a Pro plan
that saved 8.75%. It now quotes the smallest of the three, which is what
`yearlySavingPercent`'s round-down was already trying to guarantee. Reads
"save 16%" today.

Verified: `tier-config-test.mjs` 148/148, `tsc --noEmit` and `eslint` clean, and
a dev render showing 50/day on Free, $35 on Pro, $129 on Max, and the corrected
badge.

**Next**

1. Update the four Lemon Squeezy variants above, then re-run
   `npm run verify:billing:variants` until it is green. Existing subscribers
   keep the price they signed up at — Lemon Squeezy does not reprice live
   subscriptions when a variant changes, which is worth being deliberate about
   rather than discovering later.
2. Free at 50 messages a day is a third of what it was. That cap *is* visible,
   so the 402 will name it and point at Basic — worth watching whether it reads
   as a trial or as a wall.

---

## 2026-08-04 — Basic's repo scans: 15 → 10

Supersedes the Basic row in the limits table two entries above. One number in
`lib/tiers.ts` and its transcription in `scripts/tier-config-test.mjs`; every
surface reads through, so `/` and `/pricing` both say 10 without further edits.
The ladder stays ascending — free 2, basic 10, pro 50, max 200.

Nothing else moved: Basic keeps 100 snippet analyses a month and the 100/day +
700/month message ceilings, and its two Lemon Squeezy variants are still the
ones that match `plans.ts`.

Verified: `tier-config-test.mjs` 148/148, `tsc --noEmit` clean, and both pages
rendering 10 against the dev server.
