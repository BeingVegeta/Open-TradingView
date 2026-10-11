import type { Candle } from '@otv/shared';
import {
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
} from 'lightweight-charts';
import type { IndicatorConfig } from '../workspace/workspaceStore';
import { toChartTime } from './chartTime';
import { computeIndicator, INDICATOR_DEFS, type Line } from './indicatorDefs';

interface Instance {
  cfg: IndicatorConfig;
  series: ISeriesApi<SeriesType>[];
  lines: Line[];
}

const HIST_UP = 'rgba(34, 197, 94, 0.55)';
const HIST_DOWN = 'rgba(239, 68, 68, 0.55)';

/**
 * The chart's indicator series. Overlays share the price pane; RSI, MACD and
 * OI each get their own pane below. Rebuilt when the configuration changes;
 * recomputed in full on data changes (cheap at chart sizes), with only the
 * newest points pushed to the chart for live updates.
 */
export class IndicatorLayer {
  private instances: Instance[] = [];
  private candles: readonly Candle[] = [];

  constructor(private readonly chart: IChartApi) {}

  build(configs: IndicatorConfig[], ctx: { derivative: boolean }): void {
    this.clear();
    let pane = 1;
    for (const cfg of configs) {
      const def = INDICATOR_DEFS[cfg.type];
      if (!def) continue;
      if (def.derivativeOnly && !ctx.derivative) {
        this.instances.push({ cfg, series: [], lines: [] });
        continue;
      }
      const paneIndex = def.pane ? pane++ : 0;
      const lines = computeIndicator(cfg, []);
      const series = lines.map((l) => {
        const common = { priceLineVisible: false, lastValueVisible: !l.secondary, title: '' };
        const s =
          l.kind === 'histogram'
            ? this.chart.addSeries(
                HistogramSeries,
                {
                  ...common,
                  color: l.color,
                  priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
                },
                paneIndex,
              )
            : this.chart.addSeries(
                LineSeries,
                {
                  ...common,
                  color: l.color,
                  lineWidth: l.secondary ? 1 : 2,
                  lineStyle: l.secondary ? LineStyle.Dashed : LineStyle.Solid,
                  crosshairMarkerVisible: !l.secondary,
                  ...(cfg.type === 'oi' ? { priceFormat: { type: 'volume' as const } } : {}),
                },
                paneIndex,
              );
        return s as ISeriesApi<SeriesType>;
      });
      for (const lvl of def.levels ?? []) {
        series[0]?.createPriceLine({
          price: lvl,
          color: '#475569',
          lineStyle: LineStyle.Dotted,
          lineWidth: 1,
          axisLabelVisible: false,
          title: '',
        });
      }
      this.instances.push({ cfg, series, lines });
    }
    // Indicator panes take a smaller share of the height than the price pane.
    const panes = this.chart.panes();
    panes.forEach((p, i) => p.setStretchFactor(i === 0 ? 1 : 0.28));
    if (this.candles.length) this.setData(this.candles);
  }

  setData(candles: readonly Candle[]): void {
    this.candles = candles;
    for (const inst of this.instances) {
      if (!inst.series.length) continue;
      inst.lines = computeIndicator(inst.cfg, candles);
      inst.lines.forEach((l, k) => inst.series[k]!.setData(this.points(l, candles, 0)));
    }
  }

  /** Live update: recompute, then push points from `fromIndex` (the newest bars) only. */
  update(candles: readonly Candle[], fromIndex: number): void {
    this.candles = candles;
    for (const inst of this.instances) {
      if (!inst.series.length) continue;
      inst.lines = computeIndicator(inst.cfg, candles);
      inst.lines.forEach((l, k) => {
        for (const p of this.points(l, candles, fromIndex)) inst.series[k]!.update(p);
      });
    }
  }

  /** Indicator values at a bar index, for the legend. */
  valuesAt(
    index: number,
  ): { cfg: IndicatorConfig; values: { name: string; color: string; value: number | null }[] }[] {
    return this.instances.map((inst) => ({
      cfg: inst.cfg,
      values: inst.lines.map((l) => ({
        name: l.name,
        color: l.color,
        value: l.values[index] ?? null,
      })),
    }));
  }

  clear(): void {
    for (const inst of this.instances) for (const s of inst.series) this.chart.removeSeries(s);
    this.instances = [];
    const panes = this.chart.panes();
    for (let i = panes.length - 1; i >= 1; i--) this.chart.removePane(i);
  }

  private points(l: Line, candles: readonly Candle[], from: number) {
    const out = [];
    for (let i = Math.max(0, from); i < candles.length; i++) {
      const v = l.values[i];
      if (v === null || v === undefined) continue;
      const time = toChartTime(candles[i]!.time);
      out.push(
        l.kind === 'histogram'
          ? { time, value: v, color: v >= 0 ? HIST_UP : HIST_DOWN }
          : { time, value: v },
      );
    }
    return out;
  }
}
