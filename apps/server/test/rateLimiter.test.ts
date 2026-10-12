import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/kite/rateLimiter';
import { FakeClock, flush } from './fakeClock';

function setup(limits = { quote: 1, historical: 3, default: 10 }) {
  const clock = new FakeClock(1_000_000);
  const limiter = new RateLimiter(limits, clock);
  const starts: { cat: string; at: number; id: string }[] = [];
  const call = (
    cat: 'quote' | 'historical' | 'default',
    id: string,
    priority?: 'high' | 'low',
    signal?: AbortSignal,
  ) =>
    limiter.run(
      cat,
      async () => {
        starts.push({ cat, at: clock.now(), id });
        return id;
      },
      { ...(priority ? { priority } : {}), ...(signal ? { signal } : {}) },
    );
  return { clock, limiter, starts, call };
}

/** Max number of starts inside any window of `windowMs`. */
function maxInWindow(times: number[], windowMs: number): number {
  let max = 0;
  for (let i = 0; i < times.length; i++) {
    let n = 0;
    for (let j = i; j < times.length && times[j]! - times[i]! < windowMs; j++) n++;
    max = Math.max(max, n);
  }
  return max;
}

describe('RateLimiter', () => {
  it('starts up to the limit immediately, then spaces the rest by the window', async () => {
    const { clock, starts, call } = setup();
    const done = Array.from({ length: 7 }, (_, i) => call('historical', `h${i}`));
    await flush();
    expect(starts.map((s) => s.id)).toEqual(['h0', 'h1', 'h2']);
    await clock.advance(1049);
    expect(starts).toHaveLength(3);
    await clock.advance(1);
    expect(starts).toHaveLength(6);
    await clock.advance(1050);
    expect(await Promise.all(done)).toHaveLength(7);
    expect(
      maxInWindow(
        starts.map((s) => s.at),
        1000,
      ),
    ).toBe(3);
  });

  it('never exceeds 3 historical requests in any one-second window under a steady stream', async () => {
    const { clock, starts, call } = setup();
    const all: Promise<string>[] = [];
    for (let i = 0; i < 40; i++) {
      all.push(call('historical', `h${i}`));
      await clock.advance(137); // arrivals faster than the limit
    }
    await clock.advance(20_000);
    await Promise.all(all);
    expect(starts).toHaveLength(40);
    expect(
      maxInWindow(
        starts.map((s) => s.at),
        1000,
      ),
    ).toBeLessThanOrEqual(3);
  });

  it('keeps categories independent', async () => {
    const { starts, call } = setup();
    for (let i = 0; i < 3; i++) void call('historical', `h${i}`);
    void call('quote', 'q0');
    void call('quote', 'q1');
    for (let i = 0; i < 10; i++) void call('default', `d${i}`);
    await flush();
    expect(starts.filter((s) => s.cat === 'historical')).toHaveLength(3);
    expect(starts.filter((s) => s.cat === 'quote')).toHaveLength(1);
    expect(starts.filter((s) => s.cat === 'default')).toHaveLength(10);
  });

  it('runs high-priority work before queued low-priority work', async () => {
    const { clock, starts, call } = setup();
    for (let i = 0; i < 3; i++) void call('historical', `fill${i}`);
    void call('historical', 'prefetch1', 'low');
    void call('historical', 'prefetch2', 'low');
    void call('historical', 'chart', 'high');
    await clock.advance(1050);
    expect(starts.slice(3).map((s) => s.id)).toEqual(['chart', 'prefetch1', 'prefetch2']);
  });

  it('holds the category after a 429 back-off', async () => {
    const { clock, limiter, starts, call } = setup();
    limiter.backOff('historical', 2000);
    void call('historical', 'a');
    await clock.advance(1999);
    expect(starts).toHaveLength(0);
    await clock.advance(1);
    expect(starts).toHaveLength(1);
  });

  it('drops aborted jobs from the queue', async () => {
    const { clock, limiter, starts, call } = setup();
    for (let i = 0; i < 3; i++) void call('historical', `h${i}`);
    const ac = new AbortController();
    const aborted = call('historical', 'gone', 'high', ac.signal);
    ac.abort(new Error('user moved on'));
    await expect(aborted).rejects.toThrow('user moved on');
    expect(limiter.pending('historical')).toBe(0);
    await clock.advance(2000);
    expect(starts.map((s) => s.id)).not.toContain('gone');
  });
});
