import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Tick } from '@otv/shared';
import { istToEpoch } from '@otv/shared';
import { describe, expect, it } from 'vitest';
import { encodeTickFrame, HEARTBEAT_FRAME } from '../src/mock/tickEncoder';
import { loadRecording, ReplayProducer, TickRecorder } from '../src/ticker/recorder';

const t0 = istToEpoch(2026, 10, 12, 10, 0);
const tick = (i: number): Tick => ({
  token: 738561,
  mode: 'full',
  tradable: true,
  lastPrice: 1400 + i,
  volume: 1000 + i * 10,
  lastQuantity: 1,
  ohlc: { open: 1400, high: 1400 + i, low: 1400, close: 1390 },
  lastTradeTime: t0 / 1000 + i,
  exchangeTime: t0 / 1000 + i,
  oi: 0,
  oiDayHigh: 0,
  oiDayLow: 0,
  averagePrice: 1400,
  buyQuantity: 1,
  sellQuantity: 1,
  receivedAt: 0,
});

describe('tick recorder and replay', () => {
  it('records raw frames per IST day (skipping heartbeats) and replays them in time order', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'otv-rec-'));
    const rec = new TickRecorder(dir);
    for (let i = 0; i < 5; i++) {
      rec.write(encodeTickFrame([tick(i)]), true, t0 + i * 1000);
      rec.write(HEARTBEAT_FRAME, true, t0 + i * 1000 + 500);
    }
    rec.write(Buffer.from('{"type":"message","data":"hi"}'), false, t0 + 6000);
    rec.close();
    await new Promise((r) => setTimeout(r, 50));
    const files = readdirSync(dir);
    expect(files).toEqual(['ticks-2026-10-12.jsonl']);
    expect(readFileSync(path.join(dir, files[0]!), 'utf8').trim().split('\n')).toHaveLength(6);

    const ticks = await loadRecording(path.join(dir, files[0]!));
    expect(ticks.map((t) => t.lastPrice)).toEqual([1400, 1401, 1402, 1403, 1404]);
    expect(ticks[2]).toMatchObject({
      receivedAt: t0 + 2000,
      volume: 1020,
      exchangeTime: t0 / 1000 + 2,
    });

    const replay = new ReplayProducer(ticks);
    expect(replay.startsAt).toBe(t0);
    const subs = new Map([[738561, 'full' as const]]);
    expect(replay.produce(subs, t0 + 1500).map((t) => t.lastPrice)).toEqual([1400, 1401]);
    expect(replay.produce(new Map(), t0 + 2500)).toEqual([]); // not subscribed: skipped, not queued
    expect(replay.produce(subs, t0 + 10_000).map((t) => t.lastPrice)).toEqual([1403, 1404]);
  });
});
