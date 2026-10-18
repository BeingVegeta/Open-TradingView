import type { B2BGhost, B2BLabel, B2BPlot, B2BZone, TimeMapper } from '@otv/shared';
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

/** Pine v5 colour constants used by the script. */
export const PINE = {
  teal: '#089981',
  red: '#F23645',
  orange: '#FF9800',
  aqua: '#00BCD4',
  gray: '#787B86',
  olive: '#808000',
  maroon: '#880E4F',
  green: '#4CAF50',
  lime: '#00E676',
  yellow: '#FFEB3B',
  white: '#FFFFFF',
} as const;

/** Pine `color.new(c, transparency)` as an rgba() string. */
export function pineColor(hex: string, transparency = 0): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${(100 - transparency) / 100})`;
}

const ZONE_STYLE: Record<B2BZone['kind'], { color: string; text: string; bull: boolean }> = {
  bullBlock: { color: PINE.teal, text: 'BULL BLOCK 1m', bull: true },
  bearBlock: { color: PINE.red, text: 'BEAR BLOCK 1m', bull: false },
  bullBreaker: { color: PINE.aqua, text: 'BULL BREAKER 1m', bull: true },
  bearBreaker: { color: PINE.orange, text: 'BEAR BREAKER 1m', bull: false },
};

const LABEL_COLOR: Record<B2BLabel['color'], { hex: string; transparency: number }> = {
  teal: { hex: PINE.teal, transparency: 10 },
  maroon: { hex: PINE.maroon, transparency: 10 },
  olive: { hex: PINE.olive, transparency: 10 },
  green: { hex: PINE.green, transparency: 15 },
  red: { hex: PINE.red, transparency: 15 },
};

export interface B2BOverlay {
  zones: B2BZone[];
  ghosts: B2BGhost[];
  labels: B2BLabel[];
  /** Per-bar plotted levels (null = the script plots na there, breaking the line). */
  plots: B2BPlot[];
  /** Time of the chart's newest bar: live boxes reach 3 bars past it, as in the script. */
  lastTime: number;
}

/** The script's five plots, as Pine draws them (plot.style_linebr / circles). */
const PLOTS: {
  pick: (p: B2BPlot) => number | null;
  color: (p: B2BPlot) => string;
  width: number;
  circles?: boolean;
}[] = [
  { pick: (p) => p.entry, color: () => pineColor(PINE.white, 30), width: 1 },
  { pick: (p) => p.sl1, color: (p) => (p.protectedStops ? PINE.lime : PINE.red), width: 1 },
  { pick: (p) => p.sl2, color: (p) => (p.protectedStops ? PINE.aqua : PINE.red), width: 2 },
  { pick: (p) => p.book, color: () => PINE.olive, width: 1 },
  { pick: (p) => p.trigger, color: () => pineColor(PINE.yellow, 40), width: 1, circles: true },
];

/**
 * Draws Varun's script's boxes (live blocks and breakers, grey ghosts of
 * broken ones) and its labels (calls, lot 1 bookings, exits) on the price pane.
 */
export class B2BPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<'Candlestick'> | null = null;
  private requestUpdate: (() => void) | null = null;
  private data: B2BOverlay | null = null;
  private mapper: TimeMapper | null = null;
  private readonly views: IPrimitivePaneView[] = [
    { zOrder: () => 'normal', renderer: () => ({ draw: (t) => this.draw(t) }) },
  ];

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart as IChartApi;
    this.series = p.series as ISeriesApi<'Candlestick'>;
    this.requestUpdate = p.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setData(d: B2BOverlay | null): void {
    this.data = d;
    this.requestUpdate?.();
  }

  setMapper(m: TimeMapper): void {
    this.mapper = m;
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /** x of a logical bar index (whole bars; Lightweight Charts can't place fractions). */
  private xAt(logical: number): number | null {
    const ts = this.chart?.timeScale();
    if (!ts) return null;
    const i = Math.floor(logical);
    const x0 = ts.logicalToCoordinate(i as never);
    const x1 = ts.logicalToCoordinate((i + 1) as never);
    if (x0 === null || x1 === null) return null;
    return x0 + (logical - i) * (x1 - x0);
  }

  private xOf(time: number): number | null {
    const l = this.mapper?.toLogical(time);
    return l === null || l === undefined ? null : this.xAt(l);
  }

  private draw(target: Target): void {
    const d = this.data;
    const series = this.series;
    if (!d || !series || !this.mapper) return;
    const lastL = this.mapper.toLogical(d.lastTime);
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.save();
      ctx.font = "9px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
      ctx.textBaseline = 'middle';
      const rightLive = lastL === null ? null : this.xAt(lastL + 3);

      for (const g of d.ghosts) {
        this.box(
          series,
          this.xOf(g.leftTime),
          this.xOf(g.rightTime),
          g.top,
          g.bot,
          pineColor(PINE.gray, 35),
          pineColor(PINE.gray, 88),
          g.text,
          pineColor(PINE.gray, 15),
          'center',
          true,
          ctx,
        );
      }
      for (const z of d.zones) {
        const s = ZONE_STYLE[z.kind];
        this.box(
          series,
          this.xOf(z.leftTime),
          rightLive,
          z.top,
          z.bot,
          pineColor(s.color, 30),
          pineColor(s.color, 85),
          s.text,
          s.color,
          s.bull ? 'bottom' : 'top',
          false,
          ctx,
        );
      }
      this.plots(series, d.plots, ctx);
      ctx.font = "10px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
      for (const l of d.labels) this.label(series, l, ctx);
      ctx.restore();
    });
  }

  /** Lines join consecutive bars that both have a value; a missing value breaks them. */
  private plots(
    series: ISeriesApi<'Candlestick'>,
    plots: B2BPlot[],
    ctx: CanvasRenderingContext2D,
  ) {
    const range = this.chart?.timeScale().getVisibleLogicalRange();
    if (!range || !this.mapper) return;
    // Only bars on screen (plus one either side, so lines run off the edges).
    const visible = plots.filter((p) => {
      const l = this.mapper!.toLogical(p.time);
      return l !== null && l >= range.from - 1 && l <= range.to + 1;
    });
    const xs = visible.map((p) => this.xOf(p.time));
    for (const def of PLOTS) {
      let prev: { x: number; y: number } | null = null;
      visible.forEach((p, i) => {
        const v = def.pick(p);
        const x = xs[i];
        const y = v === null ? null : series.priceToCoordinate(v);
        if (v === null || x === null || x === undefined || y === null) {
          prev = null;
          return;
        }
        ctx.strokeStyle = def.color(p);
        ctx.fillStyle = def.color(p);
        if (def.circles) {
          ctx.beginPath();
          ctx.arc(x, y, 1.5, 0, Math.PI * 2);
          ctx.fill();
        } else if (prev) {
          ctx.lineWidth = def.width;
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        prev = { x, y };
      });
    }
  }

  private box(
    series: ISeriesApi<'Candlestick'>,
    x1: number | null,
    x2: number | null,
    top: number,
    bot: number,
    border: string,
    fill: string,
    text: string,
    textColor: string,
    valign: 'top' | 'bottom' | 'center',
    dashed: boolean,
    ctx: CanvasRenderingContext2D,
  ): void {
    const y1 = series.priceToCoordinate(top);
    const y2 = series.priceToCoordinate(bot);
    if (x1 === null || x2 === null || y1 === null || y2 === null) return;
    const x = Math.min(x1, x2);
    const w = Math.max(1, Math.abs(x2 - x1));
    const y = Math.min(y1, y2);
    const h = Math.max(1, Math.abs(y2 - y1));
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.setLineDash(dashed ? [4, 3] : []);
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
    ctx.setLineDash([]);
    if (h >= 8 && w > 40) {
      ctx.fillStyle = textColor;
      const ty = valign === 'top' ? y + 6 : valign === 'bottom' ? y + h - 6 : y + h / 2;
      ctx.fillText(text, x + 3, ty, w - 6);
    }
  }

  private label(
    series: ISeriesApi<'Candlestick'>,
    l: B2BLabel,
    ctx: CanvasRenderingContext2D,
  ): void {
    const x = this.xOf(l.time);
    const y = series.priceToCoordinate(l.price);
    if (x === null || y === null) return;
    const lines = l.text.split('\n');
    const pad = 4;
    const lh = 12;
    const w = Math.max(...lines.map((t) => ctx.measureText(t).width)) + pad * 2;
    const h = lines.length * lh + pad;
    const arrow = 5;
    // Below the price pointing up (Pine's label_up), or above pointing down.
    const top = l.below ? y + arrow : y - arrow - h;
    const c = LABEL_COLOR[l.color];
    ctx.fillStyle = pineColor(c.hex, c.transparency);
    ctx.beginPath();
    ctx.roundRect(x - w / 2, top, w, h, 3);
    ctx.fill();
    ctx.beginPath();
    if (l.below) {
      ctx.moveTo(x - arrow, y + arrow);
      ctx.lineTo(x, y);
      ctx.lineTo(x + arrow, y + arrow);
    } else {
      ctx.moveTo(x - arrow, y - arrow);
      ctx.lineTo(x, y);
      ctx.lineTo(x + arrow, y - arrow);
    }
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    lines.forEach((t, i) => ctx.fillText(t, x, top + pad / 2 + lh / 2 + i * lh));
    ctx.textAlign = 'left';
  }
}
