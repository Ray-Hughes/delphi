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
 * only reads, and only reads the project it was asked about. Its command line
 * may carry only flags on a short list, and what Delphi adds after that is
 * checked against exactly what Delphi meant to add. The tools it can see are an
 * allowlist rather than a list of denials, because Copilot's own saved approvals
 * (autoApprove in ~/.copilot/permissions-config.json) apply in prompt mode too,
 * and they cover web fetches and every MCP server the person has configured.
 * The folders it is let into must sit inside the project or the task's
 * Workbench, and never where keys live. It does get Delphi's own MCP server,
 * started read only and named apart from the person's own entry, so it can read
 * the same notes and pads the caller can and change none of them.
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
const binaries = require("./binaries");

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
// Long enough for a branch-sized diff, short enough that a hung CLI cannot hold
// the caller's turn, and the other agent's quota, for the rest of the afternoon.
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const SUPPORTED = new Set(["copilot-json"]);
// What an answer may be, before it is returned or kept on a Sheet. A reviewer
// that reads a log file back into its answer would otherwise put megabytes into
// the caller's context and into a comment every later get_task returns.
const ANSWER_CAP = 64 * 1024;
// What is held while reading the stream: the raw output (for a plain text run)
// and a line that has not ended yet. Past these the rest is dropped, so a CLI
// that prints without a newline cannot grow the server without bound.
const STREAM_CAP = 1024 * 1024;

// The injected server's name. Not "delphi": Copilot merges an added server into
// ~/.copilot/mcp-config.json by name, and that is where a person's own,
// read-write Delphi entry usually lives.
const SERVER_NAME = "delphi_readonly";

// The tools a server started read only offers, here rather than in the server
// so the server's refusal and Copilot's --available-tools are one list. Listed by
// what is allowed rather than what is not, so a tool added later is closed to
// the reviewer until someone decides otherwise.
const READ_ONLY_TOOLS = [
  "whoami", "list_projects", "list_tasks", "get_task", "queue_status",
  "sheet_read", "sheet_get", "workbench_status", "workbench_list",
  "list_scratchpads", "read_scratchpad", "handoff_status", "run_status", "run_list",
  "list_agents", "lock_status", "search", "get_note", "oracle_context", "oracle_entities",
  "oracle_ask", "list_flags", "recent_activity", "cost_ledger", "daily_brief", "related_notes", "weekly_review", "tidy_suggestions",
];

// Copilot's built-in tools that only read files: view reads one, glob finds
// them. Not grep or rg: they print what matches from every file under a folder
// without asking to read any one of them, so the read() denials below would not
// keep a .env in the project out of the answer. Nothing that writes, runs or
// fetches.
const COPILOT_READ_TOOLS = ["view", "glob"];
const AVAILABLE_TOOLS = [...COPILOT_READ_TOOLS, ...READ_ONLY_TOOLS.map((t) => `${SERVER_NAME}-${t}`)];

// Denied by name as well as left off the allowlist, because a denial wins over
// a saved approval and the allowlist is only as good as Copilot's filter.
// url is web fetch and any URL the shell would reach. The read() patterns stop
// the reviewer opening the usual key files inside a folder it was let into:
// a project folder often has a .env in it.
const DENY_TOOLS = [
  "write", "shell", "url",
  "read(.env)", "read(.env.*)", "read(.netrc)", "read(*.pem)", "read(*.key)", "read(id_*)",
];

// Tokens Copilot may need to sign in, and which it is told to keep out of the
// MCP servers it starts. Its documented order is COPILOT_GITHUB_TOKEN, GH_TOKEN,
// GITHUB_TOKEN; a person signed in through `copilot login` needs none of them.
const AUTH_TOKENS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
// The rest of what Copilot needs to find that sign-in: the host it signs in to
// and the folder its stored login lives in.
const AUTH_KEEP = new Set([...AUTH_TOKENS, "COPILOT_GH_HOST", "COPILOT_HOME"]);
// The caller's own identity, which is not the reviewer's. DELPHI_CLIENT in
// particular would unlock the command line's internal tools for it.
const CALLER_ONLY = ["DELPHI_CLIENT", "DELPHI_SESSION", "DELPHI_ACTOR", "DELPHI_AUTHOR_TYPE", "DELPHI_JOB"];

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

// --- where it may read -------------------------------------------------------

const realOf = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const within = (root, p) => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const strictlyWithin = (root, p) => p !== root && within(root, p);

