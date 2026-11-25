import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatRequest, ChatResponse } from "../providers/index.js";

/**
 * Local cache of successful model responses, so re-running a report, adding another candidate
 * or re-judging doesn't pay for the same calls twice. Keyed by model spec + the exact request +
 * the repeat slot (repeat 2 of a sample is a different entry from repeat 1, so the noise floor
 * still comes from independent answers). Failed calls are never cached, so they're retried.
 *
 * Responses can contain whatever your prompts contain: the cache folder gets its own
 * .gitignore so it isn't committed by accident.
 */
export class ResponseCache {
  hits = 0;
  misses = 0;

  constructor(readonly dir: string) {}

  static key(spec: string, req: ChatRequest, slot: number): string {
    const canonical = JSON.stringify([spec, req.messages, req.tools ?? null, req.temperature ?? null, req.max_tokens ?? null, !!req.json, slot]);
    return createHash("sha256").update(canonical).digest("hex");
  }

  private file(key: string): string {
    return join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  has(key: string): boolean {
    return existsSync(this.file(key));
  }

  get(key: string): ChatResponse | undefined {
    const f = this.file(key);
    if (!existsSync(f)) return undefined;
    try {
      return JSON.parse(readFileSync(f, "utf8")) as ChatResponse;
    } catch {
      return undefined; // corrupt entry: treat as a miss and overwrite
    }
  }

  put(key: string, res: ChatResponse): void {
    if (res.error) return;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, ".gitignore"), "# modelshift response cache: may contain prompt and output text\n*\n");
    }
    mkdirSync(join(this.dir, key.slice(0, 2)), { recursive: true });
    writeFileSync(this.file(key), JSON.stringify(res));
  }

  /** Any JSON value under a caller-made key (used for embeddings). */
  getValue<T>(key: string): T | undefined {
    return this.get(key) as unknown as T | undefined;
  }

  putValue(key: string, value: unknown): void {
    this.put(key, value as ChatResponse);
  }

  /** Call through the cache. */
  async chat(provider: { spec: string; chat(r: ChatRequest): Promise<ChatResponse> }, req: ChatRequest, slot: number): Promise<ChatResponse> {
    const key = ResponseCache.key(provider.spec, req, slot);
    const hit = this.get(key);
    if (hit) {
      this.hits++;
      return hit;
    }
    this.misses++;
    const res = await provider.chat(req);
    this.put(key, res);
    return res;
  }
}

export const DEFAULT_CACHE_DIR = join(".modelshift", "cache");
