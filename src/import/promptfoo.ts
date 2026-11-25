import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Expect, Sample } from "../capture.js";
import type { Message, ToolDef } from "../providers/index.js";
import { parseYaml } from "./yaml.js";

/**
 * Turn a Promptfoo config (prompts × tests, with assertions) into modelshift samples, so teams
 * that already have Promptfoo tests can run a migration check without writing new ones.
 *
 * Each (prompt, test) pair becomes one sample. Deterministic assertions become the sample's
 * expected-output rules; model-graded and code assertions can't be translated and are reported.
 */

export interface PromptfooImport {
  samples: Sample[];
  /** modelshift specs for the config's providers, where they map. */
  providers: { promptfoo: string; spec?: string }[];
  /** Assertion types that were translated, with counts. */
  mapped: Record<string, number>;
  /** Assertion types that couldn't be translated, with counts and a hint. */
  skipped: Record<string, { count: number; hint: string }>;
  warnings: string[];
}

const TEXT_EXT = new Set([".txt", ".md", ".j2", ".njk", ".nunjucks", ".tmpl", ".prompt", ""]);
const MAX_SAMPLES = 5000;

/* ------------------------------------------------------------------ loading */

function loadStructured(file: string): unknown {
  const text = readFileSync(file, "utf8");
  const ext = extname(file).toLowerCase();
  if (ext === ".json") return JSON.parse(text);
  if (ext === ".jsonl") return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  if (ext === ".yaml" || ext === ".yml") return parseYaml(text);
  if (ext === ".csv") return parseCsv(text);
  throw new Error(`can't read ${file}: expected .json, .jsonl, .yaml or .csv`);
}

/** Expand "file://path" (with simple * globs in the file name) relative to the config folder. */
function expandPaths(ref: string, base: string): string[] {
  const p = ref.replace(/^file:\/\//, "");
  const full = resolve(base, p);
  if (!/[*?]/.test(basename(full))) return [full];
  const dir = dirname(full);
  if (/[*?]/.test(dir)) throw new Error(`globs in folder names aren't supported: ${ref}`);
  const re = new RegExp("^" + basename(full).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  return existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f)) : [];
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  const [header, ...body] = nonEmpty;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

/* ------------------------------------------------------------------ templating */

function getPath(vars: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), vars);
}

