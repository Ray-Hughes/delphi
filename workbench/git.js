/**
 * The git a Workbench needs, and nothing a person ever reads raw.
 *
 * Built on the root git.js: the same binary lookup, the same argv-only
 * spawning (never a shell, so a path with a quote in it is just a path), the
 * same GIT_TERMINAL_PROMPT=0 so a remote that wants a password fails instead
 * of hanging. What this adds is the worktree half, and plain(): git's errors
 * turned into a sentence someone who has never heard of a worktree can act on,
 * because the whole point of a Workbench is that they never have to.
 *
 * Every function resolves rather than rejects on a git failure unless it says
 * otherwise. The caller decides what a failure means, as in git.js.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const core = require("../git");

// A fetch or a push crosses a network, so it gets a budget measured in what a
// slow VPN needs rather than what a local read does.
const NETWORK_TIMEOUT = 90000;
const WRITE_TIMEOUT = 60000;
const REMOTE = "origin";

const run = (dir, args, { timeout, write = false } = {}) => core.runGit(dir, args, { timeout, write });
const text = (result) => (result.ok ? result.stdout.trim() : "");

/**
 * runGit with an environment and a stdin, which keeping a copy of a folder
 * needs: a temporary index named in GIT_INDEX_FILE, and a list of paths fed on
 * stdin so that no path is ever a command line word. Otherwise the same rules
 * as runGit: argv only, no prompts, resolves rather than rejects.
 */
