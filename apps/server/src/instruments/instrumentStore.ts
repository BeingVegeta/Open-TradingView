import { EventEmitter } from 'node:events';
import type { Instrument } from '@otv/shared';
import type { Db } from '../db';
import { InstrumentIndex } from './search';

interface Row {
  key: string;
  token: number;
  exchange: string;
  tradingsymbol: string;
  name: string;
  segment: string;
  instrument_type: string;
  expiry: string | null;
  strike: number;
  tick_size: number;
  lot_size: number;
}

const SYNCED_AT = 'instruments_synced_at';

/** Instrument master persisted in SQLite, served from an in-memory index. */
export class InstrumentStore extends EventEmitter<{ replaced: [] }> {
  readonly index = new InstrumentIndex();
  private syncedAt: number | null = null;

  constructor(private readonly db: Db) {
    super();
    this.setMaxListeners(50);
    const rows = db.prepare('SELECT * FROM instruments').all() as Row[];
    this.index.load(rows.map(fromRow));
    const v = db.prepare('SELECT v FROM kv WHERE k = ?').get(SYNCED_AT) as
      { v: string } | undefined;
    this.syncedAt = v ? Number(v.v) : null;
  }

  get lastSyncedAt(): number | null {
    return this.syncedAt;
  }

  get(key: string): Instrument | undefined {
    return this.index.get(key);
  }

  /** Atomically replaces the whole master (Kite regenerates it daily). */
  replaceAll(instruments: Instrument[], syncedAt: number): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO instruments
         (key, token, exchange, tradingsymbol, name, segment, instrument_type, expiry, strike, tick_size, lot_size)
       VALUES (@key, @token, @exchange, @tradingsymbol, @name, @segment, @instrumentType, @expiry, @strike, @tickSize, @lotSize)`,
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM instruments').run();
      for (const i of instruments) insert.run(i);
      this.db
        .prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)')
        .run(SYNCED_AT, String(syncedAt));
    })();
    this.index.load(instruments);
    this.syncedAt = syncedAt;
    this.emit('replaced');
  }
}

function fromRow(r: Row): Instrument {
  return {
    key: r.key,
    token: r.token,
    exchange: r.exchange,
    tradingsymbol: r.tradingsymbol,
    name: r.name,
    segment: r.segment,
    instrumentType: r.instrument_type,
    expiry: r.expiry,
    strike: r.strike,
    tickSize: r.tick_size,
    lotSize: r.lot_size,
  };
}
