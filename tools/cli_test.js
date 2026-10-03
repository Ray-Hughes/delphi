#!/usr/bin/env node
// bin/delphi end to end: a task worked start to finish from the shell.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/cli_test.js
//
// Every command runs as a separate process with stdout a pipe, so this is also
// the "piped is clean" case: what `delphi cat 42 | pbcopy` would copy. Then the
// same, through a plain node when there is one, since that is what a shell's
// `delphi` runs under.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-cli-"));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const oracle = require("../oracle");
const fmt = require("../sheet/format");
const { openServer } = require("../sheet/client");

const CLI = path.join(__dirname, "..", "bin", "delphi");

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

const folder = path.join(dir, "checkout");
fs.mkdirSync(folder);
const project = db.createProject({ key: "cli", name: "CLI", path: folder });
oracle.open(db.handle());

let ME = "you";
try { ME = os.userInfo().username || ME; } catch {}

function plainNode() {
  const r = spawnSync("node", ["-e", "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)"], { encoding: "utf8" });
  return r.status === 0 ? "node" : null;
}

function makeRunner(binary, extraEnv) {
  return (args, { env = {}, input } = {}) => {
    const childEnv = { ...process.env, ...extraEnv, ...env };
    for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
    const r = spawnSync(binary, [CLI, ...args], { env: childEnv, encoding: "utf8", input, timeout: 60000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
}

const entryRow = (id) => {
  const row = db.handle().prepare("SELECT * FROM comments WHERE id = ?").get(Number(id));
  return row ? { ...row, meta: row.meta ? JSON.parse(row.meta) : null } : null;
};

function suite(label, delphi) {
  section(`${label}: resolving and writing`);
  const task = db.createTask({ projectId: project.id, title: `ship it over ${label}` });
  const tag = `${task.id}`;
  db.handle().prepare("UPDATE tasks SET legacy_id = ?, ref = ? WHERE id = ?").run(`T-${tag}`, `CLI-${tag}`, task.id);

  const help = delphi(["help"]);
  check("help exits 0", [help.code, /delphi cat <task>/.test(help.out)], [0, true]);
  check("help for one command", /--cwd DIR/.test(delphi(["help", "run"]).out), true);
  const unknown = delphi(["frobnicate"]);
  check("an unknown command exits 1 and says so", [unknown.code, /no command 'frobnicate'/.test(unknown.err)], [1, true]);

  const said = delphi(["say", `CLI-${tag}`, "the DLQ fills at 9am"], { env: { DELPHI_ACTOR: undefined, DELPHI_AUTHOR_TYPE: undefined } });
  check("say by ref prints the bare id when piped", [said.code, /^\d+\n$/.test(said.out)], [0, true]);
  const saidRow = entryRow(said.out);
  check("attributed to the OS user, as a human", [saidRow.task_id, saidRow.author, saidRow.author_type, saidRow.body], [task.id, ME, "human", "the DLQ fills at 9am"]);
  const audit = db.handle().prepare("SELECT summary FROM audit WHERE entity = 'task' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(task.id);
  check("History says who", audit.summary, `commented (by ${ME})`);

  const byLegacy = delphi(["say", `T-${tag}`, "by legacy id"], { env: { DELPHI_ACTOR: "claude-code:4" } });
  // Null on disk: an actor that was named rather than defaulted is not
  // declared, and the store infers it from the name when it is read.
  check("say by legacy id, as a named actor", [entryRow(byLegacy.out).task_id, entryRow(byLegacy.out).author, entryRow(byLegacy.out).author_type], [task.id, "claude-code:4", null]);
  check("which reads back as an agent", fmt.parse(delphi(["cat", tag, "--raw"]).out).entries[1].author_type, "agent");
  const noted = delphi(["note", tag, "bumped the timeout to 15m", "--promote"]);
  check("note --promote by id", [entryRow(noted.out).kind, entryRow(noted.out).promoted], ["note", 1]);
  const missing = delphi(["say", "NOPE-404", "x"]);
  check("an unknown task exits 1 in words", [missing.code, /No task matches 'NOPE-404'/.test(missing.err)], [1, true]);

  section(`${label}: running`);
  const hi = delphi(["run", tag, "--", "echo", "hi"]);
  check("run prints the output and exits 0", [hi.code, hi.out], [0, "hi\n"]);
  const hiId = Number((hi.err.match(/entry (\d+)/) || [])[1]);
  const hiRow = entryRow(hiId);
  check("the entry is ok with short output inline", [hiRow.kind, hiRow.body, hiRow.meta.state, hiRow.meta.out, hiRow.meta.lines], ["run", "echo hi", "ok", "hi", 1]);
  check("it ran in the project's folder", hiRow.meta.cwd, folder);
  check("the log is under DATA_DIR/sheets/<task>/<entry>.log", fs.readFileSync(path.join(dir, "sheets", String(task.id), `${hiId}.log`), "utf8"), "hi\n");

  const failing = delphi(["run", tag, "--cwd", dir, "--", "echo nope; exit 3"]);
  const failId = Number((failing.err.match(/entry (\d+)/) || [])[1]);
  check("a failing command exits with its code", [failing.code, entryRow(failId).meta.state, entryRow(failId).meta.code], [3, "fail", 3]);
  check("--cwd is honoured", entryRow(failId).meta.cwd, dir);

  const marker = path.join(dir, `guarded-${label.replace(/\W/g, "")}`);
  const refused = delphi(["run", tag, "--", "rm", "-rf", "/", ";", "touch", marker]);
  const refusedId = Number((refused.err.match(/entry (\d+)/) || [])[1]);
  const refusedRow = entryRow(refusedId);
  check("a guarded command exits 2", refused.code, 2);
  check("and says why", /Blocked by guard: Recursive force delete/.test(refused.err), true);
  check("the refusal is recorded with its reason",
        [refusedRow.meta.state, refusedRow.meta.code, /^Blocked by guard: Recursive force delete/.test(refusedRow.meta.out)], ["fail", "guard", true]);
  check("nothing ran", fs.existsSync(marker), false);

  const long = delphi(["run", tag, "--", "printf '\\033[32mline\\033[0m %s\\n' 1 2 3 4 5 6 7"]);
  const longId = Number((long.err.match(/entry (\d+)/) || [])[1]);
  check("long output is not inline", [entryRow(longId).meta.lines, entryRow(longId).meta.out], [7, undefined]);
  const out = delphi(["out", String(longId)]);
  check("out, piped, is the log without colour", out.out, "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\n");
  check("out --raw keeps it", delphi(["out", String(longId), "--raw"]).out.includes("\x1b[32m"), true);
  check("out of a refused run is its reason", /Blocked by guard/.test(delphi(["out", String(refusedId)]).out), true);
  check("out of a say has nothing to show", /is a say, not a run, so it has no output/.test(delphi(["out", said.out.trim()]).err), true);
  check("a run with no command is a usage error", delphi(["run", tag]).code, 1);

  section(`${label}: asking and deciding`);
  const asked = delphi(["ask", tag, "retry strategy", "exponential", "fixed"]);
  const askId = Number(asked.out);
  check("ask", [entryRow(askId).kind, entryRow(askId).meta.options.map((o) => o.label)], ["ask", ["exponential", "fixed"]]);
  check("one option is refused", delphi(["ask", tag, "q", "only"]).code, 1);
  const decided = delphi(["decide", String(askId), "a", "--why", "backs off under load"]);
  const decideRow = entryRow(decided.out);
  check("decide is promoted and points at the ask", [decideRow.kind, decideRow.ref_id, decideRow.promoted, decideRow.body], ["decide", askId, 1, "a\nbacks off under load"]);
  check("a choice not offered is refused", /Choose one of a, b/.test(delphi(["decide", String(askId), "d"]).err), true);

  section(`${label}: promoting and filing`);
  check("promote", entryRow(delphi(["promote", String(hiId)]).out).promoted, 1);
  check("promote --off", entryRow(delphi(["promote", String(hiId), "--off"]).out).promoted, 0);
  const unique = `quokkafinding${label.replace(/[^a-z]/g, "")}`;
  const finding = delphi(["say", tag, `${unique}: the consumer drops messages over 256KB`]);
  const filed = delphi(["file", finding.out.trim(), "gotcha", "--title", "Consumer drops large messages"]);
  const noteId = Number(filed.out);
  const note = db.handle().prepare("SELECT title, kind, project_id FROM notes WHERE id = ?").get(noteId);
  check("file makes a project note", { ...note }, { title: "Consumer drops large messages", kind: "gotcha", project_id: project.id });
  check("a bad entry id is a usage error", delphi(["file", "abc", "gotcha"]).code, 1);

  section(`${label}: reading`);
  const piped = delphi(["cat", tag]);
  check("cat piped exits 0", piped.code, 0);
  check("cat piped is clean: no metadata blocks", /\{id:\d+/.test(piped.out), false);
  check("cat piped reads back as clean text", fmt.format(fmt.parse(piped.out, { clean: true }), { clean: true }), piped.out);
  check("it starts with the header", piped.out.startsWith(`---\ntask: ${task.id}\ntitle: ship it over ${label}\nproject: cli\n`), true);
  check("and has the work in it", [`> ${ME}: the DLQ fills at 9am`, "$ echo hi\n  hi", "? retry strategy: [a] exponential [b] fixed", "= a\n  backs off under load"]
    .every((s) => piped.out.includes(s)), true);
  const raw = delphi(["cat", tag, "--raw"]);
  check("--raw has the ids", raw.out.includes(`{id:${hiId} `), true);
  check("--raw and clean agree once stripped", fmt.clean(raw.out), piped.out);
  const ledger = delphi(["cat", tag, "--ledger"]).out;
  check("--ledger is the promoted entries and the decided question",
        fmt.parse(ledger, { clean: true }).entries.map((e) => e.kind), ["note", "ask", "decide", "say"]);
  check("--tail 2", fmt.parse(delphi(["cat", tag, "--tail", "2"]).out, { clean: true }).entries.length, 2);
  check("--tail needs a number", delphi(["cat", tag, "--tail", "x"]).code, 1);

  section(`${label}: importing`);
  const copy = db.createTask({ projectId: project.id, title: `copy over ${label}` });
  const file = path.join(dir, `export-${copy.id}.sheet`);
  fs.writeFileSync(file, raw.out + "~ a link line nobody imports\n");
  const imported = delphi(["import", String(copy.id), file]);
  check("import exits 0 and counts", [imported.code, /imported \d+ entries into task/.test(imported.err), /skipped 1/.test(imported.err)], [0, true, true]);
  const copied = db.handle().prepare("SELECT id, kind, body, promoted, ref_id FROM comments WHERE task_id = ? ORDER BY id").all(copy.id);
  const original = db.handle().prepare("SELECT id, kind, body, promoted FROM comments WHERE task_id = ? ORDER BY id").all(task.id);
  check("every entry came across, with new ids", [copied.length, copied.every((c) => !original.some((o) => o.id === c.id))], [original.length, true]);
  check("bodies and kinds match", copied.map((c) => [c.kind, c.body]), original.map((o) => [o.kind, o.body]));
  const newAsk = copied.find((c) => c.kind === "ask");
  check("the decision points at the imported question", copied.find((c) => c.kind === "decide").ref_id, newAsk.id);
  const fromClean = db.createTask({ projectId: project.id, title: `clean copy over ${label}` });
  const cleanFile = path.join(dir, `clean-${fromClean.id}.sheet`);
  fs.writeFileSync(cleanFile, piped.out);
  delphi(["import", String(fromClean.id), cleanFile, "--clean"]);
  check("import --clean reads clean text",
        db.handle().prepare("SELECT COUNT(*) AS n FROM comments WHERE task_id = ?").get(fromClean.id).n, original.length - 1);

  return { task, noteId, unique };
}

async function finish({ task, noteId, unique }, label) {
  section(`${label}: finishing, and what the next agent finds`);
  // The shell has no verb to close a task yet (that arrives with Workbenches),
  // so the finish is what an agent does: claim and complete.
  oracle.rebuild(db.handle());
  db.setQueue(task.id, `cli-${task.id}`);
  const client = openServer({ actor: "claude-code:5", clientName: "test", warn: () => {} });
  await client.start();
  try {
    await client.call("queue_next", { queue: `cli-${task.id}` });
    await client.call("queue_complete", { task_id: task.id, summary: "replayed the DLQ and raised the size limit" });
    const found = await client.call("oracle_ask", { question: `what about ${unique}` });
    check("the note filed from the shell appears in oracle_ask", found.notes.some((n) => n.id === noteId), true);
    const next = await client.call("get_task", { id: task.id });
    check("the next agent's sheet text has the ledger", next.sheet.includes("replayed the DLQ"), true);
  } finally {
    client.close();
  }
}

/** The G2 review's findings about the command line, each as it was reproduced. */
async function review(delphi) {
  const task = db.createTask({ projectId: project.id, title: "review findings" });
  const id = String(task.id);
  const lastRun = () => entryRow(db.handle().prepare("SELECT MAX(id) AS id FROM comments WHERE task_id = ? AND kind = 'run'").get(task.id).id);

  section("item 2: run does not hand its argv to the shell twice");
  const marker = path.join(dir, "INJECTED");
  const injected = delphi(["run", id, "--", "echo", `x; touch ${marker}`]);
  check("several arguments are each one word", [injected.code, injected.out.trim(), fs.existsSync(marker)], [0, `x; touch ${marker}`, false]);
  check("and the recorded command reruns identically", lastRun().body, `echo 'x; touch ${marker}'`);
  const piped = delphi(["run", id, "--", "echo one | tr o 0"]);
  check("one argument is the command as written", piped.out.trim(), "0ne");
  check("plain words stay plain", (delphi(["run", id, "--", "echo", "a-b", "c/d"]), lastRun().body), "echo a-b c/d");

  section("item 3: a closed terminal finishes the run");
  // Unique to this run. pgrep sees every process on the machine, and another
  // run of this test (another worktree, another agent) has the same commands:
  // matching those was the flake, with theirs alive when ours was not.
  const RUNTAG = `${process.pid}-${Date.now()}`;
  {
    // The hangup arriving before the command has even started (while the
    // guard is asked) is kept and delivered, not dropped.
    const { spawn } = require("child_process");
    const child = spawn(process.execPath, [CLI, "run", id, "--", `sleep 31; echo early-${RUNTAG}`], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise((r) => child.on("close", (c) => r(c)));
    const until = async (test, ms) => { const end = Date.now() + ms; while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); return test(); };
    await until(() => { const r = lastRun(); return r && r.body === `sleep 31; echo early-${RUNTAG}`; }, 20000);
    child.kill("SIGHUP");
    await closed;
    const row = lastRun();
    check("a hangup before the command starts still ends it", [row.body, row.meta.state], [`sleep 31; echo early-${RUNTAG}`, "fail"]);
    check("and nothing is left running", await until(() => spawnSync("pgrep", ["-f", ` -c sleep 31; echo early-${RUNTAG}`], { encoding: "utf8" }).stdout.trim() === "", 10000), true);
  }
  {
    const { spawn } = require("child_process");
    const child = spawn(process.execPath, [CLI, "run", id, "--", `sleep 27; echo finished-${RUNTAG}`], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    // Waited for, not slept for: a fixed pause was the flake. Under load the
    // command had sometimes not started when the hangup came, and the reap
    // had sometimes not happened a second after it.
    const closed = new Promise((r) => child.on("close", (c) => r(c)));
    // The shell running it, matched by its -c: the delphi process's own
    // command line holds the same text, and matching that was the other flake.
    const alive = () => spawnSync("pgrep", ["-f", ` -c sleep 27; echo finished-${RUNTAG}`], { encoding: "utf8" }).stdout.trim();
    const until = async (test, ms) => { const end = Date.now() + ms; while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); return test(); };
    check("the command started", await until(() => alive() !== "", 20000), true);
    child.kill("SIGHUP");
    const code = await closed;
    const row = lastRun();
    check("the entry is finished, saying why", [row.meta.state, row.meta.code], ["fail", "SIGHUP"]);
    check("the CLI exited", typeof code, "number");
    // An unreaped zombie still matches pgrep for a moment, and is not a
    // running command; a live one would still be there after ten seconds.
    check("and the command did not outlive it", await until(() => alive() === "", 10000), true);
  }

  section("item 6: a log belongs to its entry only");
  const ran = delphi(["run", id, "--", "echo SECRET-OF-A-DELETED-RUN"]);
  const runId = lastRun().id;
  db.handle().prepare("DELETE FROM comments WHERE id = ?").run(runId);
  const reused = entryRow(delphi(["say", id, "an unrelated remark"]).out);
  check("the id was reused, as SQLite does", [ran.code, reused.id], [0, runId]);
  const out = delphi(["out", String(reused.id)]);
  check("out of a say shows no run's output", [out.code, out.out.includes("SECRET"), /not a run/.test(out.err)], [1, false, true]);

  section("item 9: commands are looked up as own properties");
  for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    const r = delphi([name]);
    check(`delphi ${name} is an unknown command, not a crash`, [r.code, /no command/.test(r.err)], [1, true]);
  }
  check("help constructor does not crash", delphi(["help", "constructor"]).code, 0);

  section("item 10: import and cat");
  const sheetText = [
    "---", `task: ${id}`, "title: x", "status: todo", "---",
    "$ make build  {id:5 by:ray running cwd:/tmp}",
    "> ray: hello from stdin", "",
  ].join("\n");
  const target = db.createTask({ projectId: project.id, title: "import target" });
  const imported = delphi(["import", String(target.id), "-"], { input: sheetText });
  check("import - reads stdin", imported.code, 0);
  const rows = db.handle().prepare("SELECT kind, body, meta FROM comments WHERE task_id = ? ORDER BY id").all(target.id);
  check("an imported running entry is lost, not running", rows.map((r) => [r.kind, r.kind === "run" ? JSON.parse(r.meta).state + ":" + JSON.parse(r.meta).code : r.body]),
    [["run", "fail:lost"], ["say", "hello from stdin"]]);
  const both = delphi(["cat", id, "--ledger", "--tail", "3"]);
  check("--ledger with --tail is refused clearly", [both.code, /cannot be used together/.test(both.err)], [1, true]);

  section("item 4: an agent tab's own shell is attributed to the agent");
  {
    const harness = require("../harness");
    const events = [];
    await harness.start({
      harness: { key: "fake", label: "Fake", command: "/usr/bin/env", args: [], parser: "text", mcp_style: "none" },
      sessionId: 77, cwd: dir, prompt: "x", dbPath: process.env.DELPHI_DB, projectId: project.id,
      actor: "fake:77",
    }, (e) => events.push(e));
    const env = events.filter((e) => e.type === "text").map((e) => e.text).join("");
    check("DELPHI_ACTOR is in the agent's environment", /^DELPHI_ACTOR=fake:77$/m.test(env), true);
    check("so is DELPHI_AUTHOR_TYPE=agent", /^DELPHI_AUTHOR_TYPE=agent$/m.test(env), true);
    check("and the database", env.includes(`DELPHI_DB=${process.env.DELPHI_DB}`), true);
    const said = delphi(["say", id, "from an agent's shell"], { env: { DELPHI_ACTOR: "fake:77", DELPHI_AUTHOR_TYPE: "agent" } });
    const row = entryRow(said.out);
    check("and delphi honours it", [row.author, row.author_type], ["fake:77", "agent"]);
  }
}

async function main() {
  const electronNode = makeRunner(process.execPath, { ELECTRON_RUN_AS_NODE: "1" });
  await review(electronNode);
  const first = suite("electron as node", electronNode);
  await finish(first, "electron as node");
  const ledger = electronNode(["cat", String(first.task.id), "--ledger"]).out;
  check("and the shell shows the summary in the ledger", ledger.includes("replayed the DLQ and raised the size limit"), true);
  check("the task is done", ledger.includes("status: done\n"), true);

  const node = plainNode();
  if (node) {
    const second = suite("plain node", makeRunner(node, { ELECTRON_RUN_AS_NODE: undefined }));
    await finish(second, "plain node");
  } else {
    console.log("\n(no plain node 18+ on PATH; that route was not exercised)");
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
