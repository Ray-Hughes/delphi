/**
 * Folders an agent worked in that are no project's yet: noticed by the MCP
 * server, put to a person in Needs you as "Add this folder?", and never made
 * a project by anyone but that person.
 *
 * An agent session started in ~/va/caseflow-efolder used to leave no trace
 * Delphi could act on, or, worse, an agent made a project for it unasked. Now
 * the server writes one discovered_folders row (via 'session') the first time
 * a session calls it from a folder no project has, and the window offers three
 * answers: add it as a new project, give it to a project that has no folder,
 * or "Not a project", which is kept for good. Agents propose; only the window
 * applies.
 *
 * Shared by the app and the server in the mould of workbench/folders.js: SQL
 * text and rules, handed a sql(query, params) in the :p1 style, and the git
 * half handed in as workbench/git.js so a test can see what was asked.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const rule = require("./folders");

// macOS and Windows file systems ignore case by default, and realpath does not
// always hand back the spelling on disk (a path typed as ~/VA/Caseflow stays
// that way through a symlink it cannot see past). Compared folded there, so one
// folder is one row whoever typed it.
const FOLDS = process.platform === "darwin" || process.platform === "win32";
const fold = (p) => (p && FOLDS ? p.toLowerCase() : p);

/** The comparable spelling: normalised as folders.js writes a path, then folded. */
const key = (p) => fold(rule.normalise(p));

/** Whether a is b or inside it, on keys. */
function within(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const base = b.endsWith(path.sep) ? b : b + path.sep;
  return a.startsWith(base);
}

/**
 * The temporary folders, real paths and as written. A session in one is a
 * scratch checkout, a test, or an installer, never work a person would file.
 * DELPHI_DISCOVERY_TEMP replaces the list, because every test of this runs in
 * a temporary folder and would otherwise find nothing to discover.
 */
function tempRoots(env = process.env) {
  const given = env.DELPHI_DISCOVERY_TEMP;
  const raw = given !== undefined
    ? String(given).split(path.delimiter).filter(Boolean)
    : [os.tmpdir(), env.TMPDIR, env.TEMP, env.TMP, "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders"];
  const out = new Set();
  for (const r of raw) {
    if (!r) continue;
    out.add(fold(path.resolve(r).replace(/[\\/]+$/, "")));
    const k = key(r);
    if (k) out.add(k);
  }
  return [...out];
}

/**
 * Why a folder is never asked about, from its spelling alone, or null.
 * Checked on the folder the session gave and again on the repository root
 * git finds for it, since either can be the one that is out of bounds.
 */
function outOfBounds(folder, { dataDir = null, workbenchDir = null, env = process.env, home = os.homedir() } = {}) {
  const k = key(folder);
  if (!k) return "no folder";
  const parsed = path.parse(k);
  if (k === parsed.root) return "the top of the disk";
  // A session started in the home folder is a terminal that was not cd'd
  // anywhere, not a project.
  if (k === key(home)) return "the home folder";
  if (dataDir && within(k, key(dataDir))) return "Delphi's own data folder";
  if (tempRoots(env).some((t) => within(k, t))) return "a temporary folder";
  // A Workbench is a task's copy of a repository that already is a project.
  // The folder name says so even when the table has lost the row.
  if (k.split(/[\\/]/).some((part) => part.endsWith(".workbenches"))) return "a Workbench";
  const wbDir = workbenchDir || env.DELPHI_WORKBENCH_DIR;
  if (wbDir && within(k, key(wbDir))) return "a Workbench";
  return null;
}

/**
 * Whether a folder is already accounted for, and by what. A project's folder
 * or anything inside it, a folder a project also works in (its repos rows), a
 * Workbench the table knows, and the folder above a project's (~/va, which
 * holds caseflow and efolder and is neither).
 */
function knownAs(sql, folder, known = snapshot(sql)) {
  const k = key(folder);
  if (!k) return null;
  for (const p of known.projects) {
    const pk = p.key;
    if (within(k, pk)) return { kind: k === pk ? "project" : "inside", id: Number(p.id), name: p.name };
    if (within(pk, k)) return { kind: "above", id: Number(p.id), name: p.name };
  }
  for (const r of known.repos) {
    if (within(k, r.key)) return { kind: "repo", id: r.project_id };
  }
  for (const w of known.benches) {
    if (within(k, w)) return { kind: "workbench" };
  }
  return null;
}

/**
 * Every folder knownAs() compares against, read once. Three queries, so a
 * list of questions costs three on the sqlite3 route (a process each) rather
 * than three per question.
 */
function snapshot(sql) {
  const projects = sql("SELECT id, name, path FROM projects WHERE path IS NOT NULL AND path != ''", [])
    .map((p) => ({ id: Number(p.id), name: p.name, key: key(p.path) }));
  // Only the folders a project also works in. A primary row counts through
  // projects.path, as projectFolders() has it: one left behind by a project
  // that gave its folder up (or an undone Attach) is a stale copy, and must
  // not make a folder with no project look like one that has one.
  const repos = sql("SELECT project_id, path FROM repos WHERE path IS NOT NULL AND path != '' AND is_primary = 0", [])
    .map((r) => ({ project_id: Number(r.project_id), key: key(r.path) }));
  const benches = sql("SELECT path FROM workbenches WHERE path IS NOT NULL", []).map((w) => key(w.path));
  return { projects, repos, benches };
}

