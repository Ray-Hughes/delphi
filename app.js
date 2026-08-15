// Renderer. Talks to the main process through window.delphi only.

const state = {
  projects: [],
  projectId: null,     // null means the All view
  view: "new",         // new | overview | tasks | notes | links | history | settings
  showDone: false,
  // Set by the dashboard tiles, so a tile is a way into the list rather than a
  // number you then have to go and find yourself. Cleared whenever the list is
  // reached by any other route.
  taskFilter: null,    // null | doing | blocked | overdue | done
  theme: "system",     // system | light | dark
  noteView: "formatted", // formatted | raw
  query: "",
  tasks: [],
  notes: [],
  links: [],
  repos: [],
  allTasks: [],
  // Where we have been, so Back can return. Holds the whole position rather than
  // just the project, because returning to the right project on the wrong tab is
  // not returning.
  history: [],
  oracleHits: [],
  oracleEntities: [],
  oracleError: null,
  provider: null,
};

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) {
    if (k == null) continue;
    node.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return node;
};

const today = () => new Date().toISOString().slice(0, 10);
const isOverdue = (t) => t.due && t.status !== "done" && t.due < today();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Applies a theme choice.
 *
 * "system" removes the attribute rather than resolving the preference here, so
 * the media query stays in charge and the window follows the system if it
 * changes while open. The other two pin it.
 */
function applyTheme(theme) {
  const choice = ["light", "dark"].includes(theme) ? theme : "system";
  state.theme = choice;
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/**
 * Renders the markdown subset the notes actually contain.
 *
 * Agents write these notes, and they write headings, tables, fenced code,
 * lists and links. Nothing here is a general markdown implementation; it is
 * the smallest thing that renders our own notes faithfully.
 *
 * Everything is built as DOM nodes rather than assembled into innerHTML. The
 * content is our own, but a renderer that pastes strings into the document is
 * one imported note away from being an injection point, and the page runs with
 * a strict CSP precisely so that cannot happen.
 */
function inlineMarkdown(text) {
  const out = [];
  // Emphasis may not be flanked by spaces, so arithmetic and shell globs in a
  // note ("2 * 3 * 4") are left alone rather than silently italicised.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*(?!\s)[^*\n]*?(?<!\s)\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(document.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      out.push(el("code", { textContent: token.slice(1, -1) }));
    } else if (token.startsWith("**")) {
      out.push(el("strong", { textContent: token.slice(2, -2) }));
    } else if (token.startsWith("*")) {
      out.push(el("em", { textContent: token.slice(1, -1) }));
    } else {
      const split = token.indexOf("](");
      const href = token.slice(split + 2, -1);
      const link = el("a", { textContent: token.slice(1, split), href: "#", title: href });
      // Only http(s) leaves the app, and it leaves through the main process
      // rather than navigating this window.
      link.onclick = (e) => {
        e.preventDefault();
        if (/^https?:\/\//i.test(href)) window.delphi.openExternal(href);
      };
      out.push(link);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

const isTableSeparator = (line) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
const splitRow = (line) => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

function renderMarkdown(source) {
  const root = el("div", { className: "md" });
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    // Fenced code. An unterminated fence runs to the end rather than throwing
    // away the rest of the note.
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;
      root.append(el("pre", {}, el("code", { textContent: body.join("\n") })));
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { root.append(el("hr")); i += 1; continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      root.append(el(`h${level}`, {}, inlineMarkdown(heading[2].trim())));
      i += 1;
      continue;
    }

    // Table: a pipe row followed by a dash rule.
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const table = el("table");
      const head = el("tr");
      splitRow(line).forEach((cell) => head.append(el("th", {}, inlineMarkdown(cell))));
      table.append(el("thead", {}, head));
      const tbody = el("tbody");
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        const tr = el("tr");
        splitRow(lines[i]).forEach((cell) => tr.append(el("td", {}, inlineMarkdown(cell))));
        tbody.append(tr);
        i += 1;
      }
      table.append(tbody);
      root.append(el("div", { className: "table-wrap" }, table));
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, "")); i += 1; }
      root.append(el("blockquote", {}, ...inlineMarkdown(body.join(" "))));
      continue;
    }

    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const marker = ordered ? numbered : bullet;
      const list = el(ordered ? "ol" : "ul");
      while (i < lines.length && marker.test(lines[i])) {
        list.append(el("li", {}, inlineMarkdown(lines[i].replace(marker, ""))));
        i += 1;
      }
      root.append(list);
      continue;
    }

    // Paragraph: runs until a blank line or the start of another block.
    const para = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^\s*(#{1,6}\s|>|```)/.test(lines[i]) &&
      !bullet.test(lines[i]) && !numbered.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) { para.push(lines[i].trim()); i += 1; }
    if (para.length) root.append(el("p", {}, ...inlineMarkdown(para.join(" "))));
  }

  return root;
}

