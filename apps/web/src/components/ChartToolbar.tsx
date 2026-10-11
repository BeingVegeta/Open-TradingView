import { instrumentKind, TIMEFRAMES, type Instrument, type TimeframeId } from '@otv/shared';
import { useWorkspace } from '../workspace/workspaceStore';
import { IndicatorMenu } from './IndicatorMenu';

export function ChartToolbar({
  instrument,
  tf,
}: {
  instrument: Instrument | null;
  tf: TimeframeId;
}) {
  const setTf = useWorkspace((s) => s.setTf);
  const layout = useWorkspace((s) => s.layout);
  const setLayout = useWorkspace((s) => s.setLayout);
  return (
    <div className="toolbar">
      {instrument && (
        <div className="toolbar-symbol" title={instrument.name}>
          <strong>{instrument.tradingsymbol}</strong>
          <span className="badge badge-ex">{instrument.exchange}</span>
          <span className="muted toolbar-name">
            {instrumentKind(instrument) === 'equity' || instrumentKind(instrument) === 'index'
              ? instrument.name
              : `${instrument.name} · exp ${instrument.expiry ?? '—'}`}
          </span>
        </div>
      )}
      {instrument && <div className="toolbar-sep" />}
      <div className="tf-group" role="group" aria-label="Timeframe">
        {TIMEFRAMES.map((t) => (
          <button
            key={t.id}
            className={`tf-btn ${t.id === tf ? 'tf-btn-on' : ''}`}
            onClick={() => setTf(t.id)}
            aria-pressed={t.id === tf}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="toolbar-sep" />
      <IndicatorMenu instrument={instrument} />
      <div className="toolbar-spacer" />
      <button
        className={`tf-btn ${layout.sidebarOpen ? 'tf-btn-on' : ''}`}
        onClick={() => setLayout({ sidebarOpen: !layout.sidebarOpen })}
        title="Toggle watchlist and depth panel"
        aria-pressed={layout.sidebarOpen}
      >
        ☰ Panel
      </button>
    </div>
  );
}