const stringify = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Nunjucks subset: {{ var }}, {{ a.b }}, filters dump / trim / upper / lower / safe / default("x"). */
export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{-?\s*([\s\S]*?)\s*-?\}\}/g, (whole, expr: string) => {
    const [head, ...filters] = expr.split("|").map((x) => x.trim());
    if (!/^[A-Za-z_][\w.]*$/.test(head)) return whole;
    let v = getPath(vars, head);
    for (const f of filters) {
      const def = /^default\((['"])(.*)\1\)$/.exec(f);
      if (def) v = v === undefined || v === null || v === "" ? def[2] : v;
      else if (f === "dump" || f === "tojson") v = JSON.stringify(v);
      else if (f === "trim") v = stringify(v).trim();
      else if (f === "upper") v = stringify(v).toUpperCase();
      else if (f === "lower") v = stringify(v).toLowerCase();
      else if (f === "safe" || f === "string") v = stringify(v);
      else return whole;
    }
    return stringify(v);
  });
}

const hasTags = (s: string) => /\{%|\{#/.test(s);

/* ------------------------------------------------------------------ prompts */

interface Prompt {
  label: string;
  /** Either raw text (one user message) or chat messages; strings inside are templates. */
  raw?: string;
  chat?: Message[];
}

function toChat(v: unknown): Message[] | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  if (!v.every((m) => m && typeof m === "object" && typeof (m as any).role === "string")) return undefined;
  return v.map((m: any) => ({ role: m.role, content: typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p?.text ?? "").join("") : JSON.stringify(m.content ?? "") }));
}

function promptFromText(text: string, label: string): Prompt {
  const t = text.trim();
  if (t.startsWith("[")) {
    try {
      const chat = toChat(JSON.parse(t));
      if (chat) return { label, chat };
    } catch {
      /* a template that isn't valid JSON until rendered: try after rendering */
    }
  }
  return { label, raw: text };
}

function loadPrompts(cfg: any, base: string, warn: (s: string) => void): Prompt[] {
  let list: unknown[] = [];
  const p = cfg.prompts;
  if (typeof p === "string") list = [p];
  else if (Array.isArray(p)) list = p;
  else if (p && typeof p === "object") list = Object.entries(p).map(([k, v]) => ({ id: k, label: v }));
  const out: Prompt[] = [];
  list.forEach((item, i) => {
    let ref: string | undefined;
    let label = `prompt${i + 1}`;
    let raw: string | undefined;
    if (typeof item === "string") ref = item;
    else if (item && typeof item === "object") {
      const o = item as any;
      if (typeof o.label === "string") label = o.label;
      if (typeof o.raw === "string") raw = o.raw;
      else if (typeof o.id === "string") ref = o.id;
      else if (Array.isArray(o.content) || Array.isArray(o)) raw = JSON.stringify(o.content ?? o);
    }
    if (raw !== undefined) return void out.push(promptFromText(raw, label));
    if (!ref) return warn(`prompt ${i + 1}: not understood, skipped`);
    const isFile = ref.startsWith("file://") || (!/\s/.test(ref) && /\.(txt|md|json|ya?ml|j2|njk|prompt)$/i.test(ref) && existsSync(resolve(base, ref)));
    if (!isFile) return void out.push(promptFromText(ref, label));
    const [pathPart, fn] = ref.split(/:(?=[A-Za-z_]\w*$)/);
    const files = expandPaths(pathPart, base);
    if (!files.length) return warn(`prompt ${ref}: no file found, skipped`);
    for (const f of files) {
      const ext = extname(f).toLowerCase();
      const name = typeof item === "string" ? basename(f) : label;
      if ([".js", ".mjs", ".cjs", ".ts", ".py"].includes(ext) || fn) {
        warn(`prompt ${basename(f)}: prompt functions (JS/Python) can't be imported; skipped. Export the rendered prompts to JSONL and use "modelshift capture" instead.`);
        continue;
      }
      if (!existsSync(f)) {
        warn(`prompt ${ref}: ${f} not found, skipped`);
        continue;
      }
      if (ext === ".json" || ext === ".yaml" || ext === ".yml" || ext === ".jsonl") {
        const v = loadStructured(f);
        const chat = toChat(v);
        if (chat) out.push({ label: name, chat });
        else if (ext === ".jsonl" && Array.isArray(v)) v.forEach((x, k) => { const c = toChat(x); if (c) out.push({ label: `${name}#${k + 1}`, chat: c }); });
        else warn(`prompt ${basename(f)}: expected a list of {role, content} messages, skipped`);
        continue;
      }
      if (!TEXT_EXT.has(ext)) {
        warn(`prompt ${basename(f)}: unsupported file type, skipped`);
        continue;
      }
      // Promptfoo splits text prompt files on lines of "---".
      const parts = readFileSync(f, "utf8").split(/^-{3,}\s*$/m).map((x) => x.trim()).filter(Boolean);
      parts.forEach((part, k) => out.push(promptFromText(part, parts.length > 1 ? `${name}#${k + 1}` : name)));
    }
  });
  return out;
}

function renderPrompt(p: Prompt, vars: Record<string, unknown>): Message[] | undefined {
  if (p.chat) return p.chat.map((m) => ({ ...m, content: render(m.content, vars) }));
  const text = render(p.raw!, vars);
  const t = text.trim();
  if (t.startsWith("[")) {
    try {
      const chat = toChat(JSON.parse(t));
      if (chat) return chat;
    } catch {
      /* plain text that starts with [ */
    }
  }
  return [{ role: "user", content: text }];
}

/* ------------------------------------------------------------------ tests and vars */

interface Test {
  description?: string;
  vars: Record<string, unknown>;
  assert: any[];
  transform?: boolean;
}

function loadVarValue(v: unknown, base: string): unknown {
  if (typeof v !== "string" || !v.startsWith("file://")) return v;
  const f = resolve(base, v.slice(7));
  if (!existsSync(f)) throw new Error(`var file not found: ${v}`);
  const ext = extname(f).toLowerCase();
  if ([".json", ".yaml", ".yml"].includes(ext)) return loadStructured(f);
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".mp3", ".wav"].includes(ext)) throw new Error(`binary var files (${basename(f)}) aren't supported`);
  return readFileSync(f, "utf8");
}

