#!/usr/bin/env node
// The queue runner with --workbenches: two agents at once in one repository.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/runner_workbench_test.js
//
// The point of a Workbench per task is that concurrency above 1 stops being a
// way for two agents to trample each other's files in one checkout. So this
// runs two fake agents at the same time against one throwaway repository and
// checks that their times overlapped and that each one's work landed only in
// its own folder and on its own branch, with the main checkout untouched and
// both Workbenches left for a person to review.
//
// Everything is in a temp directory, and git sees none of the owner's own
// configuration.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-runner-wb-")));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const home = path.join(dir, "home");
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, ".gitconfig"),
  "[user]\n\tname = Delphi Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  GIT_AUTHOR_NAME: "Delphi Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Delphi Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
  DELPHI_GH: "none",
});
for (const name of ["DELPHI_WORKBENCH_DIR", "DELPHI_BRANCH_PREFIX", "GIT_DIR", "GIT_WORK_TREE", "DELPHI_ACTOR"]) delete process.env[name];

const db = require("../db");
const GIT = require("../git").findGit();
const RUNNER = path.join(__dirname, "..", "agent", "queue_runner.js");

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}
function section(name) { console.log(`\n${name}`); }
const git = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8" }).trim();

// --- a repository with an origin ------------------------------------------------------

const origin = path.join(dir, "origin.git");
const app = path.join(dir, "code", "app");
execFileSync(GIT, ["init", "--quiet", "--bare", "-b", "main", origin]);
fs.mkdirSync(path.dirname(app), { recursive: true });
execFileSync(GIT, ["clone", "--quiet", origin, app], { stdio: "ignore" });
fs.writeFileSync(path.join(app, "README.md"), "hello\n");
git(app, "add", "-A");
git(app, "commit", "--quiet", "-m", "first");
git(app, "push", "--quiet", "origin", "main");
const mainHead = git(app, "rev-parse", "HEAD");

const project = db.createProject({ key: "wbr", name: "Runner benches", path: app });

// An agent that takes its time, so two of them overlap, and records where it
// was and when. It writes a file named for its task and commits it.
const agentLogs = path.join(dir, "agent-logs");
fs.mkdirSync(agentLogs);
const agent = path.join(dir, "agent.js");
fs.writeFileSync(agent, `
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const brief = process.argv[process.argv.length - 1];
const id = (/# Task (\\d+):/.exec(brief) || [])[1];
const started = Date.now();
const git = (...a) => execFileSync(${JSON.stringify(GIT)}, a, { encoding: "utf8" }).trim();
fs.writeFileSync("task-" + id + ".txt", "work for task " + id + "\\n");
const until = Date.now() + 1500;
while (Date.now() < until) {}
git("add", "task-" + id + ".txt");
git("commit", "--quiet", "-m", "task " + id);
fs.writeFileSync(path.join(${JSON.stringify(agentLogs)}, id + ".json"), JSON.stringify({
  id: Number(id), cwd: process.cwd(), branch: git("rev-parse", "--abbrev-ref", "HEAD"),
  started, ended: Date.now(), workbenchBrief: brief.includes("task's Workbench"),
}));
console.log("Did task " + id + ".");
`);
const agentCmd = `"${process.execPath}" "${agent}"`;
const logOf = (id) => JSON.parse(fs.readFileSync(path.join(agentLogs, `${id}.json`), "utf8"));

function runRunner(args) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: "utf8", timeout: 120000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
}

const base = ["--allow-unguarded", "--agent", agentCmd, "--project", "wbr", "--timeout", "60", "--idle", "1"];

// --- two at once ------------------------------------------------------------------------

section("two agents at once, each in its own Workbench");
const a = db.createTask({ projectId: project.id, title: "first change", priority: "high" });
const b = db.createTask({ projectId: project.id, title: "second change", priority: "high" });
db.setQueue(a.id, "ready");
db.setQueue(b.id, "ready");
const r = runRunner([...base, "--workbenches", "--concurrency", "2", "--max", "2", "--once", "--cwd", app]);
check("the runner exits cleanly", [r.status, r.status ? r.stderr : ""], [0, ""]);
const la = logOf(a.id);
const lb = logOf(b.id);
check("they ran at the same time", la.started < lb.ended && lb.started < la.ended, true);
const benches = db.sqlP("SELECT task_id, path, branch, state FROM workbenches ORDER BY task_id");
check("each task has a Workbench", benches.map((w) => w.task_id), [a.id, b.id]);
check("each agent ran in its own", [fs.realpathSync(la.cwd), fs.realpathSync(lb.cwd)], benches.map((w) => fs.realpathSync(w.path)));
check("on its own branch", [la.branch, lb.branch], benches.map((w) => w.branch));
check("the folders differ", la.cwd !== lb.cwd, true);
check("the brief says where it is", [la.workbenchBrief, lb.workbenchBrief], [true, true]);
check("a's folder has only a's work", fs.existsSync(path.join(la.cwd, `task-${b.id}.txt`)), false);
check("b's folder has only b's work", fs.existsSync(path.join(lb.cwd, `task-${a.id}.txt`)), false);
check("a's branch carries exactly a's commit", git(app, "log", "--format=%s", `main..${la.branch}`), `task ${a.id}`);
check("b's branch carries exactly b's commit", git(app, "log", "--format=%s", `main..${lb.branch}`), `task ${b.id}`);
check("the main checkout is untouched", [git(app, "rev-parse", "HEAD"), git(app, "rev-parse", "--abbrev-ref", "HEAD"), git(app, "status", "--porcelain")], [mainHead, "main", ""]);
check("both Workbenches are left active for review", benches.map((w) => w.state), ["active", "active"]);
for (const t of [a, b]) {
  const row = db.sqlP("SELECT status, claimed_by FROM tasks WHERE id = :p1", [t.id])[0];
  check(`task ${t.id} is done and let go`, row, { status: "done", claimed_by: null });
  const summary = db.sqlP("SELECT body FROM comments WHERE task_id = :p1 ORDER BY id DESC LIMIT 1", [t.id])[0].body;
  check(`task ${t.id}'s summary says where the work is`, summary.includes("left for a person to review and finish"), true);
}

