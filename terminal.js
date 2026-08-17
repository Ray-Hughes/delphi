// Running commands in a project's folder.
//
// This is the other half of a chat session: the model suggests something, and
// the person wants to run it in the same folder without leaving the window. It
// lives in the main process for the same reason ai.js does, and speaks the same
// language: you hand it a callback and it hands you back a stream of events.
//
// It is a command runner, not a terminal emulator. Be clear about the
// difference, because the two look identical until they do not.
//
// A real terminal gives the child a pseudo-terminal: a kernel device that
// pretends to be a screen and a keyboard. Programs ask it how wide the window
// is, switch it into raw mode, and draw over the top of themselves. Getting one
// in Node means node-pty, which is a native module, and this app has no native
// modules and no runtime dependencies at all. That is a deliberate line, stated
// in the README: nothing to compile, nothing to rebuild when Electron updates.
// One npm package here would cost more than the feature is worth.
//
// So the child gets pipes instead, and the consequences are honest ones:
//
//   - vim, top, less, htop and anything else full-screen will not work. They
//     either refuse to start ("not a terminal") or emit escape sequences into
//     the output with nothing to interpret them.
//   - Anything that reads a password straight from the terminal device, sudo
//     included, will not see what `write` sends. Line-buffered readers will.
//   - Most tools notice there is no terminal and turn colour off by themselves,
//     so output arrives plainer than it would in Terminal.app.
//   - There is no window size, so nothing reflows.
//
// What does work is the overwhelming majority of what anyone actually types at
// a prompt: git, npm, make, tests, greps, scripts. That is the trade.
//
// Events, matching the shape ai.js established:
//
//   { type: "output", text }            a piece of the merged output
//   { type: "exit",   code, signal }    the command finished or was killed
//   { type: "error",  message }         it never started, or the shell is gone

const { spawn } = require("child_process");
const os = require("os");
const path = require("path");

// Enough to scroll back through, small enough that `yes` cannot eat the app.
// Only the retained copy is capped; every byte is still emitted as it arrives,
// and what the window does with it is the window's business.
const MAX_RETAINED = 200 * 1024;

// How long a process gets to handle SIGTERM before it is killed outright.
const KILL_GRACE_MS = 3000;

// Shells whose -c argument is POSIX shell script, which is what the stderr
// merge below assumes. fish and nushell are neither, so they are left alone.
const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "ksh", "dash", "ash"]);

const live = new Map();

// ---------------------------------------------------------------------------
// Which shell, and how to hand it the command
//
// A login shell, because an app launched from Finder or the Start menu inherits
// almost none of the PATH a terminal has, and a version manager puts node, ruby
// and the rest somewhere only the profile knows about. ai.js has to do the same
// dance to find the Claude binary at all.
//
// Login but not interactive, which is a compromise rather than a clean win and
// worth stating as one. A login shell runs the profile, and a profile that
// starts ssh-agent prints "Agent pid 21976" before the command says anything.
// Since every command gets its own shell, that greeting arrives at the top of
// every command's output, not once per session. ai.js hits the same thing and
// works around it by taking the last line, which is not available here because
// the output is the point.
//
// Going interactive as well would read .zshrc and pick up aliases, at the cost
// of whatever else that file prints on top of the profile's greeting. Aliases
// are not worth a second source of noise, so they lose.

function shellFor(preferred) {
  if (process.platform === "win32") {
    // ComSpec rather than a hardcoded path because a locked-down Windows install
    // does not always keep cmd.exe where you expect it.
    return { file: preferred || process.env.ComSpec || "cmd.exe", kind: "cmd" };
  }
  const file = preferred || process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return { file, kind: POSIX_SHELLS.has(path.basename(file)) ? "posix" : "other" };
}

/**
 * The arguments that run one command string.
 *
 * The command is shell script written by the person using the app. That is the
 * whole feature, so there is nothing here that tries to sanitise it, and
 * pretending otherwise would only make the code look safer than it is. What
 * this does do is refuse to add any surface beyond that one string: no second
 * interpolated value, no assembled pipeline, nothing quoted into place.
 *
 * `exec 2>&1` is the exception, and it is a whole statement rather than
 * anything wrapped around the command. It points the shell's own stderr at the
 * stdout pipe before the command runs, so both streams are one file descriptor
 * from that point on and the kernel interleaves them in true order. Merging two
 * separate pipes in JavaScript cannot do that: each pipe buffers independently,
 * so a warning written before a line of output routinely arrives after it, and
 * a terminal that reorders the output is worse than one that is plain.
 */
