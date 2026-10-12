import type { Quote, Tick } from '@otv/shared';

/** Turns a tick into the quote fields the UI shows (depth only for 'full'). */
export function tickToQuote(key: string, t: Tick, detail: 'quote' | 'full'): Quote {
  const q: Quote = { key, lastPrice: t.lastPrice };
  if (t.ohlc) {
    q.open = t.ohlc.open;
    q.high = t.ohlc.high;
    q.low = t.ohlc.low;
    if (t.ohlc.close > 0) {
      q.prevClose = t.ohlc.close;
      q.change = t.lastPrice - t.ohlc.close;
      q.changePct = (q.change / t.ohlc.close) * 100;
    }
  }
  if (t.volume !== undefined) q.volume = t.volume;
  if (t.averagePrice !== undefined) q.averagePrice = t.averagePrice;
  if (t.lastTradeTime !== undefined) q.lastTradeTime = t.lastTradeTime;
  if (detail === 'full') {
    if (t.buyQuantity !== undefined) q.buyQuantity = t.buyQuantity;
    if (t.sellQuantity !== undefined) q.sellQuantity = t.sellQuantity;
    if (t.lastQuantity !== undefined) q.lastQuantity = t.lastQuantity;
    if (t.oi) {
      q.oi = t.oi;
      if (t.oiDayHigh) q.oiDayHigh = t.oiDayHigh;
      if (t.oiDayLow) q.oiDayLow = t.oiDayLow;
    }
    if (t.depth) q.depth = t.depth;
  }
  return q;
}
