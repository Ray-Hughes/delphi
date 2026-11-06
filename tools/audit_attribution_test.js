#!/usr/bin/env node
// Who made each change, through the real agent/mcp_server.js, on both routes.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/audit_attribution_test.js
//
// Every write tool leaves History rows with actor, actor type, session and
// step as columns, and both sides of the change: before and after for an
// update, after for a create. The pad sync records everything it changes.
// The regression this exists for: an agent's pad rewrite was recorded with no
// previous state, so it could not be undone, on a database where all 113 of
// them were like that.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-attribution-"));
process.env.DELPHI_DATA_DIR = dir;
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const { openServer } = require("../sheet/client");
const auditLib = require("../agent/audit");

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}
function section(name) { console.log(`\n${name}`); }
const all = (text, ...params) => db.handle().prepare(text).all(...params);
const one = (text, ...params) => db.handle().prepare(text).get(...params);
const json = (text) => (text == null ? null : JSON.parse(text));
const newRows = (since) => all("SELECT * FROM audit WHERE id > ? ORDER BY id", since);
const lastId = () => Number((one("SELECT COALESCE(MAX(id), 0) AS n FROM audit") || {}).n);

delete process.env.ELECTRON_RUN_AS_NODE;

async function client(actor, env) {
  const c = openServer({ actor, env, clientName: "test", warn: () => {} });
  await c.start();
  return c;
}

section("identity, from the environment");
{
  const id = (env) => auditLib.identity(env, { inferType: () => "agent" });
  check("a tab's agent is its session", [id({ DELPHI_ACTOR: "claude-code:7" }).session_id, id({ DELPHI_ACTOR: "claude-code:7" }).job_id], [7, null]);
  check("the Sheet chat names a task, not a session", id({ DELPHI_ACTOR: "claude-code:chat-9" }).session_id, null);
  check("a job is its job, not a session", [id({ DELPHI_ACTOR: "codex:job-12" }).session_id, id({ DELPHI_ACTOR: "codex:job-12" }).job_id], [null, 12]);
  check("a second opinion is neither", [id({ DELPHI_ACTOR: "copilot:second-opinion" }).session_id, id({ DELPHI_ACTOR: "copilot:second-opinion" }).job_id], [null, null]);
  check("DELPHI_SESSION and DELPHI_JOB win over the name", [id({ DELPHI_ACTOR: "claude-code:7", DELPHI_SESSION: "3", DELPHI_JOB: "4" }).session_id, id({ DELPHI_ACTOR: "x", DELPHI_JOB: "4" }).job_id], [3, 4]);
  check("a declared type is kept", id({ DELPHI_ACTOR: "ray", DELPHI_AUTHOR_TYPE: "human" }).actor_type, "human");
}

