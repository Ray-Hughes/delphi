#!/usr/bin/env node
// The weekly review: what it looks back on, what it offers to tidy, the
// objectives it saves, and Park, Drop and Undo.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/weekly_test.js
//
// today/weekly.js is SQL handed a sql() function, so it runs three ways on one
// seeded database: db.js's binding sqlP (the window's route), and the real MCP
// server's weekly_review on node:sqlite and on the sqlite3 binary
// (DELPHI_SQLITE_ROUTE=binary), which writes every value into the text. A
// review that differs between them is the bug a shared store is there to stop.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-weekly-"));
process.env.DELPHI_DATA_DIR = dir;
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const weekly = require("../today/weekly");
const { createWeekly } = require("../main/weekly");
const { makeSheetStore } = require("../sheet/store");
const { openServer } = require("../sheet/client");
const schema = require("../settings/schema");

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

section("the pure parts");
// 2026-11-06 is a Friday; local noon so no time zone moves the day.
const at = (y, m, d) => new Date(y, m - 1, d, 12).getTime();
check("Friday plans the coming week", weekly.objectivesWeek(at(2026, 11, 6)), "2026-11-09");
check("Sunday plans the coming week", weekly.objectivesWeek(at(2026, 11, 8)), "2026-11-09");
check("Monday plans its own week", weekly.objectivesWeek(at(2026, 11, 9)), "2026-11-09");
check("Thursday plans its own week", weekly.objectivesWeek(at(2026, 11, 12)), "2026-11-09");
const body = weekly.objectivesBody([{ text: "#12 Ship the drawer" }, { text: "Project: Caseflow" }, { text: "Write  the\nnotes" }], { week: "2026-11-09", on: "2026-11-06" });
check("objectives read back from the note they make", weekly.parseObjectives(body),
  [{ text: "#12 Ship the drawer", task_id: 12 }, { text: "Project: Caseflow", task_id: null }, { text: "Write the notes", task_id: null }]);
check("the restore command quotes what needs it",
  weekly.restoreCommand({ repo: "/r/my repo", folder: "/w/t-1", branch: "ray/t-1", id: 4, ref: "refs/delphi/discarded/1-4" }),
  "git -C '/r/my repo' worktree add -b ray/t-1-recovered-4 /w/t-1-recovered-4 refs/delphi/discarded/1-4");

section("the settings schema has the review's two settings");
check("on by default, in Brief and weekly review", [schema.BY_KEY.weeklyReviewEnabled.default, schema.BY_KEY.weeklyReviewEnabled.section], [true, "brief"]);
check("Friday by default, any day of the week", [schema.BY_KEY.weeklyReviewDay.default, schema.BY_KEY.weeklyReviewDay.choices.length], ["friday", 7]);
check("the section is listed", schema.SECTIONS.some((s) => s.id === "brief" && s.label === "Brief and weekly review"), true);

// ---------------------------------------------------------------------------
// The seed. Made through db.js, then put back in time by hand.

const q = (s, p = []) => db.sqlP(s, p);
const ago = (days) => `datetime('now', '-${Math.round(days * 24 * 60)} minutes')`;
const ahead = (days) => `datetime('now', '+${Math.round(days * 24 * 60)} minutes')`;
const project = db.createProject({ key: "wk", name: "Weekly test" });
const other = db.createProject({ key: "wk2", name: "Other one" });
function task(title, status, days, extra = {}) {
  const t = db.createTask({ projectId: extra.projectId || project.id, title, priority: extra.priority || "med", parentId: extra.parentId || null });
  q(`UPDATE tasks SET status = :p1, created_at = ${ago(days + 1)}, updated_at = ${ago(days)} WHERE id = :p2`, [status, t.id]);
  q(`UPDATE audit SET at = ${ago(days)} WHERE entity = 'task' AND entity_id = :p1`, [t.id]);
  q("DELETE FROM status_events WHERE task_id = :p1", [t.id]);
  return t.id;
}
const event = (taskId, status, days) => q(`INSERT INTO status_events (task_id, status, actor, at) VALUES (:p1, :p2, 'you', ${ago(days)})`, [taskId, status]);

