import {
  b2bLogView,
  runB2B,
  toIstParts,
  tradingViewIndexSession,
  type B2BLogRow,
  type B2BResult,
  type B2BSettings,
  type Candle,
  type PaperTrade,
  type PivotTie,
} from '@otv/shared';

/*
 * Parity diagnostics for Varun's N-B2B port: load 1-minute candles exported
 * from TradingView or Kite, run the engine on them, and compare candles, the
 * script's plots and call logs. Used by `pnpm b2b:compare`; pure, no I/O.
 */

/** The script's plot() titles, as TradingView's "Export chart data" names the columns. */
export const SCRIPT_PLOTS = {
  entry: 'Entry',
  sl1: 'SL lot 1',
  sl2: 'SL lot 2',
  book: 'Lot 1 booking level (+15)',
  trigger: 'Protection trigger (+10)',
} as const;
export type PlotKey = keyof typeof SCRIPT_PLOTS;
export type PlotRow = Record<PlotKey, number | null>;
const PLOT_KEYS = Object.keys(SCRIPT_PLOTS) as PlotKey[];

export interface CandleFile {
  candles: Candle[];
  /** The script's plotted values by bar time, when the export has its columns. */
  plots: Map<number, PlotRow> | null;
  format: string;
  warnings: string[];
}

/** IST trading day (yyyy-mm-dd) of an epoch-seconds time. */
export function istDay(epochS: number): string {
  const p = toIstParts(epochS * 1000);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

const hhmm = (epochS: number) => {
  const p = toIstParts(epochS * 1000);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

/**
 * Epoch seconds from an epoch (s or ms) or a date-time string. A string without
 * a zone is IST; Kite's "+0530" is accepted.
 */
export function parseTime(v: string | number): number {
  if (typeof v === 'number' || /^\s*\d+(\.\d+)?\s*$/.test(v)) {
    const n = Number(v);
    return Math.floor(n > 1e11 ? n / 1000 : n);
  }
  let s = v.trim().replace(' ', 'T');
  s = s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
  if (!/(Z|[+-]\d\d:\d\d)$/i.test(s)) s += '+05:30';
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`Unreadable time: ${v}`);
  return Math.floor(ms / 1000);
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Splits one CSV line (double quotes allowed). */
function csvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function fromCsv(text: string, warnings: string[]): Omit<CandleFile, 'warnings'> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) throw new Error('Empty CSV');
  const head = csvLine(lines[0]!);
  const lower = head.map((h) => h.toLowerCase());
  const col = (...names: string[]) => lower.findIndex((h) => names.includes(h));
  const ti = col('time', 'date', 'datetime', 'timestamp');
  const [oi, hi, li, ci] = ['open', 'high', 'low', 'close'].map((n) => col(n)) as [
    number,
    number,
    number,
    number,
  ];
  const vi = col('volume');
  if ([ti, oi, hi, li, ci].some((i) => i < 0))
    throw new Error(`CSV needs time, open, high, low and close columns (got: ${head.join(', ')})`);
  const plotCols = new Map<PlotKey, number>();
  for (const k of PLOT_KEYS) {
    const idx = head.flatMap((h, i) => (h === SCRIPT_PLOTS[k] ? [i] : []));
    if (idx.length > 1)
      warnings.push(
        `${idx.length} columns are named "${SCRIPT_PLOTS[k]}" (another indicator on the chart?); using the first.`,
      );
    if (idx.length) plotCols.set(k, idx[0]!);
  }
  if (plotCols.size && plotCols.size < PLOT_KEYS.length)
    warnings.push(
      `Only some of the script's plot columns were found (${[...plotCols.keys()].join(', ')}).`,
    );
  const candles: Candle[] = [];
  const plots = plotCols.size ? new Map<number, PlotRow>() : null;
  for (const line of lines.slice(1)) {
    const f = csvLine(line);
    const time = parseTime(f[ti]!);
    const o = num(f[oi]);
    const h = num(f[hi]);
    const l = num(f[li]);
    const c = num(f[ci]);
    if (o === null || h === null || l === null || c === null) continue;
    candles.push({
      time,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: vi >= 0 ? (num(f[vi]) ?? 0) : 0,
    });
    if (plots) {
      const row = {} as PlotRow;
      for (const k of PLOT_KEYS) row[k] = plotCols.has(k) ? num(f[plotCols.get(k)!]) : null;
      plots.set(time, row);
    }
  }
  return { candles, plots, format: plots ? 'csv with script plots' : 'csv' };
}

