import type { Instrument } from './market';
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

/** NSE/BSE stocks in the F&O segment: continuous trading ends when the closing auction starts. */
const AUCTION_STOCK_SESSION: ExchangeSession = { open: 9 * 60 + 15, close: 15 * 60 + 15 };
const NSE_DERIVATIVES_SESSION: ExchangeSession = { open: 9 * 60 + 15, close: 15 * 60 + 40 };

/** SEBI's closing auction session for F&O stocks, in IST minutes: 15:15–15:35. */
export const CLOSING_AUCTION = { start: 15 * 60 + 15, end: 15 * 60 + 35 } as const;

/**
 * When candles are made for an instrument: the continuous-trading session that
 * Kite's historical candles cover.
 *
 * - NSE/BSE stocks with futures (F&O stocks): 09:15–15:15. The closing auction
 *   session (15:15–15:35) makes no candles; its volume is in the day total.
 *   Seen in Kite data (Oct 2026); the times are from exchange notices.
 * - Other NSE/BSE stocks: 09:15–15:30 (the auction covers F&O stocks only)
 * - Indices: 09:15–15:30
 * - NFO/BFO futures and options: 09:15–15:40 (checked on futures)
 * - MCX: 09:00–23:30 (23:55 in winter; the later time is used as the bound)
 * - Currency: 09:00–17:00
 *
 * The open (candle anchor) is the same as `exchangeSession`. The live candle
 * service also extends the close when an instrument's previous day ran later
 * (see `extendSessionTo`).
 */
export function regularSession(
  exchange: string,
  segment?: string,
  opts: { closingAuction?: boolean } = {},
): ExchangeSession {
  if (segment === 'INDICES') return NSE_SESSION;
  switch (exchange) {
    case 'NSE':
    case 'BSE':
      return opts.closingAuction ? AUCTION_STOCK_SESSION : NSE_SESSION;
    case 'NFO':
    case 'BFO':
      return NSE_DERIVATIVES_SESSION;
    default:
      return exchangeSession(exchange);
  }
}

/** An instrument's session (see `regularSession`). */
export function instrumentSession(
  inst: Pick<Instrument, 'exchange' | 'segment' | 'closingAuction'>,
): ExchangeSession {
  return regularSession(inst.exchange, inst.segment, { closingAuction: !!inst.closingAuction });
}

export type MarketPhase = 'pre-open' | 'open' | 'closing-auction' | 'closed';

/**
 * Phase of an instrument's market at a moment: its own session (F&O until
 * 15:40, MCX into the evening), the closing auction for F&O stocks, and the 15
 * minutes before the open. Weekends are closed; holidays aren't known.
 */
export function instrumentPhase(
  inst: Pick<Instrument, 'exchange' | 'segment' | 'closingAuction'>,
  epochMs: number,
): MarketPhase {
  const day = istStartOfDay(epochMs);
  const weekday = toIstParts(day).weekday;
  if (weekday === 0 || weekday === 6) return 'closed';
  const s = instrumentSession(inst);
  const m = (epochMs - day) / MINUTE_MS;
  if (m >= s.open && m < s.close) return 'open';
  if (m >= s.open - 15 && m < s.open) return 'pre-open';
  if (inst.closingAuction && m >= CLOSING_AUCTION.start && m < CLOSING_AUCTION.end)
    return 'closing-auction';
  return 'closed';
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
