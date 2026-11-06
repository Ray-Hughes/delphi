#!/usr/bin/env node
// When undo refuses, on rows an agent wrote through the real server on both
// routes and rows the window wrote.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/undo_conflict_test.js
//
// Undo puts back only what is still as the change left it (agent/audit.js
// makeUndoRules). Each regression below is a problem found on a copy of the
// real database, reproduced here first:
//
//   - undoing an agent's change replayed the old row over a person's newer edit
//   - undoing a task's creation deleted other people's comments on it, unasked
//   - undoing a handoff's row failed with an SQL error and stopped undoLast

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-undo-conflict-"));
process.env.DELPHI_DATA_DIR = dir;
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const { openServer } = require("../sheet/client");

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}
function refuses(what, fn, pattern) {
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
  console.error(`  FAIL ${what}\n       did not refuse`);
}
function section(name) { console.log(`\n${name}`); }
const one = (text, ...params) => db.handle().prepare(text).get(...params);
const auditFor = (entity, id, like) =>
  one(`SELECT * FROM audit WHERE entity = ? AND entity_id = ? AND summary LIKE ? ORDER BY id DESC LIMIT 1`, entity, id, like);
// A fresh window step, as the next click would get. The window's step lasts
// one turn of the event loop, so writes in one synchronous run share it.
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

delete process.env.ELECTRON_RUN_AS_NODE;

async function client(actor, env) {
  const c = openServer({ actor, env, clientName: "test", warn: () => {} });
  await c.start();
  return c;
}

