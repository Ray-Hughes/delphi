#!/usr/bin/env node
// test-runtime: electron
//
// Projects and sessions, driven in the real renderer with no window on screen.
//
//   electron tools/sidebar_test.js
//
// Direction B moved both out of the sidebar: projects into the switcher at the
// top, and a project's AI sessions into the menu beside the Chat tab. The rules
// below did not move, so this drives them where they live now.
//
// Opening a project used to land on its chat, with a "+ New session" row right
// under the pointer that had just clicked, and a person found a session they
// never meant to make and no way to remove it. The rule now is that opening a
// project never makes a session: only "+ New AI session" or a first message
// does. That rule lives in the renderer, so it is checked there, by clicking
// the row the way a person does and counting the rows in the database.
//
// main.js is loaded for real against a temp data folder. The window is made
// hidden, the hotkey and the tray are stubbed, and on macOS the app never
// becomes active, so the test takes no focus and no key.

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-sidebar-")));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
delete process.env.DELPHI_DB_ID;
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}
// No vault: its default folder is outside the temp directory.
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
  constructor(options = {}) { super({ ...options, show: false, paintWhenInitiallyHidden: true }); win = this; }
  // main.js loads the page relative to the app, which here is this file's folder.
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

const db = require("../db");
const project = db.createProject({ key: "sb", name: "Sidebar", path: dir });
const other = db.createProject({ key: "sb2", name: "Another" });
require("../main.js");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sessions = (id) => db.listSessions(id).length;

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
  // Only inside an open popover: the sidebar's old rows must not be what is found.
  const click = (row) => js(`(() => { const n = document.querySelector('.pop [data-row="${row}"]'); if (!n) return false; n.click(); return true; })()`);
  // A project, picked in the switcher the way a person does.
  const pick = (id) => js(`(() => { DelphiTopbar.openSwitcher(); const n = document.querySelector('.switcher [data-pick="${id}"]'); if (!n) return false; n.click(); return true; })()`);
  const openSessions = () => js(`(() => { const b = document.querySelector('.sessions-btn'); if (!b) return false; if (!document.querySelector('.sessions-pop')) b.click(); return true; })()`);
  await until(`!!document.querySelector('#switcher .scope')`);
  // Native dialogs would block a hidden window.
  await js("window.confirm = () => true; window.alert = () => {}; 0");

  console.log("\nopening a project makes no session");
  check("the project starts with none", sessions(project.id), 0);
  check("its row is in the switcher", await pick(project.id), true);
  await until(`state.projectId === ${project.id}`);
  await wait(500);
  check("it lands on the Overview, not the chat", await js("state.view"), "overview");
  check("and still has no session", sessions(project.id), 0);
  // Back and forth, and the keyboard, the ways a stray session used to appear.
  await pick(other.id);
  await until(`state.projectId === ${other.id}`);
  await js(`(() => { DelphiTopbar.openSwitcher(); const f = document.querySelector('.pop-find'); f.value = "Sidebar"; f.dispatchEvent(new Event("input")); f.focus(); return 1; })()`);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  await until(`state.projectId === ${project.id}`);
  await wait(500);
  check("opening it again by keyboard makes none either", [sessions(project.id), sessions(other.id)], [0, 0]);
  await js(`navigate({ view: "chat" })`);
  await wait(500);
  check("nor does opening its Chat tab", sessions(project.id), 0);
  check("the Chat tab has the sessions menu", await openSessions(), true);
  await until(`!!document.querySelector(".sessions-pop .gs-head")`);
  check("the sessions are labelled", await js(`document.querySelector(".sessions-pop .gs-head")?.textContent.startsWith("AI sessions")`), true);

  console.log("\nonly New AI session makes one");
  check("the row is there", await click("sess-new"), true);
  await until(`state.sessions.length === 1`);
  check("one session, and it is open", [sessions(project.id), await js("state.view")], [1, "chat"]);

  console.log("\nremoving a session");
  const made = db.listSessions(project.id)[0];
  db.sqlP(`INSERT INTO audit (action, entity, entity_id, summary, label) VALUES ('update', 'task', 1, 'status to done (by claude-code:${made.id}0)', 'x')`);
  check("another session's rows are not counted", await js(`window.delphi.sessions.changes(${made.id})`), 0);
  const kept = db.createSession({ projectId: project.id, harness: "claude-code", title: "Did things" });
  db.sqlP(`INSERT INTO audit (action, entity, entity_id, summary, label) VALUES ('update', 'task', 1, 'status to done (by claude-code:${kept.id})', 'x')`);
  check("a session with recorded changes cannot be deleted",
    await js(`window.delphi.sessions.remove(${kept.id}).then(() => "deleted", () => "refused")`), "refused");
  check("but can be archived", (await js(`window.delphi.sessions.archive(${kept.id})`)).status, "archived");
  check("and an archived one leaves the list", db.listSessions(project.id).map((s) => s.id), [made.id]);
  check("one that changed nothing can be deleted", await js(`window.delphi.sessions.remove(${made.id}).then(() => "deleted", (e) => e.message)`), "deleted");

  console.log("\nbringing an archived session back");
  await js(`refresh()`);
  await until(`!!document.querySelector('.sessions-btn')`);
  await openSessions();
  await until(`!!document.querySelector('.pop [data-row="sess-archived"]')`);
  check("the list offers its archive", await js(`document.querySelector('.pop [data-row="sess-archived"]').textContent`), "Show archived (1)");
  await js(`document.querySelector('.pop [data-row="sess-archived"]').focus()`);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  await until(`!!document.querySelector('.pop [data-row="arch-${kept.id}"]')`);
  check("Enter unfolds it, with Restore on the row",
    await js(`!!document.querySelector('.pop [data-row="arch-${kept.id}"] button[data-act="restore-${kept.id}"]')`), true);
  await js(`document.querySelector('.pop [data-act="restore-${kept.id}"]').click()`);
  await until(`!!document.querySelector('.pop [data-row="sess-${kept.id}"]')`);
  check("Restore puts it back in the list", [db.getSession(kept.id).status, db.listSessions(project.id).map((s) => s.id)], ["active", [kept.id]]);
  check("with focus on it", await js(`document.activeElement?.dataset.row`), `sess-${kept.id}`);
  check("and the archive toggle goes when it is empty", await js(`!!document.querySelector('.pop [data-row="sess-archived"]')`), false);

  console.log("\nhide from Active");
  await js(`refresh()`);
  await wait(500);
  check("a project touched today is Active", await js(`sidebarGroups().groupOf({ id: ${other.id} })`), "active");
  await js(`setHidden(${other.id}, true)`);
  await until(`sidebarGroups().groupOf({ id: ${other.id} }) === "rest"`);
  check("hidden, it moves to More projects", await js(`sidebarGroups().groupOf({ id: ${other.id} })`), "rest");
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).hiddenFromActive;
  check("the setting is kept", saved.map((h) => h.id), [other.id]);
  // Touched after the hide: a second later, because stamps are to the second.
  await wait(1100);
  db.createTask({ projectId: other.id, title: "something new" });
  await js(`refresh()`);
  await until(`sidebarGroups().groupOf({ id: ${other.id} }) === "active"`);
  check("touched after the hide, it is Active again", await js(`sidebarGroups().groupOf({ id: ${other.id} })`), "active");

  console.log(`\n${checks - failures}/${checks} passed`);
}

main()
  .catch((error) => { failures++; console.error(error); })
  .finally(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    app.exit(failures ? 1 : 0);
  });
