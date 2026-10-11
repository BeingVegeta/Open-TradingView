import type { Candle, ClientMessage, LiveStatus, ServerMessage } from '@otv/shared';
import { create } from 'zustand';
import { useAuth } from '../auth/authStore';

export type ConnState = 'connecting' | 'open' | 'closed';

interface LiveState {
  conn: ConnState;
  live: LiveStatus | null;
  /** performance.now() when `live` arrived (to advance the mock clock locally). */
  liveAt: number;
}

export const useLive = create<LiveState>(() => ({ conn: 'closed', live: null, liveAt: 0 }));

type BarsHandler = (bars: Candle[], replace: boolean) => void;

interface Sub {
  key: string;
  tf: string;
  onBars: BarsHandler;
  onResync?: () => void;
}

/** If nothing arrives for this long the socket is presumed dead (the server sends status every 5 s). */
const SILENCE_MS = 20_000;

/**
 * The browser's one WebSocket to the local server. Reconnects with backoff,
 * re-subscribes every chart on reconnect and asks each to re-sync its newest
 * bars (to fill whatever was missed while disconnected or asleep).
 */
class LiveClient {
  private ws: WebSocket | null = null;
  private readonly subs = new Map<string, Sub>();
  private seq = 0;
  private attempts = 0;
  private retryTimer: number | undefined;
  private silenceTimer: number | undefined;
  private wanted = false;
  private everOpened = false;

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.onVisible);
    window.addEventListener('offline', this.onOffline);
    this.connect();
  }

  stop(): void {
    this.wanted = false;
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.onVisible);
    window.removeEventListener('offline', this.onOffline);
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.silenceTimer);
    this.ws?.close();
    this.ws = null;
    useLive.setState({ conn: 'closed' });
  }

  /** Live bars for a chart. Returns an unsubscribe function. */
  subscribe(key: string, tf: string, onBars: BarsHandler, onResync?: () => void): () => void {
    const sub = `s${++this.seq}`;
    this.subs.set(sub, { key, tf, onBars, ...(onResync ? { onResync } : {}) });
    this.send({ type: 'subscribe', sub, key, tf });
    return () => {
      this.subs.delete(sub);
      this.send({ type: 'unsubscribe', sub });
    };
  }

  /** The OS says the network is gone: show it now rather than after the silence timeout. */
  private onOffline = () => {
    this.ws?.close();
  };

  private onVisible = () => {
    if (document.visibilityState !== 'visible' || !this.wanted) return;
    // After sleep the socket may look open but be dead: check right away.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) this.reconnectNow();
    else {
      this.send({ type: 'ping' });
      this.armSilence(4000);
    }
  };

  private reconnectNow(): void {
    window.clearTimeout(this.retryTimer);
    this.attempts = 0;
    this.ws?.close();
    this.ws = null;
    this.connect();
  }

  private connect(): void {
    if (!this.wanted || this.ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    useLive.setState({ conn: 'connecting' });
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      useLive.setState({ conn: 'open' });
      for (const [sub, s] of this.subs) this.send({ type: 'subscribe', sub, key: s.key, tf: s.tf });
      if (this.everOpened) for (const s of this.subs.values()) s.onResync?.();
      this.everOpened = true;
      this.armSilence();
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.armSilence();
      let m: ServerMessage;
      try {
        m = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      window.clearTimeout(this.silenceTimer);
      useLive.setState({ conn: 'closed' });
      if (!this.wanted) return;
      const delay = Math.min(10_000, 500 * 2 ** this.attempts++) * (0.75 + Math.random() * 0.5);
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private onMessage(m: ServerMessage): void {
    switch (m.type) {
      case 'hello':
        useAuth.setState({ status: m.auth, serverError: null });
        useLive.setState({ live: m.live, liveAt: performance.now() });
        break;
      case 'auth':
        useAuth.setState({ status: m.auth });
        break;
      case 'live':
        useLive.setState({ live: m.live, liveAt: performance.now() });
        break;
      case 'bars':
        this.subs.get(m.sub)?.onBars(m.bars, !!m.replace);
        break;
      default:
        break;
    }
  }

  private armSilence(ms = SILENCE_MS): void {
    window.clearTimeout(this.silenceTimer);
    this.silenceTimer = window.setTimeout(() => {
      // Dead socket (e.g. after the laptop slept): drop it and reconnect.
      this.ws?.close();
      this.ws = null;
      useLive.setState({ conn: 'closed' });
      this.connect();
    }, ms);
  }

  private send(m: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
}

export const liveClient = new LiveClient();
