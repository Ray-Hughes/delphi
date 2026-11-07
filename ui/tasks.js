// The Tasks tab: quick entry, inline edit, subtask pills, and List or Kanban.
//
// Direction B's task list. Top to bottom:
//   - a toolbar: a filter field, Display (Shift+V) and the List / Kanban switch
//   - quick entry (Cmd+N lands here): Enter files the task and leaves you in
//     the field for the next one, with no dialog and no navigation
//   - the list, grouped by project in All projects and by status in a project,
//     or the same tasks as Kanban columns, one per status
//
// A row is what you scan for. Hovering it shows a pencil, and the pencil (or E
// with the row highlighted) turns the row into its own editor: title, status
// and priority in place, Enter saves, Esc puts it back. A task with subtasks
// carries a "2/4" pill that opens a checklist under the row, ticked in place.
//
// Only list and board are drawn here. Search results and a project set to
// Table or Calendar still go to app.js's renderTasks, which owns those, so
// nothing that worked before is gone (owns() below says which is which).
//
// Speed: the list is painted in chunks. The first CHUNK rows go in at once and
// the rest follow as the end comes near, so 2,000 tasks cost what 150 do, and
// filtering repaints the list box rather than the whole window. An inline
// save patches the one row unless the task has to move to another group.
//
// The rules that decide anything (parsing a quick entry, what an edit
// changes, what a pill says, what a drop writes, how tasks are grouped and
// ordered) are plain functions at the top, exported for tools/tasks_test.js.

