import type { Candle } from './market';
import type { BarGrid } from './barGrid';
import { countBarStarts, stepBars } from './barGrid';

/** A point on a chart: epoch seconds (any time, not only bar times) and a price. */
export interface ChartPoint {
  time: number;
  price: number;
}

/** User drawings, stored per instrument and shown on every timeframe. */
export type Drawing =
  | { id: string; type: 'hline'; price: number; color: string }
  | { id: string; type: 'trend'; a: ChartPoint; b: ChartPoint; color: string };

export type DrawingType = Drawing['type'];

export const MAX_DRAWINGS = 200;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPoint = (v: unknown): v is ChartPoint =>
  typeof v === 'object' &&
  v !== null &&
  isNum((v as ChartPoint).time) &&
  isNum((v as ChartPoint).price);
const isColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

/** Keeps only well-formed drawings (drops anything else), at most MAX_DRAWINGS. */
export function sanitizeDrawings(input: unknown): Drawing[] {
  if (!Array.isArray(input)) return [];
  const out: Drawing[] = [];
  for (const d of input as Record<string, unknown>[]) {
    if (typeof d !== 'object' || d === null) continue;
    const id = d.id;
    if (typeof id !== 'string' || !id || id.length > 40 || !isColor(d.color)) continue;
    if (d.type === 'hline' && isNum(d.price)) {
      out.push({ id, type: 'hline', price: d.price, color: d.color });
    } else if (d.type === 'trend' && isPoint(d.a) && isPoint(d.b)) {
      out.push({
        id,
        type: 'trend',
        a: { time: d.a.time, price: d.a.price },
        b: { time: d.b.time, price: d.b.price },
        color: d.color,
      });
    }
    if (out.length >= MAX_DRAWINGS) break;
  }
  return out;
}

/**
 * Places chart points (any time, from any timeframe) on a chart's bars, as
 * logical bar indexes. Inside the loaded bars a time goes to the bar that
 * contains it (an 11:45 point from a 15-minute chart lands on the 11:15 bar of
 * an hourly chart, on its week's bar on a weekly chart). Before the first or
 * after the last loaded bar, positions are counted in bars over trading
 * sessions, so a line keeps its slope across nights and weekends and lands on
 * the right bar once older history loads.
 */
export class TimeMapper {
  private cache = new Map<number, number>();
  private cacheFor = '';

  constructor(
    private readonly candles: readonly Candle[],
    private readonly grid: BarGrid,
  ) {}

  /** Logical index (whole bars) of the bar containing `t`, or null with no bars. */
  toLogical(t: number): number | null {
    const c = this.candles;
    const n = c.length;
    if (!n) return null;
    // Live updates append to the same array: drop cached positions when it changes.
    const stamp = `${n}:${c[0]!.time}:${c[n - 1]!.time}`;
    if (stamp !== this.cacheFor) {
      this.cache.clear();
      this.cacheFor = stamp;
    }
    const hit = this.cache.get(t);
    if (hit !== undefined) return hit;
    let l: number;
    if (t >= c[n - 1]!.time) {
      l = n - 1 + countBarStarts(this.grid, c[n - 1]!.time + 1, t + 1);
    } else if (t >= c[0]!.time) {
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (c[mid]!.time <= t) lo = mid;
        else hi = mid - 1;
      }
      l = lo;
    } else {
      // The bar containing t, and every bar between it and the first loaded one.
      l = -(countBarStarts(this.grid, t + 1, c[0]!.time) + 1);
    }
    if (this.cache.size > 1000) this.cache.clear();
    this.cache.set(t, l);
    return l;
  }

  /** Start time of the bar at a logical index (rounded to a whole bar). */
  toTime(logical: number): number | null {
    const c = this.candles;
    const n = c.length;
    if (!n) return null;
    const k = Math.round(logical);
    if (k >= 0 && k < n) return c[k]!.time;
    if (k >= n) return stepBars(this.grid, c[n - 1]!.time, k - (n - 1));
    return stepBars(this.grid, c[0]!.time, k);
  }
}
