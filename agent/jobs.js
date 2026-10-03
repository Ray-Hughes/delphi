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
 * older server's) is matched by what toRun reads it as.
 */
function list(sql, { projectId = null, states = null, taskId = null, actor = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (projectId != null) { params.push(Number(projectId)); where.push(`h.project_id = :p${params.length}`); }
  if (taskId != null) { params.push(Number(taskId)); where.push(`h.task_id = :p${params.length}`); }
  if (actor) { params.push(String(actor)); where.push(`(h.requested_by = :p${params.length} OR h.actor = :p${params.length})`); }
  params.push(Math.max(1, Math.min(Number(limit) || 100, 500)));
  const rows = sql(`${RUN_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY h.id DESC LIMIT :p${params.length}`, params);
  const wanted = Array.isArray(states) && states.length ? new Set(states) : null;
  if (wanted) {
    for (const s of wanted) if (!STATES.includes(s)) throw new Error(`states must be some of ${STATES.join(", ")}, not '${s}'.`);
  }
  return rows.map(toRun).filter((r) => !wanted || wanted.has(r.state));
}

/** Writes a new job and returns it as a run. */
function insert(sql, {
  projectId, toHarness, request, taskId = null, context = null, wake = true, kind = "ask", source = "handoff",
  requestedBy = null, requesterType = null, fromSessionId = null, state = "queued", approval = null,
}) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be ask (read and answer) or do (change code), not '${kind}'.`);
  if (!STATES.includes(state)) throw new Error(`Not a job state: ${state}`);
  if (!request || !String(request).trim()) throw new Error("A job needs a request: what to do, written for the agent.");
  const row = sql(
    `INSERT INTO handoffs (project_id, from_session_id, to_harness, task_id, request, context_json, wake,
                           kind, state, status, source, requested_by, requester_type, approval, updated_at)
     VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7, :p8, :p9, :p10, :p11, :p12, :p13, :p14, datetime('now'))
     RETURNING id`,
    [Number(projectId), fromSessionId == null ? null : Number(fromSessionId), String(toHarness), taskId == null ? null : Number(taskId),
     String(request), context == null ? null : (typeof context === "string" ? context : JSON.stringify(context)), wake ? 1 : 0,
     kind, state, LEGACY[state], source, requestedBy, requesterType, approval]
  )[0];
  return get(sql, row.id);
}

const COLUMNS = ["task_id", "reply", "approval", "approved_by", "approved_at", "actor", "workbench_id", "cwd", "runner_pid",
  "runner_host", "agent_pid", "native_session", "unguarded", "tokens_in", "tokens_out", "cost_usd", "last_activity",
  "followup", "turns", "to_session_id", "wake"];

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
    if (fields.state === "running") sets.push("started_at = COALESCE(started_at, datetime('now'))", "finished_at = NULL");
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

/** How many jobs this project finished in the last hour. The loop breaker. */
function finishedSince(sql, projectId, hours = 1) {
  return Number(sql(
    `SELECT COUNT(*) AS n FROM handoffs WHERE project_id = :p1 AND finished_at IS NOT NULL
       AND finished_at > datetime('now', :p2)`,
    [Number(projectId), `-${Number(hours)} hours`]
  )[0].n);
}

module.exports = {
  STATES, OPEN, FINAL, KINDS, LEGACY, OPEN_SQL,
  approvalFor, folders, folderProblem, readFolder, toRun, get, list, insert, update, finishedSince,
};
