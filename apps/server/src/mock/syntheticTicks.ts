import {
  DAY_MS,
  exchangeSession,
  istStartOfDay,
  MINUTE_MS,
  type Candle,
  type DepthLevel,
  type Tick,
  type TickMode,
} from '@otv/shared';
import type { MockInstrument } from './instruments';
import { hash32, rand01 } from './random';
import { dayCandles, isMockTradingDay, minuteCandles, preOpenVolume } from './synth';

interface DayState {
  minutes: Candle[];
  /** Session volume of each minute (the first minute's pre-open share removed). */
  vols: number[];
  /** Cumulative session volume before minute i. */
  cumBefore: number[];
  highBefore: number[];
  lowBefore: number[];
  preOpen: number;
  prevClose: number;
  sessionOpen: number;
}

const PRE_OPEN_MIN = 9 * 60;
const PRE_OPEN_MATCH_MIN = 9 * 60 + 8;

function roundTick(p: number, tick: number): number {
  return Math.round(Math.round(p / tick) * tick * 1e6) / 1e6;
}

/**
 * Ticks that follow the mock history exactly: within each minute the price
 * walks from the candle's open through its high and low to its close, and the
 * cumulative day volume grows so that, sampled once a second, the ticks rebuild
 * the historical 1-minute candles precisely. Includes pre-open auction ticks
 * (NSE/BSE cash) and closing-session ticks after 15:30, which must not end up
 * in regular candles. Outside trading hours it emits frozen snapshots.
 */
export class SyntheticTicks {
  private readonly days = new Map<string, DayState>();

  constructor(private readonly universe: () => Map<number, MockInstrument>) {}

  produce(subs: Map<number, TickMode>, nowMs: number): Tick[] {
    const out: Tick[] = [];
    const u = this.universe();
    for (const [token, mode] of subs) {
      const m = u.get(token);
      if (!m) continue;
      const t = this.tickAt(m, mode, nowMs);
      if (t) out.push(t);
    }
    return out;
  }

  tickAt(m: MockInstrument, mode: TickMode, nowMs: number): Tick | null {
    const { spec, instrument } = m;
    const tradable = instrument.segment !== 'INDICES';
    const sess = exchangeSession(spec.exchange);
    let day = istStartOfDay(nowMs);
    let minuteOfDay = (nowMs - day) / MINUTE_MS;
    // Before today's activity, or on a holiday: show the last session's final state.
    const hasPreOpen = spec.exchange === 'NSE' || spec.exchange === 'BSE';
    const activityStart = hasPreOpen ? PRE_OPEN_MIN : sess.open;
    if (!isMockTradingDay(day) || minuteOfDay < activityStart) {
      do day -= DAY_MS;
      while (!isMockTradingDay(day) && day > spec.listedOn);
      minuteOfDay = 24 * 60;
    }
    if (day < spec.listedOn || day > spec.delistedAfter) return null;
    const st = this.dayState(m, day);
    if (!st) return null;
    const n = st.minutes.length;
    const nowS = Math.floor(nowMs / 1000);

    let price: number;
    let cum: number;
    let ltt: number;
    let high: number;
    let low: number;
    let oi: number | undefined;
    if (minuteOfDay < sess.open) {
      // Pre-open: orders collect until 09:08, then the equilibrium price is fixed.
      const frac = Math.min(
        1,
        Math.max(0, (minuteOfDay - PRE_OPEN_MIN) / (PRE_OPEN_MATCH_MIN - PRE_OPEN_MIN)),
      );
      price = st.minutes[0]!.open;
      cum = Math.round(st.preOpen * frac);
      ltt = Math.min(nowS, Math.floor((day + PRE_OPEN_MATCH_MIN * MINUTE_MS) / 1000));
      high = low = price;
    } else if (minuteOfDay >= sess.close) {
      // After the close (closing session trades, then frozen).
      const last = st.minutes[n - 1]!;
      price = last.close;
      const post = Math.min(20, Math.max(0, minuteOfDay - sess.close - 10));
      cum =
        st.preOpen +
        st.cumBefore[n - 1]! +
        st.vols[n - 1]! +
        Math.round(spec.volumePerMinute * 0.3 * post);
      ltt = Math.floor((day + (sess.close + 10 + post) * MINUTE_MS) / 1000);
      high = Math.max(st.highBefore[n - 1]!, last.high);
      low = Math.min(st.lowBefore[n - 1]!, last.low);
      oi = last.oi;
    } else {
      const i = Math.min(n - 1, Math.floor(minuteOfDay - sess.open));
      const c = st.minutes[i]!;
      const sec = Math.min(59, Math.floor((nowMs - c.time * 1000) / 1000));
      const path = this.minutePath(spec.seed, c);
      price = roundTick(interp(path, sec), spec.tickSize);
      const seen = path.filter(([s]) => s <= sec).map(([, p]) => p);
      cum = st.preOpen + st.cumBefore[i]! + Math.round((st.vols[i]! * (sec + 1)) / 60);
      ltt = nowS;
      high = Math.max(st.highBefore[i]!, price, ...seen);
      low = Math.min(st.lowBefore[i]!, price, ...seen);
      oi = c.oi;
    }

    const tick: Tick = {
      token: instrument.token,
      mode,
      tradable,
      lastPrice: price,
      receivedAt: nowMs,
    };
    if (mode === 'ltp') return tick;
    tick.ohlc = { open: st.minutes[0]!.open, high, low, close: st.prevClose };
    tick.change = st.prevClose ? ((price - st.prevClose) * 100) / st.prevClose : 0;
    if (!tradable) {
      if (mode === 'full') tick.exchangeTime = nowS;
      return tick;
    }
    tick.volume = cum;
    tick.lastQuantity = 1 + (hash32(spec.seed, nowS) % 50);
    tick.averagePrice = roundTick((st.minutes[0]!.open + price) / 2, spec.tickSize);
    tick.buyQuantity = 50_000 + (hash32(spec.seed, nowS, 1) % 100_000);
    tick.sellQuantity = 50_000 + (hash32(spec.seed, nowS, 2) % 100_000);
    if (mode === 'quote') return tick;
    tick.lastTradeTime = ltt;
    tick.exchangeTime = nowS;
    tick.oi = oi ?? 0;
    tick.oiDayHigh = oi ?? 0;
    tick.oiDayLow = oi ?? 0;
    tick.depth = depthAround(price, spec.tickSize, spec.seed, nowS);
    return tick;
  }

