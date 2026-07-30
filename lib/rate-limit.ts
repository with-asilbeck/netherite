// In-memory, fixed-window rate limiters. Used for:
// - guest (unauthenticated) chat requests, keyed by IP
// - authenticated upload requests, keyed by user id
//
// Known limitation: state is per server instance and resets on cold start
// or redeploy. Vercel can run multiple concurrent instances of a route, so
// the *effective* global limit for a determined, distributed attacker is
// higher than the configured max. Good enough to stop casual abuse with no
// existing shared-state infra (Redis / Vercel KV) in this repo; back these
// with a shared store if either feature becomes permanent / high-traffic.

import { ipAddress } from "@vercel/functions";

type Bucket = { count: number; resetAt: number };

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

class FixedWindowLimiter {
  private buckets = new Map<string, Bucket>();
  private lastCleanup = Date.now();

  constructor(
    private readonly windowMs: number,
    private readonly maxPerWindow: number,
    private readonly maxTrackedKeys: number,
    private readonly cleanupIntervalMs: number,
  ) {}

  // Bounds memory growth from one-off keys. Runs inline (no setInterval) so
  // it works the same in a long-lived `next dev`/self-hosted process and in
  // a short-lived serverless invocation.
  private pruneExpired(now: number) {
    this.lastCleanup = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  check(key: string): RateLimitResult {
    const now = Date.now();

    if (now - this.lastCleanup >= this.cleanupIntervalMs) {
      this.pruneExpired(now);
    }

    const bucket = this.buckets.get(key);

    if (bucket && bucket.resetAt > now) {
      if (bucket.count >= this.maxPerWindow) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
        };
      }
      bucket.count += 1;
      return { allowed: true };
    }

    // New (or expired) entry. If we're at capacity, force an immediate
    // prune to try to make room before deciding whether to fail closed.
    if (this.buckets.size >= this.maxTrackedKeys) {
      this.pruneExpired(now);
    }

    if (this.buckets.size >= this.maxTrackedKeys) {
      // Still full after pruning — refuse to grow further. Fails closed
      // for this (unrecognized) key rather than letting memory usage
      // climb without bound; keys already tracked are unaffected.
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(this.cleanupIntervalMs / 1000),
      };
    }

    this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
    return { allowed: true };
  }
}

const HOUR_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // sweep stale keys every 10 minutes
const MAX_TRACKED_KEYS = 5000; // hard cap so a flood of distinct keys can't grow this unbounded

export function getClientIp(request: Request): string {
  // ipAddress() reads x-real-ip, which Vercel's own proxy computes and
  // sets itself — unlike x-forwarded-for, a client can't hand the platform
  // a fake value for it. (@vercel/functions' source confirms it doesn't
  // consult x-forwarded-for at all, deliberately.) Falls back to a single
  // shared bucket when there's no proxy in front (e.g. local dev).
  return ipAddress(request) ?? "unknown";
}

const guestChatLimiter = new FixedWindowLimiter(HOUR_MS, 15, MAX_TRACKED_KEYS, CLEANUP_INTERVAL_MS);

export function checkGuestChatRateLimit(request: Request): RateLimitResult {
  return guestChatLimiter.check(getClientIp(request));
}

// Uploads are authenticated-only, so this is keyed by the verified user id
// — unlike IP-based limiting, there's no header-spoofing concern here.
const uploadLimiter = new FixedWindowLimiter(HOUR_MS, 20, MAX_TRACKED_KEYS, CLEANUP_INTERVAL_MS);

export function checkUploadRateLimit(userId: string): RateLimitResult {
  return uploadLimiter.check(userId);
}

// Repo attach/scan. Kept separate from the upload limiter (rather than
// sharing its bucket) because the two will diverge: this endpoint currently
// only validates a URL string, but it's the seam where real server-side
// cloning lands, which is far more expensive per request. A tighter limit
// now means the ceiling is already in place when that arrives, and raising
// the file-upload allowance later can't loosen it.
const repoScanLimiter = new FixedWindowLimiter(HOUR_MS, 10, MAX_TRACKED_KEYS, CLEANUP_INTERVAL_MS);

export function checkRepoScanRateLimit(userId: string): RateLimitResult {
  return repoScanLimiter.check(userId);
}

// Actually running a scan — clone, walk, and dozens of model calls — is far
// more expensive than validating a URL or sending a chat message, so it gets
// its own much tighter budget. This is the endpoint CLAUDE.md calls out as
// public-facing and abusable.
const repoScanRunLimiter = new FixedWindowLimiter(HOUR_MS, 3, MAX_TRACKED_KEYS, CLEANUP_INTERVAL_MS);

export function checkRepoScanRunRateLimit(userId: string): RateLimitResult {
  return repoScanRunLimiter.check(userId);
}
