import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYaml, YamlError } from "../src/import/yaml.js";

test("yaml: mappings, sequences, scalars, comments", () => {
  const v = parseYaml(`# config
description: "My eval" # trailing comment
count: 3
ratio: 0.5
on: true
nothing: ~
url: http://example.com/a#frag
list:
  - a
  - 'it''s'
  - "tab\\there"
nested:
  inner:
    deep: 1
tests:
- vars:
    topic: bananas
  assert:
    - type: contains
      value: yellow
- vars: {topic: "apples, red", n: 2}
  assert: [ {type: icontains, value: Red}, {type: is-json} ]
`);
  assert.deepEqual(v, {
    description: "My eval",
    count: 3,
    ratio: 0.5,
    on: true,
    nothing: null,
    url: "http://example.com/a#frag",
    list: ["a", "it's", "tab\there"],
    nested: { inner: { deep: 1 } },
    tests: [
      { vars: { topic: "bananas" }, assert: [{ type: "contains", value: "yellow" }] },
      { vars: { topic: "apples, red", n: 2 }, assert: [{ type: "icontains", value: "Red" }, { type: "is-json" }] },
    ],
  });
});

test("yaml: block scalars and multi-line strings", () => {
  const v = parseYaml(`prompts:
  - |
    You are a helpful assistant.
    Summarise: {{text}}
  - >-
    folded
    into one line

    new paragraph
keep: |+
  a

strip: |-
  b
plain: this is
  continued here
quoted: "first
  second"
last: x
`) as any;
  assert.equal(v.prompts[0], "You are a helpful assistant.\nSummarise: {{text}}\n");
  assert.equal(v.prompts[1], "folded into one line\nnew paragraph");
  assert.equal(v.keep, "a\n\n");
  assert.equal(v.strip, "b");
  assert.equal(v.plain, "this is continued here");
  assert.equal(v.quoted, "first second");
  assert.equal(v.last, "x");
});

test("yaml: multi-line flow collections and top-level lists", () => {
  assert.deepEqual(parseYaml(`- [1, 2,
   3]
- {a: b,
   c: "d"}
- - x
  - y
`), [[1, 2, 3], { a: "b", c: "d" }, ["x", "y"]]);
  assert.deepEqual(parseYaml(`---\nkey: value\n`), { key: "value" });
});

test("yaml: anchors, aliases and merge keys", () => {
  const v = parseYaml(`base: &base
  temperature: 0
  max_tokens: 100
schema: &s { type: object }
providers:
  - id: openai:a
    config:
      <<: *base
      max_tokens: 50
  - &p2
    id: openai:b
    config: *base
  - *p2
  - id: openai:c
    config:
      <<: [*base, {seed: 1}]
      schema: *s
list: [*s, 2]
`) as any;
  assert.deepEqual(v.providers[0].config, { temperature: 0, max_tokens: 50 });
  assert.deepEqual(v.providers[1], { id: "openai:b", config: { temperature: 0, max_tokens: 100 } });
  assert.deepEqual(v.providers[2], v.providers[1]);
  assert.deepEqual(v.providers[3].config, { temperature: 0, max_tokens: 100, seed: 1, schema: { type: "object" } });
  assert.deepEqual(v.list, [{ type: "object" }, 2]);
  v.providers[1].config.temperature = 9;
  assert.equal(v.base.temperature, 0, "aliases are copies");
  assert.throws(() => parseYaml(`a: *nope\n`), /unknown alias/);
});

test("yaml: unsupported features fail clearly", () => {
  assert.throws(() => parseYaml(`a: !!str 1\n`), /tags/);
  assert.throws(() => parseYaml(`a: 1\n---\nb: 2\n`), /multiple YAML documents/);
  assert.throws(() => parseYaml(`a:\n\t- 1\n`), /tabs/);
});
