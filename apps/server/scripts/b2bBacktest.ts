/*
 * pnpm b2b:backtest — Varun's N-B2B script over many days of 1-minute candles.
 *
 *   pnpm b2b:backtest --csv data/xau_usd_1m.csv --settings '{"entFrom":1230,"entTo":2300,"sqOff":2330}' --scale 0.23
 *   pnpm b2b:backtest --csv data/paper-2026-10-21.json --index
 *
 * Reads a candle file only; sends nothing anywhere. Times of day in the
 * settings are IST. See docs/B2B_PARITY.md.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  B2B_DEFAULTS,
  formatIstDateTime,
  runB2B,
  tradingViewIndexSession,
  type B2BSettings,
  type PivotTie,
} from '@otv/shared';
import {
  groupBy,
  POINT_KEYS,
  scalePoints,
  summarize,
  tradesFromAlerts,
  typicalRange,
} from '../src/b2b/backtest';
import { parseCandleFile, textTable } from '../src/b2b/compare';

const { values: a } = parseArgs({
  options: {
    csv: { type: 'string' },
    settings: { type: 'string' },
    scale: { type: 'string', default: '1' },
    'scale-ref': { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    cost: { type: 'string', default: '0' },
    index: { type: 'boolean', default: false },
    trades: { type: 'boolean', default: false },
    'pivot-tie': { type: 'string', default: 'newer' },
    help: { type: 'boolean', default: false },
  },
});

const USAGE = `pnpm b2b:backtest --csv FILE [options]

  --csv FILE        1-minute candles: CSV (time,open,high,low,close), Kite JSON or an app export
  --settings X      JSON file or inline JSON overriding the script's inputs. Times of day
                    are IST HHMM and may go past 15:30 (e.g. "entFrom":1230,"sqOff":2330)
  --scale N|auto    Multiply every point setting (${POINT_KEYS.join(', ')}) by N.
                    auto: the median 1-minute range of --csv in its entry window divided by
                    that of --scale-ref FILE (NIFTY candles) in 09:15-15:14
  --from/--to DAY   Only count trades on these IST days (yyyy-mm-dd); earlier bars still warm up
  --cost N          Points taken off every trade for spread and charges (default 0)
  --index           Drop index bars after 15:14 IST, as TradingView has them (NIFTY)
  --trades          List every trade
  --pivot-tie T     newer (Pine) | older`;

if (a.help || !a.csv) {
  console.log(USAGE);
  process.exit(a.help ? 0 : 1);
}

const out = (s = '') => console.log(s);
let settings: B2BSettings = { ...B2B_DEFAULTS };
if (a.settings) {
  const s = a.settings.trim();
  const o = JSON.parse(s.startsWith('{') ? s : readFileSync(s, 'utf8')) as Partial<B2BSettings>;
  // Not sanitised on purpose: the dashboard limits hours and points to NIFTY's.
  settings = { ...settings, ...o };
}

const file = parseCandleFile(readFileSync(a.csv, 'utf8'));
for (const w of file.warnings) out(`! ${w}`);
const candles = a.index ? [...tradingViewIndexSession(file.candles)] : file.candles;
if (!candles.length) throw new Error('No candles');
const at = (s: number) => formatIstDateTime(s * 1000).slice(0, 16);
out(
  `Candles: ${a.csv}, ${candles.length} bars, ${at(candles[0]!.time)} -> ${at(candles.at(-1)!.time)} IST`,
);

let ratio = Number(a.scale);
if (a.scale === 'auto') {
  if (!a['scale-ref']) throw new Error('--scale auto needs --scale-ref FILE (NIFTY candles)');
  const ref = parseCandleFile(readFileSync(a['scale-ref'], 'utf8')).candles;
  const mine = typicalRange(candles, settings.entFrom, settings.entTo);
  const theirs = typicalRange(ref, 915, 1514);
  ratio = mine / theirs;
  out(
    `Typical 1-minute range: ${mine.toFixed(2)} here vs ${theirs.toFixed(2)} NIFTY -> scale ${ratio.toFixed(3)}`,
  );
}
if (!Number.isFinite(ratio) || ratio <= 0)
  throw new Error('--scale must be a positive number or auto');
if (ratio !== 1) settings = scalePoints(settings, ratio);

const tie = a['pivot-tie'] as PivotTie;
const changed = (Object.keys(B2B_DEFAULTS) as (keyof B2BSettings)[]).filter(
  (k) => settings[k] !== B2B_DEFAULTS[k],
);
out(
  'Settings: ' +
    (changed.length
      ? changed.map((k) => `${k}=${settings[k]}`).join(', ')
      : "the script's defaults"),
);

const res = runB2B(candles, { settings, pivotTie: tie });
const cost = Number(a.cost);
const trades = tradesFromAlerts(res).filter(
  (t) => (!a.from || t.day >= a.from) && (!a.to || t.day <= a.to),
);
const s = summarize(trades, cost);
const pct = (x: number | null) => (x === null ? '-' : `${Math.round(x * 100)}%`);
const n = (x: number | null) => (x === null ? '-' : String(x));

out(`\n=== Results${cost ? ` after ${cost} points per trade` : ' (no costs)'} ===`);
out(
  textTable(
    [
      'Trades',
      'Won',
      'Lost',
      'Win rate',
      'Total pts',
      'Avg win',
      'Avg loss',
      'Profit factor',
      'Per trade',
      'Max drawdown',
    ],
    [
      [
        String(s.trades),
        String(s.wins),
        String(s.losses),
        pct(s.winRate),
        String(s.totalPts),
        n(s.avgWin),
        n(s.avgLoss),
        n(s.profitFactor),
        n(s.expectancy),
        String(s.maxDrawdown),
      ],
    ],
  ),
);
out(
  `Days traded ${s.days}, green ${s.greenDays} (${pct(s.days ? s.greenDays / s.days : null)}), best day ${n(s.bestDay)}, worst day ${n(s.worstDay)}`,
);

out('\n=== By month ===');
out(
  textTable(
    ['Month', 'Trades', 'Win rate', 'Points'],
    groupBy(trades, (t) => t.day.slice(0, 7), cost).map((g) => [
      g.key,
      String(g.trades),
      pct(g.trades ? g.wins / g.trades : null),
      String(g.pts),
    ]),
  ),
);
out('\n=== By exit ===');
out(
  textTable(
    ['Result', 'Trades', 'Points'],
    groupBy(trades, (t) => t.result.replace(/[+-]?\d+(\.\d+)?/g, '#'), cost)
      .sort((x, y) => y.trades - x.trades)
      .map((g) => [g.key, String(g.trades), String(g.pts)]),
  ),
);
if (a.trades) {
  out('\n=== Trades ===');
  out(
    textTable(
      ['Day', 'In', 'Out', 'Dir', 'From', 'Entry', 'Result', 'Pts'],
      trades.map((t) => [
        t.day,
        t.entry,
        t.exit,
        t.dir,
        t.source,
        String(t.entryPrice),
        t.result,
        String(t.pts),
      ]),
    ),
  );
}
