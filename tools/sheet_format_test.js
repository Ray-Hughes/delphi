#!/usr/bin/env node
// The Sheet text format, round tripped.
//
//   node tools/sheet_format_test.js
//
// test-runtime: node
//
// Pure: no database and no Electron, so plain node is enough. The format is what
// people copy out of Delphi and paste into a ticket or a terminal, and the ways
// it goes wrong are all quiet: a {} block eaten as text, a fenced "$ " line read
// as an entry, a body that comes back one blank line shorter.

const fs = require("fs");
const path = require("path");
const fmt = require("../sheet/format");

let failures = 0;
let checks = 0;

function check(what, got, want) {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}

function section(name) { console.log(`\n${name}`); }

const FIXTURES = path.join(__dirname, "fixtures", "sheets");
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const names = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".sheet")).sort();

// ---------------------------------------------------------------------------

section("every fixture round trips");

check("the fixtures are all there", names,
      ["ask.sheet", "basic.sheet", "empty.sheet", "fake-meta.sheet", "fences.sheet",
       "multiline.sheet", "noproject.sheet", "quoting.sheet"]);

for (const name of names) {
  const text = fixture(name);
  check(`${name}: format(parse(t)) === t`, fmt.format(fmt.parse(text)), text);
  const cleaned = fmt.clean(text);
  check(`${name}: clean round trips through the clean parse`,
        fmt.format(fmt.parse(cleaned, { clean: true }), { clean: true }), cleaned);
  check(`${name}: clean adds no braces of its own`,
        (cleaned.match(/[{}]/g) || []).length <= (text.match(/[{}]/g) || []).length, true);
  check(`${name}: nothing but blocks is stripped`,
        cleaned.split("\n").length, text.split("\n").length);
  check(`${name}: no raw entries in anything format wrote`,
        fmt.parse(text).entries.filter((e) => e.kind === "raw").length, 0);
}

// ---------------------------------------------------------------------------

section("the spec example");

const basic = fmt.parse(fixture("basic.sheet"));
check("header", basic.header, { task: 42, title: "fix zip DLQ backlog", project: "efolder", status: "doing" });
check("kinds in order", basic.entries.map((e) => e.kind), ["say", "say", "run", "ask", "decide", "note"]);
check("> is a person", [basic.entries[0].author, basic.entries[0].author_type], ["ray", "human"]);
check("@ is an agent", [basic.entries[1].author, basic.entries[1].author_type], ["claude", "agent"]);
check("a say with no block has no id", basic.entries[0].id, null);
check("run meta", basic.entries[2].meta, { state: "ok", dur_ms: 1200, lines: 340 });
check("run author comes from by", basic.entries[2].author, "ray");
check("ask options", basic.entries[3].meta.options,
      [{ key: "a", label: "exponential" }, { key: "b", label: "fixed" }]);
check("ask question", basic.entries[3].body, "retry strategy");
check("decide", [basic.entries[4].body, basic.entries[4].ref_id, basic.entries[4].promoted], ["a", 808, 1]);
check("note filed and promoted", [basic.entries[5].note_kind, basic.entries[5].promoted], ["gotcha", 1]);

check("clean strips the blocks and nothing else", fmt.clean(fixture("basic.sheet")), [
  "---",
  "task: 42",
  "title: fix zip DLQ backlog",
  "project: efolder",
  "status: doing",
  "---",
  "> ray: why is the DLQ filling up?",
  "@ claude: visibility timeout is under p95 job time",
  "$ aws sqs get-queue-attributes --queue-url ...",
  "? retry strategy: [a] exponential [b] fixed",
  "= a",
  "! bump timeout to 15m before deploy",
  "",
].join("\n"));

// ---------------------------------------------------------------------------

section("bodies");

const multi = fmt.parse(fixture("multiline.sheet"));
check("continuation lines lose exactly two spaces", multi.entries[0].body,
      "first line\nsecond line\n\nafter a blank line\n  indented four\n \nthe line above is one space of content");
check("an actor name with a colon is still one author",
      [multi.entries[1].author, multi.entries[1].body], ["claude-code:12", "summary\n- point one\n- point two"]);
check("leading space on the first line is kept", multi.entries[2].body, " leading space on the first line is content\nmiddle\n\nend");
check("the why of a decide is its body after the key", multi.entries[3].body.split("\n")[0], "b");
check("unicode is untouched", multi.entries[3].body.includes("caf\u00e9 is"), true);
check("an empty say", [multi.entries[4].author, multi.entries[4].body, multi.entries[4].id], ["you", "", 6]);

