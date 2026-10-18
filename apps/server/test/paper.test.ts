import { istToEpoch, type PaperTrade } from '@otv/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { MarketClock } from '../src/kite/marketClock';
import { MockKiteGateway } from '../src/kite/mockGateway';
import { tradesCsv } from '../src/paper/paperRoutes';
import { _test, settingsHash } from '../src/paper/paperTrader';
import { B2B_DEFAULTS } from '@otv/shared';
import { HOST, makeApp } from './helpers';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const until = async (cond: () => boolean | Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe('paper trading (mock market at 60x)', { timeout: 60_000 }, () => {
  it('mirrors calls as option fills, stores the trade and its events, and reports metrics', async () => {
    const start = istToEpoch(2026, 10, 16, 10, 0, 30);
    const clock = new MarketClock(start, 60);
    const gateway = new MockKiteGateway({ clock });
    await gateway.start();
    const m = await makeApp({
      gateway,
      marketClock: clock,
      paper: true,
      paperPollMs: 200,
      reconcileDelayMs: 3000,
    });
    cleanups.push(
      () => gateway.close(),
      () => m.server.close(),
    );
    const state = new URL(m.auth.beginLogin(), 'http://x').searchParams.get('state')!;
    await m.auth.completeLogin('mock-1', state);
    await m.sync.sync();
    await m.server.ready();
    m.paper.reconsider();
    await until(() => m.paper.status().state === 'running', 20_000);

    const trades = async () =>
      (await m.server.inject({ url: '/api/paper/trades', headers: HOST })).json() as PaperTrade[];
    await until(async () => (await trades()).some((t) => t.status === 'closed'), 45_000);
    const [t] = await trades();

    // Only calls made after the trader started, on the strike and side the script named.
    expect(t!.signalTime * 1000).toBeGreaterThanOrEqual(start - 60_000);
    expect(t!.optionKey).toMatch(/^NFO:NIFTY.*(CE|PE)$/);
    expect(t!.optionKey).toContain(t!.optionName.replace(' ', ''));
    expect(t!.entryOpt).toBeGreaterThan(0);
    // Bought at the ask: never below the last price.
    expect(t!.entryOpt!).toBeGreaterThanOrEqual(t!.entryOptLtp!);
    expect(t!.lot1 && t!.lot2).toBeTruthy();
    expect(t!.result).toMatch(/^(L1 |SL \(both)/);
    expect(t!.scriptPts).toBeCloseTo(t!.lot1!.pts + t!.lot2!.pts, 6);
    expect(t!.netRs).toBeCloseTo(t!.grossRs! - t!.costsRs!, 6);
    expect(t!.costsRs).toBeGreaterThan(0);
    expect(t!.settingsHash).toBe(settingsHash(B2B_DEFAULTS));

    const events = (
      await m.server.inject({ url: '/api/paper/events?day=2026-10-16', headers: HOST })
    ).json() as {
      kind: string;
      tradeId: number | null;
    }[];
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(['CALL', 'EXIT']));
    expect(events.find((e) => e.kind === 'CALL')!.tradeId).toBe(t!.id);

    const metrics = (
      await m.server.inject({ url: '/api/paper/metrics', headers: HOST })
    ).json() as {
      trades: number;
      netRs: number;
    };
    expect(metrics.trades).toBeGreaterThanOrEqual(1);

    const csv = (await m.server.inject({ url: '/api/paper/trades.csv', headers: HOST })).body;
    expect(csv.split('\n')[0]).toContain('entry_opt');

    // Turning it off stops it and releases its subscriptions.
    const off = await m.server.inject({
      method: 'PUT',
      url: '/api/paper/config',
      headers: { ...HOST, 'content-type': 'application/json' },
      payload: { enabled: false },
    });
    expect(off.json()).toMatchObject({ enabled: false, state: 'off' });
  });
});

describe('paper helpers', () => {
  it('reads both lots from the script result', () => {
    expect(_test.rowTags({ res: 'SL (both lots)' } as never)).toEqual(['SL', 'SL']);
    expect(_test.rowTags({ res: 'L1 +15 / L2 GIVEBACK +42.5' } as never)).toEqual([
      '+15',
      'GIVEBACK +42.5',
    ]);
    expect(_test.rowTags({ res: 'OPEN' } as never)).toBeNull();
  });

  it('writes trades as CSV with quoting', () => {
    const csv = tradesCsv([
      {
        id: 1,
        day: '2026-10-19',
        notes: ['a, "quoted" note'],
        lot1: null,
        lot2: null,
      } as unknown as PaperTrade,
    ]);
    expect(csv).toContain('"a, ""quoted"" note"');
  });
});
