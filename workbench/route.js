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
 *   b. a Workbench: its folder, or its branch checked out in its own
 *      repository, is one task's, so its project.
 *   c. a ticket or a distinctive project key in the branch name, then in
 *      the latest commit's subject: APREQ-987 matches the project whose name
 *      or key carries it as a whole word, and only failing that one holding
 *      an open task with it as its ref, Jira key or a word of its title; a
 *      key counts only whole (ssnr-mpi, never ssnr).
 *   d. the project most recently active in the folder: a session or a job
 *      that ran there, or an item a person moved or confirmed there.
 *   d2. a key that is a common word (general, test, platform) in the branch
 *      or the subject, which says less than d.
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
 * the text's words (ssnr-mpi in feature/ssnr-mpi-fix), never a part of it. A
 * one-word key shorter than four letters (co, ui) is too common to mean a
 * project at all.
 */
function keyIn(key, text) {
  const k = words(key);
  const t = words(text);
  if (!k.length || !t.length) return false;
  if (k.length === 1 && k[0].length < 4) return false;
  for (let i = 0; i + k.length <= t.length; i++) if (k.every((w, j) => t[i + j] === w)) return true;
  return false;
}

// Words that turn up in branch names and commit subjects whatever the work
// is, so a project keyed on one of them is named by every other branch.
const GENERIC = new Set(("test tests testing general platform monitoring claude main master dev develop development feature fix fixes " +
  "release hotfix docs doc tools tool app apps api web core common misc infra ops data work tasks notes project projects default " +
  "staging prod production update updates cleanup refactor chore build deploy config settings setup scripts script example demo " +
  "temp tmp wip draft review migration migrations queue system systems service services server client frontend backend").split(" "));

/**
 * Whether a key is worth more than the folder's recent activity: it carries
 * a digit (a ticket, a year), or is at least six letters and not a word
 * every branch uses. "general" and "test" are not; "ssnr-mpi" and
 * "co-hearing-address" are.
 */
