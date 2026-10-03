/**
 * Running a command as a `$ ` entry on a task's Sheet.
 *
 * The entry is written before anything runs, so a command that hangs, crashes
 * the caller or is refused still leaves a record of having been asked for. The
 * guard is asked next, for every run, a person's or an agent's alike, and there
 * is no flag to skip it: if the guard blocks something that genuinely needs
 * doing, a person runs it in a normal terminal, which is the guard's own rule.
 *
 * `store` is anything with append(fields) and update(id, fields), sync or
 * async: the in process sheet store in the app, or the MCP client in the CLI.
 * That is what lets one runner serve both without knowing which it has.
 *
 * No pty. A Sheet is a record, not a terminal emulator, so interactive
 * programs are out of scope; stdin is closed.
 *
 * An entry must never be left "running" for good, because a running entry is
 * a promise that an answer is coming. Hence three rules:
 *
 * - The run ends when the shell exits, not when its pipes close. A background
 *   job (`cmd &`) inherits the pipes and can hold them open for hours; after a
 *   short grace for the last output, the pipes are cut and the entry finished.
 * - An interrupt escalates. The first sends SIGINT to the whole process group;
 *   a second, or three seconds of being ignored, sends SIGKILL. A SIGINT trap or
 *   a background job (which a non-interactive shell starts with SIGINT ignored)
 *   cannot keep it alive.
 * - The runner's pid and host go in meta, so a run whose runner died without
 *   finishing it (kill -9, a crash, a closed laptop) is found by
 *   sheet/store.js sweepLost and marked fail:lost.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const launch = require("../agent/launch");
const fmt = require("./format");

// Output this short is shown inline under the command, in meta.out, rather
// than behind "show output". Not the body: the body is the command, and mixing
// the two would break rerun and the text format's parse.
const SHORT_OUTPUT_LINES = 5;
// A five line answer can still be a megabyte of minified JSON, which is not
// something to inline into every read of the Sheet.
const SHORT_OUTPUT_BYTES = 8 * 1024;
// How long after the shell exits its output may still be arriving. Long enough
// for a pipe to drain, short enough that `cmd &` does not hold the entry.
const EXIT_GRACE_MS = 300;
// How long an interrupted command gets to stop on its own before it is killed.
const KILL_AFTER_MS = 3000;
// Live progress: meta.lines is written at most this often while a run goes, so
// a window watching the database sees it move.
const PROGRESS_MS = 1000;

const GUARD_ADVICE = "If this genuinely needs doing, run it yourself in a normal terminal. The guard has no override.";

function logPathFor(logDir, taskId, entryId) {
  return path.join(logDir, String(Number(taskId)), `${Number(entryId)}.log`);
}

/**
 * Lines as a person would count them, and as meta.out shows them: \n, \r\n and
 * a lone \r (a progress bar redrawing) each end a line, and a trailing break
 * does not start another.
 */
function countLines(text) {
  const normal = String(text || "").replace(/\r\n?/g, "\n");
  if (!normal) return 0;
  const n = normal.split("\n").length;
  return normal.endsWith("\n") ? n - 1 : n;
}

/** Who is running this, so a sweep can tell a live run from an orphaned one. */
function runnerMeta() {
  return { runner_pid: process.pid, runner_host: os.hostname() };
}

