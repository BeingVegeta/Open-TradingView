import type { Tick, TickMode, UpstreamState } from '@otv/shared';
import type { FastifyBaseLogger } from 'fastify';
import WebSocket from 'ws';
import { systemClock, type Clock } from '../kite/clock';
import { parseTickFrame, toArrayBuffer } from './tickParser';

export interface UpstreamStatus {
  state: UpstreamState;
  /** Epoch ms of the last market-data frame (not heartbeat). */
  lastTickAt: number | null;
  /** Consecutive failed attempts since the last good connection. */
  attempts: number;
  /** Next reconnect attempt, epoch ms. */
  retryAt: number | null;
  error: string | null;
}

export interface TickerConnectionOpts {
  /** WebSocket URL including api_key and access_token, or null if there is no session. */
  url: () => string | null;
  onTicks: (ticks: Tick[]) => void;
  onStatus?: (s: UpstreamStatus) => void;
  /** Called once if Kite refuses the handshake with 403 (dead token). The connection stops. */
  onTokenRejected?: (message: string) => void;
  /** Called with every raw frame (for the tick recorder). */
  onFrame?: (data: Buffer, isBinary: boolean, receivedAt: number) => void;
  /** Called after each successful (re)connect, after subscriptions are restored. */
  onConnected?: (reconnect: boolean) => void;
  log: FastifyBaseLogger;
  clock?: Clock;
  /**
   * Time stamped on received ticks (the market clock, which differs from wall
   * time in mock/replay mode). Timers always use `clock`.
   */
  marketNow?: () => number;
  /** Treat the socket as dead if nothing (not even a heartbeat) arrives for this long. */
  silenceTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/** Kite allows this many instruments per connection. */
export const MAX_INSTRUMENTS = 3000;

/**
 * The single upstream Kite ticker WebSocket.
 *
 * Holds the *desired* subscriptions (token → mode) and makes the socket match
 * them: on every (re)connect it subscribes everything and restores modes, and
 * while connected it sends only the differences. Reconnects with jittered
 * exponential backoff; detects a dead socket by silence (Kite heartbeats every
 * couple of seconds); stops for good on a 403 handshake (expired token).
 * Never exits the process.
 */
export class TickerConnection {
  private ws: WebSocket | null = null;
  private readonly desired = new Map<number, TickMode>();
  private applied = new Map<number, TickMode>();
  private running = false;
  private everConnected = false;
  private silenceTimer: unknown;
  private retryTimer: unknown;
  private status: UpstreamStatus = {
    state: 'idle',
    lastTickAt: null,
    attempts: 0,
    retryAt: null,
    error: null,
  };
  private readonly clock: Clock;

  constructor(private readonly opts: TickerConnectionOpts) {
    this.clock = opts.clock ?? systemClock;
  }

  get state(): UpstreamStatus {
    return { ...this.status };
  }

  /** Replaces the desired subscription set. Connects or disconnects as needed. */
  setSubscriptions(next: Map<number, TickMode>): void {
    if (next.size > MAX_INSTRUMENTS)
      throw new Error(`Kite allows ${MAX_INSTRUMENTS} instruments per connection`);
    this.desired.clear();
    for (const [k, v] of next) this.desired.set(k, v);
    if (this.desired.size === 0) {
      // Nothing to stream: release the connection (Kite allows only 3 per API key).
      this.running = false;
      this.close('idle');
      return;
    }
    if (!this.running) this.start();
    else if (this.ws?.readyState === WebSocket.OPEN) this.sync();
    // Otherwise a connect or a scheduled reconnect is pending and will sync on open.
  }

  /** (Re)starts connecting with the current session. */
  start(): void {
    if (this.desired.size === 0) return;
    this.running = true;
    this.status.error = null;
    if (!this.ws) this.connect();
  }

  /** Stops streaming and never reconnects until start(). */
  stop(reason = 'stopped'): void {
    this.running = false;
    this.close('stopped');
    this.update({ error: reason === 'stopped' ? null : reason });
  }

  /** Test/diagnostic hook: drop the socket as if the network failed. */
  dropForTest(): void {
    this.ws?.terminate();
  }

