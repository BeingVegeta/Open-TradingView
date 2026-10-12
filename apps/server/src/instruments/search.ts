import { instrumentKind, type Instrument, type InstrumentKind } from '@otv/shared';
import { POPULAR_SYMBOLS } from './popular';

export type SearchKind = 'equity' | 'index' | 'future' | 'option' | 'commodity' | 'currency';
export const SEARCH_KINDS: readonly SearchKind[] = [
  'equity',
  'index',
  'future',
  'option',
  'commodity',
  'currency',
];

export interface SearchOptions {
  exchanges?: string[];
  kinds?: SearchKind[];
  limit?: number;
}

interface Entry {
  i: Instrument;
  sym: string;
  symCompact: string;
  name: string;
  kind: InstrumentKind;
  derivative: boolean;
  expiryMonth: string;
  bonus: number;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const KNOWN_EXCHANGES = new Set(['NSE', 'BSE', 'NFO', 'BFO', 'CDS', 'BCD', 'MCX', 'NCO', 'MF']);
const POPULAR_INDICES = new Set([
  'NIFTY 50',
  'NIFTY BANK',
  'SENSEX',
  'NIFTY FIN SERVICE',
  'INDIA VIX',
  'NIFTY MID SELECT',
]);

const compact = (s: string) => s.replace(/[\s\-&.]/g, '');

function bonusFor(i: Instrument, kind: InstrumentKind): number {
  switch (kind) {
    case 'index':
      return (i.exchange === 'NSE' ? 12 : 10) + (POPULAR_INDICES.has(i.tradingsymbol) ? 3 : 0);
    case 'equity':
      return (
        (i.exchange === 'NSE' ? 10 : i.exchange === 'BSE' ? 6 : 4) +
        (POPULAR_SYMBOLS.has(i.tradingsymbol) ? 3 : 0)
      );
    case 'future':
      return 5;
    default:
      return 0;
  }
}

function matchesKind(e: Entry, kinds: Set<SearchKind>): boolean {
  const ex = e.i.exchange;
  if (kinds.has('commodity') && (ex === 'MCX' || ex === 'NCO')) return true;
  if (kinds.has('currency') && (ex === 'CDS' || ex === 'BCD')) return true;
  return kinds.has(e.kind as SearchKind);
}

/** Does a non-primary query token qualify this entry (type, exchange, month, strike, or text)? */
function qualifies(e: Entry, tok: string): boolean {
  if (e.sym.includes(tok) || e.name.includes(tok)) return true;
  if (tok === e.i.instrumentType || tok === e.i.exchange) return true;
  if ((tok === 'INDEX' || tok === 'IDX') && e.kind === 'index') return true;
  if ((tok === 'OPT' || tok === 'OPTION') && e.kind === 'option') return true;
  if (tok === e.expiryMonth) return true;
  if (/^\d+(\.\d+)?$/.test(tok) && e.i.strike === Number(tok)) return true;
  return false;
}

/** Text score of a query against an entry; 0 if no match. */
function textScore(e: Entry, q: string, qc: string): number {
  if (e.sym === q || (qc && e.symCompact === qc)) return 100;
  if (e.sym.startsWith(q) || (qc && e.symCompact.startsWith(qc))) {
    return 80 - Math.min(20, e.symCompact.length - qc.length) * 0.5;
  }
  // A derivative's "name" is just its underlying: matching it must not
  // outrank the underlying itself or a symbol match.
  const namePenalty = e.derivative ? 25 : 0;
  if (e.name === q) return 90 - namePenalty;
  if (e.name.startsWith(q)) return 70 - namePenalty;
  if (e.name.includes(' ' + q)) return 60 - namePenalty;
  if (e.sym.includes(q)) return 40;
  if (e.name.includes(q)) return Math.max(5, 30 - namePenalty);
  return 0;
}

interface Scored {
  e: Entry;
  s: number;
}

function better(a: Scored, b: Scored): number {
  return (
    b.s - a.s ||
    (a.e.i.expiry ?? '').localeCompare(b.e.i.expiry ?? '') ||
    a.e.i.strike - b.e.i.strike ||
    a.e.sym.length - b.e.sym.length ||
    a.e.sym.localeCompare(b.e.sym)
  );
}

/**
 * In-memory instrument search. ~100k instruments scan in a few milliseconds,
 * so no index structure beyond precomputed upper-case strings is needed.
 *
 * Ranking: exact symbol > symbol prefix (shorter first) > name > substring,
 * plus a small bonus for indices and NSE equities so `RELIANCE` resolves to
 * NSE:RELIANCE before BSE, futures, options or lookalike names.
 */
export class InstrumentIndex {
  private entries: Entry[] = [];
  private byKey = new Map<string, Instrument>();
  private byToken = new Map<number, Instrument>();

