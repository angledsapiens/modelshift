import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { toText } from "./format.js";
import { captureFromText, samplesToJsonl } from "./capture.js";
import { loadCalendar } from "./calendar.js";
import { runMarkdown, runSummaryText } from "./run/summary.js";
import { CONFIRM_ABOVE_CALLS, importCore, reportCore, runCore, scanCore, scanJson, SpendGuardError, UsageError, VERSION } from "./core.js";
import type { ProviderName } from "./live/index.js";

/**
 * Minimal Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0),
 * with no dependencies. Exposes modelshift's commands as tools so coding agents
 * (Claude Code, Cursor, etc.) can check a repo for retiring models and test a replacement.
 *
 * Paid calls are guarded: run_migration_test refuses above the spend limit unless the
 * agent passes confirm_spend: true, which it should only do after asking the user.
 */

type Json = Record<string, unknown>;

const TOOLS = [
  {
    name: "scan_models",
    description:
      "Find every LLM model id used in a repository and report which are retired, retiring, or (with live/probe) removed or silently redirected by the host. Free unless probe is set (probe sends one 1-token request per model missing from a host's list).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository directory (default: current directory)" },
        live: { type: "boolean", description: "Also check providers' live model lists using API keys from the environment" },
        probe: { type: "boolean", description: "With live: send a 1-token request for unlisted models to detect removals and silent redirects" },
        providers: { type: "array", items: { type: "string" }, description: "Limit live checks to these providers" },
      },
    },
  },
  {
    name: "retirement_calendar",
    description: "List known model retirements (shutdown dates and replacements) from modelshift's calendar, copied from official provider deprecation pages.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "openai | anthropic | google | ... (optional)" },
        query: { type: "string", description: "Substring of a model id to filter by (optional)" },
      },
    },
  },
  {
    name: "capture_samples",
    description: "Turn logged LLM requests (JSONL or JSON array: OpenAI-style request/response logs, Langfuse exports, {prompt, output}) into a replayable samples file. PII is redacted by default.",
    inputSchema: {
      type: "object",
      required: ["logs"],
      properties: {
        logs: { type: "string", description: "Path to the log file" },
        out: { type: "string", description: "Output samples file (default modelshift-samples.jsonl)" },
        limit: { type: "number", description: "Number of samples to keep, spread across the log (default 50)" },
        redact: { type: "boolean", description: "Redact emails, keys, card/phone/IBAN numbers (default true)" },
      },
    },
  },
  {
    name: "import_promptfoo",
    description: "Turn a Promptfoo config (prompts × tests with assertions) into a modelshift samples file. Deterministic assertions become expected-output rules; model-graded and code assertions are reported as not translated. Free: makes no API calls.",
    inputSchema: {
      type: "object",
      properties: {
        config: { type: "string", description: "Path to promptfooconfig.yaml (default: look in the current folder)" },
        out: { type: "string", description: "Output samples file (default modelshift-samples.jsonl)" },
      },
    },
  },
  {
    name: "run_migration_test",
    description: `Replay a samples file on the current model and on one or more replacement models, and return a verdict (likely-safe / review / unsafe) with confidence. Makes PAID API calls with the user's keys. Above ${CONFIRM_ABOVE_CALLS} calls it returns the plan instead of running: show the plan to the user and only retry with confirm_spend: true after they agree.`,
    inputSchema: {
      type: "object",
      required: ["from", "to"],
      properties: {
        from: { type: "string", description: "Current model as provider:model, e.g. openai:gpt-4o-2024-08-06" },
        to: { type: "array", items: { type: "string" }, description: "Replacement model(s) as provider:model" },
        samples: { type: "string", description: "Samples file (default modelshift-samples.jsonl)" },
        repeats: { type: "number", description: "Runs per sample per model (default 3)" },
        judge: { type: "string", description: "Optional provider:model used as an LLM judge for open-ended answers" },
        embed: { type: "string", description: "Optional embedding model (provider:model, e.g. openai:text-embedding-3-small) for a meaning-based similarity check" },
        out: { type: "string", description: "Results JSON path (default modelshift-results.json)" },
        html: { type: "string", description: "Also write an HTML report to this path" },
        confirm_spend: { type: "boolean", description: "Set only after the user approved the plan's number of paid calls" },
      },
    },
  },
  {
    name: "render_report",
    description: "Render one or more modelshift results JSON files into a single-file HTML report to share with a team.",
    inputSchema: {
      type: "object",
      required: ["results"],
      properties: {
        results: { type: "array", items: { type: "string" }, description: "Results JSON files (several = candidates compared)" },
        out: { type: "string", description: "Output HTML (default modelshift-report.html)" },
      },
    },
  },
];

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export async function callTool(name: string, a: Json): Promise<ReturnType<typeof text>> {
  try {
    switch (name) {
      case "scan_models": {
        const res = await scanCore({ path: a.path as string | undefined, live: !!a.live, probe: !!a.probe, providers: a.providers as ProviderName[] | undefined });
        const human = toText(res.models, res.live, { root: res.root, calendarUpdated: res.calendar.updated, live: !!(a.live || a.probe) });
        return text(`${human}\n\n<json>\n${JSON.stringify(scanJson(res))}\n</json>`);
      }
      case "retirement_calendar": {
        const cal = loadCalendar();
        const q = String(a.query ?? "").toLowerCase();
        const rows = cal.entries.filter((e) => (!a.provider || e.provider === a.provider) && (!q || e.ids.some((id) => id.toLowerCase().includes(q))));
        return text(`Calendar updated ${cal.updated}. ${rows.length} entries.\n${JSON.stringify(rows, null, 1)}`);
      }
      case "capture_samples": {
        const logs = String(a.logs ?? "");
        if (!existsSync(logs)) return text(`Log file not found: ${logs}`, true);
        const out = (a.out as string) ?? "modelshift-samples.jsonl";
        const { samples, skipped } = captureFromText(readFileSync(logs, "utf8"), { redact: a.redact !== false, limit: Number(a.limit ?? 50) });
        if (!samples.length) return text(`No usable requests found in ${logs} (${skipped} lines skipped).`, true);
        writeFileSync(out, samplesToJsonl(samples));
        return text(`Wrote ${samples.length} samples to ${out}${skipped ? ` (${skipped} lines skipped)` : ""}.`);
      }
      case "import_promptfoo":
        return text(importCore("promptfoo", a.config as string | undefined, (a.out as string) ?? undefined).text);
      case "run_migration_test": {
        const to = Array.isArray(a.to) ? (a.to as string[]) : String(a.to ?? "").split(",").filter(Boolean);
        const res = await runCore({
          from: String(a.from ?? ""),
          to,
          samples: a.samples as string | undefined,
          repeats: a.repeats as number | undefined,
          judge: a.judge as string | undefined,
          embed: a.embed as string | undefined,
          out: a.out as string | undefined,
          html: a.html as string | undefined,
          yes: a.confirm_spend === true,
        });
        const parts = [res.plan.text, ...res.results.map((r) => runSummaryText(r.result) + `\nFull results: ${r.out}`)];
        if (res.html) parts.push(`HTML report: ${res.html}`);
        parts.push("\n" + runMarkdown(res.results.map((r) => r.result)));
        return text(parts.join("\n"));
      }
      case "render_report": {
        const { out, results } = reportCore((a.results as string[]) ?? [], a.out as string | undefined);
        return text(`Wrote ${out} (${results.length} candidate(s), ${results[0].runs.length} samples).`);
      }
      default:
        return text(`Unknown tool: ${name}`, true);
    }
  } catch (e) {
    if (e instanceof SpendGuardError) return text(`${e.plan.text}\nNot started: this needs ${e.plan.calls + e.plan.judgeCalls} paid API calls. Ask the user to approve, then call again with confirm_spend: true.`, true);
    if (e instanceof UsageError) return text(e.message, true);
    return text(`Error: ${(e as Error).message}`, true);
  }
}

export async function handle(msg: Json): Promise<Json | undefined> {
  const id = msg.id as string | number | undefined;
  const method = msg.method as string;
  const params = (msg.params ?? {}) as Json;
  if (id === undefined) return undefined; // notification (e.g. notifications/initialized)
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: (params.protocolVersion as string) ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "modelshift", version: VERSION },
        instructions: "Use scan_models to find retiring or silently redirected models in a repo; use run_migration_test to compare a replacement. Never set confirm_spend without the user's approval.",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call":
      return ok(await callTool(String(params.name), (params.arguments ?? {}) as Json));
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

export function serveMcp(): Promise<void> {
  // stdout carries protocol messages only; anything else goes to stderr.
  console.log = (...x: unknown[]) => process.stderr.write(x.join(" ") + "\n");
  const rl = createInterface({ input: process.stdin });
  const send = (m: Json) => process.stdout.write(JSON.stringify(m) + "\n");
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const reply = await handle(msg);
    if (reply) send(reply);
  });
  return new Promise((resolve) => rl.on("close", resolve));
}
