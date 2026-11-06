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
// A decision as the window makes it: via the window, naming the proposal the
// person was shown. Only main.js passes via "window" in the app itself.
const W = (store, id, opts) => store.decide(id, { via: "window", entryId: store.getFlag(id).flag.proposal_entry_id, ...opts });

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
check("the reasoning quotes the words it kept it for, then its neighbours and the scores", /^You wrote "spans to Offerworks", so it stays shown in Offerworks\. Its nearest are note \d+ .* Second Brain app scores [\d.]+ against [\d.]+ for Offerworks\./.test(flagged.flag.proposal.reasoning), true);
check("the fallback project never voted", (flagged.flag.proposal.signals.knn || []).some(([pid]) => pid === claude.id), false);
check("nothing moved", db.handle().prepare("SELECT project_id FROM notes WHERE id = ?").get(misfiled.id).project_id, offer.id);
const thread = items.getFlag(flagged.flag.id);
check("the evaluation is a note entry carrying the proposal", thread.entries.some((e) => e.kind === "note" && e.meta && e.meta.proposal), true);

section("the person's words come first: the mockup's flag text");
const secondCopy = db.createNote({ projectId: offer.id, title: "Delphi split-brain, the second copy",
  body: "The app and the MCP server read different sqlite database files, so the tracker showed nothing an agent wrote." });
const mock = items.flag({ entity: "note", id: secondCopy.id, note: "This is about Delphi's own database. Keep it visible in Offerworks too." }).flag;
const mockOp = mock.proposal && mock.proposal.ops[0];
check("move to the tracker's project, kept visible in Offerworks", mockOp && [mockOp.op, mockOp.to, Boolean(mockOp.options && mockOp.options.keepInSource)], ["move", brain.id, true]);
check("citing the phrase it acted on", /You wrote "Keep it visible in Offerworks too", so it stays shown in Offerworks\./.test(mock.proposal.reasoning), true);
const told = (words) => {
  const n = db.createNote({ projectId: offer.id, title: `told ${words}`, body: "q" });
  const f = items.flag({ entity: "note", id: n.id, note: words }).flag;
  return { f, ops: f.proposal && f.proposal.ops.map((o) => [o.op, o.to, Boolean(o.options && o.options.keepInSource)]) };
};
const both = told("Move it to Beta and keep it visible in Offerworks too");
check("an explicit move plus keep", both.ops, [["move", beta.id, true]]);
check("quoting both instructions", /You wrote "Move it to Beta", so it moves to Beta\. You wrote "keep it visible in Offerworks too"/.test(both.f.proposal.reasoning), true);
check("move here and also show it elsewhere is a move plus an association",
  told("Move it to Beta, and also show it in SSNR / MPI").ops, [["move", beta.id, false], ["associate", ssnr.id, false]]);
check("copy, not move, when it says copy", told("Copy it to Beta").ops, [["copy", beta.id, false]]);
check("in both, with a target, keeps the home", told("It belongs in Beta, in both places really").ops, [["move", beta.id, true]]);
const tracker = db.createProject({ key: "delphi-tracker", name: "Delphi tracker" });
check("a name that resolves to exactly one project is used", told("This belongs with Delphi").ops, [["move", tracker.id, false]]);

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
const lastEntry = items.getFlag(amb.id).entries.slice(-1)[0];
check("it asks which one, naming all three, instead of guessing", [lastEntry.kind, /"delphi" could be Delphi tracker \(\d+\), Delphi: the task system \(\d+\) or Delphi: the agent queue \(\d+\)\. Which one\?/.test(lastEntry.body)], ["ask", true]);
check("so it shows in Needs you as a question", items.needsYou().some((r) => r.id === amb.id && r.kind === "question"), true);
check("the Oracle's question is the Oracle's, not the person's", [lastEntry.author, lastEntry.author_type], ["oracle", "tool"]);
const systemId = db.handle().prepare("SELECT id FROM projects WHERE key = 'delphi-tasks'").get().id;
const answered = items.reply(amb.id, `Delphi: the task system (${systemId})`);
const afterAnswer = items.getFlag(amb.id);
check("a reply naming one, as the window's choice does, settles it and proposes it",
  [answered.kind, afterAnswer.flag.status, afterAnswer.flag.proposal && afterAnswer.flag.proposal.ops[0].to], ["say", "proposed", systemId]);
