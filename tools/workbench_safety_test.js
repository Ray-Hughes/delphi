#!/usr/bin/env node
// The never-lose-work rules, one case per way the G3 review found to lose work.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/workbench_safety_test.js
//
// Each section names the review item it pins. Every repository is a throwaway
// in a temp directory, git sees none of the owner's configuration, and nothing
// is pushed anywhere but a bare repository beside it. tools/workbench_test.js
// covers the verbs working; this covers them refusing, and Discard keeping a
// copy of everything so that reaching it costs nothing.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-wbsafe-")));
process.env.DELPHI_DATA_DIR = path.join(dir, "data");
process.env.DELPHI_DB = path.join(dir, "data", "delphi.db");
fs.mkdirSync(process.env.DELPHI_DATA_DIR);
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}
const home = path.join(dir, "home");
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, ".gitconfig"),
  "[user]\n\tname = Delphi Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
Object.assign(process.env, {
  HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
  XDG_CONFIG_HOME: path.join(home, ".config"), DELPHI_GH: "none",
  GIT_AUTHOR_NAME: "Delphi Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Delphi Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
});
for (const k of ["DELPHI_WORKBENCH_DIR", "DELPHI_BRANCH_PREFIX", "GIT_DIR", "GIT_WORK_TREE", "DELPHI_ACTOR", "DELPHI_CLIENT", "DELPHI_AUTHOR_TYPE"]) delete process.env[k];

const db = require("../db");
const { makeSheetStore } = require("../sheet/store");
const { runEntry, liveBatcher } = require("../sheet/run");
const wgit = require("../workbench/git");
const keep = require("../workbench/keep");
const { makeWorkbenchStore } = require("../workbench/store");
const { createWorkbench } = require("../workbench/workbench");
const { openServer } = require("../sheet/client");
const GIT = require("../git").findGit();

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
  return ok;
}
async function rejects(what, promise, pattern, code) {
  checks++;
  try {
    await promise;
  } catch (error) {
    if (pattern.test(String(error.message)) && (!code || error.code === code)) return error;
    failures++;
    console.error(`  FAIL ${what}\n       threw ${JSON.stringify(error.message)} (${error.code})\n       want  ${pattern} ${code || ""}`);
    return error;
  }
  failures++;
  console.error(`  FAIL ${what}\n       did not throw`);
  return null;
}
const section = (name) => console.log(`\n${name}`);
const git = (cwd, ...args) => execFileSync(GIT, ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitOk = (cwd, ...args) => spawnSync(GIT, ["-C", cwd, ...args], { stdio: "ignore" }).status === 0;
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const exists = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, "utf8");
// Every ref that can reach a commit: what is left once reflogs expire.
const reachedBy = (repo, sha) => git(repo, "for-each-ref", "--contains", sha, "--format=%(refname)").split("\n").filter(Boolean);

