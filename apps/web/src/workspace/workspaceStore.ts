import { getTimeframe, type Instrument, type Prefs, type TimeframeId } from '@otv/shared';
import { create } from 'zustand';
import { api } from '../api';

const STORAGE_KEY = 'otv.workspace.v2';
export const DEFAULT_SYMBOL = 'NSE:NIFTY 50';

export type IndicatorType = 'sma' | 'ema' | 'bb' | 'vwap' | 'rsi' | 'macd' | 'oi';

export interface IndicatorConfig {
  id: string;
  type: IndicatorType;
  /** Main period (SMA/EMA/BB/RSI). */
  period?: number;
  /** BB width in standard deviations. */
  mult?: number;
  fast?: number;
  slow?: number;
  signal?: number;
  color?: string;
}

export interface Layout {
  sidebarOpen: boolean;
  sidebarWidth: number;
  depthOpen: boolean;
  watchlistId: number | null;
}

/** Everything restored on reload (saved on the server, cached in localStorage for a fast first paint). */
interface Saved {
  key: string;
  tf: TimeframeId;
  indicators: IndicatorConfig[];
  layout: Layout;
}

const DEFAULT_LAYOUT: Layout = {
  sidebarOpen: true,
  sidebarWidth: 360,
  depthOpen: true,
  watchlistId: null,
};
const DEFAULTS: Saved = { key: DEFAULT_SYMBOL, tf: '5m', indicators: [], layout: DEFAULT_LAYOUT };

/** Accepts only well-formed saved state; anything odd falls back to defaults. */
function sanitize(p: Partial<Saved> | Prefs | null | undefined): Saved {
  const o = (p ?? {}) as Partial<Saved>;
  const layout = {
    ...DEFAULT_LAYOUT,
    ...(typeof o.layout === 'object' && o.layout ? o.layout : {}),
  };
  layout.sidebarWidth = Math.min(560, Math.max(240, Number(layout.sidebarWidth) || 360));
  return {
    key: typeof o.key === 'string' && o.key.includes(':') ? o.key : DEFAULTS.key,
    tf: typeof o.tf === 'string' && getTimeframe(o.tf) ? (o.tf as TimeframeId) : DEFAULTS.tf,
    indicators: Array.isArray(o.indicators)
      ? (o.indicators as IndicatorConfig[])
          .filter((i) => i && typeof i.id === 'string' && typeof i.type === 'string')
          .slice(0, 12)
      : [],
    layout,
  };
}

function readLocal(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem('otv.workspace.v1');
    if (raw) return sanitize(JSON.parse(raw) as Partial<Saved>);
  } catch {
    // Private mode or corrupt value.
  }
  return DEFAULTS;
}

interface WorkspaceState extends Saved {
  instrument: Instrument | null;
  /** performance.now() when the user last switched symbol or timeframe (for render timing). */
  switchStartedAt: number | null;
  /** True once the server's saved preferences have been applied. */
  hydrated: boolean;
  setInstrument: (i: Instrument) => void;
  setTf: (tf: TimeframeId) => void;
  setIndicators: (list: IndicatorConfig[]) => void;
  setLayout: (patch: Partial<Layout>) => void;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  ...readLocal(),
  instrument: null,
  switchStartedAt: null,
  hydrated: false,
  setInstrument: (instrument) =>
    set({ instrument, key: instrument.key, switchStartedAt: performance.now() }),
  setTf: (tf) => {
    if (tf !== get().tf) set({ tf, switchStartedAt: performance.now() });
  },
  setIndicators: (indicators) => set({ indicators }),
  setLayout: (patch) => set({ layout: { ...get().layout, ...patch } }),
}));

const snapshot = (s: WorkspaceState): Saved => ({
  key: s.key,
  tf: s.tf,
  indicators: s.indicators,
  layout: s.layout,
});

let saveTimer: number | undefined;
let lastSaved = '';

/**
 * Loads the saved workspace from the server once logged in, then saves every
 * change (debounced). Returns a stop function.
 */
export function syncPrefs(): () => void {
  let stopped = false;
  void api
    .get<Prefs>('/api/prefs')
    .then((p) => {
      if (stopped) return;
      const local = snapshot(useWorkspace.getState());
      const saved = Object.keys(p).length ? sanitize(p) : local;
      lastSaved = JSON.stringify(saved);
      const cur = useWorkspace.getState();
      useWorkspace.setState({
        ...saved,
        // A different saved symbol needs resolving again.
        instrument: cur.instrument?.key === saved.key ? cur.instrument : null,
        hydrated: true,
      });
    })
    .catch(() => useWorkspace.setState({ hydrated: true }));

  const unsub = useWorkspace.subscribe((s) => {
    const snap = snapshot(s);
    const json = JSON.stringify(snap);
    try {
      localStorage.setItem(STORAGE_KEY, json);
    } catch {
      // Not fatal.
    }
    if (!s.hydrated || json === lastSaved) return;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      lastSaved = json;
      void api.put('/api/prefs', snap).catch(() => {});
    }, 500);
  });
  return () => {
    stopped = true;
    unsub();
  };
}
