import { buildApp, type AppDeps } from '../src/app';
import { readConfig, type Config } from '../src/config';
import { openDb } from '../src/db';
import { MockKiteGateway } from '../src/kite/mockGateway';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return {
    ...readConfig({ KITE_MODE: 'mock', ...overrides }),
    webDistDir: '/nonexistent',
  };
}

export async function makeApp(opts: Partial<AppDeps> = {}) {
  const config = opts.config ?? testConfig();
  const db = opts.db ?? openDb(':memory:');
  const gateway = opts.gateway ?? new MockKiteGateway();
  const app = await buildApp({ logger: false, ...opts, config, db, gateway });
  return { ...app, db, config, gateway };
}

export const HOST = { host: '127.0.0.1:8787' };
