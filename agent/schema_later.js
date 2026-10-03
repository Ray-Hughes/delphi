/**
 * Everything the schema gained after a database was first created.
 *
 * schema.sql stays idempotent because everything in it is CREATE ... IF NOT
 * EXISTS, but SQLite has no ADD COLUMN IF NOT EXISTS, so a new column on an
 * existing table cannot live there alone. Rather than bring in a migration
 * framework and a version table for what has so far only ever been added
 * columns, each one is named here and applied when it is missing. Every column
 * here is also declared in schema.sql, so a fresh database gets it from there
 * and this finds nothing to do.
 *
 * This used to live in db.js, which meant it only ever ran inside Electron. The
 * MCP server never migrated anything, so an agent could meet a database the app
 * had not opened since an upgrade and fail on a column that did not exist yet.
 * It is its own file so both can run it: no dependencies, no node:sqlite, just a
 * query function handed in by whichever side is calling.
 *
 * That function takes ONE statement per call. The server's node:sqlite route
 * runs prepare(text).all(), and prepare silently ignores everything after the
 * first statement, so a script handed to it would apply its first line and
 * report success.
 */

const LATER_COLUMNS = [
  ["tasks", "parent_id", "INTEGER REFERENCES tasks(id) ON DELETE CASCADE"],
  ["tasks", "assignee", "TEXT"],
  ["projects", "task_view", "TEXT NOT NULL DEFAULT 'list'"],
  ["tasks", "queue", "TEXT"],
  ["tasks", "claimed_by", "TEXT"],
  ["tasks", "claim_expires", "TEXT"],
  // Names a table schema.sql has not created yet, which is legal: SQLite
  // resolves foreign key targets when a row is written, not when the column is
  // declared, and the CREATE TABLE lands a few statements later in the same open.
  ["tasks", "organizer_id", "INTEGER REFERENCES organizers(id) ON DELETE SET NULL"],
  ["tasks", "external_key", "TEXT"],
  ["comments", "external_key", "TEXT"],
  ["organizers", "external_key", "TEXT"],
  ["tasks", "colour", "TEXT"],
  // A project is a folder now. Added here as well as in schema.sql because an
  // existing database already has the table and never re-runs the CREATE.
  ["projects", "path", "TEXT"],
  ["projects", "icon", "TEXT"],
  // A session runs somewhere. A project spanning four repos cannot tell an
  // agent which folder to work in without this.
  ["sessions", "workspace_id", "INTEGER REFERENCES workspaces(id) ON DELETE SET NULL"],
  // Whether the agent may use tools without asking. Off by default, and
  // deliberately per session: it is the difference between something that talks
  // and something that edits your files.
  ["sessions", "auto_allow", "INTEGER NOT NULL DEFAULT 0"],
  // The pad this task was read out of, when it was read out of one. Nullable
  // because a task typed into the board is not derived from anything, and SET
  // NULL because deleting the working document must not delete the work.
  ["tasks", "pad_id", "INTEGER REFERENCES scratchpads(id) ON DELETE SET NULL"],
  // A session can now be somebody else's agent rather than the built-in chat.
  ["sessions", "harness", "TEXT"],
  ["sessions", "native_id", "TEXT"],
  ["sessions", "cwd", "TEXT"],
  ["sessions", "run_state", "TEXT NOT NULL DEFAULT 'idle'"],
  ["sessions", "last_run_at", "TEXT"],
  // What this row looked like when Delphi last seeded it, so seedHarnesses can
  // tell a definition nobody has touched from one somebody has edited.
  ["harnesses", "seeded_json", "TEXT"],
  // Alerts grew a second job. A reminder is a person being nudged about a task;
  // a timer is a session being woken about something that finished while it was
  // not running. Same table because they are the same mechanism, and there is
  // already one sweep that fires due rows every minute.
  ["alerts", "session_id", "INTEGER REFERENCES sessions(id) ON DELETE CASCADE"],
  ["alerts", "kind", "TEXT NOT NULL DEFAULT 'reminder'"],
  ["alerts", "payload", "TEXT"],
  // A comment is now an entry on the task's Sheet. Every existing comment was a
  // remark, so 'say' is the honest default and old rows need no backfill.
  ["comments", "kind", "TEXT NOT NULL DEFAULT 'say'"],
  // Null means work it out from the author's name. Stored only when the writer
  // knows for certain, because a guess written down stops looking like a guess.
  ["comments", "author_type", "TEXT"],
  ["comments", "meta", "TEXT"],
  ["comments", "promoted", "INTEGER NOT NULL DEFAULT 0"],
  // SET NULL on both, and a default of NULL, which SQLite insists on for a
  // column added with a REFERENCES clause while foreign keys are on.
  ["comments", "ref_id", "INTEGER REFERENCES comments(id) ON DELETE SET NULL"],
  ["comments", "note_id", "INTEGER REFERENCES notes(id) ON DELETE SET NULL"],
  // Per repository Workbench settings. Null means "not decided yet, detect it",
  // which is a different thing from an empty string that a person typed.
  ["repos", "base_branch", "TEXT"],
  ["repos", "setup_cmd", "TEXT"],
  ["repos", "copy_files", "TEXT"],
];

