import {
  getTimeframe,
  istToEpoch,
  sessionOpenOn,
  toIstParts,
  type Candle,
  type Instrument,
} from '@otv/shared';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db';
import { CandleCache } from '../src/history/candleCache';
import { HistoryService } from '../src/history/historyService';
import { DEFAULT_RANGE_CAPS, type RangeCaps } from '../src/history/rangeCaps';
import { MockKiteGateway } from '../src/kite/mockGateway';
import { RateLimiter } from '../src/kite/rateLimiter';
import { mockInstruments } from '../src/mock/instruments';

const DAY = 86_400;
const silent = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child: () => silent,
  level: 'silent',
} as never;

function setup(opts: { now?: number; gatewayCaps?: RangeCaps; serviceCaps?: RangeCaps } = {}) {
  let now = opts.now ?? istToEpoch(2026, 10, 12, 11, 2, 30); // Monday, market open
  const clock = () => now;
  const gateway = new MockKiteGateway({
    now: clock,
    emulateRateLimit: false,
    limiter: new RateLimiter({ quote: 1e6, historical: 1e6, default: 1e6 }),
    ...(opts.gatewayCaps ? { caps: opts.gatewayCaps } : {}),
  });
  const db = openDb(':memory:');
  const cache = new CandleCache(db);
  const svc = new HistoryService({
    cache,
    gateway,
    caps: opts.serviceCaps ?? DEFAULT_RANGE_CAPS,
    log: silent,
    now: clock,
  });
  const universe = new Map(mockInstruments(now).map((m) => [m.instrument.key, m.instrument]));
  const inst = (key: string) => universe.get(key)!;
  return {
    svc,
    gateway,
    db,
    cache,
    inst,
    setNow: (t: number) => (now = t),
    get now() {
      return now;
    },
  };
}

const tf = (id: string) => getTimeframe(id)!;

function assertAscendingUnique(c: Candle[]) {
  for (let i = 1; i < c.length; i++) expect(c[i]!.time).toBeGreaterThan(c[i - 1]!.time);
}

/** Scrolls back until the start of history, like the chart does. */
async function scrollAll(
  s: ReturnType<typeof setup>,
  key: string,
  tfId: string,
  limit = 600,
  maxPages = 200,
) {
  const inst = s.inst(key);
  let res = await s.svc.getBefore('t', inst, tf(tfId), { limit });
  let all = res.candles;
  let pages = 1;
  while (res.hasMore && pages < maxPages) {
    res = await s.svc.getBefore('t', inst, tf(tfId), { before: all[0]!.time, limit });
    expect(res.candles.every((c) => c.time < all[0]!.time)).toBe(true);
    all = [...res.candles, ...all];
    pages++;
  }
  return { all, pages, done: !res.hasMore };
}

