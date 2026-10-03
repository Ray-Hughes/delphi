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
const path = require("path");
const fs = require("fs");
const os = require("os");

/** Where an installed copy keeps its data, worked out without Electron. */
function installedDatabase() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Delphi", "delphi.db");
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "Delphi", "delphi.db");
}

/**
 * Finds the database.
 *
 * A checkout keeps it beside the source, an installed copy keeps it in the
 * per-user data directory, and the same server file is used by both. This
 * duplicates paths.js on purpose, because that file ends up inside app.asar and a
 * plain Node process cannot read in there.
 *
 * The installed copy is preferred, and that ordering is the whole point. It used
 * to look beside the source first, on the reasoning that only a checkout has a
 * neighbouring database. True, but it assumed a checkout means you are *running*
 * from the checkout, and someone who has cloned the repository and also installed
 * the app has both. Their editor then registers the server by its path inside the
 * checkout, so the neighbour won, and the agent wrote to a database the app does
 * not read. Nothing errors: notes and tasks are written, and simply never appear.
 * Preferring the installed copy fixes it, and costs nothing for a developer
 * working purely from a checkout, who has no installed copy to prefer.
 *
 * DELPHI_DB still overrides both, which is the escape hatch for running the
 * server against a checkout on purpose.
 */
function findDatabase() {
  if (process.env.DELPHI_DB) return path.resolve(process.env.DELPHI_DB);

  const installed = installedDatabase();
  const beside = path.join(__dirname, "..", "delphi.db");

  if (fs.existsSync(installed)) {
    // Worth saying out loud. stderr goes to the client's MCP log rather than into
    // the protocol stream on stdout, so it cannot corrupt a response.
    if (fs.existsSync(beside)) {
      process.stderr.write(
        `delphi: two databases exist. Using the installed one at ${installed}. ` +
        `The checkout copy at ${beside} is being ignored. ` +
        `Set DELPHI_DB to override.\n`
      );
    }
    return installed;
  }

  if (fs.existsSync(beside)) return beside;
  return installed;
}

const DB = findDatabase();

const directives = require("./directives");
const readSettings = directives.makeSettingsReader(directives.settingsBesideDatabase(DB));

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
    return {
      kind: "node:sqlite",
      query(statement) {
        // all() rather than run() for everything. It returns rows for a SELECT
        // and an empty list for a write, which is exactly the shape the shelling
        // out version produced, so nothing downstream has to know which is in use.
        return handle.prepare(statement).all();
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
        const lines = [".timeout 5000", ".mode json", ".headers on", statement];
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
    };
  }
}

const DATABASE = openDatabase();

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