async function route(name, routeEnv) {
  const tag = name.replace(/[^a-z]/g, "");
  const P = db.createProject({ key: `p-${tag}`, name: `P ${tag}` });
  const agent = await client("claude-code:4", { DELPHI_AUTHOR_TYPE: "agent", ...routeEnv });
  try {
    section(`${name}: an agent's change, then a person's newer edit`);
    const t = await agent.call("add_task", { title: "agent wrote this", project_id: P.id });
    await agent.call("update_task", { id: t.id, title: "agent renamed it" });
    const agentEdit = auditFor("task", t.id, "updated%");
    await tick();
    db.updateTask(t.id, { title: "a person fixed it" });
    await tick();
    refuses("undoing the agent's change names the later edit", () => db.undo(agentEdit.id), /^You changed "agent renamed it" after this \(title changed\)\. Undo that first/);
    check("and the person's edit is still there", one("SELECT title FROM tasks WHERE id = ?", t.id).title, "a person fixed it");
    check("the agent's row is not marked undone", one("SELECT undone FROM audit WHERE id = ?", agentEdit.id).undone, 0);

    section(`${name}: drift, a write no row describes`);
    const d = await agent.call("add_task", { title: "drifting", project_id: P.id });
    await agent.call("update_task", { id: d.id, priority: "high" });
    const prio = auditFor("task", d.id, "updated%");
    db.handle().prepare("UPDATE tasks SET priority = 'low' WHERE id = ?").run(d.id);
    refuses("undo refuses a field that is not as the change left it", () => db.undo(prio.id), /has changed since \(priority\)/);
    db.handle().prepare("UPDATE tasks SET priority = 'high', detail = 'unrelated' WHERE id = ?").run(d.id);
    db.undo(prio.id);
    check("a change to another field does not stand in the way, and survives the undo",
      [one("SELECT priority FROM tasks WHERE id = ?", d.id).priority, one("SELECT detail FROM tasks WHERE id = ?", d.id).detail], ["med", "unrelated"]);

    section(`${name}: undoing a create others have hung things off`);
    const c = await agent.call("add_task", { title: "agent filed this", project_id: P.id });
    const created = auditFor("task", c.id, "created%");
    await tick();
    db.createComment({ taskId: c.id, body: "my thoughts", author: "you" });
    await tick();
    refuses("a person's comment stops the create being undone, by name", () => db.undo(created.id),
      /Undoing the creation of "agent filed this" would delete what depends on it: you have written an entry on its Sheet/);
    check("the task and the comment are still there",
      [Boolean(one("SELECT id FROM tasks WHERE id = ?", c.id)), one("SELECT COUNT(*) AS n FROM comments WHERE task_id = ?", c.id).n], [true, 1]);
    const s = await agent.call("add_task", { title: "has a subtask", project_id: P.id });
    await tick();
    db.createTask({ projectId: P.id, title: "a person's subtask", parentId: s.id });
    await tick();
    refuses("so does a subtask someone added", () => db.undo(auditFor("task", s.id, "created%").id), /it has a subtask added since/);
    const own = await agent.call("add_task", { title: "agent's own", project_id: P.id });
    await agent.call("sheet_append", { task_id: own.id, kind: "say", body: "my own note" });
    check("its own entry does not: undoLast takes the entry, then the task", db.undoLast(2), { undone: 2, stopped: null });
    check("both are gone", [one("SELECT id FROM tasks WHERE id = ?", own.id) || null, one("SELECT COUNT(*) AS n FROM comments WHERE task_id = ?", own.id).n], [null, 0]);

    section(`${name}: a Workbench and a job`);
    const w = await agent.call("add_task", { title: "has a Workbench", project_id: P.id });
    const repo = db.handle().prepare("INSERT INTO repos (project_id, name, path) VALUES (?, 'r', ?) RETURNING id").get(P.id, path.join(dir, `r-${tag}`));
    db.handle().prepare("INSERT INTO workbenches (task_id, repo_id, path, branch, base) VALUES (?, ?, ?, 'delphi/t1-x', 'main')").run(w.id, repo.id, path.join(dir, `wb-${tag}`));
    refuses("a live Workbench stops it", () => db.undo(auditFor("task", w.id, "created%").id), /it has a Workbench on delphi\/t1-x; Finish or Discard it first/);

    section(`${name}: a Sheet entry`);
    const q = await agent.call("add_task", { title: "a question", project_id: P.id });
    const ask = await agent.call("sheet_ask", { task_id: q.id, question: "which?", options: ["this", "that"] });
    const askRow = auditFor("task", q.id, "asked%");
    await tick();
    db.handle().prepare("INSERT INTO comments (task_id, author, body, kind, ref_id) VALUES (?, 'you', 'a', 'decide', ?)").run(q.id, ask.id);
    refuses("an answered question cannot be taken back alone", () => db.undo(askRow.id), /answers entry/);
    const say = await agent.call("sheet_append", { task_id: q.id, kind: "say", body: "first words" });
    await agent.call("sheet_update", { id: say.id, body: "second words" });
    const editRow = auditFor("task", q.id, "edited entry%");
    db.undo(editRow.id);
    check("an edited entry goes back to its words", one("SELECT body FROM comments WHERE id = ?", say.id).body, "first words");
    const filed = await agent.call("sheet_file", { id: say.id, kind: "gotcha" });
    const fileRow = auditFor("task", q.id, "filed entry%");
    refuses("the filing cannot be taken back while its note is there", () => db.undo(fileRow.id), /Undo the note's creation first/);
    check("undoLast takes the note and then the filing", db.undoLast(2), { undone: 2, stopped: null });
    check("leaving no note and the entry as it was",
      [one("SELECT id FROM notes WHERE id = ?", filed.note.id) || null, one("SELECT note_id, promoted FROM comments WHERE id = ?", say.id)],
      [null, { note_id: null, promoted: 0 }]);
  } finally {
    agent.close();
  }
}

section("the window: legacy rows, a handoff, and undoLast");
(async () => {
  const W = db.createProject({ key: "window", name: "Window" });
  const t = db.createTask({ projectId: W.id, title: "old" });
  await tick();
  // A row as every agent update looked before 1.8: no previous state.
  db.handle().prepare("INSERT INTO audit (action, entity, entity_id, summary, label) VALUES ('update', 'task', ?, 'updated (by claude)', 'old')").run(t.id);
  const legacy = one("SELECT * FROM audit ORDER BY id DESC LIMIT 1");
  refuses("a legacy update says it has no previous state", () => db.undo(legacy.id), /no recorded previous state/);
  check("and History marks it", db.listAudit(5).find((r) => r.id === legacy.id).legacy, 1);
  check("History falls back to the suffix for its actor", db.listAudit(5).find((r) => r.id === legacy.id).actor, null);
  db.handle().prepare("UPDATE audit SET undone = 1 WHERE id = ?").run(legacy.id);

  await tick();
  db.updateTask(t.id, { title: "newer" });
  await tick();
  const h = db.createHandoff({ projectId: W.id, toHarness: "codex", request: "have a look" });
  const hRow = one("SELECT * FROM audit WHERE entity = 'handoff' AND entity_id = ?", h.id);
  refuses("undoing a handoff's row says so in words, not SQL", () => db.undo(hRow.id), /^That is a job's own record/);
  check("History offers no undo on it", db.listAudit(5).find((r) => r.id === hRow.id).restorable, 0);
  check("undoLast steps over it to the change beneath", db.undoLast(1), { undone: 1, stopped: null });
  check("which was the rename", one("SELECT title FROM tasks WHERE id = ?", t.id).title, "old");

  await tick();
  db.updateTask(t.id, { title: "mine" });
  await tick();
  db.handle().prepare("UPDATE tasks SET title = 'someone else' WHERE id = ?").run(t.id);
  const stopped = db.undoLast(1);
  check("undoLast follows the rule too, and says why it stopped", [stopped.undone, /has changed since \(title\)/.test(stopped.stopped || "")], [0, true]);

  await route("node:sqlite", {});
  await route("sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" });
  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
