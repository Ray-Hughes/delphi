/**
 * Today's two questions that need SQL: which tasks have gone quiet, and what
 * happened while you were away (the daily brief).
 *
 * Shared by the app (main/today.js) and the MCP server (daily_brief), the same
 * way sheet/store.js is: it never opens a database, it is handed a
 * sql(query, params) function in the server's :p1 style. The server passes its
 * own, which may be shelling out to sqlite3; db.js passes sqlP, which binds.
 * So every query here is one statement (node:sqlite runs only the first of
 * several) and nothing assumes two calls share a transaction.
 *
 * Deterministic on purpose. No model is asked anything: the brief is what the
 * History, the Sheets, the dispatcher and the Workbenches already recorded,
 * filtered to a window of time. A summary a model wrote would be one more
 * thing to check against the rows, and the rows are short enough to read.
 *
 * Times are SQLite's own UTC text ("2026-11-06 07:52:34"). Every comparison
 * goes through datetime(), because some writers store ISO with a T and a Z,
 * and "2026-11-06T01:00:00Z" sorts after "2026-11-06 07:00:00" as text.
 */

const { inferAuthorType } = require("../sheet/format");

// The stuck rules, from the plan (slice 7). Quiet for 3 days is amber and
// reads "Idle 3d"; 7 or more is red and reads "7d". Blocked work waits on
// someone else by definition, so it can go amber but never red: red is for
// work somebody said they were doing. To-do is the backlog and is never
// stuck, and neither is anything done.
//
// In review is never stuck either. It is finished work waiting on a person,
// so a quiet review task is not stale agent work but a person's turn, and it
// is shown under Needs you (inReview below) with how long it has waited.
// Marking it "No movement" would blame the agent for the wait.
const AMBER_DAYS = 3;
const RED_DAYS = 7;
const NEVER_STUCK = ["todo", "review", "done"];

const DAY_MS = 86400000;
const CHARS_PER_TOKEN = 4;

/** A Date, a number or SQLite text, as SQLite's UTC text. */
function stamp(value) {
  if (value == null || value === "") return null;
  let d = value instanceof Date ? value : typeof value === "number" ? new Date(value) : null;
  if (!d) {
    const s = String(value).trim();
    // Bare SQLite text is UTC; Date would read it as local time. A bare date
    // is that day's midnight, UTC, as SQLite's datetime() reads it.
    const full = /^\d{4}-\d\d-\d\d$/.test(s) ? `${s} 00:00:00` : s;
    d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(full) ? full : `${full.replace(" ", "T")}Z`);
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace("T", " ");
}
const msOf = (text) => {
  const s = stamp(text);
  return s ? Date.parse(`${s.replace(" ", "T")}Z`) : NaN;
};

/**
 * How stuck a task is, from its status and whole days without movement:
 * "red", "amber" or null. The one place the rule lives; the window, the
 * brief and the tests all ask this.
 */
function levelOf(status, days) {
  if (NEVER_STUCK.includes(status)) return null;
  const d = Number(days);
  if (!Number.isFinite(d) || d < AMBER_DAYS) return null;
  if (d >= RED_DAYS && status !== "blocked") return "red";
  return "amber";
}

const HOUR_MS = 3600000;

/**
 * When a due date falls due, in ms. A bare day is due at the end of that day
 * on this machine's clock, which is the day a person meant; a time is read as
 * local too, the way TIME.dueState reads it in the window.
 */
function dueAt(due) {
  const s = String(due == null ? "" : due).trim();
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d))?)?/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, se] = m.map((v) => (v == null ? v : Number(v)));
  return h == null ? new Date(y, mo - 1, d + 1).getTime() : new Date(y, mo - 1, d, h, mi, se || 0).getTime();
}

/**
 * Whole hours until a task falls due, when that is within the next day: the
 * plan's other amber (slice 7). Null when it is further off, already past
 * (that is overdue, which Today says in its own words), or the task is to-do
 * or done, which are never marked.
 */
