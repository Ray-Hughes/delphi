/**
 * Which project something done in a folder belongs to, when the folder is
 * several projects'.
 *
 * ~/va/caseflow is SSNR's and Central Office's. An agent filing a task from it
 * without naming a project used to land in no project, and slice 4's answer
 * (a folder is one project's, and Today asks about the rest) asked a person a
 * question Delphi could answer itself. This answers it, in this order:
 *
 *   a. what the agent was launched from: its job's task, its session, or the
 *      project the harness scoped it to. Never a guess.
 *   b. a Workbench: the folder or the branch is one task's, so its project.
 *   c. a ticket or a project key in the branch name, then in the latest
 *      commit's subject: APREQ-987 matches the project whose name or key
 *      carries it, or one holding a task with it as its ref, Jira key or in
 *      its title.
 *   d. the project most recently active in the folder: a session or a job
 *      that ran there, or an item a person moved after it was filed there.
 *   e. the folder's Home project (the oldest, when it is several projects'
 *      Home).
 *
 * A folder only one project has needs none of c to e, and is no guess. c to e
 * are, and say so (`guessed`): the caller records the filing in filed_routes
 * so the window can show "Filed under SSNR, from branch" with a Move.
 *
 * Shared by the app and the MCP server like workbench/folders.js: handed
 * sql(query, params) in the :p1 style, and what git says handed in as facts
 * ({ branch, subject }), so resolve() is pure and either route gives the same
 * answer. readGit() is the one part that runs git, for a caller that has none.
 */

const path = require("path");
const { execFileSync } = require("child_process");
const folders = require("./folders");
const discover = require("./discover");

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const LIVE_BENCH = "('active', 'parked', 'missing', 'closing')";

/** What each via says on a chip, after "Filed under SSNR, ". */
const WHY = {
  branch: "from branch",
  commit: "from the latest commit",
  recent: "most recent in this folder",
  home: "the folder's Home",
};

