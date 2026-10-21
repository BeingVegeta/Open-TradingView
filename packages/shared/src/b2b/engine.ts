import type { Candle } from '../market';
import { istStartOfDay, toIstParts } from '../time';
import type { B2BSettings } from './settings';

/*
 * A bar-by-bar port of the TradingView indicator "Nifty 2-Lot Block-to-Block
 * v1.8" (Varun's simple rules), for the NIFTY 1-minute chart.
 *
 * It follows the script's order of operations on every bar: new-day resets,
 * pivots, new blocks, block survival and breakers, trade management (stops,
 * opposite block / end of day, peak, lot 1 booking, the +10 step, giveback,
 * finish), then entries. Like the script with `barstate.isconfirmed`, trades
 * and zones change only on closed bars; the still-forming bar can be run as a
 * preview (ok = false), which only does what the script does on unconfirmed
 * bars (new-day resets, trimming, extending boxes).
 */

export type ZoneKind = 'bullBlock' | 'bearBlock' | 'bullBreaker' | 'bearBreaker';

export interface B2BZone {
  kind: ZoneKind;
  top: number;
  bot: number;
  /** Time of the box's left edge (the block candle, or the bar a breaker formed on). */
  leftTime: number;
}

export interface B2BGhost {
  top: number;
  bot: number;
  leftTime: number;
  /** The bar the zone broke on. */
  rightTime: number;
  text: string;
}

export type B2BLabelColor = 'teal' | 'maroon' | 'olive' | 'green' | 'red';

export interface B2BLabel {
  time: number;
  price: number;
  text: string;
  /** Pine's label.style_label_up: the label sits below the price, pointing up. */
  below: boolean;
  color: B2BLabelColor;
}

/** Values the script plots at the end of a bar (null = not drawn on that bar). */
export interface B2BPlot {
  time: number;
  entry: number | null;
  sl1: number | null;
  sl2: number | null;
  /** Stage ≥ 1: the stop lines turn from red to lime (lot 1) and aqua (lot 2). */
  protectedStops: boolean;
  book: number | null;
  trigger: number | null;
}

export interface B2BLogRow {
  t: string;
  opt: string;
  dir: 1 | -1;
  ent: number | null;
  sl: number | null;
  /** Lot 2's current stop. */
  cur: number | null;
  pk: number | null;
  l1T: string;
  l1P: number | null;
  xT: string;
  ex: number | null;
  res: string;
  tot: number | null;
}

/** One alert() message (lines of the script's alert text), with its bar. */
export interface B2BAlert {
  time: number;
  lines: string[];
}

/** A swing point found by the script's pivot test (`ta.pivothigh/pivotlow(swLen, swLen)`). */
export interface B2BPivot {
  kind: 'high' | 'low';
  /** Open time of the pivot bar, and of the bar that confirmed it (swLen bars later). */
  time: number;
  confirmedAt: number;
  price: number;
}

/**
 * Which of two equal highs (or lows) inside the pivot window becomes the pivot.
 * 'newer' (Pine's behaviour, confirmed on TradingView with
 * docs/pine/pivot_tie_test.pine on 21-Oct-2026): the left side may tie and the
 * right side must be strictly lower (higher for lows). 'older' is this port's
 * original, wrong reading, kept for parity diagnostics. See docs/B2B_PARITY.md.
 */
export type PivotTie = 'older' | 'newer';

/**
 * Changes whenever the engine's behaviour changes for the same settings, so
 * paper trades made by different engine versions can be told apart.
 * 2: swing-point ties go to the newer bar, as in Pine.
 */
export const B2B_ENGINE_REV = 2;

export interface B2BState {
  pos: 0 | 1 | -1;
  ent: number;
  sl1: number;
  sl2: number;
  sl0: number;
  l1Open: boolean;
  l2Open: boolean;
  l1P: number;
  l2P: number;
  l1Tag: string;
  l2Tag: string;
  l2Px: number | null;
  pkPts: number;
  stage: number;
  optNm: string;
  li: number;
  pend: 0 | 1 | -1;
  pT: number;
  pB: number;
  pBar: number;
  pDist: number | null;
  pSrc: string;
  dTr: number;
  dWin: number;
  dLoss: number;
  dSkip: number;
  dPts: number;
  dRs: number;
  lastBlk: string;
  lastBlkT: string;
}