/** "3 days ago" reads faster than a timestamp when scanning activity. */
function ago(iso) {
  if (!iso) return "";
  const then = new Date(iso.replace(" ", "T"));
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : then.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function refresh() {
  state.projects = await window.delphi.projects.list();

  if (state.query) {
    const { tasks, notes } = await window.delphi.search(state.query);
    state.tasks = tasks;
    state.notes = notes;
    state.links = [];
    state.repos = [];

    // Meaning-based ranking and the graph, in parallel with the literal match, so
    // the Oracle tab is ready rather than loading when it is opened.
    try {
      state.oracleError = null;
      state.provider = await window.delphi.oracle.provider();
      state.oracleHits = await window.delphi.oracle.nearest(state.query, { limit: 10 });
      const ctx = await window.delphi.oracle.context(state.query.split(/\s+/)[0]);
      state.oracleEntities = ctx ? ctx.related : [];
    } catch (error) {
      // The Oracle is an enhancement, so plain search must survive losing it.
      // The reason is kept rather than discarded: "nothing matched" and "the
      // Oracle never ran" look identical on screen otherwise.
      state.oracleHits = [];
      state.oracleEntities = [];
      state.oracleError = String(error.message || error);
    }
  } else {
    state.allTasks = await window.delphi.tasks.list({
      projectId: state.projectId,
      includeDone: true,
    });
    state.tasks = state.showDone
      ? state.allTasks
      : state.allTasks.filter((t) => t.status !== "done");
    if (state.projectId) {
      state.notes = await window.delphi.notes.list(state.projectId);
      state.links = await window.delphi.links.list(state.projectId);
      state.repos = await window.delphi.repos.list(state.projectId);
    } else {
      state.notes = [];
      state.links = [];
      state.repos = [];
    }
  }
  render();
}

const currentProject = () => state.projects.find((p) => p.id === state.projectId) || null;

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

/** Current position, as the thing Back restores. */
const position = () => ({ projectId: state.projectId, view: state.view, query: state.query });

const samePosition = (a, b) =>
  a.projectId === b.projectId && a.view === b.view && a.query === b.query;

/**
 * Moves to a new position, remembering the old one.
 *
 * Repeats are not pushed, so holding Back does not walk through a run of
 * identical entries, and the depth is capped because this is a panel, not a
 * browser: nobody needs to unwind fifty steps.
 */
function navigate(next) {
  const from = position();
  // A filter belongs to the trip that set it. Any other move into the task list,
  // or out of it, drops the filter rather than leaving a list quietly narrowed.
  if (next.view !== undefined) state.taskFilter = null;
  Object.assign(state, next);
  const to = position();
  if (samePosition(from, to)) return Promise.resolve();

  state.history.push(from);
  if (state.history.length > 50) state.history.shift();
  // The repaint is handed back so a caller can wait for it. The menu needs that:
  // the composer it wants to put the cursor in is created by the render and does
  // not exist in the document until this has finished.
  return refresh();
}

/**
 * Opens the task list narrowed to one slice of it.
 *
 * Done is the exception that needs showDone turned on, since the list hides
 * finished work by default and a Done tile that led to an empty list would
 * look broken.
 */
function showTasks(filter) {
  const already = state.view === "tasks";
  if (filter === "done") state.showDone = true;
  if (already) {
    state.taskFilter = filter;
    refresh();
    return;
  }
  navigate({ view: "tasks" });
  state.taskFilter = filter;
  refresh();
}

function goBack() {
  const previous = state.history.pop();
  if (!previous) return false;
  state.projectId = previous.projectId;
  state.view = previous.view;
  state.query = previous.query;
  $("search").value = previous.query || "";
  refresh();
  return true;
}

function renderSidebar() {
  const box = $("projects");
  box.textContent = "";

  const allOpen = state.projects.reduce((n, p) => n + p.open_count, 0);
  box.append(projectRow({ id: null, name: "All work", colour: "#8d97a9", open_count: allOpen }));

  for (const p of state.projects) box.append(projectRow(p));
}

function projectRow(p) {
  const row = el("div", {
    className: "proj" + (state.projectId === p.id ? " active" : ""),
    tabIndex: 0,
    role: "button",
  });
  row.append(el("span", { className: "dot", style: `background:${p.colour || "#8d97a9"}` }));
  row.append(el("span", { className: "proj-name", textContent: p.name, title: p.summary || p.name }));
  if (p.open_count) row.append(el("span", { className: "count", textContent: String(p.open_count) }));

  const go = () => {
    $("search").value = "";
    // Landing on a project shows its dashboard; All has no dashboard to show.
    navigate({ projectId: p.id, view: p.id ? "overview" : "new", query: "" });
  };
  row.onclick = go;
  row.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
  return row;
}

function renderTabs() {
  const box = $("tabs");
  box.textContent = "";

  const tabs = state.query
    ? [["oracle", "Oracle", state.oracleHits.length], ["tasks", "Matches", state.tasks.length + state.notes.length]]
    : state.projectId
    ? [["overview", "Overview"], ["tasks", "Tasks", state.tasks.length],
       ["notes", "Memory", state.notes.length], ["links", "Links", state.links.length],
       ["activity", "Activity"]]
    : [["new", "What's new"], ["tasks", "Tasks", state.tasks.length],
       ["history", "History"], ["settings", "Settings"]];

  for (const [key, label, count] of tabs) {
    const tab = el("div", { className: "tab" + (state.view === key ? " active" : ""), tabIndex: 0, role: "tab" });
    tab.append(label);
    if (count) tab.append(el("span", { className: "n", textContent: String(count) }));
    const go = () => navigate({ view: key });
    tab.onclick = go;
    tab.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    box.append(tab);
  }
}

function render() {
  renderSidebar();

  const p = currentProject();
  if (state.query) {
    $("title").textContent = "Search";
    $("subtitle").textContent =
      `${plural(state.tasks.length, "task", "tasks")} and ${plural(state.notes.length, "note", "notes")} matching “${state.query}”`;
  } else if (p) {
    $("title").textContent = p.name;
    $("subtitle").textContent = p.summary || "";
  } else {
    $("title").textContent = "All work";
    $("subtitle").textContent = "Everything open, across every project";
  }

  // A view that does not exist for the current selection falls back rather than
  // rendering blank.
  const valid = state.query
    ? ["oracle", "tasks"]
    : state.projectId
    ? ["overview", "tasks", "notes", "links", "activity"]
    : ["new", "tasks", "history", "settings"];
  if (!valid.includes(state.view)) state.view = valid[0];

  // Hidden rather than disabled when there is nowhere to go: a button that is
  // always present but usually dead trains people to stop looking at it.
  $("back").hidden = state.history.length === 0;

  renderMetrics();
  renderTabs();

  const content = $("content");
  content.textContent = "";
  const view = ({
    new: renderWhatsNew,
    oracle: renderOracle,
    overview: renderOverview,
    tasks: renderTasks,
    notes: renderNotes,
    links: renderLinks,
    history: renderHistory,
    activity: renderActivity,
    settings: renderSettings,
  })[state.view];

  // Several views are async. Without this, a throw inside one leaves an empty
  // pane and an unhandled rejection nobody sees, which looks like the feature was
  // never built rather than like a bug.
  if (typeof view !== "function") {
    // A view listed in the tabs but missing from the table above. Say which,
    // rather than reporting that some anonymous value is not a function.
    showViewError(content, new Error(`No renderer is registered for the "${state.view}" view`));
    return;
  }

  try {
    const result = view(content);
    if (result && typeof result.then === "function") {
      result.catch((error) => showViewError(content, error));
    }
  } catch (error) {
    showViewError(content, error);
  }

}

// Counts for whatever is selected. Shown in the header on every view so the
// state of the work is always visible, not only on the dashboard.
function renderMetrics() {
  const box = $("metrics");
  box.textContent = "";
  if (state.query) return;

  const open = state.allTasks.filter((t) => t.status !== "done");
  const figures = [
    ["Open", open.length, null],
    ["Doing", open.filter((t) => t.status === "doing").length, "good"],
    ["Blocked", open.filter((t) => t.status === "blocked").length, "warn"],
    ["Overdue", open.filter(isOverdue).length, "crit"],
  ];
  if (state.projectId) figures.push(["Memory", state.notes.length, null]);

  for (const [label, value, tone] of figures) {
    // A zero is greyed rather than coloured: nothing blocked is not a warning.
    const cls = "metric" + (value === 0 ? " zero" : tone ? ` ${tone}` : "");
    box.append(el("div", { className: cls },
      el("div", { className: "v", textContent: String(value) }),
      el("div", { className: "k", textContent: label })));
  }
}

const card = (title, ...actions) => {
  const c = el("section", { className: "card" });
  const head = el("div", { className: "card-head" }, el("h2", { textContent: title }));
  actions.filter(Boolean).forEach((a) => head.append(a));
  c.append(head);
  const body = el("div", { className: "card-body" });
  c.append(body);
  return { card: c, body };
};

function showViewError(root, error) {
  console.error("view failed", error);
  root.textContent = "";
  root.append(
    el("div", { className: "empty" },
      el("strong", { textContent: "This view failed to load" }),
      String(error && error.message ? error.message : error))
  );
}

const emptyState = (headline, detail) =>
  el("div", { className: "empty" }, el("strong", { textContent: headline }), detail || "");

// ---------------------------------------------------------------------------
// Overview: the project dashboard
// ---------------------------------------------------------------------------

async function renderOverview(root) {
  const project = currentProject();
  if (!project) return;

  const all = state.allTasks;
  const open = all.filter((t) => t.status !== "done");
  const done = all.length - open.length;
  const overdue = open.filter(isOverdue).length;
  const blocked = open.filter((t) => t.status === "blocked").length;
  const doing = open.filter((t) => t.status === "doing").length;

  // Summary first: what needs attention before what merely exists.
  const stats = el("div", { className: "stats" });

  /**
   * One tile. Given a destination it becomes a button; given none, or a count
   * of zero, it stays the flat card it was. Promising a view and then showing
   * an empty one is worse than not offering the link.
   */
  const stat = (value, label, tone, go) => {
    const live = typeof go === "function" && value > 0;
    const node = el(live ? "button" : "div", {
      className: "stat" + (tone ? ` ${tone}` : "") + (live ? " act" : ""),
    });
    node.append(
      el("div", { className: "v", textContent: String(value) }),
      el("div", { className: "k", textContent: label })
    );
    if (live) {
      node.type = "button";
      node.title = `Show ${label.toLowerCase()}`;
      node.onclick = go;
    }
    return node;
  };

  stats.append(
    stat(open.length, "Open", null, () => showTasks(null)),
    stat(doing, "In progress", doing ? "good" : null, () => showTasks("doing")),
    stat(blocked, "Blocked", blocked ? "warn" : null, () => showTasks("blocked")),
    stat(overdue, "Overdue", overdue ? "crit" : null, () => showTasks("overdue")),
    stat(state.notes.length, "Memory", null, () => navigate({ view: "notes" })),
    stat(done, "Done", null, () => showTasks("done"))
  );
  root.append(stats);

  const cols = el("div", { className: "cols" });
  const left = el("div");
  const right = el("div");

  // --- what to do next -----------------------------------------------------
  const priority = [...open].sort((a, b) => {
    const rank = (t) => (isOverdue(t) ? 0 : t.status === "doing" ? 1 : t.status === "blocked" ? 2 : 3);
    return rank(a) - rank(b) || (a.priority === "high" ? -1 : 1);
  }).slice(0, 6);

  const nextCard = card("Needs attention");
  if (!priority.length) {
    nextCard.body.append(emptyState("Nothing open here", "Add a task from the Tasks tab."));
  } else {
    nextCard.card.querySelector(".card-body").className = "card-body flush";
    priority.forEach((t) => nextCard.card.append(taskRow(t)));
    nextCard.body.remove();
    const more = open.length - priority.length;
    if (more > 0) {
      const link = el("div", { className: "list-row" },
        el("a", { href: "#", className: "grow", textContent: `Show all ${open.length} open tasks` }));
      link.onclick = (e) => { e.preventDefault(); navigate({ view: "tasks" }); };
      nextCard.card.append(link);
    }
  }
  left.append(nextCard.card);

  // --- pinned and recent memory -------------------------------------------
  const memCard = card("Memory");
  if (!state.notes.length) {
    memCard.body.append(emptyState("Nothing stored yet",
      "Decisions, gotchas and things worth remembering live here."));
  } else {
    memCard.body.remove();
    const flush = el("div", { className: "card-body flush" });
    state.notes.slice(0, 5).forEach((n) => {
      const row = el("div", { className: "list-row" });
      row.append(el("span", { className: `kind ${n.kind}`, textContent: n.kind }));
      const link = el("a", { href: "#", className: "grow", textContent: n.title });
      link.onclick = (e) => { e.preventDefault(); navigate({ view: "notes" }); };
      row.append(link);
      if (n.pinned) row.append(el("span", { className: "hint", textContent: "pinned" }));
      flush.append(row);
    });
    memCard.card.append(flush);
  }
  left.append(memCard.card);

  // --- repositories --------------------------------------------------------
  const addRepo = el("button", { className: "btn sm", textContent: "Add" });
  const repoCard = card("Repositories", addRepo);
  addRepo.onclick = async () => {
    const path = prompt("Path to the repository folder");
    if (!path || !path.trim()) return;
    const name = path.trim().replace(/\/+$/, "").split("/").pop();
    await window.delphi.repos.create({
      projectId: project.id, name, path: path.trim(),
      isPrimary: state.repos.length === 0 ? 1 : 0,
    });
    refresh();
  };

  if (!state.repos.length) {
    repoCard.body.append(emptyState("No repositories linked",
      "Link the main repository and any helpers, so the project knows where its code lives."));
  } else {
    repoCard.body.remove();
    const flush = el("div", { className: "card-body flush" });
    state.repos.forEach((r) => {
      const row = el("div", { className: "list-row" });
      row.append(el("span", {
        className: "kind" + (r.is_primary ? " decision" : ""),
        textContent: r.is_primary ? "primary" : "helper",
      }));
      row.append(el("div", { className: "grow" },
        el("div", { textContent: r.name }),
        el("div", { className: "mono", textContent: r.path })));
      if (!r.is_primary) {
        const mk = el("button", { className: "btn sm", textContent: "Make primary" });
        mk.onclick = async () => { await window.delphi.repos.setPrimary(r.id); refresh(); };
        row.append(mk);
      }
      const rm = el("button", { className: "btn sm", textContent: "Remove" });
      rm.onclick = async () => { await window.delphi.repos.remove(r.id); refresh(); };
      row.append(rm);
      flush.append(row);
    });
    repoCard.card.append(flush);
  }
  right.append(repoCard.card);

  // --- links ---------------------------------------------------------------
  const linkCard = card("Links");
  if (!state.links.length) {
    linkCard.body.append(emptyState("No links yet", "Pull requests, tickets, dashboards."));
  } else {
    linkCard.body.remove();
    const flush = el("div", { className: "card-body flush" });
    state.links.slice(0, 6).forEach((l) => {
      const row = el("div", { className: "list-row" });
      row.append(el("span", { className: "kind", textContent: l.kind }));
      const a = el("a", { href: "#", className: "grow", textContent: l.label });
      a.onclick = (e) => { e.preventDefault(); window.delphi.openExternal(l.url); };
      row.append(a);
      flush.append(row);
    });
    linkCard.card.append(flush);
  }
  right.append(linkCard.card);

  // --- project settings ----------------------------------------------------
  const setCard = card("Project settings");
  const kv = el("dl", { className: "kv" });

  const nameInput = el("input", { className: "field", value: project.name });
  nameInput.onblur = async () => {
    if (nameInput.value.trim() && nameInput.value !== project.name) {
      await window.delphi.projects.update(project.id, { name: nameInput.value.trim() });
      refresh();
    }
  };
  kv.append(el("dt", { textContent: "Name" }), el("dd", {}, nameInput));

  const sumInput = el("input", { className: "field", value: project.summary || "" , placeholder: "One line: what this project is" });
  sumInput.onblur = async () => {
    if (sumInput.value !== (project.summary || "")) {
      await window.delphi.projects.update(project.id, { summary: sumInput.value.trim() });
      refresh();
    }
  };
  kv.append(el("dt", { textContent: "Summary" }), el("dd", {}, sumInput));

  const statusSel = el("select", { className: "field" });
  for (const s of ["active", "paused", "blocked", "done", "archived"]) {
    statusSel.append(el("option", { value: s, textContent: s, selected: s === project.status }));
  }
  statusSel.onchange = async () => {
    await window.delphi.projects.update(project.id, { status: statusSel.value });
    if (statusSel.value === "archived") { state.projectId = null; state.view = "tasks"; }
    refresh();
  };
  kv.append(el("dt", { textContent: "Status" }), el("dd", {}, statusSel));

  const colour = el("input", { type: "color", className: "field", value: project.colour || "#8d97a9", style: "height:34px; padding:2px" });
  colour.onchange = async () => {
    await window.delphi.projects.update(project.id, { colour: colour.value });
    refresh();
  };
  kv.append(el("dt", { textContent: "Colour" }), el("dd", {}, colour));
  kv.append(el("dt", { textContent: "Key" }), el("dd", {}, el("span", { className: "mono", textContent: project.key })));

  setCard.body.append(kv);
  right.append(setCard.card);

  cols.append(left, right);
  root.append(cols);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// What's new
// ---------------------------------------------------------------------------

async function renderWhatsNew(root) {
  const items = await window.delphi.recent(10);

  if (!items.length) {
    root.append(emptyState("Nothing yet", "Tasks and notes will appear here as they are added."));
    return;
  }

  // Grouped by day rather than listed flat: "what changed today" is the question
  // being asked, and a bare list of timestamps makes that harder to see, not easier.
  const groups = new Map();
  for (const item of items) {
    const day = dayLabel(item.updated_at);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(item);
  }

  for (const [day, group] of groups) {
    root.append(el("div", { className: "side-label", textContent: day }));
    const list = el("section", { className: "card" });

    for (const item of group) {
      const row = el("div", { className: "list-row" });

      row.append(el("span", {
        className: item.item_type === "note" ? `kind ${item.kind || "note"}` : "kind",
        textContent: item.item_type === "note" ? (item.kind || "note") : "task",
      }));

      const body = el("div", { className: "grow" });
      body.append(el("div", { textContent: item.title }));

      const meta = el("div", { className: "t-meta" });
      if (item.project_name) {
        const chip = el("span", { className: "chip", textContent: item.project_name });
        if (item.project_colour) chip.style.color = item.project_colour;
        meta.append(chip);
      }
      if (item.status && item.status !== "todo") {
        meta.append(el("span", { className: `chip ${item.status === "blocked" ? "blocked" : "doing"}`, textContent: item.status }));
      }
      if (item.priority === "high") meta.append(el("span", { className: "chip high", textContent: "high" }));
      if (item.ref) meta.append(el("span", { className: "chip ref", textContent: item.ref }));
      // Created and edited read differently, so say which this is.
      meta.append(el("span", { className: "hint",
        textContent: `${item.created_at === item.updated_at ? "added" : "edited"} ${ago(item.updated_at)}` }));
      body.append(meta);
      row.append(body);

      // The whole row is the target rather than a button at the end: the row is
      // what someone is already looking at, and a button makes them travel to the
      // edge to act on it. Keyboard users get the same target, which a hover-only
      // affordance would not give them.
      if (item.project_id) {
        row.classList.add("clickable");
        row.tabIndex = 0;
        row.setAttribute("role", "link");
        row.title = `Open in ${item.project_name}`;
        const go = () => navigate({
          projectId: item.project_id,
          view: item.item_type === "note" ? "notes" : "tasks",
        });
        row.onclick = go;
        row.onkeydown = (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
        };
      }
      list.append(row);
    }
    root.append(list);
  }
}

/** Today and Yesterday read faster than a date when scanning recent activity. */
function dayLabel(iso) {
  if (!iso) return "Earlier";
  const day = String(iso).slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  return day;
}

// ---------------------------------------------------------------------------
// The Oracle
// ---------------------------------------------------------------------------

function renderOracle(root) {
  const bar = el("div", { className: "oracle-bar" });
  const provider = state.provider;
  bar.append(el("div", { className: "hint grow",
    textContent: "Ranked by meaning rather than words, then expanded through what each result connects to." }));
  if (provider) {
    bar.append(el("span", {
      className: "provider-tag" + (provider.neural ? " neural" : ""),
      title: provider.neural
        ? "A local model is producing the vectors"
        : "No model is running, so this is falling back to word matching",
      textContent: provider.neural ? `${provider.dims}d local model` : "word matching",
    }));
  }
  root.append(bar);

  if (state.oracleError) {
    root.append(emptyState("The Oracle could not answer", state.oracleError));
    return;
  }

  if (!state.oracleHits.length) {
    root.append(emptyState("The Oracle has nothing for that",
      "Try a fuller question. It matches meaning, so a sentence works better than a keyword."));
    return;
  }

  const list = el("section", { className: "card" });
  for (const h of state.oracleHits) {
    const row = el("div", { className: "hit" });

    // Scores cluster in a narrow band, so the bar is scaled across the range in
    // view rather than 0 to 1, which would make every result look identical.
    const scores = state.oracleHits.map((x) => x.score);
    const lo = Math.min(...scores), hi = Math.max(...scores);
    const pct = hi === lo ? 100 : Math.round(((h.score - lo) / (hi - lo)) * 88 + 12);
    row.append(el("div", { className: "score" },
      el("div", { className: "n", textContent: h.score.toFixed(2) }),
      el("div", { className: "bar" }, el("i", { style: `width:${pct}%` }))));

    const body = el("div", { className: "hit-body" });
    body.append(el("div", { className: "hit-title", textContent: h.title || h.name }));
    const meta = el("div", { className: "t-meta" });
    meta.append(el("span", { className: "chip", textContent: h.type }));
    if (h.project) meta.append(el("span", { className: "chip", textContent: h.project }));
    if (h.kind && h.type === "note") meta.append(el("span", { className: `kind ${h.kind}`, textContent: h.kind }));
    if (h.status) meta.append(el("span", { className: "chip", textContent: h.status }));
    if (h.ref) meta.append(el("span", { className: "chip ref", textContent: h.ref }));
    body.append(meta);
    if (h.body) body.append(el("div", { className: "hit-snip", textContent: h.body.slice(0, 200).replace(/\s+/g, " ") }));
    row.append(body);
    list.append(row);
  }
  root.append(list);

  if (state.oracleEntities.length) {
    root.append(el("div", { className: "side-label", textContent: "Connected to" }));
    const cloud = el("div", { className: "entity-cloud" });
    for (const e of state.oracleEntities) {
      const chip = el("div", { className: "ent" },
        el("b", { textContent: e.name }),
        el("span", { className: "c", textContent: String(Math.round(e.weight)) }));
      chip.title = `${e.kind}, appears alongside this in ${Math.round(e.weight)} places`;
      chip.onclick = () => { $("search").value = e.name; navigate({ query: e.name, view: "oracle" }); };
      cloud.append(chip);
    }
    root.append(cloud);
  }
}

/* ---------------------------------------------------------------------------
   Three ways to look at the same tasks

   A flat list, the same list split into a column per status, and a board you can
   drag between. The choice is remembered on the project rather than in settings,
   because a project with four tasks and a project with forty want different
   answers and a global preference forces one of them to be wrong.

   The board is not a fourth data model. A column is a status, and dragging a card
   writes that status, which means it also writes a status event and shows up in
   the timeline like any other move. Nothing knows it came from a board.
--------------------------------------------------------------------------- */

const BOARD_COLUMNS = [
  ["todo", "To do"],
  ["doing", "In progress"],
  ["blocked", "Blocked"],
  ["done", "Done"],
];

/** The layout this project is set to, defaulting to the flat list. */
function taskViewMode() {
  const project = currentProject();
  return (project && project.task_view) || "list";
}

async function setTaskViewMode(mode) {
  const project = currentProject();
  if (!project) return;
  project.task_view = mode;           // so the repaint below is immediate
  await window.delphi.projects.update(project.id, { task_view: mode });
  refresh();
}

const VIEWS = [
  {
    id: "list", group: "popular", glyph: "rows", name: "List",
    desc: "Every open task in one column, top to bottom.",
  },
  {
    id: "board", group: "popular", glyph: "board", name: "Board",
    desc: "A column per status. Drag a card to move the work.",
  },
  {
    id: "table", group: "popular", glyph: "grid", name: "Table",
    desc: "A row per task. Compare down a column, select across.",
  },
  {
    id: "calendar", group: "popular", glyph: "cal", name: "Calendar",
    desc: "Tasks sitting on the day they are due.",
  },
  {
    id: "gantt", group: "popular", glyph: "gantt", name: "Gantt",
    desc: "Bars across a schedule, showing what blocks what.",
    why: "Needs start dates and dependencies. A task has a due date and no notion of what must finish first.",
  },
  {
    id: "doc", group: "popular", glyph: "doc", name: "Doc", tab: "notes",
    desc: "This project's memory: decisions, gotchas and references.",
  },

  {
    id: "columns", group: "more", glyph: "cols", name: "Columns",
    desc: "A column per status, side by side, without the dragging.",
  },
  {
    id: "dashboard", group: "more", glyph: "dash", name: "Dashboard", tab: "overview",
    desc: "Counts, what is moving, what is stuck, and where to go next.",
  },
  {
    id: "activity", group: "more", glyph: "feed", name: "Activity", tab: "activity",
    desc: "Every change, newest first, and a way to undo one.",
  },
  {
    id: "timeline", group: "more", glyph: "track", name: "Timeline",
    desc: "The same work laid left to right over dates.",
    why: "Needs start dates and dependencies, which tasks do not carry.",
  },
  {
    id: "form", group: "more", glyph: "form", name: "Form",
    desc: "A form that files whatever it collects as a task.",
    why: "Nothing can post into Delphi from outside it. Work arrives from agents over MCP.",
  },
  {
    id: "workload", group: "more", glyph: "bars", name: "Workload",
    desc: "Who is over capacity this week, and who is not.",
    why: "Needs people and capacity. An assignee here is free text, not an account with hours behind it.",
  },
  {
    id: "team", group: "more", glyph: "people", name: "Team",
    desc: "One lane per person, so a standup reads itself.",
    why: "Needs people. Delphi stores an assignee name and nothing behind it.",
  },
  {
    id: "mindmap", group: "more", glyph: "mind", name: "Mind Map", tab: "graph",
    desc: "The knowledge graph: what this work keeps mentioning, and what sits near what.",
  },
  {
    id: "whiteboard", group: "more", glyph: "canvas", name: "Whiteboard",
    desc: "A canvas to sketch on beside the work.",
    why: "Not built. There is nowhere to keep a drawing.",
  },
];

const VIEW_GROUPS = [["popular", "Popular"], ["more", "More"]];

const findView = (id) => VIEWS.find((v) => v.id === id) || null;

/**
 * The glyph beside each name.
 *
 * Drawn from empty elements and CSS rather than an icon font or an SVG file:
 * the page runs with a strict CSP and no build step, so the cheapest thing that
 * survives both is a handful of divs the stylesheet arranges. Each shape is a
 * count of marks here and a rule in index.html.
 */
const GLYPH_MARKS = {
  rows: 3, cols: 3, board: 3, grid: 9, cal: 12, doc: 4, dash: 3, feed: 3,
  gantt: 3, track: 3, form: 3, people: 3, bars: 3, mind: 3, canvas: 2,
};

function viewGlyph(shape) {
  const box = el("span", { className: `vp-glyph ${shape}` });
  box.setAttribute("aria-hidden", "true");
  for (let i = 0; i < (GLYPH_MARKS[shape] || 3); i++) box.append(el("i"));
  return box;
}

/**
 * Which view is showing.
 *
 * The tabs came first and still own state.view, so the three that became views
 * are translated back here rather than being renamed everywhere. Inside the
 * Tasks tab the answer is whatever layout the project is set to.
 */
function currentViewId() {
  if (state.view === "tasks") return taskViewMode();
  return { notes: "doc", overview: "dashboard", activity: "activity" }[state.view] || taskViewMode();
}

/** Switches to a view, whichever of the two mechanisms carries it. */
async function applyView(view) {
  if (view.why) return;
  if (view.id === currentViewId()) return;
  if (view.tab) return navigate({ view: view.tab });

  try {
    await setTaskViewMode(view.id);
  } catch (error) {
    // db.js validates task_view against a list of layouts. A layout offered
    // here but never added there fails loudly rather than leaving a row that
    // quietly does nothing, and the reload puts back the value the store
    // actually holds after the optimistic write.
    await refresh();
    alert(`Cannot switch to ${view.name}: ${error.message}`);
  }
}

/** One row of the popup: glyph, name, a line of prose, and a reason if it needs one. */
function viewRow(view, currentId, pick) {
  const chosen = view.id === currentId;
  const row = el("button", {
    type: "button",
    className: "vp-item" + (view.why ? " off" : "") + (chosen ? " on" : ""),
    tabIndex: -1,
  });
  row.dataset.name = view.name.toLowerCase();
  row.setAttribute("role", "menuitemradio");
  row.setAttribute("aria-checked", String(chosen));
  // aria-disabled rather than the disabled attribute, because a disabled button
  // cannot be focused and the reason it is disabled is the most useful thing on
  // the row. It stays reachable by keyboard and refuses to act instead.
  if (view.why) row.setAttribute("aria-disabled", "true");

  row.append(viewGlyph(view.glyph));

  const name = el("span", { className: "vp-name" }, view.name);
  if (view.why) name.append(el("span", { className: "chip vp-flag", textContent: "not built" }));
  else if (chosen) name.append(el("span", { className: "chip vp-now", textContent: "current" }));

  const text = el("span", { className: "vp-text" },
    name,
    el("span", { className: "vp-desc", textContent: view.desc }),
    view.why ? el("span", { className: "vp-why", textContent: view.why }) : null);

  row.append(text);
  row.onclick = () => pick(view);
  return row;
}

/**
 * Opens the popup under the trigger.
 *
 * Built on rowMenu, which already solves being a popup: one open at a time,
 * kept inside the viewport, and closed by a click anywhere else. A second
 * implementation of that would be a second set of the same bugs.
 */
function openViewMenu(trigger, land = "current") {
  const currentId = currentViewId();
  const rows = [];
  const nodes = [];

  for (const [group, heading] of VIEW_GROUPS) {
    nodes.push(el("div", { className: "vp-group", textContent: heading }));
    for (const view of VIEWS) {
      if (view.group !== group) continue;
      const row = viewRow(view, currentId, pick);
      rows.push(row);
      nodes.push(row);
    }
  }

  const box = trigger.getBoundingClientRect();
  // The class goes in rather than on, so the popup is measured at the size it
  // will actually be before rowMenu clamps it into the viewport.
  const menu = rowMenu(box.left, box.bottom + 6, nodes, { onClose: closed, className: "vp" });
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Choose a view");
  menu.onkeydown = onKey;
  trigger.setAttribute("aria-expanded", "true");

  const start = land === "last" ? rows.length - 1 : Math.max(0, rows.findIndex((r) => r.classList.contains("on")));
  rows[start].focus();

  // Runs however the menu closed, including the click away that rowMenu owns,
  // so the trigger cannot be left claiming to be expanded over nothing.
  function closed() {
    trigger.setAttribute("aria-expanded", "false");
  }

  function dismiss() {
    closeRowMenu();
    trigger.focus();
  }

  function pick(view) {
    // The unavailable rows are focusable and clickable so their reason can be
    // read. Acting on one does nothing, and closing the popup on the way would
    // hide the answer just as it was asked for.
    if (view.why) return;
    dismiss();
    applyView(view);
  }

  function step(from, by) {
    if (from < 0) return by > 0 ? rows[0] : rows[rows.length - 1];
    return rows[(from + by + rows.length) % rows.length];
  }

  function onKey(e) {
    const at = rows.indexOf(document.activeElement);

    if (e.key === "Escape") {
      // Escape reaches the window handler otherwise, and hides the whole panel
      // when all that was wanted was to shut this.
      e.preventDefault();
      e.stopPropagation();
      dismiss();
      return;
    }
    if (e.key === "Tab") {
      // Not prevented: focus is handed back to the trigger and Tab carries on
      // from there, which is where it would have been had this never opened.
      dismiss();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      step(at, e.key === "ArrowDown" ? 1 : -1).focus();
      return;
    }
    if (e.key === "Home") { e.preventDefault(); rows[0].focus(); return; }
    if (e.key === "End") { e.preventDefault(); rows[rows.length - 1].focus(); return; }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (at >= 0) rows[at].click();
      return;
    }

    // Type a letter to jump. Fifteen rows is enough that scanning with the
    // arrows is slower than saying which one you meant.
    if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const letter = e.key.toLowerCase();
      const order = rows.slice(at + 1).concat(rows.slice(0, at + 1));
      const hit = order.find((r) => r.dataset.name.startsWith(letter));
      if (hit) { e.preventDefault(); hit.focus(); }
    }
  }

  return menu;
}

