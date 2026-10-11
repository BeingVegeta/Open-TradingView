import { randomBytes } from 'node:crypto';
import { KiteApiError } from './errors';
import type { KiteGateway, NewSession } from './gateway';

export const MOCK_LOGIN_PATH = '/api/auth/mock-login';
export const MOCK_REQUEST_TOKEN_PREFIX = 'mock-';

/** Fake Kite for development and tests: no network, no credentials. */
export class MockKiteGateway implements KiteGateway {
  readonly mode = 'mock' as const;

  loginUrl(): string {
    return MOCK_LOGIN_PATH;
  }

  newRequestToken(): string {
    return MOCK_REQUEST_TOKEN_PREFIX + randomBytes(8).toString('hex');
  }

  async createSession(requestToken: string): Promise<NewSession> {
    if (!requestToken.startsWith(MOCK_REQUEST_TOKEN_PREFIX)) {
      throw new KiteApiError('token', 'Token is invalid or has expired.', 'TokenException');
    }
    return {
      accessToken: 'mock-access-' + randomBytes(8).toString('hex'),
      user: { userId: 'MK0001', userName: 'Mock Trader', userShortname: 'Mock', broker: 'MOCK' },
    };
  }

  async invalidateSession(): Promise<void> {}
}
