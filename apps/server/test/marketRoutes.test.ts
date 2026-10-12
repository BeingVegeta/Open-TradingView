import { afterEach, describe, expect, it } from 'vitest';
import { KiteApiError } from '../src/kite/errors';
import { MockKiteGateway } from '../src/kite/mockGateway';
import { RateLimiter } from '../src/kite/rateLimiter';
import { HOST, makeApp } from './helpers';

type Made = Awaited<ReturnType<typeof makeApp>>;
let made: Made | undefined;
afterEach(async () => {
  await made?.server.close();
  made = undefined;
});

class FailingGateway extends MockKiteGateway {
  failWith: KiteApiError | null = null;
  override async fetchHistory(...args: Parameters<MockKiteGateway['fetchHistory']>) {
    if (this.failWith) throw this.failWith;
    return super.fetchHistory(...args);
  }
}

async function loggedIn() {
  const gateway = new FailingGateway({
    emulateRateLimit: false,
    limiter: new RateLimiter({ quote: 1e6, historical: 1e6, default: 1e6 }),
  });
  made = await makeApp({ gateway });
  const state = new URL(made.auth.beginLogin(), 'http://x').searchParams.get('state')!;
  await made.auth.completeLogin('mock-1', state);
  await made.sync.sync();
  return { m: made, gateway };
}

const history = (m: Made, q: string) =>
  m.server.inject({ url: `/api/history?${q}`, headers: HOST });

describe('market routes', () => {
  it('requires a session', async () => {
    made = await makeApp();
    const r = await history(made, 'key=NSE:INFY&tf=5m');
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'logged_out' });
  });

  it('serves history and validates parameters', async () => {
    const { m } = await loggedIn();
    const ok = await history(m, 'key=NSE:INFY&tf=5m&limit=50');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().candles).toHaveLength(50);
    expect((await history(m, 'key=NSE:INFY&tf=7m')).statusCode).toBe(400);
    expect((await history(m, 'key=NSE:NOPE&tf=5m')).json().error).toBe('not_found');
  });

  it('explains a missing market-data subscription and does not retry it', async () => {
    const { m, gateway } = await loggedIn();
    gateway.failWith = new KiteApiError(
      'permission',
      'Insufficient permission for that call.',
      'PermissionException',
      403,
    );
    const r = await history(m, 'key=NSE:INFY&tf=5m');
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: 'no_market_data' });
    expect(r.json().message).toMatch(/Connect plan/);
    expect(m.auth.status().state).toBe('logged_in');
  });

  it('logs out when Kite rejects the token mid-session', async () => {
    const { m, gateway } = await loggedIn();
    gateway.failWith = new KiteApiError(
      'token',
      'Incorrect `api_key` or `access_token`.',
      'TokenException',
      403,
    );
    const r = await history(m, 'key=NSE:INFY&tf=5m');
    expect(r.statusCode).toBe(401);
    expect(m.auth.status()).toMatchObject({ state: 'logged_out', reason: 'token_rejected' });
  });

  it('reports upstream outages as 503', async () => {
    const { m, gateway } = await loggedIn();
    gateway.failWith = new KiteApiError('network', 'socket hang up');
    const r = await history(m, 'key=NSE:INFY&tf=5m');
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe('upstream_unavailable');
  });
});

describe('aggregation diagnostic', () => {
  it('in mock mode, intraday candles match their 1-minute candles and the day volume includes the pre-open', async () => {
    const { m } = await loggedIn();
    const r = await m.server.inject({ url: '/api/dev/aggregation', headers: HOST });
    expect(r.statusCode).toBe(200);
    const body = r.json() as Record<string, Record<string, unknown>>;
    const rel = body['NSE:RELIANCE']! as Record<
      string,
      { allMatchOwnPeriod?: boolean; times?: string[] }
    > & { dayCandleVolume: number; sumOf1mVolumes: number };
    expect(rel['1h']!.allMatchOwnPeriod).toBe(true);
    expect(rel['1h']!.times).toEqual([
      '09:15',
      '10:15',
      '11:15',
      '12:15',
      '13:15',
      '14:15',
      '15:15',
    ]);
    expect(rel['15m']!.allMatchOwnPeriod).toBe(true);
    expect(rel.dayCandleVolume).toBeGreaterThan(rel.sumOf1mVolumes);
  });
});
