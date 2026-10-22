import { B2B_DEFAULTS, istToEpoch, runB2B, type Candle } from '@otv/shared';
import { describe, expect, it } from 'vitest';
import {
  groupBy,
  scalePoints,
  summarize,
  tradesFromAlerts,
  typicalRange,
  type BtTrade,
} from '../src/b2b/backtest';

/** A seeded random walk of 1-minute candles, 09:15-15:29 IST, on the given October days. */
function market(days: number[], seed = 7): Candle[] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648), x / 2147483648);
  const out: Candle[] = [];
  let px = 25000;
  for (const d of days)
    for (let i = 0; i < 375; i++) {
      const open = px;
      const close = Math.round((open + (rnd() - 0.5) * 12) * 20) / 20;
      const high = Math.round((Math.max(open, close) + rnd() * 4) * 20) / 20;
      const low = Math.round((Math.min(open, close) - rnd() * 4) * 20) / 20;
      out.push({
        time: istToEpoch(2026, 10, d, 9, 15 + i) / 1000,
        open,
        high,
        low,
        close,
        volume: 0,
      });
      px = close;
    }
  return out;
}

const t = (day: string, pts: number): BtTrade => ({
  day,
  entry: '10:00',
  exit: '10:05',
  dir: 'long',
  source: 'block',
  entryPrice: 1,
  pts,
  result: pts > 0 ? 'L1 +15 / L2 COST' : 'SL (both lots)',
});

describe('backtest', () => {
  it("reads every day's trades from the script's alerts, matching each day's own log", () => {
    const cs = market([13, 14, 15, 16]);
    const trades = tradesFromAlerts(runB2B(cs, { settings: B2B_DEFAULTS }));
    expect(new Set(trades.map((x) => x.day)).size).toBeGreaterThan(1);
    // The last day's trades are exactly that day's call log.
    const log = runB2B(cs, { settings: B2B_DEFAULTS }).log.filter((r) => r.ent !== null);
    const last = trades.filter((x) => x.day === '2026-10-16');
    // Points come from the alert lines, rounded to 0.01 like the script's own alerts.
    expect(last.map((x) => [x.entry, x.pts])).toEqual(
      log.map((r) => [r.t, Math.round((r.tot ?? 0) * 100) / 100]),
    );
  });

  it('summarises points, costs, drawdown and days', () => {
    const s = summarize([t('d1', 15), t('d1', -20), t('d2', 30), t('d2', -20)], 1);
    expect(s).toMatchObject({ trades: 4, wins: 2, losses: 2, winRate: 0.5, totalPts: 1 });
    expect(s.avgWin).toBe(21.5);
    expect(s.avgLoss).toBe(-21);
    expect(s.profitFactor).toBeCloseTo(43 / 42, 2);
    expect(s.maxDrawdown).toBe(21);
    expect(s).toMatchObject({ days: 2, greenDays: 1, bestDay: 8, worstDay: -7 });
    expect(groupBy([t('2026-10-01', 15), t('2026-11-02', -20)], (x) => x.day.slice(0, 7))).toEqual([
      { key: '2026-10', trades: 1, wins: 1, pts: 15 },
      { key: '2026-11', trades: 1, wins: 0, pts: -20 },
    ]);
  });

  it('scales only the point settings, and measures a typical range', () => {
    const s = scalePoints(B2B_DEFAULTS, 0.25);
    expect(s).toMatchObject({ initSL: 2.5, bookPts: 3.75, stepTrig: 2.5, giveStart: 10 });
    expect(s.swLen).toBe(B2B_DEFAULTS.swLen);
    expect(s.entFrom).toBe(B2B_DEFAULTS.entFrom);
    const flat = [0, 1, 2].map((i) => ({
      time: istToEpoch(2026, 10, 16, 10, i) / 1000,
      open: 100,
      high: 100 + i + 1,
      low: 100,
      close: 100,
      volume: 0,
    }));
    expect(typicalRange(flat, 1000, 1002)).toBe(2);
    expect(() => typicalRange(flat, 1200, 1300)).toThrow(/No bars/);
  });
});
