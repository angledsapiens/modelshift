import { test } from "node:test";
import assert from "node:assert/strict";
import type { Sample } from "../src/capture.js";
import type { ChatResponse } from "../src/providers/index.js";
import { analyze, type SampleRun } from "../src/run/index.js";
import { bootstrapMeanTest, holmAdjust, mulberry32 } from "../src/run/stats.js";

test("holmAdjust matches the textbook procedure", () => {
  const adj = holmAdjust([0.01, 0.04, 0.03, 0.005]);
  // sorted: 0.005*4=0.02, 0.01*3=0.03, 0.03*2=0.06, 0.04*1=0.04 -> monotone 0.06
  assert.deepEqual(adj.map((x) => +x.toFixed(4)), [0.03, 0.06, 0.06, 0.02]);
  assert.deepEqual(holmAdjust([]), []);
});

test("bootstrapMeanTest p < 0.05 exactly when the 95% CI is on the worse side", () => {
  const rnd = mulberry32(7);
  for (let k = 0; k < 50; k++) {
    const shift = (rnd() - 0.5) * 0.6;
    const xs = Array.from({ length: 25 }, () => shift + (rnd() - 0.5));
    const { ci, p } = bootstrapMeanTest(xs, "negative");
    assert.equal(p < 0.05, ci[1] < 0, `shift ${shift}`);
  }
});

/* Simulated migrations: the candidate behaves exactly like the baseline (an "A/A" test). */
function simulate(seed: number, candidateFailBoost = 0): { samples: Sample[]; runs: SampleRun[] } {
  const rnd = mulberry32(seed);
  const samples: Sample[] = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, messages: [{ role: "user", content: `q${i}` }], json: true, expect: { match: ["ok"] } }));
  const pJson = samples.map(() => 0.6 + rnd() * 0.4); // per-sample difficulty
  const pOk = samples.map(() => 0.5 + rnd() * 0.5);
  const answer = (i: number, boost: number): ChatResponse => {
    const valid = rnd() < pJson[i] - boost;
    const ok = rnd() < pOk[i] - boost;
    const refuse = rnd() < 0.03 + boost / 2;
    const text = refuse ? "I can't help with that." : valid ? JSON.stringify({ answer: ok ? "ok" : "no" }) : ok ? "ok, not json" : "nope";
    return { text, toolCalls: [], latencyMs: 100 + rnd() * 50 };
  };
  const runs: SampleRun[] = samples.map((s, i) => ({
    id: s.id,
    baseline: [answer(i, 0), answer(i, 0), answer(i, 0)],
    candidate: [answer(i, candidateFailBoost), answer(i, candidateFailBoost), answer(i, candidateFailBoost)],
  }));
  return { samples, runs };
}

test("A/A: a candidate identical to the baseline is rarely called unsafe (family-wise false alarms <= ~5%)", () => {
  const trials = 200;
  let unsafe = 0;
  for (let t = 0; t < trials; t++) {
    const { samples, runs } = simulate(1000 + t);
    if (analyze(samples, runs).verdict === "unsafe") unsafe++;
  }
  assert.ok(unsafe / trials <= 0.06, `false alarm rate ${unsafe}/${trials}`);
});

test("a real 30-point drop in JSON validity and assertions is still caught after correction", () => {
  let caught = 0;
  for (let t = 0; t < 20; t++) {
    const { samples, runs } = simulate(5000 + t, 0.3);
    if (analyze(samples, runs).verdict === "unsafe") caught++;
  }
  assert.ok(caught >= 18, `caught ${caught}/20`);
});

/* ---------------- response cache */

import { mkdtempSync, existsSync as exists, readFileSync as read } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRun, uncachedCalls } from "../src/run/index.js";
import { ResponseCache } from "../src/run/cache.js";
import type { ChatProvider } from "../src/providers/index.js";

