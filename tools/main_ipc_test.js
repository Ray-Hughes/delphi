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
  check("interrupt twice kills it", stopped && [stopped[1].entry.meta.state, stopped[1].entry.meta.code], ["fail", 130]);
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

  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