export interface B2BResult {
  /** Live zones, oldest first. */
  bull: B2BZone[];
  bear: B2BZone[];
  ghosts: B2BGhost[];
  labels: B2BLabel[];
  plots: B2BPlot[];
  /** Today's call log, oldest first. */
  log: B2BLogRow[];
  alerts: B2BAlert[];
  state: B2BState;
  /** Last bar processed (the forming bar when previewed), its close and ATR. */
  lastTime: number | null;
  close: number | null;
  invBuf: number | null;
  /** Bars processed, and whether the last one was only previewed. */
  bars: number;
  previewed: boolean;
  /** Every swing point found, oldest first (diagnostics). */
  pivots: B2BPivot[];
}

interface ZoneRec {
  kind: ZoneKind;
  top: number;
  bot: number;
  left: number;
  brk: boolean;
  out: number;
}

interface GhostRec {
  top: number;
  bot: number;
  left: number;
  right: number;
  text: string;
}

interface LabelRec {
  bar: number;
  price: number;
  text: string;
  below: boolean;
  color: B2BLabelColor;
}

const MAX_LABELS = 300;

// ------------------------------ formatting ------------------------------

/** Pine `str.tostring(v, "#.##")`. */
export function fmt(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}
/** `(v >= 0 ? "+" : "") + fmt(v)`. */
export function sgn(v: number): string {
  return (v >= 0 ? '+' : '') + fmt(v);
}
/** Pine `str.tostring(v, "#,###")`. */
export function rsFmt(v: number): string {
  const r = Math.round(v);
  return (Object.is(r, -0) ? 0 : r).toLocaleString('en-US');
}
/** Pine `str.tostring(v, "#")`. */
export function intFmt(v: number): string {
  const r = Math.round(v);
  return String(Object.is(r, -0) ? 0 : r);
}

const l1TagOf = (p: number) => (p < -0.01 ? 'SL' : p <= 0.01 ? 'COST' : sgn(p));
const l2TagOf = (p: number) => (p < -0.01 ? 'SL' : p <= 0.01 ? 'COST' : 'STOP ' + sgn(p));

/** In-the-money call strike: the round figure strictly below spot. */
export function ceStrike(spot: number, step: number): number {
  let b = Math.floor(spot / step) * step;
  if (b >= spot) b -= step;
  return b;
}
/** In-the-money put strike: the round figure strictly above spot. */
export function peStrike(spot: number, step: number): number {
  let b = Math.ceil(spot / step) * step;
  if (b <= spot) b += step;
  return b;
}

