import type { Instrument, InstrumentSyncStatus } from '@otv/shared';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { ChartView } from '../chart/ChartView';
import { chartCount, DEFAULT_SYMBOL, useWorkspace } from '../workspace/workspaceStore';
import { ChartToolbar } from './ChartToolbar';

/** Resolves a chart's restored symbol once the instrument list is available. */
function useRestoreInstrument(slot: number) {
  const key = useWorkspace((s) => s.charts[slot]!.key);
  const instrument = useWorkspace((s) => s.instruments[slot] ?? null);
  const setInstrument = useWorkspace((s) => s.setInstrument);
  const hydrated = useWorkspace((s) => s.hydrated);
  const [sync, setSync] = useState<InstrumentSyncStatus | null>(null);

  useEffect(() => {
    // Wait for the saved workspace so we don't load one chart and then another.
    if (instrument || !hydrated) return;
    let stop = false;
    let timer: number | undefined;
    // The list we last looked the symbol up against. A lookup can race a sync that
    // finishes a moment later, so retry once whenever the list has changed since.
    let seenSyncedAt: number | null | undefined;
    const attempt = async () => {
      for (const k of key === DEFAULT_SYMBOL ? [key] : [key, DEFAULT_SYMBOL]) {
        try {
          const i = await api.get<Instrument>(
            `/api/instruments/lookup?key=${encodeURIComponent(k)}`,
          );
          if (!stop && useWorkspace.getState().charts[slot]!.key === key) setInstrument(i, slot);
          return;
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 404) break;
        }
      }
      // Not found: the instrument list may still be downloading.
      const s = await api.get<InstrumentSyncStatus>('/api/instruments/status').catch(() => null);
      if (stop) return;
      setSync(s);
      if (!s) return;
      if (s.syncing || s.count === 0) {
        timer = window.setTimeout(attempt, 1500);
      } else if (s.syncedAt !== seenSyncedAt) {
        seenSyncedAt = s.syncedAt;
        void attempt();
      }
    };
    void attempt();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [slot, key, instrument, setInstrument, hydrated]);

  return { instrument, sync };
}

function ChartPane({ slot, framed }: { slot: number; framed: boolean }) {
  const tf = useWorkspace((s) => s.charts[slot]!.tf);
  const active = useWorkspace((s) => s.active === slot);
  const setActive = useWorkspace((s) => s.setActive);
  const { instrument, sync } = useRestoreInstrument(slot);
  return (
    <section
      className={`pane ${framed ? 'pane-framed' : ''} ${framed && active ? 'pane-active' : ''}`}
      onPointerDownCapture={() => setActive(slot)}
      aria-label={`Chart ${slot + 1}${active ? ' (active)' : ''}`}
    >
      {instrument ? (
        <ChartView chart={slot} instrument={instrument} tf={tf} />
      ) : (
        <div className="empty-state">
          {sync?.error ? (
            <div className="notice notice-warn">{sync.error}</div>
          ) : sync && sync.count === 0 ? (
            <>
              <div className="spinner" />
              <p className="muted">Downloading today's instrument list from Kite…</p>
            </>
          ) : sync ? (
            <>
              <h2>No chart open</h2>
              <p className="muted">Search for an instrument with the box above (press /).</p>
            </>
          ) : (
            <div className="spinner" />
          )}
        </div>
      )}
    </section>
  );
}

export function Workspace() {
  const grid = useWorkspace((s) => s.grid);
  const n = chartCount(grid);
  return (
    <main className="workspace">
      <ChartToolbar />
      <div className={`chart-grid grid-${grid}`}>
        {Array.from({ length: n }, (_, i) => (
          <ChartPane key={i} slot={i} framed={n > 1} />
        ))}
      </div>
    </main>
  );
}
