/**
 * A small YAML reader for config files (no dependencies). Covers what eval configs use:
 * block mappings and sequences, plain / quoted scalars, block scalars (| and >, with - / +),
 * flow collections ([a, b] and {a: 1}), comments and multi-line plain scalars.
 * Not supported (throws a clear error): anchors, aliases, merge keys, tags, multiple documents.
 */

export class YamlError extends Error {}

interface Line {
  indent: number;
  text: string; // without indentation
  raw: string;
  no: number; // 1-based line number
}

export function parseYaml(src: string): unknown {
  const raw = src.replace(/^﻿/, "").split(/\r?\n/);
  const lines: Line[] = raw.map((r, i) => {
    if (/^\t/.test(r)) throw new YamlError(`line ${i + 1}: tabs can't be used for indentation in YAML`);
    const m = /^( *)(.*)$/.exec(r)!;
    return { indent: m[1].length, text: m[2], raw: r, no: i + 1 };
  });
  const p = new Parser(lines);
  p.skipDocStart();
  const v = p.node(0);
  p.skipBlank();
  if (p.i < lines.length) {
    const l = lines[p.i];
    if (l.text.startsWith("---")) throw new YamlError(`line ${l.no}: multiple YAML documents aren't supported`);
    throw new YamlError(`line ${l.no}: unexpected content "${l.text.slice(0, 40)}" (check the indentation)`);
  }
  return v ?? null;
}

const isBlank = (l: Line) => l.text === "" || l.text.startsWith("#");

/** Index of a mapping colon ("key: value" / "key:") outside quotes and brackets, or -1. */
function keyColon(text: string): number {
  if (/^[\[{]/.test(text) || /^-(\s|$)/.test(text)) return -1;
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (q === '"' && c === "\\") i++;
      else if (c === q) {
        if (q === "'" && text[i + 1] === "'") i++;
        else q = null;
      }
      continue;
    }
    if ((c === '"' || c === "'") && i === 0) q = c;
    else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) return -1;
    else if (c === ":" && (i + 1 === text.length || /\s/.test(text[i + 1]))) return i;
  }
  return -1;
}

function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function unsupported(text: string, no: number): void {
  if (/^[&*!]/.test(text) || /^<<\s*:/.test(text)) throw new YamlError(`line ${no}: YAML anchors, aliases, merge keys and tags aren't supported; expand them or use a JSON config`);
}

function plainScalar(s: string): unknown {
  const t = s.trim();
  if (t === "" || t === "~" || t === "null" || t === "Null" || t === "NULL") return null;
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?(0|[1-9]\d*)$/.test(t)) return Number(t);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  return t;
}

function unquoteDouble(body: string): string {
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e: string) => {
    if (e[0] === "u" || e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
    return ({ n: "\n", t: "\t", r: "\r", "0": "\0", '"': '"', "\\": "\\", "/": "/", " ": " ", b: "\b", f: "\f", e: "\x1b" } as Record<string, string>)[e] ?? e;
  });
}

class Parser {
  i = 0;
  constructor(private lines: Line[]) {}

  skipBlank(): void {
    while (this.i < this.lines.length && isBlank(this.lines[this.i])) this.i++;
  }

  skipDocStart(): void {
    this.skipBlank();
    const l = this.lines[this.i];
    if (l && l.indent === 0 && /^---(\s|$)/.test(l.text)) {
      const rest = l.text.slice(3).trim();
      if (rest && !rest.startsWith("#")) l.text = rest;
      else this.i++;
    }
  }

  peek(): Line | undefined {
    this.skipBlank();
    return this.lines[this.i];
  }

  /** Parse the node starting at the next line, if it is indented at least `min`. */
  node(min: number): unknown {
    const l = this.peek();
    if (!l || l.indent < min) return null;
    if (/^---(\s|$)/.test(l.text) && l.indent === 0) return null;
    unsupported(l.text, l.no);
    if (/^-(\s|$)/.test(l.text)) return this.seq(l.indent);
    if (keyColon(l.text) > 0) return this.map(l.indent);
    this.i++;
    return this.value(l.text, l.indent - 1, l.no);
  }

