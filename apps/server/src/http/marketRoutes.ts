import { getTimeframe, type ApiErrorBody, type InstrumentSearchResponse } from '@otv/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AuthService } from '../auth/authService';
import type { HistoryService } from '../history/historyService';
import type { InstrumentStore } from '../instruments/instrumentStore';
import type { InstrumentSync } from '../instruments/instrumentSync';
import { SEARCH_KINDS, type SearchKind } from '../instruments/search';
import { toKiteError } from '../kite/errors';

export interface MarketDeps {
  auth: AuthService;
  instruments: InstrumentStore;
  sync: InstrumentSync;
  history: HistoryService;
}

const list = (v: unknown) =>
  typeof v === 'string' && v.trim()
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

function fail(reply: FastifyReply, status: number, body: ApiErrorBody) {
  return reply.code(status).send(body);
}

/** Aborts upstream work (queued Kite requests) if the browser gives up on the request. */
function abortOnClose(reply: FastifyReply): AbortSignal {
  const ac = new AbortController();
  // 'close' on the response before it finished writing means the client disconnected.
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) ac.abort(new Error('client went away'));
  });
  return ac.signal;
}

export function registerMarketRoutes(app: FastifyInstance, deps: MarketDeps): void {
  const { auth, instruments, sync, history } = deps;

  /** Maps a Kite failure to an HTTP response; a dead token logs the user out. */
  function upstreamError(reply: FastifyReply, err: unknown) {
    const e = toKiteError(err);
    if (auth.handleKiteError(e))
      return fail(reply, 401, { error: 'logged_out', message: e.message });
    switch (e.kind) {
      case 'permission':
        return fail(reply, 403, {
          error: 'no_market_data',
          message: `Kite denied market data: ${e.message} Historical and live data need the paid Kite Connect plan.`,
        });
      case 'input':
        return fail(reply, 400, { error: 'bad_request', message: e.message });
      case 'not_found':
        return fail(reply, 404, { error: 'not_found', message: e.message });
      default:
        app.log.warn({ kind: e.kind, msg: e.message }, 'Kite request failed');
        return fail(reply, 503, {
          error: 'upstream_unavailable',
          message: `Kite API unavailable: ${e.message}`,
        });
    }
  }

  function requireSession(reply: FastifyReply) {
    const s = auth.session();
    if (!s) fail(reply, 401, { error: 'logged_out' });
    return s;
  }

  app.get('/api/instruments/status', async () => sync.status());

  app.get<{ Querystring: { q?: string; exchange?: string; kind?: string; limit?: string } }>(
    '/api/instruments/search',
    async (req): Promise<InstrumentSearchResponse> => {
      const kinds = list(req.query.kind)?.filter((k): k is SearchKind =>
        SEARCH_KINDS.includes(k as SearchKind),
      );
      const exchanges = list(req.query.exchange);
      const results = instruments.index.search(req.query.q ?? '', {
        ...(exchanges ? { exchanges } : {}),
        ...(kinds ? { kinds } : {}),
        limit: Number(req.query.limit) || 30,
      });
      return { results, sync: sync.status() };
    },
  );

  app.get<{ Querystring: { key?: string } }>('/api/instruments/lookup', async (req, reply) => {
    const inst = req.query.key ? instruments.get(req.query.key) : undefined;
    if (!inst)
      return fail(reply, 404, {
        error: 'not_found',
        message: `Unknown instrument ${req.query.key ?? ''}`,
      });
    return inst;
  });

  app.get<{
    Querystring: { key?: string; tf?: string; before?: string; since?: string; limit?: string };
  }>('/api/history', async (req, reply) => {
    const session = requireSession(reply);
    if (!session) return reply;
    const tf = getTimeframe(req.query.tf ?? '');
    if (!tf)
      return fail(reply, 400, {
        error: 'bad_request',
        message: `Unknown timeframe ${req.query.tf}`,
      });
    const inst = req.query.key ? instruments.get(req.query.key) : undefined;
    if (!inst) {
      const err = instruments.index.size === 0 ? 'instruments_not_synced' : 'not_found';
      return fail(reply, 404, { error: err, message: `Unknown instrument ${req.query.key ?? ''}` });
    }
    const signal = abortOnClose(reply);
    try {
      if (req.query.since !== undefined) {
        const since = Number(req.query.since);
        if (!Number.isFinite(since))
          return fail(reply, 400, { error: 'bad_request', message: 'bad since' });
        return await history.getSince(session.accessToken, inst, tf, since, { signal });
      }
      const before = req.query.before !== undefined ? Number(req.query.before) : undefined;
      if (before !== undefined && !Number.isFinite(before)) {
        return fail(reply, 400, { error: 'bad_request', message: 'bad before' });
      }
      reply.header('cache-control', 'no-store');
      return await history.getBefore(session.accessToken, inst, tf, {
        ...(before !== undefined ? { before } : {}),
        limit: Number(req.query.limit) || 600,
        // Older-history prefetch can wait behind a chart that is opening.
        priority: before !== undefined ? 'low' : 'high',
        signal,
      });
    } catch (err) {
      if (signal.aborted) return reply;
      return upstreamError(reply, err);
    }
  });
}
