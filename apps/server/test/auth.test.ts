import { istToEpoch } from '@otv/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { KiteApiError } from '../src/kite/errors';
import type { KiteGateway } from '../src/kite/gateway';
import { HOST, makeApp, testConfig } from './helpers';

type Made = Awaited<ReturnType<typeof makeApp>>;
let made: Made | undefined;
afterEach(async () => {
  await made?.server.close();
  made = undefined;
});

/** Pulls the state back out of a login URL the way Kite's redirect_params would deliver it. */
function stateOf(loginUrl: string): string {
  const u = new URL(loginUrl, 'http://x');
  const direct = u.searchParams.get('state');
  if (direct) return direct;
  return new URLSearchParams(u.searchParams.get('redirect_params') ?? '').get('state')!;
}

async function mockLogin(m: Made) {
  const login = await m.server.inject({ url: '/api/auth/login', headers: HOST });
  expect(login.statusCode).toBe(302);
  const mock = await m.server.inject({ url: login.headers.location!, headers: HOST });
  const callback = new URL(mock.headers.location!);
  return m.server.inject({ url: callback.pathname + callback.search, headers: HOST });
}

describe('auth flow (mock gateway)', () => {
  it('starts logged out, logs in through the redirect flow, and logs out', async () => {
    const now = istToEpoch(2026, 10, 12, 10, 0);
    made = await makeApp({ now: () => now });
    const status = () =>
      made!.server.inject({ url: '/api/auth/status', headers: HOST }).then((r) => r.json());

    expect(await status()).toEqual({ state: 'logged_out', mode: 'mock', reason: null });

    const cb = await mockLogin(made);
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('http://127.0.0.1:8787/');

    const s = await status();
    expect(s.state).toBe('logged_in');
    expect(s.user.userId).toBe('MK0001');
    expect(s.expiresAt).toBe(istToEpoch(2026, 10, 13, 6, 0));
    expect(JSON.stringify(s)).not.toMatch(/access/i);

    const out = await made.server.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...HOST, 'content-type': 'application/json' },
      payload: {},
    });
    expect(out.json()).toEqual({ state: 'logged_out', mode: 'mock', reason: null });
    expect(made.db.prepare('SELECT count(*) n FROM session').get()).toEqual({ n: 0 });
  });

  it('records a failed login as a normal logged-out state', async () => {
    made = await makeApp();
    const cb = await made.server.inject({
      url: '/api/auth/callback?status=cancelled',
      headers: HOST,
    });
    expect(cb.statusCode).toBe(302);
    expect(made.auth.status()).toMatchObject({ state: 'logged_out', reason: 'login_failed' });

    const state = stateOf(made.auth.beginLogin());
    await made.server.inject({
      url: `/api/auth/callback?status=success&request_token=bogus&state=${state}`,
      headers: HOST,
    });
    expect(made.auth.status()).toMatchObject({
      state: 'logged_out',
      reason: 'login_failed',
      message: 'Token is invalid or has expired.',
    });
  });

  it('expires the session at 06:00 IST', async () => {
    let now = istToEpoch(2026, 10, 12, 15, 0);
    made = await makeApp({ now: () => now });
    await mockLogin(made);
    const changes: string[] = [];
    made.auth.on('change', (s) =>
      changes.push(s.state === 'logged_out' ? `out:${s.reason}` : 'in'),
    );

    now = istToEpoch(2026, 10, 13, 5, 59);
    expect(made.auth.status().state).toBe('logged_in');
    now = istToEpoch(2026, 10, 13, 6, 0);
    expect(made.auth.status()).toMatchObject({ state: 'logged_out', reason: 'expired' });
    expect(changes).toEqual(['out:expired']);
  });

  it('restores a persisted session after a restart, but not an expired one', async () => {
    let now = istToEpoch(2026, 10, 12, 11, 0);
    made = await makeApp({ now: () => now });
    await mockLogin(made);
    const db = made.db;
    await made.server.close();

    made = await makeApp({ db, now: () => now });
    expect(made.auth.status().state).toBe('logged_in');
    await made.server.close();

    now = istToEpoch(2026, 10, 13, 7, 0);
    made = await makeApp({ db, now: () => now });
    expect(made.auth.status()).toMatchObject({ state: 'logged_out', reason: 'expired' });
  });

  it('drops a session stored for a different API key', async () => {
    made = await makeApp();
    await mockLogin(made);
    const db = made.db;
    await made.server.close();
    made = await makeApp({ db, config: testConfig({ KITE_API_KEY: 'other_key' }) });
    expect(made.auth.status()).toMatchObject({ state: 'logged_out', reason: 'api_key_changed' });
  });

  it('drops the session on a TokenException and ignores other errors', async () => {
    made = await makeApp();
    await mockLogin(made);
    expect(made.auth.handleKiteError({ error_type: 'InputException', message: 'bad' })).toBe(false);
    expect(made.auth.status().state).toBe('logged_in');
    expect(
      made.auth.handleKiteError({
        error_type: 'TokenException',
        message: 'Incorrect `api_key` or `access_token`.',
      }),
    ).toBe(true);
    expect(made.auth.status()).toMatchObject({ state: 'logged_out', reason: 'token_rejected' });
  });

  it('still logs out locally when upstream invalidation fails', async () => {
    const gateway: KiteGateway = {
      mode: 'live',
      loginUrl: (state) =>
        `https://kite.zerodha.com/connect/login?v=3&api_key=k&redirect_params=state%3D${state}`,
      createSession: async () => ({ accessToken: 't', user: { userId: 'AB1234', userName: 'A' } }),
      invalidateSession: async () => {
        throw new KiteApiError('network', 'down');
      },
      fetchInstruments: async () => [],
      fetchHistory: async () => [],
    };
    made = await makeApp({ gateway });
    await made.auth.completeLogin('rt', stateOf(made.auth.beginLogin()));
    expect(made.auth.status().state).toBe('logged_in');
    await made.auth.logout();
    expect(made.auth.status()).toMatchObject({ state: 'logged_out', reason: null });
  });
});

