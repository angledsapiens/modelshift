import { resolve } from "node:path";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { loadCalendar, todayIso } from "./calendar.js";
import { assess, scanRepo, sortAssessments } from "./scan/index.js";
import { liveCheck, type ProviderName, type ProviderResult } from "./live/index.js";
import { parseSamplesJsonl } from "./capture.js";
import { createProvider } from "./providers/index.js";
import { analyze, estimateRun, executeRun, pool, type Prices, type RunResult } from "./run/index.js";
import { judgeCallCount, judgeRuns } from "./run/judge.js";
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
  out?: string;
  html?: string;
  /** Proceed even above the spend guard. */
  yes?: boolean;
  maxCallsWithoutConfirm?: number;
}

export interface RunPlan {
  samples: number;
  repeats: number;
  candidates: number;
  calls: number;
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

export async function runCore(o: RunOptions, hooks: { onPlan?: (p: RunPlan) => void; onProgress?: (spec: string, done: number, total: number) => void } = {}): Promise<RunOutput> {
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

  const per = estimateRun(samples, repeats, prices, [baseline.spec, candidates[0].spec]);
  const calls = per.calls * candidates.length;
  const judgeCalls = judge ? judgeCallCount(samples.length, repeats) * candidates.length : 0;
  const plan: RunPlan = {
    samples: samples.length,
    repeats,
    candidates: candidates.length,
    calls,
    judgeCalls,
    approxInputTokens: per.approxInputTokens * candidates.length,
    approxCostUsd: per.approxCostUsd !== undefined ? per.approxCostUsd * candidates.length : undefined,
    text: `Plan: ${samples.length} samples × ${repeats} repeats × 2 models × ${candidates.length} candidate(s) = ${calls} API calls${judge ? ` + up to ${judgeCalls} judge calls (${judge.spec})` : ""} (~${(per.approxInputTokens * candidates.length).toLocaleString()} input tokens${per.approxCostUsd !== undefined ? `, ~$${(per.approxCostUsd * candidates.length).toFixed(2)} excluding the judge` : ""}).`,
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
      onProgress: (d, t) => hooks.onProgress?.(candidate.spec, d, t),
    });
    if (judge) {
      meta.judge = judge.spec;
      await judgeRuns(samples, runs, judge, { concurrency, pool, onProgress: (d, t) => hooks.onProgress?.(`judge ${candidate.spec}`, d, t) });
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
