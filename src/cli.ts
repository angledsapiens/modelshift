import { resolve } from "node:path";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { loadCalendar, todayIso } from "./calendar.js";
import { assess, scanRepo, sortAssessments } from "./scan/index.js";
import { liveCheck, PROVIDERS, type ProviderName, type ProviderResult } from "./live/index.js";
import { toMarkdown, toText } from "./format.js";
import { captureFromText, parseSamplesJsonl, samplesToJsonl } from "./capture.js";
import { createProvider, SUPPORTED_PROVIDERS } from "./providers/index.js";
import { analyze, estimateRun, executeRun, type Prices, type RunResult } from "./run/index.js";
import { runSummaryText } from "./run/summary.js";
import type { Host } from "./types.js";

const VERSION = "0.1.0-dev";
const CONFIRM_ABOVE_CALLS = 60;

const HELP = `modelshift ${VERSION} — know what breaks before your LLM is switched off

Usage:
  modelshift scan [path] [options]        Find model ids in a repo and check retirements
  modelshift capture <logs> [options]     Turn logged requests (JSONL/JSON) into a replayable test set
  modelshift run --from <p:m> --to <p:m>  Replay the test set on old vs new model and compare

scan options:
  --live                 Also query providers' live model lists (catches silent removals, e.g. DeepInfra).
                         Uses OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY,
                         DEEPINFRA_API_KEY, TOGETHER_API_KEY, FIREWORKS_API_KEY, GROQ_API_KEY,
                         OPENROUTER_API_KEY when set. Keys are only sent to their own provider.
  --providers a,b        Limit live checks (${PROVIDERS.map((p) => p.name).join(", ")}).
  --json | --markdown    Machine-readable output / PR-comment summary.
  --fail-on <level>      Exit 1 if anything at or above: retired | retiring | any.
  --include-markdown     Also scan .md files.
  --calendar <file>      Custom retirement calendar JSON.
  --today <YYYY-MM-DD>   Override today's date (testing).

capture options:
  -o, --out <file>       Output samples file (default: modelshift-samples.jsonl)
  --limit <n>            Keep n samples spread evenly across the log (default: 50)
  --no-redact            Keep text as-is (default redacts emails, keys, card/phone/IBAN/NI numbers)

run options:
  --from <provider:model>   Current model, e.g. openai:gpt-4o-2024-08-06, deepinfra:google/gemma-3-27b-it
  --to <provider:model>     Replacement, e.g. openai:gpt-6-luna, anthropic:claude-sonnet-5-5
                            Providers: ${SUPPORTED_PROVIDERS.join(", ")}
  --samples <file>          Samples file (default: modelshift-samples.jsonl)
  --repeats <n>             Runs per sample per model (default 3; the baseline repeats form the noise floor)
  --concurrency <n>         Parallel requests (default 4)
  --temperature <t>         Override sample temperatures
  --prices <file>           JSON {"provider:model": {"input": usdPer1M, "output": usdPer1M}} for cost comparison
  -o, --out <file>          Results JSON (default: modelshift-results.json)
  --yes                     Skip the confirmation required above ${CONFIRM_ABOVE_CALLS} API calls
  --fail-on-unsafe          Exit 1 when the verdict is "unsafe" (for CI)

  -h, --help             Show help.  -v, --version  Show version.
`;

const BOOL_FLAGS = new Set(["--live", "--json", "--markdown", "--include-markdown", "--no-redact", "--yes", "--fail-on-unsafe", "-h", "--help", "-v", "--version"]);

export interface Args {
  cmd?: string;
  positional: string[];
  flags: Set<string>;
  opts: Record<string, string>;
  // convenience views used by scan
  path: string;
  live: boolean;
  failOn?: string;
  providers?: ProviderName[];
}

export function parseArgs(argv: string[]): Args {
  const flags = new Set<string>();
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (BOOL_FLAGS.has(t)) flags.add(t);
    else if (t.startsWith("-")) opts[t === "-o" ? "--out" : t] = argv[++i] ?? "";
    else positional.push(t);
  }
  const help = flags.has("-h") || flags.has("--help");
  return {
    cmd: help ? "help" : flags.has("-v") || flags.has("--version") ? "version" : positional[0],
    positional: positional.slice(1),
    flags,
    opts,
    path: positional[1] ?? ".",
    live: flags.has("--live"),
    failOn: opts["--fail-on"],
    providers: opts["--providers"]?.split(",").filter(Boolean) as ProviderName[] | undefined,
  };
}

const err = (s: string) => process.stderr.write(s + "\n");

