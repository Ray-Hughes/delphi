/**
 * Workbenches: a folder and a branch per task, so two pieces of work never
 * share one checkout.
 *
 * Underneath it is a git worktree, but nothing here hands a person git's words.
 * There are five verbs (Start, Open, Park, Finish, Discard) and everything else
 * (a branch that already exists, a folder deleted by hand, a worktree git forgot
 * about) is handled here and explained in a sentence.
 *
 * The rules that matter most are the never-lose-work ones, and they are why
 * this file refuses more than it does:
 *
 * - Finish removes the folder only when nothing in it is unsaved and nothing on
 *   the branch is unshared, and it never forces. The branch is always kept.
 * - Discard is the only verb that throws work away. It needs the task's number
 *   typed back, it lists what goes first, and it deletes the branch only when
 *   the branch never reached a remote. Agents are never offered it.
 * - A folder that disappears is marked Missing, never forgotten silently, so a
 *   task does not quietly lose track of where its work was.
 *
 * Shared by the app (in process, db.sqlP) and the MCP server (its own sql), as
 * the stores are. Everything that varies between them is injected: the store,
 * the Sheet to write notes on, the runner for setup, the settings, the events.
 */

const fs = require("fs");
const path = require("path");
const naming = require("./naming");
const setupMod = require("./setup");
const defaultGit = require("./git");

// Status is asked for on every repaint of a task panel and every row of the
// Overview, and each answer is three or four git processes. Ten seconds is
// short enough that a commit made in a terminal shows up before anyone wonders,
// and every write here drops the cached answer for its folder anyway.
const STATUS_TTL_MS = 10000;
// MAX_PATH is 260 on Windows and git adds its own files under the folder, so
// the folder itself has to leave room.
const WINDOWS_PATH_LIMIT = 240;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isEmptyDir(p) {
  try { return fs.readdirSync(p).length === 0; } catch { return true; }
}

function inside(root, p) {
  const r = path.resolve(root);
  const q = path.resolve(p);
  return q === r || q.startsWith(r + path.sep);
}

