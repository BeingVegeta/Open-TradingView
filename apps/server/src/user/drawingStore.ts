import { sanitizeDrawings, type Drawing } from '@otv/shared';
import type { Db } from '../db';

/** Chart drawings per instrument key (EXCHANGE:TRADINGSYMBOL), shared by every timeframe. */
export class DrawingStore {
  constructor(private readonly db: Db) {}

  get(key: string): Drawing[] {
    const row = this.db.prepare('SELECT json FROM drawings WHERE ikey = ?').get(key) as
      { json: string } | undefined;
    if (!row) return [];
    try {
      return sanitizeDrawings(JSON.parse(row.json));
    } catch {
      return [];
    }
  }

  /** Replaces an instrument's drawings; returns what was stored. */
  set(key: string, input: unknown): Drawing[] {
    const list = sanitizeDrawings(input);
    if (list.length) {
      this.db
        .prepare('INSERT OR REPLACE INTO drawings (ikey, json) VALUES (?, ?)')
        .run(key, JSON.stringify(list));
    } else {
      this.db.prepare('DELETE FROM drawings WHERE ikey = ?').run(key);
    }
    return list;
  }
}
