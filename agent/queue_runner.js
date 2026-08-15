#!/usr/bin/env node
/**
 * Queue runner.
 *
 * Watches the queue, and for each claimable task spawns a headless agent to work
 * it, then writes back what the agent produced and moves the task on. Nobody is
 * sitting in front of this, which is what shapes every decision below.
 *
 * It drives agent/mcp_server.js over the stdio transport rather than opening the
 * database itself. The claim is a single UPDATE with a subselect and the release
 * path writes status_events and audit rows to match; reimplementing that here
 * would give two claim implementations that have to agree forever, and the one
 * that drifts is always the one nobody is looking at. Talking to the server also
 * means the runner works under a Node without node:sqlite, same as any other
 * client.
 *
 * The agent is spawned with argv rather than through a shell. A task title is
 * untrusted text as far as this script is concerned, and there is no quoting
 * scheme that survives being pasted into `sh -c` by someone in a hurry.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// --- options ----------------------------------------------------------------

const DEFAULTS = {
  queue: process.env.DELPHI_QUEUE || "ready",
  actor: process.env.DELPHI_ACTOR || "runner",
  // "claude -p" is Claude Code's headless form. It is only a default: anything
  // that takes a prompt as its last argument and prints its answer works.
  agent: process.env.DELPHI_AGENT_CMD || "claude -p",
  timeout: Number(process.env.DELPHI_TASK_TIMEOUT || 900),
  concurrency: 1,
  idle: 15,
  maxIdle: 300,
  cwd: process.env.DELPHI_RUNNER_CWD || process.cwd(),
  server: process.env.DELPHI_MCP_SERVER || path.join(__dirname, "mcp_server.js"),
  lease: 0,
  max: 0,
  dryRun: false,
  once: false,
  promptStdin: false,
  allowUnguarded: false,
  verbose: false,
};

const USAGE = `
Delphi queue runner: claims queued tasks and spawns a headless agent for each.

  node agent/queue_runner.js [options]

  --dry-run              Show what would happen, claim nothing, spawn nothing
  --queue NAME           Which pool to pull from (default: ${DEFAULTS.queue})
  --actor NAME           How this runner's writes are attributed (default: ${DEFAULTS.actor})
  --agent "CMD"          Headless agent command (default: ${DEFAULTS.agent})
                         A literal {} is replaced by the brief; otherwise the
                         brief is appended as the last argument
  --prompt-stdin         Feed the brief on stdin instead of as an argument
  --timeout SECONDS      Kill and release a task that runs longer (default: ${DEFAULTS.timeout})
  --lease MINUTES        Claim length (default: timeout + 5 minutes)
  --concurrency N        Tasks in flight at once (default: ${DEFAULTS.concurrency})
  --idle SECONDS         First wait when the queue is empty (default: ${DEFAULTS.idle})
  --max-idle SECONDS     Longest wait when the queue stays empty (default: ${DEFAULTS.maxIdle})
  --cwd DIR              Where the agent runs (default: this process's directory)
  --once                 Take at most one pass, then exit
  --max N                Stop after N tasks
  --server PATH          Path to mcp_server.js
  --allow-unguarded      Start even when agent/guard.py is not installed as a hook
  --verbose              Log each MCP call
  -h, --help             This
`.trimEnd();

function parseArgs(argv) {
  const o = { ...DEFAULTS };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "-h": case "--help": console.log(USAGE); process.exit(0); break;
      case "--dry-run": o.dryRun = true; break;
      case "--once": o.once = true; break;
      case "--prompt-stdin": o.promptStdin = true; break;
      case "--allow-unguarded": o.allowUnguarded = true; break;
      case "--verbose": o.verbose = true; break;
      case "--queue": o.queue = need(i, flag); i++; break;
      case "--actor": o.actor = need(i, flag); i++; break;
      case "--agent": o.agent = need(i, flag); i++; break;
      case "--cwd": o.cwd = path.resolve(need(i, flag)); i++; break;
      case "--server": o.server = path.resolve(need(i, flag)); i++; break;
      case "--timeout": o.timeout = Number(need(i, flag)); i++; break;
      case "--lease": o.lease = Number(need(i, flag)); i++; break;
      case "--concurrency": o.concurrency = Number(need(i, flag)); i++; break;
      case "--idle": o.idle = Number(need(i, flag)); i++; break;
      case "--max-idle": o.maxIdle = Number(need(i, flag)); i++; break;
      case "--max": o.max = Number(need(i, flag)); i++; break;
      default: throw new Error(`Unknown option ${flag}. Try --help.`);
    }
  }
  for (const [key, min] of [["timeout", 1], ["concurrency", 1], ["idle", 1], ["maxIdle", 1], ["max", 0], ["lease", 0]]) {
    if (!Number.isFinite(o[key]) || o[key] < min) throw new Error(`--${key} must be a number of at least ${min}`);
  }
  // The lease has to outlive the task, or the claim lapses while the agent is
  // still working and a second agent starts the same job. There is no tool for
  // extending a claim, so the only place to get this right is before taking it.
  if (!o.lease) o.lease = Math.ceil(o.timeout / 60) + 5;
  if (o.lease * 60 <= o.timeout) throw new Error("--lease must be longer than --timeout, or the claim lapses mid task");
  return o;
}

// --- logging ----------------------------------------------------------------

const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);
const warn = (...parts) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);

// --- command line into argv --------------------------------------------------

/**
 * Splits an agent command into argv, honouring quotes.
 *
 * Deliberately not a shell: no globbing, no substitution, no operators. The
 * command comes from a config file or an environment variable and the prompt it
 * carries comes from the database, and the two must never meet in a string that
 * something else parses.
 */
