import { formatIstDateTime, getTimeframe, type Instrument, type Tick } from '@otv/shared';
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
