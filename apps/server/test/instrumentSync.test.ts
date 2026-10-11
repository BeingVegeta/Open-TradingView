import { formatIstDateTime, istToEpoch } from '@otv/shared';
import { describe, expect, it } from 'vitest';
import { lastSyncBoundary } from '../src/instruments/instrumentSync';
import { MockKiteGateway } from '../src/kite/mockGateway';
import { HOST, makeApp } from './helpers';

describe('instrument sync schedule', () => {
  it('uses the most recent 08:30 IST as the staleness boundary', () => {
    expect(formatIstDateTime(lastSyncBoundary(istToEpoch(2026, 10, 12, 8, 29)))).toBe(
      '2026-10-11 08:30:00',
    );
    expect(formatIstDateTime(lastSyncBoundary(istToEpoch(2026, 10, 12, 8, 30)))).toBe(
      '2026-10-12 08:30:00',
    );
    expect(formatIstDateTime(lastSyncBoundary(istToEpoch(2026, 10, 12, 23, 0)))).toBe(
      '2026-10-12 08:30:00',
    );
  });

  it('syncs after login when stale, and not again until the next 08:30 IST', async () => {
    let now = istToEpoch(2026, 10, 12, 9, 0);
    const gateway = new MockKiteGateway({ now: () => now });
    const m = await makeApp({ gateway, now: () => now });
    try {
      m.sync.start();
      expect(m.sync.status()).toMatchObject({ count: 0, syncedAt: null });
      await m.auth.completeLogin(
        'mock-x',
        new URL(m.auth.beginLogin(), 'http://x').searchParams.get('state')!,
      );
      await m.sync.settled();
      expect(gateway.calls.instruments).toBe(1);
      expect(m.sync.status().count).toBeGreaterThan(50);

      now = istToEpoch(2026, 10, 13, 8, 0);
      await m.sync.syncIfStale();
      expect(gateway.calls.instruments).toBe(1);
      // The 06:00 expiry ended the session, so a stale list waits for the next login.
      now = istToEpoch(2026, 10, 13, 8, 31);
      await m.sync.syncIfStale();
      expect(gateway.calls.instruments).toBe(1);
      await m.auth.completeLogin(
        'mock-y',
        new URL(m.auth.beginLogin(), 'http://x').searchParams.get('state')!,
      );
      await m.sync.settled();
      expect(gateway.calls.instruments).toBe(2);

      const r = await m.server.inject({ url: '/api/instruments/search?q=infy', headers: HOST });
      expect(r.json().results[0].key).toBe('NSE:INFY');
    } finally {
      await m.server.close();
    }
  });
});