/** Tickets as written in a branch or a subject: APREQ-987, apreq-987. Upper case, once each. */
function tickets(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,14}-\d{1,7})(?![0-9])/g)) {
    const t = m[1].toUpperCase();
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** The words of a branch name: feature/ssnr-mpi_fix is feature, ssnr, mpi, fix. */
const words = (text) => String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Whether a project's key names it in this text: the whole key as a run of
 * the text's words (ssnr-mpi in feature/ssnr-mpi-fix), or its first word when
 * that is at least four letters and the key's own (ssnr in ssnr/fix). Short
 * first words (co, ui) are too common to mean a project.
 */
function keyIn(key, text) {
  const k = words(key);
  const t = words(text);
  if (!k.length || !t.length) return false;
  // A one-word key shorter than four letters (co, ui) is too common to mean a
  // project, whole or not.
  if (k.length === 1 && k[0].length < 4) return false;
  for (let i = 0; i + k.length <= t.length; i++) if (k.every((w, j) => t[i + j] === w)) return true;
  return k[0].length >= 4 && /[a-z]/.test(k[0]) && t.includes(k[0]);
}

/** The folders known to Delphi that hold `cwd`, deepest first, each with the projects that have it. */
function foldersHolding(sql, cwd) {
  const here = discover.key(cwd);
  if (!here) return [];
  const seen = new Map();
  const add = (p) => {
    const k = discover.key(p);
    if (k && discover.within(here, k) && !seen.has(k)) seen.set(k, p);
  };
  for (const r of sql("SELECT path FROM projects WHERE path IS NOT NULL AND path != '' AND status != 'archived'", [])) add(r.path);
  for (const r of sql("SELECT r.path FROM repos r JOIN projects p ON p.id = r.project_id WHERE r.is_primary = 0 AND p.status != 'archived'", [])) add(r.path);
  return [...seen].sort((a, b) => b[0].length - a[0].length).map(([, folder]) => ({
    folder,
    projects: folders.holders(sql, folder).filter((p) => p.status !== "archived"),
  })).filter((f) => f.projects.length);
}

/** The project a launch names: a job's task, a task, a session, then the harness's scope. */
function launched(sql, { jobId = null, taskId = null, sessionId = null, scopeProject = null }) {
  const project = (id) => (id == null ? null : sql("SELECT id, name, status FROM projects WHERE id = :p1", [Number(id)])[0] || null);
  if (jobId != null) {
    const job = sql(`SELECT h.project_id, h.task_id, t.project_id AS task_project FROM handoffs h LEFT JOIN tasks t ON t.id = h.task_id
                      WHERE h.id = :p1`, [Number(jobId)])[0];
    const p = job && project(job.task_project ?? job.project_id);
    if (p) return { projectId: Number(p.id), via: "job", detail: { job_id: Number(jobId), task_id: num(job.task_id) } };
  }
  if (taskId != null) {
    const t = sql("SELECT project_id FROM tasks WHERE id = :p1", [Number(taskId)])[0];
    const p = t && project(t.project_id);
    if (p) return { projectId: Number(p.id), via: "task", detail: { task_id: Number(taskId) } };
  }
  if (sessionId != null) {
    const s = sql("SELECT project_id FROM sessions WHERE id = :p1", [Number(sessionId)])[0];
    const p = s && project(s.project_id);
    if (p) return { projectId: Number(p.id), via: "session", detail: { session_id: Number(sessionId) } };
  }
  const p = project(scopeProject);
  if (p) return { projectId: Number(p.id), via: "scope", detail: {} };
  return null;
}

/** The task whose Workbench this folder or branch is. */
function workbench(sql, { cwd = null, branch = null }) {
  const rows = sql(`SELECT w.path, w.branch, w.task_id, t.project_id FROM workbenches w JOIN tasks t ON t.id = w.task_id
                     WHERE w.state IN ${LIVE_BENCH} AND t.project_id IS NOT NULL ORDER BY w.id DESC`, []);
  const here = discover.key(cwd);
  const at = here ? rows.find((w) => discover.within(here, discover.key(w.path))) : null;
  if (at) return { projectId: Number(at.project_id), via: "workbench", detail: { task_id: Number(at.task_id), branch: at.branch } };
  const named = branch ? rows.find((w) => w.branch === branch) : null;
  if (named) return { projectId: Number(named.project_id), via: "workbench", detail: { task_id: Number(named.task_id), branch: named.branch } };
  return null;
}

/** c: the one candidate a ticket or a key in this text names, or null. */
function named(sql, candidates, text) {
  if (!text) return null;
  const found = tickets(text);
  const hits = new Map();
  for (const p of candidates) {
    const row = sql("SELECT key, name FROM projects WHERE id = :p1", [p.id])[0] || {};
    const label = `${row.key || ""} ${row.name || ""}`.toUpperCase();
    for (const t of found) {
      // A whole word in the name: APREQ-987 is not APREQ-9870.
      const whole = new RegExp(`(^|[^A-Z0-9])${t.replace(/[^A-Z0-9-]/g, "")}(?![0-9])`);
      if (whole.test(label)) { hits.set(p.id, { ticket: t, by: "project" }); break; }
      // LIKE finds the candidates; the title is then read for the ticket as a
      // whole word, so APPEALS-12 never matches a task about APPEALS-120.
      const exact = whole;
      const task = sql(`SELECT id, title, ref, external_key FROM tasks WHERE project_id = :p1
                          AND (UPPER(COALESCE(ref, '')) = :p2 OR UPPER(COALESCE(external_key, '')) = :p3 OR UPPER(title) LIKE :p4)
                        ORDER BY id DESC LIMIT 200`, [p.id, t, `JIRA:${t}`, `%${t}%`])
        .find((x) => String(x.ref || "").toUpperCase() === t || String(x.external_key || "").toUpperCase() === `JIRA:${t}` || exact.test(String(x.title || "").toUpperCase()));
      if (task) { hits.set(p.id, { ticket: t, by: "task", task_id: Number(task.id) }); break; }
    }
    if (!hits.has(p.id) && keyIn(row.key, text)) hits.set(p.id, { key: row.key, by: "key" });
  }
  // Two projects named by one branch is no answer: fall through to d.
  if (hits.size !== 1) return null;
  const [[projectId, why]] = [...hits];
  return { projectId, why };
}

/** d: the candidate with the newest activity in this folder, or null. */
function recent(sql, candidates, folder) {
  const ids = candidates.map((p) => Number(p.id));
  if (!ids.length) return null;
  const inList = ids.join(", ");
  // Escaped, because a folder named my_repo is not a pattern for my-repo.
  const like = `${folder.replace(/[\\/]+$/, "").replace(/[\\%_]/g, (c) => `\\${c}`)}${path.sep === "\\" ? "\\\\" : path.sep}%`;
  const under = [folder, like];
  const rows = [
    // A session or a job that wrote History while working in the folder.
    ...sql(`SELECT s.project_id AS pid, MAX(a.id) AS n, MAX(a.at) AS at FROM audit a JOIN sessions s ON s.id = a.session_id
             WHERE s.project_id IN (${inList}) AND (s.cwd = :p1 OR s.cwd LIKE :p2 ESCAPE '\\') GROUP BY s.project_id`, under),
    ...sql(`SELECT h.project_id AS pid, MAX(a.id) AS n, MAX(a.at) AS at FROM audit a JOIN handoffs h ON h.id = a.job_id
             WHERE h.project_id IN (${inList}) AND (h.cwd = :p1 OR h.cwd LIKE :p2 ESCAPE '\\') GROUP BY h.project_id`, under),
    // Where a person put items filed from the folder: a Move or a "That's
    // right" says which project this folder's work is. Settled rows only, or
    // Delphi's own first guess would vote for itself every time after.
    ...sql(`SELECT project_id AS pid, NULL AS n, MAX(settled_at) AS at FROM filed_routes
             WHERE settled_at IS NOT NULL AND project_id IN (${inList}) AND (folder = :p1 OR folder LIKE :p2 ESCAPE '\\') GROUP BY project_id`, under),
  ].filter((r) => r.pid != null && r.at);
  if (!rows.length) return null;
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)) || Number(b.n || 0) - Number(a.n || 0));
  return { projectId: Number(rows[0].pid), why: { at: rows[0].at } };
}

