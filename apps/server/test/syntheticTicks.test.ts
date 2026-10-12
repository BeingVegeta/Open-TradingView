import { CandleBuilder, istToEpoch, type Candle } from '@otv/shared';
import { describe, expect, it } from 'vitest';
import { MockKiteGateway } from '../src/kite/mockGateway';
import { RateLimiter } from '../src/kite/rateLimiter';
import { mockInstruments } from '../src/mock/instruments';
import { SyntheticTicks } from '../src/mock/syntheticTicks';

const now = istToEpoch(2026, 10, 12, 23, 59); // after Monday's MCX close
const universe = mockInstruments(now);
const byKey = new Map(universe.map((m) => [m.instrument.key, m]));
const ticks = new SyntheticTicks(() => new Map(universe.map((m) => [m.instrument.token, m])));
const gateway = new MockKiteGateway({
  now: () => now,
  emulateRateLimit: false,
  limiter: new RateLimiter({ quote: 1e6, historical: 1e6, default: 1e6 }),
});

/**
 * Feeds one tick per second from `fromMs` to `toMs` into a builder; returns the
 * bars starting at or after `fromMs`. Ticks start an hour early so the first
 * compared bar isn't the "joined mid-bar" one (whose volume before the first
 * tick is unknowable; the app seeds it from history instead).
 */
function build(
  key: string,
  bar: number | 'day',
  fromMs: number,
  toMs: number,
  stepS = 1,
): Candle[] {
  const m = byKey.get(key)!;
  const b = new CandleBuilder(m.instrument.exchange, bar);
  const bars: Candle[] = [];
  const warmup = bar === 'day' ? 0 : 60 * 60_000;
  for (let t = fromMs - warmup; t < toMs; t += stepS * 1000) {
    const tick = ticks.tickAt(m, 'full', t);
    if (!tick) continue;
    const r = b.apply(tick);
    if (r?.closed) bars.push(r.closed);
  }
  if (b.current) bars.push(b.current);
  return bars.filter((c) => c.time * 1000 >= fromMs);
}

async function history(
  key: string,
  interval: 'minute' | '5minute' | '60minute' | 'day',
  fromMs: number,
  toMs: number,
) {
  const inst = byKey.get(key)!.instrument;
  const oi = inst.instrumentType === 'FUT';
  return gateway.fetchHistory('t', {
    instrument: inst,
    interval,
    from: fromMs / 1000,
    to: toMs / 1000,
    ...(oi ? { oi } : {}),
  });
}

describe('synthetic ticks → candle builder reproduce the mock history', () => {
  it('1-minute bars from the pre-open through the first half hour (stock)', async () => {
    const live = build(
      'NSE:RELIANCE',
      1,
      istToEpoch(2026, 10, 12, 9, 0),
      istToEpoch(2026, 10, 12, 9, 45),
    );
    const hist = await history(
      'NSE:RELIANCE',
      'minute',
      istToEpoch(2026, 10, 12, 9, 15),
      istToEpoch(2026, 10, 12, 9, 45),
    );
    expect(live).toEqual(hist);
    // The pre-open auction is in the ticks' day volume but not in the first candle.
  });

  it('5-minute and hourly bars across the close, ignoring post-close ticks', async () => {
    const from = istToEpoch(2026, 10, 12, 13, 15);
    const to = istToEpoch(2026, 10, 12, 16, 0);
    expect(build('NSE:INFY', 5, from, to)).toEqual(await history('NSE:INFY', '5minute', from, to));
    expect(build('NSE:INFY', 60, from, to)).toEqual(
      await history('NSE:INFY', '60minute', from, to),
    );
  });

  it('index bars (no volume) and futures with OI', async () => {
    const from = istToEpoch(2026, 10, 12, 10, 0);
    const to = istToEpoch(2026, 10, 12, 10, 30);
    expect(build('NSE:NIFTY 50', 1, from, to)).toEqual(
      await history('NSE:NIFTY 50', 'minute', from, to),
    );
    const fut = universe.find(
      (m) => m.instrument.key.startsWith('NFO:NIFTY') && m.instrument.instrumentType === 'FUT',
    )!.instrument.key;
    expect(build(fut, 1, from, to)).toEqual(await history(fut, 'minute', from, to));
  });

  it('MCX evening session anchored at 09:00', async () => {
    const key = universe.find((m) => m.instrument.exchange === 'MCX')!.instrument.key;
    const from = istToEpoch(2026, 10, 12, 20, 0);
    const to = istToEpoch(2026, 10, 12, 22, 0);
    expect(build(key, 60, from, to)).toEqual(await history(key, '60minute', from, to));
  });

  it('day bar matches the daily candle', async () => {
    const live = build(
      'NSE:TCS',
      'day',
      istToEpoch(2026, 10, 12),
      istToEpoch(2026, 10, 12, 15, 30),
      1,
    );
    const [hist] = await history(
      'NSE:TCS',
      'day',
      istToEpoch(2026, 10, 12),
      istToEpoch(2026, 10, 13),
    );
    expect(live.at(-1)).toEqual(hist);
  });

  it('gives every mock instrument a unique, segment-encoded token', () => {
    const tokens = universe.map((m) => m.instrument.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const m of universe) {
      const seg = m.instrument.token & 0xff;
      if (m.instrument.segment === 'INDICES') expect(seg).toBe(9);
      if (m.instrument.exchange === 'CDS') expect(seg).toBe(3);
    }
  });
});