  constructor(instruments: Instrument[] = []) {
    this.load(instruments);
  }

  load(instruments: Instrument[]): void {
    markClosingAuction(instruments);
    this.byKey = new Map(instruments.map((i) => [i.key, i]));
    this.byToken = new Map(instruments.map((i) => [i.token, i]));
    this.entries = instruments.map((i) => {
      const kind = instrumentKind(i);
      const sym = i.tradingsymbol.toUpperCase();
      return {
        i,
        sym,
        symCompact: compact(sym),
        name: i.name.toUpperCase(),
        kind,
        derivative: kind === 'future' || kind === 'option',
        expiryMonth: i.expiry ? MONTHS[Number(i.expiry.slice(5, 7)) - 1]! : '',
        bonus: bonusFor(i, kind),
      };
    });
  }

  get size(): number {
    return this.entries.length;
  }

  get(key: string): Instrument | undefined {
    return this.byKey.get(key);
  }

  getByToken(token: number): Instrument | undefined {
    return this.byToken.get(token);
  }

  search(query: string, opts: SearchOptions = {}): Instrument[] {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
    let q = query.trim().toUpperCase().replace(/\s+/g, ' ');
    let exchanges = opts.exchanges?.length
      ? new Set(opts.exchanges.map((x) => x.toUpperCase()))
      : undefined;

    // "NSE:RELIANCE" form.
    const colon = q.indexOf(':');
    if (colon > 0 && KNOWN_EXCHANGES.has(q.slice(0, colon).trim())) {
      const ex = q.slice(0, colon).trim();
      exchanges = new Set(exchanges ? [...exchanges].filter((x) => x === ex) : [ex]);
      q = q.slice(colon + 1).trim();
    }
    if (!q) return [];
    const kinds = opts.kinds?.length ? new Set(opts.kinds) : undefined;
    const qc = compact(q);
    const tokens = q.split(' ');
    const first = tokens[0]!;
    const firstC = compact(first);

    // Keep only the best `limit` (a one-letter query can match everything).
    const top: Scored[] = [];
    for (const e of this.entries) {
      if (exchanges && !exchanges.has(e.i.exchange)) continue;
      if (kinds && !matchesKind(e, kinds)) continue;
      let s = textScore(e, q, qc);
      if (s === 0 && tokens.length > 1) {
        // Multi-word query like "nifty oct fut" or "reliance 1400 ce".
        const base = textScore(e, first, firstC);
        if (base > 0 && tokens.slice(1).every((t) => qualifies(e, t))) s = base - 5;
      }
      if (s === 0) continue;
      const cand = { e, s: s + e.bonus };
      if (top.length === limit && better(cand, top[limit - 1]!) >= 0) continue;
      let i = top.length;
      while (i > 0 && better(cand, top[i - 1]!) < 0) i--;
      top.splice(i, 0, cand);
      if (top.length > limit) top.pop();
    }
    return top.map((x) => x.e.i);
  }
}

/**
 * Flags NSE/BSE stocks that have futures (on NFO or BFO, by the futures'
 * underlying `name`): SEBI's closing auction session covers F&O stocks only,
 * so their continuous trading ends at 15:15 instead of 15:30.
 */
export function markClosingAuction(instruments: Instrument[]): void {
  const underlyings = new Set<string>();
  for (const i of instruments) {
    if (i.instrumentType === 'FUT' && (i.exchange === 'NFO' || i.exchange === 'BFO'))
      underlyings.add(i.name.toUpperCase());
  }
  for (const i of instruments) {
    if ((i.exchange === 'NSE' || i.exchange === 'BSE') && i.segment !== 'INDICES') {
      if (underlyings.has(i.tradingsymbol.toUpperCase())) i.closingAuction = true;
      else delete i.closingAuction;
    }
  }
}
