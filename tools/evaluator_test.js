#!/usr/bin/env node
// The Oracle's "where does this belong", with no model, and the sweep.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/evaluator_test.js
//
// The fixture is the owner's own case, rebuilt small: a note about the
// tracker's database filed under Offerworks, its sibling notes in the
// tracker's project, and a flag saying it spans Offerworks. The answer has to
// be "move it to the tracker's project and keep it shown in Offerworks", from
// the neighbours and the flag's words alone.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-eval-"));
process.env.DELPHI_DATA_DIR = dir;
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const db = require("../db");
const { makeItemStore } = require("../items/store");

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

const brain = db.createProject({ key: "brain", name: "Second Brain app", summary: "The tracker itself" });
const offer = db.createProject({ key: "offerworks", name: "Offerworks", summary: "Offer letters" });
const claude = db.createProject({ key: "claude", name: "Claude" });
const ssnr = db.createProject({ key: "ssnr-mpi", name: "SSNR / MPI" });
const beta = db.createProject({ key: "beta", name: "Beta" });

const note = (projectId, title, body) => db.createNote({ projectId, title, body });
note(brain.id, "Two databases: the MCP server wrote where the app could not read",
  "The MCP server resolved its sqlite database path differently from the app, so agent writes landed in a database file the app never opened. The tracker database path resolver is now one module.");
note(brain.id, "Database path resolution for the tracker app",
  "locate.js resolves the sqlite database path for the app, the MCP server and the command line, so all three open one database file.");
note(brain.id, "MCP server identity check",
  "The MCP server refuses a database whose id differs from the one the app launched it for, so an agent never writes to the wrong sqlite database file.");
note(offer.id, "Offer letter template", "Offer letters use the pricing table and the candidate's start date. Legal reviews each offer.");
note(offer.id, "Offer pricing tiers", "Pricing tiers for offers: base, plus, enterprise. Discounts need approval from sales.");
note(offer.id, "Stranded handoffs to Offerworks", "Handoffs for Offerworks offer letters were stranded while agents wrote elsewhere.");
const misfiled = note(offer.id, "Delphi split-brain: app and MCP read different databases",
  "The app and the MCP server read different sqlite database files, so the tracker showed nothing an agent wrote. The database path resolver and the server identity check fix it.");

// Notes in the fallback project, near-copies of the misfiled one: they must
// not vote, or the misfiling would vote for itself.
note(claude.id, "app and MCP read different databases again", "The app and the MCP server read different sqlite database files.");
note(claude.id, "MCP server database files", "The MCP server and the app read different sqlite database files.");
// VA work sitting in the fallback project, which the sweep should notice.
for (let i = 0; i < 3; i++) note(ssnr.id, `SSNR MPI identity match ${i}`, `SSNR MPI identity match rules for veterans records, batch ${i}, correlation of MPI identifiers.`);
const vaInClaude = note(claude.id, "MPI identity match for SSNR records", "SSNR MPI identity match rules for veterans records and MPI identifiers correlation.");

const items = makeItemStore({ sql: db.sqlP, batch: db.batchP, actor: "ray", authorType: "human" });

section("the owner's case, with no model");
const flagged = items.flag({ entity: "note", id: misfiled.id, note: "This is about the tracker's own database, but it spans to Offerworks where the stranded handoffs were." });
check("it proposes", flagged.flag.status, "proposed");
const op = flagged.flag.proposal && flagged.flag.proposal.ops[0];
check("move to the tracker's project, kept in Offerworks", op && { op: op.op, to: op.to, keep: Boolean(op.options && op.options.keepInSource) }, { op: "move", to: brain.id, keep: true });
console.log("   ", flagged.flag.proposal_summary, "\n   ", flagged.flag.proposal.reasoning);
check("by the Oracle", [flagged.flag.proposal.evaluator, flagged.flag.proposed_by], ["oracle@1", "oracle"]);
check("the reasoning names its neighbours and the scores", /Its nearest are note \d+ .* Second Brain app scores [\d.]+ against [\d.]+ for Offerworks\. The flag says it spans Offerworks/.test(flagged.flag.proposal.reasoning), true);
check("the fallback project never voted", (flagged.flag.proposal.signals.knn || []).some(([pid]) => pid === claude.id), false);
check("nothing moved", db.handle().prepare("SELECT project_id FROM notes WHERE id = ?").get(misfiled.id).project_id, offer.id);
const thread = items.getFlag(flagged.flag.id);
check("the evaluation is a note entry carrying the proposal", thread.entries.some((e) => e.kind === "note" && e.meta && e.meta.proposal), true);

