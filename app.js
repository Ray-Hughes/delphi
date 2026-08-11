// Renderer. Talks to the main process through window.brain only.

const state = {
  projects: [],
  projectId: null,     // null means the All view
  view: "tasks",       // overview | tasks | notes | links | history | settings
  showDone: false,
  query: "",
  tasks: [],
  notes: [],
  links: [],
  repos: [],
  allTasks: [],
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
  state.projects = await window.brain.projects.list();

  if (state.query) {
    const { tasks, notes } = await window.brain.search(state.query);
    state.tasks = tasks;
    state.notes = notes;
    state.links = [];
    state.repos = [];
  } else {
    state.allTasks = await window.brain.tasks.list({
      projectId: state.projectId,
      includeDone: true,
    });
    state.tasks = state.showDone
      ? state.allTasks
      : state.allTasks.filter((t) => t.status !== "done");
    if (state.projectId) {
      state.notes = await window.brain.notes.list(state.projectId);
      state.links = await window.brain.links.list(state.projectId);
      state.repos = await window.brain.repos.list(state.projectId);
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
    state.projectId = p.id;
    // Landing on a project shows its dashboard; All has no dashboard to show.
    state.view = p.id ? "overview" : "tasks";
    state.query = "";
    $("search").value = "";
    refresh();
  };
  row.onclick = go;
  row.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
  return row;
}

function renderTabs() {
  const box = $("tabs");
  box.textContent = "";

  const tabs = state.query
    ? [["tasks", "Results", state.tasks.length + state.notes.length]]
    : state.projectId
    ? [["overview", "Overview"], ["tasks", "Tasks", state.tasks.length],
       ["notes", "Memory", state.notes.length], ["links", "Links", state.links.length]]
    : [["tasks", "Tasks", state.tasks.length], ["history", "History"], ["settings", "Settings"]];

  for (const [key, label, count] of tabs) {
    const tab = el("div", { className: "tab" + (state.view === key ? " active" : ""), tabIndex: 0, role: "tab" });
    tab.append(label);
    if (count) tab.append(el("span", { className: "n", textContent: String(count) }));
    const go = () => { state.view = key; render(); };
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
    ? ["tasks"]
    : state.projectId
    ? ["overview", "tasks", "notes", "links"]
    : ["tasks", "history", "settings"];
  if (!valid.includes(state.view)) state.view = valid[0];

  renderMetrics();
  renderTabs();

  const content = $("content");
  content.textContent = "";
  const view = ({
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
  const stat = (value, label, tone) =>
    el("div", { className: "stat" + (tone ? ` ${tone}` : "") },
      el("div", { className: "v", textContent: String(value) }),
      el("div", { className: "k", textContent: label }));
  stats.append(
    stat(open.length, "Open"),
    stat(doing, "In progress", doing ? "good" : null),
    stat(blocked, "Blocked", blocked ? "warn" : null),
    stat(overdue, "Overdue", overdue ? "crit" : null),
    stat(state.notes.length, "Memory"),
    stat(done, "Done")
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
      link.onclick = (e) => { e.preventDefault(); state.view = "tasks"; render(); };
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
      link.onclick = (e) => { e.preventDefault(); state.view = "notes"; render(); };
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
    await window.brain.repos.create({
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
        mk.onclick = async () => { await window.brain.repos.setPrimary(r.id); refresh(); };
        row.append(mk);
      }
      const rm = el("button", { className: "btn sm", textContent: "Remove" });
      rm.onclick = async () => { await window.brain.repos.remove(r.id); refresh(); };
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
      a.onclick = (e) => { e.preventDefault(); window.brain.openExternal(l.url); };
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
      await window.brain.projects.update(project.id, { name: nameInput.value.trim() });
      refresh();
    }
  };
  kv.append(el("dt", { textContent: "Name" }), el("dd", {}, nameInput));

  const sumInput = el("input", { className: "field", value: project.summary || "" , placeholder: "One line: what this project is" });
  sumInput.onblur = async () => {
    if (sumInput.value !== (project.summary || "")) {
      await window.brain.projects.update(project.id, { summary: sumInput.value.trim() });
      refresh();
    }
  };
  kv.append(el("dt", { textContent: "Summary" }), el("dd", {}, sumInput));

  const statusSel = el("select", { className: "field" });
  for (const s of ["active", "paused", "blocked", "done", "archived"]) {
    statusSel.append(el("option", { value: s, textContent: s, selected: s === project.status }));
  }
  statusSel.onchange = async () => {
    await window.brain.projects.update(project.id, { status: statusSel.value });
    if (statusSel.value === "archived") { state.projectId = null; state.view = "tasks"; }
    refresh();
  };
  kv.append(el("dt", { textContent: "Status" }), el("dd", {}, statusSel));

  const colour = el("input", { type: "color", className: "field", value: project.colour || "#8d97a9", style: "height:34px; padding:2px" });
  colour.onchange = async () => {
    await window.brain.projects.update(project.id, { colour: colour.value });
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

function renderTasks(root) {
  if (!state.query) {
    const input = el("input", { className: "field", placeholder: "Add a task and press Enter. Start with ! for high priority." });
    input.onkeydown = async (e) => {
      if (e.key !== "Enter" || !input.value.trim()) return;
      let title = input.value.trim();
      let priority = "med";
      if (title.startsWith("!")) { priority = "high"; title = title.slice(1).trim(); }
      const ref = (title.match(/\b([A-Z][A-Z0-9]+-\d+)\b/) || [])[1] || null;
      await window.brain.tasks.create({ projectId: state.projectId, title, priority, ref });
      input.value = "";
      refresh();
    };
    const toggle = el("button", { className: "btn", textContent: state.showDone ? "Hide done" : "Show done" });
    toggle.onclick = () => { state.showDone = !state.showDone; refresh(); };
    root.append(el("div", { className: "add-row" }, input, toggle));
  }

  if (!state.tasks.length) {
    root.append(emptyState(
      state.query ? "Nothing matched" : "No open tasks",
      state.query ? "Try a different word." : "Add one above."));
    return;
  }

  const list = el("section", { className: "card" });
  state.tasks.forEach((t) => list.append(taskRow(t)));
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
    await window.brain.tasks.update(t.id, { status: t.status === "done" ? "todo" : "done" });
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
    await window.brain.tasks.update(t.id, { status: order[(order.indexOf(t.status) + 1) % order.length] });
    refresh();
  };
  const move = el("select", { className: "btn sm" });
  move.append(el("option", { value: "", textContent: "move…" }));
  state.projects.forEach((p) =>
    move.append(el("option", { value: String(p.id), textContent: p.name, selected: p.id === t.project_id })));
  move.onchange = async () => {
    if (move.value) { await window.brain.tasks.update(t.id, { project_id: Number(move.value) }); refresh(); }
  };
  const del = el("button", { className: "btn sm", textContent: "×", title: "Delete" });
  del.onclick = async () => { await window.brain.tasks.remove(t.id); refresh(); };
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
    await window.brain.notes.create({ projectId: state.projectId, title: title.value.trim() });
    title.value = "";
    refresh();
  };
  root.append(el("div", { className: "add-row" }, title));

  if (!state.notes.length) {
    root.append(emptyState("Nothing stored yet",
      "This is for decisions and why the alternative was rejected, traps that cost time, and values that are hard to look up again."));
    return;
  }
  state.notes.forEach((n) => root.append(noteCard(n)));
}

function noteCard(n) {
  const wrap = el("article", { className: "note" });
  const head = el("div", { className: "note-head" });

  const pin = el("button", { className: "btn sm", textContent: n.pinned ? "★" : "☆", title: "Pin" });
  pin.onclick = async () => { await window.brain.notes.update(n.id, { pinned: n.pinned ? 0 : 1 }); refresh(); };
  head.append(pin);

  const titleInput = el("input", { value: n.title });
  titleInput.onblur = async () => {
    if (titleInput.value.trim() && titleInput.value !== n.title) {
      await window.brain.notes.update(n.id, { title: titleInput.value.trim() });
      refresh();
    }
  };
  head.append(titleInput);

  const kind = el("select", { className: "btn sm" });
  ["note", "decision", "gotcha", "reference", "contact"].forEach((k) =>
    kind.append(el("option", { value: k, textContent: k, selected: k === n.kind })));
  kind.onchange = async () => { await window.brain.notes.update(n.id, { kind: kind.value }); refresh(); };
  head.append(kind);

  const del = el("button", { className: "btn sm", textContent: "×", title: "Delete" });
  del.onclick = async () => { await window.brain.notes.remove(n.id); refresh(); };
  head.append(del);
  wrap.append(head);

  const body = el("textarea", {
    className: "field",
    value: n.body,
    rows: Math.min(18, Math.max(4, (n.body || "").split("\n").length + 1)),
    placeholder: "What is worth remembering here",
  });
  body.onblur = async () => {
    if (body.value !== n.body) { await window.brain.notes.update(n.id, { body: body.value }); n.body = body.value; }
  };
  wrap.append(el("div", { className: "note-body" }, body));
  return wrap;
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
    await window.brain.links.create({ projectId: state.projectId, label: label.value.trim(), url: url.value.trim(), kind });
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
    a.onclick = (e) => { e.preventDefault(); window.brain.openExternal(l.url); };
    row.append(a, el("span", { className: "mono", textContent: l.url.slice(0, 46) }));
    const del = el("button", { className: "btn sm", textContent: "×" });
    del.onclick = async () => { await window.brain.links.remove(l.id); refresh(); };
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
        const done = await window.brain.audit.undoLast(n);
        msg.className = "ok-msg";
        msg.textContent = done ? `Reversed ${plural(done, "change", "changes")}.` : "Nothing left to undo.";
      } catch (e) { msg.className = "err-msg"; msg.textContent = e.message; }
      refresh();
    };
    return b;
  };
  bar.append(undo(1, "Undo last change"), undo(5, "Undo last 5"), msg);
  root.append(bar);

  const entries = await window.brain.audit.list(200);
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
        try { await window.brain.audit.undo(e.id); } catch (err) { alert(err.message); }
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
  const settings = await window.brain.settings.get();

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
      await window.brain.settings.setHotkey(accel);
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
      await window.brain.settings.set({ panelMode: box.checked });
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
        const updated = await window.brain.settings.set({ [key]: Number(input.value) });
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
  openBtn.onclick = () => window.brain.vault.reveal();
  exportBtn.onclick = async () => {
    try {
      const r = await window.brain.vault.export();
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
  dl.append(el("dt", { textContent: "Database" }), el("dd", {}, el("span", { className: "mono", textContent: "~/va/brain/brain.db" })));
  dl.append(el("dt", { textContent: "Settings" }), el("dd", {}, el("span", { className: "mono", textContent: "~/va/brain/settings.json" })));
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
    if (state.query) state.view = "tasks";
    else state.view = state.projectId ? "overview" : "tasks";
    refresh();
  }, 140);
});

$("new-project").onclick = async () => {
  const name = prompt("Project name");
  if (!name || !name.trim()) return;
  const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const palette = ["#4a63d8", "#e0803a", "#2f8757", "#a86fd1", "#c9546b", "#3fa7a1"];
  const created = await window.brain.projects.create({
    key: key || `p${Date.now()}`,
    name: name.trim(),
    colour: palette[state.projects.length % palette.length],
  });
  state.projectId = created.id;
  state.view = "overview";
  refresh();
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if ($("search").value) {
      $("search").value = "";
      state.query = "";
      state.view = state.projectId ? "overview" : "tasks";
      refresh();
      return;
    }
    window.brain.hide();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "f") {
    e.preventDefault();
    $("search").focus();
    $("search").select();
  }
});

// Frameless panel mode has no traffic lights, so the title bar does not need to
// leave room for them.
window.brain.onMode(({ panelMode }) => {
  document.body.classList.toggle("panel", panelMode);
});

window.brain.onShown(() => { refresh(); $("search").focus(); });
window.brain.onAlertsChanged(() => refresh());
window.brain.onFocusTask(({ projectId }) => {
  if (projectId) { state.projectId = projectId; state.view = "tasks"; }
  refresh();
});

refresh();
