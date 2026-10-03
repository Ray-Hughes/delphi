#!/usr/bin/env node
// The Sheet tools, through the real agent/mcp_server.js, on both of its routes.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/mcp_sheet_test.js
//
// Seeded through db.js, then driven only through sheet/client.js, so what is
// tested is exactly what an agent sees: the tool list and its directives, the
// shapes that come back, the errors in words, and the audit rows the History
// tab will show. Run once on node:sqlite and once on the sqlite3 binary
// (DELPHI_SQLITE_ROUTE=binary), because the server substitutes literals on the
// second and a shape that differs between them is the bug a shared store is
// there to prevent.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-mcp-sheet-"));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const oracle = require("../oracle");
const { openServer } = require("../sheet/client");

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

async function rejects(what, promise, pattern) {
  checks++;
  try {
    await promise;
  } catch (error) {
    if (pattern.test(String(error.message))) return;
    failures++;
    console.error(`  FAIL ${what}\n       threw ${JSON.stringify(error.message)}\n       want  ${pattern}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${what}\n       did not throw`);
}

function section(name) { console.log(`\n${name}`); }

const folder = path.join(dir, "project-folder");
fs.mkdirSync(folder);
const project = db.createProject({ key: "mcp-sheet", name: "MCP sheet", path: folder });
// The graph's tables, as the app makes them on start.
oracle.open(db.handle());
const orphan = db.createTask({ title: "no project" });

// The server is started without ELECTRON_RUN_AS_NODE in this process's own
// environment. Under Electron the client's default command is the app binary,
// and it is the client's job, not the caller's, to make that run as Node.
delete process.env.ELECTRON_RUN_AS_NODE;

async function route(name, env) {
  section(`${name}: the tool list`);
  const client = openServer({ actor: "claude-code:9", env: { DELPHI_AUTHOR_TYPE: "agent", ...env }, clientName: "test", warn: () => {} });
  await client.start();
  try {
    const listed = (await client.request("tools/list", {})).tools;
    const byName = Object.fromEntries(listed.map((t) => [t.name, t]));
    for (const tool of ["sheet_read", "sheet_get", "sheet_append", "sheet_update", "sheet_promote", "sheet_file", "sheet_ask", "sheet_decide", "sheet_resolve"]) {
      check(`${tool} is listed`, Boolean(byName[tool]), true);
    }
    check("sheet_append carries the promotion directive",
          /Promote \(promote: true\) anything that changes what the next agent should do/.test(byName.sheet_append.description)
          && /call sheet_file on it as well/.test(byName.sheet_append.description), true);
    check("queue_complete says its summary is promoted",
          /promoted into the task's ledger automatically/.test(byName.queue_complete.description)
          && /sheet_file it/.test(byName.queue_complete.description), true);
    check("sheet_append offers no author", Object.keys(byName.sheet_append.inputSchema.properties).includes("author"), false);

    const task = db.createTask({ projectId: project.id, title: `sheet over ${name}` });
    db.handle().prepare("UPDATE tasks SET legacy_id = ?, ref = ? WHERE id = ?").run(`T-${task.id}`, `MCP-${task.id}`, task.id);

    section(`${name}: appending`);
    const say = await client.call("sheet_append", { task_id: task.id, kind: "say", body: "the DLQ fills at 9am" });
    check("a say", [say.kind, say.author, say.author_type, say.body, say.promoted, typeof say.id], ["say", "claude-code:9", "agent", "the DLQ fills at 9am", 0, "number"]);
    const nasty = "quotes ' \" and :p1 :p2 and $& $` and {id:1 ok}";
    const note = await client.call("sheet_append", { task_id: task.id, kind: "note", body: nasty, promote: true });
    check("a note, promoted, stored verbatim", [note.kind, note.body, note.promoted], ["note", nasty, 1]);
    const run = await client.call("sheet_append", { task_id: task.id, kind: "run", body: "npm test", meta: { state: "running", cwd: "/tmp/a b" } });
    check("a run", [run.kind, run.meta], ["run", { state: "running", cwd: "/tmp/a b" }]);
    const reply = await client.call("sheet_append", { task_id: task.id, kind: "say", body: "following up", ref_id: say.id });
    check("a reference", reply.ref_id, say.id);
    const spoof = await client.call("sheet_append", { task_id: task.id, kind: "say", body: "who am I", author: "ray" });
    check("an author in the input is ignored", spoof.author, "claude-code:9");

    await rejects("ask through append", client.call("sheet_append", { task_id: task.id, kind: "ask", body: "q" }), /Use sheet_ask/);
    await rejects("decide through append", client.call("sheet_append", { task_id: task.id, kind: "decide", body: "a" }), /Use sheet_decide/);
    await rejects("an unknown kind", client.call("sheet_append", { task_id: task.id, kind: "shout", body: "x" }), /kind must be one of/);
    await rejects("an empty body", client.call("sheet_append", { task_id: task.id, kind: "say", body: "  " }), /needs something/);
    await rejects("a two line command", client.call("sheet_append", { task_id: task.id, kind: "run", body: "a\nb" }), /one line/);
    await rejects("no such task", client.call("sheet_append", { task_id: 999999, kind: "say", body: "x" }), /No task 999999/);
    await rejects("a reference to another task", client.call("sheet_append", { task_id: orphan.id, kind: "say", body: "x", ref_id: say.id }), /own Sheet/);

    section(`${name}: updating`);
    const finished = await client.call("sheet_update", { id: run.id, meta: { state: "ok", code: 0, dur_ms: 1200, lines: 3 } });
    check("meta is merged", finished.meta, { state: "ok", cwd: "/tmp/a b", code: 0, dur_ms: 1200, lines: 3 });
    const edited = await client.call("sheet_update", { id: say.id, body: "the DLQ fills at 9am UTC" });
    check("a body edit", edited.body, "the DLQ fills at 9am UTC");
    check("sheet_get", (await client.call("sheet_get", { id: say.id })).body, "the DLQ fills at 9am UTC");

    section(`${name}: promoting`);
    check("promote", (await client.call("sheet_promote", { id: say.id })).promoted, 1);
    check("unpromote", (await client.call("sheet_promote", { id: say.id, on: false })).promoted, 0);

    section(`${name}: asking and deciding`);
    const ask = await client.call("sheet_ask", { task_id: task.id, question: "retry strategy", options: ["exponential", "fixed"] });
    check("an ask", [ask.kind, ask.meta], ["ask", { options: [{ key: "a", label: "exponential" }, { key: "b", label: "fixed" }] }]);
    await rejects("one option", client.call("sheet_ask", { task_id: task.id, question: "q", options: ["a"] }), /two to four/);
    await rejects("a choice not offered", client.call("sheet_decide", { ask_id: ask.id, choice: "c" }), /Choose one of a, b/);
    const decision = await client.call("sheet_decide", { ask_id: ask.id, choice: "a", why: "backs off under load" });
    check("a decide, promoted, pointing at its ask",
          [decision.kind, decision.body, decision.ref_id, decision.promoted, decision.meta],
          ["decide", "a\nbacks off under load", ask.id, 1, { choice: "a", label: "exponential" }]);
    await rejects("a decision's choice cannot be edited", client.call("sheet_update", { id: decision.id, meta: { choice: "b" } }), /cannot change/);

    section(`${name}: filing`);
    const filed = {};
    const unique = `zanzibarquux${name.replace(/[^a-z]/g, "")}`;
    for (const kind of ["decision", "gotcha", "reference", "note"]) {
      const source = kind === "decision" ? decision
        : await client.call("sheet_append", { task_id: task.id, kind: "say", body: `${unique} matters as a ${kind}` });
      filed[kind] = await client.call("sheet_file", { id: source.id, kind });
      const row = db.handle().prepare("SELECT kind, project_id, body FROM notes WHERE id = ?").get(filed[kind].note.id);
      check(`filed as ${kind}: the note row`, [row.kind, row.project_id], [kind, project.id]);
      check(`filed as ${kind}: the entry points at it`,
            [filed[kind].entry.note_id, filed[kind].entry.note_kind, filed[kind].entry.promoted], [filed[kind].note.id, kind, 1]);
      check(`filed as ${kind}: the footer`, row.body.endsWith(`\n\nFrom task #${task.id}, entry ${source.id}`), true);
    }
    check("a decision note carries the question and the options",
          db.handle().prepare("SELECT body FROM notes WHERE id = ?").get(filed.decision.note.id).body.startsWith("retry strategy\n\n[a] exponential\n[b] fixed\n\nChosen: [a] exponential"), true);
    check("filing twice returns the first note",
          (await client.call("sheet_file", { id: filed.gotcha.entry.id, kind: "gotcha" })).note.id, filed.gotcha.note.id);
    await rejects("an unknown note kind", client.call("sheet_file", { id: say.id, kind: "rumour" }), /kind must be one of/);
    // The app rebuilds the graph when it sees an agent's write; do the same.
    oracle.rebuild(db.handle());
    const found = await client.call("oracle_ask", { question: `what do we know about ${unique}` });
    check("a filed note appears in oracle_ask", found.notes.map((n) => n.id).includes(filed.gotcha.note.id), true);
    check("every filed note does", ["decision", "gotcha", "reference", "note"].filter((k) => k !== "decision")
      .every((k) => found.notes.some((n) => n.id === filed[k].note.id)), true);

    section(`${name}: reading`);
    const full = await client.call("sheet_read", { task_id: task.id, mode: "full" });
    check("full reads every entry", full.entries.length, full.total);
    check("the task", full.task, { id: task.id, title: task.title, status: "todo", project: "mcp-sheet" });
    check("the text carries ids", full.text.includes(`{id:${say.id}`), true);
    const ledger = await client.call("sheet_read", { task_id: task.id, mode: "ledger" });
    check("ledger mode is the promoted entries plus a decided ask",
          ledger.entries.every((e) => e.promoted === 1 || e.id === ask.id) && ledger.entries.some((e) => e.id === ask.id), true);
    check("ledger_count is the size of the ledger", full.ledger_count, ledger.entries.length);
    const tail = await client.call("sheet_read", { task_id: task.id, n: 3 });
    check("tail is the default, and n is honoured", [tail.mode, tail.entries.map((e) => e.id)], ["tail", full.entries.slice(-3).map((e) => e.id)]);
    await rejects("an unknown mode", client.call("sheet_read", { task_id: task.id, mode: "some" }), /mode must be/);

    const cursor = full.cursor;
    check("the cursor starts after the last entry", cursor.after_id, full.entries[full.entries.length - 1].id);
    check("since is server time", /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(cursor.since), true);
    const fresh = await client.call("sheet_append", { task_id: task.id, kind: "say", body: "new since the cursor" });
    const polled = await client.call("sheet_read", { task_id: task.id, after_id: cursor.after_id });
    check("after_id returns only the new entry", polled.entries.map((e) => e.id), [fresh.id]);
    check("and moves the cursor on", polled.cursor.after_id, fresh.id);
    const empty = await client.call("sheet_read", { task_id: task.id, after_id: fresh.id });
    check("nothing new is nothing, and the cursor holds", [empty.entries.length, empty.cursor.after_id], [0, fresh.id]);
    db.handle().prepare("UPDATE comments SET updated_at = datetime('now', '-1 hour')").run();
    const later = (await client.call("sheet_read", { task_id: task.id, mode: "full" })).cursor.since;
    await client.call("sheet_update", { id: say.id, body: "edited after the cursor" });
    const changed = await client.call("sheet_read", { task_id: task.id, after_id: fresh.id, since: later });
    check("since returns an edited entry too", changed.entries.map((e) => e.id), [say.id]);

    section(`${name}: resolving`);
    for (const ref of [String(task.id), `T-${task.id}`, `MCP-${task.id}`, `mcp-${task.id}`, `#${task.id}`]) {
      check(`resolves ${ref}`, (await client.call("sheet_resolve", { task: ref })).task.id, task.id);
    }
    const resolved = await client.call("sheet_resolve", { task: String(task.id) });
    check("the folder is the project's", [resolved.cwd, resolved.cwd_source], [folder, "folder"]);
    check("logs go beside the database", resolved.log_dir, path.join(dir, "sheets"));
    check("no Workbench yet", resolved.workbench, null);
    const nowhere = await client.call("sheet_resolve", { task: String(orphan.id) });
    check("a task with no project has no folder", [nowhere.cwd, nowhere.cwd_source], [null, null]);
    await rejects("an unknown task", client.call("sheet_resolve", { task: "NOPE-1" }), /No task matches/);

    section(`${name}: the audit trail`);
    const audit = db.handle().prepare(
      "SELECT action, entity, summary FROM audit WHERE entity_id IN (?, ?) AND entity IN ('task', 'note') AND id > 0 ORDER BY id"
    ).all(task.id, filed.gotcha.note.id).map((r) => `${r.action} ${r.entity} ${r.summary}`);
    for (const want of [
      "update task commented (by claude-code:9)",
      "update task noted (by claude-code:9)",
      "update task ran npm test (by claude-code:9)",
      "update task finished npm test: ok (by claude-code:9)",
      `update task edited entry ${say.id} (by claude-code:9)`,
      `update task promoted entry ${say.id} (by claude-code:9)`,
      `update task unpromoted entry ${say.id} (by claude-code:9)`,
      'update task asked "retry strategy" (by claude-code:9)',
      `update task decided a on ${ask.id} (by claude-code:9)`,
      `update task filed entry ${filed.gotcha.entry.id} as gotcha (by claude-code:9)`,
      "create note created (by claude-code:9)",
    ]) {
      check(`audit: ${want}`, audit.includes(want), true);
    }

    section(`${name}: what an agent is handed`);
    const busy = db.createTask({ projectId: project.id, title: `busy over ${name}` });
    const busyIds = [];
    for (let i = 0; i < 30; i++) {
      const e = await client.call("sheet_append", { task_id: busy.id, kind: "say", body: `step ${i}`, promote: i === 2 });
      busyIds.push(e.id);
    }
    const got = await client.call("get_task", { id: busy.id });
    check("get_task: the ledger plus the last 20", got.comments.map((c) => c.id), [busyIds[2], ...busyIds.slice(10)]);
    check("get_task: counts", [got.comments_total, got.comments_shown], [30, 21]);
    check("get_task: the old fields are kept", Object.keys(got.comments[0]).filter((k) => ["author", "body", "created_at"].includes(k)), ["author", "body", "created_at"]);
    check("get_task: and the new ones", [got.comments[0].kind, got.comments[0].promoted, got.comments[0].author_type], ["say", 1, "agent"]);
    check("get_task: the clean text", got.sheet.startsWith(`---\ntask: ${busy.id}\n`) && got.sheet.includes("@ claude-code:9: step 2\n") && !got.sheet.includes("{id:"), true);
    check("get_task: step 5 is left out", got.sheet.includes("step 5\n"), false);

    db.setQueue(busy.id, `q-${name.replace(/[^a-z]/g, "")}`);
    const claim = await client.call("queue_next", { queue: `q-${name.replace(/[^a-z]/g, "")}` });
    check("queue_next: the same context", [claim.claimed, claim.comments.length, claim.comments_total, typeof claim.sheet], [busy.id, 21, 30, "string"]);
    await client.call("queue_release", { task_id: busy.id, reason: "need a key I do not have" });
    const released = db.handle().prepare("SELECT body, promoted, kind, author_type FROM comments WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(busy.id);
    check("queue_release: its reason is promoted", { ...released }, { body: "Released: need a key I do not have", promoted: 1, kind: "say", author_type: "agent" });
    await client.call("queue_next", { queue: `q-${name.replace(/[^a-z]/g, "")}` });
    await client.call("queue_complete", { task_id: busy.id, summary: "rotated the key and replayed the DLQ" });
    const summary = db.handle().prepare("SELECT body, promoted, kind FROM comments WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(busy.id);
    check("queue_complete: its summary is promoted", { ...summary }, { body: "rotated the key and replayed the DLQ", promoted: 1, kind: "say" });
    const after = await client.call("sheet_read", { task_id: busy.id, mode: "ledger" });
    check("and the ledger shows it", after.entries[after.entries.length - 1].body, "rotated the key and replayed the DLQ");
    // Both shapes of the queue queries, with and without a project: the
    // project placeholder is conditional, and sql() now refuses a spare value.
    check("queue_status for the pool", Array.isArray((await client.call("queue_status", {})).waiting), true);
    check("queue_status for one project", Array.isArray((await client.call("queue_status", { project_id: project.id })).waiting), true);
    check("queue_next for one project", (await client.call("queue_next", { queue: "nothing-here", project: "mcp-sheet" })).claimed, null);
    const comment = await client.call("add_comment", { task_id: busy.id, body: "old style" });
    check("add_comment writes a typed say", [comment.kind, comment.author_type], ["say", "agent"]);
  } finally {
    client.close();
  }
}

/**
 * A request whose bytes arrive in two pipe reads, split inside a multibyte
 * character. The server used to decode each read alone.
 */
function splitWrite(env) {
  const { spawn } = require("child_process");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "agent", "mcp_server.js")], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DELPHI_ACTOR: "split-test", ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => {
      const reply = out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2);
      resolve(reply && reply.result ? JSON.parse(reply.result.content[0].text) : reply);
    });
    const task = db.createTask({ projectId: project.id, title: "split" });
    const body = "caf\u00e9 \u{1F680} done";
    const request = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "sheet_append", arguments: { task_id: task.id, kind: "say", body } } }) + "\n");
    for (const cut of [request.indexOf(Buffer.from("\u00e9")) + 1]) {
      child.stdin.write(request.subarray(0, cut));
      setTimeout(() => { child.stdin.write(request.subarray(cut)); child.stdin.end(); }, 300);
    }
  });
}

async function main() {
  await route("node:sqlite", {});
  await route("sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" });

  section("a multibyte character split across two reads");
  for (const [name, env] of [["node:sqlite", {}], ["sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" }]]) {
    const entry = await splitWrite(env);
    check(`${name}: stored whole`, entry && entry.body, "caf\u00e9 \u{1F680} done");
  }
  console.log(`\n${checks - failures}/${checks} checks passed`);
  db.close && db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
