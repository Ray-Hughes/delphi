#!/usr/bin/env node
// A folder is several projects', and a project several folders' (slice 4b).
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/shared_folders_test.js
//
// - Many to many in db.js: two projects with one Home, a linked folder added,
//   made Home and taken off, the old Home kept as linked, Home refused as a
//   removal, History undoing each, and a task's own folder (tasks.repo_id).
// - Slice 4's split put back, on both routes, from a database the way slice
//   4 left it: the moved project has its folder back as Home with its repos
//   row's settings, one whose folders a person changed since is left and the
//   row says so, a "Give the folder to" answer gives it back to the one that
//   gave it up, a merge is left alone, the unique index goes, and a second
//   run does nothing.
// - The resolver (workbench/route.js) on both routes, step by step: what
//   launched the agent, a Workbench, a ticket or key in the branch, then in
//   the latest commit, the most recent activity in the folder, then Home.
// - The MCP server, started in a shared folder on a branch naming a ticket,
//   filing a task with no project into the right one, saying how, and
//   recording it for the "Filed under" chip; a Move settles it. Both routes.
// - Workbench Start: the task's own folder, else Home.
// - Discovery: every active project offered, several at once, the likely one
//   suggested.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-shared-folders-")));
process.env.DELPHI_DATA_DIR = path.join(dir, "data");
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "data", "delphi.db");
process.env.DELPHI_DISCOVERY_TEMP = "";
fs.mkdirSync(process.env.DELPHI_DATA_DIR);
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const sqlite = require("node:sqlite");
const rule = require("../workbench/folders");
const route = require("../workbench/route");
const discover = require("../workbench/discover");
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
async function rejects(what, fn, pattern) {
  checks++;
  try { await fn(); } catch (error) {
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
const GIT = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
function repoAt(folder, branch = "main") {
  fs.mkdirSync(folder, { recursive: true });
  GIT(folder, "init", "-q", "-b", "main");
  GIT(folder, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first");
  if (branch !== "main") GIT(folder, "checkout", "-q", "-b", branch);
  return folder;
}

// --- the two routes, as the MCP server runs them ------------------------------

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
    close: () => handle.close(),
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
    close: () => {},
  };
}
const ROUTES = [["node:sqlite", nodeRoute], ["sqlite3 binary", binaryRoute]];

function fresh(file) {
  const h = new sqlite.DatabaseSync(file);
  h.exec("PRAGMA journal_mode = WAL");
  schemaLater.apply((s) => h.prepare(s).all());
  h.exec(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
  return h;
}

// --- a database as slice 4 left it --------------------------------------------

const P = mk("va", "caseflow");
const Q = mk("va", "bip-appeals-config");
const R = mk("va", "veteran-api");

/**
 * Slice 4's split, written as slice 4 wrote it: SSNR kept caseflow, Central
 * Office and Hearings were moved to No folder with their repos rows deleted
 * and written into the row's detail, Hearings had its folder changed by hand
 * after the split, and a second folder's question was answered "Give the
 * folder to" Veterans, which took it from Benefits. A third was merged.
 */
function splitFixture(file) {
  const h = fresh(file);
  const ins = (q, ...v) => h.prepare(q).run(...v);
  ins("INSERT INTO meta (key, value) VALUES ('folders_adopted', '2026-11-01T12:00:00.000Z')");
  ins("INSERT INTO projects (id, key, name, path, created_at) VALUES (1, 'ssnr-mpi', 'SSNR / MPI Person Update', ?, '2026-08-11 03:20:40')", P);
  ins("INSERT INTO projects (id, key, name, path, created_at) VALUES (8, 'co-hearing-address', 'Central Office hearing address (APREQ-987)', NULL, '2026-08-13 00:46:52')");
  ins("INSERT INTO projects (id, key, name, path) VALUES (9, 'hearings', 'Hearings', ?)", Q);
  ins("INSERT INTO projects (id, key, name, path) VALUES (10, 'benefits', 'Benefits', NULL)");
  ins("INSERT INTO projects (id, key, name, path) VALUES (11, 'veterans', 'Veterans', ?)", R);
  ins("INSERT INTO projects (id, key, name, path, status) VALUES (12, 'old', 'Old work', NULL, 'archived')");
  ins("INSERT INTO repos (project_id, name, path, is_primary) VALUES (1, 'caseflow', ?, 1)", P);
  ins("INSERT INTO repos (project_id, name, path, is_primary) VALUES (9, 'bip', ?, 1)", Q);
  ins("INSERT INTO repos (project_id, name, path, is_primary) VALUES (11, 'vetapi', ?, 1)", R);
  ins("INSERT INTO workspaces (id, key, name, path) VALUES (2, 'caseflow', 'caseflow', ?)", P);
  ins("INSERT INTO project_workspaces (project_id, workspace_id, is_primary) VALUES (1, 2, 1)");
  const at = "2026-11-01T12:00:00.000Z";
  ins(`INSERT INTO discovered_folders (path, seen_by, via, state, project_id, detail, first_seen) VALUES (?, 'migration', 'conflict', 'new', 1, ?, '2026-11-01 12:00:00')`, P,
    JSON.stringify({ at, kept: { id: 1, name: "SSNR / MPI Person Update" },
      moved: [{ id: 8, name: "Central Office hearing address (APREQ-987)" }, { id: 9, name: "Hearings" }],
      repos: [{ project_id: 8, name: "caseflow", path: P, base_branch: "master", setup_cmd: "bin/setup", copy_files: ".env" }] }));
  // Hearings: moved, then a person gave it another folder by hand.
  ins(`INSERT INTO audit (at, action, entity, entity_id, summary, label, before_json, after_json, actor, actor_type)
       VALUES ('2026-11-02 09:00:00', 'update', 'project', 9, 'changed the folder', 'Hearings', ?, ?, 'you', 'human')`,
    JSON.stringify({ id: 9, path: null }), JSON.stringify({ id: 9, path: Q }));
  // Veterans took veteran-api from Benefits by "Give the folder to"; the
  // answer's own History rows are on the question.
  const give1 = Number(ins(`INSERT INTO audit (at, action, entity, entity_id, summary, label, before_json, after_json, actor, actor_type)
       VALUES ('2026-11-02 10:00:00', 'update', 'project', 10, 'changed the folder', 'Benefits', ?, ?, 'you', 'human')`,
    JSON.stringify({ id: 10, path: R }), JSON.stringify({ id: 10, path: null })).lastInsertRowid);
  const give2 = Number(ins(`INSERT INTO audit (at, action, entity, entity_id, summary, label, before_json, after_json, actor, actor_type)
       VALUES ('2026-11-02 10:00:00', 'update', 'project', 11, 'changed the folder', 'Veterans', ?, ?, 'you', 'human')`,
    JSON.stringify({ id: 11, path: null }), JSON.stringify({ id: 11, path: R })).lastInsertRowid);
  ins(`INSERT INTO discovered_folders (path, seen_by, via, state, project_id, detail, first_seen) VALUES (?, 'migration', 'conflict', 'given', 10, ?, '2026-11-01 12:00:00')`, R,
    JSON.stringify({ at, kept: { id: 10, name: "Benefits" }, moved: [{ id: 11, name: "Veterans" }], repos: [], answer_audit: [give1, give2] }));
  ins(`INSERT INTO discovered_folders (path, seen_by, via, state, project_id, detail) VALUES ('/va/merged', 'migration', 'conflict', 'merged', 1, ?)`,
    JSON.stringify({ at, kept: { id: 1 }, moved: [{ id: 12, name: "Old work" }] }));
  // The index slice 4 made once no folder was shared.
  h.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_path ON projects(path) WHERE path IS NOT NULL");
  h.close();
}

async function rejoinOn(name, makeRoute) {
  section(`slice 4's split put back, ${name}`);
  const file = path.join(dir, `split-${name.replace(/\W+/g, "-")}.db`);
  splitFixture(file);
  const r = makeRoute(file);
  check("a split still to put back is a migration, so the app snapshots first", rule.needsAdoption(r.sql), true);
  // As the server and the app both do on open: schema_later first.
  schemaLater.apply((s) => r.sql(s, []));
  check("schema_later drops slice 4's unique index on either route", r.sql("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_projects_path'", [])[0].n, 0);
  const did = rule.adoptFolders({ sql: r.sql, batch: r.batch, now: () => new Date("2026-11-06T12:00:00Z") });
  const paths = Object.fromEntries(r.sql("SELECT id, path FROM projects ORDER BY id", []).map((p) => [p.id, p.path]));
  check("SSNR and Central Office both have caseflow as Home", [paths[1], paths[8]], [P, P]);
  check("each resolves there", [rule.folderFor(r.sql, { projectId: 1 }).path, rule.folderFor(r.sql, { projectId: 8 }).path], [P, P]);
  check("Central Office's repos row is back, with the settings it left with",
    r.sql("SELECT is_primary, base_branch, setup_cmd, copy_files FROM repos WHERE project_id = 8", []),
    [{ is_primary: 1, base_branch: "master", setup_cmd: "bin/setup", copy_files: ".env" }]);
  check("and its workspace link", r.sql("SELECT COUNT(*) AS n FROM project_workspaces WHERE project_id = 8 AND workspace_id = 2", [])[0].n, 1);
  check("Hearings, changed by hand since, is left with the folder a person gave it", paths[9], Q);
  check("Give the folder to: Benefits, which gave it up under the old rule, has it back; Veterans keeps it", [paths[10], paths[11]], [R, R]);
  check("a merge is left as it was", r.sql("SELECT state FROM discovered_folders WHERE path = '/va/merged'", [])[0].state, "merged");
  const rows = r.sql("SELECT path, state, detail FROM discovered_folders WHERE via = 'conflict' ORDER BY id", []).map((x) => ({ ...x, detail: JSON.parse(x.detail) }));
  check("the split questions are answered, and nothing asks any more",
    [rows.map((x) => x.state), rule.splitsOpen(r.sql).length], [["rejoined", "rejoined", "merged"], 0]);
  check("the caseflow row says what was done and what was left, and why",
    [rows[0].detail.rejoined.restored.map((x) => [x.id, x.as]), rows[0].detail.rejoined.left.map((x) => [x.id, /changed by hand/.test(x.why)]), /Hearings had its folders changed by hand/.test(rows[0].detail.rejoined.said)],
    [[[8, "home"]], [[9, true]], true]);
  check("the given row names Veterans as having it already", rows[1].detail.rejoined.left.map((x) => [x.id, x.why]), [[11, "has the folder already"]]);
  const history = r.sql("SELECT entity_id, actor, actor_type, summary FROM audit WHERE actor = 'delphi' ORDER BY id", []);
  check("each Home put back is a History row, by Delphi", history.map((x) => [x.entity_id, x.actor_type, /back as its Home/.test(x.summary)]), [[8, "tool", true], [10, "tool", true]]);
  check("the report says so", did.rejoined.map((x) => x.restored.map((y) => y.id)), [[8], [10]]);
  const repos = r.sql("SELECT COUNT(*) AS n FROM repos", [])[0].n;
  // Another process answering a row between the read and the batch: the
  // batch's first statement sees it and nothing is written twice.
  r.sql("UPDATE discovered_folders SET state = 'new' WHERE path = :p1", [P]);
  const racing = rule.rejoin({ sql: (q, p) => (/^UPDATE discovered_folders SET state = 'rejoined'/.test(q) ? [] : r.sql(q, p)),
    batch: (st) => { r.sql("UPDATE discovered_folders SET state = 'rejoined' WHERE path = :p1", [P]); r.batch(st); } });
  check("a row answered meanwhile is skipped, not written twice", [racing.length, r.sql("SELECT COUNT(*) AS n FROM audit WHERE actor = 'delphi'", [])[0].n], [0, 2]);
  const again = rule.adoptFolders({ sql: r.sql, batch: r.batch });
  check("a second run does nothing", [again.ran, again.rejoined.length, r.sql("SELECT COUNT(*) AS n FROM repos", [])[0].n, rule.needsAdoption(r.sql)], [false, 0, repos, false]);
  r.close();
  return file;
}

// --- the resolver --------------------------------------------------------------

function routeFixture(file) {
  const h = fresh(file);
  const ins = (q, ...v) => Number(h.prepare(q).run(...v).lastInsertRowid);
  ins("INSERT INTO projects (id, key, name, path) VALUES (1, 'ssnr-mpi', 'SSNR / MPI Person Update', ?)", P);
  ins("INSERT INTO projects (id, key, name, path) VALUES (8, 'co-hearing-address', 'Central Office hearing address (APREQ-987)', ?)", P);
  ins("INSERT INTO projects (id, key, name, path) VALUES (3, 'perf', 'Appeals performance', ?)", Q);
  ins("INSERT INTO projects (id, key, name) VALUES (4, 'veterans', 'Veterans')");
  ins("INSERT INTO repos (id, project_id, name, path, is_primary) VALUES (1, 1, 'caseflow', ?, 1)", P);
  ins("INSERT INTO repos (id, project_id, name, path, is_primary) VALUES (2, 8, 'caseflow', ?, 1)", P);
  ins("INSERT INTO repos (id, project_id, name, path, is_primary) VALUES (3, 4, 'caseflow', ?, 0)", P);
  ins("INSERT INTO tasks (id, project_id, title, ref) VALUES (50, 8, 'Hearing address', 'VACOLS-12')");
  ins("INSERT INTO tasks (id, project_id, title) VALUES (51, 1, 'Person update')");
  ins("INSERT INTO workbenches (task_id, repo_id, path, branch, base) VALUES (51, 1, ?, 'ray/51-person-update', 'main')", path.join(dir, "va", "caseflow.workbenches", "51-person-update"));
  ins("INSERT INTO handoffs (id, project_id, to_harness, task_id, request) VALUES (70, 1, 'claude', 50, 'do it')");
  ins("INSERT INTO sessions (id, project_id, title, cwd) VALUES (80, 4, 'veterans chat', ?)", P);
  h.close();
}

function resolverOn(name, makeRoute) {
  section(`the resolver, ${name}`);
  const file = path.join(dir, `route-${name.replace(/\W+/g, "-")}.db`);
  routeFixture(file);
  const r = makeRoute(file);
  const go = (facts) => { const x = route.resolve(r.sql, facts); return x ? [x.projectId, x.via, x.guessed] : null; };
  check("(a) a job: its task's project, whatever the folder", go({ jobId: 70, cwd: P, branch: "ssnr/fix" }), [8, "job", false]);
  check("(a) a session: its project", go({ sessionId: 80, cwd: P }), [4, "session", false]);
  check("(a) the harness's project scope", go({ scopeProject: 3, cwd: P }), [3, "scope", false]);
  check("(b) a Workbench folder: its task's project", go({ cwd: path.join(dir, "va", "caseflow.workbenches", "51-person-update", "app") }), [1, "workbench", false]);
  check("(b) a Workbench branch, from the main checkout", go({ cwd: P, branch: "ray/51-person-update" }), [1, "workbench", false]);
  check("(c) a ticket in the branch, against a project's name", go({ cwd: P, branch: "apreq-987-hearing-address" }), [8, "branch", true]);
  check("(c) a ticket in the branch, against a task's ref", go({ cwd: P, branch: "fix/VACOLS-12" }), [8, "branch", true]);
  check("(c) a project key in the branch", go({ cwd: path.join(P, "app", "models"), branch: "ssnr/person-merge" }), [1, "branch", true]);
  check("(c) the latest commit's subject, when the branch says nothing", go({ cwd: P, branch: "main", subject: "APREQ-987: keep the address" }), [8, "commit", true]);
  check("(e) nothing to go on: the oldest Home", go({ cwd: P, branch: "main", subject: "tidy" }), [1, "home", true]);
  // (d): a session working in the folder writes History.
  r.sql("INSERT INTO sessions (id, project_id, title, cwd) VALUES (81, 8, 'co chat', :p1)", [P]);
  r.sql("INSERT INTO audit (at, action, entity, entity_id, summary, session_id) VALUES ('2026-11-06 10:00:00', 'create', 'task', 50, 'created', 81)", []);
  check("(d) the project most recently active in the folder", go({ cwd: P, branch: "main" }), [8, "recent", true]);
  r.sql("INSERT INTO filed_routes (entity, entity_id, project_id, folder, via, created_at, settled_at) VALUES ('task', 51, 1, :p1, 'home', '2026-11-06 11:00:00', '2026-11-06 11:30:00')", [P]);
  check("(d) and a Move a person made there since counts as newer", go({ cwd: P, branch: "main" }), [1, "recent", true]);
  r.sql("INSERT INTO filed_routes (entity, entity_id, project_id, folder, via, created_at) VALUES ('task', 50, 8, :p1, 'home', '2026-11-06 12:00:00')", [P]);
  check("(d) a guess nobody confirmed is no vote for itself", go({ cwd: P, branch: "main" }), [1, "recent", true]);
  check("(c) still beats (d)", go({ cwd: P, branch: "apreq-987" }), [8, "branch", true]);
  check("(c) a ticket is a whole word: VACOLS-1 is not VACOLS-12", go({ cwd: P, branch: "fix/VACOLS-1" })[1] !== "branch", true);
  check("a linked folder counts: three projects share caseflow", route.resolve(r.sql, { cwd: P }).candidates.sort(), [1, 4, 8]);
  check("a branch naming two of them is no answer from the branch", go({ cwd: P, branch: "ssnr-mpi/apreq-987" })[1] !== "branch", true);
  check("a folder only one project has is no guess", go({ cwd: Q, branch: "apreq-987" }), [3, "folder", false]);
  check("a folder no project has is nothing", go({ cwd: path.join(dir, "elsewhere") }), null);
  check("tickets are read in any case", route.tickets("feature/apreq-987_and-CF-12"), ["APREQ-987", "CF-12"]);
  check("a short key word is not a project", [route.keyIn("co-hearing-address", "co/whatever"), route.keyIn("co-hearing-address", "x/co-hearing-address-fix"), route.keyIn("co", "fix/co")], [false, true, false]);
  r.close();
}

// --- the window's half, and the server ---------------------------------------

async function main() {
  await rejoinOn("node:sqlite", nodeRoute);
  await rejoinOn("sqlite3 binary", binaryRoute);
  for (const [name, make] of ROUTES) resolverOn(name, make);

  const db = require("../db");
  db.handle();

  section("many to many (db.js)");
  const A = mk("work", "caseflow");
  const B = mk("work", "caseflow-efolder");
  const C = mk("work", "bip");
  const ssnr = db.createProject({ key: "ssnr", name: "SSNR", path: A });
  const co = db.createProject({ key: "co", name: "Central Office (APREQ-987)", path: `${A}/` });
  check("two projects, one Home folder, no refusal", [ssnr.path, co.path], [A, A]);
  check("holders names both, as Home", rule.holders(db.sqlP, A).map((h) => [h.id, h.home]), [[ssnr.id, true], [co.id, true]]);
  const linked = db.linkFolder(ssnr.id, B);
  const linkAudit = db.newestAudit();
  check("a second folder is linked, not Home", [linked.added, linked.home, db.getProject(ssnr.id).path], [true, false, A]);
  check("and listed after Home, with who else has each", db.projectFolderList(ssnr.id).map((f) => [f.path, f.home, f.also.map((x) => x.id)]), [[A, true, [co.id]], [B, false, []]]);
  check("linking it twice changes nothing", db.linkFolder(ssnr.id, B).added, false);
  const stale = db.createProject({ key: "stale", name: "Stale row" });
  db.createRepo({ projectId: stale.id, name: "kept settings", path: C, isPrimary: 1 });
  db.sqlP("UPDATE repos SET base_branch = 'release' WHERE project_id = :p1", [stale.id]);
  db.updateProject(stale.id, { path: B });
  db.linkFolder(stale.id, C);
  check("a stale row at the folder is re-labelled, settings and all", db.sqlP("SELECT is_primary, base_branch FROM repos WHERE project_id = :p1 AND path = :p2", [stale.id, C]), [{ is_primary: 0, base_branch: "release" }]);
  db.undoLast(1);
  check("and undoing the link puts its label back rather than deleting it", db.sqlP("SELECT COUNT(*) AS n FROM repos WHERE project_id = :p1 AND path = :p2", [stale.id, C])[0].n, 1);
  const none = db.createProject({ key: "none", name: "No folder yet" });
  check("a project's first folder becomes its Home", [db.linkFolder(none.id, C).home, db.getProject(none.id).path], [true, C]);
  db.setHomeFolder(ssnr.id, B);
  check("making another folder Home keeps the old one, linked", db.projectFolderList(ssnr.id).map((f) => [f.path, f.home]), [[B, true], [A, false]]);
  check("and SSNR is still one of caseflow's", rule.holders(db.sqlP, A).map((h) => h.id), [ssnr.id, co.id]);
  db.undoLast(1);
  check("History puts Home back", db.getProject(ssnr.id).path, A);
  await rejects("Home cannot be taken off as a linked folder", () => db.unlinkFolder(ssnr.id, A), /is SSNR's Home/);
  const t = db.createTask({ projectId: ssnr.id, title: "efolder work" });
  const efRow = db.projectFolderList(ssnr.id).find((f) => f.path === B);
  db.updateTask(t.id, { repo_id: efRow.repo_id });
  check("a task names one of its project's folders", rule.folderFor(db.sqlP, { taskId: t.id, live: () => null }), { path: B, source: "task", missing: null });
  const coRow = db.sqlP("SELECT id FROM repos WHERE project_id = :p1", [co.id])[0];
  await rejects("never another project's", () => db.updateTask(t.id, { repo_id: coRow.id }), /not one of this task's project's folders/);
  const off = db.unlinkFolder(ssnr.id, B);
  check("taking the folder off: gone from the list, and the task goes back to Home",
    [off.removed, db.projectFolderList(ssnr.id).map((f) => f.path), db.sqlP("SELECT repo_id FROM tasks WHERE id = :p1", [t.id])[0].repo_id], [1, [A], null]);
  db.undoLast(1);
  check("History puts the folder back, and the task's choice with it",
    [db.projectFolderList(ssnr.id).map((f) => f.path), db.sqlP("SELECT repo_id FROM tasks WHERE id = :p1", [t.id])[0].repo_id], [[A, B], efRow.repo_id]);
  db.undoLast(1); // the task's repo_id
  db.setHomeFolder(ssnr.id, B);
  await rejects("a linked folder made Home since cannot be unlinked by undo", async () => db.undo(linkAudit), /Home now/);
  db.undoLast(1);
  db.undo(linkAudit);
  check("and undoing the link takes it off again", db.projectFolderList(ssnr.id).map((f) => f.path), [A]);
  db.linkFolder(ssnr.id, B);

  section("a moved task keeps its folder when the project it lands in has it");
  db.linkFolder(co.id, B);
  const t2 = db.createTask({ projectId: ssnr.id, title: "moves" });
  db.updateTask(t2.id, { repo_id: db.projectFolderList(ssnr.id).find((f) => f.path === B).repo_id });
  db.items().move("task", t2.id, co.id);
  const coB = db.projectFolderList(co.id).find((f) => f.path === B).repo_id;
  check("Central Office's own row for the folder", db.sqlP("SELECT repo_id FROM tasks WHERE id = :p1", [t2.id])[0].repo_id, coB);

  section("Workbench Start: the task's folder, else Home");
  const git = require("../workbench/git");
  const { makeWorkbenchStore } = require("../workbench/store");
  const { createWorkbench } = require("../workbench/workbench");
  const { makeSheetStore } = require("../sheet/store");
  const { runEntry } = require("../sheet/run");
  const H = repoAt(mk("code", "home-repo"));
  const L = repoAt(mk("code", "linked-repo"));
  const span = db.createProject({ key: "span", name: "Spans two", path: H });
  db.linkFolder(span.id, L);
  const benches = createWorkbench({
    store: makeWorkbenchStore({ sql: db.sqlP, actor: "tester" }), sheet: makeSheetStore({ sql: db.sqlP, actor: "tester", authorType: "human" }),
    runEntry, logDir: path.join(dir, "data", "sheets"), settings: () => ({ workbenchBranchPrefix: "t" }), onEvent: () => {},
  });
  const onHome = db.createTask({ projectId: span.id, title: "on home" });
  const onLinked = db.createTask({ projectId: span.id, title: "on linked" });
  db.updateTask(onLinked.id, { repo_id: db.projectFolderList(span.id).find((f) => f.path === L).repo_id });
  const s1 = await benches.start(onHome.id, { runSetup: false });
  const s2 = await benches.start(onLinked.id, { runSetup: false });
  const repoPath = (id) => db.sqlP("SELECT path FROM repos WHERE id = :p1", [id])[0].path;
  check("a task naming no folder starts in Home", repoPath(s1.workbench.repo_id), H);
  check("a task naming one starts there", repoPath(s2.workbench.repo_id), L);
  check("and its folder is the linked repository's Workbench folder", path.basename(path.dirname(s2.workbench.path)), "linked-repo.workbenches");
  void git;

  section("discovery offers every project, several at once, and suggests one");
  const found = mk("code", "apreq-987-tools");
  repoAt(found, "apreq-987-script");
  db.sqlP(`INSERT INTO discovered_folders (path, seen_by, via, state, detail) VALUES (:p1, 'claude-code:5', 'session', 'new', :p2)`,
    [found, JSON.stringify({ harness: "Claude Code", branch: "apreq-987-script" })]);
  check("attachable: every active project, folders or not", discover.attachable(db.sqlP).map((p) => p.id).includes(ssnr.id), true);
  const { createFolders } = require("../main/folders");
  const folders = createFolders({ db, git: require("../workbench/git") });
  const q = folders.discoveries().find((d) => d.path === found);
  check("the likely one, from the branch's ticket", [q.suggested, q.suggestedWhy], [co.id, "from branch"]);
  check("projects that have folders are offered too", q.attachable.filter((p) => p.has_folder).length >= 2, true);
  await folders.attach(q.id, [co.id, ssnr.id]);
  check("added to both, as a linked folder of each", [rule.holders(db.sqlP, found).map((h) => [h.id, h.home])], [[[ssnr.id, false], [co.id, false]]]);
  check("and no longer asked", folders.discoveries().some((d) => d.path === found), false);

  // --- the server -------------------------------------------------------------

  delete process.env.ELECTRON_RUN_AS_NODE;
  const { openServer } = require("../sheet/client");
  const shared = repoAt(mk("va2", "caseflow"), "feature/APREQ-987-address");
  const pS = db.createProject({ key: "ssnr-two", name: "SSNR two", path: shared });
  const pC = db.createProject({ key: "co-two", name: "Central Office two (APREQ-987)", path: shared });
  for (const [name, env] of [["node:sqlite", {}], ["sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" }]]) {
    section(`the MCP server in a shared folder, ${name}`);
    const agent = openServer({ actor: "claude-code", env: { DELPHI_AUTHOR_TYPE: "agent", DELPHI_DISCOVERY: "0", ...env }, clientName: "test", warn: () => {}, cwd: path.join(shared) });
    await agent.start();
    try {
      const me = await agent.call("whoami", {});
      check("whoami says where its work lands, and why", [me.working_in.project_id, me.working_in.via, me.working_in.guessed], [pC.id, "branch", true]);
      const made = await agent.call("add_task", { title: `filed with no project (${name})` });
      check("add_task with no project lands in the project the branch names", [made.project_id, made.filed_under.project, made.filed_under.via], [pC.id, "co-two", "branch"]);
      const row = db.sqlP("SELECT project_id, via, folder, settled_at FROM filed_routes WHERE entity = 'task' AND entity_id = :p1", [made.id])[0];
      check("recorded for the chip", [row.project_id, row.via, row.folder, row.settled_at], [pC.id, "branch", shared, null]);
      check("the window's list has it, with the words", db.filedRoutes().find((x) => x.entity_id === made.id).words, "Filed under Central Office two (APREQ-987), from branch");
      const named = await agent.call("add_task", { title: "named", project_id: pS.id });
      check("a project named is never second-guessed", [named.project_id, named.filed_under === undefined], [pS.id, true]);
      const note = await agent.call("add_note", { title: "a note with no project", body: "b" });
      check("add_note too", [note.project_id, note.filed_under.via], [pC.id, "branch"]);
      db.items().move("task", made.id, pS.id);
      check("a Move settles it, and the chip goes", [db.sqlP("SELECT project_id, settled_at IS NOT NULL AS s FROM filed_routes WHERE entity_id = :p1 AND entity = 'task'", [made.id])[0], db.filedRoutes().some((x) => x.entity === "task" && x.entity_id === made.id)],
        [{ project_id: pS.id, s: 1 }, false]);
    } finally { await agent.close(); }
  }
  {
    section("the MCP server launched for a job");
    const t3 = db.createTask({ projectId: pS.id, title: "the job's task" });
    const job = Number(db.sqlP("INSERT INTO handoffs (project_id, to_harness, task_id, request) VALUES (:p1, 'claude', :p2, 'go') RETURNING id", [pS.id, t3.id])[0].id);
    const agent = openServer({ actor: `claude-code:job-${job}`, env: { DELPHI_AUTHOR_TYPE: "agent", DELPHI_DISCOVERY: "0", DELPHI_JOB: String(job) }, clientName: "test", warn: () => {}, cwd: shared });
    await agent.start();
    try {
      const made = await agent.call("add_task", { title: "found while doing the job" });
      check("its task's project wins over the branch, and is no guess", [made.project_id, made.filed_under.via, made.filed_under.guessed], [pS.id, "job", false]);
      check("nothing for the chip", db.sqlP("SELECT COUNT(*) AS n FROM filed_routes WHERE entity = 'task' AND entity_id = :p1", [made.id])[0].n, 0);
    } finally { await agent.close(); }
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
