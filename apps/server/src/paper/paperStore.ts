import {
  DEFAULT_PAPER_CONFIG,
  DEFAULT_PAPER_COSTS,
  type PaperConfig,
  type PaperEvent,
  type PaperTrade,
} from '@otv/shared';
import type { Db } from '../db';

const CONFIG_KEY = 'paper.config';

/** Paper trades and events in SQLite (live and mock modes have separate databases). */
export class PaperStore {
  constructor(private readonly db: Db) {}

  config(): PaperConfig {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(CONFIG_KEY) as
      { v: string } | undefined;
    let o: Partial<PaperConfig> = {};
    try {
      o = row ? (JSON.parse(row.v) as Partial<PaperConfig>) : {};
    } catch {
      // Fall back to defaults.
    }
    const costs = { ...DEFAULT_PAPER_COSTS };
    for (const k of Object.keys(costs) as (keyof typeof costs)[]) {
      const v = o.costs?.[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) costs[k] = v;
    }
    return {
      enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_PAPER_CONFIG.enabled,
      lots: DEFAULT_PAPER_CONFIG.lots,
      expiry: o.expiry === 'skip-expiry-day' ? 'skip-expiry-day' : 'nearest',
      costs,
    };
  }

  setConfig(patch: Partial<PaperConfig>): PaperConfig {
    const next = { ...this.config(), ...patch };
    this.db
      .prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)')
      .run(CONFIG_KEY, JSON.stringify(next));
    return this.config();
  }

  /** Inserts a trade and returns it with its id. */
  insert(t: Omit<PaperTrade, 'id'>): PaperTrade {
    const r = this.db
      .prepare('INSERT INTO paper_trades (day, signal_time, status, json) VALUES (?, ?, ?, ?)')
      .run(t.day, t.signalTime, t.status, '{}');
    const trade = { ...t, id: Number(r.lastInsertRowid) };
    this.update(trade);
    return trade;
  }

  update(t: PaperTrade): void {
    this.db
      .prepare('UPDATE paper_trades SET status = ?, json = ? WHERE id = ?')
      .run(t.status, JSON.stringify(t), t.id);
  }

  find(day: string, signalTime: number): PaperTrade | undefined {
    const row = this.db
      .prepare('SELECT json FROM paper_trades WHERE day = ? AND signal_time = ?')
      .get(day, signalTime) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as PaperTrade) : undefined;
  }

  open(): PaperTrade[] {
    return (
      this.db.prepare("SELECT json FROM paper_trades WHERE status = 'open' ORDER BY id").all() as {
        json: string;
      }[]
    ).map((r) => JSON.parse(r.json) as PaperTrade);
  }

  /** Trades whose day is within [from, to] (yyyy-mm-dd, inclusive), oldest first. */
  trades(from = '0000-00-00', to = '9999-99-99'): PaperTrade[] {
    return (
      this.db
        .prepare(
          'SELECT json FROM paper_trades WHERE day >= ? AND day <= ? ORDER BY day, signal_time',
        )
        .all(from, to) as { json: string }[]
    ).map((r) => JSON.parse(r.json) as PaperTrade);
  }

  addEvent(e: Omit<PaperEvent, 'id'>): void {
    this.db
      .prepare(
        'INSERT INTO paper_events (at, bar_time, trade_id, kind, text) VALUES (?, ?, ?, ?, ?)',
      )
      .run(e.at, e.barTime, e.tradeId, e.kind, e.text);
  }

  /** Events with `at` in [fromMs, toMs), oldest first. */
  events(fromMs: number, toMs: number): PaperEvent[] {
    return (
      this.db
        .prepare(
          'SELECT id, at, bar_time, trade_id, kind, text FROM paper_events WHERE at >= ? AND at < ? ORDER BY id',
        )
        .all(fromMs, toMs) as {
        id: number;
        at: number;
        bar_time: number | null;
        trade_id: number | null;
        kind: string;
        text: string;
      }[]
    ).map((r) => ({
      id: r.id,
      at: r.at,
      barTime: r.bar_time,
      tradeId: r.trade_id,
      kind: r.kind,
      text: r.text,
    }));
  }
}
