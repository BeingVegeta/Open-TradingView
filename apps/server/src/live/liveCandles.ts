import { EventEmitter } from 'node:events';
import {
  CandleBuilder,
  getTimeframe,
  type Candle,
  type Instrument,
  type Tick,
  type Timeframe,
} from '@otv/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthService } from '../auth/authService';
import type { HistoryService } from '../history/historyService';
import type { InstrumentStore } from '../instruments/instrumentStore';
import type { Clock } from '../kite/clock';
import { toKiteError } from '../kite/errors';
import type { TickerManager } from '../ticker/tickerManager';

/** How long after a bar closes to ask Kite for its historical version. */
export const RECONCILE_DELAY_MS = 10_000;
/** Bars kept per series for new subscribers. */
const RECENT_BARS = 5;

interface Series {
  id: string;
  inst: Instrument;
  tf: Timeframe;
  builder: CandleBuilder;
  consumers: Set<string>;
  /** Newest bars, ascending (live-built or reconciled). */
  recent: Candle[];
  seeded: boolean;
  timer: unknown;
  lastTickAt: number;
}

export interface BarsEvent {
  series: string;
  bars: Candle[];
  /** Authoritative bars from Kite's history (overwrite), rather than live updates. */
  replace: boolean;
}

/**
 * Live candles for every (instrument, timeframe) a browser is showing.
 *
 * Each series is seeded from fresh history, then updated from ticks by a
 * CandleBuilder. Bars built from ticks are approximations (ticks are throttled
 * snapshots), so shortly after each bar closes, and after any reconnect, the
 * recent range is re-fetched from Kite and the closed bars are replaced by
 * Kite's version. No gaps, no duplicates.
 */
export class LiveCandles extends EventEmitter<{ bars: [BarsEvent] }> {
  private readonly series = new Map<string, Series>();
  private readonly byToken = new Map<number, Set<Series>>();

  constructor(
    private readonly deps: {
      ticker: TickerManager;
      history: HistoryService;
      instruments: InstrumentStore;
      auth: AuthService;
      clock: Clock;
      log: FastifyBaseLogger;
      reconcileDelayMs?: number;
    },
  ) {
    super();
    this.setMaxListeners(100);
    deps.ticker.on('ticks', (ticks) => this.onTicks(ticks));
    deps.ticker.on('connected', (reconnect) => {
      if (reconnect) for (const s of this.series.values()) void this.reconcile(s, true);
    });
  }

  static id(key: string, tf: string): string {
    return `${key}|${tf}`;
  }

  /** Starts (or joins) a live series. Throws if the instrument or timeframe is unknown. */
  acquire(key: string, tfId: string, consumer: string): string {
    const tf = getTimeframe(tfId);
    const inst = this.deps.instruments.get(key);
    if (!tf || !inst) throw new Error(`Unknown ${tf ? 'instrument' : 'timeframe'}`);
    const id = LiveCandles.id(key, tf.id);
    let s = this.series.get(id);
    if (!s) {
      s = {
        id,
        inst,
        tf,
        builder: new CandleBuilder(inst.exchange, tf.bar),
        consumers: new Set(),
        recent: [],
        seeded: false,
        timer: undefined,
        lastTickAt: 0,
      };
      this.series.set(id, s);
      void this.start(s);
    }
    s.consumers.add(consumer);
    return id;
  }

  release(id: string, consumer: string): void {
    const s = this.series.get(id);
    if (!s) return;
    s.consumers.delete(consumer);
    if (s.consumers.size) return;
    this.deps.clock.clearTimeout(s.timer);
    this.series.delete(id);
    this.byToken.get(s.inst.token)?.delete(s);
    this.deps.ticker.release(`series:${id}`);
  }

  /** The newest bars of a series, for a client that just subscribed. */
  snapshot(id: string): Candle[] {
    return this.series.get(id)?.recent.map((c) => ({ ...c })) ?? [];
  }

  get size(): number {
    return this.series.size;
  }

