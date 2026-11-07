#!/usr/bin/env node
// Edit this page: the layout model, where layouts are kept, and the History
// table widening that lets them be recorded.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/layout_test.js
//
// Four parts:
//   - the model in ui/layout.js, which is pure: reading a stored layout
//     leniently, moving and resizing within a region, presets and resets
//   - the audit widening (agent/schema_later.js widenAudit) on a copy of an
//     old database, through db.js and through the MCP server on both of its
//     routes: every row, id and attribution column kept, a column the
//     rebuild does not know kept too, and a second run a no-op
//   - layouts through db.js and main/settings.js: History says "Layout
//     changed", undo puts the last one back, a project's own layout wins and
//     "Use global" and every reset can be undone
//   - the edit-mode outline's contrast in both themes
//
// Never a real database: everything is a temp folder, and the two real paths
// are refused outright.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-layout-"));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "dbjs", "delphi.db");
delete process.env.DELPHI_DB_ID;
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
  } else {
    console.log(`  ok   ${what}`);
  }
}
const section = (name) => console.log(`\n${name}`);
const throws = (fn) => { try { fn(); return null; } catch (error) { return String(error.message || error); } };

const L = require("../ui/layout.js");
globalThis.DelphiLayout = L;
const schema = require("../settings/schema");
const T = require("../ui/tasks.js");
require("../ui/today.js");
const schemaLater = require("../agent/schema_later");

const today = L.spec("today");
const tasks = L.spec("tasks");

// --- the model ----------------------------------------------------------------
section("the model: reading a layout");
const base = L.defaults(today);
check("the default is the page as declared, in the order Today always drew it", base.regions, { top: ["capture"], main: ["weekly", "brief", "needs", "banner", "day", "quiet"] });
check("nothing hidden, every section at its own size", [base.hidden, base.sizes.day, base.sizes.capture], [[], "full", "full"]);
check("nothing stored reads as the default", L.resolve(today, null), base);
check("nor does something that is not a layout", [L.resolve(today, "junk"), L.resolve(today, [1, 2]), L.resolve(today, 42)], [base, base, base]);

const odd = L.resolve(today, {
  v: 1,
  regions: { main: ["quiet", "gone-forever", "day", 7, "day", "capture", "needs"], nowhere: ["brief"] },
  hidden: ["brief", "not-a-section", "capture"],
  sizes: { day: "half", needs: "enormous", ghost: "half" },
});
check("an unknown or removed id is ignored, never a crash", odd.regions.main.includes("gone-forever"), false);
check("an id saved in the wrong region stays in its own", [odd.regions.main.includes("capture"), odd.regions.top], [false, ["capture"]]);
check("a repeated id counts once", odd.regions.main.filter((x) => x === "day").length, 1);
check("sections the layout never named take their default place", odd.regions.main, ["weekly", "brief", "quiet", "day", "needs", "banner"]);
check("one declared first, with nothing before it there, goes first", L.insertAtDefault(["day", "quiet"], ["weekly", "day", "quiet"], "weekly"), ["weekly", "day", "quiet"]);
check("hidden keeps known ids only", odd.hidden, ["capture", "brief"]);
check("a size the section does not allow is its default", [odd.sizes.day, odd.sizes.needs], ["half", "full"]);
check("a region the page does not have is ignored", Object.keys(odd.regions), ["top", "main"]);

const newer = L.resolve(today, { v: 9, regions: { main: ["day", "quiet"] }, hidden: ["weekly"], sizes: { day: "half", quiet: "a-size-from-the-future" }, columns: 3, theme: { x: 1 } });
check("a layout from a newer version is read for what this one knows", [newer.v, newer.regions.main.indexOf("day") < newer.regions.main.indexOf("quiet"), newer.hidden, newer.sizes.day, newer.sizes.quiet], [1, true, ["weekly"], "half", "full"]);

// A section added in a later release lands beside its declared neighbours,
// wherever a person moved them.
const grown = L.checkSpec({ id: "grown", label: "Grown", regions: [{ id: "a", label: "A", sections: [
  { id: "one", label: "One" }, { id: "two", label: "Two" }, { id: "new", label: "New" }, { id: "three", label: "Three" }] }] });
check("a new section appears after the one declared before it", L.resolve(grown, { v: 1, regions: { a: ["three", "two", "one"] } }).regions.a, ["three", "two", "new", "one"]);
check("or before the one after it, when nothing before it is there", L.insertAtDefault(["three"], ["new", "three"], "new"), ["new", "three"]);
check("a bad declaration is an error at load", [
  Boolean(throws(() => L.checkSpec({ id: "x", label: "X", regions: [{ id: "a", label: "A", sections: [{ id: "s", label: "S" }, { id: "s", label: "S2" }] }] }))),
  Boolean(throws(() => L.checkSpec({ id: "Bad Id", regions: [] })))], [true, true]);

