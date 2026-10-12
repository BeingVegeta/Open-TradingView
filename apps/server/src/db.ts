import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * Ordered schema migrations. Append only — never edit an entry that has shipped.
 * The array index + 1 is the schema version stored in `PRAGMA user_version`.
 */
const MIGRATIONS: string[] = [
  // 1: the single Kite session (one user, one API key).
  `CREATE TABLE session (
     id            INTEGER PRIMARY KEY CHECK (id = 1),
     api_key       TEXT    NOT NULL,
     access_token  TEXT    NOT NULL,
     user_id       TEXT    NOT NULL,
     user_name     TEXT    NOT NULL,
     user_shortname TEXT,
     email         TEXT,
     broker        TEXT,
     login_time    INTEGER NOT NULL,
     expires_at    INTEGER NOT NULL
   );`,
  // 2: instrument master, key/value metadata and the candle cache.
  `CREATE TABLE instruments (
     key             TEXT PRIMARY KEY,
     token           INTEGER NOT NULL,
     exchange        TEXT NOT NULL,
     tradingsymbol   TEXT NOT NULL,
     name            TEXT NOT NULL,
     segment         TEXT NOT NULL,
     instrument_type TEXT NOT NULL,
     expiry          TEXT,
     strike          REAL NOT NULL,
     tick_size       REAL NOT NULL,
     lot_size        INTEGER NOT NULL
   ) WITHOUT ROWID;
   CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
   -- Candles are keyed by EXCHANGE:TRADINGSYMBOL, never by the reusable numeric token.
   CREATE TABLE candles (
     ikey     TEXT    NOT NULL,
     interval TEXT    NOT NULL,
     t        INTEGER NOT NULL,
     o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
     v INTEGER NOT NULL,
     oi INTEGER,
     PRIMARY KEY (ikey, interval, t)
   ) WITHOUT ROWID;
   -- Time ranges [from_t, to_t) known to be completely cached (settled data only).
   CREATE TABLE candle_coverage (
     ikey     TEXT    NOT NULL,
     interval TEXT    NOT NULL,
     from_t   INTEGER NOT NULL,
     to_t     INTEGER NOT NULL,
     PRIMARY KEY (ikey, interval, from_t)
   ) WITHOUT ROWID;
   -- Per cached series: the token it was fetched with, and where its data begins if known.
   CREATE TABLE candle_series (
     ikey       TEXT    NOT NULL,
     interval   TEXT    NOT NULL,
     token      INTEGER NOT NULL,
     data_start INTEGER,
     PRIMARY KEY (ikey, interval)
   ) WITHOUT ROWID;`,
  // 3: watchlists.
  `CREATE TABLE watchlists (
     id       INTEGER PRIMARY KEY,
     name     TEXT    NOT NULL,
     position INTEGER NOT NULL
   );
   CREATE TABLE watchlist_items (
     watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
     ikey         TEXT    NOT NULL,
     position     INTEGER NOT NULL,
     PRIMARY KEY (watchlist_id, ikey)
   ) WITHOUT ROWID;`,
  // 4: chart drawings, per instrument.
  `CREATE TABLE drawings (
     ikey TEXT PRIMARY KEY,
     json TEXT NOT NULL
   ) WITHOUT ROWID;`,
];

export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

/** Opens (creating if needed) the app database. Pass `':memory:'` in tests. */
export function openDb(dataDir: string | ':memory:'): Db {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    // The database holds the access token: keep the directory private to this user.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dataDir, 0o700);
    } catch {
      // Not fatal (e.g. on filesystems without POSIX permissions).
    }
    file = path.join(dataDir, 'otv.sqlite');
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/**
 * Records which mode (live/mock) filled this database's market data. If it was
 * filled in the other mode, the instrument list, candle cache and session are
 * dropped (watchlists and layout are kept), so synthetic candles can never be
 * shown as real ones or vice versa. Returns true if anything was cleared.
 */
export function claimDataMode(db: Db, mode: string): boolean {
  const row = db.prepare("SELECT v FROM kv WHERE k = 'data_mode'").get() as
    { v: string } | undefined;
  let cleared = false;
  if (row && row.v !== mode) {
    db.transaction(() => {
      for (const t of ['instruments', 'candles', 'candle_coverage', 'candle_series', 'session'])
        db.prepare(`DELETE FROM ${t}`).run();
      db.prepare("DELETE FROM kv WHERE k = 'instruments_synced_at'").run();
    })();
    cleared = true;
  }
  db.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('data_mode', ?)").run(mode);
  return cleared;
}
