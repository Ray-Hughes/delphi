#!/usr/bin/env node
// test-runtime: node
// Every ink in styles/tokens.css against every ground, in every theme.
//
//   node tools/contrast_test.js
//
// The v2 palette's own colours fail as text (#6366F1 on white is 4.47:1), so
// each colour has a fill and an -ink, and text is meant to use the ink. This
// reads the real stylesheet rather than a copy of the values, so a token edited
// later is checked against WCAG AA (4.5:1) the moment it changes.
//
// The themes are Light, Paper and Dark, and the "Soft" dark kept in a comment
// at the end of the file as the owner's other choice: it is checked like a
// shipped theme, so swapping it in can never be the change that breaks AA.
//
// It also checks that the two dark blocks are the same, because they are the
// same set written twice (CLAUDE.md, Theming) and they have drifted before,
// and that every theme sets every colour the light set has, because a token
// a theme forgets falls through to light's value on that theme's ground.
//
// --ink-faint is held to 3:1, not 4.5. It is for what is read second (counts,
// stamps, hints) and sits near 3:1 by design, as the token file says. Light's
// own two exceptions are named below (EXEMPT), not left out silently.

const fs = require("fs");
const path = require("path");

const raw = fs.readFileSync(path.join(__dirname, "..", "styles", "tokens.css"), "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

let checks = 0;
let failures = 0;
function check(what, ok, detail) {
  checks++;
  if (ok) { console.log(`  ok   ${what}`); return; }
  failures++;
  console.error(`  FAIL ${what}${detail ? `\n       ${detail}` : ""}`);
}

/** The declarations inside the first block whose selector matches, and its text. */
function block(selectorPattern, text = css) {
  const at = text.search(selectorPattern);
  if (at < 0) return null;
  const open = text.indexOf("{", at);
  let depth = 1;
  let i = open + 1;
  for (; i < text.length && depth; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
  }
  return declarations(text.slice(open + 1, i - 1));
}
function declarations(body) {
  const vars = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[name] = value.trim();
  const scheme = body.match(/(?:^|[;{\s])color-scheme\s*:\s*([^;]+);/);
  Object.defineProperty(vars, "colorScheme", { value: scheme ? scheme[1].trim() : null, enumerable: false });
  return vars;
}

const light = block(/(^|\n):root\s*\{/);
const paperOwn = block(/:root\[data-theme="paper"\]\s*\{/);
const darkMedia = block(/:root:not\(\[data-theme="light"\]\):not\(\[data-theme="paper"\]\)\s*\{/);
const darkPinned = block(/:root\[data-theme="dark"\]\s*\{/);
// The candidate is a comment, so it is read from the file before comments go.
const softText = (raw.match(/\/\* candidate: dark soft([\s\S]*?)end candidate \*\//) || [])[1];
const softOwn = softText ? declarations(softText) : null;

const THEMES = [
  ["light", light],
  ["paper", { ...light, ...paperOwn }],
  ["dark", { ...light, ...darkPinned }],
  ["dark soft (candidate)", { ...light, ...softOwn }],
];

function resolve(vars, name, seen = new Set()) {
  const v = vars[name];
  if (v == null) return null;
  const ref = v.match(/^var\((--[\w-]+)\)$/);
  if (!ref) return v;
  if (seen.has(name)) return null;
  seen.add(name);
  return resolve(vars, ref[1], seen);
}

function rgb(value) {
  const hex = String(value).match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hex) return null;
  const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function luminance([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** One pair, checked: both must be plain hex, and the ratio at least min. */
function pair(vars, fg, bg, min) {
  const a = rgb(resolve(vars, fg));
  const b = rgb(resolve(vars, bg));
  if (!a || !b) { check(`${fg} on ${bg} is a plain hex colour`, false, `${resolve(vars, fg)} on ${resolve(vars, bg)}`); return; }
  const r = ratio(a, b);
  check(`${fg} on ${bg}: ${r.toFixed(2)}:1`, r >= min, `${resolve(vars, fg)} on ${resolve(vars, bg)}, needs ${min}:1`);
}

// What a person reads, and what it is read on. The grounds include the
// window's frame (--chrome), where a bar or a segmented control puts the same
// inks. --chrome-deep is declared but no stylesheet paints with it yet; the
// day one does, it belongs in this list.
const INKS = ["--ink", "--ink-dim", "--accent-ink", "--good-ink", "--warn-ink", "--crit-ink",
              "--kind-say", "--kind-agent", "--kind-run", "--kind-ask", "--kind-decide", "--kind-note", "--kind-ledger",
              "--run-ok", "--run-fail", "--run-busy"];
const GROUNDS = ["--bg", "--surface", "--raised", "--chrome"];
// Task colours are promised as text on --surface, the card they label (the
// comment on them in tokens.css), so that is the ground they are held to.
const TASK_COLOURS = ["--tc-blue", "--tc-teal", "--tc-green", "--tc-amber", "--tc-orange", "--tc-red", "--tc-purple", "--tc-slate"];
// Light is Direction B's set and signed off as it is. Two of its values sit
// under the rules this file now holds every theme to, and are named here so
// they stay a decision rather than a drift: --ink-faint at 2.7 to 3:1 (read
// second, by design), and the amber fill #F59E0B at 2.15:1 as a mark (never
// the only sign of a state, which carries its word beside it). Paper and dark
// meet both rules.
const EXEMPT = new Set(["light --ink-faint", "light --warn"]);
// Colour tokens every theme must set. What is not a colour (spacing, radii,
// faces, the curve) is shared, and --shadow is a reference to --shadow-2.
const SHARED = /^--(s\d|r|r-sm|r-lg|font|display|mono|ease|shadow)$/;

console.log("\nthe token blocks");
check("the light set is there", Boolean(light && light["--bg"]));
check("the paper set is there", Boolean(paperOwn && paperOwn["--bg"]));
check("the dark set is there, under the media query, guarded from both light themes", Boolean(darkMedia && darkMedia["--bg"]),
  'the selector is :root:not([data-theme="light"]):not([data-theme="paper"]), or a pinned Paper turns dark on a dark Mac');
check("and again for a pinned dark theme", Boolean(darkPinned && darkPinned["--bg"]));
check("the soft candidate is there, in its comment", Boolean(softOwn && softOwn["--bg"]));
check("the two dark blocks are the same set", JSON.stringify(darkMedia) === JSON.stringify(darkPinned),
  "edit them together: one is used when the system is dark, the other when Dark is chosen");
for (const [name, own] of [["paper", paperOwn], ["dark", darkPinned], ["dark soft", softOwn]]) {
  const extra = Object.keys(own || {}).filter((k) => !(k in light));
  check(`every name the ${name} set redefines exists in the light set`, extra.length === 0, extra.join(", "));
  const gaps = Object.keys(light).filter((k) => !SHARED.test(k) && !(k in (own || {})));
  check(`the ${name} set gives every colour token its own value`, gaps.length === 0, `missing: ${gaps.join(", ")}`);
}
check("light and paper say color-scheme: light", [light.colorScheme, paperOwn && paperOwn.colorScheme].join() === "light,light",
  `${light.colorScheme}, ${paperOwn && paperOwn.colorScheme}`);
check("both dark blocks and the candidate say color-scheme: dark",
  [darkMedia, darkPinned, softOwn].every((b) => b && b.colorScheme === "dark"));

for (const [theme, vars] of THEMES) {
  console.log(`\n${theme}: inks on grounds, at least 4.5:1`);
  for (const ink of INKS) for (const ground of GROUNDS) pair(vars, ink, ground, 4.5);
  for (const ink of TASK_COLOURS) pair(vars, ink, "--surface", 4.5);
  if (EXEMPT.has(`${theme} --ink-faint`)) { console.log("  --   --ink-faint: the named light exception"); continue; }
  console.log(`\n${theme}: --ink-faint, read second, at least 3:1`);
  for (const ground of GROUNDS) pair(vars, "--ink-faint", ground, 3);
}

// Status and accent fills drawn as marks (a dot, a bar, a toggle's track):
// WCAG's non-text rule, 3:1 against what they sit on.
const FILLS = ["--accent", "--good", "--warn", "--crit"];
for (const [theme, vars] of THEMES) {
  console.log(`\n${theme}: fills drawn as marks, at least 3:1`);
  for (const fill of FILLS) {
    if (EXEMPT.has(`${theme} ${fill}`)) { console.log(`  --   ${fill}: the named light exception`); continue; }
    for (const ground of ["--bg", "--surface", "--raised"]) pair(vars, fill, ground, 3);
  }
}

// Text set on a solid fill: the ink a component puts on it, and the fill.
// The primary button and every danger fill carry --btn-fg (white): the owner's
// call was to darken the fill, not change the text, so these are the pairs.
// A ticked box's check mark on --good is a glyph, not text, so it is 3:1.
const ON_FILLS = [["--on-good", "--good-ink", 4.5], ["--btn-fg", "--btn-primary", 4.5], ["--btn-fg", "--crit-fill", 4.5],
                  ["--on-decide", "--kind-decide", 4.5], ["--on-agent-codex", "--agent-codex", 4.5], ["--on-agent", "--agent-copilot", 4.5],
                  ["--on-good", "--good", 3]];
for (const [theme, vars] of THEMES) {
  console.log(`\n${theme}: text on fills`);
  for (const [ink, fill, min] of ON_FILLS) pair(vars, ink, fill, min);
}

// The ring a focused control draws (--focus-ring, which every :focus-visible
// outline uses), on every ground. 3:1, WCAG's focus appearance floor. The
// accent a person picks is checked against the same rule by settings_test.
for (const [theme, vars] of THEMES) {
  console.log(`\n${theme}: the focus ring, at least 3:1`);
  for (const ground of GROUNDS) pair(vars, "--focus-ring", ground, 3);
}
{
  const dir = path.join(__dirname, "..", "styles");
  const loose = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".css"))) {
    const text = fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, sel, body] of text.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
      if (!/focus/.test(sel)) continue;
      if (/outline\s*:[^;]*var\(--accent\)|box-shadow\s*:[^;]*inset 0 0 0 2px var\(--accent\)/.test(body)) loose.push(`${f}: ${sel.trim()}`);
    }
  }
  console.log("\nfocus rings are drawn in --focus-ring");
  check("no focus rule outlines in --accent itself", loose.length === 0, loose.join("; "));
}

// The highlighter's colours (ui/highlight.js, styles/markdown.css), on the
// code ground a block sits on and on the grounds a code span or the drawer's
// source pane can sit on. Comments included: a comment is read, not skimmed.
const CODE_INKS = ["--ink", "--kw", "--str", "--key", "--tag", "--hl-com", "--hl-num", "--hl-add", "--hl-del", "--hl-meta"];
const CODE_GROUNDS = ["--code-bg", "--raised", "--surface"];
for (const [theme, vars] of THEMES) {
  console.log(`\n${theme}: code colours on code grounds, at least 4.5:1`);
  for (const ink of CODE_INKS) for (const ground of CODE_GROUNDS) pair(vars, ink, ground, 4.5);
}
{
  // Every colour the stylesheet gives a token type is one of the checked
  // tokens, so a new type cannot arrive with an unchecked colour.
  const mdCss = fs.readFileSync(path.join(__dirname, "..", "styles", "markdown.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const used = [...mdCss.matchAll(/\.hl-[\w-]+[^{]*\{[^}]*color\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
  console.log("\nmarkdown.css: every token colour is a checked token");
  check("the highlighter colours its tokens", used.length >= 8, `${used.length} found`);
  const loose = used.filter((v) => { const m = v.match(/^var\((--[\w-]+)\)$/); return !m || !CODE_INKS.includes(m[1]); });
  check("each is var() of a checked ink", loose.length === 0, loose.join(", "));
}

// Focus's peek is quiet by colour (--ink-dim, checked above), never by
// opacity: a faded --ink drops under 4.5:1 in both themes and no token check
// can see it, so the stylesheet itself is read.
{
  const focusCss = fs.readFileSync(path.join(__dirname, "..", "styles", "focus.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const faded = [...focusCss.matchAll(/([^{}]*)\{([^}]*)\}/g)]
    .filter(([, sel, body]) => /\.fx-next|\.fx-peek/.test(sel) && /opacity\s*:\s*0?\.\d/.test(body)).map(([, sel]) => sel.trim());
  console.log("\nfocus: text is never faded below AA by opacity");
  check(".fx-next and .fx-peek set no partial opacity", faded.length === 0, faded.join(", "));
}

// The drawer's labels a person acts on or has to read (the crumb, status and
// editor modes, a folded section's summary, what the composer will do) use
// --ink-dim, which the token checks above hold to AA. --ink-faint is ~3:1.
{
  const drawerCss = fs.readFileSync(path.join(__dirname, "..", "styles", "drawer.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const MUST = [".dw-crumb", ".dw-statusbar button", ".dw-fold-h .sum", ".dw-seg button", ".dw-sense"];
  console.log("\ndrawer: labels a person acts on are --ink-dim or stronger");
  for (const sel of MUST) {
    const rule = [...drawerCss.matchAll(/([^{}]*)\{([^}]*)\}/g)].find(([, s]) => s.trim() === sel);
    const colour = rule && (rule[2].match(/(?:^|;)\s*color\s*:\s*([^;!]+)/) || [])[1];
    check(`${sel} is not --ink-faint`, Boolean(colour) && !/--ink-faint/.test(colour), colour || "no colour rule");
  }
}

// Edit this page: the dashed outline, a hidden section's, and the focus ring,
// each at least 3:1 (WCAG non-text) on every ground in every theme. The ring
// is its own token, not the accent, so no accent choice can take it under.
for (const [theme, vars] of THEMES) {
  console.log(`\n${theme}: Edit this page's outlines and focus ring, at least 3:1`);
  for (const token of ["--ly-outline", "--ly-outline-quiet", "--ly-focus"]) {
    for (const ground of ["--bg", "--surface", "--raised"]) pair(vars, token, ground, 3);
  }
  const ring = rgb(resolve(vars, "--ly-focus"));
  const dashed = rgb(resolve(vars, "--ly-outline"));
  const apart = ring && dashed ? ratio(ring, dashed) : 0;
  check(`the focus ring stands apart from the dashed outline: ${apart.toFixed(2)}:1`, apart >= 3, `${resolve(vars, "--ly-focus")} against ${resolve(vars, "--ly-outline")}`);
}
{
  const layoutCss = fs.readFileSync(path.join(__dirname, "..", "styles", "layout.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  console.log("\nEdit this page: focus is drawn in its own token");
  check(".ly-cell:focus-visible uses --ly-focus with an offset", /\.ly-cell:focus-visible \{[^}]*outline: 2px solid var\(--ly-focus\); outline-offset: 3px/.test(layoutCss));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