// The same text as schema.sql. A table is created here too, rather than left to
// the app, because the MCP server never runs schema.sql and an agent may start a
// Workbench on a database the app has not opened since the upgrade.
const LATER_TABLES = [
  ["workbenches", `CREATE TABLE IF NOT EXISTS workbenches (
  id          INTEGER PRIMARY KEY,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  branch      TEXT NOT NULL,
  base        TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'active',
  owner       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at   TEXT
)`],
];

// [name, table, columns the index needs, statement]. The columns are checked
// because an index on a column that does not exist yet is an error, and a table
// this file could not widen (a failed ALTER) should cost one index, not the run.
const LATER_INDEXES = [
  ["idx_comments_ledger", "comments", ["task_id", "promoted"],
   "CREATE INDEX IF NOT EXISTS idx_comments_ledger ON comments(task_id, promoted)"],
  ["idx_workbenches_task", "workbenches", ["task_id", "state"],
   "CREATE INDEX IF NOT EXISTS idx_workbenches_task ON workbenches(task_id, state)"],
  // Missing counts as live in both. A Missing row is still the task's Workbench
  // until someone picks Recreate or Forget, and letting Start make a second one
  // beside it is how one branch ends up in two rows.
  ["idx_workbenches_live", "workbenches", ["task_id", "repo_id", "state"],
   "CREATE UNIQUE INDEX IF NOT EXISTS idx_workbenches_live ON workbenches(task_id, repo_id) " +
   "WHERE state IN ('active', 'parked', 'missing')"],
  ["idx_workbenches_path", "workbenches", ["path", "state"],
   "CREATE UNIQUE INDEX IF NOT EXISTS idx_workbenches_path ON workbenches(path) " +
   "WHERE state IN ('active', 'parked', 'missing')"],
];

