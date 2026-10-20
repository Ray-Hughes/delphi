#!/usr/bin/env node
// second_opinion and second opinion mode, through the real agent/mcp_server.js,
// on both of its routes.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/second_opinion_test.js
//
// The agent is a fake copilot put first on PATH. It prints what the real one
// prints in --output-format json and writes down the argv, environment and MCP
// file it was given, so what is checked is exactly what Copilot would be handed:
// read only, Delphi's server wired in under its own name, and nothing of the
// caller's own Delphi identity. The directive checks read the tool list and the
// results an agent sees, which is how the setting reaches it.

const fs = require("fs");
const os = require("os");
const path = require("path");

if (process.platform === "win32") {
  // The fake agent is a shell script. The runner itself has nothing
  // platform-specific beyond finding the binary, which launch.js covers.
  console.log("skipped on Windows: the fake copilot is a shell script");
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-second-opinion-"));
process.env.DELPHI_DATA_DIR = dir;
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const harness = require("../harness");
const directives = require("../agent/directives");
const secondOpinion = require("../agent/second_opinion");
const { openServer } = require("../sheet/client");

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

async function rejects(what, promise, pattern) {
  checks++;
  try {
    await promise;
  } catch (error) {
    if (pattern.test(String(error.message))) return;
    failures++;
    console.error(`  FAIL ${what}\n       threw ${JSON.stringify(error.message)}\n       want  ${pattern}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${what}\n       did not throw`);
}

function section(name) { console.log(`\n${name}`); }

function checkThrows(what, fn, pattern) {
  checks++;
  try { fn(); } catch (error) {
    if (pattern.test(String(error.message))) return;
    failures++;
    console.error(`  FAIL ${what}\n       threw ${JSON.stringify(error.message)}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${what}\n       did not throw`);
}

// --- the fake copilot ---------------------------------------------------------

const bin = path.join(dir, "bin");
fs.mkdirSync(bin);
const logFile = path.join(dir, "copilot-log.json");
fs.writeFileSync(path.join(dir, "fake_copilot.js"), `
const fs = require("fs");
const argv = process.argv.slice(2);
const at = argv.indexOf("--additional-mcp-config");
let mcp = null;
if (at !== -1) {
  const file = argv[at + 1].replace(/^@/, "");
  mcp = { file, exists: fs.existsSync(file), body: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null };
}
fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv, cwd: process.cwd(), client: process.env.DELPHI_CLIENT || null, mcp }));
const mode = process.env.FAKE_COPILOT || "ok";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
if (mode === "ok") {
  // An interim message between tool calls, as the real one sends, which is not
  // the answer.
  out({ type: "assistant.message_delta", data: { deltaContent: "Let me look at that." } });
  out({ type: "assistant.message", data: { content: "Let me look at that.", outputTokens: 4 } });
  out({ type: "assistant.message_delta", data: { deltaContent: "One finding: " } });
  out({ type: "tool.execution_start", data: { name: "delphi-search" } });
  out({ type: "assistant.message_delta", data: { deltaContent: "a.js:3 divides by zero." } });
  out({ type: "assistant.message", data: { content: "One finding: a.js:3 divides by zero.", outputTokens: 9 } });
  out({ type: "result", sessionId: "s-1" });
} else if (mode === "plain") {
  process.stdout.write("Nothing found.\\n");
} else if (mode === "signedout") {
  process.stderr.write("Error: No authentication information found. Run /login to sign in.\\n");
  process.exit(1);
} else if (mode === "crash") {
  process.stderr.write("something broke\\n");
  process.exit(3);
} else if (mode === "hang") {
  setTimeout(() => {}, 600000);
} else if (mode === "grandchild") {
  // Something it started that holds the output pipe open, as an MCP server or
  // the binary behind a shim can.
  const kid = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"],
    { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  fs.writeFileSync(${JSON.stringify(logFile)} + ".kid", String(kid.pid));
  setTimeout(() => {}, 600000);
}
`);
fs.writeFileSync(path.join(bin, "copilot"),
  `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(dir, "fake_copilot.js"))} "$@"\n`,
  { mode: 0o755 });
const readLog = () => JSON.parse(fs.readFileSync(logFile, "utf8"));
const PATH = `${bin}${path.delimiter}${process.env.PATH || ""}`;

// --- a project, a task and the files to review ----------------------------------

const folder = path.join(dir, "project-folder");
fs.mkdirSync(folder);
fs.writeFileSync(path.join(folder, "a.js"), "const n = 0;\nconst x = 1;\nconst y = x / n;\n");
const outside = path.join(dir, "elsewhere");
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, "review.diff"), "--- a/a.js\n+++ b/a.js\n");
const project = db.createProject({ key: "second", name: "Second", path: folder });
const task = db.createTask({ projectId: project.id, title: "review the divide" });
db.seedHarnesses(harness.BUILTINS);
const copilotRow = () => db.handle().prepare("SELECT * FROM harnesses WHERE key = 'copilot'").get();
const originalRow = copilotRow();

const settingsFile = path.join(dir, "settings.json");
const setSettings = (fields) => fs.writeFileSync(settingsFile, JSON.stringify(fields));

delete process.env.ELECTRON_RUN_AS_NODE;

// --- the directives themselves -------------------------------------------------

section("the directives");
{
  const full = directives.secondOpinionInstructions("GitHub Copilot");
  const all = [full, directives.secondOpinionToolNote("GitHub Copilot"), directives.secondOpinionReminder("GitHub Copilot")];
  check("no em or en dashes in any of them", all.some((t) => /[\u2013\u2014\u2212]/.test(t)), false);
  check("each names the tool", all.every((t) => t.includes("second_opinion")), true);
  check("each rules out secrets", all.every((t) => /secrets/.test(t)), true);
  check("the full one says verify", /Verify every finding/.test(full), true);
  check("the full one rules out calling it for show", /Never call it just to show that it was used/.test(full), true);
  check("the full one rules out trivial work", /Skip it for trivial work/.test(full), true);
  check("the defaults are off and copilot", [directives.DEFAULTS.secondOpinionMode, directives.DEFAULTS.secondOpinionAgent], [false, "copilot"]);
}

// Collected so the synchronous block below can hand its one promise to main.
const pending = [];
function await_(p) { pending.push(p); }

section("the runner without a server");
{
  const plain = secondOpinion.plan({ row: { ...originalRow }, prompt: "p", cwd: folder, dirs: [outside], mcpFlags: [] });
  check("read only flags are added", plain.argv.slice(-8), ["--deny-tool", "write", "--deny-tool", "shell", "--add-dir", folder, "--add-dir", outside]);
  check("no tool-granting flag", plain.argv.some((a) => /^--allow-all/.test(a)), false);
  check("Delphi's tools are allowed by name", plain.argv.join(" ").includes("--allow-tool delphi"), true);
  const withExtra = (extra) => secondOpinion.plan({
    row: { ...originalRow, args_json: JSON.stringify(JSON.parse(originalRow.args_json).concat(extra)) }, prompt: "p", cwd: folder, dirs: [], mcpFlags: [],
  }).error || "";
  for (const extra of [["--allow-all-tools"], ["--allow-tool", "shell"], ["--allow-tool=write"], ["--add-dir", "/"], ["--allow-url", "x"], ["--yolo"], ["stray"]]) {
    check(`a row passing ${extra.join(" ")} is refused`, /may not: it has to stay read only/.test(withExtra(extra)), true);
  }
  check("the built-in row passes as it is", secondOpinion.checkFlags(
    harness.expand(JSON.parse(originalRow.args_json), { prompt: "p", jobRead: true, mcpFlags: [] }), "p"), null);
  check("a folder inside the project is not added twice", secondOpinion.resolveFiles(["a.js"], folder).dirs, []);
  checkThrows("the filesystem root is too wide", () => secondOpinion.resolveFiles([], path.parse(folder).root), /too wide/);
  checkThrows("a home folder is too wide", () => secondOpinion.resolveFiles([os.homedir()], folder), /too wide/);
  check("the prompt names the files and carries the brief",
        /Files to read:\n- \/x\/a.js[\s\S]*Read only/.test(secondOpinion.buildPrompt("look", ["/x/a.js"])), true);
  await_(rejects("another agent is refused for now",
    secondOpinion.run({ row: { key: "codex", label: "Codex", parser: "codex-json", command: "codex" }, request: "r", cwd: folder }), /runs Copilot only for now/));
}


async function route(name, env) {
  const base = { DELPHI_AUTHOR_TYPE: "agent", PATH, ...env };
  const open = async (extra = {}) => {
    const client = openServer({ actor: "claude-code:7", env: { ...base, ...extra }, clientName: "test", warn: () => {} });
    await client.start();
    return client;
  };

  section(`${name}: mode off`);
  setSettings({});
  let client = await open();
  try {
    const init = await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    check("no instructions", init.instructions, undefined);
    const listed = (await client.request("tools/list", {})).tools;
    const tool = listed.find((t) => t.name === "second_opinion");
    check("second_opinion is listed", Boolean(tool), true);
    check("its schema needs a request", tool.inputSchema.required, ["request"]);
    check("no tool carries the mode note", listed.some((t) => /SECOND OPINION MODE/.test(t.description)), false);
    const called = await client.request("tools/call", { name: "list_projects", arguments: {} });
    check("no reminder on a result", called.content.length, 1);

    section(`${name}: asking`);
    const answer = await client.call("second_opinion", {
      request: "Is there a bug in this change?", files: ["a.js", path.join(outside, "review.diff")], project: "second", task_id: task.id,
    });
    check("the answer is the last whole message, not the interim one", answer.answer, "One finding: a.js:3 divides by zero.");
    check("it says who answered", [answer.agent, answer.label], ["copilot", "GitHub Copilot"]);
    check("the tools it used", answer.tools, ["delphi-search"]);
    const log = readLog();
    const argv = log.argv;
    const prompt = (argv.find((a) => a.startsWith("--prompt=")) || "").slice("--prompt=".length);
    check("ran in the project's folder", fs.realpathSync(log.cwd), fs.realpathSync(folder));
    check("the request is in the prompt", prompt.startsWith("Is there a bug in this change?"), true);
    check("the files are named absolutely", prompt.includes(path.join(folder, "a.js")) && prompt.includes(path.join(outside, "review.diff")), true);
    check("write and shell are denied", argv.join(" ").includes("--deny-tool write --deny-tool shell"), true);
    check("the folder and the outside file's folder are let in",
          [argv.join(" ").includes(`--add-dir ${fs.realpathSync(folder)}`), argv.join(" ").includes(`--add-dir ${fs.realpathSync(outside)}`)], [true, true]);
    check("never --allow-all-tools", argv.includes("--allow-all-tools"), false);
    check("Delphi's server is allowed", argv.join(" ").includes("--allow-tool delphi"), true);
    check("Delphi's server was wired in, all its tools", log.mcp && log.mcp.exists && log.mcp.body.mcpServers.delphi.tools, ["*"]);
    check("under its own name", log.mcp.body.mcpServers.delphi.env.DELPHI_ACTOR, "copilot:second-opinion");
    check("against this database", log.mcp.body.mcpServers.delphi.env.DELPHI_DB, process.env.DELPHI_DB);
    check("started read only", log.mcp.body.mcpServers.delphi.env.DELPHI_READ_ONLY, "1");
    check("the MCP file is gone afterwards", fs.existsSync(log.mcp.file), false);
    check("the caller's DELPHI_CLIENT is not passed on", log.client, null);
    const kept = db.handle().prepare("SELECT body, author FROM comments WHERE id = ?").get(answer.comment_id);
    check("the answer is kept on the task", kept && kept.body.startsWith("**Second opinion from GitHub Copilot** (asked: Is there a bug in this change?)"), true);
    check("written as the caller", kept && kept.author, "claude-code:7");

    section(`${name}: what goes wrong`);
    await rejects("a request is required", client.call("second_opinion", { request: "  ", project: "second" }), /needs a request/);
    await rejects("a missing file", client.call("second_opinion", { request: "r", files: ["nope.diff"], project: "second" }), /Cannot find .*nope\.diff/);
    await rejects("an unknown task", client.call("second_opinion", { request: "r", task_id: 999999 }), /No task 999999/);
  } finally {
    client.close();
  }

  // Each failure mode needs the fake to behave differently, and the fake reads
  // that from the environment the server was started with.
  for (const [mode, pattern, extra] of [
    ["signedout", /not signed in\. Run copilot once/, {}],
    ["crash", /exit code 3[\s\S]*something broke/, {}],
    ["hang", /did not answer within 1 seconds/, { timeout_seconds: 1 }],
    ["grandchild", /did not answer within 1 seconds/, { timeout_seconds: 1 }],
  ]) {
    client = await open({ FAKE_COPILOT: mode });
    try {
      const began = Date.now();
      await rejects(`${mode}`, client.call("second_opinion", { request: "r", project: "second", ...extra }), pattern);
      check(`${mode}: the MCP file is gone`, fs.existsSync(readLog().mcp.file), false);
      if (mode === "grandchild") {
        check("grandchild: the call ends in good time", Date.now() - began < 9000, true);
        const kid = Number(fs.readFileSync(logFile + ".kid", "utf8"));
        let alive = true;
        for (let i = 0; i < 20 && alive; i++) {
          try { process.kill(kid, 0); await new Promise((r) => setTimeout(r, 100)); } catch { alive = false; }
        }
        check("grandchild: what it started is stopped too", alive, false);
      }
    } finally { client.close(); }
  }
  client = await open({ FAKE_COPILOT: "plain" });
  try {
    check("plain text output is still an answer", (await client.call("second_opinion", { request: "r", cwd: folder })).answer, "Nothing found.");
  } finally { client.close(); }

  section(`${name}: the harness row`);
  const h = db.handle();
  h.prepare("UPDATE harnesses SET enabled = 0 WHERE key = 'copilot'").run();
  client = await open();
  try {
    await rejects("turned off in Settings", client.call("second_opinion", { request: "r", cwd: folder }), /turned off in Delphi's Settings/);
    h.prepare("UPDATE harnesses SET enabled = 1, args_json = ? WHERE key = 'copilot'")
      .run(JSON.stringify(JSON.parse(originalRow.args_json).concat(["--allow-all-tools"])));
    await rejects("a row that grants tools", client.call("second_opinion", { request: "r", cwd: folder }), /may not: it has to stay read only/);
    h.prepare("UPDATE harnesses SET args_json = ?, command = 'copilot-not-installed-here' WHERE key = 'copilot'").run(originalRow.args_json);
    await rejects("not installed", client.call("second_opinion", { request: "r", cwd: folder }), /not installed, or not on the PATH/);
  } finally {
    client.close();
    h.prepare("UPDATE harnesses SET enabled = 1, args_json = ?, command = ? WHERE key = 'copilot'").run(originalRow.args_json, originalRow.command);
  }
  // A database the app has not seeded since an upgrade has no row; the tool
  // still works, from the built-in definition.
  h.prepare("DELETE FROM harnesses WHERE key = 'copilot'").run();
  client = await open();
  try {
    check("no row: the built-in definition is used", (await client.call("second_opinion", { request: "r", cwd: folder })).label, "GitHub Copilot");
  } finally {
    client.close();
    db.seedHarnesses(harness.BUILTINS);
  }

  section(`${name}: the reviewer's own server`);
  client = await open({ DELPHI_READ_ONLY: "1" });
  try {
    const names = (await client.request("tools/list", {})).tools.map((t) => t.name);
    check("reading tools are offered", ["search", "get_task", "read_scratchpad"].every((n) => names.includes(n)), true);
    check("writing tools are not", ["add_task", "write_scratchpad", "handoff_send", "second_opinion", "add_comment"].some((n) => names.includes(n)), false);
    await rejects("a write is refused", client.call("add_task", { title: "planted" }), /started read only, for a second opinion/);
    await rejects("so is asking for another opinion", client.call("second_opinion", { request: "r" }), /started read only/);
    check("a read works", JSON.stringify(await client.call("get_task", { id: task.id })).includes("review the divide"), true);
  } finally {
    client.close();
  }

  section(`${name}: mode on`);
  setSettings({ secondOpinionMode: true });
  client = await open();
  try {
    const init = await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    check("the instructions carry the rule", /SECOND OPINION MODE IS ON[\s\S]*GitHub Copilot/.test(init.instructions || ""), true);
    const listed = (await client.request("tools/list", {})).tools;
    const noted = listed.filter((t) => /SECOND OPINION MODE IS ON/.test(t.description)).map((t) => t.name).sort();
    check("the note is on the tools it bears on", noted, ["add_comment", "list_projects", "queue_complete", "second_opinion", "sheet_append"]);
    const orient = await client.request("tools/call", { name: "list_projects", arguments: {} });
    check("the orienting call carries the reminder", /Second opinion mode is on/.test((orient.content[1] || {}).text || ""), true);
    const other = await client.request("tools/call", { name: "whoami", arguments: {} });
    check("other calls do not, within the hour", other.content.length, 1);
  } finally {
    client.close();
  }

  section(`${name}: both modes`);
  setSettings({ secondOpinionMode: true, scratchpadMode: true });
  client = await open();
  try {
    const init = await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    check("both directives, in one text", [/SCRATCHPAD MODE IS ON/.test(init.instructions), /SECOND OPINION MODE IS ON/.test(init.instructions)], [true, true]);
  } finally {
    client.close();
  }

  // Turned on after the session started: no instructions were read with it in,
  // so the first result after it has to carry it.
  section(`${name}: turned on while connected`);
  setSettings({});
  client = await open();
  try {
    await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    const before = await client.request("tools/call", { name: "whoami", arguments: {} });
    check("nothing before", before.content.length, 1);
    setSettings({ secondOpinionMode: true });
    // The settings reader is keyed on the file's mtime, which some filesystems
    // only keep to the second.
    await new Promise((r) => setTimeout(r, 1100));
    setSettings({ secondOpinionMode: true });
    const after = await client.request("tools/call", { name: "whoami", arguments: {} });
    check("the next result carries the reminder", /Second opinion mode is on/.test((after.content[1] || {}).text || ""), true);
    const again = await client.request("tools/call", { name: "whoami", arguments: {} });
    check("and the one after does not", again.content.length, 1);
  } finally {
    client.close();
  }
  setSettings({});
}

async function main() {
  await Promise.all(pending);
  await route("node:sqlite", {});
  await route("sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" });
  console.log(`\n${checks - failures}/${checks} checks passed`);
  db.close && db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
