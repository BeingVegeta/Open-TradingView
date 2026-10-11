import { KiteConnect } from 'kiteconnect';
import type { Config } from '../config';
import { toKiteError } from './errors';
import type { KiteGateway, NewSession } from './gateway';

export const KITE_LOGIN_URL = 'https://kite.zerodha.com/connect/login';

export class LiveKiteGateway implements KiteGateway {
  readonly mode = 'live' as const;

  constructor(
    private readonly config: Pick<Config, 'apiKey' | 'apiSecret'>,
    /** Override the API root (tests point this at a local fake). */
    private readonly root?: string,
  ) {}

  private client(accessToken?: string): InstanceType<typeof KiteConnect> {
    return new KiteConnect({
      api_key: this.config.apiKey,
      ...(accessToken ? { access_token: accessToken } : {}),
      ...(this.root ? { root: this.root } : {}),
    });
  }

  loginUrl(): string {
    const url = new URL(KITE_LOGIN_URL);
    url.searchParams.set('v', '3');
    url.searchParams.set('api_key', this.config.apiKey);
    return url.toString();
  }

  async createSession(requestToken: string): Promise<NewSession> {
    const kc = this.client();
    try {
      // The SDK computes checksum = SHA-256(api_key + request_token + api_secret)
      // and POSTs it to /session/token.
      const s = await kc.generateSession(requestToken, this.config.apiSecret);
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
      await kc.invalidateAccessToken(accessToken);
    } catch (err) {
      throw toKiteError(err);
    }
  }
}
