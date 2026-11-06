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
const AMBER_DAYS = 3;
const RED_DAYS = 7;
const NEVER_STUCK = ["todo", "done"];

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
// piece is work on the whole. Each piece is COALESCEd to '' because SQLite's
// scalar max() is NULL as soon as any argument is.
const LAST_ACTIVITY = `max(
    COALESCE(datetime(t.updated_at), ''),
    COALESCE(datetime(t.created_at), ''),
    COALESCE((SELECT max(max(COALESCE(datetime(s.updated_at), ''), COALESCE(datetime(s.created_at), '')))
                FROM tasks s WHERE s.parent_id = t.id), ''),
    COALESCE((SELECT max(datetime(c.created_at)) FROM comments c JOIN tasks s ON s.id = c.task_id WHERE s.parent_id = t.id), ''),
    COALESCE((SELECT max(datetime(COALESCE(h.last_activity, h.updated_at, h.created_at))) FROM handoffs h
                JOIN tasks s ON s.id = h.task_id WHERE s.parent_id = t.id), ''),
    COALESCE((SELECT max(datetime(a.at)) FROM audit a JOIN tasks s ON s.id = a.entity_id
                WHERE a.entity = 'task' AND s.parent_id = t.id), ''),
    COALESCE((SELECT max(max(COALESCE(datetime(c.created_at), ''), COALESCE(datetime(c.updated_at), '')))
                FROM comments c WHERE c.task_id = t.id), ''),
    COALESCE((SELECT max(max(COALESCE(datetime(h.created_at), ''), COALESCE(datetime(h.updated_at), ''),
                             COALESCE(datetime(h.last_activity), ''), COALESCE(datetime(h.finished_at), '')))
                FROM handoffs h WHERE h.task_id = t.id), ''),
    COALESCE((SELECT max(max(COALESCE(datetime(w.created_at), ''), COALESCE(datetime(w.updated_at), ''),
                             COALESCE(datetime(w.closed_at), '')))
                FROM workbenches w WHERE w.task_id = t.id), ''),
    COALESCE((SELECT max(datetime(e.at)) FROM status_events e WHERE e.task_id = t.id), ''),
    COALESCE((SELECT max(datetime(a.at)) FROM audit a WHERE a.entity = 'task' AND a.entity_id = t.id), '')
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
 * Every task that has gone quiet, loudest first: red before amber, then the
 * longest quiet. projectId narrows it to one project.
 */
function stuck(sql, { now = new Date(), projectId = null } = {}) {
  const at = stamp(now);
  const rows = sql(
    `SELECT * FROM (
       SELECT t.id, t.title, t.status, t.priority, t.due, t.assignee, t.owner, t.parent_id,
              t.project_id, p.name AS project_name, p.colour AS project_colour,
              ${LAST_ACTIVITY} AS last_at
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.status NOT IN ('todo', 'done') AND ${LIVE_PROJECT} AND ${inScope("t", 2)})
      WHERE last_at != '' AND julianday(:p1) - julianday(last_at) >= ${AMBER_DAYS}`,
    [at, projectId == null ? null : Number(projectId)]);
  const nowMs = msOf(at);
  const out = [];
  for (const r of rows) {
    const last = msOf(r.last_at);
    if (!Number.isFinite(last)) continue;
    const days = Math.floor((nowMs - last) / DAY_MS);
    const level = levelOf(r.status, days);
    if (!level) continue;
    out.push({
      id: Number(r.id), title: r.title, status: r.status, priority: r.priority, due: r.due || null,
      assignee: r.assignee || null, owner: r.owner || null, parent_id: r.parent_id == null ? null : Number(r.parent_id),
      project_id: r.project_id == null ? null : Number(r.project_id), project_name: r.project_name || null,
      project_colour: r.project_colour || null,
      last_at: stamp(r.last_at), days, level, mark: markOf(level, days), words: movementWords(days),
    });
  }
  const PRI = { high: 0, med: 1, low: 2 };
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "red" ? -1 : 1)
    || (PRI[a.priority] ?? 1) - (PRI[b.priority] ?? 1) || b.days - a.days || a.id - b.id);
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
    const last = msOf(s.last_at);
    const crossed = last + (s.level === "red" ? RED_DAYS : AMBER_DAYS) * DAY_MS;
    if (!(crossed > fromMs)) continue;
    lines.push({
      kind: "stuck", at: stamp(crossed), who: null, level: s.level, days: s.days, mark: s.mark,
      text: `${s.level === "red" ? "went red" : "went quiet"}: ${s.words.toLowerCase()}`,
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
  while (JSON.stringify(out).length > limit && out.tasks.length) {
    const last = out.tasks[out.tasks.length - 1];
    if (last.lines.length > 1) last.lines.pop(); else out.tasks.pop();
    out.trimmed = true;
  }
  if (out.trimmed) out.more = "Trimmed to the budget. Pass a later since, a project, a larger budget, or detail: \"full\".";
  return out;
}

module.exports = { AMBER_DAYS, RED_DAYS, KINDS, stamp, levelOf, markOf, movementWords, stuck, bannerOf, brief, compact };
