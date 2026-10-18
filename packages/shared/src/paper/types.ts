/**
 * Paper trading of Varun's N-B2B script: every call is simulated as 2 lots of
 * the NIFTY option the script names, filled at the live best ask (entry) and
 * best bid (exits), and stored. Nothing is ever sent to Kite.
 */

export interface PaperLotExit {
  /** Epoch ms of the simulated fill. */
  at: number;
  /** NIFTY at the exit (the candle close the script acted on, or its stop level). */
  index: number;
  /** Option fill price per unit (null if no option price was available). */
  opt: number | null;
  /** The script's reason: "+15", "SL", "COST", "STOP +x", "GIVEBACK +x", "BEAR BLOCK", "EOD"… */
  reason: string;
  /** The script's result for this lot, in its measure (index points by default). */
  pts: number;
}

export interface PaperTrade {
  id: number;
  /** IST trading day, yyyy-mm-dd. */
  day: string;
  /** Open time (epoch s) of the candle whose close gave the call. */
  signalTime: number;
  /** Epoch ms of the simulated entry fill. */
  entryAt: number;
  dir: 1 | -1;
  /** "block", "breaker", "block retest"… */
  source: string;
  underlying: string;
  /** "25000 CE" as the script names it. */
  optionName: string;
  /** EXCHANGE:TRADINGSYMBOL of the option paper-traded, or null if none was found. */
  optionKey: string | null;
  expiry: string | null;
  lots: number;
  /** Units per lot of the traded option (from Kite's instrument list). */
  lotSize: number;
  /** The script's own lot size input (its ₹ figures use it). */
  scriptLotSize: number;
  entryIndex: number;
  slIndex: number;
  /** Option entry fill per unit (best ask, else last price). */
  entryOpt: number | null;
  /** Option last price at entry (fill minus this = spread paid). */
  entryOptLtp: number | null;
  /** Best favourable / adverse move while open, in index points. */
  peakPts: number;
  maePts: number | null;
  lot1: PaperLotExit | null;
  lot2: PaperLotExit | null;
  status: 'open' | 'closed';
  /** The script's result text, e.g. "L1 +15 / L2 COST". */
  result: string | null;
  /** The script's total over both lots, in its measure, and its ₹ (× its lot size). */
  scriptPts: number | null;
  scriptRs: number | null;
  /** Option P&L in ₹ over both lots, before and after estimated costs. */
  grossRs: number | null;
  costsRs: number | null;
  netRs: number | null;
  /** Hash of the script inputs used (to compare settings versions). */
  settingsHash: string;
  /** Notes such as "filled at last price (no depth)" or "closed while the app was off". */
  notes: string[];
}

export interface PaperEvent {
  id: number;
  /** Epoch ms. */
  at: number;
  /** Candle open time (epoch s) the event came from, if any. */
  barTime: number | null;
  tradeId: number | null;
  kind: string;
  text: string;
}

/** Estimated charges for buying and selling index options (editable in settings). */
export interface PaperCosts {
  /** ₹ per executed order. */
  brokeragePerOrder: number;
  /** Fraction of sell turnover. */
  sttSell: number;
  /** Exchange transaction charges, fraction of turnover. */
  exchange: number;
  /** SEBI fees, fraction of turnover. */
  sebi: number;
  /** Stamp duty, fraction of buy turnover. */
  stampBuy: number;
  /** GST on brokerage + exchange + SEBI fees. */
  gst: number;
}

/**
 * Zerodha's published charges for NSE index options (late 2025): ₹20 an order,
 * STT 0.1% of sell premium, NSE transaction 0.03503%, SEBI ₹10 a crore, stamp
 * 0.003% on buys, GST 18%. Estimates: check against a contract note.
 */
export const DEFAULT_PAPER_COSTS: PaperCosts = {
  brokeragePerOrder: 20,
  sttSell: 0.001,
  exchange: 0.0003503,
  sebi: 0.000001,
  stampBuy: 0.00003,
  gst: 0.18,
};

export interface PaperConfig {
  /** Trade automatically whenever the app is running and logged in. */
  enabled: boolean;
  lots: number;
  /** Which expiry to trade: the nearest, or the next one on the nearest's expiry day. */
  expiry: 'nearest' | 'skip-expiry-day';
  costs: PaperCosts;
}

export const DEFAULT_PAPER_CONFIG: PaperConfig = {
  enabled: true,
  lots: 2,
  expiry: 'nearest',
  costs: DEFAULT_PAPER_COSTS,
};

export interface PaperStatus {
  enabled: boolean;
  /** What the trader is doing right now, in words. */
  state: 'off' | 'waiting-login' | 'waiting-instruments' | 'loading' | 'running' | 'error';
  message: string | null;
  /** Newest closed candle the script has run on (epoch s). */
  lastBar: number | null;
  openTrade: PaperTrade | null;
}

/** Charges for one round of option fills (each lot's exit is its own order). */
export function paperCosts(
  c: PaperCosts,
  buys: { price: number; qty: number }[],
  sells: { price: number; qty: number }[],
  orders: number,
): number {
  const buyT = buys.reduce((a, b) => a + b.price * b.qty, 0);
  const sellT = sells.reduce((a, b) => a + b.price * b.qty, 0);
  const turnover = buyT + sellT;
  const brokerage = c.brokeragePerOrder * orders;
  const exchange = turnover * c.exchange;
  const sebi = turnover * c.sebi;
  const gst = (brokerage + exchange + sebi) * c.gst;
  return brokerage + sellT * c.sttSell + exchange + sebi + buyT * c.stampBuy + gst;
}
