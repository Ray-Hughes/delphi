/**
 * An agent in a task's Sheet: `delphi chat <task>`, and /agent in the TUI.
 *
 * The interactive sibling of the queue runner. A person says something, it is
 * written as their entry, and the agent's harness (Claude Code or Copilot) runs
 * one headless turn on it. What the agent does in that turn is read from its
 * JSON stream and written onto the Sheet as it happens: what it says as `@`,
 * each shell command as a `$` entry finished from its result, each file it
 * edits as `! edited <path>`.
 *
 * Indistinguishable is the bar. Those entries are written through an MCP
 * client of their own whose actor is the agent (`claude-code:chat-42`, type
 * agent), the same way an agent calling sheet_append writes them, and a `$`
 * entry gets what sheet/run.js gives one: a log file, exit code, duration,
 * line count, and short output inline. Nothing on the Sheet says "this came
 * through chat" except the actor name, which is the point of the name.
 *
 * Three layers, for the same reason as the TUI:
 *
 *   claudeSheetMapper, copilotSheetMapper   pure. One JSON line in, actions out.
 *   createSheetWriter                       actions in, MCP writes out, in order.
 *   chatTurn, createChatSession             the spawning and the wiring.
 *
 * The argv comes from the harness row, so a flag fixed in Settings applies
 * here too, and it is spawned as argv, never through a shell.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const harness = require("../harness");
const fmt = require("./format");
const { logPathFor, countLines, runnerMeta, SHORT_OUTPUT_LINES } = require("./run");
const { guardStatus, resolveBinary } = require("../agent/launch");

// The same limit sheet/run.js puts on inline output: five lines can still be
// a megabyte of minified JSON.
const SHORT_OUTPUT_BYTES = 8 * 1024;
const CONTEXT_TAIL = 20;
const MAX_CONTEXT = 24000;

const ADAPTERS = {
  claude: { name: "claude", harnessKey: "claude-code", label: "Claude Code", mapper: claudeSheetMapper },
  copilot: { name: "copilot", harnessKey: "copilot", label: "GitHub Copilot", mapper: copilotSheetMapper },
};

// Tools whose use is a file changed, by harness. Claude's carry file_path
// (NotebookEdit notebook_path); Copilot's carry path.
const CLAUDE_EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const COPILOT_EDITS = new Set(["edit", "create", "write"]);

// --- mapping ---------------------------------------------------------------------------
//
// A mapper turns one line of a harness's JSON stream into actions:
//
//   { type: "say", text }                 the agent said something
//   { type: "run", key, command }         it started a shell command
//   { type: "ran", key, output, code }    that command finished
//   { type: "edited", path }              it changed a file
//   { type: "session", id }               the harness's own session id, for resume
//   { type: "error", message }            the turn failed
//
// and has flush(), for what is still buffered when the stream ends.

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c.text === "string" ? c.text : "")).filter(Boolean).join("\n");
  }
  return content == null ? "" : String(content);
}

/**
 * Claude Code's stream-json. Reads the complete assistant and user messages
 * and ignores stream_event, the partial deltas: a delta is for drawing a reply
 * as it types, and the Sheet wants the reply.
 *
 * Text is buffered per message and written when something else happens (a
 * tool call, the next message, the end), so a message the CLI splits into
 * several lines is still one entry, and the entry lands in the right place
 * relative to the commands around it.
 */
