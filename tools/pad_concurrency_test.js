#!/usr/bin/env node
// Several writers on one pad at once: no line lost, no task filed twice.
//
//   node tools/pad_concurrency_test.js
//
// The window and every agent's MCP server write the same pads, and a pad that
// files tasks is read, anchored and written back on every write. When that
// read and that write were two steps, a writer landing between them was
// written over (an agent's appended line gone), and two servers anchoring the
// same new checkbox line each filed a task for it. In 1.7.4, three servers and
// the app writing checkbox lines to one pad lost 55 to 304 lines and filed
// 13 to 30 tasks twice per run.
//
// This starts MCP servers on both routes (node:sqlite, and the sqlite3 binary
// where every call is its own process) and has them and the app's db.js write
// checkbox and prose lines to one pad at once, then counts. Every line written
// must be there exactly once, and every checkbox line must have exactly one
// task. The writers are interleaved by the operating system, so the exact
// order differs per run, but the counts may not.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-padconc-")));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
delete process.env.DELPHI_DB_ID;
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

let checks = 0;
let failures = 0;
function check(what, got, want) {
  checks++;
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log(`  ok   ${what}`); return; }
  failures++;
  console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
}

const db = require("../db");
const { openServer } = require("../sheet/client");
// The client runs the server with this process's binary; under Electron it is
// the client that makes that binary run as Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const ROUNDS = Number(process.env.PADCONC_ROUNDS) || 30;
const BOX_EVERY = 3;

