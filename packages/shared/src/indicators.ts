import type { Candle } from './market';
import { istStartOfDay } from './time';

/**
 * Technical indicators over candles. Every function returns an array aligned
 * with its input (one entry per bar), `null` where the indicator isn't defined
 * yet (warm-up) — so charts can plot them against the same bar times.
 *
 * Conventions follow the common definitions (TA-Lib and most charting tools):
 * EMA seeded with the SMA of its first `n` values; RSI with Wilder's smoothing;
 * Bollinger Bands with the population standard deviation; VWAP reset at the
 * start of each IST trading day.
 */
export type Series = (number | null)[];

export const closes = (candles: readonly Candle[]) => candles.map((c) => c.close);

export function sma(values: readonly number[], n: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (n < 1) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= n) sum -= values[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** EMA over a series that may start with nulls (e.g. MACD's signal line). */
export function ema(values: readonly (number | null)[], n: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (n < 1) return out;
  const k = 2 / (n + 1);
  let start = values.findIndex((v) => v !== null);
  if (start < 0) return out;
  let prev: number | null = null;
  let seed = 0;
  for (let i = start; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) {
      // A gap restarts the warm-up.
      prev = null;
      seed = 0;
      start = i + 1;
      continue;
    }
    if (prev === null) {
      seed += v;
      if (i - start === n - 1) {
        prev = seed / n;
        out[i] = prev;
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export interface Bands {
  mid: Series;
  upper: Series;
  lower: Series;
}

export function bollinger(values: readonly number[], n = 20, mult = 2): Bands {
  const mid = sma(values, n);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i++) {
    const m = mid[i]!;
    let ss = 0;
    for (let j = i - n + 1; j <= i; j++) ss += (values[j]! - m) ** 2;
    const sd = Math.sqrt(ss / n);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}

/** Relative Strength Index with Wilder's smoothing (first average = simple mean of `n` changes). */
export function rsi(values: readonly number[], n = 14): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  const value = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[n] = value();
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = value();
  }
  return out;
}

export interface Macd {
  macd: Series;
  signal: Series;
  histogram: Series;
}

export function macd(values: readonly number[], fast = 12, slow = 26, signalN = 9): Macd {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line: Series = values.map((_, i) =>
    f[i] !== null && s[i] !== null ? f[i]! - s[i]! : null,
  );
  const signal = ema(line, signalN);
  const histogram: Series = line.map((v, i) =>
    v !== null && signal[i] !== null ? v - signal[i]! : null,
  );
  return { macd: line, signal, histogram };
}

/**
 * Session VWAP: cumulative (typical price × volume) / cumulative volume, reset
 * at 00:00 IST each day. Null where there is no volume (indices).
 */
export function vwap(candles: readonly Candle[]): Series {
  const out: Series = new Array(candles.length).fill(null);
  let day = -1;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const d = istStartOfDay(c.time * 1000);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    vol += c.volume;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}
