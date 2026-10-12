import {
  getTimeframe,
  hasVolume,
  instrumentKind,
  instrumentSession,
  isPeriodBar,
  priceDecimals,
  TimeMapper,
  type Candle,
  type ChartPoint,
  type Drawing,
  type Instrument,
  type TimeframeId,
} from '@otv/shared';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type Time,
} from 'lightweight-charts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { historyStore, type SeriesState } from '../market/historyStore';
import { recordPerf } from '../perf';
import {
  DEFAULT_COLOR,
  DRAWING_COLORS,
  newDrawingId,
  useDrawings,
  useInstrumentDrawings,
} from '../drawings/drawingsStore';
import { useWorkspace } from '../workspace/workspaceStore';
import { fromChartTime, toChartCandle, toChartTime } from './chartTime';
import { DrawingsPrimitive, type DrawingHit } from './drawingsPrimitive';
import { IndicatorLayer } from './indicatorLayer';
import { Legend, type LegendData } from './Legend';

const UP = '#22c55e';
const DOWN = '#ef4444';
const UP_VOL = 'rgba(34, 197, 94, 0.38)';
const DOWN_VOL = 'rgba(239, 68, 68, 0.38)';
/** Bars shown when a series is first opened. */
const INITIAL_VISIBLE = 160;
/** Prefetch older bars when fewer than this many screens of them remain to the left. */
const PREFETCH_SCREENS = 2;
/** Background tail refresh when re-opening a cached series older than this. */
const TAIL_REFRESH_MS = 15_000;

type Status = { id: string } & (
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'empty' }
  | { state: 'error'; code: string; message: string }
);

