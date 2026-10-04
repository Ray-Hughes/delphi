/**
 * Jobs: one unit of agent work, whoever asked for it.
 *
 * A handoff (an agent asking another agent), a task queued for an agent, and a
 * person's "have Codex do this" are the same thing once they are running: a
 * harness, a task, a folder, a state, and somebody who asked. So they share one
 * row, in the handoffs table, the way comments became Sheet entries without
 * changing their table: everything that already read handoffs (handoff_status,
 * the wake in main.js, the app's list) keeps working.
 *
 * Shared by the app's dispatcher and the MCP server, like sheet/store.js: SQL
 * text and rules, handed a sql(query, params) in the server's :p1 style, never
 * opening a database itself. Every insert uses RETURNING, because on the
 * server's sqlite3 route last_insert_rowid() is always 0.
 *
 * Two status columns, on purpose. `status` is the old one and has a CHECK
 * that cannot be widened without rebuilding the table, which the server's
 * binary route cannot do safely. `state` is the job's real state and has no
 * CHECK; `status` is kept in step with it through LEGACY so older readers see
 * something true. needs_approval maps to 'running' rather than 'queued' so an
 * older Delphi's dispatcher, which runs every 'queued' row it finds, can never
 * run a job nobody approved.
 */

const fs = require("fs");
const crypto = require("crypto");

const STATES = ["queued", "needs_approval", "running", "waiting_on_human", "done", "failed", "stopped"];
// Not finished: a job in one of these still holds its task.
const OPEN = ["queued", "needs_approval", "running", "waiting_on_human"];
const FINAL = ["done", "failed", "stopped"];
const KINDS = ["ask", "do"];

const LEGACY = {
  queued: "queued",
  needs_approval: "running",
  running: "running",
  waiting_on_human: "running",
  done: "ready",
  failed: "failed",
  stopped: "cancelled",
};

// What a row an older server wrote (no state) is taken to mean. Every one of
// those came from handoff_send, so an unstarted one is an agent's request.
const FROM_LEGACY = {
  queued: "needs_approval",
  running: "running",
  ready: "done",
  harvested: "done",
  failed: "failed",
  cancelled: "stopped",
};

const literalList = (list) => list.map((s) => `'${s}'`).join(", ");
const OPEN_SQL = literalList(OPEN);

// The state toRun reads a row as, in SQL, so a filter on it can sit before the
// LIMIT. Filtering after it lost every open job older than the newest hundred.
const STATE_SQL = `COALESCE(h.state, CASE h.status ${Object.entries(FROM_LEGACY).map(([from, to]) => `WHEN '${from}' THEN '${to}'`).join(" ")} ELSE h.status END)`;
// Finished in a way a person has something to look at. A stopped job was
// stopped by a person, who has looked already.
const REVIEWABLE = ["done", "failed"];
const REVIEWS = ["accepted", "sent_back"];

/**
 * Whether a new job may run at once or waits for a person.
 *
 * A person's own request runs. An agent's waits for a person, unless the
 * project has said its agents may start work by themselves. A requester type
 * nobody recorded is treated as an agent, because the safe mistake is asking.
 */
function approvalFor({ requesterType = null, autoApprove = false } = {}) {
  if (requesterType === "human") return { state: "queued", approval: "not_needed" };
  if (autoApprove) return { state: "queued", approval: "auto" };
  return { state: "needs_approval", approval: "pending" };
}

/**
 * Every folder a project says its work is in, best first: repositories, then
 * workspace folders, then projects.path. The same order a Workbench Start uses.
 */
