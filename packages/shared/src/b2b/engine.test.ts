import { describe, expect, it } from 'vitest';
import type { Candle } from '../market';
import { istToEpoch } from '../time';
import { ceStrike, dropClosingPrints, fmt, peStrike, rsFmt, runB2B, sgn } from './engine';
import { B2B_DEFAULTS, sanitizeB2BSettings, type B2BSettings } from './settings';
import { b2bLogView, b2bStatusView, isNiftySymbol } from './view';

const T0 = istToEpoch(2026, 10, 12, 9, 15) / 1000; // Monday
type Row = [open: number, high: number, low: number, close: number];

/** 1-minute candles from 09:15 (or `start`), one per row. */
function bars(rows: Row[], start = T0): Candle[] {
  return rows.map(([o, h, l, c], i) => ({
    time: start + i * 60,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 0,
  }));
}

/** A straight move between closes, each candle opening at the previous close. */
function ramp(from: number, to: number, n: number, firstOpen: number): Row[] {
  const out: Row[] = [];
  let o = firstOpen;
  for (let i = 0; i < n; i++) {
    const c = from + ((to - from) * i) / Math.max(1, n - 1);
    out.push([o, Math.max(o, c) + 0.5, Math.min(o, c) - 0.5, c]);
    o = c;
  }
  return out;
}

/**
 * 09:15–09:44: up to a swing high (25018, high 25018.5) at 09:24, down to a
 * trough at 09:34 (the last red candle, 24997.5–25000.5, becomes the block),
 * then up; the 09:45 close of 25020 breaks the swing high. Entry: long 25020,
 * both stops 25010.
 */
function setup(): Row[] {
  return [
    ...ramp(25000, 25018, 10, 25000), // 0..9
    ...ramp(25016, 24998, 10, 25018), // 10..19 (red candles)
    ...ramp(25000, 25018, 10, 24998), // 20..29
    [25018, 25020.5, 25017.5, 25020], // 30: 09:45, close > 25018.5
  ];
}
const ENTRY_BAR = 30;

const run = (rows: Row[], settings: Partial<B2BSettings> = {}, formingIndex = -1) =>
  runB2B(bars(rows), { settings: { ...B2B_DEFAULTS, ...settings }, formingIndex });

const lines = (r: ReturnType<typeof run>) => r.alerts.flatMap((a) => a.lines);

