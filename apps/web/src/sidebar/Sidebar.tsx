import { useRef } from 'react';
import { useWorkspace } from '../workspace/workspaceStore';
import { DepthPanel } from './DepthPanel';
import { Watchlist } from './Watchlist';

/** Right-hand panel: watchlist on top, market depth below. Resizable; layout is saved. */
export function Sidebar() {
  const layout = useWorkspace((s) => s.layout);
  const setLayout = useWorkspace((s) => s.setLayout);
  const instrument = useWorkspace((s) => s.instruments[s.active] ?? null);
  const drag = useRef<{ x: number; w: number } | null>(null);

  if (!layout.sidebarOpen) return null;
  return (
    <aside className="sidebar" style={{ width: layout.sidebarWidth }}>
      <div
        className="sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, w: layout.sidebarWidth };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const w = Math.min(560, Math.max(240, drag.current.w - (e.clientX - drag.current.x)));
          setLayout({ sidebarWidth: w });
        }}
        onPointerUp={() => (drag.current = null)}
      />
      <Watchlist />
      <section className={`panel ${layout.depthOpen ? '' : 'panel-collapsed'}`}>
        <header
          className="panel-head panel-toggle"
          onClick={() => setLayout({ depthOpen: !layout.depthOpen })}
        >
          <span>{layout.depthOpen ? '▾' : '▸'} Market depth</span>
          <span className="muted">{instrument?.tradingsymbol}</span>
        </header>
        {layout.depthOpen && <DepthPanel instrument={instrument} />}
      </section>
    </aside>
  );
}
