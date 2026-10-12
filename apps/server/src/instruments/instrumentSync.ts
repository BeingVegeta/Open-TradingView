import { DAY_MS, istStartOfDay, MINUTE_MS, type InstrumentSyncStatus } from '@otv/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthService } from '../auth/authService';
import { systemClock, type Clock } from '../kite/clock';
import { toKiteError } from '../kite/errors';
import type { KiteGateway } from '../kite/gateway';
import type { InstrumentStore } from './instrumentStore';

/** Kite regenerates the instrument dump daily; its docs suggest fetching around 08:30 IST. */
export const SYNC_TIME_IST_MINUTES = 8 * 60 + 30;
const RETRY_MS = 2 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Most recent 08:30 IST at or before `now`. */
export function lastSyncBoundary(now: number): number {
  const today = istStartOfDay(now) + SYNC_TIME_IST_MINUTES * MINUTE_MS;
  return now >= today ? today : today - DAY_MS;
}

/**
 * Keeps the instrument master fresh: syncs when the stored copy predates the
 * latest 08:30 IST boundary, as soon as there is a session to do it with —
 * at startup, right after login, and on a timer at each day's 08:30 IST.
 */
export class InstrumentSync {
  private syncing: Promise<void> | null = null;
  private error: string | null = null;
  private timer: unknown;
  private retries = 0;

  constructor(
    private readonly deps: {
      store: InstrumentStore;
      gateway: KiteGateway;
      auth: AuthService;
      log: FastifyBaseLogger;
      clock?: Clock;
    },
  ) {}

  private get clock(): Clock {
    return this.deps.clock ?? systemClock;
  }

  start(): void {
    this.deps.auth.on('change', (s) => {
      if (s.state === 'logged_in') void this.syncIfStale();
    });
    void this.syncIfStale();
    this.scheduleDaily();
  }

  stop(): void {
    this.clock.clearTimeout(this.timer);
  }

  status(): InstrumentSyncStatus {
    return {
      count: this.deps.store.index.size,
      syncedAt: this.deps.store.lastSyncedAt,
      syncing: this.syncing !== null,
      error: this.error,
    };
  }

  isStale(now = this.clock.now()): boolean {
    const at = this.deps.store.lastSyncedAt;
    return at === null || at < lastSyncBoundary(now);
  }

  /** Waits for an in-flight sync, if any. */
  async settled(): Promise<void> {
    await this.syncing;
  }

  syncIfStale(): Promise<void> {
    if (!this.isStale()) return Promise.resolve();
    return this.sync();
  }

  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    const session = this.deps.auth.session();
    if (!session) return Promise.resolve();
    this.syncing = (async () => {
      const t0 = this.clock.now();
      try {
        const list = await this.deps.gateway.fetchInstruments(session.accessToken);
        if (list.length === 0) throw new Error('Kite returned an empty instrument list');
        this.deps.store.replaceAll(list, this.clock.now());
        this.error = null;
        this.retries = 0;
        this.deps.log.info(
          { count: list.length, ms: this.clock.now() - t0 },
          'Instrument master synced',
        );
      } catch (err) {
        const e = toKiteError(err);
        if (this.deps.auth.handleKiteError(e)) {
          this.error = null;
          return;
        }
        this.error =
          e.kind === 'permission'
            ? `Kite refused the instrument list: ${e.message} Market data needs the paid Kite Connect plan.`
            : `Instrument sync failed: ${e.message}`;
        this.deps.log.warn({ kind: e.kind, msg: e.message }, 'Instrument sync failed');
        if (e.retryable && this.retries < 5) {
          this.retries++;
          this.clock.clearTimeout(this.timer);
          this.timer = this.clock.setTimeout(() => {
            void this.syncIfStale();
            this.scheduleDaily();
          }, RETRY_MS * this.retries);
        }
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  private scheduleDaily(): void {
    const now = this.clock.now();
    const next = lastSyncBoundary(now) + DAY_MS;
    // A little jitter after 08:30 so the dump is surely regenerated.
    const delay = Math.min(next - now + 60_000, MAX_TIMER_MS);
    this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      void this.syncIfStale();
      this.scheduleDaily();
    }, delay);
  }
}
