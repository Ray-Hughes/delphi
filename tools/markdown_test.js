#!/usr/bin/env node
// test-runtime: electron
//
// The one Markdown renderer (ui/markdown.js), its highlighter (ui/highlight.js)
// and the checkboxes they make live.
//
//   electron tools/markdown_test.js
//
// Three layers, because the risks are different at each:
//
//   the parser and the highlighter, pure, against a small fake document: what
//     each construct becomes, that no hostile input reaches an attribute or a
//     tag this file did not choose, and that nothing spins or overflows;
//   the store: a tick by line number through pads.js and db.js, with two lines
//     of identical text, so the board's task and the pad's anchors stay right;
//   the real app in a hidden window on a temp database: the drawer's pad and
//     description, ticked by clicking, and a 2,000-line pad drawn inside the
//     budget.
//
// No real database is opened: DELPHI_DATA_DIR and DELPHI_DB point at a temp
// folder before anything is required.

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-md-")));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
delete process.env.DELPHI_DB_ID;
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}
fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ vaultEnabled: false }));

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  } else console.log(`  ok   ${what}`);
}

const MD = require("../ui/markdown.js");
const HL = require("../ui/highlight.js");
const pads = require("../pads");

// --- a fake document ------------------------------------------------------

/** Just what render() calls, recording every attribute so a test can read them all. */
function fakeDocument() {
  class Text { constructor(v) { this.nodeType = 3; this.data = String(v); } get textContent() { return this.data; } }
  class Elem {
    constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = {}; this.children = []; this.listeners = {}; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    append(...kids) { for (const k of kids) this.children.push(typeof k === "string" ? new Text(k) : k); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    fire(type, e = {}) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, stopPropagation() {}, ...e }); }
    get textContent() { return this.children.map((c) => c.textContent).join(""); }
    set textContent(v) { this.children = [new Text(v)]; }
  }
  return { createElement: (t) => new Elem(t), createTextNode: (v) => new Text(v) };
}
const walk = (node, fn) => { fn(node); for (const c of node.children || []) walk(c, fn); };
const all = (root, tag) => { const out = []; walk(root, (n) => { if (n.tagName === tag.toUpperCase()) out.push(n); }); return out; };
const render = (src, opts = {}) => MD.render(src, { document: fakeDocument(), ...opts });

// --- the parser -----------------------------------------------------------

console.log("\nblocks");
{
  const types = (src) => MD.parse(src).map((b) => b.type);
  check("headings, paragraph, hr, quote", types("# A\n\ntext\n\n---\n\n> q"), ["heading", "para", "hr", "quote"]);
  check("heading levels 1 to 6", MD.parse("# a\n## b\n###### f").map((b) => b.level), [1, 2, 6]);
  check("#123 at the start of a line is not a heading", types("#123 is broken"), ["para"]);
  check("an indented heading is a heading (the old hang)", types("  # x"), ["heading"]);
  check("fenced code keeps its language", MD.parse("```ruby\ndef x; end\n```")[0].lang, "ruby");
  check("an unterminated fence runs to the end", MD.parse("```\na\nb")[0].text, "a\nb");
  check("a tilde fence", MD.parse("~~~sh\nls\n~~~")[0].lang, "sh");
  const t = MD.parse("| a | b |\n|:-|-:|\n| 1 | 2 |\n| 3 |")[0];
  check("a table, aligned, rows padded", [t.type, t.head, t.align, t.rows], ["table", ["a", "b"], ["left", "right"], [["1", "2"], ["3", ""]]]);
  check("a pipe in a code span stays in its cell", MD.parse("| `a|b` | c |\n|---|---|\n| 1 | 2 |")[0].head, ["`a|b`", "c"]);
  const nested = MD.parse("- one\n  - two\n    - three\n- four")[0];
  check("nested lists", [nested.items.length, nested.items[0].children[1].type, nested.items[0].children[1].items[0].children[1].type], [2, "list", "list"]);
  const ol = MD.parse("3. c\n4. d")[0];
  check("an ordered list keeps its start", [ol.ordered, ol.start], [true, 3]);
  check("bullets then numbers are two lists", types("- a\n1. b"), ["list", "list"]);
  check("a loose list stays one list", MD.parse("- a\n\n- b")[0].items.length, 2);
  const tasks = MD.parse("- [ ] open\n- [x] done\n- [X] done too\n- [] not one")[0].items.map((i) => i.task && i.task.checked);
  check("task items, and [] is not one", tasks, [false, true, true, null]);
  const quoted = MD.parse("> - [ ] in a quote")[0].children[0].items[0].task;
  check("a task inside a quote keeps its source line", quoted, { checked: false, n: 0 });
  const deep = MD.parse("text\n\n- a\n  - [ ] b\n    - [x] c")[1].items[0].children[1].items[0];
  check("a nested task keeps its source line", [deep.task.n, deep.children[1].items[0].task.n], [3, 4]);
  check("CRLF reads as LF", MD.parse("# a\r\n\r\ntext").map((b) => b.type), ["heading", "para"]);
  // A lone CR is text, as toggleTask counts lines, so the two agree on which
  // line a box is.
  const lone = MD.parse("a\rb\n- [ ] x")[1].items[0].task.n;
  check("a lone CR does not shift line numbers", [lone, MD.toggleTask("a\rb\n- [ ] x", lone, true)], [1, "a\rb\n- [x] x"]);
}

