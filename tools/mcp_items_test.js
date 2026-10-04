#!/usr/bin/env node
// The items and flag tools, through the real agent/mcp_server.js, on both routes.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/mcp_items_test.js
//
// What an agent may do: flag an item, propose where it belongs, list flags,
// and move a task it filed itself in the last day (owner decision D2). What it
// may not: approve, which is not in the tool list, is refused without the
// command line's client name, and is refused by the store for an agent even
// with it. Every write is checked for its History row in DELPHI_ACTOR's name.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-mcp-items-"));
process.env.DELPHI_DATA_DIR = dir;
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const { openServer } = require("../sheet/client");

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
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
const one = (text, ...params) => db.handle().prepare(text).get(...params);

delete process.env.ELECTRON_RUN_AS_NODE;

async function client(actor, env, clientName = "test") {
  const c = openServer({ actor, env, clientName, warn: () => {} });
  await c.start();
  return c;
}

async function route(name, routeEnv) {
  const tag = name.replace(/[^a-z]/g, "");
  const A = db.createProject({ key: `a-${tag}`, name: `Alpha ${tag}` });
  const B = db.createProject({ key: `b-${tag}`, name: `Beta ${tag}` });
  const agent = await client(`claude-code:${tag}`, { DELPHI_AUTHOR_TYPE: "agent", ...routeEnv });
  try {
    section(`${name}: the tool list`);
    const listed = (await agent.request("tools/list", {})).tools.map((t) => t.name);
    check("flag_item, propose_move and list_flags are offered", ["flag_item", "propose_move", "list_flags"].every((n) => listed.includes(n)), true);
    check("no approve of any kind is offered", listed.filter((n) => /decide|approve|apply/.test(n) && n !== "sheet_decide"), []);
    await rejects("there is no flag_decide tool at all", agent.call("flag_decide", { flag_id: 1, decision: "approve" }), /Unknown tool flag_decide/);

    section(`${name}: an agent moving its own new task (D2)`);
    const epic = db.createOrganizer({ projectId: A.id, name: "epic" });
    const own = await agent.call("add_task", { title: "filed in the wrong place", project_id: A.id });
    db.handle().prepare("UPDATE tasks SET organizer_id = ? WHERE id = ?").run(epic.id, own.id);
    const ownKid = await agent.call("add_task", { title: "its subtask", parent_id: own.id });
    const moved = await agent.call("update_task", { id: own.id, project_id: B.id, priority: "high" });
    check("it moves, with the other fields", [moved.project_id, moved.priority], [B.id, "high"]);
    check("its subtask follows", one("SELECT project_id FROM tasks WHERE id = ?", ownKid.id).project_id, B.id);
    check("and the epic in the project it left is cleared", moved.organizer_id, null);
    check("the move is in History under the agent's name",
      /^moved from Alpha \w+ to Beta \w+ \(by claude-code:\w+\)$/.test(one("SELECT summary FROM audit WHERE entity = 'task' AND entity_id = ? AND summary LIKE 'moved%' ORDER BY id DESC", own.id).summary), true);
    const theirs = db.createTask({ projectId: A.id, title: "a person's task" });
    await rejects("someone else's task is refused, pointing at flag_item", agent.call("update_task", { id: theirs.id, project_id: B.id }), /not filed by you in the last 24 hours.*flag_item/);
    db.handle().prepare("UPDATE audit SET at = datetime('now', '-2 days') WHERE entity = 'task' AND entity_id = ? AND action = 'create'").run(own.id);
    await rejects("and so is its own task once a day has passed", agent.call("update_task", { id: own.id, project_id: A.id }), /flag_item/);

    section(`${name}: flag and propose, never apply`);
    const n = db.createNote({ projectId: A.id, title: "a misfiled note", body: "about Beta" });
    const flagged = await agent.call("flag_item", { entity: "note", id: n.id, note: "I think this is Beta's" });
    check("a flag comes back with its id", typeof flagged.flag_id, "number");
    check("flagging is in History under the agent's name", /^flagged for review: .*\(by claude-code:\w+\)$/.test(one("SELECT summary FROM audit WHERE entity = 'note' AND entity_id = ? ORDER BY id DESC", n.id).summary), true);
    const proposal = await agent.call("propose_move", { flag_id: flagged.flag_id, ops: [{ op: "move", entity: "note", id: n.id, to: B.id, keepInSource: true }], reasoning: "It is about Beta.", confidence: 0.8 });
    check("the proposal is recorded with its plan", [proposal.status, proposal.plan[0].ok], ["proposed", true]);
    check("nothing moved", one("SELECT project_id FROM notes WHERE id = ?", n.id).project_id, A.id);
    const flags = await agent.call("list_flags", { project_id: A.id });
    check("list_flags shows it with the proposal in a line", flags.map((f) => [f.id, f.status, /move to Beta/.test(f.proposal || "")]), [[flagged.flag_id, "proposed", true]]);
    const bad = await agent.call("propose_move", { entity: "note", id: n.id, ops: [{ op: "move", entity: "note", id: n.id, to: A.id }], reasoning: "x" });
    check("a second proposal on the same item joins its flag, refusal shown", [bad.flag_id, bad.plan[0].ok, /already lives in Alpha/.test(bad.plan[0].refusals[0])], [flagged.flag_id, false, true]);

    section(`${name}: no decision through the server, whoever asks`);
    for (const [who, env] of [["an agent", { DELPHI_AUTHOR_TYPE: "agent" }], ["a person, by its type", { DELPHI_AUTHOR_TYPE: "human" }]]) {
      const c = await client(who === "an agent" ? `claude-code:${tag}` : "ray", { ...env, ...routeEnv }, "delphi-cli");
      try {
        await rejects(`${who} behind the command line's client name finds no decide tool`, c.call("flag_decide", { flag_id: flagged.flag_id, decision: "approve" }), /Unknown tool flag_decide/);
      } finally { c.close(); }
    }
    check("the flag is still proposed and nothing moved", [one("SELECT status FROM item_flags WHERE id = ?", flagged.flag_id).status,
      one("SELECT project_id FROM notes WHERE id = ?", n.id).project_id], ["proposed", A.id]);

    section(`${name}: what an agent reads includes what is shown from elsewhere`);
    db.items().associate("task", theirs.id, B.id);
    const inB = await agent.call("list_tasks", { project_id: B.id });
    check("an associated task is listed with its home", (inB.find((t) => t.id === theirs.id) || {}).home, `a-${tag}`);
    check("a task homed there has no home field", "home" in (inB.find((t) => t.id === own.id) || { home: 1 }), false);
    const pad = db.createScratchpad({ projectId: A.id, title: "shared pad", key: `shared-${tag}`, body: "hello", derivesTasks: false });
    db.items().associate("scratchpad", pad.id, B.id);
    const pads = await agent.call("list_scratchpads", { project_id: B.id });
    check("list_scratchpads includes it with its home", (pads.find((p) => p.id === pad.id) || {}).home, `a-${tag}`);
    const read = await agent.call("read_scratchpad", { project_id: B.id, key: `shared-${tag}` });
    check("read_scratchpad by key finds the associated pad", read.id, pad.id);
    db.items().associate("note", n.id, B.id);
    const found = await agent.call("search", { query: "misfiled", detail: "full" });
    check("search says where else a note is shown", (found.notes.find((x) => x.id === n.id) || {}).also_in, `Beta ${tag}`);
  } finally {
    agent.close();
  }
}

