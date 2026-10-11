import type { Watchlist } from '@otv/shared';
import type { Db } from '../db';

export const DEFAULT_WATCHLIST = [
  'NSE:NIFTY 50',
  'NSE:NIFTY BANK',
  'NSE:RELIANCE',
  'NSE:HDFCBANK',
  'NSE:INFY',
  'NSE:TCS',
];
export const MAX_ITEMS = 250;
export const MAX_LISTS = 20;

/** Watchlists in SQLite. There is always at least one. */
export class WatchlistStore {
  constructor(private readonly db: Db) {}

  all(): Watchlist[] {
    let lists = this.db.prepare('SELECT id, name FROM watchlists ORDER BY position, id').all() as {
      id: number;
      name: string;
    }[];
    if (!lists.length) {
      this.create('Watchlist', DEFAULT_WATCHLIST);
      lists = this.db.prepare('SELECT id, name FROM watchlists ORDER BY position, id').all() as {
        id: number;
        name: string;
      }[];
    }
    const items = this.db.prepare(
      'SELECT ikey FROM watchlist_items WHERE watchlist_id = ? ORDER BY position',
    );
    return lists.map((l) => ({
      ...l,
      items: (items.all(l.id) as { ikey: string }[]).map((r) => r.ikey),
    }));
  }

  get(id: number): Watchlist | undefined {
    return this.all().find((w) => w.id === id);
  }

  create(name: string, items: string[] = []): Watchlist {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM watchlists').get() as { n: number })
      .n;
    if (count >= MAX_LISTS) throw new RangeError(`At most ${MAX_LISTS} watchlists`);
    const id = this.db.transaction(() => {
      const r = this.db
        .prepare('INSERT INTO watchlists (name, position) VALUES (?, ?)')
        .run(cleanName(name), count);
      const id = Number(r.lastInsertRowid);
      this.writeItems(id, items);
      return id;
    })();
    return this.get(id)!;
  }

  update(id: number, patch: { name?: string; items?: string[] }): Watchlist | undefined {
    if (!this.db.prepare('SELECT 1 FROM watchlists WHERE id = ?').get(id)) return undefined;
    this.db.transaction(() => {
      if (patch.name !== undefined)
        this.db
          .prepare('UPDATE watchlists SET name = ? WHERE id = ?')
          .run(cleanName(patch.name), id);
      if (patch.items) this.writeItems(id, patch.items);
    })();
    return this.get(id);
  }

  remove(id: number): boolean {
    return this.db.prepare('DELETE FROM watchlists WHERE id = ?').run(id).changes > 0;
  }

  private writeItems(id: number, items: string[]): void {
    const unique = [...new Set(items.map((k) => k.trim()).filter(Boolean))].slice(0, MAX_ITEMS);
    this.db.prepare('DELETE FROM watchlist_items WHERE watchlist_id = ?').run(id);
    const ins = this.db.prepare(
      'INSERT INTO watchlist_items (watchlist_id, ikey, position) VALUES (?, ?, ?)',
    );
    unique.forEach((k, i) => ins.run(id, k, i));
  }
}

function cleanName(name: string): string {
  const n = name.trim().slice(0, 40);
  return n || 'Watchlist';
}
