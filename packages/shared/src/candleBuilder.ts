import type { Candle } from './market';
import { bucketStart, regularSession, type ExchangeSession } from './sessions';
import { isPeriodBar, type BarLength } from './timeframes';
import { istStartOfDay, MINUTE_MS } from './time';
import { tickTime, type Tick } from './ticks';

export type BuilderTick = Pick<
  Tick,
  | 'lastPrice'
  | 'volume'
  | 'lastQuantity'
  | 'lastTradeTime'
  | 'exchangeTime'
  | 'receivedAt'
  | 'oi'
  | 'ohlc'
  | 'tradable'
>;

export interface BuilderResult {
  /** The bar that just closed because this tick opened a new one (final live state). */
  closed?: Candle;
  /** The bar this tick updated (the forming bar). */
  current: Candle;
}

/**
 * Builds candles for one instrument and timeframe from ticks.
 *
 * - Bars are session-anchored in IST (NSE 60-minute bars start 09:15, 10:15 …).
 * - Ticks outside the regular session (pre-open, closing session, after hours)
 *   never create or change intraday bars, and their volume (e.g. the pre-open
 *   auction, included in the cumulative day volume) is not counted in any bar.
 * - Volume is cumulative-day-volume(now) − cumulative-day-volume(at bar start),
 *   never a sum of ticks.
 * - A tick whose trade time is older than the forming bar (no new trade) is ignored.
 * - Day bars come straight from the exchange's day OHLC when the tick has it.
 *   Week and month bars combine the period's earlier days (from history, see
 *   `seedDays`) with today's day bar.
 * - Indices have no volume; their bars carry volume 0.
 *
 * Live bars are approximations (ticks are throttled snapshots); closed bars are
 * later replaced by Kite's historical candles (see reconciliation).
 */
export class CandleBuilder {
  private cur: Candle | null = null;
  /** Cumulative day volume at the start of the forming bar, once known. */
  private base: number | null = null;
  /** Cumulative day volume of the last accepted tick, and its IST day. */
  private lastCum: number | null = null;
  private lastCumDay: number | null = null;
  /** Week/month bars: today's day bar, and the period's earlier days combined. */
  private today: Candle | null = null;
  private prior: Candle | null = null;

  /** Minutes after IST midnight during which ticks make candles. */
  readonly session: ExchangeSession;

  constructor(
    readonly exchange: string,
    /** Bar length in minutes, or a calendar period. */
    readonly bar: BarLength,
    /** Trading session for this instrument (default: `regularSession(exchange)`). */
    session?: ExchangeSession,
  ) {
    this.session = session ?? regularSession(exchange);
  }

  get current(): Candle | null {
    return this.cur ? { ...this.cur } : null;
  }

  /** Bar start (epoch s) containing `epochS`. */
  bucket(epochS: number): number {
    return bucketStart(this.exchange, epochS * 1000, this.bar) / 1000;
  }

  /** Whether a time falls inside the regular session (always true for day and longer bars). */
  inSession(epochS: number): boolean {
    if (isPeriodBar(this.bar)) return true;
    const s = this.session;
    const minutes = (epochS * 1000 - istStartOfDay(epochS * 1000)) / MINUTE_MS;
    return minutes >= s.open && minutes < s.close;
  }

  /**
   * Starts from history: the newest candle Kite returned becomes the forming
   * bar if ticks continue in it. Call before ticks, and again after a reconcile.
   */
  seed(last: Candle | undefined): void {
    if (!last || this.bar === 'week' || this.bar === 'month') return; // see seedDays
    if (this.cur && this.cur.time > last.time) return; // already past it
    const sameBar = this.cur?.time === last.time;
    this.cur = { ...last };
    if (this.bar === 'day') this.today = { ...last };
    // Volume continuity: keep the tick-derived base if we are mid-bar and it agrees.
    if (!sameBar) this.base = null;
    else if (this.lastCum !== null) this.base = this.lastCum - last.volume;
  }

  apply(tick: BuilderTick): BuilderResult | null {
    const t = tickTime(tick);
    const price = tick.lastPrice;
    if (!(price > 0)) return null;
    if (isPeriodBar(this.bar)) return this.applyPeriod(tick, t);

    const cum = tick.tradable === false ? undefined : tick.volume;
    if (!this.inSession(t)) {
      // Pre-open trades still count in the day's cumulative volume; remember it so
      // the first bar's volume can start from zero rather than from this figure.
      if (cum !== undefined) this.noteCum(cum, t);
      return null;
    }
    const b = this.bucket(t);
    if (this.cur && b < this.cur.time) return null; // stale: no trade since an earlier bar

    let closed: Candle | undefined;
    if (!this.cur || b > this.cur.time) {
      if (this.cur) closed = { ...this.cur };
      this.base = this.baseForNewBar(b, t, cum, tick.lastQuantity);
      this.cur = { time: b, open: price, high: price, low: price, close: price, volume: 0 };
    } else {
      if (price > this.cur.high) this.cur.high = price;
      if (price < this.cur.low) this.cur.low = price;
      this.cur.close = price;
    }

    if (cum !== undefined) {
      // First tick in a seeded bar: Kite's volume so far stands for everything before it.
      if (this.base === null) this.base = cum - this.cur.volume;
      if (cum >= (this.lastCum ?? 0) || this.lastCumDay !== istStartOfDay(t * 1000)) {
        this.cur.volume = Math.max(0, cum - this.base);
      }
      this.noteCum(cum, t);
    }
    if (tick.oi) this.cur.oi = tick.oi; // full-mode ticks carry OI = 0 for non-derivatives
    return closed ? { closed, current: { ...this.cur } } : { current: { ...this.cur } };
  }