function fromJson(data: unknown): Omit<CandleFile, 'warnings'> {
  const o = data as { data?: { candles?: unknown }; candles?: unknown } | unknown[];
  const arr = Array.isArray(o) ? o : (o.data?.candles ?? o.candles);
  if (!Array.isArray(arr))
    throw new Error('JSON has no candles (expected an array, .candles or .data.candles)');
  const candles: Candle[] = [];
  for (const x of arr) {
    let c: (string | number | null | undefined)[];
    if (Array.isArray(x)) c = x as (string | number)[];
    else {
      const r = x as Record<string, string | number | undefined>;
      c = [r.time ?? r.date ?? r.timestamp, r.open, r.high, r.low, r.close, r.volume];
    }
    const o = num(c[1]);
    const h = num(c[2]);
    const l = num(c[3]);
    const cl = num(c[4]);
    if (
      c[0] === undefined ||
      c[0] === null ||
      o === null ||
      h === null ||
      l === null ||
      cl === null
    )
      continue;
    candles.push({
      time: parseTime(c[0]),
      open: o,
      high: h,
      low: l,
      close: cl,
      volume: num(c[5]) ?? 0,
    });
  }
  return { candles, plots: null, format: Array.isArray(arr[0]) ? 'kite json' : 'json' };
}

/** Reads candles from TradingView's CSV export, a Kite CSV, Kite's JSON or an app export. */
export function parseCandleFile(text: string): CandleFile {
  const warnings: string[] = [];
  const t = text.trimStart();
  const parsed =
    t.startsWith('{') || t.startsWith('[') ? fromJson(JSON.parse(t)) : fromCsv(t, warnings);
  // Oldest first, one bar per time (the last one wins), on minute boundaries.
  const byTime = new Map<number, Candle>();
  let unaligned = 0;
  for (const c of parsed.candles) {
    if (c.time % 60 !== 0) unaligned++;
    byTime.set(c.time, c);
  }
  if (unaligned) warnings.push(`${unaligned} bars don't start on a minute boundary.`);
  if (byTime.size < parsed.candles.length)
    warnings.push(`${parsed.candles.length - byTime.size} duplicate bar times (kept the last).`);
  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  return { ...parsed, candles, warnings };
}

export interface RunOptions {
  /** IST day whose call log to show; candles after it are ignored. */
  day: string;
  /** Keep only the last N bars up to the end of the day (null: all of them). */
  warmup: number | null;
  /** Drop index bars after 15:14, as the app does with Kite candles. */
  trim: boolean;
  settings: B2BSettings;
  pivotTie: PivotTie;
  /** Ignore bars before this time (epoch s), to start two runs on the same bar. */
  from?: number;
}

export interface ScriptRun {
  /** The bars the engine ran on, and the index bars after 15:14 that were left out. */
  used: Candle[];
  dropped: Candle[];
  res: B2BResult;
}

/** Candles up to the end of a day, without the bars after 15:14 the app ignores for indices. */
export function inAppSession(candles: readonly Candle[], day: string): Candle[] {
  return [...tradingViewIndexSession(candles.filter((c) => istDay(c.time) <= day))];
}

export function runScript(candles: readonly Candle[], o: RunOptions): ScriptRun {
  const upTo = candles.filter(
    (c) => istDay(c.time) <= o.day && (o.from === undefined || c.time >= o.from),
  );
  const sliced = o.warmup === null ? upTo : upTo.slice(-o.warmup);
  const used = o.trim ? [...tradingViewIndexSession(sliced)] : sliced;
  const kept = new Set(used.map((c) => c.time));
  return {
    used,
    dropped: sliced.filter((c) => !kept.has(c.time)),
    res: runB2B(used, { settings: o.settings, pivotTie: o.pivotTie }),
  };
}

/** The day's call log as the panel and the Pine table show it, oldest first, every row. */
export function logTable(
  res: B2BResult,
  S: B2BSettings,
  day: string,
): { totals: string; titles: string[]; rows: string[][] } {
  const onDay = res.lastTime !== null && istDay(res.lastTime) === day;
  const v = b2bLogView(res, { ...S, logRows: Infinity }, null);
  if (!onDay) return { totals: `no candles on ${day}`, titles: v.titles, rows: [] };
  return {
    totals: v.header
      .slice(1)
      .map((c) => c.text)
      .join(' | '),
    titles: v.titles,
    rows: v.rows.map((r) => r.cells.map((c) => c.text)).reverse(),
  };
}

