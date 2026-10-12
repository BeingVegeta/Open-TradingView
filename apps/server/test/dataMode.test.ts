import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config';
import { claimDataMode, openDb } from '../src/db';

describe('live and mock data stay apart', () => {
  it('uses a separate data folder for mock mode by default', () => {
    expect(readConfig({ KITE_MODE: 'mock' }).dataDir).toMatch(/data[\\/]mock$/);
    expect(readConfig({ KITE_API_KEY: 'k', KITE_API_SECRET: 's' }).dataDir).toMatch(/data$/);
  });

  it('clears cached market data when the mode changes, keeping watchlists and prefs', () => {
    const db = openDb(':memory:');
    expect(claimDataMode(db, 'mock')).toBe(false);
    db.prepare(
      "INSERT INTO instruments VALUES ('NSE:X', 1, 'NSE', 'X', 'X', 'NSE', 'EQ', NULL, 0, 0.05, 1)",
    ).run();
    db.prepare("INSERT INTO candles VALUES ('NSE:X', 'minute', 1, 1, 1, 1, 1, 1, NULL)").run();
    db.prepare("INSERT INTO kv VALUES ('instruments_synced_at', '1'), ('prefs', '{}')").run();
    db.prepare("INSERT INTO watchlists (name, position) VALUES ('Mine', 0)").run();
    expect(claimDataMode(db, 'mock')).toBe(false);
    expect(claimDataMode(db, 'live')).toBe(true);
    const n = (t: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(n('instruments')).toBe(0);
    expect(n('candles')).toBe(0);
    expect(n('watchlists')).toBe(1);
    expect(db.prepare("SELECT v FROM kv WHERE k = 'prefs'").get()).toEqual({ v: '{}' });
    expect(db.prepare("SELECT v FROM kv WHERE k = 'instruments_synced_at'").get()).toBeUndefined();
  });
});