function claudeSheetMapper(emit) {
  let pending = null;
  // Only commands become entries, so only their results finish one.
  const commands = new Set();
  const flush = () => {
    if (pending && pending.text.trim()) emit({ type: "say", text: pending.text });
    pending = null;
  };
  const map = (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== "object") return;
    if (m.session_id) emit({ type: "session", id: String(m.session_id) });
    if (m.type === "assistant" && m.message && Array.isArray(m.message.content)) {
      const id = m.message.id || null;
      for (const block of m.message.content) {
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string") {
          if (pending && pending.id !== id) flush();
          if (!pending) pending = { id, text: "" };
          pending.text += (pending.text ? "\n\n" : "") + block.text;
        } else if (block.type === "tool_use") {
          flush();
          const input = block.input || {};
          if (block.name === "Bash" && typeof input.command === "string") {
            commands.add(String(block.id));
            emit({ type: "run", key: String(block.id), command: input.command });
          } else if (CLAUDE_EDITS.has(block.name) && (input.file_path || input.notebook_path)) {
            emit({ type: "edited", path: String(input.file_path || input.notebook_path) });
          }
        }
      }
      return;
    }
    if (m.type === "user" && m.message && Array.isArray(m.message.content)) {
      flush();
      for (const block of m.message.content) {
        if (!block || block.type !== "tool_result" || !commands.has(String(block.tool_use_id))) continue;
        let output = toolResultText(block.content);
        // A failed Bash call reports its status as the first line.
        let code = block.is_error ? 1 : 0;
        const marked = /^Exit code (\d+)\s*(?:\n|$)/.exec(output);
        if (marked) {
          code = Number(marked[1]);
          output = output.slice(marked[0].length);
        }
        emit({ type: "ran", key: String(block.tool_use_id), output, code });
      }
      return;
    }
    if (m.type === "result") {
      flush();
      if (m.is_error) emit({ type: "error", message: String(m.result || m.subtype || "The agent reported an error.") });
    }
  };
  map.flush = flush;
  return map;
}

/**
 * Copilot's JSON stream: the events harness.js already reads. The whole
 * message arrives as assistant.message after its deltas, so that is what is
 * written, with the deltas kept only in case a message never comes. A bash
 * tool's result ends with "<exited with exit code N>", which is the only
 * place the exit code is.
 */
function copilotSheetMapper(emit) {
  const deltas = new Map();
  const commands = new Set();
  const flush = () => {
    for (const text of deltas.values()) if (text.trim()) emit({ type: "say", text });
    deltas.clear();
  };
  const map = (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== "object") return;
    const data = m.data || {};
    switch (m.type) {
      case "assistant.message_delta": {
        const id = data.messageId || "current";
        if (data.deltaContent) deltas.set(id, (deltas.get(id) || "") + data.deltaContent);
        return;
      }
      case "assistant.message": {
        const id = data.messageId || "current";
        const text = typeof data.content === "string" && data.content.trim() ? data.content : deltas.get(id) || "";
        deltas.delete(id);
        if (text.trim()) emit({ type: "say", text });
        return;
      }
      case "tool.execution_start": {
        const args = data.arguments || {};
        if (data.toolName === "bash" && typeof args.command === "string") {
          commands.add(String(data.toolCallId));
          emit({ type: "run", key: String(data.toolCallId), command: args.command });
        } else if (COPILOT_EDITS.has(data.toolName) && args.path) {
          emit({ type: "edited", path: String(args.path) });
        }
        return;
      }
      case "tool.execution_complete": {
        if (!commands.has(String(data.toolCallId))) return;
        const result = data.result || {};
        let output = toolResultText(result.content);
        let code = data.success === false ? 1 : 0;
        const marked = /\n?<exited with exit code (\d+)>\s*$/.exec(output);
        if (marked) {
          code = Number(marked[1]);
          output = output.slice(0, marked.index);
        }
        emit({ type: "ran", key: String(data.toolCallId), output, code });
        return;
      }
      case "result":
        flush();
        if (m.sessionId) emit({ type: "session", id: String(m.sessionId) });
        return;
      case "error":
        emit({ type: "error", message: String(data.message || m.message || "Copilot reported an error.") });
        return;
      default:
    }
  };
  map.flush = flush;
  return map;
}

// --- writing ---------------------------------------------------------------------------

/** Output as run.js stores it: the same trimming, and inline only when short. */
function shortOutput(output) {
  const text = fmt.normaliseBody(fmt.stripAnsi(output));
  if (!text) return null;
  if (Buffer.byteLength(output) > SHORT_OUTPUT_BYTES || countLines(output) > SHORT_OUTPUT_LINES) return null;
  return text;
}

/**
 * Applies a mapper's actions to the Sheet through the agent's MCP client, one
 * at a time and in order, so a command is never finished before it was
 * started and an entry never lands above the one it followed.
 *
 * client     the agent's MCP client
 * taskId, adapter, cwd, logDir
 * onEntry    (entry, { updated }) for each entry written or finished, for a terminal to print
 */
