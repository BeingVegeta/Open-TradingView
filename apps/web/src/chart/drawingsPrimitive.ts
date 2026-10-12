import { TimeMapper, type ChartPoint, type Drawing } from '@otv/shared';
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

/** Which part of a drawing is under the pointer. */
export interface DrawingHit {
  id: string;
  part: 'line' | 'a' | 'b';
  distance: number;
}

const HIT_PX = 6;
const HANDLE_PX = 8;

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Draws horizontal lines and trend lines on the price pane, in step with every
 * pan and zoom (Lightweight Charts calls it on each render), with price-axis
 * labels for horizontal lines and a hit test for the cursor.
 */
export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<'Candlestick'> | null = null;
  private requestUpdate: (() => void) | null = null;
  private drawings: Drawing[] = [];
  private selected: string | null = null;
  /** A trend line being drawn. */
  private preview: { a: ChartPoint; b: ChartPoint } | null = null;
  private mapper = new TimeMapper([], { bar: 1, session: { open: 0, close: 24 * 60 } });
  private axisViews: ISeriesPrimitiveAxisView[] = [];
  private readonly views: IPrimitivePaneView[] = [
    { zOrder: () => 'top', renderer: () => ({ draw: (t) => this.draw(t) }) },
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

  setDrawings(list: Drawing[]): void {
    this.drawings = list;
    if (this.selected && !list.some((d) => d.id === this.selected)) this.selected = null;
    this.rebuildAxisViews();
    this.requestUpdate?.();
  }

  setSelected(id: string | null): void {
    this.selected = id;
    this.rebuildAxisViews();
    this.requestUpdate?.();
  }

  setPreview(p: { a: ChartPoint; b: ChartPoint } | null): void {
    this.preview = p;
    this.requestUpdate?.();
  }

  setMapper(m: TimeMapper): void {
    this.mapper = m;
    this.requestUpdate?.();
  }

  get timeMapper(): TimeMapper {
    return this.mapper;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.axisViews;
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const h = this.hit(x, y);
    if (!h) return null;
    return {
      externalId: h.id,
      zOrder: 'top',
      cursorStyle: h.part === 'line' ? 'move' : 'grab',
      distance: h.distance,
      hitTestPriority: h.part === 'line' ? 1 : 2,
    };
  }

  /** The drawing (and part of it) at a point in the price pane, if any. */
  hit(x: number, y: number): DrawingHit | null {
    let best: DrawingHit | null = null;
    for (const d of this.drawings) {
      if (d.type === 'hline') {
        const py = this.series?.priceToCoordinate(d.price);
        if (py == null) continue;
        const dist = Math.abs(y - py);
        if (dist <= HIT_PX && (!best || dist < best.distance))
          best = { id: d.id, part: 'line', distance: dist };
      } else {
        const a = this.toXY(d.a);
        const b = this.toXY(d.b);
        if (!a || !b) continue;
        const da = Math.hypot(x - a.x, y - a.y);
        const db = Math.hypot(x - b.x, y - b.y);
        if (da <= HANDLE_PX && (!best || da < best.distance)) {
          best = { id: d.id, part: 'a', distance: da };
          continue;
        }
        if (db <= HANDLE_PX && (!best || db < best.distance)) {
          best = { id: d.id, part: 'b', distance: db };
          continue;
        }
        const dl = distToSegment(x, y, a.x, a.y, b.x, b.y);
        if (dl <= HIT_PX && (!best || dl < best.distance))
          best = { id: d.id, part: 'line', distance: dl };
      }
    }
    return best;
  }

  /** Pixel position of a chart point, or null if it can't be placed yet. */
  toXY(p: ChartPoint): { x: number; y: number } | null {
    const l = this.mapper.toLogical(p.time);
    if (l === null || !this.chart || !this.series) return null;
    // logicalToCoordinate returns 0 for fractional indexes (Lightweight Charts
    // 5.2), so interpolate between the whole bars either side.
    const ts = this.chart.timeScale();
    const i = Math.floor(l);
    const x0 = ts.logicalToCoordinate(i as never);
    const x1 = ts.logicalToCoordinate((i + 1) as never);
    const y = this.series.priceToCoordinate(p.price);
    if (x0 === null || x1 === null || y === null) return null;
    return { x: x0 + (l - i) * (x1 - x0), y };
  }

  /** Chart point at a pixel position. */
  fromXY(x: number, y: number): ChartPoint | null {
    if (!this.chart || !this.series) return null;
    const l = this.chart.timeScale().coordinateToLogical(x);
    const price = this.series.coordinateToPrice(y);
    const time = l === null ? null : this.mapper.toTime(l);
    return time === null || price === null ? null : { time, price };
  }

  private rebuildAxisViews(): void {
    // A new array only when the set of labels changes (the library caches by reference).
    this.axisViews = this.drawings
      .filter((d): d is Extract<Drawing, { type: 'hline' }> => d.type === 'hline')
      .map((d) => ({
        coordinate: () => this.series?.priceToCoordinate(d.price) ?? -100,
        text: () => this.series?.priceFormatter().format(d.price) ?? String(d.price),
        textColor: () => '#0b0e14',
        backColor: () => d.color,
        visible: () => this.series?.priceToCoordinate(d.price) != null,
      }));
  }

  private draw(target: Target): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      for (const d of this.drawings) {
        const sel = d.id === this.selected;
        ctx.strokeStyle = d.color;
        ctx.lineWidth = sel ? 2 : 1.5;
        ctx.setLineDash([]);
        if (d.type === 'hline') {
          const y = this.series?.priceToCoordinate(d.price);
          if (y == null) continue;
          ctx.beginPath();
          ctx.moveTo(0, Math.round(y) + 0.5);
          ctx.lineTo(mediaSize.width, Math.round(y) + 0.5);
          ctx.stroke();
          if (sel) this.handle(ctx, mediaSize.width / 2, y, d.color);
        } else {
          const a = this.toXY(d.a);
          const b = this.toXY(d.b);
          if (!a || !b) continue;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          if (sel) {
            this.handle(ctx, a.x, a.y, d.color);
            this.handle(ctx, b.x, b.y, d.color);
          }
        }
      }
      if (this.preview) {
        const a = this.toXY(this.preview.a);
        const b = this.toXY(this.preview.b);
        if (a && b) {
          ctx.strokeStyle = '#60a5fa';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.setLineDash([]);
          this.handle(ctx, a.x, a.y, '#60a5fa');
        }
      }
      ctx.restore();
    });
  }

  private handle(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0e14';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
}
