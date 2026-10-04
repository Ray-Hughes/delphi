/**
 * The dispatcher: runs jobs (agent/jobs.js) through one pool of workers.
 *
 * A job is a handoff an agent sent, a task a person queued for an agent, or a
 * person's own "have Codex do this". All three used to be different things,
 * and the one that ran inside the app ran serially: one thirty-minute Claude
 * turn held every other handoff in every project, in the project's own
 * checkout, with no tools. This replaces that.
 *
 * - Each job is its own promise in `live`, never awaited by the loop, so one
 *   long job never blocks another. Limits: a global number of jobs at once and
 *   a number per harness (subscriptions throttle), from settings. One job per
 *   task at a time, because a task has one Workbench.
 * - A job that changes code (kind do) runs in its task's Workbench and nowhere
 *   else; a job that only answers (kind ask) runs read only in the project's
 *   folder. No folder, no repository: refused with the sentence that says what
 *   to set.
 * - Real permissions, from the harness row's own template: {if:jobWrite} and
 *   friends (see harness.js). Claude Code changes code only with agent/guard.py
 *   installed as its hook, Codex only in its workspace-write sandbox, Copilot
 *   only where a project allows unguarded agents. Any bypass flag in the final
 *   argv refuses the job, whatever Settings says.
 * - A person in the loop: an agent's job waits in needs_approval until a person
 *   approves it, unless the project opts in to auto-approve. A question the
 *   agent asks on the Sheet (sheet_ask) leaves the job waiting_on_human, and
 *   the answer resumes it.
 * - The log is the task's Sheet, written exactly as `delphi chat` writes it
 *   (sheet/chat.js): `@` replies, `$` runs finished with their output, `!`
 *   edits, attributed to the job's own actor.
 *
 * No Electron here, and no database: it is handed sql() in the :p1 style, the
 * Workbench verbs and settings, so tools/dispatch_test.js runs it under a plain
 * Node with fake agents. Only the app runs it; the MCP server only writes and
 * reads job rows (agent/jobs.js).
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const harness = require("../harness");
const chat = require("../sheet/chat");
const fmt = require("../sheet/format");
const { makeSheetStore, pidAlive } = require("../sheet/store");
const launch = require("./launch");
const jobs = require("./jobs");

const ADAPTER_BY_PARSER = {
  "claude-stream-json": chat.ADAPTERS.claude,
  "copilot-json": chat.ADAPTERS.copilot,
  "codex-json": { name: "codex", harnessKey: "codex", label: "Codex", mapper: chat.codexSheetMapper },
};

// What a job's command line may carry: an allowlist per harness, checked on
// the real argv inside chatTurn immediately before every spawn, every turn.
//
// An allowlist rather than a denylist of known bypasses, because a denylist
// only knows the bypasses someone thought of: each of these CLIs has several
// (--dangerously-*, --yolo, --allow-all, --settings with a bypass mode in it,
// -c approval_policy=never) and the next release can add another. A flag not
// named here refuses the job, so a new one fails closed and costs an edit
// here rather than a hole. Values are checked too, which is what keeps a job
// that only reads (kind ask, run in the main checkout) read only.
//
// Delphi's own MCP wiring ({mcpFlags}) is matched exactly as Delphi made it
// and taken out first; the same flag with any other value is refused.
const MCP_TOOLS = "mcp__delphi";
const toolList = (v) => String(v).split(/[\s,]+/).filter(Boolean);
const anyValue = { value: true, ok: () => true };
const flag = (ok = () => true) => ({ value: false, ok });
const valued = (ok) => ({ value: true, ok });
const oneOf = (allowed) => (v) => allowed.includes(v);
const READ_TOOLS = ["Read", "Glob", "Grep", "LS"];
const BUILTIN_TOOLS = [...READ_TOOLS, "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "TodoWrite", "default"];

const POLICY = {
  "claude-stream-json": {
    flags: {
      "-p": flag(), "--print": flag(),
      "--output-format": anyValue, "--include-partial-messages": flag(), "--verbose": flag(),
      "--model": anyValue, "--append-system-prompt": anyValue, "--resume": anyValue,
      "--permission-mode": valued((v, c) => (c.kind === "do" ? ["acceptEdits", "default", "plan"] : ["default", "plan"]).includes(v)),
      "--allowedtools": valued((v, c) => toolList(v).every((t) => (c.kind === "do" ? ["Bash", MCP_TOOLS] : [MCP_TOOLS]).includes(t))),
      "--allowed-tools": valued((v, c) => toolList(v).every((t) => (c.kind === "do" ? ["Bash", MCP_TOOLS] : [MCP_TOOLS]).includes(t))),
      "--tools": valued((v, c) => toolList(v).every((t) => (c.kind === "do" ? BUILTIN_TOOLS : READ_TOOLS).includes(t))),
    },
  },
  "codex-json": {
    // exec, then optionally resume <its own session id>, then flags, then the prompt.
    leading: (rest, c) => {
      if (rest[0] !== "exec") return { error: "it does not start with exec" };
      if (rest[1] === "resume") return rest[2] === c.resume && c.resume ? { used: 3 } : { error: "resume without the job's own session" };
      return { used: 1 };
    },
    trailingPrompt: true,
    flags: {
      "--json": flag(), "--skip-git-repo-check": flag(),
      "-m": anyValue, "--model": anyValue,
      "-s": valued((v, c) => (c.kind === "do" ? ["read-only", "workspace-write"] : ["read-only"]).includes(v)),
      "--sandbox": valued((v, c) => (c.kind === "do" ? ["read-only", "workspace-write"] : ["read-only"]).includes(v)),
    },
  },
  "copilot-json": {
    flags: {
      "--prompt": valued((v, c) => c.prompt != null && v === c.prompt),
      "--output-format": anyValue, "--no-color": flag(), "--model": anyValue, "--session-id": anyValue,
      // Copilot's tools, only where the project said unguarded agents may run,
      // and only to change code; Delphi's own MCP server, to every job.
      "--allow-all-tools": flag((_v, c) => c.kind === "do" && c.unguarded),
      "--allow-tool": valued(oneOf(["delphi"])),
    },
  },
};

const clipArg = (t) => { const v = String(t); return v.length > 60 ? `${v.slice(0, 57)}...` : v; };

/**
 * Why this argv may not run as this job, or null. ctx: { parser, kind,
 * unguarded, mcpFlags, prompt (when it is in argv rather than on stdin), resume }.
 */
