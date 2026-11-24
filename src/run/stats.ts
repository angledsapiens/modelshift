/** Small, dependency-free statistics helpers. Seeded so reports are reproducible. */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Percentile bootstrap CI of the mean. */
export function bootstrapMeanCI(xs: number[], opts: { iterations?: number; alpha?: number; seed?: number } = {}): [number, number] {
  const n = xs.length;
  if (n === 0) return [NaN, NaN];
  if (n === 1) return [xs[0], xs[0]];
  const iters = opts.iterations ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const rnd = mulberry32(opts.seed ?? 42);
  const means = new Float64Array(iters);
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(rnd() * n)];
    means[b] = s / n;
  }
  means.sort();
  const lo = means[Math.floor((alpha / 2) * iters)];
  const hi = means[Math.min(iters - 1, Math.ceil((1 - alpha / 2) * iters) - 1)];
  return [lo, hi];
}

/** Mean absolute difference over all pairs: how much a metric varies between repeats of the same model. */
export function meanPairwiseAbsDiff(xs: number[]): number {
  if (xs.length < 2) return 0;
  let s = 0;
  let c = 0;
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
    s += Math.abs(xs[i] - xs[j]);
    c++;
  }
  return s / c;
}
