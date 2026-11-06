#!/usr/bin/env node
// The cost and time ledger: ledger/ledger.js, its IPC (main/ledger.js) and the
// MCP tool cost_ledger, on both of the server's routes to the database.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/ledger_test.js
//
// The checks that matter are the honest ones: a column nobody reported stays
// "not reported" rather than becoming zero, a partial sum says how many runs it
// covers, Copilot's premium requests never land in dollars, and a sent-back
// survives the job running again. Then the app and the server, on either
// route, must give the same numbers.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-ledger-"));
process.env.DELPHI_DATA_DIR = dir;
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const L = require("../ledger/ledger");
const db = require("../db");
const { openServer } = require("../sheet/client");

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  } else console.log(`  ok   ${what}`);
}
function section(name) { console.log(`\n${name}`); }

delete process.env.ELECTRON_RUN_AS_NODE;

function pure() {
  section("the sums, without a database");
  const none = L.total([{ started_at: "x", turns: 1 }]);
  check("a run that reported nothing has no tokens, cost, premium or time, not zero",
    [none.tokens_in, none.cost_usd, none.premium_requests, none.agent_seconds], [null, null, null, null]);
  check("and is said so", L.phrases(none), ["1 run", "time not reported", "tokens not reported", "cost not reported"]);

  const mixed = L.total([
    { started_at: "x", tokens_in: 100, tokens_out: 50, cost_usd: 0.25, seconds: 600, review: "accepted" },
    { started_at: "x", tokens_in: 1000, tokens_out: 0, cost_usd: null, premium_requests: 1.5, seconds: 60, review: "sent_back", sent_back_count: 0 },
    { started_at: "x", tokens_in: null, tokens_out: null, cost_usd: null, seconds: null, sent_back_count: 2 },
    { started_at: null },
  ]);
  check("runs count started jobs only", [mixed.jobs, mixed.runs], [4, 3]);
  check("a partial sum keeps how many reported", [mixed.cost_usd, mixed.cost_reported, mixed.tokens_reported], [0.25, 1, 2]);
  check("premium requests are their own total", mixed.premium_requests, 1.5);
  check("sent-backs take the audit count or the review, whichever saw more", mixed.sent_backs, 3);
  const words = L.phrases(mixed);
  check("a partial cost says it is partial, and is API-equivalent", words.find((w) => w.startsWith("$")), "$0.25 API-equivalent (1 of 3 runs reported)");
  check("partial time says so too", words[1], "11m agent time (2 of 3 runs reported)");
  check("premium requests are never written as dollars", words.filter((w) => w.includes("premium")), ["1.5 premium requests"]);

  section("time in each status");
  const ev = (status, s) => ({ task_id: 1, status, at: new Date(Date.UTC(2026, 0, 5, 9, 0, s)).toISOString().replace("T", " ").slice(0, 19) });
  const done = [ev("todo", 0), ev("doing", 60), ev("blocked", 180), ev("doing", 240), ev("done", 300)];
  check("done stops the clock", L.statusSeconds(done, "2026-02-01 00:00:00"), { todo: 60, doing: 180, blocked: 60 });
  check("an open status runs to now", L.statusSeconds([ev("todo", 0), ev("doing", 30)], "2026-01-05 09:01:30"), { todo: 30, doing: 60 });
  const many = L.statusSecondsMany([...done, { ...ev("todo", 0), task_id: 2 }, { ...ev("done", 120), task_id: 2 }], "2026-02-01 00:00:00");
  check("several tasks add up without one's clock running into the next", many, { todo: 180, doing: 180, blocked: 60 });

  section("the words");
  check("durations", [L.duration(45), L.duration(600), L.duration(3600 + 600), L.duration(86400 * 3 + 3600)], ["45s", "10m", "1h 10m", "3d 1h"]);
  check("tokens and money", [L.tokens(950), L.tokens(1500), L.tokens(999999), L.tokens(1234567), L.money(0.001), L.money(3.456)], ["950", "1.5k", "1M", "1.2M", "under $0.01", "$3.46"]);
  check("change", [L.change(12, 10), L.change(5, 10), L.change(3, 0), L.change(null, 4), L.change(4, 4)], ["up 20%", "down 50%", "new this week", null, "level"]);
  check("the label is honest", L.COST_LABEL, "API-equivalent; subscription plans don't bill per token");
}

