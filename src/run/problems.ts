import type { ChatResponse } from "../providers/index.js";
import type { MetricResult, SampleRun } from "./index.js";

/**
 * Everything that went wrong while testing, as opposed to what the models did differently.
 * A "blocker" means part of the test didn't run, so the verdict can't say "likely safe";
 * a "warning" means some results rest on less data than planned.
 */
export interface Problem {
  severity: "blocker" | "warning";
  /** Short headline, e.g. "6 of 32 candidate calls failed". */
  title: string;
  /** What it means for the results and what to do about it. */
  detail: string;
}

/** Above this share of failed calls on either side, the comparison is too incomplete to trust. */
export const FAILED_CALLS_BLOCKER = 0.2;

const TRUNCATED = new Set(["length", "max_tokens", "MAX_TOKENS"]);

/** Groups error messages so one cause is reported once: "HTTP 429: ... (×12)". */
export function commonErrors(rs: ChatResponse[], top = 2): string {
  const counts = new Map<string, number>();
  for (const r of rs) {
    if (!r.error) continue;
    const key = r.error.replace(/\s+/g, " ").slice(0, 160);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = list.slice(0, top).map(([e, n]) => `"${e}"${n > 1 ? ` (×${n})` : ""}`);
  return shown.join("; ") + (list.length > top ? `; and ${list.length - top} other error${list.length - top > 1 ? "s" : ""}` : "");
}

function hint(errors: string): string {
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|access ?denied|invalid api key|security token|signature/i.test(errors)) return " Check the API key or credentials, and that they're allowed to call this model.";
  if (/\b429\b|rate|throttl|quota|too many requests/i.test(errors)) return " The provider rate-limited these calls: lower --concurrency, or raise your quota, then re-run (answers already received are cached).";
  if (/\b404\b|not[ _-]?found|does not exist|model identifier is invalid|end of (its )?life/i.test(errors)) return " The model id may be wrong, not offered in this region, or already retired.";
  if (/timeout|ETIMEDOUT|ECONNRESET|fetch failed|ENOTFOUND/i.test(errors)) return " Network or timeout problems: re-run to retry (answers already received are cached).";
  if (/\b5\d\d\b|overloaded|internal/i.test(errors)) return " The provider had server errors: re-run later to retry (answers already received are cached).";
  return "";
}

