import { instrumentKind, type Instrument } from '@otv/shared';
import { useEffect, useRef, useState } from 'react';
import { INDICATOR_DEFS, INDICATOR_ORDER, newIndicator } from '../chart/indicatorDefs';
import { useWorkspace } from '../workspace/workspaceStore';

export function IndicatorMenu({ instrument }: { instrument: Instrument | null }) {
  const [open, setOpen] = useState(false);
  const list = useWorkspace((s) => s.indicators);
  const setIndicators = useWorkspace((s) => s.setIndicators);
  const ref = useRef<HTMLDivElement>(null);
  const kind = instrument ? instrumentKind(instrument) : 'other';
  const derivative = kind === 'future' || kind === 'option';

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button
        className={`tf-btn ${open ? 'tf-btn-on' : ''}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ƒx Indicators{list.length ? ` (${list.length})` : ''}
      </button>
      {open && (
        <ul className="menu-pop" role="menu">
          {INDICATOR_ORDER.map((t) => {
            const def = INDICATOR_DEFS[t];
            const disabled = def.derivativeOnly && !derivative;
            return (
              <li key={t}>
                <button
                  role="menuitem"
                  disabled={disabled}
                  title={disabled ? 'Futures and options only' : undefined}
                  onClick={() => {
                    setIndicators([...list, newIndicator(t)]);
                    setOpen(false);
                  }}
                >
                  {def.label}
                  <span className="muted">{def.pane ? 'pane' : 'overlay'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
