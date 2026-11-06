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
  // 1 when setup_cmd holds what Delphi detected from the lock files, 0 once a
  // person has set it, so Settings can say which it is showing.
  ["repos", "setup_cmd_detected", "INTEGER NOT NULL DEFAULT 0"],
  // What git said about a project's folder: see schema.sql.
  ["repos", "remote_url", "TEXT"],
  ["repos", "default_branch", "TEXT"],
  // A Finish or Discard in progress (state 'closing'). See schema.sql.
  ["workbenches", "closing_mode", "TEXT"],
  ["workbenches", "closing_ref", "TEXT"],
  ["workbenches", "closing_trash", "TEXT"],
  ["workbenches", "closing_at", "TEXT"],
  ["workbenches", "closing_actor", "TEXT"],
  // A handoff became a job: agent/jobs.js. See schema.sql for each column.
  ["handoffs", "kind", "TEXT NOT NULL DEFAULT 'ask'"],
  ["handoffs", "state", "TEXT"],
  ["handoffs", "source", "TEXT NOT NULL DEFAULT 'handoff'"],
  ["handoffs", "requested_by", "TEXT"],
  ["handoffs", "requester_type", "TEXT"],
  ["handoffs", "approval", "TEXT"],
  ["handoffs", "approved_by", "TEXT"],
  ["handoffs", "approved_at", "TEXT"],
  ["handoffs", "actor", "TEXT"],
  ["handoffs", "workbench_id", "INTEGER REFERENCES workbenches(id) ON DELETE SET NULL"],
  ["handoffs", "cwd", "TEXT"],
  ["handoffs", "runner_pid", "INTEGER"],
  ["handoffs", "runner_host", "TEXT"],
  ["handoffs", "agent_pid", "INTEGER"],
  ["handoffs", "native_session", "TEXT"],
  ["handoffs", "unguarded", "INTEGER NOT NULL DEFAULT 0"],
  ["handoffs", "tokens_in", "INTEGER"],
  ["handoffs", "tokens_out", "INTEGER"],
  ["handoffs", "cost_usd", "REAL"],
  ["handoffs", "last_activity", "TEXT"],
  ["handoffs", "followup", "TEXT"],
  ["handoffs", "harness_hash", "TEXT"],
  // A command a person trusted, as it was when they did. See schema.sql.
  ["harnesses", "trusted_command", "TEXT"],
  ["handoffs", "turns", "INTEGER NOT NULL DEFAULT 0"],
  ["handoffs", "updated_at", "TEXT"],
  // Reviewing a finished job, ordering queued ones, and Copilot's premium
  // requests. See schema.sql.
  ["handoffs", "reviewed_at", "TEXT"],
  ["handoffs", "reviewed_by", "TEXT"],
  ["handoffs", "review", "TEXT"],
  ["handoffs", "review_note", "TEXT"],
  ["handoffs", "queue_rank", "INTEGER"],
  ["handoffs", "premium_requests", "REAL"],
  // A person's per project say over what agents may do there unasked.
  ["projects", "auto_approve", "INTEGER NOT NULL DEFAULT 0"],
  ["projects", "allow_unguarded", "INTEGER NOT NULL DEFAULT 0"],
  // Who queued a task, so a job an agent queued waits for a person.
  ["tasks", "queued_by", "TEXT"],
  ["tasks", "queued_by_type", "TEXT"],
  // Who made each change, as columns. Older rows keep only the suffix on their
  // summary and are left as they are (owner decision S6). See agent/audit.js.
  ["audit", "actor", "TEXT"],
  ["audit", "actor_type", "TEXT"],
  ["audit", "session_id", "INTEGER"],
  ["audit", "job_id", "INTEGER"],
  ["audit", "step", "TEXT"],
  ["comments", "session_id", "INTEGER"],
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
  closed_at   TEXT,
  closing_mode  TEXT,
  closing_ref   TEXT,
  closing_trash TEXT,
  closing_at    TEXT,
  closing_actor TEXT
)`],
  // The file's identity. See agent/identity.js, which mints the id once this
  // table exists.
  ["meta", `CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
)`],  // Cross-project items: flags first, because the other two name it. See
  // schema.sql and items/store.js.
  ["item_flags", `CREATE TABLE IF NOT EXISTS item_flags (
  id              INTEGER PRIMARY KEY,
  entity          TEXT NOT NULL,
  entity_id       INTEGER NOT NULL,
  project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  label           TEXT,
  note            TEXT NOT NULL DEFAULT '',
  evidence        TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  source          TEXT NOT NULL DEFAULT 'person',
  created_by      TEXT,
  created_by_type TEXT,
  run_id          INTEGER,
  proposal        TEXT,
  proposed_by     TEXT,
  proposed_at     TEXT,
  decided_by      TEXT,
  decided_at      TEXT,
  decision_note   TEXT,
  applied_audit_id INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
)`],
  ["flag_entries", `CREATE TABLE IF NOT EXISTS flag_entries (
  id          INTEGER PRIMARY KEY,
  flag_id     INTEGER NOT NULL REFERENCES item_flags(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'say',
  author      TEXT NOT NULL,
  author_type TEXT,
  body        TEXT NOT NULL,
  meta        TEXT,
  ref_id      INTEGER REFERENCES flag_entries(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
)`],
  ["item_projects", `CREATE TABLE IF NOT EXISTS item_projects (
  entity     TEXT NOT NULL,
  entity_id  INTEGER NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  added_by   TEXT,
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  flag_id    INTEGER REFERENCES item_flags(id) ON DELETE SET NULL,
  PRIMARY KEY (entity, entity_id, project_id)
)`],
  ["item_copies", `CREATE TABLE IF NOT EXISTS item_copies (
  entity            TEXT NOT NULL,
  entity_id         INTEGER NOT NULL,
  source_id         INTEGER NOT NULL,
  source_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  source_label      TEXT,
  copied_by         TEXT,
  copied_at         TEXT NOT NULL DEFAULT (datetime('now')),
  flag_id           INTEGER REFERENCES item_flags(id) ON DELETE SET NULL,
  PRIMARY KEY (entity, entity_id)
)`],
  // What the second_opinion hourly limit counts. See schema.sql.
  ["second_opinions", `CREATE TABLE IF NOT EXISTS second_opinions (
  id          INTEGER PRIMARY KEY,
  actor       TEXT,
  agent       TEXT NOT NULL,
  project_id  INTEGER,
  task_id     INTEGER,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  outcome     TEXT
)`],
  // Snapshots taken before something big. See schema.sql and main/backups.js.
  ["restore_points", `CREATE TABLE IF NOT EXISTS restore_points (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER,
  audit_id    INTEGER,
  kind        TEXT NOT NULL CHECK (kind IN ('migration', 'rebuild', 'update', 'large_undo', 'restore')),
  label       TEXT NOT NULL,
  backup_path TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
)`],
  // Folders that are no project's, and the shared folder each project gave up.
  // See schema.sql and workbench/folders.js.
  ["discovered_folders", `CREATE TABLE IF NOT EXISTS discovered_folders (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  seen_by     TEXT,
  via         TEXT,
  state       TEXT NOT NULL DEFAULT 'new',
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  detail      TEXT,
  answered_at TEXT
)`],
];

// [name, table, columns the index needs, statement]. The columns are checked
// because an index on a column that does not exist yet is an error, and a table
// this file could not widen (a failed ALTER) should cost one index, not the run.
const LATER_INDEXES = [
  ["idx_audit_entity", "audit", ["entity", "entity_id"],
   "CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit(entity, entity_id, id)"],
  ["idx_audit_session", "audit", ["session_id"],
   "CREATE INDEX IF NOT EXISTS idx_audit_session ON audit(session_id, id)"],
  ["idx_comments_ledger", "comments", ["task_id", "promoted"],
   "CREATE INDEX IF NOT EXISTS idx_comments_ledger ON comments(task_id, promoted)"],
  ["idx_handoffs_state", "handoffs", ["state"],
   "CREATE INDEX IF NOT EXISTS idx_handoffs_state ON handoffs(state, id)"],
  ["idx_workbenches_task", "workbenches", ["task_id", "state"],
   "CREATE INDEX IF NOT EXISTS idx_workbenches_task ON workbenches(task_id, state)"],
  // Missing and Closing count as live in both. A Missing row is still the
  // task's Workbench until someone picks Recreate or Forget, a Closing one
  // until its Finish or Discard is recorded, and letting Start make a second
  // one beside either is how one branch ends up in two rows.
  //
  // The fifth field is text the index's definition must contain. A partial
  // index cannot be altered, so one created by an older version (without
  // 'closing') is dropped and made again; see apply().
  ["idx_workbenches_live", "workbenches", ["task_id", "repo_id", "state"],
   "CREATE UNIQUE INDEX IF NOT EXISTS idx_workbenches_live ON workbenches(task_id, repo_id) " +
   "WHERE state IN ('active', 'parked', 'missing', 'closing')", "'closing'"],
  ["idx_workbenches_path", "workbenches", ["path", "state"],
   "CREATE UNIQUE INDEX IF NOT EXISTS idx_workbenches_path ON workbenches(path) " +
   "WHERE state IN ('active', 'parked', 'missing', 'closing')", "'closing'"],
  ["idx_item_flags_status", "item_flags", ["status"],
   "CREATE INDEX IF NOT EXISTS idx_item_flags_status ON item_flags(status, id)"],
  ["idx_item_flags_item", "item_flags", ["entity", "entity_id"],
   "CREATE INDEX IF NOT EXISTS idx_item_flags_item ON item_flags(entity, entity_id)"],
  ["idx_item_flags_live", "item_flags", ["entity", "entity_id", "status"],
   "CREATE UNIQUE INDEX IF NOT EXISTS idx_item_flags_live ON item_flags(entity, entity_id) " +
   "WHERE status IN ('open', 'evaluating', 'proposed')"],
  ["idx_flag_entries_flag", "flag_entries", ["flag_id"],
   "CREATE INDEX IF NOT EXISTS idx_flag_entries_flag ON flag_entries(flag_id, id)"],
  ["idx_item_projects_project", "item_projects", ["project_id", "entity", "entity_id"],
   "CREATE INDEX IF NOT EXISTS idx_item_projects_project ON item_projects(project_id, entity, entity_id)"],
  ["idx_item_copies_source", "item_copies", ["entity", "source_id"],
   "CREATE INDEX IF NOT EXISTS idx_item_copies_source ON item_copies(entity, source_id)"],
  ["idx_second_opinions_started", "second_opinions", ["started_at"],
   "CREATE INDEX IF NOT EXISTS idx_second_opinions_started ON second_opinions(started_at)"],
  ["idx_restore_points_created", "restore_points", ["created_at"],
   "CREATE INDEX IF NOT EXISTS idx_restore_points_created ON restore_points(created_at)"],
];

/**
 * The delete trigger for one kind of item, as schema.sql spells it.
 *
 * One function for the four of them, because four hand-copied bodies is how
 * one of them ends up clearing the wrong entity. tools/schema_parity_test.js
 * compares what this makes with what schema.sql makes, statement for statement.
 */
function itemTrigger(name, table, entity) {
  return `CREATE TRIGGER IF NOT EXISTS ${name} AFTER DELETE ON ${table} BEGIN
  DELETE FROM item_projects WHERE entity = '${entity}' AND entity_id = old.id;
  DELETE FROM item_copies   WHERE entity = '${entity}' AND entity_id = old.id;
  UPDATE item_flags SET status = 'stale', updated_at = datetime('now')
   WHERE entity = '${entity}' AND entity_id = old.id AND status IN ('open', 'evaluating', 'proposed');
END`;
}

// [name, table it fires on, the tables its body writes, statement]. Created
// when missing and every table it names exists, after the tables above.
const LATER_TRIGGERS = [
  ["items_task_ad", "tasks", ["item_projects", "item_copies", "item_flags"], itemTrigger("items_task_ad", "tasks", "task")],
  ["items_note_ad", "notes", ["item_projects", "item_copies", "item_flags"], itemTrigger("items_note_ad", "notes", "note")],
  ["items_pad_ad", "scratchpads", ["item_projects", "item_copies", "item_flags"], itemTrigger("items_pad_ad", "scratchpads", "scratchpad")],
  ["items_link_ad", "links", ["item_projects", "item_copies", "item_flags"], itemTrigger("items_link_ad", "links", "link")],
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
    alterOrRaced(query, table, column, `ALTER TABLE ${plainName(table)} ADD COLUMN ${column} ${definition}`);
    added.push(`${table}.${column}`);
  }
  return added;
}

/**
 * Runs an ALTER that adds a column, and treats "someone else just added it" as
 * success.
 *
 * The app and any number of MCP servers can open one old database at once,
 * and each looks before it alters. Between the look and the ALTER another
 * process can win, and the loser gets "duplicate column name". The column is
 * there, which is all anyone wanted, so the table is read again and only a
 * column that is still missing counts as a failure. Without this the app
 * refused to open the database at all.
 */
function alterOrRaced(query, table, column, statement) {
  try {
    query(statement);
  } catch (error) {
    let now = [];
    try { now = columnsOf(query, table); } catch {}
    if (!now.includes(column)) throw error;
  }
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
  const result = { added: [], created: [], indexed: [], triggered: [], errors: [] };
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
      alterOrRaced(query, table, column, statement);
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

  const definitions = attempt("SELECT name, sql FROM sqlite_master WHERE type = 'index'", () =>
    new Map((query("SELECT name, sql FROM sqlite_master WHERE type = 'index'") || []).map((r) => [r.name, String(r.sql || "")])));
  if (!definitions) return result;
  const existing = new Set(definitions.keys());
  for (const [name, table, needs, statement, mustContain] of LATER_INDEXES) {
    const have = columns.get(table);
    if (!have || !needs.every((c) => have.includes(c))) continue;
    // Out of date: dropped here and made again below. Both statements are
    // idempotent, so two processes doing this at once agree.
    if (existing.has(name) && mustContain && !definitions.get(name).includes(mustContain)) {
      const drop = `DROP INDEX IF EXISTS ${plainName(name)}`;
      if (attempt(drop, () => { query(drop); return true; })) existing.delete(name);
    }
    if (existing.has(name)) continue;
    attempt(statement, () => {
      query(statement);
      result.indexed.push(name);
    });
  }

  // Triggers last, because each names tables the steps above may have made.
  const triggers = attempt("SELECT name FROM sqlite_master WHERE type = 'trigger'", () =>
    new Set((query("SELECT name FROM sqlite_master WHERE type = 'trigger'") || []).map((r) => r.name)));
  if (!triggers) return result;
  for (const [name, table, writes, statement] of LATER_TRIGGERS) {
    if (triggers.has(name) || !columns.has(table) || !writes.every((t) => columns.has(t))) continue;
    attempt(statement, () => {
      query(statement);
      result.triggered.push(name);
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// In review: the one table rebuild
//
// A task's status is a CHECK, and a CHECK cannot be altered, so In review (a
// fifth status, between doing and done) needs tasks and status_events rebuilt:
// a new table made from the old one's own definition with the wider list,
// every row copied across by column name, the old one dropped, the new one
// renamed into its place, and its indexes and triggers made again from the
// text SQLite kept for them. That is SQLite's documented twelve-step ALTER.
//
// The definition is the stored one, not schema.sql's, because the stored one
// is what this database really has: the columns schema_later added over the
// years, in the order they were added, and whatever an older schema.sql said.
// Only the status CHECK is changed in it, and only when it reads exactly as the
// old list. A definition this does not recognise is left alone and said so,
// rather than guessed at.
//
// Who runs it: the app, and only the app, in db.open after main.js has taken a
// snapshot of the file. The MCP server never does, on either route. On the
// sqlite3 binary route every call is its own process, so there is no
// transaction that spans a look at the schema and the rebuild; the rebuild
// would have to be one script written from a schema read in an earlier
// process. If the app (or another server, and an agent tab starts one each)
// rebuilt the table in between, that script would copy the rows into a table
// made from the stale definition and put the narrow CHECK back, or fail half
// way through someone else's rebuild. There is also no node:sqlite there to
// take the snapshot the rebuild must come after. On the node:sqlite route the
// server could hold a transaction, but forty servers racing the app for one
// rebuild, none of them able to snapshot first, is the wrong shape too. So the
// server reads an old table as it always has (an unknown status already reads
// as doing, slice 0) and refuses only a write of review, with the sentence
// that says to open the app once. That costs an agent nothing it had before.

const STATUS_TABLES = ["tasks", "status_events"];
const OLD_STATUS_CHECK = /CHECK\s*\(\s*status\s+IN\s*\(\s*'todo'\s*,\s*'doing'\s*,\s*'blocked'\s*,\s*'done'\s*\)\s*\)/gi;
const NEW_STATUS_CHECK = "CHECK (status IN ('todo', 'doing', 'review', 'blocked', 'done'))";
const REVIEW_CHECK = /CHECK\s*\(\s*status\s+IN\s*\([^)]*'review'/i;

const tableSql = (query, name) =>
  ((query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${plainName(name)}'`) || [])[0] || {}).sql || null;

