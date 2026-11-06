/**
 * Which database this is, and whether an app is looking after it.
 *
 * Nothing in a Delphi database used to say which one it was. Two files that
 * descend from one copy look the same to every process that opens them, so an
 * agent writing to the wrong one had no way to notice, and neither did a
 * person. The `meta` table gives each file a db_id, minted once and never
 * changed, that the app shows, the server reports in whoami, and an agent
 * launched by the app is held to through DELPHI_DB_ID.
 *
 * The app's heartbeat is NOT in the database. It was, for one commit, and every
 * beat was a write another connection could see: PRAGMA data_version moved, so
 * every other Delphi app on the file took it for an agent's write and rebuilt
 * the vault, ran its dispatcher and refreshed the window under the reader,
 * every 30 seconds. So it is a small JSON file beside the database instead,
 * replaced whole by rename, which nothing watching the database notices.
 *
 * The meta half is handed a function that runs ONE statement and returns rows,
 * like agent/schema_later.js, so it works on the server's sqlite3 route as well
 * as on node:sqlite. Values are written into the text as literals, the way the
 * server's own sql() does, because the binary route has nothing to bind against.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// How long after its last beat an app still counts as running. The app beats
// every 30 seconds; three missed beats is a stopped app, not a slow one.
const BEAT_MS = 30 * 1000;
const STALE_MS = 3 * BEAT_MS;

const literal = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

function hasMeta(query) {
  return (query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'") || []).length > 0;
}

function read(query, key) {
  const row = (query(`SELECT value FROM meta WHERE key = ${literal(key)}`) || [])[0];
  return row ? row.value : null;
}

/**
 * Mints db_id and created_at if they are missing, and returns both.
 *
 * Looks before it writes, so a file that already has its id is not written at
 * all. INSERT OR IGNORE for the first mint, so two processes opening a fresh
 * file at the same moment both try and only the first lands: they then read
 * back the same id, with no transaction, which the binary route could not give.
 *
 * Returns { db_id: null, created_at: null } when the file has no meta table,
 * which is a file that is not a Delphi database yet. Nothing is created in it.
 */
function ensure(query) {
  if (!hasMeta(query)) return { db_id: null, created_at: null };
  const have = current(query);
  if (!have.db_id) query(`INSERT OR IGNORE INTO meta (key, value) VALUES ('db_id', ${literal(crypto.randomUUID())})`);
  if (!have.created_at) query(`INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', ${literal(new Date().toISOString())})`);
  // The heartbeat row the one build that kept it here may have left. A delete
  // that matches nothing does not move data_version, so this is free after once.
  query("DELETE FROM meta WHERE key = 'app_heartbeat'");
  return have.db_id && have.created_at ? have : current(query);
}

/** The identity without minting one, for a reader that must not write. */
function current(query) {
  if (!hasMeta(query)) return { db_id: null, created_at: null };
  return { db_id: read(query, "db_id"), created_at: read(query, "created_at") };
}

// --- the heartbeat file ------------------------------------------------------

/**
 * Where an app's heartbeat for this database lives.
 *
 * In the data folder, named for the database: app.alive.json for the usual
 * delphi.db, and a name carrying a hash of the path for any other file, so two
 * databases in one folder never share a beat. Never named delphi.db*, which
 * the app's folder watch treats as a database write.
 */
function aliveFile(resolved) {
  const standard = path.resolve(resolved.dbPath) === path.join(path.resolve(resolved.dataDir), "delphi.db");
  if (standard) return path.join(resolved.dataDir, "app.alive.json");
  const hash = crypto.createHash("sha1").update(path.resolve(resolved.dbPath)).digest("hex").slice(0, 10);
  return path.join(resolved.dataDir, `app.alive.${hash}.json`);
}

/**
 * Records that this app is running against the database, now.
 *
 * Written to a temporary name and renamed over the old one, so a reader never
 * sees half a file. db_id is the one this app's open handle reports, which is
 * how a refused server can tell "the app is on another file than the one at
 * this path" from "the agent was launched for some other database".
 */
