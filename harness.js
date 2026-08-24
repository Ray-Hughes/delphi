// Running somebody else's agent inside Delphi.
//
// Claude Code, Codex and Copilot are harnesses: each one wraps a model in a
// loop that can read files, run commands and edit code. This is the layer above
// them. You open one as a tab against a project, it runs in that project's
// folder, and its turns land in the same sessions and messages tables the built
// in chat uses.
//
// ---------------------------------------------------------------------------
// Why this is not a terminal
//
// The obvious way to put Claude Code in a window is to give it a pseudo
// terminal and draw its output, which is what the tools that do this already do.
// It was rejected twice over.
//
// Once for the same reason terminal.js has no pty: node-pty is a native module,
// and the promise in the README is that there is nothing to compile and nothing
// to rebuild when Electron updates. One native module costs more than the
// feature is worth.
//
// And once for a better reason. A terminal gives Delphi bytes. Every one of
// these CLIs has a headless mode that gives it events: this is a tool call,
// this is the reply, this is the token count, this is the session id. With
// events, a turn is a row, a tool call is a row, and the tracker can search,
// route and attribute what the agent did. With bytes it can only redraw them.
// The whole point of this application is knowing what happened.
//
// The cost is honest and worth stating: no slash commands, no in-place
// permission prompt, no full-screen interface. Anything that needs those is
// still better run in a real terminal, and the window says so.
//
// ---------------------------------------------------------------------------
// Events
//
// The same vocabulary ai.js established, so one renderer serves both, plus the
// two things a harness has that a plain model call does not.
//
//   { type: "text",     text }              a piece of the reply
//   { type: "thinking", text }              a piece of the reasoning, if it shows it
//   { type: "tool",     name, detail }      it used a tool
//   { type: "session",  nativeId }          the CLI's own id, kept for resume
//   { type: "usage",    input, output }
//   { type: "error",    message }
//   { type: "done",     code }

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------------------
// Finding a binary
//
// An app launched from Finder inherits almost none of the PATH a terminal has,
// and a version manager puts these somewhere only a login shell knows about.
// Asking a login shell is the one reliable way, and it is slow, so it is cached.

const whichCache = new Map();

/**
 * The path to a command, as a login shell would resolve it.
 *
 * The last line rather than the whole output, because a profile that starts
 * ssh-agent prints "Agent pid 21976" before the command has said anything. The
 * existence check catches whatever else a profile might print: without it, that
 * greeting is returned as a path and every later call fails with ENOENT on a
 * filename that is obviously not one.
 */