const fences = fmt.parse(fixture("fences.sheet"));
check("a fenced $ line is not an entry", fences.entries.length, 3);
check("the fence comes back byte for byte", fences.entries[0].body,
      "here is the script\n```sh\n$ npm test\n> not a say\n= not a decide\n---\n```");
check("short output is meta.out, not the body",
      [fences.entries[1].body, fences.entries[1].meta.out], ["npm test", "> delphi@1.5.0 test\n49/49 checks passed"]);
check("a running entry", fences.entries[2].meta, { state: "running", cwd: "/Users/ray/src/app" });

// ---------------------------------------------------------------------------

section("quoting");

const quoted = fmt.parse(fixture("quoting.sheet"));
check("a title is taken as written", quoted.header.title, 'quoting "values" {with braces} and \\ slashes');
check("spaces and braces in values", [quoted.entries[0].author, quoted.entries[0].meta.cwd],
      ["Ray Hughes", "/Users/ray/My Projects/{app}"]);
check("an exit code is a number", quoted.entries[0].meta.code, 2);
check("escaped quotes", quoted.entries[1].author, 'say "hi"');
check("a backslash, a newline and a return", [quoted.entries[2].author, quoted.entries[2].meta.cwd],
      ["a\\b", "/tmp/two\nlines\rand a return"]);
check("a signal name stays a string", quoted.entries[2].meta.code, "SIGINT");
check("a value holding something that looks like a block",
      [quoted.entries[3].body, quoted.entries[3].meta.cwd], ["sleep 100", "C:\\Users\\ray  {id:1}"]);
check("an empty author and a bare fail", [quoted.entries[4].author, quoted.entries[4].meta], ["", { state: "fail" }]);

check("formatMeta orders and quotes",
      fmt.formatMeta({ kind: "run", id: 807, author: "ray", promoted: 1, ref_id: 3, note_kind: "gotcha",
                       meta: { state: "ok", dur_ms: 1234, lines: 340, cwd: "/a b" } }),
      '{id:807 by:ray ref:3 + note:gotcha ok dur:1.2s lines:340 cwd:"/a b"}');
check("a say does not repeat its author", fmt.formatMeta({ kind: "say", id: 1, author: "ray" }), "{id:1}");
check("nothing to say is no block", fmt.formatMeta({ kind: "say" }), "");
check("meta stored as JSON text is read", fmt.formatMeta({ kind: "run", id: 2, meta: '{"state":"fail","code":"guard"}' }),
      "{id:2 fail:guard}");
check("a running entry has no duration yet",
      fmt.formatMeta({ kind: "run", id: 3, meta: { state: "running", dur_ms: 10, lines: 2 } }), "{id:3 running}");
check("values that would not parse are left out rather than written",
      fmt.formatMeta({ kind: "run", id: 1.5, ref_id: -2, meta: { state: "ok", dur_ms: -5, lines: "x" } }), "{ok}");

// ---------------------------------------------------------------------------

section("the metadata grammar");

check("an empty block is valid and empty", fmt.parseMeta("{}"), {});
check("unknown key", fmt.parseMeta("{x}"), null);
check("unknown key among known ones", fmt.parseMeta("{id:1 colour:red}"), null);
check("a double space", fmt.parseMeta("{id:1  ok}"), null);
check("a leading space", fmt.parseMeta("{ id:1}"), null);
check("a trailing space", fmt.parseMeta("{id:1 }"), null);
check("a repeated key", fmt.parseMeta("{id:1 id:2}"), null);
check("two states", fmt.parseMeta("{ok fail:1}"), null);
check("a flag with a value", fmt.parseMeta("{+:1}"), null);
check("a value key with none", fmt.parseMeta("{by}"), null);
check("a fractional id", fmt.parseMeta("{id:1.5}"), null);
check("a duration without its unit", fmt.parseMeta("{dur:1.2}"), null);
check("a bad escape", fmt.parseMeta('{by:"a\\tb"}'), null);
check("an unterminated quote", fmt.parseMeta('{by:"ray}'), null);
check("a bare value with a brace", fmt.parseMeta("{by:a}b}"), null);
check("text after a closing quote", fmt.parseMeta('{by:"a"b}'), null);
check("not a block at all", fmt.parseMeta("id:1"), null);
check("everything at once", fmt.parseMeta('{id:9 by:"a b" ref:8 + note:decision fail:130 dur:12.0s lines:0 cwd:/x}'),
      { id: 9, by: "a b", ref: 8, promoted: true, note: "decision", state: "fail", code: 130,
        dur_ms: 12000, lines: 0, cwd: "/x" });
