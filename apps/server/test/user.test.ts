import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_WATCHLIST } from '../src/user/watchlistStore';
import { HOST, makeApp } from './helpers';

type Made = Awaited<ReturnType<typeof makeApp>>;
let made: Made | undefined;
afterEach(async () => {
  await made?.server.close();
  made = undefined;
});

const json = { ...HOST, 'content-type': 'application/json' };

describe('watchlists and prefs', () => {
  it('creates a default watchlist, then supports create / rename / reorder / delete', async () => {
    made = await makeApp();
    const s = made.server;
    const lists = (await s.inject({ url: '/api/watchlists', headers: HOST })).json();
    expect(lists).toEqual([{ id: 1, name: 'Watchlist', items: DEFAULT_WATCHLIST }]);

    const created = (
      await s.inject({
        method: 'POST',
        url: '/api/watchlists',
        headers: json,
        payload: { name: ' Banks ', items: ['NSE:SBIN', 'NSE:SBIN', 'NSE:ICICIBANK'] },
      })
    ).json();
    expect(created).toEqual({ id: 2, name: 'Banks', items: ['NSE:SBIN', 'NSE:ICICIBANK'] });

    const patched = (
      await s.inject({
        method: 'PATCH',
        url: '/api/watchlists/2',
        headers: json,
        payload: { name: 'PSU', items: ['NSE:ICICIBANK', 'NSE:SBIN', 'NSE:PNB'] },
      })
    ).json();
    expect(patched).toEqual({
      id: 2,
      name: 'PSU',
      items: ['NSE:ICICIBANK', 'NSE:SBIN', 'NSE:PNB'],
    });

    expect(
      (
        await s.inject({
          method: 'PATCH',
          url: '/api/watchlists/2',
          headers: json,
          payload: { items: [1, 2] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await s.inject({ method: 'PATCH', url: '/api/watchlists/99', headers: json, payload: {} }))
        .statusCode,
    ).toBe(404);

    const after = (
      await s.inject({ method: 'DELETE', url: '/api/watchlists/2', headers: json, payload: {} })
    ).json();
    expect(after.map((w: { id: number }) => w.id)).toEqual([1]);
  });

  it('recreates a default list when the last one is deleted', async () => {
    made = await makeApp();
    await made.server.inject({ url: '/api/watchlists', headers: HOST });
    await made.server.inject({
      method: 'DELETE',
      url: '/api/watchlists/1',
      headers: json,
      payload: {},
    });
    const lists = (await made.server.inject({ url: '/api/watchlists', headers: HOST })).json();
    expect(lists).toHaveLength(1);
    expect(lists[0].items).toEqual(DEFAULT_WATCHLIST);
  });

  it('stores prefs as an object with a size limit, and persists them', async () => {
    made = await makeApp();
    const s = made.server;
    expect((await s.inject({ url: '/api/prefs', headers: HOST })).json()).toEqual({});
    const prefs = { symbol: 'NSE:INFY', tf: '15m', indicators: [{ type: 'ema', period: 50 }] };
    expect(
      (await s.inject({ method: 'PUT', url: '/api/prefs', headers: json, payload: prefs }))
        .statusCode,
    ).toBe(200);
    expect((await s.inject({ url: '/api/prefs', headers: HOST })).json()).toEqual(prefs);
    expect(
      (await s.inject({ method: 'PUT', url: '/api/prefs', headers: json, payload: [1] }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await s.inject({
          method: 'PUT',
          url: '/api/prefs',
          headers: json,
          payload: { big: 'x'.repeat(40_000) },
        })
      ).statusCode,
    ).toBe(413);

    const db = made.db;
    await s.close();
    made = await makeApp({ db });
    expect((await made.server.inject({ url: '/api/prefs', headers: HOST })).json()).toEqual(prefs);
  });
});
