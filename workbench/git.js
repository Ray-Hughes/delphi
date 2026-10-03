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
const { execFileSync } = require("child_process");
const core = require("../git");

// A fetch or a push crosses a network, so it gets a budget measured in what a
// slow VPN needs rather than what a local read does.
const NETWORK_TIMEOUT = 90000;
const WRITE_TIMEOUT = 60000;
const REMOTE = "origin";

const run = (dir, args, { timeout, write = false } = {}) => core.runGit(dir, args, { timeout, write });
const text = (result) => (result.ok ? result.stdout.trim() : "");

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

async function worktreePrune(repo) {
  return run(repo, ["worktree", "prune"], { timeout: WRITE_TIMEOUT, write: true });
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
    if (kind === "2") i++;   // the original path of a rename is its own record
  }
  return { files, conflicted };
}

async function status(dir) {
  const result = await run(dir, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  if (!result.ok) return { ok: false, reason: plain(result, "git could not read the folder") };
  const head = core.parseStatus(result.stdout);
  const { files, conflicted } = parseStatusFiles(result.stdout);
  return {
    ok: true,
    branch: head.branch,
    upstream: head.upstream,
    ahead: head.ahead,
    behind: head.behind,
    files,
    conflicted,
    unsaved: files.length,
  };
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
  const fetched = await fetch(dir, base);
  const onto = await baseRef(dir, base);
  if (!onto) return { ok: false, conflict: false, files: [], reason: `There is no branch called ${base} to update from.`, offline: fetched.offline };
  const result = await run(dir, ["-c", "core.editor=true", "rebase", onto], { timeout: WRITE_TIMEOUT, write: true });
  if (result.ok) return { ok: true, conflict: false, files: [], reason: null, offline: fetched.offline };
  const now = await status(dir);
  const files = now.ok ? now.conflicted : [];
  await run(dir, ["rebase", "--abort"], { timeout: WRITE_TIMEOUT, write: true });
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

async function deleteBranch(repo, branch) {
  return run(repo, ["branch", "-D", branch], { timeout: WRITE_TIMEOUT, write: true });
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
  [/not a git repository/i, () => "That folder is not a git repository."],
  [/is already (?:checked out|used by worktree) at '([^']+)'/i, (m) => `That branch is already open in another folder: ${m[1]}.`],
  [/a branch named '([^']+)' already exists/i, (m) => `A branch called ${m[1]} already exists.`],
  [/'([^']+)' already exists/i, (m) => `There is already something at ${m[1]}.`],
  [/index\.lock|could not lock|cannot lock ref/i, () => "Another git command is busy in this repository. Wait for it to finish and try again."],
  [/could not resolve host|unable to access|network is unreachable|connection (?:refused|timed out)|could not read from remote/i,
    () => "Could not reach the remote. Check the network or VPN and try again."],
  [/permission denied|authentication failed|could not read username|403/i,
    () => "The remote refused your credentials. Sign in to git for this remote and try again."],
  [/\[rejected\]|non-fast-forward|fetch first|updates were rejected/i,
    () => "The remote has commits this branch does not. Update from the base first, then push again."],
  [/couldn't find remote ref|invalid refspec|not a valid object name|unknown revision/i,
    () => "That branch does not exist on the remote."],
  [/contains modified or untracked files/i, () => "The folder still has changes in it, so it was left in place."],
  [/git was not found/i, () => "git is not installed, or Delphi cannot find it. Install git and try again."],
];

/** git's failure as a sentence someone new to git can act on. */
function plain(result, fallback) {
  const raw = `${result && result.stderr || ""}\n${result && result.stdout || ""}`;
  for (const [pattern, say] of PLAIN) {
    const m = pattern.exec(raw);
    if (m) return say(m);
  }
  const reason = core.reasonFrom(result || {}, fallback);
  return reason.replace(/^(fatal|error): /i, "").replace(/^\w/, (c) => c.toUpperCase());
}

module.exports = {
  REMOTE, real, samePath,
  toplevel, mainCheckout, isBare, isLinkedWorktree, hasSubmodules, hasRemote, refExists, defaultBranch, baseRef,
  fetch, fetchBranch, remoteUrl,
  parseWorktrees, worktreeList, branchState, worktreeAdd, worktreeRemove, worktreePrune,
  parseStatusFiles, status, countCommits, localOnlyCommits,
  commitAll, push, pullRebase, deleteBranch,
  compareUrl, gh, prCreate, plain,
};
