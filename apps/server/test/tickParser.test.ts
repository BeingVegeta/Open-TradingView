import type { Tick } from '@otv/shared';
import { describe, expect, it } from 'vitest';
import { encodeTickFrame, HEARTBEAT_FRAME } from '../src/mock/tickEncoder';
import { parseTickFrame, toArrayBuffer } from '../src/ticker/tickParser';

const now = 1_791_540_000;
const depth = {
  buy: [1, 2, 3, 4, 5].map((i) => ({ price: 1400 - i * 0.05, quantity: 100 * i, orders: i })),
  sell: [1, 2, 3, 4, 5].map((i) => ({ price: 1400 + i * 0.05, quantity: 90 * i, orders: i + 1 })),
};

describe('tick frames (mock encoder → kiteconnect SDK parser)', () => {
  it('round-trips full, quote and ltp packets for a stock (token low byte 1 = NSE)', () => {
    const full: Tick = {
      token: 738561,
      mode: 'full',
      tradable: true,
      lastPrice: 1400.05,
      lastQuantity: 12,
      averagePrice: 1398.4,
      volume: 4_512_300,
      buyQuantity: 120_000,
      sellQuantity: 98_000,
      ohlc: { open: 1390, high: 1405.5, low: 1388.1, close: 1385.2 },
      lastTradeTime: now - 1,
      exchangeTime: now,
      oi: 0,
      oiDayHigh: 0,
      oiDayLow: 0,
      depth,
      receivedAt: 1,
    };
    const quote: Tick = { ...full, token: 2953217, mode: 'quote' };
    const ltp: Tick = {
      token: 408065,
      mode: 'ltp',
      tradable: true,
      lastPrice: 1478.9,
      receivedAt: 1,
    };
    const [a, b, c] = parseTickFrame(toArrayBuffer(encodeTickFrame([full, quote, ltp])), 1);
    const { change: _c1, ...fa } = a!;
    expect(fa).toEqual({ ...full });
    expect(b).toMatchObject({ token: 2953217, mode: 'quote', volume: 4_512_300, ohlc: full.ohlc });
    expect(b!.exchangeTime).toBeUndefined();
    expect(c).toEqual({
      token: 408065,
      mode: 'ltp',
      tradable: true,
      lastPrice: 1478.9,
      receivedAt: 1,
    });
  });

  it('parses index packets (shorter, no volume) — token low byte 9 = INDICES', () => {
    const token = 256265; // NIFTY 50; 256265 & 0xff === 9
    expect(token & 0xff).toBe(9);
    const t: Tick = {
      token,
      mode: 'full',
      tradable: false,
      lastPrice: 25012.35,
      ohlc: { open: 25000, high: 25050.5, low: 24980, close: 24990 },
      exchangeTime: now,
      receivedAt: 1,
    };
    const [p] = parseTickFrame(toArrayBuffer(encodeTickFrame([t])), 1);
    expect(p).toMatchObject({
      token,
      tradable: false,
      mode: 'full',
      lastPrice: 25012.35,
      exchangeTime: now,
      ohlc: t.ohlc,
    });
    expect(p!.volume).toBeUndefined();
  });

  it('uses the currency divisor for NSE currency tokens (low byte 3)', () => {
    const token = (12345 << 8) | 3;
    const [p] = parseTickFrame(
      toArrayBuffer(
        encodeTickFrame([
          { token, mode: 'ltp', tradable: true, lastPrice: 88.7325, receivedAt: 1 },
        ]),
      ),
      1,
    );
    expect(p!.lastPrice).toBeCloseTo(88.7325, 7);
  });

  it('treats a 1-byte frame as a heartbeat', () => {
    expect(parseTickFrame(toArrayBuffer(HEARTBEAT_FRAME), 1)).toEqual([]);
  });
});