export function alertLines(res: B2BResult, day: string): string[] {
  return res.alerts.filter((a) => istDay(a.time) === day).flatMap((a) => a.lines);
}

/** Pads columns into a plain-text table. `marks` prefixes each row (e.g. a flag). */
export function textTable(titles: string[], rows: string[][], marks?: string[]): string {
  const all = [titles, ...rows];
  const w = titles.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  const markW = marks
    ? Math.max(0, ...marks.map((m) => m.length)) + (marks.some(Boolean) ? 1 : 0)
    : 0;
  const pre = (i: number) => (marks ? (i < 0 ? '' : (marks[i] ?? '')).padEnd(markW) : '');
  const line = (r: string[]) =>
    r
      .map((c, i) => (c ?? '').padEnd(w[i]!))
      .join('  ')
      .trimEnd();
  return [pre(-1) + line(titles), ...rows.map((r, i) => pre(i) + line(r))].join('\n');
}

export interface BarDiff {
  time: number;
  dOpen: number;
  dHigh: number;
  dLow: number;
  dClose: number;
}

export interface CandleDiff {
  /** Overlapping range of the two files (epoch s), or null if they don't overlap. */
  range: [number, number] | null;
  /** Bars inside the overlap that only one file has. */
  onlyA: number[];
  onlyB: number[];
  /** First bar in the overlap whose OHLC differs by more than the tolerance. */
  first: BarDiff | null;
  /** Bars of the day differing by more than the tolerance (b - a). */
  day: BarDiff[];
  dayBars: number;
  maxHigh: BarDiff | null;
  maxLow: BarDiff | null;
  maxClose: BarDiff | null;
}

/** Compares two candle series bar by bar (differences are b - a). */
export function diffCandles(
  a: readonly Candle[],
  b: readonly Candle[],
  day: string,
  tol: number,
): CandleDiff {
  const empty: CandleDiff = {
    range: null,
    onlyA: [],
    onlyB: [],
    first: null,
    day: [],
    dayBars: 0,
    maxHigh: null,
    maxLow: null,
    maxClose: null,
  };
  if (!a.length || !b.length) return empty;
  const from = Math.max(a[0]!.time, b[0]!.time);
  const to = Math.min(a.at(-1)!.time, b.at(-1)!.time);
  if (from > to) return empty;
  const inR = (c: Candle) => c.time >= from && c.time <= to;
  const ma = new Map(a.filter(inR).map((c) => [c.time, c]));
  const mb = new Map(b.filter(inR).map((c) => [c.time, c]));
  const out: CandleDiff = { ...empty, range: [from, to] };
  out.onlyA = [...ma.keys()].filter((t) => !mb.has(t));
  out.onlyB = [...mb.keys()].filter((t) => !ma.has(t));
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const pick = (cur: BarDiff | null, d: BarDiff, k: 'dHigh' | 'dLow' | 'dClose') =>
    !cur || Math.abs(d[k]) > Math.abs(cur[k]) ? d : cur;
  for (const [t, ca] of [...ma.entries()].sort((x, y) => x[0] - y[0])) {
    const cb = mb.get(t);
    if (!cb) continue;
    const d: BarDiff = {
      time: t,
      dOpen: r2(cb.open - ca.open),
      dHigh: r2(cb.high - ca.high),
      dLow: r2(cb.low - ca.low),
      dClose: r2(cb.close - ca.close),
    };
    const differs = [d.dOpen, d.dHigh, d.dLow, d.dClose].some((x) => Math.abs(x) > tol + 1e-9);
    if (differs && !out.first) out.first = d;
    if (istDay(t) !== day) continue;
    out.dayBars++;
    if (differs) out.day.push(d);
    out.maxHigh = pick(out.maxHigh, d, 'dHigh');
    out.maxLow = pick(out.maxLow, d, 'dLow');
    out.maxClose = pick(out.maxClose, d, 'dClose');
  }
  return out;
}

export interface PlotCheck {
  /** Bars present in both the run and the export. */
  compared: number;
  mismatched: number;
  first: { time: number; key: PlotKey; engine: number | null; tv: number | null } | null;
}

