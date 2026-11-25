/**
 * Thin chat adapters behind one interface. A model is addressed as "provider:model",
 * e.g. "openai:gpt-4o-2024-08-06", "deepinfra:google/gemma-3-27b-it", "anthropic:claude-opus-5-5".
 * Keys come from the environment and are only sent to their own provider.
 */

import { bedrockAuth, type AwsAuth } from "./aws.js";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
}

/** OpenAI-style function tool definition (converted for other providers). */
export interface ToolDef {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface ChatRequest {
  messages: Message[];
  tools?: ToolDef[];
  temperature?: number;
  max_tokens?: number;
  json?: boolean; // ask for a JSON object response where the provider supports it
}

export interface ToolCall {
  name: string;
  arguments: string; // raw JSON string as returned
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  /** Hidden reasoning tokens, included in outputTokens (OpenAI reasoning models). */
  reasoningTokens?: number;
  latencyMs: number;
  finishReason?: string;
  /** Model the provider reports actually serving the request (may differ from the requested one: redirects/aliases). */
  servedModel?: string;
  error?: string; // set when the call failed (HTTP error, model gone, timeout...)
  /** Settings the model rejected and how the request was changed to make it work (see COMPAT_FIXES). */
  adjustments?: string[];
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ChatProvider {
  spec: string; // "provider:model"
  provider: string;
  model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

const OPENAI_COMPATIBLE: Record<string, { base: string; keyEnv: string[] }> = {
  openai: { base: "https://api.openai.com/v1", keyEnv: ["OPENAI_API_KEY"] },
  deepinfra: { base: "https://api.deepinfra.com/v1/openai", keyEnv: ["DEEPINFRA_API_KEY", "DEEPINFRA_TOKEN"] },
  together: { base: "https://api.together.xyz/v1", keyEnv: ["TOGETHER_API_KEY"] },
  fireworks: { base: "https://api.fireworks.ai/inference/v1", keyEnv: ["FIREWORKS_API_KEY"] },
  groq: { base: "https://api.groq.com/openai/v1", keyEnv: ["GROQ_API_KEY"] },
  openrouter: { base: "https://openrouter.ai/api/v1", keyEnv: ["OPENROUTER_API_KEY"] },
  mistral: { base: "https://api.mistral.ai/v1", keyEnv: ["MISTRAL_API_KEY"] },
};

export const SUPPORTED_PROVIDERS = [...Object.keys(OPENAI_COMPATIBLE), "anthropic", "google", "azure", "bedrock"];

export function parseSpec(spec: string): { provider: string; model: string } {
  const i = spec.indexOf(":");
  if (i <= 0) throw new Error(`Model must be "provider:model" (e.g. openai:gpt-4o-2024-08-06), got "${spec}"`);
  const provider = spec.slice(0, i).toLowerCase();
  const model = spec.slice(i + 1);
  if (!SUPPORTED_PROVIDERS.includes(provider)) throw new Error(`Unknown provider "${provider}". Supported: ${SUPPORTED_PROVIDERS.join(", ")}`);
  return { provider, model };
}

function keyFrom(env: NodeJS.ProcessEnv, names: string[], provider: string): string {
  const k = names.map((n) => env[n]).find(Boolean);
  if (!k) throw new Error(`Missing API key for ${provider}: set ${names.join(" or ")}`);
  return k;
}

/** Retries for transient failures (rate limits, overloaded/5xx, timeouts). Exposed for tests. */
export const retryPolicy = { attempts: 4, baseDelayMs: 1500 };

const isTransient = (status: number, error?: string) => status === 429 || (status >= 500 && status <= 504) || status === 529 || error === "timeout" || (status === 0 && !!error);

async function postJson(fetchFn: FetchFn, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<{ status: number; json?: any; error?: string; latencyMs: number; attempts: number }> {
  let last: Awaited<ReturnType<typeof postJsonOnce>> | undefined;
  for (let attempt = 1; attempt <= retryPolicy.attempts; attempt++) {
    last = await postJsonOnce(fetchFn, url, headers, body, timeoutMs);
    if (!last.error || !isTransient(last.status, last.error)) return { ...last, attempts: attempt };
    if (attempt < retryPolicy.attempts) {
      const wait = retryPolicy.baseDelayMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5); // exponential backoff + jitter
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return { ...last!, error: `${last!.error} (after ${retryPolicy.attempts} attempts)`, attempts: retryPolicy.attempts };
}

async function postJsonOnce(fetchFn: FetchFn, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<{ status: number; json?: any; error?: string; latencyMs: number }> {
  const t0 = performance.now();
  try {
    const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const raw = await res.text();
    const latencyMs = performance.now() - t0;
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      const msg = json?.error?.message ?? json?.message ?? raw.slice(0, 300);
      return { status: res.status, error: `HTTP ${res.status}: ${msg}`, latencyMs };
    }
    return { status: res.status, json, latencyMs };
  } catch (e) {
    return { status: 0, error: (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message, latencyMs: performance.now() - t0 };
  }
}

/**
 * Request settings a model rejects with HTTP 400, and the smallest change that makes the request work.
 * Newer models drop settings older ones accepted (e.g. gpt-6-luna rejects temperature 0, max_tokens,
 * and function tools on Chat Completions at its default reasoning effort). Instead of failing every call,
 * modelshift makes the change, retries, and reports it: the user's code will need the same change.
 */
export const COMPAT_FIXES: { id: string; matches: RegExp; applies: (b: Record<string, unknown>) => boolean; fix: (b: Record<string, unknown>) => void; note: (b: Record<string, unknown>) => string }[] = [
  {
    id: "temperature",
    matches: /'?temperature'? (does not support|is not supported)|unsupported (value|parameter): '?temperature/i,
    applies: (b) => b.temperature !== undefined,
    fix: (b) => delete b.temperature,
    note: (b) => `rejects temperature ${b.temperature}, so the model's default temperature was used. Remove or change temperature in your code; answers may vary more from run to run.`,
  },
  {
    id: "max_tokens",
    matches: /'?max_tokens'? is not supported[\s\S]*max_completion_tokens/i,
    applies: (b) => b.max_tokens !== undefined,
    fix: (b) => {
      b.max_completion_tokens = b.max_tokens;
      delete b.max_tokens;
    },
    note: () => "rejects max_tokens, so max_completion_tokens was sent instead. Rename it in your code. For reasoning models the limit also covers hidden reasoning tokens, so answers may be cut short at the same value.",
  },
  {
    id: "tools_reasoning_effort",
    matches: /function tools with reasoning_effort are not supported[\s\S]*reasoning_effort to '?none'?/i,
    applies: (b) => Array.isArray(b.tools) && b.reasoning_effort === undefined,
    fix: (b) => {
      b.reasoning_effort = "none";
    },
    note: () => `rejects function tools on Chat Completions at its default reasoning effort, so reasoning_effort "none" was sent for requests with tools. Your code needs that setting, or a move to the Responses API (where the model may answer differently: test that separately).`,
  },
];

function openAICompatible(provider: string, model: string, base: string, headers: Record<string, string>, fetchFn: FetchFn, timeoutMs: number, urlOverride?: string): ChatProvider {
  // Fixes this model has needed once are applied up front for later requests, so each call isn't rejected first.
  const learned = new Set<string>();
  return {
    spec: `${provider}:${model}`,
    provider,
    model,
    async chat(req) {
      const body: Record<string, unknown> = { model, messages: req.messages };
      if (req.tools?.length) body.tools = req.tools;
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
      if (req.json) body.response_format = { type: "json_object" };
      const adjustments: string[] = [];
      const apply = (f: (typeof COMPAT_FIXES)[number]) => {
        adjustments.push(f.note(body));
        f.fix(body);
      };
      for (const f of COMPAT_FIXES) if (learned.has(f.id) && f.applies(body)) apply(f);
      let r = await postJson(fetchFn, urlOverride ?? `${base}/chat/completions`, headers, body, timeoutMs);
      for (let i = 0; i < COMPAT_FIXES.length && r.error && r.status === 400; i++) {
        const f = COMPAT_FIXES.find((c) => c.matches.test(r.error!) && c.applies(body));
        if (!f) break;
        learned.add(f.id);
        apply(f);
        r = await postJson(fetchFn, urlOverride ?? `${base}/chat/completions`, headers, body, timeoutMs);
      }
      const adj = adjustments.length ? { adjustments } : {};
      if (r.error) return { text: "", toolCalls: [], latencyMs: r.latencyMs, error: r.error, ...adj };
      const choice = r.json?.choices?.[0];
      const msg = choice?.message ?? {};
      return {
        text: typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((p: any) => p.text ?? "").join("") : "",
        toolCalls: (msg.tool_calls ?? []).map((t: any) => ({ name: t.function?.name ?? "", arguments: t.function?.arguments ?? "" })),
        inputTokens: r.json?.usage?.prompt_tokens,
        outputTokens: r.json?.usage?.completion_tokens,
        reasoningTokens: r.json?.usage?.completion_tokens_details?.reasoning_tokens || undefined,
        latencyMs: r.latencyMs,
        finishReason: choice?.finish_reason,
        servedModel: typeof r.json?.model === "string" ? r.json.model : undefined,
        ...adj,
      };
    },
  };
}

function anthropic(model: string, key: string, fetchFn: FetchFn, timeoutMs: number): ChatProvider {
  return {
    spec: `anthropic:${model}`,
    provider: "anthropic",
    model,
    async chat(req) {
      const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const messages = req.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.role === "tool" ? `[tool result] ${m.content}` : m.content }));
      const body: Record<string, unknown> = { model, messages, max_tokens: req.max_tokens ?? 1024 };
      if (system) body.system = system;
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters ?? { type: "object", properties: {} } }));
      const r = await postJson(fetchFn, "https://api.anthropic.com/v1/messages", { "x-api-key": key, "anthropic-version": "2023-06-01" }, body, timeoutMs);
      if (r.error) return { text: "", toolCalls: [], latencyMs: r.latencyMs, error: r.error };
      const blocks: any[] = r.json?.content ?? [];
      return {
        text: blocks.filter((b) => b.type === "text").map((b) => b.text).join(""),
        toolCalls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ name: b.name, arguments: JSON.stringify(b.input ?? {}) })),
        inputTokens: r.json?.usage?.input_tokens,
        outputTokens: r.json?.usage?.output_tokens,
        latencyMs: r.latencyMs,
        finishReason: r.json?.stop_reason,
        servedModel: typeof r.json?.model === "string" ? r.json.model : undefined,
      };
    },
  };
}

