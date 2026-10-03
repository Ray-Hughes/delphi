#!/usr/bin/env node
// delphi chat: an agent on a task's Sheet, with a fake agent.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/chat_test.js
//
// No model is called. tools/fixtures/chat/fake_agent.js replays recorded
// streams in the shapes Claude Code's stream-json and Copilot's JSON output
// have (harness.js reads the same shapes), so the test costs nothing and is
// the same every run.
//
// The milestone's bar is "indistinguishable from MCP-written entries, and
// resumes after quitting". So the entries a chat writes are compared with ones
// written straight through the MCP tools and by delphi run, and a second chat
// on the same task is checked to hand the harness its session back.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-chat-"));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const chat = require("../sheet/chat");
const tui = require("../sheet/tui/sheet");
const { openServer } = require("../sheet/client");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bin", "delphi");
const FIX = path.join(__dirname, "fixtures", "chat");

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A home with no guard installed, so the refusal is what this machine's
// own settings cannot change; and one with it.
const bareHome = path.join(dir, "home-bare");
const guardedHome = path.join(dir, "home-guarded");
fs.mkdirSync(path.join(bareHome, ".claude"), { recursive: true });
fs.mkdirSync(path.join(guardedHome, ".claude"), { recursive: true });
fs.writeFileSync(path.join(guardedHome, ".claude", "settings.json"), JSON.stringify({
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "python3 /x/agent/guard.py" }] }] },
}));

