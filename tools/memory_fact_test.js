#!/usr/bin/env node
// Log a fact and "why it's related" (slices 9 and 15): main/memory.js, the
// reasons in agent/recall.js, and the server's related_notes on both routes.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/memory_fact_test.js
//
// What matters: a fact lands as a note like any other, in the right project
// and with the right kind, and is found by recall at once; one logged on a
// task is filed from that task's Sheet; and every related card states a reason
// that is true of the database, the same words in the window and from the
// server whichever route it takes.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-fact-"));
process.env.DELPHI_DATA_DIR = dir;
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const oracle = require("../oracle");
const { makeSheetStore } = require("../sheet/store");
const { createMemory, register } = require("../main/memory");
const { whyRelated, SIGNAL_ORDER, makeRecall } = require("../agent/recall");
const { openServer } = require("../sheet/client");

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  } else console.log(`  ok   ${what}`);
}
function section(name) { console.log(`\n${name}`); }
async function refuses(fn) { try { await fn(); return null; } catch (error) { return error.message; } }

delete process.env.ELECTRON_RUN_AS_NODE;

function pure() {
  section("the reasons, as words");
  check("from the Sheet", whyRelated({ kind: "sheet" }), "From this task's Sheet");
  check("an edge", whyRelated({ kind: "link" }), "Linked to this task");
  check("a file", whyRelated({ kind: "file", name: "app.js" }), "Same file: app.js");
  check("a name", whyRelated({ kind: "entity", name: "Stripe" }), "Both name Stripe");
  check("a Workbench", whyRelated({ kind: "workbench", task: 9 }), "Same Workbench, #9");
  check("a nearby task", whyRelated({ kind: "seen", task: 156 }), "Seen on #156");
  check("meaning and words", [whyRelated({ kind: "meaning" }), whyRelated({ kind: "words" })], ["Similar meaning", "Similar wording"]);
  check("filler says it is filler", whyRelated({ kind: "project", noteKind: "gotcha" }), "Same project, gotcha");
  check("a long name is cut short", whyRelated({ kind: "entity", name: "x".repeat(80) }).length <= 52, true);
  check("every signal has its words", SIGNAL_ORDER.every((k) => whyRelated({ kind: k }) !== "Related"), true);
  check("no dashes in any of them", SIGNAL_ORDER.map((k) => whyRelated({ kind: k, name: "n", task: 1 })).some((w) => /[\u2013\u2014\u2212]/.test(w)), false);
}

function vector(values) {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf;
}

function fixture() {
  section("the fixture");
  const a = db.createProject({ key: "fa", name: "Caseflow" });
  const b = db.createProject({ key: "fb", name: "Offerworks" });
  const parent = db.createTask({ projectId: a.id, title: "Search rewrite" });
  const task = db.createTask({ projectId: a.id, parentId: parent.id, title: "Stripe webhook retries in app.js",
    detail: "Webhook retries double charge when the signature check runs after the write." });
  const sibling = db.createTask({ projectId: a.id, parentId: parent.id, title: "Sibling task" });
  const other = db.createTask({ projectId: b.id, title: "Unrelated pricing work" });
  // Not yet reached by the graph: its own words are read, as whole words.
  const fresh = db.createTask({ projectId: b.id, title: "Stripe payouts are correct now" });
  const n = {
    file: db.createNote({ projectId: b.id, kind: "reference", title: "Where the handlers live", body: "See app.js for the routes." }),
    entity: db.createNote({ projectId: b.id, kind: "decision", title: "Billing provider", body: "We chose Stripe over Paddle." }),
    link: db.createNote({ projectId: a.id, kind: "note", title: "Drawn by hand", body: "An edge joins this to the task." }),
    words: db.createNote({ projectId: b.id, kind: "note", title: "Signature check order", body: "Run the signature check before the write, or webhook retries double charge." }),
    meaning: db.createNote({ projectId: b.id, kind: "note", title: "Quiet note", body: "Nothing in common by word." }),
    filler: db.createNote({ projectId: a.id, kind: "gotcha", title: "Caseflow devtest is slow on Mondays", body: "Batch jobs." }),
    unrelated: db.createNote({ projectId: b.id, kind: "note", title: "Lunch menu", body: "Soup." }),
    cor: db.createNote({ projectId: b.id, kind: "note", title: "COR codes", body: "The COR field." }),
  };
  oracle.open(db.handle());
  const h = db.handle();
  const ent = (kind, name) => Number(h.prepare("INSERT INTO entities (kind, name, mentions) VALUES (?, ?, ?) RETURNING id").get(kind, name, 2).id);
  const edge = (st, sid, tt, tid, rel = "mentions") => h.prepare("INSERT INTO edges (source_type, source_id, target_type, target_id, relation) VALUES (?, ?, ?, ?, ?)").run(st, sid, tt, tid, rel);
  const appjs = ent("file", "app.js");
  const stripe = ent("term", "Stripe");
  const proj = ent("project", "Caseflow");
  const cor = ent("term", "COR");
  edge("note", n.cor.id, "entity", cor);
  edge("task", task.id, "entity", appjs);
  edge("note", n.file.id, "entity", appjs);
  edge("note", n.entity.id, "entity", stripe);
  edge("task", task.id, "entity", stripe);
  // Every row in the project names the project: never a reason.
  edge("task", task.id, "entity", proj);
  edge("note", n.unrelated.id, "entity", proj);
  edge("note", n.link.id, "task", task.id, "touches");
  // Stored vectors, the task's and two notes': one near, one far.
  const emb = (type, id, v) => h.prepare("INSERT INTO embeddings (source_type, source_id, model, dims, vector, content_hash) VALUES (?, ?, 'fake', ?, ?, 'h')").run(type, id, v.length, vector(v));
  emb("task", task.id, [1, 0, 0]);
  emb("note", n.meaning.id, [0.9, 0.1, 0]);
  emb("note", n.unrelated.id, [0, 0, 1]);
  return { a, b, parent, task, sibling, other, fresh, n };
}

