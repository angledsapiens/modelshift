import { test } from "node:test";
import assert from "node:assert/strict";
import { signV4, bedrockAuth } from "../src/providers/aws.js";
import { createEmbedder, createProvider, type FetchFn } from "../src/providers/index.js";
import { liveCheck, parseModelList, providersFor } from "../src/live/index.js";
import { mapProvider } from "../src/import/promptfoo.js";
import { matchSegment } from "../src/scan/matchers.js";
import type { Assessment } from "../src/types.js";

const EXAMPLE = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };

test("SigV4 matches AWS's published signing example", () => {
  // From the AWS docs "Create a signed AWS API request" (IAM ListUsers).
  const h = signV4(
    { method: "GET", url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" }, body: "" },
    EXAMPLE,
    "us-east-1",
    "iam",
    new Date("2015-08-30T12:36:00Z"),
  );
  assert.equal(h["x-amz-date"], "20150830T123600Z");
  assert.equal(h.authorization, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
});

test("SigV4 adds the session token and double-encodes the path for Bedrock", () => {
  const now = new Date("2026-11-25T10:00:00Z");
  const url = "https://bedrock-runtime.eu-west-2.amazonaws.com/model/anthropic.claude-x-v1%3A0/converse";
  const a = signV4({ method: "POST", url, body: "{}" }, { ...EXAMPLE, sessionToken: "tok" }, "eu-west-2", "bedrock", now);
  assert.equal(a["x-amz-security-token"], "tok");
  assert.match(a.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token/);
  // A different body must change the signature.
  const b = signV4({ method: "POST", url, body: "{ }" }, { ...EXAMPLE, sessionToken: "tok" }, "eu-west-2", "bedrock", now);
  assert.notEqual(a.authorization, b.authorization);
});

test("bedrockAuth: API key first, then access keys; clear error otherwise", () => {
  const k = bedrockAuth({ AWS_BEARER_TOKEN_BEDROCK: "bk", AWS_REGION: "eu-west-2" });
  assert.equal(k.kind, "api-key");
  assert.equal(k.region, "eu-west-2");
  assert.deepEqual(k.headers("POST", "https://x", ""), { Authorization: "Bearer bk" });
  const s = bedrockAuth({ AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "s" });
  assert.equal(s.kind, "sigv4");
  assert.equal(s.region, "us-east-1");
  assert.match(s.headers("POST", "https://bedrock-runtime.us-east-1.amazonaws.com/model/m/converse", "{}").authorization, /^AWS4-HMAC-SHA256 Credential=AKID\//);
  assert.throws(() => createProvider("bedrock:anthropic.claude-x", { env: {} }), /AWS_BEARER_TOKEN_BEDROCK.*export-credentials/);
});

function recording(response: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: status < 400, status, text: async () => JSON.stringify(response) };
  };
  return { fn, calls };
}

test("Bedrock Converse adapter: request shape, tool calls and usage", async () => {
  const { fn, calls } = recording({
    output: { message: { role: "assistant", content: [{ text: "Looking up" }, { toolUse: { toolUseId: "t1", name: "lookup", input: { q: "cats" } } }] } },
    stopReason: "tool_use",
    usage: { inputTokens: 12, outputTokens: 7 },
  });
  const p = createProvider("bedrock:us.anthropic.claude-sonnet-4-20250514-v1:0", { env: { AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "s", AWS_REGION: "eu-west-2" }, fetchFn: fn });
  assert.equal(p.spec, "bedrock:us.anthropic.claude-sonnet-4-20250514-v1:0");
  const r = await p.chat({
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "a" },
      { role: "tool", content: "b" },
      { role: "assistant", content: "c" },
    ],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    temperature: 0,
    max_tokens: 50,
    json: true,
  });
  assert.equal(calls[0].url, "https://bedrock-runtime.eu-west-2.amazonaws.com/model/us.anthropic.claude-sonnet-4-20250514-v1%3A0/converse");
  assert.match(calls[0].headers.authorization, /\/eu-west-2\/bedrock\/aws4_request/);
  assert.deepEqual(calls[0].body.system, [{ text: "Be brief." }]);
  // The user and tool turns are merged so roles alternate.
  assert.deepEqual(calls[0].body.messages, [
    { role: "user", content: [{ text: "a" }, { text: "[tool result] b" }] },
    { role: "assistant", content: [{ text: "c" }] },
  ]);
  assert.deepEqual(calls[0].body.inferenceConfig, { temperature: 0, maxTokens: 50 });
  assert.deepEqual(calls[0].body.toolConfig.tools[0].toolSpec, { name: "lookup", description: "lookup", inputSchema: { json: { type: "object" } } });
  assert.equal(r.text, "Looking up");
  assert.deepEqual(r.toolCalls, [{ name: "lookup", arguments: '{"q":"cats"}' }]);
  assert.equal(r.inputTokens, 12);
  assert.equal(r.finishReason, "tool_use");
});