/** Compares the engine's plotted trade state with the script's own plots from TradingView. */
export function checkPlots(res: B2BResult, tv: Map<number, PlotRow>, tol = 0.005): PlotCheck {
  const out: PlotCheck = { compared: 0, mismatched: 0, first: null };
  for (const p of res.plots) {
    const row = tv.get(p.time);
    if (!row) continue;
    out.compared++;
    let bad: PlotKey | null = null;
    for (const k of PLOT_KEYS) {
      const e = p[k];
      const t = row[k];
      if ((e === null) !== (t === null) || (e !== null && t !== null && Math.abs(e - t) > tol)) {
        bad = k;
        break;
      }
    }
    if (bad) {
      out.mismatched++;
      if (!out.first) out.first = { time: p.time, key: bad, engine: p[bad], tv: row[bad] };
    }
  }
  return out;
}

export type MatchKind = 'same' | 'price' | 'decision';

export interface LogMatch {
  t: string;
  a: B2BLogRow | undefined;
  b: B2BLogRow | undefined;
  kind: MatchKind;
  why: string;
}

/** "L1 +9.35 / L2 COST" -> "L1 # / L2 COST": the result without its numbers. */
const resultKind = (r: string) => r.replace(/[+-]?\d+(\.\d+)?/g, '#');

/**
 * Pairs two call logs by entry time. A "decision" difference is a call only one
 * side made, or a different option, exit time or kind of result; a "price"
 * difference is the same trade at slightly different prices.
 */
export function matchLogs(
  a: readonly B2BLogRow[],
  b: readonly B2BLogRow[],
  ptsTol = 0.01,
): LogMatch[] {
  const times = [...new Set([...a.map((r) => r.t), ...b.map((r) => r.t)])].sort();
  return times.map((t) => {
    const ra = a.find((r) => r.t === t);
    const rb = b.find((r) => r.t === t);
    if (!ra || !rb)
      return { t, a: ra, b: rb, kind: 'decision', why: ra ? 'only in A' : 'only in B' };
    const why: string[] = [];
    if (ra.dir !== rb.dir || ra.opt !== rb.opt) why.push(`option ${ra.opt} vs ${rb.opt}`);
    if (resultKind(ra.res) !== resultKind(rb.res)) why.push(`result ${ra.res} vs ${rb.res}`);
    if (ra.l1T !== rb.l1T) why.push(`lot 1 out ${ra.l1T} vs ${rb.l1T}`);
    if (ra.xT !== rb.xT) why.push(`out ${ra.xT} vs ${rb.xT}`);
    if (why.length) return { t, a: ra, b: rb, kind: 'decision', why: why.join('; ') };
    const dp = (rb.tot ?? 0) - (ra.tot ?? 0);
    if (Math.abs(dp) > ptsTol || ra.ent !== rb.ent)
      return {
        t,
        a: ra,
        b: rb,
        kind: 'price',
        why: `entry ${ra.ent} vs ${rb.ent}, pts d${dp.toFixed(2)}`,
      };
    return { t, a: ra, b: rb, kind: 'same', why: '' };
  });
}

/** A short row for side-by-side logs. */
export function brief(r: B2BLogRow | undefined): string {
  if (!r) return '-';
  const tot = r.tot === null ? '' : ` ${r.tot >= 0 ? '+' : ''}${Math.round(r.tot * 100) / 100}`;
  return `${r.opt} @${r.ent ?? ''} -> ${r.res}${tot}`;
}

