# Progress

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
