#!/usr/bin/env node
// The Tasks tab's rules (ui/tasks.js): reading a quick entry, what an inline
// edit sends, what a subtask pill says and what ticking one does, what a
// Kanban drop writes, the display options, and grouping 2,000 tasks fast.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/tasks_test.js
//
// Pure functions only: the module returns them before it touches a document,
// so no window and no database is involved.

const T = require("../ui/tasks.js");

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

section("quick entry keeps the old composer's reading");
check("plain", T.parseQuick("Fix the login page"), { title: "Fix the login page", priority: "med", assignee: null, ref: null });
check("a leading ! is high", T.parseQuick("!Fix it now").priority, "high");
check("a leading ! comes off the title", T.parseQuick("!  Fix it now").title, "Fix it now");
check("the issue key is the ref", T.parseQuick("Look at APPEALS-12345 today").ref, "APPEALS-12345");
check("the ref stays in the title", T.parseQuick("Look at APPEALS-12345 today").title, "Look at APPEALS-12345 today");
section("and Today's !priority and @who");
check("!high and @who", T.parseQuick("Ask the platform team to build the CI image !high @ray"),
  { title: "Ask the platform team to build the CI image", priority: "high", assignee: "ray", ref: null });
check("!low anywhere", T.parseQuick("!low tidy the readme").priority, "low");
check("!low is not read as a leading !", T.parseQuick("!low tidy the readme").title, "tidy the readme");
check("!medium is med", T.parseQuick("thing !medium").priority, "med");
check("an email is not an assignee", T.parseQuick("mail bob@example.com").assignee, null);
check("an agent name with a colon", T.parseQuick("run it @claude-code:42").assignee, "claude-code:42");
check("!low-level is words, not a priority", T.parseQuick("fix !low-level bug"), { title: "fix !low-level bug", priority: "med", assignee: null, ref: null });
check("!high. at the end of a sentence is words too", T.parseQuick("ship it !high.").priority, "med");
check("nothing but marks is no title", T.parseQuick("  !high @ray ").title, "");

section("inline edit sends only what moved");
const task = { id: 7, title: "Write the plan", status: "todo", priority: "med" };
check("nothing changed", T.editPatch(task, { title: "Write the plan", status: "todo", priority: "med" }), { patch: null });
check("a new title", T.editPatch(task, { title: "Write the real plan", status: "todo", priority: "med" }), { patch: { title: "Write the real plan" } });
check("a title is trimmed", T.editPatch(task, { title: "  Write it  ", status: "todo", priority: "med" }), { patch: { title: "Write it" } });
check("trailing spaces alone are no change", T.editPatch(task, { title: "Write the plan  " }), { patch: null });
check("an empty title is refused", T.editPatch(task, { title: "   " }), { error: "A task needs a title." });
check("status and priority", T.editPatch(task, { title: task.title, status: "doing", priority: "high" }), { patch: { status: "doing", priority: "high" } });
check("an unknown status is ignored", T.editPatch(task, { status: "nonsense" }), { patch: null });
check("an unknown priority is ignored", T.editPatch(task, { priority: "urgent" }), { patch: null });
const review = { id: 8, title: "Review me", status: "review", priority: "high" };
check("In review, drawn as In progress, saved untouched, is not rewritten", T.editPatch(review, { title: "Review me", status: "doing", priority: "high" }), { patch: null });
check("In review moved on purpose is written", T.editPatch(review, { status: "done" }), { patch: { status: "done" } });
check("a task with no priority reads as med", T.editPatch({ id: 9, title: "x", status: "todo", priority: null }, { priority: "med" }), { patch: null });

