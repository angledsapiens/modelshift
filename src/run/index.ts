import type { ChatProvider, ChatResponse } from "../providers/index.js";
import type { Sample } from "../capture.js";
import { bootstrapMeanCI, mean, meanPairwiseAbsDiff, median } from "./stats.js";
import { assertionsPass, isJson, isRefusal, mode, outputRepr, similarity, toolSignature, topLevelKeys } from "./checks.js";

export interface SampleRun {
  id: string;
  baseline: ChatResponse[];
  candidate: ChatResponse[];
}

export interface RunMeta {
  baseline: string;
  candidate: string;
  repeats: number;
  startedAt: string;
  finishedAt?: string;
  toolVersion: string;
}

export interface MetricResult {
  name: string;
  description: string;
  direction: "higher-is-better" | "higher-is-worse";
  samples: number; // samples where the metric applied
  baseline: number; // mean rate across samples
  candidate: number;
  delta: number; // candidate - baseline
  ci: [number, number]; // 95% bootstrap CI of the paired delta
  noiseFloor: number; // baseline's own run-to-run variation
  regression: boolean;
  severity: "fail" | "review";
  /** "candidate-only" when the baseline produced no usable output (e.g. the old model was already removed). */
  mode: "paired" | "candidate-only";
}

export interface Analysis {
  metrics: MetricResult[];
  drift: { samples: number; baselineSelfSimilarity: number; crossSimilarity: number; drift: number; ci: [number, number]; changed: boolean };
  perf: { baselineLatencyMs: number; candidateLatencyMs: number; baselineOutputTokens?: number; candidateOutputTokens?: number; baselineCost?: number; candidateCost?: number };
  verdict: "likely-safe" | "review" | "unsafe";
  confidence: "low" | "medium" | "high";
  reasons: string[];
  examples: { id: string; metric: string; baseline: string; candidate: string }[];
}

export interface RunResult {
  meta: RunMeta;
  samples: Sample[];
  runs: SampleRun[];
  analysis: Analysis;
}

export type Prices = Record<string, { input: number; output: number }>; // USD per 1M tokens, keyed by "provider:model"

/* ------------------------------------------------------------------ execution */

async function pool<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

export async function executeRun(
  samples: Sample[],
  baseline: ChatProvider,
  candidate: ChatProvider,
  opts: { repeats?: number; concurrency?: number; temperature?: number; onProgress?: (done: number, total: number) => void; toolVersion?: string },
): Promise<{ meta: RunMeta; runs: SampleRun[] }> {
  const repeats = Math.max(1, opts.repeats ?? 3);
  const meta: RunMeta = { baseline: baseline.spec, candidate: candidate.spec, repeats, startedAt: new Date().toISOString(), toolVersion: opts.toolVersion ?? "dev" };
  const runs: SampleRun[] = samples.map((s) => ({ id: s.id, baseline: [], candidate: [] }));
  const tasks: (() => Promise<void>)[] = [];
  let done = 0;
  const total = samples.length * repeats * 2;
  samples.forEach((s, i) => {
    for (const [which, provider] of [["baseline", baseline], ["candidate", candidate]] as const) {
      for (let r = 0; r < repeats; r++) {
        tasks.push(async () => {
          const res = await provider.chat({ messages: s.messages, tools: s.tools, temperature: opts.temperature ?? s.temperature, max_tokens: s.max_tokens, json: s.json });
          runs[i][which].push(res);
          opts.onProgress?.(++done, total);
        });
      }
    }
  });
  await pool(tasks, opts.concurrency ?? 4);
  meta.finishedAt = new Date().toISOString();
  return { meta, runs };
}

/* ------------------------------------------------------------------ analysis */

type Extract = (r: ChatResponse, ctx: { sample: Sample; baselineOk: ChatResponse[] }) => number | undefined;

interface MetricDef {
  name: string;
  description: string;
  direction: MetricResult["direction"];
  includeErrors?: boolean; // errored outputs count (only for the error metric)
  applies: (sample: Sample, baselineOk: ChatResponse[]) => boolean;
  value: Extract;
}

