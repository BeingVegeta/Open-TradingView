import { useEffect, useState } from 'react';
import { onPerf, type PerfEvent } from '../perf';

type Switch = Extract<PerfEvent, { type: 'series-render' }>;

const switches = (): Switch[] =>
  (window.__otvPerf ?? []).filter((e): e is Switch => e.type === 'series-render');

function stats(ms: number[]) {
  if (!ms.length) return null;
  const s = [...ms].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { n: s.length, median: at(0.5), p95: at(0.95), max: s.at(-1)! };
}

const f = (v: number | undefined) => (v === undefined ? '–' : v.toFixed(0));

/**
 * Timeframe and symbol switch timings, shown with `?perf=1`. "Cached" switches
 * (the series was already loaded) are the ones the 100 ms target applies to.
 */
export function PerfOverlay() {
  const [, bump] = useState(0);
  const [open, setOpen] = useState(true);
  useEffect(() => onPerf(() => bump((n) => n + 1)), []);
  const all = switches();
  const cached = stats(all.filter((e) => e.cached).map((e) => e.ms));
  const recent = all.slice(-12).reverse();
  const copy = () => {
    const text = JSON.stringify({ userAgent: navigator.userAgent, cached, switches: all }, null, 1);
    void navigator.clipboard?.writeText(text).catch(() => {});
    console.log('[otv perf] all switches', text);
  };
  return (
    <div className="perf-overlay" aria-label="Switch timings">
      <div className="perf-head">
        <strong>Switch timings</strong>
        {cached && (
          <span>
            cached: {cached.n} · median {f(cached.median)} · p95 {f(cached.p95)} · max{' '}
            {f(cached.max)} ms
          </span>
        )}
        <button className="btn btn-ghost btn-sm" onClick={copy} title="Copy all timings as JSON">
          Copy
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            window.__otvPerf = [];
            bump((n) => n + 1);
          }}
        >
          Clear
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
        </button>
      </div>
      {open && (
        <table>
          <thead>
            <tr>
              <th>chart</th>
              <th></th>
              <th>total</th>
              <th>candles</th>
              <th>indic.</th>
              <th>bars</th>
              <th>ind</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((e, i) => (
              <tr key={`${e.at ?? i}-${i}`} className={e.cached && e.ms > 100 ? 'perf-slow' : ''}>
                <td>
                  {e.key.split(':')[1]} {e.tf}
                </td>
                <td className="muted">{e.cached ? 'cached' : 'load'}</td>
                <td>{f(e.ms)}</td>
                <td>{e.priceMs?.toFixed(1) ?? '–'}</td>
                <td>{e.indicatorsMs?.toFixed(1) ?? '–'}</td>
                <td>{e.bars}</td>
                <td>{e.indicators ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
