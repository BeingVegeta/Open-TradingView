import { describe, expect, it } from 'vitest';
import { formatIstDateTime, istStartOfDay, istToEpoch, nextTokenExpiry, toIstParts } from './time';

describe('IST helpers', () => {
  it('runs under a non-IST machine timezone (guards the rest of the suite)', () => {
    expect(new Date(0).getTimezoneOffset()).not.toBe(-330);
  });

  it('converts IST wall-clock time to the right UTC instant', () => {
    // 09:15 IST == 03:45 UTC
    expect(new Date(istToEpoch(2026, 10, 12, 9, 15)).toISOString()).toBe(
      '2026-10-12T03:45:00.000Z',
    );
  });

  it('reads IST fields independent of the machine timezone', () => {
    // 2026-10-11T20:00Z is 01:30 on the 12th in IST (a Monday)
    const p = toIstParts(Date.parse('2026-10-11T20:00:00Z'));
    expect(p).toEqual({
      year: 2026,
      month: 10,
      day: 12,
      hour: 1,
      minute: 30,
      second: 0,
      weekday: 1,
    });
  });

  it('formats in Kite historical-API format', () => {
    expect(formatIstDateTime(Date.parse('2026-10-11T20:00:05Z'))).toBe('2026-10-12 01:30:05');
  });

  it('finds the start of the IST day', () => {
    expect(new Date(istStartOfDay(Date.parse('2026-10-11T20:00:00Z'))).toISOString()).toBe(
      '2026-10-11T18:30:00.000Z',
    );
  });
});

describe('nextTokenExpiry', () => {
  const at = (h: number, m = 0, day = 12) => istToEpoch(2026, 10, day, h, m);

  it('expires at 06:00 IST the next day for a daytime login', () => {
    expect(nextTokenExpiry(at(9, 0))).toBe(at(6, 0, 13));
  });

  it('expires the same morning for a login between midnight and 06:00 IST', () => {
    expect(nextTokenExpiry(at(2, 30))).toBe(at(6, 0, 12));
  });

  it('treats exactly 06:00 as the start of a new token day', () => {
    expect(nextTokenExpiry(at(6, 0))).toBe(at(6, 0, 13));
  });

  it('rolls across month ends', () => {
    expect(nextTokenExpiry(istToEpoch(2026, 10, 31, 22))).toBe(istToEpoch(2026, 11, 1, 6));
  });
});
