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
// then opens it. A kill at any point of that is finished by the launch after;
// see applyPending for how.
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

/**
 * A file's bytes on the disk, not just in the page cache, before anything is
 * renamed onto it: a rename can reach the disk before the data it names, and a
 * power cut then leaves the right name on an empty file.
 */
function fsyncFile(file) {
  const fd = fs.openSync(file, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * The folder's list of names on the disk, which is what makes a rename durable.
 * Windows cannot open a folder to sync it, and its renames are journalled by
 * NTFS anyway, so there this does nothing.
 */
function fsyncDir(folder) {
  let fd = null;
  try { fd = fs.openSync(folder, "r"); fs.fsyncSync(fd); } catch {} finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
}

/** A JSON file replaced whole: written beside, synced, renamed over. Never half one and half the other. */
function writeNote(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fsyncFile(temp);
  fs.renameSync(temp, file);
  fsyncDir(path.dirname(file));
}

/** A name nothing has yet, so a second move into one folder never lands on the first. */
function free(file) {
  if (!fs.existsSync(file)) return file;
  for (let n = 2; ; n++) if (!fs.existsSync(`${file}.${n}`)) return `${file}.${n}`;
}

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
    writeNote(path.join(dataDir, PENDING), { from, pre, asked: now().toISOString(), phase: "asked" });
    return { from, pre };
  }

  /**
   * The second half, at launch, before the database is opened.
   *
   * Written so that a kill at any point (a crash, a force quit, a power cut)
   * leaves something the next launch can finish, and never an empty live path:
   *
   *   1. The snapshot is copied in beside the live file as .restoring.partial,
   *      fsynced, and renamed to .restoring. A .restoring is always whole.
   *   2. The live -wal and -shm are moved into backups/replaced-<stamp>/, and
   *      the live file is linked (or copied, across disks) in beside them.
   *      The live file itself stays where it is.
   *   3. .restoring is renamed over the live path: one atomic step from the
   *      old file to the new one, with no -wal left beside it for SQLite to
   *      replay into a file it does not belong to.
   *
   * The note says which step was reached, rewritten atomically after each, and
   * is removed only once the swap is done. A note found at launch is a restore
   * that has not finished, and this carries it on from where it got to. A
   * failure that is not a kill (the backup has gone, the disk is full) puts back
   * anything this launch moved and then drops the note, because nothing has
   * changed and asking again is the person's call; if putting back fails too,
   * the note stays so the next launch tries again.
   *
   * step(name) is called after each step, for the test that kills the process
   * at every one of them. Nothing else passes it.
   */
  function applyPending({ step = () => {} } = {}) {
    const note = path.join(dataDir, PENDING);
    const incoming = `${dbPath}.restoring`;
    const partial = `${incoming}.partial`;
    const home = path.dirname(dbPath);
    let asked = null;
    try { asked = JSON.parse(fs.readFileSync(note, "utf8")); } catch (error) {
      if (error.code !== "ENOENT") {
        // A note is written whole or not at all (writeNote), so one that does
        // not parse was not written by this. Kept aside rather than obeyed.
        try { fs.renameSync(note, `${note}.unreadable`); } catch {}
        return { ok: false, error: "the restore note could not be read" };
      }
      tidyStrays();
      return null;
    }
    if (!asked || typeof asked !== "object") asked = {};
    const result = (extra) => ({ from: asked.from || null, pre: asked.pre || null, ...extra });
    const aside = asked.aside && path.dirname(asked.aside) === dir ? asked.aside : path.join(dir, `replaced-${stamp(now())}`);
    let phase = asked.phase || "asked";
    // What this launch moved, so a failure can put back exactly that.
    const moved = [];
    let linked = null;
    try {
      // A swap that happened, with only the bookkeeping left undone. With the
      // note still at "aside" and .restoring gone, the live file is the one
      // that was .restoring exactly when it has the same inode; anything else
      // is .restoring lost some other way, and the restore starts over.
      if (phase === "swapped" || (phase === "aside" && !fs.existsSync(incoming) && swapped())) return finish();
      if (phase !== "asked" && !fs.existsSync(incoming)) phase = "asked";

      if (phase === "asked") {
        if (!asked.from || !fs.existsSync(asked.from)) throw new Error("the backup it named is no longer there");
        try { fs.rmSync(partial, { force: true }); } catch {}
        fs.copyFileSync(asked.from, partial);
        step("partial");
        fsyncFile(partial);
        if (fs.statSync(partial).size !== fs.statSync(asked.from).size) throw new Error("the copy came out a different size from the backup");
        fs.renameSync(partial, incoming);
        fsyncDir(home);
        step("copied");
        asked = { ...asked, phase: "copied", aside, ino: fs.statSync(incoming).ino };
        writeNote(note, asked);
        step("noted-copied");
        phase = "copied";
      }

      if (phase === "copied") {
        fs.mkdirSync(aside, { recursive: true });
        for (const suffix of ["-wal", "-shm"]) {
          if (!fs.existsSync(dbPath + suffix)) continue;
          const to = free(path.join(aside, path.basename(dbPath) + suffix));
          fs.renameSync(dbPath + suffix, to);
          moved.push([to, dbPath + suffix]);
          step(`moved${suffix}`);
        }
        const keep = path.join(aside, path.basename(dbPath));
        if (fs.existsSync(dbPath) && !fs.existsSync(keep)) {
          // A second name for the same file, which costs nothing and survives
          // the rename below. A data folder on another disk from backups/ (a
          // DELPHI_DB elsewhere) cannot link, and gets a whole copy instead.
          try { fs.linkSync(dbPath, keep); } catch {
            fs.copyFileSync(dbPath, `${keep}.partial`);
            fsyncFile(`${keep}.partial`);
            fs.renameSync(`${keep}.partial`, keep);
          }
          linked = keep;
          step("linked");
        }
        fsyncDir(aside);
        fsyncDir(home);
        writeNote(note, { ...asked, phase: "aside", aside });
        step("noted-aside");
        phase = "aside";
      }

      // A -wal or -shm that turned up beside the live file since step 2 (an
      // older launch that was killed part way) would be replayed into the
      // restored file. It is the old file's, so it goes with the old file.
      for (const suffix of ["-wal", "-shm"]) {
        if (!fs.existsSync(dbPath + suffix)) continue;
        fs.mkdirSync(aside, { recursive: true });
        const to = free(path.join(aside, path.basename(dbPath) + suffix));
        fs.renameSync(dbPath + suffix, to);
        moved.push([to, dbPath + suffix]);
      }
      fs.renameSync(incoming, dbPath);
      fsyncDir(home);
      step("swapped");
      return finish();
    } catch (error) {
      const why = String(error.message || error);
      let undone = true;
      // Back to "asked" before anything else, so a note that outlives this
      // can never read as a swap that happened once .restoring is gone.
      if (phase !== "asked") { try { writeNote(note, { ...asked, phase: "asked", aside }); } catch { undone = false; } }
      for (const [to, from] of moved.reverse()) {
        try { if (!fs.existsSync(from)) fs.renameSync(to, from); } catch { undone = false; }
      }
      // And what an earlier, killed launch moved: a live file without its -wal
      // would open without its newest rows.
      for (const suffix of ["-wal", "-shm"]) {
        const to = path.join(aside, path.basename(dbPath) + suffix);
        try { if (fs.existsSync(to) && !fs.existsSync(dbPath + suffix)) fs.renameSync(to, dbPath + suffix); } catch { undone = false; }
      }
      if (linked) { try { fs.rmSync(linked, { force: true }); } catch {} }
      try { fs.rmdirSync(aside); } catch {}
      for (const f of [partial, incoming]) {
        try { fs.rmSync(f, { force: true }); } catch (e) { if (fs.existsSync(f)) undone = false; }
      }
      if (undone) { try { fs.rmSync(note, { force: true }); fsyncDir(dataDir); } catch {} }
      return result({ ok: false, error: undone ? why : `${why}; it will be tried again at the next launch` });
    }

    function swapped() {
      // Windows can report no inode at all; there the older rule stands.
      if (!asked.ino) return true;
      try { return fs.statSync(dbPath).ino === asked.ino; } catch { return false; }
    }

    function finish() {
      try { fs.rmSync(note, { force: true }); } catch {}
      fsyncDir(dataDir);
      step("done");
      return result({ ok: true, aside, at: now().toISOString() });
    }
  }

  /**
   * With no note there is no restore under way, so a .restoring.partial is a
   * copy that never finished and goes. A whole .restoring goes too while the
   * live file is there; with the live file missing it is left for orphaned(),
   * because then it may be the only copy of anything.
   */
  function tidyStrays() {
    const incoming = `${dbPath}.restoring`;
    try { fs.rmSync(`${incoming}.partial`, { force: true }); } catch {}
    if (fs.existsSync(dbPath)) { try { fs.rmSync(incoming, { force: true }); } catch {} }
  }

  /**
   * At launch, with no restore pending: no database at the live path, but a
   * restore's replaced-* folder holding one. That is a restore that stopped
   * half way under an older Delphi (which moved the live file out before the
   * new one was in), and opening now would make an empty database and hide
   * the real one. Null when there is a database, or nothing to put back.
   */
  function orphaned() {
    if (fs.existsSync(dbPath)) return null;
    const base = path.basename(dbPath);
    let folders = [];
    try { folders = fs.readdirSync(dir).filter((f) => /^replaced-/.test(f)); } catch {}
    const found = [];
    for (const f of folders) {
      const file = path.join(dir, f, base);
      try {
        const st = fs.statSync(file);
        if (st.isFile()) found.push({ folder: path.join(dir, f), file, at: st.mtime.toISOString(), wal: fs.existsSync(`${file}-wal`) });
      } catch {}
    }
    if (!found.length) return null;
    found.sort((a, b) => b.folder.localeCompare(a.folder));
    return { dbPath, replaced: found, strayWal: fs.existsSync(`${dbPath}-wal`), incoming: fs.existsSync(`${dbPath}.restoring`) };
  }

  /**
   * Puts a replaced-* folder's database back at the live path, copied so the
   * folder keeps its copy. Its -wal goes first and the file last, by rename:
   * a kill part way leaves no database and orphaned() asks again, never a
   * database without the -wal that holds its newest rows. A -wal or -shm
   * already at the live path belongs to nothing that is there and is moved
   * into the folder, under a name of its own, before anything is copied.
   */
  function setAsideOnly(folder) {
    if (typeof folder !== "string" || path.dirname(folder) !== dir || !/^replaced-/.test(path.basename(folder))) throw new Error("That is not a folder a restore set aside.");
  }

  /**
   * A -wal or -shm at the live path with no database there, moved into the
   * restore's folder under a name of its own: SQLite would otherwise replay it
   * into whatever file is made or put back next. Also what starting empty does
   * first, so the new database starts empty in fact.
   */
  function moveStrays(folder) {
    setAsideOnly(folder);
    if (fs.existsSync(dbPath)) return;
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(dbPath + suffix)) fs.renameSync(dbPath + suffix, free(path.join(folder, `stray${suffix}`)));
    }
  }

  function putBack(folder) {
    setAsideOnly(folder);
    if (fs.existsSync(dbPath)) throw new Error("There is a database there already.");
    const base = path.basename(dbPath);
    const file = path.join(folder, base);
    if (!fs.existsSync(file)) throw new Error("That folder has no database in it.");
    const home = path.dirname(dbPath);
    fs.mkdirSync(home, { recursive: true });
    moveStrays(folder);
    if (fs.existsSync(`${file}-wal`)) {
      fs.copyFileSync(`${file}-wal`, `${dbPath}-wal.partial`);
      fsyncFile(`${dbPath}-wal.partial`);
      fs.renameSync(`${dbPath}-wal.partial`, `${dbPath}-wal`);
    }
    fs.copyFileSync(file, `${dbPath}.partial`);
    fsyncFile(`${dbPath}.partial`);
    fs.renameSync(`${dbPath}.partial`, dbPath);
    fsyncDir(home);
    try { fs.rmSync(`${dbPath}.restoring`, { force: true }); } catch {}
    return { ok: true, from: file };
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

  return { dir, snapshot, named, daily, prune, list, preview, requestRestore, applyPending, orphaned, putBack, moveStrays, beforeOpen, beforeMigration, counts };
}

module.exports = { createBackups, localDay, KEEP_DAILY, KEEP_NAMED_DAYS };
