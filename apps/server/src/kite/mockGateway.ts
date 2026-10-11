import { randomBytes } from 'node:crypto';
import { aggregateCandles, INTERVAL_BAR, type Candle, type Instrument } from '@otv/shared';
import { DEFAULT_RANGE_CAPS, type RangeCaps } from '../history/rangeCaps';
import { mockInstruments, type MockInstrument } from '../mock/instruments';
import { dayCandles, minuteCandles } from '../mock/synth';
import { KiteApiError } from './errors';
import type { HistoryRequest, KiteGateway, NewSession, RequestOpts } from './gateway';
import { RateLimiter } from './rateLimiter';

export const MOCK_LOGIN_PATH = '/api/auth/mock-login';
export const MOCK_REQUEST_TOKEN_PREFIX = 'mock-';

export interface MockGatewayOptions {
  /** Simulated network latency per REST call. */
  latencyMs?: number;
  now?: () => number;
  caps?: RangeCaps;
  limiter?: RateLimiter;
  /** Answer with 429 when history is called more than 3 times a second, like Kite. Default true. */
  emulateRateLimit?: boolean;
}

const DAY_S = 86_400;

/**
 * Fake Kite for development and tests: no network, no credentials.
 * Behaves like the real API where it matters to callers: per-interval range
 * caps (InputException), 3 req/s on history (429 if exceeded), the same
 * rate-limited queue, the still-forming last candle, holidays and listing dates.
 */
export class MockKiteGateway implements KiteGateway {
  readonly mode = 'mock' as const;
  private readonly latencyMs: number;
  private readonly now: () => number;
  private readonly caps: RangeCaps;
  private readonly limiter: RateLimiter;
  private readonly emulateRateLimit: boolean;
  private universe: Map<string, MockInstrument> | undefined;
  /** Upstream-side record of history request times, to emulate Kite's own 429s. */
  private readonly historyHits: number[] = [];
  /** Calls made, for tests and diagnostics. */
  readonly calls = { history: 0, instruments: 0 };
  readonly historyLog: { interval: string; from: number; to: number }[] = [];

  constructor(opts: MockGatewayOptions = {}) {
    this.latencyMs = opts.latencyMs ?? 0;
    this.now = opts.now ?? Date.now;
    this.caps = opts.caps ?? DEFAULT_RANGE_CAPS;
    this.limiter = opts.limiter ?? new RateLimiter();
    this.emulateRateLimit = opts.emulateRateLimit ?? true;
  }

  loginUrl(state: string): string {
    return `${MOCK_LOGIN_PATH}?${new URLSearchParams({ state })}`;
  }

  newRequestToken(): string {
    return MOCK_REQUEST_TOKEN_PREFIX + randomBytes(8).toString('hex');
  }

  async createSession(requestToken: string): Promise<NewSession> {
    if (!requestToken.startsWith(MOCK_REQUEST_TOKEN_PREFIX)) {
      throw new KiteApiError('token', 'Token is invalid or has expired.', 'TokenException', 403);
    }
    return {
      accessToken: 'mock-access-' + randomBytes(8).toString('hex'),
      user: { userId: 'MK0001', userName: 'Mock Trader', userShortname: 'Mock', broker: 'MOCK' },
    };
  }

  async invalidateSession(): Promise<void> {}

  async fetchInstruments(_accessToken: string, opts?: RequestOpts): Promise<Instrument[]> {
    return this.limiter.run(
      'default',
      async () => {
        await this.delay(this.latencyMs * 3);
        this.calls.instruments++;
        this.universe = new Map(mockInstruments(this.now()).map((m) => [m.instrument.key, m]));
        return [...this.universe.values()].map((m) => m.instrument);
      },
      opts,
    );
  }

  async fetchHistory(
    _accessToken: string,
    req: HistoryRequest,
    opts?: RequestOpts,
  ): Promise<Candle[]> {
    return this.limiter.run(
      'historical',
      async () => {
        this.calls.history++;
        this.historyLog.push({ interval: req.interval, from: req.from, to: req.to });
        const now = this.now();
        while (this.historyHits.length && this.historyHits[0]! <= now - 1000)
          this.historyHits.shift();
        this.historyHits.push(now);
        if (this.emulateRateLimit && this.historyHits.length > 3) {
          throw new KiteApiError('rate_limit', 'Too many requests', 'NetworkException', 429);
        }
        await this.delay(this.latencyMs);
        const cap = this.caps[req.interval];
        if (req.to - req.from > cap * DAY_S) {
          throw new KiteApiError(
            'input',
            `interval exceeds max limit: ${cap} days`,
            'InputException',
            400,
          );
        }
        const m = this.lookup(req.instrument);
        if (!m) throw new KiteApiError('input', 'invalid token', 'InputException', 400);
        const bar = INTERVAL_BAR[req.interval];
        let out: Candle[];
        if (bar === 'day') {
          out = dayCandles(m.spec, req.from * 1000, req.to * 1000, now);
        } else {
          const ones = minuteCandles(m.spec, req.from * 1000, req.to * 1000, now);
          out = bar === 1 ? ones : aggregateCandles(ones, req.instrument.exchange, bar);
        }
        if (!req.oi) for (const c of out) delete c.oi;
        return out.filter((c) => c.time >= req.from && c.time < req.to);
      },
      opts,
    );
  }

  private lookup(i: Instrument): MockInstrument | undefined {
    if (!this.universe) {
      this.universe = new Map(mockInstruments(this.now()).map((m) => [m.instrument.key, m]));
    }
    const m = this.universe.get(i.key);
    return m && m.instrument.token === i.token ? m : undefined;
  }

  private delay(ms: number): Promise<void> {
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }
}
