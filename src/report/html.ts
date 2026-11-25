import type { MetricResult, RunResult } from "../run/index.js";
import type { Problem } from "../run/problems.js";
import { assertionsPass, outputRepr } from "../run/checks.js";
import type { ChatResponse } from "../providers/index.js";

/**
 * A single self-contained HTML file (no scripts, no external assets) that a team can
 * open, attach to a ticket, or upload as a CI artifact. Light and dark themes.
 */

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "—");
const ms = (x: number, sep = "") => (Number.isFinite(x) ? `${Math.round(x)}${sep}ms` : "—");
const signed = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + pct(x) : "—");

const VERDICT: Record<string, { label: string; cls: string; blurb: string }> = {
  "likely-safe": { label: "Likely safe to switch", cls: "ok", blurb: "No check got worse beyond the old model's own run-to-run variation." },
  review: { label: "Review before switching", cls: "warn", blurb: "Nothing failed outright, but something needs a human look." },
  unsafe: { label: "Not safe to switch yet", cls: "bad", blurb: "At least one check got worse by more than the old model's own variation." },
};

const METRIC_LABEL: Record<string, string> = {
  errors: "Call errors",
  "json-valid": "Valid JSON",
  "json-shape": "Same JSON keys",
  "tool-calls": "Same tool calls",
  refusals: "Refusals",
  assertions: "Your expected outputs",
  judge: "LLM judge: equivalent answer",
};

/** Inline SVG: the 95% CI of the change, the noise band around zero, and which side is worse. */
function ciBar(m: MetricResult): string {
  if (m.mode !== "paired") return `<span class="muted">no baseline</span>`;
  const W = 180;
  const H = 22;
  const span = Math.max(0.1, Math.abs(m.ci[0]), Math.abs(m.ci[1]), m.noiseFloor) * 1.15;
  const x = (v: number) => W / 2 + (v / span) * (W / 2 - 6);
  const worseLeft = m.direction === "higher-is-better";
  const cls = m.regression ? "bad" : "neutral";
  return `<svg class="ci" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Change ${signed(m.delta)}, 95% CI ${signed(m.ci[0])} to ${signed(m.ci[1])}, noise ±${pct(m.noiseFloor)}">
  <rect class="worse" x="${worseLeft ? 0 : W / 2}" y="0" width="${W / 2}" height="${H}"/>
  <rect class="noise" x="${x(-m.noiseFloor)}" y="3" width="${Math.max(1, x(m.noiseFloor) - x(-m.noiseFloor))}" height="${H - 6}"/>
  <line class="zero" x1="${W / 2}" x2="${W / 2}" y1="0" y2="${H}"/>
  <line class="ci-${cls}" x1="${x(m.ci[0])}" x2="${x(m.ci[1])}" y1="${H / 2}" y2="${H / 2}"/>
  <circle class="ci-${cls}" cx="${x(m.delta)}" cy="${H / 2}" r="3.5"/>
</svg>`;
}

function metricRows(r: RunResult): string {
  return r.analysis.metrics
    .map((m) => {
      const status = m.regression ? (m.mode !== "paired" ? `<span class="pill warn">below 90%</span>` : m.severity === "review" ? `<span class="pill warn">review</span>` : `<span class="pill bad">worse</span>`) : `<span class="pill ok">ok</span>`;
      return `<tr>
  <td><strong>${esc(METRIC_LABEL[m.name] ?? m.name)}</strong><div class="muted small">${esc(m.description)}</div></td>
  <td class="num">${pct(m.baseline)}</td>
  <td class="num">${pct(m.candidate)}</td>
  <td class="num">${signed(m.delta)}<div class="muted small">${m.mode === "paired" ? `${signed(m.ci[0])} to ${signed(m.ci[1])}` : "candidate only"}</div></td>
  <td>${ciBar(m)}</td>
  <td class="num">${Number.isFinite(m.noiseFloor) ? "±" + pct(m.noiseFloor) : "—"}</td>
  <td class="num">${m.samples}</td>
  <td>${status}</td>
</tr>`;
    })
    .join("\n");
}