section("the model: moving, resizing, hiding");
let m = L.move(today, base, "day", -1);
check("an arrow moves a section one place", m.regions.main, ["weekly", "brief", "needs", "day", "banner", "quiet"]);
check("the stored layout is not changed under it", base.regions.main, ["weekly", "brief", "needs", "banner", "day", "quiet"]);
check("never past the start of its region", L.move(today, base, "weekly", -3).regions.main[0], "weekly");
check("never past the end, and never into another region", [L.move(today, base, "capture", 5).regions, L.move(today, base, "quiet", 5).regions], [base.regions, base.regions]);
check("a drop puts it at that index", L.moveTo(today, base, "quiet", 1).regions.main, ["weekly", "quiet", "brief", "needs", "banner", "day"]);
check("a drop index out of range is clamped", L.moveTo(today, base, "weekly", 99).regions.main.slice(-1), ["weekly"]);
m = L.resize(today, base, "day", -1);
check("Shift and Left makes it narrower", m.sizes.day, "two-thirds");
check("down to its narrowest, and no further", L.resize(today, L.resize(today, m, "day", -1), "day", -1).sizes.day, "half");
check("Shift and Right wider, up to full", L.resize(today, base, "day", 1).sizes.day, "full");
check("a section that only comes full width stays full width", L.resize(tasks, L.defaults(tasks), "list", -1).sizes.list, "full");
check("H hides", L.setHidden(today, base, "brief", true).hidden, ["brief"]);
check("a section the page keeps cannot be hidden", L.setHidden(tasks, L.defaults(tasks), "list", true).hidden, []);
const messy = L.resize(today, L.setHidden(today, L.move(today, base, "day", -3), "day", true), "day", -1);
check("reset this section: its place, its size, shown", (() => { const r = L.resetSection(today, messy, "day"); return [r.regions.main, r.sizes.day, r.hidden]; })(),
  [base.regions.main, "full", []]);
check("and nothing else moves", L.resetSection(today, L.move(today, messy, "quiet", -5), "day").regions.main, ["quiet", "weekly", "brief", "needs", "banner", "day"]);

section("the model: presets, storing, and which layout wins");
const focus = L.preset(today, "focus");
check("the Focus preset leaves the capture line and your day", L.defaults(today).regions.main.concat(["capture", "banner"]).filter((id) => !focus.hidden.includes(id)).sort(), ["capture", "day"]);
check("and puts your day first", focus.regions.main[0], "day");
check("every preset is a layout the schema accepts", [today, tasks].flatMap((spec) => spec.presets.map((p) => throws(() => schema.check("layouts", L.compact(spec, L.preset(spec, p.id)))))).filter(Boolean), []);
check("the Default preset is the default", L.isDefault(today, L.preset(today, "default")), true);
check("stored sizes are only the ones changed", L.compact(today, L.resize(today, base, "day", -1)).sizes, { day: "two-thirds" });
check("compact is what resolve reads back", L.same(today, L.resolve(today, L.compact(today, odd)), odd), true);
const rows = [
  { screen: "tasks", project_id: null, layout: L.compact(tasks, L.preset(tasks, "focus")) },
  { screen: "tasks", project_id: 4, layout: L.compact(tasks, L.preset(tasks, "compact")) },
  { screen: "tasks", project_id: 5, layout: null },
  { screen: "today", project_id: null, layout: L.compact(today, focus) },
];
check("a project's own layout wins there", L.effective(tasks, rows, 4).source, "project");
check("another project gets the global one", L.effective(tasks, rows, 9).source, "global");
check("a project whose own was reset (NULL) gets the global one", L.effective(tasks, rows, 5).source, "global");
check("All projects reads the global one", L.effective(tasks, rows, null).source, "global");
check("an unscoped page never reads a project's row", L.effective(today, [{ screen: "today", project_id: 4, layout: L.compact(today, focus) }], 4).source, "default");
check("nothing stored is the default", L.effective(tasks, [], 4).source, "default");
check("what a screen reader hears", L.describe(today, L.move(today, base, "day", -1), "day"), "Your day, 4 of 6 in Body, full width");

