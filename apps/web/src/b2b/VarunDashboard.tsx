import { b2bLogView, b2bStatusView, isNiftySymbol, type B2BCell } from '@otv/shared';
import { useState } from 'react';
import { useWorkspace } from '../workspace/workspaceStore';
import { useB2B } from './b2bRuntime';
import { B2BSettingsDialog } from './B2BSettingsDialog';
import { PaperPanel } from './PaperPanel';

const Cell = ({ c, colSpan }: { c: B2BCell; colSpan?: number }) => (
  <td className={`b2b-${c.tone}`} colSpan={colSpan}>
    {c.text}
  </td>
);

/**
 * Varun's dashboard: the N-B2B v1.8 script's STATUS and CALL LOG tables for
 * the chart it follows, under the charts.
 */
export function VarunDashboard() {
  const b2b = useWorkspace((s) => s.b2b);
  const setB2B = useWorkspace((s) => s.setB2B);
  const chartIdx = b2b.chart;
  const instrument = useWorkspace((s) =>
    chartIdx === null ? null : (s.instruments[chartIdx] ?? null),
  );
  const tf = useWorkspace((s) => (chartIdx === null ? null : s.charts[chartIdx]!.tf));
  const { result, live, error, alerts } = useB2B();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [tab, setTab] = useState<'signals' | 'paper'>('signals');
  if (chartIdx === null) return null;

  const S = b2b.settings;
  const flags = {
    is1m: tf === '1m',
    isNifty: !!instrument && isNiftySymbol(instrument.tradingsymbol),
  };
  const status = result ? b2bStatusView(result, S, live, flags) : null;
  const log = result ? b2bLogView(result, S, live) : null;

  return (
    <section
      className={`b2b ${b2b.collapsed ? 'b2b-collapsed' : ''}`}
      aria-label="Varun's dashboard"
    >
      <header className="b2b-bar">
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setB2B({ collapsed: !b2b.collapsed })}
          aria-expanded={!b2b.collapsed}
        >
          {b2b.collapsed ? '▸' : '▾'}
        </button>
        <strong>Varun&apos;s dashboard</strong>
        <div className="tf-group" role="tablist" aria-label="Dashboard view">
          {(
            [
              ['signals', 'Signals'],
              ['paper', 'Paper trading'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`tf-btn ${tab === id ? 'tf-btn-on' : ''}`}
              onClick={() => {
                setTab(id);
                setB2B({ collapsed: false });
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="muted">
          N-B2B v1.8 · chart {chartIdx + 1}
          {instrument ? ` · ${instrument.tradingsymbol}` : ''} · runs on 1-minute candles
          {result ? ` · ${result.bars.toLocaleString('en-US')} bars` : ''}
        </span>
        {!flags.is1m && (
          <span className="b2b-note" title="Zones and calls are drawn on the chart only on 1m">
            switch chart {chartIdx + 1} to 1m to see zones and calls on it
          </span>
        )}
        <span className="toolbar-spacer" />
        <button
          className={`btn btn-ghost btn-sm ${b2b.labels ? 'tf-btn-on' : ''}`}
          onClick={() => setB2B({ labels: !b2b.labels })}
          title="Show the script's labels (calls, lot 1 bookings, exits) on the chart"
          aria-pressed={b2b.labels}
        >
          Labels
        </button>
        <button
          className={`btn btn-ghost btn-sm ${alertsOpen ? 'tf-btn-on' : ''}`}
          onClick={() => setAlertsOpen(!alertsOpen)}
          title="Alert messages (the script's alert() calls) since the dashboard opened"
        >
          Alerts {alerts.length ? `(${alerts.length})` : ''}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setB2B({ chart: null })}
          aria-label="Close Varun's dashboard"
          title="Close"
        >
          ✕
        </button>
      </header>
      {!b2b.collapsed && tab === 'paper' && (
        <div className="b2b-body">
          <PaperPanel />
        </div>
      )}
      {!b2b.collapsed && tab === 'signals' && (
        <div className="b2b-body">
          {error && <div className="notice notice-warn">{error}</div>}
          {!error && !result && (
            <p className="muted b2b-wait">
              {instrument ? 'Loading 1-minute history…' : 'Waiting for the chart’s symbol…'}
            </p>
          )}
          {alertsOpen && (
            <div className="b2b-alerts">
              {alerts.length === 0 ? (
                <p className="muted">No alerts since the dashboard opened.</p>
              ) : (
                [...alerts]
                  .reverse()
                  .map((a, i) => <pre key={`${a.time}-${i}`}>{a.lines.join('\n')}</pre>)
              )}
            </div>
          )}
          {status && (
            <table className="b2b-table">
              <tbody>
                <tr className="b2b-head">
                  {status.header.map((c, i) => (
                    <Cell key={i} c={c} colSpan={i === status.header.length - 1 ? 6 : undefined} />
                  ))}
                </tr>
                <tr className="b2b-sub">
                  {status.titles.map((t) => (
                    <td key={t}>{t}</td>
                  ))}
                </tr>
                <tr className={`b2b-row-${status.rowTone}`}>
                  {status.row.map((c, i) => (
                    <Cell key={i} c={c} />
                  ))}
                </tr>
              </tbody>
            </table>
          )}
          {log && (
            <table className="b2b-table">
              <tbody>
                <tr className="b2b-head">
                  {log.header.map((c, i) => (
                    <Cell key={i} c={c} colSpan={i === log.header.length - 1 ? 7 : undefined} />
                  ))}
                </tr>
                <tr className="b2b-sub">
                  {log.titles.map((t) => (
                    <td key={t}>{t}</td>
                  ))}
                </tr>
                {log.empty ? (
                  <tr className="b2b-row-none">
                    <td colSpan={13} className="b2b-muted">
                      {log.empty}
                    </td>
                  </tr>
                ) : (
                  log.rows.map((r, i) => (
                    <tr key={i} className={`b2b-row-${r.tone}`}>
                      {r.cells.map((c, j) => (
                        <Cell key={j} c={c} />
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
      {settingsOpen && <B2BSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </section>
  );
}