  private connect(): void {
    const url = this.opts.url();
    if (!url) {
      this.running = false;
      this.update({ state: 'stopped', error: 'No Kite session' });
      return;
    }
    this.clock.clearTimeout(this.retryTimer);
    this.update({
      state: this.everConnected || this.status.attempts > 0 ? 'reconnecting' : 'connecting',
      retryAt: null,
    });
    const ws = new WebSocket(url, { headers: { 'X-Kite-Version': '3' }, handshakeTimeout: 10_000 });
    ws.binaryType = 'nodebuffer';
    this.ws = ws;
    let rejected = false;

    ws.on('unexpected-response', (_req, res) => {
      rejected = true;
      const code = res.statusCode ?? 0;
      res.resume();
      if (this.ws !== ws) return;
      this.ws = null;
      if (code === 403) {
        this.opts.log.warn('Kite ticker refused the access token (403); stopping');
        this.running = false;
        this.update({ state: 'stopped', error: 'Kite rejected the access token' });
        this.opts.onTokenRejected?.('the live-data connection was refused (HTTP 403)');
        return;
      }
      this.opts.log.warn({ code }, 'Kite ticker handshake failed');
      this.scheduleReconnect(`HTTP ${code} on connect`);
    });

    ws.on('open', () => {
      if (this.ws !== ws) return;
      const reconnect = this.everConnected;
      this.everConnected = true;
      this.applied = new Map();
      this.update({ state: 'connected', attempts: 0, error: null, retryAt: null });
      this.armSilence();
      this.sync();
      this.opts.log.info({ instruments: this.desired.size, reconnect }, 'Kite ticker connected');
      this.opts.onConnected?.(reconnect);
    });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (this.ws !== ws) return;
      this.armSilence();
      const now = this.clock.now();
      const marketNow = this.opts.marketNow?.() ?? now;
      this.opts.onFrame?.(data, isBinary, now);
      if (isBinary) {
        if (data.length <= 2) return; // heartbeat
        let ticks: Tick[];
        try {
          ticks = parseTickFrame(toArrayBuffer(data), marketNow);
        } catch (err) {
          this.opts.log.warn({ err: (err as Error).message }, 'Unparseable ticker frame');
          return;
        }
        if (ticks.length) {
          this.status.lastTickAt = now;
          this.opts.onTicks(ticks);
        }
        return;
      }
      this.onText(data.toString('utf8'));
    });

    ws.on('error', (err) => {
      if (this.ws !== ws || rejected) return;
      this.opts.log.warn({ err: err.message }, 'Kite ticker socket error');
    });

    ws.on('close', (code) => {
      if (this.ws !== ws || rejected) return;
      this.ws = null;
      this.clock.clearTimeout(this.silenceTimer);
      if (!this.running) {
        this.update({ state: this.desired.size ? 'stopped' : 'idle' });
        return;
      }
      this.scheduleReconnect(`closed (${code})`);
    });
  }

  private onText(text: string): void {
    let msg: { type?: string; data?: unknown };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === 'error') this.opts.log.warn({ data: msg.data }, 'Kite ticker error message');
    else if (msg.type === 'message') this.opts.log.info({ data: msg.data }, 'Kite broker message');
    // 'order' updates are ignored: this app is read-only.
  }

  /** Sends the difference between desired and applied subscriptions. */
  private sync(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const add: number[] = [];
    const remove: number[] = [];
    const byMode = new Map<TickMode, number[]>();
    for (const [token, mode] of this.desired) {
      const had = this.applied.get(token);
      if (had === undefined) add.push(token);
      if (had !== mode) byMode.set(mode, [...(byMode.get(mode) ?? []), token]);
    }
    for (const token of this.applied.keys()) if (!this.desired.has(token)) remove.push(token);
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    if (remove.length) send({ a: 'unsubscribe', v: remove });
    if (add.length) send({ a: 'subscribe', v: add });
    for (const [mode, tokens] of byMode) send({ a: 'mode', v: [mode, tokens] });
    this.applied = new Map(this.desired);
  }

  private armSilence(): void {
    this.clock.clearTimeout(this.silenceTimer);
    this.silenceTimer = this.clock.setTimeout(() => {
      if (!this.ws) return;
      this.opts.log.warn('Kite ticker went silent; reconnecting');
      this.ws.terminate();
    }, this.opts.silenceTimeoutMs ?? 7000);
  }

  private scheduleReconnect(why: string): void {
    const attempts = this.status.attempts + 1;
    const min = this.opts.minBackoffMs ?? 1000;
    const max = this.opts.maxBackoffMs ?? 30_000;
    const base = Math.min(max, min * 2 ** (attempts - 1));
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.update({ state: 'reconnecting', attempts, retryAt: this.clock.now() + delay, error: why });
    this.opts.log.info({ attempts, delay, why }, 'Kite ticker reconnect scheduled');
    this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = this.clock.setTimeout(() => {
      if (this.running && !this.ws) this.connect();
    }, delay);
  }

  private close(state: UpstreamState): void {
    this.clock.clearTimeout(this.retryTimer);
    this.clock.clearTimeout(this.silenceTimer);
    const ws = this.ws;
    this.ws = null;
    this.applied = new Map();
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.close();
    }
    this.update({ state, retryAt: null, attempts: 0 });
  }

  private update(patch: Partial<UpstreamStatus>): void {
    this.status = { ...this.status, ...patch };
    this.opts.onStatus?.({ ...this.status });
  }
}