console.log("\ninline");
{
  const kinds = (s) => MD.inline(s).map((t) => t.t);
  check("code, strong, em, del", kinds("`c` **s** *e* ~~d~~").filter((k) => k !== "text"), ["code", "strong", "em", "del"]);
  check("***both***", MD.inline("***x***")[0], { t: "strong", kids: [{ t: "em", kids: [{ t: "text", v: "x" }] }] });
  check("2 * 3 * 4 stays arithmetic", kinds("2 * 3 * 4"), ["text"]);
  check("snake_case_names stay whole", kinds("a snake_case_name"), ["text"]);
  check("a link", MD.inline("[docs](https://example.com/a \"t\")")[0], { t: "link", href: "https://example.com/a", title: "t", image: false, kids: [{ t: "text", v: "docs" }] });
  check("an autolink", MD.inline("<https://a.dev/x>")[0].href, "https://a.dev/x");
  check("a bare URL, without the full stop after it", MD.inline("see https://a.dev/x.")[1].href, "https://a.dev/x");
  check("a bare URL in parentheses", MD.inline("(https://a.dev/x)")[1].href, "https://a.dev/x");
  check("mailto", MD.inline("[me](mailto:a@b.co)")[0].href, "mailto:a@b.co");
  check("an email autolink", MD.inline("<a@b.co>")[0].href, "mailto:a@b.co");
  check("#123 is a ref", MD.inline("see #123.")[1], { t: "ref", id: 123, v: "#123" });
  check("but not a#1, &#1 or /#1", kinds("a#1 &#1 x/#1"), ["text"]);
  check("an HTML comment is dropped", MD.inline("a <!--d:12--> b"), [{ t: "text", v: "a  b" }]);
  check("a tag is text", MD.inline("<b>x</b>"), [{ t: "text", v: "<b>x</b>" }]);
  check("a backslash escape", MD.inline("\\*not em\\*"), [{ t: "text", v: "*not em*" }]);
  check("two trailing spaces are a hard break", kinds("a  \nb"), ["text", "br", "text"]);
  check("an image is a link to it, never loaded", MD.inline("![alt](https://x.dev/p.png)")[0].image, true);
}

