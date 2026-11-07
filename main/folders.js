// Folders, the window's half: Add folder as project, a project's Folders list
// (add, take off, make Home), the fix for a folder that moved, the "Add this
// folder?" question in Needs you, and what git says about each folder.
//
// The rule for a project's folders lives in workbench/folders.js and the
// writes in db.js, so the server and the app agree. This is the part only
// the window does: the native picker, and asking git about a folder before
// anyone has decided anything. A folder may be several projects', so nothing
// here refuses a folder because another project has it.
//
// Required by main.js, and by tools/folders_test.js under a plain Node with
// node:sqlite, so it takes everything it touches as arguments.

const fs = require("fs");
const path = require("path");
const os = require("os");
const rule = require("../workbench/folders");
const route = require("../workbench/route");

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
 */
function createFolders({ db, git, pick = async () => null }) {
  /**
   * What a folder is, before anything is written: its repository root (a
   * subfolder offers the root, a Workbench or other worktree its main
   * repository), the remote and default branch, which projects already have
   * it, and which projects with no folder have its name. Writes nothing.
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
    const holders = rule.holders(db.sqlP, root).map((h) => ({ id: h.id, name: h.name, archived: h.status === "archived", home: h.home }));
    const name = suggestedName(root);
    const slug = db.slugKey(name);
    // A project with no folder whose name is this folder's is probably the
    // same work, filed before it had a folder. Offered, never assumed.
    const matches = db.listProjects().filter((p) => !p.path && !holders.some((h) => h.id === p.id) && (
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
      holders,
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

  /** A new project for a folder: the project, its Home and its primary repos row, in one unit. */
  async function create({ path: folder, name, key }) {
    const look = await inspect(folder);
    if (!look.ok) throw new Error(look.why || "That folder cannot be added.");
    const label = String(name || "").trim() || look.suggestedName;
    const colours = ["#6366F1", "#0f7a80", "#2f8757", "#8a6a00", "#c4572a", "#c04a41", "#7c4dbd", "#5d6b82"];
    const made = db.createProject({
      key: String(key || "").trim() || look.suggestedKey, name: label, path: look.top,
      colour: colours[db.listProjects().length % colours.length],
      remote: look.remote, branch: look.defaultBranch,
    });
    // However the sheet was reached (the question's button, the switcher, a
    // drop), a folder that is a project's now is not a question any more.
    db.settleDiscovery(look.top, "added", made.id);
    return made;
  }

  /**
   * A project's Home: a folder for a project that has none, or a new Home
   * for one whose folder moved. The same write, through updateProject, so
   * History can undo it. The old Home stays as a linked folder.
   */
  async function setFolder(projectId, folder) {
    const look = await inspect(folder);
    if (!look.ok) throw new Error(look.why || "That folder cannot be used.");
    const after = db.updateProject(Number(projectId), { path: look.top }, { remote: look.remote, branch: look.defaultBranch });
    db.settleDiscovery(look.top, "attached", Number(projectId));
    return after;
  }

  /** Adds a folder to a project: its Home when it has none, linked otherwise. */
  async function addFolder(projectId, folder) {
    const look = await inspect(folder);
    if (!look || look.cancelled) return { cancelled: true };
    if (!look.ok) throw new Error(look.why || "That folder cannot be added.");
    const done = db.linkFolder(Number(projectId), look.top, { remote: look.remote, branch: look.defaultBranch });
    db.settleDiscovery(look.top, "attached", Number(projectId));
    return { ...done, shown: look.shown };
  }

  /** Makes one of the project's folders its Home. */
  async function makeHome(projectId, folder) {
    const found = rule.isDir(folder) ? await detect(folder) : {};
    return db.setHomeFolder(Number(projectId), folder, found.remote || found.branch ? found : {});
  }

  /**
   * The "Add this folder?" questions, worded for Needs you: who worked there,
   * what git says it is, the projects it can be added to (every active one,
   * since a folder may be several projects') and the one Delphi thinks it is.
   */
  function discoveries() {
    const list = db.folderDiscoveries();
    if (!list.length) return [];
    const attachable = db.foldersToAttach();
    return list.map((d) => {
      const likely = route.suggest(db.sqlP, { folder: d.path, branch: d.branch });
      return { ...d, shown: tilde(d.path), ownerRepo: ownerRepo(d.remote), attachable, suggested: likely ? likely.projectId : null, suggestedWhy: likely ? likely.why : null };
    });
  }

  /**
   * "Add to project": the folder becomes one of each chosen project's
   * folders, as if added in its settings, so History can undo each one.
   */
  async function attach(id, projectIds) {
    const row = db.discoveryRow(id);
    const ids = [...new Set((Array.isArray(projectIds) ? projectIds : [projectIds]).map(Number).filter(Number.isFinite))];
    if (!ids.length) throw new Error("Choose a project first.");
    const out = [];
    for (const pid of ids) {
      const project = db.getProject(pid);
      if (!project || project.status === "archived") throw new Error("One of those projects is not there any more.");
      out.push(await addFolder(pid, row.path));
    }
    return out;
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

  return { inspect, create, setFolder, addFolder, makeHome, clearFolder, listProjects, detectAll, detect, discoveries, attach };
}

/** The IPC channels. Every one is the window's: there is no MCP tool for any of them. */
function register(handle, { folders, db }) {
  handle("folders:inspect", (raw) => folders.inspect(raw || null));
  handle("folders:create", (payload = {}) => folders.create(payload));
  handle("folders:set", (projectId, folder) => folders.setFolder(projectId, folder));
  handle("folders:clear", (projectId) => folders.clearFolder(projectId));
  handle("folders:list", (projectId) => db.projectFolderList(projectId));
  handle("folders:add", (projectId, folder) => folders.addFolder(projectId, folder || null));
  handle("folders:remove", (projectId, folder) => db.unlinkFolder(projectId, folder));
  handle("folders:home", (projectId, folder) => folders.makeHome(projectId, folder));
  handle("folders:routes", () => db.filedRoutes());
  handle("folders:settleRoute", (entity, id) => db.settleRoute(entity, id));
  handle("folders:discoveries", () => folders.discoveries());
  handle("folders:attach", (id, projectIds) => folders.attach(id, projectIds));
  handle("folders:ignore", (id) => db.ignoreDiscovery(id));
}

module.exports = { createFolders, register, ownerRepo, tilde };