function splitCommand(text) {
  const out = [];
  let current = "";
  let started = false;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started || current) { out.push(current); current = ""; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) throw new Error(`Unbalanced ${quote} in the agent command`);
  if (started || current) out.push(current);
  return out;
}

/** Where a binary actually is, or null. Used to fail before claiming anything. */
function resolveBinary(name) {
  if (name.includes(path.sep) || name.startsWith(".")) {
    const full = path.resolve(name);
    return fs.existsSync(full) ? full : null;
  }
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try { if (fs.existsSync(candidate)) return candidate; } catch {}
    }
  }
  return null;
}

// --- the guard ---------------------------------------------------------------

/**
 * Whether agent/guard.py is wired in as a PreToolUse hook for Bash.
 *
 * An unattended runner is the case guard.py was written for: nobody is watching
 * the permission prompts because nobody is watching at all. Checked here rather
 * than trusted, because the failure is silent otherwise, and a runner that has
 * been quietly unguarded for a week looks exactly like one that has not.
 */
function guardStatus(cwd) {
  const files = [
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
  ];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const entries = parsed && parsed.hooks && parsed.hooks.PreToolUse;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const matcher = String(entry && entry.matcher || "");
      const body = JSON.stringify(entry && entry.hooks || []);
      if (/guard\.py/.test(body) && /Bash/.test(matcher)) return { installed: true, file };
    }
  }
  return { installed: false, file: null };
}

// --- MCP client --------------------------------------------------------------

/**
 * Speaks JSON-RPC 2.0 to agent/mcp_server.js over its stdio transport.
 *
 * One server process for the life of the runner. It handles each line as it
 * arrives, so concurrent calls are safe, and every request carries an id so the
 * answers cannot be mixed up.
 */
