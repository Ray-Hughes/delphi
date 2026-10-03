#!/usr/bin/env node
// Round trips a scratchpad through the board and back.
//
//   node tools/pad_test.js
//
// No framework, for the same reason the app has no dependencies. This is the one
// piece of Delphi with enough logic and enough blast radius to be worth a test:
// the sync writes to a document a person has open and to a board they rely on,
// and every way it can go wrong is quiet. A duplicated task, a lost assignee, an
// agent rewriting its plan and emptying the board.
//
// Runs against a throwaway database in a temp directory, which is what
// DELPHI_DATA_DIR is for, so it can never touch the real one.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-pad-"));
process.env.DELPHI_DATA_DIR = dir;

const db = require("../db");
const pads = require("../pads");
const harness = require("../harness");

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

function section(name) { console.log(`\n${name}`); }

// ---------------------------------------------------------------------------
// The grammar, with no database in the way

section("parsing");

const sample = [
  "# Plan",
  "",
  "Some prose that is not a task.",
  "",
  "- [ ] wire the codex adapter @ray !high",
  "- [x] terminal beside the chat",
  "  - [ ] and a busy dot on the tab",
  "* [ ] a star bullet counts too",
].join("\n");

const parsed = pads.parse(sample);
check("finds only checkbox lines", parsed.length, 4);
check("strips the decorations from the title", parsed[0].title, "wire the codex adapter");
check("reads the assignee", parsed[0].assignee, "ray");
check("reads the priority", parsed[0].priority, "high");
check("reads a ticked box", parsed[1].done, true);
check("nests by indentation", parsed[2].parentIndex, 1);
check("a top level line has no parent", parsed[3].parentIndex, null);
check("prose is left out", parsed.map((e) => e.index), [4, 5, 6, 7]);

check("an unticked box does not drag a task out of doing", pads.statusFor(false, "doing"), "doing");
check("an unticked box does clear done", pads.statusFor(false, "done"), "todo");
check("a ticked box is always done", pads.statusFor(true, "blocked"), "done");

// An email in a line is not an assignee, and a sentence ending in an exclamation
// mark is not a priority. Both were real ways the first version of the grammar
// ate part of a title.
const awkward = pads.parse("- [ ] email r.hughes2136@gmail.com about this!");
check("leaves an email alone", awkward[0].title, "email r.hughes2136@gmail.com about this!");
check("finds no assignee in an email", awkward[0].assignee, null);
check("finds no priority in a bare bang", awkward[0].priority, null);

// ---------------------------------------------------------------------------
// The sync

section("deriving");

const project = db.createProject({ key: "pad-test", name: "Pad test" });

let pad = db.createScratchpad({
  projectId: project.id,
  title: "Plan",
  author: "codex",
  body: [
    "## Plan",
    "",
    "- [ ] wire the codex adapter @ray !high",
    "- [x] terminal beside the chat",
    "  - [ ] and a busy dot on the tab",
  ].join("\n"),
});

let tasks = db.listTasks({ projectId: project.id, includeDone: true, includeSubtasks: true });
check("one task per checkbox line", tasks.length, 3);

const adapter = tasks.find((t) => t.title === "wire the codex adapter");
const terminal = tasks.find((t) => t.title === "terminal beside the chat");
const dot = tasks.find((t) => t.title === "and a busy dot on the tab");

check("carries the assignee", adapter.assignee, "ray");
check("carries the priority", adapter.priority, "high");
check("a ticked line arrives done", terminal.status, "done");
check("an indented line is a subtask", dot.parent_id, terminal.id);
check("every derived task knows its pad", [adapter.pad_id, terminal.pad_id, dot.pad_id],
      [pad.id, pad.id, pad.id]);
check("the line is anchored", pads.parse(pad.body)[0].taskId, adapter.id);

section("deriving twice changes nothing");

const before = db.listTasks({ projectId: project.id, includeDone: true, includeSubtasks: true }).length;
pad = db.writeScratchpad(pad.id, { body: pad.body });
check("no duplicates on a rewrite of the same text",
      db.listTasks({ projectId: project.id, includeDone: true, includeSubtasks: true }).length, before);

section("board to pad");

db.updateTask(adapter.id, { status: "done" });
pad = db.getScratchpad(pad.id);
check("ticking the task ticks the line", pads.parse(pad.body)[0].done, true);

db.updateTask(adapter.id, { title: "wire the codex adapter properly", status: "doing" });
pad = db.getScratchpad(pad.id);
check("renaming the task renames the line", pads.parse(pad.body)[0].title, "wire the codex adapter properly");
check("and unticks it again", pads.parse(pad.body)[0].done, false);
check("and keeps the anchor", pads.parse(pad.body)[0].taskId, adapter.id);
check("and keeps the assignee", pads.parse(pad.body)[0].assignee, "ray");

section("pad to board");

