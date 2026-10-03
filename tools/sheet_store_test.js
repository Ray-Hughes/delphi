#!/usr/bin/env node
// The Sheet store, on both of the routes it is given.
//
//   electron --no-sandbox tools/sheet_store_test.js
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/sheet_store_test.js
//
// Needs node:sqlite for db.js, so it runs under Electron. The store itself is
// handed a sql() function, and in real use it gets two very different ones:
// db.sqlP binding against node:sqlite in the app, and the MCP server's literal
// substitution, which may be shelling out to the sqlite3 binary. Both are run
// here against the same rules, and the shapes they return are compared, because
// "works in the app, returns a string id over MCP" is exactly the bug a shared
// store exists to prevent.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-store-"));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const { makeSheetStore, LEDGER_TAIL } = require("../sheet/store");
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

function throws(what, fn, pattern) {
  checks++;
  try {
    fn();
  } catch (error) {
    if (pattern.test(String(error.message))) return;
    failures++;
    console.error(`  FAIL ${what}\n       threw ${JSON.stringify(error.message)}\n       want  ${pattern}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${what}\n       did not throw`);
}

function section(name) { console.log(`\n${name}`); }

// The binary route, as the MCP server does it: values rendered as literals in
// one pass, the statement written to a file, sqlite3 asked for JSON.
function findSqlite() {
  for (const candidate of [process.env.DELPHI_SQLITE, "/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return "sqlite3";
}
const SQLITE = findSqlite();
const literal = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
};
function binarySql(query, params = []) {
  const statement = String(query).replace(/:p(\d+)/g, (m, n) => (Number(n) - 1 < params.length ? literal(params[Number(n) - 1]) : m));
  const file = path.join(dir, `q-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  fs.writeFileSync(file, [".timeout 5000", ".mode json", ".headers on", statement.endsWith(";") ? statement : statement + ";"].join("\n"));
  try {
    const out = execFileSync(SQLITE, [process.env.DELPHI_DB], { input: `.read ${file}\n`, encoding: "utf8" }).trim();
    return out ? JSON.parse(out) : [];
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// ---------------------------------------------------------------------------

const project = db.createProject({ key: "store-test", name: "Store test" });
const other = db.createTask({ projectId: project.id, title: "another task" });
db.handle().prepare("UPDATE tasks SET legacy_id = 'T-77', ref = 'ABC-12' WHERE id = ?").run(other.id);
const twinA = db.createTask({ projectId: project.id, title: "twin a", ref: "DUP-1" });
const twinB = db.createTask({ projectId: project.id, title: "twin b", ref: "dup-1" });
const orphan = db.createTask({ title: "no project" });

section("placeholder counts");
throws("sqlP refuses a placeholder with no value", () => db.sqlP("SELECT :p1 AS a, :p2 AS b", [1]), /:p2 has no value/);
throws("sqlP refuses a spare value", () => db.sqlP("SELECT :p1 AS a", [1, 2]), /2 values given for 1 placeholders/);
check("sqlP binds a repeated placeholder", db.sqlP("SELECT :p1 AS a, :p1 AS b", [7]), [{ a: 7, b: 7 }]);

const shapes = {};

for (const [route, sql] of [["sqlP", db.sqlP], ["sqlite3 binary", binarySql]]) {
  const store = makeSheetStore({ sql, actor: "claude-code:7" });
  const task = db.createTask({ projectId: project.id, title: `sheet on ${route}` });
  const auditFrom = Number(db.sqlP("SELECT COALESCE(MAX(id), 0) AS n FROM audit")[0].n);

  section(`${route}: appending`);

  const say = store.append({ taskId: task.id, kind: "say", body: "first finding" });
  check("a say", [say.kind, say.author, say.author_type, say.body, say.promoted, say.meta], ["say", "claude-code:7", "agent", "first finding", 0, null]);
  check("ids are numbers", [typeof say.id, typeof say.task_id], ["number", "number"]);

  const nasty = "quotes ' and \" and :p1 :p2 :p10 and $& $` $' $$ and `$ ` too\r\n\r\n```\n$ rm -rf /\n```\n\n";
  const kept = store.append({ taskId: task.id, kind: "note", body: nasty, author: "ray" });
  check("placeholders, dollars and quotes are stored as written", kept.body,
        "quotes ' and \" and :p1 :p2 :p10 and $& $` $' $$ and `$ ` too\n\n```\n$ rm -rf /\n```");
  check("an author can be named", [kept.author, kept.author_type], ["ray", "human"]);

  const human = makeSheetStore({ sql, actor: "you", authorType: "human" });
  const typed = human.append({ taskId: task.id, kind: "say", body: "  indented first line\nsecond" });
  check("authorType is stored when the writer knows it", [typed.author, typed.author_type], ["you", "human"]);
  check("leading spaces on the first line are content", typed.body, "  indented first line\nsecond");
  check("stored, not inferred",
        sql("SELECT author_type FROM comments WHERE id = :p1", [typed.id])[0].author_type, "human");
  check("and null when it does not",
        sql("SELECT author_type FROM comments WHERE id = :p1", [say.id])[0].author_type, null);

  const unicode = store.append({ taskId: task.id, kind: "say", body: "café → 🚀" });
  check("unicode survives", unicode.body, "café → 🚀");

  const runEntry = store.append({ taskId: task.id, kind: "run", body: "npm test", meta: { state: "running", cwd: "/tmp/a b" } });
  check("a run", [runEntry.kind, runEntry.meta], ["run", { state: "running", cwd: "/tmp/a b" }]);

  throws("an unknown kind", () => store.append({ taskId: task.id, kind: "shout", body: "x" }), /kind must be one of/);
  throws("an empty body", () => store.append({ taskId: task.id, kind: "say", body: " \n\t " }), /needs something/);
  throws("a two line command", () => store.append({ taskId: task.id, kind: "run", body: "a\nb" }), /one line/);
  throws("a command with a carriage return", () => store.append({ taskId: task.id, kind: "run", body: "a\rb" }), /one line/);
  throws("no such task", () => store.append({ taskId: 999999, kind: "say", body: "x" }), /No task 999999/);
  throws("a task id that is not a number", () => store.append({ taskId: "abc", kind: "say", body: "x" }), /whole number/);
  throws("a reference to another task's entry",
         () => store.append({ taskId: other.id, kind: "say", body: "x", refId: say.id }), /stay on its own Sheet/);
  throws("meta that is not an object", () => store.append({ taskId: task.id, kind: "say", body: "x", meta: [1] }), /meta must be an object/);

  section(`${route}: updating`);

  const finished = store.update(runEntry.id, { meta: { state: "ok", code: 0, exit: 0, dur_ms: 1234, lines: 2, out: "a\nb" } });
  check("meta is merged, not replaced", finished.meta,
        { state: "ok", cwd: "/tmp/a b", code: 0, exit: 0, dur_ms: 1234, lines: 2, out: "a\nb" });
  check("updated_at is bumped or equal", finished.updated_at >= runEntry.updated_at, true);
  const failing = store.append({ taskId: task.id, kind: "run", body: "make build", meta: { state: "running" } });
  store.update(failing.id, { meta: { state: "fail", code: 2 } });
  const edited = store.update(say.id, { body: "first finding, corrected" });
  check("a body edit", edited.body, "first finding, corrected");
  throws("a run edited to two lines", () => store.update(failing.id, { body: "a\nb" }), /one line/);
  throws("no such entry", () => store.update(999999, { body: "x" }), /No entry 999999/);

  section(`${route}: the ledger`);

  store.promote(kept.id, true);
  check("promoted", store.get(kept.id).promoted, 1);
  store.promote(kept.id, false);
  check("unpromoted", store.get(kept.id).promoted, 0);
  store.promote(kept.id);
  check("promote defaults to on", store.get(kept.id).promoted, 1);

  const ask = store.ask(task.id, "retry strategy", ["exponential", "fixed: maybe"]);
  check("an ask", [ask.kind, ask.body, ask.meta], ["ask", "retry strategy",
        { options: [{ key: "a", label: "exponential" }, { key: "b", label: "fixed: maybe" }] }]);
  throws("one option", () => store.ask(task.id, "q", ["a"]), /two to four/);
  throws("five options", () => store.ask(task.id, "q", ["a", "b", "c", "d", "e"]), /two to four/);
  throws("an empty option", () => store.ask(task.id, "q", ["a", " "]), /empty/);
  throws("a bracketed key in a label", () => store.ask(task.id, "q", ["a [b] c", "d"]), /brackets/);
  throws("a two line question", () => store.ask(task.id, "q\nmore", ["a", "b"]), /one line/);
  throws("a question holding the option marker", () => store.ask(task.id, "x: [a] y", ["a", "b"]), /cannot contain/);

  const decision = store.decide(ask.id, "A", "simpler to reason about");
  check("a decide", [decision.kind, decision.body, decision.ref_id, decision.promoted, decision.meta],
        ["decide", "a\nsimpler to reason about", ask.id, 1, { choice: "a", label: "exponential" }]);
  throws("a choice that is not offered", () => store.decide(ask.id, "c"), /Choose one of a, b/);
  throws("deciding something that is not a question", () => store.decide(say.id, "a"), /not a question/);

  throws("append refuses an ask", () => store.append({ taskId: task.id, kind: "ask", body: "q" }), /Use ask\(\)/);
  throws("append refuses a decide", () => store.append({ taskId: task.id, kind: "decide", body: "a" }), /Use decide\(\)/);
  throws("an ask edited to two lines", () => store.update(ask.id, { body: "q\nmore" }), /one line/);
  throws("an ask edited to hold the option marker", () => store.update(ask.id, { body: "x: [a] y" }), /cannot contain/);
  throws("an ask's options cannot change", () => store.update(ask.id, { meta: { options: [] } }), /cannot change/);
  check("an ask's question can be reworded", store.update(ask.id, { body: "retry strategy" }).body, "retry strategy");
  throws("a decide's choice cannot change", () => store.update(decision.id, { meta: { choice: "b" } }), /cannot change/);
  check("only the why of a decide is editable",
        store.update(decision.id, { body: "b\nbecause" }).body, "a\nb\nbecause");
  check("restating the choice keeps it once",
        store.update(decision.id, { body: "a\nsimpler to reason about" }).body, "a\nsimpler to reason about");

  const ledger = store.ledger(task.id);
  check("the ledger is promoted entries plus the question a decision answers",
        ledger.map((e) => e.id), [kept.id, ask.id, decision.id]);
  check("entries in ledger mode agree", store.entries(task.id, { mode: "ledger" }).map((e) => e.id), ledger.map((e) => e.id));
  // The spec: "plus every resolved decision". Unpromoting a decision does not
  // take it, or its question, out of the ledger.
  store.promote(decision.id, false);
  check("an unpromoted decision stays in the ledger, with its question",
        store.ledger(task.id).map((e) => e.id), [kept.id, ask.id, decision.id]);
  check("in ledger mode too", store.entries(task.id, { mode: "ledger" }).map((e) => e.id), [kept.id, ask.id, decision.id]);
  check("and in what an agent is handed", [ask.id, decision.id].every((id) => store.context(task.id).entries.some((e) => e.id === id)), true);
  check("and in ledger_count", store.read(task.id).ledger_count, 3);
  store.promote(decision.id, true);

  section(`${route}: filing`);

  const filed = store.file(kept.id, "gotcha");
  check("a note row exists", sql("SELECT kind, project_id FROM notes WHERE id = :p1", [filed.note.id])[0],
        { kind: "gotcha", project_id: project.id });
  check("the entry points at it", [filed.entry.note_id, filed.entry.note_kind, filed.entry.promoted], [filed.note.id, "gotcha", 1]);
  check("the body carries where it came from",
        sql("SELECT body FROM notes WHERE id = :p1", [filed.note.id])[0].body.endsWith(`\n\nFrom task #${task.id}, entry ${kept.id}`), true);
  check("the title defaults to the first line", filed.note.title, "quotes ' and \" and :p1 :p2 :p10 and $& $` $' $$ and `$ ` too");
  check("filing twice returns the same note", store.file(kept.id, "gotcha").note.id, filed.note.id);
  const decisionNote = store.file(decision.id, "decision", "Retry with backoff");
  check("a decision note is written out in full",
        sql("SELECT body FROM notes WHERE id = :p1", [decisionNote.note.id])[0].body,
        `retry strategy\n\n[a] exponential\n[b] fixed: maybe\n\nChosen: [a] exponential\n\nsimpler to reason about\n\nFrom task #${task.id}, entry ${decision.id}`);
  check("an explicit title", decisionNote.note.title, "Retry with backoff");
  for (const kind of ["reference", "note"]) {
    const e = store.append({ taskId: task.id, kind: "say", body: `worth keeping as ${kind}` });
    check(`filed as ${kind}`, store.file(e.id, kind).entry.note_kind, kind);
  }
  throws("a note kind that does not exist", () => store.file(say.id, "contact"), /kind must be one of/);
  const orphanStore = store.append({ taskId: orphan.id, kind: "say", body: "no project here" });
  check("a task with no project files a note with no project",
        store.file(orphanStore.id, "note").note.project_id, null);

  section(`${route}: reading`);

  for (let i = 0; i < 30; i++) store.append({ taskId: task.id, kind: "say", body: `filler ${i}` });
  const all = store.entries(task.id);
  const tail = store.entries(task.id, { mode: "tail", n: 5 });
  check("tail is the last n in id order", tail.map((e) => e.id), all.slice(-5).map((e) => e.id));
  check("tail defaults to the ledger tail", store.entries(task.id, { mode: "tail" }).length, LEDGER_TAIL);
  const cut = all[all.length - 3].id;
  check("after_id", store.entries(task.id, { afterId: cut }).map((e) => e.id), all.slice(-2).map((e) => e.id));
  check("after_id 0 is everything", store.entries(task.id, { afterId: 0 }).length, all.length);
  check("a cursor is not cut to n", store.entries(task.id, { mode: "tail", n: 1, afterId: cut }).length, 2);
  const future = store.entries(task.id, { since: "9999-01-01 00:00:00" });
  check("since in the future is nothing", future.length, 0);
  check("since in the past is everything", store.entries(task.id, { since: "2000-01-01 00:00:00" }).length, all.length);
  throws("a mode that does not exist", () => store.entries(task.id, { mode: "some" }), /mode must be/);
  throws("a negative after_id", () => store.entries(task.id, { afterId: -1 }), /after_id/);

  const ctx = store.context(task.id);
  const expected = new Set([...ledger.map((e) => e.id), ...store.ledger(task.id).map((e) => e.id), ...all.slice(-LEDGER_TAIL).map((e) => e.id)]);
  check("context is the ledger plus the last twenty", ctx.entries.map((e) => e.id), [...expected].sort((a, b) => a - b));
  check("context counts what it left out", [ctx.total, ctx.shown], [all.length, expected.size]);
  check("context text is clean and parses back", fmt.format(fmt.parse(ctx.text), { clean: true }), ctx.text);
  check("context text has no blocks", /\{id:/.test(ctx.text), false);
  check("the header", store.header(task.id), { task: task.id, title: `sheet on ${route}`, project: "store-test", status: "todo" });
  check("the header of a task with no project", store.header(orphan.id).project, null);
  const whole = store.sheet(task.id);
  check("sheet() formats", fmt.format(fmt.parse(fmt.format(whole))), fmt.format(whole));

  section(`${route}: resolving a task`);

  check("by id", store.resolveTask(String(task.id)).id, task.id);
  check("by #id", store.resolveTask(`#${task.id}`).id, task.id);
  check("by legacy id", store.resolveTask("T-77").id, other.id);
  check("by ref, any case", store.resolveTask("abc-12").id, other.id);
  throws("an ambiguous ref", () => store.resolveTask("dup-1"), new RegExp(`Several tasks match 'dup-1': ${twinA.id} \\(twin a\\), ${twinB.id}`));
  throws("nothing", () => store.resolveTask("NOPE-1"), /No task matches 'NOPE-1'/);
  throws("empty", () => store.resolveTask("  "), /Which task/);

  section(`${route}: the audit trail`);

  const summaries = sql("SELECT action, entity, summary FROM audit WHERE id > :p1 ORDER BY id", [auditFrom])
    .map((r) => `${r.action} ${r.entity} ${r.summary}`);
  const want = [
    "update task commented (by claude-code:7)",
    "update task noted (by claude-code:7)",
    "update task commented (by you)",
    "update task commented (by claude-code:7)",
    "update task ran npm test (by claude-code:7)",
    "update task finished npm test: ok (by claude-code:7)",
    "update task ran make build (by claude-code:7)",
    "update task finished make build: fail:2 (by claude-code:7)",
    `update task edited entry ${say.id} (by claude-code:7)`,
    `update task promoted entry ${kept.id} (by claude-code:7)`,
    `update task unpromoted entry ${kept.id} (by claude-code:7)`,
    `update task promoted entry ${kept.id} (by claude-code:7)`,
    'update task asked "retry strategy" (by claude-code:7)',
    `update task decided a on ${ask.id} (by claude-code:7)`,
    `update task edited entry ${ask.id} (by claude-code:7)`,
    `update task edited entry ${decision.id} (by claude-code:7)`,
    `update task edited entry ${decision.id} (by claude-code:7)`,
    `update task unpromoted entry ${decision.id} (by claude-code:7)`,
    `update task promoted entry ${decision.id} (by claude-code:7)`,
    `update task filed entry ${kept.id} as gotcha (by claude-code:7)`,
    "create note created (by claude-code:7)",
    `update task filed entry ${decision.id} as decision (by claude-code:7)`,
    "create note created (by claude-code:7)",
  ];
  check("the summaries, exactly", summaries.slice(0, want.length), want);

  shapes[route] = {
    entry: Object.fromEntries(Object.entries(store.get(finished.id)).map(([k, v]) => [k, v === null ? "null" : typeof v])),
    ledger: store.ledger(task.id).map((e) => [e.kind, e.promoted, e.ref_id === null ? null : "ref"]),
  };

  check("prunable leaves undone tasks", store.prunable(0).includes(task.id), false);
}

section("both routes agree");
check("the same Entry shape", shapes["sqlite3 binary"].entry, shapes.sqlP.entry);
check("the same ledger", shapes["sqlite3 binary"].ledger, shapes.sqlP.ledger);

section("prunable");
const done = db.createTask({ projectId: project.id, title: "long done" });
db.handle().prepare("UPDATE tasks SET status = 'done', completed_at = datetime('now', '-40 days') WHERE id = ?").run(done.id);
const recent = db.createTask({ projectId: project.id, title: "just done" });
db.handle().prepare("UPDATE tasks SET status = 'done', completed_at = datetime('now', '-1 days') WHERE id = ?").run(recent.id);
const store = makeSheetStore({ sql: db.sqlP });
check("done more than 30 days ago", store.prunable(30), [done.id]);
check("done more than 0 days ago", store.prunable(0), [done.id, recent.id]);
throws("days that are not a number", () => store.prunable("soon"), /days must be a number/);

// ---------------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