async function runEntry({
  store, taskId, command, cwd, logDir, env = {}, onChunk = null, signal = null,
  onStart = null, progressMs = PROGRESS_MS, guard = undefined,
} = {}) {
  if (!store || typeof store.append !== "function" || typeof store.update !== "function") {
    throw new Error("runEntry needs a store with append and update");
  }
  if (!logDir) throw new Error("runEntry needs a log folder");
  const workDir = path.resolve(cwd || process.cwd());

  const entry = await store.append({ taskId, kind: "run", body: command, meta: { state: "running", cwd: workDir, ...runnerMeta() } });
  // Writes to the entry are queued, so a progress update can never land after
  // the final one and make a finished run look running again.
  let writes = Promise.resolve();
  const write = (meta) => (writes = writes.then(() => store.update(entry.id, { meta })));
  const finish = (meta) => write(meta);

  const verdict = await launch.guardCheck(entry.body, guard || {});
  if (!verdict.allowed) {
    const reason = verdict.unavailable
      ? `The guard could not run (${verdict.reason}), so nothing was run.`
      : `Blocked by guard: ${verdict.reason}`;
    return finish({ state: "fail", code: "guard", exit: null, out: `${reason}\n${GUARD_ADVICE}` });
  }

  let isDir = false;
  try { isDir = fs.statSync(workDir).isDirectory(); } catch {}
  if (!isDir) {
    return finish({ state: "fail", code: "error", exit: null, out: `There is no folder at ${workDir} to run in.` });
  }

  const log = logPathFor(logDir, entry.task_id, entry.id);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const sink = fs.openSync(log, "w");

  const windows = process.platform === "win32";
  const [shell, args] = windows
    ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", entry.body]]
    : [process.env.SHELL || "/bin/sh", ["-c", entry.body]];

  const started = Date.now();
  let breaks = 0;
  let lastByte = -1;
  let bytes = 0;
  // Bytes, decoded once at the end, because a chunk boundary can fall inside a
  // multibyte character. Counting breaks on the bytes is safe: 0x0a and 0x0d are
  // never part of a longer UTF-8 sequence.
  const head = [];
  let interrupted = 0;
  let killedFor = null;
  let killTimer = null;
  let progressTimer = null;
  let reported = 0;

  const linesSoFar = () => breaks + (bytes && lastByte !== 10 && lastByte !== 13 ? 1 : 0);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(shell, args, {
        cwd: workDir,
        // Its own process group, so an interrupt reaches the whole pipeline
        // rather than only the shell, and so a Ctrl-C meant for the caller's
        // terminal does not kill the command before its entry can be finished.
        detached: !windows,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "1", ...env },
      });
    } catch (error) {
      fs.closeSync(sink);
      finish({ state: "fail", code: "error", exit: null, out: `Could not start ${shell}: ${error.message}` }).then(resolve, reject);
      return;
    }

    const group = (sig) => {
      try {
        if (windows) child.kill();
        else process.kill(-child.pid, sig);
      } catch {}
    };

    const take = (chunk) => {
      try { fs.writeSync(sink, chunk); } catch {}
      bytes += chunk.length;
      for (const byte of chunk) {
        if (byte === 10) { if (lastByte !== 13) breaks++; }
        else if (byte === 13) breaks++;
        lastByte = byte;
      }
      if (bytes <= SHORT_OUTPUT_BYTES) head.push(chunk);
      if (onChunk) {
        try { onChunk(chunk, entry); } catch {}
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);

    if (progressMs > 0) {
      progressTimer = setInterval(() => {
        const now = linesSoFar();
        if (now === reported) return;
        reported = now;
        write({ lines: now }).catch(() => {});
      }, progressMs);
      if (progressTimer.unref) progressTimer.unref();
    }

    /** SIGINT first; a second call, or three seconds unheeded, is SIGKILL. */
    const interrupt = () => {
      interrupted++;
      if (interrupted === 1) {
        group("SIGINT");
        killTimer = setTimeout(() => group("SIGKILL"), KILL_AFTER_MS);
        if (killTimer.unref) killTimer.unref();
      } else {
        group("SIGKILL");
      }
    };
    /** Ends it now, and records why: the caller is going away (SIGHUP, SIGTERM). */
    const kill = (reason = "killed") => {
      killedFor = String(reason);
      group("SIGKILL");
    };
    if (signal) {
      if (signal.aborted) interrupt();
      else signal.addEventListener("abort", interrupt, { once: true });
    }
    if (onStart) {
      try { onStart({ entry, pid: child.pid, interrupt, kill }); } catch {}
    }

    let closed = false;
    let graceTimer = null;
    const close = (code, sig, spawnError) => {
      if (closed) return;
      closed = true;
      clearTimeout(graceTimer);
      clearTimeout(killTimer);
      clearInterval(progressTimer);
      if (signal) signal.removeEventListener("abort", interrupt);
      // Whatever is left of the group (a background job still holding the
      // pipes) goes with the run when it was interrupted or killed.
      if (interrupted || killedFor) group("SIGKILL");
      try { child.stdout.destroy(); } catch {}
      try { child.stderr.destroy(); } catch {}
      try { fs.closeSync(sink); } catch {}
      const total = linesSoFar();
      const meta = { dur_ms: Date.now() - started, lines: total, log };
      if (spawnError) {
        Object.assign(meta, { state: "fail", code: "error", exit: null, out: `Could not start ${shell}: ${spawnError.message}` });
      } else if (killedFor) {
        Object.assign(meta, { state: "fail", code: killedFor, exit: code });
      } else if (interrupted) {
        // 130 is what a shell reports for a command ended by Ctrl-C, whatever
        // the program did with the signal, so that is what the entry says.
        Object.assign(meta, { state: "fail", code: 130, exit: code });
      } else if (code === null) {
        Object.assign(meta, { state: "fail", code: sig || "signal", exit: null });
      } else {
        Object.assign(meta, { state: code === 0 ? "ok" : "fail", code, exit: code });
      }
      if (!meta.out && bytes && bytes <= SHORT_OUTPUT_BYTES && total <= SHORT_OUTPUT_LINES) {
        const out = fmt.normaliseBody(fmt.stripAnsi(Buffer.concat(head).toString("utf8")));
        if (out) meta.out = out;
      }
      finish(meta).then(resolve, reject);
    };
    child.on("error", (error) => close(null, null, error));
    child.on("exit", (code, sig) => {
      graceTimer = setTimeout(() => close(code, sig, null), EXIT_GRACE_MS);
    });
    child.on("close", (code, sig) => close(code, sig, null));
  });
}

module.exports = { SHORT_OUTPUT_LINES, KILL_AFTER_MS, EXIT_GRACE_MS, PROGRESS_MS, GUARD_ADVICE, logPathFor, countLines, runnerMeta, runEntry };
