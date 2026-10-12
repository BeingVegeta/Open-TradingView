import { gunzipSync } from 'node:zlib';
import { parseKiteTimestamp, type Candle, type KiteInterval } from '@otv/shared';
import { sleep, systemClock, type Clock } from './clock';
import { KiteApiError, kiteErrorFromHttp, toKiteError } from './errors';
import type { Priority, RateCategory, RateLimiter } from './rateLimiter';

export const KITE_API_ROOT = 'https://api.kite.trade';

export interface RequestOpts {
  priority?: Priority;
  signal?: AbortSignal;
}

export interface HistoricalParams {
  token: number;
  interval: KiteInterval;
  /** `yyyy-mm-dd hh:mm:ss` in IST. */
  from: string;
  /** `yyyy-mm-dd hh:mm:ss` in IST. */
  to: string;
  oi?: boolean;
  continuous?: boolean;
}

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 20_000;

/**
 * Direct HTTP client for Kite's read-only market-data endpoints.
 *
 * Used instead of the kiteconnect SDK for history and the instrument dump: the
 * SDK drops HTTP status codes (so 429s can only be guessed from the message),
 * formats `Date` arguments in the machine's local timezone and drops OI values
 * of zero. Every call goes through the shared rate limiter.
 */
export class KiteRestClient {
  constructor(
    private readonly apiKey: string,
    private readonly limiter: RateLimiter,
    private readonly root = KITE_API_ROOT,
    private readonly clock: Clock = systemClock,
  ) {}

  async historical(
    accessToken: string,
    p: HistoricalParams,
    opts: RequestOpts = {},
  ): Promise<Candle[]> {
    const url = new URL(`${this.root}/instruments/historical/${p.token}/${p.interval}`);
    url.searchParams.set('from', p.from);
    url.searchParams.set('to', p.to);
    if (p.oi) url.searchParams.set('oi', '1');
    if (p.continuous) url.searchParams.set('continuous', '1');
    const res = await this.get(accessToken, url, 'historical', opts);
    const body = (await res.json()) as { data?: { candles?: unknown[][] } };
    const rows = body.data?.candles;
    if (!Array.isArray(rows))
      throw new KiteApiError('data', 'Historical response had no candles array');
    return rows.map((r) => {
      const c: Candle = {
        time: parseKiteTimestamp(String(r[0])),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5] ?? 0),
      };
      if (r.length > 6 && r[6] !== null && r[6] !== undefined) c.oi = Number(r[6]);
      return c;
    });
  }

  /** The full instrument master as CSV text. */
  async instrumentsCsv(accessToken: string, opts: RequestOpts = {}): Promise<string> {
    const res = await this.get(accessToken, new URL(`${this.root}/instruments`), 'default', opts);
    const buf = Buffer.from(await res.arrayBuffer());
    // Normally served with Content-Encoding: gzip (fetch decodes it); also accept a raw .gz body.
    const raw = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
    return raw.toString('utf8');
  }

  private async get(
    accessToken: string,
    url: URL,
    category: RateCategory,
    opts: RequestOpts,
  ): Promise<Response> {
    let lastErr: KiteApiError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.limiter.run(
          category,
          () => this.fetchOnce(accessToken, url, opts.signal),
          opts,
        );
      } catch (err) {
        const e = toKiteError(err);
        if (opts.signal?.aborted || !e.retryable || attempt === MAX_ATTEMPTS) throw e;
        lastErr = e;
        if (e.kind === 'rate_limit') this.limiter.backOff(category, 1000 * attempt);
        else await sleep(this.clock, 500 * 3 ** (attempt - 1));
      }
    }
    throw lastErr!;
  }

  private async fetchOnce(accessToken: string, url: URL, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          'X-Kite-Version': '3',
          Authorization: `token ${this.apiKey}:${accessToken}`,
          'Accept-Encoding': 'gzip',
        },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (timeout.aborted) throw new KiteApiError('network', 'Kite API request timed out');
      throw toKiteError(err);
    }
    if (res.ok) return res;
    const body: unknown = await res.json().catch(() => null);
    throw kiteErrorFromHttp(res.status, body);
  }
}