globalThis.DelphiTasks = (() => {
  // -------------------------------------------------------------------------
  // The rules, with no DOM

  const STATUSES = [["todo", "To do"], ["doing", "In progress"], ["blocked", "Blocked"], ["done", "Done"]];
  const STATUS_LABEL = new Map(STATUSES);
  const KNOWN = new Set(STATUSES.map(([s]) => s));
  /** A status this version cannot name reads as in progress, as everywhere else (app.js statusOf). */
  const statusOf = (t) => (KNOWN.has(t && t.status) ? t.status : "doing");
  const PRIORITIES = [["high", "High"], ["med", "Medium"], ["low", "Low"]];
  const PRI_LABEL = new Map(PRIORITIES);
  const PRI = { high: 0, med: 1, low: 2 };
  const priOf = (t) => (t && PRI[t.priority] != null ? t.priority : "med");

  /**
   * A quick entry, read the way the old composer read it (a leading "!" is
   * high, and an issue key such as APPEALS-123 is kept as the ref) plus what
   * Today's capture reads: !high, !med or !low anywhere, and @who.
   */
  function parseQuick(text) {
    let s = String(text == null ? "" : text).trim();
    let priority = "med";
    let assignee = null;
    if (s.startsWith("!") && !/^!(high|med|medium|low)(?=\s|$)/i.test(s)) { priority = "high"; s = s.slice(1).trim(); }
    // Followed by a space or the end, so "!low-level bug" is a title, not a priority.
    s = s.replace(/(^|\s)!(high|medium|med|low)(?=\s|$)/gi, (m, sp, p) => { const v = p.toLowerCase(); priority = v === "medium" ? "med" : v; return sp; })
      .replace(/(^|\s)@([\w:.-]+)/g, (m, sp, who) => { assignee = who; return sp; })
      .replace(/\s+/g, " ").trim();
    const ref = (s.match(/\b([A-Z][A-Z0-9]+-\d+)\b/) || [])[1] || null;
    return { title: s, priority, assignee, ref };
  }

  /** The three fields the editor holds, as the editor would show them for a task. */
  const baseOf = (t) => ({ title: String((t && t.title) || ""), status: statusOf(t), priority: priOf(t) });

  /**
   * What an inline edit changes, as the fields to send, or null for nothing.
   * Compared with `base`, the task as it was when the editor opened, never
   * with the row as it is now: an agent that retitled the task or moved its
   * status meanwhile keeps its change unless this edit touched that same
   * field. So a status this version shows as In progress (In review, written
   * by a newer Delphi) is never rewritten as doing because the row was opened
   * and saved, and an untouched title is never re-trimmed.
   */
  function editPatch(task, draft, base = baseOf(task)) {
    const out = {};
    const title = String(draft.title == null ? base.title : draft.title).trim();
    if (!title) return { error: "A task needs a title." };
    if (title !== String(base.title || "").trim()) out.title = title;
    if (draft.status && KNOWN.has(draft.status) && draft.status !== base.status) out.status = draft.status;
    if (draft.priority && PRI[draft.priority] != null && draft.priority !== base.priority) out.priority = draft.priority;
    return { patch: Object.keys(out).length ? out : null };
  }

  /** The pill a task with subtasks carries: "2/4", and how far along. Null without subtasks. */
  function pillOf(t) {
    const total = Math.max(0, Number(t && t.subtask_count) || 0);
    if (!total) return null;
    const done = Math.max(0, Math.min(total, Number(t.subtask_done) || 0));
    return { done, total, text: `${done}/${total}`, complete: done === total, ratio: done / total,
      label: `${done} of ${total} subtasks done` };
  }

  /** Ticking a subtask in the checklist: its next status, and the parent's new done count. */
  function toggleSub(parent, sub) {
    const status = sub.status === "done" ? "todo" : "done";
    const total = Math.max(0, Number(parent.subtask_count) || 0);
    const was = Math.max(0, Math.min(total, Number(parent.subtask_done) || 0));
    const subtask_done = Math.max(0, Math.min(total, was + (status === "done" ? 1 : -1)));
    return { status, subtask_done };
  }

  /**
   * What dropping a card on a column writes, or null. The board's rule since
   * before Kanban had a name: a column is a status, and dropping a card where
   * it already is writes nothing. "Already is" is the column it is drawn in,
   * so a status this version cannot name, drawn under In progress, is not
   * flattened to doing by being dropped back on In progress.
   */
  function dropPatch(task, column) {
    if (!task || !KNOWN.has(column)) return null;
    if (statusOf(task) === column) return null;
    return { status: column };
  }

  const PROPS = [
    ["id", "ID"], ["priority", "Priority"], ["status", "Status"], ["subtasks", "Subtasks"],
    ["project", "Project"], ["ref", "Ref"], ["due", "Due"], ["age", "Age"], ["assignee", "Assignee"],
  ];
  const GROUPS = { project: "Project", status: "Status", priority: "Priority", epic: "Epic", none: "No grouping" };
  const ORDERS = { activity: "Latest activity", priority: "Priority", created: "Newest first", due: "Due date", title: "Title" };
  const allProps = () => Object.fromEntries(PROPS.map(([k]) => [k, true]));
  // All projects reads as a feed, newest activity first; a project reads as
  // its own board, by status and then priority.
  const DEFAULTS = {
    global: { group: "project", order: "activity", showDone: false, props: { ...allProps(), ref: false } },
    project: { group: "status", order: "priority", showDone: false, props: { ...allProps(), project: false, ref: false } },
  };

  /** Stored display options made safe: an unknown or missing value takes the default. */
  function normalise(raw, scope) {
    const base = DEFAULTS[scope] || DEFAULTS.global;
    const o = raw && typeof raw === "object" ? raw : {};
    const props = { ...base.props };
    if (o.props && typeof o.props === "object") for (const [k] of PROPS) if (typeof o.props[k] === "boolean") props[k] = o.props[k];
    return {
      group: GROUPS[o.group] ? o.group : base.group,
      order: ORDERS[o.order] ? o.order : base.order,
      showDone: typeof o.showDone === "boolean" ? o.showDone : base.showDone,
      props,
    };
  }

  // Remembered, because sorting 2,000 tasks by activity reads each stamp a
  // dozen times and the parse was most of the cost.
  const stamps = new Map();
  const stampMs = (s) => {
    if (!s) return NaN;
    const text = String(s);
    let ms = stamps.get(text);
    if (ms === undefined) {
      ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(" ", "T")}Z`);
      if (stamps.size > 20000) stamps.clear();
      stamps.set(text, ms);
    }
    return ms;
  };
  /** Whole days since the task last changed, for the age column. */
  const ageDays = (t, now = Date.now()) => {
    const ms = stampMs(t.updated_at || t.created_at);
    return Number.isFinite(ms) ? Math.max(0, Math.floor((now - ms) / 86400000)) : null;
  };

  const COMPARE = {
    priority: (a, b) => PRI[priOf(a)] - PRI[priOf(b)] || String(a.due || "9999").localeCompare(String(b.due || "9999")) || b.id - a.id,
    activity: (a, b) => (stampMs(b.updated_at) || 0) - (stampMs(a.updated_at) || 0) || b.id - a.id,
    created: (a, b) => b.id - a.id,
    due: (a, b) => String(a.due || "9999").localeCompare(String(b.due || "9999")) || PRI[priOf(a)] - PRI[priOf(b)] || b.id - a.id,
    title: (a, b) => String(a.title || "").localeCompare(String(b.title || ""), undefined, { sensitivity: "base" }) || b.id - a.id,
  };

  /** Whether a task matches the filter field: words in the title, a #number, or the ref. */
  function matches(t, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return true;
    const hay = `#${t.id} ${t.title || ""} ${t.ref || ""} ${t.assignee || ""}`.toLowerCase();
    // "#6" is task 6, not the start of #60.
    return q.split(/\s+/).every((w) => (/^#\d+$/.test(w) ? w === `#${t.id}` : hay.includes(w)));
  }

  // The four filters the metrics strip sets (state.taskFilter), as app.js reads them.
  const TASK_FILTERS = {
    doing: [(t) => statusOf(t) === "doing", "in progress"],
    blocked: [(t) => t.status === "blocked", "blocked"],
    overdue: [(t, ctx) => Boolean(ctx.isOverdue && ctx.isOverdue(t)), "overdue"],
    done: [(t) => t.status === "done", "done"],
  };

  const STATUS_ORDER = ["doing", "blocked", "todo", "done"];

  /**
   * The tasks as groups, in the order they are drawn: [{ key, label, tasks }].
   * Done tasks are left out unless asked for, except under status grouping,
   * where they make the Done group (drawn folded).
   */
  function arrange(tasks, opts, ctx = {}) {
    const filter = ctx.taskFilter && TASK_FILTERS[ctx.taskFilter];
    const keepDone = opts.group === "status" || opts.showDone || ctx.taskFilter === "done";
    const shown = [];
    for (const t of tasks) {
      if (t.parent_id) continue;
      if (!keepDone && t.status === "done") continue;
      if (filter && !filter[0](t, ctx)) continue;
      if (!matches(t, ctx.query)) continue;
      shown.push(t);
    }
    shown.sort(COMPARE[opts.order] || COMPARE.priority);
    const by = new Map();
    const put = (key, make, t) => {
      let g = by.get(key);
      if (!g) { g = make(); g.tasks = []; by.set(key, g); }
      g.tasks.push(t);
    };
    for (const t of shown) {
      if (opts.group === "project") {
        const key = t.project_id == null ? "none" : `p${t.project_id}`;
        put(key, () => ({ key, kind: "project", projectId: t.project_id ?? null, label: t.project_name || "No project", colour: t.project_colour || null }), t);
      } else if (opts.group === "status") {
        const s = statusOf(t);
        put(s, () => ({ key: s, kind: "status", status: s, label: STATUS_LABEL.get(s) }), t);
      } else if (opts.group === "priority") {
        const p = priOf(t);
        put(p, () => ({ key: p, kind: "priority", priority: p, label: PRI_LABEL.get(p) }), t);
      } else if (opts.group === "epic") {
        const key = t.organizer_id == null ? "none" : `e${t.organizer_id}`;
        put(key, () => ({ key, kind: "epic", label: t.organizer_name || "No epic", colour: t.organizer_colour || null }), t);
      } else {
        put("all", () => ({ key: "all", kind: "none", label: null }), t);
      }
    }
    const groups = [...by.values()];
    if (opts.group === "status") groups.sort((a, b) => STATUS_ORDER.indexOf(a.key) - STATUS_ORDER.indexOf(b.key));
    else if (opts.group === "priority") groups.sort((a, b) => PRI[a.key] - PRI[b.key]);
    else if (opts.group === "project" || opts.group === "epic") {
      // The project last touched comes first, so the feed reads newest first
      // across projects too; the leftovers ("No project") go last.
      const latest = (g) => Math.max(...g.tasks.map((t) => stampMs(t.updated_at) || 0));
      const at = new Map(groups.map((g) => [g.key, latest(g)]));
      groups.sort((a, b) => (a.key === "none") - (b.key === "none") || at.get(b.key) - at.get(a.key) || String(a.label).localeCompare(String(b.label)));
    }
    return groups;
  }

  /** The Kanban columns: always the four statuses, in board order, empty ones kept. */
  function columns(tasks, opts, ctx = {}) {
    const groups = arrange(tasks, { ...opts, group: "status" }, ctx);
    const by = new Map(groups.map((g) => [g.key, g.tasks]));
    return STATUSES.map(([status, label]) => ({ key: status, status, label, tasks: by.get(status) || [] }));
  }

  /** Two letters for an avatar: "Raymond Hughes" is RH, "claude-code" is CC, "codex" is Co. */
  function initials(name) {
    const parts = String(name || "").split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
    return parts[0].slice(0, 1).toUpperCase() + parts[0].slice(1, 2).toLowerCase();
  }

  // Edit this page (ui/layout.js): the toolbar and quick entry are the top of
  // the page, the list its body. The list cannot be hidden, since it is the
  // page. Scoped, so a project can keep its own arrangement over the global one.
  const LAYOUT = {
    id: "tasks", label: "Tasks", scoped: true,
    regions: [
      { id: "top", label: "Top", sections: [
        { id: "toolbar", label: "Filter and display", sizes: ["half", "two-thirds", "full"] },
        { id: "quick", label: "Quick entry", sizes: ["half", "two-thirds", "full"] },
      ] },
      { id: "body", label: "List", sections: [{ id: "list", label: "Task list", keep: true, sizes: ["full"] }] },
    ],
    presets: [
      { id: "default", label: "Default", desc: "The filter, then quick entry, then the list.", layout: {} },
      { id: "focus", label: "Focus", desc: "Just quick entry and the list.", layout: { hidden: ["toolbar"] } },
      { id: "compact", label: "Compact", desc: "Quick entry and the filter side by side, over the list.",
        layout: { regions: { top: ["quick", "toolbar"] }, sizes: { quick: "half", toolbar: "half" } } },
    ],
  };
  if (globalThis.DelphiLayout) DelphiLayout.register(LAYOUT);

  const pure = { STATUSES, PRIORITIES, PROPS, GROUPS, ORDERS, DEFAULTS, LAYOUT, statusOf, parseQuick, baseOf, editPatch, pillOf,
    toggleSub, dropPatch, normalise, arrange, columns, matches, ageDays, initials };
  if (typeof document === "undefined") return { pure };

  // -------------------------------------------------------------------------
  // State that outlives a repaint

  const I = (name, size) => DelphiIcons.icon(name, size);
  const CHUNK = 150;        // rows painted at once, then more as the end comes near
  const GROUP_PEEK = 5;     // rows a project shows in All projects before "N more"
  const CARD_CHUNK = 40;    // cards a column paints before "Show more"
  const DONE_CAP = 20;      // the Done column and group show the latest 20

  let app = null;
  let ctxNow = null;        // what the last render drew from
  let listBox = null;       // the element the list or board is painted into
  let filterText = "";
  let focusWas = null;      // which of this tab's fields had the focus, across a repaint
  let editing = null;       // { id, title, status, priority } while a row is its own editor
  let quickBusy = false;
  let quickMsg = null;
  let quickLive = null;     // { id, value }: what is in quick entry now, carried into a rebuilt field
  let adding = null;        // { status, text }: an open "add to this status" line, redrawn by a repaint
  let lastAdded = null;
  let doneOpen = false;
  let pop = null;           // the open Display popover
  let stuckWarm = false;
  const opened = new Set(); // groups opened past their peek, by key
  const expanded = new Set(); // tasks whose checklist is open
  const subsOf = new Map(); // their subtasks, as last read
  const ticking = new Set(); // subtasks whose tick is still being written

  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(`delphi.tasks.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(`delphi.tasks.${key}`, JSON.stringify(value)); } catch {} },
  };

  const scopeOf = (s) => (s.projectId ? "project" : "global");
  const displayOf = (s) => normalise(store.get(`display.${scopeOf(s)}`, null), scopeOf(s));
  const setDisplay = (s, next) => store.set(`display.${scopeOf(s)}`, next);

  /** "list" or "board" for the place on screen; a project keeps its own, All projects one of its own. */
  function modeOf(s) {
    if (s.projectId) {
      const p = app && app.projectById(s.projectId);
      return (p && p.task_view) || "list";
    }
    return store.get("mode.global", "list") === "board" ? "board" : "list";
  }

  /** Whether this module draws the Tasks tab for this state, or app.js's renderTasks does. */
  function owns(s) {
    if (!s || s.query || s.view !== "tasks") return false;
    return ["list", "board"].includes(modeOf(s));
  }

  async function setMode(mode) {
    const s = app.state();
    if (s.projectId) { await app.setProjectMode(mode); return; }
    store.set("mode.global", mode === "board" ? "board" : "list");
    app.repaint();
  }

  function init(lent) {
    app = lent;
    document.addEventListener("keydown", (e) => {
      // Shift+V, the display options, as in Linear. Only on this tab, never
      // while typing, and never over a panel, the bar or a menu.
      if (String(e.key).toLowerCase() !== "v" || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (!owns(app.state()) || app.busy()) return;
      e.preventDefault();
      if (pop) closePop(); else openPop();
    });
  }

  // -------------------------------------------------------------------------
  // Small pieces

  const errOf = (e) => String(e && e.message ? e.message : e);
  const button = (cls, props = {}, ...kids) => el("button", { className: cls, type: "button", ...props }, ...kids);
  const kbd = (text) => el("kbd", { className: "tk-kbd", textContent: text });

  /** The three bars Linear draws for priority, filled by how high. */
  function priBars(t) {
    const p = priOf(t);
    const n = { high: 3, med: 2, low: 1 }[p];
    const box = el("span", { className: `tk-pri p-${p}`, title: `${PRI_LABEL.get(p)} priority` });
    box.setAttribute("role", "img");
    box.setAttribute("aria-label", `${PRI_LABEL.get(p)} priority`);
    for (let i = 1; i <= 3; i++) box.append(el("span", { className: i <= n ? "on" : "" }));
    return box;
  }

  /** The status mark, a button that ticks the task done (or back to to do). */
  function statusMark(t, onDone) {
    const s = statusOf(t);
    const done = t.status === "done";
    const b = button(`tk-st st-${s}`, { title: done ? "Done. Click to reopen" : `${STATUS_LABEL.get(s)}. Click to mark done` });
    b.setAttribute("aria-label", done ? `Reopen #${t.id}` : `Mark #${t.id} done`);
    b.append(el("span", { className: "tk-st-ring" }));
    b.onclick = async (e) => {
      e.stopPropagation();
      try {
        await window.delphi.tasks.update(t.id, { status: done ? "todo" : "done" });
        if (onDone) onDone();
        await app.refresh();
      } catch (error) { app.notify(errOf(error)); }
    };
    return b;
  }

  function avatar(name) {
    const agent = app.isAgent(name);
    const lower = String(name).toLowerCase();
    const kind = !agent ? "" : /codex/.test(lower) ? " codex" : /copilot/.test(lower) ? " copilot" : " claude";
    const a = el("span", { className: `tk-av${agent ? " agent" : ""}${kind}`, textContent: initials(name), title: name });
    a.setAttribute("aria-label", `Assigned to ${name}`);
    return a;
  }

  /** The age column: the stuck mark when Today says it went quiet, else days since it changed. */
  function ageTag(t) {
    const stuck = window.DelphiToday && DelphiToday.stuckOf ? DelphiToday.stuckOf(t.id) : null;
    if (stuck) {
      const tag = el("span", { className: `tk-tag ${stuck.level}`, textContent: stuck.mark, title: stuck.words });
      tag.setAttribute("aria-label", stuck.words);
      return tag;
    }
    const d = ageDays(t);
    if (d == null) return null;
    return el("span", { className: "tk-age", textContent: d ? `${d}d` : "today", title: d ? `Last changed ${d} days ago` : "Changed today" });
  }

  function pill(t, row) {
    const p = pillOf(t);
    if (!p) return null;
    const b = button(`tk-pill${p.complete ? " complete" : ""}`, { title: `${p.label}. Click to ${expanded.has(t.id) ? "hide" : "show"} them` });
    b.dataset.pill = String(t.id);
    b.setAttribute("aria-expanded", String(expanded.has(t.id)));
    b.setAttribute("aria-label", `${p.label}. ${expanded.has(t.id) ? "Hide" : "Show"} the checklist`);
    const bar = el("span", { className: "tk-pill-bar" }, el("span", { style: `width:${Math.round(p.ratio * 100)}%` }));
    b.append(bar, el("span", { className: "tk-pill-n", textContent: p.text }));
    b.onclick = (e) => { e.stopPropagation(); toggleChecklist(t, row); };
    return b;
  }

  function repaintPill(t) {
    const p = pillOf(t);
    for (const b of document.querySelectorAll(`#content [data-pill="${t.id}"]`)) {
      if (!p) continue;
      b.classList.toggle("complete", p.complete);
      b.querySelector(".tk-pill-bar span").style.width = `${Math.round(p.ratio * 100)}%`;
      b.querySelector(".tk-pill-n").textContent = p.text;
      b.setAttribute("aria-label", `${p.label}. ${expanded.has(t.id) ? "Hide" : "Show"} the checklist`);
    }
  }

  // -------------------------------------------------------------------------
  // The subtask checklist under a row

  async function toggleChecklist(t, row) {
    if (expanded.has(t.id)) {
      expanded.delete(t.id);
      const box = row.nextElementSibling;
      if (box && box.dataset.subsOf === String(t.id)) box.remove();
    } else {
      expanded.add(t.id);
      row.after(checklist(t));
    }
    const b = row.querySelector(`[data-pill="${t.id}"]`);
    if (b) b.setAttribute("aria-expanded", String(expanded.has(t.id)));
    repaintPill(t);
  }

  /** The checklist, drawn from the last read at once and read again behind it. */
  function checklist(t) {
    const box = el("div", { className: "tk-subs" });
    box.dataset.subsOf = String(t.id);
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", `Subtasks of #${t.id}`);
    const paint = (subs) => {
      box.textContent = "";
      if (!subs) { box.append(el("div", { className: "tk-subs-wait", textContent: "Reading the subtasks" })); return; }
      if (!subs.length) { box.append(el("div", { className: "tk-subs-wait", textContent: "No subtasks any more." })); return; }
      for (const s of subs) box.append(subLine(t, s, paint));
    };
    paint(subsOf.get(t.id) || null);
    window.delphi.tasks.detail(t.id).then((d) => {
      const subs = (d && d.subtasks) || [];
      const before = JSON.stringify(subsOf.get(t.id) || null);
      subsOf.set(t.id, subs);
      if (JSON.stringify(subs) !== before && box.isConnected) paint(subs);
      // The counts on the row came from the list; the checklist is newer.
      const done = subs.filter((s) => s.status === "done").length;
      if (subs.length !== Number(t.subtask_count) || done !== Number(t.subtask_done)) {
        t.subtask_count = subs.length;
        t.subtask_done = done;
        repaintPill(t);
      }
    }).catch((error) => { if (!subsOf.has(t.id)) { box.textContent = ""; box.append(el("div", { className: "tk-subs-wait", textContent: errOf(error) })); } });
    return box;
  }

  function subLine(parent, s, repaint) {
    const done = s.status === "done";
    const line = el("div", { className: "tk-sub" + (done ? " done" : "") });
    const box = button("tk-check" + (done ? " on" : ""), { title: done ? "Done. Click to reopen" : "Mark done" });
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(done));
    box.setAttribute("aria-label", `#${s.id} ${s.title}`);
    box.append(I("check", "xs"));
    box.dataset.sub = String(s.id);
    if (ticking.has(s.id)) box.disabled = true;
    box.onclick = async (e) => {
      e.stopPropagation();
      if (ticking.has(s.id)) return;
      const hadFocus = document.activeElement === box;
      const again = () => { if (hadFocus) document.querySelector(`#content [data-sub="${s.id}"]`)?.focus(); };
      const next = toggleSub(parent, s);
      const was = { status: s.status, subtask_done: parent.subtask_done };
      // Ticked on screen first and written behind it; put back if the write fails.
      s.status = next.status;
      parent.subtask_done = next.subtask_done;
      ticking.add(s.id);
      repaint(subsOf.get(parent.id));
      repaintPill(parent);
      again();
      try {
        await window.delphi.tasks.update(s.id, { status: next.status });
      } catch (error) {
        s.status = was.status;
        parent.subtask_done = was.subtask_done;
        app.notify(errOf(error));
      } finally {
        ticking.delete(s.id);
        repaint(subsOf.get(parent.id));
        repaintPill(parent);
        again();
      }
    };
    const name = button("tk-sub-title", { textContent: s.title, title: "Open this subtask" });
    name.onclick = (e) => { e.stopPropagation(); app.openTask(s.id); };
    line.append(box, el("span", { className: "tk-id", textContent: `#${s.id}` }), name);
    return line;
  }

  // -------------------------------------------------------------------------
  // A row, and the row as its own editor

  function row(t, opts, ctx) {
    if (editing && editing.id === t.id) return editor(t, opts, ctx);
    const props = opts.props;
    const r = el("div", { className: "tk-row" + (t.status === "done" ? " done" : "") + (t.id === lastAdded ? " fresh" : "") });
    r.dataset.taskId = String(t.id);
    r.tabIndex = 0;
    r.setAttribute("role", "listitem");
    r.setAttribute("aria-label", `#${t.id} ${t.title}, ${STATUS_LABEL.get(statusOf(t))}, ${PRI_LABEL.get(priOf(t))} priority`);
    const stuck = window.DelphiToday && DelphiToday.stuckOf ? DelphiToday.stuckOf(t.id) : null;
    if (stuck) r.classList.add("quiet", stuck.level);
    if (props.priority) r.append(priBars(t));
    if (props.id) r.append(el("span", { className: "tk-id", textContent: `#${t.id}` }));
    if (props.status) r.append(statusMark(t));
    r.append(el("span", { className: "tk-title", textContent: t.title }));
    if (props.subtasks) { const p = pill(t, r); if (p) r.append(p); }
    if (props.project && opts.group !== "project" && t.project_name) {
      r.append(el("span", { className: "tk-proj" },
        el("span", { className: "tk-dot", style: `background:${safeColour(t.project_colour)}` }), t.project_name));
    }
    if (props.ref && t.ref) r.append(el("span", { className: "tk-ref", textContent: t.ref }));
    r.append(el("span", { className: "grow" }));
    if (props.due && t.due) {
      const late = ctx.isOverdue(t);
      r.append(el("span", { className: "tk-due" + (late ? " late" : ""), textContent: late ? `Overdue ${t.due}` : `Due ${t.due}` }));
    }
    if (props.age) { const a = ageTag(t); if (a) r.append(a); }
    if (props.assignee && t.assignee) r.append(avatar(t.assignee));
    const edit = button("tk-act tk-edit", { title: "Edit here (E)" }, I("pencil", "sm"));
    edit.setAttribute("aria-label", `Edit #${t.id} here`);
    edit.onclick = (e) => { e.stopPropagation(); startEdit(t.id); };
    const more = button("tk-act", { title: "Actions" }, I("more", "sm"));
    more.setAttribute("aria-label", `Actions for #${t.id}`);
    more.onclick = (e) => { e.stopPropagation(); const b = more.getBoundingClientRect(); app.taskMenu(t, b.left - 150, b.bottom + 4); };
    r.append(el("span", { className: "tk-acts" }, edit, more));
    r.onclick = () => app.openTask(t.id);
    r.oncontextmenu = (e) => { e.preventDefault(); app.taskMenu(t, e.clientX, e.clientY); };
    r.onkeydown = (e) => {
      // A control inside the row keeps its own Enter and Space: without this
      // the list's Enter (ui/keys.js) would open the task instead.
      if (e.target !== r) { if (["Enter", " ", "e", "E"].includes(e.key)) e.stopPropagation(); return; }
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); app.openTask(t.id); }
      else if (e.key === " ") { e.preventDefault(); e.stopPropagation(); app.quickLook(t.id); }
      else if ((e.key === "e" || e.key === "E") && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); startEdit(t.id); }
    };
    return r;
  }

  const select = (cls, choices, value, label) => {
    const s = el("select", { className: cls });
    s.setAttribute("aria-label", label);
    for (const [v, text] of choices) s.append(el("option", { value: v, textContent: text, selected: v === value }));
    return s;
  };

  // Each editor owns its draft. `editing` names the one open now, so a save
  // still in flight for one row can never write into, or clear, the next.
  function editor(t, opts, ctx) {
    const draft = editing;
    const r = el("div", { className: "tk-row editing" });
    r.dataset.taskId = String(t.id);
    r.setAttribute("role", "listitem");
    r.setAttribute("aria-label", `Editing #${t.id}`);
    if (opts.props.priority) r.append(priBars({ priority: draft.priority }));
    if (opts.props.id) r.append(el("span", { className: "tk-id", textContent: `#${t.id}` }));
    const title = el("input", { className: "tk-edit-title", type: "text", value: draft.title });
    title.setAttribute("aria-label", `Title of #${t.id}`);
    title.dataset.keep = "tasks-edit";
    title.oninput = () => { draft.title = title.value; title.removeAttribute("aria-invalid"); };
    const status = select("tk-edit-sel", STATUSES, draft.status, "Status");
    status.onchange = () => { draft.status = status.value; };
    const priority = select("tk-edit-sel", PRIORITIES, draft.priority, "Priority");
    priority.onchange = () => { draft.priority = priority.value; };
    const hint = el("span", { className: "tk-hint" }, kbd("Enter"), " save ", kbd("Esc"), " cancel");
    r.append(title, status, priority, hint);
    track(title, "edit");
    r.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      // Kept here: Escape on the page hides the window, and Enter on the row opens it.
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelEdit(draft); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); saveEdit(t, draft, { field: title, focus: true }); }
      else e.stopPropagation();
    });
    // Leaving the row saves, the way a cell does: what was typed is kept
    // rather than thrown away by a click somewhere else. The focus stays
    // wherever that click put it.
    r.addEventListener("focusout", (e) => {
      if (e.relatedTarget && r.contains(e.relatedTarget)) return;
      setTimeout(() => { if (editing === draft && r.isConnected && !r.contains(document.activeElement)) saveEdit(t, draft, { field: title, focus: false }); }, 0);
    });
    r.onclick = (e) => e.stopPropagation();
    return r;
  }

  /** Turns a row on screen into its editor. False when the row is not one of this tab's. */
  function startEdit(id) {
    const node = document.querySelector(`#content .tk-row[data-task-id="${Number(id)}"]`);
    const t = ctxNow && ctxNow.byId.get(Number(id));
    if (!node || !t) return false;
    if (editing && editing.id === t.id && node.classList.contains("editing")) { node.querySelector(".tk-edit-title")?.focus(); return true; }
    // Another row open: it saves first, as if the focus had left it.
    if (editing) {
      const other = ctxNow.byId.get(editing.id);
      const prev = editing;
      if (other) saveEdit(other, prev, { focus: false });
      else editing = null;
    }
    editing = { id: t.id, ...baseOf(t), base: baseOf(t) };
    const ed = editor(t, ctxNow.opts, ctxNow);
    node.replaceWith(ed);
    const field = ed.querySelector(".tk-edit-title");
    field.focus();
    field.select();
    focusWas = "edit";
    return true;
  }

  function cancelEdit(draft) {
    if (!draft || editing !== draft) return;
    editing = null;
    focusWas = null;
    swapRow(draft.id, true);
  }

  /** Puts the plain row back where the editor is, and the keyboard highlight on it. */
  function swapRow(id, focus) {
    const node = document.querySelector(`#content .tk-row[data-task-id="${id}"]`);
    const t = ctxNow && ctxNow.byId.get(id);
    if (!node || !t || (editing && editing.id === id)) return;
    const fresh = row(t, ctxNow.opts, ctxNow);
    if (focus) {
      for (const n of document.querySelectorAll("#content .kbd-hi")) n.classList.remove("kbd-hi");
      fresh.classList.add("kbd-hi");
    }
    node.replaceWith(fresh);
    if (focus) fresh.focus({ preventScroll: true });
  }

  const saving = new Set();
  async function saveEdit(t, draft, { field = null, focus = false } = {}) {
    if (!draft || saving.has(draft)) return;
    const { patch, error } = editPatch(t, draft, draft.base);
    if (error) {
      // An emptied title is refused on Enter; walking away from one puts the
      // old title back rather than holding the focus hostage.
      if (focus && field) { field.setAttribute("aria-invalid", "true"); field.title = error; field.focus(); }
      else cancelEdit(draft);
      return;
    }
    if (!patch) { if (editing === draft) { editing = null; focusWas = null; swapRow(t.id, focus); } return; }
    saving.add(draft);
    const sent = { title: draft.title, status: draft.status, priority: draft.priority };
    try {
      await window.delphi.tasks.update(t.id, patch);
      const keyBefore = groupKey(t, ctxNow.opts);
      Object.assign(t, patch);
      // Typed into while it was being written: the editor stays open on what
      // is there now, and the next save sends only what changed since.
      const typedOn = editing === draft && ["title", "status", "priority"].some((k) => draft[k] !== sent[k]);
      if (typedOn) {
        draft.base = { ...draft.base, ...sent, title: String(sent.title).trim() };
        if (patch.status || groupKey(t, ctxNow.opts) !== keyBefore) await app.refresh();
        // A focusout while this was written was turned away by `saving`; if
        // the person has left the row, what they typed since is saved now.
        setTimeout(() => {
          const node = document.querySelector(`#content .tk-row.editing[data-task-id="${t.id}"]`);
          if (editing === draft && (!node || !node.contains(document.activeElement))) saveEdit(ctxNow.byId.get(t.id) || t, draft, { focus: false });
        }, 0);
        return;
      }
      if (editing === draft) { editing = null; focusWas = null; }
      // A change that moves the task to another group, or changes what the
      // tab counts, is a repaint; a new title or priority is just this row.
      if (patch.status || groupKey(t, ctxNow.opts) !== keyBefore) await app.refresh();
      else swapRow(t.id, focus);
    } catch (e) {
      app.notify(errOf(e));
    } finally {
      saving.delete(draft);
    }
  }

  const groupKey = (t, opts) => (opts.group === "status" ? statusOf(t) : opts.group === "priority" ? priOf(t) : "");

  // -------------------------------------------------------------------------
  // Keeping the focus across a repaint
  //
  // app.js replaces #content on every render, so a field that had the cursor
  // is gone before this tab is drawn again. Each field says when it has the
  // focus, and a repaint puts it back only when nothing else has taken it.

  function track(input, name) {
    input.addEventListener("focus", () => { focusWas = name; });
    input.addEventListener("blur", () => {
      // Removed by a repaint is not the same as left by the person.
      setTimeout(() => { if (input.isConnected && focusWas === name) focusWas = null; }, 0);
    });
  }

  function restoreFocus(root) {
    if (!focusWas) return;
    const a = document.activeElement;
    if (a && a !== document.body && document.contains(a)) return;
    const sel = { quick: ".tk-quick-in", filter: ".tk-filter-in", edit: ".tk-edit-title", add: ".tk-add-in" }[focusWas];
    const node = sel && root.querySelector(sel);
    if (!node) return;
    node.focus({ preventScroll: true });
    try { node.setSelectionRange(node.value.length, node.value.length); } catch {}
  }

  // -------------------------------------------------------------------------
  // The toolbar and quick entry

  function toolbar(s, mode) {
    const bar = el("div", { className: "tk-bar" });
    const filter = el("label", { className: "tk-filter" }, I("search", "sm"));
    const input = el("input", { className: "tk-filter-in", type: "search", value: filterText, placeholder: "Filter by words, #number or ref" });
    input.setAttribute("aria-label", "Filter tasks");
    input.oninput = () => { filterText = input.value; repaintList(); };
    input.onkeydown = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (input.value) { input.value = ""; filterText = ""; repaintList(); } else input.blur(); }
      if (e.key === "ArrowDown" || e.key === "Enter") {
        const first = document.querySelector("#content .tk-list [data-task-id]");
        if (first) { e.preventDefault(); first.focus(); first.classList.add("kbd-hi"); }
      }
    };
    track(input, "filter");
    filter.append(input);
    bar.append(filter, el("span", { className: "grow" }));

    const display = button("tk-btn tk-display", { title: "Display options (Shift+V)" }, I("sliders", "sm"), el("span", { textContent: "Display" }));
    display.setAttribute("aria-haspopup", "dialog");
    display.setAttribute("aria-expanded", String(Boolean(pop)));
    display.onclick = () => { if (pop) closePop(); else openPop(); };
    bar.append(display);

    const seg = el("div", { className: "tk-seg", role: "group" });
    seg.setAttribute("aria-label", "Layout");
    for (const [id, label, icon] of [["list", "List", "list"], ["board", "Kanban", "kanban"]]) {
      const b = button("tk-seg-b", {}, I(icon, "sm"), el("span", { textContent: label }));
      b.setAttribute("aria-pressed", String(mode === id));
      b.onclick = () => { if (mode !== id) setMode(id); };
      seg.append(b);
    }
    bar.append(seg);
    return bar;
  }

  /** Where a quick entry goes: this project, or in All projects the one Pads and Chat use. */
  const quickTarget = (s) => (s.projectId != null ? s.projectId : app.projectFor());

  function quick(s) {
    // .add-row .field is what Cmd+N (focusComposer in app.js) looks for.
    const wrap = el("div", { className: "add-row tk-quick" });
    const field = el("input", { className: "field tk-quick-in", type: "text", placeholder: "Quick task entry. Enter adds it; !high and @who work too" });
    field.setAttribute("aria-label", "Quick task entry");
    const draftId = s.projectId || "all";
    // A repaint builds a new field while the old one may hold text typed a
    // moment ago, newer than the saved draft; that text comes across.
    if (quickLive && quickLive.id === draftId) field.value = quickLive.value;
    if (window.DelphiRecovery) DelphiRecovery.bindDraft(field, "quick", draftId);
    track(field, "quick");
    const chips = el("span", { className: "tk-quick-chips" });
    const paintChips = () => {
      chips.textContent = "";
      const v = parseQuick(field.value);
      const target = quickTarget(s);
      if (!field.value.trim()) { chips.append(kbd(shortcut("N"))); return; }
      if (v.priority !== "med") chips.append(el("span", { className: "tk-chip" }, priBars(v), PRI_LABEL.get(v.priority)));
      if (v.assignee) chips.append(el("span", { className: "tk-chip" }, avatar(v.assignee), v.assignee));
      if (v.ref) chips.append(el("span", { className: "tk-chip mono", textContent: v.ref }));
      if (target != null) chips.append(el("span", { className: "tk-chip", textContent: app.projectName(target) || "Project" }));
      chips.append(el("span", { className: "tk-hint" }, kbd("Enter"), " add"));
    };
    field.addEventListener("input", () => { quickLive = { id: draftId, value: field.value }; quickMsg = null; paintChips(); const m = wrap.parentNode && wrap.parentNode.querySelector(".tk-msg"); if (m) m.remove(); });
    field.onkeydown = async (e) => {
      if (e.isComposing) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); field.blur(); return; }
      if (e.key !== "Enter") return;
      e.preventDefault();
      const v = parseQuick(field.value);
      if (!v.title || quickBusy) return;
      const target = quickTarget(s);
      if (target == null) { quickMsg = { error: true, text: "Make a project first: a task needs one to live in." }; app.repaint(); return; }
      quickBusy = true;
      // Emptied before the write rather than after it, so whatever is typed
      // while it is being written is the next task and is not wiped; put back
      // if the write fails.
      const sent = field.value;
      field.value = "";
      quickLive = { id: draftId, value: "" };
      paintChips();
      try {
        const created = await window.delphi.tasks.create({ projectId: target, title: v.title, priority: v.priority, assignee: v.assignee, ref: v.ref });
        if (window.DelphiRecovery) DelphiRecovery.clearDraft("quick", draftId);
        if (window.DelphiRecovery && field.value) DelphiRecovery.saveDraft?.("quick", draftId, field.value);
        lastAdded = created && created.id;
        quickMsg = { error: false, text: `Added #${created.id}${s.projectId ? "" : ` to ${app.projectName(target) || "the project"}`}.` };
        focusWas = "quick";
        // The note says it was added and then goes, so it never reads as
        // being about the next one typed.
        const said = quickMsg;
        setTimeout(() => { if (quickMsg === said) { quickMsg = null; document.querySelector("#content .tk-quick-box .tk-msg")?.remove(); } }, 4000);
        await app.refresh();
      } catch (error) {
        if (field.isConnected) { field.value = field.value ? `${sent} ${field.value}` : sent; field.dispatchEvent(new Event("input")); }
        else {
          // A repaint built a new field while this was being written: the text goes back into that one.
          // Only into this project's field: after a switch, it is kept as this project's draft instead.
          const since = quickLive && quickLive.id === draftId ? quickLive.value : "";
          const value = since ? `${sent} ${since}` : sent;
          const here = (app.state().projectId || "all") === draftId && owns(app.state());
          const live = here ? document.querySelector("#content .tk-quick-in") : null;
          if (live) { live.value = value; live.dispatchEvent(new Event("input")); }
          else if (window.DelphiRecovery) DelphiRecovery.saveDraft("quick", draftId, value);
          if (!live && quickLive && quickLive.id === draftId) quickLive = { id: draftId, value };
        }
        quickMsg = { error: true, text: errOf(error) };
        const boxNow = wrap.parentNode;
        if (boxNow) { boxNow.querySelector(".tk-msg")?.remove(); boxNow.append(el("div", { className: "tk-msg err", role: "status", textContent: quickMsg.text })); }
      } finally {
        quickBusy = false;
      }
    };
    wrap.append(I("plus", "sm"), field, chips);
    paintChips();
    const box = el("div", { className: "tk-quick-box" }, wrap);
    if (quickMsg) box.append(el("div", { className: "tk-msg" + (quickMsg.error ? " err" : ""), role: "status", textContent: quickMsg.text }));
    return box;
  }

  // -------------------------------------------------------------------------
  // The Display popover (Shift+V)

  function openPop({ focus = true } = {}) {
    const s = app.state();
    const anchor = document.querySelector("#content .tk-display");
    if (!anchor) return;
    closePop();
    const opts = displayOf(s);
    const mode = modeOf(s);
    const box = el("div", { className: "tk-pop" });
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Display options");
    // Every control carries data-k, so the one that had the focus gets it back
    // after the popover is drawn again with the new choice.
    const keep = (fn) => { const k = document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset.k : null; fn(); if (k) box.querySelector(`[data-k="${k}"]`)?.focus(); };
    const apply = (next) => keep(() => { setDisplay(s, next); repaintList(); paintPop(); });
    const paintPop = () => {
      const o = displayOf(s);
      box.textContent = "";
      const lay = el("div", { className: "tk-pop-seg", role: "group" });
      lay.setAttribute("aria-label", "Layout");
      const layouts = [["list", "List"], ["board", "Kanban"]];
      if (s.projectId) layouts.push(["table", "Table"], ["calendar", "Calendar"]);
      for (const [id, label] of layouts) {
        const b = button("tk-seg-b", { textContent: label });
        b.dataset.k = `layout-${id}`;
        b.setAttribute("aria-pressed", String(modeOf(s) === id));
        b.onclick = async () => { closePop(); if (s.projectId) await app.setProjectMode(id); else setMode(id); };
        lay.append(b);
      }
      box.append(el("div", { className: "tk-pop-h", textContent: "Layout" }), lay);

      const groupChoices = Object.entries(GROUPS).filter(([k]) => k !== "epic" || (s.projectId && ctxNow && ctxNow.hasEpics));
      const g = select("tk-pop-sel", groupChoices, o.group, "Grouping");
      g.dataset.k = "group";
      g.onchange = () => apply({ ...displayOf(s), group: g.value });
      const ord = select("tk-pop-sel", Object.entries(ORDERS), o.order, "Ordering");
      ord.dataset.k = "order";
      ord.onchange = () => apply({ ...displayOf(s), order: ord.value });
      const line = (label, control) => el("div", { className: "tk-pop-line" }, el("span", { textContent: label }), control);
      if (mode === "list") box.append(line("Grouping", g));
      box.append(line("Ordering", ord));
      if (o.group !== "status" && mode === "list") {
        const sw = button("tk-switch" + (o.showDone ? " on" : ""), { title: "Show completed tasks" });
        sw.dataset.k = "done";
        sw.setAttribute("role", "switch");
        sw.setAttribute("aria-checked", String(o.showDone));
        sw.setAttribute("aria-label", "Show completed tasks");
        sw.append(el("span"));
        sw.onclick = () => apply({ ...displayOf(s), showDone: !displayOf(s).showDone });
        box.append(line("Show completed", sw));
      }
      box.append(el("div", { className: "tk-pop-h", textContent: "Show properties" }));
      const chips = el("div", { className: "tk-pop-props" });
      for (const [k, label] of PROPS) {
        const b = button("tk-prop" + (o.props[k] ? " on" : ""), { textContent: label });
        b.setAttribute("aria-pressed", String(o.props[k]));
        b.onclick = () => { const cur = displayOf(s); apply({ ...cur, props: { ...cur.props, [k]: !cur.props[k] } }); };
        b.dataset.k = `prop-${k}`;
        b.dataset.prop = k;
        chips.append(b);
      }
      box.append(chips);
      const reset = button("tk-btn sm", { textContent: "Reset to default" });
      reset.dataset.k = "reset";
      reset.onclick = () => keep(() => { store.set(`display.${scopeOf(s)}`, null); repaintList(); paintPop(); });
      box.append(el("div", { className: "tk-pop-foot" }, el("span", { className: "tk-hint" }, kbd("Shift V"), " opens this"), el("span", { className: "grow" }), reset));
    };
    paintPop();
    document.body.append(box);
    const r = anchor.getBoundingClientRect();
    box.style.top = `${Math.round(r.bottom + 6)}px`;
    box.style.left = `${Math.max(8, Math.round(Math.min(r.right, innerWidth - 8) - box.offsetWidth))}px`;
    anchor.setAttribute("aria-expanded", "true");
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePop(true); } };
    const onDown = (e) => { if (!box.contains(e.target) && !anchor.contains(e.target)) closePop(); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    pop = { box, anchor, off: () => { document.removeEventListener("keydown", onKey, true); document.removeEventListener("mousedown", onDown, true); } };
    const first = box.querySelector("button, select");
    if (first && focus) first.focus();
  }

  function closePop(refocus = false) {
    if (!pop) return;
    const { box, anchor, off } = pop;
    pop = null;
    off();
    box.remove();
    const live = document.querySelector("#content .tk-display") || anchor;
    live.setAttribute("aria-expanded", "false");
    if (refocus && live.isConnected) live.focus();
  }

  // -------------------------------------------------------------------------
  // The list

  function groupHead(g, ctx) {
    const head = el("div", { className: `tk-gh k-${g.kind}` });
    if (g.kind === "project") {
      const p = g.projectId != null ? app.projectById(g.projectId) : null;
      head.append(el("span", { className: "tk-sq", style: `background:${safeColour(g.colour)}` }),
        el("span", { className: "tk-gh-name", textContent: g.label }),
        el("span", { className: "tk-gh-path", textContent: p && p.path ? tilde(p.path) : "no folder" }),
        el("span", { className: "tk-gh-n", textContent: `${g.tasks.length} open` }));
      const stuck = { amber: 0, red: 0 };
      if (window.DelphiToday && DelphiToday.stuckOf) for (const t of g.tasks) { const x = DelphiToday.stuckOf(t.id); if (x) stuck[x.level] = (stuck[x.level] || 0) + 1; }
      if (stuck.amber) head.append(el("span", { className: "tk-tag amber", textContent: `${stuck.amber} idle` }));
      if (stuck.red) head.append(el("span", { className: "tk-tag red", textContent: `${stuck.red} stagnant` }));
      head.append(el("span", { className: "grow" }));
      if (g.projectId != null) {
        const go = button("tk-link", {}, "Open project ", I("right", "xs"));
        go.onclick = () => app.go({ projectId: g.projectId, view: "tasks" });
        head.append(go);
      }
    } else {
      if (g.kind === "status") head.append(el("span", { className: `tk-st-ring big st-${g.status}` }));
      if (g.kind === "priority") head.append(priBars({ priority: g.priority }));
      if (g.kind === "epic") head.append(el("span", { className: "tk-sq", style: `background:${safeColour(g.colour)}` }));
      head.append(el("span", { className: "tk-gh-name", textContent: g.label }),
        el("span", { className: "tk-gh-n", textContent: String(g.tasks.length) }), el("span", { className: "grow" }));
      if (g.kind === "status" && g.status === "done") {
        const show = button("tk-link", { textContent: doneOpen ? "Hide" : "Show" });
        show.setAttribute("aria-expanded", String(doneOpen));
        show.onclick = () => { doneOpen = !doneOpen; repaintList(); };
        head.append(show);
      } else if (g.kind === "status") {
        const add = button("tk-act show", { title: `Add a task to ${g.label}` }, I("plus", "sm"));
        add.setAttribute("aria-label", `Add a task to ${g.label}`);
        add.onclick = () => addInto(head, g.status, ctx);
        head.append(add);
      }
    }
    return head;
  }

  /** Opens an entry line under a status heading: what is typed there starts in that status. */
  function addInto(after, status, ctx) {
    const existing = after.nextElementSibling;
    if (existing && existing.classList.contains("tk-add")) { existing.querySelector("input").focus(); return; }
    // One entry line at a time: a second one replaces the first.
    for (const old of document.querySelectorAll("#content .tk-add")) old.remove();
    if (!adding || adding.status !== status) adding = { status, text: "" };
    const line = addLine(ctx, adding);
    after.after(line);
    line.querySelector("input").focus();
    // Said here as well as by the focus event, which a window in the
    // background does not fire.
    focusWas = "add";
  }

  /**
   * The entry line for `adding`. Its text lives at module level, so a repaint
   * (an agent's write, a refresh) draws the line again with what was typed.
   */
  function addLine(ctx, mine) {
    const status = mine.status;
    const line = el("div", { className: "tk-add" });
    const input = el("input", { className: "tk-add-in", type: "text", value: mine.text, placeholder: `New task in ${STATUS_LABEL.get(status)}, then Enter` });
    input.setAttribute("aria-label", `New task in ${STATUS_LABEL.get(status)}`);
    track(input, "add");
    input.oninput = () => { mine.text = input.value; };
    input.onkeydown = async (e) => {
      if (e.isComposing) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (adding === mine) adding = null; focusWas = null; line.remove(); return; }
      if (e.key !== "Enter") return;
      e.preventDefault();
      const v = parseQuick(input.value);
      const target = quickTarget(ctx.state);
      if (!v.title || target == null || input.readOnly) return;
      input.readOnly = true;
      try {
        const created = await window.delphi.tasks.create({ projectId: target, title: v.title, priority: v.priority, assignee: v.assignee, ref: v.ref, status });
        lastAdded = created && created.id;
        // Left open for the next one, empty unless more was typed meanwhile.
        if (adding === mine) mine.text = "";
        focusWas = "add";
        await app.refresh();
      } catch (error) { app.notify(errOf(error)); input.readOnly = false; }
    };
    line.append(I("plus", "sm"), input);
    return line;
  }

  /**
   * The list as a queue of things to paint (headings, rows, "N more"), drawn a
   * chunk at a time. The rest follow when the sentinel at the end comes within
   * a screen of view, or when it is clicked, which is also what a keyboard
   * gets: it is a button.
   */
  function paintList(box, ctx) {
    const { opts, groups } = ctx;
    const queue = [];
    const peek = opts.group === "project" && !ctx.state.projectId && groups.length > 1;
    for (const g of groups) {
      const isDone = g.kind === "status" && g.status === "done";
      if (g.label != null) queue.push(() => groupHead(g, ctx));
      if (adding && g.kind === "status" && adding.status === g.status) { const mine = adding; queue.push(() => addLine(ctx, mine)); }
      if (isDone && !doneOpen && ctx.taskFilter !== "done") continue;
      let list = g.tasks;
      let more = 0;
      if (isDone && list.length > DONE_CAP && !opened.has(g.key)) { more = list.length - DONE_CAP; list = list.slice(0, DONE_CAP); }
      else if (peek && list.length > GROUP_PEEK + 1 && !opened.has(g.key)) { more = list.length - GROUP_PEEK; list = list.slice(0, GROUP_PEEK); }
      for (const t of list) {
        queue.push(() => row(t, opts, ctx));
        if (opts.props.subtasks && expanded.has(t.id) && pillOf(t)) queue.push(() => checklist(t));
      }
      if (more) {
        queue.push(() => {
          const b = button("tk-more", { textContent: isDone ? `${more} older done` : `${more} more in ${g.label}` });
          b.onclick = () => { opened.add(g.key); repaintList(); };
          return b;
        });
      }
    }
    let at = 0;
    let sentinel = null;
    let watcher = null;
    const step = () => {
      if (sentinel) { sentinel.remove(); sentinel = null; }
      if (watcher) { watcher.disconnect(); watcher = null; }
      const end = Math.min(queue.length, at + CHUNK);
      const frag = document.createDocumentFragment();
      for (; at < end; at++) frag.append(queue[at]());
      box.append(frag);
      if (at >= queue.length) return;
      sentinel = button("tk-more tk-sentinel", { textContent: `Show ${Math.min(CHUNK, queue.length - at)} more` });
      sentinel.onclick = step;
      box.append(sentinel);
      if (typeof IntersectionObserver === "function") {
        watcher = new IntersectionObserver((entries) => { if (entries.some((x) => x.isIntersecting)) step(); },
          { root: document.getElementById("content"), rootMargin: "800px 0px" });
        watcher.observe(sentinel);
      }
    };
    step();
    return queue.length;
  }

  // -------------------------------------------------------------------------
  // Kanban

  function card(t, ctx) {
    const c = el("div", { className: "tk-card" + (t.status === "done" ? " done" : "") + (t.id === lastAdded ? " fresh" : "") });
    c.dataset.taskId = String(t.id);
    c.tabIndex = 0;
    c.draggable = true;
    c.setAttribute("aria-label", `#${t.id} ${t.title}, ${STATUS_LABEL.get(statusOf(t))}`);
    const props = ctx.opts.props;
    const top = el("div", { className: "tk-card-top" });
    if (props.priority) top.append(priBars(t));
    if (props.id) top.append(el("span", { className: "tk-id", textContent: `#${t.id}` }));
    if (props.project && !ctx.state.projectId && t.project_name) {
      top.append(el("span", { className: "tk-proj" }, el("span", { className: "tk-dot", style: `background:${safeColour(t.project_colour)}` }), t.project_name));
    }
    c.append(top, el("div", { className: "tk-card-title", textContent: t.title }));
    const foot = el("div", { className: "tk-card-foot" });
    if (props.assignee && t.assignee) foot.append(avatar(t.assignee));
    if (props.subtasks) { const p = pillOf(t); if (p) foot.append(el("span", { className: "tk-pill static" + (p.complete ? " complete" : ""), title: p.label },
      el("span", { className: "tk-pill-bar" }, el("span", { style: `width:${Math.round(p.ratio * 100)}%` })), el("span", { className: "tk-pill-n", textContent: p.text }))); }
    foot.append(el("span", { className: "grow" }));
    if (props.due && t.due) foot.append(el("span", { className: "tk-due" + (ctx.isOverdue(t) ? " late" : ""), textContent: t.due }));
    if (props.age) { const a = ageTag(t); if (a) foot.append(a); }
    if (foot.childNodes.length > 1) c.append(foot);
    c.onclick = () => app.openTask(t.id);
    c.oncontextmenu = (e) => { e.preventDefault(); app.taskMenu(t, e.clientX, e.clientY); };
    c.onkeydown = (e) => {
      if (e.target !== c) return;
      if (e.key === "Enter") { e.preventDefault(); app.openTask(t.id); }
      else if (e.key === " ") { e.preventDefault(); app.quickLook(t.id); }
    };
    c.ondragstart = (e) => { e.dataTransfer.setData(DRAG_TYPE, String(t.id)); e.dataTransfer.effectAllowed = "move"; c.classList.add("dragging"); };
    c.ondragend = () => c.classList.remove("dragging");
    return c;
  }

  // A type of our own: dropping plain text such as "12" on Done must not close #12.
  const DRAG_TYPE = "application/x-delphi-task";

  const EMPTY = { todo: "Nothing to do.", doing: "Nothing in progress. Drag a card here.", blocked: "Nothing blocked.", done: "Nothing done yet." };

  function paintBoard(box, ctx) {
    const wrap = el("div", { className: "tk-board" });
    for (const col of ctx.columns) {
      const column = el("section", { className: `tk-col st-${col.status}` });
      column.setAttribute("aria-label", `${col.label}, ${col.tasks.length}`);
      const head = el("div", { className: "tk-col-h" }, el("span", { className: `tk-st-ring big st-${col.status}` }),
        el("span", { className: "tk-gh-name", textContent: col.label }), el("span", { className: "tk-gh-n", textContent: String(col.tasks.length) }),
        el("span", { className: "grow" }));
      const add = button("tk-act show", { title: `Add a task to ${col.label}` }, I("plus", "sm"));
      add.setAttribute("aria-label", `Add a task to ${col.label}`);
      add.onclick = () => addInto(head, col.status, ctx);
      head.append(add);
      const body = el("div", { className: "tk-col-body" });
      const list = col.status === "done" && !opened.has("col-done") ? col.tasks.slice(0, DONE_CAP) : col.tasks;
      let at = 0;
      const more = () => {
        const end = Math.min(list.length, at + CARD_CHUNK);
        const frag = document.createDocumentFragment();
        for (; at < end; at++) frag.append(card(list[at], ctx));
        body.querySelector(".tk-more")?.remove();
        body.append(frag);
        const older = col.tasks.length - list.length;
        if (at < list.length) {
          const b = button("tk-more", { textContent: `Show ${Math.min(CARD_CHUNK, list.length - at)} more` });
          b.onclick = more;
          body.append(b);
        } else if (older > 0) {
          const b = button("tk-more", { textContent: `${older} older done` });
          b.onclick = () => { opened.add("col-done"); repaintList(); };
          body.append(b);
        }
      };
      if (list.length) more();
      else body.append(el("div", { className: "tk-col-empty", textContent: EMPTY[col.status] }));
      column.append(head);
      if (adding && adding.status === col.status) column.append(addLine(ctx, adding));
      column.append(body);
      // Only a card is something to land: other dragged text gets no target.
      const land = (e) => { if (!e.dataTransfer || !e.dataTransfer.types.includes(DRAG_TYPE)) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; column.classList.add("over"); };
      column.ondragover = land;
      column.ondragenter = land;
      column.ondragleave = (e) => { if (!column.contains(e.relatedTarget)) column.classList.remove("over"); };
      column.ondrop = async (e) => {
        e.preventDefault();
        column.classList.remove("over");
        const raw = e.dataTransfer.getData(DRAG_TYPE);
        const t = raw ? ctx.byId.get(Number(raw)) : null;
        const patch = dropPatch(t, col.status);
        if (!patch) return;
        try { await window.delphi.tasks.update(t.id, patch); await app.refresh(); } catch (error) { app.notify(errOf(error)); }
      };
      wrap.append(column);
    }
    box.append(wrap);
  }

  // -------------------------------------------------------------------------
  // Painting

  function context(s) {
    const opts = displayOf(s);
    const tasks = s.allTasks || [];
    const base = { state: s, opts, query: filterText, taskFilter: s.taskFilter || null, isOverdue: app.isOverdue };
    const hasEpics = Boolean(s.projectId && (s.organizers || []).length);
    if (opts.group === "epic" && !hasEpics) opts.group = DEFAULTS[scopeOf(s)].group;
    const mode = modeOf(s);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    if (mode === "board") return { ...base, mode, byId, hasEpics, columns: columns(tasks, opts, base) };
    return { ...base, mode, byId, hasEpics, groups: arrange(tasks, opts, base) };
  }

  /** Paints the list or the board into its box, and says how long it took. */
  function repaintList() {
    if (!listBox || !listBox.isConnected) return;
    const t0 = performance.now();
    ctxNow = context(app.state());
    listBox.textContent = "";
    const s = ctxNow.state;
    const filter = s.taskFilter && TASK_FILTERS[s.taskFilter];
    if (filter || filterText) {
      const n = ctxNow.mode === "board" ? ctxNow.columns.reduce((a, c) => a + c.tasks.length, 0) : ctxNow.groups.reduce((a, g) => a + g.tasks.length, 0);
      const note = el("div", { className: "tk-note", role: "status" },
        el("span", { textContent: `Showing ${n} ${n === 1 ? "task" : "tasks"}${filter ? ` ${filter[1]}` : ""}${filterText ? ` matching “${filterText}”` : ""}` }));
      if (filter) {
        const clear = button("tk-link", { textContent: "Clear filter" });
        clear.onclick = () => { s.taskFilter = null; app.refresh(); };
        note.append(clear);
      }
      listBox.append(note);
    }
    if (ctxNow.mode === "board") paintBoard(listBox, ctxNow);
    else {
      const list = el("div", { className: "tk-list", role: "list" });
      list.setAttribute("aria-label", "Tasks");
      listBox.append(list);
      const n = paintList(list, ctxNow);
      if (!n) list.append(el("div", { className: "tk-empty" }, el("b", { textContent: filterText || filter ? "Nothing matches" : "No open tasks" }),
        el("span", { textContent: filterText || filter ? "Try fewer words, or clear the filter." : "Type one above and press Enter." })));
    }
    lastPaintMs = performance.now() - t0;
    listBox.dataset.paintMs = lastPaintMs.toFixed(1);
  }
  let lastPaintMs = 0;

  /**
   * Called from MOUNTS on every render, whatever the view. Leaving the place
   * this tab was drawn for forgets what belonged to it: the filter, the
   * groups opened past their peek, and which field had the focus, so coming
   * back later does not pull the cursor into a field nobody is in.
   */
  let placeWas = null;
  function paint(s) {
    const place = s && owns(s) ? `${s.projectId ?? "all"}` : null;
    if (place === placeWas) return;
    placeWas = place;
    focusWas = null;
    filterText = "";
    adding = null;
    opened.clear();
    doneOpen = false;
    if (pop) closePop();
  }

  function render(root) {
    const s = app.state();
    // A repaint keeps the popover open on the new page (an agent's write
    // repaints at any moment), and keeps the J and K highlight where it was.
    const popWas = Boolean(pop);
    const popFocus = popWas && pop.box.contains(document.activeElement);
    if (pop) closePop();
    const lit = listBox && listBox.querySelector(".kbd-hi");
    const litId = lit ? lit.dataset.taskId : null;
    const mode = modeOf(s);
    // A filter nobody can see would leave the list short with no way to tell
    // why, so hiding the toolbar (Edit this page) lets go of it.
    if (filterText && window.DelphiLayout && !DelphiLayout.shown("tasks", "toolbar", s.projectId ?? null)) filterText = "";
    const page = el("div", { className: "tk-page" });
    listBox = el("div", { className: "tk-body" });
    const parts = { toolbar: toolbar(s, mode), quick: quick(s), list: listBox };
    page.append(window.DelphiLayout ? DelphiLayout.mount("tasks", parts, { projectId: s.projectId ?? null }) : el("div", {}, parts.toolbar, parts.quick, listBox));
    root.append(page);
    repaintList();
    if (litId) listBox.querySelector(`[data-task-id="${litId}"]`)?.classList.add("kbd-hi");
    restoreFocus(page);
    if (popWas) openPop({ focus: popFocus });
    // The stuck marks come from Today's last answer; ask once, then paint them.
    if (!stuckWarm && window.DelphiToday && DelphiToday.load) {
      stuckWarm = true;
      DelphiToday.load().then(() => {
        if (!owns(app.state()) || !listBox || !listBox.isConnected) return;
        repaintList();
        restoreFocus(listBox);
      }).catch(() => {});
    }
    if (lastAdded) setTimeout(() => { lastAdded = null; }, 1600);
  }

  /** For Cmd+K. */
  function commands() {
    const on = () => owns(app.state());
    return [
      { id: "tasks-display", group: "Commands", title: "Tasks: display options", keys: "Shift+V",
        run: async () => { if (!on()) await app.go({ view: "tasks" }); setTimeout(openPop, 0); } },
      { id: "tasks-list", group: "Commands", title: "Tasks: show as a list", run: async () => { if (app.state().view !== "tasks") await app.go({ view: "tasks" }); setMode("list"); } },
      { id: "tasks-kanban", group: "Commands", title: "Tasks: show as Kanban", run: async () => { if (app.state().view !== "tasks") await app.go({ view: "tasks" }); setMode("board"); } },
    ];
  }

  return { init, owns, paint, render, startEdit, isOpen: () => Boolean(pop), commands, paintMs: () => lastPaintMs, pure };
})();

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.DelphiTasks.pure;
