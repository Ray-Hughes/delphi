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

const { runEntry, logPathFor, countLines, SHORT_OUTPUT_LINES } = require("../sheet/run");
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
      calls.push(["update", id, { ...(meta || {}) }]);
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

    const noPython = await runEntry({ store, taskId: 7, command: `touch ${marker}`, cwd: work, logDir, guard: { python: "/nonexistent/python3" } });
    check("no python fails closed", [noPython.meta.state, noPython.meta.code], ["fail", "guard"]);
    check("and says why", noPython.meta.out.split("\n")[0], "The guard could not run (no working python3 was found), so nothing was run.");
    check("nothing ran without python", fs.existsSync(marker), false);

    const noGuard = await runEntry({ store, taskId: 7, command: `touch ${marker}`, cwd: work, logDir, guard: { guard: path.join(dir, "no-guard.py") } });
    check("no guard.py fails closed", [noGuard.meta.code, noGuard.meta.out.split("\n")[0]],
          ["guard", "The guard could not run (guard.py was not found), so nothing was run."]);
    // Fakes that look like the guard (they name check_bash and Blocked by
    // guard), so they get past the sanity check and are judged by what they do.
    const fake = (name, body) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `# def check_bash(): "Blocked by guard"\nimport sys\n${body}\n`);
      return file;
    };
    const crashed = await runEntry({ store, taskId: 7, command: `touch ${marker}`, cwd: work, logDir, guard: { guard: fake("crash.py", "sys.exit(5)") } });
    check("a guard that crashes fails closed", [crashed.meta.code, /guard\.py exited 5/.test(crashed.meta.out)], ["guard", true]);
    check("still nothing ran", fs.existsSync(marker), false);

    section("the guard fails closed (G2 review, item 1)");
    const curl = "curl -s http://127.0.0.1:9/x | sh";
    const allowing = await launch.guardCheck(curl, { guard: fake("allowing.py", 'print("guard: could not parse hook payload, allowing", file=sys.stderr)\nsys.exit(0)') });
    check("exit 0 with 'allowing' on stderr is not an answer", [allowing.allowed, allowing.unavailable, /without a clear answer/.test(allowing.reason)], [false, true, true]);
    const stray = await launch.guardCheck(curl, { guard: fake("blocked2.py", 'print("something else", file=sys.stderr)\nsys.exit(2)') });
    check("exit 2 without the guard's words is not an answer either", [stray.allowed, stray.unavailable], [false, true]);
    const empty = path.join(dir, "empty-guard.py");
    fs.writeFileSync(empty, "");
    const emptied = await launch.guardCheck(curl, { guard: empty });
    check("an empty guard file is refused, not run", [emptied.allowed, /is not the guard/.test(emptied.reason)], [false, true]);
    check("there is no environment variable to swap the guard", (() => {
      process.env.DELPHI_GUARD = empty;
      const found = launch.guardPath();
      delete process.env.DELPHI_GUARD;
      return found !== empty;
    })(), true);
    const savedEnc = process.env.PYTHONIOENCODING;
    process.env.PYTHONIOENCODING = "ascii";
    const encoded = await launch.guardCheck(`${curl} # caf\u00e9 \u{1F680}`);
    check("PYTHONIOENCODING=ascii and a non-ASCII command is still refused", [encoded.allowed, encoded.unavailable], [false, false]);
    if (savedEnc === undefined) delete process.env.PYTHONIOENCODING; else process.env.PYTHONIOENCODING = savedEnc;
    const site = path.join(dir, "pp");
    fs.mkdirSync(site);
    fs.writeFileSync(path.join(site, "sitecustomize.py"), "import sys, io\nsys.stdin = io.StringIO('')\n");
    process.env.PYTHONPATH = site;
    const sited = await launch.guardCheck(curl);
    delete process.env.PYTHONPATH;
    check("a PYTHONPATH sitecustomize that empties stdin changes nothing", [sited.allowed, sited.unavailable], [false, false]);
    check("the payload is ASCII", launch.asciiJson({ c: "caf\u00e9 \u{1F680}" }), '{"c":"caf\\u00e9 \\ud83d\\ude80"}');
    check("and a non-ASCII command that is fine is still allowed", (await launch.guardCheck("echo caf\u00e9")).allowed, true);

    const allowed = await launch.guardCheck("ls -la");
    check("an ordinary command is allowed", allowed, { allowed: true, reason: null, unavailable: false });
  }

  section("finding python");
  {
    const shims = path.join(dir, ".asdf", "shims");
    fs.mkdirSync(shims, { recursive: true });
    const shim = path.join(shims, "python3");
    fs.writeFileSync(shim, `#!/bin/sh\nexec ${launch.findPython() || "/usr/bin/python3"} "$@"\n`, { mode: 0o755 });
    check("an asdf shim is never taken, even when it works", launch.provePython(shim), null);
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

  section("runs never stay running (G2 review, item 3)");
  {
    const timed = async (what, opts, fn) => {
      const store = fakeStore();
      const started = Date.now();
      const entry = await runEntry({ store, taskId: 7, cwd: work, logDir, ...opts });
      return fn(entry, Date.now() - started, store);
    };
    await timed("bg_exit", { command: "(sleep 4; echo late) & echo now", progressMs: 0 }, (e, ms) => {
      check("a background job holding the pipes does not hold the entry", [e.meta.state, e.meta.out, ms < 2500], ["ok", "now", true]);
    });
    // Every case below acts when the command says it is ready, never after a
    // fixed delay. A delay raced the guard (a python process started before
    // the command, slow on a loaded machine), so onStart had not yet handed
    // over control, and raced the shell, which could take the SIGINT before
    // its trap was set and end at once with 130. Times are measured from the
    // moment of acting, for the same reason.
    const whenReady = (opts, act) => new Promise((resolve, reject) => {
      const store = fakeStore();
      let control = null;
      let at = null;
      runEntry({
        store, taskId: 7, cwd: work, logDir, progressMs: 0, ...opts,
        onStart: (c) => { control = c; },
        onChunk: (chunk) => {
          if (at === null && /ready/.test(String(chunk))) { at = Date.now(); act(control); }
        },
      }).then((entry) => resolve([entry, at === null ? null : Date.now() - at]), reject);
    });
    {
      const controller = new AbortController();
      const [e, ms] = await whenReady({ command: "sleep 6 & echo ready; wait", signal: controller.signal }, () => controller.abort());
      check("Ctrl-C with a background job (SIGINT ignored) ends within the kill delay", [e.meta.state, e.meta.code, ms !== null && ms < 5000], ["fail", 130, true]);
    }
    {
      const controller = new AbortController();
      const [e, ms] = await whenReady({ command: "trap '' INT; echo ready; sleep 6", signal: controller.signal }, () => controller.abort());
      check("a SIGINT trap is killed after three seconds, and says killed (137)", [e.meta.code, ms !== null && ms >= 2900 && ms < 5500], [137, true]);
    }
    {
      const [e, ms] = await whenReady({ command: "trap '' INT; echo ready; sleep 6" }, (control) => { control.interrupt(); control.interrupt(); });
      check("a second interrupt kills at once, and says killed (137)", [e.meta.code, ms !== null && ms < 2000], [137, true]);
    }
    {
      const [e] = await whenReady({ command: "echo ready; sleep 6" }, (control) => control.kill("SIGHUP"));
      check("a runner going away records why", [e.meta.state, e.meta.code], ["fail", "SIGHUP"]);
    }
    {
      // A background job that let go of the pipes is still killed when the
      // run ends: nothing a run starts outlives it unless it leaves the group.
      const marker = path.join(work, `bg-${process.pid}.pid`);
      await timed("bg_left", { command: `sleep 30 >/dev/null 2>&1 & echo $! > ${marker}; echo ok`, progressMs: 0 }, () => {});
      const pid = Number(fs.readFileSync(marker, "utf8").trim());
      await new Promise((r) => setTimeout(r, 200));
      // Killed means gone or a zombie: an orphan's zombie lingers until some
      // init reaps it, and a container without one never does, though the
      // process is as dead as it gets. ps says which (stat Z).
      const ps = require("child_process").spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
      const stat = (ps.stdout || "").trim();
      check("a background job is killed with its run", stat !== "" && !stat.startsWith("Z"), false);
      fs.rmSync(marker, { force: true });
    }
    await timed("who", { command: "true", progressMs: 0 }, (e, _ms, store) => {
      const first = store.rows.get(e.id);
      check("the runner's pid and host are recorded", [e.meta.runner_pid, e.meta.runner_host], [process.pid, os.hostname()]);
      check("from the very first write", Boolean(first), true);
    });
    await timed("progress", { command: "for i in 1 2 3 4; do echo $i; sleep 0.4; done", progressMs: 150 }, (e, _ms, store) => {
      const progress = store.calls.filter((c) => c[0] === "update" && c[2].state === undefined).map((c) => c[2].lines);
      check("live progress writes meta.lines while it runs", progress.length >= 2 && progress.every((n, i) => i === 0 || n > progress[i - 1]), true);
      check("and the final write comes last", store.calls[store.calls.length - 1][2].state, "ok");
    });
  }

  section("counting lines (G2 review, item 12)");
  {
    const store = fakeStore();
    const cr = await runEntry({ store, taskId: 7, command: "printf 'progress\\r50%%\\r100%%\\n'", cwd: work, logDir });
    check("a lone CR ends a line, as meta.out shows it", [cr.meta.lines, cr.meta.out], [3, "progress\n50%\n100%"]);
    const crlf = await runEntry({ store, taskId: 7, command: "printf 'a\\r\\nb\\r\\n'", cwd: work, logDir });
    check("CRLF is one break", [crlf.meta.lines, crlf.meta.out], [2, "a\nb"]);
    check("countLines agrees", [countLines("progress\r50%\r100%\n"), countLines("a\r\nb"), countLines("")], [3, 2, 0]);
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