/**
 * The project for work done here, and how it was found.
 *
 *   facts: { jobId, taskId, sessionId, scopeProject, cwd, branch, subject }
 *
 * Returns null when nothing names a project (a folder no project has), else
 * { projectId, via, guessed, folder, detail, candidates }.
 */
function resolve(sql, facts = {}) {
  const { cwd = null, branch = null, subject = null } = facts;
  const a = launched(sql, facts);
  if (a) return { ...a, guessed: false, folder: null, candidates: [a.projectId] };
  const b = workbench(sql, { cwd, branch });
  if (b) return { ...b, guessed: false, folder: null, candidates: [b.projectId] };
  const holding = cwd ? foldersHolding(sql, cwd) : [];
  if (!holding.length) return null;
  const { folder, projects } = holding[0];
  const candidates = projects.map((p) => p.id);
  const answer = (projectId, via, guessed, detail = {}) => ({ projectId: Number(projectId), via, guessed, folder, detail, candidates });
  if (projects.length === 1) return answer(projects[0].id, "folder", false);
  const fromBranch = named(sql, projects, branch);
  if (fromBranch) return answer(fromBranch.projectId, "branch", true, { branch, ...fromBranch.why });
  const fromCommit = named(sql, projects, subject);
  if (fromCommit) return answer(fromCommit.projectId, "commit", true, { subject, ...fromCommit.why });
  const last = recent(sql, projects, folder);
  if (last) return answer(last.projectId, "recent", true, last.why);
  const homes = projects.filter((p) => p.home);
  return answer((homes[0] || projects[0]).id, "home", true);
}

/**
 * The project a folder no project has yet probably is, for discovery's "Add
 * to project": a ticket or key in the branch the session was on, then in the
 * latest commit's subject, then the folder's own name naming a project's key.
 * Among every active project. Null when nothing points at one: a suggestion
 * is only worth making when there is a reason to give.
 */
function suggest(sql, { folder = null, branch = null, subject = null } = {}) {
  const all = sql("SELECT id FROM projects WHERE status != 'archived' ORDER BY sort_order, id", []).map((p) => ({ id: Number(p.id) }));
  const fromBranch = named(sql, all, branch);
  if (fromBranch) return { projectId: fromBranch.projectId, via: "branch", why: WHY.branch, detail: fromBranch.why };
  const fromCommit = named(sql, all, subject);
  if (fromCommit) return { projectId: fromCommit.projectId, via: "commit", why: WHY.commit, detail: fromCommit.why };
  const base = folder ? path.basename(String(folder)) : "";
  const byName = base ? named(sql, all, base) : null;
  if (byName) return { projectId: byName.projectId, via: "name", why: "from the folder's name", detail: byName.why };
  return null;
}

/**
 * Every candidate for a folder, best first, for a list a person picks from
 * (discovery's "Add to project", the Move menu): the resolver's answer, then
 * the rest of the folder's projects.
 */
function ranked(sql, facts = {}) {
  const r = resolve(sql, facts);
  if (!r) return [];
  return [r.projectId, ...r.candidates.filter((id) => id !== r.projectId)];
}

/** "Filed under SSNR, from branch": the chip's words, from a filed_routes row and the project's name. */
function chipWords(row, projectName) {
  return `Filed under ${projectName}, ${WHY[row.via] || "by a guess"}`;
}

/** The statement that records a guessed filing. entityIdSql is SQL text for the id (a RETURNING lookup in a batch). */
function recordStatement(entity, entityIdSql, route, actor = null) {
  return [`INSERT INTO filed_routes (entity, entity_id, project_id, folder, via, detail, actor)
           VALUES (:p1, ${entityIdSql}, :p2, :p3, :p4, :p5, :p6)
           ON CONFLICT(entity, entity_id) DO UPDATE SET project_id = excluded.project_id, folder = excluded.folder,
             via = excluded.via, detail = excluded.detail, actor = excluded.actor, created_at = datetime('now'), settled_at = NULL`,
    [entity, route.projectId, route.folder, route.via, JSON.stringify(route.detail || {}), actor]];
}

/**
 * What git says about a folder: its branch and its latest commit's subject.
 * The one part that runs anything, bounded so a folder on a drive that is not
 * there cannot hold a tool call up. Nulls when it is not a repository.
 */
function readGit(cwd, { run = execFileSync, timeout = 1500 } = {}) {
  const ask = (...args) => {
    try { return String(run("git", ["-C", cwd, ...args], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] })).trim() || null; } catch { return null; }
  };
  if (!cwd) return { branch: null, subject: null };
  const branch = ask("rev-parse", "--abbrev-ref", "HEAD");
  return { branch: branch === "HEAD" ? null : branch, subject: branch ? ask("log", "-1", "--format=%s") : null };
}

module.exports = { resolve, ranked, suggest, tickets, keyIn, foldersHolding, chipWords, recordStatement, readGit, WHY };
