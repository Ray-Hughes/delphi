#!/usr/bin/env node
// Today's rules: which tasks are stuck, which one the banner names, what the
// daily brief holds, and when you were last here.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/today_test.js
//
// today/brief.js is SQL handed a sql() function, so it is run three ways on
// one seeded database: through db.js's binding sqlP (the window's route), and
// through the real MCP server's daily_brief on node:sqlite and on the sqlite3
// binary (DELPHI_SQLITE_ROUTE=binary), which writes every value into the text.
// A brief that differs between them is the bug a shared store is there to stop.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-today-"));
process.env.DELPHI_DATA_DIR = dir;
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const brief = require("../today/brief");
const { createToday } = require("../main/today");
const { makeSheetStore } = require("../sheet/store");
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
const section = (name) => console.log(`\n${name}`);

section("the stuck rule, by status and days");
for (const [status, days, want] of [
  ["todo", 40, null], ["done", 40, null],
  ["doing", 2, null], ["doing", 3, "amber"], ["doing", 6, "amber"], ["doing", 7, "red"], ["doing", 90, "red"],
  ["blocked", 3, "amber"], ["blocked", 30, "amber"],
  // A status a newer Delphi wrote reads as in progress (slice 0).
  ["shipped", 7, "red"],
  // In review waits on a person: Needs you shows it, and it is never stuck.
  ["review", 3, null], ["review", 30, null],
]) check(`${status} for ${days} days is ${want || "not stuck"}`, brief.levelOf(status, days), want);
check("the marks are words as well as colour", [brief.markOf("amber", 4), brief.markOf("red", 9)], ["Idle 4d", "9d"]);
{
  const at = new Date(2026, 10, 6, 9, 0, 0).getTime();
  check("due in five hours is Due in 5h, in progress or blocked",
    [brief.dueSoonHours("doing", "2026-11-06 14:00", at), brief.dueSoonHours("blocked", "2026-11-06 14:00", at)], [5, 5]);
  check("a bare day is due at its end", brief.dueSoonHours("doing", "2026-11-06", at), 15);
  check("tomorrow's end is more than a day off", brief.dueSoonHours("doing", "2026-11-07", at), null);
  check("past due is overdue, not due soon", brief.dueSoonHours("doing", "2026-11-05", at), null);
  check("to-do and done are never marked", [brief.dueSoonHours("todo", "2026-11-06", at), brief.dueSoonHours("done", "2026-11-06", at)], [null, null]);
}
check("the sentence", [brief.movementWords(1), brief.movementWords(12)], ["No movement in 1 day", "No movement in 12 days"]);
check("stamp reads SQLite text as UTC and ISO as given",
  [brief.stamp("2026-11-06 07:00:00"), brief.stamp("2026-11-06T07:00:00.000Z"), brief.stamp("nonsense")],
  ["2026-11-06 07:00:00", "2026-11-06 07:00:00", null]);

// ---------------------------------------------------------------------------
// The seed. Every task is made through db.js and then put back in time by
// hand, History rows and all, because creating it wrote a History row "now"
// and that is itself movement.

const q = (s, p = []) => db.sqlP(s, p);
const project = db.createProject({ key: "today", name: "Today test" });
const other = db.createProject({ key: "gone", name: "Archived one" });
const ago = (days) => `datetime('now', '-${Math.round(days * 24 * 60)} minutes')`;
function task(title, status, days, extra = {}) {
  const t = db.createTask({ projectId: extra.projectId || project.id, title, priority: extra.priority || "med", parentId: extra.parentId || null });
  q(`UPDATE tasks SET status = :p1, created_at = ${ago(days + 1)}, updated_at = ${ago(days)} WHERE id = :p2`, [status, t.id]);
  q(`UPDATE audit SET at = ${ago(days)} WHERE entity = 'task' AND entity_id = :p1`, [t.id]);
  q(`DELETE FROM status_events WHERE task_id = :p1`, [t.id]);
  return t.id;
}

const red = task("doing for ten days", "doing", 10, { priority: "high" });
const blocked = task("blocked for ten days", "blocked", 10);
const backlog = task("to do for a month", "todo", 30);
const amber = task("doing for three and a half days", "doing", 3.5);
const talked = task("doing, but its Sheet spoke yesterday", "doing", 10);
const ran = task("doing, but a job ran two days ago", "doing", 10);
const benched = task("doing, but its Workbench moved yesterday", "doing", 10);
const parent = task("doing, but a subtask moved yesterday", "doing", 10);
task("the subtask", "todo", 1, { parentId: parent });
const parent2 = task("doing, but a subtask's Sheet spoke yesterday", "doing", 10);
const sub2 = task("its quiet subtask", "todo", 10, { parentId: parent2 });
task("done long ago", "done", 50);
task("doing for two days", "doing", 2);
task("doing in an archived project", "doing", 10, { projectId: other.id });
db.updateProject(other.id, { status: "archived" });
q(`UPDATE audit SET at = ${ago(20)} WHERE entity = 'project'`);

