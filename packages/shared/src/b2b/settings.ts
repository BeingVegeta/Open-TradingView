/**
 * Inputs of "Nifty 2-Lot Block-to-Block v1.8" (Varun's rules), with the
 * script's defaults. Table position, text size and transparency inputs are
 * not needed: the app shows the tables in its own dashboard.
 */
export interface B2BSettings {
  // 1. Zones
  swLen: number;
  obScan: number;
  obKeep: number;
  atrLen: number;
  invBufA: number;
  invCloses: number;
  useBrk: boolean;
  brkEntry: boolean;
  showGhost: boolean;
  ghostKeep: number;
  ghostDay: boolean;
  // 2. Entry and stop
  entryMode: 'block' | 'hybrid' | 'retest';
  nearPts: number;
  pendMax: number;
  slBuf: number;
  initSL: number;
  // 3. Lots and booking
  lotSz: number;
  measure: 'points' | 'premium';
  deltaF: number;
  bookPts: number;
  // 3b. Protection rules
  useStep: boolean;
  stepTrig: number;
  lot1Lock: number;
  lot2Lock: number;
  useGive: boolean;
  giveStart: number;
  givePct: number;
  // 4. Session (IST, HHMM)
  entFrom: number;
  entTo: number;
  sqOff: number;
  // 5. Option mapping
  kStep: number;
  // 6. Log
  logRows: number;
  logSkip: boolean;
}

export const B2B_DEFAULTS: B2BSettings = {
  swLen: 5,
  obScan: 30,
  obKeep: 8,
  atrLen: 14,
  invBufA: 0.25,
  invCloses: 2,
  useBrk: true,
  brkEntry: true,
  showGhost: true,
  ghostKeep: 15,
  ghostDay: true,
  entryMode: 'block',
  nearPts: 15,
  pendMax: 30,
  slBuf: 2,
  initSL: 10,
  lotSz: 65,
  measure: 'points',
  deltaF: 0.65,
  bookPts: 15,
  useStep: true,
  stepTrig: 10,
  lot1Lock: 10,
  lot2Lock: 0,
  useGive: true,
  giveStart: 40,
  givePct: 15,
  entFrom: 930,
  entTo: 1500,
  sqOff: 1515,
  kStep: 100,
  logRows: 12,
  logSkip: true,
};

type NumKey = {
  [K in keyof B2BSettings]: B2BSettings[K] extends number ? K : never;
}[keyof B2BSettings];
type BoolKey = {
  [K in keyof B2BSettings]: B2BSettings[K] extends boolean ? K : never;
}[keyof B2BSettings];

export type B2BField =
  | {
      kind: 'number';
      key: NumKey;
      label: string;
      min?: number;
      max?: number;
      step?: number;
      int?: boolean;
      hint?: string;
    }
  | { kind: 'bool'; key: BoolKey; label: string; hint?: string }
  | {
      kind: 'choice';
      key: 'entryMode' | 'measure';
      label: string;
      options: { value: string; label: string }[];
    };

