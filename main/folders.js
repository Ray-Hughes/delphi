// Folders, the window's half: Add folder as project, the fix for a folder that
// moved, the shared-folder question in Needs you, and what git says about each
// folder.
//
// The rule for which folder is a project's lives in workbench/folders.js and
// the writes in db.js, so the server and the app agree. This is the part only
// the window does: the native picker, asking git about a folder before anyone
// has decided anything, and the three answers to the shared-folder question,
// which are a person's to give and so have no MCP tool.
//
// Required by main.js, and by tools/folders_test.js under a plain Node with
// node:sqlite, so it takes everything it touches as arguments.

const fs = require("fs");
const path = require("path");
const os = require("os");
const rule = require("../workbench/folders");

/** owner/repo from a remote URL, for a line a person reads. The URL itself is kept. */
function ownerRepo(remote) {
  if (!remote) return null;
  const m = String(remote).trim().replace(/\.git$/, "").match(/[:/]([^/:]+)\/([^/]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** A name for a folder: its own, with the dashes a person would not type. */
function suggestedName(folder) {
  return path.basename(folder) || folder;
}

const tilde = (p) => {
  const home = os.homedir();
  return p && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p;
};

/**
 * @param db      the app's db.js
 * @param git     workbench/git.js
 * @param pick    async () => a folder path or null (the native picker)
 * @param items   () => the item store, for a merge
 */
function createFolders({ db, git, pick = async () => null, items = () => db.items() }) {
  /**
   * What a folder is, before anything is written: its repository root (a
   * subfolder offers the root, a Workbench or other worktree its main
   * repository), the remote and default branch, and whether a project already
   * has it or a project with no folder has its name. Writes nothing.
   */
  async function inspect(raw) {
    const chosen = raw ? rule.normalise(raw) : await pick();
    if (!chosen) return { cancelled: true };
    const given = rule.normalise(chosen);
    let st = null;
    try { st = fs.statSync(given); } catch {}
    if (!st) return { ok: false, path: given, why: `${tilde(given)} is not there.` };
    if (!st.isDirectory()) return { ok: false, path: given, notFolder: true, why: `${path.basename(given)} is a file. Drop the folder that holds it instead.` };

    const top = await git.toplevel(given);
    let root = top || given;
    let worktreeOf = null;
    if (top) {
      const main = await git.mainCheckout(top);
      if (main && !rule.same(rule.normalise(main), rule.normalise(top)) && !(await git.isBare(main))) {
        worktreeOf = rule.normalise(top);
        root = main;
      }
    }
    root = rule.normalise(root);
    const remote = top ? await git.remoteUrl(root) : null;
    const branch = top ? await git.defaultBranch(root) : null;
    const owner = rule.ownerOf(db.sqlP, root);
    const name = suggestedName(root);
    const slug = db.slugKey(name);
    // A project with no folder whose name is this folder's is probably the
    // same work, filed before it had a folder. Offered, never assumed.
    const matches = owner ? [] : db.listProjects().filter((p) => !p.path && (
      db.slugKey(p.key) === slug || db.slugKey(p.name) === slug)).map((p) => ({ id: p.id, key: p.key, name: p.name }));
    let key = slug || `p${Date.now()}`;
    for (let n = 2; db.projectByKey(key); n += 1) key = `${slug}-${n}`;
    return {
      ok: true,
      path: given,
      top: root,
      shown: tilde(root),
      subfolder: Boolean(top) && !worktreeOf && !rule.same(given, root),
      worktreeOf: worktreeOf ? tilde(worktreeOf) : null,
      isGit: Boolean(top),
      remote,
      ownerRepo: ownerRepo(remote),
      defaultBranch: branch,
      existing: owner ? { id: Number(owner.id), name: owner.name, archived: owner.status === "archived" } : null,
      matches,
      suggestedName: name,
      suggestedKey: key,
    };
  }

  /** Asks git again, so what is written is what is true now rather than what the sheet showed. */
  async function detect(folder) {
    const top = await git.toplevel(folder);
    if (!top) return { remote: null, branch: null };
    return { remote: await git.remoteUrl(folder), branch: await git.defaultBranch(folder) };
  }

  /** A new project for a folder: the project, its folder and its primary repos row, in one unit. */
  async function create({ path: folder, name, key }) {
    const look = await inspect(folder);
    if (!look.ok) throw new Error(look.why || "That folder cannot be added.");
    if (look.existing) throw new Error(rule.takenSentence({ name: look.existing.name, status: look.existing.archived ? "archived" : "active" }));
    const label = String(name || "").trim() || look.suggestedName;
    const colours = ["#6366F1", "#0f7a80", "#2f8757", "#8a6a00", "#c4572a", "#c04a41", "#7c4dbd", "#5d6b82"];
    return db.createProject({
      key: String(key || "").trim() || look.suggestedKey, name: label, path: look.top,
      colour: colours[db.listProjects().length % colours.length],
      remote: look.remote, branch: look.defaultBranch,
    });
  }

  /**
   * A folder for a project that has none, or a new place for one whose folder
   * moved: the same write, through updateProject, so History can undo it.
   */
  async function setFolder(projectId, folder) {
    const look = await inspect(folder);
    if (!look.ok) throw new Error(look.why || "That folder cannot be used.");
    if (look.existing && look.existing.id !== Number(projectId)) throw new Error(rule.takenSentence({ name: look.existing.name, status: look.existing.archived ? "archived" : "active" }));
    return db.updateProject(Number(projectId), { path: look.top }, { remote: look.remote, branch: look.defaultBranch });
  }

  /** No folder, on purpose. The repos rows stay, for the folder's settings, and are not read. */
  function clearFolder(projectId) {
    return db.updateProject(Number(projectId), { path: null });
  }

  /**
   * Every project, with whether its folder is on disk. The window draws the
   * fix-it bar from folder_missing; a stat per project is cheap next to the
   * counts listProjects already makes.
   */
  function listProjects() {
    const rows = db.listProjects();
    const repos = new Map(db.sqlP("SELECT project_id, path, remote_url, default_branch FROM repos WHERE is_primary = 1", [])
      .map((r) => [`${r.project_id}\n${r.path}`, r]));
    return rows.map((p) => {
      if (!p.path) return p;
      const r = repos.get(`${p.id}\n${p.path}`) || null;
      return { ...p, folder_missing: !rule.isDir(p.path), remote_url: r ? r.remote_url : null, default_branch: r ? r.default_branch : null, owner_repo: ownerRepo(r && r.remote_url) };
    });
  }

  /**
   * The shared-folder questions, worded from what each project holds now,
   * not when the migration ran: a project can have gained tasks since.
   */
  function conflicts() {
    return db.folderConflicts().map((c) => {
      const kept = c.detail && c.detail.kept ? db.getProject(c.detail.kept.id) : null;
      const moved = (c.detail && c.detail.moved ? c.detail.moved : []).map((m) => db.getProject(m.id)).filter(Boolean);
      const holds = (p) => {
        const n = (q) => Number((db.sqlP(q, [p.id])[0] || {}).n || 0);
        return {
          tasks: n("SELECT COUNT(*) AS n FROM tasks WHERE project_id = :p1"),
          open: n("SELECT COUNT(*) AS n FROM tasks WHERE project_id = :p1 AND status != 'done'"),
          notes: n("SELECT COUNT(*) AS n FROM notes WHERE project_id = :p1"),
          pads: n("SELECT COUNT(*) AS n FROM scratchpads WHERE project_id = :p1"),
          sessions: n("SELECT COUNT(*) AS n FROM sessions WHERE project_id = :p1"),
        };
      };
      const who = (p) => p && ({ id: p.id, name: p.name, status: p.status, path: p.path, ...holds(p) });
      return { id: c.id, path: c.path, shown: tilde(c.path), kept: who(kept), moved: moved.map(who), at: c.first_seen };
    }).filter((c) => c.kept || c.moved.length);
  }

  /**
   * "Merge X into Y": everything X holds moves through the item store, as a
   * person's moves that History can undo one by one, and X is archived, never
   * deleted. A move the store refuses stops the merge before the archive, and
   * the question stays open with the refusal as its sentence.
   */
  function merge(id, fromId) {
    const row = db.conflictRow(id);
    const detail = JSON.parse(row.detail || "{}");
    const into = db.getProject(Number((detail.kept || {}).id));
    const source = db.getProject(Number(fromId));
    if (!into || !source) throw new Error("One of those projects is not there any more.");
    if (Number(source.id) === Number(into.id)) throw new Error("A project cannot be merged into itself.");
    // Only a project this question moved out. The id comes from the window,
    // and any other one would be a project merged and archived by mistake.
    if (!(detail.moved || []).some((m) => Number(m.id) === Number(source.id))) throw new Error(`${source.name} is not one of the projects that shared ${row.path}.`);
    const store = items();
    const from = db.newestAudit();
    const ids = (q) => db.sqlP(q, [source.id]).map((r) => Number(r.id));
    const queue = [
      ["organizer", ids("SELECT id FROM organizers WHERE project_id = :p1 ORDER BY id")],
      ["task", ids("SELECT id FROM tasks WHERE project_id = :p1 AND parent_id IS NULL ORDER BY id")],
      ["note", ids("SELECT id FROM notes WHERE project_id = :p1 ORDER BY id")],
      ["scratchpad", ids("SELECT id FROM scratchpads WHERE project_id = :p1 ORDER BY id")],
      ["link", ids("SELECT id FROM links WHERE project_id = :p1 ORDER BY id")],
      ["session", ids("SELECT id FROM sessions WHERE project_id = :p1 ORDER BY id")],
    ];
    const moved = [];
    for (const [entity, list] of queue) {
      for (const itemId of list) {
        try {
          store.move(entity, itemId, into.id);
          moved.push({ entity, id: itemId });
        } catch (error) {
          const why = error && error.details && error.details.refusals ? error.details.refusals.join(" ") : String(error.message || error);
          return { merged: false, moved, refused: { entity, id: itemId, why } };
        }
      }
    }
    db.updateProject(source.id, { status: "archived" });
    db.mergedFolderAnswer(id, db.auditSince(from));
    return { merged: true, moved, into: into.id, archived: source.id };
  }

  /**
   * Fills in the remote and default branch of every folder that has none
   * recorded yet. In the background after launch, because a folder may be on a
   * drive that is not mounted and git there can take a while to say so.
   */
  async function detectAll() {
    const rows = db.sqlP(`SELECT p.id, p.path FROM projects p
                           WHERE p.path IS NOT NULL AND p.status != 'archived'
                             AND NOT EXISTS (SELECT 1 FROM repos r WHERE r.project_id = p.id AND r.is_primary = 1
                                              AND r.path = p.path AND r.default_branch IS NOT NULL)`, []);
    let changed = 0;
    for (const p of rows) {
      if (!rule.isDir(p.path)) continue;
      const found = await detect(p.path);
      if (!found.branch && !found.remote) continue;
      const statements = rule.primaryRepoStatements(db.sqlP, p.id, p.path, { remote: found.remote, branch: found.branch });
      if (statements.length) { db.batchP(statements); changed += 1; }
    }
    return changed;
  }

  return { inspect, create, setFolder, clearFolder, listProjects, conflicts, merge, detectAll, detect };
}

/** The IPC channels. Every one is the window's: there is no MCP tool for any of them. */
function register(handle, { folders, db }) {
  handle("folders:inspect", (raw) => folders.inspect(raw || null));
  handle("folders:create", (payload = {}) => folders.create(payload));
  handle("folders:set", (projectId, folder) => folders.setFolder(projectId, folder));
  handle("folders:clear", (projectId) => folders.clearFolder(projectId));
  handle("folders:conflicts", () => folders.conflicts());
  handle("folders:keep", (id) => db.keepFolderAnswer(id));
  handle("folders:give", (id, toProjectId) => db.giveFolder(id, toProjectId));
  handle("folders:merge", (id, fromProjectId) => folders.merge(id, fromProjectId));
}

module.exports = { createFolders, register, ownerRepo, tilde };
