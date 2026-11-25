import type { ChatResponse } from "../providers/index.js";
import type { Expect } from "../capture.js";

/** Strip ```json fences that many models add around JSON. */
export function extractJson(text: string): unknown | undefined {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!t || (t[0] !== "{" && t[0] !== "[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export function isJson(text: string): boolean {
  return extractJson(text) !== undefined;
}

export function topLevelKeys(text: string): string | undefined {
  const v = extractJson(text);
  if (!v || typeof v !== "object" || Array.isArray(v)) return Array.isArray(v) ? "[array]" : undefined;
  return Object.keys(v as object).sort().join(",");
}

const REFUSAL = /\b(i can(?:'|’)?t (?:help|assist|provide|comply)|i(?:'m| am) (?:not able|unable) to|i won(?:'|’)?t be able to|as an ai(?: language model)?|i must decline|i cannot (?:help|assist|provide|comply))\b/i;

export function isRefusal(text: string): boolean {
  return REFUSAL.test(text.slice(0, 400));
}

export function toolSignature(r: ChatResponse): string {
  return r.toolCalls.map((t) => t.name).sort().join(",");
}

/** Comparable representation of an output: tool calls (name + parsed args) or text. */
export function outputRepr(r: ChatResponse): string {
  if (r.toolCalls.length) {
    return r.toolCalls
      .map((t) => {
        let args = t.arguments;
        try {
          args = JSON.stringify(JSON.parse(t.arguments));
        } catch {
          /* keep raw */
        }
        return `${t.name}(${args})`;
      })
      .join(" ");
  }
  return r.text;
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

/** Jaccard similarity of word sets: cheap, model-free, language-agnostic. */
export function similarity(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function mode<T>(xs: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: T | undefined;
  let n = 0;
  for (const [k, v] of counts) if (v > n) {
    best = k;
    n = v;
  }
  return best;
}

export function hasAssertions(expect?: Expect): boolean {
  return !!(expect && (expect.match?.length || expect.notMatch?.length || expect.json || expect.containsJson));
}

/** "/pattern/flags" sets flags explicitly; a bare pattern is case-insensitive. */
export function toRegExp(p: string): RegExp {
  const m = /^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(p);
  return m && m[1] ? new RegExp(m[1], m[2].replace(/g/g, "")) : new RegExp(p, "i");
}

/** A JSON object or array anywhere in the text. */
export function containsJson(text: string): boolean {
  if (isJson(text)) return true;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced && isJson(fenced[1])) return true;
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const a = text.indexOf(open);
    const b = text.lastIndexOf(close);
    if (a >= 0 && b > a && isJson(text.slice(a, b + 1))) return true;
  }
  return false;
}

/** `structured`: the output is tool calls, which count as JSON (as in Promptfoo). */
export function assertionsPass(text: string, expect?: Expect, opts: { structured?: boolean } = {}): boolean | undefined {
  if (!expect || !hasAssertions(expect)) return undefined;
  if (expect.json && !opts.structured && !isJson(text)) return false;
  if (expect.containsJson && !opts.structured && !containsJson(text)) return false;
  return (expect.match ?? []).every((p) => toRegExp(p).test(text)) && !(expect.notMatch ?? []).some((p) => toRegExp(p).test(text));
}
