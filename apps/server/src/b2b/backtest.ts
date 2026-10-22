import { toIstParts, type B2BResult, type B2BSettings, type Candle } from '@otv/shared';
import { istDay } from './compare';

/*
 * Backtesting Varun's N-B2B script over many days: one engine run over all the
 * candles, with every trade read back from the script's own alert lines (CALL
 * and EXIT), so the results are exactly what the dashboard and Pine would show.
 * Pure; used by `pnpm b2b:backtest`.
 */

export interface BtTrade {
  /** IST day and minute of the call, and of the exit. */
  day: string;
  entry: string;
  exit: string;
  dir: 'long' | 'short';
  source: string;
  entryPrice: number;
  /** The script's result over both lots, in points (to 0.01, as its alerts print it), and its text. */
  pts: number;
  result: string;
}

/** Settings measured in points of the instrument (scaled together for another market). */
export const POINT_KEYS = [
  'nearPts',
  'slBuf',
  'initSL',
  'bookPts',
  'stepTrig',
  'lot1Lock',
  'lot2Lock',
  'giveStart',
] as const;

/** Every point setting × `ratio`, to 2 decimals. Other settings are kept. */
export function scalePoints(S: B2BSettings, ratio: number): B2BSettings {
  const out = { ...S };
  for (const k of POINT_KEYS) out[k] = Math.round(S[k] * ratio * 100) / 100;
  return out;
}

/** Median 1-minute true range over bars whose IST time is within [fromHhmm, toHhmm]. */
export function typicalRange(candles: readonly Candle[], fromHhmm: number, toHhmm: number): number {
  const trs: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const p = toIstParts(c.time * 1000);
    const hhmm = p.hour * 100 + p.minute;
    if (hhmm < fromHhmm || hhmm > toHhmm) continue;
    const prev = candles[i - 1];
    const tr =
      prev && c.time - prev.time === 60
        ? Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close))
        : c.high - c.low;
    trs.push(tr);
  }
  if (!trs.length) throw new Error('No bars in that time window');
  trs.sort((a, b) => a - b);
  return trs[Math.floor(trs.length / 2)]!;
}

/** Every completed trade of a run, from the script's CALL and EXIT alert lines. */
export function tradesFromAlerts(res: B2BResult): BtTrade[] {
  const out: BtTrade[] = [];
  let open: Omit<BtTrade, 'exit' | 'pts' | 'result'> | null = null;
  for (const a of res.alerts) {
    for (const line of a.lines) {
      const f = line.split('|');
      if (f[0] === 'CALL') {
        open = {
          day: istDay(a.time),
          entry: f[1]!,
          dir: / CE$/.test(f[2] ?? '') ? 'long' : 'short',
          source: (f[3] ?? '').replace(/^from /, ''),
          entryPrice: Number((f[4] ?? '').replace(/^spot /, '')),
        };
      } else if (f[0] === 'EXIT' && open) {
        const pts = Number(/\|trade (-?[\d.]+)\|/.exec(line)?.[1] ?? NaN);
        out.push({ ...open, exit: f[1]!, pts, result: f[3] ?? '' });
        open = null;
      }
    }
  }
  return out;
}

export interface BtSummary {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPts: number;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  /** Largest fall of the cumulative points from a previous high. */
  maxDrawdown: number;
  days: number;
  greenDays: number;
  bestDay: number | null;
  worstDay: number | null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Results after `costPts` per trade (spread and charges, in points). */
export function summarize(trades: readonly BtTrade[], costPts = 0): BtSummary {
  const net = trades.map((t) => t.pts - costPts);
  const wins = net.filter((x) => x > 0);
  const losses = net.filter((x) => x < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const x of net) {
    cum += x;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  const byDay = new Map<string, number>();
  trades.forEach((t, i) => byDay.set(t.day, (byDay.get(t.day) ?? 0) + net[i]!));
  const days = [...byDay.values()];
  const opt = (x: number | null) => (x === null ? null : r2(x));
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : null,
    totalPts: r2(cum),
    avgWin: opt(mean(wins)),
    avgLoss: opt(mean(losses)),
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    expectancy: opt(mean(net)),
    maxDrawdown: r2(dd),
    days: days.length,
    greenDays: days.filter((x) => x > 0).length,
    bestDay: days.length ? r2(Math.max(...days)) : null,
    worstDay: days.length ? r2(Math.min(...days)) : null,
  };
}

/** Trades, wins and points per group (e.g. per month). */
export function groupBy(
  trades: readonly BtTrade[],
  key: (t: BtTrade) => string,
  costPts = 0,
): { key: string; trades: number; wins: number; pts: number }[] {
  const m = new Map<string, { key: string; trades: number; wins: number; pts: number }>();
  for (const t of trades) {
    const k = key(t);
    const g = m.get(k) ?? { key: k, trades: 0, wins: 0, pts: 0 };
    g.trades++;
    if (t.pts - costPts > 0) g.wins++;
    g.pts = r2(g.pts + t.pts - costPts);
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => a.key.localeCompare(b.key));
}
