// Renderer. Talks to the main process through window.brain only.

const state = {
  projects: [],
  projectId: null,   // null means the All view
  tab: "tasks",
  showDone: false,
  query: "",
  tasks: [],
  notes: [],
  links: [],
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
  } else {
    state.tasks = await window.brain.tasks.list({
      projectId: state.projectId,
      includeDone: state.showDone,
    });
    state.notes = state.projectId ? await window.brain.notes.list(state.projectId) : [];
    state.links = state.projectId ? await window.brain.links.list(state.projectId) : [];
  }
  render();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderSidebar() {
  const box = $("projects");
  box.textContent = "";

  const allOpen = state.projects.reduce((n, p) => n + p.open_count, 0);
  box.append(projectRow({ id: null, name: "All", colour: "#7c8698", open_count: allOpen }));

  for (const p of state.projects) box.append(projectRow(p));
}

function projectRow(p) {
  const row = el("div", { className: "proj" + (state.projectId === p.id ? " active" : "") });
  row.append(el("span", { className: "dot", style: `background:${p.colour || "#7c8698"}` }));
  row.append(el("span", { className: "proj-name", textContent: p.name, title: p.summary || p.name }));
  if (p.open_count) row.append(el("span", { className: "count", textContent: String(p.open_count) }));
  row.onclick = () => {
    state.projectId = p.id;
    state.query = "";
    $("search").value = "";
    refresh();
  };
  return row;
}

function currentProject() {
  return state.projects.find((p) => p.id === state.projectId) || null;
}

function render() {
  renderSidebar();

  const p = currentProject();
  if (state.query) {
    $("title").textContent = `Search: ${state.query}`;
    $("subtitle").textContent = `${state.tasks.length} tasks, ${state.notes.length} memory notes`;
  } else if (p) {
    $("title").textContent = p.name;
    $("subtitle").textContent = p.summary || "";
  } else {
    $("title").textContent = "All projects";
    $("subtitle").textContent = "Everything open, across every project";
  }

  $("n-tasks").textContent = state.tasks.length ? String(state.tasks.length) : "";
  $("n-notes").textContent = state.notes.length ? String(state.notes.length) : "";
  $("n-links").textContent = state.links.length ? String(state.links.length) : "";

  // Links are per project, so hide that tab in the All view. History and
  // Settings are global and always available.
  const noProject = !state.projectId || !!state.query;
  document.querySelectorAll(".tab").forEach((t) => {
    t.style.display = t.dataset.tab === "links" && noProject ? "none" : "";
    t.classList.toggle("active", t.dataset.tab === state.tab);
  });

  const content = $("content");
  content.textContent = "";
  if (state.tab === "tasks") renderTasks(content);
  else if (state.tab === "notes") renderNotes(content);
  else if (state.tab === "links") renderLinks(content);
  else if (state.tab === "audit") renderAudit(content);
  else renderSettings(content);

  window.brain.stats().then((s) => {
    $("stats").textContent =
      `${s.open_tasks} open, ${s.overdue} overdue, ${s.notes} notes`;
  });
}

function renderTasks(root) {
  if (!state.query) {
    const input = el("input", { placeholder: "Add a task, then Enter", id: "quick" });
    input.onkeydown = async (e) => {
      if (e.key !== "Enter" || !input.value.trim()) return;
      // A bare "!" prefix marks it high priority, so the common case does not
      // need a trip to a dropdown.
      let title = input.value.trim();
      let priority = "med";
      if (title.startsWith("!")) {
        priority = "high";
        title = title.slice(1).trim();
      }
      const ref = (title.match(/\b(APPEALS-\d+)\b/i) || [])[1] || null;
      await window.brain.tasks.create({ projectId: state.projectId, title, priority, ref });
      input.value = "";
      refresh();
    };
    const toggle = el("button", {
      className: "btn sm",
      textContent: state.showDone ? "Hide done" : "Show done",
    });
    toggle.onclick = () => {
      state.showDone = !state.showDone;
      refresh();
    };
    root.append(el("div", { className: "add-row" }, input, toggle));
  }

  if (!state.tasks.length) {
    root.append(el("div", { className: "empty" }, state.query ? "Nothing matched." : "No open tasks here."));
    return;
  }

  for (const t of state.tasks) root.append(taskRow(t));
}