  private async start(s: Series): Promise<void> {
    // Seed first, then stream: the builder continues from Kite's newest bar.
    await this.reconcile(s, true);
    if (!this.series.has(s.id)) return;
    let set = this.byToken.get(s.inst.token);
    if (!set) this.byToken.set(s.inst.token, (set = new Set()));
    set.add(s);
    this.deps.ticker.acquire(`series:${s.id}`, s.inst.token, 'full');
    this.scheduleReconcile(s);
  }

  private onTicks(ticks: Tick[]): void {
    for (const t of ticks) {
      const set = this.byToken.get(t.token);
      if (!set) continue;
      for (const s of set) {
        const r = s.builder.apply(t);
        if (!r) continue;
        s.lastTickAt = t.receivedAt;
        const bars = r.closed ? [r.closed, r.current] : [r.current];
        for (const b of bars) this.remember(s, b);
        this.emit('bars', { series: s.id, bars, replace: false });
      }
    }
  }

  /**
   * Re-fetches the recent range from Kite and replaces closed bars with it.
   * With `reseed`, the forming bar is also taken from Kite (after a reconnect
   * the builder's volume baseline can't be trusted).
   */
  private async reconcile(s: Series, reseed: boolean): Promise<void> {
    const session = this.deps.auth.session();
    if (!session) return;
    const cur = s.builder.current;
    const barS = s.tf.bar === 'day' ? 86_400 : s.tf.bar * 60;
    // From two bars before the oldest bar we may have gotten wrong.
    const from =
      (s.recent[0]?.time ?? cur?.time ?? Math.floor(this.deps.clock.now() / 1000)) - 2 * barS;
    let kite: Candle[];
    try {
      const res = await this.deps.history.getSince(session.accessToken, s.inst, s.tf, from, {
        fresh: true,
        priority: 'low',
      });
      kite = res.candles;
    } catch (err) {
      const e = toKiteError(err);
      if (!this.deps.auth.handleKiteError(e)) {
        this.deps.log.warn({ series: s.id, msg: e.message }, 'Live reconcile failed');
      }
      return;
    }
    if (!this.series.has(s.id)) return;
    const forming = s.builder.current;
    const closedFromKite = kite.filter((c) => !forming || c.time < forming.time);
    const newest = kite.at(-1);
    if (reseed || !s.seeded) {
      s.builder.seed(newest);
      s.seeded = true;
    }
    const replace =
      reseed || !forming ? kite.slice(-RECENT_BARS) : closedFromKite.slice(-RECENT_BARS);
    if (!replace.length) return;
    for (const b of replace) this.remember(s, b);
    this.emit('bars', { series: s.id, bars: replace, replace: true });
  }

  private scheduleReconcile(s: Series): void {
    if (s.tf.bar === 'day') return; // day bars come from the exchange's own day OHLC
    const now = this.deps.clock.now();
    const nextBoundary = (s.builder.bucket(Math.floor(now / 1000)) + s.tf.bar * 60) * 1000;
    const delay = nextBoundary - now + (this.deps.reconcileDelayMs ?? RECONCILE_DELAY_MS);
    s.timer = this.deps.clock.setTimeout(() => {
      if (!this.series.has(s.id)) return;
      // Only when the bar that just closed was in session and saw ticks.
      const closedBar = s.builder.bucket(Math.floor(nextBoundary / 1000) - 1);
      if (s.builder.inSession(closedBar) && s.lastTickAt > 0) void this.reconcile(s, false);
      this.scheduleReconcile(s);
    }, delay);
  }

  private remember(s: Series, bar: Candle): void {
    const i = s.recent.findIndex((c) => c.time === bar.time);
    if (i >= 0) s.recent[i] = { ...bar };
    else {
      s.recent.push({ ...bar });
      s.recent.sort((a, b) => a.time - b.time);
    }
    if (s.recent.length > RECENT_BARS) s.recent.splice(0, s.recent.length - RECENT_BARS);
  }
}
