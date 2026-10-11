import { randomUUID } from 'node:crypto';
import websocket from '@fastify/websocket';
import type { Candle, ClientMessage, LiveStatus, ServerMessage } from '@otv/shared';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { AuthService } from '../auth/authService';
import type { Clock } from '../kite/clock';
import type { TickerManager } from '../ticker/tickerManager';
import type { LiveCandles } from './liveCandles';

/** Pushes per chart are coalesced to at most one per this interval (~6–7 per second). */
export const FLUSH_MS = 150;
const PING_MS = 15_000;

interface Client {
  id: string;
  ws: WebSocket;
  /** sub id → series id */
  subs: Map<string, string>;
  /** sub id → bars waiting to be sent, by time (latest state wins). */
  pending: Map<string, Map<number, Candle>>;
  alive: boolean;
}

export function liveStatus(ticker: TickerManager, clock: Clock & { speed?: number }): LiveStatus {
  const s = ticker.status;
  return {
    upstream: s.state,
    lastTickAt: s.lastTickAt,
    retryAt: s.retryAt,
    marketNow: clock.now(),
    speed: clock.speed ?? 1,
  };
}

/**
 * The browser's single WebSocket (`/ws`). Browsers never talk to Kite: they
 * subscribe to (instrument, timeframe) series here and receive bar updates,
 * plus auth and upstream-connection status.
 */
export async function registerClientHub(
  app: FastifyInstance,
  deps: {
    auth: AuthService;
    ticker: TickerManager;
    live: LiveCandles;
    clock: Clock & { speed?: number };
    isAllowedOrigin: (origin: string | undefined) => boolean;
  },
): Promise<void> {
  const { auth, ticker, live, clock } = deps;
  const clients = new Set<Client>();
  const send = (c: Client, m: ServerMessage) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(m));
  };

  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  live.on('bars', (e) => {
    for (const c of clients) {
      for (const [sub, series] of c.subs) {
        if (series !== e.series) continue;
        if (e.replace) {
          // Authoritative bars go out immediately and supersede pending live updates for them.
          const p = c.pending.get(sub);
          for (const b of e.bars) p?.delete(b.time);
          send(c, { type: 'bars', sub, bars: e.bars, replace: true });
          continue;
        }
        let p = c.pending.get(sub);
        if (!p) c.pending.set(sub, (p = new Map()));
        for (const b of e.bars) p.set(b.time, b);
      }
    }
  });

  auth.on('change', (status) => {
    for (const c of clients) send(c, { type: 'auth', auth: status });
  });

  let lastStatus = '';
  const pushStatus = () => {
    const st = liveStatus(ticker, clock);
    const sig = `${st.upstream}|${st.retryAt}`;
    if (sig === lastStatus) return;
    lastStatus = sig;
    for (const c of clients) send(c, { type: 'live', live: st });
  };
  ticker.on('status', pushStatus);

  const flush = setInterval(() => {
    for (const c of clients) {
      for (const [sub, p] of c.pending) {
        if (!p.size) continue;
        const bars = [...p.values()].sort((a, b) => a.time - b.time);
        p.clear();
        send(c, { type: 'bars', sub, bars });
      }
    }
  }, FLUSH_MS);
  // Also lets the client see that ticks are flowing (lastTickAt) without a message per tick.
  const statusTick = setInterval(() => {
    const st = liveStatus(ticker, clock);
    for (const c of clients) send(c, { type: 'live', live: st });
  }, 5000);
  const pinger = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, PING_MS);
  for (const t of [flush, statusTick, pinger]) t.unref();
  app.addHook('onClose', async () => {
    clearInterval(flush);
    clearInterval(statusTick);
    clearInterval(pinger);
    for (const c of clients) c.ws.terminate();
  });

  app.get('/ws', { websocket: true }, (ws, req) => {
    // Browsers don't apply CORS to WebSockets: a hostile page could otherwise connect.
    if (!deps.isAllowedOrigin(req.headers.origin)) {
      ws.close(1008, 'forbidden origin');
      return;
    }
    const c: Client = { id: randomUUID(), ws, subs: new Map(), pending: new Map(), alive: true };
    clients.add(c);
    send(c, { type: 'hello', auth: auth.status(), live: liveStatus(ticker, clock) });

    ws.on('pong', () => (c.alive = true));
    ws.on('message', (raw) => {
      c.alive = true;
      let m: ClientMessage;
      try {
        m = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (m.type === 'ping') return send(c, { type: 'pong' });
      if (m.type === 'unsubscribe') {
        const series = c.subs.get(m.sub);
        if (series) live.release(series, `${c.id}:${m.sub}`);
        c.subs.delete(m.sub);
        c.pending.delete(m.sub);
        return;
      }
      if (m.type === 'subscribe') {
        if (!auth.session())
          return send(c, {
            type: 'error',
            sub: m.sub,
            error: 'logged_out',
            message: 'Not logged in',
          });
        const prev = c.subs.get(m.sub);
        if (prev) live.release(prev, `${c.id}:${m.sub}`);
        try {
          const series = live.acquire(m.key, m.tf, `${c.id}:${m.sub}`);
          c.subs.set(m.sub, series);
          const snap = live.snapshot(series);
          if (snap.length) send(c, { type: 'bars', sub: m.sub, bars: snap });
        } catch (err) {
          send(c, {
            type: 'error',
            sub: m.sub,
            error: 'bad_request',
            message: (err as Error).message,
          });
        }
      }
    });
    ws.on('close', () => {
      clients.delete(c);
      for (const [sub, series] of c.subs) live.release(series, `${c.id}:${sub}`);
    });
  });
}