// Folders anywhere in a path that hold keys. Matched as whole path segments.
const SECRET_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", "Keychains"]);
// Files that are keys by their name.
const SECRET_FILE = /^(\.env.*|\.netrc|id_.*|.*\.pem|.*\.key)$/i;

/**
 * The folders under home that are never read, whatever a project says: keys,
 * Copilot's own config and saved approvals, Claude's, and Delphi's data folder
 * with the database in it.
 */
function protectedFolders({ home, dataDir, dbPath }) {
  const list = [".ssh", ".aws", ".gnupg", path.join(".config", "gh"), ".copilot", ".claude", path.join("Library", "Keychains")]
    .map((rel) => path.join(home, rel));
  if (dataDir) list.push(dataDir);
  // The database itself as well, which DELPHI_DB can put outside the data folder.
  if (dbPath) list.push(dbPath);
  return list.map((p) => realOf(p) || path.resolve(p));
}

/** Why this real path may never be read, in words, or null. */
function secretReason(real, { home, dataDir, dbPath, isDir }) {
  const segments = real.split(path.sep);
  const bad = segments.find((s) => SECRET_SEGMENTS.has(s));
  if (bad) return `it is inside a ${bad} folder, where keys are kept`;
  if (segments.some((s, i) => s === ".config" && segments[i + 1] === "gh")) return "it is inside .config/gh, where GitHub's sign-in is kept";
  if (!isDir && SECRET_FILE.test(path.basename(real))) return `${path.basename(real)} is the kind of file that holds keys or passwords`;
  for (const folder of protectedFolders({ home, dataDir, dbPath })) {
    if (within(folder, real)) return `it is inside ${folder}, which a second opinion never reads`;
    // A folder above one of these would let the reviewer into it.
    if (isDir && strictlyWithin(real, folder)) return `${folder} is inside it, which a second opinion never reads`;
  }
  return null;
}

/**
 * Refuses a folder too wide to hand over whole: the root, a home folder, or
 * anything above one. Every folder here is let in with --add-dir, and those are
 * every key and token on the machine.
 */
function refuseBroad(real, home) {
  const homeReal = realOf(home) || home;
  if (real === path.parse(real).root || within(real, homeReal)) {
    throw new Error(`${real} is too wide to let a second opinion read: it would see everything under it, home folders included. Pass a folder inside the project instead.`);
  }
}

/**
 * cwd and the files, made absolute, followed through links, and checked; and
 * the folders the agent has to be let into to read them.
 *
 * roots are the folders it may read at all: the project's folders and the
 * task's Workbench. A missing file is an error here rather than a sentence in
 * the prompt, because an agent asked to review a file it cannot find will
 * review something else. Every check is on the real path, so a link inside the
 * project that points at ~/.ssh is judged as ~/.ssh.
 */
function resolveFiles(files, cwd, { roots = [], home = os.homedir(), dataDir = null, dbPath = null } = {}) {
  const realRoots = [...new Set(roots.map(realOf).filter(Boolean))];
  const realHome = realOf(home) || home;
  const realData = dataDir ? (realOf(dataDir) || path.resolve(dataDir)) : null;
  const realDb = dbPath ? (realOf(dbPath) || path.resolve(dbPath)) : null;
  const where = realRoots.length ? realRoots.join(", ") : "none";
  const judge = (real, isDir) => {
    if (!realRoots.some((root) => within(root, real))) {
      throw new Error(`${real} is outside the project's folders and the task's Workbench (${where}), so a second opinion may not read it. Copy what you want reviewed into the project, or pass the task it belongs to.`);
    }
    if (isDir) refuseBroad(real, realHome);
    const why = secretReason(real, { home: realHome, dataDir: realData, dbPath: realDb, isDir });
    if (why) throw new Error(`A second opinion may not read ${real}: ${why}.`);
  };

  cwd = realOf(cwd);
  if (!cwd) throw new Error("The folder to run in does not exist.");
  judge(cwd, true);
  const expand = (f) => (f === "~" || f.startsWith(`~${path.sep}`) ? path.join(realHome, f.slice(1)) : f);
  const list = (Array.isArray(files) ? files : files ? [files] : []).map((f) => path.resolve(cwd, expand(String(f))));
  const missing = list.filter((f) => !fs.existsSync(f));
  if (missing.length) throw new Error(`Cannot find ${missing.join(", ")}. Write what you want reviewed to a file inside the project first, then pass its path.`);
  const dirs = new Set();
  const real = [];
  for (const f of list) {
    const r = fs.realpathSync(f);
    const isDir = fs.statSync(r).isDirectory();
    judge(r, isDir);
    const dir = isDir ? r : path.dirname(r);
    if (!isDir) judge(dir, true);
    real.push(r);
    if (!within(cwd, dir)) dirs.add(dir);
  }
  return { cwd, files: real, dirs: [...dirs] };
}