function openServer(options) {
  if (!fs.existsSync(options.server)) {
    throw new Error(`No MCP server at ${options.server}. Pass --server or set DELPHI_MCP_SERVER.`);
  }
  const env = { ...process.env, DELPHI_ACTOR: options.actor };
  const child = spawn(process.execPath, [options.server], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  let dead = null;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || "MCP error"));
      else waiter.resolve(message.result);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => warn("mcp:", String(chunk).trimEnd()));

  const fail = (reason) => {
    dead = dead || new Error(reason);
    for (const waiter of pending.values()) waiter.reject(dead);
    pending.clear();
  };
  child.on("error", (error) => fail(`MCP server could not start: ${error.message}`));
  child.on("exit", (code, signal) => fail(`MCP server exited (${signal || code})`));

  const request = (method, params) => new Promise((resolve, reject) => {
    if (dead) return reject(dead);
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  return {
    async start() {
      await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "delphi-queue-runner", version: "1" } });
    },
    /** Calls a tool and unwraps the JSON the server packs into its text content. */
    async call(tool, args = {}) {
      if (options.verbose) log(`mcp ${tool}`, JSON.stringify(args));
      const result = await request("tools/call", { name: tool, arguments: args });
      const text = result && result.content && result.content[0] && result.content[0].text;
      if (typeof text !== "string") return null;
      try { return JSON.parse(text); } catch { return text; }
    },
    close() {
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
    },
  };
}

// --- the brief ---------------------------------------------------------------

const MAX_BRIEF = 24000;

function clip(text, limit) {
  const value = String(text == null ? "" : text);
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  return `${value.slice(0, head)}\n\n... [${value.length - limit} characters cut] ...\n\n${value.slice(-tail)}`;
}

/**
 * The whole of what the agent is told.
 *
 * The comments and status history come along because that is the point of the
 * queue: the last agent to touch this probably left the reason it failed, and an
 * agent that starts cold repeats it.
 */
function buildBrief(claim) {
  const task = claim.task;
  const lines = [];

  lines.push(`You are an agent working one task from the Delphi queue, unattended.`);
  lines.push("");
  lines.push(`# Task ${task.id}: ${task.title}`);
  lines.push("");

  const facts = [`priority ${task.priority}`];
  if (claim.project) facts.push(`project ${claim.project.name}`);
  if (task.due) facts.push(`due ${task.due}`);
  if (task.ref) facts.push(`ref ${task.ref}`);
  lines.push(facts.join(", "));
  lines.push("");

  lines.push("## What is being asked");
  lines.push(task.detail && String(task.detail).trim()
    ? String(task.detail).trim()
    : "(No detail was recorded. Work from the title, and if it is too thin to act on, say so rather than guessing.)");
  lines.push("");

  if (claim.subtasks && claim.subtasks.length) {
    lines.push("## Subtasks");
    for (const sub of claim.subtasks) lines.push(`- [${sub.status}] ${sub.id}: ${sub.title}`);
    lines.push("");
  }

  if (claim.comments && claim.comments.length) {
    lines.push("## What has already been said on this task");
    for (const comment of claim.comments.slice(-12)) {
      lines.push(`### ${comment.author} (${comment.created_at})`);
      lines.push(clip(comment.body, 2000));
      lines.push("");
    }
  }

  lines.push("## How to finish");
  lines.push([
    "Do the work here, in this working directory.",
    "",
    "Your final message is the record. Write it for the next person: what you changed, how you verified it, and anything they need to know before touching this again. It is stored as a comment on the task verbatim.",
    "",
    "Do not call queue_complete or queue_release. The runner that started you holds the claim and closes the task with your output. Calling them yourself gives the task two endings.",
    "",
    "If you cannot do it, begin your final message with the single word CANNOT, followed by the specific reason. The task goes back to the pool with that reason attached, which is a better outcome than a plausible-looking half job.",
  ].join("\n"));

  return clip(lines.join("\n"), MAX_BRIEF);
}

// --- running one task --------------------------------------------------------

const MAX_CAPTURE = 400000;   // per stream, before the child is considered runaway
const MAX_COMMENT = 12000;    // what is worth storing on the task
const MAX_SUMMARY = 1500;

/**
 * Spawns the agent and waits for it.
 *
 * detached so the child gets its own process group: `claude` starts children of
 * its own, and killing only the process we spawned on a timeout leaves those
 * running with nothing watching them.
 */
