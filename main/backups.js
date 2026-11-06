// Snapshots of the database, and putting one back.
//
// The History tab undoes one change at a time, which is the right tool for a
// mistake and the wrong one for a database that is wrong as a whole: a bad
// migration, an agent that wrote nonsense into a hundred rows, a disk that
// lost its last minutes. For those there is a copy of the whole file from
// before, taken every day and before anything big, and kept where nothing else
// writes: DATA_DIR/backups, beside the database and never in git.
//
// A snapshot is SQLite's online backup (node:sqlite backup(), the same
// mechanism as the shell's .backup). It is safe while agents are writing, and
// it includes what is still in the -wal, which a file copy would miss.
//
// Restoring cannot happen under an open database, so it is done in two halves:
// the window asks, this takes a snapshot of the current file first and leaves
// a note saying which one to restore, and the app relaunches. The next launch
// puts the file in place before anything opens it (applyPending), and only
// then opens it.
//
// Required by main.js under Electron, and by tools/recovery_test.js under a
// plain Node with node:sqlite, so it takes everything it touches as arguments.

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const DAILY = /^delphi-(\d{4}-\d{2}-\d{2})\.db$/;
const KEEP_DAILY = 7;
const KEEP_NAMED_DAYS = 30;
const PENDING = "restore.pending.json";

/** A local calendar day, YYYY-MM-DD: a snapshot is "today's" by the clock on the wall. */
function localDay(now) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** A stamp safe in a file name on every platform: no colons. */
function stamp(now) {
  return now.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
}

/**
 * @param dataDir  the data folder; snapshots go in its backups/ folder
 * @param dbPath   the live database
 * @param source   () => the open node:sqlite handle to back up from
 * @param sqlite   require("node:sqlite"), passed in so a test can use its own
 * @param now      () => Date
 */