function taskRow(t) {
  const row = el("div", { className: "task" + (t.status === "done" ? " done" : "") });

  const check = el("div", { className: "check", textContent: "✓" });
  check.onclick = async () => {
    await window.brain.tasks.update(t.id, { status: t.status === "done" ? "todo" : "done" });
    refresh();
  };
  row.append(check);

  const body = el("div", { className: "t-body" });
  body.append(el("div", { className: "t-title", textContent: t.title }));

  const meta = el("div", { className: "t-meta" });
  if (!state.projectId && t.project_name) {
    const c = el("span", { className: "chip", textContent: t.project_name });
    c.style.color = t.project_colour || "";
    meta.append(c);
  }
  if (t.priority === "high") meta.append(el("span", { className: "chip high", textContent: "high" }));
  if (t.status === "doing") meta.append(el("span", { className: "chip doing", textContent: "doing" }));
  if (t.status === "blocked") meta.append(el("span", { className: "chip blocked", textContent: "blocked" }));
  if (isOverdue(t)) meta.append(el("span", { className: "chip overdue", textContent: `due ${t.due}` }));
  else if (t.due) meta.append(el("span", { className: "chip", textContent: `due ${t.due}` }));
  if (t.ref) meta.append(el("span", { className: "chip ref", textContent: t.ref }));
  if (t.legacy_id) meta.append(el("span", { className: "chip ref", textContent: t.legacy_id }));

  const actions = el("div", { className: "t-actions" });
  const cycle = el("button", { className: "btn sm", textContent: "status" });
  cycle.onclick = async () => {
    const order = ["todo", "doing", "blocked", "done"];
    const next = order[(order.indexOf(t.status) + 1) % order.length];
    await window.brain.tasks.update(t.id, { status: next });
    refresh();
  };
  const move = el("select", { className: "btn sm" });
  move.append(el("option", { value: "", textContent: "move to…" }));
  for (const p of state.projects) {
    move.append(el("option", { value: String(p.id), textContent: p.name, selected: p.id === t.project_id }));
  }
  move.onchange = async () => {
    if (!move.value) return;
    await window.brain.tasks.update(t.id, { project_id: Number(move.value) });
    refresh();
  };
  const del = el("button", { className: "btn sm", textContent: "×", title: "Delete" });
  del.onclick = async () => {
    await window.brain.tasks.remove(t.id);
    refresh();
  };
  actions.append(cycle, move, del);
  meta.append(actions);
  body.append(meta);

  if (t.detail) {
    const d = el("div", { className: "t-detail", textContent: t.detail });
    d.style.display = "none";
    const more = el("span", { className: "chip", textContent: "notes" });
    more.style.cursor = "default";
    more.onclick = () => {
      d.style.display = d.style.display === "none" ? "" : "none";
    };
    meta.insertBefore(more, actions);
    body.append(d);
  }

  row.append(body);
  return row;
}

function renderNotes(root) {
  if (!state.projectId && !state.query) {
    root.append(el("div", { className: "empty" }, "Pick a project to see its memory."));
    return;
  }

  if (state.projectId) {
    const title = el("input", { placeholder: "New memory note title, then Enter" });
    title.onkeydown = async (e) => {
      if (e.key !== "Enter" || !title.value.trim()) return;
      await window.brain.notes.create({ projectId: state.projectId, title: title.value.trim() });
      title.value = "";
      refresh();
    };
    root.append(el("div", { className: "add-row" }, title));
  }

  if (!state.notes.length) {
    root.append(
      el("div", { className: "empty" },
        "Nothing stored yet. This is where decisions, gotchas and things worth remembering live.")
    );
    return;
  }

  for (const n of state.notes) root.append(noteCard(n));
}

function noteCard(n) {
  const card = el("div", { className: "note" });

  const head = el("h3");
  const pin = el("span", { textContent: n.pinned ? "★" : "☆", title: "Pin" });
  pin.style.cursor = "default";
  pin.style.color = n.pinned ? "var(--med)" : "var(--ink-faint)";
  pin.onclick = async () => {
    await window.brain.notes.update(n.id, { pinned: n.pinned ? 0 : 1 });
    refresh();
  };
  head.append(pin);

  const titleInput = el("input", { value: n.title });
  titleInput.style.border = "1px solid transparent";
  titleInput.style.fontWeight = "600";
  titleInput.onblur = async () => {
    if (titleInput.value !== n.title) {
      await window.brain.notes.update(n.id, { title: titleInput.value });
      refresh();
    }
  };
  head.append(titleInput);

  const kind = el("select");
  for (const k of ["note", "decision", "gotcha", "reference", "contact"]) {
    kind.append(el("option", { value: k, textContent: k, selected: k === n.kind }));
  }
  kind.className = "btn sm";
  kind.onchange = () => window.brain.notes.update(n.id, { kind: kind.value }).then(refresh);
  head.append(kind);

  const del = el("button", { className: "btn sm", textContent: "×" });
  del.onclick = async () => {
    await window.brain.notes.remove(n.id);
    refresh();
  };
  head.append(del);
  card.append(head);

  const body = el("textarea", { value: n.body, rows: Math.min(14, Math.max(3, n.body.split("\n").length + 1)) });
  body.placeholder = "What is worth remembering here…";
  body.onblur = async () => {
    if (body.value !== n.body) {
      await window.brain.notes.update(n.id, { body: body.value });
      n.body = body.value;
    }
  };
  card.append(body);
  return card;
}