const claude = makeSheetStore({ sql: db.sqlP, batch: db.batchP, actor: "claude-code:3", authorType: "agent" });
const person = makeSheetStore({ sql: db.sqlP, batch: db.batchP, actor: "you", authorType: "human" });
q(`INSERT INTO comments (task_id, author, author_type, body, kind, created_at, updated_at)
   VALUES (:p1, 'you', 'human', 'still on it', 'say', ${ago(1)}, ${ago(1)})`, [talked]);
const repo = q("INSERT INTO repos (project_id, name, path, is_primary) VALUES (:p1, 'r', '/tmp/today-r', 1) RETURNING id", [project.id])[0].id;
q(`INSERT INTO handoffs (project_id, to_harness, task_id, request, status, state, kind, created_at, last_activity, finished_at, updated_at)
   VALUES (:p1, 'claude-code', :p2, 'look', 'ready', 'done', 'ask', ${ago(3)}, ${ago(2)}, ${ago(2)}, ${ago(2)})`, [project.id, ran]);
q(`INSERT INTO workbenches (task_id, repo_id, path, branch, base, state, created_at, updated_at)
   VALUES (:p1, :p2, '/tmp/today-wb-a', 'ray/a', 'main', 'parked', ${ago(9)}, ${ago(1)})`, [benched, repo]);
q(`UPDATE tasks SET updated_at = ${ago(1)} WHERE parent_id = :p1`, [parent]);
q(`INSERT INTO comments (task_id, author, author_type, body, kind, created_at, updated_at)
   VALUES (:p1, 'codex:2', 'agent', 'tried the fix', 'say', ${ago(1)}, ${ago(1)})`, [sub2]);

section("which tasks are stuck, on db.js's route");
const rows = brief.stuck(db.sqlP);
const byId = new Map(rows.map((r) => [r.id, r]));
check("doing for ten days is red, 10d", [byId.get(red) && byId.get(red).level, byId.get(red) && byId.get(red).mark], ["red", "10d"]);
check("blocked for ten days is amber, never red", byId.get(blocked) && byId.get(blocked).mark, "Idle 10d");
check("three and a half days is amber, Idle 3d", byId.get(amber) && byId.get(amber).mark, "Idle 3d");
check("to-do is never stuck", byId.has(backlog), false);
check("a Sheet entry is movement", byId.has(talked), false);
check("a job is movement", byId.has(ran), false);
check("a Workbench is movement", byId.has(benched), false);
check("a subtask moving is movement for its parent", byId.has(parent), false);
check("a subtask's Sheet is movement for its parent", byId.has(parent2), false);
check("exactly these three, loudest first", rows.map((r) => r.id), [red, blocked, amber]);
check("the banner names the red one", brief.bannerOf(rows).id, red);
check("no red, no banner", brief.bannerOf(rows.filter((r) => r.level !== "red")), null);
check("one project only", brief.stuck(db.sqlP, { projectId: other.id }).length, 0);
check("every quiet row says why", rows.map((r) => r.reason), ["idle", "idle", "idle"]);

