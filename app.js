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
  if (samePosition(from, to)) return;

  state.history.push(from);
  if (state.history.length > 50) state.history.shift();
  refresh();
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
       ["notes", "Memory", state.notes.length], ["links", "Links", state.links.length]]
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
    ? ["overview", "tasks", "notes", "links"]
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

function renderTasks(root) {
  if (!state.query) {
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
    const toggle = el("button", { className: "btn", textContent: state.showDone ? "Hide done" : "Show done" });
    toggle.onclick = () => { state.showDone = !state.showDone; refresh(); };
    root.append(el("div", { className: "add-row" }, input, toggle));
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

  if (!shown.length) {
    root.append(emptyState(
      state.query ? "Nothing matched" : active ? `Nothing ${active[1]}` : "No open tasks",
      state.query ? "Try a different word." : active ? "Clear the filter to see the rest." : "Add one above."));
    return;
  }

  const list = el("section", { className: "card" });
  shown.forEach((t) => list.append(taskRow(t)));
  root.append(list);

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

function taskRow(t) {
  const row = el("div", { className: "task" + (t.status === "done" ? " done" : "") });

  const check = el("div", { className: "check", textContent: "✓", tabIndex: 0, role: "checkbox" });
  const toggle = async () => {
    await window.delphi.tasks.update(t.id, { status: t.status === "done" ? "todo" : "done" });
    refresh();
  };
  check.onclick = toggle;
  check.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
  row.append(check);

  const body = el("div", { className: "t-body" });
  body.append(el("div", { className: "t-title", textContent: t.title }));

  const meta = el("div", { className: "t-meta" });
  if (!state.projectId && t.project_name) {
    meta.append(el("span", { className: "chip", textContent: t.project_name }));
  }
  if (t.priority === "high") meta.append(el("span", { className: "chip high", textContent: "high" }));
  if (t.status === "doing") meta.append(el("span", { className: "chip doing", textContent: "in progress" }));
  if (t.status === "blocked") meta.append(el("span", { className: "chip blocked", textContent: "blocked" }));
  if (isOverdue(t)) meta.append(el("span", { className: "chip overdue", textContent: `overdue ${t.due}` }));
  else if (t.due) meta.append(el("span", { className: "chip", textContent: `due ${t.due}` }));
  if (t.ref) meta.append(el("span", { className: "chip ref", textContent: t.ref }));

  if (t.detail) {
    const detail = el("div", { className: "t-detail", textContent: t.detail });
    detail.style.display = "none";
    const more = el("button", { className: "btn sm", textContent: "notes" });
    more.onclick = () => { detail.style.display = detail.style.display === "none" ? "" : "none"; };
    meta.append(more);
    body.append(meta, detail);
  } else {
    body.append(meta);
  }

  const actions = el("div", { className: "t-actions" });
  const cycle = el("button", { className: "btn sm", textContent: "status" });
  cycle.onclick = async () => {
    const order = ["todo", "doing", "blocked", "done"];
    await window.delphi.tasks.update(t.id, { status: order[(order.indexOf(t.status) + 1) % order.length] });
    refresh();
  };
  const move = el("select", { className: "btn sm" });
  move.append(el("option", { value: "", textContent: "move…" }));
  state.projects.forEach((p) =>
    move.append(el("option", { value: String(p.id), textContent: p.name, selected: p.id === t.project_id })));
  move.onchange = async () => {
    if (move.value) { await window.delphi.tasks.update(t.id, { project_id: Number(move.value) }); refresh(); }
  };
  const del = el("button", { className: "btn sm", textContent: "×", title: "Delete" });
  del.onclick = async () => { await window.delphi.tasks.remove(t.id); refresh(); };
  actions.append(cycle, move, del);
  meta.append(actions);

  row.append(body);
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

  openSheet = { overlay, note, title, area, status };
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

$("new-project").onclick = async () => {
  const name = prompt("Project name");
  if (!name || !name.trim()) return;
  const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const palette = ["#4a63d8", "#e0803a", "#2f8757", "#a86fd1", "#c9546b", "#3fa7a1"];
  const created = await window.delphi.projects.create({
    key: key || `p${Date.now()}`,
    name: name.trim(),
    colour: palette[state.projects.length % palette.length],
  });
  state.projectId = created.id;
  state.view = "overview";
  refresh();
};

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
    if (openSheet) { closeNoteSheet(); return; }
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
// leave room for them.
window.delphi.onMode(({ panelMode }) => {
  document.body.classList.toggle("panel", panelMode);
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