test("Bedrock errors become response errors", async () => {
  const { fn } = recording({ message: "The provided model identifier is invalid." }, 400);
  const r = await createProvider("bedrock:meta.llama2-70b-chat-v1", { env: { AWS_BEARER_TOKEN_BEDROCK: "k" }, fetchFn: fn }).chat({ messages: [{ role: "user", content: "hi" }] });
  assert.match(r.error ?? "", /400.*model identifier is invalid/);
});

test("Bedrock embeddings: Titan one per call, Cohere in batches", async () => {
  const t = recording({ embedding: [1, 0] });
  const titan = createEmbedder("bedrock:amazon.titan-embed-text-v2:0", { env: { AWS_BEARER_TOKEN_BEDROCK: "k" }, fetchFn: t.fn });
  assert.deepEqual(await titan.embed(["a", "b"]), { vectors: [[1, 0], [1, 0]] });
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[0].url, "https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.titan-embed-text-v2%3A0/invoke");
  assert.deepEqual(t.calls[0].body, { inputText: "a" });
  const c = recording({ embeddings: [[1], [2]] });
  const cohere = createEmbedder("bedrock:cohere.embed-english-v3", { env: { AWS_BEARER_TOKEN_BEDROCK: "k" }, fetchFn: c.fn });
  assert.deepEqual(await cohere.embed(["a", "b"]), { vectors: [[1], [2]] });
  assert.equal(c.calls.length, 1);
});

test("Promptfoo bedrock provider ids map to bedrock specs", () => {
  assert.equal(mapProvider("bedrock:anthropic.claude-3-5-sonnet-20240620-v1:0"), "bedrock:anthropic.claude-3-5-sonnet-20240620-v1:0");
  assert.equal(mapProvider("bedrock:converse:us.amazon.nova-pro-v1:0"), "bedrock:us.amazon.nova-pro-v1:0");
  assert.equal(mapProvider("bedrock:mantle:openai.gpt-oss-120b"), "bedrock:openai.gpt-oss-120b");
  assert.equal(mapProvider("bedrock:video:amazon.nova-reel-v1:1"), undefined);
});

test("scan finds Bedrock ids including global inference profiles", () => {
  const ids = ["global.anthropic.claude-sonnet-4-5-20250929-v1:0", "openai.gpt-oss-120b-1:0"].flatMap((s) => matchSegment(s)).filter((m) => m.family === "bedrock").map((m) => m.rawId);
  assert.deepEqual(ids, ["global.anthropic.claude-sonnet-4-5-20250929-v1:0", "openai.gpt-oss-120b-1:0"]);
});

function asm(rawId: string): Assessment {
  return { id: rawId.toLowerCase(), family: "bedrock", status: "ok", locations: [{ file: "f.py", line: 1, rawId }], hosts: [] };
}

test("live scan: Bedrock LEGACY models are flagged, inference profiles match their base model", async () => {
  const list = {
    modelSummaries: [
      { modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0", modelLifecycle: { status: "LEGACY" } },
      { modelId: "anthropic.claude-sonnet-4-20250514-v1:0", modelLifecycle: { status: "ACTIVE" } },
    ],
  };
  assert.equal(parseModelList(list).get("anthropic.claude-3-5-sonnet-20240620-v1:0")?.deprecation, "LEGACY");
  const urls: string[] = [];
  const fetchFn = async (url: string, init?: { headers?: Record<string, string> }) => {
    urls.push(url);
    assert.match(init?.headers?.authorization ?? "", /AWS4-HMAC-SHA256/);
    return { ok: true, status: 200, json: async () => list };
  };
  const items = [asm("anthropic.claude-3-5-sonnet-20240620-v1:0"), asm("us.anthropic.claude-sonnet-4-20250514-v1:0"), asm("meta.llama2-70b-chat-v1")];
  assert.deepEqual(providersFor(items[0]), ["bedrock"]);
  const { assessments } = await liveCheck(items, { env: { AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "s", AWS_REGION: "eu-west-2" }, fetchFn });
  assert.deepEqual(urls, ["https://bedrock.eu-west-2.amazonaws.com/foundation-models"]);
  assert.equal(assessments[0].status, "flagged");
  assert.match(assessments[0].note ?? "", /LEGACY/);
  assert.equal(assessments[1].status, "ok");
  assert.equal(assessments[2].status, "unlisted");

  const { results } = await liveCheck([asm("meta.llama3-8b-instruct-v1:0")], { env: {}, fetchFn });
  assert.match(results[0].skipped ?? "", /AWS_BEARER_TOKEN_BEDROCK/);
});
