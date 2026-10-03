#!/usr/bin/env node
// The vault mirror's Sheets: one clean .sheet file per task, swept like notes.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/vault_test.js
//
// The vault is a one way mirror of the database for Obsidian, ripgrep and git.
// Each task with anything on its Sheet gets <vault>/<project>/sheets/<id>-<title>.sheet,
// in clean text (no ids, no {} metadata), the same text `delphi cat` gives in
// a pipe. A Sheet that goes away, or a task renamed, leaves no stale file.
// Everything is in a temp directory.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-vault-"));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const vault = require("../vault");
const fmt = require("../sheet/format");
const { makeSheetStore } = require("../sheet/store");

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

const out = path.join(dir, "vault");
const listSheets = (project) => {
  const d = path.join(out, project, "sheets");
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
};

const project = db.createProject({ key: "vt", name: "Vault Test" });
const other = db.createProject({ key: "ot", name: "Other" });
const sheets = makeSheetStore({ sql: db.sqlP, actor: "claude-code:7", authorType: "agent" });
const person = makeSheetStore({ sql: db.sqlP, actor: "ray", authorType: "human" });

const talked = db.createTask({ projectId: project.id, title: "fix zip DLQ backlog" });
person.append({ taskId: talked.id, kind: "say", body: "why is the DLQ filling up?" });
const reply = sheets.append({ taskId: talked.id, kind: "say", body: "visibility timeout is under p95.\n\n```sh\n$ not a run\n```\nQuoted  {id:1 ok}" });
sheets.append({ taskId: talked.id, kind: "run", body: "aws sqs get-queue-attributes", meta: { state: "ok", code: 0, dur_ms: 1200, lines: 2, out: "a\nb" } });
const ask = sheets.ask(talked.id, "retry strategy", ["exponential", "fixed"]);
person.decide(ask.id, "a", "fewer retries under load");
sheets.append({ taskId: talked.id, kind: "note", body: "bump timeout before deploy", promote: true });

const quiet = db.createTask({ projectId: project.id, title: "nothing said yet" });
const finished = db.createTask({ projectId: other.id, title: "shipped: the thing / with slashes" });
person.append({ taskId: finished.id, kind: "say", body: "done and dusted" });
db.updateTask(finished.id, { status: "done" });

section("each task's Sheet, clean");
const first = vault.exportAll(db, out);
check("the count", first.sheets, 2);
const talkedFile = path.join(out, "Vault Test", "sheets", `${talked.id}-fix zip DLQ backlog.sheet`);
check("named by id and title, under the project", fs.existsSync(talkedFile), true);
const text = fs.readFileSync(talkedFile, "utf8");
check("exactly what delphi cat gives in a pipe", text, fmt.format(person.sheet(talked.id), { clean: true }));
check("with the header", text.split("\n").slice(0, 6), ["---", `task: ${talked.id}`, "title: fix zip DLQ backlog", "project: vt", "status: todo", "---"]);
check("no ids or metadata", [text.includes(`{id:${reply.id}`), /by:|dur:|lines:/.test(text)], [false, false]);
check("but the agent's own braces", text.includes("Quoted  {id:1 ok}"), true);
check("and its fence, indented as a body", text.includes("  $ not a run"), true);
check("reads back to the same bodies", fmt.parse(text, { clean: true }).entries.map((e) => e.body).slice(0, 2), ["why is the DLQ filling up?", reply.body]);
check("a task with nothing said gets no file", listSheets("Vault Test").some((f) => f.startsWith(`${quiet.id}-`)), false);
check("a done task is mirrored too, its title made safe", listSheets("Other"), [`${finished.id}-shipped- the thing - with slashes.sheet`]);
check("the notes are still there", fs.existsSync(path.join(out, "Vault Test", "Vault Test.md")), true);

