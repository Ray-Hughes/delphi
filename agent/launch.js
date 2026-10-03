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

module.exports = { splitCommand, resolveBinary, guardStatus };
