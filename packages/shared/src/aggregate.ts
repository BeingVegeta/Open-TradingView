import type { Candle } from './market';
import { bucketStart } from './sessions';

/**
 * Rolls finer candles (ascending by time) up into coarser session-anchored
 * candles. Volume is summed (each input candle's volume is already a delta),
 * OI is taken from the last input candle of each bucket.
 */
export function aggregateCandles(
  candles: readonly Candle[],
  exchange: string,
  bar: number | 'day',
): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | undefined;
  for (const c of candles) {
    const start = bucketStart(exchange, c.time * 1000, bar) / 1000;
    if (!cur || cur.time !== start) {
      cur = {
        time: start,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      };
      if (c.oi !== undefined) cur.oi = c.oi;
      out.push(cur);
      continue;
    }
    if (c.high > cur.high) cur.high = c.high;
    if (c.low < cur.low) cur.low = c.low;
    cur.close = c.close;
    cur.volume += c.volume;
    if (c.oi !== undefined) cur.oi = c.oi;
  }
  return out;
}

/** Parses Kite's `2017-12-15T09:15:00+0530` timestamps to epoch seconds without relying on Date.parse quirks. */
export function parseKiteTimestamp(ts: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:([+-])(\d{2}):?(\d{2}))?$/.exec(
    ts,
  );
  if (!m) throw new Error(`Unrecognised Kite timestamp: ${ts}`);
  const [, y, mo, d, h, mi, s, sign, oh, om] = m;
  const utc = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!) / 1000;
  // Kite stamps everything in IST; assume +05:30 if the offset is missing.
  const offsetMin = sign ? (sign === '-' ? -1 : 1) * (+oh! * 60 + +om!) : 330;
  return utc - offsetMin * 60;
}
