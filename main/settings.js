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
function register(handle, { settings, context, dialog, info, version, documents, parent = () => null }) {
  handle("settings:doctor", () => info());

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

module.exports = { vaultFolderProblem, makeContext, register, VAULT_SCAN_LIMIT };
