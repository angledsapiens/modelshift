import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapMeanCI, meanPairwiseAbsDiff } from "../src/run/stats.js";
import { extractJson, isRefusal, similarity, topLevelKeys } from "../src/run/checks.js";
import { captureFromText, redact, sampleEvenly, toSample, type Sample } from "../src/capture.js";
import { createProvider, parseSpec, retryPolicy, type ChatProvider, type ChatResponse, type FetchFn } from "../src/providers/index.js";
import { analyze, executeRun, redirectedTo, type SampleRun } from "../src/run/index.js";
import { main } from "../src/cli.js";

/* ---------------- stats & checks */

test("bootstrap CI and pairwise noise", () => {
  assert.deepEqual(bootstrapMeanCI([0.5, 0.5, 0.5]), [0.5, 0.5]);
  const [lo, hi] = bootstrapMeanCI([0, 1, 0, 1, 0, 1, 0, 1]);
  assert.ok(lo < 0.5 && hi > 0.5);
  assert.equal(meanPairwiseAbsDiff([1, 1, 1]), 0);
  assert.equal(meanPairwiseAbsDiff([1, 0]), 1);
});

test("json, refusal and similarity checks", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(extractJson("not json"), undefined);
  assert.equal(topLevelKeys('{"b":1,"a":2}'), "a,b");
  assert.ok(isRefusal("I'm sorry, but I can't help with that."));
  assert.ok(!isRefusal("Here is the summary you asked for."));
  assert.equal(similarity("the cat sat", "the cat sat"), 1);
  assert.ok(similarity("the cat sat", "a dog ran") < 0.2);
});

/* ---------------- capture */

test("capture accepts OpenAI logs, Langfuse-style and prompt records", () => {
  const lines = [
    JSON.stringify({ request: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], response_format: { type: "json_object" }, temperature: 0 }, response: { choices: [{ message: { content: '{"ok":true}' } }] } }),
    JSON.stringify({ input: [{ role: "user", content: [{ type: "text", text: "multi" }, { type: "text", text: "part" }] }], output: "done" }),
    JSON.stringify({ prompt: "Summarise", system: "Be brief" }),
    "not json",
    JSON.stringify({ nothing: true }),
  ].join("\n");
  const { samples, skipped } = captureFromText(lines, { redact: false });
  assert.equal(samples.length, 3);
  assert.equal(skipped, 2);
  assert.equal(samples[0].json, true);
  assert.equal(samples[0].temperature, 0);
  assert.equal(samples[0].reference, '{"ok":true}');
  assert.equal(samples[1].messages[0].content, "multipart");
  assert.equal(samples[2].messages[0].role, "system");
});

test("redaction removes common PII and secrets", () => {
  const t = redact("mail jane.doe@example.com key sk-abcdefghijklmnopqrstuv card 4111 1111 1111 1111 NI AB123456C phone +44 7700 900123");
  assert.ok(!t.includes("jane.doe"));
  assert.ok(!t.includes("sk-abcdef"));
  assert.ok(!t.includes("4111"));
  assert.ok(!t.includes("AB123456C"));
  assert.ok(!t.includes("7700 900123"));
  assert.ok(redact("gpt-4o-2024-08-06 on 2024-08-06").includes("2024-08-06"), "model names and dates survive");
});

test("sampleEvenly spreads across the log", () => {
  assert.deepEqual(sampleEvenly([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5), [1, 3, 5, 7, 9]);
  assert.equal(toSample({ messages: [] }, 1), undefined);
});

/* ---------------- providers (mocked HTTP) */

function recordingFetch(responseBody: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: status < 400, status, text: async () => JSON.stringify(responseBody) };
  };
  return { fn, calls };
}

test("spec parsing", () => {
  assert.deepEqual(parseSpec("deepinfra:google/gemma-3-27b-it"), { provider: "deepinfra", model: "google/gemma-3-27b-it" });
  assert.throws(() => parseSpec("gpt-4o"), /provider:model/);
  assert.throws(() => parseSpec("nope:x"), /Unknown provider/);
  assert.throws(() => createProvider("openai:gpt-4o", { env: {} }), /OPENAI_API_KEY/);
});