/** The engine's state after a bar (re-run on the bars up to it), for a divergence report. */
export function stateAt(
  candles: readonly Candle[],
  time: number,
  settings: B2BSettings,
  pivotTie: PivotTie,
): string[] {
  const upTo = candles.filter((c) => c.time <= time);
  const res = runB2B(upTo, { settings, pivotTie });
  const s = res.state;
  const z = (zs: B2BResult['bull']) =>
    zs.map((x) => `${x.kind} ${x.bot}-${x.top} from ${istDay(x.leftTime)} ${hhmm(x.leftTime)}`);
  const piv = res.pivots
    .slice(-6)
    .map((p) => `${p.kind} ${p.price} at ${hhmm(p.time)} (confirmed ${hhmm(p.confirmedAt)})`);
  const last = upTo
    .slice(-3)
    .map((c) => `${hhmm(c.time)} O ${c.open} H ${c.high} L ${c.low} C ${c.close}`);
  return [
    `bars ${upTo.length}, last ${istDay(time)} ${hhmm(time)}`,
    `position ${s.pos === 0 ? 'flat' : s.pos === 1 ? 'long' : 'short'}${s.pos ? ` entry ${s.ent} SL1 ${s.sl1} SL2 ${s.sl2} stage ${s.stage} peak ${s.pkPts}` : ''}`,
    `pending ${s.pend} | last zone event ${s.lastBlk} ${s.lastBlkT}`,
    `ATR buffer ${res.invBuf === null ? '-' : res.invBuf.toFixed(3)}`,
    'bull zones: ' + (z(res.bull).join('; ') || '-'),
    'bear zones: ' + (z(res.bear).join('; ') || '-'),
    'recent swing points: ' + (piv.join('; ') || '-'),
    'last bars: ' + last.join(' | '),
  ];
}

/** Pivots one tie rule finds on the day that the other doesn't. */
export function pivotDifferences(a: B2BResult, b: B2BResult, day: string): string[] {
  const key = (p: B2BResult['pivots'][number]) => `${p.kind} ${p.price} at ${hhmm(p.time)}`;
  const ka = new Set(a.pivots.filter((p) => istDay(p.time) === day).map(key));
  const kb = new Set(b.pivots.filter((p) => istDay(p.time) === day).map(key));
  return [
    ...[...ka].filter((k) => !kb.has(k)).map((k) => `older only: ${k}`),
    ...[...kb].filter((k) => !ka.has(k)).map((k) => `newer only: ${k}`),
  ];
}

export interface AppMatch {
  t: string;
  offline: B2BLogRow | undefined;
  live: PaperTrade | undefined;
  flag: string;
}

/**
 * Lines up the engine's log (on Kite's final candles) with what the live paper
 * trader did. A call only one side has usually means Kite corrected a candle
 * after the live call, the trader wasn't running, or the settings differed.
 */
export function matchApp(
  log: readonly B2BLogRow[],
  trades: readonly PaperTrade[],
  day: string,
  /** "hh:mm" of calls the live trader recorded as MISSED (they came in late). */
  missed: ReadonlySet<string> = new Set(),
): AppMatch[] {
  const live = trades.filter((t) => t.day === day);
  const tOf = (t: PaperTrade) => hhmm(t.signalTime);
  const times = [...new Set([...log.map((r) => r.t), ...live.map(tOf)])].sort();
  return times.map((t) => {
    const r = log.find((x) => x.t === t && x.ent !== null);
    const p = live.find((x) => tOf(x) === t);
    let flag = '';
    if (r && !p && missed.has(t))
      flag = 'MISSED LIVE (the call came in late: machine asleep or feed down)';
    else if (r && !p)
      flag = 'NOT TAKEN LIVE (trader off or asleep, or the live run was in another trade)';
    else if (p && !r)
      flag =
        'LIVE ONLY (the live run saw other candles: a gap after a stall, or one Kite corrected later)';
    else if (r && p && p.result !== null && resultKind(p.result) !== resultKind(r.res))
      flag = `RESULT DIFFERS (live: ${p.result})`;
    if (p?.notes.length) flag = [flag, `notes: ${p.notes.join('; ')}`].filter(Boolean).join(' | ');
    return { t, offline: r, live: p, flag };
  });
}

/** Minutes after 09:15 IST, the first NSE bar of the day. */
const minuteOfSession = (epochS: number) => {
  const p = toIstParts(epochS * 1000);
  return p.hour * 60 + p.minute - (9 * 60 + 15);
};
const ticks = (x: number) => Math.round(x * 20);

/** Kite's candles for some days, packed for a Pine script: chunks of "m,c,o-c,h-c,c-l;" in ticks. */
export function packDays(
  candles: readonly Candle[],
  days: readonly string[],
): { day: string; base: number; chunks: string[]; bars: number }[] {
  return days.map((day) => {
    const bars = candles.filter((c) => istDay(c.time) === day);
    if (!bars.length) throw new Error(`No Kite candles on ${day}`);
    const base = ticks(bars[0]!.close);
    const chunks: string[] = [];
    let cur = '';
    for (const b of bars) {
      const c = ticks(b.close);
      const rec = `${minuteOfSession(b.time)},${c - base},${ticks(b.open) - c},${ticks(b.high) - c},${c - ticks(b.low)};`;
      if (cur.length + rec.length > 1800) {
        chunks.push(cur);
        cur = '';
      }
      cur += rec;
    }
    if (cur) chunks.push(cur);
    return { day, base, chunks, bars: bars.length };
  });
}