// The board owns doing, so an unticked box must leave it there.
pad = db.writeScratchpad(pad.id, { body: pad.body });
check("a pad write does not drag doing back to todo",
      db.taskDetail(adapter.id).task.status, "doing");

section("an agent rewrites the pad from scratch");

// The anchors are gone, because the agent regenerated the document. Every line
// should find its task again rather than filing the work twice.
const rewritten = [
  "## Plan",
  "",
  "- [ ] wire the codex adapter properly @ray !high",
  "- [x] terminal beside the chat",
  "  - [ ] and a busy dot on the tab",
  "- [ ] something genuinely new",
].join("\n");

pad = db.writeScratchpad(pad.id, { body: rewritten });
tasks = db.listTasks({ projectId: project.id, includeDone: true, includeSubtasks: true });
check("rebinds rather than duplicating", tasks.length, 4);
check("the rebound task is the same row", pads.parse(pad.body)[0].taskId, adapter.id);
check("and it kept the status the board gave it", db.taskDetail(adapter.id).task.status, "doing");

section("a line disappears");

const trimmed = [
  "## Plan",
  "",
  "- [x] terminal beside the chat",
].join("\n");

pad = db.writeScratchpad(pad.id, { body: trimmed });
tasks = db.listTasks({ projectId: project.id, includeDone: true, includeSubtasks: true });
check("dropping a line does not delete the task", tasks.length, 4);
const { dropped } = db.scratchpadTasks(pad.id);
check("the dropped tasks are named", dropped.length, 3);
check("the survivor is still anchored", pads.parse(pad.body)[0].taskId, terminal.id);

section("deleting the pad");

db.deleteScratchpad(pad.id);
check("the work outlives the document",
      db.listTasks({ projectId: project.id, includeDone: true, includeSubtasks: true }).length, 4);

// ---------------------------------------------------------------------------
// The argv templates
//
// Here rather than in a file of its own because it is the same kind of thing:
// rules with edge cases, exercised nowhere else except inside a spawned process
// where the only symptom of getting them wrong is an agent that never answers.

section("argv templates");

const claude = harness.BUILTINS.find((h) => h.key === "claude-code");
const codex = harness.BUILTINS.find((h) => h.key === "codex");

check("drops an optional flag whose value is missing",
      harness.expand(claude.args, { prompt: "hi" }).includes("--model"), false);
check("keeps it when there is one",
      harness.expand(claude.args, { prompt: "hi", model: "opus" }).join(" ").includes("--model opus"), true);
check("a gate that is off leaves the group out",
      harness.expand(claude.args, { prompt: "hi", autoAllow: false }).includes("bypassPermissions"), false);
check("and the other branch is in",
      harness.expand(claude.args, { prompt: "hi", autoAllow: false }).includes("--tools"), true);
check("a gate that is on swaps them",
      harness.expand(claude.args, { prompt: "hi", autoAllow: true }).includes("bypassPermissions"), true);
check("a splice becomes several arguments",
      harness.expand(claude.args, { prompt: "hi", mcpFlags: ["--mcp-config", "/tmp/x.json"] }).slice(-2),
      ["--mcp-config", "/tmp/x.json"]);
check("an empty splice becomes none",
      harness.expand(claude.args, { prompt: "hi", mcpFlags: [] }).includes("{mcpFlags}"), false);

// Position is load bearing for Codex: resume is a subcommand, so it has to land
// straight after exec or the command line means something else.
check("no resume, no subcommand", harness.expand(codex.args, { prompt: "hi" }).slice(0, 2), ["exec", "--json"]);
check("resume sits where the subcommand goes",
      harness.expand(codex.args, { prompt: "hi", resume: "abc" }).slice(0, 3), ["exec", "resume", "abc"]);
check("the prompt is still last",
      harness.expand(codex.args, { prompt: "hi", resume: "abc" }).slice(-1), ["hi"]);

// A prompt is untrusted text. It has to arrive as one argument whatever is in it.
const nasty = 'say "hi"; rm -rf / && echo $HOME `whoami`';
check("a prompt with shell in it stays one argument",
      harness.expand(claude.args, { prompt: nasty }).filter((a) => a === nasty).length, 1);

check("the copilot config path is prefixed for that CLI",
      harness.mcpFlags("flag:--additional-mcp-config|@", { dbPath: "/tmp/d.db", sessionId: 1, actor: "t" })
        .flags[1].startsWith("@"), true);
check("and is not for the others",
      harness.mcpFlags("flag:--mcp-config", { dbPath: "/tmp/d.db", sessionId: 1, actor: "t" })
        .flags[1].startsWith("@"), false);
check("codex gets dotted overrides rather than a file",
      harness.mcpFlags("codex-config", { dbPath: "/tmp/d.db", sessionId: 1, actor: "t" }).file, null);

// ---------------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
