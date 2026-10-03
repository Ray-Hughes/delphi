#!/usr/bin/env node
// Cheap memory: the graph's learned vocabulary, and the memory tools' budgets,
// fallbacks and old answers, through the real agent/mcp_server.js on both routes.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/memory_test.js
//
// The budget checks are the point. search, oracle_ask, oracle_context and
// get_task used to return whole bodies and cost an agent 10k to 25k tokens a
// call; a fixture with long notes and a long Sheet is what would show that
// creeping back. Semantic ranking is checked against a fake Ollama on a local
// port, one that answers, one that is closed and one that never answers, so
// nothing here needs a model installed.

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-memory-"));
process.env.DELPHI_DATA_DIR = dir;
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const oracle = require("../oracle");
const { openServer } = require("../sheet/client");

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  } else {
    console.log(`  ok   ${what}`);
  }
}
function section(name) { console.log(`\n${name}`); }

// --- the vocabulary, without a database ------------------------------------

section("learning entities from text");
const vocab = oracle.learnVocabulary({
  projects: [
    { key: "offerworks", name: "Offerworks" },
    { key: "ssnr-mpi", name: "SSNR / MPI Person Update" },
    { key: "general", name: "General" },
    { key: "delphi-tasks", name: "Delphi: the task system" },
    { key: "delphi-queue", name: "Delphi: the agent queue" },
  ],
  repos: ["offerworks", "billing-service"],
  people: ["claude-code:42", "ray", "app", "codex"],
  texts: [
    "We chose Stripe for billing in Offerworks. The board shows it.",
    "Deploy Offerworks with Kamal; Stripe webhooks land in billing-service.",
    "Stripe Checkout is wired. Call add_correlation before retrying, see `parse_response`.",
    "add_correlation failed again in Delphi, so parse_response logs the body.",
    "In general the Board view is fine. CASEFLOW SUCCESS and VBMS FAIL lines are logs.",
    "Ask @ray about Stripe. Claude Code filed this; codex reviewed it. SHA-256 is not a ticket, APPEALS-1234 is.",
    "the board, the board, and a board again",
    "Billing runs on Stripe now.",
  ],
});
const found = (text) => oracle.extract(text, vocab).map((e) => `${e.kind}:${e.name}`).sort();

check("a project with a one-word name is found by name", found("Notes from Offerworks today"), ["project:Offerworks"]);
check("its folder is the project, not a second thing", found("cd ~/projects/offerworks"), ["project:Offerworks"]);
check("two projects with one head are one entity", found("Delphi needs a Today view"), ["project:Delphi"]);
check("an acronym in a project's name finds the project", found("the SSNR fix"), ["project:SSNR / MPI Person Update"]);
check("a slug key finds the project", found("filed under ssnr-mpi"), ["project:SSNR / MPI Person Update"]);
check("a project named with an ordinary word is not matched in prose", found("in general it works"), []);
check("a recurring capitalised name is learned", found("Stripe is down"), ["term:Stripe"]);
check("a word written in lower case elsewhere is not a name", found("The Board and the board"), []);
check("an identifier seen twice is learned as code", found("retry add_correlation now"), ["code:add_correlation"]);
check("shouted log words are not learned", oracle.extract("SUCCESS FAIL", vocab).length, 0);
check("a repository name is found", found("billing-service is slow"), ["repo:billing-service"]);
check("a short name is only a person as an @mention", [found("ray of light"), found("ask @ray")], [[], ["person:ray"]]);
check("a hyphenated actor is found as written in prose", found("Claude Code did it"), ["person:claude-code"]);
check("sources that are not people are left out", found("the app did it"), []);
check("the seed still works", found("Caseflow in devtest"), ["env:devtest", "service:Caseflow"]);
check("a standard is not a ticket, a ticket is", found("SHA-256 and APPEALS-1234"), ["ticket:APPEALS-1234"]);
check("with no rows, only the seed and the patterns", oracle.extract("Offerworks and MPI").map((e) => e.name), ["MPI"]);

// --- the fixture -------------------------------------------------------------

