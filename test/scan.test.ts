import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { matchSegment, normalizeId, stringSegments, detectHosts } from "../src/scan/matchers.js";
import { assess, scanRepo, scanText, sortAssessments } from "../src/scan/index.js";
import { loadCalendar } from "../src/calendar.js";
import { parseArgs } from "../src/cli.js";

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/sample-repo", import.meta.url));
const TODAY = "2026-11-24";

test("string segments only come from literals and config values", () => {
  assert.deepEqual(stringSegments(`x = call(model="gpt-4o") # o3`, ".py"), ["gpt-4o"]);
  assert.deepEqual(stringSegments(`MODEL=gpt-4-turbo`, ".env"), ["gpt-4-turbo"]);
  assert.deepEqual(stringSegments(`  model: o3`, ".yaml"), ["o3"]);
  assert.deepEqual(stringSegments(`const o3 = 1;`, ".ts"), []);
});

test("adjacent ids are both detected; gateway ids are reported once", () => {
  const ids = matchSegment("gpt-4o vs gpt-4o-mini").map((m) => m.rawId);
  assert.deepEqual(ids.sort(), ["gpt-4o", "gpt-4o-mini"]);
  const gw = matchSegment("openai/gpt-4o-mini-2024-07-18");
  assert.equal(gw.length, 1);
  assert.equal(gw[0].rawId, "openai/gpt-4o-mini-2024-07-18");
});

test("no false positives from object paths or non-model org paths", () => {
  assert.equal(matchSegment("meta.get").length, 0);
  assert.equal(matchSegment("meta.ayanamsa").length, 0);
  assert.equal(matchSegment("google/callback").length, 0);
  assert.equal(matchSegment("microsoft/vscode").length, 0);
  assert.equal(matchSegment("meta.llama3-70b-instruct-v1:0")[0]?.family, "bedrock");
  assert.equal(matchSegment("google/gemma-3-12b-it")[0]?.rawId, "google/gemma-3-12b-it");
});

test("short o-series ids only match as a whole value", () => {
  assert.equal(matchSegment("o3").length, 1);
  assert.equal(matchSegment("use o3 here").length, 0);
});

test("normalization handles fine-tunes, gemini paths and gateway prefixes", () => {
  assert.equal(normalizeId("ft:gpt-4o-mini-2024-07-18:acme::abc", "openai"), "gpt-4o-mini-2024-07-18");
  assert.equal(normalizeId("models/gemini-2.5-pro", "google"), "gemini-2.5-pro");
  assert.equal(normalizeId("openai/gpt-4o", "open-weight"), "gpt-4o");
  assert.equal(normalizeId("Qwen/Qwen3-235B-A22B", "open-weight"), "qwen/qwen3-235b-a22b");
});

test("host detection", () => {
  assert.deepEqual(detectHosts(`baseURL: "https://api.deepinfra.com/v1/openai"`), ["deepinfra"]);
  assert.deepEqual(detectHosts(`OPENROUTER_API_KEY`), ["openrouter"]);
});

test("scanning the fixture repo finds the expected ids", () => {
  const ids = new Set(scanRepo(FIXTURE).map((f) => f.id));
  for (const id of [
    "gpt-4o-2024-08-06", "gpt-4o", "gpt-4o-mini-2024-07-18", "gpt-6-luna", "claude-sonnet-4-5-20250929",
    "gemini-2.5-pro", "meta-llama/meta-llama-3.1-70b-instruct", "qwen/qwen3-235b-a22b", "gpt-4-turbo", "o3",
  ]) assert.ok(ids.has(id), `missing ${id} in ${[...ids].join(", ")}`);
  assert.ok(![...ids].some((i) => i.includes("comment")));
});

test("assessment against the calendar", () => {
  const cal = loadCalendar();
  const byId = new Map(assess(scanRepo(FIXTURE), cal, TODAY).map((a) => [a.id, a]));
  assert.equal(byId.get("gpt-4o-2024-08-06")?.status, "retiring");
  assert.equal(byId.get("gpt-4o-2024-08-06")?.daysLeft, 51);
  assert.equal(byId.get("gpt-4o-2024-08-06")?.replacement, "gpt-6-luna");
  assert.equal(byId.get("gpt-4o-mini-2024-07-18")?.status, "retiring"); // fine-tune + gateway id follow base model
  assert.equal(byId.get("gpt-4-turbo")?.status, "retired");
  assert.equal(byId.get("o3")?.status, "retiring");
  assert.equal(byId.get("gpt-4o")?.status, "check"); // undated alias
  assert.equal(byId.get("claude-sonnet-4-5-20250929")?.daysLeft, 6);
  assert.equal(byId.get("gemini-2.5-pro")?.status, "retiring");
  assert.equal(byId.get("gpt-6-luna")?.status, "ok");
  const sorted = sortAssessments([...byId.values()]);
  assert.equal(sorted[0].status, "retired");
});

test("every calendar entry has a provider source and valid dates", () => {
  const cal = loadCalendar();
  for (const e of cal.entries) {
    assert.ok(cal.sources[e.provider], `no source for ${e.provider}`);
    if (e.shutdown) assert.match(e.shutdown, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.ids.length > 0);
  }
  const all = cal.entries.flatMap((e) => e.ids.map((i) => i.toLowerCase()));
  assert.equal(new Set(all).size, all.length, "duplicate id across calendar entries");
});

test("scanText ignores very long lines", () => {
  assert.equal(scanText(`"gpt-4o"` + " ".repeat(3000), "x.ts", ".ts").length, 0);
});

test("CLI argument parsing", () => {
  const a = parseArgs(["scan", "./repo", "--live", "--providers", "deepinfra,openrouter", "--fail-on", "retiring"]);
  assert.equal(a.cmd, "scan");
  assert.equal(a.path, "./repo");
  assert.equal(a.live, true);
  assert.deepEqual(a.providers, ["deepinfra", "openrouter"]);
  assert.equal(a.failOn, "retiring");
});