function app(f) {
  section("Log a fact, in the app");
  const sheets = makeSheetStore({ sql: db.sqlP, batch: db.batchP, actor: "you", authorType: "human", step: db.currentStep });
  const memory = createMemory({ db, sheets });

  const plain = memory.logFact({ text: "  The UAT Vault path\nis different  ", kind: "gotcha", projectId: f.a.id });
  check("a fact is a note in the project, with its kind", [plain.note.project_id, plain.note.kind], [f.a.id, "gotcha"]);
  check("on one line, cleaned", [plain.note.title, plain.note.body], ["The UAT Vault path is different", "The UAT Vault path is different"]);
  check("and recorded in History as yours", db.sqlP("SELECT actor, action FROM audit WHERE entity = 'note' AND entity_id = :p1", [plain.note.id])[0], { actor: "you", action: "create" });
  const long = memory.logFact({ text: "word ".repeat(60), kind: "note", projectId: f.a.id });
  check("a long fact keeps all of it in the body and a short title", [long.note.title.length <= 80, long.note.body.length], [true, 299]);

  const onTask = memory.logFact({ text: "Retries must be idempotent on the charge id", kind: "decision", projectId: f.b.id, taskId: f.task.id });
  check("one linked to a task lives in the task's project", onTask.note.project_id, f.a.id);
  check("and is filed from its Sheet", db.sqlP("SELECT kind, note_id, promoted FROM comments WHERE id = :p1", [onTask.entryId])[0],
    { kind: "note", note_id: onTask.note.id, promoted: 1 });
  check("so it says where it came from", onTask.note.body.includes(`From task #${f.task.id}, entry ${onTask.entryId}`), true);
  check("with the kind picked", onTask.note.kind, "decision");

  section("what a fact is refused for");
  return (async () => {
    check("nothing in it", await refuses(() => memory.logFact({ text: "  ", projectId: f.a.id })), "A fact needs something in it.");
    check("a kind it does not know", await refuses(() => memory.logFact({ text: "x", kind: "contact", projectId: f.a.id })),
      "kind must be one of gotcha, decision, reference, note, got 'contact'.");
    check("no project and no task", await refuses(() => memory.logFact({ text: "x" })), "Which project? A fact needs one to live in.");
    check("a project that is not there", await refuses(() => memory.logFact({ text: "x", projectId: 99999 })), "No project 99999.");
    check("a task that is not there", await refuses(() => memory.logFact({ text: "x", taskId: 99999 })), "No task 99999.");
    check("more than a line", Boolean(await refuses(() => memory.logFact({ text: "y".repeat(2001), projectId: f.a.id }))), true);

    section("in recall, at once");
    const hits = await memory.search("Vault path", f.a.id);
    check("search finds the new fact", hits.notes.map((x) => x.id).includes(plain.note.id), true);
    check("and says why", hits.notes.find((x) => x.id === plain.note.id).why, "In the title");
    const scoped = await memory.search("signature check", f.a.id);
    check("a project's search keeps to its own notes", scoped.notes.some((x) => x.id === f.n.words.id), false);
    const everywhere = await memory.search("signature check", null);
    check("all projects' does not", everywhere.notes.some((x) => x.id === f.n.words.id), true);
    check("a title match says so", everywhere.notes.find((x) => x.id === f.n.words.id).why, "In the title");
    const body = await memory.search("double charge", null);
    check("found in the body", body.notes.find((x) => x.id === f.n.words.id).why, "In the text");

    // A fake model that answers, so rows come in by meaning alone.
    const byMeaning = makeRecall({ sql: db.sqlP, embedQuery: async () => ({ model: "fake", vector: [1, 0, 0] }) });
    const meant = await byMeaning.searchNotes("zqxv", { projectId: null });
    const meantWhy = Object.fromEntries(meant.notes.map((x) => [x.id, x.why]));
    check("a note near in meaning says so", meantWhy[f.n.meaning.id], "Similar meaning");
    check("one the vectors ranked but far away is left out, not called similar", f.n.unrelated.id in meantWhy, false);
    check("no row without a reason", meant.notes.every((x) => typeof x.why === "string"), true);

    section("why it's related, in the app");
    const r = memory.relatedFor(f.task.id, { limit: 12 });
    const why = Object.fromEntries(r.notes.map((c) => [c.id, c.why]));
    check("the fact from this task's Sheet comes first", [r.notes[0].id, r.notes[0].why], [onTask.note.id, "From this task's Sheet"]);
    check("an edge", why[f.n.link.id], "Linked to this task");
    check("a shared file", why[f.n.file.id], "Same file: app.js");
    check("a name both mention, by the graph", why[f.n.entity.id], "Both name Stripe");
    const fresh = Object.fromEntries(memory.relatedFor(f.fresh.id, { limit: 12 }).notes.map((c) => [c.id, c.why]));
    check("before the graph reaches a task, a name in its words", fresh[f.n.entity.id], "Both name Stripe");
    check("as a whole word only: COR is not in correct", f.n.cor.id in fresh, false);
    check("near in stored meaning, no model called", why[f.n.meaning.id], "Similar meaning");
    check("near in wording", why[f.n.words.id], "Similar wording");
    check("filler from the project says what it is", why[plain.note.id] || why[f.n.filler.id], "Same project, gotcha");
    check("a project entity alone is no reason", f.n.unrelated.id in why, false);
    check("in order of how strong the reason is", r.notes.map((c) => SIGNAL_ORDER.indexOf(c.signal)),
      r.notes.map((c) => SIGNAL_ORDER.indexOf(c.signal)).slice().sort((x, y) => x - y));
    check("every card says why", r.notes.every((c) => typeof c.why === "string" && c.why.length > 3 && c.why.length < 60), true);
    check("and lists every reason it has", r.notes.find((c) => c.id === f.n.words.id).reasons.includes("Similar wording"), true);

    const sib = memory.logFact({ text: "Sibling learned the queue drops at midnight", kind: "gotcha", taskId: f.sibling.id });
    const again = memory.relatedFor(f.task.id, { limit: 12 });
    check("a fact filed on a sibling task", again.notes.find((c) => c.id === sib.note.id).why, `Seen on #${f.sibling.id}`);
    check("the limit holds", memory.relatedFor(f.task.id, { limit: 2 }).notes.length, 2);
    check("a task that is not there is null", memory.relatedFor(99999), null);
    check("an empty task gets only filler", memory.relatedFor(f.other.id).notes.every((c) => c.signal === "project" || c.signal === "words" || c.signal === "meaning"), true);

    section("the IPC");
    const handlers = {};
    let wrote = 0;
    register((name, fn) => { handlers[name] = fn; }, { memory, afterWrite: () => wrote++ });
    check("four channels", Object.keys(handlers).sort(), ["memory:list", "memory:logFact", "memory:relatedFor", "memory:search"]);
    const listed = handlers["memory:list"](null);
    check("every project's notes with their homes", [listed.length >= 9, listed.every((x) => "home_name" in x)], [true, true]);
    check("a project's own", handlers["memory:list"](f.b.id).every((x) => x.project_id === f.b.id), true);
    handlers["memory:logFact"]({ text: "through the channel", kind: "reference", projectId: f.b.id });
    check("a write asks for the vault export", wrote, 1);
    return again;
  })();
}

