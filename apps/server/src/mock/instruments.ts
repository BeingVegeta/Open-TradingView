import {
  DAY_MS,
  instrumentKey,
  istStartOfDay,
  istToEpoch,
  toIstParts,
  type Instrument,
} from '@otv/shared';
import { stringSeed } from './random';
import type { SynthSpec } from './synth';

export interface MockInstrument {
  instrument: Instrument;
  spec: SynthSpec;
}

interface Base {
  symbol: string;
  name: string;
  price: number;
  vol?: number;
  /** Shares per minute. */
  volume?: number;
  listed?: string;
}

const NSE_EQUITIES: Base[] = [
  { symbol: 'RELIANCE', name: 'RELIANCE INDUSTRIES', price: 1380, volume: 18000 },
  { symbol: 'TCS', name: 'TATA CONSULTANCY SERV LT', price: 3050, volume: 5000 },
  { symbol: 'INFY', name: 'INFOSYS', price: 1480, volume: 15000 },
  { symbol: 'HDFCBANK', name: 'HDFC BANK', price: 960, volume: 30000 },
  { symbol: 'ICICIBANK', name: 'ICICI BANK', price: 1360, volume: 20000 },
  { symbol: 'SBIN', name: 'STATE BANK OF INDIA', price: 860, volume: 25000 },
  { symbol: 'ITC', name: 'ITC', price: 405, volume: 30000 },
  { symbol: 'LT', name: 'LARSEN & TOUBRO', price: 3700, volume: 4000 },
  { symbol: 'BHARTIARTL', name: 'BHARTI AIRTEL', price: 1920, volume: 9000 },
  { symbol: 'KOTAKBANK', name: 'KOTAK MAHINDRA BANK', price: 2050, volume: 6000 },
  { symbol: 'AXISBANK', name: 'AXIS BANK', price: 1150, volume: 12000 },
  { symbol: 'BAJFINANCE', name: 'BAJAJ FINANCE', price: 1010, volume: 10000 },
  { symbol: 'MARUTI', name: 'MARUTI SUZUKI INDIA', price: 16200, volume: 900 },
  { symbol: 'TITAN', name: 'TITAN COMPANY', price: 3550, volume: 2500 },
  { symbol: 'WIPRO', name: 'WIPRO', price: 245, volume: 20000 },
  { symbol: 'SUNPHARMA', name: 'SUN PHARMACEUTICAL IND L', price: 1630, volume: 5000 },
  { symbol: 'ADANIENT', name: 'ADANI ENTERPRISES', price: 2450, volume: 4000, vol: 0.025 },
  { symbol: 'TATASTEEL', name: 'TATA STEEL', price: 170, volume: 60000 },
  // Lookalikes, to check that search ranks the obvious match first.
  { symbol: 'RELINFRA', name: 'RELIANCE INFRASTRUCTU', price: 300, volume: 8000, vol: 0.03 },
  { symbol: 'RELCHEMQ', name: 'RELIANCE CHEMOTEX IND', price: 160, volume: 300, vol: 0.03 },
  { symbol: 'RPOWER', name: 'RELIANCE POWER', price: 42, volume: 90000, vol: 0.035 },
  { symbol: 'NIFTYBEES', name: 'NIP IND ETF NIFTY BEES', price: 285, volume: 20000, vol: 0.01 },
  // Recently listed: scroll-back must stop at its first day instead of looping.
  {
    symbol: 'NEWLISTCO',
    name: 'NEW LISTING COMPANY',
    price: 520,
    volume: 7000,
    vol: 0.03,
    listed: '2026-06-15',
  },
];

const NSE_INDICES: Base[] = [
  { symbol: 'NIFTY 50', name: 'NIFTY 50', price: 25100, vol: 0.009 },
  { symbol: 'NIFTY BANK', name: 'NIFTY BANK', price: 56200, vol: 0.011 },
  { symbol: 'NIFTY IT', name: 'NIFTY IT', price: 35400, vol: 0.013 },
  { symbol: 'INDIA VIX', name: 'INDIA VIX', price: 11.5, vol: 0.05 },
];

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Last given weekday (0=Sun) of an IST month, as epoch ms of 00:00 IST. */
function lastWeekdayOfMonth(year: number, month: number, weekday: number): number {
  let d = istToEpoch(year, month + 1, 0); // day 0 of next month = last day of this month
  while (toIstParts(d).weekday !== weekday) d -= DAY_MS;
  return d;
}