section("the fixture");
const offer = db.createProject({ key: "offerworks", name: "Offerworks" });
const va = db.createProject({ key: "ssnr-mpi", name: "SSNR / MPI Person Update" });
// Long bodies, so a tool that returns them whole blows any budget at once.
const filler = (topic, i) => Array.from({ length: 30 }, (_, k) =>
  `Paragraph ${k} of note ${i} about ${topic}: the Caseflow service calls MPI through the Veteran API, and the retry ` +
  `budget in devtest is three attempts before the circuit breaker opens for ten minutes.`).join("\n");
const notes = [];
for (let i = 0; i < 40; i++) {
  notes.push(db.createNote({ projectId: va.id, title: `Caseflow and MPI finding ${i}`, body: filler("MPI", i), kind: i % 3 ? "note" : "gotcha" }));
}
const answerNote = db.createNote({
  projectId: va.id, kind: "gotcha",
  title: "Veteran API 401 in UAT is the Vault secret",
  body: "Symptom: Add Correlation gets 401 Tampered Token in UAT.\n\nThe UAT Veteran API validates tokens against a " +
        "different JWT signing key than devtest, because its secret lives at a different Vault path. Rotating the " +
        "Vault secret in UAT fixed the 401.",
});
const offerNote = db.createNote({ projectId: offer.id, kind: "decision", title: "Hosting: Kamal on Hetzner", body: "Chosen for cost. Postmark sends mail." });
// No word in common with the question below, so only meaning can find it.
const meaningNote = db.createNote({ projectId: offer.id, kind: "note", title: "Pricing page copy", body: "Plans are weekly or monthly." });
for (let i = 0; i < 60; i++) db.createTask({ projectId: va.id, title: `MPI retest ${i} in devtest`, detail: filler("tasks", i).slice(0, 1500) });
const offerTask = db.createTask({ projectId: offer.id, title: "Deploy with Kamal" });
const busy = db.createTask({ projectId: va.id, title: "A task with a long Sheet", detail: "x".repeat(6000) });
oracle.open(db.handle());
const built = oracle.rebuild(db.handle());
check("the rebuild is quick", built.ms < 2000, true);

