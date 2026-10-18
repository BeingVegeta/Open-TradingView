import { describe, expect, it } from 'vitest';
import { istToEpoch } from '../time';
import { exitKind, paperMetrics } from './metrics';
import { DEFAULT_PAPER_COSTS, paperCosts, type PaperTrade } from './types';

let id = 0;
function trade(p: {
  day: number;
  hour: number;
  dir?: 1 | -1;
  netRs: number;
  scriptPts: number;
  peak: number;
  l1: [reason: string, pts: number];
  l2: [reason: string, pts: number];
  result?: string;
  source?: string;
}): PaperTrade {
  const entryAt = istToEpoch(2026, 10, p.day, p.hour, 0);
  const dir = p.dir ?? 1;
  const lot = (r: [string, number], min: number) => ({
    at: entryAt + min * 60_000,
    index: 25000 + dir * r[1],
    opt: 100 + r[1] / 2,
    reason: r[0],
    pts: r[1],
  });
  return {
    id: ++id,
    day: `2026-10-${p.day}`,
    signalTime: entryAt / 1000 - 60,
    entryAt,
    dir,
    source: p.source ?? 'block',
    underlying: 'NSE:NIFTY 50',
    optionName: '25000 CE',
    optionKey: 'NFO:NIFTY26O2025000CE',
    expiry: '2026-10-20',
    lots: 2,
    lotSize: 65,
    scriptLotSize: 65,
    entryIndex: 25000,
    slIndex: 24990,
    entryOpt: 100,
    entryOptLtp: 99.5,
    peakPts: p.peak,
    maePts: 3,
    lot1: lot(p.l1, 5),
    lot2: lot(p.l2, 10),
    status: 'closed',
    result: p.result ?? `L1 ${p.l1[0]} / L2 ${p.l2[0]}`,
    scriptPts: p.scriptPts,
    scriptRs: p.scriptPts * 65,
    grossRs: p.netRs + 50,
    costsRs: 50,
    netRs: p.netRs,
    settingsHash: 'v1',
    notes: [],
  };
}

describe('paper metrics', () => {
  const trades = [
    trade({
      day: 19,
      hour: 10,
      netRs: 1000,
      scriptPts: 15,
      peak: 20,
      l1: ['BOOK +15', 15],
      l2: ['COST', 0],
    }),
    trade({
      day: 19,
      hour: 11,
      netRs: -1300,
      scriptPts: -20,
      peak: 0,
      l1: ['SL', -10],
      l2: ['SL', -10],
      result: 'SL (both lots)',
    }),
    trade({
      day: 20,
      hour: 10,
      dir: -1,
      netRs: 3000,
      scriptPts: 57.5,
      peak: 50,
      l1: ['BOOK +15', 15],
      l2: ['GIVEBACK +42.5', 42.5],
      source: 'breaker',
    }),
    trade({
      day: 20,
      hour: 13,
      netRs: -500,
      scriptPts: -5,
      peak: 4,
      l1: ['BEAR BLOCK', -2.5],
      l2: ['BEAR BLOCK', -2.5],
    }),
  ];
  const m = paperMetrics(trades);

  it('counts wins, losses and money', () => {
    expect(m).toMatchObject({
      trades: 4,
      wins: 2,
      losses: 2,
      winRate: 0.5,
      netRs: 2200,
      costsRs: 200,
    });
    expect(m.grossRs).toBe(2400);
    expect(m.scriptPts).toBe(47.5);
    expect(m.profitFactor).toBeCloseTo(4000 / 1800);
    expect(m.payoff).toBeCloseTo(2000 / 900);
    expect(m.expectancyRs).toBe(550);
  });

  it('measures drawdown, streaks and days', () => {
    // Equity: 1000, -300, 2700, 2200 → worst fall 1300 from the 1000 high.
    expect(m.maxDrawdownRs).toBe(1300);
    expect(m.maxConsecutiveLosses).toBe(1);
    expect(m).toMatchObject({ days: 2, greenDays: 1, bestDayRs: 2500, worstDayRs: -300 });
    expect(m.sharpe).not.toBeNull();
    expect(m.equity.map((e) => e.cumRs)).toEqual([1000, -300, 2700, 2200]);
  });

  it('breaks results down by exit kind, direction, source and hour', () => {
    expect(m.lot1Exits).toEqual({ BOOKED: 2, SL: 1, 'BEAR BLOCK': 1 });
    expect(m.lot2Exits).toEqual({ COST: 1, SL: 1, GIVEBACK: 1, 'BEAR BLOCK': 1 });
    expect(m.bookRate).toBe(0.5);
    expect(m.bothSlRate).toBe(0.25);
    expect(m.byDirection.map((b) => [b.key, b.trades])).toEqual([
      ['CE (long)', 3],
      ['PE (short)', 1],
    ]);
    expect(m.bySource.find((b) => b.key === 'breaker')!.netRs).toBe(3000);
    expect(m.byHour.map((b) => b.key)).toEqual(['10:00', '11:00', '13:00']);
  });

  it('measures how much of the move was kept, and the delta realised', () => {
    expect(m.avgPeakPts).toBe(18.5);
    // Lots average (15+0-10-10+15+42.5-2.5-2.5)/8 = 5.9375 points.
    expect(m.captureRatio).toBeCloseTo(5.9375 / 18.5);
    // Each option moved half the index (opt = 100 + pts/2): delta 0.5.
    expect(m.realisedDelta).toBeCloseTo(0.5);
    expect(m.avgEntrySpread).toBeCloseTo(0.5);
    expect(m.avgMinutesInTrade).toBe(10);
  });

  it('ignores open trades, and handles none', () => {
    expect(paperMetrics([{ ...trades[0]!, status: 'open' }]).trades).toBe(0);
    expect(paperMetrics([]).winRate).toBeNull();
  });

  it('groups exit reasons', () => {
    expect(['BOOK +15', 'STOP +12.5', '+10', 'GIVEBACK +44', 'SL', 'EOD'].map(exitKind)).toEqual([
      'BOOKED',
      'LOCKED STOP',
      'LOCKED STOP',
      'GIVEBACK',
      'SL',
      'EOD',
    ]);
  });
});

describe('paper costs', () => {
  it('adds brokerage per order, STT on sells, stamp on buys and GST', () => {
    // 2 lots of 65 bought at 100, sold at 110 in two orders.
    const c = paperCosts(
      DEFAULT_PAPER_COSTS,
      [{ price: 100, qty: 130 }],
      [
        { price: 110, qty: 65 },
        { price: 110, qty: 65 },
      ],
      3,
    );
    const buy = 13000;
    const sell = 14300;
    const exch = (buy + sell) * 0.0003503;
    const sebi = (buy + sell) * 0.000001;
    const expected = 60 + sell * 0.001 + exch + sebi + buy * 0.00003 + (60 + exch + sebi) * 0.18;
    expect(c).toBeCloseTo(expected, 6);
    expect(c).toBeGreaterThan(80);
    expect(c).toBeLessThan(100);
  });
});
