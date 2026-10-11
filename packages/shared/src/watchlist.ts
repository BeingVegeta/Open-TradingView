import type { DepthLevel } from './ticks';

export interface Watchlist {
  id: number;
  name: string;
  /** Instrument keys (EXCHANGE:TRADINGSYMBOL) in display order. */
  items: string[];
}

/** A live quote for a watchlist row or the depth panel. */
export interface Quote {
  key: string;
  lastPrice: number;
  /** Previous session close. */
  prevClose?: number;
  change?: number;
  changePct?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  averagePrice?: number;
  buyQuantity?: number;
  sellQuantity?: number;
  lastQuantity?: number;
  /** Epoch seconds. */
  lastTradeTime?: number;
  oi?: number;
  oiDayHigh?: number;
  oiDayLow?: number;
  depth?: { buy: DepthLevel[]; sell: DepthLevel[] };
}

/** Saved UI state (layout, last symbol, indicators). Opaque to the server beyond size limits. */
export type Prefs = Record<string, unknown>;
