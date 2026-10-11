import { istStartOfDay, MINUTE_MS } from './time';

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
 * minutes, anchored to the exchange's session open on that IST day. A `day`
 * bar starts at 00:00 IST, which is how Kite stamps daily candles.
 */
export function bucketStart(exchange: string, epochMs: number, barMinutes: number | 'day'): number {
  if (barMinutes === 'day') return istStartOfDay(epochMs);
  const open = sessionOpenOn(exchange, epochMs);
  const len = barMinutes * MINUTE_MS;
  return open + Math.floor((epochMs - open) / len) * len;
}
