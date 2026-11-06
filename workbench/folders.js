/**
 * A project's folder: the one rule for where its work is, and the migration
 * that made every folder one project's.
 *
 * There used to be three records of a folder (projects.path, the workspaces
 * join, and repos) and five places that read them, each in its own order. A
 * job, a `$ ` run, a Workbench Start, an agent's sheet_resolve and a chat
 * session could each pick a different folder for the same project. Now
 * projects.path is the project's folder, one project per folder, and every one
 * of those callers asks folderFor() or projectFolders() here.
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
 * slash. Every write of projects.path goes through this, because the unique
 * index compares text, and /Users/x/va/caseflow/ and a symlink to it are the
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

const isDir = (p) => { try { return Boolean(p) && fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * Every folder a project's work is in, best first.
 *
 * The project's own folder (projects.path) first, carrying the repos row at
 * that path when there is one, because that row holds its Workbench settings.
 * Then the folders it also works in: non-primary repos rows elsewhere.
 *
 * A primary repos row counts only through the project's folder. It is meant
 * to sit at the same path, and when it does not (a folder changed, then the
 * change undone in History; a project that gave its folder away) it is a stale
 * copy, not a second answer. That is what makes "No folder" true: a project in
 * No folder has no home here, so nothing resolves for it unless a person added
 * another folder to it on purpose.
 *
 * Whether each is a git repository is not known here; workbench.js asks git.
 */
function projectFolders(sql, projectId) {
  if (projectId === null || projectId === undefined) return [];
  const pid = Number(projectId);
  const project = sql("SELECT id, name, path FROM projects WHERE id = :p1", [pid])[0];
  if (!project) return [];
  const repos = sql("SELECT id, name, path, is_primary FROM repos WHERE project_id = :p1 ORDER BY is_primary DESC, id", [pid]);
  const out = [];
  if (project.path) {
    const at = repos.find((r) => same(r.path, project.path));
    out.push({ repo_id: at ? num(at.id) : null, name: at ? at.name : project.name, path: project.path, source: "project", is_primary: 1 });
  }
  for (const r of repos) {
    if (Number(r.is_primary) || same(r.path, project.path)) continue;
    if (out.some((f) => same(f.path, r.path))) continue;
    out.push({ repo_id: num(r.id), name: r.name, path: r.path, source: "repo", is_primary: 0 });
  }
  return out;
}

/**
 * The one folder something should run in, and where that answer came from.
 *
 *   taskId      a task's command, job or Workbench: its live Workbench first,
 *               because running a command anywhere else is how one task's build
 *               ends up in another's folder; then its project's folders.
 *   sessionCwd  a chat session: the folder it was started in wins, as it always
 *               has, so a conversation keeps its place; then the project's.
 *   projectId   otherwise, the project's folders.
 *
 * live(taskId) is workbench/store.js's live(), passed in so this file needs no
 * store. Folders that are not on disk are skipped; `missing` names the
 * project's own folder when that is why nothing was found, so a caller can say
 * "is not there any more" rather than "has no folder".
 */
function folderFor(sql, { taskId = null, projectId = null, sessionCwd = null, live = null, exists = isDir } = {}) {
  if (sessionCwd) return { path: sessionCwd, source: "session", missing: null };
  let pid = projectId;
  if (taskId !== null && taskId !== undefined) {
    const bench = live ? live(Number(taskId)) : null;
    if (bench && bench.state !== "missing" && exists(bench.path)) return { path: bench.path, source: "workbench", missing: null };
    if (pid === null || pid === undefined) {
      const task = sql("SELECT project_id FROM tasks WHERE id = :p1", [Number(taskId)])[0];
      pid = task ? task.project_id : null;
    }
  }
  const list = projectFolders(sql, pid);
  for (const f of list) if (exists(f.path)) return { path: f.path, source: f.source, missing: null };
  const home = list.find((f) => f.source === "project");
  return { path: null, source: null, missing: home ? home.path : null };
}

/** The project that already has this folder, archived ones included, or null. */
function ownerOf(sql, folder, { except = null } = {}) {
  const want = normalise(folder);
  if (!want) return null;
  // Compared after normalising both sides, because a row written before this
  // file existed may carry a trailing slash or an unresolved link.
  const rows = sql("SELECT id, key, name, path, status FROM projects WHERE path IS NOT NULL AND path != ''", []);
  return rows.find((r) => (except === null || Number(r.id) !== Number(except)) && (same(r.path, want) || same(normalise(r.path), want))) || null;
}