async function main() {
  const project = db.createProject({ key: "padconc", name: "Pad concurrency" });
  const pad = db.createScratchpad({ projectId: project.id, title: "Shared", key: "shared", body: "# Shared plan" });

  const writers = [
    { name: "node-a", env: {} },
    { name: "node-b", env: {} },
    { name: "bin-a", env: { DELPHI_SQLITE_ROUTE: "binary" } },
    { name: "bin-b", env: { DELPHI_SQLITE_ROUTE: "binary" } },
  ];
  const clients = [];
  for (const w of writers) {
    const client = openServer({ actor: `stress:${w.name}`, env: { DELPHI_AUTHOR_TYPE: "agent", ...w.env }, clientName: "test", warn: () => {} });
    await client.start();
    clients.push({ ...w, client });
  }

  // A real JSON error in the filing, not the guard's: a trigger that fails
  // on one title. It is said once, plainly, and quickly, never retried thirty
  // times into a message about the pad changing; and the append stands.
  {
    db.handle().exec(`CREATE TRIGGER padconc_boom BEFORE INSERT ON tasks WHEN NEW.title = 'boom'
                      BEGIN SELECT json('{not json'); END`);
    for (const { name, client } of [clients[0], clients[2]]) {
      const t0 = Date.now();
      let said = null;
      try { await client.call("append_scratchpad", { id: pad.id, text: `- [ ] boom` }); } catch (error) { said = String(error.message || error); }
      check(`${name}: a real JSON error is said plainly`, /not because another writer changed the pad/.test(said || ""), true);
      check(`${name}: at once, not after thirty tries`, Date.now() - t0 < 2000, true);
      check(`${name}: and the append itself stands`, db.getScratchpad(pad.id).body.split("\n").filter((l) => l === "- [ ] boom").length, 1);
      db.handle().exec("UPDATE scratchpads SET body = replace(body, char(10) || '- [ ] boom', '') WHERE id = " + Number(pad.id));
    }
    db.handle().exec("DROP TRIGGER padconc_boom");
  }

  const want = [];
  const toldIds = [];
  const toolErrors = [];
  const lineOf = (who, i) => (i % BOX_EVERY === 0 ? `- [ ] ${who} box ${i}` : `${who} prose ${i}`);
  const t0 = Date.now();
  const serverJobs = clients.map(async ({ name, client }, n) => {
    for (let i = 0; i < ROUNDS; i++) {
      const text = lineOf(name, i);
      want.push(text);
      try {
        const got = await client.call("append_scratchpad", { id: pad.id, text });
        // What an agent is told it filed: each id names its own line's task.
        if (i % BOX_EVERY === 0) {
          const mine = (got.tasks || []).find((t) => t.title === text.slice(6));
          if (mine && mine.id != null) toldIds.push([mine.id, text.slice(6)]);
          else toldIds.push([null, text.slice(6)]);
        }
        // Once each, a section of its own rewritten: that reads the body and
        // writes it back, the other path that could lose someone else's line.
        if (i === 5) {
          want.push(`${name} patched`);
          await client.call("patch_scratchpad", { id: pad.id, heading: `Notes ${name}`, text: `${name} patched` });
        }
      } catch (error) {
        toolErrors.push(`${name}: ${String(error.message || error).slice(0, 160)}`);
      }
      if (n % 2 === 0) await new Promise((r) => setImmediate(r));
    }
  });
  // The app, in this process: appends, and compare-and-set writes the way the
  // drawer saves, retried on CONFLICT.
  const appErrors = [];
  const retry = async (fn) => {
    for (let k = 0; k < 400; k++) {
      try { return fn(); } catch (e) {
        if (e && e.code === "CONFLICT") { await new Promise((r) => setTimeout(r, 3 + (k % 7))); continue; }
        appErrors.push(`${e.code || ""} ${e.message}`.slice(0, 160));
        return null;
      }
    }
    appErrors.push("gave up");
    return null;
  };
  const appJob = (async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const text = lineOf("app", i);
      want.push(text);
      if (i % 4 === 0) {
        await retry(() => { const cur = db.getScratchpad(pad.id).body; return db.writeScratchpad(pad.id, { body: `${cur}\n${text}`, author: "you" }, { expectBody: cur }); });
      } else {
        await retry(() => db.appendScratchpad(pad.id, text));
      }
      await new Promise((r) => setTimeout(r, 1));
    }
  })();
  await Promise.all([...serverJobs, appJob]);
  const ms = Date.now() - t0;
  for (const { client } of clients) { try { client.close(); } catch {} }

  console.log(`\n${clients.length} servers and the app, ${ROUNDS} writes each, in ${ms} ms`);
  check("no tool call failed", toolErrors.slice(0, 3), []);
  check("no app write failed", appErrors.slice(0, 3), []);

  const body = db.getScratchpad(pad.id).body;
  const lines = body.split("\n").map((l) => l.replace(/\s*<!--\s*d:\d+\s*-->/, ""));
  const count = new Map();
  for (const l of lines) count.set(l, (count.get(l) || 0) + 1);
  const lost = want.filter((w) => !count.get(w));
  const twice = want.filter((w) => (count.get(w) || 0) > 1);
  check("every line written is in the pad", { lost: lost.length, sample: lost.slice(0, 3) }, { lost: 0, sample: [] });
  check("and none twice", twice.slice(0, 3), []);

  const boxes = want.filter((w) => w.startsWith("- [ ] ")).map((w) => w.slice(6));
  const tasks = db.sqlP("SELECT title FROM tasks WHERE pad_id = :p1", [pad.id]).map((r) => r.title);
  const filed = new Map();
  for (const t of tasks) filed.set(t, (filed.get(t) || 0) + 1);
  const unfiled = boxes.filter((b) => !filed.get(b));
  const duplicated = boxes.filter((b) => (filed.get(b) || 0) > 1);
  check("every checkbox line has its task", { unfiled: unfiled.length, sample: unfiled.slice(0, 3) }, { unfiled: 0, sample: [] });
  check("and exactly one", { duplicated: duplicated.length, sample: duplicated.slice(0, 3) }, { duplicated: 0, sample: [] });
  check("every task the pad files is one of its lines", tasks.length, boxes.length);
  const anchors = (body.match(/<!--\s*d:(\d+)\s*-->/g) || []).map((a) => a.replace(/\D/g, ""));
  check("each anchor appears once", anchors.length, new Set(anchors).size);
  const titleOf = new Map(db.sqlP("SELECT id, title FROM tasks WHERE pad_id = :p1", [pad.id]).map((r) => [Number(r.id), r.title]));
  const wrong = toldIds.filter(([id, title]) => id == null || titleOf.get(Number(id)) !== title);
  check("the task id each server was told names that line's task", { wrong: wrong.length, sample: wrong.slice(0, 3) }, { wrong: 0, sample: [] });
  check("and every checkbox line carries one", anchors.length, boxes.length);

  console.log(`\n${checks - failures}/${checks} checks passed`);
}

main()
  .catch((error) => { failures++; console.error(error); })
  .finally(() => {
    if (process.env.PADCONC_KEEP) console.log("kept", dir); else try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    process.exit(failures ? 1 : 0);
  });
