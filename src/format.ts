import type { Assessment } from "./types.js";
import type { ProviderResult } from "./live/index.js";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = (s: string) => c(31, s);
const yellow = (s: string) => c(33, s);
const cyan = (s: string) => c(36, s);
const dim = (s: string) => c(2, s);
const bold = (s: string) => c(1, s);

const LABEL: Record<string, string> = {
  retired: "ALREADY SHUT DOWN",
  missing: "NOT SERVED ANYMORE (probe)",
  redirected: "SILENTLY REDIRECTED (probe)",
  unlisted: "NOT IN MODEL LIST (live)",
  flagged: "DEPRECATED BY PROVIDER (live)",
  retiring: "RETIRING",
  deprecated: "DEPRECATED (date TBA)",
  check: "CHECK ALIAS",
};

function when(a: Assessment): string {
  if (a.status === "retired") return `shut down ${a.shutdown}`;
  if (a.daysLeft !== undefined && a.shutdown) return `${a.shutdown} (${a.daysLeft} days)`;
  return "";
}

/** What the live check couldn't do: providers it couldn't read and probes that didn't run. */
export function liveGaps(list: Assessment[], results: ProviderResult[]): { severity: "error" | "skipped"; text: string }[] {
  const gaps: { severity: "error" | "skipped"; text: string }[] = [];
  for (const r of results) {
    if (r.ok) continue;
    if (r.error) gaps.push({ severity: "error", text: `${r.provider}: couldn't read its model list (${r.error}). Its models were only checked against the retirement calendar.` });
    else gaps.push({ severity: "skipped", text: `${r.provider}: not checked live (${r.skipped}). Its models were only checked against the retirement calendar.` });
  }
  const probe = list.filter((a) => /\(probe (failed|skipped):/.test(a.note ?? ""));
  if (probe.length) gaps.push({ severity: "error", text: `${probe.length} probe${probe.length > 1 ? "s" : ""} didn't run (${probe.map((a) => a.id).slice(0, 4).join(", ")}${probe.length > 4 ? "…" : ""}), so it's unknown whether ${probe.length > 1 ? "those models fail or are" : "that model fails or is"} silently redirected. See the notes above.` });
  return gaps;
}

export function toText(list: Assessment[], results: ProviderResult[], meta: { root: string; calendarUpdated: string; live: boolean }): string {
  const out: string[] = [];
  const risky = list.filter((a) => a.status !== "ok");
  const okCount = list.length - risky.length;
  out.push(bold(`modelshift scan`) + dim(`  ${meta.root}  (calendar updated ${meta.calendarUpdated})`));
  out.push("");
  if (!list.length) {
    out.push("No model ids found.");
    return out.join("\n");
  }
  for (const a of risky) {
    const color = a.status === "retired" || a.status === "missing" || a.status === "redirected" ? red : a.status === "check" ? cyan : yellow;
    out.push(color(`● ${LABEL[a.status]}`) + `  ${bold(a.id)}  ${when(a)}`);
    if (a.servedAs) out.push(`    actually served: ${bold(a.servedAs)}`);
    if (a.replacement) out.push(`    replacement: ${a.replacement}`);
    if (a.note) out.push(`    ${dim(a.note)}`);
    const locs = a.locations.slice(0, 5).map((l) => `${l.file}:${l.line}`);
    out.push(`    used at: ${locs.join(", ")}${a.locations.length > 5 ? ` (+${a.locations.length - 5} more)` : ""}`);
    if (a.source) out.push(dim(`    source: ${a.source}`));
    out.push("");
  }
  out.push(`${risky.length} model id(s) need attention, ${okCount} with no known retirement.`);
  if (meta.live && risky.some((a) => a.status === "unlisted")) out.push(dim("Some models are not in their host's list: add --probe to check whether they fail or are silently redirected."));
  if (meta.live) {
    for (const r of results) if (r.ok) out.push(dim(`  live: ${r.provider} ✓ (${r.models?.size ?? 0} models listed)`));
    const gaps = liveGaps(list, results);
    if (gaps.length) {
      out.push("");
      out.push(yellow(bold(`Live check incomplete (${gaps.length}):`)));
      for (const g of gaps) out.push(g.severity === "error" ? red(`  ✖ ${g.text}`) : yellow(`  ! ${g.text}`));
    }
  } else {
    out.push(dim("Tip: run with --live --probe to catch models hosts like DeepInfra removed or silently swapped (probe needs that host's API key)."));
  }
  return out.join("\n");
}

export function toMarkdown(list: Assessment[], meta: { calendarUpdated: string }, results: ProviderResult[] = []): string {
  const risky = list.filter((a) => a.status !== "ok");
  const lines = [
    `### Model retirement check`,
    ``,
    risky.length ? `**${risky.length} model id(s) need attention.**` : `No retiring models found. ✅`,
    ``,
  ];
  const gaps = liveGaps(list, results);
  if (gaps.length) {
    lines.push(`> [!${gaps.some((g) => g.severity === "error") ? "CAUTION" : "WARNING"}]`, `> **Live check incomplete**`);
    for (const g of gaps) lines.push(`> - ${g.severity === "error" ? "✖" : "⚠️"} ${g.text}`);
    lines.push("");
  }
  if (risky.length) {
    lines.push(`| Status | Model | When | Replacement | Used at |`, `|---|---|---|---|---|`);
    for (const a of risky) {
      lines.push(`| ${LABEL[a.status]} | \`${a.id}\` | ${when(a) || "—"} | ${a.replacement ?? "—"} | ${a.locations.slice(0, 3).map((l) => `${l.file}:${l.line}`).join("<br>")} |`);
    }
    lines.push("");
  }
  lines.push(`<sub>Generated by [modelshift](https://www.npmjs.com/package/modelshift) · calendar updated ${meta.calendarUpdated}</sub>`);
  return lines.join("\n");
}