  map(ind: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (;;) {
      const l = this.peek();
      if (!l || l.indent !== ind || (ind === 0 && /^---(\s|$)/.test(l.text))) break;
      const c = keyColon(l.text);
      if (c <= 0) {
        if (/^-(\s|$)/.test(l.text)) break; // a sequence at the same indent belongs to the parent key
        throw new YamlError(`line ${l.no}: expected "key: value", got "${l.text.slice(0, 40)}"`);
      }
      unsupported(l.text, l.no);
      const key = String(this.keyOf(l.text.slice(0, c).trim(), l.no));
      const rest = stripComment(l.text.slice(c + 1).trim());
      this.i++;
      if (rest === "") {
        const n = this.peek();
        if (n && n.indent > ind) out[key] = this.node(n.indent);
        else if (n && n.indent === ind && /^-(\s|$)/.test(n.text)) out[key] = this.seq(ind);
        else out[key] = null;
      } else {
        unsupported(rest, l.no);
        out[key] = this.value(l.text.slice(c + 1).trim(), ind, l.no);
      }
    }
    return out;
  }

  seq(ind: number): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      const l = this.peek();
      if (!l || l.indent !== ind || !/^-(\s|$)/.test(l.text)) break;
      const content = l.text.slice(1).replace(/^ +/, "");
      const col = ind + (l.text.length - content.length);
      if (content === "" || content.startsWith("#")) {
        this.i++;
        const n = this.peek();
        out.push(n && n.indent > ind ? this.node(n.indent) : null);
      } else if (/^-(\s|$)/.test(content) || keyColon(content) > 0) {
        // "- key: value" or "- - x": the item is a block node starting at this column.
        l.indent = col;
        l.text = content;
        out.push(this.node(col));
      } else {
        this.i++;
        unsupported(content, l.no);
        out.push(this.value(content, ind, l.no));
      }
    }
    return out;
  }

  keyOf(k: string, no: number): unknown {
    if (k.startsWith('"') && k.endsWith('"')) return unquoteDouble(k.slice(1, -1));
    if (k.startsWith("'") && k.endsWith("'")) return k.slice(1, -1).replace(/''/g, "'");
    if (k.startsWith("?")) throw new YamlError(`line ${no}: complex keys aren't supported`);
    return k;
  }

  /** A value that starts on the current (already consumed) line; continuation lines must be indented more than `parent`. */
  value(text: string, parent: number, no: number): unknown {
    const t = text.trim();
    const block = /^([|>])([-+]?)(\d?)([-+]?)\s*(#.*)?$/.exec(t);
    if (block) return this.blockScalar(block[1] as "|" | ">", block[2] || block[4], block[3] ? Number(block[3]) : undefined, parent);
    if (t.startsWith("[") || t.startsWith("{")) return this.flow(t, parent, no);
    if (t.startsWith('"')) return this.quoted(t, '"', parent, no);
    if (t.startsWith("'")) return this.quoted(t, "'", parent, no);
    // Plain scalar, possibly continued on more-indented lines (folded with spaces).
    const parts = [stripComment(t)];
    for (;;) {
      const n = this.lines[this.i];
      if (!n || n.text.startsWith("#")) break;
      if (n.text === "") {
        // a blank line inside a multi-line plain scalar is a newline, if the scalar continues after it
        let j = this.i;
        while (j < this.lines.length && this.lines[j].text === "") j++;
        const after = this.lines[j];
        if (after && after.indent > parent && keyColon(after.text) < 0 && !after.text.startsWith("#") && !/^-(\s|$)/.test(after.text)) {
          parts.push("\n");
          this.i = j;
          continue;
        }
        break;
      }
      if (n.indent <= parent || keyColon(n.text) > 0 || /^-(\s|$)/.test(n.text)) break;
      parts.push(stripComment(n.text.trim()));
      this.i++;
    }
    if (parts.length === 1) return plainScalar(parts[0]);
    return parts.reduce((acc, p) => (p === "\n" ? acc + "\n" : acc === "" || acc.endsWith("\n") ? acc + p : acc + " " + p), "");
  }

  quoted(first: string, q: '"' | "'", parent: number, no: number): string {
    let buf = first;
    for (;;) {
      const end = closingQuote(buf, q);
      if (end >= 0) {
        const tail = stripComment(buf.slice(end + 1)).trim();
        if (tail) throw new YamlError(`line ${no}: unexpected text after the quoted string: "${tail.slice(0, 30)}"`);
        const body = buf.slice(1, end);
        return q === '"' ? unquoteDouble(foldQuoted(body)) : foldQuoted(body).replace(/''/g, "'");
      }
      const n = this.lines[this.i];
      if (!n) throw new YamlError(`line ${no}: unterminated quoted string`);
      buf += "\n" + n.text;
      this.i++;
    }
  }

  blockScalar(style: "|" | ">", chomp: string, explicit: number | undefined, parent: number): string {
    const body: string[] = [];
    let indent = explicit !== undefined ? parent + explicit : -1;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (l.raw.trim() === "") {
        body.push("");
        this.i++;
        continue;
      }
      if (indent < 0) {
        if (l.indent <= parent) break;
        indent = l.indent;
      }
      if (l.indent < indent) break;
      body.push(l.raw.slice(indent));
      this.i++;
    }
    // Trailing blank lines: rewind the ones that aren't part of the scalar for "keep" decisions.
    let trailing = 0;
    while (body.length && body[body.length - 1] === "") {
      body.pop();
      trailing++;
    }
    let text: string;
    if (style === "|") text = body.join("\n");
    else {
      text = "";
      for (let k = 0; k < body.length; k++) {
        const line = body[k];
        if (k === 0) text = line;
        else if (line === "") text += "\n";
        else if (body[k - 1] === "" || /^\s/.test(line) || /^\s/.test(body[k - 1])) text += (body[k - 1] === "" ? "" : "\n") + line;
        else text += " " + line;
      }
    }
    if (!body.length) return chomp === "+" ? "\n".repeat(trailing) : "";
    if (chomp === "-") return text;
    if (chomp === "+") return text + "\n" + "\n".repeat(trailing);
    return text + "\n";
  }

  flow(first: string, parent: number, no: number): unknown {
    let buf = stripComment(first);
    while (!balanced(buf)) {
      const n = this.lines[this.i];
      if (!n || (n.indent <= parent && n.text !== "")) throw new YamlError(`line ${no}: unclosed [ or { in a flow collection`);
      if (!n.text.startsWith("#")) buf += " " + stripComment(n.text.trim());
      this.i++;
    }
    const fp = new FlowParser(buf, no);
    const v = fp.value();
    fp.ws();
    if (fp.pos < buf.length) throw new YamlError(`line ${no}: unexpected "${buf.slice(fp.pos, fp.pos + 20)}" after a flow collection`);
    return v;
  }
}