/**
 * Where each status table stands: "old" (the four-status CHECK, so it needs the
 * rebuild), "ready" (it already allows review), "missing", or "unknown" (a
 * status CHECK this does not recognise, which nothing here will touch).
 */
function statusTables(query) {
  const out = {};
  for (const name of STATUS_TABLES) {
    const text = tableSql(query, name);
    if (!text) out[name] = "missing";
    else if (REVIEW_CHECK.test(text)) out[name] = "ready";
    else out[name] = (text.match(OLD_STATUS_CHECK) || []).length === 1 ? "old" : "unknown";
  }
  return out;
}

/** True when the database still has the four-status CHECK somewhere and the rebuild has work to do. */
function needsStatusRebuild(query) {
  return Object.values(statusTables(query)).includes("old");
}

/** True when a task may be stored as review: both tables allow it. */
function reviewReady(query) {
  const t = statusTables(query);
  return t.tasks === "ready" && t.status_events === "ready";
}

const quote = (value) => (value == null ? "NULL" : `'${String(value).replace(/'/g, "''")}'`);

/**
 * The rebuild. query takes one statement per call and runs on one connection,
 * which is db.js's node:sqlite handle; see the note above for why nothing else
 * calls this. One transaction, taken with BEGIN IMMEDIATE so the write lock is
 * held from the first look to the commit, and checked again inside it, so a
 * second open (or a second process) finds nothing to do and changes nothing.
 *
 * point, when given, is the snapshot taken before this ran: a restore_points
 * row of kind 'rebuild' is written in the same transaction, so the row exists
 * exactly when the rebuild does.
 *
 * Returns { ran, tables, rows } or throws, having rolled back, with the
 * database as it was.
 */