console.log("\nsafety");
{
  const ATTRS = new Set(["class", "type", "checked", "disabled", "data-line", "aria-label", "aria-live", "role", "tabindex", "title", "start", "data-done"]);
  const TAGS = new Set(["DIV", "P", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "PRE", "CODE", "SPAN", "BUTTON", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "UL", "OL", "LI", "INPUT", "STRONG", "EM", "DEL", "A", "BR"]);
  const hostile = [
    "[x](javascript:alert(1))", "[x](JaVaScRiPt:alert(1))", "[x](java\tscript:alert(1))", "[x]( javascript:alert(1))",
    "[x](javascript&#58;alert(1))", "[x](data:text/html,<script>alert(1)</script>)", "[x](vbscript:msgbox)",
    "[x](file:///etc/passwd)", "<javascript:alert(1)>", "![x](javascript:alert(1))", "[x](//evil.com)",
    "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "<a href=\"javascript:alert(1)\">x</a>",
    "[x](https://a.dev\" onmouseover=\"alert(1))", "[x](https://a.dev 'onclick=alert(1)')",
    "```js\" onload=\"alert(1)\n</code><script>x</script>\n```", "| <svg onload=alert(1)> |\n|---|\n| x |",
    "<!-- <script>alert(1)</script> -->", "<iframe src=https://evil.com></iframe>", "<style>body{display:none}</style>",
  ];
  let badTag = [], badAttr = [], badHref = [];
  for (const src of hostile) {
    const root = render(src, { onToggle() {}, onRef() {}, openExternal() {} });
    walk(root, (n) => {
      if (n.nodeType !== 1) return;
      if (!TAGS.has(n.tagName)) badTag.push(`${n.tagName} from ${src}`);
      for (const k of Object.keys(n.attrs)) if (!ATTRS.has(k)) badAttr.push(`${k} from ${src}`);
    });
    for (const t of MD.inline(src)) if (t.t === "link" && !/^(https?:\/\/[^/]|mailto:)/i.test(t.href)) badHref.push(`${t.href} from ${src}`);
  }
  check("hostile input makes no element outside the list", badTag, []);
  check("and no attribute outside the list (no href, no on*, no style, no src)", badAttr, []);
  check("and no link that is not http(s) or mailto", badHref, []);
  const opened = [];
  const root = render("[x](javascript:alert(1)) [y](https://ok.dev)", { openExternal: (u) => opened.push(u) });
  all(root, "a").forEach((a) => a.fire("click"));
  check("only the safe link is opened, through openExternal", opened, ["https://ok.dev"]);
  check("a refused link keeps its words, as text", all(root, "a").length, 1);
  check("a fence's info string never reaches a class name", all(render("```js\" onload=x\na\n```"), "code")[0].attrs.class, "hl lang-js");
  check("safeHref refuses whitespace inside", MD.safeHref("https://a.dev/x y"), null);
  check("safeHref takes https", MD.safeHref("https://a.dev/x"), "https://a.dev/x");
  check("mailto is a bare address only", [MD.safeHref("mailto:a@b.co"), MD.safeHref("mailto:a@b.co?subject=x")], ["mailto:a@b.co", null]);
  check("a fence named constructor or __proto__ is plain", [HL.languageOf("constructor"), HL.languageOf("__proto__"), HL.tokenize("x", "constructor")], [null, null, [[null, "x"]]]);

  // Depth that would overflow a recursive parser.
  const t0 = Date.now();
  let ok = true;
  try {
    render(">".repeat(20000) + " deep");
    render(Array.from({ length: 3000 }, (_, i) => `${" ".repeat(i * 2)}- level ${i}`).join("\n"));
    render("*".repeat(20000));
    render("[".repeat(20000));
    render("**a ".repeat(5000));
    render("`".repeat(3000) + " x " + "``".repeat(1000));
    render("_".repeat(10000) + "x");
    render("[a](".repeat(5000));
    render("<!--".repeat(5000));
  } catch (e) { ok = false; console.error(e); }
  check("very deep nesting and long delimiter runs render without throwing", ok, true);
  check("and quickly", Date.now() - t0 < 3000, true);
  const deep = render(">".repeat(200) + " deep");
  check("quotes stop nesting at the cap", all(deep, "blockquote").length, MD.MAX_BLOCK_DEPTH);
}

