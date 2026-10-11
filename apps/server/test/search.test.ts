import { istToEpoch } from '@otv/shared';
import { describe, expect, it } from 'vitest';
import { InstrumentIndex } from '../src/instruments/search';
import { mockInstruments } from '../src/mock/instruments';

const index = new InstrumentIndex(
  mockInstruments(istToEpoch(2026, 10, 12, 10)).map((m) => m.instrument),
);
const keys = (q: string, opts = {}) => index.search(q, opts).map((i) => i.key);

describe('instrument search ranking', () => {
  it('puts NSE:RELIANCE first, then BSE, ahead of derivatives and lookalikes', () => {
    const r = keys('reliance');
    expect(r[0]).toBe('NSE:RELIANCE');
    expect(r[1]).toBe('BSE:RELIANCE');
    expect(r.indexOf('NFO:RELIANCE26OCTFUT')).toBeLessThan(r.indexOf('NSE:RELINFRA'));
    expect(r).toContain('NSE:RELINFRA'); // by name
  });

  it('finds indices by symbol with spaces and puts the index before futures', () => {
    expect(keys('NIFTY 50')[0]).toBe('NSE:NIFTY 50');
    expect(keys('nifty50')[0]).toBe('NSE:NIFTY 50');
    const r = keys('nifty');
    expect(r[0]).toBe('NSE:NIFTY 50');
    expect(r.indexOf('NSE:NIFTY BANK')).toBeLessThan(r.indexOf('NFO:NIFTY26OCTFUT'));
  });

  it('accepts EXCHANGE:SYMBOL', () => {
    expect(keys('BSE:RELIANCE')).toEqual(['BSE:RELIANCE']);
    expect(keys('NSE:REL')[0]).toBe('NSE:RELIANCE');
  });

  it('handles multi-word derivative queries, nearest expiry first', () => {
    const r = keys('nifty fut');
    expect(r.slice(0, 2)).toEqual(['NFO:NIFTY26OCTFUT', 'NFO:NIFTY26NOVFUT']);
    expect(keys('banknifty nov 56000 ce')).toEqual(['NFO:BANKNIFTY26NOV56000CE']);
  });

  it('filters by exchange and kind', () => {
    expect(index.search('nifty', { kinds: ['index'] }).every((i) => i.segment === 'INDICES')).toBe(
      true,
    );
    expect(
      index.search('a', { kinds: ['commodity'], limit: 50 }).every((i) => i.exchange === 'MCX'),
    ).toBe(true);
    expect(index.search('usdinr', { kinds: ['currency'] })[0]!.exchange).toBe('CDS');
    expect(index.search('tcs', { exchanges: ['BSE'] }).map((i) => i.key)).toEqual(['BSE:TCS']);
  });

  it('returns nothing for an empty query', () => {
    expect(keys('  ')).toEqual([]);
  });

  it('searches 120k instruments in a few milliseconds', () => {
    const base = mockInstruments(istToEpoch(2026, 10, 12, 10)).map((m) => m.instrument);
    const big = Array.from({ length: 1500 }, (_, k) =>
      base.map((i) => ({
        ...i,
        key: `${i.key}${k}`,
        tradingsymbol: `${i.tradingsymbol}${k}`,
        token: i.token + k,
      })),
    ).flat();
    const idx = new InstrumentIndex(big);
    expect(idx.size).toBeGreaterThan(120_000);
    const t0 = performance.now();
    for (const q of ['reliance', 'nifty', 'n', 'banknifty nov ce', 'NSE:INFY']) idx.search(q);
    expect((performance.now() - t0) / 5).toBeLessThan(60);
  });
});
