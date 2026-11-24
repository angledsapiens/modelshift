/**
 * Thin chat adapters behind one interface. A model is addressed as "provider:model",
 * e.g. "openai:gpt-4o-2024-08-06", "deepinfra:google/gemma-3-27b-it", "anthropic:claude-opus-5-5".
 * Keys come from the environment and are only sent to their own provider.
 */

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
  latencyMs: number;
  finishReason?: string;
  error?: string; // set when the call failed (HTTP error, model gone, timeout...)
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

export const SUPPORTED_PROVIDERS = [...Object.keys(OPENAI_COMPATIBLE), "anthropic", "google", "azure"];

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

async function postJson(fetchFn: FetchFn, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<{ status: number; json?: any; error?: string; latencyMs: number }> {
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

function openAICompatible(provider: string, model: string, base: string, headers: Record<string, string>, fetchFn: FetchFn, timeoutMs: number, urlOverride?: string): ChatProvider {
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
      const r = await postJson(fetchFn, urlOverride ?? `${base}/chat/completions`, headers, body, timeoutMs);
      if (r.error) return { text: "", toolCalls: [], latencyMs: r.latencyMs, error: r.error };
      const choice = r.json?.choices?.[0];
      const msg = choice?.message ?? {};
      return {
        text: typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((p: any) => p.text ?? "").join("") : "",
        toolCalls: (msg.tool_calls ?? []).map((t: any) => ({ name: t.function?.name ?? "", arguments: t.function?.arguments ?? "" })),
        inputTokens: r.json?.usage?.prompt_tokens,
        outputTokens: r.json?.usage?.completion_tokens,
        latencyMs: r.latencyMs,
        finishReason: choice?.finish_reason,
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
      };
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