describe('HistoryService', () => {
  it('loads the most recent candles including the forming one, session-anchored', async () => {
    const s = setup();
    const res = await s.svc.getBefore('t', s.inst('NSE:RELIANCE'), tf('5m'), { limit: 300 });
    expect(res.candles).toHaveLength(300);
    assertAscendingUnique(res.candles);
    const last = res.candles.at(-1)!;
    // 11:02:30 is inside the 11:00 candle (09:15 + 21×5m).
    expect(last.time * 1000).toBe(istToEpoch(2026, 10, 12, 11, 0));
    for (const c of res.candles) {
      const open = sessionOpenOn('NSE', c.time * 1000) / 1000;
      expect((c.time - open) % 300).toBe(0);
    }
    expect(res.hasMore).toBe(true);
  });

  it('matches a single direct fetch of the same range exactly (no gaps or duplicates across chunks)', async () => {
    const s = setup();
    const inst = s.inst('NSE:INFY');
    const { all } = await scrollAll(s, 'NSE:INFY', '15m', 400, 6);
    const direct = await s.gateway.fetchHistory('t', {
      instrument: inst,
      interval: '15minute',
      from: all[0]!.time,
      to: Math.floor(s.now / 1000) + 1,
    });
    expect(all).toEqual(direct);
  });

  it('keeps every upstream request within the interval range cap', async () => {
    const s = setup();
    for (const id of ['1m', '3m', '15m', '1h', '1D']) {
      await scrollAll(s, 'NSE:TCS', id, 5000, 4);
    }
    expect(s.gateway.historyLog.length).toBeGreaterThan(5);
    for (const r of s.gateway.historyLog) {
      expect(r.to - r.from).toBeLessThanOrEqual(
        DEFAULT_RANGE_CAPS[r.interval as keyof RangeCaps] * DAY,
      );
    }
  });

  it('serves repeat requests from the cache (only today is refreshed, after its TTL)', async () => {
    const s = setup();
    const inst = s.inst('NSE:SBIN');
    const first = await s.svc.getBefore('t', inst, tf('1h'), { limit: 500 });
    const calls = s.gateway.calls.history;
    const again = await s.svc.getBefore('t', inst, tf('1h'), { limit: 500 });
    expect(again.candles).toEqual(first.candles);
    expect(s.gateway.calls.history).toBe(calls);

    s.setNow(s.now + 31_000);
    await s.svc.getBefore('t', inst, tf('1h'), { limit: 500 });
    expect(s.gateway.calls.history).toBe(calls + 1); // just the tail
  });

  it('stops at the listing date instead of looping, and remembers it', async () => {
    const s = setup();
    for (const id of ['1m', '5m', '1h', '1D']) {
      const { all, done, pages } = await scrollAll(s, 'NSE:NEWLISTCO', id, 2000);
      expect(done).toBe(true);
      expect(pages).toBeLessThan(40);
      assertAscendingUnique(all);
      const p = toIstParts(all[0]!.time * 1000);
      expect([p.year, p.month, p.day]).toEqual([2026, 6, 15]);
    }
    // Asking again before the start is answered from memory, without upstream calls.
    const calls = s.gateway.calls.history;
    const res = await s.svc.getBefore('t', s.inst('NSE:NEWLISTCO'), tf('5m'), {
      before: istToEpoch(2026, 6, 15) / 1000,
      limit: 500,
    });
    expect(res).toMatchObject({ candles: [], hasMore: false });
    expect(s.gateway.calls.history).toBe(calls);
  });

  it('terminates for a derivative whose contract has no older data', async () => {
    const s = setup();
    const fut = [...mockInstruments(s.now)].find(
      (m) => m.instrument.key.startsWith('NFO:NIFTY') && m.instrument.instrumentType === 'FUT',
    )!;
    const { done, all } = await scrollAll(s, fut.instrument.key, '1m', 5000);
    expect(done).toBe(true);
    expect(all.length).toBeGreaterThan(1000);
    expect(all[0]!.oi).toBeGreaterThan(0);
  });

  it('skips holidays without ending the series', async () => {
    const s = setup();
    const res = await s.svc.getBefore('t', s.inst('NSE:ITC'), tf('1D'), { limit: 60 });
    const days = res.candles
      .map((c) => toIstParts(c.time * 1000))
      .map((p) => `${p.month}-${p.day}`);
    expect(days).not.toContain('10-2'); // mock holiday
    expect(days).toContain('10-1');
    expect(days).toContain('10-5');
    expect(res.hasMore).toBe(true);
  });

  it('drops cached candles when the instrument token changes (token reuse)', async () => {
    const s = setup();
    const inst = s.inst('NSE:WIPRO');
    await s.svc.getBefore('t', inst, tf('5m'), { limit: 100 });
    const moved: Instrument = { ...inst, token: inst.token + 1 };
    // The mock refuses unknown tokens, so just check the purge + reset signal.
    await expect(s.svc.getBefore('t', moved, tf('5m'), { limit: 100 })).rejects.toThrow();
    expect(s.cache.coverage(inst.key, '5minute')).toEqual([]);
  });

  it('detects retroactively adjusted history (split) and asks the client to reset', async () => {
    const s = setup();
    const inst = s.inst('NSE:TITAN');
    await s.svc.getBefore('t', inst, tf('1D'), { limit: 100 });
    // Pretend the cached candles predate a 1:2 split.
    s.db.prepare("UPDATE candles SET c = c * 2 WHERE ikey = 'NSE:TITAN'").run();
    s.setNow(s.now + 60_000);
    const res = await s.svc.getBefore('t', inst, tf('1D'), { limit: 100 });
    expect(res.reset).toBe(true);
    const fresh = await s.svc.getBefore('t', inst, tf('1D'), { limit: 100 });
    const direct = await s.gateway.fetchHistory('t', {
      instrument: inst,
      interval: 'day',
      from: fresh.candles[0]!.time,
      to: Math.floor(s.now / 1000) + 1,
    });
    expect(fresh.candles).toEqual(direct);
  });

  it('adapts when Kite enforces a smaller range cap than configured', async () => {
    const s = setup({ gatewayCaps: { ...DEFAULT_RANGE_CAPS, minute: 20 } });
    const { all } = await scrollAll(s, 'NSE:LT', '1m', 5000, 3);
    expect(all.length).toBe(5000 * 3);
    assertAscendingUnique(all);
    for (const r of s.gateway.historyLog.slice(-5))
      expect(r.to - r.from).toBeLessThanOrEqual(20 * DAY);
  });

  it('produces identical candles when Kite forces smaller chunks (no partial candles at chunk edges)', async () => {
    const tight = setup({ gatewayCaps: { ...DEFAULT_RANGE_CAPS, '15minute': 7 } });
    const normal = setup();
    const a = await scrollAll(tight, 'NSE:HDFCBANK', '15m', 1500, 3);
    const b = await scrollAll(normal, 'NSE:HDFCBANK', '15m', 1500, 3);
    // Tight caps return fewer bars per call (bounded upstream requests); compare the overlap.
    expect(a.all.length).toBeGreaterThan(1500);
    expect(a.all).toEqual(b.all.filter((c) => c.time >= a.all[0]!.time));
  });

  it('returns candles since a time for refreshing the live edge', async () => {
    const s = setup();
    const inst = s.inst('NSE:AXISBANK');
    const full = await s.svc.getBefore('t', inst, tf('1m'), { limit: 200 });
    const since = full.candles.at(-5)!.time;
    s.setNow(s.now + 3 * 60_000);
    const res = await s.svc.getSince('t', inst, tf('1m'), since);
    expect(res.candles[0]!.time).toBe(since);
    expect(res.candles.length).toBe(5 + 3);
    expect(res.reset).toBeUndefined();
  });

  it('handles indices (no volume)', async () => {
    const s = setup();
    const res = await s.svc.getBefore('t', s.inst('NSE:NIFTY 50'), tf('1m'), { limit: 50 });
    expect(res.candles).toHaveLength(50);
    expect(res.candles.every((c) => c.volume === 0)).toBe(true);
  });
});

describe('HistoryService request economy', () => {
  it('opens a chart with a single upstream request when the cache is cold', async () => {
    const s = setup();
    for (const [key, id] of [
      ['NSE:RELIANCE', '5m'],
      ['NSE:RELIANCE', '15m'],
      ['NSE:INFY', '1h'],
      ['NSE:INFY', '1D'],
    ] as const) {
      const before = s.gateway.calls.history;
      const res = await s.svc.getBefore('t', s.inst(key), tf(id), { limit: 1000 });
      expect(res.candles).toHaveLength(1000);
      expect(s.gateway.calls.history - before).toBe(1);
    }
  });
});
