#!/usr/bin/env node
// test-runtime: electron
//
// Focus mode: the rules with no window, then the real renderer with a hidden one.
//
//   electron tools/focus_test.js
//
// The rules are ui/focus.js's pure half: which task is first (priority, due,
// then the queue's PICK_ORDER tie-break), which tasks are never a person's to
// focus on, what the three Interruption answers come to, and a break's
// arithmetic, including one picked back up after a restart.
//
// The window half drives Focus the way a person does: open it, tick a
// subtask, press Done and watch the next task arrive, Undo, switch to an
// interruption, delegate (which must wait for approval), and take a break that
// nothing gets through. main.js is loaded for real against a temp data folder;
// the window is hidden, the hotkey and tray are stubbed, and the app never
// becomes active, so the test takes no focus and no key.

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-focus-")));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
delete process.env.DELPHI_DB_ID;
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}
fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ vaultEnabled: false }));

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

// ---------------------------------------------------------------------------
// The rules

const F = require("../ui/focus.js");
const NOW = Date.parse("2026-11-06T13:00:00Z");
const T = (id, o = {}) => ({ id, status: "todo", priority: "med", due: null, ...o });

console.log("\nwhich task is first");
{
  const tasks = [
    T(1), T(2, { priority: "high" }), T(3, { priority: "high", due: "2026-11-09" }), T(4, { priority: "high", due: "2026-11-08" }),
    T(5, { priority: "low", due: "2026-11-01" }), T(6, { priority: "high", status: "done" }), T(7, { priority: "high", status: "blocked" }),
    T(8, { priority: "high", parent_id: 3 }), T(9, { priority: "high", assignee: "claude-code" }),
    T(10, { priority: "high", claimed_by: "codex:1", claim_expires: "2026-11-06 14:00:00" }),
    T(11, { priority: "high", claimed_by: "codex:1", claim_expires: "2026-11-06 12:00:00", due: "2026-11-07" }),
    T(12, { priority: "high", queue: "ready" }), T(13, { priority: "high", status: "doing", due: "2026-11-20" }),
  ];
  const busy = F.busyTasks([{ task_id: 2, state: "needs_approval" }, { task_id: 1, state: "done" }]);
  check("priority, then due (none last), then oldest; done, blocked, subtasks and agents' work left out",
    F.rank(tasks, { now: NOW }).map((t) => t.id), [11, 4, 3, 13, 2, 1, 5]);
  check("an expired claim is no claim, a live one is", [F.heldBy(tasks[10], { now: NOW }), Boolean(F.heldBy(tasks[9], { now: NOW }))], [null, true]);
  check("a task with an open job is an agent's", F.rank(tasks, { now: NOW, busy }).map((t) => t.id).includes(2), false);
  check("a finished job leaves its task a person's", F.rank(tasks, { now: NOW, busy }).map((t) => t.id).includes(1), true);
  check("queue_rank breaks a tie the way PICK_ORDER does: ranked first, nulls last, then id",
    F.rank([T(1), T(2, { queue_rank: 2 }), T(3, { queue_rank: 1 })]).map((t) => t.id), [3, 2, 1]);
  check("the agent check is the window's own isAgent when lent", F.rank([T(1, { assignee: "ray" })], { isAgent: () => true }).length, 0);
}

console.log("\nwhat Focus shows");
{
  const tasks = [T(1, { priority: "high" }), T(2), T(3, { priority: "low" }), T(4, { status: "doing" })];
  const busy = new Set([4]);
  check("nothing on the stack: the first of the ranking", F.pick(tasks).task.id, 1);
  check("and the rest in order", F.pick(tasks).next.map((t) => t.id), [2, 4, 3]);
  const sw = F.pick(tasks, { stack: [1, 3] });
  check("switched: the newest on the stack is the task, the one under it parked", [sw.task.id, sw.parked.id], [3, 1]);
  check("neither is repeated in what is next", sw.next.map((t) => t.id), [2, 4]);
  check("a job on the task already on screen does not take it away", F.pick(tasks, { stack: [4], busy }).task.id, 4);
  const gone = F.pick([...tasks.slice(0, 2), T(3, { status: "done" })], { stack: [1, 3] });
  check("done on top: the parked one comes back", [gone.task.id, gone.parked, gone.stack], [1, null, [1]]);
  check("nothing open is nothing", F.pick([T(1, { status: "done" })]).task, null);
}

