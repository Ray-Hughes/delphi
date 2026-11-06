#!/usr/bin/env node
// main.js's IPC contract for Workbenches and composer runs, with Electron stubbed.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/main_ipc_test.js
//
// The renderer only ever reaches the main process through preload.js, so the
// contract is: every channel preload.js calls is one main.js handles, and the
// handlers do what they say. main.js is loaded for real, against a temp data
// folder, with the electron module replaced by a stub that records handlers
// and every message sent to the window. No window opens and no hotkey is taken.

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-main-ipc-")));
process.env.DELPHI_DATA_DIR = path.join(dir, "data");
// An agent session carries the id of its own database, and every server this
// starts would inherit it and refuse the temp one.
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "data", "delphi.db");
fs.mkdirSync(process.env.DELPHI_DATA_DIR);
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}
const home = path.join(dir, "home");
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = T\n\temail = t@example.invalid\n[init]\n\tdefaultBranch = main\n");
Object.assign(process.env, { HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"), DELPHI_GH: "none" });
delete process.env.DELPHI_WORKBENCH_DIR;

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

// ---------------------------------------------------------------------------
// The stub. Anything not named is a function that returns the stub, so the
// window, tray and menu code runs without knowing.

const handlers = new Map();
const sent = [];
const quitHooks = [];
const any = new Proxy(function stub() {}, {
  get: (_t, key) => (key === "then" ? undefined : key === Symbol.toPrimitive ? () => "" : any),
  apply: () => any,
  construct: () => any,
});
const windowStub = new Proxy({}, {
  get: (_t, key) => {
    if (key === "webContents") return new Proxy({}, { get: (_w, k) => (k === "send" ? (channel, payload) => sent.push([channel, payload]) : any) });
    if (key === "isDestroyed") return () => false;
    if (key === "then") return undefined;
    return any;
  },
});
const electron = new Proxy({}, {
  get: (_t, key) => {
    if (key === "app") {
      return new Proxy({}, {
        get: (_a, k) => {
          if (k === "whenReady") return () => Promise.resolve();
          if (k === "isPackaged") return false;
          if (k === "getPath") return () => home;
          if (k === "on") return (event, fn) => { if (event === "before-quit") quitHooks.push(fn); };
          if (k === "then") return undefined;
          return any;
        },
      });
    }
    if (key === "ipcMain") return { handle: (channel, fn) => handlers.set(channel, fn), on: () => {} };
    if (key === "BrowserWindow") return new Proxy(function BW() {}, { construct: () => windowStub, get: () => any });
    if (key === "clipboard") return { writeText: () => {} };
    if (key === "shell") return { openPath: async () => "", openExternal: () => {}, showItemInFolder: () => {} };
    return any;
  },
});
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === "electron") return electron;
  return realLoad.call(this, request, ...rest);
};

require("../main.js");
const db = require("../db");