function which(command) {
  if (whichCache.has(command)) return whichCache.get(command);
  let found = null;
  try {
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/zsh";
    const args = process.platform === "win32" ? ["/c", `where ${command}`] : ["-ilc", `command -v ${command}`];
    const out = execFileSync(shell, args, {
      encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = String(out).split("\n").map((l) => l.trim()).filter(Boolean);
    found = lines.reverse().find((l) => path.isAbsolute(l) && fs.existsSync(l)) || null;
  } catch {
    found = null;
  }
  whichCache.set(command, found);
  return found;
}

/** Forgets what was found, for when somebody has just installed something. */
const forgetPaths = () => whichCache.clear();

// ---------------------------------------------------------------------------
// The registry
//
// These are seed rows, not code. The whole promise of a harness for harnesses is
// that when one of these CLIs renames a flag in its next release, the fix is an
// edit in Settings rather than a new version of Delphi. So the argv is data, and
// what follows is only the shape that data takes.
//
// A template is a list. A plain string is an argument. A nested list is a group
// that is included only if every placeholder inside it has a value, which is how
// an optional flag and its value stay together: no value, no flag.
//
// Placeholders:
//   {prompt} {model} {system} {resume} {cwd}   substituted
//   {mcpFlags}                                 splices in however many arguments
//                                              this harness needs to be told
//                                              about Delphi's own MCP server
//   {if:autoAllow} {ifnot:autoAllow}           gate a group and are then removed

const BUILTINS = [
  {
    key: "claude-code",
    label: "Claude Code",
    command: "claude",
    parser: "claude-stream-json",
    // The CLI wraps verbatim Anthropic SSE events, which is why this and the
    // API path in ai.js share one mapper.
    mcp_style: "flag:--mcp-config",
    args: [
      "-p", "{prompt}",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      ["--model", "{model}"],
      ["--append-system-prompt", "{system}"],
      ["--resume", "{resume}"],
      // Tools are off unless the session says otherwise. The difference is
      // whether this can edit the folder it is pointed at, so it is a decision
      // somebody makes rather than a default they inherit.
      ["--permission-mode", "bypassPermissions", "{if:autoAllow}"],
      ["--tools", "", "{ifnot:autoAllow}"],
      "{mcpFlags}",
    ],
  },
  {
    key: "codex",
    label: "Codex",
    command: "codex",
    parser: "codex-json",
    mcp_style: "codex-config",
    args: [
      "exec",
      // Position matters: resume is a subcommand, not a flag, and the group
      // drops out entirely on a first turn.
      ["resume", "{resume}"],
      "--json",
      // A project folder is not always a git checkout, and without this it
      // refuses to start in one that is not.
      "--skip-git-repo-check",
      ["-m", "{model}"],
      ["-s", "danger-full-access", "{if:autoAllow}"],
      ["-s", "read-only", "{ifnot:autoAllow}"],
      "{mcpFlags}",
      "{prompt}",
    ],
  },
  {
    key: "copilot",
    label: "GitHub Copilot",
    command: "copilot",
    parser: "copilot-json",
    // The file path has to arrive prefixed with @, which is how this CLI tells a
    // path from the JSON it will otherwise try to parse. Hence the prefix half
    // of the style: without it the flag is handed a filename and reports
    // "Invalid JSON: expected value at line 1 column 1".
    mcp_style: "flag:--additional-mcp-config|@",
    args: [
      "-p", "{prompt}",
      "--output-format", "json",
      "--no-color",
      ["--model", "{model}"],
      ["--allow-all-tools", "{if:autoAllow}"],
      // --session-id rather than --resume. --resume takes an optional value, so
      // passing it without one opens an interactive picker, and there is nobody
      // here to pick.
      ["--session-id", "{resume}"],
      "{mcpFlags}",
    ],
  },
  {
    key: "custom",
    label: "Custom",
    command: "",
    parser: "text",
    mcp_style: "none",
    enabled: 0,
    // Anything that takes a prompt and prints an answer. Off until somebody
    // fills in a command, because an enabled harness with no binary is a tab
    // that only ever fails.
    args: ["-p", "{prompt}"],
  },
];

// ---------------------------------------------------------------------------
// Templates

/** True when a token still contains an unresolved placeholder. */
const hasHole = (token, values) =>
  /\{([a-zA-Z]+)\}/.test(token) &&
  [...token.matchAll(/\{([a-zA-Z]+)\}/g)].some(([, key]) => {
    const v = values[key];
    return v === undefined || v === null || v === "";
  });

const fill = (token, values) =>
  token.replace(/\{([a-zA-Z]+)\}/g, (whole, key) =>
    values[key] === undefined || values[key] === null ? whole : String(values[key]));

/**
 * Turns a template into an argv.
 *
 * Exported because this is the part with rules, and rules that are only
 * exercised through a spawned subprocess are rules nobody tests.
 */
function expand(template, values) {
  const out = [];
  for (const item of template) {
    if (Array.isArray(item)) {
      const flags = item.filter((t) => typeof t === "string" && /^\{ifn?o?t?:/.test(t));
      const gated = flags.every((f) => {
        const m = /^\{(if|ifnot):([a-zA-Z]+)\}$/.exec(f);
        if (!m) return true;
        return m[1] === "if" ? Boolean(values[m[2]]) : !values[m[2]];
      });
      if (!gated) continue;
      const body = item.filter((t) => !(typeof t === "string" && /^\{ifn?o?t?:/.test(t)));
      // A group is all or nothing: an optional flag whose value is missing must
      // not be passed on its own, which is how you get "--model" with the next
      // argument silently eaten as its value.
      if (body.some((t) => hasHole(t, values))) continue;
      for (const t of body) out.push(fill(t, values));
      continue;
    }
    // A splice: one token that stands for however many arguments the value has.
    const splice = /^\{([a-zA-Z]+)\}$/.exec(item);
    if (splice && Array.isArray(values[splice[1]])) {
      out.push(...values[splice[1]].map(String));
      continue;
    }
    if (hasHole(item, values)) continue;
    out.push(fill(item, values));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wiring the harness back to Delphi
//
// This is the part that makes the rest worth having. Every harness Delphi
// launches is handed Delphi's own MCP server, scoped to the project it is
// running in and named after the session it is running as. So the agent can read
// the pads, file tasks and hand work to another agent, and every write it makes
// is attributed in the audit trail to the harness that made it rather than to
// "agent". The History tab becomes the log of who did what, across tools.

/** The MCP server file, preferring the copy outside the archive. */
function serverPath() {
  const unpacked = process.resourcesPath
    ? path.join(process.resourcesPath, "agent", "mcp_server.js")
    : null;
  if (unpacked && fs.existsSync(unpacked)) return unpacked;
  return path.join(__dirname, "agent", "mcp_server.js");
}

/**
 * How the server is launched, as a command and arguments.
 *
 * process.execPath with ELECTRON_RUN_AS_NODE, rather than "node". There is no
 * guarantee the machine has a node on PATH that the child will inherit, and
 * Electron's own binary in that mode is a Node that is certainly present and
 * can read inside app.asar besides.
 */
function serverLaunch({ dbPath, projectId, sessionId, actor }) {
  return {
    command: process.execPath,
    args: [serverPath()],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      DELPHI_DB: dbPath,
      DELPHI_ACTOR: actor,
      ...(projectId ? { DELPHI_PROJECT: String(projectId) } : {}),
      ...(sessionId ? { DELPHI_SESSION: String(sessionId) } : {}),
    },
  };
}

/** A TOML value, for the one harness that configures MCP servers that way. */
function toml(value) {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).map(([k, v]) => `${k}=${toml(v)}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/**
 * The arguments that tell one harness about Delphi's MCP server.
 *
 * Returns the list {mcpFlags} splices in, and the path of any file it wrote so
 * the caller can clean up. Styles rather than a single mechanism because the
 * three CLIs genuinely differ: two take a config file, Codex takes dotted
 * overrides on the command line.
 */
function mcpFlags(style, context) {
  if (!style || style === "none") return { flags: [], file: null };
  const launch = serverLaunch(context);

  if (style === "codex-config") {
    return {
      flags: [
        "-c", `mcp_servers.delphi.command=${toml(launch.command)}`,
        "-c", `mcp_servers.delphi.args=${toml(launch.args)}`,
        "-c", `mcp_servers.delphi.env=${toml(launch.env)}`,
      ],
      file: null,
    };
  }

  // "flag:--mcp-config" names the flag. An optional "|@" after it is a prefix the
  // path is handed with, for a CLI that distinguishes a file from inline JSON
  // that way.
  const [name, prefix = ""] = (style.startsWith("flag:") ? style.slice(5) : "--mcp-config").split("|");
  // Copilot gates each server's tools behind a list on the entry itself, and an
  // absent list means none of them: the server starts, and the agent then says
  // it cannot reach it. The others have no such field, so it is added only for
  // the flag that wants it rather than to everyone.
  const entry = name === "--additional-mcp-config" ? { ...launch, tools: ["*"] } : launch;
  const dir = path.join(os.tmpdir(), "delphi-mcp");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `session-${context.sessionId || "adhoc"}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { delphi: entry } }, null, 2));
  return { flags: [name, `${prefix}${file}`], file };
}

// ---------------------------------------------------------------------------
// Parsers
//
// One line splitter, three mappers. All three CLIs emit JSON lines; what differs
// is only which shape means "the agent said something".

/** Splits a chunked stream into whole lines, keeping any partial one. */
function lineReader(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      // Not every line is JSON. Codex writes its own log lines to the same
      // place, and a line that does not parse is noise rather than an error.
      if (line) onLine(line);
    }
  };
}

