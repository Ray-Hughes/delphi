#!/usr/bin/env node
// In review, the fifth status: the one table rebuild, and the rules around it.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/review_status_test.js
//
// The rebuild drops and remakes the table every task lives in, so most of this
// is about what must survive it: on a database shaped exactly as 1.7.x left it
// (tools/fixtures/v1_7_schema.sql is v1.7.4's schema.sql), every row keeps its
// id and every column, every index and trigger comes back, the foreign keys
// still cascade, History is untouched, a restore point names the snapshot, and
// a second open changes nothing. A rebuild that fails part way leaves the file
// as it was.
//
// Then the rules: agents can put work up for review but not take it out, the
// queue and the dispatcher never hand it out, a pad line for it is never
// ticked by an agent, Today shows it under Needs you rather than as stuck, and
// a server meeting a database that has not been rebuilt yet (on either route)
// keeps serving and refuses only a write of review, without rebuilding it.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-review-status-"));
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  for (const p of [process.env.DELPHI_DB, path.join(dir, "delphi.db")]) {
    if (p && path.resolve(p) === real) { console.error("refusing to run against a real database"); process.exit(1); }
  }
}

const schemaLater = require("../agent/schema_later");
const OLD_SCHEMA = fs.readFileSync(path.join(__dirname, "fixtures", "v1_7_schema.sql"), "utf8");

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}
function ok(what, cond) { check(what, Boolean(cond), true); }
function section(name) { console.log(`\n${name}`); }
const plain = (rows) => rows.map((r) => ({ ...r }));

/**
 * A database as 1.7.x made it: v1.7.4's schema, a project, parents and
 * subtasks in every status it knew, Sheet entries, status events, an alert,
 * a pad and History rows. The ids have gaps, so a copy that renumbered would
 * show.
 */
