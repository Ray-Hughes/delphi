#!/usr/bin/env node
// "Add this folder?": a session in a folder no project has leaves one question
// and no project, on both routes.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/discovery_test.js
//
// Each session is the real agent/mcp_server.js, started in the folder under
// test as a client would start it, and asked for one tool. Checked: an
// unknown repository (one row at its root, with the remote, the branch, who
// saw it and no History row), a known one, a subfolder of a known one, a
// Workbench, a temporary folder, the data folder, the command line, two
// sessions making one row, a root named by the client, "Not a project" kept
// for good, and Attach offering and taking only a project with no folder.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-discovery-")));
const DATA = path.join(dir, "data");
fs.mkdirSync(DATA);
process.env.DELPHI_DATA_DIR = DATA;
process.env.DELPHI_DB = path.join(DATA, "delphi.db");
delete process.env.DELPHI_DB_ID;
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}
// Everything here is in a temporary folder, so the temporary folders the rule
// skips are narrowed to one of them, which the temp-dir case uses.
const TMPZONE = path.join(dir, "tmpzone");
fs.mkdirSync(TMPZONE);

const db = require("../db");
const git = require("../workbench/git");
const { createFolders } = require("../main/folders");
const folders = createFolders({ db, git });
const SERVER = path.join(__dirname, "..", "agent", "mcp_server.js");

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  } else console.log(`  ok   ${what}`);
}
async function rejects(what, promise, pattern) {
  checks++;
  try { await promise; } catch (error) {
    if (pattern.test(String(error.message))) { console.log(`  ok   ${what}`); return; }
    failures++;
    console.error(`  FAIL ${what}\n       threw ${JSON.stringify(error.message)}\n       want  ${pattern}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${what}\n       did not throw`);
}
const section = (name) => console.log(`\n${name}`);
const mk = (...parts) => { const p = path.join(dir, ...parts); fs.mkdirSync(p, { recursive: true }); return p; };
const g = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
function repo(...parts) {
  const p = mk(...parts);
  g(p, "init", "-q", "-b", "main");
  g(p, "remote", "add", "origin", `git@github.com:example/${path.basename(p)}.git`);
  fs.writeFileSync(path.join(p, "README"), "x\n");
  g(p, "add", "README");
  g(p, "commit", "-q", "-m", "first");
  return p;
}
const rows = () => db.sqlP("SELECT * FROM discovered_folders WHERE via = 'session' ORDER BY id", []);
const rowAt = (p) => db.sqlP("SELECT * FROM discovered_folders WHERE path = :p1", [p])[0] || null;
const projects = () => Number(db.sqlP("SELECT COUNT(*) AS n FROM projects", [])[0].n);
const audits = () => Number(db.sqlP("SELECT COUNT(*) AS n FROM audit", [])[0].n);

/**
 * One session: the server started in cwd, initialised as clientName, asked
 * for roots when it wants them, and called once (twice with again).
 */
function session({ cwd, actor = "claude-code:s1", clientName = "claude-code", env = {}, roots = null, again = false }) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", DELPHI_ACTOR: actor, DELPHI_AUTHOR_TYPE: "agent",
      DELPHI_DISCOVERY_TEMP: TMPZONE, DELPHI_DISCOVERY: "1", ...env };
    delete childEnv.DELPHI_CLIENT;
    if (clientName === "delphi-cli") childEnv.DELPHI_CLIENT = "delphi-cli";
    const child = spawn(process.execPath, [SERVER], { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let err = "";
    const waiting = new Map();
    const write = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    const request = (id, method, params) => new Promise((ok) => { waiting.set(id, ok); write({ jsonrpc: "2.0", id, method, params }); });
    child.stderr.on("data", (d) => { err += d; });
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.method === "roots/list") { write({ jsonrpc: "2.0", id: m.id, result: { roots: (roots || []).map((r) => ({ uri: pathToFileURL(r).href })) } }); continue; }
        if (m.method) continue;
        const ok = waiting.get(m.id);
        if (ok) { waiting.delete(m.id); ok(m); }
      }
    });
    child.on("error", reject);
    (async () => {
      await request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: roots ? { roots: { listChanged: false } } : {}, clientInfo: { name: clientName, version: "1" } });
      write({ jsonrpc: "2.0", method: "notifications/initialized" });
      // Long enough for a roots/list answer to land before the first call, as
      // it would in a real session.
      if (roots) await new Promise((r) => setTimeout(r, 300));
      const first = await request(2, "tools/call", { name: "whoami", arguments: {} });
      if (again) await request(3, "tools/call", { name: "whoami", arguments: {} });
      child.stdin.end();
      child.on("close", () => {
        if (first.error) reject(new Error(`${first.error.message}\n${err}`));
        else resolve({ whoami: JSON.parse(first.result.content[0].text), stderr: err });
      });
    })().catch(reject);
  });
}

