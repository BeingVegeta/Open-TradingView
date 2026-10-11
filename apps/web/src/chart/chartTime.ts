import { IST_OFFSET_MS, type Candle } from '@otv/shared';
import type { UTCTimestamp } from 'lightweight-charts';

/**
 * Lightweight Charts formats every timestamp as UTC. Shifting bar times by
 * +05:30 before handing them over makes the axis, tick marks (including day
 * and month boundaries) and crosshair read in IST, whatever the browser's
 * timezone. Only ever convert at this boundary.
 */
const SHIFT_S = IST_OFFSET_MS / 1000;

export const toChartTime = (epochS: number) => (epochS + SHIFT_S) as UTCTimestamp;
export const fromChartTime = (chartS: number) => chartS - SHIFT_S;

export function toChartCandle(c: Candle) {
  return { time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close };
}