describe('N-B2B v1.8 engine', () => {
  it('opens 2 lots on a new bull block at the close of the candle that makes it', () => {
    const r = run(setup());
    expect(r.state.lastBlk).toBe('BULL 24997.5-25000.5');
    expect(r.state.lastBlkT).toBe('09:45');
    expect(r.bull).toEqual([
      {
        kind: 'bullBlock',
        top: 25000.5,
        bot: 24997.5,
        leftTime: T0 + 19 * 60,
      },
    ]);
    expect(r.state).toMatchObject({
      pos: 1,
      ent: 25020,
      sl1: 25010,
      sl2: 25010,
      optNm: '25000 CE',
    });
    expect(r.log).toEqual([
      expect.objectContaining({
        t: '09:45',
        opt: '25000 CE',
        dir: 1,
        ent: 25020,
        sl: 25010,
        res: 'OPEN',
      }),
    ]);
    expect(lines(r)).toEqual([
      'CALL|09:45|BUY 2 lots NIFTY 25000 CE|from block|spot 25020|SL 25010|risk 20 index pts|Rs/2 lots 1300',
    ]);
    expect(r.labels.at(-1)).toMatchObject({
      text: 'BUY 2 x NIFTY 25000 CE\n@ 25020  SL 25010',
      below: true,
      color: 'teal',
      price: 25017.5,
    });
    expect(r.plots[ENTRY_BAR]).toEqual({
      time: T0 + ENTRY_BAR * 60,
      entry: 25020,
      sl1: 25010,
      sl2: 25010,
      protectedStops: false,
      book: 25035,
      trigger: 25030,
    });
  });

  it('at +10 moves lot 1 to +10 and lot 2 to cost, books lot 1 at +15, lot 2 out at cost', () => {
    const r = run([
      ...setup(),
      [25020, 25026, 25019, 25025], // 09:46 peak +6
      [25025, 25032, 25024, 25031], // 09:47 peak +12: stops move
      [25031, 25036, 25030.5, 25034], // 09:48 lot 1 booked at +15
      [25034, 25034.5, 25019, 25022], // 09:49 lot 2 stopped at cost
    ]);
    expect(lines(r).slice(1)).toEqual([
      'SLMOVE|09:47|NIFTY 25000 CE|lot 1 stop 25030 (+10)|peak +12',
      'SLMOVE|09:47|NIFTY 25000 CE|lot 2 stop 25020 (cost)|peak +12',
      'LOT1|09:48|NIFTY 25000 CE|booked +15|Rs 975',
      'EXIT|09:49|NIFTY 25000 CE|L1 +15 / L2 COST|L1 15|L2 0|trade 15|Rs 975|peak +16',
    ]);
    expect(r.log[0]).toMatchObject({
      l1T: '09:48',
      l1P: 15,
      xT: '09:49',
      ex: 25020,
      res: 'L1 +15 / L2 COST',
      tot: 15,
      pk: 16,
      cur: 25020,
    });
    expect(r.state).toMatchObject({ pos: 0, dTr: 1, dWin: 1, dLoss: 0, dPts: 15, dRs: 975 });
    expect(r.plots[ENTRY_BAR + 2]).toMatchObject({
      protectedStops: true,
      sl1: 25030,
      trigger: null,
    });
    expect(r.labels.map((l) => l.text)).toEqual([
      'BUY 2 x NIFTY 25000 CE\n@ 25020  SL 25010',
      'LOT 1 +15',
      'L1 +15 / L2 COST\nTrade +15  Rs 975  (peak +16)',
    ]);
  });

  it('stops both lots at -10 each', () => {
    const r = run([...setup(), [25020, 25021, 25009, 25012]]);
    expect(r.log[0]).toMatchObject({ res: 'SL (both lots)', tot: -20, l1P: -10 });
    expect(lines(r).slice(1)).toEqual([
      'LOT1|09:46|NIFTY 25000 CE|lot 1 out -10|Rs -650',
      'EXIT|09:46|NIFTY 25000 CE|SL (both lots)|L1 -10|L2 -10|trade -20|Rs -1300|peak +0',
    ]);
    expect(r.state).toMatchObject({ dLoss: 1, dRs: -1300 });
    expect(rsFmt(r.state.dRs)).toBe('-1,300');
  });

  it('closes on the first opposite block and reverses on the same candle', () => {
    // A wide stop so the drop below the 24997.5 swing low makes a bear block first.
    const r = run([...setup(), [25020, 25021, 24994, 24995]], { initSL: 40 });
    expect(r.state.lastBlk).toBe('BEAR 25017.5-25020.5');
    expect(r.log.map((l) => [l.t, l.opt, l.res, l.tot])).toEqual([
      ['09:45', '25000 CE', 'L1 BEAR BLOCK / L2 BEAR BLOCK', -50],
      ['09:46', '25000 PE', 'OPEN', null],
    ]);
    expect(r.state).toMatchObject({ pos: -1, ent: 24995, sl1: 25035 });
    expect(r.alerts.at(-1)!.lines.map((l) => l.split('|')[0])).toEqual(['EXIT', 'CALL']);
  });

  it('gives back lot 2 once lot 1 is out and the peak reached +40', () => {
    const r = run([
      ...setup(),
      [25020, 25036, 25019, 25033], // book lot 1; lot 2 to cost
      [25033, 25070, 25032, 25068], // peak +50: giveback stop at +42.5
      [25068, 25069, 25060, 25061], // stopped at +42.5
    ]);
    expect(lines(r)).toContain(
      'SLMOVE|09:47|NIFTY 25000 CE|lot 2 giveback stop 25062.5 (+42.5)|peak +50',
    );
    expect(r.log[0]).toMatchObject({ res: 'L1 +15 / L2 GIVEBACK +42.5', tot: 57.5, pk: 50 });
  });

  it('squares off at the close of the square-off candle', () => {
    const r = run([...setup(), [25020, 25024, 25018, 25023]], { sqOff: 947 });
    expect(r.log[0]).toMatchObject({ res: 'L1 EOD / L2 EOD', tot: 6, xT: '09:46' });
  });

  it('takes no new entries outside the entry window', () => {
    const r = run(setup(), { entFrom: 950 });
    expect(r.state.pos).toBe(0);
    expect(r.state.lastBlk).toBe('BULL 24997.5-25000.5');
  });

  it('turns a broken block into an opposite breaker and a grey ghost', () => {
    const r = run(
      [
        ...setup(),
        [25020, 25021, 24990, 24992], // new bear block (below the swing low)
        [24992, 24993, 24985, 24986], // 2nd close below the bull block: broken
      ],
      { entFrom: 1530, entTo: 1530 },
    );
    expect(r.ghosts).toEqual([
      expect.objectContaining({ text: 'broken BULL BLOCK', top: 25000.5, bot: 24997.5 }),
    ]);
    expect(r.bull).toEqual([]);
    expect(r.bear.map((z) => [z.kind, z.bot, z.top])).toEqual([
      ['bearBlock', 25017.5, 25020.5],
      ['bearBreaker', 24997.5, 25000.5],
    ]);
    expect(r.state.lastBlk).toBe('BEAR BRK 24997.5-25000.5');
  });

  it('enters on a retest in retest mode, and logs a SKIP when none comes', () => {
    const retest = run(
      [
        ...setup(),
        [25020, 25021, 25010, 25012],
        [25012, 25013, 25000, 25004], // touches but red
        [25004, 25008, 24999, 25006], // green close above the block: entry
      ],
      { entryMode: 'retest' },
    );
    expect(retest.log[0]).toMatchObject({ t: '09:48', ent: 25006, res: 'OPEN' });
    expect(retest.labels.at(-1)!.text).toContain('(block retest)');

    const skip = run(
      [
        ...setup(),
        [25020, 25025, 25019, 25024],
        [25024, 25026, 25022, 25025],
        [25025, 25027, 25023, 25026],
        [25026, 25028, 25024, 25027],
      ],
      { entryMode: 'retest', pendMax: 3 },
    );
    expect(skip.log).toEqual([
      expect.objectContaining({ t: '09:49', opt: '25000 CE', res: 'SKIP: no retest', ent: null }),
    ]);
    expect(skip.state.dSkip).toBe(1);
  });

  it('resets the log and day at a new session, closing a trade left open', () => {
    const day1 = [...setup(), [25020, 25024, 25018, 25023] as Row];
    const candles = [
      ...bars(day1),
      ...bars([[25030, 25031, 25029, 25030]], istToEpoch(2026, 10, 13, 9, 15) / 1000),
    ];
    const r = runB2B(candles, { settings: B2B_DEFAULTS });
    expect(r.log).toEqual([]);
    expect(r.state).toMatchObject({ pos: 0, dTr: 0 });
    expect(lines(r).at(-1)).toBe(
      'EXIT|prev day|NIFTY 25000 CE|EOD (missed square-off)|trade 6|Rs 390',
    );
  });

  it('previews a forming bar without trading on it', () => {
    const r = run(setup(), {}, ENTRY_BAR);
    expect(r.previewed).toBe(true);
    expect(r.state.pos).toBe(0); // the breakout candle hasn't closed yet
    expect(r.alerts).toEqual([]);
  });

  it('maps strikes and formats like the script', () => {
    expect(ceStrike(25020, 100)).toBe(25000);
    expect(ceStrike(25000, 100)).toBe(24900);
    expect(peStrike(24995, 100)).toBe(25000);
    expect(peStrike(25000, 100)).toBe(25100);
    expect(fmt(25000.5)).toBe('25000.5');
    expect(fmt(1 / 3)).toBe('0.33');
    expect(sgn(0)).toBe('+0');
    expect(rsFmt(12345.6)).toBe('12,346');
  });

  it('measures in estimated premium points when asked', () => {
    const r = run([...setup(), [25020, 25021, 25004, 25005]], { measure: 'premium', deltaF: 0.5 });
    // A 10-point premium stop is 20 index points away at delta 0.5.
    expect(r.log[0]).toMatchObject({ sl: 25000, res: 'OPEN' });
  });
});

