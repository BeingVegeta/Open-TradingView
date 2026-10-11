import type { AuthStatus } from './auth';
import type { Candle } from './market';
import type { Quote } from './watchlist';

export type UpstreamState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

export interface LiveStatus {
  upstream: UpstreamState;
  /** Epoch ms of the last tick from Kite. */
  lastTickAt: number | null;
  /** Next upstream reconnect attempt, epoch ms. */
  retryAt: number | null;
  /** The market clock (differs from wall time in mock/replay mode). */
  marketNow: number;
  /** Market clock speed (1 in live mode). */
  speed: number;
}

/** Browser → server messages on /ws. */
export type ClientMessage =
  | { type: 'subscribe'; sub: string; key: string; tf: string }
  | { type: 'unsubscribe'; sub: string }
  /** Live quotes for a set of instruments: 'quote' for watchlists, 'full' adds market depth and OI. */
  | { type: 'watch'; sub: string; keys: string[]; detail: 'quote' | 'full' }
  | { type: 'unwatch'; sub: string }
  | { type: 'ping' };

/** Server → browser messages on /ws. */
export type ServerMessage =
  | { type: 'hello'; auth: AuthStatus; live: LiveStatus }
  | { type: 'auth'; auth: AuthStatus }
  | { type: 'live'; live: LiveStatus }
  /**
   * Bars for a subscription. Without `replace`, they are live updates of the
   * newest bars (merge by time). With `replace`, they are authoritative
   * (reconciled with Kite's history) and overwrite what the client holds.
   */
  | { type: 'bars'; sub: string; bars: Candle[]; replace?: boolean }
  /** Changed quotes since the last push (coalesced, ~4 per second). */
  | { type: 'quotes'; sub: string; quotes: Quote[] }
  | { type: 'error'; sub?: string; error: string; message: string }
  | { type: 'pong' };
