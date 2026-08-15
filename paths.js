// Where Delphi keeps things, which is not the same place before and after packaging.
//
// Run from a checkout, everything lives beside the source: that is what the
// Makefile, the seeding scripts and every existing install expect, and moving it
// would strand the database people already have.
//
// Run from an installer, the source directory is inside app.asar, which is a
// read-only archive. Writing a database there does not fail politely; it fails at
// the first write, on a machine belonging to someone who has no idea what an asar
// is. So a packaged build uses the per-user data directory the operating system
// already sets aside for exactly this.
//
// Electron is required lazily and optionally, because the MCP server has to
// resolve the same database path while running under a plain Node that an editor
// launched, where `require("electron")` is a path to a binary rather than a module.

const path = require("path");
const fs = require("fs");
const os = require("os");

const APP_NAME = "Delphi";

/**
 * The per-user data directory, worked out without Electron.
 *
 * These are the same locations `app.getPath("userData")` returns, which is what
 * lets a plain Node process find the database a packaged app is using.
 */
function conventionalDataDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, APP_NAME);
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, APP_NAME);
}

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

function resolveDataDir() {
  // An explicit override wins over everything, which is what makes it possible to
  // point a packaged build at a checkout's database, or run two copies side by
  // side without them writing over each other.
  if (process.env.DELPHI_DATA_DIR) return path.resolve(process.env.DELPHI_DATA_DIR);

  const app = electronApp();
  if (app && app.isPackaged) return app.getPath("userData");

  // Not packaged: beside the source, exactly as before.
  return __dirname;
}

const DATA_DIR = resolveDataDir();
const DB_PATH = path.join(DATA_DIR, "delphi.db");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

/**
 * Where the markdown mirror goes.
 *
 * A packaged build puts it in Documents rather than in the data directory,
 * because the whole point of the mirror is that a person opens it in Obsidian or
 * an editor, and nobody browses to Application Support to do that.
 */
function defaultVault() {
  if (process.env.DELPHI_VAULT_DIR) return path.resolve(process.env.DELPHI_VAULT_DIR);
  const app = electronApp();
  if (app && app.isPackaged) {
    try {
      return path.join(app.getPath("documents"), APP_NAME);
    } catch {
      return path.join(DATA_DIR, "vault");
    }
  }
  return path.join(__dirname, "vault");
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
 * Only ever runs when there is no database at the destination, so it cannot
 * overwrite anything, and a failure is logged rather than thrown: starting with
 * an empty tracker beats not starting.
 */
function migrateLegacyDatabase() {
  if (fs.existsSync(DB_PATH)) return null;

  const candidates = [
    path.join(os.homedir(), "delphi", "delphi.db"),        // what the README told people to clone into
    path.join(os.homedir(), "second-brain", "delphi.db"),  // the old repository name
    path.join(os.homedir(), "second-brain", "brain.db"),   // and the old database name with it
  ];

  for (const source of candidates) {
    try {
      if (!fs.existsSync(source)) continue;
      ensureDataDir();
      fs.copyFileSync(source, DB_PATH);
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

module.exports = { APP_NAME, DATA_DIR, DB_PATH, SETTINGS_PATH, defaultVault, ensureDataDir, migrateLegacyDatabase, conventionalDataDir };