async function route(name, routeEnv) {
  const tag = name.replace(/[^a-z]/g, "");
  const P = db.createProject({ key: `p-${tag}`, name: `P ${tag}` });
  const agent = await client("claude-code:7", { DELPHI_AUTHOR_TYPE: "agent", ...routeEnv });
  // Each row an agent call wrote: by it, in its session, sharing one step.
  const attributed = (what, rows) => {
    check(`${what}: wrote History`, rows.length > 0, true);
    check(`${what}: every row is the agent's, in session 7`,
      rows.every((r) => r.actor === "claude-code:7" && r.actor_type === "agent" && r.session_id === 7), true);
    check(`${what}: one step for the call`, new Set(rows.map((r) => r.step)).size === 1 && Boolean(rows[0].step), true);
    check(`${what}: the suffix is still written for older readers`, rows.every((r) => / \(by claude-code:7\)$/.test(r.summary)), true);
    for (const r of rows) {
      if (r.action === "update") check(`${what}: ${r.entity} ${r.summary} has both sides`, Boolean(r.before_json && r.after_json), true);
      if (r.action === "create" && r.entity !== "handoff") check(`${what}: ${r.entity} create has its after`, Boolean(r.after_json), true);
    }
  };
  try {
    section(`${name}: whoami`);
    const me = await agent.call("whoami", {});
    check("says the session", me.session_id, 7);

    section(`${name}: every write tool`);
    let mark = lastId();
    const proj = await agent.call("add_project", { key: `made-${tag}`, name: `Made ${tag}` });
    attributed("add_project", newRows(mark));
    check("add_project's after is the project", json(newRows(mark)[0].after_json).key, proj.key);

    mark = lastId();
    const t = await agent.call("add_task", { title: "first", project_id: P.id });
    let rows = newRows(mark);
    attributed("add_task", rows);
    check("add_task's after is the row", [json(rows[0].after_json).id, json(rows[0].after_json).title], [t.id, "first"]);
    check("and its opening status was written", one("SELECT COUNT(*) AS n FROM status_events WHERE task_id = ?", t.id).n, 1);

    mark = lastId();
    await agent.call("update_task", { id: t.id, title: "second", status: "doing" });
    rows = newRows(mark);
    attributed("update_task", rows);
    check("update_task's sides", [json(rows[0].before_json).title, json(rows[0].after_json).title, json(rows[0].after_json).status], ["first", "second", "doing"]);
    check("and its status event", one("SELECT status FROM status_events WHERE task_id = ? ORDER BY id DESC LIMIT 1", t.id).status, "doing");

    mark = lastId();
    const c = await agent.call("add_comment", { task_id: t.id, body: "a remark" });
    rows = newRows(mark);
    attributed("add_comment", rows);
    check("the comment carries the session", one("SELECT session_id FROM comments WHERE id = ?", c.id).session_id, 7);
    check("its row names the entry in __op", json(rows[0].before_json).__op, { kind: "sheet_append", comment_id: c.id });

    mark = lastId();
    const e = await agent.call("sheet_append", { task_id: t.id, kind: "say", body: "on the Sheet" });
    attributed("sheet_append", newRows(mark));
    check("the entry carries the session", one("SELECT session_id FROM comments WHERE id = ?", e.id).session_id, 7);

    mark = lastId();
    await agent.call("sheet_update", { id: e.id, body: "on the Sheet, edited" });
    rows = newRows(mark);
    attributed("sheet_update", rows);
    check("sheet_update keeps the words before and after", [json(rows[0].before_json).__op.before.body, json(rows[0].after_json).__op.after.body],
      ["on the Sheet", "on the Sheet, edited"]);

    mark = lastId();
    await agent.call("sheet_promote", { id: e.id });
    attributed("sheet_promote", newRows(mark));

    mark = lastId();
    const filed = await agent.call("sheet_file", { id: e.id, kind: "gotcha" });
    rows = newRows(mark);
    attributed("sheet_file", rows);
    check("sheet_file records the note and the entry pointing at it", rows.map((r) => r.entity).sort(), ["note", "task"]);
    check("the entry points at the note", one("SELECT note_id FROM comments WHERE id = ?", e.id).note_id, filed.note.id);

    mark = lastId();
    const ask = await agent.call("sheet_ask", { task_id: t.id, question: "which way?", options: ["left", "right"] });
    attributed("sheet_ask", newRows(mark));
    mark = lastId();
    await agent.call("sheet_decide", { ask_id: ask.id, choice: "a" });
    attributed("sheet_decide", newRows(mark));

    mark = lastId();
    await agent.call("add_note", { project_id: P.id, title: "a gotcha", body: "watch out" });
    attributed("add_note", newRows(mark));

    section(`${name}: the queue`);
    const q = db.createTask({ projectId: P.id, title: "queued" });
    db.setQueue(q.id, `ready-${tag}`);
    mark = lastId();
    const claimed = await agent.call("queue_next", { queue: `ready-${tag}` });
    rows = newRows(mark);
    check("queue_next claimed it", claimed.claimed, q.id);
    attributed("queue_next", rows);
    check("its sides show the claim", [json(rows[0].before_json).claimed_by, json(rows[0].after_json).claimed_by, json(rows[0].after_json).status],
      [null, "claude-code:7", "doing"]);
    mark = lastId();
    const empty = await agent.call("queue_next", { queue: `ready-${tag}` });
    check("an empty queue writes nothing", [empty.claimed, newRows(mark).length], [null, 0]);
    mark = lastId();
    await agent.call("queue_extend", { task_id: q.id, minutes: 45 });
    attributed("queue_extend", newRows(mark));
    mark = lastId();
    await agent.call("queue_release", { task_id: q.id, reason: "stuck" });
    rows = newRows(mark);
    attributed("queue_release", rows);
    check("release records the task and its Sheet entry apart", rows.map((r) => json(r.before_json).__op ? "entry" : "task"), ["task", "entry"]);
    await agent.call("queue_next", { queue: `ready-${tag}` });
    mark = lastId();
    await agent.call("queue_complete", { task_id: q.id, summary: "done it" });
    attributed("queue_complete", newRows(mark));

    section(`${name}: the pad and its sync`);
    mark = lastId();
    const pad = await agent.call("write_scratchpad", { project_id: P.id, key: `plan-${tag}`, title: "plan", body: "- [ ] alpha\n  - [ ] beta\n" });
    rows = newRows(mark);
    attributed("write_scratchpad, a new pad", rows);
    check("the pad and both tasks it derived", rows.map((r) => `${r.action} ${r.entity}`), ["create scratchpad", "create task", "create task"]);
    const padRow = rows.find((r) => r.entity === "scratchpad");
    check("the pad's recorded after has the anchors the sync wrote", json(padRow.after_json).body, one("SELECT body FROM scratchpads WHERE id = ?", pad.id).body);
    const [alpha, beta] = pad.tasks;
    check("the subtask's recorded after has its parent", json(rows[2].after_json).parent_id, alpha.id);
    const anchored = one("SELECT body FROM scratchpads WHERE id = ?", pad.id).body;

    mark = lastId();
    const rewritten = anchored.replace("alpha", "alpha renamed").replace("- [ ] alpha", "- [x] alpha");
    await agent.call("write_scratchpad", { project_id: P.id, key: `plan-${tag}`, title: "plan", body: rewritten });
    rows = newRows(mark);
    attributed("write_scratchpad, a rewrite", rows);
    const titleRow = rows.find((r) => r.entity === "task");
    check("the sync records a title it changed, not only a status", titleRow && /title changed/.test(titleRow.summary), true);
    check("with the task before and after", titleRow && [json(titleRow.before_json).title, json(titleRow.after_json).title], ["alpha", "alpha renamed"]);

    mark = lastId();
    await agent.call("append_scratchpad", { id: pad.id, text: "- [ ] gamma" });
    attributed("append_scratchpad", newRows(mark));
    mark = lastId();
    await agent.call("patch_scratchpad", { id: pad.id, heading: "Notes", text: "words" });
    attributed("patch_scratchpad", newRows(mark));

    section(`${name}: an agent's pad rewrite is one undo away`);
    const before = one("SELECT body FROM scratchpads WHERE id = ?", pad.id).body;
    mark = lastId();
    await agent.call("write_scratchpad", { project_id: P.id, key: `plan-${tag}`, title: "plan", body: "# replaced by a bad plan\n" });
    const rewrite = newRows(mark).find((r) => r.entity === "scratchpad");
    check("the rewrite has the old body", json(rewrite.before_json).body, before);
    let undoError = null;
    try { db.undo(rewrite.id); } catch (error) { undoError = error.message; }
    check("and undoing it works", undoError, null);
    check("the pad is back", one("SELECT body FROM scratchpads WHERE id = ?", pad.id).body, before);
    check("the tasks were never deleted", one("SELECT COUNT(*) AS n FROM tasks WHERE id IN (?, ?)", alpha.id, beta.id).n, 2);
  } finally {
    agent.close();
  }

  section(`${name}: a chat and a job are not sessions`);
  const chat = await client("claude-code:chat-9", { DELPHI_AUTHOR_TYPE: "agent", ...routeEnv });
  try {
    const mark = lastId();
    await chat.call("add_task", { title: "from a chat", project_id: P.id });
    const r = newRows(mark)[0];
    check("a Sheet chat's write has no session", [r.actor, r.session_id], ["claude-code:chat-9", null]);
  } finally { chat.close(); }
  const asker = db.createSession({ projectId: P.id, title: "asker", harness: "claude-code" });
  const job = db.handle().prepare(`INSERT INTO handoffs (project_id, from_session_id, to_harness, request) VALUES (?, ?, 'codex', 'look') RETURNING id`).get(P.id, asker.id);
  const worker = await client(`codex:job-${job.id}`, { DELPHI_AUTHOR_TYPE: "agent", ...routeEnv });
  try {
    const mark = lastId();
    await worker.call("add_task", { title: "from a job", project_id: P.id });
    const r = newRows(mark)[0];
    check("a job's write carries the job and the session that asked for it", [r.job_id, r.session_id], [job.id, asker.id]);
  } finally { worker.close(); }
}

section("the window");
{
  const W = db.createProject({ key: "window", name: "Window" });
  const t = db.createTask({ projectId: W.id, title: "typed" });
  const r = one("SELECT * FROM audit WHERE entity = 'task' AND entity_id = ? AND action = 'create'", t.id);
  check("a person's write is theirs, with no session", [r.actor, r.actor_type, r.session_id, Boolean(r.step)], ["you", "human", null, true]);
  check("History lists the columns", Object.keys(db.listAudit(1)[0]).filter((k) => ["actor", "actor_type", "session_id", "job_id", "step", "legacy"].includes(k)).length, 6);
}

(async () => {
  await route("node:sqlite", {});
  await route("sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" });
  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