section("the screens, everywhere they are named");
const appText = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const registered = [...L.screens(), ...(/DelphiLayout\.register\(\{\s*id: "runs"/.test(appText) ? ["runs"] : [])].sort();
check("every screen a page registers is in settings/schema.js, and only those", registered, schema.LAYOUT_SCREENS.map((s) => s.id).sort());
check("scoped agrees", [Boolean(today.scoped), Boolean(tasks.scoped)], [schema.LAYOUT_SCREENS.find((s) => s.id === "today").scoped, schema.LAYOUT_SCREENS.find((s) => s.id === "tasks").scoped]);
check("the sizes are the schema's", L.SIZES, schema.LAYOUT_SIZES);
check("the version is the schema's", L.VERSION, schema.LAYOUT_VERSION);
check("Tasks exports the same declaration it registers", T.LAYOUT === tasks, true);
check("every page offers a Focus preset", [today, tasks].map((s) => s.presets.some((p) => p.id === "focus")).concat(/id: "focus", label: "Focus"/.test(appText.slice(appText.indexOf("const RUNS_LAYOUT"), appText.indexOf("function renderRuns")))), [true, true, true]);
check("the page draws through the layout", [
  /DelphiLayout\.mount\("today", parts\)/.test(fs.readFileSync(path.join(ROOT, "ui", "today.js"), "utf8")),
  /DelphiLayout\.mount\("tasks", parts, \{ projectId/.test(fs.readFileSync(path.join(ROOT, "ui", "tasks.js"), "utf8")),
  /DelphiLayout\.mount\("runs", parts\)/.test(appText)], [true, true, true]);
check("the layouts are read before the first paint", /const layouts = window\.DelphiLayout \? DelphiLayout\.load\(\) : null;[\s\S]*?await layouts;\s*await reopen\(\);/.test(appText), true);
check("and again on every refresh, so an undo shows", /async function refresh\(\) \{[\s\S]{0,400}DelphiLayout\.load\(\)[\s\S]{0,200}await layouts;/.test(appText), true);
check("not in localStorage", /localStorage\s*\.|sessionStorage\s*\./.test(fs.readFileSync(path.join(ROOT, "ui", "layout.js"), "utf8")), false);

// --- the audit table ------------------------------------------------------------
section("the audit table's entity list");
const { DatabaseSync } = require("node:sqlite");
const fresh = new DatabaseSync(":memory:");
fresh.exec(fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8"));
const freshSql = fresh.prepare("SELECT sql FROM sqlite_master WHERE name = 'audit'").get().sql;
check("schema.sql's CHECK names exactly AUDIT_ENTITIES", schemaLater.auditEntitiesIn(freshSql), schemaLater.AUDIT_ENTITIES);
check("and layout is one", schemaLater.AUDIT_ENTITIES.includes("layout"), true);
check("schema.sql's audit columns are AUDIT_COLUMNS", fresh.prepare("SELECT name FROM pragma_table_info('audit') ORDER BY cid").all().map((r) => r.name), schemaLater.AUDIT_COLUMNS.map(([n]) => n));
check("a fresh database needs no widening", schemaLater.auditRebuildPlan((s) => fresh.prepare(s).all()), []);
check("a table with no CHECK on entity is left alone", schemaLater.auditEntitiesIn("CREATE TABLE audit (id INTEGER PRIMARY KEY, entity TEXT)"), null);
check("an entity a newer Delphi allowed stays allowed", (() => {
  const t = new DatabaseSync(":memory:");
  t.exec("CREATE TABLE audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')), action TEXT NOT NULL, entity TEXT NOT NULL CHECK (entity IN ('task', 'future_kind')), summary TEXT NOT NULL, note TEXT DEFAULT 'two  spaces')");
  t.exec("INSERT INTO audit (action, entity, summary) VALUES ('create', 'future_kind', 'kept')");
  schemaLater.widenAudit((s) => t.prepare(s).all(), (list) => { for (const s of list) t.prepare(s).run(); });
  const sql = t.prepare("SELECT sql FROM sqlite_master WHERE name = 'audit'").get().sql;
  return [schemaLater.auditEntitiesIn(sql).slice(-2), t.prepare("SELECT entity, note FROM audit").get(), t.prepare("SELECT dflt_value FROM pragma_table_info('audit') WHERE name = 'note'").get().dflt_value];
})(), [["layout", "future_kind"], { entity: "future_kind", note: "two  spaces" }, "'two  spaces'"]);
check("a quoted column's CHECK is still read", schemaLater.auditEntitiesIn(`CREATE TABLE "audit" ("entity" TEXT CHECK ("entity" IN ('task', 'note')))`), ["task", "note"]);

function findSqlite() {
  for (const c of ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"]) if (fs.existsSync(c)) return c;
  return "sqlite3";
}
const SQLITE = findSqlite();
const q = (file, statement) => {
  const out = execFileSync(SQLITE, ["-json", guardPath(file), statement], { encoding: "utf8" }).trim();
  return out ? JSON.parse(out) : [];
};
const auditSql = (file) => (q(file, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit'")[0] || {}).sql;
const auditIndexes = (file) => q(file, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit' ORDER BY name").map((r) => r.name);
const allAudit = (file) => q(file, "SELECT * FROM audit ORDER BY id");

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "pre_m0.sql"), "utf8");
// An old database as a 1.7 install has it: the seven entity CHECK, the
// attribution columns schema_later added, rows written by people and agents.
// Plus what a later slice would add (slice 12's project_id and its index) and
// a column with a NOT NULL default, which a rebuild from a typed list would drop.
const OLD_ROWS = `
ALTER TABLE audit ADD COLUMN actor TEXT;
ALTER TABLE audit ADD COLUMN actor_type TEXT;
ALTER TABLE audit ADD COLUMN session_id INTEGER;
ALTER TABLE audit ADD COLUMN job_id INTEGER;
ALTER TABLE audit ADD COLUMN step TEXT;
ALTER TABLE audit ADD COLUMN project_id INTEGER;
ALTER TABLE audit ADD COLUMN kept_flag TEXT NOT NULL DEFAULT 'kept';
CREATE INDEX idx_audit_project ON audit(project_id, id);
INSERT INTO audit (id, at, action, entity, entity_id, summary, label, before_json, after_json, undone, actor, actor_type, session_id, job_id, step, project_id) VALUES
  (3, '2026-01-01 10:00:00', 'create', 'task', 1, 'created', 'an old task', NULL, '{"id":1}', 0, 'you', 'human', NULL, NULL, 'w1', 1),
  (7, '2026-01-02 10:00:00', 'update', 'task', 1, 'marked done (by claude-code:3)', 'an old task', '{"status":"doing"}', '{"status":"done"}', 1, 'claude-code:3', 'agent', 3, 12, 's7', 1),
  (8, '2026-01-03 10:00:00', 'update', 'scratchpad', 4, 'wrote to the pad', 'Plan', '{"body":"a"}', '{"body":"b"}', 0, 'codex:9', 'agent', 9, NULL, 's8', NULL),
  (41, '2026-01-04 10:00:00', 'create', 'handoff', 2, 'job queued', NULL, NULL, '{}', 0, 'delphi', 'tool', NULL, 2, 's41', 2);
UPDATE audit SET kept_flag = 'special' WHERE id = 8;
-- A person's own view over History, and a trigger elsewhere that writes it.
-- Since SQLite 3.26 a rename re-checks both, and without legacy_alter_table
-- each would block the widening on every launch.
CREATE VIEW recent_history AS SELECT id, summary FROM audit ORDER BY id DESC;
CREATE TRIGGER notes_history_test AFTER INSERT ON notes BEGIN
  INSERT INTO audit (action, entity, entity_id, summary) VALUES ('create', 'note', new.id, 'note by trigger');
END;
`;
function oldDatabase(file, { leftover = false } = {}) {
  guardPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
  execFileSync(SQLITE, [file], { input: FIXTURE + OLD_ROWS + (leftover ? "\nCREATE TABLE audit_rebuilt (id INTEGER);\n" : ""), encoding: "utf8" });
}

// What the old file held, to compare every route against.
const probe = path.join(dir, "probe", "delphi.db");
oldDatabase(probe);
const OLD = allAudit(probe);
check("the old database starts narrow", schemaLater.auditEntitiesIn(auditSql(probe)).includes("layout"), false);
check("and holds the rows to keep", OLD.map((r) => r.id), [3, 7, 8, 41]);
const OLD_INDEXES = auditIndexes(probe);

function provenWidened(label, file) {
  check(`${label}: the CHECK names every entity`, schemaLater.auditEntitiesIn(auditSql(file)), schemaLater.AUDIT_ENTITIES);
  check(`${label}: every row, id and column kept, attribution included`, allAudit(file), OLD);
  check(`${label}: a column the rebuild does not name is kept, with its NOT NULL default`,
    q(file, "SELECT name, \"notnull\" AS nn, dflt_value FROM pragma_table_info('audit') WHERE name IN ('project_id', 'kept_flag') ORDER BY cid"),
    [{ name: "project_id", nn: 0, dflt_value: null }, { name: "kept_flag", nn: 1, dflt_value: "'kept'" }]);
  check(`${label}: every index on audit is back, a later slice's included`, auditIndexes(file).filter((n) => OLD_INDEXES.includes(n)), OLD_INDEXES);
  check(`${label}: no scratch table left behind`, q(file, "SELECT name FROM sqlite_master WHERE name LIKE 'audit_rebuilt%'"), []);
  check(`${label}: a layout row can be written now`, (() => {
    try { execFileSync(SQLITE, [file, "INSERT INTO audit (action, entity, entity_id, summary) VALUES ('update', 'layout', 1, 'Layout changed'); DELETE FROM audit WHERE entity = 'layout';"]); return true; } catch { return false; }
  })(), true);
  check(`${label}: the integrity check passes`, q(file, "PRAGMA integrity_check")[0].integrity_check, "ok");
  check(`${label}: a view over audit still reads`, q(file, "SELECT COUNT(*) AS n FROM recent_history")[0].n, OLD.length);
  check(`${label}: and a trigger on notes still writes History`, (() => {
    execFileSync(SQLITE, [file, "INSERT INTO notes (id, project_id, title, body) VALUES (900, 1, 't', 'b');"]);
    const wrote = q(file, "SELECT summary FROM audit WHERE entity = 'note' AND entity_id = 900").map((r) => r.summary);
    execFileSync(SQLITE, [file, "DELETE FROM notes WHERE id = 900; DELETE FROM audit WHERE entity = 'note' AND entity_id = 900;"]);
    return wrote;
  })(), ["note by trigger"]);
}

// The server, on each route. Started twice: the second start is the
// idempotence check, and must leave the schema byte for byte as it was.
const { openServer } = require("../sheet/client");
async function serverOn(label, env) {
  const file = path.join(dir, label.replace(/[^a-z0-9]+/gi, "-"), "delphi.db");
  oldDatabase(file, { leftover: label.includes("leftover") });
  const start = async () => {
    const stderr = [];
    const client = openServer({
      server: path.join(ROOT, "agent", "mcp_server.js"), command: process.execPath, actor: "layout-test", clientName: "delphi-layout-test",
      env: { ELECTRON_RUN_AS_NODE: "1", DELPHI_DB: guardPath(file), DELPHI_SQLITE: SQLITE, DELPHI_SESSION: "1", DELPHI_SQLITE_ROUTE: "", ...env },
      warn: (...parts) => stderr.push(parts.join(" ")),
    });
    try {
      await client.start();
      await client.call("whoami", {});
    } finally { client.close(); }
    return stderr.filter((l) => /widen|History table/.test(l));
  };
  section(`the widening through the server, ${label}`);
  check(`${label}: nothing went wrong on stderr`, await start(), []);
  provenWidened(label, file);
  const schemaBefore = q(file, "SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
  await start();
  check(`${label}: a second start changes nothing`, q(file, "SELECT type, name, sql FROM sqlite_master ORDER BY type, name"), schemaBefore);
  check(`${label}: and the rows are still the old rows`, allAudit(file), OLD);
}

// A copy that would come out short must never drop the old table. The plan's
// own check is what stops it, so it is run against a table whose copy is made
// to lose a row (a trigger on the rebuilt table deletes what lands).
section("a short copy stops before anything is dropped");
{
  const file = path.join(dir, "short", "delphi.db");
  oldDatabase(file);
  const db = new DatabaseSync(file);
  const query = (s) => db.prepare(s).all();
  const plan = schemaLater.auditRebuildPlan(query);
  const at = plan.findIndex((s) => s.startsWith("INSERT INTO audit_rebuilt ("));
  plan.splice(at + 1, 0, "DELETE FROM audit_rebuilt WHERE id = 7");
  let refused = null;
  db.exec("BEGIN");
  try { for (const s of plan) db.prepare(s).run(); db.exec("COMMIT"); } catch (error) { refused = String(error.message); db.exec("ROLLBACK"); }
  db.close();
  check("the batch is refused by the row check", /CHECK constraint failed/.test(refused || ""), true);
  check("and the old table is untouched", [allAudit(file), schemaLater.auditEntitiesIn(auditSql(file)).includes("layout")], [OLD, false]);
}

// The binary route plans first and runs later, as one script. Another process
// that adds a column, or an index, in between must stop the plan, not lose
// what it added: the plan's first statement checks the table is still the one
// it read.
section("a plan made before another process changed the table does not run");
for (const [what, change, survives] of [
  ["a column", "ALTER TABLE audit ADD COLUMN added_meanwhile TEXT DEFAULT 'mine'", "SELECT COUNT(*) AS n FROM pragma_table_info('audit') WHERE name = 'added_meanwhile'"],
  ["an index", "CREATE INDEX idx_audit_meanwhile ON audit(step)", "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_audit_meanwhile'"],
]) {
  const file = path.join(dir, `stale-${what.replace(/ /g, "-")}`, "delphi.db");
  oldDatabase(file);
  const a = new DatabaseSync(file);
  const plan = schemaLater.auditRebuildPlan((st) => a.prepare(st).all());
  const b = new DatabaseSync(file);
  b.exec(change);
  b.close();
  let refused = null;
  a.exec("BEGIN IMMEDIATE");
  try { for (const st of ["PRAGMA legacy_alter_table = ON", ...plan]) a.prepare(st).all(); a.exec("COMMIT"); } catch (error) { refused = String(error.message); a.exec("ROLLBACK"); }
  a.close();
  check(`${what} added mid-way: the stale plan is refused`, /CHECK constraint failed/.test(refused || ""), true);
  check(`${what} added mid-way: it is still there, and every row`, [q(file, survives)[0].n, allAudit(file).length], [1, OLD.length]);
}

// The routes that hold a connection plan inside BEGIN IMMEDIATE: a second
// connection cannot change the table between the plan and the rebuild, and
// whatever it added before is planned for.
section("db.js and the server on node:sqlite plan inside the lock");
{
  const file = path.join(dir, "locked", "delphi.db");
  oldDatabase(file);
  const a = new DatabaseSync(file);
  const b = new DatabaseSync(file);
  b.exec("PRAGMA busy_timeout = 0");
  let blocked = null;
  let addedFirst = false;
  const query = (st) => {
    if (st === "BEGIN IMMEDIATE" && !addedFirst) { addedFirst = true; b.exec("ALTER TABLE audit ADD COLUMN added_first TEXT DEFAULT 'kept too'"); }
    const out = a.prepare(st).all();
    if (st === "BEGIN IMMEDIATE") { try { b.exec("ALTER TABLE audit ADD COLUMN added_during TEXT"); blocked = false; } catch (error) { blocked = String(error.message); } }
    return out;
  };
  const result = schemaLater.widenAuditLocked(query);
  b.close();
  check("it widened", [result.ran, schemaLater.auditEntitiesIn(auditSql(file)).includes("layout")], [true, true]);
  check("a second connection could not change the table mid-way", /locked|busy/i.test(blocked || ""), true);
  check("a column added just before was planned for, with its value", q(file, "SELECT added_first FROM audit WHERE id = 3"), [{ added_first: "kept too" }]);
  check("legacy_alter_table is back as it was", Number(a.prepare("PRAGMA legacy_alter_table").get().legacy_alter_table), 0);
  a.close();
}

// A widening that fails does not stop the app opening, and a layout save then
// says why in a sentence. A History table whose summary was once nullable and
// holds a NULL cannot be copied into the canonical one, which is such a case.
async function failedWidening() {
  section("a widening that fails leaves the app working");
  const file = path.join(dir, "broken", "delphi.db");
  oldDatabase(file);
  execFileSync(SQLITE, [file, `DROP VIEW recent_history; DROP TRIGGER notes_history_test; DROP TABLE audit;
    CREATE TABLE audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')), action TEXT NOT NULL,
      entity TEXT NOT NULL CHECK (entity IN ('task', 'note', 'project', 'link', 'scratchpad', 'session', 'handoff')),
      entity_id INTEGER, summary TEXT, label TEXT, before_json TEXT, after_json TEXT, undone INTEGER NOT NULL DEFAULT 0, undone_at TEXT,
      actor TEXT, actor_type TEXT, session_id INTEGER, job_id INTEGER, step TEXT);
    INSERT INTO audit (action, entity, entity_id, summary) VALUES ('create', 'task', 1, NULL);`]);
  const script = path.join(dir, "broken", "open.js");
  fs.writeFileSync(script, `
    const db = require(${JSON.stringify(path.join(ROOT, "db.js"))});
    const out = { projects: db.listProjects().length, layouts: db.listLayouts().length };
    const handlers = new Map();
    require(${JSON.stringify(path.join(ROOT, "main", "settings.js"))}).registerLayouts((n, f) => handlers.set(n, f), { db, projectName: () => "P" });
    try { handlers.get("layout:save")({ screen: "today", layout: { v: 1, hidden: ["brief"] } }); out.saved = true; } catch (e) { out.error = e.message; }
    console.log(JSON.stringify(out));`);
  let out = "";
  let stderr = "";
  try {
    out = execFileSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DELPHI_DB: guardPath(file), DELPHI_DATA_DIR: path.dirname(file) }, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) { out = String(error.stdout || ""); stderr = String(error.stderr || error.message); }
  const got = (() => { try { return JSON.parse(out.trim().split("\n").pop()); } catch { return { crashed: stderr.slice(0, 300) }; } })();
  check("the app opens, and the migrations after it ran (the layouts table is there)", [got.projects > 0, got.layouts], [true, 0]);
  check("a layout save says why, in a sentence", /Layouts cannot be saved on this database yet/.test(got.error || ""), true);
  check("and the History table is as it was", [q(file, "SELECT COUNT(*) AS n FROM audit")[0].n, schemaLater.auditEntitiesIn(auditSql(file)).includes("layout")], [1, false]);
}

// --- db.js, main/settings.js and undo ------------------------------------------
async function viaApp() {
  section("the widening through db.js (the app)");
  const file = process.env.DELPHI_DB;
  oldDatabase(file);
  const db = require("../db");
  db.listProjects();
  provenWidened("db.js", file);
  const conn = db.handle();
  check("db.js: a second open finds nothing to do", schemaLater.widenAudit((s) => conn.prepare(s).all(), () => { throw new Error("must not run"); }), { ran: false, statements: 0 });
  check("db.js: the layouts table and its index exist", [
    q(file, "SELECT name FROM pragma_table_info('layouts') ORDER BY cid").map((r) => r.name),
    q(file, "SELECT name FROM sqlite_master WHERE name = 'idx_layouts_scope'").length], [["id", "screen", "project_id", "layout", "created_at", "updated_at"], 1]);

  section("layouts through main/settings.js, recorded and undone");
  const handlers = new Map();
  require("../main/settings").registerLayouts((name, fn) => handlers.set(name, fn), { db, projectName: (id) => { const p = db.getProject(id); return p ? p.name : null; } });
  const call = (name, args) => handlers.get(name)(args);
  const top = () => db.listAudit(1)[0];
  const stored = (screen, pid = null) => (db.listLayouts().find((r) => r.screen === screen && (r.project_id ?? null) === pid) || {}).layout;

  // Edit this page on Today: drag Your day up two, then Done.
  const dragged = L.compact(today, L.moveTo(today, L.defaults(today), "day", 1));
  call("layout:save", { screen: "today", layout: dragged });
  check("Done stores the layout", stored("today"), dragged);
  check("History says Layout changed, for Today, by you", (({ entity, summary, label, actor, actor_type, restorable }) => ({ entity, summary, label, actor, actor_type, restorable }))(top()),
    { entity: "layout", summary: "Layout changed", label: "Today", actor: "you", actor_type: "human", restorable: 1 });
  check("saving the same layout again records nothing", (() => { const n = db.listAudit(500).length; call("layout:save", { screen: "today", layout: dragged }); return db.listAudit(500).length - n; })(), 0);
  const focusLayout = L.compact(today, L.preset(today, "focus"));
  call("layout:save", { screen: "today", layout: focusLayout, note: "Focus preset" });
  check("a preset is one more change, named", [top().summary, top().label, stored("today")], ["Layout changed", "Today: Focus preset", focusLayout]);
  db.undo(top().id);
  check("undo puts the layout before it back", stored("today"), dragged);
  db.undo(db.listAudit(10).find((e) => e.entity === "layout" && !e.undone).id);
  check("and undoing the first save leaves no layout at all", db.listLayouts().filter((r) => r.screen === "today"), []);

  // An unknown id saved by some other version reads leniently in the page.
  call("layout:save", { screen: "today", layout: { v: 1, regions: { main: ["from-a-later-release", "quiet"] }, hidden: ["gone"] } });
  check("a layout naming sections this page lacks is stored, and read leniently", [
    stored("today").regions.main.includes("from-a-later-release"), L.effective(today, db.listLayouts(), null).layout.regions.main, L.effective(today, db.listLayouts(), null).layout.hidden],
    [true, ["weekly", "brief", "needs", "banner", "day", "quiet"], []]);

  section("the per-project override, and the three resets");
  const legacy = 1;
  call("layout:save", { screen: "tasks", layout: L.compact(tasks, L.preset(tasks, "focus")) });
  call("layout:save", { screen: "tasks", projectId: legacy, layout: L.compact(tasks, L.preset(tasks, "compact")), note: "Compact preset" });
  check("History names the project", top().label, "Tasks in Legacy project: Compact preset");
  check("the project's own layout wins there, so the chip shows", L.effective(tasks, db.listLayouts(), legacy).source, "project");
  check("and the other project gets the global one", L.effective(tasks, db.listLayouts(), 2).source, "global");
  call("layout:save", { screen: "tasks", projectId: legacy, layout: null, note: "back to the global layout" });
  check("Use global is a reset of the project's row", [top().summary, top().label, L.effective(tasks, db.listLayouts(), legacy).source],
    ["Layout reset", "Tasks in Legacy project: back to the global layout", "global"]);
  db.undo(top().id);
  check("and undo gives the project its own back", L.effective(tasks, db.listLayouts(), legacy).source, "project");

  call("layout:save", { screen: "tasks", layout: null, note: "page reset" });
  check("reset this page: the global row goes back to the page's own", [stored("tasks"), top().summary], [null, "Layout reset"]);
  db.undo(top().id);
  check("undone", L.effective(tasks, db.listLayouts(), null).source, "global");

  const before = db.listLayouts().filter((r) => r.layout != null).length;
  const result = call("layout:resetAll");
  check("reset everything: no stored layout is left", result.filter((r) => r.layout != null), []);
  const resets = db.listAudit(20).filter((e) => e.entity === "layout" && e.summary === "Layout reset" && /everything reset/.test(e.label));
  check("one History row per layout, all one step", [resets.length, new Set(resets.map((e) => e.step)).size], [before, 1]);
  const undone = db.undoLast(before);
  check("and undoing them puts every one back", [undone.undone, db.listLayouts().filter((r) => r.layout != null).length], [before, before]);

  section("what the window cannot do");
  check("a screen that is not a page is refused", Boolean(throws(() => call("layout:save", { screen: "settings", layout: null }))), true);
  check("a project on a page with one layout for all is refused", /one layout for every project/.test(throws(() => call("layout:save", { screen: "today", projectId: legacy, layout: null })) || ""), true);
  check("a project that does not exist is refused", /No project 999/.test(throws(() => call("layout:save", { screen: "tasks", projectId: 999, layout: null })) || ""), true);
  check("true is not project 1", /No project true/.test(throws(() => call("layout:save", { screen: "tasks", projectId: true, layout: null })) || ""), true);
  check("a layout of the wrong shape is refused", Boolean(throws(() => call("layout:save", { screen: "today", layout: { v: "one", regions: [] } }))), true);
  check("a note is plain and short", (() => { call("layout:save", { screen: "today", layout: dragged, note: `x\u0007y ${"z".repeat(200)}` }); return top().label.length <= "Today: ".length + 60 && !/\u0007/.test(top().label); })(), true);

  section("a project deleted and put back keeps its layout");
  const own = stored("tasks", legacy);
  const ownEntry = db.listAudit(100).find((e) => e.entity === "layout" && !e.undone && /^Tasks in Legacy project/.test(e.label || ""));
  db.deleteProject(legacy, { tasks: "keep" });
  check("the delete takes its rows", db.listLayouts().filter((r) => r.project_id === legacy), []);
  check("undoing that layout's change now is refused, by name", /went with the project "Legacy project".*Undo that delete first/.test(throws(() => db.undo(ownEntry.id)) || ""), true);
  check("and is not marked undone", db.listAudit(200).find((e) => e.id === ownEntry.id).undone, 0);
  db.undo(db.listAudit(5).find((e) => e.entity === "project" && e.action === "delete").id);
  check("and the undo brings them back", stored("tasks", legacy), own);
  check("under the same id, so the layout's own change can be undone now", (() => { db.undo(ownEntry.id); return db.listAudit(300).find((e) => e.id === ownEntry.id).undone; })(), 1);
}

// --- the outline's contrast ------------------------------------------------------
function contrast() {
  section("the edit-mode outline, against every ground, in both themes");
  const css = fs.readFileSync(path.join(ROOT, "styles", "tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const block = (pattern) => {
    const at = css.search(pattern);
    const open = css.indexOf("{", at);
    let depth = 1; let i = open + 1;
    for (; i < css.length && depth; i++) { if (css[i] === "{") depth++; else if (css[i] === "}") depth--; }
    return Object.fromEntries([...css.slice(open + 1, i - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
  };
  const light = block(/(^|\n):root\s*\{/);
  const darkMedia = block(/:root:not\(\[data-theme="light"\]\)\s*\{/);
  const darkPinned = block(/:root\[data-theme="dark"\]\s*\{/);
  const rgb = (hex) => { const h = String(hex).replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q2) => q2 - p); return (x + 0.05) / (y + 0.05); };
  check("both dark blocks carry the same outline tokens", [darkMedia["--ly-outline"], darkMedia["--ly-outline-quiet"]], [darkPinned["--ly-outline"], darkPinned["--ly-outline-quiet"]]);
  for (const [theme, vars] of [["light", light], ["dark", { ...light, ...darkPinned }]]) {
    for (const token of ["--ly-outline", "--ly-outline-quiet"]) {
      for (const ground of ["--bg", "--surface", "--raised"]) {
        const r = ratio(vars[token], vars[ground]);
        check(`${theme}: ${token} on ${ground} is ${r.toFixed(2)}:1, at least 3:1`, r >= 3, true);
      }
    }
  }
  const layoutCss = fs.readFileSync(path.join(ROOT, "styles", "layout.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  check("the dashed outline is drawn in that token", /\.ly-editing \.ly-cell \{[^}]*outline: 1\.5px dashed var\(--ly-outline\)/.test(layoutCss), true);
  check("and a hidden one in the quiet one", /\.ly-cell\.ly-hidden \{[^}]*outline-color: var\(--ly-outline-quiet\)/.test(layoutCss), true);
  check("styles/layout.css names no colour of its own", layoutCss.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi), null);
  check("index.html loads it, and ui/layout.js before the pages", (() => {
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    return html.includes('href="styles/layout.css"') && html.indexOf('src="ui/layout.js"') < html.indexOf('src="ui/today.js"') && html.indexOf('src="ui/layout.js"') < html.indexOf('src="app.js"');
  })(), true);
  const dashes = ["ui/layout.js", "styles/layout.css", "tools/layout_test.js"].filter((f) => /[\u2013\u2014\u2212]/.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
  check("no em, en or minus dashes in the new files", dashes, []);
}

(async () => {
  try {
    contrast();
    await serverOn("server node:sqlite", {});
    await serverOn("server sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" });
    await serverOn("server sqlite3 binary, leftover scratch table", { DELPHI_SQLITE_ROUTE: "binary" });
    await failedWidening();
    await viaApp();
  } catch (error) {
    failures++;
    console.error(`  FAIL ${error.stack || error}`);
  } finally {
    console.log(`\n${checks - failures}/${checks} checks passed`);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    process.exit(failures ? 1 : 0);
  }
})();
