import { toIstParts } from '../time';
import type { PaperTrade } from './types';

/*
 * How well the strategy did on paper. Money figures are the simulated option
 * P&L after estimated costs (what an account would have seen); "pts" figures
 * are the script's own index-point results, to compare with TradingView.
 */

export interface Bucket {
  key: string;
  trades: number;
  wins: number;
  winRate: number | null;
  netRs: number;
  scriptPts: number;
}

export interface PaperMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  /** Option P&L after costs, gross and the costs themselves (₹). */
  netRs: number;
  grossRs: number;
  costsRs: number;
  /** The script's index points (both lots) and its ₹ at its own lot size. */
  scriptPts: number;
  scriptRs: number;
  avgWinRs: number | null;
  avgLossRs: number | null;
  /** Average win / average loss. */
  payoff: number | null;
  /** Gross wins / gross losses. */
  profitFactor: number | null;
  /** Average net ₹ and script points per trade. */
  expectancyRs: number | null;
  expectancyPts: number | null;
  /** Largest fall of the cumulative net ₹ from a previous high. */
  maxDrawdownRs: number;
  maxConsecutiveLosses: number;
  days: number;
  greenDays: number;
  bestDayRs: number | null;
  worstDayRs: number | null;
  /** Mean / standard deviation of daily net ₹, × √252 (needs 2+ days). */
  sharpe: number | null;
  /** Average best and worst excursion while open, index points. */
  avgPeakPts: number | null;
  avgMaePts: number | null;
  /** Average realised points per lot ÷ average peak: how much of the move was kept. */
  captureRatio: number | null;
  /** Both lots stopped at the initial stop. */
  bothSlRate: number | null;
  /** Lot 1 reached the +15 booking. */
  bookRate: number | null;
  avgMinutesInTrade: number | null;
  /** Option points gained per index point (over all lots), i.e. the delta actually realised. */
  realisedDelta: number | null;
  /** Average spread paid at entry per unit (fill − last price). */
  avgEntrySpread: number | null;
  /** Trades with no option price (P&L only in index points). */
  missingOptionPrices: number;
  lot1Exits: Record<string, number>;
  lot2Exits: Record<string, number>;
  byDirection: Bucket[];
  bySource: Bucket[];
  byHour: Bucket[];
  bySettings: Bucket[];
  byDay: Bucket[];
  /** Cumulative net ₹ after each closed trade (exit time, epoch ms). */
  equity: { at: number; cumRs: number }[];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);

/** Groups reasons like "BOOK +15", "STOP +12.5" or "GIVEBACK +44.41" into their kind. */
export function exitKind(reason: string): string {
  if (reason.startsWith('BOOK')) return 'BOOKED';
  if (reason.startsWith('GIVEBACK')) return 'GIVEBACK';
  if (reason.startsWith('STOP') || reason.startsWith('+') || reason.startsWith('-'))
    return 'LOCKED STOP';
  return reason;
}

function bucket(key: string, ts: PaperTrade[]): Bucket {
  const wins = ts.filter((t) => (t.netRs ?? t.scriptRs ?? 0) > 0).length;
  return {
    key,
    trades: ts.length,
    wins,
    winRate: ts.length ? wins / ts.length : null,
    netRs: sum(ts.map((t) => t.netRs ?? 0)),
    scriptPts: sum(ts.map((t) => t.scriptPts ?? 0)),
  };
}

function groupBy(ts: PaperTrade[], keyOf: (t: PaperTrade) => string): Bucket[] {
  const m = new Map<string, PaperTrade[]>();
  for (const t of ts) {
    const k = keyOf(t);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(t);
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => bucket(k, v));
}

const exitAt = (t: PaperTrade) => Math.max(t.lot1?.at ?? 0, t.lot2?.at ?? 0);

