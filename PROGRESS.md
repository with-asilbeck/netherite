# Progress

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
