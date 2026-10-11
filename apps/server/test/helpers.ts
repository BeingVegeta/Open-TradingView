import { readConfig, type Config } from '../src/config';
import { openDb } from '../src/db';
import { buildApp } from '../src/app';
import type { KiteGateway } from '../src/kite/gateway';
import { MockKiteGateway } from '../src/kite/mockGateway';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return {
    ...readConfig({ KITE_MODE: 'mock', ...overrides }),
    webDistDir: '/nonexistent',
  };
}

export async function makeApp(
  opts: {
    gateway?: KiteGateway;
    now?: () => number;
    config?: Config;
    db?: ReturnType<typeof openDb>;
  } = {},
) {
  const config = opts.config ?? testConfig();
  const db = opts.db ?? openDb(':memory:');
  const gateway = opts.gateway ?? new MockKiteGateway();
  const app = await buildApp({
    config,
    db,
    gateway,
    logger: false,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { ...app, db, config, gateway };
}

export const HOST = { host: '127.0.0.1:8787' };