// The fake agent as a binary. A wrapper, because chat strips
// ELECTRON_RUN_AS_NODE from the agent's environment, as it should.
const agentBin = path.join(dir, "fake-agent");
fs.writeFileSync(agentBin, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(FIX, "fake_agent.js"))} "$@"\n`);
fs.chmodSync(agentBin, 0o755);
const agentLog = path.join(dir, "agent-log.jsonl");
const agentRuns = () => (fs.existsSync(agentLog) ? fs.readFileSync(agentLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const checkout = path.join(dir, "checkout");
fs.mkdirSync(checkout);
const realCheckout = fs.realpathSync(checkout);
const project = db.createProject({ key: "chat", name: "Chat", path: checkout });

function cliEnv(extra = {}) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", HOME: bareHome, DELPHI_CHAT_AGENT: agentBin, FAKE_AGENT_LOG: agentLog, ...extra };
  delete env.DELPHI_ACTOR;
  return env;
}
function delphi(args, extra = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", input: "", env: cliEnv(extra), timeout: 60000 });
}

async function main() {
  const person = openServer({ actor: "tester", env: { DELPHI_AUTHOR_TYPE: "human" }, warn: () => {} });
  await person.start();
  const read = async (taskId) => (await person.call("sheet_read", { task_id: taskId, mode: "full" })).entries;

  // --- mappers ---------------------------------------------------------------------
  section("the Claude Code mapper, from a recorded stream");
  {
    const actions = [];
    const map = chat.claudeSheetMapper((a) => actions.push(a));
    for (const line of fs.readFileSync(path.join(FIX, "claude_turn.jsonl"), "utf8").replace(/\{\{CWD\}\}/g, "/w").split("\n")) map(line);
    map.flush();
    const shape = actions.filter((a) => a.type !== "session").map((a) => [a.type, a.text || a.command || a.path || a.key, a.code]);
    check("actions in order", shape, [
      ["say", "Looking at the queue first. The status line reads  {id:1 ok}", undefined],
      ["run", "ls", undefined],
      ["ran", "toolu_01", 0],
      ["run", "npm test", undefined],
      ["ran", "toolu_02", 1],
      ["edited", "/w/app.js", undefined],
      ["run", "cat <<'EOF' > notes.txt\nfixed\nEOF", undefined],
      ["ran", "toolu_04", 0],
      ["say", "Fixed the off by one in app.js:\n\n```js\nfor (let i = 0; i < n; i++) {}\n```\n\nThe two failures were that loop.", undefined],
    ]);
    check("the exit code line is taken off the output", actions.find((a) => a.key === "toolu_02" && a.type === "ran").output, "FAIL one\nFAIL two");
    check("the session id", [...new Set(actions.filter((a) => a.type === "session").map((a) => a.id))], ["sess-1111"]);
    check("stream_event deltas are not entries", actions.some((a) => a.text === "Looking"), false);
    const more = [];
    const m2 = chat.claudeSheetMapper((a) => more.push(a));
    m2('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 529 overloaded"}');
    m2("not json at all");
    check("an error result", more, [{ type: "error", message: "API Error: 529 overloaded" }]);
  }

  section("the Copilot mapper, from a recorded stream");
  {
    const actions = [];
    const map = chat.copilotSheetMapper((a) => actions.push(a));
    for (const line of fs.readFileSync(path.join(FIX, "copilot_turn.jsonl"), "utf8").replace(/\{\{CWD\}\}/g, "/w").split("\n")) map(line);
    map.flush();
    check("actions in order", actions.map((a) => [a.type, a.text || a.command || a.path || a.key || a.id, a.code]), [
      ["say", "Checking the build.", undefined],
      ["run", "make build", undefined],
      ["ran", "call_1", 0],
      ["edited", "/w/README.md", undefined],
      ["run", "make check", undefined],
      ["ran", "call_3", 2],
      ["say", "Done: README updated, check fails.", undefined],
      ["session", "cop-2222", undefined],
    ]);
    check("the exit marker is taken off the output", actions.find((a) => a.key === "call_1" && a.type === "ran").output, "built ok");
    const deltasOnly = [];
    const m2 = chat.copilotSheetMapper((a) => deltasOnly.push(a));
    m2('{"type":"assistant.message_delta","data":{"messageId":"x","deltaContent":"only "}}');
    m2('{"type":"assistant.message_delta","data":{"messageId":"x","deltaContent":"deltas"}}');
    m2.flush();
    check("deltas with no message still become one entry", deltasOnly, [{ type: "say", text: "only deltas" }]);
  }

  // --- the harness row ------------------------------------------------------------------
  section("the harness row decides the argv");
  {
    const claude = chat.ADAPTERS.claude;
    const builtin = chat.harnessRow(claude, [], {});
    check("built in defaults without a row", [builtin.command, builtin.parser], ["claude", "claude-stream-json"]);
    const edited = chat.harnessRow(claude, [{ key: "claude-code", label: "Claude Code", enabled: 1, command: "/opt/claude", args: JSON.stringify(["-p", "{prompt}", "--new-flag"]) }], {});
    check("an edited row wins, args from JSON", [edited.command, edited.args], ["/opt/claude", ["-p", "{prompt}", "--new-flag"]]);
    check("a row with only key, label and enabled keeps the built in argv", chat.harnessRow(claude, [{ key: "claude-code", label: "CC", enabled: 1 }], {}).args.includes("stream-json"), true);
    let off = null;
    try { chat.harnessRow(claude, [{ key: "claude-code", label: "Claude Code", enabled: 0 }], {}); } catch (e) { off = e.message; }
    check("a harness turned off in Settings is refused", off, "Claude Code is turned off in Delphi's settings.");
    check("DELPHI_CHAT_AGENT names the binary", chat.harnessRow(claude, [], { DELPHI_CHAT_AGENT: "/x/fake" }).command, "/x/fake");
  }

  section("the guard");
  {
    const prev = process.env.HOME;
    process.env.HOME = bareHome;
    check("unguarded is refused", /guard\.py is not installed/.test(chat.guardRefusal(checkout, {})), true);
    check("unless --allow-unguarded", chat.guardRefusal(checkout, { allowUnguarded: true }), null);
    check("--auto without the guard is refused even then", /--allow-unguarded does not cover --auto/.test(chat.guardRefusal(checkout, { autoAllow: true, allowUnguarded: true })), true);
    check("Copilot without --auto needs nothing: it asks before each tool", chat.guardRefusal(checkout, { adapter: "copilot" }), null);
    check("Copilot with --auto is refused, saying the guard cannot see it", /guard cannot see Copilot's commands/.test(chat.guardRefusal(checkout, { adapter: "copilot", autoAllow: true })), true);
    check("unless --allow-unguarded", chat.guardRefusal(checkout, { adapter: "copilot", autoAllow: true, allowUnguarded: true }), null);
    process.env.HOME = guardedHome;
    check("installed: no refusal, --auto allowed", chat.guardRefusal(checkout, { autoAllow: true }), null);
    check("an installed guard changes nothing for Copilot with --auto", /guard cannot see Copilot's commands/.test(chat.guardRefusal(checkout, { adapter: "copilot", autoAllow: true })), true);
    process.env.HOME = prev;
    const t0 = db.createTask({ projectId: project.id, title: "guarded" });
    const r = delphi(["chat", String(t0.id), "hello"]);
    check("the CLI refuses without the guard", [r.status, /guard\.py is not installed/.test(r.stderr)], [1, true]);
  }

  // --- a whole turn, through the CLI ------------------------------------------------------
  section("delphi chat with Claude Code: a turn on the Sheet");
  const task = db.createTask({ projectId: project.id, title: "fix the off by one" });
  const r0 = delphi(["chat", String(task.id), "--auto", "--allow-unguarded", "go"]);
  check("--auto without the guard is refused by the CLI", [r0.status, /does not cover --auto/.test(r0.stderr)], [1, true]);
  await person.call("sheet_append", { task_id: task.id, kind: "note", body: "the loop in app.js runs once too often", promote: true });
  for (let i = 0; i < 3; i++) await person.call("sheet_append", { task_id: task.id, kind: "say", body: `earlier remark ${i}` });
  const before = (await read(task.id)).length;
  const r1 = delphi(["chat", String(task.id), "--allow-unguarded", "please fix the loop"], { FAKE_AGENT_FIXTURE: path.join(FIX, "claude_turn.jsonl") });
  check("exits 0", [r1.status, r1.stderr], [0, ""]);
  const entries = (await read(task.id)).slice(before);
  const actor = `claude-code:chat-${task.id}`;
  check("the entries, in order", entries.map((e) => [e.kind, e.author, e.body]), [
    ["say", os.userInfo().username, "please fix the loop"],
    ["say", actor, "Looking at the queue first. The status line reads  {id:1 ok}"],
    ["run", actor, "ls"],
    ["run", actor, "npm test"],
    ["note", actor, "edited app.js"],
    ["run", actor, "cat <<'EOF' > notes.txt ..."],
    ["say", actor, "Fixed the off by one in app.js:\n\n```js\nfor (let i = 0; i < n; i++) {}\n```\n\nThe two failures were that loop."],
  ]);
  check("the person's entry is the person's", [entries[0].author_type], ["human"]);
  check("every agent entry is typed agent", entries.slice(1).every((e) => e.author_type === "agent"), true);
  check("piped, it prints the ids it wrote", r1.stdout.trim().split("\n").map(Number), entries.slice(1).map((e) => e.id));
  const [ls, npmTest, , heredoc] = entries.slice(2);
  check("a passing command", [ls.meta.state, ls.meta.code, ls.meta.exit, ls.meta.lines, ls.meta.out], ["ok", 0, 0, 2, "app.js\nREADME.md"]);
  check("a failing one, with its code", [npmTest.meta.state, npmTest.meta.code, npmTest.meta.lines], ["fail", 1, 2]);
  check("its log is where delphi out looks", fs.readFileSync(path.join(dir, "sheets", String(task.id), `${npmTest.id}.log`), "utf8"), "FAIL one\nFAIL two");
  check("ran in the project's folder", fs.realpathSync(ls.meta.cwd), realCheckout);
  check("a multi line command keeps the whole of it", heredoc.meta.script, "cat <<'EOF' > notes.txt\nfixed\nEOF");
  check("copying it gives the whole command, its source", tui.yankText([heredoc]), "cat <<'EOF' > notes.txt\nfixed\nEOF");
  check("so does copying it with output", tui.yankText([heredoc], { withOutput: true, logs: { [heredoc.id]: "done\n" } }), "cat <<'EOF' > notes.txt\nfixed\nEOF\ndone");
  {
    const rows = tui.layout([heredoc], { width: 80, expanded: new Set([heredoc.id]) });
    check("unfolded in the terminal Sheet, every line shows", [rows[0].startsWith("  $ cat <<'EOF' > notes.txt ..."), rows[1].trim(), rows[2].trim()], [true, "fixed", "EOF"]);
  }
  {
    const out = delphi(["out", String(heredoc.id)]);
    check("delphi out shows the whole command, on stderr in a pipe", [out.status, out.stderr, out.stdout], [0, "$ cat <<'EOF' > notes.txt\nfixed\nEOF\n\n", ""]);
  }
  check("the session is on the first reply", [entries[1].meta.agent, entries[1].meta.session], ["claude-code", "sess-1111"]);

  section("indistinguishable from MCP written entries");
  {
    const direct = openServer({ actor, env: { DELPHI_AUTHOR_TYPE: "agent" }, warn: () => {} });
    await direct.start();
    const viaMcp = await direct.call("sheet_append", { task_id: task.id, kind: "say", body: "written with the tool" });
    direct.close();
    const said = entries[1];
    const keys = (e) => Object.keys(e).sort();
    check("same fields", keys(said), keys(viaMcp));
    check("same author and type", [said.author, said.author_type], [viaMcp.author, viaMcp.author_type]);
    const ran = delphi(["run", String(task.id), "--", "echo", "hi"]);
    check("delphi run worked", ran.status, 0);
    const byRun = (await read(task.id)).filter((e) => e.kind === "run").pop();
    const missing = Object.keys(byRun.meta).filter((k) => !(k in ls.meta));
    check("a chat command carries every key a delphi run one does", missing, []);
    const text = (await person.call("sheet_read", { task_id: task.id, mode: "full" })).text;
    check("and formats the same way", text.includes(`$ ls  {id:${ls.id} by:${actor} ok dur:`), true);
    const history = db.handle().prepare("SELECT summary FROM audit WHERE entity = 'task' AND entity_id = ? ORDER BY id").all(task.id).map((r) => r.summary);
    check("History attributes the agent's writes to it", history.some((s) => s === `ran ls (by ${actor})`), true);
  }

  section("what the agent was given");
  {
    const run = agentRuns().pop();
    const prompt = run.argv[run.argv.indexOf("-p") + 1];
    check("argv from the harness template", [run.argv.includes("stream-json"), run.argv.includes("--resume")], [true, false]);
    check("no tools without --auto", run.argv[run.argv.indexOf("--tools") + 1], "");
    check("Delphi's MCP server is configured", run.argv.includes("--mcp-config"), true);
    check("as the agent", [run.env.DELPHI_ACTOR, run.env.DELPHI_AUTHOR_TYPE], [actor, "agent"]);
    check("in the project's folder", fs.realpathSync(run.cwd), realCheckout);
    check("the ledger is in the context", prompt.includes("! the loop in app.js runs once too often"), true);
    check("and the tail", prompt.includes("> tester: earlier remark 2"), true);
    check("clean, no metadata", /\{id:/.test(prompt), false);
    check("the message comes last", prompt.trimEnd().endsWith("The person says:\n\nplease fix the loop"), true);
    check("and is not repeated in the Sheet part", prompt.split("please fix the loop").length, 2);
  }

  section("a second delphi chat resumes");
  {
    const r2 = delphi(["chat", String(task.id), "--allow-unguarded", "and the other one?"], {
      FAKE_AGENT_FIXTURE: path.join(FIX, "claude_turn.jsonl"), FAKE_AGENT_RESUME_FIXTURE: path.join(FIX, "claude_resume.jsonl"),
    });
    check("exits 0", r2.status, 0);
    const run = agentRuns().pop();
    check("with --resume and the stored session", run.argv.slice(run.argv.indexOf("--resume"), run.argv.indexOf("--resume") + 2), ["--resume", "sess-1111"]);
    check("the reply", (await read(task.id)).pop().body, "Picked up where we left off.");
    const r3 = delphi(["chat", String(task.id), "--allow-unguarded", "once more"], {
      FAKE_AGENT_FIXTURE: path.join(FIX, "claude_resume.jsonl"), FAKE_AGENT_RESUME_FIXTURE: path.join(FIX, "claude_resume.jsonl"), FAKE_AGENT_FAIL_RESUME: "1",
    });
    const last2 = agentRuns().slice(-2);
    check("a session the harness lost is retried fresh, once", [r3.status, last2[0].argv.includes("--resume"), last2[1].argv.includes("--resume")], [0, true, false]);
  }

  section("delphi chat with Copilot");
  {
    const t2 = db.createTask({ projectId: project.id, title: "copilot task" });
    const refused = delphi(["chat", String(t2.id), "--agent", "copilot", "--auto", "build it"]);
    check("--auto with Copilot is refused, in plain words", [refused.status, /guard cannot see Copilot's commands/.test(refused.stderr)], [1, true]);
    check("and nothing was written", (await read(t2.id)).length, 0);
    const guardedAuto = delphi(["chat", String(t2.id), "--agent", "copilot", "--auto", "build it"], { HOME: guardedHome });
    check("even with the guard installed", guardedAuto.status, 1);
    // No --allow-unguarded, no guard: Copilot asks before each tool.
    const r = delphi(["chat", String(t2.id), "--agent", "copilot", "build it"], {
      FAKE_AGENT_FIXTURE: path.join(FIX, "copilot_turn.jsonl"),
    });
    check("exits 0", [r.status, r.stderr], [0, ""]);
    const es = await read(t2.id);
    const who = `copilot:chat-${t2.id}`;
    check("entries", es.map((e) => [e.kind, e.author === who ? "agent" : "person", e.body]), [
      ["say", "person", "build it"],
      ["say", "agent", "Checking the build."],
      ["run", "agent", "make build"],
      ["note", "agent", "edited README.md"],
      ["run", "agent", "make check"],
      ["say", "agent", "Done: README updated, check fails."],
    ]);
    check("exit codes from the marker", [es[2].meta.state, es[2].meta.out, es[4].meta.state, es[4].meta.code], ["ok", "built ok", "fail", 2]);
    check("the session reached the first reply after the turn ended", es[1].meta, { agent: "copilot", session: "cop-2222" });
    const argv = agentRuns().pop().argv;
    check("copilot's own argv", [argv.includes("--output-format"), argv.includes("--additional-mcp-config"), argv.includes("--allow-all-tools")], [true, true, false]);
    const t2b = db.createTask({ projectId: project.id, title: "copilot auto" });
    const auto = delphi(["chat", String(t2b.id), "--agent", "copilot", "--auto", "--allow-unguarded", "go"], { FAKE_AGENT_FIXTURE: path.join(FIX, "copilot_resume.jsonl") });
    check("--auto --allow-unguarded runs, with Copilot's allow flag", [auto.status, agentRuns().pop().argv.includes("--allow-all-tools")], [0, true]);
    delphi(["chat", String(t2.id), "--agent", "copilot", "--allow-unguarded", "again"], {
      FAKE_AGENT_FIXTURE: path.join(FIX, "copilot_turn.jsonl"), FAKE_AGENT_RESUME_FIXTURE: path.join(FIX, "copilot_resume.jsonl"),
    });
    const again = agentRuns().pop().argv;
    check("resumes with --session-id", again.slice(again.indexOf("--session-id"), again.indexOf("--session-id") + 2), ["--session-id", "cop-2222"]);
    check("the resumed reply", (await read(t2.id)).pop().body, "Back again on the same session.");
  }

  section("Ctrl-C stops the agent and finishes what it left running");
  {
    const t3 = db.createTask({ projectId: project.id, title: "long job" });
    const child = spawn(process.execPath, [CLI, "chat", String(t3.id), "--allow-unguarded", "start the long job"], {
      env: cliEnv({ FAKE_AGENT_FIXTURE: path.join(FIX, "claude_hang.jsonl") }), stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise((r) => child.on("close", (code) => r(code)));
    let running = null;
    for (let i = 0; i < 200 && !running; i++) {
      await wait(50);
      running = (await read(t3.id)).find((e) => e.kind === "run");
    }
    check("the command is running", running && running.meta.state, "running");
    child.kill("SIGINT");
    const code = await Promise.race([closed, wait(15000).then(() => "timeout")]);
    check("the chat exits 130", code, 130);
    const after = (await read(t3.id)).find((e) => e.kind === "run");
    check("and the entry says it was interrupted", [after.meta.state, after.meta.code], ["fail", 130]);
  }

  section("/agent in the Sheet in a terminal");
  {
    const t4 = db.createTask({ projectId: project.id, title: "tui chat" });
    const resolved = await person.call("sheet_resolve", { task: String(t4.id) });
    const sent = [];
    let attached = null;
    const app = tui.createSheetApp({
      client: person, resolved,
      io: {
        hooks: {
          attachAgent: async (name, res, opts) => {
            attached = [name, res.task.id, opts.allowUnguarded];
            return {
              row: { label: "Claude Code" }, resume: null,
              send: async (message) => { sent.push(message); return { code: 0, written: [], interrupted: false, stderr: "" }; },
              stop: () => false, close: () => {},
            };
          },
        },
      },
    });
    await app.load();
    await app.feed("not yet\r");
    check("before /agent, a say goes nowhere else", sent, []);
    await app.feed("/agent claude --allow-unguarded\r");
    check("/agent attaches", attached, ["claude", t4.id, true]);
    check("and says so", app.render().lines.pop().includes("Claude Code is listening"), true);
    await app.feed("over to you\r");
    await wait(20);
    check("plain text goes to the agent", sent, ["over to you"]);
    check("and is still the person's entry", (await read(t4.id)).map((e) => [e.author, e.body]).pop(), ["tester", "over to you"]);
    await app.feed("! a note\r");
    check("a note does not", sent.length, 1);
    await app.feed("/agent off\r");
    await app.feed("after\r");
    await wait(20);
    check("/agent off detaches", sent, ["over to you"]);
  }

  person.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
