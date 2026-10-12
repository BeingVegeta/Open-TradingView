import { formatIstDateTime, type Candle } from '@otv/shared';

export interface BarComparison {
  series: string;
  /** IST `yyyy-mm-dd hh:mm` of the bar. */
  bar: string;
  firstOfDay: boolean;
  /** Price differences live − Kite, in ticks. */
  ticks: { open: number; high: number; low: number; close: number };
  volumeLive: number;
  volumeKite: number;
  /** (live − Kite) / Kite × 100. */
  volumeDiffPct: number;
}

interface SeriesStats {
  compared: number;
  exactPrices: number;
  maxTickDiff: number;
  sumAbsVolPct: number;
  /** Bars whose Kite version changed between the first check (+10 s) and a later one. */
  kiteRevisedLater: number;
  firstBars: { bar: string; volumeLive: number; volumeKite: number }[];
}

/**
 * Measures how live-built candles compare with Kite's own candles for the same
 * period (captured when reconciliation replaces them). Read-only, in memory.
 * Reports differences and times, not prices.
 */
export class LiveDiagnostics {
  readonly since = Date.now();
  private readonly stats = new Map<string, SeriesStats>();
  private readonly recent: BarComparison[] = [];
  /** First Kite version seen per series+bar (then 'done' after the revision check). */
  private readonly firstKite = new Map<string, Candle | 'done'>();

  compare(series: string, live: Candle, kite: Candle, tick: number, firstOfDay: boolean): void {
    const key = `${series}@${kite.time}`;
    const prior = this.firstKite.get(key);
    const st = this.stat(series);
    if (prior === 'done') return;
    if (prior) {
      if (
        prior.close !== kite.close ||
        prior.high !== kite.high ||
        prior.low !== kite.low ||
        prior.volume !== kite.volume
      ) {
        st.kiteRevisedLater++;
      }
      this.firstKite.set(key, 'done');
      return;
    }
    this.firstKite.set(key, kite);
    if (this.firstKite.size > 5000) this.firstKite.delete(this.firstKite.keys().next().value!);
    const t = (a: number, b: number) => Math.round((a - b) / tick);
    const c: BarComparison = {
      series,
      bar: formatIstDateTime(kite.time * 1000).slice(0, 16),
      firstOfDay,
      ticks: {
        open: t(live.open, kite.open),
        high: t(live.high, kite.high),
        low: t(live.low, kite.low),
        close: t(live.close, kite.close),
      },
      volumeLive: live.volume,
      volumeKite: kite.volume,
      volumeDiffPct: kite.volume
        ? Math.round(((live.volume - kite.volume) / kite.volume) * 1000) / 10
        : 0,
    };
    st.compared++;
    const maxT = Math.max(...Object.values(c.ticks).map(Math.abs));
    if (maxT === 0) st.exactPrices++;
    st.maxTickDiff = Math.max(st.maxTickDiff, maxT);
    st.sumAbsVolPct += Math.abs(c.volumeDiffPct);
    if (firstOfDay)
      st.firstBars.push({ bar: c.bar, volumeLive: live.volume, volumeKite: kite.volume });
    this.recent.push(c);
    if (this.recent.length > 40) this.recent.shift();
  }

  report() {
    const series: Record<string, unknown> = {};
    for (const [id, s] of this.stats) {
      series[id] = {
        barsCompared: s.compared,
        barsWithIdenticalOHLC: s.exactPrices,
        maxPriceDiffTicks: s.maxTickDiff,
        meanAbsVolumeDiffPct: s.compared
          ? Math.round((s.sumAbsVolPct / s.compared) * 10) / 10
          : null,
        kiteChangedAfterFirstCheck: s.kiteRevisedLater,
        firstBarOfDay: s.firstBars,
      };
    }
    return { since: new Date(this.since).toISOString(), series, recent: this.recent };
  }

  private stat(series: string): SeriesStats {
    let s = this.stats.get(series);
    if (!s)
      this.stats.set(
        series,
        (s = {
          compared: 0,
          exactPrices: 0,
          maxTickDiff: 0,
          sumAbsVolPct: 0,
          kiteRevisedLater: 0,
          firstBars: [],
        }),
      );
    return s;
  }
}
