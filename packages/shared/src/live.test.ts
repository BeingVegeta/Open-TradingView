import { describe, expect, it } from 'vitest';
import { dropUnconfirmed } from './live';

const bar = (time: number) => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 0 });

describe('dropUnconfirmed', () => {
  it('drops bars inside the range that the authoritative set lacks', () => {
    // Live bars at 100..500; Kite has 100, 200 and 400 for [100, 500).
    const live = [100, 200, 300, 400, 500].map(bar);
    const kept = dropUnconfirmed(live, [bar(100), bar(200), bar(400)], { from: 100, to: 500 });
    expect(kept.map((b) => b.time)).toEqual([100, 200, 400, 500]);
  });

  it('keeps bars outside the range, even if Kite did not send them', () => {
    const live = [0, 50, 100, 600].map(bar);
    expect(dropUnconfirmed(live, [], { from: 100, to: 500 }).map((b) => b.time)).toEqual([
      0, 50, 600,
    ]);
  });
});
