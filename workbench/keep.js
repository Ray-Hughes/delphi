/**
 * Keeping a copy of a Workbench folder before it goes, so that removing one
 * never loses work, whoever asked for it.
 *
 * Discard used to be the one verb that threw work away, guarded by a typed
 * confirm and the hope that only a person would reach it. Hope is not a
 * boundary: an agent with a shell can reach anything a person can. So the
 * folder is copied into the repository first, as a commit that no branch
 * points at, under refs/delphi/discarded/<task>-<id>. Reaching Discard then
 * costs nothing that cannot be got back for KEEP_DAYS.
 *
 * The copy is made with a temporary index and commit-tree, which touch
 * neither the folder, its real index, its branch nor HEAD: whatever goes
 * wrong while keeping, the folder is exactly as it was, and the verb that
 * asked refuses rather than carry on without a copy.
 *
 * What is kept:
 *
 * - every tracked change and every untracked file, whatever its size: those
 *   are the work.
 * - ignored files, except reproducible output (REPRODUCIBLE: dependency
 *   installs and caches a command makes again), any single file over
 *   PER_FILE_MAX, and anything past TOTAL_MAX in all. What is not kept is
 *   listed before anyone confirms, so nothing goes unnamed.
 *
 * The same rules decide what Finish asks about: an ignored file that is not
 * reproducible, or a copied file (.env) that differs from the main checkout's,
 * is named, and Finish goes ahead only on an explicit "these can go", keeping
 * a copy under refs/delphi/finished/ all the same. That confirmation is a
 * token over the exact list (confirmToken), so a list that changed after the
 * person read it is refused rather than taken as agreed.
 *
 * What cannot be kept refuses outright, before anything is removed: a git
 * repository inside the folder (its history and its uncommitted work are not
 * files a commit can hold), and anything Delphi cannot read. A copy that
 * turns out to be missing a file it was meant to hold is refused the same
 * way, after write-tree and before the folder goes.
 *
 * Pure node and workbench/git.js, so the command line runs it in process.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEEP_DAYS = 30;
const PER_FILE_MAX = 10 * 1024 * 1024;
const TOTAL_MAX = 100 * 1024 * 1024;
// Entries visited inside ignored folders before giving up counting. A folder
// past it is reported whole as not kept, rather than walked for minutes.
const WALK_MAX = 50000;
const NAMESPACES = { discarded: "refs/delphi/discarded/", finished: "refs/delphi/finished/" };

// Folders whose contents a command makes again: installs, caches and test
// output. Deliberately not build, dist or out: people keep notes and hand
// edited files in those often enough that they are asked about instead.
const REPRODUCIBLE_DIRS = new Set([
  "node_modules", "bower_components", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
  ".ruff_cache", ".tox", ".nox", ".gradle", ".next", ".nuxt", ".svelte-kit", ".parcel-cache", ".turbo",
  ".angular", ".cache", ".nyc_output", "coverage", "target", "DerivedData", "Pods", ".terraform", ".eggs",
]);
const REPRODUCIBLE_FILES = /^(?:\.DS_Store|Thumbs\.db|desktop\.ini)$|\.py[co]$/;

/** Whether an ignored path is something a command makes again. */
function reproducible(rel) {
  const parts = String(rel).replace(/\/+$/, "").split("/");
  if (parts.some((p) => REPRODUCIBLE_DIRS.has(p) || p.endsWith(".egg-info"))) return true;
  return REPRODUCIBLE_FILES.test(parts[parts.length - 1]);
}

function sameFile(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * The folder's ignored files, sorted into what a person must hear about and
 * what may go unremarked.
 *
 *   files     every ignored file that is not reproducible: [{ path, size }]
 *   groups    the same, summarised by top level folder: [{ dir, count, bytes }]
 *   changedCopies  copy-list files (.env) that differ from the main checkout's
 *   keep      the paths a snapshot takes
 *   notKept   what a snapshot leaves out, and why: [{ path, why }]
 *
 * A copy-list file identical to the main checkout's is reproducible (Start
 * copies it again) and is not listed.
 */