export function paperMetrics(all: readonly PaperTrade[]): PaperMetrics {
  const ts = all.filter((t) => t.status === 'closed').sort((a, b) => exitAt(a) - exitAt(b));
  // A trade's result: option ₹ after costs, or the script's ₹ when no option price exists.
  const res = (t: PaperTrade) => t.netRs ?? t.scriptRs ?? 0;
  const wins = ts.filter((t) => res(t) > 0);
  const losses = ts.filter((t) => res(t) < 0);
  const grossWin = sum(wins.map(res));
  const grossLoss = -sum(losses.map(res));

  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let streak = 0;
  let maxStreak = 0;
  const equity: PaperMetrics['equity'] = [];
  for (const t of ts) {
    cum += res(t);
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
    equity.push({ at: exitAt(t), cumRs: cum });
    streak = res(t) < 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }

  const byDay = groupBy(ts, (t) => t.day);
  const dayNets = byDay.map((d) => d.netRs);
  const meanDay = avg(dayNets);
  const sdDay =
    dayNets.length > 1 && meanDay !== null
      ? Math.sqrt(sum(dayNets.map((x) => (x - meanDay) ** 2)) / (dayNets.length - 1))
      : null;

  const lotPts = ts.flatMap((t) =>
    [t.lot1?.pts, t.lot2?.pts].filter((x): x is number => x != null),
  );
  const avgPeak = avg(ts.map((t) => t.peakPts));
  const avgLot = avg(lotPts);

  // Realised delta: option points per index point, over lots that have both.
  let optPts = 0;
  let idxPts = 0;
  for (const t of ts) {
    if (t.entryOpt === null) continue;
    for (const l of [t.lot1, t.lot2]) {
      if (!l || l.opt === null) continue;
      optPts += l.opt - t.entryOpt;
      idxPts += t.dir === 1 ? l.index - t.entryIndex : t.entryIndex - l.index;
    }
  }

  const count = (pick: (t: PaperTrade) => PaperTrade['lot1']) => {
    const out: Record<string, number> = {};
    for (const t of ts) {
      const l = pick(t);
      if (!l) continue;
      const k = exitKind(l.reason);
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };

  // By the hour of the entry fill.
  const hourOf = (t: PaperTrade) => {
    const p = toIstParts(t.entryAt);
    return `${String(p.hour).padStart(2, '0')}:00`;
  };
  const spreads = ts
    .filter((t) => t.entryOpt !== null && t.entryOptLtp !== null)
    .map((t) => t.entryOpt! - t.entryOptLtp!);

  return {
    trades: ts.length,
    wins: wins.length,
    losses: losses.length,
    winRate: ts.length ? wins.length / ts.length : null,
    netRs: sum(ts.map((t) => t.netRs ?? 0)),
    grossRs: sum(ts.map((t) => t.grossRs ?? 0)),
    costsRs: sum(ts.map((t) => t.costsRs ?? 0)),
    scriptPts: sum(ts.map((t) => t.scriptPts ?? 0)),
    scriptRs: sum(ts.map((t) => t.scriptRs ?? 0)),
    avgWinRs: avg(wins.map(res)),
    avgLossRs: avg(losses.map(res)),
    payoff:
      wins.length && losses.length ? grossWin / wins.length / (grossLoss / losses.length) : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancyRs: avg(ts.map(res)),
    expectancyPts: avg(ts.map((t) => t.scriptPts ?? 0)),
    maxDrawdownRs: maxDd,
    maxConsecutiveLosses: maxStreak,
    days: byDay.length,
    greenDays: byDay.filter((d) => d.netRs > 0).length,
    bestDayRs: dayNets.length ? Math.max(...dayNets) : null,
    worstDayRs: dayNets.length ? Math.min(...dayNets) : null,
    sharpe: sdDay && meanDay !== null && sdDay > 0 ? (meanDay / sdDay) * Math.sqrt(252) : null,
    avgPeakPts: avgPeak,
    avgMaePts: avg(ts.map((t) => t.maePts).filter((x): x is number => x !== null)),
    captureRatio: avgPeak && avgLot !== null && avgPeak > 0 ? avgLot / avgPeak : null,
    bothSlRate: ts.length
      ? ts.filter((t) => t.result === 'SL (both lots)').length / ts.length
      : null,
    bookRate: ts.length
      ? ts.filter((t) => t.lot1?.reason.startsWith('BOOK')).length / ts.length
      : null,
    avgMinutesInTrade: avg(ts.map((t) => (exitAt(t) - t.entryAt) / 60_000)),
    realisedDelta: idxPts !== 0 ? optPts / idxPts : null,
    avgEntrySpread: avg(spreads),
    missingOptionPrices: ts.filter((t) => t.entryOpt === null).length,
    lot1Exits: count((t) => t.lot1),
    lot2Exits: count((t) => t.lot2),
    byDirection: groupBy(ts, (t) => (t.dir === 1 ? 'CE (long)' : 'PE (short)')),
    bySource: groupBy(ts, (t) => t.source),
    byHour: groupBy(ts, hourOf),
    bySettings: groupBy(ts, (t) => t.settingsHash),
    byDay,
    equity,
  };
}