const METRICS: MetricDef[] = [
  {
    name: "errors",
    description: "Share of calls that failed (HTTP error, model not found, timeout).",
    direction: "higher-is-worse",
    includeErrors: true,
    applies: () => true,
    value: (r) => (r.error ? 1 : 0),
  },
  {
    name: "json-valid",
    description: "Output parses as JSON (where the baseline returns JSON).",
    direction: "higher-is-better",
    applies: (s, ok) => !!s.json || (ok.length > 0 && ok.filter((r) => !r.toolCalls.length && isJson(r.text)).length / ok.length >= 0.5),
    value: (r) => (r.toolCalls.length ? undefined : isJson(r.text) ? 1 : 0),
  },
  {
    name: "json-shape",
    description: "JSON top-level keys match the baseline's usual keys.",
    direction: "higher-is-better",
    applies: (s, ok) => ok.some((r) => topLevelKeys(r.text) !== undefined),
    value: (r, { baselineOk }) => {
      if (r.toolCalls.length) return undefined;
      const expected = mode(baselineOk.map((b) => topLevelKeys(b.text)).filter((k): k is string => k !== undefined));
      return expected === undefined ? undefined : topLevelKeys(r.text) === expected ? 1 : 0;
    },
  },
  {
    name: "tool-calls",
    description: "Calls the same tools as the baseline usually does.",
    direction: "higher-is-better",
    applies: (s, ok) => !!s.tools?.length || ok.some((r) => r.toolCalls.length > 0),
    value: (r, { baselineOk }) => {
      const expected = mode(baselineOk.map(toolSignature));
      return expected === undefined ? undefined : toolSignature(r) === expected ? 1 : 0;
    },
  },
  {
    name: "refusals",
    description: "Output looks like a refusal.",
    direction: "higher-is-worse",
    applies: () => true,
    value: (r) => (r.toolCalls.length ? 0 : isRefusal(r.text) ? 1 : 0),
  },
  {
    name: "assertions",
    description: "Passes the sample's own expect.match / expect.notMatch rules.",
    direction: "higher-is-better",
    applies: (s) => !!(s.expect?.match?.length || s.expect?.notMatch?.length),
    value: (r, { sample }) => {
      const v = assertionsPass(outputRepr(r), sample.expect);
      return v === undefined ? undefined : v ? 1 : 0;
    },
  },
];

function metricValues(def: MetricDef, rs: ChatResponse[], ctx: { sample: Sample; baselineOk: ChatResponse[] }): number[] {
  return rs.filter((r) => def.includeErrors || !r.error).map((r) => def.value(r, ctx)).filter((v): v is number => v !== undefined);
}

function costOf(rs: ChatResponse[], price?: { input: number; output: number }): number | undefined {
  if (!price) return undefined;
  const withUsage = rs.filter((r) => !r.error && r.inputTokens !== undefined);
  if (!withUsage.length) return undefined;
  return mean(withUsage.map((r) => ((r.inputTokens ?? 0) * price.input + (r.outputTokens ?? 0) * price.output) / 1_000_000));
}

