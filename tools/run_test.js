#!/usr/bin/env node
// sheet/run.js and the guard check in agent/launch.js, against a fake store.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/run_test.js
//
// A fake store, because what is under test is the runner's own contract: the
// entry is written before anything runs, the guard is asked every time and a
// guard that cannot answer means no, short output is inlined and long output
// is only in the log, and an interrupt is recorded as fail:130. The real store
// behind the MCP server is covered by mcp_sheet_test.js and cli_test.js.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-run-"));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");

const { runEntry, logPathFor, SHORT_OUTPUT_LINES } = require("../sheet/run");
const launch = require("../agent/launch");

let failures = 0;
let checks = 0;

function check(what, got, want) {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}

function section(name) { console.log(`\n${name}`); }

// Ids are unique across every fake store, as they are in a real database, so
// one case's log can never stand in for another's.
let next = 100;

/** Records every call, and is async like the MCP client the CLI hands in. */
function fakeStore() {
  const rows = new Map();
  const calls = [];
  return {
    calls,
    rows,
    async append(fields) {
      calls.push(["append", fields.kind, fields.body]);
      const entry = { id: next++, task_id: fields.taskId, kind: fields.kind, body: fields.body, meta: fields.meta };
      rows.set(entry.id, entry);
      return { ...entry };
    },
    async update(id, { meta }) {
      calls.push(["update", id]);
      const entry = rows.get(id);
      entry.meta = { ...(entry.meta || {}), ...(meta || {}) };
      return { ...entry, meta: { ...entry.meta } };
    },
  };
}

const logDir = path.join(dir, "sheets");
const work = path.join(dir, "work");
fs.mkdirSync(work);

