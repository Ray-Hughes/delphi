#!/usr/bin/env node
/**
 * MCP server over the brain.
 *
 * Speaks JSON-RPC 2.0 on stdin and stdout, which is the stdio transport every
 * MCP client supports. That is what lets Claude Code and Copilot agent mode use
 * the same store: neither is talking to the other, they are both talking to this.
 *
 * Written against the protocol directly rather than an SDK so it has no
 * dependencies. It runs under whatever Node the editor launched it with, which
 * is the awkward part: that Node may or may not have node:sqlite, so there are
 * two ways in and the better one is tried first. See openDatabase below.
 */

const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const path = require("path");
const fs = require("fs");
const os = require("os");

/**
 * Finds the database, by the one rule the app and the command line also use.
 *
 * It used to be worked out here, as a twin of paths.js that preferred the
 * installed copy, while paths.js preferred the checkout when run from source.
 * Each was right alone and together they were the bug: the app read one file
 * and every agent wrote the other, and nothing errored. agent/locate.js is now
 * the only place this is decided. DELPHI_DB still names a file outright, which
 * is what the app passes to every agent it launches.
 */
const locate = require("./locate");
const RESOLVED = locate.resolve();
const DB = RESOLVED.dbPath;

const directives = require("./directives");
// settings.json lives in the data folder, which is the database's own folder
// unless DELPHI_DATA_DIR says otherwise, exactly as the app reads it.
const SETTINGS_FILE = path.join(RESOLVED.dataDir, "settings.json");
const readSettings = directives.makeSettingsReader(SETTINGS_FILE);

/**
 * The scratchpad setting, resolved against the projects that actually exist.
 *
 * The project is looked up rather than trusted, because a project can be deleted
 * after being chosen as the destination. Naming a project_id that no longer
 * exists would send agents to write notes that fail, so a dangling id degrades to
 * "no default set" instead.
 */
function scratchpadState() {
  const settings = readSettings();
  if (settings.scratchpadMode !== true) return { on: false, project: null };
  let project = null;
  if (settings.scratchpadProjectId != null) {
    try {
      project = sql("SELECT id, name FROM projects WHERE id = :p1 AND status != 'archived'",
                    [settings.scratchpadProjectId])[0] || null;
    } catch {
      project = null;
    }
  }
  return { on: true, project };
}

// Which tools carry the directive in their description. write_scratchpad is
// where the working document is actually written, list_scratchpads is what the
// directive tells agents to call first so they add to the existing pad, and
// list_projects is where an agent is oriented before it has decided anything.
//
// add_note keeps it too, because an agent reaching for a note when it wants a pad
// is the mistake this is guarding against, and the description is the last place
// to catch it.
const SCRATCHPAD_TOOLS = new Set(["write_scratchpad", "list_scratchpads", "add_note", "list_projects"]);

/**
 * The second opinion setting, and the agent it names.
 *
 * The row is read from harnesses so a model or flag set in Settings applies, and
 * falls back to the built-in definition because a database the app has never
 * opened since an upgrade has no row yet, and the tool has to work without the
 * app running. A row someone turned off stays off.
 */
function secondOpinionAgent() {
  const key = String(readSettings().secondOpinionAgent || "copilot");
  let row = null;
  try { row = sql("SELECT * FROM harnesses WHERE key = :p1", [key])[0] || null; } catch { row = null; }
  if (!row) {
    const builtin = harness.BUILTINS.find((h) => h.key === key);
    if (builtin) row = { ...builtin, args_json: JSON.stringify(builtin.args), enabled: 1 };
  }
  return row;
}

function secondOpinionState() {
  if (readSettings().secondOpinionMode !== true) return { on: false, label: null };
  const row = secondOpinionAgent();
  return { on: true, label: (row && row.label) || "the second opinion agent" };
}

// Which tools carry the second opinion note. second_opinion itself, and the
// moments the rule is about: finishing a queued task, writing up what was found,
// and the orienting call.
const SECOND_OPINION_TOOLS = new Set(["second_opinion", "queue_complete", "add_comment", "sheet_append", "list_projects"]);
// How often a running session is reminded through tool results. Once an hour is
// enough to reach a session that started before the mode was turned on, without
// repeating itself so often that the model learns to skip it.
const SECOND_OPINION_REMIND_MS = 60 * 60 * 1000;
let secondOpinionRemindedAt = 0;
const ACTOR = process.env.DELPHI_ACTOR || "agent";

/**
 * Finds the sqlite3 binary, for when node:sqlite is not available.
 *
 * An MCP client launches this without a login shell, so PATH may not carry the
 * one the user sees in a terminal. The system copy on macOS is checked first
 * because it is always present and always adequate here. Windows ships no sqlite3
 * at all, which is why this is now the fallback rather than the only route.
 */
