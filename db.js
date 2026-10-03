// Database access for the main process.
//
// Uses node:sqlite, which ships inside Electron's bundled Node, so there is no
// native module to compile and nothing to rebuild when Electron updates. That
// matters more than raw speed here: the whole dataset is a few hundred rows, and
// a build step that breaks on every Electron bump is the usual reason small
// tools like this quietly stop working.

const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");
const paths = require("./paths");
const pads = require("./pads");
const schemaLater = require("./agent/schema_later");

// Beside the source when run from a checkout, in the per-user data directory when
// run from an installer. See paths.js: the packaged source directory is a
// read-only archive, so a database cannot live there.
const DB_PATH = paths.DB_PATH;

let db;

function open() {
  if (db) return db;
  paths.ensureDataDir();
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA foreign_keys = ON");
  // SQLite allows one writer at a time and, without this, a second writer fails
  // immediately rather than waiting its turn. The app and any number of agents
  // write to this file concurrently, so "immediately" is a lost write.
  db.exec("PRAGMA busy_timeout = 5000");
  // Schema is idempotent, so applying it on every open keeps a hand-copied
  // database in step without a migration framework.
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  // Columns first, then the schema. schema.sql indexes some of these columns, and
  // an index on a column that does not exist yet is an error that stops the whole
  // file, so an older database would fail to open at all. See agent/schema_later.js
  // for why the list lives there: the MCP server runs the same one.
  //
  // apply() never throws, because the server would rather serve without a column
  // than not serve. The app has always refused to open a database it could not
  // bring up to date, and still does, so the first failure is raised here.
  const later = schemaLater.apply((statement) => db.prepare(statement).all());
  if (later.errors.length) {
    const first = later.errors[0];
    throw new Error(`Could not bring the database up to date: ${first.message} (${first.statement.split("\n")[0]})`);
  }
  db.exec(schema);
  // After the schema, because on a fresh database the table it rebuilds has just
  // been created with the right constraint and there is nothing to do.
  widenAuditEntities(db);
  // Safe to call here: db is already assigned, so the helpers this goes through
  // find the connection rather than recursing into open(). Guarded because a
  // database that adopts nothing still works, and one that refuses to open does
  // not.
  try {
    adoptProjectPaths();
  } catch (error) {
    console.error("could not adopt project paths into workspaces", error);
  }
  return db;
}

/**
 * Widens the CHECK on audit.entity, once.
 *
 * The audit table names the kinds of thing that can be written, and scratchpads
 * are a new one. A CHECK constraint cannot be altered, so the only way to change
 * it is the twelve step rebuild SQLite documents: make the new table, copy, drop
 * the old, rename, put the indexes back.
 *
 * This is the first thing in the file more structural than an added column, and
 * it is worth the risk rather than the alternative. The alternative was to file
 * pad writes under 'note', which would make the History tab lie about what
 * happened, in the one feature whose whole selling point is that it does not.
 *
 * Guarded on the stored SQL rather than a version number, so it is idempotent
 * without a migrations table: if the constraint already names scratchpad, this
 * has run.
 */
function widenAuditEntities(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit'").get();
  if (!row || !row.sql || row.sql.includes("'scratchpad'")) return;
  // foreign_keys cannot be changed inside a transaction, hence the order. Nothing
  // references audit, so this is belt and braces rather than load bearing.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    BEGIN;
    CREATE TABLE audit_rebuilt (
      id          INTEGER PRIMARY KEY,
      at          TEXT NOT NULL DEFAULT (datetime('now')),
      action      TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
      entity      TEXT NOT NULL CHECK (entity IN ('task', 'note', 'project', 'link',
                                                  'scratchpad', 'session', 'handoff')),
      entity_id   INTEGER,
      summary     TEXT NOT NULL,
      label       TEXT,
      before_json TEXT,
      after_json  TEXT,
      undone      INTEGER NOT NULL DEFAULT 0,
      undone_at   TEXT
    );
    INSERT INTO audit_rebuilt
      (id, at, action, entity, entity_id, summary, label, before_json, after_json, undone, undone_at)
      SELECT id, at, action, entity, entity_id, summary, label, before_json, after_json, undone, undone_at
      FROM audit;
    DROP TABLE audit;
    ALTER TABLE audit_rebuilt RENAME TO audit;
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at DESC);
    COMMIT;
  `);
  db.exec("PRAGMA foreign_keys = ON");
}

const all = (sql, params = {}) => open().prepare(sql).all(params);
const one = (sql, params = {}) => open().prepare(sql).get(params);
const run = (sql, params = {}) => open().prepare(sql).run(params);

/**
 * Runs a query written in the MCP server's style, :p1 to :pN, with real binding.
 *
 * The stores under sheet/ and workbench/ are shared with the server rather than
 * twinned, and take whichever sql() they are handed. The server substitutes
 * literals because one of its routes is a sqlite3 subprocess; this binds, which
 * is the better thing to do when there is a handle to bind against. One regex
 * pass with a replacement function, so nothing in a value is ever looked at.
 *
 * Values are coerced the way the server's literal() renders them, so a store
 * sees the same thing stored whichever side wrote it: a boolean is 1 or 0, a
 * number that is not finite is NULL, and anything else that is not a number or
 * a string is turned into one rather than refused.
 */
function sqlP(query, params = []) {
  // The same count rule as the server's sql(): node:sqlite would bind a
  // missing value as NULL and ignore a spare one, and the server's route
  // would do neither the same way, so a mismatch throws on both.
  let highest = 0;
  const statement = String(query).replace(/:p(\d+)/g, (match, n) => {
    const index = Number(n);
    if (index < 1 || index > params.length) throw new Error(`sqlP(): ${match} has no value (${params.length} given)`);
    if (index > highest) highest = index;
    return `?${n}`;
  });
  if (highest !== params.length) throw new Error(`sqlP(): ${params.length} values given for ${highest} placeholders`);
  const values = params.map((v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "bigint" || typeof v === "string") return v;
    return String(v);
  });
  return open().prepare(statement).all(...values);
}

// Audit summaries are read by people, so they say "1 task" rather than "1 tasks".
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Audit
//
// Every mutation records the row before and after. Undo replays the stored
// "before", so there is one mechanism rather than two that can disagree: if a
// change is in the log it can be reversed, and if it cannot be reversed it is
// not in the log.
// ---------------------------------------------------------------------------

const TABLES = {
  task: "tasks", note: "notes", project: "projects", link: "links",
  // Listed here and not only in the CHECK, because this is what makes a pad edit
  // reversible. An agent that rewrites your plan badly should be one undo away
  // from having not done that.
  scratchpad: "scratchpads",
};

const rowOf = (entity, id) =>
  id == null ? null : one(`SELECT * FROM ${TABLES[entity]} WHERE id = :id`, { id });

function record({ action, entity, entityId, summary, label, before, after }) {
  run(
    `INSERT INTO audit (action, entity, entity_id, summary, label, before_json, after_json)
     VALUES (:action, :entity, :entityId, :summary, :label, :before, :after)`,
    {
      action,
      entity,
      entityId: entityId ?? null,
      summary,
      label: label ?? null,
      before: before ? JSON.stringify(before) : null,
      after: after ? JSON.stringify(after) : null,
    }
  );
}

// Describes an update in words, so the audit list is readable without diffing
// two blobs of JSON. Status changes are called out because they are the ones
// people undo.
function describeUpdate(entity, before, after) {
  const changes = [];
  for (const key of Object.keys(after)) {
    if (key === "updated_at" || key === "completed_at") continue;
    if (String(before[key] ?? "") === String(after[key] ?? "")) continue;
    if (key === "status") {
      // A project's status carries archiving, which is the app's put-this-away
      // gesture rather than a label. "status active to archived" is the truth but
      // it reads like every other field change, and this is the entry someone
      // scanning the list is most likely to have come for.
      if (entity === "project" && after[key] === "archived") changes.push("archived");
      else if (entity === "project" && before[key] === "archived") changes.push("brought back from the archive");
      else changes.push(after[key] === "done" ? "marked done" : `status ${before[key]} to ${after[key]}`);
    } else if (key === "task_view") {
      changes.push(`laid out as ${after[key]}`);
    } else if (key === "project_id") {
      changes.push("moved project");
    } else if (key === "organizer_id") {
      changes.push(after[key] == null ? "taken out of its epic" : "filed under an epic");
    } else if (key === "body" && entity === "scratchpad") {
      changes.push("wrote to the pad");
    } else if (key === "body" || key === "detail") {
      changes.push(`edited ${key}`);
    } else {
      changes.push(`${key} changed`);
    }
  }
  return changes.length ? changes.join(", ") : "no visible change";
}

/**
 * Everything that has happened inside one project.
 *
 * The audit table records what changed, not where it lived, so a project has to
 * be worked out per row. For rows that still exist that is a lookup. For deleted
 * ones the row is gone, and the only surviving copy of its project is inside the
 * stored before_json, which is exactly the case someone needs most: a delete is
 * the change people come here to reverse.
 */
function projectActivity(projectId, limit = 200) {
  return all(
    `SELECT id, at, action, entity, entity_id, summary, label, undone, undone_at,
            CASE WHEN before_json IS NULL THEN 0 ELSE 1 END AS restorable
     FROM audit
     WHERE (entity = 'project' AND entity_id = :projectId)
        OR (entity = 'task'  AND entity_id IN (SELECT id FROM tasks  WHERE project_id = :projectId))
        OR (entity = 'note'  AND entity_id IN (SELECT id FROM notes  WHERE project_id = :projectId))
        OR (entity = 'link'  AND entity_id IN (SELECT id FROM links  WHERE project_id = :projectId))
        OR json_extract(COALESCE(before_json, after_json), '$.project_id') = :projectId
     ORDER BY id DESC
     LIMIT :limit`,
    { projectId, limit }
  );
}

function listAudit(limit = 100) {
  return all(
    // restorable is the same column projectActivity computes, and for the same
    // reason: a delete with no stored copy cannot be put back, and the global
    // list used to offer an undo button on those rows anyway.
    `SELECT id, at, action, entity, entity_id, summary, label, undone, undone_at,
            CASE WHEN before_json IS NULL THEN 0 ELSE 1 END AS restorable
     FROM audit ORDER BY id DESC LIMIT :limit`,
    { limit }
  );
}

/**
 * What a delete carried away, in the order it has to come back.
 *
 * Each entry is a key in the stored blob and the table its rows belong to.
 * Parents before children, or the foreign key has nothing to point at: an
 * organizer before the tasks filed under it, a task before its comments and
 * reminders, the project itself before any of them.
 */
const RESTORE_ORDER = {
  task: [["__subtasks", "tasks"], ["__comments", "comments"], ["__events", "status_events"]],
  project: [
    ["__organizers", "organizers"],
    ["__tasks", "tasks"],
    ["__comments", "comments"],
    ["__events", "status_events"],
    ["__alerts", "alerts"],
    ["__notes", "notes"],
    ["__links", "links"],
    ["__repos", "repos"],
    // Sessions before their messages, same rule as everything above: the child
    // has a foreign key pointing at the parent and nothing to point at if the
    // parent is not back yet.
    ["__sessions", "sessions"],
    ["__messages", "messages"],
  ],
};

/**
 * Puts a set of stored rows back.
 *
 * OR IGNORE because a restore has to survive a row that is somehow already
 * there. On its own that turns a half finished restore into a silent success,
 * since an id SQLite has handed to something else since the delete is skipped
 * without a word, so the count is checked when the caller asks for strict.
 *
 * Only a project restore asks. A project that comes back missing a third of its
 * work, reported as a success, is worse than one that did not come back at all,
 * and undo()'s transaction unwinds it. A task restore stays tolerant because it
 * used to be: SQLite reuses a freed comment rowid as soon as anything else
 * writes a comment, so a strict task restore refuses to bring back a task whose
 * own row is perfectly fine over a single clashing comment.
 */
function restoreRows(table, rows, strict = false) {
  let inserted = 0;
  for (const row of rows) {
    const cols = Object.keys(row);
    const r = run(
      `INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => ":" + c).join(", ")})`,
      row
    );
    inserted += Number(r.changes);
  }
  if (strict && inserted !== rows.length) {
    throw new Error(
      `Could not put back ${rows.length - inserted} of ${rows.length} rows in ${table}, ` +
      "so nothing was restored"
    );
  }
}

/**
 * Gives orphaned tasks their project back.
 *
 * Deleting a project with the tasks kept does not delete them: tasks.project_id
 * is ON DELETE SET NULL, so they are sitting in All work with no home and, since
 * organizers did cascade, no epic either. Both are restored from the stored copy.
 *
 * A task that no longer matches is left alone rather than treated as a failure.
 * It has either been deleted since, with its own audit row to reverse, or moved
 * into another project on purpose, and dragging it back out of one would be a
 * worse answer than leaving it.
 */
function reattachTasks(projectId, rows) {
  for (const row of rows) {
    run(
      `UPDATE tasks SET project_id = :projectId, organizer_id = :organizerId
       WHERE id = :id AND project_id IS NULL`,
      { projectId, organizerId: row.organizer_id ?? null, id: row.id }
    );
  }
}

// Reverses one entry. Deliberately does not itself write an audit row: an undo
// that appears in the log as another change makes the list confusing and invites
// undoing an undo. The entry is marked undone instead, so the history stays
// truthful about what happened. Undoing the creation of a project is the one
// exception, and applyUndo says why.
function undo(auditId) {
  const entry = one("SELECT * FROM audit WHERE id = :id", { id: auditId });
  if (!entry) throw new Error("No such audit entry");
  if (entry.undone) throw new Error("That change has already been undone");

  // One transaction over the whole reversal. A restore is many statements and a
  // failure part way through used to leave a project back but empty, which is
  // worse than the delete it was trying to reverse and reported as success.
  const conn = open();
  conn.exec("BEGIN");
  try {
    applyUndo(entry);
    // Putting a pad body back leaves the board reading from text that is no
    // longer there, so the projection is taken again from the restored body.
    // Inside the same transaction as the restore, for the reason writeScratchpad
    // gives: half a sync is worse than none.
    if (entry.entity === "scratchpad" && entry.action !== "delete") deriveInPlace(entry.entity_id);
    run("UPDATE audit SET undone = 1, undone_at = datetime('now') WHERE id = :id", { id: auditId });
    conn.exec("COMMIT");
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
  return listAudit(100);
}

function applyUndo(entry) {
  const table = TABLES[entry.entity];
  const before = entry.before_json ? JSON.parse(entry.before_json) : null;

  if (entry.action === "create") {
    // A project is the one create whose reversal is a cascading delete rather
    // than the removal of one row: notes, links, organizers and repos all go
    // with it and tasks are orphaned. The agent path writes project creates with
    // no before_json, so undoing one used to destroy all of that with nothing
    // kept. Refused outright when the project has since been filled, and routed
    // through the project delete when it has not, which is the one place undo
    // writes an audit row of its own: without it the removal leaves no copy at all.
    if (entry.entity === "project") {
      // Already gone, so the creation has been reversed some other way and there
      // is nothing left to take. Returning marks the entry undone, which is what
      // the plain DELETE that used to sit here did. Throwing instead left the
      // entry pending for good, and undoLast stops at the first entry it cannot
      // reverse, so one of these blocked everything older than it.
      if (!getProject(entry.entity_id)) return;
      const held = projectContents(entry.entity_id);
      const total = held ? held.tasks + held.notes + held.links + held.organizers + held.repos : 0;
      if (total) {
        throw new Error(
          "This project holds work now, so undoing its creation would take all of it. " +
          "Delete it from the project's Settings tab instead, which says what will go and can be reversed."
        );
      }
      // The untransacted body: undo() has already opened a transaction around
      // this, and SQLite will not nest a second one.
      deleteProjectRows(entry.entity_id, { tasks: "delete" });
      return;
    }
    run(`DELETE FROM ${table} WHERE id = :id`, { id: entry.entity_id });
  } else if (entry.action === "update") {
    if (!before) throw new Error("That change has no recorded previous state");
    const cols = Object.keys(before).filter((c) => c !== "id");
    const sets = cols.map((c) => `${c} = :${c}`).join(", ");
    run(`UPDATE ${table} SET ${sets} WHERE id = :id`, { ...before, id: entry.entity_id });
  } else if (entry.action === "delete") {
    if (!before) throw new Error("That deletion has no recorded contents");
    // Keys beginning with two underscores are the subtree the cascade took, not
    // columns of this row.
    const carried = {};
    for (const key of Object.keys(before)) {
      if (key.startsWith("__")) { carried[key] = before[key]; delete before[key]; }
    }
    const cols = Object.keys(before);
    run(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => ":" + c).join(", ")})`,
      before
    );
    for (const [key, subTable] of RESTORE_ORDER[entry.entity] || []) {
      const rows = carried[key] || [];
      if (!rows.length) continue;
      // Tasks the delete only orphaned are still in the database. They want their
      // project back, not a second copy of themselves.
      if (subTable === "tasks" && entry.entity === "project" && carried.__tasks_mode === "keep") {
        reattachTasks(entry.entity_id, rows);
        continue;
      }
      restoreRows(subTable, rows, entry.entity === "project");
    }
  }
}

