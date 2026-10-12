/** Kite's native historical intervals. */
export type KiteInterval =
  'minute' | '3minute' | '5minute' | '10minute' | '15minute' | '30minute' | '60minute' | 'day';

export type TimeframeId =
  '1m' | '3m' | '5m' | '10m' | '15m' | '30m' | '1h' | '2h' | '4h' | '1D' | '1W' | '1M';

/** Bar length in minutes, or a calendar period. */
export type BarLength = number | 'day' | 'week' | 'month';

export interface Timeframe {
  id: TimeframeId;
  label: string;
  /** The Kite interval fetched: the timeframe itself, or its source if aggregated. */
  interval: KiteInterval;
  bar: BarLength;
  /**
   * True if Kite has no such interval and bars are built on the server by
   * aggregating `interval` candles (2h and 4h from 60-minute, week and month
   * from daily).
   */
  aggregated: boolean;
}

const native = (id: TimeframeId, label: string, interval: KiteInterval, bar: BarLength) =>
  ({ id, label, interval, bar, aggregated: false }) as const;
const derived = (id: TimeframeId, label: string, interval: KiteInterval, bar: BarLength) =>
  ({ id, label, interval, bar, aggregated: true }) as const;

export const TIMEFRAMES: readonly Timeframe[] = [
  native('1m', '1m', 'minute', 1),
  native('3m', '3m', '3minute', 3),
  native('5m', '5m', '5minute', 5),
  native('10m', '10m', '10minute', 10),
  native('15m', '15m', '15minute', 15),
  native('30m', '30m', '30minute', 30),
  native('1h', '1h', '60minute', 60),
  derived('2h', '2h', '60minute', 120),
  derived('4h', '4h', '60minute', 240),
  native('1D', 'D', 'day', 'day'),
  derived('1W', 'W', 'day', 'week'),
  derived('1M', 'M', 'day', 'month'),
];

const BY_ID = new Map(TIMEFRAMES.map((t) => [t.id, t]));

export function getTimeframe(id: string): Timeframe | undefined {
  return BY_ID.get(id as TimeframeId);
}

/** The native timeframe an aggregated one is built from (itself if native). */
export function sourceTimeframe(tf: Timeframe): Timeframe {
  return tf.aggregated ? TIMEFRAMES.find((t) => !t.aggregated && t.interval === tf.interval)! : tf;
}

/** Whether bars are whole calendar periods (stamped 00:00 IST) rather than intraday. */
export function isPeriodBar(bar: BarLength): bar is 'day' | 'week' | 'month' {
  return typeof bar !== 'number';
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