function gemini(model: string, key: string, fetchFn: FetchFn, timeoutMs: number): ChatProvider {
  const name = model.replace(/^models\//, "");
  return {
    spec: `google:${name}`,
    provider: "google",
    model: name,
    async chat(req) {
      const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const contents = req.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
      const generationConfig: Record<string, unknown> = {};
      if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
      if (req.max_tokens !== undefined) generationConfig.maxOutputTokens = req.max_tokens;
      if (req.json) generationConfig.responseMimeType = "application/json";
      const body: Record<string, unknown> = { contents, generationConfig };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      if (req.tools?.length) body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })) }];
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(name)}:generateContent`;
      const r = await postJson(fetchFn, url, { "x-goog-api-key": key }, body, timeoutMs);
      if (r.error) return { text: "", toolCalls: [], latencyMs: r.latencyMs, error: r.error };
      const cand = r.json?.candidates?.[0];
      const parts: any[] = cand?.content?.parts ?? [];
      return {
        text: parts.filter((p) => typeof p.text === "string").map((p) => p.text).join(""),
        toolCalls: parts.filter((p) => p.functionCall).map((p) => ({ name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) })),
        inputTokens: r.json?.usageMetadata?.promptTokenCount,
        outputTokens: r.json?.usageMetadata?.candidatesTokenCount,
        latencyMs: r.latencyMs,
        finishReason: cand?.finishReason,
        servedModel: typeof r.json?.modelVersion === "string" ? r.json.modelVersion : undefined,
      };
    },
  };
}

/**
 * AWS Bedrock through the Converse API, which works the same for every chat model on
 * Bedrock (Claude, Llama, Nova, Mistral, Cohere, DeepSeek...). The model is a Bedrock
 * model id, inference profile id or ARN: bedrock:anthropic.claude-sonnet-4-20250514-v1:0,
 * bedrock:us.meta.llama3-3-70b-instruct-v1:0.
 */
function bedrock(model: string, auth: AwsAuth, fetchFn: FetchFn, timeoutMs: number): ChatProvider {
  const url = `https://bedrock-runtime.${auth.region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;
  return {
    spec: `bedrock:${model}`,
    provider: "bedrock",
    model,
    async chat(req) {
      const system = req.messages.filter((m) => m.role === "system").map((m) => ({ text: m.content }));
      // Converse needs alternating user/assistant turns starting with the user: merge neighbours.
      const messages: { role: "user" | "assistant"; content: { text: string }[] }[] = [];
      for (const m of req.messages) {
        if (m.role === "system") continue;
        const role = m.role === "assistant" ? "assistant" : "user";
        const text = (m.role === "tool" ? `[tool result] ${m.content}` : m.content) || " ";
        const last = messages.at(-1);
        if (last?.role === role) last.content.push({ text });
        else messages.push({ role, content: [{ text }] });
      }
      if (messages[0]?.role === "assistant") messages.unshift({ role: "user", content: [{ text: " " }] });
      const body: Record<string, unknown> = { messages };
      if (system.length) body.system = system;
      const inferenceConfig: Record<string, unknown> = {};
      if (req.temperature !== undefined) inferenceConfig.temperature = req.temperature;
      if (req.max_tokens !== undefined) inferenceConfig.maxTokens = req.max_tokens;
      if (Object.keys(inferenceConfig).length) body.inferenceConfig = inferenceConfig;
      if (req.tools?.length)
        body.toolConfig = { tools: req.tools.map((t) => ({ toolSpec: { name: t.function.name, description: t.function.description || t.function.name, inputSchema: { json: t.function.parameters ?? { type: "object", properties: {} } } } })) };
      // Converse has no JSON mode; the prompt's own instructions decide the format.
      const payload = JSON.stringify(body);
      const r = await postJson(fetchFn, url, auth.headers("POST", url, payload), body, timeoutMs);
      if (r.error) return { text: "", toolCalls: [], latencyMs: r.latencyMs, error: r.error };
      const blocks: any[] = r.json?.output?.message?.content ?? [];
      return {
        text: blocks.filter((b) => typeof b.text === "string").map((b) => b.text).join(""),
        toolCalls: blocks.filter((b) => b.toolUse).map((b) => ({ name: b.toolUse.name, arguments: JSON.stringify(b.toolUse.input ?? {}) })),
        inputTokens: r.json?.usage?.inputTokens,
        outputTokens: r.json?.usage?.outputTokens,
        latencyMs: r.latencyMs,
        finishReason: r.json?.stopReason,
      };
    },
  };
}

