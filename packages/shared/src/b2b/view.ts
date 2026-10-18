import { istStartOfDay, toIstParts } from '../time';
import { fmt, rsFmt, sgn, type B2BLogRow, type B2BResult } from './engine';
import type { B2BSettings } from './settings';

/*
 * The script's STATUS and CALL LOG tables, cell for cell. Trade state comes
 * from closed candles; like Pine at `barstate.islast`, live values (spot, P&L,
 * the open row of the log) use the forming candle's price, and a forming
 * candle that starts a new day already shows the new day's empty log.
 */

export type B2BTone = 'text' | 'muted' | 'up' | 'down' | 'warn' | 'yellow';
export type B2BRowTone = 'win' | 'loss' | 'none' | 'sub';

export interface B2BCell {
  text: string;
  tone: B2BTone;
}

export interface B2BStatusView {
  header: B2BCell[];
  titles: string[];
  row: B2BCell[];
  rowTone: B2BRowTone;
}

export interface B2BLogView {
  header: B2BCell[];
  titles: string[];
  rows: { cells: B2BCell[]; tone: B2BRowTone }[];
  empty: string | null;
}

export interface B2BLive {
  /** Bar open time (epoch s) and price of the newest candle (forming or closed). */
  time: number;
  close: number;
}

const cell = (text: string, tone: B2BTone = 'text'): B2BCell => ({ text, tone });

const hhmmOf = (epochS: number) => {
  const p = toIstParts(epochS * 1000);
  return p.hour * 100 + p.minute;
};

/** True when the live candle starts a day after the last closed one (Pine resets on it). */
function liveNewDay(res: B2BResult, live: B2BLive | null): boolean {
  return (
    !!live &&
    res.lastTime !== null &&
    istStartOfDay(live.time * 1000) > istStartOfDay(res.lastTime * 1000)
  );
}