function findSqlite() {
  const candidates = [
    process.env.DELPHI_SQLITE,
    ...(process.platform === "win32"
      ? [
          path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "sqlite3.exe"),
          "C:\\ProgramData\\chocolatey\\bin\\sqlite3.exe",
          "sqlite3.exe",
        ]
      : ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"]),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return process.platform === "win32" ? "sqlite3.exe" : "sqlite3";
}

/**
 * Opens the database the best way this Node allows.
 *
 * node:sqlite is preferred wherever it exists. It is in process, so there is no
 * temporary file and no subprocess per query, and it is the only route that works
 * on Windows out of the box: Windows ships no sqlite3 command, so a server that
 * can only shell out is a server that cannot start there.
 *
 * It is not always there. It landed in Node 22.5 behind a flag and only became
 * available unflagged later, so requiring it throws on plenty of the versions an
 * editor might be running. That throw is the whole test.
 *
 * DELPHI_SQLITE_ROUTE=binary skips it. That is for the tests, which have to
 * prove both routes on a machine where node:sqlite is always there.
 */
function openDatabase() {
  try {
    if (process.env.DELPHI_SQLITE_ROUTE === "binary") throw new Error("binary route asked for");
    const { DatabaseSync } = require("node:sqlite");
    const handle = new DatabaseSync(DB);
    // Wait for another writer rather than failing on contention. Two agents
    // claiming from the same queue at the same moment is the normal case here,
    // not the edge one.
    handle.exec("PRAGMA busy_timeout = 5000");
    // FULL, as the app sets it. Here it is the compile default; on the binary
    // route below it is not, which is why each script says it again.
    handle.exec("PRAGMA synchronous = FULL");
    return {
      kind: "node:sqlite",
      query(statement) {
        // all() rather than run() for everything. It returns rows for a SELECT
        // and an empty list for a write, which is exactly the shape the shelling
        // out version produced, so nothing downstream has to know which is in use.
        return handle.prepare(statement).all();
      },
      // Several statements as one unit, for a move that must land whole. A
      // savepoint so it nests if a caller ever holds a transaction already.
      batch(statements) {
        handle.exec("SAVEPOINT delphi_batch");
        try {
          for (const statement of statements) handle.prepare(statement).all();
          handle.exec("RELEASE delphi_batch");
        } catch (error) {
          handle.exec("ROLLBACK TO delphi_batch");
          handle.exec("RELEASE delphi_batch");
          throw error;
        }
      },
    };
  } catch {
    const binary = findSqlite();
    return {
      kind: binary,
      query(statement) {
        // Written to a file rather than bound through ".parameter set", which is
        // a dot command and therefore line-oriented: a note body containing a
        // newline silently breaks it halfway through. A quoted SQL literal inside
        // a script file spans lines happily.
        // The sqlite3 binary has no busy timeout by default: a locked database
        // is an immediate error rather than a wait, and two agents claiming at
        // once hit exactly that.
        //
        // The dot command rather than the pragma. PRAGMA busy_timeout prints the
        // value it set, and that line lands in stdout ahead of the results,
        // where it makes the JSON unparseable and every query look empty.
        // synchronous is per connection, and every call here is a new one at
        // Apple's NORMAL, so each script sets FULL first. It prints nothing.
        const lines = ["PRAGMA synchronous = FULL;", ".timeout 5000", ".mode json", ".headers on", statement];
        const file = path.join(os.tmpdir(), `delphi-${process.pid}-${Date.now()}.sql`);
        fs.writeFileSync(file, lines.join("\n"));
        try {
          const out = execFileSync(binary, [DB], {
            input: `.read ${file}\n`,
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
          });
          const trimmed = out.trim();
          if (!trimmed) return [];
          try {
            return JSON.parse(trimmed);
          } catch {
            return [];
          }
        } finally {
          try { fs.unlinkSync(file); } catch {}
        }
      },
      // Each query() is its own process, so no transaction spans two of them.
      // A batch is therefore one script in one process, between BEGIN and
      // COMMIT, with .bail so the first failure ends the process before the
      // COMMIT and the whole script rolls back. execFileSync throws on that
      // exit, with sqlite3's own message on stderr.
      batch(statements) {
        const lines = ["PRAGMA synchronous = FULL;", ".timeout 5000", ".bail on", "BEGIN IMMEDIATE;",
          ...statements.map((q) => (q.trim().endsWith(";") ? q : `${q};`)), "COMMIT;"];
        const file = path.join(os.tmpdir(), `delphi-${process.pid}-${Date.now()}-batch.sql`);
        fs.writeFileSync(file, lines.join("\n"));
        try {
          execFileSync(binary, [DB], { input: `.read ${file}\n`, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
        } catch (error) {
          const said = String((error && error.stderr) || "").trim().split("\n")[0];
          throw new Error(said || String(error.message || error));
        } finally {
          try { fs.unlinkSync(file); } catch {}
        }
      },
    };
  }
}

/**
 * The id of the file at DB, read without writing anything, or null.
 *
 * Read-only on both routes, because it is asked before the database is opened
 * for real: opening it for real migrates it, mints an id in it, or creates it
 * when it is missing, and a server about to refuse a file must not have done
 * any of that to it first.
 *
 * Read-only is not enough on its own for a WAL file. With no -wal beside it,
 * a read-only open creates an empty -wal and -shm and, being read-only, cannot
 * remove them on close. Debian's sqlite3 deletes both when it closes a file,
 * so on Linux every refusal left two new files behind; Apple's keeps an empty
 * -wal, which is why a Mac never showed it. Apple's sqlite3 cannot open such a
 * file read-only at all, so on a Mac the binary route reported "no id" for a
 * file that had one. When the -wal is absent or empty, every committed page is
 * in the main file, so it is opened immutable, which takes no locks and makes
 * no files. A -wal with frames in it may hold the id itself (the app keeps the
 * file open and checkpoints when it likes), and immutable would ignore it, so
 * that case still goes through the log.
 */
function readIdReadOnly() {
  const statement = "SELECT value FROM meta WHERE key = 'db_id'";
  let DatabaseSync = null;
  if (process.env.DELPHI_SQLITE_ROUTE !== "binary") {
    try { ({ DatabaseSync } = require("node:sqlite")); } catch {}
  }
  const walSize = () => { try { return fs.statSync(DB + "-wal").size; } catch { return 0; } };
  const immutable = walSize() === 0;
  // The plain path stays as a fallback for a path SQLite will not take as a
  // URI (a Windows share, say), which is no worse than before.
  const found = readIdFrom(statement, DatabaseSync, immutable ? [pathToFileURL(DB).href + "?immutable=1", DB] : [DB]);
  // A writer that started while it read may have put the id where immutable
  // cannot see it, so look again through the log. The writer has made the
  // -shm by then, so this second open makes nothing.
  if (immutable && walSize() > 0) return readIdFrom(statement, DatabaseSync, [DB]);
  return found;
}

function readIdFrom(statement, DatabaseSync, targets) {
  for (const target of targets) {
    if (DatabaseSync) {
      let handle;
      try { handle = new DatabaseSync(target, { readOnly: true }); } catch { continue; }
      try { return (handle.prepare(statement).get() || {}).value || null; }
      // No meta table, or not a database at all: either way it has no id.
      catch { return null; } finally { handle.close(); }
    }
    try {
      // stderr piped, not inherited: "no such table: meta" is the expected
      // answer for an old file, and would otherwise land in the client's log
      // above the refusal.
      const out = execFileSync(findSqlite(), ["-readonly", "-json", target, statement],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      return out ? (JSON.parse(out)[0] || {}).value || null : null;
    } catch (err) {
      // Only a file it could not open is worth the plain path. Anything else
      // (no meta table, not a database) is an answer, and asking again
      // without immutable would make the very files this is avoiding.
      if (!/unable to open|\buri\b/i.test(String(err.stderr || ""))) return null;
    }
  }
  return null;
}

// An agent the app launched is told which database it is for, by id as well as
// by path. A path can be right and the file behind it wrong: restored from a
// backup, swapped for another copy, or a second checkout's. Writing on regardless
// is how work disappears without an error, so this refuses to start at all,
// before the file is opened, migrated, given an id or created, and says why
// where the client's MCP log will show it. fs.writeSync rather than
// process.stderr.write, because on macOS a pipe is written asynchronously and
// process.exit does not wait for it.
if (process.env.DELPHI_DB_ID) {
  const wanted = process.env.DELPHI_DB_ID;
  const exists = fs.existsSync(DB);
  const found = exists ? readIdReadOnly() : null;
  if (found !== wanted) {
    // When the app that launched this still reports the wanted id from its open
    // handle, the file at the path was replaced under it, and launching the
    // agent again from that app would only be refused again.
    const beat = require("./identity").readAlive(RESOLVED);
    const appStale = Boolean(beat && beat.db_id === wanted);
    fs.writeSync(2,
      `delphi: refusing to start. This server was launched for the database with id ${wanted}, but ` +
      (exists ? `${DB} ${found ? `has the id ${found}` : "has no Delphi id at all"}. ` : `there is no file at ${DB}. `) +
      `Nothing was read, written or created. ` +
      (appStale
        ? `The Delphi app still has the database with id ${wanted} open, but the file at that path is now a different one: restart the Delphi app.\n`
        : `Start the agent again from the Delphi app that owns the database, or unset DELPHI_DB_ID if this file is the one you meant.\n`));
    process.exit(1);
  }
}

const DATABASE = openDatabase();

// Which file this server opened. Restoring a backup puts a different file at
// the same path while the app is closed, and an agent session that outlived it
// would carry on writing: on node:sqlite into the old file, now set aside, and
// on either route with whatever it had read from the old one in mind. So every
// call checks, and refuses in words once the file under the path has changed.
const fileId = () => { try { const st = fs.statSync(DB); return `${st.dev}:${st.ino}`; } catch { return null; } };
const OPENED_FILE = fileId();
function refuseIfReplaced() {
  const now = fileId();
  if (OPENED_FILE && now && now !== OPENED_FILE) {
    throw new Error("Delphi restored a backup. Restart this agent's session.");
  }
}

// Every insert the Sheet makes uses RETURNING, which the sqlite3 command only
// understands from 3.35. An older one (some long-term-support Linux releases
// still ship one) fails each write with a syntax error that says nothing about
// versions, so this says it once, up front, in words.
if (DATABASE.kind !== "node:sqlite") {
  try {
    const version = String(DATABASE.query("SELECT sqlite_version() AS v;")[0].v);
    const [major, minor] = version.split(".").map(Number);
    if (major < 3 || (major === 3 && minor < 35)) {
      process.stderr.write(`delphi: ${DATABASE.kind} is SQLite ${version}; Sheets need 3.35 or newer, so writes to them will fail. Install a newer sqlite3 or set DELPHI_SQLITE to one.\n`);
    }
  } catch {}
}

/**
 * Brings the database up to date before the first request, once.
 *
 * The app used to be the only thing that migrated, so an agent could meet a
 * database the app had not opened since an upgrade and fail on a column that
 * did not exist yet. Failures go to stderr, which is the client's MCP log rather
 * than the protocol stream, and the server carries on: an agent missing one
 * column it may never touch is better off than an agent with no tracker at all.
 */
const schemaLater = require("./schema_later");
const MIGRATED = schemaLater.apply((statement) => DATABASE.query(statement));
for (const failure of MIGRATED.errors) {
  process.stderr.write(`delphi: could not migrate (${failure.message}): ${failure.statement.split("\n")[0]}\n`);
}

/**
 * The file's identity, minted if this is the first process to meet it since
 * meta arrived. See agent/identity.js.
 */
const identity = require("./identity");
// Jobs (handoffs, queued work, a person's own requests): rows and rules shared
// with the app's dispatcher. See agent/jobs.js.
const jobs = require("./jobs");
// Second opinions: another agent's CLI, run read only and waited for.
const secondOpinion = require("./second_opinion");
const harness = require("../harness");
let IDENTITY = { db_id: null, created_at: null };
try {
  IDENTITY = identity.ensure((statement) => DATABASE.query(statement));
} catch (error) {
  process.stderr.write(`delphi: could not read this database's identity (${error.message})\n`);
}

// A checkout's own delphi.db is never used now, and that deserves saying once
// rather than on every start: stderr from here reaches a person running the
// delphi command on every command. "Once" is remembered in the database, per
// checkout path, so a different checkout is still mentioned. Only when nothing
// was overridden: with DELPHI_DB or DELPHI_DATA_DIR set, a file was chosen on
// purpose and the checkout one is not being ignored by surprise.
if (RESOLVED.source === "default" && RESOLVED.checkoutDbIgnored && IDENTITY.db_id) {
  try {
    const said = (DATABASE.query("SELECT value FROM meta WHERE key = 'checkout_db_noticed';")[0] || {}).value;
    if (said !== RESOLVED.checkoutDbIgnored) {
      process.stderr.write(`${locate.ignoredNotice(RESOLVED)} Run delphi doctor to see it again.\n`);
      const quoted = `'${RESOLVED.checkoutDbIgnored.replace(/'/g, "''")}'`;
      DATABASE.query(`INSERT INTO meta (key, value) VALUES ('checkout_db_noticed', ${quoted}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`);
    }
  } catch {}
}

// --- database ---------------------------------------------------------------

/**
 * Renders one value as a SQL literal.
 *
 * Doubling the single quote is the whole of the escaping SQLite needs: unlike
 * MySQL it gives no special meaning to a backslash inside a string literal, so
 * there is no second escape to get wrong.
 */
function literal(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function render(query, params = []) {
  // Values are substituted into the statement rather than bound. Both routes take
  // the statement as text, so doing it once here keeps them interchangeable.
  //
  // One pass over the query as written, with a replacement function. It used to
  // be one replaceAll per parameter, highest first, which went wrong two ways
  // with values that are quite ordinary in a Sheet: a value quoting a lower
  // numbered placeholder was itself rewritten by the next pass, and a string
  // replacement gives $& and its relatives a meaning, so a value holding one
  // spliced pieces of the query into itself. The regex is greedy on digits,
  // which is also what stops :p10 being read as :p1.
  //
  // The highest placeholder must be the last value, no more and no fewer. A
  // placeholder with no value used to be left in the text, where SQLite reads
  // it as an unbound parameter and quietly makes it NULL; a spare value usually
  // means a condition dropped its placeholder and kept its argument. Both are
  // bugs at the call site, so both throw. db.js sqlP holds the same rule.
  let highest = 0;
  const statement = String(query).replace(/:p(\d+)/g, (match, n) => {
    const index = Number(n);
    if (index < 1 || index > params.length) {
      throw new Error(`sql(): ${match} has no value (${params.length} given)`);
    }
    if (index > highest) highest = index;
    return literal(params[index - 1]);
  });
  if (highest !== params.length) {
    throw new Error(`sql(): ${params.length} values given for ${highest} placeholders`);
  }
  return statement;
}

function sql(query, params = []) {
  const statement = render(query, params);
  return DATABASE.query(statement.endsWith(";") ? statement : statement + ";");
}

/** [[query, params], ...] as one transaction, on either route. For the shared stores. */
function batch(statements) {
  if (!statements.length) return;
  DATABASE.batch(statements.map(([query, params]) => render(query, params || [])));
}

/**
 * Turns whatever a caller said about a project into an id, or null for all of them.
 *
 * A key is accepted as well as an id because list_projects hands back both, and
 * an agent that has been told which project it works on has been told the key.
 * An unknown key is an error rather than a quiet fall back to no filter: silently
 * widening the scope would hand an agent another project's work, which is the
 * one mistake a project filter exists to prevent.
 *
 * An id is checked the same way, and used not to. It went through untouched, so
 * a wrong or stale number narrowed the filter to nothing instead of widening it,
 * and the failure was silent in the other direction: queue_runner reads a
 * bare-digits --project as an id, so a runner started with the wrong one polled
 * forever saying "Nothing waiting in the ready queue" while the work sat there.
 * A non-numeric one was worse still, because literal() renders NaN as NULL and
 * "project_id = NULL" is never true, so the filter matched nothing and the
 * message said "for project NaN".
 */
function resolveProjectId(a) {
  if (a.project_id !== undefined && a.project_id !== null) {
    const id = Number(a.project_id);
    if (!Number.isInteger(id)) {
      throw new Error(`project_id must be a whole number, got '${a.project_id}'. Call list_projects to see them.`);
    }
    const row = sql("SELECT id FROM projects WHERE id = :p1", [id])[0];
    if (!row) throw new Error(`No project with the id ${id}. Call list_projects to see them.`);
    return row.id;
  }
  if (!a.project) return null;
  const row = sql("SELECT id FROM projects WHERE key = :p1", [String(a.project)])[0];
  if (!row) throw new Error(`No project with the key '${a.project}'. Call list_projects to see them.`);
  return row.id;
}

// The pad grammar, shared with the app rather than copied.
//
// Everything else in this file that touches a row is a deliberate twin of db.js,
// because requiring db.js would drag in node:sqlite. pads.js has no dependencies
// at all: it is pure text in, text out. Two copies of a grammar this fiddly would
// disagree within a month, and the disagreement would show up as duplicated tasks
// in somebody's board rather than as an error anyone could read.
//
// Shipped beside this file by electron-builder's extraResources, for the same
// reason the server itself is: a plain Node process cannot read inside app.asar.
const pads = require("../pads");

// The Sheet's rows. Shared with the app rather than twinned: the store is SQL
// text and rules and is handed this file's sql(), so it works on either route
// and the two sides cannot disagree about what a valid entry is. See the head
// of sheet/store.js.
const { makeSheetStore, pidAlive } = require("../sheet/store");
const sheetFormat = require("../sheet/format");
const AUTHOR_TYPE = ["human", "agent", "tool"].includes(process.env.DELPHI_AUTHOR_TYPE)
  ? process.env.DELPHI_AUTHOR_TYPE : null;
// Who this process writes as, and the step each tool call's rows share. See
// agent/audit.js. The step lives in AsyncLocalStorage rather than a variable,
// because an async tool (second_opinion, a Workbench's setup) can still be
// running when the next call arrives, and two calls must not trade step ids.
const auditLib = require("./audit");
const { AsyncLocalStorage } = require("async_hooks");
const STEP = new AsyncLocalStorage();
const WHO = auditLib.identity(process.env, { inferType: sheetFormat.inferAuthorType });
// A job writes for the session that asked for it, when one did.
if (WHO.session_id == null && WHO.job_id != null) WHO.session_id = auditLib.sessionOfJob(sql, WHO.job_id);
const currentStep = () => STEP.getStore() || null;
const auditor = auditLib.makeAuditor({ sql, batch, who: WHO, step: currentStep });
const sheets = makeSheetStore({ sql, batch, actor: ACTOR, authorType: AUTHOR_TYPE, who: WHO, step: currentStep });
// Run logs live in the data folder, DATA_DIR in the app's terms, so they
// inherit its "never in git" rule.
const SHEET_LOG_DIR = path.join(RESOLVED.dataDir, "sheets");

// Workbenches, from the same modules the app uses, for the same reason the
// Sheet store is shared. Setup commands run through sheet/run.js so they are
// guarded and recorded like any other `$ ` entry.
const { makeWorkbenchStore } = require("../workbench/store");
const { createWorkbench } = require("../workbench/workbench");
const { runEntry } = require("../sheet/run");
const benchStore = makeWorkbenchStore({ sql, actor: ACTOR, who: WHO, step: currentStep });
const benches = createWorkbench({
  store: benchStore, sheet: sheets, runEntry, logDir: SHEET_LOG_DIR,
  settings: () => readSettings(),
});

// Cross-project items and flags, from the store the app uses. Its moves are
// batches, which on the sqlite3 route are one script in one process, so a
// task never lands in one project with its subtasks in another. The author
// type falls back to what the name looks like, so an agent whose launcher did
// not say what it is cannot approve a proposal by leaving the type out.
const { makeItemStore, inProject } = require("../items/store");
const ITEM_AUTHOR_TYPE = AUTHOR_TYPE || sheetFormat.inferAuthorType(ACTOR);
const itemStore = makeItemStore({
  sql, batch, actor: ACTOR, authorType: ITEM_AUTHOR_TYPE, settings: () => readSettings(),
  derive: (padId) => derivePad(padId), who: WHO, step: currentStep,
});

// When sheet_read last swept a task for lost runs. See sheet_read.
const SWEEP_EVERY_MS = 30000;
const swept = new Map();

/** A task's live Workbench, or a sentence saying it has none. */
function benchFor(taskId) {
  const wb = benchStore.live(taskId);
  if (!wb) throw new Error(`Task ${taskId} has no Workbench. Start one with workbench_start.`);
  return wb;
}

/**
 * What an agent is told when it closes a task that still has a Workbench. The
 * update goes through; the folder and the branch are a person's to Finish,
 * because Finish is where someone looks at the work before it is put away, and
 * an agent finishing its own work as a side effect skips exactly that.
 */
function workbenchNotice(taskId) {
  const wb = benchStore.live(taskId);
  if (!wb || wb.state === "missing" || !fs.existsSync(wb.path)) return null;
  return {
    id: wb.id, path: wb.path, branch: wb.branch, state: wb.state,
    note: `This task still has a live Workbench at ${wb.path}. A person will Finish it; do not remove the folder or the branch yourself.`,
  };
}

/**
 * get_task without the parts that repeat or rarely matter, so reading a task
 * before working on it stays near a few hundred tokens. The Sheet's entries
 * were sent twice, as JSON and as text; the text is kept, with the ids beside
 * it for sheet_promote and the rest. Empty columns go, a long detail or Sheet is
 * clipped with a word saying so, and only the latest statuses are listed.
 */
const TASK_TITLE_CHARS = 300;
const TASK_DETAIL_CHARS = 2000;
const TASK_SHEET_CHARS = 3000;
const TASK_ENTRY_CHARS = 200;
const TASK_HISTORY_SHOWN = 4;
// The newest of the ledger, then the recent tail. A ledger is meant to be
// short, but nothing stops an agent promoting everything, and a task with
// thousands of promoted entries returned all of them.
const TASK_LEDGER_SHOWN = 8;
const TASK_TAIL_SHOWN = 6;
const TASK_LIST_SHOWN = 50;
const TASK_BUDGET = 1500;
function taskBrief(task) {
  const id = Number(task.id);
  const row = {};
  for (const [k, v] of Object.entries(task)) if (v !== null && v !== "" && k !== "colour") row[k] = v;
  const clipped = [];
  if (row.title && String(row.title).length > TASK_TITLE_CHARS) {
    row.title = String(row.title).slice(0, TASK_TITLE_CHARS) + "…";
    clipped.push("title");
  }
  if (row.detail && String(row.detail).length > TASK_DETAIL_CHARS) {
    row.detail = String(row.detail).slice(0, TASK_DETAIL_CHARS) + "…";
    clipped.push("detail");
  }

  const context = sheets.context(id);
  let entries = context.entries;
  let text = context.text;
  let ledgerMore = 0;
  if (text.length > TASK_SHEET_CHARS) {
    // The newest of the ledger and of the tail, bodies clipped.
    const ledger = entries.filter((e) => e.promoted || e.kind === "decide" || e.kind === "ask");
    const tail = entries.filter((e) => !ledger.includes(e)).slice(-TASK_TAIL_SHOWN);
    ledgerMore = Math.max(0, ledger.length - TASK_LEDGER_SHOWN);
    const short = (e) => ({ ...e, body: String(e.body || "").length > TASK_ENTRY_CHARS ? String(e.body).slice(0, TASK_ENTRY_CHARS) + "…" : e.body });
    entries = [...ledger.slice(-TASK_LEDGER_SHOWN), ...tail].sort((x, y) => x.id - y.id).map(short);
    text = sheetFormat.format({ header: { ...sheets.header(id), title: row.title }, entries }, { clean: true });
    clipped.push("sheet");
  }
  const ids = entries.map((e) => e.id);
  const subtasks = sql("SELECT id, title, status FROM tasks WHERE parent_id = :p1 ORDER BY id", [id]);

  const history = sql("SELECT status, actor, at FROM status_events WHERE task_id = :p1 ORDER BY at, id", [id]);
  // Whatever the caps above miss (a title of thousands of characters, say),
  // the budget catches: fit trims the longest field or list until it fits.
  return recallFit({
    task: row,
    project: task.project_id ? sql("SELECT id, key, name FROM projects WHERE id = :p1", [task.project_id])[0] : null,
    subtasks: subtasks.slice(0, TASK_LIST_SHOWN),
    ...(subtasks.length > TASK_LIST_SHOWN ? { subtasks_total: subtasks.length } : {}),
    sheet: text,
    ...(ledgerMore ? { ledger_more: `${ledgerMore} older ledger entries are not shown; sheet_read mode ledger has them.` } : {}),
    entry_ids: ids.slice(-TASK_LIST_SHOWN),
    ...(ids.length > TASK_LIST_SHOWN ? { entry_ids_total: ids.length } : {}),
    comments_total: context.total,
    comments_shown: entries.length,
    history: history.slice(-TASK_HISTORY_SHOWN),
    ...(history.length > TASK_HISTORY_SHOWN ? { history_total: history.length } : {}),
    ...(clipped.length ? { clipped, more: "get_task with detail \"full\", or sheet_read mode full, for the rest." } : {}),
  }, TASK_BUDGET, ["subtasks", "history"]);
}
const recallFit = (...args) => require("./recall").fit(...args);

/** What an agent is shown of a task's Sheet: the ledger plus the recent tail. */
function sheetContext(taskId) {
  const context = sheets.context(taskId);
  return {
    // The three fields comments always had are kept, so a client written
    // against the old shape (queue_runner's brief, for one) still reads it.
    comments: context.entries.map((e) => ({
      id: e.id, kind: e.kind, author: e.author, author_type: e.author_type,
      body: e.body, promoted: e.promoted, created_at: e.created_at,
    })),
    sheet: context.text,
    comments_total: context.total,
    comments_shown: context.shown,
  };
}

/**
 * The folder a command for this task should run in, and where that came from.
 *
 * The task's Workbench first, because that is where its work is and running
 * a command anywhere else is how one task's build ends up in another's folder.
 * Then the primary repo, then the project's primary workspace folder, then the
 * project's own folder. repos is empty in most real databases, which is why the
 * other two count.
 */
function resolveTaskFolder(task) {
  const exists = (p) => { try { return Boolean(p) && fs.statSync(p).isDirectory(); } catch { return false; } };
  const bench = benchStore.live(task.id);
  if (bench && bench.state !== "missing" && exists(bench.path)) return { cwd: bench.path, cwd_source: "workbench" };
  if (task.project_id == null) return { cwd: null, cwd_source: null };
  const repos = sql("SELECT path FROM repos WHERE project_id = :p1 ORDER BY is_primary DESC, id", [task.project_id]);
  for (const r of repos) if (exists(r.path)) return { cwd: r.path, cwd_source: "repo" };
  const spaces = sql(
    `SELECT w.path FROM project_workspaces pw JOIN workspaces w ON w.id = pw.workspace_id
      WHERE pw.project_id = :p1 ORDER BY pw.is_primary DESC, w.sort_order, w.id`, [task.project_id]);
  for (const w of spaces) if (exists(w.path)) return { cwd: w.path, cwd_source: "folder" };
  const project = sql("SELECT path FROM projects WHERE id = :p1", [task.project_id])[0];
  if (project && exists(project.path)) return { cwd: project.path, cwd_source: "folder" };
  return { cwd: null, cwd_source: null };
}

const PROMOTE_DIRECTIVE =
  "Promote (promote: true) anything that changes what the next agent should do: a finding, a dead end, a decision. " +
  "If it would matter on a different task too, call sheet_file on it as well, so it becomes a project note the graph and search can find.";

// --- scratchpads -------------------------------------------------------------
//
// The row half of the pad tools. Twins of db.js the same way add_project is, and
// for the same reason: node:sqlite is not available here. The grammar is not
// duplicated, only the writes.

/** A pad by id, or by project and key, which is how an agent addresses one. */
function findPad(a, { shown = false } = {}) {
  if (a.id != null) return sql("SELECT * FROM scratchpads WHERE id = :p1", [Number(a.id)])[0] || null;
  if (!a.key) throw new Error("Pass either id, or project_id and key.");
  const projectId = resolveProjectId(a);
  if (projectId == null) throw new Error("Pass either id, or project_id and key.");
  const own = sql("SELECT * FROM scratchpads WHERE project_id = :p1 AND key = :p2",
                  [projectId, String(a.key)])[0] || null;
  if (own || !shown) return own;
  // For reading only: a pad shown here from another project, when exactly one
  // has the key. A write by key stays home only, so it never lands in a
  // project the agent did not name.
  const others = sql(`SELECT s.* FROM scratchpads s JOIN item_projects ip ON ip.entity = 'scratchpad' AND ip.entity_id = s.id
                       WHERE ip.project_id = :p1 AND s.key = :p2`, [projectId, String(a.key)]);
  return others.length === 1 ? others[0] : null;
}

/**
 * The slug a pad is addressed by.
 *
 * Not made unique by appending a number, unlike db.js. Here a repeated key means
 * an agent writing to the pad it wrote last time, which is the intended use, and
 * silently giving it "plan-2" would leave it appending to a document nobody else
 * reads.
 */
function padKeyFor(projectId, source) {
  const key = String(source).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!key) throw new Error("key must contain at least one alphanumeric character");
  return key;
}

/** Twin of db.js patchScratchpad. Replaces a section, or adds it if it is new. */
function patchSection(body, heading, text) {
  const lines = String(body || "").split("\n");
  const wanted = String(heading).trim().toLowerCase().replace(/^#+\s*/, "");
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (m && m[2].trim().toLowerCase() === wanted) { start = i; level = m[1].length; break; }
  }
  if (start === -1) {
    const joiner = !body || body.endsWith("\n") ? "" : "\n";
    return `${body}${joiner}\n## ${heading}\n\n${text}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return [...lines.slice(0, start + 1), "", text, "", ...lines.slice(end)].join("\n");
}

/**
 * Reads a pad's checkbox lines into tasks. Twin of db.js deriveInPlace.
 *
 * Returns what the caller should report back: the pad, and the tasks it now
 * owns. An agent that has just written a plan wants to know which task ids it
 * got, because those are what it will claim and close later.
 */
function derivePad(padId) {
  const pad = sql("SELECT * FROM scratchpads WHERE id = :p1", [padId])[0];
  if (!pad) throw new Error("No such scratchpad");
  if (!pad.derives_tasks) return { ...pad, tasks: [] };

  let body = pad.body;
  let entries = pads.parse(body);
  const idByEntry = new Map();
  const filed = [];
  const stepId = auditor.step();

  for (const entry of entries.slice()) {
    // Re-read each pass, because anchoring a line shifts nothing but rewrites it,
    // and the entry we are holding was parsed from the text before that.
    const current = pads.parse(body)[entry.at];
    if (!current) continue;
    const parentId = current.parentIndex != null ? idByEntry.get(current.parentIndex) ?? null : null;

    let task = current.taskId
      ? sql("SELECT * FROM tasks WHERE id = :p1", [current.taskId])[0]
      : null;
    if (task && task.pad_id !== pad.id) task = null;

    if (!task) {
      // An anchorless line that exactly matches a task this pad owns, and that no
      // other line currently claims, is that task with its marker rewritten away.
      // See pads.js: exact match only, because a wrong merge is harder to spot
      // than a duplicate.
      const claimed = [...pads.anchoredIds(body)];
      const rows = sql(
        `SELECT * FROM tasks WHERE pad_id = :p1 AND title = :p2
         ${claimed.length ? `AND id NOT IN (${claimed.join(", ")})` : ""} ORDER BY id`,
        [pad.id, current.title]
      );
      task = rows[0] || null;
    }

    if (task) {
      // Values go through sql()'s placeholders, never spliced into the text
      // first. A title spliced in as a literal is still query text when sql()
      // runs, so a line that happened to mention a placeholder was rewritten.
      //
      // Every change is recorded with the row before and after, in one batch
      // with the write. Only status flips and creates used to be, so a title
      // or a parent the sync rewrote could not be undone or even seen.
      const sets = [];
      const values = [];
      const said = [];
      const set = (column, value) => { values.push(value); sets.push(`${column} = :p${values.length}`); };
      if (current.title && current.title !== task.title) { set("title", current.title); said.push("title changed"); }
      const status = pads.statusFor(current.done, task.status);
      if (status !== task.status) {
        set("status", status);
        sets.push(status === "done" ? "completed_at = datetime('now')" : "completed_at = NULL");
        said.push(`status ${task.status} to ${status}`);
      }
      if (current.assignee && current.assignee !== task.assignee) { set("assignee", current.assignee); said.push("assignee changed"); }
      if (current.priority && current.priority !== task.priority) { set("priority", current.priority); said.push("priority changed"); }
      if (parentId !== (task.parent_id ?? null)) { set("parent_id", parentId); said.push(parentId == null ? "taken out from under its parent" : "moved under another task"); }
      const anchorKey = `pad:${pad.id}:${task.id}`;
      if (task.external_key !== anchorKey) set("external_key", anchorKey);
      if (sets.length) {
        values.push(task.id);
        const writes = [[`UPDATE tasks SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = :p${values.length}`, values]];
        if (status !== task.status) {
          writes.push(["INSERT INTO status_events (task_id, status, actor) VALUES (:p1, :p2, :p3)", [task.id, status, ACTOR]]);
        }
        auditor.run(auditor.update("task", task.id, { summary: said.length ? said.join(", ") : "anchored to its pad line",
                                                      label: current.title || task.title, stepId }, writes));
      }
    } else {
      // RETURNING rather than a second SELECT on last_insert_rowid(). On the
      // sqlite3 binary route every sql() call is its own process, and a new
      // connection's last_insert_rowid() is always 0, so every pad task filed
      // that way came back as undefined.
      // One batch for the task, its anchor key, its opening status and its
      // History row, with the id taken inside it (agent/audit.js create). The
      // key goes in before the row is recorded, so the recorded after is the
      // task as the sync left it.
      const title = current.title || "Untitled";
      auditor.run(auditor.create("task", { summary: "read out of a pad", label: title, stepId },
        [`INSERT INTO tasks (project_id, title, status, priority, assignee, parent_id, pad_id, source, completed_at)
          VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7, 'pad',
                  CASE WHEN :p3 = 'done' THEN datetime('now') END)`,
         [pad.project_id, title, current.done ? "done" : "todo",
          current.priority || "med", current.assignee || null, parentId, pad.id]],
        [[`INSERT INTO status_events (task_id, status, actor) SELECT id, status, :p1 FROM tasks WHERE id = ${auditor.createdId("task", stepId)}`, [ACTOR]]],
        [["UPDATE tasks SET external_key = 'pad:' || pad_id || ':' || id WHERE id = last_insert_rowid()", []]]));
      task = sql("SELECT * FROM tasks WHERE id = :p1", [auditor.created("task", stepId)])[0];
    }

    idByEntry.set(current.at, task.id);
    filed.push({ id: task.id, title: current.title, status: pads.statusFor(current.done, task.status) });

    if (current.taskId !== task.id) body = pads.anchorLine(body, current, task.id);
  }

  // The anchors are part of the write that made them: the step's own row for
  // the pad is given the body with them in, or undo would read the pad as
  // edited since by the time anyone pressed it.
  if (body !== pad.body) {
    auditor.run(auditor.refreshAfter("scratchpad", pad.id, { summary: "anchored its lines to their tasks", label: pad.title, stepId },
      [["UPDATE scratchpads SET body = :p1 WHERE id = :p2", [body, pad.id]]]));
  }
  return { ...sql("SELECT * FROM scratchpads WHERE id = :p1", [pad.id])[0], tasks: filed };
}

// --- tools ------------------------------------------------------------------

/** Whether a Delphi app is running against this database: true, false or "unknown". See agent/identity.js. */
const appState = () => identity.appState(RESOLVED, { isAlive: pidAlive });

/**
 * The project this server was scoped to by whatever launched it, or null.
 *
 * Looked up rather than trusted, and never thrown over: whoami is the call an
 * agent makes when it is unsure of its footing, and it has to answer.
 */
function projectScope() {
  const raw = process.env.DELPHI_PROJECT;
  if (!raw) return null;
  try {
    const row = /^\d+$/.test(raw)
      ? sql("SELECT id, key, name FROM projects WHERE id = :p1", [Number(raw)])[0]
      : sql("SELECT id, key, name FROM projects WHERE key = :p1", [raw])[0];
    return row || { id: null, key: null, name: null, unknown: raw };
  } catch {
    return { id: null, key: null, name: null, unknown: raw };
  }
}

const isDirectory = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const holds = (root, p) => {
  const a = (() => { try { return fs.realpathSync(root); } catch { return null; } })();
  const b = (() => { try { return fs.realpathSync(p); } catch { return null; } })();
  if (!a || !b) return false;
  const rel = path.relative(a, b);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * Which task and project a second opinion is about, the folders it may read,
 * and where it runs.
 *
 * The folders are the project's own (repositories, workspaces, its path) and the
 * task's live Workbench, and nothing else: the reviewer is let into every folder
 * here, and an agent that could name any folder could hand it a home directory.
 * With no project named, the session's own scope is used, then the project
 * whose folder holds cwd.
 */
function secondOpinionScope(a) {
  let task = null;
  if (a.task_id != null) {
    task = sql("SELECT id, title, project_id FROM tasks WHERE id = :p1", [a.task_id])[0];
    if (!task) throw new Error(`No task ${a.task_id}`);
  }
  let projectId = resolveProjectId(a);
  if (projectId != null && task && Number(task.project_id) !== Number(projectId)) {
    throw new Error(`Task ${task.id} is not in the project you named (it is in project ${task.project_id}). Pass the task alone, or the project it belongs to.`);
  }
  if (projectId == null && task) projectId = task.project_id;
  if (projectId == null) {
    const scope = projectScope();
    if (scope && scope.id) projectId = scope.id;
  }
  const benches = (where, params) => sql(`SELECT w.path, w.task_id, t.project_id FROM workbenches w JOIN tasks t ON t.id = w.task_id
                                           WHERE w.state IN ('active', 'parked') ${where} ORDER BY w.id DESC`, params);
  // A Workbench cwd belongs to a task; without one named, it is the folder that
  // says which, and it is let in as that task's.
  let inferredBench = null;
  if (projectId == null) {
    const here = a.cwd || process.cwd();
    const bench = benches("", []).find((b) => holds(b.path, here));
    if (bench) { projectId = bench.project_id; inferredBench = bench.path; }
    else {
      const found = sql("SELECT id FROM projects ORDER BY id", []).find((p) => jobs.folders(sql, p.id).some((f) => holds(f, here)));
      if (found) projectId = found.id;
    }
  }
  if (projectId == null) {
    throw new Error("A second opinion reads only inside a project's folders or a task's Workbench, and none was given. Pass project or task_id, or a cwd inside a project's folder.");
  }
  const own = task ? benches("AND w.task_id = :p1", [task.id]).map((b) => b.path) : (inferredBench ? [inferredBench] : []);
  const roots = [...own, ...jobs.folders(sql, projectId)];
  const cwd = a.cwd || own.find(isDirectory) || jobs.readFolder(sql, projectId);
  if (!cwd) throw new Error(jobs.folderProblem(sql, projectId) || "The project has no folder for a second opinion to read.");
  return { task, projectId: Number(projectId), roots, cwd };
}

/**
 * A say entry and its History row, as statements for a batch. The queue's
 * release and complete write theirs beside the task's own change, so the entry
 * can be undone on its own and the change without it.
 */
function sheetEntry(task, summary, body, { promoted = false, stepId = null } = {}) {
  return auditor.sheetAppend(task, { summary, stepId }, [
    `INSERT INTO comments (task_id, author, body, kind, author_type, promoted, session_id)
     VALUES (:p1, :p2, :p3, 'say', :p4, :p5, :p6)`,
    [task.id, ACTOR, body, AUTHOR_TYPE, promoted ? 1 : 0, WHO.session_id],
  ]);
}

/** A plain comment on a task, as add_comment and second_opinion both write it. */
function addComment(taskId, body) {
  const task = sql("SELECT id, title FROM tasks WHERE id = :p1", [taskId])[0];
  if (!task) throw new Error(`No task ${taskId}`);
  if (!body || !String(body).trim()) throw new Error("A comment needs something in it");
  const stepId = auditor.step();
  auditor.run(sheetEntry(task, "commented", String(body).trim(), { stepId }));
  return sql("SELECT * FROM comments WHERE id = :p1", [auditor.appendedId(task.id, stepId)])[0];
}

const TOOLS = {
  whoami: {
    description:
      "Your database, who your writes are attributed to, and whether a Delphi app is running to dispatch handoffs (app_running: true, false or \"unknown\"). Call it when unsure your work lands where the person sees it.",
    schema: { type: "object", properties: {} },
    run: () => {
      const app = appState();
      return {
        db_path: DB,
        db_id: IDENTITY.db_id,
        db_created_at: IDENTITY.created_at,
        data_dir: RESOLVED.dataDir,
        resolved_by: RESOLVED.source,
        actor: ACTOR,
        author_type: AUTHOR_TYPE || "agent",
        session_id: WHO.session_id,
        ...(WHO.job_id ? { job_id: WHO.job_id } : {}),
        project_scope: projectScope(),
        app_running: app.running,
        app,
        checkout_db_ignored: RESOLVED.checkoutDbIgnored,
        sqlite_route: DATABASE.kind,
      };
    },
  },

  list_projects: {
    description:
      "List projects with open task counts. Call this first to find the right project_id.",
    schema: { type: "object", properties: {} },
    run: () =>
      sql(`SELECT p.id, p.key, p.name, p.summary, p.status,
                  (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status != 'done') AS open_tasks,
                  (SELECT COUNT(*) FROM notes n WHERE n.project_id = p.id) AS notes
           FROM projects p WHERE p.status != 'archived' ORDER BY p.sort_order`),
  },

  add_project: {
    description:
      "Create a project for work no existing one fits (check list_projects first), rather than filing it under General.",
    schema: {
      type: "object",
      required: ["key", "name"],
      properties: {
        key: { type: "string", description: "Slug, e.g. co-hearing-address" },
        name: { type: "string" },
        summary: { type: "string", description: "One line" },
        colour: { type: "string", description: "e.g. #4A90D9" },
      },
    },
    run: (a) => {
      // Twin of db.js createProject. These rules, the slug, the clash check and
      // the sort_order below, exist in both files and have to be changed in both.
      // Requiring db.js is not an option here for the same reason paths.js is
      // duplicated above: it ends up inside app.asar, and the Node an editor
      // launched this with may have no node:sqlite either way.
      //
      // The slug is the one column with a uniqueness constraint, so it is
      // normalised here rather than trusting the caller to pass a clean one.
      const key = String(a.key).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (!key) throw new Error("key must contain at least one alphanumeric character");

      const clash = sql("SELECT id, key, name FROM projects WHERE key = :p1", [key])[0];
      if (clash) throw new Error(`Project ${clash.id} already uses key '${key}' (${clash.name})`);

      // Sit above General, which is pinned at 99 as the catch-all. New projects
      // slot in behind the last real one so the sidebar keeps its order.
      const below = sql("SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM projects WHERE sort_order < 99")[0];
      auditor.run(auditor.create("project", { summary: "created", label: a.name },
        [`INSERT INTO projects (key, name, summary, colour, sort_order)
          VALUES (:p1, :p2, :p3, :p4, :p5)`,
         [key, a.name, a.summary ?? null, a.colour ?? null, below.next]]));
      return sql("SELECT id, key, name, summary, status, sort_order FROM projects WHERE key = :p1", [key])[0];
    },
  },

  list_tasks: {
    description:
      "List tasks. Omit project_id for every project. Done tasks are excluded unless include_done is true.",
    schema: {
      type: "object",
      properties: {
        project_id: { type: "number" },
        include_done: { type: "boolean" },
        status: { type: "string", enum: ["todo", "doing", "blocked", "done"] },
      },
    },
    run: (a) => {
      const where = [];
      const params = [];
      // Home or shown here from another project; a row from elsewhere says
      // its home, so an agent knows where it really lives.
      if (a.project_id != null) { params.push(resolveProjectId(a)); where.push(inProject("task", "t", `:p${params.length}`)); }
      if (a.status) { params.push(a.status); where.push(`t.status = :p${params.length}`); }
      else if (!a.include_done) where.push("t.status != 'done'");
      const asked = a.project_id != null ? Number(params[0]) : null;
      return sql(
        `SELECT t.id, t.title, t.detail, t.status, t.priority, t.due, t.ref, p.name AS project,
                ${asked != null ? `CASE WHEN t.project_id IS ${asked} THEN NULL ELSE p.key END` : "NULL"} AS home
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY CASE t.status WHEN 'doing' THEN 0 WHEN 'blocked' THEN 2 WHEN 'todo' THEN 3 WHEN 'done' THEN 4 ELSE 1 END,
                  CASE t.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, t.id DESC
         LIMIT 200`,
        params
      ).map(({ home, ...row }) => (home ? { ...row, home } : row));
    },
  },

  add_task: {
    description:
      "Create a task for work that will not be finished now, without waiting to be asked.",
    schema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        project_id: { type: "number" },
        detail: { type: "string", description: "Why it matters, how to verify" },
        priority: { type: "string", enum: ["high", "med", "low"] },
        due: { type: "string", description: "YYYY-MM-DD" },
        ref: { type: "string", description: "Ticket or PR" },
        parent_id: { type: "number", description: "Makes it a subtask" },
      },
    },
    run: (a) => {
      // A subtask lives in its parent's project whatever was passed, because a
      // subtask filed somewhere else is not a subtask.
      let projectId = a.project_id ?? null;
      if (a.parent_id) {
        const parent = sql("SELECT project_id FROM tasks WHERE id = :p1", [a.parent_id])[0];
        if (!parent) throw new Error(`No task ${a.parent_id} to hang this from`);
        projectId = parent.project_id;
      }
      // RETURNING, not "the newest row": with two agents filing at once the
      // newest row can be the other agent's.
      //
      // The task, its opening status and its History row are one batch, with
      // the id read back from this call's own row, which no other agent's
      // write can be.
      const stepId = auditor.step();
      auditor.run(auditor.create("task", { summary: "created", label: a.title, stepId },
        [`INSERT INTO tasks (project_id, title, detail, priority, due, ref, parent_id, source)
          VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7, :p8)`,
         [projectId, a.title, a.detail ?? null, a.priority || "med", a.due ?? null, a.ref ?? null, a.parent_id ?? null, ACTOR]],
        [[`INSERT INTO status_events (task_id, status, actor) VALUES (${auditor.createdId("task", stepId)}, 'todo', :p1)`, [ACTOR]]]));
      return sql("SELECT id, title FROM tasks WHERE id = :p1", [auditor.created("task", stepId)])[0];
    },
  },

  update_task: {
    description:
      "Change a task. Set status to done when work is finished, blocked when waiting on someone.",
    schema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "number" },
        title: { type: "string" },
        detail: { type: "string" },
        status: { type: "string", enum: ["todo", "doing", "blocked", "done"] },
        priority: { type: "string", enum: ["high", "med", "low"] },
        due: { type: "string" },
        project_id: { type: "number", description: "Moves it, subtasks too: only a task you filed in the last day, else flag_item" },
        assignee: { type: "string", description: "Who holds it; your actor name to take it" },
      },
    },
    run: (a) => {
      let before = sql("SELECT * FROM tasks WHERE id = :p1", [a.id])[0];
      if (!before) throw new Error(`No task ${a.id}`);
      // A change of project is a move (owner decision D2). An agent may move a
      // task it filed itself in the last day, which is fixing its own
      // misfiling, the common case; anything else is a person's call, so it is
      // refused with the tool that asks for one. The move goes through the
      // shared store, so the subtasks follow and the epic it left is cleared:
      // setting the column here used to leave the task filed under an epic in
      // the project it had left.
      if (a.project_id !== undefined && a.project_id !== null && Number(a.project_id) !== Number(before.project_id)) {
        // Only for a named writer: with no DELPHI_ACTOR every agent is
        // "agent", and "you filed it" would let one move another's work.
        const named = Boolean(process.env.DELPHI_ACTOR) && ACTOR !== "agent";
        // The actor column says who filed it; the suffix is all a row from
        // before that column has, so it is the fallback.
        const suffix = `(by ${ACTOR})`;
        const mine = named && sql(`SELECT id FROM audit WHERE action = 'create' AND entity = 'task' AND entity_id = :p1
                            AND (actor = :p2 OR (actor IS NULL AND substr(summary, -length(:p3)) = :p3))
                            AND at >= datetime('now', '-24 hours') LIMIT 1`,
                         [before.id, ACTOR, suffix])[0];
        if (!mine) {
          throw new Error(`Task ${before.id} was not filed by you in the last 24 hours, so moving it is a person's call. ` +
            `Flag it instead: flag_item with entity "task", id ${before.id}, and a note saying where it belongs and why.`);
        }
        itemStore.move("task", before.id, Number(a.project_id));
        before = sql("SELECT * FROM tasks WHERE id = :p1", [a.id])[0];
      }
      const fields = ["title", "detail", "status", "priority", "due", "assignee"].filter((f) => a[f] !== undefined);
      if (!fields.length) return before;
      const params = fields.map((f) => a[f]);
      const sets = fields.map((f, i) => `${f} = :p${i + 1}`).join(", ");
      params.push(a.id);
      const done = a.status === "done" ? ", completed_at = datetime('now')" : a.status ? ", completed_at = NULL" : "";
      // The timeline should not be able to tell whether a person or an agent
      // moved a task, only who it was. Recorded here for the same reason the app
      // records it: so the history cannot disagree with the column. In the same
      // batch as the write and its History row, compared in SQL against the
      // status the row had when the batch began.
      auditor.run(auditor.update("task", a.id, { summary: a.status ? `status to ${a.status}` : "updated", label: a.title ?? before.title }, [
        [`UPDATE tasks SET ${sets}, updated_at = datetime('now')${done} WHERE id = :p${params.length}`, params],
        ["INSERT INTO status_events (task_id, status, actor) SELECT id, status, :p1 FROM tasks WHERE id = :p2 AND status IS NOT :p3",
         [ACTOR, a.id, before.status]],
      ]));
      const after = sql("SELECT * FROM tasks WHERE id = :p1", [a.id])[0];
      const notice = a.status === "done" ? workbenchNotice(a.id) : null;
      return notice ? { ...after, workbench: notice } : after;
    },
  },

  queue_next: {
    description:
      "Claim the next queued task with everything needed to do it, when you are ready to work. claimed null means the queue is empty: stop, do not invent work. Pass project_id or project if you can only work on one project (say you run in its checkout); otherwise you get the top of the whole pool.",
    schema: {
      type: "object",
      properties: {
        queue: { type: "string", description: "Pool, default ready" },
        minutes: { type: "number", description: "Claim length, default 30" },
        project_id: { type: "number", description: "Only this project" },
        project: { type: "string", description: "Same, by key" },
      },
    },
    run: (a) => {
      const queue = a.queue || "ready";
      const minutes = a.minutes || 30;
      const projectId = resolveProjectId(a);
      // One statement, because two with a gap between them is exactly where two
      // agents both win. An expired claim counts as unclaimed, so a task held by
      // an agent that died comes back on its own.
      //
      // This statement has a twin: db.js claimNext is the same claim for the
      // app. They cannot share code, because this file has to run under a plain
      // Node with no better-sqlite3 and cannot read inside app.asar, so any
      // change to how a task is chosen has to be made in both or the app and the
      // agents will disagree about what is claimable.
      //
      // Now one batch rather than one statement, so the History row records
      // the task before and after: the row is written first, choosing the task,
      // and the claim takes whichever task it chose. Both routes run a batch as
      // one write transaction, so two agents still cannot both win.
      //
      // Blocked work is not available work: something outside the task is
      // being waited on, and an agent given it can only hand it back. Values
      // are literals here because this text is spliced into several statements.
      // The statuses are named rather than excluded, so one a newer Delphi
      // wrote (In review) is never handed out by this one.
      const stepId = auditor.step();
      const chosen = `SELECT id FROM tasks
             WHERE queue = ${literal(queue)}
               AND status IN ('todo', 'doing')
               AND (claimed_by IS NULL OR claim_expires < datetime('now'))
               ${projectId == null ? "" : `AND project_id = ${literal(Number(projectId))}`}
             ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, id
             LIMIT 1`;
      const took = auditor.stepRowId("task", stepId);
      auditor.run(auditor.update("task", { sql: chosen }, { summary: `claimed by ${ACTOR}`, stepId }, [
        [`UPDATE tasks
            SET claimed_by = :p1,
                claim_expires = datetime('now', '+' || :p2 || ' minutes'),
                status = CASE WHEN status = 'todo' THEN 'doing' ELSE status END,
                updated_at = datetime('now')
          WHERE id = ${took}`, [ACTOR, minutes]],
        // Only when the claim moved it. Nothing but todo is claimable, so this
        // is always a real transition rather than a repeat of the current status.
        [`INSERT INTO status_events (task_id, status, actor) SELECT id, status, :p1 FROM tasks WHERE id = ${took} AND status = 'doing'`, [ACTOR]],
      ]));
      const claimedId = sql(`SELECT ${took} AS id`, [])[0];
      const claimed = claimedId && claimedId.id != null ? sql("SELECT * FROM tasks WHERE id = :p1", [claimedId.id])[0] : null;

      if (!claimed) {
        return {
          claimed: null,
          message: projectId == null
            ? `Nothing waiting in the ${queue} queue.`
            : `Nothing waiting in the ${queue} queue for project ${projectId}.`,
        };
      }


      return {
        claimed: claimed.id,
        expires: claimed.claim_expires,
        task: claimed,
        project: claimed.project_id
          ? sql("SELECT id, key, name FROM projects WHERE id = :p1", [claimed.project_id])[0]
          : null,
        subtasks: sql("SELECT id, title, status FROM tasks WHERE parent_id = :p1 ORDER BY id", [claimed.id]),
        ...sheetContext(claimed.id),
        next_steps:
          "Work it, comment what you did with add_comment, then queue_complete. " +
          "If you cannot finish it, queue_release with a reason so someone else can pick it up.",
      };
    },
  },

  queue_release: {
    description:
      "Give a claimed task back unfinished. Say why: the next agent reads it first, and an unexplained release is picked up and abandoned again.",
    schema: {
      type: "object",
      required: ["task_id", "reason"],
      properties: {
        task_id: { type: "number" },
        reason: { type: "string", description: "What stopped you, specifically." },
      },
    },
    run: (a) => {
      const before = sql("SELECT * FROM tasks WHERE id = :p1", [a.task_id])[0];
      if (!before) throw new Error(`No task ${a.task_id}`);
      // Promoted, because why the last agent gave up is the first thing the
      // next one needs, and the ledger is what it reads first.
      const stepId = auditor.step();
      auditor.run([
        ...auditor.update("task", a.task_id, { summary: `released by ${ACTOR}`, label: before.title, stepId }, [
          [`UPDATE tasks SET claimed_by = NULL, claim_expires = NULL,
               status = CASE WHEN status = 'doing' THEN 'todo' ELSE status END,
               updated_at = datetime('now') WHERE id = :p1`, [a.task_id]],
          ["INSERT INTO status_events (task_id, status, actor) SELECT id, status, :p1 FROM tasks WHERE id = :p2 AND status IS NOT :p3",
           [ACTOR, a.task_id, before.status]],
        ]),
        ...sheetEntry(before, "commented", `Released: ${a.reason}`, { promoted: true, stepId }),
      ]);
      return sql("SELECT * FROM tasks WHERE id = :p1", [a.task_id])[0];
    },
  },

  queue_extend: {
    description:
      "Extend your claim while you are still working. Do it before the lease lapses: after that the task may be someone else's.",
    schema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "number" },
        minutes: { type: "number", description: "Default another full lease" },
      },
    },
    run: (a) => {
      const minutes = a.minutes && a.minutes > 0 ? Math.round(a.minutes) : 30;
      const task = sql("SELECT * FROM tasks WHERE id = :p1", [a.task_id])[0];
      if (!task) throw new Error(`No task ${a.task_id}`);
      if (!task.claimed_by) throw new Error(`Task ${a.task_id} is not claimed`);
      // Whoever is holding it is the only one who may move its expiry, and an
      // expired claim is refused outright rather than quietly renewed, because
      // by then it may be someone else's and extending would take it from them.
      if (task.claimed_by !== ACTOR) throw new Error(`Task ${a.task_id} is held by ${task.claimed_by}`);
      const stale = sql("SELECT datetime('now') AS now")[0].now;
      if (task.claim_expires && task.claim_expires < stale) {
        throw new Error("That claim has already expired. Call queue_next again rather than extending it.");
      }
      const until = sql("SELECT datetime('now', '+' || :p1 || ' minutes') AS t", [minutes])[0].t;
      auditor.run(auditor.update("task", a.task_id, { summary: `claim extended by ${ACTOR} to ${until}`, label: task.title }, [
        [`UPDATE tasks SET claim_expires = :p2, updated_at = datetime('now') WHERE id = :p1`, [a.task_id, until]],
      ]));
      return sql("SELECT * FROM tasks WHERE id = :p1", [a.task_id])[0];
    },
  },

  queue_complete: {
    description:
      "Finish a claimed task. Your summary is promoted into the task's ledger automatically, the first thing the next agent reads: write it for them, not as a changelog. If something matters beyond this task, sheet_file it.",
    schema: {
      type: "object",
      required: ["task_id", "summary"],
      properties: {
        task_id: { type: "number" },
        summary: { type: "string", description: "What you did, and what the next person needs to know" },
      },
    },
    run: (a) => {
      const before = sql("SELECT * FROM tasks WHERE id = :p1", [a.task_id])[0];
      if (!before) throw new Error(`No task ${a.task_id}`);
      // Promoted, so every finished run lands in the ledger: it is the one
      // entry the next person or agent always wants.
      const stepId = auditor.step();
      auditor.run([
        ...sheetEntry(before, "commented", a.summary, { promoted: true, stepId }),
        ...auditor.update("task", a.task_id, { summary: "status to done", label: before.title, stepId }, [
          [`UPDATE tasks SET status = 'done', completed_at = datetime('now'),
               claimed_by = NULL, claim_expires = NULL, queue = NULL,
               updated_at = datetime('now') WHERE id = :p1`, [a.task_id]],
          ...(before.status !== "done"
            ? [["INSERT INTO status_events (task_id, status, actor) VALUES (:p1, 'done', :p2)", [a.task_id, ACTOR]]] : []),
        ]),
      ]);
      const after = sql("SELECT * FROM tasks WHERE id = :p1", [a.task_id])[0];
      const notice = workbenchNotice(a.task_id);
      return notice ? { ...after, workbench: notice } : after;
    },
  },

  queue_status: {
    description: "What is waiting in the queue and what other agents hold.",
    schema: {
      type: "object",
      properties: {
        queue: { type: "string" },
        project_id: { type: "number", description: "Only this project" },
        project: { type: "string", description: "Same, by key" },
      },
    },
    run: (a) => {
      const queue = a.queue || "ready";
      const projectId = resolveProjectId(a);
      const mine = projectId == null ? "" : "AND project_id = :p2";
      return {
        queue,
        project_id: projectId,
        // project_id comes back on every row, because a status read against the
        // whole pool is exactly where you need to know whose work it is.
        waiting: sql(
          `SELECT id, title, priority, project_id FROM tasks
            WHERE queue = :p1 AND status IN ('todo', 'doing')
              AND (claimed_by IS NULL OR claim_expires < datetime('now'))
              ${mine}
            ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, id`,
          projectId == null ? [queue] : [queue, projectId]
        ),
        in_flight: sql(
          `SELECT id, title, project_id, claimed_by, claim_expires FROM tasks
            WHERE queue = :p1 AND status != 'done'
              AND claimed_by IS NOT NULL AND claim_expires >= datetime('now')
              ${mine}
            ORDER BY claim_expires`,
          projectId == null ? [queue] : [queue, projectId]
        ),
      };
    },
  },

  get_task: {
    description:
      "One task: detail, subtasks, recent statuses, and its Sheet as text (the ledger of what was promoted, plus the last 20 entries). Read it before starting a task: the last agent probably left you something. detail full adds the entries as JSON; sheet_read has older ones.",
    schema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "number" },
        detail: { type: "string", enum: ["brief", "full"] },
      },
    },
    run: (a) => {
      const task = sql("SELECT * FROM tasks WHERE id = :p1", [a.id])[0];
      if (!task) throw new Error(`No task ${a.id}`);
      if (a.detail !== "full") return taskBrief(task);
      return {
        task,
        project: task.project_id
          ? sql("SELECT id, key, name FROM projects WHERE id = :p1", [task.project_id])[0]
          : null,
        subtasks: sql("SELECT id, title, status FROM tasks WHERE parent_id = :p1 ORDER BY id", [a.id]),
        ...sheetContext(a.id),
        history: sql("SELECT status, actor, at FROM status_events WHERE task_id = :p1 ORDER BY at, id", [a.id]),
      };
    },
  },

  add_comment: {
    description:
      "Comment on a task: what you found, tried and would do next, so the next agent does not start from nothing.",
    schema: {
      type: "object",
      required: ["task_id", "body"],
      properties: {
        task_id: { type: "number" },
        body: { type: "string", description: "Markdown. Be specific." },
      },
    },
    run: (a) => addComment(a.task_id, a.body),
  },

  // --- the Sheet ---------------------------------------------------------------
  //
  // A task's Sheet is its comments, each with a kind. These tools never take an
  // author: every entry is DELPHI_ACTOR's, so History cannot be told otherwise.

  sheet_read: {
    description:
      "A task's Sheet entries, as JSON and text. mode: tail (default, the last n), ledger (only what was promoted), full. To poll, pass the cursor back as after_id and since, and dedupe by id.",
    schema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "number" },
        mode: { type: "string", enum: ["ledger", "tail", "full"] },
        n: { type: "number", description: "Tail size, default 20, max 500" },
        after_id: { type: "number", description: "Entries after this id, or changed since `since`" },
        since: { type: "string", description: "Cursor time, inclusive" },
      },
    },
    run: (a) => {
      const mode = a.mode || "tail";
      // A run whose runner died is finished as fail:lost before anyone reads
      // it as still going. Every plain read sweeps; a cursor poll at most
      // every SWEEP_EVERY_MS per task, because a terminal polls twice a
      // second and on the sqlite3 route every query is a process.
      const key = String(a.task_id);
      const polling = a.after_id != null && Boolean(a.since);
      if (!polling || Date.now() - (swept.get(key) || 0) >= SWEEP_EVERY_MS) {
        swept.set(key, Date.now());
        try { sheets.sweepLost({ taskId: a.task_id, host: os.hostname(), isAlive: pidAlive }); } catch {}
      }
      // A poll that finds nothing new costs one query (sheets.quietRead).
      const quiet = a.after_id != null && a.since ? sheets.quietRead(a.task_id, { afterId: a.after_id, since: a.since }) : null;
      if (quiet) {
        return {
          task: { id: quiet.header.task, title: quiet.header.title, status: quiet.header.status, project: quiet.header.project },
          mode, entries: [], text: sheetFormat.format({ header: quiet.header, entries: [] }),
          total: quiet.total, ledger_count: quiet.ledger_count, cursor: quiet.cursor,
        };
      }
      const read = sheets.read(a.task_id, { mode, n: a.n, afterId: a.after_id, since: a.since });
      const header = sheets.header(a.task_id);
      return {
        task: { id: header.task, title: header.title, status: header.status, project: header.project },
        mode,
        entries: read.entries,
        text: sheetFormat.format({ header, entries: read.entries }),
        total: read.total,
        ledger_count: read.ledger_count,
        cursor: read.cursor,
      };
    },
  },

  sheet_get: {
    description: "One Sheet entry by id, with its task id.",
    schema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
    run: (a) => sheets.get(a.id),
  },

  sheet_append: {
    description:
      "Write an entry on a task's Sheet. kind say: a remark or finding; note: a marker of something done (a file edited, a deploy); run: a one-line shell command, meta {state, code, cwd, out}. Questions go through sheet_ask and sheet_decide. " +
      PROMOTE_DIRECTIVE,
    schema: {
      type: "object",
      required: ["task_id", "kind", "body"],
      properties: {
        task_id: { type: "number" },
        kind: { type: "string", enum: ["say", "run", "note"] },
        body: { type: "string", description: "Markdown; for run, the command" },
        meta: { type: "object", description: "For run: state (running, ok, fail), code, cwd, out" },
        ref_id: { type: "number", description: "The entry this answers or follows" },
        promote: { type: "boolean", description: "Into the ledger, which every later agent reads first" },
      },
    },
    run: (a) => {
      if (a.kind === "ask" || a.kind === "decide") throw new Error(`Use sheet_${a.kind} for that, not sheet_append.`);
      return sheets.append({ taskId: a.task_id, kind: a.kind, body: a.body, meta: a.meta ?? null,
                             refId: a.ref_id ?? null, promote: a.promote === true });
    },
  },

  sheet_update: {
    description:
      "Change an entry: meta (merged one level deep), body, or promote. Finish a run entry with meta {state: ok or fail, code, dur_ms, lines}. promote true puts it in the ledger, which is read first: promote what changes what the next agent should do. An ask's options and a decision's choice are fixed.",
    schema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "number" },
        meta: { type: "object" },
        body: { type: "string" },
        promote: { type: "boolean" },
      },
    },
    // promote is sheet_promote folded in, so the list carries one tool, not two.
    run: (a) => {
      let entry = null;
      if (a.meta !== undefined || a.body !== undefined || a.promote === undefined) {
        entry = sheets.update(a.id, { meta: a.meta, body: a.body });
      }
      if (a.promote !== undefined) entry = sheets.promote(a.id, a.promote === true);
      return entry;
    },
  },

  sheet_promote: {
    description:
      "Put an entry in its task's ledger (on: true, default) or take it out. The ledger is read first, so promote what changes what the next agent should do: a finding, a dead end, a decision.",
    schema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "number" }, on: { type: "boolean" } },
    },
    run: (a) => sheets.promote(a.id, a.on === undefined ? true : a.on),
  },

  sheet_file: {
    description:
      "Turn a Sheet entry into a project note (decision, gotcha, reference, note) that search and the graph find from other tasks. Also promotes it; filing twice returns the first note.",
    schema: {
      type: "object",
      required: ["id", "kind"],
      properties: {
        id: { type: "number" },
        kind: { type: "string", enum: ["decision", "gotcha", "reference", "note"] },
        title: { type: "string", description: "Default: the entry's first line" },
      },
    },
    run: (a) => sheets.file(a.id, a.kind, a.title ?? null),
  },

  sheet_ask: {
    description:
      "Ask a one-line question on a task's Sheet with two to four answers (a to d), when a person or agent must choose before work goes on. Put background in a say entry first.",
    schema: {
      type: "object",
      required: ["task_id", "question", "options"],
      properties: {
        task_id: { type: "number" },
        question: { type: "string" },
        options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 },
      },
    },
    run: (a) => sheets.ask(a.task_id, a.question, a.options),
  },

  sheet_decide: {
    description:
      "Answer a sheet_ask question. The decision is promoted automatically; say why when it is not obvious.",
    schema: {
      type: "object",
      required: ["ask_id", "choice"],
      properties: {
        ask_id: { type: "number" },
        choice: { type: "string", enum: ["a", "b", "c", "d"] },
        why: { type: "string" },
      },
    },
    // A person answering here (the delphi command, the Sheet in a terminal)
    // puts the job waiting on the question back in the queue in the same
    // call, so the app's dispatcher starts it as soon as it sees the write
    // rather than at its next pass. jobs.resumeAnswered counts only a
    // decision whose author_type is human, so an agent cannot answer its own.
    run: (a) => {
      const entry = sheets.decide(a.ask_id, a.choice, a.why ?? null);
      let resumed = [];
      try { resumed = jobs.resumeAnswered(sql, { taskId: entry.task_id }); } catch (error) { console.error(`resuming jobs after decide: ${error.message}`); }
      return resumed.length ? { ...entry, resumed_jobs: resumed.map((r) => r.id) } : entry;
    },
  },

  sheet_resolve: {
    description:
      "Find a task by id, legacy id or ticket ref, with the folder its commands should run in and where run logs go.",
    schema: {
      type: "object",
      required: ["task"],
      properties: { task: { type: "string", description: "e.g. 42, T-17 or ABC-1234" } },
    },
    run: (a) => {
      const task = sheets.resolveTask(a.task);
      const project = task.project_id != null
        ? sql("SELECT id, key, name FROM projects WHERE id = :p1", [task.project_id])[0] || null
        : null;
      return { task, project, workbench: benchStore.live(task.id), ...resolveTaskFolder(task), log_dir: SHEET_LOG_DIR };
    },
  },

  workbench_start: {
    description:
      "Give a task its own folder and branch (a Workbench) so its work cannot collide with another task's; run your commands in the path returned. An existing one is returned as is (created: false). Setup (npm ci and the like) runs as a recorded command unless run_setup is false. Read warnings: they say when the remote was unreachable.",
    schema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "number" },
        repo: { type: "string", description: "Name or path, when the project has several and none is primary" },
        run_setup: { type: "boolean" },
      },
    },
    run: async (a) => {
      const made = await benches.start(a.task_id, { repo: a.repo || null, runSetup: a.run_setup !== false });
      return {
        workbench: made.workbench, created: made.created, warnings: made.warnings || [],
        setup_entry: made.setup_entry || null, setup_cmd: made.setup_cmd || null,
      };
    },
  },

  workbench_status: {
    description:
      "A task's Workbench in words: unsaved changes, unpushed commits, behind its base. workbench is null when it has none.",
    schema: { type: "object", required: ["task_id"], properties: { task_id: { type: "number" } } },
    run: async (a) => {
      const wb = benchStore.live(a.task_id);
      if (!wb) return { workbench: null };
      return { workbench: wb, status: await benches.status(wb.id, { fresh: true }) };
    },
  },

  workbench_finish: {
    description:
      "Put a task's Workbench away once its work is committed and pushed: the folder goes, the branch stays. Refuses, saying why, when anything is unsaved or unpushed, a rebase or merge is part way, a repository is nested inside, or it holds files git does not keep (an edited .env): removing those is a person's decision, so say in the Sheet what is there. Never forces or stashes. There is no tool to throw a Workbench away: that is a person's decision too.",
    schema: { type: "object", required: ["task_id"], properties: { task_id: { type: "number" } } },
    // No confirm here, on purpose: through this server Finish only goes
    // ahead when nothing at all would be removed that git does not keep.
    run: async (a) => {
      const done = await benches.finish(benchFor(a.task_id).id);
      return { finished: true, task_status: done.taskStatus, branch: done.branch, ref: done.ref || null, recover: done.recover || null };
    },
  },

  workbench_list: {
    description: "Live Workbenches (active, parked, missing) with status in words; project_id or project narrows it. With task_id, that task's Workbench checked fresh (null when it has none).",
    schema: {
      type: "object",
      properties: { project_id: { type: "number" }, project: { type: "string" }, task_id: { type: "number" } },
    },
    // task_id is workbench_status folded in.
    run: (a) => (a.task_id != null ? TOOLS.workbench_status.run(a) : benches.list({ projectId: resolveProjectId(a) })),
  },

  // The rest are for the delphi command line only: left out of tools/list and
  // refused unless DELPHI_CLIENT says the CLI is calling. That is a courtesy,
  // not a boundary, and nothing here depends on it: no tool in this server
  // removes a folder that has anything in it without keeping a copy first.
  // Discard in particular has no tool. The command line does its git work in
  // its own process and only records the result here, through
  // workbench_discarded, which believes nothing it is told.
  workbench_park: {
    description: "Mark a task's Workbench parked. Nothing on disk changes.",
    schema: { type: "object", required: ["task_id"], properties: { task_id: { type: "number" } } },
    run: (a) => benches.park(benchFor(a.task_id).id),
  },
  workbench_resume: {
    description: "Mark a parked Workbench active again.",
    schema: { type: "object", required: ["task_id"], properties: { task_id: { type: "number" } } },
    run: (a) => benches.resume(benchFor(a.task_id).id),
  },
  workbench_update: {
    description: "Bring in the latest from the base branch by rebasing onto it. Stops, changing nothing, on a conflict.",
    schema: { type: "object", required: ["task_id"], properties: { task_id: { type: "number" } } },
    run: (a) => benches.update(benchFor(a.task_id).id),
  },
  workbench_commit: {
    description: "Commit everything in the Workbench folder.",
    schema: { type: "object", required: ["task_id", "message"], properties: { task_id: { type: "number" }, message: { type: "string" } } },
    run: (a) => benches.commit(benchFor(a.task_id).id, a.message),
  },
  workbench_push: {
    description: "Push the Workbench's branch to origin.",
    schema: { type: "object", required: ["task_id"], properties: { task_id: { type: "number" } } },
    run: (a) => benches.push(benchFor(a.task_id).id),
  },
  workbench_pr: {
    description: "Where to open a pull request, or with create, open one with gh.",
    schema: { type: "object", required: ["task_id"], properties: { task_id: { type: "number" }, create: { type: "boolean" } } },
    run: (a) => benches.pr(benchFor(a.task_id).id, { create: a.create === true }),
  },
  workbench_finish_plan: {
    description: "The files git does not keep that Finish would remove, summarised by folder.",
    schema: { type: "object", required: ["task_id"], properties: { task_id: { type: "number" } } },
    run: (a) => benches.finishPlan(benchFor(a.task_id).id),
  },
  workbench_finished: {
    description: "Record a Finish the command line has already done. Refuses unless the folder is gone and the Workbench's copy (ref) is in its repository.",
    schema: {
      type: "object",
      required: ["task_id", "ref"],
      properties: {
        task_id: { type: "number" }, ref: { type: "string" }, not_kept: { type: "array", items: { type: "string" } },
        removed_ignored: { type: "boolean" },
      },
    },
    run: (a) => benches.markFinished(benchFor(a.task_id).id, { ref: a.ref || null, notKept: a.not_kept, removedIgnored: a.removed_ignored === true }),
  },
  workbench_closing: {
    description: "Write a Finish or Discard's intent on the Workbench's row (state closing) before the command line moves the folder, or with cancel, undo it when the move failed.",
    schema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "number" }, mode: { type: "string", enum: ["discard", "finish"] }, ref: { type: "string" },
        trash: { type: "string" }, cancel: { type: "boolean" }, back_to: { type: "string" },
      },
    },
    run: (a) => {
      const wb = benchFor(a.task_id);
      if (a.cancel === true) return benchStore.cancelClosing(wb.id, a.back_to || "active");
      const row = benchStore.beginClosing(wb.id, { mode: a.mode, ref: a.ref, trash: a.trash || null });
      if (!row) throw new Error(`Task ${a.task_id}'s Workbench is not open, so nothing was begun.`);
      return row;
    },
  },
  workbench_busy: {
    description: "What is running in a task's Workbench folder right now, in words. Finish and Discard refuse while anything is.",
    schema: { type: "object", required: ["task_id"], properties: { task_id: { type: "number" } } },
    run: (a) => ({ running: benchStore.busyIn(benchFor(a.task_id)) }),
  },
  workbench_discarded: {
    description: "Record a Discard the command line has already done. Refuses unless the folder is gone and the Workbench's kept copy (ref) is in its repository.",
    schema: {
      type: "object",
      required: ["task_id", "ref"],
      properties: {
        task_id: { type: "number" }, ref: { type: "string" },
        unsaved: { type: "number" }, files: { type: "array", items: { type: "string" } },
        commits: { type: "number" }, detached: { type: "number" }, ignored: { type: "number" },
        branch_tip: { type: "string" }, not_kept: { type: "array", items: { type: "string" } },
      },
    },
    run: (a) => benches.markDiscarded(benchFor(a.task_id).id, {
      ref: a.ref, unsaved: a.unsaved, files: a.files, commits: a.commits, detached: a.detached,
      ignored: a.ignored, branchTip: typeof a.branch_tip === "string" ? a.branch_tip : null, notKept: a.not_kept,
    }),
  },
  workbench_recreate: {
    description: "Put a missing Workbench's folder back on its branch.",
    schema: { type: "object", required: ["task_id"], properties: { task_id: { type: "number" } } },
    run: (a) => benches.recreate(benchFor(a.task_id).id),
  },
  workbench_forget: {
    description: "Stop tracking a missing Workbench. The branch is left alone.",
    schema: { type: "object", required: ["task_id"], properties: { task_id: { type: "number" } } },
    run: (a) => benches.forget(benchFor(a.task_id).id),
  },
  workbench_housekeep: {
    description: "Prune, mark missing folders, adopt orphaned Workbench folders.",
    schema: { type: "object", properties: {} },
    run: () => benches.housekeep(),
  },
  workbench_advanced: {
    description: "The real branch, path and git commands behind a Workbench.",
    schema: { type: "object", required: ["task_id"], properties: { task_id: { type: "number" } } },
    run: (a) => benches.advanced(benchFor(a.task_id).id),
  },

  add_note: {
    description:
      "Store knowledge against a project: a decision and why, a gotcha, a reference. Anything a future session would otherwise rediscover; prefer it to leaving knowledge in chat.",
    schema: {
      type: "object",
      required: ["project_id", "title", "body"],
      properties: {
        project_id: { type: "number" },
        title: { type: "string" },
        body: { type: "string" },
        kind: { type: "string", enum: ["note", "decision", "gotcha", "reference", "contact"] },
      },
    },
    run: (a) => {
      const stepId = auditor.step();
      auditor.run(auditor.create("note", { summary: "created", label: a.title, stepId },
        [`INSERT INTO notes (project_id, title, body, kind) VALUES (:p1, :p2, :p3, :p4)`,
         [a.project_id, a.title, a.body, a.kind || "note"]]));
      return sql("SELECT id, title FROM notes WHERE id = :p1", [auditor.created("note", stepId)])[0];
    },
  },

  list_scratchpads: {
    description:
      "A project's scratchpads (working documents) with their keys. Call it before writing one, to add to the existing plan rather than start a second.",
    schema: {
      type: "object",
      properties: {
        project_id: { type: "number" },
        project: { type: "string", description: "Project key, as an alternative to project_id" },
      },
    },
    run: (a) => {
      const projectId = a.project_id ?? (a.project ? resolveProjectId(a) : null);
      return sql(
        `SELECT s.id, s.project_id, s.key, s.title, s.author, s.derives_tasks, s.updated_at,
                length(s.body) AS size, CASE WHEN s.project_id IS :p1 THEN NULL ELSE p.key END AS home
         FROM scratchpads s LEFT JOIN projects p ON p.id = s.project_id
         ${projectId ? `WHERE ${inProject("scratchpad", "s", ":p1")}` : "WHERE :p1 IS NULL"}
         ORDER BY s.pinned DESC, s.updated_at DESC LIMIT 100`,
        [projectId || null]
      ).map(({ home, ...row }) => (projectId && home ? { ...row, home } : row));
    },
  },

  read_scratchpad: {
    description:
      "Read a scratchpad in full, by id or by project and key: how you pick up what the last session or another agent was doing.",
    schema: {
      type: "object",
      properties: {
        id: { type: "number" },
        project_id: { type: "number" },
        key: { type: "string" },
      },
    },
    run: (a) => {
      const pad = findPad(a, { shown: true });
      if (!pad) throw new Error("No such scratchpad. Call list_scratchpads to see them.");
      return pad;
    },
  },

  write_scratchpad: {
    description:
      "Write a scratchpad, the working document for a piece of work: plan, findings, handover, what you tried. Creates it for a new key, replaces the body otherwise.\n\n" +
      "Checkbox lines become tasks on the board, kept in step both ways:\n" +
      "  - [ ] wire the codex adapter @ray !high\n" +
      "  - [x] a finished one\n" +
      "    - [ ] an indented one is a subtask\n" +
      "So write the plan as checkboxes, and do not also add_task the same work.\n\n" +
      "Delphi marks each filed line <!--d:123-->. Leave those in place: they keep a line and its task the same thing.\n\n" +
      "Prefer append_scratchpad or patch_scratchpad when another agent may be writing the same pad.",
    schema: {
      type: "object",
      required: ["title", "body"],
      properties: {
        project_id: { type: "number" },
        project: { type: "string", description: "Project key, as an alternative to project_id" },
        key: { type: "string", description: "Slug to address it by; default the title" },
        title: { type: "string" },
        body: { type: "string", description: "Markdown" },
        derives_tasks: {
          type: "boolean",
          description: "False for a sketch of options nobody agreed to",
        },
      },
    },
    run: (a) => {
      const projectId = a.project_id ?? resolveProjectId(a);
      const key = padKeyFor(projectId, a.key || a.title);
      const existing = sql("SELECT * FROM scratchpads WHERE project_id = :p1 AND key = :p2",
                           [projectId, key])[0];
      // Recorded with the pad before and after, so an agent's rewrite of a plan
      // is one undo away; it used to be recorded with neither, and every one of
      // them refused to undo.
      if (existing) {
        auditor.run(auditor.update("scratchpad", existing.id, { summary: "wrote to the pad", label: a.title }, [
          [`UPDATE scratchpads SET title = :p1, body = :p2, author = :p3,
               derives_tasks = :p4, updated_at = datetime('now') WHERE id = :p5`,
           [a.title, a.body, ACTOR, a.derives_tasks === false ? 0 : existing.derives_tasks, existing.id]],
        ]));
        return derivePad(existing.id);
      }
      const stepId = auditor.step();
      auditor.run(auditor.create("scratchpad", { summary: "created", label: a.title, stepId },
        [`INSERT INTO scratchpads (project_id, key, title, body, author, derives_tasks)
          VALUES (:p1, :p2, :p3, :p4, :p5, :p6)`,
         [projectId, key, a.title, a.body, ACTOR, a.derives_tasks === false ? 0 : 1]]));
      return derivePad(auditor.created("scratchpad", stepId));
    },
  },

  append_scratchpad: {
    description:
      "Add to the end of a scratchpad without reading it: the safe write when another agent may be on the same pad.",
    schema: {
      type: "object",
      required: ["text"],
      properties: {
        id: { type: "number" },
        project_id: { type: "number" },
        key: { type: "string" },
        text: { type: "string", description: "Markdown" },
      },
    },
    run: (a) => {
      const pad = findPad(a);
      if (!pad) throw new Error("No such scratchpad. Call list_scratchpads to see them.");
      const joiner = !pad.body || pad.body.endsWith("\n") ? "" : "\n";
      // The text is appended in SQL rather than from the body read above, so a
      // write landing between the read and this batch is not overwritten.
      const tail = `${joiner}${a.text}`;
      auditor.run(auditor.update("scratchpad", pad.id, { summary: "added to the pad", label: pad.title }, [
        ["UPDATE scratchpads SET body = body || :p1, author = :p2, updated_at = datetime('now') WHERE id = :p3", [tail, ACTOR, pad.id]],
      ]));
      return derivePad(pad.id);
    },
  },

  patch_scratchpad: {
    description:
      "Replace one section of a scratchpad, found by its markdown heading (added at the end if missing), leaving everyone else's alone.",
    schema: {
      type: "object",
      required: ["heading", "text"],
      properties: {
        id: { type: "number" },
        project_id: { type: "number" },
        key: { type: "string" },
        heading: { type: "string", description: "Without the hashes" },
        text: { type: "string" },
      },
    },
    run: (a) => {
      const pad = findPad(a);
      if (!pad) throw new Error("No such scratchpad. Call list_scratchpads to see them.");
      auditor.run(auditor.update("scratchpad", pad.id, { summary: `rewrote "${a.heading}"`, label: pad.title }, [
        ["UPDATE scratchpads SET body = :p1, author = :p2, updated_at = datetime('now') WHERE id = :p3",
         [patchSection(pad.body, a.heading, a.text), ACTOR, pad.id]],
      ]));
      return derivePad(pad.id);
    },
  },

  handoff_send: {
    description:
      "Hand work to another agent as a job. kind ask: it reads the project and answers (\"have Codex review this branch\"). kind do: it changes code in the task's own Workbench, never the main checkout, and a person reviews it. Without task_id the job gets a task whose Sheet is its log.\n\n" +
      "Returns a job_id at once. An agent's job waits for a person's approval (needs_approval) unless the project lets agents start work; the result says which, whether a Delphi app is running to dispatch it, and whether you will be woken. Believe it. Do not wait, poll or sleep: finish and say you handed it over; read it later with run_status. Unsure of the name? list_agents.",
    schema: {
      type: "object",
      required: ["to", "request"],
      properties: {
        to: { type: "string", description: "Agent key: codex, claude-code, copilot" },
        request: { type: "string", description: "Written for them, not for a log" },
        kind: { type: "string", enum: ["ask", "do"], description: "Default ask" },
        project_id: { type: "number" },
        project: { type: "string", description: "Key, instead of project_id" },
        task_id: { type: "number" },
        context: { type: "object", description: "Branch, files, pad ids: what they cannot work out" },
        wake: { type: "boolean", description: "A turn when the reply lands; false if you are leaving" },
      },
    },
    run: (a) => {
      // A job about a task belongs to the task's project, where its Workbench is
      // built; naming another project beside it is refused (agent/jobs.js).
      const named = a.project_id ?? resolveProjectId(a);
      if (named == null && a.task_id == null) throw new Error("A handoff needs a project. Pass project_id or project.");
      const projectId = jobs.projectFor(sql, { projectId: named, taskId: a.task_id ?? null });
      const target = sql("SELECT key, label, enabled FROM harnesses WHERE key = :p1", [String(a.to)])[0];
      if (!target) {
        const known = sql("SELECT key FROM harnesses WHERE enabled = 1").map((r) => r.key).join(", ");
        throw new Error(`No agent called '${a.to}'. This machine has: ${known || "none configured"}.`);
      }
      if (!target.enabled) throw new Error(`${target.label} is turned off in Delphi's settings.`);
      const kind = a.kind === undefined || a.kind === null ? "ask" : String(a.kind);
      if (!jobs.KINDS.includes(kind)) throw new Error(`kind must be ask (read and answer) or do (change code), not '${kind}'.`);
      // Refused now rather than failed later: an agent told at once that the
      // project has no folder can tell its person what to set.
      const problem = jobs.folderProblem(sql, Number(projectId));
      if (problem) throw new Error(problem);

      // An agent's request waits for a person unless the project says its
      // agents may start work by themselves. Nothing here can approve one.
      const project = sql("SELECT auto_approve FROM projects WHERE id = :p1", [Number(projectId)])[0] || {};
      const { state, approval } = jobs.approvalFor({ requesterType: "agent", autoApprove: Number(project.auto_approve) === 1 });
      const run = jobs.insert(sql, {
        projectId: Number(projectId),
        // Set by whatever launched this server. A handoff from a tab knows
        // which tab it came from and can be woken; one from an editor's own
        // MCP client does not, and simply has nobody to wake.
        fromSessionId: process.env.DELPHI_SESSION ? Number(process.env.DELPHI_SESSION) : null,
        toHarness: target.key, request: String(a.request), taskId: a.task_id ?? null,
        context: a.context ?? null, wake: a.wake !== false, kind, source: "handoff",
        requestedBy: ACTOR, requesterType: AUTHOR_TYPE || "agent", state, approval,
      });
      // The job's own record: attributed like every row, never undone.
      auditor.run([auditor.statement({ action: "create", entity: "handoff", id: run.id, summary: `asked ${run.harness} (${kind})`,
                                       label: run.request.slice(0, 80) })]);
      // Told honestly. Only a Delphi app's dispatcher ever runs a job, and
      // only a session the app launched has a turn to be woken into, so an
      // agent promised both when neither holds stops and waits for nothing.
      const app = appState();
      const wakeable = run.from_session_id != null && run.wake;
      // "nothing will dispatch it" only when that is certain: a running app
      // from before heartbeats looks, from here, like no app at all.
      const when = app.running === true
        ? "A Delphi app is running against this database and will dispatch it."
        : app.running === false
          ? `No Delphi app is running against this database, so nothing will dispatch it until one is started. ${app.reason}`
          : `It is not certain a Delphi app is running against this database to dispatch it. ${app.reason}`;
      const gate = state === "needs_approval"
        ? " It waits for a person to approve it in Delphi's Runs panel before it starts."
        : " The project lets agents start work by themselves, so it runs without waiting for approval.";
      const after = wakeable
        ? (app.running === true ? " You will be woken with the reply." : " You will be woken with the reply once it has run.")
        : " Nothing can wake you with the reply, because this session was not started by Delphi: read it later with run_status.";
      return {
        ...run,
        // The row as written, for a reader that wants the stored text.
        context_json: sql("SELECT context_json FROM handoffs WHERE id = :p1", [run.id])[0].context_json,
        job_id: run.id,
        needs_approval: state === "needs_approval",
        dispatcher_running: app.running,
        will_wake: wakeable,
        note: `Job ${run.id} created.${gate} ${when}${after} Do not wait for it here.`,
      };
    },
  },

  handoff_status: {
    description:
      "What was handed to and from you and where each got to: check it on returning to a session. run_status and run_list say more.",
    schema: {
      type: "object",
      properties: {
        id: { type: "number", description: "One, in full, with the reply" },
        project_id: { type: "number" },
        project: { type: "string" },
      },
    },
    run: (a) => {
      if (a.id != null) {
        const row = sql("SELECT * FROM handoffs WHERE id = :p1", [Number(a.id)])[0];
        if (!row) throw new Error("No such handoff");
        return { ...row, state: jobs.toRun(row).state };
      }
      const projectId = a.project_id ?? resolveProjectId(a);
      const session = process.env.DELPHI_SESSION ? Number(process.env.DELPHI_SESSION) : null;
      return sql(
        `SELECT id, from_session_id, to_harness, status, state, kind, request, reply, created_at, finished_at
         FROM handoffs
         WHERE ${projectId != null ? "project_id = :p1" : "1 = :p1"}
         ORDER BY id DESC LIMIT 25`,
        [projectId != null ? projectId : 1]
      ).map((h) => ({ ...h, state: jobs.toRun(h).state, mine: session != null && h.from_session_id === session }));
    },
  },

  run_status: {
    description:
      "One job: state (queued, needs_approval, running, waiting_on_human, done, failed, stopped), who asked and approved, Workbench, tokens, reply. Its log is the task's Sheet. Read it when you return; do not poll.",
    schema: {
      type: "object",
      required: ["job_id"],
      properties: { job_id: { type: "number", description: "From handoff_send" } },
    },
    run: (a) => {
      const run = jobs.get(sql, Number(a.job_id));
      if (!run) throw new Error(`No job ${a.job_id}.`);
      return { ...run, dispatcher_running: appState().running };
    },
  },

  run_list: {
    description:
      "Jobs, newest first, by project, states, or only yours. Approving one is a person's decision in the app; no tool does it.",
    schema: {
      type: "object",
      properties: {
        project_id: { type: "number" },
        project: { type: "string" },
        states: { type: "array", items: { type: "string", enum: jobs.STATES } },
        mine: { type: "boolean", description: "Ones you asked for or run" },
        limit: { type: "number", description: "Default 25" },
      },
    },
    run: (a) => {
      const projectId = a.project_id ?? resolveProjectId(a);
      return {
        dispatcher_running: appState().running,
        jobs: jobs.list(sql, { projectId, states: Array.isArray(a.states) ? a.states : null, actor: a.mine ? ACTOR : null, limit: a.limit || 25 })
          // The request and reply in full are one run_status away.
          .map((r) => ({ ...r, request: r.request.length > 300 ? `${r.request.slice(0, 297)}...` : r.request, reply: r.reply && r.reply.length > 300 ? `${r.reply.slice(0, 297)}...` : r.reply })),
      };
    },
  },

  second_opinion: {
    description:
      "Ask another agent (Copilot by default) for a second opinion and wait for its answer. It runs read only, with Delphi's tools, in the task's Workbench or the project's folder, and returns what it said. " +
      "It reads only inside the project's folders and the task's Workbench, never key files, one at a time, and a limited number an hour. " +
      "Use it to review a diff before a commit or pull request (write the diff to a file inside the project and pass it in files), to diagnose a bug independently (give it the symptom, not your conclusion), or to summarise unfamiliar code. " +
      "Verify what it says before acting on it. Never send secrets or real personal data. With task_id the answer is also kept on the task's Sheet.",
    schema: {
      type: "object",
      required: ["request"],
      properties: {
        request: { type: "string", description: "What to look at and what you want to know, written for them" },
        files: { type: "array", items: { type: "string" }, description: "Paths it should read: a diff, the files in question" },
        cwd: { type: "string", description: "Folder to run in. Default: the project's folder" },
        task_id: { type: "number", description: "Keep the answer on this task's Sheet" },
        project_id: { type: "number" },
        project: { type: "string", description: "Key, instead of project_id" },
        timeout_seconds: { type: "number", description: "Default 300, at most 600" },
      },
    },
    run: async (a) => {
      const row = secondOpinionAgent();
      const key = String(readSettings().secondOpinionAgent || "copilot");
      if (!row) throw new Error(`There is no agent called "${key}" to ask. Set the second opinion agent in Delphi's Settings.`);
      if (!Number(row.enabled)) throw new Error(`${row.label} is turned off in Delphi's Settings, under Agents. Turn it on to ask it for a second opinion.`);

      const { task, projectId, roots, cwd } = secondOpinionScope(a);

      // Claimed only once everything else has been checked, immediately before
      // the agent starts, so a call that was refused for a missing file or a
      // folder outside the project does not count against the hour.
      let claim = null;
      const beforeStart = () => {
        const limit = secondOpinion.hourlyLimit(readSettings());
        if (limit === 0) return "Second opinions are turned off: the hourly limit in Delphi's Settings is 0.";
        claim = secondOpinion.claimHourly(sql, { limit, actor: ACTOR, agent: row.key, projectId, taskId: task ? task.id : null });
        return claim ? null : `${limit} second opinions have been asked for on this database in the last hour, which is the limit in Delphi's Settings. Carry on without one and say so, or ask again later.`;
      };

      let result;
      try {
        result = await secondOpinion.run({
          row,
          request: a.request,
          files: a.files || [],
          cwd,
          roots,
          dataDir: RESOLVED.dataDir,
          dbPath: DB,
          beforeStart,
          timeoutMs: a.timeout_seconds ? Number(a.timeout_seconds) * 1000 : undefined,
          // Its own name in History, so a note it writes is never mistaken for
          // the caller's.
          mcp: { dbPath: DB, dbId: IDENTITY.db_id, projectId, sessionId: null, actor: `${row.key}:second-opinion`, tag: "second-opinion", readOnly: true },
        });
      } catch (error) {
        secondOpinion.finishHourly(sql, claim, "failed");
        throw error;
      }
      secondOpinion.finishHourly(sql, claim, "answered");

      // Kept on the task after the answer is in hand, and a failure to keep it
      // is reported beside the answer rather than instead of it: the task may
      // have gone while the agent was thinking, and the answer is still good.
      if (!task) return result;
      const first = secondOpinion.redact(String(a.request).trim().split("\n")[0].slice(0, 200)).text;
      // A Sheet is read by every later session and mirrored into the vault, so
      // a key the reviewer quoted back from a file it read is taken out first,
      // and the entry says so rather than leaving a gap nobody can explain.
      const clean = secondOpinion.redact(result.answer);
      const said = clean.count
        ? `\n\n_${clean.count} ${clean.count === 1 ? "thing" : "things"} shaped like a token or private key ${clean.count === 1 ? "was" : "were"} replaced with [redacted] before this was kept._`
        : "";
      try {
        return { ...result, redacted: clean.count, comment_id: addComment(task.id, `**Second opinion from ${result.label}** (asked: ${first})\n\n${clean.text}${said}`).id };
      } catch (error) {
        return { ...result, comment_error: `The answer could not be kept on task ${task.id}: ${error.message}` };
      }
    },
  },

  list_agents: {
    description:
      "The other agents Delphi can hand work to on this machine, and whether each is turned on. Call this before handoff_send if you are guessing at a name.",
    schema: { type: "object", properties: {} },
    // The launch fields ride along (plan 6.6), so a client that runs agents
    // itself (sheet/chat.js) launches them as Settings says, edits included.
    run: () => sql("SELECT key, label, enabled, command, args_json, parser, mcp_style FROM harnesses ORDER BY sort_order, id")
      .map(({ args_json: argsJson, ...row }) => {
        let args = [];
        try { args = JSON.parse(argsJson); } catch {}
        return { ...row, args: Array.isArray(args) ? args : [] };
      }),
  },

  lock_acquire: {
    description:
      "Take a lease on something two agents could both touch: a file, a migration, a branch, a dev server. It expires, so a dead agent cannot hold it forever; call again with the same key to extend. held false means someone else has it, and says who.",
    schema: {
      type: "object",
      required: ["key"],
      properties: {
        key: { type: "string", description: "e.g. db/schema.sql" },
        project_id: { type: "number" },
        project: { type: "string" },
        note: { type: "string", description: "What you are doing, for whoever finds it held" },
        minutes: { type: "number", description: "Default 15" },
      },
    },
    run: (a) => {
      const projectId = a.project_id ?? resolveProjectId(a);
      if (projectId == null) throw new Error("A lock needs a project. Pass project_id or project.");
      const minutes = Math.max(1, Number(a.minutes) || 15);
      // Two statements, both leaning on the unique index, so two agents asking at
      // the same moment cannot both win. Twin of db.js acquireLock.
      sql(
        `INSERT INTO locks (project_id, key, holder, note, expires_at)
         VALUES (:p1, :p2, :p3, :p4, datetime('now', :p5))
         ON CONFLICT (project_id, key) DO UPDATE SET
           holder = excluded.holder, note = excluded.note, expires_at = excluded.expires_at,
           created_at = datetime('now')
         WHERE locks.expires_at <= datetime('now') OR locks.holder = excluded.holder`,
        [projectId, String(a.key), ACTOR, a.note ?? null, `+${minutes} minutes`]
      );
      const row = sql("SELECT * FROM locks WHERE project_id = :p1 AND key = :p2",
                      [projectId, String(a.key)])[0];
      return {
        held: row.holder === ACTOR,
        holder: row.holder,
        expires_at: row.expires_at,
        note: row.holder === ACTOR
          ? "Yours until it expires. Call lock_release when you are done."
          : `${row.holder} has this until ${row.expires_at}. Work on something else, or wait.`,
      };
    },
  },

  lock_release: {
    description: "Give back a lease as soon as you are done.",
    schema: {
      type: "object",
      required: ["key"],
      properties: {
        key: { type: "string" },
        project_id: { type: "number" },
        project: { type: "string" },
      },
    },
    run: (a) => {
      const projectId = a.project_id ?? resolveProjectId(a);
      sql("DELETE FROM locks WHERE project_id = :p1 AND key = :p2 AND holder = :p3",
          [projectId, String(a.key), ACTOR]);
      return { released: true };
    },
  },

  lock_status: {
    description: "What is held in a project, and by whom.",
    schema: {
      type: "object",
      properties: { project_id: { type: "number" }, project: { type: "string" } },
    },
    run: (a) => {
      const projectId = a.project_id ?? resolveProjectId(a);
      sql("DELETE FROM locks WHERE expires_at <= datetime('now')");
      return sql(
        `SELECT key, holder, note, expires_at FROM locks
         ${projectId != null ? "WHERE project_id = :p1" : ""} ORDER BY key`,
        projectId != null ? [projectId] : []
      );
    },
  },

  // The three lease tools as one entry in the list. They stay callable by name.
  lock: {
    description:
      "Leases on something two agents could both touch: a file, a migration, a branch, a dev server. take (the default) holds key for minutes (15) and extends your own; held false means someone else has it, and says who. A lease expires, so a dead agent cannot hold it forever. release gives it back as soon as you are done; status lists what is held in a project.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["take", "release", "status"] },
        key: { type: "string", description: "e.g. db/schema.sql" },
        project_id: { type: "number" },
        project: { type: "string" },
        note: { type: "string", description: "What you are doing, for whoever finds it held" },
        minutes: { type: "number" },
      },
    },
    run: (a) => {
      const action = a.action || "take";
      if (action === "status") return TOOLS.lock_status.run(a);
      if (!a.key) throw new Error(`lock ${action} needs a key.`);
      return action === "release" ? TOOLS.lock_release.run(a) : TOOLS.lock_acquire.run(a);
    },
  },

  timer_set: {
    description:
      "Get a turn later instead of waiting, for a build, a deploy, anything on its own clock. Only inside a Delphi agent tab, which has a session to wake. Waiting in a loop burns tokens and stops when your turn ends.",
    schema: {
      type: "object",
      required: ["minutes", "message"],
      properties: {
        minutes: { type: "number", description: "From now" },
        message: { type: "string", description: "What to tell you on waking, enough to carry on" },
      },
    },
    run: (a) => {
      const session = process.env.DELPHI_SESSION ? Number(process.env.DELPHI_SESSION) : null;
      if (!session) {
        throw new Error(
          "There is no session to wake: this server was not launched by a Delphi agent tab. " +
          "Ask the person to run you as a tab in Delphi if you need this."
        );
      }
      const minutes = Math.max(1, Number(a.minutes) || 1);
      // RETURNING for the reason derivePad gives.
      const row = sql(
        `INSERT INTO alerts (session_id, kind, fire_at, message)
         VALUES (:p1, 'timer', datetime('now', :p2), :p3)
         RETURNING id, fire_at`,
        [session, `+${minutes} minutes`, String(a.message)]
      )[0];
      return { ...row, note: "Set. Finish your turn: you will be given another one when it fires." };
    },
  },

  // The four memory tools answer in a few hundred tokens by default: ids, titles,
  // scores and one sentence each, inside `budget` (tokens, default 1500). See
  // agent/recall.js. detail "full" is the answer each gave before, unchanged, so
  // a client written against it still works.
  search: {
    description:
      "Find tasks and notes by words, best first, one line each. Check here before searching a repository. Read one with get_note or get_task; detail full returns whole bodies.",
    schema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Per kind, default 8" },
        budget: { type: "number", description: "Max tokens, default 1500" },
        detail: { type: "string", enum: ["brief", "full"] },
      },
    },
    run: (a) => {
      if (a.detail !== "full") return recall.search(String(a.query), opts(a, 8));
      const like = `%${a.query}%`;
      const also = (entity) => `(SELECT GROUP_CONCAT(ap.name, ', ') FROM item_projects ip JOIN projects ap ON ap.id = ip.project_id
                                  WHERE ip.entity = '${entity}' AND ip.entity_id = x.id) AS also_in`;
      return {
        tasks: sql(
          `SELECT x.id, x.title, x.status, p.name AS project, ${also("task")} FROM tasks x
           LEFT JOIN projects p ON p.id = x.project_id
           WHERE x.title LIKE :p1 OR x.detail LIKE :p1 OR x.ref LIKE :p1 LIMIT 30`, [like]),
        notes: sql(
          `SELECT x.id, x.title, x.kind, x.body, p.name AS project, ${also("note")} FROM notes x
           LEFT JOIN projects p ON p.id = x.project_id
           WHERE x.title LIKE :p1 OR x.body LIKE :p1 LIMIT 30`, [like]),
      };
    },
  },

  get_note: {
    description: "Notes in full by id, after search, oracle_ask or oracle_context.",
    schema: {
      type: "object",
      properties: { id: { type: "number" }, ids: { type: "array", items: { type: "number" } } },
    },
    run: (a) => {
      const ids = [...(a.ids || []), ...(a.id != null ? [a.id] : [])].map(Number).filter(Number.isInteger);
      if (!ids.length) throw new Error("Pass id, or ids for several.");
      const rows = sql(
        `SELECT n.id, n.title, n.kind, n.body, n.pinned, n.created_at, n.updated_at, p.id AS project_id, p.name AS project
         FROM notes n LEFT JOIN projects p ON p.id = n.project_id WHERE n.id IN (${ids.slice(0, 20).join(",")})`);
      if (a.id != null && !a.ids) {
        if (!rows[0]) throw new Error(`No note ${a.id}`);
        return rows[0];
      }
      return { notes: rows, missing: ids.filter((id) => !rows.some((r) => Number(r.id) === id)) };
    },
  },

  oracle_context: {
    description:
      "What we know about one thing (project, ticket, service, repo, file, person, term): notes and tasks that mention it, its projects, and what it appears alongside. Use it before reading a repository. No name lists what the graph knows.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "e.g. Offerworks, PROJ-1234, billing API" },
        kind: { type: "string", description: "Filters the list when there is no name" },
        limit: { type: "number", description: "Per list, default 8" },
        budget: { type: "number", description: "Max tokens, default 1500" },
        detail: { type: "string", enum: ["brief", "full"] },
      },
    },
    run: (a) => {
      if (a.detail !== "full" || !a.name) return recall.context(a.name ? String(a.name) : "", { ...opts(a, 8), kind: a.kind || null });
      const like = `%${a.name}%`;
      const entity = sql(
        "SELECT * FROM entities WHERE name LIKE :p1 ORDER BY mentions DESC LIMIT 1", [like]
      )[0];
      if (!entity) {
        return { found: false, suggestions: sql(
          "SELECT kind, name, mentions FROM entities ORDER BY mentions DESC LIMIT 15") };
      }
      return {
        entity,
        projects: sql(`
          SELECT DISTINCT p.name FROM edges e
          JOIN notes n ON e.source_type='note' AND n.id=e.source_id
          JOIN projects p ON p.id=n.project_id
          WHERE e.target_type='entity' AND e.target_id=:p1
          UNION
          SELECT DISTINCT p.name FROM edges e
          JOIN tasks t ON e.source_type='task' AND t.id=e.source_id
          JOIN projects p ON p.id=t.project_id
          WHERE e.target_type='entity' AND e.target_id=:p1`, [entity.id]),
        notes: sql(`
          SELECT n.id, n.title, n.kind, n.body, p.name AS project, e.evidence
          FROM edges e JOIN notes n ON n.id=e.source_id
          LEFT JOIN projects p ON p.id=n.project_id
          WHERE e.source_type='note' AND e.target_type='entity'
            AND e.target_id=:p1 AND e.relation='mentions' LIMIT 20`, [entity.id]),
        tasks: sql(`
          SELECT t.id, t.title, t.status, t.priority, t.ref, p.name AS project
          FROM edges e JOIN tasks t ON t.id=e.source_id
          LEFT JOIN projects p ON p.id=t.project_id
          WHERE e.source_type='task' AND e.target_type='entity'
            AND e.target_id=:p1 AND e.relation='mentions'
          ORDER BY t.status!='done' DESC LIMIT 20`, [entity.id]),
        related: sql(`
          SELECT o.kind, o.name, e.weight FROM edges e
          JOIN entities o ON o.id = CASE WHEN e.source_id=:p1 THEN e.target_id ELSE e.source_id END
          WHERE e.relation='co_occurs' AND (e.source_id=:p1 OR e.target_id=:p1)
          ORDER BY e.weight DESC LIMIT 12`, [entity.id]),
      };
    },
  },

  // Not listed: oracle_context with no name does this now. Still callable, so
  // nothing that already calls it breaks.
  oracle_entities: {
    description:
      "List the things the graph knows about, most referenced first. Useful for orienting at the start of a session, or finding the exact name to pass to oracle_context.",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["ticket", "pr", "repo", "service", "file", "person", "env", "concept", "project", "term", "code"] },
        limit: { type: "number" },
      },
    },
    run: (a) => {
      const params = [];
      let where = "";
      if (a.kind) { params.push(a.kind); where = "WHERE kind = :p1"; }
      params.push(Math.min(a.limit || 40, 200));
      return sql(
        `SELECT kind, name, mentions FROM entities ${where} ORDER BY mentions DESC LIMIT :p${params.length}`,
        params
      );
    },
  },

  oracle_ask: {
    description:
      "The main way to ask what we know. Ranks notes and tasks by meaning (when a local embedding model runs), words and graph links, and answers in sentences quoted from the best notes, cited by id. Prefer it to reading a repository, and to search when unsure of the words.",
    schema: {
      type: "object",
      required: ["question"],
      properties: {
        question: { type: "string" },
        limit: { type: "number", description: "Per kind, default 6" },
        budget: { type: "number", description: "Max tokens, default 1500" },
        detail: { type: "string", enum: ["brief", "full"] },
      },
    },
    run: (a) => {
      if (a.detail !== "full") return recall.ask(String(a.question), opts(a, 6));
      // The answer this tool gave before it ranked anything: lexical matches with
      // whole bodies, and the entities the best of them mention.
      const limit = Math.min(a.limit || 8, 30);
      const words = String(a.question).toLowerCase()
        .split(/[^a-z0-9_.-]+/).filter((w) => w.length > 3);

      const scoreClause = words.length
        ? words.map((w, i) => `(CASE WHEN lower(t.title || ' ' || COALESCE(t.detail,'')) LIKE :p${i + 1} THEN 1 ELSE 0 END)`).join(" + ")
        : "0";
      const params = words.map((w) => `%${w}%`);

      const tasks = words.length ? sql(
        `SELECT t.id, t.title, t.status, t.ref, p.name AS project, (${scoreClause}) AS hits
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         WHERE (${scoreClause}) > 0 ORDER BY hits DESC, t.status != 'done' DESC LIMIT :p${params.length + 1}`,
        [...params, limit]) : [];

      const noteClause = words.length
        ? words.map((w, i) => `(CASE WHEN lower(n.title || ' ' || n.body) LIKE :p${i + 1} THEN 1 ELSE 0 END)`).join(" + ")
        : "0";
      const notes = words.length ? sql(
        `SELECT n.id, n.title, n.kind, n.body, p.name AS project, (${noteClause}) AS hits
         FROM notes n LEFT JOIN projects p ON p.id = n.project_id
         WHERE (${noteClause}) > 0 ORDER BY hits DESC LIMIT :p${params.length + 1}`,
        [...params, limit]) : [];

      // The graph's tables are made by the app (oracle.sql), so a database an
      // agent reached before the app ever opened it has none. That is no reason
      // to lose the matches already found.
      const seedIds = notes.slice(0, 4).map((n) => n.id);
      const graphed = schemaLater.hasTable((s) => DATABASE.query(s), "edges");
      const connected = seedIds.length && graphed ? sql(
        `SELECT DISTINCT e2.kind, e2.name, e2.mentions FROM edges ed
         JOIN entities e2 ON e2.id = ed.target_id
         WHERE ed.source_type = 'note' AND ed.relation = 'mentions'
           AND ed.source_id IN (${seedIds.join(",")})
         ORDER BY e2.mentions DESC LIMIT 12`) : [];

      return {
        note: "Lexical and graph results with whole bodies. The brief answer (the default) also ranks by meaning when a local embedding model is running.",
        tasks, notes, connected,
      };
    },
  },

  // --- items in the wrong place ------------------------------------------------
  //
  // An agent may say an item is misfiled and propose where it belongs. Nothing
  // here applies a proposal: approving is a person's, in the window or with
  // delphi flags approve, which the guard blocks in an agent's shell.

  flag_item: {
    description:
      "Say an item may be in the wrong project: note where it belongs and why. Changes nothing; the Oracle proposes a home and a person decides.",
    schema: {
      type: "object",
      required: ["entity", "id", "note"],
      properties: {
        entity: { type: "string", enum: ["task", "note", "scratchpad", "link", "organizer", "session"] },
        id: { type: "number" },
        note: { type: "string" },
        evidence: { type: "array", items: { type: "object" }, description: "{type: text|url, value} or {type: task|note|pad|project, id}" },
      },
    },
    run: (a) => {
      const made = itemStore.flag({ entity: a.entity, id: a.id, note: a.note, evidence: a.evidence ?? null, suggest: a.suggest ?? null, source: "agent" });
      return { flag_id: made.flag.id, status: made.flag.status, appended: made.appended, proposal: made.flag.proposal_summary };
    },
  },

  propose_move: {
    description:
      "Propose where an item belongs: 1 to 3 ops (move, copy, associate, dissociate). Never applies: returns the plan with any refusals, for a person to approve.",
    schema: {
      type: "object",
      required: ["ops", "reasoning"],
      properties: {
        flag_id: { type: "number", description: "Or entity and id" },
        entity: { type: "string" },
        id: { type: "number" },
        ops: { type: "array", items: { type: "object" }, description: "{op, entity, id, to, keepInSource}" },
        reasoning: { type: "string" },
        confidence: { type: "number", description: "0 to 1" },
      },
    },
    run: (a) => {
      const done = itemStore.propose({ flagId: a.flag_id ?? null, entity: a.entity ?? null, id: a.id ?? null, ops: a.ops,
        reasoning: a.reasoning, confidence: a.confidence ?? null, by: ACTOR, evaluator: ACTOR });
      return { flag_id: done.flag.id, status: done.flag.status, plan: done.plan.map((p) => ({ ok: p.ok, summary: p.summary, refusals: p.refusals })) };
    },
  },

  list_flags: {
    description: "Flags on possibly misfiled items, with each proposal in a line. Open ones unless status says.",
    schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "e.g. applied, rejected, all" },
        project_id: { type: "number" },
        project: { type: "string" },
      },
    },
    run: (a) => itemStore.listFlags({ status: a.status ? (a.status === "live" ? null : a.status) : null, projectId: resolveProjectId(a) })
      .map((f) => ({ id: f.id, item: `${f.entity} ${f.entity_id}`, label: f.label, home: f.project ? f.project.key : null,
        status: f.status, proposal: f.proposal_summary, by: f.created_by })),
  },

  // There is no decide tool. Approving or rejecting a proposal happens only in
  // the Delphi window: nothing that reaches this server, the command line
  // included, can show it is a person rather than an agent saying it is one.
  flag_get: {
    description: "One flag with its thread and the plan of its proposal.",
    schema: { type: "object", required: ["flag_id"], properties: { flag_id: { type: "number" } } },
    run: (a) => itemStore.getFlag(a.flag_id),
  },

  recent_activity: {
    description: "What changed recently, and who changed it. Useful for picking up where another agent left off.",
    schema: { type: "object", properties: { limit: { type: "number" } } },
    run: (a) =>
      sql(`SELECT at, action, entity, entity_id, summary, label, undone
           FROM audit ORDER BY id DESC LIMIT :p1`, [Math.min(a.limit || 30, 200)]),
  },
};

