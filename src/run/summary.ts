import type { RunResult } from "./index.js";

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a");
const signed = (x: number) => (x >= 0 ? "+" : "") + pct(x);

const VERDICT: Record<string, string> = {
  "likely-safe": "LIKELY SAFE TO SWITCH",
  review: "REVIEW BEFORE SWITCHING",
  unsafe: "NOT SAFE TO SWITCH YET",
};

export function runSummaryText(r: RunResult): string {
  const a = r.analysis;
  const lines: string[] = [];
  lines.push("");
  lines.push(`${r.meta.baseline}  →  ${r.meta.candidate}   (${r.runs.length} samples × ${r.meta.repeats} repeats)`);
  lines.push(`Verdict: ${VERDICT[a.verdict]}  (confidence: ${a.confidence}${a.confidence === "low" ? " — add more samples" : ""}; never a guarantee)`);
  for (const reason of a.reasons) lines.push(`  - ${reason}`);
  lines.push("");
  lines.push("Check            baseline  candidate  change (95% CI)           noise   n");
  for (const m of a.metrics) {
    const flag = m.regression ? " ✗" : "";
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
  lines.push(`Latency (median): ${Math.round(p.baselineLatencyMs)}ms → ${Math.round(p.candidateLatencyMs)}ms`);
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
