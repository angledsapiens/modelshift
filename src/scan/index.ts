import { readFileSync } from "node:fs";
import type { Assessment, Calendar, Finding, Host } from "../types.js";
import { daysBetween, indexCalendar } from "../calendar.js";
import { calendarFamily, detectHosts, matchSegment, normalizeId, stringSegments } from "./matchers.js";
import { effectiveExt, relPath, walkFiles } from "./walk.js";

export function scanText(text: string, file: string, ext: string): Finding[] {
  const hosts = detectHosts(text);
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.length > 2000) return; // minified / data blobs
    const seen = new Set<string>();
    for (const seg of stringSegments(line, ext)) {
      for (const { rawId, family } of matchSegment(seg)) {
        if (seen.has(rawId)) continue;
        seen.add(rawId);
        findings.push({ file, line: i + 1, rawId, id: normalizeId(rawId, family), family: calendarFamily(rawId, family), hosts });
      }
    }
  });
  return findings;
}

export function scanRepo(root: string, opts: { includeMarkdown?: boolean } = {}): Finding[] {
  const out: Finding[] = [];
  for (const file of walkFiles(root, opts)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue; // binary
    out.push(...scanText(text, relPath(root, file), effectiveExt(file)));
  }
  return out;
}

/** Group findings by id and assess them against the retirement calendar. */
export function assess(findings: Finding[], cal: Calendar, today: string): Assessment[] {
  const index = indexCalendar(cal);
  const byId = new Map<string, Assessment>();
  for (const f of findings) {
    let a = byId.get(f.id);
    if (!a) {
      a = { id: f.id, family: f.family, status: "ok", locations: [], hosts: [] };
      byId.set(f.id, a);
    }
    a.locations.push({ file: f.file, line: f.line, rawId: f.rawId });
    for (const h of f.hosts) if (!a.hosts.includes(h as Host)) a.hosts.push(h);
  }

  for (const a of byId.values()) {
    const entry = index.get(a.id);
    if (entry) {
      a.replacement = entry.replacement;
      a.shutdown = entry.shutdown;
      a.source = cal.sources[entry.provider];
      a.note = entry.note;
      if (!entry.shutdown) {
        a.status = "deprecated";
      } else {
        a.daysLeft = daysBetween(today, entry.shutdown);
        a.status = a.daysLeft <= 0 ? "retired" : "retiring";
      }
      continue;
    }
    // Undated alias (e.g. "gpt-4o") whose dated snapshots are on the calendar.
    const snapshot = [...index.entries()].find(([k]) => k.startsWith(a.id + "-") && /-\d{4}-\d{2}-\d{2}$/.test(k) && k.slice(a.id.length + 1).match(/^\d{4}-\d{2}-\d{2}$/));
    if (snapshot) {
      const e = snapshot[1];
      a.status = "check";
      a.shutdown = e.shutdown;
      a.daysLeft = e.shutdown ? daysBetween(today, e.shutdown) : undefined;
      a.replacement = e.replacement;
      a.source = cal.sources[e.provider];
      a.note = `Undated alias: dated snapshot ${snapshot[0]} retires ${e.shutdown ?? "(date TBA)"}. Check which snapshot this alias resolves to.`;
    }
  }
  return [...byId.values()];
}

const ORDER: Record<string, number> = { retired: 0, missing: 1, flagged: 2, retiring: 3, deprecated: 4, check: 5, ok: 6 };

export function sortAssessments(list: Assessment[]): Assessment[] {
  return [...list].sort((x, y) => ORDER[x.status] - ORDER[y.status] || (x.daysLeft ?? 1e9) - (y.daysLeft ?? 1e9) || x.id.localeCompare(y.id));
}