const stale = task("doing for ten days", "doing", 10, { priority: "high" });
const reopened = task("reopened from done", "doing", 1);
event(reopened, "doing", 6); event(reopened, "done", 4); event(reopened, "doing", 2);
const sentBack = task("back to to do", "todo", 1);
event(sentBack, "doing", 20); event(sentBack, "todo", 3);
const longAgo = task("went back a month ago", "todo", 30);
event(longAgo, "done", 40); event(longAgo, "todo", 30);
const blockedOnly = task("blocked is not a step back", "blocked", 1);
event(blockedOnly, "doing", 5); event(blockedOnly, "blocked", 2);
const finished = task("finished this week", "done", 2);
q(`UPDATE tasks SET completed_at = ${ago(2)} WHERE id = :p1`, [finished]);
const finishedOld = task("finished last month", "done", 40);
q(`UPDATE tasks SET completed_at = ${ago(40)} WHERE id = :p1`, [finishedOld]);
const elsewhere = task("done in the other project", "done", 1, { projectId: other.id });
q(`UPDATE tasks SET completed_at = ${ago(1)} WHERE id = :p1`, [elsewhere]);
const dueSoon = task("due on Monday", "todo", 1);
q(`UPDATE tasks SET due = date('now', '+3 days') WHERE id = :p1`, [dueSoon]);

const claude = makeSheetStore({ sql: db.sqlP, batch: db.batchP, actor: "claude-code:3", authorType: "agent" });
const person = makeSheetStore({ sql: db.sqlP, batch: db.batchP, actor: "you", authorType: "human" });
const ask1 = claude.ask(reopened, "Which queue?", ["The DLQ", "The main one"]);
claude.decide(ask1.id, "a", "the DLQ is where it fails");
const ask2 = person.ask(sentBack, "Keep the flag?", ["Yes", "No"]);
person.decide(ask2.id, "b");
const ask3 = claude.ask(finishedOld, "An old question", ["Yes", "No"]);
const old = claude.decide(ask3.id, "a");
q(`UPDATE comments SET created_at = ${ago(20)} WHERE id = :p1`, [old.id]);

q(`INSERT INTO handoffs (project_id, to_harness, task_id, request, status, state, kind, created_at, started_at, finished_at, updated_at, tokens_in, tokens_out, cost_usd)
   VALUES (:p1, 'claude-code', :p2, 'fix it', 'ready', 'done', 'do', ${ago(3)}, ${ago(3)}, datetime(${ago(3)}, '+30 minutes'), ${ago(2.9)}, 1000, 500, 1.25)`, [project.id, reopened]);
q(`INSERT INTO handoffs (project_id, to_harness, task_id, request, status, state, kind, created_at, started_at, finished_at, updated_at, tokens_in, tokens_out, cost_usd)
   VALUES (:p1, 'claude-code', :p2, 'a month ago', 'ready', 'done', 'do', ${ago(30)}, ${ago(30)}, ${ago(29.9)}, ${ago(29.9)}, 9000, 9000, 9)`, [project.id, reopened]);

const repo = q("INSERT INTO repos (project_id, name, path, is_primary) VALUES (:p1, 'r', '/tmp/wk-repo', 1) RETURNING id", [project.id])[0].id;
const idleTask = task("its Workbench sat a week", "doing", 1);
const idleBench = q(`INSERT INTO workbenches (task_id, repo_id, path, branch, base, state, created_at, updated_at)
   VALUES (:p1, :p2, '/tmp/wk-wb-a', 'ray/a', 'main', 'active', ${ago(12)}, ${ago(9)}) RETURNING id`, [idleTask, repo])[0].id;