/* ------------------------------------------------------------------ embeddings */

export interface Embedder {
  spec: string;
  /** One vector per input text, or an error for the whole batch. */
  embed(texts: string[]): Promise<{ vectors?: number[][]; error?: string }>;
}

const EMBED_CLIP = 8000; // characters per text, to stay under embedding models' input limits

/**
 * Embedding models, addressed like chat models: openai:text-embedding-3-small,
 * deepinfra:BAAI/bge-m3, google:gemini-embedding-001, mistral:mistral-embed, azure:<deployment>,
 * bedrock:amazon.titan-embed-text-v2:0, bedrock:cohere.embed-english-v3.
 */
export function createEmbedder(spec: string, opts: { env?: NodeJS.ProcessEnv; fetchFn?: FetchFn; timeoutMs?: number } = {}): Embedder {
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const { provider, model } = parseSpec(spec);
  const clip = (t: string) => (t.length > EMBED_CLIP ? t.slice(0, EMBED_CLIP) : t) || " ";
  if (provider === "anthropic") throw new Error("Anthropic has no embeddings API; use e.g. --embed openai:text-embedding-3-small or deepinfra:BAAI/bge-m3");
  if (provider === "bedrock") {
    const auth = bedrockAuth(env);
    const url = `https://bedrock-runtime.${auth.region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`;
    const call = async (body: unknown) => {
      const payload = JSON.stringify(body);
      return postJson(fetchFn, url, auth.headers("POST", url, payload), body, timeoutMs);
    };
    return {
      spec: `bedrock:${model}`,
      async embed(texts) {
        if (/^(\w+\.)?cohere\.embed/.test(model)) {
          // Cohere Embed takes up to 96 texts per call.
          const vectors: number[][] = [];
          for (let i = 0; i < texts.length; i += 96) {
            const r = await call({ texts: texts.slice(i, i + 96).map((t) => clip(t).slice(0, 2048)), input_type: "search_document" });
            if (r.error) return { error: r.error };
            const e = r.json?.embeddings;
            vectors.push(...(Array.isArray(e) ? e : (e?.float ?? [])));
          }
          return vectors.length === texts.length ? { vectors } : { error: "embedding response had the wrong number of vectors" };
        }
        // Titan Text Embeddings: one text per call.
        const vectors: number[][] = [];
        for (const t of texts) {
          const r = await call({ inputText: clip(t) });
          if (r.error) return { error: r.error };
          if (!Array.isArray(r.json?.embedding)) return { error: `unexpected embedding response from ${model} (use amazon.titan-embed-text-v2:0 or cohere.embed-*)` };
          vectors.push(r.json.embedding);
        }
        return { vectors };
      },
    };
  }
  if (provider === "google") {
    const key = keyFrom(env, ["GEMINI_API_KEY", "GOOGLE_API_KEY"], provider);
    const name = model.replace(/^models\//, "");
    return {
      spec: `google:${name}`,
      async embed(texts) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(name)}:batchEmbedContents`;
        const r = await postJson(fetchFn, url, { "x-goog-api-key": key }, { requests: texts.map((t) => ({ model: `models/${name}`, content: { parts: [{ text: clip(t) }] } })) }, timeoutMs);
        if (r.error) return { error: r.error };
        const vectors = (r.json?.embeddings ?? []).map((e: any) => e.values as number[]);
        return vectors.length === texts.length ? { vectors } : { error: "embedding response had the wrong number of vectors" };
      },
    };
  }
  let url: string;
  let headers: Record<string, string>;
  if (provider === "azure") {
    const endpoint = env.AZURE_OPENAI_ENDPOINT;
    if (!endpoint) throw new Error("Missing AZURE_OPENAI_ENDPOINT for azure:<deployment>");
    url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${encodeURIComponent(model)}/embeddings?api-version=${env.AZURE_OPENAI_API_VERSION ?? "2024-10-21"}`;
    headers = { "api-key": keyFrom(env, ["AZURE_OPENAI_API_KEY"], provider) };
  } else {
    const cfg = OPENAI_COMPATIBLE[provider];
    url = `${cfg.base}/embeddings`;
    headers = { Authorization: `Bearer ${keyFrom(env, cfg.keyEnv, provider)}` };
  }
  return {
    spec: `${provider}:${model}`,
    async embed(texts) {
      const r = await postJson(fetchFn, url, headers, { model, input: texts.map(clip) }, timeoutMs);
      if (r.error) return { error: r.error };
      const data: any[] = [...(r.json?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const vectors = data.map((d) => d.embedding as number[]);
      return vectors.length === texts.length && vectors.every(Array.isArray) ? { vectors } : { error: "embedding response had the wrong number of vectors" };
    },
  };
}

export function createProvider(spec: string, opts: { env?: NodeJS.ProcessEnv; fetchFn?: FetchFn; timeoutMs?: number } = {}): ChatProvider {
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const { provider, model } = parseSpec(spec);
  if (provider === "anthropic") return anthropic(model, keyFrom(env, ["ANTHROPIC_API_KEY"], provider), fetchFn, timeoutMs);
  if (provider === "google") return gemini(model, keyFrom(env, ["GEMINI_API_KEY", "GOOGLE_API_KEY"], provider), fetchFn, timeoutMs);
  if (provider === "bedrock") return bedrock(model, bedrockAuth(env), fetchFn, timeoutMs);
  if (provider === "azure") {
    // azure:<deployment> with AZURE_OPENAI_ENDPOINT (https://<resource>.openai.azure.com) and AZURE_OPENAI_API_VERSION
    const endpoint = env.AZURE_OPENAI_ENDPOINT;
    if (!endpoint) throw new Error("Missing AZURE_OPENAI_ENDPOINT for azure:<deployment>");
    const version = env.AZURE_OPENAI_API_VERSION ?? "2024-10-21";
    const key = keyFrom(env, ["AZURE_OPENAI_API_KEY"], provider);
    const url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${version}`;
    return openAICompatible("azure", model, endpoint, { "api-key": key }, fetchFn, timeoutMs, url);
  }
  const cfg = OPENAI_COMPATIBLE[provider];
  const key = keyFrom(env, cfg.keyEnv, provider);
  return openAICompatible(provider, model, cfg.base, { Authorization: `Bearer ${key}` }, fetchFn, timeoutMs);
}