function sql(query, params = []) {
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

  return DATABASE.query(statement.endsWith(";") ? statement : statement + ";");
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
const sheets = makeSheetStore({ sql, actor: ACTOR, authorType: AUTHOR_TYPE });
// Run logs live beside the database, which is DATA_DIR in the app's terms, so
// they inherit its "never in git" rule.
const SHEET_LOG_DIR = path.join(path.dirname(DB), "sheets");

// Workbenches, from the same modules the app uses, for the same reason the
// Sheet store is shared. Setup commands run through sheet/run.js so they are
// guarded and recorded like any other `$ ` entry.
const { makeWorkbenchStore } = require("../workbench/store");
const { createWorkbench } = require("../workbench/workbench");
const { runEntry } = require("../sheet/run");
const benchStore = makeWorkbenchStore({ sql, actor: ACTOR });
const benches = createWorkbench({
  store: benchStore, sheet: sheets, runEntry, logDir: SHEET_LOG_DIR,
  settings: () => readSettings(),
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

const audit = (action, entity, entityId, summary, label) =>
  sql(
    `INSERT INTO audit (action, entity, entity_id, summary, label)
     VALUES (:p1, :p2, :p3, :p4, :p5)`,
    [action, entity, entityId, `${summary} (by ${ACTOR})`, label]
  );

// --- scratchpads -------------------------------------------------------------
//
// The row half of the pad tools. Twins of db.js the same way add_project is, and
// for the same reason: node:sqlite is not available here. The grammar is not
// duplicated, only the writes.

/** A pad by id, or by project and key, which is how an agent addresses one. */
function findPad(a) {
  if (a.id != null) return sql("SELECT * FROM scratchpads WHERE id = :p1", [Number(a.id)])[0] || null;
  if (!a.key) throw new Error("Pass either id, or project_id and key.");
  const projectId = resolveProjectId(a);
  if (projectId == null) throw new Error("Pass either id, or project_id and key.");
  return sql("SELECT * FROM scratchpads WHERE project_id = :p1 AND key = :p2",
             [projectId, String(a.key)])[0] || null;
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
      const sets = [];
      const values = [];
      const set = (column, value) => { values.push(value); sets.push(`${column} = :p${values.length}`); };
      if (current.title && current.title !== task.title) set("title", current.title);
      const status = pads.statusFor(current.done, task.status);
      if (status !== task.status) {
        set("status", status);
        sets.push(status === "done" ? "completed_at = datetime('now')" : "completed_at = NULL");
      }
      if (current.assignee && current.assignee !== task.assignee) set("assignee", current.assignee);
      if (current.priority && current.priority !== task.priority) set("priority", current.priority);
      if (parentId !== (task.parent_id ?? null)) set("parent_id", parentId);
      if (sets.length) {
        values.push(task.id);
        sql(`UPDATE tasks SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = :p${values.length}`, values);
        if (status !== task.status) {
          sql("INSERT INTO status_events (task_id, status, actor) VALUES (:p1, :p2, :p3)",
              [task.id, status, ACTOR]);
          audit("update", "task", task.id, `status ${task.status} to ${status}`, task.title);
        }
      }
    } else {
      // RETURNING rather than a second SELECT on last_insert_rowid(). On the
      // sqlite3 binary route every sql() call is its own process, and a new
      // connection's last_insert_rowid() is always 0, so every pad task filed
      // that way came back as undefined.
      task = sql(
        `INSERT INTO tasks (project_id, title, status, priority, assignee, parent_id, pad_id, source, completed_at)
         VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7, 'pad',
                 CASE WHEN :p3 = 'done' THEN datetime('now') END)
         RETURNING *`,
        [pad.project_id, current.title || "Untitled", current.done ? "done" : "todo",
         current.priority || "med", current.assignee || null, parentId, pad.id]
      )[0];
      sql("INSERT INTO status_events (task_id, status, actor) VALUES (:p1, :p2, :p3)",
          [task.id, task.status, ACTOR]);
      audit("create", "task", task.id, "read out of a pad", task.title);
    }

    sql("UPDATE tasks SET pad_id = :p1, external_key = :p2 WHERE id = :p3",
        [pad.id, `pad:${pad.id}:${task.id}`, task.id]);
    idByEntry.set(current.at, task.id);
    filed.push({ id: task.id, title: current.title, status: pads.statusFor(current.done, task.status) });

    if (current.taskId !== task.id) body = pads.anchorLine(body, current, task.id);
  }

  if (body !== pad.body) sql("UPDATE scratchpads SET body = :p1 WHERE id = :p2", [body, pad.id]);
  return { ...sql("SELECT * FROM scratchpads WHERE id = :p1", [pad.id])[0], tasks: filed };
}

// --- tools ------------------------------------------------------------------

const TOOLS = {
  list_projects: {
    description:
      "List every project with its open task count. Call this first to find the right project_id.",
    schema: { type: "object", properties: {} },
    run: () =>
      sql(`SELECT p.id, p.key, p.name, p.summary, p.status,
                  (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status != 'done') AS open_tasks,
                  (SELECT COUNT(*) FROM notes n WHERE n.project_id = p.id) AS notes
           FROM projects p WHERE p.status != 'archived' ORDER BY p.sort_order`),
  },

  add_project: {
    description:
      "Create a project. Use this when work does not belong to any existing project rather than filing it under General, so its tasks and notes have a home. Call list_projects first to check one does not already exist.",
    schema: {
      type: "object",
      required: ["key", "name"],
      properties: {
        key: { type: "string", description: "Short slug, e.g. co-hearing-address" },
        name: { type: "string" },
        summary: { type: "string", description: "One line: what this project is" },
        colour: { type: "string", description: "Accent for the sidebar dot, e.g. #4A90D9" },
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
      sql(
        `INSERT INTO projects (key, name, summary, colour, sort_order)
         VALUES (:p1, :p2, :p3, :p4, :p5)`,
        [key, a.name, a.summary ?? null, a.colour ?? null, below.next]
      );
      const row = sql("SELECT id, key, name, summary, status, sort_order FROM projects WHERE key = :p1", [key])[0];
      audit("create", "project", row.id, "created", row.name);
      return row;
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
      if (a.project_id != null) { params.push(a.project_id); where.push(`t.project_id = :p${params.length}`); }
      if (a.status) { params.push(a.status); where.push(`t.status = :p${params.length}`); }
      else if (!a.include_done) where.push("t.status != 'done'");
      return sql(
        `SELECT t.id, t.title, t.detail, t.status, t.priority, t.due, t.ref, p.name AS project
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY CASE t.status WHEN 'doing' THEN 0 WHEN 'blocked' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END,
                  CASE t.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, t.id DESC
         LIMIT 200`,
        params
      );
    },
  },

  add_task: {
    description:
      "Create a task. Use this whenever work is identified that will not be finished immediately, without waiting to be asked.",
    schema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        project_id: { type: "number" },
        detail: { type: "string", description: "Why it matters and how to verify it" },
        priority: { type: "string", enum: ["high", "med", "low"] },
        due: { type: "string", description: "YYYY-MM-DD" },
        ref: { type: "string", description: "Ticket or pull request reference" },
        parent_id: { type: "number", description: "Make this a subtask of that task" },
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
      const row = sql(
        `INSERT INTO tasks (project_id, title, detail, priority, due, ref, parent_id, source)
         VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7, :p8)
         RETURNING id, title`,
        [projectId, a.title, a.detail ?? null, a.priority || "med", a.due ?? null, a.ref ?? null, a.parent_id ?? null, ACTOR]
      )[0];
      sql("INSERT INTO status_events (task_id, status, actor) VALUES (:p1, 'todo', :p2)", [row.id, ACTOR]);
      audit("create", "task", row.id, "created", row.title);
      return row;
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
        project_id: { type: "number" },
        assignee: { type: "string", description: "Who is holding this. Your own actor name if you are taking it." },
      },
    },
    run: (a) => {
      const before = sql("SELECT * FROM tasks WHERE id = :p1", [a.id])[0];
      if (!before) throw new Error(`No task ${a.id}`);
      const fields = ["title", "detail", "status", "priority", "due", "project_id", "assignee"].filter((f) => a[f] !== undefined);
      if (!fields.length) return before;
      const params = fields.map((f) => a[f]);
      const sets = fields.map((f, i) => `${f} = :p${i + 1}`).join(", ");
      params.push(a.id);
      const done = a.status === "done" ? ", completed_at = datetime('now')" : a.status ? ", completed_at = NULL" : "";
      sql(`UPDATE tasks SET ${sets}, updated_at = datetime('now')${done} WHERE id = :p${params.length}`, params);
      const after = sql("SELECT * FROM tasks WHERE id = :p1", [a.id])[0];
      // The timeline should not be able to tell whether a person or an agent
      // moved a task, only who it was. Recorded here for the same reason the app
      // records it: so the history cannot disagree with the column.
      if (after.status !== before.status) {
        sql("INSERT INTO status_events (task_id, status, actor) VALUES (:p1, :p2, :p3)",
            [a.id, after.status, ACTOR]);
      }
      audit("update", "task", a.id, a.status ? `status to ${a.status}` : "updated", after.title);
      const notice = a.status === "done" ? workbenchNotice(a.id) : null;
      return notice ? { ...after, workbench: notice } : after;
    },
  },

  queue_next: {
    description:
      "Claim the next piece of work from the queue and get everything needed to do it. Call this when you are ready to work rather than waiting to be given something. Returns null when the queue is empty, which means there is nothing to do and you should stop rather than invent work. Pass project_id or project when you are only able to work on one project, for example because you are running in that project's checkout: without it you will be handed whatever is at the top of the pool, whichever project it belongs to.",
    schema: {
      type: "object",
      properties: {
        queue: { type: "string", description: "Which pool. Defaults to ready." },
        minutes: { type: "number", description: "How long to hold it before the claim lapses. Defaults to 30." },
        project_id: { type: "number", description: "Only take work from this project. Leave it out to take from any." },
        project: { type: "string", description: "The same thing by project key, if that is what you have." },
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
      const claimed = sql(
        `UPDATE tasks
            SET claimed_by = :p1,
                claim_expires = datetime('now', '+' || :p2 || ' minutes'),
                status = CASE WHEN status = 'todo' THEN 'doing' ELSE status END,
                updated_at = datetime('now')
          WHERE id = (
            SELECT id FROM tasks
             WHERE queue = :p3
               -- Blocked work is not available work: something outside the task
               -- is being waited on, and an agent given it can only hand it back.
               AND status NOT IN ('done', 'blocked')
               AND (claimed_by IS NULL OR claim_expires < datetime('now'))
               ${projectId == null ? "" : "AND project_id = :p4"}
             ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, id
             LIMIT 1)
          RETURNING *`,
        projectId == null ? [ACTOR, minutes, queue] : [ACTOR, minutes, queue, projectId]
      )[0];

      if (!claimed) {
        return {
          claimed: null,
          message: projectId == null
            ? `Nothing waiting in the ${queue} queue.`
            : `Nothing waiting in the ${queue} queue for project ${projectId}.`,
        };
      }

      // Only when the claim moved it. Nothing but todo is claimable, so this is
      // always a real transition rather than a repeat of the current status.
      if (claimed.status === "doing") {
        sql("INSERT INTO status_events (task_id, status, actor) VALUES (:p1, :p2, :p3)",
            [claimed.id, claimed.status, ACTOR]);
      }
      audit("update", "task", claimed.id, `claimed by ${ACTOR}`, claimed.title);

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
      "Give a claimed task back without finishing it. Always say why: the next agent reads that reason before starting, and an unexplained release is a task that gets picked up and abandoned again.",
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
      sql(`UPDATE tasks SET claimed_by = NULL, claim_expires = NULL,
             status = CASE WHEN status = 'doing' THEN 'todo' ELSE status END,
             updated_at = datetime('now') WHERE id = :p1`, [a.task_id]);
      // Promoted, because why the last agent gave up is the first thing the
      // next one needs, and the ledger is what it reads first.
      sql(`INSERT INTO comments (task_id, author, body, kind, author_type, promoted)
           VALUES (:p1, :p2, :p3, 'say', :p4, 1)`,
          [a.task_id, ACTOR, `Released: ${a.reason}`, AUTHOR_TYPE]);
      const after = sql("SELECT * FROM tasks WHERE id = :p1", [a.task_id])[0];
      if (after.status !== before.status) {
        sql("INSERT INTO status_events (task_id, status, actor) VALUES (:p1, :p2, :p3)",
            [a.task_id, after.status, ACTOR]);
      }
      audit("update", "task", a.task_id, `released by ${ACTOR}`, after.title);
      return after;
    },
  },

  queue_extend: {
    description:
      "Push your claim's expiry out because you are still working. A lease is short so a dead agent's task comes back quickly, which makes a slow but healthy agent the awkward case. Call this rather than letting the lease lapse: once it has, the task may already belong to someone else.",
    schema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "number" },
        minutes: { type: "number", description: "How much longer you need. Defaults to another full lease." },
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
      sql(`UPDATE tasks SET claim_expires = datetime('now', '+' || :p2 || ' minutes'),
             updated_at = datetime('now') WHERE id = :p1`, [a.task_id, minutes]);
      const after = sql("SELECT * FROM tasks WHERE id = :p1", [a.task_id])[0];
      audit("update", "task", a.task_id, `claim extended by ${ACTOR} to ${after.claim_expires}`, after.title);
      return after;
    },
  },

  queue_complete: {
    description:
      "Finish a claimed task. The summary is left as a comment and is what the next person or agent reads to know what actually happened, so write it for them rather than for a changelog. Your summary is promoted into the task's ledger automatically, so the next agent reads it first. If you learned something that matters beyond this task, sheet_file it.",
    schema: {
      type: "object",
      required: ["task_id", "summary"],
      properties: {
        task_id: { type: "number" },
        summary: { type: "string", description: "What you did, and anything the next person needs to know." },
      },
    },
    run: (a) => {
      const before = sql("SELECT * FROM tasks WHERE id = :p1", [a.task_id])[0];
      if (!before) throw new Error(`No task ${a.task_id}`);
      // Promoted, so every finished run lands in the ledger: it is the one
      // entry the next person or agent always wants.
      sql(`INSERT INTO comments (task_id, author, body, kind, author_type, promoted)
           VALUES (:p1, :p2, :p3, 'say', :p4, 1)`,
          [a.task_id, ACTOR, a.summary, AUTHOR_TYPE]);
      sql(`UPDATE tasks SET status = 'done', completed_at = datetime('now'),
             claimed_by = NULL, claim_expires = NULL, queue = NULL,
             updated_at = datetime('now') WHERE id = :p1`, [a.task_id]);
      if (before.status !== "done") {
        sql("INSERT INTO status_events (task_id, status, actor) VALUES (:p1, 'done', :p2)", [a.task_id, ACTOR]);
      }
      audit("update", "task", a.task_id, "status to done", before.title);
      const after = sql("SELECT * FROM tasks WHERE id = :p1", [a.task_id])[0];
      const notice = workbenchNotice(a.task_id);
      return notice ? { ...after, workbench: notice } : after;
    },
  },

  queue_status: {
    description: "What is waiting in the queue and what other agents are already holding. Read it before claiming if you want to know whether it is worth starting.",
    schema: {
      type: "object",
      properties: {
        queue: { type: "string" },
        project_id: { type: "number", description: "Only count work in this project. Leave it out for the whole pool." },
        project: { type: "string", description: "The same thing by project key." },
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
            WHERE queue = :p1 AND status NOT IN ('done', 'blocked')
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
      "Everything about one task: its detail, subtasks, the discussion on it, and every status it has been through. Read this before starting work on a task, because the last agent probably left you something. The discussion is the task's Sheet: its ledger (what was promoted as mattering) plus the last 20 entries, as entries in comments and as text in sheet. comments_total says how many there are in all; call sheet_read with mode full when you need the rest.",
    schema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "number" } },
    },
    run: (a) => {
      const task = sql("SELECT * FROM tasks WHERE id = :p1", [a.id])[0];
      if (!task) throw new Error(`No task ${a.id}`);
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
      "Leave a comment on a task. Use it for what you found, what you tried, and what you would do next, so the agent that picks this up after you does not start from nothing.",
    schema: {
      type: "object",
      required: ["task_id", "body"],
      properties: {
        task_id: { type: "number" },
        body: { type: "string", description: "Markdown. Be specific: an unread comment is better than a vague one." },
      },
    },
    run: (a) => {
      const task = sql("SELECT id, title FROM tasks WHERE id = :p1", [a.task_id])[0];
      if (!task) throw new Error(`No task ${a.task_id}`);
      if (!a.body || !String(a.body).trim()) throw new Error("A comment needs something in it");
      const row = sql(`INSERT INTO comments (task_id, author, body, kind, author_type)
                       VALUES (:p1, :p2, :p3, 'say', :p4) RETURNING *`,
                      [a.task_id, ACTOR, String(a.body).trim(), AUTHOR_TYPE])[0];
      audit("update", "task", a.task_id, "commented", task.title);
      return row;
    },
  },

  // --- the Sheet ---------------------------------------------------------------
  //
  // A task's Sheet is its comments, each with a kind. These tools never take an
  // author: every entry is DELPHI_ACTOR's, so History cannot be told otherwise.

  sheet_read: {
    description:
      "Read a task's Sheet: its entries as JSON and as text. mode tail (the default) is the last n entries, ledger is only what was promoted as mattering, full is everything. To poll, pass back the cursor you were given as after_id and since; you then get only entries that are new or changed, and should dedupe by id.",
    schema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "number" },
        mode: { type: "string", enum: ["ledger", "tail", "full"], description: "Defaults to tail." },
        n: { type: "number", description: "How many entries in tail mode. Defaults to 20, at most 500." },
        after_id: { type: "number", description: "Only entries with a higher id (or changed since `since`)." },
        since: { type: "string", description: "Server time from a previous cursor. Inclusive." },
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
    description: "One Sheet entry by its id, with its task id. For when you have an entry id and need what it says.",
    schema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
    run: (a) => sheets.get(a.id),
  },

  sheet_append: {
    description:
      "Write an entry on a task's Sheet. kind say is a remark or finding, note is a short marker of something that happened (a file edited, a deploy done), run records a shell command (one line) with meta {state, code, cwd, out}. Questions and answers have their own tools, sheet_ask and sheet_decide. " +
      PROMOTE_DIRECTIVE,
    schema: {
      type: "object",
      required: ["task_id", "kind", "body"],
      properties: {
        task_id: { type: "number" },
        kind: { type: "string", enum: ["say", "run", "note"] },
        body: { type: "string", description: "Markdown for say and note. The command itself for run." },
        meta: { type: "object", description: "Kind specific. For run: state (running, ok, fail), code, cwd, out." },
        ref_id: { type: "number", description: "An entry on the same task this one answers or follows." },
        promote: { type: "boolean", description: "Put it in the ledger, which every later agent reads first." },
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
      "Change an entry's meta, its body, or both. Meta is merged one level deep. This is how a run entry is finished: pass meta {state: ok or fail, code, dur_ms, lines}. An ask's options and a decision's choice cannot change.",
    schema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "number" },
        meta: { type: "object" },
        body: { type: "string" },
      },
    },
    run: (a) => sheets.update(a.id, { meta: a.meta, body: a.body }),
  },

  sheet_promote: {
    description:
      "Put an entry in its task's ledger (on: true, the default) or take it out. The ledger is what the next agent reads first, so promote what changes what they should do: a finding, a dead end, a decision.",
    schema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "number" }, on: { type: "boolean", description: "Defaults to true." } },
    },
    run: (a) => sheets.promote(a.id, a.on === undefined ? true : a.on),
  },

  sheet_file: {
    description:
      "Turn a Sheet entry into a project note (decision, gotcha, reference or note), so the graph and search find it from other tasks. Also promotes it. Filing twice returns the first note. Use it for anything that would matter on a different task.",
    schema: {
      type: "object",
      required: ["id", "kind"],
      properties: {
        id: { type: "number" },
        kind: { type: "string", enum: ["decision", "gotcha", "reference", "note"] },
        title: { type: "string", description: "Defaults to the entry's first line." },
      },
    },
    run: (a) => sheets.file(a.id, a.kind, a.title ?? null),
  },

  sheet_ask: {
    description:
      "Ask a question on a task's Sheet with two to four answers, keyed a to d. Use it when a person (or another agent) has to choose before work can go on. The question is one line; put background in a say entry first.",
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
      "Answer a question asked with sheet_ask. The decision is promoted into the ledger automatically, since it is what the next agent most needs. Say why when it is not obvious.",
    schema: {
      type: "object",
      required: ["ask_id", "choice"],
      properties: {
        ask_id: { type: "number" },
        choice: { type: "string", enum: ["a", "b", "c", "d"] },
        why: { type: "string" },
      },
    },
    run: (a) => sheets.decide(a.ask_id, a.choice, a.why ?? null),
  },

  sheet_resolve: {
    description:
      "Find a task from whatever you have: its id, its legacy id, or its ticket ref. Also says which folder a command for it should run in, and where run logs go.",
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
      "Give a task its own folder and branch to work in (a Workbench), so it cannot collide with any other task's work. Returns the folder's path: run your commands there. If the task already has one, that one is returned (created: false). The branch is named for the task; existing branches are reused. Setup (npm ci and the like) runs as a recorded command unless run_setup is false. Read warnings: they say when the remote could not be reached and the local copy was used.",
    schema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "number" },
        repo: { type: "string", description: "Which repository, by name or path, when the project has several and none is primary." },
        run_setup: { type: "boolean", description: "Defaults to true." },
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
      "Whether a task's Workbench has unsaved changes, commits not shared yet, or is behind its base branch, in words. Returns workbench null when the task has none.",
    schema: { type: "object", required: ["task_id"], properties: { task_id: { type: "number" } } },
    run: async (a) => {
      const wb = benchStore.live(a.task_id);
      if (!wb) return { workbench: null };
      return { workbench: wb, status: await benches.status(wb.id, { fresh: true }) };
    },
  },

  workbench_finish: {
    description:
      "Put a task's Workbench away once its work is committed and pushed: the folder is removed and the branch is kept. Refuses, saying why, when anything is unsaved (hidden changes included) or not pushed, when a rebase or merge is part way through, when there is a git repository inside the folder, or when the folder holds files git does not keep (an edited .env, notes in build/): removing those is a person's decision, so say in the Sheet what is there and leave it to them. It never forces and never stashes. There is no tool to throw a Workbench away either: that is a person's decision too.",
    schema: { type: "object", required: ["task_id"], properties: { task_id: { type: "number" } } },
    // No confirm here, on purpose: through this server Finish only goes
    // ahead when nothing at all would be removed that git does not keep.
    run: async (a) => {
      const done = await benches.finish(benchFor(a.task_id).id);
      return { finished: true, task_status: done.taskStatus, branch: done.branch, ref: done.ref || null, recover: done.recover || null };
    },
  },

  workbench_list: {
    description: "Live Workbenches (active, parked or missing), with status in words. Pass project_id or project to narrow to one project.",
    schema: {
      type: "object",
      properties: { project_id: { type: "number" }, project: { type: "string" } },
    },
    run: (a) => benches.list({ projectId: resolveProjectId(a) }),
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
      "Store something worth remembering against a project: a decision and why, a gotcha, a reference. Use this for anything a future session would otherwise have to rediscover. Prefer this over leaving knowledge only in chat.",
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
      const row = sql(`INSERT INTO notes (project_id, title, body, kind) VALUES (:p1, :p2, :p3, :p4)
                       RETURNING id, title`,
                      [a.project_id, a.title, a.body, a.kind || "note"])[0];
      audit("create", "note", row.id, "created", row.title);
      return row;
    },
  },

  list_scratchpads: {
    description:
      "List the scratchpads in a project: the working documents, with their keys. Call this before writing one, so you add to the existing plan rather than starting a second one beside it.",
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
        `SELECT id, project_id, key, title, author, derives_tasks, updated_at,
                length(body) AS size
         FROM scratchpads
         ${projectId ? "WHERE project_id = :p1" : ""}
         ORDER BY pinned DESC, updated_at DESC LIMIT 100`,
        projectId ? [projectId] : []
      );
    },
  },

  read_scratchpad: {
    description:
      "Read a scratchpad in full, by id or by project and key. This is how you pick up what the last session, or another agent, was in the middle of.",
    schema: {
      type: "object",
      properties: {
        id: { type: "number" },
        project_id: { type: "number" },
        key: { type: "string" },
      },
    },
    run: (a) => {
      const pad = findPad(a);
      if (!pad) throw new Error("No such scratchpad. Call list_scratchpads to see them.");
      return pad;
    },
  },

  write_scratchpad: {
    description:
      "Write a scratchpad: the working document for a piece of work. Plans, findings, handover notes, what you tried and what it did. Creates it if the key is new, replaces the body if it is not.\n\n" +
      "Checkbox lines become real tasks on the board, kept in step in both directions:\n" +
      "  - [ ] wire the codex adapter @ray !high\n" +
      "  - [x] a finished one\n" +
      "    - [ ] an indented one is a subtask\n" +
      "So write the plan as checkboxes and the board follows. Do not also call add_task for the same work.\n\n" +
      "Delphi adds an <!--d:123--> marker to each line it has filed. Leave those in place when you edit around them: they are how a line and its task stay the same thing. If you drop them, the lines are matched back up by their exact text.\n\n" +
      "Prefer append_scratchpad or patch_scratchpad when you are adding to a pad another agent may also be writing.",
    schema: {
      type: "object",
      required: ["title", "body"],
      properties: {
        project_id: { type: "number" },
        project: { type: "string", description: "Project key, as an alternative to project_id" },
        key: { type: "string", description: "Short slug to address this pad by later. Defaults to the title." },
        title: { type: "string" },
        body: { type: "string", description: "Markdown. Checkbox lines become tasks." },
        derives_tasks: {
          type: "boolean",
          description: "False for a sketch full of options nobody has agreed to yet. Defaults to true.",
        },
      },
    },
    run: (a) => {
      const projectId = a.project_id ?? resolveProjectId(a);
      const key = padKeyFor(projectId, a.key || a.title);
      const existing = sql("SELECT * FROM scratchpads WHERE project_id = :p1 AND key = :p2",
                           [projectId, key])[0];
      if (existing) {
        sql(`UPDATE scratchpads SET title = :p1, body = :p2, author = :p3,
             derives_tasks = :p4, updated_at = datetime('now') WHERE id = :p5`,
            [a.title, a.body, ACTOR, a.derives_tasks === false ? 0 : existing.derives_tasks, existing.id]);
        audit("update", "scratchpad", existing.id, "wrote to the pad", a.title);
        return derivePad(existing.id);
      }
      sql(`INSERT INTO scratchpads (project_id, key, title, body, author, derives_tasks)
           VALUES (:p1, :p2, :p3, :p4, :p5, :p6)`,
          [projectId, key, a.title, a.body, ACTOR, a.derives_tasks === false ? 0 : 1]);
      const row = sql("SELECT id FROM scratchpads WHERE project_id = :p1 AND key = :p2",
                      [projectId, key])[0];
      audit("create", "scratchpad", row.id, "created", a.title);
      return derivePad(row.id);
    },
  },

  append_scratchpad: {
    description:
      "Add to the end of a scratchpad without reading it first. The safe write when another agent may be working the same pad: it cannot overwrite what they added.",
    schema: {
      type: "object",
      required: ["text"],
      properties: {
        id: { type: "number" },
        project_id: { type: "number" },
        key: { type: "string" },
        text: { type: "string", description: "Markdown to add. Checkbox lines become tasks." },
      },
    },
    run: (a) => {
      const pad = findPad(a);
      if (!pad) throw new Error("No such scratchpad. Call list_scratchpads to see them.");
      const joiner = !pad.body || pad.body.endsWith("\n") ? "" : "\n";
      sql("UPDATE scratchpads SET body = :p1, author = :p2, updated_at = datetime('now') WHERE id = :p3",
          [`${pad.body}${joiner}${a.text}`, ACTOR, pad.id]);
      audit("update", "scratchpad", pad.id, "added to the pad", pad.title);
      return derivePad(pad.id);
    },
  },

  patch_scratchpad: {
    description:
      "Replace one section of a scratchpad, found by its markdown heading. Use this to update your own part of a shared pad without touching anyone else's. The section is added at the end if the heading is not there yet.",
    schema: {
      type: "object",
      required: ["heading", "text"],
      properties: {
        id: { type: "number" },
        project_id: { type: "number" },
        key: { type: "string" },
        heading: { type: "string", description: "The heading text, without the leading hashes" },
        text: { type: "string", description: "What the section should now say" },
      },
    },
    run: (a) => {
      const pad = findPad(a);
      if (!pad) throw new Error("No such scratchpad. Call list_scratchpads to see them.");
      sql("UPDATE scratchpads SET body = :p1, author = :p2, updated_at = datetime('now') WHERE id = :p3",
          [patchSection(pad.body, a.heading, a.text), ACTOR, pad.id]);
      audit("update", "scratchpad", pad.id, `rewrote "${a.heading}"`, pad.title);
      return derivePad(pad.id);
    },
  },

  handoff_send: {
    description:
      "Hand a piece of work to another agent. Use this when something is better done by a different tool, or by a second opinion: \"have Codex review this branch\", \"ask Claude to write the migration\".\n\n" +
      "It returns immediately with a handoff id. Delphi runs the request in that agent's own session in this project, keeps the reply, and gives you a turn of your own with the answer when it lands. So do not wait, do not poll in a loop, and do not sleep: finish what you were doing and say you have handed it over. You will be woken.\n\n" +
      "Call list_agents first if you are not sure which agents this machine has.",
    schema: {
      type: "object",
      required: ["to", "request"],
      properties: {
        to: { type: "string", description: "The agent's key, e.g. codex, claude-code, copilot" },
        request: { type: "string", description: "What you want done, written for them rather than for a log" },
        project_id: { type: "number" },
        project: { type: "string", description: "Project key, as an alternative to project_id" },
        task_id: { type: "number", description: "The task this is about, if there is one" },
        context: {
          type: "object",
          description: "Branch, files, pad ids: whatever they will need and cannot work out",
        },
        wake: {
          type: "boolean",
          description: "Whether you want a turn when the reply lands. True unless you are handing something over and leaving.",
        },
      },
    },
    run: (a) => {
      const projectId = a.project_id ?? resolveProjectId(a);
      if (projectId == null) throw new Error("A handoff needs a project. Pass project_id or project.");
      const target = sql("SELECT key, label, enabled FROM harnesses WHERE key = :p1", [String(a.to)])[0];
      if (!target) {
        const known = sql("SELECT key FROM harnesses WHERE enabled = 1").map((r) => r.key).join(", ");
        throw new Error(`No agent called '${a.to}'. This machine has: ${known || "none configured"}.`);
      }
      if (!target.enabled) throw new Error(`${target.label} is turned off in Delphi's settings.`);

      // RETURNING for the reason derivePad gives: on the binary route a fresh
      // connection's last_insert_rowid() is 0, and this returned nothing.
      const row = sql(
        `INSERT INTO handoffs (project_id, from_session_id, to_harness, task_id, request, context_json, wake)
         VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7)
         RETURNING *`,
        [
          projectId,
          // Set by whatever launched this server. A handoff from a tab knows
          // which tab it came from and can be woken; one from an editor's own
          // MCP client does not, and simply has nobody to wake.
          process.env.DELPHI_SESSION ? Number(process.env.DELPHI_SESSION) : null,
          String(a.to), a.task_id ?? null, String(a.request),
          a.context ? JSON.stringify(a.context) : null,
          a.wake === false ? 0 : 1,
        ]
      )[0];
      audit("create", "handoff", row.id, `asked ${row.to_harness}`, row.request.slice(0, 80));
      return {
        ...row,
        note: "Queued. Delphi will run it and wake you with the reply. Do not wait for it here.",
      };
    },
  },

  handoff_status: {
    description:
      "What has been handed to and from you, and where each one got to. Use this when you have come back to a session and want to know whether an answer arrived while you were away.",
    schema: {
      type: "object",
      properties: {
        id: { type: "number", description: "One handoff, in full, including the reply" },
        project_id: { type: "number" },
        project: { type: "string" },
      },
    },
    run: (a) => {
      if (a.id != null) {
        const row = sql("SELECT * FROM handoffs WHERE id = :p1", [Number(a.id)])[0];
        if (!row) throw new Error("No such handoff");
        return row;
      }
      const projectId = a.project_id ?? resolveProjectId(a);
      const session = process.env.DELPHI_SESSION ? Number(process.env.DELPHI_SESSION) : null;
      return sql(
        `SELECT id, from_session_id, to_harness, status, request, reply, created_at, finished_at
         FROM handoffs
         WHERE ${projectId != null ? "project_id = :p1" : "1 = :p1"}
         ORDER BY id DESC LIMIT 25`,
        [projectId != null ? projectId : 1]
      ).map((h) => ({ ...h, mine: session != null && h.from_session_id === session }));
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
      "Take a lease on something, so another agent working the same project does not touch it at the same time. Use it for a file two of you are editing, a migration, a branch, a dev server.\n\n" +
      "A lease, not a lock: it expires, because an agent that takes one and dies must not hold it forever. Extend it by calling again with the same key and holder. Check the answer: held false means somebody else has it and says who.",
    schema: {
      type: "object",
      required: ["key"],
      properties: {
        key: { type: "string", description: "What is being held, e.g. db/schema.sql or migration" },
        project_id: { type: "number" },
        project: { type: "string" },
        note: { type: "string", description: "What you are doing with it, for whoever finds it held" },
        minutes: { type: "number", description: "How long you need it. 15 by default." },
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
    description: "Give back a lease you took. Do this as soon as you are done rather than letting it expire.",
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
    description: "What is currently held in a project, and by whom. Expired leases are cleared rather than reported.",
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

  timer_set: {
    description:
      "Ask to be given a turn later. Use this instead of waiting: for a build you have started, a deploy, anything that finishes on its own clock.\n\n" +
      "Only works from inside a Delphi agent tab, because there has to be a session to wake. Waiting in a loop instead burns tokens for no reason and stops the moment your turn ends.",
    schema: {
      type: "object",
      required: ["minutes", "message"],
      properties: {
        minutes: { type: "number", description: "How long from now" },
        message: { type: "string", description: "What to tell you when you wake, in enough detail to carry on" },
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

  search: {
    description:
      "Search tasks and memory notes. Check here before searching a repository: a previous session may have already worked out the answer.",
    schema: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
    run: (a) => {
      const like = `%${a.query}%`;
      return {
        tasks: sql(
          `SELECT t.id, t.title, t.status, p.name AS project FROM tasks t
           LEFT JOIN projects p ON p.id = t.project_id
           WHERE t.title LIKE :p1 OR t.detail LIKE :p1 OR t.ref LIKE :p1 LIMIT 30`, [like]),
        notes: sql(
          `SELECT n.id, n.title, n.kind, n.body, p.name AS project FROM notes n
           LEFT JOIN projects p ON p.id = n.project_id
           WHERE n.title LIKE :p1 OR n.body LIKE :p1 LIMIT 30`, [like]),
      };
    },
  },

  oracle_context: {
    description:
      "Everything connected to a thing: a ticket, service, repository, file or concept. Returns the notes and tasks that mention it, the projects it spans, and the entities it appears alongside. Use this before reading a repository: it answers 'what do we already know about X' in one call, including connections nobody wrote down explicitly.",
    schema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", description: "e.g. deploy pipeline, auth service, PROJ-1234, billing API" } },
    },
    run: (a) => {
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

  oracle_entities: {
    description:
      "List the things the graph knows about, most referenced first. Useful for orienting at the start of a session, or finding the exact name to pass to oracle_context.",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["ticket", "pr", "repo", "service", "file", "person", "env", "concept"] },
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
      "The main way to ask what we know. Combines meaning and connections: finds text that means something similar even with no words in common, then expands through the graph to what those things are connected to. Prefer this over reading a repository, and over plain search when you are not sure of the exact words.",
    schema: {
      type: "object",
      required: ["question"],
      properties: {
        question: { type: "string" },
        limit: { type: "number", description: "How many results, default 8" },
      },
    },
    run: (a) => {
      // Semantic scoring needs the vector runtime, which this process does not
      // have, so it delegates to the app's helper. Lexical and graph results are
      // produced here so the tool still answers when that is unavailable.
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

      // Expand through the graph: entities mentioned by the best matches, and
      // what those entities travel with. This is the part plain search cannot do.
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
        note: "Lexical and graph results. For meaning-based ranking the app exposes oracle.nearest; this tool covers what is reachable without the vector runtime.",
        tasks, notes, connected,
      };
    },
  },

  recent_activity: {
    description: "What changed recently, and who changed it. Useful for picking up where another agent left off.",
    schema: { type: "object", properties: { limit: { type: "number" } } },
    run: (a) =>
      sql(`SELECT at, action, entity, entity_id, summary, label, undone
           FROM audit ORDER BY id DESC LIMIT :p1`, [Math.min(a.limit || 30, 200)]),
  },
};

// Callable only by the delphi command line, and not listed. See the comment
// above workbench_park.
const INTERNAL_TOOLS = new Set([
  "workbench_park", "workbench_resume", "workbench_update", "workbench_commit", "workbench_push",
  "workbench_pr", "workbench_finish_plan", "workbench_finished", "workbench_busy", "workbench_closing", "workbench_discarded", "workbench_recreate",
  "workbench_forget", "workbench_housekeep", "workbench_advanced",
]);
const CLI_CLIENT = process.env.DELPHI_CLIENT === "delphi-cli";

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
    const scratchpad = scratchpadState();
    return {
      protocolVersion: "2024-11-05",
      // listChanged, because the scratchpad setting rewrites tool descriptions.
      // Without it a client caches the list from startup and the toggle does
      // nothing until the agent is restarted.
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "brain", version: "1.0.0" },
      ...(scratchpad.on
        ? { instructions: directives.scratchpadInstructions(scratchpad.project) }
        : {}),
    };
  }

  if (method === "tools/list") {
    const scratchpad = scratchpadState();
    const suffix = scratchpad.on ? directives.scratchpadToolNote(scratchpad.project) : "";
    return {
      tools: Object.entries(TOOLS).filter(([name]) => !INTERNAL_TOOLS.has(name)).map(([name, t]) => ({
        name,
        description: t.description + (suffix && SCRATCHPAD_TOOLS.has(name) ? suffix : ""),
        inputSchema: t.schema,
      })),
    };
  }

  if (method === "tools/call") {
    const tool = TOOLS[params.name];
    if (!tool || (INTERNAL_TOOLS.has(params.name) && !CLI_CLIENT)) throw new Error(`Unknown tool ${params.name}`);
    const result = await tool.run(params.arguments || {});
    const content = [{ type: "text", text: JSON.stringify(result, null, 2) }];

    // The last word, and the one an agent is most likely to act on, because it
    // arrives while it is already working rather than at startup. Only on
    // list_projects: that is the orienting call, and repeating this on every
    // result would train the model to skip it.
    const scratchpad = scratchpadState();
    if (scratchpad.on && params.name === "list_projects") {
      content.push({ type: "text", text: directives.scratchpadReminder(scratchpad.project) });
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
  const settingsPath = directives.settingsBesideDatabase(DB);
  let previous = JSON.stringify(scratchpadState());
  let timer = null;

  try {
    fs.watch(path.dirname(settingsPath), (_event, filename) => {
      if (filename && String(filename) !== path.basename(settingsPath)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = JSON.stringify(scratchpadState());
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
