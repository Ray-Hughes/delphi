#!/usr/bin/env node
// test-runtime: node
// The one settings list, and everything built from it.
//
//   node tools/settings_test.js
//
// settings/schema.js is where every global setting is defined. This checks:
// - each entry is whole (label, sentence, what it does not change, a section
//   the panel has), and its default passes its own check;
// - main.js takes its defaults and its settings:set checks from it, and keeps
//   no list of its own that could drift (the old allowlist silently dropped any
//   field it did not name, which is how the vault became unwritable);
// - every effect an entry names is one main.js knows how to run;
// - every key the renderer saves is in the schema;
// - a write is all or nothing, panel mode no longer discards the rest of its
//   call, the vault's two keys can be written, and a name nobody defined is
//   refused by name;
// - bounds agree with the dispatcher's and the second opinion's own;
// - export leaves out what only means something here, and import says why it
//   skips what it skips;
// - a vault folder that already holds someone's markdown is refused;
// - every curated accent passes AA in both themes, against styles/tokens.css.

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const schema = require("../settings/schema");
const settingsMain = require("../main/settings");

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
const throws = (fn) => { try { fn(); return null; } catch (error) { return error.message; } };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// --- the schema itself --------------------------------------------------------
console.log("\nthe schema");
const sections = new Set(schema.SECTIONS.map((s) => s.id));
const keys = schema.SETTINGS.map((s) => s.key);
check("keys are unique", keys.length, new Set(keys).size);
const ctxAll = { projectExists: () => true, checkoutDbIgnored: null };
const broken = [];
for (const s of schema.SETTINGS) {
  const why = [];
  if (!s.label || !s.desc) why.push("needs a label and a sentence");
  if (s.internal) { if (s.section !== null) why.push("an internal setting has no section"); }
  else {
    if (!sections.has(s.section) || s.section === "overview") why.push(`section "${s.section}" is not one the panel lists`);
    if (!s.group) why.push("needs a group");
    if (!s.notChanged) why.push("needs what it does not change");
    if (!Array.isArray(s.synonyms) || !s.synonyms.length) why.push("needs synonyms for search");
  }
  if (s.danger && !(s.danger.title && s.danger.body && s.danger.confirm)) why.push("a danger needs a title, a body and a confirm");
  if (s.type === "int" && !(Number.isInteger(s.min) && Number.isInteger(s.max) && s.unit)) why.push("an int needs min, max and unit");
  if (s.type === "enum" && !(Array.isArray(s.choices) && s.choices.some(([c]) => c === s.default))) why.push("an enum's default must be a choice");
  const bad = throws(() => schema.check(s.key, s.default, ctxAll));
  if (bad) why.push(`its default fails its own check: ${bad}`);
  if (/[\u2013\u2014\u2212]/.test(JSON.stringify(s))) why.push("contains a dash the house rules forbid");
  if (why.length) broken.push(`${s.key}: ${why.join("; ")}`);
}
check("every entry is whole, and its default passes its own check", broken, []);
check("every section but the Overview and About has a setting or a panel of its own",
  schema.SECTIONS.map((x) => x.id).filter((id) => !["overview", "about", "data", "privacy", "agents"].includes(id) && !schema.SETTINGS.some((s) => s.section === id)), []);

// --- main.js takes everything from it -------------------------------------------
console.log("\nmain.js");
const main = read("main.js");
check("the defaults are the schema's", /let settings = settingsSchema\.defaults\(\);/.test(main), true);
check("settings:set goes through the schema's apply", /handle\("settings:set", setSettings\)/.test(main) && /settingsSchema\.apply\(settings, fields, settingsContext\(\)\)/.test(main), true);
check("and setHotkey through the same path", /handle\("settings:setHotkey", \(accelerator\) => setSettings\(\{ hotkey: accelerator \}\)\)/.test(main), true);
check("main.js keeps no allowlist of its own (no fields.<name> anywhere)", main.match(/\bfields\.[A-Za-z]+/g), null);
const effectsBlock = main.slice(main.indexOf("const SETTING_EFFECTS = {"), main.indexOf("function setSettings("));
const known = new Set([...effectsBlock.matchAll(/^  (\w+): /gm)].map((m) => m[1]));
check("every effect an entry names, main.js can run",
  [...new Set(schema.SETTINGS.map((s) => s.effect).filter(Boolean))].filter((e) => !known.has(e)), []);
