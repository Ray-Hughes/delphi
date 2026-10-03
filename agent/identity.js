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
 * It also carries the app's heartbeat. A handoff is only ever run by a Delphi
 * app's dispatcher, so an agent handing work over deserves to know whether one
 * is running against this database, rather than being told it will be woken by
 * something that does not exist.
 *
 * Shared by db.js and the MCP server, like agent/schema_later.js: handed a
 * function that runs ONE statement and returns rows, so it works on the
 * server's sqlite3 route as well as on node:sqlite. Values are written into the
 * text as literals, the way the server's own sql() does, because the binary
 * route has nothing to bind against.
 */

const crypto = require("crypto");
const os = require("os");

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
 * INSERT OR IGNORE, so two processes opening a fresh file at the same moment
 * both write and only the first lands: they then read back the same id. That
 * is the only race here, and it needs no transaction, which the binary route
 * could not give anyway.
 *
 * Returns { db_id: null, created_at: null } when the file has no meta table,
 * which is a file that is not a Delphi database yet. Nothing is created in it.
 */
function ensure(query) {
  if (!hasMeta(query)) return { db_id: null, created_at: null };
  query(`INSERT OR IGNORE INTO meta (key, value) VALUES ('db_id', ${literal(crypto.randomUUID())})`);
  query(`INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', ${literal(new Date().toISOString())})`);
  return current(query);
}

/** The identity without minting one, for a reader that must not write. */
function current(query) {
  if (!hasMeta(query)) return { db_id: null, created_at: null };
  return { db_id: read(query, "db_id"), created_at: read(query, "created_at") };
}

/** Records that an app is running against this file, now. */
function beat(query, { pid = process.pid, host = os.hostname(), version = null, now = new Date() } = {}) {
  const value = JSON.stringify({ pid, host, version, at: now.toISOString() });
  query(`INSERT INTO meta (key, value) VALUES ('app_heartbeat', ${literal(value)}) ` +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value");
}

/**
 * Takes this app's beat away on the way out, so an agent is told at once that
 * nothing is dispatching rather than up to 90 seconds later.
 *
 * Only a beat this process wrote. A second launch that is about to quit, or an
 * app on another machine sharing the file, must not erase the running one's.
 */
function clearBeat(query, { pid = process.pid, host = os.hostname() } = {}) {
  query("DELETE FROM meta WHERE key = 'app_heartbeat' " +
        `AND json_extract(value, '$.pid') = ${Number(pid)} AND json_extract(value, '$.host') = ${literal(host)}`);
}

/**
 * Whether an app is running against this database, honestly.
 *
 * A fresh beat is the evidence. On this machine a dead pid overrules it: an app
 * that crashed a minute ago left a fresh beat and runs nothing. isAlive is
 * handed in (sheet/store.js has one) so this file stays free of process probing.
 *
 * Returns { running, pid, host, version, last_seen, age_seconds, reason }.
 */
function appState(query, { now = new Date(), isAlive = null, host = os.hostname() } = {}) {
  let beatValue = null;
  try {
    if (hasMeta(query)) beatValue = read(query, "app_heartbeat");
  } catch {}
  if (!beatValue) {
    return { running: false, pid: null, host: null, version: null, last_seen: null, age_seconds: null,
      reason: "No Delphi app has run against this database since it last quit." };
  }
  let b = {};
  try { b = JSON.parse(beatValue) || {}; } catch {}
  const at = Date.parse(b.at);
  const age = Number.isFinite(at) ? Math.max(0, Math.round((now.getTime() - at) / 1000)) : null;
  const base = { pid: b.pid ?? null, host: b.host ?? null, version: b.version ?? null, last_seen: b.at ?? null, age_seconds: age };
  if (age === null || age * 1000 > STALE_MS) {
    return { running: false, ...base, reason: `The Delphi app last checked in at ${b.at || "an unknown time"} and has not since.` };
  }
  if (isAlive && b.host === host && b.pid && !isAlive(b.pid)) {
    return { running: false, ...base, reason: `The Delphi app that last checked in (pid ${b.pid}) is no longer running.` };
  }
  return { running: true, ...base, reason: null };
}

module.exports = { BEAT_MS, STALE_MS, ensure, current, beat, clearBeat, appState, hasMeta };
