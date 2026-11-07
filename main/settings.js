// The main process's half of settings: the checks that need the disk or the
// database, and the IPC the floating Settings panel adds.
//
// What a setting is, its default and its shape all live in settings/schema.js,
// which the renderer loads too. main.js keeps the settings object and the side
// effects of a change (rebuild the window, restart the scheduler); this file
// gives it the ctx the schema's checks ask, and the handlers that read files.
//
// Required by main.js under Electron, and by tools/settings_test.js under a
// plain Node, so it takes everything it touches as arguments.

const fs = require("fs");
const path = require("path");
const schema = require("../settings/schema");

// Enough to cover any real vault and to stop well before a home folder has
// been walked. A folder too big to look through is refused rather than
// guessed at, because the guess is about deleting someone's files.
const VAULT_SCAN_LIMIT = 4000;
// What vault.exportAll leaves in a folder it mirrors into. Named here and
// there by the same string; tools/settings_test.js checks they agree.
const VAULT_MARKER = ".delphi-vault";

/**
 * Why a folder is not safe to mirror the vault into, or null.
 *
 * vault.exportAll deletes every .md under the vault that it did not write
 * itself on that pass. Pointed at a folder of somebody's own notes, that is
 * every one of them. So a new vault folder must be missing, empty of
 * markdown, or one Delphi already writes to.
 */
function vaultFolderProblem(target, { known = [] } = {}) {
  const resolved = path.resolve(target);
  if (known.filter(Boolean).some((k) => path.resolve(k) === resolved)) return null;
  let st;
  try { st = fs.statSync(resolved); } catch (error) {
    // Missing is fine: the export makes it. Anything else (no permission) is
    // a folder that cannot be checked, so it is not passed.
    return error && error.code === "ENOENT" ? null : "Delphi cannot look inside that folder, so it cannot tell whether the vault would delete anything there.";
  }
  if (!st.isDirectory()) return "That is a file, not a folder.";
  // A folder Delphi has mirrored into before carries its marker
  // (vault.exportAll writes it), and is Delphi's own to rewrite.
  try { if (fs.statSync(path.join(resolved, VAULT_MARKER)).isFile()) return null; } catch {}
  let seen = 0;
  const stack = [resolved];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return "Delphi cannot look inside part of that folder, so it cannot tell whether the vault would delete anything there."; }
    for (const entry of entries) {
      if (++seen > VAULT_SCAN_LIMIT) return "That folder holds too much to check. The vault deletes markdown it did not write, so choose an empty folder.";
      // Hidden folders too: vault.exportAll's sweep walks them (an Obsidian
      // .trash is full of notes).
      if (entry.isDirectory()) { stack.push(path.join(dir, entry.name)); continue; }
      if (/\.(md|sheet)$/i.test(entry.name)) {
        return `That folder already holds markdown (${path.relative(resolved, path.join(dir, entry.name))}). The vault deletes markdown it did not write, so choose an empty folder.`;
      }
    }
  }
  return null;
}

/**
 * The ctx the schema's checks are asked through.
 *
 * @param projectExists  id => boolean
 * @param checkoutDbIgnored  the path app:dataInfo reports, or null
 * @param vaults  () => the folders the vault is or would be by default
 */
function makeContext({ projectExists, checkoutDbIgnored, vaults = () => [] }) {
  return {
    projectExists,
    checkoutDbIgnored,
    vaultFolderProblem: (target) => vaultFolderProblem(target, { known: vaults() }),
    // This platform's idea of absolute, so C:/x is not a full path on a Mac.
    isAbsolute: (target) => path.isAbsolute(target),
    now: () => new Date().toISOString().slice(0, 19).replace("T", " "),
  };
}

/**
 * The panel's handlers.
 *
 * @param handle   main.js's handle(channel, fn)
 * @param settings () => the live settings object
 * @param context  () => the ctx above
 * @param dialog   Electron's dialog
 * @param info     () => the facts the Overview shows (database, guard, backups)
 * @param version  the app's version
 * @param documents  the folder a save dialog starts in
 */
