import { ipAddress } from "@vercel/functions";

import { getUserEntitlement } from "@/lib/get-user-tier";
import {
  CONSENT_CHECKBOX_LABEL,
  consentClauses,
  PRIVATE_SCAN_CONSENT_VERSION,
} from "@/lib/private-scan/consent";
import { getConsent, revokeConsent, saveConsent } from "@/lib/private-scan/store";
import { checkConsentRateLimit } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { createClient } from "@/lib/supabase/server";

// Consent for private repository scanning.
//
// GET  — what the screen should say, and whether this user has already agreed
//        to *this version* of it.
// POST — records agreement. Requires an explicit `accepted: true` and the
//        version the client was actually shown.
// DELETE — withdraws it.
//
// Two properties worth stating outright:
//
//   1. **This route cannot grant anything by itself.** Consent is one of four
//      conditions in lib/private-scan/authorize.ts, and the scan route calls
//      that, not this. Posting here does not make a user eligible to scan; it
//      only records that they were told where their code goes.
//
//   2. **The version is checked, not trusted.** A client that posts a version
//      other than the one this server is serving is refused rather than
//      recorded — otherwise a stale tab could record agreement to terms the
//      user never saw, which is the one thing a consent record must never do.

export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 2 * 1024;

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Please log in." }, { status: 401 });
  }

  // Free users are not shown the terms at all: there is nothing they could do
  // with them. The account page hides the whole panel on the same flag.
  const entitlement = await getUserEntitlement(user.id);
  if (!entitlement.privateRepoScanning) {
    return Response.json(
      {
        error:
          "Scanning private repositories is available on paid plans. Upgrade to scan code that isn't public.",
        action: "upgrade",
      },
      { status: 402 },
    );
  }

  const consent = await getConsent(user.id);
  const current = consent !== null && consent.consentVersion >= PRIVATE_SCAN_CONSENT_VERSION;

  return Response.json(
    {
      version: PRIVATE_SCAN_CONSENT_VERSION,
      clauses: consentClauses(),
      checkboxLabel: CONSENT_CHECKBOX_LABEL,
      granted: current,
      // Non-null but out of date reads as "you agreed to an older version",
      // which the screen says explicitly rather than silently re-asking.
      grantedAt: consent?.consentGivenAt ?? null,
      grantedVersion: consent?.consentVersion ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "Request is too large." }, { status: 413 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Please log in." }, { status: 401 });
  }

  // CSRF. Supabase's SSR cookies are SameSite=Lax, which already stops a
  // cross-site POST from carrying the session — this is the explicit second
  // lock, matching /api/checkout.
  //
  // It matters more here than anywhere else in the app. A consent row written
  // by a forged cross-site request is worse than no row at all: it is a
  // durable record asserting that a human read the data-handling terms and
  // agreed, and it is the gate that stands between a forged request and
  // somebody's private source code being sent to two model vendors. A form
  // POST with `enctype="text/plain"` is a simple request — no preflight — and
  // `request.json()` parses its body perfectly well, so this is not
  // theoretical.
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const entitlement = await getUserEntitlement(user.id);
  if (!entitlement.privateRepoScanning) {
    return Response.json(
      {
        error:
          "Scanning private repositories is available on paid plans. Upgrade to scan code that isn't public.",
        action: "upgrade",
      },
      { status: 402 },
    );
  }

  // Keyed by the verified session user id. A consent record is a legal-ish
  // artifact and this endpoint writes one per call; there is no reason for a
  // single account to produce dozens a minute.
  const rateLimit = checkConsentRateLimit(user.id);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Too many attempts. Please wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  let body: { accepted?: unknown; version?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Explicit, and explicitly `true` — not merely truthy. A consent record
  // built from `"false"` or `1` is not a record of anybody agreeing.
  if (body.accepted !== true) {
    return Response.json(
      { error: "Tick the box to confirm you understand where your code is sent." },
      { status: 400 },
    );
  }

  if (body.version !== PRIVATE_SCAN_CONSENT_VERSION) {
    return Response.json(
      {
        error:
          "These terms have been updated since this page was loaded. Reload and read the current version before accepting.",
      },
      { status: 409 },
    );
  }

  const saved = await saveConsent(user.id, {
    userAgent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
    // Vercel's own proxy computes x-real-ip; this helper deliberately ignores
    // the spoofable x-forwarded-for. Same reasoning as lib/rate-limit.ts.
    ipAddress: ipAddress(request) ?? null,
  });

  if (!saved) {
    return Response.json(
      { error: "Couldn't record your consent. Please try again." },
      { status: 503 },
    );
  }

  return Response.json({ granted: true, version: PRIVATE_SCAN_CONSENT_VERSION });
}

export async function DELETE(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Please log in." }, { status: 401 });
  }

  // Withdrawal is the safe direction, so a forged one is a nuisance rather
  // than a breach — but an endpoint that can be driven cross-site is still an
  // endpoint that can be driven cross-site, and the check is one line.
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

  // Own row only — the id is the session's, never the request's.
  await revokeConsent(user.id);
  return Response.json({ granted: false });
}
