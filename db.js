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

const DB_PATH = path.join(__dirname, "brain.db");

let db;

function open() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA foreign_keys = ON");
  // Schema is idempotent, so applying it on every open keeps a hand-copied
  // database in step without a migration framework.
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  return db;
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
    } else if (key === "body" || key === "detail") {
      changes.push(`edited ${key}`);
    } else {
      changes.push(`${key} changed`);
    }
  }
  return changes.length ? changes.join(", ") : "no visible change";
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
    const cols = Object.keys(before);
    run(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => ":" + c).join(", ")})`,
      before
    );
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
  const allowed = ["name", "summary", "status", "colour", "sort_order"];
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return getProject(id);
  const assignments = sets.map((k) => `${k} = :${k}`).join(", ");
  run(`UPDATE projects SET ${assignments}, updated_at = datetime('now') WHERE id = :id`, {
    ...Object.fromEntries(sets.map((k) => [k, fields[k]])),
    id,
  });
  return getProject(id);
}

// Tasks. Passing projectId of null means everything, which is what the All view
// and the search box use.
function listTasks({ projectId = null, includeDone = false } = {}) {
  const clauses = [];
  if (projectId !== null) clauses.push("t.project_id = :projectId");
  if (!includeDone) clauses.push("t.status != 'done'");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return all(
    `SELECT t.*, p.name AS project_name, p.colour AS project_colour
     FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
     ${where}
     ORDER BY
       CASE t.status WHEN 'doing' THEN 0 WHEN 'blocked' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END,
       CASE t.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END,
       COALESCE(t.due, '9999-99-99'),
       t.id DESC`,
    projectId !== null ? { projectId } : {}
  );
}

function createTask({ projectId = null, title, detail = null, priority = "med", ref = null, due = null }) {
  const r = run(
    `INSERT INTO tasks (project_id, title, detail, priority, ref, due, source)
     VALUES (:projectId, :title, :detail, :priority, :ref, :due, 'app')`,
    { projectId, title, detail, priority, ref, due }
  );
  const created = one("SELECT * FROM tasks WHERE id = :id", { id: Number(r.lastInsertRowid) });
  record({ action: "create", entity: "task", entityId: created.id,
           summary: "created", label: created.title, after: created });
  return created;
}

function updateTask(id, fields) {
  const allowed = ["project_id", "title", "detail", "status", "priority", "owner", "due", "ref"];
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return one("SELECT * FROM tasks WHERE id = :id", { id });
  const assignments = sets.map((k) => `${k} = :${k}`).join(", ");
  // completed_at is derived rather than passed in, so it can never disagree with status.
  const completed =
    fields.status === "done"
      ? ", completed_at = datetime('now')"
      : fields.status
      ? ", completed_at = NULL"
      : "";
  const before = rowOf("task", id);
  run(
    `UPDATE tasks SET ${assignments}, updated_at = datetime('now')${completed} WHERE id = :id`,
    { ...Object.fromEntries(sets.map((k) => [k, fields[k]])), id }
  );
  const after = one("SELECT * FROM tasks WHERE id = :id", { id });
  record({ action: "update", entity: "task", entityId: id,
           summary: describeUpdate("task", before, after), label: after.title,
           before, after });
  return after;
}

function deleteTask(id) {
  const before = rowOf("task", id);
  run("DELETE FROM tasks WHERE id = :id", { id });
  record({ action: "delete", entity: "task", entityId: id,
           summary: "deleted", label: before ? before.title : null, before });
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

function listAlerts({ includeFinished = true } = {}) {
  const where = includeFinished ? "" : "WHERE a.status IN ('pending','snoozed','fired')";
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
  `);
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

module.exports = {
  DB_PATH,
  // The graph builder works against the connection directly, so it is exposed
  // rather than every graph query being proxied through this module.
  handle: open,
  listProjects, getProject, createProject, updateProject,
  listTasks, createTask, updateTask, deleteTask,
  listNotes, createNote, updateNote, deleteNote,
  listLinks, createLink, deleteLink,
  search, stats,
  listAudit, undo, undoLast,
  dueAlerts, listAlerts, createAlert, updateAlert, deleteAlert,
  markFired, snoozeAlert, actOnAlert,
  listRepos, createRepo, setPrimaryRepo, deleteRepo,
};
