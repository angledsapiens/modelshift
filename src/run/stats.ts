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

/**
 * Bootstrap CI of the mean plus a p-value for "the mean is on the worse side of 0".
 * p = 2 × share of resampled means that are NOT worse, so with a single check
 * "p < 0.05" is exactly "the 95% CI lies entirely on the worse side".
 */
export function bootstrapMeanTest(xs: number[], worse: "negative" | "positive", opts: { iterations?: number; alpha?: number; seed?: number } = {}): { ci: [number, number]; p: number } {
  const n = xs.length;
  if (n === 0) return { ci: [NaN, NaN], p: 1 };
  const isWorse = (m: number) => (worse === "negative" ? m < 0 : m > 0);
  if (n === 1) return { ci: [xs[0], xs[0]], p: isWorse(xs[0]) ? 0 : 1 };
  const iters = opts.iterations ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const rnd = mulberry32(opts.seed ?? 42);
  const means = new Float64Array(iters);
  let notWorse = 0;
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(rnd() * n)];
    means[b] = s / n;
    if (!isWorse(means[b])) notWorse++;
  }
  means.sort();
  const lo = means[Math.floor((alpha / 2) * iters)];
  const hi = means[Math.min(iters - 1, Math.ceil((1 - alpha / 2) * iters) - 1)];
  return { ci: [lo, hi], p: Math.min(1, (2 * notWorse) / iters) };
}

/**
 * The smallest p-value bootstrapMeanTest could ever give for n paired differences of which k are
 * non-zero (reached when all k point the worse way): 2 × P(a resample contains none of them).
 * It depends only on how many samples changed, not on the direction, so a check that can't get
 * below 0.05 even on its own can be left out of a multiple-testing family without biasing it
 * (Tarone's idea): it can never raise an alarm, true or false.
 */
export function minAttainableP(n: number, k: number): number {
  if (k <= 0 || n <= 0) return 1;
  return Math.min(1, 2 * Math.pow((n - k) / n, n));
}

/**
 * Holm–Bonferroni adjusted p-values. Controls the chance of ANY false alarm across a
 * family of checks (family-wise error), which is what a go/no-go verdict needs.
 */
export function holmAdjust(ps: number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const adj = new Array<number>(m);
  let running = 0;
  order.forEach(([p, i], k) => {
    running = Math.max(running, Math.min(1, (m - k) * p));
    adj[i] = running;
  });
  return adj;
}