async function cmdScan(args: Args): Promise<number> {
  const root = resolve(args.path);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    err(`Not a directory: ${root}`);
    return 1;
  }
  const cal = loadCalendar(args.opts["--calendar"]);
  const today = args.opts["--today"] ?? todayIso();
  const findings = scanRepo(root, { includeMarkdown: args.flags.has("--include-markdown") });
  let list = assess(findings, cal, today);
  let results: ProviderResult[] = [];
  if (args.live) {
    const repoHosts = [...new Set(findings.flatMap((f) => f.hosts))] as Host[];
    ({ assessments: list, results } = await liveCheck(list, { only: args.providers, repoHosts }));
  }
  list = sortAssessments(list);

  if (args.flags.has("--json")) process.stdout.write(JSON.stringify({ root, today, calendarUpdated: cal.updated, models: list, live: results.map((r) => ({ provider: r.provider, ok: r.ok, skipped: r.skipped, error: r.error, listed: r.models?.size })) }, null, 2) + "\n");
  else if (args.flags.has("--markdown")) process.stdout.write(toMarkdown(list, { calendarUpdated: cal.updated }) + "\n");
  else process.stdout.write(toText(list, results, { root, calendarUpdated: cal.updated, live: args.live }) + "\n");

  if (args.failOn) {
    const levels: Record<string, string[]> = {
      retired: ["retired", "missing"],
      retiring: ["retired", "missing", "flagged", "retiring"],
      any: ["retired", "missing", "flagged", "retiring", "deprecated", "check"],
    };
    const bad = levels[args.failOn];
    if (!bad) {
      err(`--fail-on must be one of: retired, retiring, any`);
      return 1;
    }
    if (list.some((a) => bad.includes(a.status))) return 1;
  }
  return 0;
}

function cmdCapture(args: Args): number {
  const input = args.positional[0];
  if (!input || !existsSync(input)) {
    err(`Usage: modelshift capture <logs.jsonl> [-o samples.jsonl] [--limit n] [--no-redact]`);
    return 1;
  }
  const out = args.opts["--out"] ?? "modelshift-samples.jsonl";
  const limit = Number(args.opts["--limit"] ?? 50);
  const redact = !args.flags.has("--no-redact");
  const { samples, skipped } = captureFromText(readFileSync(input, "utf8"), { redact, limit });
  if (!samples.length) {
    err(`No usable requests found in ${input} (${skipped} lines skipped). See README for accepted formats.`);
    return 1;
  }
  writeFileSync(out, samplesToJsonl(samples));
  process.stdout.write(`Wrote ${samples.length} samples to ${out}${skipped ? ` (${skipped} lines skipped)` : ""}.${redact ? " PII redaction applied (best effort: review before sharing)." : ""}\n`);
  return 0;
}

async function cmdRun(args: Args): Promise<number> {
  const from = args.opts["--from"];
  const to = args.opts["--to"];
  if (!from || !to) {
    err(`Usage: modelshift run --from <provider:model> --to <provider:model> [--samples file] [--repeats n]`);
    return 1;
  }
  const samplesFile = args.opts["--samples"] ?? "modelshift-samples.jsonl";
  if (!existsSync(samplesFile)) {
    err(`Samples file not found: ${samplesFile}. Create one with "modelshift capture <logs.jsonl>".`);
    return 1;
  }
  const samples = parseSamplesJsonl(readFileSync(samplesFile, "utf8"));
  const repeats = Math.max(1, Number(args.opts["--repeats"] ?? 3));
  const concurrency = Math.max(1, Number(args.opts["--concurrency"] ?? 4));
  const prices: Prices | undefined = args.opts["--prices"] ? JSON.parse(readFileSync(args.opts["--prices"], "utf8")) : undefined;
  const temperature = args.opts["--temperature"] !== undefined ? Number(args.opts["--temperature"]) : undefined;

  // Validate specs + keys before spending anything.
  const baseline = createProvider(from);
  const candidate = createProvider(to);

  const est = estimateRun(samples, repeats, prices, [baseline.spec, candidate.spec]);
  process.stdout.write(`Plan: ${samples.length} samples × ${repeats} repeats × 2 models = ${est.calls} API calls (~${est.approxInputTokens.toLocaleString()} input tokens${est.approxCostUsd !== undefined ? `, ~$${est.approxCostUsd.toFixed(2)}` : ""}).\n`);
  if (est.calls > CONFIRM_ABOVE_CALLS && !args.flags.has("--yes")) {
    err(`This will make ${est.calls} paid API calls. Re-run with --yes to proceed, or lower --repeats / use fewer samples.`);
    return 1;
  }

  const { meta, runs } = await executeRun(samples, baseline, candidate, {
    repeats,
    concurrency,
    temperature,
    toolVersion: VERSION,
    onProgress: (d, t) => {
      if (process.stderr.isTTY) process.stderr.write(`\r  ${d}/${t} calls`);
    },
  });
  if (process.stderr.isTTY) process.stderr.write("\n");
  const analysis = analyze(samples, runs, { prices, baselineSpec: baseline.spec, candidateSpec: candidate.spec });
  const result: RunResult = { meta, samples, runs, analysis };
  const out = args.opts["--out"] ?? "modelshift-results.json";
  writeFileSync(out, JSON.stringify(result, null, 2));
  process.stdout.write(runSummaryText(result) + `\nFull results: ${out}\n`);
  return args.flags.has("--fail-on-unsafe") && analysis.verdict === "unsafe" ? 1 : 0;
}

async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  switch (args.cmd) {
    case "scan":
      return cmdScan(args);
    case "capture":
      return cmdCapture(args);
    case "run":
      return cmdRun(args);
    case "version":
      process.stdout.write(VERSION + "\n");
      return 0;
    case "help":
      process.stdout.write(HELP);
      return 0;
    default:
      process.stdout.write(HELP);
      if (args.cmd) err(`\nUnknown command "${args.cmd}".`);
      return 1;
  }
}

export { main };
