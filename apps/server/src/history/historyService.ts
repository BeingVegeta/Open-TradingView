import {
  DAY_MS,
  INTERVAL_BAR,
  instrumentKind,
  istStartOfDay,
  istToEpoch,
  sessionMinutes,
  type Candle,
  type HistoryResponse,
  type Instrument,
  type KiteInterval,
  type Timeframe,
} from '@otv/shared';
import type { FastifyBaseLogger } from 'fastify';
import { toKiteError } from '../kite/errors';
import type { KiteGateway, RequestOpts } from '../kite/gateway';
import type { CandleCache } from './candleCache';
import { coveredEndBefore, rangeEndingAt, type Range } from './coverage';
import type { RangeCaps } from './rangeCaps';

const DAY_S = DAY_MS / 1000;
/** No Indian exchange data before this. */
export const HISTORY_FLOOR = istToEpoch(1995, 1, 1) / 1000;
/** Upper bound on upstream requests for one API call, to keep latency bounded. */
const MAX_FETCHES_PER_CALL = 6;
/** A cached split-adjusted series is considered stale when its last candle moves more than this. */
const ADJUSTMENT_TOLERANCE = 0.01;

/**
 * How long a stretch with no candles at all must be before we conclude the
 * instrument's data starts after it (pre-listing, pre-contract, or beyond
 * Kite's archive). No Indian exchange has closed for anywhere near this long.
 */
export function emptyStopDays(interval: KiteInterval, caps: RangeCaps): number {
  return interval === 'day' ? 365 : Math.min(caps[interval], 45);
}

/** Calendar days likely to hold `bars` candles, with slack for weekends and holidays. */
export function estimateSpanDays(exchange: string, interval: KiteInterval, bars: number): number {
  const bar = INTERVAL_BAR[interval];
  const perDay = bar === 'day' ? 1 : Math.max(1, Math.floor(sessionMinutes(exchange) / bar));
  const tradingDays = bars / perDay;
  return Math.ceil(tradingDays * (7 / 5) * 1.15) + 3;
}

/**
 * Start of a chunk reaching back `spanDays` from `to`, aligned down to 00:00 IST
 * (no candle straddles midnight, so a chunk can never cut a candle in half)
 * and kept within the cap.
 */
export function chunkStart(to: number, spanDays: number, capDays: number): number {
  let from = istStartOfDay((to - spanDays * DAY_S) * 1000) / 1000;
  while (to - from > capDays * DAY_S) from += DAY_S;
  return from;
}

interface Tail {
  from: number;
  fetchedAt: number;
  candles: Candle[];
}

export interface HistoryServiceDeps {
  cache: CandleCache;
  gateway: KiteGateway;
  caps: RangeCaps;
  log: FastifyBaseLogger;
  now?: () => number;
  /** How long today's (unsettled) candles may be served from memory. */
  tailTtlMs?: number;
}

export interface GetBeforeOpts extends RequestOpts {
  /** Epoch seconds (exclusive). Omit for the live edge. */
  before?: number;
  limit: number;
}

/**
 * Serves candle history from the cache, fetching what is missing from Kite in
 * chunks that respect the per-interval range caps.
 *
 * Data before 00:00 IST today is "settled" and cached in SQLite with explicit
 * coverage, so empty stretches (holidays, pre-listing) are remembered too.
 * Today's candles are "tail": kept in memory for a short TTL and refetched,
 * because the last one is still forming and Kite may revise the day's data.
 */
export class HistoryService {
  private readonly tails = new Map<string, Tail>();
  private readonly inflightTails = new Map<string, Promise<Tail>>();
  private readonly now: () => number;
  private readonly tailTtlMs: number;
  /** Caps learnt from InputExceptions, if Kite has tightened them. */
  private readonly caps: RangeCaps;

  constructor(private readonly deps: HistoryServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.tailTtlMs = deps.tailTtlMs ?? 30_000;
    this.caps = { ...deps.caps };
  }