function ymd(ms: number): string {
  const p = toIstParts(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The next `count` monthly expiries (last Tuesday) on or after today. */
function monthlyExpiries(nowMs: number, count: number, weekday = 2): number[] {
  const p = toIstParts(nowMs);
  const out: number[] = [];
  const today = istStartOfDay(nowMs);
  for (let k = 0; out.length < count; k++) {
    const y = p.year + Math.floor((p.month - 1 + k) / 12);
    const m = ((p.month - 1 + k) % 12) + 1;
    const e = lastWeekdayOfMonth(y, m, weekday);
    if (e >= today) out.push(e);
  }
  return out;
}

/** Kite's segment codes, carried in the low byte of every instrument token. */
const SEGMENT_CODE: Record<string, number> = {
  NSE: 1,
  NFO: 2,
  CDS: 3,
  BSE: 4,
  BFO: 5,
  BCD: 6,
  MCX: 7,
  INDICES: 9,
};

/** Stable Kite-shaped token: (exchange token << 8) | segment code, as the ticker parser expects. */
function tokenFor(key: string, segment: string, exchange: string): number {
  const code = SEGMENT_CODE[segment === 'INDICES' ? 'INDICES' : exchange] ?? 1;
  const exchangeToken = 1000 + (stringSeed(key) % 60_000);
  return exchangeToken * 256 + code;
}

function parseDate(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  return istToEpoch(y!, m!, d!);
}

const DEFAULT_LISTED = istToEpoch(2008, 1, 1);

/**
 * A small, realistic instrument universe for mock mode: NSE/BSE equities and
 * indices, NFO futures and options, MCX and currency futures. Derivative
 * expiries are generated relative to `nowMs` so the list never goes stale.
 */
export function mockInstruments(nowMs: number): MockInstrument[] {
  const out: MockInstrument[] = [];
  const add = (
    i: Omit<Instrument, 'key' | 'token'>,
    spec: Omit<SynthSpec, 'seed' | 'exchange' | 'tickSize' | 'listedOn' | 'delistedAfter'> & {
      seedKey?: string;
      listedOn?: number;
      delistedAfter?: number;
    },
  ) => {
    const key = instrumentKey(i.exchange, i.tradingsymbol);
    out.push({
      instrument: { key, token: tokenFor(key, i.segment, i.exchange), ...i },
      spec: {
        seed: stringSeed(spec.seedKey ?? key),
        exchange: i.exchange,
        basePrice: spec.basePrice,
        dailyVol: spec.dailyVol,
        volumePerMinute: spec.volumePerMinute,
        oiBase: spec.oiBase,
        tickSize: i.tickSize,
        listedOn: spec.listedOn ?? DEFAULT_LISTED,
        delistedAfter: spec.delistedAfter ?? Infinity,
      },
    });
  };
  const eq = (exchange: string, b: Base, volumeScale = 1) =>
    add(
      {
        exchange,
        tradingsymbol: b.symbol,
        name: b.name,
        segment: exchange,
        instrumentType: 'EQ',
        expiry: null,
        strike: 0,
        tickSize: b.price < 1 ? 0.01 : 0.05,
        lotSize: 1,
      },
      {
        // BSE and NSE listings of a stock move together.
        seedKey: `EQ:${b.symbol}`,
        basePrice: b.price,
        dailyVol: b.vol ?? 0.016,
        volumePerMinute: (b.volume ?? 5000) * volumeScale,
        oiBase: 0,
        ...(b.listed ? { listedOn: parseDate(b.listed) } : {}),
      },
    );

  for (const b of NSE_EQUITIES) eq('NSE', b);
  for (const sym of ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'SBIN']) {
    eq(
      'BSE',
      NSE_EQUITIES.find((b) => b.symbol === sym)!,
      0.08,
    );
  }

  const index = (exchange: string, b: Base) =>
    add(
      {
        exchange,
        tradingsymbol: b.symbol,
        name: b.name,
        segment: 'INDICES',
        instrumentType: 'EQ',
        expiry: null,
        strike: 0,
        tickSize: 0.05,
        lotSize: 0,
      },
      {
        seedKey: `IDX:${b.symbol}`,
        basePrice: b.price,
        dailyVol: b.vol ?? 0.01,
        volumePerMinute: 0,
        oiBase: 0,
      },
    );
  for (const b of NSE_INDICES) index('NSE', b);
  index('BSE', { symbol: 'SENSEX', name: 'SENSEX', price: 82000, vol: 0.009 });

  // Derivatives: monthly futures for two expiries, a few options strikes.
  const [e1, e2] = monthlyExpiries(nowMs, 2);
  const underlyings = [
    { sym: 'NIFTY', seedKey: 'IDX:NIFTY 50', price: 25100, lot: 75, vol: 0.009 },
    { sym: 'BANKNIFTY', seedKey: 'IDX:NIFTY BANK', price: 56200, lot: 35, vol: 0.011 },
    { sym: 'RELIANCE', seedKey: 'EQ:RELIANCE', price: 1380, lot: 500, vol: 0.016 },
  ];
  for (const exp of [e1!, e2!]) {
    const p = toIstParts(exp);
    const tag = `${String(p.year).slice(2)}${MONTHS[p.month - 1]}`;
    // Contracts trade for about three months before expiry.
    const listedOn = exp - 92 * DAY_MS;
    for (const u of underlyings) {
      add(
        {
          exchange: 'NFO',
          tradingsymbol: `${u.sym}${tag}FUT`,
          name: u.sym,
          segment: 'NFO-FUT',
          instrumentType: 'FUT',
          expiry: ymd(exp),
          strike: 0,
          tickSize: u.price > 10000 ? 0.1 : 0.05,
          lotSize: u.lot,
        },
        {
          seedKey: u.seedKey,
          basePrice: u.price * 1.004,
          dailyVol: u.vol,
          volumePerMinute: 3000,
          oiBase: 12_000_000,
          listedOn,
          delistedAfter: exp + DAY_MS,
        },
      );
      if (u.sym === 'RELIANCE') continue;
      const step = u.sym === 'NIFTY' ? 100 : 500;
      const atm = Math.round(u.price / step) * step;
      for (let k = -2; k <= 2; k++) {
        const strike = atm + k * step;
        for (const type of ['CE', 'PE'] as const) {
          add(
            {
              exchange: 'NFO',
              tradingsymbol: `${u.sym}${tag}${strike}${type}`,
              name: u.sym,
              segment: 'NFO-OPT',
              instrumentType: type,
              expiry: ymd(exp),
              strike,
              tickSize: 0.05,
              lotSize: u.lot,
            },
            {
              basePrice: Math.max(20, u.price * 0.012 - (type === 'CE' ? k : -k) * step * 0.35),
              dailyVol: 0.12,
              volumePerMinute: 20000,
              oiBase: 3_000_000,
              listedOn,
              delistedAfter: exp + DAY_MS,
            },
          );
        }
      }
    }
  }

  // Commodities and currency (different sessions: 09:00 open).
  const [m1] = monthlyExpiries(nowMs, 1, 4);
  const mt = toIstParts(m1!);
  const mtag = `${String(mt.year).slice(2)}${MONTHS[mt.month - 1]}`;
  for (const c of [
    { sym: 'CRUDEOIL', price: 5600, lot: 100, tick: 1, vol: 0.02 },
    { sym: 'GOLD', price: 118000, lot: 1, tick: 1, vol: 0.009 },
    { sym: 'SILVER', price: 146000, lot: 30, tick: 1, vol: 0.015 },
  ]) {
    add(
      {
        exchange: 'MCX',
        tradingsymbol: `${c.sym}${mtag}FUT`,
        name: c.sym,
        segment: 'MCX-FUT',
        instrumentType: 'FUT',
        expiry: ymd(m1!),
        strike: 0,
        tickSize: c.tick,
        lotSize: c.lot,
      },
      {
        basePrice: c.price,
        dailyVol: c.vol,
        volumePerMinute: 400,
        oiBase: 20_000,
        listedOn: m1! - 180 * DAY_MS,
        delistedAfter: m1! + DAY_MS,
      },
    );
  }
  add(
    {
      exchange: 'CDS',
      tradingsymbol: `USDINR${mtag}FUT`,
      name: 'USDINR',
      segment: 'CDS-FUT',
      instrumentType: 'FUT',
      expiry: ymd(m1!),
      strike: 0,
      tickSize: 0.0025,
      lotSize: 1,
    },
    {
      basePrice: 88.7,
      dailyVol: 0.003,
      volumePerMinute: 5000,
      oiBase: 2_000_000,
      listedOn: m1! - 365 * DAY_MS,
      delistedAfter: m1! + DAY_MS,
    },
  );
  return out;
}
