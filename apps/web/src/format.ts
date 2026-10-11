import { toIstParts } from '@otv/shared';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `06:00 IST, Tue 13 Oct` — always IST regardless of the browser's timezone. */
export function formatIstShort(epochMs: number): string {
  const p = toIstParts(epochMs);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][p.weekday];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    p.month - 1
  ];
  return `${pad2(p.hour)}:${pad2(p.minute)} IST, ${wd} ${p.day} ${mo}`;
}

/** `14h 05m`, `42m`, `<1m` */
export function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${pad2(m)}m` : `${m}m`;
}

const fmtCache = new Map<string, Intl.NumberFormat>();

/** Indian-grouped price with fixed decimals (e.g. 1,23,456.75). `signed` adds a + for positives. */
export function formatPrice(v: number, decimals = 2, signed = false): string {
  const k = `${decimals}`;
  let f = fmtCache.get(k);
  if (!f)
    fmtCache.set(
      k,
      (f = new Intl.NumberFormat('en-IN', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })),
    );
  const s = f.format(v);
  return signed && v > 0 ? `+${s}` : s;
}

/** Compact Indian quantities: 12.3K, 4.56L, 1.2Cr. */
export function formatQty(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}
