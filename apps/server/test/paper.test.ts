import { istToEpoch, type PaperTrade } from '@otv/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { MarketClock } from '../src/kite/marketClock';
import { MockKiteGateway } from '../src/kite/mockGateway';
import { matchApp, parseCandleFile, runScript } from '../src/b2b/compare';
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
    const kinds = async () =>
      (
        (
          await m.server.inject({ url: '/api/paper/events?day=2026-10-16', headers: HOST })
        ).json() as { kind: string }[]
      ).map((e) => e.kind);
    // Events are stored after the trades of the same candle, which can wait on an option price.
    await until(
      async () =>
        (await trades()).some((t) => t.status === 'closed') && (await kinds()).includes('EXIT'),
      45_000,
    );
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

    // The export replays: the script on the trader's own candles makes the same call.
    const exp = await m.server.inject({ url: '/api/paper/export?day=2026-10-16', headers: HOST });
    expect(exp.headers['content-disposition']).toContain('paper-2026-10-16.json');
    const ex = exp.json() as { day: string; settingsHash: string; trades: PaperTrade[] };
    expect(ex).toMatchObject({ day: '2026-10-16', settingsHash: settingsHash(B2B_DEFAULTS) });
    expect(ex.trades.map((x) => x.id)).toContain(t!.id);
    const { candles } = parseCandleFile(exp.body);
    expect(candles.length).toBeGreaterThan(1000);
    const replay = runScript(candles, {
      day: '2026-10-16',
      warmup: null,
      trim: true,
      settings: B2B_DEFAULTS,
      pivotTie: 'newer',
    });
    const row = matchApp(replay.res.log, ex.trades, '2026-10-16').find((r) => r.live?.id === t!.id);
    expect(row!.offline).toBeDefined();
    expect(row!.flag).not.toMatch(/LIVE ONLY|RESULT DIFFERS/);
    expect(
      (await m.server.inject({ url: '/api/paper/export?day=16-10-2026', headers: HOST }))
        .statusCode,
    ).toBe(400);

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
