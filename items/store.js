/**
 * Items that cross projects: move, copy, also-belongs-to, and flag for review.
 *
 * Shared by the app and the MCP server in the mould of sheet/store.js: SQL text
 * and rules, handed a sql(query, params) function in the server's :p1 style and
 * a batch(statements) function that runs a list of them as one transaction. The
 * app passes db.sqlP and a batch on its handle; the server passes its own,
 * which on the sqlite3 route writes every statement into one file and runs it
 * in one process. One implementation, two routes, and the same History rows
 * whichever side made the change. The twin that drifted is the reason this
 * exists: update_task used to move a task and leave it filed under an epic in
 * the project it had left, while db.updateTask cleared it.
 *
 * Three rules hold everywhere below.
 *
 * - The home is the item's own project_id. item_projects holds only the other
 *   projects an item is shown in, so "where does this live" has one answer.
 * - A change that has to land together is one batch. On the sqlite3 route no
 *   transaction spans two sql() calls, so a move written as several calls could
 *   leave a parent in one project and its subtasks in another.
 * - Nothing an agent does here applies a proposal. Flags and proposals are
 *   records; apply runs only from decide, and decide refuses an agent.
 */

const pads = require("../pads");
const { makeEvaluator } = require("./evaluate");

// What each kind of item is, as the store needs to know it: its table, the
// column a person reads as its name, and the audit entity History files it
// under. The audit CHECK cannot be widened cheaply, so an epic and a repository
// are recorded against the project they moved into, which is where History
// shows them anyway.
const KINDS = {
  task: { table: "tasks", label: "title", audit: "task" },
  note: { table: "notes", label: "title", audit: "note" },
  scratchpad: { table: "scratchpads", label: "title", audit: "scratchpad" },
  link: { table: "links", label: "label", audit: "link" },
  organizer: { table: "organizers", label: "name", audit: "project" },
  session: { table: "sessions", label: "title", audit: "session" },
  repo: { table: "repos", label: "name", audit: "project" },
};
const MOVABLE = Object.keys(KINDS);
// Subtasks, epics, sessions and repositories are never shown in a second
// project on their own: a subtask appears wherever its parent does, and the
// rest are containers or places, not things a person files twice.
const ASSOCIABLE = ["task", "note", "scratchpad", "link"];
const COPYABLE = ["task", "note", "scratchpad", "link"];
const FLAGGABLE = ["task", "note", "scratchpad", "link", "organizer", "session"];
const OPS = ["move", "copy", "associate", "dissociate"];
const FLAG_STATUSES = ["open", "evaluating", "proposed", "applied", "rejected", "withdrawn", "stale", "failed"];
const LIVE = ["open", "evaluating", "proposed"];
const SOURCES = ["person", "agent", "sweep"];
const AUTHOR_TYPES = ["human", "agent", "tool"];
const ENTRY_KINDS = ["say", "note", "ask", "decide"];
const EVIDENCE_TYPES = ["text", "url", "task", "note", "pad", "project"];
// A Workbench in one of these still holds its folder and branch, so the task
// it belongs to keeps the project whose repository that is in view.
const LIVE_BENCH = "('active', 'parked', 'missing', 'closing')";
const MAX_OPS = 3;
const NOTE_CHARS = 4000;
const REASON_CHARS = 600;

/** A refusal: the sentences say what is in the way and what to do about it. */
class Refused extends Error {
  constructor(refusals) {
    super(refusals.join(" "));
    this.code = "REFUSED";
    this.details = { refusals };
  }
}

/**
 * A whole number id, or a sentence saying what was wrong with it. The same rule
 * as sheet/store.js: Number() would take true, "0x1" and "1e0", and an id that
 * is secretly 1 is how the wrong item moves.
 */
function idOf(value, what) {
  const ok = (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    || (typeof value === "string" && /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)) && Number(value) > 0);
  if (!ok) throw new Error(`${what} must be a whole number, got '${value}'.`);
  return Number(value);
}