function renderLinks(root) {
  if (!state.projectId) {
    root.append(el("div", { className: "empty" }, "Pick a project to see its links."));
    return;
  }
  const label = el("input", { placeholder: "Label" });
  const url = el("input", { placeholder: "https://…" });
  const add = el("button", { className: "btn sm", textContent: "Add" });
  add.onclick = async () => {
    if (!label.value.trim() || !url.value.trim()) return;
    const kind = /pull\/\d+/.test(url.value) ? "pr" : /jira|APPEALS-/i.test(url.value) ? "jira" : "link";
    await window.brain.links.create({
      projectId: state.projectId, label: label.value.trim(), url: url.value.trim(), kind,
    });
    label.value = url.value = "";
    refresh();
  };
  root.append(el("div", { className: "add-row" }, label, url, add));

  if (!state.links.length) {
    root.append(el("div", { className: "empty" }, "No links yet. Pull requests, tickets, dashboards."));
    return;
  }

  for (const l of state.links) {
    const row = el("div", { className: "link-row" });
    row.append(el("span", { className: "chip", textContent: l.kind }));
    const a = el("a", { href: "#", textContent: l.label, className: "grow" });
    a.onclick = (e) => {
      e.preventDefault();
      window.brain.openExternal(l.url);
    };
    row.append(a);
    const del = el("button", { className: "btn sm", textContent: "×" });
    del.onclick = async () => {
      await window.brain.links.remove(l.id);
      refresh();
    };
    row.append(del);
    root.append(row);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    state.tab = tab.dataset.tab;
    render();
  };
});

let searchTimer;
$("search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value;
  // Debounced so typing does not fire a query per keystroke.
  searchTimer = setTimeout(() => {
    state.query = v.trim();
    if (state.query) state.tab = "tasks";
    refresh();
  }, 140);
});

$("new-project").onclick = async () => {
  const name = prompt("Project name");
  if (!name || !name.trim()) return;
  const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const palette = ["#4f8ef7", "#e0803a", "#57a773", "#a86fd1", "#c9546b", "#3fa7a1"];
  await window.brain.projects.create({
    key: key || `p${Date.now()}`,
    name: name.trim(),
    colour: palette[state.projects.length % palette.length],
  });
  refresh();
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if ($("search").value) {
      $("search").value = "";
      state.query = "";
      refresh();
      return;
    }
    window.brain.hide();
  }
  // Cmd+F focuses search, matching the shortcut people already have in their hands.
  if ((e.metaKey || e.ctrlKey) && e.key === "f") {
    e.preventDefault();
    $("search").focus();
    $("search").select();
  }
});

// Re-read on every show, so the panel never displays stale data after work
// happened elsewhere, for instance a task added from a script.
window.brain.onShown(() => {
  refresh();
  $("search").focus();
});

refresh();


// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

async function renderAudit(root) {
  const bar = el("div", { className: "add-row" });
  const undo1 = el("button", { className: "btn sm", textContent: "Undo last change" });
  const undo5 = el("button", { className: "btn sm", textContent: "Undo last 5" });
  const msg = el("span", { className: "hint" });
  const runUndo = async (n) => {
    try {
      const done = await window.brain.audit.undoLast(n);
      msg.className = "ok-msg";
      msg.textContent = done ? `Reversed ${done} change${done === 1 ? "" : "s"}.` : "Nothing left to undo.";
    } catch (e) {
      msg.className = "err-msg";
      msg.textContent = e.message;
    }
    refresh();
  };
  undo1.onclick = () => runUndo(1);
  undo5.onclick = () => runUndo(5);
  bar.append(undo1, undo5, msg);
  root.append(bar);

  const entries = await window.brain.audit.list(200);
  if (!entries.length) {
    root.append(el("div", { className: "empty" },
      "No changes recorded yet. Everything you do from here on is logged and reversible."));
    return;
  }

  for (const e of entries) {
    const row = el("div", { className: "audit-row" + (e.undone ? " undone" : "") });
    row.append(el("span", { className: "audit-when", textContent: e.at }));

    const what = el("div", { className: "audit-what" });
    what.append(el("span", { textContent: `${e.entity} ${e.summary}` }));
    if (e.label) what.append(el("div", { className: "lbl", textContent: e.label.slice(0, 110) }));
    row.append(what);

    if (e.undone) {
      row.append(el("span", { className: "chip", textContent: "undone" }));
    } else {
      const b = el("button", { className: "btn sm", textContent: "undo" });
      b.onclick = async () => {
        try {
          await window.brain.audit.undo(e.id);
        } catch (err) {
          alert(err.message);
        }
        refresh();
      };
      row.append(b);
    }
    root.append(row);
  }
}

