/**
 * Where the database is. One answer, worked out the same way by every process.
 *
 * There used to be two rules. paths.js said "run from a checkout, the database
 * is beside the source", and the MCP server said "the installed copy wins when
 * it exists". Both were reasonable alone. Together they meant `npm start` read
 * one file while every agent and the delphi command wrote another, nothing
 * errored, and work written by an agent simply never appeared in the window. A
 * person running the checkout and the installed app at once had two trackers,
 * two schedulers and two handoff dispatchers, and a handoff went to whichever
 * one happened to look first.
 *
 * So there is one rule, and it lives here, shared rather than twinned for the
 * reason CLAUDE.md gives: two copies of a rule disagree within a month, and the
 * disagreement surfaces as lost work rather than as an error.
 *
 *   1. DELPHI_DB names the file. The data folder is DELPHI_DATA_DIR if that is
 *      set too, otherwise the folder the file is in.
 *   2. DELPHI_DATA_DIR names the folder, and the file is delphi.db inside it.
 *   3. Otherwise the per-user data folder, packaged or not.
 *
 * A checkout's neighbouring delphi.db is never chosen by this. It is only
 * reported, so the app, the server and `delphi doctor` can say it is being
 * ignored instead of leaving someone to wonder where their tasks went.
 *
 * Plain Node, fs/path/os only, so the server can run it under whatever Node an
 * editor launched it with, and it can be read from outside app.asar.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_NAME = "Delphi";
const DB_FILE = "delphi.db";

/**
 * The per-user data folder, worked out without Electron.
 *
 * The same places `app.getPath("userData")` returns for an app named Delphi,
 * which is what lets a plain Node process find the database the app is using.
 * Arguments are injectable so the tests can ask about another platform without
 * pretending to be on it.
 */
function conventionalDataDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", APP_NAME);
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), APP_NAME);
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), APP_NAME);
}

/** The checkout this file belongs to. Inside an installed app this is Resources/, which has no database. */
const CHECKOUT_DIR = path.resolve(__dirname, "..");

/** Compared through realpath where the file exists, so /var and /private/var are one place. */
function samePath(a, b) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
}

/**
 * Resolves the data folder and the database.
 *
 * Returns { dataDir, dbPath, source, conventional, checkoutDb, checkoutDbIgnored }.
 * source says which rule decided ("DELPHI_DB", "DELPHI_DATA_DIR" or "default").
 * checkoutDbIgnored is the path of a checkout database that exists and is not
 * the one in use, or null.
 */
function resolve({ env = process.env, platform = process.platform, home = os.homedir(), checkoutDir = CHECKOUT_DIR } = {}) {
  const conventional = conventionalDataDir({ env, platform, home });
  let dataDir;
  let dbPath;
  let source;
  if (env.DELPHI_DB) {
    dbPath = path.resolve(env.DELPHI_DB);
    dataDir = env.DELPHI_DATA_DIR ? path.resolve(env.DELPHI_DATA_DIR) : path.dirname(dbPath);
    source = "DELPHI_DB";
  } else if (env.DELPHI_DATA_DIR) {
    dataDir = path.resolve(env.DELPHI_DATA_DIR);
    dbPath = path.join(dataDir, DB_FILE);
    source = "DELPHI_DATA_DIR";
  } else {
    dataDir = conventional;
    dbPath = path.join(dataDir, DB_FILE);
    source = "default";
  }
  const checkoutDb = path.join(checkoutDir, DB_FILE);
  let checkoutDbIgnored = null;
  try {
    if (fs.existsSync(checkoutDb) && !samePath(checkoutDb, dbPath)) checkoutDbIgnored = checkoutDb;
  } catch {}
  return { dataDir, dbPath, source, conventional, checkoutDb, checkoutDbIgnored };
}

/**
 * The sentence every process prints about an ignored checkout database.
 *
 * One wording, so the app, the server and the command line read the same and a
 * search for it finds all three.
 */
function ignoredNotice(resolved) {
  if (!resolved.checkoutDbIgnored) return null;
  return `delphi: a database exists beside the source at ${resolved.checkoutDbIgnored}, and it is not used. ` +
    `Delphi uses ${resolved.dbPath}. Nothing reads or writes the checkout copy any more; ` +
    `move it aside once anything in it you still want has been brought across.`;
}

/**
 * Where Electron keeps its own profile (cookies, local storage, the
 * single-instance lock) for this data folder.
 *
 * null means leave Electron's default alone, which is the per-user folder
 * itself. A data folder chosen by override gets a profile inside it instead, so
 * the single-instance lock is per database: two apps on one database cannot
 * run, while a test's hidden app on a temp folder, or a developer's app on a
 * separate dev folder, never collides with the one in use. An override that
 * names the per-user folder anyway is the same database, so it keeps the
 * default profile and the same lock.
 */
function electronProfileDir(resolved) {
  if (resolved.source === "default" || samePath(resolved.dataDir, resolved.conventional)) return null;
  return path.join(resolved.dataDir, "electron-profile");
}

module.exports = { APP_NAME, DB_FILE, CHECKOUT_DIR, conventionalDataDir, resolve, ignoredNotice, electronProfileDir, samePath };