function createSheetWriter({ client, taskId, adapter, cwd, logDir, onEntry = () => {}, onError = () => {}, now = Date.now }) {
  let chain = Promise.resolve();
  const runs = new Map();
  let firstSay = null;
  let session = null;
  let sessionWritten = false;
  const written = [];

  // updated says whether this is an entry finished rather than a new one,
  // so a terminal prints a command's result under it instead of the command twice.
  const record = (entry, updated = false) => {
    if (entry) {
      if (!updated) written.push(entry);
      try { onEntry(entry, { updated }); } catch {}
    }
    return entry;
  };
  const call = (tool, args) => client.call(tool, args);
  // Relative to the folder it works in when the file is inside it. Both sides
  // through realpath, because the agent reports the path it resolved
  // (/private/var on a Mac) and the folder may be the path as configured.
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const relative = (file) => {
    if (!cwd) return file;
    const full = path.resolve(cwd, file);
    const base = real(cwd);
    const dirReal = real(path.dirname(full));
    const rel = path.relative(base, path.join(dirReal, path.basename(full)));
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
  };

  async function finishRun(run, { output = "", code }) {
    const entry = await run.entry;
    if (!entry || run.done) return;
    run.done = true;
    const meta = { state: code === 0 ? "ok" : "fail", code, exit: Number.isInteger(code) ? code : null, dur_ms: now() - run.started, lines: countLines(output) };
    if (logDir) {
      try {
        const file = logPathFor(logDir, taskId, entry.id);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, output);
        meta.log = file;
      } catch {}
    }
    const out = shortOutput(output);
    if (out) meta.out = out;
    record(await call("sheet_update", { id: entry.id, meta }), true);
  }

  async function apply(action) {
    switch (action.type) {
      case "session":
        session = action.id;
        if (firstSay && !sessionWritten) {
          sessionWritten = true;
          await call("sheet_update", { id: firstSay.id, meta: { session } });
        }
        return;
      case "say": {
        const meta = { agent: adapter.harnessKey };
        if (!firstSay && session) { meta.session = session; sessionWritten = true; }
        const entry = record(await call("sheet_append", { task_id: taskId, kind: "say", body: action.text, meta }));
        if (!firstSay) firstSay = entry;
        return;
      }
      case "run": {
        // A command the store would refuse as several lines is recorded by its
        // first line, with the whole of it kept in meta.script.
        const lines = String(action.command).replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
        const body = lines.length > 1 ? `${lines[0].trim()} ...` : (lines[0] || action.command).trim();
        const meta = { state: "running", cwd: cwd || null, tool_use_id: action.key, ...runnerMeta() };
        if (lines.length > 1) meta.script = action.command;
        const run = { started: now(), done: false, entry: null };
        runs.set(action.key, run);
        run.entry = call("sheet_append", { task_id: taskId, kind: "run", body, meta }).then(record);
        await run.entry;
        return;
      }
      case "ran": {
        const run = runs.get(action.key);
        if (run) await finishRun(run, action);
        return;
      }
      case "edited":
        record(await call("sheet_append", { task_id: taskId, kind: "note", body: `edited ${relative(action.path)}` }));
        return;
      case "error":
        record(await call("sheet_append", { task_id: taskId, kind: "note", body: `${adapter.label} stopped: ${String(action.message).split("\n")[0]}` }));
        return;
      default:
    }
  }

  return {
    apply(action) {
      chain = chain.then(() => apply(action)).catch((error) => { try { onError(error); } catch {} });
      return chain;
    },
    idle() { return chain; },
    /** Finishes any command the stream never reported back on, so none is left running. */
    finishOpen(code) {
      chain = chain.then(async () => {
        for (const run of runs.values()) {
          if (!run.done) await finishRun(run, { output: "", code }).catch((error) => onError(error));
        }
      });
      return chain;
    },
    get session() { return session; },
    get firstSay() { return firstSay; },
    written,
  };
}

// --- context ---------------------------------------------------------------------------

/**
 * What the agent is told on the first turn: who it is working for, the task,
 * the clean ledger and the latest entries, then the person's message. Later
 * turns in the same session are only the message, since the agent's own
 * session already holds the rest.
 */
