import { dropUnconfirmed, type BarRange, type Candle, type HistoryResponse } from '@otv/shared';
import { api, qs } from '../api';
import { liveClient } from '../live/liveClient';

export interface SeriesState {
  candles: Candle[];
  hasMore: boolean;
  /** Epoch ms of the last tail refresh. */
  refreshedAt: number;
}

/**
 * What changed in a series: `tail` (only bars from index `from` on changed or were
 * appended), `all` (earlier bars changed too), or `reload` (the server says the
 * series must be loaded again from scratch, e.g. after a split adjustment).
 */
export type SeriesChange = { kind: 'tail'; from: number } | { kind: 'all' } | { kind: 'reload' };
type Listener = (change: SeriesChange) => void;

const INITIAL_BARS = 1000;
/** Fewer for long bars: 400 weeks is already eight years of daily candles to fetch. */
const INITIAL_BARS_BY_TF: Record<string, number> = { '1W': 400, '1M': 240 };
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
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly following = new Map<string, { charts: number; stop: () => void }>();

  static id(key: string, tf: string) {
    return `${key}|${tf}`;
  }

  /** Calls `listener` whenever the series changes (whoever changed it). */
  onChange(key: string, tf: string, listener: Listener): () => void {
    const id = HistoryStore.id(key, tf);
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(id);
    };
  }

  private emit(id: string, change: SeriesChange): void {
    for (const l of this.listeners.get(id) ?? []) l(change);
  }

  /**
   * Keeps a loaded series up to date with the server's live bars, once however
   * many charts show it. Returns a stop function.
   */
  follow(key: string, tf: string): () => void {
    const id = HistoryStore.id(key, tf);
    let f = this.following.get(id);
    if (!f) {
      const stop = liveClient.subscribe(
        key,
        tf,
        (bars, _replace, range) => this.applyBars(key, tf, bars, range),
        () => {
          // Reconnected after a gap: fetch whatever we missed.
          this.refreshTail(key, tf).catch(() => {});
        },
      );
      f = { charts: 0, stop };
      this.following.set(id, f);
    }
    f.charts++;
    const entry = f;
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (--entry.charts > 0) return;
      entry.stop();
      if (this.following.get(id) === entry) this.following.delete(id);
    };
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
        .get<HistoryResponse>(
          `/api/history?${qs({ key, tf, limit: INITIAL_BARS_BY_TF[tf] ?? INITIAL_BARS })}`,
        )
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
            if (r.reset) {
              this.series.delete(id);
              this.emit(id, { kind: 'reload' });
            }
            return 0;
          }
          const older = r.candles.filter((c) => c.time < cur.candles[0]!.time);
          cur.candles = [...older, ...cur.candles];
          const hadMore = cur.hasMore;
          cur.hasMore = r.hasMore;
          if (older.length || hadMore !== r.hasMore) this.emit(id, { kind: 'all' });
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
      this.emit(id, { kind: 'reload' });
      return null;
    }
    const keep = cur.candles.filter((c) => c.time < since);
    cur.candles = [...keep, ...r.candles];
    cur.refreshedAt = Date.now();
    this.emit(id, { kind: 'all' });
    return cur;
  }

  /**
   * Merges bars pushed by the server. Live updates touch the newest bars;
   * replacements (reconciled with Kite) may fix older ones or fill a gap.
   * Returns 'tail' if only the last bar changed or bars were appended, 'all'
   * if earlier bars changed, or null if nothing changed.
   */
  applyBars(key: string, tf: string, bars: Candle[], range?: BarRange): 'tail' | 'all' | null {
    const id = HistoryStore.id(key, tf);
    const s = this.series.get(id);
    if (!s) return null;
    const lastBefore = s.candles.at(-1)?.time ?? -Infinity;
    const result = this.merge(s, bars, range);
    if (result === 'all') this.emit(id, { kind: 'all' });
    else if (result === 'tail') {
      let from = s.candles.length;
      while (from > 0 && s.candles[from - 1]!.time >= lastBefore) from--;
      this.emit(id, { kind: 'tail', from });
    }
    return result;
  }

  private merge(s: SeriesState, bars: Candle[], range?: BarRange): 'tail' | 'all' | null {
    let result: 'tail' | 'all' | null = null;
    if (range) {
      // Authoritative range: drop bars Kite doesn't have (e.g. live bars outside the session).
      const before = s.candles.length;
      s.candles = dropUnconfirmed(s.candles, bars, range);
      if (s.candles.length !== before) result = 'all';
    }
    if (!bars.length) return result;
    const c = s.candles;
    for (const b of [...bars].sort((x, y) => x.time - y.time)) {
      const last = c.at(-1);
      if (!last || b.time > last.time) {
        c.push(b);
        result ??= 'tail';
      } else if (b.time === last.time) {
        if (!sameBar(last, b)) {
          c[c.length - 1] = b;
          result ??= 'tail';
        }
      } else if (b.time >= c[0]!.time) {
        // Binary search for an older bar (reconciliation, or a gap being filled).
        let lo = 0;
        let hi = c.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (c[mid]!.time < b.time) lo = mid + 1;
          else hi = mid;
        }
        if (c[lo]!.time === b.time) {
          if (sameBar(c[lo]!, b)) continue;
          c[lo] = b;
        } else c.splice(lo, 0, b);
        result = 'all';
      }
    }
    return result;
  }

  private put(id: string, s: SeriesState): SeriesState {
    this.series.set(id, s);
    while (this.series.size > MAX_SERIES) this.series.delete(this.series.keys().next().value!);
    return s;
  }
}

export const historyStore = new HistoryStore();

if (import.meta.env.DEV) {
  // Inspection hook for development and browser tests.
  (window as unknown as { __otvHistory: HistoryStore }).__otvHistory = historyStore;
}

function sameBar(a: Candle, b: Candle): boolean {
  return (
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume &&
    a.oi === b.oi
  );
}