/** Claude Code, which wraps verbatim Anthropic events. */
function claudeMapper(emit) {
  return (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.session_id) emit({ type: "session", nativeId: m.session_id });

    if (m.type === "stream_event" && m.event) {
      const e = m.event;
      if (e.type === "content_block_delta" && e.delta) {
        if (e.delta.type === "text_delta") emit({ type: "text", text: e.delta.text || "" });
        else if (e.delta.type === "thinking_delta") emit({ type: "thinking", text: e.delta.thinking || "" });
        return;
      }
      // A tool call arrives as a block start. The input streams in afterwards as
      // partial JSON, which is not worth reassembling: the name and the fact it
      // happened is what a reader wants on the transcript.
      if (e.type === "content_block_start" && e.content_block && e.content_block.type === "tool_use") {
        emit({ type: "tool", name: e.content_block.name, detail: null });
        return;
      }
      if (e.type === "message_delta" && e.usage) {
        emit({ type: "usage", input: e.usage.input_tokens || 0, output: e.usage.output_tokens || 0 });
      }
      return;
    }
    if (m.type === "result") {
      if (m.usage) {
        emit({ type: "usage", input: m.usage.input_tokens || 0, output: m.usage.output_tokens || 0 });
      }
      if (m.is_error) emit({ type: "error", message: m.result || "The agent reported an error" });
    }
  };
}