check("a negative exit code", fmt.parseMeta("{fail:-1}"), { state: "fail", code: -1 });

const fake = fmt.parse(fixture("fake-meta.sheet"));
check("{x} stays in the text", [fake.entries[0].body, fake.entries[0].id], ["the config is literally  {x}", null]);
check("only the last block that parses is the block",
      [fake.entries[1].body, fake.entries[1].id], ["unknown keys are text  {colour:red}", 41]);
check("an empty block protects a quoted one",
      [fake.entries[2].body, fake.entries[2].id], ["a quoted sheet line: $ ls  {id:1 ok}", null]);
check("a real block after a quoted one",
      [fake.entries[3].body, fake.entries[3].id], ["same, in an entry that has a block of its own  {id:1 ok}", 43]);
const fakeClean = fmt.clean(fixture("fake-meta.sheet"));
check("clean strips every block and adds none", fakeClean.split("\n").slice(6, 11), [
  "> ray: the config is literally  {x}",
  "> ray: unknown keys are text  {colour:red}",
  "! a quoted sheet line: $ ls  {id:1 ok}",
  "! same, in an entry that has a block of its own  {id:1 ok}",
  "@ claude: two spaces inside a brace  { id:1}",
]);
const quotedHead = fmt.parse(fakeClean, { clean: true }).entries[2];
check("the clean parse reads a quoted block as text", [quotedHead.body, quotedHead.id], ["a quoted sheet line: $ ls  {id:1 ok}", null]);
check("and it comes back byte for byte with no {}",
      fmt.formatEntry(quotedHead, { clean: true }), "! a quoted sheet line: $ ls  {id:1 ok}");
check("the full format still protects it with {}",
      fmt.formatEntry({ ...quotedHead, id: null }), "! a quoted sheet line: $ ls  {id:1 ok}  {}");

// Pinned limitation: the head of a say is split at the first ": ", so an author
// containing one cannot come back. Actor names never do. If this starts passing
// the other way, the header comment in format.js is out of date.
const colonAuthor = fmt.parse(fmt.format({ header: null, entries: [{ kind: "say", author: "Ray: H", body: "hi" }] }));
check("an author containing ': ' does not round trip (known limit)",
      [colonAuthor.entries[0].author, colonAuthor.entries[0].body], ["Ray", "H: hi"]);

// ---------------------------------------------------------------------------

section("durations");

const dur = (ms) => fmt.formatMeta({ kind: "run", meta: { state: "ok", dur_ms: ms } });
check("zero", dur(0), "{ok dur:0.0s}");
check("rounds to a tenth", dur(1234), "{ok dur:1.2s}");
check("a minute", dur(59999), "{ok dur:60.0s}");
check("long", dur(3723400), "{ok dur:3723.4s}");
check("comes back as milliseconds to the tenth", fmt.parseMeta("{dur:1.2s}").dur_ms, 1200);

// ---------------------------------------------------------------------------

section("ask");

const ask = fmt.parse(fixture("ask.sheet"));
check("two options", ask.entries[0].meta.options.length, 2);
check("four options, one label with a colon", ask.entries[1].meta.options, [
  { key: "a", label: "us-east-1: primary" }, { key: "b", label: "eu-west-2" },
  { key: "c", label: "ap-south-1" }, { key: "d", label: "none of these" },
]);
check("an agent asking", ask.entries[1].author, "claude-code:4");
check("the why under a decide", ask.entries[2].body, "d\nnone of them is close enough to the customer");
check("an ask with an empty label",
      fmt.parse("? pick: [a]  [b] x\n").entries[0].meta.options, [{ key: "a", label: "" }, { key: "b", label: "x" }]);

// ---------------------------------------------------------------------------

section("normalising");