/** A CSV row: __expected / __expected1.. columns hold assertions, __description the name. */
function testFromCsvRow(row: Record<string, string>): any {
  const vars: Record<string, string> = {};
  const assert: any[] = [];
  let description: string | undefined;
  for (const [k, v] of Object.entries(row)) {
    if (/^__expected\d*$/.test(k)) {
      if (v.trim()) assert.push(csvAssertion(v.trim()));
    } else if (k === "__description") description = v;
    else if (!k.startsWith("__")) vars[k] = v;
  }
  return { description, vars, assert };
}

/** "contains: foo", "not-icontains: bar", "regex: x+", "is-json", "grade: ...", "fn: ...", or a plain value (equals). */
function csvAssertion(v: string): any {
  if (v.startsWith("fn:") || v.startsWith("javascript:")) return { type: "javascript", value: v.replace(/^(fn|javascript):\s*/, "") };
  if (v.startsWith("python:")) return { type: "python", value: v.slice(7).trim() };
  if (v.startsWith("grade:") || v.startsWith("llm-rubric:")) return { type: "llm-rubric", value: v.replace(/^(grade|llm-rubric):\s*/, "") };
  if (v.startsWith("similar")) return { type: "similar", value: v.replace(/^similar(\(\s*[\d.]+\s*\))?:\s*/, "") };
  const m = /^(not-)?([a-z][a-z-]*?)(?:\((\s*[\d.]+\s*)\))?:\s*([\s\S]*)$/.exec(v);
  if (m && KNOWN.has(m[2])) return { type: `${m[1] ?? ""}${m[2]}`, value: m[4] };
  if (/^(not-)?is-json$/.test(v) || /^(not-)?contains-json$/.test(v)) return { type: v };
  return { type: "equals", value: v };
}

const KNOWN = new Set(["equals", "contains", "icontains", "contains-any", "icontains-any", "contains-all", "icontains-all", "starts-with", "regex", "is-json", "contains-json", "levenshtein", "rouge-n", "bleu", "similar", "llm-rubric", "javascript", "python", "webhook", "cost", "latency"]);

const REMOTE = /^(https?|huggingface|hf|s3|gs|gcs|azure|sharepoint|sheets):\/\//i;
const CODE = /\.(m?js|cjs|ts|py)(:[\w.]+)?$/i;

function loadTests(cfg: any, base: string, warn: (s: string) => void): any[] {
  const t = cfg.tests;
  const items: any[] = [];
  const fromFile = (ref: string) => {
    if (REMOTE.test(ref) || /docs\.google\.com/.test(ref)) return warn(`tests from ${ref} are fetched when Promptfoo runs; export them to a CSV/JSONL file and point "tests" at it to import`);
    if (CODE.test(ref)) return warn(`tests from ${ref.replace(/^file:\/\//, "")} are generated by code; run Promptfoo once and export the test cases to CSV/JSONL to import them`);
    const files = expandPaths(ref.replace(/:[\w.]+$/, (m) => (/\.(ya?ml|json|jsonl|csv)$/i.test(ref.slice(0, -m.length)) ? "" : m)), base);
    if (!files.length || files.some((f) => !existsSync(f))) return warn(`tests file ${ref} not found`);
    for (const f of files) {
      const v = loadStructured(f);
      const list = Array.isArray(v) ? v : [v];
      for (const x of list) items.push(extname(f).toLowerCase() === ".csv" ? testFromCsvRow(x as Record<string, string>) : x);
    }
  };
  if (t === undefined || t === null) items.push({});
  else if (typeof t === "string") fromFile(t);
  else if (Array.isArray(t)) for (const x of t) typeof x === "string" ? fromFile(x) : items.push(x);
  else if (typeof t === "object" && typeof t.path === "string") fromFile(t.path);
  return items;
}

/** Array-valued vars expand into one test per combination (as Promptfoo does). */
function expandVars(vars: Record<string, unknown>): Record<string, unknown>[] {
  let combos: Record<string, unknown>[] = [{}];
  for (const [k, v] of Object.entries(vars)) {
    const values = Array.isArray(v) ? v : [v];
    combos = combos.flatMap((c) => values.map((x) => ({ ...c, [k]: x })));
    if (combos.length > MAX_SAMPLES) throw new Error(`var combinations exceed ${MAX_SAMPLES}`);
  }
  return combos;
}

/* ------------------------------------------------------------------ assertions */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const exact = (re: string) => `/${re}/`; // case-sensitive
const ci = (re: string) => `/${re}/i`;

