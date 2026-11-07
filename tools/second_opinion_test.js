#!/usr/bin/env node
// second_opinion and second opinion mode, through the real agent/mcp_server.js,
// on both of its routes.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/second_opinion_test.js
//
// The agent is a fake copilot put first on PATH, trusted the way a person
// trusts a command in Settings, because the binary check is the dispatcher's
// and a script in a temp folder is not Copilot as an installer put it. It
// prints what the real one prints in --output-format json and writes down the
// argv, environment and MCP file it was given, so what is checked is exactly
// what Copilot would be handed: read only, its tools an allowlist, Delphi's
// server wired in under its own name, and nothing of the caller's own Delphi
// identity. The real copilot is never run. The directive checks read the tool
// list and the results an agent sees, which is how the setting reaches it.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

if (process.platform === "win32") {
  // The fake agent is a shell script. The runner itself has nothing
  // platform-specific beyond finding the binary, which launch.js covers.
  console.log("skipped on Windows: the fake copilot is a shell script");
  process.exit(0);
}

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-second-opinion-")));
// The data folder apart from the project's, because a second opinion never
// reads inside the data folder and a project under it would be refused.
const dataDir = path.join(dir, "data");
fs.mkdirSync(dataDir);
process.env.DELPHI_DATA_DIR = dataDir;
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dataDir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const harness = require("../harness");
const directives = require("../agent/directives");
const secondOpinion = require("../agent/second_opinion");
const binaries = require("../agent/binaries");
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid, ms = 3000) {
  for (let t = 0; t < ms && alive(pid); t += 100) await sleep(100);
  return !alive(pid);
}

// --- the fake copilot ---------------------------------------------------------

const bin = path.join(dir, "bin");
fs.mkdirSync(bin);
const logFile = path.join(dir, "copilot-log.json");
const ENV_SEEN = ["DELPHI_CLIENT", "DELPHI_SESSION", "DELPHI_ACTOR", "DELPHI_AUTHOR_TYPE", "COPILOT_ALLOW_ALL", "COPILOT_MODEL",
                  "COPILOT_HOME", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "SLACK_BOT_TOKEN", "DELPHI_DB"];
