/**
 * Who made a change, the History row that says so, and when that row may be undone.
 *
 * Shared by the app and the MCP server in the mould of sheet/store.js: SQL text
 * and rules, handed a sql(query, params) function in the server's :p1 style and
 * a batch(statements) that runs a list of them as one transaction. No requires,
 * so it loads under a plain Node from Resources/ as well as inside app.asar.
 *
 * Attribution used to be text: the server, the Sheet and the item store wrote
 * " (by <actor>)" on the end of summary, the window wrote nothing, and the
 * session existed only inside the actor string. Parsing that is not a
 * foundation for undoing what a session did, so every writer now fills actor,
 * actor_type, session_id, job_id and step from here. The suffix is still
 * written, because the command line, recent_activity and every older row are
 * read that way.
 *
 * Both sides of a change are recorded in the same batch as the change. On the
 * sqlite3 route each sql() call is its own process, so a row read in one call
 * can be changed by another writer before the next; the before and after here
 * are therefore taken by SQL inside the batch (json_object over the row), not
 * read beforehand and written back as a literal.
 */

// The rows undo can put back, by audit entity. handoff and session are in the
// audit CHECK too, but their rows are a job's or a session's own bookkeeping:
// there is no table row to replay, and undoing one used to fail with an SQL
// error that also stopped undoLast dead.
// A layout is a page's arrangement (Edit this page); only the window writes
// one, and undo puts back the JSON it held.
const TABLES = { task: "tasks", note: "notes", project: "projects", link: "links", scratchpad: "scratchpads", layout: "layouts" };
const BOOKKEEPING = ["handoff", "session"];
// A session can only be moved (items/store.js never copies or associates
// one), and undoLast() selects exactly that.
const ITEM_OPS = ["move"];
const LABELS = { task: "title", note: "title", project: "name", link: "label", scratchpad: "title", layout: "screen" };

// Columns a later write may change without that being a change anyone made to
// the item. updated_at moves on every write; the rest are the pad sync's
// anchors and a claim's lease, which expire and are rewritten on their own.
const NOT_COMPARED = new Set(["updated_at"]);
// A create is compared on every field, so its list also takes the order a
// person drags things into, which is not recorded as a change.
const NOT_COMPARED_ON_CREATE = new Set(["updated_at", "pad_id", "external_key", "claim_expires", "completed_at", "sort_order"]);

// The jobs and Workbenches that keep a task's folder or a running agent. A
// task deleted under one orphans a folder on disk or a job mid-turn.
const OPEN_JOBS = "('queued', 'needs_approval', 'running', 'waiting_on_human')";
const LIVE_BENCH = "('active', 'parked', 'missing', 'closing')";

const AUTHOR_TYPES = ["human", "agent", "tool"];

const wholeNumber = (value) => (/^\d+$/.test(String(value == null ? "" : value).trim()) && Number(value) > 0 ? Number(value) : null);

/**
 * Who a process writes as, from the environment it was launched with.
 *
 * The session is DELPHI_SESSION, or the number in an actor shaped
 * <harness>:<sessionId>, which is how harness.js names a tab's agent. Only a
 * bare number counts: the Sheet chat is <harness>:chat-<taskId> and a job is
 * <harness>:job-<id>, and reading either number as a session would file a
 * task's chat or a job under some unrelated session. A job's number is its
 * job_id instead, and its session is the one that asked for it, which the
 * caller looks up (sessionOfJob) because only it has a database to ask.
 */
function identity(env = {}, { inferType = null } = {}) {
  const actor = String(env.DELPHI_ACTOR || "agent");
  const declared = AUTHOR_TYPES.includes(env.DELPHI_AUTHOR_TYPE) ? env.DELPHI_AUTHOR_TYPE : null;
  const sessionInName = /^[^:\s]+:(\d+)$/.exec(actor);
  const jobInName = /^[^:\s]+:job-(\d+)$/.exec(actor);
  return {
    actor,
    actor_type: declared || (typeof inferType === "function" ? inferType(actor) : "agent"),
    session_id: wholeNumber(env.DELPHI_SESSION) || (sessionInName ? Number(sessionInName[1]) : null),
    job_id: wholeNumber(env.DELPHI_JOB) || (jobInName ? Number(jobInName[1]) : null),
  };
}