console.log("\nnodes");
{
  const root = render("- [ ] a <!--d:7-->\n- [x] b\n\n```sh\necho hi # c\n```\n\nsee #4 and #9");
  const boxes = all(root, "input");
  check("a checkbox per task, with its source line", boxes.map((b) => b.attrs["data-line"]), ["0", "1"]);
  check("disabled without onToggle", boxes.map((b) => "disabled" in b.attrs), [true, true]);
  check("labelled by its words, the anchor left out", boxes[0].attrs["aria-label"], "a");
  check("the anchor is not shown", root.textContent.includes("d:7"), false);
  const code = all(root, "code")[0];
  check("code is coloured", code.children.filter((c) => c.tagName === "SPAN").map((s) => s.attrs.class), ["hl-fn", "hl-com"]);
  check("and its text is exactly the source", code.textContent, "echo hi # c");
  check("a Copy button and a live region", [all(root, "button")[0].textContent, all(root, "span").some((s) => s.attrs["aria-live"] === "polite")], ["Copy", true]);
  check("#N is text without onRef", all(root, "a").length, 0);
  const refs = render("see #4 and #9", { onRef() {}, refTitle: (id) => (id === 4 ? "Four" : null) });
  check("#N is a link only when the task is known", all(refs, "a").map((a) => [a.textContent, a.attrs.title]), [["#4", "#4 Four"]]);

  const ticks = [];
  const live = render("- [ ] same\n- [ ] same", { onToggle: (t) => ticks.push(t) });
  const [b1, b2] = all(live, "input");
  b2.checked = true;
  b2.fire("change");
  check("a tick names the line it came from and the text drawn", ticks.map(({ line, checked, text }) => ({ line, checked, text })), [{ line: 1, checked: true, text: "- [ ] same" }]);
  check("the boxes are enabled with onToggle", "disabled" in b1.attrs, false);
  const two = all(render("- [ ] - [ ] x", { onToggle() {} }), "input").map((b) => "disabled" in b.attrs);
  check("of two boxes on one line, only the first is live", two, [false, true]);

  let copied = null;
  const c = render("```\nx\n```", { copy: (t) => { copied = t; return Promise.resolve(); } });
  all(c, "button")[0].fire("click");
  check("Copy writes the code through the given clipboard", copied, "x");
}

console.log("\ntoggleTask");
{
  const src = "# Plan\n- [ ] same <!--d:4-->\n- [ ] same <!--d:5-->\n  - [x] child\n> - [ ] quoted\n1. [ ] numbered";
  const lines = (s) => s.split("\n");
  check("ticks the second of two identical lines, not the first", lines(MD.toggleTask(src, 2, true, "- [ ] same <!--d:5-->")).slice(1, 3), ["- [ ] same <!--d:4-->", "- [x] same <!--d:5-->"]);
  check("unticks a nested one", lines(MD.toggleTask(src, 3, false))[3], "  - [ ] child");
  check("in a quote", lines(MD.toggleTask(src, 4, true))[4], "> - [x] quoted");
  check("in a numbered list", lines(MD.toggleTask(src, 5, true))[5], "1. [x] numbered");
  check("refuses when the line changed since it was drawn", MD.toggleTask(src, 2, true, "- [ ] something else"), null);
  check("refuses a line that is not a task", MD.toggleTask(src, 0, true), null);
  check("refuses a line past the end", MD.toggleTask(src, 99, true), null);
  check("changes one character, and keeps CRLF", MD.toggleTask("- [ ] a\r\n- [ ] b\r\n", 1, true), "- [ ] a\r\n- [x] b\r\n");
  const done = MD.toggleTask(src, 1, true);
  check("the anchor survives", pads.parse(done).map((e) => [e.taskId, e.done]).slice(0, 2), [[4, true], [5, false]]);
}

