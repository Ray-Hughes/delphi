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
 * a copy under refs/delphi/finished/ all the same.
 *
 * Pure node and workbench/git.js, so the command line runs it in process.
 */

const fs = require("fs");
const path = require("path");

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
  let visited = 0;

  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(path.join(folder, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (reproducible(child)) continue;
      if (++visited > WALK_MAX) { notKept.push({ path: `${child}${e.isDirectory() ? "/" : ""}`, why: "too many files to go through" }); continue; }
      if (e.isDirectory()) walk(child);
      else add(child);
    }
  };
  const add = (rel) => {
    let size = 0;
    try { size = fs.lstatSync(path.join(folder, rel)).size; } catch { return; }
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
  return { ok: true, files, groups: [...byDir.values()], changedCopies, keep, notKept };
}

/** Where a Workbench's copy goes. One per Workbench and verb, so a second never overwrites a first. */
function refFor(kind, wb) {
  return `${NAMESPACES[kind]}${Number(wb.task_id)}-${Number(wb.id)}`;
}

const q = (p) => (/^[A-Za-z0-9_./:@+-]+$/.test(String(p)) ? String(p) : `'${String(p).replace(/'/g, "'\\''")}'`);

/** The one command that puts everything back, as a sentence a person can paste. */
function recoverText({ ref, repo, folder, branch, until }) {
  return `Everything in it is kept until ${until} as ${ref}. To get it back: ` +
    `git -C ${q(repo)} worktree add -b ${q(`${branch}-recovered`)} ${q(folder)} ${ref}`;
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
async function snapshot(git, { repo, folder = null, branch, ref, keep = [], message }) {
  const rev = async (dir, spec) => {
    const r = await git.run(dir, ["rev-parse", "--verify", "--quiet", spec]);
    return r.ok ? r.stdout.trim() : null;
  };
  if (await rev(repo, ref)) return { ok: false, reason: `A copy called ${ref} is already there.` };
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
  reproducible, ignoredReport, refFor, recoverText, untilDate, snapshot, expire,
};
