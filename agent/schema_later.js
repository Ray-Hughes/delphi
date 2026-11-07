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
  // How many sessions have called from a discovered folder. A database from
  // slice 4 has the table already, so the CREATE in LATER_TABLES never adds it.
  ["discovered_folders", "seen_count", "INTEGER NOT NULL DEFAULT 1"],
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
  answered_at TEXT,
  seen_count  INTEGER NOT NULL DEFAULT 1
)`],
  // Edit this page: one row per screen and scope. See schema.sql and ui/layout.js.
  ["layouts", `CREATE TABLE IF NOT EXISTS layouts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  screen      TEXT NOT NULL,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  layout      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
  // One row per screen for everyone, and one per screen per project. NULL is
  // global, and a UNIQUE index counts NULLs as distinct, hence the COALESCE.
  ["idx_layouts_scope", "layouts", ["screen", "project_id"],
   "CREATE UNIQUE INDEX IF NOT EXISTS idx_layouts_scope ON layouts(screen, COALESCE(project_id, 0))"],
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
// The audit table's entity list
//
// audit.entity carries a CHECK naming every kind of thing History records, and
// a CHECK cannot be altered, so adding a kind means rebuilding the table the
// way SQLite documents: make the new one, copy, drop the old, rename, put the
// indexes back. It lives here rather than in db.js alone so the MCP server
// runs it too (an agent may meet a database the app has not opened since an
// upgrade), and so there is one copy of it rather than two.
//
// Columns are copied by name, from pragma_table_info, never from a list typed
// here. The rebuild used to copy a fixed list, so a column a later slice added
// to audit through LATER_COLUMNS would have been dropped by the next widening
// without a word (slice 12 adds two). A column the old table has and
// AUDIT_COLUMNS does not name is kept, with the type, NOT NULL and default the
// old table gave it.

/** Every entity History may name. schema.sql's CHECK lists the same, in this order. */
const AUDIT_ENTITIES = ["task", "note", "project", "link", "scratchpad", "session", "handoff", "layout"];
const quoteList = (list) => list.map((e) => `'${e}'`).join(", ");

/** The audit table as schema.sql declares it, column by column. */
const AUDIT_COLUMNS = [
  ["id", "INTEGER PRIMARY KEY"],
  ["at", "TEXT NOT NULL DEFAULT (datetime('now'))"],
  ["action", "TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete'))"],
  ["entity", `TEXT NOT NULL CHECK (entity IN (${quoteList(AUDIT_ENTITIES)}))`],
  ["entity_id", "INTEGER"],
  ["summary", "TEXT NOT NULL"],
  ["label", "TEXT"],
  ["before_json", "TEXT"],
  ["after_json", "TEXT"],
  ["undone", "INTEGER NOT NULL DEFAULT 0"],
  ["undone_at", "TEXT"],
  ["actor", "TEXT"],
  ["actor_type", "TEXT"],
  ["session_id", "INTEGER"],
  ["job_id", "INTEGER"],
  ["step", "TEXT"],
];

/**
 * The entities a stored CREATE TABLE audit allows, or null when it has no
 * CHECK on entity at all, which allows everything and so needs no widening.
 */
