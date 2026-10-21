import { B2B_DEFAULTS, istToEpoch, runB2B, type Candle, type PaperTrade } from '@otv/shared';
import { describe, expect, it } from 'vitest';
import {
  checkPlots,
  diffCandles,
  istDay,
  logTable,
  matchApp,
  matchLogs,
  packDays,
  pineDiffScript,
  unpackDay,
  parseCandleFile,
  parseTime,
  runScript,
  SCRIPT_PLOTS,
  type PlotRow,
} from '../src/b2b/compare';

const IST = (d: number, h: number, m: number) => istToEpoch(2026, 10, d, h, m) / 1000;

/** A seeded random walk of NIFTY-like 1-minute candles, 09:15–15:29, on the given days. */
function market(days: number[], seed = 7): Candle[] {
  let x = seed;
  const rnd = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
  const out: Candle[] = [];
  let px = 25000;
  for (const d of days) {
    for (let i = 0; i < 375; i++) {
      const open = px;
      const close = Math.round((open + (rnd() - 0.5) * 12) * 20) / 20;
      const high = Math.round((Math.max(open, close) + rnd() * 4) * 20) / 20;
      const low = Math.round((Math.min(open, close) - rnd() * 4) * 20) / 20;
      out.push({ time: IST(d, 9, 15) + i * 60, open, high, low, close, volume: 0 });
      px = close;
    }
  }
  return out;
}

const run = (cs: Candle[], day = '2026-10-16') =>
  runScript(cs, { day, warmup: null, trim: false, settings: B2B_DEFAULTS, pivotTie: 'older' });

describe('parseTime', () => {
  it('reads epochs and date-times, assuming IST without a zone', () => {
    const t = IST(16, 9, 15);
    expect(parseTime(t)).toBe(t);
    expect(parseTime(String(t * 1000))).toBe(t);
    expect(parseTime('2026-10-16T03:45:00Z')).toBe(t);
    expect(parseTime('2026-10-16T09:15:00+05:30')).toBe(t);
    expect(parseTime('2026-10-16T09:15:00+0530')).toBe(t); // Kite
    expect(parseTime('2026-10-16 09:15:00')).toBe(t);
    expect(() => parseTime('yesterday')).toThrow(/Unreadable/);
  });
});

describe('parseCandleFile', () => {
  it("reads TradingView's export with the script's plot columns", () => {
    const t = IST(16, 9, 15);
    const csv = [
      `time,open,high,low,close,${Object.values(SCRIPT_PLOTS).join(',')},Volume`,
      `${t},25000,25010,24990,25005,NaN,NaN,NaN,NaN,NaN,0`,
      `${t + 60},25005,25012,25001,25010,25010,25000,25000,25025,25020,0`,
    ].join('\n');
    const f = parseCandleFile(csv);
    expect(f.format).toBe('csv with script plots');
    expect(f.candles).toHaveLength(2);
    expect(f.plots!.get(t)!.entry).toBeNull();
    expect(f.plots!.get(t + 60)).toEqual({
      entry: 25010,
      sl1: 25000,
      sl2: 25000,
      book: 25025,
      trigger: 25020,
    });
  });

  it("reads Kite's JSON, the app's export, and warns about duplicates", () => {
    const kite = JSON.stringify({
      data: {
        candles: [
          ['2026-10-16T09:16:00+0530', 2, 3, 1, 2.5, 0],
          ['2026-10-16T09:15:00+0530', 1, 2, 0.5, 1.5, 0],
          ['2026-10-16T09:16:00+0530', 2, 3, 1, 2.6, 0],
        ],
      },
    });
    const f = parseCandleFile(kite);
    expect(f.format).toBe('kite json');
    expect(f.candles.map((c) => c.close)).toEqual([1.5, 2.6]);
    expect(f.warnings.join()).toMatch(/duplicate/);
    const app = parseCandleFile(
      JSON.stringify({
        trades: [],
        candles: [{ time: IST(16, 9, 15), open: 1, high: 2, low: 0, close: 1 }],
      }),
    );
    expect(app.candles).toHaveLength(1);
  });

  it('rejects a CSV without OHLC columns', () => {
    expect(() => parseCandleFile('time,price\n1,2')).toThrow(/needs time, open/);
  });
});

describe('runScript', () => {
  it('keeps the last N bars up to the day and drops bars after 15:14 only when asked', () => {
    const cs = market([15, 16, 19]);
    const r = runScript(cs, {
      day: '2026-10-16',
      warmup: 500,
      trim: true,
      settings: B2B_DEFAULTS,
      pivotTie: 'older',
    });
    expect(r.used.every((c) => istDay(c.time) <= '2026-10-16')).toBe(true);
    // 15:15-15:29 on both days in the window.
    expect(r.dropped).toHaveLength(30);
    expect(r.used.length + r.dropped.length).toBe(500);
    expect(run(cs).dropped).toEqual([]);
  });
});

