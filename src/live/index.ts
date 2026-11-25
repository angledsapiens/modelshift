import type { Assessment, Family, Host } from "../types.js";
import { bedrockAuth } from "../providers/aws.js";

/**
 * Live check: ask each provider which models it serves right now, and flag ids the
 * repo uses that are no longer listed (or carry a deprecation/expiry field).
 * This catches silent removals on inference hosts (e.g. DeepInfra publishes no
 * deprecation page and its /models objects have no deprecation field).
 */

export type ProviderName = Host | "openai" | "anthropic" | "google" | "mistral" | "bedrock";

interface ProviderDef {
  name: ProviderName;
  url: string;
  keyEnv: string[];
  keyRequired: boolean;
  headers?: (key: string) => Record<string, string>;
  /** Strip provider-specific prefixes so ids compare with repo ids. */
  normalize?: (id: string) => string;
  /** Builds the URL and auth headers itself (e.g. AWS signing); a string means "skip, because...". */
  request?: (env: NodeJS.ProcessEnv) => { url: string; headers: Record<string, string> } | string;
}

export const PROVIDERS: ProviderDef[] = [
  { name: "openai", url: "https://api.openai.com/v1/models", keyEnv: ["OPENAI_API_KEY"], keyRequired: true },
  {
    name: "anthropic",
    url: "https://api.anthropic.com/v1/models?limit=1000",
    keyEnv: ["ANTHROPIC_API_KEY"],
    keyRequired: true,
    headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }),
  },
  {
    name: "google",
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    keyRequired: true,
    headers: (k) => ({ "x-goog-api-key": k }),
    normalize: (id) => id.replace(/^models\//, ""),
  },
  { name: "mistral", url: "https://api.mistral.ai/v1/models", keyEnv: ["MISTRAL_API_KEY"], keyRequired: true },
  { name: "deepinfra", url: "https://api.deepinfra.com/v1/openai/models", keyEnv: ["DEEPINFRA_API_KEY", "DEEPINFRA_TOKEN"], keyRequired: false },
  { name: "together", url: "https://api.together.xyz/v1/models", keyEnv: ["TOGETHER_API_KEY"], keyRequired: true },
  { name: "fireworks", url: "https://api.fireworks.ai/inference/v1/models", keyEnv: ["FIREWORKS_API_KEY"], keyRequired: true },
  { name: "groq", url: "https://api.groq.com/openai/v1/models", keyEnv: ["GROQ_API_KEY"], keyRequired: true },
  { name: "openrouter", url: "https://openrouter.ai/api/v1/models", keyEnv: ["OPENROUTER_API_KEY"], keyRequired: false },
  {
    // ListFoundationModels: Bedrock marks models it is retiring as LEGACY.
    name: "bedrock",
    url: "https://bedrock.us-east-1.amazonaws.com/foundation-models",
    keyEnv: ["AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID"],
    keyRequired: true,
    request: (env) => {
      let auth;
      try {
        auth = bedrockAuth(env);
      } catch {
        return "set AWS_BEARER_TOKEN_BEDROCK or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (and AWS_REGION) to check live";
      }
      const url = `https://bedrock.${auth.region}.amazonaws.com/foundation-models`;
      return { url, headers: auth.headers("GET", url, "") };
    },
  },
];

/** Bedrock cross-region inference profiles ("us.", "eu.", "global."...) wrap a base model id. */
const BEDROCK_PROFILE = /^(us|eu|apac|global|jp|au|ca|us-gov)\./;

export interface LiveModel {
  id: string;
  deprecation?: string; // any deprecation / expiry signal the provider exposes
}