const HINTS: Record<string, string> = {
  "llm-rubric": "use --judge (compares each answer with the old model's, rather than a rubric)",
  "model-graded-closedqa": "use --judge",
  "model-graded-factuality": "use --judge",
  factuality: "use --judge",
  "g-eval": "use --judge",
  similar: "use --judge, or the built-in behaviour-drift check",
  "answer-relevance": "use --judge",
  "select-best": "not applicable: modelshift compares old vs new model directly",
  javascript: "code assertions can't run; rewrite as a regex in expect.match if possible",
  python: "code assertions can't run; rewrite as a regex in expect.match if possible",
  webhook: "not supported",
  cost: "covered: the report compares cost when you pass --prices",
  latency: "covered: the report compares latency",
  "is-refusal": "covered by the built-in refusals check",
  "is-valid-openai-tools-call": "covered by the built-in tool-calls check",
  "is-valid-openai-function-call": "covered by the built-in tool-calls check",
  "is-valid-function-call": "covered by the built-in tool-calls check",
  moderation: "not supported",
  levenshtein: "not supported; the behaviour-drift check measures text change",
  "rouge-n": "not supported; the behaviour-drift check measures text change",
  bleu: "not supported; the behaviour-drift check measures text change",
};

const TRANSFORM_HINT = "checks a transformed output (e.g. one field); modelshift checks the raw output, so this isn't translated";

function addAssertion(a: any, vars: Record<string, unknown>, expect: Expect, mapped: Record<string, number>, skip: (type: string, hint?: string) => void, transformed = false): void {
  if (!a || typeof a !== "object") return;
  if (a.type === "assert-set" && Array.isArray(a.assert)) {
    for (const x of a.assert) addAssertion(x, vars, expect, mapped, skip, transformed || !!a.transform);
    return;
  }
  const type = String(a.type ?? "");
  // Deterministic checks on a transformed output would fail on the raw one: a false regression.
  if ((transformed || a.transform) && !HINTS[type.replace(/^not-/, "")]) return skip(`${type} (transformed output)`, TRANSFORM_HINT);
  const neg = type.startsWith("not-");
  const base = neg ? type.slice(4) : type;
  const valueOf = (v: unknown): unknown => (typeof v === "string" ? render(v, vars) : v);
  const value = valueOf(a.value);
  const values = (Array.isArray(value) ? value : typeof value === "string" ? value.split(",").map((x) => x.trim()) : []).map((x) => String(valueOf(x)));
  const must = (re: string) => (expect.match ??= []).push(re);
  const mustNot = (re: string) => (expect.notMatch ??= []).push(re);
  const ok = () => void (mapped[type] = (mapped[type] ?? 0) + 1);
  if (typeof value === "string" && value.startsWith("file://")) return skip(type, "assertion values loaded from files aren't supported");
  switch (base) {
    case "equals":
      if (typeof value === "object" && value !== null) return skip(type, "equals with an object value isn't supported");
      (neg ? mustNot : must)(exact(`^\\s*${esc(String(value ?? ""))}\\s*$`));
      return ok();
    case "contains":
    case "icontains": {
      const re = esc(String(value ?? ""));
      (neg ? mustNot : must)(base === "contains" ? exact(re) : ci(re));
      return ok();
    }
    case "starts-with": {
      const re = `^\\s*${esc(String(value ?? ""))}`;
      (neg ? mustNot : must)(exact(re));
      return ok();
    }
    case "regex": {
      const re = String(value ?? "");
      try {
        new RegExp(re);
      } catch {
        return skip(type, "invalid regex");
      }
      (neg ? mustNot : must)(exact(re));
      return ok();
    }
    case "contains-any":
    case "icontains-any": {
      if (!values.length) return skip(type, "no values");
      const re = values.map(esc).join("|");
      const wrap = base === "contains-any" ? exact : ci;
      if (neg) values.forEach((v) => mustNot(wrap(esc(v)))); // none of them
      else must(wrap(`(?:${re})`));
      return ok();
    }
    case "contains-all":
    case "icontains-all": {
      if (!values.length) return skip(type, "no values");
      const wrap = base === "contains-all" ? exact : ci;
      if (neg) return skip(type, "\"not all of\" can't be expressed as patterns");
      values.forEach((v) => must(wrap(esc(v))));
      return ok();
    }
    case "is-json":
      if (neg) return skip(type, "not-is-json isn't supported");
      expect.json = true;
      if (value !== undefined && value !== null) mapped["is-json (schema not checked)"] = (mapped["is-json (schema not checked)"] ?? 0) + 1;
      else ok();
      return;
    case "contains-json":
      if (neg) return skip(type, "not-contains-json isn't supported");
      expect.containsJson = true;
      return ok();
    default:
      return skip(type, HINTS[base] ?? HINTS[type]);
  }
}