section("named intent");
const t1 = db.createNote({ projectId: offer.id, title: "n1", body: "x" });
const t2 = db.createNote({ projectId: offer.id, title: "n2", body: "y" });
const t3 = db.createNote({ projectId: offer.id, title: "n3", body: "z" });
const ops = (id, words) => {
  const f = items.flag({ entity: "note", id, note: words }).flag;
  return f.proposal && f.proposal.ops.map((o) => [o.op, o.to, Boolean(o.options && o.options.keepInSource)]);
};
check("copy to a named project", ops(t1.id, "We also need it in Beta, copy it there"), [["copy", beta.id, false]]);
check("also show it", ops(t2.id, "Please also show this in Beta"), [["associate", beta.id, false]]);
check("belongs in", ops(t3.id, "This belongs in Beta"), [["move", beta.id, false]]);
db.createProject({ key: "delphi-tasks", name: "Delphi: the task system" });
db.createProject({ key: "delphi-queue", name: "Delphi: the agent queue" });
const t4 = db.createNote({ projectId: offer.id, title: "unrelated thing", body: "quarterly gardening rota" });
const amb = items.flag({ entity: "note", id: t4.id, note: "This belongs in Delphi" }).flag;
check("an ambiguous name is not guessed", [amb.status, (items.getFlag(amb.id).entries.find((e) => e.meta && e.meta.signals) || { meta: { signals: {} } }).meta.signals.ambiguous.map((a) => a.word)], ["open", ["delphi"]]);
check("and the reasoning says so", /"delphi" names more than one project/.test(items.getFlag(amb.id).entries.slice(-1)[0].body), true);

section("an agent evaluator is off, and its prompt fits");
let refused = "";
try { items.evaluate(amb.id, { mode: "agent" }); } catch (error) { refused = error.message; }
check("asking for one says it is off", /Agent evaluation is turned off/.test(refused), true);
for (let i = 0; i < 40; i++) db.createProject({ key: `filler-${i}`, name: `Filler project ${i}`, summary: "a long summary ".repeat(20) });
const huge = db.createNote({ projectId: offer.id, title: "huge", body: "word ".repeat(10000) });
const hugeFlag = items.flag({ entity: "note", id: huge.id, note: "evidence ".repeat(2000), evaluate: "none" }).flag;
check("the prompt for a 50,000 character note and 45 projects stays under 2,500 tokens", items.evalPrompt(hugeFlag.id).length <= 10000, true);

section("the sweep: proposals only");
const before = db.handle().prepare("SELECT id, project_id FROM notes ORDER BY id").all();
const swept = items.sweep({ projectId: claude.id });
check("it finds the VA note filed in the fallback project", swept.created.some((f) => f.entity === "note" && f.entity_id === vaInClaude.id && f.proposal && f.proposal.ops[0].to === ssnr.id), true);
check("from the sweep", swept.created.every((f) => f.source === "sweep"), true);
check("it applied nothing", db.handle().prepare("SELECT id, project_id FROM notes ORDER BY id").all(), before);
const again = items.sweep({ projectId: claude.id });
check("a second sweep skips what is already flagged", again.created.length, 0);
const rejectedFlag = swept.created.find((f) => f.entity_id === vaInClaude.id);
if (rejectedFlag.status === "proposed") items.decide(rejectedFlag.id, { approve: false, note: "it is fine there" });
else items.withdraw(rejectedFlag.id);
check("a rejected suggestion stays dismissed", items.sweep({ projectId: claude.id }).created.some((f) => f.entity_id === vaInClaude.id), rejectedFlag.status !== "proposed");

console.log(`\n${checks - failures}/${checks} checks passed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