/** The sentence the unique index would otherwise say as "UNIQUE constraint failed". */
function takenSentence(owner) {
  const archived = owner.status === "archived" ? " (archived)" : "";
  return `That folder is already ${owner.name}'s project${archived}. A folder belongs to one project.`;
}

/**
 * The statements that make a project's primary repos row sit at its folder.
 *
 * A row already at that path becomes the primary one. Otherwise the old
 * primary row is demoted, where it stands, and a new row is made for the
 * folder. A repos row is never moved to another path: its base branch, setup
 * command and files to copy were set for its own folder (a project whose
 * primary row was caseflow-efolder must not carry efolder's setup into
 * bip-appeals-config), and a Workbench may hang off it. Demoted, it is one of
 * the folders the project also works in, which a person can remove.
 */
function primaryRepoStatements(sql, projectId, folder, { name = null, remote = undefined, branch = undefined } = {}) {
  const pid = Number(projectId);
  const statements = [];
  if (!folder) return statements;
  const repos = sql(`SELECT r.id, r.path, r.is_primary,
                            (SELECT COUNT(*) FROM workbenches w WHERE w.repo_id = r.id) AS benches
                       FROM repos r WHERE r.project_id = :p1 ORDER BY r.is_primary DESC, r.id`, [pid]);
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
  statements.push(["UPDATE repos SET is_primary = 0 WHERE project_id = :p1", [pid]]);
  statements.push([`INSERT INTO repos (project_id, name, path, is_primary, remote_url, default_branch) VALUES (:p1, :p2, :p3, 1, :p4, :p5)`,
    [pid, name || path.basename(folder), folder, remote === undefined ? null : remote, branch === undefined ? null : branch]]);
  return statements;
}

/**
 * What a project giving up a folder leaves behind, as statements.
 *
 * Its repos rows at that folder go, so no resolver finds the folder through
 * them, unless a Workbench hangs off one: deleting the row would cascade to
 * the Workbench rows, which are never deleted. Those stay as they are, and
 * since a project with no folder of its own reads no primary row, they keep
 * the Workbench working without making the folder the project's. Workspace
 * links to the folder go too, which only the migration still reads.
 *
 * Returns { statements, kept } with the settings of every row removed, so the
 * caller can write them down rather than lose them.
 */
function releaseStatements(sql, projectId, folder) {
  const pid = Number(projectId);
  const statements = [];
  const kept = [];
  const repos = sql(`SELECT r.*, (SELECT COUNT(*) FROM workbenches w WHERE w.repo_id = r.id) AS benches
                       FROM repos r WHERE r.project_id = :p1`, [pid]);
  for (const r of repos) {
    if (!same(r.path, folder) && !same(normalise(r.path), folder)) continue;
    if (Number(r.benches)) continue;
    kept.push({ name: r.name, path: r.path, base_branch: r.base_branch ?? null, setup_cmd: r.setup_cmd ?? null, copy_files: r.copy_files ?? null });
    statements.push(["DELETE FROM repos WHERE id = :p1", [num(r.id)]]);
  }
  return { statements, kept };
}

// ---------------------------------------------------------------------------
// The migration: one folder, one project

const ADOPTED = "folders_adopted";
const INDEX = "CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_path ON projects(path) WHERE path IS NOT NULL";

const hasTable = (sql, name) => sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name = :p1", [name]).length > 0;

/** Paths more than one project holds, as normalised text. */
function sharedFolders(sql) {
  const rows = sql("SELECT id, path FROM projects WHERE path IS NOT NULL AND path != ''", []);
  const by = new Map();
  for (const r of rows) {
    const key = normalise(r.path);
    by.set(key, [...(by.get(key) || []), Number(r.id)]);
  }
  return [...by].filter(([, ids]) => ids.length > 1).map(([folder, ids]) => ({ folder, ids }));
}

/**
 * Whether opening this database will migrate it, asked before it is opened so
 * the app can take a snapshot first. True until the migration has run, and
 * again if a folder is shared once more (an older version wrote one).
 */
