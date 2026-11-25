import { resolve } from "node:path";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { loadCalendar, todayIso } from "./calendar.js";
import { assess, scanRepo, sortAssessments } from "./scan/index.js";
import { liveCheck, type ProviderName, type ProviderResult } from "./live/index.js";
import { parseSamplesJsonl, samplesToJsonl } from "./capture.js";
import { importPromptfoo, type PromptfooImport } from "./import/promptfoo.js";
import { createEmbedder, createProvider } from "./providers/index.js";
import { analyze, estimateRun, executeRun, pool, uncachedCalls, type Prices, type RunResult } from "./run/index.js";
import { DEFAULT_CACHE_DIR, ResponseCache } from "./run/cache.js";
import { judgeCallCount, judgeRuns } from "./run/judge.js";
import { embedRuns } from "./run/semantic.js";
import { renderHtmlReport } from "./report/html.js";
import type { Assessment, Calendar, Host } from "./types.js";

export const VERSION = "0.1.0-dev";
export const CONFIRM_ABOVE_CALLS = 60;

export class UsageError extends Error {}

/* ------------------------------------------------------------------ scan */

export interface ScanOptions {
  path?: string;
  live?: boolean;
  probe?: boolean;
  providers?: ProviderName[];
  includeMarkdown?: boolean;
  calendar?: string;
  today?: string;
}

export interface ScanOutput {
  root: string;
  today: string;
  calendar: Calendar;
  models: Assessment[];
  live: ProviderResult[];
}

export async function scanCore(o: ScanOptions): Promise<ScanOutput> {
  const root = resolve(o.path ?? ".");
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new UsageError(`Not a directory: ${root}`);
  const calendar = loadCalendar(o.calendar);
  const today = o.today ?? todayIso();
  const findings = scanRepo(root, { includeMarkdown: o.includeMarkdown });
  let models = assess(findings, calendar, today);
  let live: ProviderResult[] = [];
  if (o.live || o.probe) {
    const repoHosts = [...new Set(findings.flatMap((f) => f.hosts))] as Host[];
    ({ assessments: models, results: live } = await liveCheck(models, { only: o.providers, repoHosts, probe: !!o.probe }));
  }
  return { root, today, calendar, models: sortAssessments(models), live };
}

export const FAIL_LEVELS: Record<string, string[]> = {
  retired: ["retired", "missing"],
  retiring: ["retired", "missing", "redirected", "flagged", "retiring"],
  any: ["retired", "missing", "redirected", "unlisted", "flagged", "retiring", "deprecated", "check"],
};

export function scanJson(s: ScanOutput): object {
  return { root: s.root, today: s.today, calendarUpdated: s.calendar.updated, models: s.models, live: s.live.map((r) => ({ provider: r.provider, ok: r.ok, skipped: r.skipped, error: r.error, listed: r.models?.size })) };
}

/* ------------------------------------------------------------------ run */

export interface RunOptions {
  from: string;
  to: string[];
  samples?: string;
  repeats?: number;
  concurrency?: number;
  temperature?: number;
  prices?: string;
  judge?: string;
  /** Embedding model (provider:model) for the meaning-based similarity check. */
  embed?: string;
  out?: string;
  html?: string;
  /** Response cache folder (default .modelshift/cache); false to always call the models. */
  cache?: string | false;
  /** Proceed even above the spend guard. */
  yes?: boolean;
  maxCallsWithoutConfirm?: number;
}

export interface RunPlan {
  samples: number;
  repeats: number;
  candidates: number;
  /** Model calls still to make (after the cache). */
  calls: number;
  /** Model calls served from the cache. */
  cachedCalls: number;
  judgeCalls: number;
  approxInputTokens: number;
  approxCostUsd?: number;
  text: string;
}

export class SpendGuardError extends Error {
  constructor(public plan: RunPlan) {
    super(`This will make ${plan.calls + plan.judgeCalls} paid API calls. Re-run with --yes to proceed, or lower --repeats / use fewer samples.`);
  }
}

export interface RunOutput {
  plan: RunPlan;
  results: { spec: string; result: RunResult; out: string }[];
  html?: string;
}