console.log("\nthe three questions");
{
  const yes = true;
  const no = false;
  check("unanswered or part answered is no outcome", [F.triage({}), F.triage({ wait: no, keeps: yes })], [null, null]);
  check("AI can do it: delegate, whatever else", [F.triage({ wait: no, keeps: yes, ai: yes }), F.triage({ wait: yes, keeps: no, ai: yes })], ["delegate", "delegate"]);
  check("cannot wait and keeps the business running: switch now", F.triage({ wait: no, keeps: yes, ai: no }), "switch");
  check("everything else waits", [F.triage({ wait: yes, keeps: yes, ai: no }), F.triage({ wait: yes, keeps: no, ai: no }), F.triage({ wait: no, keeps: no, ai: no })], ["later", "later", "later"]);
  check("filed for later, one that cannot wait is high", [F.laterPriority({ wait: no }), F.laterPriority({ wait: yes })], ["high", "med"]);
  check("each outcome says what happened in one line",
    [F.outcomeLine("later", { id: 9, current: "Ship it" }), F.outcomeLine("switch", { id: 9, current: "Ship it" }), F.outcomeLine("sent", { agent: "Claude Code", job: 4 })],
    ['Filed #9 for later. You are still on "Ship it".', 'Switched to #9. "Ship it" is parked, still doing, and comes back next.', "Sent to Claude Code as job #4. It waits in Needs you until you approve it."]);
  check("no line has a dash the house rules forbid", /[\u2013\u2014\u2212]/.test(["later", "switch", "delegate", null].map((o) => F.preview(o, { current: "x" })).join(" ")), false);
}

console.log("\nbreak timing");
{
  check("15, 30 and 60 minutes", F.BREAK_MINUTES.map((m) => F.breakEnd(m, NOW) - NOW), [900000, 1800000, 3600000]);
  let refused = null;
  try { F.breakEnd(45, NOW); } catch (e) { refused = e.message; }
  check("and nothing else", Boolean(refused), true);
  check("time left never goes below nothing", [F.breakLeft(NOW + 5000, NOW), F.breakLeft(NOW - 5000, NOW)], [5000, 0]);
  check("a stored end still ahead resumes", F.resumeBreak(NOW + 600000, NOW), { state: "running", endsAt: NOW + 600000, left: 600000 });
  check("one that passed while closed has ended", F.resumeBreak(NOW - 1, NOW), { state: "ended", endsAt: NOW - 1 });
  check("no end, or junk, is no break", [F.resumeBreak(null, NOW).state, F.resumeBreak("soon", NOW).state, F.resumeBreak(0, NOW).state], ["none", "none", "none"]);
  check("the countdown rounds up, so 0:00 means over", [F.clock(1800000), F.clock(59001), F.clock(1), F.clock(0), F.clock(3600000)], ["30:00", "1:00", "0:01", "0:00", "1:00:00"]);
  const schema = require("../settings/schema");
  check("the setting takes an end within the hour, or nothing",
    [schema.check("focusBreakUntil", Date.now() + 1800000) > 0, schema.check("focusBreakUntil", null)], [true, null]);
  let far = null;
  try { schema.check("focusBreakUntil", Date.now() + 5 * 3600000); } catch (e) { far = e.message; }
  check("and refuses one that would lock the window for hours", Boolean(far), true);
}

// ---------------------------------------------------------------------------
// The window

