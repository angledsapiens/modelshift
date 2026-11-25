import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPromptfoo, mapProvider, parseCsv, render } from "../src/import/promptfoo.js";
import { assertionsPass } from "../src/run/checks.js";
import { main } from "../src/cli.js";

const FIXTURE = join("test", "fixtures", "promptfoo", "promptfooconfig.yaml");

test("render: Nunjucks variables and common filters", () => {
  assert.equal(render("Hi {{ name }}, {{user.city | upper}} {{ missing | default('n/a') }} {{ obj | dump }}", { name: "Ann", user: { city: "Leeds" }, obj: { a: 1 } }), 'Hi Ann, LEEDS n/a {"a":1}');
  assert.equal(render("{{ weird(x) }}", {}), "{{ weird(x) }}");
});

test("parseCsv handles quotes, commas and newlines", () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi""\nthere"\n'), [{ a: "x, y", b: 'say "hi"\nthere' }]);
});

test("mapProvider translates Promptfoo provider ids", () => {
  assert.equal(mapProvider("openai:chat:gpt-4o"), "openai:gpt-4o");
  assert.equal(mapProvider("openai:gpt-4.1-mini"), "openai:gpt-4.1-mini");
  assert.equal(mapProvider("anthropic:messages:claude-sonnet-5-5"), "anthropic:claude-sonnet-5-5");
  assert.equal(mapProvider("azureopenai:chat:my-deploy"), "azure:my-deploy");
  assert.equal(mapProvider("vertex:gemini-2.5-pro"), "google:gemini-2.5-pro");
  assert.equal(mapProvider("togetherai:meta-llama/Llama-3.3-70B-Instruct-Turbo"), "together:meta-llama/Llama-3.3-70B-Instruct-Turbo");
  assert.equal(mapProvider("ollama:llama3"), undefined);
});

test("importPromptfoo: prompts × tests (incl. CSV and array vars) with translated assertions", () => {
  const r = importPromptfoo(FIXTURE);
  // 4 replayable prompts (2 from the --- split text file, the chat JSON, the inline one); the JS prompt is skipped.
  // 5 test cases (1 + 2 from the array var + 2 CSV rows).
  assert.equal(r.samples.length, 20);
  assert.ok(r.warnings.some((w) => /dynamic\.js/.test(w)));
  assert.deepEqual(r.providers.map((p) => p.spec), ["openai:gpt-4o-2024-08-06", "anthropic:claude-sonnet-5-5"]);
  assert.equal(r.skipped["llm-rubric"].count, 4);
  assert.match(r.skipped["llm-rubric"].hint, /--judge/);
  assert.equal(r.skipped.javascript.count, 8);

  const refund = r.samples.find((s) => s.id === "refund-question-p3")!;
  assert.deepEqual(refund.messages, [
    { role: "system", content: "You are a support agent." },
    { role: "user", content: "I want a refund for order 1234" },
  ]);
  assert.equal(refund.temperature, 0);
  assert.ok(assertionsPass("Your refund for 1234 is on its way", refund.expect));
  assert.equal(assertionsPass("Your refund is on its way", refund.expect), false, "contains is required");
  assert.equal(assertionsPass("As an AI, 1234", refund.expect), false, "defaultTest not-icontains applies");

  const hello = r.samples.filter((s) => s.id.startsWith("t2-"));
  assert.equal(hello.length, 8);
  assert.equal(hello[0].messages[0].content, "Summarise in one line: Hello there");
  assert.ok(assertionsPass("Bonjour !", hello[0].expect), "icontains-any is case-insensitive");

  const csv = r.samples.filter((s) => s.id.startsWith("t3-") || s.id.startsWith("t4-"));
  assert.equal(csv.length, 8);
  const ship = csv.find((s) => s.messages.at(-1)!.content.includes("Downing") && s.id.endsWith("p4"))!;
  assert.equal(ship.messages[0].content, "Translate to French: Ship to 10 Downing St, please");
  assert.equal(ship.expect?.json, true);
  assert.ok(assertionsPass('{"a": 10}', ship.expect));
  assert.equal(assertionsPass('{"a": "ten"}', ship.expect), false, "regex \\d+ is required");
  const plain = csv.find((s) => s.messages.at(-1)!.content.endsWith("plain"))!;
  assert.ok(assertionsPass("  exact answer ", plain.expect));
  assert.equal(assertionsPass("Exact answer", plain.expect), false, "equals is case-sensitive");
  assert.equal(new Set(r.samples.map((s) => s.id)).size, r.samples.length, "ids are unique");
});