  /** Up to `limit` candles ending before `before` (or the live edge), oldest first. */
  async getBefore(
    accessToken: string,
    inst: Instrument,
    tf: Timeframe,
    opts: GetBeforeOpts,
  ): Promise<HistoryResponse> {
    const interval = tf.interval;
    let reset = this.checkToken(inst, interval);
    const nowS = Math.floor(this.now() / 1000);
    const settled = istStartOfDay(this.now()) / 1000;
    const limit = Math.max(1, Math.min(opts.limit, 5000));
    let cursor = Math.min(opts.before ?? nowS + 1, nowS + 1);
    const out: Candle[][] = [];
    let count = 0;

    // 0. Cold start: one request for recent settled history and today together,
    //    instead of two (requests are the scarce resource at 3/s).
    if (cursor > settled && !this.tailFresh(inst.key, interval, settled)) {
      const cov = this.deps.cache.coverage(inst.key, interval);
      if (!rangeEndingAt(cov, settled)) {
        const span = Math.min(
          this.caps[interval],
          estimateSpanDays(inst.exchange, interval, limit),
        );
        const from = Math.max(
          chunkStart(nowS + 1, span, this.caps[interval]),
          coveredEndBefore(cov, settled),
          HISTORY_FLOOR,
        );
        if (from < settled) {
          const fetched = await this.fetchChunk(
            accessToken,
            inst,
            interval,
            { from, to: nowS + 1 },
            opts,
          );
          this.deps.cache.storeRange(
            inst.key,
            interval,
            { from, to: settled },
            fetched.filter((c) => c.time < settled),
          );
          this.tails.set(`${inst.key}|${interval}`, {
            from: settled,
            fetchedAt: this.now(),
            candles: fetched.filter((c) => c.time >= settled),
          });
        }
      }
    }

    // 1. Today's tail.
    if (cursor > settled) {
      const tail = await this.getTail(accessToken, inst, interval, settled, opts);
      if (tail.reset) reset = true;
      const rows = tail.candles.filter((c) => c.time < cursor);
      const take = rows.slice(Math.max(0, rows.length - limit));
      out.unshift(take);
      count += take.length;
      cursor = take.length === rows.length ? settled : take[0]!.time;
    }

    // 2. Settled history: cache first, Kite for the gaps.
    const meta = this.deps.cache.series(inst.key, interval);
    let dataStart = meta?.dataStart ?? null;
    let fetches = 0;
    let emptyRun = 0;
    let spanDays = 0;
    while (count < limit && cursor > HISTORY_FLOOR && (dataStart === null || cursor > dataStart)) {
      const cov = this.deps.cache.coverage(inst.key, interval);
      const seg = rangeEndingAt(cov, cursor);
      let segFrom: number;
      let got: number;
      if (seg) {
        const rows = this.deps.cache.newest(inst.key, interval, seg.from, cursor, limit - count);
        out.unshift(rows);
        count += rows.length;
        got = rows.length;
        segFrom = seg.from;
        if (count >= limit && rows.length) {
          cursor = rows[0]!.time;
          break;
        }
      } else {
        if (fetches >= MAX_FETCHES_PER_CALL) break;
        const cap = this.caps[interval];
        spanDays =
          emptyRun > 0
            ? Math.min(cap, Math.max(spanDays * 2, 1))
            : Math.min(cap, estimateSpanDays(inst.exchange, interval, limit - count));
        // Fill only up to the end of the previous covered range (don't refetch it).
        segFrom = Math.max(
          chunkStart(cursor, spanDays, cap),
          coveredEndBefore(cov, cursor),
          HISTORY_FLOOR,
        );
        const range: Range = { from: segFrom, to: cursor };
        const candles = await this.fetchChunk(accessToken, inst, interval, range, opts);
        fetches++;
        this.deps.cache.storeRange(inst.key, interval, range, candles);
        // Read it back through the cache path on the next iteration.
        if (candles.length) {
          emptyRun = 0;
          continue;
        }
        got = 0;
      }
      if (got > 0) {
        emptyRun = 0;
      } else {
        emptyRun += cursor - segFrom;
        if (emptyRun >= emptyStopDays(interval, this.caps) * DAY_S || segFrom <= HISTORY_FLOOR) {
          // Nothing for a long stretch: the series starts after it.
          dataStart = this.deps.cache.oldestTime(inst.key, interval) ?? cursor;
          this.deps.cache.setSeries(inst.key, interval, inst.token, dataStart);
          this.deps.log.info({ key: inst.key, interval, dataStart }, 'Reached start of history');
          cursor = Math.min(cursor, dataStart);
          break;
        }
      }
      cursor = segFrom;
    }
    if (!meta) this.deps.cache.setSeries(inst.key, interval, inst.token, dataStart);

    const candles = out.flat();
    const hasMore = cursor > HISTORY_FLOOR && (dataStart === null || cursor > dataStart);
    const res: HistoryResponse = { key: inst.key, tf: tf.id, candles, hasMore };
    if (reset) res.reset = true;
    return res;
  }

  /**
   * Candles with time >= `since` up to now, for refreshing the live edge of
   * a chart the client already holds. `since` must be within today or the
   * cached range; otherwise the client should reload with getBefore.
   */
  async getSince(
    accessToken: string,
    inst: Instrument,
    tf: Timeframe,
    since: number,
    opts: RequestOpts = {},
  ): Promise<HistoryResponse> {
    const interval = tf.interval;
    let reset = this.checkToken(inst, interval);
    const settled = istStartOfDay(this.now()) / 1000;
    const tail = await this.getTail(accessToken, inst, interval, settled, opts);
    if (tail.reset) reset = true;
    let candles = tail.candles.filter((c) => c.time >= since);
    if (since < settled) {
      const cov = this.deps.cache.coverage(inst.key, interval);
      const seg = rangeEndingAt(cov, settled);
      if (!seg || seg.from > since) reset = true;
      else candles = [...this.deps.cache.range(inst.key, interval, since, settled), ...candles];
    }
    const res: HistoryResponse = { key: inst.key, tf: tf.id, candles, hasMore: true };
    if (reset) res.reset = true;
    return res;
  }

