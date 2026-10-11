import type { KiteMode, SessionUser } from '@otv/shared';

export interface NewSession {
  accessToken: string;
  user: SessionUser;
}

/**
 * Everything the server needs from Kite, behind one interface so that
 * `KITE_MODE=mock` can swap in a fake. Grows with each milestone
 * (instruments, history, ticker). Read-only by design: there is no order API here.
 */
export interface KiteGateway {
  readonly mode: KiteMode;
  /** Where to send the browser to log in. */
  loginUrl(): string;
  /** Exchanges the `request_token` from the login redirect for an access token. Throws KiteApiError. */
  createSession(requestToken: string): Promise<NewSession>;
  /** Invalidates an access token upstream (logout). Throws KiteApiError. */
  invalidateSession(accessToken: string): Promise<void>;
}