function rebuildStatuses(query, { point = null } = {}) {
  if (!needsStatusRebuild(query)) return { ran: false, tables: [], rows: {} };
  const fkWas = Number(((query("PRAGMA foreign_keys") || [])[0] || {}).foreign_keys) === 1;
  // Off for the drop: with foreign keys on, DROP TABLE tasks first deletes
  // every row, and ON DELETE CASCADE would take every Sheet entry, status event
  // and subtask with it. It cannot be changed inside a transaction, hence here.
  // The connection's settings go back in the finally whatever happens, foreign
  // keys first, because a connection left with them off silently stops cascading.
  let fkOff = false;
  let legacyOn = false;
  // On for the rename: since SQLite 3.26 RENAME re-checks every view and every
  // trigger on other tables, and one that names tasks (a person's own view, a
  // trigger on comments) fails it with "no such table" in the moment between
  // the drop and the rename, which would roll this back on every launch. The
  // legacy rename checks nothing and rewrites nothing, which is exactly right
  // here: the new table takes the old one's name, so every reference to it by
  // name is already correct. SQLite's own twelve-step procedure says as much.
  const legacyWas = Number(((query("PRAGMA legacy_alter_table") || [])[0] || {}).legacy_alter_table) === 1;
  const done = { ran: false, tables: [], rows: {} };
  try {
    if (fkWas) { query("PRAGMA foreign_keys = OFF"); fkOff = true; }
    if (!legacyWas) { query("PRAGMA legacy_alter_table = ON"); legacyOn = true; }
    query("BEGIN IMMEDIATE");
    try {
      const state = statusTables(query);
      const todo = STATUS_TABLES.filter((name) => state[name] === "old");
      if (!todo.length) { query("ROLLBACK"); return done; }
      // A dangling reference that was there before is not this rebuild's to
      // fix, but one that appears during it is a row this lost the link to.
      const danglingBefore = (query("PRAGMA foreign_key_check") || []).length;
      // The same for views: one that was already broken (it names a column
      // long gone) is not this rebuild's to judge, and must not block it.
      const viewReads = (name) => { try { query(`SELECT * FROM "${String(name).replace(/"/g, '""')}" LIMIT 0`); return true; } catch { return false; } };
      const viewsBefore = (query("SELECT name FROM sqlite_master WHERE type = 'view'") || []).map((v) => v.name).filter(viewReads);
      for (const name of todo) {
        const fresh = `${name}_rebuilt`;
        const definition = tableSql(query, name);
        const columns = columnsOf(query, name);
        const count = Number(query(`SELECT COUNT(*) AS n FROM ${plainName(name)}`)[0].n);
        const top = query(`SELECT MAX(rowid) AS m FROM ${plainName(name)}`)[0].m;
        const extras = query(`SELECT type, name, sql FROM sqlite_master WHERE tbl_name = '${plainName(name)}' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name`) || [];
        const head = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|'[^']+'|`[^`]+`|\[[^\]]+\]|\w+)/i;
        if (!head.test(definition)) throw new Error(`the ${name} table's definition does not start the way it should`);
        const widened = definition.replace(OLD_STATUS_CHECK, NEW_STATUS_CHECK).replace(head, `CREATE TABLE ${fresh}`);
        query(widened);
        const names = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
        query(`INSERT INTO ${fresh} (${names}) SELECT ${names} FROM ${plainName(name)}`);
        query(`DROP TABLE ${plainName(name)}`);
        query(`ALTER TABLE ${fresh} RENAME TO ${plainName(name)}`);
        for (const x of extras) query(x.sql);
        // Checked before the commit: the same columns in the same order, every
        // row, the same highest id, and every index and trigger back.
        const after = columnsOf(query, name);
        if (JSON.stringify(after) !== JSON.stringify(columns)) throw new Error(`the rebuilt ${name} table has different columns`);
        const n = Number(query(`SELECT COUNT(*) AS n FROM ${plainName(name)}`)[0].n);
        if (n !== count) throw new Error(`the rebuilt ${name} table has ${n} rows, not ${count}`);
        if (query(`SELECT MAX(rowid) AS m FROM ${plainName(name)}`)[0].m !== top) throw new Error(`the rebuilt ${name} table's ids changed`);
        const back = new Set((query(`SELECT name FROM sqlite_master WHERE tbl_name = '${plainName(name)}' AND type IN ('index', 'trigger')`) || []).map((r) => r.name));
        const lost = extras.filter((x) => !back.has(x.name)).map((x) => x.name);
        if (lost.length) throw new Error(`the rebuilt ${name} table is missing ${lost.join(", ")}`);
        if (!REVIEW_CHECK.test(tableSql(query, name) || "")) throw new Error(`the rebuilt ${name} table still refuses review`);
        done.tables.push(name);
        done.rows[name] = n;
      }
      // Every view that read before still reads, now that what it names is back.
      const broken = viewsBefore.filter((name) => !viewReads(name));
      if (broken.length) throw new Error(`the rebuild broke the view ${broken.join(", ")}`);
      const danglingAfter = (query("PRAGMA foreign_key_check") || []).length;
      if (danglingAfter > danglingBefore) throw new Error(`the rebuild left ${danglingAfter - danglingBefore} rows pointing at nothing`);
      if (point) {
        // After the newest History row, which is the moment the snapshot holds.
        query(`INSERT INTO restore_points (kind, label, backup_path, audit_id)
               VALUES ('rebuild', ${quote(point.label || "Before adding In review")}, ${quote(point.file || null)},
                       (SELECT MAX(id) FROM audit))`);
      }
      query("COMMIT");
      done.ran = true;
      return done;
    } catch (error) {
      try { query("ROLLBACK"); } catch {}
      throw error;
    }
  } finally {
    try { if (fkOff) query("PRAGMA foreign_keys = ON"); } finally { if (legacyOn) query("PRAGMA legacy_alter_table = OFF"); }
  }
}

module.exports = { LATER_COLUMNS, LATER_TABLES, LATER_INDEXES, LATER_TRIGGERS, apply, addLaterColumns, hasTable, columnsOf, allColumns,
  STATUS_TABLES, statusTables, needsStatusRebuild, reviewReady, rebuildStatuses };