async function ignoredReport(git, folder, { main = null, copy = [] } = {}) {
  const listed = await git.ignoredPaths(folder);
  if (!listed.ok) return { ok: false, reason: listed.reason };
  const copies = new Set(copy.map((c) => String(c).replace(/^\.\//, "")));
  const files = [];
  const notKept = [];
  const changedCopies = [];
  const nested = [];
  const unreadable = [];
  let visited = 0;

  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(path.join(folder, rel), { withFileTypes: true }); } catch { unreadable.push(`${rel}/`); return; }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      // A repository inside an ignored folder: its own history and its own
      // uncommitted work, none of which a commit of files can hold.
      if (e.name === ".git") { nested.push(`${rel}/`); continue; }
      if (reproducible(child)) continue;
      if (++visited > WALK_MAX) { notKept.push({ path: `${child}${e.isDirectory() ? "/" : ""}`, why: "too many files to go through" }); continue; }
      if (e.isDirectory()) walk(child);
      else add(child);
    }
  };
  const add = (rel) => {
    let size = 0;
    let stat;
    try { stat = fs.lstatSync(path.join(folder, rel)); size = stat.size; } catch { return; }
    if (stat.isFile()) {
      try { fs.accessSync(path.join(folder, rel), fs.constants.R_OK); } catch { unreadable.push(rel); return; }
    }
    if (copies.has(rel) && main) {
      if (sameFile(path.join(folder, rel), path.join(main, rel))) return;
      changedCopies.push(rel);
    }
    files.push({ path: rel, size });
  };

  for (const entry of listed.paths) {
    if (reproducible(entry)) continue;
    if (entry.endsWith("/")) walk(entry.slice(0, -1));
    else add(entry);
  }

  const keep = [];
  let total = 0;
  for (const f of files) {
    if (f.size > PER_FILE_MAX) { notKept.push({ path: f.path, why: `larger than ${PER_FILE_MAX / 1024 / 1024} MB` }); continue; }
    if (total + f.size > TOTAL_MAX) { notKept.push({ path: f.path, why: `past ${TOTAL_MAX / 1024 / 1024} MB of ignored files in all` }); continue; }
    total += f.size;
    keep.push(f.path);
  }

  const byDir = new Map();
  for (const f of files) {
    const slash = f.path.indexOf("/");
    const dir = slash === -1 ? f.path : f.path.slice(0, slash + 1);
    const g = byDir.get(dir) || { dir, count: 0, bytes: 0 };
    g.count++;
    g.bytes += f.size;
    byDir.set(dir, g);
  }
  return { ok: true, files, groups: [...byDir.values()], changedCopies, keep, notKept, nested, unreadable };
}

/**
 * The repositories inside a folder, which no copy can hold: initialised
 * submodules (gitlinks with a .git of their own), untracked repositories
 * (git status lists one as a single folder, and with -uall that is the only
 * kind of folder it lists), and repositories inside ignored folders (found by
 * ignoredReport's walk).
 */
function nestedRepos(folder, { gitlinks = [], untracked = [], report = null } = {}) {
  const found = new Set();
  const hasGit = (rel) => { try { fs.lstatSync(path.join(folder, rel, ".git")); return true; } catch { return false; } };
  for (const g of gitlinks) if (hasGit(g)) found.add(`${g.replace(/\/+$/, "")}/`);
  for (const u of untracked) if (u.endsWith("/") && hasGit(u)) found.add(u);
  for (const n of (report && report.nested) || []) found.add(n);
  return [...found].sort();
}

/**
 * A short token for exactly what a person agreed could go: every listed
 * ignored file and every path that would not be kept. Finish and Discard
 * recompute it and refuse on any difference, so a confirmation is never
 * stretched over files the person was not shown.
 */
function confirmToken(report) {
  const list = { files: (report.files || []).map((f) => f.path).sort(), notKept: (report.notKept || []).map((n) => n.path).sort() };
  return crypto.createHash("sha256").update(JSON.stringify(list)).digest("hex").slice(0, 32);
}

/** Where a Workbench's copy goes. One per Workbench and verb, so a second never overwrites a first. */
function refFor(kind, wb) {
  return `${NAMESPACES[kind]}${Number(wb.task_id)}-${Number(wb.id)}`;
}

const q = (p) => (/^[A-Za-z0-9_./:@+-]+$/.test(String(p)) ? String(p) : `'${String(p).replace(/'/g, "'\\''")}'`);

/**
 * A folder and a branch to recover into that are free now: the original
 * folder may hold a new Workbench for the same task by the time anyone
 * recovers, and a second Discard of that task wants a recovery of its own.
 * Both carry the Workbench id, and a number after it if even that is taken.
 */
async function freeNames(git, { repo, folder, branch, id }) {
  for (let n = 1; n < 100; n++) {
    const tail = `recovered-${Number(id)}${n > 1 ? `-${n}` : ""}`;
    const dir = `${folder}-${tail}`;
    const name = `${branch}-${tail}`;
    if (fs.existsSync(dir)) continue;
    if (await git.refExists(repo, `refs/heads/${name}`)) continue;
    return { dir, name };
  }
  return { dir: `${folder}-recovered-${Number(id)}-${Date.now()}`, name: `${branch}-recovered-${Number(id)}-${Date.now()}` };
}