function runWith(dir, args, { env = {}, input = null, timeout = WRITE_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    const bin = core.findGit();
    if (!bin) {
      resolve({ ok: false, code: null, stdout: "", stderr: "git was not found on this machine" });
      return;
    }
    const child = spawn(bin, ["-C", String(dir), ...args], {
      stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, code: null, stdout, stderr: String(e.message || e) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) resolve({ ok: false, code: null, stdout, stderr: `git did not finish within ${timeout}ms` });
      else resolve({ ok: code === 0, code, stdout, stderr });
    });
    if (input != null) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

/** The real path of something that exists, else the path resolved. git reports real paths. */
function real(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function samePath(a, b) {
  if (!a || !b) return false;
  return real(a) === real(b);
}

// ---------------------------------------------------------------------------
// What kind of folder this is

async function toplevel(dir) {
  if (!dir) return null;
  try { if (!fs.statSync(dir).isDirectory()) return null; } catch { return null; }
  const top = text(await run(dir, ["rev-parse", "--show-toplevel"]));
  return top ? real(top) : null;
}

/**
 * The main checkout for any folder in a repository, linked worktrees included.
 * Two candidates that are the same repository seen through different folders
 * must count as one, or Start would ask "which one?" about a single repo.
 */
async function mainCheckout(dir) {
  const common = text(await run(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (!common) return null;
  return path.basename(common) === ".git" ? real(path.dirname(common)) : real(common);
}

async function isBare(dir) {
  return text(await run(dir, ["rev-parse", "--is-bare-repository"])) === "true";
}

async function isLinkedWorktree(dir) {
  const own = text(await run(dir, ["rev-parse", "--path-format=absolute", "--git-dir"]));
  const common = text(await run(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  return Boolean(own && common) && real(own) !== real(common);
}

/** Worktrees and submodules interact badly, so Start warns rather than pretending. */
function hasSubmodules(repoTop) {
  try { return fs.statSync(path.join(repoTop, ".gitmodules")).isFile(); } catch { return false; }
}

async function hasRemote(repo, name = REMOTE) {
  const out = await run(repo, ["remote"]);
  return out.ok && out.stdout.split("\n").map((s) => s.trim()).includes(name);
}

async function refExists(repo, ref) {
  return (await run(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).ok;
}

/** origin/HEAD, then main, then master, then whatever is checked out. */
async function defaultBranch(repo) {
  const head = text(await run(repo, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${REMOTE}/HEAD`]));
  if (head && head.startsWith(`${REMOTE}/`)) return head.slice(REMOTE.length + 1);
  for (const name of ["main", "master"]) {
    if (await refExists(repo, `refs/heads/${name}`) || await refExists(repo, `refs/remotes/${REMOTE}/${name}`)) return name;
  }
  return text(await run(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"])) || null;
}

/** What to start from or compare with: the remote's copy of base when there is one. */
async function baseRef(repo, base) {
  if (await refExists(repo, `refs/remotes/${REMOTE}/${base}`)) return `${REMOTE}/${base}`;
  if (await refExists(repo, `refs/heads/${base}`)) return base;
  return null;
}

// ---------------------------------------------------------------------------
// Talking to the remote

/**
 * Brings base up to date from origin. Never throws and never fails Start: no
 * remote, no network and a VPN that is down all mean "work from the local
 * copy", which is what a person on a train wants.
 */
async function fetch(repo, base) {
  if (!(await hasRemote(repo))) return { ok: false, offline: true, noRemote: true, reason: "this repository has no remote" };
  const result = await run(repo, ["fetch", "--quiet", "--no-tags", REMOTE, base], { timeout: NETWORK_TIMEOUT, write: true });
  if (result.ok) return { ok: true, offline: false };
  return { ok: false, offline: true, reason: plain(result, "the fetch failed") };
}

/**
 * Fetches one branch into its remote-tracking ref, so a branch that exists only
 * on the remote (pushed from another machine) is found and reused rather than
 * shadowed by a new one of the same name. A branch the remote does not have is
 * the ordinary answer, so the result is ignored.
 */
async function fetchBranch(repo, branch) {
  if (!(await hasRemote(repo))) return false;
  const result = await run(repo, ["fetch", "--quiet", "--no-tags", REMOTE,
    `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`], { timeout: NETWORK_TIMEOUT, write: true });
  return result.ok;
}

async function remoteUrl(repo) {
  return text(await run(repo, ["remote", "get-url", REMOTE])) || null;
}

// ---------------------------------------------------------------------------
// Worktrees

/**
 * Every worktree git knows about, from `worktree list --porcelain -z`.
 *
 * -z for the reason git.js gives: paths are literal and never quoted. Each
 * worktree is a run of NUL-terminated attribute lines ended by an empty one.
 */
function parseWorktrees(out) {
  const list = [];
  let current = null;
  for (const line of String(out).split("\0")) {
    if (!line) {
      if (current) list.push(current);
      current = null;
      continue;
    }
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1);
    if (key === "worktree") {
      if (current) list.push(current);
      current = { path: value, branch: null, head: null, bare: false, detached: false, locked: false, prunable: false };
    } else if (current) {
      if (key === "HEAD") current.head = value;
      else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "bare") current.bare = true;
      else if (key === "detached") current.detached = true;
      else if (key === "locked") current.locked = true;
      else if (key === "prunable") current.prunable = true;
    }
  }
  if (current) list.push(current);
  return list;
}

async function worktreeList(repo) {
  const result = await run(repo, ["worktree", "list", "--porcelain", "-z"]);
  return result.ok ? parseWorktrees(result.stdout) : [];
}

/** Whether a branch exists here, on the remote, and which folder has it checked out. */
async function branchState(repo, branch) {
  const local = await refExists(repo, `refs/heads/${branch}`);
  const remote = await refExists(repo, `refs/remotes/${REMOTE}/${branch}`);
  const holder = (await worktreeList(repo)).find((w) => w.branch === branch && !w.prunable);
  return { local, remote, checkedOutAt: holder ? holder.path : null };
}

// Two Starts in one repository at once, from two agents in two processes, race
// for .git/worktrees and the ref locks. The in-process queue in workbench.js
// stops it within a process; across processes git's own lock is the arbiter,
// and losing it is worth a short wait and another go rather than an error.
const LOCKED = /index\.lock|could not lock|cannot lock ref|unable to create .*\.lock|File exists/i;

async function withLockRetry(fn, tries = 4) {
  let result;
  for (let i = 0; i < tries; i++) {
    result = await fn();
    if (result.ok || !LOCKED.test(`${result.stderr}\n${result.stdout}`)) return result;
    await new Promise((r) => setTimeout(r, 250 * (i + 1) + Math.floor(Math.random() * 200)));
  }
  return result;
}

/**
 * Adds the folder.
 *
 *   mode "new"     a new branch from startPoint, not tracking it: the branch's
 *                  upstream is set by its first push, so ahead and behind mean
 *                  "against my own remote branch", never "against main"
 *   mode "local"   an existing local branch
 *   mode "remote"  a branch that only the remote has, tracking it
 */
async function worktreeAdd(repo, dir, { branch, startPoint, mode }) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const args = mode === "local" ? ["worktree", "add", dir, branch]
    : mode === "remote" ? ["worktree", "add", "--track", "-b", branch, dir, `${REMOTE}/${branch}`]
    : ["worktree", "add", "--no-track", "-b", branch, dir, startPoint];
  return withLockRetry(() => run(repo, args, { timeout: WRITE_TIMEOUT, write: true }));
}

async function worktreeRemove(repo, dir, { force = false } = {}) {
  const args = ["worktree", "remove", ...(force ? ["--force", "--force"] : []), dir];
  return withLockRetry(() => run(repo, args, { timeout: WRITE_TIMEOUT, write: true }));
}

/**
 * Forgets folders git still lists but that are gone. Only ones gone for more
 * than a week: a folder on a disk that is not mounted right now, or a network
 * share that is down, looks exactly like a deleted one, and pruning it would
 * cost the person their worktree the next time the disk comes back.
 */
async function worktreePrune(repo, { expire = "1.week.ago" } = {}) {
  return run(repo, ["worktree", "prune", `--expire=${expire}`], { timeout: WRITE_TIMEOUT, write: true });
}

/**
 * Forgets one folder git still lists but that is gone, and nothing else. For
 * the verbs that know which folder they mean (Recreate, Forget, Discard,
 * Start into a folder name that was used before), where a repository wide
 * prune would sweep up other people's folders too. A locked registration is
 * left alone: someone locked it on purpose.
 */
async function forgetRegistration(repo, dir) {
  const entry = (await worktreeList(repo)).find((w) => w.path === dir || samePath(w.path, dir));
  if (!entry || !entry.prunable || entry.locked) return { ok: true, removed: false };
  const result = await run(repo, ["worktree", "remove", "--force", entry.path], { timeout: WRITE_TIMEOUT, write: true });
  return { ok: result.ok, removed: result.ok };
}

// ---------------------------------------------------------------------------
// Status

/**
 * Changed paths and the branch line, from porcelain v2 with -z. The counts
 * parser in git.js is reused for the header; the paths are read here because
 * Discard and Finish have to name the files, not just count them.
 */
function parseStatusFiles(out) {
  const files = [];
  const conflicted = [];
  const untracked = [];
  const records = String(out).split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record || record.startsWith("# ")) continue;
    const kind = record[0];
    // Fields before the path: 8 for "1", 9 for "2" (the score), 10 for "u".
    const skip = kind === "1" ? 8 : kind === "2" ? 9 : kind === "u" ? 10 : kind === "?" ? 1 : -1;
    if (skip < 0) continue;
    let at = 0;
    for (let n = 0; n < skip; n++) at = record.indexOf(" ", at) + 1;
    const file = record.slice(at);
    files.push(file);
    if (kind === "u") conflicted.push(file);
    if (kind === "?") untracked.push(file);
    if (kind === "2") i++;   // the original path of a rename is its own record
  }
  return { files, conflicted, untracked };
}

/**
 * The index entries git has been told not to look at (assume-unchanged,
 * lower case tags, and skip-worktree, S), and the gitlinks (mode 160000:
 * submodules), from one `ls-files -v -s`.
 */
function parseIndexFlags(out) {
  const flagged = [];
  const gitlinks = [];
  for (const record of String(out).split("\0")) {
    if (!record) continue;
    const m = /^(\S) (\d{6}) ([0-9a-f]+) \d\t([\s\S]*)$/.exec(record);
    if (!m) continue;
    const [, tag, mode, sha, file] = m;
    if (mode === "160000") gitlinks.push(file);
    const assume = tag !== tag.toUpperCase();
    const skip = tag.toUpperCase() === "S";
    if (assume || skip) flagged.push({ file, sha, assume, skip });
  }
  return { flagged, gitlinks };
}

/**
 * Changes git does not report because it was told not to look: a file
 * marked assume-unchanged or skip-worktree whose content is no longer what
 * the index says. status never lists them, worktree remove deletes them, and
 * a snapshot taken from the real index would leave them out, so they are
 * found here by hashing the files themselves. A skip-worktree file that is
 * simply absent is a sparse checkout doing its job, not a change.
 */
async function hiddenChanges(dir, flagged) {
  const present = [];
  const hidden = [];
  for (const f of flagged) {
    let exists = false;
    try { exists = fs.lstatSync(path.join(dir, f.file)).isFile(); } catch {}
    if (exists) present.push(f);
    else if (f.assume && !f.skip) hidden.push(f.file);
  }
  if (present.length) {
    const r = await runWith(dir, ["hash-object", "--stdin-paths"], { input: present.map((f) => f.file).join("\n") + "\n", timeout: WRITE_TIMEOUT });
    const shas = r.ok ? r.stdout.split("\n").map((l) => l.trim()) : [];
    present.forEach((f, i) => { if (shas[i] !== f.sha) hidden.push(f.file); });
  }
  return hidden;
}

/**
 * The folder's status, or ok:false with a plain reason when git cannot read
 * it. A folder whose own top is somewhere else (its .git file was deleted, so
 * git walked up and found some enclosing repository) counts as unreadable
 * too: reading the enclosing one would describe somebody else's files.
 */
async function status(dir) {
  const top = await run(dir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { ok: false, reason: plain(top, UNREADABLE, { strict: true }) };
  if (!samePath(top.stdout.trim(), dir)) {
    return { ok: false, reason: "This folder is no longer a checkout of its own: git finds a different repository around it." };
  }
  const result = await run(dir, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  if (!result.ok) return { ok: false, reason: plain(result, UNREADABLE, { strict: true }) };
  const head = core.parseStatus(result.stdout);
  const { files, conflicted, untracked } = parseStatusFiles(result.stdout);
  const index = await run(dir, ["ls-files", "-v", "-s", "-z"]);
  if (!index.ok) return { ok: false, reason: plain(index, UNREADABLE, { strict: true }) };
  const { flagged, gitlinks } = parseIndexFlags(index.stdout);
  const hidden = flagged.length ? await hiddenChanges(dir, flagged) : [];
  // Folders git could not open are skipped with only a warning, and status
  // still succeeds: what is in them is unknown, which is not the same as
  // nothing. Kept, so Finish and Discard can refuse rather than guess.
  const unreadable = [...String(result.stderr).matchAll(/could not open directory '([^']+)'/g)].map((m) => m[1]);
  return {
    ok: true,
    branch: head.branch,
    detached: head.detached,
    upstream: head.upstream,
    ahead: head.ahead,
    behind: head.behind,
    files: [...files, ...hidden.filter((f) => !files.includes(f))],
    conflicted,
    untracked,
    hidden,
    flagged: flagged.map((f) => f.file),
    gitlinks,
    unreadable,
    unsaved: files.length + hidden.filter((f) => !files.includes(f)).length,
  };
}

const UNREADABLE = "Git cannot read this folder.";

// The operations a person can be part way through, by the file git keeps
// while one is. Asked by path rather than guessed, because a linked
// worktree keeps them in its own git folder, not the main one.
const OPERATIONS = [
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase"],
  ["MERGE_HEAD", "a merge"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
  ["sequencer", "a cherry-pick or revert"],
  ["BISECT_LOG", "a bisect"],
];

/** The operation the folder is part way through, in words ("a rebase"), or null. */
async function operation(dir) {
  const result = await run(dir, ["rev-parse", "--path-format=absolute", ...OPERATIONS.flatMap(([p]) => ["--git-path", p])]);
  if (!result.ok) return null;
  const paths = result.stdout.split("\n");
  for (let i = 0; i < OPERATIONS.length; i++) {
    if (paths[i] && fs.existsSync(paths[i].trim())) return OPERATIONS[i][1];
  }
  return null;
}

/**
 * Commits the folder's HEAD has that no branch and no remote has: what a
 * commit on a detached HEAD, or one left behind by a rebase stopped part way,
 * looks like. Removing the folder loses them, because HEAD is the only thing
 * pointing at them and HEAD goes with the folder.
 */
async function lonelyCommits(dir) {
  const result = await run(dir, ["log", "-z", "--format=%H%x1f%s", "HEAD", "--not", "--branches", "--remotes"]);
  if (!result.ok) return [];
  return result.stdout.split("\0").filter(Boolean).map((r) => {
    const [sha, subject] = r.split("\x1f");
    return { sha: sha.trim(), subject: subject || "" };
  });
}

/**
 * Files git ignores, as git lists them: a folder that is ignored as a whole
 * comes back once, with a trailing slash, rather than file by file, so a
 * node_modules costs one line here instead of a hundred thousand.
 */
async function ignoredPaths(dir) {
  const result = await run(dir, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
  if (!result.ok) return { ok: false, reason: plain(result, UNREADABLE, { strict: true }), paths: [] };
  return { ok: true, paths: result.stdout.split("\0").filter(Boolean) };
}

async function countCommits(dir, args) {
  const n = Number(text(await run(dir, ["rev-list", "--count", ...args])));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Commits on a branch that exist nowhere else: on no remote and on no other
 * local branch. This is what Discard would destroy by deleting the branch, so
 * it is what Discard lists.
 */
async function localOnlyCommits(repo, branch) {
  const result = await run(repo, ["log", "-z", "--format=%H%x1f%s", branch, "--not",
    // --exclude takes the name without refs/heads/ when it applies to --branches.
    `--exclude=${branch}`, "--branches", "--remotes"]);
  if (!result.ok) return [];
  return result.stdout.split("\0").filter(Boolean).map((r) => {
    const [sha, subject] = r.split("\x1f");
    return { sha: sha.trim(), subject: subject || "" };
  });
}

// ---------------------------------------------------------------------------
// Changing things

async function commitAll(dir, message) {
  return core.commit(dir, message, { all: true });
}

async function push(dir, branch) {
  if (!(await hasRemote(dir))) {
    return { ok: false, reason: "This repository has no remote called origin, so there is nowhere to push to." };
  }
  const result = await run(dir, ["push", "--set-upstream", REMOTE, `refs/heads/${branch}:refs/heads/${branch}`],
    { timeout: NETWORK_TIMEOUT, write: true });
  return result.ok ? { ok: true, reason: null } : { ok: false, reason: plain(result, "The push failed.") };
}

/**
 * Brings in the latest from base by rebasing onto it. On a conflict the rebase
 * is aborted, so the folder is exactly as it was, and the files that clashed
 * are named. Leaving someone mid-rebase is leaving them in git's least
 * explicable state, which is the one place a Workbench must never put them.
 */
async function pullRebase(dir, base) {
  // A rebase, merge or bisect the person started themselves is theirs to
  // finish. Starting another on top would fail anyway, and the abort below
  // would then throw away the one they were part way through, amended
  // commits and all.
  const busy = await operation(dir);
  if (busy) {
    return { ok: false, conflict: false, files: [], offline: false,
      reason: `This folder is in the middle of ${busy}. Finish it or stop it there first; nothing was changed.` };
  }
  const fetched = await fetch(dir, base);
  const onto = await baseRef(dir, base);
  if (!onto) return { ok: false, conflict: false, files: [], reason: `There is no branch called ${base} to update from.`, offline: fetched.offline };
  const result = await run(dir, ["-c", "core.editor=true", "rebase", onto], { timeout: WRITE_TIMEOUT, write: true });
  if (result.ok) return { ok: true, conflict: false, files: [], reason: null, offline: fetched.offline };
  const now = await status(dir);
  const files = now.ok ? now.conflicted : [];
  // Nothing was in progress a moment ago, so a rebase in progress now is the
  // one this call started, and only that one is ever aborted.
  if (await operation(dir) === "a rebase") await run(dir, ["rebase", "--abort"], { timeout: WRITE_TIMEOUT, write: true });
  return {
    ok: false,
    conflict: files.length > 0,
    files,
    offline: fetched.offline,
    reason: files.length
      ? `Your changes and the latest ${base} both change ${files.join(", ")}. Nothing was changed; resolve it in the folder with git rebase ${onto}, or ask for help.`
      : plain(result, `Could not bring in the latest ${base}.`),
  };
}

/**
 * Deletes a local branch, but only if it still points where the caller last
 * saw it. Discard has already kept that commit, so a branch that moved since
 * (someone committed to it in another folder) is left alone rather than lost.
 */
async function deleteBranch(repo, branch, expected) {
  const args = expected ? ["update-ref", "-d", `refs/heads/${branch}`, expected] : ["branch", "-D", branch];
  return run(repo, args, { timeout: WRITE_TIMEOUT, write: true });
}

// ---------------------------------------------------------------------------
// Pull requests

/**
 * The host's "compare and open a pull request" page, built from the remote URL.
 * Known hosts only: a guessed URL on an unknown host is a 404 that looks like
 * Delphi's fault. GitHub Enterprise and self-hosted GitLab are recognised by
 * name, which is how they are almost always named.
 */
function compareUrl(remote, base, branch) {
  if (!remote) return null;
  let host;
  let repoPath;
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(remote);
  if (scp) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    try {
      const u = new URL(remote);
      if (!/^(https?|ssh|git):$/.test(u.protocol)) return null;
      host = u.hostname;
      repoPath = u.pathname;
    } catch {
      return null;
    }
  }
  repoPath = repoPath.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (!host || !repoPath.includes("/")) return null;
  const enc = (s) => s.split("/").map(encodeURIComponent).join("/");
  if (/github/i.test(host)) return `https://${host}/${repoPath}/compare/${enc(base)}...${enc(branch)}?expand=1`;
  if (/gitlab/i.test(host)) {
    return `https://${host}/${repoPath}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(branch)}&merge_request[target_branch]=${encodeURIComponent(base)}`;
  }
  if (/bitbucket/i.test(host)) return `https://${host}/${repoPath}/pull-requests/new?source=${encodeURIComponent(branch)}&dest=${encodeURIComponent(base)}`;
  return null;
}

let ghCache = null;

/** Whether the GitHub CLI is installed and signed in. DELPHI_GH=none says it is not. */
function gh() {
  if (process.env.DELPHI_GH === "none") return { available: false, authed: false, path: null };
  if (ghCache) return ghCache;
  const candidates = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh",
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, process.platform === "win32" ? "gh.exe" : "gh"))];
  const found = candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
  if (!found) return (ghCache = { available: false, authed: false, path: null });
  let authed = false;
  try {
    execFileSync(found, ["auth", "status"], { stdio: "ignore", timeout: 10000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
    authed = true;
  } catch {}
  return (ghCache = { available: true, authed, path: found });
}

/** Opens a pull request with gh, or finds the one already open for the branch. */
async function prCreate(dir, { base, branch, title, body }) {
  const tool = gh();
  if (!tool.available || !tool.authed) return { ok: false, url: null, reason: "The GitHub CLI is not installed or not signed in." };
  const { spawn } = require("child_process");
  const runGh = (args) => new Promise((resolve) => {
    const child = spawn(tool.path, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), NETWORK_TIMEOUT);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, stdout: out, stderr: String(e.message) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout: out, stderr: err }); });
  });
  const existing = await runGh(["pr", "view", branch, "--json", "url", "--jq", ".url"]);
  if (existing.ok && /^https?:\/\//.test(existing.stdout.trim())) return { ok: true, url: existing.stdout.trim(), reason: null };
  const made = await runGh(["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body || ""]);
  const url = (made.stdout.match(/https?:\/\/\S+/) || [])[0];
  if (made.ok && url) return { ok: true, url, reason: null };
  return { ok: false, url: null, reason: core.reasonFrom(made, "gh could not open the pull request.") };
}

// ---------------------------------------------------------------------------
// Words

// git's message, matched, and what a person should be told instead. First match
// wins, so the specific ones come before the general.
const PLAIN = [
  [/locked working tree(?:, lock reason: ([^\n]+))?|is locked|worktree.*locked/i,
    (m) => `This folder is marked as locked${m[1] ? ` (${m[1].trim()})` : ""}, so it was left in place. Unlock it first if it should go.`],
  [/dubious ownership|safe\.directory/i, () => "This folder belongs to another user account, so git will not read it until it is marked safe."],
  [/index file (?:smaller than expected|corrupt)|bad (?:index file )?signature|bad index version|unable to read index|index uses .* extension/i,
    () => "Git's record of what is in this folder is damaged, so it cannot tell what has changed."],
  [/gitdir file points to non-existent location|not a git repository|invalid gitfile|gitdir/i,
    () => "That folder is not a git repository, or git's link to it is broken."],
  [/unable to (?:read|write) (?:tree|object)|loose object .* is corrupt|object file .* is empty|missing (?:blob|tree|commit)|bad object/i,
    () => "Part of the repository's history is damaged or missing."],
  [/submodules? .*(?:cannot|can't)|containing submodules|cannot be (?:moved or )?removed/i,
    () => "This folder has submodules in it, which git will not remove on its own. Remove them first."],
  [/unable to create temporary file|read-only file system|insufficient permission/i,
    () => "Git does not have permission to write in this folder or its repository."],
  [/is already (?:checked out|used by worktree) at '([^']+)'/i, (m) => `That branch is already open in another folder: ${m[1]}.`],
  [/a branch named '([^']+)' already exists/i, (m) => `A branch called ${m[1]} already exists.`],
  [/'([^']+)' already exists/i, (m) => `There is already something at ${m[1]}.`],
  [/index\.lock|could not lock|cannot lock ref/i, () => "Another git command is busy in this repository. Wait for it to finish and try again."],
  [/could not resolve host|unable to access|network is unreachable|connection (?:refused|timed out)|could not read from remote/i,
    () => "Could not reach the remote. Check the network or VPN and try again."],
  [/open\("([^"]+)"\): Permission denied|could not open directory '([^']+)'|unable to (?:index|read|stat) file '?([^'\n]+)/i,
    (m) => `Delphi cannot read ${(m[1] || m[2] || m[3] || "a file").trim()} in this folder (its permissions do not allow it), so nothing was changed.`],
  [/permission denied|authentication failed|could not read username|403/i,
    () => "The remote refused your credentials. Sign in to git for this remote and try again."],
  [/\[rejected\]|non-fast-forward|fetch first|updates were rejected/i,
    () => "The remote has commits this branch does not. Update from the base first, then push again."],
  [/couldn't find remote ref|invalid refspec|not a valid object name|unknown revision/i,
    () => "That branch does not exist on the remote."],
  [/contains modified or untracked files/i, () => "The folder still has changes in it, so it was left in place."],
  [/git was not found/i, () => "git is not installed, or Delphi cannot find it. Install git and try again."],
];

/**
 * git's failure as a sentence someone new to git can act on. strict gives the
 * fallback rather than git's own first line when nothing matches, for the
 * places (status, above all) where a person must never see git's words.
 */
function plain(result, fallback, { strict = false } = {}) {
  const raw = `${result && result.stderr || ""}\n${result && result.stdout || ""}`;
  for (const [pattern, say] of PLAIN) {
    const m = pattern.exec(raw);
    if (m) return say(m);
  }
  if (strict) return fallback;
  const reason = core.reasonFrom(result || {}, fallback);
  return reason.replace(/^(fatal|error): /i, "").replace(/^\w/, (c) => c.toUpperCase());
}

module.exports = {
  REMOTE, real, samePath, run, runWith,
  toplevel, mainCheckout, isBare, isLinkedWorktree, hasSubmodules, hasRemote, refExists, defaultBranch, baseRef,
  fetch, fetchBranch, remoteUrl,
  parseWorktrees, worktreeList, branchState, worktreeAdd, worktreeRemove, worktreePrune, forgetRegistration,
  parseStatusFiles, parseIndexFlags, status, operation, lonelyCommits, ignoredPaths, countCommits, localOnlyCommits,
  commitAll, push, pullRebase, deleteBranch,
  compareUrl, gh, prCreate, plain,
};
