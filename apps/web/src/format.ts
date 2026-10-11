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
