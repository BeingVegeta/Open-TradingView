import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KiteApiError, toKiteError } from '../src/kite/errors';
import { LiveKiteGateway } from '../src/kite/liveGateway';

/**
 * Runs the real kiteconnect SDK against a local fake of api.kite.trade to pin
 * down what it sends (checksum, headers) and how its errors surface.
 */
describe('LiveKiteGateway against a fake Kite API', () => {
  const fake = Fastify();
  const seen: { method: string; url: string; headers: Record<string, unknown>; body: unknown }[] =
    [];
  let root = '';
  const gw = () => new LiveKiteGateway({ apiKey: 'key123', apiSecret: 'secret456' }, root);

  beforeAll(async () => {
    fake.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_r, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );
    fake.addHook('onRequest', async (req) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: undefined });
    });
    fake.post('/session/token', async (req, reply) => {
      seen.at(-1)!.body = req.body;
      const { request_token } = req.body as Record<string, string>;
      if (request_token === 'expired') {
        return reply.code(403).send({
          status: 'error',
          error_type: 'TokenException',
          message: 'Token is invalid or has expired.',
        });
      }
      return {
        status: 'success',
        data: {
          user_id: 'AB1234',
          user_name: 'Test User',
          user_shortname: 'Test',
          email: 't@example.com',
          broker: 'ZERODHA',
          access_token: 'acc789',
          login_time: '2026-10-12 09:01:02',
        },
      };
    });
    fake.delete('/session/token', async () => ({ status: 'success', data: true }));
    root = await fake.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(() => fake.close());

  it('builds the v3 login URL with the state in redirect_params', () => {
    expect(gw().loginUrl('abc_123')).toBe(
      'https://kite.zerodha.com/connect/login?v=3&api_key=key123&redirect_params=state%3Dabc_123',
    );
  });

  it('exchanges the request token with checksum = sha256(api_key + request_token + api_secret)', async () => {
    const s = await gw().createSession('req999');
    expect(s).toEqual({
      accessToken: 'acc789',
      user: {
        userId: 'AB1234',
        userName: 'Test User',
        userShortname: 'Test',
        email: 't@example.com',
        broker: 'ZERODHA',
      },
    });
    const req = seen.at(-1)!;
    expect(req.headers['x-kite-version']).toBe('3');
    expect(req.body).toEqual({
      api_key: 'key123',
      request_token: 'req999',
      checksum: createHash('sha256').update('key123req999secret456').digest('hex'),
    });
  });

  it('maps a 403 TokenException to a token error', async () => {
    const err = await gw()
      .createSession('expired')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KiteApiError);
    expect(err).toMatchObject({ kind: 'token', errorType: 'TokenException' });
  });

  it('invalidates with the auth header and access token', async () => {
    await gw().invalidateSession('acc789');
    const req = seen.at(-1)!;
    expect(req.method).toBe('DELETE');
    expect(req.headers.authorization).toBe('token key123:acc789');
    expect(new URL(req.url, 'http://x').searchParams.get('access_token')).toBe('acc789');
  });

  it('reports an unreachable API as a retryable network error', async () => {
    const err = await new LiveKiteGateway({ apiKey: 'k', apiSecret: 's' }, 'http://127.0.0.1:1')
      .createSession('x')
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'network', retryable: true });
  });
});

describe('toKiteError', () => {
  it('classifies Kite error types', () => {
    expect(toKiteError({ error_type: 'PermissionException', message: 'No market data' }).kind).toBe(
      'permission',
    );
    expect(
      toKiteError({ error_type: 'InputException', message: 'interval exceeds max limit: 60 days' })
        .kind,
    ).toBe('input');
    expect(toKiteError({ error_type: 'NetworkException', message: 'Too many requests' }).kind).toBe(
      'rate_limit',
    );
  });
});
