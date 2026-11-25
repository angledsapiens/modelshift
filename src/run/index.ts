import type { ChatProvider, ChatResponse } from "../providers/index.js";
import type { Sample } from "../capture.js";
import { bootstrapMeanCI, bootstrapMeanTest, holmAdjust, mean, meanPairwiseAbsDiff, median, minAttainableP } from "./stats.js";
import { assertionsPass, hasAssertions, isJson, isRefusal, mode, outputRepr, similarity, toolSignature, topLevelKeys } from "./checks.js";
import type { JudgeScores } from "./judge.js";
import { ResponseCache } from "./cache.js";
import { SEMANTIC_MIN_EFFECT, type SemanticScores } from "./semantic.js";

export interface SampleRun {
  id: string;
  baseline: ChatResponse[];
  candidate: ChatResponse[];
  /** Present when the run was judged by an LLM (--judge). */
  judge?: JudgeScores;
  /** Present when outputs were embedded (--embed). */
  semantic?: SemanticScores;
}

export interface RunMeta {
  baseline: string;
  candidate: string;
  repeats: number;
  startedAt: string;
  finishedAt?: string;
  toolVersion: string;
  judge?: string;
  embed?: string;
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
  /** Paired checks only: bootstrap p-value for "worse", and after Holm correction across all paired checks in this run. */
  p?: number;
  pAdjusted?: number;
  /** Paired checks only: samples whose value changed between the models (in either direction). */
  changed?: number;
  /** Paired checks only: false when the check couldn't reach significance even on its own, so it isn't part of the correction. */
  inFamily?: boolean;
  /** Smallest change that matters in practice (on top of the noise floor), for continuous scores. */
  minEffect?: number;
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

export async function pool<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
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
  opts: { repeats?: number; concurrency?: number; temperature?: number; onProgress?: (done: number, total: number) => void; toolVersion?: string; cache?: ResponseCache },
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
          const req = sampleRequest(s, opts.temperature);
          const res = opts.cache ? await opts.cache.chat(provider, req, r) : await provider.chat(req);
          runs[i][which][r] = res; // by slot, so repeat order is stable across runs and the cache
          opts.onProgress?.(++done, total);
        });
      }
    }
  });
  await pool(tasks, opts.concurrency ?? 4);
  meta.finishedAt = new Date().toISOString();
  return { meta, runs };
}

export function sampleRequest(s: Sample, temperature?: number) {
  return { messages: s.messages, tools: s.tools, temperature: temperature ?? s.temperature, max_tokens: s.max_tokens, json: s.json };
}