export function analyze(samples: Sample[], runs: SampleRun[], opts: { prices?: Prices; baselineSpec?: string; candidateSpec?: string } = {}): Analysis {
  const byId = new Map(samples.map((s) => [s.id, s]));
  const metrics: MetricResult[] = [];
  const examples: Analysis["examples"] = [];

  for (const def of METRICS) {
    const deltas: number[] = [];
    const bases: number[] = [];
    const cands: number[] = [];
    const noises: number[] = [];
    const candOnly: number[] = [];
    for (const run of runs) {
      const sample = byId.get(run.id);
      if (!sample) continue;
      const baselineOk = run.baseline.filter((r) => !r.error);
      // With no working baseline, judge metrics that don't need one (assertions, JSON validity when requested).
      const applies = baselineOk.length ? def.applies(sample, baselineOk) : def.name === "assertions" ? def.applies(sample, []) : def.name === "json-valid" ? !!sample.json : def.name === "refusals";
      if (!applies) continue;
      const ctx = { sample, baselineOk };
      const b = metricValues(def, run.baseline, ctx);
      const c = metricValues(def, run.candidate, ctx);
      if (!b.length && c.length) {
        candOnly.push(mean(c));
        continue;
      }
      if (!b.length || !c.length) continue;
      const bm = mean(b);
      const cm = mean(c);
      bases.push(bm);
      cands.push(cm);
      deltas.push(cm - bm);
      noises.push(meanPairwiseAbsDiff(b));
      const worse = def.direction === "higher-is-better" ? cm < bm : cm > bm;
      if (worse && examples.filter((e) => e.metric === def.name).length < 3) {
        const badIdx = c.findIndex((v) => (def.direction === "higher-is-better" ? v === 0 : v === 1));
        const cResp = run.candidate.filter((r) => def.includeErrors || !r.error)[Math.max(0, badIdx)];
        const bResp = (def.includeErrors ? run.baseline : baselineOk)[0];
        examples.push({ id: run.id, metric: def.name, baseline: trimOut(bResp), candidate: trimOut(cResp) });
      }
    }
    if (!deltas.length) {
      if (candOnly.length) {
        // No baseline to compare with: report the candidate's own rate and its CI.
        const rate = mean(candOnly);
        const ci = bootstrapMeanCI(candOnly);
        const bad = def.direction === "higher-is-better" ? rate < 0.9 : rate > 0.1;
        metrics.push({ name: def.name, description: def.description, direction: def.direction, samples: candOnly.length, baseline: NaN, candidate: rate, delta: NaN, ci, noiseFloor: NaN, regression: bad, severity: "review", mode: "candidate-only" });
      }
      continue;
    }
    const delta = mean(deltas);
    const ci = bootstrapMeanCI(deltas);
    const noiseFloor = mean(noises);
    const worseSide = def.direction === "higher-is-better" ? ci[1] < 0 : ci[0] > 0;
    const regression = worseSide && Math.abs(delta) > noiseFloor;
    metrics.push({ name: def.name, description: def.description, direction: def.direction, samples: deltas.length, baseline: mean(bases), candidate: mean(cands), delta, ci, noiseFloor, regression, severity: "fail", mode: "paired" });
  }

  // Behaviour drift: is the candidate less similar to the baseline than the baseline is to itself?
  const drifts: number[] = [];
  const selfs: number[] = [];
  const crosses: number[] = [];
  for (const run of runs) {
    const sample = byId.get(run.id);
    const B = run.baseline.filter((r) => !r.error).map(outputRepr);
    const C = run.candidate.filter((r) => !r.error).map(outputRepr);
    if (!C.length || !B.length) continue;
    const pool = [...B, ...(sample?.reference && B.length < 2 ? [sample.reference] : [])];
    if (pool.length < 2) continue;
    const self: number[] = [];
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) self.push(similarity(pool[i], pool[j]));
    const cross: number[] = [];
    for (const c of C) for (const b of B) cross.push(similarity(c, b));
    selfs.push(mean(self));
    crosses.push(mean(cross));
    drifts.push(mean(self) - mean(cross));
  }
  const driftCi = bootstrapMeanCI(drifts);
  const drift = {
    samples: drifts.length,
    baselineSelfSimilarity: mean(selfs),
    crossSimilarity: mean(crosses),
    drift: mean(drifts),
    ci: driftCi,
    changed: drifts.length > 0 && driftCi[0] > 0,
  };

  const allB = runs.flatMap((r) => r.baseline).filter((r) => !r.error);
  const allC = runs.flatMap((r) => r.candidate).filter((r) => !r.error);
  const tok = (rs: ChatResponse[]) => {
    const v = rs.map((r) => r.outputTokens).filter((x): x is number => typeof x === "number");
    return v.length ? median(v) : undefined;
  };
  const perf: Analysis["perf"] = {
    baselineLatencyMs: median(allB.map((r) => r.latencyMs)),
    candidateLatencyMs: median(allC.map((r) => r.latencyMs)),
    baselineOutputTokens: tok(allB),
    candidateOutputTokens: tok(allC),
    baselineCost: costOf(allB, opts.baselineSpec ? opts.prices?.[opts.baselineSpec] : undefined),
    candidateCost: costOf(allC, opts.candidateSpec ? opts.prices?.[opts.candidateSpec] : undefined),
  };

  const reasons: string[] = [];
  const baselineCalls = runs.flatMap((r) => r.baseline);
  const baselineDead = baselineCalls.length > 0 && baselineCalls.every((r) => r.error);
  if (baselineDead) {
    const firstErr = baselineCalls[0].error ?? "";
    reasons.push(`baseline unavailable: all ${baselineCalls.length} baseline calls failed (${firstErr.slice(0, 120)}). The old model may already be removed; results below judge the candidate on its own against your expected outputs.`);
  }
  const fails = metrics.filter((m) => m.regression && m.mode === "paired");
  for (const m of fails) reasons.push(`${m.name}: ${pct(m.baseline)} → ${pct(m.candidate)} (95% CI of change ${pct(m.ci[0])} to ${pct(m.ci[1])}, beyond the baseline's own variation of ±${pct(m.noiseFloor)})`);
  for (const m of metrics.filter((x) => x.regression && x.mode === "candidate-only")) reasons.push(`${m.name}: candidate scores ${pct(m.candidate)} on its own (95% CI ${pct(m.ci[0])}–${pct(m.ci[1])}); no baseline to compare.`);
  if (drift.changed) reasons.push(`behaviour drift: outputs are less similar to the baseline (${drift.crossSimilarity.toFixed(2)}) than the baseline is to itself (${drift.baselineSelfSimilarity.toFixed(2)}). Review examples.`);
  if (perf.baselineLatencyMs && perf.candidateLatencyMs > perf.baselineLatencyMs * 2) reasons.push(`latency: median ${Math.round(perf.baselineLatencyMs)}ms → ${Math.round(perf.candidateLatencyMs)}ms`);
  // Verdict rules:
  //  - unsafe:      a paired check regressed beyond the noise floor
  //  - review:      candidate-only checks fell short, behaviour drifted, or latency doubled
  //  - likely-safe: none of the above
  const candOnlyFails = metrics.some((m) => m.regression && m.mode === "candidate-only");
  const softIssues = candOnlyFails || drift.changed || (perf.baselineLatencyMs > 0 && perf.candidateLatencyMs > perf.baselineLatencyMs * 2);
  const verdict: Analysis["verdict"] = fails.length ? "unsafe" : softIssues ? "review" : "likely-safe";
  const n = runs.length;
  let confidence: Analysis["confidence"] = n < 20 ? "low" : n < 50 ? "medium" : "high";
  if (baselineDead && confidence === "high") confidence = "medium"; // no noise floor without a baseline
  if (!reasons.length) reasons.push("No regression beyond the baseline's own run-to-run variation was detected.");

  return { metrics, drift, perf, verdict, confidence, reasons, examples };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function trimOut(r?: ChatResponse): string {
  if (!r) return "";
  if (r.error) return `[error] ${r.error}`;
  return outputRepr(r).slice(0, 600);
}

/* ------------------------------------------------------------------ estimate */

export function estimateRun(samples: Sample[], repeats: number, prices?: Prices, specs?: [string, string]): { calls: number; approxInputTokens: number; approxCostUsd?: number } {
  const chars = samples.reduce((s, x) => s + x.messages.reduce((a, m) => a + m.content.length, 0), 0);
  const perCallTokens = samples.length ? chars / 4 / samples.length : 0;
  const calls = samples.length * repeats * 2;
  const approxInputTokens = Math.round(perCallTokens * calls);
  let approxCostUsd: number | undefined;
  if (prices && specs) {
    const outGuess = 500; // tokens per answer, rough
    approxCostUsd = specs.reduce((sum, sp) => {
      const p = prices[sp];
      if (!p) return sum;
      const n = samples.length * repeats;
      return sum + (n * perCallTokens * p.input + n * outGuess * p.output) / 1_000_000;
    }, 0);
  }
  return { calls, approxInputTokens, approxCostUsd };
}