async function route(name, env, f, inApp) {
  section(`related_notes, ${name}`);
  const agent = openServer({ actor: `claude-code:fact-${name.replace(/\W/g, "")}`, env: { DELPHI_AUTHOR_TYPE: "agent", ...env }, clientName: "test", warn: () => {} });
  await agent.start();
  try {
    const tool = (await agent.request("tools/list", {})).tools.find((t) => t.name === "related_notes");
    check("listed, with a short description", Boolean(tool) && tool.description.length < 200, true);
    const brief = await agent.call("related_notes", { task_id: f.task.id, limit: 12 });
    check("brief by default: one line per card, with its reason",
      brief.notes, inApp.notes.map((c) => `#${c.id} ${c.kind}: ${c.title} (${c.why})`));
    check("and says how to get more", typeof brief.more === "string", true);
    const tight = await agent.call("related_notes", { task_id: f.task.id, limit: 12, budget: 100 });
    check("inside its budget, and says it trimmed", [JSON.stringify(tight).length <= 100 * 4, tight.trimmed], [true, true]);
    const got = await agent.call("related_notes", { task_id: f.task.id, limit: 12, detail: "full" });
    check("detail full: the same cards and reasons as the window", got.notes.map((c) => [c.id, c.why]), inApp.notes.map((c) => [c.id, c.why]));
    check("with every reason", got.notes.every((c) => Array.isArray(c.reasons) && c.reasons.length > 0), true);
    check("unknown task", (await refuses(() => agent.call("related_notes", { task_id: 99999 }))) || "", "No task 99999");
  } finally {
    agent.close();
  }
}

async function main() {
  pure();
  const f = fixture();
  const inApp = await app(f);
  // The binary route reads what is on disk.
  db.handle().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  await route("node:sqlite", {}, f, inApp);
  await route("sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" }, f, inApp);
  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