let stepsMade = 0;
/**
 * A fresh step id. Rows of one tool call or one window action share it, which
 * is what lets a rollback take a whole step and never half of one. Unique per
 * process by the counter and across processes by pid and time; a collision
 * would only merge two steps' History grouping, never lose a row.
 */
function newStep(prefix = "s") {
  stepsMade += 1;
  const pid = typeof process !== "undefined" && process.pid ? process.pid : 0;
  return `${prefix}${pid.toString(36)}-${Date.now().toString(36)}-${stepsMade.toString(36)}`;
}

const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;
const parse = (text) => {
  if (text == null || text === "") return null;
  if (typeof text === "object") return text;
  try { return JSON.parse(text); } catch { return null; }
};

/**
 * The audit writer for one store or process.
 *
 *   who     { actor, actor_type, session_id, job_id }, or a function returning it
 *   step    a function returning the current step id, or null for a fresh one
 *           per change
 *   suffix  whether summaries get " (by <actor>)". The window's never did.
 */
function makeAuditor({ sql, batch = null, who = {}, step = null, suffix = true } = {}) {
  if (typeof sql !== "function") throw new Error("makeAuditor needs a sql(query, params) function");
  const current = () => {
    const w = (typeof who === "function" ? who() : who) || {};
    return {
      actor: w.actor == null ? null : String(w.actor),
      actor_type: AUTHOR_TYPES.includes(w.actor_type) ? w.actor_type : null,
      session_id: wholeNumber(w.session_id),
      job_id: wholeNumber(w.job_id),
    };
  };
  const stepNow = () => (typeof step === "function" && step()) || newStep();
  const runAll = (statements) => {
    if (!statements.length) return;
    if (typeof batch === "function") batch(statements);
    else for (const [q, p] of statements) sql(q, p);
  };

  const cache = new Map();
  /** A table's columns, in their declared order, so id comes first in every blob. */
  function columns(table) {
    if (!cache.has(table)) cache.set(table, sql("SELECT name FROM pragma_table_info(:p1)", [table]).map((r) => r.name));
    return cache.get(table);
  }
  /** SQL for the row as JSON, taken inside the statement it is part of. */
  function rowSql(entity, idSql) {
    const table = TABLES[entity];
    if (!table) throw new Error(`No table for audit entity '${entity}'`);
    const pairs = columns(table).map((c) => `${quote(c)}, "${c}"`).join(", ");
    return `(SELECT json_object(${pairs}) FROM ${table} WHERE id = ${idSql})`;
  }

  /**
   * One audit row as a statement. before and after are objects written as
   * JSON; beforeSql, afterSql and idSql are SQL text (built here, never from
   * input) for values only the batch can know.
   */
  function statement({ action, entity, id = null, idSql = null, summary, label = null, labelSql = null,
                       before = null, after = null, beforeSql = null, afterSql = null, stepId = null, where = null, as = null }) {
    // as: a writer other than the store's own for this one row, such as the
    // person a job's approval came from, given to the dispatcher's audit.
    const w = as ? { ...current(), ...as } : current();
    const text = suffix && w.actor ? `${summary} (by ${w.actor})` : String(summary);
    const params = [];
    const p = (value) => { params.push(value); return `:p${params.length}`; };
    const values = [
      p(action), p(entity), idSql || p(id == null ? null : Number(id)), p(text), labelSql || p(label == null ? null : String(label)),
      beforeSql || p(before ? JSON.stringify(before) : null), afterSql || p(after ? JSON.stringify(after) : null),
      p(w.actor), p(w.actor_type), p(w.session_id), p(w.job_id), p(stepId || stepNow()),
    ];
    return [
      `INSERT INTO audit (action, entity, entity_id, summary, label, before_json, after_json,
                          actor, actor_type, session_id, job_id, step)
       ${where ? `SELECT ${values.join(", ")} WHERE ${where}` : `VALUES (${values.join(", ")})`}`,
      params,
    ];
  }

  /** The audit row this step wrote for one entity, as SQL, for an after taken later. */
  const ownRow = (entity, idSql, stepId) =>
    `(SELECT MAX(id) FROM audit WHERE entity = ${quote(entity)} AND entity_id = ${idSql} AND step = ${quote(stepId)})`;

  /**
   * An update and its History row, as statements for one batch: the row as it
   * was, then the writes, then the row as they left it.
   *
   * id is a number, or { sql } for a row only the batch can choose (the queue's
   * claim picks its task in the same transaction that takes it). Then no audit
   * row is written when it chooses none, and the writes find the chosen id with
   * stepRowId().
   */
  function update(entity, id, { summary, label = null, stepId = null }, writes) {
    const s = stepId || stepNow();
    const chosen = id && typeof id === "object" ? `(${id.sql})` : null;
    const idSql = chosen || String(Number(id));
    const head = chosen
      ? statement({ action: "update", entity, idSql, summary, labelSql: `(SELECT ${LABELS[entity] || "title"} FROM ${TABLES[entity]} WHERE id = ${idSql})`,
                    beforeSql: rowSql(entity, idSql), stepId: s, where: `${idSql} IS NOT NULL` })
      : statement({ action: "update", entity, id, summary, label, beforeSql: rowSql(entity, idSql), stepId: s });
    const target = chosen ? stepRowId(entity, s) : idSql;
    return [
      head,
      ...writes,
      [`UPDATE audit SET after_json = ${rowSql(entity, target)} WHERE id = ${ownRow(entity, target, s)}`, []],
    ];
  }
  /** SQL for the entity id this step's newest row on an entity names. */
  const stepRowId = (entity, stepId) =>
    `(SELECT entity_id FROM audit WHERE step = ${quote(stepId)} AND entity = ${quote(entity)} ORDER BY id DESC LIMIT 1)`;

  /**
   * A create and its History row. The insert must be first: the audit row takes
   * the new id from last_insert_rowid(), which on the sqlite3 route is only
   * meaningful inside the one process a batch runs in. extras run after it and
   * find the id with createdId().
   */
  function create(entity, { summary, label = null, stepId = null }, insert, extras = [], between = []) {
    const s = stepId || stepNow();
    return [
      insert,
      // Writes that belong in the row's first recorded state (the pad sync's
      // anchor) go between, which leaves last_insert_rowid() alone.
      ...between,
      statement({ action: "create", entity, idSql: "last_insert_rowid()", summary, label,
                  afterSql: rowSql(entity, "last_insert_rowid()"), stepId: s }),
      ...extras,
    ];
  }
  /** SQL for the id the newest create of this entity in a step was given. */
  const createdId = (entity, stepId) =>
    `(SELECT entity_id FROM audit WHERE step = ${quote(stepId)} AND entity = ${quote(entity)} AND action = 'create' ORDER BY id DESC LIMIT 1)`;
  /** The same, read once the batch has run. */
  const created = (entity, stepId) => {
    const row = sql(`SELECT entity_id FROM audit WHERE step = :p1 AND entity = :p2 AND action = 'create' ORDER BY id DESC LIMIT 1`, [stepId, entity])[0];
    return row ? Number(row.entity_id) : null;
  };

  /**
   * Retakes the after of this step's row for an entity, or records one when the
   * step has none. For a second write in the same step, such as the pad sync
   * anchoring lines in the body an agent just wrote: without it the recorded
   * after lacks the anchors, and undo would read the pad as edited since.
   */
  function refreshAfter(entity, id, { summary, label = null, stepId }, writes) {
    const idSql = String(Number(id));
    // Not a move's or a copy's row: their after is the record of what they
    // did, and the derive a copy runs must not write over it.
    const mine = sql(`SELECT id FROM audit WHERE entity = :p1 AND entity_id = :p2 AND step = :p3
                        AND (before_json IS NULL OR substr(before_json, 1, 4) != '{"__') ORDER BY id DESC LIMIT 1`,
                     [entity, Number(id), stepId])[0];
    if (!mine) return update(entity, id, { summary, label, stepId }, writes);
    return [...writes, [`UPDATE audit SET after_json = ${rowSql(entity, idSql)} WHERE id = ${Number(mine.id)}`, []]];
  }

  // --- Sheet entries ---------------------------------------------------------------
  //
  // Comments are not in the audit CHECK, so an entry's write is recorded on its
  // task with what it did in __op, the pattern items/store.js uses for moves.
  // That makes it reversible without widening the CHECK: db.js undo takes an
  // added entry away and puts an edited one back, refusing when it has changed
  // since. The four fields compared are the ones a person or agent changes.
  const commentSql = (idSql) =>
    `json((SELECT json_object('body', body, 'meta', meta, 'promoted', promoted, 'note_id', note_id) FROM comments WHERE id = ${idSql}))`;
  /**
   * An entry added and its task's History row. The insert must come
   * immediately before the row, which takes the entry's id from
   * last_insert_rowid(); appendedId() finds it once the batch has run.
   */
  function sheetAppend(task, { summary, stepId = null }, insert) {
    const s = stepId || stepNow();
    const op = (withAfter) => `json_object('__op', json_object('kind', 'sheet_append', 'comment_id', last_insert_rowid()${withAfter ? `, 'after', ${commentSql("last_insert_rowid()")}` : ""}))`;
    return [insert, statement({ action: "update", entity: "task", id: task.id, summary, label: task.title,
                                beforeSql: op(false), afterSql: op(true), stepId: s })];
  }
  const appendedId = (taskId, stepId) => {
    const row = sql(`SELECT json_extract(before_json, '$.__op.comment_id') AS id FROM audit
                      WHERE step = :p1 AND entity = 'task' AND entity_id = :p2 AND before_json LIKE '{"__op":{"kind":"sheet_append"%'
                      ORDER BY id DESC LIMIT 1`, [stepId, Number(taskId)])[0];
    return row && row.id != null ? Number(row.id) : null;
  };
  /** An entry changed, with its words and flags before and after, and its task's History row. */
  function sheetEdit(task, commentId, { summary, stepId = null }, writes) {
    const s = stepId || stepNow();
    const id = String(Number(commentId));
    const op = (side) => `json_object('__op', json_object('kind', 'sheet_edit', 'comment_id', ${id}, '${side}', ${commentSql(id)}))`;
    const taskId = String(Number(task.id));
    return [
      statement({ action: "update", entity: "task", id: task.id, summary, label: task.title, beforeSql: op("before"), stepId: s }),
      ...writes,
      [`UPDATE audit SET after_json = ${op("after")} WHERE id = ${ownRow("task", taskId, s)}`, []],
    ];
  }

  return { who: current, step: stepNow, sheetAppend, appendedId, sheetEdit, statement, update, create, createdId, created, stepRowId, refreshAfter, rowSql, columns, run: runAll };
}

