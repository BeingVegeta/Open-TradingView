import type { Candle, Instrument, KiteInterval, KiteMode, SessionUser } from '@otv/shared';
import type { Priority } from './rateLimiter';

export interface NewSession {
  accessToken: string;
  user: SessionUser;
}

export interface RequestOpts {
  priority?: Priority;
  signal?: AbortSignal;
}

export interface HistoryRequest {
  instrument: Instrument;
  interval: KiteInterval;
  /** Epoch seconds, inclusive. */
  from: number;
  /** Epoch seconds, exclusive. */
  to: number;
  oi?: boolean;
}

/**
 * Everything the server needs from Kite, behind one interface so that
 * `KITE_MODE=mock` can swap in a fake. Grows with each milestone.
 * Read-only by design: there is no order API here.
 * Methods throw KiteApiError.
 */
export interface KiteGateway {
  readonly mode: KiteMode;
  /**
   * Where to send the browser to log in. `state` must come back on the
   * redirect URL as a `state` query parameter (Kite's `redirect_params`).
   */
  loginUrl(state: string): string;
  /** Exchanges the `request_token` from the login redirect for an access token. */
  createSession(requestToken: string): Promise<NewSession>;
  /** Invalidates an access token upstream (logout). */
  invalidateSession(accessToken: string): Promise<void>;
  /** The full instrument master. */
  fetchInstruments(accessToken: string, opts?: RequestOpts): Promise<Instrument[]>;
  /** Candles with open time in [from, to), ascending. The range must fit the interval's cap. */
  fetchHistory(accessToken: string, req: HistoryRequest, opts?: RequestOpts): Promise<Candle[]>;
  /** WebSocket URL of the ticker for an access token. */
  tickerUrl(accessToken: string): string;
  /** Starts local resources (mock/replay ticker server). */
  start?(): Promise<void>;
  close?(): Promise<void>;
}