// ---------------------------------------------------------------------------
// Settings, including the hotkey recorder
// ---------------------------------------------------------------------------

// Electron accelerators use these names rather than the browser's key values.
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
  else if (/^F\d{1,2}$/.test(key)) key = key;
  else if (key === "ArrowUp") key = "Up";
  else if (key === "ArrowDown") key = "Down";
  else if (key === "ArrowLeft") key = "Left";
  else if (key === "ArrowRight") key = "Right";
  else if (key.length === 1) key = key.toUpperCase();

  return { parts, key };
}

async function renderSettings(root) {
  const settings = await window.brain.settings.get();

  // --- hotkey ---
  const block = el("div", { className: "setting-block" });
  block.append(el("h3", { textContent: "Show and hide shortcut" }));
  block.append(el("p", {
    textContent:
      "Click the box, then press the combination you want. It is registered straight away, " +
      "and if another application already owns it you are told rather than left wondering.",
  }));

  const rec = el("div", { className: "recorder" });
  const keys = el("div", { className: "keys" });
  const status = el("div", { className: "hint", textContent: "Click to record" });

  const paint = (accel) => {
    keys.textContent = "";
    for (const part of accel.split("+")) {
      keys.append(el("span", { className: "key", textContent: partLabel(part) }));
    }
  };
  paint(settings.hotkey);
  rec.append(keys, status);

  let armed = false;
  const stop = () => {
    armed = false;
    rec.classList.remove("armed");
    status.textContent = "Click to record";
    document.removeEventListener("keydown", onKey, true);
  };

  const onKey = async (event) => {
    if (!armed) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      paint(settings.hotkey);
      stop();
      return;
    }

    const { parts, key } = toAccelerator(event);
    if (!key) {
      // Modifiers alone: show them building up so it feels responsive.
      keys.textContent = "";
      for (const p of parts) keys.append(el("span", { className: "key", textContent: partLabel(p) }));
      return;
    }
    if (!parts.length) {
      status.className = "err-msg";
      status.textContent = "Needs at least one modifier, otherwise it would fire while typing.";
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

  rec.onclick = () => {
    if (armed) return stop();
    armed = true;
    rec.classList.add("armed");
    status.className = "hint";
    status.textContent = "Listening. Press a combination, or Escape to cancel.";
    document.addEventListener("keydown", onKey, true);
  };

  block.append(rec);
  root.append(block);

  // --- mouse buttons ---
  const mouse = el("div", { className: "setting-block" });
  mouse.append(el("h3", { textContent: "Using a mouse button" }));
  mouse.append(el("p", {
    textContent:
      "A global shortcut can only be a keyboard combination, so a mouse button cannot be bound here " +
      "directly. Do it the other way round: in your mouse software, map the side button to send the " +
      "combination above. The panel cannot tell the difference, so the button then works exactly like " +
      "pressing the keys. Logitech Options, SteerMouse and Razer Synapse all do this.",
  }));
  root.append(mouse);

  // --- where things live ---
  const info = el("div", { className: "setting-block" });
  info.append(el("h3", { textContent: "Where your data lives" }));
  const list = el("p");
  list.append(el("span", { textContent: "Database: ~/va/brain/brain.db" }), el("br"),
              el("span", { textContent: "Settings: ~/va/brain/settings.json" }), el("br"),
              el("span", { textContent: "Every change is recorded on the History tab and can be reversed." }));
  info.append(list);
  root.append(info);
}

function partLabel(part) {
  return { Control: "control", Alt: "option", Shift: "shift", Command: "command", Space: "space" }[part] || part;
}
