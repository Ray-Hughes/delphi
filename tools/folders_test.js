#!/usr/bin/env node
// One folder per project: the rule, the migration, Add folder, and the
// shared-folder question.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/folders_test.js
//
// - workbench/folders.js on both routes (node:sqlite binding, and the sqlite3
//   binary with values written into the script, as the MCP server does): two
//   projects on one folder leave one in No folder with the other's work
//   untouched, a workspace nobody had becomes a question rather than a project,
//   sessions keep their folder, and the unique index arrives last. Run twice,
//   it does nothing the second time.
// - The resolver: a project in No folder resolves nowhere, a stale primary
//   repos row is not a second answer, a Workbench and a session's own folder
//   win, and a folder that is not on disk is reported as missing.
// - db.js: a folder another project has is refused in a sentence, the folder
//   is normalised, and its repos row moves with it. Give the folder and Keep
//   answer once, and History puts a give back.
// - main/folders.js: what Add folder says about a repository, a subfolder, a
//   worktree, a plain folder, a file, a folder that is already a project and a
//   folderless project with the same name; create, merge, the missing flag.
// - main/backups.js: a snapshot before the migration, reusing the update's.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-folders-")));
process.env.DELPHI_DATA_DIR = path.join(dir, "data");
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "data", "delphi.db");
fs.mkdirSync(process.env.DELPHI_DATA_DIR);
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const sqlite = require("node:sqlite");
const rule = require("../workbench/folders");
const schemaLater = require("../agent/schema_later");

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  } else console.log(`  ok   ${what}`);
}
async function rejects(what, promiseOrFn, pattern) {
  checks++;
  try {
    await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn);
  } catch (error) {
    if (pattern.test(String(error.message))) { console.log(`  ok   ${what}`); return; }
    failures++;
    console.error(`  FAIL ${what}\n       threw ${JSON.stringify(error.message)}\n       want  ${pattern}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${what}\n       did not throw`);
}
const section = (name) => console.log(`\n${name}`);
const mk = (...parts) => { const p = path.join(dir, ...parts); fs.mkdirSync(p, { recursive: true }); return p; };

// --- the two routes ----------------------------------------------------------

function nodeRoute(file) {
  const handle = new sqlite.DatabaseSync(file);
  const bind = (q) => String(q).replace(/:p(\d+)/g, "?$1");
  return {
    handle,
    sql: (q, params = []) => handle.prepare(bind(q)).all(...params),
    batch: (statements) => {
      handle.exec("SAVEPOINT b");
      try { for (const [q, p] of statements) handle.prepare(bind(q)).all(...(p || [])); handle.exec("RELEASE b"); }
      catch (error) { handle.exec("ROLLBACK TO b"); handle.exec("RELEASE b"); throw error; }
    },
  };
}

function findSqlite() {
  for (const c of [process.env.DELPHI_SQLITE, "/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"]) if (c && fs.existsSync(c)) return c;
  return "sqlite3";
}
const SQLITE = findSqlite();
const literal = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
};
const render = (q, params = []) => String(q).replace(/:p(\d+)/g, (m, n) => (Number(n) - 1 < params.length ? literal(params[Number(n) - 1]) : m));
function binaryRoute(file) {
  const run = (lines) => {
    const script = path.join(dir, `q-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
    fs.writeFileSync(script, lines.join("\n"));
    try { return execFileSync(SQLITE, [file], { input: `.read ${script}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim(); }
    finally { fs.rmSync(script, { force: true }); }
  };
  return {
    sql: (q, params = []) => {
      const s = render(q, params);
      const out = run(["PRAGMA synchronous = FULL;", ".timeout 5000", ".mode json", ".headers on", s.endsWith(";") ? s : `${s};`]);
      return out ? JSON.parse(out) : [];
    },
    batch: (statements) => {
      run(["PRAGMA synchronous = FULL;", ".timeout 5000", ".bail on", "BEGIN IMMEDIATE;",
        ...statements.map(([q, p]) => { const s = render(q, p); return s.trim().endsWith(";") ? s : `${s};`; }), "COMMIT;"]);
    },
  };
}

// --- a database from before the migration ------------------------------------

const P = mk("va", "caseflow");
const Q = mk("va", "bip-appeals-config");
const W3 = mk("va", "appeals-performance");
const U = mk("va", "caseflow-efolder");
const X = mk("va", "veteran-api");