export async function runCore(o: RunOptions, hooks: { onPlan?: (p: RunPlan) => void; onProgress?: (spec: string, done: number, total: number) => void; onWarning?: (msg: string) => void } = {}): Promise<RunOutput> {
  const samplesFile = o.samples ?? "modelshift-samples.jsonl";
  if (!existsSync(samplesFile)) throw new UsageError(`Samples file not found: ${samplesFile}. Create one with "modelshift capture <logs.jsonl>".`);
  const samples = parseSamplesJsonl(readFileSync(samplesFile, "utf8"));
  if (!samples.length) throw new UsageError(`No samples in ${samplesFile}.`);
  const repeats = Math.max(1, o.repeats ?? 3);
  const concurrency = Math.max(1, o.concurrency ?? 4);
  const prices: Prices | undefined = o.prices ? JSON.parse(readFileSync(o.prices, "utf8")) : undefined;

  // Validate specs and keys before spending anything.
  const baseline = createProvider(o.from);
  const candidates = o.to.map((s) => createProvider(s));
  if (!candidates.length) throw new UsageError("Give at least one --to model.");
  const judge = o.judge ? createProvider(o.judge) : undefined;
  let embedder;
  try {
    embedder = o.embed ? createEmbedder(o.embed) : undefined;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }

  const cache = o.cache === false ? undefined : new ResponseCache(o.cache ?? DEFAULT_CACHE_DIR);
  const per = estimateRun(samples, repeats, prices, [baseline.spec, candidates[0].spec]);
  // The baseline is called once even with several candidates (later candidates reuse it from the cache).
  const specs = [baseline.spec, ...candidates.map((c) => c.spec)];
  const totalCalls = cache ? uncachedCalls(samples, specs, repeats, undefined, o.temperature) : per.calls * candidates.length;
  const calls = cache ? uncachedCalls(samples, specs, repeats, cache, o.temperature) : totalCalls;
  const cachedCalls = totalCalls - calls;
  const costScale = per.calls ? calls / (per.calls * candidates.length) : 0;
  const judgeCalls = judge ? judgeCallCount(samples.length, repeats) * candidates.length : 0;
  const plan: RunPlan = {
    samples: samples.length,
    repeats,
    candidates: candidates.length,
    calls,
    cachedCalls,
    judgeCalls,
    approxInputTokens: Math.round(per.approxInputTokens * candidates.length * costScale),
    approxCostUsd: per.approxCostUsd !== undefined ? per.approxCostUsd * candidates.length * costScale : undefined,
    text: `Plan: ${samples.length} samples × ${repeats} repeats on ${specs.length} models = ${calls} API calls${cachedCalls ? ` (${cachedCalls} more already cached)` : ""}${judge ? ` + up to ${judgeCalls} judge calls (${judge.spec}${cache ? ", cached ones free" : ""})` : ""}${embedder ? ` + a few embedding calls (${embedder.spec}, ~${Math.ceil((samples.length * repeats * specs.length) / 64)} batches)` : ""} (~${Math.round(per.approxInputTokens * candidates.length * costScale).toLocaleString()} input tokens${per.approxCostUsd !== undefined ? `, ~$${(per.approxCostUsd * candidates.length * costScale).toFixed(2)} excluding the judge` : ""}).`,
  };
  hooks.onPlan?.(plan);
  if (calls + judgeCalls > (o.maxCallsWithoutConfirm ?? CONFIRM_ABOVE_CALLS) && !o.yes) throw new SpendGuardError(plan);

  const outBase = o.out ?? "modelshift-results.json";
  const results: RunOutput["results"] = [];
  for (const [i, candidate] of candidates.entries()) {
    const { meta, runs } = await executeRun(samples, baseline, candidate, {
      repeats,
      concurrency,
      temperature: o.temperature,
      toolVersion: VERSION,
      cache,
      onProgress: (d, t) => hooks.onProgress?.(candidate.spec, d, t),
    });
    if (judge) {
      meta.judge = judge.spec;
      await judgeRuns(samples, runs, judge, { concurrency, pool, cache, onProgress: (d, t) => hooks.onProgress?.(`judge ${candidate.spec}`, d, t) });
    }
    if (embedder) {
      meta.embed = embedder.spec;
      const e = await embedRuns(runs, embedder, { cache, concurrency, pool, onProgress: (d, t) => hooks.onProgress?.(`embed ${candidate.spec}`, d, t) });
      if (e.failed) hooks.onWarning?.(`${e.failed} outputs could not be embedded with ${embedder.spec}: ${e.error ?? "unknown error"}`);
    }
    const analysis = analyze(samples, runs, { prices, baselineSpec: baseline.spec, candidateSpec: candidate.spec });
    const result: RunResult = { meta, samples, runs, analysis };
    const out = candidates.length === 1 ? outBase : outBase.replace(/(\.json)?$/, `-${i + 1}.json`);
    writeFileSync(out, JSON.stringify(result, null, 2));
    results.push({ spec: candidate.spec, result, out });
  }
  let html: string | undefined;
  if (o.html) {
    writeFileSync(o.html, renderHtmlReport(results.map((r) => r.result)));
    html = o.html;
  }
  return { plan, results, html };
}

