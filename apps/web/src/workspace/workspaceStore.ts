import { getTimeframe, type Instrument, type TimeframeId } from '@otv/shared';
import { create } from 'zustand';

const STORAGE_KEY = 'otv.workspace.v1';
export const DEFAULT_SYMBOL = 'NSE:NIFTY 50';

interface Saved {
  key: string;
  tf: TimeframeId;
}

function readSaved(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Saved>;
      if (typeof s.key === 'string' && s.tf && getTimeframe(s.tf)) return { key: s.key, tf: s.tf };
    }
  } catch {
    // Private mode or corrupt value: fall back to defaults.
  }
  return { key: DEFAULT_SYMBOL, tf: '5m' };
}

function save(s: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Not fatal.
  }
}

interface WorkspaceState {
  /** The symbol to show (restored from the last session until resolved). */
  key: string;
  instrument: Instrument | null;
  tf: TimeframeId;
  /** performance.now() when the user last switched symbol or timeframe (for render timing). */
  switchStartedAt: number | null;
  setInstrument: (i: Instrument) => void;
  setTf: (tf: TimeframeId) => void;
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  const saved = readSaved();
  return {
    key: saved.key,
    instrument: null,
    tf: saved.tf,
    switchStartedAt: null,
    setInstrument: (instrument) => {
      set({ instrument, key: instrument.key, switchStartedAt: performance.now() });
      save({ key: instrument.key, tf: get().tf });
    },
    setTf: (tf) => {
      if (tf === get().tf) return;
      set({ tf, switchStartedAt: performance.now() });
      save({ key: get().key, tf });
    },
  };
});