const hhmmOf = (epochS: number) => {
  const p = toIstParts(epochS * 1000);
  return p.hour * 100 + p.minute;
};
const timeStr = (epochS: number) => {
  const p = toIstParts(epochS * 1000);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

export interface B2BOptions {
  settings: B2BSettings;
  /**
   * Index of a still-forming last bar, processed as a preview (Pine's
   * unconfirmed realtime bar), or -1 if every bar is closed.
   */
  formingIndex?: number;
  /** Bar length in seconds (60 on the 1-minute chart). */
  barSeconds?: number;
  /** Tie rule for swing highs and lows (default 'newer', as Pine). */
  pivotTie?: PivotTie;
}

/** Runs the script over candles (oldest first). */
export function runB2B(candles: readonly Candle[], opts: B2BOptions): B2BResult {
  const S = opts.settings;
  const barS = opts.barSeconds ?? 60;
  const forming = opts.formingIndex ?? -1;
  const newerTie = opts.pivotTie !== 'older';
  const pivots: B2BPivot[] = [];
  const m = S.measure === 'points' ? 1 : S.deltaF;
  const mName = S.measure === 'points' ? 'index pts' : 'premium pts (est.)';

  // ---- series state ----
  let trSeed = 0;
  let trCount = 0;
  let atr: number | null = null;
  let sHigh: number | null = null;
  let sLow: number | null = null;
  let armUp = false;
  let armDn = false;

  const bull: ZoneRec[] = [];
  const bear: ZoneRec[] = [];
  let ghosts: GhostRec[] = [];
  const labels: LabelRec[] = [];
  let log: B2BLogRow[] = [];
  const plots: B2BPlot[] = [];
  const alerts: B2BAlert[] = [];

  const st: B2BState = {
    pos: 0,
    ent: NaN,
    sl1: NaN,
    sl2: NaN,
    sl0: NaN,
    l1Open: false,
    l2Open: false,
    l1P: 0,
    l2P: 0,
    l1Tag: '',
    l2Tag: '',
    l2Px: null,
    pkPts: 0,
    stage: 0,
    optNm: '',
    li: -1,
    pend: 0,
    pT: NaN,
    pB: NaN,
    pBar: NaN,
    pDist: null,
    pSrc: '',
    dTr: 0,
    dWin: 0,
    dLoss: 0,
    dSkip: 0,
    dPts: 0,
    dRs: 0,
    lastBlk: '-',
    lastBlkT: '',
  };

  const label = (l: LabelRec) => {
    labels.push(l);
    if (labels.length > MAX_LABELS) labels.shift();
  };
  const logPush = (
    t: string,
    opt: string,
    dir: 1 | -1,
    en: number | null,
    sl: number | null,
    res: string,
  ) => {
    log.push({
      t,
      opt,
      dir,
      ent: en,
      sl,
      cur: sl,
      pk: null,
      l1T: '',
      l1P: null,
      xT: '',
      ex: null,
      res,
      tot: null,
    });
    return log.length - 1;
  };
  const row = () => (st.li >= 0 && st.li < log.length ? log[st.li]! : null);

  let lastTime: number | null = null;
  let lastClose: number | null = null;
  let lastInvBuf: number | null = null;
  let previewed = false;

  for (let bi = 0; bi < candles.length; bi++) {
    // The forming bar (always the last one) is a preview: like an unconfirmed
    // bar in Pine it only runs the code the script doesn't gate on isconfirmed.
    const ok = bi !== forming;
    if (!ok) previewed = true;
    const c = candles[bi]!;
    const prev = bi > 0 ? candles[bi - 1]! : null;
    const close = c.close;
    const high = c.high;
    const low = c.low;
    const open = c.open;
    const at = (i: number) => candles[bi - i]!;

    const newDay =
      prev !== null && istStartOfDay(c.time * 1000) !== istStartOfDay(prev.time * 1000);
    const tStr = timeStr(c.time);
    const hhmm = hhmmOf(c.time);
    const inWin = hhmm >= S.entFrom && hhmm <= S.entTo;
    const hhmmC = hhmmOf(c.time + barS);
    const isEod = hhmmC >= S.sqOff;

    // ta.atr: RMA of the true range, seeded with the SMA of the first `atrLen`.
    const tr = prev
      ? Math.max(high - low, Math.abs(high - prev.close), Math.abs(low - prev.close))
      : high - low;
    if (atr === null) {
      trSeed += tr;
      trCount++;
      if (trCount >= S.atrLen) atr = trSeed / S.atrLen;
    } else {
      atr = (tr + (S.atrLen - 1) * atr) / S.atrLen;
    }
    const invBuf = atr === null ? null : atr * S.invBufA;

    if (S.ghostDay && newDay) ghosts = [];

    const addGhost = (z: ZoneRec, text: string) => {
      if (!S.showGhost) return;
      ghosts.push({ top: z.top, bot: z.bot, left: z.left, right: bi, text });
      while (ghosts.length > S.ghostKeep) ghosts.shift();
    };

    // ------------------------------ structure ------------------------------
    const L = S.swLen;
    if (bi >= 2 * L) {
      const cIdx = bi - L;
      const ch = candles[cIdx]!.high;
      const cl = candles[cIdx]!.low;
      let isPh = true;
      let isPl = true;
      for (let k = 1; k <= L; k++) {
        const left = candles[cIdx - k]!;
        const right = candles[cIdx + k]!;
        if (newerTie) {
          // Left side may tie, right side strictly lower (higher for lows).
          if (left.high > ch || right.high >= ch) isPh = false;
          if (left.low < cl || right.low <= cl) isPl = false;
        } else {
          // Left side strictly lower (higher for lows), right side may tie.
          if (left.high >= ch || right.high > ch) isPh = false;
          if (left.low <= cl || right.low < cl) isPl = false;
        }
      }
      const pt = candles[cIdx]!.time;
      if (isPh) {
        sHigh = ch;
        armUp = true;
        pivots.push({ kind: 'high', time: pt, confirmedAt: c.time, price: ch });
      }
      if (isPl) {
        sLow = cl;
        armDn = true;
        pivots.push({ kind: 'low', time: pt, confirmedAt: c.time, price: cl });
      }
    }

    let newBull = false;
    let newBear = false;
    let brkBull = false;
    let brkBear = false;
    let nbT = NaN;
    let nbB = NaN;
    let nsT = NaN;
    let nsB = NaN;

    if (ok && armUp && sHigh !== null && close > sHigh) {
      armUp = false;
      let idx = -1;
      for (let i = 1; i <= Math.min(S.obScan, bi - 1); i++) {
        if (at(i).close < at(i).open) {
          idx = i;
          break;
        }
      }
      if (idx > 0) {
        newBull = true;
        nbT = Math.max(at(idx).high, at(idx).open);
        nbB = at(idx).low;
        bull.push({ kind: 'bullBlock', top: nbT, bot: nbB, left: bi - idx, brk: false, out: 0 });
        st.lastBlk = 'BULL ' + fmt(nbB) + '-' + fmt(nbT);
        st.lastBlkT = tStr;
      }
    }
    if (ok && armDn && sLow !== null && close < sLow) {
      armDn = false;
      let idx2 = -1;
      for (let i = 1; i <= Math.min(S.obScan, bi - 1); i++) {
        if (at(i).close > at(i).open) {
          idx2 = i;
          break;
        }
      }
      if (idx2 > 0) {
        newBear = true;
        nsT = at(idx2).high;
        nsB = Math.min(at(idx2).low, at(idx2).open);
        bear.push({ kind: 'bearBlock', top: nsT, bot: nsB, left: bi - idx2, brk: false, out: 0 });
        st.lastBlk = 'BEAR ' + fmt(nsB) + '-' + fmt(nsT);
        st.lastBlkT = tStr;
      }
    }

    // ------------------- survival / break / breaker -------------------
    if (ok && bull.length > 0) {
      for (let i = bull.length - 1; i >= 0; i--) {
        const z = bull[i]!;
        z.out = invBuf !== null && close < z.bot - invBuf ? z.out + 1 : 0;
        if (z.out >= S.invCloses) {
          addGhost(z, z.brk ? 'broken BREAKER' : 'broken BULL BLOCK');
          bull.splice(i, 1);
          if (S.useBrk && !z.brk) {
            bear.push({ kind: 'bearBreaker', top: z.top, bot: z.bot, left: bi, brk: true, out: 0 });
            brkBear = true;
            if (!newBear) {
              nsT = z.top;
              nsB = z.bot;
            }
            st.lastBlk = 'BEAR BRK ' + fmt(z.bot) + '-' + fmt(z.top);
            st.lastBlkT = tStr;
          }
        }
      }
    }
    if (ok && bear.length > 0) {
      for (let i = bear.length - 1; i >= 0; i--) {
        const z = bear[i]!;
        z.out = invBuf !== null && close > z.top + invBuf ? z.out + 1 : 0;
        if (z.out >= S.invCloses) {
          addGhost(z, z.brk ? 'broken BREAKER' : 'broken BEAR BLOCK');
          bear.splice(i, 1);
          if (S.useBrk && !z.brk) {
            bull.push({ kind: 'bullBreaker', top: z.top, bot: z.bot, left: bi, brk: true, out: 0 });
            brkBull = true;
            if (!newBull) {
              nbT = z.top;
              nbB = z.bot;
            }
            st.lastBlk = 'BULL BRK ' + fmt(z.bot) + '-' + fmt(z.top);
            st.lastBlkT = tStr;
          }
        }
      }
    }
    while (bull.length > S.obKeep) bull.shift();
    while (bear.length > S.obKeep) bear.shift();

    const oppBear = newBear || brkBear;
    const oppBull = newBull || brkBull;
    const entBear = newBear || (brkBear && S.brkEntry);
    const entBull = newBull || (brkBull && S.brkEntry);

    const evt: string[] = [];

    // ------------------------- new-day resets -------------------------
    if (newDay && st.pos !== 0 && prev) {
      const pnl = st.pos === 1 ? (prev.close - st.ent) * m : (st.ent - prev.close) * m;
      const p1N = st.l1Open ? pnl : st.l1P;
      const p2N = st.l2Open ? pnl : st.l2P;
      const totN = p1N + p2N;
      if (ok)
        alerts.push({
          time: c.time,
          lines: [
            `EXIT|prev day|NIFTY ${st.optNm}|EOD (missed square-off)|trade ${fmt(totN)}|Rs ${intFmt(totN * S.lotSz)}`,
          ],
        });
      st.pos = 0;
      st.l1Open = false;
      st.l2Open = false;
    }
    if (newDay) {
      log = [];
      st.li = -1;
      st.pos = 0;
      st.pend = 0;
      st.dTr = 0;
      st.dWin = 0;
      st.dLoss = 0;
      st.dSkip = 0;
      st.dPts = 0;
      st.dRs = 0;
    }

    // ------------------------ manage open trade ------------------------
    if (ok && st.pos !== 0) {
      const pos = st.pos;
      const bookPx = pos === 1 ? st.ent + S.bookPts / m : st.ent - S.bookPts / m;
      let stopHit = false;

      // 1) stops, at the levels valid coming into this bar
      if (st.l1Open && (pos === 1 ? low <= st.sl1 : high >= st.sl1)) {
        const pS1 = pos === 1 ? (st.sl1 - st.ent) * m : (st.ent - st.sl1) * m;
        st.l1Open = false;
        st.l1P = pS1;
        st.l1Tag = l1TagOf(pS1);
        stopHit = true;
        const r = row();
        if (r) {
          r.l1T = tStr;
          r.l1P = pS1;
        }
        evt.push(
          `LOT1|${tStr}|NIFTY ${st.optNm}|lot 1 out ${sgn(pS1)}|Rs ${intFmt(pS1 * S.lotSz)}`,
        );
      }
      if (st.l2Open && (pos === 1 ? low <= st.sl2 : high >= st.sl2)) {
        const pS2 = pos === 1 ? (st.sl2 - st.ent) * m : (st.ent - st.sl2) * m;
        st.l2Open = false;
        st.l2P = pS2;
        st.l2Tag = st.stage === 3 && pS2 > 0.01 ? 'GIVEBACK ' + sgn(pS2) : l2TagOf(pS2);
        st.l2Px = st.sl2;
        stopHit = true;
      }

      // 2) opposite block / breaker, or end of day, closes what is still open
      const oppNow = pos === 1 ? oppBear : oppBull;
      if ((st.l1Open || st.l2Open) && (oppNow || isEod)) {
        const isBk = pos === 1 ? brkBear && !newBear : brkBull && !newBull;
        const kindTxt = oppNow
          ? pos === 1
            ? isBk
              ? 'BEAR BREAKER'
              : 'BEAR BLOCK'
            : isBk
              ? 'BULL BREAKER'
              : 'BULL BLOCK'
          : 'EOD';
        const pcl = pos === 1 ? (close - st.ent) * m : (st.ent - close) * m;
        if (st.l1Open) {
          st.l1Open = false;
          st.l1P = pcl;
          st.l1Tag = kindTxt;
          const r = row();
          if (r) {
            r.l1T = tStr;
            r.l1P = pcl;
          }
        }
        if (st.l2Open) {
          st.l2Open = false;
          st.l2P = pcl;
          st.l2Tag = kindTxt;
          st.l2Px = close;
        }
      } else if ((st.l1Open || st.l2Open) && !stopHit) {
        // 3) peak
        const fav = pos === 1 ? (high - st.ent) * m : (st.ent - low) * m;
        st.pkPts = Math.max(st.pkPts, fav);
        const r3 = row();
        if (r3) r3.pk = st.pkPts;
        // 4) lot 1 booked at +bookPts
        if (st.l1Open && (pos === 1 ? high >= bookPx : low <= bookPx)) {
          st.l1Open = false;
          st.l1P = S.bookPts;
          st.l1Tag = sgn(S.bookPts);
          const r = row();
          if (r) {
            r.l1T = tStr;
            r.l1P = S.bookPts;
          }
          label({
            bar: bi,
            price: bookPx,
            text: 'LOT 1 +' + fmt(S.bookPts),
            below: pos !== 1,
            color: 'olive',
          });
          evt.push(
            `LOT1|${tStr}|NIFTY ${st.optNm}|booked +${fmt(S.bookPts)}|Rs ${intFmt(S.bookPts * S.lotSz)}`,
          );
        }
        // 5) at +stepTrig: lot 1 stop to +lot1Lock, lot 2 stop to cost (a lot whose
        //    level this candle already closed back through is closed at the close)
        if (S.useStep && st.pkPts >= S.stepTrig) {
          const t1v = pos === 1 ? st.ent + S.lot1Lock / m : st.ent - S.lot1Lock / m;
          if (st.l1Open) {
            if (pos === 1 ? close <= t1v : close >= t1v) {
              const pc1 = pos === 1 ? (close - st.ent) * m : (st.ent - close) * m;
              st.l1Open = false;
              st.l1P = pc1;
              st.l1Tag = l1TagOf(pc1);
              const r = row();
              if (r) {
                r.l1T = tStr;
                r.l1P = pc1;
              }
            } else if (pos === 1 ? t1v > st.sl1 : t1v < st.sl1) {
              st.sl1 = t1v;
              st.stage = Math.max(st.stage, 1);
              evt.push(
                `SLMOVE|${tStr}|NIFTY ${st.optNm}|lot 1 stop ${fmt(st.sl1)} (+${fmt(S.lot1Lock)})|peak +${fmt(st.pkPts)}`,
              );
            }
          }
          const t2v = pos === 1 ? st.ent + S.lot2Lock / m : st.ent - S.lot2Lock / m;
          if (st.l2Open) {
            if (pos === 1 ? close <= t2v : close >= t2v) {
              const pc2 = pos === 1 ? (close - st.ent) * m : (st.ent - close) * m;
              st.l2Open = false;
              st.l2P = pc2;
              st.l2Tag = l2TagOf(pc2);
              st.l2Px = close;
            } else if (pos === 1 ? t2v > st.sl2 : t2v < st.sl2) {
              st.sl2 = t2v;
              st.stage = Math.max(st.stage, 1);
              const r = row();
              if (r) r.cur = st.sl2;
              evt.push(
                `SLMOVE|${tStr}|NIFTY ${st.optNm}|lot 2 stop ${fmt(st.sl2)}${
                  S.lot2Lock > 0 ? ` (+${fmt(S.lot2Lock)})` : ' (cost)'
                }|peak +${fmt(st.pkPts)}`,
              );
            }
          }
        }
        // 6) giveback: lot 1 is out and lot 2's profit falls givePct % from its peak
        if (S.useGive && !st.l1Open && st.l2Open && st.pkPts >= S.giveStart) {
          const lockG = st.pkPts * (1 - S.givePct / 100);
          const tgv = pos === 1 ? st.ent + lockG / m : st.ent - lockG / m;
          if (pos === 1 ? close <= tgv : close >= tgv) {
            const pcg = pos === 1 ? (close - st.ent) * m : (st.ent - close) * m;
            st.l2Open = false;
            st.l2P = pcg;
            st.l2Tag = 'GIVEBACK ' + sgn(pcg);
            st.l2Px = close;
          } else if (pos === 1 ? tgv > st.sl2 : tgv < st.sl2) {
            st.sl2 = tgv;
            st.stage = 3;
            const r = row();
            if (r) r.cur = st.sl2;
            evt.push(
              `SLMOVE|${tStr}|NIFTY ${st.optNm}|lot 2 giveback stop ${fmt(st.sl2)} (+${fmt(lockG)})|peak +${fmt(st.pkPts)}`,
            );
          }
        }
      }

      // 7) finish when both lots are out
      if (!st.l1Open && !st.l2Open) {
        const tot = st.l1P + st.l2P;
        const rs = tot * S.lotSz;
        const bothSL = st.l1Tag === 'SL' && st.l2Tag === 'SL';
        const resTxt = bothSL ? 'SL (both lots)' : `L1 ${st.l1Tag} / L2 ${st.l2Tag}`;
        const r = row();
        if (r) {
          r.xT = tStr;
          r.ex = st.l2Px ?? close;
          r.res = resTxt;
          r.tot = tot;
          r.pk = st.pkPts;
        }
        st.dTr += 1;
        st.dWin += tot > 0 ? 1 : 0;
        st.dLoss += tot < 0 ? 1 : 0;
        st.dPts += tot;
        st.dRs += rs;
        label({
          bar: bi,
          price: st.l2Px ?? close,
          text: `${resTxt}\nTrade ${sgn(tot)}  Rs ${rsFmt(rs)}  (peak +${fmt(st.pkPts)})`,
          below: pos !== 1,
          color: tot >= 0 ? 'green' : 'red',
        });
        evt.push(
          `EXIT|${tStr}|NIFTY ${st.optNm}|${resTxt}|L1 ${fmt(st.l1P)}|L2 ${fmt(st.l2P)}|trade ${fmt(tot)}|Rs ${intFmt(rs)}|peak +${fmt(st.pkPts)}`,
        );
        st.pos = 0;
        st.stage = 0;
        st.li = -1;
      }
    }

    // ------------------------------ entries ------------------------------
    if (ok && st.pos === 0) {
      let goDir: 0 | 1 | -1 = 0;
      let fromPend = false;
      const isHyb = S.entryMode === 'hybrid';
      const srcNow = entBull
        ? brkBull && !newBull
          ? 'breaker'
          : 'block'
        : entBear
          ? brkBear && !newBear
            ? 'breaker'
            : 'block'
          : '';
      const distB = entBull ? Math.max(0, close - nbT) : entBear ? Math.max(0, nsB - close) : null;
      const toPend =
        S.entryMode === 'retest' ||
        (isHyb && (entBull || entBear) && distB !== null && distB > S.nearPts);
      if ((entBull || entBear) && !toPend) {
        goDir = entBull ? 1 : -1;
      } else if ((entBull || entBear) && toPend) {
        if (inWin) {
          st.pend = entBull ? 1 : -1;
          st.pT = entBull ? nbT : nsT;
          st.pB = entBull ? nbB : nsB;
          st.pBar = bi;
          st.pDist = distB;
          st.pSrc = srcNow;
        }
      } else if (st.pend !== 0) {
        const expired = bi - st.pBar > S.pendMax;
        const broken = st.pend === 1 ? close < st.pB - S.slBuf : close > st.pT + S.slBuf;
        if (expired || broken) {
          const kS = st.pend === 1 ? ceStrike(close, S.kStep) : peStrike(close, S.kStep);
          st.dSkip += 1;
          logPush(
            tStr,
            intFmt(kS) + (st.pend === 1 ? ' CE' : ' PE'),
            st.pend,
            null,
            null,
            expired ? 'SKIP: no retest' : 'SKIP: block broke',
          );
          st.pend = 0;
        } else if (st.pend === 1 && low <= st.pT && close > st.pT && close > open) {
          goDir = 1;
          fromPend = true;
        } else if (st.pend === -1 && high >= st.pB && close < st.pB && close < open) {
          goDir = -1;
          fromPend = true;
        }
      }
      if (goDir !== 0 && inWin) {
        const slP = goDir === 1 ? close - S.initSL / m : close + S.initSL / m;
        const k = goDir === 1 ? ceStrike(close, S.kStep) : peStrike(close, S.kStep);
        const nm = intFmt(k) + (goDir === 1 ? ' CE' : ' PE');
        const src = fromPend ? st.pSrc + ' retest' : srcNow;
        st.pend = 0;
        st.pos = goDir;
        st.ent = close;
        st.sl1 = slP;
        st.sl2 = slP;
        st.sl0 = slP;
        st.l1Open = true;
        st.l2Open = true;
        st.l1P = 0;
        st.l2P = 0;
        st.l1Tag = '';
        st.l2Tag = '';
        st.l2Px = null;
        st.pkPts = 0;
        st.stage = 0;
        st.optNm = nm;
        st.li = logPush(tStr, nm, goDir, st.ent, slP, 'OPEN');
        label({
          bar: bi,
          price: goDir === 1 ? low : high,
          text: `BUY 2 x NIFTY ${nm}${src !== 'block' ? `  (${src})` : ''}\n@ ${fmt(st.ent)}  SL ${fmt(slP)}`,
          below: goDir === 1,
          color: goDir === 1 ? 'teal' : 'maroon',
        });
        evt.push(
          `CALL|${tStr}|BUY 2 lots NIFTY ${nm}|from ${src}|spot ${fmt(st.ent)}|SL ${fmt(slP)}|risk ${fmt(
            S.initSL * 2,
          )} ${mName}|Rs/2 lots ${intFmt(S.initSL * 2 * S.lotSz)}`,
        );
      }
    }

    // ------------------------------- plots -------------------------------
    const p = st.pos;
    plots.push({
      time: c.time,
      entry: p !== 0 ? st.ent : null,
      sl1: p !== 0 && st.l1Open ? st.sl1 : null,
      sl2: p !== 0 && st.l2Open ? st.sl2 : null,
      protectedStops: st.stage >= 1,
      book:
        p !== 0 && st.l1Open ? (p === 1 ? st.ent + S.bookPts / m : st.ent - S.bookPts / m) : null,
      trigger:
        p !== 0 && st.stage === 0 && S.useStep
          ? p === 1
            ? st.ent + S.stepTrig / m
            : st.ent - S.stepTrig / m
          : null,
    });

    if (ok && evt.length) alerts.push({ time: c.time, lines: evt });
    lastTime = c.time;
    lastClose = close;
    lastInvBuf = invBuf;
  }

  const toTime = (i: number) => candles[Math.max(0, Math.min(candles.length - 1, i))]!.time;
  const zoneOut = (z: ZoneRec): B2BZone => ({
    kind: z.kind,
    top: z.top,
    bot: z.bot,
    leftTime: toTime(z.left),
  });
  return {
    bull: bull.map(zoneOut),
    bear: bear.map(zoneOut),
    ghosts: ghosts.map((g) => ({
      top: g.top,
      bot: g.bot,
      leftTime: toTime(g.left),
      rightTime: toTime(g.right),
      text: g.text,
    })),
    labels: labels.map((l) => ({
      time: toTime(l.bar),
      price: l.price,
      text: l.text,
      below: l.below,
      color: l.color,
    })),
    plots,
    log,
    alerts,
    state: { ...st },
    lastTime,
    close: lastClose,
    invBuf: lastInvBuf,
    bars: candles.length,
    previewed,
    pivots,
  };
}

/** Whether the last candle is still forming at `nowS` (epoch seconds). */
export function formingIndexAt(candles: readonly Candle[], nowS: number, barS = 60): number {
  const last = candles.at(-1);
  return last && last.time + barS > nowS ? candles.length - 1 : -1;
}

/** From this IST minute of the day, a run of candles at the day's final close is suspect. */
const CLOSING_PRINT_FROM = 15 * 60 + 20;
/** Index sessions end at 15:30 IST. */
const SESSION_END_MS = (15 * 60 + 30) * 60_000;

/**
 * Kite's 1-minute index candles end each day on the official closing value,
 * which comes from the closing auction, not from trading: on 16-Oct-2026 NIFTY
 * traded near 23,120 until 15:27, then its 15:28 candle jumped to the official
 * close of 23,146.15 and 15:29 stayed there. TradingView's candles don't have
 * the jump, and it breaks zones the script would carry into the next day.
 *
 * For every finished day (a later day follows, or it is past 15:30 IST on that
 * day at `nowS`), this drops the trailing candles from 15:20 on whose close
 * equals the day's last close. On a day without the jump that is just the 15:29
 * candle (after the 15:15 square-off). A day still in session is left alone.
 */
export function dropClosingPrints<T extends Candle>(
  candles: readonly T[],
  nowS = -Infinity,
): readonly T[] {
  let out: T[] | null = null;
  let end = candles.length; // exclusive end of the day being checked
  for (let i = candles.length - 1; i >= 0; i--) {
    const day = istStartOfDay(candles[i]!.time * 1000);
    if (i > 0 && istStartOfDay(candles[i - 1]!.time * 1000) === day) continue;
    // candles[i..end) is one IST day; only trim it once the day is over.
    if (end < candles.length || nowS * 1000 >= day + SESSION_END_MS) {
      const last = candles[end - 1]!.close;
      let cut = end;
      while (cut > i) {
        const c = candles[cut - 1]!;
        const p = toIstParts(c.time * 1000);
        if (c.close !== last || p.hour * 60 + p.minute < CLOSING_PRINT_FROM) break;
        cut--;
      }
      if (cut < end) {
        out ??= candles.slice();
        out.splice(cut, end - cut);
      }
    }
    end = i;
  }
  return out ?? candles;
}
