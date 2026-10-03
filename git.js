// The git state of a project's folder.
//
// This lives in the main process for the same reason ai.js does: the renderer
// has no way to run a process, so the window asks over IPC and gets back a plain
// object it can put in the footer. Nothing here holds state between calls except
// the path to the git binary.
//
// Everything is read through `git status --porcelain=v2 --branch -z`, which is
// the only output git promises not to change between versions. It is also the
// cheapest: branch name, upstream, ahead/behind and every changed path come back
// from one process, where the human-readable output would need three calls and a
// parser that breaks the first time someone has a non-English locale or sets
// status.short in their config.
//
// -z is not decoration. Without it git quotes any path containing a space, a
// quote or a UTF-8 byte, and a rename entry packs two paths onto one line with a
// tab between them. With it every record is NUL-terminated and every path is
// literal, so the parser never has to unquote anything.
//
// A folder that is not a repository is the ordinary case, not a failure. Half of
// the projects someone points this app at will be a plain directory, so status()
// answers `repo: false` and no caller needs a try/catch to show a footer.

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");

// A read finishes in milliseconds on any repo this app will see, so ten seconds
// only ever fires when something is wrong: a stale index.lock, a network
// filesystem that stopped answering, a filter driver waiting on nothing.
const READ_TIMEOUT = 10000;

// Committing gets its own budget because a pre-commit hook can run a linter over
// the whole tree, and killing that halfway is worse than waiting.
const COMMIT_TIMEOUT = 120000;

const LOG_LIMIT_MAX = 500;

// ---------------------------------------------------------------------------
// Finding the binary
//
// An app launched from Finder inherits almost none of the PATH a terminal has,
// so "git" on its own resolves to nothing. Unlike the CLI in ai.js, git lives in
// a handful of known places, and checking those directly avoids paying four
// seconds for a login shell on every cold start.
//
// Order matters. /usr/bin/git on macOS is usually a shim: on a machine without
// the Command Line Tools it exists, and running it pops the installer dialog and
// exits non-zero instead of being git. Real installs are looked at first so that
// dialog is never provoked on a machine that already has one, and the shim is
// only reached as a last resort, where the prompt it raises is the right answer
// anyway. Each candidate is proved by running it rather than by existsSync, for
// exactly that reason.

let gitPathCache;