function openingContext({ task, sheetText, message, label = "an agent", actor }) {
  const where = [task.project ? `project ${task.project}` : null, task.status ? `status ${task.status}` : null].filter(Boolean).join(", ");
  const build = (sheet) => [
    `You are ${label}, working with a person on task ${task.id} in Delphi: ${task.title}${where ? ` (${where})` : ""}.`,
    "",
    "This is the task's Sheet: its ledger (what was promoted as mattering) and its latest entries, oldest first, as clean text.",
    "A line starting > is a person, @ an agent, $ a command, ! a note, ? a question and = its answer.",
    "",
    sheet || "(Nothing on the Sheet yet.)",
    "",
    "What you say, the commands you run and the files you edit are written onto this Sheet as you go" +
      `${actor ? `, as ${actor}` : ""}. Do not copy your reply into it with sheet_append; it is already there.`,
    "Use sheet_promote on anything the next person or agent should read first.",
    "",
    "The person says:",
    "",
    String(message || "").trim(),
  ].join("\n");
  const sheet = String(sheetText || "").trim();
  const text = build(sheet);
  if (text.length <= MAX_CONTEXT) return text;
  // The Sheet is what gives, from its oldest end; the message never does.
  const over = text.length - MAX_CONTEXT + 40;
  return build(`[${over} characters of older entries cut]\n${sheet.slice(over)}`);
}

/** The clean ledger plus the tail, without the entries listed in skip. */
async function sheetContext(client, taskId, { skip = [] } = {}) {
  const [ledger, tail] = await Promise.all([
    client.call("sheet_read", { task_id: taskId, mode: "ledger" }),
    client.call("sheet_read", { task_id: taskId, mode: "tail", n: CONTEXT_TAIL + skip.length }),
  ]);
  const byId = new Map();
  for (const e of [...(ledger.entries || []), ...(tail.entries || [])]) if (!skip.includes(e.id)) byId.set(e.id, e);
  const entries = [...byId.values()].sort((a, b) => a.id - b.id);
  return { task: tail.task, text: fmt.format({ entries }, { clean: true }) };
}

/** The session to resume: the latest entry this harness wrote with one. */
async function findSession(client, taskId, harnessKey) {
  const read = await client.call("sheet_read", { task_id: taskId, mode: "full" });
  const entries = read.entries || [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const meta = entries[i].meta || {};
    if (meta.agent === harnessKey && meta.session) return String(meta.session);
  }
  return null;
}

// --- the harness row -------------------------------------------------------------------

/**
 * The harness row for an adapter: what list_agents returns, over the built in
 * defaults for anything it does not. When list_agents carries command, args,
 * parser and mcp_style, an edit in Settings applies here; DELPHI_CHAT_AGENT
 * names a different binary outright (a wrapper, or a fake in a test).
 */
function harnessRow(adapter, rows = [], env = process.env) {
  const builtin = harness.BUILTINS.find((b) => b.key === adapter.harnessKey);
  const row = (rows || []).find((r) => r && r.key === adapter.harnessKey);
  if (!row && !builtin) throw new Error(`No harness called ${adapter.harnessKey}.`);
  if (row && (row.enabled === 0 || row.enabled === false)) {
    throw new Error(`${row.label || adapter.label} is turned off in Delphi's settings.`);
  }
  const merged = { ...builtin };
  for (const key of ["label", "command", "args", "parser", "mcp_style"]) {
    if (row && row[key] !== undefined && row[key] !== null && row[key] !== "") merged[key] = row[key];
  }
  if (typeof merged.args === "string") merged.args = JSON.parse(merged.args);
  if (env.DELPHI_CHAT_AGENT) merged.command = env.DELPHI_CHAT_AGENT;
  return merged;
}

function resolveCommand(command) {
  if (!command) return null;
  if (path.isAbsolute(command)) return fs.existsSync(command) ? command : null;
  return resolveBinary(command) || harness.which(command);
}

// --- one turn ------------------------------------------------------------------------------

