#!/usr/bin/env node
// test-runtime: electron
//
// Everything the old task panel could do is still reachable from the drawer.
//
//   electron tools/drawer_test.js
//
// Direction B replaces the task panel with the drawer (ui/drawer.js), and the
// owner asked for a much cleaner one. Cleaner is only safe if nothing went
// missing on the way, so this lists every feature of the old panel, the way
// tools/commands_test.js lists every old place, and drives the real renderer
// to find each one where the drawer puts it: on the surface, behind a fold, or
// in a menu. A feature dropped from the drawer fails here by name.
//
// It also checks the drawer's own rules: the status keys, Escape and focus,
// the fold state, the composer's kinds, and the pure helpers (stuck, related,
// the subtask order).
//
// main.js is loaded for real against a temp data folder, with a hidden window
// that never takes focus, as in tools/sidebar_test.js.

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-drawer-")));
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

const electron = require("electron");
const { app } = electron;
if (app.setActivationPolicy) app.setActivationPolicy("prohibited");
const ROOT = path.join(__dirname, "..");
let win = null;
class HiddenWindow extends electron.BrowserWindow {
  constructor(options = {}) { super({ ...options, show: false, paintWhenInitiallyHidden: true, width: 1440, height: 900 }); win = this; }
  loadFile(file, options) { return super.loadFile(path.resolve(ROOT, file), options); }
  show() {}
  focus() {}
}
const quiet = new Proxy(function stub() {}, { get: () => quiet, apply: () => quiet, construct: () => quiet });
const stubbed = new Proxy(electron, {
  get: (target, key) => {
    if (key === "BrowserWindow") return HiddenWindow;
    if (key === "Tray") return quiet;
    if (key === "globalShortcut") return { register: () => true, unregister() {}, unregisterAll() {}, isRegistered: () => false };
    return target[key];
  },
});
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  return request === "electron" ? stubbed : realLoad.call(this, request, ...rest);
};