const busyTask = task("its Workbench ran yesterday", "doing", 1);
const busyBench = q(`INSERT INTO workbenches (task_id, repo_id, path, branch, base, state, created_at, updated_at)
   VALUES (:p1, :p2, '/tmp/wk-wb-b', 'ray/b', 'main', 'parked', ${ago(12)}, ${ago(9)}) RETURNING id`, [busyTask, repo])[0].id;
q(`INSERT INTO handoffs (project_id, to_harness, task_id, workbench_id, request, status, state, kind, created_at, finished_at, updated_at)
   VALUES (:p1, 'codex', :p2, :p3, 'ran', 'ready', 'done', 'do', ${ago(1.2)}, ${ago(1)}, ${ago(1)})`, [project.id, busyTask, busyBench]);
const goneTask = task("discarded twenty five days ago", "done", 25);
const soonBench = q(`INSERT INTO workbenches (task_id, repo_id, path, branch, base, state, created_at, updated_at, closed_at, closing_ref, closing_at, closing_mode)
   VALUES (:p1, :p2, '/tmp/wk-wb-c', 'ray/c', 'main', 'discarded', ${ago(40)}, ${ago(25)}, ${ago(25)}, :p3, ${ago(25)}, 'discard') RETURNING id`,
   [goneTask, repo, `refs/delphi/discarded/${goneTask}-x`])[0].id;
q(`INSERT INTO workbenches (task_id, repo_id, path, branch, base, state, created_at, updated_at, closed_at, closing_ref, closing_at, closing_mode)
   VALUES (:p1, :p2, '/tmp/wk-wb-d', 'ray/d', 'main', 'finished', ${ago(40)}, ${ago(10)}, ${ago(10)}, 'refs/delphi/finished/d', ${ago(10)}, 'finish')`, [goneTask, repo]);
q(`INSERT INTO workbenches (task_id, repo_id, path, branch, base, state, created_at, updated_at, closed_at, closing_ref, closing_at, closing_mode)
   VALUES (:p1, :p2, '/tmp/wk-wb-e', 'ray/e', 'main', 'finished', ${ago(40)}, ${ago(31)}, ${ago(31)}, 'refs/delphi/finished/e', ${ago(31)}, 'finish')`, [goneTask, repo]);

section("look back, on db.js's route");
const r = weekly.review(db.sqlP);
const lb = r.look_back;
check("seven days, ending now", [r.days, Math.round((Date.parse(`${r.until.replace(" ", "T")}Z`) - Date.parse(`${r.since.replace(" ", "T")}Z`)) / 86400000)], [7, 7]);
check("this week's decisions, a person's too, newest first", lb.decisions.map((d) => [d.task_id, d.choice]), [[sentBack, "No"], [reopened, "The DLQ"]]);
check("each with its question and why", [lb.decisions[1].question, lb.decisions[1].why], ["Which queue?", "the DLQ is where it fails"]);
check("backwards: reopened from done and back to to do, not blocked, not last month",
  lb.backwards.map((b) => [b.task_id, b.from, b.to]).sort(), [[reopened, "done", "doing"], [sentBack, "doing", "todo"]].sort());
check("done this week, in every project", [lb.done.count, lb.done.tasks.map((t) => t.id).sort()], [2, [finished, elsewhere].sort()]);
check("cost from the ledger, this week's run only", [lb.cost.totals.runs, lb.cost.totals.cost_usd, lb.cost.totals.tokens_in], [1, 1.25, 1000]);
check("its agent time", lb.cost.totals.agent_seconds, 1800);
check("where it went: tasks with a run, not a job that never started", lb.cost.top_tasks.map((t) => [t.task_id, t.title]), [[reopened, "reopened from done"]]);
check("labelled API-equivalent", /API-equivalent/.test(lb.cost.cost_label), true);
check("one project narrows it", weekly.review(db.sqlP, { projectId: other.id }).look_back.done.count, 1);