console.log("\nthe highlighter");
{
  const kinds = (code, lang) => HL.tokenize(code, lang).filter(([k]) => k).map(([k, t]) => `${k}:${t}`);
  const exact = (code, lang) => HL.tokenize(code, lang).map(([, t]) => t).join("") === code;
  check("js", kinds("const x = foo('a') // c", "js"), ["kw:const", "fn:foo", "str:'a'", "com:// c"]);
  check("ts is js", HL.languageOf("tsx"), "js");
  check("json keys and values", kinds('{"a": 1, "b": "s", "c": true}', "json"), ['key:"a"', "num:1", 'key:"b"', 'str:"s"', 'key:"c"', "num:true"]);
  check("bash", kinds('if [ -f "$HOME/x" ]; then echo $1 # c\nfi', "bash"), ["kw:if", "meta:-f", 'str:"$HOME/x"', "kw:then", "fn:echo", "key:$1", "com:# c", "kw:fi"]);
  check("zsh is sh", HL.languageOf("zsh"), "sh");
  check("python", kinds('@dec\ndef f(x):\n    return None  # c\n"""doc"""', "python"), ["meta:@dec", "kw:def", "fn:f", "kw:return", "num:None", "com:# c", 'str:"""doc"""']);
  check("ruby", kinds('class User < ApplicationRecord\n  has_many :posts\n  def name = @name # c\nend', "ruby"), ["kw:class", "type:User", "type:ApplicationRecord", "key::posts", "kw:def", "key:@name", "com:# c", "kw:end"]);
  check("ruby hash keys", kinds("validates :email, presence: true", "rb"), ["key::email", "key:presence:", "num:true"]);
  check("sql, any case", kinds("SELECT id FROM t WHERE a = 'x' -- c", "sql"), ["kw:SELECT", "kw:FROM", "kw:WHERE", "str:'x'", "com:-- c"]);
  check("yaml", kinds("name: app # c\nlist:\n  - 3", "yaml"), ["key:name", "com:# c", "key:list", "num:3"]);
  check("html", kinds('<a href="x">t</a><!-- c -->', "html"), ["tag:<a", "key:href", 'str:"x"', "tag:>", "tag:</a>", "com:<!-- c -->"]);
  check("css", kinds(".a { color: #fff; margin: 2px; }", "css"), ["key:color", "num:#fff", "key:margin", "num:2px"]);
  check("diff", kinds("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n same", "diff"), ["meta:--- a\n+++ b\n@@ -1 +1 @@", "del:-old", "add:+new"].flatMap((s) => s.startsWith("meta") ? ["meta:--- a", "meta:+++ b", "meta:@@ -1 +1 @@"] : [s]));
  check("markdown", kinds("# T\n- `x` **b**", "md"), ["kw:# T", "meta:-", "str:`x`", "key:**b**"]);
  check("an unknown language is plain", HL.tokenize("a b", "cobol"), [[null, "a b"]]);
  const samples = { js: "x = `a${b}` /* c", json: '{"a": [1, -2.5e3]}', sh: "a=$(ls) 'q", py: "f'{x}' r'\\d'", rb: "%w[a b] =begin\nx\n=end", sql: "x = 'it''s'", yaml: "a: 'b' &x", html: "<p class='x'>&amp;", css: "@media (x) { a:hover { b: 1em } }", diff: "+a\n-b", md: "> q [l](u)" };
  check("every language gives back exactly its input", Object.entries(samples).filter(([l, s]) => !exact(s, l)).map(([l]) => l), []);
  const big = "const a = 'x'; // y\n".repeat(2500);
  const t0 = Date.now();
  const ok = exact(big, "js");
  check("50,000 characters of js, exactly, in well under a second", [ok, Date.now() - t0 < 500], [true, true]);
  check("past the cap it is plain", HL.tokenize("x".repeat(HL.MAX + 1), "js").length, 1);
}

