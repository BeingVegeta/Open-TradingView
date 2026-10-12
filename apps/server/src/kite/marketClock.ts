import { DAY_MS, istStartOfDay, MINUTE_MS } from '@otv/shared';
import { systemClock, type Clock } from './clock';

/**
 * Clock for market-data components. In live mode it is the system clock. In
 * mock or replay mode it can start at another moment (e.g. "as if the market is
 * open" on a Sunday) and run faster than real time; timers scale with it.
 */
export class MarketClock implements Clock {
  private readonly realStart = Date.now();

  constructor(
    private readonly startAt: number = Date.now(),
    readonly speed = 1,
  ) {}

  now(): number {
    return this.startAt + (Date.now() - this.realStart) * this.speed;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    return systemClock.setTimeout(fn, Math.max(0, ms / this.speed));
  }

  clearTimeout(handle: unknown): void {
    systemClock.clearTimeout(handle);
  }
}

/** Parses `YYYY-MM-DD HH:MM[:SS]` as IST. */
export function parseIst(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0)) - 330 * MINUTE_MS;
}

/**
 * Start time for "as if the market is open": now if NSE is in session on a
 * trading day, else 11:00 IST on the most recent trading day.
 */
export function marketOpenStart(
  now: number,
  isTradingDay: (dayStartMs: number) => boolean,
): number {
  const today = istStartOfDay(now);
  const minutes = (now - today) / MINUTE_MS;
  if (isTradingDay(today) && minutes >= 9 * 60 + 15 && minutes < 15 * 60 + 30) return now;
  let day = minutes >= 15 * 60 + 30 ? today : today - DAY_MS;
  while (!isTradingDay(day)) day -= DAY_MS;
  return day + 11 * 60 * MINUTE_MS;
}