section("inline edit diffs against the task as it was when opened");
{
  const opened = { id: 10, title: "Old title", status: "todo", priority: "med" };
  const base = T.baseOf(opened);
  // Meanwhile an agent retitled it and started it.
  const now = { id: 10, title: "Agent title", status: "doing", priority: "med" };
  check("only priority touched: the agent's title and status stand",
    T.editPatch(now, { title: "Old title", status: "todo", priority: "high" }, base), { patch: { priority: "high" } });
  check("nothing touched sends nothing, though the row moved on",
    T.editPatch(now, { title: "Old title", status: "todo", priority: "med" }, base), { patch: null });
  check("a title typed by the person still wins",
    T.editPatch(now, { title: "Mine", status: "todo", priority: "med" }, base), { patch: { title: "Mine" } });
  check("the base of In review reads as In progress", T.baseOf({ title: "x", status: "review", priority: null }), { title: "x", status: "doing", priority: "med" });
}

section("subtask pills");
check("no subtasks, no pill", T.pillOf({ subtask_count: 0 }), null);
check("2 of 4", T.pillOf({ subtask_count: 4, subtask_done: 2 }),
  { done: 2, total: 4, text: "2/4", complete: false, ratio: 0.5, label: "2 of 4 subtasks done" });
check("all done is complete", T.pillOf({ subtask_count: 3, subtask_done: 3 }).complete, true);
check("a done count past the total is clamped", T.pillOf({ subtask_count: 2, subtask_done: 5 }).text, "2/2");
check("counts from SQL as strings", T.pillOf({ subtask_count: "5", subtask_done: "4" }).text, "4/5");
const parent = { subtask_count: 4, subtask_done: 2 };
check("ticking an open subtask", T.toggleSub(parent, { status: "todo" }), { status: "done", subtask_done: 3 });
check("unticking a done one", T.toggleSub(parent, { status: "done" }), { status: "todo", subtask_done: 1 });
check("ticking one in progress closes it", T.toggleSub(parent, { status: "doing" }), { status: "done", subtask_done: 3 });
check("never above the total", T.toggleSub({ subtask_count: 2, subtask_done: 2 }, { status: "todo" }).subtask_done, 2);
check("never below nought", T.toggleSub({ subtask_count: 2, subtask_done: 0 }, { status: "done" }).subtask_done, 0);

section("a Kanban drop writes a status, and only a change");
check("todo to doing", T.dropPatch({ status: "todo" }, "doing"), { status: "doing" });
check("back where it was", T.dropPatch({ status: "blocked" }, "blocked"), null);
check("In review dropped on In progress stays In review", T.dropPatch({ status: "review" }, "doing"), null);
check("In review dropped on Done", T.dropPatch({ status: "review" }, "done"), { status: "done" });
check("not a column", T.dropPatch({ status: "todo" }, "nowhere"), null);
check("no task", T.dropPatch(null, "done"), null);

section("display options");
check("nothing stored is the default, All projects", T.normalise(null, "global").group, "project");
check("nothing stored is the default, a project", T.normalise(undefined, "project").group, "status");
check("All projects reads newest activity first", T.normalise(null, "global").order, "activity");
check("an unknown group falls back", T.normalise({ group: "colour" }, "project").group, "status");
check("a kept choice is kept", T.normalise({ group: "priority", order: "title" }, "project"), {
  group: "priority", order: "title", showDone: false, props: T.DEFAULTS.project.props });
check("a property turned off stays off", T.normalise({ props: { age: false, junk: true } }, "global").props.age, false);
check("an unknown property is dropped", "junk" in T.normalise({ props: { junk: true } }, "global").props, false);

section("grouping and order");
const at = (d) => `2026-11-0${d} 10:00:00`;
const tasks = [
  { id: 1, title: "b", status: "todo", priority: "low", project_id: 1, project_name: "Alpha", updated_at: at(1) },
  { id: 2, title: "a", status: "doing", priority: "high", project_id: 2, project_name: "Beta", updated_at: at(5) },
  { id: 3, title: "c", status: "done", priority: "med", project_id: 1, project_name: "Alpha", updated_at: at(4) },
  { id: 4, title: "d", status: "review", priority: "med", project_id: 1, project_name: "Alpha", updated_at: at(3) },
  { id: 5, title: "sub", status: "todo", priority: "med", project_id: 1, parent_id: 1, updated_at: at(9) },
  { id: 6, title: "e", status: "blocked", priority: "high", project_id: null, updated_at: at(8) },
];
const shape = (groups) => groups.map((g) => [g.key, g.tasks.map((t) => t.id)]);
const global = T.normalise(null, "global");
check("by project, newest project first, no project last, done and subtasks left out",
  shape(T.arrange(tasks, global)), [["p2", [2]], ["p1", [4, 1]], ["none", [6]]]);
