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
 * - Discard removes the folder, but keeps a copy of everything in it first
 *   (workbench/keep.js), so reaching it loses nothing for thirty days. It
 *   still needs the task's number typed back and lists what goes, and agents
 *   are still never offered it; but those are courtesies now, not the only
 *   thing between an agent and a week of work.
 * - A folder git cannot read is Unreadable, never Missing, and neither Finish
 *   nor Discard touches it: not being able to see what is in a folder is no
 *   reason to think nothing is.
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
const keep = require("./keep");

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

/** Up to five names, then how many more. */
function someOf(list, n = 5) {
  return list.slice(0, n).join(", ") + (list.length > n ? `, and ${list.length - n} more` : "");
}

function unreadableWords(wb, reason) {
  return `${reason} Finish and Discard leave the folder alone until git can read it again. It is at ${wb.path}.`;
}

/** The real top folder of a Workbench's repository, from its row, or from the folder itself. */
async function repoTopFor(git, wb) {
  const fromRow = await git.toplevel(wb.repo_path);
  if (fromRow) return (await git.mainCheckout(fromRow)) || fromRow;
  if (isDir(wb.path)) return git.mainCheckout(wb.path);
  return null;
}

/**
 * Everything Discard needs to know, read without a store, so the command line
 * can run Discard in its own process (see bin/delphi) and nothing that an
 * agent can reach over MCP ever removes a folder.
 *
 * keepPaths is the ignored files the copy takes; the plan a person is shown
 * leaves it out, since it can run to thousands of paths.
 */
async function inspectForDiscard(wb, { git = defaultGit } = {}) {
  if (wb.state === "finished" || wb.state === "discarded") {
    throw refusal(`Workbench ${wb.id} for task ${wb.task_id} is already ${wb.state}.`, "CLOSED");
  }
  const plan = {
    unsaved: [], commits: [], detached: [], ignored: [], notKept: [], operation: null,
    branchPushed: false, remote: null, remoteUrl: null, branch: wb.branch, path: wb.path,
    folderGone: !isDir(wb.path), unreadable: null, ref: keep.refFor("discarded", wb),
    until: keep.untilDate(), recover: null, top: null, keepPaths: [],
  };
  const top = await repoTopFor(git, wb);
  if (!top) {
    plan.unreadable = plan.folderGone
      ? `The repository at ${wb.repo_path} is not there any more, so there is nothing to keep a copy in. Forget this Workbench instead.`
      : `The repository at ${wb.repo_path} is not there any more, so there is nowhere to keep a copy of the folder. Nothing was thrown away.`;
    return plan;
  }
  plan.top = top;
  if (!plan.folderGone) {
    const st = await git.status(wb.path);
    if (!st.ok) { plan.unreadable = unreadableWords(wb, st.reason); return plan; }
    plan.unsaved = st.files;
    plan.detached = await git.lonelyCommits(wb.path);
    plan.operation = await git.operation(wb.path);
    const report = await keep.ignoredReport(git, wb.path, { main: top, copy: setupMod.copyList(wb.copy_files ?? setupMod.DEFAULT_COPY) });
    if (!report.ok) { plan.unreadable = unreadableWords(wb, report.reason); return plan; }
    plan.ignored = report.groups;
    plan.notKept = report.notKept;
    plan.keepPaths = report.keep;
  }
  // Asked of the remote itself when it answers, so a branch pushed from
  // another machine counts. Offline, the last known answer stands, which
  // errs towards keeping the branch.
  await git.fetchBranch(top, wb.branch);
  plan.branchPushed = await git.refExists(top, `refs/remotes/${git.REMOTE}/${wb.branch}`);
  plan.commits = await git.localOnlyCommits(top, wb.branch);
  plan.remote = plan.branchPushed ? `${git.REMOTE}/${wb.branch}` : null;
  plan.remoteUrl = plan.branchPushed ? await git.remoteUrl(top) : null;
  plan.recover = keep.recoverText({ ref: plan.ref, repo: top, folder: wb.path, branch: wb.branch, until: plan.until });
  return plan;
}