function oldDatabase(file) {
  const h = new DatabaseSync(file);
  h.exec("PRAGMA journal_mode = WAL");
  h.exec("PRAGMA foreign_keys = ON");
  h.exec(OLD_SCHEMA);
  h.exec(`INSERT INTO projects (id, key, name) VALUES (3, 'old', 'Old project')`);
  h.exec(`INSERT INTO scratchpads (id, project_id, key, title, body) VALUES (2, 3, 'plan', 'Plan', '- [ ] a line')`);
  const statuses = ["todo", "doing", "blocked", "done", "todo", "doing"];
  statuses.forEach((s, i) => {
    const id = 10 + i * 7;
    h.prepare(`INSERT INTO tasks (id, project_id, title, detail, status, priority, queue, assignee, colour, completed_at)
               VALUES (?, 3, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, `task ${id}`, `detail for ${id}`, s, i % 2 ? "high" : "med", i < 3 ? "ready" : null, i === 1 ? "claude-code" : null,
           i === 2 ? "teal" : null, s === "done" ? "2026-10-01 10:00:00" : null);
    h.prepare("INSERT INTO status_events (task_id, status, actor, at) VALUES (?, ?, 'you', '2026-10-01 09:00:00')").run(id, s);
    h.prepare("INSERT INTO comments (task_id, author, body, kind, promoted) VALUES (?, 'you', ?, 'say', ?)").run(id, `entry on ${id}`, i % 2);
    h.prepare("INSERT INTO audit (action, entity, entity_id, summary, label, after_json, actor) VALUES ('create', 'task', ?, 'created', ?, '{}', 'you')").run(id, `task ${id}`);
  });
  h.exec("INSERT INTO tasks (id, project_id, title, status, parent_id) VALUES (90, 3, 'a subtask', 'todo', 17)");
  h.exec("INSERT INTO comments (task_id, author, body) VALUES (90, 'you', 'on the subtask')");
  h.exec("INSERT INTO alerts (task_id, fire_at, message) VALUES (24, '2026-12-01 09:00:00', 'look again')");
  h.exec("UPDATE tasks SET pad_id = 2, external_key = 'pad:2:10' WHERE id = 10");
  // A person's own view and a trigger on another table, both naming tasks:
  // since SQLite 3.26 a rename re-checks them, and between the drop and the
  // rename "tasks" does not exist.
  h.exec("CREATE VIEW mine_open AS SELECT id, title FROM tasks WHERE status != 'done'");
  h.exec(`CREATE TRIGGER comment_touches_task AFTER INSERT ON comments BEGIN
    UPDATE tasks SET updated_at = '2030-01-01 00:00:00' WHERE id = new.task_id; END`);
  h.close();
}

/** Everything the rebuild must not change, read the same way before and after. */
function picture(h) {
  const q = (s) => plain(h.prepare(s).all());
  return {
    tasks: q("SELECT * FROM tasks ORDER BY id"),
    events: q("SELECT * FROM status_events ORDER BY id"),
    comments: q("SELECT id, task_id, body FROM comments ORDER BY id"),
    alerts: q("SELECT id, task_id FROM alerts ORDER BY id"),
    audit: q("SELECT * FROM audit ORDER BY id"),
    // Only the names: the definitions of the tables themselves are what changes.
    objects: q(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name IN ('tasks', 'status_events') AND sql IS NOT NULL ORDER BY type, name`),
    columns: q("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('tasks')"),
    foreignKeys: q("SELECT \"table\", \"from\", \"to\", on_delete FROM pragma_foreign_key_list('tasks') ORDER BY id"),
  };
}

// ---------------------------------------------------------------------------
// The held case runs in a child, because db.js opens one database per process.

if (process.env.REVIEW_TEST_CHILD === "bare") {
  // Opened with nobody having taken a snapshot: db.js takes its own.
  const db = require("../db");
  db.handle();
  const point = db.handle().prepare("SELECT backup_path FROM restore_points WHERE kind = 'rebuild'").get();
  process.stdout.write(JSON.stringify({ rebuild: db.statusRebuild(), ready: db.reviewReady(), backup: point ? point.backup_path : null,
    exists: Boolean(point && fs.existsSync(point.backup_path)),
    snapshotOld: point ? schemaLater.statusTables((q) => new DatabaseSync(point.backup_path, { readOnly: true }).prepare(q).all()).tasks : null }));
  process.exit(0);
}

if (process.env.REVIEW_TEST_CHILD === "held") {
  const db = require("../db");
  db.prepareStatusRebuild({ hold: true });
  db.handle();
  const result = { rebuild: db.statusRebuild(), ready: db.reviewReady() };
  try { db.updateTask(10, { status: "review" }); result.wrote = true; } catch (error) { result.refused = error.message; }
  result.status = db.handle().prepare("SELECT status FROM tasks WHERE id = 10").get().status;
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

// ---------------------------------------------------------------------------

process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
delete process.env.DELPHI_DB_ID;
delete process.env.ELECTRON_RUN_AS_NODE_FOR_CHILD;

function rebuildOnACopy() {
  section("the rebuild on a 1.7.x database (node:sqlite, one transaction)");
  oldDatabase(process.env.DELPHI_DB);
  const pristine = path.join(dir, "pristine-1.7.db");
  {
    const h = new DatabaseSync(process.env.DELPHI_DB);
    h.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    h.close();
    fs.copyFileSync(process.env.DELPHI_DB, pristine);
  }
  const before = (() => { const h = new DatabaseSync(process.env.DELPHI_DB); try { return picture(h); } finally { h.close(); } })();
  const q0 = (() => { const h = new DatabaseSync(process.env.DELPHI_DB); try { return schemaLater.statusTables((s) => h.prepare(s).all()); } finally { h.close(); } })();
  check("a 1.7.x database has the four-status CHECK on both tables", q0, { tasks: "old", status_events: "old" });

  // The snapshot, as main.js takes it: slice 1's beforeMigration, asked
  // through needsStatusRebuild, before the first open.
  const { createBackups } = require("../main/backups");
  const backups = createBackups({ dataDir: dir, dbPath: process.env.DELPHI_DB, source: () => null, sqlite: require("node:sqlite") });
  return backups.beforeMigration({ needs: schemaLater.needsStatusRebuild, label: "before-review" }).then((shot) => {
    ok("a snapshot was taken before the rebuild", shot && fs.existsSync(shot.file));
    const snap = new DatabaseSync(shot.file, { readOnly: true });
    check("the snapshot is the database as it was", picture(snap).tasks, before.tasks);
    check("and still has the old CHECK", schemaLater.statusTables((s) => snap.prepare(s).all()).tasks, "old");
    snap.close();

    const db = require("../db");
    db.prepareStatusRebuild({ file: shot.file });
    const h = db.handle();
    const result = db.statusRebuild();
    check("the first open rebuilt both tables", { ran: result.ran, tables: result.tables }, { ran: true, tables: ["tasks", "status_events"] });
    check("both tables now allow review", schemaLater.statusTables((s) => h.prepare(s).all()), { tasks: "ready", status_events: "ready" });
    const after = picture(h);
    // schema_later and schema.sql add 2.0's columns and indexes in the same
    // open, so the comparison is of what 1.7.x had, column by column.
    const keep = (rows, cols) => rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
    const oldCols = Object.keys(before.tasks[0]);
    check("every task row, id and column is intact", keep(after.tasks, oldCols), before.tasks);
    check("every status event is intact", after.events, before.events);
    check("every Sheet entry is intact", after.comments, before.comments);
    check("the alert is intact", after.alerts, before.alerts);
    check("History is intact (no row changed, none lost)", keep(after.audit, Object.keys(before.audit[0])), before.audit);
    check("the columns are the same, in the same order", after.columns.slice(0, before.columns.length), before.columns);
    check("the foreign keys are the same", after.foreignKeys, before.foreignKeys);
    const names = (p) => p.objects.map((o) => `${o.type}:${o.name}`);
    for (const n of names(before)) ok(`${n} came back`, names(after).includes(n));
    check("each index and trigger came back with its own definition",
      after.objects.filter((o) => names(before).includes(`${o.type}:${o.name}`)).map((o) => o.sql),
      before.objects.map((o) => o.sql));
    check("integrity_check is ok", h.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    check("no row points at nothing", h.prepare("PRAGMA foreign_key_check").all().length, 0);
    const points = plain(h.prepare("SELECT kind, label, backup_path, audit_id FROM restore_points WHERE kind = 'rebuild'").all());
    check("one restore point, naming the snapshot, after the newest History row",
      points, [{ kind: "rebuild", label: "Before adding In review", backup_path: shot.file, audit_id: before.audit[before.audit.length - 1].id }]);

    section("a second open is a no-op");
    const schemaBefore = plain(h.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all());
    const again = schemaLater.rebuildStatuses((s) => h.prepare(s).all(), { point: { file: "/nowhere.db" } });
    check("the rebuild finds nothing to do", again.ran, false);
    check("and changes no definition", plain(h.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()), schemaBefore);
    check("and writes no second restore point", h.prepare("SELECT COUNT(*) AS n FROM restore_points WHERE kind = 'rebuild'").get().n, 1);
    check("foreign keys are back on for the app's connection", h.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);

    section("the foreign keys still do their work");
    db.deleteTask(17);
    check("the view still reads", h.prepare("SELECT COUNT(*) AS n FROM mine_open").get().n > 0, true);
    db.createComment({ taskId: 31, body: "touch" });
    check("the trigger on comments still writes to tasks", h.prepare("SELECT updated_at FROM tasks WHERE id = 31").get().updated_at, "2030-01-01 00:00:00");
    check("deleting a task still cascades to its subtask and Sheet", [
      h.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id IN (17, 90)").get().n,
      h.prepare("SELECT COUNT(*) AS n FROM comments WHERE task_id IN (17, 90)").get().n,
      h.prepare("SELECT COUNT(*) AS n FROM status_events WHERE task_id = 17").get().n,
    ], [0, 0, 0]);

    return { db, pristine };
  });
}

function rollback(pristine) {
  section("a rebuild that fails part way changes nothing");
  const file = path.join(dir, "fails.db");
  fs.copyFileSync(pristine, file);
  const h = new DatabaseSync(file);
  h.exec("PRAGMA foreign_keys = ON");
  const q = (s) => h.prepare(s).all();
  schemaLater.apply(q);
  h.exec(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
  const before = picture(h);
  const defs = plain(h.prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('tasks', 'status_events')").all());
  let renames = 0;
  const failing = (s) => {
    // The second table's rename: the first table is already rebuilt by then.
    if (/^ALTER TABLE \w+_rebuilt RENAME/.test(s) && ++renames === 2) throw new Error("the disk went away");
    return q(s);
  };
  let threw = null;
  try { schemaLater.rebuildStatuses(failing, { point: { file: "/x.db" } }); } catch (error) { threw = error.message; }
  check("the failure is raised", threw, "the disk went away");
  check("both definitions are as they were", plain(h.prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('tasks', 'status_events')").all()), defs);
  check("every row is as it was", picture(h), before);
  check("no restore point was written", h.prepare("SELECT COUNT(*) AS n FROM restore_points").get().n, 0);
  check("no half-made table is left", h.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_rebuilt'").get().n, 0);
  check("foreign keys are back on", h.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  h.close();
}

function bare(pristine) {
  section("opened without main.js: db.js takes its own snapshot first");
  // A folder of its own, so its snapshot never shares a name or a folder with
  // the ones the rest of this test takes.
  const home = path.join(dir, "bare");
  fs.mkdirSync(path.join(home, "backups"), { recursive: true });
  const file = path.join(home, "bare.db");
  fs.copyFileSync(pristine, file);
  const data = path.join(dir, "bare-data");
  // One a failed launch left behind: no restore point names it.
  const stale = path.join(home, "backups", "before-review-2026-01-01T00-00-00-1-aaaaaa.db");
  fs.copyFileSync(pristine, stale);
  const out = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, REVIEW_TEST_CHILD: "bare", DELPHI_DB: file, DELPHI_DATA_DIR: data },
    encoding: "utf8",
  });
  let got = null;
  try { got = JSON.parse(out.stdout); } catch { console.error(out.stderr); }
  check("the rebuild ran", got && got.rebuild && got.rebuild.ran, true);
  ok("after a snapshot beside the file it opened, not in a data folder that is not its own", got && got.exists && got.backup.startsWith(path.join(home, "backups")));
  check("a before-review snapshot no restore point names is tidied away", fs.existsSync(stale), false);
  check("and only the one the rebuild came after is kept", fs.readdirSync(path.join(home, "backups")).filter((f) => /^before-review-/.test(f)).length, 1);
  check("which holds the database from before it", got && got.snapshotOld, "old");
}

function unknown() {
  section("a status CHECK this does not recognise is left alone");
  const h = new DatabaseSync(":memory:");
  h.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT CHECK (status IN ('open', 'closed')))");
  h.exec("CREATE TABLE status_events (id INTEGER PRIMARY KEY, status TEXT CHECK (status IN ('todo', 'doing', 'blocked', 'done')))");
  const q = (x) => h.prepare(x).all();
  check("it reads as unknown, and the other as old", schemaLater.statusTables(q), { tasks: "unknown", status_events: "old" });
  h.exec("DROP TABLE status_events");
  h.exec("CREATE TABLE status_events (id INTEGER PRIMARY KEY, status TEXT)");
  check("with nothing old there is nothing to rebuild", schemaLater.needsStatusRebuild(q), false);
  check("and the rebuild does nothing", schemaLater.rebuildStatuses(q).ran, false);
  check("review is not ready", schemaLater.reviewReady(q), false);
  h.close();
}

function held(pristine) {
  section("held back when no snapshot could be taken");
  const file = path.join(dir, "held.db");
  fs.copyFileSync(pristine, file);
  const out = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, REVIEW_TEST_CHILD: "held", DELPHI_DB: file, DELPHI_DATA_DIR: path.join(dir, "held-data") },
    encoding: "utf8",
  });
  let got = null;
  try { got = JSON.parse(out.stdout); } catch { console.error(out.stderr); }
  check("the rebuild did not run", got && got.rebuild, { ran: false, held: true });
  check("review is not ready", got && got.ready, false);
  ok("a write of review is refused with a sentence", got && /could not take a backup first/.test(got.refused || ""));
  check("and the task is unchanged", got && got.status, "todo");
}

function appRules(db) {
  section("the app: review is a status like the others, that nobody holds");
  const p = db.createProject({ key: "rv-app", name: "Review app" });
  const t = db.createTask({ projectId: p.id, title: "goes up for review" });
  db.setQueue(t.id, "ready");
  const claimed = db.claimNext({ queue: "ready", agent: "claude-code:1", projectId: p.id });
  check("an agent claimed it first", claimed && claimed.task.id, t.id);
  const up = db.updateTask(t.id, { status: "review" }, { actor: "claude-code:1" });
  check("it is in review, and the claim ended with it", [up.status, up.claimed_by, up.claim_expires], ["review", null, null]);
  check("a status event says so", db.statusEvents(t.id).map((e) => e.status), ["todo", "doing", "review"]);
  check("the queue does not list it as waiting", db.queueState("ready", p.id).waiting.map((x) => x.id), []);
  check("nor hand it out", db.claimNext({ queue: "ready", agent: "claude-code:2", projectId: p.id }), null);
  const other = db.createTask({ projectId: p.id, title: "still to do" });
  const ordered = db.listTasks({ projectId: p.id }).map((x) => x.id);
  check("it sorts straight after doing, before todo", ordered, [t.id, other.id]);
  const created = db.createTask({ projectId: p.id, title: "filed in review", status: "review" });
  check("a task can be filed straight into review", created.status, "review");
  const back = db.updateTask(t.id, { status: "doing" });
  check("a person moves it back to doing", back.status, "doing");
  check("and then it is claimable again", (db.claimNext({ queue: "ready", agent: "claude-code:2", projectId: p.id }) || { task: {} }).task.id, t.id);
  db.updateTask(t.id, { status: "review" });
  check("or on to done", db.updateTask(t.id, { status: "done" }).status, "done");

  section("today: in review waits on you, it is never stuck");
  const brief = require("../today/brief");
  const quiet = db.createTask({ projectId: p.id, title: "reviewed weeks ago" });
  db.updateTask(quiet.id, { status: "review" });
  // Ten days quiet, every trace of it moved back together.
  const h = db.handle();
  for (const s of [
    "UPDATE tasks SET updated_at = datetime('now', '-10 days'), created_at = datetime('now', '-12 days') WHERE id = ?",
    "UPDATE status_events SET at = datetime('now', '-10 days') WHERE task_id = ?",
    "UPDATE audit SET at = datetime('now', '-10 days') WHERE entity = 'task' AND entity_id = ?",
  ]) h.prepare(s).run(quiet.id);
  const stuck = brief.stuck(db.sqlP, { projectId: p.id });
  check("it is not on the stuck list", stuck.map((s) => s.id).includes(quiet.id), false);
  check("levelOf never marks review", [brief.levelOf("review", 3), brief.levelOf("review", 30)], [null, null]);
  const waiting = brief.inReview(db.sqlP, { projectId: p.id });
  const mine = waiting.find((w) => w.id === quiet.id);
  ok("it is listed for Needs you", mine);
  check("with how long it has waited", mine && [mine.days, mine.words], [10, "Waiting on your review for 10 days"]);
  check("oldest wait first", waiting[0].id, quiet.id);
  const parent = db.createTask({ projectId: p.id, title: "a parent still in progress", status: "doing" });
  const sub = db.createTask({ projectId: p.id, title: "a piece up for review", parentId: parent.id, status: "review" });
  check("a subtask in review is listed when its parent is not", brief.inReview(db.sqlP, { projectId: p.id }).some((w) => w.id === sub.id), true);
  db.updateTask(parent.id, { status: "review" });
  const both = brief.inReview(db.sqlP, { projectId: p.id }).map((w) => w.id);
  check("and stood for by its parent when both are", [both.includes(parent.id), both.includes(sub.id)], [true, false]);
}

function padRoundTrip(db) {
  section("pads: a review task's line is never ticked for it");
  const pads = require("../pads");
  check("statusFor keeps review on an unticked line", pads.statusFor(false, "review"), "review");
  check("a person's tick moves it on to done", pads.statusFor(true, "review"), "done");
  check("an agent's tick does not", pads.statusFor(true, "review", { finishReview: false }), "review");
  const p = db.createProject({ key: "rv-pad", name: "Review pad" });
  const pad = db.createScratchpad({ projectId: p.id, title: "Plan", body: "- [ ] write it\n- [ ] ship it" });
  const ids = db.scratchpadTasks(pad.id).lines.map((l) => l.task && l.task.id);
  db.updateTask(ids[0], { status: "review" });
  const body = db.getScratchpad(pad.id).body;
  ok("the line stays unticked when the task goes up for review", /^- \[ \] write it/m.test(body));
  db.writeScratchpad(pad.id, { body: db.getScratchpad(pad.id).body + "\n" });
  check("rewriting the pad leaves it in review", db.handle().prepare("SELECT status FROM tasks WHERE id = ?").get(ids[0]).status, "review");
  return { p, pad, ids };
}

async function server(db, name, routeEnv, padFixture) {
  const { openServer } = require("../sheet/client");
  section(`${name}: the server on the rebuilt database`);
  const p = db.createProject({ key: `rv-mcp-${name.replace(/[^a-z]/g, "")}`, name: `Review ${name}` });
  const t = db.createTask({ projectId: p.id, title: "an agent's work" });
  const held = db.createTask({ projectId: p.id, title: "another agent's work" });
  db.setQueue(t.id, "ready");
  db.setQueue(held.id, "ready");
  const agent = openServer({ actor: "claude-code:a", env: { DELPHI_AUTHOR_TYPE: "agent", ...routeEnv }, clientName: "test", warn: () => {} });
  const other = openServer({ actor: "codex:b", env: { DELPHI_AUTHOR_TYPE: "agent", ...routeEnv }, clientName: "test", warn: () => {} });
  const person = openServer({ actor: "ray", env: { DELPHI_AUTHOR_TYPE: "human", ...routeEnv }, clientName: "test", warn: () => {} });
  await Promise.all([agent.start(), other.start(), person.start()]);
  const refused = async (client, tool, args) => {
    try { await client.call(tool, args); return null; } catch (error) { return String(error.message || error); }
  };
  try {
    const mine = await agent.call("queue_next", { queue: "ready", project_id: p.id });
    const theirs = await other.call("queue_next", { queue: "ready", project_id: p.id });
    check("each agent claimed one", [mine.task.id, theirs.task.id].sort(), [t.id, held.id].sort());
    const ownId = mine.task.id;
    const theirId = theirs.task.id;
    const done = await agent.call("queue_complete", { task_id: ownId, summary: "built it, please look", review: true });
    check("queue_complete with review puts it up for review, unclaimed, still queued",
      [done.status, done.claimed_by, done.completed_at, done.queue], ["review", null, null, "ready"]);
    check("queue_next never hands it out", (await other.call("queue_next", { queue: "ready", project_id: p.id })).claimed, null);
    check("queue_status does not list it as waiting", (await agent.call("queue_status", { queue: "ready", project_id: p.id })).waiting.map((x) => x.id), []);
    ok("an agent cannot finish it", /waiting on a person/.test(await refused(agent, "update_task", { id: ownId, status: "done" }) || ""));
    ok("nor send it back to doing", /waiting on a person/.test(await refused(agent, "update_task", { id: ownId, status: "doing" }) || ""));
    ok("nor queue_complete it to done", /waiting on a person/.test(await refused(other, "queue_complete", { task_id: ownId, summary: "done" }) || ""));
    ok("nor put another agent's held task up for review", /held by codex:b/.test(await refused(agent, "update_task", { id: theirId, status: "review" }) || ""));
    ok("nor mark another agent's held task done", /held by codex:b/.test(await refused(agent, "update_task", { id: theirId, status: "done" }) || ""));
    ok("nor blocked", /held by codex:b/.test(await refused(agent, "update_task", { id: theirId, status: "blocked" }) || ""));
    ok("nor queue_complete it", /held by codex:b/.test(await refused(agent, "queue_complete", { task_id: theirId, summary: "mine now" }) || ""));
    check("and it is still theirs, in progress", { ...db.handle().prepare("SELECT status, claimed_by FROM tasks WHERE id = ?").get(theirId) }, { status: "doing", claimed_by: "codex:b" });
    const brief = await agent.call("daily_brief", { project_id: p.id });
    ok("daily_brief lists the task in review", (brief.in_review || []).some((l) => l.startsWith(`#${ownId} `)));
    const fullBrief = await agent.call("daily_brief", { project_id: p.id, detail: "full" });
    check("and in full", (fullBrief.in_review || []).map((r) => r.id), [ownId]);
    const elsewhere = db.createProject({ key: `${p.key}-x`, name: `${p.name} elsewhere` });
    ok("a refused status change in the same call as a move moves nothing",
      /waiting on a person/.test(await refused(agent, "update_task", { id: ownId, status: "done", project_id: elsewhere.id }) || "")
      && db.handle().prepare("SELECT project_id FROM tasks WHERE id = ?").get(ownId).project_id === p.id);
    const retitled = await agent.call("update_task", { id: ownId, title: "an agent's work, retitled" });
    check("an agent can still edit it otherwise", [retitled.status, retitled.title], ["review", "an agent's work, retitled"]);
    check("list_tasks filters by review", (await agent.call("list_tasks", { project_id: p.id, status: "review" })).map((x) => x.id), [ownId]);
    const moved = await person.call("update_task", { id: ownId, status: "done" });
    check("a person moves it on to done", moved.status, "done");
    const own2 = await other.call("update_task", { id: theirId, status: "review" });
    check("the holder puts its own task up for review", [own2.status, own2.claimed_by], ["review", null]);
    check("a person sends it back to doing", (await person.call("update_task", { id: theirId, status: "doing" })).status, "doing");
    check("the events read in order", db.statusEvents(ownId).map((e) => e.status), ["todo", "doing", "review", "done"]);

    // An agent ticking a review task's pad line leaves it in review and its line unticked.
    const { pad, ids } = padFixture;
    const reviewId = ids[0];
    const ticked = db.getScratchpad(pad.id).body.replace(/^- \[ \] write it/m, "- [x] write it");
    await agent.call("write_scratchpad", { project_id: pad.project_id, key: pad.key, title: pad.title, body: ticked });
    check("an agent's tick on a review line leaves the task in review", db.handle().prepare("SELECT status FROM tasks WHERE id = ?").get(reviewId).status, "review");
    ok("and the line is unticked again", /^- \[ \] write it/m.test(db.getScratchpad(pad.id).body));
  } finally {
    agent.close(); other.close(); person.close();
  }
}

async function oldServer(name, routeEnv, pristine) {
  const { openServer } = require("../sheet/client");
  section(`${name}: the server on a database 1.7.x left, not rebuilt yet`);
  const file = path.join(dir, `old-${name.replace(/[^a-z]/g, "")}.db`);
  fs.copyFileSync(pristine, file);
  const env = { DELPHI_AUTHOR_TYPE: "agent", DELPHI_DB: file, ...routeEnv };
  const agent = openServer({ actor: "claude-code:old", env, clientName: "test", warn: () => {} });
  await agent.start();
  try {
    const listed = await agent.call("list_tasks", { project_id: 3, include_done: true });
    check("it serves the old database", listed.length, 7);
    let refused = null;
    try { await agent.call("update_task", { id: 10, status: "review" }); } catch (error) { refused = String(error.message || error); }
    ok("a write of review is refused with the sentence to open the app", /Open the Delphi app once/.test(refused || ""));
    check("other writes still work", (await agent.call("update_task", { id: 10, status: "doing" })).status, "doing");
    let completed = null;
    try { await agent.call("queue_complete", { task_id: 10, summary: "x", review: true }); } catch (error) { completed = String(error.message || error); }
    ok("queue_complete into review is refused the same way", /Open the Delphi app once/.test(completed || ""));
  } finally {
    agent.close();
  }
  const h = new DatabaseSync(file, { readOnly: true });
  check("the server did not rebuild anything", schemaLater.statusTables((s) => h.prepare(s).all()), { tasks: "old", status_events: "old" });
  check("and the task it refused is not in review", h.prepare("SELECT status FROM tasks WHERE id = 10").get().status, "doing");
  h.close();
}

function dispatcher(db) {
  section("the dispatcher never files a review task as a job");
  const { createDispatcher } = require("../agent/dispatch");
  const p = db.createProject({ key: "rv-dispatch", name: "Review dispatch" });
  db.seedHarnesses(require("../harness").BUILTINS);
  const harness = db.listHarnesses().find((h) => h.enabled);
  ok("there is an enabled harness to queue for", harness);
  if (!harness) return;
  const t = db.createTask({ projectId: p.id, title: "waiting on a look", status: "review" });
  db.setQueue(t.id, harness.key);
  db.handle().prepare("UPDATE tasks SET queued_by = 'agent-x', queued_by_type = 'agent' WHERE id = ?").run(t.id);
  const d = createDispatcher({ sql: db.sqlP, settings: () => ({ jobConcurrency: 1, jobHarnessLimits: {} }), log: () => {} });
  try { d.tick(); } finally { if (d.close) d.close(); }
  check("no job for it", db.handle().prepare("SELECT COUNT(*) AS n FROM handoffs WHERE task_id = ?").get(t.id).n, 0);
}

async function main() {
  const { db, pristine } = await rebuildOnACopy();
  rollback(pristine);
  bare(pristine);
  unknown();
  held(pristine);
  appRules(db);
  const padFixture = padRoundTrip(db);
  delete process.env.ELECTRON_RUN_AS_NODE;
  await server(db, "node:sqlite", {}, padFixture);
  // A fresh pad line in review for the second route's tick.
  db.writeScratchpad(padFixture.pad.id, { body: db.getScratchpad(padFixture.pad.id).body });
  await server(db, "sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" }, padFixture);
  await oldServer("node:sqlite", {}, pristine);
  await oldServer("sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" }, pristine);
  dispatcher(db);
  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
