import { describe, expect, it } from 'vitest';
import { bollinger, ema, macd, rsi, sma, vwap } from './indicators';
import type { Candle } from './market';
import { istToEpoch } from './time';

const close = (s: (number | null)[], digits = 2) =>
  s.map((v) => (v === null ? null : Number(v.toFixed(digits))));

/** Straightforward reference EMA (seeded with the SMA of the first n values). */
function refEma(v: number[], n: number): (number | null)[] {
  const out: (number | null)[] = v.map(() => null);
  let prev = v.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < v.length; i++) {
    prev = (v[i]! - prev) * (2 / (n + 1)) + prev;
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI worked example (as published by StockCharts): 14-period RSI on these closes.
const RSI_CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
  46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
];

const walk = Array.from({ length: 120 }, (_, i) => 100 + 10 * Math.sin(i / 7) + (i % 5) - 2);

describe('indicators', () => {
  it('SMA', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('EMA matches a reference implementation and handles leading nulls', () => {
    expect(close(ema(walk, 20), 8)).toEqual(close(refEma(walk, 20), 8));
    expect(ema([null, null, 1, 2, 3, 4], 2)).toEqual([null, null, null, 1.5, 2.5, 3.5]);
  });

  // StockCharts' published table shows 70.53, 66.32, 66.55, 69.41, 66.36, 57.97 because it rounds the
  // intermediate averages to two decimals; computed exactly, Wilder's method gives the values below.
  it("RSI follows Wilder's smoothing (StockCharts worked example, unrounded)", () => {
    const r = rsi(RSI_CLOSES, 14);
    expect(r.slice(0, 14).every((v) => v === null)).toBe(true);
    expect(close(r.slice(14))).toEqual([70.46, 66.25, 66.48, 69.35, 66.29, 57.92]);
  });

  it('RSI is 100 for only gains and 50 for a flat line', () => {
    expect(rsi([1, 2, 3, 4, 5], 3).at(-1)).toBe(100);
    expect(rsi([5, 5, 5, 5, 5], 3).at(-1)).toBe(50);
  });

  it('Bollinger Bands use the population standard deviation', () => {
    const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
    // mean 5, population sd 2
    expect(b.mid.at(-1)).toBe(5);
    expect(b.upper.at(-1)).toBe(9);
    expect(b.lower.at(-1)).toBe(1);
    expect(b.upper[6]).toBeNull();
  });

  it('MACD = EMA12 − EMA26, signal = EMA9 of MACD, histogram = difference', () => {
    const m = macd(walk);
    const e12 = refEma(walk, 12);
    const e26 = refEma(walk, 26);
    expect(m.macd[24]).toBeNull();
    expect(m.macd[25]).toBeCloseTo(e12[25]! - e26[25]!, 10);
    const line = walk.map((_, i) => (i >= 25 ? e12[i]! - e26[i]! : null));
    const sig = refEma(line.slice(25) as number[], 9);
    expect(m.signal[25 + 8]).toBeCloseTo(sig[8]!, 10);
    expect(m.signal[25 + 7]).toBeNull();
    expect(m.histogram.at(-1)).toBeCloseTo(m.macd.at(-1)! - m.signal.at(-1)!, 12);
  });

  it('VWAP resets each IST day and is null without volume', () => {
    const bar = (day: number, h: number, m: number, p: number, v: number): Candle => ({
      time: istToEpoch(2026, 10, day, h, m) / 1000,
      open: p,
      high: p,
      low: p,
      close: p,
      volume: v,
    });
    const v = vwap([
      bar(9, 15, 25, 100, 10),
      bar(9, 15, 29, 110, 30),
      bar(12, 9, 15, 200, 5),
      bar(12, 9, 16, 210, 5),
    ]);
    expect(v).toEqual([100, 107.5, 200, 205]);
    expect(vwap([bar(12, 9, 15, 25000, 0)])).toEqual([null]);
  });
});