/**
 * Codex.
 *
 * Items arrive started, updated and completed, and each carries the text so far
 * rather than the piece that is new. Emitting on every one would print the reply
 * three times over, so what has already been sent per item is tracked and only
 * the tail goes out.
 */
function codexMapper(emit) {
  const sent = new Map();
  const tail = (id, text) => {
    const already = sent.get(id) || 0;
    if (text.length <= already) return "";
    sent.set(id, text.length);
    return text.slice(already);
  };

  return (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }

    if (m.type === "thread.started" && m.thread_id) {
      emit({ type: "session", nativeId: m.thread_id });
      return;
    }
    if (m.type === "turn.completed" && m.usage) {
      emit({
        type: "usage",
        input: m.usage.input_tokens || 0,
        output: m.usage.output_tokens || 0,
      });
      return;
    }
    if (m.type === "turn.failed") {
      emit({ type: "error", message: (m.error && m.error.message) || "The turn failed" });
      return;
    }
    if (m.type === "error") {
      emit({ type: "error", message: m.message || "Codex reported an error" });
      return;
    }

    const item = m.item;
    if (!item || !m.type || !m.type.startsWith("item.")) return;
    const id = item.id || `${item.type}`;

    switch (item.type) {
      case "agent_message": {
        const text = tail(id, String(item.text || ""));
        if (text) emit({ type: "text", text });
        break;
      }
      case "reasoning": {
        const text = tail(id, String(item.text || ""));
        if (text) emit({ type: "thinking", text });
        break;
      }
      case "error":
        if (m.type === "item.completed") emit({ type: "error", message: item.message || "Codex reported an error" });
        break;
      default:
        // Everything else is something it did rather than something it said.
        // Reported once, on completion, so a long command does not scroll the
        // transcript while it runs.
        if (m.type === "item.completed") {
          emit({ type: "tool", name: item.type, detail: describeCodexItem(item) });
        }
    }
  };
}

function describeCodexItem(item) {
  if (item.command) return String(item.command).split("\n")[0].slice(0, 160);
  if (item.changes) return Object.keys(item.changes).join(", ").slice(0, 160);
  if (item.query) return String(item.query).slice(0, 160);
  if (item.tool) return String(item.tool).slice(0, 160);
  return null;
}

/** Copilot, which streams deltas and then repeats the whole message. */
function copilotMapper(emit) {
  return (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    const data = m.data || {};

    switch (m.type) {
      case "assistant.message_delta":
        if (data.deltaContent) emit({ type: "text", text: data.deltaContent });
        break;
      case "assistant.reasoning_delta":
        if (data.deltaContent) emit({ type: "thinking", text: data.deltaContent });
        break;
      // Not assistant.message: it repeats the content the deltas already
      // delivered, and emitting both prints every reply twice. Its token count
      // is worth having, though.
      case "assistant.message":
        if (data.outputTokens) emit({ type: "usage", input: 0, output: data.outputTokens });
        break;
      case "result":
        if (m.sessionId) emit({ type: "session", nativeId: m.sessionId });
        break;
      case "error":
        emit({ type: "error", message: data.message || m.message || "Copilot reported an error" });
        break;
      default:
        if (m.type && m.type.startsWith("tool.") && data.name) {
          emit({ type: "tool", name: data.name, detail: null });
        }
    }
  };
}