fs.writeFileSync(path.join(dir, "fake_copilot.js"), `
const fs = require("fs");
const argv = process.argv.slice(2);
const at = argv.indexOf("--additional-mcp-config");
let mcp = null;
if (at !== -1) {
  const file = argv[at + 1].replace(/^@/, "");
  mcp = { file, exists: fs.existsSync(file), body: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null };
}
const env = {};
for (const k of ${JSON.stringify(ENV_SEEN)}) if (process.env[k] !== undefined) env[k] = process.env[k];
fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv, cwd: process.cwd(), env, mcp, pid: process.pid }));
const mode = process.env.FAKE_COPILOT || "ok";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
if (mode === "ok") {
  // An interim message between tool calls, as the real one sends, which is not
  // the answer.
  out({ type: "assistant.message_delta", data: { deltaContent: "Let me look at that." } });
  out({ type: "assistant.message", data: { content: "Let me look at that.", outputTokens: 4 } });
  out({ type: "assistant.message_delta", data: { deltaContent: "One finding: " } });
  out({ type: "tool.execution_start", data: { name: "delphi_readonly-search" } });
  out({ type: "assistant.message_delta", data: { deltaContent: "a.js:3 divides by zero." } });
  out({ type: "assistant.message", data: { content: "One finding: a.js:3 divides by zero.", outputTokens: 9 } });
  out({ type: "result", sessionId: "s-1" });
} else if (mode === "plain") {
  process.stdout.write("Nothing found.\\n");
} else if (mode === "big") {
  out({ type: "assistant.message", data: { content: "B".repeat(200 * 1024) } });
} else if (mode === "longline") {
  // An interim message, then a final one too long to hold as a line.
  out({ type: "assistant.message", data: { content: "Let me look at that." } });
  out({ type: "assistant.message_delta", data: { deltaContent: "The real answer. " } });
  out({ type: "assistant.message", data: { content: "L".repeat(2 * 1024 * 1024) } });
} else if (mode === "noline") {
  // Plain text, three megabytes of it and never a newline.
  const chunk = "N".repeat(64 * 1024);
  for (let i = 0; i < 48; i++) process.stdout.write(chunk);
} else if (mode === "secret") {
  out({ type: "assistant.message", data: { content: "Found the key: ghp_" + "a".repeat(36) + " and\\n-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaA\\n-----END OPENSSH PRIVATE KEY-----\\nand AKIA" + "ABCDEFGHIJKLMNOP" + " end." } });
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
const fakeScript = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(dir, "fake_copilot.js"))} "$@"\n`;
const fakeCopilot = path.join(bin, "copilot");
fs.writeFileSync(fakeCopilot, fakeScript, { mode: 0o755 });
const readLog = () => JSON.parse(fs.readFileSync(logFile, "utf8"));
const PATH = `${bin}${path.delimiter}${process.env.PATH || ""}`;

// A global npm root of its own with a copilot in it, the way an installer puts
// one, for the row the app never seeded: that has no trust to lean on.
const npmGlobal = path.join(dir, "npm-global");
const npmBin = path.join(dir, "npm-bin");
fs.mkdirSync(npmGlobal);
fs.mkdirSync(npmBin);
fs.writeFileSync(path.join(npmGlobal, "copilot"), fakeScript, { mode: 0o755 });
fs.writeFileSync(path.join(npmBin, "npm"), `#!/bin/sh\necho ${JSON.stringify(npmGlobal)}\n`, { mode: 0o755 });
const INSTALLED_PATH = `${npmGlobal}${path.delimiter}${npmBin}${path.delimiter}${process.env.PATH || ""}`;

// Copilot's own config, as a person has it: their own read-write delphi, the
// GitHub server, and a name no flag could carry.
const copilotHome = path.join(dir, "copilot-home");
fs.mkdirSync(copilotHome);
fs.writeFileSync(path.join(copilotHome, "mcp-config.json"), JSON.stringify({ mcpServers: { "github-mcp-server": {}, delphi: {}, "bad name": {} } }));

// --- a project, a task and the files to review ----------------------------------

const work = path.join(dir, "work");
const folder = path.join(work, "project-folder");
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(folder, "a.js"), "const n = 0;\nconst x = 1;\nconst y = x / n;\n");
fs.writeFileSync(path.join(folder, "review.diff"), "--- a/a.js\n+++ b/a.js\n");
fs.writeFileSync(path.join(folder, ".env"), "SECRET=1\n");
fs.writeFileSync(path.join(folder, "server.pem"), "pem\n");
fs.mkdirSync(path.join(folder, ".ssh"));
fs.writeFileSync(path.join(folder, ".ssh", "id_rsa"), "key\n");
// A second repository of the same project, elsewhere on disk.
const repo2 = path.join(work, "other-repo");
fs.mkdirSync(repo2);
fs.writeFileSync(path.join(repo2, "b.js"), "module.exports = 2;\n");
const outside = path.join(dir, "elsewhere");
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, "review.diff"), "--- a/a.js\n+++ b/a.js\n");
fs.symlinkSync(outside, path.join(folder, "link-out"));
const project = db.createProject({ key: "second", name: "Second", path: folder });
// The project's folder is its primary repository, so it is where a run starts.
db.createRepo({ projectId: project.id, name: "main", path: folder, isPrimary: 1 });
db.createRepo({ projectId: project.id, name: "other", path: repo2 });
const otherProject = db.createProject({ key: "other", name: "Other", path: outside });
const task = db.createTask({ projectId: project.id, title: "review the divide" });
db.seedHarnesses(harness.BUILTINS);
const copilotRow = () => db.handle().prepare("SELECT * FROM harnesses WHERE key = 'copilot'").get();
// Trusted the way the window does it, as the real file.
const trust = () => db.handle().prepare("UPDATE harnesses SET trusted_command = ? WHERE key = 'copilot'").run(fs.realpathSync(fakeCopilot));
trust();
const originalRow = copilotRow();

const settingsFile = path.join(dataDir, "settings.json");
const setSettings = (fields) => fs.writeFileSync(settingsFile, JSON.stringify(fields));
const clearHour = () => db.handle().prepare("DELETE FROM second_opinions").run();

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

// Collected so the synchronous block below can hand its promises to main.
const pending = [];
function await_(p) { pending.push(p); }