section("tidy");
check("stale is the brief's stuck rule", r.tidy.stale.map((s) => [s.id, s.level]), [[stale, "red"]]);
check("a Workbench idle a week, and not one that ran yesterday", r.tidy.idle_workbenches.map((w) => [w.workbench_id, w.days]), [[idleBench, 9]]);
check("a copy expiring in five days, not one with twenty left or one already gone",
  r.tidy.expiring.map((e) => [e.workbench_id, e.kind, e.days_left]), [[soonBench, "discarded", 5]]);
check("with its restore command", r.tidy.expiring[0].restore,
  `git -C /tmp/wk-repo worktree add -b ray/c-recovered-${soonBench} /tmp/wk-wb-c-recovered-${soonBench} refs/delphi/discarded/${goneTask}-x`);

section("next week");
check("candidates: in progress first, then due soon", r.next_week.candidates.slice(0, 2).map((c) => c.status === "doing"), [true, true]);
check("due soon says so", (r.next_week.candidates.find((c) => c.id === dueSoon) || { why: [] }).why.some((w) => /^Due /.test(w)), true);
check("done work is never a candidate", r.next_week.candidates.some((c) => c.id === finished), false);
check("no objectives yet", [r.next_week.last, r.next_week.saved_this_week], [null, false]);

section("compact, for an agent");
const c = weekly.compact(r);
check("counts and three sections", [c.counts.decisions, c.counts.stale, c.counts.expiring, Array.isArray(c.next_week)], [2, 1, 1, true]);
check("the restore command is in it", c.tidy.some((l) => l.includes("worktree add")), true);
const tight = weekly.compact(r, { budget: 200 });
check("budgeted, and says so", [tight.trimmed, typeof tight.more], [true, "string"]);
// A week too big for any budget still fits it: the totals and notes go last.
const huge = JSON.parse(JSON.stringify(r));
huge.tidy.stale = Array.from({ length: 300 }, (_, i) => ({ ...r.tidy.stale[0], id: i, title: "x".repeat(200) }));
huge.look_back.cost.top_tasks = Array.from({ length: 5 }, (_, i) => ({ ...lb.cost.totals, task_id: i, title: "y".repeat(400) }));
for (const b of [200, 400, 1200]) {
  const out = weekly.compact(huge, { budget: b });
  check(`never over a budget of ${b} tokens`, JSON.stringify(out).length <= b * 4, true);
}

// ---------------------------------------------------------------------------
// Park, Drop, Undo and the objectives: the window's half.

section("Park, Drop and Undo");
const sheets = makeSheetStore({ sql: db.sqlP, batch: db.batchP, actor: "you", authorType: "human", step: db.currentStep });
let wrote = 0;
const w = createWeekly({ db, sheets, after: () => { wrote++; } });
const statusOf = (id) => q("SELECT status FROM tasks WHERE id = :p1", [id])[0].status;
const parked = w.park(stale);
check("Park puts it in To do and hands back its History rows", [statusOf(stale), parked.was, parked.audit.length > 0], ["todo", "doing", true]);
check("off the stale list", weekly.review(db.sqlP).tidy.stale.length, 0);
w.undo(parked);
check("Undo puts it back", statusOf(stale), "doing");
check("and takes its status event away, so it is not a step back", weekly.review(db.sqlP).look_back.backwards.some((b) => b.task_id === stale), false);
const dropped = w.drop(stale, "superseded by the drawer");
const note = q("SELECT body, kind FROM comments WHERE task_id = :p1 ORDER BY id DESC LIMIT 1", [stale])[0];
check("Drop is done with a note saying why", [statusOf(stale), note.kind, note.body], ["done", "note", "Dropped in the weekly review: superseded by the drawer"]);
check("two History rows, the note and the status", dropped.audit.length >= 2, true);
const afterDrop = weekly.review(db.sqlP).look_back.done;
check("a dropped task is counted apart from the done ones", [afterDrop.count, afterDrop.dropped], [2, 1]);
w.undo(dropped);
check("Undo puts the status back and takes the note off", [statusOf(stale), q("SELECT COUNT(*) AS n FROM comments WHERE task_id = :p1 AND body LIKE 'Dropped%'", [stale])[0].n], ["doing", 0]);
let forged = null;
try { w.undo({ receipt: 999 }); } catch (error) { forged = error.message; }
check("Undo takes only a receipt this process gave out", /History/.test(String(forged)), true);
// An agent changing the same task in the same moment is not swept into the Undo.
const parkedAgain = w.park(stale);
const agentStore = makeSheetStore({ sql: db.sqlP, batch: db.batchP, actor: "codex:7", authorType: "agent" });
agentStore.append({ taskId: stale, kind: "say", body: "picked it up" });
w.undo(parkedAgain);
check("an agent's entry after a Park survives its Undo",
  q("SELECT COUNT(*) AS n FROM comments WHERE task_id = :p1 AND body = 'picked it up'", [stale])[0].n, 1);
