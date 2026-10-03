#!/usr/bin/env node
// The queue runner, through the shared MCP client, on both database routes.
//
//   electron --no-sandbox tools/runner_test.js
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/runner_test.js
//
// The runner's client moved into sheet/client.js and its spawning helpers into
// agent/launch.js. Neither move was meant to change anything a person can see,
// so the dry run is compared line for line with tools/fixtures/runner/dry_run.txt,
// which was captured from the runner before the move. Then a real pass with a
// fake agent, so the claim, the comment and the completion are proved to still
// go through the server.
//
// Needs node:sqlite to seed the database, hence Electron. Every child is the
// same Electron binary with ELECTRON_RUN_AS_NODE=1, because a test run as
// `electron file.js` would otherwise start the app when it spawns itself.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-runner-"));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const launch = require("../agent/launch");
const runner = require("../agent/queue_runner");

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

const RUNNER = path.join(__dirname, "..", "agent", "queue_runner.js");
const home = path.join(dir, "home");
const cwd = path.join(dir, "cwd");
fs.mkdirSync(home);
fs.mkdirSync(cwd);

function runRunner(args, extraEnv = {}) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      // guardStatus reads ~/.claude/settings.json; an empty home makes the
      // answer the same on every machine.
      HOME: home,
      USERPROFILE: home,
      DELPHI_DB: process.env.DELPHI_DB,
      ...extraEnv,
    },
  });
}

// ---------------------------------------------------------------------------

section("requiring the runner does not run it");

check("exports the brief", typeof runner.buildBrief, "function");
check("and the helpers it shares", [runner.splitCommand, runner.resolveBinary, runner.guardStatus],
      [launch.splitCommand, launch.resolveBinary, launch.guardStatus]);
check("splitCommand honours quotes", launch.splitCommand(`claude -p "two words" 'and \\ this' ""`),
      ["claude", "-p", "two words", "and \\ this", ""]);
check("an unbalanced quote", (() => { try { launch.splitCommand('a "b'); return null; } catch (e) { return e.message; } })(),
      'Unbalanced " in the agent command');
check("a missing binary is null", launch.resolveBinary("delphi-no-such-binary-anywhere"), null);
check("no guard in an empty home", launch.guardStatus(cwd).installed, false);
fs.mkdirSync(path.join(cwd, ".claude"));
fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), JSON.stringify({
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "python3 /x/agent/guard.py" }] }] },
}));
check("a guard in the project settings is found", launch.guardStatus(cwd).installed, true);
fs.rmSync(path.join(cwd, ".claude"), { recursive: true });

// ---------------------------------------------------------------------------
// The same rows the golden file was captured against. Changing anything here
// changes the brief, and the golden file with it.

const project = db.createProject({ key: "run-test", name: "Runner test" });
const first = db.createTask({ projectId: project.id, title: "first queued", detail: "Do the first thing.\nCarefully.", priority: "high" });
const second = db.createTask({ projectId: project.id, title: "second queued", priority: "low" });
db.createComment({ taskId: first.id, body: "Tried X, it failed with :p1 and $& in it", author: "claude-code:3" });
db.createComment({ taskId: first.id, body: "multi\nline\n\n```\n$ ls\n```", author: "ray" });
db.setQueue(first.id, "ready");
db.setQueue(second.id, "ready");
db.handle().exec("PRAGMA wal_checkpoint(TRUNCATE)");

const golden = fs.readFileSync(path.join(__dirname, "fixtures", "runner", "dry_run.txt"), "utf8");
const agentPath = launch.resolveBinary("cat");