// Recall for the memory tools. The query embedding comes from Ollama when it
// answers inside a short timeout (embeddings.js embedQuery); the stored vectors
// are read through sql like everything else, so semantic ranking works on both
// routes, and without Ollama the ranking is words and graph alone.
const embeddings = require("../embeddings");
const recall = require("./recall").makeRecall({
  sql,
  hasTable: (name) => schemaLater.hasTable((s) => DATABASE.query(s), name),
  embedQuery: (text) => embeddings.embedQuery(text),
});
const opts = (a, limit) => ({
  limit: Math.max(1, Math.min(Number(a.limit) || limit, 50)),
  budget: Math.max(200, Number(a.budget) || 1500),
});

// Listed nowhere but still callable by anyone, because a broader tool covers
// them and a client that already calls one by name must keep working.
const UNLISTED_TOOLS = new Set([
  "oracle_entities", "sheet_promote", "workbench_status", "lock_acquire", "lock_release", "lock_status",
]);

// Callable only by the delphi command line, and not listed. See the comment
// above workbench_park.
const INTERNAL_TOOLS = new Set([
  "workbench_park", "workbench_resume", "workbench_update", "workbench_commit", "workbench_push",
  "workbench_pr", "workbench_finish_plan", "workbench_finished", "workbench_busy", "workbench_closing", "workbench_discarded", "workbench_recreate",
  "workbench_forget", "workbench_housekeep", "workbench_advanced",
  "flag_get",
]);
const CLI_CLIENT = process.env.DELPHI_CLIENT === "delphi-cli";

