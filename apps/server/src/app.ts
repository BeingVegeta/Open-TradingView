import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { AuthService } from './auth/authService';
import { SessionStore } from './auth/sessionStore';
import type { Config } from './config';
import type { Db } from './db';
import { systemClock, type Clock } from './kite/clock';
import type { KiteGateway } from './kite/gateway';
import { CandleCache } from './history/candleCache';
import { HistoryService } from './history/historyService';
import { registerAuthRoutes } from './http/authRoutes';
import { registerGuards } from './http/guards';
import { registerMarketRoutes } from './http/marketRoutes';
import { InstrumentStore } from './instruments/instrumentStore';
import { InstrumentSync } from './instruments/instrumentSync';
import { registerClientHub } from './live/clientHub';
import { LiveCandles } from './live/liveCandles';
import { TickerManager } from './ticker/tickerManager';

export interface AppDeps {
  config: Config;
  db: Db;
  gateway: KiteGateway;
  /** Wall clock for auth and scheduling (tests). */
  now?: () => number;
  /** Market-data clock (mock/replay may shift and speed it up). Defaults to the wall clock. */
  marketClock?: Clock & { speed?: number };
  logger?: FastifyServerOptions['logger'];
  /** Raw ticker frames, e.g. for the tick recorder. */
  onTickerFrame?: (data: Buffer, isBinary: boolean, receivedAt: number) => void;
  /** Ticker reconnect backoff floor (tests). */
  tickerBackoffMs?: number;
  reconcileDelayMs?: number;
}

export interface App {
  server: FastifyInstance;
  auth: AuthService;
  instruments: InstrumentStore;
  sync: InstrumentSync;
  history: HistoryService;
  ticker: TickerManager;
  live: LiveCandles;
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

  const { isAllowedOrigin } = registerGuards(server, config);

  const instruments = new InstrumentStore(db);
  const clock = deps.now ? { ...systemClock, now: deps.now } : systemClock;
  const sync = new InstrumentSync({ store: instruments, gateway, auth, log: server.log, clock });
  server.addHook('onClose', async () => sync.stop());
  const marketClock = deps.marketClock ?? clock;
  const history = new HistoryService({
    cache: new CandleCache(db),
    gateway,
    caps: config.historyCaps,
    log: server.log,
    now: () => marketClock.now(),
  });
  const ticker = new TickerManager({
    auth,
    urlFor: (token) => gateway.tickerUrl(token),
    log: server.log,
    ...(deps.onTickerFrame ? { onFrame: deps.onTickerFrame } : {}),
    ...(deps.tickerBackoffMs ? { minBackoffMs: deps.tickerBackoffMs } : {}),
  });
  const live = new LiveCandles({
    ticker,
    history,
    instruments,
    auth,
    clock: marketClock,
    log: server.log,
    ...(deps.reconcileDelayMs !== undefined ? { reconcileDelayMs: deps.reconcileDelayMs } : {}),
  });
  server.addHook('onClose', async () => ticker.stop());

  server.get('/api/health', async () => ({ ok: true, mode: gateway.mode }));
  registerAuthRoutes(server, { config, auth, gateway });
  registerMarketRoutes(server, { auth, instruments, sync, history });
  await registerClientHub(server, { auth, ticker, live, clock: marketClock, isAllowedOrigin });
  if (gateway.mode === 'mock' && 'dropTickerConnections' in gateway) {
    // Development aids for exercising recovery paths in mock mode.
    const mock = gateway as unknown as { dropTickerConnections(): void; expireAllTokens(): void };
    server.post('/api/dev/drop-ticker', async () => (mock.dropTickerConnections(), { ok: true }));
    server.post(
      '/api/dev/expire-token',
      async () => (mock.expireAllTokens(), mock.dropTickerConnections(), { ok: true }),
    );
  }

  if (existsSync(config.webDistDir)) {
    await server.register(fastifyStatic, { root: config.webDistDir, wildcard: false });
    server.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  return { server, auth, instruments, sync, history, ticker, live };
}
