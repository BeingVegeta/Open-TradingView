/**
 * Lightweight performance log for the targets in the brief (cached timeframe
 * switch < 100 ms; scroll-back prefetch before the left edge). Readable from
 * the console or tests as `window.__otvPerf`. With `?perf=1` in the URL (kept
 * until `?perf=0`) the app also shows the switch timings on screen and logs
 * each one to the console.
 */
export type PerfEvent =
  | {
      type: 'series-render';
      key: string;
      tf: string;
      cached: boolean;
      /** Click (or symbol pick) to the chart's next painted frame. */
      ms: number;
      bars: number;
      /** Time in Lightweight Charts' setData for candles and volume. */
      priceMs?: number;
      /** Time computing indicators and in setData for their series. */
      indicatorsMs?: number;
      /** Indicators configured on the chart. */
      indicators?: number;
      /** Charts in the layout. */
      charts?: number;
      /** performance.now() when it was recorded. */
      at?: number;
    }
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

const FLAG = 'otv.perf';
let enabled: boolean | null = null;

/** Whether the on-screen timings are on (`?perf=1` turns them on, `?perf=0` off). */
export function perfEnabled(): boolean {
  if (enabled !== null) return enabled;
  const param = new URLSearchParams(location.search).get('perf');
  try {
    if (param === '1') localStorage.setItem(FLAG, '1');
    if (param === '0') localStorage.removeItem(FLAG);
    enabled = localStorage.getItem(FLAG) === '1';
  } catch {
    enabled = param === '1';
  }
  return enabled;
}

const listeners = new Set<() => void>();

/** Calls `l` after each recorded event. */
export function onPerf(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function recordPerf(e: PerfEvent): void {
  const log = (window.__otvPerf ??= []);
  log.push(e);
  if (log.length > 1000) log.splice(0, log.length - 1000);
  if (e.type === 'series-render' && perfEnabled()) {
    console.log(
      `[otv perf] ${e.cached ? 'cached' : 'loaded'} ${e.key} ${e.tf}: ${e.ms.toFixed(0)} ms` +
        ` (chart ${e.priceMs?.toFixed(1) ?? '?'} ms, indicators ${e.indicatorsMs?.toFixed(1) ?? '?'} ms,` +
        ` ${e.bars} bars, ${e.indicators ?? 0} indicators, ${e.charts ?? 1} charts)`,
    );
  } else if (import.meta.env.DEV) {
    console.debug('[perf]', e);
  }
  for (const l of listeners) l();
}