function register(handle, { settings, context, dialog, info, version, documents, parent = () => null, broken = null }) {
  handle("settings:doctor", () => info());
  // The bad settings.json kept aside at launch, until the window says it has
  // told the person (settings:brokenSeen), so a reload before then still tells.
  let brokenTold = false;
  handle("settings:brokenNotice", () => (brokenTold ? null : (broken ? broken() : null)));
  handle("settings:brokenSeen", () => { brokenTold = true; return null; });

  // JSON with every setting a person sets, and a line saying what is left out
  // and why, so nobody opens it looking for the API key.
  handle("settings:export", async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(parent() || undefined, {
      title: "Export Delphi settings",
      defaultPath: path.join(documents, `delphi-settings-${stamp}.json`),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (canceled || !filePath) return null;
    const out = {
      format: "delphi-settings",
      formatVersion: 1,
      app: version,
      exportedAt: new Date().toISOString(),
      leftOut: "No secrets: the API key stays in the system keychain and trusted agent commands stay in the database. Settings that only mean something on this computer (the vault folder, the default project, pins) are left out too.",
      settings: schema.exportable(settings()),
    };
    fs.writeFileSync(filePath, JSON.stringify(out, null, 2) + "\n");
    return { path: filePath, count: Object.keys(out.settings).length };
  });

  // Reads and checks a file, and says what it would change. Nothing is saved:
  // the window shows the difference and applies it through settings:set,
  // which checks every field again.
  handle("settings:importRead", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(parent() || undefined, {
      title: "Import Delphi settings",
      defaultPath: documents,
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (canceled || !filePaths || !filePaths[0]) return null;
    const file = filePaths[0];
    const st = fs.statSync(file);
    if (st.size > 1024 * 1024) throw new Error("That file is too big to be a settings export.");
    let data;
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { throw new Error(`That file is not valid JSON: ${error.message}`); }
    return { path: file, ...schema.importable(data, settings(), context()) };
  });
}

/**
 * Edit this page's handlers. Layouts are rows in the database, not
 * settings.json (the `layouts` entry in settings/schema.js says so), because
 * a change has to be in History and undoable like any other.
 *
 * Everything the window sends is checked here before db.js stores it: the
 * screen is one settings/schema.js lists, a project is one that exists and
 * only on a screen that may have one, and the layout has the shape check()
 * accepts. What History calls the change is built here too, from the
 * schema's words, so the window cannot write any label it likes.
 *
 * @param db           db.js: listLayouts, saveLayout, resetAllLayouts
 * @param projectName  id => the project's name, or null when there is none
 */
function registerLayouts(handle, { db, projectName }) {
  const screenOf = (id) => schema.LAYOUT_SCREENS.find((s) => s.id === id) || null;
  const labelOf = (screen, projectId) => {
    const s = screenOf(screen);
    const name = s ? s.label : String(screen);
    if (!s || !s.scoped) return name;
    if (projectId == null) return `${name}, all projects`;
    return `${name} in ${projectName(projectId) || `project ${projectId}`}`;
  };
  // A preset's name or a reset's kind, from the window: plain words, short.
  const noteOf = (note) => {
    if (note == null || note === "") return "";
    const t = String(note).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    return t.slice(0, 60);
  };

  handle("layout:list", () => db.listLayouts());
  handle("layout:save", (args) => {
    const { screen, projectId = null, layout = null, note = null } = args || {};
    const s = screenOf(screen);
    if (!s) throw new Error(`Delphi has no page called "${screen}" to lay out.`);
    let pid = null;
    if (projectId != null) {
      pid = Number(projectId);
      if (!s.scoped) throw new Error(`${s.label} has one layout for every project.`);
      if (!Number.isInteger(pid) || pid <= 0 || !projectName(pid)) throw new Error(`No project ${projectId}.`);
    }
    const value = schema.check("layouts", layout);
    const words = noteOf(note);
    const label = labelOf(s.id, pid) + (words ? `: ${words}` : "");
    db.saveLayout({ screen: s.id, projectId: pid, layout: value, summary: value == null ? "Layout reset" : "Layout changed", label });
    return db.listLayouts();
  });
  handle("layout:resetAll", () => {
    db.resetAllLayouts({ summary: "Layout reset", labelOf: (row) => `${labelOf(row.screen, row.project_id)}: everything reset` });
    return db.listLayouts();
  });
}

/**
 * settings.json, written so a crash or a full disk mid-write never leaves half
 * a file: a temporary file beside it, flushed to the disk, then renamed over
 * the old one, which the filesystem does in one step.
 */
function writeSettingsFile(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(temp, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(settings, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

/**
 * The temporary files of writes that never reached their rename: a process
 * killed between open and rename leaves settings.json.<pid>.tmp behind. Only
 * those of processes that are gone: this one's, or a live one's, may be
 * mid-write.
 */
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return Boolean(error && error.code === "EPERM"); }
};
function sweepTemps(file, pid = process.pid, alive = pidAlive) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const own = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, (m) => "\\" + m)}\\.(\\d+)\\.tmp$`);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const removed = [];
  for (const name of names) {
    const m = name.match(own);
    if (!m || Number(m[1]) === pid || alive(Number(m[1]))) continue;
    try { fs.rmSync(path.join(dir, name), { force: true }); removed.push(name); } catch {}
  }
  return removed;
}

/**
 * settings.json as found, over the schema's defaults.
 *
 * A missing file is a new install: it gets the defaults, and the file is
 * written so it exists to be edited. A file that is not valid JSON was hand
 * edited into something broken; it is kept, renamed settings.json.broken-<time>
 * beside the new one, so whatever was being typed is not lost, and the caller
 * tells the person once. A theme missing from a file that exists predates the
 * setting, when every window followed the system, so it stays "system" rather
 * than taking the new installs' dark.
 *
 * A file that is there but cannot be read, or cannot be set aside, is never
 * written over: protect says so, and saveSettings refuses until it is fixed.
 *
 * Returns { settings, write, broken, protect }: write says the file should be
 * written now, broken is where the bad file went, or null.
 */
function readSettingsFile(file, defaults, { now = () => new Date(), pid = process.pid, alive = pidAlive } = {}) {
  const swept = sweepTemps(file, pid, alive);
  if (swept.length) console.log(`settings: removed ${swept.join(", ")}, left by writes that never finished`);
  let text = null;
  try { text = fs.readFileSync(file, "utf8"); } catch (error) {
    if (error && error.code === "ENOENT") return { settings: { ...defaults }, write: true, broken: null, protect: false };
    return { settings: { ...defaults }, write: false, broken: null, protect: true };
  }
  // Editors on Windows save UTF-8 with a byte-order mark, which JSON.parse
  // refuses; the file is fine without it.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let parsed;
  try {
    parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  } catch {
    const broken = `${file}.broken-${now().toISOString().replace(/[:.]/g, "-")}`;
    try { fs.renameSync(file, broken); } catch { return { settings: { ...defaults }, write: false, broken: null, protect: true }; }
    return { settings: { ...defaults }, write: true, broken, protect: false };
  }
  const settings = { ...defaults, ...parsed };
  if (!("theme" in parsed)) settings.theme = "system";
  return { settings, write: false, broken: null, protect: false };
}

module.exports = { vaultFolderProblem, makeContext, register, registerLayouts, writeSettingsFile, readSettingsFile, sweepTemps, VAULT_SCAN_LIMIT, VAULT_MARKER };