function argsFor(kind, command) {
  if (kind === "cmd") return ["/d", "/s", "/c", command];
  if (kind === "posix") return ["-lc", `exec 2>&1\n${command}`];
  return ["-lc", command];
}

// ---------------------------------------------------------------------------
// Sessions

/**
 * Starts a command.
 *
 * `id` is the caller's, one per chat session, so several projects can be
 * running something at once and each stream of events knows where it belongs.
 * `timeoutMs` defaults to none: a build that takes twenty minutes is not a
 * hung one, and a person watching the output can always press stop.
 */
function start({ id, cwd, command, shell, timeoutMs = 0 }, emit) {
  const send = guarded(emit);

  if (!id) {
    send({ type: "error", message: "A terminal needs an id" });
    return null;
  }
  if (!command || !String(command).trim()) {
    send({ type: "error", message: "Nothing to run" });
    return null;
  }
  // Same reasoning as the one-turn-at-a-time guard in main.js: two commands
  // sharing an id would interleave into one transcript with no way to tell
  // whose output was whose, and one exit event would be attributed to the
  // wrong command.
  if (live.has(id)) {
    send({ type: "error", message: "Something is already running in this terminal" });
    return null;
  }

  const { file, kind } = shellFor(shell);
  // Resolved here rather than left to the child, because a packaged app's
  // working directory is wherever the launcher happened to put it, so a
  // relative path would land somewhere different in development and in a build.
  const dir = cwd ? path.resolve(cwd) : os.homedir();

  let child;
  try {
    child = spawn(file, argsFor(kind, String(command)), {
      cwd: dir,
      // stdin stays open so `write` has somewhere to go.
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX only. This makes the shell a process group leader, which is what
      // makes it possible to kill everything it spawned later. On Windows it
      // would let the child survive the app, and taskkill /T walks the tree
      // without it.
      detached: process.platform !== "win32",
      // Node would otherwise re-quote the command, and cmd.exe /s already
      // treats everything after /c as the literal command line. Quoting it
      // twice is how a command with quotes in it turns into something else.
      windowsVerbatimArguments: process.platform === "win32",
      windowsHide: true,
    });
  } catch (error) {
    // A missing shell or an unreadable cwd throws here rather than arriving as
    // an error event, and dying inside an IPC handler tells the person nothing.
    send({ type: "error", message: String(error.message || error) });
    return null;
  }

  const session = {
    id,
    command: String(command),
    cwd: dir,
    shell: file,
    child,
    pid: child.pid,
    startedAt: Date.now(),
    retained: "",
    dropped: 0,
    announcedDrop: false,
    finished: false,
    killTimer: null,
    timeoutTimer: null,
  };
  live.set(id, session);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => onOutput(session, chunk, send));
  // Only reached when the shell is not a POSIX one and the merge above was
  // skipped. Ordering against stdout is best effort in that case.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => onOutput(session, chunk, send));

  // A closed stdin is ordinary here: the command may simply not read any, and
  // an unhandled EPIPE would take the app down with it.
  child.stdin.on("error", () => {});

  child.on("error", (error) => {
    // A folder that no longer exists fails as "spawn /bin/zsh ENOENT", which
    // reads as a missing shell and sends whoever sees it looking in the wrong
    // place. The shell was found; the folder was not.
    const message = error.code === "ENOENT" && cwd
      ? `That folder is not there any more: ${dir}`
      : String(error.message || error);
    send({ type: "error", message });
    finish(session, null, null, send);
  });
  child.on("close", (code, signal) => finish(session, code, signal, send));

  if (timeoutMs > 0) {
    session.timeoutTimer = setTimeout(() => {
      send({ type: "error", message: `Stopped after ${Math.round(timeoutMs / 1000)}s without finishing` });
      stop(id);
    }, timeoutMs);
    // Nothing should be held open just because a command is being watched.
    if (session.timeoutTimer.unref) session.timeoutTimer.unref();
  }

  return { id, pid: child.pid, cwd: dir, shell: file, command: session.command };
}

/**
 * Emits a chunk and keeps a bounded copy.
 *
 * The retained copy exists so a window that was closed and reopened, or a tab
 * switched away from, can be shown what it missed. Trimming from the front
 * keeps the recent end, which is the end anyone wants; the alternative, capping
 * by refusing new output, would freeze the terminal at the least useful moment.
 */