function auditEntitiesIn(createSql) {
  // The column may be quoted ("entity", `entity`, [entity]): a table some tool
  // rewrote. Read as no CHECK, it would never be widened, and every layout
  // write would then fail on the CHECK it still has.
  const m = /CHECK\s*\(\s*["`\[]?entity["`\]]?\s+IN\s*\(([^)]*)\)\s*\)/i.exec(String(createSql || ""));
  if (!m) return null;
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

const quoteName = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * What a plan was made from, as one string SQLite can compute itself: the
 * table's stored SQL, its columns in order, and every index and trigger on it.
 * The plan reads it before anything else and its first statement checks it
 * again inside the transaction, so a plan made from a table another process
 * has changed since (a column added, an index made) fails instead of
 * rebuilding from the old shape and dropping what was added.
 */
const AUDIT_SHAPE = "(SELECT COALESCE((SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit'), '')) || char(31) || " +
  "(SELECT COALESCE(group_concat(name, ','), '') FROM (SELECT name FROM pragma_table_info('audit') ORDER BY cid)) || char(31) || " +
  "(SELECT COALESCE(group_concat(sql, char(30)), '') FROM (SELECT sql FROM sqlite_master WHERE tbl_name = 'audit' " +
  "AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name))";
const auditShape = (query) => String(((query(`SELECT ${AUDIT_SHAPE} AS shape`) || [])[0] || {}).shape ?? "");
const sqlText = (text) => `'${String(text).replace(/'/g, "''")}'`;

/**
 * The statements that rebuild audit with the full entity list, or [] when the
 * table already allows every one, or does not exist. Only reads, so a test can
 * look at what would run without running it.
 *
 * Run inside the transaction where the route allows it (widenAuditLocked).
 * Where it cannot (the server's sqlite3 binary, a process per statement), the
 * shape check at the top of the plan is what keeps a stale plan from running.
 */
function auditRebuildPlan(query) {
  const shape = auditShape(query);
  const table = (query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit'") || [])[0];
  if (!table || !table.sql) return [];
  const allowed = auditEntitiesIn(table.sql);
  if (!allowed || AUDIT_ENTITIES.every((e) => allowed.includes(e))) return [];

  const old = query(`SELECT name, type, "notnull" AS nn, dflt_value AS dflt FROM pragma_table_info('audit') ORDER BY cid`) || [];
  if (!old.length) return [];
  const canonical = new Map(AUDIT_COLUMNS);
  // Never narrower than it was: an entity a newer Delphi added stays allowed,
  // or its rows would fail the copy and the widening would never land.
  // Read from between quotes, so none holds one; any other spelling is kept.
  const extra = allowed.filter((e) => e.length && !AUDIT_ENTITIES.includes(e));
  if (extra.length) canonical.set("entity", `TEXT NOT NULL CHECK (entity IN (${quoteList([...AUDIT_ENTITIES, ...extra])}))`);
  const oldNames = old.map((c) => c.name);
  const definitions = old.map((c) => {
    if (canonical.has(c.name)) return `${quoteName(c.name)} ${canonical.get(c.name)}`;
    // Bracketed whatever it is: pragma_table_info gives an expression default
    // without the brackets it was written with, and DEFAULT datetime('now')
    // on its own is a syntax error.
    return [quoteName(c.name), c.type, Number(c.nn) ? "NOT NULL" : "", c.dflt == null ? "" : `DEFAULT (${c.dflt})`].filter(Boolean).join(" ");
  });
  for (const [name, def] of AUDIT_COLUMNS) if (!oldNames.includes(name)) definitions.push(`${quoteName(name)} ${def}`);
  const names = oldNames.map(quoteName).join(", ");

  // Every index and trigger on audit as stored, so one a later slice added
  // comes back too: dropping the table takes them with it.
  const attached = (query("SELECT sql FROM sqlite_master WHERE tbl_name = 'audit' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name") || [])
    .map((r) => String(r.sql));
  // Changed while it was being read: the reads above may not agree with each
  // other, so nothing is planned from them.
  if (auditShape(query) !== shape) throw new Error("the History table changed while the widening was reading it");
  return [
    // A CHECK on a scratch table is how a plain statement fails on a
    // condition, the same way on every route: the transaction stops there and
    // the old table is never dropped.
    "CREATE TEMP TABLE IF NOT EXISTS audit_rebuilt_check (ok INTEGER NOT NULL CHECK (ok = 1))",
    // The table is still the one this plan was made from.
    `INSERT INTO audit_rebuilt_check (ok) SELECT ${AUDIT_SHAPE} = ${sqlText(shape)}`,
    "DROP TABLE IF EXISTS audit_rebuilt",
    `CREATE TABLE audit_rebuilt (\n  ${definitions.join(",\n  ")}\n)`,
    `INSERT INTO audit_rebuilt (${names}) SELECT ${names} FROM audit`,
    // A copy that came out short stops here.
    "INSERT INTO audit_rebuilt_check (ok) SELECT (SELECT COUNT(*) FROM audit_rebuilt) = (SELECT COUNT(*) FROM audit) " +
      "AND (SELECT COALESCE(MAX(id), 0) FROM audit_rebuilt) = (SELECT COALESCE(MAX(id), 0) FROM audit)",
    "DROP TABLE audit_rebuilt_check",
    "DROP TABLE audit",
    "ALTER TABLE audit_rebuilt RENAME TO audit",
    ...attached,
  ];
}

/**
 * Widens audit.entity to AUDIT_ENTITIES when it is narrower, as one
 * transaction, for a route with no connection of its own to hold (the
 * server's sqlite3 binary, where a batch is one script in one process).
 * Idempotent without a migrations table: the guard is the stored CHECK
 * itself, so once it names every entity there is nothing to do.
 *
 * The script turns legacy_alter_table on first. Since SQLite 3.26 a rename
 * re-checks every view and every trigger on other tables, and one that names
 * audit (a person's own view, a trigger on notes that writes History) fails it
 * with "no such table" between the drop and the rename, which would roll this
 * back on every launch. The legacy rename checks nothing and rewrites nothing,
 * which is right here: the new table takes the old name, so every reference
 * to it by name is already correct. The process ends with the script, so
 * nothing needs putting back.
 *
 * @param query  one statement per call, as for apply()
 * @param batch  statements as one transaction
 */
function widenAudit(query, batch) {
  const plan = auditRebuildPlan(query);
  if (!plan.length) return { ran: false, statements: 0 };
  batch(["PRAGMA legacy_alter_table = ON", ...plan]);
  return { ran: true, statements: plan.length };
}

/**
 * The same for a route that holds one connection (db.js, the server on
 * node:sqlite): the plan is made inside BEGIN IMMEDIATE, so nothing can change
 * the table between reading it and rebuilding it, and legacy_alter_table is
 * on for the rename (see widenAudit) and put back as it was, whatever happens.
 *
 * @param query  one statement per call, on the connection that will run them
 */
function widenAuditLocked(query) {
  const pragma = (name) => Number(((query(`PRAGMA ${name}`) || [])[0] || {})[name]);
  const legacyWas = pragma("legacy_alter_table") === 1;
  try {
    if (!legacyWas) query("PRAGMA legacy_alter_table = ON");
    query("BEGIN IMMEDIATE");
    try {
      const plan = auditRebuildPlan(query);
      if (!plan.length) { query("ROLLBACK"); return { ran: false, statements: 0 }; }
      for (const statement of plan) query(statement);
      query("COMMIT");
      return { ran: true, statements: plan.length };
    } catch (error) {
      try { query("ROLLBACK"); } catch {}
      throw error;
    }
  } finally {
    if (!legacyWas) { try { query("PRAGMA legacy_alter_table = OFF"); } catch {} }
  }
}

module.exports = {
  LATER_COLUMNS, LATER_TABLES, LATER_INDEXES, LATER_TRIGGERS, apply, addLaterColumns, hasTable, columnsOf, allColumns,
  AUDIT_ENTITIES, AUDIT_COLUMNS, auditEntitiesIn, auditRebuildPlan, widenAudit, widenAuditLocked,
};
