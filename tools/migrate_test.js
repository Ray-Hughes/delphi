#!/usr/bin/env node
// An old database, brought up to date by the MCP server and by the app.
//
//   node tools/migrate_test.js
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/migrate_test.js
//   electron --no-sandbox tools/migrate_test.js
//
// tools/fixtures/pre_m0.sql is a database from before Sheets and Workbenches.
// The server used to never migrate anything, so an agent could meet a file the
// app had not opened since an upgrade and fail on a column that was not there.
// Now both sides run agent/schema_later.js, and this proves it on every route a
// real client can take:
//
//   - Electron as Node, which has node:sqlite (what harness tabs launch);
//   - Electron as Node told to use the sqlite3 binary (DELPHI_SQLITE_ROUTE);
//   - a plain node, also on the binary, which is what an editor may launch.
//
// Which route actually ran is not taken on trust: DELPHI_SQLITE points the
// server at a wrapper that logs every call, so the node:sqlite route must leave
// the log empty and the binary route must not.
//
// Also the placeholder regression: values quoting :p1 or holding $& used to be
// rewritten by sql() itself, and last_insert_rowid() was always 0 on the binary
// route. Both are checked through the real tools.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn, spawnSync } = require("child_process");
const { openServer } = require("../sheet/client");
const { resolveBinary } = require("../agent/launch");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "agent", "mcp_server.js");
const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "pre_m0.sql"), "utf8");
const ELECTRON = process.versions.electron ? process.execPath : require("electron");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-migrate-"));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "unused.db");
const REAL = [path.join(os.homedir(), "va", "delphi", "delphi.db"),
              path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")];
function guardPath(file) {
  if (REAL.includes(path.resolve(file))) { console.error(`refusing to touch ${file}`); process.exit(1); }
  return file;
}

let failures = 0;
let checks = 0;

function check(what, got, want) {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}

function section(name) { console.log(`\n${name}`); }

function findSqlite() {
  for (const candidate of ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return resolveBinary("sqlite3") || "sqlite3";
}
const SQLITE = findSqlite();

/** Reads a database with the sqlite3 binary, independent of either route under test. */
function q(file, statement) {
  const out = execFileSync(SQLITE, ["-json", guardPath(file), statement], { encoding: "utf8" }).trim();
  return out ? JSON.parse(out) : [];
}

function freshFixture(file) {
  guardPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
  execFileSync(SQLITE, [file], { input: FIXTURE, encoding: "utf8" });
}

const columns = (file, table) => q(file, `PRAGMA table_info(${table})`).map((c) => c.name);
const schemaOf = (file) => q(file, "SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
const indexes = (file) => q(file, "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);

const NEW_COMMENT_COLUMNS = ["kind", "author_type", "meta", "promoted", "ref_id", "note_id"];
const NEW_REPO_COLUMNS = ["base_branch", "setup_cmd", "copy_files"];
const WORKBENCH_COLUMNS = ["id", "task_id", "repo_id", "path", "branch", "base", "state", "owner", "created_at", "updated_at", "closed_at"];
const NEW_INDEXES = ["idx_comments_ledger", "idx_workbenches_live", "idx_workbenches_path", "idx_workbenches_task"];

// The wrapper that tells us which route ran.
const wrapper = path.join(dir, "sqlite3-wrapper.sh");
const wrapperLog = path.join(dir, "sqlite3-calls.log");
fs.writeFileSync(wrapper, `#!/bin/sh\necho call >> "${wrapperLog}"\nexec "${SQLITE}" "$@"\n`);
fs.chmodSync(wrapper, 0o755);
const binaryCalls = () => (fs.existsSync(wrapperLog) ? fs.readFileSync(wrapperLog, "utf8").split("\n").filter(Boolean).length : 0);

function serverEnv(file, extra = {}) {
  return {
    ELECTRON_RUN_AS_NODE: "1",
    DELPHI_DB: guardPath(file),
    DELPHI_SQLITE: wrapper,
    DELPHI_SESSION: "1",
    // Whatever the outer shell had must not leak a route into a config that
    // did not ask for one.
    DELPHI_SQLITE_ROUTE: "",
    ...extra,
  };
}

async function withServer(command, env, fn) {
  const stderr = [];
  const client = openServer({
    server: SERVER, command, actor: "migrate-test", env, clientName: "delphi-migrate-test",
    warn: (...parts) => stderr.push(parts.join(" ")),
  });
  try {
    await client.start();
    return await fn(client, stderr);
  } finally {
    client.close();
  }
}

/** Sends lines and closes stdin at once, then collects every answer. */
function rawExchange(command, env, lines) {
  return new Promise((resolve) => {
    const child = spawn(command, [SERVER], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => resolve({ code, messages: out.split("\n").filter(Boolean).map((l) => JSON.parse(l)) }));
    child.stdin.end(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  });
}

const NASTY = "quotes ' and \" and :p1 then :p2 and :p3 :p10 and $& $` $' $$ $1 and `$ ` in backticks";

async function exercise(label, command, extraEnv, expectBinary) {
  const file = path.join(dir, label.replace(/[^a-z0-9]+/gi, "-"), "delphi.db");
  freshFixture(file);
  fs.rmSync(wrapperLog, { force: true });
  const env = serverEnv(file, extraEnv);

  section(`${label}: migrating`);
  check("the fixture starts old", columns(file, "comments").includes("kind"), false);

  await withServer(command, env, async (client, stderr) => {
    const task = await client.call("get_task", { id: 1 });
    check("the server answers", task.task.title, "an old task with comments");
    check("old comments come back as they were", task.comments.map((c) => c.body),
          ["Plain words.", "Multi\nline, with a fence:\n```\n$ npm test\n```"]);
    check("nothing went to stderr", stderr.filter((l) => !/two databases exist/.test(l)), []);
  });

  check(`ran on the ${expectBinary ? "sqlite3 binary" : "node:sqlite"} route`, binaryCalls() > 0, expectBinary);
  check("comments gained every new column", NEW_COMMENT_COLUMNS.filter((c) => !columns(file, "comments").includes(c)), []);
  check("repos gained every new column", NEW_REPO_COLUMNS.filter((c) => !columns(file, "repos").includes(c)), []);
  check("workbenches exists", columns(file, "workbenches"), WORKBENCH_COLUMNS);
  check("the new indexes exist", NEW_INDEXES.filter((i) => !indexes(file).includes(i)), []);
  check("old comments read as say, unpromoted, type unknown",
        q(file, "SELECT kind, promoted, author_type, meta, ref_id, note_id FROM comments ORDER BY id"),
        [1, 2, 3].map(() => ({ kind: "say", promoted: 0, author_type: null, meta: null, ref_id: null, note_id: null })));
  check("old repos have nothing decided yet", q(file, "SELECT base_branch, setup_cmd, copy_files FROM repos"),
        [{ base_branch: null, setup_cmd: null, copy_files: null }]);

  section(`${label}: a second start is a no op`);
  const before = schemaOf(file);
  await withServer(command, env, async (client, stderr) => {
    await client.call("list_projects", {});
    check("nothing went to stderr", stderr.filter((l) => !/two databases exist/.test(l)), []);
  });
  check("the schema did not move", schemaOf(file), before);

  section(`${label}: the partial unique indexes`);
  q(file, "INSERT INTO workbenches (task_id, repo_id, path, branch, base) VALUES (1, 1, '/w/one', 'ray/1-one', 'main')");
  let refused = false;
  try {
    execFileSync(SQLITE, [file, "INSERT INTO workbenches (task_id, repo_id, path, branch, base) VALUES (1, 1, '/w/two', 'ray/1-two', 'main')"], { stdio: "pipe" });
  } catch { refused = true; }
  check("a second live Workbench for one task and repo is refused", refused, true);
  refused = false;
  try {
    execFileSync(SQLITE, [file, "INSERT INTO workbenches (task_id, repo_id, path, branch, base) VALUES (2, 1, '/w/one', 'ray/2-x', 'main')"], { stdio: "pipe" });
  } catch { refused = true; }
  check("two live rows cannot claim one folder", refused, true);
  q(file, "UPDATE workbenches SET state = 'missing' WHERE task_id = 1");
  refused = false;
  try {
    execFileSync(SQLITE, [file, "INSERT INTO workbenches (task_id, repo_id, path, branch, base) VALUES (1, 1, '/w/three', 'ray/1-three', 'main')"], { stdio: "pipe" });
  } catch { refused = true; }
  check("missing still counts as live", refused, true);
  q(file, "UPDATE workbenches SET state = 'finished' WHERE task_id = 1");
  q(file, "INSERT INTO workbenches (task_id, repo_id, path, branch, base) VALUES (1, 1, '/w/one', 'ray/1-again', 'main')");
  check("a finished one leaves room for a new one in the same folder",
        q(file, "SELECT COUNT(*) AS n FROM workbenches WHERE task_id = 1")[0].n, 2);

  section(`${label}: values are stored as written`);
  await withServer(command, env, async (client) => {
    const comment = await client.call("add_comment", { task_id: 1, body: NASTY });
    check("add_comment returns the row it wrote", [comment.body, typeof comment.id], [NASTY, "number"]);
    check("and the row is verbatim", q(file, `SELECT body FROM comments WHERE id = ${Number(comment.id)}`)[0].body, NASTY);

    const added = await client.call("add_task", { title: `task ${NASTY}`, project_id: 1 });
    check("add_task returns its own id", q(file, `SELECT title FROM tasks WHERE id = ${Number(added.id)}`)[0].title, `task ${NASTY}`);
    const note = await client.call("add_note", { project_id: 1, title: `note :p1 $&`, body: NASTY });
    check("add_note returns its own id", q(file, `SELECT title, body FROM notes WHERE id = ${Number(note.id)}`)[0],
          { title: "note :p1 $&", body: NASTY });

    const padBody = "## Plan :p1\n\n- [ ] first :p1 line @ray !high\n- [ ] second $& line :p2\n";
    const pad = await client.call("write_scratchpad", { project_id: 1, key: "plan", title: "Plan :p2 $' here", body: padBody });
    check("a pad files its tasks, with ids, on this route", pad.tasks.map((t) => [typeof t.id, t.title]),
          [["number", "first :p1 line"], ["number", "second $& line :p2"]]);
    const stored = q(file, `SELECT title, body FROM scratchpads WHERE id = ${Number(pad.id)}`)[0];
    check("the pad title is verbatim", stored.title, "Plan :p2 $' here");
    check("the pad body is verbatim apart from the anchors",
          stored.body.replace(/ <!--d:\d+-->/g, ""), padBody);
    check("pad tasks are titled verbatim",
          q(file, `SELECT title, assignee, priority FROM tasks WHERE pad_id = ${Number(pad.id)} ORDER BY id`),
          [{ title: "first :p1 line", assignee: "ray", priority: "high" }, { title: "second $& line :p2", assignee: null, priority: "med" }]);

    // A rename goes through derivePad's UPDATE, which used to splice the title
    // into the query text before sql() substituted the placeholders.
    // A function, not a string, as the replacement: a string would give $& its
    // meaning here too, which is the very bug being tested for.
    const renamed = stored.body.replace("first :p1 line", () => "first :p1 :p2 renamed $&");
    await client.call("write_scratchpad", { project_id: 1, key: "plan", title: "Plan", body: renamed });
    check("a renamed line renames its task verbatim",
          q(file, `SELECT title FROM tasks WHERE id = ${Number(pad.tasks[0].id)}`)[0].title, "first :p1 :p2 renamed $&");

    const handoff = await client.call("handoff_send", { to: "codex", project_id: 1, request: `review :p1 $&`, context: { branch: "$'" } });
    check("handoff_send returns the row it wrote", [typeof handoff.id, handoff.request, handoff.context_json],
          ["number", "review :p1 $&", '{"branch":"$\'"}']);
    const timer = await client.call("timer_set", { minutes: 5, message: "wake :p1 $&" });
    check("timer_set returns the row it wrote", [typeof timer.id, typeof timer.fire_at], ["number", "string"]);
    check("and its message is verbatim", q(file, `SELECT message FROM alerts WHERE id = ${Number(timer.id)}`)[0].message, "wake :p1 $&");

    let error = null;
    try { await client.call("get_task", { id: 99999 }); } catch (e) { error = e.message; }
    check("a failing tool is an error response, not a dead server", error, "No task 99999");
    check("and the server is still there", (await client.call("get_task", { id: 2 })).task.title, "a finished one");
  });

  section(`${label}: answers survive stdin closing`);
  const exchange = await rawExchange(command, env, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "add_comment", arguments: { task_id: 3, body: "written as stdin closed" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "no_such_tool", arguments: {} } },
  ]);
  // Answers are keyed by id and may arrive in any order, as JSON-RPC allows:
  // handle() is async, so a quick failure can overtake a slower success.
  const byId = Object.fromEntries(exchange.messages.map((m) => [m.id, m]));
  check("every request is answered", exchange.messages.map((m) => m.id).sort(), [1, 2, 3]);
  check("the notification is not answered", exchange.messages.some((m) => m.id === undefined), false);
  check("the write is answered", Boolean(byId[2] && byId[2].result), true);
  check("the unknown tool is an error", byId[3] && byId[3].error && byId[3].error.message, "Unknown tool no_such_tool");
  check("the write landed", q(file, "SELECT COUNT(*) AS n FROM comments WHERE body = 'written as stdin closed'")[0].n, 1);
  check("and the server exited cleanly", exchange.code, 0);

  return file;
}

// db.js in a child, because it reads DELPHI_DATA_DIR once at require time and
// needs node:sqlite, which only Electron is sure to have.
function openWithApp(dataDir) {
  const script = `
    const db = require(${JSON.stringify(path.join(ROOT, "db.js"))});
    db.handle();
    db.handle().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    process.stdout.write("opened");
  `;
  const result = spawnSync(ELECTRON, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DELPHI_DATA_DIR: dataDir, DELPHI_DB: path.join(dataDir, "delphi.db") },
  });
  return { ok: result.status === 0 && result.stdout === "opened", stderr: result.stderr };
}

(async () => {
  const electronFile = await exercise("electron, node:sqlite", ELECTRON, {}, false);
  await exercise("electron, sqlite3 binary", ELECTRON, { DELPHI_SQLITE_ROUTE: "binary" }, true);
  const node = resolveBinary("node");
  if (node) {
    await exercise("plain node, sqlite3 binary", node, { DELPHI_SQLITE_ROUTE: "binary" }, true);
  } else {
    console.log("\n(no node on PATH: the plain node route was not run)");
  }

  section("the app opens the same fixture");
  const appDir = path.join(dir, "app");
  freshFixture(path.join(appDir, "delphi.db"));
  const opened = openWithApp(appDir);
  check("db.js opens a pre-M0 database", opened.ok, true);
  if (!opened.ok) console.error(opened.stderr);
  const appFile = path.join(appDir, "delphi.db");
  check("with every new comments column", NEW_COMMENT_COLUMNS.filter((c) => !columns(appFile, "comments").includes(c)), []);
  check("every new repos column", NEW_REPO_COLUMNS.filter((c) => !columns(appFile, "repos").includes(c)), []);
  check("the workbenches table", columns(appFile, "workbenches"), WORKBENCH_COLUMNS);
  check("and the indexes", NEW_INDEXES.filter((i) => !indexes(appFile).includes(i)), []);
  check("old comments are says", q(appFile, "SELECT DISTINCT kind FROM comments"), [{ kind: "say" }]);

  section("app and server agree on the result");
  const sorted = (file, table) => columns(file, table).slice().sort();
  for (const table of ["comments", "repos", "workbenches", "tasks", "projects"]) {
    check(`${table} has the same columns either way`, sorted(appFile, table), sorted(electronFile, table));
  }

  section("then the server on the app's database, and the app on the server's");
  const beforeServer = schemaOf(appFile);
  fs.rmSync(wrapperLog, { force: true });
  await withServer(ELECTRON, serverEnv(appFile), async (client, stderr) => {
    await client.call("list_projects", {});
    check("nothing to do and nothing said", stderr.filter((l) => !/two databases exist/.test(l)), []);
  });
  check("the schema did not move", schemaOf(appFile), beforeServer);

  const serverFirst = path.join(dir, "server-first");
  freshFixture(path.join(serverFirst, "delphi.db"));
  await withServer(ELECTRON, serverEnv(path.join(serverFirst, "delphi.db")), async (client) => {
    await client.call("list_projects", {});
  });
  const second = openWithApp(serverFirst);
  check("db.js opens a database the server migrated", second.ok, true);
  if (!second.ok) console.error(second.stderr);

  section("a brand new file");
  const empty = path.join(dir, "empty", "delphi.db");
  fs.mkdirSync(path.dirname(empty), { recursive: true });
  await withServer(ELECTRON, serverEnv(empty), async (client, stderr) => {
    let error = null;
    try { await client.call("list_projects", {}); } catch (e) { error = e.message; }
    check("the server says there is nothing there rather than crashing", /no such table/.test(String(error)), true);
    check("and did not complain about migrating", stderr.filter((l) => /could not migrate/.test(l)), []);
  });
  check("no lone workbenches table is left in a file that is not Delphi's", q(empty, "SELECT name FROM sqlite_master"), []);

  section("a statement that fails costs only itself");
  const schemaLater = require("../agent/schema_later");
  const partial = path.join(dir, "partial", "delphi.db");
  freshFixture(partial);
  const flaky = (statement) => {
    if (/ADD COLUMN promoted /.test(statement)) throw new Error("disk says no");
    return q(partial, statement);
  };
  let outcome = null;
  try { outcome = schemaLater.apply(flaky); } catch (error) { outcome = { threw: error.message }; }
  check("apply does not throw", outcome && outcome.threw, undefined);
  check("the failure is reported with its statement", outcome.errors.map((e) => [e.message, /ADD COLUMN promoted/.test(e.statement)]),
        [["disk says no", true]]);
  check("everything else still landed", outcome.added.includes("comments.kind") && outcome.created.includes("workbenches"), true);
  check("the index that needed the missing column was skipped, not failed",
        [outcome.indexed.includes("idx_comments_ledger"), outcome.indexed.includes("idx_workbenches_task")], [false, true]);
  check("a second apply finishes the job", schemaLater.apply((s) => q(partial, s)),
        { added: ["comments.promoted"], created: [], indexed: ["idx_comments_ledger"], errors: [] });
  check("and a third has nothing to do", schemaLater.apply((s) => q(partial, s)),
        { added: [], created: [], indexed: [], errors: [] });

  section("another process adds the column between the look and the ALTER");
  // The app and several servers can open one old database together. Each
  // looks, then alters, and the one that loses gets "duplicate column name".
  // The column is there, so that is success, not a database that will not open.
  for (const [label, run] of [["apply", (fn) => schemaLater.apply(fn)], ["addLaterColumns", (fn) => schemaLater.addLaterColumns(fn)]]) {
    const raced = path.join(dir, `raced-${label}`, "delphi.db");
    freshFixture(raced);
    let beaten = 0;
    const racing = (statement) => {
      if (/^ALTER TABLE \w+ ADD COLUMN/.test(statement)) { q(raced, statement); beaten++; }
      return q(raced, statement);
    };
    let result = null;
    try { result = run(racing); } catch (error) { result = { threw: error.message }; }
    check(`${label}: lost every race and still did not fail`, [beaten > 0, result.threw, result.errors || []], [true, undefined, []]);
    check(`${label}: and every column is there`, NEW_COMMENT_COLUMNS.filter((c) => !columns(raced, "comments").includes(c)), []);
  }
  const broken = path.join(dir, "raced-broken", "delphi.db");
  freshFixture(broken);
  const refusing = (statement) => {
    if (/ADD COLUMN kind /.test(statement)) throw new Error("duplicate column name: kind");
    return q(broken, statement);
  };
  check("an ALTER that failed and left the column missing is still an error",
        schemaLater.apply(refusing).errors.map((e) => e.message), ["duplicate column name: kind"]);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
