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
  // file, so an older database would fail to open at all.
  addLaterColumns(db);
  db.exec(schema);
  return db;
}

/**
 * Adds columns that arrived after a database was first created.
 *
 * schema.sql stays idempotent because everything in it is CREATE ... IF NOT
 * EXISTS, but SQLite has no ADD COLUMN IF NOT EXISTS, so a new column on an
 * existing table cannot live there alone. Rather than bring in a migration
 * framework and a version table for what has so far only ever been added
 * columns, each one is named here and applied when it is missing.
 *
 * The column is also declared in schema.sql, so a fresh database gets it from
 * there and this finds nothing to do. Anything more structural than an added
 * column should get a real migration rather than an entry here.
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
  ["tasks", "colour", "TEXT"],
];

function addLaterColumns(db) {
  for (const [table, column, definition] of LATER_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    // No rows means the table does not exist yet, which is a brand new database.
    // schema.sql is about to create it with the column already in place.
    if (!columns.length) continue;
    if (columns.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const all = (sql, params = {}) => open().prepare(sql).all(params);
const one = (sql, params = {}) => open().prepare(sql).get(params);
const run = (sql, params = {}) => open().prepare(sql).run(params);

// ---------------------------------------------------------------------------
// Audit
//
// Every mutation records the row before and after. Undo replays the stored
// "before", so there is one mechanism rather than two that can disagree: if a
// change is in the log it can be reversed, and if it cannot be reversed it is
// not in the log.
// ---------------------------------------------------------------------------

const TABLES = { task: "tasks", note: "notes", project: "projects", link: "links" };

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
      changes.push(after[key] === "done" ? "marked done" : `status ${before[key]} to ${after[key]}`);
    } else if (key === "project_id") {
      changes.push("moved project");
    } else if (key === "organizer_id") {
      changes.push(after[key] == null ? "taken out of its epic" : "filed under an epic");
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
    `SELECT id, at, action, entity, entity_id, summary, label, undone, undone_at
     FROM audit ORDER BY id DESC LIMIT :limit`,
    { limit }
  );
}

// Reverses one entry. Deliberately does not itself write an audit row: an undo
// that appears in the log as another change makes the list confusing and invites
// undoing an undo. The entry is marked undone instead, so the history stays
// truthful about what happened.
function undo(auditId) {
  const entry = one("SELECT * FROM audit WHERE id = :id", { id: auditId });
  if (!entry) throw new Error("No such audit entry");
  if (entry.undone) throw new Error("That change has already been undone");

  const table = TABLES[entry.entity];
  const before = entry.before_json ? JSON.parse(entry.before_json) : null;

  if (entry.action === "create") {
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
    // The parent first, then everything that pointed at it, or the foreign keys
    // have nothing to point at.
    for (const [key, rows] of [["__subtasks", "tasks"], ["__comments", "comments"], ["__events", "status_events"]]
           .map(([k, t]) => [t, carried[k] || []])) {
      for (const row of rows) {
        const rowCols = Object.keys(row);
        run(
          `INSERT OR IGNORE INTO ${key} (${rowCols.join(", ")}) VALUES (${rowCols.map((c) => ":" + c).join(", ")})`,
          row
        );
      }
    }
  }

  run("UPDATE audit SET undone = 1, undone_at = datetime('now') WHERE id = :id", { id: auditId });
  return listAudit(100);
}

function undoLast(count = 1) {
  const pending = all(
    "SELECT id FROM audit WHERE undone = 0 ORDER BY id DESC LIMIT :count",
    { count }
  );
  // Newest first, so a sequence of changes to the same row unwinds in the right
  // order rather than leaving an older state on top.
  for (const row of pending) undo(row.id);
  return pending.length;
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

function getProject(id) {
  return one("SELECT * FROM projects WHERE id = :id", { id });
}

function createProject({ key, name, summary = null, colour = "#7c8698" }) {
  const order = one("SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM projects").n;
  const r = run(
    `INSERT INTO projects (key, name, summary, colour, sort_order)
     VALUES (:key, :name, :summary, :colour, :sort_order)`,
    { key, name, summary, colour, sort_order: order }
  );
  return getProject(Number(r.lastInsertRowid));
}

function updateProject(id, fields) {
  const allowed = ["name", "summary", "status", "colour", "sort_order", "task_view"];
  if (fields.task_view !== undefined && !TASK_VIEWS.includes(fields.task_view)) {
    throw new Error(`task_view must be one of ${TASK_VIEWS.join(", ")}`);
  }
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return getProject(id);
  const assignments = sets.map((k) => `${k} = :${k}`).join(", ");
  run(`UPDATE projects SET ${assignments}, updated_at = datetime('now') WHERE id = :id`, {
    ...Object.fromEntries(sets.map((k) => [k, fields[k]])),
    id,
  });
  return getProject(id);
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

/** What is waiting, and what is being worked on, in one pool. */
function queueState(queue = "ready") {
  return {
    queue,
    waiting: all(
      `SELECT id, title, priority, project_id, ref FROM tasks
       WHERE queue = :queue AND status NOT IN ('done', 'blocked')
         AND (claimed_by IS NULL OR claim_expires < datetime('now'))
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, id`,
      { queue }
    ),
    claimed: all(
      `SELECT id, title, claimed_by, claim_expires FROM tasks
       WHERE queue = :queue AND status != 'done'
         AND claimed_by IS NOT NULL AND claim_expires >= datetime('now')
       ORDER BY claim_expires`,
      { queue }
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
 */
function claimNext({ queue = "ready", agent, minutes = LEASE_MINUTES }) {
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
         ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, id
         LIMIT 1
      )
      RETURNING *`,
    { queue, agent, minutes }
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
    comments: listComments(id),
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
  return { tasks, notes };
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
      AND a.fire_at <= datetime('now')
      AND t.status != 'done'
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

function createAlert({ taskId, fireAt, message = null, repeatEveryMinutes = null }) {
  const r = run(
    `INSERT INTO alerts (task_id, fire_at, message, repeat_every_minutes)
     VALUES (:taskId, :fireAt, :message, :repeatEveryMinutes)`,
    { taskId, fireAt, message, repeatEveryMinutes }
  );
  const created = one("SELECT * FROM alerts WHERE id = :id", { id: Number(r.lastInsertRowid) });
  record({ action: "create", entity: "task", entityId: taskId,
           summary: `reminder set for ${fireAt}`, label: message || null, after: created });
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

module.exports = {
  DB_PATH,
  // The graph builder works against the connection directly, so it is exposed
  // rather than every graph query being proxied through this module.
  handle: open,
  listProjects, getProject, createProject, updateProject,
  listTasks, createTask, updateTask,
  listOrganizers, getOrganizer, createOrganizer, updateOrganizer, deleteOrganizer,
  projectByKey, taskByExternalKey, createExternalTask,
  commentByExternalKey, createExternalComment, updateExternalComment, deleteTask,
  taskDetail, listComments, createComment, deleteComment, statusEvents, subtasks,
  setQueue, queueState, claimNext, releaseClaim, completeClaim,
  listNotes, createNote, updateNote, deleteNote,
  listLinks, createLink, deleteLink,
  search, stats,
  listAudit, projectActivity, undo, undoLast,
  recentItems,
  dueAlerts, listAlerts, createAlert, updateAlert, deleteAlert,
  markFired, snoozeAlert, actOnAlert,
  listRepos, createRepo, setPrimaryRepo, deleteRepo,
};
