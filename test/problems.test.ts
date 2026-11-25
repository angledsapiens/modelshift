import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, type RunResult, type SampleRun } from "../src/run/index.js";
import { commonErrors } from "../src/run/problems.js";
import { runMarkdown, runSummaryText } from "../src/run/summary.js";
import { renderHtmlReport } from "../src/report/html.js";
import type { ChatResponse } from "../src/providers/index.js";
import type { Sample } from "../src/capture.js";

const ok = (text: string, extra: Partial<ChatResponse> = {}): ChatResponse => ({ text, toolCalls: [], latencyMs: 100, ...extra });
const err = (error: string): ChatResponse => ({ text: "", toolCalls: [], latencyMs: 50, error });
const samples = (n: number): Sample[] => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, messages: [{ role: "user" as const, content: `extract ${i}` }], json: true }));

function result(runs: SampleRun[], meta: Partial<RunResult["meta"]> = {}): RunResult {
  const s = samples(runs.length);
  const m = { baseline: "openai:a", candidate: "bedrock:b", repeats: 2, startedAt: "t", toolVersion: "x", ...meta };
  return { meta: m, samples: s, runs, analysis: analyze(s, runs, { baselineSpec: m.baseline, candidateSpec: m.candidate, judge: m.judge, embed: m.embed, repeats: m.repeats }) };
}

test("a clean run reports no problems", () => {
  const r = result(samples(20).map((s) => ({ id: s.id, baseline: [ok('{"a":1}'), ok('{"a":1}')], candidate: [ok('{"a":1}'), ok('{"a":1}')] })));
  assert.deepEqual(r.analysis.problems, []);
  assert.equal(r.analysis.verdict, "likely-safe");
  assert.doesNotMatch(runSummaryText(r), /Problems during testing/);
});

test("a candidate that never answered blocks the verdict, with the cause and a fix", () => {
  const r = result(samples(20).map((s) => ({ id: s.id, baseline: [ok('{"a":1}'), ok('{"a":1}')], candidate: [err("HTTP 403: AccessDeniedException: not authorized"), err("HTTP 403: AccessDeniedException: not authorized")] })));
  const p = r.analysis.problems.find((x) => x.title === "40 of 40 candidate calls failed")!;
  assert.equal(p.severity, "blocker");
  assert.match(p.detail, /bedrock:b.*AccessDeniedException.*×40.*never answered.*credentials/);
  assert.notEqual(r.analysis.verdict, "likely-safe");
  assert.equal(r.analysis.confidence, "low");
  assert.match(r.analysis.reasons[0], /^Testing was incomplete \(40 of 40 candidate calls failed\)/);
});

test("rate limits on a few calls are a warning with a retry hint; partial gaps are listed by sample", () => {
  const runs: SampleRun[] = samples(20).map((s, i) => ({
    id: s.id,
    baseline: i === 3 ? [err("HTTP 500: overloaded"), err("HTTP 500: overloaded")] : [ok('{"a":1}'), ok('{"a":1}')],
    candidate: [ok('{"a":1}'), i < 2 ? err("HTTP 429: Too many requests (after 4 attempts)") : ok('{"a":1}')],
  }));
  const r = result(runs);
  const cand = r.analysis.problems.find((x) => x.title.includes("candidate calls failed"))!;
  assert.equal(cand.severity, "warning");
  assert.match(cand.detail, /rate-limited.*--concurrency/);
  assert.ok(r.analysis.problems.some((x) => x.title === "1 sample had no baseline answer" && /s3/.test(x.detail)));
  assert.ok(r.analysis.problems.every((x) => x.severity === "warning"));
});

test("cut-off answers, failed judge calls and failed embeddings are reported", () => {
  const runs: SampleRun[] = samples(20).map((s) => ({
    id: s.id,
    baseline: [ok('{"a":1}'), ok('{"a":1}')],
    candidate: [ok('{"a":', { finishReason: "length" }), ok('{"a":1}')],
    judge: { baseline: [null], candidate: [null, null], reference: "baseline", judge: "openai:j" },
    semantic: { self: null, cross: null, model: "bedrock:e" },
  }));
  const r = result(runs, { judge: "openai:j", embed: "bedrock:e" });
  const titles = r.analysis.problems.map((p) => `${p.severity}: ${p.title}`);
  assert.ok(titles.includes("warning: 20 candidate answers were cut off by the token limit"));
  assert.ok(titles.includes("blocker: The judge check didn't run"));
  assert.ok(titles.includes("blocker: The meaning check didn't run"));
  assert.notEqual(r.analysis.verdict, "likely-safe");
});

test("problems appear in the terminal summary, markdown and HTML report", () => {
  const r = result(samples(20).map((s) => ({ id: s.id, baseline: [ok('{"a":1}'), ok('{"a":1}')], candidate: [err("HTTP 404: model not found"), err("HTTP 404: model not found")] })));
  const text = runSummaryText(r);
  assert.match(text, /Problems during testing \(1, 1 stopped part of the test\):\n  ✖ 40 of 40 candidate calls failed/);
  assert.match(text, /retired/);
  const md = runMarkdown([r]);
  assert.match(md, /> \[!CAUTION\]\n> \*\*Problems during testing\*\*\n> - ✖ \*\*40 of 40 candidate calls failed\.\*\*/);
  const html = renderHtmlReport([r, r]);
  assert.match(html, /class="problems bad" role="alert"/);
  assert.match(html, /Problems during testing \(1\) · 1 stopped part of the test/);
  assert.match(html, /pill bad">Incomplete</);
});

test("commonErrors groups repeated messages", () => {
  assert.equal(commonErrors([err("a"), err("a"), err("b"), err("c"), ok("x")]), `"a" (×2); "b"; and 1 other error`);
});

test("scan: providers the live check couldn't read are listed as gaps, in text and markdown", async () => {
  const { liveGaps, toMarkdown, toText } = await import("../src/format.js");
  const list = [{ id: "m1", family: "bedrock" as const, status: "unlisted" as const, locations: [{ file: "a.py", line: 1, rawId: "m1" }], hosts: [], note: "x (probe failed: HTTP 500)" }];
  const results = [
    { provider: "bedrock" as const, ok: false, error: "HTTP 403" },
    { provider: "together" as const, ok: false, skipped: "set TOGETHER_API_KEY to check live" },
  ];
  const gaps = liveGaps(list, results);
  assert.deepEqual(gaps.map((g) => g.severity), ["error", "skipped", "error"]);
  assert.match(gaps[0].text, /bedrock: couldn't read its model list \(HTTP 403\)/);
  assert.match(gaps[2].text, /1 probe didn't run \(m1\)/);
  assert.match(toText(list, results, { root: ".", calendarUpdated: "d", live: true }), /Live check incomplete \(3\)/);
  assert.match(toMarkdown(list, { calendarUpdated: "d" }, results), /> \[!CAUTION\]\n> \*\*Live check incomplete\*\*/);
});