const electron = require("electron");
const { app } = electron;
if (app.setActivationPolicy) app.setActivationPolicy("prohibited");
const ROOT = path.join(__dirname, "..");
let win = null;
class HiddenWindow extends electron.BrowserWindow {
  constructor(options = {}) { super({ ...options, show: false, paintWhenInitiallyHidden: true }); win = this; }
  loadFile(file, options) { return super.loadFile(path.resolve(ROOT, file), options); }
  show() {}
  focus() {}
}
const quiet = new Proxy(function stub() {}, { get: () => quiet, apply: () => quiet, construct: () => quiet });
const notices = [];
class FakeNotification { constructor(o) { this.o = o; } show() { notices.push(this.o); } static isSupported() { return true; } }
const stubbed = new Proxy(electron, {
  get: (target, key) => {
    if (key === "BrowserWindow") return HiddenWindow;
    if (key === "Tray") return quiet;
    if (key === "Notification") return FakeNotification;
    if (key === "globalShortcut") return { register: () => true, unregister() {}, unregisterAll() {}, isRegistered: () => false };
    return target[key];
  },
});
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  return request === "electron" ? stubbed : realLoad.call(this, request, ...rest);
};

const db = require("../db");
const project = db.createProject({ key: "fx", name: "Focus test", path: dir });
const first = db.createTask({ projectId: project.id, title: "Ship the release notes", priority: "high", due: "2026-11-07" });
const sub = db.createTask({ projectId: project.id, title: "Draft the summary", parentId: first.id });
const second = db.createTask({ projectId: project.id, title: "Reply to the vendor", priority: "high" });
db.createTask({ projectId: project.id, title: "An agent's job", priority: "high", assignee: "claude-code" });
db.createTask({ projectId: project.id, title: "Tidy the backlog", priority: "low" });
require("../main.js");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (id) => db.taskDetail(id).task.status;