section("the command line");
{
  const mcpFlags = ["--additional-mcp-config", "@/tmp/x.json"];
  const disable = ["delphi", "github-mcp-server"];
  const built = secondOpinion.plan({ row: { ...originalRow }, prompt: "p", cwd: folder, dirs: [repo2], mcpFlags, disable });
  const argv = built.argv || [];
  const joined = argv.join(" ");
  check("it builds", built.error, undefined);
  check("no tool-granting flag", argv.some((a) => /^--allow-all|^--yolo|^--allow-url/.test(a)), false);
  check("the row's own --allow-tool delphi is left out: that is the person's server here", joined.includes("--allow-tool delphi "), false);
  check("the injected server is allowed by its own name", joined.includes(`--allow-tool ${secondOpinion.SERVER_NAME}`), true);
  check("it is not called delphi", secondOpinion.SERVER_NAME, "delphi_readonly");
  const at = argv.indexOf("--available-tools");
  check("the tools are an allowlist: Copilot's read tools and the read-only server's",
        argv.slice(at + 1, at + 1 + secondOpinion.AVAILABLE_TOOLS.length), ["view", "glob", ...secondOpinion.READ_ONLY_TOOLS.map((t) => `delphi_readonly-${t}`)]);
  check("no writing tool on it", secondOpinion.AVAILABLE_TOOLS.some((t) => /write|add_|handoff_send|second_opinion|shell|bash|edit|create|web_fetch|^grep$|^rg$/.test(t)), false);
  check("built-in MCP servers are off", argv.includes("--disable-builtin-mcps"), true);
  check("the person's own servers are off", ["delphi", "github-mcp-server"].every((n) => joined.includes(`--disable-mcp-server ${n}`)), true);
  check("write, shell and url are denied", ["write", "shell", "url"].every((t) => joined.includes(`--deny-tool ${t}`)), true);
  check("key files are denied by name", ["read(.env)", "read(*.pem)", "read(id_*)"].every((t) => joined.includes(`--deny-tool ${t}`)), true);
  check("the temp folder is not let in", argv.includes("--disallow-temp-dir"), true);
  check("the folders come last", argv.slice(-4), ["--add-dir", folder, "--add-dir", repo2]);

  const ctx = { cwd: folder, dirs: [repo2], mcpFlags, disable };
  const added = secondOpinion.addedFlags(ctx);
  check("what Delphi adds passes its own check", secondOpinion.checkAdded(added, ctx), null);
  for (const [what, tampered] of [
    ["an extra --add-dir /", [...added, "--add-dir", "/"]],
    ["--allow-tool shell", [...added, "--allow-tool", "shell"]],
    ["--allow-all-urls", [...added, "--allow-all-urls"]],
    ["one more available tool", added.flatMap((a) => (a === "view" ? ["view", "bash"] : [a]))],
    ["disabling a server it did not find", [...added, "--disable-mcp-server", "other"]],
    ["no url denial", added.filter((a, i) => !(a === "url" && added[i - 1] === "--deny-tool") && !(a === "--deny-tool" && added[i + 1] === "url"))],
    ["no --disable-builtin-mcps", added.filter((a) => a !== "--disable-builtin-mcps")],
    ["no --disallow-temp-dir", added.filter((a) => a !== "--disallow-temp-dir")],
    ["no --secret-env-vars", added.filter((a) => !a.startsWith("--secret-env-vars"))],
    ["no --add-dir for cwd", added.slice(0, -4).concat(["--add-dir", repo2])],
  ]) {
    check(`the check refuses ${what}`, secondOpinion.checkAdded(tampered, ctx) !== null, true);
  }
  check("a person's own server called delphi_readonly is refused, not merged",
        /already has an MCP server called delphi_readonly/.test(secondOpinion.plan({ row: { ...originalRow }, prompt: "p", cwd: folder, dirs: [], mcpFlags, disable: ["delphi_readonly"] }).error || ""), true);

  const withExtra = (extra) => secondOpinion.plan({
    row: { ...originalRow, args_json: JSON.stringify(JSON.parse(originalRow.args_json).concat(extra)) }, prompt: "p", cwd: folder, dirs: [], mcpFlags: [],
  }).error || "";
  for (const extra of [["--allow-all-tools"], ["--allow-tool", "shell"], ["--allow-tool=write"], ["--add-dir", "/"], ["--allow-url", "x"], ["--yolo"],
                       ["--available-tools", "bash"], ["--enable-mcp-server", "x"], ["stray"]]) {
    check(`a row passing ${extra.join(" ")} is refused`, /may not: it has to stay read only/.test(withExtra(extra)), true);
  }
  check("the built-in row passes as it is", secondOpinion.checkFlags(
    harness.expand(JSON.parse(originalRow.args_json), { prompt: "p", jobRead: false, mcpFlags: [] }), "p"), null);
  check("the timeout is at most ten minutes", secondOpinion.MAX_TIMEOUT_MS, 10 * 60 * 1000);
}

section("the environment");
{
  const env = secondOpinion.childEnvFrom({
    PATH: "/bin", HOME: "/h", DELPHI_CLIENT: "delphi-cli", DELPHI_SESSION: "4", DELPHI_ACTOR: "claude-code:1", DELPHI_AUTHOR_TYPE: "human", DELPHI_JOB: "2",
    DELPHI_DB: "/d/delphi.db", COPILOT_ALLOW_ALL: "true", COPILOT_MODEL: "x", COPILOT_HOME: "/c", COPILOT_GH_HOST: "va.ghe.com",
    COPILOT_GITHUB_TOKEN: "a", GH_TOKEN: "b", GITHUB_TOKEN: "c", NPM_TOKEN: "d", SLACK_BOT_TOKEN: "e", tokenish_thing: "f", GH_HOST: "va.ghe.com",
  });
  check("only what Copilot signs in with, and the rest of the caller's environment",
        Object.keys(env).sort(), ["COPILOT_GH_HOST", "COPILOT_GITHUB_TOKEN", "COPILOT_HOME", "DELPHI_DB", "GH_HOST", "GH_TOKEN", "GITHUB_TOKEN", "HOME", "PATH"]);
}

