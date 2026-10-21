import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import type { ModeInfo, ModeSwitchRequest } from '@otv/shared';
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
import { registerDiagnosticRoutes } from './http/diagnosticRoutes';
import { registerMarketRoutes } from './http/marketRoutes';
import { registerUserRoutes } from './http/userRoutes';
import { PaperStore } from './paper/paperStore';
import { registerPaperRoutes } from './paper/paperRoutes';
import { PaperTrader } from './paper/paperTrader';
import { DrawingStore } from './user/drawingStore';
import { PrefsStore } from './user/prefsStore';
import { WatchlistStore } from './user/watchlistStore';
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
  /** How often the paper trader re-checks for a closed candle (tests). */
  paperPollMs?: number;
  /** Override the paper trader's late-call limit (tests run the market clock fast). */
  paperMaxEntryLagMs?: number;
  /** Override how often the paper trader may refill missing minutes (ms). */
  paperRefillEveryMs?: number;
  /** Run the paper trader (default true; most tests turn it off). */
  paper?: boolean;
  /** Lets the UI switch between live and mock data (see Runtime). */
  modeControl?: {
    info: () => ModeInfo;
    check: (req: ModeSwitchRequest) => string | null;
    request: (req: ModeSwitchRequest) => void;
  };
}

export interface App {
  server: FastifyInstance;
  auth: AuthService;
  instruments: InstrumentStore;
  sync: InstrumentSync;
  history: HistoryService;
  ticker: TickerManager;
  live: LiveCandles;
  paper: PaperTrader;
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
    marketNow: () => marketClock.now(),
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
  server.get(
    '/api/mode',
    async (): Promise<ModeInfo> =>
      deps.modeControl?.info() ?? {
        mode: gateway.mode,
        liveAvailable: gateway.mode === 'live',
        mock: null,
      },
  );
  server.post<{ Body: Partial<ModeSwitchRequest> }>('/api/mode', async (req, reply) => {
    const ctl = deps.modeControl;
    if (!ctl)
      return reply
        .code(501)
        .send({ error: 'not_supported', message: 'Mode switching is not available' });
    const body: ModeSwitchRequest = { mode: req.body?.mode as ModeSwitchRequest['mode'] };
    if (typeof req.body?.marketOpen === 'boolean') body.marketOpen = req.body.marketOpen;
    if (typeof req.body?.speed === 'number') body.speed = req.body.speed;
    const err = ctl.check(body);
    if (err) return reply.code(400).send({ error: 'bad_request', message: err });
    ctl.request(body);
    return { ok: true, restarting: true };
  });
  registerAuthRoutes(server, { config, auth, gateway });
  registerMarketRoutes(server, { auth, instruments, sync, history });
  registerDiagnosticRoutes(server, {
    auth,
    instruments,
    history,
    ticker,
    live,
    clock: marketClock,
  });
  const prefs = new PrefsStore(db);
  registerUserRoutes(server, {
    watchlists: new WatchlistStore(db),
    prefs,
    drawings: new DrawingStore(db),
  });
  // Paper trading of Varun's script: simulated fills only, never orders.
  const paperStore = new PaperStore(db);
  const paper = new PaperTrader({
    auth,
    history,
    live,
    ticker,
    instruments,
    store: paperStore,
    prefs,
    clock: marketClock,
    log: server.log,
    ...(deps.paperPollMs ? { pollMs: deps.paperPollMs } : {}),
    ...(deps.paperMaxEntryLagMs !== undefined ? { maxEntryLagMs: deps.paperMaxEntryLagMs } : {}),
    ...(deps.paperRefillEveryMs !== undefined ? { refillEveryMs: deps.paperRefillEveryMs } : {}),
    inactive: deps.paper === false,
  });
  server.addHook('onClose', async () => paper.stop());
  registerPaperRoutes(server, { store: paperStore, trader: paper });
  await registerClientHub(server, {
    auth,
    ticker,
    live,
    instruments,
    clock: marketClock,
    isAllowedOrigin,
  });
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

  server.addHook('onReady', async () => paper.reconsider());
  return { server, auth, instruments, sync, history, ticker, live, paper };
}