function distinctive(key) {
  const k = String(key || "").toLowerCase();
  if (!k) return false;
  if (/\d/.test(k)) return true;
  if (k.replace(/[^a-z0-9]/g, "").length < 6) return false;
  return !words(k).every((w) => GENERIC.has(w)) && !GENERIC.has(k);
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
  // An archived project is not where new work goes: fall through to the next
  // step rather than file into it.
  const project = (id) => {
    if (id == null) return null;
    const row = sql("SELECT id, name, status FROM projects WHERE id = :p1", [Number(id)])[0] || null;
    return row && row.status !== "archived" ? row : null;
  };
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

/** Live Workbenches of active projects, with the repository each was made from. */
const benchRows = (sql) => sql(`SELECT w.path, w.branch, w.task_id, t.project_id, r.path AS repo_path FROM workbenches w
                                  JOIN tasks t ON t.id = w.task_id JOIN projects p ON p.id = t.project_id
                                  LEFT JOIN repos r ON r.id = w.repo_id
                                 WHERE w.state IN ${LIVE_BENCH} AND p.status != 'archived' ORDER BY w.id DESC`, []);

/** b: the task whose Workbench folder this is. Needs no git. */
function workbenchAt(sql, cwd) {
  const here = discover.key(cwd);
  if (!here) return null;
  const at = benchRows(sql).find((w) => discover.within(here, discover.key(w.path)));
  return at ? { projectId: Number(at.project_id), via: "workbench", detail: { task_id: Number(at.task_id), branch: at.branch } } : null;
}

/**
 * b, by branch: a Workbench's branch checked out in its own repository's
 * main folder. Only there: the same branch name in another repository is
 * another piece of work, and filing it into this task's project would be
 * certain and wrong.
 */
function workbenchBranch(sql, cwd, branch) {
  const here = discover.key(cwd);
  if (!here || !branch) return null;
  const at = benchRows(sql).find((w) => w.branch === branch && w.repo_path && discover.within(here, discover.key(w.repo_path)));
  return at ? { projectId: Number(at.project_id), via: "workbench", detail: { task_id: Number(at.task_id), branch: at.branch } } : null;
}

/**
 * c: the one candidate this text names, at one strength:
 *   "ticket"  a ticket that is a whole word of a project's name or key, then
 *             (only if no project's own name has it) one that is an open
 *             task's ref, Jira key or a whole word of its title;
 *   "key"     a project's whole key, when the key is distinctive, the
 *             distinctive first word of a hyphenated key, or an alias a
 *             person gave it (namesFor);
 *   "generic" a project's whole key that is a common word, ranked below the
 *             folder's recent activity.
 * Two candidates at the same strength is no answer.
 */
function named(sql, candidates, text, strength) {
  if (!text) return null;
  const rows = candidates.map((p) => ({ id: Number(p.id), ...(sql("SELECT * FROM projects WHERE id = :p1", [p.id])[0] || {}) }));
  const one = (hits) => (hits.size === 1 ? (([[projectId, why]]) => ({ projectId, why }))([...hits]) : null);
  if (strength === "ticket") {
    const found = tickets(text);
    if (!found.length) return null;
    const whole = (t) => new RegExp(`(^|[^A-Z0-9])${t.replace(/[^A-Z0-9-]/g, "")}(?![0-9])`);
    const byProject = new Map();
    for (const r of rows) {
      const label = `${r.key || ""} ${r.name || ""}`.toUpperCase();
      const t = found.find((x) => whole(x).test(label));
      if (t) byProject.set(r.id, { ticket: t, by: "project" });
    }
    if (byProject.size) return one(byProject);
    const byTask = new Map();
    for (const r of rows) {
      for (const t of found) {
        const task = sql(`SELECT id, title, ref, external_key FROM tasks WHERE project_id = :p1 AND status != 'done'
                            AND (UPPER(COALESCE(ref, '')) = :p2 OR UPPER(COALESCE(external_key, '')) = :p3 OR UPPER(title) LIKE :p4)
                          ORDER BY id DESC LIMIT 200`, [r.id, t, `JIRA:${t}`, `%${t}%`])
          .find((x) => String(x.ref || "").toUpperCase() === t || String(x.external_key || "").toUpperCase() === `JIRA:${t}` || whole(t).test(String(x.title || "").toUpperCase()));
        if (task) { byTask.set(r.id, { ticket: t, by: "task", task_id: Number(task.id) }); break; }
      }
    }
    return one(byTask);
  }
  const byKey = new Map();
  if (strength === "generic") {
    for (const r of rows) if (r.key && !distinctive(r.key) && keyIn(r.key, text)) byKey.set(r.id, { key: r.key, by: "key" });
    return one(byKey);
  }
  const others = strength === "key" ? firstWordsTaken(sql) : null;
  for (const r of rows) {
    const term = namesFor(r, others).find((t) => keyIn(t.text, text));
    if (term) byKey.set(r.id, { key: term.text, by: term.by });
  }
  return one(byKey);
}

/** Aliases as written in Settings: comma-separated, each a run of whole words. */
const aliasesOf = (raw) => String(raw || "").split(",").map((a) => a.trim()).filter((a) => words(a).length);

/**
 * How many active projects each word starts a key or a name of, so a first
 * word two projects share (caseflow-x and caseflow-y) names neither.
 */
function firstWordsTaken(sql) {
  const count = new Map();
  for (const p of sql("SELECT key, name FROM projects WHERE status != 'archived'", [])) {
    const own = new Set([...words(p.key), ...words(p.name)]);
    for (const w of own) count.set(w, (count.get(w) || 0) + 1);
  }
  return count;
}

/**
 * What names a project at the "key" strength: its whole key when that is
 * distinctive; the first word of a hyphenated key (ssnr from ssnr-mpi) when
 * it is four letters or more, not a common word, and no other active
 * project's key or name has it; and every alias a person gave it.
 */
function namesFor(r, taken) {
  const out = [];
  if (r.key && distinctive(r.key)) out.push({ text: r.key, by: "key" });
  const k = words(r.key);
  if (k.length > 1 && k[0].length >= 4 && /[a-z]/.test(k[0]) && !GENERIC.has(k[0]) && taken && (taken.get(k[0]) || 0) <= 1) {
    out.push({ text: k[0], by: "key word" });
  }
  for (const a of aliasesOf(r.aliases)) out.push({ text: a, by: "alias" });
  return out;
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
             WHERE settled_at IS NOT NULL AND settled_at >= datetime('now', '-30 days') AND project_id IN (${inList}) AND (folder = :p1 OR folder LIKE :p2 ESCAPE '\\') GROUP BY project_id`, under),
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
 * branch and subject may be left out and a git() handed in instead, which is
 * asked only when the answer needs them: the launch, a Workbench folder and a
 * folder one project has decide without git.
 *
 * Returns null when nothing names a project (a folder no project has), else
 * { projectId, via, guessed, folder, detail, candidates }.
 */
function resolve(sql, facts = {}) {
  const { cwd = null } = facts;
  let seen = null;
  const gitFacts = () => {
    if (!seen) seen = ("branch" in facts || "subject" in facts || !facts.git)
      ? { branch: facts.branch || null, subject: facts.subject || null }
      : (facts.git() || { branch: null, subject: null });
    return seen;
  };
  const sure = (r) => ({ ...r, guessed: false, folder: null, candidates: [r.projectId] });
  const a = launched(sql, facts);
  if (a) return sure(a);
  const b = cwd ? workbenchAt(sql, cwd) : null;
  if (b) return sure(b);
  const holding = cwd ? foldersHolding(sql, cwd) : [];
  if (!holding.length) return null;
  const { folder, projects } = holding[0];
  const candidates = projects.map((p) => p.id);
  const answer = (projectId, via, guessed, detail = {}) => ({ projectId: Number(projectId), via, guessed, folder, detail, candidates });
  if (projects.length === 1) return answer(projects[0].id, "folder", false);
  const { branch, subject } = gitFacts();
  const bb = workbenchBranch(sql, cwd, branch);
  if (bb && candidates.includes(bb.projectId)) return sure(bb);
  for (const strength of ["ticket", "key"]) {
    const fromBranch = named(sql, projects, branch, strength);
    if (fromBranch) return answer(fromBranch.projectId, "branch", true, { branch, ...fromBranch.why });
    const fromCommit = named(sql, projects, subject, strength);
    if (fromCommit) return answer(fromCommit.projectId, "commit", true, { subject, ...fromCommit.why });
  }
  const last = recent(sql, projects, folder);
  if (last) return answer(last.projectId, "recent", true, last.why);
  const fromBranch = named(sql, projects, branch, "generic");
  if (fromBranch) return answer(fromBranch.projectId, "branch", true, { branch, ...fromBranch.why });
  const fromCommit = named(sql, projects, subject, "generic");
  if (fromCommit) return answer(fromCommit.projectId, "commit", true, { subject, ...fromCommit.why });
  const homes = projects.filter((p) => p.home);
  return answer((homes[0] || projects[0]).id, "home", true);
}

/**
 * The project a folder no project has yet probably is, for discovery's "Add
 * to project": a ticket or distinctive key in the branch the session was on,
 * then in the latest commit's subject, then the folder's own name naming a
 * project's key. Among every active project. Null when nothing points at
 * one: a suggestion is only worth making when there is a reason to give.
 */
function suggest(sql, { folder = null, branch = null, subject = null } = {}) {
  const all = sql("SELECT id FROM projects WHERE status != 'archived' ORDER BY sort_order, id", []).map((p) => ({ id: Number(p.id) }));
  for (const strength of ["ticket", "key"]) {
    const fromBranch = named(sql, all, branch, strength);
    if (fromBranch) return { projectId: fromBranch.projectId, via: "branch", why: WHY.branch, detail: fromBranch.why };
    const fromCommit = named(sql, all, subject, strength);
    if (fromCommit) return { projectId: fromCommit.projectId, via: "commit", why: WHY.commit, detail: fromCommit.why };
  }
  const base = folder ? path.basename(String(folder)) : "";
  const byName = base ? named(sql, all, base, "key") : null;
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

module.exports = { resolve, ranked, suggest, tickets, keyIn, distinctive, aliasesOf, foldersHolding, chipWords, recordStatement, readGit, WHY };
