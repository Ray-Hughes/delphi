#!/usr/bin/env node
// Crash recovery: how the last run ended, snapshots, restore, drafts and place.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/recovery_test.js
//
// - main/recovery.js: a heartbeat left behind by a dead pid on this host is an
//   unclean exit; no heartbeat, a live pid or another host's is not. The runs
//   it lists are the interrupted ones, with whether their agent still lives.
// - main/backups.js: seven dailies are kept and named ones for 30 days, the
//   preview counts both files, a restore swaps the file in at the next launch
//   with the old one kept, and an update is snapshotted before it migrates.
// - agent/mcp_server.js: a server whose file was replaced under it refuses,
//   in words, on both routes.
// - ui/recovery.js, against a stub localStorage: a draft survives a reload and
//   goes once saved; old drafts are dropped; the place survives a reload.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-recovery-")));
process.env.DELPHI_DATA_DIR = path.join(dir, "data");
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "data", "delphi.db");
fs.mkdirSync(process.env.DELPHI_DATA_DIR);
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const sqlite = require("node:sqlite");
const { lastExit, createRecovery } = require("../main/recovery");
const { createBackups, localDay } = require("../main/backups");

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  } else console.log(`  ok   ${what}`);
}
function section(name) { console.log(`\n${name}`); }

function heartbeat() {
  section("main/recovery.js: how the last run ended");
  const host = "this-mac";
  const dead = () => false;
  const alive = () => true;
  check("no heartbeat: a clean exit", lastExit(null, { host, isAlive: dead }).unclean, false);
  check("a dead pid on this host: unclean", lastExit({ pid: 4242, host, last_seen: "2026-11-06T05:00:00Z" }, { host, isAlive: dead }),
    { unclean: true, lastSeen: "2026-11-06T05:00:00Z", version: null });
  check("a live pid: another app on this database, not a crash", lastExit({ pid: 4242, host }, { host, isAlive: alive }).unclean, false);
  check("another machine's heartbeat says nothing about this one", lastExit({ pid: 4242, host: "other" }, { host, isAlive: dead }).unclean, false);

  const rows = {
    7: { id: 7, state: "failed", task_id: 3, to_harness: "claude-code", agent_pid: 999, request: "Work task 3", task_title: "Fix the thing" },
    8: { id: 8, state: "failed", task_id: null, to_harness: "codex", agent_pid: null, request: "Look at the logs\nand more", task_title: null },
  };
  const sql = (_q, [id]) => (rows[id] ? [rows[id]] : []);
  const pidsAlive = new Set([999]);
  const r = createRecovery({ sql, isAlive: (pid) => pidsAlive.has(pid) });
  const seen = r.start({ pid: 1, host }, [7, 8], { host });
  check("the interrupted runs are listed, with their titles", seen.runs.map((x) => [x.id, x.title, x.harness]),
    [[7, "Fix the thing", "claude-code"], [8, "Look at the logs", "codex"]]);
  check("a run whose agent still lives says so", seen.runs.map((x) => x.agentAlive), [true, false]);
  pidsAlive.clear();
  check("and stops saying so once it has exited", r.view().runs[0].agentAlive, false);
  r.done(7);
  check("a handled run leaves the list", r.view().runs.map((x) => x.id), [8]);
  r.dismiss();
  check("dismissed, there is no banner", r.view(), null);
  const clean = createRecovery({ sql, isAlive: () => false });
  check("after a clean exit there is no banner, whatever was interrupted", clean.start(null, [7], { host }), null);
}

