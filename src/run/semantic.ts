import { createHash } from "node:crypto";
import type { Embedder } from "../providers/index.js";
import type { ResponseCache } from "./cache.js";
import { outputRepr } from "./checks.js";
import type { SampleRun } from "./index.js";

/**
 * Optional meaning-based similarity (--embed provider:model): a cheaper, deterministic
 * alternative to the LLM judge for open-ended answers.
 *
 * Per sample it records
 *   self  = mean cosine similarity between the OLD model's own repeats (how much it varies), and
 *   cross = mean cosine similarity between each NEW answer and each OLD answer.
 * The check flags "review" when cross is reliably below self by more than 0.02: the new answers
 * mean something different from the old ones more than the old ones differ from each other.
 * It never makes the verdict "unsafe" on its own: embeddings are a fuzzy signal.
 */

export interface SemanticScores {
  self: number | null;
  cross: number | null;
  model: string;
}

export const SEMANTIC_MIN_EFFECT = 0.02;
const BATCH = 64;

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Unique texts across all runs that need a vector. */
export function textsToEmbed(runs: SampleRun[]): string[] {
  const set = new Set<string>();
  for (const r of runs) for (const x of [...r.baseline, ...r.candidate]) if (!x.error) set.add(outputRepr(x));
  return [...set];
}

export async function embedRuns(
  runs: SampleRun[],
  embedder: Embedder,
  opts: { cache?: ResponseCache; concurrency?: number; pool: <T>(tasks: (() => Promise<T>)[], c: number) => Promise<T[]>; onProgress?: (done: number, total: number) => void },
): Promise<{ embedded: number; failed: number; error?: string }> {
  const texts = textsToEmbed(runs);
  const keyOf = (t: string) => createHash("sha256").update(JSON.stringify(["embed", embedder.spec, t])).digest("hex");
  const vectors = new Map<string, number[]>();
  const todo: string[] = [];
  for (const t of texts) {
    const hit = opts.cache?.getValue<{ v: number[] }>(keyOf(t));
    if (hit?.v) vectors.set(t, hit.v);
    else todo.push(t);
  }
  let failed = 0;
  let lastError: string | undefined;
  const batches: string[][] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  let done = 0;
  await opts.pool(
    batches.map((b) => async () => {
      const r = await embedder.embed(b);
      opts.onProgress?.(++done, batches.length);
      if (!r.vectors) {
        failed += b.length;
        lastError = r.error;
        return;
      }
      b.forEach((t, i) => {
        vectors.set(t, r.vectors![i]);
        opts.cache?.putValue(keyOf(t), { v: r.vectors![i] });
      });
    }),
    opts.concurrency ?? 4,
  );

  for (const run of runs) {
    const B = run.baseline.filter((x) => !x.error).map((x) => vectors.get(outputRepr(x))).filter((v): v is number[] => !!v);
    const C = run.candidate.filter((x) => !x.error).map((x) => vectors.get(outputRepr(x))).filter((v): v is number[] => !!v);
    const self: number[] = [];
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) self.push(cosine(B[i], B[j]));
    const cross: number[] = [];
    for (const c of C) for (const b of B) cross.push(cosine(c, b));
    const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
    run.semantic = { self: avg(self), cross: avg(cross), model: embedder.spec };
  }
  return { embedded: texts.length - failed, failed, error: lastError };
}
