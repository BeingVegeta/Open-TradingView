import {
  formingIndexAt,
  runB2B,
  tradingViewIndexSession,
  type B2BAlert,
  type B2BLive,
  type B2BResult,
  type B2BSettings,
  type Candle,
} from '@otv/shared';
import { useEffect } from 'react';
import { create } from 'zustand';
import { failure, notify } from '../components/Toasts';
import { useLive } from '../live/liveClient';
import { historyStore } from '../market/historyStore';
import { useWorkspace } from '../workspace/workspaceStore';

/**
 * About 13 trading days of 1-minute candles. Zones survive across days, so the
 * script's state depends on how much history it has seen; TradingView runs it
 * over its own history (often 5,000+ bars), so a similar depth keeps the two close.
 */
export const B2B_WARMUP_BARS = 5000;
const TF = '1m';

interface B2BRuntime {
  key: string | null;
  loading: boolean;
  error: string | null;
  result: B2BResult | null;
  /** The newest candle (forming or closed): live price for the tables. */
  live: B2BLive | null;
  /** Alert messages since the dashboard opened, newest last. */
  alerts: B2BAlert[];
}

export const useB2B = create<B2BRuntime>(() => ({
  key: null,
  loading: false,
  error: null,
  result: null,
  live: null,
  alerts: [],
}));

/** Market time in epoch seconds (the simulated clock in mock and replay mode). */
function marketNowS(): number {
  const { live, liveAt } = useLive.getState();
  const ms = live ? live.marketNow + (performance.now() - liveAt) * (live.speed ?? 1) : Date.now();
  return Math.floor(ms / 1000);
}

/** Cheap fingerprint of the closed candles: count, ends and the newest few bars in full. */
function signature(closed: readonly Candle[], settings: B2BSettings): string {
  const tail = closed
    .slice(-12)
    .map((c) => `${c.time}:${c.open}:${c.high}:${c.low}:${c.close}`)
    .join(',');
  return `${closed.length}|${closed[0]?.time}|${tail}|${JSON.stringify(settings)}`;
}

/**
 * Runs Varun's script for the chart the dashboard follows, on that
 * instrument's 1-minute candles (whatever timeframe the chart shows).
 */
export function useB2BRuntime(): void {
  const chart = useWorkspace((s) => s.b2b.chart);
  const settings = useWorkspace((s) => s.b2b.settings);
  const instrument = useWorkspace((s) => (chart === null ? null : (s.instruments[chart] ?? null)));
  const key = instrument?.key ?? null;
  const isIndex = instrument?.segment === 'INDICES';

  useEffect(() => {
    if (!key) {
      useB2B.setState({ key: null, result: null, live: null, loading: false, error: null });
      return;
    }
    let stopped = false;
    let lastSig = '';
    /** Alerts up to this bar time were already shown (none on the first run). */
    let seenUntil: number | null = null;
    useB2B.setState({ key, result: null, live: null, loading: true, error: null, alerts: [] });

    const compute = () => {
      if (stopped) return;
      const s = historyStore.get(key, TF);
      if (!s?.candles.length) return;
      const candles = s.candles;
      const nowS = marketNowS();
      const forming = formingIndexAt(candles, nowS);
      const all = forming >= 0 ? candles.slice(0, -1) : candles;
      // TradingView's index day ends at 15:14; see tradingViewIndexSession.
      const closed = isIndex ? tradingViewIndexSession(all) : all;
      const last = candles.at(-1)!;
      const live = { time: last.time, close: last.close };
      const sig = signature(closed, settings);
      if (sig === lastSig) {
        useB2B.setState({ live });
        return;
      }
      lastSig = sig;
      const result = runB2B(closed, { settings });
      const fresh =
        seenUntil === null ? [] : result.alerts.filter((a) => a.time > (seenUntil as number));
      seenUntil = result.lastTime ?? seenUntil ?? 0;
      for (const a of fresh) notify(`Varun B2B: ${a.lines.join('  ·  ')}`);
      useB2B.setState((st) => ({
        result,
        live,
        loading: false,
        alerts: fresh.length ? [...st.alerts, ...fresh].slice(-100) : st.alerts,
      }));
    };

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        compute();
      });
    };

    const off = historyStore.onChange(key, TF, (change) => {
      if (change.kind === 'reload') void load();
      else schedule();
    });
    let unfollow: (() => void) | null = null;
    const load = async () => {
      try {
        let s = await historyStore.load(key, TF);
        for (let i = 0; i < 4 && !stopped && s.hasMore && s.candles.length < B2B_WARMUP_BARS; i++) {
          const added = await historyStore.loadOlder(key, TF, 2000);
          s = historyStore.get(key, TF) ?? s;
          if (!added) break;
        }
        if (stopped) return;
        unfollow ??= historyStore.follow(key, TF);
        compute();
      } catch (err) {
        if (!stopped)
          useB2B.setState({
            loading: false,
            error: failure("Couldn't load 1-minute history", err),
          });
      }
    };
    void load();
    // A candle also closes when no tick follows it (the market's last minute).
    const timer = window.setInterval(compute, 5000);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
      off();
      unfollow?.();
    };
  }, [key, settings, isIndex]);
}