export function findProblems(
  runs: SampleRun[],
  metrics: MetricResult[],
  opts: { baselineSpec?: string; candidateSpec?: string; judge?: string; embed?: string; repeats?: number } = {},
): Problem[] {
  const out: Problem[] = [];
  if (!runs.length) return [{ severity: "blocker", title: "No samples were tested", detail: "The samples file was empty, so nothing was compared." }];

  // 1. Failed calls on each side.
  const sides = [
    ["baseline", opts.baselineSpec, runs.flatMap((r) => r.baseline)],
    ["candidate", opts.candidateSpec, runs.flatMap((r) => r.candidate)],
  ] as const;
  for (const [label, spec, rs] of sides) {
    const failed = rs.filter((r) => r.error);
    if (!failed.length) continue;
    const errors = commonErrors(failed);
    const name = spec ? `${label} (${spec})` : label;
    const all = failed.length === rs.length;
    const share = failed.length / rs.length;
    const effect =
      label === "baseline"
        ? all
          ? "There is nothing to compare against, so the candidate is only judged on its own against your expected outputs."
          : "Samples without a baseline answer have less data behind them."
        : all
          ? "The candidate never answered, so none of its behaviour was tested."
          : "Failed calls count against the candidate in the errors check; if the cause is on your side (keys, quota), fix it and re-run.";
    out.push({
      // Baseline failures only reduce the data (a dead baseline switches to judging the candidate on its own);
      // candidate failures mean part of the new model's behaviour went untested.
      severity: label === "candidate" && (all || share >= FAILED_CALLS_BLOCKER) ? "blocker" : "warning",
      title: `${failed.length} of ${rs.length} ${label} calls failed`,
      detail: `${name}: ${errors}. ${effect}${hint(errors)}`,
    });
  }

  // 2. Samples left out of the paired comparison.
  const noBase = runs.filter((r) => r.baseline.length && r.baseline.every((x) => x.error) && r.candidate.some((x) => !x.error));
  const noCand = runs.filter((r) => r.candidate.length && r.candidate.every((x) => x.error) && r.baseline.some((x) => !x.error));
  const neither = runs.filter((r) => [...r.baseline, ...r.candidate].every((x) => x.error));
  const allBaseDead = runs.every((r) => r.baseline.every((x) => x.error));
  if (noBase.length && !allBaseDead) out.push({ severity: "warning", title: `${noBase.length} sample${noBase.length > 1 ? "s" : ""} had no baseline answer`, detail: `Left out of the paired checks: ${ids(noBase)}.` });
  if (noCand.length && !runs.every((r) => r.candidate.every((x) => x.error))) out.push({ severity: "warning", title: `${noCand.length} sample${noCand.length > 1 ? "s" : ""} had no candidate answer`, detail: `Only the errors check covers these: ${ids(noCand)}.` });
  if (neither.length && neither.length < runs.length) out.push({ severity: "warning", title: `${neither.length} sample${neither.length > 1 ? "s" : ""} got no answer from either model`, detail: `Not tested at all: ${ids(neither)}.` });

  // 3. Answers cut off by the token limit look like format or quality failures.
  for (const [label, , rs] of sides) {
    const cut = rs.filter((r) => !r.error && r.finishReason && TRUNCATED.has(r.finishReason));
    if (cut.length)
      out.push({
        severity: "warning",
        title: `${cut.length} ${label} answer${cut.length > 1 ? "s were" : " was"} cut off by the token limit`,
        detail: `Cut-off answers can fail JSON or assertion checks for that reason alone. Raise max_tokens in the samples (or the Promptfoo config) and re-run.`,
      });
  }

  // 4. Judge calls that failed.
  if (opts.judge) {
    const scores = runs.flatMap((r) => (r.judge ? [...r.judge.baseline, ...r.judge.candidate] : []));
    const failed = scores.filter((s) => s === null).length;
    const judged = runs.filter((r) => r.judge).length;
    if (!scores.length || failed === scores.length)
      out.push({ severity: "blocker", title: `The judge check didn't run`, detail: `Every call to ${opts.judge} failed${judged ? "" : " or there were no answers to judge"}, so answer quality wasn't compared. Check the judge model's key and id, then re-run (model answers are cached).` });
    else if (failed)
      out.push({ severity: failed / scores.length >= FAILED_CALLS_BLOCKER ? "blocker" : "warning", title: `${failed} of ${scores.length} judge calls failed`, detail: `Those answers weren't judged, so the judge check rests on fewer answers than planned. Re-run to retry (successful judgements are cached).` });
  }

  // 5. Embeddings that failed (the meaning check).
  if (opts.embed) {
    const semantic = metrics.find((m) => m.name === "semantic");
    const withAnswers = runs.filter((r) => r.baseline.some((x) => !x.error) && r.candidate.some((x) => !x.error));
    const missing = withAnswers.filter((r) => !r.semantic || r.semantic.cross === null);
    if ((opts.repeats ?? 2) < 2)
      out.push({ severity: "warning", title: `The meaning check needs --repeats 2 or more`, detail: `It compares new answers with the old model's own variation, which needs at least two baseline answers per sample.` });
    else if (!semantic)
      out.push({ severity: "blocker", title: `The meaning check didn't run`, detail: `No answers could be embedded with ${opts.embed}, so meaning wasn't compared. Check the embedding model's key and id, then re-run (model answers are cached).` });
    else if (missing.length)
      out.push({ severity: "warning", title: `${missing.length} sample${missing.length > 1 ? "s" : ""} missing from the meaning check`, detail: `Their answers couldn't be embedded with ${opts.embed}: ${ids(missing)}.` });
  }

  // 6. Checks that saw changes but had too few samples to test them.
  for (const m of metrics) {
    if (m.mode === "paired" && m.inFamily === false && (m.changed ?? 0) > 0 && m.delta !== 0 && (m.direction === "higher-is-better" ? m.delta < 0 : m.delta > 0))
      out.push({
        severity: "warning",
        title: `Too few samples to test the ${m.name} check`,
        detail: `It got worse on ${m.changed} of ${m.samples} samples, but with this few changes no result could be significant. Add samples that exercise it.`,
      });
  }
  return out;
}

function ids(rs: SampleRun[]): string {
  const shown = rs.slice(0, 6).map((r) => r.id);
  return shown.join(", ") + (rs.length > 6 ? ` and ${rs.length - 6} more` : "");
}
