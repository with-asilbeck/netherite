/**
 * GitHub App authentication: the only place a credential capable of reading
 * private source code is created.
 *
 * ## The two credentials, and why only one of them is ever stored
 *
 * A GitHub App has two: the **App JWT**, signed locally with the App's RSA
 * private key, which proves "I am this App" and can do nothing to a
 * repository; and an **installation access token**, obtained by presenting
 * that JWT, which can read the repositories the installation covers. The
 * second is the dangerous one and it is never persisted — not in the
 * database, not on disk, not in a module-level cache. It is minted for one
 * scan, handed to one `git clone`, and dropped.
 *
 * There is no column anywhere in the schema that could hold one (see
 * supabase/migrations/20260807000000_private_repo_scanning.sql), which is a
 * stronger guarantee than a rule about not writing it: a future mistake has
 * nowhere to put it.
 *
 * GitHub expires installation tokens after one hour regardless. That is a
 * backstop, not the design — the design is that the token's lifetime is the
 * lifetime of one clone.
 *
 * ## Why the token is never logged
 *
 * Every failure path in this file reports the *status* of a GitHub call and
 * never its request headers or body. `redactToken` exists for the one place
 * where a token could plausibly reach a string that gets logged: git's own
 * stderr (see lib/repo-scan/clone.ts).
 */

import { createSign, timingSafeEqual } from "node:crypto";

const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * GitHub rejects an App JWT with `exp` more than 10 minutes out, and clock
 * skew between us and GitHub is real, so this sits well under the ceiling.
 * `iat` is backdated for the same reason.
 */
const JWT_LIFETIME_SECONDS = 480;
const JWT_BACKDATE_SECONDS = 60;

export class GitHubAppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAppConfigError";
  }
}

/**
 * Reads the App's RSA private key from the environment, tolerating every
 * shape it plausibly arrives in.
 *
 * This is not defensive padding — each branch corresponds to a real way the
 * key gets mangled between GitHub's download and a running process:
 *
 * - **Base64** (`GITHUB_PRIVATE_KEY_B64`), preferred for Vercel and any other
 *   dashboard whose environment-variable box does not reliably round-trip a
 *   27-line value.
 * - **Literal `\n` escapes**, which is what happens when a PEM is pasted into
 *   a single-line env var by hand.
 * - **CRLF**, which is what happens when the `.env` file was written on
 *   Windows. Node's PEM decoder is strict about this.
 *
 * Fails loudly rather than returning something unusable: a malformed key
 * that surfaces as "signature invalid" three calls later is a bad afternoon.
 */
export function readAppPrivateKey(): string {
  const b64 = process.env.GITHUB_PRIVATE_KEY_B64;
  const raw = b64
    ? Buffer.from(b64, "base64").toString("utf8")
    : (process.env.GITHUB_PRIVATE_KEY ?? "");

  const key = raw.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();

  if (!key) {
    throw new GitHubAppConfigError(
      "GITHUB_PRIVATE_KEY is not set, so private repository scanning is unavailable.",
    );
  }
  if (!key.includes("BEGIN") || !key.includes("PRIVATE KEY") || !key.includes("END")) {
    throw new GitHubAppConfigError(
      "GITHUB_PRIVATE_KEY does not look like a PEM private key. If it is a multi-line value in .env.local it must be wrapped in double quotes, or supplied base64-encoded as GITHUB_PRIVATE_KEY_B64.",
    );
  }
  // A single-line value that has BEGIN and END but no interior newlines is
  // the exact failure this app already hit once: dotenv truncating an
  // unquoted multi-line PEM. Catch it here rather than at signing time.
  if (key.split("\n").length < 3) {
    throw new GitHubAppConfigError(
      "GITHUB_PRIVATE_KEY appears truncated to a single line. An unquoted multi-line value in .env.local is read only up to its first newline — wrap it in double quotes, or use GITHUB_PRIVATE_KEY_B64.",
    );
  }
  return key;
}

export function readAppId(): string {
  const appId = process.env.GITHUB_APP_ID?.trim();
  if (!appId) {
    throw new GitHubAppConfigError(
      "GITHUB_APP_ID is not set, so private repository scanning is unavailable.",
    );
  }
  return appId;
}

