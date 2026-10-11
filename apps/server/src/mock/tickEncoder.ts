import type { Tick } from '@otv/shared';

/**
 * Encodes ticks into Kite's binary market-data frame format
 * (https://kite.trade/docs/connect/v3/websocket/#binary-market-data):
 * [int16 packet count] then per packet [int16 length][packet], big-endian.
 * Used by the mock ticker server so mock mode exercises the real parser.
 */

// Segment is the low byte of the instrument token (as the SDK reads it).
const NSE_CD = 3;
const BSE_CD = 6;
const INDICES = 9;

function divisorFor(token: number): number {
  const seg = token & 0xff;
  if (seg === NSE_CD) return 10_000_000;
  if (seg === BSE_CD) return 10_000;
  return 100;
}

export function isIndexToken(token: number): boolean {
  return (token & 0xff) === INDICES;
}

function packet(t: Tick): Buffer {
  const d = divisorFor(t.token);
  const px = (v: number | undefined) => Math.round((v ?? 0) * d);
  const index = isIndexToken(t.token);
  let len: number;
  if (t.mode === 'ltp') len = 8;
  else if (index) len = t.mode === 'full' ? 32 : 28;
  else len = t.mode === 'full' ? 184 : 44;
  const b = Buffer.alloc(len);
  b.writeInt32BE(t.token, 0);
  b.writeInt32BE(px(t.lastPrice), 4);
  if (len === 8) return b;
  if (index) {
    b.writeInt32BE(px(t.ohlc?.high), 8);
    b.writeInt32BE(px(t.ohlc?.low), 12);
    b.writeInt32BE(px(t.ohlc?.open), 16);
    b.writeInt32BE(px(t.ohlc?.close), 20);
    b.writeInt32BE(px((t.lastPrice ?? 0) - (t.ohlc?.close ?? 0)), 24);
    if (len === 32) b.writeInt32BE(t.exchangeTime ?? 0, 28);
    return b;
  }
  b.writeInt32BE(t.lastQuantity ?? 0, 8);
  b.writeInt32BE(px(t.averagePrice), 12);
  b.writeInt32BE(t.volume ?? 0, 16);
  b.writeInt32BE(t.buyQuantity ?? 0, 20);
  b.writeInt32BE(t.sellQuantity ?? 0, 24);
  b.writeInt32BE(px(t.ohlc?.open), 28);
  b.writeInt32BE(px(t.ohlc?.high), 32);
  b.writeInt32BE(px(t.ohlc?.low), 36);
  b.writeInt32BE(px(t.ohlc?.close), 40);
  if (len === 44) return b;
  b.writeInt32BE(t.lastTradeTime ?? 0, 44);
  b.writeInt32BE(t.oi ?? 0, 48);
  b.writeInt32BE(t.oiDayHigh ?? 0, 52);
  b.writeInt32BE(t.oiDayLow ?? 0, 56);
  b.writeInt32BE(t.exchangeTime ?? 0, 60);
  const levels = [
    ...(t.depth?.buy ?? []).slice(0, 5),
    ...Array(Math.max(0, 5 - (t.depth?.buy.length ?? 0))).fill(null),
    ...(t.depth?.sell ?? []).slice(0, 5),
    ...Array(Math.max(0, 5 - (t.depth?.sell.length ?? 0))).fill(null),
  ];
  levels.forEach((lv: { quantity: number; price: number; orders: number } | null, i) => {
    const o = 64 + i * 12;
    if (!lv) return;
    b.writeInt32BE(lv.quantity, o);
    b.writeInt32BE(px(lv.price), o + 4);
    b.writeInt16BE(lv.orders, o + 8);
  });
  return b;
}

export function encodeTickFrame(ticks: Tick[]): Buffer {
  const parts: Buffer[] = [Buffer.alloc(2)];
  parts[0]!.writeInt16BE(ticks.length, 0);
  for (const t of ticks) {
    const p = packet(t);
    const len = Buffer.alloc(2);
    len.writeInt16BE(p.length, 0);
    parts.push(len, p);
  }
  return Buffer.concat(parts);
}

/** Kite's keep-alive: a single byte. */
export const HEARTBEAT_FRAME = Buffer.from([0]);