section("due within 24 hours is amber too (plan, slice 7)");
{
  const pad = (n) => String(n).padStart(2, "0");
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const soon = local(new Date(Date.now() + 5 * 3600 * 1000 - 20 * 60 * 1000));
  const dueDoing = task("in progress, due in five hours", "doing", 0.1);
  const dueTodo = task("to do, due in five hours", "todo", 0.1);
  const dueFar = task("in progress, due next week", "doing", 0.1);
  q("UPDATE tasks SET due = :p1 WHERE id IN (:p2, :p3)", [soon, dueDoing, dueTodo]);
  q("UPDATE tasks SET due = date('now', '+7 days') WHERE id = :p1", [dueFar]);
  q("UPDATE tasks SET due = :p1 WHERE id = :p2", [soon, red]);
  const due = new Map(brief.stuck(db.sqlP).map((r) => [r.id, r]));
  const d = due.get(dueDoing);
  check("in progress and due in five hours: amber, Due in 5h", d && [d.level, d.reason, d.mark, d.words], ["amber", "due", "Due in 5h", "Due in 5 hours"]);
  check("a to-do due soon is not marked", due.has(dueTodo), false);
  check("due next week is not marked", due.has(dueFar), false);
  check("red quiet outranks due soon", [due.get(red).level, due.get(red).reason], ["red", "idle"]);
  // Quiet for three and a half days and due soon: the row says Due, the brief still says it went quiet.
  q("UPDATE tasks SET due = :p1 WHERE id = :p2", [soon, amber]);
  const both = brief.stuck(db.sqlP).find((r) => r.id === amber);
  check("quiet and due soon: the mark is Due, the quiet rule still holds", [both.reason, both.idle], ["due", "amber"]);
  check("and the brief still reports it went quiet", brief.brief(db.sqlP, { since: brief.stamp(Date.now() - 86400000) }).groups
    .flatMap((g) => g.lines).filter((l) => l.kind === "stuck" && l.task_id === amber).map((l) => l.mark), ["Idle 3d"]);
  q("UPDATE tasks SET due = NULL WHERE id = :p1", [amber]);
  check("due soon is not newly stuck in the brief", brief.brief(db.sqlP, { since: brief.stamp(Date.now() - 3600000) }).groups
    .flatMap((g) => g.lines).some((l) => l.kind === "stuck" && l.task_id === dueDoing), false);
  q("UPDATE tasks SET due = NULL WHERE id IN (:p1, :p2, :p3, :p4)", [dueDoing, dueTodo, dueFar, red]);
  q("UPDATE tasks SET status = 'done' WHERE id IN (:p1, :p2, :p3)", [dueDoing, dueTodo, dueFar]);
}

// ---------------------------------------------------------------------------
// The brief. Since a day ago.

const since = brief.stamp(Date.now() - 86400000);
const ask = claude.ask(talked, "Which queue?", ["The DLQ", "The main one"]);
const decided = claude.decide(ask.id, "a", "the DLQ is where it fails");
const openAsk = claude.ask(red, "Ship it behind a flag?", ["Yes", "No"]);
const mine = person.ask(parent, "Mine to answer?", ["Yes", "No"]);
person.decide(mine.id, "b");
q(`INSERT INTO handoffs (project_id, to_harness, task_id, request, status, state, kind, created_at, finished_at, updated_at)
   VALUES (:p1, 'codex', :p2, 'unreviewed', 'ready', 'done', 'do', ${ago(0.2)}, ${ago(0.1)}, ${ago(0.1)})`, [project.id, benched]);
q(`INSERT INTO handoffs (project_id, to_harness, task_id, request, status, state, kind, created_at, finished_at, updated_at, reviewed_at)
   VALUES (:p1, 'codex', :p2, 'reviewed', 'ready', 'done', 'do', ${ago(0.2)}, ${ago(0.1)}, ${ago(0.1)}, ${ago(0.05)})`, [project.id, benched]);
q(`INSERT INTO handoffs (project_id, to_harness, task_id, request, status, state, kind, created_at, finished_at, updated_at)
   VALUES (:p1, 'codex', :p2, 'older than the window', 'ready', 'done', 'do', ${ago(4)}, ${ago(3)}, ${ago(3)})`, [project.id, benched]);
const auditLine = (taskId, summary, days) =>
  q(`INSERT INTO audit (at, action, entity, entity_id, summary, label, before_json, actor) VALUES (${ago(days)}, 'update', 'task', :p1, :p2, 'x', '{"__note":"workbench"}', 'claude-code:3')`, [taskId, summary]);
auditLine(benched, "committed in workbench", 0.04);
const pushedTask = task("pushed after its commit", "doing", 0.5);
q(`INSERT INTO workbenches (task_id, repo_id, path, branch, base, state, created_at, updated_at)
   VALUES (:p1, :p2, '/tmp/today-wb-b', 'ray/b', 'main', 'active', ${ago(2)}, ${ago(0.02)})`, [pushedTask, repo]);
auditLine(pushedTask, "committed in workbench", 0.06);
auditLine(pushedTask, "pushed workbench", 0.03);

const shape = (b) => ({
  counts: b.counts,
  groups: b.groups.map((g) => [g.task_id, g.lines.map((l) => [l.kind, l.audit_id != null, l.undoable])]),
});