// Table names go into PRAGMA text, which cannot take a bound parameter. They
// only ever come from the lists above, but a name that is not a plain word is
// refused rather than trusted, so a typo here cannot become a quoting problem.
const plainName = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Not a table name: ${name}`);
  return name;
};

/** The column names of a table, or [] when it does not exist. Both routes agree on that. */
function columnsOf(query, table) {
  return (query(`PRAGMA table_info(${plainName(table)})`) || []).map((c) => c.name);
}

function hasTable(query, name) {
  return columnsOf(query, name).length > 0;
}

/**
 * Adds every missing column. Returns "table.column" for each one added.
 *
 * Throws on the first failure, for db.js's sake, which has always treated a
 * database it cannot bring up to date as one it cannot open. apply() is the
 * forgiving version.
 */
function addLaterColumns(query) {
  const added = [];
  for (const [table, column, definition] of LATER_COLUMNS) {
    const columns = columnsOf(query, table);
    // No rows means the table does not exist yet, which is a brand new database.
    // schema.sql is about to create it with the column already in place.
    if (!columns.length || columns.includes(column)) continue;
    query(`ALTER TABLE ${plainName(table)} ADD COLUMN ${column} ${definition}`);
    added.push(`${table}.${column}`);
  }
  return added;
}

/**
 * Every table's columns in one query, as Map(table -> [column]).
 *
 * One query rather than a PRAGMA per table because the server's sqlite3 route
 * starts a process per statement, and this runs every time an agent tab starts
 * a server. Forty processes to learn that nothing needs doing was a visible
 * pause; this is one.
 */
function allColumns(query) {
  const map = new Map();
  const rows = query(
    "SELECT m.name AS tbl, p.name AS col FROM sqlite_master AS m, pragma_table_info(m.name) AS p " +
    "WHERE m.type = 'table' ORDER BY m.name, p.cid"
  ) || [];
  for (const row of rows) {
    if (!map.has(row.tbl)) map.set(row.tbl, []);
    map.get(row.tbl).push(row.col);
  }
  return map;
}

/**
 * Brings a database up to date, one statement at a time, and never throws.
 *
 * Columns, then tables, then indexes, because each step needs the one before.
 * Failures are collected rather than raised: the MCP server writes them to
 * stderr and keeps serving, since an agent that cannot start at all is worse
 * than one that is missing a column it may never touch.
 *
 * The later tables are only created in a file that already holds Delphi's
 * tables. A server pointed at an empty or mistaken path should not leave a lone
 * workbenches table in it; schema.sql creates it with everything else when the
 * app first opens the file.
 */
function apply(query) {
  const result = { added: [], created: [], indexed: [], errors: [] };
  const attempt = (statement, fn) => {
    try {
      return fn();
    } catch (error) {
      result.errors.push({ statement, message: String((error && error.message) || error) });
      return undefined;
    }
  };

  const LOOK = "SELECT ... FROM sqlite_master, pragma_table_info(name)";
  let columns = attempt(LOOK, () => allColumns(query));
  if (!columns) return result;

  const altered = [];
  for (const [table, column, definition] of LATER_COLUMNS) {
    const have = columns.get(table);
    // No table means a brand new database: schema.sql is about to create it
    // with the column already in place.
    if (!have || have.includes(column)) continue;
    const statement = `ALTER TABLE ${plainName(table)} ADD COLUMN ${column} ${definition}`;
    attempt(statement, () => {
      query(statement);
      have.push(column);
      altered.push([table, column, statement]);
    });
  }

  if (columns.has("tasks")) {
    for (const [name, statement] of LATER_TABLES) {
      if (columns.has(name)) continue;
      attempt(statement, () => {
        query(statement);
        altered.push([name, null, statement]);
      });
    }
  }

  // Checked rather than assumed, once, after every change. A route that
  // swallowed a statement would otherwise report a column that is not there.
  if (altered.length) {
    columns = attempt(LOOK, () => allColumns(query)) || new Map();
    for (const [table, column, statement] of altered) {
      const have = columns.get(table);
      if (column === null) {
        if (have) result.created.push(table);
        else result.errors.push({ statement, message: "the table is still missing after CREATE TABLE" });
      } else if (have && have.includes(column)) {
        result.added.push(`${table}.${column}`);
      } else {
        result.errors.push({ statement, message: "the column is still missing after ALTER TABLE" });
      }
    }
  }

  const existing = attempt("SELECT name FROM sqlite_master WHERE type = 'index'", () =>
    new Set((query("SELECT name FROM sqlite_master WHERE type = 'index'") || []).map((r) => r.name)));
  if (!existing) return result;
  for (const [name, table, needs, statement] of LATER_INDEXES) {
    const have = columns.get(table);
    if (!have || !needs.every((c) => have.includes(c)) || existing.has(name)) continue;
    attempt(statement, () => {
      query(statement);
      result.indexed.push(name);
    });
  }

  return result;
}

module.exports = { LATER_COLUMNS, LATER_TABLES, LATER_INDEXES, apply, addLaterColumns, hasTable, columnsOf, allColumns };