function needsAdoption(sql) {
  let done = null;
  // A file too old to have meta has not been migrated either: asked as "yes",
  // so the snapshot is taken rather than skipped.
  try { done = sql("SELECT value FROM meta WHERE key = :p1", [ADOPTED])[0]; } catch { done = null; }
  if (!done) {
    // A database with no projects has nothing to move; it only needs the index.
    try { return Number(sql("SELECT COUNT(*) AS n FROM projects", [])[0].n) > 0; } catch { return false; }
  }
  return sharedFolders(sql).length > 0;
}

/**
 * What a project holds, scored for who keeps a shared folder: its tasks,
 * notes, pads and sessions, and its History rows in the last 90 days.
 */
function score(sql, projectId) {
  const pid = Number(projectId);
  const n = (q) => Number((sql(q, [pid])[0] || {}).n || 0);
  const tasks = n("SELECT COUNT(*) AS n FROM tasks WHERE project_id = :p1");
  const open = n("SELECT COUNT(*) AS n FROM tasks WHERE project_id = :p1 AND status != 'done'");
  const notes = n("SELECT COUNT(*) AS n FROM notes WHERE project_id = :p1");
  const pads = n("SELECT COUNT(*) AS n FROM scratchpads WHERE project_id = :p1");
  const sessions = n("SELECT COUNT(*) AS n FROM sessions WHERE project_id = :p1");
  const recent = n(`SELECT COUNT(*) AS n FROM audit a WHERE a.at >= datetime('now', '-90 days') AND (
      (a.entity = 'project' AND a.entity_id = :p1)
   OR (a.entity = 'task' AND a.entity_id IN (SELECT id FROM tasks WHERE project_id = :p1))
   OR (a.entity = 'note' AND a.entity_id IN (SELECT id FROM notes WHERE project_id = :p1))
   OR (a.entity = 'scratchpad' AND a.entity_id IN (SELECT id FROM scratchpads WHERE project_id = :p1))
   OR (a.entity = 'session' AND a.entity_id IN (SELECT id FROM sessions WHERE project_id = :p1)))`);
  return { tasks, open, notes, pads, sessions, recent, total: tasks + notes + pads + sessions + recent };
}

/**
 * Makes every folder one project's, once. Safe to run on every open.
 *
 * Additive: no project, task, note, pad, session or link is deleted, and every
 * move is written down. In order:
 *
 *   1. A project with no folder but one workspace (or a primary one) takes
 *      that workspace's folder; failing that, its primary repos row's.
 *   2. Every folder is normalised.
 *   3. Where projects share a folder, the one holding most (score()) keeps it,
 *      the older on a tie. The others go to No folder: path NULL, their link
 *      to that workspace removed and their repos rows there released
 *      (releaseStatements), so no resolver hands them the folder anyway. The
 *      folder is recorded in discovered_folders, via 'conflict', naming who
 *      kept it and who moved, which is the question Needs you asks.
 *   4. Each project with a folder has its primary repos row there.
 *   5. Its other workspace folders become non-primary repos rows, the "also
 *      works in" folders, so nothing a workspace said is lost.
 *   6. A workspace no project is linked to becomes a discovered_folders row,
 *      via 'migration', rather than a project nobody asked for.
 *   7. A workspace's icon and colour go to the project only where it has none.
 *   8. A session that recorded only a workspace gets that workspace's folder as
 *      its cwd, because workspaces are not read after this.
 *   9. meta.folders_adopted, and then the unique index on projects(path).
 *
 * The app takes a snapshot first and writes a restore point (main/backups.js);
 * this does not, because it runs under either route and a snapshot is the
 * app's job. Returns what it did, for the restore point and the log.
 */