section("the brief, on db.js's route");
const full = brief.brief(db.sqlP, { since });
check("one of each kind, and the person's own decision is not news", full.counts, { decision: 1, ask: 1, job: 1, workbench: 1, stuck: 1 });
const lineOf = (kind) => full.groups.flatMap((g) => g.lines).find((l) => l.kind === kind);
check("the decision names the question it answered", lineOf("decision").text, 'decided "The DLQ" on "Which queue?"');
check("the decision links its History row and can be undone", [typeof lineOf("decision").audit_id, lineOf("decision").undoable], ["number", true]);
check("the open ask is the unanswered one", lineOf("ask").entry_id, openAsk.id);
check("the job is the unreviewed one inside the window", [lineOf("job").task_id, /unreviewed/.test(lineOf("job").text)], [benched, true]);
check("a run has no Undo", lineOf("job").undoable, false);
check("the Workbench is the one not pushed since its commit", [lineOf("workbench").branch, lineOf("workbench").task_id], ["ray/a", benched]);
check("newly stuck is the task that crossed three days inside the window, not the old red one",
  [lineOf("stuck").task_id, lineOf("stuck").level], [amber, "amber"]);
check("grouped by task: the Workbench task carries its job and its Workbench",
  full.groups.find((g) => g.task_id === benched).lines.map((l) => l.kind).sort(), ["job", "workbench"]);
check("newest group first: the ask made a moment ago", full.groups[0].task_id, red);
check("nothing before since", brief.brief(db.sqlP, { since: brief.stamp(Date.now() + 60000) }).total, 0);

const small = brief.compact(full, { budget: 200 });
const roomy = brief.compact(full, { budget: 4000 });
check("compact: one line per thing, naming its History row", roomy.tasks.flatMap((t) => t.lines).length, 5);
check("compact lines say History", roomy.tasks.flatMap((t) => t.lines).some((l) => / \(History \d+\)$/.test(l)), true);
check("compact fits a small budget, the note included, and says it was trimmed", [JSON.stringify(small).length <= 200 * 4, small.trimmed, typeof small.more], [true, true, "string"]);
for (const budget of [200, 260, 320, 400]) {
  check(`never over a budget of ${budget}`, JSON.stringify(brief.compact(full, { budget })).length <= budget * 4, true);
}

section("Undo from a brief line is History's undo");
db.undo(lineOf("decision").audit_id);
check("an undone decision leaves the brief", brief.brief(db.sqlP, { since }).counts.decision, 0);
check("and its ask is open again", brief.brief(db.sqlP, { since }).counts.ask, 2);
const back = brief.brief(db.sqlP, { since });

// ---------------------------------------------------------------------------
// When you were last here.

section("lastSeen: focused for more than a minute, and away for a while");
{
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-today-seen-"));
  let now = Date.parse("2026-11-06T09:00:00Z");
  const today = createToday({ sql: db.sqlP, dataDir: data, clock: () => now });
  check("never looked: since a day back", today.since(), "2026-11-05 09:00:00");
  today.focused(); now += 30 * 1000; today.blurred();
  check("a glance under a minute is not a look", JSON.parse(fs.readFileSync(path.join(data, "today.json"), "utf8")).lastSeen, undefined);
  now += 5 * 1000; today.focused(); now += 2 * 60 * 1000; today.blurred();
  check("two minutes is", JSON.parse(fs.readFileSync(path.join(data, "today.json"), "utf8")).lastSeen, "2026-11-06 09:02:35");
  now += 10 * 1000; today.focused();
  check("back after ten seconds: the brief keeps its start", today.since(), "2026-11-05 09:00:00");
  now += 2 * 60 * 1000; today.blurred();
  now += 20 * 60 * 1000; today.focused();
  check("back after twenty minutes: since the last look", today.since(), "2026-11-06 09:04:45");
  today.blurred();
  now += 60 * 1000;
  today.seen("2026-11-06 09:20:00");
  check("Mark as seen starts after the newest thing shown, not the click", today.since(), "2026-11-06 09:20:00");
  today.seen("2026-11-06 09:10:00");
  check("and never moves backwards", today.since(), "2026-11-06 09:20:00");
  today.seen("2030-01-01 00:00:00");
  check("nor past now", today.since(), "2026-11-06 09:25:45");
  today.seen("not a time");
  check("a time that does not parse moves nothing", today.since(), "2026-11-06 09:25:45");
  check("seenUpTo: the newest line shown", brief.seenUpTo({ until: "2026-11-06 10:00:00",
    groups: [{ lines: [{ at: "2026-11-06 08:00:00" }, { at: "2026-11-06 09:30:00" }] }, { lines: [{ at: "2026-11-06 09:00:00" }] }] }), "2026-11-06 09:30:00");
  check("seenUpTo: an empty brief is seen to its end", brief.seenUpTo({ until: "2026-11-06 10:00:00", groups: [] }), "2026-11-06 10:00:00");
  const again = createToday({ sql: db.sqlP, dataDir: data, clock: () => now + 3600 * 1000 });
  check("a relaunch starts from the last look", again.since(), "2026-11-06 09:25:45");
  check("view hands back the stuck list, the banner and the brief", Object.keys(again.view()).sort(), ["banner", "brief", "firstRun", "lastSeen", "review", "since", "stuck"]);
}

