import type { Message, ToolDef } from "./providers/index.js";

/**
 * A Sample is one replayable request. `reference` is the output that was logged
 * in production (optional; the noise floor comes from re-running the baseline).
 */
export interface Sample {
  id: string;
  messages: Message[];
  tools?: ToolDef[];
  temperature?: number;
  max_tokens?: number;
  json?: boolean;
  reference?: string;
  /** Per-sample assertions. Patterns are regexes, case-insensitive by default; write "/pattern/flags" to set flags (e.g. "/Total/" is case-sensitive). */
  expect?: Expect;
}

export interface Expect {
  /** Patterns the output must match. */
  match?: string[];
  /** Patterns the output must not match. */
  notMatch?: string[];
  /** Output must be valid JSON (```json fences allowed). */
  json?: boolean;
  /** Output must contain a JSON object or array somewhere. */
  containsJson?: boolean;
}

/** Accepted line shapes:
 *  1. OpenAI-style log:   { request: { messages, tools?, temperature?, response_format? }, response: { choices: [{ message }] } }
 *  2. Bare request body:  { messages: [...], tools?, ... , output? }
 *  3. Langfuse-style:     { input: [...messages] | "prompt", output: "..." | { content } }
 *  4. Simple prompt:      { prompt: "...", system?: "...", output?: "..." }
 */
export function toSample(obj: any, n: number): Sample | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const req = obj.request ?? obj.body ?? obj;
  let messages: Message[] | undefined;
  if (Array.isArray(req.messages)) messages = req.messages;
  else if (Array.isArray(obj.input)) messages = obj.input;
  else if (typeof obj.input === "string") messages = [{ role: "user", content: obj.input }];
  else if (obj.input && Array.isArray(obj.input.messages)) messages = obj.input.messages;
  else if (typeof obj.prompt === "string") messages = [...(obj.system ? [{ role: "system" as const, content: obj.system }] : []), { role: "user", content: obj.prompt }];
  if (!messages?.length) return undefined;

  const norm = messages
    .filter((m: any) => m && typeof m.role === "string")
    .map((m: any) => ({ role: m.role, content: contentToText(m.content), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}), ...(m.name ? { name: m.name } : {}) })) as Message[];
  if (!norm.length) return undefined;

  const respMsg = obj.response?.choices?.[0]?.message;
  const reference = respMsg ? contentToText(respMsg.content) : typeof obj.output === "string" ? obj.output : obj.output?.content !== undefined ? contentToText(obj.output.content) : undefined;

  const s: Sample = { id: String(obj.id ?? `s${n}`), messages: norm };
  if (Array.isArray(req.tools) && req.tools.length) s.tools = req.tools;
  if (typeof req.temperature === "number") s.temperature = req.temperature;
  const mt = req.max_tokens ?? req.max_completion_tokens;
  if (typeof mt === "number") s.max_tokens = mt;
  if (req.response_format?.type === "json_object" || req.response_format?.type === "json_schema") s.json = true;
  if (reference) s.reference = reference;
  if (obj.expect) s.expect = obj.expect;
  return s;
}

function contentToText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("");
  if (c == null) return "";
  return JSON.stringify(c);
}

/** Best-effort PII / secret redaction. Not a guarantee: review samples before sharing them. */
const REDACTIONS: [RegExp, string][] = [
  [/\b(sk|pk|rk)-[A-Za-z0-9_\-]{16,}\b/g, "[REDACTED_KEY]"],
  [/\bBearer\s+[A-Za-z0-9._\-]{16,}/g, "Bearer [REDACTED_KEY]"],
  [/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]"],
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, "[REDACTED_IBAN]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[REDACTED_NUMBER]"],
  [/\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi, "[REDACTED_NINO]"],
  [/(?:\+44\s?7\d{3}|\(?07\d{3}\)?)\s?\d{3}\s?\d{3}\b/g, "[REDACTED_PHONE]"],
  [/\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g, "[REDACTED_PHONE]"],
];

export function redact(text: string): string {
  let t = text;
  for (const [re, rep] of REDACTIONS) t = t.replace(re, rep);
  return t;
}

export function redactSample(s: Sample): Sample {
  return {
    ...s,
    messages: s.messages.map((m) => ({ ...m, content: redact(m.content) })),
    ...(s.reference ? { reference: redact(s.reference) } : {}),
  };
}

export interface CaptureResult {
  samples: Sample[];
  skipped: number;
}

/** Parse JSONL (or a JSON array) of logged requests into samples. */
export function captureFromText(text: string, opts: { redact?: boolean; limit?: number } = {}): CaptureResult {
  const doRedact = opts.redact ?? true;
  const items: unknown[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) items.push(...JSON.parse(trimmed));
  else for (const line of trimmed.split(/\r?\n/)) if (line.trim()) {
    try {
      items.push(JSON.parse(line));
    } catch {
      items.push(undefined);
    }
  }
  const samples: Sample[] = [];
  let skipped = 0;
  items.forEach((it, i) => {
    const s = toSample(it, i + 1);
    if (!s) {
      skipped++;
      return;
    }
    samples.push(doRedact ? redactSample(s) : s);
  });
  const limited = opts.limit ? sampleEvenly(samples, opts.limit) : samples;
  return { samples: limited, skipped };
}

/** Deterministic spread across the log (not just the first N), so the test set covers different traffic. */
export function sampleEvenly<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
}

export function samplesToJsonl(samples: Sample[]): string {
  return samples.map((s) => JSON.stringify(s)).join("\n") + "\n";
}

export function parseSamplesJsonl(text: string): Sample[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l, i) => {
      const s = JSON.parse(l) as Sample;
      if (!Array.isArray(s.messages)) throw new Error(`samples line ${i + 1}: missing "messages"`);
      return { ...s, id: s.id ?? `s${i + 1}` };
    });
}
