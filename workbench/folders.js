/**
 * A project's folders: the one rule for where its work is, and the migration
 * that brought every database to it.
 *
 * There used to be three records of a folder (projects.path, the workspaces
 * join, and repos) and five places that read them, each in its own order. A
 * job, a `$ ` run, a Workbench Start, an agent's sheet_resolve and a chat
 * session could each pick a different folder for the same project. Now every
 * one of those callers asks folderFor() or projectFolders() here.
 *
 * A folder and a project are many to many. One repository holds several
 * pieces of work (caseflow is SSNR's and Central Office's), and one piece of
 * work spans several repositories. Each project marks one folder as its Home:
 * projects.path, with the primary repos row at the same path for its
 * Workbench settings. Its other folders are non-primary repos rows. Slice 4
 * made a folder one project's and moved the others out; the owner reversed
 * that, and rejoin() below puts back what it moved.
 *
 * Shared by the app and the MCP server in the mould of workbench/store.js: SQL
 * text and rules, handed a sql(query, params) function in the :p1 style and a
 * batch(statements) that runs a list as one unit. One implementation, two
 * routes. Nothing here runs git, and the only thing it asks of the disk is
 * whether a folder is there and what its real path is.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * The one spelling of a folder: absolute, symlinks resolved, no trailing
 * slash. Every write of projects.path goes through this, because folders are
 * compared as text, and /Users/x/va/caseflow/ and a symlink to it are the
 * same folder written two ways. A folder that is not there (moved, or on a
 * drive that is not mounted) keeps its resolved spelling, so it can still be
 * found and fixed.
 */
function normalise(raw) {
  if (raw === null || raw === undefined) return null;
  let p = String(raw).trim();
  if (!p) return null;
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  p = path.resolve(p);
  try { p = fs.realpathSync.native(p); } catch {}
  const root = path.parse(p).root;
  while (p.length > root.length && /[\\/]$/.test(p)) p = p.slice(0, -1);
  return p;
}

/** Two stored folders are one when their spellings are, slash for slash. */
const same = (a, b) => Boolean(a) && Boolean(b) && String(a).replace(/[\\/]+$/, "") === String(b).replace(/[\\/]+$/, "");
/** The same, after normalising both, for a row written before normalise() existed. */
const alike = (a, b) => same(a, b) || (Boolean(a) && Boolean(b) && same(normalise(a), normalise(b)));