async function main() {
  await app.whenReady();
  if (app.dock) app.dock.hide();
  for (let i = 0; i < 100 && !win; i++) await wait(100);
  if (!win) throw new Error("no window");
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const until = async (code, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) { if (await js(code)) return true; await wait(100); }
    return false;
  };
  const key = (keyCode, modifiers = []) => win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  const click = (sel) => js(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n || n.disabled) return false; n.click(); return true; })()`);
  const title = () => js(`document.querySelector("#focus .fx-title")?.textContent || null`);
  await until(`!!document.querySelector('#switcher .scope') && !!window.DelphiFocus`);
  await js("window.confirm = () => true; window.alert = () => {}; document.documentElement.setAttribute('data-motion', 'off'); 0");

  console.log("\nopening Focus");
  check("the top bar has the way in", await js(`!!document.querySelector("#focus-entry .fx-entry")`), true);
  check("Cmd+K lists it", await js(`DelphiCommands.match(COMMANDS, "focus mode", state).some((c) => c.id === "focus-mode")`), true);
  await js(`document.activeElement && document.activeElement.blur(); 0`);
  key("F");
  check("F opens it", await until(`DelphiFocus.isOpen() && !!document.querySelector("#focus .fx-title")`), true);
  check("on the top task", await title(), first.title);
  check("the rest of the window is out of reach", await js(`[document.getElementById("top").inert, document.querySelector("body > .body").inert]`), [true, true]);
  check("its subtasks are there", await js(`[...document.querySelectorAll("#focus .fx-step .txt")].map((n) => n.textContent)`), [sub.title]);
  check("an agent's task is never next", await js(`[...document.querySelectorAll("#focus .fx-peek .t")].map((n) => n.textContent)`), [second.title, "Tidy the backlog"]);

  console.log("\na subtask saves");
  await click(`#focus [data-act="sub-${sub.id}"]`);
  check("ticked, it is done in the database", await until(`!!document.querySelector('#focus [data-act="sub-${sub.id}"][aria-checked="true"]')`) && status(sub.id), "done");

  console.log("\nDone moves on");
  key("D");
  check("D brings the next task in", await until(`document.querySelector("#focus .fx-title")?.textContent === ${JSON.stringify(second.title)}`), true);
  check("the one before is done, through the normal path", status(first.id), "done");
  check("which wrote History", db.sqlP("SELECT COUNT(*) AS n FROM audit WHERE entity = 'task' AND entity_id = :p1 AND summary LIKE '%done%'", [first.id])[0].n > 0, true);
  check("and says so where a screen reader hears it", await until(`/Done: Ship the release notes/.test(document.querySelector("#focus .fx-live").textContent)`), true);
  check("Undo is offered", await click(`#focus .fx-toast-act`), true);
  check("Undo puts it back, and back on screen", await until(`document.querySelector("#focus .fx-title")?.textContent === ${JSON.stringify(first.title)}`) && status(first.id), "todo");

  console.log("\nan interruption that keeps the business running");
  key("I");
  check("I opens the three questions", await until(`!!document.querySelector('#focus .ic [data-q="wait"]')`), true);
  check("asked in order: the second waits for the first", await js(`document.querySelector('#focus .ic [data-q="keeps"]').disabled`), true);
  await js(`(() => { const t = document.querySelector("#focus .ic-title"); t.value = "The site is down"; t.dispatchEvent(new Event("input")); return 1; })()`);
  await click(`#focus .ic [data-q="wait"][data-v="false"]`);
  await click(`#focus .ic [data-q="keeps"][data-v="true"]`);
  await click(`#focus .ic [data-q="ai"][data-v="false"]`);
  check("the outcome is named before it is chosen", await js(`document.querySelector("#focus .verdict").textContent`), "Keeps business running");
  await click(`#focus [data-act="ic-go"]`);
  check("it becomes the focus", await until(`document.querySelector("#focus .fx-title")?.textContent === "The site is down"`), true);
  const made = db.sqlP("SELECT id, status, priority FROM tasks WHERE title = 'The site is down'", [])[0];
  check("filed as high and doing", [made.status, made.priority], ["doing", "high"]);
  check("the one it replaced is parked and still doing", [await js(`!!document.querySelector("#focus .fx-parked")`), status(first.id)], [true, "doing"]);
  check("one line says what happened", await js(`document.querySelector("#focus .fx-toast")?.textContent || ""`), `Switched to #${made.id}. "Ship the release notes" is parked, still doing, and comes back next.`);
  key("D");
  check("done with it, the parked one comes back", await until(`document.querySelector("#focus .fx-title")?.textContent === ${JSON.stringify(first.title)}`), true);

  console.log("\nan interruption that can wait");
  key("I");
  await until(`!!document.querySelector('#focus .ic-title')`);
  await js(`(() => { const t = document.querySelector("#focus .ic-title"); t.value = "Order more toner"; t.dispatchEvent(new Event("input")); return 1; })()`);
  for (const [q, v] of [["wait", "true"], ["keeps", "false"], ["ai", "false"]]) await click(`#focus .ic [data-q="${q}"][data-v="${v}"]`);
  await click(`#focus [data-act="ic-go"]`);
  await until(`!document.querySelector("#focus .ic")`);
  check("filed for later, and the focus stays put", [db.sqlP("SELECT status FROM tasks WHERE title = 'Order more toner'", [])[0]?.status, await title()], ["todo", first.title]);

  console.log("\ndelegating waits for approval");
  db.sqlP("UPDATE harnesses SET enabled = 1 WHERE key = 'claude-code'", []);
  db.sqlP("UPDATE projects SET auto_approve = 1 WHERE id = :p1", [project.id]);
  const run = await js(`window.delphi.focus.delegate({ projectId: ${project.id}, harness: "claude-code", request: "Draft it", taskId: ${first.id}, kind: "ask" })`);
  check("even on a project that auto-approves", [run.state, run.approval], ["needs_approval", "pending"]);
  const sent = await js(`window.delphi.runs.create({ projectId: ${project.id}, harness: "claude-code", request: "Draft it", taskId: ${first.id}, kind: "ask" })`);
  check("while the Hand to an agent dialog is unchanged", sent.state === "needs_approval", false);

  console.log("\na strict break");
  key("B");
  check("B offers three lengths", await until(`document.querySelectorAll("#focus .bp-opt").length === 3`), true);
  await click(`#focus [data-brk="15"]`);
  check("the blur is up", await until(`!!document.getElementById("fx-brk")`), true);
  check("and everything else is inert", await js(`[...document.body.children].filter((n) => n.id !== "fx-brk" && !n.inert).map((n) => n.tagName + "." + n.className)`), []);
  await wait(300);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).focusBreakUntil;
  check("its end is kept, so a restart picks it up", typeof saved === "number" && saved > Date.now() + 14 * 60000, true);
  key("Escape");
  key("K", [process.platform === "darwin" ? "meta" : "control"]);
  await wait(300);
  check("Escape does not end it, and Cmd+K does not open", [await js(`!!document.getElementById("fx-brk") && DelphiFocus.isOpen()`), await js(`DelphiPalette.isOpen()`)], [true, false]);
  await js(`document.body.append(Object.assign(document.createElement("div"), { className: "late" })); 0`);
  await wait(100);
  check("something added during the break is shut out too", await js(`document.querySelector("body > .late").inert`), true);
  check("a drop on the blur never reaches the page (Add folder listens on the document)",
    await js(`(() => { let reached = false; const f = () => { reached = true; }; document.addEventListener("drop", f); const e = new Event("drop", { bubbles: true, cancelable: true }); document.getElementById("fx-brk").dispatchEvent(e); document.removeEventListener("drop", f); return [reached, e.defaultPrevented]; })()`), [false, true]);
  await click(`#fx-brk [data-act="brk-cancel"]`);
  check("Cancel break asks first", await until(`!!document.querySelector('#fx-brk [data-act="brk-end"]')`), true);
  await click(`#fx-brk [data-act="brk-end"]`);
  check("and ends it", await until(`!document.getElementById("fx-brk")`), true);
  await wait(300);
  check("the window is reachable again, and the end is cleared",
    [await js(`document.querySelector("body > .late").inert`), JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).focusBreakUntil], [false, null]);
  // A break that runs out: its end moved half a second away rather than waiting fifteen minutes.
  await js(`(() => { const b = document.querySelector('#focus [data-act="break"]'); b.click(); return 1; })()`);
  await until(`!!document.querySelector('#focus [data-brk="15"]')`);
  await js(`(() => { document.querySelector('#focus [data-brk="15"]').click(); return 1; })()`);
  await until(`!!document.getElementById("fx-brk")`);
  await js(`(() => { DelphiFocus._state().brk.endsAt = Date.now() + 500; return 1; })()`);
  check("when it runs out it says so", await until(`/over/.test(document.getElementById("fx-brk")?.textContent || "")`, 5000), true);
  check("and a notice goes out", notices.some((n) => n.title === "Break's over"), true);
  key("Return");
  check("Enter goes back to the task", await until(`!document.getElementById("fx-brk")`), true);

  console.log("\nleaving");
  await js(`document.activeElement && document.activeElement.blur(); 0`);
  key("Escape");
  check("Escape leaves Focus", await until(`!DelphiFocus.isOpen()`), true);
  check("and gives the window back", await js(`[document.getElementById("top").inert, document.querySelector("body > .body").inert]`), [false, false]);

  console.log(`\n${checks - failures}/${checks} passed`);
}

main()
  .catch((error) => { failures++; console.error(error); })
  .finally(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    app.exit(failures ? 1 : 0);
  });