async function route(name, routeEnv) {
  const tag = name.replace(/[^a-z]/g, "");
  const env = routeEnv;

  section(`${name}: an unknown repository`);
  const efolder = repo("work", tag, "va", "caseflow-efolder");
  const sub = mk("work", tag, "va", "caseflow-efolder", "app", "models");
  const before = { projects: projects(), audits: audits() };
  const first = await session({ cwd: sub, env, again: true });
  const r = rowAt(efolder);
  check("one row, at the repository's root, not the subfolder the session was in", [Boolean(r), rowAt(sub)], [true, null]);
  check("new, from a session, seen once however many calls", [r.via, r.state, Number(r.seen_count)], ["session", "new", 1]);
  check("who saw it", r.seen_by, "claude-code:s1");
  const detail = JSON.parse(r.detail);
  check("the harness, remote and branch", [detail.harness, detail.remote, detail.branch], ["Claude Code", "git@github.com:example/caseflow-efolder.git", "main"]);
  check("no project made, and no History row", [projects(), audits()], [before.projects, before.audits]);
  check("on the route asked for", first.whoami.sqlite_route === "node:sqlite", env.DELPHI_SQLITE_ROUTE !== "binary");
  check("whoami mentions it", [first.whoami.pending_folders.count >= 1, first.whoami.pending_folders.folders.includes(efolder)], [true, true]);

  section(`${name}: two sessions, one row`);
  await Promise.all([
    session({ cwd: efolder, actor: "codex:s2", clientName: "codex-mcp-client", env }),
    session({ cwd: sub, actor: "copilot:s3", clientName: "github-copilot", env }),
  ]);
  check("still one row, counted three times", [rows().filter((x) => x.path === efolder).length, Number(rowAt(efolder).seen_count)], [1, 3]);
  check("and it keeps who saw it first", rowAt(efolder).seen_by, "claude-code:s1");
  if (process.platform === "darwin") {
    // The same folder typed in another case, which this file system allows.
    await session({ cwd: path.join(path.dirname(efolder), "CASEFLOW-EFOLDER"), actor: "claude-code:s4", env });
    check("the same folder in another case is the same row", [rows().filter((x) => x.path.toLowerCase() === efolder.toLowerCase()).length, Number(rowAt(efolder).seen_count)], [1, 4]);
  }

  section(`${name}: a folder that is not a repository`);
  const loose = mk("work", tag, "Loose Notes");
  await session({ cwd: loose, actor: "codex:s5", clientName: "codex-mcp-client", env });
  check("is asked about as itself, with no remote", [Boolean(rowAt(loose)), JSON.parse(rowAt(loose).detail).is_git, JSON.parse(rowAt(loose).detail).remote, JSON.parse(rowAt(loose).detail).harness],
    [true, false, null, "Codex"]);
  if (process.platform === "darwin") {
    await session({ cwd: path.join(path.dirname(loose), "loose notes"), env });
    check("and typed in another case it is the same row", [rows().filter((x) => x.path.toLowerCase() === loose.toLowerCase()).length, Number(rowAt(loose).seen_count)], [1, 2]);
  }

  section(`${name}: folders that are never asked about`);
  const known = repo("work", tag, "va", "caseflow");
  const P = db.createProject({ key: `caseflow-${tag}`, name: `Caseflow ${tag}`, path: known });
  const count = rows().length;
  await session({ cwd: known, env });
  check("a project's folder", rows().length, count);
  await session({ cwd: mk("work", tag, "va", "caseflow", "spec", "models"), env });
  check("a subfolder of a project's folder", rows().length, count);
  const plainKnown = mk("work", tag, "notes");
  db.createProject({ key: `notes-${tag}`, name: `Notes ${tag}`, path: plainKnown });
  await session({ cwd: mk("work", tag, "notes", "2026", "nov"), env });
  check("a subfolder of a project's folder that is not a repository", rows().length, count);
  const bench = repo("work", tag, "va", "caseflow.workbenches", "12-fix-the-thing");
  await session({ cwd: bench, env });
  check("a Workbench folder", [rows().length, rowAt(bench)], [count, null]);
  const temp = repo("tmpzone", tag, "scratch-clone");
  await session({ cwd: temp, env });
  check("a temporary folder", [rows().length, rowAt(temp)], [count, null]);
  await session({ cwd: mk("data", `sheets-${tag}`), env });
  check("Delphi's own data folder", rows().length, count);
  await session({ cwd: mk("work", tag), env });
  check("the folder above a project's", rows().length, count);
  const byHand = repo("work", tag, "by-hand");
  await session({ cwd: byHand, clientName: "delphi-cli", actor: "ray", env: { ...env, DELPHI_AUTHOR_TYPE: "human" } });
  check("the command line, which a person runs from anywhere", rowAt(byHand), null);
  check("none of it made a project", db.listProjects().filter((p) => p.key.endsWith(tag)).length, 2);

  section(`${name}: a root the client names`);
  const roots = repo("work", tag, "efolder-express");
  await session({ cwd: known, env, roots: [roots] });
  check("is asked about, though the session started in a known folder", [Boolean(rowAt(roots)), rows().length], [true, count + 1]);

  section(`${name}: Not a project`);
  const found = db.folderDiscoveries().find((d) => d.path === efolder);
  check("the window lists it, with the harness and remote", [Boolean(found), found.harness, found.remote], [true, "Claude Code", "git@github.com:example/caseflow-efolder.git"]);
  db.ignoreDiscovery(found.id);
  check("answered, and gone from the list", [rowAt(efolder).state, db.folderDiscoveries().some((d) => d.path === efolder)], ["ignored", false]);
  await session({ cwd: efolder, actor: "claude-code:s9", env });
  check("a later session does not ask again", [rowAt(efolder).state, db.folderDiscoveries().some((d) => d.path === efolder), rows().filter((x) => x.path === efolder).length], ["ignored", false, 1]);
  await rejects("and a stale click cannot answer it twice", Promise.resolve().then(() => db.ignoreDiscovery(found.id)), /answered already/);
  return { P };
}