test("OpenAI-compatible adapter (DeepInfra) sends the right request and parses tool calls", async () => {
  const { fn, calls } = recordingFetch({ choices: [{ message: { content: null, tool_calls: [{ function: { name: "lookup", arguments: '{"q":1}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  const p = createProvider("deepinfra:google/gemma-3-27b-it", { env: { DEEPINFRA_API_KEY: "k" }, fetchFn: fn });
  const r = await p.chat({ messages: [{ role: "user", content: "hi" }], json: true, temperature: 0 });
  assert.equal(calls[0].url, "https://api.deepinfra.com/v1/openai/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  assert.equal(calls[0].body.model, "google/gemma-3-27b-it");
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  assert.equal(r.toolCalls[0].name, "lookup");
  assert.equal(r.inputTokens, 10);
});

test("HTTP errors (e.g. model removed) become response errors, not exceptions", async () => {
  const { fn } = recordingFetch({ error: { message: "Model not found" } }, 404);
  const p = createProvider("deepinfra:meta-llama/Meta-Llama-3-8B-Instruct", { env: { DEEPINFRA_API_KEY: "k" }, fetchFn: fn });
  const r = await p.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.match(r.error ?? "", /404.*Model not found/);
});

test("transient 429s are retried; permanent 404s are not", async () => {
  const saved = { ...retryPolicy };
  retryPolicy.baseDelayMs = 1;
  try {
    let n = 0;
    const flaky: FetchFn = async () => {
      n++;
      return n < 3 ? { ok: false, status: 429, text: async () => '{"error":{"message":"Model busy, retry later"}}' } : { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"ok"}}]}' };
    };
    const r = await createProvider("deepinfra:x/y-1", { env: { DEEPINFRA_API_KEY: "k" }, fetchFn: flaky }).chat({ messages: [{ role: "user", content: "a" }] });
    assert.equal(r.text, "ok");
    assert.equal(n, 3);

    let m = 0;
    const gone: FetchFn = async () => {
      m++;
      return { ok: false, status: 404, text: async () => '{"error":{"message":"does not exist"}}' };
    };
    const g = await createProvider("deepinfra:x/y-1", { env: { DEEPINFRA_API_KEY: "k" }, fetchFn: gone }).chat({ messages: [{ role: "user", content: "a" }] });
    assert.match(g.error ?? "", /404/);
    assert.equal(m, 1);
  } finally {
    Object.assign(retryPolicy, saved);
  }
});

test("the errors check counts samples whose baseline failed entirely", () => {
  const samples = jsonSamples(10);
  const runs: SampleRun[] = samples.map((s, i) => ({ id: s.id, baseline: [i < 3 ? errored() : ok('{"a":1}')], candidate: [ok('{"a":1}')] }));
  const a = analyze(samples, runs);
  assert.equal(a.metrics.find((m) => m.name === "errors")?.samples, 10);
});

test("Anthropic adapter moves system prompt and converts tools", async () => {
  const { fn, calls } = recordingFetch({ content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "t", input: { a: 1 } }], usage: { input_tokens: 3, output_tokens: 2 } });
  const p = createProvider("anthropic:claude-sonnet-5-5", { env: { ANTHROPIC_API_KEY: "k" }, fetchFn: fn });
  const r = await p.chat({ messages: [{ role: "system", content: "sys" }, { role: "user", content: "u" }], tools: [{ type: "function", function: { name: "t", parameters: { type: "object" } } }] });
  assert.equal(calls[0].body.system, "sys");
  assert.equal(calls[0].body.messages.length, 1);
  assert.equal(calls[0].body.tools[0].input_schema.type, "object");
  assert.equal(calls[0].headers["x-api-key"], "k");
  assert.equal(r.text, "ok");
  assert.equal(r.toolCalls[0].arguments, '{"a":1}');
});

test("Gemini adapter uses generateContent and maps roles", async () => {
  const { fn, calls } = recordingFetch({ candidates: [{ content: { parts: [{ text: "hey" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } });
  const p = createProvider("google:models/gemini-3.6-flash", { env: { GEMINI_API_KEY: "k" }, fetchFn: fn });
  const r = await p.chat({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }], json: true });
  assert.match(calls[0].url, /models\/gemini-3\.6-flash:generateContent$/);
  assert.equal(calls[0].body.contents[1].role, "model");
  assert.equal(calls[0].body.generationConfig.responseMimeType, "application/json");
  assert.equal(r.text, "hey");
});

test("Azure adapter targets the deployment URL with api-key header", async () => {
  const { fn, calls } = recordingFetch({ choices: [{ message: { content: "x" } }] });
  const p = createProvider("azure:my-gpt4o", { env: { AZURE_OPENAI_API_KEY: "k", AZURE_OPENAI_ENDPOINT: "https://res.openai.azure.com/" }, fetchFn: fn });
  await p.chat({ messages: [{ role: "user", content: "a" }] });
  assert.match(calls[0].url, /^https:\/\/res\.openai\.azure\.com\/openai\/deployments\/my-gpt4o\/chat\/completions\?api-version=/);
  assert.equal(calls[0].headers["api-key"], "k");
});

test("OpenAI adapter adapts to settings a newer model rejects, and records each change", async () => {
  // Mimics gpt-6-luna: rejects temperature 0, max_tokens, and tools without reasoning_effort "none".
  const bodies: any[] = [];
  const fn: FetchFn = async (_url, init) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    const fail = (msg: string) => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: msg } }) });
    if (b.temperature === 0) return fail("Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.");
    if ("max_tokens" in b) return fail("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.");
    if (b.tools && b.reasoning_effort !== "none") return fail("Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.");
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
  };
  const p = createProvider("openai:gpt-6-luna", { env: { OPENAI_API_KEY: "k" }, fetchFn: fn });
  const tools = [{ type: "function" as const, function: { name: "f", parameters: { type: "object" } } }];
  const first = await p.chat({ messages: [{ role: "user", content: "a" }], temperature: 0, max_tokens: 50, tools });
  assert.equal(first.error, undefined);
  assert.equal(first.text, "ok");
  assert.equal(first.adjustments?.length, 3);
  assert.match(first.adjustments![0], /temperature 0/);
  assert.equal(bodies.length, 4); // rejected three times, then accepted
  const last = bodies.at(-1);
  assert.equal(last.temperature, undefined);
  assert.equal(last.max_completion_tokens, 50);
  assert.equal(last.reasoning_effort, "none");

  // Later requests get the learned fixes up front: one call, and the changes are still recorded.
  bodies.length = 0;
  const second = await p.chat({ messages: [{ role: "user", content: "b" }], temperature: 0 });
  assert.equal(bodies.length, 1);
  assert.equal(second.adjustments?.length, 1);
  // Requests without the rejected setting have nothing to record.
  const third = await p.chat({ messages: [{ role: "user", content: "c" }] });
  assert.equal(third.adjustments, undefined);

  // Unrelated 400s are not retried.
  bodies.length = 0;
  const bad: FetchFn = async (_u, init) => (bodies.push(JSON.parse(init.body)), { ok: false, status: 400, text: async () => '{"error":{"message":"Invalid messages"}}' });
  const r = await createProvider("openai:x", { env: { OPENAI_API_KEY: "k" }, fetchFn: bad }).chat({ messages: [{ role: "user", content: "a" }], temperature: 0 });
  assert.match(r.error!, /Invalid messages/);
  assert.equal(bodies.length, 1);
});

