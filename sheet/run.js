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
 */

const fs = require("fs");
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

const GUARD_ADVICE = "If this genuinely needs doing, run it yourself in a normal terminal. The guard has no override.";

function logPathFor(logDir, taskId, entryId) {
  return path.join(logDir, String(Number(taskId)), `${Number(entryId)}.log`);
}

/** Lines as a person would count them: a trailing newline does not start another. */
function countLines(text) {
  if (!text) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

async function runEntry({ store, taskId, command, cwd, logDir, env = {}, onChunk = null, signal = null } = {}) {
  if (!store || typeof store.append !== "function" || typeof store.update !== "function") {
    throw new Error("runEntry needs a store with append and update");
  }
  if (!logDir) throw new Error("runEntry needs a log folder");
  const workDir = path.resolve(cwd || process.cwd());

  const entry = await store.append({ taskId, kind: "run", body: command, meta: { state: "running", cwd: workDir } });
  const finish = (meta) => store.update(entry.id, { meta });

  const verdict = await launch.guardCheck(entry.body);
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
  let lines = 0;
  let endedWithNewline = true;
  let bytes = 0;
  // Bytes, decoded once at the end, because a chunk boundary can fall inside a
  // multibyte character. Counting newlines on the bytes is safe: 0x0a is never
  // part of a longer UTF-8 sequence.
  const head = [];
  let aborted = false;

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

    const take = (chunk) => {
      fs.writeSync(sink, chunk);
      bytes += chunk.length;
      for (const byte of chunk) if (byte === 10) lines++;
      if (chunk.length) endedWithNewline = chunk[chunk.length - 1] === 10;
      if (bytes <= SHORT_OUTPUT_BYTES) head.push(chunk);
      if (onChunk) {
        try { onChunk(chunk); } catch {}
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);

    const interrupt = () => {
      aborted = true;
      try {
        if (windows) child.kill();
        else process.kill(-child.pid, "SIGINT");
      } catch {}
    };
    if (signal) {
      if (signal.aborted) interrupt();
      else signal.addEventListener("abort", interrupt, { once: true });
    }

    let closed = false;
    const close = (code, sig, spawnError) => {
      if (closed) return;
      closed = true;
      if (signal) signal.removeEventListener("abort", interrupt);
      try { fs.closeSync(sink); } catch {}
      const total = lines + (bytes && !endedWithNewline ? 1 : 0);
      const meta = { dur_ms: Date.now() - started, lines: total, log };
      if (spawnError) {
        Object.assign(meta, { state: "fail", code: "error", exit: null, out: `Could not start ${shell}: ${spawnError.message}` });
      } else if (aborted) {
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
      Promise.resolve(finish(meta)).then(resolve, reject);
    };
    child.on("error", (error) => close(null, null, error));
    child.on("close", (code, sig) => close(code, sig, null));
  });
}

module.exports = { SHORT_OUTPUT_LINES, GUARD_ADVICE, logPathFor, countLines, runEntry };