function dueSoonHours(status, due, now = Date.now()) {
  if (NEVER_STUCK.includes(status)) return null;
  const left = dueAt(due) - (now instanceof Date ? now.getTime() : Number(now));
  if (!Number.isFinite(left) || left <= 0 || left > DAY_MS) return null;
  return Math.max(1, Math.ceil(left / HOUR_MS));
}

/** The words on the mark: amber says what it is, red is already loud. */
function markOf(level, days) {
  if (level === "amber") return `Idle ${days}d`;
  if (level === "red") return `${days}d`;
  return "";
}

/** The sentence a person reads, on the banner, the card and the drawer. */
const movementWords = (days) => `No movement in ${days} ${Number(days) === 1 ? "day" : "days"}`;

// The latest moment anything happened to a task, as one expression over a
// tasks row aliased t. "Anything" is everything Delphi records about it: the
// row itself, its Sheet, its jobs, its Workbenches, its status changes and its
// History, and its subtasks' rows, Sheets, jobs and History, since work on a
// piece is work on the whole.
//
// The subtask lookups start from the subtasks (idx_tasks_parent), never from
// a join to tasks. A join lets the planner, with no ANALYZE statistics, walk
// every task row in audit and check each one's parent: 9 seconds at 200k
// History rows, on the main process. tools/today_test.js checks the plan and
// the time. Each piece is COALESCEd to '' because SQLite's
// scalar max() is NULL as soon as any argument is.
// A task's newest History row is its highest id: rows are only ever appended,
// and neither writer (agent/audit.js, db.js record) sets at, so it is the
// column's default, datetime('now') at the insert. A clock stepped back would
// put that out by the step, which is hours against a rule counted in days. So it is one seek down idx_audit_entity
// (entity, entity_id, id) rather than a max() that has to read and convert
// every row a busy task has, which at 200k rows was most of the cost.
const NEWEST_AUDIT = (id) => `(SELECT datetime(a.at) FROM audit a WHERE a.entity = 'task' AND a.entity_id = ${id}
                ORDER BY a.id DESC LIMIT 1)`;

const LAST_ACTIVITY = `max(
    COALESCE(datetime(t.updated_at), ''),
    COALESCE(datetime(t.created_at), ''),
    COALESCE((SELECT max(max(COALESCE(datetime(s.updated_at), ''), COALESCE(datetime(s.created_at), '')))
                FROM tasks s WHERE s.parent_id = t.id), ''),
    COALESCE((SELECT max(datetime(c.created_at)) FROM comments c
                WHERE c.task_id IN (SELECT s.id FROM tasks s WHERE s.parent_id = t.id)), ''),
    COALESCE((SELECT max(datetime(COALESCE(h.last_activity, h.updated_at, h.created_at))) FROM handoffs h
                WHERE h.task_id IN (SELECT s.id FROM tasks s WHERE s.parent_id = t.id)), ''),
    COALESCE((SELECT max(${NEWEST_AUDIT("s.id")}) FROM tasks s WHERE s.parent_id = t.id), ''),
    COALESCE((SELECT max(max(COALESCE(datetime(c.created_at), ''), COALESCE(datetime(c.updated_at), '')))
                FROM comments c WHERE c.task_id = t.id), ''),
    COALESCE((SELECT max(max(COALESCE(datetime(h.created_at), ''), COALESCE(datetime(h.updated_at), ''),
                             COALESCE(datetime(h.last_activity), ''), COALESCE(datetime(h.finished_at), '')))
                FROM handoffs h WHERE h.task_id = t.id), ''),
    COALESCE((SELECT max(max(COALESCE(datetime(w.created_at), ''), COALESCE(datetime(w.updated_at), ''),
                             COALESCE(datetime(w.closed_at), '')))
                FROM workbenches w WHERE w.task_id = t.id), ''),
    COALESCE((SELECT max(datetime(e.at)) FROM status_events e WHERE e.task_id = t.id), ''),
    COALESCE(${NEWEST_AUDIT("t.id")}, '')
  )`;