function runAgent(argv, brief, options, register) {
  return new Promise((resolve) => {
    const args = argv.slice(1);
    const usesPlaceholder = args.includes("{}");
    const finalArgs = options.promptStdin
      ? args
      : usesPlaceholder
        ? args.map((a) => (a === "{}" ? brief : a))
        : [...args, brief];

    const child = spawn(argv[0], finalArgs, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DELPHI_ACTOR: options.childActor },
    });

    let stdout = "";
    let stderr = "";
    let outcome = null;
    let settled = false;

    const stop = (signal) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };

    const timer = setTimeout(() => {
      outcome = outcome || "timeout";
      stop("SIGTERM");
      // A SIGTERM the agent ignores is still an agent holding a claim, so there
      // is a floor under how long the polite version gets.
      setTimeout(() => stop("SIGKILL"), 10000).unref();
    }, options.timeout * 1000);

    const cancel = register(() => {
      outcome = outcome || "stopped";
      stop("SIGTERM");
      setTimeout(() => stop("SIGKILL"), 5000).unref();
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_CAPTURE) { outcome = outcome || "runaway"; stop("SIGKILL"); }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > MAX_CAPTURE) { outcome = outcome || "runaway"; stop("SIGKILL"); }
    });

    if (options.promptStdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(brief);
    } else {
      child.stdin.end();
    }

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancel();
      resolve(result);
    };

    child.on("error", (error) => done({ outcome: "spawn-failed", code: null, stdout, stderr: String(error.message) }));
    child.on("close", (code, signal) => done({ outcome: outcome || (code === 0 ? "ok" : "failed"), code, signal, stdout, stderr }));
  });
}

/** The agent's own way of handing work back. */
function refusal(stdout) {
  const first = stdout.split("\n").map((l) => l.trim()).find(Boolean) || "";
  if (!/^CANNOT\b/i.test(first)) return null;
  const rest = stdout.replace(/^\s*CANNOT[:\s-]*/i, "").trim();
  return clip(rest || first, MAX_SUMMARY);
}

function describeFailure(result, options) {
  const tail = (result.stderr || "").trim().split("\n").slice(-8).join("\n");
  switch (result.outcome) {
    case "timeout": return `Agent hit the ${options.timeout}s timeout and was killed. Nothing it did was verified.${tail ? `\n\nLast stderr:\n${clip(tail, 800)}` : ""}`;
    case "stopped": return "Runner was stopped while this was in flight, so the agent was killed part way through. Whatever it had done is unverified.";
    case "runaway": return "Agent produced more output than the runner will hold and was killed. Something is looping.";
    case "spawn-failed": return `Agent could not be started: ${clip(result.stderr, 500)}`;
    default: return `Agent exited ${result.code}${result.signal ? ` on ${result.signal}` : ""}.${tail ? `\n\nLast stderr:\n${clip(tail, 800)}` : ""}`;
  }
}