/**
 * The folder a session's folder stands for: its repository's top level, and
 * for a linked worktree its main checkout, as Add folder decides. A folder
 * that is not in a repository stands for itself. Asks git; writes nothing.
 */
async function rootOf(folder, git) {
  const given = rule.normalise(folder);
  if (!given || !rule.isDir(given)) return null;
  const top = git ? await git.toplevel(given) : null;
  if (!top) return { path: given, given, isGit: false, remote: null, branch: null };
  let root = rule.normalise(top);
  const main = await git.mainCheckout(top);
  if (main && !rule.same(rule.normalise(main), root) && !(await git.isBare(main))) root = rule.normalise(main);
  return { path: root, given, isGit: true, remote: await git.remoteUrl(root), branch: await git.defaultBranch(root) };
}

/**
 * What one folder a session called from comes to: { skip: reason } when it is
 * never asked about or already known, else { path, remote, branch, isGit }.
 */
async function consider(sql, folder, { git, dataDir = null, workbenchDir = null, env = process.env, home = os.homedir() } = {}) {
  const bounds = { dataDir, workbenchDir, env, home };
  const early = outOfBounds(folder, bounds);
  if (early) return { skip: early };
  // Before git, so a session inside a project's folder costs no process.
  const snap = snapshot(sql);
  const knownFirst = knownAs(sql, folder, snap);
  if (knownFirst) return { skip: `known (${knownFirst.kind})`, known: knownFirst };
  const found = await rootOf(folder, git);
  if (!found) return { skip: "not there" };
  const late = outOfBounds(found.path, bounds);
  if (late) return { skip: late };
  const known = knownAs(sql, found.path, snap);
  if (known) return { skip: `known (${known.kind})`, known };
  return found;
}

/** "Claude Code", "Codex", "Copilot", from the actor or the client's name. */
function harnessName(actor, clientName) {
  for (const s of [actor, clientName]) {
    const t = String(s || "").toLowerCase();
    if (/claude/.test(t)) return "Claude Code";
    if (/codex/.test(t)) return "Codex";
    if (/copilot/.test(t)) return "Copilot";
  }
  return null;
}

/**
 * The one write: a new row the first time, a count and a time after. Keyed on
 * the unique path, so two sessions seeing the same folder at once still make
 * one row, on either route, without a read before the write. An existing row
 * keeps its via, state and detail: "Not a project" stays answered, and a
 * shared-folder question stays the question it was.
 */
function recordStatement(found, { actor = null, harness = null, client = null, cwd = null, now = () => new Date() } = {}) {
  const detail = {
    harness, client, cwd: cwd || found.given || found.path,
    remote: found.remote || null, branch: found.branch || null, is_git: Boolean(found.isGit),
    at: now().toISOString(),
  };
  return [`INSERT INTO discovered_folders (path, seen_by, via, state, detail, seen_count)
           VALUES (:p1, :p2, 'session', 'new', :p3, 1)
           ON CONFLICT(path) DO UPDATE SET last_seen = datetime('now'), seen_count = COALESCE(seen_count, 0) + 1`,
    [found.path, actor, JSON.stringify(detail)]];
}

const num = (v) => (v === null || v === undefined ? null : Number(v));
const hasTable = (sql, name) => sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name = :p1", [name]).length > 0;

/**
 * The "Add this folder?" questions still waiting, newest first. A folder that
 * became a project's some other way since (Add folder, an agent's add_project
 * with a path) is left out rather than asked about, so the list never offers
 * to add what is already there. The migration's own rows (a workspace no
 * project had) are the same question, so they are here too.
 *
 * An 'added' or 'attached' answer whose folder is no project's any more (the
 * project write undone in History, or the folder taken off it) is asked
 * again, because the answer it records is no longer true. 'ignored' is never
 * asked again.
 */
function pending(sql) {
  if (!hasTable(sql, "discovered_folders")) return [];
  const rows = sql(`SELECT * FROM discovered_folders WHERE via IN ('session', 'migration') AND state IN ('new', 'added', 'attached')
                     ORDER BY last_seen DESC, id DESC`, []);
  if (!rows.length) return [];
  const known = snapshot(sql);
  return rows.filter((r) => !knownAs(sql, r.path, known)).map((r) => {
    let detail = null;
    try { detail = JSON.parse(r.detail || "null"); } catch {}
    detail = detail && typeof detail === "object" ? detail : {};
    return {
      id: num(r.id), path: r.path, via: r.via, state: r.state, seen_by: r.seen_by || null,
      seen_count: num(r.seen_count) || 1, first_seen: r.first_seen, last_seen: r.last_seen,
      harness: detail.harness || harnessName(r.seen_by, detail.client), remote: detail.remote || null, branch: detail.branch || null,
    };
  });
}

/**
 * The projects a folder can be attached to: active ones with no folder. One
 * folder per project, so a project that has one is not offered, rather than
 * offered and then refused.
 */
function attachable(sql) {
  return sql("SELECT id, key, name FROM projects WHERE (path IS NULL OR path = '') AND status != 'archived' ORDER BY sort_order, id", [])
    .map((p) => ({ id: num(p.id), key: p.key, name: p.name }));
}

module.exports = {
  key, within, tempRoots, outOfBounds, knownAs, snapshot, rootOf, consider, harnessName, recordStatement, pending, attachable,
};