// bin/delphi flags, as a separate process the way a person's shell runs it.
function cli() {
  section("delphi flags");
  const { spawnSync } = require("child_process");
  const run = (args, env = {}) => {
    const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", DELPHI_ACTOR: "ray", DELPHI_AUTHOR_TYPE: "human", ...env };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "delphi"), ...args], { env: childEnv, encoding: "utf8", timeout: 60000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const P = db.createProject({ key: "cli-p", name: "CLI P" });
  const Q = db.createProject({ key: "cli-q", name: "CLI Q" });
  const n = db.createNote({ projectId: P.id, title: "cli note", body: "x" });
  const f = db.items().flag({ entity: "note", id: n.id, note: "?", evaluate: "none" }).flag;
  db.items().propose({ flagId: f.id, ops: [{ op: "move", entity: "note", id: n.id, to: Q.id }], reasoning: "it is Q's" });
  const listed = run(["flags", "--project", "cli-p"]);
  check("list shows the flag and its proposal", [listed.code, new RegExp(`#${f.id} proposed .*cli note.*move to CLI Q`).test(listed.out)], [0, true]);
  // The command line never decides, for anyone: it cannot tell a person
  // from an agent that sets DELPHI_ACTOR and DELPHI_AUTHOR_TYPE to look like one.
  for (const [what, args, env] of [
    ["approve, as a person", ["flags", "approve", String(f.id), "--note", "yes"], {}],
    ["reject, as a person", ["flags", "reject", String(f.id), "no"], {}],
    ["approve, as an agent", ["flags", "approve", String(f.id)], { DELPHI_AUTHOR_TYPE: "agent" }],
    ["approve with options first", ["flags", "--all", "approve", String(f.id)], {}],
  ]) {
    const r = run(args, env);
    check(`delphi flags ${what}: says where, exits 1`, [r.code, r.err.trim()], [1, "delphi: Approve or reject this in the Delphi window."]);
  }
  check("and nothing changed", [one("SELECT status FROM item_flags WHERE id = ?", f.id).status, one("SELECT project_id FROM notes WHERE id = ?", n.id).project_id], ["proposed", P.id]);
  // The review's forge: an agent proposes, then approves through the command
  // line with options before the verb and a person's type claimed or left out.
  const n2 = db.createNote({ projectId: P.id, title: "forged", body: "x" });
  const agentEnv = { DELPHI_ACTOR: "claude:1", DELPHI_AUTHOR_TYPE: "agent" };
  const server = (calls, env) => {
    const lines = calls.map(([name, args], i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: args } }));
    const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...env };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "agent", "mcp_server.js")], { env: childEnv, input: lines.join("\n") + "\n", encoding: "utf8" });
    return r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };
  const [made] = server([["propose_move", { entity: "note", id: n2.id, ops: [{ op: "move", entity: "note", id: n2.id, to: Q.id }], reasoning: "mine" }]], agentEnv);
  const forgedFlag = JSON.parse(made.result.content[0].text).flag_id;
  for (const [what, args, env] of [
    ["an agent's session, options first", ["flags", "--all", "approve", String(forgedFlag)], agentEnv],
    ["the proposer claiming to be a person", ["flags", "--all", "approve", String(forgedFlag)], { DELPHI_ACTOR: "claude:1", DELPHI_AUTHOR_TYPE: "human" }],
    ["the proposer with no type at all", ["flags", "--project", "cli-p", "approve", String(forgedFlag)], { DELPHI_ACTOR: "claude:1", DELPHI_AUTHOR_TYPE: undefined }],
  ]) {
    const r = run(args, env);
    check(`refused: ${what}`, [r.code, one("SELECT project_id FROM notes WHERE id = ?", n2.id).project_id], [1, P.id]);
  }
  check("and the flag is still proposed", one("SELECT status FROM item_flags WHERE id = ?", forgedFlag).status, "proposed");

  section("D2 needs a named writer");
  const mine = db.createProject({ key: "d2-p", name: "D2 P" });
  const unnamed = { DELPHI_ACTOR: undefined, DELPHI_AUTHOR_TYPE: "agent" };
  const [added] = server([["add_task", { title: "an unnamed agent's", project_id: mine.id }]], unnamed);
  const taskId = JSON.parse(added.result.content[0].text).id;
  const [tried] = server([["update_task", { id: taskId, project_id: Q.id }]], unnamed);
  check("with no DELPHI_ACTOR, every agent is 'agent', so the exception does not apply", [Boolean(tried.error && /flag_item/.test(tried.error.message)),
    one("SELECT project_id FROM tasks WHERE id = ?", taskId).project_id], [true, mine.id]);

  const shown = run(["flags", "show", String(f.id)]);
  check("show prints the thread and the plan", [shown.code, /note +you: it is Q's/.test(shown.out), /plan: Moves it to CLI Q/.test(shown.out)], [0, true, true]);
  const help = run(["help", "flags"]);
  check("the help says decisions are made in the window", /done in the Delphi window only/.test(help.out), true);
}

async function main() {
  await route("node:sqlite", {});
  await route("sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" });
  cli();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