// A server started for a second opinion offers only what reads. The reviewer is
// handed whatever it is reviewing, and a diff can carry instructions; read only
// has to mean it cannot file work, change a pad, hand a job to an agent that
// writes, or ask for a second opinion of its own and start a chain. Listed by
// what is allowed rather than what is not, so a tool added later is closed to it
// until someone decides otherwise.
const READ_ONLY = process.env.DELPHI_READ_ONLY === "1";
// The list lives in agent/second_opinion.js, which hands the same names to
// Copilot as --available-tools.
const READ_ONLY_TOOLS = new Set(secondOpinion.READ_ONLY_TOOLS);

// --- JSON-RPC ---------------------------------------------------------------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

/**
 * Answers one request.
 *
 * Async so a tool may return a promise: starting a Workbench fetches and runs
 * git, which is not something to do synchronously on the only thread. Every
 * synchronous tool still runs to completion before the next line is read,
 * because an async function runs up to its first await at once, so the order
 * writes land in is the order requests arrived in, as it was before.
 */
async function handle(req) {
  const { id, method, params } = req;

  if (method === "initialize") {
    const scratchpad = READ_ONLY ? { on: false } : scratchpadState();
    const second = READ_ONLY ? { on: false } : secondOpinionState();
    // Both directives, when both are on, as separate sections of one text.
    const instructions = [
      scratchpad.on ? directives.scratchpadInstructions(scratchpad.project) : null,
      second.on ? directives.secondOpinionInstructions(second.label) : null,
    ].filter(Boolean).join("\n\n");
    if (second.on) secondOpinionRemindedAt = Date.now();
    return {
      protocolVersion: "2024-11-05",
      // listChanged, because the scratchpad setting rewrites tool descriptions.
      // Without it a client caches the list from startup and the toggle does
      // nothing until the agent is restarted.
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "brain", version: "1.0.0" },
      ...(instructions ? { instructions } : {}),
    };
  }

  if (method === "tools/list") {
    // A server started read only carries none of the directives: they tell the
    // reviewer to write pads and ask for second opinions, which it cannot, and
    // each one is tokens on someone else's quota spent on an instruction it has
    // to ignore.
    const scratchpad = READ_ONLY ? { on: false } : scratchpadState();
    const suffix = scratchpad.on ? directives.scratchpadToolNote(scratchpad.project) : "";
    const second = READ_ONLY ? { on: false } : secondOpinionState();
    const secondNote = second.on ? directives.secondOpinionToolNote(second.label) : "";
    return {
      tools: Object.entries(TOOLS).filter(([name]) => !INTERNAL_TOOLS.has(name) && !UNLISTED_TOOLS.has(name) &&
                                                      (!READ_ONLY || READ_ONLY_TOOLS.has(name))).map(([name, t]) => ({
        name,
        description: t.description +
          (suffix && SCRATCHPAD_TOOLS.has(name) ? suffix : "") +
          (secondNote && SECOND_OPINION_TOOLS.has(name) ? secondNote : ""),
        inputSchema: t.schema,
      })),
    };
  }

  if (method === "tools/call") {
    refuseIfReplaced();
    const tool = TOOLS[params.name];
    if (!tool || (INTERNAL_TOOLS.has(params.name) && !CLI_CLIENT)) throw new Error(`Unknown tool ${params.name}`);
    if (READ_ONLY && !READ_ONLY_TOOLS.has(params.name)) {
      throw new Error(`${params.name} is not available here: this Delphi server was started read only, for a second opinion. Say what you would do instead.`);
    }
    // One step per call: every row it writes shares the id, which is what a
    // rollback takes whole. See agent/audit.js.
    const result = await STEP.run(auditLib.newStep("m"), () => tool.run(params.arguments || {}));
    // Compact JSON. Indentation is a fifth of a pretty-printed answer and an
    // agent reads the structure without it, so every call paid for whitespace.
    const content = [{ type: "text", text: JSON.stringify(result) }];

    // The last word, and the one an agent is most likely to act on, because it
    // arrives while it is already working rather than at startup. Only on
    // list_projects: that is the orienting call, and repeating this on every
    // result would train the model to skip it.
    // None of this on a read-only server; see tools/list.
    const scratchpad = READ_ONLY ? { on: false } : scratchpadState();
    if (scratchpad.on && params.name === "list_projects") {
      content.push({ type: "text", text: directives.scratchpadReminder(scratchpad.project) });
    }
    // On the orienting call, and on any call when this session has not been
    // told for an hour. The second half is what reaches a session that was
    // already running when the mode was turned on: it read its instructions
    // before the mode existed and will not read them again.
    const second = READ_ONLY ? { on: false } : secondOpinionState();
    if (second.on && params.name !== "second_opinion" &&
        (params.name === "list_projects" || Date.now() - secondOpinionRemindedAt >= SECOND_OPINION_REMIND_MS)) {
      secondOpinionRemindedAt = Date.now();
      content.push({ type: "text", text: directives.secondOpinionReminder(second.label) });
    }
    return { content };
  }

  if (method === "ping") return {};
  throw new Error(`Unknown method ${method}`);
}