function lastUser(r: RunResult, id: string): string {
  const s = r.samples.find((x) => x.id === id);
  const u = [...(s?.messages ?? [])].reverse().find((m) => m.role === "user");
  return u?.content ?? "";
}

function out(res?: ChatResponse): string {
  if (!res) return "";
  return res.error ? `[error] ${res.error}` : outputRepr(res);
}

const MAX_SAMPLE_ROWS = 300;

function sampleRows(r: RunResult): string {
  const byId = new Map(r.samples.map((s) => [s.id, s]));
  return r.runs
    .slice(0, MAX_SAMPLE_ROWS)
    .map((run) => {
      const sample = byId.get(run.id);
      const b = run.baseline[0];
      const c = run.candidate[0];
      const marks: string[] = [];
      const rate = (rs: ChatResponse[]) => {
        const v = rs.map((x) => (x.error ? undefined : assertionsPass(outputRepr(x), sample?.expect))).filter((x): x is boolean => x !== undefined);
        return v.length ? v.filter(Boolean).length / v.length : undefined;
      };
      const ba = rate(run.baseline);
      const ca = rate(run.candidate);
      if (ca !== undefined) marks.push(`<span class="pill ${ca === 1 ? "ok" : ca === 0 ? "bad" : "warn"}">expected ${Math.round(ca * 100)}%${ba !== undefined ? ` (was ${Math.round(ba * 100)}%)` : ""}</span>`);
      const cErr = run.candidate.filter((x) => x.error).length;
      if (cErr) marks.push(`<span class="pill bad">${cErr} error${cErr > 1 ? "s" : ""}</span>`);
      const jc = run.judge?.candidate.filter((v): v is number => v !== null);
      if (jc?.length) {
        const share = jc.filter((v) => v === 1).length / jc.length;
        marks.push(`<span class="pill ${share === 1 ? "ok" : share === 0 ? "bad" : "warn"}">judge: same ${Math.round(share * 100)}%</span>`);
      }
      const changed = (ca !== undefined && ba !== undefined && ca < ba) || cErr > 0 || (jc?.length ? jc.includes(0) : false);
      return `<details class="sample${changed ? " changed" : ""}"${changed ? " open" : ""}>
  <summary><code>${esc(run.id)}</code> ${marks.join(" ")}<span class="muted small preview">${esc(lastUser(r, run.id).slice(0, 110))}</span></summary>
  <div class="io">
    <div><h4>Input</h4><pre>${esc(lastUser(r, run.id).slice(0, 2000))}</pre></div>
    <div><h4>Baseline <span class="muted small">${esc(r.meta.baseline)}</span></h4><pre>${esc(out(b).slice(0, 3000))}</pre></div>
    <div><h4>Candidate <span class="muted small">${esc(r.meta.candidate)}</span></h4><pre>${esc(out(c).slice(0, 3000))}</pre></div>
  </div>
</details>`;
    })
    .join("\n");
}

function servedNote(r: RunResult): string {
  const notes: string[] = [];
  for (const [label, spec, rs] of [["Baseline", r.meta.baseline, r.runs.flatMap((x) => x.baseline)], ["Candidate", r.meta.candidate, r.runs.flatMap((x) => x.candidate)]] as const) {
    const served = new Set(rs.filter((x) => !x.error && x.servedModel).map((x) => x.servedModel!));
    if (served.size) notes.push(`${label} served as: <code>${[...served].map(esc).join("</code>, <code>")}</code> <span class="muted">(requested <code>${esc(spec)}</code>)</span>`);
  }
  return notes.length ? `<p class="small">${notes.join("<br>")}</p>` : "";
}