/** The plan as a person (or a window) is shown it. */
function publicPlan(plan) {
  const { keepPaths, top, ...shown } = plan;
  return shown;
}

/** What Discard would remove, and how to get it back, before anyone confirms. */
async function discardPlanFor(wb, opts = {}) {
  return publicPlan(await inspectForDiscard(wb, opts));
}

/**
 * Discard's git half: keep a copy, then remove the folder, then the branch if
 * it never reached a remote. Runs without a store, in the app's process or the
 * command line's, and never in the MCP server's. The caller records the result
 * (markDiscarded), which checks for itself that the folder is gone and the
 * copy is there before it believes a word of it.
 */
async function discardFolder(wb, { git = defaultGit } = {}) {
  const plan = await inspectForDiscard(wb, { git });
  if (plan.unreadable) throw refusal(plan.unreadable, "UNREADABLE");
  const snap = await keep.snapshot(git, {
    repo: plan.top, folder: plan.folderGone ? null : wb.path, branch: wb.branch, ref: plan.ref, keep: plan.keepPaths,
    message: `Kept by Delphi before discarding task ${wb.task_id}'s Workbench\n\nBranch: ${wb.branch}\nFolder: ${wb.path}\n`,
  });
  if (!snap.ok) throw refusal(`Could not keep a copy of the folder first: ${snap.reason} Nothing was thrown away.`, "NO_COPY");
  if (!plan.folderGone) {
    const removed = await git.worktreeRemove(plan.top, wb.path, { force: true });
    if (!removed.ok) {
      throw refusal(`${git.plain(removed, "git would not remove the folder.")} A copy is kept as ${snap.ref} all the same.`, "GIT", { ref: snap.ref });
    }
  } else {
    await git.forgetRegistration(plan.top, wb.path);
  }
  let branchDeleted = false;
  if (!plan.branchPushed && snap.tip) {
    const holder = (await git.branchState(plan.top, wb.branch)).checkedOutAt;
    if (!holder) branchDeleted = (await git.deleteBranch(plan.top, wb.branch, snap.tip)).ok;
  }
  return {
    discarded: true, branchDeleted, keptRemote: plan.remote, branch: wb.branch,
    ref: snap.ref, sha: snap.sha, until: plan.until, recover: plan.recover,
    unsaved: plan.unsaved.length, files: plan.unsaved.slice(0, 5),
    commits: plan.commits.length, detached: plan.detached.length,
    ignored: plan.ignored.reduce((n, g) => n + g.count, 0),
  };
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
        // A path names one of the project's own repositories by another
        // route, or nothing. Taking any repository on disk and adding it to
        // the project would let one call quietly attach a stranger's
        // checkout; that is the project settings' job, done on purpose.
        const top = await git.toplevel(path.resolve(wanted));
        if (top) {
          const main = (await git.mainCheckout(top)) || top;
          pick = list.find((c) => git.samePath(c.path, main)) || null;
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

  const repoTopOf = (wb) => repoTopFor(git, wb);

  // ---------------------------------------------------------------------------
  // Start

  async function start(taskId, { repoId = null, repo = null, path: given = null, runSetup = true, background = false } = {}) {
    const task = store.task(taskId);
    const { repo: repoRow, top } = await chooseRepo(task, { repoId, repo, path: given });
    const existing = store.live(task.id, repoRow.id);
    if (existing) return { workbench: existing, created: false, warnings: [], setup_entry: null };

    let made;
    try {
      made = await serial(top, () => create(task, repoRow, top));
    } catch (error) {
      // Two processes (the app and the command line, two agents) starting
      // the same task at once: whichever loses the race to git or to the
      // unique index fails here, and the answer it wanted is the winner's.
      const theirs = await awaitLive(task.id, repoRow.id, error);
      if (theirs) return { workbench: theirs, created: false, warnings: [], setup_entry: null };
      throw error;
    }
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

  // Codes a lost start race fails with. Anything else (no base branch, a
  // bare repository) is the real answer and is not worth waiting on.
  const RACY = new Set(["GIT", "FOLDER_EXISTS", "CHECKED_OUT_ELSEWHERE"]);

  async function awaitLive(taskId, repoId, error) {
    const racy = RACY.has(error && error.code) || /UNIQUE|constraint/i.test(String(error && error.message));
    const until = Date.now() + (racy ? 8000 : 0);
    for (;;) {
      const row = store.live(taskId, repoId) || store.live(taskId);
      if (row) return row;
      if (Date.now() >= until) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
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
      // A folder of this name that git still lists but that is gone (an
      // earlier Workbench removed by hand) would make the add fail. Only that
      // one registration is cleared, never the repository's others.
      await git.forgetRegistration(top, folder);
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
      words: "Missing", state: "missing", unsaved: 0, files: [], ahead: 0, behind: 0, lonely: 0, operation: null,
      base: wb.base, hasRemote: false, hasRemoteBranch: false, checkedAt: new Date().toISOString(),
    };
  }

  // Drawn like Missing by the window, but it is not: the folder is there and
  // may be full of work. It only means git cannot say what is in it.
  function unreadableStatus(wb, reason) {
    return { ...missingStatus(wb), words: "Unreadable", state: "unreadable", message: unreadableWords(wb, reason) };
  }

  async function statusOf(wb, { fresh = false } = {}) {
    if (wb.state === "finished" || wb.state === "discarded") {
      return { ...missingStatus(wb), words: wb.state === "finished" ? "Finished" : "Discarded", state: wb.state };
    }
    const hit = cache.get(wb.path);
    if (!fresh && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;

    let value;
    // The folder decides, not the row: a row marked missing whose folder is
    // back is read, and a folder that is there is never called Missing.
    const s = isDir(wb.path) ? await git.status(wb.path) : null;
    if (!s) {
      value = missingStatus(wb);
    } else if (!s.ok) {
      value = unreadableStatus(wb, s.reason);
    } else {
      const remote = await git.hasRemote(wb.path);
      const hasRemoteBranch = remote && await git.refExists(wb.path, `refs/remotes/${git.REMOTE}/${wb.branch}`);
      const operation = await git.operation(wb.path);
      // On no branch and no remote: a commit on a detached HEAD. Counted on
      // its own, because pushing the branch does not save it.
      const lonely = (await git.lonelyCommits(wb.path)).length;
      // Unshared means on no remote at all. With no remote there is nowhere to
      // share to, and the branch is kept by Finish, so nothing counts here.
      const ahead = remote ? Math.max(0, await git.countCommits(wb.path, ["HEAD", "--not", `--remotes=${git.REMOTE}`]) - lonely) : 0;
      const onto = await git.baseRef(wb.path, wb.base);
      const behind = onto ? await git.countCommits(wb.path, [`HEAD..${onto}`]) : 0;
      const parts = [];
      if (operation) parts.push(`In the middle of ${operation}`);
      if (s.unsaved) parts.push(plural(s.unsaved, "unsaved change", "unsaved changes"));
      if (ahead) parts.push(`${plural(ahead, "commit", "commits")} not shared yet`);
      if (lonely) parts.push(`${plural(lonely, "commit", "commits")} on no branch`);
      if (behind) parts.push(`${parts.length ? "behind" : "Behind"} ${wb.base} by ${behind}`);
      value = {
        words: parts.join(", ") || "Ready",
        state: operation ? "busy" : s.unsaved ? "unsaved" : ahead || lonely ? "unshared" : behind ? "behind" : "ready",
        unsaved: s.unsaved,
        files: s.files,
        ahead,
        lonely,
        operation,
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

  async function park(id) {
    const wb = requireOpen(store.get(id));
    if (wb.state === "parked") return wb;
    const row = store.setState(wb.id, "parked");
    await note(wb.task_id, `parked workbench on ${wb.branch}`);
    store.audit(wb.task_id, "parked workbench");
    return row;
  }

  /** Active again. A parked one whose folder went while it was parked is put back first. */
  async function resume(id) {
    const wb = store.get(id);
    if (wb.state !== "finished" && wb.state !== "discarded" && !isDir(wb.path)) return recreate(id);
    requireOpen(wb);
    if (wb.state === "active") return wb;
    const row = store.setState(wb.id, "active");
    await note(wb.task_id, `resumed workbench on ${wb.branch}`);
    store.audit(wb.task_id, "resumed workbench");
    return row;
  }

  async function update(id) {
    const wb = requireOpen(store.get(id));
    const before = await statusOf(wb, { fresh: true });
    if (before.state === "unreadable") return { ok: false, words: before.message, conflict: null };
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

  /**
   * What Finish would remove that git does not carry, for a surface to show
   * before it asks: ignored files that are not reproducible, and copied files
   * that differ from the main checkout's. Both need "these can go".
   */
  async function finishPlan(id) {
    const wb = requireOpen(store.get(id));
    const top = await repoTopOf(wb);
    const report = await keep.ignoredReport(git, wb.path, { main: top, copy: setupMod.copyList(wb.copy_files ?? setupMod.DEFAULT_COPY) });
    if (!report.ok) throw refusal(unreadableWords(wb, report.reason), "UNREADABLE");
    return {
      ignored: report.groups, files: report.files.map((f) => f.path), changedCopies: report.changedCopies,
      notKept: report.notKept, needsConfirm: report.files.length > 0, _report: report, _top: top,
    };
  }

  /**
   * Removes the folder once its work is safe, keeping the branch. Never
   * forces. Ignored files that are not reproducible (and copied files that
   * were changed) stop it until the caller passes ignoredOk, which is a
   * person saying "these can go"; even then a copy of them is kept under
   * refs/delphi/finished/ for thirty days.
   */
  async function finish(id, { ignoredOk = false } = {}) {
    const wb = requireOpen(store.get(id));
    const st = await statusOf(wb, { fresh: true });
    if (st.state === "unreadable") throw refusal(st.message, "UNREADABLE");
    if (st.operation) {
      throw refusal(`This folder is in the middle of ${st.operation}. Finish it or stop it there first: removing the folder now would lose it.`, "BUSY");
    }
    if (st.unsaved) {
      const shown = st.files.slice(0, 5).join(", ") + (st.files.length > 5 ? `, and ${st.files.length - 5} more` : "");
      throw refusal(`There ${st.unsaved === 1 ? "is" : "are"} ${plural(st.unsaved, "unsaved change", "unsaved changes")} in the Workbench (${shown}). Commit them first. Finish never puts work aside on its own.`,
        "UNSAVED", { files: st.files });
    }
    if (st.ahead) {
      throw refusal(`${plural(st.ahead, "commit is", "commits are")} not shared yet. Push first: Finish only removes a folder whose work is safe on the remote.`,
        "UNSHARED", { ahead: st.ahead });
    }
    if (st.lonely) {
      throw refusal(`${plural(st.lonely, "commit is", "commits are")} on no branch, made while the folder was not on ${wb.branch}. Removing the folder would lose ${st.lonely === 1 ? "it" : "them"}. Put ${st.lonely === 1 ? "it" : "them"} on the branch first.`,
        "LONELY", { lonely: st.lonely });
    }
    const plan = await finishPlan(id);
    const top = plan._top;
    if (!top) throw refusal(`The repository at ${wb.repo_path} is not there any more, so the folder was left in place.`, "NO_REPO");
    let kept = null;
    if (plan.needsConfirm) {
      if (!ignoredOk) {
        const names = plan.ignored.map((g) => (g.count > 1 || g.dir.endsWith("/") ? `${g.dir} (${plural(g.count, "file", "files")})` : g.dir));
        const changed = plan.changedCopies.length ? ` ${someOf(plan.changedCopies)} ${plan.changedCopies.length === 1 ? "differs" : "differ"} from the main checkout's copy.` : "";
        throw refusal(`The folder has files git does not keep: ${someOf(names)}.${changed} Finishing removes them. Say these can go to finish anyway (a copy is kept for ${keep.KEEP_DAYS} days), or move them out first.`,
          "IGNORED", { details: { ignored: plan.ignored, files: plan.files, changedCopies: plan.changedCopies, notKept: plan.notKept } });
      }
      const snap = await keep.snapshot(git, {
        repo: top, folder: wb.path, branch: wb.branch, ref: keep.refFor("finished", wb), keep: plan._report.keep,
        message: `Kept by Delphi before finishing task ${wb.task_id}'s Workbench\n\nBranch: ${wb.branch}\nFolder: ${wb.path}\n`,
      });
      if (!snap.ok) throw refusal(`Could not keep a copy of the ignored files first: ${snap.reason} Nothing was removed.`, "NO_COPY");
      kept = { ref: snap.ref, until: keep.untilDate() };
    }
    const removed = await git.worktreeRemove(top, wb.path);
    if (!removed.ok) throw refusal(git.plain(removed, "git would not remove the folder."), "GIT");
    drop(wb.path);
    store.setState(wb.id, "finished");
    const recover = kept ? keep.recoverText({ ref: kept.ref, repo: top, folder: wb.path, branch: wb.branch, until: kept.until }) : null;
    await note(wb.task_id, `finished workbench; the branch ${wb.branch} is kept${kept ? `. The files git does not keep were removed. ${recover}` : ""}`);
    store.audit(wb.task_id, "finished workbench");
    const task = store.task(wb.task_id);
    return { finished: true, taskStatus: task.status, branch: wb.branch, ref: kept && kept.ref, recover };
  }

  // ---------------------------------------------------------------------------
  // Discard

  /** What Discard would remove, and how to get it back, before anyone is asked to confirm it. */
  async function discardPlan(id) {
    return discardPlanFor(store.get(id), { git });
  }

  /**
   * Discard, in process: the git half (discardFolder) then the record. The
   * command line does the same two halves itself, the second through the
   * workbench_discarded tool.
   */
  async function discard(id, typed) {
    const wb = store.get(id);
    if (String(typed == null ? "" : typed).trim() !== String(wb.task_id)) {
      throw refusal(`Type ${wb.task_id}, the task's number, to confirm. Nothing was thrown away.`, "CONFIRM");
    }
    const done = await discardFolder(wb, { git });
    drop(wb.path);
    await markDiscarded(id, done);
    return done;
  }

  /**
   * Records a Discard that has already happened, after checking for itself
   * that it has: the folder is gone and the copy is in the repository under
   * this Workbench's own name. The command line calls it over MCP once it has
   * done the git half in its own process; nothing here removes anything, so
   * an agent that reaches it can only describe what a person already did.
   */
  async function markDiscarded(id, summary = {}) {
    const wb = store.get(id);
    if (wb.state === "discarded") return { discarded: true, already: true };
    if (wb.state === "finished") throw refusal(`Workbench ${wb.id} for task ${wb.task_id} is already finished.`, "CLOSED");
    const ref = keep.refFor("discarded", wb);
    if (summary.ref !== ref) throw refusal(`The copy of this Workbench is called ${ref}, not ${summary.ref}. Nothing was recorded.`, "NO_COPY");
    if (isDir(wb.path)) throw refusal(`The folder is still there (${wb.path}), so the Workbench was not marked discarded.`, "NOT_GONE");
    const top = await repoTopOf(wb);
    if (!top || !(await git.refExists(top, ref))) {
      throw refusal(`There is no copy at ${ref}, so the Workbench was not marked discarded.`, "NO_COPY");
    }
    const when = await git.run(top, ["log", "-1", "--format=%ct", ref]);
    const made = Number(when.ok ? when.stdout.trim() : NaN);
    const until = keep.untilDate(keep.KEEP_DAYS, Number.isFinite(made) ? made * 1000 : Date.now());
    const count = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Math.min(Number(v), 1e6) : 0);
    const files = (Array.isArray(summary.files) ? summary.files : []).slice(0, 5).map((f) => String(f).slice(0, 200));
    const unsaved = count(summary.unsaved);
    const parts = [];
    if (unsaved) parts.push(`${plural(unsaved, "unsaved file", "unsaved files")}${files.length ? ` (${files.join(", ")}${unsaved > files.length ? ", ..." : ""})` : ""}`);
    if (count(summary.commits)) parts.push(plural(count(summary.commits), "local commit", "local commits"));
    if (count(summary.detached)) parts.push(plural(count(summary.detached), "commit on no branch", "commits on no branch"));
    if (count(summary.ignored)) parts.push(plural(count(summary.ignored), "ignored file", "ignored files"));
    const branchDeleted = summary.branchDeleted === true;
    const pushed = await git.refExists(top, `refs/remotes/${git.REMOTE}/${wb.branch}`);
    const branchWords = pushed ? `the branch is kept on the remote as ${git.REMOTE}/${wb.branch}`
      : branchDeleted ? `the branch ${wb.branch} was deleted` : `the branch ${wb.branch} is kept`;
    drop(wb.path);
    store.setState(wb.id, "discarded");
    const recover = keep.recoverText({ ref, repo: top, folder: wb.path, branch: wb.branch, until });
    await note(wb.task_id, `discarded workbench with ${parts.length ? parts.join(", ") : "nothing unsaved in it"}; ${branchWords}. ${recover}`);
    store.audit(wb.task_id, "discarded workbench");
    return { discarded: true, ref, until, recover };
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
    await git.forgetRegistration(top, wb.path);
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
    if (top) await git.forgetRegistration(top, wb.path);
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
   * Only repositories that have had a Workbench are touched: a repository
   * Delphi merely knows about is the person's own business.
   *
   * - git worktree prune, for folders gone more than a week (a disk that is
   *   not mounted today is not a deleted folder), and kept copies past
   *   their thirty days are expired.
   * - An active row whose folder is gone becomes Missing, and active again
   *   when it comes back. A parked one stays parked either way: its status
   *   says Missing while the folder is away, and the person's choice to set
   *   it aside outlives a disk being unplugged.
   * - A folder that is there but that git cannot read is left as it is; its
   *   status says Unreadable.
   * - A worktree under a Workbench folder with no row is adopted when its
   *   branch is one Delphi would have made for that same task; anything
   *   else is reported as found but not managed, and left alone.
   */
  async function housekeep() {
    const report = { pruned: 0, missing: [], restored: [], adopted: [], unmanaged: [], expired: [] };
    const live = store.list({});
    const seenTops = new Set();
    for (const repoRow of store.reposInUse()) {
      const rows = live.filter((w) => w.repo_id === Number(repoRow.id));
      for (const row of rows) {
        const present = isDir(row.path);
        if (!present && row.state !== "missing") {
          if (row.state === "active") store.setState(row.id, "missing");
          drop(row.path);
          report.missing.push(row.id);
        } else if (present && row.state === "missing") {
          store.setState(row.id, "active");
          drop(row.path);
          report.restored.push(row.id);
        }
      }
      const top0 = await git.toplevel(repoRow.path);
      const top = top0 ? ((await git.mainCheckout(top0)) || top0) : null;
      if (!top || seenTops.has(top)) continue;
      seenTops.add(top);
      await git.worktreePrune(top);
      report.pruned++;
      report.expired.push(...await keep.expire(git, top));

      const trees = await git.worktreeList(top);
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
          if (task && Number(task.project_id) === Number(repoRow.project_id) && !store.live(task.id, repoRow.id)
              && branchIsFor(tree.branch, task)) {
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

  /**
   * Whether a branch names this task: its lead is the task's number, or its
   * ticket key. A folder called 12-something on a branch made for task 40 is
   * somebody's hand made worktree, and adopting it would hand task 12 another
   * task's work.
   */
  function branchIsFor(branch, task) {
    const lead = /^[^/]+\/((?:[A-Z][A-Z0-9]+-\d+)|\d+)-/.exec(branch);
    if (!lead) return false;
    if (/^\d+$/.test(lead[1])) return Number(lead[1]) === Number(task.id);
    return lead[1] === naming.ticketOf(task.ref);
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
    finishPlan: async (id) => { const { _report, _top, ...shown } = await finishPlan(id); return shown; },
    finish, discardPlan, discard, markDiscarded, recreate, forget: forgetBench, housekeep, advanced,
    get: (id) => store.get(id), live: (taskId) => store.live(taskId),
  };
}

module.exports = { STATUS_TTL_MS, WINDOWS_PATH_LIMIT, createWorkbench, discardPlanFor, discardFolder, repoTopFor };