describe('candle and plot checks', () => {
  const tv = market([15, 16]);

  it('finds the first differing bar and the largest differences of the day', () => {
    const kite = tv.map((c) => ({ ...c }));
    const i = tv.findIndex((c) => c.time === IST(16, 10, 0));
    kite[i] = { ...kite[i]!, high: kite[i]!.high + 0.3, close: kite[i]!.close + 0.1 };
    kite[i + 5] = { ...kite[i + 5]!, low: kite[i + 5]!.low - 0.5 };
    kite.splice(i + 10, 1); // a bar Kite doesn't have
    const d = diffCandles(tv, kite, '2026-10-16', 0.05);
    expect(d.first).toMatchObject({ time: IST(16, 10, 0), dHigh: 0.3, dClose: 0.1 });
    expect(d.maxHigh).toMatchObject({ time: IST(16, 10, 0), dHigh: 0.3 });
    expect(d.maxLow).toMatchObject({ time: IST(16, 10, 5), dLow: -0.5 });
    expect(d.day).toHaveLength(2);
    expect(d.onlyA).toEqual([IST(16, 10, 10)]);
    expect(diffCandles(tv, tv, '2026-10-16', 0.05).first).toBeNull();
  });

  it("matches the script's plots bar by bar and reports the first mismatch", () => {
    const res = runB2B(tv, { settings: B2B_DEFAULTS });
    expect(res.plots.some((p) => p.entry !== null)).toBe(true); // the walk makes calls
    const plots = new Map<number, PlotRow>(
      res.plots.map((p) => [
        p.time,
        { entry: p.entry, sl1: p.sl1, sl2: p.sl2, book: p.book, trigger: p.trigger },
      ]),
    );
    expect(checkPlots(res, plots)).toMatchObject({
      compared: tv.length,
      mismatched: 0,
      first: null,
    });
    const t = res.plots.find((p) => p.entry !== null)!.time;
    plots.set(t, { ...plots.get(t)!, entry: null });
    expect(checkPlots(res, plots).first).toMatchObject({ time: t, key: 'entry', tv: null });
  });
});

describe('log matching', () => {
  const a = run(market([15, 16])).res.log.filter((r) => r.ent !== null);

  it('tells decisions from prices', () => {
    expect(a.length).toBeGreaterThan(2);
    const b = a.map((r) => ({ ...r }));
    b[0] = { ...b[0]!, ent: b[0]!.ent! + 0.1, tot: (b[0]!.tot ?? 0) + 0.1 };
    b[1] = { ...b[1]!, res: 'SL (both lots)', xT: '15:00' };
    b.splice(2, 1);
    const m = matchLogs(a, b);
    expect(m[0]!.kind).toBe('price');
    expect(m[1]!.kind).toBe('decision');
    expect(m[2]).toMatchObject({ kind: 'decision', why: 'only in A' });
    expect(m.slice(3).every((x) => x.kind === 'same')).toBe(true);
  });

  it('prints every row of the day, oldest first, with the totals', () => {
    const t = logTable(run(market([15, 16])).res, B2B_DEFAULTS, '2026-10-16');
    expect(t.titles[0]).toBe('In');
    expect(t.rows.length).toBe(run(market([15, 16])).res.log.length);
    expect(t.rows[0]![0]! <= t.rows.at(-1)![0]!).toBe(true);
    expect(t.totals).toMatch(/^Taken \d+ \| W \d+ \/ L \d+/);
    expect(logTable(run(market([15, 16])).res, B2B_DEFAULTS, '2026-10-19').rows).toEqual([]);
  });

  it('flags calls the live trader took or missed', () => {
    const live = (r: (typeof a)[number], over: Partial<PaperTrade> = {}): PaperTrade =>
      ({
        day: '2026-10-16',
        signalTime: IST(16, ...(r.t.split(':').map(Number) as [number, number])),
        optionName: r.opt,
        entryIndex: r.ent,
        result: r.res,
        scriptPts: r.tot,
        netRs: 100,
        notes: [],
        ...over,
      }) as PaperTrade;
    const trades = [
      live(a[0]!),
      live(a[1]!, {
        result: 'SL (both lots)',
        notes: ['call withdrawn after Kite corrected the candle'],
      }),
      { ...live(a[0]!), signalTime: IST(16, 15, 1) },
    ];
    const m = matchApp(a.slice(0, 3), trades, '2026-10-16');
    expect(m.find((x) => x.t === a[0]!.t)!.flag).toBe('');
    expect(m.find((x) => x.t === a[1]!.t)!.flag).toMatch(/RESULT DIFFERS.*notes: call withdrawn/);
    expect(m.find((x) => x.t === a[2]!.t)!.flag).toMatch(/NOT TAKEN LIVE/);
    expect(m.find((x) => x.t === '15:01')!.flag).toMatch(/LIVE ONLY/);
  });
});

describe('Pine diff script', () => {
  const cs = market([15, 16]);

  it("packs Kite's candles losslessly in ticks of 0.05", () => {
    const [p] = packDays(cs, ['2026-10-16']);
    expect(p!.bars).toBe(375);
    expect(p!.chunks.every((c) => c.length <= 1800)).toBe(true);
    const back = unpackDay(p!.base, p!.chunks);
    const day = cs.filter((c) => istDay(c.time) === '2026-10-16');
    day.forEach((c, i) =>
      expect(back.get(i)).toEqual([c.open, c.high, c.low, c.close].map((x) => Math.round(x * 20))),
    );
  });

  it('writes a script with every day and chunk, and refuses a day without candles', () => {
    const s = pineDiffScript(cs, ['2026-10-15', '2026-10-16']);
    expect(s.startsWith('//@version=6')).toBe(true);
    expect(s).toContain('options = ["2026-10-15", "2026-10-16"]');
    const chunks = packDays(cs, ['2026-10-15', '2026-10-16']).flatMap((p) => p.chunks);
    for (const c of chunks) expect(s).toContain(`"${c}"`);
    expect(() => pineDiffScript(cs, ['2026-10-17'])).toThrow(/No Kite candles/);
  });
});
