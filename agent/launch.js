/**
 * Starting other programs safely: argv from a command line, finding a binary,
 * and whether agent/guard.py is wired in.
 *
 * Shared by the queue runner, `delphi chat` and sheet/run.js, which all spawn
 * something on a person's behalf and all have to get the same three things
 * right. Lifted out of queue_runner.js unchanged. No dependencies, because the
 * runner and the command line run under a plain Node.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

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

/**
 * Where guard.py is, or null.
 *
 * The copy in the packaged app's resources first, because python cannot read
 * inside app.asar. A checkout has it beside this file. DELPHI_GUARD is for the
 * tests, which need to point at a guard that is not there.
 */
function guardPath() {
  if (process.env.DELPHI_GUARD !== undefined) {
    const forced = path.resolve(process.env.DELPHI_GUARD);
    return isFile(forced) ? forced : null;
  }
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "agent", "guard.py"));
  candidates.push(path.join(__dirname, "guard.py"));
  return candidates.find(isFile) || null;
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

// A version manager's shim picks a python by reading config in the current
// directory, and inside a checkout that pins nothing it fails with "No version
// is set for command python3". That would make the guard look broken in exactly
// the folders people run commands from, so a shim is never taken, even off PATH.
const SHIM = /[\\/](?:\.asdf|\.pyenv|\.rtx|mise|shims)[\\/]/;

let pythonCache;

/**
 * A python3 that actually runs, or null.
 *
 * Proved by running --version rather than trusted because it exists: macOS
 * ships /usr/bin/python3 as a stub that offers to install the developer tools,
 * and a shim on PATH exists and still fails. DELPHI_PYTHON, when set, is the
 * only candidate, so a test can make python missing on purpose.
 */
function findPython() {
  if (process.env.DELPHI_PYTHON !== undefined) return provePython(process.env.DELPHI_PYTHON);
  if (pythonCache !== undefined) return pythonCache;
  const candidates = process.platform === "win32"
    ? []
    : ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"];
  const names = process.platform === "win32" ? ["python3.exe", "python.exe"] : ["python3"];
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) candidates.push(path.join(dir, name));
  }
  pythonCache = null;
  for (const candidate of candidates) {
    if (SHIM.test(candidate)) continue;
    const proved = provePython(candidate);
    if (proved) { pythonCache = proved; break; }
  }
  return pythonCache;
}

function provePython(candidate) {
  if (!candidate || SHIM.test(candidate) || !isFile(candidate)) return null;
  const r = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 10000 });
  return r.status === 0 && /Python 3/.test(`${r.stdout}${r.stderr}`) ? candidate : null;
}

/**
 * Asks guard.py whether a shell command may run.
 *
 * Fails closed. guard.py itself fails open on a payload it cannot parse, because
 * it sits in an agent's hook chain where refusing every tool call is the worse
 * outcome. Here nothing waits on the answer but the command, so when the guard
 * cannot give one (no python, no guard.py, a crash) the answer is no, with the
 * reason said plainly.
 *
 * Resolves { allowed, reason, unavailable }. Never rejects.
 */
function guardCheck(command) {
  return new Promise((resolve) => {
    const guard = guardPath();
    if (!guard) return resolve({ allowed: false, unavailable: true, reason: "guard.py was not found" });
    const python = findPython();
    if (!python) return resolve({ allowed: false, unavailable: true, reason: "no working python3 was found" });

    let child;
    try {
      child = spawn(python, [guard], { stdio: ["pipe", "ignore", "pipe"] });
    } catch (error) {
      return resolve({ allowed: false, unavailable: true, reason: `python3 would not start: ${error.message}` });
    }
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done({ allowed: false, unavailable: true, reason: "the guard took longer than 15 seconds" });
    }, 15000);
    function done(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => done({ allowed: false, unavailable: true, reason: `python3 would not start: ${error.message}` }));
    child.on("close", (code) => {
      if (code === 0) return done({ allowed: true, reason: null, unavailable: false });
      const first = stderr.split("\n").map((l) => l.trim()).find(Boolean) || "";
      if (code === 2) {
        return done({ allowed: false, unavailable: false, reason: first.replace(/^Blocked by guard:\s*/, "") || "refused" });
      }
      done({ allowed: false, unavailable: true, reason: `guard.py exited ${code}${first ? `: ${first}` : ""}` });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ tool_name: "Bash", tool_input: { command: String(command) } }));
  });
}

module.exports = { splitCommand, resolveBinary, guardStatus, guardPath, findPython, guardCheck };
