/**
 * The workbenches rows, and the repos rows they hang off.
 *
 * Shared by the app and the MCP server for the reason sheet/store.js gives: it
 * is SQL text and rules, handed a sql(query, params) function in the :p1
 * style, so one implementation serves both routes. The same two consequences
 * follow: every insert uses RETURNING, and nothing assumes a transaction spans
 * two calls.
 *
 * Nothing here runs git. Whether a folder is a repository, and which branch is
 * where, is workbench.js's business; this only knows what Delphi recorded.
 */

const STATES = ["active", "parked", "finished", "discarded", "missing"];
// Live is what the unique indexes count. Missing is live on purpose: it is
// still the task's Workbench until someone picks Recreate or Forget.
const LIVE = ["active", "parked", "missing"];
const CLOSED = ["finished", "discarded"];
// Finished and discarded rows drop out of lists after this long. They are
// never deleted, because History links to them and the branch names in them
// are how someone finds old work again.
const HIDE_AFTER_DAYS = 90;

const LIVE_SQL = LIVE.map((s) => `'${s}'`).join(", ");

const SELECT = `SELECT w.*, t.title AS task_title, t.status AS task_status, t.project_id AS project_id,
       r.name AS repo_name, r.path AS repo_path
  FROM workbenches w
  JOIN tasks t ON t.id = w.task_id
  JOIN repos r ON r.id = w.repo_id`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** A row as every surface sees it. */
function shape(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    task_id: Number(row.task_id),
    task_title: row.task_title,
    task_status: row.task_status,
    project_id: num(row.project_id),
    repo_id: Number(row.repo_id),
    repo_name: row.repo_name,
    repo_path: row.repo_path,
    path: row.path,
    branch: row.branch,
    base: row.base,
    state: row.state,
    owner: row.owner || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at || null,
  };
}

