#!/usr/bin/env node
// The dispatcher (agent/dispatch.js): jobs from handoffs, queues and people,
// run several at once, each code-changing one in its own Workbench.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/dispatch_test.js
//
// No agent CLI is ever called. Claude Code, Codex and Copilot are each the
// fake in tools/fixtures/chat replaying a stream written here, through a
// wrapper in the temp folder that the harness rows point at, and the test
// refuses to start if any row points anywhere else. Everything lives in a
// temp directory, and git sees none of the owner's configuration.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-dispatch-")));
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
  HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  GIT_AUTHOR_NAME: "Delphi Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Delphi Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
  DELPHI_GH: "none",
});
for (const name of ["DELPHI_WORKBENCH_DIR", "DELPHI_BRANCH_PREFIX", "GIT_DIR", "GIT_WORK_TREE", "DELPHI_ACTOR", "DELPHI_SESSION", "DELPHI_CLIENT"]) delete process.env[name];

const db = require("../db");
const harness = require("../harness");
const GIT = require("../git").findGit();
const { createDispatcher, checkArgv, jobCommand } = require("../agent/dispatch");
const jobsStore = require("../agent/jobs");
const { makeSheetStore, pidAlive } = require("../sheet/store");
const { makeWorkbenchStore } = require("../workbench/store");
const { createWorkbench } = require("../workbench/workbench");
const { runEntry } = require("../sheet/run");
const { openServer } = require("../sheet/client");

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  } else {
    console.log(`  ok   ${what}`);
  }
}
function section(name) { console.log(`\n${name}`); }
const git = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, ms = 20000) {
  const until = Date.now() + ms;
  for (;;) {
    let value;
    try { value = fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

// --- a repository with an origin, and a project on it ----------------------------------

const origin = path.join(dir, "origin.git");
const app = path.join(dir, "code", "app");
execFileSync(GIT, ["init", "--quiet", "--bare", "-b", "main", origin]);
fs.mkdirSync(path.dirname(app), { recursive: true });
execFileSync(GIT, ["clone", "--quiet", origin, app], { stdio: "ignore" });
fs.writeFileSync(path.join(app, "README.md"), "hello\n");
git(app, "add", "-A");
git(app, "commit", "--quiet", "-m", "first");
git(app, "push", "--quiet", "origin", "main");

const project = db.createProject({ key: "jobs", name: "Jobs", path: app });
// A folder is one project's, so the other projects below get their own clone
// of the same repository rather than sharing this one.
const cloneOf = (name) => {
  const to = path.join(dir, "code", name);
  execFileSync(GIT, ["clone", "--quiet", origin, to], { stdio: "ignore" });
  return to;
};

// The guard, as Claude Code would find it: a PreToolUse hook for Bash.
fs.mkdirSync(path.join(home, ".claude"));
fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "python3 /x/agent/guard.py" }] }] },
}));

// --- the fake agents ---------------------------------------------------------------------

const FIX = path.join(__dirname, "fixtures", "chat");
const fixtures = path.join(dir, "fixtures");
fs.mkdirSync(fixtures);
const agentLog = path.join(dir, "agent-log.jsonl");
const agentTimes = path.join(dir, "agent-times.jsonl");
const fixture = (name, lines) => {
  const file = path.join(fixtures, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
};

// The three jobs that must overlap meet here: none finishes until all three
// have started, so a dispatcher that ran them one after another would hold
// the first for the whole bound and fail the overlap check.
const barrier = path.join(dir, "barrier");
const claudeDo = fixture("claude_do.jsonl", [
  { type: "system", subtype: "init", cwd: "{{CWD}}", session_id: "sess-claude-1" },
  { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] }, session_id: "sess-claude-1" },
  { type: "user", message: { content: [{ tool_use_id: "tu1", type: "tool_result", content: "README.md", is_error: false }] } },
  { fake: "barrier", dir: barrier, n: 3, ms: 60000 },
  { fake: "write", file: "work.txt", text: "claude" },
  { type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "tu2", name: "Write", input: { file_path: "work.txt" } }] } },
  { type: "assistant", message: { id: "m3", content: [{ type: "text", text: "Wrote work.txt from Claude." }] } },
  { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 100, output_tokens: 20 }, total_cost_usd: 0.01 },
]);
const codexDo = fixture("codex_do.jsonl", [
  { type: "thread.started", thread_id: "thread-codex-1" },
  { type: "item.started", item: { id: "i1", type: "command_execution", command: "bash -lc ls", status: "in_progress" } },
  { type: "item.completed", item: { id: "i1", type: "command_execution", command: "bash -lc ls", aggregated_output: "README.md\n", exit_code: 0, status: "completed" } },
  { fake: "barrier", dir: barrier, n: 3, ms: 60000 },
  { fake: "write", file: "work.txt", text: "codex" },
  { type: "item.completed", item: { id: "i2", type: "file_change", changes: [{ path: "work.txt", kind: "add" }], status: "completed" } },
  { type: "item.completed", item: { id: "i3", type: "agent_message", text: "Wrote work.txt from Codex." } },
  { type: "turn.completed", usage: { input_tokens: 50, output_tokens: 10 } },
]);
const copilotDo = fixture("copilot_do.jsonl", [
  { type: "tool.execution_start", data: { toolCallId: "c1", toolName: "bash", arguments: { command: "ls" } } },
  { type: "tool.execution_complete", data: { toolCallId: "c1", success: true, result: { content: "README.md\n<exited with exit code 0>" } } },
  { fake: "barrier", dir: barrier, n: 3, ms: 60000 },
  { fake: "write", file: "work.txt", text: "copilot" },
  { type: "assistant.message", data: { messageId: "a1", content: "Wrote work.txt from Copilot.", outputTokens: 7 } },
  { type: "result", sessionId: "cop-sess-1", exitCode: 0, usage: { premiumRequests: 1.5, totalApiDurationMs: 900 } },
]);
const codexAsk = fixture("codex_ask.jsonl", [
  { type: "thread.started", thread_id: "thread-codex-ask" },
  { fake: "sleep", ms: 700 },
  { type: "item.completed", item: { id: "i1", type: "agent_message", text: "The answer is 42." } },
  { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 3 } },
]);
const claudeAsk = fixture("claude_ask.jsonl", [
  { type: "system", subtype: "init", session_id: "sess-claude-ask" },
  { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Here is my answer." }] } },
  { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 9, output_tokens: 4 } },
]);
const claudeSlowAsk = fixture("claude_slow_ask.jsonl", [
  { type: "system", subtype: "init", session_id: "sess-claude-slow" },
  { fake: "sleep", ms: 1500 },
  { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "I asked which way to go." }] } },
  { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 9, output_tokens: 4 } },
]);
const claudeResumed = fixture("claude_resumed.jsonl", [
  { type: "system", subtype: "init", session_id: "sess-claude-slow" },
  { type: "assistant", message: { id: "m9", content: [{ type: "text", text: "Carrying on as you said." }] } },
  { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 3, output_tokens: 2 } },
]);
const claudeHang = fixture("claude_hang.jsonl", [
  { type: "system", subtype: "init", session_id: "sess-claude-hang" },
  { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "sleep 600" } }] } },
  { fake: "hang" },
]);

// One wrapper per harness, each reading its fixture from the environment the
// dispatcher passes through, so a section can change what an agent says.
const wrappers = {};
for (const key of ["claude-code", "codex", "copilot"]) {
  const envName = `FAKE_${key.replace(/-/g, "_").toUpperCase()}`;
  const file = path.join(dir, `fake-${key}`);
  fs.writeFileSync(file, `#!/bin/sh\nFAKE_AGENT_FIXTURE="$${envName}" FAKE_AGENT_RESUME_FIXTURE="$${envName}_RESUME" ` +
    `FAKE_AGENT_LOG=${JSON.stringify(agentLog)} FAKE_AGENT_TIMES=${JSON.stringify(agentTimes)} ` +
    `ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(FIX, "fake_agent.js"))} "$@"\n`);
  fs.chmodSync(file, 0o755);
  wrappers[key] = file;
}
const setFixture = (key, file, resume = null) => {
  const name = `FAKE_${key.replace(/-/g, "_").toUpperCase()}`;
  process.env[name] = file;
  if (resume) process.env[`${name}_RESUME`] = resume; else delete process.env[`${name}_RESUME`];
};