function checkArgv(argv, { parser, kind = "ask", unguarded = false, mcpFlags = [], prompt = null, resume = null } = {}) {
  const policy = POLICY[parser];
  if (!policy) return `Delphi has no list of the flags a job may pass to a ${parser} agent`;
  const ctx = { kind, unguarded, prompt, resume };
  // The exact argv the CLI will get, Delphi's MCP flags in place. They were
  // once taken out before parsing, which let "--model --mcp-config X
  // --dangerously-skip-permissions" through: the checker read the bypass as
  // --model's value, and the CLI read it as a flag.
  const rest = argv.map(String);
  const mcp = (mcpFlags || []).map(String);
  const mcpAt = (at) => mcp.length > 0 && at + mcp.length <= rest.length && mcp.every((f, j) => rest[at + j] === f);
  let mcpSeen = false;
  let i = 0;
  if (policy.leading) {
    const lead = policy.leading(rest, ctx);
    if (lead.error) return lead.error;
    i = lead.used;
  }
  for (; i < rest.length; i++) {
    const tok = rest[i];
    // Delphi's own MCP wiring, accepted only where a flag is expected, once.
    if (!mcpSeen && mcpAt(i)) { mcpSeen = true; i += mcp.length - 1; continue; }
    // The prompt, last. One that starts with a dash would be read as a flag.
    if (policy.trailingPrompt && i === rest.length - 1 && prompt != null && tok === String(prompt)) {
      if (tok.startsWith("-")) return "a prompt that starts with '-', which the agent would read as a flag";
      continue;
    }
    if (!tok.startsWith("-") || tok === "-" || tok === "--") return `an argument it does not expect (${clipArg(tok)})`;
    let name = tok;
    let value;
    let inline = false;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq > 0) { name = tok.slice(0, eq); value = tok.slice(eq + 1); inline = true; }
      name = name.toLowerCase();
    } else if (tok.length > 2) {
      name = tok.slice(0, 2); value = tok.slice(2); inline = true;
    }
    const rule = policy.flags[name];
    if (!rule) return `${clipArg(tok)}, which is not on the list of flags a job may pass to this agent`;
    if (rule.value) {
      if (!inline) {
        if (i + 1 >= rest.length) return `${name} with no value`;
        value = rest[++i];
        // A value in its own argument never starts with a dash: some of these
        // flags take an optional value (Claude's --resume), and the CLI reads
        // a dash-word there as the next flag, not as the value.
        if (value.startsWith("-")) return `${name} followed by ${clipArg(value)}, which the agent would read as a flag`;
      }
      if (!rule.ok(value, ctx)) return `${name} ${clipArg(value)}`;
    } else {
      if (inline) return clipArg(tok);
      if (!rule.ok(null, ctx)) return name;
    }
  }
  return null;
}

// The binary each kind of harness is, and where a real one is installed.
//
// A tripwire against accidents and casual edits (a wrapper typed into
// Settings, a `claude` script earlier on PATH, a row an agent rewrote), not a
// boundary against a determined local process, which can write these same
// folders. The command, followed to the file it really is, must sit under a
// folder installers put these programs in, inside that harness's own package
// or named for it, in folders nobody else can write; or be exactly the file a
// person trusted.
const BINARY = Object.fromEntries(harness.BUILTINS.filter((b) => b.command).map((b) => [b.parser, b.command]));
const PACKAGE = {
  claude: `${path.sep}@anthropic-ai${path.sep}claude-code${path.sep}`,
  codex: `${path.sep}@openai${path.sep}codex${path.sep}`,
  copilot: `${path.sep}@github${path.sep}copilot${path.sep}`,
};
const stem = (file) => path.basename(file).replace(/\.(exe|js|cjs|mjs|cmd)$/i, "").toLowerCase();
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

