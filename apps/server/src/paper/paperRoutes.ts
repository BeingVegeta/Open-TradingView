import { paperMetrics, type PaperConfig, type PaperTrade } from '@otv/shared';
import type { FastifyInstance } from 'fastify';
import type { PaperStore } from './paperStore';
import type { PaperTrader } from './paperTrader';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function range(q: { from?: string; to?: string }): [string, string] {
  return [
    q.from && DAY.test(q.from) ? q.from : '0000-00-00',
    q.to && DAY.test(q.to) ? q.to : '9999-99-99',
  ];
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per trade, for a spreadsheet. */
export function tradesCsv(ts: PaperTrade[]): string {
  const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : '');
  const cols: [string, (t: PaperTrade) => unknown][] = [
    ['id', (t) => t.id],
    ['day', (t) => t.day],
    ['entry_at_utc', (t) => iso(t.entryAt)],
    ['direction', (t) => (t.dir === 1 ? 'CE' : 'PE')],
    ['source', (t) => t.source],
    ['option', (t) => t.optionKey ?? `NIFTY ${t.optionName}`],
    ['expiry', (t) => t.expiry],
    ['lot_size', (t) => t.lotSize],
    ['entry_index', (t) => t.entryIndex],
    ['sl_index', (t) => t.slIndex],
    ['entry_opt', (t) => t.entryOpt],
    ['entry_opt_ltp', (t) => t.entryOptLtp],
    ['lot1_exit_at_utc', (t) => iso(t.lot1?.at)],
    ['lot1_reason', (t) => t.lot1?.reason],
    ['lot1_pts', (t) => t.lot1?.pts],
    ['lot1_exit_opt', (t) => t.lot1?.opt],
    ['lot2_exit_at_utc', (t) => iso(t.lot2?.at)],
    ['lot2_reason', (t) => t.lot2?.reason],
    ['lot2_pts', (t) => t.lot2?.pts],
    ['lot2_exit_opt', (t) => t.lot2?.opt],
    ['peak_pts', (t) => t.peakPts],
    ['mae_pts', (t) => t.maePts],
    ['result', (t) => t.result],
    ['script_pts', (t) => t.scriptPts],
    ['script_rs', (t) => t.scriptRs],
    ['gross_rs', (t) => t.grossRs],
    ['costs_rs', (t) => t.costsRs],
    ['net_rs', (t) => t.netRs],
    ['status', (t) => t.status],
    ['settings', (t) => t.settingsHash],
    ['notes', (t) => t.notes.join('; ')],
  ];
  return (
    [
      cols.map((c) => c[0]).join(','),
      ...ts.map((t) => cols.map((c) => csvCell(c[1](t))).join(',')),
    ].join('\n') + '\n'
  );
}

export function registerPaperRoutes(
  app: FastifyInstance,
  deps: { store: PaperStore; trader: PaperTrader },
): void {
  const { store, trader } = deps;

  app.get('/api/paper/status', async () => ({ ...trader.status(), config: store.config() }));

  app.put<{ Body: Partial<PaperConfig> }>('/api/paper/config', async (req, reply) => {
    const b = req.body ?? {};
    const patch: Partial<PaperConfig> = {};
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    if (b.expiry === 'nearest' || b.expiry === 'skip-expiry-day') patch.expiry = b.expiry;
    if (b.costs && typeof b.costs === 'object')
      patch.costs = { ...store.config().costs, ...b.costs };
    if (!Object.keys(patch).length) return reply.code(400).send({ error: 'bad_request' });
    const config = store.setConfig(patch);
    trader.reconsider();
    return { ...trader.status(), config };
  });

  app.get<{ Querystring: { from?: string; to?: string } }>('/api/paper/trades', async (req) =>
    store.trades(...range(req.query)),
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/api/paper/trades.csv',
    async (req, reply) => {
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="paper-trades.csv"');
      return tradesCsv(store.trades(...range(req.query)));
    },
  );

  app.get<{ Querystring: { from?: string; to?: string } }>('/api/paper/metrics', async (req) =>
    paperMetrics(store.trades(...range(req.query))),
  );

  app.get<{ Querystring: { day?: string } }>('/api/paper/events', async (req, reply) => {
    const day = req.query.day;
    if (!day || !DAY.test(day))
      return reply.code(400).send({ error: 'bad_request', message: 'use ?day=yyyy-mm-dd' });
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    const start = Date.UTC(y, m - 1, d) - 330 * 60_000;
    return store.events(start, start + 86_400_000);
  });
}
