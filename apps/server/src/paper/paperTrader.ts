import { EventEmitter } from 'node:events';
import {
  dropUnconfirmed,
  formatIstDateTime,
  getTimeframe,
  istToEpoch,
  paperCosts,
  runB2B,
  sanitizeB2BSettings,
  type B2BLogRow,
  type B2BResult,
  type B2BSettings,
  type Candle,
  type Instrument,
  type PaperLotExit,
  type PaperStatus,
  type PaperTrade,
  type Tick,
} from '@otv/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthService } from '../auth/authService';
import type { HistoryService } from '../history/historyService';
import type { InstrumentStore } from '../instruments/instrumentStore';
import type { Clock } from '../kite/clock';
import { toKiteError } from '../kite/errors';
import type { BarsEvent, LiveCandles } from '../live/liveCandles';
import type { TickerManager } from '../ticker/tickerManager';
import type { PrefsStore } from '../user/prefsStore';
import type { PaperStore } from './paperStore';

export const PAPER_UNDERLYING = 'NSE:NIFTY 50';
const CONSUMER = 'paper';
const WARMUP_BARS = 5000;
/** Strikes streamed on each side of spot, so a call can be filled at once. */
const CHAIN_STRIKES = 4;
const FILL_WAIT_MS = 3000;

const ymd = (epochMs: number) => formatIstDateTime(epochMs).slice(0, 10);