test("response cache: re-runs and extra candidates don't call the models again; errors are retried", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "ms-cache-")), "cache");
  let calls = 0;
  let failNext = 1;
  const fake = (spec: string): ChatProvider => ({
    spec,
    provider: "fake",
    model: spec,
    async chat(req) {
      calls++;
      if (failNext-- > 0) return { text: "", toolCalls: [], latencyMs: 1, error: "HTTP 500: boom" };
      return { text: `${spec} says ${req.messages[0].content} #${calls}`, toolCalls: [], latencyMs: 5 };
    },
  });
  const samples: Sample[] = [0, 1].map((i) => ({ id: `s${i}`, messages: [{ role: "user", content: `q${i}` }] }));
  const cache = new ResponseCache(dir);
  assert.equal(uncachedCalls(samples, ["a:1", "b:2"], 2, cache), 8);

  const first = await executeRun(samples, fake("a:1"), fake("b:2"), { repeats: 2, cache, concurrency: 1 });
  assert.equal(calls, 8);
  assert.ok(exists(join(dir, ".gitignore")) && read(join(dir, ".gitignore"), "utf8").includes("*"));
  assert.equal(uncachedCalls(samples, ["a:1", "b:2"], 2, cache), 1, "the failed call is not cached");

  // Same baseline, a new candidate: only the candidate and the one failed baseline slot are called.
  const second = await executeRun(samples, fake("a:1"), fake("c:3"), { repeats: 2, cache: new ResponseCache(dir), concurrency: 1 });
  assert.equal(calls, 8 + 1 + 4);
  // Repeats keep their slot, so the cached baseline answers line up between runs.
  assert.deepEqual(second.runs[1].baseline.map((r) => r.text), first.runs[1].baseline.map((r) => r.text));
  assert.equal(new Set(second.runs[1].baseline.map((r) => r.text)).size, 2, "repeats are separate answers, not one cached copy");
});

/* ---------------- semantic similarity */

import { embedRuns, cosine } from "../src/run/semantic.js";
import { createEmbedder, type Embedder, type FetchFn } from "../src/providers/index.js";
import { pool } from "../src/run/index.js";

test("cosine similarity", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosine([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-12);
});

test("semantic check: a candidate whose answers mean something else is flagged for review (not unsafe)", async () => {
  // Toy embedder: answers about cats point one way, about dogs the other, with a little noise.
  let calls = 0;
  const toy: Embedder = {
    spec: "toy:embed",
    async embed(texts) {
      calls++;
      return { vectors: texts.map((t) => { const n = (t.length % 7) / 100; return t.includes("cat") ? [1, n, 0] : [0, n, 1]; }) };
    },
  };
  const ok = (text: string): ChatResponse => ({ text, toolCalls: [], latencyMs: 1 });
  const samples: Sample[] = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, messages: [{ role: "user", content: `q${i}` }] }));
  const runs: SampleRun[] = samples.map((s, i) => ({
    id: s.id,
    baseline: [ok(`a cat ${i}`), ok(`the cat ${i}!`), ok(`cat ${i}`)],
    candidate: [ok(`a dog ${i}`), ok(`a cat ${i}?`), ok(`dog ${i}`)],
  }));
  const dir = join(mkdtempSync(join(tmpdir(), "ms-embed-")), "cache");
  await embedRuns(runs, toy, { pool, cache: new ResponseCache(dir) });
  const a = analyze(samples, runs);
  const m = a.metrics.find((x) => x.name === "semantic")!;
  assert.equal(m.severity, "review");
  assert.ok(m.candidate < m.baseline);
  assert.equal(m.regression, true);
  assert.equal(a.verdict, "review");
  // Embeddings are cached: a second pass makes no calls.
  const before = calls;
  await embedRuns(runs, toy, { pool, cache: new ResponseCache(dir) });
  assert.equal(calls, before);

  // Same meaning: not flagged.
  const same: SampleRun[] = samples.map((s, i) => ({ id: s.id, baseline: runs[i].baseline, candidate: [ok(`cat ${i}.`), ok(`a cat, ${i}`), ok(`cats ${i}`)] }));
  await embedRuns(same, toy, { pool });
  assert.equal(analyze(samples, same).metrics.find((x) => x.name === "semantic")!.regression, false);
});

test("OpenAI-compatible embedder sends one batch and keeps input order", async () => {
  let body: any;
  const fn: FetchFn = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }) };
  };
  const e = createEmbedder("deepinfra:BAAI/bge-m3", { env: { DEEPINFRA_API_KEY: "k" }, fetchFn: fn });
  const r = await e.embed(["first", ""]);
  assert.deepEqual(body, { model: "BAAI/bge-m3", input: ["first", " "] });
  assert.deepEqual(r.vectors, [[1, 0], [0, 1]]);
  assert.throws(() => createEmbedder("anthropic:x", { env: {} }), /no embeddings API/);
});