describe('closing prints', () => {
  /** One day's candles from `hh:mm` with the given closes. */
  const day = (d: number, hh: number, mm: number, closes: number[]) =>
    closes.map((c, i) => ({
      time: istToEpoch(2026, 10, d, hh, mm + i) / 1000,
      open: c,
      high: c,
      low: c,
      close: c,
      volume: 0,
    }));
  const times = (cs: readonly Candle[]) =>
    cs.map((c) => new Date(c.time * 1000 + 19_800_000).toISOString().slice(8, 16));

  it("drops a finished day's jump to the official close", () => {
    // 16-Oct: trading to 15:27, then 15:28 and 15:29 on the official close.
    const fri = day(16, 15, 25, [23120, 23121, 23122, 23146.15, 23146.15]);
    const mon = day(19, 9, 15, [23100]);
    expect(times(dropClosingPrints([...fri, ...mon]))).toEqual([
      '16T15:25',
      '16T15:26',
      '16T15:27',
      '19T09:15',
    ]);
  });

  it('keeps a flat close before 15:20 and leaves the current day alone', () => {
    const thu = day(15, 15, 18, [22990, 22990, 22990]); // 15:18-15:20 all equal
    const fri = day(16, 15, 27, [23122, 23146.15, 23146.15]);
    const out = dropClosingPrints([...thu, ...fri]);
    expect(times(out)).toEqual(['15T15:18', '15T15:19', '16T15:27', '16T15:28', '16T15:29']);
    const plain = day(16, 9, 15, [1, 2, 3]);
    expect(dropClosingPrints(plain)).toBe(plain);
  });
});