// --- the loop ----------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const argv = splitCommand(options.agent);
  if (!argv.length) throw new Error("--agent is empty. Give it something to run, for example: --agent \"claude -p\"");

  // Before anything is claimed. A runner that discovers its agent is missing
  // only after taking a task has already put that task into the thirty minute
  // wait for a lease to lapse, for no reason.
  const binary = resolveBinary(argv[0]);
  if (!binary) {
    throw new Error(
      `Cannot find the agent command '${argv[0]}' on PATH.\n` +
      `The default is Claude Code's headless form, 'claude -p'. If you use something else,\n` +
      `set DELPHI_AGENT_CMD or pass --agent "your-command --flags". The prompt is appended\n` +
      `as the last argument, or substituted for a literal {} if the command contains one.`
    );
  }

  const guard = guardStatus(options.cwd);
  if (!guard.installed) {
    const message =
      "agent/guard.py is not installed as a PreToolUse hook for Bash.\n" +
      "It is what stops an unattended agent running something irreversible, and unattended\n" +
      "is exactly what this is. See the Safety section of AGENTS.md, then start again.\n" +
      "Pass --allow-unguarded if you have decided this run does not need it.";
    if (!options.allowUnguarded && !options.dryRun) throw new Error(message);
    warn("WARNING: " + message.split("\n")[0]);
  }
  if (/dangerously-skip-permissions/.test(options.agent)) {
    warn("WARNING: the agent command skips permission prompts. Hooks still run, so guard.py still applies, but nothing else does.");
  }

  const server = openServer(options);
  await server.start();

  log(`queue '${options.queue}' as '${options.actor}', agent '${binary}', timeout ${options.timeout}s, lease ${options.lease}m`);
  log(`agent runs in ${options.cwd}`);
  log(`guard.py ${guard.installed ? `installed via ${guard.file}` : "NOT installed"}`);

  if (options.dryRun) {
    await dryRun(server, options, argv, binary);
    server.close();
    return;
  }

  const held = new Set();
  const killers = new Set();
  let stopping = false;
  let started = 0;
  let idleFor = options.idle;
  // A set rather than one handle: with more than one worker, a single slot means
  // an interrupt wakes the last sleeper and leaves the rest waiting out a backoff
  // that can be five minutes long.
  const sleepers = new Set();

  const sleep = (seconds) => new Promise((resolve) => {
    const wake = () => { clearTimeout(timer); sleepers.delete(wake); resolve(); };
    const timer = setTimeout(wake, seconds * 1000);
    sleepers.add(wake);
  });

  const register = (kill) => {
    killers.add(kill);
    return () => killers.delete(kill);
  };

  async function workOne() {
    // The budget is spent before the claim, not after. Two workers checking a
    // counter that only the winner increments both pass, and --max 1 starts two.
    if (options.max && started >= options.max) return false;
    started++;
    let claim;
    try {
      claim = await server.call("queue_next", { queue: options.queue, minutes: options.lease });
    } catch (error) {
      started--;
      throw error;
    }
    if (!claim || !claim.claimed) { started--; return false; }

    const id = claim.claimed;
    held.add(id);
    const startedAt = Date.now();
    log(`claimed ${id}: ${claim.task.title}`);

    try {
      const result = await runAgent(argv, buildBrief(claim), options, register);
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      const output = (result.stdout || "").trim();

      if (result.outcome !== "ok") {
        const reason = describeFailure(result, options);
        if (output) await server.call("add_comment", { task_id: id, body: `Agent output before it stopped:\n\n${clip(output, MAX_COMMENT)}` });
        await server.call("queue_release", { task_id: id, reason: clip(reason, MAX_SUMMARY) });
        warn(`released ${id} after ${seconds}s: ${result.outcome}`);
        return true;
      }

      const cannot = refusal(output);
      if (cannot) {
        await server.call("queue_release", { task_id: id, reason: cannot });
        log(`released ${id} after ${seconds}s: agent handed it back`);
        return true;
      }

      // The full transcript only when the summary cannot carry it. Two copies of
      // the same paragraph on a task is noise, and the point of the comment is
      // that someone reads it.
      if (output.length > MAX_SUMMARY) {
        await server.call("add_comment", { task_id: id, body: clip(output, MAX_COMMENT) });
      }
      const summary = output
        ? clip(output, MAX_SUMMARY)
        : `Agent finished in ${seconds}s and said nothing. Worth checking before trusting this one.`;
      await server.call("queue_complete", {
        task_id: id,
        summary: `${summary}\n\n(Run unattended by ${options.actor} via ${path.basename(binary)}, ${seconds}s.)`,
      });
      log(`completed ${id} in ${seconds}s`);
      return true;
    } catch (error) {
      // Anything unexpected on our side is still a claim someone else could be
      // using. Release first, complain second.
      try {
        await server.call("queue_release", { task_id: id, reason: `Runner failed while working this: ${clip(error.message, 500)}` });
      } catch {}
      throw error;
    } finally {
      held.delete(id);
    }
  }

  async function worker() {
    while (!stopping) {
      if (options.max && started >= options.max) break;
      let worked = false;
      try {
        worked = await workOne();
      } catch (error) {
        if (stopping) break;
        warn(`error: ${error.message}`);
        // Back off on errors too. A database that is locked, or a server that
        // died, otherwise turns into a tight loop of failures.
        await sleep(idleFor);
        idleFor = Math.min(idleFor * 2, options.maxIdle);
        continue;
      }
      if (worked) idleFor = options.idle;
      if (options.once) break;
      if (options.max && started >= options.max) break;
      if (worked) continue;
      await sleep(idleFor);
      idleFor = Math.min(idleFor * 2, options.maxIdle);
    }
  }

  let shuttingDown = false;
  process.on("SIGINT", () => {
    if (shuttingDown) {
      warn("second interrupt, leaving now. Any claim still held will lapse on its own.");
      process.exit(130);
    }
    shuttingDown = true;
    stopping = true;
    warn(`stopping. Releasing ${held.size} task(s) before exit, so nothing waits for a lease to lapse.`);
    for (const kill of killers) kill();
    for (const wake of Array.from(sleepers)) wake();
    // A release that cannot complete must not become a runner that will not
    // exit. Ctrl-C twice is the documented way out, and this is the automatic one.
    setTimeout(() => {
      warn("release took too long, exiting anyway.");
      process.exit(130);
    }, 30000).unref();
  });

  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));

  // Belt and braces: a worker that threw on its way out could still be holding.
  for (const id of held) {
    try {
      await server.call("queue_release", { task_id: id, reason: "Runner exited while holding this." });
    } catch {}
  }

  server.close();
  log(`done, ${started} task(s) started`);
  if (shuttingDown) process.exit(130);
}

