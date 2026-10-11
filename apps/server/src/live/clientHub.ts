import { randomUUID } from 'node:crypto';
import websocket from '@fastify/websocket';
import type { Candle, ClientMessage, LiveStatus, Quote, ServerMessage } from '@otv/shared';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { AuthService } from '../auth/authService';
import type { InstrumentStore } from '../instruments/instrumentStore';
import type { Clock } from '../kite/clock';
import type { TickerManager } from '../ticker/tickerManager';
import type { LiveCandles } from './liveCandles';
import { tickToQuote } from './quotes';

/** Pushes per chart are coalesced to at most one per this interval (~6–7 per second). */
export const FLUSH_MS = 150;
/** Watchlist/depth quotes are pushed at most this often (~4 per second). */
export const QUOTE_FLUSH_MS = 250;
const MAX_WATCH_KEYS = 500;
const PING_MS = 15_000;

interface Client {
  id: string;
  ws: WebSocket;
  /** sub id → series id */
  subs: Map<string, string>;
  /** sub id → bars waiting to be sent, by time (latest state wins). */
  pending: Map<string, Map<number, Candle>>;
  /** Quote subscriptions: sub id → detail level and token → key. */
  watches: Map<string, { detail: 'quote' | 'full'; keys: string[]; tokens: Map<number, string> }>;
  /** sub id → quotes waiting to be sent, by key (latest wins). */
  pendingQuotes: Map<string, Map<string, Quote>>;
  alive: boolean;
  /** Re-resolves watched keys to tokens (after the instrument list changes). */
  resolveWatches?: () => void;
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
    instruments: InstrumentStore;
    clock: Clock & { speed?: number };
    isAllowedOrigin: (origin: string | undefined) => boolean;
  },
): Promise<void> {
  const { auth, ticker, live, clock, instruments } = deps;
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

  ticker.on('ticks', (ticks) => {
    for (const c of clients) {
      for (const [sub, w] of c.watches) {
        for (const t of ticks) {
          const key = w.tokens.get(t.token);
          if (!key) continue;
          let p = c.pendingQuotes.get(sub);
          if (!p) c.pendingQuotes.set(sub, (p = new Map()));
          // Merge so a quote-mode tick doesn't erase depth from an earlier full tick.
          const merged = ticker.lastTick(t.token) ?? t;
          p.set(key, tickToQuote(key, merged, w.detail));
        }
      }
    }
  });

  // A new instrument list (first sync, or the daily refresh) can resolve keys that
  // were unknown before, and derivative tokens change: re-resolve every watch.
  instruments.on('replaced', () => {
    for (const c of clients) c.resolveWatches?.();
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
  const quoteFlush = setInterval(() => {
    for (const c of clients) {
      for (const [sub, p] of c.pendingQuotes) {
        if (!p.size) continue;
        send(c, { type: 'quotes', sub, quotes: [...p.values()] });
        p.clear();
      }
    }
  }, QUOTE_FLUSH_MS);
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
  for (const t of [flush, quoteFlush, statusTick, pinger]) t.unref();
  app.addHook('onClose', async () => {
    clearInterval(flush);
    clearInterval(quoteFlush);
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
    const c: Client = {
      id: randomUUID(),
      ws,
      subs: new Map(),
      pending: new Map(),
      watches: new Map(),
      pendingQuotes: new Map(),
      alive: true,
    };
    const resolveWatch = (cl: Client, sub: string, keys: string[], detail: 'quote' | 'full') => {
      const tokens = new Map<number, string>();
      for (const key of keys) {
        const inst = instruments.get(key);
        if (inst) tokens.set(inst.token, inst.key);
      }
      // Release then re-acquire: the ticker batches both, so unchanged tokens cause no upstream traffic.
      ticker.release(`watch:${cl.id}:${sub}`);
      for (const token of tokens.keys()) ticker.acquire(`watch:${cl.id}:${sub}`, token, detail);
      cl.watches.set(sub, { detail, keys, tokens });
      return tokens;
    };
    c.resolveWatches = () => {
      for (const [sub, w] of c.watches) resolveWatch(c, sub, w.keys, w.detail);
    };
    const unwatch = (sub: string) => {
      ticker.release(`watch:${c.id}:${sub}`);
      c.watches.delete(sub);
      c.pendingQuotes.delete(sub);
    };
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
      if (m.type === 'unwatch') return unwatch(m.sub);
      if (m.type === 'watch') {
        if (!auth.session())
          return send(c, {
            type: 'error',
            sub: m.sub,
            error: 'logged_out',
            message: 'Not logged in',
          });
        if (!Array.isArray(m.keys)) return;
        const detail = m.detail === 'full' ? 'full' : 'quote';
        const keys = m.keys
          .filter((k): k is string => typeof k === 'string')
          .slice(0, MAX_WATCH_KEYS);
        const tokens = resolveWatch(c, m.sub, keys, detail);
        // Immediate snapshot from the latest ticks we already have.
        const snap: Quote[] = [];
        for (const [token, key] of tokens) {
          const t = ticker.lastTick(token);
          if (t) snap.push(tickToQuote(key, t, detail));
        }
        if (snap.length) send(c, { type: 'quotes', sub: m.sub, quotes: snap });
        return;
      }
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
      for (const sub of [...c.watches.keys()]) unwatch(sub);
    });
  });
}