function onOutput(session, chunk, send) {
  const text = String(chunk);
  session.retained += text;
  if (session.retained.length > MAX_RETAINED) {
    const overflow = session.retained.length - MAX_RETAINED;
    session.retained = session.retained.slice(overflow);
    session.dropped += overflow;
    if (!session.announcedDrop) {
      session.announcedDrop = true;
      // Said out loud in the output itself, because output that quietly
      // disappears is how someone concludes a command produced nothing.
      send({
        type: "output",
        text: `\n[delphi: this command has produced more than ${Math.round(MAX_RETAINED / 1024)}KB, so earlier output is no longer kept]\n`,
        dropped: session.dropped,
      });
    }
  }
  send(session.dropped ? { type: "output", text, dropped: session.dropped } : { type: "output", text });
}

/** Emits the exit event once, whatever route got us here. */
function finish(session, code, signal, send) {
  if (session.finished) return;
  session.finished = true;
  clearTimeout(session.killTimer);
  clearTimeout(session.timeoutTimer);
  live.delete(session.id);
  send({
    type: "exit",
    code: code === null || code === undefined ? null : code,
    signal: signal || null,
    dropped: session.dropped,
    ms: Date.now() - session.startedAt,
  });
}

/**
 * Sends text to a running command's stdin.
 *
 * Worth knowing what this can and cannot answer. A program reading lines from
 * stdin, which is most scripts and anything piped-friendly, sees this. A
 * program that opens the terminal device directly to ask for a password does
 * not, because there is no terminal device to open. Newlines are the caller's
 * to include, since some prompts want one and some want a single keystroke.
 */
function write(id, text) {
  const session = live.get(id);
  if (!session || !session.child.stdin || !session.child.stdin.writable) return false;
  session.child.stdin.write(String(text));
  return true;
}

/**
 * Stops one command, and everything it started.
 *
 * Killing the child alone is not enough and the difference shows up
 * immediately: `npm test` is a shell that spawned node, and signalling the
 * shell leaves node running with nowhere to send its output. The negative pid
 * signals the whole process group, which is the group created by `detached`
 * above. Windows has no such thing, so taskkill walks the process tree instead.
 *
 * SIGTERM first so a test runner can tear down what it made, then SIGKILL, so
 * that stop always means stopped even for something that traps signals.
 */
function stop(id, { force = false } = {}) {
  const session = live.get(id);
  if (!session) return false;

  if (process.platform === "win32") {
    // /T for the tree, /F because a console app without a console window has no
    // way to receive the polite request.
    spawn("taskkill", ["/pid", String(session.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
      .on("error", () => {});
    return true;
  }

  signalGroup(session, force ? "SIGKILL" : "SIGTERM");
  if (force) return true;

  session.killTimer = setTimeout(() => {
    if (live.has(id)) signalGroup(session, "SIGKILL");
  }, KILL_GRACE_MS);
  if (session.killTimer.unref) session.killTimer.unref();
  return true;
}

function signalGroup(session, signal) {
  try {
    process.kill(-session.pid, signal);
  } catch {
    // ESRCH means the group is already gone, which is the outcome we wanted.
    // Anything else is worth one more attempt at the process on its own, in
    // case the group never formed.
    try { session.child.kill(signal); } catch { /* already dead */ }
  }
}

/**
 * Stops everything, for app shutdown.
 *
 * SIGKILL rather than the graceful path, because by the time the window is
 * closing there is no guarantee the event loop lives long enough to run the
 * three second escalation, and a detached process group outlives the app that
 * made it. A stray `npm run dev` still holding port 3000 after Delphi has quit
 * is the failure this avoids.
 */
function stopAll() {
  const ids = [...live.keys()];
  for (const id of ids) stop(id, { force: true });
  return ids.length;
}

/** What is running right now. */
function sessions() {
  return [...live.values()].map((s) => ({
    id: s.id,
    pid: s.pid,
    command: s.command,
    cwd: s.cwd,
    shell: s.shell,
    startedAt: s.startedAt,
    ms: Date.now() - s.startedAt,
    bytes: s.retained.length,
    dropped: s.dropped,
    output: s.retained,
  }));
}

/**
 * Wraps the caller's emit so a dead window cannot break the child.
 *
 * main.js already checks for a destroyed frame before sending, but a throw from
 * anywhere in there would land inside a stdout handler, where there is nothing
 * to catch it and the process is left running with no one listening.
 */
function guarded(emit) {
  return (event) => {
    try {
      if (typeof emit === "function") emit(event);
    } catch { /* the window went away mid-command */ }
  };
}

module.exports = { start, write, stop, stopAll, sessions };