test("import CLI writes samples and suggests the run command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ms-import-"));
  const out = join(dir, "s.jsonl");
  const orig = process.stdout.write.bind(process.stdout);
  let printed = "";
  (process.stdout as any).write = (s: string) => ((printed += s), true);
  try {
    assert.equal(await main(["import", "promptfoo", FIXTURE, "-o", out]), 0);
  } finally {
    (process.stdout as any).write = orig;
  }
  assert.equal(readFileSync(out, "utf8").trim().split("\n").length, 20);
  assert.match(printed, /Next: modelshift run --from openai:gpt-4o-2024-08-06 --to anthropic:claude-sonnet-5-5/);
  assert.match(printed, /llm-rubric ×4: use --judge/);

  const bad = join(dir, "bad.yaml");
  writeFileSync(bad, "prompts:\n  - file://prompts/only.py\n");
  assert.equal(await main(["import", "promptfoo", bad]), 1);
  assert.equal(await main(["import", "nope"]), 1);
});

test("importPromptfoo: provider tools, JSON mode, provider files, transforms and anchors", () => {
  const dir = mkdtempSync(join(tmpdir(), "ms-pf2-"));
  writeFileSync(join(dir, "provider.yaml"), "id: openai:chat:gpt-4o-mini\nconfig:\n  temperature: 0\n");
  writeFileSync(join(dir, "tools.json"), JSON.stringify([{ name: "lookup", description: "Find", input_schema: { type: "object" } }]));
  writeFileSync(join(dir, "promptfooconfig.yaml"), `common: &common
  temperature: 0
  tools: file://tools.json
  response_format: { type: json_object }
prompts: ['Find {{q}}']
providers:
  - file://provider.yaml
  - id: anthropic:messages:claude-haiku-5
    config:
      <<: *common
tests:
  - vars: { q: cats }
    options: { transform: output.name }
    assert:
      - type: equals
        value: lookup
  - vars: { q: dogs }
    assert:
      - type: is-json
      - type: contains
        value: dogs
        transform: output.toUpperCase()
  - huggingface://datasets/x/y
`);
  const r = importPromptfoo(join(dir, "promptfooconfig.yaml"));
  assert.deepEqual(r.providers.map((p) => p.spec), ["openai:gpt-4o-mini", "anthropic:claude-haiku-5"]);
  assert.equal(r.samples.length, 2);
  assert.deepEqual(r.samples[0].tools, [{ type: "function", function: { name: "lookup", description: "Find", parameters: { type: "object" } } }]);
  assert.equal(r.samples[0].json, true);
  assert.equal(r.samples[0].temperature, 0);
  // Assertions on transformed outputs are not translated (they would fail on the raw output).
  assert.equal(r.samples[0].expect, undefined);
  assert.deepEqual(r.samples[1].expect, { json: true });
  assert.equal(r.skipped["equals (transformed output)"].count, 1);
  assert.equal(r.skipped["contains (transformed output)"].count, 1);
  assert.ok(r.warnings.some((w) => /huggingface:\/\/.*fetched when Promptfoo runs/.test(w)));
  // A tool-call answer counts as JSON, as in Promptfoo.
  assert.equal(assertionsPass('lookup({"q":"dogs"})', r.samples[1].expect, { structured: true }), true);
});

test("importPromptfoo explains configs it can't import", () => {
  const dir = mkdtempSync(join(tmpdir(), "ms-pf3-"));
  writeFileSync(join(dir, "a.yaml"), "prompts: ['x']\ntests: file://gen.ts:make\n");
  assert.throws(() => importPromptfoo(join(dir, "a.yaml")), /generated by code/);
  writeFileSync(join(dir, "b.yaml"), "targets: [http]\nredteam:\n  plugins: [harmful]\n");
  assert.throws(() => importPromptfoo(join(dir, "b.yaml")), /red-team configs/);
});
