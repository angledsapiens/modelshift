import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Calendar, RetirementEntry } from "./types.js";

/** Bundled calendar lives at <package>/data/retirements.json; this file compiles to <package>/dist/src/calendar.js. */
export function defaultCalendarPath(): string {
  return fileURLToPath(new URL("../../data/retirements.json", import.meta.url));
}

export function loadCalendar(path: string = defaultCalendarPath()): Calendar {
  const cal = JSON.parse(readFileSync(path, "utf8")) as Calendar;
  if (!Array.isArray(cal.entries)) throw new Error(`Invalid calendar file: ${path}`);
  return cal;
}

/** Map of lower-cased id -> entry, for O(1) lookups. */
export function indexCalendar(cal: Calendar): Map<string, RetirementEntry> {
  const map = new Map<string, RetirementEntry>();
  for (const e of cal.entries) for (const id of e.ids) map.set(id.toLowerCase(), e);
  return map;
}

export function daysBetween(fromIso: string, toIso: string): number {
  const ms = Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z");
  return Math.round(ms / 86_400_000);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
