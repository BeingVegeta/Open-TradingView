import { istToEpoch, type ServerMessage } from '@otv/shared';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { MarketClock } from '../src/kite/marketClock';
import { MockKiteGateway } from '../src/kite/mockGateway';
import { makeApp } from './helpers';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const until = async (cond: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function setup(speed = 30) {
  // Monday 11:00:40 IST; 30x so a 1-minute bar closes every 2 real seconds.
  const clock = new MarketClock(istToEpoch(2026, 10, 12, 11, 0, 40), speed);
  const gateway = new MockKiteGateway({ clock });
  await gateway.start();
  const m = await makeApp({
    gateway,
    marketClock: clock,
    tickerBackoffMs: 50,
    reconcileDelayMs: 3000,
  });
  cleanups.push(
    () => gateway.close(),
    () => m.server.close(),
  );
  const state = new URL(m.auth.beginLogin(), 'http://x').searchParams.get('state')!;
  await m.auth.completeLogin('mock-1', state);
  await m.sync.sync();
  const url = await m.server.listen({ host: '127.0.0.1', port: 0 });
  return { m, gateway, clock, wsUrl: url.replace('http', 'ws') + '/ws' };
}

function connect(wsUrl: string, origin = 'http://127.0.0.1:5173') {
  const ws = new WebSocket(wsUrl, { headers: { origin } });
  const msgs: (ServerMessage & { at: number })[] = [];
  ws.on('message', (d) =>
    msgs.push({ ...(JSON.parse(String(d)) as ServerMessage), at: Date.now() }),
  );
  cleanups.push(() => ws.close());
  return {
    ws,
    msgs,
    open: new Promise<void>((r, j) => (ws.once('open', () => r()), ws.once('error', j))),
  };
}

describe('live candles over /ws (mock market at 30x)', { timeout: 30_000 }, () => {
  it('rejects connections from other origins', async () => {
    const { wsUrl } = await setup();
    const { ws } = connect(wsUrl, 'https://evil.example');
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
    expect(code).toBe(1008);
  });

  it('streams coalesced bar updates and reconciles closed bars with history', async () => {
    const { wsUrl, m, clock } = await setup();
    const c = connect(wsUrl);
    await c.open;
    expect(c.msgs[0]).toMatchObject({ type: 'hello', auth: { state: 'logged_in' } });
    c.ws.send(JSON.stringify({ type: 'subscribe', sub: 'a', key: 'NSE:RELIANCE', tf: '1m' }));

    // Live updates arrive...
    await until(() => c.msgs.filter((x) => x.type === 'bars' && !x.replace).length >= 10);
    const live = c.msgs.filter(
      (x): x is Extract<ServerMessage, { type: 'bars' }> & { at: number } =>
        x.type === 'bars' && !x.replace,
    );
    // ...coalesced: never more than ~7 per second for one chart.
    const span = (live.at(-1)!.at - live[0]!.at) / 1000;
    expect(live.length / Math.max(span, 1)).toBeLessThanOrEqual(8);

    // After a bar closes (+3s market time), its Kite version replaces the live one.
    await until(() => c.msgs.filter((x) => x.type === 'bars' && x.replace).length >= 2, 15000);
    const replaced = c.msgs
      .filter(
        (x): x is Extract<ServerMessage, { type: 'bars' }> & { at: number } =>
          x.type === 'bars' && !!x.replace,
      )
      .at(-1)!;
    const inst = m.instruments.get('NSE:RELIANCE')!;
    const hist = await m.history.getBefore(
      't',
      inst,
      { id: '1m', label: '1m', interval: 'minute', bar: 1 },
      { limit: 20 },
    );
    for (const b of replaced.bars) {
      const h = hist.candles.find((x) => x.time === b.time);
      if (h && b.time + 60 <= clock.now() / 1000) expect(b).toEqual(h);
    }
    // Every live bar is session-anchored and within the newest few minutes.
    for (const msg of live)
      for (const b of msg.bars)
        expect((b.time - istToEpoch(2026, 10, 12, 9, 15) / 1000) % 60).toBe(0);
  });

  it('live-built bars match history once complete (mock ticks follow the history path)', async () => {
    const { wsUrl, m, clock } = await setup(10);
    const c = connect(wsUrl);
    await c.open;
    c.ws.send(JSON.stringify({ type: 'subscribe', sub: 'a', key: 'NSE:INFY', tf: '1m' }));
    // Collect the live state of a bar that started after we subscribed and has closed.
    const startS = Math.floor(clock.now() / 1000 / 60) * 60 + 60;
    await until(() => clock.now() / 1000 > startS + 65, 20_000);
    const lastLive = new Map<number, unknown>();
    for (const x of c.msgs)
      if (x.type === 'bars' && !x.replace) for (const b of x.bars) lastLive.set(b.time, b);
    const inst = m.instruments.get('NSE:INFY')!;
    const hist = await m.history.getBefore(
      't',
      inst,
      { id: '1m', label: '1m', interval: 'minute', bar: 1 },
      { limit: 10 },
    );
    expect(lastLive.get(startS)).toEqual(hist.candles.find((h) => h.time === startS));
  });

  it('recovers from an upstream drop and re-syncs bars from history', async () => {
    const { wsUrl, m, gateway } = await setup();
    const c = connect(wsUrl);
    await c.open;
    c.ws.send(JSON.stringify({ type: 'subscribe', sub: 'a', key: 'NSE:TCS', tf: '1m' }));
    await until(() => c.msgs.some((x) => x.type === 'bars' && !x.replace));
    const before = c.msgs.length;
    gateway.dropTickerConnections();
    await until(() =>
      c.msgs.slice(before).some((x) => x.type === 'live' && x.live.upstream === 'reconnecting'),
    );
    await until(() =>
      c.msgs.slice(before).some((x) => x.type === 'live' && x.live.upstream === 'connected'),
    );
    await until(() => c.msgs.slice(before).some((x) => x.type === 'bars' && x.replace));
    await until(
      () => c.msgs.slice(before).filter((x) => x.type === 'bars' && !x.replace).length > 3,
    );
    expect(m.ticker.status.state).toBe('connected');
  });

  it('pushes the logged-out state when Kite rejects the token', async () => {
    const { wsUrl, gateway } = await setup();
    const c = connect(wsUrl);
    await c.open;
    c.ws.send(JSON.stringify({ type: 'subscribe', sub: 'a', key: 'NSE:ITC', tf: '5m' }));
    await until(() => c.msgs.some((x) => x.type === 'bars'));
    gateway.expireAllTokens();
    gateway.dropTickerConnections();
    await until(() => c.msgs.some((x) => x.type === 'auth' && x.auth.state === 'logged_out'));
  });

  it('streams watchlist quotes with change vs previous close, and depth + OI in full detail', async () => {
    const { wsUrl, m } = await setup();
    const c = connect(wsUrl);
    await c.open;
    const fut = [...m.instruments.index.search('nifty fut', { limit: 1 })][0]!.key;
    c.ws.send(
      JSON.stringify({
        type: 'watch',
        sub: 'wl',
        keys: ['NSE:INFY', 'NSE:NIFTY 50', 'NSE:DOESNOTEXIST'],
        detail: 'quote',
      }),
    );
    c.ws.send(JSON.stringify({ type: 'watch', sub: 'depth', keys: [fut], detail: 'full' }));
    const quotes = (sub: string) =>
      c.msgs.flatMap((x) => (x.type === 'quotes' && x.sub === sub ? x.quotes : []));
    await until(
      () =>
        new Set(quotes('wl').map((q) => q.key)).size === 2 && quotes('depth').some((q) => q.depth),
    );
    const infy = quotes('wl')
      .filter((q) => q.key === 'NSE:INFY')
      .at(-1)!;
    expect(infy.prevClose).toBeGreaterThan(0);
    expect(infy.change).toBeCloseTo(infy.lastPrice - infy.prevClose!, 6);
    expect(infy.depth).toBeUndefined();
    const d = quotes('depth')
      .filter((q) => q.depth)
      .at(-1)!;
    expect(d.depth!.buy).toHaveLength(5);
    expect(d.oi).toBeGreaterThan(0);
    // Upstream mode is the richest requested: the future is in full mode.
    expect(m.ticker.desired().get(m.instruments.get(fut)!.token)).toBe('full');
    expect(m.ticker.desired().get(m.instruments.get('NSE:INFY')!.token)).toBe('quote');

    c.ws.send(JSON.stringify({ type: 'unwatch', sub: 'wl' }));
    await until(() => !m.ticker.desired().has(m.instruments.get('NSE:INFY')!.token));
  });

  it('reports live-vs-Kite candle differences and per-exchange anchoring', async () => {
    const { wsUrl, m } = await setup(10);
    const c = connect(wsUrl);
    await c.open;
    c.ws.send(JSON.stringify({ type: 'subscribe', sub: 'a', key: 'NSE:INFY', tf: '1m' }));
    const base = wsUrl.replace('ws://', 'http://').replace('/ws', '');
    const diag = async () =>
      (await (await fetch(`${base}/api/dev/diagnostics`)).json()) as {
        series: Record<string, { barsCompared: number; barsWithIdenticalOHLC: number }>;
      };
    await until(
      async () => ((await diag()).series['NSE:INFY|1m']?.barsCompared ?? 0) >= 1,
      25_000,
    ).catch(async () => {
      throw new Error(JSON.stringify(await diag()));
    });
    const st = (await diag()).series['NSE:INFY|1m']!;
    // Mock ticks follow the history path exactly at 10x, so live bars match Kite's.
    expect(st.barsWithIdenticalOHLC).toBe(st.barsCompared);

    const a = (await (await fetch(`${base}/api/dev/anchoring`)).json()) as {
      anchoring: Record<string, Record<string, string[]>>;
    };
    // Minutes past the hour at which every hourly candle starts.
    const minutes = (key: string) => [
      ...new Set(
        Object.values(a.anchoring[key] ?? {})
          .flat()
          .map((t) => t.slice(3)),
      ),
    ];
    expect(minutes('NSE:NIFTY 50')).toEqual(['15']);
    expect(minutes('BSE:SENSEX')).toEqual(['15']);
    expect(minutes(Object.keys(a.anchoring).find((k) => k.startsWith('MCX:'))!)).toEqual(['00']);
    expect(minutes(Object.keys(a.anchoring).find((k) => k.startsWith('CDS:'))!)).toEqual(['00']);
    const fullDay = Object.values(a.anchoring['NSE:NIFTY 50']!).find((d) => d.length === 7)!;
    expect(fullDay).toEqual(['09:15', '10:15', '11:15', '12:15', '13:15', '14:15', '15:15']);
    expect(m.ticker).toBeDefined();
  });

  it('releases the upstream subscription when the last viewer leaves', async () => {
    const { wsUrl, m } = await setup();
    const c = connect(wsUrl);
    await c.open;
    c.ws.send(JSON.stringify({ type: 'subscribe', sub: 'a', key: 'NSE:SBIN', tf: '5m' }));
    await until(() => m.ticker.desired().size === 1);
    c.ws.send(JSON.stringify({ type: 'unsubscribe', sub: 'a' }));
    await until(() => m.ticker.desired().size === 0 && m.live.size === 0);
  });
});