// Whether an audit row can be put back, the same rule db.js AUDIT_LIST_COLUMNS
// gives History's undo button, so the brief never offers an Undo that History
// would not. The undo itself still runs every check (db.undo), and its refusal
// is shown word for word when there is one.
const RESTORABLE = (a) => `CASE WHEN ${a}.id IS NULL OR ${a}.undone = 1 THEN 0
            WHEN ${a}.entity IN ('handoff', 'session') THEN 0
            WHEN ${a}.action = 'create' THEN 1
            WHEN ${a}.before_json IS NULL OR ${a}.before_json LIKE '{"__flag":%' OR ${a}.before_json LIKE '{"__note":%' THEN 0
            ELSE 1 END`;

// The History row that appended a Sheet entry, for an entry aliased c. The
// json_extract sits inside a CASE because SQLite does not promise to test the
// LIKE first otherwise, and one row of before_json that is not JSON would
// fail the whole brief.
const ENTRY_AUDIT = (c) => `(SELECT a.id FROM audit a
     WHERE a.entity = 'task' AND a.entity_id = ${c}.task_id
       AND CASE WHEN a.before_json LIKE '{"__op":{"kind":"sheet_append"%'
                THEN json_extract(a.before_json, '$.__op.comment_id') END = ${c}.id
     ORDER BY a.id DESC LIMIT 1)`;

const TASK_COLUMNS = "t.id AS task_id, t.title AS task_title, t.status AS task_status, t.project_id, p.name AS project_name";
const LIVE_PROJECT = "(p.id IS NULL OR p.status != 'archived')";
const inScope = (alias, n) => `(:p${n} IS NULL OR ${alias}.project_id = :p${n})`;

/**
 * Every task that has gone quiet or falls due within a day, loudest first:
 * red before amber, then priority (high first), then the longest quiet, then
 * the lowest id. projectId narrows it to one project.
 *
 * reason says which rule gives the row its mark: "idle" (no movement) or
 * "due" (due within 24 hours, "Due in Nh"). Red quiet beats due soon;
 * otherwise due soon is the mark, because it has a clock on it. idle is the
 * quiet rule's own answer either way, which is what the brief reads. Due rows
 * sort with the other amber ones, by priority and then quiet, not by how soon.
 */
function stuck(sql, { now = new Date(), projectId = null } = {}) {
  const at = stamp(now);
  const rows = sql(
    `SELECT * FROM (
       SELECT t.id, t.title, t.status, t.priority, t.due, t.assignee, t.owner, t.parent_id,
              t.project_id, p.name AS project_name, p.colour AS project_colour,
              ${LAST_ACTIVITY} AS last_at
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.status NOT IN ('todo', 'review', 'done') AND ${LIVE_PROJECT} AND ${inScope("t", 2)})
      WHERE (last_at != '' AND julianday(:p1) - julianday(last_at) >= ${AMBER_DAYS})
         OR (due IS NOT NULL AND due != '')`,
    [at, projectId == null ? null : Number(projectId)]);
  const nowMs = msOf(at);
  const out = [];
  for (const r of rows) {
    const last = msOf(r.last_at);
    const days = Number.isFinite(last) ? Math.floor((nowMs - last) / DAY_MS) : 0;
    const idle = levelOf(r.status, days);
    const hours = dueSoonHours(r.status, r.due, nowMs);
    if (!idle && hours == null) continue;
    const reason = idle === "red" || hours == null ? "idle" : "due";
    const level = reason === "due" ? "amber" : idle;
    out.push({
      id: Number(r.id), title: r.title, status: r.status, priority: r.priority, due: r.due || null,
      assignee: r.assignee || null, owner: r.owner || null, parent_id: r.parent_id == null ? null : Number(r.parent_id),
      project_id: r.project_id == null ? null : Number(r.project_id), project_name: r.project_name || null,
      project_colour: r.project_colour || null,
      last_at: stamp(r.last_at), days, level, reason, idle, due_in_hours: hours,
      mark: reason === "due" ? `Due in ${hours}h` : markOf(level, days),
      words: reason === "due" ? `Due in ${hours} ${hours === 1 ? "hour" : "hours"}` : movementWords(days),
    });
  }
  const PRI = { high: 0, med: 1, low: 2 };
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "red" ? -1 : 1)
    || (PRI[a.priority] ?? 1) - (PRI[b.priority] ?? 1) || b.days - a.days || a.id - b.id);
}

