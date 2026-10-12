import {
  DAY_MS,
  formatIstDateTime,
  getTimeframe,
  istStartOfDay,
  type Candle,
  type Instrument,
  type Tick,
  type TimeframeId,
} from '@otv/shared';
import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/authService';
import type { HistoryService } from '../history/historyService';
import type { InstrumentStore } from '../instruments/instrumentStore';
import { toKiteError } from '../kite/errors';
import type { LiveCandles } from '../live/liveCandles';
import type { TickerManager } from '../ticker/tickerManager';

/** Nearest-expiry future of an underlying on an exchange. */
function nearestFuture(
  store: InstrumentStore,
  query: string,
  exchange: string,
): Instrument | undefined {
  return store.index
    .search(query, { kinds: ['future'], exchanges: [exchange], limit: 10 })
    .sort((a, b) => (a.expiry ?? '').localeCompare(b.expiry ?? ''))[0];
}

/**
 * Read-only diagnostics for checking the app against real Kite data. Output is
 * differences, times and volumes, not price series.
 */
export function registerDiagnosticRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthService;
    instruments: InstrumentStore;
    history: HistoryService;
    ticker: TickerManager;
    live: LiveCandles;
  },
): void {
  const { auth, instruments, history, ticker, live } = deps;

  app.get('/api/dev/diagnostics', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return {
      what: 'Live-built candles compared with Kite historical candles for the same period (live − Kite). Prices in ticks.',
      ...live.diagnostics.report(),
    };
  });

  /**
   * Which 1-minute candles make up each of Kite's 15/30/60-minute candles on the
   * last complete trading day, and whether the daily volume equals the sum of
   * the 1-minute volumes. Uses history only, so it works any time.
   */
  app.get('/api/dev/aggregation', async (_req, reply) => {
    const session = auth.session();
    if (!session) return reply.code(401).send({ error: 'logged_out' });
    const picks = [
      instruments.get('NSE:RELIANCE'),
      instruments.get('NSE:HDFCBANK'),
      instruments.get('NSE:NIFTY 50'),
      nearestFuture(instruments, 'NIFTY', 'NFO'),
      nearestFuture(instruments, 'CRUDEOIL', 'MCX'),
    ];
    const hhmm = (t: number) => formatIstDateTime(t * 1000).slice(11, 16);
    const out: Record<string, unknown> = {};
    for (const inst of picks) {
      if (!inst) continue;
      try {
        const get = (tf: TimeframeId, before: number, limit: number) =>
          history
            .getBefore(session.accessToken, inst, getTimeframe(tf)!, { before, limit })
            .then((r) => r.candles);
        // Last complete trading day: the newest daily candle before today.
        const today = istStartOfDay(Date.now()) / 1000;
        const days = await get('1D', today, 3);
        const day = days.at(-1);
        if (!day) continue;
        const dayEnd = day.time + DAY_MS / 1000;
        const ones = (await get('1m', dayEnd, 1000)).filter((c) => c.time >= day.time);
        const sum = (from: number, to: number) => ones.filter((c) => c.time >= from && c.time < to);
        const report: Record<string, unknown> = {
          day: formatIstDateTime(day.time * 1000).slice(0, 10),
          oneMinuteCandles: ones.length,
          first1m: ones[0] ? hhmm(ones[0].time) : null,
          last1m: ones.at(-1) ? hhmm(ones.at(-1)!.time) : null,
          dayCandleVolume: day.volume,
          sumOf1mVolumes: ones.reduce((a, c) => a + c.volume, 0),
        };
        for (const [tf, len] of [
          ['1h', 60],
          ['30m', 30],
          ['15m', 15],
        ] as const) {
          const bars = (await get(tf, dayEnd, 60)).filter((c) => c.time >= day.time);
          const rows = bars.map((k: Candle, i) => {
            const next = bars[i + 1]?.time ?? dayEnd;
            const natural = sum(k.time, k.time + len * 60);
            const untilNext = sum(k.time, next);
            const vol = (cs: Candle[]) => cs.reduce((a, c) => a + c.volume, 0);
            const hi = (cs: Candle[]) => Math.max(...cs.map((c) => c.high));
            return {
              t: hhmm(k.time),
              kiteVolume: k.volume,
              sum1mOwnPeriod: vol(natural),
              sum1mUntilNextCandle: vol(untilNext),
              lastMinuteIncluded: untilNext.at(-1) ? hhmm(untilNext.at(-1)!.time) : null,
              highMatches:
                k.high === hi(untilNext)
                  ? 'untilNext'
                  : k.high === hi(natural)
                    ? 'ownPeriod'
                    : 'neither',
            };
          });
          report[tf] = {
            times: bars.map((b) => hhmm(b.time)),
            allMatchOwnPeriod: rows.every((r) => r.kiteVolume === r.sum1mOwnPeriod),
            allMatchUntilNext: rows.every((r) => r.kiteVolume === r.sum1mUntilNextCandle),
            // The last two candles of the day are where sessions differ.
            lastCandles: rows.slice(-2),
            mismatches: rows.filter((r) => r.kiteVolume !== r.sum1mOwnPeriod).slice(0, 4),
          };
        }
        out[inst.key] = report;
      } catch (err) {
        out[inst.key] = { error: toKiteError(err).message };
      }
    }
    reply.header('cache-control', 'no-store');
    return {
      what: "Kite's 1h/30m/15m candles on the last complete day vs the 1-minute candles of the same day; daily volume vs the sum of 1-minute volumes.",
      ...out,
    };
  });

  app.get('/api/dev/anchoring', async (_req, reply) => {
    const session = auth.session();
    if (!session) return reply.code(401).send({ error: 'logged_out' });
    const tf1h = getTimeframe('1h')!;
    const tf1m = getTimeframe('1m')!;
    const picks: (Instrument | undefined)[] = [
      instruments.get('NSE:NIFTY 50'),
      instruments.get('NSE:RELIANCE'),
      instruments.get('BSE:SENSEX'),
      nearestFuture(instruments, 'NIFTY', 'NFO'),
      nearestFuture(instruments, 'CRUDEOIL', 'MCX') ?? nearestFuture(instruments, 'GOLD', 'MCX'),
      nearestFuture(instruments, 'USDINR', 'CDS'),
    ];
    const anchoring: Record<string, unknown> = {};
    for (const inst of picks) {
      if (!inst) continue;
      try {
        const res = await history.getBefore(session.accessToken, inst, tf1h, { limit: 40 });
        const days: Record<string, string[]> = {};
        for (const c of res.candles) {
          const t = formatIstDateTime(c.time * 1000);
          (days[t.slice(0, 10)] ??= []).push(t.slice(11, 16));
        }
        anchoring[inst.key] = days;
      } catch (err) {
        anchoring[inst.key] = { error: toKiteError(err).message };
      }
    }

    // Pre-open volume: does today's first 1-minute candle include the pre-open
    // auction? Compare the day's cumulative volume (from a tick) with the sum of
    // today's 1-minute candle volumes; a gap the size of the pre-open volume means
    // it's not in the candles.
    const preOpen: Record<string, unknown> = {};
    for (const key of ['NSE:RELIANCE', 'NSE:HDFCBANK', 'NSE:SBIN']) {
      const inst = instruments.get(key);
      if (!inst) continue;
      const consumer = `diag:${key}`;
      ticker.acquire(consumer, inst.token, 'quote');
      try {
        const tick = await new Promise<Tick | undefined>((resolve) => {
          const have = ticker.lastTick(inst.token);
          if (have?.volume !== undefined) return resolve(have);
          const onTicks = (ts: Tick[]) => {
            const t = ts.find((x) => x.token === inst.token && x.volume !== undefined);
            if (t) {
              ticker.off('ticks', onTicks);
              resolve(t);
            }
          };
          ticker.on('ticks', onTicks);
          setTimeout(() => {
            ticker.off('ticks', onTicks);
            resolve(undefined);
          }, 6000);
        });
        const todayStart = Math.floor(
          new Date(formatIstDateTime(Date.now()).slice(0, 10) + 'T00:00:00+05:30').getTime() / 1000,
        );
        const res = await history.getSince(session.accessToken, inst, tf1m, todayStart, {
          fresh: true,
        });
        const sum = res.candles.reduce((a, c) => a + c.volume, 0);
        const first = res.candles[0];
        preOpen[key] = {
          tickDayVolume: tick?.volume ?? null,
          sumOfTodays1mCandleVolumes: sum,
          difference: tick?.volume !== undefined ? tick.volume - sum : null,
          firstCandle: first
            ? {
                time: formatIstDateTime(first.time * 1000).slice(11, 16),
                volume: first.volume,
                secondCandleVolume: res.candles[1]?.volume ?? null,
              }
            : null,
        };
      } catch (err) {
        preOpen[key] = { error: toKiteError(err).message };
      } finally {
        ticker.release(consumer);
      }
    }
    reply.header('cache-control', 'no-store');
    return {
      what: "anchoring: start times (IST) of 1-hour candles per day. preOpen: day volume from a live tick vs the sum of today's 1-minute candles (a large positive difference ≈ pre-open volume missing from the candles).",
      anchoring,
      preOpen,
    };
  });
}
