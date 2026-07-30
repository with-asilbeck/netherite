import { createClient } from "@/lib/supabase/server";
import { checkRepoScanRateLimit } from "@/lib/rate-limit";
import { MAX_REPO_URL_LENGTH, parseGitHubRepoUrl } from "@/lib/github-repo";

// Repo attach endpoint — the seam for roadmap feature #2 (GitHub repo
// scanning). Right now it validates and normalizes a pasted repo URL and
// nothing else: no clone, no fetch, no outbound request of any kind. That's
// deliberate, not an oversight. The URL is attacker-controlled, so anything
// that resolved it server-side would be an SSRF sink, and cloning arbitrary
// repos needs its own design (disk limits, timeouts, private-repo auth,
// symlink/`.git` handling) rather than being bolted on here.
//
// The client attaches the repo chip on a 200 from this route, so when the
// real scanner lands it plugs in at the marked call site below and the UI
// needs no structural change.

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

  // This route stays validate-only: it's what the composer calls to build an
  // attachment chip, and it has to answer instantly. The scan itself runs at
  // send time against POST /api/repo-scan/run, which streams progress and
  // can take minutes.
  const scanAvailable = true;

  // `scanAvailable` tells the client whether sending this attachment will
  // produce a real scan, so the composed message can be honest either way.
  return Response.json({
    kind: "repo" as const,
    owner: parsed.owner,
    repo: parsed.repo,
    ref: parsed.ref,
    slug: parsed.slug,
    canonicalUrl: parsed.canonicalUrl,
    scanAvailable,
  });
}