/**
 * Every task in review, for Needs you: oldest wait first. since is when it
 * last entered review (its newest status event saying so, else the row's
 * updated_at for a task with no such event), and days is whole days since.
 * A subtask in review is listed too, unless its parent is in review as well,
 * which then stands for both.
 */
function inReview(sql, { now = new Date(), projectId = null } = {}) {
  const at = stamp(now);
  const rows = sql(
    `SELECT t.id, t.title, t.priority, t.due, t.assignee, t.project_id, p.name AS project_name, p.colour AS project_colour,
            COALESCE((SELECT max(datetime(e.at)) FROM status_events e WHERE e.task_id = t.id AND e.status = 'review'),
                     datetime(t.updated_at)) AS since,
            (SELECT e.actor FROM status_events e WHERE e.task_id = t.id AND e.status = 'review' ORDER BY e.at DESC, e.id DESC LIMIT 1) AS moved_by
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.status = 'review' AND ${LIVE_PROJECT} AND ${inScope("t", 1)}
        AND NOT EXISTS (SELECT 1 FROM tasks pt WHERE pt.id = t.parent_id AND pt.status = 'review')
      ORDER BY since, t.id`,
    [projectId == null ? null : Number(projectId)]);
  const nowMs = msOf(at);
  return rows.map((r) => {
    const since = msOf(r.since);
    const days = Number.isFinite(since) ? Math.max(0, Math.floor((nowMs - since) / DAY_MS)) : 0;
    return {
      id: Number(r.id), title: r.title, status: "review", priority: r.priority, due: r.due || null, assignee: r.assignee || null,
      project_id: r.project_id == null ? null : Number(r.project_id), project_name: r.project_name || null,
      project_colour: r.project_colour || null, since: stamp(r.since), moved_by: r.moved_by || null, days,
      words: days ? `Waiting on your review for ${days} ${days === 1 ? "day" : "days"}` : "Waiting on your review since today",
    };
  });
}

/**
 * The one stuck task the banner names: red work first, a parent before its
 * subtasks, then priority, then the longest quiet. Null when nothing is red,
 * because an amber task is a nudge for its row, not a banner.
 */
function bannerOf(rows) {
  const red = (rows || []).filter((r) => r.level === "red");
  if (!red.length) return null;
  const PRI = { high: 0, med: 1, low: 2 };
  return red.slice().sort((a, b) => (a.parent_id == null ? 0 : 1) - (b.parent_id == null ? 0 : 1)
    || (PRI[a.priority] ?? 1) - (PRI[b.priority] ?? 1) || b.days - a.days || a.id - b.id)[0];
}

const isAgent = (author, type) => (type || inferAuthorType(author)) === "agent";
const clip = (text, n) => {
  const v = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return v.length <= n ? v : `${v.slice(0, n - 3)}...`;
};
const parseMeta = (text) => {
  if (!text) return null;
  try { const v = JSON.parse(text); return v && typeof v === "object" ? v : null; } catch { return null; }
};

/**
 * What happened between since and now, grouped by task.
 *
 * Five kinds of line:
 *   decision    an agent answered a question on a Sheet, so nobody asked you
 *   ask         an agent asked a question that is still open
 *   job         a run finished and nobody has reviewed it
 *   workbench   a Workbench has had work since it was last pushed
 *   stuck       a task crossed into amber or red while you were away
 *
 * Each line names the History row it came from (audit_id) and whether that row
 * can be undone (undoable), so the window can link to it and offer Undo.
 *
 * stuckRows is stuck()'s answer for the same now and project, when the caller
 * already has it, so one view does not run the heaviest query twice.
 */