/**
 * Runs one turn of the agent and writes what it does onto the Sheet.
 * Resolves { code, sessionId, interrupted, stderr, written }.
 *
 * onStart({ stop }) hands over the way to interrupt it: SIGINT to the agent's
 * process group, then SIGTERM, then SIGKILL, the same escalation a run gets.
 */
function chatTurn({
  adapter, harness: row, prompt, cwd, resume = null, autoAllow = false, agentClient, taskId, projectId = null,
  actor, logDir, onEntry, onError, onStart = () => {}, env = {},
}) {
  const command = resolveCommand(row.command);
  if (!command) {
    return Promise.reject(new Error(`${row.label || adapter.label} is not installed, or is not on PATH (looked for ${row.command || "nothing"}).`));
  }
  const mcp = harness.mcpFlags(row.mcp_style, {
    dbPath: process.env.DELPHI_DB || undefined, projectId, sessionId: `chat-${taskId}`, actor,
  });
  const argv = harness.expand(row.args, { prompt, resume, cwd, autoAllow, mcpFlags: mcp.flags });
  const writer = createSheetWriter({ client: agentClient, taskId, adapter, cwd, logDir, onEntry, onError });
  const mapper = adapter.mapper((action) => writer.apply(action));
  const childEnv = { ...process.env, ...env, DELPHI_ACTOR: actor, DELPHI_AUTHOR_TYPE: "agent" };
  // The agent is not Delphi, and must not inherit the switch that makes
  // Electron's binary behave as Node.
  delete childEnv.ELECTRON_RUN_AS_NODE;

  return new Promise((resolve) => {
    const windows = process.platform === "win32";
    let child;
    try {
      child = spawn(command, argv, {
        cwd: cwd || undefined,
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so Ctrl-C at the terminal reaches only us, and
        // we decide what it means; and so stopping it stops what it started.
        detached: !windows,
        env: childEnv,
      });
    } catch (error) {
      resolve({ code: null, sessionId: null, interrupted: false, stderr: error.message, written: [] });
      return;
    }
    let stderr = "";
    let interrupted = 0;
    const timers = [];
    const signal = (sig) => {
      try { if (windows) child.kill(); else process.kill(-child.pid, sig); } catch {}
    };
    const stop = () => {
      interrupted++;
      if (interrupted === 1) {
        signal("SIGINT");
        timers.push(setTimeout(() => signal("SIGTERM"), 3000), setTimeout(() => signal("SIGKILL"), 6000));
        for (const t of timers) if (t.unref) t.unref();
      } else {
        signal("SIGKILL");
      }
    };
    try { onStart({ stop, pid: child.pid }); } catch {}

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", harnessLineReader(mapper));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { if (stderr.length < 64 * 1024) stderr += d; });

    let finished = false;
    const finish = async (code) => {
      if (finished) return;
      finished = true;
      for (const t of timers) clearTimeout(t);
      mapper.flush();
      writer.finishOpen(interrupted ? 130 : "lost");
      await writer.idle();
      if (mcp.file) { try { fs.unlinkSync(mcp.file); } catch {} }
      resolve({ code, sessionId: writer.session, interrupted: interrupted > 0, stderr, written: writer.written });
    };
    child.on("error", (error) => { stderr += error.message; finish(null); });
    child.on("close", (code) => finish(code));
  });
}

/** harness.js's line splitter, which keeps a partial line until the rest comes. */
function harnessLineReader(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line) onLine(line);
    }
  };
}

// --- a session ------------------------------------------------------------------------------

/**
 * Why a chat will not start, or null when it may.
 *
 * agent/guard.py is a Claude Code hook. It sees every command Claude Code is
 * about to run, and nothing any other harness runs. So for Claude Code the
 * rule is the queue runner's: refuse unguarded unless --allow-unguarded, and
 * refuse --auto unguarded whatever is passed. For Copilot the guard is
 * irrelevant either way, installed or not, and saying otherwise would be a
 * promise it cannot keep: without --auto Copilot asks before each tool, which
 * is the protection; with --auto nothing stands between it and a command, so
 * that needs --allow-unguarded and says why.
 */
