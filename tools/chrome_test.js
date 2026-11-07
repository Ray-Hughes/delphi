#!/usr/bin/env node
// test-runtime: electron
//
// The window's chrome and the Escape key, in the real renderer with a hidden
// window.
//
//   electron tools/chrome_test.js
//
// The chrome: macOS draws the traffic lights where main.js pins them, and the
// top row has to be level with them and start after them, and move down out of
// the menu bar's strip in full screen. Every layer that starts at the top of
// the window (the bar, Settings, the weekly review, a dialog, Focus) has to
// keep clear of them too, and fit a 900 by 600 window without running off it.
//
// Escape: one press closes one layer, innermost first, and with nothing left
// open it does nothing. It used to hide the window, so a few presses too many
// made the app vanish. Twenty presses from every screen must leave it where it
// was. main.js is loaded for real against a temp data folder; the hotkey and
// tray are stubbed, and the app never becomes active, so the test takes no
// focus and no key.

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-chrome-")));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
delete process.env.DELPHI_DB_ID;
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}
fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ vaultEnabled: false, panelMode: false }));

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

// Anything that takes the window away is counted here, whoever asked for it.
const gone = [];
let win = null;
let options = null;
class HiddenWindow extends electron.BrowserWindow {
  constructor(o = {}) { options = o; super({ ...o, show: false, paintWhenInitiallyHidden: true, width: 1200, height: 800 }); win = this; }
  loadFile(file, o) { return super.loadFile(path.resolve(ROOT, file), o); }
  show() {}
  focus() {}
  // As a person has it: on screen, so main.js's hide() would really hide it.
  isVisible() { return true; }
  hide() { gone.push("hide"); }
  minimize() { gone.push("minimize"); }
  close() { gone.push("close"); }
  setFullScreen(on) { gone.push(`fullscreen:${on}`); }
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
const project = db.createProject({ key: "ch", name: "Chrome test", path: dir });
const first = db.createTask({ projectId: project.id, title: "Retry failed uploads", priority: "high" });
for (let i = 0; i < 40; i++) db.createTask({ projectId: project.id, title: `Upload backlog item ${i + 1}` });
require("../main.js");
electron.ipcMain.on("hide", () => gone.push("ipc:hide"));
const realQuit = app.quit.bind(app);
app.quit = () => gone.push("quit");
const realHide = app.hide && app.hide.bind(app);
app.hide = () => gone.push("app:hide");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const esc = async () => { win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" }); await wait(120); };
  const rect = (sel) => js(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const b = n.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), h: Math.round(b.height) }; })()`);
  await until(`!!document.querySelector('#switcher .scope') && !!window.DelphiFocus && document.body.classList.length > 0`);
  await js("window.confirm = () => true; window.alert = () => {}; document.documentElement.setAttribute('data-motion', 'off'); window.delphi.recovery && window.delphi.recovery.dismiss && window.delphi.recovery.dismiss(); 0");
  const mac = process.platform === "darwin";

  console.log("\nthe traffic lights and the top row");
  if (mac) {
    const lights = options.trafficLightPosition;
    check("main.js pins the traffic lights", Boolean(lights && Number.isFinite(lights.x) && Number.isFinite(lights.y)), true);
    check("and the page knows it is a Mac window", await js(`document.body.classList.contains("mac")`), true);
    const row = await rect(".top-row");
    // 14px buttons, 23px apart: the middle of them is y + 7, the third ends at x + 60.
    check("the row's middle is the lights' middle", row.t + row.h / 2, lights.y + 7);
    const home = await rect("#home-btn");
    check("the first control starts at least 8px after the third light", home.l >= lights.x + 60 + 8, true);
    check("nothing in the row is under the lights", await js(`[...document.querySelectorAll(".top-row > *:not(.grow)")].filter((n) => n.offsetParent).every((n) => n.getBoundingClientRect().left >= ${lights.x + 60})`), true);
  } else {
    console.log("  skip not macOS");
  }
  check("the row moves the window", await js(`getComputedStyle(document.querySelector(".top-row")).webkitAppRegion || getComputedStyle(document.querySelector(".top-row")).getPropertyValue("-webkit-app-region")`), "drag");
  check("and its controls do not", await js(`[...document.querySelectorAll(".top-row button, .top-row input")].filter((n) => n.offsetParent).every((n) => getComputedStyle(n.closest(".top-row > *") || n).getPropertyValue("-webkit-app-region") === "no-drag")`), true);

  console.log("\nfull screen");
  const before = await rect("#home-btn");
  win.emit("enter-full-screen");
  check("main tells the page", await until(`document.body.classList.contains("is-fullscreen")`, 3000), true);
  if (mac) {
    const row = await rect(".top-row");
    check("the row starts below the menu bar's strip", row.t >= 24, true);
    check("and drops the traffic lights' inset", (await rect("#home-btn")).l < before.l, true);
    await js(`Promise.resolve(DelphiDrawer.open(${first.id})).then(() => 1)`);
    await until(`!!document.querySelector(".dw.on")`);
    check("the drawer starts under the row, not over it", (await rect(".dw")).t >= row.b, true);
    await esc();
  }
  win.emit("leave-full-screen");
  check("and when it leaves", await until(`!document.body.classList.contains("is-fullscreen")`, 3000), true);
  check("the row is back where it was", await rect("#home-btn"), before);

  console.log("\na small window");
  win.setContentSize(900, 600);
  check("the window really is 900 by 600", await until("innerHeight === 600 && innerWidth === 900", 3000), true);
  const inside = (r) => Boolean(r) && r.t >= 0 && r.l >= 0 && r.b <= 600 && r.r <= 900;
  const clear = (r) => !mac || r.t >= 31 || r.l >= 76;   // below or right of the lights
  await js(`navigate({ projectId: null, view: "today", query: "" }).then(() => 1)`);
  await js("openBar('')");
  await until(`!!document.querySelector(".cmdk")`);
  const bar = await rect(".cmdk");
  check("Cmd+K fits the window", inside(bar), true);
  check("its field is on screen", inside(await rect(".cmdk .pal-input")), true);
  check("its list scrolls inside it", await js(`(() => { const l = document.querySelector(".cmdk .pal-list"); return l.scrollHeight > l.clientHeight && getComputedStyle(l).overflowY === "auto"; })()`), true);
  await esc();
  check("Escape closes it", await js(`!document.querySelector(".cmdk")`), true);

  const layers = [
    ["the switcher", "DelphiTopbar.openSwitcher(), 1", ".switcher"],
    ["Settings", "DelphiSettingsPanel.open(), 1", ".sp"],
    ["the weekly review", "Promise.resolve(DelphiWeekly.open()).then(() => 1)", ".wk"],
    ["the PR description", `(() => { const ed = DelphiReport.editor("Retry.\\n\\n".repeat(60), { title: "Retry failed uploads" }); wbDialog({ title: "PR description", body: [ed.node || ed], className: "rp-dialog", actions: [{ label: "Cancel", value: null }, { label: "Open PR", value: 1, primary: true }] }); return 1; })()`, ".rp-dialog"],
  ];
  for (const [name, open, sel] of layers) {
    await js(open);
    await until(`!!document.querySelector(${JSON.stringify(sel)})`);
    await wait(200);
    const r = await rect(sel);
    check(`${name} fits the window and clears the lights`, [inside(r), clear(r)], [true, true]);
    if (sel === ".rp-dialog") {
      check("its buttons are on screen", await js(`(() => { const b = [...document.querySelectorAll(".rp-dialog button")].find((x) => x.textContent === "Open PR"); const r = b.getBoundingClientRect(); return r.bottom <= 600 && r.top >= 0; })()`), true);
    }
    await esc();
    check(`Escape closes ${name}`, await js(`!document.querySelector(${JSON.stringify(sel)})`), true);
  }
  await js(`Promise.resolve(DelphiFocus.enter(${first.id})).then(() => 1)`);
  await until(`DelphiFocus.isOpen()`);
  const brand = await rect(".fx-top > *");
  check("Focus's first control clears the lights", clear(brand), true);
  // Within a pixel: the brand's own height is odd, and the lights' middle is not.
  if (mac) check("and is level with them", Math.abs(brand.t + brand.h / 2 - (options.trafficLightPosition.y + 7)) <= 1, true);
  await esc();
  check("Escape leaves Focus", await until(`!DelphiFocus.isOpen()`, 3000), true);

  console.log("\nEscape, twenty times, from every screen");
  const screens = [
    ["Today", `navigate({ projectId: null, view: "today", query: "" }).then(() => 1)`],
    ["Tasks", `navigate({ projectId: ${project.id}, view: "tasks", query: "" }).then(() => 1)`],
    ["Memory", `navigate({ projectId: ${project.id}, view: "notes", query: "" }).then(() => 1)`],
    ["Runs", `navigate({ projectId: null, view: "runs", query: "" }).then(() => 1)`],
    ["Cmd+K", "openBar('upload'), 1"],
    ["the switcher", "DelphiTopbar.openSwitcher(), 1"],
    ["the drawer", `Promise.resolve(DelphiDrawer.open(${first.id})).then(() => 1)`],
    ["a dialog over the drawer", `Promise.resolve(DelphiDrawer.open(${first.id})).then(() => (wbDialog({ title: "Sure?", actions: [{ label: "Cancel", value: null }] }), 1))`],
    ["Settings", "DelphiSettingsPanel.open(), 1"],
    ["the weekly review", "Promise.resolve(DelphiWeekly.open()).then(() => 1)"],
    ["a dialog", `(wbDialog({ title: "Sure?", actions: [{ label: "Cancel", value: null }, { label: "Yes", value: 1, primary: true }] }), 1)`],
    ["Focus", `Promise.resolve(DelphiFocus.enter(${first.id})).then(() => 1)`],
  ];
  const open = () => js(`[!!document.querySelector(".cmdk"), !!document.querySelector(".pop"), !!document.querySelector(".dw.on"), !!document.querySelector(".sp"), !!document.querySelector(".wk"), !!document.querySelector(".overlay"), DelphiFocus.isOpen()].filter(Boolean).length`);
  for (const [name, how] of screens) {
    await js(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); 0`);
    await js(how);
    await wait(500);
    gone.length = 0;
    for (let i = 0; i < 20; i++) await esc();
    await wait(200);
    check(`from ${name}: the window stays, and nothing is left open`, [gone, await open()], [[], 0]);
  }

  console.log("\none layer at a time");
  await js(`Promise.resolve(DelphiDrawer.open(${first.id})).then(() => (wbDialog({ title: "Sure?", actions: [{ label: "Cancel", value: null }] }), 1))`);
  check("a dialog over the drawer", await until(`!!document.querySelector(".wb-dialog") && !!document.querySelector(".dw.on")`), true);
  await esc();
  check("the first Escape closes the dialog and leaves the drawer", await js(`[!!document.querySelector(".wb-dialog"), !!document.querySelector(".dw.on")]`), [false, true]);
  await esc();
  check("the second closes the drawer", await js(`!!document.querySelector(".dw.on")`), false);

  console.log("\na panel");
  // Panel mode for real: the setting rebuilds the window, so the options and
  // the page below are the panel's own. It has the same traffic lights, so it
  // needs the same room, and Escape never puts it away either; its hotkey,
  // the tray and a click elsewhere do.
  const windowWas = win;
  await js(`window.delphi.settings.set({ panelMode: true }).then(() => 1)`);
  for (let i = 0; i < 100 && win === windowWas; i++) await wait(100);
  check("the setting makes a new window", win !== windowWas, true);
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));
  await until(`document.body.classList.contains("panel") && !!document.querySelector('#switcher .scope')`);
  await js("window.confirm = () => true; window.alert = () => {}; document.documentElement.setAttribute('data-motion', 'off'); 0");
  check("and the page knows it is a panel", await js(`document.body.classList.contains("panel")`), true);
  if (mac) {
    const lights = options.trafficLightPosition;
    check("a panel's traffic lights are pinned too", Boolean(lights && lights.x === 16 && lights.y === 17), true);
    const row = await rect(".top-row");
    check("its row is level with them", row.t + row.h / 2, lights.y + 7);
    check("and starts after them", (await rect("#home-btn")).l >= lights.x + 60 + 8, true);
    await js(`Promise.resolve(DelphiFocus.enter(${first.id})).then(() => 1)`);
    await until(`DelphiFocus.isOpen()`);
    check("Focus in a panel clears them too", clear(await rect(".fx-top > *")), true);
    await js("DelphiFocus.exit(), 1");
    check("and leaves", await until(`!DelphiFocus.isOpen()`, 3000), true);
  }
  for (const [name, how] of [["the page", `navigate({ projectId: null, view: "today", query: "" }).then(() => 1)`], ["Focus", `Promise.resolve(DelphiFocus.enter(${first.id})).then(() => 1)`], ["Cmd+K", "openBar('upload'), 1"]]) {
    await js(how);
    await wait(400);
    gone.length = 0;
    for (let i = 0; i < 20; i++) await esc();
    await wait(200);
    check(`twenty Escapes in a panel, from ${name}: it stays, and nothing is left open`, [gone, await open()], [[], 0]);
  }

  console.log(`\n${checks - failures}/${checks} passed`);
}

main()
  .catch((error) => { failures++; console.error(error); })
  .finally(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    app.quit = realQuit;
    if (realHide) app.hide = realHide;
    app.exit(failures ? 1 : 0);
  });
