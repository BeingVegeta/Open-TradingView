import { getTimeframe, type Instrument, type Prefs, type TimeframeId } from '@otv/shared';
import { create } from 'zustand';
import { api } from '../api';
import { failure, notify } from '../components/Toasts';

const STORAGE_KEY = 'otv.workspace.v3';
const OLD_STORAGE_KEYS = ['otv.workspace.v2', 'otv.workspace.v1'];
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

/** One chart of the grid. */
export interface ChartSlot {
  key: string;
  tf: TimeframeId;
  indicators: IndicatorConfig[];
}

export type GridId = '1' | '2v' | '2h' | '3' | '4';

/** Chart grids: how many charts each shows. */
export const GRIDS: { id: GridId; charts: number; title: string }[] = [
  { id: '1', charts: 1, title: 'One chart' },
  { id: '2v', charts: 2, title: 'Two charts side by side' },
  { id: '2h', charts: 2, title: 'Two charts, one above the other' },
  { id: '3', charts: 3, title: 'Three charts' },
  { id: '4', charts: 4, title: 'Four charts' },
];
export const MAX_CHARTS = 4;
export const chartCount = (grid: GridId) => GRIDS.find((g) => g.id === grid)?.charts ?? 1;

/** Everything restored on reload (saved on the server, cached in localStorage for a fast first paint). */
interface Saved {
  /** Always MAX_CHARTS long; charts beyond the grid keep their settings for later. */
  charts: ChartSlot[];
  active: number;
  grid: GridId;
  layout: Layout;
}

const DEFAULT_LAYOUT: Layout = {
  sidebarOpen: true,
  sidebarWidth: 360,
  depthOpen: true,
  watchlistId: null,
};
const DEFAULT_TFS: TimeframeId[] = ['5m', '1h', '1D', '15m'];

const slot = (key: string, tf: TimeframeId): ChartSlot => ({ key, tf, indicators: [] });

const DEFAULTS: Saved = {
  charts: DEFAULT_TFS.map((tf) => slot(DEFAULT_SYMBOL, tf)),
  active: 0,
  grid: '1',
  layout: DEFAULT_LAYOUT,
};

function sanitizeSlot(o: unknown, fallback: ChartSlot): ChartSlot {
  const c = (typeof o === 'object' && o ? o : {}) as Partial<ChartSlot>;
  return {
    key: typeof c.key === 'string' && c.key.includes(':') ? c.key : fallback.key,
    tf: typeof c.tf === 'string' && getTimeframe(c.tf) ? c.tf : fallback.tf,
    indicators: Array.isArray(c.indicators)
      ? c.indicators
          .filter((i) => i && typeof i.id === 'string' && typeof i.type === 'string')
          .slice(0, 12)
      : [],
  };
}

/** Accepts only well-formed saved state; anything odd falls back to defaults. */
function sanitize(p: Prefs | null | undefined): Saved {
  const o = (p ?? {}) as Record<string, unknown>;
  const layout = {
    ...DEFAULT_LAYOUT,
    ...(typeof o.layout === 'object' && o.layout ? o.layout : {}),
  };
  layout.sidebarWidth = Math.min(560, Math.max(240, Number(layout.sidebarWidth) || 360));
  let charts: ChartSlot[];
  if (Array.isArray(o.charts)) {
    charts = DEFAULTS.charts.map((d, i) => sanitizeSlot((o.charts as unknown[])[i], d));
  } else {
    // Single-chart layout saved before multi-chart: it becomes the first chart.
    const first = sanitizeSlot(o, DEFAULTS.charts[0]!);
    charts = [first, ...DEFAULT_TFS.slice(1).map((tf) => slot(first.key, tf))];
  }
  const grid = GRIDS.some((g) => g.id === o.grid) ? (o.grid as GridId) : '1';
  const active = Number.isInteger(o.active) ? (o.active as number) : 0;
  return {
    charts,
    grid,
    active: active >= 0 && active < chartCount(grid) ? active : 0,
    layout,
  };
}

function readLocal(): Saved {
  try {
    for (const k of [STORAGE_KEY, ...OLD_STORAGE_KEYS]) {
      const raw = localStorage.getItem(k);
      if (raw) return sanitize(JSON.parse(raw) as Prefs);
    }
  } catch {
    // Private mode or corrupt value.
  }
  return DEFAULTS;
}

interface WorkspaceState extends Saved {
  /** Resolved instrument per chart (null while its key is being looked up). */
  instruments: (Instrument | null)[];
  /** performance.now() when the user last switched symbol or timeframe (for render timing). */
  switchStartedAt: number | null;
  /** True once the server's saved preferences have been applied. */
  hydrated: boolean;
  setActive: (i: number) => void;
  /** Opens an instrument in a chart (default: the active one). */
  setInstrument: (inst: Instrument, chart?: number) => void;
  setTf: (tf: TimeframeId, chart?: number) => void;
  setIndicators: (list: IndicatorConfig[], chart?: number) => void;
  setGrid: (grid: GridId) => void;
  setLayout: (patch: Partial<Layout>) => void;
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  const patchChart = (i: number, patch: Partial<ChartSlot>) =>
    get().charts.map((c, j) => (j === i ? { ...c, ...patch } : c));
  return {
    ...readLocal(),
    instruments: Array<Instrument | null>(MAX_CHARTS).fill(null),
    switchStartedAt: null,
    hydrated: false,
    setActive: (active) => {
      if (active !== get().active && active < chartCount(get().grid)) set({ active });
    },
    setInstrument: (inst, chart = get().active) =>
      set({
        charts: patchChart(chart, { key: inst.key }),
        instruments: get().instruments.map((x, j) => (j === chart ? inst : x)),
        switchStartedAt: performance.now(),
      }),
    setTf: (tf, chart = get().active) => {
      if (tf !== get().charts[chart]!.tf)
        set({ charts: patchChart(chart, { tf }), switchStartedAt: performance.now() });
    },
    setIndicators: (indicators, chart = get().active) =>
      set({ charts: patchChart(chart, { indicators }) }),
    setGrid: (grid) => set({ grid, active: Math.min(get().active, chartCount(grid) - 1) }),
    setLayout: (patch) => set({ layout: { ...get().layout, ...patch } }),
  };
});

/** The active chart's slot and resolved instrument. */
export function useActiveChart() {
  const chart = useWorkspace((s) => s.charts[s.active]!);
  const instrument = useWorkspace((s) => s.instruments[s.active] ?? null);
  return { ...chart, instrument, index: useWorkspace((s) => s.active) };
}

const snapshot = (s: WorkspaceState): Saved => ({
  charts: s.charts,
  active: s.active,
  grid: s.grid,
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
        // A chart whose saved symbol differs needs resolving again.
        instruments: cur.instruments.map((inst, i) =>
          inst?.key === saved.charts[i]!.key ? inst : null,
        ),
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
      void api
        .put('/api/prefs', snap)
        .catch((e: unknown) => notify(failure("Couldn't save the layout", e)));
    }, 500);
  });
  return () => {
    stopped = true;
    unsub();
  };
}