function createBackups({ dataDir, dbPath, source, sqlite, now = () => new Date() }) {
  const dir = path.join(dataDir, "backups");
  const ensure = () => fs.mkdirSync(dir, { recursive: true });

  /**
   * One snapshot, written under a temporary name and renamed into place, so a
   * half-written file is never listed as a backup.
   */
  async function snapshot(name, from = source()) {
    ensure();
    const target = path.join(dir, name);
    const temp = `${target}.partial`;
    try { fs.rmSync(temp, { force: true }); } catch {}
    await sqlite.backup(from, temp);
    fs.renameSync(temp, target);
    return target;
  }

  /** A snapshot named for what it comes before: "pre-restore", "update-1.7.1". */
  function named(label, from) {
    return snapshot(`${String(label).replace(/[^\w.-]+/g, "-")}-${stamp(now())}.db`, from);
  }

  /** Today's snapshot, unless there is one already. Then the old ones go. */
  async function daily() {
    const name = `delphi-${localDay(now())}.db`;
    let made = null;
    if (!fs.existsSync(path.join(dir, name))) made = await snapshot(name);
    prune();
    return made;
  }

  /**
   * Seven daily snapshots, the newest by the day in their names. A named one
   * (taken before something big) is not a daily and is kept for 30 days
   * whatever happens to the dailies, because it is the one that undoes that
   * one big thing.
   */
  function prune() {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return { removed: [] }; }
    const removed = [];
    const dailies = files.filter((f) => DAILY.test(f)).sort().reverse();
    for (const f of dailies.slice(KEEP_DAILY)) removed.push(f);
    const cutoff = now().getTime() - KEEP_NAMED_DAYS * 24 * 3600 * 1000;
    // A snapshot that never finished (the app stopped part way) is no backup.
    // A day old means nothing is still writing it.
    for (const f of files) {
      if (!f.endsWith(".partial")) continue;
      try { if (fs.statSync(path.join(dir, f)).mtimeMs < now().getTime() - 24 * 3600 * 1000) removed.push(f); } catch {}
    }
    // The files a restore moved aside go on the same 30 days: the pre-restore
    // snapshot already holds what they hold, so they are a second copy.
    for (const f of files) {
      if (DAILY.test(f) || !(f.endsWith(".db") || /^replaced-/.test(f))) continue;
      try { if (fs.statSync(path.join(dir, f)).mtimeMs < cutoff) removed.push(f); } catch {}
    }
    for (const f of removed) { try { fs.rmSync(path.join(dir, f), { force: true, recursive: true }); } catch {} }
    return { removed };
  }

  /** Every snapshot, newest first. */
  function list() {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".db")); } catch { return []; }
    return files.map((name) => {
      const st = fs.statSync(path.join(dir, name));
      const day = name.match(DAILY);
      return { name, kind: day ? "daily" : "named", day: day ? day[1] : null, at: st.mtime.toISOString(), size: st.size };
    }).sort((a, b) => b.at.localeCompare(a.at) || b.name.localeCompare(a.name));
  }

  /** What a file holds, in the words a person checks a restore by. */
  function counts(handle) {
    const n = (table) => {
      try { return Number(handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n); } catch { return null; }
    };
    return { projects: n("projects"), tasks: n("tasks"), notes: n("notes"), pads: n("scratchpads"), entries: n("comments") };
  }

  /** A snapshot by name, refusing anything that is not a plain file in backups/. */
  function resolve(name) {
    if (typeof name !== "string" || name !== path.basename(name) || !name.endsWith(".db")) throw new Error("That is not one of the backups.");
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) throw new Error("That backup is no longer there.");
    return file;
  }

  /** The snapshot's counts beside the live ones, so a restore is chosen knowingly. */
  function preview(name) {
    const file = resolve(name);
    // Immutable: a snapshot is never written, and a plain read-only open of a
    // WAL file with no -shm beside it fails rather than reads.
    const handle = new sqlite.DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
    try {
      const entry = list().find((b) => b.name === name);
      return { name, at: entry ? entry.at : null, snapshot: counts(handle), current: counts(source()) };
    } finally {
      handle.close();
    }
  }

  /**
   * The first half of a restore: the live file is snapshotted, then a note
   * records which snapshot goes in. The caller relaunches the app.
   */
  async function requestRestore(name) {
    const from = resolve(name);
    const pre = await named("pre-restore");
    fs.writeFileSync(path.join(dataDir, PENDING), JSON.stringify({ from, pre, asked: now().toISOString() }));
    return { from, pre };
  }

  /**
   * The second half, at launch, before the database is opened. The live file
   * and its -wal and -shm are moved aside rather than deleted (the pre-restore
   * snapshot already holds them, and this is a second copy for nothing), and
   * the snapshot is copied in. The note is removed whatever happens, so a
   * restore that cannot be done is said once rather than tried on every launch.
   */
  function applyPending() {
    const note = path.join(dataDir, PENDING);
    let asked = null;
    try { asked = JSON.parse(fs.readFileSync(note, "utf8")); } catch { return null; }
    try { fs.rmSync(note, { force: true }); } catch {}
    // Copied in beside the live file first, so a full disk or a crash part way
    // never leaves the live path empty or half written; only a complete copy is
    // renamed into place, and if anything fails the moved files go back.
    const incoming = `${dbPath}.restoring`;
    const moved = [];
    try {
      if (!asked || !fs.existsSync(asked.from)) throw new Error("the backup it named is no longer there");
      fs.copyFileSync(asked.from, incoming);
      const aside = path.join(dir, `replaced-${stamp(now())}`);
      fs.mkdirSync(aside, { recursive: true });
      for (const suffix of ["", "-wal", "-shm"]) {
        if (!fs.existsSync(dbPath + suffix)) continue;
        const to = path.join(aside, path.basename(dbPath) + suffix);
        fs.renameSync(dbPath + suffix, to);
        moved.push([to, dbPath + suffix]);
      }
      fs.renameSync(incoming, dbPath);
      return { ok: true, from: asked.from, pre: asked.pre, aside };
    } catch (error) {
      for (const [to, from] of moved.reverse()) { try { fs.renameSync(to, from); } catch {} }
      try { fs.rmSync(incoming, { force: true }); } catch {}
      return { ok: false, from: asked && asked.from, pre: asked && asked.pre, error: String(error.message || error) };
    }
  }

  /**
   * Whether this launch is a new version on an existing file, read before the
   * file is opened (and so before it is migrated), and if so a snapshot of it
   * as the old version left it. The version is the app's own record in meta;
   * a file with tasks and no record was last opened by a version from before
   * the record, which is an update too.
   */
  async function beforeOpen(version) {
    if (!fs.existsSync(dbPath)) return null;
    let handle = null;
    try {
      // Not read only. A read-only open of a WAL file with no -wal beside it
      // cannot create the -shm it needs and fails, which would read as "no
      // version" and skip the snapshot; an ordinary open changes nothing until
      // something writes, and nothing here does.
      handle = new sqlite.DatabaseSync(dbPath);
      let last = null;
      try { last = (handle.prepare("SELECT value FROM meta WHERE key = 'app_version'").get() || {}).value || null; } catch {}
      if (last === version) return null;
      let tasks = 0;
      try { tasks = Number(handle.prepare("SELECT COUNT(*) AS n FROM tasks").get().n); } catch {}
      if (!last && !tasks) return null;
      const file = await named(`update-${last || "earlier"}`, handle);
      return { from: last, to: version, file };
    } finally {
      if (handle) handle.close();
    }
  }

  /**
   * A snapshot before the folder migration (workbench/folders.js) runs, read
   * before the file is opened the way beforeOpen is. needs is that file's
   * needsAdoption, asked of this handle. The update snapshot, when this launch
   * took one, is the same file a moment earlier, so it is reused rather than
   * the database copied twice. Returns { file } or null when nothing will
   * migrate; throws when a snapshot was needed and could not be made, so the
   * caller can hold the migration back.
   */
  async function beforeMigration({ needs, reuse = null, label = "before-folders" }) {
    if (!fs.existsSync(dbPath)) return null;
    let handle = null;
    try {
      handle = new sqlite.DatabaseSync(dbPath);
      const query = (q, params = []) => handle.prepare(String(q).replace(/:p(\d+)/g, "?$1")).all(...params);
      if (!needs(query)) return null;
      if (reuse && fs.existsSync(reuse)) return { file: reuse, reused: true };
      return { file: await named(label, handle) };
    } finally {
      if (handle) handle.close();
    }
  }

  return { dir, snapshot, named, daily, prune, list, preview, requestRestore, applyPending, beforeOpen, beforeMigration, counts };
}

module.exports = { createBackups, localDay, KEEP_DAILY, KEEP_NAMED_DAYS };