async function call(channel, ...args) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  const r = await fn({}, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await wait(300);

  section("every channel preload.js calls is handled");
  const preload = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  const called = [...preload.matchAll(/call\("([^"]+)"/g)].map((m) => m[1]);
  const missing = called.filter((c) => !handlers.has(c));
  check("no channel is missing a handler", missing, []);
  for (const c of ["workbench:forTask", "workbench:candidates", "workbench:start", "workbench:open", "workbench:status",
    "workbench:park", "workbench:resume", "workbench:update", "workbench:commit", "workbench:push", "workbench:pr",
    "workbench:finish", "workbench:discardPlan", "workbench:discard", "workbench:recreate", "workbench:forget",
    "workbench:list", "workbench:advanced", "repos:update", "sheet:run", "sheet:interrupt"]) {
    check(`${c} is in preload and handled`, [called.includes(c), handlers.has(c)], [true, true]);
  }
  for (const c of ["sessions:changes", "sessions:archive", "sessions:delete"]) {
    check(`${c} is in preload and handled`, [called.includes(c), handlers.has(c)], [true, true]);
  }
  for (const event of ["onWorkbenchEvent", "onWorkbenchPrompt", "onSheetRunOutput", "onSheetRunDone"]) {
    check(`preload exposes ${event}`, preload.includes(`${event}:`), true);
  }

  section("a Workbench from the app");
  const origin = path.join(dir, "origin.git");
  const repo = path.join(dir, "code", "app");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "--quiet", origin, repo], { stdio: "ignore" });
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "a"]);
  execFileSync("git", ["-C", repo, "push", "--quiet", "origin", "main"]);
  const project = db.createProject({ key: "ipc", name: "IPC", path: repo });
  const task = db.createTask({ projectId: project.id, title: "From the app" });
  check("no Workbench yet", await call("workbench:forTask", task.id), null);
  check("candidates", (await call("workbench:candidates", task.id)).map((c) => c.path), [fs.realpathSync(repo)]);
  const wb = await call("workbench:start", task.id, { runSetup: false });
  check("start returns the Workbench", [wb.task_id, wb.state, wb.created, fs.existsSync(wb.path)], [task.id, "active", true, true]);
  check("progress went to the window", sent.filter(([c]) => c === "workbench-event").map(([, p]) => p.phase), ["fetching", "creating", "copying", "ready"]);
  const detail = await call("tasks:detail", task.id);
  check("tasks:detail carries it, with status", [detail.workbench.id, detail.workbench.status.words], [wb.id, "Ready"]);
  check("status", (await call("workbench:status", wb.id, { fresh: true })).state, "ready");
  check("list", (await call("workbench:list", { projectId: project.id })).map((w) => w.id), [wb.id]);
  check("advanced", (await call("workbench:advanced", wb.id)).branch, wb.branch);
  check("park", (await call("workbench:park", wb.id)).state, "parked");
  check("resume", (await call("workbench:resume", wb.id)).state, "active");
  const row = db.handle().prepare("SELECT id FROM repos WHERE project_id = ?").get(project.id);
  check("repos:update", (await call("repos:update", row.id, { setup_cmd: "", copy_files: ".env, .npmrc" })).copy_files, ".env,.npmrc");
  let refused = null;
  try { await call("workbench:discard", wb.id, "nope"); } catch (e) { refused = e.message; }
  check("discard re-checks the typed number", /Type \d+, the task's number/.test(refused || ""), true);
  check("open in a folder", await call("workbench:open", wb.id, "folder"), { opened: true, via: "folder" });

  section("done prompts Finish");
  sent.length = 0;
  await call("tasks:update", task.id, { status: "done" });
  const prompt = sent.find(([c]) => c === "workbench-prompt");
  check("workbench-prompt is sent with the task and the Workbench",
    prompt && [prompt[1].taskId, prompt[1].workbenchId, prompt[1].path, prompt[1].branch],
    [task.id, wb.id, wb.path, wb.branch]);
  sent.length = 0;
  await call("tasks:update", task.id, { title: "renamed" });
  check("no prompt for other changes", sent.some(([c]) => c === "workbench-prompt"), false);
  await call("tasks:update", task.id, { status: "done" });
  check("nor for done again", sent.some(([c]) => c === "workbench-prompt"), false);
  const finished = await call("workbench:finish", wb.id);
  check("finish", [finished.finished, fs.existsSync(wb.path)], [true, false]);

  // Before composer runs, whose quit hooks shut the dispatcher down.
  section("runs: review, reorder, and a decision that wakes a job");
  for (const c of ["runs:list", "runs:review", "runs:reorder", "runs:reply", "sheet:decide"]) {
    check(`${c} is in preload and handled`, [called.includes(c), handlers.has(c)], [true, true]);
  }
  const runProject = db.createProject({ key: "ipc-runs", name: "IPC runs", path: dir });
  const runTask2 = db.createTask({ projectId: runProject.id, title: "job to review" });
  // A harness with no row: if anything starts these, it fails at once and
  // spawns nothing, so no real agent CLI can be reached from this test.
  const doneJob = db.sqlP(`INSERT INTO handoffs (project_id, to_harness, task_id, request, kind, state, status, finished_at)
                           VALUES (:p1, 'nobody', :p2, 'done already', 'ask', 'done', 'ready', datetime('now')) RETURNING id`, [runProject.id, runTask2.id])[0].id;
  check("runs:list({needsReview: true}) lists it", (await call("runs:list", { needsReview: true })).map((r) => r.id), [doneJob]);
  const reviewed = await call("runs:review", doneJob, { accepted: false, note: "Not this way." });
  check("runs:review sends it back: { run, entry, continue }",
    [reviewed.run.review, reviewed.entry.body, reviewed.entry.author_type, reviewed.continue.available], ["sent_back", "Not this way.", "human", false]);
  check("and it leaves the list", (await call("runs:list", { needsReview: true })).length, 0);
  const badReview = await handlers.get("runs:review")({}, doneJob, { accepted: true });
  check("a second review is refused", [badReview.ok, /already reviewed/.test(badReview.error)], [false, true]);
  const q1 = db.sqlP(`INSERT INTO handoffs (project_id, to_harness, request, state, status) VALUES (:p1, 'nobody', 'q1', 'queued', 'queued') RETURNING id`, [runProject.id])[0].id;
  const q2 = db.sqlP(`INSERT INTO handoffs (project_id, to_harness, request, state, status) VALUES (:p1, 'nobody', 'q2', 'queued', 'queued') RETURNING id`, [runProject.id])[0].id;
  check("runs:reorder returns the queue in its new order", (await call("runs:reorder", [q2, q1])).map((r) => [r.id, r.queue_rank]), [[q2, 1], [q1, 2]]);
  const badOrder = await handlers.get("runs:reorder")({}, [doneJob]);
  check("only queued jobs", [badOrder.ok, /not queued/.test(badOrder.error)], [false, true]);
  db.sqlP("UPDATE handoffs SET state = 'stopped', status = 'cancelled' WHERE id IN (:p1, :p2)", [q1, q2]);
  const waitTask = db.createTask({ projectId: runProject.id, title: "waiting on a person" });
  const waiting = db.sqlP(`INSERT INTO handoffs (project_id, to_harness, task_id, request, kind, state, status, actor, updated_at)
                           VALUES (:p1, 'nobody', :p2, 'wait', 'ask', 'waiting_on_human', 'running', 'nobody:job', datetime('now', '-1 minute')) RETURNING id`, [runProject.id, waitTask.id])[0].id;
  const asked = require("../sheet/store").makeSheetStore({ sql: db.sqlP, actor: "nobody:job", authorType: "agent" }).ask(waitTask.id, "Which?", ["this", "that"]);
  await call("sheet:decide", asked.id, "a", null);
  const woken = db.sqlP("SELECT state, reply FROM handoffs WHERE id = :p1", [waiting])[0];
  check("sheet:decide starts the waiting job in the same call, not at the next pass",
    [woken.state, /no agent called "nobody"/.test(woken.reply || "")], ["failed", true]);

  section("composer runs");
  const runTask = db.createTask({ projectId: project.id, title: "run here" });
  sent.length = 0;
  const started = await call("sheet:run", runTask.id, "echo one; echo two");
  check("sheet:run resolves with the entry once it starts", [started.kind, started.meta.state, started.author], ["run", "running", "you"]);
  check("in the project's repository", started.meta.cwd, fs.realpathSync(repo));
  await wait(800);
  const output = sent.filter(([c]) => c === "sheet-run-output").map(([, p]) => p);
  check("output arrives on sheet-run-output", [output.every((p) => p.entryId === started.id && p.taskId === runTask.id), output.map((p) => p.chunk).join("")], [true, "one\ntwo\n"]);
  const done = sent.find(([c]) => c === "sheet-run-done");
  check("and the finished entry on sheet-run-done", done && [done[1].entryId, done[1].entry.meta.state, done[1].entry.meta.out], [started.id, "ok", "one\ntwo"]);
  const refusedRun = await call("sheet:run", runTask.id, "rm -rf /");
  check("the guard refuses, and that is the entry returned", [refusedRun.meta.state, refusedRun.meta.code], ["fail", "guard"]);
  sent.length = 0;
  const long = await call("sheet:run", runTask.id, "trap '' INT; sleep 20");
  await call("sheet:interrupt", long.id);
  await call("sheet:interrupt", long.id);
  await wait(800);
  const stopped = sent.find(([c]) => c === "sheet-run-done");
  check("interrupt twice kills it, and says killed (137)", stopped && [stopped[1].entry.meta.state, stopped[1].entry.meta.code], ["fail", 137]);
  let notRunning = null;
  try { await call("sheet:interrupt", long.id); } catch (e) { notRunning = e.message; }
  check("interrupting a finished run says so", /not running/.test(notRunning || ""), true);
  const quitting = await call("sheet:run", runTask.id, "sleep 20");
  for (const hook of quitHooks) hook();
  const afterQuit = JSON.parse(db.handle().prepare("SELECT meta FROM comments WHERE id = ?").get(quitting.id).meta);
  check("quitting finishes a running composer run at once", [afterQuit.state, afterQuit.code], ["fail", "quit"]);

  section("logs");
  const log = await call("sheet:log", started.id);
  check("a run's log", log.text, "one\ntwo\n");
  const say = await call("sheet:append", runTask.id, { kind: "say", body: "hello" });
  let notRun = null;
  try { await call("sheet:log", say.id); } catch (e) { notRun = e.message; }
  check("a say has no log", /not a run/.test(notRun || ""), true);
  const logFile = path.join(process.env.DELPHI_DATA_DIR, "sheets", String(runTask.id), `${started.id}.log`);
  await call("tasks:uncomment", started.id);
  check("deleting a run deletes its log", fs.existsSync(logFile), false);

  section("a multi-line command shows and copies in full");
  {
    const { makeSheetStore } = require("../sheet/store");
    const agentSheet = makeSheetStore({ sql: db.sqlP, actor: "claude-code:1", authorType: "agent" });
    const script = "set -e\nnpm ci\nnpm test";
    const multi = agentSheet.append({ taskId: runTask.id, kind: "run", body: "set -e ...", meta: { state: "ok", code: 0, script } });
    const logPath = path.join(process.env.DELPHI_DATA_DIR, "sheets", String(runTask.id), `${multi.id}.log`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "all green\n");
    check("copy gives the whole script", await call("sheet:copy", multi.id), script);
    check("copy with output gives the script, then the output", await call("sheet:copy", multi.id, { withOutput: true }), `${script}\nall green`);
    check("the log leads with the script", (await call("sheet:log", multi.id)).text, `$ ${script}\n\nall green\n`);
    const single = agentSheet.append({ taskId: runTask.id, kind: "run", body: "echo one", meta: { state: "ok", code: 0 } });
    check("a one line command copies as its body", await call("sheet:copy", single.id), "echo one");
  }

  section("settings");
  const got = await call("settings:get");
  check("the default branch prefix is there to show, and is naming.js's",
    got.workbenchBranchPrefixDefault, require("../workbench/naming").defaultPrefix());

  check("the dispatcher's settings and pinned projects have defaults", [got.jobConcurrency, got.jobHarnessLimits, got.pinnedProjects], [3, {}, []]);
  const refusedSet = async (fields) => { const r = await handlers.get("settings:set")({}, fields); return r.ok ? null : r.error; };
  check("jobConcurrency is a whole number from 1 to 8",
    [await refusedSet({ jobConcurrency: 0 }), await refusedSet({ jobConcurrency: 9 }), await refusedSet({ jobConcurrency: 2.5 }), (await call("settings:set", { jobConcurrency: 8 })).jobConcurrency],
    ["jobConcurrency must be a whole number from 1 to 8", "jobConcurrency must be a whole number from 1 to 8", "jobConcurrency must be a whole number from 1 to 8", 8]);
  check("a harness's limit is a whole number from 0 to 4, and the map is replaced whole",
    [await refusedSet({ jobHarnessLimits: { codex: 5 } }), await refusedSet({ jobHarnessLimits: [1] }), await refusedSet({ jobHarnessLimits: { "no spaces": 1 } }),
     (await call("settings:set", { jobHarnessLimits: { codex: 0, "claude-code": "2" } })).jobHarnessLimits],
    ["jobHarnessLimits.codex must be a whole number from 0 to 4", "jobHarnessLimits must be an object of harness key to a number", "\"no spaces\" is not a harness key", { codex: 0, "claude-code": 2 }]);
  const pinA = db.createProject({ key: "pin-a", name: "Pin A" });
  const pinB = db.createProject({ key: "pin-b", name: "Pin B" });
  check("pinned projects are existing ids, in order, once each",
    [await refusedSet({ pinnedProjects: [pinA.id, 999999] }), await refusedSet({ pinnedProjects: "1" }),
     (await call("settings:set", { pinnedProjects: [pinB.id, String(pinA.id), pinB.id] })).pinnedProjects],
    ["No project 999999", "pinnedProjects must be a list of project ids", [pinB.id, pinA.id]]);
  check("hidden from Active keeps existing projects with their time, and drops the rest",
    [await refusedSet({ hiddenFromActive: "1" }),
     (await call("settings:set", { hiddenFromActive: [{ id: pinA.id, at: "2026-01-02 03:04:05" }, { id: 999999, at: "2026-01-02 03:04:05" }, { id: pinA.id, at: "nonsense" }] })).hiddenFromActive.map((h) => [h.id, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(h.at)])],
    ["hiddenFromActive must be a list of { id, at }", [[pinA.id, true]]]);
  await call("settings:set", { hiddenFromActive: [] });
  check("a refused field changes nothing", (await call("settings:get")).jobConcurrency, 8);
  check("and the dispatcher reads them on its next pass", JSON.parse(fs.readFileSync(path.join(process.env.DELPHI_DATA_DIR, "settings.json"), "utf8")).jobHarnessLimits, { codex: 0, "claude-code": 2 });
  await call("settings:set", { jobConcurrency: 3, jobHarnessLimits: {}, pinnedProjects: [] });

  section("where the data lives");
  const info = await call("app:dataInfo");
  const locate = require("../agent/locate");
  check("app:dataInfo names the database this process really opened, and its folder",
    [info.path, info.dataDir, info.resolvedBy], [process.env.DELPHI_DB, process.env.DELPHI_DATA_DIR, "DELPHI_DB"]);
  check("and its id, the same one the file holds", info.dbId, db.identity().db_id);
  check("the id is a uuid", /^[0-9a-f-]{36}$/.test(String(info.dbId)), true);
  check("an ignored checkout database is a path or null, never a boolean",
    info.checkoutDbIgnored, locate.resolve().checkoutDbIgnored);
  check("preload exposes it as delphi.app.dataInfo", /app: \{[\s\S]*?dataInfo: \(\) => call\("app:dataInfo"\)/.test(preload), true);
  const notShown = await handlers.get("settings:set")({}, { checkoutNoticeSeen: "/somewhere/else.db" });
  check("acknowledging a notice nobody was shown is refused", notShown.ok, false);
  if (info.checkoutDbIgnored) {
    await call("settings:set", { checkoutNoticeSeen: info.checkoutDbIgnored });
    check("once acknowledged, the notice is no longer due", (await call("app:dataInfo")).checkoutNoticeDue, false);
  }
  const beat = require("../agent/identity").appState(locate.resolve(), { isAlive: require("../sheet/store").pidAlive, processes: () => [] });
  check("the app has written its heartbeat, so agents see it running", [beat.running, beat.pid], [true, process.pid]);

  section("refusals keep their code");
  const loose = db.createTask({ projectId: null, title: "in no project" });
  const coded = await handlers.get("workbench:start")({}, loose.id, {});
  check("a coded refusal crosses with its code, the message unchanged",
    [coded.ok, coded.code, /not in a project/.test(coded.error)], [false, "NO_PROJECT", true]);
  const plain = await handlers.get("sheet:log")({}, 999999);
  check("an uncoded one has no code", [plain.ok, plain.code], [false, undefined]);
  const preloadText = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  check("preload carries code and details through", /code: result\.code, details:/.test(preloadText), true);

  section("items and flags");
  for (const c of ["items:plan", "items:move", "items:copy", "items:associate", "items:dissociate", "items:where", "items:flag",
    "items:rehomePlan", "items:rehome", "flags:list", "flags:get", "flags:reply", "flags:evaluate", "flags:approve",
    "flags:reject", "flags:withdraw", "flags:sweep"]) {
    check(`${c} is in preload and handled`, [called.includes(c), handlers.has(c)], [true, true]);
  }
  check("preload exposes onFlagsChanged", preload.includes("onFlagsChanged:"), true);
  const here = db.createProject({ key: "ipc-here", name: "IPC here" });
  const there = db.createProject({ key: "ipc-there", name: "IPC there" });
  const parent = db.createTask({ projectId: here.id, title: "moves whole" });
  const kid = db.createTask({ parentId: parent.id, title: "its kid" });
  const planned = await call("items:plan", { op: { op: "move", entity: "task", id: parent.id, to: there.id } });
  check("plan", [planned.ok, planned.counts.subtasks], [true, 1]);
  const moved = await call("items:move", { entity: "task", id: parent.id, to: there.id, options: { keepInSource: true } });
  check("move returns the audit id and the tasks", [typeof moved.auditId, moved.moved.tasks.sort()], ["number", [parent.id, kid.id].sort()]);
  check("tasks:update with a project moves the subtree too", await (async () => {
    await call("tasks:update", parent.id, { project_id: here.id });
    return db.handle().prepare("SELECT project_id FROM tasks WHERE id = ?").get(kid.id).project_id;
  })(), here.id);
  const subtaskMove = await handlers.get("items:move")({}, { entity: "task", id: kid.id, to: there.id });
  check("a refused move is {ok: false} with the sentence and REFUSED", [subtaskMove.ok, subtaskMove.code, /moves with its parent/.test(subtaskMove.error), Array.isArray(subtaskMove.details.refusals)],
    [false, "REFUSED", true, true]);
  const where = await call("items:where", { entity: "task", id: parent.id });
  check("where", [where.home.id, where.also.map((p) => p.id)], [here.id, []]);
  const sentBefore = sent.length;
  const flagged = await call("items:flag", { entity: "task", id: parent.id, note: "belongs in IPC there", evaluate: "oracle" });
  check("flag returns the flag, evaluated", [flagged.appended, flagged.flag.status, flagged.flag.proposal.ops[0].to], [false, "proposed", there.id]);
  check("flags-changed went to the window", sent.slice(sentBefore).some(([c, p]) => c === "flags-changed" && p.flagId === flagged.flag.id), true);
  const needs = await call("flags:list", { needsYou: true });
  check("Needs you rows", needs.some((r) => r.source === "flag" && r.id === flagged.flag.id && r.kind === "decision"), true);
  const noEntry = await handlers.get("flags:approve")({}, flagged.flag.id, { note: "yes" });
  check("approve without the entry the person saw is refused", [noEntry.ok, /needs the proposal you looked at/.test(noEntry.error)], [false, true]);
  const approved = await call("flags:approve", flagged.flag.id, { note: "yes", entryId: flagged.flag.proposal_entry_id });
  check("approve applies", [approved.flag.status, db.handle().prepare("SELECT project_id FROM tasks WHERE id = ?").get(parent.id).project_id], ["applied", there.id]);
  const selfDecided = db.createNote({ projectId: here.id, title: "decide it myself", body: "x" });
  const openFlag = await call("items:flag", { entity: "note", id: selfDecided.id, note: "?", evaluate: "none" });
  const mine = await call("flags:approve", openFlag.flag.id, { ops: [{ op: "move", entity: "note", id: selfDecided.id, to: there.id }], note: "mine" });
  check("flags:approve with the person's own ops and no entryId applies them", [mine.flag.status,
    db.handle().prepare("SELECT project_id FROM notes WHERE id = ?").get(selfDecided.id).project_id], ["applied", there.id]);
  const swept = await call("flags:sweep", {});
  check("sweep answers in its shape", [Array.isArray(swept.created), typeof swept.skipped], [true, "number"]);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
