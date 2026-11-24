import type { Family, Host } from "../types.js";

/**
 * Model-ID detection works on string-like segments only (quoted literals, and the
 * value side of env/yaml/toml/ini assignments). That keeps prose and identifiers
 * like `o1` in comments from producing noise.
 */

const QUOTED = /"([^"\\\n]{2,200})"|'([^'\\\n]{2,200})'|`([^`\\\n]{2,200})`/g;
const ASSIGNMENT_EXT = new Set([".env", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".properties"]);

export function stringSegments(line: string, ext: string): string[] {
  const segs: string[] = [];
  for (const m of line.matchAll(QUOTED)) segs.push((m[1] ?? m[2] ?? m[3]).trim());
  if (ASSIGNMENT_EXT.has(ext) || /(^|\/)\.env/.test(ext)) {
    const kv = line.match(/^\s*[\w.\-]+\s*[:=]\s*([^#\s"'`][^#]*?)\s*(#.*)?$/);
    if (kv) segs.push(kv[1].trim());
  }
  return segs;
}

interface Pattern {
  family: Family;
  re: RegExp;
  /** If true, the whole segment must be the id (used for very short ids like o3). */
  whole?: boolean;
}

const OPEN_WEIGHT_ORGS = [
  "meta-llama", "Qwen", "mistralai", "deepseek-ai", "google", "microsoft", "nvidia", "NousResearch",
  "moonshotai", "zai-org", "THUDM", "openai", "allenai", "BAAI", "intfloat", "sentence-transformers",
  "black-forest-labs", "stabilityai", "01-ai", "tiiuae", "ibm-granite", "MiniMaxAI", "Gryphe",
  "cognitivecomputations", "anthropic", "x-ai", "cohere", "bigcode", "Sao10K", "lizpreciatior",
  "codellama", "WizardLM", "HuggingFaceH4", "upstage", "amazon", "perplexity", "liquid",
];

const PATTERNS: Pattern[] = [
  // org/model (Hugging Face style, used by DeepInfra, Together, Fireworks, OpenRouter...)
  { family: "open-weight", re: new RegExp(`(?:^|[\\s(@])((?:${OPEN_WEIGHT_ORGS.join("|")})\\/[A-Za-z0-9][\\w.\\-:]*)`, "g") },
  // Fireworks account paths
  { family: "open-weight", re: /(accounts\/[\w\-]+\/models\/[\w.\-]+)/g },
  // AWS Bedrock ids (vendor.model-family...), e.g. anthropic.claude-3-5-sonnet-20240620-v1:0, meta.llama3-70b-instruct-v1:0
  { family: "bedrock", re: /\b((?:us\.|eu\.|apac\.)?(?:anthropic\.claude|meta\.llama|amazon\.(?:titan|nova)|mistral\.(?:mistral|mixtral|pixtral)|cohere\.(?:command|embed)|ai21\.(?:jamba|j2)|deepseek\.(?:r1|v3))[\w.\-]*(?::\d+)?)/g },
  { family: "openai", re: /(?:^|[^\w\-])((?:ft:)?(?:gpt-[0-9][\w.\-]*|chatgpt-[\w.\-]+|gpt-image-[\w.\-]+|gpt-realtime[\w.\-]*|gpt-audio[\w.\-]*|text-embedding-[\w.\-]+|tts-1(?:-hd)?|whisper-1|dall-e-[23]|davinci-002|babbage-002|computer-use-preview[\w.\-]*|sora-2[\w.\-]*)(?::[\w.\-:]*)?)/g },
  { family: "openai", re: /^(o[1-9](?:-(?:mini|pro|preview|deep-research))*(?:-\d{4}-\d{2}-\d{2})?)$/g, whole: true },
  { family: "anthropic", re: /(?:^|[^\w\-.])(claude-[a-z0-9][\w.\-]*)/g },
  { family: "google", re: /(?:^|[^\w\-])((?:models\/)?(?:gemini|gemma|imagen|veo)-[\w.\-]+)/g },
  { family: "mistral", re: /(?:^|[^\w\-])((?:mistral|codestral|pixtral|ministral|magistral|devstral|open-mistral|open-mixtral)-[\w.\-]+)/g },
  { family: "cohere", re: /(?:^|[^\w\-])(command-(?:r|a|light|nightly|r7b)[\w.\-]*)/g },
  { family: "deepseek", re: /(?:^|[^\w\-])(deepseek-(?:chat|reasoner|coder|v\d|r\d)[\w.\-]*)/g },
];

const MODEL_WORDS = /llama|qwen|gemma|gemini|mistral|mixtral|phi|deepseek|instruct|chat|coder|embed|bge|e5|whisper|flux|sdxl|stable|glm|kimi|minimax|hermes|wizard|falcon|granite|olmo|nemotron|command|sonar|nova|grok|gpt|claude|reasoner|turbo|vision|base|it$/i;

/** "org/name" strings are only treated as models when the name part looks like one (digit or model word). */
export function looksLikeModel(rawId: string): boolean {
  const name = rawId.includes("/") ? rawId.slice(rawId.lastIndexOf("/") + 1) : rawId;
  return /\d/.test(name) || MODEL_WORDS.test(name);
}

export interface RawMatch {
  rawId: string;
  family: Family;
}

export function matchSegment(seg: string): RawMatch[] {
  const out: RawMatch[] = [];
  const spans: [number, number][] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of seg.matchAll(p.re)) {
      const rawId = m[1].replace(/[.,;:)\]]+$/, "");
      if (rawId.length < 2) continue;
      if (p.family === "open-weight" && !looksLikeModel(rawId)) continue;
      const start = (m.index ?? 0) + m[0].indexOf(m[1]);
      const end = start + rawId.length;
      // Earlier patterns win on overlap: "openai/gpt-4o" is reported once (as the gateway id),
      // but "gpt-4o" and "gpt-4o-mini" side by side are both reported.
      if (spans.some(([s, e]) => start < e && end > s)) continue;
      spans.push([start, end]);
      out.push({ rawId, family: p.family });
    }
  }
  return out;
}