/** Two projects, four tasks, jobs from three agents with every kind of gap. */
function fixture(tag) {
  db.seedHarnesses(require("../harness").BUILTINS);
  const h = db.handle();
  const a = db.createProject({ key: `lg-a-${tag}`, name: `Ledger A ${tag}` });
  const b = db.createProject({ key: `lg-b-${tag}`, name: `Ledger B ${tag}` });
  const t1 = db.createTask({ projectId: a.id, title: "Claude and Copilot both worked" });
  const t2 = db.createTask({ projectId: a.id, title: "Codex, which reports no cost" });
  const t3 = db.createTask({ projectId: b.id, title: "Last week only" });
  const t4 = db.createTask({ projectId: b.id, title: "Never run" });
  const job = (fields) => {
    const cols = Object.keys(fields);
    const row = h.prepare(`INSERT INTO handoffs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) RETURNING id`).get(...cols.map((c) => fields[c]));
    return row.id;
  };
  const at = (mod) => h.prepare(`SELECT datetime(${["'now'", ...mod.map(() => "?")].join(", ")}) AS t`).get(...mod).t;
  const base = { request: "work", kind: "do" };
  // This week: finished now, so whatever the weekday it is this week.
  const j1 = job({ ...base, project_id: a.id, task_id: t1.id, to_harness: "claude-code", state: "done", status: "harvested", tokens_in: 120000, tokens_out: 8000, cost_usd: 1.25, turns: 2,
                   started_at: at(["-90 minutes"]), finished_at: at([]), updated_at: at([]), review: "sent_back" });
  const j2 = job({ ...base, project_id: a.id, task_id: t1.id, to_harness: "copilot", state: "done", status: "harvested", tokens_in: 40000, tokens_out: 2000, premium_requests: 2.5, turns: 1,
                   started_at: at(["-30 minutes"]), finished_at: at([]), updated_at: at([]), review: "accepted" });
  const j3 = job({ ...base, project_id: a.id, task_id: t2.id, to_harness: "codex", state: "failed", status: "failed", turns: 1,
                   started_at: at(["-10 minutes"]), finished_at: at([]), updated_at: at([]) });
  // Last week, at exactly this point a week ago, so it is in last week by now.
  const j4 = job({ ...base, project_id: b.id, task_id: t3.id, to_harness: "claude-code", state: "done", status: "harvested", tokens_in: 1000, tokens_out: 100, cost_usd: 0.5, turns: 1,
                   started_at: at(["-7 days", "-1 hours"]), finished_at: at(["-7 days"]), updated_at: at(["-7 days"]) });
  // Queued and never started: a job, not a run.
  job({ ...base, project_id: b.id, task_id: t4.id, to_harness: "codex", state: "queued", status: "queued" });
  // j1 was sent back once before it ran again, and the review column was
  // cleared then; only the audit row remembers. It is sent_back again now.
  h.prepare("INSERT INTO audit (action, entity, entity_id, summary, label, actor, job_id) VALUES ('update', 'handoff', ?, 'sent back (by you)', 'work', 'you', ?)").run(j1, j1);
  h.prepare("INSERT INTO audit (action, entity, entity_id, summary, label, actor, job_id) VALUES ('update', 'handoff', ?, 'sent back (by you)', 'work', 'you', ?)").run(j1, j1);
  // Time in status for t1: moved to doing an hour after it was made, still doing.
  h.prepare("UPDATE status_events SET at = datetime('now', '-3 hours') WHERE task_id = ?").run(t1.id);
  h.prepare("INSERT INTO status_events (task_id, status, actor, at) VALUES (?, 'doing', 'you', datetime('now', '-2 hours'))").run(t1.id);
  h.prepare("UPDATE tasks SET status = 'doing' WHERE id = ?").run(t1.id);
  // A chat session with a running total, and one that never reported.
  const s = db.createSession({ projectId: a.id, title: "tab", harness: "claude-code" });
  db.addSessionUsage(s.id, { input: 5000, output: 700 });
  db.createSession({ projectId: a.id, title: "empty", harness: "codex" });
  return { a, b, t1, t2, t3, t4, j1, j2, j3, j4 };
}

function store(f) {
  section("the store, in the app (db.sqlP)");
  const ledger = L.makeLedger({ sql: db.sqlP });
  const one = ledger.forTask(f.t1.id);
  check("a task's totals", [one.totals.runs, one.totals.tokens_in, one.totals.tokens_out, one.totals.cost_usd, one.totals.premium_requests],
        [2, 160000, 10000, 1.25, 2.5]);
  check("cost is partial, and says so", [one.totals.cost_reported, one.totals.runs], [1, 2]);
  check("sent back twice (the audit) and accepted once", [one.totals.sent_backs, one.totals.accepted], [2, 1]);
  check("agent time is both jobs' wall clock", one.totals.agent_seconds >= 90 * 60 + 30 * 60 - 5 && one.totals.agent_seconds <= 120 * 60 + 5, true);
  check("per agent, each in its own unit", one.by_harness.map((x) => [x.key, x.cost_usd, x.premium_requests]), [["claude-code", 1.25, null], ["copilot", null, 2.5]]);
  check("time in status: an hour to do, two in progress so far", [Math.round(one.status_seconds.todo / 60), Math.round(one.status_seconds.doing / 60)], [60, 120]);

  const codex = ledger.forTask(f.t2.id);
  check("a harness that reports nothing is not reported, not free", [codex.totals.runs, codex.totals.cost_usd, codex.totals.tokens_in], [1, null, null]);
  const never = ledger.forTask(f.t4.id);
  check("a queued job is a job but not a run", [never.totals.jobs, never.totals.runs, L.phrases(never.totals)[0]], [1, 0, "no runs yet (1 job not started)"]);
  check("no such task is null", ledger.forTask(999999), null);

  const all = ledger.rollup({ weeks: 4 });
  check("this week: three runs", all.this_week_totals.runs, 3);
  check("last week: one run, in by this point", [all.last_week_totals.runs, all.last_week_to_date.runs], [1, 1]);
  check("four weeks in the series, oldest first, ending this week", [all.series.length, all.series[3].week], [4, all.this_week]);
  check("dollars add only what was reported", all.totals.cost_usd, 1.75);
  check("per project", all.by_project.map((p) => [p.label, p.runs]).sort(), [[`Ledger A ${f.tag}`, 3], [`Ledger B ${f.tag}`, 1]].sort());
  check("sessions are all time, with reported tokens only", all.tabs.map((t) => [t.harness, t.sessions, t.tokens_in]), [["claude-code", 1, 5000]]);

  const proj = ledger.rollup({ projectId: f.b.id, weeks: 2 });
  check("one project: only its jobs", [proj.totals.jobs, proj.totals.runs, proj.this_week_totals.runs], [2, 1, 0]);
  check("and its agent tasks' time in status", [proj.agent_tasks, Object.keys(proj.status_seconds)], [2, ["todo"]]);
  return { one, all };
}

