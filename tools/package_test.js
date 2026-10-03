#!/usr/bin/env node
// test-runtime: electron-node
//
// Proves a packaged Delphi can start its MCP server and its command line tool,
// without building an installer to find out.
//
//   node tools/package_test.js                     simulated layout, plus release/ if current
//   node tools/package_test.js --app PATH.app      also a specific packaged build, strictly
//
// Why this exists: electron-builder copies what electron-builder.config.js names
// and says nothing about what it does not. agent/directives.js was left out of
// extraResources, and every installed build from 1.3.0 on shipped an MCP server
// that died at its first require, while the build itself was green. A missing
// source in that list is a warning in a build log nobody reads.
//
// So this does what an installed build does, from the config rather than from a
// build: it copies every extraResources entry into a temporary Resources/ folder,
// then launches Resources/agent/mcp_server.js the way harness.js does (the app's
// own binary with ELECTRON_RUN_AS_NODE=1), and also under a plain `node` when
// there is one, because an editor launches it with its own Node. That half always
// runs. It also checks that every file the main process requires is in `files`,
// which is the same failure one level up: a main process requiring a module that
// is not in the archive.
//
// The packaged half runs against a real build when there is one. A missing build
// is a skip with a reason, not a failure, because most runs of `npm test` have
// not built one and should not have to. A build whose version is not the one in
// package.json is skipped too, as stale, unless it was named with --app: an old
// build in release/ failing would say nothing about the code in front of you.
//
// Nothing here touches a real database. The server is pointed at a database made
// for the run in a temp directory, through DELPHI_DB.

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PKG = require(path.join(ROOT, "package.json"));

// Paths the plan says are coming and are already wired into the config. Until a
// file exists it is reported as pending rather than failed, so the config can
// lead the code. Remove an entry once its file lands; after that, missing is a
// failure like anything else.
const PENDING = new Set([]);

let checks = 0;
let failures = 0;
const notes = [];

function check(what, ok, detail) {
  checks++;
  if (ok) return true;
  failures++;
  console.error(`  FAIL ${what}${detail ? `\n       ${String(detail).split("\n").join("\n       ")}` : ""}`);
  return false;
}

function note(text) { notes.push(text); console.log(`  note ${text}`); }
function section(name) { console.log(`\n${name}`); }

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

const strip = (p) => p.replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// The config

function loadConfig(signing) {
  const saved = process.env.CSC_LINK;
  if (signing) process.env.CSC_LINK = "test"; else delete process.env.CSC_LINK;
  const file = require.resolve(path.join(ROOT, "electron-builder.config.js"));
  delete require.cache[file];
  const config = require(file);
  if (saved === undefined) delete process.env.CSC_LINK; else process.env.CSC_LINK = saved;
  return config;
}

function exists(rel) { return fs.existsSync(path.join(ROOT, strip(rel))); }

function checkListed(kind, rel) {
  if (exists(rel)) return check(`${kind} ${rel} exists`, true);
  if (PENDING.has(strip(rel))) { note(`${kind} ${rel} is wired but not written yet`); return true; }
  return check(`${kind} ${rel} exists`, false, "the config names a path that is not in the repository");
}

// ---------------------------------------------------------------------------
// Requires, read from the text. Lazy requires inside functions are exactly the
// ones a launch does not exercise, which is why this reads files rather than
// relying on the server starting.

const REQUIRE = /require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

