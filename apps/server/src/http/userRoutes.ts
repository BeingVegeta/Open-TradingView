import type { FastifyInstance } from 'fastify';
import type { PrefsStore } from '../user/prefsStore';
import type { WatchlistStore } from '../user/watchlistStore';

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

export function registerUserRoutes(
  app: FastifyInstance,
  deps: { watchlists: WatchlistStore; prefs: PrefsStore },
): void {
  const { watchlists, prefs } = deps;

  app.get('/api/watchlists', async () => watchlists.all());

  app.post<{ Body: { name?: unknown; items?: unknown } }>('/api/watchlists', async (req, reply) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : 'Watchlist';
    const items = isStringArray(req.body?.items) ? req.body.items : [];
    try {
      return watchlists.create(name, items);
    } catch (e) {
      return reply.code(400).send({ error: 'bad_request', message: (e as Error).message });
    }
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown; items?: unknown } }>(
    '/api/watchlists/:id',
    async (req, reply) => {
      const patch: { name?: string; items?: string[] } = {};
      if (typeof req.body?.name === 'string') patch.name = req.body.name;
      if (req.body?.items !== undefined) {
        if (!isStringArray(req.body.items))
          return reply.code(400).send({ error: 'bad_request', message: 'items must be strings' });
        patch.items = req.body.items;
      }
      const w = watchlists.update(Number(req.params.id), patch);
      return w ?? reply.code(404).send({ error: 'not_found' });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/watchlists/:id', async (req, reply) => {
    if (!watchlists.remove(Number(req.params.id)))
      return reply.code(404).send({ error: 'not_found' });
    return watchlists.all();
  });

  app.get('/api/prefs', async () => prefs.get());

  app.put<{ Body: unknown }>('/api/prefs', async (req, reply) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return reply.code(400).send({ error: 'bad_request', message: 'expected an object' });
    }
    try {
      prefs.set(req.body as Record<string, unknown>);
      return { ok: true };
    } catch (e) {
      return reply.code(413).send({ error: 'too_large', message: (e as Error).message });
    }
  });
}
