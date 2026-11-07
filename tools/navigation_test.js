#!/usr/bin/env node
// test-runtime: electron
//
// Getting home, and getting back: the shell's navigation, in the real
// renderer.
//
//   electron tools/navigation_test.js
//
// The owner: "if I start clicking into things it's hard to get back to this
// really nice home/dashboard page." So, checked here against main.js loaded
// for real with a hidden window that never takes focus (as in
// tools/drawer_test.js):
//
// - the Home control at the top left, on every page, lit on Home, and one
//   click back to Today across every project;
// - G then H goes Home, and no other G letter clashes with it or with Focus's;
// - Back and Forward over views and drawer opens, by Cmd+[ and Cmd+], the
//   buttons in the head, and the mouse's back and forward buttons;
// - Escape from the drawer goes back to exactly where you were: the page, its
//   scroll, the row the keyboard was on, and the focus;
// - the breadcrumb on every page but Home;
// - and the slice's own surfaces: a project's Folders list with Home marked,
//   the "Filed under" chip, and the drawer's folder picker.

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-nav-")));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
delete process.env.DELPHI_DB_ID;
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}
fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ vaultEnabled: false, taskOpenMode: "drawer" }));

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  } else console.log(`  ok   ${what}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

const repo = (name) => {
  const p = path.join(dir, "code", name);
  fs.mkdirSync(p, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: p });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: p });
  return p;
};
const db = require("../db");
const caseflow = repo("caseflow");
const efolder = repo("caseflow-efolder");
const ssnr = db.createProject({ key: "ssnr", name: "SSNR", path: caseflow });
const co = db.createProject({ key: "co", name: "Central Office (APREQ-987)", path: caseflow });
db.linkFolder(ssnr.id, efolder);
const tasks = [];
for (let i = 0; i < 60; i++) tasks.push(db.createTask({ projectId: ssnr.id, title: `Task number ${i}` }));
const routed = db.createTask({ projectId: co.id, title: "Filed by an agent" });
db.sqlP("INSERT INTO filed_routes (entity, entity_id, project_id, folder, via, detail) VALUES ('task', :p1, :p2, :p3, 'branch', '{}')", [routed.id, co.id, caseflow]);
const routedNote = db.createNote({ projectId: co.id, title: "A note an agent filed", body: "b" });
const routedPad = db.createScratchpad({ projectId: co.id, key: "agent-plan", title: "An agent's plan", body: "- one" });
for (const [e, id] of [["note", routedNote.id], ["scratchpad", routedPad.id]]) {
  db.sqlP("INSERT INTO filed_routes (entity, entity_id, project_id, folder, via, detail) VALUES (:p1, :p2, :p3, :p4, 'recent', '{}')", [e, id, co.id, caseflow]);
}

require("../main.js");

async function main() {
  await app.whenReady();
  if (app.dock) app.dock.hide();
  for (let i = 0; i < 100 && !win; i++) await wait(100);
  if (!win) throw new Error("no window");
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const until = async (code, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) { if (await js(code).catch(() => false)) return true; await wait(100); }
    return false;
  };
  await until("typeof DelphiDrawer === 'object' && !!document.querySelector('#switcher .scope')");
  await js("window.confirm = () => true; window.alert = () => {}; localStorage.clear(); 0");
  const where = () => js("({ p: state.projectId, v: state.view, d: DelphiDrawer.openTask() })");
  const key = (k, extra = {}) => js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, ...${JSON.stringify(extra)} })); 1`);
  const mod = process.platform === "darwin" ? { metaKey: true } : { ctrlKey: true };

  console.log("\nHome");
  await js(`navigate({ projectId: ${ssnr.id}, view: "tasks", query: "" }).then(() => 1)`);
  await wait(300);
  check("the Home control is at the top left, before the switcher",
    await js("(() => { const b = document.getElementById('home-btn'); const s = document.getElementById('switcher'); return [!!b, b.textContent.trim(), !!(b.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING)]; })()"), [true, "Home", true]);
  check("not lit away from Home", await js("document.getElementById('home-btn').classList.contains('on')"), false);
  await js("document.getElementById('home-btn').click(); 1");
  await until("state.view === 'today'");
  await wait(400);
  check("one click goes Home: Today, every project", await where(), { p: null, v: "today", d: null });
  check("lit there, as the current page", await js("[document.getElementById('home-btn').classList.contains('on'), document.getElementById('home-btn').getAttribute('aria-current')]"), [true, "page"]);
  check("no breadcrumb on Home", await js("document.getElementById('crumbs').hidden"), true);

  console.log("\nG then H");
  await js(`navigate({ projectId: ${ssnr.id}, view: "project", query: "" }).then(() => 1)`);
  await wait(300);
  await js("document.activeElement && document.activeElement.blur(); 1");
  await key("g");
  await key("h");
  await until("state.view === 'today'");
  check("G then H goes Home", await where(), { p: null, v: "today", d: null });
  const chords = await js("DelphiCommands.make({ state: () => state, themeIs: () => 'light' }).filter((c) => c.chord).map((c) => c.chord)");
  check("every G letter is one command's", chords.length, new Set(chords).size);
  check("H is Home's (Today)", await js("DelphiCommands.chord(DelphiCommands.make({ state: () => state, themeIs: () => 'light' }), 'h').id"), "go-today");
  check("Focus's letter is not a G letter", chords.includes(String((await js("(state.settings && state.settings.focusLetter) || 'f'")) || "f").toLowerCase()), false);

  console.log("\nBack and Forward");
  await js("state.history = []; state.future = []; 1");
  await js(`navigate({ projectId: ${ssnr.id}, view: "tasks", query: "" }).then(() => 1)`);
  await wait(300);
  await js(`navigate({ projectId: ${ssnr.id}, view: "project", query: "" }).then(() => 1)`);
  await wait(300);
  await key("[", mod);
  await until("state.view === 'tasks'");
  await wait(400);
  check("Cmd+[ goes back a view", await where(), { p: ssnr.id, v: "tasks", d: null });
  check("and the Forward button appears", await js("document.getElementById('fwd').hidden"), false);
  await key("]", mod);
  await until("state.view === 'project'");
  await wait(400);
  check("Cmd+] goes forward again", await where(), { p: ssnr.id, v: "project", d: null });
  await js("window.dispatchEvent(new MouseEvent('mouseup', { button: 3, bubbles: true })); 1");
  await until("state.view === 'tasks'");
  await wait(400);
  check("the mouse's back button", (await where()).v, "tasks");
  await js("window.dispatchEvent(new MouseEvent('mouseup', { button: 4, bubbles: true })); 1");
  await until("state.view === 'project'");
  await wait(400);
  check("and its forward button", (await where()).v, "project");
  await js("document.getElementById('back').click(); 1");
  await until("state.view === 'tasks'");
  check("the Back button in the head", (await where()).v, "tasks");

  console.log("\na drawer is a stop");
  await wait(300);
  const target = tasks[40].id;
  await js(`openTaskSheet(${target}).then(() => 1)`);
  await until(`DelphiDrawer.openTask() === ${target}`);
  check("opening a task is remembered", await js("state.history.length > 0 && state.future.length === 0"), true);
  await key("[", mod);
  await until("DelphiDrawer.openTask() === null");
  check("Back from a drawer closes it and stays on the page", await where(), { p: ssnr.id, v: "tasks", d: null });
  await key("]", mod);
  await until(`DelphiDrawer.openTask() === ${target}`);
  check("Forward opens it again", await where(), { p: ssnr.id, v: "tasks", d: target });
  await js("DelphiDrawer.close(); 1");
  await until("DelphiDrawer.openTask() === null");

  console.log("\nEscape from the drawer goes back to exactly where you were");
  await wait(300);
  const row = tasks[45].id;
  const before = await js(`(() => {
    const c = document.getElementById('content');
    const r = document.querySelector('#content [data-task-id="${row}"]');
    r.scrollIntoView({ block: 'center' });
    for (const n of document.querySelectorAll('.kbd-hi')) n.classList.remove('kbd-hi');
    r.classList.add('kbd-hi');
    r.focus();
    return c.scrollTop;
  })()`);
  check("the page is scrolled down to start with", before > 200, true);
  await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); 1");
  await until(`DelphiDrawer.openTask() === ${row}`);
  // A repaint under the drawer replaces the page, at the top.
  await js("(() => { const c = document.getElementById('content'); c.replaceWith(c.cloneNode(true)); return 1; })()");
  await js("(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1");
  await until("DelphiDrawer.openTask() === null");
  await wait(400);
  const after = await js(`(() => ({
    scroll: document.getElementById('content').scrollTop,
    lit: (document.querySelector('#content .kbd-hi') || {}).dataset ? document.querySelector('#content .kbd-hi').dataset.taskId : null,
    focus: document.activeElement && document.activeElement.closest('[data-task-id]') ? document.activeElement.closest('[data-task-id]').dataset.taskId : null,
  }))()`);
  check("the same scroll", Math.abs(after.scroll - before) < 2, true);
  check("the same row lit, and focused", [after.lit, after.focus], [String(row), String(row)]);
  check("and the same page", await where(), { p: ssnr.id, v: "tasks", d: null });
  // Scrolling done while the drawer was open is the reader's, and stays.
  await js(`openTaskSheet(${row}).then(() => 1)`);
  await until(`DelphiDrawer.openTask() === ${row}`);
  await js("document.getElementById('content').scrollTop = 40; 1");
  await js("(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1");
  await until("DelphiDrawer.openTask() === null");
  await wait(400);
  check("a page scrolled while the drawer was open stays where the reader put it", await js("document.getElementById('content').scrollTop"), 40);
  await js(`navigate({ projectId: ${ssnr.id}, view: "tasks", query: "" }).then(() => 1)`);

  console.log("\nthe breadcrumb");
  const crumbs = () => js("(() => { const b = document.getElementById('crumbs'); return b.hidden ? null : [...b.querySelectorAll('.crumb, .crumb-now')].map((n) => n.textContent); })()");
  check("a project's tasks: Home, the project, Tasks", await crumbs(), ["Home", "SSNR", "Tasks"]);
  await js(`navigate({ projectId: ${ssnr.id}, view: "project", query: "" }).then(() => 1)`);
  await wait(300);
  check("its settings", await crumbs(), ["Home", "SSNR", "Settings"]);
  await js(`navigate({ projectId: null, view: "runs", query: "" }).then(() => 1)`);
  await wait(300);
  check("Runs", await crumbs(), ["Home", "Runs"]);
  await js("document.querySelector('#crumbs .crumb').click(); 1");
  await until("state.view === 'today'");
  check("its Home crumb goes Home", await where(), { p: null, v: "today", d: null });

  console.log("\nFolders, the chip and the picker");
  await js(`navigate({ projectId: ${ssnr.id}, view: "project", query: "" }).then(() => 1)`);
  await until("document.querySelectorAll('#project-folder .fl-row').length === 2");
  check("SSNR's Settings list two folders, Home first, and who shares the Home",
    await js("[...document.querySelectorAll('#project-folder .fl-row')].map((r) => [r.querySelector('.kind').textContent, r.querySelector('.fl-name').textContent, (r.querySelector('.fl-also') || {}).textContent || null])"),
    [["Home", "caseflow", "Also Central Office (APREQ-987)"], ["Linked", "caseflow-efolder", null]]);
  check("a linked folder can be made Home or taken off; Home cannot be taken off",
    await js("[...document.querySelectorAll('#project-folder .fl-row')].map((r) => [...r.querySelectorAll('.repo-acts button')].map((b) => b.textContent).filter((t) => t !== 'Workbench settings'))"),
    [[], ["Make Home", "Remove"]]);
  await js(`navigate({ projectId: ${co.id}, view: "tasks", query: "" }).then(() => 1)`);
  await until(`!!document.querySelector('#content [data-route="task:${routed.id}"]')`);
  check("the Filed under chip on the routed task", await js(`document.querySelector('#content [data-route="task:${routed.id}"]').textContent`), "Filed under Central Office (APREQ-987), from branch");
  await js(`document.querySelector('#content [data-route="task:${routed.id}"]').click(); 1`);
  await wait(200);
  check("with a Move to the other project in the folder", await js("[...document.querySelectorAll('.ctx .ctx-item')].map((n) => n.textContent)"), ["Move to SSNR", "That's right, keep it in Central Office (APREQ-987)"]);
  await js("closeRowMenu(); 1");
  await js(`openTaskSheet(${tasks[0].id}).then(() => 1)`);
  await until(`DelphiDrawer.openTask() === ${tasks[0].id}`);
  await js("(() => { const f = document.querySelector('.dw [data-fold=workbench]'); if (!f.classList.contains('open')) f.querySelector('.dw-fold-h').click(); return 1; })()");
  await until("!!document.querySelector('.dw .wb-folder-pick')");
  check("the drawer's folder picker, for a project with two folders",
    await js("[...document.querySelectorAll('.dw .wb-folder-pick option')].map((o) => o.textContent)"), ["caseflow (Home)", "caseflow-efolder"]);
  await js("(() => { const s = document.querySelector('.dw .wb-folder-pick'); s.value = s.options[1].value; s.dispatchEvent(new Event('change')); return 1; })()");
  await wait(500);
  check("choosing one writes the task's folder", db.sqlP("SELECT r.path FROM tasks t JOIN repos r ON r.id = t.repo_id WHERE t.id = :p1", [tasks[0].id])[0].path, efolder);
  await js("DelphiDrawer.close(); 1");
  await js(`openTaskSheet(${routed.id}).then(() => 1)`);
  await until(`DelphiDrawer.openTask() === ${routed.id}`);
  await js("(() => { const f = document.querySelector('.dw [data-fold=workbench]'); if (!f.classList.contains('open')) f.querySelector('.dw-fold-h').click(); return 1; })()");
  await wait(600);
  check("no picker for a project with one folder", await js("!!document.querySelector('.dw .wb-folder-pick')"), false);
  check("the chip under the drawer's title too", await js(`!!document.querySelector('.dw .dw-route [data-route="task:${routed.id}"]')`), true);
  await js("DelphiDrawer.close(); 1");
  await js(`DelphiDrawer.openNote(${JSON.stringify(routedNote)}); 1`);
  await until(`!!document.querySelector('.dw [data-route="note:${routedNote.id}"]')`);
  check("a guessed note says so in its drawer", await js(`document.querySelector('.dw [data-route="note:${routedNote.id}"]').textContent`), "Filed under Central Office (APREQ-987), most recent in this folder");
  await js("DelphiDrawer.close(); 1");
  await js(`DelphiDrawer.openPad(${routedPad.id}); 1`);
  await until(`!!document.querySelector('.dw [data-route="scratchpad:${routedPad.id}"]')`);
  check("and a guessed pad in its", await js(`!!document.querySelector('.dw [data-route="scratchpad:${routedPad.id}"]')`), true);
  await js("DelphiDrawer.close(); 1");
  await js(`navigate({ projectId: ${co.id}, view: "memory", query: "" }).then(() => 1)`);
  await until(`!!document.querySelector('#content [data-route="note:${routedNote.id}"]')`);
  check("Memory's row says so, as words inside the row's own button", await js(`document.querySelector('#content [data-route="note:${routedNote.id}"]').tagName`), "SPAN");
  {
    await js(`(state.padId = ${routedPad.id}, navigate({ projectId: ${co.id}, view: "pads", query: "" })).then(() => 1)`);
    check("and the Pads tab", await until(`!!document.querySelector('#content [data-route="scratchpad:${routedPad.id}"]')`), true);
  }

  console.log(`\n${checks - failures}/${checks} passed`);
}

main()
  .catch((error) => { failures++; console.error(error); })
  .finally(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    app.exit(failures ? 1 : 0);
  });