console.log("\nthe store: a tick by line, with two identical lines");
{
  const db = require("../db");
  const project = db.createProject({ key: "md", name: "Markdown" });
  let pad = db.createScratchpad({ projectId: project.id, key: "plan", title: "Plan", body: "# Plan\n- [ ] check the logs\n- [ ] check the logs\n- [ ] review me" });
  const entries = pads.parse(pad.body);
  const [first, second, third] = entries.map((e) => e.taskId);
  check("three lines, three tasks, all anchored", [entries.length, new Set([first, second, third]).size, entries.every((e) => e.taskId)], [3, 3, true]);
  // The drawer's route for a line that is not a filed task: flip the line in
  // the pad as stored and write it, and the derivation does the rest.
  const lines = pad.body.split("\n");
  const next = MD.toggleTask(pad.body, 2, true, lines[2]);
  pad = db.writeScratchpad(pad.id, { body: next, author: "you" });
  check("the second task is done, the first is not", [db.getTask ? null : null, statusOf(db, first), statusOf(db, second)].slice(1), ["todo", "done"]);
  check("the anchors are where they were", pads.parse(pad.body).map((e) => e.taskId), [first, second, third]);
  // The route for a filed task: the board's own update, whose write-back
  // rewrites the line it is anchored to.
  db.updateTask(first, { status: "done" });
  pad = db.getScratchpad(pad.id);
  check("the board's tick writes back to the first line only", pads.parse(pad.body).map((e) => e.done), [true, true, false]);
  // Held by an agent and In progress: a pad write never drags it back to to
  // do, and a tick finishes it, as on the board. (In review is a status a
  // newer Delphi writes; this schema refuses it, and statusFor treats it as it
  // treats doing, so the doing case covers it.)
  db.updateTask(third, { status: "doing" });
  db.handle().prepare("UPDATE tasks SET queue = 'default', claimed_by = 'claude-code' WHERE id = ?").run(third);
  pad = db.writeScratchpad(pad.id, { body: db.getScratchpad(pad.id).body + "\nmore prose", author: "you" });
  check("a pad write leaves an agent-held task In progress", statusOf(db, third), "doing");
  check("and its line unticked", pads.parse(pad.body)[2].done, false);
  db.updateTask(third, { status: "done" });
  check("ticked from the board, it is done and its line ticked", [statusOf(db, third), pads.parse(db.getScratchpad(pad.id).body)[2].done], ["done", true]);
  check("pads.statusFor keeps In review on an unticked line", pads.statusFor(false, "review"), "review");
}

function statusOf(db, id) {
  return db.handle().prepare("SELECT status FROM tasks WHERE id = ?").get(id).status;
}

// --- the real app ---------------------------------------------------------

const electron = require("electron");
const { app } = electron;
if (app.setActivationPolicy) app.setActivationPolicy("prohibited");
const ROOT = path.join(__dirname, "..");
let win = null;
class HiddenWindow extends electron.BrowserWindow {
  constructor(options = {}) { super({ ...options, show: false, paintWhenInitiallyHidden: true, width: 1440, height: 900 }); win = this; }
  loadFile(file, options) { return super.loadFile(path.resolve(ROOT, file), options); }
  show() {}
  focus() {}
}
const quiet = new Proxy(function stub() {}, { get: () => quiet, apply: () => quiet, construct: () => quiet });
const stubbed = new Proxy(electron, {
  get: (target, key) => {
    if (key === "BrowserWindow") return HiddenWindow;
    if (key === "Tray") return quiet;
    if (key === "globalShortcut") return { register: () => true, unregister() {}, unregisterAll() {}, isRegistered: () => false };
    return target[key];
  },
});
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  return request === "electron" ? stubbed : realLoad.call(this, request, ...rest);
};

