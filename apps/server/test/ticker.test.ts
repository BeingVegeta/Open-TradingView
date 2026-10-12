import type { Tick } from '@otv/shared';
import { istToEpoch } from '@otv/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { MarketClock } from '../src/kite/marketClock';
import { MockKiteGateway } from '../src/kite/mockGateway';
import { TickerManager } from '../src/ticker/tickerManager';
import { makeApp } from './helpers';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup() {
  // Monday 11:00 IST, running 5x so a few real seconds cover plenty of ticks.
  const clock = new MarketClock(istToEpoch(2026, 10, 12, 11, 0), 5);
  const gateway = new MockKiteGateway({ clock });
  await gateway.start();
  const app = await makeApp({ gateway });
  const ticker = new TickerManager({
    auth: app.auth,
    urlFor: (t) => gateway.tickerUrl(t),
    log: app.server.log,
    minBackoffMs: 50,
  });
  cleanups.push(
    () => ticker.stop(),
    () => app.server.close(),
    () => gateway.close(),
  );
  const state = new URL(app.auth.beginLogin(), 'http://x').searchParams.get('state')!;
  await app.auth.completeLogin('mock-1', state);
  const list = await gateway.fetchInstruments('x');
  const tok = (key: string) => list.find((i) => i.key === key)!.token;
  const received: Tick[] = [];
  ticker.on('ticks', (t) => received.push(...t));
  return { app, gateway, ticker, tok, received };
}

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('ticker connection and manager (against the mock Kite ticker)', () => {
  it('streams ticks for acquired instruments in the requested mode', async () => {
    const { ticker, tok, received } = await setup();
    ticker.acquire('chart-1', tok('NSE:INFY'), 'full');
    ticker.acquire('watch', tok('NSE:NIFTY 50'), 'ltp');
    // The snapshot sent on subscribe comes in Kite's default (quote) mode; then the requested mode applies.
    await until(
      () =>
        received.some((t) => t.token === tok('NSE:INFY') && t.mode === 'full') &&
        received.some((t) => t.token === tok('NSE:NIFTY 50') && t.mode === 'ltp'),
    );
    const infy = received.find((t) => t.token === tok('NSE:INFY') && t.mode === 'full')!;
    expect(infy.depth?.buy).toHaveLength(5);
    expect(infy.volume).toBeGreaterThan(0);
    const nifty = received.find((t) => t.token === tok('NSE:NIFTY 50') && t.mode === 'ltp')!;
    expect(nifty).toMatchObject({ mode: 'ltp', tradable: false });
    expect(ticker.status.state).toBe('connected');
  });

  it('uses the richest requested mode and drops tokens nobody holds', async () => {
    const { ticker, tok } = await setup();
    const t = tok('NSE:TCS');
    ticker.acquire('watch', t, 'ltp');
    ticker.acquire('chart', t, 'full');
    expect(ticker.desired().get(t)).toBe('full');
    ticker.release('chart');
    expect(ticker.desired().get(t)).toBe('ltp');
    ticker.release('watch', t);
    expect(ticker.desired().size).toBe(0);
  });

  it('reconnects after a network drop and restores subscriptions and modes', async () => {
    const { ticker, tok, received, gateway } = await setup();
    const t = tok('NSE:SBIN');
    ticker.acquire('chart', t, 'full');
    await until(() => received.length > 0);
    let reconnected = false;
    ticker.on('connected', (re) => (reconnected ||= re));
    gateway.dropTickerConnections();
    await until(() => ticker.status.state === 'reconnecting');
    received.length = 0;
    await until(() => reconnected && received.some((x) => x.token === t && x.mode === 'full'));
    expect(ticker.status.state).toBe('connected');
  });

  it('stops and logs out when Kite refuses the token on reconnect (06:00 expiry)', async () => {
    const { app, ticker, tok, received, gateway } = await setup();
    ticker.acquire('chart', tok('NSE:ITC'), 'quote');
    await until(() => received.length > 0);
    gateway.expireAllTokens();
    gateway.dropTickerConnections();
    await until(() => app.auth.status().state === 'logged_out');
    expect(app.auth.status()).toMatchObject({ reason: 'token_rejected' });
    await until(() => ticker.status.state === 'stopped');
  });

  it('resubscribes everything after the next login', async () => {
    const { app, ticker, tok, received, gateway } = await setup();
    ticker.acquire('chart', tok('NSE:LT'), 'full');
    await until(() => received.length > 0);
    await app.auth.logout();
    await until(() => ticker.status.state === 'stopped');
    received.length = 0;
    const state = new URL(app.auth.beginLogin(), 'http://x').searchParams.get('state')!;
    await app.auth.completeLogin('mock-2', state);
    await until(() => received.some((x) => x.token === tok('NSE:LT')));
    expect(gateway).toBeDefined();
  });
});