check("and the Park is undone", statusOf(stale), "doing");
let refused = null;
try { w.park(sentBack); } catch (error) { refused = error.message; }
check("Park on a task already in To do says so", refused, `#${sentBack} is already in To do.`);
check("every write was followed by the vault export", wrote >= 4, true);

section("Park and Drop hold the write lock, so no other writer can land in between");
// The MCP server is another process on the same file. If it could write
// between the mark and the end of a Park, its row would be counted as the
// Park's and taken back by Undo. Both of its routes are tried mid-write: a
// second node:sqlite connection and the sqlite3 binary, neither waiting.
const { DatabaseSync } = require("node:sqlite");
const { spawnSync } = require("child_process");
const probes = [];
const probing = { ...db, updateTask: (id, fields) => {
  const other = new DatabaseSync(process.env.DELPHI_DB);
  other.exec("PRAGMA busy_timeout = 0");
  try { other.exec("INSERT INTO meta (key, value) VALUES ('wk-probe-node', '1')"); probes.push("node wrote"); }
  catch (error) { probes.push(/locked|busy/i.test(error.message) ? "node locked out" : error.message); }
  finally { other.close(); }
  const bin = spawnSync("sqlite3", ["-cmd", ".timeout 0", process.env.DELPHI_DB, "INSERT INTO meta (key, value) VALUES ('wk-probe-bin', '1');"], { encoding: "utf8" });
  probes.push(bin.status === 0 ? "binary wrote" : /locked|busy/i.test(bin.stderr) ? "binary locked out" : bin.stderr.trim());
  return db.updateTask(id, fields);
} };
const lockedW = createWeekly({ db: probing, sheets, after: () => {} });
const probeParked = lockedW.park(stale);
check("both routes are locked out while a Park writes", probes, ["node locked out", "binary locked out"]);
check("and the Park's rows are only its own", q("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'wk-probe-%'", [])[0].n, 0);
lockedW.undo(probeParked);
check("its Undo puts it back", statusOf(stale), "doing");

section("a task written in a pad: Drop ticks its line, and Undo puts the task back");
const pad = db.createScratchpad({ projectId: project.id, title: "wk pad", body: "- [ ] a pad task\n" });
const padTask = q("SELECT id FROM tasks WHERE pad_id = :p1", [pad.id])[0].id;
db.updateTask(padTask, { status: "doing" });
const padLine = () => (q("SELECT body FROM scratchpads WHERE id = :p1", [pad.id])[0].body.match(/^- \[(.)\] a pad task/m) || [])[1];
const padDrop = w.drop(padTask, "covered elsewhere");
check("dropped, its line is ticked", [statusOf(padTask), padLine()], ["done", "x"]);
w.undo(padDrop);
check("undone, the task is as it was", statusOf(padTask), "doing");
// The line stays ticked: db.undo restores the task row and does not write the
// board back to the pad, the same as an undo from History. That is db.js's to
// change, for every undo at once, not this module's.