check("the question is not asked again", afterAnswer.entries.filter((e) => e.kind === "ask").length, 1);
check("and the proposal is the Oracle's too", [afterAnswer.entries.slice(-1)[0].author, afterAnswer.entries.slice(-1)[0].author_type], ["oracle", "tool"]);
for (const [what, reply] of [["by key", "delphi-queue"], ["by #id", `#${db.handle().prepare("SELECT id FROM projects WHERE key = 'delphi-queue'").get().id}`]]) {
  const n = db.createNote({ projectId: offer.id, title: `answer ${what}`, body: "q" });
  const f = items.flag({ entity: "note", id: n.id, note: "This belongs with Delphi" }).flag;
  items.reply(f.id, reply);
  const got = items.getFlag(f.id);
  check(`an answer ${what} settles it`, [got.flag.proposal && got.flag.proposal.ops[0].to, got.entries.filter((e) => e.kind === "ask").length],
    [db.handle().prepare("SELECT id FROM projects WHERE key = 'delphi-queue'").get().id, 1]);
}
const vague = db.createNote({ projectId: offer.id, title: "vague answer", body: "q" });
const vf = items.flag({ entity: "note", id: vague.id, note: "This belongs with Delphi" }).flag;
items.reply(vf.id, "not sure, you pick");
const vgot = items.getFlag(vf.id);
check("a reply that names none is told so once, not asked again", [vgot.entries.filter((e) => e.kind === "ask").length,
  /did not name one of/.test(vgot.entries.slice(-1)[0].body), vgot.entries.slice(-1)[0].author], [1, true, "oracle"]);

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
if (rejectedFlag.status === "proposed") W(items, rejectedFlag.id, { approve: false, note: "it is fine there" });
else items.withdraw(rejectedFlag.id);
check("a rejected suggestion stays dismissed", items.sweep({ projectId: claude.id }).created.some((f) => f.entity_id === vaInClaude.id), rejectedFlag.status !== "proposed");

section("an agent's words and chips are its suggestion, never the neighbours' finding");
const agentItems = makeItemStore({ sql: db.sqlP, batch: db.batchP, actor: "claude:7", authorType: "agent" });
const liveFlag = (id) => items.getFlag(id).flag;
const done = (f) => { if (["open", "evaluating", "proposed"].includes(liveFlag(f.id).status)) items.withdraw(f.id); };
done(flagged.flag);
// The neighbours alone settle the owner's note on the tracker's project.
const plain = items.flag({ entity: "note", id: misfiled.id, note: "" }).flag;
check("with no words, the neighbours send it to the tracker's project", [plain.proposal && plain.proposal.ops[0].to, Boolean(plain.proposal && plain.proposal.suggested_by)], [brain.id, false]);
const plainConfidence = plain.proposal.confidence;
done(plain);
const agrees = agentItems.flag({ entity: "note", id: misfiled.id, note: "move it to Second Brain app" }).flag;
check("an agent agreeing changes neither the answer nor its confidence", [agrees.proposal.ops[0].to, agrees.proposal.confidence, Boolean(agrees.proposal.suggested_by)],
  [brain.id, plainConfidence, false]);
done(agrees);
const spread = agentItems.flag({ entity: "note", id: misfiled.id, note: "move it to Second Brain app",
  evidence: Array.from({ length: 12 }, () => ({ type: "project", id: beta.id })) }).flag;
check("an agent agreeing while its chips spread the vote leaves the neighbours' answer theirs",
  [spread.proposal && spread.proposal.ops[0].to, spread.proposal && spread.proposal.confidence, Boolean(spread.proposal && spread.proposal.suggested_by)],
  [brain.id, plainConfidence, false]);
done(spread);
const chips = Array.from({ length: 12 }, () => ({ type: "project", id: beta.id }));
const tipped = agentItems.flag({ entity: "note", id: misfiled.id, note: "move it to Beta", evidence: chips }).flag;
console.log("   ", tipped.proposal_summary, "\n   ", tipped.proposal.reasoning);
check("an agent that tips the vote to another project gets its own name on it, at 0.5",
  [tipped.proposal.ops[0].to, tipped.proposal.confidence, tipped.proposal.suggested_by, tipped.proposal.suggested_by_type, tipped.proposal_summary],
  [beta.id, 0.5, "claude:7", "agent", "Suggested by agent claude:7: move to Beta (0.50)"]);
check("and the reasoning says where the neighbours pointed without it",
  /^Suggested by agent claude:7, who wrote "move it to Beta"\. No person has said so\. Without it, the neighbours point to Second Brain app\./.test(tipped.proposal.reasoning), true);
done(tipped);

const lonely = (title) => db.createNote({ projectId: offer.id, title, body: "qzxv wplm frobnicate" });
const chipNote = lonely("zzkq one");
const byAgent = agentItems.flag({ entity: "note", id: chipNote.id, note: "", evidence: [{ type: "project", id: beta.id }, { type: "project", id: beta.id }] }).flag;
check("an agent's evidence chips alone are its suggestion, at 0.5",
  [byAgent.proposal && byAgent.proposal.ops[0].to, byAgent.proposal && byAgent.proposal.confidence, byAgent.proposal && byAgent.proposal.suggested_by,
   byAgent.proposal && /from the evidence it attached/.test(byAgent.proposal.reasoning)], [beta.id, 0.5, "claude:7", true]);
