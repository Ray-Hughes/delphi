// Every place and action the top bar, Cmd+K and the G keys can reach.
//
// One registry, read by all three, so a place cannot be on a tab and missing
// from the bar, or in the bar with no key. Each command is plain data plus a
// run(), and run() only ever calls what app.js hands in: this file knows the
// names of the places, never how they are drawn.
//
// The tabs are the six of Direction B. Each maps onto a view that exists
// today, until the slices that build its own page:
//   Today    its own page (ui/today.js): what is on, Needs you, the brief
//   Tasks    the task list, in the current scope
//   Memory   its own page (ui/memory.js): notes as rows, in this project or all
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
    today: "today", inbox: "today", new: "today", reminders: "today",
    tasks: "tasks", queue: "tasks",
    memory: "memory", notes: "memory", links: "memory", graph: "memory",
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
      case "today": return { projectId: null, view: "today" };
      case "tasks": return { view: "tasks" };
      case "memory": return { view: "memory" };
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
  // The platform's spelling of a shortcut, from ui/core.js in the window. A
  // test that loads this file alone gets the Mac's.
  const keys = (k) => (typeof shortcut === "function" ? shortcut(k) : `\u2318${k}`);

  function make(app) {
    const go = (target) => (target ? app.go(target) : undefined);
    const inProject = () => app.state().projectId != null;
    const tab = (t) => ({
      id: `go-${t.id}`, group: "Go to", title: t.label, chord: t.chord, place: t.id,
      // Today is Home: the Home control at the top left goes there, and so
      // does G then H, which is why its letter is h.
      ...(t.id === "today" ? { keywords: "home dashboard" } : {}),
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
      { id: "go-notes", group: "Go to", title: "Edit notes: every note in full", place: "notes", when: inProject, run: () => go({ view: "notes" }) },
      { id: "go-links", group: "Go to", title: "Links", place: "links", when: inProject, run: () => go({ view: "links" }) },
      { id: "go-history", group: "Go to", title: "History", place: "history",
        run: () => go(inProject() ? { view: "activity" } : { projectId: null, view: "history" }) },
      { id: "go-overview", group: "Go to", title: "Project overview", place: "overview", when: inProject, run: () => go({ view: "overview" }) },
      { id: "go-project-settings", group: "Go to", title: "Project settings", place: "project-settings", when: inProject, run: () => go({ view: "project" }) },
      { id: "go-all", group: "Go to", title: "All projects", place: "all", run: () => go({ projectId: null, view: "new" }) },
      { id: "settings", group: "Commands", title: "Settings", keys: keys(","), place: "settings", run: () => app.openSettings() },
      { id: "archived", group: "Commands", title: "Archived projects", place: "archived", run: () => app.openSettings("archived") },
      { id: "switch-project", group: "Commands", title: "Switch project", keys: keys("P"), run: () => app.openSwitcher() },
      { id: "new-task", group: "Commands", title: "New task", keys: keys("N"), run: () => app.newTask() },
      { id: "new-note", group: "Commands", title: "New note", run: () => app.newNote() },
      { id: "add-folder", group: "Commands", title: "Add folder as project", run: () => app.addFolder() },
      { id: "new-project", group: "Commands", title: "New project without a folder", run: () => app.newProject() },
      { id: "theme", group: "Commands", get title() { return app.themeIs() === "dark" ? "Switch to light theme" : "Switch to dark theme"; }, run: () => app.toggleTheme() },
      { id: "undo-last", group: "Commands", title: "Undo the last change", run: () => app.undoLast() },
    ];
  }

  /**
   * The heading of a view outside the six tabs. Each used to be named by the
   * tab strip it sat in; with that gone, a page with the project's name over
   * it (or "All work") gave no clue it was Settings or History. So each has its
   * own title, and a breadcrumb back to where it belongs. Null for a view the
   * tabs already name, whose heading stays the project's or the scope's.
   */
  const PLACES = {
    all: {
      settings: ["Settings", "How Delphi looks, which agents it can run, and where it keeps your data."],
      history: ["History", "Every change, by whom, across every project. Each one can be undone."],
      queue: ["Queue", "Tasks waiting for an agent to pick them up, across every project."],
      reminders: ["Reminders", "What is set to remind you, and when."],
      graph: ["Mind map", "What your notes and tasks mention, and which of those things turn up together."],
      new: ["What's new", "What changed lately, across every project."],
    },
    project: {
      project: ["Settings", "This project's name, folders and colour, and how agents may work in it."],
      activity: ["History", "Every change in this project, by whom. Each one can be undone."],
      links: ["Links", "The links kept in this project."],
      queue: ["Queue", "This project's tasks waiting for an agent to pick them up."],
    },
  };
  function heading(state, projectName = "") {
    if (state.query) return null;
    const inProject = state.projectId != null;
    const place = (inProject ? PLACES.project : state.workspaceId ? {} : PLACES.all)[state.view];
    if (!place) return null;
    const home = inProject
      ? { label: projectName || "This project", target: { view: "overview" } }
      : { label: "All projects", target: { projectId: null, view: "new" } };
    return { title: place[0], subtitle: place[1], crumbs: state.view === "new" && !inProject ? [{ label: "All projects", target: null }] : [home] };
  }

  /** Home: Today, across every project. The Home control and G then H go here. */
  const HOME = { projectId: null, view: "today" };
  const isHome = (state) => !state.query && state.projectId == null && state.view === "today";

  // The words for a view the tabs and PLACES do not name.
  const NAMES = { inbox: "Needs you", runs: "Runs", overview: "Overview", workspace: "Folder", oracle: "Search" };

  /**
   * The breadcrumb over every page but Home: Home first, then the project
   * when there is one, then where you are. Each crumb but the last is a
   * navigate() target. Null on Home itself, which is where every trail starts.
   */
  function trail(state, projectName = "") {
    if (isHome(state)) return null;
    const crumbs = [{ label: "Home", target: HOME }];
    if (state.query) return { crumbs, here: "Search" };
    const project = projectName || "This project";
    if (state.projectId != null) {
      if (state.view === "overview") return { crumbs, here: project };
      crumbs.push({ label: project, target: { view: "overview" } });
    }
    const place = heading(state, projectName);
    const tab = TABS.find((t) => t.id === tabOf(state) && t.id !== "today");
    const here = place ? place.title : NAMES[state.view] || (tab ? tab.label : null) || state.view;
    return { crumbs, here };
  }

  /**
   * The two ways to see a search, Oracle and Matches, as the toggle on the
   * results page draws them. A target never names the query, so switching
   * keeps it: navigate() changes only what it is given.
   */
  function searchViews(state) {
    return [
      { id: "oracle", label: "Oracle", count: (state.oracleHits || []).length, target: { view: "oracle" } },
      { id: "tasks", label: "Matches", count: (state.tasks || []).length + (state.notes || []).length, target: { view: "tasks" } },
    ].map((v) => ({ ...v, on: state.view === v.id }));
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
    // A quiet command (each setting is one) is found by typing, never listed
    // on the empty bar; its keywords count as well as its title.
    const here = commands.filter((c) => (!c.when || c.when(state)) && (words.length || !c.quiet));
    if (!words.length) return here;
    const hits = here.filter((c) => words.every((w) => `${c.title} ${c.keywords || ""}`.toLowerCase().includes(w)));
    return hits.sort((a, b) => Number(b.title.toLowerCase().startsWith(words[0])) - Number(a.title.toLowerCase().startsWith(words[0])));
  }

  return { TABS, HOME, isHome, tabOf, tabTarget, make, chord, match, heading, trail, searchViews };
})();

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.DelphiCommands;