// A repository with a Workbench in it, made by git, so the Workbench section
// has a real folder to describe.
const repoDir = path.join(dir, "repo");
const wbDir = path.join(dir, "repo.workbenches", "task-wb");
const git = (...args) => execFileSync("git", args, { cwd: repoDir, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
fs.mkdirSync(repoDir, { recursive: true });
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(repoDir, "README"), "hi\n");
git("add", ".");
git("commit", "-qm", "first");
git("worktree", "add", "-q", "-b", "task-wb", wbDir, "main");

const db = require("../db");
// db.sqlP binds :p1 to :pN; the queries here read better with names.
const q = (sql, named = {}) => {
  const values = [];
  const text = sql.replace(/:([a-z]\w*)/gi, (_, k) => { values.push(named[k]); return `:p${values.length}`; });
  return db.sqlP(text, values);
};
const project = db.createProject({ key: "dw", name: "Drawer", path: repoDir });
const task = db.createTask({ projectId: project.id, title: "The task with everything", detail: "Read note 1 first.\n\n- one\n- two" });
db.updateTask(task.id, { status: "doing", priority: "high", ref: "PR-12", due: "2026-12-01" });
const subA = db.createTask({ projectId: project.id, title: "Sub A", parentId: task.id });
const subB = db.createTask({ projectId: project.id, title: "Sub B", parentId: task.id });
db.updateTask(subA.id, { status: "done" });
const wbTask = db.createTask({ projectId: project.id, title: "Has a Workbench" });
const note = db.createNote({ projectId: project.id, title: "A gotcha", body: `Seen on #${task.id}.`, kind: "gotcha" });
const pad = db.createScratchpad
  ? db.createScratchpad({ projectId: project.id, key: "plan", title: "The plan", body: "- [ ] a line" })
  : null;
const say = (kind, body, extra = {}) => q(
  "INSERT INTO comments (task_id, author, body, kind, meta, promoted, ref_id, author_type) VALUES (:t, :a, :b, :k, :m, :p, :r, :y) RETURNING id",
  { t: task.id, a: extra.author || "you", b: body, k: kind, m: extra.meta ? JSON.stringify(extra.meta) : null, p: extra.promoted ? 1 : 0, r: extra.ref || null, y: extra.type || "human" });
const idOf = (r) => (Array.isArray(r) ? r[0].id : r.id);
say("say", "A plain comment", { promoted: true });
say("run", "npm test", { meta: { state: "ok", code: 0, lines: 3, dur_ms: 1200 }, author: "claude-code", type: "agent" });
const asked = idOf(say("ask", "Ship it?", { meta: { options: [{ key: "a", label: "Yes" }, { key: "b", label: "No" }] } }));
say("decide", "a\nBecause it is ready", { ref: asked, meta: { choice: "a" } });
say("ask", "Which name?", { meta: { options: [{ key: "a", label: "Drawer" }, { key: "b", label: "Panel" }] } });
q("INSERT INTO status_events (task_id, status, actor) VALUES (:t, 'doing', 'you')", { t: task.id });
const repo = q("INSERT INTO repos (project_id, name, path, is_primary, base_branch) VALUES (:p, 'repo', :path, 1, 'main') RETURNING id", { p: project.id, path: repoDir });
q("INSERT INTO workbenches (task_id, repo_id, path, branch, base, state) VALUES (:t, :r, :path, 'task-wb', 'main', 'active')",
  { t: wbTask.id, r: idOf(repo), path: wbDir });
require("../main.js");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The old panel's features, each with where the drawer keeps it. `where` is
 * the section to unfold first (or null for the head), and `find` an
 * expression that is true when the feature is there. `menu` names a menu to
 * open and the words an item in it must carry.
 */
const FEATURES = [
  // The header row.
  ["crumb back to the project", null, "!!document.querySelector('.dw .dw-crumb-p')"],
  ["Hand to agent", null, null, { menu: "more", item: "Hand to agent" }],
  ["Copy brief", null, "!!document.querySelector('.dw [data-act=share]')"],
  ["Copy brief, in More too", null, null, { menu: "more", item: "Copy brief" }],
  ["Item menu: Move", null, null, { menu: "more", item: "Move to" }],
  ["Item menu: Copy", null, null, { menu: "more", item: "Copy to" }],
  ["Item menu: Also belongs to", null, null, { menu: "more", item: "Also belongs to" }],
  ["Item menu: Flag for review", null, null, { menu: "more", item: "Flag for review" }],
  ["the agent queue", null, null, { menu: "more", item: "agent queue" }],
  ["colour", null, null, { menu: "more", sel: ".swatch, .swatches, .swatch-row, [data-colour]" }],
  ["Open full view", null, null, { menu: "more", item: "Open full view" }],
  ["History", null, null, { menu: "more", item: "History" }],
  ["Delete", null, "!!document.querySelector('.dw [data-act=delete]')"],
  ["Close", null, "!!document.querySelector('.dw [data-act=close]')"],
  // The title and its facts.
  ["title, editable", null, "!!document.querySelector('.dw textarea.dw-title')"],
  ["the done ring", null, "!!document.querySelector('.dw [data-act=done]')"],
  ["status: To do, In progress, Done", null, "['todo','doing','done'].every((s) => document.querySelector(`.dw [data-status=${s}]`))"],
  ["status: Blocked", null, "!!document.querySelector('.dw [data-status=blocked]')"],
  ["priority", null, "!!document.querySelector('.dw [data-act=priority]')"],
  ["due date", null, "!!document.querySelector('.dw [data-act=due]')"],
  ["reminder", null, "!!document.querySelector('.dw [data-act=remind]')"],
  ["assignee", null, "!!document.querySelector('.dw [data-act=assign]')"],
  ["reference", null, "document.querySelector('.dw .dw-prop.ref')?.textContent === 'PR-12'"],
  ["subtask progress", null, "!!document.querySelector('.dw .dw-progress')"],
  // The run chip and the Workbench cluster moved into cards and sections.
  ["the Workbench, at a glance", null, "!!document.querySelector('.dw [data-card=workbench]')"],
  ["the newest run, at a glance", null, "!!document.querySelector('.dw [data-card=runs]')"],
  ["the Sheet, at a glance", null, "!!document.querySelector('.dw [data-card=sheet]')"],
  ["Start Workbench", "workbench", "!!document.querySelector('.dw [data-fold=workbench] [data-act=start]')"],
  // Details, Reminders and History tabs became sections.
  ["the description, rendered", "description", "!!document.querySelector('.dw [data-fold=description] .dw-prev .md')"],
  ["the description, editable", "description", "(document.querySelector('.dw [data-act=mode-write]').click(), !!document.querySelector('.dw [data-fold=description] textarea.dw-raw'))"],
  ["subtasks, each opens", "subtasks", "document.querySelectorAll('.dw [data-sub] [data-act=open]').length === 2"],
  ["subtask status", "subtasks", "!!document.querySelector('.dw [data-sub] [data-act=tick]')"],
  ["subtask menu", "subtasks", "!!document.querySelector('.dw [data-sub] [data-act=menu]')"],
  ["add a subtask", "subtasks", "!!document.querySelector('.dw .dw-addsub-in')"],
  ["reminders, listed and added", "reminders", "document.querySelector('.dw [data-fold=reminders] .dw-fold-b').childElementCount > 0"],
  ["how it got here", "activity", "!!document.querySelector('.dw .dw-timeline li')"],
  // The Sheet rail.
  ["Sheet: All and Ledger", "sheet", "!!document.querySelector('.dw [data-act=ledger]') && !!document.querySelector('.dw [data-act=all]')"],
  ["Sheet: copy it all", "sheet", "!!document.querySelector('.dw [data-act=copy-all]')"],
  ["Sheet: every entry shown", "sheet", "document.querySelectorAll('.dw [data-entry]').length === 5"],
  ["Sheet: promote", "sheet", null, { menu: "entry", item: "ledger" }],
  ["Sheet: file as a note", "sheet", null, { menu: "entry", item: "Decision" }],
  ["Sheet: copy an entry", "sheet", null, { menu: "entry", item: "Copy" }],
  ["Sheet: delete an entry", "sheet", null, { menu: "entry", item: "Delete entry" }],
  ["Sheet: a run's output", "sheet", "!!document.querySelector('.dw [data-act=output]')"],
  ["Sheet: answer an ask", "sheet", "!!document.querySelector('.dw [data-act=opt-a]:not([disabled])')"],
  ["Sheet: a decision names its question", "sheet", "!!document.querySelector('.dw [data-act=ref]')"],
  ["composer: say, run, ask, decide, note", null, "['say','run','ask','decide','note'].every((k) => document.querySelector(`.dw .dw-kinds [data-kind=${k}]`))"],
  ["composer: pinned at the bottom", null, "!!document.querySelector('.dw > .dw-foot .dw-compose-in')"],
  // Runs.
  ["Runs: hand to an agent", "runs", "!!document.querySelector('.dw [data-fold=runs] [data-act=hand]')"],
  // Memory, new in the drawer.
  ["Memory: the note that mentions it", "memory", `!!document.querySelector('.dw [data-note="${note.id}"]')`],
  ["Memory: log a fact", "memory", "!!document.querySelector('.dw [data-act=log-fact]')"],
];

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
  await until("typeof DelphiDrawer === 'object' && !!document.querySelector('#switcher .scope')");
  await js("window.confirm = () => true; window.alert = () => {}; localStorage.clear(); 0");
  await js(`navigate({ projectId: ${project.id}, view: "tasks", query: "" }).then(() => 1)`);
  await wait(500);

  const openTask = async (id) => {
    await js("DelphiDrawer.close(); 1");
    await wait(200);
    await js(`openTaskSheet(${id}).then(() => 1)`);
    return until(`!!document.querySelector('.dw[data-task="${id}"]')`);
  };
  const unfold = (key) => js(`(() => { const f = document.querySelector('.dw [data-fold=${key}]'); if (!f.classList.contains('open')) f.querySelector('.dw-fold-h').click(); return 1; })()`);
  const menuItems = async (which) => {
    await js("closeRowMenu(); 1");
    const opened = await js(which === "more"
      ? "(() => { const b = document.querySelector('.dw .dw-top [data-act=more]'); if (!b) return false; b.click(); return true; })()"
      : "(() => { const b = document.querySelector('.dw [data-entry] [data-act=entry-menu]'); if (!b) return false; b.click(); return true; })()");
    if (!opened) return null;
    await wait(150);
    return js("(() => { const m = document.querySelector('.ctx'); return m ? { text: [...m.querySelectorAll('.ctx-item')].map((n) => n.textContent), html: m.innerHTML.length, m: true } : null; })()");
  };

  console.log("\nopening a task opens the drawer");
  check("openTaskSheet draws the drawer", await openTask(task.id), true);
  check("and not the old panel", await js("!!document.querySelector('.task-sheet')"), false);
  check("it is a labelled dialog", await js("(() => { const d = document.querySelector('.dw'); return [d.getAttribute('role'), d.getAttribute('aria-label').startsWith('Task ')]; })()"), ["dialog", true]);
  check("it is openSheet, so live updates reach it", await js("openSheet && openSheet.drawer === true && openSheet.taskId"), task.id);

  console.log("\nevery feature of the old panel is reachable");
  for (const [name, where, find, menu] of FEATURES) {
    if (where) { await unfold(where); await wait(250); }
    if (menu) {
      const got = await menuItems(menu.menu);
      let ok = !!got;
      if (ok && menu.item) ok = got.text.some((t) => t.includes(menu.item));
      if (ok && menu.sel) ok = await js(`!!document.querySelector('.ctx') && !!document.querySelector('.ctx').querySelector(${JSON.stringify(menu.sel)})`);
      await js("closeRowMenu(); 1");
      check(name, ok, true);
    } else {
      check(name, await js(find).catch((e) => String(e)), true);
    }
  }

  console.log("\nthe Workbench section, with a Workbench");
  await openTask(wbTask.id);
  await unfold("workbench");
  await until("!!document.querySelector('.dw [data-fold=workbench] .dw-panel')");
  const acts = await js("[...document.querySelectorAll('.dw [data-fold=workbench] [data-act]')].map((n) => n.dataset.act)");
  for (const act of ["Open", "open-in", "Park", "Finish", "wb-more", "discard"]) check(`Workbench: ${act}`, acts.includes(act), true);
  await js("document.querySelector('.dw [data-act=wb-more]').click(); 1");
  await wait(150);
  check("Workbench More: Update and Show advanced",
    await js("[...document.querySelectorAll('.ctx .ctx-item')].map((n) => n.textContent)"), ["Update from main", "Show advanced"]);
  await js("closeRowMenu(); 1");
  check("the card names the branch", await js("document.querySelector('.dw [data-card=workbench] .v').textContent"), "task-wb");
  q("UPDATE workbenches SET state = 'parked' WHERE task_id = :t", { t: wbTask.id });
  await openTask(wbTask.id);
  await until("!!document.querySelector('.dw [data-fold=workbench] .dw-panel')");
  check("Workbench parked: Resume", await js("!!document.querySelector('.dw [data-fold=workbench] [data-act=Resume]')"), true);
  q("UPDATE workbenches SET state = 'missing' WHERE task_id = :t", { t: wbTask.id });
  await openTask(wbTask.id);
  await until("!!document.querySelector('.dw [data-fold=workbench] .dw-panel')");
  check("Workbench missing: Recreate and Forget",
    await js("['Recreate','Forget'].map((a) => !!document.querySelector(`.dw [data-fold=workbench] [data-act=${a}]`))"), [true, true]);

  console.log("\nthe keys");
  await openTask(task.id);
  await js("document.querySelector('.dw').focus(); 1");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "4" });
  win.webContents.sendInputEvent({ type: "char", keyCode: "4" });
  await until(`openSheet && document.querySelector('.dw [data-status=done]')?.classList.contains('on')`);
  check("4 marks it done", db.getTask ? db.getTask(task.id).status : q("SELECT status FROM tasks WHERE id = :id", { id: task.id })[0].status, "done");
  await js("document.querySelector('.dw').focus(); 1");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "2" });
  await wait(600);
  check("2 sets it in progress", q("SELECT status FROM tasks WHERE id = :id", { id: task.id })[0].status, "doing");
  await js("document.querySelector('.dw').focus(); 1");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "P" });
  await wait(200);
  check("P opens priority", await js("[...document.querySelectorAll('.ctx .ctx-item')].map((n) => n.textContent.trim().split(' ')[0])"), ["High", "Medium", "Low"]);
  await js("closeRowMenu(); document.querySelector('.dw').focus(); 1");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "A" });
  await wait(200);
  check("A opens the assignee", await js("document.activeElement?.getAttribute('aria-label')"), "Assignee");
  await js("document.activeElement.blur(); 1");
  await wait(300);
  check("digits typed in the composer stay digits", await js(`(() => { const b = document.querySelector('.dw .dw-compose-in'); b.focus(); return 1; })()`), 1);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "1" });
  win.webContents.sendInputEvent({ type: "char", keyCode: "1" });
  await wait(300);
  check("and do not change the status", q("SELECT status FROM tasks WHERE id = :id", { id: task.id })[0].status, "doing");
  await js("document.querySelector('.dw .dw-compose-in').value = ''; 1");

  console.log("\nthe title and the subtask box");
  await js("document.querySelector('.dw .dw-title-btn').click(); 1");
  check("the title edits on a click", await js("document.activeElement?.tagName === 'TEXTAREA' && document.activeElement.classList.contains('dw-title')"), true);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  await wait(200);
  check("and Enter hands focus back to the title, not the page", await js("document.activeElement?.classList.contains('dw-title-btn')"), true);
  await unfold("subtasks");
  await js(`(() => { const i = document.querySelector('.dw .dw-addsub-in'); i.focus(); i.value = 'Sub C'; return 1; })()`);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  check("a subtask added with Enter shows straight away", await until(`[...document.querySelectorAll('.dw [data-sub] [data-act=open]')].some((n) => n.textContent === 'Sub C')`), true);
  check("with the box still ready for the next", await js("document.activeElement?.classList.contains('dw-addsub-in')"), true);
  await js("document.activeElement.blur(); 1");

  console.log("\nthe composer");
  await js(`(() => { const b = document.querySelector('.dw .dw-compose-in'); b.value = 'From the test'; b.dispatchEvent(new Event('input')); document.querySelector('.dw [data-act=send]').click(); return 1; })()`);
  await until(`[...document.querySelectorAll('.dw [data-entry]')].some((n) => n.textContent.includes('From the test'))`);
  check("say posts to the Sheet", q("SELECT kind FROM comments WHERE body = 'From the test'").map((r) => r.kind), ["say"]);
  const C = (raw, mode, ask) => js(`DelphiDrawer.composed(${JSON.stringify(raw)}, ${JSON.stringify(mode)}, { openAsk: ${JSON.stringify(ask)} })`);
  check("$ runs whatever the mode", (await C("$ ls", "say")).kind, "run");
  check("/note switches to a note", [(await C("/note hi", "say")).kind, (await C("/note hi", "say")).body], ["note", "hi"]);
  check("an ask needs 2 to 4 options", [(await C("q | a", "ask")).ok, (await C("q | a | b", "ask")).ok], [false, true]);
  const open = { id: 9, body: "Which?", meta: { options: [{ key: "a", label: "A" }, { key: "b", label: "B" }] } };
  check("decide takes the option key and why", await C("b because", "decide", open).then((c) => [c.ok, c.askId, c.choice, c.why]), [true, 9, "b", "because"]);
  check("decide with nothing open says so", (await C("a", "decide", null)).ok, false);

  console.log("\nfolds, Escape and focus");
  // Activity was unfolded above; folding it must survive a reopen.
  const isOpen = () => js("document.querySelector('.dw [data-fold=activity]').classList.contains('open')");
  if (!(await isOpen())) await unfold("activity");
  await js("document.querySelector('.dw [data-fold=activity] .dw-fold-h').click(); 1");
  check("folding is kept per viewer", await js("JSON.parse(localStorage.getItem('delphi.drawer.folds')).activity"), false);
  await openTask(task.id);
  check("and a reopened drawer has it folded", await isOpen(), false);
  await unfold("activity");
  await openTask(task.id);
  check("unfolded likewise", await isOpen(), true);
  await js("DelphiDrawer.close(); 1");
  await wait(200);
  await js(`(() => { const b = document.createElement('button'); b.id = 'opener'; b.textContent = 'x'; document.body.append(b); b.focus(); return 1; })()`);
  await js(`openTaskSheet(${task.id}).then(() => 1)`);
  await until("!!document.querySelector('.dw')");
  check("focus moves into the drawer", await js("document.querySelector('.dw').contains(document.activeElement)"), true);
  await js("(() => { const all = [...document.querySelectorAll('.dw button, .dw textarea, .dw input')].filter((n) => !n.disabled && n.offsetParent); all[all.length - 1].focus(); return 1; })()");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  await wait(100);
  check("Tab from the last control stays inside", await js("document.querySelector('.dw').contains(document.activeElement)"), true);
  await js("document.querySelector('.dw').focus(); 1");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  await until("!document.querySelector('.dw')");
  check("Escape closes it", await js("!!document.querySelector('.dw') || !!openSheet"), false);
  check("and focus goes back where it was", await js("document.activeElement?.id"), "opener");
  await js("document.getElementById('opener').remove(); 1");

  console.log("\nOpen full view keeps the old panel");
  await openTask(task.id);
  await js("document.querySelector('.dw .dw-top [data-act=more]').click(); 1");
  await wait(150);
  await js("[...document.querySelectorAll('.ctx .ctx-item')].find((n) => n.textContent.includes('Open full view')).click(); 1");
  check("the full panel opens", await until("!!document.querySelector('.task-sheet')"), true);
  check("and the drawer is gone", await js("!!document.querySelector('.dw')"), false);
  await js("openSheet && openSheet.close(); 1");
  await wait(300);

  console.log("\nthe drawer or the centered view, as the owner chooses");
  await openTask(task.id);
  check("the drawer has Open full view in its header", await js("!!document.querySelector('.dw .dw-top [data-act=full]')"), true);
  await js("document.querySelector('.dw').focus(); 1");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return", modifiers: ["shift"] });
  check("Shift and Enter in the drawer opens the centered view", await until("!!document.querySelector('.task-sheet') && !document.querySelector('.dw')"), true);
  await js("openSheet && openSheet.close(); 1");
  await wait(300);
  await js(`window.delphi.settings.set({ taskOpenMode: "centered" }).then((s) => { state.settings = s; return 1; })`);
  await js(`openTaskSheet(${task.id}).then(() => 1)`);
  check("with Open tasks in set to Centered view, a task opens centered", await until("!!document.querySelector('.task-sheet')"), true);
  check("and not in the drawer", await js("!!document.querySelector('.dw')"), false);
  await js("openSheet && openSheet.close(); 1");
  await wait(300);
  await js(`window.delphi.settings.set({ taskOpenMode: "drawer" }).then((s) => { state.settings = s; return 1; })`);
  check("set back to Drawer, it opens in the drawer again", await openTask(task.id), true);
  await js("DelphiDrawer.close(); 1");
  await wait(200);

  console.log("\nnotes and pads open in the same drawer");
  await js(`openNoteSheet(${JSON.stringify(note)}); 1`);
  check("a note opens in the drawer", await until("!!document.querySelector('.dw.dw-note')"), true);
  check("it lists the task it names", await js(`!!document.querySelector('.dw [data-open="${task.id}"]')`), true);
  check("with Also belongs to and Flag for review", await js("['also','flag'].map((a) => !!document.querySelector(`.dw [data-act=${a}]`))"), [true, true]);
  if (pad) {
    await js(`DelphiDrawer.openPad(${pad.id}).then(() => 1)`);
    check("a pad opens in the drawer", await until("!!document.querySelector('.dw.dw-pad')"), true);
    check("with its checkbox switch", await js("document.querySelector('.dw [data-act=derive]')?.getAttribute('role')"), "switch");
  }
  await js("DelphiDrawer.close(); 1");

  console.log("\nagents writing while a person reads or types");
  const changed = () => win.webContents.send("db-changed");
  const pick = async (label) => {
    await until(`!!document.querySelector(".wb-dialog")`);
    return js(`(() => { const b = [...document.querySelectorAll(".wb-dialog button")].find((n) => n.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
  };
  const raw = (scope) => `document.querySelector('${scope} textarea.dw-raw')`;
  const detailOf = (id) => q("SELECT detail FROM tasks WHERE id = :id", { id })[0].detail;
  const typeInto = (sel, text) => js(`(() => { const a = ${sel}; a.focus(); a.value = a.value + ${JSON.stringify(text)}; a.dispatchEvent(new Event('input')); return 1; })()`);
  // A hidden window that never has the focus fires no blur of its own, so
  // the event a person's click elsewhere would send is sent by hand.
  const blur = (sel) => js(`(() => { const a = ${sel}; a.blur(); a.dispatchEvent(new FocusEvent("blur")); return 1; })()`);
  const dTask = db.createTask({ projectId: project.id, title: "Written by two", detail: "A" });
  await js(`localStorage.setItem("delphi.drawer.mode.task", JSON.stringify("write")); localStorage.setItem("delphi.drawer.folds", JSON.stringify({ description: true })); 1`);
  await openTask(dTask.id);
  const D = raw(".dw [data-fold=description]");
  db.updateTask(dTask.id, { detail: "B" }); changed();
  check("not focused: the description shows the agent's write", await until(`${D}.value === "B"`), true);
  await js(`${D}.focus(); 1`);
  db.updateTask(dTask.id, { detail: "C" }); changed();
  await wait(500);
  check("focused: the box is left alone while it has the focus", await js(`${D}.value`), "B");
  await blur(D);
  check("and on blur, with nothing typed, it takes the agent's write", await until(`${D}.value === "C"`), true);
  check("without writing anything back", detailOf(dTask.id), "C");
  await typeInto(D, " mine");
  db.updateTask(dTask.id, { detail: "D by an agent" }); changed();
  await wait(300);
  await blur(D);
  check("typed and written both: it asks", await pick("Not now"), true);
  await wait(300);
  check("Not now writes nothing", detailOf(dTask.id), "D by an agent");
  check("and keeps what was typed", await js(`${D}.value`), "C mine");
  await js(`${D}.focus(); 1`); await blur(D);
  check("asked again, Keep mine", await pick("Keep mine"), true);
  await until(`!document.querySelector(".wb-dialog")`); await wait(300);
  check("writes the person's text", detailOf(dTask.id), "C mine");
  await typeInto(D, " again");
  db.updateTask(dTask.id, { detail: "E by an agent" }); changed();
  await wait(300);
  await blur(D);
  check("asked, Take theirs", await pick("Take theirs"), true);
  await until(`${D}.value === "E by an agent"`);
  check("keeps the agent's text and shows it", [detailOf(dTask.id), await js(`${D}.value`)], ["E by an agent", "E by an agent"]);
  // A preview tick while the description holds typing after Not now
  // (probe8): the next blur still asks, and the agent's words stay.
  await js("DelphiDrawer.close(); 1"); await wait(300);
  const dtk = db.createTask({ projectId: project.id, title: "Tick probe", detail: "- [ ] box\nA" });
  await js(`localStorage.setItem("delphi.drawer.mode.task", JSON.stringify("split")); 1`);
  await openTask(dtk.id);
  await typeInto(D, "").then(() => js(`(() => { const a = ${D}; a.value = a.value.replace("A", "A mine"); a.dispatchEvent(new Event('input')); return 1; })()`));
  db.updateTask(dtk.id, { detail: "- [ ] box\nC by agent" }); changed();
  await wait(300);
  await blur(D);
  check("description typed while an agent wrote: it asks", await pick("Not now"), true);
  await wait(300);
  await js("(() => { const b = document.querySelector('.dw [data-fold=description] .dw-prev input.md-check:not([disabled])'); b.checked = true; b.dispatchEvent(new Event('change')); return 1; })()");
  await wait(900);
  check("the tick lands on the stored text", detailOf(dtk.id), "- [x] box\nC by agent");
  await typeInto(D, ".");
  await blur(D);
  check("and the next save still asks, rather than writing over the agent", await pick("Not now"), true);
  await wait(300);
  check("so the agent's words stay", detailOf(dtk.id), "- [x] box\nC by agent");
  await js("DelphiDrawer.close(); 1");
  check("closing asks once more", await pick("Not now"), true);
  await until("!document.querySelector('.dw')");
  db.updateTask(dtk.id, { detail: "- [x] box\nD by agent" });
  await openTask(dtk.id);
  check("reopened, the draft is back", await js(`${D}.value.includes("A mine")`), true);
  await typeInto(D, "!");
  await blur(D);
  check("typing on it asks again rather than writing over the agent", await pick("Not now"), true);
  await wait(300);
  check("and the agent's words are still there", detailOf(dtk.id), "- [x] box\nD by agent");
  await js("DelphiDrawer.close(); 1");
  await pick("Not now");
  await until("!document.querySelector('.dw')");
  await js(`localStorage.setItem("delphi.drawer.mode.task", JSON.stringify("write")); 1`);
  await openTask(dTask.id);

  const T = "document.querySelector('.dw textarea.dw-title')";
  const titleOf = (id) => q("SELECT title FROM tasks WHERE id = :id", { id })[0].title;
  await js("document.querySelector('.dw .dw-title-btn').click(); 1");
  await typeInto(T, " (mine)");
  db.updateTask(dTask.id, { title: "Renamed by an agent" }); changed();
  await wait(300);
  await blur(T);
  check("a title typed while an agent renamed it asks too", await pick("Take theirs"), true);
  await wait(300);
  check("Take theirs keeps the agent's title, in the store and the box", [titleOf(dTask.id), await js(`${T}.value`)], ["Renamed by an agent", "Renamed by an agent"]);
  await js(`(() => { const a = ${T}; a.value = a.value + "  "; a.dispatchEvent(new Event('input')); return 1; })()`);
  db.updateTask(dTask.id, { title: "Renamed again" }); changed();
  await wait(300);
  await blur(T);
  await wait(400);
  check("spaces typed after it are not a rename over the agent's", [titleOf(dTask.id), await js("!!document.querySelector('.wb-dialog')")], ["Renamed again", false]);
  await js("DelphiDrawer.close(); 1"); await wait(300);

  // A tick in the description while an agent has written it, unseen here.
  const tTask = db.createTask({ projectId: project.id, title: "Ticks", detail: "- [ ] one\n- [ ] two" });
  await js(`localStorage.setItem("delphi.drawer.mode.task", JSON.stringify("preview")); 1`);
  await openTask(tTask.id);
  await until(`!!document.querySelector('.dw [data-fold=description] input[data-line="1"]')`);
  db.updateTask(tTask.id, { detail: "- [ ] one\n- [ ] two\nwritten by an agent" });
  await js(`(() => { const b = document.querySelector('.dw [data-fold=description] input[data-line="1"]'); b.checked = true; b.dispatchEvent(new Event("change")); return 1; })()`);
  await wait(800);
  check("a tick lands on the agent's newer text, not over it", detailOf(tTask.id), "- [ ] one\n- [x] two\nwritten by an agent");
  db.updateTask(tTask.id, { detail: "- [ ] zero\n- [ ] one\n- [x] two\nwritten by an agent" });
  await js(`(() => { const b = document.querySelector('.dw [data-fold=description] input[data-line="0"]'); b.checked = true; b.dispatchEvent(new Event("change")); return 1; })()`);
  await wait(800);
  check("and a tick whose line moved meanwhile writes nothing", detailOf(tTask.id), "- [ ] zero\n- [ ] one\n- [x] two\nwritten by an agent");
  await js("DelphiDrawer.close(); 1"); await wait(300);
  await js(`localStorage.setItem("delphi.drawer.mode.task", JSON.stringify("write")); 1`);

  if (pad) {
    const padRow = () => q("SELECT body FROM scratchpads WHERE id = :id", { id: pad.id })[0].body;
    db.writeScratchpad(pad.id, { derives_tasks: 1 });
    await js(`localStorage.setItem("delphi.drawer.mode.pad", JSON.stringify("write")); 1`);
    await js(`DelphiDrawer.openPad(${pad.id}).then(() => 1)`);
    await until("!!document.querySelector('.dw.dw-pad')");
    const P = raw(".dw-pad");
    await typeInto(P, "\n- [ ] beta"); await blur(P);
    check("a pad saved here gets its new line's anchor back in the box", await until(`/beta <!--d:\\d+-->/.test(${P}.value)`), true);
    await js(`(() => { const a = ${P}; a.focus(); a.value = a.value.replace("beta", "beta two"); a.dispatchEvent(new Event('input')); return 1; })()`);
    await blur(P);
    await wait(800);
    const st = db.scratchpadTasks(pad.id);
    check("so renaming that line renames its task, not a second one", [st.lines.length, st.dropped.length, st.lines.some((l) => /beta two/.test(l.title || (l.task && l.task.title) || ""))], [2, 0, true]);
    db.appendScratchpad(pad.id, "- [ ] agent line"); changed();
    check("not focused: an agent's append shows", await until(`${P}.value.includes("agent line")`), true);
    await typeInto(P, "\nmy prose");
    db.appendScratchpad(pad.id, "- [ ] second agent line"); changed();
    await wait(300);
    await blur(P);
    await wait(800);
    check("typed and appended both: the lines merge, with no question", [await js("!!document.querySelector('.wb-dialog')"), padRow().includes("second agent line"), padRow().includes("my prose")], [false, true, true]);
    await js("DelphiDrawer.close(); 1");
    await until("!document.querySelector('.dw')");

    // A task the board ticked while the person edited prose: Keep mine
    // never reopens it, because there is nothing to ask.
    const pad2 = db.createScratchpad({ projectId: project.id, key: "tick" + Date.now() % 1000, title: "Ticks", body: "- [ ] alpha" });
    const alphaId = db.scratchpadTasks(pad2.id).lines[0].taskId;
    await js(`DelphiDrawer.openPad(${pad2.id}).then(() => 1)`);
    await until("!!document.querySelector('.dw.dw-pad')");
    await typeInto(P, "\nprose");
    db.updateTask(alphaId, { status: "done" }); changed();
    await wait(300);
    await blur(P);
    await wait(800);
    check("a tick the board wrote back stays done through the person's save", [q("SELECT status FROM tasks WHERE id = :id", { id: alphaId })[0].status, /\[x\] alpha/.test(q("SELECT body FROM scratchpads WHERE id = :id", { id: pad2.id })[0].body)], ["done", true]);
    await js("DelphiDrawer.close(); 1");
    await until("!document.querySelector('.dw')");

    // Typing while a save is on its way, then renaming the line it filed:
    // the anchor comes into the typing, so it stays one task (probe5, S7).
    const pad3 = db.createScratchpad({ projectId: project.id, key: "ray" + Date.now() % 1000, title: "Gamma", body: "- [ ] alpha" });
    await js(`DelphiDrawer.openPad(${pad3.id}).then(() => 1)`);
    await until("!!document.querySelector('.dw.dw-pad')");
    await js(`(() => { const a = ${P}; a.focus(); a.value += '\\n- [ ] gamma'; a.dispatchEvent(new Event('input')); a.dispatchEvent(new FocusEvent('blur'));
      a.value = a.value.replace('gamma', 'gamma ray') + '\\nmore'; a.dispatchEvent(new Event('input')); return 1; })()`);
    await wait(900);
    check("the anchor of a line saved while typing goes into the typing", await js(`/gamma ray <!--d:\\d+-->/.test(${P}.value)`), true);
    await blur(P);
    await wait(900);
    const g = db.scratchpadTasks(pad3.id);
    check("so the renamed line is one task, not two", [g.lines.length, g.dropped.length, g.lines.map((l) => (l.task && l.task.title) || l.title).filter((t) => /gamma/.test(t || ""))], [2, 0, ["gamma ray"]]);
    await js("DelphiDrawer.close(); 1");
    await until("!document.querySelector('.dw')");

    // One line reworded on both sides: nothing to choose, both are kept.
    const padOf = (id) => q("SELECT body FROM scratchpads WHERE id = :id", { id })[0].body;
    const pad4 = db.createScratchpad({ projectId: project.id, key: "dr" + Date.now() % 1000, title: "Both", body: "- [ ] alpha\nprose" });
    await js(`DelphiDrawer.openPad(${pad4.id}).then(() => 1)`);
    await until("!!document.querySelector('.dw.dw-pad')");
    await js(`(() => { const a = ${P}; a.focus(); a.value = a.value.replace("prose", "prose MINE"); a.dispatchEvent(new Event('input')); return 1; })()`);
    { const cur = padOf(pad4.id); db.writeScratchpad(pad4.id, { body: cur.replace("prose", "prose THEIRS") + "\n- [ ] agent line" }); }
    changed();
    await wait(300);
    await blur(P);
    await wait(900);
    const b4 = padOf(pad4.id);
    check("a pad reworded on both sides asks nothing", await js("!!document.querySelector('.wb-dialog')"), false);
    check("keeps the person's line, then the agent's marked under it, and the agent's new line", [b4.includes("prose MINE"), b4.includes("> (agent's version) prose THEIRS"), b4.includes("agent line")], [true, true, true]);
    check("and says so", await js("/both versions are kept/.test((document.querySelector('.wb-toast') || {}).textContent || '')"), true);

    // A preview tick while the box holds typing the store has not taken
    // (probe8): the base moves only by the tick, so the next save still
    // merges with the agent's write rather than writing over it.
    await js(`localStorage.setItem("delphi.drawer.mode.pad", JSON.stringify("split")); 1`);
    await js("DelphiDrawer.close(); 1");
    await until("!document.querySelector('.dw')");
    const pad5 = db.createScratchpad({ projectId: project.id, key: "tk" + Date.now() % 1000, title: "Tick while typing", body: "- [ ] one\nprose" });
    await js(`DelphiDrawer.openPad(${pad5.id}).then(() => 1)`);
    await until("!!document.querySelector('.dw.dw-pad .dw-prev input.md-check')");
    await js(`(() => { const a = ${P}; a.focus(); a.value = a.value.replace("prose", "prose MINE"); a.dispatchEvent(new Event('input')); return 1; })()`);
    { const cur = padOf(pad5.id); db.writeScratchpad(pad5.id, { body: cur.replace("prose", "prose THEIRS") + "\n- [ ] agent line" }); }
    changed();
    await wait(300);
    await js("(() => { const b = document.querySelector('.dw-pad .dw-prev input.md-check:not([disabled])'); b.checked = true; b.dispatchEvent(new Event('change')); return 1; })()");
    await wait(900);
    await typeInto(P, ".");
    await blur(P);
    await wait(900);
    const b5 = padOf(pad5.id);
    check("a tick on a pad with unsaved typing, then a save, keeps the agent's words and line", [b5.includes("THEIRS"), b5.includes("agent line"), b5.includes("MINE"), /- \[x\] one/.test(b5)], [true, true, true, true]);
    await js("DelphiDrawer.close(); 1");
    await until("!document.querySelector('.dw')");
    await js(`localStorage.setItem("delphi.drawer.mode.pad", JSON.stringify("write")); 1`);

    // A line inserted above a new task while it saves, then the task renamed
    // (the reviewer's case): the task keeps its anchor, so it stays one task.
    const pad6 = db.createScratchpad({ projectId: project.id, key: "ab" + Date.now() % 1000, title: "Above", body: "- [ ] alpha" });
    await js(`DelphiDrawer.openPad(${pad6.id}).then(() => 1)`);
    await until("!!document.querySelector('.dw.dw-pad')");
    await js(`(() => { const a = ${P}; a.focus(); a.value += '\\n- [ ] gamma'; a.dispatchEvent(new Event('input')); a.dispatchEvent(new FocusEvent('blur'));
      a.value = a.value.replace('- [ ] gamma', 'some prose\\n- [ ] gamma ray'); a.dispatchEvent(new Event('input')); return 1; })()`);
    await wait(900);
    await blur(P);
    await wait(900);
    const g6 = db.scratchpadTasks(pad6.id);
    check("prose put above a task while it saved, then a rename: still one task", [g6.lines.length, g6.dropped.length, g6.lines.filter((l) => /gamma/.test((l.task && l.task.title) || l.title || "")).length], [2, 0, 1]);
    await js("DelphiDrawer.close(); 1");
    await until("!document.querySelector('.dw')");

    console.log("\ncompare and set");
    let refused = null;
    const was4 = q("SELECT body FROM scratchpads WHERE id = :id", { id: pad4.id })[0].body;
    try { db.writeScratchpad(pad4.id, { body: "nope" }, { expectBody: "not what it is" }); } catch (e) { refused = e.code; }
    check("a pad write that expects an older body is refused with CONFLICT", refused, "CONFLICT");
    check("and writes nothing", q("SELECT body FROM scratchpads WHERE id = :id", { id: pad4.id })[0].body, was4);
    const nowBody = q("SELECT body FROM scratchpads WHERE id = :id", { id: pad4.id })[0].body;
    db.writeScratchpad(pad4.id, { body: nowBody + "\nok" }, { expectBody: nowBody });
    check("one that expects the body it has is written", q("SELECT body FROM scratchpads WHERE id = :id", { id: pad4.id })[0].body.endsWith("\nok"), true);
    check("through the window too", await js(`window.delphi.pads.write(${pad4.id}, { body: "x" }, { expectBody: "stale" }).then(() => "written", (e) => e.code)`), "CONFLICT");
  }

  const nNote = db.createNote({ projectId: project.id, title: "Shared note", body: "one" });
  await js(`localStorage.setItem("delphi.drawer.mode.note", JSON.stringify("write")); 1`);
  await js(`DelphiDrawer.openNote({ id: ${nNote.id}, project_id: ${project.id}, title: "stale", body: "" }).then(() => 1)`);
  await until("!!document.querySelector('.dw.dw-note')");
  const N = raw(".dw-note");
  check("a note opened from a stale row shows the stored body", await js(`${N}.value`), "one");
  db.updateNote(nNote.id, { body: "two by an agent" }); changed();
  check("not focused: a note takes an agent's write", await until(`${N}.value === "two by an agent"`), true);
  await typeInto(N, " and mine");
  db.updateNote(nNote.id, { body: "three by an agent" }); changed();
  await wait(300);
  await blur(N);
  check("typed and written both: it asks", await pick("Take theirs"), true);
  await wait(300);
  check("Take theirs keeps the agent's note", q("SELECT body FROM notes WHERE id = :id", { id: nNote.id })[0].body, "three by an agent");
  await js("DelphiDrawer.close(); 1"); await wait(300);

  console.log("\nkeys and clicks that do the thing");
  await js(`navigate({ projectId: ${project.id}, view: "tasks", query: "" }).then(() => 1)`);
  await until(`!!document.querySelector('#content .tk-row[data-task-id="${dTask.id}"]')`);
  await wait(400);
  await js(`document.querySelector('#content .tk-row[data-task-id="${dTask.id}"]').focus(); 1`);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return", modifiers: ["shift"] });
  check("Shift and Enter on a focused row opens the centered view", await until("!!document.querySelector('.task-sheet')"), true);
  await js("openSheet && openSheet.close(); 1"); await wait(300);
  q("UPDATE tasks SET status = 'doing' WHERE id = :id", { id: task.id });
  await openTask(task.id);
  await unfold("subtasks");
  await js("document.querySelector('.dw [data-sub] [data-act=open]').focus(); 1");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "4" });
  await wait(500);
  check("4 pressed on a subtask does not touch the task above it", q("SELECT status FROM tasks WHERE id = :id", { id: task.id })[0].status, "doing");
  await unfold("sheet");
  const decidesBefore = q("SELECT COUNT(*) AS n FROM comments WHERE task_id = :t AND kind = 'decide'", { t: task.id })[0].n;
  await js("document.querySelector('.dw [data-act=opt-a]:not([disabled])').click(); 1");
  await wait(800);
  check("clicking an ask's option answers it", q("SELECT COUNT(*) AS n FROM comments WHERE task_id = :t AND kind = 'decide'", { t: task.id })[0].n, decidesBefore + 1);
  await unfold("runs");
  await js("document.querySelector('.dw [data-fold=runs] [data-act=hand]').click(); 1");
  check("clicking Run opens Hand to agent", await until("!!document.querySelector('.hand-dialog')"), true);
  await js("(() => { const b = [...document.querySelectorAll('.hand-dialog button')].find((n) => /cancel/i.test(n.textContent)); if (b) b.click(); else document.querySelector('.hand-dialog').closest('.overlay').remove(); return 1; })()");
  await wait(300);
  const startTask = db.createTask({ projectId: project.id, title: "Start me" });
  await openTask(startTask.id);
  await unfold("workbench");
  await until("!!document.querySelector('.dw [data-fold=workbench] [data-act=start]')");
  await js("document.querySelector('.dw [data-fold=workbench] [data-act=start]').click(); 1");
  // More than one place to start from asks which; the first is fine here.
  await wait(600);
  await js("(() => { const o = document.querySelector('.wb-dialog .repo-pick button, .wb-dialog [data-pick], .wb-dialog li button'); if (o) o.click(); return 1; })()");
  check("clicking Start Workbench makes one", await until(`(window.__n = (window.__n || 0) + 1, !!document.querySelector('.dw [data-card=workbench] .v.mono'))`, 20000), true);
  check("in the store too", q("SELECT COUNT(*) AS n FROM workbenches WHERE task_id = :t", { t: startTask.id })[0].n, 1);
  await js("DelphiDrawer.close(); 1"); await wait(300);

  console.log("\nthe pure rules");
  const ML = (b, t, m) => js(`DelphiDrawer.mergeLines(${JSON.stringify(b)}, ${JSON.stringify(t)}, ${JSON.stringify(m)})`);
  check("merge: an agent's new line and the person's new line both stay", (await ML("a", "a\nagent", "a\nmine")).text, "a\nagent\nmine");
  check("merge: different lines changed on each side", (await ML("a\nb\nc", "a\nB\nc", "a\nb\nC")).text, "a\nB\nC");
  check("merge: the same line changed on both sides is a clash", (await ML("x", "y", "z")).conflicts, 1);
  check("merge: a tick from theirs on a line the person renamed", (await ML("- [ ] a <!--d:1-->", "- [x] a <!--d:1-->", "- [ ] a two <!--d:1-->")).text, "- [x] a two <!--d:1-->");
  check("merge: a line the person moved keeps the agent's tick", (await ML("- [ ] a <!--d:1-->\n- [ ] b <!--d:2-->", "- [ ] a <!--d:1-->\n- [x] b <!--d:2-->", "- [ ] b <!--d:2-->\n- [ ] a <!--d:1-->")).text, "- [x] b <!--d:2-->\n- [ ] a <!--d:1-->");
  check("merge: the agent's new line next to a clash comes after the agent's version", (await ML("- [ ] a <!--d:1-->", "- [ ] a theirs <!--d:1-->\n- [ ] agent new", "- [ ] a mine <!--d:1-->")).text, "- [ ] a mine <!--d:1-->\n> (agent's version) a theirs\n- [ ] agent new");
  check("merge: a reordered copy of a line keeps its anchor once", (await ML("- [ ] a <!--d:1-->\n- [ ] b <!--d:2-->", "- [ ] a <!--d:1-->\n- [ ] b <!--d:2-->", "- [ ] b <!--d:2-->\n- [ ] a <!--d:1-->\n- [ ] a copy <!--d:1-->")).text, "- [ ] b <!--d:2-->\n- [ ] a <!--d:1-->\n- [ ] a copy");
  check("merge: identical lines, the agent removed one, the person edits the other", (await ML("- [ ] t <!--d:1-->\n- [ ] t <!--d:2-->", "- [ ] t <!--d:2-->", "- [ ] t <!--d:1-->\n- [ ] t edited <!--d:2-->")).text, "- [ ] t edited <!--d:2-->");
  check("merge: identical unanchored lines the agent filed and ticked", (await ML("- [ ] t\n- [ ] t", "- [ ] t <!--d:7-->\n- [x] t <!--d:8-->", "- [ ] t\n- [ ] t\nmore")).text, "- [ ] t <!--d:7-->\n- [x] t <!--d:8-->\nmore");
  check("merge: a line the agent deleted and the person did not touch stays deleted", (await ML("- [ ] a <!--d:1-->\n- [ ] b <!--d:2-->\n- [ ] c <!--d:3-->", "- [ ] a <!--d:1-->\n- [ ] c <!--d:3-->", "- [ ] a edited <!--d:1-->\n- [ ] b <!--d:2-->\n- [ ] c <!--d:3-->")).text, "- [ ] a edited <!--d:1-->\n- [ ] c <!--d:3-->");
  check("merge: a line the person deleted but the agent ticked is kept", (await ML("- [ ] a <!--d:1-->\n- [ ] b <!--d:2-->", "- [ ] a <!--d:1-->\n- [x] b <!--d:2-->", "- [ ] a <!--d:1-->")).text, "- [ ] a <!--d:1-->\n- [x] b <!--d:2-->");
  check("merge: prose above a renamed new task, with its anchor carried", (await ML("- [ ] a <!--d:1-->\n- [ ] g", "- [ ] a <!--d:1-->\n- [ ] g <!--d:9-->", "- [ ] a <!--d:1-->\nsome prose\n- [ ] g ray")).text, "- [ ] a <!--d:1-->\nsome prose\n- [ ] g ray <!--d:9-->");
  check("merge: the same new line added on both sides is kept once", (await ML("a", "a\nsame", "a\nsame")).text, "a\nsame");
  check("merge: a new line both added, beside other new lines", (await ML("a", "a\nsame\nagent", "a\nsame\nmine")).text, "a\nsame\nagent\nmine");
  check("merge: CRLF and LF read as the same lines", (await ML("- [ ] a\r\n- [ ] b", "- [ ] a <!--d:1-->\r\n- [ ] b <!--d:2-->", "- [ ] a\r\n- [ ] b changed")).text, "- [ ] a <!--d:1-->\n- [ ] b changed <!--d:2-->");
  {
    const big = Array.from({ length: 2000 }, (_, i) => `- [ ] t${i} <!--d:${i + 1}-->`);
    const t0 = Date.now();
    await ML(big.join("\n"), big.slice().reverse().join("\n"), big.map((l, i) => (i % 50 === 0 ? l.replace(" <!--", " edited <!--") : l)).join("\n"));
    check("merge: 2,000 lines reversed by an agent while 40 are edited, well under a second", Date.now() - t0 < 1000, true);
  }
  check("reconcile: untouched and unmoved writes nothing", await js(`DelphiDrawer.reconcile("a", "a", "a")`), "none");
  check("reconcile: untouched and moved takes theirs", await js(`DelphiDrawer.reconcile("a", "b", "a")`), "take");
  check("reconcile: typed and unmoved writes", await js(`DelphiDrawer.reconcile("a", "a", "c")`), "write");
  check("reconcile: typed and moved asks", await js(`DelphiDrawer.reconcile("a", "b", "c")`), "conflict");
  check("reconcile: moved to what was typed is done", await js(`DelphiDrawer.reconcile("a", "c", "c")`), "same");
  const day = 86400000;
  const at = (ms) => new Date(Date.now() - ms).toISOString().replace("T", " ").slice(0, 19);
  const S = (status, ms) => js(`DelphiDrawer.stuck({ task: { id: 1, status: ${JSON.stringify(status)}, updated_at: ${JSON.stringify(at(ms))} }, events: [], comments: [] })`);
  check("to do is never stuck", await S("todo", 30 * day), null);
  check("doing for 2 days is not", await S("doing", 2 * day), null);
  check("doing for 4 days is amber", await S("doing", 4 * day).then((s) => [s.level, s.words]), ["amber", "No movement in 4 days"]);
  check("doing for 8 days is red", await S("doing", 8 * day).then((s) => s.level), "red");
  check("blocked stays amber", await S("blocked", 20 * day).then((s) => s.level), "amber");
  check("a note mentioning the task is related", await js(`DelphiDrawer.related({ id: 5, detail: "" }, { id: 2, title: "x", body: "see #5." })`), "Mentions #5");
  check("but not one mentioning #55", await js(`DelphiDrawer.related({ id: 5, detail: "" }, { id: 2, title: "x", body: "see #55." })`), null);
  check("a note named in the description", await js(`DelphiDrawer.related({ id: 5, detail: "read note 2" }, { id: 2, title: "x", body: "" })`), "Named in the description");
  check("subtasks keep a dragged order, new ones last", await js(`DelphiDrawer.ordered([{ id: 1 }, { id: 2 }, { id: 3 }], [3, 1]).map((s) => s.id)`), [3, 1, 2]);

  console.log(`\n${checks - failures}/${checks} passed`);
}

main()
  .catch((error) => { failures++; console.error(error); })
  .finally(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    app.exit(failures ? 1 : 0);
  });