/** An Error with a code, for surfaces that want to offer something (Open, Commit) rather than only show it. */
function refusal(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function createWorkbench({
  store,
  sheet = null,
  runEntry = null,
  git = defaultGit,
  settings = () => ({}),
  logDir = null,
  onEvent = null,
  env = process.env,
} = {}) {
  if (!store) throw new Error("createWorkbench needs a store");
  const cache = new Map();
  const queues = new Map();
  let unmanaged = [];

  function emit(taskId, workbenchId, phase, text) {
    if (!onEvent) return;
    try { onEvent({ workbenchId: workbenchId || null, taskId, phase, text }); } catch {}
  }

  // The Sheet is the record of what happened to the work, so every verb that
  // changes a Workbench says so there. A failed note never fails the verb: the
  // folder and branch are the real thing, the note is the account of it.
  async function note(taskId, body) {
    if (!sheet || typeof sheet.append !== "function") return null;
    try { return await sheet.append({ taskId, kind: "note", body }); } catch { return null; }
  }

  function drop(p) { cache.delete(p); }

  /**
   * One Start at a time per repository in this process. Two `git worktree add`
   * calls at once fight over .git/worktrees and the ref locks; across processes
   * workbench/git.js retries on the lock instead.
   */
  function serial(key, fn) {
    const prior = queues.get(key) || Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return next;
  }

  function prefix() {
    const s = (typeof settings === "function" ? settings() : settings) || {};
    return naming.cleanPrefix(s.workbenchBranchPrefix) || naming.cleanPrefix(env.DELPHI_BRANCH_PREFIX) || naming.defaultPrefix();
  }

  function overrideDir() {
    const dir = env.DELPHI_WORKBENCH_DIR;
    if (!dir) return null;
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    return git.real(dir);
  }

  // ---------------------------------------------------------------------------
  // Which repository

  /**
   * Every repository the task's project points at, one entry per repository
   * however many folders lead to it, best first. Only folders that are really
   * inside a git working tree count.
   */
  async function candidates(taskId) {
    const task = store.task(taskId);
    const seen = new Map();
    for (const folder of store.repoFolders(task.project_id)) {
      const top = await git.toplevel(folder.path);
      if (!top) continue;
      const main = (await git.mainCheckout(top)) || top;
      if (!isDir(main) || await git.isBare(main)) continue;
      const prior = seen.get(main);
      if (prior) {
        // The same repository reached twice: keep the repos row if either has
        // one, and the primary flag if either is primary.
        if (prior.repo_id == null && folder.repo_id != null) Object.assign(prior, { repo_id: folder.repo_id, name: folder.name, source: "repo" });
        prior.is_primary = prior.is_primary || folder.is_primary;
        continue;
      }
      seen.set(main, { repo_id: folder.repo_id, name: folder.name || path.basename(main), path: main, source: folder.source, is_primary: folder.is_primary });
    }
    return [...seen.values()];
  }

  /** The repository a Start should use, as a repos row and its real top folder. */
  async function chooseRepo(task, { repoId = null, repo = null, path: given = null } = {}) {
    if (task.project_id == null) {
      throw refusal(`Task ${task.id} is not in a project, so there is no repository to work in. Put it in a project first.`, "NO_PROJECT");
    }
    const list = await candidates(task.id);
    let pick = null;
    if (repoId != null) {
      pick = list.find((c) => c.repo_id === Number(repoId));
      if (!pick) throw refusal(`Repository ${repoId} is not one of this project's, or its folder is not a git repository.`, "NO_REPO");
    } else if (given || repo) {
      const wanted = String(given || repo);
      pick = list.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
      if (!pick) {
        const top = await git.toplevel(path.resolve(wanted));
        if (top) {
          const main = (await git.mainCheckout(top)) || top;
          pick = list.find((c) => git.samePath(c.path, main)) || { repo_id: null, name: path.basename(main), path: main, source: "given", is_primary: 0 };
        }
      }
      if (!pick) {
        throw refusal(`'${wanted}' is not a repository of this project or a git folder. ${list.length ? `The project has ${list.map((c) => `${c.name} (${c.path})`).join(", ")}.` : ""}`.trim(), "NO_REPO", { candidates: list });
      }
    } else {
      if (!list.length) {
        throw refusal(`Task ${task.id}'s project has no git repository Delphi can find. Add one to the project, or point the project at the folder its code is in.`, "NO_REPO", { candidates: [] });
      }
      const repoPrimary = list.filter((c) => c.source === "repo" && c.is_primary);
      const primaries = list.filter((c) => c.is_primary);
      pick = list.length === 1 ? list[0] : repoPrimary.length === 1 ? repoPrimary[0] : primaries.length === 1 ? primaries[0] : null;
      if (!pick) {
        throw refusal(`Task ${task.id}'s project has several repositories and none is marked primary: ${list.map((c) => `${c.name} (${c.path})`).join(", ")}. Say which one.`, "WHICH_REPO", { candidates: list });
      }
    }
    const row = pick.repo_id != null ? store.repo(pick.repo_id) : store.adoptRepo({ projectId: task.project_id, path: pick.path, name: pick.name });
    return { repo: row, top: pick.path };
  }

  /** The real top folder of a Workbench's repository, from its row, or from the folder itself. */
  async function repoTopOf(wb) {
    const fromRow = await git.toplevel(wb.repo_path);
    if (fromRow) return (await git.mainCheckout(fromRow)) || fromRow;
    if (isDir(wb.path)) return git.mainCheckout(wb.path);
    return null;
  }

  // ---------------------------------------------------------------------------
  // Start

  async function start(taskId, { repoId = null, repo = null, path: given = null, runSetup = true, background = false } = {}) {
    const task = store.task(taskId);
    const { repo: repoRow, top } = await chooseRepo(task, { repoId, repo, path: given });
    const existing = store.live(task.id, repoRow.id);
    if (existing) return { workbench: existing, created: false, warnings: [], setup_entry: null };

    const made = await serial(top, () => create(task, repoRow, top));
    if (!made.created) return made;

    const { workbench } = made;
    let setupCmd = repoRow.setup_cmd;
    if (setupCmd === null || setupCmd === undefined) {
      setupCmd = setupMod.detectSetup(top);
      try { store.updateRepo(repoRow.id, { setup_cmd: setupCmd }); } catch {}
    }
    if (!runSetup || !setupCmd || !runEntry || !sheet || !logDir) {
      emit(task.id, workbench.id, "ready", `Ready at ${workbench.path}`);
      // setup_cmd is handed back when it was not run, so a caller that wants
      // to run it itself (the command line, streaming the output) can.
      return { ...made, setup_entry: null, setup_cmd: setupCmd || null };
    }
    const setup = async () => {
      emit(task.id, workbench.id, "setup", `Running ${setupCmd}`);
      const entry = await runEntry({ store: sheet, taskId: task.id, command: setupCmd, cwd: workbench.path, logDir });
      const ok = entry && entry.meta && entry.meta.state === "ok";
      emit(task.id, workbench.id, ok ? "ready" : "failed",
        ok ? `Ready at ${workbench.path}` : `Setup did not finish (${setupCmd}). The folder is there; see the Sheet for what it said.`);
      return entry;
    };
    if (background) {
      setup().catch((error) => emit(task.id, workbench.id, "failed", String(error.message || error)));
      return { ...made, setup_entry: null, setup: setupCmd };
    }
    return { ...made, setup_entry: await setup() };
  }

  async function create(task, repoRow, top) {
    // Asked again inside the queue: a Start that waited behind another for the
    // same task should get that one's Workbench, not a second.
    const again = store.live(task.id, repoRow.id);
    if (again) return { workbench: again, created: false, warnings: [], setup_entry: null };

    const warnings = [];
    if (await git.isBare(top)) throw refusal(`${top} is a bare repository, which has no files to work on.`, "BARE");
    const base = repoRow.base_branch || await git.defaultBranch(top);
    if (!base) {
      throw refusal(`Could not tell which branch ${repoRow.name} starts from. Set the base branch in the repository's Workbench settings.`, "NO_BASE");
    }

    emit(task.id, null, "fetching", `Getting the latest ${base}`);
    const fetched = await git.fetch(top, base);
    if (!fetched.ok) {
      warnings.push(fetched.noRemote
        ? `This repository has no remote, so using your local copy of ${base}.`
        : `Could not reach the remote (${fetched.reason}), so using your local copy of ${base}.`);
    }
    const startPoint = await git.baseRef(top, base);
    if (!startPoint) {
      throw refusal(`There is no branch called ${base} in ${repoRow.name}, here or on the remote. Set the base branch in the repository's Workbench settings.`, "NO_BASE");
    }

    const branch = naming.branchName({ prefix: prefix(), taskId: task.id, title: task.title, ref: task.ref });
    const folder = naming.folderFor({ repoTop: top, taskId: task.id, title: task.title, overrideDir: overrideDir() });
    if (process.platform === "win32" && folder.length > WINDOWS_PATH_LIMIT) {
      throw refusal(`The folder would be ${folder.length} characters long, past what Windows allows. Set DELPHI_WORKBENCH_DIR to a short folder near the drive root, such as C:\\wb, and start again.`, "PATH_TOO_LONG");
    }

    if (fetched.ok) await git.fetchBranch(top, branch);
    const state = await git.branchState(top, branch);
    if (state.checkedOutAt && !git.samePath(state.checkedOutAt, folder)) {
      throw refusal(`The branch ${branch} is already open in another folder: ${state.checkedOutAt}. Open that folder instead, or finish the work there first.`,
        "CHECKED_OUT_ELSEWHERE", { path: state.checkedOutAt, branch });
    }

    if (state.checkedOutAt) {
      // The folder is already a worktree on this branch, made by an earlier
      // Start whose row is gone. Taking it back loses nothing; making another
      // would be impossible anyway.
      warnings.push(`Picked up the folder already at ${folder}.`);
    } else {
      if (isDir(folder) && !isEmptyDir(folder)) {
        throw refusal(`There is already a folder at ${folder} that Delphi did not make. Move it or delete it, then start again.`, "FOLDER_EXISTS", { path: folder });
      }
      if (fs.existsSync(folder) && !isDir(folder)) {
        throw refusal(`There is a file at ${folder} where the Workbench folder would go. Move it, then start again.`, "FOLDER_EXISTS", { path: folder });
      }
      emit(task.id, null, "creating", `Making ${branch}`);
      const mode = state.local ? "local" : state.remote ? "remote" : "new";
      const added = await git.worktreeAdd(top, folder, { branch, startPoint, mode });
      if (!added.ok) throw refusal(git.plain(added, "git could not make the folder."), "GIT");
      if (mode === "local") warnings.push(`Picked up your existing branch ${branch}.`);
      if (mode === "remote") warnings.push(`Picked up the branch ${branch} from the remote.`);
    }
    const where = git.real(folder);

    emit(task.id, null, "copying", "Copying files git does not carry");
    const copied = setupMod.copyFiles(top, where, repoRow.copy_files ?? setupMod.DEFAULT_COPY);
    for (const s of copied.skipped) warnings.push(`Did not copy ${s.file}: ${s.reason}.`);
    if (git.hasSubmodules(top)) {
      warnings.push("This repository uses submodules, which a Workbench does not set up. If you need them, run git submodule update --init in the folder.");
    }

    const workbench = store.insert({ taskId: task.id, repoId: repoRow.id, path: where, branch, base });
    await note(task.id, `started workbench on ${branch}`);
    store.audit(task.id, "started workbench");
    return { workbench, created: true, warnings, copied: copied.copied };
  }

  // ---------------------------------------------------------------------------
  // Status

  function missingStatus(wb) {
    return {
      words: "Missing", state: "missing", unsaved: 0, files: [], ahead: 0, behind: 0,
      base: wb.base, hasRemote: false, hasRemoteBranch: false, checkedAt: new Date().toISOString(),
    };
  }

  async function statusOf(wb, { fresh = false } = {}) {
    if (wb.state === "finished" || wb.state === "discarded") {
      return { ...missingStatus(wb), words: wb.state === "finished" ? "Finished" : "Discarded", state: wb.state };
    }
    const hit = cache.get(wb.path);
    if (!fresh && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;

    let value;
    const s = wb.state === "missing" || !isDir(wb.path) ? null : await git.status(wb.path);
    if (!s || !s.ok) {
      value = missingStatus(wb);
    } else {
      const remote = await git.hasRemote(wb.path);
      const hasRemoteBranch = remote && await git.refExists(wb.path, `refs/remotes/${git.REMOTE}/${wb.branch}`);
      // Unshared means on no remote at all. With no remote there is nowhere to
      // share to, and the branch is kept by Finish, so nothing counts here.
      const ahead = remote ? await git.countCommits(wb.path, ["HEAD", "--not", `--remotes=${git.REMOTE}`]) : 0;
      const onto = await git.baseRef(wb.path, wb.base);
      const behind = onto ? await git.countCommits(wb.path, [`HEAD..${onto}`]) : 0;
      const parts = [];
      if (s.unsaved) parts.push(plural(s.unsaved, "unsaved change", "unsaved changes"));
      if (ahead) parts.push(`${plural(ahead, "commit", "commits")} not shared yet`);
      if (behind) parts.push(`${parts.length ? "behind" : "Behind"} ${wb.base} by ${behind}`);
      value = {
        words: parts.join(", ") || "Ready",
        state: s.unsaved ? "unsaved" : ahead ? "unshared" : behind ? "behind" : "ready",
        unsaved: s.unsaved,
        files: s.files,
        ahead,
        behind,
        base: wb.base,
        hasRemote: remote,
        hasRemoteBranch,
        checkedAt: new Date().toISOString(),
      };
    }
    cache.set(wb.path, { at: Date.now(), value });
    return value;
  }

  async function status(id, opts = {}) {
    return statusOf(store.get(id), opts);
  }

  async function withStatus(wb) {
    return wb ? { ...wb, status: await statusOf(wb) } : null;
  }

  async function forTask(taskId) {
    return withStatus(store.live(taskId));
  }

  async function list({ projectId = null, includeClosed = false } = {}) {
    const rows = store.list({ projectId, includeClosed });
    const out = [];
    for (const row of rows) out.push(await withStatus(row));
    return out;
  }

  // ---------------------------------------------------------------------------
  // Park, resume, update, commit, push, pull request

  /** A Workbench whose folder is there to act on, or a sentence saying why not. */
  function requireOpen(wb) {
    if (wb.state === "finished" || wb.state === "discarded") {
      throw refusal(`Workbench ${wb.id} for task ${wb.task_id} is already ${wb.state}.`, "CLOSED");
    }
    if (wb.state === "missing" || !isDir(wb.path)) {
      throw refusal(`The folder for task ${wb.task_id}'s Workbench is gone (${wb.path}). Recreate it, or forget it.`, "MISSING");
    }
    return wb;
  }

  function park(id) {
    const wb = requireOpen(store.get(id));
    if (wb.state === "parked") return wb;
    const row = store.setState(wb.id, "parked");
    store.audit(wb.task_id, "parked workbench");
    return row;
  }

  function resume(id) {
    const wb = requireOpen(store.get(id));
    if (wb.state === "active") return wb;
    const row = store.setState(wb.id, "active");
    store.audit(wb.task_id, "resumed workbench");
    return row;
  }

  async function update(id) {
    const wb = requireOpen(store.get(id));
    const before = await statusOf(wb, { fresh: true });
    if (before.unsaved) {
      return {
        ok: false,
        words: `Commit the ${plural(before.unsaved, "unsaved change", "unsaved changes")} first; bringing in ${wb.base} needs a clean folder.`,
        conflict: null,
      };
    }
    const result = await git.pullRebase(wb.path, wb.base);
    drop(wb.path);
    if (!result.ok) {
      return { ok: false, words: result.reason, conflict: result.conflict ? { files: result.files, message: result.reason } : null };
    }
    store.touch(wb.id);
    store.audit(wb.task_id, `updated workbench from ${wb.base}`);
    const after = await statusOf(wb, { fresh: true });
    const words = result.offline ? `${after.words} (could not reach the remote, so updated from your local copy of ${wb.base})` : after.words;
    return { ok: true, words, conflict: null };
  }

  async function commit(id, message) {
    const wb = requireOpen(store.get(id));
    await git.commitAll(wb.path, message);
    drop(wb.path);
    store.touch(wb.id);
    store.audit(wb.task_id, "committed in workbench");
    return statusOf(wb, { fresh: true });
  }

  async function push(id) {
    const wb = requireOpen(store.get(id));
    const result = await git.push(wb.path, wb.branch);
    drop(wb.path);
    if (result.ok) {
      store.touch(wb.id);
      store.audit(wb.task_id, "pushed workbench");
    }
    return result;
  }

  /**
   * Where to open a pull request. With create, gh opens it (or finds the one
   * already open). Without, this only says which way it would go, so a surface
   * can label its button before anything happens.
   */
  async function pr(id, { create: make = false } = {}) {
    const wb = requireOpen(store.get(id));
    const st = await statusOf(wb, { fresh: true });
    if (!st.hasRemoteBranch) return { url: null, via: null, reason: "Push the branch first: a pull request needs it on the remote." };
    const tool = git.gh();
    let reason = null;
    if (tool.available && tool.authed) {
      if (!make) return { url: null, via: "gh", reason: null };
      const task = store.task(wb.task_id);
      const ticket = naming.ticketOf(task.ref);
      const made = await git.prCreate(wb.path, {
        base: wb.base, branch: wb.branch,
        title: ticket ? `${ticket} ${task.title}` : task.title,
        body: `From Delphi task #${task.id}.`,
      });
      if (made.ok) return { url: made.url, via: "gh", reason: null };
      reason = made.reason;
    }
    const url = git.compareUrl(await git.remoteUrl(wb.path), wb.base, wb.branch);
    if (url) return { url, via: "compare", reason };
    return { url: null, via: null, reason: reason || "Could not tell where this remote opens pull requests. Open one on the host's website." };
  }

  // ---------------------------------------------------------------------------
  // Finish

  async function finish(id) {
    const wb = requireOpen(store.get(id));
    const st = await statusOf(wb, { fresh: true });
    if (st.unsaved) {
      const shown = st.files.slice(0, 5).join(", ") + (st.files.length > 5 ? `, and ${st.files.length - 5} more` : "");
      throw refusal(`There ${st.unsaved === 1 ? "is" : "are"} ${plural(st.unsaved, "unsaved change", "unsaved changes")} in the Workbench (${shown}). Commit them first. Finish never puts work aside on its own.`,
        "UNSAVED", { files: st.files });
    }
    if (st.ahead) {
      throw refusal(`${plural(st.ahead, "commit is", "commits are")} not shared yet. Push first: Finish only removes a folder whose work is safe on the remote.`,
        "UNSHARED", { ahead: st.ahead });
    }
    const top = await repoTopOf(wb);
    const removed = await git.worktreeRemove(top || wb.path, wb.path);
    if (!removed.ok) throw refusal(git.plain(removed, "git would not remove the folder."), "GIT");
    if (top) await git.worktreePrune(top);
    drop(wb.path);
    store.setState(wb.id, "finished");
    await note(wb.task_id, `finished workbench; the branch ${wb.branch} is kept`);
    store.audit(wb.task_id, "finished workbench");
    const task = store.task(wb.task_id);
    return { finished: true, taskStatus: task.status, branch: wb.branch };
  }

  // ---------------------------------------------------------------------------
  // Discard

  /** What Discard would throw away, in full, before anyone is asked to confirm it. */
  async function discardPlan(id) {
    const wb = store.get(id);
    if (wb.state === "finished" || wb.state === "discarded") {
      throw refusal(`Workbench ${wb.id} for task ${wb.task_id} is already ${wb.state}.`, "CLOSED");
    }
    const top = await repoTopOf(wb);
    const st = isDir(wb.path) ? await statusOf(wb, { fresh: true }) : missingStatus(wb);
    let branchPushed = false;
    let commits = [];
    let url = null;
    if (top) {
      // Asked of the remote itself when it answers, so a branch pushed from
      // another machine counts. Offline, the last known answer stands, which
      // errs towards keeping the branch.
      await git.fetchBranch(top, wb.branch);
      branchPushed = await git.refExists(top, `refs/remotes/${git.REMOTE}/${wb.branch}`);
      commits = await git.localOnlyCommits(top, wb.branch);
      url = await git.remoteUrl(top);
    }
    return {
      unsaved: st.files,
      commits,
      branchPushed,
      remote: branchPushed ? `${git.REMOTE}/${wb.branch}` : null,
      remoteUrl: branchPushed ? url : null,
      branch: wb.branch,
      path: wb.path,
    };
  }

  async function discard(id, typed) {
    const wb = store.get(id);
    if (String(typed == null ? "" : typed).trim() !== String(wb.task_id)) {
      throw refusal(`Type ${wb.task_id}, the task's number, to confirm. Nothing was thrown away.`, "CONFIRM");
    }
    const plan = await discardPlan(id);
    const top = await repoTopOf(wb);
    if (isDir(wb.path)) {
      const removed = await git.worktreeRemove(top || wb.path, wb.path, { force: true });
      if (!removed.ok) throw refusal(git.plain(removed, "git would not remove the folder."), "GIT");
    }
    if (top) await git.worktreePrune(top);
    let branchDeleted = false;
    if (!plan.branchPushed && top) {
      const holder = (await git.branchState(top, wb.branch)).checkedOutAt;
      if (!holder) branchDeleted = (await git.deleteBranch(top, wb.branch)).ok;
    }
    drop(wb.path);
    store.setState(wb.id, "discarded");
    const dropped = [];
    if (plan.unsaved.length) {
      const names = plan.unsaved.slice(0, 5).join(", ") + (plan.unsaved.length > 5 ? ", ..." : "");
      dropped.push(`${plural(plan.unsaved.length, "unsaved file", "unsaved files")} (${names})`);
    }
    if (branchDeleted && plan.commits.length) dropped.push(plural(plan.commits.length, "local commit", "local commits"));
    const kept = plan.branchPushed ? `; the branch is kept on the remote as ${plan.remote}` : branchDeleted ? "" : `; the branch ${wb.branch} is kept`;
    await note(wb.task_id, `discarded workbench: ${dropped.length ? `dropped ${dropped.join(", ")}` : "nothing unsaved was dropped"}${kept}`);
    store.audit(wb.task_id, "discarded workbench");
    return { discarded: true, branchDeleted, keptRemote: plan.remote, branch: wb.branch };
  }

  // ---------------------------------------------------------------------------
  // Missing folders

  /** Puts the folder back, on the branch it had. */
  async function recreate(id) {
    const wb = store.get(id);
    if (wb.state === "finished" || wb.state === "discarded") {
      throw refusal(`Workbench ${wb.id} for task ${wb.task_id} is already ${wb.state}. Start a new one instead.`, "CLOSED");
    }
    const top = await repoTopOf(wb);
    if (!top) throw refusal(`The repository at ${wb.repo_path} is not there any more, so there is nothing to recreate the folder from.`, "NO_REPO");
    await git.worktreePrune(top);
    const state = await git.branchState(top, wb.branch);
    const back = state.checkedOutAt && git.samePath(state.checkedOutAt, wb.path);
    if (state.checkedOutAt && !back) {
      throw refusal(`The branch ${wb.branch} is open in another folder now: ${state.checkedOutAt}. Open that one, or forget this Workbench.`,
        "CHECKED_OUT_ELSEWHERE", { path: state.checkedOutAt, branch: wb.branch });
    }
    if (!back) {
      if (isDir(wb.path) && !isEmptyDir(wb.path)) {
        throw refusal(`There is a folder at ${wb.path} that is not this Workbench. Move it, then recreate.`, "FOLDER_EXISTS", { path: wb.path });
      }
      if (!state.local && !state.remote) await git.fetchBranch(top, wb.branch);
      const again = await git.branchState(top, wb.branch);
      const mode = again.local ? "local" : again.remote ? "remote" : "new";
      const startPoint = await git.baseRef(top, wb.base);
      if (mode === "new" && !startPoint) throw refusal(`Neither the branch ${wb.branch} nor ${wb.base} exists any more.`, "NO_BASE");
      const added = await git.worktreeAdd(top, wb.path, { branch: wb.branch, startPoint, mode });
      if (!added.ok) throw refusal(git.plain(added, "git could not make the folder."), "GIT");
      const repoRow = store.repo(wb.repo_id);
      setupMod.copyFiles(top, wb.path, repoRow.copy_files ?? setupMod.DEFAULT_COPY);
    }
    drop(wb.path);
    const row = store.setState(wb.id, "active");
    await note(wb.task_id, `recreated workbench on ${wb.branch}`);
    store.audit(wb.task_id, "recreated workbench");
    return row;
  }

  /**
   * Stops tracking a Workbench whose folder is gone. Only then: one whose
   * folder is still there has work in it, and Finish or Discard is the honest
   * way to close it. The branch is left exactly as it is.
   */
  async function forgetBench(id) {
    const wb = store.get(id);
    if (wb.state === "finished" || wb.state === "discarded") return { forgotten: true };
    if (isDir(wb.path) && !isEmptyDir(wb.path)) {
      throw refusal(`The folder is still there (${wb.path}). Finish it or discard it instead, so nothing in it is lost by accident.`, "NOT_MISSING");
    }
    const top = await repoTopOf(wb);
    if (top) await git.worktreePrune(top);
    drop(wb.path);
    store.setState(wb.id, "discarded");
    await note(wb.task_id, `forgot workbench; the branch ${wb.branch} was left as it is`);
    store.audit(wb.task_id, "forgot workbench");
    return { forgotten: true };
  }

  // ---------------------------------------------------------------------------
  // Housekeeping

  /**
   * Squares the rows with what is on disk. Run on app start and on every
   * `delphi status`, so the list is never further wrong than one launch.
   *
   * - git worktree prune, so git forgets folders that were deleted by hand.
   * - A row whose folder is gone becomes Missing; one whose folder came back
   *   becomes active again.
   * - A worktree under a Workbench folder with no row is adopted when its
   *   branch is one Delphi would have made and its task is real; anything else
   *   is reported as found but not managed, and left alone.
   */
  async function housekeep() {
    const report = { pruned: 0, missing: [], restored: [], adopted: [], unmanaged: [] };
    const live = store.list({});
    const seenTops = new Set();
    for (const repoRow of store.allRepos()) {
      const rows = live.filter((w) => w.repo_id === Number(repoRow.id));
      const top0 = await git.toplevel(repoRow.path);
      const top = top0 ? ((await git.mainCheckout(top0)) || top0) : null;
      if (!top) {
        for (const row of rows) {
          if (row.state !== "missing" && !isDir(row.path)) {
            store.setState(row.id, "missing");
            report.missing.push(row.id);
          }
        }
        continue;
      }
      if (!seenTops.has(top)) {
        await git.worktreePrune(top);
        report.pruned++;
      }
      const trees = await git.worktreeList(top);
      const known = (p) => trees.some((t) => !t.prunable && git.samePath(t.path, p));
      for (const row of rows) {
        const present = isDir(row.path) && known(row.path);
        if (row.state !== "missing" && !present) {
          store.setState(row.id, "missing");
          drop(row.path);
          report.missing.push(row.id);
        } else if (row.state === "missing" && present) {
          store.setState(row.id, "active");
          drop(row.path);
          report.restored.push(row.id);
        }
      }
      if (seenTops.has(top)) continue;
      seenTops.add(top);

      const roots = [naming.rootFor({ repoTop: top })];
      const override = overrideDir();
      if (override) roots.push(naming.rootFor({ repoTop: top, overrideDir: override }));
      for (const tree of trees) {
        if (tree.bare || tree.prunable || git.samePath(tree.path, top)) continue;
        if (!roots.some((root) => inside(git.real(root), git.real(tree.path)))) continue;
        if (store.byPath(git.real(tree.path)) || store.byPath(tree.path)) continue;
        const m = /^(\d+)-/.exec(path.basename(tree.path));
        let adopted = null;
        if (m && tree.branch && naming.ADOPTABLE.test(tree.branch)) {
          let task = null;
          try { task = store.task(Number(m[1])); } catch {}
          if (task && Number(task.project_id) === Number(repoRow.project_id) && !store.live(task.id, repoRow.id)) {
            const base = repoRow.base_branch || await git.defaultBranch(top) || "main";
            try {
              adopted = store.insert({ taskId: task.id, repoId: repoRow.id, path: git.real(tree.path), branch: tree.branch, base });
              await note(task.id, `found the workbench on ${tree.branch} again and took it back`);
              store.audit(task.id, "adopted workbench");
              report.adopted.push(adopted.id);
            } catch {
              adopted = null;
            }
          }
        }
        if (!adopted) report.unmanaged.push({ path: tree.path, branch: tree.branch, repo: repoRow.name, repo_id: Number(repoRow.id) });
      }
    }
    unmanaged = report.unmanaged;
    return report;
  }

  /** The real names, for people learning what a Workbench is underneath. */
  function advanced(id) {
    const wb = store.get(id);
    const q = (p) => (/^[A-Za-z0-9_./:@-]+$/.test(p) ? p : `"${p.replace(/(["\\$`])/g, "\\$1")}"`);
    return {
      branch: wb.branch,
      path: wb.path,
      base: wb.base,
      repo: wb.repo_path,
      commands: [
        `cd ${q(wb.path)}`,
        `git -C ${q(wb.path)} status`,
        `git -C ${q(wb.path)} push --set-upstream origin ${wb.branch}`,
        `git -C ${q(wb.repo_path)} worktree list`,
        `git -C ${q(wb.repo_path)} worktree remove ${q(wb.path)}`,
      ],
      unmanaged: unmanaged.filter((u) => u.repo_id === wb.repo_id),
    };
  }

  return {
    candidates, start, status, forTask, list, park, resume, update, commit, push, pr,
    finish, discardPlan, discard, recreate, forget: forgetBench, housekeep, advanced,
    get: (id) => store.get(id), live: (taskId) => store.live(taskId),
  };
}

module.exports = { STATUS_TTL_MS, WINDOWS_PATH_LIMIT, createWorkbench };
