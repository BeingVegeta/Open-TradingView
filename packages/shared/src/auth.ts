export type KiteMode = 'live' | 'mock';

/** Why the user is currently logged out. `null` means they never logged in (or logged out themselves). */
export type LoggedOutReason =
  /** The daily 06:00 IST token expiry passed. */
  | 'expired'
  /** Kite rejected the token (403 TokenException) before the scheduled expiry. */
  | 'token_rejected'
  /** The Zerodha login page returned an error or the request_token exchange failed. */
  | 'login_failed'
  /** The API key in the configuration no longer matches the stored session. */
  | 'api_key_changed';

export interface SessionUser {
  userId: string;
  userName: string;
  userShortname?: string;
  email?: string;
  broker?: string;
}

export type AuthStatus =
  | {
      state: 'logged_in';
      mode: KiteMode;
      user: SessionUser;
      /** Epoch ms. */
      loginTime: number;
      /** Epoch ms of the scheduled 06:00 IST expiry. */
      expiresAt: number;
    }
  | {
      state: 'logged_out';
      mode: KiteMode;
      reason: LoggedOutReason | null;
      /** Human-readable detail for `login_failed` / `token_rejected`. */
      message?: string;
    };

/** Which data source the server is running on, and what the UI may switch to. */
export interface ModeInfo {
  mode: KiteMode;
  /** True when KITE_API_KEY and KITE_API_SECRET are configured. */
  liveAvailable: boolean;
  /** Mock market settings (mock mode only). */
  mock: { marketOpen: boolean; speed: number } | null;
}

export interface ModeSwitchRequest {
  mode: KiteMode;
  /** Mock: start "as if the market is open" (default true). */
  marketOpen?: boolean;
  /** Mock: market clock speed (default 1). */
  speed?: number;
}