/** A drawing moved by dragging `part` from `from` to `to`. */
function moveDrawing(
  d: Drawing,
  part: DrawingHit['part'],
  from: ChartPoint,
  to: ChartPoint,
  mapper: TimeMapper,
  roundPrice: (p: number) => number,
): Drawing {
  const dp = to.price - from.price;
  if (d.type === 'hline') return { ...d, price: roundPrice(d.price + dp) };
  if (part === 'a') return { ...d, a: to };
  if (part === 'b') return { ...d, b: to };
  // Shift in bars rather than seconds, so a line keeps its shape across overnight gaps.
  const dl = (mapper.toLogical(to.time) ?? 0) - (mapper.toLogical(from.time) ?? 0);
  const shift = (p: ChartPoint): ChartPoint => ({
    time: mapper.toTime((mapper.toLogical(p.time) ?? 0) + dl) ?? p.time,
    price: p.price + dp,
  });
  return { ...d, a: shift(d.a), b: shift(d.b) };
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

export function ChartView({
  chart: chartIndex,
  instrument,
  tf,
}: {
  /** Index of this chart in the workspace grid. */
  chart: number;
  instrument: Instrument;
  tf: TimeframeId;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const layerRef = useRef<IndicatorLayer | null>(null);
  const drawRef = useRef<DrawingsPrimitive | null>(null);
  /** Bar time under the crosshair (epoch s), or null for the newest bar. */
  const hoverRef = useRef<number | null>(null);
  const indicators = useWorkspace((s) => s.charts[chartIndex]!.indicators);
  const [legend, setLegend] = useState<LegendData>({
    candle: null,
    prev: null,
    indicators: [],
    hovering: false,
  });
  /** Which series the chart currently shows, to ignore late responses for an old one. */
  const currentRef = useRef({ key: instrument.key, tf });
  const seriesId = `${instrument.key}|${tf}`;
  const [storedStatus, setStatus] = useState<Status>({ id: '', state: 'loading' });
  // A status recorded for another series means this one is still loading.
  const status: Status =
    storedStatus.id === seriesId ? storedStatus : { id: seriesId, state: 'loading' };
  const [retry, setRetry] = useState(0);
  /** The series id whose history is on screen (live updates start after it loads). */
  const [loadedId, setLoadedId] = useState('');

  // Create the chart once.
  useEffect(() => {
    const el = containerRef.current!;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#0b0e14' },
        textColor: '#8a94a6',
        fontSize: 11,
        fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        // Required by the Lightweight Charts licence (link to TradingView). Keep it on.
        attributionLogo: true,
        panes: { separatorColor: '#222a37' },
      },
      grid: { vertLines: { color: '#131924' }, horzLines: { color: '#131924' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#222a37' },
      timeScale: {
        borderColor: '#222a37',
        rightOffset: 6,
        barSpacing: 7,
        timeVisible: true,
        secondsVisible: false,
      },
      localization: { dateFormat: "dd MMM 'yy" },
    });
    candlesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    volumeRef.current = chart.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = chart;
    layerRef.current = new IndicatorLayer(chart);
    const drawings = new DrawingsPrimitive();
    candlesRef.current.attachPrimitive(drawings);
    drawRef.current = drawings;
    if (import.meta.env.DEV) {
      // Inspection hook for development and browser tests.
      const w = window as unknown as { __otvDrawings?: DrawingsPrimitive[] };
      (w.__otvDrawings ??= []).push(drawings);
    }
    return () => {
      chart.remove();
      chartRef.current = null;
      layerRef.current = null;
      drawRef.current = null;
    };
  }, []);

  /** Recomputes the legend for the hovered (or newest) bar of the series on screen. */
  const refreshLegend = useCallback(() => {
    const { key, tf: t } = currentRef.current;
    const candles = historyStore.get(key, t)?.candles ?? [];
    const hover = hoverRef.current;
    let i = candles.length - 1;
    if (hover !== null) {
      let lo = 0;
      let hi = candles.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (candles[mid]!.time <= hover) lo = mid;
        else hi = mid - 1;
      }
      i = lo;
    }
    setLegend({
      candle: candles[i] ?? null,
      prev: candles[i - 1] ?? null,
      indicators: i >= 0 && layerRef.current ? layerRef.current.valuesAt(i) : [],
      hovering: hover !== null,
    });
  }, []);

  // Legend follows the crosshair.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const onMove = (p: MouseEventParams<Time>) => {
      hoverRef.current = p.time === undefined ? null : fromChartTime(p.time as number);
      refreshLegend();
    };
    chart.subscribeCrosshairMove(onMove);
    return () => chart.unsubscribeCrosshairMove(onMove);
  }, [refreshLegend]);

  // Indicator series follow the saved configuration.
  const kind = instrumentKind(instrument);
  const derivative = kind === 'future' || kind === 'option';
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const s = historyStore.get(currentRef.current.key, currentRef.current.tf);
    layer.build(indicators, { derivative });
    if (s) layer.setData(s.candles);
    refreshLegend();
  }, [indicators, derivative, refreshLegend]);

  /** Pushes a series' candles into the chart. `resetView` scrolls to the newest bars. */
  const render = useCallback(
    (s: SeriesState, resetView: boolean) => {
      const chart = chartRef.current;
      if (!chart) return;
      const t0 = performance.now();
      candlesRef.current!.setData(s.candles.map(toChartCandle));
      const withVolume = hasVolume(instrument);
      volumeRef.current!.applyOptions({ visible: withVolume });
      volumeRef.current!.setData(
        withVolume
          ? s.candles.map((c) => ({
              time: toChartTime(c.time),
              value: c.volume,
              color: c.close >= c.open ? UP_VOL : DOWN_VOL,
            }))
          : [],
      );
      const t1 = performance.now();
      layerRef.current?.setData(s.candles);
      drawRef.current?.setMapper(
        new TimeMapper(s.candles, {
          bar: getTimeframe(currentRef.current.tf)?.bar ?? 1,
          session: instrumentSession(instrument),
        }),
      );
      recordPerf({
        type: 'render-cost',
        bars: s.candles.length,
        priceMs: t1 - t0,
        indicatorsMs: performance.now() - t1,
      });
      // At the start of the instrument's history, don't let the view drift into empty space.
      chart.timeScale().applyOptions({ fixLeftEdge: !s.hasMore });
      if (resetView) {
        const n = s.candles.length;
        chart
          .timeScale()
          .setVisibleLogicalRange({ from: Math.max(0, n - INITIAL_VISIBLE), to: n + 5 });
      }
      const id = `${instrument.key}|${currentRef.current.tf}`;
      setStatus(s.candles.length ? { id, state: 'ready' } : { id, state: 'empty' });
      refreshLegend();
    },
    [instrument, refreshLegend],
  );

  // Price precision and time axis style follow the instrument and timeframe.
  useEffect(() => {
    const tick = instrument.tickSize > 0 ? instrument.tickSize : 0.01;
    candlesRef.current?.applyOptions({
      priceFormat: { type: 'price', precision: priceDecimals(tick), minMove: tick },
    });
    chartRef.current?.applyOptions({
      timeScale: { timeVisible: !isPeriodBar(getTimeframe(tf)?.bar ?? 1) },
    });
  }, [instrument, tf]);

  // Load the series whenever the symbol or timeframe changes.
  useEffect(() => {
    const key = instrument.key;
    currentRef.current = { key, tf };
    const isCurrent = () => currentRef.current.key === key && currentRef.current.tf === tf;
    const startedAt = useWorkspace.getState().switchStartedAt ?? performance.now();
    const cached = historyStore.get(key, tf);
    let cancelled = false;

    const done = async (s: SeriesState, wasCached: boolean) => {
      render(s, true);
      setLoadedId(`${key}|${tf}`);
      await nextFrame();
      recordPerf({
        type: 'series-render',
        key,
        tf,
        cached: wasCached,
        ms: performance.now() - startedAt,
        bars: s.candles.length,
      });
    };

    if (cached) {
      void done(cached, true);
      if (Date.now() - cached.refreshedAt > TAIL_REFRESH_MS) {
        // Changes arrive through historyStore.onChange (a reload included).
        historyStore.refreshTail(key, tf).catch(() => {});
      }
    } else {
      candlesRef.current?.setData([]);
      volumeRef.current?.setData([]);
      historyStore
        .load(key, tf)
        .then((s) => {
          if (isCurrent()) return done(s, false);
        })
        .catch((err: unknown) => {
          if (cancelled || !isCurrent()) return;
          const e = err instanceof ApiError ? err : new ApiError(0, 'error', String(err));
          setStatus({ id: `${key}|${tf}`, state: 'error', code: e.code, message: e.message });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [instrument.key, tf, render, retry]);

  // Updates to the series on screen, whichever chart or live push caused them.
  const live = loadedId === seriesId;
  useEffect(() => {
    if (!live) return;
    const key = instrument.key;
    const withVolume = hasVolume(instrument);
    const volBar = (c: Candle) => ({
      time: toChartTime(c.time),
      value: c.volume,
      color: c.close >= c.open ? UP_VOL : DOWN_VOL,
    });
    const off = historyStore.onChange(key, tf, (change) => {
      const s = historyStore.get(key, tf);
      if (change.kind === 'reload' || !s) {
        setRetry((n) => n + 1); // the server asked for a full reload
      } else if (change.kind === 'all') {
        render(s, false);
      } else {
        // Only the newest bars changed or new bars started: cheap incremental update.
        // (Lightweight Charts can only update its newest bar or append.)
        for (const c of s.candles.slice(change.from)) {
          candlesRef.current?.update(toChartCandle(c));
          if (withVolume) volumeRef.current?.update(volBar(c));
        }
        layerRef.current?.update(s.candles, change.from);
        if (hoverRef.current === null) refreshLegend();
      }
    });
    const unfollow = historyStore.follow(key, tf);
    return () => {
      off();
      unfollow();
    };
  }, [live, instrument, tf, render, refreshLegend]);

  // Scroll-back: fetch older candles before the user reaches the left edge.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const key = instrument.key;
    let edgeReported = false;
    const onRange = (range: LogicalRange | null) => {
      if (!range) return;
      const s = historyStore.get(key, tf);
      if (!s || !s.candles.length) return;
      const visible = range.to - range.from;
      const barsLeft = range.from; // logical index 0 is the oldest loaded candle
      const loading = historyStore.isLoadingOlder(key, tf);
      if (barsLeft < 0 && s.hasMore && !edgeReported) {
        edgeReported = true;
        recordPerf({ type: 'edge-reached', key, tf, whileLoading: loading });
      }
      // Start fetching while two screens of older bars are still loaded, so even a
      // fast drag doesn't reach the edge before the next chunk arrives.
      if (barsLeft >= Math.max(visible * PREFETCH_SCREENS, 100) || !s.hasMore || loading) return;
      const t0 = performance.now();
      const bars = Math.min(2000, Math.max(300, Math.ceil(visible * 4)));
      historyStore
        .loadOlder(key, tf, bars)
        .then((added) => {
          recordPerf({
            type: 'prefetch',
            key,
            tf,
            barsLeftAtTrigger: Math.round(barsLeft),
            visibleBars: Math.round(visible),
            ms: performance.now() - t0,
            added,
          });
          edgeReported = false; // the chart re-renders through historyStore.onChange
        })
        .catch(() => {});
    };
    const ts = chart.timeScale();
    ts.subscribeVisibleLogicalRangeChange(onRange);
    return () => ts.unsubscribeVisibleLogicalRangeChange(onRange);
  }, [instrument.key, tf]);

  // Drawings: shown on every timeframe of the instrument.
  const drawings = useInstrumentDrawings(instrument.key);
  const selectedId = useDrawings((s) =>
    s.selected?.key === instrument.key ? s.selected.id : null,
  );
  const isActive = useWorkspace((s) => s.active === chartIndex);
  useEffect(() => drawRef.current?.setDrawings(drawings), [drawings]);
  useEffect(() => drawRef.current?.setSelected(selectedId), [selectedId]);

  // Placing, selecting and dragging drawings. Lightweight Charts listens for mouse
  // events, so a mousedown that starts drawing work is caught first (capture phase).
  useEffect(() => {
    const el = containerRef.current!;
    const chart = chartRef.current!;
    const prim = drawRef.current!;
    const key = instrument.key;
    const tick = instrument.tickSize > 0 ? instrument.tickSize : 0.05;
    const roundPrice = (p: number) => Math.round(Math.round(p / tick) * tick * 1e6) / 1e6;
    const list = () => useDrawings.getState().byKey[key] ?? [];
    let drag: {
      id: string;
      part: DrawingHit['part'];
      start: ChartPoint;
      orig: Drawing;
      latest: Drawing | null;
    } | null = null;
    let pending: { a: ChartPoint; x: number; y: number } | null = null;

    const local = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const inPricePane = (p: { x: number; y: number }) =>
      p.x >= 0 &&
      p.y >= 0 &&
      p.x < chart.timeScale().width() &&
      p.y < (chart.panes()[0]?.getHeight() ?? 0);
    const setScroll = (on: boolean) => chart.applyOptions({ handleScroll: on, handleScale: on });
    const stop = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const finishTrend = (b: ChartPoint) => {
      if (!pending) return;
      const st = useDrawings.getState();
      const d: Drawing = {
        id: newDrawingId(),
        type: 'trend',
        a: { ...pending.a, price: roundPrice(pending.a.price) },
        b: { ...b, price: roundPrice(b.price) },
        color: DEFAULT_COLOR.trend,
      };
      pending = null;
      prim.setPreview(null);
      setScroll(true);
      st.save(key, [...list(), d]);
      st.setTool(null);
      st.select({ key, id: d.id });
    };
    const cancelPending = () => {
      if (!pending) return;
      pending = null;
      prim.setPreview(null);
      setScroll(true);
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const p = local(e);
      if (!inPricePane(p)) return;
      const st = useDrawings.getState();
      const pt = prim.fromXY(p.x, p.y);
      if (st.tool) {
        stop(e);
        if (!pt) return;
        if (st.tool === 'hline') {
          const d: Drawing = {
            id: newDrawingId(),
            type: 'hline',
            price: roundPrice(pt.price),
            color: DEFAULT_COLOR.hline,
          };
          st.save(key, [...list(), d]);
          st.setTool(null);
          st.select({ key, id: d.id });
        } else if (!pending) {
          pending = { a: pt, x: p.x, y: p.y };
          prim.setPreview({ a: pt, b: pt });
          setScroll(false);
        } else {
          finishTrend(pt);
        }
        return;
      }
      const h = prim.hit(p.x, p.y);
      const d = h && list().find((x) => x.id === h.id);
      if (h && d && pt) {
        stop(e);
        st.select({ key, id: h.id });
        drag = { id: h.id, part: h.part, start: pt, orig: d, latest: null };
        setScroll(false);
      } else if (st.selected) {
        st.select(null);
      }
    };
    const onMove = (e: MouseEvent) => {
      if (!drag && !pending) return;
      const p = local(e);
      const pt = prim.fromXY(p.x, p.y);
      if (!pt) return;
      if (pending) {
        prim.setPreview({ a: pending.a, b: pt });
      } else if (drag) {
        const d = moveDrawing(drag.orig, drag.part, drag.start, pt, prim.timeMapper, roundPrice);
        drag.latest = d;
        prim.setDrawings(list().map((x) => (x.id === d.id ? d : x)));
      }
    };
    const onUp = (e: MouseEvent) => {
      if (drag) {
        const d = drag.latest;
        drag = null;
        setScroll(true);
        if (d)
          useDrawings.getState().save(
            key,
            list().map((x) => (x.id === d.id ? d : x)),
          );
        return;
      }
      if (pending) {
        // Press-drag-release draws a trend line too.
        const p = local(e);
        if (Math.hypot(p.x - pending.x, p.y - pending.y) > 8) {
          const pt = prim.fromXY(p.x, p.y);
          if (pt) finishTrend(pt);
        }
      }
    };
    // Escape (or another tool) abandons a half-drawn trend line.
    const unsub = useDrawings.subscribe((s) => {
      if (s.tool !== 'trend') cancelPending();
    });
    el.addEventListener('mousedown', onDown, true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      unsub();
      cancelPending();
      if (drag) setScroll(true);
      el.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [instrument.key, instrument.tickSize]);

  const selectedDrawing = selectedId ? drawings.find((d) => d.id === selectedId) : undefined;
  const recolor = (color: string) =>
    selectedDrawing &&
    useDrawings.getState().save(
      instrument.key,
      drawings.map((d) => (d.id === selectedDrawing.id ? { ...d, color } : d)),
    );

  return (
    <div className="chart-wrap">
      <div ref={containerRef} className="chart" />
      {status.state === 'ready' && (
        <Legend
          chart={chartIndex}
          instrument={instrument}
          tfLabel={getTimeframe(tf)?.label ?? tf}
          data={legend}
        />
      )}
      {isActive && selectedDrawing && (
        <div className="drawing-bar" onMouseDown={(e) => e.stopPropagation()}>
          <span className="muted">
            {selectedDrawing.type === 'hline' ? 'Horizontal line' : 'Trend line'}
          </span>
          {DRAWING_COLORS.map((c) => (
            <button
              key={c}
              className={`swatch ${c === selectedDrawing.color ? 'swatch-on' : ''}`}
              style={{ background: c }}
              onClick={() => recolor(c)}
              aria-label={`Colour ${c}`}
            />
          ))}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              useDrawings.getState().save(
                instrument.key,
                drawings.filter((d) => d.id !== selectedDrawing.id),
              );
              useDrawings.getState().select(null);
            }}
            title="Delete (Del)"
          >
            Delete
          </button>
        </div>
      )}
      {status.state === 'loading' && (
        <div className="chart-overlay">
          <div className="spinner" aria-label="Loading chart" />
        </div>
      )}
      {status.state === 'empty' && (
        <div className="chart-overlay">
          <div className="overlay-card">
            <strong>No candles</strong>
            <p className="muted">Kite has no data for {instrument.key} on this timeframe.</p>
          </div>
        </div>
      )}
      {status.state === 'error' && (
        <div className="chart-overlay">
          <div className="overlay-card">
            <strong>
              {status.code === 'no_market_data'
                ? 'No market data access'
                : "Couldn't load the chart"}
            </strong>
            <p className="muted">{status.message}</p>
            {status.code !== 'no_market_data' && (
              <button className="btn" onClick={() => setRetry((n) => n + 1)}>
                Retry
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
