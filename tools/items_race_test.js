#!/usr/bin/env node
// Two processes cutting lines out of one pad at once, on the sqlite3 route.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/items_race_test.js
//
// A detach-move outdents the task's pad line and a carry cuts it out; both
// read the pad, then write it in a batch. On the sqlite3 route nothing holds
// the pad still between the read and the write, so two of them at once would
// each write back a body missing the other's change. items/store.js opens
// each batch with a check that the pad is still what it read, and reads it
// again when it is not. This runs two real processes and proves neither
// change is lost.
//
// Nothing here waits on a clock. Each racer stops at its first move batch,
// after its reads and before its write, and says so with a file; the parent
// lets the first through only when both have stopped, and the second only
// once the first has finished. So both always cut from the same body, and
// the second's first batch always meets a pad the first has changed. A sleep
// would race the machine as well as the racers, and on a slow runner the
// second would read after the first wrote and never test the retry at all.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const CHILD = process.env.ITEMS_RACE_CHILD;

// The binary, or null. The route needs RETURNING (3.35) and json() (3.38,
// or JSON1 compiled in, as every build since has it).
function findSqlite() {
  for (const candidate of [process.env.DELPHI_SQLITE, "/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3", "sqlite3"]) {
    if (!candidate) continue;
    try {
      const out = execFileSync(candidate, [":memory:"], { input: "SELECT json('[1]');\nCREATE TABLE t (a);\nINSERT INTO t VALUES (7) RETURNING a;\n", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      if (/\[1\]/.test(out) && /\b7\b/.test(out)) return candidate;
    } catch {}
  }
  return null;
}

// The server's sqlite3 route, as tools/items_store_test.js has it.
function binaryRoute(dbPath, scratch, SQLITE) {
  const literal = (v) => {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
    if (typeof v === "boolean") return v ? "1" : "0";
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  const render = (query, params = []) => String(query).replace(/:p(\d+)/g, (m, n) => literal(params[Number(n) - 1]));
  let n = 0;
  const script = (lines, json) => {
    const file = path.join(scratch, `q-${process.pid}-${n++}.sql`);
    fs.writeFileSync(file, lines.join("\n"));
    try {
      const out = execFileSync(SQLITE, [dbPath], { input: `.read ${file}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      return json ? (out ? JSON.parse(out) : []) : null;
    } catch (error) {
      throw new Error(String(error.stderr || error.message).trim().split("\n")[0]);
    } finally {
      fs.rmSync(file, { force: true });
    }
  };
  return {
    sql: (q, p = []) => { const s = render(q, p); return script([".timeout 5000", ".mode json", ".headers on", s.endsWith(";") ? s : `${s};`], true); },
    batch: (statements) => script([".timeout 5000", ".bail on", "BEGIN IMMEDIATE;",
      ...statements.map(([q, p]) => { const s = render(q, p || []); return s.trim().endsWith(";") ? s : `${s};`; }), "COMMIT;"], false),
  };
}

// The statement items/store.js opens a move batch with, one per pad it read.
const GUARD = /^SELECT CASE WHEN \(SELECT body FROM scratchpads WHERE id = /;

if (CHILD) {
  // One racer. Its first move batch stops at the gate: "ready" says it has
  // read everything, and it goes on when "go" appears. A retry goes straight.
  // It reports, as JSON, each batch and whether the pad guard was the
  // statement that refused it, so the parent can tell a compare-and-set miss
  // from any other failure that happened to be followed by a second batch.
  const { makeItemStore } = require("../items/store");
  const { dbPath, scratch, taskId, to, mode, ready, go, sqlite } = JSON.parse(CHILD);
  const route = binaryRoute(dbPath, scratch, sqlite);
  const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  const batches = [];
  const items = makeItemStore({
    sql: route.sql, actor: `racer-${taskId}`, authorType: "human",
    batch: (statements) => {
      const guards = statements.filter(([q]) => GUARD.test(q));
      if (guards.length && !batches.length) {
        fs.writeFileSync(ready, "read");
        while (!fs.existsSync(go)) nap();
      }
      try {
        route.batch(statements);
        batches.push({ ok: true });
      } catch (error) {
        // Each guard on its own, after the fact: the one that raises is a pad
        // that changed since it was read, which is what the batch tripped on.
        const missed = guards.some(([q, p]) => { try { route.sql(q, p); return false; } catch { return true; } });
        batches.push({ ok: false, error: error.message, guardMissed: missed, guardsFirst: statements.slice(0, guards.length).every(([q]) => GUARD.test(q)) });
        throw error;
      }
    },
  });
  let result;
  try {
    items.move("task", taskId, to, mode === "carry" ? { pad: "carry" } : { detach: true });
    result = { moved: true, batches };
  } catch (error) {
    result = { moved: false, error: error.message, batches };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

const SQLITE = findSqlite();
if (!SQLITE) {
  console.log("SKIP: no sqlite3 binary with RETURNING and json() was found (set DELPHI_SQLITE to one). This race is only possible on that route.");
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-items-race-"));
process.env.DELPHI_DATA_DIR = dir;
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "delphi.db");

const db = require("../db");
const pads = require("../pads");

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

const exists = (file) => fs.existsSync(file);
// Waits for a file another process writes. Polled, but only the order is
// waited on, never a length of time; the limit is there so a racer that died
// fails the test instead of hanging it.
async function waitFor(test, what) {
  const until = Date.now() + 60000;
  while (!test()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let round = 0;
async function race([first, second]) {
  const tag = round++;
  const spawnRacer = (c, i) => {
    const ready = path.join(dir, `ready-${tag}-${i}`);
    const go = path.join(dir, `go-${tag}-${i}`);
    const child = spawn(process.execPath, [__filename], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ITEMS_RACE_CHILD: JSON.stringify({ ...c, ready, go, sqlite: SQLITE, dbPath: process.env.DELPHI_DB, scratch: dir }) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let closed = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const done = new Promise((resolve) => child.on("close", () => { closed = true; resolve(); }));
    const result = async () => {
      await done;
      try { return JSON.parse(out.trim().split("\n").pop()); } catch { return { moved: false, error: `${out}${err}`.trim(), batches: [] }; }
    };
    return { ready, go, done, result, isClosed: () => closed, kill: () => { if (!closed) child.kill("SIGKILL"); } };
  };
  const a = spawnRacer(first, 0);
  const b = spawnRacer(second, 1);
  // A racer left waiting on a gate polls forever, so a failure here ends both.
  try {
    // Both have read the pad before either writes.
    await waitFor(() => (exists(a.ready) || a.isClosed()) && (exists(b.ready) || b.isClosed()), "both racers to read");
    fs.writeFileSync(a.go, "go");
    await waitFor(a.isClosed, "the first racer to finish");
    fs.writeFileSync(b.go, "go");
    await waitFor(b.isClosed, "the second racer to finish");
  } catch (error) {
    a.kill();
    b.kill();
    throw error;
  }
  return [await a.result(), await b.result()];
}

async function main() {
  const A = db.createProject({ key: "race-a", name: "Race A" });
  const B = db.createProject({ key: "race-b", name: "Race B" });
  const C = db.createProject({ key: "race-c", name: "Race C" });

  section("two detach-moves out of one pad at once");
  const pad = db.createScratchpad({ projectId: A.id, title: "race", key: "race", body: "- [ ] parent\n  - [ ] one\n  - [ ] two\n- [ ] tail\n" });
  const [parent, one, two] = db.handle().prepare("SELECT id FROM tasks WHERE pad_id = ? ORDER BY id").all(pad.id).map((r) => r.id);
  const outs = await race([{ taskId: one, to: B.id, mode: "detach" }, { taskId: two, to: C.id, mode: "detach" }]);
  check("both moved", outs.map((o) => o.moved), [true, true]);
  check("the first wrote in one batch", outs[0].batches.map((x) => x.ok), [true]);
  check("the second's first batch was refused by the pad guard, and its retry went through",
    outs[1].batches.map((x) => [x.ok, Boolean(x.guardMissed), x.ok || Boolean(x.guardsFirst)]), [[false, true, true], [true, false, true]]);
  const body = db.handle().prepare("SELECT body FROM scratchpads WHERE id = ?").get(pad.id).body;
  const top = pads.parse(body).filter((e) => e.depth === 0).map((e) => e.taskId);
  check("both lines are at the top level: neither write lost the other's", [top.includes(one), top.includes(two), top.includes(parent)], [true, true, true]);
  db.derive(pad.id);
  check("and a derive keeps them detached",
    db.handle().prepare("SELECT id, parent_id FROM tasks WHERE id IN (?, ?) ORDER BY id").all(one, two).map((r) => r.parent_id), [null, null]);

  section("a carry and a detach out of one pad at once");
  const pad2 = db.createScratchpad({ projectId: A.id, title: "race two", key: "race-two", body: "- [ ] p2\n  - [ ] stays-detached\n- [ ] carried\n  - [ ] carried kid\n" });
  const ids = db.handle().prepare("SELECT id, title FROM tasks WHERE pad_id = ? ORDER BY id").all(pad2.id);
  const byTitle = (t) => ids.find((r) => r.title === t).id;
  const outs2 = await race([{ taskId: byTitle("stays-detached"), to: B.id, mode: "detach" }, { taskId: byTitle("carried"), to: C.id, mode: "carry" }]);
  check("both moved", outs2.map((o) => o.moved), [true, true]);
  check("the carry's first batch was refused by the pad guard, and its retry went through",
    outs2[1].batches.map((x) => [x.ok, Boolean(x.guardMissed)]), [[false, true], [true, false]]);
  const left = db.handle().prepare("SELECT body FROM scratchpads WHERE id = ?").get(pad2.id).body;
  check("the carried lines left the pad and the detached line is at the top level",
    [pads.anchoredIds(left).has(byTitle("carried")), pads.parse(left).find((e) => e.taskId === byTitle("stays-detached")).depth], [false, 0]);
  const plan = db.handle().prepare("SELECT body FROM scratchpads WHERE project_id = ? AND key = 'plan'").get(C.id);
  check("and arrived in the target's plan pad", Boolean(plan) && pads.anchoredIds(plan.body).has(byTitle("carried")), true);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  return failures ? 1 : 0;
}

main()
  .catch((error) => { console.error(error); return 1; })
  .then((code) => {
    try { db.handle().close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(code);
  });
