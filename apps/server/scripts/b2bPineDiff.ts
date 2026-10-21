/*
 * pnpm b2b:pine-diff --kite data/paper-2026-10-19.json --days 2026-10-13,2026-10-14 [--out FILE]
 *
 * Writes a Pine script carrying Kite's candles for those days. On TradingView's
 * NIFTY 50 1-minute chart it lists the bars that differ from Kite's, so
 * TradingView's candles can be rebuilt without a paid export. See docs/B2B_PARITY.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseCandleFile, pineDiffScript } from '../src/b2b/compare';

const { values: a } = parseArgs({
  options: { kite: { type: 'string' }, days: { type: 'string' }, out: { type: 'string' } },
});
if (!a.kite || !a.days) {
  console.log('pnpm b2b:pine-diff --kite FILE --days YYYY-MM-DD[,YYYY-MM-DD...] [--out FILE]');
  process.exit(1);
}
const days = a.days.split(',').map((d) => d.trim());
const script = pineDiffScript(parseCandleFile(readFileSync(a.kite, 'utf8')).candles, days);
const out = a.out ?? `data/pine-diff-${days[0]}_${days.at(-1)}.pine`;
writeFileSync(out, script);
console.log(
  `Wrote ${out} (${script.length} characters). Keep it private: it holds Kite's candles.`,
);