async function main() {
  section("a command that works");
  {
    const store = fakeStore();
    const chunks = [];
    const entry = await runEntry({ store, taskId: 7, command: "echo hi", cwd: work, logDir, onChunk: (c) => chunks.push(String(c)) });
    check("appended running before anything else", store.calls[0], ["append", "run", "echo hi"]);
    check("the first meta said running, with the folder", store.rows.get(entry.id) && entry.meta.cwd, work);
    check("finished ok", [entry.meta.state, entry.meta.code, entry.meta.exit, entry.meta.lines], ["ok", 0, 0, 1]);
    check("short output is inline", entry.meta.out, "hi");
    check("the log is where logPathFor says", entry.meta.log, path.join(logDir, "7", `${entry.id}.log`));
    check("logPathFor", logPathFor("/x", 3, 9), path.join("/x", "3", "9.log"));
    check("the log holds the output", fs.readFileSync(entry.meta.log, "utf8"), "hi\n");
    check("chunks were streamed", chunks.join(""), "hi\n");
    check("a duration", typeof entry.meta.dur_ms === "number" && entry.meta.dur_ms >= 0, true);
  }

  section("a command that fails");
  {
    const store = fakeStore();
    const entry = await runEntry({ store, taskId: 7, command: "echo nope >&2; exit 3", cwd: work, logDir });
    check("fail with the exit code", [entry.meta.state, entry.meta.code, entry.meta.exit], ["fail", 3, 3]);
    check("stderr is captured too", entry.meta.out, "nope");
  }

  section("output length");
  {
    const store = fakeStore();
    const five = await runEntry({ store, taskId: 7, command: `printf '1\\n2\\n3\\n4\\n5\\n'`, cwd: work, logDir });
    check(`${SHORT_OUTPUT_LINES} lines are inline`, [five.meta.lines, five.meta.out], [5, "1\n2\n3\n4\n5"]);
    const six = await runEntry({ store, taskId: 7, command: "seq 1 6", cwd: work, logDir });
    check("six lines are only in the log", [six.meta.lines, six.meta.out], [6, undefined]);
    check("and the log has them", fs.readFileSync(six.meta.log, "utf8"), "1\n2\n3\n4\n5\n6\n");
    const none = await runEntry({ store, taskId: 7, command: "true", cwd: work, logDir });
    check("no output, no out", [none.meta.lines, none.meta.out], [0, undefined]);
    const noNewline = await runEntry({ store, taskId: 7, command: "printf abc", cwd: work, logDir });
    check("a last line with no newline still counts", [noNewline.meta.lines, noNewline.meta.out], [1, "abc"]);
    const colour = await runEntry({ store, taskId: 7, command: `printf '\\033[31mred\\033[0m\\n'`, cwd: work, logDir });
    check("ANSI is stripped from out", colour.meta.out, "red");
    check("and kept in the log", fs.readFileSync(colour.meta.log, "utf8"), "\x1b[31mred\x1b[0m\n");
    const forced = await runEntry({ store, taskId: 7, command: "echo $FORCE_COLOR", cwd: work, logDir });
    check("FORCE_COLOR is set", forced.meta.out, "1");
    const unicode = await runEntry({ store, taskId: 7, command: "printf 'caf\\303\\251 \\360\\237\\232\\200\\n'", cwd: work, logDir });
    check("UTF-8 survives", unicode.meta.out, "café \u{1F680}");
  }

  section("the guard");
  {
    const store = fakeStore();
    const marker = path.join(work, "should-not-exist");
    const entry = await runEntry({ store, taskId: 7, command: `rm -rf / ; touch ${marker}`, cwd: work, logDir });
    check("refused as fail:guard", [entry.meta.state, entry.meta.code], ["fail", "guard"]);
    check("the reason is recorded", /^Blocked by guard: Recursive force delete/.test(entry.meta.out), true);
    check("and the advice", entry.meta.out.split("\n")[1], "If this genuinely needs doing, run it yourself in a normal terminal. The guard has no override.");
    check("nothing ran", fs.existsSync(marker), false);
    check("no log was written", fs.existsSync(logPathFor(logDir, 7, entry.id)), false);
    check("the entry was still written first", store.calls.map((c) => c[0]), ["append", "update"]);

    const saved = process.env.DELPHI_PYTHON;
    process.env.DELPHI_PYTHON = "/nonexistent/python3";
    const noPython = await runEntry({ store, taskId: 7, command: `touch ${marker}`, cwd: work, logDir });
    check("no python fails closed", [noPython.meta.state, noPython.meta.code], ["fail", "guard"]);
    check("and says why", noPython.meta.out.split("\n")[0], "The guard could not run (no working python3 was found), so nothing was run.");
    check("nothing ran without python", fs.existsSync(marker), false);
    if (saved === undefined) delete process.env.DELPHI_PYTHON; else process.env.DELPHI_PYTHON = saved;

    process.env.DELPHI_GUARD = path.join(dir, "no-guard.py");
    const noGuard = await runEntry({ store, taskId: 7, command: `touch ${marker}`, cwd: work, logDir });
    check("no guard.py fails closed", [noGuard.meta.code, noGuard.meta.out.split("\n")[0]],
          ["guard", "The guard could not run (guard.py was not found), so nothing was run."]);
    const crashing = path.join(dir, "crash.py");
    fs.writeFileSync(crashing, "import sys\nsys.exit(5)\n");
    process.env.DELPHI_GUARD = crashing;
    const crashed = await runEntry({ store, taskId: 7, command: `touch ${marker}`, cwd: work, logDir });
    check("a guard that crashes fails closed", [crashed.meta.code, /guard\.py exited 5/.test(crashed.meta.out)], ["guard", true]);
    delete process.env.DELPHI_GUARD;
    check("still nothing ran", fs.existsSync(marker), false);

    const allowed = await launch.guardCheck("ls -la");
    check("an ordinary command is allowed", allowed, { allowed: true, reason: null, unavailable: false });
  }

  section("finding python");
  {
    const shims = path.join(dir, ".asdf", "shims");
    fs.mkdirSync(shims, { recursive: true });
    const shim = path.join(shims, "python3");
    fs.writeFileSync(shim, `#!/bin/sh\nexec ${launch.findPython() || "/usr/bin/python3"} "$@"\n`, { mode: 0o755 });
    const saved = process.env.DELPHI_PYTHON;
    process.env.DELPHI_PYTHON = shim;
    check("an asdf shim is never taken, even when it works", launch.findPython(), null);
    if (saved === undefined) delete process.env.DELPHI_PYTHON; else process.env.DELPHI_PYTHON = saved;
    const found = launch.findPython();
    check("a real python3 is found", Boolean(found) && !/shims/.test(found), true);
  }

  section("interrupting");
  {
    const store = fakeStore();
    const controller = new AbortController();
    const started = Date.now();
    const pending = runEntry({ store, taskId: 7, command: "echo started; sleep 30; echo never", cwd: work, logDir,
                               signal: controller.signal,
                               onChunk: () => controller.abort() });
    const entry = await pending;
    check("an interrupt is fail:130", [entry.meta.state, entry.meta.code], ["fail", 130]);
    check("and it did not wait for the sleep", Date.now() - started < 10000, true);
    check("output before it is kept", fs.readFileSync(entry.meta.log, "utf8"), "started\n");
  }

  section("a folder that is not there");
  {
    const store = fakeStore();
    const entry = await runEntry({ store, taskId: 7, command: "echo hi", cwd: path.join(dir, "gone"), logDir });
    check("fails without running", [entry.meta.state, entry.meta.code, /no folder/.test(entry.meta.out)], ["fail", "error", true]);
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