/** The trigger: what is showing now, and the way to change it. */
function viewPicker() {
  const current = findView(currentViewId()) || VIEWS[0];

  const trigger = el("button", { type: "button", className: "btn vp-trigger", title: "Change view" });
  trigger.append(
    viewGlyph(current.glyph),
    el("span", { className: "vp-trigger-name", textContent: current.name }),
    el("span", { className: "vp-caret", textContent: "▾" }));
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");

  // Opened on mousedown rather than click, so that clicking the trigger while
  // the popup is open closes it and leaves it closed. On click it would not:
  // rowMenu's click away fires first on the same press, and the click that
  // followed would open it straight back up.
  trigger.onmousedown = (e) => {
    e.preventDefault();
    if (openMenu && openMenu.classList.contains("vp")) {
      // Focused by hand, because preventDefault above stopped the press doing
      // it, and the row that held focus is being removed from the document.
      closeRowMenu();
      trigger.focus();
      return;
    }
    openViewMenu(trigger);
  };

  trigger.onkeydown = (e) => {
    if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    // Prevented so the synthesised click does not arrive after the popup has
    // opened and land on whichever row is under the pointer.
    e.preventDefault();
    openViewMenu(trigger, e.key === "ArrowUp" ? "last" : "current");
  };

  return trigger;
}

/** Tasks grouped into the four statuses, in board order. */
function groupByStatus(tasks) {
  return BOARD_COLUMNS.map(([status, label]) => ({
    status,
    label,
    tasks: tasks.filter((t) => t.status === status),
  }));
}

/**
 * A card, for the column and board layouts.
 *
 * Deliberately quieter than a row: in a narrow column there is no room for meta,
 * so it carries the title and only what changes a decision.
 */
function taskCard(t, { draggable = false, showDue = true } = {}) {
  const card = el("div", { className: "tcard" + (t.status === "done" ? " done" : "") });
  card.append(el("div", { className: "tcard-title", textContent: t.title }));

  const foot = el("div", { className: "tcard-foot" });
  if (t.priority === "high") foot.append(el("span", { className: "pill high", textContent: "high" }));
  // Inside a calendar cell the day is the cell, so repeating it on every card is
  // noise. Overdue still says so, because that is not a date, it is a warning.
  if (isOverdue(t)) foot.append(el("span", { className: "pill overdue", textContent: showDue ? t.due : "overdue" }));
  else if (showDue && t.due) foot.append(el("span", { className: "t-due", textContent: t.due }));
  if (t.subtask_count) foot.append(el("span", { className: "t-due", textContent: `${t.subtask_done}/${t.subtask_count}` }));
  if (t.ref) foot.append(el("span", { className: "t-ref", textContent: t.ref }));
  if (t.assignee) {
    foot.append(el("span", {
      className: "avatar sm" + (isAgent(t.assignee) ? " agent" : ""),
      title: t.assignee,
      textContent: t.assignee.slice(0, 1).toUpperCase(),
    }));
  }
  if (foot.childNodes.length) card.append(foot);

  card.onclick = () => openTaskSheet(t.id);
  card.oncontextmenu = (e) => { e.preventDefault(); taskMenu(t, e.clientX, e.clientY); };
  card.tabIndex = 0;
  card.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); openTaskSheet(t.id); }
    if (e.key === " ") { e.preventDefault(); quickLook(t.id); }
  };

  if (draggable) {
    card.draggable = true;
    card.ondragstart = (e) => {
      e.dataTransfer.setData("text/plain", String(t.id));
      e.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    };
    card.ondragend = () => card.classList.remove("dragging");
  }
  return card;
}

/** One status column, used by both the columns layout and the board. */
function statusColumn(group, { board = false } = {}) {
  const column = el("div", { className: "tcol" });
  const head = el("div", { className: `tcol-head st-${group.status}` });
  head.append(el("span", { className: "tcol-dot" }));
  head.append(el("span", { className: "tcol-name", textContent: group.label }));
  head.append(el("span", { className: "tcol-n", textContent: String(group.tasks.length) }));
  column.append(head);

  const body = el("div", { className: "tcol-body" });
  for (const t of group.tasks) body.append(taskCard(t, { draggable: board }));

  if (!group.tasks.length) {
    body.append(el("div", { className: "tcol-empty", textContent: board ? "Drop here" : "Nothing" }));
  }

  // Adding into a column sets that status, which is what someone means by
  // typing into the Blocked column.
  const add = el("input", { className: "tcol-add", placeholder: "＋ Add" });
  add.onkeydown = async (e) => {
    if (e.key !== "Enter" || !add.value.trim()) return;
    let title = add.value.trim();
    let priority = "med";
    if (title.startsWith("!")) { priority = "high"; title = title.slice(1).trim(); }
    const created = await window.delphi.tasks.create({ projectId: state.projectId, title, priority });
    if (group.status !== "todo") await window.delphi.tasks.update(created.id, { status: group.status });
    add.value = "";
    refresh();
  };

  if (board) {
    const land = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; column.classList.add("over"); };
    column.ondragover = land;
    column.ondragenter = land;
    column.ondragleave = (e) => { if (!column.contains(e.relatedTarget)) column.classList.remove("over"); };
    column.ondrop = async (e) => {
      e.preventDefault();
      column.classList.remove("over");
      const id = Number(e.dataTransfer.getData("text/plain"));
      if (!id) return;
      const moved = state.tasks.find((t) => t.id === id);
      // Dropping a card back where it came from is not a status change, and
      // recording one would put a meaningless entry on the timeline.
      if (!moved || moved.status === group.status) return;
      await window.delphi.tasks.update(id, { status: group.status });
      refresh();
    };
  }

  column.append(body, add);
  return column;
}

/* ---------------------------------------------------------------------------
   The calendar

   A fifth way to look at the same tasks, and the only one that answers what a
   week is actually made of. It reads and writes one field, due, so a card
   dropped on a day is the same edit as typing the date into the sheet, and it
   lands on the timeline like any other change.

   Weeks start on Monday. Every date in the store is an ISO string and ISO weeks
   start there, so a locale-derived first day would put the grid and the data on
   two different calendars.
--------------------------------------------------------------------------- */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// A day with more than this many tasks shows a count instead, so one busy day
// cannot set the height of the whole week.
const CAL_STACK = 3;

// Which month the grid is showing, as YYYY-MM. Module level for the same reason
// the table's selection is: it is where the view is looking, not part of what
// the app loads. Null means the month containing today.
let calendarMonth = null;

const DAY_MS = 86400000;

// The arithmetic is done in UTC off the ISO strings the store already holds, so
// the grid, isOverdue and the Due column can never disagree about which day it
// is. Local components would drift by one whenever the clock is behind UTC.
const dayStamp = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const dayIso = (stamp) => new Date(stamp).toISOString().slice(0, 10);
const monthOf = (iso) => iso.slice(0, 7);

/** The month delta months away. Date.UTC rolls the year over on its own. */
function shiftMonth(month, delta) {
  return monthOf(dayIso(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 + delta, 1)));
}

const monthLabel = (month) =>
  new Date(dayStamp(`${month}-01`)).toLocaleDateString(undefined, {
    month: "long", year: "numeric", timeZone: "UTC",
  });

/**
 * Every day the grid shows, including the days either side that fill the first
 * and last week out. Those days are real due dates, so they carry their tasks
 * rather than being drawn as padding.
 */
function monthGrid(month) {
  const year = +month.slice(0, 4);
  const index = +month.slice(5, 7);
  const first = dayStamp(`${month}-01`);
  const lead = (new Date(first).getUTCDay() + 6) % 7;
  const length = new Date(Date.UTC(year, index, 0)).getUTCDate();
  const start = first - lead * DAY_MS;
  return Array.from({ length: Math.ceil((lead + length) / 7) * 7 }, (_, i) => dayIso(start + i * DAY_MS));
}

/** Tasks split by the day they are due, and the ones that are not due at all. */
function byDueDay(tasks) {
  const days = new Map();
  const undated = [];
  for (const t of tasks) {
    if (!t.due) { undated.push(t); continue; }
    const key = t.due.slice(0, 10);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(t);
  }
  return { days, undated };
}

// Inside a day the order is what is still to do, most urgent first. Finished
// work sinks, because the reason to look at a past day is what is left on it.
const dayOrder = (a, b) =>
  Number(a.status === "done") - Number(b.status === "done") ||
  Number(b.priority === "high") - Number(a.priority === "high") ||
  a.id - b.id;

/**
 * Writes a due date from a drop.
 *
 * Dropping a card back on the day it already has is not an edit, and recording
 * one would put a meaningless entry on the timeline. This is the same bargain
 * the board makes with status.
 */