section("a Drop that cannot finish leaves nothing behind");
const failing = { ...db, updateTask: () => { throw new Error("refused for the test"); } };
const failW = createWeekly({ db: failing, sheets, after: () => {} });
const countOf = (sqlText, params) => q(sqlText, params)[0].n;
const before = [countOf("SELECT COUNT(*) AS n FROM comments WHERE task_id = :p1", [stale]), countOf("SELECT COUNT(*) AS n FROM audit", [])];
let failed = null;
try { failW.drop(stale, "never lands"); } catch (error) { failed = error.message; }
check("the error is said, not swallowed", failed, "refused for the test");
check("no note and no History row stay", [countOf("SELECT COUNT(*) AS n FROM comments WHERE task_id = :p1", [stale]), countOf("SELECT COUNT(*) AS n FROM audit", [])], before);
check("and the task is as it was", statusOf(stale), "doing");

section("dropped is the Drop's mark, not words that look like it");
const lookalike = task("finished, with a note that only sounds like a Drop", "doing", 1);
agentStore.append({ taskId: lookalike, kind: "note", body: "Dropped in the weekly review: no, this one was finished" });
q(`UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = :p1`, [lookalike]);
check("a note in the same words without the mark counts as done", weekly.review(db.sqlP).look_back.done.tasks.some((x) => x.id === lookalike), true);

section("next week's objectives");
let few = null;
try { w.save({ projectId: project.id, objectives: [{ text: "one" }, { text: "two" }] }); } catch (error) { few = error.message; }
check("fewer than three is refused", few, "Pick 3 to 5 objectives; 2 are picked.");
const saved = w.save({ projectId: project.id, objectives: [{ text: `#${reopened} reopened from done` }, { text: `#${dueSoon} due on Monday` }, { text: "Project: Weekly test" }] });
check("saved as a decision note", [saved.kind, saved.title.startsWith(weekly.OBJECTIVES_TITLE)], ["decision", true]);
check("the Today card's question", w.status().savedThisWeek, true);
q(`UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = :p1`, [dueSoon]);
const after = weekly.review(db.sqlP).next_week;
check("next week's review reads them back with how each went",
  after.last.objectives.map((o) => [o.task_id, o.status]), [[reopened, "doing"], [dueSoon, "done"], [null, null]]);
check("and knows they were saved this week", after.saved_this_week, true);
const again = w.save({ projectId: other.id, objectives: [{ text: "First" }, { text: "Second" }, { text: "Third" }, { text: "Fourth" }] });
check("saving the same week again rewrites its note, in the project it is kept in",
  [again.id, again.updated, again.project_id, q("SELECT COUNT(*) AS n FROM notes WHERE title = :p1", [saved.title])[0].n], [saved.id, true, project.id, 1]);
check("and the review reads the second list", weekly.review(db.sqlP).next_week.last.objectives.map((o) => o.text), ["First", "Second", "Third", "Fourth"]);

// ---------------------------------------------------------------------------
// The same review from the MCP server, on both routes.

db.handle().exec("PRAGMA wal_checkpoint(TRUNCATE)");
delete process.env.ELECTRON_RUN_AS_NODE;
// What a second's difference in "now" cannot move.
const shape = (x) => ({
  decisions: x.look_back.decisions.map((d) => [d.entry_id, d.choice, d.question]),
  backwards: x.look_back.backwards.map((b) => [b.task_id, b.from, b.to]),
  done: x.look_back.done.count, cost: [x.look_back.cost.totals.runs, x.look_back.cost.totals.cost_usd],
  stale: x.tidy.stale.map((s) => s.id), idle: x.tidy.idle_workbenches.map((w2) => w2.workbench_id),
  expiring: x.tidy.expiring.map((e) => e.restore), candidates: x.next_week.candidates.map((k) => k.id),
  last: x.next_week.last && x.next_week.last.objectives,
});

