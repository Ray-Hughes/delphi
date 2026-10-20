/**
 * A second opinion from another agent, waited for.
 *
 * handoff_send already gives work to another agent, but as a job: it waits for a
 * person's approval, it needs the app running to dispatch it, and the answer
 * arrives as a later turn that only an agent inside a Delphi tab is woken for. A
 * review of a diff before a commit is none of those things. It is a question the
 * caller is blocked on, asked from whatever terminal the caller is in, and the
 * answer is wanted in the same breath. So this runs the other agent's CLI here,
 * in the server's own process, and hands back what it said.
 *
 * What makes that safe to do without a person approving it is that the agent
 * only reads. Its command line may carry only flags on a short list, write and
 * shell are denied by name, and a harness row edited to pass anything else is
 * refused rather than trimmed, because trimming would mean guessing at flags
 * Delphi does not know. It does get Delphi's own MCP server, started read only,
 * so it can read the same notes and pads the caller can and change none of them.
 *
 * Only Copilot for now. Each CLI says "read only" differently, and a second one
 * should arrive with its own flags and its own test rather than a guess.
 *
 * Dependency-free and outside the archive, because only the server needs it.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const harness = require("../harness");
const launch = require("./launch");

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
// Long enough for a branch-sized diff, short enough that a hung CLI cannot hold
// the caller's turn for the rest of the afternoon.
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const SUPPORTED = new Set(["copilot-json"]);

// The only flags a row may pass, and what each may carry. An allowlist, because
// a denylist of the flags that grant tools was beaten by the first one it did not
// name (--allow-tool shell, --add-dir /). Anything else in the row is refused:
// a second opinion that could edit the code it is reviewing is not one. This is
// the copilot-json half of agent/dispatch.js's POLICY, which cannot be required
// from here because the dispatcher lives inside the app's archive.
const FLAGS = {
  "--prompt": { attached: true },
  "--output-format": { value: true },
  "--no-color": {},
  "--model": { value: true },
  "--allow-tool": { value: true, only: ["delphi"] },
};

// Kept short and last in the prompt, where it is read as the brief rather than
// as part of the material.
const BRIEF =
  "You are giving a second opinion to another agent. Read only: do not edit files and do not run commands. " +
  "If Delphi's tools are available, you may search its notes and tasks for context. " +
  "Answer concisely: findings first, each with the file and line it is about, and say plainly when you found nothing.";

/** The prompt, with the files named so the agent reads them rather than guessing. */
function buildPrompt(request, files) {
  const parts = [String(request).trim()];
  if (files.length) parts.push(`Files to read:\n${files.map((f) => `- ${f}`).join("\n")}`);
  parts.push(BRIEF);
  return parts.join("\n\n");
}

/**
 * The files, made absolute and checked, and the folders the agent needs to be
 * let into to read them.
 *
 * A missing file is an error here rather than a sentence in the prompt, because
 * an agent asked to review a file it cannot find will review something else.
 */
function resolveFiles(files, cwd) {
  // Compared as real paths on both sides, or a folder reached through a link
  // (a temp folder on macOS is one) looks like it is outside itself.
  cwd = fs.realpathSync(cwd);
  const list = (Array.isArray(files) ? files : files ? [files] : []).map((f) => path.resolve(cwd, String(f)));
  const missing = list.filter((f) => !fs.existsSync(f));
  if (missing.length) throw new Error(`Cannot find ${missing.join(", ")}. Write what you want reviewed to a file first, then pass its path.`);
  const dirs = new Set();
  const inside = (dir) => dir === cwd || dir.startsWith(cwd.endsWith(path.sep) ? cwd : cwd + path.sep);
  for (const f of list) {
    // Real paths, so a link inside the folder that points out of it is let in
    // as the folder it really is, and judged as that.
    const real = fs.realpathSync(f);
    const dir = fs.statSync(real).isDirectory() ? real : path.dirname(real);
    if (!inside(dir)) dirs.add(dir);
  }
  for (const dir of [cwd, ...dirs]) refuseBroad(dir);
  return { files: list, dirs: [...dirs] };
}

/**
 * Refuses a folder too wide to hand over whole.
 *
 * Every folder here is let in with --add-dir, and the root or a home folder is
 * every key and token on the machine. The caller could read them itself, but it
 * would be sending them somewhere else, which is the thing to stop by default.
 */
function refuseBroad(dir) {
  const real = fs.realpathSync(dir);
  const broad = [path.parse(real).root, fs.realpathSync(os.homedir())];
  if (broad.includes(real)) {
    throw new Error(`${dir} is too wide to let a second opinion read: it would see everything under it. Copy what you want reviewed into a folder of its own and pass that.`);
  }
}

