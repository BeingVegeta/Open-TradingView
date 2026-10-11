import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Runtime } from '../src/runtime';

const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.shutdown();
});

function env(extra: Record<string, string> = {}) {
  const port = String(20000 + Math.floor(Math.random() * 20000));
  return {
    KITE_MODE: 'mock',
    PORT: port,
    DATA_DIR: mkdtempSync(path.join(tmpdir(), 'otv-rt-')),
    LOG_LEVEL: 'silent',
    ...extra,
  };
}

const until = async (cond: () => Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await cond().catch(() => false))) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('runtime mode switching', () => {
  it('reports the mode and refuses live without credentials', async () => {
    const e = env();
    const rt = new Runtime(e);
    runtimes.push(rt);
    await rt.start();
    const base = `http://127.0.0.1:${e.PORT}`;
    expect(await (await fetch(`${base}/api/mode`)).json()).toEqual({
      mode: 'mock',
      liveAvailable: false,
      mock: { marketOpen: false, speed: 1 },
    });
    const r = await fetch(`${base}/api/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'live' }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { message: string }).message).toMatch(/KITE_API_KEY/);
  });

  it('switches mock → live → mock on the same port, each with its own data', async () => {
    const e = env({ KITE_API_KEY: 'key', KITE_API_SECRET: 'secret' });
    const rt = new Runtime(e);
    runtimes.push(rt);
    await rt.start();
    const base = `http://127.0.0.1:${e.PORT}`;
    const mode = async () =>
      ((await (await fetch(`${base}/api/mode`)).json()) as { mode: string }).mode;
    const post = (body: object) =>
      fetch(`${base}/api/mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await post({ mode: 'live' })).status).toBe(200);
    await until(async () => (await mode()) === 'live');
    // Live mode: the login URL now points at Zerodha.
    const login = await fetch(`${base}/api/auth/login`, { redirect: 'manual' });
    expect(login.headers.get('location')).toMatch(
      /^https:\/\/kite\.zerodha\.com\/connect\/login\?v=3&api_key=key/,
    );

    expect((await post({ mode: 'mock', marketOpen: true, speed: 10 })).status).toBe(200);
    await until(async () => (await mode()) === 'mock');
    const info = await (await fetch(`${base}/api/mode`)).json();
    expect(info).toEqual({
      mode: 'mock',
      liveAvailable: true,
      mock: { marketOpen: true, speed: 10 },
    });
    expect((await post({ mode: 'mock', speed: 7 })).status).toBe(400);
  });
});
