import { describe, expect, it } from 'vitest';
import { CandleBuilder, marketPhase, type BuilderTick } from './candleBuilder';
import { regularSession } from './sessions';
import { formatIstDateTime, istToEpoch } from './time';

/** IST wall-clock → epoch seconds on Mon 12 Oct 2026. */
const at = (h: number, m: number, s = 0, day = 12) => istToEpoch(2026, 10, day, h, m, s) / 1000;
const hhmm = (epochS: number) => formatIstDateTime(epochS * 1000).slice(11, 19);

/** A full-mode tick for a tradable instrument. */
function tk(
  time: number,
  price: number,
  volume?: number,
  extra: Partial<BuilderTick> = {},
): BuilderTick {
  return {
    lastPrice: price,
    lastTradeTime: time,
    exchangeTime: time,
    receivedAt: time * 1000 + 50,
    tradable: true,
    ...(volume !== undefined ? { volume } : {}),
    ...extra,
  };
}

function run(b: CandleBuilder, ticks: BuilderTick[]) {
  const closed = [];
  let last;
  for (const t of ticks) {
    const r = b.apply(t);
    if (r?.closed) closed.push(r.closed);
    if (r) last = r.current;
  }
  return { closed, current: last };
}

describe('CandleBuilder: intraday bars', () => {
  it('puts boundary ticks in the right bar (09:19:59 vs 09:20:00 on 5m)', () => {
    const b = new CandleBuilder('NSE', 5);
    const { closed, current } = run(b, [
      tk(at(9, 15, 1), 100, 1000),
      tk(at(9, 19, 59), 101, 1500),
      tk(at(9, 20, 0), 102, 1600),
    ]);
    expect(closed).toHaveLength(1);
    expect(hhmm(closed[0]!.time)).toBe('09:15:00');
    // Joined at 09:15:01 without earlier ticks: volume counts from the first tick.
    expect(closed[0]).toMatchObject({ open: 100, high: 101, low: 100, close: 101, volume: 500 });
    expect(hhmm(current!.time)).toBe('09:20:00');
    expect(current).toMatchObject({ open: 102, close: 102, volume: 100 });
  });

  it('derives volume from cumulative day volume, not by summing ticks', () => {
    const b = new CandleBuilder('NSE', 1);
    const { current } = run(b, [
      tk(at(10, 0, 5), 50, 10_000, { lastQuantity: 10 }),
      tk(at(10, 0, 20), 51, 10_400, { lastQuantity: 25 }),
      tk(at(10, 0, 40), 49, 10_900, { lastQuantity: 5 }),
    ]);
    // Connected mid-session: only the first tick's own trade (10) predates nothing we saw.
    expect(current).toMatchObject({ open: 50, high: 51, low: 49, close: 49, volume: 910 });
  });

  it('starts the day at the session open and leaves pre-open volume out (as Kite does)', () => {
    const b = new CandleBuilder('NSE', 1);
    const pre = run(b, [tk(at(9, 7, 30), 98, 5000), tk(at(9, 8, 0), 98.5, 5000)]);
    expect(pre.current).toBeUndefined(); // pre-open never makes a bar
    const { current } = run(b, [tk(at(9, 15, 0), 99, 6200), tk(at(9, 15, 30), 99.5, 6500)]);
    expect(hhmm(current!.time)).toBe('09:15:00');
    expect(current).toMatchObject({ open: 99, high: 99.5, close: 99.5, volume: 1500 });
  });

  it('without pre-open ticks, the first bar counts only trades from its first tick', () => {
    const b = new CandleBuilder('NSE', 1);
    const { current } = run(b, [
      tk(at(9, 15, 1), 99, 6200, { lastQuantity: 20 }),
      tk(at(9, 15, 30), 99.5, 6500),
    ]);
    expect(current!.volume).toBe(320);
  });

  it('ends cash stocks at 15:15 (closing auction) and ignores later ticks', () => {
    const b = new CandleBuilder('NSE', 5);
    run(b, [tk(at(15, 14, 50), 200, 90_000)]);
    // Closing auction (SEBI CAS): its trades are not part of any candle.
    expect(b.apply(tk(at(15, 15, 0), 201, 95_000))).toBeNull();
    expect(b.apply(tk(at(15, 30, 0), 202, 97_000))).toBeNull();
    expect(b.current).toMatchObject({ close: 200, volume: 0 });
  });

  it('keeps F&O trading until 15:40 and indices until 15:30', () => {
    const fut = new CandleBuilder('NFO', 5);
    expect(fut.apply(tk(at(15, 39, 0), 300, 10))!.current.time).toBe(at(15, 35, 0));
    expect(fut.apply(tk(at(15, 40, 0), 301, 20))).toBeNull();
    const idx = new CandleBuilder('NSE', 5, regularSession('NSE', 'INDICES'));
    expect(idx.apply(tk(at(15, 29, 0), 25000, 0))!.current.time).toBe(at(15, 25, 0));
    expect(idx.apply(tk(at(15, 30, 0), 25001, 0))).toBeNull();
  });

  it('uses an explicit session when given one', () => {
    const b = new CandleBuilder('NSE', 1, { open: 9 * 60 + 15, close: 15 * 60 + 30 });
    expect(b.apply(tk(at(15, 20, 0), 200, 10))).not.toBeNull();
  });

  it('ignores stale ticks whose last trade is older than the forming bar', () => {
    const b = new CandleBuilder('NSE', 1);
    run(b, [tk(at(11, 0, 10), 10, 100), tk(at(11, 1, 5), 11, 150)]);
    // Illiquid: the snapshot is new but the last trade was in the 11:00 bar.
    const r = b.apply(tk(at(11, 0, 50), 9, 150, { exchangeTime: at(11, 1, 30) }));
    expect(r).toBeNull();
    expect(b.current).toMatchObject({ close: 11, low: 11 });
  });

  it('handles indices: no volume, exchange timestamp only', () => {
    const b = new CandleBuilder('NSE', 3);
    const idx = (time: number, price: number): BuilderTick => ({
      lastPrice: price,
      exchangeTime: time,
      receivedAt: time * 1000,
      tradable: false,
    });
    const { closed, current } = run(b, [
      idx(at(9, 15, 1), 25000),
      idx(at(9, 17, 59), 25010),
      idx(at(9, 18, 0), 24990),
    ]);
    expect(closed[0]).toMatchObject({ open: 25000, high: 25010, close: 25010, volume: 0 });
    expect(current).toMatchObject({ open: 24990, volume: 0 });
  });

  it('continues a bar seeded from history using Kite volume as the starting point', () => {
    const b = new CandleBuilder('NSE', 5);
    b.seed({ time: at(10, 0), open: 100, high: 103, low: 99, close: 102, volume: 4000 });
    const { current } = run(b, [tk(at(10, 2, 10), 104, 50_000), tk(at(10, 2, 20), 101, 50_300)]);
    expect(current).toMatchObject({ open: 100, high: 104, low: 99, close: 101, volume: 4300 });
  });

  it('after a gap, opens the new bar and lets reconciliation replace the gap', () => {
    const b = new CandleBuilder('NSE', 1);
    run(b, [tk(at(12, 0, 5), 10, 1000), tk(at(12, 0, 55), 10.5, 1100)]);
    // Connection drop: next tick arrives in 12:03.
    const r = b.apply(tk(at(12, 3, 2), 11, 1500))!;
    expect(hhmm(r.closed!.time)).toBe('12:00:00');
    expect(hhmm(r.current.time)).toBe('12:03:00');
    // Trades during the gap get lumped into the new bar until reconciled...
    expect(r.current.volume).toBe(400);
    // ...then history (here: Kite says 12:03 so far traded 120) replaces it.
    b.seed({ time: at(12, 3), open: 10.9, high: 11.1, low: 10.9, close: 11, volume: 120 });
    const after = b.apply(tk(at(12, 3, 30), 11.2, 1530))!;
    expect(after.current).toMatchObject({ open: 10.9, high: 11.2, volume: 150 });
  });

  it('carries open interest from full-mode ticks', () => {
    const b = new CandleBuilder('NFO', 1);
    const { current } = run(b, [
      tk(at(9, 30, 1), 25100, 1000, { oi: 12_000_000 }),
      tk(at(9, 30, 2), 25101, 1075, { oi: 12_000_075 }),
    ]);
    expect(current!.oi).toBe(12_000_075);
  });

  it('anchors every timeframe to the session open per exchange', () => {
    const cases: [string, number, number, string][] = [
      ['NSE', 60, at(10, 14, 59), '09:15:00'],
      ['NSE', 60, at(10, 15, 0), '10:15:00'],
      ['NSE', 30, at(9, 46, 0), '09:45:00'],
      ['NSE', 15, at(15, 14, 0), '15:00:00'],
      ['NFO', 15, at(15, 39, 0), '15:30:00'],
      ['NSE', 10, at(9, 24, 59), '09:15:00'],
      ['NSE', 3, at(9, 18, 0), '09:18:00'],
      ['BSE', 60, at(11, 20, 0), '11:15:00'],
      ['MCX', 60, at(9, 59, 0), '09:00:00'],
      ['MCX', 60, at(23, 10, 0), '23:00:00'],
      ['MCX', 15, at(19, 7, 0), '19:00:00'],
      ['CDS', 30, at(9, 31, 0), '09:30:00'],
    ];
    for (const [ex, bar, time, want] of cases) {
      const b = new CandleBuilder(ex, bar);
      expect(hhmm(b.apply(tk(time, 1, 1))!.current.time), `${ex} ${bar}m @ ${hhmm(time)}`).toBe(
        want,
      );
    }
  });

  it('accepts MCX evening ticks that NSE would reject', () => {
    expect(new CandleBuilder('MCX', 5).apply(tk(at(21, 0, 0), 5600, 10))).not.toBeNull();
    expect(new CandleBuilder('NSE', 5).apply(tk(at(21, 0, 0), 100, 10))).toBeNull();
  });

  it('ignores zero prices (empty snapshots)', () => {
    expect(new CandleBuilder('NSE', 1).apply(tk(at(10, 0, 0), 0, 10))).toBeNull();
  });
});

