import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { nextTokenExpiry, type AuthStatus, type LoggedOutReason } from '@otv/shared';
import type { FastifyBaseLogger } from 'fastify';
import { KiteApiError, toKiteError } from '../kite/errors';
import type { KiteGateway } from '../kite/gateway';
import type { SessionStore, StoredSession } from './sessionStore';

/** setTimeout cannot wait longer than this (~24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How long a started login may take to come back from Zerodha. */
const LOGIN_STATE_TTL_MS = 15 * 60_000;
const MAX_PENDING_LOGINS = 16;

export interface AuthServiceOptions {
  apiKey: string;
  store: SessionStore;
  gateway: KiteGateway;
  log: FastifyBaseLogger;
  now?: () => number;
}

/**
 * Owns the single Kite session. Being logged out is a normal state, not an
 * error: the token dies every morning at 06:00 IST and Kite issues no refresh
 * token to individual users.
 *
 * Emits `change` with the new AuthStatus whenever the state changes.
 */
export class AuthService extends EventEmitter<{ change: [AuthStatus] }> {
  private current: StoredSession | null = null;
  private reason: LoggedOutReason | null = null;
  private message: string | undefined;
  private expiryTimer: NodeJS.Timeout | undefined;
  /** Login `state` values handed out and not yet used, with their expiry. */
  private readonly pendingStates = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly opts: AuthServiceOptions) {
    super();
    this.now = opts.now ?? Date.now;
    const stored = opts.store.load();
    if (!stored) return;
    if (stored.apiKey !== opts.apiKey) {
      opts.store.clear();
      this.reason = 'api_key_changed';
    } else if (stored.expiresAt <= this.now()) {
      opts.store.clear();
      this.reason = 'expired';
    } else {
      this.current = stored;
      this.armExpiryTimer();
    }
  }

  status(): AuthStatus {
    this.checkExpiry();
    const mode = this.opts.gateway.mode;
    if (this.current) {
      return {
        state: 'logged_in',
        mode,
        user: this.current.user,
        loginTime: this.current.loginTime,
        expiresAt: this.current.expiresAt,
      };
    }
    const out: AuthStatus = { state: 'logged_out', mode, reason: this.reason };
    if (this.message) out.message = this.message;
    return out;
  }

  /** The live session, or null. Server-side only: never send the access token anywhere but Kite. */
  session(): StoredSession | null {
    this.checkExpiry();
    return this.current;
  }

  /** Starts a login: returns the Zerodha URL carrying a fresh one-time `state`. */
  beginLogin(): string {
    const now = this.now();
    for (const [s, exp] of this.pendingStates) if (exp <= now) this.pendingStates.delete(s);
    while (this.pendingStates.size >= MAX_PENDING_LOGINS) {
      this.pendingStates.delete(this.pendingStates.keys().next().value!);
    }
    const state = randomBytes(16).toString('base64url');
    this.pendingStates.set(state, now + LOGIN_STATE_TTL_MS);
    return this.opts.gateway.loginUrl(state);
  }

  /** Consumes a `state` from the callback. True only for one this server issued and that hasn't expired. */
  private consumeState(state: string | undefined): boolean {
    if (!state) return false;
    const exp = this.pendingStates.get(state);
    this.pendingStates.delete(state);
    return exp !== undefined && exp > this.now();
  }

  /**
   * Completes the redirect flow. Rejects callbacks whose `state` this server
   * didn't issue (a login it didn't start). On failure the state becomes
   * logged_out/login_failed.
   */
  async completeLogin(requestToken: string, state: string | undefined): Promise<void> {
    if (!this.consumeState(state)) {
      this.opts.log.warn('Login callback with unknown or expired state; rejecting');
      this.loginFailed(
        'The login response did not match a login started from this app (or it took longer than 15 minutes). Please try again.',
      );
      return;
    }
    try {
      const { accessToken, user } = await this.opts.gateway.createSession(requestToken);
      const loginTime = this.now();
      const s: StoredSession = {
        apiKey: this.opts.apiKey,
        accessToken,
        user,
        loginTime,
        expiresAt: nextTokenExpiry(loginTime),
      };
      this.opts.store.save(s);
      this.current = s;
      this.reason = null;
      this.message = undefined;
      this.armExpiryTimer();
      this.opts.log.info(
        { userId: user.userId, expiresAt: new Date(s.expiresAt).toISOString() },
        'Kite session created',
      );
      this.emitChange();
    } catch (err) {
      const e = toKiteError(err);
      this.opts.log.warn(
        { kind: e.kind, errorType: e.errorType, msg: e.message },
        'Kite login failed',
      );
      this.loginFailed(e.message);
    }
  }

  /** The Zerodha login page came back without a usable request_token. */
  loginFailed(message: string): void {
    this.drop('login_failed', message);
  }

  async logout(): Promise<void> {
    const s = this.current;
    this.drop(null);
    if (!s) return;
    try {
      await this.opts.gateway.invalidateSession(s.accessToken);
    } catch (err) {
      // The local session is gone either way; an already-dead token is fine.
      this.opts.log.warn({ msg: toKiteError(err).message }, 'Kite token invalidation failed');
    }
  }

  /**
   * Call with any error from a Kite request. Returns true if it was a
   * TokenException, in which case the session has been dropped.
   */
  handleKiteError(err: unknown): boolean {
    const e = err instanceof KiteApiError ? err : toKiteError(err);
    if (e.kind !== 'token' || !this.current) return e.kind === 'token';
    this.opts.log.warn({ msg: e.message }, 'Kite rejected the access token; dropping session');
    this.drop('token_rejected', e.message);
    return true;
  }

  dispose(): void {
    clearTimeout(this.expiryTimer);
    this.removeAllListeners();
  }

  private checkExpiry(): void {
    if (this.current && this.current.expiresAt <= this.now()) this.drop('expired');
  }

  private drop(reason: LoggedOutReason | null, message?: string): void {
    const changed = this.current !== null || this.reason !== reason || this.message !== message;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.current = null;
    this.reason = reason;
    this.message = message;
    this.opts.store.clear();
    if (changed) this.emitChange();
  }

  private armExpiryTimer(): void {
    clearTimeout(this.expiryTimer);
    if (!this.current) return;
    const delay = Math.min(Math.max(this.current.expiresAt - this.now(), 0), MAX_TIMER_MS);
    this.expiryTimer = setTimeout(() => {
      if (this.current && this.current.expiresAt <= this.now()) this.drop('expired');
      else this.armExpiryTimer();
    }, delay);
    this.expiryTimer.unref();
  }

  private emitChange(): void {
    this.emit('change', this.status());
  }
}