/* ------------------------------------------------------------------ providers */

/** Promptfoo provider id → modelshift spec, where an adapter exists. */
export function mapProvider(id: string): string | undefined {
  const parts = id.split(":");
  const [p] = parts;
  const rest = (n: number) => parts.slice(n).join(":");
  switch (p) {
    case "openai":
      return parts.length > 2 && ["chat", "responses", "completion"].includes(parts[1]) ? `openai:${rest(2)}` : `openai:${rest(1)}`;
    case "anthropic":
      return parts[1] === "messages" || parts[1] === "completion" ? `anthropic:${rest(2)}` : `anthropic:${rest(1)}`;
    case "azure":
    case "azureopenai":
      return parts.length > 2 && ["chat", "completion", "responses"].includes(parts[1]) ? `azure:${rest(2)}` : `azure:${rest(1)}`;
    case "google":
    case "vertex":
      return `google:${rest(1).replace(/^models\//, "")}`;
    case "mistral":
      return `mistral:${parts[1] === "chat" ? rest(2) : rest(1)}`;
    case "groq":
    case "fireworks":
    case "openrouter":
    case "deepinfra":
      return `${p}:${rest(1)}`;
    case "togetherai":
    case "together":
      return `together:${parts[1] === "chat" ? rest(2) : rest(1)}`;
    default:
      return undefined;
  }
}

function loadProviders(cfg: any, base: string, warn: (s: string) => void): { id: string; config?: any }[] {
  const p = cfg.providers ?? cfg.targets;
  const raw = typeof p === "string" ? [p] : Array.isArray(p) ? p : p && typeof p === "object" ? Object.entries(p).map(([id, config]) => ({ id, config })) : [];
  const list: unknown[] = [];
  for (const x of raw) {
    // Provider definitions kept in their own YAML/JSON file.
    if (typeof x === "string" && x.startsWith("file://") && /\.(ya?ml|json)$/i.test(x)) {
      const f = resolve(base, x.slice(7));
      if (!existsSync(f)) {
        warn(`provider file ${x} not found`);
        continue;
      }
      const v = loadStructured(f);
      list.push(...(Array.isArray(v) ? v : [v]));
    } else list.push(x);
  }
  return list
    .map((x: any) => (typeof x === "string" ? { id: x } : x && typeof x === "object" ? { id: String(x.id ?? Object.keys(x)[0] ?? ""), config: x.config ?? (x.id ? undefined : Object.values(x)[0]) } : undefined))
    .filter((x): x is { id: string; config?: any } => !!x && !!x.id);
}

/** OpenAI-style function tools from a provider config (inline or file://), converting Anthropic-style ones. */
function toolsFrom(v: unknown, base: string, warn: (s: string) => void): ToolDef[] | undefined {
  let list = v;
  if (typeof v === "string" && v.startsWith("file://")) {
    const f = resolve(base, v.slice(7));
    if (CODE.test(f) || !existsSync(f)) {
      warn(`tools from ${v} can't be loaded; samples are imported without tools`);
      return undefined;
    }
    list = loadStructured(f);
  }
  if (!Array.isArray(list)) return undefined;
  const out: ToolDef[] = [];
  for (const t of list as any[]) {
    if (t?.type === "function" && t.function?.name) out.push({ type: "function", function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters } });
    else if (t?.name && (t.input_schema || t.parameters)) out.push({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema ?? t.parameters } });
  }
  if (out.length < (list as unknown[]).length) warn(`${(list as unknown[]).length - out.length} provider tools aren't function tools (e.g. built-in search) and were left out`);
  return out.length ? out : undefined;
}

/* ------------------------------------------------------------------ main */