/**
 * The sentence that says what was kept and the one command that puts it
 * back. When something was not kept it says so by name: "everything" is
 * never claimed for a copy that is missing anything.
 */
function recoverText({ ref, repo, until, dir, name, notKept = [] }) {
  const missing = notKept.map((n) => n.path || n);
  const what = missing.length
    ? `Everything in it except ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? `, and ${missing.length - 5} more` : ""} (not kept: too large or too many) is kept until ${until} as ${ref}.`
    : `Everything in it is kept until ${until} as ${ref}.`;
  return `${what} To get it back: git -C ${q(repo)} worktree add -b ${q(name)} ${q(dir)} ${ref}`;
}

async function recoverFor(git, { ref, repo, folder, branch, id, until, notKept = [] }) {
  const { dir, name } = await freeNames(git, { repo, folder, branch, id });
  return recoverText({ ref, repo, until, dir, name, notKept });
}

function untilDate(days = KEEP_DAYS, now = Date.now()) {
  return new Date(now + days * 86400000).toISOString().slice(0, 10);
}

/**
 * Commits the folder as it is (tracked changes, untracked files and the
 * listed ignored ones) onto a commit no branch points at, and names it ref.
 *
 * Its first parent is the folder's HEAD and its second the branch's tip when
 * that differs, so commits on a detached HEAD and commits on a branch about
 * to be deleted are both reachable from the one ref. With no folder (it was
 * deleted by hand) the branch tip alone is kept, and with neither an empty
 * commit records that there was nothing.
 *
 * Refuses, changing nothing, if the ref already exists.
 */