/**
 * Reverses the newest changes, and stops at the first one it cannot.
 *
 * Newest first, so a sequence of changes to the same row unwinds in the right
 * order rather than leaving an older state on top. Stopping rather than throwing
 * matters because the earlier entries have already been applied by then: a throw
 * left the caller believing nothing had happened when several changes had.
 */
function undoLast(count = 1) {
  const pending = all(
    "SELECT id FROM audit WHERE undone = 0 ORDER BY id DESC LIMIT :count",
    { count }
  );
  let undone = 0;
  let stopped = null;
  for (const row of pending) {
    try {
      undo(row.id);
      undone += 1;
    } catch (error) {
      stopped = String(error.message || error);
      break;
    }
  }
  return { undone, stopped };
}

// Projects, each carrying its own open/total counts so the sidebar can show
// progress without a second round trip per project.
// The layouts a project's tasks can be shown in. Here rather than as a CHECK
// constraint, because a constraint cannot be added to a database that already
// exists and the two would drift.
const TASK_VIEWS = ["list", "table", "columns", "board", "calendar"];

/**
 * The colours a task may carry.
 *
 * Names, not hex. The renderer resolves each one against the theme in force, so
 * a task coloured on a light screen is still legible on a dark one. Kept here
 * rather than as a CHECK constraint for the same reason as TASK_VIEWS: a
 * constraint cannot be added to a database that already exists, so the two
 * would drift.
 */
const TASK_COLOURS = ["blue", "teal", "green", "amber", "orange", "red", "purple", "slate"];

/**
 * The states a project can be in.
 *
 * This one does have a CHECK behind it in schema.sql, unlike TASK_VIEWS. It is
 * still listed here because the constraint only ever arrives at a caller as
 * "CHECK constraint failed: projects", which names neither the column nor the
 * answers it would have accepted.
 */
const PROJECT_STATUSES = ["active", "paused", "blocked", "done", "archived"];

/**
 * Normalises a project key.
 *
 * key is the only column in the table with a uniqueness constraint and the only
 * one anything outside this window points at, so it is cleaned here rather than
 * trusted to arrive clean from four different callers.
 *
 * agent/mcp_server.js keeps its own copy of this and of the sort_order rule in
 * createProject below. It has to: it runs under whatever Node an editor launched
 * it with, which may have no node:sqlite, and this file ends up inside app.asar
 * where a plain Node process cannot read it. The two are twins and have to be
 * edited together, so add_project carries a comment pointing back here.
 */