function folders(sql, projectId) {
  const out = [];
  for (const r of sql("SELECT path FROM repos WHERE project_id = :p1 ORDER BY is_primary DESC, id", [projectId])) out.push(r.path);
  for (const w of sql(`SELECT w.path FROM project_workspaces pw JOIN workspaces w ON w.id = pw.workspace_id
                        WHERE pw.project_id = :p1 ORDER BY pw.is_primary DESC, w.sort_order, w.id`, [projectId])) out.push(w.path);
  const p = sql("SELECT path FROM projects WHERE id = :p1", [projectId])[0];
  if (p && p.path) out.push(p.path);
  return [...new Set(out.filter(Boolean))];
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * Why a job in this project could not run, as a sentence that says exactly
 * what to set, or null when there is somewhere for it to work.
 */
function folderProblem(sql, projectId) {
  const project = sql("SELECT id, key, name FROM projects WHERE id = :p1", [projectId])[0];
  if (!project) return `There is no project ${projectId}.`;
  const list = folders(sql, projectId);
  if (!list.length) {
    return `Project ${project.name} has no folder, so there is nowhere for an agent to work. ` +
      `In Delphi, open the project's settings and set its Folder to where its code is (or add a repository to it), then ask again.`;
  }
  if (!list.some(isDir)) {
    return `Project ${project.name}'s folder (${list[0]}) is not there any more. ` +
      `In Delphi, open the project's settings and point its Folder at where the code is now, then ask again.`;
  }
  return null;
}

/** The first folder of the project's that exists, for a job that only reads. */
function readFolder(sql, projectId) {
  return folders(sql, projectId).find(isDir) || null;
}

const RUN_SELECT = `SELECT h.*, p.key AS project_key, p.name AS project_name, t.title AS task_title,
       hs.label AS harness_label, w.path AS workbench_path, w.branch AS workbench_branch, w.state AS workbench_state
  FROM handoffs h
  LEFT JOIN projects p ON p.id = h.project_id
  LEFT JOIN tasks t ON t.id = h.task_id
  LEFT JOIN harnesses hs ON hs.key = h.to_harness
  LEFT JOIN workbenches w ON w.id = h.workbench_id`;

/** A row as every surface sees it: the Runs panel, run_status and run_list. */
function toRun(row) {
  if (!row) return null;
  let context = null;
  if (row.context_json) { try { context = JSON.parse(row.context_json); } catch { context = row.context_json; } }
  const state = row.state || FROM_LEGACY[row.status] || row.status;
  return {
    id: Number(row.id),
    state,
    kind: row.kind || "ask",
    source: row.source || "handoff",
    project_id: row.project_id == null ? null : Number(row.project_id),
    project_key: row.project_key || null,
    project_name: row.project_name || null,
    task_id: row.task_id == null ? null : Number(row.task_id),
    task_title: row.task_title || null,
    harness: row.to_harness,
    harness_label: row.harness_label || row.to_harness,
    request: row.request,
    context,
    reply: row.reply || null,
    requested_by: row.requested_by || null,
    requester_type: row.requester_type || null,
    approval: row.approval || null,
    approved_by: row.approved_by || null,
    approved_at: row.approved_at || null,
    actor: row.actor || null,
    workbench: row.workbench_id == null ? null : {
      id: Number(row.workbench_id), path: row.workbench_path || null, branch: row.workbench_branch || null, state: row.workbench_state || null,
    },
    cwd: row.cwd || null,
    unguarded: Number(row.unguarded) === 1,
    tokens_in: row.tokens_in == null ? null : Number(row.tokens_in),
    tokens_out: row.tokens_out == null ? null : Number(row.tokens_out),
    cost_usd: row.cost_usd == null ? null : Number(row.cost_usd),
    last_activity: row.last_activity || null,
    turns: Number(row.turns || 0),
    premium_requests: row.premium_requests == null ? null : Number(row.premium_requests),
    queue_rank: row.queue_rank == null ? null : Number(row.queue_rank),
    review: row.review || null,
    review_note: row.review_note || null,
    reviewed_by: row.reviewed_by || null,
    reviewed_at: row.reviewed_at || null,
    needs_review: REVIEWABLE.includes(state) && Boolean(row.state) && !row.reviewed_at,
    native_session: row.native_session || null,
    followup: row.followup || null,
    runner_pid: row.runner_pid == null ? null : Number(row.runner_pid),
    runner_host: row.runner_host || null,
    agent_pid: row.agent_pid == null ? null : Number(row.agent_pid),
    from_session_id: row.from_session_id == null ? null : Number(row.from_session_id),
    wake: Number(row.wake) === 1,
    status: row.status,
    created_at: row.created_at,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    updated_at: row.updated_at || null,
  };
}

function get(sql, id) {
  return toRun(sql(`${RUN_SELECT} WHERE h.id = :p1`, [Number(id)])[0]);
}

/**
 * Jobs, newest first. states narrows to those states; a row with no state (an
 * older server's) is matched by what toRun reads it as. needsReview narrows to
 * finished jobs (done or failed) nobody has reviewed. Only rows the dispatcher
 * wrote count: an older server's finished handoff was harvested by the agent
 * that asked, and a backlog of those is not something a person owes a look.
 */
function list(sql, { projectId = null, states = null, taskId = null, actor = null, needsReview = false, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (projectId != null) { params.push(Number(projectId)); where.push(`h.project_id = :p${params.length}`); }
  if (taskId != null) { params.push(Number(taskId)); where.push(`h.task_id = :p${params.length}`); }
  if (actor) { params.push(String(actor)); where.push(`(h.requested_by = :p${params.length} OR h.actor = :p${params.length})`); }
  if (Array.isArray(states) && states.length) {
    for (const s of states) if (!STATES.includes(s)) throw new Error(`states must be some of ${STATES.join(", ")}, not '${s}'.`);
    where.push(`${STATE_SQL} IN (${literalList([...new Set(states)])})`);
  }
  if (needsReview) where.push(`h.state IN (${literalList(REVIEWABLE)}) AND h.reviewed_at IS NULL`);
  params.push(Math.max(1, Math.min(Number(limit) || 100, 500)));
  const rows = sql(`${RUN_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY h.id DESC LIMIT :p${params.length}`, params);
  return rows.map(toRun);
}

/** Writes a new job and returns it as a run. */
/**
 * What a harness row was when a job was approved: its command, its argv
 * template and the rest of what decides what runs. The dispatcher compares it
 * at every spawn, so a row changed after approval (by Settings, or by
 * anything with the database file open) cannot run under that approval.
 */
function harnessHash(sql, key) {
  const row = sql("SELECT command, args_json, parser, mcp_style, trusted_command FROM harnesses WHERE key = :p1", [String(key)])[0];
  if (!row) return null;
  return crypto.createHash("sha256")
    .update(JSON.stringify([row.command, row.args_json, row.parser, row.mcp_style, row.trusted_command]))
    .digest("hex");
}

function insert(sql, {
  projectId, toHarness, request, taskId = null, context = null, wake = true, kind = "ask", source = "handoff",
  requestedBy = null, requesterType = null, fromSessionId = null, state = "queued", approval = null,
}) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be ask (read and answer) or do (change code), not '${kind}'.`);
  if (!STATES.includes(state)) throw new Error(`Not a job state: ${state}`);
  if (!request || !String(request).trim()) throw new Error("A job needs a request: what to do, written for the agent.");
  const row = sql(
    `INSERT INTO handoffs (project_id, from_session_id, to_harness, task_id, request, context_json, wake,
                           kind, state, status, source, requested_by, requester_type, approval, harness_hash, updated_at)
     VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7, :p8, :p9, :p10, :p11, :p12, :p13, :p14, :p15, datetime('now'))
     RETURNING id`,
    [Number(projectId), fromSessionId == null ? null : Number(fromSessionId), String(toHarness), taskId == null ? null : Number(taskId),
     String(request), context == null ? null : (typeof context === "string" ? context : JSON.stringify(context)), wake ? 1 : 0,
     kind, state, LEGACY[state], source, requestedBy, requesterType, approval,
     // Queued now means approved now (a person asked, or the project allows
     // it), so the row it was approved against is recorded now too.
     state === "queued" ? harnessHash(sql, toHarness) : null]
  )[0];
  return get(sql, row.id);
}

const COLUMNS = ["task_id", "reply", "approval", "approved_by", "approved_at", "actor", "workbench_id", "cwd", "runner_pid",
  "runner_host", "agent_pid", "native_session", "unguarded", "tokens_in", "tokens_out", "cost_usd", "last_activity",
  "followup", "turns", "to_session_id", "wake", "queue_rank", "harness_hash"];

/**
 * Changes a job. A new state writes the legacy status beside it, and the
 * timestamps that go with it, so neither can drift from the other. `from`
 * makes the change conditional on the state it was in, which is how a claim
 * or an approval is taken once: the row comes back null when someone else
 * moved it first.
 */
function update(sql, id, fields = {}, { from = null } = {}) {
  const sets = [];
  const params = [];
  const add = (expr, value) => { params.push(value); sets.push(`${expr} = :p${params.length}`); };
  for (const key of COLUMNS) if (fields[key] !== undefined) add(key, fields[key]);
  if (fields.state !== undefined) {
    if (!STATES.includes(fields.state)) throw new Error(`Not a job state: ${fields.state}`);
    add("state", fields.state);
    add("status", LEGACY[fields.state]);
    // A new turn is new work: whatever was reviewed before is not what it
    // will finish with, and its place in the queue is used up.
    if (fields.state === "running") {
      sets.push("started_at = COALESCE(started_at, datetime('now'))", "finished_at = NULL", "queue_rank = NULL",
        "reviewed_at = NULL", "reviewed_by = NULL", "review = NULL", "review_note = NULL");
    }
    if (FINAL.includes(fields.state)) sets.push("finished_at = datetime('now')");
    if (fields.state === "queued" || fields.state === "waiting_on_human") sets.push("finished_at = NULL");
  }
  if (!sets.length) return get(sql, id);
  sets.push("updated_at = datetime('now')");
  params.push(Number(id));
  let where = `id = :p${params.length}`;
  if (from) {
    const list = Array.isArray(from) ? from : [from];
    for (const s of list) if (!STATES.includes(s)) throw new Error(`Not a job state: ${s}`);
    where += ` AND state IN (${literalList(list)})`;
  }
  const row = sql(`UPDATE handoffs SET ${sets.join(", ")} WHERE ${where} RETURNING id`, params)[0];
  return row ? get(sql, row.id) : null;
}

/**
 * The project a job belongs to. A job about a task is the task's project's:
 * its Workbench is built there, so its approval and its permission to run
 * unguarded must come from there too, never from a project named beside it.
 * A different project named alongside the task is refused rather than
 * corrected, because the caller believed something that is not true.
 */
function projectFor(sql, { projectId = null, taskId = null } = {}) {
  if (taskId == null) {
    if (projectId == null) throw new Error("A job needs a project, or a task to take its project from.");
    return Number(projectId);
  }
  const task = sql("SELECT t.id, t.project_id, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = :p1", [Number(taskId)])[0];
  if (!task) throw new Error(`There is no task ${taskId}.`);
  if (task.project_id == null) throw new Error(`Task ${taskId} is not in a project, so there is nowhere for a job on it to run. Put it in a project first.`);
  if (projectId != null && Number(projectId) !== Number(task.project_id)) {
    const named = sql("SELECT name FROM projects WHERE id = :p1", [Number(projectId)])[0];
    throw new Error(`Task ${taskId} is in project ${task.project_name} (${task.project_id}), not ${named ? named.name : "project"} (${projectId}). ` +
      "A job runs in its task's project; leave the project out, or name that one.");
  }
  return Number(task.project_id);
}

/**
 * Records a person's review of a finished job, once. Null when the job is not
 * done or failed, or was reviewed already, so two windows cannot both send the
 * same job back.
 */
function review(sql, id, { accepted, by, note = null }) {
  const verdict = accepted ? "accepted" : "sent_back";
  if (!REVIEWS.includes(verdict)) throw new Error(`Not a review: ${verdict}`);
  const row = sql(`UPDATE handoffs SET reviewed_at = datetime('now'), reviewed_by = :p1, review = :p2, review_note = :p3, updated_at = datetime('now')
                    WHERE id = :p4 AND state IN (${literalList(REVIEWABLE)}) AND reviewed_at IS NULL RETURNING id`,
                  [String(by), verdict, note, Number(id)])[0];
  return row ? get(sql, row.id) : null;
}

/**
 * Puts queued jobs in a person's order: ids first, as given, then every other
 * queued job in the order it would have run, so ranking three does not shuffle
 * the rest. Throws, changing nothing, when an id is not a queued job.
 */
function reorder(sql, ids) {
  if (!Array.isArray(ids) || !ids.length) throw new Error("Reordering needs the queued jobs' ids, first to run first.");
  const wanted = ids.map(Number);
  if (wanted.some((n) => !Number.isInteger(n))) throw new Error("Job ids are whole numbers.");
  if (new Set(wanted).size !== wanted.length) throw new Error("A job can only be in the order once.");
  const queued = sql(`SELECT id FROM handoffs WHERE state = 'queued' ORDER BY ${PICK_ORDER}`, []).map((r) => Number(r.id));
  const notQueued = wanted.filter((n) => !queued.includes(n));
  if (notQueued.length) {
    throw new Error(`Only queued jobs can be reordered, and ${notQueued.length === 1 ? `job ${notQueued[0]} is` : `jobs ${notQueued.join(", ")} are`} not queued now.`);
  }
  const order = [...wanted, ...queued.filter((n) => !wanted.includes(n))];
  order.forEach((n, i) => sql("UPDATE handoffs SET queue_rank = :p1, updated_at = datetime('now') WHERE id = :p2 AND state = 'queued'", [i + 1, n]));
  return order;
}

// The order the dispatcher takes queued jobs in: a person's ranking first,
// then oldest first.
const PICK_ORDER = "queue_rank IS NULL, queue_rank, id";

/**
 * Jobs waiting on a person whose questions a person has now answered, put
 * back in the queue with the answers as their next turn. Shared, so an answer
 * given through the MCP server moves the job at once rather than whenever the
 * app next looks; only a person's answer counts, so an agent cannot answer
 * its own question and carry on. taskId narrows it to one task.
 */
function resumeAnswered(sql, { taskId = null } = {}) {
  const out = [];
  const params = [];
  let narrow = "";
  if (taskId != null) { params.push(Number(taskId)); narrow = ` AND task_id = :p1`; }
  for (const row of sql(`SELECT id, task_id, actor, updated_at FROM handoffs WHERE state = 'waiting_on_human' AND task_id IS NOT NULL AND actor IS NOT NULL${narrow}`, params)) {
    const open = sql(`SELECT COUNT(*) AS n FROM comments c WHERE c.task_id = :p1 AND c.kind = 'ask' AND c.author = :p2
                       AND NOT EXISTS (SELECT 1 FROM comments d WHERE d.kind = 'decide' AND d.ref_id = c.id)`, [row.task_id, row.actor])[0].n;
    if (Number(open)) continue;
    const answers = sql(`SELECT a.body AS question, d.meta AS meta, d.body AS body FROM comments d JOIN comments a ON a.id = d.ref_id
                          WHERE d.kind = 'decide' AND d.author_type = 'human'
                            AND a.task_id = :p1 AND a.author = :p2 AND d.created_at >= :p3 ORDER BY d.id`,
                        [row.task_id, row.actor, row.updated_at || "0"]);
    if (!answers.length) continue;
    const lines = answers.map((a) => {
      let m = {};
      try { m = JSON.parse(a.meta) || {}; } catch {}
      const why = String(a.body || "").split("\n").slice(1).join(" ").trim();
      return `- "${a.question}": ${m.choice || "?"}) ${m.label || ""}${why ? `. ${why}` : ""}`;
    });
    const after = update(sql, row.id, { state: "queued", followup: `A person answered on the Sheet:\n${lines.join("\n")}\n\nCarry on from there.` }, { from: "waiting_on_human" });
    if (after) out.push(after);
  }
  return out;
}

/** How many jobs this project finished in the last hour. The loop breaker. */
function finishedSince(sql, projectId, hours = 1) {
  return Number(sql(
    `SELECT COUNT(*) AS n FROM handoffs WHERE project_id = :p1 AND finished_at IS NOT NULL
       AND finished_at > datetime('now', :p2)`,
    [Number(projectId), `-${Number(hours)} hours`]
  )[0].n);
}

module.exports = {
  STATES, OPEN, FINAL, KINDS, LEGACY, OPEN_SQL, STATE_SQL, REVIEWABLE, PICK_ORDER,
  approvalFor, projectFor, harnessHash, folders, folderProblem, readFolder, toRun, get, list, insert, update, finishedSince,
  review, reorder, resumeAnswered,
};