const sheet = {
  header: { task: 1, title: "a title\r\nover two lines", project: null, status: "todo" },
  entries: [
    { id: 1, kind: "say", author: "ray", body: "\r\n\r\nhello\r\nworld\r\n\r\n  \r\n" },
    { id: 2, kind: "note", author: "ray", body: "\n\n" },
    { id: 3, kind: "run", author: "ray", body: "echo hi", meta: { state: "ok", code: 0, dur_ms: 12, lines: 1, out: "hi\n\n", cwd: "/tmp" } },
    { id: 4, kind: "say", author: "claude-code:1", author_type: null, body: "a lone\rreturn" },
    { id: 5, kind: "say", author: "ray", author_type: "agent", body: "forced agent" },
  ],
};
const written = fmt.format(sheet);
check("CRLF, trailing blanks and the title are normalised", written, [
  "---",
  "task: 1",
  "title: a title over two lines",
  "status: todo",
  "---",
  "> ray: hello  {id:1}",
  "  world",
  "!   {id:2 by:ray}",
  "$ echo hi  {id:3 by:ray ok dur:0.0s lines:1 cwd:/tmp}",
  "  hi",
  "@ claude-code:1: a lone  {id:4}",
  "  return",
  "@ ray: forced agent  {id:5}",
  "",
].join("\n"));
check("and what it wrote round trips", fmt.format(fmt.parse(written)), written);
check("parse reads CRLF", fmt.format(fmt.parse(written.replace(/\n/g, "\r\n"))), written);
check("output ends with exactly one newline", /[^\n]\n$/.test(written), true);
check("an empty sheet is empty", fmt.format({ header: null, entries: [] }), "");
check("an empty sheet parses to nothing", fmt.parse(""), { header: null, entries: [] });
check("formatEntry has no trailing newline", fmt.formatEntry({ kind: "note", body: "x" }), "! x");
check("formatEntry clean", fmt.formatEntry({ kind: "note", id: 1, body: "x\ny" }, { clean: true }), "! x\n  y");

section("text nobody formatted");

const hand = "stray line before anything\n> ray: hi\n~ link to #12\n# a heading\n  under it\n---\n> ray: after\n";
const handParsed = fmt.parse(hand);
check("raw entries are kept, not imported",
      handParsed.entries.map((e) => e.kind), ["raw", "say", "raw", "raw", "raw", "say"]);
check("and written back as they were", fmt.format(handParsed), hand);
check("a document with no header", fmt.parse("> ray: hi\n").header, null);

// ---------------------------------------------------------------------------

section("author inference");

for (const [name, want] of [
  ["ray", "human"], ["you", "human"], ["Ray Hughes", "human"], ["", "human"], [null, "human"],
  ["claude", "agent"], ["claude-code:12", "agent"], ["Copilot", "agent"], ["codex", "agent"],
  ["cursor", "agent"], ["agent", "agent"], ["gpt-5", "agent"], ["dependabot", "agent"],
  ["runner", "agent"], ["someone:1", "agent"],
]) {
  check(`${JSON.stringify(name)} is ${want}`, fmt.inferAuthorType(name), want);
}

// ---------------------------------------------------------------------------

section("stripAnsi");

check("colour", fmt.stripAnsi("\x1b[31mred\x1b[0m plain"), "red plain");
check("cursor movement and erase", fmt.stripAnsi("a\x1b[2K\x1b[1Gb"), "ab");
check("a hyperlink", fmt.stripAnsi("\x1b]8;;https://x.test\x07link\x1b]8;;\x07"), "link");
check("private modes", fmt.stripAnsi("\x1b[?25lhidden\x1b[?25h"), "hidden");
check("plain text untouched", fmt.stripAnsi("50% done {ok}"), "50% done {ok}");

// ---------------------------------------------------------------------------
// A seeded fuzz. Bodies are built from the characters that cause trouble: the
// sigils, braces, quotes, colons, blank lines and the two-space separator. Two
// promises are checked on every one: the text round trips, and what comes back
// means what went in.

section("fuzz");

let seed = 20261002;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (list) => list[Math.floor(rand() * list.length)];
const PIECES = ["a", "word", " ", "  ", ":", ": ", "{", "}", "{id:1}", "  {id:7 ok}", "  {}", '"', "\\",
                "$ ", "> ", "@ ", "? ", "= ", "! ", "---", "```", "\t", "caf\u00e9", "\u00a0", "[a] ", "[b]",
                "\n", "\n", "\n\n", "\r\n", "  {x}", "by:\"q\"", "%"];
const phrase = (n, allowNewline = true) => {
  let s = "";
  for (let i = 0; i < n; i++) {
    const p = pick(PIECES);
    if (!allowNewline && /[\r\n]/.test(p)) continue;
    s += p;
  }
  return s;
};
const authorFor = () => pick(["ray", "you", "claude-code:3", "Ray Hughes", "a{b}", 'q"x', "", "runner"]);