  /** Vertices (second, price) of the intra-minute path: open → high/low (hashed order) → close. */
  private minutePath(seed: number, c: Candle): [number, number][] {
    const a = 1 + (hash32(seed, c.time, 11) % 28);
    const b = 30 + (hash32(seed, c.time, 12) % 28);
    const highFirst = rand01(seed, c.time, 13) < 0.5;
    return [
      [0, c.open],
      [a, highFirst ? c.high : c.low],
      [b, highFirst ? c.low : c.high],
      [59, c.close],
    ];
  }

  private dayState(m: MockInstrument, day: number): DayState | null {
    const key = `${m.instrument.token}:${day}`;
    const hit = this.days.get(key);
    if (hit) return hit;
    const minutes = minuteCandles(m.spec, day, day + DAY_MS, Number.MAX_SAFE_INTEGER);
    if (!minutes.length) return null;
    const preOpen = preOpenVolume(m.spec, day);
    const vols = minutes.map((c, i) => (i === 0 ? c.volume - preOpen : c.volume));
    const cumBefore: number[] = [];
    const highBefore: number[] = [];
    const lowBefore: number[] = [];
    let cum = 0;
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = 0; i < minutes.length; i++) {
      cumBefore.push(cum);
      highBefore.push(hi);
      lowBefore.push(lo);
      cum += vols[i]!;
      hi = Math.max(hi, minutes[i]!.high);
      lo = Math.min(lo, minutes[i]!.low);
    }
    const prev = dayCandles(m.spec, day - 10 * DAY_MS, day, Number.MAX_SAFE_INTEGER).at(-1);
    const st: DayState = {
      minutes,
      vols,
      cumBefore,
      highBefore,
      lowBefore,
      preOpen,
      prevClose: prev?.close ?? minutes[0]!.open,
      sessionOpen: day + exchangeSession(m.spec.exchange).open * MINUTE_MS,
    };
    if (this.days.size > 500) this.days.clear();
    this.days.set(key, st);
    return st;
  }
}

function interp(path: [number, number][], s: number): number {
  for (let k = 1; k < path.length; k++) {
    const [s1, p1] = path[k]!;
    const [s0, p0] = path[k - 1]!;
    if (s <= s1) return s1 === s0 ? p1 : p0 + ((p1 - p0) * (s - s0)) / (s1 - s0);
  }
  return path.at(-1)![1];
}

function depthAround(
  price: number,
  tick: number,
  seed: number,
  t: number,
): { buy: DepthLevel[]; sell: DepthLevel[] } {
  const lvl = (side: number, i: number): DepthLevel => ({
    price: roundTick(price + side * (i + 1) * tick, tick),
    quantity: 10 + (hash32(seed, t, side + 5, i) % 2000),
    orders: 1 + (hash32(seed, t, side + 9, i) % 30),
  });
  return {
    buy: [0, 1, 2, 3, 4].map((i) => lvl(-1, i)),
    sell: [0, 1, 2, 3, 4].map((i) => lvl(1, i)),
  };
}