done(byAgent);
const byPerson = items.flag({ entity: "note", id: chipNote.id, note: "", evidence: [{ type: "project", id: beta.id }, { type: "project", id: beta.id }] }).flag;
check("the same chips from a person are the person's vote", [byPerson.proposal && byPerson.proposal.ops[0].to, byPerson.proposal && byPerson.proposal.confidence > 0.5,
  Boolean(byPerson.proposal && byPerson.proposal.suggested_by)], [beta.id, true, false]);
done(byPerson);

section("whose words a flag's note is does not depend on who replied");
const n2 = lonely("zzkq two");
const humanFirst = items.flag({ entity: "note", id: n2.id, note: "move it to Beta", evaluate: "none" }).flag;
check("the flag row carries its author's type", humanFirst.created_by_type, "human");
agentItems.reply(humanFirst.id, "I would leave it where it is");
items.evaluate(humanFirst.id);
const hf = liveFlag(humanFirst.id);
check("a person's note is still their instruction after an agent replies", [hf.proposal && hf.proposal.ops[0].to, hf.proposal && hf.proposal.confidence,
  hf.proposal && /^You wrote "move it to Beta"/.test(hf.proposal.reasoning)], [beta.id, 0.9, true]);
done(humanFirst);
const n3 = lonely("zzkq three");
const agentFirst = agentItems.flag({ entity: "note", id: n3.id, note: "move it to Beta", evaluate: "none" }).flag;
check("an agent's flag row says agent", agentFirst.created_by_type, "agent");
items.reply(agentFirst.id, "hmm, not sure about this one");
items.evaluate(agentFirst.id);
const af = liveFlag(agentFirst.id);
check("an agent's note is still its suggestion after a person replies", [af.proposal && af.proposal.ops[0].to, af.proposal && af.proposal.confidence,
  af.proposal && af.proposal.suggested_by, af.proposal && /You wrote/.test(af.proposal.reasoning)], [beta.id, 0.5, "claude:7", false]);
done(agentFirst);

section("an archived project is no suggestion");
const shut = db.createProject({ key: "shut", name: "Shuttered" });
db.handle().prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(shut.id);
const n4 = lonely("zzkq four");
const toArchived = agentItems.flag({ entity: "note", id: n4.id, note: "move it to Shuttered" }).flag;
check("an agent naming an archived project proposes nothing", [toArchived.proposal, toArchived.status], [null, "open"]);
done(toArchived);

section("an agent's name and quote cannot pass for a person's");
const ray = makeItemStore({ sql: db.sqlP, batch: db.batchP, actor: "Ray", authorType: "agent" });
const n5 = lonely("zzkq five");
const posed = ray.flag({ entity: "note", id: n5.id, note: 'move it to Beta "now", says the person' }).flag;
console.log("   ", posed.proposal_summary, "\n   ", posed.proposal.reasoning);
check("an agent named Ray is labelled an agent", [posed.proposal_summary, /^Suggested by agent Ray, who wrote "/.test(posed.proposal.reasoning)],
  ["Suggested by agent Ray: move to Beta (0.50)", true]);
check("its quote marks cannot close the Oracle's quotation", (posed.proposal.reasoning.match(/"/g) || []).length, 2);
done(posed);

section("a stored proposal that touches another item is refused before anything changes");
const n6 = lonely("zzkq six");
const other = lonely("zzkq other");
const forged = items.flag({ entity: "note", id: n6.id, note: "", evaluate: "none" }).flag;
const bad = { ops: [{ op: "move", entity: "note", id: other.id, to: beta.id }], reasoning: "", confidence: 0.9, evaluator: "mallory" };
db.handle().prepare("UPDATE item_flags SET status = 'proposed', proposal = ?, proposed_by = 'mallory' WHERE id = ?").run(JSON.stringify(bad), forged.id);
db.handle().prepare("INSERT INTO flag_entries (flag_id, kind, author, author_type, body, meta) VALUES (?, 'note', 'mallory', 'agent', 'x', ?)")
  .run(forged.id, JSON.stringify({ proposal: bad }));
const entriesBefore = items.getFlag(forged.id).entries.length;
let forgedError = "";
try { W(items, forged.id, { approve: true }); } catch (error) { forgedError = error.message; }
check("it is refused, saying it is the stored proposal", /stored proposal changes something other than note \d+, so it was not applied/.test(forgedError), true);
check("and nothing changed: the flag, its thread, the other note",
  [liveFlag(forged.id).status, items.getFlag(forged.id).entries.length, db.handle().prepare("SELECT project_id FROM notes WHERE id = ?").get(other.id).project_id],
  ["proposed", entriesBefore, offer.id]);

console.log(`\n${checks - failures}/${checks} checks passed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
