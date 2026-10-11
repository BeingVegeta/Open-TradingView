import type { Candle } from './market';
import { bucketStart, exchangeSession } from './sessions';
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
 *   never create or change intraday bars. Pre-open volume does count towards
 *   the first bar, because cumulative day volume already includes it.
 * - Volume is cumulative-day-volume(now) − cumulative-day-volume(at bar start),
 *   never a sum of ticks.
 * - A tick whose trade time is older than the forming bar (no new trade) is ignored.
 * - Day bars come straight from the exchange's day OHLC when the tick has it.
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

  constructor(
    readonly exchange: string,
    /** Bar length in minutes, or 'day'. */
    readonly bar: number | 'day',
  ) {}

  get current(): Candle | null {
    return this.cur ? { ...this.cur } : null;
  }

  /** Bar start (epoch s) containing `epochS`. */
  bucket(epochS: number): number {
    return bucketStart(this.exchange, epochS * 1000, this.bar) / 1000;
  }

  /** Whether a time falls inside the regular session (always true for day bars). */
  inSession(epochS: number): boolean {
    if (this.bar === 'day') return true;
    const s = exchangeSession(this.exchange);
    const minutes = (epochS * 1000 - istStartOfDay(epochS * 1000)) / MINUTE_MS;
    return minutes >= s.open && minutes < s.close;
  }

  /**
   * Starts from history: the newest candle Kite returned becomes the forming
   * bar if ticks continue in it. Call before ticks, and again after a reconcile.
   */
  seed(last: Candle | undefined): void {
    if (!last) return;
    if (this.cur && this.cur.time > last.time) return; // already past it
    const sameBar = this.cur?.time === last.time;
    this.cur = { ...last };
    // Volume continuity: keep the tick-derived base if we are mid-bar and it agrees.
    if (!sameBar) this.base = null;
    else if (this.lastCum !== null) this.base = this.lastCum - last.volume;
  }

  apply(tick: BuilderTick): BuilderResult | null {
    const t = tickTime(tick);
    const price = tick.lastPrice;
    if (!(price > 0)) return null;
    if (this.bar === 'day') return this.applyDay(tick, t);

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
    const sessionOpen = day / 1000 + exchangeSession(this.exchange).open * 60;
    // The day's first bar includes the pre-open auction volume: start from zero.
    if (b === sessionOpen) return 0;
    // Otherwise everything up to the previous tick belonged to earlier bars.
    if (this.lastCum !== null && this.lastCumDay === day) return this.lastCum;
    // No earlier tick today (e.g. connected mid-session): only this tick's trade is ours.
    return Math.max(0, cum - (lastQty ?? 0));
  }

  private noteCum(cum: number, t: number): void {
    this.lastCum = cum;
    this.lastCumDay = istStartOfDay(t * 1000);
  }

  private applyDay(tick: BuilderTick, t: number): BuilderResult {
    const day = istStartOfDay(t * 1000) / 1000;
    let closed: Candle | undefined;
    if (this.cur && day > this.cur.time) closed = { ...this.cur };
    if (!this.cur || day > this.cur.time) {
      this.cur = {
        time: day,
        open: tick.lastPrice,
        high: tick.lastPrice,
        low: tick.lastPrice,
        close: tick.lastPrice,
        volume: 0,
      };
    }
    const c = this.cur;
    if (day < c.time) return { current: { ...c } };
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
    return closed ? { closed, current: { ...c } } : { current: { ...c } };
  }
}

/** Phase of an exchange's regular session at a moment (weekends closed; holidays unknown). */
export function marketPhase(exchange: string, epochMs: number): 'open' | 'pre-open' | 'closed' {
  const day = istStartOfDay(epochMs);
  const weekday = new Date(day + 330 * 60_000).getUTCDay();
  if (weekday === 0 || weekday === 6) return 'closed';
  const s = exchangeSession(exchange);
  const m = (epochMs - day) / MINUTE_MS;
  if (m >= s.open && m < s.close) return 'open';
  if (m >= s.open - 15 && m < s.open) return 'pre-open';
  return 'closed';
}
