import type { Drawing, DrawingType } from '@otv/shared';
import { useEffect } from 'react';
import { create } from 'zustand';
import { api, qs } from '../api';
import { failure, notify } from '../components/Toasts';

export const DRAWING_COLORS = ['#f59e0b', '#60a5fa', '#22c55e', '#ef4444', '#e879f9', '#d6dbe4'];
export const DEFAULT_COLOR: Record<DrawingType, string> = { hline: '#f59e0b', trend: '#60a5fa' };

interface DrawingsState {
  /** Drawings per instrument key, once loaded. */
  byKey: Record<string, Drawing[]>;
  /** The drawing tool waiting for a click on a chart, if any. */
  tool: DrawingType | null;
  /** The selected drawing (one at a time, across charts). */
  selected: { key: string; id: string } | null;
  setTool: (t: DrawingType | null) => void;
  select: (s: { key: string; id: string } | null) => void;
  /** Replaces an instrument's drawings and saves them (debounced). */
  save: (key: string, list: Drawing[]) => void;
}

const inflight = new Set<string>();
const timers = new Map<string, number>();

export const useDrawings = create<DrawingsState>((set, get) => ({
  byKey: {},
  tool: null,
  selected: null,
  setTool: (tool) => set({ tool, selected: null }),
  select: (selected) => set({ selected }),
  save: (key, list) => {
    set({ byKey: { ...get().byKey, [key]: list } });
    window.clearTimeout(timers.get(key));
    timers.set(
      key,
      window.setTimeout(() => {
        timers.delete(key);
        void api
          .put(`/api/drawings?${qs({ key })}`, list)
          .catch((e: unknown) => notify(failure(`Couldn't save drawings on ${key}`, e)));
      }, 400),
    );
  },
}));

/** An instrument's drawings, loading them from the server on first use. */
export function useInstrumentDrawings(key: string): Drawing[] {
  const list = useDrawings((s) => s.byKey[key]);
  useEffect(() => {
    if (list || inflight.has(key)) return;
    inflight.add(key);
    api
      .get<Drawing[]>(`/api/drawings?${qs({ key })}`)
      .then((d) => {
        // Don't clobber drawings made while the request was in flight.
        if (!useDrawings.getState().byKey[key])
          useDrawings.setState((s) => ({ byKey: { ...s.byKey, [key]: d } }));
      })
      .catch((e: unknown) => notify(failure(`Couldn't load drawings for ${key}`, e)))
      .finally(() => inflight.delete(key));
  }, [key, list]);
  return list ?? EMPTY;
}
const EMPTY: Drawing[] = [];

export const newDrawingId = () =>
  `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
