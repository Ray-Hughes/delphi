#!/usr/bin/env node
// One database, enforced: the resolver, the file's identity, the refusal, the
// heartbeat and whoami.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/identity_test.js
//
// The app used to read the checkout's database while every agent wrote the
// installed one, and nothing errored. These are the checks that it cannot come
// back: every process resolves the same file by the same rule, the file says
// which database it is, a server the app launched refuses any other file, and
// an agent is told honestly whether anything will dispatch its handoff.
//
// Nothing here touches a real database. Every file is in a temp folder, HOME is
// a temp folder for any process that resolves by default, and a server that
// must see a checkout database runs from a copy of the source tree.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "agent", "mcp_server.js");
const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "pre_m0.sql"), "utf8");
const locate = require("../agent/locate");
const identity = require("../agent/identity");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-identity-")));
process.env.DELPHI_DATA_DIR = path.join(dir, "floor");
process.env.DELPHI_DB = path.join(dir, "floor", "delphi.db");
const REAL = [path.join(os.homedir(), "va", "delphi", "delphi.db"),
              path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db"),
              path.join(locate.CHECKOUT_DIR, "delphi.db")];
function guard(file) {
  if (REAL.some((r) => path.resolve(file) === r)) { console.error(`refusing to touch ${file}`); process.exit(1); }
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
  } else {
    console.log(`  ok   ${what}`);
  }
}
function section(name) { console.log(`\n${name}`); }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function findSqlite() {
  for (const candidate of ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "sqlite3";
}
const SQLITE = findSqlite();
const q = (file, statement) => {
  const out = execFileSync(SQLITE, ["-json", guard(file), statement], { encoding: "utf8" }).trim();
  return out ? JSON.parse(out) : [];
};
function fixture(file) {
  guard(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(file + s, { force: true });
  execFileSync(SQLITE, [file], { input: FIXTURE, encoding: "utf8" });
  return file;
}

// A clean environment for a child: nothing Delphi-ish inherited, so the only
// variables it sees are the ones a check sets.
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("DELPHI_")) env[k] = v;
  env.ELECTRON_RUN_AS_NODE = "1";
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

/** Runs the server with these tool calls on stdin and returns { status, stderr, results }. */
function rpc(env, calls = [], server = SERVER) {
  const lines = [{ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }];
  calls.forEach(([name, args], i) => lines.push({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: args || {} } }));
  const r = spawnSync(process.execPath, [server], {
    env, input: lines.map((l) => JSON.stringify(l)).join("\n") + "\n", encoding: "utf8", timeout: 60000,
  });
  const byId = new Map();
  for (const line of String(r.stdout || "").split("\n")) {
    try { const m = JSON.parse(line); if (m.id !== undefined) byId.set(m.id, m); } catch {}
  }
  const results = calls.map((_c, i) => {
    const m = byId.get(i + 1);
    if (!m) return null;
    if (m.error) return { error: m.error.message };
    try { return JSON.parse(m.result.content[0].text); } catch { return m.result; }
  });
  return { status: r.status, stderr: String(r.stderr || ""), results };
}

