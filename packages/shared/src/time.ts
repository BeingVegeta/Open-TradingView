/**
 * Indian Standard Time helpers.
 *
 * IST is a fixed UTC+05:30 offset with no daylight saving, so plain arithmetic
 * on epoch milliseconds is exact. Nothing here reads the machine's local
 * timezone: the user is not necessarily in India, and every market-time
 * decision must be made in IST.
 */

export const IST_OFFSET_MINUTES = 330;
export const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60_000;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export interface IstParts {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

/** Breaks an epoch-millisecond instant into IST calendar fields. */
export function toIstParts(epochMs: number): IstParts {
  const d = new Date(epochMs + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

/** Epoch milliseconds for an IST wall-clock time. Out-of-range fields roll over like Date.UTC. */
export function istToEpoch(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  return Date.UTC(year, month - 1, day, hour, minute, second) - IST_OFFSET_MS;
}

/** Epoch milliseconds of 00:00 IST on the IST calendar day containing `epochMs`. */
export function istStartOfDay(epochMs: number): number {
  const p = toIstParts(epochMs);
  return istToEpoch(p.year, p.month, p.day);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `yyyy-mm-dd hh:mm:ss` in IST — the format Kite's historical API expects for `from`/`to`. */
export function formatIstDateTime(epochMs: number): string {
  const p = toIstParts(epochMs);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

/** Hour of the day (IST) at which Kite invalidates every access token. */
export const KITE_TOKEN_EXPIRY_HOUR_IST = 6;

/**
 * When an access token issued at `loginMs` stops working: the first 06:00 IST
 * strictly after login. This is a schedule, not a guarantee — a `TokenException`
 * from Kite is the authoritative signal and can arrive earlier.
 */
export function nextTokenExpiry(loginMs: number): number {
  const p = toIstParts(loginMs);
  const sameDay = istToEpoch(p.year, p.month, p.day, KITE_TOKEN_EXPIRY_HOUR_IST);
  return sameDay > loginMs ? sameDay : sameDay + DAY_MS;
}