export function importPromptfoo(configPath: string): PromptfooImport {
  const file = resolve(configPath);
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`Promptfoo config not found: ${configPath}`);
  const base = dirname(file);
  const cfg = loadStructured(file) as any;
  if (!cfg || typeof cfg !== "object") throw new Error(`${configPath} is not a Promptfoo config`);
  const warnings: string[] = [];
  const warn = (s: string) => void warnings.push(s);
  const mapped: Record<string, number> = {};
  const skipped: PromptfooImport["skipped"] = {};
  const skip = (type: string, hint = "not supported") => {
    skipped[type] ??= { count: 0, hint };
    skipped[type].count++;
  };

  const prompts = loadPrompts(cfg, base, warn);
  if (!prompts.length) {
    const why = warnings.length ? ` (${warnings.join("; ")})` : cfg.redteam ? " (red-team configs generate their tests when Promptfoo runs)" : "";
    throw new Error(`no prompts that modelshift can replay${why}`);
  }
  const providers = loadProviders(cfg, base, warn).map((x) => ({ promptfoo: x.id, spec: mapProvider(x.id), config: x.config }));

  // Shared generation settings: only when every provider agrees (otherwise leave them to the run).
  const shared = (key: string): number | undefined => {
    const vals = providers.map((p) => p.config?.[key]).filter((v) => typeof v === "number");
    return vals.length === providers.length && vals.length && vals.every((v) => v === vals[0]) ? vals[0] : undefined;
  };
  const temperature = shared("temperature");
  const maxTokens = shared("max_tokens") ?? shared("max_completion_tokens") ?? shared("maxOutputTokens") ?? shared("max_output_tokens");
  // Tools and JSON mode come from the (first) provider that defines them: they are part of the request.
  const withTools = providers.find((p) => p.config?.tools);
  const tools = withTools ? toolsFrom(withTools.config.tools, base, warn) : undefined;
  const json = providers.some((p) => /^json/.test(String(p.config?.response_format?.type ?? p.config?.responseMimeType ?? "").replace("application/", "")));

  const def = cfg.defaultTest && typeof cfg.defaultTest === "object" ? cfg.defaultTest : {};
  const defTransform = !!(def.options?.transform || def.transform);
  const tests: Test[] = loadTests(cfg, base, warn).map((t: any) => ({
    description: t.description,
    vars: { ...(def.vars ?? {}), ...(t.vars ?? {}) },
    assert: [...(Array.isArray(def.assert) ? def.assert : []), ...(Array.isArray(t.assert) ? t.assert : [])],
    transform: defTransform || !!(t.options?.transform || t.transform),
  }));
  if (!tests.length) throw new Error(`no test cases that modelshift can read${warnings.length ? ` (${warnings.join("; ")})` : ""}`);

  const samples: Sample[] = [];
  let tagged = 0;
  tests.forEach((t, ti) => {
    let combos: Record<string, unknown>[];
    try {
      const loaded = Object.fromEntries(Object.entries(t.vars).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => loadVarValue(x, base)) : loadVarValue(v, base)]));
      combos = expandVars(loaded);
    } catch (e) {
      warn(`test ${ti + 1}: ${(e as Error).message}; skipped`);
      return;
    }
    combos.forEach((vars, ci2) => {
      prompts.forEach((p, pi) => {
        const templates = p.chat ? p.chat.map((m) => m.content) : [p.raw!];
        if (templates.some(hasTags)) {
          tagged++;
          return;
        }
        const messages = renderPrompt(p, vars);
        if (!messages) return;
        const expect: Expect = {};
        for (const a of t.assert) addAssertion(a, vars, expect, mapped, skip, t.transform);
        const slug = (t.description ? t.description.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) : `t${ti + 1}`) + (combos.length > 1 ? `-${ci2 + 1}` : "");
        const s: Sample = { id: prompts.length > 1 ? `${slug}-p${pi + 1}` : slug, messages };
        if (temperature !== undefined) s.temperature = temperature;
        if (maxTokens !== undefined) s.max_tokens = maxTokens;
        if (tools?.length) s.tools = tools;
        if (json) s.json = true;
        if (expect.match?.length || expect.notMatch?.length || expect.json || expect.containsJson) s.expect = expect;
        samples.push(s);
        if (samples.length > MAX_SAMPLES) throw new Error(`more than ${MAX_SAMPLES} samples; split the config`);
      });
    });
  });
  if (tagged) warn(`${tagged} prompt × test combinations use Nunjucks tags ({% %}), which modelshift doesn't evaluate; skipped`);

  // Unique ids (descriptions can repeat).
  const seen = new Map<string, number>();
  for (const s of samples) {
    const n = seen.get(s.id) ?? 0;
    seen.set(s.id, n + 1);
    if (n) s.id = `${s.id}-${n + 1}`;
  }
  return { samples, providers: providers.map(({ promptfoo, spec }) => ({ promptfoo, spec })), mapped, skipped, warnings };
}