/**
 * The argv for one read-only run, or an error in words.
 *
 * Built from the harness row's own template, so a model or flag someone set in
 * Settings is honoured, then closed down with explicit denials. {if:jobRead} is
 * what the job dispatcher uses for an ask job, and it is what gives Copilot
 * Delphi's MCP server without asking.
 */
function plan({ row, prompt, cwd, dirs, mcpFlags }) {
  let template;
  try { template = typeof row.args_json === "string" ? JSON.parse(row.args_json) : row.args_json; } catch { template = null; }
  if (!Array.isArray(template)) {
    return { error: `${row.label}'s command line in Settings is not a list Delphi can read. Reset it in Settings, under Agents.` };
  }
  const rowArgv = harness.expand(template, { prompt, jobRead: true, autoAllow: false, jobUnguarded: false, jobWrite: false, mcpFlags: [] });
  const why = checkFlags(rowArgv, prompt);
  if (why) {
    return { error: `${row.label}'s command line in Settings passes ${why}, which a second opinion may not: it has to stay read only. Reset it in Settings, under Agents.` };
  }
  // Delphi's own wiring is added after the check, so what was checked is the
  // row and what is added is known.
  const argv = [...rowArgv, ...mcpFlags];
  argv.push("--deny-tool", "write", "--deny-tool", "shell", "--add-dir", cwd);
  for (const dir of dirs) argv.push("--add-dir", dir);
  return { argv };
}

/** The first flag in argv that is not on the list, in words, or null. */
function checkFlags(argv, prompt) {
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    const [name, attached] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
    const rule = FLAGS[name];
    if (!rule) return arg.startsWith("-") ? name : `an argument it does not expect (${arg.slice(0, 40)})`;
    if (rule.attached) {
      if (attached !== prompt) return `${name} with something other than the request`;
      continue;
    }
    if (!rule.value) {
      if (attached !== null) return arg;
      continue;
    }
    const value = attached !== null ? attached : argv[++i];
    if (value === undefined) return `${name} without a value`;
    if (rule.only && !rule.only.includes(String(value))) return `${name} ${value}`;
  }
  return null;
}

// Runs still going, so a server that is told to exit takes them with it rather
// than leaving an agent running and its MCP file on disk.
const live = new Set();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => { for (const stop of live) stop(); });
}

/** The binary, found the way the caller's terminal would, then a login shell. */
function findCommand(row, { resolveBinary = launch.resolveBinary, which = harness.which } = {}) {
  const configured = String(row.command || "");
  if (!configured) return null;
  return resolveBinary(configured) || which(configured);
}

// What Copilot prints when nobody has signed in. Matched loosely, because the
// wording has moved between releases and a miss only costs a vaguer message.
const SIGNED_OUT = /not (logged|signed) in|no authentication|authenticat(e|ion) (is )?required|please (log|sign) in|\/login/i;

/** The last few lines of something, for an error a person has to act on. */
const tail = (text, n = 6) => String(text || "").trim().split("\n").slice(-n).join("\n");

/**
 * Runs the agent and resolves with its answer.
 *
 * `row` is a harnesses row (or the built-in definition, when the app has never
 * seeded one into this database). `mcp` is the context harness.mcpFlags needs to
 * wire Delphi's server in. Rejects with an Error whose message says what to do.
 */
