import type { KiteInterval } from '@otv/shared';

/**
 * Maximum days per historical request, per interval. Not in Kite's docs: these
 * are the figures Zerodha staff gave on the forum, so they are overridable via
 * KITE_HISTORY_MAX_DAYS (e.g. "minute=60,day=2000"), and an InputException
 * mentioning the limit makes the chunker halve its span and retry.
 */
export const DEFAULT_RANGE_CAPS: Record<KiteInterval, number> = {
  minute: 60,
  '3minute': 100,
  '5minute': 100,
  '10minute': 100,
  '15minute': 200,
  '30minute': 200,
  '60minute': 400,
  day: 2000,
};

export type RangeCaps = Record<KiteInterval, number>;

export function parseRangeCaps(spec: string | undefined): RangeCaps {
  const caps = { ...DEFAULT_RANGE_CAPS };
  if (!spec?.trim()) return caps;
  for (const part of spec.split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if (!k || !(k in caps)) throw new Error(`KITE_HISTORY_MAX_DAYS: unknown interval "${k}"`);
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0)
      throw new Error(`KITE_HISTORY_MAX_DAYS: bad value for ${k}: "${v}"`);
    caps[k as KiteInterval] = n;
  }
  return caps;
}
