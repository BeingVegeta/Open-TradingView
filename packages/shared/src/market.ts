/** One row of Kite's instrument master, keyed by `EXCHANGE:TRADINGSYMBOL`. */
export interface Instrument {
  /** `EXCHANGE:TRADINGSYMBOL`, e.g. `NSE:RELIANCE`, `NSE:NIFTY 50`. The stable identity. */
  key: string;
  /** Kite's numeric token for history and the ticker. May be reused for another contract after expiry. */
  token: number;
  exchange: string;
  tradingsymbol: string;
  name: string;
  /** e.g. NSE, NFO-FUT, NFO-OPT, INDICES, MCX-FUT, CDS-FUT */
  segment: string;
  /** EQ, FUT, CE, PE (indices are EQ in segment INDICES) */
  instrumentType: string;
  /** `yyyy-mm-dd` for derivatives, else null. */
  expiry: string | null;
  strike: number;
  tickSize: number;
  lotSize: number;
  /**
   * NSE/BSE stocks with futures (from the instrument list): their continuous
   * trading ends at 15:15, followed by SEBI's closing auction session.
   */
  closingAuction?: boolean;
}

export type InstrumentKind = 'equity' | 'index' | 'future' | 'option' | 'other';

export function instrumentKind(i: Pick<Instrument, 'segment' | 'instrumentType'>): InstrumentKind {
  if (i.segment === 'INDICES') return 'index';
  switch (i.instrumentType) {
    case 'EQ':
      return 'equity';
    case 'FUT':
      return 'future';
    case 'CE':
    case 'PE':
      return 'option';
    default:
      return 'other';
  }
}

export function instrumentKey(exchange: string, tradingsymbol: string): string {
  return `${exchange}:${tradingsymbol}`;
}

/** Index instruments carry no volume (and their ticks have no volume field). */
export function hasVolume(i: Pick<Instrument, 'segment'>): boolean {
  return i.segment !== 'INDICES';
}

/** Decimal places needed to show prices at this tick size (0.05 → 2, 0.0025 → 4, 1 → 0). */
export function priceDecimals(tickSize: number): number {
  if (!(tickSize > 0)) return 2;
  const s = tickSize.toString();
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** An OHLCV bar. `time` is the bar's open as epoch seconds (a real instant, not IST-shifted). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
}

export interface InstrumentSyncStatus {
  count: number;
  /** Epoch ms of the last successful sync, or null. */
  syncedAt: number | null;
  syncing: boolean;
  error: string | null;
}

export interface InstrumentSearchResponse {
  results: Instrument[];
  sync: InstrumentSyncStatus;
}

export interface HistoryResponse {
  key: string;
  tf: string;
  candles: Candle[];
  /** False once the start of the instrument's data has been reached. */
  hasMore: boolean;
  /**
   * True if cached history turned out to be stale (e.g. Kite adjusted past prices
   * for a split or bonus); the client should drop what it holds and reload.
   */
  reset?: boolean;
}

/** Error body for every non-2xx API response. */
export interface ApiErrorBody {
  error:
    | 'logged_out'
    | 'no_market_data'
    | 'not_found'
    | 'bad_request'
    | 'upstream_unavailable'
    | 'instruments_not_synced'
    | string;
  message?: string;
}