let repos = 0;
function makeRepo(name, { remote = true } = {}) {
  const app = path.join(dir, "code", `${name}`);
  if (remote) {
    const origin = path.join(dir, `${name}-origin.git`);
    execFileSync(GIT, ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync(GIT, ["clone", "-q", origin, app], { stdio: "ignore" });
  } else {
    fs.mkdirSync(app, { recursive: true });
    git(app, "init", "-q", "-b", "main");
  }
  write(path.join(app, "README.md"), "hello\n");
  write(path.join(app, ".gitignore"), ".env\nbuild/\nnode_modules/\n");
  git(app, "add", "-A");
  git(app, "commit", "-qm", "first");
  if (remote) git(app, "push", "-q", "origin", "main");
  write(path.join(app, ".env"), "SECRET=from-main\n");
  const project = db.createProject({ key: `s${++repos}`, name: `Safety ${repos}`, path: app });
  return { app: fs.realpathSync(app), project };
}

const sheets = makeSheetStore({ sql: db.sqlP, actor: "tester", authorType: "human" });
const store = makeWorkbenchStore({ sql: db.sqlP, actor: "tester" });
const logDir = path.join(dir, "data", "sheets");
const benches = createWorkbench({ store, sheet: sheets, runEntry, logDir, settings: () => ({ workbenchBranchPrefix: "ray" }) });
const task = (project, title) => db.createTask({ projectId: project.id, title });
const notes = (taskId) => db.handle().prepare("SELECT body FROM comments WHERE task_id = ? AND kind = 'note' ORDER BY id").all(taskId).map((r) => r.body);
async function bench(repo, title) {
  const t = task(repo.project, title);
  return { t, wb: (await benches.start(t.id, { runSetup: false })).workbench };
}
function commit(wb, file, text, message) {
  write(path.join(wb.path, file), text);
  git(wb.path, "add", "-A");
  git(wb.path, "commit", "-qm", message);
  return git(wb.path, "rev-parse", "HEAD");
}
function rebaseStoppedAtEdit(wb, n) {
  execFileSync(GIT, ["-C", wb.path, "rebase", "-i", `HEAD~${n}`],
    { env: { ...process.env, GIT_SEQUENCE_EDITOR: "sed -i.bak -e '1s/^pick/edit/'" }, stdio: "ignore" });
  write(path.join(wb.path, "f1.txt"), "amended carefully\n");
  git(wb.path, "add", "-A");
  git(wb.path, "commit", "-q", "--amend", "-m", "c1 amended");
  return git(wb.path, "rev-parse", "HEAD");
}
const inRebase = (wb) => exists(git(wb.path, "rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"));

async function main() {
  // -------------------------------------------------------------------------
  section("1. Discard keeps a copy of everything, and says how to get it back");
  {
    const r = makeRepo("keep", { remote: false });
    const { t, wb } = await bench(r, "keep it all");
    const committed = commit(wb, "precious.txt", "a day of work\n", "precious");
    write(path.join(wb.path, "draft.txt"), "uncommitted\n");
    write(path.join(wb.path, ".env"), "SECRET=edited-in-the-workbench\n");
    write(path.join(wb.path, "build/notes.txt"), "hours of work\n");
    write(path.join(wb.path, "node_modules/x/index.js"), "reproducible\n");
    write(path.join(wb.path, "build/big.bin"), Buffer.alloc(keep.PER_FILE_MAX + 1));
    const plan = await benches.discardPlan(wb.id);
    check("the plan lists the ignored files by folder, not node_modules",
      plan.ignored.map((g) => [g.dir, g.count]).sort(), [[".env", 1], ["build/", 2]]);
    check("and says what is too big to keep", plan.notKept.map((n) => n.path), ["build/big.bin"]);
    check("and how to recover, naming what is not kept, before anyone confirms",
      /^Everything in it except build\/big\.bin \(not kept.*\) is kept until \d{4}-\d\d-\d\d as refs\/delphi\/discarded\//.test(plan.recover), true);
    check("the plan never carries the internal path list", [plan.keepPaths, plan.top], [undefined, undefined]);
    const done = await benches.discard(wb.id, String(t.id), { confirm: plan.confirm });
    const ref = `refs/delphi/discarded/${t.id}-${wb.id}`;
    check("discarded, folder gone, branch gone, copy named", [done.ref, exists(wb.path), gitOk(r.app, "rev-parse", "--verify", `refs/heads/${wb.branch}`), gitOk(r.app, "rev-parse", "--verify", ref)],
      [ref, false, false, true]);
    check("the branch's commit is still reachable", reachedBy(r.app, committed), [ref]);
    check("the Sheet says how to recover", notes(t.id).pop().includes(done.recover), true);
    // The printed command, run as printed.
    const cmd = done.recover.slice(done.recover.indexOf("git -C "));
    execFileSync("/bin/sh", ["-c", cmd.replace(/^git /, `${GIT} `)], { stdio: "ignore" });
    // Into a folder of its own, beside where the Workbench was.
    const back = `${wb.path}-recovered-${wb.id}`;
    check("the recovery command brings back the committed, uncommitted and ignored work",
      [read(path.join(back, "precious.txt")), read(path.join(back, "draft.txt")), read(path.join(back, ".env")), read(path.join(back, "build/notes.txt"))],
      ["a day of work\n", "uncommitted\n", "SECRET=edited-in-the-workbench\n", "hours of work\n"]);
    check("but not the reproducible or the too big", [exists(path.join(back, "node_modules/x/index.js")), exists(path.join(back, "build/big.bin"))], [false, false]);
  }

  // -------------------------------------------------------------------------
  section("1. An agent cannot discard: no tool, a narrow recorder, the CLI refuses agents");
  const victim = makeRepo("victim", { remote: false });
  const vt = await bench(victim, "agent target");
  commit(vt.wb, "precious.txt", "x\n", "precious");
  write(path.join(vt.wb.path, "uncommitted.txt"), "more\n");
  db.handle().exec("PRAGMA wal_checkpoint(TRUNCATE)");

  // -------------------------------------------------------------------------
  section("2. Update never aborts a rebase the person is in the middle of");
  {
    const r = makeRepo("rebase");
    const { wb } = await bench(r, "rebase in progress");
    for (const n of [1, 2, 3]) commit(wb, `f${n}.txt`, `${n}\n`, `c${n}`);
    const amended = rebaseStoppedAtEdit(wb, 3);
    const st = await benches.status(wb.id, { fresh: true });
    check("status says so, in words", [st.state, /^In the middle of a rebase/.test(st.words)], ["busy", true]);
    const u = await benches.update(wb.id);
    check("update refuses and changes nothing", [u.ok, /middle of a rebase/.test(u.words), inRebase(wb), git(wb.path, "rev-parse", "HEAD")], [false, true, true, amended]);
    await rejects("finish refuses mid-rebase", benches.finish(wb.id), /middle of a rebase/, "BUSY");
    // A rebase this call starts and that clashes is still aborted: only its own.
    execFileSync(GIT, ["-C", wb.path, "rebase", "--abort"]);
    check("and the folder is out of it", inRebase(wb), false);
  }

  // -------------------------------------------------------------------------
  section("3. Finish refuses commits on no branch, with or without a remote");
  for (const remote of [false, true]) {
    const r = makeRepo(`detached-${remote}`, { remote });
    const { wb } = await bench(r, `detached ${remote}`);
    git(wb.path, "checkout", "-q", "--detach");
    const sha = commit(wb, "work.txt", "w\n", "detached work");
    const st = await benches.status(wb.id, { fresh: true });
    check(`status counts it (remote ${remote})`, [st.lonely, /1 commit on no branch/.test(st.words), st.ahead], [1, true, 0]);
    await rejects(`finish refuses (remote ${remote})`, benches.finish(wb.id), /on no branch/, "LONELY");
    check("the commit and the folder are still there", [exists(wb.path), gitOk(r.app, "cat-file", "-e", `${sha}^{commit}`)], [true, true]);
  }
  {
    const r = makeRepo("midrebase", { remote: false });
    const { wb } = await bench(r, "finish mid rebase");
    for (const n of [1, 2]) commit(wb, `f${n}.txt`, `${n}\n`, `c${n}`);
    rebaseStoppedAtEdit(wb, 2);
    await rejects("finish refuses mid-rebase with no remote", benches.finish(wb.id), /middle of a rebase/, "BUSY");
    check("folder kept", exists(wb.path), true);
  }

  // -------------------------------------------------------------------------
  section("4. A folder git cannot read is Unreadable, and nothing touches it");
  {
    const r = makeRepo("blind");
    const { t, wb } = await bench(r, "blind");
    write(path.join(wb.path, "draft.txt"), "a week of notes\n");
    fs.writeFileSync(git(wb.path, "rev-parse", "--path-format=absolute", "--git-path", "index"), "garbage");
    const st = await benches.status(wb.id, { fresh: true });
    check("status is unreadable, in plain words", [st.state, st.words, /damaged/.test(st.message), /fatal|index file|signature/i.test(st.message)],
      ["unreadable", "Unreadable", true, false]);
    const plan = await benches.discardPlan(wb.id);
    check("the discard plan says so instead of 'nothing'", /damaged/.test(plan.unreadable), true);
    await rejects("discard refuses", benches.discard(wb.id, String(t.id)), /damaged/, "UNREADABLE");
    await rejects("finish refuses", benches.finish(wb.id), /damaged/, "UNREADABLE");
    check("housekeeping does not call it missing", [(await benches.housekeep()).missing.includes(wb.id), store.get(wb.id).state], [false, "active"]);
    check("the work is still there", read(path.join(wb.path, "draft.txt")), "a week of notes\n");
  }

  // -------------------------------------------------------------------------
  section("5. Finish asks before ignored files go, and keeps a copy when told yes");
  {
    const r = makeRepo("ignored");
    const { t, wb } = await bench(r, "ignored work");
    check("a copied .env that is unchanged needs no question", (await benches.finishPlan(wb.id)).needsConfirm, false);
    write(path.join(wb.path, "node_modules/a/b.js"), "x\n");
    check("nor does node_modules", (await benches.finishPlan(wb.id)).needsConfirm, false);
    write(path.join(wb.path, ".env"), "API_KEY=only-copy-of-this\n");
    write(path.join(wb.path, "build/notes.txt"), "hours of work\n");
    const err = await rejects("finish refuses, naming them", benches.finish(wb.id), /\.env.*build\/ .*these exact files can go/, "IGNORED");
    check("the refusal carries the list for a window to show",
      [err && err.details.changedCopies, err && err.details.ignored.map((g) => g.dir).sort()], [[".env"], [".env", "build/"]]);
    check("and nothing went", [read(path.join(wb.path, ".env")), exists(path.join(wb.path, "build/notes.txt"))], ["API_KEY=only-copy-of-this\n", true]);
    check("the refusal carries the token for that exact list", err && err.details.confirm, (await benches.finishPlan(wb.id)).confirm);
    await rejects("a wrong token is no confirmation", benches.finish(wb.id, { confirm: "not-the-token" }), /these exact files/, "IGNORED");
    const done = await benches.finish(wb.id, { confirm: err.details.confirm });
    const ref = `refs/delphi/finished/${t.id}-${wb.id}`;
    check("with these-can-go it finishes and keeps a copy", [done.finished, done.ref, exists(wb.path)], [true, ref, false]);
    check("the copy has them", [git(r.app, "show", `${ref}:.env`), git(r.app, "show", `${ref}:build/notes.txt`)], ["API_KEY=only-copy-of-this", "hours of work"]);
    check("the Sheet says where", notes(t.id).pop().includes(ref), true);
  }

  // -------------------------------------------------------------------------
  section("6. The Discard plan lists commits on a detached HEAD, and keeps them");
  {
    const r = makeRepo("plan");
    const { t, wb } = await bench(r, "discard plan");
    commit(wb, "on-branch.txt", "x\n", "on branch");
    git(wb.path, "checkout", "-q", "--detach");
    const dsha = commit(wb, "detached.txt", "x\n", "detached only");
    const plan = await benches.discardPlan(wb.id);
    check("listed", [plan.commits.map((c) => c.subject), plan.detached.map((c) => c.subject)], [["on branch"], ["detached only"]]);
    await benches.discard(wb.id, String(t.id));
    check("and reachable afterwards from the copy", reachedBy(r.app, dsha), [`refs/delphi/discarded/${t.id}-${wb.id}`]);
  }

  // -------------------------------------------------------------------------
  section("7. Housekeeping prunes narrowly, keeps parked, expires old copies");
  {
    const r = makeRepo("prune");
    store.adoptRepo({ projectId: r.project.id, path: r.app, name: "prune" });   // known, never had a Workbench
    const mine = path.join(dir, "usb", "pr-hotfix");
    git(r.app, "worktree", "add", "-q", "-b", "hotfix", mine, "main");
    write(path.join(mine, "half-done.txt"), "uncommitted\n");
    fs.renameSync(path.join(dir, "usb"), path.join(dir, "usb-away"));
    await benches.housekeep();
    fs.renameSync(path.join(dir, "usb-away"), path.join(dir, "usb"));
    check("a person's own worktree on an unmounted disk survives", gitOk(mine, "status", "--short"), true);

    const { wb } = await bench(r, "parked one");   // now the repo is in use
    fs.renameSync(path.join(dir, "usb"), path.join(dir, "usb-away"));
    await benches.housekeep();
    fs.renameSync(path.join(dir, "usb-away"), path.join(dir, "usb"));
    check("and still survives once the repo has Workbenches (a week's grace)", gitOk(mine, "status", "--short"), true);

    await benches.park(wb.id);
    check("park leaves a note", notes(wb.task_id).pop(), `parked workbench on ${wb.branch}`);
    fs.renameSync(wb.path, `${wb.path}.moved`);
    const away = await benches.housekeep();
    check("a parked folder that goes is reported, and stays parked", [away.missing.includes(wb.id), store.get(wb.id).state, (await benches.status(wb.id, { fresh: true })).words], [true, "parked", "Missing"]);
    fs.renameSync(`${wb.path}.moved`, wb.path);
    await benches.housekeep();
    check("and is still parked when it comes back", store.get(wb.id).state, "parked");
    await benches.resume(wb.id);
    check("resume leaves a note", notes(wb.task_id).pop(), `resumed workbench on ${wb.branch}`);

    // A copy made forty days ago, and one made now.
    const head = git(r.app, "rev-parse", "HEAD");
    const tree = git(r.app, "rev-parse", "HEAD^{tree}");
    const old = execFileSync(GIT, ["-C", r.app, "commit-tree", tree, "-p", head, "-m", "old"],
      { env: { ...process.env, GIT_COMMITTER_DATE: `${Math.floor(Date.now() / 1000) - 40 * 86400} +0000` }, encoding: "utf8" }).trim();
    git(r.app, "update-ref", "refs/delphi/discarded/999-1", old);
    git(r.app, "update-ref", "refs/delphi/discarded/999-2", head);
    const hk = await benches.housekeep();
    check("copies past thirty days expire, newer ones stay", [hk.expired, gitOk(r.app, "rev-parse", "--verify", "refs/delphi/discarded/999-2")], [["refs/delphi/discarded/999-1"], true]);
  }

  // -------------------------------------------------------------------------
  section("10. Smaller things");
  {
    const r = makeRepo("small");
    const { wb } = await bench(r, "locked");   // housekeeping only looks at repositories in use
    // Adoption only when the branch is that task's.
    const victimTask = task(r.project, "victim");
    const otherTask = task(r.project, "other");
    const root = path.join(path.dirname(r.app), "small.workbenches");
    git(r.app, "worktree", "add", "-q", "-b", `bob/${otherTask.id}-other`, path.join(root, `${victimTask.id}-hand-made`), "main");
    const hk = await benches.housekeep();
    check("a folder named for one task on another's branch is not adopted", [hk.adopted, store.live(victimTask.id), hk.unmanaged.some((u) => u.branch === `bob/${otherTask.id}-other`)], [[], null, true]);
    const own = task(r.project, "own");
    git(r.app, "worktree", "add", "-q", "-b", `bob/${own.id}-own`, path.join(root, `${own.id}-own`), "main");
    check("one on its own task's branch is", (await benches.housekeep()).adopted.length, 1);

    // Locked: plain words.
    git(r.app, "worktree", "lock", "--reason", "on a usb disk", wb.path);
    const locked = await rejects("finish on a locked folder", benches.finish(wb.id), /marked as locked \(on a usb disk\)/, "GIT");
    check("with no git words in it", /worktree|fatal|cannot remove/i.test(locked && locked.message), false);

    // Start with a path that is not the project's.
    const stranger = makeRepo("stranger");
    const before = db.handle().prepare("SELECT COUNT(*) AS n FROM repos WHERE project_id = ?").get(r.project.id).n;
    await rejects("start refuses a repository that is not the project's", benches.start(task(r.project, "elsewhere").id, { path: stranger.app, runSetup: false }), /not a repository of this project/, "NO_REPO");
    check("and adds nothing to the project", db.handle().prepare("SELECT COUNT(*) AS n FROM repos WHERE project_id = ?").get(r.project.id).n, before);

    // plain() on its own.
    check("plain: locked", wgit.plain({ stderr: "fatal: cannot remove a locked working tree, lock reason: usb\n" }), "This folder is marked as locked (usb), so it was left in place. Unlock it first if it should go.");
    check("plain strict never hands back git's words", wgit.plain({ stderr: "fatal: something new\n" }, "Git cannot read this folder.", { strict: true }), "Git cannot read this folder.");
  }

  // -------------------------------------------------------------------------
  section("9. Live output is batched and capped");
  {
    const sent = [];
    const live = liveBatcher((p) => sent.push(p), { flushMs: 30, max: 1000 });
    for (let i = 0; i < 500; i++) live.push("0123456789");
    await new Promise((r) => setTimeout(r, 80));
    live.push("tail");
    live.end();
    check("a flood is a couple of messages, not five hundred", sent.length, 2);
    check("the first is the last 1000 characters, marked truncated", [sent[0].chunk.length, sent[0].truncated], [1000, true]);
    check("the rest is sent at the end, untruncated", sent[1], { chunk: "tail" });
  }

  // -------------------------------------------------------------------------
  section("11. sheet_append refuses run-only meta on other kinds");
  {
    const t = task(makeRepo("meta").project, "meta");
    for (const key of ["state", "out", "exit", "code"]) {
      let message = null;
      try { sheets.append({ taskId: t.id, kind: "say", body: "found it", meta: { [key]: "x" } }); } catch (e) { message = e.message; }
      check(`a say with ${key}`, /only belong on a run entry/.test(String(message)), true);
    }
    check("a run may carry them", sheets.append({ taskId: t.id, kind: "run", body: "true", meta: { state: "ok", code: 0, out: "" } }).kind, "run");
  }

  // -------------------------------------------------------------------------
  section("G4 1. What cannot be kept goes only with a yes to that exact list");
  {
    const r = makeRepo("g4big");
    const { t, wb } = await bench(r, "big");
    write(path.join(wb.path, "build/notes.txt"), "notes\n");
    fs.writeFileSync(path.join(wb.path, "build/dataset.bin"), Buffer.alloc(keep.PER_FILE_MAX + 1, 7));
    const plan = await benches.finishPlan(wb.id);
    check("finishPlan names what cannot be kept", plan.notKept.map((n) => n.path), ["build/dataset.bin"]);
    const err = await rejects("finish without a confirm refuses, naming it", benches.finish(wb.id), /gone for good: build\/dataset\.bin \(larger than 10 MB\)/, "IGNORED");
    check("its details carry notKept and the token", [err.details.notKept.map((n) => n.path), err.details.confirm], [["build/dataset.bin"], plan.confirm]);
    write(path.join(wb.path, "build/later.txt"), "added after the plan\n");
    await rejects("a list that changed since the plan refuses", benches.finish(wb.id, { confirm: plan.confirm }), /these exact files/, "IGNORED");
    check("and nothing went", [exists(path.join(wb.path, "build/dataset.bin")), exists(path.join(wb.path, "build/later.txt"))], [true, true]);
    const fresh = await benches.finishPlan(wb.id);
    const done = await benches.finish(wb.id, { confirm: fresh.confirm });
    check("with the current token it finishes", [done.finished, exists(wb.path)], [true, false]);
    check("and the recovery text names what was not kept, never 'everything'",
      [/^Everything in it except build\/dataset\.bin \(not kept/.test(done.recover), /^Everything in it is kept/.test(done.recover)], [true, false]);
    check("the copy has the rest", git(r.app, "show", `${done.ref}:build/notes.txt`), "notes");

    const r2 = makeRepo("g4bigd", { remote: false });
    const d = await bench(r2, "big discard");
    fs.mkdirSync(path.join(d.wb.path, "build"));
    fs.writeFileSync(path.join(d.wb.path, "build/huge.bin"), Buffer.alloc(keep.PER_FILE_MAX + 1, 1));
    const dplan = await benches.discardPlan(d.wb.id);
    await rejects("discard with something not kept wants the plan's token too", benches.discard(d.wb.id, String(d.t.id)), /these exact files/, "IGNORED");
    check("folder untouched", exists(path.join(d.wb.path, "build/huge.bin")), true);
    const gone = await benches.discard(d.wb.id, String(d.t.id), { confirm: dplan.confirm });
    check("with it, discard goes and says what was not kept", [gone.discarded, /except build\/huge\.bin/.test(gone.recover), gone.notKept], [true, true, ["build/huge.bin"]]);
  }

  // -------------------------------------------------------------------------
  section("G4 2. A repository inside the folder stops Finish and Discard");
  {
    const r = makeRepo("g4nest");
    const u = await bench(r, "untracked repo");
    const sub = path.join(u.wb.path, "spike");
    fs.mkdirSync(sub);
    git(sub, "init", "-q");
    write(path.join(sub, "a.txt"), "c\n");
    git(sub, "add", "-A");
    git(sub, "commit", "-qm", "x");
    write(path.join(sub, "uncommitted.txt"), "hours\n");
    const e1 = await rejects("discard refuses an untracked repository", benches.discard(u.wb.id, String(u.t.id)), /git repository inside this folder: spike\//, "NESTED");
    check("naming it in details", e1 && e1.details.nested, ["spike/"]);
    check("the plan says so before anyone confirms", (await benches.discardPlan(u.wb.id)).blocked.code, "NESTED");
    await rejects("finish refuses too", benches.finish(u.wb.id), /git repository inside/, "NESTED");
    check("its work is untouched", read(path.join(sub, "uncommitted.txt")), "hours\n");

    const i = await bench(r, "ignored repo");
    write(path.join(i.wb.path, "build/lib/x.txt"), "y\n");
    git(path.join(i.wb.path, "build/lib"), "init", "-q");
    check("finishPlan reports it as blocked", [(await benches.finishPlan(i.wb.id)).blocked.code, (await benches.finishPlan(i.wb.id)).nested], ["NESTED", ["build/lib/"]]);
    await rejects("an ignored repository stops discard", benches.discard(i.wb.id, String(i.t.id)), /build\/lib\//, "NESTED");
    check("still there", exists(path.join(i.wb.path, "build/lib/x.txt")), true);
  }

  // -------------------------------------------------------------------------
  section("G4 3. Hidden changes (assume-unchanged, skip-worktree) are unsaved, and kept");
  {
    const r = makeRepo("g4hidden");
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      const { t, wb } = await bench(r, `hidden ${flag}`);
      git(wb.path, "update-index", flag, "README.md");
      write(path.join(wb.path, "README.md"), "a local edit worth keeping\n");
      const st = await benches.status(wb.id, { fresh: true });
      check(`status says hidden (${flag})`, [st.words, st.state, st.hidden], ["1 hidden change", "unsaved", ["README.md"]]);
      await rejects(`finish refuses (${flag})`, benches.finish(wb.id), /hidden change/, "UNSAVED");
      const done = await benches.discard(wb.id, String(t.id));
      check(`discard's copy holds the edit (${flag})`, git(r.app, "show", `${done.ref}:README.md`), "a local edit worth keeping");
    }
  }

  // -------------------------------------------------------------------------
  section("G4 low. Unreadable paths refuse before anything is removed");
  if (process.getuid && process.getuid() !== 0) {
    const r = makeRepo("g4perm");
    for (const kind of ["file", "dir"]) {
      const { t, wb } = await bench(r, `perm ${kind}`);
      const f = path.join(wb.path, kind === "file" ? "secret.txt" : "locked/inner.txt");
      write(f, "work\n");
      write(path.join(wb.path, "other.txt"), "other work\n");
      const closed = kind === "file" ? f : path.dirname(f);
      fs.chmodSync(closed, 0o000);
      try {
        await rejects(`discard refuses an unreadable ${kind}`, benches.discard(wb.id, String(t.id)), /cannot read .*permissions/, "UNREADABLE");
        check(`and is all or nothing (${kind})`, [exists(path.join(wb.path, "other.txt")), store.get(wb.id).state], [true, "active"]);
      } finally {
        fs.chmodSync(closed, 0o755);
      }
    }
    check("plain: a local file git cannot open is not a credentials problem",
      wgit.plain({ stderr: "error: open(\"secret.txt\"): Permission denied\n" }), "Delphi cannot read secret.txt in this folder (its permissions do not allow it), so nothing was changed.");
  }

  // -------------------------------------------------------------------------
  section("G4 7. The recovery command works after the task is started again");
  {
    const r = makeRepo("g4rec");
    const t = task(r.project, "rec");
    const wb = (await benches.start(t.id, { runSetup: false })).workbench;
    write(path.join(wb.path, "w.txt"), "w\n");
    // A copy of the same name left by an older database: never replaced.
    git(r.app, "update-ref", `refs/delphi/discarded/${t.id}-${wb.id}`, git(r.app, "rev-parse", "HEAD"));
    const first = await benches.discard(wb.id, String(t.id));
    check("a name already taken gets a suffix", first.ref, `refs/delphi/discarded/${t.id}-${wb.id}-2`);
    check("and the row is recorded against it", store.get(wb.id).state, "discarded");
    const wb2 = (await benches.start(t.id, { runSetup: false })).workbench;
    check("the task's folder is back in use", wb2.path, wb.path);
    const cmd = first.recover.slice(first.recover.indexOf("git -C "));
    const out = spawnSync("/bin/sh", ["-c", cmd.replace(/^git /, `${GIT} `)], { encoding: "utf8" });
    check("the printed command still works", out.status, 0);
    check("into its own folder", read(path.join(`${wb.path}-recovered-${wb.id}`, "w.txt")), "w\n");
    write(path.join(wb2.path, "w2.txt"), "w2\n");
    const second = await benches.discard(wb2.id, String(t.id));
    const cmd2 = second.recover.slice(second.recover.indexOf("git -C "));
    check("a second discard of the task recovers beside the first", spawnSync("/bin/sh", ["-c", cmd2.replace(/^git /, `${GIT} `)]).status, 0);
  }

  // -------------------------------------------------------------------------
  section("Smaller G4 items");
  {
    const r = makeRepo("g4setup");
    store.updateRepo(store.adoptRepo({ projectId: r.project.id, path: r.app, name: "g4setup" }).id, { setup_cmd: null });
    const { wb } = await bench(r, "setup flag");
    const row = () => db.handle().prepare("SELECT setup_cmd, setup_cmd_detected FROM repos WHERE id = ?").get(wb.repo_id);
    check("a detected setup command is marked detected", row().setup_cmd_detected, 1);
    store.updateRepo(wb.repo_id, { setup_cmd: "make deps" });
    check("one a person sets is not", [row().setup_cmd, row().setup_cmd_detected], ["make deps", 0]);

    const t = task(r.project, "poll");
    sheets.append({ taskId: t.id, kind: "say", body: "first" });
    // The cursor is inclusive of its own second, so the poll after the one
    // that saw "first" is the first that can find nothing.
    await new Promise((res) => setTimeout(res, 1100));
    const seen = sheets.read(t.id, { mode: "full" }).cursor;
    await new Promise((res) => setTimeout(res, 1100));
    const cursor = sheets.read(t.id, { mode: "full", afterId: seen.after_id, since: seen.since }).cursor;
    const quiet = sheets.quietRead(t.id, { afterId: cursor.after_id, since: cursor.since });
    check("an idle poll is answered by the one query", quiet && [quiet.total, quiet.cursor.after_id], [1, cursor.after_id]);
    sheets.append({ taskId: t.id, kind: "say", body: "second" });
    check("and hands over to a full read when anything changed", sheets.quietRead(t.id, { afterId: cursor.after_id, since: quiet.cursor.since }), null);
  }

  // -------------------------------------------------------------------------
  section("G5 M. A removal never stops half way: the folder is moved aside, recorded, then deleted");
  {
    const r = makeRepo("g5ro");
    for (const verb of ["discard", "finish"]) {
      const { t, wb } = await bench(r, `ro ${verb}`);
      const d = path.join(wb.path, verb === "finish" ? "build/cache/pkg" : "cache/pkg");
      write(path.join(d, "a.txt"), "a\n");
      fs.chmodSync(d, 0o555);   // as go mod, Bazel and nix leave their caches
      const done = verb === "finish"
        ? await benches.finish(wb.id, { confirm: (await benches.finishPlan(wb.id)).confirm })
        : await benches.discard(wb.id, String(t.id));
      check(`${verb}: a read-only folder inside goes, and the row and copy are recorded`,
        [exists(wb.path), store.get(wb.id).state, gitOk(r.app, "rev-parse", "--verify", done.ref), done.cleanup.deleted],
        [false, verb === "finish" ? "finished" : "discarded", true, true]);
      check(`${verb}: no trash left behind`, fs.readdirSync(path.join(path.dirname(wb.path), keep.TRASH)).filter((n) => n.startsWith(`${wb.id}-`)), []);
      check(`${verb}: git no longer lists the folder`, git(r.app, "worktree", "list", "--porcelain").includes(wb.path), false);
    }

    // A file written into the folder after the copy was made: the git half
    // is run on its own so the write can land exactly between the copy and
    // the delete, as a writer racing the Discard would.
    const W = require("../workbench/workbench");
    for (const how of ["a new file", "an appended file"]) {
      const { t, wb } = await bench(r, `late ${how}`);
      write(path.join(wb.path, "log.txt"), "one\n");
      const done = await W.discardFolder(store.get(wb.id));
      await benches.markDiscarded(wb.id, done);
      check(`${how}: recorded before anything is deleted`, [store.get(wb.id).state, exists(done.trash)], ["discarded", true]);
      if (how === "a new file") write(path.join(done.trash, "late.txt"), "written after the copy\n");
      else fs.appendFileSync(path.join(done.trash, "log.txt"), "two\n");
      const left = await W.emptyMoved(done);
      check(`${how}: the moved folder is kept, not deleted`, [left.deleted, left.kept, left.changed], [false, done.trash, [how === "a new file" ? "late.txt" : "log.txt"]]);
      check(`${how}: marked so housekeeping leaves it`, exists(`${done.trash}.kept`), true);
      await benches.housekeep();
      check(`${how}: and housekeeping did`, exists(done.trash), true);
      fs.rmSync(done.trash, { recursive: true, force: true });
      void t;
    }

    // Deleting fails outright (an immutable file): the Workbench is already
    // recorded, and housekeeping deletes the rest later.
    if (process.platform === "darwin") {
      const { t, wb } = await bench(r, "undeletable");
      write(path.join(wb.path, "stuck.txt"), "s\n");
      const W2 = require("../workbench/workbench");
      const done = await W2.discardFolder(store.get(wb.id));
      await benches.markDiscarded(wb.id, done);
      execFileSync("chflags", ["uchg", path.join(done.trash, "stuck.txt")]);
      const left = await W2.emptyMoved(done);
      check("a delete that fails leaves the Workbench recorded", [left.deleted, store.get(wb.id).state], [false, "discarded"]);
      execFileSync("chflags", ["nouchg", path.join(done.trash, "stuck.txt")]);
      const hk = await benches.housekeep();
      check("housekeeping deletes it on a later run", [hk.trashed.includes(done.trash), exists(done.trash)], [true, false]);
      void t;
    }

    // Something Delphi started is still running in the folder.
    const { t: bt, wb: bwb } = await bench(r, "busy");
    write(path.join(bwb.path, "w.txt"), "w\n");
    const running = sheets.append({ taskId: bt.id, kind: "run", body: "npm run watch",
      meta: { state: "running", cwd: bwb.path, runner_pid: process.pid, runner_host: os.hostname() } });
    await rejects("discard refuses while a run is live in the folder", benches.discard(bwb.id, String(bt.id)), /still running in this folder: \$ npm run watch/, "BUSY");
    await rejects("finish too", benches.finish(bwb.id), /unsaved|still running/);
    sheets.update(running.id, { meta: { state: "ok", code: 0 } });
    db.handle().prepare("UPDATE tasks SET claimed_by = 'claude-code:2', claim_expires = datetime('now', '+30 minutes') WHERE id = ?").run(bt.id);
    await rejects("and while an agent holds the task", benches.discard(bwb.id, String(bt.id)), /an agent \(claude-code:2\) holding task/, "BUSY");
    db.handle().prepare("UPDATE tasks SET claimed_by = NULL, claim_expires = NULL WHERE id = ?").run(bt.id);
    check("nothing was touched", [exists(path.join(bwb.path, "w.txt")), store.get(bwb.id).state], [true, "active"]);
    check("plain: a delete that failed is not a credentials problem",
      wgit.plain({ stderr: "error: failed to delete '/x/y': Permission denied\n" }), "Delphi could not remove /x/y: something in it is read-only or still in use. Nothing was lost.");
  }

  // -------------------------------------------------------------------------
  section("G5 low");
  {
    const r = makeRepo("g5low");
    // 1. A decomposed (NFD) name among the kept ignored files.
    const n = await bench(r, "nfd");
    write(path.join(n.wb.path, "build", "re\u0301sume\u0301.txt"), "cv\n");
    const nd = await benches.discard(n.wb.id, String(n.t.id));
    check("an NFD ignored name is kept and verified", git(r.app, "show", `${nd.ref}:build/r\u00e9sum\u00e9.txt`), "cv");

    // 2. Untouched assume-unchanged symlink and newline-named file: no false hidden changes.
    fs.symlinkSync("README.md", path.join(r.app, "link"));
    write(path.join(r.app, "x\ny"), "v1\n");
    git(r.app, "add", "-A");
    git(r.app, "commit", "-qm", "odd");
    git(r.app, "push", "-q", "origin", "main");
    const h = await bench(r, "hidden odd");
    git(h.wb.path, "update-index", "--assume-unchanged", "--", "link");
    git(h.wb.path, "update-index", "--assume-unchanged", "--", "x\ny");
    check("no hidden change for an untouched symlink or newline name", (await benches.status(h.wb.id, { fresh: true })).hidden, []);
    write(path.join(h.wb.path, "x\ny"), "v2\n");
    check("but an edit to the newline name is one", (await benches.status(h.wb.id, { fresh: true })).hidden, ["x\ny"]);

    // 3. markFinished needs the copy.
    const m = await bench(r, "mark");
    fs.renameSync(m.wb.path, `${m.wb.path}.away`);
    await rejects("markFinished with no ref refuses", benches.markFinished(m.wb.id, {}), /recorded with its copy/, "NO_COPY");
    fs.renameSync(`${m.wb.path}.away`, m.wb.path);
    check("and records nothing", store.get(m.wb.id).state, "active");

    // 4. A token is for one Workbench.
    const a = await bench(r, "token a");
    const b = await bench(r, "token b");
    write(path.join(a.wb.path, "build/same.txt"), "a\n");
    write(path.join(b.wb.path, "build/same.txt"), "a\n");
    const ta = (await benches.finishPlan(a.wb.id)).confirm;
    check("the same list in two Workbenches has two tokens", ta === (await benches.finishPlan(b.wb.id)).confirm, false);
    await rejects("one Workbench's token does not finish another", benches.finish(b.wb.id, { confirm: ta }), /these exact files/, "IGNORED");

    // 6. A submodule is named as one, with deinit.
    const lib = makeRepo("g5sublib");
    const sm = await bench(r, "submodule");
    execFileSync(GIT, ["-C", sm.wb.path, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.app, "vendor/lib"], { stdio: "ignore" });
    git(sm.wb.path, "commit", "-qm", "add lib");
    await rejects("a submodule stops discard and says deinit", benches.discard(sm.wb.id, String(sm.t.id)), /git submodule deinit vendor\/lib/, "NESTED");

    // 5. Old repos rows are left at 0 (not detected): see schema_later.
    const { DatabaseSync } = require("node:sqlite");
    const old = new DatabaseSync(":memory:");
    old.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY); CREATE TABLE repos (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, path TEXT, is_primary INTEGER, setup_cmd TEXT)");
    old.exec("INSERT INTO repos (project_id, name, path, is_primary, setup_cmd) VALUES (1, 'x', '/x', 1, 'npm ci')");
    require("../agent/schema_later").apply((q) => { const st = old.prepare(q); return /^\s*(SELECT|PRAGMA)/i.test(q) ? st.all() : (st.run(), []); });
    check("an old row's setup command is not claimed as detected", old.prepare("SELECT setup_cmd_detected AS d FROM repos").get().d, 0);
  }

  // -------------------------------------------------------------------------
  section("G6 1. A process that dies after the move is finished by housekeeping, from the manifest");
  {
    const W = require("../workbench/workbench");
    const r = makeRepo("g6crash");
    for (const verb of ["discard", "finish"]) {
      const { t, wb } = await bench(r, `crash ${verb}`);
      write(path.join(wb.path, verb === "discard" ? "work.txt" : "build/notes.txt"), "work\n");
      const row = store.get(wb.id);
      const done = verb === "discard" ? await W.discardFolder(row) : await W.finishFolder(row, { confirm: (await benches.finishPlan(wb.id)).confirm });
      check(`${verb}: a manifest beside the moved folder`, [exists(done.trash), keep.readManifest(done.trash).ref], [true, done.ref]);
      check(`${verb}: the branch is still there until the record`, gitOk(r.app, "rev-parse", "--verify", `refs/heads/${wb.branch}`), true);
      // The process dies here: nothing recorded.
      const hk = await benches.housekeep();
      check(`${verb}: housekeeping records it`, [hk.reconciled.includes(wb.id), store.get(wb.id).state], [true, verb === "discard" ? "discarded" : "finished"]);
      check(`${verb}: with the recover text on the Sheet`, notes(t.id).some((n) => n.includes(done.ref) && n.includes("To get it back")), true);
      check(`${verb}: then empties it`, [exists(done.trash), exists(`${done.trash}.json`)], [false, false]);
      check(`${verb}: and a Discard's branch goes after the record, a Finish's stays`,
        gitOk(r.app, "rev-parse", "--verify", `refs/heads/${wb.branch}`), verb !== "discard");
    }

    // Recorded, then something wrote into the moved folder, then the
    // process died before emptying it.
    const { t, wb } = await bench(r, "late writer");
    write(path.join(wb.path, "work.txt"), "v1\n");
    const done = await W.discardFolder(store.get(wb.id));
    await benches.markDiscarded(wb.id, done);
    check("the moved folder is cut loose from git", [exists(path.join(done.trash, ".git")), exists(path.join(done.trash, ".git.was"))], [false, true]);
    write(path.join(done.trash, "work.txt"), "v2 after the copy\n");
    const hk = await benches.housekeep();
    check("housekeeping keeps a changed one, and says so", [hk.keptTrash, exists(done.trash), exists(`${done.trash}.kept`)], [[done.trash], true, true]);
    check("in words that say it is detached and how to compare", /cut loose from git.*diff -ru/.test(notes(t.id).pop()), true);
    // A new Workbench for the same task: git in the kept folder cannot reach it.
    const again = (await benches.start(t.id, { runSetup: false })).workbench;
    write(path.join(again.path, "fresh.txt"), "x\n");
    spawnSync(GIT, ["-C", done.trash, "add", "-A"], { stdio: "ignore" });
    check("git run in the kept folder does not touch the new Workbench", git(again.path, "diff", "--cached", "--name-only"), "");

    // An entry with no manifest is never deleted.
    const orphan = path.join(path.dirname(wb.path), keep.TRASH, "999-1700000000000");
    write(path.join(orphan, "mine.txt"), "a person's\n");
    await benches.housekeep();
    check("a .trash entry with no manifest is left alone", exists(path.join(orphan, "mine.txt")), true);
  }

  // -------------------------------------------------------------------------
  section("G6 3. The changed check skips only what git ignores");
  {
    const W = require("../workbench/workbench");
    const r = makeRepo("g6skip");
    write(path.join(r.app, "src/target/main.c"), "int main(){}\n");
    git(r.app, "add", "-A");
    git(r.app, "commit", "-qm", "t");
    git(r.app, "push", "-q", "origin", "main");
    for (const [file, kept] of [["src/target/main.c", true], ["src/coverage/notes.md", true], ["node_modules/x/late.js", false]]) {
      const { wb } = await bench(r, `skip ${file}`);
      const done = await W.discardFolder(store.get(wb.id));
      await benches.markDiscarded(wb.id, done);
      write(path.join(done.trash, file), "written after the copy\n");
      const left = await W.emptyMoved(done);
      check(`${file} after the copy: ${kept ? "kept" : "not counted"}`, Boolean(left.kept), kept);
      if (left.kept) fs.rmSync(done.trash, { recursive: true, force: true });
    }
    const benches_ = path.join(dir, "probe-here");
    const now = keep.volumeNow(path.join(benches_, "1-x"));
    check("the volume's clock is read from a probe that leaves nothing behind",
      [Math.abs(now - Date.now()) < 5000, fs.readdirSync(path.join(benches_, keep.TRASH)).filter((n) => n.startsWith(".probe")).length], [true, 0]);
  }

  // -------------------------------------------------------------------------
  section("G6 low 1. What counts as running in the folder");
  {
    const r = makeRepo("g6busy");
    const cases = [
      ["through the /var symlink", (wb) => ({ cwd: wb.path.replace(/^\/private/, ""), runner_pid: process.pid, runner_host: os.hostname() }), true],
      ["with a trailing slash", (wb) => ({ cwd: `${wb.path}/`, runner_pid: process.pid, runner_host: os.hostname() }), true],
      ["in a subfolder", (wb) => ({ cwd: path.join(wb.path, "src"), runner_pid: process.pid, runner_host: os.hostname() }), true],
      ["a sibling with the same prefix", (wb) => ({ cwd: `${wb.path}-other`, runner_pid: process.pid, runner_host: os.hostname() }), false],
      ["from another machine, recent", (wb) => ({ cwd: wb.path, runner_pid: 1, runner_host: "elsewhere" }), true],
      ["from another machine, two days old", (wb) => ({ cwd: wb.path, runner_pid: 1, runner_host: "elsewhere" }), false, "-2 days"],
      ["with no runner, two days old", (wb) => ({ cwd: wb.path }), false, "-2 days"],
    ];
    for (const [label, meta, busy, age] of cases) {
      const { t, wb } = await bench(r, `busy ${label}`);
      const e = sheets.append({ taskId: t.id, kind: "run", body: "npm run dev", meta: { state: "running", ...meta(wb) } });
      if (age) db.handle().prepare(`UPDATE comments SET created_at = datetime('now', '${age}') WHERE id = ?`).run(e.id);
      check(`a run ${label} ${busy ? "counts" : "does not"}`, store.busyIn(store.get(wb.id)).length > 0, busy);
    }
  }

  // -------------------------------------------------------------------------
  section("G7. A manifest is a hint: housekeeping acts only on what the row and git confirm");
  {
    const W = require("../workbench/workbench");
    const r = makeRepo("g7");
    const anyNote = (taskId, re) => notes(taskId).filter((n) => re.test(n)).length;

    // Forged: the folder is only away (a disk unplugged), an agent makes a
    // ref and a manifest naming another repository and its branch.
    const victim = makeRepo("g7victim");
    git(victim.app, "branch", "precious");
    const tip = git(victim.app, "rev-parse", "precious");
    const f = await bench(r, "forged");
    write(path.join(f.wb.path, "work.txt"), "real work\n");
    fs.renameSync(f.wb.path, `${f.wb.path}.away`);
    const ref = `refs/delphi/discarded/${f.t.id}-${f.wb.id}`;
    git(r.app, "update-ref", ref, git(r.app, "rev-parse", "HEAD"));
    const forged = path.join(path.dirname(f.wb.path), keep.TRASH, `${f.wb.id}-${Date.now()}`);
    fs.mkdirSync(forged, { recursive: true });
    fs.writeFileSync(`${forged}.json`, JSON.stringify({ mode: "discard", workbench: f.wb.id, task_id: f.t.id, folder: f.wb.path, ref,
      tree: git(r.app, "rev-parse", "HEAD^{tree}"), top: victim.app, since: Date.now(), branchToDelete: { branch: "precious", tip } }));
    const hk1 = await benches.housekeep();
    check("a forged entry records nothing", [hk1.reconciled, store.get(f.wb.id).state !== "discarded"], [[], true]);
    check("deletes nothing, here or in another repository", [exists(forged), gitOk(victim.app, "rev-parse", "--verify", "refs/heads/precious"), gitOk(r.app, "rev-parse", "--verify", `refs/heads/${f.wb.branch}`)], [true, true, true]);
    check("and says once where it is", anyNote(f.t.id, /cannot vouch for/), 1);
    await benches.housekeep();
    check("not twice", anyNote(f.t.id, /cannot vouch for/), 1);
    await rejects("Forget refuses while it is there", benches.forget(f.wb.id), /moved to .*\.trash/, "IN_TRASH");
    fs.renameSync(`${f.wb.path}.away`, f.wb.path);
    check("the real folder is untouched when it comes back", read(path.join(f.wb.path, "work.txt")), "real work\n");
    fs.rmSync(forged, { recursive: true, force: true });
    for (const ext of [".json", ".noted"]) fs.rmSync(`${forged}${ext}`, { force: true });

    // A ref without Delphi's trailer is not a copy, even under the right name.
    const n = await bench(r, "untrailed");
    fs.renameSync(n.wb.path, `${n.wb.path}.away`);
    git(r.app, "update-ref", `refs/delphi/discarded/${n.t.id}-${n.wb.id}`, git(r.app, "rev-parse", "HEAD"));
    await rejects("markDiscarded refuses a ref Delphi did not write", benches.markDiscarded(n.wb.id, { ref: `refs/delphi/discarded/${n.t.id}-${n.wb.id}` }), /not a copy Delphi made/, "NO_COPY");
    fs.renameSync(`${n.wb.path}.away`, n.wb.path);

    // Two housekeeping runs at once over one moved folder.
    const c = await bench(r, "concurrent");
    for (let i = 0; i < 2000; i++) write(path.join(c.wb.path, `bulk/f${i}.txt`), `x${i}\n`);
    const cdone = await W.discardFolder(store.get(c.wb.id));
    const [a1, a2] = await Promise.all([benches.housekeep(), benches.housekeep()]);
    check("two at once record it exactly once", [a1.reconciled.length + a2.reconciled.length, anyNote(c.t.id, /^discarded workbench/)], [1, 1]);
    check("and leave no stray marker or lock", fs.readdirSync(path.dirname(cdone.trash)).filter((x) => x.startsWith(`${c.wb.id}-`)), []);

    // Recorded, then the process died before the branch went.
    const b = await bench(r, "pending branch");
    commit(b.wb, "w.txt", "w\n", "c");
    const bdone = await W.discardFolder(store.get(b.wb.id));
    const rec = await benches.markDiscarded(b.wb.id, { ...bdone, branchToDelete: null });   // the delete never happened
    check("the note is written after the branch step, and says what happened", [rec.branchDeleted, / is kept\./.test(notes(b.t.id).filter((x) => /^discarded/.test(x)).pop())], [false, true]);
    await benches.housekeep();
    check("housekeeping deletes it, from the row's own branch and the copy's tip", gitOk(r.app, "rev-parse", "--verify", `refs/heads/${b.wb.branch}`), false);
    check("and says so", anyNote(b.t.id, /deleted the branch .* which the Discard meant to/), 1);
    check("its commits are still in the copy", gitOk(r.app, "merge-base", "--is-ancestor", bdone.branchToDelete.tip, bdone.ref), true);

    // A truncated manifest, and a copy deleted early.
    for (const how of ["truncated manifest", "copy deleted"]) {
      const x = await bench(r, how);
      write(path.join(x.wb.path, "w.txt"), "w\n");
      const xd = await W.discardFolder(store.get(x.wb.id));
      if (how === "truncated manifest") fs.writeFileSync(`${xd.trash}.json`, fs.readFileSync(`${xd.trash}.json`, "utf8").slice(0, 40));
      else git(r.app, "update-ref", "-d", xd.ref);
      const hk = await benches.housekeep();
      check(`${how}: nothing recorded, the folder kept`, [hk.reconciled.includes(x.wb.id), exists(path.join(xd.trash, "w.txt"))], [false, true]);
      check(`${how}: the Sheet says where it is`, notes(x.t.id).some((t) => t.includes(xd.trash)), true);
      await rejects(`${how}: Forget refuses`, benches.forget(x.wb.id), /moved to/, "IN_TRASH");
    }

    // The app emptying while housekeeping runs: one of them does it, once.
    const e = await bench(r, "race empty");
    for (let i = 0; i < 2000; i++) write(path.join(e.wb.path, `bulk/f${i}.txt`), `x${i}\n`);
    const ed = await W.discardFolder(store.get(e.wb.id));
    await benches.markDiscarded(e.wb.id, ed);
    const [em, hkE] = await Promise.all([W.emptyMoved(ed), benches.housekeep()]);
    check("emptied once, with no kept note", [exists(ed.trash), em.kept || hkE.keptTrash.length ? "kept" : "ok", anyNote(e.t.id, /^kept the old folder/)], [false, "ok", 0]);
  }

  await viaServer();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);

  async function viaServer() {
    delete process.env.ELECTRON_RUN_AS_NODE;
    section("1. Through MCP and the command line, as an agent would try it");
    const agentEnv = { DELPHI_AUTHOR_TYPE: "agent", DELPHI_CLIENT: "delphi-cli" };
    const agent = openServer({ actor: "claude-code:7", env: agentEnv, clientName: "test", warn: () => {} });
    await agent.start();
    try {
      await rejects("there is no discard tool, even claiming to be the CLI", agent.call("workbench_discard", { task_id: vt.t.id, typed: String(vt.t.id) }), /Unknown tool/);
      await rejects("the recorder will not mark a folder that is still there",
        agent.call("workbench_discarded", { task_id: vt.t.id, ref: `refs/delphi/discarded/${vt.t.id}-${vt.wb.id}` }), /still there/);
      check("nothing happened", [exists(path.join(vt.wb.path, "uncommitted.txt")), store.get(vt.wb.id).state], [true, "active"]);
      // G4: an agent cannot remove ignored files by passing ignored_ok.
      const ar = makeRepo("g4agent");
      const at = task(ar.project, "agent finish");
      const awb = (await benches.start(at.id, { runSetup: false })).workbench;
      fs.mkdirSync(path.join(awb.path, "build"));
      fs.writeFileSync(path.join(awb.path, "build/model.ckpt"), Buffer.alloc(keep.PER_FILE_MAX + 2, 1));
      db.handle().exec("PRAGMA wal_checkpoint(TRUNCATE)");
      await rejects("workbench_finish ignores ignored_ok and refuses, naming the file", agent.call("workbench_finish", { task_id: at.id, ignored_ok: true, confirm: "x" }), /model\.ckpt/);
      check("the file is still there", exists(path.join(awb.path, "build/model.ckpt")), true);
      const list = (await agent.request("tools/list", {})).tools.find((x) => x.name === "workbench_finish");
      check("and the tool offers no way to say yes", Object.keys(list.inputSchema.properties), ["task_id"]);
      // Not a safety rule, but the same server: list_agents carries the launch
      // fields sheet/chat.js reads (plan 6.6).
      db.seedHarnesses(require("../harness").BUILTINS);
      db.handle().exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const agents = await agent.call("list_agents", {});
      const claude = agents.find((x) => x.key === "claude-code");
      check("list_agents has the launch fields", claude && [typeof claude.command, Array.isArray(claude.args) && claude.args.length > 0, typeof claude.parser, typeof claude.mcp_style, "enabled" in claude],
        ["string", true, "string", "string", true]);
    } finally {
      agent.close();
    }

    const CLI = path.join(__dirname, "..", "bin", "delphi");
    // script(1) gives the CLI a terminal, which is how the review got past
    // the interactive check. The typed confirm is fed in ahead.
    // script wants its stdin to be a pipe or a terminal, not the socket
    // spawnSync gives it, hence the shell. The confirm is typed ahead after a
    // pause, as a person (or the review's agent) would.
    const viaScript = (taskId, env) => spawnSync("/bin/sh", ["-c", '(sleep 3; printf "%s\\n" "$1") | /usr/bin/script -q /dev/null "$2" "$3" discard "$1"', "sh",
      String(taskId), process.execPath, CLI], {
      encoding: "utf8", timeout: 120000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DELPHI_ACTOR: "ray", ...env },
    });
    if (process.platform === "darwin" && exists("/usr/bin/script")) {
      const r = viaScript(vt.t.id, { DELPHI_AUTHOR_TYPE: "agent" });
      check("the CLI refuses an agent even at a terminal", [/agent's session/.test(r.stdout + r.stderr), exists(path.join(vt.wb.path, "uncommitted.txt"))], [true, true]);

      // A person, with more files than the list shows.
      for (let i = 0; i < 25; i++) write(path.join(vt.wb.path, `loose-${String(i).padStart(2, "0")}.txt`), "x\n");
      const p = viaScript(vt.t.id, {});
      const out = p.stdout + p.stderr;
      check("a person can discard from the CLI", [/Discarded/.test(out), exists(vt.wb.path), store.get(vt.wb.id).state], [true, false, "discarded"]);
      check("the list says how many more", /and 6 more/.test(out), true);
      check("and how to get it all back", /To get it back: git -C /.test(out), true);
      check("the copy is there", gitOk(victim.app, "rev-parse", "--verify", `refs/delphi/discarded/${vt.t.id}-${vt.wb.id}`), true);
    } else {
      console.log("  (no script(1) here; the terminal cases are skipped)");
    }

    section("8. Two processes starting the same task at once");
    const tally = {};
    for (let trial = 0; trial < 8; trial++) {
      const r = makeRepo(`race${trial}`);
      const t = task(r.project, `race ${trial}`);
      db.handle().exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const mk = (n) => openServer({ actor: `agent:${n}`, env: { DELPHI_BRANCH_PREFIX: "ray" }, clientName: "test", warn: () => {} });
      const a = mk(1);
      const b = mk(2);
      await a.start();
      await b.start();
      const callIt = (c) => c.call("workbench_start", { task_id: t.id, run_setup: false }).then((x) => `created=${x.created}`, (e) => `ERR ${e.message}`);
      const pair = await Promise.all([callIt(a), new Promise((res) => setTimeout(res, trial * 20)).then(() => callIt(b))]);
      const rows = db.handle().prepare("SELECT COUNT(*) AS n FROM workbenches WHERE task_id = ?").get(t.id).n;
      const key = `${pair.sort().join(" | ")} rows=${rows}`;
      tally[key] = (tally[key] || 0) + 1;
      a.close();
      b.close();
    }
    check("every race ends with one Workbench and no error", tally, { "created=false | created=true rows=1": 8 });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
