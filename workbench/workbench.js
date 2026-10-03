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

/** A Workbench part way through a Finish or Discard: nothing else may start on it. */
function closingRefusal(wb) {
  return refusal(`Task ${wb.task_id}'s Workbench is being put away (a ${wb.closing ? wb.closing.mode : "Finish or Discard"} is in progress). If that stopped part way, the next housekeeping (when the app starts, or delphi status) records it, reopens it, or marks it Missing, and the Sheet says which.`,
    "CLOSING", { details: { closing: wb.closing || null } });
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

const plural2 = (n, one, many) => (n === 1 ? one : many);

/**
 * What is in a folder that removing it would touch, read once and shared by
 * Finish and Discard: its status (hidden changes included), its ignored
 * files, and the two things no copy can hold, a repository inside it and a
 * path Delphi cannot read. blocked is the refusal when either is there; both
 * verbs throw it before they touch anything, which is what makes them all or
 * nothing.
 */
async function inspectFolder(git, wb, top) {
  const st = await git.status(wb.path);
  if (!st.ok) return { blocked: refusal(unreadableWords(wb, st.reason), "UNREADABLE") };
  const report = await keep.ignoredReport(git, wb.path, { main: top, copy: setupMod.copyList(wb.copy_files ?? setupMod.DEFAULT_COPY) });
  if (!report.ok) return { blocked: refusal(unreadableWords(wb, report.reason), "UNREADABLE") };
  // Untracked files are checked here too, before anything is touched, so
  // the refusal is the same whichever kind of file it is.
  const closedFiles = st.untracked.filter((f) => {
    if (f.endsWith("/")) return false;
    try { fs.accessSync(path.join(wb.path, f), fs.constants.R_OK); return false; } catch (e) { return e.code === "EACCES" || e.code === "EPERM"; }
  });
  const unreadable = [...new Set([...st.unreadable, ...report.unreadable, ...closedFiles])];
  const nested = keep.nestedRepos(wb.path, { gitlinks: st.gitlinks, untracked: st.untracked, report });
  let blocked = null;
  if (unreadable.length) {
    blocked = refusal(`Delphi cannot read ${someOf(unreadable)} in this folder (${plural2(unreadable.length, "its", "their")} permissions do not allow it), so it cannot keep a copy and will not remove the folder. Fix the permissions, or move ${plural2(unreadable.length, "it", "them")} out, first. Nothing was changed.`,
      "UNREADABLE", { details: { paths: unreadable } });
  } else if (nested.length) {
    // A submodule is put away with git submodule deinit, which keeps its
    // place in the repository; a repository that is merely inside the
    // folder is moved out.
    const subs = nested.submodules || [];
    const others = nested.filter((n) => !subs.includes(n));
    const how = [
      subs.length ? `run git submodule deinit ${subs.map((x) => x.replace(/\/$/, "")).join(" ")} in the folder (after committing and pushing any work in ${plural2(subs.length, "it", "them")})` : null,
      others.length ? `move ${someOf(others)} out` : null,
    ].filter(Boolean).join(", and ");
    blocked = refusal(`There ${plural2(nested.length, "is a git repository", "are git repositories")} inside this folder: ${someOf(nested)}. A copy cannot hold a repository's history or its uncommitted work, so the folder is left in place. First ${how}. Nothing was changed.`,
      "NESTED", { details: { nested: [...nested], submodules: subs } });
  }
  return { st, report, nested, unreadable, blocked, confirm: keep.confirmToken(report, wb.id) };
}

/**
 * What must be true just before a folder is moved aside: nothing Delphi
 * started is still running in it (a `$ ` run, a chat's command, a queue
 * runner's agent: busy is the store's list of them, in words), and git's
 * registration is not locked, which a person does on purpose.
 */
async function readyToMove(git, top, wb, busy) {
  if (busy && busy.length) {
    throw refusal(`Something is still running in this folder: ${someOf(busy)}. Stop it, or wait for it to finish, then try again. Nothing was changed.`,
      "BUSY", { details: { running: busy } });
  }
  const entry = (await git.worktreeList(top)).find((w) => w.path === wb.path || git.samePath(w.path, wb.path));
  if (entry && entry.locked) {
    throw refusal(`This folder is marked as locked${entry.lockReason ? ` (${entry.lockReason})` : ""}, so it was left in place. Unlock it first if it should go. Nothing was changed.`, "GIT");
  }
}

/**
 * Moves the folder aside once its copy is made: one rename, so it is gone
 * from where it was or still there whole, never half. The slow delete comes
 * later (emptyTrash), after the Workbench is recorded.
 */
async function moveFolderAside(git, top, wb, ref, done, { intent, cancel }) {
  // What housekeeping needs to finish the job if this process dies after
  // the move: how to record it, what to check it against, what to delete.
  const { trash: _t, ...manifest } = done;
  const to = keep.trashPath(wb.path, wb.id);
  // The intent goes on the row first (state closing, with the ref and where
  // the folder is going). That row, not anything on disk, is what lets
  // housekeeping finish this if the process dies after the move.
  await intent({ mode: done.mode, ref, trash: to });
  try {
    return await keep.moveAside(git, { repo: top, folder: wb.path, id: wb.id, to, manifest: { ...manifest, task_id: wb.task_id } });
  } catch (error) {
    try { await cancel(); } catch {}
    throw refusal(`Could not move the folder aside (${error.code || error.message}), so it is still there, whole. A copy is kept as ${ref} all the same.`,
      "GIT", { ref, details: { ref } });
  }
}

/** The refusal for files git does not keep, carrying the exact list and the token that agrees to it. */
function ignoredRefusal(look, verb) {
  const { report } = look;
  const names = report.groups.map((g) => (g.count > 1 || g.dir.endsWith("/") ? `${g.dir} (${plural(g.count, "file", "files")})` : g.dir));
  const changed = report.changedCopies.length ? ` ${someOf(report.changedCopies)} ${report.changedCopies.length === 1 ? "differs" : "differ"} from the main checkout's copy.` : "";
  const lost = report.notKept.length ? ` These cannot be kept and would be gone for good: ${someOf(report.notKept.map((n) => `${n.path} (${n.why})`))}.` : "";
  const what = names.length ? `The folder has files git does not keep: ${someOf(names)}.${changed}` : "Some files cannot be kept.";
  return refusal(`${what}${lost} ${verb === "finish" ? "Finishing" : "Discarding"} removes them. A person has to say these exact files can go${report.notKept.length ? "" : ` (a copy is kept for ${keep.KEEP_DAYS} days)`}, or move them out first. Nothing was changed.`,
    "IGNORED", { details: { ignored: report.groups, files: report.files.map((f) => f.path), changedCopies: report.changedCopies, notKept: report.notKept, confirm: look.confirm } });
}

/**
 * Everything Discard needs to know, read without a store, so the command line
 * can run Discard in its own process (see bin/delphi) and nothing that an
 * agent can reach over MCP ever removes a folder.
 *
 * keepPaths and the rest of the inspection stay out of the plan a person is
 * shown, since they can run to thousands of paths.
 */
async function inspectForDiscard(wb, { git = defaultGit } = {}) {
  if (wb.state === "finished" || wb.state === "discarded") {
    throw refusal(`Workbench ${wb.id} for task ${wb.task_id} is already ${wb.state}.`, "CLOSED");
  }
  if (wb.state === "closing") throw closingRefusal(wb);
  const plan = {
    unsaved: [], hidden: [], commits: [], detached: [], ignored: [], notKept: [], nested: [], operation: null,
    branchPushed: false, remote: null, remoteUrl: null, branch: wb.branch, path: wb.path,
    folderGone: !isDir(wb.path), unreadable: null, blocked: null, ref: keep.refFor("discarded", wb),
    until: keep.untilDate(), recover: null, confirm: null, top: null, look: null,
  };
  const top = await repoTopFor(git, wb);
  if (!top) {
    plan.unreadable = plan.folderGone
      ? `The repository at ${wb.repo_path} is not there any more, so there is nothing to keep a copy in. Forget this Workbench instead.`
      : `The repository at ${wb.repo_path} is not there any more, so there is nowhere to keep a copy of the folder. Nothing was thrown away.`;
    plan.blocked = { code: "UNREADABLE", message: plan.unreadable };
    return plan;
  }
  plan.top = top;
  if (!plan.folderGone) {
    const look = await inspectFolder(git, wb, top);
    plan.look = look;
    if (look.blocked) {
      plan.blocked = { code: look.blocked.code, message: look.blocked.message };
      if (look.blocked.code === "UNREADABLE") plan.unreadable = look.blocked.message;
      plan.nested = look.nested || [];
      if (!look.st) return plan;
    }
    plan.unsaved = look.st.files;
    plan.hidden = look.st.hidden;
    plan.detached = await git.lonelyCommits(wb.path);
    plan.operation = await git.operation(wb.path);
    plan.ignored = look.report.groups;
    plan.notKept = look.report.notKept;
    plan.confirm = look.confirm;
  }
  // Asked of the remote itself when it answers, so a branch pushed from
  // another machine counts. Offline, the last known answer stands, which
  // errs towards keeping the branch.
  await git.fetchBranch(top, wb.branch);
  plan.branchPushed = await git.refExists(top, `refs/remotes/${git.REMOTE}/${wb.branch}`);
  plan.commits = await git.localOnlyCommits(top, wb.branch);
  plan.remote = plan.branchPushed ? `${git.REMOTE}/${wb.branch}` : null;
  plan.remoteUrl = plan.branchPushed ? await git.remoteUrl(top) : null;
  plan.recover = await keep.recoverFor(git, { ref: plan.ref, repo: top, folder: wb.path, branch: wb.branch, id: wb.id, until: plan.until, notKept: plan.notKept });
  return plan;
}

/** The plan as a person (or a window) is shown it. */
function publicPlan(plan) {
  const { top, look, ...shown } = plan;
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
 *
 * confirm is the plan's token, and is required when anything would not be
 * kept: the person agreed to lose those exact files, and a list that changed
 * since is refused.
 */
/** Refuses a Finish or Discard that was not given a way to write its intent: see moveFolderAside. */
function needIntent(intent, cancel) {
  if (typeof intent !== "function" || typeof cancel !== "function") {
    throw new Error("Finish and Discard need intent and cancel, which write the closing state on the Workbench's row.");
  }
}

async function discardFolder(wb, { git = defaultGit, confirm = null, busy = [], intent = null, cancel = null } = {}) {
  needIntent(intent, cancel);
  const plan = await inspectForDiscard(wb, { git });
  if (plan.look && plan.look.blocked) throw plan.look.blocked;
  if (plan.blocked) throw refusal(plan.blocked.message, plan.blocked.code);
  if (plan.notKept.length && confirm !== plan.confirm) throw ignoredRefusal(plan.look, "discard");
  if (!plan.folderGone) await readyToMove(git, plan.top, wb, busy);
  const since = keep.volumeNow(wb.path);
  const snap = await keep.snapshot(git, {
    repo: plan.top, folder: plan.folderGone ? null : wb.path, branch: wb.branch, ref: plan.ref,
    keep: plan.look ? plan.look.report.keep : [], hidden: plan.hidden, expect: plan.look ? plan.look.st.untracked : [],
    message: `Kept by Delphi before discarding task ${wb.task_id}'s Workbench\n\nBranch: ${wb.branch}\nFolder: ${wb.path}\n\n${TRAILER}: ${Number(wb.id)}\n`,
  });
  if (!snap.ok) throw refusal(`Could not keep a copy of the folder first: ${snap.reason} Nothing was thrown away.`, "NO_COPY");
  const recover = snap.ref === plan.ref ? plan.recover
    : await keep.recoverFor(git, { ref: snap.ref, repo: plan.top, folder: wb.path, branch: wb.branch, id: wb.id, until: plan.until, notKept: plan.notKept });
  // The branch goes only after the Discard is recorded (markDiscarded):
  // until then the branch is one of the two ways back to the work.
  // Held by another folder means someone else is on it; this folder holding
  // it is expected, since it has not moved yet.
  const held = !plan.branchPushed && snap.tip ? (await git.branchState(plan.top, wb.branch)).checkedOutAt : null;
  const holder = held && !git.samePath(held, wb.path) ? held : null;
  const branchToDelete = !plan.branchPushed && snap.tip && !holder ? { branch: wb.branch, tip: snap.tip } : null;
  const done = {
    mode: "discard", discarded: true, branchDeleted: false, branchToDelete, keptRemote: plan.remote, branch: wb.branch,
    ref: snap.ref, sha: snap.sha, until: plan.until, recover,
    unsaved: plan.unsaved.length, files: plan.unsaved.slice(0, 5),
    commits: plan.commits.length, detached: plan.detached.length,
    ignored: plan.ignored.reduce((n, g) => n + g.count, 0),
    notKept: plan.notKept.map((n) => n.path),
    // For emptyTrash, once the Discard is recorded.
    trash: null, top: plan.top, tree: snap.sha, since, copy: setupMod.copyList(wb.copy_files ?? setupMod.DEFAULT_COPY),
  };
  if (!plan.folderGone) done.trash = await moveFolderAside(git, plan.top, wb, snap.ref, done, { intent, cancel });
  else {
    await intent({ mode: "discard", ref: snap.ref, trash: null });
    await git.forgetRegistration(plan.top, wb.path);
  }
  return done;
}

// The line every copy's commit message ends with, binding it to one
// Workbench. Housekeeping believes a .trash manifest's ref only when the
// commit it names says this, for the Workbench the manifest claims.
const TRAILER = "Delphi-Workbench";

/** Whether a ref is a copy Delphi made of this Workbench: its name and its commit's trailer. */
async function isOwnCopy(git, top, wb, ref, kind) {
  const base = keep.refFor(kind, wb);
  const name = String(ref || "");
  if (!(name === base || (name.startsWith(base) && /^-\d+$/.test(name.slice(base.length))))) return false;
  const body = await git.run(top, ["log", "-1", "--format=%B", name]);
  return body.ok && new RegExp(`^${TRAILER}: ${Number(wb.id)}$`, "m").test(body.stdout);
}

/**
 * Deletes a Discarded Workbench's branch, and only that: the branch named on
 * the row (never one a manifest names), only while it still points at tip,
 * only when tip is a parent of the copy (so its commits stay reachable from
 * the copy), and only when it never reached a remote and no folder has it.
 */
async function deleteKeptBranch(git, wb, top, ref, tip) {
  if (!tip || !top || !/^[0-9a-f]{40,64}$/.test(String(tip))) return false;
  if (await git.refExists(top, `refs/remotes/${git.REMOTE}/${wb.branch}`)) return false;
  const now = await git.run(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${wb.branch}^{commit}`]);
  if (!now.ok || now.stdout.trim() !== tip) return false;
  const parents = await git.run(top, ["rev-list", "--parents", "-n", "1", ref]);
  if (!parents.ok || !parents.stdout.trim().split(" ").slice(1).includes(tip)) return false;
  const held = (await git.branchState(top, wb.branch)).checkedOutAt;
  if (held) return false;
  return (await git.deleteBranch(top, wb.branch, tip)).ok;
}

/**
 * The last step of Finish and Discard, after they are recorded: delete the
 * folder that was moved aside, unless something in it changed after the
 * copy was made, in which case it is kept and where it is is returned.
 */
async function emptyMoved(done, { git = defaultGit } = {}) {
  if (!done || !done.trash) return { deleted: true, kept: null, changed: [] };
  return keep.emptyTrash(git, { repo: done.top, trash: done.trash, tree: done.tree, since: done.since, notKept: done.notKept || [], copy: done.copy || [] });
}

/**
 * Finish's git half, without a store, for the same reason as discardFolder:
 * removing ignored files is a person's call, so with them present it runs
 * only in the app's process or the command line's. Through MCP (no confirm)
 * it goes ahead only when nothing at all would be dropped.
 *
 * Refuses, changing nothing, on anything unsafe: unreadable or nested,
 * part way through a rebase or merge, unsaved (hidden changes included),
 * unshared, commits on no branch, and ignored files without the person's
 * token for that exact list.
 */
async function finishFolder(wb, { git = defaultGit, confirm = null, busy = [], intent = null, cancel = null } = {}) {
  needIntent(intent, cancel);
  if (wb.state === "finished" || wb.state === "discarded") {
    throw refusal(`Workbench ${wb.id} for task ${wb.task_id} is already ${wb.state}.`, "CLOSED");
  }
  if (wb.state === "closing") throw closingRefusal(wb);
  if (wb.state === "missing" || !isDir(wb.path)) {
    throw refusal(`The folder for task ${wb.task_id}'s Workbench is gone (${wb.path}). Recreate it, or forget it.`, "MISSING");
  }
  const top = await repoTopFor(git, wb);
  if (!top) throw refusal(`The repository at ${wb.repo_path} is not there any more, so the folder was left in place.`, "NO_REPO");
  const look = await inspectFolder(git, wb, top);
  if (look.blocked) throw look.blocked;
  const { st, report } = look;
  const midway = await git.operation(wb.path);
  if (midway) throw refusal(`This folder is in the middle of ${midway}. Finish it or stop it there first: removing the folder now would lose it.`, "BUSY");
  if (st.unsaved) {
    const hiddenWords = st.hidden.length
      ? ` ${someOf(st.hidden)} ${st.hidden.length === 1 ? "is a hidden change" : "are hidden changes"}: git was told not to look at ${st.hidden.length === 1 ? "that file" : "those files"} (assume-unchanged or skip-worktree), so an ordinary commit will not pick ${st.hidden.length === 1 ? "it" : "them"} up.`
      : "";
    throw refusal(`There ${st.unsaved === 1 ? "is" : "are"} ${plural(st.unsaved, "unsaved change", "unsaved changes")} in the Workbench (${someOf(st.files)}). Commit them first. Finish never puts work aside on its own.${hiddenWords}`,
      "UNSAVED", { files: st.files, details: { files: st.files, hidden: st.hidden } });
  }
  const lonely = (await git.lonelyCommits(wb.path)).length;
  const remote = await git.hasRemote(wb.path);
  const ahead = remote ? Math.max(0, await git.countCommits(wb.path, ["HEAD", "--not", `--remotes=${git.REMOTE}`]) - lonely) : 0;
  if (ahead) {
    throw refusal(`${plural(ahead, "commit is", "commits are")} not shared yet. Push first: Finish only removes a folder whose work is safe on the remote.`,
      "UNSHARED", { ahead });
  }
  if (lonely) {
    throw refusal(`${plural(lonely, "commit is", "commits are")} on no branch, made while the folder was not on ${wb.branch}. Removing the folder would lose ${lonely === 1 ? "it" : "them"}. Put ${lonely === 1 ? "it" : "them"} on the branch first.`,
      "LONELY", { lonely });
  }
  if (report.files.length && confirm !== look.confirm) throw ignoredRefusal(look, "finish");
  await readyToMove(git, top, wb, busy);
  // A copy every time, not only when ignored files go: it is what the moved
  // folder is checked against before it is deleted, so a file written after
  // these checks is noticed rather than lost.
  const since = keep.volumeNow(wb.path);
  const snap = await keep.snapshot(git, {
    repo: top, folder: wb.path, branch: wb.branch, ref: keep.refFor("finished", wb), keep: report.keep,
    expect: st.untracked, hidden: st.hidden,
    message: `Kept by Delphi before finishing task ${wb.task_id}'s Workbench\n\nBranch: ${wb.branch}\nFolder: ${wb.path}\n\n${TRAILER}: ${Number(wb.id)}\n`,
  });
  if (!snap.ok) throw refusal(`Could not keep a copy of the folder first: ${snap.reason} Nothing was removed.`, "NO_COPY");
  const until = keep.untilDate();
  const recover = await keep.recoverFor(git, { ref: snap.ref, repo: top, folder: wb.path, branch: wb.branch, id: wb.id, until, notKept: report.notKept });
  const done = {
    mode: "finish", finished: true, branch: wb.branch, ref: snap.ref, recover, removedIgnored: report.files.length > 0,
    notKept: report.notKept.map((n) => n.path), trash: null, top, tree: snap.sha, since,
    copy: setupMod.copyList(wb.copy_files ?? setupMod.DEFAULT_COPY),
  };
  done.trash = await moveFolderAside(git, top, wb, snap.ref, done, { intent, cancel });
  return done;
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
  // The app empties a moved-aside folder behind the call, since deleting a
  // big tree can take minutes; everyone else waits for it.
  trashInBackground = false,
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
  async function note(taskId, body, { by = null } = {}) {
    if (!sheet || typeof sheet.append !== "function") return null;
    // by: who it is from when that is not whoever this store was made for:
    // housekeeping finishing a closing, never put in a person's name.
    const who = by ? { author: by, authorType: "tool" } : {};
    try { return await sheet.append({ taskId, kind: "note", body, ...who }); } catch { return null; }
  }

  /**
   * The intent and its undo, for a Finish or Discard run here: the row goes
   * to closing (with the ref and the folder's destination) before anything
   * moves, and back to what it was if the move fails.
   */
  function intentFor(id) {
    const before = store.get(id).state;
    return {
      intent: async ({ mode, ref, trash }) => {
        const row = store.beginClosing(id, { mode, ref, trash });
        if (!row) throw closingRefusal(store.get(id));
        return row;
      },
      cancel: async () => store.cancelClosing(id, before),
    };
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
    if (existing && existing.state === "closing") throw closingRefusal(existing);
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
      try { store.updateRepo(repoRow.id, { setup_cmd: setupCmd, setup_cmd_detected: true }); } catch {}
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
      words: "Missing", state: "missing", unsaved: 0, files: [], hidden: [], ahead: 0, behind: 0, lonely: 0, operation: null,
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
    if (wb.state === "closing") {
      return { ...missingStatus(wb), words: "Being put away", state: "closing", closing: wb.closing || null };
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
      // Hidden changes are edits to files git was told not to look at
      // (assume-unchanged, skip-worktree): unsaved all the same, and named
      // apart because committing in the usual way does not pick them up.
      const hiddenCount = s.hidden.length;
      if (s.unsaved - hiddenCount) parts.push(plural(s.unsaved - hiddenCount, "unsaved change", "unsaved changes"));
      if (hiddenCount) parts.push(plural(hiddenCount, "hidden change", "hidden changes"));
      if (ahead) parts.push(`${plural(ahead, "commit", "commits")} not shared yet`);
      if (lonely) parts.push(`${plural(lonely, "commit", "commits")} on no branch`);
      if (behind) parts.push(`${parts.length ? "behind" : "Behind"} ${wb.base} by ${behind}`);
      value = {
        words: parts.join(", ") || "Ready",
        state: operation ? "busy" : s.unsaved ? "unsaved" : ahead || lonely ? "unshared" : behind ? "behind" : "ready",
        unsaved: s.unsaved,
        files: s.files,
        hidden: s.hidden,
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
    if (wb.state === "closing") throw closingRefusal(wb);
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
   * before it asks: ignored files that are not reproducible, copied files
   * that differ from the main checkout's, and what could not be kept even in
   * a copy. confirm is the token finish({ confirm }) needs for that exact
   * list; blocked says when Finish cannot go ahead at all (NESTED,
   * UNREADABLE), whatever is confirmed.
   */
  async function finishPlan(id) {
    const wb = requireOpen(store.get(id));
    const top = await repoTopOf(wb);
    if (!top) throw refusal(`The repository at ${wb.repo_path} is not there any more.`, "NO_REPO");
    const look = await inspectFolder(git, wb, top);
    if (!look.report) throw look.blocked;
    const { report } = look;
    return {
      ignored: report.groups, files: report.files.map((f) => f.path), changedCopies: report.changedCopies,
      notKept: report.notKept, needsConfirm: report.files.length > 0, confirm: look.confirm,
      nested: look.nested, unreadable: look.unreadable,
      blocked: look.blocked ? { code: look.blocked.code, message: look.blocked.message } : null,
    };
  }

  /**
   * Removes the folder once its work is safe, keeping the branch. Never
   * forces. Files git does not keep stop it until the caller passes the
   * confirm token finishPlan gave for them, which is a person saying "these
   * exact files can go"; a copy of what can be kept goes under
   * refs/delphi/finished/ for thirty days all the same.
   */
  async function finish(id, { confirm = null } = {}) {
    const wb = store.get(id);
    const done = await finishFolder(wb, { git, confirm, busy: busyIn(wb), ...intentFor(id) });
    drop(wb.path);
    const cleanup = await recordThenEmpty(wb, done, () => markFinished(id, done));
    const task = store.task(wb.task_id);
    return { ...shown(done), cleanup, taskStatus: task.status };
  }

  /** What is still running in a Workbench's folder, in words, from the store when it can say. */
  function busyIn(wb) {
    try { return typeof store.busyIn === "function" ? store.busyIn(wb) : []; } catch { return []; }
  }

  /** The verbs' results without the paths and ids only emptyTrash needs. */
  function shown(done) {
    const { trash, top, tree, since, copy, mode, branchToDelete, ...rest } = done;
    return rest;
  }

  /**
   * The verb's record and its empty, under the moved folder's lock, so a
   * housekeeping run at the same moment is shut out rather than racing it.
   * The record is conditional anyway (closing to closed): whoever is second
   * finds nothing to do and says nothing.
   */
  async function recordThenEmpty(wb, done, record) {
    let release = null;
    for (let i = 0; done.trash && !release && i < 300; i++) {
      release = keep.takeLock(done.trash);
      if (!release) await new Promise((r) => setTimeout(r, 100));
    }
    try {
      const recorded = await record();
      if (recorded && recorded.branchDeleted !== undefined) done.branchDeleted = recorded.branchDeleted === true;
      if (!done.trash) return { deleted: true, kept: null, changed: [] };
      if (trashInBackground) {
        const held = release;
        release = null;
        settle(wb, done, { locked: Boolean(held) }).finally(() => held && held()).catch(() => {});
        return { deleted: null, kept: null, changed: [], pending: true };
      }
      return await settle(wb, done, { locked: Boolean(release) });
    } finally {
      if (release) release();
    }
  }

  /**
   * Empties the folder a Finish or Discard moved aside, now that the verb is
   * recorded. When something in it changed after the copy, it is kept, and
   * the Sheet says where. In the background for the app; awaited otherwise.
   */
  async function settle(wb, done, { locked = false } = {}) {
    const result = done.trash
      ? await keep.emptyTrash(git, { repo: done.top, trash: done.trash, tree: done.tree, since: done.since, notKept: done.notKept || [], copy: done.copy || [], locked })
      : { deleted: true, kept: null, changed: [] };
    if (result.kept && !result.already) await note(wb.task_id, keptWords(result, done));
    return { deleted: result.deleted, kept: result.kept, changed: result.changed };
  }

  /**
   * The checks both records share: the row is closing, on this ref, the
   * folder is gone from its path, and the ref is a copy Delphi made of this
   * Workbench. Returns the repository's top, or a result saying it is done
   * already (someone else recorded it first).
   */
  async function checkClosing(wb, ref, kind) {
    if (wb.state === (kind === "finished" ? "finished" : "discarded")) return { already: true };
    if (wb.state !== "closing" || !wb.closing || wb.closing.ref !== ref) {
      throw refusal(`Workbench ${wb.id} for task ${wb.task_id} is not being ${kind === "finished" ? "finished" : "discarded"} with the copy ${ref || "(none)"}, so nothing was recorded.`, "NOT_CLOSING");
    }
    if (isDir(wb.path)) throw refusal(`The folder is still there (${wb.path}), so the Workbench was not marked ${kind}.`, "NOT_GONE");
    const top = await repoTopOf(wb);
    if (!top || !(await git.refExists(top, ref))) throw refusal(`There is no copy at ${ref}, so the Workbench was not marked ${kind}.`, "NO_COPY");
    if (!(await isOwnCopy(git, top, wb, ref, kind))) throw refusal(`${ref} is not a copy Delphi made of this Workbench, so nothing was recorded.`, "NO_COPY");
    return { top };
  }

  /**
   * Records a Finish that has already happened, after checking that the
   * folder is gone and, when a copy was made, that it is there. Like
   * markDiscarded, nothing here removes anything.
   */
  async function markFinished(id, summary = {}, { by = null } = {}) {
    const wb = store.get(id);
    if (wb.state === "discarded") throw refusal(`Workbench ${wb.id} for task ${wb.task_id} is already discarded.`, "CLOSED");
    const ref = String(summary.ref || "");
    const checked = await checkClosing(wb, ref, "finished");
    if (checked.already) return { finished: true, already: true };
    const { top } = checked;
    const notKept = (Array.isArray(summary.notKept) ? summary.notKept : []).slice(0, 1000).map((f) => String(f).slice(0, 300));
    const recover = await keep.recoverFor(git, { ref, repo: top, folder: wb.path, branch: wb.branch, id: wb.id, until: keep.untilDate(), notKept });
    const removedIgnored = summary.removedIgnored === true || notKept.length > 0;
    drop(wb.path);
    // Closing to finished on this ref, or nothing: the second to arrive
    // writes no note and no audit row.
    if (!store.completeClosing(wb.id, "finished", ref)) return { finished: true, already: true };
    await note(wb.task_id, `finished workbench; the branch ${wb.branch} is kept${removedIgnored ? `. The files git does not keep were removed. ${recover}` : ""}${by ? ` (finished by ${by}, from the Finish ${wb.closing.actor || "someone"} began)` : ""}`, { by });
    store.audit(wb.task_id, "finished workbench", by);
    return { finished: true, recover };
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
  async function discard(id, typed, { confirm = null } = {}) {
    const wb = store.get(id);
    if (String(typed == null ? "" : typed).trim() !== String(wb.task_id)) {
      throw refusal(`Type ${wb.task_id}, the task's number, to confirm. Nothing was thrown away.`, "CONFIRM");
    }
    const done = await discardFolder(wb, { git, confirm, busy: busyIn(wb), ...intentFor(id) });
    drop(wb.path);
    const cleanup = await recordThenEmpty(wb, done, () => markDiscarded(id, done));
    return { ...shown(done), cleanup };
  }

  /**
   * Records a Discard that has already happened, after checking for itself
   * that it has: the folder is gone and the copy is in the repository under
   * this Workbench's own name. The command line calls it over MCP once it has
   * done the git half in its own process; nothing here removes anything, so
   * an agent that reaches it can only describe what a person already did.
   */
  async function markDiscarded(id, summary = {}, { by = null } = {}) {
    const wb = store.get(id);
    if (wb.state === "finished") throw refusal(`Workbench ${wb.id} for task ${wb.task_id} is already finished.`, "CLOSED");
    const ref = String(summary.ref || "");
    const checked = await checkClosing(wb, ref, "discarded");
    if (checked.already) return { discarded: true, already: true };
    const { top } = checked;
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
    drop(wb.path);
    // Closing to discarded on this ref, or nothing: the second to arrive
    // writes no note, no audit row, and deletes no branch.
    if (!store.completeClosing(wb.id, "discarded", ref)) return { discarded: true, already: true };
    // The branch goes after the record and before the note, so the note says
    // what happened rather than what was meant to.
    const tip = summary.branchToDelete && summary.branchToDelete.tip || summary.branchTip || null;
    const branchDeleted = await deleteKeptBranch(git, wb, top, ref, tip);
    const pushed = await git.refExists(top, `refs/remotes/${git.REMOTE}/${wb.branch}`);
    const branchWords = pushed ? `the branch is kept on the remote as ${git.REMOTE}/${wb.branch}`
      : branchDeleted ? `the branch ${wb.branch} was deleted` : `the branch ${wb.branch} is kept`;
    const notKept = (Array.isArray(summary.notKept) ? summary.notKept : []).slice(0, 1000).map((f) => String(f).slice(0, 300));
    const recover = await keep.recoverFor(git, { ref, repo: top, folder: wb.path, branch: wb.branch, id: wb.id, until, notKept });
    await note(wb.task_id, `discarded workbench with ${parts.length ? parts.join(", ") : "nothing unsaved in it"}; ${branchWords}. ${recover}${by ? ` (finished by ${by}, from the Discard ${wb.closing.actor || "someone"} began)` : ""}`, { by });
    store.audit(wb.task_id, "discarded workbench", by);
    return { discarded: true, ref, until, recover, branchDeleted };
  }

  // ---------------------------------------------------------------------------
  // Missing folders

  /** Puts the folder back, on the branch it had. */
  async function recreate(id) {
    const wb = store.get(id);
    if (wb.state === "closing") throw closingRefusal(wb);
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
    // A closing one may be forgotten once its moved folder is gone too: a
    // person's explicit choice, recorded as theirs. While the moved folder
    // is there, housekeeping records it from its copy instead.
    if (wb.state === "closing") {
      const c = wb.closing || {};
      if ((c.trash && fs.existsSync(c.trash)) || isDir(wb.path)) throw closingRefusal(wb);
      store.cancelClosing(wb.id, "missing");
    }
    // Forgetting never deletes a folder a Finish or Discard moved aside; the
    // note says where it is, so it is not left unexplained.
    const aside = trashFor(wb).map((e) => e.trash);
    if (isDir(wb.path) && !isEmptyDir(wb.path)) {
      throw refusal(`The folder is still there (${wb.path}). Finish it or discard it instead, so nothing in it is lost by accident.`, "NOT_MISSING");
    }
    const top = await repoTopOf(wb);
    if (top) await git.forgetRegistration(top, wb.path);
    drop(wb.path);
    store.setState(wb.id, "discarded");
    await note(wb.task_id, `forgot workbench; the branch ${wb.branch} was left as it is${aside.length ? `. A folder it was moved to is still at ${aside.join(", ")}; delete it yourself when you are sure` : ""}`);
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
    const report = { pruned: 0, missing: [], restored: [], adopted: [], unmanaged: [], expired: [], trashed: [], reconciled: [], keptTrash: [] };
    const live = store.list({});
    const seenTops = new Set();
    for (const repoRow of store.reposInUse()) {
      const rows = live.filter((w) => w.repo_id === Number(repoRow.id));
      for (const row of rows) {
        if (row.state === "closing") {
          await settleStuckClosing(row, report);
          continue;
        }
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
      // Folders a Finish or Discard moved aside and could not delete then:
      // tried again here, inside .trash and nowhere else.
      const trashRoots = new Set(roots);
      for (const row of store.list({ includeClosed: true })) if (row.repo_id === Number(repoRow.id)) trashRoots.add(path.dirname(row.path));
      for (const root of trashRoots) await sweepTrash(root, report);
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
   * A row left closing by a process that died. Its folder back where it was
   * and nothing in .trash means the move never happened: it is open again.
   * A Discard of a folder that was already gone (no trash) is recorded from
   * its copy, as housekeeping's doing. Anything with a .trash entry is the
   * sweep's to finish.
   */
  async function settleStuckClosing(row, report) {
    const c = row.closing || {};
    const aside = Boolean(c.trash && fs.existsSync(c.trash));
    if (!aside && isDir(row.path)) {
      if (store.cancelClosing(row.id, "active")) {
        drop(row.path);
        await note(row.task_id, `a ${c.mode || "Finish or Discard"} of this Workbench did not get as far as moving the folder, so it is open again, as it was`, { by: "housekeeping" });
        report.reopened = [...(report.reopened || []), row.id];
      }
      return;
    }
    // Without its copy there is nothing to record a Finish or Discard from:
    // the row goes back to Missing, which Recreate or Forget can take from
    // there, and the Sheet says where the moved folder is.
    const top = await repoTopOf(row);
    const kind = c.mode === "finish" ? "finished" : "discarded";
    const good = Boolean(top && c.ref && await git.refExists(top, c.ref) && await isOwnCopy(git, top, row, c.ref, kind));
    if (!good) {
      if (store.cancelClosing(row.id, "missing")) {
        drop(row.path);
        if (aside) { try { fs.writeFileSync(`${c.trash}.noted`, "the copy is gone\n"); } catch {} }
        await note(row.task_id, `a ${c.mode || "Finish or Discard"} of this Workbench stopped part way and its copy (${c.ref || "none"}) is gone, so nothing was recorded. ` +
          (aside ? `The folder is at ${c.trash}: look through it, then Recreate or Forget this Workbench.` : "Its folder is gone too: Forget this Workbench, or Recreate it from its branch."), { by: "housekeeping" });
        report.unstuck = [...(report.unstuck || []), row.id];
      }
      return;
    }
    // The person deleted the moved folder: the copy holds everything that
    // was in it, so the Finish or Discard is recorded from that.
    if (!aside) {
      const hint = c.trash ? hintFor(row, keep.readManifest(c.trash)) : {};
      try {
        const r = c.mode === "finish"
          ? await markFinished(row.id, { ref: c.ref, notKept: hint.notKept, removedIgnored: hint.removedIgnored }, { by: "housekeeping" })
          : await markDiscarded(row.id, { ...hint.summary, ref: c.ref, notKept: hint.notKept, branchToDelete: hint.tip ? { tip: hint.tip } : null }, { by: "housekeeping" });
        if (!r.already) {
          report.reconciled.push(row.id);
          if (c.trash) await note(row.task_id, `the moved folder (${c.trash}) was already gone, so the record above is from the copy ${c.ref}, which holds what was in it`, { by: "housekeeping" });
        }
        if (c.trash) { try { fs.unlinkSync(`${c.trash}.json`); } catch {} }
      } catch {}
    }
  }

  /** What a manifest adds, when it names this row: never the repository, branch or folder. */
  function hintFor(row, m) {
    const ok = m && Number(m.workbench) === Number(row.id) && Number(m.task_id) === Number(row.task_id)
      && m.folder && (m.folder === row.path || git.samePath(m.folder, row.path));
    if (!ok) return {};
    return {
      notKept: Array.isArray(m.notKept) ? m.notKept.map(String) : [],
      removedIgnored: m.removedIgnored === true,
      tip: m.branchToDelete && typeof m.branchToDelete.tip === "string" ? m.branchToDelete.tip : null,
      summary: { unsaved: m.unsaved, files: m.files, commits: m.commits, detached: m.detached, ignored: m.ignored },
    };
  }

  /**
   * A closing row whose moved folder cannot be emptied (it changed after
   * the copy, or does not match it): the Finish or Discard is recorded from
   * the row's own copy, signed housekeeping, and the folder kept for good,
   * since the copy and the folder together hold everything.
   */
  async function recordAndKeep(row, trash, why, report, done = null) {
    const c = row.closing || {};
    const hint = hintFor(row, keep.readManifest(trash));
    try { fs.writeFileSync(`${trash}.kept`, `Kept: ${why}\n`); } catch {}
    let r;
    try {
      r = c.mode === "finish"
        ? await markFinished(row.id, { ref: c.ref, notKept: hint.notKept, removedIgnored: hint.removedIgnored }, { by: "housekeeping" })
        : await markDiscarded(row.id, { ...hint.summary, ref: c.ref, notKept: hint.notKept, branchToDelete: hint.tip ? { tip: hint.tip } : null }, { by: "housekeeping" });
    } catch {
      return false;
    }
    if (!r.already) {
      report.reconciled.push(row.id);
      report.keptTrash.push(trash);
      await note(row.task_id, `kept the old folder at ${trash}: ${why}, so it was not deleted. Nothing is lost: the copy ${c.ref} and this folder together hold everything. ` +
        "It is cut loose from git (its .git file is now .git.was); compare it with the copy put back beside it, then delete it yourself.", { by: "housekeeping" });
    }
    void done;
    return true;
  }

  /**
   * Finishes what a Finish or Discard started and did not see through: the
   * folder was moved into .trash, and then the process died.
   *
   * The manifest beside an entry is a hint, never authority: anyone with a
   * shell can write one. What is acted on comes from the database row
   * (repository, branch, folder) and from git (the copy, which must be one
   * Delphi made of this Workbench, by its trailer). An entry is believed only
   * when its manifest names this row's own folder, its .git.was points at
   * this Workbench's own registration, every file in the copy is in it, and
   * nothing in it differs from the copy. Anything else: nothing is recorded,
   * nothing deleted, and the task's Sheet says once where the folder is.
   *
   * One entry at a time, under its lock, with the row read again after the
   * lock is taken, so two housekeeping runs (or the app emptying one while a
   * terminal's housekeeping looks) never both record, note or delete.
   */
  async function sweepTrash(root, report) {
    for (const entry of keep.trashEntries(root)) {
      if (entry.kept) continue;
      let row = null;
      try { row = store.find(entry.id); } catch {}
      if (!row) continue;
      const release = keep.takeLock(entry.trash);
      if (!release) continue;
      try {
        if (!fs.existsSync(entry.trash) || fs.existsSync(`${entry.trash}.kept`)) continue;
        row = store.get(row.id);
        // Only the row says what this folder is: a Finish or Discard wrote
        // its destination there before moving it. An entry no row claims is
        // not acted on, whatever its manifest says.
        const owned = Boolean(row.closing && row.closing.trash && (row.closing.trash === entry.trash || git.samePath(row.closing.trash, entry.trash)));
        if (!owned) {
          await unrecognised(row, entry.trash, "no Finish or Discard of this Workbench put it there");
          report.unrecognised = [...(report.unrecognised || []), entry.trash];
          continue;
        }
        const open = row.state !== "finished" && row.state !== "discarded";
        if (open && isDir(row.path)) continue;
        // A delete that was checked and started, then stopped (a file it
        // could not remove): finished off once the row is closed and the
        // copy is still this Workbench's own.
        if (!open && fs.existsSync(`${entry.trash}.deleting`)) {
          const m = keep.readManifest(entry.trash) || {};
          const top = await repoTopOf(row);
          const kind = row.state === "finished" ? "finished" : "discarded";
          if (top && await isOwnCopy(git, top, row, row.closing.ref, kind)) {
            try {
              keep.deleteTree(entry.trash);
              for (const ext of [".json", ".deleting"]) { try { fs.unlinkSync(`${entry.trash}${ext}`); } catch {} }
              report.trashed.push(entry.trash);
            } catch {}
          }
          continue;
        }
        const trust = await recognise(row, entry.trash, keep.readManifest(entry.trash));
        if (!trust.ok) {
          // A closing row whose copy is good (settleStuckClosing has already
          // dealt with one whose copy is not) is recorded from that copy and
          // the folder kept, never deleted: the two together hold everything.
          if (row.state === "closing" && await recordAndKeep(row, entry.trash, trust.why, report)) continue;
          await unrecognised(row, entry.trash, trust.why);
          report.unrecognised = [...(report.unrecognised || []), entry.trash];
          continue;
        }
        const done = trust.done;
        if (open) {
          // Emptied only when the moved folder is exactly the copy. One that
          // changed after it is recorded all the same, and kept.
          const changed = await keep.changedSince(git, { repo: done.top, trash: done.trash, tree: done.tree, since: done.since, notKept: done.notKept, copy: done.copy });
          if (changed.length) {
            await recordAndKeep(row, entry.trash, `${someOf(changed)} in it changed after the copy was made`, report, done);
            continue;
          }
          try {
            // Recorded as housekeeping's doing, never in the name of whoever
            // began it: they did not see it through.
            const r = done.mode === "finish"
              ? await markFinished(row.id, { ref: done.ref, notKept: done.notKept, removedIgnored: done.removedIgnored }, { by: "housekeeping" })
              : await markDiscarded(row.id, { ...done.summary, ref: done.ref, notKept: done.notKept, branchToDelete: done.branchToDelete }, { by: "housekeeping" });
            if (!r.already) report.reconciled.push(row.id);
          } catch {
            continue;
          }
        } else if (done.mode === "discard" && row.state === "discarded" && done.branchToDelete) {
          // Recorded, then the process died before the branch went.
          if (await deleteKeptBranch(git, row, done.top, done.ref, done.branchToDelete.tip)) {
            await note(row.task_id, `deleted the branch ${row.branch}, which the Discard meant to; its commits are in ${done.ref}`);
          }
        }
        const result = await keep.emptyTrash(git, { repo: done.top, trash: done.trash, tree: done.tree, since: done.since, notKept: done.notKept, copy: done.copy, locked: true });
        if (result.kept) {
          if (!result.already) await note(row.task_id, keptWords(result, done));
          report.keptTrash.push(result.kept);
        } else if (result.deleted) {
          report.trashed.push(entry.trash);
        }
      } finally {
        release();
      }
    }
  }

  /**
   * Whether a .trash entry is what its manifest says, checked against the
   * row and git. Returns the facts to act on, all row derived, or why not.
   */
  async function recognise(row, trash, manifest) {
    // The row decides what this is and which copy it is checked against;
    // the manifest only adds what the row has no room for (files agreed
    // lost, the counts for the note, the branch's tip), and only when it
    // names this same Workbench and folder.
    const hint = manifest && Number(manifest.workbench) === Number(row.id) && Number(manifest.task_id) === Number(row.task_id)
      && manifest.folder && (manifest.folder === row.path || git.samePath(manifest.folder, row.path)) ? manifest : {};
    const mode = row.closing.mode === "finish" ? "finish" : "discard";
    const top = await repoTopOf(row);
    if (!top) return { ok: false, why: "its repository is not there" };
    const ref = String(row.closing.ref || "");
    if (!(await git.refExists(top, ref)) || !(await isOwnCopy(git, top, row, ref, mode === "finish" ? "finished" : "discarded"))) {
      return { ok: false, why: "the copy its Finish or Discard made is missing, or is not one Delphi made of this Workbench" };
    }
    // Its .git file, renamed when it was moved, must point at this
    // Workbench's own registration under the repository's git folder.
    let gitdir = "";
    try { gitdir = (/^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(trash, ".git.was"), "utf8")) || [])[1] || ""; } catch {}
    const common = await git.run(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const own = common.ok && gitdir
      && git.samePath(path.dirname(gitdir.trim()), path.join(common.stdout.trim(), "worktrees"))
      && new RegExp(`^${path.basename(row.path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d*$`).test(path.basename(gitdir.trim()));
    if (!own) return { ok: false, why: "it was not moved there from this Workbench" };
    const tree = (await git.run(top, ["rev-parse", `${ref}^{tree}`])).stdout.trim();
    const ct = Number((await git.run(top, ["log", "-1", "--format=%ct", ref])).stdout.trim());
    // A manifest cannot push the check's start past the copy's own time.
    const since = Math.min(Number(hint.since) || 0, Number.isFinite(ct) ? ct * 1000 : 0);
    const listed = await git.runWith(top, ["ls-tree", "-r", "-z", "--name-only", ref], { timeout: 10 * 60000 });
    const missing = listed.stdout.split("\0").filter(Boolean).filter((p) => { try { fs.lstatSync(path.join(trash, p)); return false; } catch { return true; } });
    if (missing.length) return { ok: false, why: `${someOf(missing)} from the copy ${missing.length === 1 ? "is" : "are"} not in it` };
    const notKept = (Array.isArray(hint.notKept) ? hint.notKept : []).map((n) => String(n));
    const tip = hint.branchToDelete && typeof hint.branchToDelete.tip === "string" ? hint.branchToDelete.tip : null;
    return {
      ok: true,
      done: {
        mode, ref, top, tree, since, trash, notKept, wb: row,
        copy: setupMod.copyList(row.copy_files ?? setupMod.DEFAULT_COPY),
        removedIgnored: hint.removedIgnored === true,
        branchToDelete: mode === "discard" && tip ? { branch: row.branch, tip } : null,
        summary: { unsaved: hint.unsaved, files: hint.files, commits: hint.commits, detached: hint.detached, ignored: hint.ignored },
      },
    };
  }

  /** Says once, on the row's task, that a folder is in .trash that this cannot vouch for. */
  async function unrecognised(row, trash, why) {
    const marker = `${trash}.noted`;
    if (fs.existsSync(marker)) return;
    try { fs.writeFileSync(marker, `${why}\n`); } catch {}
    await note(row.task_id, `found a folder at ${trash} that Delphi cannot vouch for (${why}), so nothing was recorded and nothing deleted. ` +
      "Look through it; if it is this Workbench's work, move it back or keep what you need, then delete it yourself.");
  }

  /** .trash entries for a Workbench, which Forget must not leave behind unexplained. */
  function trashFor(row) {
    return keep.trashEntries(path.dirname(row.path)).filter((e) => e.id === Number(row.id));
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
    finishPlan,
    finish, markFinished, discardPlan, discard, markDiscarded, recreate, intent: intentFor, forget: forgetBench, housekeep, advanced,
    get: (id) => store.get(id), live: (taskId) => store.live(taskId),
  };
}

/** The Sheet's words for a moved folder kept because it changed after the copy. */
function keptWords(result, done) {
  return `kept the old folder at ${result.kept}: ${someOf(result.changed)} changed after the copy was made, so it was not deleted. ` +
    `It is cut loose from git (its .git file is now .git.was), so git run inside it touches no Workbench. ` +
    `To see what differs, put the copy back beside it with the command in the note above (it is ${done.ref}) and compare the two folders, ` +
    `for example with diff -ru; then delete the old folder yourself.`;
}

module.exports = { STATUS_TTL_MS, WINDOWS_PATH_LIMIT, createWorkbench, discardPlanFor, discardFolder, finishFolder, emptyMoved, keptWords, repoTopFor };
