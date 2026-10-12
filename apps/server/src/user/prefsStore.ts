import type { Prefs } from '@otv/shared';
import type { Db } from '../db';

const KEY = 'prefs';
export const MAX_PREFS_BYTES = 32 * 1024;

/** The browser's saved layout and last symbol, kept server-side so it survives browsers and devices. */
export class PrefsStore {
  constructor(private readonly db: Db) {}

  get(): Prefs {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(KEY) as
      { v: string } | undefined;
    if (!row) return {};
    try {
      return JSON.parse(row.v) as Prefs;
    } catch {
      return {};
    }
  }

  set(p: Prefs): void {
    const json = JSON.stringify(p);
    if (json.length > MAX_PREFS_BYTES) throw new RangeError('Preferences too large');
    this.db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(KEY, json);
  }
}
