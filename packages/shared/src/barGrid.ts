import type { ExchangeSession } from './sessions';
import { DAY_MS, istStartOfDay, istToEpoch, toIstParts } from './time';
import type { BarLength } from './timeframes';

/**
 * Where bars of one timeframe can start for an instrument: intraday bars every
 * `bar` minutes from the session open until its close, on weekdays; day bars at
 * 00:00 IST on weekdays; week bars on Mondays; month bars on the 1st. Exchange
 * holidays aren't known, so counts across them are off by those days' bars.
 */
export interface BarGrid {
  bar: BarLength;
  session: ExchangeSession;
}

const DAY_S = DAY_MS / 1000;
const isWeekday = (dayS: number) => {
  const w = toIstParts(dayS * 1000).weekday;
  return w !== 0 && w !== 6;
};
const dayOf = (s: number) => istStartOfDay(s * 1000) / 1000;
/** Bar starts per trading day for an intraday bar length. */
const perDay = (g: BarGrid, bar: number) => Math.ceil((g.session.close - g.session.open) / bar);

/** Number of bar starts `s` with from <= s < to (epoch seconds). */
export function countBarStarts(g: BarGrid, from: number, to: number): number {
  if (to <= from) return 0;
  const bar = g.bar;
  if (bar === 'week' || bar === 'month') {
    let n = 0;
    for (let s = firstStartAtOrAfter(g, from); s < to; s = stepBars(g, s, 1)) n++;
    return n;
  }
  let n = 0;
  for (let d = dayOf(from); d < to; d += DAY_S) {
    // Days are 86,400 s in IST (no daylight saving), so stepping is exact.
    if (!isWeekday(d)) continue;
    if (bar === 'day') {
      if (d >= from) n++;
      continue;
    }
    const open = d + g.session.open * 60;
    const len = bar * 60;
    const k = perDay(g, bar);
    const lo = Math.max(0, Math.ceil((from - open) / len));
    const hi = Math.min(k, Math.ceil((to - open) / len));
    if (hi > lo) n += hi - lo;
  }
  return n;
}

/** The first bar start at or after `t`. */
export function firstStartAtOrAfter(g: BarGrid, t: number): number {
  const bar = g.bar;
  if (bar === 'month') {
    const p = toIstParts(t * 1000);
    const first = istToEpoch(p.year, p.month, 1) / 1000;
    return first >= t ? first : istToEpoch(p.year, p.month + 1, 1) / 1000;
  }
  if (bar === 'week') {
    const d = dayOf(t);
    const monday = d - ((toIstParts(d * 1000).weekday + 6) % 7) * DAY_S;
    return monday >= t ? monday : monday + 7 * DAY_S;
  }
  for (let d = dayOf(t); ; d += DAY_S) {
    if (!isWeekday(d)) continue;
    if (bar === 'day') {
      if (d >= t) return d;
      continue;
    }
    const open = d + g.session.open * 60;
    const len = bar * 60;
    const k = Math.max(0, Math.ceil((t - open) / len));
    if (k < perDay(g, bar)) return open + k * len;
  }
}

/** The bar start `k` bars after (or, for negative k, before) the bar starting at `s`. */
export function stepBars(g: BarGrid, s: number, k: number): number {
  const bar = g.bar;
  if (bar === 'month') {
    const p = toIstParts(s * 1000);
    return istToEpoch(p.year, p.month + k, 1) / 1000;
  }
  if (bar === 'week') return s + k * 7 * DAY_S;
  let cur = s;
  const dir = Math.sign(k);
  for (let i = 0; i < Math.abs(k); i++) cur = neighbour(g, cur, dir);
  return cur;
}

function neighbour(g: BarGrid, s: number, dir: number): number {
  const bar = g.bar as number | 'day';
  let d = dayOf(s);
  if (bar !== 'day') {
    const len = bar * 60;
    const open = d + g.session.open * 60;
    const k = Math.round((s - open) / len) + dir;
    if (k >= 0 && k < perDay(g, bar)) return open + k * len;
  }
  do d += dir * DAY_S;
  while (!isWeekday(d));
  if (bar === 'day') return d;
  return d + g.session.open * 60 + (dir > 0 ? 0 : (perDay(g, bar) - 1) * bar * 60);
}
