import { instrumentKey, type Instrument } from '@otv/shared';
import { parseCsv } from './csv';

/**
 * Parses Kite's instrument master CSV. Columns are located by header name
 * (trimmed), so order changes or extra columns don't break parsing.
 */
export function parseInstrumentsCsv(text: string): Instrument[] {
  const rows = parseCsv(text);
  const header = rows.shift()?.map((h) => h.trim());
  if (!header) return [];
  const col = (name: string) => {
    const idx = header.indexOf(name);
    if (idx < 0) throw new Error(`Instrument CSV is missing the "${name}" column`);
    return idx;
  };
  const c = {
    token: col('instrument_token'),
    symbol: col('tradingsymbol'),
    name: col('name'),
    expiry: col('expiry'),
    strike: col('strike'),
    tick: col('tick_size'),
    lot: col('lot_size'),
    type: col('instrument_type'),
    segment: col('segment'),
    exchange: col('exchange'),
  };
  const out: Instrument[] = [];
  for (const r of rows) {
    const token = Number(r[c.token]);
    const exchange = r[c.exchange]?.trim() ?? '';
    const tradingsymbol = r[c.symbol]?.trim() ?? '';
    if (!Number.isFinite(token) || !exchange || !tradingsymbol) continue;
    const expiry = r[c.expiry]?.trim() ?? '';
    out.push({
      key: instrumentKey(exchange, tradingsymbol),
      token,
      exchange,
      tradingsymbol,
      name: r[c.name]?.trim() ?? '',
      segment: r[c.segment]?.trim() ?? '',
      instrumentType: r[c.type]?.trim() ?? '',
      expiry: /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? expiry : null,
      strike: Number(r[c.strike]) || 0,
      tickSize: Number(r[c.tick]) || 0.05,
      lotSize: Number(r[c.lot]) || 1,
    });
  }
  return out;
}
