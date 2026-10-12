import { systemClock, type Clock } from './clock';

/** Kite's per-API-key limits (https://kite.trade/docs/connect/v3/exceptions/#api-rate-limit). */
export type RateCategory = 'quote' | 'historical' | 'default';

export const KITE_RATE_LIMITS: Record<RateCategory, number> = {
  quote: 1,
  historical: 3,
  default: 10,
};

export type Priority = 'high' | 'low';

interface Job {
  start: () => void;
  signal?: AbortSignal | undefined;
}

interface Lane {
  limit: number;
  /** Start times of the last `limit` requests, oldest first. */
  starts: number[];
  high: Job[];
  low: Job[];
  /** No starts before this time (set after a 429). */
  blockedUntil: number;
  timer: unknown;
}

/**
 * One queue in front of every Kite REST call. A sliding one-second window per
 * category guarantees at most `limit` request starts in any window (plus a
 * small safety margin for clock skew between us and Kite). Interactive work
 * (`high`) goes before background work (`low`, e.g. prefetch) in the same lane.
 */
export class RateLimiter {
  private readonly lanes = new Map<RateCategory, Lane>();

  constructor(
    limits: Record<RateCategory, number> = KITE_RATE_LIMITS,
    private readonly clock: Clock = systemClock,
    private readonly windowMs = 1000,
    private readonly safetyMs = 50,
  ) {
    for (const [cat, limit] of Object.entries(limits) as [RateCategory, number][]) {
      this.lanes.set(cat, {
        limit,
        starts: [],
        high: [],
        low: [],
        blockedUntil: 0,
        timer: undefined,
      });
    }
  }

  /** Runs `fn` once the category has capacity. Rejects with the signal's reason if aborted while queued. */
  run<T>(
    category: RateCategory,
    fn: () => Promise<T>,
    opts: { priority?: Priority; signal?: AbortSignal } = {},
  ): Promise<T> {
    const lane = this.lanes.get(category)!;
    return new Promise<T>((resolve, reject) => {
      if (opts.signal?.aborted) return reject(opts.signal.reason);
      const job: Job = {
        signal: opts.signal,
        start: () => {
          fn().then(resolve, reject);
        },
      };
      opts.signal?.addEventListener(
        'abort',
        () => {
          for (const q of [lane.high, lane.low]) {
            const i = q.indexOf(job);
            if (i >= 0) {
              q.splice(i, 1);
              reject(opts.signal!.reason);
            }
          }
        },
        { once: true },
      );
      (opts.priority === 'low' ? lane.low : lane.high).push(job);
      this.pump(lane);
    });
  }

  /** After a 429: hold the whole category for `ms`. */
  backOff(category: RateCategory, ms: number): void {
    const lane = this.lanes.get(category)!;
    lane.blockedUntil = Math.max(lane.blockedUntil, this.clock.now() + ms);
  }

  /** Number of jobs waiting (for tests and diagnostics). */
  pending(category: RateCategory): number {
    const lane = this.lanes.get(category)!;
    return lane.high.length + lane.low.length;
  }

  private nextSlot(lane: Lane): number {
    const now = this.clock.now();
    let t = Math.max(now, lane.blockedUntil);
    if (lane.starts.length >= lane.limit) {
      t = Math.max(
        t,
        lane.starts[lane.starts.length - lane.limit]! + this.windowMs + this.safetyMs,
      );
    }
    return t;
  }

  private pump(lane: Lane): void {
    if (lane.timer !== undefined) return;
    for (;;) {
      const queue = lane.high.length ? lane.high : lane.low;
      const job = queue[0];
      if (!job) return;
      if (job.signal?.aborted) {
        queue.shift();
        continue;
      }
      const at = this.nextSlot(lane);
      const now = this.clock.now();
      if (at > now) {
        lane.timer = this.clock.setTimeout(() => {
          lane.timer = undefined;
          this.pump(lane);
        }, at - now);
        return;
      }
      queue.shift();
      lane.starts.push(now);
      if (lane.starts.length > lane.limit) lane.starts.splice(0, lane.starts.length - lane.limit);
      job.start();
    }
  }
}
