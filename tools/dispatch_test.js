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
const { createDispatcher, dangerous } = require("../agent/dispatch");
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

const claudeDo = fixture("claude_do.jsonl", [
  { type: "system", subtype: "init", cwd: "{{CWD}}", session_id: "sess-claude-1" },
  { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] }, session_id: "sess-claude-1" },
  { type: "user", message: { content: [{ tool_use_id: "tu1", type: "tool_result", content: "README.md", is_error: false }] } },
  { fake: "sleep", ms: 1500 },
  { fake: "write", file: "work.txt", text: "claude" },
  { type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "tu2", name: "Write", input: { file_path: "work.txt" } }] } },
  { type: "assistant", message: { id: "m3", content: [{ type: "text", text: "Wrote work.txt from Claude." }] } },
  { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 100, output_tokens: 20 }, total_cost_usd: 0.01 },
]);
const codexDo = fixture("codex_do.jsonl", [
  { type: "thread.started", thread_id: "thread-codex-1" },
  { type: "item.started", item: { id: "i1", type: "command_execution", command: "bash -lc ls", status: "in_progress" } },
  { type: "item.completed", item: { id: "i1", type: "command_execution", command: "bash -lc ls", aggregated_output: "README.md\n", exit_code: 0, status: "completed" } },
  { fake: "sleep", ms: 1500 },
  { fake: "write", file: "work.txt", text: "codex" },
  { type: "item.completed", item: { id: "i2", type: "file_change", changes: [{ path: "work.txt", kind: "add" }], status: "completed" } },
  { type: "item.completed", item: { id: "i3", type: "agent_message", text: "Wrote work.txt from Codex." } },
  { type: "turn.completed", usage: { input_tokens: 50, output_tokens: 10 } },
]);
const copilotDo = fixture("copilot_do.jsonl", [
  { type: "tool.execution_start", data: { toolCallId: "c1", toolName: "bash", arguments: { command: "ls" } } },
  { type: "tool.execution_complete", data: { toolCallId: "c1", success: true, result: { content: "README.md\n<exited with exit code 0>" } } },
  { fake: "sleep", ms: 1500 },
  { fake: "write", file: "work.txt", text: "copilot" },
  { type: "assistant.message", data: { messageId: "a1", content: "Wrote work.txt from Copilot.", outputTokens: 7 } },
  { type: "result", sessionId: "cop-sess-1" },
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
  if (wrappers[row.key]) db.updateHarness(row.id, { command: wrappers[row.key] });
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
const d = makeDispatcher();
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
    [true, "Bash", false, false]);
  const codexArgv = argvOf(1);
  check("Codex: its workspace-write sandbox, nothing wider",
    [codexArgv[codexArgv.indexOf("-s") + 1], codexArgv.filter((a) => a === "-s").length, codexArgv.includes("danger-full-access")], ["workspace-write", 1, false]);
  check("Copilot: tools only because the project allows unguarded agents", argvOf(2).includes("--allow-all-tools"), true);
  check("unguarded is recorded where it applies", after.map((r) => r.unguarded), [false, false, true]);
  check("each agent's MCP server is attributed to its job", runsOf(made[0].id)[0].mcpActor, `claude-code:job-${made[0].id}`);
  check("tokens and cost are recorded", [after[0].tokens_in, after[0].tokens_out, after[0].cost_usd, after[1].tokens_in, after[2].tokens_out], [100, 20, 0.01, 50, 7]);
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
  check("Claude Code reading gets the reading tools only", [claudeAskArgv[claudeAskArgv.indexOf("--tools") + 1], claudeAskArgv.includes("--allowedTools")], ["Read,Glob,Grep", false]);
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

  // ------------------------------------------------------------------------------------
  section("stop ends the agent's process group and leaves the Workbench");
  setFixture("claude-code", claudeHang);
  const st = db.createTask({ projectId: project.id, title: "long job" });
  const sj = d.create({ projectId: project.id, harness: "claude-code", request: "Take forever", taskId: st.id, kind: "do" });
  d.tick();
  const agentPid = await waitFor("the agent to start", () => d.get(sj.id).agent_pid);
  await waitFor("its command on the Sheet", () => entriesOf(st.id).some((e) => e.kind === "run"));
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
  const fresh = makeDispatcher();
  check("recovery fails this machine's dead job only", fresh.recover(), [rj.id]);
  check("as interrupted", [fresh.get(rj.id).state, /^interrupted/.test(fresh.get(rj.id).reply)], ["failed", true]);
  check("with a note on its Sheet", entriesOf(rt.id).some((e) => /interrupted/.test(e.body)), true);
  fresh.tick();
  check("and it is not run again", [fresh.running().length, fresh.get(rj.id).state, runsOf(rj.id).length], [0, "failed", 0]);
  db.sqlP("UPDATE handoffs SET state = 'stopped', status = 'cancelled' WHERE id = :p1", [elsewhere.id]);

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
  const tight = makeDispatcher({ hourlyLimit: 1 });
  const hp = tight.create({ projectId: project.id, harness: "codex", request: "a person's, held", kind: "ask" });
  db.sqlP("UPDATE projects SET auto_approve = 1 WHERE id = :p1", [project.id]);
  const ha = await client.call("handoff_send", { to: "codex", project_id: project.id, request: "an agent's, stopped" });
  db.sqlP("UPDATE projects SET auto_approve = 0 WHERE id = :p1", [project.id]);
  tight.tick();
  check("a person's job waits and says why", [tight.get(hp.id).state, /^Waiting: 1 jobs finished/.test(tight.get(hp.id).last_activity)], ["queued", true]);
  check("an agent's is stopped, since that is how a loop shows", [tight.get(ha.job_id).state, /Delphi stopped this one/.test(tight.get(ha.job_id).reply)], ["failed", true]);
  tight.stop(hp.id);

  section("guards");
  const unguardedProject = db.createProject({ key: "strict", name: "Strict", path: app });
  const noGuard = makeDispatcher({ guardStatus: () => ({ installed: false, file: null }) });
  const gt = db.createTask({ projectId: unguardedProject.id, title: "guarded?" });
  const gj = noGuard.create({ projectId: unguardedProject.id, harness: "claude-code", request: "edit", taskId: gt.id, kind: "do" });
  await waitFor("refused", () => (noGuard.tick(), noGuard.get(gj.id).state === "failed"));
  check("Claude Code without the guard is refused unless the project allows it", /guard\.py is not installed.*Allow unguarded agents/.test(noGuard.get(gj.id).reply), true);
  const ct = db.createTask({ projectId: unguardedProject.id, title: "copilot?" });
  const cj = d.create({ projectId: unguardedProject.id, harness: "copilot", request: "edit", taskId: ct.id, kind: "do" });
  await waitFor("refused", () => (d.tick(), d.get(cj.id).state === "failed"));
  check("Copilot changing code needs the project's say-so", /Allow unguarded agents/.test(d.get(cj.id).reply), true);
  check("a bypass flag in an edited template refuses the job", [dangerous(["-p", "x", "--permission-mode", "bypassPermissions"], false), dangerous(["--allow-all-tools"], false), dangerous(["--allow-all-tools"], true)], ["bypassPermissions", "--allow-all-tools", null]);

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
