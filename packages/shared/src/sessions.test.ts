import { describe, expect, it } from 'vitest';
import { aggregateCandles, parseKiteTimestamp } from './aggregate';
import type { Candle } from './market';
import { priceDecimals } from './market';
import { bucketStart, extendSessionTo, regularSession } from './sessions';
import { formatIstDateTime, istToEpoch } from './time';

const ist = (h: number, m: number, day = 12) => istToEpoch(2026, 10, day, h, m);
const fmt = (ms: number) => formatIstDateTime(ms).slice(11, 16);

describe('bucketStart (session-anchored)', () => {
  it('anchors NSE hourly candles to 09:15', () => {
    expect(fmt(bucketStart('NSE', ist(9, 15), 60))).toBe('09:15');
    expect(fmt(bucketStart('NSE', ist(10, 14), 60))).toBe('09:15');
    expect(fmt(bucketStart('NSE', ist(10, 15), 60))).toBe('10:15');
    expect(fmt(bucketStart('NFO', ist(15, 29), 60))).toBe('15:15');
  });

  it('anchors NSE 30-minute candles to 09:15 / 09:45', () => {
    expect(fmt(bucketStart('NSE', ist(9, 44), 30))).toBe('09:15');
    expect(fmt(bucketStart('NSE', ist(9, 45), 30))).toBe('09:45');
  });

  it('anchors MCX and currency candles to 09:00', () => {
    expect(fmt(bucketStart('MCX', ist(10, 59), 60))).toBe('10:00');
    expect(fmt(bucketStart('MCX', ist(23, 10), 60))).toBe('23:00');
    expect(fmt(bucketStart('CDS', ist(9, 31), 15))).toBe('09:30');
  });

  it('puts day candles at 00:00 IST', () => {
    expect(formatIstDateTime(bucketStart('NSE', ist(15, 0), 'day'))).toBe('2026-10-12 00:00:00');
  });
});

describe('aggregateCandles', () => {
  const m = (
    h: number,
    mi: number,
    o: number,
    hi: number,
    lo: number,
    c: number,
    v: number,
    oi?: number,
  ): Candle => ({
    time: ist(h, mi) / 1000,
    open: o,
    high: hi,
    low: lo,
    close: c,
    volume: v,
    ...(oi !== undefined ? { oi } : {}),
  });

  it('builds 5m candles from 1m candles anchored at 09:15', () => {
    const ones = [
      m(9, 15, 100, 101, 99, 100.5, 10, 1),
      m(9, 16, 100.5, 102, 100, 101, 20, 2),
      m(9, 19, 101, 101.5, 98, 99, 5, 3),
      m(9, 20, 99, 99, 97, 98, 7, 4),
    ];
    expect(aggregateCandles(ones, 'NSE', 5)).toEqual([
      { time: ist(9, 15) / 1000, open: 100, high: 102, low: 98, close: 99, volume: 35, oi: 3 },
      { time: ist(9, 20) / 1000, open: 99, high: 99, low: 97, close: 98, volume: 7, oi: 4 },
    ]);
  });
});

describe('parseKiteTimestamp', () => {
  it('parses +0530 timestamps to the right instant', () => {
    expect(parseKiteTimestamp('2017-12-15T09:15:00+0530')).toBe(
      Date.parse('2017-12-15T03:45:00Z') / 1000,
    );
    expect(parseKiteTimestamp('2015-02-10T00:00:00+0530')).toBe(
      Date.parse('2015-02-09T18:30:00Z') / 1000,
    );
  });
});

describe('priceDecimals', () => {
  it('derives display precision from tick size', () => {
    expect(priceDecimals(0.05)).toBe(2);
    expect(priceDecimals(0.0025)).toBe(4);
    expect(priceDecimals(1)).toBe(0);
    expect(priceDecimals(0.01)).toBe(2);
  });
});

