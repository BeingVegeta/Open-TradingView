/*
 * pnpm b2b:compare - does the N-B2B port reproduce TradingView? See docs/B2B_PARITY.md.
 *
 *   pnpm b2b:compare --tv data/tv-nifty-1m.csv
 *   pnpm b2b:compare --tv data/tv.csv --kite data/paper-2026-10-19.json --day 2026-10-19
 *   pnpm b2b:compare --app-log data/paper-2026-10-19.json
 *
 * Reads files only; sends nothing anywhere.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  B2B_DEFAULTS,
  formatIstDateTime,
  sanitizeB2BSettings,
  type B2BSettings,
  type Candle,
  type PaperTrade,
  type PivotTie,
} from '@otv/shared';
import {
  alertLines,
  brief,
  checkPlots,
  diffCandles,
  istDay,
  logTable,
  matchApp,
  matchLogs,
  parseCandleFile,
  pivotDifferences,
  runScript,
  stateAt,
  textTable,
  withoutClosingPrints,
  type CandleFile,
  type ScriptRun,
} from '../src/b2b/compare';
import { settingsHash } from '../src/paper/paperTrader';

/** Bars the dashboard and the paper trader load (B2B_WARMUP_BARS / WARMUP in the app). */
const APP_WARMUP = 5000;

