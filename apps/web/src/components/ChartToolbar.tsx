import { instrumentKind, TIMEFRAMES } from '@otv/shared';
import { GRIDS, useActiveChart, useWorkspace, type GridId } from '../workspace/workspaceStore';
import { IndicatorMenu } from './IndicatorMenu';

/** Small pictures of each chart grid, for the layout buttons. */
function GridIcon({ grid }: { grid: GridId }) {
  const cells: Record<GridId, [number, number, number, number][]> = {
    '1': [[1, 1, 14, 10]],
    '2v': [
      [1, 1, 6.5, 10],
      [8.5, 1, 6.5, 10],
    ],
    '2h': [
      [1, 1, 14, 4.5],
      [1, 6.5, 14, 4.5],
    ],
    '3': [
      [1, 1, 6.5, 10],
      [8.5, 1, 6.5, 4.5],
      [8.5, 6.5, 6.5, 4.5],
    ],
    '4': [
      [1, 1, 6.5, 4.5],
      [8.5, 1, 6.5, 4.5],
      [1, 6.5, 6.5, 4.5],
      [8.5, 6.5, 6.5, 4.5],
    ],
  };
  return (
    <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true">
      {cells[grid].map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx="1" fill="currentColor" />
      ))}
    </svg>
  );
}

/** Acts on the active chart: symbol, timeframe, indicators; plus the chart grid. */
export function ChartToolbar() {
  const { instrument, tf } = useActiveChart();
  const setTf = useWorkspace((s) => s.setTf);
  const grid = useWorkspace((s) => s.grid);
  const setGrid = useWorkspace((s) => s.setGrid);
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
            title={t.aggregated ? `${t.label}: built from Kite's ${t.interval} candles` : undefined}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="toolbar-sep" />
      <IndicatorMenu instrument={instrument} />
      <div className="toolbar-spacer" />
      <div className="tf-group" role="group" aria-label="Chart layout">
        {GRIDS.map((g) => (
          <button
            key={g.id}
            className={`tf-btn tf-icon ${g.id === grid ? 'tf-btn-on' : ''}`}
            onClick={() => setGrid(g.id)}
            title={g.title}
            aria-label={g.title}
            aria-pressed={g.id === grid}
          >
            <GridIcon grid={g.id} />
          </button>
        ))}
      </div>
      <div className="toolbar-sep" />
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
