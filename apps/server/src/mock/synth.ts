import {
  DAY_MS,
  exchangeSession,
  istStartOfDay,
  MINUTE_MS,
  toIstParts,
  type Candle,
} from '@otv/shared';
import { gauss, rand01, walkNoise } from './random';

export interface SynthSpec {
  seed: number;
  exchange: string;
  basePrice: number;
  /** Typical daily move as a fraction (0.015 = 1.5%). */
  dailyVol: number;
  /** Mean volume per minute; 0 for indices. */
  volumePerMinute: number;
  /** Open interest level for derivatives, else 0. */
  oiBase: number;
  tickSize: number;
  /** Epoch ms of the first trading day (00:00 IST). */
  listedOn: number;
  /** Epoch ms after which there is no data (expiry), or Infinity. */
  delistedAfter: number;
}

/** Fixed (month, day) market holidays used every year in mock mode. */
const MOCK_HOLIDAYS = new Set([
  '1-26',
  '3-14',
  '4-14',
  '5-1',
  '8-15',
  '10-2',
  '11-9',
  '11-10',
  '12-25',
]);

export function isMockTradingDay(dayStartMs: number): boolean {
  const p = toIstParts(dayStartMs);
  if (p.weekday === 0 || p.weekday === 6) return false;
  return !MOCK_HOLIDAYS.has(`${p.month}-${p.day}`);
}

const EPOCH_DAY0 = Date.UTC(2000, 0, 1) - 330 * 60_000;
export const dayIndex = (dayStartMs: number) => Math.round((dayStartMs - EPOCH_DAY0) / DAY_MS);

function level(spec: SynthSpec, day: number): number {
  return spec.basePrice * Math.exp(spec.dailyVol * 0.55 * walkNoise(spec.seed, day));
}

function roundTick(p: number, tick: number): number {
  return Math.round(Math.round(p / tick) * tick * 1e6) / 1e6;
}

interface DayPath {
  /** Minute boundary prices, length = minutes + 1. */
  px: Float64Array;
  minutes: number;
}

const pathCache = new Map<string, DayPath>();
const PATH_CACHE_MAX = 5000;

/** The intraday price path for a trading day: a Brownian bridge from the open to the close. */
function dayPath(spec: SynthSpec, dayStartMs: number): DayPath {
  const ck = `${spec.seed}:${dayStartMs}`;
  const hit = pathCache.get(ck);
  if (hit) return hit;
  const sess = exchangeSession(spec.exchange);
  const n = sess.close - sess.open;
  const d = dayIndex(dayStartMs);
  const close = level(spec, d);
  const open = level(spec, d - 1) * (1 + gauss(spec.seed, d, 77) * spec.dailyVol * 0.25);
  const sigma = (close * spec.dailyVol * 0.8) / Math.sqrt(n);
  const w = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) w[i] = w[i - 1]! + gauss(spec.seed, d, i);
  const px = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    px[i] = open + (close - open) * t + (w[i]! - t * w[n]!) * sigma;
  }
  const path = { px, minutes: n };
  if (pathCache.size >= PATH_CACHE_MAX) pathCache.delete(pathCache.keys().next().value!);
  pathCache.set(ck, path);
  return path;
}

const daySummaryCache = new Map<string, Candle>();

/**
 * Daily candles in [fromMs, toMs), equal to aggregating that day's minute
 * candles (cached per completed day, so long daily ranges stay fast).
 */
export function dayCandles(spec: SynthSpec, fromMs: number, toMs: number, nowMs: number): Candle[] {
  const out: Candle[] = [];
  const today = istStartOfDay(nowMs);
  const end = Math.min(toMs, nowMs + 1, spec.delistedAfter);
  for (let day = istStartOfDay(Math.max(fromMs, spec.listedOn)); day < end; day += DAY_MS) {
    if (day < fromMs || !isMockTradingDay(day)) continue;
    const ck = `${spec.seed}:${day}`;
    let c = day < today ? daySummaryCache.get(ck) : undefined;
    if (!c) {
      const mins = minuteCandles(spec, day, day + DAY_MS, nowMs);
      if (!mins.length) continue;
      c = {
        time: day / 1000,
        open: mins[0]!.open,
        high: -Infinity,
        low: Infinity,
        close: mins.at(-1)!.close,
        volume: 0,
      };
      for (const m of mins) {
        if (m.high > c.high) c.high = m.high;
        if (m.low < c.low) c.low = m.low;
        c.volume += m.volume;
      }
      if (mins.at(-1)!.oi !== undefined) c.oi = mins.at(-1)!.oi!;
      if (day < today) {
        if (daySummaryCache.size > 200_000) daySummaryCache.clear();
        daySummaryCache.set(ck, c);
      }
    }
    out.push({ ...c });
  }
  return out;
}

/** Shares matched in the 09:00–09:08 pre-open auction (NSE/BSE cash market only). */
export function preOpenVolume(spec: SynthSpec, dayIndexOrStart: number): number {
  if (spec.volumePerMinute <= 0 || (spec.exchange !== 'NSE' && spec.exchange !== 'BSE')) return 0;
  const d = dayIndexOrStart > 1e9 ? dayIndex(dayIndexOrStart) : dayIndexOrStart;
  return Math.round(spec.volumePerMinute * 6 * (0.5 + rand01(spec.seed, d, 4242)));
}

/** One-minute candles in [fromMs, toMs), excluding minutes that start after `nowMs`. */
export function minuteCandles(
  spec: SynthSpec,
  fromMs: number,
  toMs: number,
  nowMs: number,
): Candle[] {
  const out: Candle[] = [];
  const end = Math.min(toMs, nowMs + 1, spec.delistedAfter);
  const sess = exchangeSession(spec.exchange);
  for (let day = istStartOfDay(Math.max(fromMs, spec.listedOn)); day < end; day += DAY_MS) {
    if (!isMockTradingDay(day)) continue;
    const { px, minutes } = dayPath(spec, day);
    const d = dayIndex(day);
    const sessOpen = day + sess.open * MINUTE_MS;
    const sigma = Math.abs(px[minutes]! * spec.dailyVol) / Math.sqrt(minutes);
    for (let i = 0; i < minutes; i++) {
      const t = sessOpen + i * MINUTE_MS;
      if (t < fromMs) continue;
      if (t >= end) break;
      const o = roundTick(px[i]!, spec.tickSize);
      const c = roundTick(px[i + 1]!, spec.tickSize);
      const h = roundTick(
        Math.max(o, c) + Math.abs(gauss(spec.seed, d, i, 5)) * sigma * 0.4,
        spec.tickSize,
      );
      const l = roundTick(
        Math.min(o, c) - Math.abs(gauss(spec.seed, d, i, 6)) * sigma * 0.4,
        spec.tickSize,
      );
      const x = i / minutes;
      const shape = 0.6 + 3 * (x - 0.5) ** 2 * 2;
      const volume =
        spec.volumePerMinute > 0
          ? Math.round(spec.volumePerMinute * shape * Math.exp(0.6 * gauss(spec.seed, d, i, 9)))
          : 0;
      // Kite folds the pre-open auction volume into the day's first candle (assumed; verify live).
      const v = i === 0 ? volume + preOpenVolume(spec, d) : volume;
      const candle: Candle = { time: t / 1000, open: o, high: h, low: l, close: c, volume: v };
      if (spec.oiBase > 0) {
        candle.oi = Math.round(
          spec.oiBase *
            (1 + 0.04 * walkNoise(spec.seed + 13, d + x) + 0.01 * rand01(spec.seed, d, i)),
        );
      }
      out.push(candle);
    }
  }
  return out;
}