// ---------------------------------------------------------------------------
// The same brief from the MCP server, on both routes.

db.handle().exec("PRAGMA wal_checkpoint(TRUNCATE)");
delete process.env.ELECTRON_RUN_AS_NODE;

async function route(name, env) {
  section(`daily_brief over ${name}`);
  const client = openServer({ actor: "claude-code:9", env: { DELPHI_AUTHOR_TYPE: "agent", ...env }, clientName: "test", warn: () => {} });
  await client.start();
  try {
    const listed = (await client.request("tools/list", {})).tools.find((t) => t.name === "daily_brief");
    check("daily_brief is listed", Boolean(listed), true);
    const got = await client.call("daily_brief", { since, detail: "full" });
    check("the same brief as db.js's route", shape(got), shape(back));
    const one = await client.call("daily_brief", { since, project: "today" });
    check("compact by default, with counts", [Array.isArray(one.tasks), one.counts.stuck], [true, 1]);
    const tight = await client.call("daily_brief", { since, budget: 200 });
    check("budgeted", tight.trimmed, true);
    const none = await client.call("daily_brief", { since, project: "gone" });
    check("an archived project has nothing to say", none.note, "Nothing happened in this window that needs you.");
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------------------
// Speed, with no ANALYZE statistics, as a real database has. The subtask
// lookups once planned as a walk of every task row in History: 9.4 seconds at
// 200k rows, synchronously in the main process on every Today paint.

function perf() {
  section("the stuck query at 200k History rows, without ANALYZE");
  const h = db.handle();
  h.exec("DROP TABLE IF EXISTS sqlite_stat1");
  const busy = [];
  for (let i = 0; i < 60; i++) {
    const p = task(`busy parent ${i}`, i % 3 ? "doing" : "blocked", 5);
    for (let k = 0; k < 3; k++) task(`busy subtask ${i}.${k}`, "todo", 5, { parentId: p });
    busy.push(p);
  }
  const ids = q("SELECT id FROM tasks").map((r) => r.id);
  h.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200000)
          INSERT INTO audit (at, action, entity, entity_id, summary, label, before_json)
          SELECT datetime('now', '-' || (i % 90) || ' days'), 'update', 'task', ${ids[0]} + (i % ${ids.length}), 'moved', 'x', '{}' FROM n`);
  check("200k History rows", Number(q("SELECT COUNT(*) AS n FROM audit")[0].n) >= 200000, true);
  const plan = h.prepare(`EXPLAIN QUERY PLAN SELECT ${brief.LAST_ACTIVITY} FROM tasks t`).all().map((r) => r.detail);
  check("History is only ever searched by its entity index, never scanned",
    plan.filter((d) => /\ba\b/.test(d)).every((d) => /^SEARCH a USING (COVERING )?INDEX idx_audit_entity/.test(d)), true);
  check("a parent's subtasks are found by idx_tasks_parent", plan.some((d) => /idx_tasks_parent/.test(d)), true);
  brief.stuck(db.sqlP);
  const runs = [];
  for (let i = 0; i < 3; i++) { const t0 = process.hrtime.bigint(); brief.stuck(db.sqlP); runs.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  const best = Math.min(...runs);
  console.log(`       stuck(): ${runs.map((r) => r.toFixed(1)).join(", ")} ms`);
  check("stuck() under 100ms", best < 100, true);
  const t0 = process.hrtime.bigint();
  brief.brief(db.sqlP, { since: brief.stamp(Date.now() - 86400000) });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`       brief(): ${ms.toFixed(1)} ms`);
  check("the whole brief under 250ms", ms < 250, true);
}

(async () => {
  await route("node:sqlite", {});
  await route("the sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" });
  process.env.ELECTRON_RUN_AS_NODE = "1";
  perf();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