const { values: a } = parseArgs({
  options: {
    tv: { type: 'string' },
    kite: { type: 'string' },
    'app-log': { type: 'string' },
    day: { type: 'string' },
    tol: { type: 'string', default: '0.05' },
    warmup: { type: 'string' },
    settings: { type: 'string' },
    'pivot-tie': { type: 'string', default: 'newer' },
    bars: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

const USAGE = `pnpm b2b:compare [--tv FILE] [--kite FILE] [--app-log FILE] [options]

  --tv FILE        TradingView "Export chart data" CSV of NIFTY 1m (with the N-B2B
                   indicator on the chart, its plots are checked bar by bar)
  --kite FILE      Kite candles: CSV, Kite JSON ([ts,o,h,l,c,v] rows) or an app export
  --app-log FILE   The app's export (/api/paper/export?day=...): live paper trades, and
                   its candles if --kite isn't given
  --day YYYY-MM-DD Day to report (default: the newest day in the files)
  --tol N          OHLC difference that counts (default 0.05)
  --warmup N|all   Bars up to the end of the day to run on (default: all of a TV file
                   or an app export, the last ${APP_WARMUP} of a Kite file, as the app loads)
  --settings X     JSON file or inline JSON of script inputs, or "app" for the export's
                   (default: the script's defaults)
  --pivot-tie T    older | newer: which of two equal highs/lows is the swing point
                   (default newer, as Pine; older is the app's rule before 21-Oct-2026)
  --bars           List every differing bar of the day, not just the first 40`;

if (a.help || (!a.tv && !a.kite && !a['app-log'])) {
  console.log(USAGE);
  process.exit(a.help ? 0 : 1);
}

const out = (s = '') => console.log(s);
const section = (title: string) =>
  out(`\n=== ${title} ${'='.repeat(Math.max(0, 76 - title.length))}`);
const at = (s: number) => formatIstDateTime(s * 1000).slice(0, 16);

function load(path: string, label: string): CandleFile {
  const f = parseCandleFile(readFileSync(path, 'utf8'));
  const c = f.candles;
  out(
    `${label}: ${path} (${f.format}), ${c.length} bars` +
      (c.length ? `, ${at(c[0]!.time)} -> ${at(c.at(-1)!.time)} IST` : ''),
  );
  for (const w of f.warnings) out(`  ! ${w}`);
  return f;
}

interface AppExport {
  day?: string;
  settings?: unknown;
  settingsHash?: string;
  trades?: PaperTrade[];
  events?: { kind: string; text: string }[];
  candles?: unknown[];
}

section('Inputs');
const tv = a.tv ? load(a.tv, 'TradingView') : null;
let appLog: AppExport | null = null;
let appTrades: PaperTrade[] = [];
if (a['app-log']) {
  const raw = JSON.parse(readFileSync(a['app-log'], 'utf8')) as AppExport | PaperTrade[];
  appLog = Array.isArray(raw) ? { trades: raw } : raw;
  appTrades = appLog.trades ?? [];
  out(`App log: ${a['app-log']}, ${appTrades.length} paper trades`);
}
let kite: CandleFile | null = null;
/** Candles from the export are exactly what the trader held: replay all of them. */
let kiteFromApp = false;
if (a.kite) kite = load(a.kite, 'Kite');
else if (appLog?.candles?.length && a['app-log']) {
  kite = load(a['app-log'], 'Kite (the candles the paper trader ran on)');
  kiteFromApp = true;
}

const tie = a['pivot-tie'] as PivotTie;
if (tie !== 'older' && tie !== 'newer') throw new Error('--pivot-tie must be older or newer');
const tol = Number(a.tol);

let settings: B2BSettings = B2B_DEFAULTS;
if (a.settings === 'app') {
  if (!appLog?.settings) throw new Error('--settings app needs an --app-log export with settings');
  settings = sanitizeB2BSettings(appLog.settings);
} else if (a.settings) {
  const s = a.settings.trim();
  const o: unknown = JSON.parse(s.startsWith('{') ? s : readFileSync(s, 'utf8'));
  settings = sanitizeB2BSettings({ ...B2B_DEFAULTS, ...(o as object) });
}
const changed = (Object.keys(B2B_DEFAULTS) as (keyof B2BSettings)[]).filter(
  (k) => settings[k] !== B2B_DEFAULTS[k],
);
out(
  `Settings: ${settingsHash(settings)}` +
    (changed.length
      ? ` (changed: ${changed.map((k) => `${k}=${settings[k]}`).join(', ')})`
      : ' (defaults)') +
    ` | pivot tie: ${tie}`,
);
if (appLog?.settingsHash && appLog.settingsHash !== settingsHash(settings))
  out(`  ! The app ran with settings ${appLog.settingsHash}; add --settings app to use them.`);

const days = (f: CandleFile | null) => new Set(f?.candles.map((c) => istDay(c.time)) ?? []);
const tvDays = days(tv);
const kiteDays = days(kite);
const day =
  a.day ??
  [...(tv && kite ? [...tvDays].filter((d) => kiteDays.has(d)) : [...tvDays, ...kiteDays])]
    .sort()
    .at(-1);
if (!day) throw new Error('No day to report: the files have no common day');
out(`Day: ${day}`);
const kiteHasDay = !kite || kiteDays.has(day);
const tvHasDay = !tv || tvDays.has(day);
if (!kiteHasDay) out(`  ! The Kite candles have no bars on ${day} (a holiday?).`);
if (!tvHasDay) out(`  ! The TradingView file has no bars on ${day}.`);
if (!kiteHasDay && !tvHasDay) process.exit(0);

const warmupFor = (isTv: boolean): number | null =>
  a.warmup === 'all' ? null : a.warmup ? Number(a.warmup) : isTv || kiteFromApp ? null : APP_WARMUP;

function printLog(run: ScriptRun, title: string): void {
  const t = logTable(run.res, settings, day!);
  out(`${title}: ${t.totals}`);
  out(t.rows.length ? textTable(t.titles, t.rows) : '(no calls)');
}

function describeRun(run: ScriptRun): string {
  const u = run.used;
  return `${u.length} bars from ${u.length ? at(u[0]!.time) : '-'}${
    run.dropped.length ? `, ${run.dropped.length} closing-print bars dropped` : ''
  }`;
}

// ---------------------------------------------------------------- TradingView
if (tv && tvHasDay) {
  section('Engine on TradingView candles (as TradingView ran the script)');
  const opts = (pivotTie: PivotTie) => ({
    day: day!,
    warmup: warmupFor(true),
    trim: false,
    settings,
    pivotTie,
  });
  const runs = {
    older: runScript(tv.candles, opts('older')),
    newer: runScript(tv.candles, opts('newer')),
  };
  const tvRun = runs[tie];
  out(describeRun(tvRun));
  if (tv.plots) {
    out("Bar-by-bar check against the script's own plots in the export:");
    for (const r of ['older', 'newer'] as const) {
      const c = checkPlots(runs[r].res, tv.plots);
      out(
        `  pivot tie ${r}: ${c.compared} bars compared, ${c.mismatched} differ` +
          (c.first
            ? ` - first at ${at(c.first.time)}: ${c.first.key} engine ${c.first.engine ?? 'na'} vs TradingView ${c.first.tv ?? 'na'}`
            : ' - reproduces TradingView on every bar'),
      );
    }
    const mine = checkPlots(tvRun.res, tv.plots);
    if (mine.first) {
      out(
        `\nFIRST DIVERGING BAR (pivot tie ${tie}): ${at(mine.first.time)}. Engine state after it:`,
      );
      for (const l of stateAt(tvRun.used, mine.first.time, settings, tie)) out('  ' + l);
    }
  } else {
    out(
      '  (no script plot columns: export with the N-B2B indicator on the chart to check every bar;\n' +
        '   until then compare the call log below with the CALL LOG table on TradingView)',
    );
  }
  const pd = pivotDifferences(runs.older.res, runs.newer.res, day);
  out(
    `Swing points the two tie rules disagree on, ${day}: ` +
      (pd.length ? '\n  ' + pd.join('\n  ') : 'none'),
  );
  printLog(tvRun, `\nCall log ${day} (oldest first)`);
  out('\nAlerts:');
  for (const l of alertLines(tvRun.res, day)) out('  ' + l);
}

// ---------------------------------------------------------------------- Kite
let kiteRun: ScriptRun | null = null;
if (kite && kiteHasDay) {
  section('Engine on Kite candles (as the app runs it)');
  kiteRun = runScript(kite.candles, {
    day,
    warmup: warmupFor(false),
    trim: true,
    settings,
    pivotTie: tie,
  });
  out(describeRun(kiteRun));
  if (kiteRun.dropped.length)
    out('  dropped: ' + kiteRun.dropped.map((c) => `${at(c.time)} C ${c.close}`).join(', '));
  printLog(kiteRun, `\nCall log ${day} (oldest first)`);
  out('\nAlerts:');
  for (const l of alertLines(kiteRun.res, day)) out('  ' + l);
}

// ------------------------------------------------------------ TV against Kite
if (tv && kite && tvHasDay && kiteHasDay) {
  section('Candles: Kite - TradingView');
  const d = diffCandles(tv.candles, kite.candles, day, tol);
  if (!d.range) out('The two files have no bars in common.');
  else {
    out(`Overlap ${at(d.range[0])} -> ${at(d.range[1])}`);
    if (d.onlyA.length)
      out(`  only in TradingView: ${d.onlyA.length} bars, first ${at(d.onlyA[0]!)}`);
    if (d.onlyB.length) out(`  only in Kite: ${d.onlyB.length} bars, first ${at(d.onlyB[0]!)}`);
    const f = d.first;
    out(
      f
        ? `First bar differing by more than ${tol}: ${at(f.time)} (dO ${f.dOpen} dH ${f.dHigh} dL ${f.dLow} dC ${f.dClose})`
        : `No bar differs by more than ${tol}.`,
    );
    const used = diffCandles(tv.candles, withoutClosingPrints(kite.candles, day), day, tol).first;
    if (used && used.time !== f?.time)
      out(
        `First one among the bars the app uses (closing prints left out): ${at(used.time)} ` +
          `(dO ${used.dOpen} dH ${used.dHigh} dL ${used.dLow} dC ${used.dClose})`,
      );
    out(`${day}: ${d.day.length} of ${d.dayBars} bars differ by more than ${tol}`);
    const mx = (n: string, b: typeof d.maxHigh, k: 'dHigh' | 'dLow' | 'dClose') =>
      b && b[k] !== 0 ? `max |d${n}| ${Math.abs(b[k])} at ${at(b.time).slice(11)}` : `no d${n}`;
    out(
      '  ' +
        [
          mx('high', d.maxHigh, 'dHigh'),
          mx('low', d.maxLow, 'dLow'),
          mx('close', d.maxClose, 'dClose'),
        ].join(', '),
    );
    const dropped = new Set(kiteRun?.dropped.map((c) => c.time));
    const list = a.bars ? d.day : d.day.slice(0, 40);
    if (list.length)
      out(
        textTable(
          ['Time', 'dOpen', 'dHigh', 'dLow', 'dClose', ''],
          list.map((x) => [
            at(x.time).slice(11),
            String(x.dOpen),
            String(x.dHigh),
            String(x.dLow),
            String(x.dClose),
            dropped.has(x.time) ? 'closing print (ignored by the app)' : '',
          ]),
        ),
      );
    if (list.length < d.day.length)
      out(`  ... ${d.day.length - list.length} more (--bars lists all)`);
  }

  section('Call logs side by side, both runs starting on the same bar');
  const from = Math.max(tv.candles[0]!.time, kite.candles[0]!.time);
  const common = { day, warmup: null, settings, pivotTie: tie, from };
  const tvC = runScript(tv.candles, { ...common, trim: false });
  const kC = runScript(kite.candles, { ...common, trim: true });
  out(`TradingView: ${describeRun(tvC)}\nKite:        ${describeRun(kC)}`);
  out(`TradingView: ${logTable(tvC.res, settings, day).totals}`);
  out(`Kite:        ${logTable(kC.res, settings, day).totals}`);
  const m = matchLogs(
    tvC.res.log.filter((r) => r.ent !== null),
    kC.res.log.filter((r) => r.ent !== null),
  );
  const firstDecision = m.findIndex((x) => x.kind === 'decision');
  out(
    textTable(
      ['In', 'TradingView', 'Kite', 'Why'],
      m.map((x) => [x.t, brief(x.a), brief(x.b), x.why]),
      m.map((x, i) =>
        i === firstDecision
          ? '>> FIRST'
          : x.kind === 'decision'
            ? '!'
            : x.kind === 'price'
              ? '~'
              : '',
      ),
    ),
  );
  out(
    "'!' a different decision, '~' the same trade at different prices, '>> FIRST' the first decision that differs.",
  );
  if (firstDecision >= 0) {
    const t = m[firstDecision]!.t;
    const time = [...kC.used, ...tvC.used].find(
      (c) => istDay(c.time) === day && at(c.time).slice(11) === t,
    )?.time;
    out(`\nEngine state on the bar before ${t}, each side:`);
    const before = (cs: Candle[]) =>
      time ? cs.filter((c) => c.time < time).at(-1)?.time : undefined;
    const bt = before(tvC.used);
    const bk = before(kC.used);
    if (bt) for (const l of stateAt(tvC.used, bt, settings, tie)) out('  TV   ' + l);
    if (bk) for (const l of stateAt(kC.used, bk, settings, tie)) out('  Kite ' + l);
  }
}

// ------------------------------------------------------- Kite against live run
if (appLog && kiteRun) {
  section('Offline run on Kite candles vs what the live paper trader did');
  const missed = new Set(
    (appLog.events ?? []).filter((e) => e.kind === 'MISSED').map((e) => e.text.split('|')[1] ?? ''),
  );
  const onDay = kiteRun.res.lastTime !== null && istDay(kiteRun.res.lastTime) === day;
  const rows = matchApp(onDay ? kiteRun.res.log : [], appTrades, day, missed);
  if (!rows.length) out('(no calls either way)');
  else
    out(
      textTable(
        ['In', 'Offline (final candles)', 'Live paper trade', 'Net Rs', 'Flag'],
        rows.map((r) => [
          r.t,
          brief(r.offline),
          r.live
            ? `${r.live.optionName} @${r.live.entryIndex} -> ${r.live.result ?? 'open'} ${r.live.scriptPts === null ? '' : Math.round(r.live.scriptPts * 100) / 100}`
            : '-',
          r.live?.netRs === null || r.live?.netRs === undefined
            ? ''
            : String(Math.round(r.live.netRs)),
          r.flag,
        ]),
      ),
    );
} else if (appLog && !kite) {
  out('\n(App log given without candles: pass --kite, or use an export that includes candles.)');
}
