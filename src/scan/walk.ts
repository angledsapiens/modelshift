import { readdirSync, statSync } from "node:fs";
import { join, relative, extname, basename, sep } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".venv", "venv", "env",
  "__pycache__", ".mypy_cache", ".pytest_cache", "coverage", ".turbo", ".cache", "target",
  "vendor", ".idea", ".vscode", "site-packages",
]);

export const SCAN_EXTS = new Set([
  ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".yaml", ".yml", ".toml",
  ".ini", ".cfg", ".properties", ".go", ".rb", ".java", ".kt", ".cs", ".php", ".rs", ".swift",
  ".ipynb", ".md", ".sh", ".tf", ".env",
]);

const MAX_BYTES = 1_000_000;

/** Effective extension; treats ".env", ".env.example", ".env.local" as ".env". */
export function effectiveExt(path: string): string {
  const name = basename(path);
  if (name === ".env" || name.startsWith(".env.")) return ".env";
  return extname(name).toLowerCase();
}

export function walkFiles(root: string, extra: { includeMarkdown?: boolean } = {}): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) stack.push(full);
      } else if (st.isFile() && st.size <= MAX_BYTES) {
        const ext = effectiveExt(full);
        if (!SCAN_EXTS.has(ext)) continue;
        if (ext === ".md" && !extra.includeMarkdown) continue;
        if (name === "package-lock.json" || name === "yarn.lock" || name === "pnpm-lock.yaml") continue;
        files.push(full);
      }
    }
  }
  return files.sort();
}

export function relPath(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}
