import { EventEmitter } from 'node:events';
import { maxMode, type Tick, type TickMode } from '@otv/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthService } from '../auth/authService';
import type { Clock } from '../kite/clock';
import { TickerConnection, type UpstreamStatus } from './tickerConnection';

/**
 * Reference-counted subscriptions over the single upstream ticker connection.
 *
 * Every consumer (a chart series, a browser's watchlist, …) acquires the
 * instruments it needs with the mode it needs; the upstream mode for a token is
 * the richest any consumer asked for (full > quote > ltp), and a token is
 * unsubscribed only when nobody holds it. Follows the auth state: stops at
 * logout or token expiry, resubscribes everything after the next login.
 */
export class TickerManager extends EventEmitter<{
  ticks: [Tick[]];
  status: [UpstreamStatus];
  connected: [boolean];
}> {
  private readonly holds = new Map<string, Map<number, TickMode>>();
  private readonly latest = new Map<number, Tick>();
  private readonly conn: TickerConnection;
  private pending = false;

  constructor(
    private readonly deps: {
      auth: AuthService;
      /** Builds the upstream URL for an access token. */
      urlFor: (accessToken: string) => string;
      log: FastifyBaseLogger;
      clock?: Clock;
      onFrame?: (data: Buffer, isBinary: boolean, receivedAt: number) => void;
      silenceTimeoutMs?: number;
      minBackoffMs?: number;
    },
  ) {
    super();
    this.setMaxListeners(100);
    this.conn = new TickerConnection({
      url: () => {
        const s = deps.auth.session();
        return s ? deps.urlFor(s.accessToken) : null;
      },
      onTicks: (ticks) => {
        for (const t of ticks) this.latest.set(t.token, mergeTick(this.latest.get(t.token), t));
        this.emit('ticks', ticks);
      },
      onStatus: (s) => this.emit('status', s),
      onTokenRejected: (message) => {
        deps.auth.handleKiteError({ error_type: 'TokenException', message });
      },
      onConnected: (reconnect) => this.emit('connected', reconnect),
      log: deps.log,
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.onFrame ? { onFrame: deps.onFrame } : {}),
      ...(deps.silenceTimeoutMs ? { silenceTimeoutMs: deps.silenceTimeoutMs } : {}),
      ...(deps.minBackoffMs
        ? { minBackoffMs: deps.minBackoffMs, maxBackoffMs: deps.minBackoffMs * 4 }
        : {}),
    });
    deps.auth.on('change', (s) => {
      if (s.state === 'logged_in') {
        // New session (e.g. the daily re-login): restore every subscription.
        const d = this.desired();
        if (d.size) this.conn.setSubscriptions(d);
        this.conn.start();
      } else {
        this.conn.stop();
      }
    });
  }

  get status(): UpstreamStatus {
    return this.conn.state;
  }

  /** Latest known tick (merged across modes) for a token. */
  lastTick(token: number): Tick | undefined {
    return this.latest.get(token);
  }

  acquire(consumer: string, token: number, mode: TickMode): void {
    let m = this.holds.get(consumer);
    if (!m) this.holds.set(consumer, (m = new Map()));
    const prev = m.get(token);
    m.set(token, prev ? maxMode(prev, mode) : mode);
    this.schedule();
  }

  /** Releases one token, or everything the consumer holds. */
  release(consumer: string, token?: number): void {
    const m = this.holds.get(consumer);
    if (!m) return;
    if (token === undefined) this.holds.delete(consumer);
    else {
      m.delete(token);
      if (m.size === 0) this.holds.delete(consumer);
    }
    this.schedule();
  }

  /** Effective upstream subscriptions (for tests and diagnostics). */
  desired(): Map<number, TickMode> {
    const out = new Map<number, TickMode>();
    for (const m of this.holds.values()) {
      for (const [token, mode] of m)
        out.set(token, out.has(token) ? maxMode(out.get(token)!, mode) : mode);
    }
    return out;
  }

  stop(): void {
    this.conn.stop();
  }

  dropUpstreamForTest(): void {
    this.conn.dropForTest();
  }

  /** Batches bursts of acquire/release (e.g. a layout opening) into one upstream update. */
  private schedule(): void {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      const d = this.desired();
      for (const token of this.latest.keys()) if (!d.has(token)) this.latest.delete(token);
      if (!this.deps.auth.session()) return;
      this.conn.setSubscriptions(d);
    });
  }
}

/** Keeps richer fields from an earlier tick when a poorer-mode tick arrives. */
function mergeTick(prev: Tick | undefined, next: Tick): Tick {
  if (!prev || next.mode === 'full' || prev.mode === next.mode) return next;
  return { ...prev, ...next, mode: prev.mode === 'full' ? 'full' : next.mode };
}
