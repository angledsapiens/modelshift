export type Family =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "cohere"
  | "deepseek"
  | "bedrock"
  | "open-weight";

/** Inference hosts / gateways that serve open-weight or third-party models. */
export type Host = "deepinfra" | "together" | "fireworks" | "groq" | "openrouter";

export interface Finding {
  file: string; // path relative to the scan root, forward slashes
  line: number; // 1-based
  rawId: string; // exactly as found in the source
  id: string; // normalized id used for lookups
  family: Family;
  hosts: Host[]; // inference hosts referenced in the same file
}

export interface RetirementEntry {
  provider: string;
  ids: string[];
  shutdown: string | null; // YYYY-MM-DD, null = deprecated, date not announced
  announced?: string;
  replacement: string | null;
  note?: string;
}

export interface Calendar {
  updated: string;
  sources: Record<string, string>;
  entries: RetirementEntry[];
}

export type Status =
  | "retired" // shutdown date has passed: calls are (or will soon be) failing
  | "missing" // live check: the provider no longer lists this model
  | "retiring" // shutdown date in the future
  | "deprecated" // deprecated, no date yet
  | "check" // undated alias whose dated snapshots are retiring
  | "flagged" // live check: provider marks it deprecated/expiring
  | "ok"; // no known retirement

export interface Assessment {
  id: string;
  family: Family;
  status: Status;
  shutdown?: string | null;
  daysLeft?: number;
  replacement?: string | null;
  source?: string;
  note?: string;
  locations: { file: string; line: number; rawId: string }[];
  hosts: Host[];
}