/**
 * Normalize for calendar lookups:
 *  - OpenRouter/gateway prefixes "openai/gpt-4o" -> "gpt-4o" (only for first-party families)
 *  - Gemini "models/gemini-x" -> "gemini-x"
 *  - fine-tuned "ft:gpt-4o-mini-2024-07-18:org::abc" -> base model
 *  - Bedrock "anthropic.claude-x-v1:0" -> keeps bedrock form (separate namespace)
 */
export function normalizeId(rawId: string, family: Family): string {
  let id = rawId.trim();
  if (id.startsWith("ft:")) id = id.slice(3).split(":")[0];
  if (family === "google") id = id.replace(/^models\//, "");
  if (family === "open-weight") {
    const m = id.match(/^(openai|anthropic|google)\/(.+)$/);
    if (m) id = m[2];
  }
  return id.toLowerCase();
}

/** Family to look up in the calendar for an id (gateway ids like "openai/gpt-4o" resolve to openai). */
export function calendarFamily(rawId: string, family: Family): Family {
  if (family !== "open-weight") return family;
  if (/^openai\//.test(rawId)) return "openai";
  if (/^anthropic\//.test(rawId)) return "anthropic";
  if (/^google\/gemini/.test(rawId)) return "google";
  return family;
}

const HOST_SIGNALS: [Host, RegExp][] = [
  ["deepinfra", /deepinfra/i],
  ["together", /together\.(xyz|ai)|TOGETHER_API_KEY|from together import|['"]together['"]/i],
  ["fireworks", /fireworks\.ai|FIREWORKS_API_KEY|fireworks-ai/i],
  ["groq", /groq\.com|GROQ_API_KEY|from groq import|['"]groq-sdk['"]/i],
  ["openrouter", /openrouter/i],
];

export function detectHosts(text: string): Host[] {
  return HOST_SIGNALS.filter(([, re]) => re.test(text)).map(([h]) => h);
}
