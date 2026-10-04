#!/usr/bin/env node
// items/store.js, on both of the routes it is given.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/items_store_test.js
//
// The store is handed a sql() and a batch(). In the app those bind against
// node:sqlite and run a batch under a savepoint; in the MCP server on its
// sqlite3 route they substitute literals and run a batch as one script in one
// process. Every rule here is checked on both, against the same file, because
// a move that is atomic on one route and half done on the other is exactly the
// bug the shared store exists to prevent. db.js integration (lists, undo,
// History) is checked on the app route after.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-items-"));
process.env.DELPHI_DATA_DIR = dir;
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const { makeItemStore } = require("../items/store");
const pads = require("../pads");

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}
function throws(what, fn, pattern) {
  checks++;
  try {
    fn();
  } catch (error) {
    if (pattern.test(String(error.message))) return error;
    failures++;
    console.error(`  FAIL ${what}\n       threw ${JSON.stringify(error.message)}\n       want  ${pattern}`);
    return error;
  }
  failures++;
  console.error(`  FAIL ${what}\n       did not throw`);
  return null;
}
function section(name) { console.log(`\n${name}`); }

// --- the sqlite3 route, as agent/mcp_server.js does it -------------------------------

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
const render = (query, params = []) => String(query).replace(/:p(\d+)/g, (m, n) => literal(params[Number(n) - 1]));
let fileN = 0;
function script(lines, json) {
  const file = path.join(dir, `q-${process.pid}-${fileN++}.sql`);
  fs.writeFileSync(file, lines.join("\n"));
  try {
    const out = execFileSync(SQLITE, [process.env.DELPHI_DB], { input: `.read ${file}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return json ? (out ? JSON.parse(out) : []) : null;
  } catch (error) {
    throw new Error(String(error.stderr || error.message).trim().split("\n")[0]);
  } finally {
    fs.rmSync(file, { force: true });
  }
}
const binarySql = (query, params = []) => {
  const statement = render(query, params);
  return script([".timeout 5000", ".mode json", ".headers on", statement.endsWith(";") ? statement : `${statement};`], true);
};
const binaryBatch = (statements) => script([".timeout 5000", ".bail on", "BEGIN IMMEDIATE;",
  ...statements.map(([q, p]) => { const s = render(q, p || []); return s.trim().endsWith(";") ? s : `${s};`; }), "COMMIT;"], false);

const ROUTES = [
  ["node:sqlite", { sql: db.sqlP, batch: db.batchP }],
  ["sqlite3 binary", { sql: binarySql, batch: binaryBatch }],
];

const q = (text, ...params) => db.handle().prepare(text).all(...params);
const one = (text, ...params) => db.handle().prepare(text).get(...params);

// --- the rules, on each route ---------------------------------------------------------------

function scenario(name, { sql, batch }) {
  const items = makeItemStore({ sql, batch, actor: "ray", authorType: "human" });
  const tag = name.replace(/[^a-z]/g, "");
  const A = db.createProject({ key: `a-${tag}`, name: `Alpha ${tag}` });
  const B = db.createProject({ key: `b-${tag}`, name: `Beta ${tag}` });
  const C = db.createProject({ key: `c-${tag}`, name: `Gamma ${tag}` });

  section(`${name}: a move takes the whole subtree`);
  const epic = db.createOrganizer({ projectId: A.id, name: "epic" });
  const root = db.createTask({ projectId: A.id, title: "root", organizerId: epic.id });
  const kid = db.createTask({ parentId: root.id, title: "kid" });
  const grandkid = db.createTask({ parentId: kid.id, title: "grandkid" });
  db.createComment({ taskId: kid.id, body: "a remark" });
  db.createAlert({ taskId: grandkid.id, fireAt: "2030-01-01 09:00:00", message: "later" });
  const planned = items.plan({ op: "move", entity: "task", id: root.id, to: B.id });
  check("plan is ok", planned.ok, true);
  check("plan counts the subtree", [planned.counts.tasks, planned.counts.subtasks, planned.counts.entries, planned.counts.alerts], [3, 2, 1, 1]);
  check("plan says it in a sentence", /Moves 1 task and 2 subtasks with 1 Sheet entry to Beta/.test(planned.summary), true);
  const moved = items.move("task", root.id, B.id);
  check("every task in the subtree is in the target",
    q("SELECT project_id FROM tasks WHERE id IN (?, ?, ?) ORDER BY id", root.id, kid.id, grandkid.id).map((r) => r.project_id), [B.id, B.id, B.id]);
  check("the epic it left is cleared", one("SELECT organizer_id FROM tasks WHERE id = ?", root.id).organizer_id, null);
  check("the Sheet entry and the reminder followed", [one("SELECT COUNT(*) AS n FROM comments WHERE task_id = ? AND kind = 'say'", kid.id).n, one("SELECT COUNT(*) AS n FROM alerts WHERE task_id = ?", grandkid.id).n], [1, 1]);
  check("a note on the root's Sheet says where it came from", /Moved from Alpha \w+ to Beta \w+ by ray/.test(one("SELECT body FROM comments WHERE task_id = ? AND kind = 'note' ORDER BY id DESC", root.id).body), true);
  check("the move is one History row on the task", one("SELECT entity, entity_id, action FROM audit WHERE id = ?", moved.auditId), { entity: "task", entity_id: root.id, action: "update" });
  check("which the project it left can find", JSON.parse(one("SELECT before_json FROM audit WHERE id = ?", moved.auditId).before_json).project_id, A.id);
  check("moved lists the tasks", moved.moved.tasks.sort(), [root.id, kid.id, grandkid.id].sort());

  section(`${name}: a subtask moves only out of its parent`);
  throws("refused without detach", () => items.move("task", kid.id, C.id), /subtask of task \d+; it moves with its parent/);
  items.move("task", kid.id, C.id, { detach: true });
  check("detached and moved with its own subtree", [one("SELECT parent_id, project_id FROM tasks WHERE id = ?", kid.id), one("SELECT project_id FROM tasks WHERE id = ?", grandkid.id).project_id],
    [{ parent_id: null, project_id: C.id }, C.id]);

  section(`${name}: work in progress refuses, saying why`);
  const held = db.createTask({ projectId: A.id, title: "held" });
  db.handle().prepare("UPDATE tasks SET claimed_by = 'codex', claim_expires = datetime('now', '+30 minutes') WHERE id = ?").run(held.id);
  throws("a live claim", () => items.move("task", held.id, B.id), /held by codex until .*release it or wait/);
  db.handle().prepare("UPDATE tasks SET claimed_by = NULL, claim_expires = NULL WHERE id = ?").run(held.id);
  const job = one("INSERT INTO handoffs (project_id, to_harness, task_id, request, state, status) VALUES (?, 'codex', ?, 'do it', 'running', 'running') RETURNING id", A.id, held.id);
  throws("a running job", () => items.move("task", held.id, B.id), new RegExp(`Job ${job.id} \\(codex\\) is running on task ${held.id}`));
  db.handle().prepare("UPDATE handoffs SET state = 'done', status = 'ready' WHERE id = ?").run(job.id);
  const runEntry = one("INSERT INTO comments (task_id, author, kind, body, meta) VALUES (?, 'ray', 'run', 'npm test', '{\"state\":\"running\"}') RETURNING id", held.id);
  throws("a command still running on its Sheet", () => items.move("task", held.id, B.id), new RegExp(`still running on task ${held.id}'s Sheet \\(entry ${runEntry.id}\\)`));
  db.handle().prepare("UPDATE comments SET meta = '{\"state\":\"ok\"}' WHERE id = ?").run(runEntry.id);
  check("and moves once nothing is in progress", items.plan({ op: "move", entity: "task", id: held.id, to: B.id }).ok, true);
  throws("into its own home", () => items.move("task", held.id, A.id), /already lives in Alpha/);

  section(`${name}: associations`);
  const note = db.createNote({ projectId: A.id, title: "shared note", body: "about two projects" });
  const first = items.associate("note", note.id, B.id);
  check("associate returns the other projects", first.projects.map((p) => p.id), [B.id]);
  const again = items.associate("note", note.id, B.id);
  check("associate is idempotent", [again.auditId, q("SELECT * FROM item_projects WHERE entity = 'note' AND entity_id = ?", note.id).length], [null, 1]);
  throws("not to its own home", () => items.associate("note", note.id, A.id), /already lives in Alpha/);
  throws("a subtask is never associated", () => items.associate("task", grandkid.id, A.id), /is a subtask; it appears wherever its parent does/);
  items.move("note", note.id, B.id, { keepInSource: true });
  check("moving into an associated project makes it home and keepInSource keeps the old one",
    [one("SELECT project_id FROM notes WHERE id = ?", note.id).project_id, q("SELECT project_id FROM item_projects WHERE entity = 'note' AND entity_id = ?", note.id).map((r) => r.project_id)],
    [B.id, [A.id]]);
  const gone = items.dissociate("note", note.id, A.id);
  check("dissociate", gone.projects, []);
  throws("dissociating a project it is not shown in", () => items.dissociate("note", note.id, C.id), /is not shown in Gamma/);
  const w = items.where("note", note.id);
  check("where names the home", w.home.id, B.id);

  section(`${name}: copy`);
  const src = db.createTask({ projectId: A.id, title: "original", detail: "d", priority: "high" });
  const srcKid = db.createTask({ parentId: src.id, title: "original kid" });
  db.handle().prepare("UPDATE tasks SET queue = 'ready', claimed_by = 'x', claim_expires = datetime('now', '-1 minutes'), external_key = ? WHERE id = ?").run(`ext:${tag}`, src.id);
  const chat = one("INSERT INTO comments (task_id, author, kind, body) VALUES (?, 'ray', 'say', 'chatter') RETURNING id", src.id);
  const key = one("INSERT INTO comments (task_id, author, kind, body, promoted) VALUES (?, 'ray', 'say', 'a finding', 1) RETURNING id", src.id);
  const ask = one("INSERT INTO comments (task_id, author, kind, body, meta) VALUES (?, 'ray', 'ask', 'which?', '{\"options\":[\"x\",\"y\"]}') RETURNING id", src.id);
  one("INSERT INTO comments (task_id, author, kind, body, ref_id, meta) VALUES (?, 'ray', 'decide', 'x', ?, '{\"choice\":\"a\"}') RETURNING id", src.id, ask.id);
  const copied = items.copy("task", src.id, C.id);
  const copyRow = one("SELECT * FROM tasks WHERE id = ?", copied.id);
  check("the copy lives in the target, fields kept, work fields cleared",
    [copyRow.project_id, copyRow.title, copyRow.priority, copyRow.queue, copyRow.claimed_by, copyRow.external_key, copyRow.pad_id, copyRow.source],
    [C.id, "original", "high", null, null, null, null, "copy"]);
  const copyKid = one("SELECT * FROM tasks WHERE parent_id = ?", copied.id);
  check("subtasks come too, under the copy", [copyKid && copyKid.title, copyKid && copyKid.project_id], ["original kid", C.id]);
  check("provenance for every row", q("SELECT entity_id, source_id FROM item_copies WHERE entity = 'task' AND entity_id IN (?, ?) ORDER BY entity_id", copied.id, copyKid.id).map((r) => r.source_id), [src.id, srcKid.id]);
  const copiedBodies = q("SELECT kind, body FROM comments WHERE task_id = ? ORDER BY id", copied.id).map((r) => `${r.kind}:${r.body}`);
  check("the ledger only, after a note saying where from", copiedBodies.slice(1), ["say:a finding", "ask:which?", "decide:x"]);
  check("no chatter", copiedBodies.some((b) => b.includes("chatter")), false);
  check("the decision still answers the copied question", (() => {
    const d = one("SELECT ref_id FROM comments WHERE task_id = ? AND kind = 'decide'", copied.id);
    return one("SELECT body FROM comments WHERE id = ?", d.ref_id).body;
  })(), "which?");
  void chat; void key;
  const tasksBefore = one("SELECT COUNT(*) AS n FROM tasks").n;
  const commentsBefore = one("SELECT COUNT(*) AS n FROM comments").n;
  throws("a copy that fails part way", () => items.apply([{ op: "copy", entity: "task", id: src.id, to: C.id }], { failAfterRows: "injected" }), /The copy failed and nothing was kept: injected/);
  check("leaves no partial copy", [one("SELECT COUNT(*) AS n FROM tasks").n, one("SELECT COUNT(*) AS n FROM comments").n], [tasksBefore, commentsBefore]);
  const linkRow = db.createLink({ projectId: A.id, label: "docs", url: "https://example.invalid" });
  const linkCopy = items.copy("link", linkRow.id, B.id);
  check("a link copy", one("SELECT project_id, url FROM links WHERE id = ?", linkCopy.id), { project_id: B.id, url: "https://example.invalid" });

  section(`${name}: pads`);
  const pad = db.createScratchpad({ projectId: A.id, title: "plan", key: "plan", body: "# Plan\n\n- [ ] first line\n  - [ ] its sub\n- [ ] second line\n" });
  const padTasks = q("SELECT id, title FROM tasks WHERE pad_id = ? ORDER BY id", pad.id);
  check("the pad derived three tasks", padTasks.length, 3);
  db.createScratchpad({ projectId: B.id, title: "plan", key: "plan", body: "" });
  const padMove = items.plan({ op: "move", entity: "scratchpad", id: pad.id, to: B.id });
  check("a key clash gets the old project's key as a suffix", /becomes plan-a-/.test(padMove.summary), true);
  items.move("scratchpad", pad.id, B.id);
  check("its tasks follow by default", q("SELECT DISTINCT project_id FROM tasks WHERE pad_id = ?", pad.id).map((r) => r.project_id), [B.id]);
  check("and its key changed", one("SELECT key FROM scratchpads WHERE id = ?", pad.id).key.startsWith("plan-a-"), true);
  const stay = db.createScratchpad({ projectId: A.id, title: "notes", key: "notes", body: "- [ ] keep me\n" });
  items.move("scratchpad", stay.id, C.id, { tasks: "stay" });
  check("tasks stay when asked", q("SELECT project_id FROM tasks WHERE pad_id = ?", stay.id).map((r) => r.project_id), [A.id]);
  const padCopy = items.copy("scratchpad", pad.id, C.id);
  const copiedPad = one("SELECT body, derives_tasks FROM scratchpads WHERE id = ?", padCopy.id);
  check("a pad copy has no anchors and derives nothing", [/<!--d:/.test(copiedPad.body), copiedPad.derives_tasks, one("SELECT COUNT(*) AS n FROM tasks WHERE pad_id = ?", padCopy.id).n], [false, 0, 0]);

  section(`${name}: carrying a task's line to the target's pad`);
  const carryPad = db.createScratchpad({ projectId: A.id, title: "carry", key: `carry`, body: "- [ ] carry me\n  - [ ] and my sub\n- [ ] stay here\n" });
  const [carryRoot, carrySub] = q("SELECT id FROM tasks WHERE pad_id = ? ORDER BY id", carryPad.id).map((r) => r.id);
  items.move("task", carryRoot, C.id, { pad: "carry" });
  const targetPad = one("SELECT * FROM scratchpads WHERE project_id = ? AND key = 'plan'", C.id);
  check("the target got a plan pad with both lines", [Boolean(targetPad), pads.anchoredIds(targetPad.body).has(carryRoot), pads.anchoredIds(targetPad.body).has(carrySub)], [true, true, true]);
  check("the source pad lost them and kept the rest", one("SELECT body FROM scratchpads WHERE id = ?", carryPad.id).body.trim(), `- [ ] stay here <!--d:${q("SELECT id FROM tasks WHERE pad_id = ?", carryPad.id)[0].id}-->`);
  check("their pad and external key were rewritten", q("SELECT pad_id, external_key FROM tasks WHERE id IN (?, ?) ORDER BY id", carryRoot, carrySub),
    [{ pad_id: targetPad.id, external_key: `pad:${targetPad.id}:${carryRoot}` }, { pad_id: targetPad.id, external_key: `pad:${targetPad.id}:${carrySub}` }]);
  const tasksNow = one("SELECT COUNT(*) AS n FROM tasks").n;
  db.derive(carryPad.id);
  db.derive(targetPad.id);
  check("deriving both pads files no duplicate", one("SELECT COUNT(*) AS n FROM tasks").n, tasksNow);

  section(`${name}: a live Workbench`);
  const repo = db.createRepo({ projectId: A.id, name: `repo-${tag}`, path: path.join(dir, `repo-${tag}`) });
  const benchTask = db.createTask({ projectId: A.id, title: "has a bench" });
  db.handle().prepare("INSERT INTO workbenches (task_id, repo_id, path, branch, base, state) VALUES (?, ?, ?, 'b', 'main', 'active')").run(benchTask.id, repo.id, path.join(dir, `wb-${tag}`));
  const benchPlan = items.plan({ op: "move", entity: "task", id: benchTask.id, to: B.id });
  check("the move is allowed and keeps the old project", [benchPlan.ok, benchPlan.keepInSource, /stays in repo-/.test(benchPlan.summary)], [true, true, true]);
  items.move("task", benchTask.id, B.id);
  check("the Workbench row is unchanged", one("SELECT task_id, repo_id, state FROM workbenches WHERE task_id = ?", benchTask.id), { task_id: benchTask.id, repo_id: repo.id, state: "active" });
  check("the old project stays associated", q("SELECT project_id FROM item_projects WHERE entity = 'task' AND entity_id = ?", benchTask.id).map((r) => r.project_id), [A.id]);
  throws("and cannot be dissociated while it is live", () => items.dissociate("task", benchTask.id, A.id), /Workbench is still open in repo-.*Finish or Discard/);

  section(`${name}: undo puts back exactly what moved`);
  const u = db.createTask({ projectId: A.id, title: "undo me" });
  const uKid = db.createTask({ parentId: u.id, title: "undo kid" });
  const uMove = items.move("task", u.id, B.id, { keepInSource: true });
  db.handle().prepare("UPDATE tasks SET title = 'renamed after the move' WHERE id = ?").run(u.id);
  items.undo(one("SELECT * FROM audit WHERE id = ?", uMove.auditId));
  check("back in its project with its subtask", q("SELECT project_id FROM tasks WHERE id IN (?, ?)", u.id, uKid.id).map((r) => r.project_id), [A.id, A.id]);
  check("the later edit is kept", one("SELECT title FROM tasks WHERE id = ?", u.id).title, "renamed after the move");
  check("the association it added is gone", q("SELECT * FROM item_projects WHERE entity = 'task' AND entity_id = ?", u.id).length, 0);
  const m1 = items.move("task", u.id, B.id);
  items.move("task", u.id, C.id);
  throws("refused once it has moved again", () => items.undo(one("SELECT * FROM audit WHERE id = ?", m1.auditId)), /moved again since, to Gamma .*undo that first/);
  const cp = db.createScratchpad({ projectId: A.id, title: "carry2", key: "carry2", body: "- [ ] go\n" });
  const goId = q("SELECT id FROM tasks WHERE pad_id = ?", cp.id)[0].id;
  const carried = items.move("task", goId, B.id, { pad: "carry" });
  db.handle().prepare("UPDATE scratchpads SET body = body || 'edited' WHERE id = ?").run(cp.id);
  throws("refused once a carried pad has been edited", () => items.undo(one("SELECT * FROM audit WHERE id = ?", carried.auditId)), /pad has been edited since/);

  section(`${name}: epics, sessions, repositories, links`);
  const e2 = db.createOrganizer({ projectId: A.id, name: "epic two" });
  const filed = db.createTask({ projectId: A.id, title: "filed", organizerId: e2.id });
  const filedKid = db.createTask({ parentId: filed.id, title: "filed kid" });
  const eMove = items.move("organizer", e2.id, B.id);
  check("the epic and its tasks move together, still filed", [one("SELECT project_id FROM organizers WHERE id = ?", e2.id).project_id,
    one("SELECT project_id, organizer_id FROM tasks WHERE id = ?", filed.id), one("SELECT project_id FROM tasks WHERE id = ?", filedKid.id).project_id],
  [B.id, { project_id: B.id, organizer_id: e2.id }, B.id]);
  check("recorded against the project it moved into", one("SELECT entity, entity_id FROM audit WHERE id = ?", eMove.auditId), { entity: "project", entity_id: B.id });
  const session = db.createSession({ projectId: A.id, title: "chat" });
  db.handle().prepare("UPDATE sessions SET run_state = 'running' WHERE id = ?").run(session.id);
  throws("a running session stays", () => items.move("session", session.id, B.id), /is running; move it once it is idle/);
  db.handle().prepare("UPDATE sessions SET run_state = 'idle' WHERE id = ?").run(session.id);
  items.move("session", session.id, B.id);
  check("an idle one moves", one("SELECT project_id FROM sessions WHERE id = ?", session.id).project_id, B.id);
  throws("a repository with a live Workbench stays", () => items.move("repo", repo.id, C.id), /Workbench is still open in repo-/);
  items.move("link", linkRow.id, C.id);
  check("a link moves", one("SELECT project_id FROM links WHERE id = ?", linkRow.id).project_id, C.id);

  section(`${name}: flags`);
  const f1 = items.flag({ entity: "note", id: note.id, note: "this is in the wrong place", evaluate: "none" });
  check("a flag changes nothing about the item", one("SELECT project_id FROM notes WHERE id = ?", note.id).project_id, B.id);
  check("it is open, from a person", [f1.flag.status, f1.flag.source, f1.appended], ["open", "person", false]);
  const f2 = items.flag({ entity: "note", id: note.id, note: "agreed", evaluate: "none" });
  check("a second flag joins the first", [f2.flag.id, f2.appended, f2.flag.entries], [f1.flag.id, true, 2]);
  const proposed = items.propose({ flagId: f1.flag.id, ops: [{ op: "move", entity: "note", id: note.id, to: C.id, keepInSource: true }], reasoning: "it is Gamma's", confidence: 0.7, by: "claude-code:1", evaluator: "claude-code:1" });
  check("a proposal is recorded with its plan, not applied", [proposed.flag.status, proposed.plan[0].ok, one("SELECT project_id FROM notes WHERE id = ?", note.id).project_id], ["proposed", true, B.id]);
  throws("an agent cannot approve", () => items.decide(f1.flag.id, { approve: true, by: "claude-code:1", byType: "agent" }), /a person's decision, and this is an agent/);
  throws("a rejection says why", () => items.decide(f1.flag.id, { approve: false }), /Say why when rejecting/);
  const applied = items.decide(f1.flag.id, { approve: true, note: "yes" });
  check("approval applies it and the flag says so", [applied.flag.status, applied.flag.decided_by, one("SELECT project_id FROM notes WHERE id = ?", note.id).project_id, applied.flag.applied_audit_id === applied.auditIds[0]],
    ["applied", "ray", C.id, true]);
  check("its History row credits the proposer", /proposed by claude-code:1 \(by ray\)$/.test(one("SELECT summary FROM audit WHERE id = ?", applied.auditIds[0]).summary), true);
  items.undo(one("SELECT * FROM audit WHERE id = ?", applied.auditIds[0]));
  check("undoing an applied flag returns it to proposed", [items.getFlag(f1.flag.id).flag.status, one("SELECT project_id FROM notes WHERE id = ?", note.id).project_id], ["proposed", B.id]);
  const rejected = items.decide(f1.flag.id, { approve: false, note: "no, it is fine" });
  check("rejected", rejected.flag.status, "rejected");
  const doomed = db.createNote({ projectId: A.id, title: "doomed", body: "x" });
  const fd = items.flag({ entity: "note", id: doomed.id, note: "?", evaluate: "none" });
  db.deleteNote(doomed.id);
  check("deleting the item makes its live flag stale", items.getFlag(fd.flag.id).flag.status, "stale");
  const impossible = items.flag({ entity: "task", id: held.id, note: "move it", evaluate: "none" });
  db.handle().prepare("UPDATE tasks SET claimed_by = 'codex', claim_expires = datetime('now', '+30 minutes') WHERE id = ?").run(held.id);
  const bad = items.propose({ flagId: impossible.flag.id, ops: [{ op: "move", entity: "task", id: held.id, to: B.id }], reasoning: "x" });
  check("an impossible proposal is recorded and shown as impossible", [bad.flag.status, bad.plan[0].ok], ["proposed", false]);
  throws("approving it refuses", () => items.decide(impossible.flag.id, { approve: true }), /held by codex/);
  check("and the flag is failed, not applied", items.getFlag(impossible.flag.id).flag.status, "failed");
  db.handle().prepare("UPDATE tasks SET claimed_by = NULL, claim_expires = NULL WHERE id = ?").run(held.id);
  const needs = items.needsYou({ projectId: A.id });
  check("Needs you rows have the dispatcher's shape", needs.every((r) => r.source === "flag" && r.title && r.summary && Array.isArray(r.actions)), true);
  check("an agent's propose on another item is refused", (() => { try { items.propose({ flagId: fd.flag.id, ops: [{ op: "move", entity: "note", id: note.id, to: A.id }], reasoning: "x" }); return "no"; } catch (e) { return /stale/.test(e.message) ? "refused" : e.message; } })(), "refused");
  return { A, B, C };
}

// --- db.js, on the app's route ---------------------------------------------------------------

function appSide() {
  section("db.js: lists include what is shown from elsewhere");
  const P = db.createProject({ key: "home-p", name: "Home P" });
  const Q = db.createProject({ key: "other-q", name: "Other Q" });
  const items = db.items();
  const parent = db.createTask({ projectId: P.id, title: "shared parent" });
  const child = db.createTask({ parentId: parent.id, title: "shared child" });
  const sharedNote = db.createNote({ projectId: P.id, title: "shared memo", body: "zebra" });
  const sharedPad = db.createScratchpad({ projectId: P.id, title: "shared pad", key: "sp", body: "text", derivesTasks: false });
  const sharedLink = db.createLink({ projectId: P.id, label: "l", url: "https://example.invalid/l" });
  for (const [e, id] of [["task", parent.id], ["note", sharedNote.id], ["scratchpad", sharedPad.id], ["link", sharedLink.id]]) items.associate(e, id, Q.id);
  const tasksQ = db.listTasks({ projectId: Q.id });
  check("listTasks has the associated task, marked", tasksQ.map((t) => [t.id, t.associated]), [[parent.id, 1]]);
  check("with subtasks, its subtask too", db.listTasks({ projectId: Q.id, includeSubtasks: true }).map((t) => t.id).sort(), [parent.id, child.id].sort());
  check("listTasks of the home marks it as home", db.listTasks({ projectId: P.id }).find((t) => t.id === parent.id).associated, 0);
  check("listNotes", db.listNotes(Q.id).map((n) => [n.id, n.associated, n.home_name]), [[sharedNote.id, 1, "Home P"]]);
  check("listScratchpads", db.listScratchpads(Q.id).map((n) => [n.id, n.associated]), [[sharedPad.id, 1]]);
  check("listLinks", db.listLinks(Q.id).map((n) => [n.id, n.associated]), [[sharedLink.id, 1]]);
  const counts = db.listProjects().find((p) => p.id === Q.id);
  check("project counts stay home only, with the shared count beside them", [counts.total_count, counts.note_count, counts.shared_count], [0, 0, 4]);
  check("search says where else a hit is shown", db.search("zebra").notes.find((n) => n.id === sharedNote.id).also_in, "Other Q");
  check("the associated project's History lists the association", db.projectActivity(Q.id).some((a) => a.entity === "note" && a.entity_id === sharedNote.id), true);
  check("projectContents counts what other projects still show", db.projectContents(P.id).shared_out, 4);
  const rehome = items.rehomePlan(P.id);
  check("the rehome plan names each, with where it would go", rehome.items.map((i) => [i.entity, i.id, i.to.id]),
    [["task", parent.id, Q.id], ["note", sharedNote.id, Q.id], ["scratchpad", sharedPad.id, Q.id], ["link", sharedLink.id, Q.id]]);

  section("db.js: updateTask with a project is a move");
  const R = db.createProject({ key: "third-r", name: "Third R" });
  const epic = db.createOrganizer({ projectId: P.id, name: "e" });
  const t = db.createTask({ projectId: P.id, title: "menu move", organizerId: epic.id });
  const tk = db.createTask({ parentId: t.id, title: "menu move kid" });
  db.updateTask(t.id, { project_id: R.id });
  check("the subtasks follow (the old Move to left them behind)", one("SELECT project_id FROM tasks WHERE id = ?", tk.id).project_id, R.id);
  check("and the epic is cleared", one("SELECT organizer_id FROM tasks WHERE id = ?", t.id).organizer_id, null);
  throws("a subtask alone is refused", () => db.updateTask(tk.id, { project_id: P.id }), /it moves with its parent/);
  db.updateTask(t.id, { title: "renamed later" });
  const moveRow = one("SELECT id FROM audit WHERE entity = 'task' AND entity_id = ? AND summary LIKE 'moved from%' ORDER BY id DESC", t.id);
  db.undo(moveRow.id);
  check("undo of the move through db.undo keeps the later rename", one("SELECT project_id, title FROM tasks WHERE id = ?", t.id), { project_id: P.id, title: "renamed later" });
  check("and the subtask came back too", one("SELECT project_id FROM tasks WHERE id = ?", tk.id).project_id, P.id);

  section("db.js: a delete keeps the associations for undo");
  db.deleteNote(sharedNote.id);
  check("the trigger took the association", one("SELECT COUNT(*) AS n FROM item_projects WHERE entity = 'note' AND entity_id = ?", sharedNote.id).n, 0);
  db.undoLast(1);
  check("undo brings it back with the association", [Boolean(one("SELECT id FROM notes WHERE id = ?", sharedNote.id)), one("SELECT COUNT(*) AS n FROM item_projects WHERE entity = 'note' AND entity_id = ?", sharedNote.id).n], [true, 1]);
  db.deleteTask(parent.id);
  db.undoLast(1);
  check("a task delete too", one("SELECT COUNT(*) AS n FROM item_projects WHERE entity = 'task' AND entity_id = ?", parent.id).n, 1);
  const assocRow = one("SELECT id FROM audit WHERE entity = 'link' AND entity_id = ? AND summary LIKE 'also shown in%'", sharedLink.id);
  db.undo(assocRow.id);
  check("undo of an association removes it", one("SELECT COUNT(*) AS n FROM item_projects WHERE entity = 'link' AND entity_id = ?", sharedLink.id).n, 0);
}

// Regressions from the review of b315415, each on the app's route.
function reviewed() {
  section("review: nobody approves their own proposal, and unset is not a person");
  const P = db.createProject({ key: "rv-p", name: "RV P" });
  const Q = db.createProject({ key: "rv-q", name: "RV Q" });
  const agent = makeItemStore({ sql: db.sqlP, batch: db.batchP, actor: "claude:1", authorType: "agent" });
  const n = db.createNote({ projectId: P.id, title: "rv note", body: "x" });
  const proposed = agent.propose({ entity: "note", id: n.id, ops: [{ op: "move", entity: "note", id: n.id, to: Q.id }], reasoning: "mine", by: "claude:1" });
  const sameName = makeItemStore({ sql: db.sqlP, batch: db.batchP, actor: "claude:1", authorType: "human" });
  throws("the proposer claiming to be a person cannot approve it", () => sameName.decide(proposed.flag.id, { approve: true }), /claude:1 proposed this, so claude:1 cannot also decide it/);
  const untyped = makeItemStore({ sql: db.sqlP, batch: db.batchP, actor: "someone" });
  throws("a writer with no type is not a person", () => untyped.decide(proposed.flag.id, { approve: true }), /has not said it is a person/);
  check("nothing moved", one("SELECT project_id FROM notes WHERE id = ?", n.id).project_id, P.id);
  const flaggedByAgent = agent.flag({ entity: "note", id: db.createNote({ projectId: P.id, title: "rv2", body: "y" }).id, note: "x", evaluate: "none" }).flag;
  db.items().propose({ flagId: flaggedByAgent.id, ops: [{ op: "move", entity: "note", id: flaggedByAgent.entity_id, to: Q.id }], reasoning: "x", by: "oracle" });
  throws("nor the agent that raised the flag, under its own name", () => sameName.decide(flaggedByAgent.id, { approve: true }), /raised this flag as an agent/);
  check("a person approves it", db.items().decide(flaggedByAgent.id, { approve: true }).flag.status, "applied");

  section("review: a flag does not block undo");
  const renamed = db.createNote({ projectId: P.id, title: "before", body: "z" });
  db.updateNote(renamed.id, { title: "after" });
  agent.flag({ entity: "note", id: renamed.id, note: "misfiled?", evaluate: "none" });
  const undone = db.undoLast(1);
  check("rename, flag it, undo: the name comes back", [undone.undone, one("SELECT title FROM notes WHERE id = ?", renamed.id).title], [1, "before"]);
  const flagRow = one("SELECT id FROM audit WHERE entity = 'note' AND entity_id = ? AND summary LIKE 'flagged%'", renamed.id);
  throws("undoing the flag row itself says what to do instead", () => db.undo(flagRow.id), /Withdraw or reject the flag/);
  check("and History does not offer it as restorable", db.listAudit(200).find((a) => a.id === flagRow.id).restorable, 0);

  section("review: a detached subtask stays detached through the pad");
  const pad = db.createScratchpad({ projectId: P.id, title: "rv pad", key: "rv-pad", body: "- [ ] parent\n  - [ ] child\n- [ ] other\n" });
  const [parentId, childId] = q("SELECT id FROM tasks WHERE pad_id = ? ORDER BY id", pad.id).map((r) => r.id);
  check("the pad filed the child under its parent", one("SELECT parent_id FROM tasks WHERE id = ?", childId).parent_id, parentId);
  const detached = db.items().move("task", childId, Q.id, { detach: true });
  db.derive(pad.id);
  check("derive after the detach leaves it with no parent, in its new project", one("SELECT parent_id, project_id FROM tasks WHERE id = ?", childId), { parent_id: null, project_id: Q.id });
  check("its line is at the top level of the pad", /^- \[ \] child/m.test(one("SELECT body FROM scratchpads WHERE id = ?", pad.id).body), true);
  db.undo(detached.auditId);
  check("undo puts it and its line back under the parent", [one("SELECT parent_id, project_id FROM tasks WHERE id = ?", childId), /^  - \[ \] child/m.test(one("SELECT body FROM scratchpads WHERE id = ?", pad.id).body)],
    [{ parent_id: parentId, project_id: P.id }, true]);

  section("review: undo of an approved flag after the item was flagged again");
  const n3 = db.createNote({ projectId: P.id, title: "rv3", body: "w" });
  const f3 = db.items().flag({ entity: "note", id: n3.id, note: "x", evaluate: "none" }).flag;
  agent.propose({ flagId: f3.id, ops: [{ op: "move", entity: "note", id: n3.id, to: Q.id }], reasoning: "x", by: "claude:1" });
  const applied = db.items().decide(f3.id, { approve: true });
  const f4 = agent.flag({ entity: "note", id: n3.id, note: "again", evaluate: "none" }).flag;
  db.undo(applied.auditIds[0]);
  check("the undo works, the old flag stays applied, the new one stays live", [one("SELECT project_id FROM notes WHERE id = ?", n3.id).project_id,
    db.items().getFlag(f3.id).flag.status, db.items().getFlag(f4.id).flag.status], [P.id, "applied", "open"]);

  section("review: undo of a move takes a subtask added since");
  const root = db.createTask({ projectId: P.id, title: "rv root" });
  const mv = db.items().move("task", root.id, Q.id);
  const late = db.createTask({ parentId: root.id, title: "added after the move" });
  db.undo(mv.auditId);
  check("the tree goes home whole", [one("SELECT project_id FROM tasks WHERE id = ?", root.id).project_id, one("SELECT project_id FROM tasks WHERE id = ?", late.id).project_id], [P.id, P.id]);

  section("review: undoing a project delete brings its associations back");
  const D = db.createProject({ key: "rv-d", name: "RV D" });
  const dn = db.createNote({ projectId: D.id, title: "shown elsewhere", body: "v" });
  db.items().associate("note", dn.id, Q.id);
  const elsewhere = db.createNote({ projectId: Q.id, title: "shown in D", body: "u" });
  db.items().associate("note", elsewhere.id, D.id);
  db.deleteProject(D.id, { tasks: "delete" });
  check("the delete took both", one("SELECT COUNT(*) AS n FROM item_projects WHERE (entity = 'note' AND entity_id = ?) OR project_id = ?", dn.id, D.id).n, 0);
  db.undoLast(1);
  check("undo restores both", q("SELECT entity_id, project_id FROM item_projects WHERE (entity = 'note' AND entity_id = ?) OR project_id = ? ORDER BY entity_id", dn.id, D.id)
    .map((r) => [r.entity_id, r.project_id]).sort(), [[dn.id, Q.id], [elsewhere.id, D.id]].sort());
}

for (const [name, route] of ROUTES) scenario(name, route);
appSide();
reviewed();

console.log(`\n${checks - failures}/${checks} checks passed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
