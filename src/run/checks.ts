import type { ChatResponse } from "../providers/index.js";

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

export function assertionsPass(text: string, expect?: { match?: string[]; notMatch?: string[] }): boolean | undefined {
  if (!expect || (!expect.match?.length && !expect.notMatch?.length)) return undefined;
  const ok = (expect.match ?? []).every((p) => new RegExp(p, "i").test(text)) && !(expect.notMatch ?? []).some((p) => new RegExp(p, "i").test(text));
  return ok;
}