section("where it may read");
{
  const opts = { roots: [folder, repo2], home: path.join(dir, "home"), dataDir };
  fs.mkdirSync(path.join(dir, "home", ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(dir, "home", ".ssh", "id_rsa"), "key\n");
  check("a file in the project is read where it is", secondOpinion.resolveFiles(["a.js"], folder, opts).dirs, []);
  check("a file in another of the project's repositories lets that folder in", secondOpinion.resolveFiles([path.join(repo2, "b.js")], folder, opts).dirs, [repo2]);
  checkThrows("a cwd outside the project", () => secondOpinion.resolveFiles([], outside, opts), /outside the project's folders/);
  checkThrows("a file outside the project", () => secondOpinion.resolveFiles([path.join(outside, "review.diff")], folder, opts), /outside the project's folders/);
  checkThrows("a link out of the project is judged where it lands", () => secondOpinion.resolveFiles(["link-out/review.diff"], folder, opts), new RegExp(`${outside}.*outside the project`));
  checkThrows("~/.ssh/id_rsa", () => secondOpinion.resolveFiles(["~/.ssh/id_rsa"], folder, opts), /outside the project's folders/);
  checkThrows("~/.ssh/id_rsa even when home is a project folder",
              () => secondOpinion.resolveFiles(["~/.ssh/id_rsa"], folder, { ...opts, roots: [folder, path.join(dir, "home")] }), /\.ssh folder, where keys are kept/);
  checkThrows(".env inside the project", () => secondOpinion.resolveFiles([".env"], folder, opts), /\.env is the kind of file that holds keys/);
  checkThrows("a .pem inside the project", () => secondOpinion.resolveFiles(["server.pem"], folder, opts), /server\.pem is the kind of file/);
  checkThrows("a .ssh folder inside the project", () => secondOpinion.resolveFiles([".ssh/id_rsa"], folder, opts), /\.ssh folder/);
  checkThrows("the root is too wide, whatever the project says", () => secondOpinion.resolveFiles([], path.parse(folder).root, { ...opts, roots: ["/"] }), /too wide/);
  checkThrows("the folder above home is too wide", () => secondOpinion.resolveFiles([], dir, { ...opts, home: path.join(dir, "home"), roots: [dir], dataDir: null }), /too wide/);
  checkThrows("so is home itself", () => secondOpinion.resolveFiles([], os.homedir(), { roots: [os.homedir()] }), /too wide/);
  checkThrows("a folder holding the data folder", () => secondOpinion.resolveFiles([], dir, { roots: [dir], home: os.homedir(), dataDir }), /inside it, which a second opinion never reads/);
  checkThrows("the data folder itself", () => secondOpinion.resolveFiles([], dataDir, { roots: [dir], home: os.homedir(), dataDir }), /never reads/);
  checkThrows("the database, when DELPHI_DB puts it in a project", () => secondOpinion.resolveFiles([], folder, { ...opts, dbPath: path.join(folder, "a.js") }), /inside it, which a second opinion never reads/);
  fs.mkdirSync(path.join(folder, ".config", "gh"), { recursive: true });
  fs.writeFileSync(path.join(folder, ".config", "gh", "hosts.yml"), "x");
  checkThrows(".config/gh", () => secondOpinion.resolveFiles([".config/gh/hosts.yml"], folder, opts), /inside \.config\/gh/);
  check("but not .config/ghost", (() => { fs.mkdirSync(path.join(folder, ".config", "ghost"), { recursive: true }); fs.writeFileSync(path.join(folder, ".config", "ghost", "a.txt"), "x"); return secondOpinion.resolveFiles([".config/ghost/a.txt"], folder, opts).files.length; })(), 1);
  checkThrows("no roots at all", () => secondOpinion.resolveFiles([], folder, { ...opts, roots: [] }), /outside the project's folders/);
  check("the prompt names the files and carries the brief",
        /Files to read:\n- \/x\/a.js[\s\S]*Read only/.test(secondOpinion.buildPrompt("look", ["/x/a.js"])), true);
  await_(rejects("another agent is refused for now",
    secondOpinion.run({ row: { key: "codex", label: "Codex", parser: "codex-json", command: "codex" }, request: "r", cwd: folder, roots: [folder] }), /runs Copilot only for now/));
}

section("the binary");
{
  const row = (extra) => ({ ...originalRow, ...extra });
  const opts = { resolveBinary: () => fakeCopilot, which: () => null, roots: [] };
  check("a copilot that is not where an installer puts it is refused",
        /not copilot as an installer put it[\s\S]*Trust this command/.test(secondOpinion.findCommand(row({ trusted_command: null }), opts).error || ""), true);
  check("trusted as the real file, it runs", secondOpinion.findCommand(row({}), opts).path, fakeCopilot);
  check("trusted as some other file, it does not", Boolean(secondOpinion.findCommand(row({ trusted_command: "/opt/elsewhere/copilot" }), opts).error), true);
  check("under an install root, named copilot, it runs untrusted",
        secondOpinion.findCommand(row({ trusted_command: null }), { ...opts, roots: [{ dir: bin }] }).path, fakeCopilot);
  const open = path.join(dir, "open");
  fs.mkdirSync(open);
  fs.chmodSync(open, 0o777);
  const loose = path.join(open, "copilot");
  fs.writeFileSync(loose, fakeScript, { mode: 0o755 });
  check("in a folder anyone can write, it is refused even trusted",
        /could be changed by someone else/.test(secondOpinion.findCommand(row({ trusted_command: fs.realpathSync(loose) }), { ...opts, resolveBinary: () => loose }).error || ""), true);
  check("the dispatcher asks the same module", require("../agent/dispatch").jobCommand, binaries.jobCommand);
}

section("what comes back");
{
  const big = secondOpinion.capAnswer("x".repeat(100 * 1024));
  check("a long answer is cut to about 64 KB", big.text.length < 64 * 1024 + 200, true);
  check("and says so", [big.trimmed, /\[trimmed: the answer was longer than 64 KB/.test(big.text)], [true, true]);
  check("a short one is left alone", secondOpinion.capAnswer("fine"), { text: "fine", trimmed: false });
  const r = secondOpinion.redact(`a ghp_${"x".repeat(36)} b github_pat_${"y".repeat(30)} c AKIAABCDEFGHIJKLMNOP d xoxb-1234567890-abc e\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nf`);
  check("token shapes are redacted", r.text, "a [redacted] b [redacted] c [redacted] d [redacted] e\n[redacted]\nf");
  check("and counted", r.count, 5);
  check("a key cut off before its END line is still taken", secondOpinion.redact("-----BEGIN PRIVATE KEY-----\nMIIE...").text, "[redacted]");
  check("ordinary text is not", secondOpinion.redact("ghp is a prefix; AKIA too").count, 0);
  check("a PGP key block is", secondOpinion.redact("-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQ\n-----END PGP PRIVATE KEY BLOCK-----").text, "[redacted]");
  check("the hourly limit defaults when the setting is blank, and is kept in range",
        [null, "", undefined, 0, 500, -3, 7].map((v) => secondOpinion.hourlyLimit({ secondOpinionHourlyLimit: v })), [12, 12, 12, 0, 60, 0, 7]);
  check("and the default is harness.js's", secondOpinion.hourlyLimit({}), harness.SECOND_OPINION_HOURLY.default);
}

async function route(name, env) {
  const base = { DELPHI_AUTHOR_TYPE: "agent", PATH, COPILOT_HOME: copilotHome, ...env };
  const open = async (extra = {}) => {
    const client = openServer({ actor: "claude-code:7", env: { ...base, ...extra }, clientName: "test", warn: () => {} });
    await client.start();
    return client;
  };
  setSettings({ secondOpinionHourlyLimit: 60 });
  clearHour();

  section(`${name}: mode off`);
  let client = await open({
    // What the caller's own environment may carry, none of which is the reviewer's.
    DELPHI_SESSION: "5", COPILOT_ALLOW_ALL: "true", COPILOT_MODEL: "x", NPM_TOKEN: "npm", SLACK_BOT_TOKEN: "slack", GH_TOKEN: "gh",
  });
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
      request: "Is there a bug in this change?", files: ["a.js", path.join(repo2, "b.js")], project: "second", task_id: task.id,
    });
    check("the answer is the last whole message, not the interim one", answer.answer, "One finding: a.js:3 divides by zero.");
    check("it says who answered", [answer.agent, answer.label], ["copilot", "GitHub Copilot"]);
    check("the tools it used", answer.tools, ["delphi_readonly-search"]);
    const log = readLog();
    const argv = log.argv;
    const joined = argv.join(" ");
    const prompt = (argv.find((a) => a.startsWith("--prompt=")) || "").slice("--prompt=".length);
    check("ran in the project's folder", fs.realpathSync(log.cwd), fs.realpathSync(folder));
    check("the request is in the prompt", prompt.startsWith("Is there a bug in this change?"), true);
    check("the files are named absolutely", prompt.includes(path.join(folder, "a.js")) && prompt.includes(path.join(repo2, "b.js")), true);
    check("write, shell and url are denied", ["write", "shell", "url"].every((t) => joined.includes(`--deny-tool ${t}`)), true);
    check("the folder and the other repository are let in",
          [joined.includes(`--add-dir ${folder}`), joined.includes(`--add-dir ${repo2}`)], [true, true]);
    check("never --allow-all-tools", argv.includes("--allow-all-tools"), false);
    check("the tools are the allowlist", joined.includes(`--available-tools ${secondOpinion.AVAILABLE_TOOLS.join(" ")} --`), true);
    check("the person's own servers are switched off, the odd name left to the allowlist",
          [joined.includes("--disable-mcp-server delphi "), joined.includes("--disable-mcp-server github-mcp-server"), joined.includes("bad name")], [true, true, false]);
    check("built-in servers are off", argv.includes("--disable-builtin-mcps"), true);
    check("Delphi's server was wired in under its own name, all its tools",
          log.mcp && log.mcp.exists && [Object.keys(log.mcp.body.mcpServers), log.mcp.body.mcpServers.delphi_readonly.tools], [["delphi_readonly"], ["*"]]);
    const served = log.mcp.body.mcpServers.delphi_readonly.env;
    check("under its own name in History", served.DELPHI_ACTOR, "copilot:second-opinion");
    check("typed as an agent", served.DELPHI_AUTHOR_TYPE, "agent");
    check("against this database", served.DELPHI_DB, process.env.DELPHI_DB);
    check("started read only", served.DELPHI_READ_ONLY, "1");
    check("the MCP file is gone afterwards", fs.existsSync(log.mcp.file), false);
    // Whatever sign-in tokens the machine running the test has are kept too.
    const signIn = ["COPILOT_GITHUB_TOKEN", "GITHUB_TOKEN"].filter((k) => process.env[k] !== undefined);
    check("none of the caller's identity, Copilot's switches or other tokens reach it",
          Object.keys(log.env).sort(), ["COPILOT_HOME", "DELPHI_DB", "GH_TOKEN", ...signIn].sort());
    const kept = db.handle().prepare("SELECT body, author FROM comments WHERE id = ?").get(answer.comment_id);
    check("the answer is kept on the task", kept && kept.body.startsWith("**Second opinion from GitHub Copilot** (asked: Is there a bug in this change?)"), true);
    check("written as the caller", kept && kept.author, "claude-code:7");
    check("nothing to redact, nothing said about it", [answer.redacted, /redacted/.test(kept.body)], [0, false]);
    check("the run is counted", db.handle().prepare("SELECT COUNT(*) AS n, MAX(outcome) AS o FROM second_opinions").get(), { n: 1, o: "answered" });

    section(`${name}: what goes wrong`);
    await rejects("a request is required", client.call("second_opinion", { request: "  ", project: "second" }), /needs a request/);
    await rejects("a missing file", client.call("second_opinion", { request: "r", files: ["nope.diff"], project: "second" }), /Cannot find .*nope\.diff/);
    await rejects("an unknown task", client.call("second_opinion", { request: "r", task_id: 999999 }), /No task 999999/);
    await rejects("a task and a project that disagree", client.call("second_opinion", { request: "r", task_id: task.id, project: "other" }), /not in the project you named/);
    await rejects("a cwd above the project", client.call("second_opinion", { request: "r", project: "second", cwd: path.dirname(os.homedir()) }), /outside the project's folders/);
    await rejects("a file outside the project", client.call("second_opinion", { request: "r", project: "second", files: [path.join(outside, "review.diff")] }), /outside the project's folders/);
    await rejects("a key file inside it", client.call("second_opinion", { request: "r", project: "second", files: [".env"] }), /holds keys or passwords/);
    await rejects("no project anywhere", client.call("second_opinion", { request: "r", cwd: dir }), /reads only inside a project's folders/);
    check("none of the refusals were counted", db.handle().prepare("SELECT COUNT(*) AS n FROM second_opinions").get().n, 1);
  } finally {
    client.close();
  }

  // Each failure mode needs the fake to behave differently, and the fake reads
  // that from the environment the server was started with.
  for (const [mode, pattern, extra] of [
    ["signedout", /not signed in\. Run copilot once/, {}],
    ["crash", /exit code 3[\s\S]*something broke/, {}],
    ["hang", /did not answer within 1 seconds/, { timeout_seconds: 1 }],
  ]) {
    client = await open({ FAKE_COPILOT: mode });
    try {
      await rejects(`${mode}`, client.call("second_opinion", { request: "r", project: "second", ...extra }), pattern);
      check(`${mode}: the MCP file is gone`, fs.existsSync(readLog().mcp.file), false);
    } finally { client.close(); }
  }
  // The grandchild case proves something only if the time limit lands after
  // the fake has started what holds the pipe, and the limit's clock starts at
  // spawn. On a loaded machine the fake's own start can take longer than one
  // second, so it was stopped before it had a grandchild and the case failed,
  // or read the pid file the other route left. So the pid file is cleared
  // first and the case is tried again with twice the limit until the fake got
  // that far, up to a bound no machine that can run the suite needs.
  {
    const kidFile = logFile + ".kid";
    let kid = null;
    for (let limit = 1; !kid && limit <= 32; limit *= 2) {
      fs.rmSync(kidFile, { force: true });
      client = await open({ FAKE_COPILOT: "grandchild" });
      try {
        const began = Date.now();
        await rejects(`grandchild (a ${limit}s limit)`, client.call("second_opinion", { request: "r", project: "second", timeout_seconds: limit }),
          new RegExp(`did not answer within ${limit} seconds`));
        // A pid file caught half written reads as 0, which is no pid at all.
        const read = fs.existsSync(kidFile) ? Number(fs.readFileSync(kidFile, "utf8")) : 0;
        if (!Number.isInteger(read) || read <= 0) continue;
        kid = read;
        check("grandchild: the MCP file is gone", fs.existsSync(readLog().mcp.file), false);
        // The limit, the three seconds between SIGTERM and SIGKILL, and the
        // two after that the answer waits on a pipe held open, with room.
        check("grandchild: the call ends in good time", Date.now() - began < limit * 1000 + 8000, true);
        check("grandchild: what it started is stopped too", await gone(kid), true);
      } finally { client.close(); }
    }
    check("grandchild: the fake started one within some limit", Number.isInteger(kid) && kid > 0, true);
  }
  client = await open({ FAKE_COPILOT: "plain" });
  try {
    check("plain text output is still an answer, the project found from cwd", (await client.call("second_opinion", { request: "r", cwd: folder })).answer, "Nothing found.");
  } finally { client.close(); }
  {
    const bench = path.join(work, "project-folder.workbenches", "t1");
    fs.mkdirSync(bench, { recursive: true });
    const repoId = db.handle().prepare("SELECT id FROM repos WHERE path = ?").get(folder).id;
    db.handle().prepare("DELETE FROM workbenches").run();
    db.handle().prepare("INSERT INTO workbenches (task_id, repo_id, path, branch, base) VALUES (?, ?, ?, ?, ?)").run(task.id, repoId, bench, "t1", "main");
    client = await open({ FAKE_COPILOT: "plain" });
    try {
      await client.call("second_opinion", { request: "r", cwd: bench });
      check("a cwd in a Workbench, nothing else named, runs there", fs.realpathSync(readLog().cwd), bench);
      await client.call("second_opinion", { request: "r", task_id: task.id });
      check("a task with a Workbench runs in it", fs.realpathSync(readLog().cwd), bench);
    } finally { client.close(); db.handle().prepare("DELETE FROM workbenches").run(); }
  }
  client = await open({ FAKE_COPILOT: "plain", DELPHI_PROJECT: "second" });
  try {
    await client.call("second_opinion", { request: "r" });
    check("a session scoped by project key runs in that project", fs.realpathSync(readLog().cwd), folder);
  } finally { client.close(); }

  section(`${name}: the size of an answer`);
  client = await open({ FAKE_COPILOT: "longline" });
  try {
    const got = await client.call("second_opinion", { request: "r", project: "second" });
    check("longline: the interim message is not passed off as the answer", [got.answer.startsWith("The real answer."), got.trimmed], [true, true]);
  } finally { client.close(); }
  for (const mode of ["big", "noline"]) {
    client = await open({ FAKE_COPILOT: mode });
    try {
      const got = await client.call("second_opinion", { request: "r", project: "second", task_id: task.id });
      check(`${mode}: cut to about 64 KB and marked`, [Buffer.byteLength(got.answer) < 64 * 1024 + 200, got.trimmed, /\[trimmed:/.test(got.answer)], [true, true, true]);
      const kept = db.handle().prepare("SELECT body FROM comments WHERE id = ?").get(got.comment_id);
      check(`${mode}: and so is what is kept`, Buffer.byteLength(kept.body) < 64 * 1024 + 600, true);
    } finally { client.close(); }
  }

  section(`${name}: redacting what is kept`);
  client = await open({ FAKE_COPILOT: "secret" });
  try {
    const got = await client.call("second_opinion", { request: "r", project: "second", task_id: task.id });
    const kept = db.handle().prepare("SELECT body FROM comments WHERE id = ?").get(got.comment_id).body;
    check("no token survives on the Sheet", [/ghp_/.test(kept), /BEGIN OPENSSH/.test(kept), /AKIA/.test(kept)], [false, false, false]);
    check("the entry says what was taken out", /3 things shaped like a token or private key were replaced with \[redacted\]/.test(kept), true);
    check("the count comes back too", got.redacted, 3);
  } finally { client.close(); }

  section(`${name}: limits`);
  client = await open({ FAKE_COPILOT: "hang" });
  try {
    fs.rmSync(logFile, { force: true });
    const first = client.call("second_opinion", { request: "r", project: "second", timeout_seconds: 2 }).catch((e) => e);
    // Wait until the first has really started.
    for (let i = 0; i < 50; i++) { await sleep(100); try { readLog(); break; } catch {} }
    await rejects("a second at once is refused", client.call("second_opinion", { request: "r", project: "second" }), /already giving a second opinion for this session/);
    check("the first still ends", /did not answer within 2 seconds/.test(String((await first).message)), true);
  } finally { client.close(); }
  clearHour();
  setSettings({ secondOpinionHourlyLimit: 2 });
  client = await open({ FAKE_COPILOT: "plain" });
  try {
    await client.call("second_opinion", { request: "r", project: "second" });
    await client.call("second_opinion", { request: "r", project: "second" });
    await rejects("the hourly limit, counted across servers", client.call("second_opinion", { request: "r", project: "second" }), /2 second opinions have been asked for on this database in the last hour/);
    db.handle().prepare("UPDATE second_opinions SET started_at = datetime('now', '-2 hours')").run();
    check("an hour later there is room again", (await client.call("second_opinion", { request: "r", project: "second" })).answer, "Nothing found.");
    setSettings({ secondOpinionHourlyLimit: 0 });
    await sleep(1100);
    setSettings({ secondOpinionHourlyLimit: 0 });
    await rejects("0 turns it off", client.call("second_opinion", { request: "r", project: "second" }), /turned off: the hourly limit/);
  } finally { client.close(); }
  setSettings({ secondOpinionHourlyLimit: 60 });
  clearHour();

  section(`${name}: the server is stopped while Copilot is running`);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    fs.rmSync(logFile, { force: true });
    const server = spawn(process.execPath, [path.join(__dirname, "..", "agent", "mcp_server.js")], {
      env: { ...process.env, ...base, FAKE_COPILOT: "hang", ELECTRON_RUN_AS_NODE: "1", DELPHI_ACTOR: "claude-code:7" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const write = (m) => server.stdin.write(JSON.stringify(m) + "\n");
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "second_opinion", arguments: { request: "r", project: "second" } } });
    let started = null;
    for (let i = 0; i < 100 && !started; i++) { await sleep(100); try { started = readLog(); } catch {} }
    check(`${signal}: Copilot started`, Boolean(started && alive(started.pid)), true);
    const exited = new Promise((r) => server.on("exit", (code, sig) => r(sig || code)));
    server.kill(signal);
    check(`${signal}: the server still dies of it`, await exited, signal);
    check(`${signal}: Copilot is stopped with it`, started ? await gone(started.pid) : false, true);
    check(`${signal}: and its MCP file is gone`, started ? fs.existsSync(started.mcp.file) : true, false);
    if (started && alive(started.pid)) process.kill(started.pid, "SIGKILL");
  }
  clearHour();

  section(`${name}: the harness row`);
  const h = db.handle();
  h.prepare("UPDATE harnesses SET enabled = 0 WHERE key = 'copilot'").run();
  client = await open();
  try {
    await rejects("turned off in Settings", client.call("second_opinion", { request: "r", cwd: folder }), /turned off in Delphi's Settings/);
    h.prepare("UPDATE harnesses SET enabled = 1, args_json = ? WHERE key = 'copilot'")
      .run(JSON.stringify(JSON.parse(originalRow.args_json).concat(["--allow-all-tools"])));
    await rejects("a row that grants tools", client.call("second_opinion", { request: "r", cwd: folder }), /may not: it has to stay read only/);
    h.prepare("UPDATE harnesses SET args_json = ?, trusted_command = NULL WHERE key = 'copilot'").run(originalRow.args_json);
    await rejects("an untrusted copilot from a temp folder", client.call("second_opinion", { request: "r", cwd: folder }), /Refusing to start GitHub Copilot: .*not copilot as an installer put it/);
    h.prepare("UPDATE harnesses SET command = 'copilot-not-installed-here' WHERE key = 'copilot'").run();
    await rejects("not installed", client.call("second_opinion", { request: "r", cwd: folder }), /not installed, or is not on the PATH/);
  } finally {
    client.close();
    h.prepare("UPDATE harnesses SET enabled = 1, args_json = ?, command = ? WHERE key = 'copilot'").run(originalRow.args_json, originalRow.command);
    trust();
  }
  // A database the app has not seeded since an upgrade has no row; the tool
  // still works, from the built-in definition, with a copilot an installer put
  // there (it has no trust to lean on).
  h.prepare("DELETE FROM harnesses WHERE key = 'copilot'").run();
  client = await open({ PATH: INSTALLED_PATH });
  try {
    check("no row: the built-in definition is used", (await client.call("second_opinion", { request: "r", cwd: folder })).label, "GitHub Copilot");
  } finally {
    client.close();
    db.seedHarnesses(harness.BUILTINS);
    trust();
  }
  clearHour();

  section(`${name}: the reviewer's own server`);
  setSettings({ secondOpinionMode: true, scratchpadMode: true });
  client = await open({ DELPHI_READ_ONLY: "1" });
  try {
    const init = await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    check("no directives, whatever the modes", init.instructions, undefined);
    const listed = (await client.request("tools/list", {})).tools;
    const names = listed.map((t) => t.name);
    check("reading tools are offered", ["search", "get_task", "read_scratchpad"].every((n) => names.includes(n)), true);
    check("exactly the list Copilot is given", names.slice().sort(), secondOpinion.READ_ONLY_TOOLS.filter((n) => names.includes(n)).sort());
    check("writing tools are not", ["add_task", "write_scratchpad", "handoff_send", "second_opinion", "add_comment"].some((n) => names.includes(n)), false);
    check("no tool notes", listed.some((t) => /MODE IS ON/.test(t.description)), false);
    const orient = await client.request("tools/call", { name: "list_projects", arguments: {} });
    check("no reminders on a result", orient.content.length, 1);
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
    await sleep(1100);
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