let npmRootCache;
/** `npm root -g`, once: where npm's global installs land for the node in use (asdf, nvm, volta or system). */
function npmRoot({ which = harness.which } = {}) {
  if (npmRootCache !== undefined) return npmRootCache;
  npmRootCache = null;
  try {
    const npm = launch.resolveBinary("npm") || which("npm");
    if (npm) {
      const out = require("child_process").execFileSync(npm, ["root", "-g"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
      const line = String(out).split("\n").map((l) => l.trim()).filter((l) => path.isAbsolute(l)).pop();
      if (line) npmRootCache = realOf(line) || line;
    }
  } catch {}
  return npmRootCache;
}

/**
 * The folders a real install lives under, each with whether anything under it
 * counts (a folder only that harness uses) or only that harness's package or
 * a file named for it.
 */
function installRoots({ home = require("os").homedir(), npm = npmRoot() } = {}) {
  const roots = [
    { dir: path.join(home, ".local", "share", "claude", "versions"), only: "claude" },
    { dir: path.join(home, ".claude", "local"), only: "claude" },
    { dir: "/opt/homebrew" }, { dir: "/usr/local/Cellar" }, { dir: "/usr/local/lib/node_modules" },
  ];
  if (npm) roots.push({ dir: npm });
  return roots.map((r) => ({ ...r, dir: realOf(r.dir) || r.dir }));
}

const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * Why a file, or a folder above it, could be swapped by somebody else, or
 * null. A folder anyone can write is refused unless it is sticky (as /tmp is),
 * where others cannot replace what is in it; a file or folder owned by anyone
 * but this user or root is refused. Not on Windows, which has no such bits.
 */
function swappable(file) {
  if (typeof process.getuid !== "function") return null;
  const uid = process.getuid();
  let at = file;
  for (;;) {
    let st;
    try { st = fs.statSync(at); } catch { return `${at} cannot be read`; }
    if (st.uid !== uid && st.uid !== 0) return `${at} belongs to another user`;
    if (st.isDirectory() && (st.mode & 0o002) && !(st.mode & 0o1000)) return `${at} can be written by anyone`;
    if (at !== file && st.isFile()) return `${at} is not a folder`;
    if (!st.isDirectory() && (st.mode & 0o002)) return `${at} can be written by anyone`;
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** The command as the job would find it, followed to the real file, or null. */
function resolveCommand(command, { resolveBinary = launch.resolveBinary, which = harness.which } = {}) {
  const configured = String(command || "");
  if (!configured) return null;
  const found = path.isAbsolute(configured) ? (fs.existsSync(configured) ? configured : null) : (resolveBinary(configured) || which(configured));
  if (!found) return null;
  return { found, real: realOf(found) || found };
}

/**
 * The absolute path a job may spawn for this harness row, or { error }.
 * row.trusted_command, when set, is the real path a person trusted; a row
 * whose command now resolves anywhere else is not trusted.
 */
function jobCommand(row, { resolveBinary = launch.resolveBinary, which = harness.which, roots = null } = {}) {
  const configured = String(row.command || "");
  const binary = BINARY[row.parser];
  const label = row.label || "This agent";
  if (!configured) return { error: `${label} has no command set in Settings` };
  const resolved = resolveCommand(configured, { resolveBinary, which });
  if (!resolved) return { error: `${label} is not installed, or is not on the PATH a login shell sees (looked for ${configured})` };
  const { found, real } = resolved;
  const unsafe = swappable(real) || (found !== real ? swappable(path.dirname(found)) : null);
  if (unsafe) return { error: `${label}'s command (${found}) could be changed by someone else: ${unsafe}` };
  if (row.trusted_command && row.trusted_command === real) return { path: found };
  const list = roots || installRoots();
  const ok = binary && list.some((r) => inside(r.dir, real) && (
    r.only ? r.only === binary : (real.includes(PACKAGE[binary] || "\0") || stem(real) === binary)));
  if (ok) return { path: found };
  return {
    error: `${label}'s command (${configured}, which is ${real}) is not ${binary || "the agent"} as an installer put it, so Delphi cannot know what flags it adds. ` +
      `If you trust it, click "Trust this command" under Settings, Agents, ${label}; otherwise point it at ${binary || "the agent"} itself`,
  };
}

const DEFAULTS = { jobConcurrency: 3, jobHarnessLimit: 1, jobTimeoutMinutes: 60 };
// The bounds settings:set enforces, held here too so a hand-edited
// settings.json cannot ask for forty agents at once. Eight in all is more than
// one person can review; four of one harness is past what a subscription lets
// run before it throttles. 0 for a harness holds its jobs without refusing them.
const BOUNDS = { jobConcurrency: [1, 8], jobHarnessLimit: [0, 4], jobTimeoutMinutes: [1, 24 * 60] };
const HOURLY_LIMIT = 12;
const SHEET_TAIL = 20;
const MAX_BRIEF_SHEET = 16000;

const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const firstLine = (text, n = 200) => {
  const line = String(text || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  return line.length > n ? `${line.slice(0, n - 3)}...` : line;
};
const int = (v, fallback, min, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/** The Sheet writer's MCP client, answered in process by a store made for the agent. */
function storeClient(store) {
  return {
    async call(tool, a = {}) {
      if (tool === "sheet_append") {
        return store.append({ taskId: a.task_id, kind: a.kind, body: a.body, meta: a.meta ?? null, refId: a.ref_id ?? null, promote: a.promote === true });
      }
      if (tool === "sheet_update") return store.update(a.id, { meta: a.meta, body: a.body });
      throw new Error(`${tool} is not something a job's writer does.`);
    },
  };
}

function createDispatcher({
  sql,
  // workbench/workbench.js createWorkbench(...), for jobs that change code.
  benches = null,
  logDir = null,
  dbPath = null,
  dbId = null,              // a value, or a function returning one
  settings = () => ({}),
  // ({ id, state, project_id }) whenever a job changes, for the Runs panel.
  onChange = () => {},
  // (run) when a job ends a turn, for the wake (main.js).
  onFinished = () => {},
  host = os.hostname(),
  pid = process.pid,
  isAlive = pidAlive,
  runTurn = chat.chatTurn,
  guardStatus = launch.guardStatus,
  hourlyLimit = HOURLY_LIMIT,
  // For tests: a job's time limit in ms instead of jobTimeoutMinutes, and how
  // long after it a turn that will not end is abandoned.
  jobTimeoutMs = null,
  hardGraceMs = 10000,
  log = (...parts) => console.error(...parts),
} = {}) {
  if (typeof sql !== "function") throw new Error("createDispatcher needs a sql(query, params) function");
  const tool = makeSheetStore({ sql, actor: "delphi", authorType: "tool" });
  const live = new Map();
  let closed = false;
  let ticking = false;

  const limits = () => {
    const s = (typeof settings === "function" ? settings() : settings) || {};
    const perHarness = s.jobHarnessLimits && typeof s.jobHarnessLimits === "object" ? s.jobHarnessLimits : {};
    return {
      global: int(s.jobConcurrency, DEFAULTS.jobConcurrency, ...BOUNDS.jobConcurrency),
      harness: (key) => int(perHarness[key], DEFAULTS.jobHarnessLimit, ...BOUNDS.jobHarnessLimit),
      timeoutMs: int(s.jobTimeoutMinutes, DEFAULTS.jobTimeoutMinutes, ...BOUNDS.jobTimeoutMinutes) * 60 * 1000,
    };
  };

  const changed = (run) => {
    if (!run) return;
    try { onChange({ id: run.id, state: run.state, project_id: run.project_id }); } catch {}
  };

  function audit(id, summary, label, by = "delphi") {
    try {
      sql(`INSERT INTO audit (action, entity, entity_id, summary, label) VALUES ('update', 'handoff', :p1, :p2, :p3)`,
          [Number(id), `${summary} (by ${by})`, label ? String(label).slice(0, 80) : null]);
    } catch (error) { log("job audit", error.message); }
  }

  // A note never fails the job: the row is the record, the note is the account.
  function note(taskId, body) {
    if (!taskId) return null;
    try { return tool.append({ taskId, kind: "note", body }); } catch (error) { log("job note", error.message); return null; }
  }

  // ---------------------------------------------------------------------------
  // Creating and moving jobs

  function projectRow(id) {
    return sql("SELECT * FROM projects WHERE id = :p1", [Number(id)])[0] || null;
  }

  /**
   * A job a person asked for, from the window. Refused at once, with the
   * reason, when it could never run: nothing to run it with, or nowhere.
   */
  function create({ projectId, harness: key, request, taskId = null, kind = "ask", context = null, wake = false, fromSessionId = null } = {}, { by = "you", type = "human" } = {}) {
    const project = projectRow(jobs.projectFor(sql, { projectId: projectId || null, taskId }));
    if (!project) throw new Error(`There is no project ${projectId}.`);
    const row = sql("SELECT key, label, enabled FROM harnesses WHERE key = :p1", [String(key || "")])[0];
    if (!row || !Number(row.enabled)) throw new Error(`There is no agent called "${key}" turned on here. Turn it on in Settings, under Agents.`);
    const problem = jobs.folderProblem(sql, project.id);
    if (problem) throw new Error(problem);
    const { state, approval } = jobs.approvalFor({ requesterType: type, autoApprove: Number(project.auto_approve) === 1 });
    const run = jobs.insert(sql, {
      projectId: project.id, toHarness: row.key, request, taskId, context, wake, kind, source: "person",
      requestedBy: by, requesterType: type, fromSessionId, state, approval,
    });
    audit(run.id, `asked ${row.key} (${kind})`, run.request, by);
    changed(run);
    soon();
    return run;
  }

  /**
   * harnessHash: the harness row as the person saw it (a run's
   * harness_hash_now). Approval is of what they saw, so a row changed since is
   * refused rather than approved at the click. requireHash is the window's
   * route, where showing it is the point.
   */
  function approve(id, { by = "you", harnessHash = null, requireHash = false } = {}) {
    const current = jobs.get(sql, id);
    const hash = current ? jobs.harnessHash(sql, current.harness) : null;
    if (current && requireHash && !harnessHash) {
      throw new Error(`Approving job ${id} needs the agent's settings as you saw them (harnessHash). Look at it again, then approve.`);
    }
    if (current && harnessHash && harnessHash !== hash) {
      throw new Error(`${current.harness_label}'s settings changed after you looked at job ${id}, so it was not approved. Look at it again, then approve.`);
    }
    const run = jobs.update(sql, id, { state: "queued", approval: "approved", approved_by: by, approved_at: stamp(), harness_hash: hash }, { from: "needs_approval" });
    if (!run) throw notIn(id, "waiting for approval");
    audit(run.id, "approved", run.request, by);
    note(run.task_id, `Job ${run.id} approved by ${by}: ${run.harness_label} may start.`);
    changed(run);
    soon();
    return run;
  }

  function reject(id, { by = "you", why = null } = {}) {
    const reason = why && String(why).trim() ? `: ${String(why).trim()}` : ".";
    const run = jobs.update(sql, id, { state: "stopped", approval: "rejected", approved_by: by, approved_at: stamp(), reply: `Rejected by ${by}${reason}` }, { from: "needs_approval" });
    if (!run) throw notIn(id, "waiting for approval");
    audit(run.id, "rejected", run.request, by);
    note(run.task_id, `Job ${run.id} rejected by ${by}${reason}`);
    changed(run);
    return run;
  }

  function notIn(id, what) {
    const run = jobs.get(sql, id);
    if (!run) return new Error(`There is no job ${id}.`);
    return new Error(`Job ${id} is not ${what}; it is ${run.state.replace(/_/g, " ")}.`);
  }

  /**
   * Stops a job. A running one has its agent's whole process group ended
   * (SIGTERM, then SIGKILL), its open commands finished on the Sheet, and its
   * Workbench left exactly as it is for a person to review.
   */
  function stop(id, { by = "you" } = {}) {
    const entry = live.get(Number(id));
    if (entry) {
      entry.stopReason = "person";
      entry.stoppedBy = by;
      if (entry.stop) entry.stop("stopped");
      audit(entry.id, "stop asked", null, by);
      return jobs.get(sql, id);
    }
    const run = jobs.get(sql, id);
    if (!run) throw new Error(`There is no job ${id}.`);
    if (["queued", "needs_approval", "waiting_on_human"].includes(run.state)) {
      // A job stopped before anyone approved it was in effect rejected, so a
      // later reply cannot start it without an approval.
      const refused = run.state === "needs_approval" ? { approval: "rejected", approved_by: by, approved_at: stamp() } : {};
      const after = jobs.update(sql, id, { ...refused, state: "stopped", followup: null, reply: run.reply || `Stopped by ${by} before it ran.` }, { from: run.state });
      if (!after) return stop(id, { by });
      audit(id, `stopped while ${run.state.replace(/_/g, " ")}`, run.request, by);
      note(run.task_id, `Job ${id} stopped by ${by}.${after.workbench ? ` Its Workbench at ${after.workbench.path} is left as it is.` : ""}`);
      changed(after);
      return after;
    }
    if (run.state === "running") {
      throw new Error(`Job ${id} is being run by another Delphi (pid ${run.runner_pid || "?"} on ${run.runner_host || "another machine"}); stop it there.`);
    }
    throw new Error(`Job ${id} has already finished (${run.state}).`);
  }

  /**
   * A person's follow-up. Written on the Sheet as theirs, and sent to the
   * agent as its next turn, resuming the harness's own session when there is
   * one. Allowed whenever the job is not running or waiting to.
   */
  function reply(id, message, { by = "you" } = {}) {
    const text = String(message == null ? "" : message).trim();
    if (!text) throw new Error("A reply needs something in it.");
    const run = jobs.get(sql, id);
    if (!run) throw new Error(`There is no job ${id}.`);
    if (run.state === "needs_approval") throw new Error(`Job ${id} has not been approved yet. Approve it first, then reply.`);
    if (run.state === "running" || run.state === "queued") throw new Error(`Job ${id} is ${run.state}; reply once its turn has finished.`);
    if (run.approval === "rejected") throw new Error(`Job ${id} was rejected. Ask again to start a new one.`);
    if (run.task_id) {
      makeSheetStore({ sql, actor: by, authorType: "human" }).append({ taskId: run.task_id, kind: "say", body: text });
    }
    const after = jobs.update(sql, id, { state: "queued", followup: text }, { from: run.state });
    if (!after) throw notIn(id, "finished its turn");
    audit(id, "replied to", run.request, by);
    changed(after);
    soon();
    return after;
  }

  /**
   * A person's review of a finished job. Accepting records it. Sending it back
   * records it too, and puts the person's note on the task's Sheet in their
   * own name, where the next agent on the task reads it first; then says
   * whether there is a Workbench to carry on in, with the runs:create payload
   * that would, rather than starting one itself: what to run next, and with
   * which agent, is the person's next decision, not this one.
   */
  function review(id, { accepted, note: said = null } = {}, { by = "you" } = {}) {
    if (typeof accepted !== "boolean") throw new Error("A review says accepted: true or accepted: false.");
    const text = said == null ? "" : String(said).trim();
    const run = jobs.get(sql, id);
    if (!run) throw new Error(`There is no job ${id}.`);
    if (!jobs.REVIEWABLE.includes(run.state)) {
      throw new Error(`Job ${id} is ${run.state.replace(/_/g, " ")}; only a done or failed job is reviewed.`);
    }
    const after = jobs.review(sql, id, { accepted, by, note: text || null });
    if (!after) {
      const now = jobs.get(sql, id);
      throw new Error(now && now.reviewed_at
        ? `Job ${id} was already reviewed by ${now.reviewed_by || "someone"} at ${now.reviewed_at}.`
        : notIn(id, "done or failed").message);
    }
    let entry = null;
    if (after.task_id) {
      if (!accepted && text) {
        entry = makeSheetStore({ sql, actor: by, authorType: "human" }).append({ taskId: after.task_id, kind: "say", body: text, promote: true });
      }
      note(after.task_id, accepted ? `Job ${id} reviewed and accepted by ${by}.` : `Job ${id} sent back by ${by}${text ? "." : ", with no note."}`);
    }
    audit(id, accepted ? "accepted" : "sent back", text || after.request, by);
    changed(after);
    if (accepted) return { run: after, entry: null, continue: null };
    return { run: after, entry, continue: continuation(after, text) };
  }

  /**
   * Whether a sent-back job can carry on where it left off, and how: the
   * runs:create payload for a new do job on the same task, whose Workbench
   * the dispatcher reuses because a task has one. A Workbench that is gone,
   * parked or being put away is a person's to sort out first, and is said so.
   */
  function continuation(run, text) {
    const wb = run.workbench;
    const base = { workbench: wb, task_id: run.task_id };
    if (!run.task_id) return { ...base, available: false, why: `Job ${run.id} has no task, so there is no Workbench to carry on in.` };
    if (!wb) return { ...base, available: false, why: `Job ${run.id} had no Workbench: it only read. Ask again to have an agent change code.` };
    const live = sql("SELECT state, path FROM workbenches WHERE id = :p1", [wb.id])[0];
    const state = live ? live.state : null;
    if (state !== "active") {
      const said = { parked: "is parked; resume it first", missing: "folder is gone; recreate it first", closing: "is being put away" };
      return { ...base, available: false, why: `Task ${run.task_id}'s Workbench ${said[state] || (state ? `is ${state}` : "is no longer recorded")}.` };
    }
    const request = `A person sent job ${run.id} back. Carry on in this task's Workbench, from what is already there.${text ? `\n\nTheir note:\n${text}` : ""}`;
    return {
      ...base,
      available: true,
      create: { projectId: run.project_id, harness: run.harness, taskId: run.task_id, kind: "do", request },
    };
  }

  /** Queued jobs in a person's order, first to run first. Starts what that frees. */
  function reorder(ids, { by = "you" } = {}) {
    const order = jobs.reorder(sql, ids);
    for (const id of ids) changed(jobs.get(sql, id));
    audit(Number(ids[0]), `queue reordered: ${order.join(", ")}`, null, by);
    soon();
    return order.map((n) => jobs.get(sql, n));
  }

  /**
   * A person answered on a task's Sheet: the job waiting on it goes back to
   * its agent now, not at the next scheduler pass, which is a minute away by
   * default and longer if someone stretched it.
   */
  function answered(taskId = null) {
    const resumed = jobs.resumeAnswered(sql, { taskId });
    for (const r of resumed) changed(r);
    tick();
    return resumed.map((r) => r.id);
  }

  // Each run carries its harness row's hash as it is now, for the window to
  // hand back when a person approves what it showed them.
  const withHash = (runs) => {
    const seen = new Map();
    const now = (key) => { if (!seen.has(key)) seen.set(key, jobs.harnessHash(sql, key)); return seen.get(key); };
    return runs.map((r) => (r ? { ...r, harness_hash_now: now(r.harness) } : r));
  };
  const get = (id) => withHash([jobs.get(sql, id)])[0];
  const list = (opts = {}) => withHash(jobs.list(sql, opts));

  // ---------------------------------------------------------------------------
  // Recovery and shutdown

  /**
   * Jobs this machine's Delphi was running when it died are failed as
   * interrupted, with a note, and never run again on their own: rerunning an
   * agent somebody stopped looking at is how work gets done twice.
   */
  function recover() {
    const out = [];
    for (const row of sql("SELECT id FROM handoffs WHERE state = 'running' ORDER BY id")) {
      if (live.has(Number(row.id))) continue;
      const run = jobs.get(sql, row.id);
      const raw = sql("SELECT runner_pid, runner_host, agent_pid FROM handoffs WHERE id = :p1", [run.id])[0] || {};
      // Another machine sharing the file is left alone. On this one, a running
      // row this process is not running is dead whatever its pid says: there
      // is one app per database, and after a reboot the old pid can belong to
      // anything, which used to leave such a job running forever.
      if (raw.runner_host && raw.runner_host !== host) continue;
      const still = raw.agent_pid && isAlive(Number(raw.agent_pid))
        ? ` Its agent process (pid ${raw.agent_pid}) may still be running; it is no longer watched.` : "";
      const reason = `interrupted: Delphi stopped while this job was running, so it never finished. It is not run again on its own; reply to it to carry on.` +
        `${run.workbench ? ` Its Workbench at ${run.workbench.path} is left as it was.` : ""}${still}`;
      const after = jobs.update(sql, run.id, { state: "failed", reply: reason }, { from: "running" });
      if (!after) continue;
      audit(run.id, "interrupted", run.request);
      note(run.task_id, `Job ${run.id} ${reason}`);
      out.push(run.id);
      changed(after);
    }
    return out;
  }

  /**
   * Stops everything on the way out. The rows are written first, at once,
   * because the process may be gone before the agents have finished dying.
   */
  function shutdown(reason = "Delphi quit") {
    closed = true;
    for (const entry of live.values()) {
      entry.stopReason = "shutdown";
      const msg = `interrupted: ${reason} while this job was running. It is not run again on its own; reply to it to carry on.`;
      try {
        const after = jobs.update(sql, entry.id, { state: "failed", reply: msg }, { from: "running" });
        if (after) note(after.task_id, `Job ${entry.id} ${msg}`);
      } catch {}
      if (entry.stop) { try { entry.stop("quit"); } catch {} }
    }
  }

  // ---------------------------------------------------------------------------
  // The pass

  let soonTimer = null;
  function soon() {
    if (soonTimer || closed) return;
    soonTimer = setTimeout(() => { soonTimer = null; tick(); }, 20);
    if (soonTimer.unref) soonTimer.unref();
  }

  /** Rows an older server wrote, given the state they would have had. */
  function adopt() {
    for (const row of sql("SELECT h.id, p.auto_approve FROM handoffs h JOIN projects p ON p.id = h.project_id WHERE h.state IS NULL AND h.status = 'queued'")) {
      const { state, approval } = jobs.approvalFor({ requesterType: "agent", autoApprove: Number(row.auto_approve) === 1 });
      sql(`UPDATE handoffs SET state = :p1, status = :p2, approval = :p3, requester_type = COALESCE(requester_type, 'agent'), updated_at = datetime('now')
            WHERE id = :p4 AND state IS NULL`, [state, jobs.LEGACY[state], approval, Number(row.id)]);
      changed(jobs.get(sql, row.id));
    }
  }

  /**
   * Tasks in a queue named after a harness become jobs for it. Taken out of
   * the queue in the same statement, so neither a second pass nor an agent
   * calling queue_next can take it as well.
   */
  function fileQueued() {
    const rows = sql(
      `SELECT t.id, t.project_id, t.title, t.queue, t.queued_by, t.queued_by_type, p.auto_approve
         FROM tasks t JOIN harnesses h ON h.key = t.queue AND h.enabled = 1
         JOIN projects p ON p.id = t.project_id
        WHERE t.status NOT IN ('done', 'blocked')
          AND (t.claimed_by IS NULL OR t.claim_expires < datetime('now'))
          AND NOT EXISTS (SELECT 1 FROM handoffs j WHERE j.task_id = t.id AND j.state IN (${jobs.OPEN_SQL}))
        ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, t.id`, []);
    for (const t of rows) {
      // The claim and status rechecked in the same statement as the take: an
      // agent's queue_next between the look and here must not leave the task
      // with two workers.
      const took = sql(`UPDATE tasks SET queue = NULL, updated_at = datetime('now')
                         WHERE id = :p1 AND queue = :p2 AND status NOT IN ('done', 'blocked')
                           AND (claimed_by IS NULL OR claim_expires < datetime('now')) RETURNING id`, [t.id, t.queue])[0];
      if (!took) continue;
      const type = t.queued_by_type || "agent";
      const { state, approval } = jobs.approvalFor({ requesterType: type, autoApprove: Number(t.auto_approve) === 1 });
      const run = jobs.insert(sql, {
        projectId: t.project_id, toHarness: t.queue, request: `Work task ${t.id}: ${t.title}`, taskId: t.id, kind: "do",
        source: "queue", requestedBy: t.queued_by || null, requesterType: type, state, approval, wake: false,
        context: { queue: t.queue },
      });
      sql(`INSERT INTO audit (action, entity, entity_id, summary, label) VALUES ('update', 'task', :p1, :p2, :p3)`,
          [t.id, `taken from the ${t.queue} queue as job ${run.id} (by delphi)`, t.title]);
      if (state === "needs_approval") note(t.id, `Job ${run.id}: queued for ${run.harness_label} by ${t.queued_by || "an unknown writer"}, waiting for a person to approve it.`);
      changed(run);
    }
  }

  /** A question the agent asked is answered: the job goes back to its agent. See jobs.resumeAnswered. */
  function resumeAnswered() {
    for (const after of jobs.resumeAnswered(sql)) changed(after);
  }

  const harnessCount = (key) => [...live.values()].filter((e) => e.harness === key).length;
  const taskBusy = (taskId) => taskId != null && (
    [...live.values()].some((e) => e.taskId === Number(taskId)) ||
    Number(sql("SELECT COUNT(*) AS n FROM handoffs WHERE task_id = :p1 AND state = 'running'", [Number(taskId)])[0].n) > 0);

  /**
   * One pass: adopt, file the queues, resume answered jobs, then start what
   * the limits allow. Synchronous and quick; every job it starts runs on its own.
   */
  function tick() {
    if (closed || ticking) return;
    ticking = true;
    try {
      adopt();
      fileQueued();
      resumeAnswered();
      const lim = limits();
      for (const row of sql(`SELECT id, project_id, to_harness, task_id, requester_type FROM handoffs WHERE state = 'queued' ORDER BY ${jobs.PICK_ORDER}`)) {
        if (live.size >= lim.global) break;
        if (harnessCount(row.to_harness) >= lim.harness(row.to_harness)) continue;
        if (taskBusy(row.task_id)) continue;
        if (jobs.finishedSince(sql, row.project_id) >= hourlyLimit) {
          // A person's own request waits for the hour to pass; an agent's,
          // which is how a loop between two agents shows up, is stopped.
          if (row.requester_type === "human") {
            const why = `Waiting: ${hourlyLimit} jobs finished in this project in the last hour, so this starts when that drops.`;
            const was = sql("SELECT last_activity FROM handoffs WHERE id = :p1", [row.id])[0];
            if (!was || was.last_activity !== why) changed(jobs.update(sql, row.id, { last_activity: why }));
            continue;
          }
          const after = jobs.update(sql, row.id, {
            state: "failed",
            reply: `Delphi stopped this one. ${hourlyLimit} jobs have already finished in this project in the last hour, which usually means agents are handing work back and forth. Nothing is lost: reply to it to run it again.`,
          }, { from: "queued" });
          changed(after);
          continue;
        }
        begin(row.id);
      }
    } catch (error) {
      log("dispatch pass", error);
    } finally {
      ticking = false;
    }
  }

  function begin(id) {
    const claimed = jobs.update(sql, id, { state: "running", runner_pid: pid, runner_host: host, agent_pid: null }, { from: "queued" });
    if (!claimed) return;
    // A job approved before approvals recorded the harness row is held to
    // the row as it is when it first starts.
    if (!sql("SELECT harness_hash FROM handoffs WHERE id = :p1", [claimed.id])[0].harness_hash) {
      jobs.update(sql, claimed.id, { harness_hash: jobs.harnessHash(sql, claimed.harness) });
    }
    // The entry is this turn's identity. A turn abandoned at the hard deadline
    // may still finish later, after the job was replied to and is running
    // again under a new entry; nothing it does then may touch that one.
    const entry = { id: claimed.id, harness: claimed.harness, taskId: claimed.task_id, stop: null, stopReason: null, stoppedBy: null, timer: null, lastPing: 0, abandoned: false };
    live.set(claimed.id, entry);
    changed(claimed);
    entry.promise = run(claimed, entry)
      .catch((error) => end(entry, { state: "failed", reply: `Delphi could not run this job: ${error.message}` }))
      .finally(() => {
        clearTimeout(entry.timer);
        if (live.get(entry.id) === entry) live.delete(entry.id);
        soon();
      });
  }

  /** Ends a turn. Conditional on the job still running, so a quit that already wrote it is not written twice. */
  function end(entry, { state, reply: text, fields = {}, noteText = null }) {
    if (entry.abandoned || live.get(entry.id) !== entry) return null;
    const after = jobs.update(sql, entry.id, { ...fields, state, reply: text }, { from: "running" });
    if (!after) return null;
    audit(after.id, state.replace(/_/g, " "), after.request);
    note(after.task_id, noteText || `Job ${after.id} ${state === "failed" ? "failed" : state.replace(/_/g, " ")}: ${text}`);
    changed(after);
    try { onFinished(after); } catch (error) { log("job finished hook", error); }
    return after;
  }

  function activity(entry, action) {
    if (entry.abandoned) return;
    try {
      if (action.type === "usage") {
        // premiumRequests is Copilot's, from its result line, once per turn
        // (one process); summed, like the tokens, over a job's turns.
        const premium = typeof action.premiumRequests === "number" && Number.isFinite(action.premiumRequests) ? action.premiumRequests : null;
        sql(`UPDATE handoffs SET tokens_in = COALESCE(tokens_in, 0) + :p1, tokens_out = COALESCE(tokens_out, 0) + :p2,
               cost_usd = CASE WHEN :p3 IS NULL THEN cost_usd ELSE COALESCE(cost_usd, 0) + :p3 END,
               premium_requests = CASE WHEN :p4 IS NULL THEN premium_requests ELSE COALESCE(premium_requests, 0) + :p4 END WHERE id = :p5`,
            [Number(action.input) || 0, Number(action.output) || 0, typeof action.cost === "number" ? action.cost : null, premium, entry.id]);
      } else if (action.type === "say" || action.type === "run" || action.type === "edited") {
        const text = action.type === "say" ? firstLine(action.text) : action.type === "run" ? `$ ${firstLine(action.command)}` : `edited ${action.path}`;
        sql("UPDATE handoffs SET last_activity = :p1, updated_at = datetime('now') WHERE id = :p2", [text, entry.id]);
      } else return;
      // At most once a second per job: a stream of tool calls is not a stream of repaints.
      const now = Date.now();
      if (now - entry.lastPing > 1000) { entry.lastPing = now; changed(jobs.get(sql, entry.id)); }
    } catch (error) { log("job activity", error.message); }
  }

  function ensureTask(job, project) {
    if (job.task_id) return job.task_id;
    const title = firstLine(job.request, 120) || `Job ${job.id}`;
    const row = sql(`INSERT INTO tasks (project_id, title, detail, priority, source) VALUES (:p1, :p2, :p3, 'med', :p4) RETURNING id`,
                    [project.id, title, String(job.request), job.requested_by || "delphi"])[0];
    sql("INSERT INTO status_events (task_id, status, actor) VALUES (:p1, 'todo', :p2)", [row.id, job.requested_by || "delphi"]);
    sql(`INSERT INTO audit (action, entity, entity_id, summary, label) VALUES ('create', 'task', :p1, :p2, :p3)`,
        [row.id, `created for job ${job.id}, which had no task (by delphi)`, title]);
    return Number(row.id);
  }

  function startTask(taskId, actor) {
    const t = sql("UPDATE tasks SET status = 'doing', updated_at = datetime('now') WHERE id = :p1 AND status = 'todo' RETURNING id, title", [taskId])[0];
    if (t) sql("INSERT INTO status_events (task_id, status, actor) VALUES (:p1, 'doing', :p2)", [taskId, actor]);
  }

  function sheetText(taskId) {
    const store = tool;
    const ledger = store.read(taskId, { mode: "ledger" }).entries || [];
    const tail = store.read(taskId, { mode: "tail", n: SHEET_TAIL }).entries || [];
    const byId = new Map();
    for (const e of [...ledger, ...tail]) byId.set(e.id, e);
    const text = fmt.format({ entries: [...byId.values()].sort((a, b) => a.id - b.id) }, { clean: true }).trim();
    return text.length > MAX_BRIEF_SHEET ? `[older entries cut]\n${text.slice(-MAX_BRIEF_SHEET)}` : text;
  }

  function brief({ job, task, project, label, actor, workbench, cwd, followup }) {
    const lines = [
      `You are ${label}, running job ${job.id} for Delphi on task ${task.id}: ${task.title} (project ${project.name}).`,
      `${job.requested_by ? `${job.requested_by} asked for it` : "It was asked for"}${job.approved_by ? `, and ${job.approved_by} approved it` : ""}.`,
      "",
      "## What is asked",
      String(job.request).trim(),
    ];
    if (job.context && job.source !== "queue") lines.push("", "Context:", typeof job.context === "string" ? job.context : JSON.stringify(job.context, null, 2));
    if (task.detail && String(task.detail).trim() && String(task.detail).trim() !== String(job.request).trim()) {
      lines.push("", "## The task", String(task.detail).trim());
    }
    const sheet = sheetText(task.id);
    lines.push("", "## The task's Sheet",
      "Its ledger and latest entries, oldest first. A line starting > is a person, @ an agent, $ a command, ! a note, ? a question and = its answer.",
      "", sheet || "(Nothing on the Sheet yet.)");
    lines.push("", "## Where you are working");
    if (workbench) {
      lines.push(
        `This folder (${cwd}) is the task's Workbench: its own copy of the repository on the branch ${workbench.branch}, so nothing you do here touches anyone else's work.`,
        "Change files only here. Do not switch branches, push, or remove the folder. Commit on this branch if you can, or leave the changes uncommitted: a person reviews the Workbench and finishes it either way.");
    } else {
      lines.push(`You are in the project's folder (${cwd}) to read and answer. Do not change files; this job only reads.`);
    }
    lines.push("", "## How to finish",
      `What you say, the commands you run and the files you edit are written onto the task's Sheet as you go, as ${actor}. Do not copy your reply into it with sheet_append.`,
      "If you need a decision from a person, ask it with sheet_ask and end your turn: the job waits for them, and you are resumed with the answer.",
      "Your final message is the record: what you found or changed, how you checked it, and anything the next person needs. Use sheet_promote on anything they should read first.");
    if (followup) lines.push("", "## Since then", followup);
    return lines.join("\n");
  }

  async function run(job, entry) {
    const fail = (reason) => end(entry, { state: "failed", reply: reason });
    const followup = job.followup || null;
    if (followup) jobs.update(sql, job.id, { followup: null });

    const row = sql("SELECT * FROM harnesses WHERE key = :p1", [job.harness])[0];
    if (!row || !Number(row.enabled)) {
      return fail(`There is no agent called "${job.harness}" turned on here. Turn it on in Delphi's Settings, under Agents, then reply to this job.`);
    }
    const base = ADAPTER_BY_PARSER[row.parser];
    if (!base) return fail(`${row.label} speaks a format Delphi cannot follow as a job (${row.parser}). Jobs run Claude Code, Codex or Copilot.`);
    const adapter = { ...base, harnessKey: row.key, label: row.label || base.label };
    const label = adapter.label;
    const project = projectRow(job.project_id);
    if (!project) return fail(`Its project (${job.project_id}) no longer exists.`);
    const problem = jobs.folderProblem(sql, project.id);
    if (problem) return fail(problem);

    // Approved, and allowed or not to run unguarded, as a job of this project;
    // so it runs in this project or not at all. A row written before that was
    // checked at the door is caught here.
    if (job.task_id) {
      try { jobs.projectFor(sql, { projectId: project.id, taskId: job.task_id }); } catch (error) { return fail(error.message); }
    }
    const taskId = ensureTask(job, project);
    entry.taskId = taskId;
    const actor = job.actor || `${row.key}:job-${job.id}`;
    job = jobs.update(sql, job.id, { task_id: taskId, actor });
    startTask(taskId, actor);

    let cwd;
    let workbench = null;
    if (job.kind === "do") {
      if (!benches) return fail("This Delphi cannot start Workbenches, so it cannot run a job that changes code.");
      let made;
      try {
        made = await benches.start(taskId, { runSetup: true, background: false });
      } catch (error) {
        return fail(`A job that changes code runs only in its task's own Workbench, and task ${taskId}'s could not be started: ${error.message}`);
      }
      const wb = made.workbench;
      if (wb.state === "parked") return fail(`Task ${taskId}'s Workbench is parked: a person set it aside. Resume it, then reply to this job.`);
      if (wb.state === "closing") return fail(`Task ${taskId}'s Workbench is being put away (a Finish or Discard). A person decides what happens to it.`);
      if (wb.state === "missing") return fail(`Task ${taskId}'s Workbench folder (${wb.path}) is gone. Recreate it, then reply to this job.`);
      const setup = made.setup_entry;
      if (setup && setup.meta && setup.meta.state !== "ok") {
        return fail(`Setting up the Workbench failed (entry ${setup.id} on the Sheet). The folder is kept at ${wb.path}.`);
      }
      workbench = wb;
      cwd = wb.path;
    } else {
      cwd = jobs.readFolder(sql, project.id);
    }

    // Permissions, from the harness row's own template. See harness.js.
    let template;
    try { template = typeof row.args_json === "string" ? JSON.parse(row.args_json) : row.args_json; } catch { template = null; }
    if (!Array.isArray(template)) return fail(`${label}'s command line in Settings is not a list Delphi can read. Reset it in Settings, under Agents.`);
    const text = JSON.stringify(template);
    const values = { jobWrite: job.kind === "do", jobRead: job.kind === "ask", jobUnguarded: false };
    let unguarded = false;
    const allowUnguarded = Number(project.allow_unguarded) === 1;
    // Named exactly as the toggle in the project's settings reads.
    const setting = `turn on "Allow agents without Delphi's safety guard" in project ${project.name}'s settings`;
    if (job.kind === "do") {
      if (row.parser === "copilot-json") {
        if (!allowUnguarded) {
          return fail(`${label} would change code with nothing watching its commands: agent/guard.py is a Claude Code hook and cannot see ${label}'s. ` +
            `If you accept that, ${setting}, then reply to this job; or hand it to Claude Code or Codex.`);
        }
        if (!text.includes("{if:jobUnguarded}")) return fail(`${label}'s command line in Settings has no {if:jobUnguarded} group, so Delphi cannot give it tools. Reset it in Settings, under Agents.`);
        unguarded = true;
        values.jobUnguarded = true;
      } else {
        if (!text.includes("{if:jobWrite}")) {
          return fail(`${label}'s command line in Settings has no {if:jobWrite} group, so Delphi cannot give it tools that stay inside the Workbench. Reset it to the built-in definition in Settings, under Agents, then reply to this job.`);
        }
        if (row.parser === "claude-stream-json" && !guardStatus(cwd).installed) {
          if (!allowUnguarded) {
            return fail(`${label} would run commands in the Workbench, and agent/guard.py is not installed as its PreToolUse hook for Bash, so nothing would stop an irreversible one. ` +
              `Install the guard (the Safety section of AGENTS.md), or ${setting}, then reply to this job.`);
          }
          unguarded = true;
        }
      }
    }

    job = jobs.update(sql, job.id, { cwd, workbench_id: workbench ? workbench.id : null, unguarded: unguarded ? 1 : 0, turns: (job.turns || 0) + 1 });
    if (entry.stopReason) return end(entry, { state: "stopped", reply: `Stopped by ${entry.stoppedBy || "you"} before it started.` });

    const task = sql("SELECT * FROM tasks WHERE id = :p1", [taskId])[0];
    if (!followup) {
      note(taskId, `Job ${job.id} started: ${label} ${job.kind === "do" ? `changing code in the Workbench at ${cwd} on ${workbench.branch}` : `reading in ${cwd}`}, as ${actor}.`);
    }
    if (unguarded) {
      note(taskId, `Job ${job.id} is running unguarded: agent/guard.py cannot see ${label}'s commands here, and project ${project.name} allows unguarded agents.`);
    }

    const client = storeClient(makeSheetStore({ sql, actor, authorType: "agent" }));
    const firstEntry = Number(sql("SELECT COALESCE(MAX(id), 0) AS n FROM comments", [])[0].n);
    // The binary itself, resolved once here and spawned by that path, so what
    // was checked is what runs.
    const command = jobCommand(row);
    if (command.error) return fail(`Refusing to start ${label}: ${command.error}.`);
    const harnessRow = { label, command: command.path, args: template, parser: row.parser, mcp_style: row.mcp_style };
    const id = typeof dbId === "function" ? dbId() : dbId;
    let errorSeen = null;
    const turn = (resume, prompt) => runTurn({
      adapter, harness: harnessRow, prompt, cwd, resume, autoAllow: false, values, agentClient: client, taskId,
      projectId: project.id, actor, logDir, dbPath, dbId: id,
      env: { DELPHI_JOB: String(job.id), DELPHI_PROJECT: String(project.id), ...(dbPath ? { DELPHI_DB: dbPath } : {}), ...(id ? { DELPHI_DB_ID: id } : {}) },
      onStart: (control) => {
        entry.stop = control.stop;
        if (!entry.abandoned) { try { jobs.update(sql, job.id, { agent_pid: control.pid || null }); } catch {} }
        if (entry.stopReason) control.stop(entry.stopReason === "shutdown" ? "quit" : "stopped");
      },
      onAction: (action) => {
        if (action.type === "error") errorSeen = action.message;
        activity(entry, action);
      },
      onError: (error) => log(`job ${job.id} sheet`, error.message),
      // The real argv, every turn, just before it is spawned: a resume id and
      // the MCP wiring are only known here, and a group that needs one of them
      // is exactly where a bypass flag could hide from a check made earlier.
      checkArgv: (argv, c) => {
        // The harness row, read again now: if its command or argv template
        // changed since the job was approved, that approval does not cover it.
        const approved = sql("SELECT harness_hash FROM handoffs WHERE id = :p1", [job.id])[0];
        if (!approved || !approved.harness_hash || approved.harness_hash !== jobs.harnessHash(sql, row.key)) {
          return `Refusing to start ${label}: its definition in Settings changed after this job was approved, so the approval does not cover what would run now. Ask again to run it as it is.`;
        }
        const why = checkArgv(argv, { parser: row.parser, kind: job.kind, unguarded, ...c });
        return why ? `Refusing to start ${label} with ${why}: a job passes only flags Delphi knows keep it ${job.kind === "do" ? "inside its Workbench" : "read only"}. Check its command line in Settings, under Agents.` : null;
      },
    });

    const timeoutMs = (typeof jobTimeoutMs === "function" ? jobTimeoutMs() : jobTimeoutMs) || limits().timeoutMs;
    entry.timer = setTimeout(() => {
      entry.stopReason = entry.stopReason || "timeout";
      if (entry.stop) entry.stop("timeout");
      // A hard deadline. Something the agent started outside its process
      // group can hold its output open, and then the turn never ends; the job
      // is finished as failed and its slot freed whatever the pipes are doing.
      const hard = setTimeout(() => {
        if (!live.has(entry.id)) return;
        end(entry, { state: "failed", fields: { agent_pid: null }, reply: `timeout: stopped after ${Math.round(timeoutMs / 60000)} minutes, the longest a job may run, and its agent did not finish when told to.` });
        entry.abandoned = true;
        if (live.get(entry.id) === entry) live.delete(entry.id);
        soon();
      }, hardGraceMs);
      if (hard.unref) hard.unref();
    }, timeoutMs);
    if (entry.timer.unref) entry.timer.unref();

    const resume = followup && job.native_session ? job.native_session : null;
    const opening = () => brief({ job, task, project, label, actor, workbench, cwd, followup });
    // A reply that starts with a dash would be read as a flag by a CLI that
    // takes its prompt as an argument; said in words, it cannot be.
    const message = followup && /^\s*-/.test(followup) ? `The person says:\n${followup}` : followup;
    let result;
    try {
      result = await turn(resume, resume ? message : opening());
      // A session the harness no longer has fails before saying anything:
      // start fresh rather than leave the job stuck behind it.
      if (resume && result.code !== 0 && !result.written.length && !result.interrupted && !entry.stopReason) {
        result = await turn(null, opening());
      }
    } catch (error) {
      return fail(error.message);
    }
    clearTimeout(entry.timer);

    const said = result.written.filter((e) => e.kind === "say");
    const last = said.length ? said[said.length - 1].body : null;
    const fields = { native_session: result.sessionId || job.native_session || null, agent_pid: null };
    const where = workbench ? ` Its Workbench at ${workbench.path} (${workbench.branch}) is left as it is, for you to review, then Finish or Discard.` : "";

    if (entry.stopReason === "person") {
      return end(entry, { state: "stopped", fields, reply: `Stopped by ${entry.stoppedBy || "you"}.${where}` });
    }
    if (entry.stopReason === "timeout") {
      const minutes = Math.round(timeoutMs / 60000);
      return end(entry, { state: "failed", fields, reply: `Stopped after ${minutes} minutes, the longest a job may run (jobTimeoutMinutes in settings).${where}` });
    }
    if (entry.stopReason === "shutdown") {
      return end(entry, { state: "failed", fields, reply: "interrupted: Delphi quit while this job was running." });
    }
    if (!said.length && (result.code !== 0 || errorSeen)) {
      const tail = String(result.stderr || "").trim().split("\n").slice(-4).join("\n");
      return end(entry, { state: "failed", fields, reply: errorSeen || tail || `${label} exited with code ${result.code} and said nothing.` });
    }
    const asked = Number(sql(`SELECT COUNT(*) AS n FROM comments c WHERE c.task_id = :p1 AND c.kind = 'ask' AND c.author = :p2 AND c.id > :p3
                                 AND NOT EXISTS (SELECT 1 FROM comments d WHERE d.kind = 'decide' AND d.ref_id = c.id)`,
                             [taskId, actor, firstEntry])[0].n);
    if (asked) {
      return end(entry, { state: "waiting_on_human", fields, reply: last,
        noteText: `Job ${job.id} is waiting on a person: ${label} asked a question on this Sheet. Answer it, and the job carries on.` });
    }
    return end(entry, { state: "done", fields, reply: last || `${label} finished and said nothing.`,
      noteText: `Job ${job.id} done.${where}` });
  }

  return {
    tick, create, approve, reject, stop, reply, review, reorder, answered, get, list, recover, shutdown,
    running: () => [...live.keys()],
    /** Resolves once every job running now has ended. For tests and quitting. */
    idle: () => Promise.all([...live.values()].map((e) => e.promise)),
  };
}

module.exports = { createDispatcher, checkArgv, jobCommand, resolveCommand, installRoots, POLICY, storeClient, ADAPTER_BY_PARSER, DEFAULTS, BOUNDS };