function ipc(f) {
  section("the IPC (main/ledger.js)");
  const handlers = {};
  require("../main/ledger").register((name, fn) => { handlers[name] = fn; }, { db });
  check("two read-only channels", Object.keys(handlers).sort(), ["ledger:forTask", "ledger:rollup"]);
  check("ledger:forTask answers", handlers["ledger:forTask"](f.t1.id).totals.runs, 2);
  check("ledger:rollup takes a project", handlers["ledger:rollup"]({ projectId: f.a.id }).totals.runs, 3);
}

async function route(name, env, f, inApp) {
  section(`cost_ledger, ${name}`);
  const agent = openServer({ actor: `claude-code:ledger-${name.replace(/\W/g, "")}`, env: { DELPHI_AUTHOR_TYPE: "agent", ...env }, clientName: "test", warn: () => {} });
  await agent.start();
  try {
    const listed = (await agent.request("tools/list", {})).tools;
    const tool = listed.find((t) => t.name === "cost_ledger");
    check("cost_ledger is listed", Boolean(tool), true);
    check("its description is short", tool && tool.description.length < 300, true);
    check("and second opinions may call it", require("../agent/second_opinion").READ_ONLY_TOOLS.includes("cost_ledger"), true);

    const full = await agent.call("cost_ledger", { task_id: f.t1.id, detail: "full" });
    const strip = (t) => ({ ...t, agent_seconds: null });
    check("the server's numbers are the app's", strip(full.totals), strip(inApp.one.totals));
    const brief = await agent.call("cost_ledger", { task_id: f.t1.id });
    check("brief is lines and the cost note", [Array.isArray(brief.lines), brief.cost_note], [true, L.COST_LABEL]);
    check("its first line says it all", /^Task \d+ .*2 runs, .* agent time, 170k tokens \(160k in, 10k out\), \$1\.25 API-equivalent \(1 of 2 runs reported\), 2\.5 premium requests, 2 sent back\.$/.test(brief.lines[0]), true);

    const rolled = await agent.call("cost_ledger", { detail: "full", weeks: 4 });
    check("the rollup agrees", [rolled.this_week_totals.runs, rolled.last_week_to_date.runs, rolled.totals.cost_usd], [inApp.all.this_week_totals.runs, inApp.all.last_week_to_date.runs, inApp.all.totals.cost_usd]);
    const byKey = await agent.call("cost_ledger", { project: `lg-a-${f.tag}` });
    check("a project by key, compact", byKey.lines[0].startsWith("This week so far"), true);
    const tight = await agent.call("cost_ledger", { budget: 100 });
    const queuedLine = (await agent.call("cost_ledger", { task_id: f.t4.id })).lines.find((l) => l.startsWith("Job "));
    check("a job that never started says so, not an empty line", / not started\.$/.test(queuedLine), true);
    check("a sent-back job's line counts its sends", (await agent.call("cost_ledger", { task_id: f.t1.id })).lines.some((l) => /sent back\): .*2 sent back\.$/.test(l)), true);
    check("a small budget is kept, and says it trimmed", [JSON.stringify(tight).length <= 100 * 4 + 200, tight.trimmed], [true, true]);
    const def = await agent.call("cost_ledger", {});
    check("the default fits 400 tokens", JSON.stringify(def).length / 4 <= 450, true);
    let refused = null;
    try { await agent.call("cost_ledger", { task_id: 999999 }); } catch (error) { refused = error.message; }
    check("no such task is refused in words", /No task 999999/.test(String(refused)), true);
  } finally {
    agent.close();
  }
}

async function main() {
  pure();
  const f = { ...fixture("x"), tag: "x" };
  const inApp = store(f);
  ipc(f);
  await route("node:sqlite", {}, f, inApp);
  await route("sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" }, f, inApp);
  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
