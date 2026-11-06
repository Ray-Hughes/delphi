#!/usr/bin/env node
// test-runtime: electron
//
// The floating Settings panel, driven in the real renderer with no window on
// screen, for what only shows there:
// - the focus stays on the control a person was using when its row grows a
//   Reset, and follows the choice when arrow keys move a radio group;
// - Enter in a number field saves it and keeps the focus there;
// - a stored value this version refuses says so, with Fix, and a segmented
//   control holding one can still be tabbed to;
// - at the window's 860px minimum the section list gives way to a menu,
//   never to nothing;
// - search finds the panel's own rows (backups, the API key), not only settings;
// - Tab while recording a shortcut keeps the focus inside the panel;
// - the default pad project is shown by name.
//
// main.js is loaded for real against a temp data folder, as in sidebar_test.js.

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-panel-")));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
delete process.env.DELPHI_DB_ID;
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}
// No vault (its folder is outside the temp directory), and two values an older
// version could have saved that this one refuses.
fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ vaultEnabled: false, theme: "dark", noteView: "sideways", snoozeMinutes: 99999 }));

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
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
  constructor(options = {}) { super({ ...options, show: false, paintWhenInitiallyHidden: true, width: 1320, height: 860 }); win = this; }
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
const pads = db.createProject({ key: "pads", name: "Where pads go" });
require("../main.js");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const file = () => JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));

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
  // A key press on whatever has the focus, as the page's own listeners see it.
  // (A hidden window takes no real key input.) Enter and Space on a button are
  // the button's click, which a synthetic event does not perform, so for those
  // the test clicks, as the browser would.
  const key = (k) => js(`(() => { const a = document.activeElement; const e = new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }); a.dispatchEvent(e); if (!e.defaultPrevented && ${k === "Enter" || k === " "} && a.tagName === "BUTTON") a.click(); return 1; })()`);
  const active = () => js(`(() => { const a = document.activeElement; const r = a && a.closest("[data-key], [data-row]"); return [r ? (r.dataset.key || r.dataset.row) : null, a ? (a.getAttribute("role") || a.tagName.toLowerCase()) : null, a ? (a.dataset.v || a.className) : null]; })()`);
  await until(`!!window.DelphiSettingsPanel && !!document.querySelector('#switcher .scope')`);
  await js("window.confirm = () => true; window.alert = () => {}; 0");
  const open = async (opts) => { await js(`DelphiSettingsPanel.close(), DelphiSettingsPanel.open(${JSON.stringify(opts)}).then(() => 1)`); await wait(600); };

  console.log("\nthe focus stays on the control");
  await open({ key: "animations" });
  check("Configure opens at the row, on its switch", await active(), ["animations", "switch", "sp-toggle"]);
  await key(" ");
  await until(`!!document.querySelector('[data-key="animations"] .sp-rst')`);
  await wait(200);
  check("turning it off saves", file().animations, false);
  check("and the row grows a Reset, but the focus stays on the switch", await active(), ["animations", "switch", "sp-toggle"]);
  check("Reset comes after the control, in the order Tab reaches them",
    await js(`(() => { const r = document.querySelector('[data-key="animations"]'); const all = [...r.querySelectorAll("button")]; return all.map((b) => b.classList.contains("sp-rst") ? "reset" : "control"); })()`), ["control", "reset"]);
  await open({ key: "density" });
  check("a radio group opens on its chosen value", await active(), ["density", "radio", "comfortable"]);
  await key("ArrowRight");
  await until(`document.documentElement.dataset.density === "spacious"`);
  await wait(200);
  check("the arrow saves the next choice, and the focus goes with it", [file().density, await active()], ["spacious", ["density", "radio", "spacious"]]);
  await js(`window.delphi.settings.set({ animations: true, density: "comfortable" }).then(() => 1)`);

  await open({ section: "data" });
  await js(`document.querySelector('[data-row="settings-file"] .sp-btn').focus()`);
  await js(`document.querySelector(".sp-nav [data-sec='data']").click()`);
  check("a row that is not a setting keeps its focus through a repaint", await js(`[document.activeElement.closest("[data-row]")?.dataset.row, document.querySelector(".sp").contains(document.activeElement)]`), ["settings-file", true]);

  console.log("\nEnter saves a field and keeps the focus");
  await open({ key: "jobTimeoutMinutes" });
  await js(`(() => { const i = document.querySelector('[data-key="jobTimeoutMinutes"] input'); i.focus(); i.value = "45"; return 1; })()`);
  await key("Enter");
  await until(`!!document.querySelector('[data-key="jobTimeoutMinutes"] .sp-rst')`);
  await wait(200);
  check("Enter saved it", file().jobTimeoutMinutes, 45);
  check("and the focus is still in that field", await active(), ["jobTimeoutMinutes", "input", ""]);

  console.log("\nvalues an older version saved");
  await open({ section: "memory" });
  check("a refused value says so, with Fix", await js(`!!document.querySelector('[data-key="noteView"] .warn .sp-btn')`), true);
  check("and its segmented control can still be tabbed to", await js(`[...document.querySelectorAll('[data-key="noteView"] [role="radio"]')].map((b) => b.tabIndex)`), [0, -1]);
  await open({ section: "focus" });
  await js(`document.querySelector('[data-key="snoozeMinutes"] .warn .sp-btn').click()`);
  await until(`!document.querySelector('[data-key="snoozeMinutes"] .warn')`);
  check("Fix saves the nearest value allowed", file().snoozeMinutes, 1440);

  console.log("\nthe default pad project, by name");
  await js(`window.delphi.settings.set({ scratchpadProjectId: ${pads.id} }).then(() => refresh()).then(() => 1)`);
  await open({ query: "@modified" });
  check("shown by name, not by id", await js(`[...document.querySelectorAll(".sp-res")].filter((n) => n.querySelector(".n").textContent === "Default project for pads").map((n) => n.querySelector(".val").textContent)`), ["Where pads go"]);

  console.log("\nsearch finds the panel's own rows");
  for (const [q, want] of [["backup", "Backups"], ["api key", "Anthropic API key"], ["trust", "Trust this command"], ["unguarded", "Allow unguarded runs"], ["import", "Export and import settings"], ["restore", "Backups"]]) {
    await open({ query: q });
    check(`"${q}" finds ${want}`, await js(`[...document.querySelectorAll(".sp-res .n")].some((n) => n.textContent === ${JSON.stringify(want)})`), true);
  }
  await open({ query: "backup" });
  await js(`document.querySelector(".sp-find input").focus()`);
  await key("Enter");
  await until(`!!document.querySelector('.sp-content [data-row="backups"]')`);
  check("Enter jumps to the backups in Data and backups", await js(`[document.querySelector(".sp-nav [aria-current='page']")?.dataset.sec, !!document.querySelector('[data-row="backups"].flash')]`), ["data", true]);
  check("and Cmd+K lists it", await js(`COMMANDS.some((c) => c.id === "settings-row-backups") && DelphiCommands.match(COMMANDS, "restore backup", state).some((c) => c.id === "settings-row-backups")`), true);

  console.log("\nat the window's narrowest");
  win.setSize(860, 640);
  await wait(400);
  await open({ section: "general" });
  check("the section list gives way to a menu, never to nothing",
    await js(`[getComputedStyle(document.querySelector(".sp-nav")).display, getComputedStyle(document.querySelector(".sp-navsel")).display === "none" ? "hidden" : "shown"]`), ["none", "shown"]);
  await js(`(() => { const s = document.querySelector(".sp-navsel select"); s.value = "privacy"; s.dispatchEvent(new Event("change")); return 1; })()`);
  await wait(200);
  check("the menu moves between sections", await js(`document.querySelector("#sp-sec-title").textContent`), "Privacy");
  check("and the foot says how", await js(`getComputedStyle(document.querySelector(".sp-foot .narrow")).display !== "none" && getComputedStyle(document.querySelector(".sp-foot .wide")).display === "none"`), true);
  win.setSize(1320, 860);
  await wait(300);

  console.log("\nTab while recording a shortcut");
  await open({ section: "shortcuts" });
  await js(`document.querySelector('[data-key="hotkey"] .sp-btn').click()`);
  await until(`!!document.querySelector(".sp-binding.rec")`);
  await js(`document.querySelector('[data-key="hotkey"] [data-fid="rec-cancel"]').focus()`);
  const prevented = await js(`(() => { const e = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }); document.activeElement.dispatchEvent(e); return e.defaultPrevented; })()`);
  check("Tab is kept by the panel's trap", prevented, true);
  check("it ends the recording, and the focus is still inside the panel", await js(`[!document.querySelector(".sp-binding.rec"), document.querySelector(".sp").contains(document.activeElement)]`), [true, true]);

  console.log(`\n${checks - failures}/${checks} passed`);
}

main()
  .catch((error) => { failures++; console.error(error); })
  .finally(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    app.exit(failures ? 1 : 0);
  });