describe('CandleBuilder: day bars', () => {
  it('uses the exchange day OHLC and cumulative volume', () => {
    const b = new CandleBuilder('NSE', 'day');
    const r = b.apply(
      tk(at(13, 0, 0), 1402, 3_000_000, {
        ohlc: { open: 1390, high: 1410, low: 1385, close: 1380 },
      }),
    )!;
    expect(formatIstDateTime(r.current.time * 1000)).toBe('2026-10-12 00:00:00');
    expect(r.current).toMatchObject({
      open: 1390,
      high: 1410,
      low: 1385,
      close: 1402,
      volume: 3_000_000,
    });
  });

  it('rolls over to a new day bar', () => {
    const b = new CandleBuilder('NSE', 'day');
    b.apply(tk(at(15, 0, 0), 100, 10));
    const r = b.apply(tk(at(9, 15, 5, 13), 101, 20))!;
    expect(r.closed).toBeDefined();
    expect(formatIstDateTime(r.current.time * 1000)).toBe('2026-10-13 00:00:00');
  });
});

describe('marketPhase', () => {
  it('knows regular sessions, pre-open and weekends (holidays are not known)', () => {
    expect(marketPhase('NSE', at(9, 10) * 1000)).toBe('pre-open');
    expect(marketPhase('NSE', at(9, 15) * 1000)).toBe('open');
    expect(marketPhase('NSE', at(15, 30) * 1000)).toBe('closed');
    expect(marketPhase('MCX', at(22, 0) * 1000)).toBe('open');
    expect(marketPhase('NSE', istToEpoch(2026, 10, 11, 11, 0))).toBe('closed'); // Sunday
  });
});