/** Whether the deployment is configured for private scanning at all. */
export function privateScanningConfigured(): boolean {
  try {
    readAppId();
    readAppPrivateKey();
    return true;
  } catch {
    return false;
  }
}

const base64url = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * Signs an App JWT. Cheap (one RSA signature), so it is done per call rather
 * than cached — a cached JWT is a credential with a lifetime, and this file
 * exists to avoid those.
 */
export function createAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "RS256", typ: "JWT" });
  const payload = base64url({
    iat: now - JWT_BACKDATE_SECONDS,
    exp: now + JWT_LIFETIME_SECONDS,
    iss: readAppId(),
  });

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(readAppPrivateKey(), "base64url")}`;
}

export type InstallationAccount = {
  login: string;
  id: number;
  type: string;
};

export type AppInstallation = {
  id: number;
  account: InstallationAccount;
  repositorySelection: "all" | "selected";
};

type AppCallFailure =
  | { kind: "config"; message: string }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export type AppResult<T> = { ok: true; data: T } | { ok: false; failure: AppCallFailure };

async function appFetch(
  path: string,
  init: { method?: string } = {},
): Promise<AppResult<unknown>> {
  let jwt: string;
  try {
    jwt = createAppJwt();
  } catch (err) {
    return {
      ok: false,
      failure: {
        kind: "config",
        message:
          err instanceof GitHubAppConfigError ? err.message : "GitHub App is not configured.",
      },
    };
  }

  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Netherite-Security-Scanner",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, failure: { kind: "unavailable" } };
  }

  if (response.status === 404) return { ok: false, failure: { kind: "not_found" } };
  if (!response.ok) {
    // Deliberately does not include the body. An error body from an
    // authenticated GitHub call is not a place to be casual about what gets
    // into a log line.
    console.error(`[github-app] ${init.method ?? "GET"} ${path} -> ${response.status}`);
    return { ok: false, failure: { kind: "unavailable" } };
  }

  try {
    return { ok: true, data: await response.json() };
  } catch {
    return { ok: false, failure: { kind: "unavailable" } };
  }
}

function parseInstallation(value: unknown): AppInstallation | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as {
    id?: unknown;
    account?: { login?: unknown; id?: unknown; type?: unknown } | null;
    repository_selection?: unknown;
  };
  if (typeof row.id !== "number") return null;
  if (
    !row.account ||
    typeof row.account.login !== "string" ||
    typeof row.account.id !== "number"
  ) {
    return null;
  }
  return {
    id: row.id,
    account: {
      login: row.account.login,
      id: row.account.id,
      type: typeof row.account.type === "string" ? row.account.type : "User",
    },
    repositorySelection: row.repository_selection === "all" ? "all" : "selected",
  };
}

/**
 * The App's slug, which is what its install URL is built from.
 *
 * Read from GitHub rather than hardcoded, because a slug that drifts from the
 * real one produces a 404 on GitHub's own site — a confusing dead end for the
 * user and an easy thing to miss in review. `GITHUB_APP_SLUG` overrides it for
 * deployments that would rather not spend the call.
 *
 * Cached for the process lifetime: an App's slug changes only if somebody
 * renames the App, which is not a thing that happens between two requests.
 */
let cachedSlug: string | null = null;

export async function fetchAppSlug(): Promise<string | null> {
  const configured = process.env.GITHUB_APP_SLUG?.trim();
  if (configured) return configured;
  if (cachedSlug) return cachedSlug;

  const result = await appFetch("/app");
  if (!result.ok) return null;

  const slug = (result.data as { slug?: unknown }).slug;
  if (typeof slug !== "string" || !slug) return null;

  cachedSlug = slug;
  return slug;
}

/** Where a user goes to install the App. */
export function installUrl(slug: string, state: string): string {
  const url = new URL(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

/** Reads one installation by id. The callback uses this to verify ownership. */
export async function fetchInstallation(
  installationId: number,
): Promise<AppResult<AppInstallation>> {
  const result = await appFetch(`/app/installations/${encodeURIComponent(String(installationId))}`);
  if (!result.ok) return result;

  const installation = parseInstallation(result.data);
  if (!installation) return { ok: false, failure: { kind: "unavailable" } };
  return { ok: true, data: installation };
}

/**
 * An installation access token, and the only object in this codebase that
 * holds one.
 *
 * `use` rather than a bare string field so callers read as
 * "here is the token, for this one call" — and so the only way to obtain the
 * string is a method call that can be found by grepping for it. There are
 * exactly two call sites, both in lib/repo-scan/clone.ts.
 */
export type InstallationToken = {
  /** The token itself. Never store, never log, never put in a URL. */
  use: () => string;
  expiresAt: string;
};

/**
 * Mints a short-lived installation access token.
 *
 * Called immediately before a clone and never cached. Two reasons caching
 * would be wrong even though GitHub gives an hour: a cache is a place the
 * token lives, and a cached token outlives the consent and tier checks that
 * justified minting it — a user downgraded or a consent withdrawn mid-hour
 * would still have a working credential sitting in memory.
 *
 * `repositoryIds` narrows the token to the single repository being scanned
 * when GitHub supports it. An installation may cover an entire account; a
 * token scoped to one repo means a bug elsewhere in the pipeline cannot read
 * the other ninety.
 */
export async function createInstallationToken(
  installationId: number,
  options: { repositoryIds?: number[] } = {},
): Promise<AppResult<InstallationToken>> {
  let jwt: string;
  try {
    jwt = createAppJwt();
  } catch (err) {
    return {
      ok: false,
      failure: {
        kind: "config",
        message:
          err instanceof GitHubAppConfigError ? err.message : "GitHub App is not configured.",
      },
    };
  }

  const body: Record<string, unknown> = {};
  if (options.repositoryIds?.length) {
    body.repository_ids = options.repositoryIds;
    // Least privilege, restated per token: the installation may be granted
    // more than this, but this token is only ever used to read one repo's
    // contents for one clone.
    body.permissions = { contents: "read", metadata: "read" };
  }

  let response: Response;
  try {
    response = await fetch(
      `${GITHUB_API}/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Netherite-Security-Scanner",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch {
    return { ok: false, failure: { kind: "unavailable" } };
  }

  if (response.status === 404) return { ok: false, failure: { kind: "not_found" } };

  if (!response.ok) {
    console.error(`[github-app] token exchange -> ${response.status}`);
    return { ok: false, failure: { kind: "unavailable" } };
  }

  let parsed: { token?: unknown; expires_at?: unknown };
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, failure: { kind: "unavailable" } };
  }

  if (typeof parsed.token !== "string" || parsed.token.length === 0) {
    return { ok: false, failure: { kind: "unavailable" } };
  }

  const token = parsed.token;
  return {
    ok: true,
    data: {
      use: () => token,
      expiresAt: typeof parsed.expires_at === "string" ? parsed.expires_at : "",
    },
  };
}

/**
 * Best-effort revocation, called after a clone finishes.
 *
 * GitHub expires these in an hour anyway, so this is belt-and-braces — but an
 * hour is a long time for a credential whose useful life was four seconds,
 * and a scan that crashed mid-clone is exactly when you would want it gone.
 * Failures are swallowed: nothing about the scan depends on it, and the
 * token expires regardless.
 */
export async function revokeInstallationToken(token: InstallationToken): Promise<void> {
  try {
    await fetch(`${GITHUB_API}/installation/token`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token.use()}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Netherite-Security-Scanner",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Deliberately silent. See the doc comment.
  }
}

/**
 * Removes a token from a string that is about to be logged or shown.
 *
 * The one realistic leak path is git's stderr: a transport error can echo
 * back parts of the request. Compared with `timingSafeEqual` semantics
 * elsewhere in this codebase, this is a plain substring replace — it is a
 * scrubber, not a check, and the value is already known to both sides.
 */
export function redactToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("[redacted]");
}

/**
 * Constant-time comparison for the installation-callback state parameter.
 * Exported here because this is the module that owns App-flow secrets.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
