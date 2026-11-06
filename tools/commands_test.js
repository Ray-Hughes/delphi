#!/usr/bin/env node
// test-runtime: node
// Every old place still has a way in, and every G chord goes somewhere.
//
//   node tools/commands_test.js
//
// Direction B removes the sidebar and the tab strip, and that is only safe if
// nothing they reached is now unreachable. This loads the registry the Cmd+K
// bar and the G keys both read (ui/commands.js), with ui/core.js and
// ui/palette.js beside it the way the window loads them, against a stub of
// what app.js lends it, and checks each place from the plan (section 1.1) by
// running its command and looking at where it asked to go.

const path = require("path");

let checks = 0;
let failures = 0;
function check(what, got, want) {
  checks++;
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log(`  ok   ${what}`); return; }
  failures++;
  console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
}
function section(name) { console.log(`\n${name}`); }

require(path.join(__dirname, "..", "ui", "core.js"));
const C = require(path.join(__dirname, "..", "ui", "commands.js"));
require(path.join(__dirname, "..", "ui", "palette.js"));

// What app.js lends, recording every trip and action instead of making it.
const calls = [];
let state = { projectId: null, view: "new", query: "" };
const app = {
  state: () => state,
  go: (target) => { calls.push(["go", target]); },
  projectFor: () => 12,
  newTask: () => calls.push(["newTask"]),
  newNote: () => calls.push(["newNote"]),
  newProject: () => calls.push(["newProject"]),
  openSettings: (anchor) => calls.push(["settings", anchor || null]),
  toggleTheme: () => calls.push(["theme"]),
  undoLast: () => calls.push(["undo"]),
  openSwitcher: () => calls.push(["switcher"]),
  openTask: (id) => calls.push(["task", id]),
  scrollTop: () => calls.push(["top"]),
  themeIs: () => "dark",
};
const commands = C.make(app);
const byPlace = (place) => commands.find((c) => c.place === place);
async function run(c, from) {
  state = { query: "", ...from };
  calls.length = 0;
  await c.run();
  return calls.slice();
}