// --- the command line ----------------------------------------------------------

/**
 * The person's own MCP servers, by name, so each can be switched off for this
 * run. Read from Copilot's user config and the two workspace files it names.
 * Only names that could be one are returned; an odd one is still kept out by
 * --available-tools, which names every tool the reviewer may see.
 */
function userMcpServers({ env = process.env, cwd, home = os.homedir() } = {}) {
  const copilotHome = env.COPILOT_HOME || path.join(home, ".copilot");
  const files = [path.join(copilotHome, "mcp-config.json")];
  if (cwd) files.push(path.join(cwd, ".mcp.json"), path.join(cwd, ".github", "mcp.json"));
  const names = new Set();
  for (const file of files) {
    let body;
    try { body = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    const servers = body && (body.mcpServers || body.servers);
    if (!servers || typeof servers !== "object") continue;
    for (const name of Object.keys(servers)) if (/^[A-Za-z0-9_.-]{1,100}$/.test(name)) names.add(name);
  }
  return [...names].sort();
}

/**
 * What Delphi adds after the row's own flags, in order.
 *
 * mcpFlags wire in the read only server; the rest close Copilot down to that
 * server and its own read tools. disable is the person's own MCP servers.
 */
function addedFlags({ cwd, dirs, mcpFlags, disable }) {
  const out = [...mcpFlags];
  if (mcpFlags.length) out.push("--allow-tool", SERVER_NAME);
  out.push("--available-tools", ...AVAILABLE_TOOLS);
  out.push("--disable-builtin-mcps");
  for (const name of disable) out.push("--disable-mcp-server", name);
  for (const rule of DENY_TOOLS) out.push("--deny-tool", rule);
  out.push(`--secret-env-vars=${AUTH_TOKENS.join(",")}`);
  // The system temp folder is let in by default, and it holds every other
  // session's files besides the one being reviewed.
  out.push("--disallow-temp-dir");
  out.push("--add-dir", cwd);
  for (const dir of dirs) out.push("--add-dir", dir);
  return out;
}

/**
 * Why Delphi's own additions are not exactly what it meant to add, or null.
 *
 * A second check rather than trust in addedFlags, so a later edit that adds a
 * flag there, or passes a folder it did not check, fails here and in the test
 * instead of reaching Copilot.
 */
function checkAdded(added, { cwd, dirs, mcpFlags, disable }) {
  const folders = new Set([cwd, ...dirs]);
  const seen = { deny: new Set(), available: false, builtin: false, temp: false, secrets: false, cwd: false };
  let i = 0;
  if (mcpFlags.length) {
    if (!mcpFlags.every((f, j) => added[j] === f)) return "Delphi's MCP wiring was not where it should be";
    i = mcpFlags.length;
  }
  for (; i < added.length; i++) {
    const flag = added[i];
    const next = () => added[++i];
    if (flag === "--allow-tool") { if (next() !== SERVER_NAME || !mcpFlags.length) return `--allow-tool ${added[i]}`; continue; }
    if (flag === "--available-tools") {
      const list = [];
      while (i + 1 < added.length && !String(added[i + 1]).startsWith("-")) list.push(next());
      if (JSON.stringify(list) !== JSON.stringify(AVAILABLE_TOOLS)) return "--available-tools with a list other than the read tools";
      seen.available = true;
      continue;
    }
    if (flag === "--disable-builtin-mcps") { seen.builtin = true; continue; }
    if (flag === "--disable-mcp-server") { if (!disable.includes(next())) return `--disable-mcp-server ${added[i]}`; continue; }
    if (flag === "--deny-tool") { const v = next(); if (!DENY_TOOLS.includes(v)) return `--deny-tool ${v}`; seen.deny.add(v); continue; }
    if (flag === `--secret-env-vars=${AUTH_TOKENS.join(",")}`) { seen.secrets = true; continue; }
    if (flag === "--disallow-temp-dir") { seen.temp = true; continue; }
    if (flag === "--add-dir") { const v = next(); if (!folders.has(v)) return `--add-dir ${v}`; if (v === cwd) seen.cwd = true; continue; }
    return flag;
  }
  if (!seen.available) return "no --available-tools";
  if (!seen.builtin) return "no --disable-builtin-mcps";
  if (!seen.temp) return "no --disallow-temp-dir";
  if (!seen.secrets) return "no --secret-env-vars";
  if (!seen.cwd) return "no --add-dir for the folder it runs in";
  const missing = DENY_TOOLS.filter((d) => !seen.deny.has(d));
  if (missing.length) return `no --deny-tool ${missing[0]}`;
  return null;
}

/**
 * The argv for one read-only run, or an error in words.
 *
 * Built from the harness row's own template, so a model or flag someone set in
 * Settings is honoured, then closed down. The row's own `--allow-tool delphi`
 * group is left out ({if:jobRead} false), because "delphi" is the person's own
 * server here, not the injected one.
 */
function plan({ row, prompt, cwd, dirs, mcpFlags, disable = [] }) {
  let template;
  try { template = typeof row.args_json === "string" ? JSON.parse(row.args_json) : row.args_json; } catch { template = null; }
  if (!Array.isArray(template)) {
    return { error: `${row.label}'s command line in Settings is not a list Delphi can read. Reset it in Settings, under Agents.` };
  }
  const rowArgv = harness.expand(template, { prompt, jobRead: false, autoAllow: false, jobUnguarded: false, jobWrite: false, mcpFlags: [] });
  const why = checkFlags(rowArgv, prompt);
  if (why) {
    return { error: `${row.label}'s command line in Settings passes ${why}, which a second opinion may not: it has to stay read only. Reset it in Settings, under Agents.` };
  }
  if (disable.includes(SERVER_NAME)) {
    return { error: `Copilot already has an MCP server called ${SERVER_NAME} in its own config, and Delphi's read only server would be merged into it. Rename or remove that entry, then ask again.` };
  }
  // Delphi's own wiring is added after the check, so what was checked is the
  // row and what is added is known, and then checked as exactly that.
  const added = addedFlags({ cwd, dirs, mcpFlags, disable });
  const wrong = checkAdded(added, { cwd, dirs, mcpFlags, disable });
  if (wrong) return { error: `Delphi built a second opinion command line it does not expect (${wrong}), so it was not run.` };
  return { argv: [...rowArgv, ...added] };
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

/**
 * The environment Copilot is started with: the caller's, without the caller's
 * Delphi identity, without Copilot's own switches (COPILOT_ALLOW_ALL=true
 * would approve every tool and trust the folder), and without any token but
 * the ones it signs in with.
 */
function childEnvFrom(env) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (CALLER_ONLY.includes(key)) continue;
    if (AUTH_KEEP.has(key)) { out[key] = value; continue; }
    if (/^COPILOT_/i.test(key) || /TOKEN/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

// --- what comes back -----------------------------------------------------------

/** text trimmed to about ANSWER_CAP bytes, marked when it was, and whether it was. */
function capAnswer(text, { already = false } = {}) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= ANSWER_CAP && !already) return { text, trimmed: false };
  // Cut on bytes, then drop a character the cut split in half.
  const kept = bytes > ANSWER_CAP ? Buffer.from(text, "utf8").subarray(0, ANSWER_CAP).toString("utf8").replace(/�+$/, "") : text;
  return { text: `${kept}\n\n[trimmed: the answer was longer than ${Math.round(ANSWER_CAP / 1024)} KB and the rest was dropped]`, trimmed: true };
}

// Shapes a token has when it is pasted whole: the list sheet/scrub.js keeps
// for everything Delphi sends out, so a shape added there is caught here too.
// Only the token shapes, not scrub's people's numbers or its context rules:
// this is a net for an answer that quoted a key file back, and a false match
// costs a word of a review.
const { SECRET_SHAPES } = require("../sheet/scrub");

/** The text with anything shaped like a token replaced, and how many were. */
function redact(text) {
  let count = 0;
  let out = String(text);
  for (const shape of SECRET_SHAPES) out = out.replace(shape, () => { count++; return "[redacted]"; });
  return { text: out, count };
}

// --- limits --------------------------------------------------------------------

/**
 * Records a second opinion starting, unless the hourly limit is reached, in one
 * statement: a count and an insert in two calls would let two servers on the
 * binary route both see eleven and both start. Returns the row id, or null when
 * the limit is reached. Rows older than a day are dropped first, because only
 * the last hour is ever counted.
 */
function claimHourly(sql, { limit, actor, agent, projectId, taskId }) {
  try { sql("DELETE FROM second_opinions WHERE started_at < datetime('now', '-1 day')", []); } catch {}
  const row = sql(`INSERT INTO second_opinions (actor, agent, project_id, task_id)
                   SELECT :p1, :p2, :p3, :p4
                    WHERE (SELECT COUNT(*) FROM second_opinions WHERE started_at > datetime('now', '-1 hour')) < :p5
                   RETURNING id`, [actor || null, agent, projectId || null, taskId || null, limit])[0];
  return row ? Number(row.id) : null;
}

/** Writes how a claimed second opinion ended. Never throws: the answer matters more. */
function finishHourly(sql, id, outcome) {
  if (!id) return;
  try { sql("UPDATE second_opinions SET finished_at = datetime('now'), outcome = :p1 WHERE id = :p2", [outcome, id]); } catch {}
}

/** The hourly limit from settings, a hand-edited one kept inside the range main.js enforces. */
function hourlyLimit(settings) {
  const { default: fallback, bounds: [min, max] } = harness.SECOND_OPINION_HOURLY;
  const value = settings ? settings.secondOpinionHourlyLimit : undefined;
  // Number(null) and Number("") are 0, which would turn the tool off for a
  // settings file that merely has the key blank.
  const n = value === null || value === undefined || value === "" ? NaN : Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// --- running it ------------------------------------------------------------------

// Runs still going, so a server that is told to stop takes them with it rather
// than leaving an agent running and its MCP file on disk. Copilot is spawned in
// its own process group so a stop reaches what it started; that same group is
// why a signal to the server alone never reaches it.
const live = new Set();
let hooked = false;
function hookExit() {
  if (hooked) return;
  hooked = true;
  const stopAll = () => { for (const stop of [...live]) stop(); };
  process.on("exit", stopAll);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const onSignal = () => {
      stopAll();
      // Die of the signal as the server would have without this, unless
      // something else in the process has its own plans for it.
      if (process.listenerCount(signal) === 1) {
        process.removeListener(signal, onSignal);
        try { process.kill(process.pid, signal); } catch { process.exit(1); }
      }
    };
    process.on(signal, onSignal);
  }
}

// One at a time per server. Each run is a whole agent session on someone's
// quota, and an agent told to ask for reviews will otherwise fan out.
let running = 0;
const MAX_RUNNING = 1;
/** Whether this server is already running one, for a caller that wants to refuse before claiming. */
const busy = () => running >= MAX_RUNNING;

/** The binary, checked the way the job dispatcher checks it. */
function findCommand(row, options) {
  return binaries.jobCommand(row, options);
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
 * wire Delphi's server in. `roots` are the folders it may read. `beforeStart`
 * is called once every check has passed, immediately before the spawn, and a
 * sentence it returns refuses the run (the hourly limit). Rejects with an Error
 * whose message says what to do.
 */
function run({ row, request, files = [], cwd, roots = [], dataDir = null, dbPath = null, home = os.homedir(), timeoutMs = DEFAULT_TIMEOUT_MS, mcp = null,
               env = process.env, spawnImpl = spawn, find = findCommand, beforeStart = null }) {
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

    let resolved;
    try { resolved = resolveFiles(files, cwd, { roots, home, dataDir, dbPath }); } catch (error) { reject(error); return; }
    cwd = resolved.cwd;

    if (running >= MAX_RUNNING) {
      reject(new Error(`${label} is already giving a second opinion for this session. Wait for that answer, then ask again; one runs at a time.`));
      return;
    }

    const command = find(row);
    if (!command || command.error) {
      reject(new Error(`Refusing to start ${label}: ${command ? command.error : `${label} is not installed, or is not on the PATH`}. Install it and sign in by running it once in a terminal, or fix it in Settings, under Agents.`));
      return;
    }

    let wiring = { flags: [], file: null };
    try {
      if (mcp) wiring = harness.mcpFlags(row.mcp_style, { ...mcp, serverName: SERVER_NAME });
    } catch (error) {
      reject(new Error(`Could not give ${label} Delphi's tools: ${error.message}`));
      return;
    }
    const cleanup = () => { if (wiring.file) { try { fs.unlinkSync(wiring.file); } catch {} } };

    const prompt = buildPrompt(request, resolved.files);
    const disable = userMcpServers({ env, cwd, home });
    const built = plan({ row, prompt, cwd, dirs: resolved.dirs, mcpFlags: wiring.flags, disable });
    if (built.error) { cleanup(); reject(new Error(built.error)); return; }

    const childEnv = childEnvFrom(env);
    let refused = null;
    try { refused = beforeStart ? beforeStart() : null; } catch (error) { refused = error.message; }
    if (refused) { cleanup(); reject(new Error(refused)); return; }

    const limit = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const started = Date.now();
    let child;
    try {
      // stdin closed: Copilot does not read a prompt from it in this mode, and
      // an open pipe is one more way for it to sit waiting for input.
      // Its own process group, so a stop reaches whatever it started too: an MCP
      // server it launched, or the real binary behind a shim, can otherwise hold
      // the output pipe open after the agent itself has gone.
      child = spawnImpl(command.path, built.argv, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (error) {
      cleanup();
      reject(new Error(`Could not start ${label}: ${error.message}`));
      return;
    }
    running++;

    let text = "";
    let last = null;
    let raw = "";
    let stderr = "";
    let parsed = false;
    let reported = null;
    let overflow = false;
    // A line too long to keep may have been the final message, so the last whole
    // one seen is no longer the answer; the deltas are.
    let dropped = false;
    const tools = [];
    const mapper = harness.MAPPERS[row.parser]((event) => {
      parsed = true;
      if (event.type === "text") { if (text.length <= ANSWER_CAP * 2) text += event.text; else overflow = true; }
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
    child.stdout.on("data", (chunk) => {
      if (raw.length < STREAM_CAP) raw += chunk; else overflow = true;
      buffer += chunk;
      let cut;
      while ((cut = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (line) read(line);
      }
      // A line that never ends is not going to parse; what was kept of it in
      // raw is all there will be.
      if (buffer.length > STREAM_CAP) { buffer = ""; overflow = true; dropped = true; }
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
    const timedOutError = () => new Error(`${label} did not answer within ${Math.round(limit / 1000)} seconds and was stopped. Ask about less at once, or pass a longer timeout_seconds (at most ${MAX_TIMEOUT_MS / 60000} minutes).`);
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      // A CLI that ignores SIGTERM still has to let go of the caller's turn,
      // and the answer is given even if something still holds the pipe open.
      setTimeout(() => kill("SIGKILL"), 3000).unref();
      setTimeout(() => finish(() => reject(timedOutError())), 5000).unref();
    }, limit);

    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      running--;
      clearTimeout(timer);
      live.delete(stopNow);
      cleanup();
      fn();
    };

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
      const whole = (parsed ? ((!dropped && last) || text) : raw).trim();
      const said = `${reported || ""}\n${stderr}\n${parsed ? "" : raw}`;
      if (code !== 0 || (!whole && reported)) {
        if (SIGNED_OUT.test(said)) {
          reject(new Error(`${label} is not signed in. Run ${row.command} once in a terminal and sign in, then ask again.`));
          return;
        }
        reject(new Error(`${label} stopped ${code === null ? `on ${signal}` : `with exit code ${code}`}${reported ? `: ${reported}` : ""}${tail(stderr) ? `\n${tail(stderr)}` : ""}`));
        return;
      }
      if (!whole) {
        reject(new Error(`${label} finished without saying anything.${tail(stderr) ? `\n${tail(stderr)}` : ""}`));
        return;
      }
      // A whole message is complete however much was dropped around it; the
      // stream is only short when the answer was taken from it.
      const capped = capAnswer(whole, { already: overflow && !(parsed && last && !dropped) });
      resolve({ agent: row.key, label, answer: capped.text, trimmed: capped.trimmed, seconds: Math.round(ms / 100) / 10, tools });
    }));
  });
}

module.exports = {
  run, busy, plan, checkFlags, checkAdded, addedFlags, buildPrompt, resolveFiles, findCommand, childEnvFrom, userMcpServers,
  capAnswer, redact, claimHourly, finishHourly, hourlyLimit,
  DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, ANSWER_CAP, SERVER_NAME, READ_ONLY_TOOLS, AVAILABLE_TOOLS, DENY_TOOLS, AUTH_TOKENS,
};