function resolveLocal(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.js`, `${base}.json`, path.join(base, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Strips comments before matching, so a require quoted in a comment is not read
// as a dependency. Crude, and enough for this codebase's style.
function localRequires(file) {
  const text = fs.readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  return [...text.matchAll(REQUIRE)].map((m) => m[1]);
}

/** Walks relative requires from the roots. Returns { files: Set, missing: [{from, spec}] }. */
function walk(roots, within) {
  const files = new Set();
  const missing = [];
  const queue = roots.filter((r) => fs.existsSync(r));
  while (queue.length) {
    const file = queue.shift();
    if (files.has(file)) continue;
    files.add(file);
    if (!/\.js$|^[^.]*$/.test(path.basename(file))) continue;
    for (const spec of localRequires(file)) {
      const target = resolveLocal(file, spec);
      if (!target || !target.startsWith(within + path.sep)) missing.push({ from: path.relative(within, file), spec });
      else queue.push(target);
    }
  }
  return { files, missing };
}

function inFiles(config, rel) {
  return config.files.some((entry) =>
    entry.endsWith("/") ? rel.startsWith(entry) : rel === entry);
}

// ---------------------------------------------------------------------------
// A Resources folder made from the config

function copyResources(config, into) {
  for (const { from, to } of config.extraResources) {
    const source = path.join(ROOT, from);
    if (!fs.existsSync(source)) continue;
    // cpSync keeps the mode, so a lost executable bit on bin/delphi shows here
    // the same way it would in a build.
    fs.cpSync(source, path.join(into, to), { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Talking to the server

function runServer({ binary, args, env, label }) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const replies = new Map();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const want = new Set();

    const finish = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      setTimeout(() => { try { child.kill(); } catch {} }, 500);
      resolve({ replies, stderr, why });
    };
    const timer = setTimeout(() => finish(`no reply within 20s (${label})`), 20000);

    const send = (msg) => {
      if (msg.id !== undefined) want.add(msg.id);
      child.stdin.write(JSON.stringify(msg) + "\n");
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let i;
      while ((i = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, i).trim();
        stdout = stdout.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { stderr += `[not JSON on stdout] ${line}\n`; continue; }
        if (msg.id === undefined) continue;
        replies.set(msg.id, msg);
        onReply(msg);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(`could not start: ${error.message}`));
    child.on("exit", (code, signal) => {
      if (!settled) finish(`exited ${code === null ? `on ${signal}` : code} before answering`);
    });

    // Asked in sequence, because what is called after tools/list depends on what
    // that list says exists. Sheet and Workbench tools are exercised once the
    // server has them, without this file having to change on the day they land.
    function onReply(msg) {
      if (msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) {
        const names = new Set(msg.result.tools.map((t) => t.name));
        send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_projects", arguments: {} } });
        if (names.has("workbench_list")) {
          send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "workbench_list", arguments: {} } });
        }
      }
      if ([...want].every((id) => replies.has(id)) && replies.has(2)) finish(null);
    }

    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "package_test", version: "1" } },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  });
}

async function exerciseServer(resources, binary, extraEnv, label, env) {
  const server = path.join(resources, "agent", "mcp_server.js");
  const { replies, stderr, why } = await runServer({
    binary, args: [server], label,
    env: { ...env, ...extraEnv, DELPHI_ACTOR: "package_test" },
  });
  const context = [why, stderr.trim().split("\n").slice(-6).join("\n")].filter(Boolean).join("\n");

  const init = replies.get(1);
  if (!check(`${label}: initialize answers`, init && init.result && init.result.serverInfo, context)) return;
  const list = replies.get(2);
  const tools = list && list.result && list.result.tools;
  if (!check(`${label}: tools/list returns tools`, Array.isArray(tools) && tools.length > 0,
             list ? JSON.stringify(list.error || list.result).slice(0, 300) : context)) return;
  check(`${label}: list_projects is among them`, tools.some((t) => t.name === "list_projects"));
  const call = replies.get(3);
  check(`${label}: list_projects runs`, call && call.result && !call.error,
        call ? JSON.stringify(call.error) : context);
  if (replies.has(4)) {
    const wb = replies.get(4);
    check(`${label}: workbench_list runs`, wb.result && !wb.error, JSON.stringify(wb.error));
  } else {
    note(`${label}: no workbench_list tool yet, not exercised`);
  }
  console.log(`  ok   ${label}: server answered with ${tools.length} tools`);
}

function exerciseCli(resources, binary, extraEnv, label, env) {
  const cli = path.join(resources, "bin", "delphi");
  if (!fs.existsSync(cli)) { note(`${label}: no bin/delphi yet, CLI not exercised`); return; }
  if (process.platform !== "win32") {
    check(`${label}: bin/delphi is executable`, (fs.statSync(cli).mode & 0o111) === 0o111);
  }
  const r = spawnSync(binary, [cli, "help"], {
    env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 20000,
  });
  check(`${label}: delphi help exits 0 and prints something`,
        r.status === 0 && r.stdout.trim().length > 0,
        `exit ${r.status}${r.error ? ` (${r.error.message})` : ""}\n${(r.stderr || "").trim().split("\n").slice(-6).join("\n")}`);
}

// Every relative require reachable from the server and the CLI, resolved inside
// the copied tree. A file left out of extraResources fails here even when the
// require is behind a branch the launch never takes.
function checkResourceRequires(resources, label) {
  const roots = [path.join(resources, "agent", "mcp_server.js"), path.join(resources, "bin", "delphi")];
  const { files, missing } = walk(roots, resources);
  for (const m of missing) {
    check(`${label}: ${m.from} requires ${m.spec}`, false, "not found under Resources/, so it is missing from extraResources");
  }
  if (!missing.length) console.log(`  ok   ${label}: ${files.size} files reachable from the server and CLI all resolve`);
}

// ---------------------------------------------------------------------------

function electronBinary() {
  try {
    const binary = require(path.join(ROOT, "node_modules", "electron"));
    if (typeof binary === "string" && fs.existsSync(binary)) return binary;
  } catch {}
  return null;
}

function plainNode() {
  const r = spawnSync("node", ["--version"], { encoding: "utf8" });
  return r.status === 0 ? "node" : null;
}

function appVersion(app) {
  const plist = path.join(app, "Contents", "Info.plist");
  if (!fs.existsSync(plist)) return null;
  const m = fs.readFileSync(plist, "utf8").match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
  return m ? m[1] : null;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-package-"));
  const dataDir = path.join(tmp, "data");
  fs.mkdirSync(dataDir);
  const dbPath = path.join(dataDir, "delphi.db");
  const env = { ...process.env, DELPHI_DATA_DIR: dataDir, DELPHI_DB: dbPath };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const name of ["DELPHI_ACTOR", "DELPHI_SESSION", "DELPHI_PROJECT", "DELPHI_WORKBENCH", "DELPHI_CLIENT"]) delete env[name];

  try {
    section("electron-builder.config.js");
    const config = loadConfig(false);
    const signed = loadConfig(true);
    check("unsigned mode sets identity null", config.mac.identity === null);
    check("signed mode notarises", signed.mac.notarize === true);
    for (const icon of [config.mac.icon, config.win.icon]) checkListed("icon", icon);
    for (const entry of config.files) checkListed("files", entry);
    for (const { from } of config.extraResources) checkListed("extraResources", from);
    const roots = ["main.js", "preload.js", "db.js"].map((f) => path.join(ROOT, f));
    const app = walk(roots, ROOT);
    for (const m of app.missing) check(`${m.from} requires ${m.spec}`, false, "does not resolve in the checkout");
    for (const file of app.files) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      check(`files covers ${rel}`, inFiles(config, rel), "the main process requires it, and it would not be in app.asar");
    }
    console.log(`  ok   ${app.files.size} files reachable from main.js, preload.js and db.js checked against files`);

    // A real database, made the way the app makes one, so tools have tables to
    // read. Done after the config checks so a db.js mid-edit fails here, with a
    // message, rather than masking them.
    process.env.DELPHI_DATA_DIR = dataDir;
    try {
      require(path.join(ROOT, "db.js")).handle();
    } catch (error) {
      check("a fresh database opens through db.js", false, error.stack);
    }

    section("simulated Resources/, copied from extraResources");
    const resources = path.join(tmp, "Resources");
    fs.mkdirSync(resources);
    copyResources(config, resources);
    checkResourceRequires(resources, "simulated");
    const electron = electronBinary();
    if (check("electron is installed", Boolean(electron), "run npm ci")) {
      await exerciseServer(resources, electron, { ELECTRON_RUN_AS_NODE: "1" }, "simulated, electron as node", env);
      exerciseCli(resources, electron, { ELECTRON_RUN_AS_NODE: "1" }, "simulated, electron as node", env);
    }
    const node = plainNode();
    if (node) {
      await exerciseServer(resources, node, {}, "simulated, plain node", env);
    } else {
      note("no node on PATH, the plain node launch was not exercised");
    }

    section("packaged build");
    const named = argValue("--app") || process.env.DELPHI_PACKAGED_APP;
    const appPath = path.resolve(named || path.join(ROOT, "release", `mac-${process.arch}`, "Delphi.app"));
    const version = appVersion(appPath);
    if (!fs.existsSync(appPath)) {
      if (named) check(`packaged app exists at ${appPath}`, false);
      else note(`skipped: no packaged app at ${path.relative(ROOT, appPath)}. Build one with npm run pack to include it`);
    } else if (!named && version !== PKG.version) {
      note(`skipped: ${path.relative(ROOT, appPath)} is version ${version}, the checkout is ${PKG.version}. ` +
           "Rebuild with npm run pack, or name it with --app to test it anyway");
    } else {
      const packaged = path.join(appPath, "Contents", "Resources");
      const binary = path.join(appPath, "Contents", "MacOS", PKG.productName || "Delphi");
      checkResourceRequires(packaged, `packaged ${version}`);
      await exerciseServer(packaged, binary, { ELECTRON_RUN_AS_NODE: "1" }, `packaged ${version}`, env);
      exerciseCli(packaged, binary, { ELECTRON_RUN_AS_NODE: "1" }, `packaged ${version}`, env);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${checks - failures}/${checks} checks passed${notes.length ? `, ${notes.length} notes` : ""}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error.stack);
  process.exit(1);
});
