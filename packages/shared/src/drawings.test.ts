import { describe, expect, it } from 'vitest';
import { aggregateCandles } from './aggregate';
import { countBarStarts, stepBars, type BarGrid } from './barGrid';
import { sanitizeDrawings, TimeMapper } from './drawings';
import type { Candle } from './market';
import { regularSession } from './sessions';
import { formatIstDateTime, istToEpoch } from './time';
import type { BarLength } from './timeframes';

/** NSE F&O stock session (09:15–15:15). */
const session = regularSession('NSE', 'NSE', { closingAuction: true });
const grid = (bar: BarLength): BarGrid => ({ bar, session });
const at = (m: number, d: number, h = 0, mi = 0) => istToEpoch(2026, m, d, h, mi) / 1000;
const fmt = (s: number) => formatIstDateTime(s * 1000).slice(0, 16);

/** Every 1-minute candle on weekdays from Mon 3 Aug to Fri 13 Nov 2026 (no holidays). */
function minutes(): Candle[] {
  const out: Candle[] = [];
  for (let t = at(8, 3); t < at(11, 14); t += 86_400) {
    const w = new Date((t + 19_800) * 1000).getUTCDay();
    if (w === 0 || w === 6) continue;
    for (let m = 9 * 60 + 15; m < 15 * 60 + 15; m++) {
      const time = t + m * 60;
      out.push({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    }
  }
  return out;
}
const ONE_MINUTE = minutes();
/** Daily candles on weekdays from 2021 to 13 Nov 2026, for weeks and months. */
function days(): Candle[] {
  const out: Candle[] = [];
  for (let t = at(1, 4) - 5 * 365 * 86_400; t < at(11, 14); t += 86_400) {
    const w = new Date((t + 19_800) * 1000).getUTCDay();
    if (w !== 0 && w !== 6) out.push({ time: t, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  }
  return out;
}
const DAYS = days();
const series = (bar: BarLength) =>
  bar === 'week' || bar === 'month'
    ? aggregateCandles(DAYS, 'NSE', bar)
    : aggregateCandles(ONE_MINUTE, 'NSE', bar);

describe('TimeMapper: drawings across timeframes', () => {
  // A trend line drawn on a 15-minute chart: Mon 5 Oct 11:45 → Thu 8 Oct 14:30.
  const a = at(10, 5, 11, 45);
  const b = at(10, 8, 14, 30);

  const cases: [string, BarLength, string, string][] = [
    ['15m', 15, '2026-10-05 11:45', '2026-10-08 14:30'],
    ['1h', 60, '2026-10-05 11:15', '2026-10-08 14:15'],
    ['4h', 240, '2026-10-05 09:15', '2026-10-08 13:15'],
    ['D', 'day', '2026-10-05 00:00', '2026-10-08 00:00'],
    ['W', 'week', '2026-10-05 00:00', '2026-10-05 00:00'],
    ['M', 'month', '2026-10-01 00:00', '2026-10-01 00:00'],
  ];
  for (const [name, bar, wantA, wantB] of cases) {
    it(`puts 15m endpoints on the containing ${name} bar`, () => {
      const candles = series(bar);
      const m = new TimeMapper(candles, grid(bar));
      const la = m.toLogical(a)!;
      const lb = m.toLogical(b)!;
      expect(Number.isInteger(la) && Number.isInteger(lb)).toBe(true);
      expect(fmt(candles[la]!.time)).toBe(wantA);
      expect(fmt(candles[lb]!.time)).toBe(wantB);
      expect(fmt(m.toTime(la)!)).toBe(wantA);
    });
  }

  for (const [name, bar] of [
    ['15m', 15],
    ['1h', 60],
    ['4h', 240],
    ['D', 'day'],
    ['W', 'week'],
    ['M', 'month'],
  ] as const) {
    it(`places ${name} endpoints before the loaded history and in the future`, () => {
      const all = series(bar);
      // Load only the middle of the history: drop the oldest and newest bars.
      const cut = Math.max(2, Math.floor(all.length / 4));
      const loaded = all.slice(cut, all.length - cut);
      const m = new TimeMapper(loaded, grid(bar));
      const old = all[1]!.time + 1; // inside the second-oldest bar, which isn't loaded
      const future = all[all.length - 2]!.time + 1;
      // Counted over trading sessions, the positions are exactly where the bars will be.
      expect(m.toLogical(old)).toBe(1 - cut);
      expect(m.toLogical(future)).toBe(all.length - 2 - cut);
      expect(m.toTime(1 - cut)).toBe(all[1]!.time);
      expect(m.toTime(all.length - 2 - cut)).toBe(all[all.length - 2]!.time);
    });
  }

  it('lands a point inside a night or weekend gap on the last bar before it', () => {
    const candles = series(60);
    const m = new TimeMapper(candles, grid(60));
    const sat = at(10, 10, 12, 0);
    expect(fmt(candles[m.toLogical(sat)!]!.time)).toBe('2026-10-09 14:15');
  });

  it('counts and steps bars over sessions', () => {
    const g = grid(60);
    // Fri 14:15 → next bar is Mon 09:15; six hourly bars a day (09:15 … 14:15).
    expect(fmt(stepBars(g, at(10, 9, 14, 15), 1))).toBe('2026-10-12 09:15');
    expect(fmt(stepBars(g, at(10, 12, 9, 15), -1))).toBe('2026-10-09 14:15');
    expect(countBarStarts(g, at(10, 9), at(10, 13))).toBe(12);
    expect(fmt(stepBars(grid('month'), at(10, 1), -10))).toBe('2025-12-01 00:00');
  });

  it('has no positions without bars', () => {
    expect(new TimeMapper([], grid(5)).toLogical(5)).toBeNull();
  });
});

describe('sanitizeDrawings', () => {
  it('keeps valid drawings and drops the rest', () => {
    const ok = { id: 'a', type: 'hline', price: 10, color: '#aabbcc' };
    expect(sanitizeDrawings([ok, { ...ok, color: 'red' }, { ...ok, type: 'x' }, null])).toEqual([
      ok,
    ]);
    expect(sanitizeDrawings('nope')).toEqual([]);
  });
});