/**
 * Tells the client to re-read the tool list when the scratchpad setting changes.
 *
 * Tool descriptions carry the directive, and a client fetches them once at
 * startup. Without this, turning the setting on has no effect on an agent that is
 * already connected, which is the case that matters: someone flips the checkbox
 * because of what the agent is doing right now.
 *
 * The directory is watched rather than settings.json itself, because a settings
 * file is typically written by replacement and a watch on the old inode stops
 * firing. Only a real change in the effective state is announced, so an unrelated
 * write such as a theme change stays quiet.
 */
function watchSettings() {
  const settingsPath = SETTINGS_FILE;
  const effective = () => JSON.stringify([scratchpadState(), secondOpinionState()]);
  let previous = effective();
  let timer = null;

  try {
    fs.watch(path.dirname(settingsPath), (_event, filename) => {
      if (filename && String(filename) !== path.basename(settingsPath)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = effective();
        if (next === previous) return;
        previous = next;
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      }, 200);
    }).unref();
  } catch {
    // Not fatal. The setting still applies to every client that connects after
    // it was changed; only the live update is lost.
  }
}

let buffer = "";
// Requests still being answered. A client that writes its last request and
// closes stdin straight away is entitled to the answer, so the exit waits.
const inFlight = new Set();
// Decoded as a stream, not chunk by chunk. A pipe read can end in the middle of
// a multibyte character, and decoding each half alone stored "caf\u00e9" as two
// replacement characters.
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;

    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }

    const answered = handle(req).then(
      // Notifications have no id and must not be answered.
      (result) => { if (req.id !== undefined) send({ jsonrpc: "2.0", id: req.id, result }); },
      (error) => {
        if (req.id !== undefined) {
          send({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: String((error && error.message) || error) } });
        }
      }
    );
    inFlight.add(answered);
    answered.finally(() => inFlight.delete(answered));
  }
});

watchSettings();

process.stdin.on("end", () => {
  // Exit once the last answer has left, not merely been queued: a pipe on macOS
  // is written asynchronously, and process.exit does not wait for it.
  Promise.allSettled(Array.from(inFlight)).then(() => process.stdout.write("", () => process.exit(0)));
});