const MAPPERS = {
  "claude-stream-json": claudeMapper,
  "codex-json": codexMapper,
  "copilot-json": copilotMapper,
};

// ---------------------------------------------------------------------------
// Running one

const live = new Map();

/**
 * Starts a turn and streams it.
 *
 * `harness` is a row from the registry. Everything else is what this particular
 * turn needs, and the template decides which of it reaches the command line.
 */
function start(options, emit) {
  const {
    harness, sessionId, cwd, prompt, model, system, resume,
    autoAllow = false, dbPath, projectId, actor, env: extraEnv,
  } = options;

  const command = harness.command && path.isAbsolute(harness.command)
    ? harness.command
    : which(harness.command || "");

  if (!command) {
    emit({ type: "error", message: `${harness.label} is not installed, or is not on the PATH a login shell sees.` });
    emit({ type: "done", code: null });
    return Promise.resolve();
  }

  const { flags, file } = mcpFlags(harness.mcp_style, {
    dbPath, projectId, sessionId,
    actor: actor || `${harness.key}:${sessionId || "adhoc"}`,
  });

  const template = typeof harness.args === "string" ? JSON.parse(harness.args) : harness.args;
  const argv = expand(template, {
    prompt, model, system, resume, cwd, autoAllow, mcpFlags: flags,
  });

  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd: cwd || undefined,
      // stdin ignored rather than inherited. Codex reads a piped stdin and
      // appends it to the prompt, and an inherited one would hand it whatever
      // Electron was launched with.
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(extraEnv || {}) },
    });

    if (sessionId) live.set(sessionId, child);

    const mapper = MAPPERS[harness.parser];
    let stderr = "";
    let said = false;

    child.stdout.setEncoding("utf8");
    if (mapper) {
      const map = mapper((event) => {
        if (event.type === "text" || event.type === "tool") said = true;
        emit(event);
      });
      child.stdout.on("data", lineReader(map));
    } else {
      // The plain text parser, for a custom command with no structured output.
      // What it prints is the reply.
      child.stdout.on("data", (chunk) => { said = true; emit({ type: "text", text: chunk }); });
    }

    child.stderr.on("data", (d) => (stderr += d));

    child.on("error", (e) => {
      emit({ type: "error", message: String(e.message || e) });
      finish(null);
    });
    child.on("close", (code) => finish(code));

    let finished = false;
    function finish(code) {
      if (finished) return;
      finished = true;
      if (sessionId) live.delete(sessionId);
      if (file) { try { fs.unlinkSync(file); } catch {} }
      // Only when it produced nothing. A non-zero exit after a complete answer
      // is common enough, and reporting stderr on top of a good reply reads as
      // though the reply were wrong.
      if (code !== 0 && !said) {
        emit({
          type: "error",
          message: stderr.trim() || `${harness.label} exited with code ${code} and said nothing.`,
        });
      }
      emit({ type: "done", code });
      resolve();
    }
  });
}

/** Stops a running turn. SIGTERM first, because these write files. */
function stop(sessionId) {
  const child = live.get(sessionId);
  if (!child) return false;
  child.kill("SIGTERM");
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
  return true;
}

const running = () => [...live.keys()];

/**
 * Whether each harness is actually usable.
 *
 * Installed is not the same as ready, and the difference is the thing worth
 * showing: a CLI that is present but signed out fails at the first turn with a
 * message nobody sees, and the tab just looks broken.
 */
function detect(harnesses, { force = false } = {}) {
  if (force) forgetPaths();
  return harnesses.map((h) => {
    const found = h.command && path.isAbsolute(h.command) ? h.command : which(h.command || "");
    if (!h.command) return { ...h, ready: false, detail: "no command set", path: null };
    if (!found) return { ...h, ready: false, detail: "not installed", path: null };
    return { ...h, ready: true, detail: "installed", path: found };
  });
}

module.exports = {
  BUILTINS, MAPPERS,
  which, forgetPaths, expand, mcpFlags, serverPath, serverLaunch, toml,
  start, stop, running, detect,
};
