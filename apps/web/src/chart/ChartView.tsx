import {
  hasVolume,
  priceDecimals,
  type Candle,
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
} from 'lightweight-charts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { liveClient } from '../live/liveClient';
import { historyStore, type SeriesState } from '../market/historyStore';
import { recordPerf } from '../perf';
import { useWorkspace } from '../workspace/workspaceStore';
import { toChartCandle, toChartTime } from './chartTime';

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

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

export function ChartView({ instrument, tf }: { instrument: Instrument; tf: TimeframeId }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
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
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  /** Pushes a series' candles into the chart. `resetView` scrolls to the newest bars. */
  const render = useCallback(
    (s: SeriesState, resetView: boolean) => {
      const chart = chartRef.current;
      if (!chart) return;
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
    },
    [instrument],
  );

  // Price precision and time axis style follow the instrument and timeframe.
  useEffect(() => {
    const tick = instrument.tickSize > 0 ? instrument.tickSize : 0.01;
    candlesRef.current?.applyOptions({
      priceFormat: { type: 'price', precision: priceDecimals(tick), minMove: tick },
    });
    chartRef.current?.applyOptions({ timeScale: { timeVisible: tf !== '1D' } });
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
        historyStore
          .refreshTail(key, tf)
          .then((s) => {
            if (!isCurrent()) return;
            if (s) render(s, false);
            else setRetry((n) => n + 1); // server asked for a full reload
          })
          .catch(() => {});
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

  // Live updates for the series on screen.
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
    return liveClient.subscribe(
      key,
      tf,
      (bars) => {
        const lastBefore = historyStore.get(key, tf)?.candles.at(-1)?.time ?? -Infinity;
        const change = historyStore.applyBars(key, tf, bars);
        if (change === 'all') {
          const s = historyStore.get(key, tf);
          if (s) render(s, false);
        } else if (change === 'tail') {
          // Only the newest bar changed or new bars started: cheap incremental update.
          // (Lightweight Charts can only update its newest bar or append.)
          const s = historyStore.get(key, tf)!;
          for (const c of s.candles.slice(-bars.length - 1)) {
            if (c.time < lastBefore) continue;
            candlesRef.current?.update(toChartCandle(c));
            if (withVolume) volumeRef.current?.update(volBar(c));
          }
        }
      },
      () => {
        // Reconnected after a gap: fetch whatever we missed.
        historyStore
          .refreshTail(key, tf)
          .then((s) => {
            if (s) render(s, false);
            else setRetry((n) => n + 1);
          })
          .catch(() => {});
      },
    );
  }, [live, instrument, tf, render]);

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
          edgeReported = false;
          const cur = historyStore.get(key, tf);
          if (cur && added > 0 && currentRef.current.key === key && currentRef.current.tf === tf)
            render(cur, false);
        })
        .catch(() => {});
    };
    const ts = chart.timeScale();
    ts.subscribeVisibleLogicalRangeChange(onRange);
    return () => ts.unsubscribeVisibleLogicalRangeChange(onRange);
  }, [instrument.key, tf, render]);

  return (
    <div className="chart-wrap">
      <div ref={containerRef} className="chart" />
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