/** The actor of an audit row: the column, or the suffix older rows carry. */
function actorOf(entry) {
  if (!entry) return null;
  if (entry.actor) return String(entry.actor);
  const m = / \(by ([^()]+)\)$/.exec(String(entry.summary || ""));
  return m ? m[1] : null;
}

/** What History calls a writer. The window's own writes are the person's. */
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const nameOf = (actor) => (actor == null ? "someone" : actor === "you" ? "you" : actor);

/**
 * When an undo would do harm, as a sentence. The rule items/store.js keeps for
 * moves, applied to every row: put back only what is still as the change left
 * it, and refuse, naming what is in the way, rather than guess which of two
 * changes a person meant to keep.
 *
 *   1. A later change, recorded, to the same row by any step but this one.
 *   2. Drift: a field this change set is not what it set it to, which catches
 *      the writes no audit row describes (a pad derive, a claim expiring).
 *   3. Dependants: undoing a create would delete what others have hung off it
 *      since, a comment, a subtask, an association, a Workbench or a job,
 *      because each goes with the task's delete (owner decision S8: refuse).
 *
 * Returns null when the undo may go ahead.
 */
function makeUndoRules({ sql } = {}) {
  if (typeof sql !== "function") throw new Error("makeUndoRules needs a sql(query, params) function");

  const changedFields = (before, after, skip) =>
    Object.keys(after).filter((k) => !skip.has(k) && k !== "id" && !k.startsWith("__")
      && String(before ? before[k] ?? "" : "") !== String(after[k] ?? ""));
  const differs = (a, b) => String(a ?? "") !== String(b ?? "");

  function laterChange(entry) {
    // Rows that only say something happened (a flag, a move, a Sheet entry, a
    // Workbench started) carry a __ key and change no field of the row, so they
    // do not stand in the way. Drift covers the fields a move did change.
    return sql(`SELECT id, summary, actor FROM audit
                 WHERE entity = :p1 AND entity_id = :p2 AND id > :p3 AND undone = 0
                   AND (before_json IS NULL OR substr(before_json, 1, 4) != '{"__')
                   AND (step IS NULL OR :p4 IS NULL OR step != :p4)
                 ORDER BY id DESC LIMIT 1`,
               [entry.entity, Number(entry.entity_id), Number(entry.id), entry.step || null])[0] || null;
  }

  function dependants(entry, actor) {
    const id = Number(entry.entity_id);
    const reasons = [];
    const assoc = sql("SELECT COUNT(*) AS n FROM item_projects WHERE entity = :p1 AND entity_id = :p2", [entry.entity, id])[0];
    if (assoc && Number(assoc.n)) reasons.push(`it is shown in ${Number(assoc.n) === 1 ? "another project" : `${assoc.n} other projects`}`);
    if (entry.entity !== "task") return reasons;
    // Comments by its own creator go with it: they were part of making it.
    // Anyone else's are theirs, and a delete would take them with no copy.
    const others = sql(`SELECT author, COUNT(*) AS n FROM comments WHERE task_id = :p1 AND (:p2 IS NULL OR author != :p2)
                        GROUP BY author ORDER BY MIN(id)`, [id, actor]);
    if (others.length) {
      const total = others.reduce((s, r) => s + Number(r.n), 0);
      reasons.push(`${others.map((r) => nameOf(r.author)).join(" and ")} ${others.length === 1 && others[0].author === "you" ? "have" : "has"} written ${total === 1 ? "an entry" : `${total} entries`} on its Sheet`);
    }
    const subtasks = sql(`SELECT id FROM tasks WHERE parent_id = :p1
                            AND id NOT IN (SELECT entity_id FROM audit WHERE entity = 'task' AND action = 'create'
                                            AND step IS NOT NULL AND step = :p2)`, [id, entry.step || null]);
    if (subtasks.length) reasons.push(`it has ${subtasks.length === 1 ? "a subtask" : `${subtasks.length} subtasks`} added since (${subtasks.map((r) => `#${r.id}`).join(", ")})`);
    const bench = sql(`SELECT branch FROM workbenches WHERE task_id = :p1 AND state IN ${LIVE_BENCH} ORDER BY id LIMIT 1`, [id])[0];
    if (bench) reasons.push(`it has a Workbench on ${bench.branch}; Finish or Discard it first`);
    const job = sql(`SELECT id FROM handoffs WHERE task_id = :p1 AND state IN ${OPEN_JOBS} ORDER BY id LIMIT 1`, [id])[0];
    if (job) reasons.push(`job ${job.id} is still open on it`);
    const reminders = sql("SELECT COUNT(*) AS n FROM alerts WHERE task_id = :p1 AND kind = 'reminder'", [id])[0];
    if (reminders && Number(reminders.n)) reasons.push(`it has ${Number(reminders.n) === 1 ? "a reminder" : `${reminders.n} reminders`}`);
    return reasons;
  }

  function refusal(entry) {
    if (!entry) return "No such audit entry.";
    // A session moved to another project is a person's change to where it
    // lives, made by the item store and reversed by it from its __op, like a
    // task's or a note's move. Everything else a session writes is its own
    // bookkeeping.
    const moved = entry.entity === "session" && ITEM_OPS.includes((parse(entry.before_json) || {}).__op?.kind);
    if (BOOKKEEPING.includes(entry.entity) && !moved) {
      return entry.entity === "handoff"
        ? "That is a job's own record, which changed no task or note. Stop or reject the job instead."
        : "That is a session's own record, which changed no task or note, so there is nothing to put back.";
    }
    const before = parse(entry.before_json);
    const after = parse(entry.after_json);
    // Moves, associations and Sheet entries are checked by whoever reverses them.
    if (before && Object.keys(before).some((k) => k.startsWith("__"))) return null;
    const table = TABLES[entry.entity];
    if (!table) return `Nothing can be put back for a ${entry.entity}.`;
    const label = entry.label ? `"${entry.label}"` : `This ${entry.entity}`;

    if (entry.action === "delete") {
      const taken = sql(`SELECT id FROM ${table} WHERE id = :p1`, [Number(entry.entity_id)])[0];
      return taken ? `${entry.entity[0].toUpperCase()}${entry.entity.slice(1)} ${entry.entity_id} exists again, so the deleted one cannot come back under its id.` : null;
    }

    const now = sql(`SELECT * FROM ${table} WHERE id = :p1`, [Number(entry.entity_id)])[0] || null;
    if (!now) return null;   // already gone: the create is reversed, the update has nothing left to change

    const later = laterChange(entry);
    if (later) {
      const what = String(later.summary || "").replace(/ \(by [^()]+\)$/, "");
      return `${capital(nameOf(actorOf(later)))} changed ${label} after this (${what}). Undo that first, or change it by hand.`;
    }

    if (entry.action === "update" && before && after) {
      const moved = changedFields(before, after, NOT_COMPARED).filter((k) => k in now && differs(now[k], after[k]));
      if (moved.length) return `${label} has changed since (${moved.join(", ")}), so undoing this would overwrite that. Change it by hand instead.`;
      return null;
    }

    if (entry.action === "create") {
      if (after) {
        const moved = Object.keys(after).filter((k) => !NOT_COMPARED_ON_CREATE.has(k) && k !== "id" && k in now && differs(now[k], after[k]));
        if (moved.length) return `${label} has changed since it was made (${moved.join(", ")}), so undoing its creation would lose that. Delete it by hand if you mean to.`;
      }
      const reasons = dependants(entry, actorOf(entry));
      if (reasons.length) return `Undoing the creation of ${label} would delete what depends on it: ${reasons.join("; ")}. Delete it by hand if you mean to.`;
    }
    return null;
  }

  /** The fields an update should put back: only what it changed, when both sides were kept. */
  function restoreSet(entry) {
    const before = parse(entry.before_json);
    const after = parse(entry.after_json);
    if (!before) return null;
    if (!after) return Object.keys(before).filter((c) => c !== "id" && !c.startsWith("__"));
    const fields = changedFields(before, after, NOT_COMPARED);
    // updated_at goes back too when anything does, so the row reads as it did.
    return fields.length && "updated_at" in before ? [...fields, "updated_at"] : fields;
  }

  return { refusal, restoreSet, dependants, laterChange };
}

/** The session a job's writes belong to: the one that asked for it, if any. */
function sessionOfJob(sql, jobId) {
  if (!jobId) return null;
  try {
    const row = sql("SELECT from_session_id FROM handoffs WHERE id = :p1", [Number(jobId)])[0];
    return row && row.from_session_id != null ? Number(row.from_session_id) : null;
  } catch { return null; }
}

module.exports = { TABLES, BOOKKEEPING, identity, newStep, makeAuditor, makeUndoRules, actorOf, sessionOfJob };