/**
 * What would happen, without any of it happening.
 *
 * Reads through queue_status and get_task rather than queue_next on purpose: a
 * dry run that claims a task is not a dry run, and the first thing anyone does
 * with a runner is point it at a real queue to see what it thinks.
 */
async function dryRun(server, options, argv, binary) {
  const status = await server.call("queue_status", { queue: options.queue });
  const waiting = status.waiting || [];
  const inFlight = status.in_flight || [];

  log(`DRY RUN, nothing will be claimed or spawned`);
  log(`${waiting.length} waiting, ${inFlight.length} held by someone else`);
  for (const task of inFlight) {
    log(`  held  ${task.id} by ${task.claimed_by} until ${task.claim_expires}: ${task.title}`);
  }
  if (!waiting.length) {
    log(`Nothing in the '${options.queue}' queue. The runner would poll every ${options.idle}s, backing off to ${options.maxIdle}s.`);
    return;
  }

  const take = waiting.slice(0, Math.max(1, options.concurrency));
  for (const task of waiting) {
    log(`  wait  ${task.id} [${task.priority}] ${task.title}${take.includes(task) ? "   <- would take this" : ""}`);
  }

  const first = await server.call("get_task", { id: take[0].id });
  const brief = buildBrief({ claimed: first.task.id, task: first.task, project: first.project, subtasks: first.subtasks, comments: first.comments });

  const shown = options.promptStdin ? argv : (argv.includes("{}") ? argv.map((a) => (a === "{}" ? "<brief>" : a)) : [...argv, "<brief>"]);
  console.log("");
  console.log(`Would spawn, in ${options.cwd}:`);
  console.log(`  ${binary} ${shown.slice(1).join(" ")}`);
  console.log(`  brief ${options.promptStdin ? "on stdin" : "as the last argument"}, ${brief.length} characters`);
  console.log("");
  console.log("--- brief for task " + take[0].id + " ---");
  console.log(brief);
  console.log("--- end of brief ---");
  console.log("");
  console.log(`Then: add_comment with the agent's output, and queue_complete.`);
  console.log(`On a non-zero exit or after ${options.timeout}s: queue_release with the reason.`);
}

main().catch((error) => {
  warn(error.message);
  process.exit(1);
});
