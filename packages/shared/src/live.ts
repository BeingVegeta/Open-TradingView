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
  | {
      type: 'bars';
      sub: string;
      bars: Candle[];
      replace?: boolean;
      /**
       * With `replace`: the bars are complete for [from, to) (epoch s); any other
       * bar the client holds in that range doesn't exist at Kite and must go.
       */
      range?: BarRange;
    }
  /** Changed quotes since the last push (coalesced, ~4 per second). */
  | { type: 'quotes'; sub: string; quotes: Quote[] }
  | { type: 'error'; sub?: string; error: string; message: string }
  | { type: 'pong' };

/** A time range [from, to) (epoch s) for which a set of bars is complete. */
export interface BarRange {
  from: number;
  to: number;
}

/**
 * Drops candles inside `range` that the authoritative set doesn't have (e.g. live
 * bars built from ticks Kite's candles don't count). Candles outside it are kept.
 */
export function dropUnconfirmed<T extends { time: number }>(
  candles: T[],
  authoritative: readonly { time: number }[],
  range: BarRange,
): T[] {
  const keep = new Set(authoritative.map((b) => b.time));
  return candles.filter((c) => c.time < range.from || c.time >= range.to || keep.has(c.time));
}
