import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sample } from "../src/capture.js";
import type { ChatProvider, ChatRequest, ChatResponse } from "../src/providers/index.js";
import { analyze, pool, type RunResult, type SampleRun } from "../src/run/index.js";
import { judgeCallCount, judgeRuns, parseJudgeVerdict } from "../src/run/judge.js";
import { renderHtmlReport } from "../src/report/html.js";
import { runMarkdown } from "../src/run/summary.js";
import { handle } from "../src/mcp.js";
import { main } from "../src/cli.js";

const ok = (text: string, extra: Partial<ChatResponse> = {}): ChatResponse => ({ text, toolCalls: [], latencyMs: 100, ...extra });
const samples = (n: number): Sample[] => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, messages: [{ role: "user", content: `Summarise item ${i} <b>bold</b>` }] }));

/** A fake judge: says SAME when the new answer contains "good", DIFFERENT otherwise. */
const fakeJudge = (): ChatProvider & { calls: number } => {
  const j = {
    spec: "fake:judge",
    provider: "fake",
    model: "judge",
    calls: 0,
    async chat(req: ChatRequest) {
      j.calls++;
      const user = req.messages[1].content;
      const answer = user.slice(user.indexOf("<new>"));
      return ok(/good/.test(answer) ? "SAME" : "DIFFERENT");
    },
  };
  return j;
};

/* ---------------- judge */

test("parseJudgeVerdict reads the first verdict word", () => {
  assert.equal(parseJudgeVerdict("SAME"), 1);
  assert.equal(parseJudgeVerdict("different."), 0);
  assert.equal(parseJudgeVerdict("SAME — not DIFFERENT"), 1);
  assert.equal(parseJudgeVerdict("maybe"), undefined);
  assert.equal(judgeCallCount(10, 3), 10 * (2 + 3));
});

test("judge flags a candidate that the judge rejects more often than the baseline rejects itself", async () => {
  const ss = samples(24);
  const runs: SampleRun[] = ss.map((s) => ({ id: s.id, baseline: [ok("good a"), ok("good b"), ok("good c")], candidate: [ok("bad"), ok("bad"), ok("good")] }));
  const judge = fakeJudge();
  await judgeRuns(ss, runs, judge, { pool, concurrency: 8 });
  assert.equal(judge.calls, judgeCallCount(24, 3));
  const a = analyze(ss, runs);
  const m = a.metrics.find((x) => x.name === "judge")!;
  assert.equal(m.mode, "paired");
  assert.equal(m.baseline, 1);
  assert.ok(Math.abs(m.candidate - 1 / 3) < 1e-9);
  assert.equal(m.regression, true);
  assert.equal(a.verdict, "unsafe");
  assert.ok(a.examples.some((e) => e.metric === "judge"));
});

test("judge does not flag when the candidate agrees as often as the baseline agrees with itself", async () => {
  const ss = samples(24);
  // Baseline is itself inconsistent (1 of 2 repeats judged different), candidate the same.
  const runs: SampleRun[] = ss.map((s) => ({ id: s.id, baseline: [ok("good"), ok("good"), ok("meh")], candidate: [ok("good"), ok("good"), ok("meh")] }));
  await judgeRuns(ss, runs, fakeJudge(), { pool });
  const m = analyze(ss, runs).metrics.find((x) => x.name === "judge")!;
  assert.equal(m.regression, false);
});

test("judge without baseline repeats is candidate-only (no noise floor)", async () => {
  const ss = samples(5);
  const runs: SampleRun[] = ss.map((s) => ({ id: s.id, baseline: [ok("good")], candidate: [ok("bad")] }));
  await judgeRuns(ss, runs, fakeJudge(), { pool });
  const m = analyze(ss, runs).metrics.find((x) => x.name === "judge")!;
  assert.equal(m.mode, "candidate-only");
  assert.equal(m.regression, true);
});

/* ---------------- report */

function result(): RunResult {
  const ss = samples(3);
  ss[0].expect = { match: ["good"] };
  const runs: SampleRun[] = ss.map((s, i) => ({ id: s.id, baseline: [ok("good <script>x</script>", { servedModel: "y/other-model" }), ok("good")], candidate: [i === 0 ? ok("bad") : ok("good"), ok("good")] }));
  const analysis = analyze(ss, runs, { baselineSpec: "deepinfra:x/old", candidateSpec: "deepinfra:x/new" });
  return { meta: { baseline: "deepinfra:x/old", candidate: "deepinfra:x/new", repeats: 2, startedAt: "2026-11-24T00:00:00Z", toolVersion: "test" }, samples: ss, runs, analysis };
}

test("HTML report is self-contained, escaped and shows the verdict and redirects", () => {
  const html = renderHtmlReport([result()], { generatedAt: "now" });
  assert.match(html, /^<!doctype html>/);
  assert.ok(!html.includes("<script>x</script>"), "model output must be escaped");
  assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt;"));
  assert.ok(!/<script|<link|src="http/.test(html), "no scripts or external assets");
  assert.match(html, /Review before switching|Not safe to switch yet|Likely safe to switch/);
  assert.match(html, /served as: <code>y\/other-model<\/code>/);
  assert.match(html, /prefers-color-scheme:dark/);
  const multi = renderHtmlReport([result(), result()]);
  assert.match(multi, /Candidates compared/);
});

test("markdown summary has a row per check", () => {
  const md = runMarkdown([result()]);
  assert.match(md, /### modelshift migration check/);
  assert.match(md, /\| errors \|/);
  assert.match(md, /redirected/);
});

test("report command re-analyses a results file into HTML", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ms-report-"));
  const file = join(dir, "r.json");
  const r = result();
  r.analysis.reasons = ["stale analysis from an old version"];
  writeFileSync(file, JSON.stringify(r));
  const out = join(dir, "r.html");
  const code = await main(["report", file, "-o", out]);
  assert.equal(code, 0);
  const html = readFileSync(out, "utf8");
  assert.ok(!html.includes("stale analysis"));
  assert.match(html, /redirected/);
  assert.equal(await main(["report", join(dir, "missing.json")]), 1);
});

/* ---------------- MCP */

test("MCP server: initialize, list tools, spend guard, unknown method", async () => {
  const init = (await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })) as any;
  assert.equal(init.result.serverInfo.name, "modelshift");
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  const list = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as any;
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ["scan_models", "retirement_calendar", "capture_samples", "run_migration_test", "render_report"]);

  const dir = mkdtempSync(join(tmpdir(), "ms-mcp-"));
  const sfile = join(dir, "s.jsonl");
  writeFileSync(sfile, samples(30).map((s) => JSON.stringify(s)).join("\n"));
  process.env.DEEPINFRA_API_KEY ??= "test-key-not-used";
  const guarded = (await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_migration_test", arguments: { from: "deepinfra:a/b", to: ["deepinfra:c/d"], samples: sfile } } })) as any;
  assert.equal(guarded.result.isError, true);
  assert.match(guarded.result.content[0].text, /confirm_spend/);

  const unknown = (await handle({ jsonrpc: "2.0", id: 4, method: "nope" })) as any;
  assert.equal(unknown.error.code, -32601);
});