export function b2bStatusView(
  res: B2BResult,
  S: B2BSettings,
  live: B2BLive | null,
  flags: { is1m: boolean; isNifty: boolean },
): B2BStatusView {
  const m = S.measure === 'points' ? 1 : S.deltaF;
  const st = res.state;
  const close = live?.close ?? res.close ?? NaN;
  const hhmm = live ? hhmmOf(live.time) : res.lastTime !== null ? hhmmOf(res.lastTime) : 0;
  const inWin = hhmm >= S.entFrom && hhmm <= S.entTo;
  const pos = liveNewDay(res, live) ? 0 : st.pos;
  const stageTxt = (s: number) =>
    s === 0
      ? `0 initial -${fmt(S.initSL)}`
      : s === 1
        ? `1 L1 +${fmt(S.lot1Lock)} / L2 cost`
        : `3 giveback ${fmt(S.givePct)}%`;

  const header = [
    cell('NIFTY 2-LOT B2B v1.8'),
    cell(`SL -${fmt(S.initSL)} each lot | lot ${S.lotSz} x 2`),
    cell(
      `+${fmt(S.stepTrig)}: L1 +${fmt(S.lot1Lock)}, L2 cost | L1 books +${fmt(S.bookPts)} | giveback ${fmt(
        S.givePct,
      )}% from +${fmt(S.giveStart)}`,
    ),
    cell(`calls ${S.entFrom}-${S.entTo} | sq-off ${S.sqOff}`, inWin ? 'text' : 'warn'),
    cell(
      S.entryMode === 'hybrid'
        ? `entry: hybrid (near ${fmt(S.nearPts)})`
        : S.entryMode === 'block'
          ? 'entry: on block'
          : 'entry: on retest',
    ),
    cell(
      `zones v7.9 | live B/S ${res.bull.length}/${res.bear.length} | ghosts ${res.ghosts.length}`,
    ),
    cell((flags.is1m ? '' : 'USE 1m CHART! ') + (flags.isNifty ? '' : 'NOT A NIFTY CHART'), 'warn'),
  ];
  const titles = [
    'Option',
    'Spot',
    'Dir',
    'Last zone event',
    'Entry / Trade',
    'Peak',
    'SL',
    'SL now / stage',
    'Lot 1',
    'Lot 2',
    'Exit at',
    'Risk Rs now',
  ];

  if (pos !== 0) {
    const livePts = pos === 1 ? (close - st.ent) * m : (st.ent - close) * m;
    const s1p = st.l1Open ? (pos === 1 ? (st.sl1 - st.ent) * m : (st.ent - st.sl1) * m) : st.l1P;
    const s2p = st.l2Open ? (pos === 1 ? (st.sl2 - st.ent) * m : (st.ent - st.sl2) * m) : st.l2P;
    const worst = s1p + s2p;
    const nBullB = res.bull.at(-1)?.bot;
    const nBearT = res.bear.at(-1)?.top;
    const ib = res.invBuf ?? 0;
    const exitTxt =
      pos === 1
        ? 'BEAR block / breaker' + (nBullB === undefined ? '' : ` (< ${fmt(nBullB - ib)})`)
        : 'BULL block / breaker' + (nBearT === undefined ? '' : ` (> ${fmt(nBearT + ib)})`);
    const bookPx = pos === 1 ? st.ent + S.bookPts / m : st.ent - S.bookPts / m;
    return {
      header,
      titles,
      rowTone: livePts >= 0 ? 'win' : 'loss',
      row: [
        cell('NIFTY ' + st.optNm),
        cell(fmt(close)),
        cell(pos === 1 ? 'BUY CE' : 'BUY PE', pos === 1 ? 'up' : 'down'),
        cell(`${st.lastBlk}  ${st.lastBlkT}`),
        cell(`LIVE @${fmt(st.ent)}  ${sgn(livePts)}`, livePts >= 0 ? 'up' : 'down'),
        cell('+' + fmt(st.pkPts), 'up'),
        cell(fmt(st.sl0), 'warn'),
        cell(
          `${st.l1Open ? 'L1 ' + fmt(st.sl1) : 'L1 out'} | ${st.l2Open ? 'L2 ' + fmt(st.sl2) : 'L2 out'} | st ${stageTxt(st.stage)}`,
          st.stage >= 1 ? 'up' : 'warn',
        ),
        cell(
          st.l1Open ? 'open, book at ' + fmt(bookPx) : 'OUT ' + st.l1Tag,
          st.l1Open ? 'text' : 'up',
        ),
        cell(st.l2Open ? 'open' : 'OUT ' + st.l2Tag, st.l2Open ? 'yellow' : 'up'),
        cell(exitTxt),
        cell(
          worst < 0 ? rsFmt(-worst * S.lotSz) : `0 (locked +${rsFmt(worst * S.lotSz)})`,
          worst < 0 ? 'text' : 'up',
        ),
      ],
    };
  }
  const pend = liveNewDay(res, live) ? 0 : st.pend;
  const barsLeft = S.pendMax - (res.bars - 1 - st.pBar);
  return {
    header,
    titles,
    rowTone: 'none',
    row: [
      cell('-', 'muted'),
      cell(fmt(close)),
      cell('-', 'muted'),
      cell(`${st.lastBlk}  ${st.lastBlkT}`),
      cell(
        pend !== 0
          ? `WAIT retest ${pend === 1 ? 'BULL ' : 'BEAR '}${fmt(st.pB)}-${fmt(st.pT)}${
              st.pDist === null ? '' : ` (far ${fmt(st.pDist)} pts, ${barsLeft} bars left)`
            }`
          : inWin
            ? 'FLAT - waiting for block'
            : 'OUT OF HRS',
        pend !== 0 ? 'yellow' : inWin ? 'muted' : 'warn',
      ),
      ...Array.from({ length: 7 }, () => cell('', 'muted')),
    ],
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function b2bLogView(res: B2BResult, S: B2BSettings, live: B2BLive | null): B2BLogView {
  const m = S.measure === 'points' ? 1 : S.deltaF;
  const st = res.state;
  const fresh = liveNewDay(res, live);
  const log: B2BLogRow[] = fresh ? [] : res.log;
  const pos = fresh ? 0 : st.pos;
  const close = live?.close ?? res.close ?? NaN;
  const dayTime = live?.time ?? res.lastTime ?? 0;
  const p = toIstParts(dayTime * 1000);
  const openN = pos !== 0 ? 1 : 0;
  const z = fresh ? { dTr: 0, dWin: 0, dLoss: 0, dPts: 0, dRs: 0, dSkip: 0 } : st;

  const header = [
    cell(`CALL LOG ${String(p.day).padStart(2, '0')}-${MONTHS[p.month - 1]}`),
    cell('Taken ' + (z.dTr + openN)),
    cell(`W ${z.dWin} / L ${z.dLoss}`),
    cell('Open ' + openN),
    cell('Net pts ' + fmt(z.dPts), z.dPts >= 0 ? 'up' : 'down'),
    cell('Net Rs ' + rsFmt(z.dRs), z.dRs >= 0 ? 'up' : 'down'),
    cell('Skipped ' + z.dSkip, 'warn'),
  ];
  const titles = [
    'In',
    'Option',
    'Dir',
    'Entry',
    'SL',
    'SL now (lot 2)',
    'Peak',
    'Lot 1 out',
    'Lot 1 pts',
    'Out',
    'Exit',
    'Result',
    'Pts / Rs',
  ];
  if (!log.length)
    return { header, titles, rows: [], empty: 'No calls yet today (log fills live, from load)' };

  const rows: B2BLogView['rows'] = [];
  for (let i = log.length - 1; i >= 0 && rows.length < S.logRows; i--) {
    const r = log[i]!;
    const isSkip = r.res.startsWith('SKIP');
    if (isSkip && !S.logSkip) continue;
    const isOpen = r.res === 'OPEN';
    const d = r.dir;
    let tot = r.tot;
    if (isOpen && r.ent !== null) {
      const remL = d === 1 ? (close - r.ent) * m : (r.ent - close) * m;
      tot = (st.l1Open ? remL : st.l1P) + (st.l2Open ? remL : st.l2P);
    }
    const tone: B2BRowTone = isSkip ? 'none' : isOpen ? 'sub' : (tot ?? 0) >= 0 ? 'win' : 'loss';
    const cv = r.cur;
    const lkv = cv === null || r.ent === null ? 0 : d === 1 ? (cv - r.ent) * m : (r.ent - cv) * m;
    const openTxt =
      st.l1Open && st.l2Open ? 'OPEN (2 lots)' : st.l2Open ? 'OPEN (lot 2)' : 'OPEN (lot 1)';
    const totV = tot ?? 0;
    rows.push({
      tone,
      cells: [
        cell(r.t),
        cell('NIFTY ' + r.opt),
        cell(d === 1 ? 'BUY CE' : 'BUY PE', d === 1 ? 'up' : 'down'),
        cell(r.ent === null ? '' : fmt(r.ent)),
        cell(r.sl === null ? '' : fmt(r.sl), 'warn'),
        cell(
          isSkip || cv === null
            ? ''
            : fmt(cv) + (lkv > 0.01 ? ' +' + fmt(lkv) : lkv >= -0.01 ? ' cost' : ''),
          isSkip ? 'muted' : lkv >= -0.01 ? 'up' : 'warn',
        ),
        cell(isSkip || r.pk === null ? '' : '+' + fmt(r.pk), 'up'),
        cell(r.l1T),
        cell(r.l1P === null ? '' : sgn(r.l1P), (r.l1P ?? 0) >= 0 ? 'up' : 'down'),
        cell(r.xT),
        cell(r.ex === null ? '' : fmt(r.ex)),
        cell(
          isOpen ? openTxt : r.res,
          isSkip ? 'warn' : isOpen ? 'yellow' : totV >= 0 ? 'up' : 'down',
        ),
        cell(
          isSkip ? '' : `${sgn(totV)} / ${rsFmt(totV * S.lotSz)}`,
          isSkip ? 'muted' : totV >= 0 ? 'up' : 'down',
        ),
      ],
    });
  }
  return { header, titles, rows, empty: null };
}

/** The script's NIFTY check: NIFTY, but not BANKNIFTY, FINNIFTY or MIDCPNIFTY. */
export function isNiftySymbol(tradingsymbol: string): boolean {
  const s = tradingsymbol.toUpperCase();
  return s.includes('NIFTY') && !s.includes('BANK') && !s.includes('FIN') && !s.includes('MID');
}
