import type { B2BLive, B2BPlot, B2BResult, TimeMapper } from '@otv/shared';
import type { ISeriesApi } from 'lightweight-charts';
import { B2BPrimitive } from './b2bPrimitive';

/**
 * Varun's script on a chart: its boxes, labels and five plotted levels (entry,
 * lot 1 and lot 2 stops, the lot 1 booking level and the +10 trigger), drawn
 * by one series primitive.
 */
export class B2BLayer {
  private readonly prim = new B2BPrimitive();
  private shown = false;

  constructor(candles: ISeriesApi<'Candlestick'>) {
    candles.attachPrimitive(this.prim);
  }

  setMapper(m: TimeMapper): void {
    this.prim.setMapper(m);
  }

  /** Shows the script's output, with the plots carried on to the forming candle. */
  show(res: B2BResult, live: B2BLive | null, opts: { labels: boolean }): void {
    this.shown = true;
    const plots: B2BPlot[] =
      live && res.plots.length && live.time > res.plots.at(-1)!.time
        ? [...res.plots, { ...res.plots.at(-1)!, time: live.time }]
        : res.plots;
    this.prim.setData({
      zones: [...res.bull, ...res.bear],
      ghosts: res.ghosts,
      labels: opts.labels ? res.labels : [],
      plots,
      lastTime: Math.max(live?.time ?? 0, res.lastTime ?? 0),
    });
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.prim.setData(null);
  }
}
