import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/app';
import { ConfigError, readConfig } from '../src/config';

describe('readConfig', () => {
  it('defaults to localhost and derives the redirect URL', () => {
    const c = readConfig({ KITE_API_KEY: 'k', KITE_API_SECRET: 's' });
    expect(c).toMatchObject({
      mode: 'live',
      host: '127.0.0.1',
      port: 8787,
      redirectUrl: 'http://127.0.0.1:8787/api/auth/callback',
      appUrl: 'http://127.0.0.1:8787',
    });
  });

  it('requires credentials in live mode only', () => {
    expect(() => readConfig({})).toThrow(ConfigError);
    expect(readConfig({ KITE_MODE: 'mock' }).mode).toBe('mock');
  });

  it('rejects unknown modes', () => {
    expect(() => readConfig({ KITE_MODE: 'paper' })).toThrow(/live.*mock/);
  });
});

describe('redactUrl', () => {
  it('strips one-time tokens from logged URLs', () => {
    expect(redactUrl('/api/auth/callback?action=login&request_token=abc123&status=success')).toBe(
      '/api/auth/callback?action=login&request_token=[redacted]&status=success',
    );
  });
});