export interface ProviderResult {
  provider: ProviderName;
  ok: boolean;
  skipped?: string; // reason, e.g. missing key
  error?: string;
  models?: Map<string, LiveModel>;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const DEPRECATION_FIELDS = ["deprecation", "deprecation_date", "deprecated_at", "expiration_date", "expires_at", "sunset", "sunset_date", "retirement_date"];

function extractDeprecation(obj: Record<string, unknown>): string | undefined {
  for (const f of DEPRECATION_FIELDS) {
    const v = obj[f];
    if (v && (typeof v === "string" || typeof v === "number")) return String(v);
    if (v && typeof v === "object") {
      const inner = v as Record<string, unknown>;
      const d = inner.date ?? inner.deprecation_date ?? inner.retirement_date;
      if (d) return String(d);
    }
  }
  if (obj.deprecated === true) return "deprecated";
  const life = obj.modelLifecycle as Record<string, unknown> | undefined;
  if (life && life.status === "LEGACY") {
    const eol = life.endOfLifeTime ?? life.endOfLifeDate;
    return eol ? `LEGACY, end of life ${String(eol).slice(0, 10)}` : "LEGACY";
  }
  return undefined;
}

export function parseModelList(body: unknown, normalize?: (id: string) => string): Map<string, LiveModel> {
  const b = body as Record<string, unknown>;
  const arr = (Array.isArray(b?.data) ? b.data : Array.isArray(b?.models) ? b.models : Array.isArray(b?.modelSummaries) ? b.modelSummaries : Array.isArray(body) ? body : []) as Record<string, unknown>[];
  const map = new Map<string, LiveModel>();
  for (const m of arr) {
    const raw = (m.id ?? m.modelId ?? m.name) as string | undefined;
    if (!raw) continue;
    const id = (normalize ? normalize(raw) : raw).toLowerCase();
    map.set(id, { id, deprecation: extractDeprecation(m) });
  }
  return map;
}

export async function fetchProvider(def: ProviderDef, env: NodeJS.ProcessEnv, fetchFn: FetchLike): Promise<ProviderResult> {
  const key = def.keyEnv.map((k) => env[k]).find(Boolean);
  if (!key && def.keyRequired) return { provider: def.name, ok: false, skipped: `set ${def.keyEnv.join(" or ")} to check live` };
  let headers: Record<string, string> = key ? (def.headers ? def.headers(key) : { Authorization: `Bearer ${key}` }) : {};
  let first = def.url;
  if (def.request) {
    const r = def.request(env);
    if (typeof r === "string") return { provider: def.name, ok: false, skipped: r };
    ({ url: first, headers } = r);
  }
  try {
    const models = new Map<string, LiveModel>();
    let url: string | undefined = first;
    for (let page = 0; url && page < 20; page++) {
      const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return { provider: def.name, ok: false, error: `HTTP ${res.status}` };
      const body = (await res.json()) as Record<string, unknown>;
      for (const [k, v] of parseModelList(body, def.normalize)) models.set(k, v);
      url = undefined;
      if (def.name === "google" && typeof body.nextPageToken === "string") url = `${def.url}&pageToken=${encodeURIComponent(body.nextPageToken)}`;
      if (def.name === "anthropic" && body.has_more && typeof body.last_id === "string") url = `${def.url}&after_id=${encodeURIComponent(body.last_id)}`;
    }
    return { provider: def.name, ok: true, models };
  } catch (e) {
    return { provider: def.name, ok: false, error: (e as Error).message };
  }
}

/** Which providers can tell us whether this id is still served. */
export function providersFor(a: Assessment, repoHosts: Host[] = []): ProviderName[] {
  const byFamily: Partial<Record<Family, ProviderName>> = { openai: "openai", anthropic: "anthropic", google: "google", mistral: "mistral", bedrock: "bedrock" };
  const hosts = a.hosts.length ? a.hosts : repoHosts;
  // Only "<vendor>/<model>" ids are gateway ids; "models/gemini-x" is Google's own path format.
  const viaGateway = a.locations.some((l) => /^(openai|anthropic|google|mistralai|deepseek|x-ai|cohere)\//i.test(l.rawId));
  const list: ProviderName[] = [];
  const first = byFamily[a.family];
  if (first && !viaGateway) list.push(first);
  if (a.family === "open-weight") {
    // Open-weight ids are only checkable when we know which host serves them;
    // id formats differ between hosts, so we never guess.
    list.push(...hosts);
  } else if (viaGateway) {
    // "openai/gpt-4o" style ids are gateway (OpenRouter-style) ids.
    list.push(...(hosts.length ? hosts : ["openrouter" as Host]));
  }
  return [...new Set(list)];
}

function liveKey(a: Assessment): string[] {
  // Hosts list org/model ids; compare both the full raw id and the normalized id.
  const raws = a.locations.map((l) => l.rawId.toLowerCase());
  const keys = [a.id, ...raws];
  if (a.family === "bedrock") {
    // Compare the base model of an inference profile, with and without the ":0" version suffix.
    for (const k of [...keys]) {
      const base = k.replace(BEDROCK_PROFILE, "");
      keys.push(base, /:\d+$/.test(base) ? base : `${base}:0`);
    }
  }
  return [...new Set(keys)];
}

export async function liveCheck(
  assessments: Assessment[],
  opts: { env?: NodeJS.ProcessEnv; fetchFn?: FetchLike; only?: ProviderName[]; repoHosts?: Host[]; probe?: boolean; probeFn?: ProbeFn } = {},
): Promise<{ assessments: Assessment[]; results: ProviderResult[] }> {
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const repoHosts = opts.repoHosts ?? [];
  const needed = new Set<ProviderName>();
  for (const a of assessments) for (const p of providersFor(a, repoHosts)) needed.add(p);
  const defs = PROVIDERS.filter((d) => needed.has(d.name) && (!opts.only || opts.only.includes(d.name)));
  const results = await Promise.all(defs.map((d) => fetchProvider(d, env, fetchFn)));
  const byName = new Map(results.map((r) => [r.provider, r]));

  const probeTargets: { a: Assessment; p: ProviderName; prev: Assessment["status"]; prevNote?: string }[] = [];
  for (const a of assessments) {
    if (a.status === "retired") continue; // already known dead
    for (const p of providersFor(a, repoHosts)) {
      const r = byName.get(p);
      if (!r?.ok || !r.models) continue;
      const hit = liveKey(a).map((k) => r.models!.get(k)).find(Boolean);
      if (!hit) {
        probeTargets.push({ a, p, prev: a.status, prevNote: a.note });
        a.status = "unlisted";
        a.note = `Not in ${p}'s public model list today. The host may have removed it, or may silently serve a different model under this name — run with --probe to find out.${a.note ? " " + a.note : ""}`;
        break;
      }
      if (hit.deprecation && a.status !== "retiring") {
        a.status = "flagged";
        a.note = `${p} marks this model deprecated/expiring: ${hit.deprecation}.`;
      }
    }
  }

  if (opts.probe) {
    for (const t of probeTargets) {
      const res = await probeModel(t.p, t.a.locations[0].rawId, env, opts.probeFn);
      if (res.skipped) {
        t.a.note = `${t.a.note} (probe skipped: ${res.skipped})`;
      } else if (res.notFound) {
        t.a.status = "missing";
        t.a.note = `${t.p} returned model-not-found: calls with this id are failing.`;
      } else if (res.served && !sameModel(res.served, t.a.locations[0].rawId)) {
        t.a.status = "redirected";
        t.a.servedAs = res.served;
        t.a.note = `${t.p} silently serves "${res.served}" when you ask for this model. Your app is not running the model it names: behaviour, quality and cost may have changed without notice.`;
      } else if (res.served) {
        t.a.status = t.prev;
        t.a.note = `Not in ${t.p}'s public list, but still served as itself (probe).${t.prevNote ? " " + t.prevNote : ""}`;
      } else if (res.error) {
        t.a.note = `${t.a.note} (probe failed: ${res.error})`;
      }
    }
  }
  return { assessments, results };
}

/* ------------------------------------------------------------------ probe */

export interface ProbeResult {
  served?: string;
  notFound?: boolean;
  skipped?: string;
  error?: string;
}

export type ProbeFn = (provider: ProviderName, model: string, env: NodeJS.ProcessEnv) => Promise<ProbeResult>;

function sameModel(served: string, requested: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/^models\//, "");
  return n(served) === n(requested);
}

/** One 1-token request; reads the "model" the provider reports serving. Costs a fraction of a cent. */
async function probeModel(provider: ProviderName, model: string, env: NodeJS.ProcessEnv, probeFn?: ProbeFn): Promise<ProbeResult> {
  if (probeFn) return probeFn(provider, model, env);
  const { createProvider } = await import("../providers/index.js");
  let chat;
  try {
    chat = createProvider(`${provider}:${model}`, { env, timeoutMs: 30_000 });
  } catch (e) {
    return { skipped: (e as Error).message };
  }
  const r = await chat.chat({ messages: [{ role: "user", content: "Reply with: OK" }], max_tokens: 1, temperature: 0 });
  if (r.error) return /\b404\b|does not exist|not[ _-]found|model identifier is invalid|end of (its )?life/i.test(r.error) ? { notFound: true } : { error: r.error };
  return { served: r.servedModel ?? model };
}