async function route(name, env) {
  section(`weekly_review over ${name}`);
  const client = openServer({ actor: "claude-code:9", env: { DELPHI_AUTHOR_TYPE: "agent", ...env }, clientName: "test", warn: () => {} });
  await client.start();
  try {
    const listed = (await client.request("tools/list", {})).tools.find((t) => t.name === "weekly_review");
    check("weekly_review is listed", Boolean(listed), true);
    const before = q("SELECT COUNT(*) AS n FROM audit", [])[0].n;
    const got = await client.call("weekly_review", { detail: "full" });
    check("the same review as db.js's route", shape(got), shape(weekly.review(db.sqlP)));
    const one = await client.call("weekly_review", { project: "wk2" });
    check("compact by default, one project", [Array.isArray(one.look_back), one.counts.done], [true, 1]);
    const small = await client.call("weekly_review", { budget: 200 });
    check("budgeted", small.trimmed, true);
    check("read only: nothing written", q("SELECT COUNT(*) AS n FROM audit", [])[0].n, before);

    // An agent writing on this route to a task the window Parked: Undo takes
    // back the Park and nothing of the agent's.
    const mine = task(`parked while an agent talks, ${name}`, "doing", 5);
    const p1 = w.park(mine);
    await client.call("sheet_append", { task_id: mine, kind: "say", body: `still on it over ${name}` });
    const agentRows = () => q("SELECT id, undone FROM audit WHERE entity = 'task' AND entity_id = :p1 AND actor = 'claude-code:9'", [mine]);
    check("the Park's rows are none of the agent's", p1.audit.some((id) => agentRows().some((r) => r.id === id)), false);
    w.undo(p1);
    check("Undo puts the Park back and leaves the agent's entry",
      [statusOf(mine), q("SELECT COUNT(*) AS n FROM comments WHERE task_id = :p1 AND body LIKE 'still on it%'", [mine])[0].n,
       agentRows().every((r) => Number(r.undone) === 0)], ["doing", 1, true]);

    // An agent that changed the task itself since: Undo refuses as a whole,
    // and nothing of either is undone.
    const theirs = task(`parked, then changed by an agent, ${name}`, "doing", 5);
    const p2 = w.park(theirs);
    await client.call("update_task", { id: theirs, priority: "high" });
    let no = null;
    try { w.undo(p2); } catch (error) { no = error.message; }
    check("Undo refuses, saying who changed it", /claude-code:9 changed/i.test(String(no)), true);
    check("and changes nothing: still parked, the agent's priority kept, no row undone",
      [statusOf(theirs), q("SELECT priority FROM tasks WHERE id = :p1", [theirs])[0].priority,
       q(`SELECT COUNT(*) AS n FROM audit WHERE entity = 'task' AND entity_id = :p1 AND undone = 1`, [theirs])[0].n], ["todo", "high", 0]);

    // Drop then Undo, read back through this route.
    const gone = task(`dropped and brought back, ${name}`, "doing", 5);
    const d1 = w.drop(gone, "testing");
    const dropped1 = (await client.call("weekly_review", { detail: "full" })).look_back.done;
    w.undo(d1);
    const dropped2 = (await client.call("weekly_review", { detail: "full" })).look_back.done;
    check("a Drop counts as dropped on this route, and its Undo takes the note and the count away",
      [dropped1.dropped - dropped2.dropped, q("SELECT COUNT(*) AS n FROM comments WHERE task_id = :p1", [gone])[0].n, statusOf(gone)], [1, 0, "doing"]);

    // One note per week, read on this route.
    const w2 = w.save({ projectId: project.id, objectives: [{ text: `A ${name}` }, { text: "B" }, { text: "C" }] });
    const last = (await client.call("weekly_review", { detail: "full" })).next_week.last;
    check("a re-save is still one note for the week, and the server reads the latest list",
      [last.note_id, last.objectives[0].text, q("SELECT COUNT(*) AS n FROM notes WHERE title = :p1", [w2.title])[0].n], [w2.id, `A ${name}`, 1]);
  } finally {
    client.close();
  }
}

(async () => {
  await route("node:sqlite", {});
  await route("the sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" });
  console.log(`\n${checks - failures}/${checks} checks passed`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