for (const [route, env] of [["node:sqlite", {}], ["sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" }]]) {
  section(`dry run, ${route}`);
  const result = runRunner(["--dry-run", "--agent", "cat -n", "--cwd", cwd, "--project", "run-test"], env);
  check("exits cleanly", result.status, 0);
  const stdout = result.stdout
    .split("\n").map((line) => line.replace(/^\[\d\d:\d\d:\d\d\] /, "")).join("\n")
    .split(cwd).join("<CWD>")
    .split(agentPath).join("<AGENT>")
    .replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/g, "<T>");
  check("prints exactly what it printed before the move", stdout, golden);
  if (stdout !== golden) {
    const a = stdout.split("\n");
    const b = golden.split("\n");
    const at = a.findIndex((line, i) => line !== b[i]);
    console.error(`       first difference at line ${at + 1}:\n       got  ${JSON.stringify(a[at])}\n       want ${JSON.stringify(b[at])}`);
  }
  check("warns about the guard on stderr",
        result.stderr.replace(/^\[\d\d:\d\d:\d\d\] /gm, "").trim(),
        "WARNING: agent/guard.py is not installed as a PreToolUse hook for Bash.");
  check("claims nothing", db.sqlP("SELECT COUNT(*) AS n FROM tasks WHERE claimed_by IS NOT NULL")[0].n, 0);
}

// ---------------------------------------------------------------------------

section("a real pass with a fake agent");

const agent = path.join(dir, "agent.js");
fs.writeFileSync(agent, [
  "const brief = process.argv[process.argv.length - 1];",
  "const m = /# Task (\\d+):/.exec(brief);",
  "if (m && m[1] === process.env.CANNOT_TASK) { console.log('CANNOT the fixture says no'); process.exit(0); }",
  "console.log('Did the thing for task ' + (m ? m[1] : '?') + '. Quotes \\' and :p1 and $& survive.');",
].join("\n"));
const agentCmd = `"${process.execPath}" "${agent}"`;

for (const [route, env] of [["node:sqlite", {}], ["sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" }]]) {
  const task = db.createTask({ projectId: project.id, title: `real run on ${route}`, priority: "high" });
  // Alone in the queue, so --max 1 can only take this one.
  db.sqlP("UPDATE tasks SET queue = NULL");
  db.setQueue(task.id, "ready");
  const result = runRunner(["--once", "--max", "1", "--allow-unguarded", "--agent", agentCmd, "--cwd", cwd,
                            "--project", "run-test", "--timeout", "30", "--actor", `runner-${route}`], env);
  check(`${route}: exits cleanly`, result.status, 0);
  const after = db.sqlP("SELECT status, claimed_by, queue FROM tasks WHERE id = :p1", [task.id])[0];
  check(`${route}: the task is done and let go`, after, { status: "done", claimed_by: null, queue: null });
  const comment = db.sqlP("SELECT author, body FROM comments WHERE task_id = :p1 ORDER BY id DESC LIMIT 1", [task.id])[0];
  check(`${route}: the agent's words are the summary, verbatim`,
        comment && comment.body.split("\n")[0], `Did the thing for task ${task.id}. Quotes ' and :p1 and $& survive.`);
  check(`${route}: attributed to the runner`, comment && comment.author, `runner-${route}`);
  const audit = db.sqlP("SELECT summary FROM audit WHERE entity = 'task' AND entity_id = :p1 ORDER BY id", [task.id]).map((r) => r.summary);
  check(`${route}: claimed then done, by the runner`, audit.slice(-2),
        [`claimed by runner-${route} (by runner-${route})`, `status to done (by runner-${route})`]);
}

section("an agent that hands the work back");

const refused = db.createTask({ projectId: project.id, title: "cannot do this", priority: "high" });
db.sqlP("UPDATE tasks SET queue = NULL");
db.setQueue(refused.id, "ready");
const refusal = runRunner(["--once", "--max", "1", "--allow-unguarded", "--agent", agentCmd, "--cwd", cwd,
                           "--project", "run-test", "--timeout", "30"], { CANNOT_TASK: String(refused.id) });
check("exits cleanly", refusal.status, 0);
check("goes back to the pool", db.sqlP("SELECT status, claimed_by, queue FROM tasks WHERE id = :p1", [refused.id])[0],
      { status: "todo", claimed_by: null, queue: "ready" });
check("with the reason", db.sqlP("SELECT body FROM comments WHERE task_id = :p1 ORDER BY id DESC LIMIT 1", [refused.id])[0].body,
      "Released: the fixture says no");

// ---------------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