describe('B2B settings', () => {
  it('keeps valid values and falls back for the rest', () => {
    const s = sanitizeB2BSettings({ initSL: 12, swLen: 99, entryMode: 'hybrid', useGive: 'yes' });
    expect(s).toMatchObject({ initSL: 12, swLen: 20, entryMode: 'hybrid', useGive: true });
    expect(sanitizeB2BSettings(null)).toEqual(B2B_DEFAULTS);
  });
});

describe('B2B dashboard tables', () => {
  const flags = { is1m: true, isNifty: true };

  it('shows the open trade with live P&L from the forming candle', () => {
    const r = run([...setup(), [25020, 25026, 25019, 25025]]);
    const live = { time: T0 + 32 * 60, close: 25027 };
    const s = b2bStatusView(r, B2B_DEFAULTS, live, flags);
    expect(s.rowTone).toBe('win');
    expect(s.row.map((c) => c.text)).toEqual([
      'NIFTY 25000 CE',
      '25027',
      'BUY CE',
      'BULL 24997.5-25000.5  09:45',
      'LIVE @25020  +7',
      '+6',
      '25010',
      'L1 25010 | L2 25010 | st 0 initial -10',
      'open, book at 25035',
      'open',
      // Exit if a bear block forms, or the newest bull zone breaks (bottom − 0.25 × ATR).
      `BEAR block / breaker (< ${fmt(24997.5 - r.invBuf!)})`,
      '1,300',
    ]);
    const log = b2bLogView(r, B2B_DEFAULTS, live);
    expect(log.header.map((c) => c.text)).toEqual([
      'CALL LOG 12-Oct',
      'Taken 1',
      'W 0 / L 0',
      'Open 1',
      'Net pts 0',
      'Net Rs 0',
      'Skipped 0',
    ]);
    expect(log.rows[0]!.cells.map((c) => c.text)).toEqual([
      '09:45',
      'NIFTY 25000 CE',
      'BUY CE',
      '25020',
      '25010',
      '25010',
      '+6',
      '',
      '',
      '',
      '',
      'OPEN (2 lots)',
      '+14 / 910',
    ]);
  });

  it('flat outside hours, and warns off a non-NIFTY or non-1m chart', () => {
    const r = run(setup(), { entFrom: 950 });
    const s = b2bStatusView(
      r,
      B2B_DEFAULTS,
      { time: T0 + 400 * 60, close: 25020 },
      {
        is1m: false,
        isNifty: false,
      },
    );
    expect(s.row[4]).toEqual({ text: 'OUT OF HRS', tone: 'warn' });
    expect(s.header[6]!.text).toBe('USE 1m CHART! NOT A NIFTY CHART');
  });

  it("clears to the new day's empty log as soon as the next day's first candle forms", () => {
    const r = run([...setup(), [25020, 25026, 25019, 25025]]);
    const live = { time: istToEpoch(2026, 10, 13, 9, 15) / 1000, close: 25100 };
    expect(b2bLogView(r, B2B_DEFAULTS, live).empty).toMatch(/No calls yet today/);
    expect(b2bStatusView(r, B2B_DEFAULTS, live, flags).row[0]!.text).toBe('-');
  });

  it('recognises NIFTY charts like the script', () => {
    expect(
      ['NIFTY 50', 'NIFTY26OCTFUT', 'NIFTY BANK', 'FINNIFTY26OCTFUT', 'NIFTY MIDCAP 100'].map(
        isNiftySymbol,
      ),
    ).toEqual([true, true, false, false, false]);
  });
});
