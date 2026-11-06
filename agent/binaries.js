/**
 * Which binary Delphi may start as an agent, followed to the file it really is.
 *
 * Lifted out of agent/dispatch.js so the job dispatcher and second_opinion ask
 * the same question the same way. second_opinion once found its binary with a
 * bare PATH lookup, which skipped every check below: a `copilot` script earlier
 * on PATH, or a row pointed at a wrapper, ran as if it were Copilot. The
 * dispatcher lives inside the app's archive and the server cannot read it, so
 * the rules live here, in a module both can load (`files` and OUTSIDE_TOO, per
 * CLAUDE.md), rather than in two copies that would drift apart.
 *
 * Dependency-free beyond harness.js and launch.js, which are shared the same way.
 */

const fs = require("fs");
const path = require("path");
const harness = require("../harness");
const launch = require("./launch");

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

module.exports = { jobCommand, resolveCommand, installRoots, swappable, BINARY, PACKAGE };
