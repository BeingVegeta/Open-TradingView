import type { BarLength } from './timeframes';
import { DAY_MS, istStartOfDay, istToEpoch, MINUTE_MS, toIstParts } from './time';

/**
 * Regular trading session per exchange, in IST minutes after midnight.
 * Intraday candles are anchored to the session open, not to the clock hour:
 * NSE 60-minute candles start 09:15, 10:15, … .
 *
 * MCX's close moves between 23:30 and 23:55 with US daylight saving; the later
 * time is used as the outer bound. Anchoring (09:00) is unaffected.
 */
export interface ExchangeSession {
  open: number;
  close: number;
}

const NSE_SESSION: ExchangeSession = { open: 9 * 60 + 15, close: 15 * 60 + 30 };
const CURRENCY_SESSION: ExchangeSession = { open: 9 * 60, close: 17 * 60 };
const MCX_SESSION: ExchangeSession = { open: 9 * 60, close: 23 * 60 + 55 };

export function exchangeSession(exchange: string): ExchangeSession {
  switch (exchange) {
    case 'CDS':
    case 'BCD':
      return CURRENCY_SESSION;
    case 'MCX':
    case 'NCO':
      return MCX_SESSION;
    default:
      // NSE, BSE, NFO, BFO and their indices.
      return NSE_SESSION;
  }
}

const NSE_CASH_SESSION: ExchangeSession = { open: 9 * 60 + 15, close: 15 * 60 + 15 };
const NSE_DERIVATIVES_SESSION: ExchangeSession = { open: 9 * 60 + 15, close: 15 * 60 + 40 };

/**
 * When candles are made for an instrument: the continuous-trading session that
 * Kite's historical candles cover. Verified against Kite data (Oct 2026):
 *
 * - NSE/BSE stocks: 09:15–15:15 (continuous trading ends at 15:15; the closing
 *   auction until 15:30 produces no candles, but its volume is in the day total)
 * - Indices: 09:15–15:30
 * - NFO/BFO futures and options: 09:15–15:40 (checked on futures)
 * - MCX: 09:00–23:30 (23:55 in winter; the later time is used as the bound)
 * - Currency: 09:00–17:00
 *
 * The open (candle anchor) is the same as `exchangeSession`. The live candle
 * service extends the close when an instrument's previous day ran later (see
 * `extendSessionTo`), e.g. a stock outside the closing auction session.
 */
export function regularSession(exchange: string, segment?: string): ExchangeSession {
  if (segment === 'INDICES') return NSE_SESSION;
  switch (exchange) {
    case 'NSE':
    case 'BSE':
      return NSE_CASH_SESSION;
    case 'NFO':
    case 'BFO':
      return NSE_DERIVATIVES_SESSION;
    default:
      return exchangeSession(exchange);
  }
}

/** Upper bound of regular-session minutes per trading day. */
export function sessionMinutes(exchange: string): number {
  const s = exchangeSession(exchange);
  return s.close - s.open;
}

/** Epoch ms of the session open on the IST day containing `epochMs`. */
export function sessionOpenOn(exchange: string, epochMs: number): number {
  return istStartOfDay(epochMs) + exchangeSession(exchange).open * MINUTE_MS;
}

/**
 * Start (epoch ms) of the candle that contains `epochMs`, for a bar length in
 * minutes, anchored to the exchange's session open on that IST day. Calendar
 * bars start at 00:00 IST (how Kite stamps daily candles): `day` on the day,
 * `week` on its Monday, `month` on its 1st.
 */
export function bucketStart(exchange: string, epochMs: number, bar: BarLength): number {
  if (bar === 'day') return istStartOfDay(epochMs);
  if (bar === 'week') {
    const day = istStartOfDay(epochMs);
    return day - ((toIstParts(day).weekday + 6) % 7) * DAY_MS;
  }
  if (bar === 'month') {
    const p = toIstParts(epochMs);
    return istToEpoch(p.year, p.month, 1);
  }
  const open = sessionOpenOn(exchange, epochMs);
  const len = bar * MINUTE_MS;
  return open + Math.floor((epochMs - open) / len) * len;
}

/**
 * A session extended to cover a day whose last 1-minute candle started at
 * `lastCandleS` (rounded up to 5 minutes), by at most 30 minutes. It never
 * shortens the session: an illiquid instrument's last trade can be well before
 * the close.
 */
export function extendSessionTo(
  session: ExchangeSession,
  lastCandleS: number | undefined,
): ExchangeSession {
  if (lastCandleS === undefined) return session;
  const endMin = (lastCandleS * 1000 + MINUTE_MS - istStartOfDay(lastCandleS * 1000)) / MINUTE_MS;
  const close = Math.ceil(endMin / 5) * 5;
  return close > session.close && close <= session.close + 30 ? { ...session, close } : session;
}