check("show completed brings done back", shape(T.arrange(tasks, { ...global, showDone: true }))[1], ["p1", [3, 4, 1]]);
const proj = T.normalise(null, "project");
check("by status: doing (In review with it), blocked, todo, done",
  shape(T.arrange(tasks, proj)), [["doing", [2, 4]], ["blocked", [6]], ["todo", [1]], ["done", [3]]]);
check("by priority", shape(T.arrange(tasks, { ...proj, group: "priority" })), [["high", [6, 2]], ["med", [4]], ["low", [1]]]);
check("no grouping, by title", shape(T.arrange(tasks, { ...proj, group: "none", order: "title" })), [["all", [2, 1, 4, 6]]]);
check("the filter field", shape(T.arrange(tasks, global, { query: "#6" })), [["none", [6]]]);
check("#6 is task 6, not #60", T.matches({ id: 60, title: "sixty" }, "#6"), false);
check("#60 is task 60", T.matches({ id: 60, title: "sixty" }, "#60"), true);
check("the filter words all have to match", T.arrange(tasks, global, { query: "zzz" }).length, 0);
check("the metrics filter, blocked", shape(T.arrange(tasks, global, { taskFilter: "blocked" })), [["none", [6]]]);
check("the metrics filter, done, shows done", shape(T.arrange(tasks, global, { taskFilter: "done" })), [["p1", [3]]]);
check("Kanban keeps all four columns, empty ones too",
  T.columns(tasks.filter((t) => t.status !== "blocked"), proj).map((c) => [c.status, c.tasks.length]),
  [["todo", 1], ["doing", 2], ["blocked", 0], ["done", 1]]);

section("avatars");
check("two words", T.initials("Raymond Hughes"), "RH");
check("an agent", T.initials("claude-code"), "CC");
check("one word", T.initials("codex"), "Co");
check("nothing", T.initials(""), "?");

section("2,000 tasks group and filter inside a frame");
const many = [];
for (let i = 1; i <= 2000; i++) {
  many.push({ id: i, title: `Task number ${i} about ${["mpi", "caseflow", "efolder", "vacols"][i % 4]}`,
    status: ["todo", "doing", "blocked", "done"][i % 4], priority: ["high", "med", "low"][i % 3],
    project_id: i % 16, project_name: `P${i % 16}`, updated_at: `2026-10-${String(1 + (i % 28)).padStart(2, "0")} 10:00:00`,
    subtask_count: i % 5, subtask_done: i % 3 });
}
// The fastest of 20 runs, not the mean: several builds share this machine, and
// a run that waited for the CPU says nothing about what the code costs.
const time = (fn) => { let best = Infinity; for (let k = 0; k < 20; k++) { const t0 = process.hrtime.bigint(); fn(); best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6); } return best; };
const groupMs = time(() => T.arrange(many, global));
const filterMs = time(() => T.arrange(many, global, { query: "caseflow 12" }));
const boardMs = time(() => T.columns(many, proj));
console.log(`  group ${groupMs.toFixed(2)} ms, filter ${filterMs.toFixed(2)} ms, Kanban ${boardMs.toFixed(2)} ms`);
check("grouping 2,000 is under 16 ms", groupMs < 16, true);
check("filtering 2,000 is under 16 ms", filterMs < 16, true);
check("columns for 2,000 are under 16 ms", boardMs < 16, true);
check("every open task lands in a group", T.arrange(many, global).reduce((n, g) => n + g.tasks.length, 0), 1500);

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