test("request changes show up as a warning that the user's code needs them too", () => {
  const samples = jsonSamples(3);
  const adj = ["rejects temperature 0, so the model's default temperature was used."];
  const runs: SampleRun[] = samples.map((s) => ({ id: s.id, baseline: [ok("{}"), ok("{}")], candidate: [ok("{}", { adjustments: adj }), ok("{}", { adjustments: adj })] }));
  const a = analyze(samples, runs, { baselineSpec: "openai:gpt-4o-mini", candidateSpec: "openai:gpt-6-luna" });
  const p = a.problems.find((x) => /had to change/.test(x.title));
  assert.ok(p, JSON.stringify(a.problems));
  assert.equal(p!.severity, "warning");
  assert.match(p!.title, /1 setting had to change for the candidate model: your code will need this change too/);
  assert.match(p!.detail, /openai:gpt-6-luna rejected this setting/);
  assert.deepEqual(p!.items, ["Rejects temperature 0, so the model's default temperature was used. (6 of 6 calls)"]);
});

test("empty answers caused by hidden reasoning get a specific diagnosis", () => {
  const samples = jsonSamples(2);
  const empty = ok("", { finishReason: "length", outputTokens: 10, reasoningTokens: 10 });
  const runs: SampleRun[] = samples.map((s) => ({ id: s.id, baseline: [ok("{}"), ok("{}")], candidate: [empty, ok("{}", { finishReason: "length" })] }));
  const a = analyze(samples, runs);
  const p = a.problems.find((x) => /hidden reasoning/.test(x.title));
  assert.ok(p, JSON.stringify(a.problems));
  assert.match(p!.title, /2 candidate answers were empty: hidden reasoning used the whole token limit/);
  assert.match(p!.detail, /reasoning_effort "none"/);
  assert.match(p!.detail, /2 other answers were cut off part-way/);
  // Ordinary truncation keeps the generic message.
  const plain = analyze(samples, samples.map((s) => ({ id: s.id, baseline: [ok("{}")], candidate: [ok('{"a":', { finishReason: "length" })] })));
  assert.ok(plain.problems.some((x) => /cut off by the token limit/.test(x.title)));
});

