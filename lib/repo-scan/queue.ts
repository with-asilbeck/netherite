// Admission control for repo scans, with priority for pro and max.
//
// Scans are not background jobs in this app — a scan runs inside the request
// that asked for it and streams progress back (app/api/repo-scan/run). There
// is therefore no job table to dequeue from, and "priority queue" has to
// mean something that actually exists: which waiting request gets the next
// free scan slot.
//
// A slot is worth queueing for. One scan is a clone plus up to ~50 model
// calls across two models, and several at once on one instance contend for
// CPU, disk, sockets, and the OpenRouter rate limit — so the practical
// effect of unbounded concurrency is that everybody's scan gets slower and
// some time out. Bounding it and ordering the waiters is the whole feature.
//
// **Known limitation, same as lib/rate-limit.ts:** this queue is per server
// instance and does not survive a cold start. Vercel can run several
// instances of a route concurrently, so the effective global concurrency is
// higher than MAX_CONCURRENT_SCANS and a pro user only overtakes free users
// waiting on the *same* instance. Making this global needs shared state
// (Redis / Vercel KV), which this repo does not have yet. It is a real
// improvement over no ordering at all, not a distributed scheduler, and it
// is documented as such rather than being presented as one.

/** Scans allowed to run at once on this instance. */
export const MAX_CONCURRENT_SCANS = 2;

/** Waiters allowed to queue before new arrivals are turned away. */
export const MAX_QUEUE_DEPTH = 12;

/**
 * How long a waiter will hold before giving up.
 *
 * Below the route's `maxDuration` of 300s with room for the scan itself, so
 * a request that waits this long is told to retry rather than being admitted
 * with no time left to finish.
 */
export const MAX_QUEUE_WAIT_MS = 45_000;

/** Lower number is served first. */
export const PRIORITY_HIGH = 0;
export const PRIORITY_NORMAL = 1;

export type ScanPriority = typeof PRIORITY_HIGH | typeof PRIORITY_NORMAL;

export class ScanQueueFullError extends Error {
  constructor() {
    super("Too many scans are queued right now. Please try again in a few minutes.");
    this.name = "ScanQueueFullError";
  }
}

export class ScanQueueTimeoutError extends Error {
  constructor() {
    super(
      "The scanner is busy and your scan didn't get a slot in time. Please try again in a few minutes.",
    );
    this.name = "ScanQueueTimeoutError";
  }
}

type Waiter = {
  priority: ScanPriority;
  /** Arrival order, so equal priorities stay first-come-first-served. */
  seq: number;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  onAbort: (() => void) | null;
  signal: AbortSignal | undefined;
};

let running = 0;
let sequence = 0;
const waiting: Waiter[] = [];

/** Highest priority first, then arrival order. Never sorts by wait time. */
function nextWaiterIndex(): number {
  let best = -1;
  for (let i = 0; i < waiting.length; i++) {
    if (best === -1) {
      best = i;
      continue;
    }
    const candidate = waiting[i];
    const incumbent = waiting[best];
    if (
      candidate.priority < incumbent.priority ||
      (candidate.priority === incumbent.priority && candidate.seq < incumbent.seq)
    ) {
      best = i;
    }
  }
  return best;
}

function settle(waiter: Waiter, err: Error | null) {
  if (waiter.settled) return;
  waiter.settled = true;
  clearTimeout(waiter.timer);
  if (waiter.onAbort && waiter.signal) {
    waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
  if (err) waiter.reject(err);
  else waiter.resolve();
}

function remove(waiter: Waiter) {
  const index = waiting.indexOf(waiter);
  if (index !== -1) waiting.splice(index, 1);
}

function admitNext() {
  while (running < MAX_CONCURRENT_SCANS) {
    const index = nextWaiterIndex();
    if (index === -1) return;
    const [waiter] = waiting.splice(index, 1);
    // A waiter that already timed out or aborted is skipped rather than
    // being handed a slot nobody is left to use.
    if (waiter.settled) continue;
    running += 1;
    settle(waiter, null);
  }
}

/**
 * Waits for a scan slot and returns the function that gives it back.
 *
 * `priority` comes from the caller's tier — `entitlement.priorityQueue`,
 * which is derived from the subscriptions table server-side. It is a
 * parameter of this module rather than something read here so that the
 * queue has no opinion about billing, and so nothing in this file can be
 * influenced by a request.
 *
 * The returned release function is idempotent: a scan that throws and is
 * also released in a `finally` must not return the slot twice, which would
 * let concurrency drift above the cap over time.
 */
export function acquireScanSlot(
  priority: ScanPriority,
  signal?: AbortSignal,
): Promise<() => void> {
  if (signal?.aborted) {
    return Promise.reject(new ScanQueueTimeoutError());
  }

  const release = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      running = Math.max(0, running - 1);
      admitNext();
    };
  };

  if (running < MAX_CONCURRENT_SCANS && waiting.length === 0) {
    running += 1;
    return Promise.resolve(release());
  }

  if (waiting.length >= MAX_QUEUE_DEPTH) {
    return Promise.reject(new ScanQueueFullError());
  }

  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = {
      priority,
      seq: sequence++,
      resolve: () => resolve(release()),
      reject,
      settled: false,
      onAbort: null,
      signal,
      timer: setTimeout(() => {
        remove(waiter);
        settle(waiter, new ScanQueueTimeoutError());
      }, MAX_QUEUE_WAIT_MS),
    };

    // A client that disconnects while queued should free its place
    // immediately rather than being admitted into a scan nobody will read.
    if (signal) {
      waiter.onAbort = () => {
        remove(waiter);
        settle(waiter, new ScanQueueTimeoutError());
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }

    waiting.push(waiter);
  });
}

/** Test and diagnostics only — never used to make an entitlement decision. */
export function scanQueueStats() {
  return {
    running,
    queued: waiting.length,
    queuedByPriority: {
      high: waiting.filter((w) => w.priority === PRIORITY_HIGH).length,
      normal: waiting.filter((w) => w.priority === PRIORITY_NORMAL).length,
    },
  };
}

/** Test-only reset, so one suite's queue state can't leak into the next. */
export function resetScanQueueForTests() {
  for (const waiter of [...waiting]) {
    remove(waiter);
    settle(waiter, new ScanQueueTimeoutError());
  }
  running = 0;
  sequence = 0;
}