function brief(sql, { since, now = new Date(), projectId = null, stuckRows = null } = {}) {
  const until = stamp(now);
  const from = stamp(since) || stamp(msOf(until) - DAY_MS);
  const scope = projectId == null ? null : Number(projectId);
  const lines = [];

  const decisions = sql(
    `SELECT c.id AS entry_id, c.author, c.author_type, c.body, c.meta, c.created_at AS at,
            q.body AS question, ${TASK_COLUMNS}, x.id AS audit_id, ${RESTORABLE("x")} AS undoable
       FROM comments c
       JOIN tasks t ON t.id = c.task_id
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN comments q ON q.id = c.ref_id
       LEFT JOIN audit x ON x.id = ${ENTRY_AUDIT("c")}
      WHERE c.kind = 'decide' AND COALESCE(c.author_type, '') != 'human'
        AND datetime(c.created_at) > datetime(:p1) AND datetime(c.created_at) <= datetime(:p2)
        AND ${LIVE_PROJECT} AND ${inScope("t", 3)}
      ORDER BY c.id`, [from, until, scope]);
  for (const r of decisions) {
    if (!isAgent(r.author, r.author_type)) continue;
    const meta = parseMeta(r.meta) || {};
    const choice = meta.label || meta.choice || clip(r.body, 80);
    lines.push({
      kind: "decision", at: stamp(r.at), who: r.author, entry_id: Number(r.entry_id),
      text: r.question ? `decided "${clip(choice, 80)}" on "${clip(r.question, 90)}"` : `decided "${clip(choice, 120)}"`,
      ...taskOf(r), audit_id: r.audit_id == null ? null : Number(r.audit_id), undoable: Number(r.undoable) === 1,
    });
  }

  const asks = sql(
    `SELECT c.id AS entry_id, c.author, c.author_type, c.body, c.created_at AS at,
            ${TASK_COLUMNS}, x.id AS audit_id, ${RESTORABLE("x")} AS undoable
       FROM comments c
       JOIN tasks t ON t.id = c.task_id
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN audit x ON x.id = ${ENTRY_AUDIT("c")}
      WHERE c.kind = 'ask' AND COALESCE(c.author_type, '') != 'human'
        AND NOT EXISTS (SELECT 1 FROM comments d WHERE d.kind = 'decide' AND d.ref_id = c.id)
        AND datetime(c.created_at) > datetime(:p1) AND datetime(c.created_at) <= datetime(:p2)
        AND ${LIVE_PROJECT} AND ${inScope("t", 3)}
      ORDER BY c.id`, [from, until, scope]);
  for (const r of asks) {
    if (!isAgent(r.author, r.author_type)) continue;
    lines.push({
      kind: "ask", at: stamp(r.at), who: r.author, entry_id: Number(r.entry_id),
      text: `asked "${clip(r.body, 140)}"`,
      ...taskOf(r), audit_id: r.audit_id == null ? null : Number(r.audit_id), undoable: Number(r.undoable) === 1,
    });
  }

  // The rule agent/jobs.js gives needs_review: done or failed in the state
  // column, and not reviewed. A row an older server wrote has no state and is
  // never offered for review there, so it is not news here either.
  const jobs = sql(
    `SELECT h.id AS job_id, h.kind AS job_kind, h.to_harness, h.state, h.request,
            COALESCE(h.finished_at, h.updated_at, h.created_at) AS at,
            ${TASK_COLUMNS.replace("t.project_id", "h.project_id")},
            (SELECT a.id FROM audit a WHERE a.entity = 'handoff' AND a.entity_id = h.id ORDER BY a.id DESC LIMIT 1) AS audit_id
       FROM handoffs h
       LEFT JOIN tasks t ON t.id = h.task_id
       LEFT JOIN projects p ON p.id = h.project_id
      WHERE h.state IN ('done', 'failed') AND h.reviewed_at IS NULL
        AND datetime(COALESCE(h.finished_at, h.updated_at, h.created_at)) > datetime(:p1)
        AND datetime(COALESCE(h.finished_at, h.updated_at, h.created_at)) <= datetime(:p2)
        AND ${LIVE_PROJECT} AND ${inScope("h", 3)}
      ORDER BY h.id`, [from, until, scope]);
  for (const r of jobs) {
    lines.push({
      kind: "job", at: stamp(r.at), who: r.to_harness, job_id: Number(r.job_id),
      text: `${r.state === "failed" ? "failed" : "finished"} ${r.job_kind === "do" ? "a Do" : "an Ask"} run nobody has reviewed: "${clip(r.request, 90)}"`,
      ...taskOf(r), audit_id: r.audit_id == null ? null : Number(r.audit_id), undoable: false,
    });
  }

  // Delphi cannot see a push made with plain git, only the ones it made
  // (workbench_push writes "pushed workbench"). So "unpushed" here is the
  // honest version: work Delphi recorded in it, a commit through Delphi or a
  // Do run that finished in it, newer than any push Delphi recorded. The
  // window words it that way.
  // Missing counts: a folder deleted by hand may have taken unpushed work
  // with it, which is the one case a person most needs to hear about.
  // The commit and push rows name the task, not the Workbench, so a task with
  // two (one per repository) shares them; that is rare, and the line then
  // says the task has unpushed work, which is still true of one of them.
  const benches = sql(
    `SELECT w.id AS workbench_id, w.branch, w.state AS bench_state, ${TASK_COLUMNS}, work.at, work.audit_id
       FROM workbenches w
       JOIN tasks t ON t.id = w.task_id
       LEFT JOIN projects p ON p.id = t.project_id
       JOIN (SELECT b.id AS bench,
                    max(COALESCE((SELECT max(datetime(a.at)) FROM audit a
                                   WHERE a.entity = 'task' AND a.entity_id = b.task_id AND a.undone = 0
                                     AND a.summary LIKE 'committed in workbench%' AND datetime(a.at) >= datetime(b.created_at)), ''),
                        COALESCE((SELECT max(datetime(COALESCE(h.finished_at, h.updated_at))) FROM handoffs h
                                   WHERE h.workbench_id = b.id AND h.kind = 'do' AND h.state IN ('done', 'failed')), '')) AS at,
                    (SELECT a.id FROM audit a WHERE a.entity = 'task' AND a.entity_id = b.task_id AND a.undone = 0
                       AND a.summary LIKE 'committed in workbench%' AND datetime(a.at) >= datetime(b.created_at)
                     ORDER BY a.id DESC LIMIT 1) AS audit_id,
                    COALESCE((SELECT max(datetime(a.at)) FROM audit a
                               WHERE a.entity = 'task' AND a.entity_id = b.task_id AND a.undone = 0
                                 AND a.summary LIKE 'pushed workbench%' AND datetime(a.at) >= datetime(b.created_at)), '') AS pushed
               FROM workbenches b WHERE b.state IN ('active', 'parked', 'missing')) work ON work.bench = w.id
      WHERE work.at != '' AND work.at > work.pushed
        AND work.at > datetime(:p1) AND work.at <= datetime(:p2)
        AND ${LIVE_PROJECT} AND ${inScope("t", 3)}
      ORDER BY w.id`, [from, until, scope]);
  for (const r of benches) {
    lines.push({
      kind: "workbench", at: stamp(r.at), who: null, workbench_id: Number(r.workbench_id), branch: r.branch,
      text: r.bench_state === "missing"
        ? `Workbench ${r.branch} has lost its folder, and Delphi has not seen its work pushed`
        : `Workbench ${r.branch} has work Delphi has not seen pushed`,
      ...taskOf(r), audit_id: r.audit_id == null ? null : Number(r.audit_id), undoable: false,
    });
  }

  // Newly stuck: the moment a task crossed 3 or 7 days falls inside the window.
  const fromMs = msOf(from);
  for (const s of stuckRows || stuck(sql, { now: until, projectId: scope })) {
    // By the quiet rule alone: a task that went quiet and is also due soon
    // still went quiet, whichever mark its row shows.
    if (!s.idle) continue;
    const last = msOf(s.last_at);
    const crossed = last + (s.idle === "red" ? RED_DAYS : AMBER_DAYS) * DAY_MS;
    if (!(crossed > fromMs)) continue;
    lines.push({
      kind: "stuck", at: stamp(crossed), who: null, level: s.idle, days: s.days, mark: markOf(s.idle, s.days),
      text: `${s.idle === "red" ? "went red" : "went quiet"}: ${movementWords(s.days).toLowerCase()}`,
      task_id: s.id, task_title: s.title, task_status: s.status, project_id: s.project_id, project_name: s.project_name,
      audit_id: lastAuditOf(sql, s.id), undoable: false,
    });
  }

  return group({ since: from, until, lines });
}

