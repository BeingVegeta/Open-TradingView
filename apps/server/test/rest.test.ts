import { gzipSync } from 'node:zlib';
import { istToEpoch } from '@otv/shared';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/kite/csv';
import { parseInstrumentsCsv } from '../src/kite/instrumentsCsv';
import { LiveKiteGateway } from '../src/kite/liveGateway';
import { RateLimiter } from '../src/kite/rateLimiter';

const CSV = `instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange
738561,2885,RELIANCE,"RELIANCE INDUSTRIES",0,,,0.05,1,EQ,NSE,NSE
256265,1001,NIFTY 50,NIFTY 50,0,,0,0.0,0,EQ,INDICES,NSE
12517890,48937,NIFTY26OCTFUT,"NIFTY",0,2026-10-27,0,0.1,75,FUT,NFO-FUT,NFO
1,2,"ODD, NAME ""Q""",X,0,,,0.05,1,EQ,BSE,BSE
`;

describe('CSV parsing', () => {
  it('handles quotes, embedded commas and escaped quotes', () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n1,2,3\n')).toEqual([
      ['a', 'b,c', 'd "e"'],
      ['1', '2', '3'],
    ]);
  });

  it('parses the instrument master by header name', () => {
    const list = parseInstrumentsCsv(CSV);
    expect(list.map((i) => i.key)).toEqual([
      'NSE:RELIANCE',
      'NSE:NIFTY 50',
      'NFO:NIFTY26OCTFUT',
      'BSE:ODD, NAME "Q"',
    ]);
    expect(list[2]).toMatchObject({
      token: 12517890,
      expiry: '2026-10-27',
      lotSize: 75,
      tickSize: 0.1,
      segment: 'NFO-FUT',
    });
    expect(list[0]!.expiry).toBeNull();
  });
});

describe('KiteRestClient via LiveKiteGateway', () => {
  const fake = Fastify();
  const seen: { url: string; auth?: string }[] = [];
  let hits429 = 0;
  let root = '';

  beforeAll(async () => {
    fake.addHook('onRequest', async (req) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
    });
    fake.get('/instruments', async (_req, reply) => {
      // Served as a raw gzip body (not Content-Encoding) to check both paths.
      return reply.header('content-type', 'text/csv').send(gzipSync(CSV));
    });
    fake.get('/instruments/historical/:token/:interval', async (req, reply) => {
      const q = req.query as Record<string, string>;
      if ((req.params as { token: string }).token === '429' && hits429++ < 1) {
        return reply
          .code(429)
          .send({ status: 'error', error_type: 'NetworkException', message: 'Too many requests' });
      }
      if ((req.params as { token: string }).token === '403') {
        return reply.code(403).send({
          status: 'error',
          error_type: 'PermissionException',
          message: 'Insufficient permission for that call.',
        });
      }
      return {
        status: 'success',
        data: {
          candles: [
            [`${q.from!.slice(0, 10)}T09:15:00+0530`, 100, 101, 99, 100.5, 1000, 0],
            [`${q.from!.slice(0, 10)}T09:16:00+0530`, 100.5, 102, 100, 101, 500, 12],
          ],
        },
      };
    });
    root = await fake.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(() => fake.close());

  const gw = () =>
    new LiveKiteGateway(
      { apiKey: 'k', apiSecret: 's' },
      root,
      new RateLimiter({ quote: 100, historical: 100, default: 100 }),
    );
  const inst = (token: number) => ({
    key: 'NSE:X',
    token,
    exchange: 'NSE',
    tradingsymbol: 'X',
    name: 'X',
    segment: 'NSE',
    instrumentType: 'EQ',
    expiry: null,
    strike: 0,
    tickSize: 0.05,
    lotSize: 1,
  });

  it('downloads and parses the gzipped instrument dump', async () => {
    const list = await gw().fetchInstruments('tok');
    expect(list).toHaveLength(4);
    expect(seen.at(-1)!.auth).toBe('token k:tok');
  });

  it('sends IST from/to strings with an inclusive end, and keeps OI zeros', async () => {
    const from = istToEpoch(2026, 10, 12, 9, 15) / 1000;
    const candles = await gw().fetchHistory('tok', {
      instrument: inst(5),
      interval: 'minute',
      from,
      to: from + 3600,
      oi: true,
    });
    const q = new URL(seen.at(-1)!.url, 'http://x').searchParams;
    expect(q.get('from')).toBe('2026-10-12 09:15:00');
    expect(q.get('to')).toBe('2026-10-12 10:14:59');
    expect(q.get('oi')).toBe('1');
    expect(candles).toEqual([
      { time: from, open: 100, high: 101, low: 99, close: 100.5, volume: 1000, oi: 0 },
      { time: from + 60, open: 100.5, high: 102, low: 100, close: 101, volume: 500, oi: 12 },
    ]);
  });

  it('retries after a 429', async () => {
    const before = seen.length;
    const from = istToEpoch(2026, 10, 12, 9, 15) / 1000;
    const c = await gw().fetchHistory('tok', {
      instrument: inst(429),
      interval: 'minute',
      from,
      to: from + 3600,
    });
    expect(c).toHaveLength(2);
    expect(seen.length - before).toBe(2);
  });

  it('surfaces a permission error without retrying', async () => {
    const before = seen.length;
    const from = istToEpoch(2026, 10, 12, 9, 15) / 1000;
    const err = await gw()
      .fetchHistory('tok', { instrument: inst(403), interval: 'minute', from, to: from + 60 })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'permission', status: 403 });
    expect(seen.length - before).toBe(1);
  });
});
