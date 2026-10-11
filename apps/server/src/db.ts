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