async function snapshot(git, { repo, folder = null, branch, ref: wanted, keep = [], hidden = [], expect = [], message }) {
  const rev = async (dir, spec) => {
    const r = await git.run(dir, ["rev-parse", "--verify", "--quiet", spec]);
    return r.ok ? r.stdout.trim() : null;
  };
  // A copy of this name left by an older database (ids start again) is
  // somebody's work too: never replaced, the new one takes the next name.
  let ref = wanted;
  for (let n = 2; await rev(repo, ref); n++) ref = `${wanted}-${n}`;
  const head = folder ? await rev(folder, "HEAD^{commit}") : null;
  const tip = await rev(repo, `refs/heads/${branch}^{commit}`);
  const env = {
    GIT_AUTHOR_NAME: "Delphi", GIT_AUTHOR_EMAIL: "delphi@localhost",
    GIT_COMMITTER_NAME: "Delphi", GIT_COMMITTER_EMAIL: "delphi@localhost",
    GIT_LITERAL_PATHSPECS: "1",
  };

  let tree = null;
  if (folder) {
    const indexOut = await git.run(folder, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    if (!indexOut.ok) return { ok: false, reason: git.plain(indexOut, "Git cannot read this folder.", { strict: true }) };
    const index = indexOut.stdout.trim();
    const temp = `${index}.delphi-keep-${process.pid}-${Date.now()}`;
    const withIndex = { ...env, GIT_INDEX_FILE: temp };
    try {
      // The real index copied rather than rebuilt, so git trusts its record of
      // unchanged files and does not read the whole tree again. A missing or
      // unreadable one falls back to HEAD's tree, which is merely slower.
      let seeded = false;
      try { fs.copyFileSync(index, temp); seeded = true; } catch {}
      if (!seeded && head) {
        const r = await git.runWith(folder, ["read-tree", head], { env: withIndex });
        if (!r.ok) return { ok: false, reason: git.plain(r, "Could not read the folder's last commit.", { strict: true }) };
      }
      // Files git was told not to look at (assume-unchanged, skip-worktree)
      // are looked at here: their flags are cleared in the copy's index only,
      // or add would skip exactly the edits nobody can see.
      // One flag per call: given both, update-index applies only the last.
      for (const flag of hidden.length ? ["--no-assume-unchanged", "--no-skip-worktree"] : []) {
        const r = await git.runWith(folder, ["update-index", flag, "-z", "--stdin"], { env: withIndex, input: `${hidden.join("\0")}\0` });
        if (!r.ok) return { ok: false, reason: git.plain(r, "Could not read the hidden changes.", { strict: true }) };
      }
      let r = await git.runWith(folder, ["add", "--all", "--", "."], { env: withIndex, timeout: 10 * 60000 });
      if (!r.ok) return { ok: false, reason: git.plain(r, "Could not read every file in the folder.", { strict: true }) };
      if (keep.length) {
        r = await git.runWith(folder, ["add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"],
          { env: withIndex, input: `${keep.join("\0")}\0`, timeout: 10 * 60000 });
        if (!r.ok) return { ok: false, reason: git.plain(r, "Could not read the ignored files.", { strict: true }) };
      }
      r = await git.runWith(folder, ["write-tree"], { env: withIndex });
      if (!r.ok) return { ok: false, reason: git.plain(r, "Could not record the folder's files.", { strict: true }) };
      tree = r.stdout.trim();
      // Checked, not trusted: every file the copy was meant to hold is in
      // it, or the folder stays. add skips what it cannot see (a repository
      // inside the folder, a file it was not allowed to open) with at most a
      // warning, and a copy with a hole in it is worse than no copy, because
      // it is believed.
      const wantIn = [...new Set([...keep, ...expect.filter((p) => !p.endsWith("/")), ...hidden])];
      // A hidden change is checked by content, not presence: the file was in
      // the tree all along, with the old text.
      for (const h of hidden) {
        const want = await git.runWith(folder, ["hash-object", "--", h]);
        const got = await git.runWith(folder, ["rev-parse", "--verify", "--quiet", `${tree}:${h}`]);
        if (fs.existsSync(path.join(folder, h)) && (!want.ok || !got.ok || want.stdout.trim() !== got.stdout.trim())) {
          return { ok: false, reason: `The copy would not hold the change to ${h}.` };
        }
      }
      if (wantIn.length) {
        const listed = await git.runWith(folder, ["ls-tree", "-r", "-z", "--name-only", tree], { timeout: 10 * 60000 });
        if (!listed.ok) return { ok: false, reason: "Could not check the copy." };
        const inTree = new Set(listed.stdout.split("\0").filter(Boolean));
        const lost = wantIn.filter((p) => !inTree.has(p) && fs.existsSync(path.join(folder, p)));
        if (lost.length) {
          return { ok: false, reason: `The copy would be missing ${lost.slice(0, 5).join(", ")}${lost.length > 5 ? `, and ${lost.length - 5} more` : ""}.` };
        }
      }
    } finally {
      try { fs.unlinkSync(temp); } catch {}
    }
  } else if (tip) {
    tree = await rev(repo, `${tip}^{tree}`);
  } else {
    const r = await git.runWith(repo, ["mktree"], { input: "" });
    tree = r.ok ? r.stdout.trim() : null;
  }
  if (!tree) return { ok: false, reason: "Could not record the folder's files." };

  const parents = [...new Set([head, tip].filter(Boolean))];
  const made = await git.runWith(repo, ["commit-tree", "--no-gpg-sign", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message], { env });
  if (!made.ok) return { ok: false, reason: git.plain(made, "Could not record the copy.", { strict: true }) };
  const sha = made.stdout.trim();
  // An empty old value: the ref is only created, never moved.
  const named = await git.run(repo, ["update-ref", "-m", "delphi: kept before removing a Workbench", ref, sha, ""], { write: true });
  if (!named.ok || await rev(repo, ref) !== sha) return { ok: false, reason: git.plain(named, "Could not name the copy.", { strict: true }) };
  return { ok: true, ref, sha, head, tip, kept: keep.length };
}

/**
 * Deletes kept copies older than KEEP_DAYS, by the date the copy was made.
 * Each is deleted only if it still points where it was read, so a copy made
 * a moment ago under a reused name is never the one removed.
 */
async function expire(git, repo, { days = KEEP_DAYS, now = Date.now() } = {}) {
  const r = await git.run(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(committerdate:unix)",
    NAMESPACES.discarded, NAMESPACES.finished]);
  if (!r.ok) return [];
  const cutoff = now / 1000 - days * 86400;
  const gone = [];
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    const [ref, sha, when] = line.split("\0");
    if (!(Number(when) < cutoff)) continue;
    const d = await git.run(repo, ["update-ref", "-d", ref, sha], { write: true });
    if (d.ok) gone.push(ref);
  }
  return gone;
}

module.exports = {
  KEEP_DAYS, PER_FILE_MAX, TOTAL_MAX, WALK_MAX, NAMESPACES, REPRODUCIBLE_DIRS,
  reproducible, ignoredReport, nestedRepos, confirmToken, refFor, freeNames, recoverText, recoverFor, untilDate, snapshot, expire,
};