const clip = (text, limit) => {
  const value = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const parseJson = (text, fallback = null) => {
  if (text === null || text === undefined || text === "") return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
};
const sameId = (a, b) => a != null && b != null && Number(a) === Number(b);

/**
 * The condition that puts an item in a project: its home, or an association.
 *
 * Every reader that lists a project's items builds it here, so no query writes
 * it by hand and none can forget the second half. param is the placeholder the
 * caller binds the project id to: ":p1" for a store, ":projectId" for db.js.
 */
function inProject(entity, alias, param) {
  if (!ASSOCIABLE.includes(entity)) throw new Error(`${entity} is never shown in a second project.`);
  return `(${alias}.project_id = ${param} OR ${alias}.id IN (SELECT entity_id FROM item_projects
             WHERE project_id = ${param} AND entity = '${entity}'))`;
}

function makeItemStore({
  sql, batch = null, actor = "agent", authorType = null, settings = () => ({}),
  derive = null, agentEvaluator = null,
} = {}) {
  if (typeof sql !== "function") throw new Error("makeItemStore needs a sql(query, params) function");
  const writer = String(actor || "agent");
  const writerType = AUTHOR_TYPES.includes(authorType) ? authorType : null;
  // Without a batch the statements still run, one call each. Only a caller
  // that has neither a handle nor a script route would do that, and the tests
  // are the only such caller; both real sides pass one.
  const runAll = typeof batch === "function"
    ? (statements) => { if (statements.length) batch(statements); }
    : (statements) => { for (const [q, p] of statements) sql(q, p); };
  const evaluator = makeEvaluator({ sql, settings });

  // --- reading -------------------------------------------------------------------

  const projectRef = (id) => {
    if (id == null) return null;
    const row = sql("SELECT id, key, name, colour, status FROM projects WHERE id = :p1", [Number(id)])[0];
    return row ? { id: Number(row.id), key: row.key, name: row.name, colour: row.colour || null, archived: row.status === "archived" } : null;
  };
  const projectName = (id) => (projectRef(id) || { name: id == null ? "no project" : `project ${id}` }).name;

  function rowOf(entity, id) {
    const kind = KINDS[entity];
    if (!kind) throw new Error(`entity must be one of ${MOVABLE.join(", ")}, not '${entity}'.`);
    return sql(`SELECT * FROM ${kind.table} WHERE id = :p1`, [Number(id)])[0] || null;
  }
  const labelOf = (entity, row) => (row ? row[KINDS[entity].label] : null);

  /** A task and every task under it, parents before children. */
  function subtree(rootId) {
    return sql(
      `WITH RECURSIVE sub(id, depth) AS (
         SELECT :p1, 0
         UNION ALL SELECT t.id, sub.depth + 1 FROM tasks t JOIN sub ON t.parent_id = sub.id)
       SELECT t.*, sub.depth AS depth FROM tasks t JOIN sub ON sub.id = t.id ORDER BY sub.depth, t.id`,
      [Number(rootId)]);
  }
  const idList = (rows) => rows.map((r) => Number(r.id)).join(", ");

  const associations = (entity, id) => sql(
    `SELECT ip.*, p.key, p.name, p.colour FROM item_projects ip JOIN projects p ON p.id = ip.project_id
      WHERE ip.entity = :p1 AND ip.entity_id = :p2 ORDER BY ip.added_at, ip.project_id`, [entity, Number(id)]);

  /** The live Workbenches on these tasks, with the project each one's repository is in. */
  function benchesOn(taskRows) {
    if (!taskRows.length) return [];
    return sql(
      `SELECT w.id, w.task_id, w.path, w.branch, w.state, r.project_id AS repo_project_id, r.name AS repo
         FROM workbenches w JOIN repos r ON r.id = w.repo_id
        WHERE w.task_id IN (${idList(taskRows)}) AND w.state IN ${LIVE_BENCH}`);
  }

  /** What would stop work on these tasks being moved out from under whoever is doing it. */
  function workRefusals(taskRows) {
    if (!taskRows.length) return [];
    const ids = idList(taskRows);
    const out = [];
    for (const t of sql(`SELECT id, claimed_by, claim_expires FROM tasks
                          WHERE id IN (${ids}) AND claimed_by IS NOT NULL AND claim_expires > datetime('now')`)) {
      out.push(`Task ${t.id} is held by ${t.claimed_by} until ${t.claim_expires}; release it or wait.`);
    }
    for (const h of sql(`SELECT id, task_id, to_harness, COALESCE(state, status) AS state FROM handoffs
                          WHERE task_id IN (${ids})
                            AND (state IN ('queued', 'running') OR (state IS NULL AND status IN ('queued', 'running')))`)) {
      out.push(`Job ${h.id} (${h.to_harness}) is ${h.state} on task ${h.task_id}; stop it or let it finish first.`);
    }
    for (const c of sql(`SELECT id, task_id FROM comments
                          WHERE task_id IN (${ids}) AND kind = 'run'
                            AND (CASE WHEN json_valid(meta) THEN json_extract(meta, '$.state') END) = 'running'`)) {
      out.push(`A command is still running on task ${c.task_id}'s Sheet (entry ${c.id}); wait for it or interrupt it.`);
    }
    return out;
  }

  function jobNotices(taskRows) {
    if (!taskRows.length) return [];
    return sql(`SELECT id, task_id, state FROM handoffs WHERE task_id IN (${idList(taskRows)})
                 AND state IN ('needs_approval', 'waiting_on_human')`)
      .map((h) => `Job ${h.id} on task ${h.task_id} is ${h.state === "needs_approval" ? "waiting for approval" : "waiting on a person"}; it will run against the task where it now lives.`);
  }

  // --- the operation ---------------------------------------------------------------

  /** An op in its one shape, or a sentence saying what is wrong with it. */
  function normalise(raw) {
    if (!raw || typeof raw !== "object") throw new Error("An op is an object: {op, entity, id, to}.");
    const op = String(raw.op || "").toLowerCase();
    if (!OPS.includes(op)) throw new Error(`op must be one of ${OPS.join(", ")}, not '${raw.op}'.`);
    const entity = String(raw.entity || "");
    const allowed = op === "move" ? MOVABLE : op === "copy" ? COPYABLE : ASSOCIABLE;
    if (!allowed.includes(entity)) throw new Error(`${op} works on ${allowed.join(", ")}, not '${entity}'.`);
    const id = idOf(raw.id, `${entity} id`);
    const toRaw = raw.to ?? raw.projectId ?? raw.project_id;
    const to = idOf(toRaw, "The project (to)");
    const options = raw.options && typeof raw.options === "object" ? { ...raw.options } : {};
    // keepInSource is the one option a proposal names at the top level, so it
    // is accepted in both places.
    if (raw.keepInSource !== undefined && options.keepInSource === undefined) options.keepInSource = raw.keepInSource;
    return { op, entity, id, to, options };
  }

  /**
   * What an op would do, and everything that would stop it. Never throws for a
   * reason a person could act on: those are refusals, so a proposal that cannot
   * be applied is shown as such rather than failing to be recorded at all.
   */
  function plan(raw) {
    let op;
    try {
      op = normalise(raw);
    } catch (error) {
      return { ok: false, op: raw || null, refusals: [error.message], notices: [], counts: {}, summary: error.message };
    }
    const result = {
      ok: true, op, item: null, target: projectRef(op.to), counts: {}, workbench: null, pad: null,
      keepInSource: Boolean(op.options.keepInSource), refusals: [], notices: [], summary: "",
    };
    const refuse = (text) => result.refusals.push(text);
    const row = rowOf(op.entity, op.id);
    if (!row) refuse(`There is no ${op.entity} ${op.id}.`);
    if (!result.target) refuse(`There is no project ${op.to}.`);
    if (!row || !result.target) return finish(result);
    const home = row.project_id == null ? null : Number(row.project_id);
    result.item = { entity: op.entity, id: op.id, label: labelOf(op.entity, row), home: projectRef(home) };
    if (op.entity === "task" && row.parent_id != null) result.item.parent_id = Number(row.parent_id);
    const there = result.target.name;
    if (result.target.archived && op.op !== "dissociate") result.notices.push(`${there} is archived.`);

    if (op.op === "move") planMove(result, op, row, home);
    else if (op.op === "copy") planCopy(result, op, row);
    else if (op.op === "associate") {
      if (op.entity === "task" && row.parent_id != null) refuse(`Task ${op.id} is a subtask; it appears wherever its parent does. Show the parent in ${there} instead.`);
      if (sameId(home, op.to)) refuse(`${result.item.label} already lives in ${there}.`);
      else if (associations(op.entity, op.id).some((a) => sameId(a.project_id, op.to))) result.notices.push(`It is already shown in ${there}.`);
    } else if (op.op === "dissociate") {
      if (!associations(op.entity, op.id).some((a) => sameId(a.project_id, op.to))) {
        refuse(sameId(home, op.to)
          ? `${there} is its home, not an extra project. Move it to take it out of ${there}.`
          : `${result.item.label} is not shown in ${there}.`);
      } else if (op.entity === "task") {
        const pinned = benchesOn(subtree(op.id)).find((w) => sameId(w.repo_project_id, op.to));
        if (pinned) refuse(`Its Workbench is still open in ${pinned.repo}, which is in ${there}; Finish or Discard it before taking the task out of ${there}.`);
      }
    }
    return finish(result);
  }

  function finish(result) {
    result.ok = result.refusals.length === 0;
    result.summary = result.ok ? describe(result) : result.refusals.join(" ");
    return result;
  }

  /** The sentence a picker shows under the button before it is pressed. */
  function describe(p) {
    const { op } = p;
    const there = p.target ? p.target.name : "";
    const c = p.counts || {};
    const parts = [];
    if (op.op === "move" && op.entity === "task") {
      parts.push(`Moves 1 task${c.subtasks ? ` and ${plural(c.subtasks, "subtask", "subtasks")}` : ""}` +
        `${c.entries ? ` with ${plural(c.entries, "Sheet entry", "Sheet entries")}` : ""} to ${there}.`);
    } else if (op.op === "move" && op.entity === "organizer") {
      parts.push(`Moves the epic and ${plural(c.tasks || 0, "task", "tasks")} filed under it to ${there}.`);
    } else if (op.op === "move" && op.entity === "scratchpad") {
      parts.push(`Moves the pad to ${there}${c.tasks ? `, with ${plural(c.tasks, "task", "tasks")} it anchors` : ""}.`);
    } else if (op.op === "move") {
      parts.push(`Moves it to ${there}.`);
    } else if (op.op === "copy") {
      parts.push(op.entity === "task"
        ? `Copies ${plural(c.tasks || 1, "task", "tasks")} to ${there}${c.entries ? ` with ${plural(c.entries, "key entry", "key entries")}` : ""}.`
        : `Copies it to ${there}.`);
    } else if (op.op === "associate") {
      parts.push(`Also shows it in ${there}, from ${p.item && p.item.home ? p.item.home.name : "no project"}.`);
    } else {
      parts.push(`Takes it out of ${there}; it stays in ${p.item && p.item.home ? p.item.home.name : "no project"}.`);
    }
    if (op.op === "move" && p.keepInSource && p.item && p.item.home) parts.push(`It stays visible in ${p.item.home.name}.`);
    return [...parts, ...p.notices].join(" ");
  }

  function planMove(result, op, row, home) {
    const refuse = (text) => result.refusals.push(text);
    const there = result.target.name;
    if (sameId(home, op.to)) refuse(`${result.item.label} already lives in ${there}.`);
    const assoc = ASSOCIABLE.includes(op.entity) ? associations(op.entity, op.id) : [];
    if (assoc.some((a) => sameId(a.project_id, op.to))) result.notices.push(`It was shown in ${there}; that becomes its home.`);

    if (op.entity === "task") {
      if (row.parent_id != null && !op.options.detach) {
        refuse(`Task ${op.id} is a subtask of task ${row.parent_id}; it moves with its parent. Move the parent, or move it out of its parent (detach).`);
      }
      const rows = subtree(op.id);
      result.counts = taskCounts(rows);
      result.refusals.push(...workRefusals(rows));
      result.notices.push(...jobNotices(rows));
      if (op.options.organizerId != null) {
        const epic = sql("SELECT id, project_id, name FROM organizers WHERE id = :p1", [Number(op.options.organizerId)])[0];
        if (!epic) refuse(`There is no epic ${op.options.organizerId}.`);
        else if (!sameId(epic.project_id, op.to)) refuse(`The epic ${epic.name} is not in ${there}.`);
      }
      const benches = benchesOn(rows);
      if (benches.length && home != null) {
        const w = benches[0];
        result.workbench = { id: Number(w.id), task_id: Number(w.task_id), path: w.path, branch: w.branch, state: w.state, repo: w.repo };
        // Allowed (owner decision D3), and the old home stays associated so the
        // work stays visible where its code is. Start, Finish and the list for
        // that repository should still find the task there.
        result.keepInSource = true;
        result.notices.push(`Its Workbench stays in ${w.repo}, so it will also stay visible in ${projectName(home)}.`);
      }
      planPadForTask(result, op, row);
    } else if (op.entity === "scratchpad") {
      const clash = sql("SELECT id FROM scratchpads WHERE project_id = :p1 AND key = :p2", [op.to, row.key])[0];
      if (clash) {
        const key = freePadKey(op.to, `${row.key}-${(projectRef(home) || { key: "moved" }).key}`);
        result.pad = { key, was: row.key };
        result.notices.push(`${there} already has a pad called ${row.key}, so this one becomes ${key}.`);
      }
      const follow = op.options.tasks !== "stay";
      const anchored = sql("SELECT * FROM tasks WHERE pad_id = :p1 AND project_id IS :p2 ORDER BY id", [op.id, home]);
      const anchoredIds = new Set(anchored.map((t) => Number(t.id)));
      const roots = anchored.filter((t) => t.parent_id == null || !anchoredIds.has(Number(t.parent_id)));
      const loose = roots.filter((t) => t.parent_id != null);
      if (loose.length) result.notices.push(`${plural(loose.length, "task", "tasks")} it anchors ${loose.length === 1 ? "is a subtask" : "are subtasks"} of work outside the pad and ${loose.length === 1 ? "stays" : "stay"} with ${loose.length === 1 ? "its parent" : "their parents"}.`);
      const movable = roots.filter((t) => t.parent_id == null);
      if (follow) {
        const all = movable.flatMap((t) => subtree(t.id));
        result.counts = { ...taskCounts(all), tasks: all.length };
        result.refusals.push(...workRefusals(all));
        result.followRoots = movable.map((t) => Number(t.id));
      } else {
        result.counts = { tasks: 0 };
        result.followRoots = [];
        if (anchored.length) result.notices.push(`${plural(anchored.length, "task", "tasks")} it anchors stay in ${projectName(home)} and keep syncing.`);
      }
    } else if (op.entity === "organizer") {
      const filed = sql("SELECT id FROM tasks WHERE organizer_id = :p1 ORDER BY id", [op.id]);
      const all = filed.flatMap((t) => subtree(t.id));
      result.counts = { ...taskCounts(all), tasks: filed.length };
      result.refusals.push(...workRefusals(all));
      const benches = benchesOn(all);
      if (benches.length) result.notices.push(`${plural(benches.length, "task has a Workbench", "tasks have Workbenches")}; ${benches.length === 1 ? "it stays" : "they stay"} visible in ${projectName(home)}.`);
      // The tasks under the epic whose subtree holds a Workbench keep the
      // epic's old project in view, for the reason a single task's move gives.
      result.benchTasks = filed.map((t) => Number(t.id)).filter((id) => benchesOn(subtree(id)).length);
    } else if (op.entity === "session") {
      if (row.run_state && row.run_state !== "idle") refuse(`Session ${op.id} is ${row.run_state}; move it once it is idle.`);
    } else if (op.entity === "repo") {
      const live = sql(`SELECT COUNT(*) AS n FROM workbenches WHERE repo_id = :p1 AND state IN ${LIVE_BENCH}`, [op.id])[0];
      if (Number(live.n)) refuse(`${plural(Number(live.n), "Workbench is", "Workbenches are")} still open in ${row.name}; Finish or Discard ${Number(live.n) === 1 ? "it" : "them"} first.`);
    }
    if (result.keepInSource && !ASSOCIABLE.includes(op.entity)) result.keepInSource = false;
  }

  function planCopy(result, op, row) {
    if (op.entity === "task") {
      const rows = op.options.subtasks === false ? [row] : subtree(op.id);
      const counts = taskCounts(rows);
      // What the copy carries of the Sheet is the ledger (owner decision D4),
      // so that is the count a picker shows, not the whole conversation.
      counts.entries = Number(sql(
        `SELECT COUNT(*) AS n FROM comments c WHERE c.task_id IN (${idList(rows)}) AND c.kind != 'run' AND (c.promoted = 1
            OR (c.kind = 'decide' AND c.ref_id IS NOT NULL)
            OR c.id IN (SELECT d.ref_id FROM comments d WHERE d.task_id = c.task_id AND d.kind = 'decide' AND d.ref_id IS NOT NULL))`)[0].n);
      result.counts = counts;
      if (row.parent_id != null) result.notices.push("The copy is a task of its own, not a subtask.");
      if (op.options.organizerId != null) {
        const epic = sql("SELECT project_id, name FROM organizers WHERE id = :p1", [Number(op.options.organizerId)])[0];
        if (!epic || !sameId(epic.project_id, op.to)) result.refusals.push(`That epic is not in ${result.target.name}.`);
      }
    } else if (op.entity === "scratchpad") {
      result.notices.push(op.options.derive ? "Its checkboxes become new tasks there." : "It is a copy of the document; its checkboxes stay text until you turn deriving on.");
    }
  }

  function taskCounts(rows) {
    if (!rows.length) return { tasks: 0, subtasks: 0, entries: 0, events: 0, alerts: 0 };
    const ids = idList(rows);
    const n = (q) => Number(sql(q)[0].n);
    return {
      tasks: rows.length,
      subtasks: rows.length - 1,
      entries: n(`SELECT COUNT(*) AS n FROM comments WHERE task_id IN (${ids})`),
      events: n(`SELECT COUNT(*) AS n FROM status_events WHERE task_id IN (${ids})`),
      alerts: n(`SELECT COUNT(*) AS n FROM alerts WHERE task_id IN (${ids})`),
    };
  }

  /**
   * Where a moving task's pad line goes. By default it stays: the line keeps
   * syncing from the pad it is in, and nobody's document is edited by a move
   * made from a menu. carry cuts it out and appends it to a pad in the target.
   */
  function planPadForTask(result, op, row) {
    if (row.pad_id == null) return;
    const pad = sql("SELECT id, project_id, key, title, body FROM scratchpads WHERE id = :p1", [row.pad_id])[0];
    if (!pad) return;
    if (op.options.pad !== "carry") {
      result.pad = { mode: "keep", from: { id: Number(pad.id), title: pad.title } };
      result.notices.push(`Its line stays in the pad ${pad.title} and keeps syncing from there.`);
      return;
    }
    if (!pads.cutBlock(pad.body, op.id)) {
      result.pad = { mode: "keep", from: { id: Number(pad.id), title: pad.title } };
      result.notices.push(`The pad ${pad.title} no longer has its line, so there is nothing to carry.`);
      return;
    }
    let target = null;
    if (op.options.targetPadId != null) {
      target = sql("SELECT id, project_id, title FROM scratchpads WHERE id = :p1", [Number(op.options.targetPadId)])[0];
      if (!target) result.refusals.push(`There is no pad ${op.options.targetPadId}.`);
      else if (!sameId(target.project_id, op.to)) result.refusals.push(`The pad ${target.title} is not in ${result.target.name}.`);
    } else {
      target = sql("SELECT id, project_id, title FROM scratchpads WHERE project_id = :p1 AND key = 'plan'", [op.to])[0] || null;
      if (!target) result.notices.push(`${result.target.name} has no plan pad yet, so one is made for the line.`);
    }
    result.pad = { mode: "carry", from: { id: Number(pad.id), title: pad.title }, to: target ? { id: Number(target.id), title: target.title } : null };
  }

  function freePadKey(projectId, wanted) {
    const base = String(wanted).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "pad";
    let key = base;
    for (let n = 2; sql("SELECT id FROM scratchpads WHERE project_id = :p1 AND key = :p2", [projectId, key])[0]; n++) key = `${base}-${n}`;
    return key;
  }

  // --- writing ---------------------------------------------------------------------

  const auditStatement = (action, entity, entityId, summary, label, before, after) => [
    `INSERT INTO audit (action, entity, entity_id, summary, label, before_json, after_json)
     VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7)`,
    [action, entity, entityId, `${summary} (by ${writer})`, label ?? null,
     before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null],
  ];
  /** The newest audit row a batch just wrote. Batches return nothing, on either route. */
  const lastAudit = (entity, entityId, action) => {
    const row = sql(`SELECT id FROM audit WHERE entity = :p1 AND entity_id = :p2 AND action = :p3
                     ORDER BY id DESC LIMIT 1`, [entity, entityId, action])[0];
    return row ? Number(row.id) : null;
  };
  const sheetNote = (taskId, body, meta) => [
    `INSERT INTO comments (task_id, author, author_type, kind, body, meta) VALUES (:p1, :p2, :p3, 'note', :p4, :p5)`,
    [taskId, writer, writerType, body, meta ? JSON.stringify(meta) : null],
  ];
  const via = (ctx) => (ctx && ctx.flagId ? ` (flag ${ctx.flagId})` : "");
  const credit = (ctx) => (ctx && ctx.proposedBy ? `, proposed by ${ctx.proposedBy}` : "");

  /** A task subtree's move, as one statement. */
  const moveSubtree = (rootId, to, organizerId, detach) => [
    `WITH RECURSIVE sub(id) AS (SELECT :p1 UNION ALL SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id)
     UPDATE tasks SET project_id = :p2,
            organizer_id = CASE WHEN id = :p1 THEN :p3 ELSE NULL END,
            parent_id = CASE WHEN id = :p1 AND :p4 = 1 THEN NULL ELSE parent_id END,
            updated_at = datetime('now')
      WHERE id IN (SELECT id FROM sub)`,
    [rootId, to, organizerId ?? null, detach ? 1 : 0],
  ];

  /** The association changes a move makes, as statements, and the record undo needs. */
  function assocForMove(entity, id, from, to, keepInSource, flagId) {
    const statements = [];
    const removed = associations(entity, id).filter((a) => sameId(a.project_id, to))
      .map((a) => [entity, id, Number(a.project_id), a.added_by, a.added_at, a.flag_id == null ? null : Number(a.flag_id)]);
    if (removed.length) {
      statements.push([`DELETE FROM item_projects WHERE entity = :p1 AND entity_id = :p2 AND project_id = :p3`, [entity, id, to]]);
    }
    const added = [];
    if (keepInSource && from != null && !associations(entity, id).some((a) => sameId(a.project_id, from))) {
      statements.push([`INSERT OR IGNORE INTO item_projects (entity, entity_id, project_id, added_by, flag_id)
                        VALUES (:p1, :p2, :p3, :p4, :p5)`, [entity, id, from, writer, flagId ?? null]]);
      added.push([entity, id, from]);
    }
    return { statements, added, removed };
  }

  function executeMove(p, ctx = {}) {
    const { op } = p;
    const row = rowOf(op.entity, op.id);
    const from = row.project_id == null ? null : Number(row.project_id);
    const to = op.to;
    const label = labelOf(op.entity, row);
    const summary = `moved from ${projectName(from)} to ${projectName(to)}${credit(ctx)}`;
    const statements = [];
    const record = { kind: "move", entity: op.entity, id: op.id, from, to, rows: [], assoc_added: [], assoc_removed: [], pads: [], flag_id: ctx.flagId ?? null };
    const moved = { tasks: [], notes: [], scratchpads: [], links: [], organizers: [], sessions: [], repos: [] };

    const moveTaskTree = (rootId, organizerId, detach, keep) => {
      const rows = subtree(rootId);
      for (const t of rows) {
        record.rows.push({ table: "tasks", id: Number(t.id), project_id: t.project_id == null ? null : Number(t.project_id),
          ...(sameId(t.id, rootId) ? { organizer_id: t.organizer_id == null ? null : Number(t.organizer_id), parent_id: t.parent_id == null ? null : Number(t.parent_id) } : {}) });
        moved.tasks.push(Number(t.id));
      }
      statements.push(moveSubtree(rootId, to, organizerId, detach));
      const a = assocForMove("task", rootId, from, to, keep, ctx.flagId);
      statements.push(...a.statements);
      record.assoc_added.push(...a.added);
      record.assoc_removed.push(...a.removed);
      statements.push(sheetNote(rootId, `Moved from ${projectName(from)} to ${projectName(to)} by ${writer}${via(ctx)}.`,
        { moved: { from, to }, ...(ctx.flagId ? { flag_id: ctx.flagId } : {}) }));
      return rows;
    };

    if (op.entity === "task") {
      const rows = moveTaskTree(op.id, op.options.organizerId ?? null, Boolean(op.options.detach && row.parent_id != null), p.keepInSource);
      if (p.pad && p.pad.mode === "carry") carryPad(p, rows, statements, record);
    } else if (op.entity === "note" || op.entity === "link") {
      record.rows.push({ table: KINDS[op.entity].table, id: op.id, project_id: from });
      statements.push([`UPDATE ${KINDS[op.entity].table} SET project_id = :p1${op.entity === "note" ? ", updated_at = datetime('now')" : ""} WHERE id = :p2`, [to, op.id]]);
      const a = assocForMove(op.entity, op.id, from, to, p.keepInSource, ctx.flagId);
      statements.push(...a.statements);
      record.assoc_added.push(...a.added);
      record.assoc_removed.push(...a.removed);
      moved[`${op.entity}s`].push(op.id);
    } else if (op.entity === "scratchpad") {
      record.rows.push({ table: "scratchpads", id: op.id, project_id: from, key: row.key });
      const key = p.pad && p.pad.key ? p.pad.key : row.key;
      statements.push([`UPDATE scratchpads SET project_id = :p1, key = :p2, updated_at = datetime('now') WHERE id = :p3`, [to, key, op.id]]);
      const a = assocForMove("scratchpad", op.id, from, to, p.keepInSource, ctx.flagId);
      statements.push(...a.statements);
      record.assoc_added.push(...a.added);
      record.assoc_removed.push(...a.removed);
      moved.scratchpads.push(op.id);
      for (const rootId of p.followRoots || []) moveTaskTree(rootId, null, false, false);
    } else if (op.entity === "organizer") {
      record.rows.push({ table: "organizers", id: op.id, project_id: from });
      statements.push([`UPDATE organizers SET project_id = :p1, updated_at = datetime('now') WHERE id = :p2`, [to, op.id]]);
      moved.organizers.push(op.id);
      for (const t of sql("SELECT id FROM tasks WHERE organizer_id = :p1 ORDER BY id", [op.id])) {
        // Filed under the epic, so it keeps the epic: the epic is moving too.
        moveTaskTree(Number(t.id), op.id, false, (p.benchTasks || []).includes(Number(t.id)));
      }
    } else if (op.entity === "session") {
      record.rows.push({ table: "sessions", id: op.id, project_id: from });
      statements.push([`UPDATE sessions SET project_id = :p1, updated_at = datetime('now') WHERE id = :p2`, [to, op.id]]);
      moved.sessions.push(op.id);
    } else if (op.entity === "repo") {
      // Not primary where it lands: the target may already have one, and two
      // primaries is two answers to "where do commands run".
      record.rows.push({ table: "repos", id: op.id, project_id: from, is_primary: Number(row.is_primary) ? 1 : 0 });
      statements.push([`UPDATE repos SET project_id = :p1, is_primary = 0 WHERE id = :p2`, [to, op.id]]);
      moved.repos.push(op.id);
    }

    const auditEntity = KINDS[op.entity].audit;
    // An epic or a repository has no audit entity of its own, so its row is
    // filed against the project it moved into, with the one it left in
    // before_json.project_id, which is how the project it left finds it too.
    const auditId = auditEntity === "project" ? to : op.id;
    const before = { id: auditId, project_id: from, __op: record };
    if (auditEntity !== "project" && op.entity === "task") {
      before.organizer_id = row.organizer_id == null ? null : Number(row.organizer_id);
      before.parent_id = row.parent_id == null ? null : Number(row.parent_id);
    }
    const what = auditEntity === "project" ? `${op.entity === "organizer" ? "epic" : "repository"} ${label} ${summary}` : summary;
    statements.push(auditStatement("update", auditEntity, auditId, what, label, before, { id: auditId, project_id: to }));
    statements.push(...(ctx.extra || []));
    runAll(statements);
    return { auditId: lastAudit(auditEntity, auditId, "update"), moved, notices: p.notices };
  }

  /** The statements that carry a task's pad lines to a pad in the target. */
  function carryPad(p, rows, statements, record) {
    const source = sql("SELECT id, body FROM scratchpads WHERE id = :p1", [p.pad.from.id])[0];
    const cut = pads.cutBlock(source.body, p.op.id);
    let target = p.pad.to ? sql("SELECT id, body FROM scratchpads WHERE id = :p1", [p.pad.to.id])[0] : null;
    if (!target) {
      // Made before the batch, because the batch needs its id and the sqlite3
      // route returns nothing from a batch. A plan pad left behind by a batch
      // that then failed is an empty document, which loses nothing.
      target = sql(`INSERT INTO scratchpads (project_id, key, title, body, author) VALUES (:p1, :p2, 'Plan', '', :p3)
                    RETURNING id, body`, [p.op.to, freePadKey(p.op.to, "plan"), writer])[0];
    }
    const targetBody = pads.appendBlock(target.body, cut.block, `Moved from ${p.item.home ? p.item.home.name : "elsewhere"}`);
    statements.push([`UPDATE scratchpads SET body = :p1, updated_at = datetime('now') WHERE id = :p2`, [cut.body, source.id]]);
    statements.push([`UPDATE scratchpads SET body = :p1, updated_at = datetime('now') WHERE id = :p2`, [targetBody, target.id]]);
    // Only the tasks whose lines travelled: a subtask typed into the board has
    // no line and no pad to change.
    const carried = new Set(pads.parse(cut.block).map((e) => e.taskId).filter(Boolean));
    for (const t of rows) {
      if (!carried.has(Number(t.id)) || !sameId(t.pad_id, source.id)) continue;
      statements.push([`UPDATE tasks SET pad_id = :p1, external_key = :p2 WHERE id = :p3`, [Number(target.id), `pad:${target.id}:${t.id}`, Number(t.id)]]);
      const r = record.rows.find((x) => x.table === "tasks" && sameId(x.id, t.id));
      r.pad_id = Number(source.id);
      r.external_key = t.external_key ?? null;
    }
    record.pads.push({ id: Number(source.id), body_before: source.body, body_after: cut.body });
    record.pads.push({ id: Number(target.id), body_before: target.body, body_after: targetBody });
  }

  function executeAssociate(p, ctx = {}) {
    const { op } = p;
    const row = rowOf(op.entity, op.id);
    const label = labelOf(op.entity, row);
    if (associations(op.entity, op.id).some((a) => sameId(a.project_id, op.to))) {
      return { auditId: null, projects: projectsOf(op.entity, op.id), notices: p.notices };
    }
    const record = { kind: "associate", entity: op.entity, id: op.id, project: op.to, flag_id: ctx.flagId ?? null };
    runAll([
      [`INSERT OR IGNORE INTO item_projects (entity, entity_id, project_id, added_by, flag_id) VALUES (:p1, :p2, :p3, :p4, :p5)`,
       [op.entity, op.id, op.to, writer, ctx.flagId ?? null]],
      auditStatement("update", KINDS[op.entity].audit, op.id, `also shown in ${projectName(op.to)}${credit(ctx)}`, label,
        { id: op.id, project_id: row.project_id ?? null, __op: record }, null),
      ...(ctx.extra || []),
    ]);
    return { auditId: lastAudit(KINDS[op.entity].audit, op.id, "update"), projects: projectsOf(op.entity, op.id), notices: p.notices };
  }

  function executeDissociate(p, ctx = {}) {
    const { op } = p;
    const row = rowOf(op.entity, op.id);
    const label = labelOf(op.entity, row);
    const was = associations(op.entity, op.id).find((a) => sameId(a.project_id, op.to));
    const record = { kind: "dissociate", entity: op.entity, id: op.id, project: op.to,
      row: [op.entity, op.id, op.to, was.added_by, was.added_at, was.flag_id == null ? null : Number(was.flag_id)], flag_id: ctx.flagId ?? null };
    runAll([
      [`DELETE FROM item_projects WHERE entity = :p1 AND entity_id = :p2 AND project_id = :p3`, [op.entity, op.id, op.to]],
      auditStatement("update", KINDS[op.entity].audit, op.id, `no longer shown in ${projectName(op.to)}${credit(ctx)}`, label,
        // The project it left, so that project's History still lists it.
        { id: op.id, project_id: op.to, __op: record }, null),
      ...(ctx.extra || []),
    ]);
    return { auditId: lastAudit(KINDS[op.entity].audit, op.id, "update"), projects: projectsOf(op.entity, op.id), notices: p.notices };
  }

  /**
   * A copy, as new rows. Not a batch: the copy's ids come back through
   * RETURNING and the next row needs them. So it is sequential, and a failure
   * part way deletes the copy's root, whose cascade and triggers take every
   * other row it made. A half copy is removed, never kept.
   */
  function executeCopy(p, ctx = {}) {
    const { op } = p;
    const row = rowOf(op.entity, op.id);
    const from = row.project_id == null ? null : Number(row.project_id);
    const label = labelOf(op.entity, row);
    const table = KINDS[op.entity].table;
    let rootCopy = null;
    const pairs = [];
    // Every row made, so a failure can take them all back by id. The server's
    // routes run without foreign keys, so a delete of the root alone would
    // cascade nowhere there and leave the rest behind.
    const madeTasks = [];
    const provenance = (entity, copyId, sourceRow) => sql(
      `INSERT INTO item_copies (entity, entity_id, source_id, source_project_id, source_label, copied_by, flag_id)
       VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7)`,
      [entity, copyId, Number(sourceRow.id), sourceRow.project_id ?? null, labelOf(entity, sourceRow), writer, ctx.flagId ?? null]);
    try {
      if (op.entity === "task") {
        const remap = new Map();
        for (const t of subtree(op.id)) {
          const isRoot = sameId(t.id, op.id);
          if (!isRoot && op.options.subtasks === false) continue;
          const parent = isRoot ? null : remap.get(Number(t.parent_id)) ?? null;
          const made = sql(
            `INSERT INTO tasks (project_id, title, detail, status, priority, owner, due, ref, assignee, colour,
                                parent_id, organizer_id, source, completed_at)
             VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7, :p8, :p9, :p10, :p11, :p12, 'copy', :p13)
             RETURNING *`,
            [op.to, t.title, t.detail ?? null, t.status, t.priority, t.owner ?? null, t.due ?? null, t.ref ?? null,
             t.assignee ?? null, t.colour ?? null, parent, isRoot ? (op.options.organizerId ?? null) : null,
             t.status === "done" ? (t.completed_at ?? null) : null])[0];
          if (isRoot) rootCopy = made;
          madeTasks.push(Number(made.id));
          remap.set(Number(t.id), Number(made.id));
          pairs.push([Number(t.id), Number(made.id)]);
          provenance("task", Number(made.id), t);
          sql("INSERT INTO status_events (task_id, status, actor) VALUES (:p1, :p2, :p3)", [Number(made.id), made.status, writer]);
          sql(`INSERT INTO comments (task_id, author, author_type, kind, body, meta) VALUES (:p1, :p2, :p3, 'note', :p4, :p5)`,
              [Number(made.id), writer, writerType, `Copied from ${projectName(t.project_id)} #${t.id}${via(ctx)}.`,
               JSON.stringify({ copied_from: { task: Number(t.id), project: t.project_id ?? null } })]);
          if (op.options.ledger !== false) copyLedger(Number(t.id), Number(made.id));
        }
      } else if (op.entity === "note") {
        rootCopy = sql(`INSERT INTO notes (project_id, title, body, kind, pinned) VALUES (:p1, :p2, :p3, :p4, 0) RETURNING *`,
                       [op.to, row.title, row.body, row.kind])[0];
        provenance("note", Number(rootCopy.id), row);
      } else if (op.entity === "link") {
        rootCopy = sql(`INSERT INTO links (project_id, label, url, kind) VALUES (:p1, :p2, :p3, :p4) RETURNING *`,
                       [op.to, row.label, row.url, row.kind])[0];
        provenance("link", Number(rootCopy.id), row);
      } else if (op.entity === "scratchpad") {
        // A copy of the document, not of the work, unless asked: the anchors
        // would point the copy at the original's tasks.
        rootCopy = sql(`INSERT INTO scratchpads (project_id, key, title, body, author, derives_tasks) VALUES (:p1, :p2, :p3, :p4, :p5, :p6) RETURNING *`,
                       [op.to, freePadKey(op.to, row.key), row.title, pads.stripAnchors(row.body), writer, op.options.derive ? 1 : 0])[0];
        provenance("scratchpad", Number(rootCopy.id), row);
      }
      if (!rootCopy) throw new Error("Nothing was copied.");
      if (ctx.failAfterRows) throw new Error(ctx.failAfterRows);
      sql(...auditStatement("create", KINDS[op.entity].audit, Number(rootCopy.id),
        `copied from ${projectName(from)} #${op.id}${credit(ctx)}`, label, null, rootCopy));
    } catch (error) {
      try {
        if (madeTasks.length) {
          runAll([
            [`DELETE FROM comments WHERE task_id IN (${madeTasks.join(", ")})`, []],
            [`DELETE FROM status_events WHERE task_id IN (${madeTasks.join(", ")})`, []],
            [`DELETE FROM item_copies WHERE entity = 'task' AND entity_id IN (${madeTasks.join(", ")})`, []],
            [`DELETE FROM tasks WHERE id IN (${madeTasks.join(", ")})`, []],
          ]);
        } else if (rootCopy) {
          sql(`DELETE FROM ${table} WHERE id = :p1`, [Number(rootCopy.id)]);
        }
      } catch {}
      throw new Error(`The copy failed and nothing was kept: ${error.message}`);
    }
    if (ctx.extra && ctx.extra.length) runAll(ctx.extra);
    if (op.entity === "scratchpad" && op.options.derive && typeof derive === "function") derive(Number(rootCopy.id));
    return { id: Number(rootCopy.id), auditId: lastAudit(KINDS[op.entity].audit, Number(rootCopy.id), "create"), copied: { [`${op.entity}s`]: pairs.length ? pairs : [[op.id, Number(rootCopy.id)]] }, notices: p.notices };
  }

  /**
   * A task's ledger onto its copy: promoted entries, every decision and the
   * question it answers, in order (owner decision D4). The chatter stays at
   * the origin, one click away through "copied from". Runs are left out: their
   * logs belong to the original's entry ids.
   */
  function copyLedger(fromTask, toTask) {
    const rows = sql(
      `SELECT * FROM comments c WHERE c.task_id = :p1 AND c.kind != 'run' AND (c.promoted = 1
          OR (c.kind = 'decide' AND c.ref_id IS NOT NULL)
          OR c.id IN (SELECT d.ref_id FROM comments d WHERE d.task_id = :p1 AND d.kind = 'decide' AND d.ref_id IS NOT NULL))
        ORDER BY c.id`, [fromTask]);
    const remap = new Map();
    for (const c of rows) {
      const meta = { ...(parseJson(c.meta, {}) || {}), copied_from_entry: Number(c.id) };
      const made = sql(
        `INSERT INTO comments (task_id, author, author_type, kind, body, meta, promoted, ref_id, created_at)
         VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7, :p8, :p9) RETURNING id`,
        [toTask, c.author, c.author_type ?? null, c.kind, c.body, JSON.stringify(meta), Number(c.promoted) ? 1 : 0,
         c.ref_id == null ? null : remap.get(Number(c.ref_id)) ?? null, c.created_at])[0];
      remap.set(Number(c.id), Number(made.id));
    }
  }

  // --- the verbs ---------------------------------------------------------------------

  /**
   * Applies ops, after planning each one again: the world may have changed
   * since a proposal was made. Any refusal refuses the lot, before anything is
   * written.
   */
  function apply(ops, ctx = {}) {
    const list = Array.isArray(ops) ? ops : [ops];
    if (!list.length || list.length > MAX_OPS) throw new Error(`Between 1 and ${MAX_OPS} ops at a time.`);
    const plans = list.map(plan);
    const refusals = plans.flatMap((p) => p.refusals);
    if (refusals.length) throw new Refused(refusals);
    const results = [];
    plans.forEach((p, i) => {
      // The flag's own bookkeeping rides with the last op's batch, so an
      // applied flag and its applied change land together.
      const extra = i === plans.length - 1 ? ctx.extra || [] : [];
      const c = { ...ctx, extra };
      if (p.op.op === "move") results.push(executeMove(p, c));
      else if (p.op.op === "copy") results.push(executeCopy(p, c));
      else if (p.op.op === "associate") results.push(executeAssociate(p, c));
      else results.push(executeDissociate(p, c));
    });
    return { auditIds: results.map((r) => r.auditId).filter((id) => id != null), results };
  }

  const move = (entity, id, to, options = {}) => apply([{ op: "move", entity, id, to, options }]).results[0];
  const copy = (entity, id, to, options = {}) => apply([{ op: "copy", entity, id, to, options }]).results[0];
  const associate = (entity, id, projectId) => apply([{ op: "associate", entity, id, to: projectId }]).results[0];
  const dissociate = (entity, id, projectId) => apply([{ op: "dissociate", entity, id, to: projectId }]).results[0];

  function projectsOf(entity, id) {
    return associations(entity, id).map((a) => ({ id: Number(a.project_id), key: a.key, name: a.name, colour: a.colour || null }));
  }

  /** Home, the other projects, where a copy came from and what copies exist, and a live flag. */
  function where(entity, id) {
    if (!KINDS[entity]) throw new Error(`entity must be one of ${MOVABLE.join(", ")}, not '${entity}'.`);
    const itemId = idOf(id, `${entity} id`);
    const row = rowOf(entity, itemId);
    if (!row) throw new Error(`There is no ${entity} ${itemId}.`);
    const copyRef = (r, idKey) => ({ entity, id: Number(r[idKey]), label: r.label ?? r.source_label ?? null,
      project: projectRef(r.project_id ?? r.source_project_id), exists: r.exists == null ? true : Boolean(Number(r.exists)) });
    const table = KINDS[entity].table;
    const labelCol = KINDS[entity].label;
    const from = sql(`SELECT c.*, (SELECT COUNT(*) FROM ${table} WHERE id = c.source_id) AS "exists" FROM item_copies c
                       WHERE c.entity = :p1 AND c.entity_id = :p2`, [entity, itemId])[0];
    const copies = sql(`SELECT c.entity_id, x.${labelCol} AS label, x.project_id FROM item_copies c
                         JOIN ${table} x ON x.id = c.entity_id WHERE c.entity = :p1 AND c.source_id = :p2 ORDER BY c.entity_id`, [entity, itemId]);
    const live = sql(`SELECT * FROM item_flags WHERE entity = :p1 AND entity_id = :p2 AND status IN ('open', 'evaluating', 'proposed')`, [entity, itemId])[0];
    return {
      home: projectRef(row.project_id),
      also: ASSOCIABLE.includes(entity) ? projectsOf(entity, itemId) : [],
      copiedFrom: from ? copyRef({ ...from, project_id: from.source_project_id }, "source_id") : null,
      copies: copies.map((c) => copyRef(c, "entity_id")),
      flag: live ? summarise(live) : null,
    };
  }

  // --- undo ----------------------------------------------------------------------------

  /**
   * Reverses a change this store made, from the __op its audit row carries.
   *
   * Exactly the columns and association rows the change touched go back, and
   * nothing else: replaying the stored row used to revert every edit made to a
   * task since it was moved. Refuses with a sentence when the world has moved
   * on, rather than guessing which of two changes a person meant to keep.
   */
  function undo(entry) {
    const before = typeof entry.before_json === "string" ? parseJson(entry.before_json, {}) : entry.before_json || {};
    const op = before.__op;
    if (!op || !op.kind) throw new Error("That change was not made by a move, copy or association.");
    const statements = [];
    if (op.kind === "move") {
      const rootTable = KINDS[op.entity].table;
      const now = sql(`SELECT project_id FROM ${rootTable} WHERE id = :p1`, [op.id])[0];
      if (!now) throw new Error(`That ${op.entity} has been deleted since it was moved.`);
      if (!sameId(now.project_id, op.to)) throw new Error(`It has been moved again since, to ${projectName(now.project_id)}; undo that first.`);
      for (const pad of op.pads || []) {
        const current = sql("SELECT body FROM scratchpads WHERE id = :p1", [pad.id])[0];
        if (!current || current.body !== pad.body_after) throw new Error("The pad has been edited since; restore its line by hand.");
      }
      for (const r of op.rows) {
        const cols = Object.keys(r).filter((k) => k !== "table" && k !== "id");
        const values = cols.map((c) => r[c]);
        statements.push([`UPDATE ${r.table} SET ${cols.map((c, i) => `${c} = :p${i + 1}`).join(", ")} WHERE id = :p${cols.length + 1}`, [...values, r.id]]);
      }
      for (const pad of op.pads || []) statements.push(["UPDATE scratchpads SET body = :p1 WHERE id = :p2", [pad.body_before, pad.id]]);
      for (const [e, id, pid] of op.assoc_added || []) {
        statements.push(["DELETE FROM item_projects WHERE entity = :p1 AND entity_id = :p2 AND project_id = :p3", [e, id, pid]]);
      }
      for (const [e, id, pid, by, at, flag] of op.assoc_removed || []) {
        statements.push([`INSERT OR IGNORE INTO item_projects (entity, entity_id, project_id, added_by, added_at, flag_id)
                          VALUES (:p1, :p2, :p3, :p4, :p5, :p6)`, [e, id, pid, by ?? null, at, flag ?? null]]);
      }
      if (op.entity === "task") statements.push(sheetNote(op.id, `Moved back to ${projectName(op.from)} by ${writer} (undo).`, { moved: { from: op.to, to: op.from, undo: true } }));
    } else if (op.kind === "associate") {
      statements.push(["DELETE FROM item_projects WHERE entity = :p1 AND entity_id = :p2 AND project_id = :p3", [op.entity, op.id, op.project]]);
    } else if (op.kind === "dissociate") {
      const [e, id, pid, by, at, flag] = op.row;
      if (!rowOf(e, id)) throw new Error(`That ${e} has been deleted since.`);
      statements.push([`INSERT OR IGNORE INTO item_projects (entity, entity_id, project_id, added_by, added_at, flag_id)
                        VALUES (:p1, :p2, :p3, :p4, :p5, :p6)`, [e, id, pid, by ?? null, at, flag ?? null]]);
    } else {
      throw new Error(`Cannot undo a ${op.kind}.`);
    }
    // An applied flag goes back to proposed, so it can be approved again or
    // rejected rather than sitting as "applied" over a change that was undone.
    if (op.flag_id) {
      statements.push([`UPDATE item_flags SET status = 'proposed', decided_by = NULL, decided_at = NULL, applied_audit_id = NULL,
                               updated_at = datetime('now') WHERE id = :p1 AND status = 'applied'`, [op.flag_id]]);
      statements.push([`INSERT INTO flag_entries (flag_id, kind, author, author_type, body) VALUES (:p1, 'note', :p2, :p3, :p4)`,
        [op.flag_id, writer, writerType, "The change was undone, so the proposal is open again."]]);
    }
    runAll(statements);
    return { undone: true, kind: op.kind };
  }

  // --- flags ---------------------------------------------------------------------------

  const flagRow = (id) => sql("SELECT * FROM item_flags WHERE id = :p1", [idOf(id, "Flag id")])[0] || null;
  function requireFlag(id) {
    const row = flagRow(id);
    if (!row) throw new Error(`There is no flag ${id}.`);
    return row;
  }

  function cleanEvidence(evidence) {
    if (evidence == null) return [];
    if (!Array.isArray(evidence)) throw new Error("evidence is a list of chips, such as {type: \"task\", id: 151}.");
    return evidence.slice(0, 20).map((chip) => {
      if (!chip || !EVIDENCE_TYPES.includes(chip.type)) throw new Error(`An evidence chip's type is one of ${EVIDENCE_TYPES.join(", ")}.`);
      if (chip.type === "text" || chip.type === "url") return { type: chip.type, value: String(chip.value ?? "").slice(0, 4000) };
      return { type: chip.type, id: idOf(chip.id, `A ${chip.type} chip's id`) };
    });
  }

  const entryStatement = (flagId, kind, body, meta = null, refId = null) => [
    `INSERT INTO flag_entries (flag_id, kind, author, author_type, body, meta, ref_id) VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7)`,
    [flagId, kind, writer, writerType, String(body), meta ? JSON.stringify(meta) : null, refId],
  ];
  const addEntry = (flagId, kind, body, meta = null, refId = null) => {
    if (!ENTRY_KINDS.includes(kind)) throw new Error(`An entry's kind is one of ${ENTRY_KINDS.join(", ")}.`);
    const [q, p] = entryStatement(flagId, kind, body, meta, refId);
    return toEntry(sql(`${q} RETURNING *`, p)[0]);
  };
  const flagAudit = (row, summary) => {
    const auditEntity = KINDS[row.entity].audit;
    const id = auditEntity === "project" ? row.project_id : row.entity_id;
    if (id == null) return;
    // No before_json, like a comment: a flag changes nothing about the item,
    // so there is nothing for undo to put back.
    sql(...auditStatement("update", auditEntity, id, summary, row.label, null, null));
  };

  /**
   * Flags an item as possibly in the wrong place. A second flag on an item
   * that already has a live one is added to it as a remark, so there is never
   * a parallel review that could be approved the other way.
   */
  function flag({ entity, id, note = "", evidence = null, suggest = null, source = null, evaluate = "oracle" } = {}) {
    if (!FLAGGABLE.includes(entity)) throw new Error(`Only ${FLAGGABLE.join(", ")} can be flagged, not '${entity}'.`);
    const itemId = idOf(id, `${entity} id`);
    const row = rowOf(entity, itemId);
    if (!row) throw new Error(`There is no ${entity} ${itemId}.`);
    const text = String(note || "").trim().slice(0, NOTE_CHARS);
    const chips = cleanEvidence(evidence);
    const from = SOURCES.includes(source) ? source : writerType === "agent" ? "agent" : "person";
    const meta = { ...(chips.length ? { evidence: chips } : {}), ...(suggest ? { suggest } : {}) };
    const live = () => sql(`SELECT * FROM item_flags WHERE entity = :p1 AND entity_id = :p2 AND status IN ('open', 'evaluating', 'proposed')`, [entity, itemId])[0];
    let existing = live();
    if (!existing) {
      try {
        existing = sql(
          `INSERT INTO item_flags (entity, entity_id, project_id, label, note, evidence, source, created_by, created_by_type)
           VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7, :p8, :p9) RETURNING *`,
          [entity, itemId, row.project_id ?? null, labelOf(entity, row), text, chips.length ? JSON.stringify(chips) : null,
           from, writer, writerType || (from === "sweep" ? "tool" : null)])[0];
      } catch (error) {
        // Two writers at once: the unique index let one in, and this one adds
        // to it instead. Anything else is a real failure.
        existing = live();
        if (!existing) throw error;
        existing.appendTo = true;
      }
      if (!existing.appendTo) {
        addEntry(Number(existing.id), "say", text || "Flagged for review.", Object.keys(meta).length ? meta : null);
        flagAudit(existing, `flagged for review${text ? `: ${clip(text, 80)}` : ""}`);
        if (evaluate === "oracle") return { flag: evaluateFlag(Number(existing.id), { mode: "oracle" }).flag, appended: false };
        return { flag: summarise(flagRow(existing.id)), appended: false };
      }
    }
    if (text || chips.length) addEntry(Number(existing.id), "say", text || "Flagged again.", Object.keys(meta).length ? meta : null);
    sql("UPDATE item_flags SET updated_at = datetime('now') WHERE id = :p1", [existing.id]);
    return { flag: summarise(flagRow(existing.id)), appended: true };
  }

  /** A remark on a flag. A reply to an evaluator's question, or to a rejection, opens it to another look. */
  function reply(flagId, body) {
    const row = requireFlag(flagId);
    const text = String(body || "").trim();
    if (!text) throw new Error("A reply needs something in it.");
    const last = sql("SELECT kind FROM flag_entries WHERE flag_id = :p1 ORDER BY id DESC LIMIT 1", [row.id])[0];
    const entry = addEntry(Number(row.id), "say", text.slice(0, NOTE_CHARS));
    if (row.status === "rejected") {
      sql("UPDATE item_flags SET status = 'open', updated_at = datetime('now') WHERE id = :p1", [row.id]);
    } else {
      sql("UPDATE item_flags SET updated_at = datetime('now') WHERE id = :p1", [row.id]);
    }
    if (last && last.kind === "ask" && LIVE.includes(row.status)) evaluateFlag(Number(row.id), { mode: "oracle" });
    return entry;
  }

  function cleanOps(ops) {
    if (!Array.isArray(ops) || !ops.length || ops.length > MAX_OPS) throw new Error(`A proposal is 1 to ${MAX_OPS} ops.`);
    return ops.map((o) => {
      const n = normalise(o);
      return { op: n.op, entity: n.entity, id: n.id, to: n.to, ...(Object.keys(n.options).length ? { options: n.options } : {}) };
    });
  }

  /**
   * Records a proposal on a flag, making the flag first when there is none.
   * Never applies anything. The plan of each op is stored with it, refusals
   * and all, so a proposal that could not be applied is visible as such.
   */
  function propose({ flagId = null, entity = null, id = null, ops, reasoning = "", confidence = null, by = null,
                     evaluator: who = null, signals = null } = {}) {
    let row = flagId != null ? requireFlag(flagId) : null;
    if (!row) {
      const made = flag({ entity, id, note: "", evaluate: "none" });
      row = requireFlag(made.flag.id);
    }
    if (!LIVE.includes(row.status) && row.status !== "rejected" && row.status !== "failed") {
      throw new Error(`Flag ${row.id} is ${row.status}; a proposal goes on an open one.`);
    }
    const clean = cleanOps(ops);
    for (const o of clean) {
      if (o.entity !== row.entity || o.id !== Number(row.entity_id)) {
        throw new Error(`Flag ${row.id} is about ${row.entity} ${row.entity_id}; a proposal on it changes that item only.`);
      }
    }
    const plans = clean.map(plan);
    const proposal = {
      ops: clean,
      reasoning: clip(reasoning, REASON_CHARS),
      confidence: confidence == null || !Number.isFinite(Number(confidence)) ? null : Math.max(0, Math.min(1, Number(confidence))),
      ...(signals ? { signals } : {}),
      evaluator: who || (writerType === "agent" ? writer : "person"),
    };
    const proposer = by || proposal.evaluator;
    runAll([
      [`UPDATE item_flags SET status = 'proposed', proposal = :p1, proposed_by = :p2, proposed_at = datetime('now'),
                              updated_at = datetime('now') WHERE id = :p3`, [JSON.stringify(proposal), proposer, row.id]],
      entryStatement(Number(row.id), "note", proposal.reasoning || summaryOf(proposal, row),
        { proposal, plan: plans.map((p) => ({ ok: p.ok, summary: p.summary, refusals: p.refusals })) }),
    ]);
    return { flag: summarise(flagRow(row.id)), plan: plans };
  }

  /** How a proposal reads in a list: "Oracle suggests: move to X, keep in Y (0.82)". */
  function summaryOf(proposal, row) {
    if (!proposal || !Array.isArray(proposal.ops)) return null;
    const words = proposal.ops.map((o) => {
      const there = projectName(o.to);
      const keep = o.options && o.options.keepInSource && row && row.project_id != null ? `, keep in ${projectName(row.project_id)}` : "";
      return o.op === "move" ? `move to ${there}${keep}` : o.op === "copy" ? `copy to ${there}` : o.op === "associate" ? `also show in ${there}` : `take out of ${there}`;
    }).join("; ");
    const who = proposal.evaluator === "oracle@1" ? "Oracle" : proposal.evaluator || "Someone";
    return `${who} suggests: ${words}${proposal.confidence != null ? ` (${proposal.confidence.toFixed(2)})` : ""}`;
  }

  /**
   * A person's decision on a flag. An agent's is refused here, whatever
   * reached this: the tools/list has no approve, the guard blocks the command
   * line's, and this is the floor under both.
   */
  function decide(flagId, { approve, ops = null, note = null, by = null, byType = null } = {}) {
    const row = requireFlag(flagId);
    const type = byType || writerType;
    const who = by || writer;
    if (type === "agent") {
      throw new Error("Approving or rejecting a proposal is a person's decision, and this is an agent. Say what you think in a reply on the flag instead.");
    }
    if (!LIVE.includes(row.status) && !(approve && row.status === "failed")) throw new Error(`Flag ${row.id} is ${row.status}, so there is nothing to decide.`);
    const proposal = parseJson(row.proposal);
    const lastProposal = sql(`SELECT id FROM flag_entries WHERE flag_id = :p1 AND kind = 'note'
                               AND (CASE WHEN json_valid(meta) THEN json_extract(meta, '$.proposal') END) IS NOT NULL
                               ORDER BY id DESC LIMIT 1`, [row.id])[0];
    const refId = lastProposal ? Number(lastProposal.id) : null;
    const why = note ? String(note).trim().slice(0, NOTE_CHARS) : null;
    if (!approve) {
      if (!why) throw new Error("Say why when rejecting, so the next look at it does not propose the same thing.");
      runAll([
        [`UPDATE item_flags SET status = 'rejected', decided_by = :p1, decided_at = datetime('now'), decision_note = :p2,
                                updated_at = datetime('now') WHERE id = :p3`, [who, why, row.id]],
        entryStatement(Number(row.id), "decide", `Rejected: ${why}`, { decision: "reject", by: who }, refId),
      ]);
      flagAudit(row, `proposal rejected: ${clip(why, 80)}`);
      return { flag: summarise(flagRow(row.id)), auditIds: [] };
    }
    const chosen = ops ? cleanOps(ops) : proposal && proposal.ops;
    if (!chosen || !chosen.length) throw new Error(`Flag ${row.id} has no proposal yet; pass the ops to apply.`);
    const edited = Boolean(ops) && JSON.stringify(chosen) !== JSON.stringify(proposal && proposal.ops);
    const body = edited
      ? `Approved with changes: ${summaryOf({ ops: chosen }, row).replace(/^Someone suggests: /, "")} instead of ${proposal ? summaryOf(proposal, row).replace(/^.*? suggests: /, "") : "nothing proposed"}.${why ? ` ${why}` : ""}`
      : `Approved${why ? `: ${why}` : "."}`;
    const extra = [
      [`UPDATE item_flags SET status = 'applied', decided_by = :p1, decided_at = datetime('now'), decision_note = :p2,
                              updated_at = datetime('now') WHERE id = :p3`, [who, why, row.id]],
      entryStatement(Number(row.id), "decide", body, { decision: "approve", by: who, ops: chosen, edited }, refId),
    ];
    let applied;
    try {
      applied = apply(chosen, { flagId: Number(row.id), proposedBy: row.proposed_by || null, extra });
    } catch (error) {
      runAll([
        [`UPDATE item_flags SET status = 'failed', decided_by = :p1, decided_at = datetime('now'), updated_at = datetime('now') WHERE id = :p2`, [who, row.id]],
        entryStatement(Number(row.id), "note", `Could not apply it: ${error.message}`, { decision: "failed" }, refId),
      ]);
      throw error;
    }
    if (applied.auditIds.length) sql("UPDATE item_flags SET applied_audit_id = :p1 WHERE id = :p2", [applied.auditIds[0], row.id]);
    return { flag: summarise(flagRow(row.id)), auditIds: applied.auditIds, results: applied.results };
  }

  function withdraw(flagId) {
    const row = requireFlag(flagId);
    if (!LIVE.includes(row.status)) throw new Error(`Flag ${row.id} is ${row.status} already.`);
    runAll([
      ["UPDATE item_flags SET status = 'withdrawn', updated_at = datetime('now') WHERE id = :p1", [row.id]],
      entryStatement(Number(row.id), "note", `Withdrawn by ${writer}.`),
    ]);
    return summarise(flagRow(row.id));
  }

  function toEntry(r) {
    return {
      id: Number(r.id), flag_id: Number(r.flag_id), kind: r.kind, author: r.author, author_type: r.author_type || null,
      body: r.body, meta: parseJson(r.meta), ref_id: r.ref_id == null ? null : Number(r.ref_id), created_at: r.created_at,
    };
  }

  /** A flag as every list shows it. */
  function summarise(row) {
    if (!row) return null;
    const proposal = parseJson(row.proposal);
    const last = sql("SELECT kind FROM flag_entries WHERE flag_id = :p1 ORDER BY id DESC LIMIT 1", [row.id])[0];
    const count = Number(sql("SELECT COUNT(*) AS n FROM flag_entries WHERE flag_id = :p1", [row.id])[0].n);
    // What it needs from a person: a decision when there is a proposal, an
    // answer when an evaluator asked, a look when it is open with neither.
    const needs = row.status === "proposed" ? "decision" : LIVE.includes(row.status) && last && last.kind === "ask" ? "question"
      : row.status === "open" ? "review" : null;
    return {
      id: Number(row.id), entity: row.entity, entity_id: Number(row.entity_id), label: row.label,
      project: projectRef(row.project_id), status: row.status, source: row.source,
      created_by: row.created_by, created_by_type: row.created_by_type || null,
      note: clip(row.note, 300), evidence: parseJson(row.evidence, []),
      proposal, proposal_summary: summaryOf(proposal, row), proposed_by: row.proposed_by || null,
      needs, decided_by: row.decided_by || null, decision_note: row.decision_note || null,
      applied_audit_id: row.applied_audit_id == null ? null : Number(row.applied_audit_id),
      entries: count, created_at: row.created_at, updated_at: row.updated_at,
    };
  }

  function listFlags({ status = null, projectId = null, source = null, entity = null, entityId = null, limit = 200 } = {}) {
    const where = [];
    const params = [];
    const add = (clause, value) => { params.push(value); where.push(clause.replace("?", `:p${params.length}`)); };
    const statuses = status == null ? LIVE : Array.isArray(status) ? status : [status];
    for (const s of statuses) if (s !== "all" && !FLAG_STATUSES.includes(s)) throw new Error(`status is one of ${FLAG_STATUSES.join(", ")} or all, not '${s}'.`);
    if (!statuses.includes("all")) where.push(`f.status IN (${statuses.map((s) => `'${s}'`).join(", ")})`);
    if (projectId != null) {
      const pid = idOf(projectId, "projectId");
      // Its home when flagged, or a project it is shown in.
      params.push(pid);
      where.push(`(f.project_id = :p${params.length} OR f.entity_id IN (SELECT entity_id FROM item_projects WHERE entity = f.entity AND project_id = :p${params.length}))`);
    }
    if (source) add("f.source = ?", source);
    if (entity) add("f.entity = ?", entity);
    if (entityId != null) add("f.entity_id = ?", idOf(entityId, "entityId"));
    params.push(Math.max(1, Math.min(Number(limit) || 200, 500)));
    return sql(`SELECT f.* FROM item_flags f ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                ORDER BY f.updated_at DESC, f.id DESC LIMIT :p${params.length}`, params).map(summarise);
  }

  function getFlag(id) {
    const row = requireFlag(id);
    const entries = sql("SELECT * FROM flag_entries WHERE flag_id = :p1 ORDER BY id", [row.id]).map(toEntry);
    const proposal = parseJson(row.proposal);
    const plans = proposal && Array.isArray(proposal.ops) && LIVE.includes(row.status) ? proposal.ops.map(plan) : null;
    return { flag: summarise(row), entries, plan: plans };
  }

  /**
   * Flags in the shape the Needs you list draws: decisions and questions, one
   * row each, except the sweep's, which are grouped by where they would go so
   * "18 notes in Claude look like SSNR / MPI" is one row with Approve all.
   */
  function needsYou({ projectId = null } = {}) {
    const rows = listFlags({ status: ["open", "proposed"], projectId });
    const out = [];
    const groups = new Map();
    for (const f of rows) {
      if (!f.needs || (f.needs === "review" && f.source === "sweep")) continue;
      const first = f.proposal && f.proposal.ops && f.proposal.ops[0];
      if (f.source === "sweep" && f.status === "proposed" && first) {
        const key = `${first.op}|${f.project ? f.project.id : ""}|${first.to}|${f.entity}`;
        if (!groups.has(key)) groups.set(key, { first, flags: [], home: f.project, entity: f.entity });
        groups.get(key).flags.push(f);
        continue;
      }
      out.push(needsRow(f));
    }
    for (const g of groups.values()) {
      if (g.flags.length === 1) { out.push(needsRow(g.flags[0])); continue; }
      const noun = { task: ["task", "tasks"], note: ["note", "notes"], scratchpad: ["pad", "pads"], link: ["link", "links"] }[g.entity] || ["item", "items"];
      out.push({
        source: "flag", kind: "decision", group: true, ids: g.flags.map((f) => f.id),
        project_id: g.home ? g.home.id : null,
        title: `${plural(g.flags.length, noun[0], noun[1])} in ${g.home ? g.home.name : "no project"} look like ${projectName(g.first.to)}`,
        summary: `The sweep suggests: ${g.first.op} to ${projectName(g.first.to)}.`,
        created_at: g.flags.map((f) => f.created_at).sort()[0],
        actions: ["approve_all", "review"],
      });
    }
    return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  const needsRow = (f) => ({
    source: "flag", kind: f.needs, id: f.id, project_id: f.project ? f.project.id : null,
    title: f.label || `${f.entity} ${f.entity_id}`,
    summary: f.proposal_summary || (f.needs === "question" ? "The evaluator has a question." : f.note || "Flagged for review."),
    created_at: f.created_at,
    actions: f.needs === "decision" ? ["approve", "edit", "reject", "open"] : ["reply", "open"],
  });

  // --- evaluation --------------------------------------------------------------------

  /**
   * Has a flag looked at. The Oracle answers with no model; an agent is a hook
   * left in place and off (owner decision D6), so asking for one says so
   * rather than quietly doing nothing.
   */
  function evaluateFlag(flagId, { mode = "oracle" } = {}) {
    const row = requireFlag(flagId);
    if (!LIVE.includes(row.status) && row.status !== "rejected") throw new Error(`Flag ${row.id} is ${row.status}, so there is nothing to evaluate.`);
    if (mode === "agent") {
      if (typeof agentEvaluator !== "function") {
        throw new Error("Agent evaluation is turned off; the Oracle evaluates flags. Ask for oracle, or answer it yourself.");
      }
      return agentEvaluator(row, { prompt: evaluator.prompt(row) });
    }
    if (mode !== "oracle") throw new Error(`mode is oracle or agent, not '${mode}'.`);
    const entries = sql("SELECT kind, body, meta FROM flag_entries WHERE flag_id = :p1 ORDER BY id", [row.id]);
    const result = evaluator.evaluate(row, { entries });
    if (result.proposal) {
      // Not the same thing again: a person already said no to it.
      const rejected = row.status === "rejected" && JSON.stringify(parseJson(row.proposal, {}).ops) === JSON.stringify(result.proposal.ops);
      if (!rejected) {
        return propose({ flagId: row.id, ops: result.proposal.ops, reasoning: result.reasoning, confidence: result.confidence,
          by: "oracle", evaluator: "oracle@1", signals: result.signals });
      }
    }
    runAll([
      ["UPDATE item_flags SET status = 'open', updated_at = datetime('now') WHERE id = :p1", [row.id]],
      entryStatement(Number(row.id), "note", result.reasoning || "The Oracle found no clear home for it.",
        { evaluator: "oracle@1", signals: result.signals, proposal: null }),
    ]);
    return { flag: summarise(flagRow(row.id)), plan: null };
  }

  /**
   * Looks for items that seem filed in the wrong place, and flags them. Only
   * flags: nothing is applied, however sure it is. Skips anything with a live
   * flag and anything whose same proposal a person rejected in the last 90
   * days, so dismissing a suggestion makes it stay dismissed.
   */
  function sweep({ projectId = null, limit = 20 } = {}) {
    const cap = Math.max(1, Math.min(Number(limit) || 20, 100));
    const found = evaluator.sweep({ projectId: projectId == null ? null : idOf(projectId, "projectId") });
    const created = [];
    let skipped = 0;
    for (const c of found) {
      if (created.length >= cap) { skipped++; continue; }
      const live = sql(`SELECT id FROM item_flags WHERE entity = :p1 AND entity_id = :p2 AND status IN ('open', 'evaluating', 'proposed')`, [c.entity, c.id])[0];
      const dismissed = sql(`SELECT id FROM item_flags WHERE entity = :p1 AND entity_id = :p2 AND status = 'rejected'
                               AND decided_at >= datetime('now', '-90 days')
                               AND (CASE WHEN json_valid(proposal) THEN json_extract(proposal, '$.ops[0].to') END) = :p3`, [c.entity, c.id, c.to])[0];
      if (live || dismissed) { skipped++; continue; }
      const made = flag({ entity: c.entity, id: c.id, note: `The sweep thinks this belongs in ${projectName(c.to)}.`, source: "sweep", evaluate: "none" });
      const fid = made.flag.id;
      if (c.confidence >= 0.8) {
        propose({ flagId: fid, ops: [{ op: "move", entity: c.entity, id: c.id, to: c.to }], reasoning: c.reasoning,
          confidence: c.confidence, by: "oracle", evaluator: "oracle@1", signals: c.signals });
      } else {
        addEntry(fid, "note", c.reasoning, { evaluator: "oracle@1", signals: c.signals, proposal: null });
      }
      created.push(summarise(flagRow(fid)));
    }
    return { created, skipped };
  }

  // --- deleting a project whose items are shown elsewhere -------------------------------

  /**
   * What a project delete would take that other projects still show (owner
   * decision D7): each item homed here and associated elsewhere, and where it
   * would be rehomed, its first other project. The window offers rehome first.
   */
  function rehomePlan(projectId) {
    const pid = idOf(projectId, "projectId");
    const out = [];
    for (const entity of ASSOCIABLE) {
      const { table, label } = KINDS[entity];
      const rows = sql(
        `SELECT x.id, x.${label} AS label,
                (SELECT ip.project_id FROM item_projects ip WHERE ip.entity = '${entity}' AND ip.entity_id = x.id
                  ORDER BY ip.added_at, ip.project_id LIMIT 1) AS to_project
           FROM ${table} x WHERE x.project_id = :p1
            ${entity === "task" ? "AND x.parent_id IS NULL" : ""}
            AND EXISTS (SELECT 1 FROM item_projects ip WHERE ip.entity = '${entity}' AND ip.entity_id = x.id)
          ORDER BY x.id`, [pid]);
      for (const r of rows) {
        const p = plan({ op: "move", entity, id: Number(r.id), to: Number(r.to_project) });
        out.push({ entity, id: Number(r.id), label: r.label, to: projectRef(r.to_project), ok: p.ok, refusals: p.refusals });
      }
    }
    return { project: projectRef(pid), items: out };
  }

  /** Moves every item rehomePlan names to its first other project. Refused ones are reported, not forced. */
  function rehome(projectId) {
    const planned = rehomePlan(projectId);
    const moved = [];
    const refused = [];
    for (const item of planned.items) {
      try {
        const r = move(item.entity, item.id, item.to.id);
        moved.push({ entity: item.entity, id: item.id, to: item.to, auditId: r.auditId });
      } catch (error) {
        refused.push({ entity: item.entity, id: item.id, reason: error.message });
      }
    }
    return { moved, refused };
  }

  return {
    plan, apply, move, copy, associate, dissociate, where, undo,
    flag, reply, propose, decide, withdraw, listFlags, getFlag, needsYou, summarise,
    evaluate: evaluateFlag, sweep, evalPrompt: (id) => evaluator.prompt(requireFlag(id)),
    rehomePlan, rehome, projectsOf, inProject,
  };
}

module.exports = {
  makeItemStore, inProject, Refused, KINDS, MOVABLE, ASSOCIABLE, COPYABLE, FLAGGABLE, OPS, FLAG_STATUSES,
};
