#!/usr/bin/env node
// test-runtime: node
// Every ink in styles/tokens.css against every ground, in both themes.
//
//   node tools/contrast_test.js
//
// The v2 palette's own colours fail as text (#6366F1 on white is 4.47:1), so
// each colour has a fill and an -ink, and text is meant to use the ink. This
// reads the real stylesheet rather than a copy of the values, so a token edited
// later is checked against WCAG AA (4.5:1) the moment it changes.
//
// It also checks that the two dark blocks are the same, because they are the
// same set written twice (CLAUDE.md, Theming) and they have drifted before.
//
// --ink-faint is left out on purpose. It is for what is read second (counts,
// stamps, hints) and sits near 3:1 by design, as the token file says.

const fs = require("fs");
const path = require("path");

const css = fs.readFileSync(path.join(__dirname, "..", "styles", "tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

let checks = 0;
let failures = 0;
function check(what, ok, detail) {
  checks++;
  if (ok) { console.log(`  ok   ${what}`); return; }
  failures++;
  console.error(`  FAIL ${what}${detail ? `\n       ${detail}` : ""}`);
}

/** The declarations inside the first block whose selector matches. */
function block(selectorPattern) {
  const at = css.search(selectorPattern);
  if (at < 0) return null;
  const open = css.indexOf("{", at);
  let depth = 1;
  let i = open + 1;
  for (; i < css.length && depth; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
  }
  const vars = {};
  for (const [, name, value] of css.slice(open + 1, i - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[name] = value.trim();
  return vars;
}

const light = block(/(^|\n):root\s*\{/);
const darkMedia = block(/:root:not\(\[data-theme="light"\]\)\s*\{/);
const darkPinned = block(/:root\[data-theme="dark"\]\s*\{/);

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

// What a person reads, and what it is read on.
const INKS = ["--ink", "--ink-dim", "--accent-ink", "--good-ink", "--warn-ink", "--crit-ink",
              "--kind-say", "--kind-note", "--kind-ledger"];
const GROUNDS = ["--bg", "--surface", "--raised"];

console.log("\nthe token blocks");
check("the light set is there", Boolean(light && light["--bg"]));
check("the dark set is there, under the media query", Boolean(darkMedia && darkMedia["--bg"]));
check("and again for a pinned dark theme", Boolean(darkPinned && darkPinned["--bg"]));
check("the two dark blocks are the same set", JSON.stringify(darkMedia) === JSON.stringify(darkPinned),
  "edit them together: one is used when the system is dark, the other when Dark is chosen");
check("every name the dark set redefines exists in the light set", Object.keys(darkPinned || {}).every((k) => k in light),
  Object.keys(darkPinned || {}).filter((k) => !(k in light)).join(", "));

for (const [theme, vars] of [["light", light], ["dark", { ...light, ...darkPinned }]]) {
  console.log(`\n${theme}: inks on grounds, at least 4.5:1`);
  for (const ink of INKS) {
    for (const ground of GROUNDS) {
      const a = rgb(resolve(vars, ink));
      const b = rgb(resolve(vars, ground));
      if (!a || !b) { check(`${ink} on ${ground} is a plain hex colour`, false, `${resolve(vars, ink)} on ${resolve(vars, ground)}`); continue; }
      const r = ratio(a, b);
      check(`${ink} on ${ground}: ${r.toFixed(2)}:1`, r >= 4.5, `${resolve(vars, ink)} on ${resolve(vars, ground)}`);
    }
  }
}

// Text set on a solid fill: the ink a component puts on it, and the fill.
// The primary button and every danger fill carry --btn-fg (white): the owner's
// call was to darken the fill, not change the text, so these are the pairs.
const ON_FILLS = [["--on-good", "--good-ink"], ["--btn-fg", "--btn-primary"], ["--btn-fg", "--crit-fill"]];
for (const [theme, vars] of [["light", light], ["dark", { ...light, ...darkPinned }]]) {
  console.log(`\n${theme}: text on fills, at least 4.5:1`);
  for (const [ink, fill] of ON_FILLS) {
    const r = ratio(rgb(resolve(vars, ink)), rgb(resolve(vars, fill)));
    check(`${ink} on ${fill}: ${r.toFixed(2)}:1`, r >= 4.5, `${resolve(vars, ink)} on ${resolve(vars, fill)}`);
  }
}

// The highlighter's colours (ui/highlight.js, styles/markdown.css), on the
// code ground a block sits on and on the grounds a code span or the drawer's
// source pane can sit on. Comments included: a comment is read, not skimmed.
const CODE_INKS = ["--ink", "--kw", "--str", "--key", "--tag", "--hl-com", "--hl-num", "--hl-add", "--hl-del", "--hl-meta"];
const CODE_GROUNDS = ["--code-bg", "--raised", "--surface"];
for (const [theme, vars] of [["light", light], ["dark", { ...light, ...darkPinned }]]) {
  console.log(`\n${theme}: code colours on code grounds, at least 4.5:1`);
  for (const ink of CODE_INKS) {
    for (const ground of CODE_GROUNDS) {
      const a = rgb(resolve(vars, ink));
      const b = rgb(resolve(vars, ground));
      if (!a || !b) { check(`${ink} on ${ground} is a plain hex colour`, false, `${resolve(vars, ink)} on ${resolve(vars, ground)}`); continue; }
      const r = ratio(a, b);
      check(`${ink} on ${ground}: ${r.toFixed(2)}:1`, r >= 4.5, `${resolve(vars, ink)} on ${resolve(vars, ground)}`);
    }
  }
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
// each at least 3:1 (WCAG non-text) on every ground in both themes. The ring
// is its own token, not the accent, so no accent choice can take it under.
for (const [theme, vars] of [["light", light], ["dark", { ...light, ...darkPinned }]]) {
  console.log(`\n${theme}: Edit this page's outlines and focus ring, at least 3:1`);
  for (const token of ["--ly-outline", "--ly-outline-quiet", "--ly-focus"]) {
    for (const ground of GROUNDS) {
      const a = rgb(resolve(vars, token));
      const b = rgb(resolve(vars, ground));
      const r = a && b ? ratio(a, b) : 0;
      check(`${token} on ${ground}: ${r.toFixed(2)}:1`, r >= 3, `${resolve(vars, token)} on ${resolve(vars, ground)}`);
    }
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
