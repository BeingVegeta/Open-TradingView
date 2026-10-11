/** Deterministic hashing-based randomness: the same inputs always give the same numbers. */

function mix(h: number, x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  h = Math.imul(h ^ x, 0x27d4eb2d);
  return h ^ (h >>> 15);
}

/** 32-bit hash of up to five integers (fixed arity: this is the mock's hot path). */
export function hash32(a: number, b = 0, c = 0, d = 0, e = 0): number {
  let h = 0x9e3779b9;
  h = mix(h, a | 0);
  h = mix(h, b | 0);
  h = mix(h, c | 0);
  h = mix(h, d | 0);
  h = mix(h, e | 0);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Uniform in [0, 1). */
export function rand01(a: number, b = 0, c = 0, d = 0, e = 0): number {
  return hash32(a, b, c, d, e) / 4294967296;
}

/** Standard normal (Box–Muller on two hashed uniforms). */
export function gauss(a: number, b = 0, c = 0, d = 0): number {
  const u = Math.max(hash32(a, b, c, d, 1) / 4294967296, 1e-12);
  const v = hash32(a, b, c, d, 2) / 4294967296;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function stringSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Smooth 1-D value noise in [-1, 1]. */
function valueNoise(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = rand01(seed, i) * 2 - 1;
  const b = rand01(seed, i + 1) * 2 - 1;
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
}

const WAVELENGTHS = [2, 5, 13, 34, 89, 233, 610, 1597];

/**
 * Fractal noise whose amplitude grows with sqrt(wavelength), like a random
 * walk's, but evaluable at any x in O(1) — so any date range can be generated
 * independently and still line up exactly.
 */
export function walkNoise(seed: number, x: number): number {
  let sum = 0;
  for (let k = 0; k < WAVELENGTHS.length; k++) {
    const w = WAVELENGTHS[k]!;
    sum += Math.sqrt(w) * valueNoise(seed + k * 7919, x / w);
  }
  return sum;
}
