/** Half-open time range [from, to) in epoch seconds. */
export interface Range {
  from: number;
  to: number;
}

/** Adds `r` to a sorted, disjoint list, merging overlapping and touching ranges. */
export function addRange(ranges: readonly Range[], r: Range): Range[] {
  if (r.to <= r.from) return [...ranges];
  const out: Range[] = [];
  let cur = { ...r };
  let placed = false;
  for (const x of ranges) {
    if (x.to < cur.from) out.push(x);
    else if (x.from > cur.to) {
      if (!placed) {
        out.push(cur);
        placed = true;
      }
      out.push(x);
    } else cur = { from: Math.min(cur.from, x.from), to: Math.max(cur.to, x.to) };
  }
  if (!placed) out.push(cur);
  return out;
}

/** The covered range that contains the instant just before `t` (i.e. covers [x, t)), if any. */
export function rangeEndingAt(ranges: readonly Range[], t: number): Range | undefined {
  return ranges.find((r) => r.from < t && r.to >= t);
}

/** End of the latest covered range that ends at or before `t`, or -Infinity. */
export function coveredEndBefore(ranges: readonly Range[], t: number): number {
  let end = -Infinity;
  for (const r of ranges) if (r.to <= t && r.to > end) end = r.to;
  return end;
}
