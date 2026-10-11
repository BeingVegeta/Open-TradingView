import type { Candle, KiteInterval } from '@otv/shared';
import type { Db } from '../db';
import { addRange, type Range } from './coverage';

interface CandleRow {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  oi: number | null;
}

const toCandle = (r: CandleRow): Candle => {
  const c: Candle = { time: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v };
  if (r.oi !== null) c.oi = r.oi;
  return c;
};

/** SQLite-backed candle cache with per-series coverage. Settled data only. */
export class CandleCache {
  private readonly stmts;

  constructor(private readonly db: Db) {
    this.stmts = {
      coverage: db.prepare(
        'SELECT from_t AS "from", to_t AS "to" FROM candle_coverage WHERE ikey = ? AND interval = ? ORDER BY from_t',
      ),
      delCoverage: db.prepare('DELETE FROM candle_coverage WHERE ikey = ? AND interval = ?'),
      insCoverage: db.prepare(
        'INSERT INTO candle_coverage (ikey, interval, from_t, to_t) VALUES (?, ?, ?, ?)',
      ),
      delCandles: db.prepare(
        'DELETE FROM candles WHERE ikey = ? AND interval = ? AND t >= ? AND t < ?',
      ),
      insCandle: db.prepare(
        'INSERT OR REPLACE INTO candles (ikey, interval, t, o, h, l, c, v, oi) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      newest: db.prepare(
        'SELECT t, o, h, l, c, v, oi FROM candles WHERE ikey = ? AND interval = ? AND t >= ? AND t < ? ORDER BY t DESC LIMIT ?',
      ),
      range: db.prepare(
        'SELECT t, o, h, l, c, v, oi FROM candles WHERE ikey = ? AND interval = ? AND t >= ? AND t < ? ORDER BY t',
      ),
      lastBefore: db.prepare(
        'SELECT t, o, h, l, c, v, oi FROM candles WHERE ikey = ? AND interval = ? AND t < ? ORDER BY t DESC LIMIT 1',
      ),
      oldest: db.prepare('SELECT MIN(t) AS t FROM candles WHERE ikey = ? AND interval = ?'),
      series: db.prepare(
        'SELECT token, data_start AS dataStart FROM candle_series WHERE ikey = ? AND interval = ?',
      ),
      setSeries: db.prepare(
        `INSERT INTO candle_series (ikey, interval, token, data_start) VALUES (?, ?, ?, ?)
         ON CONFLICT (ikey, interval) DO UPDATE SET token = excluded.token, data_start = excluded.data_start`,
      ),
      purgeCandles: db.prepare('DELETE FROM candles WHERE ikey = ?'),
      purgeCoverage: db.prepare('DELETE FROM candle_coverage WHERE ikey = ?'),
      purgeSeries: db.prepare('DELETE FROM candle_series WHERE ikey = ?'),
    };
  }

  coverage(ikey: string, interval: KiteInterval): Range[] {
    return this.stmts.coverage.all(ikey, interval) as Range[];
  }

  /**
   * Stores the complete set of candles Kite returned for [from, to) and marks
   * the range covered. Existing candles in the range are replaced.
   */
  storeRange(ikey: string, interval: KiteInterval, range: Range, candles: readonly Candle[]): void {
    this.db.transaction(() => {
      this.stmts.delCandles.run(ikey, interval, range.from, range.to);
      for (const c of candles) {
        this.stmts.insCandle.run(
          ikey,
          interval,
          c.time,
          c.open,
          c.high,
          c.low,
          c.close,
          c.volume,
          c.oi ?? null,
        );
      }
      const merged = addRange(this.coverage(ikey, interval), range);
      this.stmts.delCoverage.run(ikey, interval);
      for (const r of merged) this.stmts.insCoverage.run(ikey, interval, r.from, r.to);
    })();
  }

  /** Up to `limit` newest candles in [from, to), ascending. */
  newest(ikey: string, interval: KiteInterval, from: number, to: number, limit: number): Candle[] {
    const rows = this.stmts.newest.all(ikey, interval, from, to, limit) as CandleRow[];
    return rows.reverse().map(toCandle);
  }

  range(ikey: string, interval: KiteInterval, from: number, to: number): Candle[] {
    return (this.stmts.range.all(ikey, interval, from, to) as CandleRow[]).map(toCandle);
  }

  lastBefore(ikey: string, interval: KiteInterval, t: number): Candle | undefined {
    const r = this.stmts.lastBefore.get(ikey, interval, t) as CandleRow | undefined;
    return r && toCandle(r);
  }

  oldestTime(ikey: string, interval: KiteInterval): number | null {
    return (this.stmts.oldest.get(ikey, interval) as { t: number | null }).t;
  }

  series(
    ikey: string,
    interval: KiteInterval,
  ): { token: number; dataStart: number | null } | undefined {
    return this.stmts.series.get(ikey, interval) as
      { token: number; dataStart: number | null } | undefined;
  }

  setSeries(ikey: string, interval: KiteInterval, token: number, dataStart: number | null): void {
    this.stmts.setSeries.run(ikey, interval, token, dataStart);
  }

  /** Drops everything cached for an instrument (all intervals). */
  purge(ikey: string): void {
    this.db.transaction(() => {
      this.stmts.purgeCandles.run(ikey);
      this.stmts.purgeCoverage.run(ikey);
      this.stmts.purgeSeries.run(ikey);
    })();
  }
}
