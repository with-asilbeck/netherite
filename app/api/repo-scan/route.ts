import { createClient } from "@/lib/supabase/server";
import { checkRepoScanRateLimit } from "@/lib/rate-limit";
import { MAX_REPO_URL_LENGTH, parseGitHubRepoUrl } from "@/lib/github-repo";
import { oversizeRefusal, verifyRepoAccess } from "@/lib/github/access";

// Repo attach endpoint. Validates and normalizes a pasted repo URL, then
// asks GitHub whether this user may scan it — so the composer can refuse to
// build an attachment chip for a repo the scanner would reject anyway.
//
// The one outbound request it makes is to api.github.com, on a path built
// from segments parseGitHubRepoUrl has already validated against a strict
// allow-list. The pasted URL itself is never fetched, resolved, or cloned
// here: it is attacker-controlled, and anything that dereferenced it would
// be an SSRF sink. Cloning happens only in POST /api/repo-scan/run, behind
// its own DNS re-resolution check (lib/repo-scan/ssrf.ts).
//
// The client attaches the repo chip on a 200 from this route; the scan runs
// at send time against /api/repo-scan/run, which re-verifies access rather
// than trusting that this route ran.

const MAX_REQUEST_BYTES = 4 * 1024;

export async function POST(request: Request) {
  // The body here is tiny by definition; reject anything oversized on its
  // declared length before request.json() buffers it into memory.
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "Request is too large." }, { status: 413 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Attachments are an authenticated-only feature (see
  // app/api/attachments/route.ts) — and once this endpoint really clones,
  // an account is what makes per-user limiting meaningful.
  if (!user) {
    return Response.json({ error: "Please log in to attach a repository." }, { status: 401 });
  }

  // Keyed by the verified session user id, never a client-supplied header.
  const rateLimit = checkRepoScanRateLimit(user.id);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "You've reached the repository limit. Please try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  let body: { repoUrl?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (typeof body.repoUrl !== "string" || body.repoUrl.length > MAX_REPO_URL_LENGTH) {
    return Response.json(
      { error: "Enter a GitHub repository URL, like https://github.com/owner/repo." },
      { status: 400 },
    );
  }

  const parsed = parseGitHubRepoUrl(body.repoUrl);
  if (!parsed) {
    return Response.json(
      { error: "That doesn't look like a GitHub repository URL. Example: https://github.com/owner/repo." },
      { status: 400 },
    );
  }

  // ── Ownership verification ────────────────────────────────────────────
  // Asked here as well as at send time so the user finds out they can't scan
  // a repo while attaching it, not after composing a message. This is a
  // convenience copy of the check, exactly like the client's URL parsing is
  // a convenience copy of the server's — POST /api/repo-scan/run re-runs it
  // independently, and that one is the boundary. Removing this route's copy
  // would cost UX; removing the other one would remove the gate.
  const access = await verifyRepoAccess(user.id, parsed);
  if (!access.allowed) {
    return Response.json(
      { error: access.message, ...(access.action ? { action: access.action } : {}) },
      { status: access.status },
    );
  }

  // Refuse an unscannable repo at attach time too, so the size limit is
  // learned while pasting the URL rather than after composing a message.
  const oversize = oversizeRefusal(access.sizeKb);
  if (oversize) {
    return Response.json({ error: oversize }, { status: 413 });
  }

  // `scanAvailable` tells the client whether sending this attachment will
  // produce a real scan, so the composed message can be honest either way.
  // It is true here because the ownership check above already passed — an
  // attachment that reaches this line is one the scanner will accept.
  return Response.json({
    kind: "repo" as const,
    owner: parsed.owner,
    repo: parsed.repo,
    ref: parsed.ref,
    slug: parsed.slug,
    canonicalUrl: parsed.canonicalUrl,
    scanAvailable: true,
  });
}