const slugKey = (key) =>
  String(key ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function listProjects() {
  return all(`
    SELECT p.*,
           (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status != 'done') AS open_count,
           (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS total_count,
           (SELECT COUNT(*) FROM notes n WHERE n.project_id = p.id) AS note_count
    FROM projects p
    WHERE p.status != 'archived'
    ORDER BY p.sort_order, p.name
  `);
}

/**
 * The projects listProjects deliberately hides.
 *
 * Archiving is the soft removal: the row and everything hanging off it stay
 * exactly where they were, and only the WHERE clause above pretends otherwise.
 * But the renderer learns about projects through that one call and nothing else,
 * so archiving used to be a one way door that no part of the window could open.
 * This is the other side of it.
 *
 * Carries the same three counts, because the question asked of an archived
 * project is whether it still holds anything worth having back. Ordered by name
 * rather than sort_order, which is a statement about a sidebar these are not in.
 */
function listArchivedProjects() {
  return all(`
    SELECT p.*,
           (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status != 'done') AS open_count,
           (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS total_count,
           (SELECT COUNT(*) FROM notes n WHERE n.project_id = p.id) AS note_count
    FROM projects p
    WHERE p.status = 'archived'
    ORDER BY p.name
  `);
}

function getProject(id) {
  return one("SELECT * FROM projects WHERE id = :id", { id });
}

function createProject({ key, name, summary = null, colour = "#7c8698", path = null, icon = null }) {
  const slug = slugKey(key);
  if (!slug) throw new Error("A project key needs at least one letter or digit");

  // Checked before the insert rather than left to the UNIQUE constraint, which
  // reaches the window as "UNIQUE constraint failed: projects.key" and says
  // neither which project already holds the key nor that a key is what went
  // wrong. The agent path has always pre-checked; this path had not.
  const clash = projectByKey(slug);
  if (clash) {
    throw new Error(`A project with the key ${slug} already exists (${clash.name})`);
  }

  // Above General, which is pinned at 99 as the catch-all, so a new project does
  // not sort below the place work goes when it has nowhere else to be. This is
  // the rule the agent path already used, and the reason two projects made the
  // same week ended up either side of General depending on which one made them.
  const order = one(
    "SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM projects WHERE sort_order < 99"
  ).n;
  const r = run(
    `INSERT INTO projects (key, name, summary, colour, path, icon, sort_order)
     VALUES (:key, :name, :summary, :colour, :path, :icon, :sort_order)`,
    { key: slug, name, summary, colour, path, icon, sort_order: order }
  );
  const created = getProject(Number(r.lastInsertRowid));
  record({ action: "create", entity: "project", entityId: created.id,
           summary: "created", label: created.name, after: created });
  return created;
}

function updateProject(id, fields) {
  const allowed = ["name", "summary", "status", "colour", "sort_order", "task_view", "path", "icon"];
  if (fields.task_view !== undefined && !TASK_VIEWS.includes(fields.task_view)) {
    throw new Error(`task_view must be one of ${TASK_VIEWS.join(", ")}`);
  }
  // status has a CHECK in the schema, but hitting it produces a message naming
  // the table and nothing else, which is the failure the task_view check above
  // exists to avoid. Stated here so both bad values fail the same readable way.
  if (fields.status !== undefined && !PROJECT_STATUSES.includes(fields.status)) {
    throw new Error(`status must be one of ${PROJECT_STATUSES.join(", ")}`);
  }
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return getProject(id);
  const before = rowOf("project", id);
  const assignments = sets.map((k) => `${k} = :${k}`).join(", ");
  run(`UPDATE projects SET ${assignments}, updated_at = datetime('now') WHERE id = :id`, {
    ...Object.fromEntries(sets.map((k) => [k, fields[k]])),
    id,
  });
  const after = getProject(id);

  // Nothing was recorded here until now, which left the audit trail exactly
  // inverted: archiving, the app's own put-this-away gesture, happened with no
  // entry and no way back, while the agent's create was the one project change
  // offering an undo button.
  //
  // A write that changed nothing is left out rather than filed as "no visible
  // change". Both the colour picker and the status select re-send the value they
  // are already showing, and a history of entries that did nothing is a history
  // nobody reads.
  if (before) {
    const summary = describeUpdate("project", before, after);
    if (summary !== "no visible change") {
      record({ action: "update", entity: "project", entityId: id, summary,
               label: after.name, before, after });
    }
  }
  return after;
}

/**
 * What a project holds, so a caller can say what it is about to destroy.
 *
 * listProjects carries open_count, total_count and note_count, which is what the
 * sidebar needs and not what a confirmation needs: nobody agrees to lose "three
 * things" without being told which three.
 *
 * subtasks_elsewhere is the work that only the "delete the tasks too" answer
 * takes: subtasks of this project's tasks that were moved into another project
 * and go anyway, because tasks.parent_id is ON DELETE CASCADE. It is counted
 * apart from tasks so the confirmation can name it, since it is the one part of
 * the loss that lands outside the project the person is looking at.
 */
function projectContents(id) {
  return one(
    `WITH RECURSIVE doomed(id) AS (
       SELECT id FROM tasks WHERE project_id = :id
       UNION
       SELECT t.id FROM tasks t JOIN doomed d ON t.parent_id = d.id
     )
     SELECT
       (SELECT COUNT(*) FROM tasks      WHERE project_id = :id) AS tasks,
       (SELECT COUNT(*) FROM notes      WHERE project_id = :id) AS notes,
       (SELECT COUNT(*) FROM links      WHERE project_id = :id) AS links,
       (SELECT COUNT(*) FROM organizers WHERE project_id = :id) AS organizers,
       (SELECT COUNT(*) FROM repos      WHERE project_id = :id) AS repos,
       (SELECT COUNT(*) FROM tasks
         WHERE id IN (SELECT id FROM doomed)
           AND (project_id IS NULL OR project_id != :id)) AS subtasks_elsewhere`,
    { id }
  );
}

/**
 * Deletes a project, keeping enough to put the whole thing back.
 *
 * The cascade in the schema is the wrong way round for this. notes, links,
 * organizers and repos are ON DELETE CASCADE while tasks is ON DELETE SET NULL,
 * so an unguarded DELETE destroys everything the project remembered and leaves
 * the work behind as orphans in All work. That is exactly backwards from what
 * anyone deleting a project expects, so the whole subtree is copied first, the
 * same way deleteTask copies its own.
 *
 * The tasks option is the one real choice: "keep" lets the SET NULL stand and
 * the work survives in All work, "delete" takes it with the project. Both are
 * reversible, and which one was taken is stored alongside the rows because undo
 * has to put them back differently: kept tasks are still there and want their
 * project back, deleted ones have to be inserted again.
 *
 * Organizers and repos ride inside this blob rather than being audited in their
 * own right. The audit entity column has a CHECK that cannot be widened on a
 * database that already exists, which is the dead end deleteOrganizer documents.
 *
 * The whole thing runs in one transaction. The snapshot, both deletes and the
 * audit row have to land together or not at all: a throw from record(), whose
 * summary is NOT NULL and whose before blob can be large, used to leave the
 * project already deleted with no stored copy anywhere, which is the one failure
 * that cannot be recovered from.
 */
function deleteProject(id, options = {}) {
  const conn = open();
  conn.exec("BEGIN");
  try {
    const result = deleteProjectRows(id, options);
    conn.exec("COMMIT");
    return result;
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
}

// The body of the above, without the transaction. undo() already holds one when
// it reverses a project creation, and SQLite has no nested BEGIN, so that path
// calls this directly rather than opening a second one.
function deleteProjectRows(id, { tasks = "keep" } = {}) {
  if (tasks !== "keep" && tasks !== "delete") {
    throw new Error('tasks must be either "keep" or "delete"');
  }
  const before = rowOf("project", id);
  if (!before) throw new Error("No such project");

  // Parents ahead of their children, because tasks.parent_id points at another
  // task and a child restored first has nothing to point at. Roots come first,
  // and among the rest a child always has the higher id, having been created
  // after the task it hangs off.
  //
  // Taking the tasks means taking more than the project's own rows. tasks.parent_id
  // is ON DELETE CASCADE, and "Move to <project>" sets project_id on a single
  // task, so a subtask can legitimately sit in another project and still goes
  // when its parent goes. Walking the closure first is what makes the count
  // honest, the stored copy complete and the delete something undo can reverse.
  // Keeping the tasks does not reach them: SET NULL only touches rows that
  // actually carry this project_id.
  const taskRows = tasks === "delete"
    ? all(
        `WITH RECURSIVE doomed(id) AS (
           SELECT id FROM tasks WHERE project_id = :id
           UNION
           SELECT t.id FROM tasks t JOIN doomed d ON t.parent_id = d.id
         )
         SELECT * FROM tasks WHERE id IN (SELECT id FROM doomed)
         ORDER BY parent_id IS NULL DESC, id`,
        { id }
      )
    : all(
        "SELECT * FROM tasks WHERE project_id = :id ORDER BY parent_id IS NULL DESC, id",
        { id }
      );
  const taskIds = taskRows.map((t) => t.id);
  const placeholders = taskIds.map((_, i) => `:id${i}`).join(", ");
  const params = Object.fromEntries(taskIds.map((v, i) => [`id${i}`, v]));
  const forTasks = (sql) => (taskIds.length ? all(sql, params) : []);

  before.__tasks_mode = tasks;
  before.__organizers = all("SELECT * FROM organizers WHERE project_id = :id", { id });
  before.__tasks = taskRows;
  // Only worth copying when the tasks themselves are going. Kept tasks keep
  // their own comments, history and reminders, and storing a second copy would
  // give undo two ways to disagree about them.
  if (tasks === "delete") {
    before.__comments = forTasks(`SELECT * FROM comments WHERE task_id IN (${placeholders})`);
    before.__events = forTasks(`SELECT * FROM status_events WHERE task_id IN (${placeholders})`);
    before.__alerts = forTasks(`SELECT * FROM alerts WHERE task_id IN (${placeholders})`);
  }
  before.__notes = all("SELECT * FROM notes WHERE project_id = :id", { id });
  before.__links = all("SELECT * FROM links WHERE project_id = :id", { id });
  before.__repos = all("SELECT * FROM repos WHERE project_id = :id", { id });
  // Sessions cascade from the project and messages cascade from the session, so
  // without copying both here a deleted project takes every conversation with it
  // and undo brings the project back empty.
  before.__sessions = all("SELECT * FROM sessions WHERE project_id = :id", { id });
  before.__messages = all(
    `SELECT m.* FROM messages m
      JOIN sessions s ON s.id = m.session_id
     WHERE s.project_id = :id`,
    { id }
  );

  // By id rather than by project_id, so the rows deleted are exactly the rows
  // copied above. Deleting by project_id would let the cascade reach subtasks
  // living elsewhere that the snapshot never saw.
  if (tasks === "delete" && taskIds.length) {
    run(`DELETE FROM tasks WHERE id IN (${placeholders})`, params);
  }
  run("DELETE FROM projects WHERE id = :id", { id });

  const counts = {
    tasks: taskRows.length,
    notes: before.__notes.length,
    links: before.__links.length,
    organizers: before.__organizers.length,
    repos: before.__repos.length,
    sessions: before.__sessions.length,
  };
  record({
    action: "delete",
    entity: "project",
    entityId: id,
    summary: tasks === "delete"
      ? `deleted with ${plural(counts.tasks, "task", "tasks")}`
      : counts.tasks
      ? `deleted, ${plural(counts.tasks, "task", "tasks")} kept in All work`
      : "deleted",
    label: before.name,
    before,
  });
  return { ok: true, name: before.name, tasksMode: tasks, counts };
}

/**
 * Checks an organizer is a legal home for a task, and says why when it is not.
 *
 * Both rules are about the relationship between two rows, and a CHECK
 * constraint only ever sees one, so neither can live in the schema.
 */
function assertOrganizerFits(organizerId, { projectId, parentId }) {
  if (organizerId == null) return null;
  // A subtask is reached through its parent, so it takes its parent's epic
  // rather than carrying one of its own. Two places to file the same piece of
  // work is how a grouping stops being worth trusting.
  if (parentId != null) throw new Error("A subtask takes its epic from its parent task");
  const organizer = one("SELECT * FROM organizers WHERE id = :id", { id: organizerId });
  if (!organizer) throw new Error("No such organizer");
  if (organizer.project_id !== projectId) {
    throw new Error("An organizer only holds tasks from its own project");
  }
  return organizer;
}

/**
 * Every organizer in a project, each with what it contains.
 *
 * Subtasks never carry an organizer_id, so the counts are stories rather than
 * pieces of stories, which is the number the header is asked for.
 */
function listOrganizers(projectId) {
  return all(
    `SELECT o.*,
            (SELECT COUNT(*) FROM tasks t WHERE t.organizer_id = o.id) AS total_count,
            (SELECT COUNT(*) FROM tasks t WHERE t.organizer_id = o.id AND t.status != 'done') AS open_count
     FROM organizers o
     WHERE o.project_id = :projectId
     ORDER BY o.sort_order, o.id`,
    { projectId }
  );
}

const getOrganizer = (id) => one("SELECT * FROM organizers WHERE id = :id", { id });

function createOrganizer({ projectId, name, summary = null, colour = null }) {
  if (!projectId) throw new Error("An organizer belongs to a project");
  if (!name || !String(name).trim()) throw new Error("An organizer needs a name");
  const order = one(
    "SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM organizers WHERE project_id = :projectId",
    { projectId }
  ).n;
  const r = run(
    `INSERT INTO organizers (project_id, name, summary, colour, sort_order)
     VALUES (:projectId, :name, :summary, :colour, :sort_order)`,
    { projectId, name: String(name).trim(), summary, colour, sort_order: order }
  );
  return getOrganizer(Number(r.lastInsertRowid));
}

function updateOrganizer(id, fields) {
  const allowed = ["name", "summary", "colour", "sort_order"];
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return getOrganizer(id);
  const assignments = sets.map((k) => `${k} = :${k}`).join(", ");
  run(`UPDATE organizers SET ${assignments}, updated_at = datetime('now') WHERE id = :id`, {
    ...Object.fromEntries(sets.map((k) => [k, fields[k]])),
    id,
  });
  return getOrganizer(id);
}

/**
 * Removes the shell and keeps the work.
 *
 * organizer_id is ON DELETE SET NULL, so the tasks stay exactly where they were
 * and lose only the grouping. Nothing is written to the audit table: its entity
 * column has a CHECK that cannot be widened on a database that already exists,
 * and filing an organizer under 'project' would leave undo trying to insert an
 * organizer's columns into the projects table. The count comes back so the
 * caller can say what it is about to loosen, since it cannot offer to undo it.
 */
function deleteOrganizer(id) {
  const organizer = getOrganizer(id);
  if (!organizer) return { ok: false, loosened: 0, name: null };
  const loosened = one("SELECT COUNT(*) AS n FROM tasks WHERE organizer_id = :id", { id }).n;
  run("DELETE FROM organizers WHERE id = :id", { id });
  return { ok: true, loosened, name: organizer.name };
}

// Tasks. Passing projectId of null means everything, which is what the All view
// and the search box use. organizerId narrows to one epic, or to the work that
// is in none when it is the string "none". A string rather than null for that,
// because null and "no filter" have to stay distinguishable across IPC.
function listTasks({ projectId = null, organizerId = null, includeDone = false, includeSubtasks = false } = {}) {
  const clauses = [];
  if (projectId !== null) clauses.push("t.project_id = :projectId");
  if (organizerId === "none") clauses.push("t.organizer_id IS NULL");
  else if (organizerId !== null) clauses.push("t.organizer_id = :organizerId");
  if (!includeDone) clauses.push("t.status != 'done'");
  // Subtasks are shown by their parent, not alongside it. Left in, a task broken
  // into six pieces makes the list longer rather than clearer, which is the
  // opposite of the point.
  if (!includeSubtasks) clauses.push("t.parent_id IS NULL");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const params = {};
  if (projectId !== null) params.projectId = projectId;
  if (organizerId !== null && organizerId !== "none") params.organizerId = organizerId;
  return all(
    `SELECT t.*, p.name AS project_name, p.colour AS project_colour,
            o.name AS organizer_name, o.colour AS organizer_colour,
            (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id) AS subtask_count,
            (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id AND s.status = 'done') AS subtask_done,
            (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count
     FROM tasks t
     LEFT JOIN projects p ON p.id = t.project_id
     LEFT JOIN organizers o ON o.id = t.organizer_id
     ${where}
     ORDER BY
       CASE t.status WHEN 'doing' THEN 0 WHEN 'blocked' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END,
       CASE t.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END,
       COALESCE(t.due, '9999-99-99'),
       t.id DESC`,
    params
  );
}

function createTask({
  projectId = null, title, detail = null, priority = "med", status = "todo",
  ref = null, due = null, parentId = null, assignee = null, organizerId = null, actor = null,
}) {
  // A subtask belongs to the same project as its parent whatever the caller
  // says, because a subtask filed somewhere else is not a subtask.
  if (parentId) {
    const parent = one("SELECT project_id FROM tasks WHERE id = :id", { id: parentId });
    if (!parent) throw new Error("No such parent task");
    projectId = parent.project_id;
    organizerId = null;
  }
  assertOrganizerFits(organizerId, { projectId, parentId });

  const r = run(
    // completed_at is derived from status here for the same reason updateTask
    // derives it, and only an importer ever creates a task that is already done.
    // Creating it as todo and updating it a statement later would stamp the
    // import time over the date the work actually finished, and leave a status
    // event saying it was open for a millisecond.
    `INSERT INTO tasks (project_id, title, detail, priority, status, ref, due, parent_id, assignee, organizer_id, source, completed_at)
     VALUES (:projectId, :title, :detail, :priority, :status, :ref, :due, :parentId, :assignee, :organizerId, 'app',
             CASE WHEN :status = 'done' THEN datetime('now') END)`,
    { projectId, title, detail, priority, status, ref, due, parentId, assignee, organizerId }
  );
  const created = one("SELECT * FROM tasks WHERE id = :id", { id: Number(r.lastInsertRowid) });
  // The opening status is an event like any other, so a timeline never starts
  // halfway through the story.
  run("INSERT INTO status_events (task_id, status, actor) VALUES (:id, :status, :actor)",
      { id: created.id, status: created.status, actor });
  record({ action: "create", entity: "task", entityId: created.id,
           summary: "created", label: created.title, after: created });
  return created;
}

function updateTask(id, fields, { actor = null } = {}) {
  const allowed = ["project_id", "title", "detail", "status", "priority", "owner", "due", "ref",
                   "assignee", "parent_id", "queue", "organizer_id", "colour"];
  // Rejected here rather than stored and ignored: a colour outside the palette
  // has no hex behind it in either theme, so it would paint nothing and look
  // like the write silently failed.
  if (fields.colour != null && !TASK_COLOURS.includes(fields.colour)) {
    throw new Error(`colour must be one of ${TASK_COLOURS.join(", ")}`);
  }
  // Read before the statement is assembled, because two of the rules below need
  // to know what the row currently is in order to decide what to write.
  const before = rowOf("task", id);
  const next = { ...fields };

  if (before) {
    const projectId = next.project_id !== undefined ? next.project_id : before.project_id;
    // An epic belongs to one project, so a task that leaves its project cannot
    // keep it. Cleared rather than refused: moving the task is the intent, and
    // the grouping is the only part of it that stops making sense.
    if (projectId !== before.project_id && next.organizer_id === undefined) next.organizer_id = null;
    if (next.organizer_id !== undefined) {
      assertOrganizerFits(next.organizer_id, {
        projectId,
        parentId: next.parent_id !== undefined ? next.parent_id : before.parent_id,
      });
    }
  }

  const sets = Object.keys(next).filter((k) => allowed.includes(k));
  if (!sets.length) return one("SELECT * FROM tasks WHERE id = :id", { id });
  const assignments = sets.map((k) => `${k} = :${k}`).join(", ");
  // completed_at is derived rather than passed in, so it can never disagree with status.
  const completed =
    next.status === "done"
      ? ", completed_at = datetime('now')"
      : next.status
      ? ", completed_at = NULL"
      : "";
  run(
    `UPDATE tasks SET ${assignments}, updated_at = datetime('now')${completed} WHERE id = :id`,
    { ...Object.fromEntries(sets.map((k) => [k, next[k]])), id }
  );
  const after = one("SELECT * FROM tasks WHERE id = :id", { id });
  // Written here rather than by callers, so the history cannot drift from the
  // column it describes. Only an actual change is recorded: setting a status to
  // what it already was is not a transition and should not look like one.
  if (before && after.status !== before.status) {
    run("INSERT INTO status_events (task_id, status, actor) VALUES (:id, :status, :actor)",
        { id, status: after.status, actor });
  }
  record({ action: "update", entity: "task", entityId: id,
           summary: describeUpdate("task", before, after), label: after.title,
           before, after });
  // The other half of the pad sync. After the audit row rather than before, so
  // the log reads in the order things happened, and unconditional rather than
  // gated on a flag the caller passes: ticking a task on the board has to tick
  // the line in the document whichever screen the tick came from.
  writeBackToPad(after, before);
  return after;
}

// ---------------------------------------------------------------------------
// The agent queue
//
// A pool an agent pulls from, rather than an assignment someone makes. Whichever
// agent asks next gets the next piece of work, which needs no scheduler and no
// knowledge of who is available.
//
// A claim is a lease, not an assignment. An agent that takes a task and then dies
// would otherwise hold it forever, which is how every queue discovers it needed
// expiry. Claiming takes the oldest highest-priority task whose lease is absent
// or expired, in one statement, so two agents asking at the same moment cannot
// get the same task.
// ---------------------------------------------------------------------------

const LEASE_MINUTES = 30;

/** Puts a task in a pool, or takes it out when queue is null. */
function setQueue(id, queue) {
  const before = rowOf("task", id);
  if (!before) throw new Error("No such task");
  run("UPDATE tasks SET queue = :queue, updated_at = datetime('now') WHERE id = :id", { id, queue });
  const after = one("SELECT * FROM tasks WHERE id = :id", { id });
  record({ action: "update", entity: "task", entityId: id,
           summary: queue ? `queued for agents (${queue})` : "taken out of the queue",
           label: after.title, before, after });
  return after;
}

/**
 * What is waiting, and what is being worked on, in one pool.
 *
 * The project is optional, and omitting it means the whole pool, which is what
 * the All view asks for. Passing one narrows to that project's share of the same
 * pool: the name still means what it always meant, and the project is a slice
 * through it rather than a second queue. A task with no project is therefore in
 * no project's queue and is only ever visible in the global view, which is the
 * honest reading of a filter on a column that is allowed to be NULL.
 */
function queueState(queue = "ready", projectId = null) {
  // Swept first, so what this reports is what an agent would actually be handed
  // rather than a picture that includes leases nobody is holding any more.
  const reclaimed = reclaimExpired(queue, projectId);
  const mine = projectId == null ? "" : "AND t.project_id = :projectId";
  const params = projectId == null ? { queue } : { queue, projectId };
  return {
    queue,
    projectId,
    reclaimed,
    waiting: all(
      // The project is joined in rather than looked up by the renderer, because
      // the global view needs a name for a project the renderer may not be
      // holding: its list hides archived projects, and a queued task can belong
      // to one.
      `SELECT t.id, t.title, t.priority, t.project_id, t.ref,
              p.name AS project_name, p.colour AS project_colour
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.queue = :queue AND t.status NOT IN ('done', 'blocked')
         AND (t.claimed_by IS NULL OR t.claim_expires < datetime('now'))
         ${mine}
       ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, t.id`,
      params
    ),
    claimed: all(
      `SELECT t.id, t.title, t.claimed_by, t.claim_expires FROM tasks t
       WHERE t.queue = :queue AND t.status != 'done'
         AND t.claimed_by IS NOT NULL AND t.claim_expires >= datetime('now')
         ${mine}
       ORDER BY t.claim_expires`,
      params
    ),
    // Recently finished, so the view can show work leaving the pool rather than
    // only what is still in it. Not filtered by the pool, and it cannot be:
    // finishing a task nulls its queue, so a done task carries no memory of
    // having been queued and there is nothing left to match on. The project can
    // be filtered, because project_id survives. The view says which of the two
    // it is showing rather than claiming this is the pool's own history.
    finished: all(
      `SELECT t.id, t.title, t.assignee, t.completed_at FROM tasks t
       WHERE t.status = 'done' AND t.completed_at IS NOT NULL
         AND t.completed_at > datetime('now', '-7 days')
         ${mine}
       ORDER BY t.completed_at DESC LIMIT 20`,
      projectId == null ? {} : { projectId }
    ),
  };
}

/**
 * Takes the next piece of work, atomically.
 *
 * The whole claim is one UPDATE with a subquery, because two statements with a
 * gap between them is exactly where two agents both win. An expired lease counts
 * as unclaimed, which is what makes a dead agent's task come back on its own
 * rather than needing a sweeper.
 *
 * This statement has a twin: agent/mcp_server.js queue_next runs the same claim
 * inline. The two cannot share code, because that server must run under a plain
 * Node with no better-sqlite3 and cannot read inside app.asar, so any change to
 * how a task is chosen has to be made in both or the app and the agents will
 * disagree about what is claimable.
 */
function claimNext({ queue = "ready", agent, minutes = LEASE_MINUTES, projectId = null }) {
  if (!agent) throw new Error("A claim needs to say who is claiming");
  const claimed = one(
    `UPDATE tasks
        SET claimed_by = :agent,
            claim_expires = datetime('now', '+' || :minutes || ' minutes'),
            status = CASE WHEN status = 'todo' THEN 'doing' ELSE status END,
            updated_at = datetime('now')
      WHERE id = (
        SELECT id FROM tasks
         WHERE queue = :queue
           -- Blocked work is not available work. Something outside this task is
           -- being waited on, and handing it to an agent produces an agent that
           -- discovers it is blocked and hands it straight back.
           AND status NOT IN ('done', 'blocked')
           AND (claimed_by IS NULL OR claim_expires < datetime('now'))
           ${projectId == null ? "" : "AND project_id = :projectId"}
         ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, id
         LIMIT 1
      )
      RETURNING *`,
    projectId == null ? { queue, agent, minutes } : { queue, agent, minutes, projectId }
  );
  if (!claimed) return null;

  // Only when the claim actually moved it. Nothing but todo can be claimed now,
  // so this is always a real todo to doing transition, and writing one
  // unconditionally would put a repeat of the current status on the timeline.
  if (claimed.status === "doing") {
    run("INSERT INTO status_events (task_id, status, actor) VALUES (:id, :status, :actor)",
        { id: claimed.id, status: claimed.status, actor: agent });
  }
  record({ action: "update", entity: "task", entityId: claimed.id,
           summary: `claimed by ${agent}`, label: claimed.title });
  return taskDetail(claimed.id);
}

/**
 * Pushes a claim's expiry out, for an agent still working.
 *
 * A lease is short so a dead agent's work comes back quickly, which makes a slow
 * but healthy agent the awkward case: it is still going when its lease runs out,
 * and without this the only honest options are a lease long enough to be useless
 * or losing the work. Renewing is refused once the lease has already lapsed,
 * because by then the task may belong to someone else and moving its expiry
 * would take it from them.
 */
function extendClaim(id, { agent, minutes = LEASE_MINUTES } = {}) {
  if (!agent) throw new Error("An extension needs to say who is asking");
  const task = one("SELECT * FROM tasks WHERE id = :id", { id });
  if (!task) throw new Error("No such task");
  if (!task.claimed_by) throw new Error("That task is not claimed");
  if (task.claimed_by !== agent) throw new Error(`That task is held by ${task.claimed_by}`);
  if (task.claim_expires && task.claim_expires < nowStamp()) {
    throw new Error("That claim has already expired. Claim it again rather than extending it.");
  }
  run(`UPDATE tasks SET claim_expires = datetime('now', '+' || :minutes || ' minutes'),
       updated_at = datetime('now') WHERE id = :id`, { id, minutes });
  const after = one("SELECT * FROM tasks WHERE id = :id", { id });
  record({ action: "update", entity: "task", entityId: id,
           summary: `claim extended by ${agent} to ${after.claim_expires}`, label: after.title });
  return after;
}

const nowStamp = () => one("SELECT datetime('now') AS n").n;

/**
 * Puts expired claims back in the pool, and says so on the timeline.
 *
 * claimNext already treats an expired lease as unclaimed, so this changes no
 * decision. What it changes is the record: without it a task silently goes from
 * "in progress, held by agent-2" to "someone else's", and the history says the
 * status moved with nobody moving it. Called on a schedule and before the queue
 * is shown, so what is on screen is what an agent would actually be handed.
 */
function reclaimExpired(queue = null, projectId = null) {
  const params = {};
  if (queue) params.queue = queue;
  if (projectId != null) params.projectId = projectId;
  const stale = all(
    `SELECT * FROM tasks
      WHERE claimed_by IS NOT NULL AND claim_expires IS NOT NULL
        AND claim_expires < datetime('now')
        AND status != 'done'
        ${queue ? "AND queue = :queue" : ""}
        ${projectId == null ? "" : "AND project_id = :projectId"}`,
    params
  );
  for (const task of stale) {
    const before = { ...task };
    run(`UPDATE tasks SET claimed_by = NULL, claim_expires = NULL,
         status = CASE WHEN status = 'doing' THEN 'todo' ELSE status END,
         updated_at = datetime('now') WHERE id = :id`, { id: task.id });
    const after = one("SELECT * FROM tasks WHERE id = :id", { id: task.id });
    if (after.status !== before.status) {
      run("INSERT INTO status_events (task_id, status, actor) VALUES (:id, :status, :actor)",
          { id: task.id, status: after.status, actor: `${task.claimed_by} (lease expired)` });
    }
    record({ action: "update", entity: "task", entityId: task.id,
             summary: `lease expired, ${task.claimed_by} lost the claim`,
             label: after.title, before, after });
  }
  return stale.map((t) => ({ id: t.id, title: t.title, agent: t.claimed_by, expired: t.claim_expires }));
}

/** Gives a task back without finishing it. */
function releaseClaim(id, { agent = null, note = null } = {}) {
  const before = rowOf("task", id);
  if (!before) throw new Error("No such task");
  run(`UPDATE tasks SET claimed_by = NULL, claim_expires = NULL,
       status = CASE WHEN status = 'doing' THEN 'todo' ELSE status END,
       updated_at = datetime('now') WHERE id = :id`, { id });
  if (note) createComment({ taskId: id, body: note, author: agent || "agent" });
  const after = one("SELECT * FROM tasks WHERE id = :id", { id });
  if (after.status !== before.status) {
    run("INSERT INTO status_events (task_id, status, actor) VALUES (:id, :status, :actor)",
        { id, status: after.status, actor: agent });
  }
  record({ action: "update", entity: "task", entityId: id,
           summary: `released by ${agent || "an agent"}`, label: after.title, before, after });
  return after;
}

/** Finishes a claimed task and takes it out of the pool. */
function completeClaim(id, { agent = null, note = null } = {}) {
  if (note) createComment({ taskId: id, body: note, author: agent || "agent" });
  const after = updateTask(id, { status: "done" }, { actor: agent });
  run(`UPDATE tasks SET claimed_by = NULL, claim_expires = NULL, queue = NULL WHERE id = :id`, { id });
  return one("SELECT * FROM tasks WHERE id = :id", { id });
}

// ---------------------------------------------------------------------------
// The task detail
// ---------------------------------------------------------------------------

const listComments = (taskId) =>
  all("SELECT * FROM comments WHERE task_id = :taskId ORDER BY id", { taskId });

/**
 * The task's comments as Sheet entries: kind, meta parsed, author type
 * resolved, the filed note's kind joined. The same shape sheet/store.js hands
 * the MCP tools, built by the same toEntry, so the rail and an agent read one
 * thing. listComments stays as it was for the vault and undo, which want rows.
 */
function sheetEntries(taskId) {
  const { toEntry } = require("./sheet/store");
  return all(
    `SELECT c.*, n.kind AS note_kind FROM comments c LEFT JOIN notes n ON n.id = c.note_id
      WHERE c.task_id = :taskId ORDER BY c.id`, { taskId }
  ).map(toEntry);
}

function createComment({ taskId, body, author = "you" }) {
  if (!body || !String(body).trim()) throw new Error("A comment needs something in it");
  const r = run(
    "INSERT INTO comments (task_id, author, body) VALUES (:taskId, :author, :body)",
    { taskId, author, body: String(body).trim() }
  );
  // Comments are not in the audit table's entity list, so the task carries the
  // trail. That keeps the History tab readable: "commented on X" belongs against
  // the task, not against a row nobody can navigate to.
  const task = one("SELECT * FROM tasks WHERE id = :id", { id: taskId });
  record({ action: "update", entity: "task", entityId: taskId,
           summary: `commented (by ${author})`, label: task ? task.title : null });
  return one("SELECT * FROM comments WHERE id = :id", { id: Number(r.lastInsertRowid) });
}

function deleteComment(id) {
  const comment = one("SELECT * FROM comments WHERE id = :id", { id });
  if (!comment) return { ok: false };
  run("DELETE FROM comments WHERE id = :id", { id });
  return { ok: true };
}

const statusEvents = (taskId) =>
  all("SELECT * FROM status_events WHERE task_id = :taskId ORDER BY at, id", { taskId });

// The same three aggregates listTasks computes, because the parent's Details tab
// shows subtasks as cards, and a card that cannot say "2/5" or how much has been
// said about it is missing the two facts that decide whether to open it.
const subtasks = (parentId) =>
  all(
    `SELECT t.*,
            (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id) AS subtask_count,
            (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id AND s.status = 'done') AS subtask_done,
            (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count
     FROM tasks t WHERE t.parent_id = :parentId ORDER BY t.id`,
    { parentId }
  );

/** Everything the detail view shows, in one call so it cannot half load. */
function taskDetail(id) {
  const task = one("SELECT * FROM tasks WHERE id = :id", { id });
  if (!task) return null;
  return {
    task,
    project: task.project_id
      ? one("SELECT id, name, colour FROM projects WHERE id = :id", { id: task.project_id })
      : null,
    parent: task.parent_id
      ? one("SELECT id, title, status FROM tasks WHERE id = :id", { id: task.parent_id })
      : null,
    organizer: task.organizer_id ? getOrganizer(task.organizer_id) : null,
    // The whole list rather than only the one it is in, so the sheet can offer a
    // change of epic without a second call. The sheet opens from All work and
    // from search too, where the project's organizers are not already loaded.
    organizers: task.project_id ? listOrganizers(task.project_id) : [],
    comments: sheetEntries(id),
    events: statusEvents(id),
    subtasks: subtasks(id),
  };
}

/**
 * Deletes a task, keeping enough to put the whole thing back.
 *
 * Subtasks, comments and status events are removed by ON DELETE CASCADE, and
 * none of them were being recorded. Restoring a deleted task therefore returned
 * an empty shell: the row came back, everything it contained did not, and the
 * activity list still said "restored". So the copy taken here is the subtree,
 * not the row.
 */
function deleteTask(id) {
  const before = rowOf("task", id);
  if (!before) return;

  // Grandchildren too. A subtask can have its own comments and history.
  const subtaskRows = all("SELECT * FROM tasks WHERE parent_id = :id", { id });
  const ids = [id, ...subtaskRows.map((s) => s.id)];
  const placeholders = ids.map((_, i) => `:id${i}`).join(", ");
  const params = Object.fromEntries(ids.map((v, i) => [`id${i}`, v]));

  before.__subtasks = subtaskRows;
  before.__comments = all(`SELECT * FROM comments WHERE task_id IN (${placeholders})`, params);
  before.__events = all(`SELECT * FROM status_events WHERE task_id IN (${placeholders})`, params);

  run("DELETE FROM tasks WHERE id = :id", { id });
  record({ action: "delete", entity: "task", entityId: id,
           summary: subtaskRows.length ? `deleted with ${subtaskRows.length} subtasks` : "deleted",
           label: before.title, before });
}

// Notes are the memory spots.
function listNotes(projectId) {
  return all(
    `SELECT * FROM notes WHERE project_id = :projectId
     ORDER BY pinned DESC, updated_at DESC`,
    { projectId }
  );
}

function createNote({ projectId, title, body = "", kind = "note" }) {
  const r = run(
    `INSERT INTO notes (project_id, title, body, kind) VALUES (:projectId, :title, :body, :kind)`,
    { projectId, title, body, kind }
  );
  const created = one("SELECT * FROM notes WHERE id = :id", { id: Number(r.lastInsertRowid) });
  record({ action: "create", entity: "note", entityId: created.id,
           summary: "created", label: created.title, after: created });
  return created;
}

function updateNote(id, fields) {
  const allowed = ["title", "body", "kind", "pinned"];
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return one("SELECT * FROM notes WHERE id = :id", { id });
  const assignments = sets.map((k) => `${k} = :${k}`).join(", ");
  const before = rowOf("note", id);
  run(`UPDATE notes SET ${assignments}, updated_at = datetime('now') WHERE id = :id`, {
    ...Object.fromEntries(sets.map((k) => [k, fields[k]])),
    id,
  });
  const after = one("SELECT * FROM notes WHERE id = :id", { id });
  record({ action: "update", entity: "note", entityId: id,
           summary: describeUpdate("note", before, after), label: after.title,
           before, after });
  return after;
}

function deleteNote(id) {
  const before = rowOf("note", id);
  run("DELETE FROM notes WHERE id = :id", { id });
  record({ action: "delete", entity: "note", entityId: id,
           summary: "deleted", label: before ? before.title : null, before });
}

// ---------------------------------------------------------------------------
// Scratchpads, and the tasks derived from them
//
// The board is a projection of the pads. A checkbox line in a pad is a task row,
// and the two are kept in step in both directions: writing the pad updates the
// tasks, and updating a task rewrites its line.
//
// Two rules keep that from being destructive, and both were chosen against the
// obvious alternative.
//
// A line that disappears does not delete its task. An agent tidying its own
// notes, or replacing a plan wholesale, would otherwise be able to empty a
// board. The task is left, and reads as dropped from the pad because nothing in
// the pad anchors it any more.
//
// An unticked box does not force a task back to todo. See pads.statusFor: a
// checkbox has two states and a task has four, so the pad owns "done or not"
// and the board owns the rest.
//
// pads.js has the grammar and no database access. This has the rows and no
// parsing. The split is what makes the grammar testable.
// ---------------------------------------------------------------------------

// Derivation writes tasks, and writing a task writes back to the pad. Without
// this the first pad write would recurse until the stack gave out. Set for the
// duration of a derivation, which is the only time a task update is already the
// consequence of a pad the caller is holding.
let deriving = false;

const listScratchpads = (projectId) =>
  all(
    `SELECT * FROM scratchpads WHERE project_id = :projectId
     ORDER BY pinned DESC, updated_at DESC`,
    { projectId }
  );

const getScratchpad = (id) => one("SELECT * FROM scratchpads WHERE id = :id", { id });

const scratchpadByKey = (projectId, key) =>
  one("SELECT * FROM scratchpads WHERE project_id = :projectId AND key = :key", { projectId, key });

/**
 * A key that is unique within its project.
 *
 * An agent naming a pad "plan" in two projects is asking for two pads, not one,
 * which is why the uniqueness is scoped. Within a project a collision is a
 * different pad wanting the same name, and it gets a number.
 */
function padKey(projectId, title, key = null) {
  const base = slugKey(key || title) || "pad";
  let candidate = base;
  let n = 2;
  while (scratchpadByKey(projectId, candidate)) candidate = `${base}-${n++}`;
  return candidate;
}

function createScratchpad({ projectId, title, body = "", key = null, author = null, sessionId = null, derivesTasks = true }) {
  const r = run(
    `INSERT INTO scratchpads (project_id, key, title, body, author, session_id, derives_tasks)
     VALUES (:projectId, :key, :title, :body, :author, :sessionId, :derivesTasks)`,
    {
      projectId, key: padKey(projectId, title, key), title, body, author,
      sessionId, derivesTasks: derivesTasks ? 1 : 0,
    }
  );
  const created = getScratchpad(Number(r.lastInsertRowid));
  record({ action: "create", entity: "scratchpad", entityId: created.id,
           summary: "created", label: created.title, after: created });
  return derive(created.id);
}

/**
 * Replaces a pad's body, and re-reads the board from it.
 *
 * One transaction over the write and the derivation, so a pad and its tasks can
 * never be half in step. That matters more here than anywhere else in this file:
 * the failure would be silent, and the thing left behind would be a board that
 * disagrees with the document everybody is reading.
 */
function writeScratchpad(id, fields = {}) {
  const allowed = ["title", "body", "author", "pinned", "derives_tasks", "session_id"];
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return getScratchpad(id);
  const before = rowOf("scratchpad", id);
  if (!before) throw new Error("No such scratchpad");

  const conn = open();
  conn.exec("BEGIN");
  try {
    run(
      `UPDATE scratchpads SET ${sets.map((k) => `${k} = :${k}`).join(", ")},
       updated_at = datetime('now') WHERE id = :id`,
      { ...Object.fromEntries(sets.map((k) => [k, fields[k]])), id }
    );
    deriveInPlace(id);
    conn.exec("COMMIT");
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }

  const after = getScratchpad(id);
  record({ action: "update", entity: "scratchpad", entityId: id,
           summary: describeUpdate("scratchpad", before, after), label: after.title,
           before, after });
  return after;
}

/** Adds to the end of a pad. The common agent write, and it cannot lose anything. */
function appendScratchpad(id, text) {
  const pad = getScratchpad(id);
  if (!pad) throw new Error("No such scratchpad");
  const joiner = !pad.body || pad.body.endsWith("\n") ? "" : "\n";
  return writeScratchpad(id, { body: `${pad.body}${joiner}${text}` });
}

/**
 * Replaces one markdown section, found by its heading.
 *
 * Here so two agents working the same pad do not have to read, edit and write
 * the whole document to change their own part of it, which is the write that
 * loses the other one's work. The heading is matched on its text, at any level,
 * and the section runs to the next heading of the same level or higher.
 */
function patchScratchpad(id, heading, text) {
  const pad = getScratchpad(id);
  if (!pad) throw new Error("No such scratchpad");
  const lines = pad.body.split("\n");
  const wanted = String(heading).trim().toLowerCase().replace(/^#+\s*/, "");

  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (m && m[2].trim().toLowerCase() === wanted) { start = i; level = m[1].length; break; }
  }
  // A heading that is not there is added rather than refused. An agent asking to
  // patch a section it has not written yet means to write it, and making that an
  // error would only teach it to read the whole pad first.
  if (start === -1) return appendScratchpad(id, `\n## ${heading}\n\n${text}\n`);

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  const body = [...lines.slice(0, start + 1), "", text, "", ...lines.slice(end)].join("\n");
  return writeScratchpad(id, { body });
}

function deleteScratchpad(id) {
  const before = rowOf("scratchpad", id);
  // The tasks outlive the pad, by the ON DELETE SET NULL on tasks.pad_id. Said
  // out loud because the opposite is what people expect from a cascade, and the
  // opposite is how a board gets emptied by a tidy-up.
  run("DELETE FROM scratchpads WHERE id = :id", { id });
  record({ action: "delete", entity: "scratchpad", entityId: id,
           summary: "deleted", label: before ? before.title : null, before });
}

/**
 * Reads a pad's checkbox lines into tasks, and anchors them.
 *
 * Runs inside whatever transaction the caller has open, which is why it does not
 * start one. deriveInPlace is the half that touches rows; derive is the wrapper
 * that returns the pad afterwards.
 */
function deriveInPlace(padId) {
  const pad = getScratchpad(padId);
  if (!pad || !pad.derives_tasks) return pad;

  deriving = true;
  try {
    let body = pad.body;
    // Re-parsed after every write, because anchoring a line changes its text and
    // the entries hold the offsets they were parsed at.
    let entries = pads.parse(body);
    const idByEntry = new Map();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const parentId = entry.parentIndex != null ? idByEntry.get(entry.parentIndex) ?? null : null;
      let task = entry.taskId ? one("SELECT * FROM tasks WHERE id = :id", { id: entry.taskId }) : null;

      // An anchor pointing at a task that has been deleted, or at one belonging
      // to another pad, is stale text rather than an instruction. Dropped, and
      // the line is treated as new.
      if (task && task.pad_id !== pad.id) task = null;

      if (!task) task = rebind(pad, entry, body);

      if (task) {
        const changes = {};
        if (task.title !== entry.title && entry.title) changes.title = entry.title;
        const status = pads.statusFor(entry.done, task.status);
        if (status !== task.status) changes.status = status;
        if (entry.assignee && entry.assignee !== task.assignee) changes.assignee = entry.assignee;
        if (entry.priority && entry.priority !== task.priority) changes.priority = entry.priority;
        if (parentId !== (task.parent_id ?? null)) changes.parent_id = parentId;
        if (Object.keys(changes).length) task = updateTask(task.id, changes, { actor: pad.author });
      } else {
        task = createTask({
          projectId: pad.project_id,
          title: entry.title || "Untitled",
          status: entry.done ? "done" : "todo",
          priority: entry.priority || "med",
          assignee: entry.assignee || null,
          parentId,
          actor: pad.author,
        });
      }

      run("UPDATE tasks SET pad_id = :padId, external_key = :key WHERE id = :id",
          { padId: pad.id, key: `pad:${pad.id}:${task.id}`, id: task.id });
      idByEntry.set(entry.at, task.id);

      if (entry.taskId !== task.id) {
        body = pads.anchorLine(body, entry, task.id);
        entries = pads.parse(body);
      }
    }

    if (body !== pad.body) {
      run("UPDATE scratchpads SET body = :body WHERE id = :id", { body, id: pad.id });
    }
  } finally {
    deriving = false;
  }
  return getScratchpad(padId);
}

/**
 * Finds the task an unanchored line used to be.
 *
 * The failure this exists for: an agent rewrites a pad from scratch and the
 * anchors go with the old text. Without this, every line comes back as new work
 * and the board doubles. With it, a line whose words exactly match a task this
 * pad owns, and which nothing else in the pad currently claims, is recognised as
 * that task again.
 *
 * Exact title match only. Fuzzy matching here would mean a plan that reworded
 * two similar items could silently merge them, and a wrong merge is much harder
 * to notice than a duplicate.
 */
function rebind(pad, entry, body) {
  if (!entry.title) return null;
  const claimed = pads.anchoredIds(body);
  const candidates = all(
    "SELECT * FROM tasks WHERE pad_id = :padId AND title = :title ORDER BY id",
    { padId: pad.id, title: entry.title }
  );
  return candidates.find((t) => !claimed.has(t.id)) || null;
}

const derive = (padId) => deriveInPlace(padId);

/**
 * Rewrites a task's line in its pad.
 *
 * The other direction of the sync, called from updateTask. Silent when the task
 * has no pad, when the pad has gone, or when we are already inside a derivation,
 * which is the case that would otherwise loop.
 */
function writeBackToPad(task, before) {
  if (deriving || !task || !task.pad_id) return;
  const pad = getScratchpad(task.pad_id);
  if (!pad || !pad.derives_tasks) return;
  const entry = pads.parse(pad.body).find((e) => e.taskId === task.id);
  if (!entry) return;

  const fields = {};
  if (!before || before.status !== task.status) fields.done = task.status === "done";
  if (!before || before.title !== task.title) fields.title = task.title;
  if (!before || before.assignee !== task.assignee) fields.assignee = task.assignee || null;
  if (!before || before.priority !== task.priority) fields.priority = task.priority;
  if (!Object.keys(fields).length) return;

  const body = pads.writeLine(pad.body, entry, fields);
  if (body === pad.body) return;
  run("UPDATE scratchpads SET body = :body, updated_at = datetime('now') WHERE id = :id",
      { body, id: pad.id });
}

/**
 * A pad's lines, each with the task behind it, for the editor to render.
 *
 * Also names the tasks the pad no longer mentions, which is the honest way to
 * show what a rewrite dropped: they are still on the board, and this is where
 * someone would go looking for why.
 */
function scratchpadTasks(padId) {
  const pad = getScratchpad(padId);
  if (!pad) return { lines: [], dropped: [] };
  const entries = pads.parse(pad.body);
  const anchored = new Set(entries.map((e) => e.taskId).filter(Boolean));
  const lines = entries.map((e) => ({
    ...e,
    task: e.taskId ? one("SELECT * FROM tasks WHERE id = :id", { id: e.taskId }) : null,
  }));
  const dropped = all("SELECT * FROM tasks WHERE pad_id = :padId ORDER BY id", { padId })
    .filter((t) => !anchored.has(t.id));
  return { lines, dropped };
}

function listLinks(projectId) {
  return all("SELECT * FROM links WHERE project_id = :projectId ORDER BY id", { projectId });
}

function createLink({ projectId, label, url, kind = "link" }) {
  const r = run(
    "INSERT INTO links (project_id, label, url, kind) VALUES (:projectId, :label, :url, :kind)",
    { projectId, label, url, kind }
  );
  const created = one("SELECT * FROM links WHERE id = :id", { id: Number(r.lastInsertRowid) });
  record({ action: "create", entity: "link", entityId: created.id,
           summary: "added link", label: created.label, after: created });
  return created;
}

function deleteLink(id) {
  const before = rowOf("link", id);
  run("DELETE FROM links WHERE id = :id", { id });
  record({ action: "delete", entity: "link", entityId: id,
           summary: "removed link", label: before ? before.label : null, before });
}

// Search covers task titles and note bodies. Notes go through the full text
// index; tasks are a LIKE because there are few enough that it does not matter.
function search(query) {
  const q = (query || "").trim();
  if (!q) return { tasks: [], notes: [] };
  const like = `%${q}%`;
  const tasks = all(
    `SELECT t.*, p.name AS project_name, p.colour AS project_colour
     FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.title LIKE :like OR t.detail LIKE :like OR t.ref LIKE :like
     ORDER BY t.status = 'done', t.id DESC LIMIT 50`,
    { like }
  );
  let notes = [];
  try {
    notes = all(
      `SELECT n.*, p.name AS project_name, p.colour AS project_colour
       FROM notes_fts f JOIN notes n ON n.id = f.rowid
       LEFT JOIN projects p ON p.id = n.project_id
       WHERE notes_fts MATCH :q ORDER BY rank LIMIT 50`,
      { q: `${q}*` }
    );
  } catch {
    // A malformed FTS expression (a bare quote, say) should degrade to a plain
    // match rather than blanking the results while someone is mid-word.
    notes = all(
      `SELECT n.*, p.name AS project_name, p.colour AS project_colour
       FROM notes n LEFT JOIN projects p ON p.id = n.project_id
       WHERE n.title LIKE :like OR n.body LIKE :like LIMIT 50`,
      { like }
    );
  }
  // Pads join the same search, through their own index. A working document is
  // often the only place a decision was written down before it became one, so
  // leaving them out would make search quietly worse the more the agents use it.
  let padHits = [];
  try {
    padHits = all(
      `SELECT s.*, p.name AS project_name, p.colour AS project_colour
       FROM pads_fts f JOIN scratchpads s ON s.id = f.rowid
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE pads_fts MATCH :q ORDER BY rank LIMIT 50`,
      { q: `${q}*` }
    );
  } catch {
    padHits = all(
      `SELECT s.*, p.name AS project_name, p.colour AS project_colour
       FROM scratchpads s LEFT JOIN projects p ON p.id = s.project_id
       WHERE s.title LIKE :like OR s.body LIKE :like LIMIT 50`,
      { like }
    );
  }
  return { tasks, notes, pads: padHits };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

// Everything due, so the scheduler can fire in one pass. Snoozed alerts come
// back through the same query because a snooze just moves fire_at forward.
function dueAlerts() {
  return all(`
    SELECT a.*, t.title AS task_title, t.status AS task_status, t.project_id,
           p.name AS project_name
    FROM alerts a
    JOIN tasks t ON t.id = a.task_id
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE a.status IN ('pending', 'snoozed')
      AND a.kind = 'reminder'
      AND a.fire_at <= datetime('now')
      AND t.status != 'done'
    ORDER BY a.fire_at
  `);
}

/**
 * Timers that are due: a session being woken rather than a person nudged.
 *
 * A separate query rather than a flag on the one above, because the join
 * differs. A reminder is about a task and is pointless once the task is done; a
 * timer is about a session and usually has no task at all, so the inner join
 * that makes the reminder query correct would silently drop every one of these.
 */
function dueTimers() {
  return all(`
    SELECT a.*, s.project_id, s.harness, s.title AS session_title
    FROM alerts a
    JOIN sessions s ON s.id = a.session_id
    WHERE a.status IN ('pending', 'snoozed')
      AND a.kind != 'reminder'
      AND a.fire_at <= datetime('now')
      AND s.status = 'active'
    ORDER BY a.fire_at
  `);
}

// taskId narrows to one task's reminders. Without it the sheet has to filter the
// global list, which stops at 200 rows, and a busy database quietly drops a
// task's older finished reminders off the end of it.
function listAlerts({ includeFinished = true, taskId = null } = {}) {
  const clauses = [];
  if (!includeFinished) clauses.push("a.status IN ('pending','snoozed','fired')");
  if (taskId) clauses.push("a.task_id = :taskId");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return all(`
    SELECT a.*, t.title AS task_title, t.status AS task_status, t.project_id,
           p.name AS project_name, p.colour AS project_colour
    FROM alerts a
    JOIN tasks t ON t.id = a.task_id
    LEFT JOIN projects p ON p.id = t.project_id
    ${where}
    ORDER BY CASE a.status WHEN 'fired' THEN 0 WHEN 'snoozed' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
             a.fire_at DESC
    LIMIT 200
  `, taskId ? { taskId } : {});
}

function createAlert({ taskId = null, fireAt, message = null, repeatEveryMinutes = null,
                      sessionId = null, kind = "reminder", payload = null }) {
  const r = run(
    `INSERT INTO alerts (task_id, fire_at, message, repeat_every_minutes, session_id, kind, payload)
     VALUES (:taskId, :fireAt, :message, :repeatEveryMinutes, :sessionId, :kind, :payload)`,
    {
      taskId, fireAt, message, repeatEveryMinutes, sessionId, kind,
      payload: payload && typeof payload === "object" ? JSON.stringify(payload) : payload,
    }
  );
  const created = one("SELECT * FROM alerts WHERE id = :id", { id: Number(r.lastInsertRowid) });
  // A reminder is a thing somebody set and may want to undo. A timer is
  // plumbing: one is written every time an agent waits on another, and putting
  // those in History would bury the changes worth reading.
  if (kind === "reminder") {
    record({ action: "create", entity: "task", entityId: taskId,
             summary: `reminder set for ${fireAt}`, label: message || null, after: created });
  }
  return created;
}

function updateAlert(id, fields) {
  const allowed = ["fire_at", "message", "status", "repeat_every_minutes"];
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return one("SELECT * FROM alerts WHERE id = :id", { id });
  const assignments = sets.map((k) => `${k} = :${k}`).join(", ");
  run(`UPDATE alerts SET ${assignments} WHERE id = :id`, {
    ...Object.fromEntries(sets.map((k) => [k, fields[k]])), id,
  });
  return one("SELECT * FROM alerts WHERE id = :id", { id });
}

function deleteAlert(id) {
  run("DELETE FROM alerts WHERE id = :id", { id });
}

// Marks an alert as shown. A repeating alert schedules its next appearance here
// rather than when it is acted on, so a reminder that is ignored still returns.
function markFired(id) {
  const alert = one("SELECT * FROM alerts WHERE id = :id", { id });
  if (!alert) return null;
  if (alert.repeat_every_minutes) {
    run(`UPDATE alerts SET status = 'fired', fired_at = datetime('now'),
         fire_at = datetime('now', '+' || :mins || ' minutes') WHERE id = :id`,
        { id, mins: alert.repeat_every_minutes });
  } else {
    run("UPDATE alerts SET status = 'fired', fired_at = datetime('now') WHERE id = :id", { id });
  }
  return one("SELECT * FROM alerts WHERE id = :id", { id });
}

function snoozeAlert(id, minutes) {
  run(`UPDATE alerts SET status = 'snoozed', snooze_count = snooze_count + 1,
       fire_at = datetime('now', '+' || :minutes || ' minutes') WHERE id = :id`,
      { id, minutes });
  return one("SELECT * FROM alerts WHERE id = :id", { id });
}

// Acting on an alert closes it. Deliberately does not touch the task: clicking a
// reminder means "I am looking at this now", not "this is finished".
function actOnAlert(id) {
  run("UPDATE alerts SET status = 'done', acted_at = datetime('now') WHERE id = :id", { id });
  return one("SELECT * FROM alerts WHERE id = :id", { id });
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

function listRepos(projectId) {
  return all("SELECT * FROM repos WHERE project_id = :projectId ORDER BY is_primary DESC, name",
             { projectId });
}

function createRepo({ projectId, name, path, isPrimary = 0 }) {
  // Only one primary per project, so setting a new one clears the old.
  if (isPrimary) run("UPDATE repos SET is_primary = 0 WHERE project_id = :projectId", { projectId });
  const r = run(
    `INSERT INTO repos (project_id, name, path, is_primary) VALUES (:projectId, :name, :path, :isPrimary)`,
    { projectId, name, path, isPrimary: isPrimary ? 1 : 0 }
  );
  return one("SELECT * FROM repos WHERE id = :id", { id: Number(r.lastInsertRowid) });
}

function setPrimaryRepo(id) {
  const repo = one("SELECT * FROM repos WHERE id = :id", { id });
  if (!repo) return null;
  run("UPDATE repos SET is_primary = 0 WHERE project_id = :projectId", { projectId: repo.project_id });
  run("UPDATE repos SET is_primary = 1 WHERE id = :id", { id });
  return one("SELECT * FROM repos WHERE id = :id", { id });
}

function deleteRepo(id) {
  run("DELETE FROM repos WHERE id = :id", { id });
}

// The most recently touched things, whatever kind they are.
//
// Tasks and notes are unioned so the list reads as "what has happened lately"
// rather than making someone check two places. Ordered by when a row was last
// touched rather than created, because editing a note is news too, and an item
// created and then revised should appear once, at its latest position.
function recentItems(limit = 10) {
  return all(`
    SELECT * FROM (
      SELECT 'task' AS item_type, t.id, t.title, t.status, t.priority, t.ref,
             NULL AS kind, t.created_at, t.updated_at,
             p.name AS project_name, p.colour AS project_colour, p.id AS project_id
      FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
      UNION ALL
      SELECT 'note' AS item_type, n.id, n.title, NULL, NULL, NULL,
             n.kind, n.created_at, n.updated_at,
             p.name, p.colour, p.id
      FROM notes n LEFT JOIN projects p ON p.id = n.project_id
    )
    ORDER BY updated_at DESC, id DESC
    LIMIT :limit
  `, { limit });
}

function stats() {
  return one(`
    SELECT
      (SELECT COUNT(*) FROM tasks WHERE status != 'done') AS open_tasks,
      (SELECT COUNT(*) FROM tasks WHERE status = 'done') AS done_tasks,
      (SELECT COUNT(*) FROM tasks WHERE status != 'done' AND due IS NOT NULL AND due < date('now')) AS overdue,
      (SELECT COUNT(*) FROM projects WHERE status = 'active') AS active_projects,
      (SELECT COUNT(*) FROM notes) AS notes
  `);
}

// ---------------------------------------------------------------------------
// Imported rows
//
// Anything imported has to be importable twice, and that needs a handle on the
// row that survives both a re-import and a person editing it afterwards. ref
// cannot be that handle: it is free text, it is in updateTask's allowlist, and
// the app lets anyone change it, so the first tidy-up would turn every following
// import into a duplicate. tasks.legacy_id is here for the same reason, from the
// last time this question came up.
//
// Keys are namespaced ("jira:HELIO-14"), so a second importer can share the
// column without either having to guess whose key it is reading.
// ---------------------------------------------------------------------------

const projectByKey = (key) => one("SELECT * FROM projects WHERE key = :key", { key });

const taskByExternalKey = (externalKey) =>
  one("SELECT * FROM tasks WHERE external_key = :externalKey", { externalKey });

/**
 * Creates a task an importer owns.
 *
 * Goes through createTask rather than writing its own INSERT, so an imported
 * task gets the same opening status event and the same audit row as one typed
 * into the app. The columns createTask does not take are stamped on afterwards:
 * external_key and source identify the importer, owner is the only mapped field
 * with nowhere to ride in, and completedAt is the upstream tracker's own record
 * of when this finished, which beats the moment the import happened to run.
 */
function createExternalTask({
  externalKey, source = "import", owner = null, status = null, completedAt = null, ...fields
}) {
  const created = createTask({ ...fields, status: status || undefined });
  run(
    `UPDATE tasks SET external_key = :externalKey, source = :source, owner = :owner,
            completed_at = COALESCE(:completedAt, completed_at)
       WHERE id = :id`,
    { externalKey, source, owner, completedAt, id: created.id }
  );
  return one("SELECT * FROM tasks WHERE id = :id", { id: created.id });
}

const organizerByExternalKey = (externalKey) =>
  one("SELECT * FROM organizers WHERE external_key = :externalKey", { externalKey });

/**
 * Creates an epic an importer owns.
 *
 * Matched on the key rather than the name, because renaming an epic upstream is
 * ordinary and re-importing after one should move the same shell rather than
 * leave the old one behind and build a second.
 */
function createExternalOrganizer({ externalKey, projectId, name, summary = null, colour = null }) {
  const created = createOrganizer({ projectId, name, summary, colour });
  run("UPDATE organizers SET external_key = :externalKey WHERE id = :id",
      { externalKey, id: created.id });
  return getOrganizer(created.id);
}

const commentByExternalKey = (externalKey) =>
  one("SELECT * FROM comments WHERE external_key = :externalKey", { externalKey });

function createExternalComment({ taskId, externalKey, body, author = "you" }) {
  const created = createComment({ taskId, body, author });
  run("UPDATE comments SET external_key = :externalKey WHERE id = :id", { externalKey, id: created.id });
  return one("SELECT * FROM comments WHERE id = :id", { id: created.id });
}

/**
 * Rewrites an imported comment whose text changed upstream.
 *
 * No audit row: a comment edited in Jira is not a change anyone made here, and
 * the History tab is for things that happened in Delphi.
 */
function updateExternalComment(id, body) {
  run("UPDATE comments SET body = :body, updated_at = datetime('now') WHERE id = :id",
      { id, body: String(body).trim() });
  return one("SELECT * FROM comments WHERE id = :id", { id });
}


// ---------------------------------------------------------------------------
// Sessions
//
// A session is a conversation with an agent, held against a project. It is
// stored rather than kept in memory because a session that does not survive a
// restart is a chat window, and the whole point of calling it a session is that
// you can come back to it.
//
// Messages are written as they arrive, including a partial assistant reply, so
// a stream that is interrupted leaves what it managed to say rather than
// nothing. That is why appendMessage and updateMessage are separate: one starts
// a turn, the other grows it.

function listSessions(projectId) {
  return all(
    `SELECT s.*,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
            (SELECT m.content FROM messages m
              WHERE m.session_id = s.id AND m.role = 'user'
              ORDER BY m.id LIMIT 1) AS opener
     FROM sessions s
     WHERE s.project_id = :projectId AND s.status != 'archived'
     ORDER BY s.updated_at DESC, s.id DESC`,
    { projectId }
  );
}

const getSession = (id) => one("SELECT * FROM sessions WHERE id = :id", { id });

/**
 * The next unused "Session N" in a project.
 *
 * Numbered rather than all called the same thing, because a column of four rows
 * reading "New session" tells you nothing about which is which. Taken from the
 * highest number already used rather than from the count, so deleting Session 2
 * does not make the next one collide with Session 3.
 *
 * A first message renames the session to what was asked, so this is what a
 * session is called only until it has been used.
 */
function nextSessionName(projectId) {
  const rows = all("SELECT title FROM sessions WHERE project_id = :projectId", { projectId });
  let highest = 0;
  for (const r of rows) {
    const m = /^Session (\d+)$/.exec(String(r.title || "").trim());
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return `Session ${highest + 1}`;
}

function createSession({
  projectId, title = null, agent = null, provider = null, model = null,
  workspaceId = null, harness = null, cwd = null,
}) {
  if (!projectId) throw new Error("A session needs a project");
  const r = run(
    `INSERT INTO sessions (project_id, workspace_id, title, agent, provider, model, harness, cwd)
     VALUES (:projectId, :workspaceId, :title, :agent, :provider, :model, :harness, :cwd)`,
    {
      projectId, workspaceId, title: title || nextSessionName(projectId),
      agent, provider, model, harness, cwd,
    }
  );
  // Not audited, even though the entity CHECK now admits 'session'. Undo replays
  // a stored "before" row, which is meaningless for a conversation, and a
  // deleted session takes its messages with it either way. What is worth
  // auditing is what the session did, and every one of those writes comes back
  // through the MCP server under the harness's own actor name.
  return getSession(Number(r.lastInsertRowid));
}

const RUN_STATES = ["idle", "running", "failed"];

function updateSession(id, fields) {
  const allowed = ["title", "agent", "provider", "model", "status", "tokens_in", "tokens_out",
                   "workspace_id", "auto_allow", "harness", "native_id", "cwd", "run_state",
                   "last_run_at"];
  // Validated here rather than by a CHECK, because ALTER TABLE could not have
  // added the constraint to a database that already exists and one rule that
  // holds on new installs only is worse than none.
  if (fields.run_state != null && !RUN_STATES.includes(fields.run_state)) {
    throw new Error(`run_state must be one of ${RUN_STATES.join(", ")}`);
  }
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return getSession(id);
  const assignments = sets.map((k) => `${k} = :${k}`).join(", ");
  run(`UPDATE sessions SET ${assignments}, updated_at = datetime('now') WHERE id = :id`, {
    ...Object.fromEntries(sets.map((k) => [k, fields[k]])),
    id,
  });
  return getSession(id);
}

// ---------------------------------------------------------------------------
// The harness registry
//
// Rows rather than code, so a flag that moves in the next Codex release is an
// edit in Settings and not a release of this. harness.js holds the four built-in
// definitions and the machinery that runs them; this holds the copies a person
// can change.
// ---------------------------------------------------------------------------

const listHarnesses = ({ includeDisabled = true } = {}) =>
  all(`SELECT * FROM harnesses ${includeDisabled ? "" : "WHERE enabled = 1"}
       ORDER BY sort_order, id`);

const getHarness = (key) => one("SELECT * FROM harnesses WHERE key = :key", { key });

/**
 * Puts the built-in harnesses in, and keeps the untouched ones current.
 *
 * The obvious version of this is INSERT OR IGNORE, and it is wrong in a way that
 * only shows up later: these CLIs move, so a shipped definition will need fixing,
 * and a row that is never updated means everybody who installed before the fix
 * keeps the broken flag forever. The first version of the Copilot row passed its
 * MCP config file without the @ prefix that CLI needs, and every existing
 * database would have kept doing that.
 *
 * The other obvious version, overwriting on every launch, is worse: somebody who
 * edited a command line had a reason, and silently reverting it is the failure
 * this whole table exists to avoid.
 *
 * So each row remembers what it was last seeded with. If it still matches, it
 * has not been touched and takes the new definition. If it does not, somebody
 * changed it and it is left exactly as they left it.
 */
function seedHarnesses(definitions) {
  definitions.forEach((h, i) => {
    const seeded = JSON.stringify({
      label: h.label, command: h.command || null, args: h.args,
      parser: h.parser, mcp_style: h.mcp_style,
    });
    const existing = getHarness(h.key);
    if (!existing) {
      run(
        `INSERT INTO harnesses (key, label, kind, command, args_json, parser, mcp_style, enabled, sort_order, seeded_json)
         VALUES (:key, :label, 'builtin', :command, :args, :parser, :mcpStyle, :enabled, :sort, :seeded)`,
        {
          key: h.key, label: h.label, command: h.command || null,
          args: JSON.stringify(h.args), parser: h.parser, mcpStyle: h.mcp_style,
          enabled: h.enabled === undefined ? 1 : h.enabled, sort: (i + 1) * 10, seeded,
        }
      );
      return;
    }
    if (existing.kind !== "builtin") return;
    const current = JSON.stringify({
      label: existing.label, command: existing.command, args: JSON.parse(existing.args_json),
      parser: existing.parser, mcp_style: existing.mcp_style,
    });
    // A row with no snapshot predates this and is treated as untouched, which is
    // true: there was no way to edit one before there was a settings panel.
    const untouched = !existing.seeded_json || existing.seeded_json === current;
    if (!untouched) return;
    // enabled is deliberately not in the snapshot and not written here. Turning a
    // harness off is a preference, not an edit to its definition, and it has to
    // survive a definition that changes underneath it.
    run(
      `UPDATE harnesses SET label = :label, command = :command, args_json = :args,
       parser = :parser, mcp_style = :mcpStyle, seeded_json = :seeded,
       updated_at = datetime('now') WHERE id = :id`,
      {
        label: h.label, command: h.command || null, args: JSON.stringify(h.args),
        parser: h.parser, mcpStyle: h.mcp_style, seeded, id: existing.id,
      }
    );
  });
  return listHarnesses();
}

const PARSERS = ["claude-stream-json", "codex-json", "copilot-json", "text"];

function updateHarness(id, fields) {
  const allowed = ["label", "command", "args_json", "parser", "mcp_style", "enabled", "sort_order"];
  if (fields.parser != null && !PARSERS.includes(fields.parser)) {
    throw new Error(`parser must be one of ${PARSERS.join(", ")}`);
  }
  // Rejected here rather than at spawn time. A malformed template fails inside a
  // child process, where the only symptom is a harness that never answers.
  if (fields.args_json != null) {
    let parsed;
    try { parsed = JSON.parse(fields.args_json); } catch { throw new Error("The argv template is not valid JSON"); }
    if (!Array.isArray(parsed)) throw new Error("The argv template must be a list");
  }
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return one("SELECT * FROM harnesses WHERE id = :id", { id });
  run(`UPDATE harnesses SET ${sets.map((k) => `${k} = :${k}`).join(", ")},
       updated_at = datetime('now') WHERE id = :id`,
      { ...Object.fromEntries(sets.map((k) => [k, fields[k]])), id });
  return one("SELECT * FROM harnesses WHERE id = :id", { id });
}

function createHarness({ key, label, command, args, parser = "text", mcpStyle = "none" }) {
  const slug = slugKey(key || label);
  if (!slug) throw new Error("A harness needs a key");
  if (getHarness(slug)) throw new Error(`A harness with the key '${slug}' already exists`);
  run(
    `INSERT INTO harnesses (key, label, kind, command, args_json, parser, mcp_style, sort_order)
     VALUES (:key, :label, 'custom', :command, :args, :parser, :mcpStyle,
             (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM harnesses))`,
    {
      key: slug, label: label || slug, command: command || null,
      args: JSON.stringify(args || ["-p", "{prompt}"]), parser, mcpStyle,
    }
  );
  return getHarness(slug);
}

/** Built-ins are disabled rather than removed, so the definition can come back. */
function deleteHarness(id) {
  const row = one("SELECT * FROM harnesses WHERE id = :id", { id });
  if (!row) return;
  if (row.kind === "builtin") return updateHarness(id, { enabled: 0 });
  run("DELETE FROM harnesses WHERE id = :id", { id });
  return null;
}

// ---------------------------------------------------------------------------
// Handoffs
//
// One agent asking another. The row outlives the turn that created it, which is
// the point: the sender's turn ends in seconds and the answer arrives in
// minutes, so there has to be somewhere durable for it to arrive.
// ---------------------------------------------------------------------------

const getHandoff = (id) => one("SELECT * FROM handoffs WHERE id = :id", { id });

const listHandoffs = ({ projectId = null, sessionId = null, status = null, limit = 50 } = {}) => {
  const where = [];
  if (projectId != null) where.push("h.project_id = :projectId");
  if (sessionId != null) where.push("(h.from_session_id = :sessionId OR h.to_session_id = :sessionId)");
  if (status) where.push("h.status = :status");
  return all(
    `SELECT h.*, t.title AS task_title,
            f.title AS from_title, f.harness AS from_harness,
            r.title AS to_title
     FROM handoffs h
     LEFT JOIN tasks t ON t.id = h.task_id
     LEFT JOIN sessions f ON f.id = h.from_session_id
     LEFT JOIN sessions r ON r.id = h.to_session_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY h.id DESC LIMIT :limit`,
    { projectId, sessionId, status, limit }
  );
};

function createHandoff({ projectId, fromSessionId = null, toHarness, request, taskId = null, context = null, wake = true }) {
  if (!projectId) throw new Error("A handoff needs a project");
  if (!toHarness) throw new Error("A handoff needs somebody to hand to");
  if (!request || !String(request).trim()) throw new Error("A handoff needs a request");
  const r = run(
    `INSERT INTO handoffs (project_id, from_session_id, to_harness, task_id, request, context_json, wake)
     VALUES (:projectId, :fromSessionId, :toHarness, :taskId, :request, :context, :wake)`,
    {
      projectId, fromSessionId, toHarness: String(toHarness), taskId,
      request: String(request),
      context: context ? JSON.stringify(context) : null,
      wake: wake ? 1 : 0,
    }
  );
  const created = getHandoff(Number(r.lastInsertRowid));
  record({ action: "create", entity: "handoff", entityId: created.id,
           summary: `asked ${created.to_harness}`, label: created.request.slice(0, 80), after: created });
  return created;
}

/**
 * Moves a handoff along.
 *
 * Every transition goes through here so the timestamps cannot drift from the
 * status they describe, which is the same reason status_events is written by
 * updateTask rather than by its callers.
 */
function updateHandoff(id, fields) {
  const before = getHandoff(id);
  if (!before) throw new Error("No such handoff");
  const allowed = ["status", "reply", "to_session_id", "wake"];
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return before;
  const stamps =
    fields.status === "running" ? ", started_at = datetime('now')"
    : ["ready", "failed", "cancelled"].includes(fields.status) ? ", finished_at = datetime('now')"
    : "";
  run(`UPDATE handoffs SET ${sets.map((k) => `${k} = :${k}`).join(", ")}${stamps} WHERE id = :id`,
      { ...Object.fromEntries(sets.map((k) => [k, fields[k]])), id });
  const after = getHandoff(id);
  if (before.status !== after.status) {
    record({ action: "update", entity: "handoff", entityId: id,
             summary: `${before.status} to ${after.status}`, label: after.request.slice(0, 80),
             before, after });
  }
  return after;
}

/** Everything queued, oldest first, for whatever is going to run them. */
const pendingHandoffs = () =>
  all("SELECT * FROM handoffs WHERE status = 'queued' ORDER BY id");

/**
 * How many handoffs this project has finished in the last hour.
 *
 * The circuit breaker. Two agents can hand work to each other, and each reply
 * wakes the other with a turn of its own, so a polite pair saying "thanks, one
 * more thing" is a loop that spends real money at machine speed with nobody
 * watching. Counting completions rather than tracking a chain depth, because the
 * MCP server writes these rows from a separate process and any depth it was
 * asked to carry would be a number an agent could get wrong.
 */
const handoffsSince = (projectId, hours = 1) =>
  one(
    `SELECT COUNT(*) AS n FROM handoffs
     WHERE project_id = :projectId AND finished_at IS NOT NULL
       AND finished_at > datetime('now', :window)`,
    { projectId, window: `-${hours} hours` }
  ).n;

// ---------------------------------------------------------------------------
// Locks
//
// The task claim, generalised. A lease and not a mutex: an agent that takes one
// and dies must not hold it forever, so everything here expires and the acquire
// is allowed to take over anything that has.
// ---------------------------------------------------------------------------

const LOCK_MINUTES = 15;

/**
 * Takes a lock, or reports who has it.
 *
 * One statement for the insert and one for the takeover, both relying on the
 * unique index, so two agents asking at the same moment cannot both win. The
 * read afterwards says who actually holds it, which is the answer either way.
 */
function acquireLock({ projectId, key, holder, note = null, minutes = LOCK_MINUTES }) {
  if (!projectId || !key || !holder) throw new Error("A lock needs a project, a key and a holder");
  run(
    `INSERT INTO locks (project_id, key, holder, note, expires_at)
     VALUES (:projectId, :key, :holder, :note, datetime('now', :window))
     ON CONFLICT (project_id, key) DO UPDATE SET
       holder = excluded.holder, note = excluded.note, expires_at = excluded.expires_at,
       created_at = datetime('now')
     WHERE locks.expires_at <= datetime('now') OR locks.holder = excluded.holder`,
    { projectId, key: String(key), holder, note, window: `+${Math.max(1, minutes)} minutes` }
  );
  const row = one("SELECT * FROM locks WHERE project_id = :projectId AND key = :key",
                  { projectId, key: String(key) });
  return { held: row.holder === holder, lock: row };
}

function releaseLock({ projectId, key, holder }) {
  const r = run(
    "DELETE FROM locks WHERE project_id = :projectId AND key = :key AND holder = :holder",
    { projectId, key: String(key), holder }
  );
  return { released: Number(r.changes) > 0 };
}

/** What is held right now. Expired rows are swept rather than reported. */
function listLocks(projectId = null) {
  run("DELETE FROM locks WHERE expires_at <= datetime('now')");
  return all(
    `SELECT * FROM locks ${projectId != null ? "WHERE project_id = :projectId" : ""} ORDER BY key`,
    { projectId }
  );
}

function deleteSession(id) {
  const before = getSession(id);
  if (!before) return null;
  // Messages go with it through ON DELETE CASCADE. Not audited, for the reason
  // given in createSession.
  run("DELETE FROM sessions WHERE id = :id", { id });
  return before;
}

const listMessages = (sessionId) =>
  all("SELECT * FROM messages WHERE session_id = :sessionId ORDER BY id", { sessionId });

function appendMessage({ sessionId, role, content = "", tokens = null, error = null }) {
  if (!sessionId) throw new Error("A message needs a session");
  const r = run(
    `INSERT INTO messages (session_id, role, content, tokens, error)
     VALUES (:sessionId, :role, :content, :tokens, :error)`,
    { sessionId, role, content, tokens, error }
  );
  // Touched so the session list stays in most-recent order without the caller
  // having to remember to do it.
  run("UPDATE sessions SET updated_at = datetime('now') WHERE id = :id", { id: sessionId });
  return one("SELECT * FROM messages WHERE id = :id", { id: Number(r.lastInsertRowid) });
}

function updateMessage(id, fields) {
  const allowed = ["content", "tokens", "error"];
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return one("SELECT * FROM messages WHERE id = :id", { id });
  const assignments = sets.map((k) => `${k} = :${k}`).join(", ");
  run(`UPDATE messages SET ${assignments} WHERE id = :id`, {
    ...Object.fromEntries(sets.map((k) => [k, fields[k]])),
    id,
  });
  return one("SELECT * FROM messages WHERE id = :id", { id });
}

/** Adds a completed turn's usage to the session's running totals. */
function addSessionUsage(id, { input = 0, output = 0 }) {
  run(
    `UPDATE sessions SET tokens_in = tokens_in + :input, tokens_out = tokens_out + :output,
                         updated_at = datetime('now')
     WHERE id = :id`,
    { id, input, output }
  );
  return getSession(id);
}


// ---------------------------------------------------------------------------
// Workspaces
//
// A folder, as a thing in its own right, joined to projects many to many. See
// the comment above the table in schema.sql for why it has to be a join and not
// a column.

const listWorkspaces = () =>
  all(`SELECT w.*,
              (SELECT COUNT(*) FROM project_workspaces pw WHERE pw.workspace_id = w.id) AS project_count
       FROM workspaces w ORDER BY w.sort_order, w.name`);

const getWorkspace = (id) => one("SELECT * FROM workspaces WHERE id = :id", { id });
const workspaceByPath = (path) => one("SELECT * FROM workspaces WHERE path = :path", { path });

function createWorkspace({ name, path, icon = null, colour = null }) {
  if (!path) throw new Error("A workspace needs a folder");
  const clean = String(path).replace(/\/+$/, "");

  // Choosing a folder that is already a workspace means opening it, not making a
  // second one. Returned rather than thrown so the caller does not have to tell
  // "already exists" apart from a real failure.
  const already = workspaceByPath(clean);
  if (already) return already;

  const label = name || clean.split("/").pop() || clean;
  const base = slugKey(label) || `w${Date.now()}`;
  let key = base;
  // Two folders of the same name in different places are ordinary, so the slug
  // is suffixed rather than the second one refused.
  let n = 2;
  while (one("SELECT 1 AS x FROM workspaces WHERE key = :key", { key })) {
    key = `${base}-${n}`;
    n += 1;
  }

  const order = one("SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM workspaces").n;
  const r = run(
    `INSERT INTO workspaces (key, name, path, icon, colour, sort_order)
     VALUES (:key, :name, :path, :icon, :colour, :sort_order)`,
    { key, name: label, path: clean, icon, colour, sort_order: order }
  );
  return getWorkspace(Number(r.lastInsertRowid));
}

function updateWorkspace(id, fields) {
  const allowed = ["name", "path", "icon", "colour", "sort_order"];
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return getWorkspace(id);
  const assignments = sets.map((k) => `${k} = :${k}`).join(", ");
  run(`UPDATE workspaces SET ${assignments}, updated_at = datetime('now') WHERE id = :id`, {
    ...Object.fromEntries(sets.map((k) => [k, fields[k]])),
    id,
  });
  return getWorkspace(id);
}

function deleteWorkspace(id) {
  const before = getWorkspace(id);
  if (!before) return null;
  // The join goes with it through ON DELETE CASCADE. The projects do not: work
  // that spanned four folders still exists when one of them is forgotten, and
  // the folder on disk is never touched.
  run("DELETE FROM workspaces WHERE id = :id", { id });
  return before;
}

/** The projects that touch a folder. */
const projectsInWorkspace = (workspaceId) =>
  all(`SELECT p.*, pw.is_primary,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status != 'done') AS open_count,
              (SELECT COUNT(*) FROM notes n WHERE n.project_id = p.id) AS note_count
       FROM projects p
       JOIN project_workspaces pw ON pw.project_id = p.id
       WHERE pw.workspace_id = :workspaceId AND p.status != 'archived'
       ORDER BY p.sort_order, p.name`,
    { workspaceId });

/** The folders a project touches, primary first. */
const workspacesForProject = (projectId) =>
  all(`SELECT w.*, pw.is_primary
       FROM workspaces w
       JOIN project_workspaces pw ON pw.workspace_id = w.id
       WHERE pw.project_id = :projectId
       ORDER BY pw.is_primary DESC, w.name`,
    { projectId });

function linkProjectWorkspace(projectId, workspaceId, { primary = false } = {}) {
  run(`INSERT OR IGNORE INTO project_workspaces (project_id, workspace_id, is_primary)
       VALUES (:projectId, :workspaceId, :primary)`,
      { projectId, workspaceId, primary: primary ? 1 : 0 });
  if (primary) {
    run("UPDATE project_workspaces SET is_primary = 0 WHERE project_id = :projectId", { projectId });
    run(`UPDATE project_workspaces SET is_primary = 1
         WHERE project_id = :projectId AND workspace_id = :workspaceId`, { projectId, workspaceId });
  }
  return workspacesForProject(projectId);
}

const unlinkProjectWorkspace = (projectId, workspaceId) => {
  run(`DELETE FROM project_workspaces
       WHERE project_id = :projectId AND workspace_id = :workspaceId`, { projectId, workspaceId });
  return workspacesForProject(projectId);
};

/**
 * Turns the old one folder per project column into workspaces.
 *
 * Runs once at open and is safe to repeat: createWorkspace returns the existing
 * row for a path it already holds, and the link is INSERT OR IGNORE. projects.
 * path is left in place rather than dropped, because SQLite cannot drop a column
 * on an old database and a stale copy that nothing reads is harmless.
 */
function adoptProjectPaths() {
  const withPath = all("SELECT id, name, path, icon FROM projects WHERE path IS NOT NULL AND path != ''");
  for (const p of withPath) {
    const w = createWorkspace({ name: p.path.split("/").pop(), path: p.path, icon: p.icon });
    linkProjectWorkspace(p.id, w.id, { primary: true });
  }
  return withPath.length;
}

module.exports = {
  DB_PATH,
  // The graph builder works against the connection directly, so it is exposed
  // rather than every graph query being proxied through this module.
  handle: open,
  // For the stores shared with the MCP server. See sqlP.
  sqlP,
  listProjects, listArchivedProjects, getProject, createProject, updateProject, deleteProject,
  projectContents,
  listTasks, createTask, updateTask,
  listOrganizers, getOrganizer, createOrganizer, updateOrganizer, deleteOrganizer,
  // Exported because createProject now normalises the key it is given, so anyone
  // looking a project up by a key they built themselves has to look it up in the
  // same shape it was stored in or they will miss it and try to create it again.
  projectByKey, slugKey, taskByExternalKey, createExternalTask,
  organizerByExternalKey, createExternalOrganizer,
  commentByExternalKey, createExternalComment, updateExternalComment, deleteTask,
  taskDetail, listComments, createComment, deleteComment, statusEvents, subtasks,
  setQueue, queueState, claimNext, releaseClaim, completeClaim, extendClaim, reclaimExpired,
  listNotes, createNote, updateNote, deleteNote,
  listScratchpads, getScratchpad, scratchpadByKey, createScratchpad, writeScratchpad,
  appendScratchpad, patchScratchpad, deleteScratchpad, scratchpadTasks, derive,
  listLinks, createLink, deleteLink,
  search, stats,
  listAudit, projectActivity, undo, undoLast,
  recentItems,
  dueAlerts, dueTimers, listAlerts, createAlert, updateAlert, deleteAlert,
  markFired, snoozeAlert, actOnAlert,
  listRepos, createRepo, setPrimaryRepo, deleteRepo,
  listWorkspaces, getWorkspace, workspaceByPath, createWorkspace, updateWorkspace, deleteWorkspace,
  projectsInWorkspace, workspacesForProject, linkProjectWorkspace, unlinkProjectWorkspace,
  adoptProjectPaths,
  listSessions, getSession, createSession, updateSession, deleteSession,
  listHarnesses, getHarness, seedHarnesses, createHarness, updateHarness, deleteHarness,
  listHandoffs, getHandoff, createHandoff, updateHandoff, pendingHandoffs, handoffsSince,
  acquireLock, releaseLock, listLocks,
  listMessages, appendMessage, updateMessage, addSessionUsage,
};