describe('login state check', () => {
  const callback = (m: Made, query: string) =>
    m.server.inject({
      url: `/api/auth/callback?action=login&status=success&request_token=mock-1&${query}`,
      headers: HOST,
    });

  it('rejects a callback without a state', async () => {
    made = await makeApp();
    await callback(made, '');
    expect(made.auth.status()).toMatchObject({ state: 'logged_out', reason: 'login_failed' });
  });

  it('rejects a state this server did not issue', async () => {
    made = await makeApp();
    made.auth.beginLogin();
    await callback(made, 'state=forged');
    expect(made.auth.status()).toMatchObject({ state: 'logged_out', reason: 'login_failed' });
  });

  it('accepts an issued state once, and not after 15 minutes', async () => {
    let now = istToEpoch(2026, 10, 12, 9, 0);
    made = await makeApp({ now: () => now });
    const s1 = stateOf(made.auth.beginLogin());
    await callback(made, `state=${s1}`);
    expect(made.auth.status().state).toBe('logged_in');

    await made.auth.logout();
    await callback(made, `state=${s1}`); // replay
    expect(made.auth.status()).toMatchObject({ state: 'logged_out', reason: 'login_failed' });

    const s2 = stateOf(made.auth.beginLogin());
    now += 16 * 60_000;
    await callback(made, `state=${s2}`);
    expect(made.auth.status()).toMatchObject({ state: 'logged_out', reason: 'login_failed' });
  });
});

describe('localhost guards', () => {
  it('rejects foreign Host headers (DNS rebinding)', async () => {
    made = await makeApp();
    const r = await made.server.inject({
      url: '/api/health',
      headers: { host: 'attacker.example:8787' },
    });
    expect(r.statusCode).toBe(403);
    const ok = await made.server.inject({
      url: '/api/health',
      headers: { host: 'localhost:8787' },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('requires JSON and a same-site Origin for state-changing requests', async () => {
    made = await makeApp();
    const form = await made.server.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...HOST, 'content-type': 'text/plain' },
      payload: '{}',
    });
    expect(form.statusCode).toBe(415);
    const xsite = await made.server.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...HOST, 'content-type': 'application/json', origin: 'https://evil.example' },
      payload: {},
    });
    expect(xsite.statusCode).toBe(403);
    const same = await made.server.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...HOST, 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
      payload: {},
    });
    expect(same.statusCode).toBe(200);
  });
});
