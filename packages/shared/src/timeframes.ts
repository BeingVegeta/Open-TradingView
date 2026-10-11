/** Kite's native historical intervals. */
export type KiteInterval =
  'minute' | '3minute' | '5minute' | '10minute' | '15minute' | '30minute' | '60minute' | 'day';

export type TimeframeId = '1m' | '3m' | '5m' | '10m' | '15m' | '30m' | '1h' | '1D';

export interface Timeframe {
  id: TimeframeId;
  label: string;
  interval: KiteInterval;
  /** Bar length in minutes, or 'day'. */
  bar: number | 'day';
}

export const TIMEFRAMES: readonly Timeframe[] = [
  { id: '1m', label: '1m', interval: 'minute', bar: 1 },
  { id: '3m', label: '3m', interval: '3minute', bar: 3 },
  { id: '5m', label: '5m', interval: '5minute', bar: 5 },
  { id: '10m', label: '10m', interval: '10minute', bar: 10 },
  { id: '15m', label: '15m', interval: '15minute', bar: 15 },
  { id: '30m', label: '30m', interval: '30minute', bar: 30 },
  { id: '1h', label: '1h', interval: '60minute', bar: 60 },
  { id: '1D', label: 'D', interval: 'day', bar: 'day' },
];

const BY_ID = new Map(TIMEFRAMES.map((t) => [t.id, t]));

export function getTimeframe(id: string): Timeframe | undefined {
  return BY_ID.get(id as TimeframeId);
}

/** Bar length of each native Kite interval, in minutes or 'day'. */
export const INTERVAL_BAR: Record<KiteInterval, number | 'day'> = {
  minute: 1,
  '3minute': 3,
  '5minute': 5,
  '10minute': 10,
  '15minute': 15,
  '30minute': 30,
  '60minute': 60,
  day: 'day',
};