async function main() {
  await route("node:sqlite", {});
  await route("sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" });

  section("Attach: one folder per project");
  const loose = repo("work", "attach", "bip-appeals-config");
  await session({ cwd: loose });
  const q = db.folderDiscoveries().find((d) => d.path === loose);
  const has = db.createProject({ key: "has-folder", name: "Has a folder", path: repo("work", "attach", "appeals-performance") });
  const none = db.createProject({ key: "no-folder", name: "Changeit truststore" });
  const offered = folders.discoveries().find((d) => d.id === q.id).attachable.map((p) => p.id);
  check("only projects with no folder are offered", [offered.includes(none.id), offered.includes(has.id), offered.some((id) => db.getProject(id).path)], [true, false, false]);
  await rejects("a project with a folder is refused, in a sentence", folders.attach(q.id, has.id), /has a folder already .*one folder/);
  check("and nothing changed", [db.getProject(has.id).path !== loose, rowAt(loose).state], [true, "new"]);
  await folders.attach(q.id, none.id);
  check("the project with none takes it", [db.getProject(none.id).path, rowAt(loose).state, Number(rowAt(loose).project_id)], [loose, "attached", none.id]);
  check("the question is gone", db.folderDiscoveries().some((d) => d.id === q.id), false);
  const last = db.sqlP("SELECT id FROM audit WHERE entity = 'project' AND entity_id = :p1 ORDER BY id DESC LIMIT 1", [none.id])[0];
  db.undo(Number(last.id));
  check("History puts it back, and the question is asked again", [db.getProject(none.id).path, db.folderDiscoveries().some((d) => d.id === q.id)], [null, true]);

  section("Add as a new project");
  const made = await folders.create({ path: loose, name: "BIP appeals config" });
  check("Add folder settles it", [db.getProject(made.id).path, rowAt(loose).state, db.folderDiscoveries().some((d) => d.id === q.id)], [loose, "added", false]);
  check("with the remote and branch git reported", db.sqlP("SELECT remote_url, default_branch FROM repos WHERE project_id = :p1 AND is_primary = 1", [made.id])[0],
    { remote_url: "git@github.com:example/bip-appeals-config.git", default_branch: "main" });
  check("a folder settled as a project is not asked about by the next session", [await session({ cwd: loose }).then(() => rowAt(loose).state)], ["added"]);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
