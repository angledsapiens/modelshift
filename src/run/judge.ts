import type { ChatProvider, Message } from "../providers/index.js";
import type { Sample } from "../capture.js";
import type { SampleRun } from "./index.js";
import { outputRepr } from "./checks.js";
import type { ResponseCache } from "./cache.js";

/**
 * Optional LLM judge for open-ended answers, where regexes and JSON checks can't tell
 * whether a new answer is still good enough.
 *
 * The judge never scores answers in isolation. For each sample it compares
 *   - every other baseline repeat against the first baseline answer (how often the OLD model
 *     agrees with itself: the noise floor), and
 *   - every candidate answer against that same first baseline answer.
 * A regression is only flagged when the candidate is judged "different" more often than the
 * baseline is judged different from itself, so judge bias toward one wording largely cancels out.
 */

export interface JudgeScores {
  /** 1 = acceptable substitute, 0 = materially different, null = judge call failed. Aligned with the OK outputs. */
  baseline: (number | null)[];
  candidate: (number | null)[];
  /** What the answers were compared to: the first baseline answer, or the sample's logged reference if the baseline failed. */
  reference: "baseline" | "sample";
  judge: string;
}

const SYSTEM = `You compare two answers an AI system gave to the same task.
Decide whether the NEW answer is an acceptable substitute for the REFERENCE answer for the purpose of the task:
same facts and decisions, same required format and fields, nothing important missing or added.
Ignore differences in wording, style, ordering or politeness that don't change what a user or a program would do with the answer.
Reply with exactly one word: SAME or DIFFERENT.`;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …[truncated]" : s);

export function judgeMessages(sample: Sample, reference: string, answer: string): Message[] {
  const task = sample.messages
    .filter((m) => m.role === "system" || m.role === "user")
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: `<task>\n${clip(task, 6000)}\n</task>\n\n<reference>\n${clip(reference, 4000)}\n</reference>\n\n<new>\n${clip(answer, 4000)}\n</new>\n\nIs NEW an acceptable substitute for REFERENCE? Answer SAME or DIFFERENT.` },
  ];
}

export function parseJudgeVerdict(text: string): number | undefined {
  const t = text.toUpperCase();
  const diff = t.search(/\bDIFFERENT\b/);
  const same = t.search(/\bSAME\b/);
  if (diff === -1 && same === -1) return undefined;
  if (diff === -1) return 1;
  if (same === -1) return 0;
  return same < diff ? 1 : 0; // first verdict word wins
}

/** Number of judge calls a run will need (upper bound, assuming every call succeeds). */
export function judgeCallCount(samples: number, repeats: number): number {
  return samples * (Math.max(0, repeats - 1) + repeats);
}

export async function judgeRuns(
  samples: Sample[],
  runs: SampleRun[],
  judge: ChatProvider,
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void; pool: <T>(tasks: (() => Promise<T>)[], c: number) => Promise<T[]>; cache?: ResponseCache },
): Promise<void> {
  const byId = new Map(samples.map((s) => [s.id, s]));
  const tasks: (() => Promise<void>)[] = [];
  let done = 0;
  const ask = async (sample: Sample, ref: string, ans: string): Promise<number | null> => {
    const req = { messages: judgeMessages(sample, ref, ans), temperature: 0, max_tokens: 16 };
    const r = opts.cache ? await opts.cache.chat(judge, req, 0) : await judge.chat(req);
    opts.onProgress?.(++done, tasks.length);
    if (r.error) return null;
    return parseJudgeVerdict(r.text) ?? null;
  };
  for (const run of runs) {
    const sample = byId.get(run.id);
    if (!sample) continue;
    const B = run.baseline.filter((r) => !r.error).map(outputRepr);
    const C = run.candidate.filter((r) => !r.error).map(outputRepr);
    const reference = B[0] ?? sample.reference;
    if (reference === undefined || !C.length) continue;
    const scores: JudgeScores = { baseline: new Array(Math.max(0, B.length - 1)).fill(null), candidate: new Array(C.length).fill(null), reference: B.length ? "baseline" : "sample", judge: judge.spec };
    run.judge = scores;
    B.slice(1).forEach((b, i) => tasks.push(async () => void (scores.baseline[i] = await ask(sample, reference, b))));
    C.forEach((c, i) => tasks.push(async () => void (scores.candidate[i] = await ask(sample, reference, c))));
  }
  await opts.pool(tasks, opts.concurrency ?? 4);
}