section("the sweep");
const stray = path.join(out, "Vault Test", "sheets", "999-gone.sheet");
fs.writeFileSync(stray, "old\n");
const keep = path.join(out, "Vault Test", "sheets", "notes-by-hand.txt");
fs.writeFileSync(keep, "mine\n");
db.updateTask(talked.id, { title: "fix the DLQ" });
const second = vault.exportAll(db, out);
check("a stale .sheet is removed", fs.existsSync(stray), false);
check("a renamed task leaves no twin", listSheets("Vault Test"), [`${talked.id}-fix the DLQ.sheet`, "notes-by-hand.txt"]);
check("a file that is not a .sheet or .md is left alone", fs.existsSync(keep), true);
check("removed counts both", second.removed, 2);
db.deleteTask(finished.id);
vault.exportAll(db, out);
check("a deleted task's Sheet goes", listSheets("Other"), []);
const again = vault.exportAll(db, out);
check("a second export changes nothing", [again.removed, again.sheets], [0, 1]);

section("a new entry reaches the mirror on the next export");
sheets.append({ taskId: talked.id, kind: "say", body: "and one more thing" });
vault.exportAll(db, out);
check("it is in the file", fs.readFileSync(path.join(out, "Vault Test", "sheets", `${talked.id}-fix the DLQ.sheet`), "utf8").trimEnd().endsWith("@ claude-code:7: and one more thing"), true);

section("G4: a project's name cannot write outside the vault");
{
  const dots = db.createProject({ key: "dd", name: ".." });
  const hidden = db.createProject({ key: "hd", name: ".hidden" });
  for (const p of [dots, hidden]) {
    const t = db.createTask({ projectId: p.id, title: "x" });
    person.append({ taskId: t.id, kind: "say", body: "hello" });
  }
  vault.exportAll(db, out);
  check("nothing beside the vault", fs.existsSync(path.join(dir, "sheets")), false);
  check("'..' becomes a folder inside it", fs.existsSync(path.join(out, "__", "sheets")), true);
  check("a leading dot does not hide the folder", fs.existsSync(path.join(out, "_hidden", "sheets")), true);
}

section("G4: the sweep leaves a person's own .sheet files alone");
{
  const mine = [path.join(out, "mine.sheet"), path.join(out, "Vault Test", "kept.sheet"), path.join(out, "Vault Test", "sheets", "my-notes.sheet")];
  for (const f of mine) fs.writeFileSync(f, "a person's own sheet\n");
  const stale = path.join(out, "Vault Test", "sheets", "12345-gone.sheet");
  fs.writeFileSync(stale, "stale\n");
  vault.exportAll(db, out);
  check("only <project>/sheets/<id>-*.sheet that it did not write goes", [fs.existsSync(stale), ...mine.map((f) => fs.existsSync(f))], [false, true, true, true]);
}

section("G4: a vault file imports back exactly, with --clean");
{
  const { spawnSync } = require("child_process");
  const source = db.createTask({ projectId: project.id, title: "braces that are text" });
  const tricky = ["the config is literally  {x}", "a quoted sheet line: $ ls  {id:1 ok}", "ends in a block  {id:7 by:ray +}"];
  for (const body of tricky) person.append({ taskId: source.id, kind: "say", body });
  vault.exportAll(db, out);
  const file = path.join(out, "Vault Test", "sheets", `${source.id}-braces that are text.sheet`);
  const target = db.createTask({ projectId: project.id, title: "imported" });
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "delphi"), "import", String(target.id), file, "--clean"], {
    encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DELPHI_ACTOR: "ray", DELPHI_AUTHOR_TYPE: "human" },
  });
  check("import exits 0", [r.status, r.stderr.trim()], [0, `delphi: imported 3 entries into task ${target.id}`]);
  check("every body comes back whole, braces and all", person.sheet(target.id).entries.map((e) => e.body), tricky);
  const back = fmt.format({ entries: person.sheet(target.id).entries }, { clean: true });
  check("and its clean text is the vault file's", back, fs.readFileSync(file, "utf8").split("\n").slice(6).join("\n"));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
