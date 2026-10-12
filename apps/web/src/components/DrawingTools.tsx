import { useEffect } from 'react';
import { useDrawings } from '../drawings/drawingsStore';
import { useActiveChart } from '../workspace/workspaceStore';

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);

/**
 * Drawing tools for the active chart: horizontal line (Alt+H) and trend line
 * (Alt+T). Esc cancels; Delete removes the selected drawing.
 */
export function DrawingTools() {
  const tool = useDrawings((s) => s.tool);
  const setTool = useDrawings((s) => s.setTool);
  const { key } = useActiveChart();
  const count = useDrawings((s) => s.byKey[key]?.length ?? 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const st = useDrawings.getState();
      if (e.altKey && (e.code === 'KeyH' || e.code === 'KeyT')) {
        e.preventDefault();
        const t = e.code === 'KeyH' ? 'hline' : 'trend';
        st.setTool(st.tool === t ? null : t);
      } else if (e.key === 'Escape' && (st.tool || st.selected)) {
        st.setTool(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && st.selected) {
        e.preventDefault();
        const { key: k, id } = st.selected;
        st.save(
          k,
          (st.byKey[k] ?? []).filter((d) => d.id !== id),
        );
        st.select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="tf-group" role="group" aria-label="Drawing tools">
      <button
        className={`tf-btn tf-icon ${tool === 'hline' ? 'tf-btn-on' : ''}`}
        onClick={() => setTool(tool === 'hline' ? null : 'hline')}
        title="Horizontal line (Alt+H): click a price"
        aria-label="Horizontal line"
        aria-pressed={tool === 'hline'}
      >
        <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true">
          <path d="M1 6h14" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="8" cy="6" r="2" fill="currentColor" />
        </svg>
      </button>
      <button
        className={`tf-btn tf-icon ${tool === 'trend' ? 'tf-btn-on' : ''}`}
        onClick={() => setTool(tool === 'trend' ? null : 'trend')}
        title="Trend line (Alt+T): click the start, then the end"
        aria-label="Trend line"
        aria-pressed={tool === 'trend'}
      >
        <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true">
          <path d="M2.5 10L13.5 2" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="2.5" cy="10" r="1.8" fill="currentColor" />
          <circle cx="13.5" cy="2" r="1.8" fill="currentColor" />
        </svg>
      </button>
      <button
        className="tf-btn tf-icon"
        disabled={!count}
        onClick={() => {
          if (window.confirm(`Remove all ${count} drawings on ${key}?`)) {
            useDrawings.getState().save(key, []);
            useDrawings.getState().select(null);
          }
        }}
        title={count ? `Remove all drawings on ${key}` : 'No drawings on this symbol'}
        aria-label="Remove all drawings"
      >
        <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
          <path
            d="M2 3h10M5 3V1.5h4V3M3.5 3l.7 8h5.6l.7-8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
          />
        </svg>
      </button>
    </div>
  );
}