const isDir = (p) => { try { return Boolean(p) && fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * Every folder a project's work is in, Home first.
 *
 * Home (projects.path) first, carrying the repos row at that path when there
 * is one, because that row holds its Workbench settings. Then its linked
 * folders: non-primary repos rows elsewhere.
 *
 * A primary repos row counts only through Home. It is meant to sit at the same
 * path, and when it does not (a Home changed, then the change undone in
 * History) it is a stale copy, not a second answer. That is what makes "No
 * folder" true: a project with no Home has nothing here unless a person linked
 * a folder to it on purpose.
 *
 * Whether each is a git repository is not known here; workbench.js asks git.
 */
function projectFolders(sql, projectId) {
  if (projectId === null || projectId === undefined) return [];
  const pid = Number(projectId);
  const project = sql("SELECT id, name, path FROM projects WHERE id = :p1", [pid])[0];
  if (!project) return [];
  const repos = sql("SELECT id, name, path, is_primary, remote_url, default_branch FROM repos WHERE project_id = :p1 ORDER BY is_primary DESC, id", [pid]);
  const out = [];
  if (project.path) {
    const at = repos.find((r) => same(r.path, project.path));
    out.push({ repo_id: at ? num(at.id) : null, name: at ? at.name : path.basename(project.path) || project.name, path: project.path, source: "project", is_primary: 1,
      remote_url: at ? at.remote_url ?? null : null, default_branch: at ? at.default_branch ?? null : null });
  }
  for (const r of repos) {
    if (Number(r.is_primary) || same(r.path, project.path)) continue;
    if (out.some((f) => same(f.path, r.path))) continue;
    out.push({ repo_id: num(r.id), name: r.name, path: r.path, source: "repo", is_primary: 0, remote_url: r.remote_url ?? null, default_branch: r.default_branch ?? null });
  }
  return out;
}

/**
 * The one folder something should run in, and where that answer came from.
 *
 *   taskId      a task's command, job or Workbench: its live Workbench first,
 *               because running a command anywhere else is how one task's build
 *               ends up in another's folder; then the folder the task names
 *               (tasks.repo_id), when it is one of its project's; then its
 *               project's folders, Home first.
 *   sessionCwd  a chat session: the folder it was started in wins, as it always
 *               has, so a conversation keeps its place; then the project's.
 *   projectId   otherwise, the project's folders.
 *
 * live(taskId) is workbench/store.js's live(), passed in so this file needs no
 * store. Folders that are not on disk are skipped; `missing` names Home when
 * that is why nothing was found, so a caller can say "is not there any more"
 * rather than "has no folder".
 */
function folderFor(sql, { taskId = null, projectId = null, sessionCwd = null, live = null, exists = isDir } = {}) {
  if (sessionCwd) return { path: sessionCwd, source: "session", missing: null };
  let pid = projectId;
  let own = null;
  if (taskId !== null && taskId !== undefined) {
    const bench = live ? live(Number(taskId)) : null;
    if (bench && bench.state !== "missing" && exists(bench.path)) return { path: bench.path, source: "workbench", missing: null };
    const task = sql("SELECT project_id, repo_id FROM tasks WHERE id = :p1", [Number(taskId)])[0] || null;
    if (pid === null || pid === undefined) pid = task ? task.project_id : null;
    own = task && task.repo_id != null ? Number(task.repo_id) : null;
  }
  const list = projectFolders(sql, pid);
  const mine = own === null ? null : list.find((f) => f.repo_id === own);
  if (mine && exists(mine.path)) return { path: mine.path, source: "task", missing: null };
  for (const f of list) if (exists(f.path)) return { path: f.path, source: f.source, missing: null };
  const home = list.find((f) => f.source === "project");
  return { path: null, source: null, missing: home ? home.path : null };
}

/**
 * Every project that has this folder, as its Home or as a linked folder,
 * archived ones included, oldest first. A folder may be several projects'
 * (one repository, several pieces of work in it), so this is a list and
 * never a refusal.
 */
function holders(sql, folder) {
  const want = normalise(folder);
  if (!want) return [];
  const out = new Map();
  for (const r of sql("SELECT id, key, name, path, status FROM projects WHERE path IS NOT NULL AND path != ''", [])) {
    if (alike(r.path, want)) out.set(Number(r.id), { id: Number(r.id), key: r.key, name: r.name, status: r.status, home: true });
  }
  // Only non-primary rows: a primary row away from Home is a stale copy.
  for (const r of sql(`SELECT p.id, p.key, p.name, p.status, r.path FROM repos r JOIN projects p ON p.id = r.project_id
                        WHERE r.is_primary = 0`, [])) {
    if (!out.has(Number(r.id)) && alike(r.path, want)) out.set(Number(r.id), { id: Number(r.id), key: r.key, name: r.name, status: r.status, home: false });
  }
  return [...out.values()].sort((a, b) => a.id - b.id);
}

/**
 * The statements that make a project's primary repos row sit at its Home.
 *
 * A row already at that path becomes the primary one. Otherwise the old
 * primary row is demoted, where it stands, and a new row is made for the
 * folder. A repos row is never moved to another path: its base branch, setup
 * command and files to copy were set for its own folder (a project whose
 * primary row was caseflow-efolder must not carry efolder's setup into
 * bip-appeals-config), and a Workbench may hang off it. Demoted, it is one of
 * the project's linked folders, which a person can remove.
 *
 * `settings` fills a new row's Workbench settings, for a folder coming back
 * with the settings it left with (rejoin()).
 */
function primaryRepoStatements(sql, projectId, folder, { name = null, remote = undefined, branch = undefined, settings = null } = {}) {
  const pid = Number(projectId);
  const statements = [];
  if (!folder) return statements;
  const repos = sql("SELECT r.id, r.path, r.is_primary FROM repos r WHERE r.project_id = :p1 ORDER BY r.is_primary DESC, r.id", [pid]);
  // What git said, written only when the caller asked git: undefined leaves
  // a row's earlier answer alone.
  const setDetected = (id) => {
    if (remote !== undefined) statements.push(["UPDATE repos SET remote_url = :p1 WHERE id = :p2", [remote, id]]);
    if (branch !== undefined) statements.push(["UPDATE repos SET default_branch = :p1 WHERE id = :p2", [branch, id]]);
  };
  const at = repos.find((r) => same(r.path, folder)) || repos.find((r) => same(normalise(r.path), folder));
  if (at) {
    if (!Number(at.is_primary)) {
      statements.push(["UPDATE repos SET is_primary = CASE WHEN id = :p1 THEN 1 ELSE 0 END WHERE project_id = :p2", [num(at.id), pid]]);
    }
    if (!same(at.path, folder)) statements.push(["UPDATE repos SET path = :p1 WHERE id = :p2", [folder, num(at.id)]]);
    setDetected(num(at.id));
    return statements;
  }
  const s = settings || {};
  statements.push(["UPDATE repos SET is_primary = 0 WHERE project_id = :p1", [pid]]);
  statements.push([`INSERT INTO repos (project_id, name, path, is_primary, remote_url, default_branch, base_branch, setup_cmd, copy_files)
                    VALUES (:p1, :p2, :p3, 1, :p4, :p5, :p6, :p7, :p8)`,
    [pid, name || s.name || path.basename(folder), folder, remote === undefined ? null : remote, branch === undefined ? null : branch,
     s.base_branch ?? null, s.setup_cmd ?? null, s.copy_files ?? null]]);
  return statements;
}

/**
 * A linked folder for a project, as statements: a non-primary repos row at
 * the folder, unless the project has the folder already (as Home or linked).
 * Making a folder Home is db.js updateProject's, because Home is a project
 * field History records.
 */
function linkStatements(sql, projectId, folder, { name = null, remote = undefined, branch = undefined } = {}) {
  const pid = Number(projectId);
  const want = normalise(folder);
  if (!want) return [];
  if (projectFolders(sql, pid).some((f) => alike(f.path, want))) return [];
  // A stale primary row at the folder (a Home changed away) is the row to
  // use: its settings were made for this folder.
  const stale = sql("SELECT id, path FROM repos WHERE project_id = :p1", [pid]).find((r) => alike(r.path, want));
  if (stale) return [["UPDATE repos SET is_primary = 0 WHERE id = :p1", [num(stale.id)]]];
  return [["INSERT INTO repos (project_id, name, path, is_primary, remote_url, default_branch) VALUES (:p1, :p2, :p3, 0, :p4, :p5)",
    [pid, name || path.basename(want), want, remote === undefined ? null : remote, branch === undefined ? null : branch]]];
}

/**
 * What a project giving up a linked folder leaves behind, as statements.
 *
 * Its repos rows at that folder go, so no resolver finds the folder through
 * them, unless a Workbench hangs off one: deleting the row would cascade to
 * the Workbench rows, which are never deleted. Those stay as they are, and
 * keep the Workbench working. A task that named the folder (tasks.repo_id)
 * goes back to Home, by the foreign key.
 *
 * Returns { statements, kept, held } with every row removed, settings and
 * all, so the caller can write them down rather than lose them, and the rows
 * a Workbench held.
 */
function releaseStatements(sql, projectId, folder) {
  const pid = Number(projectId);
  const statements = [];
  const kept = [];
  const held = [];
  const repos = sql(`SELECT r.*, (SELECT COUNT(*) FROM workbenches w WHERE w.repo_id = r.id) AS benches
                       FROM repos r WHERE r.project_id = :p1`, [pid]);
  for (const r of repos) {
    if (!alike(r.path, folder)) continue;
    if (Number(r.benches)) { held.push(num(r.id)); continue; }
    const { benches, ...row } = r;
    kept.push({ ...row, id: num(r.id) });
    statements.push(["UPDATE tasks SET repo_id = NULL WHERE repo_id = :p1", [num(r.id)]]);
    statements.push(["DELETE FROM repos WHERE id = :p1", [num(r.id)]]);
  }
  return { statements, kept, held };
}

// ---------------------------------------------------------------------------
// The migration

const ADOPTED = "folders_adopted";
// Slice 4's unique index on projects(path), which said a folder is one
// project's. Dropped wherever it was made; agent/schema_later.js drops it too,
// so the server never meets it on a database the app has not opened since.
const RETIRED_INDEX = "idx_projects_path";

const hasTable = (sql, name) => sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name = :p1", [name]).length > 0;

/** Paths more than one project has as Home, as normalised text. Allowed now; said in the log. */
function sharedFolders(sql) {
  const rows = sql("SELECT id, path FROM projects WHERE path IS NOT NULL AND path != ''", []);
  const by = new Map();
  for (const r of rows) {
    const key = normalise(r.path);
    by.set(key, [...(by.get(key) || []), Number(r.id)]);
  }
  return [...by].filter(([, ids]) => ids.length > 1).map(([folder, ids]) => ({ folder, ids }));
}

/** Slice 4's shared-folder rows rejoin() has not yet answered. */
const SPLIT_OPEN = "via = 'conflict' AND state IN ('new', 'kept', 'given')";
function splitsOpen(sql) {
  if (!hasTable(sql, "discovered_folders")) return [];
  return sql(`SELECT * FROM discovered_folders WHERE ${SPLIT_OPEN} ORDER BY id`, []);
}

/**
 * Whether opening this database will migrate it, asked before it is opened so
 * the app can take a snapshot first. True until the adoption has run, and
 * while a folder slice 4 split is still to be put back.
 */
function needsAdoption(sql) {
  let done = null;
  // A file too old to have meta has not been migrated either: asked as "yes",
  // so the snapshot is taken rather than skipped.
  try { done = sql("SELECT value FROM meta WHERE key = :p1", [ADOPTED])[0]; } catch { done = null; }
  if (!done) {
    // A database with no projects has nothing to move.
    try { return Number(sql("SELECT COUNT(*) AS n FROM projects", [])[0].n) > 0; } catch { return false; }
  }
  try { return splitsOpen(sql).length > 0; } catch { return false; }
}

/**
 * Brings every project's folders into projects.path and repos, once. Safe to
 * run on every open.
 *
 * Additive: no project, task, note, pad, session or link is deleted. In order:
 *
 *   1. A project with no folder but one workspace (or a primary one) takes
 *      that workspace's folder as Home; failing that, its primary repos row's.
 *   2. Every folder is normalised. Two projects may share one.
 *   3. Each project with a Home has its primary repos row there.
 *   4. Its other workspace folders become linked folders (non-primary repos
 *      rows), so nothing a workspace said is lost.
 *   5. A workspace no project is linked to becomes a discovered_folders row,
 *      via 'migration', rather than a project nobody asked for.
 *   6. A workspace's icon and colour go to the project only where it has none.
 *   7. A session that recorded only a workspace gets that workspace's folder as
 *      its cwd, because workspaces are not read after this.
 *   8. meta.folders_adopted.
 *
 * Then, every time, rejoin(): what slice 4's split moved out of a shared
 * folder is put back. And the unique index slice 4 made is dropped.
 *
 * The app takes a snapshot first and writes a restore point (main/backups.js);
 * this does not, because it runs under either route and a snapshot is the
 * app's job. Returns what it did, for the restore point and the log.
 */
function adoptFolders({ sql, batch, now = () => new Date() }) {
  const index = dropIndex(sql);
  const adopted = sql("SELECT value FROM meta WHERE key = :p1", [ADOPTED])[0];
  const auditId = Number((sql("SELECT COALESCE(MAX(id), 0) AS n FROM audit", [])[0] || {}).n || 0);
  if (adopted) {
    const rejoined = rejoin({ sql, batch, now });
    return { ran: rejoined.length > 0, auditId, rejoined, index };
  }

  const statements = [];
  const projects = sql("SELECT id, key, name, path, icon, colour, created_at FROM projects ORDER BY id", []);
  const spaces = hasTable(sql, "workspaces") ? sql("SELECT id, name, path, icon, colour FROM workspaces", []) : [];
  const links = hasTable(sql, "project_workspaces") ? sql("SELECT project_id, workspace_id, is_primary FROM project_workspaces", []) : [];
  const spaceById = new Map(spaces.map((w) => [Number(w.id), w]));
  const linksOf = (pid) => links.filter((l) => Number(l.project_id) === Number(pid)).map((l) => ({ ...l, space: spaceById.get(Number(l.workspace_id)) })).filter((l) => l.space);

  // 1 and 2: every project's Home, as it will be written.
  const folderOf = new Map();
  for (const p of projects) {
    let folder = p.path ? normalise(p.path) : null;
    if (!folder) {
      const mine = linksOf(p.id);
      const chosen = mine.find((l) => Number(l.is_primary)) || (mine.length === 1 ? mine[0] : null);
      if (chosen) folder = normalise(chosen.space.path);
    }
    if (!folder) {
      const primary = sql("SELECT path FROM repos WHERE project_id = :p1 AND is_primary = 1 ORDER BY id LIMIT 1", [Number(p.id)])[0];
      if (primary && primary.path) folder = normalise(primary.path);
    }
    folderOf.set(Number(p.id), folder);
    if (folder !== p.path) statements.push(["UPDATE projects SET path = :p1 WHERE id = :p2", [folder, Number(p.id)]]);
  }

  // 3 and 4: repos rows for the folders each project has.
  for (const p of projects) {
    const f = folderOf.get(Number(p.id));
    if (f) statements.push(...primaryRepoStatements(sql, p.id, f, { name: path.basename(f) }));
    const have = sql("SELECT path FROM repos WHERE project_id = :p1", [Number(p.id)]).map((r) => normalise(r.path));
    for (const l of linksOf(p.id)) {
      const wf = normalise(l.space.path);
      if (!wf || same(wf, f) || have.includes(wf)) continue;
      have.push(wf);
      statements.push(["INSERT INTO repos (project_id, name, path, is_primary) VALUES (:p1, :p2, :p3, 0)", [Number(p.id), l.space.name || path.basename(wf), wf]]);
    }
    // 6. Only where the project has none of its own.
    const home = linksOf(p.id).find((l) => Number(l.is_primary)) || null;
    if (home && home.space.icon && !p.icon) statements.push(["UPDATE projects SET icon = :p1 WHERE id = :p2 AND icon IS NULL", [home.space.icon, Number(p.id)]]);
    if (home && home.space.colour && !p.colour) statements.push(["UPDATE projects SET colour = :p1 WHERE id = :p2 AND colour IS NULL", [home.space.colour, Number(p.id)]]);
  }

  // 5. A folder nobody had made a project of is asked about, never made one.
  const linked = new Set(links.map((l) => Number(l.workspace_id)));
  const homes = [...folderOf.values()].filter(Boolean);
  for (const w of spaces) {
    const wf = normalise(w.path);
    if (linked.has(Number(w.id)) || !wf || homes.some((h) => same(h, wf))) continue;
    statements.push([`INSERT INTO discovered_folders (path, seen_by, via, state) VALUES (:p1, 'migration', 'migration', 'new')
                      ON CONFLICT(path) DO NOTHING`, [wf]]);
  }

  // 7. Sessions keep the folder their workspace gave them.
  if (spaces.length) {
    statements.push([`UPDATE sessions SET cwd = (SELECT w.path FROM workspaces w WHERE w.id = sessions.workspace_id)
                       WHERE (cwd IS NULL OR cwd = '') AND workspace_id IS NOT NULL
                         AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = sessions.workspace_id)`, []]);
  }

  // 8.
  statements.push(["INSERT INTO meta (key, value) VALUES (:p1, :p2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [ADOPTED, now().toISOString()]]);
  batch(statements);
  const rejoined = rejoin({ sql, batch, now });
  return { ran: true, auditId, rejoined, shared: sharedFolders(sql), index };
}

/** Slice 4's unique index, gone. Its own step, so a failure costs only this. */
function dropIndex(sql) {
  try {
    if (!sql("SELECT name FROM sqlite_master WHERE type = 'index' AND name = :p1", [RETIRED_INDEX]).length) return { ok: true };
    sql(`DROP INDEX IF EXISTS ${RETIRED_INDEX}`, []);
    return { ok: true, dropped: true };
  } catch (error) {
    return { ok: false, why: String(error.message || error) };
  }
}

const parseDetail = (text) => { try { const d = JSON.parse(text || "null"); return d && typeof d === "object" ? d : {}; } catch { return {}; } };
const tildeOf = (p) => {
  const home = os.homedir();
  return p && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p;
};

/**
 * Puts back what slice 4's split took out of a shared folder.
 *
 * Slice 4 kept each shared folder for the project holding most and moved the
 * others to No folder: Home cleared, their repos rows at the folder deleted
 * (their settings written into the row's detail.repos) and their workspace
 * links removed. Each such discovered_folders row (via 'conflict') is answered
 * here, once, for every project it names: the projects it moved, and for a
 * "Give the folder to" answer the one that gave it up.
 *
 * A project gets the folder back as Home when it has no Home now, and as a
 * linked folder when it has another Home, with the repos row's settings as
 * they were. It is left alone, and the row says so, when:
 *   - it has the folder already;
 *   - it is archived or gone (a merge archived it, or a person did);
 *   - a person changed its folders since the split: a project History row
 *     changing its path after the row was written, other than the answer to
 *     the question itself, which was made under the old rule.
 *
 * Every Home put back is a project update in History, attributed to Delphi,
 * so a person can undo any of them one at a time. The row is marked
 * 'rejoined' in the same batch, with what was done and what was left, so it
 * never runs twice and Today never asks about it again. A row answered
 * 'merged' is left as it is: the merge moved the work on purpose.
 */
function rejoin({ sql, batch, now = () => new Date() }) {
  const rows = splitsOpen(sql);
  if (!rows.length) return [];
  const reports = [];
  const projectsTable = hasTable(sql, "project_workspaces") && hasTable(sql, "workspaces");
  for (const row of rows) {
    const folder = normalise(row.path);
    const detail = parseDetail(row.detail);
    const since = detail.at || row.first_seen || "1970-01-01";
    const answered = new Set((Array.isArray(detail.answer_audit) ? detail.answer_audit : []).map(Number));
    const step = `rejoin-${num(row.id)}-${now().getTime()}`;
    const ids = [...(detail.moved || []).map((m) => Number(m.id))];
    // "Give the folder to" took it from the project that kept it, under the
    // rule that only one could have it. It comes back too.
    if (row.state === "given" && detail.kept && detail.kept.id != null) ids.push(Number(detail.kept.id));
    // First in the batch: the row must still be open. Another process that
    // answered it since makes json() fail, which ends the batch before anything
    // is written, on either route.
    const statements = [[`SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM discovered_folders WHERE id = :p1 AND ${SPLIT_OPEN})
                            THEN json('delphi: answered already') END`, [num(row.id)]]];
    const restored = [];
    const left = [];
    for (const pid of [...new Set(ids)].filter(Number.isFinite)) {
      const p = sql("SELECT * FROM projects WHERE id = :p1", [pid])[0];
      const name = p ? p.name : (detail.moved || []).find((m) => Number(m.id) === pid)?.name || `project ${pid}`;
      if (!p) { left.push({ id: pid, name, why: "is not there any more" }); continue; }
      if (p.status === "archived") { left.push({ id: pid, name, why: "is archived" }); continue; }
      if (projectFolders(sql, pid).some((f) => alike(f.path, folder))) { left.push({ id: pid, name, why: "has the folder already" }); continue; }
      const changes = sql(`SELECT id, actor FROM audit WHERE entity = 'project' AND entity_id = :p1 AND action = 'update' AND undone = 0
                             AND at >= datetime(:p2)
                             AND COALESCE(json_extract(CASE WHEN json_valid(before_json) THEN before_json END, '$.path'), '')
                              != COALESCE(json_extract(CASE WHEN json_valid(after_json) THEN after_json END, '$.path'), '')
                           ORDER BY id`, [pid, since]).filter((a) => !answered.has(Number(a.id)));
      if (changes.length) {
        left.push({ id: pid, name, why: `had its folders changed by hand since (History ${changes.map((c) => `#${c.id}`).join(", ")})`, audit: changes.map((c) => Number(c.id)) });
        continue;
      }
      // Its own settings for the folder, as slice 4 wrote them down.
      const settings = (detail.repos || []).find((r) => Number(r.project_id) === pid && alike(r.path, folder)) || null;
      if (!p.path) {
        const after = { ...p, path: folder };
        statements.push(["UPDATE projects SET path = :p1, updated_at = datetime('now') WHERE id = :p2", [folder, pid]]);
        statements.push(...primaryRepoStatements(sql, pid, folder, { settings }));
        statements.push([`INSERT INTO audit (action, entity, entity_id, summary, label, before_json, after_json, actor, actor_type, step)
                          VALUES ('update', 'project', :p1, :p2, :p3, :p4, :p5, 'delphi', 'tool', :p6)`,
          [pid, `has ${tildeOf(folder)} back as its Home, which it shared before`, p.name, JSON.stringify(p), JSON.stringify(after), step]]);
        restored.push({ id: pid, name, as: "home" });
      } else {
        // Its Home is elsewhere now, and nobody changed it by hand, so the
        // folder comes back beside it. Not History: repos rows are not
        // recorded there, and the row below says it was done.
        statements.push(...linkStatements(sql, pid, folder, { name: settings ? settings.name : null }));
        if (settings) {
          statements.push([`UPDATE repos SET base_branch = COALESCE(base_branch, :p1), setup_cmd = COALESCE(setup_cmd, :p2), copy_files = COALESCE(copy_files, :p3)
                             WHERE project_id = :p4 AND path = :p5 AND is_primary = 0`, [settings.base_branch ?? null, settings.setup_cmd ?? null, settings.copy_files ?? null, pid, folder]]);
        }
        restored.push({ id: pid, name, as: "linked" });
      }
      if (projectsTable) {
        statements.push([`INSERT OR IGNORE INTO project_workspaces (project_id, workspace_id, is_primary)
                          SELECT :p1, w.id, 0 FROM workspaces w WHERE w.path = :p2 OR w.path = :p3`, [pid, folder, `${folder}/`]]);
      }
    }
    const said = [
      ...restored.map((r) => `${r.name} has it back${r.as === "linked" ? " as a linked folder" : ""}.`),
      ...left.map((l) => `${l.name} ${l.why}, so it was left as it is.`),
    ].join(" ");
    const rejoined = { at: now().toISOString(), step, restored, left, said, was: row.state };
    statements.push([`UPDATE discovered_folders SET state = 'rejoined', answered_at = datetime('now'),
                        detail = json_set(CASE WHEN json_valid(detail) THEN detail ELSE '{}' END, '$.rejoined', json(:p1))
                      WHERE id = :p2 AND ${SPLIT_OPEN}`, [JSON.stringify(rejoined), num(row.id)]]);
    try { batch(statements); } catch (error) {
      if (!splitsOpen(sql).some((r) => num(r.id) === num(row.id))) continue;
      throw error;
    }
    reports.push({ id: num(row.id), folder, ...rejoined });
  }
  return reports;
}

module.exports = {
  normalise, same, alike, isDir, projectFolders, folderFor, holders,
  primaryRepoStatements, linkStatements, releaseStatements,
  adoptFolders, needsAdoption, rejoin, dropIndex, sharedFolders, splitsOpen, ADOPTED, RETIRED_INDEX,
};
