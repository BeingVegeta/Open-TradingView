import type { Candle, HistoryResponse } from '@otv/shared';
import { api, qs } from '../api';

export interface SeriesState {
  candles: Candle[];
  hasMore: boolean;
  /** Epoch ms of the last tail refresh. */
  refreshedAt: number;
}

const INITIAL_BARS = 1000;
const MAX_SERIES = 24;

/**
 * Candles the browser already holds, per instrument and timeframe. Switching
 * back to a timeframe or symbol renders straight from here (no request), and
 * the live edge is refreshed in the background.
 */
class HistoryStore {
  private readonly series = new Map<string, SeriesState>();
  private readonly inflight = new Map<string, Promise<SeriesState>>();
  private readonly olderInflight = new Map<string, Promise<number>>();

  static id(key: string, tf: string) {
    return `${key}|${tf}`;
  }

  get(key: string, tf: string): SeriesState | undefined {
    const id = HistoryStore.id(key, tf);
    const s = this.series.get(id);
    if (s) {
      // LRU touch.
      this.series.delete(id);
      this.series.set(id, s);
    }
    return s;
  }

  /**
   * First load of a series (or the cached copy). Not abortable: the request is
   * shared by every caller that wants this series, so one caller giving up
   * must not fail it for the others. Callers ignore results they no longer need.
   */
  load(key: string, tf: string): Promise<SeriesState> {
    const cached = this.get(key, tf);
    if (cached) return Promise.resolve(cached);
    const id = HistoryStore.id(key, tf);
    let p = this.inflight.get(id);
    if (!p) {
      p = api
        .get<HistoryResponse>(`/api/history?${qs({ key, tf, limit: INITIAL_BARS })}`)
        .then((r) =>
          this.put(id, { candles: r.candles, hasMore: r.hasMore, refreshedAt: Date.now() }),
        )
        .finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return p;
  }

  /** Prepends older candles. Resolves to the number of candles added. */
  loadOlder(key: string, tf: string, bars: number): Promise<number> {
    const id = HistoryStore.id(key, tf);
    const s = this.series.get(id);
    if (!s || !s.hasMore || !s.candles.length) return Promise.resolve(0);
    let p = this.olderInflight.get(id);
    if (!p) {
      const before = s.candles[0]!.time;
      p = api
        .get<HistoryResponse>(`/api/history?${qs({ key, tf, before, limit: bars })}`)
        .then((r) => {
          const cur = this.series.get(id);
          if (!cur || r.reset) {
            if (r.reset) this.series.delete(id);
            return 0;
          }
          const older = r.candles.filter((c) => c.time < cur.candles[0]!.time);
          cur.candles = [...older, ...cur.candles];
          cur.hasMore = r.hasMore;
          return older.length;
        })
        .finally(() => this.olderInflight.delete(id));
      this.olderInflight.set(id, p);
    }
    return p;
  }

  isLoadingOlder(key: string, tf: string): boolean {
    return this.olderInflight.has(HistoryStore.id(key, tf));
  }

  /**
   * Refreshes the newest candles (today's may have changed). Returns the
   * updated state, or null if the server says the series must be reloaded.
   */
  async refreshTail(key: string, tf: string): Promise<SeriesState | null> {
    const id = HistoryStore.id(key, tf);
    const s = this.series.get(id);
    if (!s || !s.candles.length) return s ?? null;
    const since = s.candles.at(-1)!.time;
    const r = await api.get<HistoryResponse>(`/api/history?${qs({ key, tf, since })}`);
    const cur = this.series.get(id);
    if (!cur) return null;
    if (r.reset) {
      this.series.delete(id);
      return null;
    }
    const keep = cur.candles.filter((c) => c.time < since);
    cur.candles = [...keep, ...r.candles];
    cur.refreshedAt = Date.now();
    return cur;
  }

  private put(id: string, s: SeriesState): SeriesState {
    this.series.set(id, s);
    while (this.series.size > MAX_SERIES) this.series.delete(this.series.keys().next().value!);
    return s;
  }
}

export const historyStore = new HistoryStore();