/** Runs a few lines against db.js in a child, because db.js reads its paths once at require time. */
function withApp(env, body) {
  const r = spawnSync(process.execPath, ["-e", `
    const db = require(${JSON.stringify(path.join(ROOT, "db.js"))});
    const out = (() => { ${body} })();
    process.stdout.write(JSON.stringify(out === undefined ? null : out));
  `], { env: cleanEnv(env), cwd: ROOT, encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) throw new Error(`app child failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// ---------------------------------------------------------------------------
section("the resolver: one rule, and the checkout is never chosen");

const home = path.join(dir, "home");
const checkout = path.join(dir, "checkout");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(checkout, { recursive: true });
fs.writeFileSync(path.join(checkout, "delphi.db"), "");
const macData = path.join(home, "Library", "Application Support", "Delphi");

{
  const r = locate.resolve({ env: {}, platform: "darwin", home, checkoutDir: checkout });
  check("unpackaged, with a checkout database present, still picks the data folder",
    [r.dbPath, r.dataDir, r.source], [path.join(macData, "delphi.db"), macData, "default"]);
  check("and reports the checkout database as ignored", r.checkoutDbIgnored, path.join(checkout, "delphi.db"));
  check("the notice names both files", /beside the source at .*checkout\/delphi\.db.*uses .*Application Support/.test(locate.ignoredNotice(r)), true);
}
{
  const r = locate.resolve({ env: { DELPHI_DATA_DIR: path.join(dir, "dd") }, platform: "darwin", home, checkoutDir: checkout });
  check("DELPHI_DATA_DIR wins over the default", [r.dataDir, r.dbPath, r.source], [path.join(dir, "dd"), path.join(dir, "dd", "delphi.db"), "DELPHI_DATA_DIR"]);
}
{
  const r = locate.resolve({ env: { DELPHI_DB: path.join(dir, "x", "a.db") }, platform: "darwin", home, checkoutDir: checkout });
  check("DELPHI_DB names the file, and its folder is the data folder", [r.dbPath, r.dataDir, r.source], [path.join(dir, "x", "a.db"), path.join(dir, "x"), "DELPHI_DB"]);
}
{
  const r = locate.resolve({ env: { DELPHI_DB: path.join(dir, "x", "a.db"), DELPHI_DATA_DIR: path.join(dir, "dd") }, platform: "darwin", home, checkoutDir: checkout });
  check("DELPHI_DB wins for the file, DELPHI_DATA_DIR still names the folder", [r.dbPath, r.dataDir], [path.join(dir, "x", "a.db"), path.join(dir, "dd")]);
}
{
  const r = locate.resolve({ env: { DELPHI_DB: path.join(checkout, "delphi.db") }, platform: "darwin", home, checkoutDir: checkout });
  check("the checkout database named on purpose is not 'ignored'", r.checkoutDbIgnored, null);
}
check("Windows uses APPDATA", locate.conventionalDataDir({ env: { APPDATA: "C:\\Users\\r\\AppData\\Roaming" }, platform: "win32", home }),
  path.join("C:\\Users\\r\\AppData\\Roaming", "Delphi"));
check("Linux uses XDG_CONFIG_HOME, then ~/.config", [
  locate.conventionalDataDir({ env: { XDG_CONFIG_HOME: "/x/cfg" }, platform: "linux", home }),
  locate.conventionalDataDir({ env: {}, platform: "linux", home }),
], [path.join("/x/cfg", "Delphi"), path.join(home, ".config", "Delphi")]);

section("the single-instance lock is per database");
{
  const def = locate.resolve({ env: {}, platform: "darwin", home, checkoutDir: checkout });
  const over = locate.resolve({ env: { DELPHI_DATA_DIR: path.join(dir, "dev") }, platform: "darwin", home, checkoutDir: checkout });
  const same = locate.resolve({ env: { DELPHI_DATA_DIR: macData }, platform: "darwin", home, checkoutDir: checkout });
  check("the default keeps the per-user profile, so a checkout and the installed app share one lock", locate.electronProfileDir(def), null);
  check("an override gets a profile, and so a lock, of its own", locate.electronProfileDir(over), path.join(dir, "dev", "electron-profile"));
  check("an override that names the per-user folder is the same database and the same lock", locate.electronProfileDir(same), null);
}

section("paths.js uses the resolver, packaged or not");
{
  const r = spawnSync(process.execPath, ["-e", `
    const p = require(${JSON.stringify(path.join(ROOT, "paths.js"))});
    process.stdout.write(JSON.stringify({ data: p.DATA_DIR, db: p.DB_PATH, vault: p.defaultVault(), ignored: p.RESOLVED.checkoutDbIgnored, source: p.RESOLVED.source }));
  `], { env: cleanEnv({ HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), APPDATA: path.join(home, "AppData") }), encoding: "utf8" });
  const got = JSON.parse(r.stdout || "{}");
  const conventional = locate.conventionalDataDir({ env: { XDG_CONFIG_HOME: path.join(home, ".config"), APPDATA: path.join(home, "AppData") }, home });
  check("run from the checkout with nothing set, the database is the per-user one, not the checkout's",
    [got.data, got.db, got.source], [conventional, path.join(conventional, "delphi.db"), "default"]);
  check("and the vault is the Documents one, not vault/ beside the source", got.vault, path.join(home, "Documents", "Delphi"));
  const overridden = spawnSync(process.execPath, ["-e", `
    const p = require(${JSON.stringify(path.join(ROOT, "paths.js"))});
    process.stdout.write(JSON.stringify({ vault: p.defaultVault(), migrated: p.migrateLegacyDatabase() }));
  `], { env: cleanEnv({ HOME: home, DELPHI_DATA_DIR: path.join(dir, "ov") }), encoding: "utf8" });
  const ov = JSON.parse(overridden.stdout || "{}");
  check("an overridden data folder keeps its vault inside it", ov.vault, path.join(dir, "ov", "vault"));
}

section("migrateLegacyDatabase never puts an old copy over a real one");
{
  const legacy = path.join(home, "delphi", "delphi.db");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, "LEGACY");
  const run = (env) => {
    const r = spawnSync(process.execPath, ["-e", `
      const p = require(${JSON.stringify(path.join(ROOT, "paths.js"))});
      process.stdout.write(JSON.stringify({ from: p.migrateLegacyDatabase(), db: p.DB_PATH }));
    `], { env: cleanEnv({ HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), APPDATA: path.join(home, "AppData"), ...env }), encoding: "utf8" });
    // The last line: the migration announces itself on stdout first.
    return JSON.parse(String(r.stdout || "{}").trim().split("\n").pop());
  };
  const target = path.join(locate.conventionalDataDir({ env: { XDG_CONFIG_HOME: path.join(home, ".config"), APPDATA: path.join(home, "AppData") }, home }), "delphi.db");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "REAL");
  check("a database already there: nothing copied", run({}).from, null);
  check("and the real one is untouched", fs.readFileSync(target, "utf8"), "REAL");
  fs.rmSync(target);
  fs.writeFileSync(target + "-wal", "WAL");
  check("only a -wal there: still nothing copied", run({}).from, null);
  fs.rmSync(target + "-wal");
  check("an override: never migrates into it", run({ DELPHI_DATA_DIR: path.join(dir, "ov2") }).from, null);
  check("nothing there at all: the legacy copy is brought across", run({}).from, legacy);
  check("and it is the legacy file's contents", fs.readFileSync(target, "utf8"), "LEGACY");
}

// ---------------------------------------------------------------------------
section("meta and db_id, fresh and old, on both routes");

const freshDir = path.join(dir, "fresh");
const fresh = withApp({ DELPHI_DATA_DIR: freshDir }, "db.handle(); return db.identity();");
check("a fresh database made by the app has a uuid db_id", UUID.test(String(fresh.db_id)), true);
check("and a created_at", typeof fresh.created_at === "string" && !Number.isNaN(Date.parse(fresh.created_at)), true);
check("reopening keeps the same id", withApp({ DELPHI_DATA_DIR: freshDir }, "db.handle(); return db.identity().db_id;"), fresh.db_id);
check("the server reads the id the app minted", rpc(cleanEnv({ DELPHI_DB: path.join(freshDir, "delphi.db") }), [["whoami"]]).results[0].db_id, fresh.db_id);

for (const route of ["node:sqlite", "binary"]) {
  const file = fixture(path.join(dir, `old-${route.replace(":", "")}`, "delphi.db"));
  check(`${route}: an old database has no meta table before`, q(file, "SELECT name FROM sqlite_master WHERE name = 'meta'").length, 0);
  const env = cleanEnv({ DELPHI_DB: file, DELPHI_SQLITE_ROUTE: route === "binary" ? "binary" : "" });
  const first = rpc(env, [["whoami"]]);
  const who = first.results[0] || {};
  check(`${route}: the server migrates it and mints an id`, UUID.test(String(who.db_id)), true);
  check(`${route}: whoami says which route ran`, route === "binary" ? who.sqlite_route !== "node:sqlite" : who.sqlite_route === "node:sqlite", true);
  check(`${route}: the id is in the file`, q(file, "SELECT value FROM meta WHERE key = 'db_id'")[0].value, who.db_id);
  check(`${route}: a second server keeps it`, rpc(env, [["whoami"]]).results[0].db_id, who.db_id);
  check(`${route}: and the app, opening it after, agrees`,
    withApp({ DELPHI_DATA_DIR: path.dirname(file), DELPHI_DB: file }, "db.handle(); return db.identity().db_id;"), who.db_id);
}

{
  const empty = guard(path.join(dir, "empty", "delphi.db"));
  fs.mkdirSync(path.dirname(empty), { recursive: true });
  execFileSync(SQLITE, [empty, "CREATE TABLE unrelated (x);"]);
  const r = rpc(cleanEnv({ DELPHI_DB: empty }), [["whoami"]]);
  check("a file that is not a Delphi database gets no id", r.results[0] && r.results[0].db_id, null);
  check("and no meta table is put in it", q(empty, "SELECT name FROM sqlite_master WHERE name = 'meta'").length, 0);
}

// ---------------------------------------------------------------------------
section("DELPHI_DB_ID: a launched server refuses any other database");

for (const route of ["node:sqlite", "binary"]) {
  const file = fixture(path.join(dir, `refuse-${route.replace(":", "")}`, "delphi.db"));
  const base = { DELPHI_DB: file, DELPHI_SQLITE_ROUTE: route === "binary" ? "binary" : "", DELPHI_ACTOR: "codex:9" };
  const id = rpc(cleanEnv(base), [["whoami"]]).results[0].db_id;
  const before = q(file, "SELECT COUNT(*) AS n FROM tasks")[0].n;
  const wrong = rpc(cleanEnv({ ...base, DELPHI_DB_ID: "00000000-0000-4000-8000-000000000000" }),
    [["add_task", { title: "should never land", project_id: 1 }]]);
  check(`${route}: a mismatched id exits non-zero`, wrong.status, 1);
  check(`${route}: and says why on stderr`, /refusing to start.*00000000-0000-4000-8000-000000000000.*has the id/.test(wrong.stderr.replace(/\n/g, " ")), true);
  check(`${route}: and answers nothing`, wrong.results, [null]);
  check(`${route}: and wrote nothing`, q(file, "SELECT COUNT(*) AS n FROM tasks")[0].n, before);
  const right = rpc(cleanEnv({ ...base, DELPHI_DB_ID: id }), [["whoami"]]);
  check(`${route}: the matching id starts normally`, [right.status, right.results[0] && right.results[0].db_id], [0, id]);
}
{
  const empty = path.join(dir, "empty", "delphi.db");
  const r = rpc(cleanEnv({ DELPHI_DB: empty, DELPHI_DB_ID: "00000000-0000-4000-8000-000000000000" }), [["whoami"]]);
  check("an id asked for, and a file with none: refused", [r.status, /has no Delphi id/.test(r.stderr)], [1, true]);
}

section("the app passes the id to every server it launches");
{
  const harness = require("../harness");
  const codex = harness.mcpFlags("codex-config", { dbPath: "/tmp/d.db", dbId: "abc", sessionId: 1, actor: "t" });
  check("codex: DELPHI_DB_ID rides with DELPHI_DB", codex.flags.some((f) => /DELPHI_DB_ID="abc"/.test(f) && /DELPHI_DB="\/tmp\/d.db"/.test(f)), true);
  const claude = harness.mcpFlags("flag:--mcp-config", { dbPath: "/tmp/d.db", dbId: "abc", sessionId: 1, actor: "t" });
  const written = JSON.parse(fs.readFileSync(claude.file, "utf8"));
  check("claude: in the config file it writes", written.mcpServers.delphi.env.DELPHI_DB_ID, "abc");
  fs.rmSync(claude.file, { force: true });
  const none = harness.mcpFlags("codex-config", { dbPath: "/tmp/d.db", sessionId: 1, actor: "t" });
  check("no id known: none passed, rather than an empty one that would refuse everything", none.flags.some((f) => /DELPHI_DB_ID/.test(f)), false);
}

// ---------------------------------------------------------------------------
section("whoami and the heartbeat");

const whoDir = path.join(dir, "who");
const sessionId = withApp({ DELPHI_DATA_DIR: whoDir }, `
  db.handle();
  db.seedHarnesses(require(${JSON.stringify(path.join(ROOT, "harness.js"))}).BUILTINS);
  const p = db.createProject({ key: "scope", name: "Scoped" });
  return db.createSession({ projectId: p.id, harness: "claude-code" }).id;
`);
const whoFile = path.join(whoDir, "delphi.db");
const { DatabaseSync } = require("node:sqlite");
const direct = new DatabaseSync(whoFile);
const dq = (statement) => direct.prepare(statement).all();

for (const route of ["node:sqlite", "binary"]) {
  const env = cleanEnv({ DELPHI_DB: whoFile, DELPHI_ACTOR: "claude-code:4", DELPHI_AUTHOR_TYPE: "agent",
    DELPHI_PROJECT: "scope", DELPHI_SQLITE_ROUTE: route === "binary" ? "binary" : "" });
  dq("DELETE FROM meta WHERE key = 'app_heartbeat'");
  let who = rpc(env, [["whoami"]]).results[0];
  check(`${route}: whoami has the shape agents are told about`,
    ["db_path", "db_id", "actor", "author_type", "project_scope", "app_running"].every((k) => k in who), true);
  check(`${route}: path, actor, type and scope`, [who.db_path, who.actor, who.author_type, who.project_scope && who.project_scope.key],
    [whoFile, "claude-code:4", "agent", "scope"]);
  check(`${route}: no app has beaten, so none is running`, [who.app_running, /since it last quit/.test(who.app.reason)], [false, true]);

  identity.beat(dq, { version: "test" });
  who = rpc(env, [["whoami"]]).results[0];
  check(`${route}: a fresh beat from a live process is a running app`, [who.app_running, who.app.pid], [true, process.pid]);

  identity.beat(dq, { now: new Date(Date.now() - 5 * 60 * 1000) });
  check(`${route}: a beat five minutes old is not`, rpc(env, [["whoami"]]).results[0].app_running, false);

  identity.beat(dq, { pid: 2 ** 22 + 12345 });
  check(`${route}: a fresh beat from a pid that is gone is not either`, rpc(env, [["whoami"]]).results[0].app_running, false);

  dq("DELETE FROM meta WHERE key = 'app_heartbeat'");
  const quiet = rpc(env, [["handoff_send", { to: "codex", request: "review", project: "scope" }]]).results[0];
  check(`${route}: handoff_send with no app says nothing will dispatch it`,
    [quiet.dispatcher_running, /No Delphi app is running/.test(quiet.note), /You will be woken/.test(quiet.note)], [false, true, false]);
  identity.beat(dq, {});
  const live = rpc(env, [["handoff_send", { to: "codex", request: "review", project: "scope" }]]).results[0];
  check(`${route}: with an app running it says it will be dispatched`, [live.dispatcher_running, /will dispatch it/.test(live.note)], [true, true]);
  check(`${route}: and with no Delphi session, that nothing can wake the caller`, [live.will_wake, /Nothing can wake you/.test(live.note)], [false, true]);
  const woken = rpc({ ...env, DELPHI_SESSION: String(sessionId) }, [["handoff_send", { to: "codex", request: "review", project: "scope" }]]).results[0];
  check(`${route}: a session Delphi started is told it will be woken`, [woken.will_wake, /You will be woken/.test(woken.note)], [true, true]);
}

{
  identity.beat(dq, { pid: 424242, host: "elsewhere" });
  identity.clearBeat(dq);
  check("clearBeat leaves another process's beat alone", JSON.parse(dq("SELECT value FROM meta WHERE key = 'app_heartbeat'")[0].value).pid, 424242);
  identity.beat(dq, {});
  identity.clearBeat(dq);
  check("and takes away its own", dq("SELECT value FROM meta WHERE key = 'app_heartbeat'").length, 0);
}
direct.close();

// ---------------------------------------------------------------------------
section("an ignored checkout database is mentioned once, and never opened");
{
  // A copy of the source, so there can be a delphi.db beside it without one
  // being made in the real checkout.
  const tree = path.join(dir, "tree");
  fs.cpSync(ROOT, tree, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      return !/^(node_modules|release|vault|\.git|docs|assets|build|sheets)(\/|$)/.test(rel) && !/^delphi\.db/.test(rel) && !/^settings\.json$/.test(rel);
    },
  });
  const stale = path.join(tree, "delphi.db");
  execFileSync(SQLITE, [stale, "CREATE TABLE stale (x); INSERT INTO stale VALUES (1);"]);
  const staleBefore = fs.readFileSync(stale);
  const fakeHome = path.join(dir, "home2");
  const env = cleanEnv({ HOME: fakeHome, XDG_CONFIG_HOME: path.join(fakeHome, ".config"), APPDATA: path.join(fakeHome, "AppData") });
  const target = path.join(locate.conventionalDataDir({ env, home: fakeHome }), "delphi.db");
  fixture(target);
  const server = path.join(tree, "agent", "mcp_server.js");
  const first = rpc(env, [["whoami"]], server);
  check("the server uses the per-user database", first.results[0] && first.results[0].db_path, target);
  check("and reports the checkout one as ignored", first.results[0] && first.results[0].checkout_db_ignored, stale);
  check("it says so on stderr the first time", /beside the source at .*tree\/delphi\.db.*is not used/.test(first.stderr.replace(/\n/g, " ")), true);
  const second = rpc(env, [["whoami"]], server);
  check("and not the second", /beside the source/.test(second.stderr), false);
  check("the checkout database was never written", Buffer.compare(fs.readFileSync(stale), staleBefore), 0);
  const overridden = rpc(cleanEnv({ HOME: fakeHome, DELPHI_DB: fixture(path.join(dir, "other", "delphi.db")) }), [["whoami"]], server);
  check("with an override, nothing is said: the file was chosen on purpose", /beside the source/.test(overridden.stderr), false);

  section("delphi doctor");
  const cli = path.join(tree, "bin", "delphi");
  const pathOnly = spawnSync(process.execPath, [cli, "doctor", "--path"], { env, encoding: "utf8" });
  check("--path prints the resolved database and nothing else", pathOnly.stdout.trim(), target);
  fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, ".codex", "config.toml"),
    `[mcp_servers.delphi]\ncommand = "node"\nargs = ["${server}"]\n\n[mcp_servers.delphi.env]\nDELPHI_DB = "${path.join(dir, "elsewhere.db")}"\n`);
  fs.writeFileSync(path.join(fakeHome, ".claude.json"), JSON.stringify({
    mcpServers: { delphi: { command: "node", args: [server], env: { DELPHI_ACTOR: "claude" } } },
  }));
  const doc = spawnSync(process.execPath, [cli, "doctor", "--json"], { env, encoding: "utf8", timeout: 60000 });
  let report = {};
  try { report = JSON.parse(doc.stdout); } catch {}
  check("doctor reports the same database and id as whoami", [report.whoami && report.whoami.db_path, report.whoami && report.whoami.db_id],
    [target, first.results[0].db_id]);
  const claude = (report.agents && report.agents.found || []).find((e) => e.agent === "Claude Code");
  const codex = (report.agents && report.agents.found || []).find((e) => e.agent === "Codex");
  check("a Claude Code entry with no DELPHI_DB lands on this database", claude && claude.same_database, true);
  check("a Codex entry pointing elsewhere is a problem, named", [codex && codex.same_database, codex && codex.db_path], [false, path.join(dir, "elsewhere.db")]);
  check("Copilot with no entry is reported as not registered", (report.agents && report.agents.missing || []).some((m) => m.agent === "Copilot"), true);
  check("doctor exits 1 when something needs attention", doc.status, 1);
  check("and never edited a config", fs.readFileSync(path.join(fakeHome, ".claude.json"), "utf8").includes('"DELPHI_ACTOR":"claude"'), true);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
