#!/usr/bin/env node
// Workbenches against throwaway repositories, never a real one.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/workbench_test.js
//
// Every repository here lives in a temp directory, with a bare repository in
// the same directory as its origin, so nothing is ever pushed anywhere else.
// git is cut off from the owner's own configuration (GIT_CONFIG_NOSYSTEM, a
// temp HOME and GIT_CONFIG_GLOBAL), so a global hook, a signing key or a
// default branch of their choosing cannot change what is tested.
//
// Most cases run in process through db.sqlP, which is how the app uses these
// modules. The MCP tools and the command line are then driven the way an agent
// and a person would, against the same database.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-workbench-")));
process.env.DELPHI_DATA_DIR = path.join(dir, "data");
process.env.DELPHI_DB = path.join(dir, "data", "delphi.db");
fs.mkdirSync(process.env.DELPHI_DATA_DIR);
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

// git sees none of the owner's configuration.
const home = path.join(dir, "home");
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, ".gitconfig"),
  "[user]\n\tname = Delphi Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
Object.assign(process.env, {
  HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  GIT_AUTHOR_NAME: "Delphi Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Delphi Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
  DELPHI_GH: "none",
});
delete process.env.DELPHI_WORKBENCH_DIR;
delete process.env.DELPHI_BRANCH_PREFIX;
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;

const db = require("../db");
const { makeSheetStore } = require("../sheet/store");
const { runEntry } = require("../sheet/run");
const naming = require("../workbench/naming");
const setup = require("../workbench/setup");
const wgit = require("../workbench/git");
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

function section(name) { console.log(`\n${name}`); }

