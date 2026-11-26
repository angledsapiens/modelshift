// Builds an animated terminal SVG (CSS keyframes, no scripts) from a real captured modelshift run.
// Usage: node make-demo-svg.mjs <output.txt> <command> <out.svg>
import { readFileSync, writeFileSync } from "node:fs";

const [, , inFile, command, outFile] = process.argv;
const COLS = 98, FONT = 14, LH = 20, PADX = 20, TOP = 52, CHARW = 8.43;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Wrap like a terminal of COLS columns (hard wrap, no indent), keeping the original line's role.
const raw = readFileSync(inFile, "utf8").replace(/\r/g, "").replace(/\s+$/, "").split("\n").map((l) => l.replace(/\s+$/, ""));
const lines = [];
for (const l of raw) {
  if (l.length <= COLS) { lines.push(l); continue; }
  // wrap at word boundaries for readability, continuation lines keep the 4-space indent of detail lines
  const indent = l.match(/^\s*/)[0];
  let rest = l, first = true;
  while (rest.length > COLS) {
    let cut = rest.lastIndexOf(" ", COLS);
    if (cut <= indent.length) cut = COLS;
    lines.push(rest.slice(0, cut));
    rest = indent + rest.slice(cut).trimStart();
    first = false;
  }
  lines.push(rest);
}

// Colour by meaning (the CLI prints plain text; colours only help scanning).
function render(l) {
  let m;
  if ((m = l.match(/^● (SILENTLY REDIRECTED|ALREADY SHUT DOWN|REMOVED[^ ]*)(.*)$/))) return `<tspan class="r">● ${esc(m[1])}</tspan><tspan class="w">${esc(m[2])}</tspan>`;
  if ((m = l.match(/^● (RETIRING|CHECK ALIAS)(  )(\S+)(.*)$/))) return `<tspan class="a">● ${esc(m[1])}</tspan>${m[2]}<tspan class="w">${esc(m[3])}</tspan><tspan class="d">${esc(m[4])}</tspan>`;
  if ((m = l.match(/^(\s+)(actually served: )(.*)$/))) return `${m[1]}<tspan class="d">${esc(m[2])}</tspan><tspan class="r">${esc(m[3])}</tspan>`;
  if ((m = l.match(/^(\s+)(replacement: )(.*)$/))) return `${m[1]}<tspan class="d">${esc(m[2])}</tspan><tspan class="g">${esc(m[3])}</tspan>`;
  if (/^modelshift scan/.test(l)) return `<tspan class="w b">${esc(l)}</tspan>`;
  if (/need attention/.test(l)) return `<tspan class="w b">${esc(l)}</tspan>`;
  if (/^\s+live:/.test(l)) return `<tspan class="g">${esc(l)}</tspan>`;
  return `<tspan class="d">${esc(l)}</tspan>`;
}

// Timeline (seconds): type the command, short "thinking" pause, then lines stream in, hold, fade, loop.
const TYPE_START = 0.6, TYPE_DUR = 1.6, THINK = 1.4, PER_LINE = 0.09, HOLD = 6;
const outStart = TYPE_START + TYPE_DUR + 0.3 + THINK;
const T = +(outStart + lines.length * PER_LINE + HOLD).toFixed(2);
const pct = (s) => +((s / T) * 100).toFixed(3);

const W = Math.round(PADX * 2 + COLS * CHARW);
const H = TOP + (lines.length + 2) * LH + 16;
const cmdY = TOP;
const css = [];
css.push(`.t{font:${FONT}px ui-monospace,SFMono-Regular,"Cascadia Mono",Menlo,Consolas,monospace;white-space:pre}`);
css.push(`.w{fill:#e6edf3}.d{fill:#8b949e}.r{fill:#ff7b72}.a{fill:#e3b341}.g{fill:#3fb950}.b{font-weight:700}`);
// Typing: reveal the command with a clip rectangle growing in steps.
const cmdText = `$ ${command}`;
const cmdW = cmdText.length * CHARW + 2;
css.push(`#typer{animation:type ${T}s steps(${command.length},end) infinite}`);
css.push(`@keyframes type{0%,${pct(TYPE_START)}%{width:${(2 * CHARW).toFixed(1)}px}${pct(TYPE_START + TYPE_DUR)}%,97%{width:${cmdW.toFixed(1)}px}100%{width:${(2 * CHARW).toFixed(1)}px}}`);
css.push(`.cursor{animation:blink 1s step-end infinite}@keyframes blink{50%{opacity:0}}`);
css.push(`#cur{animation:curmove ${T}s steps(${command.length},end) infinite}`);
css.push(`@keyframes curmove{0%,${pct(TYPE_START)}%{transform:translateX(0)}${pct(TYPE_START + TYPE_DUR)}%,${pct(outStart)}%{transform:translateX(${(command.length * CHARW).toFixed(1)}px)}${pct(outStart) + 0.01}%,100%{transform:translateX(${(command.length * CHARW).toFixed(1)}px);opacity:0}}`);
const body = [];
lines.forEach((l, i) => {
  const at = pct(outStart + i * PER_LINE);
  css.push(`.l${i}{opacity:0;animation:l${i} ${T}s step-end infinite}@keyframes l${i}{0%{opacity:0}${at}%{opacity:1}97%{opacity:0}}`);
  body.push(`<text class="t l${i}" x="${PADX}" y="${cmdY + (i + 2) * LH}">${render(l)}</text>`);
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Terminal recording: ${esc(cmdText)} finds a silently redirected model and three retiring models">
<title>modelshift scan --live --probe (real output, recorded ${new Date().toISOString().slice(0, 10)})</title>
<style>${css.join("")}</style>
<rect width="${W}" height="${H}" rx="10" fill="#0d1117"/>
<rect width="${W}" height="32" rx="10" fill="#161b22"/><rect y="22" width="${W}" height="10" fill="#161b22"/>
<circle cx="20" cy="16" r="6" fill="#ff5f57"/><circle cx="40" cy="16" r="6" fill="#febc2e"/><circle cx="60" cy="16" r="6" fill="#28c840"/>
<text class="t d" x="${W / 2}" y="21" text-anchor="middle" style="font-size:12px">~/support-app</text>
<defs><clipPath id="cmdclip"><rect id="typer" x="${PADX}" y="${cmdY - LH + 4}" width="${(2 * CHARW).toFixed(1)}" height="${LH}"/></clipPath></defs>
<text class="t" x="${PADX}" y="${cmdY}" clip-path="url(#cmdclip)"><tspan class="g">$ </tspan><tspan class="w">${esc(command)}</tspan></text>
<g id="cur"><rect class="cursor" x="${(PADX + 2 * CHARW).toFixed(1)}" y="${cmdY - FONT + 2}" width="${CHARW.toFixed(1)}" height="${FONT + 3}" fill="#e6edf3"/></g>
${body.join("\n")}
</svg>
`;
writeFileSync(outFile, svg);
console.log(`${lines.length} lines, cycle ${T}s, ${W}x${H}, ${svg.length} bytes`);
