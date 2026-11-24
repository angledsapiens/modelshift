import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PROVIDERS, type ProviderName } from "./live/index.js";
import { toMarkdown, toText } from "./format.js";
import { captureFromText, samplesToJsonl } from "./capture.js";
import { SUPPORTED_PROVIDERS } from "./providers/index.js";
import { compareCandidatesText, runMarkdown, runSummaryText } from "./run/summary.js";
import { CONFIRM_ABOVE_CALLS, FAIL_LEVELS, loadResults, reportCore, runCore, scanCore, scanJson, SpendGuardError, UsageError, VERSION } from "./core.js";
import { serveMcp } from "./mcp.js";

const HELP = `modelshift ${VERSION} — know what breaks before your LLM is switched off

Usage:
  modelshift scan [path] [options]        Find model ids in a repo and check retirements
  modelshift capture <logs> [options]     Turn logged requests (JSONL/JSON) into a replayable test set
  modelshift run --from <p:m> --to <p:m>  Replay the test set on old vs new model and compare
  modelshift report <results.json...>     Turn run results into a shareable single-file HTML report
  modelshift mcp                          Start an MCP server (stdio) so agents can scan and test migrations

scan options:
  --live                 Also query providers' live model lists (catches silent removals, e.g. DeepInfra).
                         Uses OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY,
                         DEEPINFRA_API_KEY, TOGETHER_API_KEY, FIREWORKS_API_KEY, GROQ_API_KEY,
                         OPENROUTER_API_KEY when set. Keys are only sent to their own provider.
  --probe                With --live: send one 1-token request per unlisted model to see if it fails (404)
                         or is SILENTLY REDIRECTED to a different model (e.g. DeepInfra swaps retired models).
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
  --to <provider:model>     Replacement(s), comma-separated to compare several, e.g. openai:gpt-6-luna,anthropic:claude-sonnet-5-5
                            If the old model is already gone, candidates are judged on their own against each
                            sample's expected output (expect.match / expect.notMatch).
                            Providers: ${SUPPORTED_PROVIDERS.join(", ")}
  --samples <file>          Samples file (default: modelshift-samples.jsonl)
  --repeats <n>             Runs per sample per model (default 3; the baseline repeats form the noise floor)
  --concurrency <n>         Parallel requests (default 4)
  --temperature <t>         Override sample temperatures
  --prices <file>           JSON {"provider:model": {"input": usdPer1M, "output": usdPer1M}} for cost comparison
  --judge <provider:model>  Also ask an LLM judge whether each answer is an acceptable substitute for the
                            baseline's (for open-ended outputs). Calibrated against the baseline's agreement
                            with itself, so use --repeats 2 or more.
  -o, --out <file>          Results JSON (default: modelshift-results.json)
  --html <file>             Also write the HTML report
  --markdown                Print a markdown summary (for PR comments / CI step summaries)
  --yes                     Skip the confirmation required above ${CONFIRM_ABOVE_CALLS} API calls
  --fail-on-unsafe          Exit 1 when the verdict is "unsafe" (for CI)

report options:
  -o, --out <file>          Output HTML (default: modelshift-report.html). Several results files = one report
                            comparing the candidates.
  --markdown                Print a markdown summary instead of writing HTML

  -h, --help             Show help.  -v, --version  Show version.
`;

const BOOL_FLAGS = new Set(["--live", "--probe", "--json", "--markdown", "--include-markdown", "--no-redact", "--yes", "--fail-on-unsafe", "-h", "--help", "-v", "--version"]);

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
    live: flags.has("--live") || flags.has("--probe"),
    failOn: opts["--fail-on"],
    providers: opts["--providers"]?.split(",").filter(Boolean) as ProviderName[] | undefined,
  };
}

const err = (s: string) => process.stderr.write(s + "\n");

async function cmdScan(args: Args): Promise<number> {
  if (args.failOn && !FAIL_LEVELS[args.failOn]) {
    err(`--fail-on must be one of: retired, retiring, any`);
    return 1;
  }
  const res = await scanCore({
    path: args.path,
    live: args.live,
    probe: args.flags.has("--probe"),
    providers: args.providers,
    includeMarkdown: args.flags.has("--include-markdown"),
    calendar: args.opts["--calendar"],
    today: args.opts["--today"],
  });
  if (args.flags.has("--json")) process.stdout.write(JSON.stringify(scanJson(res), null, 2) + "\n");
  else if (args.flags.has("--markdown")) process.stdout.write(toMarkdown(res.models, { calendarUpdated: res.calendar.updated }) + "\n");
  else process.stdout.write(toText(res.models, res.live, { root: res.root, calendarUpdated: res.calendar.updated, live: args.live }) + "\n");
  if (args.failOn && res.models.some((m) => FAIL_LEVELS[args.failOn!].includes(m.status))) return 1;
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
  const markdown = args.flags.has("--markdown");
  const log = (s: string) => (markdown ? process.stderr : process.stdout).write(s + "\n");
  try {
    const res = await runCore(
      {
        from,
        to: to.split(",").map((x) => x.trim()).filter(Boolean),
        samples: args.opts["--samples"],
        repeats: args.opts["--repeats"] !== undefined ? Number(args.opts["--repeats"]) : undefined,
        concurrency: args.opts["--concurrency"] !== undefined ? Number(args.opts["--concurrency"]) : undefined,
        temperature: args.opts["--temperature"] !== undefined ? Number(args.opts["--temperature"]) : undefined,
        prices: args.opts["--prices"],
        judge: args.opts["--judge"],
        out: args.opts["--out"],
        html: args.opts["--html"],
        yes: args.flags.has("--yes"),
      },
      {
        onPlan: (p) => log(p.text),
        onProgress: (spec, d, t) => {
          if (process.stderr.isTTY) process.stderr.write(`\r  ${spec}: ${d}/${t} calls${d === t ? "\n" : ""}`);
        },
      },
    );
    for (const r of res.results) log(runSummaryText(r.result) + `\nFull results: ${r.out}`);
    if (res.results.length > 1) log("\n" + compareCandidatesText(res.results.map((r) => ({ spec: r.spec, result: r.result }))));
    if (res.html) log(`HTML report: ${res.html}`);
    if (markdown) process.stdout.write(runMarkdown(res.results.map((r) => r.result)) + "\n");
    return args.flags.has("--fail-on-unsafe") && res.results.some((r) => r.result.analysis.verdict === "unsafe") ? 1 : 0;
  } catch (e) {
    if (e instanceof SpendGuardError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
}

function cmdReport(args: Args): number {
  if (args.flags.has("--markdown")) {
    process.stdout.write(runMarkdown(loadResults(args.positional)) + "\n");
    return 0;
  }
  const { out, results } = reportCore(args.positional, args.opts["--out"]);
  process.stdout.write(`Wrote ${out} (${results.length} candidate${results.length > 1 ? "s" : ""}, ${results[0].runs.length} samples).\n`);
  return 0;
}

async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  try {
    return await dispatch(args);
  } catch (e) {
    if (e instanceof UsageError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
}

async function dispatch(args: Args): Promise<number> {
  switch (args.cmd) {
    case "scan":
      return cmdScan(args);
    case "capture":
      return cmdCapture(args);
    case "run":
      return cmdRun(args);
    case "report":
      return cmdReport(args);
    case "mcp":
      await serveMcp();
      return 0;
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