async function setDue(id, due) {
  const moved = state.tasks.find((t) => t.id === id);
  if (!moved || (moved.due ? moved.due.slice(0, 10) : null) === due) return;
  await window.delphi.tasks.update(id, { due });
  refresh();
}

/** Makes a node a landing place for a card, the way a board column is. */
function acceptsDue(node, due) {
  const land = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; node.classList.add("over"); };
  node.ondragover = land;
  node.ondragenter = land;
  node.ondragleave = (e) => { if (!node.contains(e.relatedTarget)) node.classList.remove("over"); };
  node.ondrop = (e) => {
    e.preventDefault();
    node.classList.remove("over");
    const id = Number(e.dataTransfer.getData("text/plain"));
    if (id) setDue(id, due);
  };
}

/** One day. */
function calendarDay(iso, tasks, month) {
  const now = today();
  const cell = el("div", {
    className: "cal-day"
      + (monthOf(iso) === month ? "" : " out")
      + (iso === now ? " today" : iso < now ? " past" : ""),
  });
  cell.setAttribute("aria-label", iso);

  const head = el("div", { className: "cal-daynum" });
  head.append(el("span", { className: "cal-n", textContent: String(+iso.slice(8, 10)) }));
  if (iso === now) head.append(el("span", { className: "cal-mark", textContent: "today" }));
  head.append(el("span", { className: "grow" }));

  // Typing into a day sets that due date, which is what someone means by
  // starting a task on a Thursday, exactly as typing into a column sets status.
  const add = el("button", { className: "cal-add", textContent: "＋", title: `Add a task due ${iso}` });
  add.onclick = (e) => {
    e.stopPropagation();
    if (cell.querySelector(".cal-field")) return;
    const field = el("input", { className: "cal-field", placeholder: "Task" });
    field.onkeydown = async (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") { field.remove(); return; }
      if (ev.key !== "Enter" || !field.value.trim()) return;
      let title = field.value.trim();
      let priority = "med";
      if (title.startsWith("!")) { priority = "high"; title = title.slice(1).trim(); }
      await window.delphi.tasks.create({ projectId: state.projectId, title, priority, due: iso });
      refresh();
    };
    field.onblur = () => field.remove();
    cell.append(field);
    field.focus();
  };
  head.append(add);
  cell.append(head);

  const stack = el("div", { className: "cal-stack" });
  const ordered = [...tasks].sort(dayOrder);
  for (const t of ordered.slice(0, CAL_STACK)) stack.append(taskCard(t, { draggable: true, showDue: false }));

  const rest = ordered.slice(CAL_STACK);
  if (rest.length) {
    const more = el("button", { className: "cal-more", textContent: `${rest.length} more` });
    // Expanded in place rather than through a repaint: nothing in the store has
    // changed, and re-rendering to show three more cards would also throw away
    // every other cell someone had already opened.
    more.onclick = (e) => {
      e.stopPropagation();
      more.remove();
      for (const t of rest) stack.append(taskCard(t, { draggable: true, showDue: false }));
    };
    stack.append(more);
  }
  cell.append(stack);

  acceptsDue(cell, iso);
  return cell;
}

/**
 * The tasks with no due date.
 *
 * They sit under the grid rather than being left out of it. A calendar that can
 * only show dated work quietly hides everything that has not been scheduled,
 * which is the half most likely to need scheduling. Here they are visible,
 * countable, and a drag away from having a date. Dropping a card back on the
 * tray takes the date off again, so the move is reversible by the same gesture.
 */
function undatedTray(tasks) {
  const tray = el("section", { className: "cal-tray" });

  const head = el("div", { className: "cal-tray-head" });
  head.append(el("span", { className: "tcol-dot" }));
  head.append(el("span", { className: "tcol-name", textContent: "No due date" }));
  head.append(el("span", { className: "tcol-n", textContent: String(tasks.length) }));
  head.append(el("span", { className: "grow" }));
  head.append(el("span", { className: "cal-hint", textContent: "Drag onto a day to schedule" }));
  tray.append(head);

  const body = el("div", { className: "cal-tray-body" });
  if (!tasks.length) body.append(el("div", { className: "tcol-empty", textContent: "Drop here to clear a date" }));
  for (const t of tasks) body.append(taskCard(t, { draggable: true }));
  tray.append(body);

  acceptsDue(tray, null);
  return tray;
}

/** A chip that jumps to the month holding the nearest work outside this one. */
function calendarJump(label, month) {
  const chip = el("button", { className: "btn sm", textContent: label, title: `Go to ${monthLabel(month)}` });
  chip.onclick = () => { calendarMonth = month; render(); };
  return chip;
}

function renderTaskCalendar(root, tasks) {
  const month = calendarMonth || monthOf(today());
  calendarMonth = month;
  const { days, undated } = byDueDay(tasks);

  const head = el("div", { className: "cal-head" });
  head.append(el("div", { className: "cal-title", textContent: monthLabel(month) }));

  const nav = el("div", { className: "cal-nav" });
  const step = (label, title, delta) => {
    const b = el("button", { className: "btn sm icon", textContent: label, title });
    // Moving months changes nothing in the store and every task of the project
    // is already loaded, so this repaints rather than reloading.
    b.onclick = () => { calendarMonth = shiftMonth(month, delta); render(); };
    return b;
  };
  const home = el("button", { className: "btn sm", textContent: "Today", title: "Back to this month" });
  home.onclick = () => { calendarMonth = monthOf(today()); render(); };
  nav.append(step("‹", "Previous month", -1), home, step("›", "Next month", 1));
  head.append(el("span", { className: "grow" }), nav);
  root.append(head);

  const scroll = el("div", { className: "cal-scroll" });
  const grid = el("div", { className: "cal-grid" });
  for (const name of WEEKDAYS) grid.append(el("div", { className: "cal-dow", textContent: name }));
  for (const iso of monthGrid(month)) grid.append(calendarDay(iso, days.get(iso) || [], month));
  scroll.append(grid);
  root.append(scroll);

  // Work in another month is reachable by stepping, but only if someone knows it
  // is there. These say so, and land on the nearest month that has any.
  const outside = tasks.filter((t) => t.due && monthOf(t.due) !== month);
  const earlier = outside.filter((t) => monthOf(t.due) < month);
  const later = outside.filter((t) => monthOf(t.due) > month);
  if (earlier.length || later.length) {
    const foot = el("div", { className: "cal-foot" });
    if (earlier.length) {
      const nearest = earlier.reduce((a, b) => (a.due > b.due ? a : b)).due;
      foot.append(calendarJump(`‹ ${plural(earlier.length, "task", "tasks")} earlier`, monthOf(nearest)));
    }
    if (later.length) {
      const nearest = later.reduce((a, b) => (a.due < b.due ? a : b)).due;
      foot.append(calendarJump(`${plural(later.length, "task", "tasks")} later ›`, monthOf(nearest)));
    }
    root.append(foot);
  }

  root.append(undatedTray(undated));
}

/** The composer at the top of the flat list. */
function taskComposer() {
  const input = el("input", { className: "field", placeholder: "Add a task and press Enter. Start with ! for high priority." });
  input.onkeydown = async (e) => {
    if (e.key !== "Enter" || !input.value.trim()) return;
    let title = input.value.trim();
    let priority = "med";
    if (title.startsWith("!")) { priority = "high"; title = title.slice(1).trim(); }
    const ref = (title.match(/\b([A-Z][A-Z0-9]+-\d+)\b/) || [])[1] || null;
    await window.delphi.tasks.create({ projectId: state.projectId, title, priority, ref });
    input.value = "";
    refresh();
  };
  return input;
}

/* ---------------------------------------------------------------------------
   The table view, and selecting more than one thing

   A table is the layout for scanning many tasks against the same few fields:
   columns line up, so the eye compares down a column instead of reading every
   row. The row still opens the task, and the controls sit at the end where they
   do not compete with it.

   Selection exists because some jobs are about several tasks at once. Ticking
   rows one at a time and then repeating the same menu on each is the thing a
   floating bar removes.
--------------------------------------------------------------------------- */

const selected = new Set();

function clearSelection() {
  selected.clear();
  const bar = document.getElementById("bulk-bar");
  if (bar) bar.remove();
  for (const box of document.querySelectorAll(".row-check.on")) box.classList.remove("on");
  for (const row of document.querySelectorAll(".trow.picked")) row.classList.remove("picked");
}

/**
 * The bar that appears once something is selected.
 *
 * Floating rather than a toolbar at the top, so it is near the pointer that just
 * made the selection and does not push the table around when it appears.
 */
function paintBulkBar() {
  const existing = document.getElementById("bulk-bar");
  if (!selected.size) { if (existing) existing.remove(); return; }

  const bar = existing || el("div", { className: "bulk-bar", id: "bulk-bar" });
  bar.textContent = "";
  bar.append(el("span", { className: "bulk-count",
    textContent: `${selected.size} ${selected.size === 1 ? "task" : "tasks"} selected` }));

  const ids = () => [...selected];
  const act = async (fn, label) => {
    // Sequential rather than parallel: these are writes to one SQLite file, and
    // twenty at once would spend their time waiting on each other's locks.
    for (const id of ids()) await fn(id);
    clearSelection();
    refresh();
  };

  const button = (label, title, run, danger = false) => {
    const b = el("button", { className: "bulk-btn" + (danger ? " danger" : ""), textContent: label, title });
    b.onclick = run;
    return b;
  };

  bar.append(
    button("Done", "Mark every selected task done",
      () => act((id) => window.delphi.tasks.update(id, { status: "done" }))),
    button("Start", "Move every selected task to in progress",
      () => act((id) => window.delphi.tasks.update(id, { status: "doing" }))),
    button("Queue", "Send every selected task to the agent queue",
      () => act((id) => window.delphi.tasks.queue(id, "ready"))),
    button("Delete", "Delete every selected task",
      async () => {
        const n = selected.size;
        await act((id) => window.delphi.tasks.remove(id));
        setTimeout(() => alert(`${n} ${n === 1 ? "task" : "tasks"} deleted. Restore from this project's Activity tab.`), 30);
      }, true)
  );

  const close = el("button", { className: "bulk-close", textContent: "✕", title: "Clear selection" });
  close.onclick = clearSelection;
  bar.append(close);

  if (!existing) document.body.append(bar);
}

function toggleSelected(id, rowEl, boxEl) {
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  boxEl.classList.toggle("on", selected.has(id));
  rowEl.classList.toggle("picked", selected.has(id));
  paintBulkBar();
}

/** A tick box that selects rather than completes. */
function selectBox(t, row) {
  const box = el("span", { className: "row-check" + (selected.has(t.id) ? " on" : ""), role: "checkbox", tabIndex: 0 });
  box.setAttribute("aria-checked", String(selected.has(t.id)));
  const hit = (e) => { e.stopPropagation(); toggleSelected(t.id, row, box); };
  box.onclick = hit;
  box.onkeydown = (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); hit(e); } };
  return box;
}

const TABLE_COLUMNS = ["", "Task", "Status", "Assignee", "Due", "Priority", ""];

/** One task as a table row. */
function taskTableRow(t) {
  const row = el("div", { className: "trow" + (t.status === "done" ? " done" : "") + (selected.has(t.id) ? " picked" : "") });

  row.append(selectBox(t, row));

  const name = el("div", { className: "tcell tcell-name" });
  name.append(el("span", { className: "trow-title", textContent: t.title }));
  const under = el("span", { className: "trow-sub" });
  if (!state.projectId && t.project_name) under.append(el("span", { textContent: t.project_name }));
  if (t.ref) under.append(el("span", { className: "t-ref", textContent: t.ref }));
  if (t.subtask_count) under.append(el("span", { textContent: `${t.subtask_done}/${t.subtask_count}` }));
  if (t.comment_count) under.append(el("span", { textContent: `${t.comment_count} ✦` }));
  if (t.queue) under.append(el("span", { className: "queued-mark", textContent: t.claimed_by ? `◆ ${t.claimed_by}` : "◆ queued" }));
  if (under.childNodes.length) name.append(under);
  row.append(name);

  // Status is a control here rather than a label: in a table the whole point is
  // changing one field across many rows without opening any of them.
  const statusCell = el("div", { className: "tcell" });
  const status = el("select", { className: `cell-select st-${t.status}` });
  for (const [value, label] of BOARD_COLUMNS) {
    status.append(el("option", { value, textContent: label, selected: t.status === value }));
  }
  status.onclick = (e) => e.stopPropagation();
  status.onchange = async (e) => {
    e.stopPropagation();
    await window.delphi.tasks.update(t.id, { status: status.value });
    refresh();
  };
  statusCell.append(status);
  row.append(statusCell);

  const who = el("div", { className: "tcell" });
  if (t.assignee) {
    who.append(el("span", { className: "avatar sm" + (isAgent(t.assignee) ? " agent" : ""), textContent: t.assignee.slice(0, 1).toUpperCase() }));
    who.append(el("span", { className: "cell-text", textContent: t.assignee }));
  } else {
    who.append(el("span", { className: "cell-empty", textContent: "unassigned" }));
  }
  row.append(who);

  const due = el("div", { className: "tcell" });
  if (isOverdue(t)) due.append(el("span", { className: "pill overdue", textContent: t.due }));
  else if (t.due) due.append(el("span", { className: "cell-text", textContent: t.due }));
  else due.append(el("span", { className: "cell-empty", textContent: "no date" }));
  row.append(due);

  const priority = el("div", { className: "tcell" });
  priority.append(el("span", { className: "pill " + (t.priority === "high" ? "high" : "muted"), textContent: t.priority }));
  row.append(priority);

  const actions = el("div", { className: "tcell tcell-actions" });
  const open = el("button", { className: "row-btn", textContent: "Open", title: "Open the task" });
  open.onclick = (e) => { e.stopPropagation(); openTaskSheet(t.id); };
  const look = el("button", { className: "row-btn", textContent: "Look", title: "Quick look" });
  look.onclick = (e) => { e.stopPropagation(); quickLook(t.id); };
  const more = el("button", { className: "row-btn icon", textContent: "⋯", title: "Actions" });
  more.onclick = (e) => {
    e.stopPropagation();
    const box = more.getBoundingClientRect();
    taskMenu(t, box.left - 150, box.bottom + 4);
  };
  actions.append(open, look, more);
  row.append(actions);

  row.onclick = () => openTaskSheet(t.id);
  row.oncontextmenu = (e) => { e.preventDefault(); taskMenu(t, e.clientX, e.clientY); };
  return row;
}

/** The table, grouped by status the way the references group it. */
function renderTaskTable(root, tasks) {
  const table = el("section", { className: "ttable" });

  const header = el("div", { className: "trow thead" });
  header.append(el("span", { className: "row-check head", title: "Select all" }));
  for (const label of TABLE_COLUMNS.slice(1)) header.append(el("div", { className: "tcell", textContent: label }));
  // Select all is the one place the header box does something.
  const all = header.querySelector(".row-check");
  all.onclick = () => {
    const everyone = tasks.every((t) => selected.has(t.id));
    if (everyone) clearSelection();
    else { for (const t of tasks) selected.add(t.id); refreshSelectionMarks(); paintBulkBar(); }
  };
  table.append(header);

  for (const group of groupByStatus(tasks)) {
    if (!group.tasks.length) continue;
    const head = el("div", { className: `tgroup st-${group.status}` });
    head.append(el("span", { className: "tcol-dot" }));
    head.append(el("span", { className: "tgroup-name", textContent: group.label }));
    head.append(el("span", { className: "tcol-n", textContent: String(group.tasks.length) }));
    table.append(head);
    for (const t of group.tasks) table.append(taskTableRow(t));
  }

  root.append(table);
}

