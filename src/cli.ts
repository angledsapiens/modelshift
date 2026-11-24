import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { loadCalendar, todayIso } from "./calendar.js";
import { assess, scanRepo, sortAssessments } from "./scan/index.js";
import { liveCheck, PROVIDERS, type ProviderName, type ProviderResult } from "./live/index.js";
import { toMarkdown, toText } from "./format.js";
import type { Host } from "./types.js";

const HELP = `modelshift — know what breaks before your LLM is switched off

Usage:
  modelshift scan [path] [options]

Options:
  --live                 Also query providers' live model lists (catches silent removals, e.g. DeepInfra).
                         Uses OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY,
                         DEEPINFRA_API_KEY, TOGETHER_API_KEY, FIREWORKS_API_KEY, GROQ_API_KEY,
                         OPENROUTER_API_KEY when set. Keys are only sent to their own provider.
  --providers a,b        Limit live checks to these providers (${PROVIDERS.map((p) => p.name).join(", ")}).
  --json                 Machine-readable output.
  --markdown             Markdown summary (for PR comments / READMEs).
  --fail-on <level>      Exit 1 if anything at or above level: retired | retiring | any.
  --include-markdown     Also scan .md files.
  --calendar <file>      Use a custom retirement calendar JSON.
  --today <YYYY-MM-DD>   Override today's date (testing).
  -h, --help             Show help.
`;

interface Args {
  cmd?: string;
  path: string;
  live: boolean;
  json: boolean;
  markdown: boolean;
  failOn?: string;
  providers?: ProviderName[];
  includeMarkdown: boolean;
  calendar?: string;
  today?: string;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { path: ".", live: false, json: false, markdown: false, includeMarkdown: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--live") a.live = true;
    else if (t === "--json") a.json = true;
    else if (t === "--markdown") a.markdown = true;
    else if (t === "--include-markdown") a.includeMarkdown = true;
    else if (t === "--fail-on") a.failOn = argv[++i];
    else if (t === "--providers") a.providers = (argv[++i] ?? "").split(",").filter(Boolean) as ProviderName[];
    else if (t === "--calendar") a.calendar = argv[++i];
    else if (t === "--today") a.today = argv[++i];
    else if (t === "-h" || t === "--help") a.cmd = "help";
    else rest.push(t);
  }
  if (a.cmd !== "help") a.cmd = rest[0];
  if (rest[1]) a.path = rest[1];
  return a;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cmd || args.cmd === "help") {
    process.stdout.write(HELP);
    return args.cmd === "help" ? 0 : 1;
  }
  if (args.cmd !== "scan") {
    process.stderr.write(`Unknown command "${args.cmd}". Only "scan" exists in this version (run, capture and report are coming).\n`);
    return 1;
  }
  const root = resolve(args.path);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    process.stderr.write(`Not a directory: ${root}\n`);
    return 1;
  }

  const cal = loadCalendar(args.calendar);
  const today = args.today ?? todayIso();
  const findings = scanRepo(root, { includeMarkdown: args.includeMarkdown });
  let list = assess(findings, cal, today);
  let results: ProviderResult[] = [];
  if (args.live) {
    const repoHosts = [...new Set(findings.flatMap((f) => f.hosts))] as Host[];
    ({ assessments: list, results } = await liveCheck(list, { only: args.providers, repoHosts }));
  }
  list = sortAssessments(list);

  if (args.json) process.stdout.write(JSON.stringify({ root, today, calendarUpdated: cal.updated, models: list, live: results.map((r) => ({ provider: r.provider, ok: r.ok, skipped: r.skipped, error: r.error, listed: r.models?.size })) }, null, 2) + "\n");
  else if (args.markdown) process.stdout.write(toMarkdown(list, { calendarUpdated: cal.updated }) + "\n");
  else process.stdout.write(toText(list, results, { root, calendarUpdated: cal.updated, live: args.live }) + "\n");

  if (args.failOn) {
    const levels: Record<string, string[]> = {
      retired: ["retired", "missing"],
      retiring: ["retired", "missing", "flagged", "retiring"],
      any: ["retired", "missing", "flagged", "retiring", "deprecated", "check"],
    };
    const bad = levels[args.failOn];
    if (!bad) {
      process.stderr.write(`--fail-on must be one of: retired, retiring, any\n`);
      return 1;
    }
    if (list.some((a) => bad.includes(a.status))) return 1;
  }
  return 0;
}

export { main };