/** The script's input groups, in its order and wording (for the settings dialog). */
export const B2B_FIELDS: { group: string; fields: B2BField[] }[] = [
  {
    group: '1. Zones (SMC v7.9 engine, 1m)',
    fields: [
      { kind: 'number', key: 'swLen', label: 'Swing length', min: 2, max: 20, int: true },
      {
        kind: 'number',
        key: 'obScan',
        label: 'Bars back to find the block candle',
        min: 3,
        max: 80,
        int: true,
      },
      {
        kind: 'number',
        key: 'obKeep',
        label: 'Max live zones per side',
        min: 1,
        max: 20,
        int: true,
      },
      { kind: 'number', key: 'atrLen', label: 'ATR length', min: 1, int: true },
      {
        kind: 'number',
        key: 'invBufA',
        label: 'Zone breaks only on a close beyond by (x ATR)',
        min: 0,
        max: 2,
        step: 0.05,
      },
      {
        kind: 'number',
        key: 'invCloses',
        label: '…for this many consecutive closes',
        min: 1,
        max: 5,
        int: true,
      },
      { kind: 'bool', key: 'useBrk', label: 'Broken block becomes an opposite BREAKER' },
      { kind: 'bool', key: 'brkEntry', label: 'Breaker also gives an entry the other way' },
      { kind: 'bool', key: 'showGhost', label: 'Keep broken zones as grey ghosts' },
      {
        kind: 'number',
        key: 'ghostKeep',
        label: 'Max ghost zones on chart',
        min: 1,
        max: 60,
        int: true,
      },
      { kind: 'bool', key: 'ghostDay', label: 'Clear ghosts at each new session' },
    ],
  },
  {
    group: '2. Entry and stop',
    fields: [
      {
        kind: 'choice',
        key: 'entryMode',
        label: 'Entry',
        options: [
          { value: 'block', label: 'On block creation' },
          { value: 'hybrid', label: 'Hybrid (near = now, far = retest)' },
          { value: 'retest', label: 'On retest of the block' },
        ],
      },
      {
        kind: 'number',
        key: 'nearPts',
        label: 'Hybrid: enter now if within (index pts of the block)',
        min: 1,
        step: 1,
      },
      {
        kind: 'number',
        key: 'pendMax',
        label: 'Retest must come within N bars',
        min: 3,
        max: 200,
        int: true,
      },
      {
        kind: 'number',
        key: 'slBuf',
        label: 'Retest mode: block counts as broken beyond (index pts)',
        min: 0,
        step: 0.5,
      },
      {
        kind: 'number',
        key: 'initSL',
        label: 'Initial SL per lot (points from entry)',
        min: 2,
        step: 1,
        hint: '10 = each lot −10, both lots −20 points.',
      },
    ],
  },
  {
    group: '3. Lots and booking',
    fields: [
      { kind: 'number', key: 'lotSz', label: 'Nifty lot size', min: 1, int: true },
      {
        kind: 'choice',
        key: 'measure',
        label: 'Measure profit in',
        options: [
          { value: 'points', label: 'Index points' },
          { value: 'premium', label: 'Est. premium (index x delta)' },
        ],
      },
      {
        kind: 'number',
        key: 'deltaF',
        label: 'Delta for the premium estimate',
        min: 0.1,
        max: 1,
        step: 0.05,
      },
      { kind: 'number', key: 'bookPts', label: 'Book LOT 1 at + (points)', min: 1, step: 1 },
    ],
  },
  {
    group: '3b. Protection rules (v1.8)',
    fields: [
      { kind: 'bool', key: 'useStep', label: 'At +10: lot 1 stop to +10, lot 2 stop to cost' },
      {
        kind: 'number',
        key: 'stepTrig',
        label: '…when the peak reaches + (points)',
        min: 1,
        step: 1,
      },
      { kind: 'number', key: 'lot1Lock', label: '…lot 1 stop = entry + (points)', min: 0, step: 1 },
      {
        kind: 'number',
        key: 'lot2Lock',
        label: '…lot 2 stop = entry + (points)',
        min: 0,
        step: 0.5,
        hint: '0 = cost to cost.',
      },
      { kind: 'bool', key: 'useGive', label: 'Giveback exit for lot 2 (once lot 1 is out)' },
      {
        kind: 'number',
        key: 'giveStart',
        label: "…starts when lot 2's peak reaches + (points)",
        min: 5,
        step: 5,
        hint: 'Lower = tighter, e.g. 20. 40 keeps small trades from being cut on a 2-3 pt pullback.',
      },
      {
        kind: 'number',
        key: 'givePct',
        label: '…exit if profit falls this % from the peak',
        min: 5,
        max: 50,
        step: 1,
      },
    ],
  },
  {
    group: '4. Session (IST)',
    fields: [
      {
        kind: 'number',
        key: 'entFrom',
        label: 'New entries from (HHMM)',
        min: 915,
        max: 1530,
        int: true,
      },
      {
        kind: 'number',
        key: 'entTo',
        label: 'No new entries after (HHMM)',
        min: 915,
        max: 1530,
        int: true,
      },
      {
        kind: 'number',
        key: 'sqOff',
        label: 'Square-off at (HHMM, candle close)',
        min: 915,
        max: 1530,
        int: true,
      },
    ],
  },
  {
    group: '5. Option mapping',
    fields: [
      {
        kind: 'number',
        key: 'kStep',
        label: 'Strike step (round figure)',
        min: 50,
        step: 50,
        int: true,
      },
    ],
  },
  {
    group: '6. Log',
    fields: [
      {
        kind: 'number',
        key: 'logRows',
        label: 'Rows shown (latest first)',
        min: 3,
        max: 30,
        int: true,
      },
      { kind: 'bool', key: 'logSkip', label: 'Show SKIPPED setups in the log' },
    ],
  },
];

/** Settings from saved data: unknown or out-of-range values fall back to the defaults. */
export function sanitizeB2BSettings(input: unknown): B2BSettings {
  const o = (typeof input === 'object' && input ? input : {}) as Record<string, unknown>;
  const out: B2BSettings = { ...B2B_DEFAULTS };
  for (const { fields } of B2B_FIELDS) {
    for (const f of fields) {
      const v = o[f.key];
      if (f.kind === 'bool') {
        if (typeof v === 'boolean') out[f.key] = v;
      } else if (f.kind === 'choice') {
        if (typeof v === 'string' && f.options.some((x) => x.value === v))
          (out as unknown as Record<string, string>)[f.key] = v;
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        let n = f.int ? Math.round(v) : v;
        if (f.min !== undefined) n = Math.max(f.min, n);
        if (f.max !== undefined) n = Math.min(f.max, n);
        out[f.key] = n;
      }
    }
  }
  return out;
}
