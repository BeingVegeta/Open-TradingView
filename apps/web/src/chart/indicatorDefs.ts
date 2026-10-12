import {
  bollinger,
  closes,
  ema,
  macd,
  rsi,
  sma,
  vwap,
  type Candle,
  type Series,
} from '@otv/shared';
import type { IndicatorConfig, IndicatorType } from '../workspace/workspaceStore';

export interface ParamDef {
  key: 'period' | 'mult' | 'fast' | 'slow' | 'signal';
  label: string;
  min: number;
  max: number;
  step?: number;
}

export interface IndicatorDef {
  label: string;
  /** Drawn in its own pane below the price chart. */
  pane: boolean;
  defaults: Omit<IndicatorConfig, 'id' | 'type'>;
  params: ParamDef[];
  /** Only meaningful for futures and options. */
  derivativeOnly?: boolean;
  /** Horizontal guide levels (RSI 70/30). */
  levels?: number[];
}

export const INDICATOR_DEFS: Record<IndicatorType, IndicatorDef> = {
  sma: {
    label: 'SMA',
    pane: false,
    defaults: { period: 20, color: '#f59e0b' },
    params: [{ key: 'period', label: 'Length', min: 1, max: 500 }],
  },
  ema: {
    label: 'EMA',
    pane: false,
    defaults: { period: 50, color: '#a78bfa' },
    params: [{ key: 'period', label: 'Length', min: 1, max: 500 }],
  },
  bb: {
    label: 'Bollinger Bands',
    pane: false,
    defaults: { period: 20, mult: 2, color: '#38bdf8' },
    params: [
      { key: 'period', label: 'Length', min: 2, max: 500 },
      { key: 'mult', label: 'StdDev', min: 0.5, max: 5, step: 0.5 },
    ],
  },
  vwap: { label: 'VWAP', pane: false, defaults: { color: '#f472b6' }, params: [] },
  rsi: {
    label: 'RSI',
    pane: true,
    defaults: { period: 14, color: '#c084fc' },
    params: [{ key: 'period', label: 'Length', min: 2, max: 100 }],
    levels: [70, 30],
  },
  macd: {
    label: 'MACD',
    pane: true,
    defaults: { fast: 12, slow: 26, signal: 9, color: '#3b82f6' },
    params: [
      { key: 'fast', label: 'Fast', min: 1, max: 100 },
      { key: 'slow', label: 'Slow', min: 2, max: 200 },
      { key: 'signal', label: 'Signal', min: 1, max: 100 },
    ],
  },
  oi: {
    label: 'Open Interest',
    pane: true,
    defaults: { color: '#fbbf24' },
    params: [],
    derivativeOnly: true,
  },
};

export const INDICATOR_ORDER: IndicatorType[] = ['sma', 'ema', 'bb', 'vwap', 'rsi', 'macd', 'oi'];

export interface Line {
  name: string;
  color: string;
  values: Series;
  kind: 'line' | 'histogram';
  /** Thinner/dashed secondary lines (bands, signal). */
  secondary?: boolean;
}

/** Short label for legends, e.g. "EMA 50", "BB 20 2", "MACD 12 26 9". */
export function indicatorLabel(c: IndicatorConfig): string {
  const d = INDICATOR_DEFS[c.type];
  const params = d.params.map((p) => c[p.key] ?? d.defaults[p.key]).filter((v) => v !== undefined);
  return [c.type === 'bb' ? 'BB' : d.label, ...params].join(' ');
}

export function newIndicator(type: IndicatorType): IndicatorConfig {
  return {
    id: `${type}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    ...INDICATOR_DEFS[type].defaults,
  };
}

/** Computes an indicator's lines over candles (aligned by index). */
export function computeIndicator(c: IndicatorConfig, candles: readonly Candle[]): Line[] {
  const d = INDICATOR_DEFS[c.type];
  const color = c.color ?? d.defaults.color ?? '#94a3b8';
  const px = closes(candles);
  const p = (k: ParamDef['key']) => Number(c[k] ?? d.defaults[k]);
  switch (c.type) {
    case 'sma':
      return [{ name: 'SMA', color, values: sma(px, p('period')), kind: 'line' }];
    case 'ema':
      return [{ name: 'EMA', color, values: ema(px, p('period')), kind: 'line' }];
    case 'bb': {
      const b = bollinger(px, p('period'), p('mult'));
      return [
        { name: 'Basis', color, values: b.mid, kind: 'line', secondary: true },
        { name: 'Upper', color, values: b.upper, kind: 'line' },
        { name: 'Lower', color, values: b.lower, kind: 'line' },
      ];
    }
    case 'vwap':
      return [{ name: 'VWAP', color, values: vwap(candles), kind: 'line' }];
    case 'rsi':
      return [{ name: 'RSI', color, values: rsi(px, p('period')), kind: 'line' }];
    case 'macd': {
      const m = macd(px, p('fast'), p('slow'), p('signal'));
      return [
        { name: 'Hist', color: '#64748b', values: m.histogram, kind: 'histogram' },
        { name: 'MACD', color, values: m.macd, kind: 'line' },
        { name: 'Signal', color: '#f97316', values: m.signal, kind: 'line', secondary: true },
      ];
    }
    case 'oi':
      return [
        { name: 'OI', color, values: candles.map((k) => (k.oi ? k.oi : null)), kind: 'line' },
      ];
  }
}
