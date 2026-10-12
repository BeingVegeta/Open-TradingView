import { instrumentSession, istToEpoch, type Instrument } from '@otv/shared';
import { describe, expect, it } from 'vitest';
import { InstrumentIndex, markClosingAuction } from '../src/instruments/search';
import { parseInstrumentsCsv } from '../src/kite/instrumentsCsv';
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

describe('closing auction flag', () => {
  it('marks NSE/BSE stocks with futures on NFO or BFO, and nothing else', () => {
    const inst = (exchange: string, sym: string, extra: Partial<Instrument> = {}): Instrument => ({
      key: `${exchange}:${sym}`,
      token: Math.floor(Math.random() * 1e9),
      exchange,
      tradingsymbol: sym,
      name: sym,
      segment: exchange,
      instrumentType: 'EQ',
      expiry: null,
      strike: 0,
      tickSize: 0.05,
      lotSize: 1,
      ...extra,
    });
    const list = [
      inst('NSE', 'RELIANCE', { name: 'RELIANCE INDUSTRIES' }),
      inst('BSE', 'RELIANCE', { name: 'RELIANCE INDUSTRIES' }),
      inst('NSE', 'SMALLCO'),
      inst('NSE', 'NIFTY 50', { segment: 'INDICES' }),
      inst('NFO', 'RELIANCE26OCTFUT', {
        name: 'RELIANCE',
        segment: 'NFO-FUT',
        instrumentType: 'FUT',
      }),
      inst('NFO', 'NIFTY26OCTFUT', { name: 'NIFTY', segment: 'NFO-FUT', instrumentType: 'FUT' }),
      inst('BFO', 'BSEONLY26OCTFUT', {
        name: 'BSEONLY',
        segment: 'BFO-FUT',
        instrumentType: 'FUT',
      }),
      inst('BSE', 'BSEONLY'),
    ];
    markClosingAuction(list);
    const flagged = list.filter((i) => i.closingAuction).map((i) => i.key);
    expect(flagged).toEqual(['NSE:RELIANCE', 'BSE:RELIANCE', 'BSE:BSEONLY']);
  });
});

describe('closing auction flag from the instrument dump', () => {
  // Rows in Kite's CSV format. Futures carry the underlying in `name`; the
  // tradingsymbol (M&M26OCTFUT) is never parsed.
  const csv = [
    'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
    '519937,2031,M&M,"MAHINDRA & MAHINDRA",0,,0,0.1,1,EQ,NSE,NSE',
    '12345601,48225,M&M26OCTFUT,"M&M",0,2026-10-27,0,0.1,200,FUT,NFO-FUT,NFO',
    '12345602,48226,M&M26OCT3500CE,"M&M",0,2026-10-27,3500,0.05,200,CE,NFO-OPT,NFO',
    '4267265,16669,BAJAJ-AUTO,"BAJAJ AUTO",0,,0,0.5,1,EQ,NSE,NSE',
    '12345603,48227,BAJAJ-AUTO26OCTFUT,"BAJAJ-AUTO",0,2026-10-27,0,0.5,75,FUT,NFO-FUT,NFO',
    // IDEA has futures; IDEAFORGE (IDEA is a prefix of it) does not.
    '3677697,14366,IDEA,"VODAFONE IDEA",0,,0,0.01,1,EQ,NSE,NSE',
    '12345604,48228,IDEA26OCTFUT,"IDEA",0,2026-10-27,0,0.01,70000,FUT,NFO-FUT,NFO',
    '7458561,29136,IDEAFORGE,"IDEAFORGE TECHNOLOGY",0,,0,0.05,1,EQ,NSE,NSE',
    // TATA is a prefix of an F&O stock's name but has no futures of its own.
    '9999901,99001,TATA,"TATA EXAMPLE",0,,0,0.05,1,EQ,NSE,NSE',
    '12345605,48229,TATASTEEL26OCTFUT,"TATASTEEL",0,2026-10-27,0,0.01,5500,FUT,NFO-FUT,NFO',
    '895745,3499,TATASTEEL,"TATA STEEL",0,,0,0.01,1,EQ,NSE,NSE',
    // The same stock on BSE is an F&O stock too.
    '128083204,500520,M&M,"MAHINDRA & MAHINDRA",0,,0,0.05,1,EQ,BSE,BSE',
    // An index future doesn't flag an index.
    '256265,1024,NIFTY 50,"NIFTY 50",0,,0,0,0,EQ,INDICES,NSE',
    '12345606,48230,NIFTY26OCTFUT,"NIFTY",0,2026-10-27,0,0.1,75,FUT,NFO-FUT,NFO',
  ].join('\n');

  it('flags exactly the stocks whose symbol is a futures underlying', () => {
    const list = parseInstrumentsCsv(csv);
    markClosingAuction(list);
    expect(
      list
        .filter((i) => i.closingAuction)
        .map((i) => i.key)
        .sort(),
    ).toEqual(['BSE:M&M', 'NSE:BAJAJ-AUTO', 'NSE:IDEA', 'NSE:M&M', 'NSE:TATASTEEL']);
    const session = (key: string) => instrumentSession(list.find((i) => i.key === key)!).close;
    expect(session('NSE:M&M')).toBe(15 * 60 + 15);
    expect(session('NSE:IDEAFORGE')).toBe(15 * 60 + 30);
    expect(session('NSE:TATA')).toBe(15 * 60 + 30);
  });
});