/** Reverses packDays (for tests and for rebuilding TradingView's candles from the differences). */
export function unpackDay(
  base: number,
  chunks: readonly string[],
): Map<number, [number, number, number, number]> {
  const out = new Map<number, [number, number, number, number]>();
  for (const rec of chunks.join('').split(';')) {
    if (!rec) continue;
    const [m, c, oc, hc, cl] = rec.split(',').map(Number) as [
      number,
      number,
      number,
      number,
      number,
    ];
    const close = base + c;
    out.set(m, [close + oc, close + hc, close - cl, close]);
  }
  return out;
}

/**
 * A Pine script that carries Kite's candles for the given days and, on
 * TradingView's NIFTY 50 1-minute chart, lists every bar whose open, high, low
 * or close differs from Kite's, in ticks of 0.05 (TradingView − Kite), plus
 * bars only one side has. With the differences, TradingView's candles can be
 * rebuilt exactly without a paid chart export.
 */
export function pineDiffScript(candles: readonly Candle[], days: readonly string[]): string {
  const packed = packDays(candles, days);
  const q = (s: string) => `"${s}"`;
  const cDay: number[] = [];
  const cTxt: string[] = [];
  packed.forEach((p, i) =>
    p.chunks.forEach((c) => {
      cDay.push(i);
      cTxt.push(c);
    }),
  );
  const last = days.at(-1)!;
  return `//@version=6
// Generated by pnpm b2b:pine-diff. It contains Kite's 1-minute NIFTY 50 candles for
// ${days.join(', ')}: keep it private (don't publish it). Add it to TradingView's
// NIFTY 50 1-minute chart, choose a day and page, and screenshot the table. Numbers are
// TradingView minus Kite in ticks of 0.05 ("." = same). "*" rows are bars only
// TradingView has (its prices shown). Scroll the chart back until the day is loaded.
indicator("Kite vs TradingView (N-B2B parity)", overlay = true)

DAY = input.string(${q(last)}, "Day", options = [${days.map(q).join(', ')}])
PAGE = input.int(1, "Page", minval = 1)
ROWS = input.int(30, "Rows per column (fewer if the table is cut off)", minval = 5, maxval = 40)
const string TZ = "Asia/Kolkata"
const int NONE = -999999

var array<string> DAYS = array.from(${days.map(q).join(', ')})
var array<int> BASES = array.from(${packed.map((p) => p.base).join(', ')})
var array<int> CDAY = array.from(${cDay.join(', ')})
var array<string> CTXT = array.from(
     ${cTxt.map(q).join(',\n     ')})

var array<int> kO = array.new<int>(400, NONE)
var array<int> kH = array.new<int>(400, NONE)
var array<int> kL = array.new<int>(400, NONE)
var array<int> kC = array.new<int>(400, NONE)
var array<bool> seen = array.new<bool>(400, false)
var array<string> eT = array.new<string>()
var array<string> eO = array.new<string>()
var array<string> eH = array.new<string>()
var array<string> eL = array.new<string>()
var array<string> eC = array.new<string>()
var int tvBars = 0
var int kBars = 0

if barstate.isfirst
    int sel = array.indexof(DAYS, DAY)
    int base = array.get(BASES, sel)
    for i = 0 to array.size(CTXT) - 1
        if array.get(CDAY, i) == sel
            for rec in str.split(array.get(CTXT, i), ";")
                if str.length(rec) > 0
                    array<string> f = str.split(rec, ",")
                    int m = int(str.tonumber(array.get(f, 0)))
                    int c = base + int(str.tonumber(array.get(f, 1)))
                    array.set(kC, m, c)
                    array.set(kO, m, c + int(str.tonumber(array.get(f, 2))))
                    array.set(kH, m, c + int(str.tonumber(array.get(f, 3))))
                    array.set(kL, m, c - int(str.tonumber(array.get(f, 4))))
                    kBars += 1

sig(int d) =>
    d == 0 ? "." : (d > 0 ? "+" : "") + str.tostring(d)
num(string s) =>
    nz(str.tonumber(str.replace_all(s, "+", "")))
hhmm(int m) =>
    str.format("{0,number,00}:{1,number,00}", math.floor((m + 555) / 60), (m + 555) % 60)

if str.format_time(time, "yyyy-MM-dd", TZ) == DAY
    int m = hour(time, TZ) * 60 + minute(time, TZ) - 555
    if m >= 0 and m < 400
        tvBars += 1
        array.set(seen, m, true)
        string hm = str.format_time(time, "HH:mm", TZ)
        if array.get(kC, m) == NONE
            array.push(eT, hm + "*")
            array.push(eO, str.tostring(open))
            array.push(eH, str.tostring(high))
            array.push(eL, str.tostring(low))
            array.push(eC, str.tostring(close))
        else
            int dO = math.round(open * 20) - array.get(kO, m)
            int dH = math.round(high * 20) - array.get(kH, m)
            int dL = math.round(low * 20) - array.get(kL, m)
            int dC = math.round(close * 20) - array.get(kC, m)
            if dO != 0 or dH != 0 or dL != 0 or dC != 0
                array.push(eT, hm)
                array.push(eO, sig(dO))
                array.push(eH, sig(dH))
                array.push(eL, sig(dL))
                array.push(eC, sig(dC))

var table info = table.new(position.bottom_left, 1, 3, bgcolor = color.new(color.black, 0), border_width = 1)
var table tb = table.new(position.top_right, 20, ROWS + 3, bgcolor = color.new(color.black, 0), border_width = 1)
if barstate.islast
    string kOnly = ""
    int kn = 0
    for m = 0 to 399
        if array.get(kC, m) != NONE and not array.get(seen, m)
            kn += 1
            if kn <= 20
                kOnly += " " + hhmm(m)
    int n = array.size(eT)
    int per = ROWS * 4
    int pages = math.max(1, math.ceil(n / per))
    table.cell(info, 0, 0, DAY + " | TradingView bars " + str.tostring(tvBars) + " | Kite bars " + str.tostring(kBars) + " | differing " + str.tostring(n) + " | page " + str.tostring(PAGE) + " of " + str.tostring(pages), text_color = color.white, text_size = size.small)
    table.cell(info, 0, 1, "Kite only " + str.tostring(kn) + ":" + kOnly + (kn > 20 ? " ..." : ""), text_color = color.white, text_size = size.small)
    for g = 0 to 3
        table.cell(tb, g * 5, 0, "IST", text_color = color.white, text_size = size.small)
        table.cell(tb, g * 5 + 1, 0, "O", text_color = color.white, text_size = size.small)
        table.cell(tb, g * 5 + 2, 0, "H", text_color = color.white, text_size = size.small)
        table.cell(tb, g * 5 + 3, 0, "L", text_color = color.white, text_size = size.small)
        table.cell(tb, g * 5 + 4, 0, "C", text_color = color.white, text_size = size.small)
    int start = (PAGE - 1) * per
    int rowsOnPage = 0
    float sO = 0
    float sH = 0
    float sL = 0
    float sC = 0
    for j = 0 to per - 1
        int k = start + j
        if k < n
            int col = math.floor(j / ROWS) * 5
            int row = j % ROWS + 1
            rowsOnPage += 1
            table.cell(tb, col, row, array.get(eT, k), text_color = color.white, text_size = size.small)
            table.cell(tb, col + 1, row, array.get(eO, k), text_color = color.white, text_size = size.small)
            table.cell(tb, col + 2, row, array.get(eH, k), text_color = color.white, text_size = size.small)
            table.cell(tb, col + 3, row, array.get(eL, k), text_color = color.white, text_size = size.small)
            table.cell(tb, col + 4, row, array.get(eC, k), text_color = color.white, text_size = size.small)
            if not str.contains(array.get(eT, k), "*")
                sO += num(array.get(eO, k))
                sH += num(array.get(eH, k))
                sL += num(array.get(eL, k))
                sC += num(array.get(eC, k))
    table.cell(info, 0, 2, "page check: rows " + str.tostring(rowsOnPage) + " | sum O " + str.tostring(sO) + " H " + str.tostring(sH) + " L " + str.tostring(sL) + " C " + str.tostring(sC), text_color = color.yellow, text_size = size.small)
`;
}
