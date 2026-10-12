export type TickMode = 'ltp' | 'quote' | 'full';

export interface DepthLevel {
  price: number;
  quantity: number;
  orders: number;
}

/**
 * One Kite ticker packet, normalised. Prices are in rupees (already divided).
 * Ticks are throttled snapshots, not individual trades. `volume` is the
 * cumulative day volume, so a candle's volume is a difference of these.
 */
export interface Tick {
  token: number;
  mode: TickMode;
  /** False for indices (no trades, no volume). */
  tradable: boolean;
  lastPrice: number;
  lastQuantity?: number;
  averagePrice?: number;
  /** Cumulative volume traded today. */
  volume?: number;
  buyQuantity?: number;
  sellQuantity?: number;
  /** Day OHLC; `close` is the previous session's close. */
  ohlc?: { open: number; high: number; low: number; close: number };
  /** Percent change vs previous close. */
  change?: number;
  /** Epoch seconds of the last trade (full mode, tradables only). */
  lastTradeTime?: number;
  /** Epoch seconds of the exchange snapshot (full mode). */
  exchangeTime?: number;
  oi?: number;
  oiDayHigh?: number;
  oiDayLow?: number;
  depth?: { buy: DepthLevel[]; sell: DepthLevel[] };
  /** Epoch ms when the server received the frame. */
  receivedAt: number;
}

const MODE_RANK: Record<TickMode, number> = { ltp: 0, quote: 1, full: 2 };

/** The richer of two subscription modes. */
export function maxMode(a: TickMode, b: TickMode): TickMode {
  return MODE_RANK[a] >= MODE_RANK[b] ? a : b;
}

/**
 * The time a tick's price belongs to, in epoch seconds: the last trade time if
 * known (trades define candles), else the exchange snapshot time, else arrival.
 */
export function tickTime(t: Pick<Tick, 'lastTradeTime' | 'exchangeTime' | 'receivedAt'>): number {
  return t.lastTradeTime ?? t.exchangeTime ?? Math.floor(t.receivedAt / 1000);
}