/** Marks every row as selected after a select all, without a full re-render. */
function refreshSelectionMarks() {
  for (const box of document.querySelectorAll(".trow:not(.thead) .row-check")) box.classList.add("on");
  for (const row of document.querySelectorAll(".trow:not(.thead)")) row.classList.add("picked");
}

function renderTasks(root) {
  const mode = state.projectId && !state.query ? taskViewMode() : "list";

  if (!state.query) {
    const bar = el("div", { className: "add-row" });
    // The composer belongs to the flat list. The other two put an input at the
    // foot of each column, where it also decides the status.
    if (mode === "list") bar.append(taskComposer());
    else bar.append(el("span", { className: "grow" }));
    const toggle = el("button", { className: "btn", textContent: state.showDone ? "Hide done" : "Show done" });
    toggle.onclick = () => { state.showDone = !state.showDone; refresh(); };
    bar.append(toggle);
    // Only inside a project: All work spans several and a per-project setting
    // has nothing to attach to.
    if (state.projectId) bar.append(viewPicker());
    root.append(bar);
  }

  // Applied here rather than in refresh so the tab count keeps reporting the
  // whole list, and clearing the filter is a render away rather than a reload.
  const filters = {
    doing: [(t) => t.status === "doing", "in progress"],
    blocked: [(t) => t.status === "blocked", "blocked"],
    overdue: [isOverdue, "overdue"],
    done: [(t) => t.status === "done", "done"],
  };
  const active = filters[state.taskFilter];
  const shown = active ? state.tasks.filter(active[0]) : state.tasks;

  if (active) {
    const clear = el("button", { className: "btn sm", textContent: "Clear filter" });
    clear.onclick = () => { state.taskFilter = null; refresh(); };
    root.append(el("div", { className: "filter-note" },
      el("span", { textContent: `Showing ${plural(shown.length, "task", "tasks")} ${active[1]}` }),
      clear));
  }

  // The columns and the board keep their shape when empty, because an empty
  // column is information and a board that vanishes when the last task moves is
  // disorienting.
  clearSelection();

  if (!shown.length && mode === "list") {
    root.append(emptyState(
      state.query ? "Nothing matched" : active ? `Nothing ${active[1]}` : "No open tasks",
      state.query ? "Try a different word." : active ? "Clear the filter to see the rest." : "Add one above."));
    return;
  }

  if (mode === "list") {
    const list = el("section", { className: "card" });
    shown.forEach((t) => list.append(taskRow(t)));
    root.append(list);
  } else if (mode === "table") {
    renderTaskTable(root, shown);
  } else if (mode === "calendar") {
    renderTaskCalendar(root, shown);
  } else {
    // Done is hidden by default everywhere else, so a Done column that is always
    // empty would be a lie. It appears only when done work is being shown.
    const groups = groupByStatus(shown).filter((g) => g.status !== "done" || state.showDone || g.tasks.length);
    const wrap = el("div", { className: "tcols" + (mode === "board" ? " board" : "") });
    for (const group of groups) wrap.append(statusColumn(group, { board: mode === "board" }));
    root.append(wrap);
  }

  if (state.query && state.notes.length) {
    root.append(el("div", { className: "side-label", textContent: "Matching memory" }));
    const notes = el("section", { className: "card" });
    state.notes.forEach((n) => {
      const row = el("div", { className: "list-row" });
      row.append(el("span", { className: `kind ${n.kind}`, textContent: n.kind }));
      row.append(el("div", { className: "grow" },
        el("div", { textContent: n.title }),
        el("div", { className: "hint", textContent: (n.body || "").slice(0, 110) })));
      if (n.project_name) row.append(el("span", { className: "chip", textContent: n.project_name }));
      notes.append(row);
    });
    root.append(notes);
  }
}

/* ---------------------------------------------------------------------------
   Row menus and quick look

   The row used to carry eleven separate controls: a status cycler, a project
   dropdown, a notes toggle, a delete, and a chip for every attribute. Between
   them there was barely any row left to click, and the one thing anyone wants,
   opening the task, was the hardest target on it.

   The row now shows what you scan for and nothing else. Everything that was a
   button lives in a menu on right click, and a quick look reads the task without
   opening it.
--------------------------------------------------------------------------- */

let openMenu = null;
let onMenuClose = null;

function closeRowMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  // Read and cleared before it runs, so a handler that opens another menu
  // cannot have its own callback wiped by the one it replaced.
  const done = onMenuClose;
  onMenuClose = null;
  if (done) done();
}

/**
 * A menu at a point on screen.
 *
 * Kept inside the viewport rather than allowed to run off the bottom, because a
 * menu opened on the last row of a long list is exactly where that happens.
 *
 * An item is a verb, a separator, or a node the caller built itself. The verb
 * form stays the common case, because most menus are a list of things to do and
 * should not have to build anything to say so.
 */
