import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { AuthService } from './auth/authService';
import { SessionStore } from './auth/sessionStore';
import type { Config } from './config';
import type { Db } from './db';
import { systemClock } from './kite/clock';
import type { KiteGateway } from './kite/gateway';
import { CandleCache } from './history/candleCache';
import { HistoryService } from './history/historyService';
import { registerAuthRoutes } from './http/authRoutes';
import { registerGuards } from './http/guards';
import { registerMarketRoutes } from './http/marketRoutes';
import { InstrumentStore } from './instruments/instrumentStore';
import { InstrumentSync } from './instruments/instrumentSync';

export interface AppDeps {
  config: Config;
  db: Db;
  gateway: KiteGateway;
  now?: () => number;
  logger?: FastifyServerOptions['logger'];
}

export interface App {
  server: FastifyInstance;
  auth: AuthService;
  instruments: InstrumentStore;
  sync: InstrumentSync;
  history: HistoryService;
}

/** Strips one-time tokens from URLs before they reach the log. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:request_token|access_token|api_secret)=)[^&#]*/gi, '$1[redacted]');
}

export async function buildApp(deps: AppDeps): Promise<App> {
  const { config, db, gateway } = deps;
  const server = Fastify({
    logger: deps.logger ?? {
      level: config.logLevel,
      serializers: {
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          url: redactUrl(req.url),
        }),
      },
    },
    // Single local user: keep request bodies small.
    bodyLimit: 1024 * 1024,
  });

  const auth = new AuthService({
    apiKey: config.apiKey,
    store: new SessionStore(db),
    gateway,
    log: server.log,
    ...(deps.now ? { now: deps.now } : {}),
  });
  server.addHook('onClose', async () => auth.dispose());

  registerGuards(server, config);

  const instruments = new InstrumentStore(db);
  const clock = deps.now ? { ...systemClock, now: deps.now } : systemClock;
  const sync = new InstrumentSync({ store: instruments, gateway, auth, log: server.log, clock });
  server.addHook('onClose', async () => sync.stop());
  const history = new HistoryService({
    cache: new CandleCache(db),
    gateway,
    caps: config.historyCaps,
    log: server.log,
    ...(deps.now ? { now: deps.now } : {}),
  });

  server.get('/api/health', async () => ({ ok: true, mode: gateway.mode }));
  registerAuthRoutes(server, { config, auth, gateway });
  registerMarketRoutes(server, { auth, instruments, sync, history });

  if (existsSync(config.webDistDir)) {
    await server.register(fastifyStatic, { root: config.webDistDir, wildcard: false });
    server.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  return { server, auth, instruments, sync, history };
}
