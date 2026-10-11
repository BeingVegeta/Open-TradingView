import type { Instrument, InstrumentSyncStatus } from '@otv/shared';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { ChartView } from '../chart/ChartView';
import { DEFAULT_SYMBOL, useWorkspace } from '../workspace/workspaceStore';
import { ChartToolbar } from './ChartToolbar';

/** Resolves the restored symbol once the instrument list is available. */
function useRestoreInstrument() {
  const key = useWorkspace((s) => s.key);
  const instrument = useWorkspace((s) => s.instrument);
  const setInstrument = useWorkspace((s) => s.setInstrument);
  const [sync, setSync] = useState<InstrumentSyncStatus | null>(null);

  useEffect(() => {
    if (instrument) return;
    let stop = false;
    let timer: number | undefined;
    const attempt = async () => {
      for (const k of key === DEFAULT_SYMBOL ? [key] : [key, DEFAULT_SYMBOL]) {
        try {
          const i = await api.get<Instrument>(
            `/api/instruments/lookup?key=${encodeURIComponent(k)}`,
          );
          if (!stop) useWorkspace.setState({ instrument: i, key: i.key });
          return;
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 404) break;
        }
      }
      // Not found: the instrument list may still be downloading.
      const s = await api.get<InstrumentSyncStatus>('/api/instruments/status').catch(() => null);
      if (stop) return;
      setSync(s);
      if (s && (s.syncing || s.count === 0)) timer = window.setTimeout(attempt, 1500);
    };
    void attempt();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [key, instrument, setInstrument]);

  return { instrument, sync };
}

export function Workspace() {
  const tf = useWorkspace((s) => s.tf);
  const { instrument, sync } = useRestoreInstrument();

  return (
    <main className="workspace">
      <ChartToolbar instrument={instrument} tf={tf} />
      {instrument ? (
        <ChartView instrument={instrument} tf={tf} />
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
    </main>
  );
}
