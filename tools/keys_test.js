#!/usr/bin/env node
// test-runtime: node
// The keyboard on each platform: Cmd on macOS, Ctrl elsewhere, never both.
//
//   node tools/keys_test.js
//
// ui/keys.js listens on the document, so this hands it a document that is a
// list of listeners and nothing else, fires keys at it, and records what the
// app was asked to do and whether the key was taken from the page. The point
// is the macOS text keys: Ctrl+K, Ctrl+P and Ctrl+F in a box are the box's
// own (kill line, up, forward), and a shortcut must never eat them.

const path = require("path");

let checks = 0;
let failures = 0;
function check(what, got, want) {
  checks++;
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log(`  ok   ${what}`); return; }
  failures++;
  console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
}
function section(name) { console.log(`\n${name}`); }

/** ui/core.js and ui/keys.js loaded fresh, as a window on this platform would. */
function load(platform) {
  const listeners = [];
  const body = { tagName: "BODY" };
  globalThis.window = { delphi: { platform } };
  globalThis.document = {
    body, activeElement: body,
    addEventListener: (type, fn) => { if (type === "keydown") listeners.push(fn); },
    querySelectorAll: () => [],
    querySelector: (sel) => (sel.includes("kbd-hi") ? globalThis.__litRow || null : null),
  };
  for (const f of ["core.js", "commands.js", "keys.js"]) delete require.cache[require.resolve(path.join(__dirname, "..", "ui", f))];
  // core.js is a classic script in the window: its consts are globals there.
  Object.assign(globalThis, require(path.join(__dirname, "..", "ui", "core.js")));
  require(path.join(__dirname, "..", "ui", "commands.js"));
  require(path.join(__dirname, "..", "ui", "keys.js"));
  const asked = [];
  globalThis.DelphiKeys.install({
    commands: () => [], busy: () => false,
    openBar: () => asked.push("bar"), openSwitcher: () => asked.push("switcher"), openTask: () => asked.push("task"),
  });
  const press = (key, { meta = false, ctrl = false, target = body } = {}) => {
    asked.length = 0;
    let prevented = false;
    const e = { key, metaKey: meta, ctrlKey: ctrl, shiftKey: false, altKey: false, isComposing: false, target,
      preventDefault: () => { prevented = true; }, stopPropagation: () => {} };
    for (const fn of listeners) fn(e);
    return { asked: asked.slice(), prevented };
  };
  return { press, core: globalThis };
}

const input = { tagName: "INPUT" };

section("macOS: Cmd, and only Cmd");
let k = load("darwin");
check("the labels are the Mac's", [k.core.modLabel(), k.core.shortcut("K")], ["⌘", "⌘K"]);
check("Cmd+K opens the bar", k.press("k", { meta: true }), { asked: ["bar"], prevented: true });
check("Cmd+P opens the switcher", k.press("p", { meta: true }), { asked: ["switcher"], prevented: true });
for (const key of ["k", "p", "f"]) {
  check(`Ctrl+${key.toUpperCase()} in a text box is left to the box`, k.press(key, { ctrl: true, target: input }), { asked: [], prevented: false });
}
check("Ctrl+K on the page is not K either", k.press("k", { ctrl: true }), { asked: [], prevented: false });
check("Cmd+Ctrl+K is neither", k.press("k", { meta: true, ctrl: true }), { asked: [], prevented: false });

section("Windows and Linux: Ctrl, and only Ctrl");
for (const platform of ["win32", "linux"]) {
  k = load(platform);
  check(`${platform}: the labels say Ctrl`, [k.core.modLabel(), k.core.shortcut("K")], ["Ctrl", "Ctrl+K"]);
  check(`${platform}: Ctrl+K opens the bar`, k.press("k", { ctrl: true }), { asked: ["bar"], prevented: true });
  check(`${platform}: Ctrl+P opens the switcher`, k.press("p", { ctrl: true }), { asked: ["switcher"], prevented: true });
  check(`${platform}: the Windows key with K does nothing here`, k.press("k", { meta: true }), { asked: [], prevented: false });
}

section("tilde, on every platform's home folder");
const { tilde } = require(path.join(__dirname, "..", "ui", "core.js"));
check("tilde on each layout", [
  tilde("/Users/ray/va/delphi"), tilde("/home/ray/src"), tilde("/root/x"), tilde("C:\\Users\\Ray\\code"), tilde("c:/Users/Ray/code"),
  tilde("/Users/ray"), tilde("/opt/delphi"), tilde("/Users"), tilde("D:\\Work\\x"),
], ["~/va/delphi", "~/src", "~/x", "~\\code", "~/code", "~", "/opt/delphi", "/Users", "D:\\Work\\x"]);

section("F is not a second Enter");
k = load("darwin");
globalThis.__litRow = { dataset: { taskId: "5" }, contains: () => false };
check("with a row lit, Enter opens it", k.press("Enter").asked, ["task"]);
check("E opens it to edit", k.press("e").asked, ["task"]);
check("F does nothing until there is a Focus view", k.press("f"), { asked: [], prevented: false });

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