async function main() {
  section("the palette loads beside the registry");
  check("ui/palette.js defines the bar without a window", typeof globalThis.DelphiPalette.open, "function");

  section("every place the old window had (plan 1.1)");
  const all = { projectId: null, view: "new" };
  const proj = { projectId: 1, view: "overview" };
  const places = [
    ["today", all, [["go", { projectId: null, view: "inbox" }]]],
    ["needs", all, [["go", { projectId: null, view: "inbox" }], ["top"]]],
    ["whats-new", proj, [["go", { projectId: null, view: "new" }]]],
    ["reminders", proj, [["go", { projectId: null, view: "reminders" }]]],
    ["tasks", proj, [["go", { view: "tasks" }]]],
    ["queue", proj, [["go", { view: "queue" }]]],
    ["memory", proj, [["go", { view: "notes" }]]],
    ["memory", all, [["go", { view: "graph" }]]],
    ["links", proj, [["go", { view: "links" }]]],
    ["mind-map", proj, [["go", { projectId: null, view: "graph" }]]],
    ["pads", proj, [["go", { view: "pads" }]]],
    ["pads", all, [["go", { projectId: 12, view: "pads" }]]],
    ["chat", proj, [["go", { view: "chat" }]]],
    ["chat", all, [["go", { projectId: 12, view: "chat" }]]],
    ["runs", proj, [["go", { projectId: null, view: "runs" }]]],
    ["history", all, [["go", { projectId: null, view: "history" }]]],
    ["history", proj, [["go", { view: "activity" }]]],
    ["overview", proj, [["go", { view: "overview" }]]],
    ["project-settings", proj, [["go", { view: "project" }]]],
    ["settings", proj, [["settings", null]]],
    ["archived", all, [["settings", "archived"]]],
    ["all", proj, [["go", { projectId: null, view: "new" }]]],
  ];
  for (const [place, from, want] of places) {
    const c = byPlace(place);
    if (!c) { check(`${place} has a command`, false, true); continue; }
    check(`${place}, from ${from.projectId == null ? "All projects" : "a project"}`, await run(c, from), want);
  }
  for (const id of ["new-task", "new-note", "new-project", "theme", "switch-project", "undo-last"]) {
    check(`${id} is a command`, Boolean(commands.find((c) => c.id === id)), true);
  }
  check("the theme command says which way it switches", commands.find((c) => c.id === "theme").title, "Switch to light theme");

  section("the six tabs, and the G chords");
  check("the tabs are Direction B's, with Chat and without Sessions", C.TABS.map((t) => t.label), ["Today", "Tasks", "Memory", "Pads", "Chat", "Runs"]);
  const chords = commands.filter((c) => c.chord).map((c) => c.chord);
  check("each chord letter is used once", new Set(chords).size, chords.length);
  for (const [letter, place] of [["h", "today"], ["t", "tasks"], ["m", "memory"], ["p", "pads"], ["c", "chat"], ["r", "runs"], ["i", "needs"]]) {
    const c = C.chord(commands, letter);
    check(`G ${letter.toUpperCase()} goes to ${place}`, c && c.place, place);
  }
  check("a capital after G works too", (C.chord(commands, "T") || {}).place, "tasks");
  check("a letter with no place does nothing", C.chord(commands, "z"), null);
  for (const t of C.TABS) check(`the ${t.label} tab has a G chord`, Boolean(C.chord(commands, t.chord)), true);

  section("which tab is lit");
  const lit = (view, extra = {}) => C.tabOf({ view, query: "", ...extra });
  check("Needs you and What's new are Today", [lit("inbox"), lit("new")], ["today", "today"]);
  check("the queue is part of Tasks", lit("queue"), "tasks");
  check("notes, links and the mind map are Memory", [lit("notes"), lit("links"), lit("graph")], ["memory", "memory", "memory"]);
  check("Overview, History and Settings light none", [lit("overview"), lit("activity"), lit("settings")], [null, null, null]);
  check("a search lights none", lit("tasks", { query: "x" }), null);

  section("the bar's matching");
  check("typing runs finds Runs first", C.match(commands, "runs", {})[0].place, "runs");
  check("every word has to match", C.match(commands, "new note", {}).map((c) => c.id), ["new-note"]);
  state = { projectId: null, view: "new", query: "" };
  check("a project's Links is not offered from All projects", C.match(commands, "links", state).length, 0);
  state = { projectId: 1, view: "tasks", query: "" };
  check("and is from inside one", C.match(commands, "links", state).map((c) => c.place), ["links"]);
  check("nothing typed lists everything available", C.match(commands, "", state).length > 20, true);

  section("every view outside the six tabs has its own title and a way back");
  const head = (view, projectId = null) => C.heading({ view, projectId, query: "" }, "Caseflow");
  for (const [view, title] of [["settings", "Settings"], ["history", "History"], ["queue", "Queue"], ["reminders", "Reminders"], ["graph", "Mind map"], ["new", "What's new"]]) {
    const h = head(view);
    check(`${title}, in All projects`, [h && h.title, h && h.crumbs[0].label, Boolean(h && h.subtitle)], [title, "All projects", true]);
  }
  for (const [view, title] of [["project", "Settings"], ["activity", "History"], ["links", "Links"], ["queue", "Queue"]]) {
    const h = head(view, 4);
    check(`a project's ${title}, under the project`, [h && h.title, h && h.crumbs[0].label, h && h.crumbs[0].target], [title, "Caseflow", { view: "overview" }]);
  }
  check("a view the tabs name keeps the project's heading", [head("tasks", 4), head("notes", 4), head("overview", 4)], [null, null, null]);
  check("a search has its own heading", C.heading({ view: "settings", projectId: null, query: "x" }), null);

  section("a search can be seen both ways, and switching keeps the query");
  const sv = C.searchViews({ view: "oracle", query: "task", oracleHits: [1, 2], tasks: [1, 2, 3], notes: [1] });
  check("Oracle and Matches, with counts, Oracle lit", sv.map((v) => [v.label, v.count, v.on]), [["Oracle", 2, true], ["Matches", 4, false]]);
  check("neither target names the query, so navigate() keeps it", sv.every((v) => !("query" in v.target) && !("projectId" in v.target)), true);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
