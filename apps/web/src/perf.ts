/**
 * Lightweight performance log for the targets in the brief (cached timeframe
 * switch < 100 ms; scroll-back prefetch before the left edge). Readable from
 * the console or tests as `window.__otvPerf`.
 */
export type PerfEvent =
  | { type: 'series-render'; key: string; tf: string; cached: boolean; ms: number; bars: number }
  | {
      type: 'prefetch';
      key: string;
      tf: string;
      barsLeftAtTrigger: number;
      visibleBars: number;
      ms: number;
      added: number;
    }
  | { type: 'edge-reached'; key: string; tf: string; whileLoading: boolean }
  | { type: 'render-cost'; bars: number; priceMs: number; indicatorsMs: number };

declare global {
  interface Window {
    __otvPerf?: PerfEvent[];
  }
}

export function recordPerf(e: PerfEvent): void {
  (window.__otvPerf ??= []).push(e);
  if (import.meta.env.DEV) console.debug('[perf]', e);
}