function fixture(file) {
  const h = new sqlite.DatabaseSync(file);
  h.exec("PRAGMA journal_mode = WAL");
  schemaLater.apply((s) => h.prepare(s).all());
  h.exec(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
  const ins = (q, ...v) => h.prepare(q).run(...v);
  ins("INSERT INTO projects (id, key, name, path, created_at) VALUES (1, 'ssnr-mpi', 'SSNR / MPI Person Update', ?, '2026-08-11 03:20:40')", `${P}/`);
  ins("INSERT INTO projects (id, key, name, path, created_at) VALUES (8, 'co-hearing-address', 'Central Office hearing address (APREQ-987)', ?, '2026-08-13 00:46:52')", P);
  ins("INSERT INTO projects (id, key, name, path) VALUES (2, 'changeit', 'changeit', ?)", Q);
  ins("INSERT INTO projects (id, key, name) VALUES (3, 'perf', 'Appeals performance')");
  ins("INSERT INTO projects (id, key, name) VALUES (6, 'general', 'General')");
  for (const [id, key, p, icon] of [[2, "caseflow", P, null], [3, "bip", Q, null], [5, "perf", W3, "chart"], [6, "efolder", U, null], [7, "vetapi", X, null]]) {
    ins("INSERT INTO workspaces (id, key, name, path, icon) VALUES (?, ?, ?, ?, ?)", id, key, key, p, icon);
  }
  for (const [pid, wid, primary] of [[1, 2, 1], [8, 2, 1], [2, 3, 1], [3, 5, 1], [2, 7, 0]]) ins("INSERT INTO project_workspaces (project_id, workspace_id, is_primary) VALUES (?, ?, ?)", pid, wid, primary);
  for (let i = 0; i < 3; i++) ins("INSERT INTO tasks (project_id, title, status) VALUES (1, ?, 'todo')", `task ${i}`);
  ins("INSERT INTO notes (project_id, title, body) VALUES (8, 'the address', 'body')");
  ins("INSERT INTO sessions (id, project_id, workspace_id, title) VALUES (2, 1, 2, 'older session')");
  ins("INSERT INTO sessions (id, project_id, cwd, title) VALUES (3, 8, ?, 'co session')", P);
  ins("INSERT INTO repos (project_id, name, path, is_primary, base_branch) VALUES (8, 'caseflow', ?, 0, 'master')", P);
  h.close();
}

async function migrationOn(name, makeRoute) {
  section(`the migration, ${name}`);
  const file = path.join(dir, `${name.replace(/\W+/g, "-")}.db`);
  fixture(file);
  const r = makeRoute(file);
  check("needed before it runs", rule.needsAdoption(r.sql), true);
  const did = rule.adoptFolders({ sql: r.sql, batch: r.batch, now: () => new Date("2026-11-06T12:00:00Z") });
  const paths = Object.fromEntries(r.sql("SELECT id, path FROM projects ORDER BY id", []).map((p) => [p.id, p.path]));
  check("SSNR keeps caseflow, normalised", paths[1], P);
  check("Central Office is in No folder", paths[8], null);
  check("a project with only a workspace takes its folder", paths[3], W3);
  check("the others are as they were", [paths[2], paths[6]], [Q, null]);
  check("one conflict, settled by what each holds", did.conflicts.map((c) => [c.folder, c.kept.id, c.moved.map((m) => m.id)]), [[P, 1, [8]]]);
  const q = rule.conflicts(r.sql);
  check("Needs you has the question", q.map((c) => [c.path, c.state, c.detail.kept.name, c.detail.moved[0].notes]), [[P, "new", "SSNR / MPI Person Update", 1]]);
  check("the repos row it gave up is written down, settings and all", q[0].detail.repos.map((x) => [x.project_id, x.base_branch]), [[8, "master"]]);
  check("and gone, so no resolver hands Central Office the folder", r.sql("SELECT COUNT(*) AS n FROM repos WHERE project_id = 8", [])[0].n, 0);
  check("its link to the caseflow workspace is gone too", r.sql("SELECT COUNT(*) AS n FROM project_workspaces WHERE project_id = 8", [])[0].n, 0);
  check("Central Office keeps its note and its session", [r.sql("SELECT COUNT(*) AS n FROM notes WHERE project_id = 8", [])[0].n, r.sql("SELECT cwd FROM sessions WHERE id = 3", [])[0].cwd], [1, P]);
  check("the workspace nobody had is asked about, not made a project",
    [r.sql("SELECT via, state FROM discovered_folders WHERE path = :p1", [U])[0], r.sql("SELECT COUNT(*) AS n FROM projects", [])[0].n], [{ via: "migration", state: "new" }, 5]);
  check("a session with only a workspace gets its folder", r.sql("SELECT cwd FROM sessions WHERE id = 2", [])[0].cwd, P);
  check("each folder has its primary repos row",
    r.sql("SELECT project_id, path FROM repos WHERE is_primary = 1 ORDER BY project_id", []).map((x) => [x.project_id, x.path]), [[1, P], [2, Q], [3, W3]]);
  check("the other workspace becomes an also-works-in folder", r.sql("SELECT path FROM repos WHERE project_id = 2 AND is_primary = 0", []).map((x) => x.path), [X]);
  check("the workspace icon goes where the project had none", r.sql("SELECT icon FROM projects WHERE id = 3", [])[0].icon, "chart");
  check("recorded, and the unique index made", [Boolean(r.sql("SELECT value FROM meta WHERE key = 'folders_adopted'", [])[0]), did.index.ok,
    r.sql("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_projects_path'", [])[0].n], [true, true, 1]);
  check("no longer needed", rule.needsAdoption(r.sql), false);
  const again = rule.adoptFolders({ sql: r.sql, batch: r.batch });
  check("a second run does nothing", [again.ran, r.sql("SELECT COUNT(*) AS n FROM repos", [])[0].n, r.sql("SELECT COUNT(*) AS n FROM discovered_folders", [])[0].n], [false, 4, 2]);
  await rejects("the index refuses a second project on a folder", () => r.sql("UPDATE projects SET path = :p1 WHERE id = 8", [P]), /UNIQUE/);
  check("the resolver: SSNR works in caseflow", rule.folderFor(r.sql, { projectId: 1 }).path, P);
  check("Central Office has no folder", rule.folderFor(r.sql, { projectId: 8 }), { path: null, source: null, missing: null });
  check("changeit: its folder, then the one it also works in", rule.projectFolders(r.sql, 2).map((f) => [f.path, f.source]), [[Q, "project"], [X, "repo"]]);
  if (r.handle) r.handle.close();
}

async function main() {
  section("normalise");
  check("a trailing slash goes", rule.normalise(`${P}/`), P);
  check("~ is the home folder", rule.normalise("~/"), fs.realpathSync(os.homedir()));
  const link = path.join(dir, "link-to-caseflow");
  fs.symlinkSync(P, link);
  check("a link is the folder it points at", rule.normalise(link), P);
  check("a folder that is not there keeps its spelling", rule.normalise(path.join(dir, "gone") + "/"), path.join(dir, "gone"));
  check("nothing is nothing", [rule.normalise(""), rule.normalise(null)], [null, null]);

  await migrationOn("node:sqlite", nodeRoute);
  await migrationOn("sqlite3 binary", binaryRoute);

  section("a tie goes to the older project");
  {
    const file = path.join(dir, "tie.db");
    const h = new sqlite.DatabaseSync(file);
    schemaLater.apply((s) => h.prepare(s).all());
    h.exec(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
    h.prepare("INSERT INTO projects (id, key, name, path, created_at) VALUES (1, 'b', 'Newer', ?, '2026-09-01')").run(P);
    h.prepare("INSERT INTO projects (id, key, name, path, created_at) VALUES (2, 'a', 'Older', ?, '2026-08-01')").run(P);
    h.close();
    const r = nodeRoute(file);
    const did = rule.adoptFolders(r);
    check("the older keeps it", did.conflicts[0].kept.name, "Older");
    r.handle.close();
  }

  // --- db.js and the window's half --------------------------------------------

  const db = require("../db");
  db.handle();
  section("db.js: the folder is written in one place");
  check("a fresh database is adopted and indexed at open", [db.folderAdoption().ran, db.folderAdoption().index.ok], [true, true]);
  const A = mk("work", "alpha");
  const B = mk("work", "beta");
  const a = db.createProject({ key: "alpha", name: "Alpha", path: `${A}/` });
  check("created with its folder normalised", a.path, A);
  check("and its primary repos row", db.sqlP("SELECT path, is_primary FROM repos WHERE project_id = :p1", [a.id]), [{ path: A, is_primary: 1 }]);
  await rejects("a second project on the folder is refused by name", () => db.createProject({ key: "alpha2", name: "Alpha two", path: A }), /already Alpha's project/);
  const b = db.createProject({ key: "beta", name: "Beta" });
  await rejects("so is moving one onto it", () => db.updateProject(b.id, { path: A }), /already Alpha's project/);
  db.updateProject(a.id, { path: B });
  check("changing the folder moves the repos row with it", db.sqlP("SELECT path, is_primary FROM repos WHERE project_id = :p1", [a.id]), [{ path: B, is_primary: 1 }]);
  db.updateProject(a.id, { path: A });

  section("the resolver");
  db.createRepo({ projectId: b.id, name: "stale", path: B, isPrimary: 1 });
  check("a primary row is no folder for a project with none", rule.projectFolders(db.sqlP, b.id), []);
  db.createRepo({ projectId: b.id, name: "helper", path: B, isPrimary: 0 });
  check("an also-works-in row is", rule.projectFolders(db.sqlP, b.id).map((f) => [f.path, f.source]), [[B, "repo"]]);
  check("a session's own folder wins", rule.folderFor(db.sqlP, { sessionCwd: "/somewhere", projectId: a.id }).source, "session");
  const t = db.createTask({ projectId: a.id, title: "work" });
  check("a task with no Workbench runs in its project's folder", rule.folderFor(db.sqlP, { taskId: t.id, live: () => null }), { path: A, source: "project", missing: null });
  check("a live Workbench wins", rule.folderFor(db.sqlP, { taskId: t.id, live: () => ({ state: "active", path: B }) }).source, "workbench");
  const gone = mk("work", "gone");
  const g = db.createProject({ key: "gone", name: "Gone", path: gone });
  fs.rmSync(gone, { recursive: true });
  check("a folder that is not on disk is named as missing", rule.folderFor(db.sqlP, { projectId: g.id }), { path: null, source: null, missing: gone });

  section("the shared-folder question");
  const c = db.createProject({ key: "central", name: "Central Office hearing address (APREQ-987)" });
  db.createNote({ projectId: c.id, title: "address", body: "b" });
  const ask = (pathFor) => Number(db.sqlP(`INSERT INTO discovered_folders (path, via, state, project_id, detail) VALUES (:p1, 'conflict', 'new', :p2, :p3) RETURNING id`,
    [pathFor, a.id, JSON.stringify({ kept: { id: a.id, name: a.name }, moved: [{ id: c.id, name: c.name }] })])[0].id);
  const q1 = ask(A);
  db.keepFolderAnswer(q1);
  await rejects("answered once, never twice", () => db.keepFolderAnswer(q1), /answered already/);
  db.sqlP("DELETE FROM discovered_folders WHERE id = :p1", [q1]);
  const q2 = ask(A);
  const given = db.giveFolder(q2, c.id);
  check("give swaps the folder", [db.getProject(a.id).path, db.getProject(c.id).path, given.from], [null, A, a.id]);
  check("and Alpha no longer resolves there", rule.folderFor(db.sqlP, { projectId: a.id }).path, null);
  check("answered", db.sqlP("SELECT state FROM discovered_folders WHERE id = :p1", [q2])[0].state, "given");
  const undone = db.undoLast(2);
  check("History puts it back", [undone.undone, db.getProject(a.id).path, db.getProject(c.id).path], [2, A, null]);

  section("Add folder (main/folders.js)");
  const git = require("../workbench/git");
  const { createFolders, ownerRepo } = require("../main/folders");
  const GIT = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  const repo = mk("code", "caseflow-efolder");
  GIT(repo, "init", "-q", "-b", "main");
  GIT(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first");
  GIT(repo, "remote", "add", "origin", "git@github.com:department-of-veterans-affairs/caseflow-efolder.git");
  mk("code", "caseflow-efolder", "app", "models");
  const tree = path.join(dir, "code", "caseflow-efolder.workbenches", "12-fix");
  GIT(repo, "worktree", "add", "-q", "-b", "wb/12", tree);
  const plain = mk("code", "notes");
  fs.writeFileSync(path.join(plain, "a.txt"), "x");
  let picked = null;
  const folders = createFolders({ db, git, pick: async () => picked });
  const look = await folders.inspect(repo);
  check("a repository: its remote, branch, a name and a key",
    [look.ok, look.isGit, look.top, look.ownerRepo, look.defaultBranch, look.suggestedName, look.suggestedKey, look.existing, look.subfolder, look.worktreeOf],
    [true, true, repo, "department-of-veterans-affairs/caseflow-efolder", "main", "caseflow-efolder", "caseflow-efolder", null, false, null]);
  const sub = await folders.inspect(path.join(repo, "app", "models"));
  check("a subfolder offers the repository root", [sub.top, sub.subfolder], [repo, true]);
  const wt = await folders.inspect(tree);
  check("a Workbench offers its main repository", [wt.top, Boolean(wt.worktreeOf), wt.subfolder], [repo, true, false]);
  const notGit = await folders.inspect(plain);
  check("a plain folder is allowed, without git", [notGit.ok, notGit.isGit, notGit.remote], [true, false, null]);
  const file = await folders.inspect(path.join(plain, "a.txt"));
  check("a file is refused in a sentence", [file.ok, file.notFolder, /is a file/.test(file.why)], [false, true, true]);
  check("the picker cancelled is nothing", await folders.inspect(null), { cancelled: true });
  const same = db.createProject({ key: "efolder", name: "caseflow efolder" });
  const matched = await folders.inspect(repo);
  check("a folderless project with the name is offered", matched.matches.map((m) => m.id), [same.id]);
  const made = await folders.create({ path: repo, name: "eFolder", key: "efolder-app" });
  check("create: the project, its folder, its repos row with what git said",
    [made.path, db.sqlP("SELECT remote_url, default_branch FROM repos WHERE project_id = :p1 AND is_primary = 1", [made.id])[0]],
    [repo, { remote_url: "git@github.com:department-of-veterans-affairs/caseflow-efolder.git", default_branch: "main" }]);
  check("History has the create", db.sqlP("SELECT action, entity FROM audit WHERE entity = 'project' AND entity_id = :p1", [made.id]), [{ action: "create", entity: "project" }]);
  const again = await folders.inspect(tree);
  check("a folder that is already a project names it", again.existing, { id: made.id, name: "eFolder", archived: false });
  await rejects("and creating it twice is refused", () => folders.create({ path: repo, name: "Again" }), /already eFolder's project/);
  check("owner/repo from https too", ownerRepo("https://github.com/a/b.git"), "a/b");
  const listed = folders.listProjects();
  check("the list says which folder is missing", [listed.find((p) => p.id === g.id).folder_missing, listed.find((p) => p.id === made.id).folder_missing, listed.find((p) => p.id === made.id).owner_repo],
    [true, false, "department-of-veterans-affairs/caseflow-efolder"]);
  picked = plain;
  check("the picker's choice is inspected", (await folders.inspect(null)).top, plain);

  section("merge");
  db.createSession({ projectId: c.id, title: "co chat" });
  db.sqlP("DELETE FROM discovered_folders WHERE id = :p1", [q2]);
  const q3 = ask(A);
  const merged = folders.merge(q3, c.id);
  check("everything moves and Central Office is archived, not deleted",
    [merged.merged, db.sqlP("SELECT COUNT(*) AS n FROM notes WHERE project_id = :p1", [a.id])[0].n, db.sqlP("SELECT COUNT(*) AS n FROM sessions WHERE project_id = :p1", [a.id])[0].n, db.getProject(c.id).status],
    [true, 1, 1, "archived"]);
  check("answered as merged", db.sqlP("SELECT state FROM discovered_folders WHERE id = :p1", [q3])[0].state, "merged");
  check("each move is in History", db.sqlP("SELECT COUNT(*) AS n FROM audit WHERE summary LIKE '%moved%' OR summary LIKE '%Moved%'", [])[0].n >= 2, true);

  section("a snapshot before the migration (main/backups.js)");
  const { createBackups } = require("../main/backups");
  const old = path.join(dir, "old", "delphi.db");
  fs.mkdirSync(path.dirname(old));
  fixture(old);
  const backups = createBackups({ dataDir: path.dirname(old), dbPath: old, source: () => null, sqlite });
  const shot = await backups.beforeMigration({ needs: rule.needsAdoption });
  const inShot = new sqlite.DatabaseSync(shot.file, { readOnly: true });
  check("taken, of the file as it was", [path.basename(shot.file).startsWith("before-folders-"), inShot.prepare("SELECT COUNT(*) AS n FROM projects WHERE path IS NOT NULL").get().n], [true, 3]);
  inShot.close();
  check("the update's snapshot is reused when there is one", await backups.beforeMigration({ needs: rule.needsAdoption, reuse: shot.file }), { file: shot.file, reused: true });
  const r = nodeRoute(old);
  rule.adoptFolders(r);
  r.handle.close();
  check("none once it has run", await backups.beforeMigration({ needs: rule.needsAdoption }), null);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