function git(cwd, ...args) {
  return execFileSync(GIT, ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
const gitOk = (cwd, ...args) => spawnSync(GIT, ["-C", cwd, ...args], { stdio: "ignore" }).status === 0;
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const exists = (p) => fs.existsSync(p);

// ---------------------------------------------------------------------------
// The repositories

const origin = path.join(dir, "origin.git");
const seed = path.join(dir, "seed");
const work = path.join(dir, "code");
const app = path.join(work, "app");

execFileSync(GIT, ["init", "--quiet", "--bare", "-b", "main", origin]);
execFileSync(GIT, ["clone", "--quiet", origin, seed], { stdio: "ignore" });
write(path.join(seed, "README.md"), "hello\n");
write(path.join(seed, ".gitignore"), ".env\n.env.local\n");
write(path.join(seed, "shared.txt"), "one\n");
git(seed, "add", "-A");
git(seed, "commit", "--quiet", "-m", "first");
git(seed, "push", "--quiet", "origin", "main");
fs.mkdirSync(work);
execFileSync(GIT, ["clone", "--quiet", origin, app], { stdio: "ignore" });
write(path.join(app, ".env"), "SECRET=from-main\n");

/** Pushes a commit to origin's main from the seed clone, as a colleague would. */
function colleagueCommits(file, text, message) {
  git(seed, "pull", "--quiet", "--rebase", "origin", "main");
  write(path.join(seed, file), text);
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", message);
  git(seed, "push", "--quiet", "origin", "main");
}

const project = db.createProject({ key: "wb", name: "Workbench test", path: app });
const sheets = makeSheetStore({ sql: db.sqlP, actor: "tester", authorType: "human" });
const store = makeWorkbenchStore({ sql: db.sqlP, actor: "tester" });
const logDir = path.join(dir, "data", "sheets");
const events = [];
const benches = createWorkbench({
  store, sheet: sheets, runEntry, logDir,
  settings: () => ({ workbenchBranchPrefix: "ray" }),
  onEvent: (e) => events.push(e),
});
const task = (title, extra = {}) => db.createTask({ projectId: project.id, title, ...extra });
const notes = (taskId) => db.handle().prepare("SELECT body FROM comments WHERE task_id = ? AND kind = 'note' ORDER BY id").all(taskId).map((r) => r.body);
const audits = (taskId) => db.handle().prepare("SELECT summary FROM audit WHERE entity = 'task' AND entity_id = ? ORDER BY id").all(taskId).map((r) => r.summary);

async function main() {
  section("naming");
  check("slug", naming.slug("Fix the ZIP DLQ!!"), "fix-the-zip-dlq");
  const long = naming.slug("a very long title that goes on and on well past forty characters");
  check("slug is 40 ASCII characters at most, cut at a word", [long.length <= 40, /^[a-z0-9-]+$/.test(long), long.endsWith("-")], [true, true, false]);
  check("accents are kept as letters", naming.slug("Café déjà vu"), "cafe-deja-vu");
  check("what is not ASCII after that is dropped", naming.slug("修复 zip 队列 bug"), "zip-bug");
  check("an id leads", naming.branchName({ prefix: "ray", taskId: 42, title: "Fix zip DLQ" }), "ray/42-fix-zip-dlq");
  check("a ticket ref leads, upper cased", naming.branchName({ prefix: "ray", taskId: 42, title: "Fix zip DLQ", ref: "abc-1234" }), "ray/ABC-1234-fix-zip-dlq");
  check("a ref that is not a ticket does not", naming.branchName({ prefix: "ray", taskId: 42, title: "x", ref: "PR 12" }), "ray/42-x");
  check("a title with nothing ASCII still names a branch", naming.branchName({ prefix: "ray", taskId: 7, title: "日本語" }), "ray/7-task");
  check("a messy prefix is cleaned", naming.branchName({ prefix: "Ray Hughes..", taskId: 1, title: "a" }), "Ray-Hughes/1-a");
  check("default prefix is usable", /^[A-Za-z0-9._-]+$/.test(naming.defaultPrefix()), true);
  for (const b of ["ray/42-fix-zip-dlq", "ray/ABC-1234-fix", "ray/7-task"]) check(`${b} is adoptable`, naming.ADOPTABLE.test(b), true);
  for (const b of ["feature/x", "main", "ray/fix-it", "a/b/42-x"]) check(`${b} is not adoptable`, naming.ADOPTABLE.test(b), false);
  check("folder is a sibling", naming.folderFor({ repoTop: "/src/app", taskId: 42, title: "Fix zip" }), "/src/app.workbenches/42-fix-zip");
  check("folder under an override", naming.folderFor({ repoTop: "/src/app", taskId: 42, title: "Fix zip", overrideDir: "/wb" }), "/wb/app/42-fix-zip");

  section("setup detection and copying");
  const detect = (files) => {
    const d = fs.mkdtempSync(path.join(dir, "detect-"));
    for (const f of files) write(path.join(d, f), "");
    return setup.detectSetup(d);
  };
  check("npm", detect(["package-lock.json"]), "npm ci");
  check("pnpm", detect(["pnpm-lock.yaml"]), "pnpm install --frozen-lockfile");
  check("yarn", detect(["yarn.lock"]), "yarn install --frozen-lockfile");
  check("bundler", detect(["Gemfile.lock"]), "bundle install");
  check("pip", detect(["requirements.txt"]), "python3 -m pip install -r requirements.txt");
  check("poetry wins over requirements", detect(["poetry.lock", "requirements.txt"]), "poetry install");
  check("uv", detect(["uv.lock"]), "uv sync");
  check("two ecosystems", detect(["Gemfile.lock", "package-lock.json"]), "npm ci && bundle install");
  check("nothing", detect(["README.md"]), "");
  const from = fs.mkdtempSync(path.join(dir, "copy-from-"));
  const to = fs.mkdtempSync(path.join(dir, "copy-to-"));
  write(path.join(from, ".env"), "theirs\n");
  write(path.join(from, ".env.local"), "local\n");
  write(path.join(to, ".env"), "mine\n");
  write(path.join(dir, "outside.txt"), "nope\n");
  const copied = setup.copyFiles(from, to, ".env, .env.local, ../outside.txt, missing.txt");
  check("copies what is not there", copied.copied, [".env.local"]);
  check("never overwrites", fs.readFileSync(path.join(to, ".env"), "utf8"), "mine\n");
  check("says why it skipped", copied.skipped.map((s) => s.file), [".env", "../outside.txt"]);
  check("no escape from the folder", fs.readdirSync(to).sort(), [".env", ".env.local"]);

  section("git parsing");
  check("worktree list", wgit.parseWorktrees("worktree /a b\0HEAD 123\0branch refs/heads/main\0\0worktree /c\0HEAD 456\0detached\0prunable gitdir file points to non-existent location\0\0"),
    [{ path: "/a b", branch: "main", head: "123", bare: false, detached: false, locked: false, prunable: false },
     { path: "/c", branch: null, head: "456", bare: false, detached: true, locked: false, prunable: true }]);
  check("status paths, renames and spaces", wgit.parseStatusFiles(
    "# branch.oid abc\0# branch.head main\0" +
    "1 .M N... 100644 100644 100644 aaa bbb has space.txt\0" +
    "2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt\0old name.txt\0" +
    "u UU N... 100644 100644 100644 100644 aaa bbb ccc clash.txt\0? new.txt\0"),
    { files: ["has space.txt", "new name.txt", "clash.txt", "new.txt"], conflicted: ["clash.txt"] });
  check("github compare", wgit.compareUrl("git@github.com:me/app.git", "main", "ray/1-x"), "https://github.com/me/app/compare/main...ray/1-x?expand=1");
  check("github https", wgit.compareUrl("https://github.com/me/app", "main", "b"), "https://github.com/me/app/compare/main...b?expand=1");
  check("gitlab", /^https:\/\/gitlab\.com\/g\/s\/app\/-\/merge_requests\/new\?/.test(wgit.compareUrl("ssh://git@gitlab.com/g/s/app.git", "main", "b")), true);
  check("bitbucket", wgit.compareUrl("git@bitbucket.org:me/app.git", "main", "b"), "https://bitbucket.org/me/app/pull-requests/new?source=b&dest=main");
  check("an unknown host is not guessed", wgit.compareUrl("git@git.example.com:me/app.git", "main", "b"), null);
  check("a local path has no web page", wgit.compareUrl(origin, "main", "b"), null);
  check("plain words for a checked out branch", wgit.plain({ stderr: "fatal: 'ray/1' is already checked out at '/x/y'\n" }), "That branch is already open in another folder: /x/y.");
  check("plain words for the network", wgit.plain({ stderr: "fatal: unable to access 'https://h/': Could not resolve host: h\n" }), "Could not reach the remote. Check the network or VPN and try again.");

  section("start");
  const t1 = task("Fix zip DLQ");
  const first = await benches.start(t1.id, { runSetup: false });
  const wb1 = first.workbench;
  const appReal = fs.realpathSync(app);
  check("created", first.created, true);
  check("folder is a sibling of the repo", wb1.path, path.join(path.dirname(appReal), "app.workbenches", `${t1.id}-fix-zip-dlq`));
  check("branch is named for the task", wb1.branch, `ray/${t1.id}-fix-zip-dlq`);
  check("base is detected", wb1.base, "main");
  check("the folder is on the branch", git(wb1.path, "rev-parse", "--abbrev-ref", "HEAD"), wb1.branch);
  check(".env was copied", fs.readFileSync(path.join(wb1.path, ".env"), "utf8"), "SECRET=from-main\n");
  check("the project folder was adopted as its primary repo",
    db.handle().prepare("SELECT path, is_primary FROM repos WHERE project_id = ?").all(project.id).map((r) => [r.path, r.is_primary]), [[appReal, 1]]);
  check("the Sheet says so", notes(t1.id), [`started workbench on ${wb1.branch}`]);
  check("History says so", audits(t1.id).includes("started workbench (by tester)"), true);
  check("progress events", events.filter((e) => e.taskId === t1.id).map((e) => e.phase), ["fetching", "creating", "copying", "ready"]);
  check("no warnings on a clean start", first.warnings, []);
  const again = await benches.start(t1.id, { runSetup: false });
  check("starting again returns the same one", [again.created, again.workbench.id], [false, wb1.id]);
  check("the same task's branch from the setup table", (await benches.candidates(t1.id)).length, 1);

  section("status in words");
  check("ready", (await benches.status(wb1.id, { fresh: true })).words, "Ready");
  write(path.join(wb1.path, "work.txt"), "work\n");
  const dirty = await benches.status(wb1.id, { fresh: true });
  check("unsaved", [dirty.words, dirty.state, dirty.files], ["1 unsaved change", "unsaved", ["work.txt"]]);
  check("cached for ten seconds", (await benches.status(wb1.id)).checkedAt, dirty.checkedAt);
  await rejects("finish refuses unsaved work", benches.finish(wb1.id), /unsaved change.*work\.txt.*Commit them first/, "UNSAVED");
  const committed = await benches.commit(wb1.id, "work");
  check("unshared", [committed.words, committed.state], ["1 commit not shared yet", "unshared"]);
  await rejects("finish refuses unpushed work", benches.finish(wb1.id), /not shared yet\. Push first/, "UNSHARED");
  check("the folder is still there after both refusals", exists(path.join(wb1.path, "work.txt")), true);
  const pr0 = await benches.pr(wb1.id);
  check("no pull request before a push", pr0.via, null);
  const pushed = await benches.push(wb1.id);
  check("push", pushed, { ok: true, reason: null });
  check("ready after the push", (await benches.status(wb1.id, { fresh: true })).words, "Ready");
  check("the branch is on origin", gitOk(origin, "rev-parse", "--verify", `refs/heads/${wb1.branch}`), true);
  const pr1 = await benches.pr(wb1.id);
  check("a local origin has no compare page, and says so", [pr1.url, pr1.via, typeof pr1.reason], [null, null, "string"]);
  colleagueCommits("other.txt", "theirs\n", "colleague");
  git(app, "fetch", "--quiet", "origin");
  const behind = await benches.status(wb1.id, { fresh: true });
  check("behind", [behind.words, behind.state, behind.behind], ["Behind main by 1", "behind", 1]);
  const updated = await benches.update(wb1.id);
  check("update brings it in", [updated.ok, updated.conflict], [true, null]);
  check("the update needs a push again", /not shared yet/.test(updated.words), true);
  // A rebased branch cannot fast-forward the one already pushed, and push says
  // so in words rather than with git's hint block. It never forces.
  check("a push the remote rejects is explained", await benches.push(wb1.id),
    { ok: false, reason: "The remote has commits this branch does not. Update from the base first, then push again." });

  section("finish");
  const t2 = task("Finish me");
  const wb2 = (await benches.start(t2.id, { runSetup: false })).workbench;
  write(path.join(wb2.path, "done.txt"), "done\n");
  await benches.commit(wb2.id, "done");
  check("push before finish", (await benches.push(wb2.id)).ok, true);
  const finished = await benches.finish(wb2.id);
  check("finished", [finished.finished, finished.taskStatus], [true, "todo"]);
  check("the folder is gone", exists(wb2.path), false);
  check("the branch is kept", gitOk(app, "rev-parse", "--verify", `refs/heads/${wb2.branch}`), true);
  check("the row is finished", store.get(wb2.id).state, "finished");
  check("finish is on the Sheet", notes(t2.id).pop(), `finished workbench; the branch ${wb2.branch} is kept`);
  check("no longer live", store.live(t2.id), null);
  await rejects("finish twice", benches.finish(wb2.id), /already finished/, "CLOSED");

  section("update with a conflict");
  const t3 = task("Clash");
  const wb3 = (await benches.start(t3.id, { runSetup: false })).workbench;
  write(path.join(wb3.path, "shared.txt"), "mine\n");
  await benches.commit(wb3.id, "mine");
  colleagueCommits("shared.txt", "theirs\n", "theirs");
  const clash = await benches.update(wb3.id);
  check("stops on a conflict", [clash.ok, clash.conflict && clash.conflict.files], [false, ["shared.txt"]]);
  check("in words", /both change shared\.txt\. Nothing was changed/.test(clash.words), true);
  check("and leaves no rebase half done", [exists(path.join(git(wb3.path, "rev-parse", "--git-dir"), "rebase-merge")),
    fs.readFileSync(path.join(wb3.path, "shared.txt"), "utf8")], [false, "mine\n"]);
  write(path.join(wb3.path, "loose.txt"), "x\n");
  const refused = await benches.update(wb3.id);
  check("update refuses unsaved work", [refused.ok, /Commit the 1 unsaved change first/.test(refused.words)], [false, true]);

  section("existing branches");
  const t4 = task("Reuse local");
  const localBranch = `ray/${t4.id}-reuse-local`;
  git(app, "branch", localBranch, "origin/main");
  const localSha = git(app, "rev-parse", localBranch);
  const r4 = await benches.start(t4.id, { runSetup: false });
  check("reuses a local branch", [r4.workbench.branch, git(r4.workbench.path, "rev-parse", "HEAD")], [localBranch, localSha]);
  check("and says so", r4.warnings.some((w) => /existing branch/.test(w)), true);

  const t5 = task("Reuse remote");
  const remoteBranch = `ray/${t5.id}-reuse-remote`;
  git(seed, "checkout", "--quiet", "-b", remoteBranch);
  write(path.join(seed, "remote.txt"), "pushed elsewhere\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "from another machine");
  git(seed, "push", "--quiet", "origin", remoteBranch);
  const remoteSha = git(seed, "rev-parse", "HEAD");
  git(seed, "checkout", "--quiet", "main");
  const r5 = await benches.start(t5.id, { runSetup: false });
  check("reuses a branch only the remote had", git(r5.workbench.path, "rev-parse", "HEAD"), remoteSha);
  check("from the remote", r5.warnings.some((w) => /from the remote/.test(w)), true);
  check("and it is ready, not unshared", (await benches.status(r5.workbench.id, { fresh: true })).words, "Ready");

  const t6 = task("Busy elsewhere");
  const busyBranch = `ray/${t6.id}-busy-elsewhere`;
  const elsewhere = path.join(dir, "elsewhere");
  git(app, "worktree", "add", "--quiet", "-b", busyBranch, elsewhere, "origin/main");
  const busy = await rejects("a branch checked out elsewhere", benches.start(t6.id, { runSetup: false }),
    /already open in another folder: .*elsewhere\. Open that folder instead/, "CHECKED_OUT_ELSEWHERE");
  check("and the error carries the folder to offer Open on", busy && busy.path, fs.realpathSync(elsewhere));
  check("nothing was recorded", store.live(t6.id), null);

  section("side by side");
  const ta = task("Side A");
  const tb = task("Side B");
  const [ra, rb] = await Promise.all([benches.start(ta.id, { runSetup: false }), benches.start(tb.id, { runSetup: false })]);
  check("both started at once", [ra.created, rb.created], [true, true]);
  check("in different folders on different branches", [ra.workbench.path !== rb.workbench.path, ra.workbench.branch !== rb.workbench.branch], [true, true]);
  write(path.join(ra.workbench.path, "a.txt"), "a\n");
  check("work in one", (await benches.status(ra.workbench.id, { fresh: true })).words, "1 unsaved change");
  check("does not show in the other", (await benches.status(rb.workbench.id, { fresh: true })).words, "Ready");
  check("nor in the main checkout", gitOk(app, "diff", "--quiet") && !exists(path.join(app, "a.txt")), true);

  section("missing, recreate, forget");
  const tm = task("Goes missing");
  const wm = (await benches.start(tm.id, { runSetup: false })).workbench;
  write(path.join(wm.path, "m.txt"), "m\n");
  await benches.commit(wm.id, "kept on the branch");
  const keptSha = git(wm.path, "rev-parse", "HEAD");
  fs.rmSync(wm.path, { recursive: true, force: true });
  const kept = await benches.housekeep();
  check("housekeeping marks it missing", [kept.missing.includes(wm.id), store.get(wm.id).state], [true, "missing"]);
  check("status says Missing", (await benches.status(wm.id, { fresh: true })).words, "Missing");
  await rejects("finish refuses a missing one", benches.finish(wm.id), /is gone .*Recreate it, or forget it/, "MISSING");
  check("a missing one is still the task's", (await benches.start(tm.id, { runSetup: false })).workbench.id, wm.id);
  const back = await benches.recreate(wm.id);
  check("recreate puts it back on its branch", [back.state, git(back.path, "rev-parse", "HEAD"), exists(path.join(back.path, "m.txt"))], ["active", keptSha, true]);
  check(".env is copied again", exists(path.join(back.path, ".env")), true);
  await rejects("forget refuses while the folder is there", benches.forget(wm.id), /still there/, "NOT_MISSING");
  fs.rmSync(wm.path, { recursive: true, force: true });
  await benches.housekeep();
  check("forget", await benches.forget(wm.id), { forgotten: true });
  check("forgotten leaves the branch", gitOk(app, "rev-parse", "--verify", `refs/heads/${wm.branch}`), true);
  check("and is no longer live", store.live(tm.id), null);

  section("discard");
  const td = task("Throw away");
  const wd = (await benches.start(td.id, { runSetup: false })).workbench;
  write(path.join(wd.path, "c.txt"), "c\n");
  await benches.commit(wd.id, "only here");
  write(path.join(wd.path, "loose.txt"), "loose\n");
  const plan = await benches.discardPlan(wd.id);
  check("the plan lists unsaved files and lonely commits", [plan.unsaved, plan.commits.map((c) => c.subject), plan.branchPushed], [["loose.txt"], ["only here"], false]);
  await rejects("a wrong confirm", benches.discard(wd.id, "nope"), new RegExp(`Type ${td.id}, the task's number`), "CONFIRM");
  check("and nothing went", exists(path.join(wd.path, "loose.txt")), true);
  const gone = await benches.discard(wd.id, ` ${td.id} `);
  check("discarded, branch deleted", [gone.discarded, gone.branchDeleted, gone.keptRemote], [true, true, null]);
  check("folder gone, branch gone", [exists(wd.path), gitOk(app, "rev-parse", "--verify", `refs/heads/${wd.branch}`)], [false, false]);
  check("the Sheet records what went, and how to get it back", notes(td.id).pop(),
    `discarded workbench with 1 unsaved file (loose.txt), 1 local commit; the branch ${wd.branch} was deleted. ` +
    `Everything in it is kept until ${gone.until} as refs/delphi/discarded/${td.id}-${wd.id}. To get it back: ` +
    `git -C ${fs.realpathSync(app)} worktree add -b ${wd.branch}-recovered ${wd.path} refs/delphi/discarded/${td.id}-${wd.id}`);

  const tp = task("Throw away pushed");
  const wp = (await benches.start(tp.id, { runSetup: false })).workbench;
  write(path.join(wp.path, "p.txt"), "p\n");
  await benches.commit(wp.id, "pushed");
  await benches.push(wp.id);
  write(path.join(wp.path, "scratch.txt"), "s\n");
  const pplan = await benches.discardPlan(wp.id);
  check("a pushed branch is known as pushed", [pplan.branchPushed, pplan.remote, pplan.unsaved], [true, `origin/${wp.branch}`, ["scratch.txt"]]);
  const pgone = await benches.discard(wp.id, String(tp.id));
  check("a pushed branch is kept, and where is said", [pgone.branchDeleted, pgone.keptRemote], [false, `origin/${wp.branch}`]);
  check("still there locally and on origin", [gitOk(app, "rev-parse", "--verify", `refs/heads/${wp.branch}`), gitOk(origin, "rev-parse", "--verify", `refs/heads/${wp.branch}`)], [true, true]);
  check("the note says where", /kept on the remote as origin\//.test(notes(tp.id).pop()), true);

  section("orphans");
  const to1 = task("Orphan task");
  const orphanBranch = `ray/${to1.id}-orphan-task`;
  const orphanPath = path.join(path.dirname(appReal), "app.workbenches", `${to1.id}-orphan-task`);
  git(app, "worktree", "add", "--quiet", "-b", orphanBranch, orphanPath, "origin/main");
  const strayPath = path.join(path.dirname(appReal), "app.workbenches", "stray");
  git(app, "worktree", "add", "--quiet", "-b", "feature/stray", strayPath, "origin/main");
  const found = await benches.housekeep();
  const adopted = store.live(to1.id);
  check("an orphan with a Delphi branch is adopted", [Boolean(adopted), adopted && found.adopted.includes(adopted.id), adopted && adopted.branch], [true, true, orphanBranch]);
  check("anything else is reported, not taken", found.unmanaged.map((u) => [u.branch, path.basename(u.path)]), [["feature/stray", "stray"]]);
  check("and shown under Advanced", benches.advanced(adopted.id).unmanaged.length, 1);
  check("Advanced has the real commands", benches.advanced(adopted.id).commands[0], `cd ${adopted.path}`);
  check("adopting twice does nothing", (await benches.housekeep()).adopted, []);

  section("setup runs as a recorded command");
  const repoRow = db.handle().prepare("SELECT * FROM repos WHERE project_id = ?").get(project.id);
  check("setup detected once and stored", repoRow.setup_cmd, "");
  store.updateRepo(repoRow.id, { setup_cmd: "echo set up > setup-ran.txt" });
  const ts = task("With setup");
  const rs = await benches.start(ts.id);
  check("setup ran in the folder", [rs.setup_entry && rs.setup_entry.kind, rs.setup_entry && rs.setup_entry.meta.state, exists(path.join(rs.workbench.path, "setup-ran.txt"))], ["run", "ok", true]);
  check("its cwd is the Workbench", rs.setup_entry.meta.cwd, rs.workbench.path);
  store.updateRepo(repoRow.id, { setup_cmd: "" });
  await rejects("a two line setup command is refused", Promise.resolve().then(() => store.updateRepo(repoRow.id, { setup_cmd: "a\nb" })), /one line/);
  await rejects("a bad base branch is refused", Promise.resolve().then(() => store.updateRepo(repoRow.id, { base_branch: "../x" })), /not a branch name/);

  section("DELPHI_WORKBENCH_DIR");
  const override = path.join(dir, "wbroot");
  process.env.DELPHI_WORKBENCH_DIR = override;
  const tw = task("Elsewhere please");
  const rw = await benches.start(tw.id, { runSetup: false });
  check("folders go under the override", rw.workbench.path, path.join(fs.realpathSync(override), "app", `${tw.id}-elsewhere-please`));
  delete process.env.DELPHI_WORKBENCH_DIR;

  section("offline and no remote");
  const offline = path.join(work, "offline");
  execFileSync(GIT, ["clone", "--quiet", origin, offline], { stdio: "ignore" });
  git(offline, "remote", "set-url", "origin", path.join(dir, "no-such-origin.git"));
  const offProject = db.createProject({ key: "off", name: "Offline", path: offline });
  const toff = db.createTask({ projectId: offProject.id, title: "On a train" });
  const roff = await benches.start(toff.id, { runSetup: false });
  check("an unreachable remote uses the local copy", [roff.created, roff.warnings.some((w) => /using your local copy of main/.test(w))], [true, true]);
  const lonely = path.join(work, "lonely");
  fs.mkdirSync(lonely);
  git(lonely, "init", "--quiet", "-b", "main");
  write(path.join(lonely, "a.txt"), "a\n");
  git(lonely, "add", "-A");
  git(lonely, "commit", "--quiet", "-m", "a");
  const loneProject = db.createProject({ key: "lone", name: "Lonely", path: lonely });
  const tl = db.createTask({ projectId: loneProject.id, title: "No remote" });
  const rl = await benches.start(tl.id, { runSetup: false });
  check("no remote at all also uses the local copy", rl.warnings.some((w) => /no remote, so using your local copy of main/.test(w)), true);
  write(path.join(rl.workbench.path, "b.txt"), "b\n");
  await benches.commit(rl.workbench.id, "b");
  check("with nowhere to share to, a commit is not unshared", (await benches.status(rl.workbench.id, { fresh: true })).words, "Ready");
  check("push says why not", (await benches.push(rl.workbench.id)).reason, "This repository has no remote called origin, so there is nowhere to push to.");
  check("finish keeps the branch locally", [(await benches.finish(rl.workbench.id)).finished, gitOk(lonely, "rev-parse", "--verify", `refs/heads/${rl.workbench.branch}`)], [true, true]);

  section("submodules");
  const sub = path.join(work, "withsub");
  fs.mkdirSync(sub);
  git(sub, "init", "--quiet", "-b", "main");
  write(path.join(sub, ".gitmodules"), "[submodule \"lib\"]\n\tpath = lib\n\turl = ../lib.git\n");
  git(sub, "add", "-A");
  git(sub, "commit", "--quiet", "-m", "sub");
  const subProject = db.createProject({ key: "sub", name: "Sub", path: sub });
  const rsub = await benches.start(db.createTask({ projectId: subProject.id, title: "Has submodules" }).id, { runSetup: false });
  check("Start warns about submodules and still works", [rsub.created, rsub.warnings.some((w) => /submodules/.test(w))], [true, true]);

  section("choosing a repository");
  const multi = db.createProject({ key: "multi", name: "Multi" });
  const repoA = path.join(work, "multi-a");
  const repoB = path.join(work, "multi-b");
  for (const r of [repoA, repoB]) execFileSync(GIT, ["clone", "--quiet", origin, r], { stdio: "ignore" });
  db.createRepo({ projectId: multi.id, name: "a", path: repoA });
  const rowB = db.createRepo({ projectId: multi.id, name: "b", path: repoB });
  const tmulti = db.createTask({ projectId: multi.id, title: "Which one" });
  const which = await rejects("several repositories and none primary", benches.start(tmulti.id, { runSetup: false }),
    /several repositories and none is marked primary: a \(.*multi-a\), b \(.*multi-b\)\. Say which one/, "WHICH_REPO");
  check("the refusal carries the list", which && which.candidates.map((c) => c.name), ["a", "b"]);
  const chosen = await benches.start(tmulti.id, { repoId: rowB.id, runSetup: false });
  check("naming one works", chosen.workbench.repo_name, "b");
  const byName = await benches.start(db.createTask({ projectId: multi.id, title: "By name" }).id, { repo: "a", runSetup: false });
  check("so does naming it by name", byName.workbench.repo_name, "a");
  const wsProject = db.createProject({ key: "ws", name: "Workspace only" });
  const wsRepo = path.join(work, "ws-repo");
  execFileSync(GIT, ["clone", "--quiet", origin, wsRepo], { stdio: "ignore" });
  const space = db.createWorkspace({ name: "ws-repo", path: wsRepo });
  db.linkProjectWorkspace(wsProject.id, space.id, { primary: true });
  const rws = await benches.start(db.createTask({ projectId: wsProject.id, title: "From a workspace" }).id, { runSetup: false });
  check("a workspace folder is adopted into repos", [rws.created,
    db.handle().prepare("SELECT path, is_primary FROM repos WHERE project_id = ?").all(wsProject.id).map((r) => [r.path, r.is_primary])],
    [true, [[fs.realpathSync(wsRepo), 1]]]);
  const loose = db.createTask({ title: "No project" });
  await rejects("a task with no project", benches.start(loose.id), /not in a project/, "NO_PROJECT");

  await mcp(t1);
  cli();

  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Through the MCP server, as an agent sees it

async function mcp(t1) {
  delete process.env.ELECTRON_RUN_AS_NODE;
  section("the MCP tools");
  const agent = openServer({ actor: "claude-code:3", env: { DELPHI_AUTHOR_TYPE: "agent", DELPHI_BRANCH_PREFIX: "agent" }, clientName: "test", warn: () => {} });
  await agent.start();
  try {
    const names = (await agent.request("tools/list", {})).tools.map((t) => t.name);
    for (const t of ["workbench_start", "workbench_status", "workbench_finish", "workbench_list"]) check(`${t} is listed`, names.includes(t), true);
    check("no discard tool is listed", names.filter((n) => /discard/.test(n)), []);
    check("nor any of the command line's own", names.filter((n) => /^workbench_(park|commit|push|forget|housekeep)/.test(n)), []);
    await rejects("internal tools refuse anyone but the command line", agent.call("workbench_discard", { task_id: t1.id, typed: String(t1.id) }), /Unknown tool workbench_discard/);

    const tm = task("Agent work");
    const made = await agent.call("workbench_start", { task_id: tm.id, run_setup: false });
    check("an agent starts one", [made.created, made.workbench.branch, made.workbench.owner], [true, `agent/${tm.id}-agent-work`, "claude-code:3"]);
    const status = await agent.call("workbench_status", { task_id: tm.id });
    check("and reads its status", status.status.words, "Ready");
    check("no Workbench reads as null", await agent.call("workbench_status", { task_id: task("none").id }), { workbench: null });
    const resolved = await agent.call("sheet_resolve", { task: String(tm.id) });
    check("$ runs default to the Workbench", [resolved.cwd, resolved.cwd_source, resolved.workbench.id], [made.workbench.path, "workbench", made.workbench.id]);
    const plain = await agent.call("sheet_resolve", { task: String(task("no bench").id) });
    check("without one, the project's repo", [plain.cwd, plain.cwd_source], [fs.realpathSync(app), "repo"]);
    const listed = await agent.call("workbench_list", { project: "wb" });
    check("listed with status words", listed.some((w) => w.id === made.workbench.id && w.status.words === "Ready"), true);
    write(path.join(made.workbench.path, "agent.txt"), "x\n");
    await rejects("workbench_finish refuses unsaved work", agent.call("workbench_finish", { task_id: tm.id }), /unsaved change.*agent\.txt/);
    const closed = await agent.call("update_task", { id: tm.id, status: "done" });
    check("done still succeeds", closed.status, "done");
    check("and tells the agent a person will Finish it", closed.workbench && closed.workbench.note,
      `This task still has a live Workbench at ${made.workbench.path}. A person will Finish it; do not remove the folder or the branch yourself.`);
    check("the folder was left alone", exists(path.join(made.workbench.path, "agent.txt")), true);
    const notDone = await agent.call("update_task", { id: tm.id, title: "Agent work, renamed" });
    check("no notice on other updates", notDone.workbench, undefined);

    // Two agents, two processes, one repository, at once.
    const other = openServer({ actor: "claude-code:4", clientName: "test", warn: () => {} });
    await other.start();
    try {
      const [x, y] = await Promise.all([
        agent.call("workbench_start", { task_id: task("Race X").id, run_setup: false }),
        other.call("workbench_start", { task_id: task("Race Y").id, run_setup: false }),
      ]);
      check("concurrent starts from two processes both succeed", [x.created, y.created, x.workbench.path !== y.workbench.path], [true, true, true]);
    } finally {
      other.close();
    }
  } finally {
    agent.close();
  }

  // The binary route substitutes literals, so the same calls are made there once.
  const binary = openServer({ actor: "claude-code:5", env: { DELPHI_SQLITE_ROUTE: "binary" }, clientName: "test", warn: () => {} });
  await binary.start();
  try {
    const tb = task("Binary route");
    const made = await binary.call("workbench_start", { task_id: tb.id, run_setup: false });
    check("the sqlite3 route starts one too", [made.created, typeof made.workbench.id], [true, "number"]);
    check("and lists it", (await binary.call("workbench_list", {})).some((w) => w.id === made.workbench.id), true);
  } finally {
    binary.close();
  }
}

// ---------------------------------------------------------------------------
// The command line

function cli() {
  section("the command line");
  const CLI = path.join(__dirname, "..", "bin", "delphi");
  const run = (args, env = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DELPHI_ACTOR: "ray", ...env }, encoding: "utf8", timeout: 120000,
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const tc = task("From the shell");
  const first = run(["work", String(tc.id), "--path"]);
  const row = store.live(tc.id);
  check("work --path makes one and prints it", [first.code, first.out.trim()], [0, row && row.path]);
  check("again prints the same", run(["work", String(tc.id), "--path"]).out.trim(), row.path);
  const benchesOut = run(["benches", "--project", "wb"]);
  check("benches lists it, tab separated when piped", benchesOut.out.split("\n").some((l) => l === [tc.id, "active", "Ready", row.branch, row.path].join("\t")), true);
  check("status for one", run(["status", String(tc.id)]).out.trim(), `#${tc.id}  Ready`);
  const park = run(["park", String(tc.id)]);
  check("park", [park.code, store.live(tc.id).state], [0, "parked"]);
  check("work picks a parked one up again", [run(["work", String(tc.id), "--path"]).code, store.live(tc.id).state], [0, "active"]);
  check("update", run(["update", String(tc.id)]).code, 0);
  const discard = run(["discard", String(tc.id)]);
  check("discard refuses without a terminal", [discard.code, /only runs at a terminal/.test(discard.err), exists(row.path)], [1, true, true]);
  write(path.join(row.path, "x.txt"), "x\n");
  const fin = run(["finish", String(tc.id)]);
  check("finish without a terminal refuses unsaved work in words", [fin.code, /unsaved change.*x\.txt/.test(fin.err)], [1, true]);
  const done = run(["done", String(tc.id)]);
  check("done marks the task and points at finish", [done.code, /Task \d+ is done/.test(done.out), /still has a Workbench .* delphi finish/.test(done.err)], [0, true, true]);
  const init = run(["shell-init", "zsh"]);
  check("shell-init defines work with a real cd", [init.code, /work\(\) \{/.test(init.out), /cd "\$dir"/.test(init.out)], [0, true, true]);
  check("shell-init refuses fish", run(["shell-init", "fish"]).code, 1);
  check("the shell's run defaults to the Workbench", (() => {
    const r = run(["run", String(tc.id), "--", "pwd"]);
    return r.out.trim();
  })(), row.path);
  const off = task("Gone from the shell");
  const offRow = (run(["work", String(off.id), "--path"]), store.live(off.id));
  fs.rmSync(offRow.path, { recursive: true, force: true });
  const st = run(["status", String(off.id)]);
  check("status runs housekeeping and shows Missing", /Missing/.test(st.out), true);
  check("work puts a missing folder back", [run(["work", String(off.id), "--path"]).code, exists(offRow.path), store.live(off.id).state], [0, true, "active"]);
}

main().catch((error) => { console.error(error); process.exit(1); });