/* ------------------------------------------------------------------ import */

export const PROMPTFOO_CONFIGS = ["promptfooconfig.yaml", "promptfooconfig.yml", "promptfooconfig.json"];

export function importCore(from: string, config?: string, out = "modelshift-samples.jsonl"): { result: PromptfooImport; out: string; text: string } {
  if (from !== "promptfoo") throw new UsageError(`Unknown import source "${from}". Supported: promptfoo`);
  const file = config ?? PROMPTFOO_CONFIGS.find((f) => existsSync(f));
  if (!file) throw new UsageError(`No Promptfoo config found. Give its path: modelshift import promptfoo path/to/promptfooconfig.yaml`);
  let result: PromptfooImport;
  try {
    result = importPromptfoo(file);
  } catch (e) {
    throw new UsageError(`Could not import ${file}: ${(e as Error).message}`);
  }
  if (!result.samples.length) throw new UsageError(`${file}: no prompt × test combinations could be imported.${result.warnings.length ? "\n" + result.warnings.join("\n") : ""}`);
  writeFileSync(out, samplesToJsonl(result.samples));
  const lines = [`Imported ${result.samples.length} samples from ${file} into ${out}.`];
  const withRules = result.samples.filter((s) => s.expect).length;
  const mappedN = Object.values(result.mapped).reduce((a, b) => a + b, 0);
  lines.push(`Assertions translated: ${mappedN} (${Object.entries(result.mapped).map(([k, v]) => `${k} ×${v}`).join(", ") || "none"}); ${withRules} of ${result.samples.length} samples have expected-output rules.`);
  const sk = Object.entries(result.skipped);
  if (sk.length) {
    lines.push(`Not translated:`);
    for (const [k, v] of sk) lines.push(`  ${k} ×${v.count}: ${v.hint}`);
  }
  for (const w of result.warnings) lines.push(`Note: ${w}`);
  const specs = result.providers.filter((p) => p.spec).map((p) => p.spec!);
  const unmapped = result.providers.filter((p) => !p.spec).map((p) => p.promptfoo);
  if (unmapped.length) lines.push(`Providers without a modelshift adapter: ${unmapped.join(", ")}`);
  const fromSpec = specs[0] ?? "<provider:current-model>";
  const toSpec = specs[1] ?? "<provider:new-model>";
  lines.push("", `Next: modelshift run --from ${fromSpec} --to ${toSpec} --samples ${out}`);
  return { result, out, text: lines.join("\n") };
}

/* ------------------------------------------------------------------ report */

export function loadResults(files: string[]): RunResult[] {
  if (!files.length) throw new UsageError("Give one or more results files, e.g. modelshift report modelshift-results.json");
  return files.map((f) => {
    if (!existsSync(f)) throw new UsageError(`Results file not found: ${f}`);
    const r = JSON.parse(readFileSync(f, "utf8")) as RunResult;
    if (!r?.meta || !r?.analysis || !Array.isArray(r.runs)) throw new UsageError(`${f} is not a modelshift results file.`);
    // Re-analyse from the raw runs so files from older versions get current checks.
    // Costs depend on --prices, which isn't stored, so keep the recorded ones.
    const fresh = analyze(r.samples, r.runs, { baselineSpec: r.meta.baseline, candidateSpec: r.meta.candidate });
    fresh.perf.baselineCost = r.analysis.perf?.baselineCost;
    fresh.perf.candidateCost = r.analysis.perf?.candidateCost;
    return { ...r, analysis: fresh };
  });
}

export function reportCore(files: string[], out = "modelshift-report.html"): { out: string; results: RunResult[] } {
  const results = loadResults(files);
  writeFileSync(out, renderHtmlReport(results));
  return { out, results };
}
