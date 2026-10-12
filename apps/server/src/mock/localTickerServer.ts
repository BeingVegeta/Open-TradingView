import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Tick, TickMode } from '@otv/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Clock } from '../kite/clock';
import { encodeTickFrame, HEARTBEAT_FRAME } from './tickEncoder';

export interface TickProducer {
  /** Ticks to send now for these subscriptions (mock-clock time `nowMs`). */
  produce(subs: Map<number, TickMode>, nowMs: number): Tick[];
}

interface Conn {
  ws: WebSocket;
  subs: Map<number, TickMode>;
  lastSent: number;
}

/**
 * A local server speaking Kite's ticker protocol: JSON subscribe/unsubscribe/mode
 * requests in, binary market-data frames and 1-byte heartbeats out, 403 on the
 * handshake for an unknown access token. Lets mock and replay modes run the
 * real connection, parser and reconnect code.
 */
export class LocalTickerServer {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly conns = new Set<Conn>();
  private timer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private port = 0;
  /** Seconds of mock time between tick batches (Kite sends roughly one per second per instrument). */
  private readonly stepMs: number;

  constructor(
    private readonly opts: {
      producer: TickProducer;
      clock: Clock & { speed?: number };
      isValid: (apiKey: string, accessToken: string) => boolean;
    },
  ) {
    const speed = opts.clock.speed ?? 1;
    this.stepMs = Math.max(50, Math.round(1000 / speed));
  }

  async listen(): Promise<number> {
    if (this.port) return this.port;
    const http = createServer((_req, res) => {
      res.writeHead(426).end();
    });
    const wss = new WebSocketServer({ noServer: true });
    http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const ok = this.opts.isValid(
        url.searchParams.get('api_key') ?? '',
        url.searchParams.get('access_token') ?? '',
      );
      if (!ok) {
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    this.http = http;
    this.wss = wss;
    this.port = (http.address() as AddressInfo).port;
    this.timer = setInterval(() => this.step(), this.stepMs);
    this.timer.unref();
    this.heartbeat = setInterval(() => {
      const now = Date.now();
      for (const c of this.conns) if (now - c.lastSent >= 1000) this.send(c, HEARTBEAT_FRAME);
    }, 1000);
    this.heartbeat.unref();
    return this.port;
  }

  url(apiKey: string, accessToken: string): string {
    return `ws://127.0.0.1:${this.port}/?${new URLSearchParams({ api_key: apiKey, access_token: accessToken })}`;
  }

  /** Simulates a network failure: kills every connection without a close handshake. */
  dropAll(): void {
    for (const c of this.conns) c.ws.terminate();
  }

  /** Closes connections authenticated with a token that is no longer valid. */
  get connections(): number {
    return this.conns.size;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    for (const c of this.conns) c.ws.terminate();
    this.wss?.close();
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
    this.port = 0;
  }

  private onConnection(ws: WebSocket): void {
    const c: Conn = { ws, subs: new Map(), lastSent: Date.now() };
    this.conns.add(c);
    ws.on('close', () => this.conns.delete(c));
    ws.on('error', () => this.conns.delete(c));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: { a?: string; v?: unknown };
      try {
        msg = JSON.parse(String(data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.a === 'subscribe' && Array.isArray(msg.v)) {
        // Kite's default mode for new subscriptions is quote.
        for (const t of msg.v as number[]) if (!c.subs.has(t)) c.subs.set(t, 'quote');
        this.sendNow(c, msg.v as number[]);
      } else if (msg.a === 'unsubscribe' && Array.isArray(msg.v)) {
        for (const t of msg.v as number[]) c.subs.delete(t);
      } else if (msg.a === 'mode' && Array.isArray(msg.v)) {
        const [mode, tokens] = msg.v as [TickMode, number[]];
        for (const t of tokens) if (c.subs.has(t)) c.subs.set(t, mode);
        this.sendNow(c, tokens);
      }
    });
  }

  /** Kite sends a snapshot as soon as you subscribe, even when the market is closed. */
  private sendNow(c: Conn, tokens: number[]): void {
    const subs = new Map([...c.subs].filter(([t]) => tokens.includes(t)));
    const ticks = this.opts.producer.produce(subs, this.opts.clock.now());
    if (ticks.length) this.send(c, encodeTickFrame(ticks));
  }

  private step(): void {
    const now = this.opts.clock.now();
    for (const c of this.conns) {
      if (!c.subs.size) continue;
      const ticks = this.opts.producer.produce(c.subs, now);
      if (ticks.length) this.send(c, encodeTickFrame(ticks));
    }
  }

  private send(c: Conn, frame: Buffer): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    c.ws.send(frame, { binary: true });
    c.lastSent = Date.now();
  }
}