  /** Cumulative volume at the start of a new bar opened by a tick at `t`. */
  private baseForNewBar(
    b: number,
    t: number,
    cum: number | undefined,
    lastQty: number | undefined,
  ): number | null {
    if (cum === undefined) return null;
    const day = istStartOfDay(t * 1000);
    // Everything up to the previous tick belonged to earlier bars — including the
    // pre-open auction, which Kite's candles exclude (verified against live data:
    // the day's cumulative volume exceeds the sum of its 1-minute candles by the
    // pre-open volume).
    if (this.lastCum !== null && this.lastCumDay === day) return this.lastCum;
    // No earlier tick today (e.g. connected mid-session): only this tick's trade is ours.
    return Math.max(0, cum - (lastQty ?? 0));
  }

  private noteCum(cum: number, t: number): void {
    this.lastCum = cum;
    this.lastCumDay = istStartOfDay(t * 1000);
  }

  /**
   * Week and month bars: seeds from the period's daily candles (ascending; the
   * last is the newest day, possibly today's partial one).
   */
  seedDays(days: readonly Candle[]): void {
    const last = days.at(-1);
    if (!last || this.bar === 'day' || typeof this.bar === 'number') return;
    const period = bucketStart(this.exchange, last.time * 1000, this.bar) / 1000;
    if (this.cur && this.cur.time > period) return;
    if (this.today && this.today.time > last.time) return; // ticks are already past it
    let prior: Candle | null = null;
    for (const d of days.slice(0, -1)) {
      if (bucketStart(this.exchange, d.time * 1000, this.bar) / 1000 !== period) continue;
      prior = prior ? combine(prior, d) : { ...d, time: period };
    }
    this.prior = prior;
    this.today = { ...last };
    this.cur = prior ? combine(prior, last) : { ...last, time: period };
  }

  private applyPeriod(tick: BuilderTick, t: number): BuilderResult {
    const day = istStartOfDay(t * 1000) / 1000;
    const period = bucketStart(this.exchange, t * 1000, this.bar) / 1000;
    if (this.cur && period < this.cur.time) return { current: { ...this.cur } };
    if (this.today && day < this.today.time) return { current: { ...this.cur! } };
    let closed: Candle | undefined;
    if (this.cur && period > this.cur.time) {
      closed = { ...this.cur };
      this.prior = null;
      this.today = null;
    }
    if (this.today && day > this.today.time) {
      // A new day within the same week or month.
      this.prior = this.prior ? combine(this.prior, this.today) : { ...this.today, time: period };
      this.today = null;
    }
    if (!this.today) {
      this.today = {
        time: day,
        open: tick.lastPrice,
        high: tick.lastPrice,
        low: tick.lastPrice,
        close: tick.lastPrice,
        volume: 0,
      };
    }
    const c = this.today;
    if (tick.ohlc && tick.ohlc.open > 0) {
      // The exchange's own day OHLC is authoritative.
      c.open = tick.ohlc.open;
      c.high = Math.max(tick.ohlc.high, tick.lastPrice);
      c.low = Math.min(tick.ohlc.low > 0 ? tick.ohlc.low : tick.lastPrice, tick.lastPrice);
    } else {
      c.high = Math.max(c.high, tick.lastPrice);
      c.low = Math.min(c.low, tick.lastPrice);
    }
    c.close = tick.lastPrice;
    if (tick.tradable !== false && tick.volume !== undefined) c.volume = tick.volume;
    if (tick.oi) c.oi = tick.oi;
    this.cur = this.prior ? combine(this.prior, c) : { ...c, time: period };
    return closed ? { closed, current: { ...this.cur } } : { current: { ...this.cur } };
  }
}

/** `a` followed by `b`, as one candle stamped with `a`'s time. */
function combine(a: Candle, b: Candle): Candle {
  const c: Candle = {
    time: a.time,
    open: a.open,
    high: Math.max(a.high, b.high),
    low: Math.min(a.low, b.low),
    close: b.close,
    volume: a.volume + b.volume,
  };
  const oi = b.oi ?? a.oi;
  if (oi !== undefined) c.oi = oi;
  return c;
}