function makeDb(file, n) {
  const h = new sqlite.DatabaseSync(file);
  h.exec("PRAGMA journal_mode = WAL");
  h.exec(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT);
          CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT);
          CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS scratchpads (id INTEGER PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`);
  addTasks(h, n);
  return h;
}
function addTasks(h, n) { for (let i = 0; i < n; i++) h.prepare("INSERT INTO tasks (title) VALUES (?)").run(`t${i}`); }

async function snapshots() {
  section("main/backups.js: daily snapshots, kept seven");
  const dataDir = process.env.DELPHI_DATA_DIR;
  const dbPath = process.env.DELPHI_DB;
  const live = makeDb(dbPath, 3);
  live.prepare("INSERT INTO projects (name) VALUES ('p')").run();
  let clock = new Date(2026, 9, 1, 9, 0, 0);
  const b = createBackups({ dataDir, dbPath, source: () => live, sqlite, now: () => clock });
  for (let day = 1; day <= 9; day++) {
    clock = new Date(2026, 9, day, 9, 0, 0);
    await b.daily();
  }
  const dailies = b.list().filter((x) => x.kind === "daily").map((x) => x.day).sort();
  check("nine days of launches leave the newest seven", dailies, ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
  const again = await b.daily();
  check("a second launch on the same day takes none", again, null);
  check("the name is the local day", fs.existsSync(path.join(b.dir, `delphi-${localDay(clock)}.db`)), true);
  check("no half-written file is left behind", fs.readdirSync(b.dir).filter((f) => f.endsWith(".partial")), []);

  section("main/backups.js: named snapshots are kept 30 days");
  const old = await b.named("pre-restore");
  const recent = await b.named("update-1.7.1");
  const longAgo = (clock.getTime() - 31 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(old, longAgo, longAgo);
  b.prune();
  check("a named one older than 30 days goes", fs.existsSync(old), false);
  check("a recent named one stays, whatever the dailies do", fs.existsSync(recent), true);

  section("main/backups.js: the preview");
  addTasks(live, 4);
  const newest = b.list().find((x) => x.kind === "daily");
  const p = b.preview(newest.name);
  check("the snapshot's counts beside the live ones", [p.snapshot.tasks, p.current.tasks, p.snapshot.projects, p.current.projects], [3, 7, 1, 1]);
  check("a table a file lacks counts as unknown, not as an error", typeof p.snapshot.entries, "number");
  let refused = null;
  try { b.preview("../delphi.db"); } catch (error) { refused = error.message; }
  check("only a file in backups/ can be previewed", refused, "That is not one of the backups.");

  section("main/backups.js: a restore, in two halves");
  const asked = await b.requestRestore(newest.name);
  check("the live file is snapshotted first", fs.existsSync(asked.pre) && /pre-restore-/.test(path.basename(asked.pre)), true);
  check("and a note says which one goes in", fs.existsSync(path.join(dataDir, "restore.pending.json")), true);
  live.close();
  const done = b.applyPending();
  check("at the next launch it goes in", done.ok, true);
  check("the note is gone", fs.existsSync(path.join(dataDir, "restore.pending.json")), false);
  const back = new sqlite.DatabaseSync(dbPath);
  check("the file now holds what the snapshot held", Number(back.prepare("SELECT COUNT(*) AS n FROM tasks").get().n), 3);
  back.close();
  check("the replaced file is moved aside, not deleted", fs.existsSync(path.join(done.aside, "delphi.db")), true);
  check("with nothing pending, launching does nothing", b.applyPending(), null);
  const asideAgo = (clock.getTime() - 31 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(done.aside, asideAgo, asideAgo);
  b.prune();
  check("what was moved aside goes after 30 days too", fs.existsSync(done.aside), false);
  fs.writeFileSync(path.join(dataDir, "restore.pending.json"), JSON.stringify({ from: path.join(b.dir, "gone.db") }));
  const failed = b.applyPending();
  check("a note naming a missing backup is said once and dropped", [failed.ok, /no longer there/.test(failed.error), fs.existsSync(path.join(dataDir, "restore.pending.json"))], [false, true, false]);
  check("and the live file is untouched", fs.existsSync(dbPath), true);
  // A copy that fails part way: here the target is a folder, so the rename
  // into place throws after the live files were moved aside.
  const before = fs.readFileSync(dbPath);
  fs.mkdirSync(`${dbPath}.restoring`);
  fs.writeFileSync(path.join(dataDir, "restore.pending.json"), JSON.stringify({ from: path.join(b.dir, newest.name) }));
  const broke = b.applyPending();
  check("a restore that fails part way puts the live file back", [broke.ok, fs.readFileSync(dbPath).equals(before)], [false, true]);
  fs.rmSync(`${dbPath}.restoring`, { recursive: true, force: true });
  fs.writeFileSync(path.join(b.dir, "delphi-2026-01-01.db.partial"), "half");
  const dayAgo = (clock.getTime() - 25 * 3600 * 1000) / 1000;
  fs.utimesSync(path.join(b.dir, "delphi-2026-01-01.db.partial"), dayAgo, dayAgo);
  b.prune();
  check("a snapshot that never finished is cleared a day later", fs.existsSync(path.join(b.dir, "delphi-2026-01-01.db.partial")), false);

  section("main/backups.js: an update is snapshotted before it opens");
  const h = new sqlite.DatabaseSync(dbPath);
  h.prepare("INSERT INTO meta (key, value) VALUES ('app_version', '1.7.1')").run();
  h.close();
  check("the same version: nothing", await b.beforeOpen("1.7.1"), null);
  const up = await b.beforeOpen("2.0.0");
  check("a new version: a snapshot named for the old one", [up.from, up.to, /^update-1\.7\.1-/.test(path.basename(up.file))], ["1.7.1", "2.0.0", true]);
  const fresh = createBackups({ dataDir: path.join(dir, "fresh"), dbPath: path.join(dir, "fresh", "none.db"), source: () => null, sqlite });
  check("no database yet: nothing", await fresh.beforeOpen("2.0.0"), null);
}

async function server() {
  section("agent/mcp_server.js: a file replaced under a running server");
  const { openServer } = require("../sheet/client");
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const [name, env] of [["node:sqlite", {}], ["sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" }]]) {
    const where = path.join(dir, `srv-${name.replace(/\W/g, "")}`);
    fs.mkdirSync(where);
    const dbPath = path.join(where, "delphi.db");
    // A database made the way the app makes one; the server only ever widens.
    const made = new sqlite.DatabaseSync(dbPath);
    made.exec(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
    made.close();
    const c = openServer({ actor: "test", env: { ...env, DELPHI_DATA_DIR: where, DELPHI_DB: dbPath }, clientName: "test", warn: () => {} });
    await c.start();
    try {
      const before = await c.call("list_projects", {});
      check(`${name}: it answers on the file it opened`, Array.isArray(before), true);
      const copy = `${dbPath}.copy`;
      fs.copyFileSync(dbPath, copy);
      fs.renameSync(dbPath, `${dbPath}.aside`);
      fs.renameSync(copy, dbPath);
      let said = null;
      try { await c.call("list_projects", {}); } catch (error) { said = error.message; }
      check(`${name}: and refuses once it was replaced`, said, "Delphi restored a backup. Restart this agent's session.");
    } finally {
      c.close();
    }
  }
}

function renderer() {
  section("ui/recovery.js: drafts and the place, against a stub localStorage");
  const data = new Map();
  globalThis.localStorage = {
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
  const load = () => {
    delete require.cache[require.resolve("../ui/recovery.js")];
    return require("../ui/recovery.js");
  };
  let R = load();
  R.saveDraft("sheet", 15, "half a thought");
  R.remember({ projectId: 1, view: "tasks" });
  R.taskOpened(15);
  R = load();
  check("a draft survives a reload", R.draft("sheet", 15), "half a thought");
  check("the place survives a reload", [R.lastPlace().projectId, R.lastPlace().view, R.lastPlace().taskId], [1, "tasks", 15]);
  R.clearDraft("sheet", 15);
  check("and the draft is gone once it is saved", R.draft("sheet", 15), null);
  R.saveDraft("quick", "all", "   ");
  check("an empty box keeps no draft", R.draft("quick", "all"), null);
  R.saveDraft("flag", 9, "a reply");
  R.saveDraft("flag", 10, "another");
  check("the drafts of one kind can be listed", R.draftsOf("flag").map((d) => d.id).sort(), ["10", "9"]);
  data.set("delphi.draft.desc.3", JSON.stringify({ text: "stale", at: Date.now() - 31 * 24 * 3600 * 1000 }));
  check("a draft untouched for 30 days is dropped at launch", [R.pruneDrafts(), R.draft("desc", 3), R.draft("flag", 9)], [1, null, "a reply"]);
  R.taskClosed();
  R.remember({ projectId: 2, view: "notes" });
  check("moving on forgets the task and the scroll", [R.lastPlace().taskId, R.lastPlace().scroll], [null, 0]);
  delete globalThis.localStorage;
  R = load();
  check("with no storage at all, nothing throws and nothing is kept", [R.draft("sheet", 1), (R.saveDraft("sheet", 1, "x"), R.draft("sheet", 1))], [null, null]);
}

async function main() {
  heartbeat();
  await snapshots();
  await server();
  renderer();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
