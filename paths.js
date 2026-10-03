// Where Delphi keeps things.
//
// The database, settings.json and the Sheet run logs live in one data folder,
// and agent/locate.js is what decides which. It is shared with the MCP server
// and the delphi command line, so all three resolve the same file the same way.
// That folder is the per-user data folder whether or not the app is packaged:
// it used to be the checkout when run from source, and that is how `npm start`
// ended up reading one database while every agent wrote another. Developer
// isolation is now explicit, through DELPHI_DATA_DIR.
//
// Electron is required lazily and optionally, because defaultVault wants the
// Documents folder and this file is also loaded by tools under a plain Node,
// where `require("electron")` is a path to a binary rather than a module.

const path = require("path");
const fs = require("fs");
const os = require("os");
const locate = require("./agent/locate");

const APP_NAME = locate.APP_NAME;
const conventionalDataDir = locate.conventionalDataDir;

/** The Electron app object, or null when this is not running under Electron. */
function electronApp() {
  try {
    const electron = require("electron");
    // Under a plain Node, requiring "electron" resolves to the npm package, whose
    // export is the path to the binary as a string rather than the API.
    return electron && typeof electron === "object" && electron.app ? electron.app : null;
  } catch {
    return null;
  }
}

const RESOLVED = locate.resolve();
const DATA_DIR = RESOLVED.dataDir;
const DB_PATH = RESOLVED.dbPath;
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

/**
 * Where the markdown mirror goes.
 *
 * Documents rather than the data folder, because the whole point of the mirror
 * is that a person opens it in Obsidian or an editor, and nobody browses to
 * Application Support to do that. A data folder chosen by override keeps its
 * vault inside it instead, so a test or a dev copy never writes over the
 * mirror of the real database.
 */
function defaultVault() {
  if (process.env.DELPHI_VAULT_DIR) return path.resolve(process.env.DELPHI_VAULT_DIR);
  if (RESOLVED.source !== "default") return path.join(DATA_DIR, "vault");
  const app = electronApp();
  try {
    if (app) return path.join(app.getPath("documents"), APP_NAME);
  } catch {}
  return path.join(os.homedir(), "Documents", APP_NAME);
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

/**
 * Brings a source install's database across on the first packaged run.
 *
 * Anyone using this before there were installers has their work in a checkout,
 * and installing the app would otherwise present them with an empty tracker and
 * no clue that their notes still exist. The write-ahead log is copied alongside
 * the database on purpose: recent rows can still be sitting in it, and copying
 * the database alone is how a migration silently loses the last session's work.
 *
 * Only ever runs when there is no database at the destination, not even a
 * stray -wal, so it can never put an old copy over a real one. Never when the
 * folder was chosen by override: that is someone pointing at a database on
 * purpose, a test's above all, and filling it with a legacy copy would be a
 * surprise at best. The checkout this is running from is not a candidate; that
 * one is reported (locate.ignoredNotice), never adopted. A failure is logged
 * rather than thrown: starting with an empty tracker beats not starting.
 */
function migrateLegacyDatabase() {
  if (RESOLVED.source !== "default") return null;
  if (fs.existsSync(DB_PATH) || fs.existsSync(DB_PATH + "-wal")) return null;

  const candidates = [
    path.join(os.homedir(), "delphi", "delphi.db"),        // what the README told people to clone into
    path.join(os.homedir(), "second-brain", "delphi.db"),  // the old repository name
    path.join(os.homedir(), "second-brain", "brain.db"),   // and the old database name with it
  ];

  for (const source of candidates) {
    try {
      if (!fs.existsSync(source) || locate.samePath(source, DB_PATH)) continue;
      ensureDataDir();
      // COPYFILE_EXCL as the last word on "never over a real one": if anything
      // made the file between the check above and here, the copy fails.
      fs.copyFileSync(source, DB_PATH, fs.constants.COPYFILE_EXCL);
      for (const suffix of ["-wal", "-shm"]) {
        if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, DB_PATH + suffix);
      }
      console.log(`Brought your existing database across from ${source}`);
      return source;
    } catch (error) {
      console.error(`Could not copy ${source}`, error);
    }
  }
  return null;
}

module.exports = {
  APP_NAME, DATA_DIR, DB_PATH, SETTINGS_PATH, RESOLVED,
  defaultVault, ensureDataDir, migrateLegacyDatabase, conventionalDataDir,
};