function adoptFolders({ sql, batch, now = () => new Date() }) {
  const adopted = sql("SELECT value FROM meta WHERE key = :p1", [ADOPTED])[0];
  const shared = sharedFolders(sql);
  if (adopted && !shared.length) return { ran: false, conflicts: [], index: ensureIndex(sql) };
  const auditId = Number((sql("SELECT COALESCE(MAX(id), 0) AS n FROM audit", [])[0] || {}).n || 0);

  const statements = [];
  const projects = sql("SELECT id, key, name, path, icon, colour, created_at FROM projects ORDER BY id", []);
  const spaces = hasTable(sql, "workspaces") && !adopted ? sql("SELECT id, name, path, icon, colour FROM workspaces", []) : [];
  const links = hasTable(sql, "project_workspaces") && !adopted ? sql("SELECT project_id, workspace_id, is_primary FROM project_workspaces", []) : [];
  const spaceById = new Map(spaces.map((w) => [Number(w.id), w]));
  const linksOf = (pid) => links.filter((l) => Number(l.project_id) === Number(pid)).map((l) => ({ ...l, space: spaceById.get(Number(l.workspace_id)) })).filter((l) => l.space);

  // 1 and 2: every project's folder, as it will be written.
  const folderOf = new Map();
  for (const p of projects) {
    let folder = p.path ? normalise(p.path) : null;
    // Only the first time. Afterwards a project with no folder is in No folder
    // on purpose, and a repos row it kept for a Workbench must not hand the
    // folder back to it.
    if (!folder && !adopted) {
      const mine = linksOf(p.id);
      const chosen = mine.find((l) => Number(l.is_primary)) || (mine.length === 1 ? mine[0] : null);
      if (chosen) folder = normalise(chosen.space.path);
    }
    if (!folder && !adopted) {
      const primary = sql("SELECT path FROM repos WHERE project_id = :p1 AND is_primary = 1 ORDER BY id LIMIT 1", [Number(p.id)])[0];
      if (primary && primary.path) folder = normalise(primary.path);
    }
    folderOf.set(Number(p.id), folder);
  }

  // 3. One project per folder.
  const byFolder = new Map();
  for (const p of projects) {
    const f = folderOf.get(Number(p.id));
    if (f) byFolder.set(f, [...(byFolder.get(f) || []), p]);
  }
  const conflicts = [];
  for (const [folder, holders] of byFolder) {
    if (holders.length < 2) continue;
    const scored = holders.map((p) => ({ p, s: score(sql, p.id) }));
    scored.sort((a, b) => b.s.total - a.s.total
      || String(a.p.created_at || "").localeCompare(String(b.p.created_at || ""))
      || Number(a.p.id) - Number(b.p.id));
    const [keeper, ...movers] = scored;
    const kept = [];
    for (const { p } of movers) {
      folderOf.set(Number(p.id), null);
      const released = releaseStatements(sql, p.id, folder);
      statements.push(...released.statements);
      kept.push(...released.kept.map((r) => ({ ...r, project_id: Number(p.id) })));
      // Its conversations ran in this folder, through the project's own
      // folder or the workspace link removed below, whether or not they wrote
      // it down. Written down now, so each still opens where it was (plan 1.3,
      // step 3) once the project is in No folder.
      statements.push(["UPDATE sessions SET cwd = :p1 WHERE project_id = :p2 AND (cwd IS NULL OR cwd = '')", [folder, Number(p.id)]]);
      const spaceIds = spaces.filter((w) => same(normalise(w.path), folder)).map((w) => Number(w.id));
      for (const wid of spaceIds) statements.push(["DELETE FROM project_workspaces WHERE project_id = :p1 AND workspace_id = :p2", [Number(p.id), wid]]);
    }
    const who = ({ p, s }) => ({ id: Number(p.id), key: p.key, name: p.name, ...s });
    const detail = { kept: who(keeper), moved: movers.map(who), repos: kept, at: now().toISOString() };
    conflicts.push({ folder, ...detail });
    statements.push([`INSERT INTO discovered_folders (path, seen_by, via, state, project_id, detail)
                      VALUES (:p1, 'migration', 'conflict', 'new', :p2, :p3)
                      ON CONFLICT(path) DO UPDATE SET via = 'conflict', state = 'new', project_id = excluded.project_id,
                        detail = excluded.detail, last_seen = datetime('now'), answered_at = NULL`,
      [folder, Number(keeper.p.id), JSON.stringify(detail)]]);
  }

  // The folders as decided, written. NULLs first, so no two rows hold one
  // folder at any point in the batch.
  for (const p of projects) {
    const f = folderOf.get(Number(p.id));
    if (!f && p.path) statements.unshift(["UPDATE projects SET path = NULL WHERE id = :p1", [Number(p.id)]]);
  }
  for (const p of projects) {
    const f = folderOf.get(Number(p.id));
    if (f && f !== p.path) statements.push(["UPDATE projects SET path = :p1 WHERE id = :p2", [f, Number(p.id)]]);
  }

  // 4 and 5: repos rows for the folders each project has.
  for (const p of projects) {
    const f = folderOf.get(Number(p.id));
    if (f) statements.push(...primaryRepoStatements(sql, p.id, f, { name: path.basename(f) }));
    const have = sql("SELECT path FROM repos WHERE project_id = :p1", [Number(p.id)]).map((r) => normalise(r.path));
    for (const l of linksOf(p.id)) {
      const wf = normalise(l.space.path);
      if (!wf || same(wf, f) || have.includes(wf)) continue;
      // A folder another project now keeps is that project's, not this one's
      // "also works in": that link is what the conflict above removed.
      if (conflicts.some((c) => same(c.folder, wf) && c.moved.some((m) => m.id === Number(p.id)))) continue;
      have.push(wf);
      statements.push(["INSERT INTO repos (project_id, name, path, is_primary) VALUES (:p1, :p2, :p3, 0)", [Number(p.id), l.space.name || path.basename(wf), wf]]);
    }
    // 7. Only where the project has none of its own.
    const home = linksOf(p.id).find((l) => Number(l.is_primary)) || null;
    if (home && home.space.icon && !p.icon) statements.push(["UPDATE projects SET icon = :p1 WHERE id = :p2 AND icon IS NULL", [home.space.icon, Number(p.id)]]);
    if (home && home.space.colour && !p.colour) statements.push(["UPDATE projects SET colour = :p1 WHERE id = :p2 AND colour IS NULL", [home.space.colour, Number(p.id)]]);
  }

  // 6. A folder nobody had made a project of is asked about, never made one.
  const linked = new Set(links.map((l) => Number(l.workspace_id)));
  const homes = [...folderOf.values()].filter(Boolean);
  for (const w of spaces) {
    const wf = normalise(w.path);
    if (linked.has(Number(w.id)) || !wf || homes.some((h) => same(h, wf))) continue;
    statements.push([`INSERT INTO discovered_folders (path, seen_by, via, state) VALUES (:p1, 'migration', 'migration', 'new')
                      ON CONFLICT(path) DO NOTHING`, [wf]]);
  }

  // 8. Sessions keep the folder their workspace gave them.
  if (spaces.length) {
    statements.push([`UPDATE sessions SET cwd = (SELECT w.path FROM workspaces w WHERE w.id = sessions.workspace_id)
                       WHERE (cwd IS NULL OR cwd = '') AND workspace_id IS NOT NULL
                         AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = sessions.workspace_id)`, []]);
  }

  // 9.
  statements.push(["INSERT INTO meta (key, value) VALUES (:p1, :p2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [ADOPTED, adopted ? adopted.value : now().toISOString()]]);
  batch(statements);
  return { ran: true, auditId, conflicts, index: ensureIndex(sql) };
}

/**
 * The unique index, made once no two projects share a folder. Its own step,
 * after the batch, because a failure here should cost the index (and say so),
 * never the migration that just ran.
 */
function ensureIndex(sql) {
  try {
    if (sql("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_projects_path'", []).length) return { ok: true };
    // An empty folder is no folder. Two '' rows would collide in the index
    // (it skips NULL, not ''), and the index would never be made.
    sql("UPDATE projects SET path = NULL WHERE path = ''", []);
    if (sharedFolders(sql).length) return { ok: false, why: "two projects still share a folder" };
    sql(INDEX, []);
    return { ok: true, made: true };
  } catch (error) {
    return { ok: false, why: String(error.message || error) };
  }
}

/** The shared-folder questions still waiting on a person, newest first. */
function conflicts(sql) {
  if (!hasTable(sql, "discovered_folders")) return [];
  return sql("SELECT * FROM discovered_folders WHERE via = 'conflict' AND state = 'new' ORDER BY id DESC", []).map((r) => {
    let detail = null;
    try { detail = JSON.parse(r.detail || "null"); } catch {}
    return { id: num(r.id), path: r.path, state: r.state, project_id: num(r.project_id), detail, first_seen: r.first_seen };
  });
}

module.exports = {
  normalise, same, isDir, projectFolders, folderFor, ownerOf, takenSentence,
  primaryRepoStatements, releaseStatements,
  adoptFolders, needsAdoption, ensureIndex, sharedFolders, score, conflicts, ADOPTED, INDEX,
};