function taskOf(r) {
  return {
    task_id: r.task_id == null ? null : Number(r.task_id), task_title: r.task_title || null,
    task_status: r.task_status || null, project_id: r.project_id == null ? null : Number(r.project_id),
    project_name: r.project_name || null,
  };
}

/** The newest History row on a task, which is where its last movement is. */
function lastAuditOf(sql, taskId) {
  const row = sql("SELECT id FROM audit WHERE entity = 'task' AND entity_id = :p1 ORDER BY id DESC LIMIT 1", [Number(taskId)])[0];
  return row ? Number(row.id) : null;
}

const KINDS = ["decision", "ask", "job", "workbench", "stuck"];

/** Lines into groups by task, newest group first; a job with no task is grouped by its project. */
function group({ since, until, lines }) {
  const groups = new Map();
  for (const line of lines) {
    const key = line.task_id != null ? `t${line.task_id}` : `p${line.project_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        task_id: line.task_id, title: line.task_title, status: line.task_status,
        project_id: line.project_id, project_name: line.project_name, latest: line.at, lines: [],
      });
    }
    const g = groups.get(key);
    g.lines.push(line);
    if (String(line.at) > String(g.latest)) g.latest = line.at;
  }
  const list = [...groups.values()];
  for (const g of list) g.lines.sort((a, b) => String(b.at).localeCompare(String(a.at)) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  list.sort((a, b) => String(b.latest).localeCompare(String(a.latest)) || (a.task_id || 0) - (b.task_id || 0));
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const line of lines) counts[line.kind]++;
  return { since, until, total: lines.length, counts, groups: list };
}

/**
 * The brief for an agent: one line per thing, inside a token budget, the way
 * agent/recall.js answers. Groups are dropped from the end (the oldest) until
 * it fits, and it says so, so an agent knows to narrow the window or ask for
 * detail "full" rather than assume there was nothing more.
 */
function compact(full, { budget = 1200 } = {}) {
  const ago = (at) => {
    const mins = Math.max(0, Math.round((msOf(full.until) - msOf(at)) / 60000));
    return mins < 60 ? `${mins}m ago` : mins < 2880 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
  };
  const out = {
    since: full.since, until: full.until, counts: full.counts,
    tasks: full.groups.map((g) => ({
      task: g.task_id != null ? `#${g.task_id} ${clip(g.title, 70)}` : "(no task)",
      project: g.project_name || null,
      lines: g.lines.map((l) => `${l.kind}: ${l.who ? `${l.who} ` : ""}${clip(l.text, 160)}, ${ago(l.at)}${l.audit_id ? ` (History ${l.audit_id})` : ""}`),
    })),
  };
  if (!full.total) out.note = "Nothing happened in this window that needs you.";
  const limit = Math.max(200, Number(budget) || 1200) * CHARS_PER_TOKEN;
  // The note is put on before trimming, so the room it takes is counted: added
  // after, it pushed a trimmed answer back over the budget it was trimmed to.
  if (JSON.stringify(out).length > limit) {
    out.trimmed = true;
    out.more = "Trimmed to the budget. Pass a later since, a project, a larger budget, or detail: \"full\".";
    while (JSON.stringify(out).length > limit && out.tasks.length) {
      const last = out.tasks[out.tasks.length - 1];
      if (last.lines.length > 1) last.lines.pop(); else out.tasks.pop();
    }
  }
  return out;
}

/**
 * Where "Mark as seen" starts the next brief: the newest line the person was
 * shown, else the end of the window they were shown. Never the click time, so
 * anything that arrived after the last repaint is still news next time.
 */
function seenUpTo(shown) {
  if (!shown) return null;
  let newest = null;
  for (const g of shown.groups || []) for (const l of g.lines || []) if (!newest || String(l.at) > newest) newest = String(l.at);
  return stamp(newest || shown.until);
}

module.exports = { LAST_ACTIVITY, AMBER_DAYS, RED_DAYS, KINDS, stamp, levelOf, markOf, movementWords, dueAt, dueSoonHours, stuck, inReview, bannerOf, brief, compact, seenUpTo };
