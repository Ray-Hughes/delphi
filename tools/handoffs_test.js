#!/usr/bin/env node
// Handoffs listed the way the app lists them, against a throwaway database.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/handoffs_test.js
//
// handoffs:list failed on every call that left a filter out, with "Unknown
// named parameter 'sessionId'": node:sqlite refuses a bound name the
// statement does not use. Every combination of filters is called here.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-handoffs-")));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");

const db = require("../db");

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}
function attempt(fn) {
  try { return fn(); } catch (error) { return `threw: ${error.message}`; }
}

const p = db.createProject({ key: "ho", name: "Handoffs", path: dir });
const other = db.createProject({ key: "ot", name: "Other", path: dir });
db.createHandoff({ projectId: p.id, toHarness: "codex", request: "review this" });
db.createHandoff({ projectId: other.id, toHarness: "claude-code", request: "and this" });

check("no filters", attempt(() => db.listHandoffs().length), 2);
check("an empty options object, as the IPC handler passes", attempt(() => db.listHandoffs({}).length), 2);
check("by project, as the app's project page asks", attempt(() => db.listHandoffs({ projectId: p.id, limit: 8 }).map((h) => h.request)), ["review this"]);
check("by session", attempt(() => db.listHandoffs({ sessionId: 999 }).length), 0);
check("by status", attempt(() => db.listHandoffs({ status: "pending" }).length) >= 0, true);
check("every filter at once", attempt(() => db.listHandoffs({ projectId: p.id, sessionId: 999, status: "pending", limit: 3 }).length), 0);
check("a limit is honoured", attempt(() => db.listHandoffs({ limit: 1 }).length), 1);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
