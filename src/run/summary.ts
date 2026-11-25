import type { RunResult } from "./index.js";
import type { Problem } from "./problems.js";

/** Plain-text list of problems during testing, blockers first. */
export function problemsText(problems: Problem[], indent = "  "): string[] {
  if (!problems.length) return [];
  const sorted = [...problems].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "blocker" ? -1 : 1));
  const blockers = problems.filter((p) => p.severity === "blocker").length;
  const lines = [`Problems during testing (${problems.length}${blockers ? `, ${blockers} stopped part of the test` : ""}):`];
  for (const p of sorted) lines.push(`${indent}${p.severity === "blocker" ? "✖" : "!"} ${p.title}`, `${indent}  ${p.detail}`, ...(p.items ?? []).map((i) => `${indent}    - ${i}`));
  return lines;
}

/** Median latency, or "—" when the model never answered. */
const ms = (x: number, sep = "") => (Number.isFinite(x) ? `${Math.round(x)}${sep}ms` : "—");
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a");
const signed = (x: number) => (x >= 0 ? "+" : "") + pct(x);

const VERDICT: Record<string, string> = {
  "likely-safe": "LIKELY SAFE TO SWITCH",
  review: "REVIEW BEFORE SWITCHING",
  unsafe: "NOT SAFE TO SWITCH YET",
};

export function compareCandidatesText(list: { spec: string; result: RunResult }[]): string {
  const names = [...new Set(list.flatMap((x) => x.result.analysis.metrics.map((m) => m.name)))];
  const lines = ["Candidates compared:", ["candidate".padEnd(42), "verdict".padEnd(12), ...names.map((n) => n.padEnd(11)), "latency"].join(" ")];
  for (const { spec, result } of list) {
    const a = result.analysis;
    const cells = names.map((n) => {
      const m = a.metrics.find((x) => x.name === n);
      return (m ? pct(m.candidate) + (m.regression ? "✗" : "") : "—").padEnd(11);
    });
    const incomplete = (a.problems ?? []).some((p) => p.severity === "blocker");
    lines.push([spec.padEnd(42), (a.verdict + (incomplete ? "*" : "")).padEnd(12), ...cells, `${ms(a.perf.candidateLatencyMs, "")}`].join(" "));
  }
  if (list.some(({ result }) => (result.analysis.problems ?? []).some((p) => p.severity === "blocker"))) lines.push("* testing was incomplete for this candidate: see its problems above");
  return lines.join("\n");
}

export function runSummaryText(r: RunResult): string {
  const a = r.analysis;
  const lines: string[] = [];
  lines.push("");
  lines.push(`${r.meta.baseline}  →  ${r.meta.candidate}   (${r.runs.length} samples × ${r.meta.repeats} repeats)`);
  lines.push(`Verdict: ${VERDICT[a.verdict]}  (confidence: ${a.confidence}${a.confidence === "low" ? " — add more samples" : ""}; never a guarantee)`);
  for (const reason of a.reasons) lines.push(`  - ${reason}`);
  const problems = problemsText(a.problems ?? []);
  if (problems.length) lines.push("", ...problems);
  lines.push("");
  lines.push("Check            baseline  candidate  change (95% CI)           noise   n");
  for (const m of a.metrics) {
    const flag = (m.regression ? (m.severity === "review" ? " ⚠ review" : " ✗") : "") + (m.mode === "candidate-only" ? "  (candidate only)" : "");
    lines.push(
      `${m.name.padEnd(16)} ${pct(m.baseline).padStart(8)}  ${pct(m.candidate).padStart(9)}  ${`${signed(m.delta)} [${pct(m.ci[0])}, ${pct(m.ci[1])}]`.padEnd(26)} ±${pct(m.noiseFloor).padEnd(6)} ${m.samples}${flag}`,
    );
  }
  if (a.drift.samples) {
    lines.push(
      `similarity       ${a.drift.baselineSelfSimilarity.toFixed(2).padStart(8)}  ${a.drift.crossSimilarity.toFixed(2).padStart(9)}  drift ${a.drift.drift.toFixed(3)} [${a.drift.ci[0].toFixed(3)}, ${a.drift.ci[1].toFixed(3)}]${a.drift.changed ? " ✗" : ""}`,
    );
  }
  const p = a.perf;
  lines.push("");
  lines.push(`Latency (median): ${ms(p.baselineLatencyMs, "")} → ${ms(p.candidateLatencyMs, "")}`);
  if (p.baselineOutputTokens !== undefined || p.candidateOutputTokens !== undefined) lines.push(`Output tokens (median): ${p.baselineOutputTokens ?? "?"} → ${p.candidateOutputTokens ?? "?"}`);
  if (p.baselineCost !== undefined || p.candidateCost !== undefined) lines.push(`Cost per call (mean): $${p.baselineCost?.toFixed(5) ?? "?"} → $${p.candidateCost?.toFixed(5) ?? "?"}`);
  if (a.examples.length) {
    lines.push("");
    lines.push("Examples of changes:");
    for (const e of a.examples.slice(0, 4)) {
      lines.push(`  [${e.metric}] sample ${e.id}`);
      lines.push(`    baseline : ${e.baseline.replace(/\s+/g, " ").slice(0, 160)}`);
      lines.push(`    candidate: ${e.candidate.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  return lines.join("\n");
}

/** Compact markdown for PR comments and GitHub step summaries. */
export function runMarkdown(results: RunResult[]): string {
  const icon: Record<string, string> = { "likely-safe": "🟢", review: "🟡", unsafe: "🔴" };
  const lines: string[] = ["### modelshift migration check", ""];
  for (const r of results) {
    const a = r.analysis;
    lines.push(`**\`${r.meta.baseline}\` → \`${r.meta.candidate}\`**: ${icon[a.verdict]} ${VERDICT[a.verdict]} (confidence: ${a.confidence}; ${r.runs.length} samples × ${r.meta.repeats} repeats)`);
    lines.push("");
    for (const reason of a.reasons) lines.push(`- ${reason}`);
    lines.push("");
    const problems = [...(a.problems ?? [])].sort((x, y) => (x.severity === y.severity ? 0 : x.severity === "blocker" ? -1 : 1));
    if (problems.length) {
      lines.push(`> [!${problems.some((p) => p.severity === "blocker") ? "CAUTION" : "WARNING"}]`, `> **Problems during testing**`);
      for (const p of problems) lines.push(`> - ${p.severity === "blocker" ? "✖" : "⚠️"} **${p.title}.** ${p.detail}`, ...(p.items ?? []).map((i) => `>   - ${i}`));
      lines.push("");
    }
    lines.push("| Check | Baseline | Candidate | Change (95% CI) | Noise | |");
    lines.push("|---|---:|---:|---|---:|---|");
    for (const m of a.metrics) {
      const ci = m.mode === "paired" ? `${signed(m.delta)} [${pct(m.ci[0])}, ${pct(m.ci[1])}]` : "candidate only";
      lines.push(`| ${m.name} | ${pct(m.baseline)} | ${pct(m.candidate)} | ${ci} | ${Number.isFinite(m.noiseFloor) ? "±" + pct(m.noiseFloor) : "—"} | ${m.regression ? (m.severity === "review" ? "⚠️" : "❌") : "✅"} |`);
    }
    lines.push(`| latency (median) | ${ms(a.perf.baselineLatencyMs, "")} | ${ms(a.perf.candidateLatencyMs, "")} | | | |`);
    lines.push("");
  }
  lines.push("<sub>A check fails only when the 95% CI of the change is entirely on the worse side and larger than the baseline's own run-to-run variation. Never a guarantee.</sub>");
  return lines.join("\n");
}