check("the window rebuild waits for the reply to go", /window: \(\) => setTimeout\(/.test(effectsBlock), true);
check("defaults() has every key, and only them", Object.keys(schema.defaults()).sort(), [...keys].sort());
check("defaults() hands out fresh lists", schema.defaults().pinnedProjects === schema.defaults().pinnedProjects, false);

// Bounds the dispatcher and the server also enforce.
const { BOUNDS } = require("../agent/dispatch");
const harness = require("../harness");
const B = schema.BY_KEY;
check("jobConcurrency's bounds are the dispatcher's", [B.jobConcurrency.min, B.jobConcurrency.max], BOUNDS.jobConcurrency);
check("jobTimeoutMinutes's bounds are the dispatcher's", [B.jobTimeoutMinutes.min, B.jobTimeoutMinutes.max], BOUNDS.jobTimeoutMinutes);
check("a per-agent limit's bounds are the dispatcher's", [B.jobHarnessLimits.min, B.jobHarnessLimits.max], BOUNDS.jobHarnessLimit);
check("the second opinion's limit and default are the harness module's",
  [B.secondOpinionHourlyLimit.min, B.secondOpinionHourlyLimit.max, B.secondOpinionHourlyLimit.default],
  [...harness.SECOND_OPINION_HOURLY.bounds, harness.SECOND_OPINION_HOURLY.default]);
// The server reads settings.json too, through agent/directives.js, with its
// own defaults for the keys it uses. They must say the same.
const directives = read("agent/directives.js");
for (const key of ["scratchpadMode", "scratchpadProjectId", "secondOpinionMode", "secondOpinionAgent"]) {
  const m = directives.match(new RegExp(`${key}: ([^,\\n]+),`));
  check(`the server's default for ${key} is the schema's`, m ? JSON.parse(m[1].replace(/'/g, '"')) : "missing", B[key].default);
}

// --- every key the renderer saves ----------------------------------------------
console.log("\nthe renderer");
/** The keys of an object literal starting at text[at] === "{", top level only. */
function literalKeys(text, at) {
  // inValue: past this property's colon, so what follows is its value and
  // not a shorthand key.
  let depth = 0; let i = at; const out = []; let token = ""; let inValue = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "{" || c === "(" || c === "[") { depth++; if (depth === 2 && c === "[" && !inValue && token.trim() === "") out.push("[computed]"); token = ""; continue; }
    if (c === "}" || c === ")" || c === "]") { depth--; if (depth === 0) break; token = ""; continue; }
    if (depth !== 1) continue;
    if (c === ":") { const k = token.trim(); if (!inValue && /^\w+$/.test(k)) out.push(k); token = ""; inValue = true; continue; }
    if (c === ",") { const k = token.trim(); if (!inValue && /^\w+$/.test(k)) out.push(k); token = ""; inValue = false; continue; }
    token += c;
  }
  const last = token.trim();
  if (!inValue && /^\w+$/.test(last)) out.push(last);
  return { keys: [...new Set(out)], end: i };
}
/** The helper a call site sits in: the nearest `const name = (...) =>` above it. */
function enclosingHelper(text, at) {
  const before = text.slice(Math.max(0, at - 1500), at);
  const all = [...before.matchAll(/const (\w+) = (?:async )?\(?[^=]*?\)? =>/g)];
  return all.length ? all[all.length - 1][1] : null;
}
/** Every key the calls of a helper pass: in an object literal, or as a camelCase string. */
function keysFromCalls(text, name, { objects = false } = {}) {
  const out = [];
  for (const m of text.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
    let depth = 0; let i = m.index + name.length;
    for (; i < text.length; i++) { if (text[i] === "(") depth++; else if (text[i] === ")" && --depth === 0) break; }
    const args = text.slice(m.index + name.length, i + 1);
    if (!objects) {
      for (const k of args.matchAll(/\bkey: "(\w+)"/g)) out.push(k[1]);
      for (const k of args.matchAll(/"([a-z]+[A-Z]\w*)"/g)) out.push(k[1]);
    } else if (/^\(\s*\{/.test(args)) {
      out.push(...literalKeys(args, args.indexOf("{")).keys);
    }
  }
  return out;
}
const saved = new Set();
const unread = [];
const files = ["app.js", ...fs.readdirSync(path.join(ROOT, "ui")).filter((f) => f.endsWith(".js") && f !== "settings.js").map((f) => `ui/${f}`)];
for (const file of files) {
  const text = read(file);
  for (const m of text.matchAll(/window\.delphi\.settings\.set\(/g)) {
    const at = m.index + m[0].length;
    if (text[at] === "{") {
      const { keys: found } = literalKeys(text, at);
      for (const k of found) {
        if (k !== "[computed]") { saved.add(k); continue; }
        const helper = enclosingHelper(text, m.index);
        const via = helper ? keysFromCalls(text, helper) : [];
        if (!via.length) unread.push(`${file}: a computed key with no helper to read`);
        via.forEach((v) => saved.add(v));
      }
    } else {
      const helper = enclosingHelper(text, m.index);
      const via = helper ? keysFromCalls(text, helper, { objects: true }).filter((k) => k !== "[computed]") : [];
      if (!via.length) unread.push(`${file}: settings.set(${text.slice(at, at + 20)}...) with no helper to read`);
      via.forEach((v) => saved.add(v));
    }
  }
  // The old Settings page's hotkey goes through its own call.
  if (/window\.delphi\.settings\.setHotkey\(/.test(text)) saved.add("hotkey");
}
check("every settings.set call in the renderer was read", unread, []);
console.log("       saved:", [...saved].sort().join(", "));
check("and found the keys it saves (a floor, so a broken scan cannot pass empty)", saved.size >= 15, true);
check("every key the renderer saves is in the schema", [...saved].filter((k) => !schema.BY_KEY[k]).sort(), []);
const panel = read("ui/settings.js");
check("the panel saves only through the schema's keys (no setting named in a set call)", /settings\.set\(\{\s*\w+:/.test(panel), false);
const panelKeys = [...panel.matchAll(/\bsave\(\{ (\w+):/g)].map((m) => m[1]);
check("and every key it names in a save is in the schema", panelKeys.filter((k) => !schema.BY_KEY[k]), []);
check("(it does name some, so that check read something)", panelKeys.length > 3, true);
const html = read("index.html");
check("index.html loads the schema before the panel",
  html.indexOf('src="settings/schema.js"') > 0 && html.indexOf('src="settings/schema.js"') < html.indexOf('src="ui/settings.js"'), true);
check("and the panel's stylesheet", html.includes('href="styles/settings.css"'), true);

// --- writes -------------------------------------------------------------------
console.log("\nwrites");
const current = schema.defaults();
{
  const { values, changed } = schema.apply(current, { panelMode: true, theme: "light", snoozeMinutes: 15 }, ctxAll);
  check("panel mode no longer discards the rest of its call", values, { panelMode: true, theme: "light", snoozeMinutes: 15 });
  check("and the window rebuild comes last", changed[changed.length - 1], "panelMode");
}
check("the vault can be switched off and moved from the window",
  schema.apply(current, { vaultEnabled: false, vaultPath: "/tmp/somewhere-new" }, ctxAll).values, { vaultEnabled: false, vaultPath: "/tmp/somewhere-new" });
check("an empty vault folder means the default", schema.apply(current, { vaultPath: "" }, ctxAll).values, { vaultPath: null });
check("a relative vault folder is refused", throws(() => schema.apply(current, { vaultPath: "notes" }, ctxAll)), "Vault folder must be a full path to a folder.");
check("a setting nobody defined is refused by name, not dropped",
  throws(() => schema.apply(current, { theme: "dark", vaultEnable: false }, ctxAll)), 'Delphi has no setting called "vaultEnable".');
check("one bad field and nothing is applied (the call throws before returning values)",
  throws(() => schema.apply(current, { theme: "dark", jobConcurrency: 99 }, ctxAll)), "Jobs at once must be a whole number from 1 to 8.");
check("a switch is true or false, not a truthy string", throws(() => schema.apply(current, { scratchpadMode: "yes" }, ctxAll)), "Agents keep their working notes here is on or off: true or false.");
check("a theme is one of three", throws(() => schema.apply(current, { theme: "sepia" }, ctxAll)), "Theme must be one of system, light, dark.");
check("an accent is one of the curated ones", throws(() => schema.apply(current, { accent: "#ff0000" }, ctxAll)) !== null, true);
check("text size is 12 to 16", [throws(() => schema.apply(current, { fontSize: 30 }, ctxAll)) !== null, schema.apply(current, { fontSize: "14" }, ctxAll).values.fontSize], [true, 14]);
check("a shortcut is modifiers and one key",
  [throws(() => schema.check("hotkey", "Control+")) !== null, throws(() => schema.check("hotkey", "Shift")) !== null, throws(() => schema.check("hotkey", "T")) !== null, schema.check("hotkey", "Alt+Space"), schema.check("hotkey", "F13")], [true, true, true, "Alt+Space", "F13"]);
check("Shift and a letter would take over typing, so it is refused; a name that is not a key is too",
  [throws(() => schema.check("hotkey", "Shift+T")) !== null, throws(() => schema.check("hotkey", "Control+Banana")) !== null, schema.check("hotkey", "Control+Shift+Space")], [true, true, "Control+Shift+Space"]);
check("text settings take text, not an object", throws(() => schema.check("workbenchEditor", { a: 1 })), "Open a Workbench with must be text.");
check("a project that does not exist is refused", throws(() => schema.check("scratchpadProjectId", 99, { projectExists: () => false })), "No project 99.");
check("a value that is the same is not a change", schema.apply(current, { theme: "dark" }, ctxAll).changed, []);
check("a call that is not an object is refused", throws(() => schema.apply(current, null, ctxAll)) !== null, true);
check("the checkout notice takes only the path the window was shown",
  [throws(() => schema.check("checkoutNoticeSeen", "/x.db", { checkoutDbIgnored: "/y.db" })) !== null, schema.check("checkoutNoticeSeen", "/y.db", { checkoutDbIgnored: "/y.db" })], [true, "/y.db"]);

check("modified means not the default", [schema.isModified("theme", "system"), schema.isModified("theme", "dark"), schema.isModified("workbenchEditor", ""), schema.isModified("jobHarnessLimits", {})], [true, false, false, false]);
check("turning a dangerous switch on needs a yes, turning it off does not",
  [schema.needsConfirm("scratchpadMode", true), schema.needsConfirm("scratchpadMode", false), schema.needsConfirm("vaultPath", "/a"), schema.needsConfirm("vaultPath", null), schema.needsConfirm("theme", "dark")],
  [true, false, true, false, false]);

check("__proto__ and constructor are no setting, refused by name",
  [throws(() => schema.apply(current, JSON.parse('{"__proto__":{"x":1}}'), ctxAll)), throws(() => schema.apply(current, { constructor: 1 }, ctxAll)), throws(() => schema.apply(current, { toString: 1 }, ctxAll))],
  ['Delphi has no setting called "__proto__".', 'Delphi has no setting called "constructor".', 'Delphi has no setting called "toString".']);
check("NaN is no number", throws(() => schema.apply(current, { fontSize: NaN }, ctxAll)) !== null, true);

// --- settings.json, read and written ------------------------------------------
console.log("\nsettings.json");
{
  const tmpS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-settings-file-")));
  const file = path.join(tmpS, "settings.json");
  const d = schema.defaults();
  check("a new install's theme is dark, and is not counted as changed", [d.theme, schema.isModified("theme", d.theme)], ["dark", false]);
  const fresh = settingsMain.readSettingsFile(file, d);
  check("a missing file is a new install: defaults, and written", [fresh.settings.theme, fresh.write, fresh.broken], ["dark", true, null]);
  settingsMain.writeSettingsFile(file, { ...fresh.settings, snoozeMinutes: 15 });
  check("a write leaves the whole file and no temporary beside it",
    [JSON.parse(fs.readFileSync(file, "utf8")).snoozeMinutes, fs.readdirSync(tmpS)], [15, ["settings.json"]]);
  fs.writeFileSync(file, JSON.stringify({ snoozeMinutes: 20 }));
  const old = settingsMain.readSettingsFile(file, d);
  check("an existing file without a theme predates it, and keeps following the system", [old.settings.theme, old.settings.snoozeMinutes, old.write], ["system", 20, false]);
  fs.writeFileSync(file, JSON.stringify({ theme: "light" }));
  check("a theme someone chose is kept", settingsMain.readSettingsFile(file, d).settings.theme, "light");
  fs.writeFileSync(file, "{ \"theme\": \"light\", oops");
  const bad = settingsMain.readSettingsFile(file, d, { now: () => new Date("2026-11-06T10:00:00Z") });
  check("a file that is not JSON is kept aside, and defaults are written", [path.basename(bad.broken || ""), bad.write, bad.settings.theme, fs.existsSync(file)],
    ["settings.json.broken-2026-11-06T10-00-00-000Z", true, "dark", false]);
  check("with what was being typed still in it", fs.readFileSync(bad.broken, "utf8"), "{ \"theme\": \"light\", oops");
  fs.rmSync(file, { force: true }); fs.mkdirSync(file);
  const unreadable = settingsMain.readSettingsFile(file, d);
  check("a settings.json that is there but cannot be read is never written over", [unreadable.write, unreadable.protect], [false, true]);
  fs.rmSync(tmpS, { recursive: true, force: true });
}
{
  const handlers = new Map();
  settingsMain.register((ch, fn) => handlers.set(ch, fn), { settings: () => ({}), context: () => ({}), dialog: {}, info: () => ({}), version: "x", documents: os.tmpdir(), broken: () => "/data/settings.json.broken-1" });
  check("the person is told about a broken settings.json until the window says it has told them",
    [handlers.get("settings:brokenNotice")(), handlers.get("settings:brokenNotice")(), handlers.get("settings:brokenSeen")(), handlers.get("settings:brokenNotice")()], ["/data/settings.json.broken-1", "/data/settings.json.broken-1", null, null]);
}
const mainText = read("main.js");
check("main.js reads and writes the file through those two", /settingsMain\.readSettingsFile\(SETTINGS_PATH/.test(mainText) && /settingsMain\.writeSettingsFile\(SETTINGS_PATH, settings\)/.test(mainText) && !/writeFileSync\(SETTINGS_PATH/.test(mainText), true);
check("loadSettings no longer sets a first-run theme of its own", /settings\.theme = "dark"/.test(mainText), false);
check("a failed hotkey rollback is reported, not ignored", /const back = registerHotkey\(previousHotkey\)/.test(mainText), true);

// --- the panel's own rows, in search and Cmd+K -----------------------------------
console.log("\nthe panel's rows");
{
  globalThis.DelphiSettingsSchema = schema;
  globalThis.isMac = () => true; globalThis.modLabel = () => "⌘"; globalThis.tilde = (p) => p; globalThis.modKey = () => false;
  globalThis.navigator = globalThis.navigator || { platform: "MacIntel" };
  require("../ui/settings.js");
  const P = globalThis.DelphiSettingsPanel;
  const find = (q) => P.EXTRAS.filter((x) => [x.label, x.desc, ...x.synonyms].join(" ").toLowerCase().includes(q)).map((x) => x.id);
  const missing = ["backup", "restore", "import", "export", "api key", "trust", "approve", "unguarded", "guard", "reset", "database", "folder", "history", "keychain"].filter((q) => !find(q).length);
  check("every action people search for has a row: backup, restore, import, api key, trust, approve, unguarded, guard, reset...", missing, []);
  check("every one names a section the panel has", P.EXTRAS.filter((x) => !sections.has(x.section)).map((x) => x.id), []);
  const cmds = P.commands();
  check("and each is a Cmd+K command too", P.EXTRAS.every((x) => cmds.some((c) => c.id === `settings-row-${x.id}`)), true);
  const panelText = read("ui/settings.js");
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, (m) => "\\" + m);
  const drawn = (x) => {
    if (x.target) return P.EXTRAS.some((y) => y.id === x.target);
    if (x.row) return new RegExp(`infoRow\\(\\s*"${esc(x.row)}"`).test(panelText);
    if (x.group) return new RegExp(`(group\\(\\s*|textContent: )"${esc(x.group)}"`).test(panelText);
    return new RegExp(`(dataset\\.row = |perProject\\()"${esc(x.id)}"`).test(panelText);
  };
  check("every row an entry names is a row the panel draws", P.EXTRAS.filter((x) => !drawn(x)).map((x) => x.id), []);
}

// --- export and import ----------------------------------------------------------
console.log("\nexport and import");
const mine = { ...schema.defaults(), theme: "dark", vaultPath: "/Users/x/vault", scratchpadProjectId: 12, pinnedProjects: [1, 2], checkoutNoticeSeen: "/a.db" };
const out = schema.exportable(mine);
check("export leaves out what only means something here, and what the app keeps for itself",
  ["vaultPath", "scratchpadProjectId", "pinnedProjects", "hiddenFromActive", "checkoutNoticeSeen", "workbenchEditor"].filter((k) => k in out), []);
check("and keeps the rest", out.theme, "dark");
check("there is nothing secret in it: no key, token or password",
  Object.keys(out).filter((k) => /key$|token|secret|password|trusted/i.test(k) && k !== "hotkey"), []);
const imp = schema.importable({ format: "delphi-settings", settings: { theme: "light", vaultPath: "/a", nope: 1, jobConcurrency: 50, accent: "teal" } }, mine, ctxAll);
check("import applies what is valid and new", imp.apply, { theme: "light", accent: "teal" });
check("and says why it skipped each of the rest", imp.skipped.map((s) => s.key), ["vaultPath", "nope", "jobConcurrency"]);
check("a file that is not settings is refused", throws(() => schema.importable([1, 2], mine, ctxAll)), "That file is not a Delphi settings export.");

// --- the vault folder ---------------------------------------------------------------
console.log("\nthe vault folder");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-settings-")));
const own = path.join(tmp, "notes"); fs.mkdirSync(path.join(own, "deep"), { recursive: true });
fs.writeFileSync(path.join(own, "deep", "mine.md"), "# my own notes\n");
const empty = path.join(tmp, "empty"); fs.mkdirSync(empty);
fs.writeFileSync(path.join(tmp, "file.txt"), "x");
check("a folder holding someone's markdown is refused, saying which file",
  /already holds markdown \(deep[\\/]mine\.md\)/.test(settingsMain.vaultFolderProblem(own) || ""), true);
check("an empty folder, a missing one, and the current vault are fine",
  [settingsMain.vaultFolderProblem(empty), settingsMain.vaultFolderProblem(path.join(tmp, "missing")), settingsMain.vaultFolderProblem(own, { known: [own] })], [null, null, null]);
check("a file is not a folder", settingsMain.vaultFolderProblem(path.join(tmp, "file.txt")), "That is a file, not a folder.");
const hidden = path.join(tmp, "obsidian"); fs.mkdirSync(path.join(hidden, ".trash"), { recursive: true });
fs.writeFileSync(path.join(hidden, ".trash", "old.md"), "x");
check("markdown in a hidden folder counts too, since the vault's sweep walks those", /already holds markdown/.test(settingsMain.vaultFolderProblem(hidden) || ""), true);
const ctx = settingsMain.makeContext({ projectExists: () => true, checkoutDbIgnored: null, vaults: () => [] });
check("a path this platform does not call absolute is refused", throws(() => schema.check("vaultPath", process.platform === "win32" ? "notes" : "C:/vault", ctx)), "Vault folder must be a full path to a folder.");
const mine2 = path.join(tmp, "was-mine"); fs.mkdirSync(mine2);
fs.writeFileSync(path.join(mine2, "Project.md"), "# x"); fs.writeFileSync(path.join(mine2, settingsMain.VAULT_MARKER), "x");
check("a folder Delphi mirrored into before, with its marker, is allowed back", settingsMain.vaultFolderProblem(mine2), null);
fs.rmSync(path.join(mine2, settingsMain.VAULT_MARKER)); fs.mkdirSync(path.join(mine2, settingsMain.VAULT_MARKER));
check("a folder merely named like the marker does not count", /already holds markdown/.test(settingsMain.vaultFolderProblem(mine2) || ""), true);
check("the marker is the one vault.js writes", read("vault.js").includes(`"${settingsMain.VAULT_MARKER}"`), true);
check("and settings:set's own check says so", /already holds markdown/.test(throws(() => schema.apply(current, { vaultPath: own }, ctx)) || ""), true);
fs.rmSync(tmp, { recursive: true, force: true });

// --- accents ------------------------------------------------------------------------
console.log("\naccents, against styles/tokens.css");
const css = read("styles/tokens.css").replace(/\/\*[\s\S]*?\*\//g, "");
function block(re) {
  const at = css.search(re); const open = css.indexOf("{", at); let d = 1; let i = open + 1;
  for (; i < css.length && d; i++) { if (css[i] === "{") d++; else if (css[i] === "}") d--; }
  return Object.fromEntries([...css.slice(open + 1, i - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const light = block(/(^|\n):root\s*\{/);
const dark = { ...light, ...block(/:root\[data-theme="dark"\]\s*\{/) };
const rgb = (hex) => { const h = hex.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const low = [];
for (const a of schema.ACCENTS) {
  for (const [theme, vars, [fill, ink]] of [["light", light, a.light], ["dark", dark, a.dark]]) {
    for (const g of ["--bg", "--surface", "--raised"]) if (ratio(ink, vars[g]) < 4.5) low.push(`${a.id} ${theme} ink on ${g}: ${ratio(ink, vars[g]).toFixed(2)}`);
    if (ratio("#FFFFFF", fill) < 4.5) low.push(`${a.id} ${theme} white on the fill: ${ratio("#FFFFFF", fill).toFixed(2)}`);
  }
}
check("every accent's ink reads on every ground, and white reads on its fill, in both themes", low, []);
check("the accent's choices are the palette", B.accent.choices.map(([c]) => c), schema.ACCENTS.map((a) => a.id));

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