describe('regularSession (closing auction session)', () => {
  const hhmm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  it('ends cash stocks at 15:15, indices at 15:30 and F&O at 15:40', () => {
    expect(hhmm(regularSession('NSE', 'NSE').close)).toBe('15:15');
    expect(hhmm(regularSession('BSE', 'BSE').close)).toBe('15:15');
    expect(hhmm(regularSession('NSE', 'INDICES').close)).toBe('15:30');
    expect(hhmm(regularSession('BSE', 'INDICES').close)).toBe('15:30');
    expect(hhmm(regularSession('NFO', 'NFO-FUT').close)).toBe('15:40');
    expect(hhmm(regularSession('MCX', 'MCX-FUT').close)).toBe('23:55');
    expect(hhmm(regularSession('NSE', 'NSE').open)).toBe('9:15');
  });

  it('extends (never shortens) the close to cover the last candle of a day', () => {
    const cash = regularSession('NSE', 'NSE');
    const last = (h: number, m: number) => istToEpoch(2026, 10, 9, h, m) / 1000;
    // A stock still trading continuously until 15:30.
    expect(hhmm(extendSessionTo(cash, last(15, 29)).close)).toBe('15:30');
    expect(extendSessionTo(cash, last(15, 14))).toEqual(cash);
    // Illiquid: last trade early. Unchanged.
    expect(extendSessionTo(cash, last(14, 2))).toEqual(cash);
    // Implausibly late (e.g. a special session): unchanged.
    expect(extendSessionTo(cash, last(18, 0))).toEqual(cash);
    expect(extendSessionTo(cash, undefined)).toEqual(cash);
  });
});

describe('custom timeframes: buckets and aggregation', () => {
  const at = (d: number, h: number, m: number) => istToEpoch(2026, 10, d, h, m);
  const hm = (ms: number) => formatIstDateTime(ms).slice(11, 16);

  it('anchors 2h and 4h bars to the session open', () => {
    expect([9, 10, 11, 13, 15].map((h) => hm(bucketStart('NSE', at(12, h, 20), 120)))).toEqual([
      '09:15',
      '09:15',
      '11:15',
      '13:15',
      '15:15',
    ]);
    expect(hm(bucketStart('NSE', at(12, 13, 14), 240))).toBe('09:15');
    expect(hm(bucketStart('NSE', at(12, 13, 15), 240))).toBe('13:15');
    expect(hm(bucketStart('MCX', at(12, 22, 0), 240))).toBe('21:00');
  });

  it('starts weeks on Monday and months on the 1st, at 00:00 IST', () => {
    // Sunday 18 Oct 2026 23:59 IST belongs to the week of Monday 12 Oct.
    expect(bucketStart('NSE', at(18, 23, 59), 'week')).toBe(istToEpoch(2026, 10, 12));
    expect(bucketStart('NSE', at(19, 0, 0), 'week')).toBe(istToEpoch(2026, 10, 19));
    expect(bucketStart('NSE', at(12, 0, 0), 'week')).toBe(istToEpoch(2026, 10, 12));
    expect(bucketStart('NSE', at(31, 23, 59), 'month')).toBe(istToEpoch(2026, 10, 1));
    expect(bucketStart('NSE', istToEpoch(2026, 11, 1), 'month')).toBe(istToEpoch(2026, 11, 1));
  });

  it('builds 2h bars from hourly candles, the last one short (CAS close)', () => {
    const hours = [9, 10, 11, 12, 13, 14].map((h, i) => ({
      time: at(12, h, 15) / 1000,
      open: 100 + i,
      high: 110 + i,
      low: 90 - i,
      close: 101 + i,
      volume: 10,
    }));
    const out = aggregateCandles(hours, 'NSE', 120);
    expect(out.map((c) => hm(c.time * 1000))).toEqual(['09:15', '11:15', '13:15']);
    expect(out[0]).toMatchObject({ open: 100, high: 111, low: 89, close: 102, volume: 20 });
  });

  it('builds week and month bars from daily candles', () => {
    const days = [8, 9, 12, 13, 30].map((d, i) => ({
      time: istToEpoch(2026, 10, d) / 1000,
      open: 10 + i,
      high: 20 + i,
      low: 5 - i,
      close: 11 + i,
      volume: 100,
    }));
    const weeks = aggregateCandles(days, 'NSE', 'week');
    expect(weeks.map((c) => formatIstDateTime(c.time * 1000).slice(0, 10))).toEqual([
      '2026-10-05',
      '2026-10-12',
      '2026-10-26',
    ]);
    expect(weeks[1]).toMatchObject({ open: 12, high: 23, low: 2, close: 14, volume: 200 });
    const months = aggregateCandles(days, 'NSE', 'month');
    expect(months).toHaveLength(1);
    expect(months[0]).toMatchObject({ open: 10, close: 15, volume: 500 });
  });
});
