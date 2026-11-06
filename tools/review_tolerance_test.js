#!/usr/bin/env node
// A database a newer Delphi wrote, with a status this version does not know.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/review_tolerance_test.js
//
// v2 adds In review as a fifth status by rebuilding `tasks`. Someone who
// downgrades keeps that database, so 1.7.x has to read it without harm: the
// task lists, it sorts with the work in progress rather than with done, and no
// queue lists it as waiting or hands it to an agent. The six queue filters name
// the statuses an agent may take, rather than excluding the ones it may not,
// because an exclusion lets every status nobody has invented yet through.
//
// The fixture writes `review` with CHECK constraints ignored on that one
// connection, which is the nearest this schema can come to the rebuilt one.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-review-tolerance-"));
process.env.DELPHI_DATA_DIR = dir;
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const { openServer } = require("../sheet/client");
const { createDispatcher } = require("../agent/dispatch");

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

/** Writes a status the CHECK would refuse, the way a rebuilt v2 table holds it. */
function forceStatus(id, status) {
  const h = db.handle();
  h.exec("PRAGMA ignore_check_constraints = ON");
  try { h.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, id); }
  finally { h.exec("PRAGMA ignore_check_constraints = OFF"); }
}

delete process.env.ELECTRON_RUN_AS_NODE;

/** One task in each status, all in the ready queue, in a project of its own. */
function fixture(key) {
  const p = db.createProject({ key, name: `Review ${key}` });
  const make = (title, status) => {
    const t = db.createTask({ projectId: p.id, title });
    if (status !== "todo") forceStatus(t.id, status);
    db.setQueue(t.id, "ready");
    return t.id;
  };
  // In this order so the ids alone would sort them differently: id DESC is
  // the last tie-break, and the order checks have to prove the status rank.
  const ids = {
    todo: make("waiting to start", "todo"),
    doing: make("in progress", "doing"),
    blocked: make("blocked", "blocked"),
    review: make("in review", "review"),
    done: make("finished", "done"),
  };
  return { p, ids, order: [ids.doing, ids.review, ids.blocked, ids.todo, ids.done] };
}

async function route(name, routeEnv) {
  const tag = name.replace(/[^a-z]/g, "");

  section(`${name}: the app (db.js)`);
  {
    const { p, ids, order } = fixture(`rv-app-${tag}`);
    const listed = db.listTasks({ projectId: p.id, includeDone: true }).map((t) => t.id);
    check("listTasks sorts review straight after doing, before blocked, todo and done", listed, order);
    const state = db.queueState("ready", p.id);
    check("queueState lists only todo and doing as waiting", state.waiting.map((t) => t.id).sort(), [ids.todo, ids.doing].sort());
    const claimed = [];
    for (let i = 0; i < 4; i++) {
      const c = db.claimNext({ queue: "ready", agent: `app-${tag}`, projectId: p.id });
      if (!c) break;
      claimed.push(c.task.id);
    }
    check("claimNext hands out todo and doing, and never review", claimed.sort(), [ids.todo, ids.doing].sort());
  }

  section(`${name}: the server`);
  const { p, ids, order } = fixture(`rv-mcp-${tag}`);
  const agent = openServer({ actor: `claude-code:${tag}`, env: { DELPHI_AUTHOR_TYPE: "agent", ...routeEnv }, clientName: "test", warn: () => {} });
  await agent.start();
  try {
    const tasks = (await agent.call("list_tasks", { project_id: p.id, include_done: true })).map((t) => t.id);
    check("list_tasks sorts review straight after doing", tasks, order);
    // recall.js ranks a project's tasks in oracle_context; review used to
    // fall through to todo's rank there.
    const ctx = await agent.call("oracle_context", { name: p.name, limit: 10 });
    check("oracle_context ranks review straight after doing", ctx.tasks.map((t) => t.id).slice(0, 2), [ids.doing, ids.review]);
    const status = await agent.call("queue_status", { queue: "ready", project_id: p.id });
    check("queue_status lists only todo and doing as waiting", status.waiting.map((t) => t.id).sort(), [ids.todo, ids.doing].sort());
    const got = [];
    for (let i = 0; i < 4; i++) {
      const next = await agent.call("queue_next", { queue: "ready", project_id: p.id });
      if (!next || !next.task) break;
      got.push(next.task.id);
    }
    check("queue_next hands out todo and doing, and never review", got.sort(), [ids.todo, ids.doing].sort());
    check("the review task is still review, unclaimed", { ...db.handle().prepare("SELECT status, claimed_by FROM tasks WHERE id = ?").get(ids.review) }, { status: "review", claimed_by: null });
  } finally {
    agent.close();
  }
}

function dispatcher() {
  section("the dispatcher's queue filing (agent/dispatch.js)");
  const p = db.createProject({ key: "rv-dispatch", name: "Review dispatch" });
  db.seedHarnesses(require("../harness").BUILTINS);
  const harness = db.listHarnesses().find((h) => h.enabled);
  check("there is an enabled harness to queue for", Boolean(harness), true);
  if (!harness) return;
  const make = (title, status) => {
    const t = db.createTask({ projectId: p.id, title });
    if (status !== "todo") forceStatus(t.id, status);
    db.setQueue(t.id, harness.key);
    // Queued by an agent, so the job it becomes waits for approval and no
    // agent CLI is ever started by this test.
    db.handle().prepare("UPDATE tasks SET queued_by = 'agent-x', queued_by_type = 'agent' WHERE id = ?").run(t.id);
    return t.id;
  };
  const todo = make("for the agent", "todo");
  const review = make("waiting on a review", "review");
  // Nothing may start: the only point of the tick here is fileQueued.
  const d = createDispatcher({ sql: db.sqlP, settings: () => ({ jobConcurrency: 1, jobHarnessLimits: {} }), log: () => {} });
  try { d.tick(); } finally { if (d.close) d.close(); }
  const jobsFor = (id) => db.handle().prepare("SELECT COUNT(*) AS n FROM handoffs WHERE task_id = ?").get(id).n;
  check("the todo task became a job, waiting for approval", [jobsFor(todo), db.handle().prepare("SELECT state FROM handoffs WHERE task_id = ?").get(todo)?.state], [1, "needs_approval"]);
  check("the review task did not", jobsFor(review), 0);
  check("and it is still in its queue", db.handle().prepare("SELECT queue FROM tasks WHERE id = ?").get(review).queue, harness.key);
}

async function main() {
  await route("node:sqlite", {});
  await route("sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" });
  dispatcher();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