section("round trips the fuzzer found");
{
  const LS = "\u2028";
  const cases = [
    ["U+2028 in a header title", { header: { task: 1, title: `a${LS}b`, status: "todo" }, entries: [] }],
    ["U+2029 in a header title", { header: { task: 1, title: "a\u2029b", status: "todo" }, entries: [] }],
    ["a header task of 007", { header: { task: "007", title: "t", status: "todo" }, entries: [] }],
    ["a run body with a blank second line", { header: null, entries: [{ kind: "run", author: "ray", body: "cmd\n\nmore" }] }],
    ["fail:01", { header: null, entries: [{ id: 1, kind: "run", author: "ray", body: "c", meta: { state: "fail", code: "01" } }] }],
    ["fail:-0", { header: null, entries: [{ id: 1, kind: "run", author: "ray", body: "c", meta: { state: "fail", code: "-0" } }] }],
    ["an ask with an empty question", { header: null, entries: [{ kind: "ask", author: "ray", body: "", meta: { options: [{ key: "a", label: "x" }] } }] }],
    ["a U+2028 line in a body", { header: null, entries: [{ kind: "note", author: "ray", body: `x\n${LS}\ny` }] }],
    ["NEL in a say", { header: null, entries: [{ kind: "say", author: "ray", body: "a\u0085b" }] }],
  ];
  for (const [name, sheet] of cases) {
    for (const clean of [false, true]) {
      const text = fmt.format(sheet, { clean });
      check(`${name} (${clean ? "clean" : "full"})`, fmt.format(fmt.parse(text, { clean }), { clean }), text);
    }
  }
  check("a header title keeps its words either side of U+2028", fmt.parse(fmt.format(cases[0][1])).header.title, "a b");
  check("007 stays a string", fmt.parse("---\ntask: 007\ntitle: t\nstatus: x\n---\n").header.task, "007");
  check("fail:01 keeps its zero", fmt.parseMeta("{fail:01}").code, "01");
  check("an id with a leading zero is not a block", fmt.parseMeta("{id:007}"), null);
}

let fuzzFailures = 0;
for (let n = 0; n < 4000; n++) {
  const kind = pick(["say", "say", "note", "run", "ask", "decide"]);
  const entry = {
    id: rand() < 0.8 ? Math.floor(rand() * 1000) : null,
    kind,
    author: authorFor(),
    author_type: pick([null, "human", "agent"]),
    promoted: rand() < 0.3 ? 1 : 0,
    ref_id: rand() < 0.2 ? Math.floor(rand() * 100) : null,
    note_kind: rand() < 0.2 ? pick(["gotcha", "decision", "odd kind"]) : null,
    body: phrase(Math.floor(rand() * 12)),
    meta: null,
  };
  if (kind === "run") {
    entry.body = phrase(1 + Math.floor(rand() * 6), false);
    entry.meta = {
      state: pick(["running", "ok", "fail"]), code: pick([1, 130, "guard", "SIGTERM", null]),
      dur_ms: Math.floor(rand() * 100000), lines: Math.floor(rand() * 500),
      cwd: pick(["/tmp", "/a b/{c}", 'C:\\x "y"', "", null]),
      out: rand() < 0.5 ? phrase(Math.floor(rand() * 8)) : undefined,
    };
  }
  if (kind === "ask") {
    entry.body = phrase(1 + Math.floor(rand() * 4), false).replace(/: \[a\] /g, "");
    const labels = ["exp", "fixed: maybe", "", "x  {id:2}", "caf\u00e9"];
    entry.meta = { options: ["a", "b", "c", "d"].slice(0, 2 + Math.floor(rand() * 3)).map((key) => ({ key, label: pick(labels) })) };
  }
  for (const clean of [false, true]) {
    const text = fmt.format({ header: null, entries: [entry] }, { clean });
    const back = fmt.parse(text, { clean });
    const again = fmt.format(back, { clean });
    const got = back.entries[0] || {};
    const sameText = again === text;
    const sameBody = back.entries.length === 1 && got.body === fmt.normaliseBody(entry.body).replace(/\r/g, "\n");
    const sameAuthor = kind !== "say" || got.author === entry.author;
    const sameId = clean || got.id === entry.id;
    const trailing = (t) => String(t == null ? "" : t).replace(/\r\n?/g, "\n").replace(/(?:\n[ \t]*)+$/, "").replace(/^[ \t]+$/, "");
    const sameOut = kind !== "run" || clean || ((got.meta && got.meta.out) || "") === trailing(entry.meta.out);
    if (!(sameText && sameBody && sameAuthor && sameId && sameOut)) {
      fuzzFailures++;
      if (fuzzFailures <= 5) {
        console.error(`  FAIL fuzz case ${n} (clean ${clean})\n       entry ${JSON.stringify(entry)}\n       text  ${JSON.stringify(text)}\n       back  ${JSON.stringify(back.entries)}`);
      }
    }
  }
}
check("4000 random entries round trip in both modes, and mean what they meant", fuzzFailures, 0);

// ---------------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