function rowMenu(x, y, items, { onClose = null, className = "" } = {}) {
  closeRowMenu();
  // The extra class goes on before the measurement below, not after. It is what
  // sets the width and the height cap, so clamping first would fit the menu to
  // the viewport at a size it is about to stop being.
  const menu = el("div", { className: "ctx" + (className ? ` ${className}` : "") });
  for (const item of items) {
    if (item === "-") { menu.append(el("div", { className: "ctx-sep" })); continue; }
    if (item.nodeType) { menu.append(item); continue; }
    if (item.node) { menu.append(item.node); continue; }
    const b = el("button", { className: "ctx-item" + (item.danger ? " danger" : ""), textContent: item.label });
    b.onclick = async () => { closeRowMenu(); await item.run(); };
    menu.append(b);
  }
  menu.style.left = "0px";
  menu.style.top = "0px";
  document.body.append(menu);

  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - box.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - box.height - 8)}px`;

  openMenu = menu;
  onMenuClose = onClose;
  // Bound after this click finishes, or the click that opened it closes it.
  setTimeout(() => {
    const away = (e) => {
      if (!menu.contains(e.target)) { closeRowMenu(); document.removeEventListener("mousedown", away); }
    };
    document.addEventListener("mousedown", away);
  }, 0);
  return menu;
}

const STATUS_WORD = { todo: "To do", doing: "In progress", blocked: "Blocked", done: "Done" };

/**
 * The task at a glance, without opening it.
 *
 * Read only on purpose. It answers "what is this" in one keypress and gets out
 * of the way; anything that changes the task happens in the task.
 */
async function quickLook(taskId) {
  const detail = await window.delphi.tasks.detail(taskId);
  if (!detail) return;
  const t = detail.task;

  const overlay = el("div", { className: "overlay" });
  const card = el("div", { className: "qlook", role: "dialog" });
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", "Quick look");

  card.append(el("div", { className: "qlook-head" },
    el("span", { className: `dot-status st-${t.status}` }),
    el("h3", { textContent: t.title })));

  const rows = [
    ["Status", STATUS_WORD[t.status] || t.status],
    ["Priority", t.priority],
    ["Assignee", t.assignee || "unassigned"],
    ["Due", t.due || "no due date"],
    ["Project", detail.project ? detail.project.name : "none"],
    ["Reference", t.ref || "none"],
    ["Subtasks", detail.subtasks.length
      ? `${detail.subtasks.filter((s) => s.status === "done").length} of ${detail.subtasks.length} done`
      : "none"],
    ["Comments", String(detail.comments.length)],
    ["Created", ago(t.created_at)],
  ];
  const grid = el("div", { className: "qlook-grid" });
  for (const [label, value] of rows) {
    grid.append(el("span", { className: "qlook-label", textContent: label }));
    grid.append(el("span", { className: "qlook-value", textContent: value }));
  }
  card.append(grid);

  if (t.detail) {
    const body = el("div", { className: "qlook-detail" });
    body.append(renderMarkdown(t.detail));
    card.append(body);
  }

  const close = async () => { overlay.remove(); openSheet = null; };
  const foot = el("div", { className: "qlook-foot" });
  const openIt = el("button", { className: "btn primary", textContent: "Open task" });
  openIt.onclick = async () => { await close(); openTaskSheet(taskId); };
  const shut = el("button", { className: "btn", textContent: "Close" });
  shut.onclick = close;
  foot.append(el("span", { className: "hint", textContent: "Escape to close" }), openIt, shut);
  card.append(foot);

  overlay.append(card);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.body.append(overlay);
  openSheet = { overlay, close };
  openIt.focus();
}

/** The menu a task row offers, used by right click and by the row's own button. */
function taskMenu(t, x, y) {
  const set = async (fields) => { await window.delphi.tasks.update(t.id, fields); refresh(); };

  const moves = state.projects
    .filter((p) => p.id !== t.project_id)
    .slice(0, 8)
    .map((p) => ({ label: `Move to ${p.name}`, run: () => set({ project_id: p.id }) }));

  rowMenu(x, y, [
    { label: "Open", run: () => openTaskSheet(t.id) },
    { label: "Quick look", run: () => quickLook(t.id) },
    "-",
    ...(t.status === "done"
      ? [{ label: "Reopen", run: () => set({ status: "todo" }) }]
      : [{ label: "Mark done", run: () => set({ status: "done" }) }]),
    ...(t.status === "doing" ? [] : [{ label: "Start", run: () => set({ status: "doing" }) }]),
    ...(t.status === "blocked"
      ? [{ label: "Unblock", run: () => set({ status: "todo" }) }]
      : [{ label: "Block", run: () => set({ status: "blocked" }) }]),
    "-",
    ...(t.queue
      ? [{ label: "Take out of the agent queue", run: async () => { await window.delphi.tasks.queue(t.id, null); refresh(); } }]
      : [{ label: "Send to the agent queue", run: async () => { await window.delphi.tasks.queue(t.id, "ready"); refresh(); } }]),
    "-",
    ...(moves.length ? [...moves, "-"] : []),
    {
      label: "Delete", danger: true,
      run: async () => {
        await window.delphi.tasks.remove(t.id);
        refresh();
        // Said where it happened, because that is when someone needs to know it
        // is not final.
        setTimeout(() => alert("Task deleted. Restore it from this project's Activity tab."), 30);
      },
    },
  ]);
}

/**
 * One task, as a line.
 *
 * Only what someone scans for: whether it is done, what it is called, and the
 * two or three facts that decide whether to look closer. Everything else is a
 * right click away, so the row itself stays a target rather than a toolbar.
 */
function taskRow(t) {
  const row = el("div", { className: "task" + (t.status === "done" ? " done" : "") });

  const check = el("div", { className: "check", textContent: "✓", tabIndex: 0, role: "checkbox" });
  check.setAttribute("aria-checked", String(t.status === "done"));
  const toggle = async (e) => {
    if (e) e.stopPropagation();
    await window.delphi.tasks.update(t.id, { status: t.status === "done" ? "todo" : "done" });
    refresh();
  };
  check.onclick = toggle;
  check.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
  row.append(check);

  const body = el("div", { className: "t-body" });
  const heading = el("div", { className: "t-title", textContent: t.title });
  body.append(heading);

  // A second line only when there is something worth putting on it.
  const sub = el("div", { className: "t-sub" });
  if (!state.projectId && t.project_name) sub.append(el("span", { textContent: t.project_name }));
  if (t.ref) sub.append(el("span", { className: "t-ref", textContent: t.ref }));
  if (t.subtask_count) sub.append(el("span", { textContent: `${t.subtask_done}/${t.subtask_count}` }));
  if (t.comment_count) sub.append(el("span", { textContent: `${t.comment_count} ✦` }));
  if (sub.childNodes.length) body.append(sub);
  row.append(body);

  const right = el("div", { className: "t-right" });
  if (t.priority === "high") right.append(el("span", { className: "pill high", textContent: "high" }));
  if (t.status === "doing") right.append(el("span", { className: "pill doing", textContent: "In progress" }));
  if (t.status === "blocked") right.append(el("span", { className: "pill blocked", textContent: "Blocked" }));
  if (isOverdue(t)) right.append(el("span", { className: "pill overdue", textContent: t.due }));
  else if (t.due) right.append(el("span", { className: "t-due", textContent: t.due }));
  if (t.queue) {
    right.append(el("span", {
      className: "pill queued",
      title: t.claimed_by ? `Claimed by ${t.claimed_by}` : "Waiting for an agent",
      textContent: t.claimed_by ? `◆ ${t.claimed_by}` : "◆ queued",
    }));
  }
  if (t.assignee) {
    right.append(el("span", {
      className: "avatar sm" + (isAgent(t.assignee) ? " agent" : ""),
      title: t.assignee,
      textContent: t.assignee.slice(0, 1).toUpperCase(),
    }));
  }

  const more = el("button", { className: "t-more", textContent: "⋯", title: "Actions" });
  more.setAttribute("aria-label", "Task actions");
  more.onclick = (e) => {
    e.stopPropagation();
    const box = more.getBoundingClientRect();
    taskMenu(t, box.left - 150, box.bottom + 4);
  };
  right.append(more);
  row.append(right);

  // The whole row opens the task, so the target is the row and not a word in it.
  row.onclick = () => openTaskSheet(t.id);
  row.oncontextmenu = (e) => { e.preventDefault(); taskMenu(t, e.clientX, e.clientY); };
  row.tabIndex = 0;
  row.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); openTaskSheet(t.id); }
    if (e.key === " ") { e.preventDefault(); quickLook(t.id); }
  };

  return row;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

function renderNotes(root) {
  const title = el("input", { className: "field", placeholder: "New memory note title, then Enter" });
  title.onkeydown = async (e) => {
    if (e.key !== "Enter" || !title.value.trim()) return;
    await window.delphi.notes.create({ projectId: state.projectId, title: title.value.trim() });
    title.value = "";
    refresh();
  };
  // The toggle sits beside the composer so it governs the whole list, which is
  // how it is used: you are either reading the notes or editing them.
  root.append(el("div", { className: "add-row" }, title, noteViewToggle()));

  if (!state.notes.length) {
    root.append(emptyState("Nothing stored yet",
      "This is for decisions and why the alternative was rejected, traps that cost time, and values that are hard to look up again."));
    return;
  }
  state.notes.forEach((n) => root.append(noteCard(n)));
}

/**
 * Switches memory between rendered markdown and the source.
 *
 * Notes are written as markdown by agents and read as prose by people, so both
 * are first-class: formatted to read, raw to edit. The choice is remembered
 * because it tracks what you are doing that session, not which note you are on.
 */
function noteViewToggle() {
  const seg = el("div", { className: "seg", role: "group" });
  seg.setAttribute("aria-label", "Memory display");
  for (const [value, label] of [["formatted", "Formatted"], ["raw", "Raw markdown"]]) {
    const button = el("button", { type: "button", textContent: label });
    button.setAttribute("aria-pressed", String(state.noteView === value));
    button.onclick = async () => {
      if (state.noteView === value) return;
      state.noteView = value;
      try { await window.delphi.settings.set({ noteView: value }); } catch {}
      refresh();
    };
    seg.append(button);
  }
  return seg;
}

function noteCard(n) {
  const wrap = el("article", { className: "note" });
  const head = el("div", { className: "note-head" });

  const pin = el("button", { className: "btn sm", textContent: n.pinned ? "★" : "☆", title: "Pin" });
  pin.onclick = async () => { await window.delphi.notes.update(n.id, { pinned: n.pinned ? 0 : 1 }); refresh(); };
  head.append(pin);

  const titleInput = el("input", { value: n.title });
  titleInput.onblur = async () => {
    if (titleInput.value.trim() && titleInput.value !== n.title) {
      await window.delphi.notes.update(n.id, { title: titleInput.value.trim() });
      refresh();
    }
  };
  head.append(titleInput);

  const kind = el("select", { className: "btn sm" });
  ["note", "decision", "gotcha", "reference", "contact"].forEach((k) =>
    kind.append(el("option", { value: k, textContent: k, selected: k === n.kind })));
  kind.onchange = async () => { await window.delphi.notes.update(n.id, { kind: kind.value }); refresh(); };
  head.append(kind);

  const expand = el("button", { className: "icon-btn", title: "Full view (Command + Enter while editing)" });
  expand.setAttribute("aria-label", "Open full view");
  expand.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  expand.onclick = () => openNoteSheet(n);
  head.append(expand);

  const del = el("button", { className: "btn sm", textContent: "×", title: "Delete" });
  del.onclick = async () => { await window.delphi.notes.remove(n.id); refresh(); };
  head.append(del);
  wrap.append(head);

  if (state.noteView === "formatted") {
    // Read mode. Double click drops into the source at the note you are looking
    // at, so switching to edit does not mean changing a global setting first.
    const rendered = renderMarkdown(n.body);
    rendered.title = "Double click to edit the markdown";
    rendered.ondblclick = () => { state.noteView = "raw"; refresh(); };
    wrap.append(el("div", { className: "note-body" },
      (n.body || "").trim()
        ? rendered
        : el("div", { className: "hint", textContent: "Empty. Switch to raw markdown to write something." })));
    return wrap;
  }

  const body = el("textarea", {
    className: "field",
    value: n.body,
    rows: Math.min(18, Math.max(4, (n.body || "").split("\n").length + 1)),
    placeholder: "What is worth remembering here",
  });
  body.onblur = async () => {
    if (body.value !== n.body) { await window.delphi.notes.update(n.id, { body: body.value }); n.body = body.value; }
  };
  // The moment you want more room is while typing in too little of it.
  body.onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      n.body = body.value;
      openNoteSheet(n);
    }
  };
  wrap.append(el("div", { className: "note-body" }, body));
  return wrap;
}

// ---------------------------------------------------------------------------
// Full view
// ---------------------------------------------------------------------------

let openSheet = null;

/**
 * Opens one note at full size.
 *
 * Saves on close rather than on every keystroke: this is a place to write at
 * length, and a write per character would fight the vault rebuild that follows
 * each change.
 */
function openNoteSheet(note) {
  if (openSheet) closeNoteSheet();

  const overlay = el("div", { className: "overlay" });
  const sheet = el("div", { className: "sheet", role: "dialog" });
  sheet.setAttribute("aria-modal", "true");

  const head = el("div", { className: "sheet-head" });
  const title = el("input", { value: note.title });
  head.append(el("span", { className: `kind ${note.kind || "note"}`, textContent: note.kind || "note" }), title);

  const status = el("span", { className: "hint" });
  const close = el("button", { className: "icon-btn", title: "Close (Escape)" });
  close.setAttribute("aria-label", "Close full view");
  close.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  const area = el("textarea", { value: note.body || "", spellcheck: false });
  area.placeholder = "What is worth remembering here";

  const pane = el("div", { className: "sheet-body" });

  // Rendering reads from the textarea rather than from the note, so switching
  // to formatted shows what you have just typed and not what was last saved.
  const paint = () => {
    pane.textContent = "";
    pane.append(state.noteView === "formatted" ? renderMarkdown(area.value) : area);
    if (state.noteView === "raw") area.focus();
  };

  const seg = el("div", { className: "seg", role: "group" });
  seg.setAttribute("aria-label", "Display");
  for (const [value, label] of [["formatted", "Formatted"], ["raw", "Raw"]]) {
    const button = el("button", { type: "button", textContent: label });
    button.setAttribute("aria-pressed", String(state.noteView === value));
    button.onclick = async () => {
      if (state.noteView === value) return;
      state.noteView = value;
      for (const b of seg.children) b.setAttribute("aria-pressed", String(b.textContent.toLowerCase().startsWith(value)));
      try { await window.delphi.settings.set({ noteView: value }); } catch {}
      paint();
    };
    seg.append(button);
  }

  head.append(seg, status, close);

  const foot = el("div", { className: "sheet-foot" });
  const counts = () => {
    const text = area.value;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    foot.textContent = `${text.split("\n").length} lines, ${words} words   ·   Escape closes and saves`;
  };
  counts();
  area.oninput = counts;

  paint();
  sheet.append(head, pane, foot);
  overlay.append(sheet);
  // Clicking the backdrop closes, but a click inside must not bubble out to it.
  overlay.onclick = (e) => { if (e.target === overlay) closeNoteSheet(); };
  close.onclick = () => closeNoteSheet();
  document.body.append(overlay);

  openSheet = { overlay, note, title, area, status, close: closeNoteSheet };
  // Only the source pane can take a caret. In formatted mode the textarea is
  // detached, and focusing a node that is not in the document does nothing.
  if (state.noteView === "raw") {
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }
}

async function closeNoteSheet() {
  if (!openSheet) return;
  const { overlay, note, title, area } = openSheet;
  openSheet = null;

  const updates = {};
  if (title.value.trim() && title.value !== note.title) updates.title = title.value.trim();
  if (area.value !== (note.body || "")) updates.body = area.value;

  overlay.remove();

  if (Object.keys(updates).length) {
    await window.delphi.notes.update(note.id, updates);
    refresh();
  }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function renderLinks(root) {
  const label = el("input", { className: "field", placeholder: "Label" });
  const url = el("input", { className: "field", placeholder: "https://" });
  const add = el("button", { className: "btn primary", textContent: "Add" });
  add.onclick = async () => {
    if (!label.value.trim() || !url.value.trim()) return;
    const kind = /pull\/\d+|\/pr\//.test(url.value) ? "pr"
      : /jira|atlassian|[A-Z]+-\d+/.test(url.value) ? "jira"
      : /grafana|dashboard|kibana/.test(url.value) ? "dashboard" : "link";
    await window.delphi.links.create({ projectId: state.projectId, label: label.value.trim(), url: url.value.trim(), kind });
    label.value = url.value = "";
    refresh();
  };
  root.append(el("div", { className: "add-row" }, label, url, add));

  if (!state.links.length) {
    root.append(emptyState("No links yet", "Pull requests, tickets and dashboards for this project."));
    return;
  }
  const list = el("section", { className: "card" });
  state.links.forEach((l) => {
    const row = el("div", { className: "list-row" });
    row.append(el("span", { className: "kind", textContent: l.kind }));
    const a = el("a", { href: "#", className: "grow", textContent: l.label });
    a.onclick = (e) => { e.preventDefault(); window.delphi.openExternal(l.url); };
    row.append(a, el("span", { className: "mono", textContent: l.url.slice(0, 46) }));
    const del = el("button", { className: "btn sm", textContent: "×" });
    del.onclick = async () => { await window.delphi.links.remove(l.id); refresh(); };
    row.append(del);
    list.append(row);
  });
  root.append(list);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * What has happened inside this project, and how to put it back.
 *
 * The same audit trail the History tab reads, narrowed to one project. It exists
 * because a task deleted inside a project could previously only be recovered from
 * the All view, which is not where anyone looks after deleting something.
 */
async function renderActivity(root) {
  const entries = await window.delphi.audit.project(state.projectId, 200);

  if (!entries.length) {
    root.append(emptyState("Nothing has happened here yet",
      "Every change in this project is recorded, and every one of them can be put back."));
    return;
  }

  const deletes = entries.filter((e) => e.action === "delete" && !e.undone && e.restorable);
  if (deletes.length) {
    const bar = el("div", { className: "restore-bar" });
    bar.append(el("span", {
      textContent: `${plural(deletes.length, "deleted item", "deleted items")} can still be restored.`,
    }));
    const all = el("button", { className: "btn primary sm", textContent: "Restore all" });
    all.onclick = async () => {
      // Oldest first, so anything that depended on something else comes back
      // after the thing it depended on.
      for (const e of [...deletes].reverse()) {
        try { await window.delphi.audit.undo(e.id); } catch { /* keep going */ }
      }
      refresh();
    };
    bar.append(all);
    root.append(bar);
  }

  const list = el("section", { className: "card" });
  for (const e of entries) {
    const row = el("div", {
      className: "audit-row" + (e.undone ? " undone" : "") + (e.action === "delete" ? " deleted" : ""),
    });
    row.append(el("span", { className: "audit-when", textContent: ago(e.at) }));

    const what = el("div", { className: "audit-what" },
      el("div", {}, el("span", { className: `act act-${e.action}`, textContent: e.action }),
                    el("span", { textContent: ` ${e.entity} ${e.summary}` })));
    if (e.label) what.append(el("div", { className: "lbl", textContent: e.label.slice(0, 140) }));
    row.append(what);

    if (e.undone) {
      row.append(el("span", { className: "chip", textContent: "restored" }));
    } else if (e.action === "delete" && !e.restorable) {
      // Honest rather than hopeful: with no stored copy there is nothing to put
      // back, and a button that cannot work is worse than no button.
      row.append(el("span", { className: "chip", textContent: "not recoverable" }));
    } else {
      const b = el("button", {
        className: "btn sm" + (e.action === "delete" ? " primary" : ""),
        textContent: e.action === "delete" ? "restore" : "undo",
      });
      b.onclick = async () => {
        try { await window.delphi.audit.undo(e.id); } catch (err) { alert(err.message); }
        refresh();
      };
      row.append(b);
    }
    list.append(row);
  }
  root.append(list);
}

async function renderHistory(root) {
  const bar = el("div", { className: "add-row" });
  const msg = el("span", { className: "hint" });
  const undo = (n, text) => {
    const b = el("button", { className: "btn", textContent: text });
    b.onclick = async () => {
      try {
        const done = await window.delphi.audit.undoLast(n);
        msg.className = "ok-msg";
        msg.textContent = done ? `Reversed ${plural(done, "change", "changes")}.` : "Nothing left to undo.";
      } catch (e) { msg.className = "err-msg"; msg.textContent = e.message; }
      refresh();
    };
    return b;
  };
  bar.append(undo(1, "Undo last change"), undo(5, "Undo last 5"), msg);
  root.append(bar);

  const entries = await window.delphi.audit.list(200);
  if (!entries.length) {
    root.append(emptyState("Nothing recorded yet", "Every change from here on is logged and reversible."));
    return;
  }

  const list = el("section", { className: "card" });
  entries.forEach((e) => {
    const row = el("div", { className: "audit-row" + (e.undone ? " undone" : "") });
    row.append(el("span", { className: "audit-when", textContent: ago(e.at) }));
    const what = el("div", { className: "audit-what" },
      el("div", { textContent: `${e.entity} ${e.summary}` }));
    if (e.label) what.append(el("div", { className: "lbl", textContent: e.label.slice(0, 120) }));
    row.append(what);
    if (e.undone) row.append(el("span", { className: "chip", textContent: "undone" }));
    else {
      const b = el("button", { className: "btn sm", textContent: "undo" });
      b.onclick = async () => {
        try { await window.delphi.audit.undo(e.id); } catch (err) { alert(err.message); }
        refresh();
      };
      row.append(b);
    }
    list.append(row);
  });
  root.append(list);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function toAccelerator(event) {
  const parts = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Command");

  let key = event.key;
  const code = event.code || "";
  if (["Control", "Alt", "Shift", "Meta"].includes(key)) return { parts, key: null };
  if (key === " " || code === "Space") key = "Space";
  else if (code.startsWith("Digit")) key = code.slice(5);
  else if (code.startsWith("Key")) key = code.slice(3);
  else if (key === "ArrowUp") key = "Up";
  else if (key === "ArrowDown") key = "Down";
  else if (key === "ArrowLeft") key = "Left";
  else if (key === "ArrowRight") key = "Right";
  else if (key.length === 1) key = key.toUpperCase();
  return { parts, key };
}

const partLabel = (p) =>
  ({ Control: "control", Alt: "option", Shift: "shift", Command: "command", Space: "space" }[p] || p);

async function renderSettings(root) {
  const settings = await window.delphi.settings.get();

  // --- appearance ----------------------------------------------------------
  const appearance = el("div", { className: "setting" });
  appearance.append(el("h3", { textContent: "Appearance" }));
  appearance.append(el("p", {
    textContent: "System follows whatever the Mac is set to and changes with it. Light and dark pin the window regardless.",
  }));

  const themes = el("div", { className: "seg", role: "group" });
  themes.setAttribute("aria-label", "Theme");
  for (const [value, label] of [["system", "System"], ["light", "Light"], ["dark", "Dark"]]) {
    const button = el("button", { type: "button", textContent: label });
    button.setAttribute("aria-pressed", String(state.theme === value));
    button.onclick = async () => {
      // Applied before the write so the window changes on the click rather than
      // after a round trip, and left applied if the write fails: the setting
      // not persisting is a smaller problem than the button looking dead.
      applyTheme(value);
      for (const b of themes.children) b.setAttribute("aria-pressed", String(b.textContent.toLowerCase() === value));
      try { await window.delphi.settings.set({ theme: value }); } catch {}
    };
    themes.append(button);
  }
  appearance.append(themes);
  root.append(appearance);

  // --- shortcut ------------------------------------------------------------
  const shortcut = el("div", { className: "setting" });
  shortcut.append(el("h3", { textContent: "Show and hide shortcut" }));
  shortcut.append(el("p", {
    textContent: "Click the box, then press the combination you want. It registers straight away, and if another application already owns it you are told rather than left wondering.",
  }));

  const rec = el("div", { className: "recorder", tabIndex: 0, role: "button" });
  const keys = el("div", { className: "keys" });
  const status = el("div", { className: "hint", textContent: "Click to record" });
  const paint = (accel) => {
    keys.textContent = "";
    accel.split("+").forEach((p) => keys.append(el("span", { className: "key", textContent: partLabel(p) })));
  };
  paint(settings.hotkey);
  rec.append(keys, status);

  let armed = false;
  const stop = () => {
    armed = false;
    rec.classList.remove("armed");
    status.className = "hint";
    status.textContent = "Click to record";
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = async (event) => {
    if (!armed) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") { paint(settings.hotkey); stop(); return; }

    const { parts, key } = toAccelerator(event);
    if (!key) {
      keys.textContent = "";
      parts.forEach((p) => keys.append(el("span", { className: "key", textContent: partLabel(p) })));
      return;
    }
    if (!parts.length) {
      status.className = "err-msg";
      status.textContent = "Needs at least one modifier, otherwise it would fire while you type.";
      return;
    }
    const accel = [...parts, key].join("+");
    paint(accel);
    try {
      await window.delphi.settings.setHotkey(accel);
      settings.hotkey = accel;
      status.className = "ok-msg";
      status.textContent = `Saved. ${accel} now shows and hides this panel.`;
    } catch (e) {
      status.className = "err-msg";
      status.textContent = e.message;
      paint(settings.hotkey);
    }
    armed = false;
    rec.classList.remove("armed");
    document.removeEventListener("keydown", onKey, true);
  };
  const arm = () => {
    if (armed) return stop();
    armed = true;
    rec.classList.add("armed");
    status.className = "hint";
    status.textContent = "Listening. Press a combination, or Escape to cancel.";
    document.addEventListener("keydown", onKey, true);
  };
  rec.onclick = arm;
  shortcut.append(rec);
  root.append(shortcut);

  // --- window behaviour ----------------------------------------------------
  const mode = el("div", { className: "setting" });
  mode.append(el("h3", { textContent: "Window behaviour" }));
  mode.append(el("p", {
    textContent: "By default this is an ordinary application: it appears in the dock, can be full screened, and stays where you put it. Panel mode instead makes it float above your work and disappear as soon as you click away, which suits quick glances and gets in the way of longer sessions.",
  }));
  const modeRow = el("div", { className: "row" });
  const box = el("input", { type: "checkbox", checked: settings.panelMode === true, id: "panel-mode" });
  const lbl = el("label", { htmlFor: "panel-mode", textContent: "Panel mode: float above other windows and hide when it loses focus" });
  const modeMsg = el("span", { className: "hint" });
  box.onchange = async () => {
    try {
      // The window is rebuilt to apply this, so it will flicker once.
      await window.delphi.settings.set({ panelMode: box.checked });
      modeMsg.className = "ok-msg";
      modeMsg.textContent = box.checked ? "Panel mode on" : "Normal window";
    } catch (e) {
      modeMsg.className = "err-msg";
      modeMsg.textContent = e.message;
      box.checked = !box.checked;
    }
  };
  modeRow.append(box, lbl, modeMsg);
  mode.append(modeRow);
  mode.append(el("p", { className: "hint", style: "margin:12px 0 0",
    textContent: "The shortcut works either way: in normal mode it brings the window forward rather than dismissing it." }));
  root.append(mode);

  // --- reminders -----------------------------------------------------------
  const rem = el("div", { className: "setting" });
  rem.append(el("h3", { textContent: "Reminders" }));
  rem.append(el("p", { textContent: "How long Snooze puts a reminder off for, and how often the app looks for reminders that have come due." }));
  const numberField = (label, key, suffix) => {
    const row = el("div", { className: "row", style: "margin-bottom:10px" });
    row.append(el("span", { textContent: label, style: "flex:0 0 210px" }));
    const input = el("input", { type: "number", min: "1", value: String(settings[key] ?? ""), className: "field", style: "width:92px" });
    const note = el("span", { className: "hint" });
    input.onchange = async () => {
      try {
        const updated = await window.delphi.settings.set({ [key]: Number(input.value) });
        settings[key] = updated[key];
        note.className = "ok-msg";
        note.textContent = "saved";
      } catch (e) { note.className = "err-msg"; note.textContent = e.message; }
    };
    row.append(input, el("span", { className: "hint", textContent: suffix }), note);
    return row;
  };
  rem.append(numberField("Snooze for", "snoozeMinutes", "minutes"));
  rem.append(numberField("Check for due reminders every", "checkIntervalSeconds", "seconds"));
  root.append(rem);

  // --- vault ---------------------------------------------------------------
  const v = el("div", { className: "setting" });
  v.append(el("h3", { textContent: "Markdown vault" }));
  v.append(el("p", {
    textContent: "Your memory notes are mirrored to plain markdown files so they are not trapped in a database only this app reads. Point Obsidian at the folder and you get its editor, backlinks, graph and mobile apps over the same notes. It rewrites itself a moment after any change.",
  }));
  const vrow = el("div", { className: "row" });
  const openBtn = el("button", { className: "btn", textContent: "Open the folder" });
  const exportBtn = el("button", { className: "btn", textContent: "Rebuild now" });
  const vmsg = el("span", { className: "hint" });
  openBtn.onclick = () => window.delphi.vault.reveal();
  exportBtn.onclick = async () => {
    try {
      const r = await window.delphi.vault.export();
      vmsg.className = "ok-msg";
      vmsg.textContent = `${r.notes} notes across ${r.projects} projects written`;
    } catch (e) { vmsg.className = "err-msg"; vmsg.textContent = e.message; }
  };
  vrow.append(openBtn, exportBtn, vmsg);
  v.append(vrow);
  v.append(el("p", { className: "hint", style: "margin-top:12px; margin-bottom:0",
    textContent: "The database stays the source of truth and the mirror is one way. Two way sync between a database and a folder is where these break, so edits made in Obsidian are not read back." }));
  root.append(v);

  // --- mouse buttons -------------------------------------------------------
  const mouse = el("div", { className: "setting" });
  mouse.append(el("h3", { textContent: "Using a mouse button" }));
  mouse.append(el("p", { style: "margin-bottom:0",
    textContent: "A global shortcut can only be a keyboard combination, so a mouse button cannot be bound here directly. Do it the other way round: in your mouse software, map the side button to send the combination above. The panel cannot tell the difference. Logitech Options, SteerMouse and Razer Synapse all do this." }));
  root.append(mouse);

  // --- data ----------------------------------------------------------------
  const data = el("div", { className: "setting" });
  data.append(el("h3", { textContent: "Where your data lives" }));
  const dl = el("dl", { className: "kv" });
  dl.append(el("dt", { textContent: "Database" }), el("dd", {}, el("span", { className: "mono", textContent: "~/va/delphi/delphi.db" })));
  dl.append(el("dt", { textContent: "Settings" }), el("dd", {}, el("span", { className: "mono", textContent: "~/va/delphi/settings.json" })));
  dl.append(el("dt", { textContent: "History" }), el("dd", { textContent: "Every change is recorded and can be reversed." }));
  data.append(dl);
  root.append(data);
}

// ---------------------------------------------------------------------------
// The task sheet
//
// A task in a list is a line of text. Opened, it is the whole story: what state
// it has been through and for how long, what was said about it, what it is made
// of, and who is holding it.
//
// Two things here are deliberate rather than decorative. The timeline shows
// durations rather than timestamps, because "blocked for four days" is the thing
// anyone actually wants to know and a pair of dates makes you do the arithmetic.
// And the handoff block turns the task into a brief an agent can act on, because
// the alternative is a person retyping the same context into a chat window.
// ---------------------------------------------------------------------------

const STATUSES = [
  ["todo", "To do"],
  ["doing", "In progress"],
  ["blocked", "Blocked"],
  ["done", "Done"],
];

/** Names that belong to software rather than to a person. */
const isAgent = (name) => /claude|copilot|codex|cursor|agent|gpt|bot/i.test(String(name || ""));

/**
 * A gap in words.
 *
 * Rounded to one unit on purpose: this is read at a glance to answer "was that
 * recent", and "3d" answers it where "3 days 4 hours 12 minutes" does not.
 */
function gap(fromIso, toIso) {
  const from = new Date(String(fromIso).replace(" ", "T") + "Z").getTime();
  const to = toIso ? new Date(String(toIso).replace(" ", "T") + "Z").getTime() : Date.now();
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 90) return "moments";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * The task as something an agent can be handed.
 *
 * Everything it would otherwise have to ask for, plus the exact calls that change
 * it, so the agent does not have to guess the tool names. Copied rather than sent
 * anywhere: which agent gets this is the person's decision, not the app's.
 */
function handoffText(detail) {
  const t = detail.task;
  const lines = [
    `Delphi task ${t.id}: ${t.title}`,
    detail.project ? `Project: ${detail.project.name}` : null,
    `Status: ${t.status}   Priority: ${t.priority}` +
      (t.due ? `   Due: ${t.due}` : "") +
      (t.assignee ? `   Assignee: ${t.assignee}` : ""),
    t.ref ? `Reference: ${t.ref}` : null,
    "",
    t.detail ? t.detail.trim() : "(no detail written)",
  ].filter((line) => line !== null);

  if (detail.subtasks.length) {
    lines.push("", "Subtasks:");
    for (const s of detail.subtasks) lines.push(`  [${s.status === "done" ? "x" : " "}] ${s.title}`);
  }

  if (detail.comments.length) {
    lines.push("", "Discussion so far:");
    for (const c of detail.comments) lines.push(`  ${c.author}: ${c.body.replace(/\s+/g, " ").trim()}`);
  }

  if (detail.events.length > 1) {
    lines.push("", "How it got here:");
    for (let i = 0; i < detail.events.length; i++) {
      const e = detail.events[i];
      const next = detail.events[i + 1];
      lines.push(`  ${e.status} for ${gap(e.at, next ? next.at : null)}${e.actor ? ` (${e.actor})` : ""}`);
    }
  }

  lines.push(
    "",
    "To act on this through the Delphi MCP server:",
    `  update_task(id: ${t.id}, status: "doing")`,
    `  update_task(id: ${t.id}, status: "done")`,
    "  add_note(project, title, body, kind) for anything worth keeping afterwards"
  );

  return lines.join("\n");
}

/**
 * Opens one task as a workspace.
 *
 * The first version of this was a form: labelled fields stacked in a column with
 * a segmented status control at the top. It worked and it was dull, and dull is
 * the wrong answer for the screen someone spends the most time in.
 *
 * This is laid out the way the tools people already use lay it out. The metadata
 * is a row of chips you click to edit rather than a grid of form controls, so the
 * task reads as a sentence and not as a settings page. Detail and history are
 * tabs rather than a scroll. The discussion sits beside the work instead of
 * underneath it, with the composer pinned where your hands already are.
 */
async function openTaskSheet(taskId) {
  if (openSheet) await openSheet.close();

  let detail = await window.delphi.tasks.detail(taskId);
  if (!detail) return;

  let pane = "details";   // details | activity
  let editingDesc = false;

  const overlay = el("div", { className: "overlay" });
  const sheet = el("div", { className: "sheet task-sheet", role: "dialog" });
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "Task");

  const top = el("div", { className: "ts-top" });
  const body = el("div", { className: "ts-body" });
  const main = el("div", { className: "ts-main" });
  const rail = el("div", { className: "ts-rail" });
  body.append(main, rail);
  sheet.append(top, body);

  const flashHost = el("span", { className: "hint" });
  const flash = (text) => {
    flashHost.textContent = text;
    setTimeout(() => { if (flashHost.textContent === text) flashHost.textContent = ""; }, 1500);
  };

  const reload = async () => {
    detail = await window.delphi.tasks.detail(taskId);
    if (!detail) return;
    paintAll();
  };

  const write = async (fields, note) => {
    await window.delphi.tasks.update(taskId, fields);
    flash(note);
    await reload();
    refresh();
  };

  // --- header ---------------------------------------------------------------

  function paintTop() {
    top.textContent = "";
    const crumbs = el("div", { className: "ts-crumbs" });
    if (detail.project) {
      const p = el("button", { className: "crumb", textContent: detail.project.name });
      p.onclick = async () => { await closeSheet(); goTo({ projectId: detail.project.id, view: "tasks", query: "" }); };
      crumbs.append(p, el("span", { className: "crumb-sep", textContent: "/" }));
    }
    if (detail.parent) {
      const up = el("button", { className: "crumb", textContent: detail.parent.title });
      up.onclick = () => openTaskSheet(detail.parent.id);
      crumbs.append(up, el("span", { className: "crumb-sep", textContent: "/" }));
      crumbs.append(el("span", { className: "crumb-now", textContent: "subtask" }));
    } else {
      crumbs.append(el("span", { className: "crumb-now", textContent: `task ${detail.task.id}` }));
    }
    top.append(crumbs, el("span", { className: "spacer" }), flashHost);

    const hand = el("button", { className: "btn sm", textContent: "Copy brief" });
    hand.title = "Copies this task, its discussion and its history as a brief an agent can act on";
    hand.onclick = async () => {
      try {
        await navigator.clipboard.writeText(handoffText(detail));
        hand.textContent = "Copied";
      } catch { hand.textContent = "Could not copy"; }
      setTimeout(() => (hand.textContent = "Copy brief"), 1400);
    };

    const del = el("button", { className: "icon-btn", title: "Delete this task" });
    del.setAttribute("aria-label", "Delete task");
    del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>';
    del.onclick = async () => {
      await window.delphi.tasks.remove(taskId);
      await closeSheet();
      // Said at the moment it happens, because that is when someone needs to
      // know it can be taken back.
      refresh();
      setTimeout(() => alert("Task deleted. It can be restored from the project's Activity tab."), 30);
    };

    const close = el("button", { className: "icon-btn", title: "Close (Escape)" });
    close.setAttribute("aria-label", "Close");
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    close.onclick = () => closeSheet();

    top.append(hand, del, close);
  }

  // --- title ----------------------------------------------------------------

  // A textarea rather than an input, because a task title is often a sentence and
  // an input silently clips it to whatever fits.
  const title = el("textarea", { className: "ts-title", value: detail.task.title, rows: 1 });
  title.setAttribute("aria-label", "Task title");
  const growTitle = () => {
    title.style.height = "auto";
    title.style.height = `${title.scrollHeight}px`;
  };
  title.oninput = growTitle;
  // Enter commits rather than adding a line: a title is one line of meaning even
  // when it wraps across two.
  title.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); title.blur(); } };

  const ring = el("button", { className: "ts-ring" });
  ring.setAttribute("aria-label", "Toggle done");
  ring.onclick = () => write({ status: detail.task.status === "done" ? "todo" : "done" },
                             detail.task.status === "done" ? "reopened" : "marked done");

  const titleRow = el("div", { className: "ts-title-row" }, ring, title);

  function paintRing() {
    ring.className = "ts-ring" + (detail.task.status === "done" ? " on" : "");
    ring.textContent = detail.task.status === "done" ? "✓" : "";
  }

  // --- metadata chips -------------------------------------------------------

  const meta = el("div", { className: "ts-meta" });

  /**
   * A chip that becomes its own editor when clicked.
   *
   * Chips rather than form fields because a task should read as a line of facts.
   * The control only appears when someone wants to change something, which is
   * rarely, and disappears again straight after.
   */
  function chip({ icon, value, empty, tone = "", build }) {
    const wrap = el("span", { className: `ts-chip ${tone}`.trim(), tabIndex: 0, role: "button" });
    wrap.append(el("span", { className: "ts-chip-icon", textContent: icon }));
    wrap.append(el("span", { className: value ? "" : "ts-chip-empty", textContent: value || empty }));
    const open = () => {
      const editor = build(() => paintMeta());
      wrap.replaceWith(editor);
      if (editor.focus) editor.focus();
    };
    wrap.onclick = open;
    wrap.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    return wrap;
  }

  const STATUS_LABEL = { todo: "To do", doing: "In progress", blocked: "Blocked", done: "Done" };

  function paintMeta() {
    meta.textContent = "";
    const t = detail.task;

    meta.append(chip({
      icon: "◍", value: STATUS_LABEL[t.status], tone: `tone-${t.status}`,
      build: (done) => {
        const s = el("select", { className: "ts-inline" });
        for (const [v, label] of Object.entries(STATUS_LABEL)) {
          s.append(el("option", { value: v, textContent: label, selected: t.status === v }));
        }
        s.onchange = () => write({ status: s.value }, "status saved").then(done);
        s.onblur = done;
        return s;
      },
    }));

    meta.append(chip({
      icon: "⚑", value: t.priority, tone: t.priority === "high" ? "tone-high" : "",
      build: (done) => {
        const s = el("select", { className: "ts-inline" });
        for (const v of ["high", "med", "low"]) s.append(el("option", { value: v, textContent: v, selected: t.priority === v }));
        s.onchange = () => write({ priority: s.value }, "priority saved").then(done);
        s.onblur = done;
        return s;
      },
    }));

    meta.append(chip({
      icon: "◔", value: t.due ? (isOverdue(t) ? `overdue ${t.due}` : t.due) : "",
      empty: "no due date", tone: isOverdue(t) ? "tone-overdue" : "",
      build: (done) => {
        const i = el("input", { className: "ts-inline", type: "date", value: t.due || "" });
        i.onchange = () => write({ due: i.value || null }, "due date saved").then(done);
        i.onblur = done;
        return i;
      },
    }));

    meta.append(chip({
      icon: "◎", value: t.assignee || "", empty: "unassigned",
      tone: isAgent(t.assignee) ? "tone-agent" : "",
      build: (done) => {
        const i = el("input", { className: "ts-inline", value: t.assignee || "", placeholder: "name or agent" });
        i.onchange = () => write({ assignee: i.value.trim() || null }, "assignee saved").then(done);
        i.onblur = done;
        return i;
      },
    }));

    if (t.ref) meta.append(el("span", { className: "ts-chip tone-ref" },
      el("span", { className: "ts-chip-icon", textContent: "⧉" }), el("span", { textContent: t.ref })));

    const total = detail.subtasks.length;
    if (total) {
      const done = detail.subtasks.filter((s) => s.status === "done").length;
      const box = el("span", { className: "ts-chip ts-progress" });
      box.append(el("span", { className: "ts-chip-icon", textContent: "▤" }));
      box.append(el("span", { textContent: `${done}/${total}` }));
      const bar = el("span", { className: "ts-bar" });
      bar.append(el("span", { className: "ts-bar-fill", style: `width:${Math.round((done / total) * 100)}%` }));
      box.append(bar);
      meta.append(box);
    }
  }

  // --- description ----------------------------------------------------------

  const desc = el("div", { className: "ts-desc" });

  function paintDesc() {
    desc.textContent = "";
    const text = detail.task.detail || "";
    if (editingDesc) {
      const area = el("textarea", { className: "ts-desc-edit", value: text, spellcheck: false });
      area.placeholder = "What does finishing this actually involve";
      const save = async () => {
        editingDesc = false;
        if (area.value !== text) await write({ detail: area.value }, "description saved");
        else paintDesc();
      };
      area.onblur = save;
      desc.append(area);
      setTimeout(() => area.focus(), 0);
      return;
    }
    // Not "empty": that class already exists for empty states and centres its text.
    const shown = el("div", { className: "ts-desc-read" + (text ? "" : " ts-desc-blank"), tabIndex: 0, role: "button" });
    if (text) shown.append(renderMarkdown(text));
    else shown.append(el("span", { textContent: "Add a description" }));
    const edit = () => { editingDesc = true; paintDesc(); };
    shown.onclick = edit;
    shown.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); edit(); } };
    desc.append(shown);
  }

  // --- tabs -----------------------------------------------------------------

  const tabs = el("div", { className: "ts-tabs", role: "tablist" });
  const paneBox = el("div", { className: "ts-pane" });

  function paintTabs() {
    tabs.textContent = "";
    const entries = [
      ["details", "Details", detail.subtasks.length || null],
      ["activity", "Activity", detail.events.length || null],
    ];
    for (const [key, label, count] of entries) {
      const b = el("button", { className: "ts-tab" + (pane === key ? " on" : ""), textContent: label });
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(pane === key));
      if (count) b.append(el("span", { className: "ts-tab-n", textContent: String(count) }));
      b.onclick = () => { pane = key; paintTabs(); paintPane(); };
      tabs.append(b);
    }
  }

  function paintPane() {
    paneBox.textContent = "";
    if (pane === "details") paintSubtasks();
    else paintActivity();
  }

  function paintSubtasks() {
    const head = el("div", { className: "ts-sec-head" }, el("h4", { textContent: "Subtasks" }));
    if (detail.subtasks.length) {
      head.append(el("span", { className: "ts-count", textContent: String(detail.subtasks.length) }));
    }
    paneBox.append(head);

    for (const s of detail.subtasks) {
      const row = el("div", { className: "ts-sub" + (s.status === "done" ? " done" : "") });
      const tick = el("button", { className: "ts-ring sm" + (s.status === "done" ? " on" : ""),
                                  textContent: s.status === "done" ? "✓" : "" });
      tick.setAttribute("aria-label", "Toggle subtask");
      tick.onclick = async () => {
        await window.delphi.tasks.update(s.id, { status: s.status === "done" ? "todo" : "done" });
        await reload();
        refresh();
      };
      const name = el("button", { className: "ts-sub-title", textContent: s.title });
      name.onclick = () => openTaskSheet(s.id);
      row.append(tick, name);

      const bits = el("span", { className: "ts-sub-meta" });
      if (s.due) bits.append(el("span", { className: "ts-chip mini" + (isOverdue(s) ? " tone-overdue" : "") },
        el("span", { className: "ts-chip-icon", textContent: "◔" }), el("span", { textContent: s.due })));
      if (s.priority === "high") bits.append(el("span", { className: "ts-chip mini tone-high" },
        el("span", { className: "ts-chip-icon", textContent: "⚑" }), el("span", { textContent: "high" })));
      if (s.assignee) bits.append(el("span", { className: "avatar sm", textContent: s.assignee.slice(0, 1).toUpperCase() }));
      row.append(bits);
      paneBox.append(row);
    }

    const add = el("input", { className: "ts-add", placeholder: "＋  Add a subtask" });
    add.onkeydown = async (e) => {
      if (e.key !== "Enter" || !add.value.trim()) return;
      await window.delphi.tasks.create({ title: add.value.trim(), parentId: taskId });
      add.value = "";
      await reload();
      refresh();
    };
    paneBox.append(add);
  }

  function paintActivity() {
    paneBox.append(el("div", { className: "ts-sec-head" }, el("h4", { textContent: "How it got here" })));
    if (!detail.events.length) {
      paneBox.append(el("div", { className: "hint pad", textContent: "No status history yet." }));
      return;
    }
    const list = el("div", { className: "timeline" });
    detail.events.forEach((e, i) => {
      const next = detail.events[i + 1];
      const row = el("div", { className: "tl-row" + (next ? "" : " current") });
      row.append(el("span", { className: `tl-dot st-${e.status}` }));
      const b = el("div", { className: "tl-body" });
      b.append(el("div", { className: "tl-status" },
        el("span", { textContent: STATUS_LABEL[e.status] || e.status }),
        el("span", { className: "hint", textContent: next ? `for ${gap(e.at, next.at)}` : `for ${gap(e.at)} so far` })));
      b.append(el("div", { className: "tl-when" },
        el("span", { className: "hint", textContent: e.at }),
        e.actor ? el("span", { className: isAgent(e.actor) ? "agent-tag" : "hint", textContent: e.actor }) : null));
      row.append(b);
      list.append(row);
    });
    paneBox.append(list);
  }

  // --- rail: comments -------------------------------------------------------

  const railHead = el("div", { className: "ts-rail-head" });
  const railList = el("div", { className: "ts-comments" });
  const railFoot = el("div", { className: "ts-composer" });

  function paintRail() {
    railHead.textContent = "";
    railHead.append(el("h4", { textContent: "Comments" }));
    if (detail.comments.length) railHead.append(el("span", { className: "ts-count", textContent: String(detail.comments.length) }));

    railList.textContent = "";
    if (!detail.comments.length) {
      railList.append(el("div", { className: "hint pad",
        textContent: "Nothing said yet. Agents write here too, and what they leave is what the next one reads." }));
    }
    for (const c of detail.comments) {
      const agent = isAgent(c.author);
      const row = el("div", { className: "ts-comment" });
      const who = el("div", { className: "ts-comment-who" },
        el("span", { className: "avatar" + (agent ? " agent" : ""), textContent: String(c.author || "?").slice(0, 1).toUpperCase() }),
        el("span", { className: "ts-comment-author", textContent: c.author }),
        agent ? el("span", { className: "agent-tag", textContent: "agent" }) : null,
        el("span", { className: "hint", textContent: `${gap(c.created_at)} ago` }));
      const kill = el("button", { className: "ts-kill", textContent: "×", title: "Delete comment" });
      kill.onclick = async () => { await window.delphi.tasks.uncomment(c.id); await reload(); };
      who.append(kill);
      row.append(who, renderMarkdown(c.body));
      railList.append(row);
    }
    railList.scrollTop = railList.scrollHeight;
  }

  const composer = el("textarea", { className: "ts-composer-box", placeholder: "Write a comment" });
  composer.setAttribute("aria-label", "New comment");
  const post = async () => {
    if (!composer.value.trim()) return;
    await window.delphi.tasks.comment(taskId, composer.value, "you");
    composer.value = "";
    await reload();
  };
  composer.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); post(); } };
  const send = el("button", { className: "btn primary sm", textContent: "Comment" });
  send.onclick = post;
  railFoot.append(composer, el("div", { className: "ts-composer-row" },
    el("span", { className: "hint", textContent: "Enter to send" }), send));

  // --- assemble -------------------------------------------------------------

  function paintAll() {
    paintTop();
    paintRing();
    paintMeta();
    paintDesc();
    paintTabs();
    paintPane();
    paintRail();
    if (document.activeElement !== title) title.value = detail.task.title;
  }

  main.append(titleRow, meta, desc, tabs, paneBox);
  rail.append(railHead, railList, railFoot);
  overlay.append(sheet);
  document.body.append(overlay);
  paintAll();
  growTitle();

  const closeSheet = async () => {
    if (!openSheet) return;
    openSheet = null;
    const updates = {};
    if (title.value.trim() && title.value !== detail.task.title) updates.title = title.value.trim();
    overlay.remove();
    if (Object.keys(updates).length) {
      await window.delphi.tasks.update(taskId, updates);
      refresh();
    }
  };

  overlay.onclick = (e) => { if (e.target === overlay) closeSheet(); };
  openSheet = { overlay, close: closeSheet };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

let searchTimer;
$("search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(() => {
    state.query = v.trim();
    if (state.query) state.view = "oracle";
    else state.view = state.projectId ? "overview" : "new";
    refresh();
  }, 140);
});

async function createProject() {
  const name = prompt("Project name");
  if (!name || !name.trim()) return null;
  const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const palette = ["#4a63d8", "#e0803a", "#2f8757", "#a86fd1", "#c9546b", "#3fa7a1"];
  const created = await window.delphi.projects.create({
    key: key || `p${Date.now()}`,
    name: name.trim(),
    colour: palette[state.projects.length % palette.length],
  });
  state.projectId = created.id;
  state.view = "overview";
  await refresh();
  return created;
}

$("new-project").onclick = createProject;

$("back").onclick = () => goBack();

// The side buttons on a mouse, which people expect to mean back and forward.
// Bound on mouseup because Chromium fires auxclick inconsistently for these.
window.addEventListener("mouseup", (e) => {
  if (e.button === 3) { e.preventDefault(); goBack(); }
});

document.addEventListener("keydown", (e) => {
  // While the sheet is open it owns the keyboard apart from Escape. Navigating
  // behind it would leave it orphaned over a page it does not belong to, and
  // lose whatever was being written.
  if (openSheet && e.key !== "Escape") {
    if ((e.metaKey || e.ctrlKey) && ["[", "ArrowLeft", "f"].includes(e.key)) e.preventDefault();
    return;
  }

  // The shortcuts macOS already uses for Back, so there is nothing new to learn.
  if ((e.metaKey || e.ctrlKey) && (e.key === "[" || e.key === "ArrowLeft")) {
    e.preventDefault();
    goBack();
    return;
  }

  if (e.key === "Escape") {
    // The sheet is the innermost thing open, so it closes first. Without this,
    // Escape would hide the whole window and lose unsaved edits.
    if (openSheet) { openSheet.close(); return; }
    if ($("search").value) {
      $("search").value = "";
      state.query = "";
      state.view = state.projectId ? "overview" : "new";
      refresh();
      return;
    }
    window.delphi.hide();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "f") {
    e.preventDefault();
    $("search").focus();
    $("search").select();
  }
});

// Frameless panel mode has no traffic lights, so the title bar does not need to
// leave room for them. Which side needs the room at all is a platform question:
// macOS puts its traffic lights on the left of our bar, Windows puts the system
// control overlay on the right of it.
window.delphi.onMode(({ panelMode, platform, overlay }) => {
  document.body.classList.toggle("panel", panelMode);
  document.body.classList.toggle("mac", platform === "darwin");
  document.body.classList.toggle("overlay", overlay === true);
});

// ---------------------------------------------------------------------------
// The application menu
//
// The menu is built in the main process, which owns no part of the page, so every
// item that acts on what is displayed arrives here as one message. Anything that
// puts the cursor in a composer waits for the repaint first: those fields are
// created by the render and are not in the document until it has run.
// ---------------------------------------------------------------------------

function focusComposer() {
  const place = () => {
    const field = document.querySelector(".add-row .field");
    if (!field) return null;
    field.focus();
    field.select();
    return field;
  };

  const field = place();
  if (!field) return;

  // A repaint that was still in flight replaces this field with a new one and the
  // cursor is left nowhere. Two menu items in quick succession is the case that
  // does it: the first is still rendering when the second arrives. Cheap to check
  // whether that happened, so it is checked rather than assumed not to.
  requestAnimationFrame(() => {
    if (!document.contains(field)) place();
  });
}

/** Navigating from the menu empties the search box with the query, so the field
 *  cannot sit there showing a search the view no longer reflects. */
function goTo(next) {
  if (next.query === "") $("search").value = "";
  return navigate(next);
}

/** Notes and dashboards belong to a project, so the menu needs one to open. */
const someProjectId = () => state.projectId || (state.projects[0] && state.projects[0].id) || null;

window.delphi.onMenu(async ({ action, view, theme }) => {
  switch (action) {
    case "search":
      $("search").focus();
      $("search").select();
      return;

    case "back":
      goBack();
      return;

    case "theme":
      applyTheme(theme);
      render();
      return;

    case "settings":
      // Settings live in the All view, so getting there means leaving whichever
      // project is open rather than looking for a tab that is not there.
      await goTo({ projectId: null, view: "settings", query: "" });
      return;

    case "new-project":
      await createProject();
      return;

    case "new-task":
      await goTo({ view: "tasks", query: "" });
      focusComposer();
      return;

    case "new-note": {
      const projectId = someProjectId();
      // Memory is stored per project, so with none in the tracker yet the useful
      // thing to do is make one rather than to fail quietly.
      if (!projectId) {
        if (!(await createProject())) return;
      } else {
        await goTo({ projectId, view: "notes", query: "" });
      }
      focusComposer();
      return;
    }

    case "undo-last":
      try {
        await window.delphi.audit.undoLast(1);
      } catch (error) {
        alert(`Nothing to undo: ${error.message}`);
      }
      await refresh();
      return;

    case "view": {
      // What's new and History are the All view's tabs; Memory only exists inside
      // a project. Sending the wrong one would land on a tab that is not there.
      if (view === "new" || view === "history") {
        await goTo({ projectId: null, view, query: "" });
      } else if (view === "notes") {
        const projectId = someProjectId();
        if (projectId) await goTo({ projectId, view: "notes", query: "" });
      } else {
        await goTo({ view, query: "" });
      }
      return;
    }
  }
});

window.delphi.onShown(() => { refresh(); $("search").focus(); });
window.delphi.onAlertsChanged(() => refresh());
window.delphi.onFocusTask(({ projectId }) => {
  if (projectId) { state.projectId = projectId; state.view = "tasks"; }
  refresh();
});

/**
 * Reads the stored preferences before the first paint.
 *
 * The theme is applied here rather than inside render so the window never shows
 * one theme and then swaps to the other. A failure is survivable: the defaults
 * are the behaviour the app had before these settings existed.
 */
async function boot() {
  try {
    const settings = await window.delphi.settings.get();
    applyTheme(settings.theme);
    if (["formatted", "raw"].includes(settings.noteView)) state.noteView = settings.noteView;
  } catch {
    applyTheme("system");
  }
  refresh();
}

boot();