/** Calls a run still has to make: unique (model, sample, repeat) slots that aren't cached yet. */
export function uncachedCalls(samples: Sample[], specs: string[], repeats: number, cache?: ResponseCache, temperature?: number): number {
  const seen = new Set<string>();
  let n = 0;
  for (const spec of specs) for (const s of samples) for (let r = 0; r < repeats; r++) {
    const k = ResponseCache.key(spec, sampleRequest(s, temperature), r);
    if (seen.has(k)) continue;
    seen.add(k);
    if (!cache?.has(k)) n++;
  }
  return n;
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
    description: "Passes the sample's own expected-output rules (expect.match / notMatch / json).",
    direction: "higher-is-better",
    applies: (s) => hasAssertions(s.expect),
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
      const applies = def.includeErrors || (baselineOk.length ? def.applies(sample, baselineOk) : def.name === "assertions" ? def.applies(sample, []) : def.name === "json-valid" ? !!sample.json : def.name === "refusals");
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
    const { ci, p } = bootstrapMeanTest(deltas, def.direction === "higher-is-better" ? "negative" : "positive");
    const noiseFloor = mean(noises);
    metrics.push({ name: def.name, description: def.description, direction: def.direction, samples: deltas.length, baseline: mean(bases), candidate: mean(cands), delta, ci, noiseFloor, regression: false, severity: "fail", mode: "paired", p, changed: deltas.filter((d) => d !== 0).length });
  }

  const judgeMetric = judgeMetricOf(runs, examples);
  if (judgeMetric) metrics.push(judgeMetric);
  const semanticMetric = semanticMetricOf(runs);
  if (semanticMetric) metrics.push(semanticMetric);
  const family = correctForMultipleChecks(metrics);

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
  // Hosts can silently serve a different model under the requested name (e.g. DeepInfra redirects retired models).
  for (const [label, spec, rs] of [["baseline", opts.baselineSpec, runs.flatMap((r) => r.baseline)], ["candidate", opts.candidateSpec, runs.flatMap((r) => r.candidate)]] as const) {
    const redirect = spec ? redirectedTo(spec, rs) : undefined;
    if (redirect) reasons.push(`${label} redirected: you asked for ${spec} but the provider served "${redirect}". You are comparing against a different model than named.`);
  }
  const baselineCalls = runs.flatMap((r) => r.baseline);
  const baselineDead = baselineCalls.length > 0 && baselineCalls.every((r) => r.error);
  if (baselineDead) {
    const firstErr = baselineCalls[0].error ?? "";
    reasons.push(`baseline unavailable: all ${baselineCalls.length} baseline calls failed (${firstErr.slice(0, 120)}). The old model may already be removed; results below judge the candidate on its own against your expected outputs.`);
  }
  const fails = metrics.filter((m) => m.regression && m.mode === "paired" && m.severity === "fail");
  const corrected = family > 1 ? `; significant after correcting for ${family} checks` : "";
  for (const m of fails) reasons.push(`${m.name}: ${pct(m.baseline)} → ${pct(m.candidate)} (95% CI of change ${pct(m.ci[0])} to ${pct(m.ci[1])}, beyond the baseline's own variation of ±${pct(m.noiseFloor)}${corrected})`);
  const near = nearMisses(metrics);
  for (const m of near) reasons.push(`${m.name}: ${pct(m.baseline)} → ${pct(m.candidate)} (95% CI of change ${pct(m.ci[0])} to ${pct(m.ci[1])}) is worse on its own, but not after correcting for ${family} checks. Add samples to confirm.`);
  for (const m of metrics.filter((x) => x.regression && x.mode === "paired" && x.severity === "review")) reasons.push(`${m.name}: ${m.baseline.toFixed(2)} → ${m.candidate.toFixed(2)} (95% CI of change ${m.ci[0].toFixed(3)} to ${m.ci[1].toFixed(3)}). Review examples.`);
  for (const m of metrics.filter((x) => x.regression && x.mode === "candidate-only")) reasons.push(`${m.name}: candidate scores ${pct(m.candidate)} on its own (95% CI ${pct(m.ci[0])}–${pct(m.ci[1])}); no baseline to compare.`);
  if (drift.changed) reasons.push(`behaviour drift: outputs are less similar to the baseline (${drift.crossSimilarity.toFixed(2)}) than the baseline is to itself (${drift.baselineSelfSimilarity.toFixed(2)}). Review examples.`);
  if (perf.baselineLatencyMs && perf.candidateLatencyMs > perf.baselineLatencyMs * 2) reasons.push(`latency: median ${Math.round(perf.baselineLatencyMs)}ms → ${Math.round(perf.candidateLatencyMs)}ms`);
  // Verdict rules:
  //  - unsafe:      a paired check regressed beyond the noise floor
  //  - review:      candidate-only checks fell short, behaviour drifted, or latency doubled
  //  - likely-safe: none of the above
  const candOnlyFails = metrics.some((m) => m.regression && (m.mode === "candidate-only" || m.severity === "review"));
  const softIssues = candOnlyFails || near.length > 0 || drift.changed || reasons.some((x) => x.includes(" redirected: ")) || (perf.baselineLatencyMs > 0 && perf.candidateLatencyMs > perf.baselineLatencyMs * 2);
  const verdict: Analysis["verdict"] = fails.length ? "unsafe" : softIssues ? "review" : "likely-safe";
  const n = runs.length;
  let confidence: Analysis["confidence"] = n < 20 ? "low" : n < 50 ? "medium" : "high";
  if (baselineDead && confidence === "high") confidence = "medium"; // no noise floor without a baseline
  if (!reasons.length) reasons.push("No regression beyond the baseline's own run-to-run variation was detected.");

  return { metrics, drift, perf, verdict, confidence, reasons, examples };
}

/**
 * Several checks run on the same comparison, so a 95% test on each would raise a false alarm
 * somewhere more than 5% of the time. Holm-adjust the paired checks' p-values together, then
 * flag a check only if it is significant after adjustment AND bigger than the noise floor.
 * Checks that couldn't reach p < 0.05 even on their own (too few samples changed) can never
 * alarm, so they don't count toward the correction. Returns the family size.
 */
function correctForMultipleChecks(metrics: MetricResult[]): number {
  const paired = metrics.filter((m) => m.mode === "paired" && m.p !== undefined);
  for (const m of paired) m.inFamily = minAttainableP(m.samples, m.changed ?? m.samples) < 0.05;
  const family = paired.filter((m) => m.inFamily);
  const adj = holmAdjust(family.map((m) => m.p!));
  family.forEach((m, i) => {
    m.pAdjusted = adj[i];
    m.regression = adj[i] < 0.05 && Math.abs(m.delta) > m.noiseFloor + (m.minEffect ?? 0);
  });
  for (const m of paired) if (!m.inFamily) {
    m.pAdjusted = 1;
    m.regression = false;
  }
  return family.length;
}