const db = require("../db");
const project = db.createProject({ key: "win", name: "Window" });
const padBody = "## Plan\n- [ ] same line\n- [ ] same line\n\n```ruby\nputs :hi\n```";
const winPad = db.createScratchpad({ projectId: project.id, key: "win", title: "Window plan", body: padBody });
const desc = db.createTask({ projectId: project.id, title: "Has a list", detail: "- [ ] twice\n- [ ] twice" });
const big = Array.from({ length: 2000 }, (_, i) => (i % 50 === 0 ? `## Part ${i}` : i % 7 === 0 ? "```js\nconst x = 1;\n```" : i % 3 === 0 ? `- [ ] step ${i} with **bold** and \`code\` <!--d:${i}-->` : `Prose line ${i} with a [link](https://example.com/${i}) and #12.`)).join("\n");
require("../main.js");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await app.whenReady();
  if (app.dock) app.dock.hide();
  for (let i = 0; i < 100 && !win; i++) await wait(100);
  if (!win) throw new Error("no window");
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const until = async (code, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) { if (await js(code)) return true; await wait(100); }
    return false;
  };
  await until("typeof DelphiDrawer === 'object' && typeof DelphiMarkdown === 'object' && !!document.querySelector('#switcher .scope')");
  await js("window.confirm = () => true; window.alert = () => {}; localStorage.clear(); 0");
  await js(`navigate({ projectId: ${project.id}, view: "pads", query: "" }).then(() => 1)`);
  await wait(400);

  console.log("\nin the window");
  // A real DOM, under the app's CSP: hostile input again, read back from the page.
  const leaks = await js(`(() => {
    const src = ${JSON.stringify("[x](javascript:alert(1)) <img src=x onerror=alert(1)> <script>alert(1)</script> [y](https://ok.dev)\n\n```js\" onload=\"x\nx\n```")};
    const root = renderMarkdown(src);
    const bad = [];
    for (const n of root.querySelectorAll("*")) {
      if (/^(IMG|SCRIPT|IFRAME|STYLE)$/.test(n.tagName)) bad.push(n.tagName);
      for (const a of n.attributes) if (/^on|^href$|^src$|^style$/i.test(a.name)) bad.push(n.tagName + " " + a.name);
    }
    return bad;
  })()`);
  check("nothing hostile reaches the real DOM", leaks, []);

  const time = await js(`(() => {
    const src = ${JSON.stringify(big)};
    renderMarkdown(src);
    const t0 = performance.now();
    const node = renderMarkdown(src);
    const host = document.createElement("div");
    host.className = "dw-prev";
    host.append(node);
    document.body.append(host);
    host.getBoundingClientRect();
    const ms = performance.now() - t0;
    host.remove();
    return ms;
  })()`);
  console.log(`       a 2,000-line pad rendered and laid out in ${time.toFixed(1)}ms`);
  check("a 2,000-line pad renders in under 100ms", time < 100, true);

  // The drawer's pad, in Preview: tick the second of two identical lines.
  await js(`localStorage.setItem("delphi.drawer.mode.pad", JSON.stringify("preview")); DelphiDrawer.openPad(${winPad.id}).then(() => 1)`);
  await until("document.querySelectorAll('.dw .dw-prev .md-check').length === 2");
  check("the pad's checkboxes are live", await js("[...document.querySelectorAll('.dw .dw-prev .md-check')].map((b) => b.disabled)"), [false, false]);
  check("its code is coloured, with Copy", await js("[!!document.querySelector('.dw .dw-prev .md-code .hl-key'), !!document.querySelector('.dw .dw-prev .md-copy')]"), [true, true]);
  check("its anchors are not shown", await js("document.querySelector('.dw .dw-prev').textContent.includes('d:')"), false);
  const ids = pads.parse(db.getScratchpad(winPad.id).body).map((e) => e.taskId);
  await js("document.querySelectorAll('.dw .dw-prev .md-check')[1].click(), 1");
  await until(`window.delphi.pads.get(${winPad.id}).then((p) => /- \\[x\\] same line/.test(p.body))`);
  await wait(300);
  const after = pads.parse(db.getScratchpad(winPad.id).body);
  check("the second line is ticked in the pad, the first is not", after.map((e) => e.done), [false, true]);
  check("its task is done on the board, the other is not", [statusOf(db, ids[0]), statusOf(db, ids[1])], ["todo", "done"]);
  check("the anchors are intact", after.map((e) => e.taskId), ids);
  check("the preview shows it ticked", await js("[...document.querySelectorAll('.dw .dw-prev .md-check')].map((b) => b.checked)"), [false, true]);

  // An agent appends to the pad while it is open; a tick must not write the
  // window's older copy back over it.
  db.appendScratchpad(winPad.id, "- [ ] added by an agent");
  await js("document.querySelectorAll('.dw .dw-prev .md-check')[0].click(), 1");
  await until(`window.delphi.pads.get(${winPad.id}).then((p) => p.body.startsWith("## Plan\\n- [x]"))`);
  await wait(300);
  const later = db.getScratchpad(winPad.id).body;
  check("a tick keeps what an agent appended meanwhile", later.includes("added by an agent"), true);
  check("and ticked the first line", pads.parse(later).slice(0, 2).map((e) => e.done), [true, true]);

  // Split: the source and the preview side by side, with a handle.
  await js("document.querySelector('.dw [data-act=mode-split]').click(), 1");
  await wait(200);
  check("Split shows the source, a handle and the preview", await js("[...document.querySelector('.dw .dw-ed-body.split').children].map((c) => c.className.split(' ')[0])"), ["dw-raw", "dw-split", "dw-prev"]);
  await js("(() => { const h = document.querySelector('.dw .dw-split'); h.focus(); h.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); return 1; })()");
  check("the handle resizes, and the size is remembered for this surface", await js("JSON.parse(localStorage.getItem('delphi.drawer.split.pad'))"), 0.55);
  check("Split is remembered for pads", await js("JSON.parse(localStorage.getItem('delphi.drawer.mode.pad'))"), "split");

  // A description: two identical lines, the second ticked, saved.
  await js("DelphiDrawer.close(); 1");
  await wait(200);
  await js(`localStorage.setItem("delphi.drawer.mode.task", JSON.stringify("preview")); localStorage.setItem("delphi.drawer.folds", JSON.stringify({ description: true })); DelphiDrawer.open(${desc.id}).then(() => 1)`);
  await until("document.querySelectorAll('.dw [data-fold=description] .md-check').length === 2");
  await js("document.querySelectorAll('.dw [data-fold=description] .md-check')[1].click(), 1");
  await until(`window.delphi.tasks.detail(${desc.id}).then((d) => d.task.detail.includes("[x]"))`);
  check("a description's tick edits its own line", db.handle().prepare("SELECT detail FROM tasks WHERE id = ?").get(desc.id).detail, "- [ ] twice\n- [x] twice");

  // Copy, through the clipboard, said aloud.
  await js(`DelphiDrawer.close(); 1`);
  await wait(200);
  await js(`DelphiDrawer.openPad(${winPad.id}).then(() => 1)`);
  await until("!!document.querySelector('.dw .md-copy')");
  await js("navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }; document.querySelector('.dw .md-copy').click(), 1");
  await wait(150);
  check("Copy copies the code and says so", await js("[window.__copied, document.querySelector('.dw .md-copy').textContent, document.querySelector('.dw .md-live').textContent]"), ["puts :hi", "Copied", "Copied to the clipboard"]);

  // The Pads tab hosts the same editor.
  await js("DelphiDrawer.close(); 1");
  await wait(200);
  await js(`state.padId = ${winPad.id}; state.padRaw = true; render(); 1`);
  await wait(300);
  check("the Pads tab has Write, Preview and Split", await js("[...document.querySelectorAll('.pad-pane .dw-ed [data-act^=mode-]')].map((b) => b.dataset.act)"), ["mode-write", "mode-preview", "mode-split"]);

  console.log(`\n${checks - failures}/${checks} passed`);
}

main()
  .catch((error) => { failures++; console.error(error); })
  .finally(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    app.exit(failures ? 1 : 0);
  });
