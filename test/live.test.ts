import { test } from "node:test";
import assert from "node:assert/strict";
import { liveCheck, parseModelList, providersFor } from "../src/live/index.js";
import type { Assessment } from "../src/types.js";

function a(id: string, rawId: string, family: Assessment["family"], hosts: Assessment["hosts"] = [], status: Assessment["status"] = "ok"): Assessment {
  return { id, family, status, locations: [{ file: "f.ts", line: 1, rawId }], hosts };
}

function mockFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[key] };
  };
  return { fn, calls };
}

test("parseModelList reads ids and deprecation-style fields", () => {
  const m = parseModelList({ data: [{ id: "A" }, { id: "b", deprecation: { date: "2027-01-01" } }, { id: "c", expiration_date: "2026-12-31" }] });
  assert.equal(m.get("a")?.deprecation, undefined);
  assert.equal(m.get("b")?.deprecation, "2027-01-01");
  assert.equal(m.get("c")?.deprecation, "2026-12-31");
});

test("open-weight ids are only checked against known hosts", () => {
  assert.deepEqual(providersFor(a("qwen/x", "Qwen/x", "open-weight")), []);
  assert.deepEqual(providersFor(a("qwen/x", "Qwen/x", "open-weight"), ["deepinfra"]), ["deepinfra"]);
  assert.deepEqual(providersFor(a("gpt-4o", "openai/gpt-4o", "openai")), ["openrouter"]);
  assert.deepEqual(providersFor(a("gpt-4o", "gpt-4o", "openai")), ["openai"]);
  // Google's "models/..." path is not a gateway id, even in a file that also uses DeepInfra
  assert.deepEqual(providersFor(a("gemini-2.5-pro", "models/gemini-2.5-pro", "google", ["deepinfra"])), ["google"]);
});

test("a model DeepInfra silently removed is flagged as missing", async () => {
  const list = [
    a("meta-llama/meta-llama-3.1-70b-instruct", "meta-llama/Meta-Llama-3.1-70B-Instruct", "open-weight", ["deepinfra"]),
    a("qwen/qwen3-235b-a22b", "Qwen/Qwen3-235B-A22B", "open-weight", ["deepinfra"]),
  ];
  const { fn } = mockFetch({ "https://api.deepinfra.com/v1/openai/models": { object: "list", data: [{ id: "Qwen/Qwen3-235B-A22B" }] } });
  const { assessments, results } = await liveCheck(list, { env: {}, fetchFn: fn });
  assert.equal(results[0].ok, true); // DeepInfra's list works without a key
  assert.equal(assessments[0].status, "missing");
  assert.match(assessments[0].note ?? "", /deepinfra/);
  assert.equal(assessments[1].status, "ok");
});

test("providers needing keys are skipped, not failed, when keys are absent", async () => {
  const { fn, calls } = mockFetch({});
  const { assessments, results } = await liveCheck([a("gpt-4o", "gpt-4o", "openai")], { env: {}, fetchFn: fn });
  assert.equal(calls.length, 0);
  assert.match(results[0].skipped ?? "", /OPENAI_API_KEY/);
  assert.equal(assessments[0].status, "ok");
});

test("provider deprecation fields surface as flagged", async () => {
  const { fn } = mockFetch({ "https://api.mistral.ai/v1/models": { data: [{ id: "mistral-large-2407", deprecation: "2027-03-30" }] } });
  const { assessments } = await liveCheck([a("mistral-large-2407", "mistral-large-2407", "mistral")], { env: { MISTRAL_API_KEY: "k" }, fetchFn: fn });
  assert.equal(assessments[0].status, "flagged");
});

test("already-retired models are left as retired", async () => {
  const { fn } = mockFetch({ "https://api.openai.com/v1/models": { data: [] } });
  const { assessments } = await liveCheck([a("gpt-4-turbo", "gpt-4-turbo", "openai", [], "retired")], { env: { OPENAI_API_KEY: "k" }, fetchFn: fn });
  assert.equal(assessments[0].status, "retired");
});