/* ---------------- analysis */

const ok = (text: string, extra: Partial<ChatResponse> = {}): ChatResponse => ({ text, toolCalls: [], latencyMs: 100, ...extra });
const errored = (): ChatResponse => ({ text: "", toolCalls: [], latencyMs: 50, error: "HTTP 404: model not found" });

function jsonSamples(n: number): Sample[] {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i}`, messages: [{ role: "user" as const, content: `extract ${i}` }], json: true }));
}

test("identical behaviour → likely safe", () => {
  const samples = jsonSamples(25);
  const runs: SampleRun[] = samples.map((s) => ({ id: s.id, baseline: [1, 2, 3].map(() => ok('{"name":"x","total":1}')), candidate: [1, 2, 3].map(() => ok('{"name":"x","total":1}')) }));
  const a = analyze(samples, runs);
  assert.equal(a.verdict, "likely-safe");
  assert.equal(a.confidence, "medium");
  assert.ok(a.metrics.every((m) => !m.regression));
});

test("candidate breaks JSON shape → unsafe, with examples", () => {
  const samples = jsonSamples(25);
  const runs: SampleRun[] = samples.map((s) => ({
    id: s.id,
    baseline: [1, 2, 3].map(() => ok('{"name":"x","total":1}')),
    candidate: [1, 2, 3].map(() => ok("Sure! Here is the data: name x, total 1")),
  }));
  const a = analyze(samples, runs);
  assert.equal(a.verdict, "unsafe");
  assert.ok(a.metrics.find((m) => m.name === "json-valid")?.regression);
  assert.ok(a.examples.some((e) => e.metric === "json-valid"));
});

test("removed model (all candidate calls error) → errors regression", () => {
  const samples = jsonSamples(10);
  const runs: SampleRun[] = samples.map((s) => ({ id: s.id, baseline: [ok('{"a":1}'), ok('{"a":1}')], candidate: [errored(), errored()] }));
  const a = analyze(samples, runs);
  const e = a.metrics.find((m) => m.name === "errors")!;
  assert.equal(e.candidate, 1);
  assert.ok(e.regression);
  assert.equal(a.verdict, "unsafe");
  assert.equal(a.confidence, "low");
});

test("a noisy baseline does not produce false alarms when the candidate is equally noisy", () => {
  const samples = jsonSamples(30);
  const runs: SampleRun[] = samples.map((s, i) => ({
    id: s.id,
    baseline: [ok('{"a":1}'), ok(i % 2 ? "oops not json" : '{"a":1}'), ok('{"a":1}')],
    candidate: [ok('{"a":1}'), ok(i % 2 ? '{"a":1}' : "oops not json"), ok('{"a":1}')],
  }));
  const a = analyze(samples, runs);
  assert.ok(!a.metrics.find((m) => m.name === "json-valid")?.regression);
});

test("tool-call changes are detected", () => {
  const samples: Sample[] = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, messages: [{ role: "user", content: "weather?" }], tools: [{ type: "function", function: { name: "get_weather" } }] }));
  const call = (name: string) => ok("", { toolCalls: [{ name, arguments: "{}" }] });
  const runs: SampleRun[] = samples.map((s) => ({ id: s.id, baseline: [call("get_weather"), call("get_weather")], candidate: [ok("It is sunny."), ok("It is sunny.")] }));
  const a = analyze(samples, runs);
  assert.ok(a.metrics.find((m) => m.name === "tool-calls")?.regression);
  assert.ok(a.drift.changed);
});

test("old model already removed → candidate judged on its own against expected outputs", () => {
  const samples: Sample[] = Array.from({ length: 20 }, (_, i) => ({ id: `l${i}`, messages: [{ role: "user", content: "kal milte hain" }], expect: { match: ["^romanized hindi\\.?$"] } }));
  const good: SampleRun[] = samples.map((s) => ({ id: s.id, baseline: [errored(), errored()], candidate: [ok("romanized Hindi"), ok("romanized Hindi")] }));
  const a = analyze(samples, good);
  assert.match(a.reasons[0], /baseline unavailable/);
  const as = a.metrics.find((m) => m.name === "assertions")!;
  assert.equal(as.mode, "candidate-only");
  assert.equal(as.candidate, 1);
  assert.equal(a.verdict, "likely-safe");

  const bad: SampleRun[] = samples.map((s, i) => ({ id: s.id, baseline: [errored(), errored()], candidate: [ok(i % 2 ? "English" : "romanized Hindi"), ok("English")] }));
  const b = analyze(samples, bad);
  assert.equal(b.verdict, "review");
  assert.ok(b.metrics.find((m) => m.name === "assertions")?.regression);
});

test("a silently redirected baseline is called out; dated aliases are not", () => {
  assert.equal(redirectedTo("deepinfra:google/gemma-2-9b-it", [ok("x", { servedModel: "google/gemma-3-12b-it" })]), "google/gemma-3-12b-it");
  assert.equal(redirectedTo("openai:gpt-4o", [ok("x", { servedModel: "gpt-4o-2024-08-06" })]), undefined);
  assert.equal(redirectedTo("google:gemini-3.6-flash", [ok("x", { servedModel: "models/gemini-3.6-flash" })]), undefined);
  const samples = jsonSamples(20);
  const runs: SampleRun[] = samples.map((s) => ({ id: s.id, baseline: [ok('{"a":1}', { servedModel: "google/gemma-3-12b-it" })], candidate: [ok('{"a":1}', { servedModel: "google/gemma-3-12b-it" })] }));
  const r = analyze(samples, runs, { baselineSpec: "deepinfra:google/gemma-2-9b-it", candidateSpec: "deepinfra:google/gemma-3-12b-it" });
  assert.ok(r.reasons.some((x) => x.startsWith("baseline redirected")));
  assert.equal(r.verdict, "review");
});

test("executeRun runs every sample × repeat × model with bounded concurrency", async () => {
  let inFlight = 0;
  let peak = 0;
  const fake = (spec: string): ChatProvider => ({
    spec,
    provider: "fake",
    model: spec,
    async chat() {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return ok("x");
    },
  });
  const samples = jsonSamples(5);
  const { runs, meta } = await executeRun(samples, fake("a:1"), fake("b:2"), { repeats: 3, concurrency: 2 });
  assert.equal(meta.repeats, 3);
  assert.ok(runs.every((r) => r.baseline.length === 3 && r.candidate.length === 3));
  assert.ok(peak <= 2);
});

/* ---------------- CLI */

test("capture CLI writes a samples file; run refuses large spends without --yes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "modelshift-"));
  const logs = join(dir, "logs.jsonl");
  writeFileSync(logs, Array.from({ length: 12 }, (_, i) => JSON.stringify({ messages: [{ role: "user", content: `q${i} mail me at a@b.co` }] })).join("\n"));
  const out = join(dir, "samples.jsonl");
  assert.equal(await main(["capture", logs, "-o", out]), 0);
  const text = readFileSync(out, "utf8");
  assert.equal(text.trim().split("\n").length, 12);
  assert.ok(!text.includes("a@b.co"));

  const prev = process.env.DEEPINFRA_API_KEY;
  process.env.DEEPINFRA_API_KEY = "test-key";
  try {
    // 12 samples × 3 repeats × 2 = 72 calls > 60 → must stop before calling any API
    assert.equal(await main(["run", "--from", "deepinfra:a/b-1", "--to", "deepinfra:c/d-2", "--samples", out, "--out", join(dir, "r.json")]), 1);
    assert.ok(!existsSync(join(dir, "r.json")));
  } finally {
    if (prev === undefined) delete process.env.DEEPINFRA_API_KEY;
    else process.env.DEEPINFRA_API_KEY = prev;
  }
});