function usable(candidate) {
  try {
    if (!candidate.includes("/")) return false;
    if (!fs.existsSync(candidate)) return false;
    execFileSync(candidate, ["--version"], { timeout: 5000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function findGit() {
  if (gitPathCache !== undefined) return gitPathCache;

  const candidates = [
    process.env.DELPHI_GIT,        // an escape hatch for a git somewhere unusual
    "/opt/homebrew/bin/git",       // Homebrew on Apple silicon
    "/usr/local/bin/git",          // Homebrew on Intel, and the official installer
    "/usr/bin/git",                // Apple's shim, which may or may not be real git
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (usable(candidate)) {
      gitPathCache = candidate;
      return gitPathCache;
    }
  }

  // Nothing where it should be, so ask a login shell, the same way ai.js finds
  // the Claude CLI. The last line is taken because a profile that starts
  // ssh-agent prints "Agent pid 21976" before this command says anything.
  try {
    const out = execFileSync("/bin/zsh", ["-ilc", "command -v git"], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = String(out).split("\n").map((l) => l.trim()).filter(Boolean);
    gitPathCache = lines.reverse().find((l) => l.startsWith("/") && fs.existsSync(l)) || null;
  } catch {
    gitPathCache = null;
  }
  return gitPathCache;
}

// ---------------------------------------------------------------------------
// Running git

/**
 * Runs git in a folder and collects its output.
 *
 * Resolves on failure rather than rejecting, because "exited non-zero" means
 * something different at every call site here: for isRepo it is the answer, for
 * status it means show nothing, for commit it is an error worth a sentence. A
 * result object lets each one decide instead of wrapping every call in a catch.
 *
 * The folder is passed as `-C <folder>` rather than as spawn's cwd so that a
 * folder which has been deleted or renamed comes back as a git error we can
 * read, instead of an ENOENT thrown by spawn itself. Arguments go as an array,
 * never as a shell string, so a path holding a space or a quote is just a path.
 */
function runGit(folder, args, { timeout = READ_TIMEOUT, write = false } = {}) {
  return new Promise((resolve) => {
    const git = findGit();
    if (!git) {
      resolve({ ok: false, code: null, stdout: "", stderr: "git was not found on this machine" });
      return;
    }

    const child = spawn(git, ["-C", String(folder), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // git never gets to sit waiting for a password on a terminal that does
        // not exist. Without this a repo with an http remote can hang forever.
        GIT_TERMINAL_PROMPT: "0",
        // A read must not take index.lock. `git status` likes to write back a
        // refreshed index, which fights whatever editor or CLI the person has
        // open on the same repo and can fail outright on a read-only checkout.
        ...(write ? {} : { GIT_OPTIONAL_LOCKS: "0" }),
      },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: String(e.message || e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // A killed process closes with a null code and an empty stderr, which
      // would otherwise reach the window as a blank error message.
      if (timedOut) {
        resolve({ ok: false, code: null, stdout, stderr: `git did not finish within ${timeout}ms` });
        return;
      }
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/** The first thing git said that reads like a reason, for showing to a person. */
function reasonFrom(result, fallback) {
  // Hooks and some porcelain write their complaint to stdout, so stderr alone is
  // not enough to explain a failed commit.
  const text = (result.stderr || "").trim() || (result.stdout || "").trim();
  return text ? text.split("\n").filter(Boolean)[0] : fallback;
}

// ---------------------------------------------------------------------------
// Reading status
//
// The records of porcelain v2, all NUL-terminated:
//
//   # branch.oid <sha> | (initial)
//   # branch.head <branch> | (detached)
//   # branch.upstream <ref>          only when one is configured
//   # branch.ab +<ahead> -<behind>   only when one is configured
//   1 <XY> ...            <path>     a changed tracked file
//   2 <XY> ... <score>    <path>     a rename or copy, original path follows
//   u <XY> ...            <path>     an unmerged file
//   ? <path>                         untracked
//   ! <path>                         ignored, which we never ask for
//
// XY is two characters: X is what is staged, Y is what is not, and "." means
// unchanged. A file edited twice, once staged and once not, is counted in both.

function parseStatus(out) {
  const state = {
    oid: null,
    branch: null,
    upstream: null,
    ahead: null,
    behind: null,
    detached: false,
    unborn: false,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    changed: 0,
  };

  const records = out.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;

    if (record.startsWith("# ")) {
      const space = record.indexOf(" ", 2);
      const key = space === -1 ? record.slice(2) : record.slice(2, space);
      const value = space === -1 ? "" : record.slice(space + 1);
      if (key === "branch.oid") {
        // "(initial)" is git saying the branch exists but points at nothing yet,
        // which is what `git init` leaves behind until the first commit.
        if (value === "(initial)") state.unborn = true;
        else state.oid = value;
      } else if (key === "branch.head") {
        if (value === "(detached)") state.detached = true;
        else state.branch = value;
      } else if (key === "branch.upstream") {
        state.upstream = value;
      } else if (key === "branch.ab") {
        const m = /^\+(\d+)\s+-(\d+)$/.exec(value);
        if (m) {
          state.ahead = Number(m[1]);
          state.behind = Number(m[2]);
        }
      }
      continue;
    }

    const kind = record[0];
    if (kind === "?") {
      state.untracked++;
      state.changed++;
    } else if (kind === "u") {
      state.conflicted++;
      state.changed++;
    } else if (kind === "1" || kind === "2") {
      const xy = record.split(" ")[1] || "..";
      if (xy[0] !== ".") state.staged++;
      if (xy[1] !== ".") state.unstaged++;
      state.changed++;
      // A rename carries two paths, and under -z the original one is its own
      // NUL-terminated record. Skipping it is what stops it being read as the
      // start of the next entry.
      if (kind === "2") i++;
    }
    // "!" is ignored, and we never pass --ignored, so anything else is a record
    // from a git newer than this parser and is better skipped than guessed at.
  }

  return state;
}

/** Whether a folder is inside a git working tree at all. */
async function isRepo(folder) {
  if (!folder) return false;
  const result = await runGit(folder, ["rev-parse", "--is-inside-work-tree"], { timeout: 5000 });
  return result.ok && result.stdout.trim() === "true";
}

/**
 * What the footer shows: where this repo is and how much is uncommitted.
 *
 * The counts are numbers rather than lists because the footer counts, and a repo
 * mid-rebase with ten thousand untracked files should not send ten thousand
 * paths across IPC to render the digit 4. Untracked directories are counted
 * collapsed, git's default, so a newly added folder counts as one thing and not
 * as the three hundred files inside it, which is both faster and what the person
 * looking at the footer means by "one new folder".
 *
 * `ahead` and `behind` are null, never 0, when there is no upstream: a branch
 * that was never pushed is not level with anything, and showing it as level is a
 * lie that costs someone their work.
 *
 * A folder that is not a repo comes back with `repo: false` and the rest of the
 * shape intact, so a caller can read `status.branch` without checking first.
 */
async function status(folder) {
  const notARepo = {
    repo: false,
    branch: null,
    ahead: null,
    behind: null,
    upstream: null,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    changed: 0,
    clean: true,
    detached: false,
    unborn: false,
    head: null,
  };

  if (!folder) return notARepo;

  const result = await runGit(folder, ["status", "--porcelain=v2", "--branch", "-z"]);
  if (!result.ok) {
    // Everything that gets here looks the same to the window: no repo to show.
    // The distinction between "not a repo", "the folder is gone" and "git said
    // the ownership is dubious" only matters if someone asks, so the sentence is
    // carried along rather than thrown.
    return { ...notARepo, reason: reasonFrom(result, "not a git repository") };
  }

  const parsed = parseStatus(result.stdout);
  return {
    repo: true,
    branch: parsed.branch,
    ahead: parsed.ahead,
    behind: parsed.behind,
    upstream: parsed.upstream,
    staged: parsed.staged,
    unstaged: parsed.unstaged,
    untracked: parsed.untracked,
    conflicted: parsed.conflicted,
    // Distinct paths touched. staged + unstaged double-counts a file that is
    // both, so this is the number to put next to the Commit button.
    changed: parsed.changed,
    clean: parsed.changed === 0,
    detached: parsed.detached,
    // No commits yet. There is a branch name, but nothing is on it, so anything
    // that reads history has to expect an empty answer.
    unborn: parsed.unborn,
    head: parsed.oid,
  };
}

// ---------------------------------------------------------------------------
// Committing

/** A single configured value, or null when git has none. */
async function configValue(folder, key) {
  // --get exits 1 when the key is unset, which is an answer and not a failure.
  const result = await runGit(folder, ["config", "--get", key], { timeout: 5000 });
  const value = result.ok ? result.stdout.trim() : "";
  return value || null;
}

/**
 * Stages and commits, and says clearly why not when it cannot.
 *
 * Refusing before running anything is the point. git's own failures here are
 * famously opaque: an empty commit exits 1 with the whole status output, and a
 * missing identity produces a nine-line lecture about ~/.gitconfig. Neither fits
 * in a footer, so identity and staged content are checked first and the button
 * gets one sentence it can show.
 *
 * `all: true` stages untracked files as well as modified ones, which `git commit
 * -a` does not. That is deliberate: the count beside the button includes new
 * files, so a commit that quietly left them out would not match what the person
 * was looking at when they pressed it.
 */
async function commit(folder, message, { all = false } = {}) {
  const text = String(message || "").trim();
  if (!text) throw new Error("A commit needs a message.");

  const before = await status(folder);
  if (!before.repo) throw new Error("That folder is not a git repository.");
  if (before.conflicted > 0) {
    const files = before.conflicted === 1 ? "1 file has" : `${before.conflicted} files have`;
    throw new Error(`${files} unresolved conflicts. Resolve them before committing.`);
  }

  const name = await configValue(folder, "user.name");
  const email = await configValue(folder, "user.email");
  if (!name || !email) {
    const missing = !name && !email ? "user.name and user.email are" : !name ? "user.name is" : "user.email is";
    throw new Error(`git ${missing} not configured, so it cannot record who made this commit.`);
  }

  if (all) {
    // -A rather than -u, so new files are included. Pathspec "." would miss
    // deletions outside the current directory; there is no current directory
    // here worth trusting, so the whole tree it is.
    const staged = await runGit(folder, ["add", "-A"], { timeout: COMMIT_TIMEOUT, write: true });
    if (!staged.ok) throw new Error(reasonFrom(staged, "git could not stage the changes."));
  }

  // Asked again after staging, because that is what decides whether there is
  // anything to commit, and because `all` may have just changed the answer.
  const ready = await status(folder);
  if (ready.staged === 0) {
    throw new Error(all ? "Nothing has changed, so there is nothing to commit."
                        : "Nothing is staged. Stage something, or commit with all.");
  }

  const done = await runGit(folder, ["commit", "-m", text], { timeout: COMMIT_TIMEOUT, write: true });
  if (!done.ok) throw new Error(reasonFrom(done, "git refused the commit."));

  // Read back rather than parse the commit's own output, which is a summary
  // written for a terminal and changes shape with the config.
  const head = await log(folder, 1);
  const made = head[0] || {};
  return {
    sha: made.sha || null,
    short: made.sha ? made.sha.slice(0, 7) : null,
    subject: made.subject || text.split("\n")[0],
    branch: ready.branch,
  };
}

// ---------------------------------------------------------------------------
// History and branches

/**
 * Local branches, current one marked.
 *
 * for-each-ref rather than `git branch`, whose output is decorated for a human
 * and indents, colours and abbreviates depending on config. A newline is one of
 * the few things a ref name cannot contain, so splitting on it here is safe in a
 * way it would not be for paths.
 */
async function branches(folder) {
  const format = "%(HEAD)%00%(refname:short)%00%(upstream:short)%00%(objectname)";
  const result = await runGit(folder, [
    "for-each-ref", "--sort=-committerdate", `--format=${format}`, "refs/heads",
  ]);
  if (!result.ok) return [];

  return result.stdout.split("\n").filter(Boolean).map((line) => {
    const [head, name, upstream, sha] = line.split("\0");
    return {
      name,
      current: head === "*",
      upstream: upstream || null,
      sha: sha || null,
    };
  }).filter((b) => b.name);
}

/**
 * Recent commits, newest first.
 *
 * Fields are separated by a unit separator and commits by NUL, because a subject
 * can contain anything a person can type, tabs and pipe characters included. An
 * unborn repo returns an empty list rather than an error: having no history is a
 * state, not a fault.
 */
async function log(folder, limit = 20) {
  const count = Math.min(Math.max(parseInt(limit, 10) || 20, 1), LOG_LIMIT_MAX);
  const result = await runGit(folder, [
    "log", "-z", `--max-count=${count}`, "--format=%H%x1f%s%x1f%an%x1f%aI",
  ]);
  if (!result.ok) return [];

  return result.stdout.split("\0").filter(Boolean).map((record) => {
    const [sha, subject, author, at] = record.split("\x1f");
    return { sha, subject: subject || "", author: author || "", at: at || null };
  }).filter((c) => c.sha);
}

// runGit, findGit, parseStatus and reasonFrom are exported for workbench/git.js,
// which needs the same binary, the same environment rules and the same parser
// rather than a second copy of each that would drift.
module.exports = { status, commit, isRepo, branches, log, runGit, findGit, parseStatus, reasonFrom };