/** Worse on its own, but not after the correction: worth a look, and more samples. */
function nearMisses(metrics: MetricResult[]): MetricResult[] {
  return metrics.filter((m) => m.mode === "paired" && m.severity === "fail" && !m.regression && m.inFamily && (m.p ?? 1) < 0.05 && Math.abs(m.delta) > m.noiseFloor);
}

/** Meaning-based similarity: new vs old answers, against the old model's similarity to itself. */
function semanticMetricOf(runs: SampleRun[]): MetricResult | undefined {
  const scored = runs.filter((r) => r.semantic && r.semantic.self !== null && r.semantic.cross !== null);
  if (!scored.length) return undefined;
  const bases = scored.map((r) => r.semantic!.self!);
  const cands = scored.map((r) => r.semantic!.cross!);
  const deltas = cands.map((c, i) => c - bases[i]);
  const { ci, p } = bootstrapMeanTest(deltas, "negative");
  return {
    name: "semantic",
    description: `Meaning-based similarity (${scored[0].semantic!.model} embeddings) of new answers to old ones, against the old model's similarity to itself. A review signal: flagged when reliably more than ${SEMANTIC_MIN_EFFECT} lower.`,
    direction: "higher-is-better",
    samples: deltas.length,
    baseline: mean(bases),
    candidate: mean(cands),
    delta: mean(deltas),
    ci,
    noiseFloor: 0, // the baseline's self-similarity is already the reference
    minEffect: SEMANTIC_MIN_EFFECT,
    regression: false,
    severity: "review",
    mode: "paired",
    p,
    changed: deltas.filter((d) => d !== 0).length,
  };
}

/** LLM-judge agreement: candidate vs first baseline answer, against the baseline's agreement with itself. */
function judgeMetricOf(runs: SampleRun[], examples: Analysis["examples"]): MetricResult | undefined {
  const judged = runs.filter((r) => r.judge);
  if (!judged.length) return undefined;
  const spec = judged[0].judge!.judge;
  const description = `LLM judge (${spec}) rates the answer an acceptable substitute for the baseline's answer.`;
  const deltas: number[] = [];
  const bases: number[] = [];
  const cands: number[] = [];
  const noises: number[] = [];
  const candOnly: number[] = [];
  for (const run of judged) {
    const j = run.judge!;
    const b = j.baseline.filter((v): v is number => v !== null);
    const c = j.candidate.filter((v): v is number => v !== null);
    if (!c.length) continue;
    const bad = j.candidate.findIndex((v) => v === 0);
    if (bad >= 0 && examples.filter((e) => e.metric === "judge").length < 3) {
      const ref = j.reference === "baseline" ? trimOut(run.baseline.find((r) => !r.error)) : "[logged reference]";
      examples.push({ id: run.id, metric: "judge", baseline: ref, candidate: trimOut(run.candidate.filter((r) => !r.error)[bad]) });
    }
    // Without baseline repeats there is no measure of the old model's self-agreement: judge the candidate alone.
    if (!b.length) {
      candOnly.push(mean(c));
      continue;
    }
    const bm = mean(b);
    const cm = mean(c);
    bases.push(bm);
    cands.push(cm);
    deltas.push(cm - bm);
    noises.push(meanPairwiseAbsDiff([1, ...b])); // the reference agrees with itself
  }
  if (deltas.length) {
    const delta = mean(deltas);
    const { ci, p } = bootstrapMeanTest(deltas, "negative");
    const noiseFloor = mean(noises);
    return { name: "judge", description, direction: "higher-is-better", samples: deltas.length, baseline: mean(bases), candidate: mean(cands), delta, ci, noiseFloor, regression: false, severity: "fail", mode: "paired", p, changed: deltas.filter((d) => d !== 0).length };
  }
  if (candOnly.length) {
    const rate = mean(candOnly);
    return { name: "judge", description, direction: "higher-is-better", samples: candOnly.length, baseline: NaN, candidate: rate, delta: NaN, ci: bootstrapMeanCI(candOnly), noiseFloor: NaN, regression: rate < 0.9, severity: "review", mode: "candidate-only" };
  }
  return undefined;
}

/** The served model, if it differs from the requested one (ignoring "models/" prefixes and dated-snapshot aliases). */
export function redirectedTo(spec: string, rs: ChatResponse[]): string | undefined {
  const requested = spec.slice(spec.indexOf(":") + 1).toLowerCase().replace(/^models\//, "");
  for (const r of rs) {
    if (r.error || !r.servedModel) continue;
    const served = r.servedModel.toLowerCase().replace(/^models\//, "");
    if (served === requested || served.startsWith(requested + "-")) continue; // alias -> dated snapshot is normal
    return r.servedModel;
  }
  return undefined;
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
