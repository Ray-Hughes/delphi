#!/usr/bin/env node
// Runs every test in the repository and fails if any of them does.
//
//   npm test                    everything
//   npm test -- sheet guard     only the files whose names contain a word given
//
// No framework, matching the tests themselves. Each test is a script that prints
// its own checks and exits non-zero on failure; this only finds them, runs each
// one the way it needs, and adds up the exits.
//
// Discovery is by name: every tools/*_test.js and agent/*_test.py. A new test is
// picked up by existing, with nothing to register, because a test that has to be
// added to a list is a test that sometimes is not.
//
// How a JavaScript test is run is declared in the test file itself, by a comment
// in its first twenty lines:
//
//   // test-runtime: electron-node   (the default) Electron's binary with
//                                    ELECTRON_RUN_AS_NODE=1. Node 24 with
//                                    node:sqlite, the same Node the app runs, and
//                                    no window, so no display is needed on Linux.
//   // test-runtime: node            whatever `node` ran this runner. For a test
//                                    that must prove something works without
//                                    Electron, as the MCP server has to.
//   // test-runtime: electron        the full app runtime, `electron --no-sandbox`,
//                                    for a test that needs the electron module's
//                                    API. On Linux this needs a display, so it is
//                                    wrapped in xvfb-run when there is none.
//
// Every child gets its own temp directory with DELPHI_DATA_DIR and DELPHI_DB
// pointing inside it, and the Delphi variables an agent session carries are
// removed first. An agent running `npm test` from a harness tab has DELPHI_DB set
// to the real database, and a test that forgot to set its own would otherwise
// write there. Tests still set their own; this is the floor under that.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TIMEOUT_MS = Number(process.env.DELPHI_TEST_TIMEOUT_MS) || 5 * 60 * 1000;

// Files the runner must never execute however they are named. Empty today; here
// so excluding something is a visible decision rather than a renamed file.
const EXCLUDE = new Set([]);

// Variables that point a process at a particular database, session or Workbench.
// Inherited from an agent's environment they would aim a test at real work.
const SCRUB = [
  "DELPHI_DB", "DELPHI_DATA_DIR", "DELPHI_ACTOR", "DELPHI_SESSION", "DELPHI_PROJECT",
  "DELPHI_WORKBENCH", "DELPHI_WORKBENCH_DIR", "DELPHI_CLIENT", "DELPHI_AUTHOR_TYPE",
  "ELECTRON_RUN_AS_NODE",
];

function discover() {
  const found = [];
  for (const dir of ["tools", "agent"]) {
    for (const name of fs.readdirSync(path.join(ROOT, dir)).sort()) {
      if (!/_test\.(js|py)$/.test(name)) continue;
      const rel = `${dir}/${name}`;
      if (!EXCLUDE.has(rel)) found.push(rel);
    }
  }
  return found;
}

function declaredRuntime(file) {
  const head = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n").slice(0, 20).join("\n");
  const match = head.match(/\/\/\s*test-runtime:\s*([\w-]+)/);
  return match ? match[1] : "electron-node";
}

// The electron npm package exports the binary's path when required from a plain
// Node. Resolved lazily so a run of only the python tests works without it.
function electronBinary() {
  try {
    const binary = require(path.join(ROOT, "node_modules", "electron"));
    if (typeof binary === "string" && fs.existsSync(binary)) return binary;
  } catch {}
  return null;
}

// python3 is proved by running it, not by finding it. An asdf shim is on PATH in
// some checkouts and fails with "No version is set" for every call, which would
// read as a failing guard rather than a missing interpreter.
function findPython() {
  const candidates = [
    process.env.DELPHI_PYTHON,
    "/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3",
    "python3", "python",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const r = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (r.status === 0 && /Python 3/.test(r.stdout + r.stderr)) return candidate;
  }
  return null;
}

function hasCommand(name) {
  return spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0;
}

/** Returns { argv, env } for a test, or { skip: reason }. */
function plan(file, env) {
  const full = path.join(ROOT, file);
  if (file.endsWith(".py")) {
    const python = findPython();
    return python ? { argv: [python, full] } : { skip: "no working python3 found (set DELPHI_PYTHON)" };
  }
  const runtime = declaredRuntime(file);
  if (runtime === "node") return { argv: [process.execPath, full] };
  const electron = electronBinary();
  if (!electron) return { skip: "electron is not installed, run npm ci" };
  if (runtime === "electron-node") {
    env.ELECTRON_RUN_AS_NODE = "1";
    return { argv: [electron, full] };
  }
  if (runtime === "electron") {
    const argv = [electron, "--no-sandbox", full];
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      if (!hasCommand("xvfb-run")) return { skip: "needs a display, and xvfb-run is not installed" };
      return { argv: ["xvfb-run", "-a", ...argv] };
    }
    return { argv };
  }
  return { fail: `unknown test-runtime "${runtime}" (use electron-node, node or electron)` };
}

function main() {
  const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const tests = discover().filter((f) => !filters.length || filters.some((w) => f.includes(w)));
  if (!tests.length) {
    console.error(filters.length ? `No test matches ${filters.join(", ")}` : "No tests found");
    process.exit(1);
  }

  const results = [];
  for (const file of tests) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-test-"));
    const env = { ...process.env };
    for (const name of SCRUB) delete env[name];
    env.DELPHI_DATA_DIR = path.join(tmp, "data");
    env.DELPHI_DB = path.join(tmp, "data", "delphi.db");
    fs.mkdirSync(env.DELPHI_DATA_DIR);

    const how = plan(file, env);
    console.log(`\n=== ${file}${how.argv ? `  (${how.argv[0] === process.execPath ? "node" : path.basename(how.argv[0])})` : ""}`);

    let outcome;
    const started = Date.now();
    if (how.skip) {
      console.log(`  skipped: ${how.skip}`);
      outcome = "skip";
    } else if (how.fail) {
      console.log(`  ${how.fail}`);
      outcome = "fail";
    } else {
      const r = spawnSync(how.argv[0], how.argv.slice(1), {
        cwd: ROOT, env, stdio: "inherit", timeout: TIMEOUT_MS,
      });
      if (r.error && r.error.code === "ETIMEDOUT") {
        console.log(`  timed out after ${TIMEOUT_MS / 1000}s`);
        outcome = "fail";
      } else if (r.error) {
        console.log(`  could not start: ${r.error.message}`);
        outcome = "fail";
      } else {
        outcome = r.status === 0 ? "pass" : "fail";
        if (r.status !== 0) console.log(`  exited ${r.status === null ? `on ${r.signal}` : r.status}`);
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    results.push({ file, outcome, secs: ((Date.now() - started) / 1000).toFixed(1) });
  }

  console.log("\n=== summary");
  for (const r of results) console.log(`  ${r.outcome.padEnd(4)}  ${r.file}  ${r.secs}s`);
  const failed = results.filter((r) => r.outcome === "fail").length;
  const passed = results.filter((r) => r.outcome === "pass").length;
  const skipped = results.length - failed - passed;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
}

main();