function run({ row, request, files = [], cwd, timeoutMs = DEFAULT_TIMEOUT_MS, mcp = null, env = process.env, spawnImpl = spawn, find = findCommand }) {
  return new Promise((resolve, reject) => {
    const label = row.label || row.key;
    if (!SUPPORTED.has(row.parser)) {
      reject(new Error(`second_opinion runs Copilot only for now, and ${label} is not Copilot. Set the second opinion agent to copilot in Delphi's Settings.`));
      return;
    }
    if (!request || !String(request).trim()) {
      reject(new Error("A second opinion needs a request: what to look at and what you want to know."));
      return;
    }
    cwd = cwd ? path.resolve(String(cwd)) : cwd;
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      reject(new Error(`The folder to run in (${cwd || "none given"}) does not exist. Pass cwd, or a project with a folder.`));
      return;
    }

    cwd = fs.realpathSync(cwd);
    let resolved;
    try { resolved = resolveFiles(files, cwd); } catch (error) { reject(error); return; }

    const command = find(row);
    if (!command) {
      reject(new Error(`${label} is not installed, or not on the PATH (looked for ${row.command}). Install it, sign in by running it once in a terminal, then ask again.`));
      return;
    }

    let wiring = { flags: [], file: null };
    try {
      if (mcp) wiring = harness.mcpFlags(row.mcp_style, mcp);
    } catch (error) {
      reject(new Error(`Could not give ${label} Delphi's tools: ${error.message}`));
      return;
    }
    const cleanup = () => { if (wiring.file) { try { fs.unlinkSync(wiring.file); } catch {} } };

    const prompt = buildPrompt(request, resolved.files);
    const built = plan({ row, prompt, cwd, dirs: resolved.dirs, mcpFlags: wiring.flags });
    if (built.error) { cleanup(); reject(new Error(built.error)); return; }

    // The caller's own Delphi variables are not the reviewer's. DELPHI_CLIENT in
    // particular would unlock the command line's internal tools for it.
    const childEnv = { ...env };
    delete childEnv.DELPHI_CLIENT;

    const limit = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const started = Date.now();
    let child;
    try {
      // stdin closed: Copilot does not read a prompt from it in this mode, and
      // an open pipe is one more way for it to sit waiting for input.
      // Its own process group, so a stop reaches whatever it started too: an MCP
      // server it launched, or the real binary behind a shim, can otherwise hold
      // the output pipe open after the agent itself has gone.
      child = spawnImpl(command, built.argv, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (error) {
      cleanup();
      reject(new Error(`Could not start ${label}: ${error.message}`));
      return;
    }

    let text = "";
    let last = null;
    let raw = "";
    let stderr = "";
    let parsed = false;
    let reported = null;
    const tools = [];
    const mapper = harness.MAPPERS[row.parser]((event) => {
      parsed = true;
      if (event.type === "text") text += event.text;
      else if (event.type === "error") reported = event.message;
      else if (event.type === "tool" && tools.length < 50) tools.push(event.name);
    });
    let buffer = "";
    child.stdout.setEncoding("utf8");
    // The last whole message is the answer. The deltas are every message,
    // including "let me look at that" between tool calls, so they are only the
    // fallback for a run that never sent a whole one.
    const read = (line) => {
      mapper(line);
      try {
        const m = JSON.parse(line);
        if (m.type === "assistant.message" && m.data && typeof m.data.content === "string" && m.data.content.trim()) last = m.data.content;
      } catch {}
    };
    const CAP = 1024 * 1024;
    child.stdout.on("data", (chunk) => {
      if (raw.length < CAP) raw += chunk;
      buffer += chunk;
      let cut;
      while ((cut = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (line) read(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk; });

    const kill = (signal) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch {}
      }
    };
    const stopNow = () => { kill("SIGKILL"); cleanup(); };
    live.add(stopNow);
    hookExit();

    let timedOut = false;
    const timedOutError = () => new Error(`${label} did not answer within ${Math.round(limit / 1000)} seconds and was stopped. Ask about less at once, or pass a longer timeout_seconds.`);
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      // A CLI that ignores SIGTERM still has to let go of the caller's turn,
      // and the answer is given even if something still holds the pipe open.
      setTimeout(() => kill("SIGKILL"), 3000).unref();
      setTimeout(() => finish(() => reject(timedOutError())), 5000).unref();
    }, limit);

    let settled = false;
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); live.delete(stopNow); cleanup(); fn(); };

    child.on("error", (error) => finish(() => reject(new Error(`Could not start ${label}: ${error.message}`))));
    child.on("close", (code, signal) => finish(() => {
      if (buffer.trim()) read(buffer.trim());
      const ms = Date.now() - started;
      if (timedOut) {
        reject(timedOutError());
        return;
      }
      // Without --output-format json the row prints plain text, and nothing
      // parses. That is still an answer.
      const answer = (parsed ? (last || text) : raw).trim();
      const said = `${reported || ""}\n${stderr}\n${parsed ? "" : raw}`;
      if (code !== 0 || (!answer && reported)) {
        if (SIGNED_OUT.test(said)) {
          reject(new Error(`${label} is not signed in. Run ${row.command} once in a terminal and sign in, then ask again.`));
          return;
        }
        reject(new Error(`${label} stopped ${code === null ? `on ${signal}` : `with exit code ${code}`}${reported ? `: ${reported}` : ""}${tail(stderr) ? `\n${tail(stderr)}` : ""}`));
        return;
      }
      if (!answer) {
        reject(new Error(`${label} finished without saying anything.${tail(stderr) ? `\n${tail(stderr)}` : ""}`));
        return;
      }
      resolve({ agent: row.key, label, answer, seconds: Math.round(ms / 100) / 10, tools });
    }));
  });
}

module.exports = { run, plan, checkFlags, buildPrompt, resolveFiles, findCommand, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
