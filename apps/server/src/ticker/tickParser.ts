import type { Tick, TickMode } from '@otv/shared';
import { KiteTicker } from 'kiteconnect';

/** Shape of the SDK's parsed tick (not exported by its type definitions). */
interface SdkTick {
  tradable: boolean;
  mode: TickMode;
  instrument_token: number;
  last_price: number;
  last_traded_quantity?: number;
  average_traded_price?: number;
  volume_traded?: number;
  total_buy_quantity?: number;
  total_sell_quantity?: number;
  ohlc?: { open: number; high: number; low: number; close: number };
  change?: number;
  last_trade_time?: Date | null;
  exchange_timestamp?: Date | null;
  oi?: number;
  oi_day_high?: number;
  oi_day_low?: number;
  depth?: {
    buy: { quantity: number; price: number; orders: number }[];
    sell: { quantity: number; price: number; orders: number }[];
  };
}

/**
 * The kiteconnect SDK's binary parser, used without its connection handling.
 * (KiteTicker's connection code calls process.exit() on reconnect exhaustion and
 * after disconnect(), keeps module-global state, and doesn't resubscribe; see
 * tickerConnection.ts.) Constructing a KiteTicker does not open a connection.
 */
const sdk = new KiteTicker({ api_key: 'parser-only', access_token: '' }) as unknown as {
  parseBinary(buf: ArrayBuffer): SdkTick[];
};

const secs = (d: Date | null | undefined) => (d ? Math.floor(d.getTime() / 1000) : undefined);

/** Parses one binary market-data frame (one or more packets) into ticks. */
export function parseTickFrame(frame: ArrayBuffer, receivedAt: number): Tick[] {
  if (frame.byteLength <= 2) return []; // 1-byte heartbeat (or empty)
  const out: Tick[] = [];
  for (const s of sdk.parseBinary(frame)) {
    const t: Tick = {
      token: s.instrument_token,
      mode: s.mode,
      tradable: s.tradable,
      lastPrice: s.last_price,
      receivedAt,
    };
    if (s.last_traded_quantity !== undefined) t.lastQuantity = s.last_traded_quantity;
    if (s.average_traded_price !== undefined) t.averagePrice = s.average_traded_price;
    if (s.volume_traded !== undefined) t.volume = s.volume_traded;
    if (s.total_buy_quantity !== undefined) t.buyQuantity = s.total_buy_quantity;
    if (s.total_sell_quantity !== undefined) t.sellQuantity = s.total_sell_quantity;
    if (s.ohlc) t.ohlc = s.ohlc;
    if (s.change !== undefined) t.change = s.change;
    const ltt = secs(s.last_trade_time);
    if (ltt !== undefined) t.lastTradeTime = ltt;
    const ext = secs(s.exchange_timestamp);
    if (ext !== undefined) t.exchangeTime = ext;
    if (s.oi !== undefined) t.oi = s.oi;
    if (s.oi_day_high !== undefined) t.oiDayHigh = s.oi_day_high;
    if (s.oi_day_low !== undefined) t.oiDayLow = s.oi_day_low;
    if (s.depth) t.depth = s.depth;
    out.push(t);
  }
  return out;
}

/** Copies a Node Buffer into a standalone ArrayBuffer (the SDK slices it). */
export function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