  /** Drops cached series fetched under a different token (Kite reuses tokens after expiry). */
  private checkToken(inst: Instrument, interval: KiteInterval): boolean {
    const meta = this.deps.cache.series(inst.key, interval);
    if (meta && meta.token !== inst.token) {
      this.deps.log.info({ key: inst.key }, 'Instrument token changed; dropping cached candles');
      this.purge(inst.key);
      return true;
    }
    return false;
  }

  private purge(ikey: string): void {
    this.deps.cache.purge(ikey);
    for (const k of this.tails.keys()) if (k.startsWith(ikey + '|')) this.tails.delete(k);
  }

  private tailFresh(ikey: string, interval: KiteInterval, settled: number): boolean {
    const t = this.tails.get(`${ikey}|${interval}`);
    return !!t && t.from === settled && this.now() - t.fetchedAt < this.tailTtlMs;
  }

  private async getTail(
    accessToken: string,
    inst: Instrument,
    interval: KiteInterval,
    settled: number,
    opts: RequestOpts,
  ): Promise<Tail & { reset?: boolean }> {
    const k = `${inst.key}|${interval}`;
    if (this.tailFresh(inst.key, interval, settled)) return this.tails.get(k)!;
    let p = this.inflightTails.get(k);
    if (!p) {
      p = this.fetchTail(accessToken, inst, interval, settled, opts).finally(() =>
        this.inflightTails.delete(k),
      );
      this.inflightTails.set(k, p);
    }
    return p;
  }

  private async fetchTail(
    accessToken: string,
    inst: Instrument,
    interval: KiteInterval,
    settled: number,
    opts: RequestOpts,
  ): Promise<Tail & { reset?: boolean }> {
    const nowS = Math.floor(this.now() / 1000);
    // Include the newest settled candle we hold, to detect retroactive
    // adjustments (splits, bonuses) that make the cache stale.
    const cov = this.deps.cache.coverage(inst.key, interval);
    const lastSettled = rangeEndingAt(cov, settled)
      ? this.deps.cache.lastBefore(inst.key, interval, settled)
      : undefined;
    const from =
      lastSettled && nowS + 1 - lastSettled.time <= this.caps[interval] * DAY_S
        ? lastSettled.time
        : settled;
    const fetched = await this.fetchChunk(
      accessToken,
      inst,
      interval,
      { from, to: nowS + 1 },
      opts,
    );
    let reset = false;
    if (lastSettled) {
      const fresh = fetched.find((c) => c.time === lastSettled.time);
      if (
        fresh &&
        Math.abs(fresh.close - lastSettled.close) > ADJUSTMENT_TOLERANCE * lastSettled.close
      ) {
        this.deps.log.warn(
          { key: inst.key, interval, cached: lastSettled.close, now: fresh.close },
          'Cached history no longer matches Kite (corporate action?); dropping cache',
        );
        this.purge(inst.key);
        reset = true;
      }
    }
    const tail: Tail = {
      from: settled,
      fetchedAt: this.now(),
      candles: fetched.filter((c) => c.time >= settled),
    };
    this.tails.set(`${inst.key}|${interval}`, tail);
    return reset ? { ...tail, reset } : tail;
  }

  /**
   * Fetches [from, to) from Kite, split into pieces no longer than the
   * interval's cap. If Kite rejects a range as too long (its caps aren't
   * documented and may change), the cap is halved and the piece retried.
   */
  private async fetchChunk(
    accessToken: string,
    inst: Instrument,
    interval: KiteInterval,
    range: Range,
    opts: RequestOpts,
  ): Promise<Candle[]> {
    const capS = this.caps[interval] * DAY_S;
    if (range.to - range.from > capS) {
      const mid = chunkStart(range.to, this.caps[interval], this.caps[interval]);
      const older = await this.fetchChunk(
        accessToken,
        inst,
        interval,
        { from: range.from, to: mid },
        opts,
      );
      const newer = await this.fetchChunk(
        accessToken,
        inst,
        interval,
        { from: mid, to: range.to },
        opts,
      );
      return [...older, ...newer];
    }
    const oi = ['future', 'option'].includes(instrumentKind(inst));
    try {
      return await this.deps.gateway.fetchHistory(
        accessToken,
        { instrument: inst, interval, ...range, ...(oi ? { oi } : {}) },
        opts,
      );
    } catch (err) {
      const e = toKiteError(err);
      const days = (range.to - range.from) / DAY_S;
      const capHit = e.kind === 'input' && /exceed|max(imum)? limit/i.test(e.message);
      if (!capHit || days <= 1) throw e;
      this.caps[interval] = Math.max(1, Math.min(this.caps[interval], Math.floor(days / 2)));
      this.deps.log.warn(
        { interval, msg: e.message, newCapDays: this.caps[interval] },
        'Kite rejected the history range; reducing the cap (set KITE_HISTORY_MAX_DAYS to make it permanent)',
      );
      return this.fetchChunk(accessToken, inst, interval, range, opts);
    }
  }
}
