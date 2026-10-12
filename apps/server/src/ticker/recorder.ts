import { createReadStream, createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { formatIstDateTime, type Tick, type TickMode } from '@otv/shared';
import type { TickProducer } from '../mock/localTickerServer';
import { parseTickFrame } from './tickParser';

/**
 * Records raw upstream ticker frames as JSON lines:
 *   {"t": <epoch ms received>, "b": "<base64 binary frame>"}   or   {"t": …, "s": "<text frame>"}
 * One file per IST day under data/recordings/ (git-ignored: Zerodha's terms forbid
 * redistributing market data). Heartbeats are skipped.
 */
export class TickRecorder {
  private out: WriteStream | null = null;
  private day = '';

  constructor(private readonly dir: string) {}

  write(data: Buffer, isBinary: boolean, receivedAt: number): void {
    if (isBinary && data.length <= 2) return;
    const day = formatIstDateTime(receivedAt).slice(0, 10);
    if (day !== this.day || !this.out) {
      this.out?.end();
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.out = createWriteStream(path.join(this.dir, `ticks-${day}.jsonl`), {
        flags: 'a',
        mode: 0o600,
      });
      this.day = day;
    }
    const line = isBinary
      ? { t: receivedAt, b: data.toString('base64') }
      : { t: receivedAt, s: data.toString('utf8') };
    this.out.write(JSON.stringify(line) + '\n');
  }

  close(): void {
    this.out?.end();
    this.out = null;
  }
}

/** Reads a recording (optionally .gz) into ticks ordered by arrival time. */
export async function loadRecording(file: string): Promise<Tick[]> {
  const input = createReadStream(file);
  const rl = createInterface({
    input: file.endsWith('.gz') ? input.pipe(createGunzip()) : input,
    crlfDelay: Infinity,
  });
  const ticks: Tick[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as { t: number; b?: string };
    if (!rec.b) continue;
    const buf = Buffer.from(rec.b, 'base64');
    ticks.push(
      ...parseTickFrame(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
        rec.t,
      ),
    );
  }
  ticks.sort((a, b) => a.receivedAt - b.receivedAt);
  return ticks;
}

/**
 * Plays a recording back through the local ticker server: each call returns the
 * recorded ticks (for subscribed tokens) that arrived since the previous call,
 * following the replay clock. Ticks keep their recorded mode.
 */
export class ReplayProducer implements TickProducer {
  private cursor = 0;

  constructor(private readonly ticks: Tick[]) {}

  get startsAt(): number {
    return this.ticks[0]?.receivedAt ?? Date.now();
  }

  produce(subs: Map<number, TickMode>, nowMs: number): Tick[] {
    const out: Tick[] = [];
    while (this.cursor < this.ticks.length && this.ticks[this.cursor]!.receivedAt <= nowMs) {
      const t = this.ticks[this.cursor++]!;
      if (subs.has(t.token)) out.push({ ...t, receivedAt: nowMs });
    }
    return out;
  }
}
