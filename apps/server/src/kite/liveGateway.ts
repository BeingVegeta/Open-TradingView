import { formatIstDateTime, type Candle, type Instrument } from '@otv/shared';
import { KiteConnect } from 'kiteconnect';
import type { Config } from '../config';
import { toKiteError } from './errors';
import type { HistoryRequest, KiteGateway, NewSession, RequestOpts } from './gateway';
import { parseInstrumentsCsv } from './instrumentsCsv';
import { RateLimiter } from './rateLimiter';
import { KITE_API_ROOT, KiteRestClient } from './rest';

export const KITE_LOGIN_URL = 'https://kite.zerodha.com/connect/login';

export class LiveKiteGateway implements KiteGateway {
  readonly mode = 'live' as const;
  private readonly rest: KiteRestClient;

  constructor(
    private readonly config: Pick<Config, 'apiKey' | 'apiSecret'>,
    /** Override the API root (tests point this at a local fake). */
    private readonly root?: string,
    private readonly limiter = new RateLimiter(),
  ) {
    this.rest = new KiteRestClient(config.apiKey, limiter, root ?? KITE_API_ROOT);
  }

  private client(accessToken?: string): InstanceType<typeof KiteConnect> {
    return new KiteConnect({
      api_key: this.config.apiKey,
      ...(accessToken ? { access_token: accessToken } : {}),
      ...(this.root ? { root: this.root } : {}),
    });
  }

  loginUrl(state: string): string {
    const url = new URL(KITE_LOGIN_URL);
    url.searchParams.set('v', '3');
    url.searchParams.set('api_key', this.config.apiKey);
    // Kite appends these (URL-encoded query string) to the redirect URL as-is.
    url.searchParams.set('redirect_params', new URLSearchParams({ state }).toString());
    return url.toString();
  }

  async createSession(requestToken: string): Promise<NewSession> {
    const kc = this.client();
    try {
      // The SDK computes checksum = SHA-256(api_key + request_token + api_secret)
      // and POSTs it to /session/token.
      const s = await this.limiter.run('default', () =>
        kc.generateSession(requestToken, this.config.apiSecret),
      );
      const user: NewSession['user'] = { userId: s.user_id, userName: s.user_name };
      if (s.user_shortname) user.userShortname = s.user_shortname;
      if (s.email) user.email = s.email;
      if (s.broker) user.broker = s.broker;
      // Note: s.login_time is ignored on purpose. Kite sends it as an IST wall-clock
      // string without an offset and the SDK parses it in the machine's local timezone.
      return { accessToken: s.access_token, user };
    } catch (err) {
      throw toKiteError(err);
    }
  }

  async invalidateSession(accessToken: string): Promise<void> {
    const kc = this.client(accessToken);
    try {
      await this.limiter.run('default', () => kc.invalidateAccessToken(accessToken));
    } catch (err) {
      throw toKiteError(err);
    }
  }

  async fetchInstruments(accessToken: string, opts?: RequestOpts): Promise<Instrument[]> {
    return parseInstrumentsCsv(await this.rest.instrumentsCsv(accessToken, opts));
  }

  async fetchHistory(
    accessToken: string,
    req: HistoryRequest,
    opts?: RequestOpts,
  ): Promise<Candle[]> {
    const candles = await this.rest.historical(
      accessToken,
      {
        token: req.instrument.token,
        interval: req.interval,
        // Always IST strings: never let a Date be formatted in the machine's timezone.
        from: formatIstDateTime(req.from * 1000),
        // Kite's `to` is inclusive; the request range is half-open.
        to: formatIstDateTime((req.to - 1) * 1000),
        ...(req.oi ? { oi: true } : {}),
      },
      opts,
    );
    return candles.filter((c) => c.time >= req.from && c.time < req.to);
  }
}