function writeAlive(resolved, { pid = process.pid, host = os.hostname(), version = null, dbId = null, started = null, now = new Date() } = {}) {
  const file = aliveFile(resolved);
  const body = JSON.stringify({
    pid, host, version, db_id: dbId, db_path: path.resolve(resolved.dbPath),
    started: started || now.toISOString(), last_seen: now.toISOString(),
  });
  const temp = `${file}.${pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, body);
  fs.renameSync(temp, file);
  return file;
}

function readAlive(resolved) {
  try {
    return JSON.parse(fs.readFileSync(aliveFile(resolved), "utf8")) || null;
  } catch {
    return null;
  }
}

/**
 * Takes this app's beat away on the way out, so an agent is told at once that
 * nothing is dispatching rather than up to 90 seconds later. Only a beat this
 * process wrote: a second launch about to quit must not erase the first's.
 */
function clearAlive(resolved, { pid = process.pid, host = os.hostname() } = {}) {
  const beat = readAlive(resolved);
  if (!beat || beat.pid !== pid || beat.host !== host) return false;
  try { fs.rmSync(aliveFile(resolved), { force: true }); } catch { return false; }
  return true;
}

/**
 * Command lines of processes that may be a Delphi app without a heartbeat:
 * an installed build from before there was one, or a checkout's app.
 *
 * One `ps` call. Windows has no cheap equivalent, so there it is null, meaning
 * "cannot tell". DELPHI_PS_FIXTURE replaces the process list with a JSON array
 * of command lines, which is how the tests prove both answers on a machine
 * that has, or has not, got Delphi open.
 */
function delphiProcesses({ selfPid = process.pid } = {}) {
  let lines;
  if (process.env.DELPHI_PS_FIXTURE !== undefined) {
    try { lines = JSON.parse(process.env.DELPHI_PS_FIXTURE).map((c, i) => `${900000 + i} ${c}`); } catch { lines = []; }
  } else {
    if (process.platform === "win32") return null;
    try {
      lines = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024 }).split("\n");
    } catch {
      return null;
    }
  }
  const found = [];
  for (const line of lines) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m || Number(m[1]) === selfPid) continue;
    const command = m[2];
    const app = /Delphi\.app\/Contents\/MacOS\/Delphi(\s|$)/.test(command) ||
      /\/node_modules\/electron\/dist\/(Electron\.app\/Contents\/MacOS\/Electron|electron)(\s|$)/.test(command) ||
      // Linux: electron-builder names the packaged binary in lower case.
      /^\S*\/delphi(\s|$)/.test(command);
    // The same binaries run the MCP server, the CLI and the tests as Node, and
    // those name a script; an app is launched with no script, or with a folder.
    // Chromium helper processes carry --type= and are not the app.
    if (app && !/\.(c|m)?js(\s|$)|\s-e\s|--type=/.test(command)) found.push({ pid: Number(m[1]), command });
  }
  return found;
}

/**
 * Whether an app is running against this database, as honestly as it can be
 * said: true, false or "unknown".
 *
 * A fresh beat for this file from a live process is true. Without one, a
 * process that looks like a Delphi app makes it "unknown", because an app from
 * before heartbeats, or one on another database, looks the same from here. Only
 * when there is no beat and no such process is it false, and on Windows, where
 * processes are not looked at, it is "unknown" rather than a guess.
 *
 * Returns { running, pid, version, last_seen, age_seconds, reason }.
 */
function appState(resolved, { now = new Date(), isAlive = null, host = os.hostname(), processes = delphiProcesses } = {}) {
  const beat = readAlive(resolved);
  let age = null;
  let base = { pid: null, version: null, last_seen: null, age_seconds: null };
  let why = "No Delphi app has checked in for this database since it last quit.";
  if (beat && (!beat.db_path || path.resolve(beat.db_path) === path.resolve(resolved.dbPath))) {
    const at = Date.parse(beat.last_seen);
    age = Number.isFinite(at) ? Math.max(0, Math.round((now.getTime() - at) / 1000)) : null;
    base = { pid: beat.pid ?? null, version: beat.version ?? null, last_seen: beat.last_seen ?? null, age_seconds: age };
    const dead = isAlive && beat.host === host && beat.pid && !isAlive(beat.pid);
    if (age !== null && age * 1000 <= STALE_MS && !dead) return { running: true, ...base, reason: null };
    why = dead
      ? `The Delphi app that last checked in (pid ${beat.pid}) is no longer running.`
      : `The Delphi app last checked in at ${beat.last_seen || "an unknown time"} and has not since.`;
  }
  const seen = processes();
  if (seen === null) {
    return { running: "unknown", ...base, reason: `${why} Whether an older Delphi app is open cannot be checked on this system.` };
  }
  if (seen.length) {
    return { running: "unknown", ...base,
      reason: `${why} But a Delphi app process is running (pid ${seen.map((p) => p.pid).join(", ")}); it may be a version from before heartbeats, or on another database.` };
  }
  return { running: false, ...base, reason: `${why} No Delphi app process is running.` };
}

module.exports = {
  BEAT_MS, STALE_MS, ensure, current, hasMeta,
  aliveFile, writeAlive, readAlive, clearAlive, delphiProcesses, appState,
};