function closingQuote(s: string, q: string): number {
  for (let i = 1; i < s.length; i++) {
    if (q === '"' && s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

/** Line breaks inside quoted scalars fold to spaces (blank lines to newlines). */
function foldQuoted(body: string): string {
  if (!body.includes("\n")) return body;
  return body
    .split("\n")
    .map((l, i) => (i === 0 ? l.trimEnd() : l.trim()))
    .reduce((acc, l, i) => (i === 0 ? l : l === "" ? acc + "\n" : acc.endsWith("\n") ? acc + l : acc + " " + l), "");
}

function balanced(s: string): boolean {
  let depth = 0;
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth <= 0 && !q;
}

class FlowParser {
  pos = 0;
  constructor(private s: string, private no: number) {}

  ws(): void {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++;
  }

  err(msg: string): never {
    throw new YamlError(`line ${this.no}: ${msg} in a flow collection`);
  }

  value(): unknown {
    this.ws();
    const c = this.s[this.pos];
    if (c === "[") {
      this.pos++;
      const out: unknown[] = [];
      for (;;) {
        this.ws();
        if (this.s[this.pos] === "]") {
          this.pos++;
          return out;
        }
        out.push(this.value());
        this.ws();
        if (this.s[this.pos] === ",") this.pos++;
        else if (this.s[this.pos] !== "]") this.err("expected , or ]");
      }
    }
    if (c === "{") {
      this.pos++;
      const out: Record<string, unknown> = {};
      for (;;) {
        this.ws();
        if (this.s[this.pos] === "}") {
          this.pos++;
          return out;
        }
        const k = this.scalar(true);
        this.ws();
        let v: unknown = null;
        if (this.s[this.pos] === ":") {
          this.pos++;
          v = this.value();
        }
        out[String(k)] = v;
        this.ws();
        if (this.s[this.pos] === ",") this.pos++;
        else if (this.s[this.pos] !== "}") this.err("expected , or }");
      }
    }
    return this.scalar(false);
  }

  scalar(isKey: boolean): unknown {
    this.ws();
    const c = this.s[this.pos];
    if (c === '"' || c === "'") {
      const end = closingQuote(this.s.slice(this.pos), c);
      if (end < 0) this.err("unterminated string");
      const body = this.s.slice(this.pos + 1, this.pos + end);
      this.pos += end + 1;
      return c === '"' ? unquoteDouble(body) : body.replace(/''/g, "'");
    }
    const start = this.pos;
    while (this.pos < this.s.length) {
      const ch = this.s[this.pos];
      if (ch === "," || ch === "]" || ch === "}") break;
      if (ch === ":" && (isKey || /[\s,\]}]/.test(this.s[this.pos + 1] ?? " "))) break;
      this.pos++;
    }
    const raw = this.s.slice(start, this.pos);
    if (/^[&*!]/.test(raw.trim())) this.err("anchors, aliases and tags aren't supported");
    return isKey ? raw.trim() : plainScalar(raw);
  }
}