section("off by default");
{
  const c = db.createTask({ projectId: project.id, title: "plain run", priority: "high" });
  db.sqlP("UPDATE tasks SET queue = NULL");
  db.setQueue(c.id, "ready");
  const cwd = path.join(dir, "plain");
  fs.mkdirSync(cwd);
  execFileSync(GIT, ["init", "--quiet", cwd]);
  const plain = runRunner([...base, "--max", "1", "--once", "--cwd", cwd]);
  check("exits cleanly", plain.status, 0);
  check("the agent ran in --cwd", fs.realpathSync(logOf(c.id).cwd), fs.realpathSync(cwd));
  check("and no Workbench was made", db.sqlP("SELECT COUNT(*) AS n FROM workbenches WHERE task_id = :p1", [c.id])[0].n, 0);
  check("the brief says nothing about one", logOf(c.id).workbenchBrief, false);
  check("--help says it is off by default", /Off by default in this release/.test(runRunner(["--help"]).stdout), true);
}

section("a parked Workbench is set aside, and the queue moves on");
{
  const d = db.createTask({ projectId: project.id, title: "parked one", priority: "high" });
  db.sqlP("UPDATE tasks SET queue = NULL");
  db.setQueue(d.id, "ready");
  const first = runRunner([...base, "--workbenches", "--max", "1", "--once", "--cwd", app]);
  check("first pass works it", first.status, 0);
  db.sqlP("UPDATE tasks SET status = 'todo', queue = 'ready' WHERE id = :p1", [d.id]);
  db.sqlP("UPDATE workbenches SET state = 'parked' WHERE task_id = :p1", [d.id]);
  fs.rmSync(path.join(agentLogs, `${d.id}.json`));
  // A task behind it, lower down the queue: it must not be starved.
  const behind = db.createTask({ projectId: project.id, title: "behind the parked one", priority: "low" });
  db.setQueue(behind.id, "ready");
  const again = runRunner([...base, "--workbenches", "--max", "1", "--once", "--cwd", app]);
  check("exits cleanly", again.status, 0);
  check("the agent was not started for the parked one", fs.existsSync(path.join(agentLogs, `${d.id}.json`)), false);
  check("it is taken out of the pool, unclaimed", db.sqlP("SELECT status, claimed_by FROM tasks WHERE id = :p1", [d.id])[0], { status: "blocked", claimed_by: null });
  const notes = () => db.sqlP("SELECT body, promoted FROM comments WHERE task_id = :p1 AND body LIKE 'Released:%' ORDER BY id", [d.id]);
  check("with one promoted note saying why", [notes().length, notes()[0].promoted, /^Released: Its Workbench is parked.*Marked blocked/.test(notes()[0].body)], [1, 1, true]);
  check("and the task behind it was worked in the same run", [fs.existsSync(path.join(agentLogs, `${behind.id}.json`)), db.sqlP("SELECT status FROM tasks WHERE id = :p1", [behind.id])[0].status], [true, "done"]);
  check("the parked Workbench is untouched", db.sqlP("SELECT state FROM workbenches WHERE task_id = :p1", [d.id])[0].state, "parked");
  // A person sets it back to todo without resuming the Workbench: set aside
  // again, but the same long note is not written twice in a row.
  db.sqlP("UPDATE tasks SET status = 'todo' WHERE id = :p1", [d.id]);
  runRunner([...base, "--workbenches", "--max", "1", "--once", "--cwd", app]);
  const bodies = notes().map((n) => n.body);
  check("blocked again, with a short note rather than the same one", [db.sqlP("SELECT status FROM tasks WHERE id = :p1", [d.id])[0].status, bodies.length, bodies[1]],
    ["blocked", 2, "Released: Still blocked for the reason released with above."]);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
