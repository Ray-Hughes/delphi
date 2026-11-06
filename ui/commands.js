// Every place and action the top bar, Cmd+K and the G keys can reach.
//
// One registry, read by all three, so a place cannot be on a tab and missing
// from the bar, or in the bar with no key. Each command is plain data plus a
// run(), and run() only ever calls what app.js hands in: this file knows the
// names of the places, never how they are drawn.
//
// The tabs are the six of Direction B. Each maps onto a view that exists
// today, until the slices that build its own page:
//   Today    the Needs you page (it grows due and stuck work in slice 7)
//   Tasks    the task list, in the current scope
//   Memory   a project's notes, or the mind map across all of them
//   Pads     a project's pads
//   Chat     a project's chat, sessions and all
//   Runs     every agent's runs
// Pads and Chat belong to a project. Asked for from All projects they open the
// project last open, or the default one, rather than a page with nothing on it.
//
// Pure: no DOM and no window.delphi, so tools/commands_test.js loads it under
// Node and checks that every old place still has a way in.

globalThis.DelphiCommands = (() => {
  const TABS = [
    { id: "today", label: "Today", chord: "h" },
    { id: "tasks", label: "Tasks", chord: "t" },
    { id: "memory", label: "Memory", chord: "m" },
    { id: "pads", label: "Pads", chord: "p" },
    { id: "chat", label: "Chat", chord: "c" },
    { id: "runs", label: "Runs", chord: "r" },
  ];

  // Which tab a view belongs to. A view in none (Overview, History, Settings,
  // a search) leaves every tab unlit rather than lighting the wrong one.
  const VIEW_TAB = {
    inbox: "today", new: "today", reminders: "today",
    tasks: "tasks", queue: "tasks",
    notes: "memory", links: "memory", graph: "memory",
    pads: "pads", chat: "chat", runs: "runs",
  };

  function tabOf(state) {
    if (state.query) return null;
    return VIEW_TAB[state.view] || null;
  }

  /**
   * Where a tab goes from here, as a navigate() target. projectFor is asked
   * only when the tab needs a project and the scope is all of them.
   */
  function tabTarget(id, state, projectFor) {
    const inProject = state.projectId != null;
    const needsProject = (view) => (inProject ? { view } : { projectId: projectFor(), view });
    switch (id) {
      case "today": return { projectId: null, view: "inbox" };
      case "tasks": return { view: "tasks" };
      case "memory": return inProject ? { view: "notes" } : { view: "graph" };
      case "pads": return needsProject("pads");
      case "chat": return needsProject("chat");
      case "runs": return { projectId: null, view: "runs" };
      default: return null;
    }
  }

  /**
   * The registry. `app` is what app.js lends it:
   *   state()            the renderer's state
   *   go(target)         navigate there, clearing any search
   *   projectFor()       the project Pads and Chat open from All projects
   *   newTask(), newNote(), newProject(), addFolder(), openSettings(), toggleTheme(),
   *   undoLast(), openSwitcher(), openTask(id), scrollTop()
   *   themeIs()          "dark" or "light", as the window is showing it now
   */
  function make(app) {
    const go = (target) => (target ? app.go(target) : undefined);
    const inProject = () => app.state().projectId != null;
    const tab = (t) => ({
      id: `go-${t.id}`, group: "Go to", title: t.label, chord: t.chord, place: t.id,
      run: () => go(tabTarget(t.id, app.state(), app.projectFor)),
    });
    return [
      ...TABS.map(tab),
      { id: "go-needs", group: "Go to", title: "Needs you", chord: "i", place: "needs",
        run: async () => { await go({ projectId: null, view: "inbox" }); app.scrollTop(); } },
      { id: "go-whats-new", group: "Go to", title: "What's new", place: "whats-new", run: () => go({ projectId: null, view: "new" }) },
      { id: "go-queue", group: "Go to", title: "Queue: waiting for an agent", place: "queue", run: () => go({ view: "queue" }) },
      { id: "go-reminders", group: "Go to", title: "Reminders", place: "reminders", run: () => go({ projectId: null, view: "reminders" }) },
      { id: "go-mind-map", group: "Go to", title: "Mind map", place: "mind-map", run: () => go({ projectId: null, view: "graph" }) },
      { id: "go-links", group: "Go to", title: "Links", place: "links", when: inProject, run: () => go({ view: "links" }) },
      { id: "go-history", group: "Go to", title: "History", place: "history",
        run: () => go(inProject() ? { view: "activity" } : { projectId: null, view: "history" }) },
      { id: "go-overview", group: "Go to", title: "Project overview", place: "overview", when: inProject, run: () => go({ view: "overview" }) },
      { id: "go-project-settings", group: "Go to", title: "Project settings", place: "project-settings", when: inProject, run: () => go({ view: "project" }) },
      { id: "go-all", group: "Go to", title: "All projects", place: "all", run: () => go({ projectId: null, view: "new" }) },
      { id: "settings", group: "Commands", title: "Settings", keys: "⌘,", place: "settings", run: () => app.openSettings() },
      { id: "archived", group: "Commands", title: "Archived projects", place: "archived", run: () => app.openSettings("archived") },
      { id: "switch-project", group: "Commands", title: "Switch project", keys: "⌘P", run: () => app.openSwitcher() },
      { id: "new-task", group: "Commands", title: "New task", keys: "⌘N", run: () => app.newTask() },
      { id: "new-note", group: "Commands", title: "New note", run: () => app.newNote() },
      { id: "add-folder", group: "Commands", title: "Add folder as project", run: () => app.addFolder() },
      { id: "new-project", group: "Commands", title: "New project without a folder", run: () => app.newProject() },
      { id: "theme", group: "Commands", get title() { return app.themeIs() === "dark" ? "Switch to light theme" : "Switch to dark theme"; }, run: () => app.toggleTheme() },
      { id: "undo-last", group: "Commands", title: "Undo the last change", run: () => app.undoLast() },
    ];
  }

  /** The command a G chord's second key names, if any. */
  function chord(commands, key) {
    const k = String(key || "").toLowerCase();
    return commands.find((c) => c.chord === k) || null;
  }

  /**
   * Commands matching what was typed: every word somewhere in the title, the
   * ones that start with the first word first. Commands not available here
   * (a project's Links from All projects) are left out.
   */
  function match(commands, query, state) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const here = commands.filter((c) => !c.when || c.when(state));
    if (!words.length) return here;
    const hits = here.filter((c) => words.every((w) => c.title.toLowerCase().includes(w)));
    return hits.sort((a, b) => Number(b.title.toLowerCase().startsWith(words[0])) - Number(a.title.toLowerCase().startsWith(words[0])));
  }

  return { TABS, tabOf, tabTarget, make, chord, match };
})();

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.DelphiCommands;