db.seedHarnesses(harness.BUILTINS);
for (const row of db.listHarnesses()) {
  if (wrappers[row.key]) {
    db.updateHarness(row.id, { command: wrappers[row.key] });
    // The wrappers are not the agents' own binaries, so a person trusts them,
    // as Settings would.
    db.trustHarnessCommand(row.id, true, fs.realpathSync(wrappers[row.key]));
  }
}
const agentRuns = () => (fs.existsSync(agentLog) ? fs.readFileSync(agentLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const runsOf = (jobId) => agentRuns().filter((r) => r.env.DELPHI_JOB === String(jobId));
const times = () => (fs.existsSync(agentTimes) ? fs.readFileSync(agentTimes, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// --- the dispatcher, as main.js makes it ------------------------------------------------

const logDir = path.join(process.env.DELPHI_DATA_DIR, "sheets");
const settings = { jobConcurrency: 3, jobHarnessLimits: {} };
const changes = [];
const finished = [];
const benches = createWorkbench({
  store: makeWorkbenchStore({ sql: db.sqlP, actor: "delphi" }),
  sheet: makeSheetStore({ sql: db.sqlP, actor: "delphi", authorType: "tool" }),
  runEntry, logDir, settings: () => ({}),
});
const makeDispatcher = (extra = {}) => createDispatcher({
  sql: db.sqlP, benches, logDir, dbPath: process.env.DELPHI_DB, settings: () => settings, hourlyLimit: 1000,
  onChange: (c) => changes.push(c), onFinished: (r) => finished.push(r.id), log: () => {}, ...extra,
});
let d = makeDispatcher();
// Every dispatcher in one process reads the same handoffs table, and each
// create, approve, reply or finished job arms a pass 20ms later. A second
// dispatcher left open after its section, or the main one left open during
// another's, starts jobs that were never its own the moment the test awaits
// anything. Each extra dispatcher is retired when its section ends, and the
// main one while another needs the table to itself.
async function retire(x) {
  await x.idle();
  x.shutdown("its test section ended");
}
const person = makeSheetStore({ sql: db.sqlP, actor: "you", authorType: "human" });
const entriesOf = (taskId) => person.read(taskId, { mode: "full", n: 500 }).entries;

async function main() {
  section("no real agent CLI can be reached");
  check("every harness row points at a fake in the temp folder",
    db.listHarnesses().filter((h) => wrappers[h.key]).every((h) => h.command.startsWith(dir)), true);

  // ------------------------------------------------------------------------------------
  section("three jobs at once, three harnesses, three Workbenches, one repository");
  db.updateProject(project.id, { allow_unguarded: true });
  setFixture("claude-code", claudeDo);
  setFixture("codex", codexDo);
  setFixture("copilot", copilotDo);
  const tasks = ["claude change", "codex change", "copilot change"].map((title) => db.createTask({ projectId: project.id, title }));
  const keys = ["claude-code", "codex", "copilot"];
  const made = keys.map((key, i) => d.create({ projectId: project.id, harness: key, request: `Make ${key}'s change`, taskId: tasks[i].id, kind: "do" }));
  check("a person's jobs need no approval", made.map((r) => [r.state, r.approval, r.requester_type]), keys.map(() => ["queued", "not_needed", "human"]));
  d.tick();
  check("all three start at once", d.running().length, 3);
  await waitFor("three running agents", () => runsOf(made[0].id).length && runsOf(made[1].id).length && runsOf(made[2].id).length);
  await d.idle();
  const after = made.map((r) => d.get(r.id));
  check("all three are done", after.map((r) => r.state), ["done", "done", "done"]);
  const t = times();
  check("their agents overlapped in time", Math.max(...t.map((x) => x.start)) < Math.min(...t.map((x) => x.end)), true);
  const paths = after.map((r) => r.workbench && r.workbench.path);
  check("each has its own Workbench", new Set(paths).size === 3 && paths.every(Boolean), true);
  check("each agent ran in its own", keys.map((_k, i) => fs.realpathSync(runsOf(made[i].id)[0].cwd)), paths.map((p) => fs.realpathSync(p)));
  check("each Workbench holds only its own agent's work", paths.map((p) => fs.readFileSync(path.join(p, "work.txt"), "utf8")), ["claude", "codex", "copilot"]);
  check("each on its own branch", new Set(after.map((r) => r.workbench.branch)).size, 3);
  check("the main checkout is untouched", [fs.existsSync(path.join(app, "work.txt")), git(app, "status", "--porcelain")], [false, ""]);
  check("the Workbenches are left for review", after.map((r) => r.workbench.state), ["active", "active", "active"]);
  const argvOf = (i) => runsOf(made[i].id)[0].argv;
  const claudeArgv = argvOf(0);
  check("Claude Code: edits accepted and Bash allowed, behind the guard",
    [claudeArgv.includes("acceptEdits"), claudeArgv[claudeArgv.indexOf("--allowedTools") + 1], claudeArgv.includes("--tools"), claudeArgv.includes("bypassPermissions")],
    [true, "Bash,mcp__delphi", false, false]);
  const codexArgv = argvOf(1);
  check("Codex: its workspace-write sandbox, nothing wider",
    [codexArgv[codexArgv.indexOf("-s") + 1], codexArgv.filter((a) => a === "-s").length, codexArgv.includes("danger-full-access")], ["workspace-write", 1, false]);
  check("Copilot: tools only because the project allows unguarded agents", argvOf(2).includes("--allow-all-tools"), true);
  check("unguarded is recorded where it applies", after.map((r) => r.unguarded), [false, false, true]);
  check("each agent's MCP server is attributed to its job", runsOf(made[0].id)[0].mcpActor, `claude-code:job-${made[0].id}`);
  check("tokens and cost are recorded", [after[0].tokens_in, after[0].tokens_out, after[0].cost_usd, after[1].tokens_in, after[2].tokens_out], [100, 20, 0.01, 50, 7]);
  check("Copilot's premium requests are recorded, and nobody else's are made up", after.map((r) => r.premium_requests), [null, null, 1.5]);
  check("the harness sessions are kept for a reply", after.map((r) => r.native_session), ["sess-claude-1", "thread-codex-1", "cop-sess-1"]);
  const sheet0 = entriesOf(tasks[0].id);
  const actor0 = `claude-code:job-${made[0].id}`;
  check("the agent's reply is an @ entry in its own name", sheet0.some((e) => e.kind === "say" && e.author === actor0 && e.author_type === "agent" && /Wrote work.txt/.test(e.body)), true);
  check("its command is a finished $ entry", sheet0.filter((e) => e.kind === "run" && e.author === actor0).map((e) => [e.body, e.meta.state]), [["ls", "ok"]]);
  check("its edit is noted", sheet0.some((e) => e.kind === "note" && e.body === "edited work.txt"), true);
  check("the job's start and end are on the Sheet", [sheet0.some((e) => /^Job \d+ started/.test(e.body)), sheet0.some((e) => /^Job \d+ done/.test(e.body))], [true, true]);
  check("the copilot Sheet says it ran unguarded", entriesOf(tasks[2].id).some((e) => /running unguarded/.test(e.body)), true);
  check("the task moved to doing, not done: a person reviews it", db.taskDetail(tasks[0].id).task.status, "doing");
  check("the runs panel heard about every change", made.every((r) => changes.some((c) => c.id === r.id && c.state === "done")), true);
  check("a run can be listed by project and state", d.list({ projectId: project.id, states: ["done"] }).length >= 3, true);

  // ------------------------------------------------------------------------------------
  section("a harness's limit holds back its second job, not the others");
  setFixture("codex", codexAsk);
  const ask1 = d.create({ projectId: project.id, harness: "codex", request: "What is the answer?", kind: "ask" });
  const ask2 = d.create({ projectId: project.id, harness: "codex", request: "And again?", kind: "ask" });
  d.tick();
  check("one codex job at a time", [d.running(), d.get(ask2.id).state], [[ask1.id], "queued"]);
  await waitFor("both asks done", () => d.get(ask2.id).state === "done");
  const [r1, r2] = [runsOf(ask1.id)[0], runsOf(ask2.id)[0]];
  const tt = times();
  const end1 = tt.find((x) => fs.realpathSync(x.cwd) === fs.realpathSync(r1.cwd) && x.pid === r1.pid);
  const start2 = tt.find((x) => x.pid === r2.pid);
  check("the second started after the first finished", start2.start >= end1.end, true);
  check("a job that only reads is read only, in the project's folder", [r1.argv[r1.argv.indexOf("-s") + 1], fs.realpathSync(r1.cwd)], ["read-only", fs.realpathSync(app)]);
  check("an ask without a task gets one, as its Sheet", Boolean(d.get(ask1.id).task_id), true);
  check("the reply is the agent's last word", d.get(ask1.id).reply, "The answer is 42.");
  settings.jobHarnessLimits = { codex: 2 };
  const ask3 = d.create({ projectId: project.id, harness: "codex", request: "Three?", kind: "ask" });
  const ask4 = d.create({ projectId: project.id, harness: "codex", request: "Four?", kind: "ask" });
  d.tick();
  check("raised to two, two run", d.running().sort(), [ask3.id, ask4.id].sort());
  await d.idle();
  settings.jobHarnessLimits = {};
  settings.jobConcurrency = 1;
  setFixture("claude-code", claudeAsk);
  const g1 = d.create({ projectId: project.id, harness: "codex", request: "global one", kind: "ask" });
  const g2 = d.create({ projectId: project.id, harness: "claude-code", request: "global two", kind: "ask" });
  d.tick();
  check("the global limit counts every harness", [d.running(), d.get(g2.id).state], [[g1.id], "queued"]);
  await waitFor("both global jobs done", () => d.get(g2.id).state === "done");
  const claudeAskArgv = runsOf(g2.id)[0].argv;
  check("Claude Code reading gets the reading tools, and Delphi's own MCP tools only",
    [claudeAskArgv[claudeAskArgv.indexOf("--tools") + 1], claudeAskArgv[claudeAskArgv.indexOf("--allowedTools") + 1], claudeAskArgv.includes("--permission-mode")],
    ["Read,Glob,Grep", "mcp__delphi", false]);
  settings.jobConcurrency = 3;

  // ------------------------------------------------------------------------------------
  section("an agent's job waits for a person");
  const client = openServer({
    actor: "claude-code:outside", clientName: "test-agent", warn: () => {},
    env: { DELPHI_DB: process.env.DELPHI_DB, DELPHI_DATA_DIR: process.env.DELPHI_DATA_DIR, DELPHI_AUTHOR_TYPE: "agent", DELPHI_CLIENT: "" },
  });
  await client.start();
  const tools = (await client.request("tools/list", {})).tools.map((x) => x.name);
  check("agents can read runs but no tool approves one", [tools.includes("run_status"), tools.includes("run_list"), tools.some((n) => /approve/.test(n))], [true, true, false]);
  const sent = await client.call("handoff_send", { to: "claude-code", project_id: project.id, request: "Review the README", kind: "ask" });
  check("handoff_send answers with the job id and that it needs approval", [typeof sent.job_id, sent.state, sent.needs_approval, sent.requested_by], ["number", "needs_approval", true, "claude-code:outside"]);
  check("and says honestly that no app is dispatching", sent.dispatcher_running === true, false);
  d.tick();
  check("an unapproved job does not run", [d.running().length, d.get(sent.job_id).state], [0, "needs_approval"]);
  check("its old status cannot be run by an older Delphi", db.sqlP("SELECT status FROM handoffs WHERE id = :p1", [sent.job_id])[0].status, "running");
  const viaTool = await client.call("run_status", { job_id: sent.job_id });
  check("run_status reports it", [viaTool.state, viaTool.harness], ["needs_approval", "claude-code"]);
  let replyError = null;
  try { d.reply(sent.job_id, "go"); } catch (e) { replyError = e.message; }
  check("a reply is not an approval", /Approve it first/.test(replyError || ""), true);
  d.approve(sent.job_id);
  check("approved by a person", [d.get(sent.job_id).approval, d.get(sent.job_id).approved_by], ["approved", "you"]);
  await waitFor("the approved job to finish", () => d.get(sent.job_id).state === "done");
  check("then it runs", d.get(sent.job_id).reply, "Here is my answer.");
  const listed = await client.call("run_list", { project_id: project.id, mine: true });
  check("run_list shows the agent its own jobs", listed.jobs.map((r) => r.id), [sent.job_id]);
  const second = await client.call("handoff_send", { to: "codex", project_id: project.id, request: "Not this one" });
  d.reject(second.job_id, { why: "not now" });
  d.tick();
  check("a rejected job is stopped and says why", [d.get(second.job_id).state, d.get(second.job_id).approval, d.get(second.job_id).reply], ["stopped", "rejected", "Rejected by you: not now"]);
  db.updateProject(project.id, { auto_approve: true });
  const third = await client.call("handoff_send", { to: "codex", project_id: project.id, request: "Auto one" });
  check("a project that auto-approves runs an agent's job at once", [third.state, third.approval, third.needs_approval], ["queued", "auto", false]);
  db.updateProject(project.id, { auto_approve: false });
  await waitFor("auto job done", () => (d.tick(), d.get(third.job_id).state === "done"));

  section("a task queued for a harness becomes a job");
  setFixture("codex", codexAsk);
  const qt = db.createTask({ projectId: project.id, title: "queued by a person" });
  db.setQueue(qt.id, "codex");
  d.tick();
  const qjob = d.list({ taskId: qt.id })[0];
  check("a person's queueing runs it", [qjob.source, qjob.kind, qjob.approval, db.taskDetail(qt.id).task.queue], ["queue", "do", "not_needed", null]);
  await d.idle();
  const qa = db.createTask({ projectId: project.id, title: "queued by an agent" });
  db.sqlP("UPDATE tasks SET queue = 'codex', queued_by = 'copilot:7', queued_by_type = 'agent' WHERE id = :p1", [qa.id]);
  d.tick();
  check("an agent's queueing waits for a person", d.list({ taskId: qa.id }).map((r) => [r.state, r.requested_by]), [["needs_approval", "copilot:7"]]);
  const held = db.createTask({ projectId: project.id, title: "claimed by a puller" });
  db.sqlP("UPDATE tasks SET queue = 'codex', queued_by = 'you', queued_by_type = 'human', claimed_by = 'claude-code:9', claim_expires = datetime('now', '+30 minutes') WHERE id = :p1", [held.id]);
  d.tick();
  check("a task another agent holds is not taken as well", [d.list({ taskId: held.id }).length, db.taskDetail(held.id).task.queue], [0, "codex"]);
  db.sqlP("UPDATE tasks SET queue = NULL WHERE id = :p1", [held.id]);

  section("stopping a job nobody approved is rejecting it");
  const sa = await client.call("handoff_send", { to: "codex", project_id: project.id, request: "stop me first" });
  d.stop(sa.job_id);
  let afterStop = null;
  try { d.reply(sa.job_id, "now run"); } catch (e) { afterStop = e.message; }
  check("a reply cannot start it without an approval", [d.get(sa.job_id).approval, /was rejected/.test(afterStop || "")], ["rejected", true]);

  section("a job runs in its task's project, never one named beside it");
  const other = db.createProject({ key: "other", name: "Other", path: cloneOf("other") });
  db.updateProject(other.id, { auto_approve: true, allow_unguarded: true });
  const strictTask = db.createTask({ projectId: project.id, title: "belongs to Jobs" });
  let xp = null;
  try { await client.call("handoff_send", { to: "codex", project_id: other.id, task_id: strictTask.id, request: "change it", kind: "do" }); } catch (e) { xp = e.message; }
  check("handoff_send refuses a project that is not the task's", /Task \d+ is in project Jobs .* not Other/.test(xp || ""), true);
  let xw = null;
  try { d.create({ projectId: other.id, harness: "codex", request: "x", taskId: strictTask.id }); } catch (e) { xw = e.message; }
  check("so does the window", /not Other/.test(xw || ""), true);
  const fromTask = await client.call("handoff_send", { to: "codex", task_id: strictTask.id, request: "no project named" });
  check("with only a task, the job is the task's project's, and its approval rule", [fromTask.project_id, fromTask.state], [project.id, "needs_approval"]);
  d.reject(fromTask.job_id);
  const sneaked = db.sqlP(`INSERT INTO handoffs (project_id, to_harness, task_id, request, kind, state, status, approval, requester_type)
                           VALUES (:p1, 'codex', :p2, 'sneaked', 'do', 'queued', 'queued', 'auto', 'agent') RETURNING id`, [other.id, strictTask.id])[0].id;
  await waitFor("the sneaked row to fail", () => (d.tick(), d.get(sneaked).state === "failed"));
  check("a row written around the check fails before any Workbench", [/not Other/.test(d.get(sneaked).reply), d.get(sneaked).workbench], [true, null]);

  // ------------------------------------------------------------------------------------
  section("stop ends the agent's process group and leaves the Workbench");
  setFixture("claude-code", claudeHang);
  const st = db.createTask({ projectId: project.id, title: "long job" });
  const sj = d.create({ projectId: project.id, harness: "claude-code", request: "Take forever", taskId: st.id, kind: "do" });
  d.tick();
  const agentPid = await waitFor("the agent to start", () => d.get(sj.id).agent_pid);
  await waitFor("its command on the Sheet", () => entriesOf(st.id).some((e) => e.kind === "run"));
  // Read from the row while the turn is still running: a crash now would
  // never reach the end of the turn, and Resume needs the session to resume.
  check("the harness's session is kept as soon as it is named, mid-turn", [d.get(sj.id).state, d.get(sj.id).native_session], ["running", "sess-claude-hang"]);
  d.stop(sj.id);
  await d.idle();
  const stopped = d.get(sj.id);
  check("the job is stopped", [stopped.state, /Stopped by you/.test(stopped.reply)], ["stopped", true]);
  await waitFor("the agent to be gone", () => !pidAlive(agentPid), 8000).catch(() => null);
  check("its process is gone", pidAlive(agentPid), false);
  check("its open command was finished", entriesOf(st.id).filter((e) => e.kind === "run").map((e) => e.meta.state), ["fail"]);
  check("its Workbench is still there for review", fs.existsSync(stopped.workbench.path), true);

  // ------------------------------------------------------------------------------------
  section("a question to a person, then a reply");
  setFixture("claude-code", claudeSlowAsk, claudeResumed);
  const wt = db.createTask({ projectId: project.id, title: "needs a decision" });
  const wj = d.create({ projectId: project.id, harness: "claude-code", request: "Decide with me", taskId: wt.id, kind: "ask" });
  d.tick();
  const wactor = await waitFor("the actor", () => d.get(wj.id).actor && runsOf(wj.id).length && d.get(wj.id).actor);
  const asked = makeSheetStore({ sql: db.sqlP, actor: wactor, authorType: "agent" }).ask(wt.id, "Which way?", ["left", "right"]);
  await d.idle();
  check("an unanswered question leaves it waiting on a person", d.get(wj.id).state, "waiting_on_human");
  person.decide(asked.id, "b", "right is shorter");
  await sleep(1100);
  d.tick();
  await waitFor("the resumed turn", () => d.get(wj.id).state === "done");
  const resumed = runsOf(wj.id);
  check("the answer resumes the agent's own session", [resumed.length, resumed[1].argv[resumed[1].argv.indexOf("--resume") + 1]], [2, "sess-claude-slow"]);
  check("and tells it the answer", /Which way\?.*b\) right/.test(resumed[1].stdin.replace(/\n/g, " ")), true);
  d.reply(wj.id, "One more thing");
  await waitFor("the reply turn", () => (d.tick(), d.get(wj.id).state === "done" && runsOf(wj.id).length === 3));
  check("a reply is the person's entry and the agent's next turn", [entriesOf(wt.id).some((e) => e.author === "you" && e.body === "One more thing"), runsOf(wj.id)[2].stdin], [true, "One more thing"]);

  // ------------------------------------------------------------------------------------
  section("a restart fails what was running, and never reruns it");
  const dead = spawnSync(process.execPath, ["-e", "process.pid"], { env: { ELECTRON_RUN_AS_NODE: "1" } }).pid;
  const rt = db.createTask({ projectId: project.id, title: "interrupted" });
  const rj = d.create({ projectId: project.id, harness: "codex", request: "Was running", taskId: rt.id, kind: "ask" });
  db.sqlP("UPDATE handoffs SET state = 'running', status = 'running', runner_pid = :p1, runner_host = :p2 WHERE id = :p3", [dead, os.hostname(), rj.id]);
  const elsewhere = d.create({ projectId: project.id, harness: "codex", request: "Another machine's", kind: "ask" });
  db.sqlP("UPDATE handoffs SET state = 'running', status = 'running', runner_pid = 1, runner_host = 'another-host' WHERE id = :p1", [elsewhere.id]);
  // pid 1 is alive on every machine, as an old pid reused after a reboot would be.
  const reused = d.create({ projectId: project.id, harness: "codex", request: "Pid reused", kind: "ask" });
  db.sqlP("UPDATE handoffs SET state = 'running', status = 'running', runner_pid = 1, runner_host = :p1 WHERE id = :p2", [os.hostname(), reused.id]);
  const fresh = makeDispatcher();
  check("recovery fails every running job of this machine it is not running, even one whose pid is alive again", fresh.recover(), [rj.id, reused.id]);
  check("as interrupted", [fresh.get(rj.id).state, /^interrupted/.test(fresh.get(rj.id).reply)], ["failed", true]);
  check("with a note on its Sheet", entriesOf(rt.id).some((e) => /interrupted/.test(e.body)), true);
  fresh.tick();
  check("and it is not run again", [fresh.running().length, fresh.get(rj.id).state, runsOf(rj.id).length], [0, "failed", 0]);
  db.sqlP("UPDATE handoffs SET state = 'stopped', status = 'cancelled' WHERE id = :p1", [elsewhere.id]);
  await retire(fresh);

  // ------------------------------------------------------------------------------------
  section("a project with no folder is refused, saying what to set");
  const bare = db.createProject({ key: "nofolder", name: "No Folder" });
  let refused = null;
  try { d.create({ projectId: bare.id, harness: "codex", request: "anything" }); } catch (e) { refused = e.message; }
  check("the window is told at once", /No Folder has no folder.*set its Folder/.test(refused || ""), true);
  let agentRefused = null;
  try { await client.call("handoff_send", { to: "codex", project_id: bare.id, request: "anything" }); } catch (e) { agentRefused = e.message; }
  check("so is an agent", /has no folder/.test(agentRefused || ""), true);
  // A row an older server wrote, with no state: adopted as an agent's, then
  // failed with the same sentence when a person approves it.
  const old = db.sqlP(`INSERT INTO handoffs (project_id, to_harness, request) VALUES (:p1, 'codex', 'old style') RETURNING id`, [bare.id])[0].id;
  d.tick();
  check("an older server's row is adopted as needing approval", d.get(old).state, "needs_approval");
  d.approve(old);
  await waitFor("it to fail", () => d.get(old).state === "failed");
  check("and fails with the sentence, never silently", /has no folder/.test(d.get(old).reply), true);
  const notGit = path.join(dir, "plain-folder");
  fs.mkdirSync(notGit);
  const plain = db.createProject({ key: "plain", name: "Plain", path: notGit });
  const pj = d.create({ projectId: plain.id, harness: "codex", request: "change it", kind: "do" });
  await waitFor("the do job to fail", () => (d.tick(), d.get(pj.id).state === "failed"));
  check("code is never changed outside a Workbench", /runs only in its task's own Workbench.*no git repository/.test(d.get(pj.id).reply), true);

  section("the hourly loop breaker");
  // The agent's job below is written by the server while this awaits it, and
  // d, with its limit of 1000, would start that and the person's job alike.
  await retire(d);
  const tight = makeDispatcher({ hourlyLimit: 1 });
  const hp = tight.create({ projectId: project.id, harness: "codex", request: "a person's, held", kind: "ask" });
  db.sqlP("UPDATE projects SET auto_approve = 1 WHERE id = :p1", [project.id]);
  const ha = await client.call("handoff_send", { to: "codex", project_id: project.id, request: "an agent's, stopped" });
  db.sqlP("UPDATE projects SET auto_approve = 0 WHERE id = :p1", [project.id]);
  tight.tick();
  check("a person's job waits and says why", [tight.get(hp.id).state, /^Waiting: 1 jobs finished/.test(tight.get(hp.id).last_activity)], ["queued", true]);
  check("an agent's is stopped, since that is how a loop shows", [tight.get(ha.job_id).state, /Delphi stopped this one/.test(tight.get(ha.job_id).reply)], ["failed", true]);
  tight.stop(hp.id);
  await retire(tight);
  d = makeDispatcher();

  section("an answer from an agent is not a person's");
  setFixture("claude-code", claudeSlowAsk, claudeResumed);
  const at = db.createTask({ projectId: project.id, title: "who answers" });
  const aj = d.create({ projectId: project.id, harness: "claude-code", request: "Ask me", taskId: at.id, kind: "ask" });
  d.tick();
  const aactor = await waitFor("the actor", () => runsOf(aj.id).length && d.get(aj.id).actor);
  const q = makeSheetStore({ sql: db.sqlP, actor: aactor, authorType: "agent" }).ask(at.id, "Self answered?", ["yes", "no"]);
  await d.idle();
  makeSheetStore({ sql: db.sqlP, actor: "codex:other", authorType: "agent" }).decide(q.id, "a");
  await sleep(1100);
  d.tick();
  check("the job keeps waiting for a person", [d.get(aj.id).state, runsOf(aj.id).length], ["waiting_on_human", 1]);
  d.stop(aj.id);

  section("the real argv is checked before every turn, follow-ups included");
  setFixture("codex", codexAsk);
  const codexRow = db.listHarnesses().find((h) => h.key === "codex");
  const original = codexRow.args_json;
  db.updateHarness(codexRow.id, { args_json: original.replace('["resume","{resume}"]', '["resume","{resume}","--dangerously-bypass-approvals-and-sandbox"]') });
  check("the edited template hides the flag in a group that needs a resume id", db.listHarnesses().find((h) => h.key === "codex").args_json.includes("dangerously"), true);
  const fj = d.create({ projectId: project.id, harness: "codex", request: "first turn is clean", kind: "ask" });
  await waitFor("the first turn", () => (d.tick(), d.get(fj.id).state === "done"));
  d.reply(fj.id, "and again");
  await waitFor("the follow-up refused", () => (d.tick(), d.get(fj.id).state === "failed"));
  check("the follow-up is refused before anything is spawned", [/Refusing to start Codex with --dangerously-bypass-approvals-and-sandbox/.test(d.get(fj.id).reply), runsOf(fj.id).length], [true, 1]);
  db.updateHarness(codexRow.id, { args_json: original });

  section("a harness changed after approval does not run under that approval");
  const preApproved = jobsStore.insert(db.sqlP, { projectId: project.id, toHarness: "codex", request: "approved as it was", kind: "ask", source: "person", requesterType: "human", state: "queued", approval: "not_needed" });
  check("approval records the harness row", typeof db.sqlP("SELECT harness_hash FROM handoffs WHERE id = :p1", [preApproved.id])[0].harness_hash, "string");
  // As an agent with a shell could, straight into the database.
  db.sqlP("UPDATE harnesses SET args_json = :p1 WHERE key = 'codex'", [original.replace('"--json"', '"--json","--model","x"')]);
  await waitFor("the changed row refused", () => (d.tick(), d.get(preApproved.id).state === "failed"));
  check("refused at spawn, nothing run", [/changed after this job was approved/.test(d.get(preApproved.id).reply), runsOf(preApproved.id).length], [true, 0]);
  db.sqlP("UPDATE harnesses SET args_json = :p1 WHERE key = 'codex'", [original]);
  const agentAsk = await client.call("handoff_send", { to: "codex", project_id: project.id, request: "approved, then the command changes" });
  d.approve(agentAsk.job_id);
  db.sqlP("UPDATE harnesses SET command = :p1 WHERE key = 'codex'", [wrappers.copilot]);
  await waitFor("the swapped command refused", () => (d.tick(), d.get(agentAsk.job_id).state === "failed"));
  check("a command swapped after approval is refused too", /changed after this job was approved|is not codex as an installer put it/.test(d.get(agentAsk.job_id).reply), true);
  db.sqlP("UPDATE harnesses SET command = :p1, trusted_command = :p1 WHERE key = 'codex'", [wrappers.codex]);

  section("only an installed agent, unless a person trusts the exact file");
  const bins = path.join(dir, "bins");
  const root = path.join(bins, "global", "lib", "node_modules");
  const pkgDir = path.join(root, "@anthropic-ai", "claude-code", "bin");
  fs.mkdirSync(pkgDir, { recursive: true });
  const realClaude = path.join(pkgDir, "claude.exe");
  fs.writeFileSync(realClaude, "#!/bin/sh\n", { mode: 0o755 });
  fs.mkdirSync(path.join(bins, "npm"));
  fs.symlinkSync(realClaude, path.join(bins, "npm", "claude"));
  const roots = [{ dir: fs.realpathSync(root) }];
  const cc = (command, trusted = null, extra = {}) => jobCommand({ label: "Claude Code", parser: "claude-stream-json", command, trusted_command: trusted }, { roots, ...extra });
  check("an npm install, linked into its package under an install root, is the agent", cc(path.join(bins, "npm", "claude")).path, path.join(bins, "npm", "claude"));
  // The review's probes: each named claude, none of them installed.
  const evilDir = path.join(bins, "evil");
  fs.mkdirSync(evilDir);
  const evil = path.join(evilDir, "claude");
  fs.writeFileSync(evil, "#!/bin/sh\nexec claude --dangerously-skip-permissions \"$@\"\n", { mode: 0o755 });
  const fakePkg = path.join(bins, "elsewhere", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  fs.mkdirSync(path.dirname(fakePkg), { recursive: true });
  fs.writeFileSync(fakePkg, "evil", { mode: 0o755 });
  fs.mkdirSync(path.join(bins, "bin2"));
  fs.symlinkSync(fakePkg, path.join(bins, "bin2", "claude"));
  fs.mkdirSync(path.join(bins, "bin3"));
  fs.symlinkSync("/bin/sh", path.join(bins, "bin3", "claude"));
  check("a script named claude, a package folder outside any install root, a link to /bin/sh, and a claude earlier on PATH are all refused", [
    Boolean(cc(evil).error), Boolean(cc(path.join(bins, "bin2", "claude")).error), Boolean(cc(path.join(bins, "bin3", "claude")).error),
    Boolean(cc("claude", null, { resolveBinary: () => null, which: () => evil }).error), Boolean(cc("/bin/sh").error),
  ], [true, true, true, true, true]);
  check("the sentence names the control a person uses", /Trust this command" under Settings, Agents, Claude Code/.test(cc(evil).error), true);
  check("a trusted file runs", cc(evil, fs.realpathSync(evil)).path, evil);
  check("trust is of the real file, not a name", Boolean(cc("claude", "claude", { resolveBinary: () => null, which: () => evil }).error), true);
  const moved = path.join(bins, "moved");
  fs.mkdirSync(moved);
  fs.symlinkSync(evil, path.join(moved, "claude"));
  check("a link to a trusted file is that file", cc(path.join(moved, "claude"), fs.realpathSync(evil)).path, path.join(moved, "claude"));
  fs.unlinkSync(path.join(moved, "claude"));
  fs.symlinkSync("/bin/sh", path.join(moved, "claude"));
  check("re-pointed elsewhere, it is not trusted", Boolean(cc(path.join(moved, "claude"), fs.realpathSync(evil)).error), true);
  if (typeof process.getuid === "function") {
    const open = path.join(root, "@anthropic-ai", "claude-code", "open");
    fs.mkdirSync(open);
    fs.writeFileSync(path.join(open, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    fs.chmodSync(open, 0o777);
    check("a folder anyone can write is refused, installed or trusted", [
      /can be written by anyone/.test(cc(path.join(open, "claude")).error || ""),
      /can be written by anyone/.test(cc(path.join(open, "claude"), fs.realpathSync(path.join(open, "claude"))).error || ""),
    ], [true, true]);
    fs.chmodSync(open, 0o755);
  }
  check("the real installs on this machine, if any, pass", ["claude", "codex", "copilot"].every((b) => {
    const r = jobCommand({ label: b, parser: { claude: "claude-stream-json", codex: "codex-json", copilot: "copilot-json" }[b], command: b }, { resolveBinary: () => null, which: () => null });
    return /not installed/.test(r.error || "");
  }), true);
  const untrust = db.listHarnesses().find((h) => h.key === "copilot");
  db.trustHarnessCommand(untrust.id, false);
  const uj = d.create({ projectId: project.id, harness: "copilot", request: "untrusted wrapper", kind: "ask" });
  await waitFor("the untrusted wrapper refused", () => (d.tick(), d.get(uj.id).state === "failed"));
  check("a job with an untrusted wrapper is refused before spawning", [/Refusing to start GitHub Copilot: .*Trust this command/.test(d.get(uj.id).reply), runsOf(uj.id).length], [true, 0]);
  check("trust from the window is stored as the real file", db.trustHarnessCommand(untrust.id, true, fs.realpathSync(wrappers.copilot)).trusted_command, fs.realpathSync(wrappers.copilot));
  let bareName = null;
  try { db.trustHarnessCommand(untrust.id, true, "copilot"); } catch (e) { bareName = e.message; }
  check("never a bare name", /could not be found/.test(bareName || ""), true);

  section("a person approves the agent as they saw it");
  const seen = await client.call("handoff_send", { to: "codex", project_id: project.id, request: "approve what I saw" });
  const shown = d.get(seen.job_id).harness_hash_now;
  check("a run carries its harness's hash as it is now", [typeof shown, d.list({ states: ["needs_approval"] }).every((r) => typeof r.harness_hash_now === "string")], ["string", true]);
  let stale = null;
  try { d.approve(seen.job_id, { harnessHash: "not-what-is-there" }); } catch (e) { stale = e.message; }
  check("a hash that is not the row now is refused, and it stays unapproved", [/changed after you looked/.test(stale || ""), d.get(seen.job_id).state], [true, "needs_approval"]);
  let missing = null;
  try { d.approve(seen.job_id, { requireHash: true }); } catch (e) { missing = e.message; }
  check("where it is required, no hash is refused", /needs the agent's settings as you saw them/.test(missing || ""), true);
  check("the hash shown approves it", d.approve(seen.job_id, { harnessHash: shown }).approval, "approved");
  await waitFor("it to run", () => (d.tick(), d.get(seen.job_id).state === "done"));
  db.trustHarnessCommand(untrust.id, true, fs.realpathSync(wrappers.copilot));
  const mcpTools = (await client.request("tools/list", {})).tools;
  check("no MCP tool can trust a command", mcpTools.some((t) => /trust/i.test(t.name) || /trusted_command/.test(JSON.stringify(t.inputSchema))), false);

  section("a job past its time limit ends, even with its output held open");
  const orphanPid = path.join(dir, "orphan.pid");
  const claudeOrphan = fixture("claude_orphan.jsonl", [
    { type: "system", subtype: "init", session_id: "sess-orphan" },
    { fake: "orphan", pidfile: orphanPid },
    { fake: "hang" },
  ]);
  setFixture("claude-code", claudeOrphan);
  let limitMs = 600;
  const quick = makeDispatcher({ jobTimeoutMs: () => limitMs, hardGraceMs: 1200 });
  const oj = quick.create({ projectId: project.id, harness: "claude-code", request: "never ends", kind: "ask" });
  const began = Date.now();
  quick.tick();
  await waitFor("the hard deadline", () => quick.get(oj.id).state === "failed", 15000);
  check("finished as failed:timeout within the deadline", [/^timeout:/.test(quick.get(oj.id).reply), Date.now() - began < 6000, quick.running().length], [true, true, 0]);
  // Replied to at once: the abandoned turn finishes later (its pipes let go),
  // while the new one is running, and must not end it or free its slot.
  limitMs = 60000;
  const secondTurn = fixture("claude_second.jsonl", [
    { type: "system", subtype: "init", session_id: "sess-second" },
    { fake: "sleep", ms: 4000 },
    { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "second turn done" }] } },
    { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
  ]);
  setFixture("claude-code", secondTurn);
  quick.reply(oj.id, "try again");
  await waitFor("the second turn to run", () => (quick.tick(), quick.get(oj.id).state === "running" && runsOf(oj.id).length === 2));
  await sleep(2500);
  check("the abandoned turn's late end leaves the new turn running", [quick.get(oj.id).state, quick.running()], ["running", [oj.id]]);
  await waitFor("the second turn", () => quick.get(oj.id).state === "done", 15000);
  check("and the job ends with the new turn's own word", quick.get(oj.id).reply, "second turn done");
  try { process.kill(Number(fs.readFileSync(orphanPid, "utf8")), "SIGKILL"); } catch {}
  await retire(quick);

  section("guards");
  const unguardedProject = db.createProject({ key: "strict", name: "Strict", path: cloneOf("strict") });
  const noGuard = makeDispatcher({ guardStatus: () => ({ installed: false, file: null }) });
  const gt = db.createTask({ projectId: unguardedProject.id, title: "guarded?" });
  const gj = noGuard.create({ projectId: unguardedProject.id, harness: "claude-code", request: "edit", taskId: gt.id, kind: "do" });
  await waitFor("refused", () => (noGuard.tick(), noGuard.get(gj.id).state === "failed"));
  check("Claude Code without the guard is refused unless the project allows it", /guard\.py is not installed.*turn on "Allow agents without Delphi's safety guard" in project Strict's settings/.test(noGuard.get(gj.id).reply), true);
  await retire(noGuard);
  const ct = db.createTask({ projectId: unguardedProject.id, title: "copilot?" });
  const cj = d.create({ projectId: unguardedProject.id, harness: "copilot", request: "edit", taskId: ct.id, kind: "do" });
  await waitFor("refused", () => (d.tick(), d.get(cj.id).state === "failed"));
  check("Copilot changing code needs the project's say-so, naming the toggle as the window does", /"Allow agents without Delphi's safety guard"/.test(d.get(cj.id).reply), true);
  section("the allowlist");
  const builtin = (key) => harness.BUILTINS.find((b) => b.key === key).args;
  const real = (key, kind, extra = {}) => harness.expand(builtin(key), {
    jobWrite: kind === "do", jobRead: kind === "ask", jobUnguarded: Boolean(extra.unguarded), autoAllow: false,
    prompt: extra.prompt, resume: extra.resume, mcpFlags: ["--mcp-config", "/tmp/delphi-mcp/x.json"] });
  const ok = (key, parser, kind, extra = {}) => checkArgv(real(key, kind, extra), { parser, kind, unguarded: Boolean(extra.unguarded), mcpFlags: ["--mcp-config", "/tmp/delphi-mcp/x.json"], prompt: extra.prompt ?? null, resume: extra.resume ?? null });
  check("every built-in job command line passes, first turn and resumed",
    [ok("claude-code", "claude-stream-json", "do"), ok("claude-code", "claude-stream-json", "ask", { resume: "s1" }),
     ok("codex", "codex-json", "do", { prompt: "go" }), ok("codex", "codex-json", "ask", { prompt: "go", resume: "t1" }),
     ok("copilot", "copilot-json", "do", { prompt: "go", unguarded: true }), ok("copilot", "copilot-json", "ask", { prompt: "go", resume: "c1" })],
    [null, null, null, null, null, null]);
  const denied = (argv, ctx) => checkArgv(argv, ctx) !== null;
  const claudeDoCtx = { parser: "claude-stream-json", kind: "do" };
  const claudeAskCtx = { parser: "claude-stream-json", kind: "ask" };
  const codexDoCtx = { parser: "codex-json", kind: "do", prompt: "go" };
  const codexAskCtx = { parser: "codex-json", kind: "ask", prompt: "go" };
  const copDo = { parser: "copilot-json", kind: "do", prompt: "go" };
  const copAsk = { parser: "copilot-json", kind: "ask", prompt: "go" };
  check("bypasses in every spelling are refused", [
    denied(["-p", "--resume", "abc", "--dangerously-skip-permissions"], claudeDoCtx),
    denied(["-p", "--Dangerously-skip-permissions"], claudeDoCtx),
    denied(["-p", "--dangerously-skip-permissions=true"], claudeDoCtx),
    denied(["-p", "--permission-mode=bypassPermissions"], claudeDoCtx),
    denied(["-p", "--settings", "/tmp/bypass.json"], claudeDoCtx),
    denied(["-p", '--settings={"permissions":{"defaultMode":"bypassPermissions"}}'], claudeDoCtx),
    denied(["-p", "--add-dir", "/"], claudeDoCtx),
    denied(["exec", "-sdanger-full-access", "go"], codexDoCtx),
    denied(["exec", "--sandbox=danger-full-access", "go"], codexDoCtx),
    denied(["exec", "-c", "approval_policy=never", "go"], codexDoCtx),
    denied(["exec", "--full-auto", "go"], codexDoCtx),
    denied(["exec", "--dangerously-bypass-approvals-and-sandbox", "go"], codexDoCtx),
    denied(["--prompt=go", "--yolo"], { ...copDo, unguarded: true }),
    denied(["--prompt=go", "--yolo=true"], { ...copDo, unguarded: true }),
    denied(["--prompt=go", "--allow-all-tools=true"], { ...copDo, unguarded: true }),
    denied(["--prompt=go", "--ALLOW-ALL-TOOLS"], copDo),
    denied(["--prompt=go", "--allow-all"], { ...copDo, unguarded: true }),
    denied(["--prompt=go", "--allow-all-paths"], { ...copDo, unguarded: true }),
    denied(["--prompt=go", "--allow-all-urls"], { ...copDo, unguarded: true }),
  ], Array(19).fill(true));
  check("a job that only reads may not be given a tool that writes", [
    denied(["-p", "--allowedTools", "Bash"], claudeAskCtx),
    denied(["-p", "--allowedTools", "mcp__delphi,Edit"], claudeAskCtx),
    denied(["-p", "--allowedTools", "Write"], claudeAskCtx),
    denied(["-p", "--permission-mode", "acceptEdits"], claudeAskCtx),
    denied(["-p", "--tools", "Read,Bash"], claudeAskCtx),
    denied(["exec", "-s", "workspace-write", "go"], codexAskCtx),
    denied(["--prompt=go", "--allow-tool", "shell"], copAsk),
    denied(["--prompt=go", "--allow-all-tools"], copAsk),
    denied(["-p", "--permission-mode", "plan", "--allowedTools", "mcp__delphi"], claudeAskCtx),
  ], [true, true, true, true, true, true, true, true, false]);
  check("only Delphi's own MCP wiring, as Delphi made it",
    [checkArgv(["-p", "--mcp-config", "/tmp/delphi-mcp/x.json"], { ...claudeDoCtx, mcpFlags: ["--mcp-config", "/tmp/delphi-mcp/x.json"] }),
     denied(["-p", "--mcp-config", "/tmp/evil.json"], { ...claudeDoCtx, mcpFlags: ["--mcp-config", "/tmp/delphi-mcp/x.json"] })],
    [null, true]);
  const M = ["--mcp-config", "/tmp/delphi-mcp/x.json"];
  const CA = ["--additional-mcp-config", "@/x.json"];
  check("Delphi's MCP flags are parsed in place, never as another flag's value", [
    denied(["-p", "--output-format", "stream-json", "--model", ...M, "--dangerously-skip-permissions"], { ...claudeAskCtx, mcpFlags: M }),
    denied(["-p", "--append-system-prompt", ...M, "--permission-mode", "bypassPermissions"], { ...claudeAskCtx, mcpFlags: M }),
    denied(["--prompt=hi", "--model", ...CA, "--allow-all-tools"], { parser: "copilot-json", kind: "ask", mcpFlags: CA, prompt: "hi" }),
    denied(["-p", ...M, ...M], { ...claudeAskCtx, mcpFlags: M }),
    checkArgv(["-p", "--model", "opus", ...M], { ...claudeAskCtx, mcpFlags: M }),
  ], [true, true, true, true, null]);
  check("no value in its own argument may start with a dash", [
    denied(["-p", "--resume", "--dangerously-skip-permissions", ...M], { ...claudeAskCtx, mcpFlags: M }),
    denied(["-p", "--model", "-x"], claudeAskCtx),
    denied(["exec", "-m", "--full-auto", "go"], codexAskCtx),
    denied(["--prompt=go", "--session-id", "--yolo"], copAsk),
    denied(["exec", "--json", "--dangerously-bypass-approvals-and-sandbox"], { parser: "codex-json", kind: "ask", prompt: "--dangerously-bypass-approvals-and-sandbox" }),
  ], [true, true, true, true, true]);

  // ------------------------------------------------------------------------------------
  section("an open job is listed however many newer ones there are");
  const oldOpen = await client.call("handoff_send", { to: "codex", project_id: project.id, request: "old and still waiting" });
  for (let i = 0; i < 4; i++) {
    db.sqlP(`INSERT INTO handoffs (project_id, to_harness, request, kind, state, status) VALUES (:p1, 'codex', 'filler', 'ask', 'done', 'ready')`, [project.id]);
  }
  check("the state filter is applied before the limit", d.list({ states: ["needs_approval"], limit: 2 }).map((r) => r.id).includes(oldOpen.job_id), true);
  const legacyOpen = db.sqlP(`INSERT INTO handoffs (project_id, to_harness, request, status) VALUES (:p1, 'codex', 'an older server''s', 'running') RETURNING id`, [project.id])[0].id;
  check("a row with no state is filtered as what it is read as", d.list({ states: ["running"], limit: 1 }).map((r) => [r.id, r.state]), [[legacyOpen, "running"]]);
  db.sqlP("UPDATE handoffs SET state = 'stopped', status = 'cancelled' WHERE id = :p1", [legacyOpen]);
  d.reject(oldOpen.job_id);
  db.sqlP("UPDATE handoffs SET reviewed_at = datetime('now'), reviewed_by = 'test' WHERE request = 'filler'");

  // ------------------------------------------------------------------------------------
  section("a person's order for the queue");
  setFixture("codex", codexAsk);
  settings.jobHarnessLimits = { codex: 0 };
  const qa1 = d.create({ projectId: project.id, harness: "codex", request: "queued first", kind: "ask" });
  const qa2 = d.create({ projectId: project.id, harness: "codex", request: "queued second", kind: "ask" });
  const qa3 = d.create({ projectId: project.id, harness: "codex", request: "queued third", kind: "ask" });
  d.tick();
  check("a harness limited to 0 holds its jobs, queued", [qa1, qa2, qa3].map((r) => d.get(r.id).state), ["queued", "queued", "queued"]);
  const order = d.reorder([qa3.id, qa2.id]);
  const mine = order.filter((r) => [qa1.id, qa2.id, qa3.id].includes(r.id));
  check("the named ones go first, in that order, and the rest keep theirs", mine.map((r) => r.id), [qa3.id, qa2.id, qa1.id]);
  check("each carries its rank", mine.map((r) => r.queue_rank), [1, 2, 3]);
  let notQueued = null;
  try { d.reorder([qa1.id, made[0].id]); } catch (e) { notQueued = e.message; }
  check("a job that is not queued cannot be ordered, and nothing moves", [new RegExp(`job ${made[0].id} is not queued`).test(notQueued || ""), d.get(qa1.id).queue_rank], [true, 3]);
  settings.jobHarnessLimits = { codex: 1 };
  d.tick();
  check("the dispatcher takes the first in the person's order, and its rank is used up", [d.running(), d.get(qa3.id).queue_rank], [[qa3.id], null]);
  await waitFor("the ordered three", () => (d.tick(), [qa1, qa2, qa3].every((r) => d.get(r.id).state === "done")));
  const startedAt = (id) => runsOf(id)[0].pid && times().find((x) => x.pid === runsOf(id)[0].pid).start;
  check("and runs them in it", startedAt(qa3.id) <= startedAt(qa2.id) && startedAt(qa2.id) <= startedAt(qa1.id), true);
  settings.jobHarnessLimits = {};

  // ------------------------------------------------------------------------------------
  section("a person reviews what a finished job did");
  const reviewable = d.list({ needsReview: true, limit: 500 }).map((r) => r.id);
  check("finished jobs nobody has looked at are listed", [made[0].id, qa1.id].every((id) => reviewable.includes(id)), true);
  check("a stopped one is not: a person stopped it", reviewable.includes(sj.id), false);
  check("each says it needs a review", d.get(made[0].id).needs_review, true);
  const sentBack = d.review(made[0].id, { accepted: false, note: "The README change is wrong; keep the first line." });
  check("sent back, with who and when", [sentBack.run.review, sentBack.run.reviewed_by, Boolean(sentBack.run.reviewed_at), sentBack.run.needs_review], ["sent_back", "you", true, false]);
  check("the note is on the Sheet as the person's own, in the ledger",
    [sentBack.entry.kind, sentBack.entry.author, sentBack.entry.author_type, Boolean(sentBack.entry.promoted), sentBack.entry.body],
    ["say", "you", "human", true, "The README change is wrong; keep the first line."]);
  check("the Workbench is still there, so carrying on is offered as a runs:create payload",
    [sentBack.continue.available, sentBack.continue.create.harness, sentBack.continue.create.taskId, sentBack.continue.create.kind, /sent job \d+ back[\s\S]*keep the first line/.test(sentBack.continue.create.request)],
    [true, "claude-code", tasks[0].id, "do", true]);
  check("it is no longer listed as needing review", d.list({ needsReview: true, limit: 500 }).some((r) => r.id === made[0].id), false);
  let twice = null;
  try { d.review(made[0].id, { accepted: true }); } catch (e) { twice = e.message; }
  check("a job is reviewed once", /already reviewed by you/.test(twice || ""), true);
  setFixture("claude-code", claudeAsk);
  const carried = d.create(sentBack.continue.create);
  await waitFor("the carried-on job", () => (d.tick(), d.get(carried.id).state === "done"));
  check("and the new job works in the same Workbench", d.get(carried.id).workbench.path, sentBack.run.workbench.path);
  const accepted = d.review(qa1.id, { accepted: true, note: "fine" });
  check("accepting records it and offers nothing more", [accepted.run.review, accepted.run.review_note, accepted.entry, accepted.continue], ["accepted", "fine", null, null]);
  const ro = d.review(qa2.id, { accepted: false });
  check("a job that only read has no Workbench to carry on in, and says so", [ro.continue.available, /only read/.test(ro.continue.why)], [false, true]);
  let unfinished = null;
  try { d.review(qa1.id + 1000, { accepted: true }); } catch (e) { unfinished = e.message; }
  check("there is no such job", /There is no job/.test(unfinished || ""), true);
  let notBool = null;
  try { d.review(qa3.id, { accepted: "yes" }); } catch (e) { notBool = e.message; }
  check("accepted must be true or false", /accepted: true or accepted: false/.test(notBool || ""), true);
  d.reply(qa1.id, "one more look");
  await waitFor("the reply turn", () => (d.tick(), d.get(qa1.id).state === "done" && runsOf(qa1.id).length === 2));
  check("a job that runs again needs reviewing again", [d.get(qa1.id).needs_review, d.get(qa1.id).review], [true, null]);

  // ------------------------------------------------------------------------------------
  section("an answer wakes the job waiting on it at once");
  setFixture("claude-code", claudeSlowAsk, claudeResumed);
  const nt = db.createTask({ projectId: project.id, title: "answered now" });
  const nj = d.create({ projectId: project.id, harness: "claude-code", request: "Ask and wait", taskId: nt.id, kind: "ask" });
  d.tick();
  const nactor = await waitFor("the actor", () => runsOf(nj.id).length && d.get(nj.id).actor);
  const nq = makeSheetStore({ sql: db.sqlP, actor: nactor, authorType: "agent" }).ask(nt.id, "Now?", ["yes", "no"]);
  await d.idle();
  check("waiting on a person", d.get(nj.id).state, "waiting_on_human");
  person.decide(nq.id, "a");
  check("the app's answer starts it in the same call, with no pass in between", [d.answered(nt.id), d.running().includes(nj.id)], [[nj.id], true]);
  await d.idle();
  const nt2 = db.createTask({ projectId: project.id, title: "answered from the command line" });
  const nj2 = d.create({ projectId: project.id, harness: "claude-code", request: "Ask again", taskId: nt2.id, kind: "ask" });
  d.tick();
  const nactor2 = await waitFor("the actor", () => runsOf(nj2.id).length && d.get(nj2.id).actor);
  const nq2 = makeSheetStore({ sql: db.sqlP, actor: nactor2, authorType: "agent" }).ask(nt2.id, "Then?", ["yes", "no"]);
  await d.idle();
  const agentDecides = await client.call("sheet_decide", { ask_id: nq2.id, choice: "b" }).catch((e) => ({ error: e.message }));
  check("an agent's answer through the server moves nothing", [agentDecides.resumed_jobs, d.get(nj2.id).state], [undefined, "waiting_on_human"]);
  // A second question, since the first is answered, for a person to answer.
  db.sqlP("DELETE FROM comments WHERE kind = 'decide' AND ref_id = :p1", [nq2.id]);
  const human = openServer({
    actor: "ray", clientName: "test-person", warn: () => {},
    // The sqlite3 binary route, where every call is its own process: the
    // decision and the resume are separate statements and must both land.
    env: { DELPHI_DB: process.env.DELPHI_DB, DELPHI_DATA_DIR: process.env.DELPHI_DATA_DIR, DELPHI_AUTHOR_TYPE: "human", DELPHI_CLIENT: "", DELPHI_SQLITE_ROUTE: "binary" },
  });
  await human.start();
  const byPerson = await human.call("sheet_decide", { ask_id: nq2.id, choice: "a", why: "go on" });
  check("a person's answer through the server queues the job in the same call", [byPerson.resumed_jobs, d.get(nj2.id).state, /Then\?.*a\) yes\. go on/.test(d.get(nj2.id).followup.replace(/\n/g, " "))], [[nj2.id], "queued", true]);
  human.close();
  d.tick();
  await d.idle();
  check("and the next pass runs it", d.get(nj2.id).state, "done");

  client.close();
  await d.idle();
}

main().catch((error) => {
  failures++;
  console.error(`  FAIL ${error.stack || error}`);
}).finally(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
});