// An entities table from before the learned kinds is rebuilt, not refused.
const old = path.join(dir, "old.db");
{
  const { DatabaseSync } = require("node:sqlite");
  const h = new DatabaseSync(old);
  h.exec(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
  h.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('ticket','pr','repo','service','file','person','env','concept')),
          name TEXT NOT NULL, display TEXT, summary TEXT, mentions INTEGER NOT NULL DEFAULT 0,
          first_seen TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (kind, name))`);
  h.exec("INSERT INTO projects (key, name) VALUES ('offerworks', 'Offerworks')");
  h.exec("INSERT INTO notes (project_id, title, body) VALUES (1, 'Offerworks plan', 'Offerworks ships in May.')");
  oracle.rebuild(h);
  check("an old entities table takes the learned kinds", h.prepare("SELECT kind, name FROM entities WHERE kind = 'project'").all().map((r) => r.name), ["Offerworks"]);
  h.close();
}

// --- the server ----------------------------------------------------------------

delete process.env.ELECTRON_RUN_AS_NODE;
const tokens = (value) => Math.round(JSON.stringify(value).length / 4);

/** A fake Ollama: answers with a fixed vector, or never answers at all. */
function fakeOllama(mode) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (mode === "hang") return; // never answers
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ embedding: [0, 1, 0, 0] }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// Four-dimensional vectors under the model name the server will ask for. The
// pricing note is the one the fake model's answer points at.
const blob = (v) => Buffer.from(new Float32Array(v).buffer);
const insertVector = db.handle().prepare(
  "INSERT INTO embeddings (source_type, source_id, model, dims, vector, content_hash) VALUES (?, ?, 'ollama:nomic-embed-text', 4, ?, ?)");
insertVector.run("note", meaningNote.id, blob([0, 1, 0, 0]), "a");
insertVector.run("note", answerNote.id, blob([1, 0, 0, 0]), "b");
insertVector.run("note", offerNote.id, blob([0, 0, 1, 0]), "c");
for (let i = 0; i < 30; i++) db.handle().prepare("INSERT INTO comments (task_id, author, body) VALUES (?, 'claude-code:1', ?)").run(busy.id, `step ${i}: ${"words ".repeat(80)}`);
db.handle().exec("PRAGMA wal_checkpoint(TRUNCATE)");

async function route(name, env) {
  const closed = await new Promise((resolve) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const client = openServer({ actor: "claude-code:9", clientName: "test", warn: () => {},
    env: { DELPHI_AUTHOR_TYPE: "agent", DELPHI_OLLAMA: `http://127.0.0.1:${closed}`, ...env } });
  await client.start();
  try {
    section(`${name}: the default stays inside the budget`);
    const calls = [
      ["oracle_context", { name: "Caseflow" }],
      ["oracle_context", { name: "MPI" }],
      ["oracle_context", { name: "Offerworks" }],
      ["oracle_ask", { question: "why does the Veteran API return 401 in UAT" }],
      ["search", { query: "MPI" }],
      ["get_task", { id: busy.id }],
    ];
    for (const [tool, args] of calls) {
      const t = tokens(await client.call(tool, args));
      check(`${tool} ${JSON.stringify(args)} is under 1,500 tokens (${t})`, t < 1500, true);
    }
    const tight = await client.call("search", { query: "MPI", budget: 300 });
    check("a smaller budget is kept, and says it trimmed", [tokens(tight) <= 300, tight.trimmed], [true, true]);

    section(`${name}: what the brief answers say`);
    const ask = await client.call("oracle_ask", { question: "why does the Veteran API return 401 in UAT" });
    check("the answer cites the note that answers it", ask.answer.includes(`[note ${answerNote.id}]`), true);
    check("in that note's own words", ask.answer.includes("different JWT signing key than devtest"), true);
    check("and the note leads the list", ask.notes[0].id, answerNote.id);
    check("no bodies, a snippet instead", [ask.notes.every((n) => !("body" in n)), typeof ask.notes[0].snippet], [true, "string"]);
    const ctx = await client.call("oracle_context", { name: "Offerworks" });
    check("a project resolves, with its notes and tasks", [ctx.entity.kind, ctx.notes.some((n) => n.id === offerNote.id), ctx.tasks.some((t) => t.id === offerTask.id)], ["project", true, true]);
    check("so does an acronym in a project's name", (await client.call("oracle_context", { name: "SSNR" })).entity.kind, "project");
    const listing = await client.call("oracle_context", {});
    check("no name lists what the graph knows", listing.entities.some((e) => e.startsWith("Caseflow (service")), true);
    const found = await client.call("search", { query: "MPI" });
    check("search counts everything it matched", [found.total.notes, found.total.tasks], [40, 60]);
    const task = await client.call("get_task", { id: busy.id });
    check("get_task clips a long detail and Sheet, and says so", [task.clipped, task.task.detail.length < 3000, "comments" in task], [["detail", "sheet"], true, false]);
    check("and keeps the entry ids", task.entry_ids.length > 0 && task.entry_ids.length <= task.comments_total, true);
    check("get_note says more", (await client.call("get_note", { id: answerNote.id })).body.includes("Rotating the Vault secret"), true);
    check("for several at once", (await client.call("get_note", { ids: [answerNote.id, offerNote.id, 99999] })).missing, [99999]);

    section(`${name}: the old answers, by asking for them`);
    const full = await client.call("search", { query: "MPI", detail: "full" });
    check("search full: whole bodies, up to 30", [full.notes.length, typeof full.notes[0].body], [30, "string"]);
    const fullCtx = await client.call("oracle_context", { name: "Caseflow", detail: "full" });
    check("oracle_context full: the old shape", Object.keys(fullCtx), ["entity", "projects", "notes", "tasks", "related"]);
    check("with bodies", typeof fullCtx.notes[0].body, "string");
    const fullAsk = await client.call("oracle_ask", { question: "Vault secret rotation", detail: "full" });
    check("oracle_ask full: the old shape", Object.keys(fullAsk), ["note", "tasks", "notes", "connected"]);
    const fullTask = await client.call("get_task", { id: busy.id, detail: "full" });
    check("get_task full: every entry as JSON, nothing clipped", [fullTask.comments.length, fullTask.task.detail.length], [20, 6000]);
    check("oracle_entities is still callable", Array.isArray(await client.call("oracle_entities", { kind: "project" })), true);

    section(`${name}: fewer tools listed, none lost`);
    const names = (await client.request("tools/list", {})).tools.map((t) => t.name);
    check("folded tools are not listed", ["oracle_entities", "sheet_promote", "workbench_status", "lock_acquire", "lock_release", "lock_status"].filter((n) => names.includes(n)), []);
    check("their broader tools are", ["oracle_context", "sheet_update", "workbench_list", "lock", "get_note"].filter((n) => names.includes(n)).length, 5);
    const held = await client.call("lock", { key: "db/schema.sql", project: "offerworks" });
    check("lock takes a lease", held.held, true);
    check("lock status lists it", (await client.call("lock", { action: "status", project: "offerworks" })).map((l) => l.key), ["db/schema.sql"]);
    check("the old name still works", (await client.call("lock_release", { key: "db/schema.sql", project: "offerworks" })).released, true);
    const entry = db.handle().prepare("SELECT id FROM comments WHERE task_id = ? ORDER BY id LIMIT 1").get(busy.id).id;
    check("sheet_update promotes", (await client.call("sheet_update", { id: entry, promote: true })).promoted, 1);
    check("and unpromotes", (await client.call("sheet_update", { id: entry, promote: false })).promoted, 0);
    check("workbench_list with a task_id is its status", await client.call("workbench_list", { task_id: busy.id }), { workbench: null });

    section(`${name}: ranking without a model`);
    const started = Date.now();
    const lexical = await client.call("oracle_ask", { question: "what are the subscription options" });
    check("Ollama down: lexical, said plainly", [lexical.ranking.includes("semantic"), typeof lexical.semantic_off], [false, "string"]);
    check("and quickly", Date.now() - started < 1500, true);
  } finally {
    client.close();
  }

  section(`${name}: ranking with a model`);
  const fake = await fakeOllama("answer");
  const withModel = openServer({ actor: "claude-code:9", clientName: "test", warn: () => {},
    env: { DELPHI_AUTHOR_TYPE: "agent", DELPHI_OLLAMA: `http://127.0.0.1:${fake.address().port}`, ...env } });
  await withModel.start();
  try {
    const sem = await withModel.call("oracle_ask", { question: "what are the subscription options" });
    check("Ollama up: semantic ranking is used", sem.ranking.includes("semantic"), true);
    check("and finds the note by meaning alone", sem.notes[0].id, meaningNote.id);
    const s = await withModel.call("search", { query: "subscription" });
    check("search uses it too", s.ranking.includes("semantic"), true);
  } finally {
    withModel.close();
    fake.close();
  }

  const hung = await fakeOllama("hang");
  const slow = openServer({ actor: "claude-code:9", clientName: "test", warn: () => {},
    env: { DELPHI_AUTHOR_TYPE: "agent", DELPHI_OLLAMA: `http://127.0.0.1:${hung.address().port}`, DELPHI_EMBED_TIMEOUT_MS: "300", ...env } });
  await slow.start();
  try {
    const t0 = Date.now();
    const r = await slow.call("oracle_ask", { question: "what are the subscription options" });
    check("a model that never answers costs the timeout and no more", [r.ranking.includes("semantic"), Date.now() - t0 < 1500], [false, true]);
    const t1 = Date.now();
    await slow.call("search", { query: "subscription" });
    check("and is not asked again straight away", Date.now() - t1 < 250, true);
  } finally {
    slow.close();
    hung.closeAllConnections && hung.closeAllConnections();
    hung.close();
  }
}

(async () => {
  await route("node:sqlite", {});
  await route("sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" });
  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
