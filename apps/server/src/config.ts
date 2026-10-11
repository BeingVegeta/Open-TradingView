import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KiteMode } from '@otv/shared';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export interface Config {
  mode: KiteMode;
  host: string;
  port: number;
  /** Required in live mode. */
  apiKey: string;
  /** Required in live mode. Never sent to the browser or logged. */
  apiSecret: string;
  /** Must exactly match the redirect URL registered on developers.kite.trade. */
  redirectUrl: string;
  /** Where the browser is sent after the login callback (the web app's origin). */
  appUrl: string;
  dataDir: string;
  /** Directory with the built web app, served when it exists. */
  webDistDir: string;
  logLevel: string;
}

export class ConfigError extends Error {}

/** The Vite dev server (`pnpm dev`), which proxies /api to this server. */
export const DEV_APP_URL = 'http://127.0.0.1:5173';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/** Loads `<repo>/.env` into process.env (existing variables win). */
export function loadDotEnv(file = path.join(REPO_ROOT, '.env')): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawMode = (env.KITE_MODE ?? 'live').trim().toLowerCase();
  if (rawMode !== 'live' && rawMode !== 'mock') {
    throw new ConfigError(`KITE_MODE must be "live" or "mock", got "${env.KITE_MODE}".`);
  }
  const mode: KiteMode = rawMode;

  const host = env.HOST?.trim() || '127.0.0.1';
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`PORT must be a TCP port number, got "${env.PORT}".`);
  }

  const apiKey = env.KITE_API_KEY?.trim() ?? '';
  const apiSecret = env.KITE_API_SECRET?.trim() ?? '';
  if (mode === 'live' && (!apiKey || !apiSecret)) {
    throw new ConfigError(
      'KITE_API_KEY and KITE_API_SECRET are required in live mode. ' +
        'Copy .env.example to .env and fill them in, or run with KITE_MODE=mock.',
    );
  }

  const ownOrigin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const redirectUrl = env.KITE_REDIRECT_URL?.trim() || `${ownOrigin}/api/auth/callback`;
  try {
    new URL(redirectUrl);
  } catch {
    throw new ConfigError(`KITE_REDIRECT_URL is not a valid URL: "${redirectUrl}".`);
  }

  return {
    mode,
    host,
    port,
    apiKey: mode === 'mock' ? apiKey || 'mock_api_key' : apiKey,
    apiSecret,
    redirectUrl,
    appUrl: (env.APP_URL?.trim() || (env.OTV_DEV === '1' ? DEV_APP_URL : ownOrigin)).replace(
      /\/+$/,
      '',
    ),
    dataDir: path.resolve(REPO_ROOT, env.DATA_DIR?.trim() || 'data'),
    webDistDir: path.join(REPO_ROOT, 'apps/web/dist'),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
  };
}