function guardRefusal(cwd, { autoAllow = false, allowUnguarded = false, adapter = "claude" } = {}) {
  if (adapter === "copilot") {
    if (autoAllow && !allowUnguarded) {
      return "Delphi's guard cannot see Copilot's commands: agent/guard.py is a Claude Code hook. --auto lets Copilot " +
        "run commands and edit files without asking, so nothing would stop an irreversible one. Pass --allow-unguarded " +
        "with --auto if you accept that, or leave --auto off and Copilot asks before each tool.";
    }
    return null;
  }
  const status = guardStatus(cwd);
  if (status.installed) return null;
  if (autoAllow) {
    return "--auto lets the agent run commands without asking, and agent/guard.py is not installed as a hook, " +
      "so nothing would stop an irreversible one. Install the guard (see AGENTS.md); --allow-unguarded does not cover --auto.";
  }
  if (!allowUnguarded) {
    return "agent/guard.py is not installed as a PreToolUse hook for Bash, so nothing stops the agent running something " +
      "irreversible. See the Safety section of AGENTS.md, or pass --allow-unguarded if you have decided this chat does not need it.";
  }
  return null;
}

/**
 * A chat with one agent on one task. The person's own entries are written by
 * the caller, through the person's client; this runs the turns.
 *
 *   adapter          "claude" or "copilot"
 *   personClient     the person's MCP client, for reads
 *   openAgentClient  (actor) => started MCP client attributed to the agent
 *   resolved         sheet_resolve's answer for the task
 *
 * send(message, { skip }) runs a turn. skip is the ids of entries not to
 * repeat in the opening context, usually the message's own entry.
 */
async function createChatSession({
  adapter: name = "claude", personClient, openAgentClient, resolved, autoAllow = false, allowUnguarded = false,
  onEntry, onError, env = process.env,
}) {
  const adapter = ADAPTERS[name];
  if (!adapter) throw new Error(`No agent called ${name}. Use ${Object.keys(ADAPTERS).join(" or ")}.`);
  const cwd = resolved.cwd || process.cwd();
  const refusal = guardRefusal(cwd, { autoAllow, allowUnguarded, adapter: adapter.name });
  if (refusal) throw new Error(refusal);
  const rows = await personClient.call("list_agents", {});
  const row = harnessRow(adapter, rows, env);
  if (!resolveCommand(row.command)) {
    throw new Error(`${row.label} is not installed, or is not on PATH (looked for ${row.command}).`);
  }
  const taskId = resolved.task.id;
  const actor = `${adapter.harnessKey}:chat-${taskId}`;
  let resume = await findSession(personClient, taskId, adapter.harnessKey);
  const agentClient = await openAgentClient(actor);
  let first = true;
  let current = null;

  async function send(message, { skip = [] } = {}) {
    const turn = async (withResume) => {
      let prompt = String(message);
      if (first || !withResume) {
        const context = await sheetContext(personClient, taskId, { skip });
        prompt = openingContext({
          task: { ...context.task, project: resolved.project ? resolved.project.key : context.task.project },
          sheetText: context.text, message, label: row.label, actor,
        });
      }
      return chatTurn({
        adapter, harness: row, prompt, cwd, resume: withResume, autoAllow, agentClient, taskId,
        projectId: resolved.task.project_id || null, actor, logDir: resolved.log_dir, onEntry, onError,
        onStart: (c) => { current = c; },
      });
    };
    let result = await turn(resume);
    // A session the harness no longer has (cleared, another machine) fails
    // before saying anything. Once, start fresh rather than leave the person
    // stuck behind a resume that can never work.
    if (resume && result.code !== 0 && !result.written.length && !result.interrupted) {
      resume = null;
      result = await turn(null);
    }
    current = null;
    first = false;
    if (result.sessionId) resume = result.sessionId;
    return result;
  }

  return {
    adapter, actor, row, cwd,
    get resume() { return resume; },
    get busy() { return Boolean(current); },
    send,
    stop() { if (current) { current.stop(); return true; } return false; },
    close() { try { agentClient.close(); } catch {} },
  };
}

module.exports = {
  ADAPTERS, claudeSheetMapper, copilotSheetMapper, createSheetWriter, openingContext, sheetContext,
  findSession, harnessRow, guardRefusal, chatTurn, createChatSession,
};