function idOf(value, what) {
  const n = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${what} must be a whole number, got '${value}'.`);
  }
  return n;
}

function makeWorkbenchStore({ sql, actor = "agent" } = {}) {
  if (typeof sql !== "function") throw new Error("makeWorkbenchStore needs a sql(query, params) function");
  const writer = String(actor || "agent");

  function find(id) {
    return shape(sql(`${SELECT} WHERE w.id = :p1`, [idOf(id, "Workbench id")])[0]);
  }

  function get(id) {
    const row = find(id);
    if (!row) throw new Error(`No Workbench ${id}.`);
    return row;
  }

  function task(taskId) {
    const id = idOf(taskId, "task_id");
    const row = sql("SELECT * FROM tasks WHERE id = :p1", [id])[0];
    if (!row) throw new Error(`No task ${id}.`);
    return row;
  }

  /** The task's live Workbench: in the given repo, else its primary repo's, else the newest. */
  function live(taskId, repoId = null) {
    const id = idOf(taskId, "task_id");
    const rows = sql(`${SELECT} WHERE w.task_id = :p1 AND w.state IN (${LIVE_SQL})
                      ORDER BY r.is_primary DESC, w.id DESC`, [id]).map(shape);
    if (repoId != null) return rows.find((r) => r.repo_id === Number(repoId)) || null;
    return rows[0] || null;
  }

  function byPath(p) {
    return shape(sql(`${SELECT} WHERE w.path = :p1 AND w.state IN (${LIVE_SQL})`, [String(p)])[0]);
  }

  /**
   * Live ones, optionally for one project. includeClosed adds finished and
   * discarded rows that closed within HIDE_AFTER_DAYS.
   */
  function list({ projectId = null, includeClosed = false } = {}) {
    const where = [includeClosed
      ? `(w.state IN (${LIVE_SQL}) OR w.closed_at >= datetime('now', '-${HIDE_AFTER_DAYS} days'))`
      : `w.state IN (${LIVE_SQL})`];
    const params = [];
    if (projectId != null) {
      params.push(idOf(projectId, "project_id"));
      where.push(`t.project_id = :p${params.length}`);
    }
    return sql(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY w.updated_at DESC, w.id DESC`, params).map(shape);
  }

  function insert({ taskId, repoId, path, branch, base, state = "active" }) {
    if (!STATES.includes(state)) throw new Error(`state must be one of ${STATES.join(", ")}`);
    const row = sql(`INSERT INTO workbenches (task_id, repo_id, path, branch, base, state, owner)
                     VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7) RETURNING id`,
                    [idOf(taskId, "task_id"), idOf(repoId, "repo_id"), String(path), String(branch), String(base), state, writer])[0];
    return get(row.id);
  }

  function setState(id, state) {
    if (!STATES.includes(state)) throw new Error(`state must be one of ${STATES.join(", ")}`);
    const closing = CLOSED.includes(state);
    sql(`UPDATE workbenches SET state = :p1, updated_at = datetime('now'),
           closed_at = ${closing ? "datetime('now')" : "NULL"} WHERE id = :p2`, [state, idOf(id, "Workbench id")]);
    return get(id);
  }

  function touch(id) {
    sql("UPDATE workbenches SET updated_at = datetime('now') WHERE id = :p1", [idOf(id, "Workbench id")]);
    return get(id);
  }

  /**
   * Every folder the task's project says its code is in, best first: repos
   * (primary first), then the project's workspace folders (primary first),
   * then projects.path. repos is empty in most real databases, which is why the
   * other two count at all. Whether each is a git repository is not known here.
   */
  function repoFolders(projectId) {
    if (projectId == null) return [];
    const pid = idOf(projectId, "project_id");
    const out = [];
    for (const r of sql("SELECT id, name, path, is_primary FROM repos WHERE project_id = :p1 ORDER BY is_primary DESC, id", [pid])) {
      out.push({ repo_id: Number(r.id), name: r.name, path: r.path, source: "repo", is_primary: Number(r.is_primary) ? 1 : 0 });
    }
    for (const w of sql(`SELECT w.name, w.path, pw.is_primary FROM project_workspaces pw
                           JOIN workspaces w ON w.id = pw.workspace_id
                          WHERE pw.project_id = :p1 ORDER BY pw.is_primary DESC, w.sort_order, w.id`, [pid])) {
      out.push({ repo_id: null, name: w.name, path: w.path, source: "workspace", is_primary: Number(w.is_primary) ? 1 : 0 });
    }
    const project = sql("SELECT name, path FROM projects WHERE id = :p1", [pid])[0];
    if (project && project.path) out.push({ repo_id: null, name: project.name, path: project.path, source: "project", is_primary: 0 });
    return out;
  }

  function repo(id) {
    const row = sql("SELECT * FROM repos WHERE id = :p1", [idOf(id, "repo id")])[0];
    if (!row) throw new Error(`No repository ${id}.`);
    return row;
  }

  /**
   * A folder made into a repos row, so a Workbench has a repo_id and the per
   * repo settings (base branch, setup, files to copy) have somewhere to live.
   * Primary when the project has none yet, which is what the person meant by
   * pointing the project at that folder in the first place.
   */
  function adoptRepo({ projectId, path, name }) {
    const pid = idOf(projectId, "project_id");
    const existing = sql("SELECT * FROM repos WHERE project_id = :p1 AND path = :p2", [pid, String(path)])[0];
    if (existing) return existing;
    const hasPrimary = sql("SELECT 1 AS one FROM repos WHERE project_id = :p1 AND is_primary = 1", [pid]).length > 0;
    return sql(`INSERT INTO repos (project_id, name, path, is_primary) VALUES (:p1, :p2, :p3, :p4) RETURNING *`,
               [pid, String(name || path), String(path), hasPrimary ? 0 : 1])[0];
  }

  /** Every repo that has ever had a Workbench, for housekeeping. */
  function reposInUse() {
    return sql("SELECT * FROM repos WHERE id IN (SELECT DISTINCT repo_id FROM workbenches) ORDER BY id", []);
  }

  function allRepos() {
    return sql("SELECT * FROM repos ORDER BY id", []);
  }

  /**
   * The per repo Workbench settings. An empty base branch means "detect", an
   * empty setup command means "run nothing" (null means "not detected yet"),
   * and an empty copy list means "copy nothing" (null means the default).
   */
  function updateRepo(id, fields = {}) {
    const row = repo(id);
    const sets = [];
    const params = [];
    if (fields.base_branch !== undefined) {
      let v = fields.base_branch == null ? null : String(fields.base_branch).trim();
      if (v === "") v = null;
      if (v !== null && (!/^[A-Za-z0-9._/-]{1,200}$/.test(v) || v.includes("..") || v.startsWith("-") || v.endsWith("/"))) {
        throw new Error(`'${v}' is not a branch name git would accept.`);
      }
      params.push(v); sets.push(`base_branch = :p${params.length}`);
    }
    if (fields.setup_cmd !== undefined) {
      const v = fields.setup_cmd == null ? null : String(fields.setup_cmd).trim();
      if (v && (v.length > 1000 || /[\r\n]/.test(v))) throw new Error("The setup command must be one line, under 1000 characters. Put anything longer in a script.");
      params.push(v); sets.push(`setup_cmd = :p${params.length}`);
    }
    if (fields.copy_files !== undefined) {
      const v = fields.copy_files == null ? null
        : String(fields.copy_files).split(",").map((s) => s.trim()).filter(Boolean).join(",");
      if (v && v.length > 1000) throw new Error("The list of files to copy is too long.");
      params.push(v); sets.push(`copy_files = :p${params.length}`);
    }
    if (!sets.length) return row;
    params.push(row.id);
    return sql(`UPDATE repos SET ${sets.join(", ")} WHERE id = :p${params.length} RETURNING *`, params)[0];
  }

  // Audited against the task, as Sheet entries are: "started workbench" belongs
  // in the task's history, where someone looking for where the work went will
  // look.
  function audit(taskId, summary) {
    const t = sql("SELECT id, title FROM tasks WHERE id = :p1", [idOf(taskId, "task_id")])[0];
    if (!t) return;
    sql(`INSERT INTO audit (action, entity, entity_id, summary, label)
         VALUES ('update', 'task', :p1, :p2, :p3)`, [t.id, `${summary} (by ${writer})`, t.title]);
  }

  return { find, get, task, live, byPath, list, insert, setState, touch, repoFolders, repo, adoptRepo, reposInUse, allRepos, updateRepo, audit, actor: writer };
}

module.exports = { STATES, LIVE, CLOSED, HIDE_AFTER_DAYS, shape, makeWorkbenchStore };