/** 32-bit FNV-1a, as 8 hex digits: identifies a settings version. */
export function settingsHash(s: B2BSettings): string {
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(s)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The script's exit tags for both lots of a log row ("L1 +15 / L2 COST", "SL (both lots)"). */
function rowTags(r: B2BLogRow): [string, string] | null {
  if (r.res === 'SL (both lots)') return ['SL', 'SL'];
  const m = /^L1 (.*) \/ L2 (.*)$/.exec(r.res);
  return m ? [m[1]!, m[2]!] : null;
}

export interface PaperTraderDeps {
  auth: AuthService;
  history: HistoryService;
  live: LiveCandles;
  ticker: TickerManager;
  instruments: InstrumentStore;
  store: PaperStore;
  prefs: PrefsStore;
  clock: Clock;
  log: FastifyBaseLogger;
  /** How often to re-check for a closed candle without a newer tick (ms). */
  pollMs?: number;
  /** Never start (tests that don't exercise paper trading). */
  inactive?: boolean;
}

/**
 * Trades Varun's N-B2B script on paper, live: on every closed NIFTY 1-minute
 * candle it runs the script (with the dashboard's settings) and mirrors each
 * call, lot exit and close as simulated fills of the option the script names,
 * at the live best ask (buys) and best bid (sells). Trades and events are
 * stored. It never places orders.
 */
export class PaperTrader extends EventEmitter<{ change: [] }> {
  private candles: Candle[] = [];
  private seriesId: string | null = null;
  private running = false;
  private starting = false;
  private state: PaperStatus['state'] = 'off';
  private message: string | null = null;
  private lastBar: number | null = null;
  /** Alerts up to this candle were handled (no trading on history replayed at start). */
  private seenUntil: number | null = null;
  private lastSig = '';
  private chain = new Set<number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private busy: Promise<void> = Promise.resolve();
  private readonly onBars = (e: BarsEvent) => this.handleBars(e);

  constructor(private readonly deps: PaperTraderDeps) {
    super();
    deps.auth.on('change', () => this.reconsider());
    deps.instruments.on('replaced', () => this.reconsider());
  }

  status(): PaperStatus {
    const open = this.deps.store.open();
    return {
      enabled: this.deps.store.config().enabled,
      state: this.state,
      message: this.message,
      lastBar: this.lastBar,
      openTrade: open.at(-1) ?? null,
    };
  }

  /** Starts or stops to match the config and login. */
  reconsider(): void {
    if (this.deps.inactive) return;
    const enabled = this.deps.store.config().enabled;
    const session = this.deps.auth.session();
    if (!enabled) return this.halt('off', null);
    if (!session) return this.halt('waiting-login', 'Log in to Kite to start paper trading.');
    if (!this.running && !this.starting) void this.begin();
  }

  stop(): void {
    this.halt('off', null);
  }

  private setState(state: PaperStatus['state'], message: string | null): void {
    this.state = state;
    this.message = message;
    this.emit('change');
  }

  private halt(state: PaperStatus['state'], message: string | null): void {
    clearInterval(this.timer);
    clearTimeout(this.retry);
    this.timer = undefined;
    this.deps.live.off('bars', this.onBars);
    if (this.seriesId) this.deps.live.release(this.seriesId, CONSUMER);
    this.deps.ticker.release(CONSUMER);
    this.seriesId = null;
    this.chain.clear();
    this.running = false;
    this.candles = [];
    this.lastSig = '';
    this.seenUntil = null;
    if (this.state !== state || this.message !== message) this.setState(state, message);
  }

  private async begin(): Promise<void> {
    const { instruments, history, auth, live, log } = this.deps;
    const inst = instruments.get(PAPER_UNDERLYING);
    if (!inst) {
      this.setState('waiting-instruments', 'Waiting for the instrument list.');
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.reconsider(), 5000);
      return;
    }
    const session = auth.session();
    if (!session) return;
    this.starting = true;
    this.setState('loading', 'Loading 1-minute history.');
    try {
      const res = await history.getBefore(session.accessToken, inst, getTimeframe('1m')!, {
        limit: WARMUP_BARS,
        priority: 'low',
      });
      if (!this.deps.store.config().enabled || !auth.session()) return;
      this.candles = res.candles.slice();
      live.on('bars', this.onBars);
      this.seriesId = live.acquire(PAPER_UNDERLYING, '1m', CONSUMER);
      this.running = true;
      this.timer = setInterval(() => this.queue(), this.deps.pollMs ?? 2000);
      this.timer.unref?.();
      this.setState('running', null);
      log.info({ bars: this.candles.length }, 'Paper trading started');
      this.queue();
    } catch (err) {
      const e = toKiteError(err);
      this.setState('error', `Couldn't start: ${e.message}`);
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.reconsider(), 30_000);
    } finally {
      this.starting = false;
    }
  }

  private handleBars(e: BarsEvent): void {
    if (e.series !== this.seriesId) return;
    let c = this.candles;
    if (e.range) c = dropUnconfirmed(c, e.bars, e.range);
    for (const b of [...e.bars].sort((x, y) => x.time - y.time)) {
      const last = c.at(-1);
      if (!last || b.time > last.time) c.push({ ...b });
      else {
        const i = c.findIndex((x) => x.time === b.time);
        if (i >= 0) c[i] = { ...b };
        else {
          c.push({ ...b });
          c.sort((x, y) => x.time - y.time);
        }
      }
    }
    this.candles = c;
    this.queue();
  }

  /** Runs evaluations one at a time. */
  private queue(): void {
    this.busy = this.busy
      .then(() => this.evaluate())
      .catch((err: unknown) => {
        this.deps.log.error({ err }, 'Paper trading step failed');
        this.setState('error', `Paper trading step failed: ${(err as Error).message}`);
      });
  }

  /** Waits for pending work (tests). */
  idle(): Promise<void> {
    return this.busy;
  }

  private async evaluate(): Promise<void> {
    if (!this.running) return;
    const nowMs = this.deps.clock.now();
    const nowS = Math.floor(nowMs / 1000);
    const closed = this.candles.filter((c) => c.time + 60 <= nowS);
    if (!closed.length) return;
    const settings = sanitizeB2BSettings(
      (this.deps.prefs.get() as { b2b?: { settings?: unknown } }).b2b?.settings,
    );
    const lastC = closed.at(-1)!;
    const sig = `${closed.length}|${lastC.time}|${lastC.close}|${lastC.high}|${lastC.low}|${JSON.stringify(settings)}`;
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      const res = runB2B(closed, { settings });
      this.lastBar = res.lastTime;
      if (this.seenUntil === null) {
        // Started (or restarted): don't trade calls from before we were watching.
        this.seenUntil = res.lastTime;
        this.resume(res, settings, nowMs);
      } else {
        await this.apply(res, settings, nowMs);
      }
      this.emit('change');
    }
    this.updateChain(lastC.close, settings);
  }

  private dayOf(res: B2BResult): string | null {
    return res.lastTime === null ? null : ymd(res.lastTime * 1000);
  }

  /** Bar open time (epoch s) of a log row's "HH:MM" on a day. */
  private rowTime(day: string, hhmm: string): number {
    const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
    const [h, mi] = hhmm.split(':').map(Number) as [number, number];
    return istToEpoch(y, mo, d, h, mi) / 1000;
  }

  /**
   * After a (re)start: open trades the script has since closed, or no longer
   * has, are closed at the current option price, with a note.
   */
  private resume(res: B2BResult, settings: B2BSettings, nowMs: number): void {
    const day = this.dayOf(res);
    for (const t of this.deps.store.open()) {
      const row =
        t.day === day ? res.log.find((r) => this.rowTime(t.day, r.t) === t.signalTime) : undefined;
      if (row && row.res === 'OPEN' && res.state.pos === t.dir) continue; // still open: carry on
      const note = row ? 'closed while the app was off' : 'not found after a restart';
      this.closeRemaining(t, res, row, settings, nowMs, note);
    }
  }

  private async apply(res: B2BResult, settings: B2BSettings, nowMs: number): Promise<void> {
    const { store } = this.deps;
    const day = this.dayOf(res);
    if (!day) return;
    const fresh = res.alerts.filter((a) => a.time > (this.seenUntil ?? 0));
    this.seenUntil = res.lastTime;
    const freshLines = fresh.flatMap((a) => a.lines.map((text) => ({ barTime: a.time, text })));

    // Open trades the script no longer has (Kite's corrected candle changed the call).
    for (const t of store.open()) {
      const row =
        t.day === day ? res.log.find((r) => this.rowTime(t.day, r.t) === t.signalTime) : undefined;
      if (!row && t.day === day)
        this.closeRemaining(
          t,
          res,
          undefined,
          settings,
          nowMs,
          'call withdrawn after Kite corrected the candle',
        );
      else if (t.day !== day)
        this.closeRemaining(t, res, undefined, settings, nowMs, 'carried over to a new day');
    }

    for (let i = 0; i < res.log.length; i++) {
      const r = res.log[i]!;
      if (r.ent === null) continue; // a SKIP row
      const signalTime = this.rowTime(day, r.t);
      let t = store.find(day, signalTime);
      if (!t) {
        // Only calls made on candles that closed while we were watching.
        if (!fresh.some((a) => a.time === signalTime)) continue;
        t = await this.enter(r, settings, signalTime, nowMs, freshLines);
      }
      if (t.status !== 'open') continue;
      t.peakPts = Math.max(t.peakPts, r.pk ?? 0);
      const isCurrent = i === res.state.li;
      // Lot 1 out?
      if (r.l1T && !t.lot1) {
        const tags = isCurrent ? [res.state.l1Tag, res.state.l2Tag] : (rowTags(r) ?? ['?', '?']);
        const exitBar = this.rowTime(day, r.l1T);
        const booked = freshLines.some(
          (l) =>
            l.barTime === exitBar &&
            l.text.startsWith('LOT1|') &&
            l.text.includes(`|NIFTY ${t!.optionName}|booked +`),
        );
        t.lot1 = await this.exitLot(
          t,
          r.l1P ?? 0,
          booked ? `BOOK ${tags[0]}` : tags[0]!,
          settings,
          nowMs,
        );
      }
      // Trade closed?
      if (r.xT) {
        const tags = rowTags(r) ?? ['?', '?'];
        if (!t.lot1) t.lot1 = await this.exitLot(t, r.l1P ?? 0, tags[0], settings, nowMs);
        const l2pts = (r.tot ?? 0) - (r.l1P ?? 0);
        t.lot2 = await this.exitLot(t, l2pts, tags[1], settings, nowMs);
        this.finish(t, r, settings);
      }
      store.update(t);
    }
    for (const l of freshLines) {
      const tr = this.tradeForLine(day, l.text);
      store.addEvent({
        at: nowMs,
        barTime: l.barTime,
        tradeId: tr?.id ?? null,
        kind: l.text.split('|')[0]!,
        text: l.text,
      });
    }
  }

  private tradeForLine(day: string, text: string): PaperTrade | undefined {
    const m = /^(?:CALL|LOT1|SLMOVE|EXIT)\|(\d\d:\d\d)\|/.exec(text);
    if (!m) return undefined;
    // CALL lines carry the entry time; others belong to the open (or just closed) trade.
    if (text.startsWith('CALL|')) return this.deps.store.find(day, this.rowTime(day, m[1]!));
    const name = /\|NIFTY ([^|]+)\|/.exec(text)?.[1];
    return this.deps.store
      .trades(day, day)
      .filter((t) => t.optionName === name)
      .at(-1);
  }

  /** The option to trade: NIFTY, the strike and side the script names, the chosen expiry. */
  private optionFor(dir: 1 | -1, strike: number, nowMs: number): Instrument | undefined {
    const today = ymd(nowMs);
    const type = dir === 1 ? 'CE' : 'PE';
    const cands = [...this.deps.instruments.index.all()].filter(
      (i) =>
        i.exchange === 'NFO' &&
        i.name === 'NIFTY' &&
        i.instrumentType === type &&
        i.strike === strike &&
        i.expiry !== null &&
        i.expiry >= today,
    );
    cands.sort((a, b) => a.expiry!.localeCompare(b.expiry!));
    if (this.deps.store.config().expiry === 'skip-expiry-day' && cands[0]?.expiry === today)
      return cands[1] ?? cands[0];
    return cands[0];
  }

  /** Keeps the strikes around spot streaming, so a call can be filled immediately. */
  private updateChain(spot: number, settings: B2BSettings): void {
    const nowMs = this.deps.clock.now();
    const want = new Set<number>();
    const base = Math.round(spot / settings.kStep) * settings.kStep;
    for (let k = -CHAIN_STRIKES; k <= CHAIN_STRIKES; k++) {
      for (const dir of [1, -1] as const) {
        const o = this.optionFor(dir, base + k * settings.kStep, nowMs);
        if (o) want.add(o.token);
      }
    }
    for (const t of this.deps.store.open()) {
      const o = t.optionKey ? this.deps.instruments.get(t.optionKey) : undefined;
      if (o) want.add(o.token);
    }
    for (const tok of this.chain) if (!want.has(tok)) this.deps.ticker.release(CONSUMER, tok);
    for (const tok of want)
      if (!this.chain.has(tok)) this.deps.ticker.acquire(CONSUMER, tok, 'full');
    this.chain = want;
  }

  /** A simulated fill: best ask to buy, best bid to sell, else the last price. */
  private async fill(
    token: number,
    side: 'buy' | 'sell',
  ): Promise<{ price: number; ltp: number; note?: string } | null> {
    let tick: Tick | undefined = this.deps.ticker.lastTick(token);
    if (!tick) {
      this.deps.ticker.acquire(CONSUMER, token, 'full');
      this.chain.add(token);
      const until = Date.now() + FILL_WAIT_MS;
      while (!tick && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 100));
        tick = this.deps.ticker.lastTick(token);
      }
    }
    if (!tick || !(tick.lastPrice > 0)) return null;
    const level = side === 'buy' ? tick.depth?.sell[0] : tick.depth?.buy[0];
    if (level && level.price > 0) return { price: level.price, ltp: tick.lastPrice };
    return {
      price: tick.lastPrice,
      ltp: tick.lastPrice,
      note: `${side} filled at last price (no depth)`,
    };
  }

  private async enter(
    r: B2BLogRow,
    settings: B2BSettings,
    signalTime: number,
    nowMs: number,
    lines: { barTime: number; text: string }[],
  ): Promise<PaperTrade> {
    const strike = Number(r.opt.split(' ')[0]);
    const opt = this.optionFor(r.dir, strike, nowMs);
    const notes: string[] = [];
    let fill: Awaited<ReturnType<PaperTrader['fill']>> = null;
    if (opt) {
      fill = await this.fill(opt.token, 'buy');
      if (!fill) notes.push('no option price at entry');
      else if (fill.note) notes.push(fill.note);
    } else notes.push(`no NIFTY ${r.opt} contract found in the instrument list`);
    const call = lines.find((l) => l.barTime === signalTime && l.text.startsWith('CALL|'));
    const source = /\|from ([^|]+)\|/.exec(call?.text ?? '')?.[1] ?? 'block';
    const trade = this.deps.store.insert({
      day: ymd(signalTime * 1000),
      signalTime,
      entryAt: nowMs,
      dir: r.dir,
      source,
      underlying: PAPER_UNDERLYING,
      optionName: r.opt,
      optionKey: opt?.key ?? null,
      expiry: opt?.expiry ?? null,
      lots: 2,
      lotSize: opt?.lotSize ?? settings.lotSz,
      scriptLotSize: settings.lotSz,
      entryIndex: r.ent!,
      slIndex: r.sl!,
      entryOpt: fill?.price ?? null,
      entryOptLtp: fill?.ltp ?? null,
      peakPts: 0,
      maePts: null,
      lot1: null,
      lot2: null,
      status: 'open',
      result: null,
      scriptPts: null,
      scriptRs: null,
      grossRs: null,
      costsRs: null,
      netRs: null,
      settingsHash: settingsHash(settings),
      notes,
    });
    this.deps.log.info(
      { option: trade.optionKey, entryOpt: trade.entryOpt, index: trade.entryIndex },
      `Paper trade: BUY 2 lots NIFTY ${r.opt}`,
    );
    return trade;
  }

  private async exitLot(
    t: PaperTrade,
    pts: number,
    reason: string,
    settings: B2BSettings,
    nowMs: number,
  ): Promise<PaperLotExit> {
    const m = settings.measure === 'points' ? 1 : settings.deltaF;
    const opt = t.optionKey ? this.deps.instruments.get(t.optionKey) : undefined;
    const fill = opt ? await this.fill(opt.token, 'sell') : null;
    if (opt && !fill) t.notes.push('no option price at an exit');
    else if (fill?.note && !t.notes.includes(fill.note)) t.notes.push(fill.note);
    return {
      at: nowMs,
      index: t.entryIndex + (t.dir * pts) / m,
      opt: fill?.price ?? null,
      reason,
      pts,
    };
  }

  private finish(t: PaperTrade, r: B2BLogRow | undefined, settings: B2BSettings): void {
    t.status = 'closed';
    t.result = r?.xT ? r.res : (t.result ?? 'closed');
    t.scriptPts = (t.lot1?.pts ?? 0) + (t.lot2?.pts ?? 0);
    t.scriptRs = t.scriptPts * settings.lotSz;
    t.maePts = this.mae(t);
    if (t.entryOpt !== null && t.lot1?.opt != null && t.lot2?.opt != null) {
      const q = t.lotSize;
      t.grossRs = (t.lot1.opt - t.entryOpt) * q + (t.lot2.opt - t.entryOpt) * q;
      t.costsRs = paperCosts(
        this.deps.store.config().costs,
        [{ price: t.entryOpt, qty: 2 * q }],
        [
          { price: t.lot1.opt, qty: q },
          { price: t.lot2.opt, qty: q },
        ],
        t.lot1.at === t.lot2.at ? 2 : 3,
      );
      t.netRs = t.grossRs - t.costsRs;
    }
    this.deps.log.info(
      { result: t.result, scriptPts: t.scriptPts, netRs: t.netRs },
      `Paper trade closed: NIFTY ${t.optionName}`,
    );
  }

  /** Worst move against the trade while it was open, in index points. */
  private mae(t: PaperTrade): number | null {
    const end = Math.max(t.lot1?.at ?? 0, t.lot2?.at ?? 0) / 1000;
    const bars = this.candles.filter((c) => c.time > t.signalTime && c.time < end);
    if (!bars.length) return 0;
    return Math.max(
      0,
      ...bars.map((c) => (t.dir === 1 ? t.entryIndex - c.low : c.high - t.entryIndex)),
    );
  }

  /** Closes what's left of a trade at the current option price, with a note. */
  private closeRemaining(
    t: PaperTrade,
    res: B2BResult,
    row: B2BLogRow | undefined,
    settings: B2BSettings,
    nowMs: number,
    note: string,
  ): void {
    const m = settings.measure === 'points' ? 1 : settings.deltaF;
    const close = res.close ?? t.entryIndex;
    const ptsNow = t.dir === 1 ? (close - t.entryIndex) * m : (t.entryIndex - close) * m;
    const opt = t.optionKey ? this.deps.instruments.get(t.optionKey) : undefined;
    const tick = opt ? this.deps.ticker.lastTick(opt.token) : undefined;
    const optNow = tick && tick.lastPrice > 0 ? tick.depth?.buy[0]?.price || tick.lastPrice : null;
    const tags = row ? rowTags(row) : null;
    const exit = (pts: number, reason: string): PaperLotExit => ({
      at: nowMs,
      index: t.entryIndex + (t.dir * pts) / m,
      opt: optNow,
      reason,
      pts,
    });
    if (!t.lot1) t.lot1 = exit(row?.l1P ?? ptsNow, tags?.[0] ?? 'CLOSED');
    if (!t.lot2)
      t.lot2 = exit(
        row && row.tot !== null ? row.tot - (row.l1P ?? 0) : ptsNow,
        tags?.[1] ?? 'CLOSED',
      );
    t.notes.push(note);
    if (row?.xT) t.result = row.res;
    else t.result = `closed: ${note}`;
    this.finish(t, row, settings);
    this.deps.store.update(t);
    this.deps.store.addEvent({
      at: nowMs,
      barTime: null,
      tradeId: t.id,
      kind: 'NOTE',
      text: `NIFTY ${t.optionName}: ${note}`,
    });
  }
}

export const _test = { rowTags };