function problemsBox(problems: Problem[]): string {
  if (!problems.length) return "";
  const sorted = [...problems].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "blocker" ? -1 : 1));
  const blockers = problems.filter((p) => p.severity === "blocker").length;
  return `<div class="problems ${blockers ? "bad" : "warn"}" role="alert">
    <div class="p-title">Problems during testing (${problems.length})${blockers ? ` · ${blockers} stopped part of the test, so the verdict can't be "safe"` : ""}</div>
    <ul>${sorted.map((p) => `<li><span class="pill ${p.severity === "blocker" ? "bad" : "warn"}">${p.severity === "blocker" ? "Blocked" : "Warning"}</span> <strong>${esc(p.title)}.</strong> ${esc(p.detail)}${p.items?.length ? `<ul class="items">${p.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}</li>`).join("")}</ul>
  </div>`;
}

function section(r: RunResult, idx: number, multi: boolean): string {
  const a = r.analysis;
  const v = VERDICT[a.verdict];
  const p = a.perf;
  const perfRows = [
    ["Median latency", `${ms(p.baselineLatencyMs, " ")}`, `${ms(p.candidateLatencyMs, " ")}`],
    ...(p.baselineOutputTokens !== undefined || p.candidateOutputTokens !== undefined ? [["Median output tokens", String(p.baselineOutputTokens ?? "—"), String(p.candidateOutputTokens ?? "—")]] : []),
    ...(p.baselineCost !== undefined || p.candidateCost !== undefined ? [["Mean cost per call", p.baselineCost !== undefined ? `$${p.baselineCost.toFixed(5)}` : "—", p.candidateCost !== undefined ? `$${p.candidateCost.toFixed(5)}` : "—"]] : []),
    ...(a.drift.samples ? [["Answer similarity (word overlap)", `${a.drift.baselineSelfSimilarity.toFixed(2)} vs itself`, `${a.drift.crossSimilarity.toFixed(2)} vs baseline${a.drift.changed ? " ⚠" : ""}`]] : []),
  ];
  const examples = a.examples.length
    ? `<h3>Examples of what changed</h3>${a.examples
        .map(
          (e) => `<div class="example"><div class="muted small">${esc(METRIC_LABEL[e.metric] ?? e.metric)} · sample <code>${esc(e.id)}</code></div>
<div class="pair"><div><h4>Baseline</h4><pre>${esc(e.baseline)}</pre></div><div><h4>Candidate</h4><pre>${esc(e.candidate)}</pre></div></div></div>`,
        )
        .join("\n")}`
    : "";
  return `<section id="c${idx}">
  ${multi ? `<h2>${esc(r.meta.candidate)}</h2>` : ""}
  <div class="verdict ${v.cls}">
    <div class="v-label">${esc(v.label)}</div>
    <div class="v-meta">Confidence: <strong>${esc(a.confidence)}</strong>${a.confidence === "low" ? " (add more samples)" : ""} · ${r.runs.length} samples × ${r.meta.repeats} repeats · never a guarantee</div>
    <div class="v-blurb">${esc(v.blurb)}</div>
  </div>
  <ul class="reasons">${a.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
  ${problemsBox(a.problems ?? [])}
  ${servedNote(r)}
  <h3>Checks</h3>
  <div class="scroll"><table>
    <thead><tr><th>Check</th><th class="num">Baseline</th><th class="num">Candidate</th><th class="num">Change (95% CI)</th><th>Change vs noise <span class="muted small">shaded = worse side</span></th><th class="num">Noise</th><th class="num">n</th><th></th></tr></thead>
    <tbody>${metricRows(r)}</tbody>
  </table></div>
  <h3>Performance</h3>
  <div class="scroll"><table class="perf"><thead><tr><th></th><th>Baseline</th><th>Candidate</th></tr></thead>
  <tbody>${perfRows.map(([k, b, c]) => `<tr><td>${esc(k)}</td><td>${esc(b)}</td><td>${esc(c)}</td></tr>`).join("")}</tbody></table></div>
  ${examples}
  <h3>Every sample <span class="muted small">(changed ones are open; first answer of each model shown)</span></h3>
  ${sampleRows(r)}
  ${r.runs.length > MAX_SAMPLE_ROWS ? `<p class="muted">Showing the first ${MAX_SAMPLE_ROWS} of ${r.runs.length} samples. The results JSON has them all.</p>` : ""}
</section>`;
}

function comparison(results: RunResult[]): string {
  const names = [...new Set(results.flatMap((r) => r.analysis.metrics.map((m) => m.name)))];
  return `<h2>Candidates compared</h2><div class="scroll"><table>
<thead><tr><th>Candidate</th><th>Verdict</th>${names.map((n) => `<th class="num">${esc(METRIC_LABEL[n] ?? n)}</th>`).join("")}<th class="num">Latency</th></tr></thead>
<tbody>${results
    .map((r, i) => {
      const v = VERDICT[r.analysis.verdict];
      const blocked = (r.analysis.problems ?? []).some((p) => p.severity === "blocker");
      return `<tr><td><a href="#c${i}"><code>${esc(r.meta.candidate)}</code></a></td><td><span class="pill ${v.cls}">${esc(v.label)}</span>${blocked ? ` <span class="pill bad">Incomplete</span>` : ""}</td>${names
        .map((n) => {
          const m = r.analysis.metrics.find((x) => x.name === n);
          return `<td class="num${m?.regression ? " bad-text" : ""}">${m ? pct(m.candidate) : "—"}</td>`;
        })
        .join("")}<td class="num">${ms(r.analysis.perf.candidateLatencyMs, " ")}</td></tr>`;
    })
    .join("")}</tbody></table></div>`;
}

const CSS = `
:root{--bg:#fbfaf8;--card:#fff;--fg:#1d1c1a;--muted:#6b6862;--line:#e6e2db;--ok:#1f7a4d;--ok-bg:#e5f3eb;--warn:#8a5a00;--warn-bg:#fbf0d9;--bad:#b42318;--bad-bg:#fbe7e4;--accent:#3d5afe;--code:#f3f1ec;--worse:rgba(180,35,24,.07);--noise:rgba(107,104,98,.22)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151413;--card:#1e1d1b;--fg:#ecebe8;--muted:#a19d96;--line:#34322e;--ok:#5fd39a;--ok-bg:#16301f;--warn:#f0c060;--warn-bg:#352a10;--bad:#ff8a7a;--bad-bg:#3a1713;--accent:#8c9eff;--code:#262421;--worse:rgba(255,138,122,.09);--noise:rgba(161,157,150,.28)}}
:root[data-theme="dark"]{--bg:#151413;--card:#1e1d1b;--fg:#ecebe8;--muted:#a19d96;--line:#34322e;--ok:#5fd39a;--ok-bg:#16301f;--warn:#f0c060;--warn-bg:#352a10;--bad:#ff8a7a;--bad-bg:#3a1713;--accent:#8c9eff;--code:#262421;--worse:rgba(255,138,122,.09);--noise:rgba(161,157,150,.28)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 16px 64px}
header h1{font-size:26px;margin:0 0 4px;letter-spacing:-.01em}
.models{font-size:17px;margin:6px 0 2px}.models code{font-size:15px}
h2{font-size:20px;margin:40px 0 12px;padding-top:12px;border-top:1px solid var(--line)}
h3{font-size:16px;margin:28px 0 10px}
h4{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:0 0 6px;font-weight:600}
code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em;background:var(--code);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
.muted{color:var(--muted)}.small{font-size:12.5px}
.verdict{border-radius:12px;padding:18px 20px;margin:20px 0 12px;border:1px solid var(--line)}
.verdict.ok{background:var(--ok-bg);border-color:var(--ok)}.verdict.warn{background:var(--warn-bg);border-color:var(--warn)}.verdict.bad{background:var(--bad-bg);border-color:var(--bad)}
.v-label{font-size:22px;font-weight:700}.verdict.ok .v-label{color:var(--ok)}.verdict.warn .v-label{color:var(--warn)}.verdict.bad .v-label{color:var(--bad)}
.v-meta{margin-top:4px;font-size:13.5px}.v-blurb{margin-top:6px;font-size:13.5px;color:var(--muted)}
.reasons{padding-left:20px;margin:8px 0}.reasons li{margin:4px 0}
.problems{border-radius:10px;padding:12px 16px;margin:12px 0;border:1px solid}.problems.bad{background:var(--bad-bg);border-color:var(--bad)}.problems.warn{background:var(--warn-bg);border-color:var(--warn)}
.problems ul.items{margin:6px 0 2px;padding-left:20px}.problems ul.items li{margin:3px 0}
.p-title{font-weight:700}.problems.bad .p-title{color:var(--bad)}.problems.warn .p-title{color:var(--warn)}
.problems ul{padding-left:18px;margin:8px 0 0}.problems li{margin:6px 0}
.scroll{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
th{font-size:12px;font-weight:600;color:var(--muted);white-space:nowrap}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;white-space:nowrap}
.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.warn{background:var(--warn-bg);color:var(--warn)}.pill.bad{background:var(--bad-bg);color:var(--bad)}
.bad-text{color:var(--bad);font-weight:600}
svg.ci .worse{fill:var(--worse)}svg.ci .noise{fill:var(--noise)}svg.ci .zero{stroke:var(--muted);stroke-width:1}
svg.ci line.ci-neutral{stroke:var(--fg);stroke-width:2}svg.ci circle.ci-neutral{fill:var(--fg)}
svg.ci line.ci-bad{stroke:var(--bad);stroke-width:2.5}svg.ci circle.ci-bad{fill:var(--bad)}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--code);padding:10px;border-radius:8px;max-height:320px;overflow:auto}
.example{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin:10px 0}
.pair,.io{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px}.io{grid-template-columns:1fr 1fr 1fr}
details.sample{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:6px 0;padding:8px 12px}
details.sample.changed{border-left:3px solid var(--warn)}
details.sample summary{cursor:pointer;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.preview{flex:1 1 200px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.io{padding:10px 0 4px}
footer{margin-top:48px;font-size:12.5px;color:var(--muted)}
a{color:var(--accent)}
@media (max-width:720px){.pair,.io{grid-template-columns:1fr}main{padding:20px 16px 48px}}
`;

export function renderHtmlReport(results: RunResult[], opts: { generatedAt?: string } = {}): string {
  if (!results.length) throw new Error("No results to report.");
  const multi = results.length > 1;
  const first = results[0];
  const title = multi ? `${first.meta.baseline} → ${results.length} candidates` : `${first.meta.baseline} → ${first.meta.candidate}`;
  const when = opts.generatedAt ?? new Date().toISOString();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Model migration report</title>
<meta name="description" content="${esc(title)}">
<style>${CSS}</style>
</head>
<body>
<main>
<header>
  <div class="muted small">modelshift migration report</div>
  <h1>Model migration report</h1>
  <div class="models"><code>${esc(first.meta.baseline)}</code> → ${results.map((r) => `<code>${esc(r.meta.candidate)}</code>`).join(", ")}</div>
  <div class="muted small">Run ${esc(first.meta.startedAt)} · report ${esc(when)} · modelshift ${esc(first.meta.toolVersion)}${first.meta.judge ? ` · judge <code>${esc(first.meta.judge)}</code>` : ""}</div>
</header>
${multi ? comparison(results) : ""}
${results.map((r, i) => section(r, i, multi)).join("\n")}
<footer>
  <p><strong>How to read this.</strong> Each sample was sent to the baseline ${first.meta.repeats} time(s); how much the baseline disagrees with itself is the <em>noise</em>.
  A check is marked <em>worse</em> only when the 95% confidence interval of the change lies entirely on the worse side <em>and</em> the change is larger than that noise.
  "Likely safe" is a statistical statement about these samples, never a guarantee. Outputs may contain data from your samples: review before sharing outside your team.</p>
  <p>Generated by <a href="https://github.com/angledsapiens/modelshift">modelshift</a>.</p>
</footer>
</main>
</body>
</html>
`;
}
