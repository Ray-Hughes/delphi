// Memory: the tab, the cards that say why they are there, and Log a fact.
//
// The Memory tab is Direction B's list: one row per note with its kind, its
// number, its title, the project it lives in (or "from <project>" when it is
// shown here from another), and its age. A kind filter and a search sit above
// it; a search says on each row why the row was found. The editable list of
// whole notes is still there, one click away ("Edit notes"), and so is the mind
// map.
//
// Log a fact (Cmd+L, Ctrl+L elsewhere, and Cmd+Shift+L as the plan wrote it) is
// one line. Alt and a letter picks the kind (G gotcha, D decision, R reference,
// N note), Enter saves. With a task open, the fact is linked to it unless Alt+T
// says not, and it is filed from that task's Sheet, so it reads "From task #N"
// and turns up first among the task's related notes. On All projects with no
// task open, it asks which project.
//
// For the drawer, and any other surface that shows memory beside a task:
//
//   DelphiMemory.relatedFor(taskId, { limit })   Promise of cards, best first.
//     Each is { id, title, kind, project, project_id, updated_at, snippet,
//     why, reasons, signal }: why is the few words the card shows, reasons
//     every one that applies. No model is called (agent/recall.js related).
//   DelphiMemory.cards(cards, { onOpen })        a node of memory cards, each
//     with its kind, its reason and its age. onOpen(card) defaults to opening
//     the note.
//   DelphiMemory.mountRelated(node, taskId, { limit, title })
//     both of the above, with a heading, a Log a fact button for that task and
//     an empty state. Resolves to the cards it drew.
//   DelphiMemory.openLogFact({ taskId, projectId })
//
// Data only through window.delphi.memory (main/memory.js). DOM nodes, never
// innerHTML: every string here came from the database.

globalThis.DelphiMemory = (() => {
  const KINDS = [
    { id: "gotcha", label: "Gotcha", key: "g", icon: "alert" },
    { id: "decision", label: "Decision", key: "d", icon: "check" },
    { id: "reference", label: "Reference", key: "r", icon: "link" },
    { id: "note", label: "Note", key: "n", icon: "memory" },
  ];
  const FILTERS = [["all", "All"], ["gotcha", "Gotchas"], ["decision", "Decisions"], ["reference", "References"], ["note", "Notes"]];
  const kindOf = (id) => KINDS.find((k) => k.id === id) || { id: id || "note", label: id || "note", icon: "memory" };

  let app = null;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const icon = (name, size = "sm") => (globalThis.DelphiIcons ? DelphiIcons.icon(name, size) : document.createElement("span"));
  /** "3d", the mockup's age, from timefmt's "3d ago". */
  const age = (value) => {
    const words = globalThis.delphiTime ? delphiTime.ago(value) : "";
    return words === "just now" ? "now" : words.replace(/ ago$/, "");
  };
  const altLabel = (key) => (isMac() ? `⌥${key.toUpperCase()}` : `Alt+${key.toUpperCase()}`);
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(`delphi.memory.${key}`); return v == null ? fallback : v; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(`delphi.memory.${key}`, value); } catch {} },
  };

  /**
   * @param lent.state()            the renderer's state
   * @param lent.refresh()          reload and repaint
   * @param lent.notify(text, o)    a toast
   * @param lent.go(target)         navigate, clearing any search
   * @param lent.openNote(n)        open a note to read and edit it
   * @param lent.openTaskId()       the task open on screen, or null
   * @param lent.taskById(id)       a task row from state, or null
   * @param lent.projectName(id), lent.projectColour(id)
   * @param lent.blocked()          true while a dialog owns the keyboard
   * @param lent.afterFact(result)  after a fact is saved: the open Sheet reloads
   */
  function init(lent) {
    app = lent;
    window.addEventListener("keydown", onShortcut, true);
  }

  // -------------------------------------------------------------------------
  // Pieces every surface shares

  function kindChip(kind) {
    const k = kindOf(kind);
    return el("span", { className: `mm-kind k-${k.id}`, textContent: k.id });
  }

  function whyChip(why, reasons) {
    const chip = el("span", { className: "mm-why", textContent: why });
    // Every reason, not just the one that fits on the card.
    if (reasons && reasons.length > 1) chip.title = reasons.join(". ");
    return chip;
  }

  function projectChip(id, name) {
    const sw = el("span", { className: "mm-sw" });
    sw.style.background = safeColour(app && id != null ? app.projectColour(id) : null);
    return el("span", { className: "mm-proj", title: name || "" }, sw, el("span", { textContent: name || "No project" }));
  }

  /** Shown here from another project: where it lives. */
  function fromChip(id, name) {
    const sw = el("span", { className: "mm-sw" });
    sw.style.background = safeColour(app && id != null ? app.projectColour(id) : null);
    const chip = el("span", { className: "mm-from" }, sw, "from ", el("b", { textContent: name || "no project" }));
    chip.title = `Lives in ${name || "no project"}, and is shown here too.`;
    return chip;
  }

  // -------------------------------------------------------------------------
  // The Memory tab

  let filter = store.get("filter", "all");
  let query = "";
  let found = null;        // { query, scope, notes } from memory:search
  let everyNote = null;    // All projects' list, kept between renders
  let listBox = null;
  let searchTimer = null;

  const scopeKey = (s) => (s.projectId == null ? "all" : String(s.projectId));

  async function render(root) {
    const s = app.state();
    const inProject = s.projectId != null;
    if (!inProject && !everyNote) {
      try { everyNote = await window.delphi.memory.list(null); } catch { everyNote = []; }
    } else if (!inProject) {
      // Kept on screen while the fresh list comes, then repainted if it moved.
      window.delphi.memory.list(null).then((rows) => {
        const was = JSON.stringify(everyNote.map((n) => [n.id, n.updated_at, n.kind, n.title]));
        everyNote = rows;
        if (was !== JSON.stringify(rows.map((n) => [n.id, n.updated_at, n.kind, n.title])) && listBox && listBox.isConnected) paintList();
      }).catch(() => {});
    }
    if (found && found.scope !== scopeKey(s)) { found = null; query = ""; }

    const page = el("div", { className: "mm-page" });
    const bar = el("div", { className: "mm-bar" });

    const seg = el("div", { className: "mm-seg", role: "group" });
    seg.setAttribute("aria-label", "Which kind");
    for (const [id, label] of FILTERS) {
      const b = el("button", { type: "button", textContent: label });
      b.setAttribute("aria-pressed", String(filter === id));
      b.onclick = () => {
        filter = id;
        store.set("filter", id);
        for (const other of seg.children) other.setAttribute("aria-pressed", String(other === b));
        paintList();
      };
      seg.append(b);
    }

    const search = el("label", { className: "mm-search" }, icon("search"));
    const field = el("input", { type: "search", placeholder: inProject ? "Search this project's memory" : "Search all memory", value: query });
    field.setAttribute("aria-label", "Search memory");
    field.oninput = () => {
      query = field.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 180);
    };
    field.onkeydown = (e) => { if (e.key === "Escape" && field.value) { e.stopPropagation(); field.value = ""; query = ""; found = null; paintList(); } };
    search.append(field);

    const log = el("button", { className: "btn sm primary mm-log", type: "button" }, icon("plus"), "Log a fact");
    log.title = `Log a fact (${shortcut("L")})`;
    log.onclick = () => openLogFact();
    const map = el("button", { className: "btn sm ghost", type: "button" }, icon("sparkle"), "Mind map");
    map.onclick = () => app.go({ projectId: null, view: "graph" });
    bar.append(seg, search, el("span", { className: "grow" }), map);
    if (inProject) {
      const edit = el("button", { className: "btn sm ghost", type: "button", textContent: "Edit notes" });
      edit.title = "Every note in full, to read and edit";
      edit.onclick = () => app.go({ view: "notes" });
      bar.append(edit);
    }
    bar.append(log);
    page.append(bar);

    listBox = el("div", { className: "mm-list-wrap" });
    page.append(listBox);
    root.append(page);
    paintList();
  }

  async function runSearch() {
    // The scope as a value, taken now: app.state() is the live state object,
    // so reading s.projectId after the await would see the new project.
    const s = app.state();
    const scope = scopeKey(s);
    const q = query.trim();
    if (!q) { found = null; paintList(); return; }
    try {
      const r = await window.delphi.memory.search(q, s.projectId);
      // Dropped when the question or the scope moved on while it was asked:
      // a project's answer painted into another project reads as its notes.
      if (q !== query.trim() || scopeKey(app.state()) !== scope) return;
      found = { query: q, scope, notes: r.notes || [] };
    } catch (error) {
      if (q !== query.trim() || scopeKey(app.state()) !== scope) return;
      found = { query: q, scope, notes: [], error: error.message || String(error) };
    }
    paintList();
  }

  function rowsNow() {
    const s = app.state();
    const inProject = s.projectId != null;
    if (found) {
      return found.notes.map((n) => ({
        ...n, home_name: n.project, associated: inProject && Number(n.project_id) !== Number(s.projectId) ? 1 : 0,
      }));
    }
    return inProject ? (s.notes || []) : (everyNote || []);
  }

  function paintList() {
    if (!listBox) return;
    const s = app.state();
    const inProject = s.projectId != null;
    const rows = rowsNow().filter((n) => filter === "all" || (n.kind || "note") === filter);
    listBox.replaceChildren();

    if (found && found.error) {
      listBox.append(el("div", { className: "mm-empty" }, el("b", { textContent: "Search did not finish" }), el("p", { textContent: found.error })));
      return;
    }
    if (!rows.length) {
      const what = filter === "all" ? "notes" : FILTERS.find(([id]) => id === filter)[1].toLowerCase();
      const empty = el("div", { className: "mm-empty" });
      if (found) {
        empty.append(el("b", { textContent: `No ${what} match "${found.query}"` }),
          el("p", { textContent: "Search looks at titles and text, the names the graph knows, and meaning when a model is set up." }));
      } else {
        empty.append(el("b", { textContent: filter === "all" ? "Nothing remembered yet" : `No ${what} yet` }),
          el("p", { textContent: "For decisions and why the alternative lost, traps that cost time, and values that are hard to look up again. One line is enough." }));
        const b = el("button", { className: "btn sm", type: "button" }, icon("plus"), "Log a fact");
        b.onclick = () => openLogFact();
        empty.append(b);
      }
      listBox.append(empty);
      return;
    }

    const head = el("div", { className: "mm-count" });
    const borrowed = rows.filter((n) => Number(n.associated)).length;
    head.textContent = found
      ? `${plural(rows.length, "note", "notes")} found for "${found.query}"`
      : `${plural(rows.length, "note", "notes")}${borrowed ? `, ${borrowed} from ${borrowed === 1 ? "another project" : "other projects"}` : ""}`;
    listBox.append(head);

    const box = el("div", { className: "mm-list" });
    for (const n of rows.slice(0, 400)) box.append(row(n, { inProject, why: found ? n.why : null }));
    listBox.append(box);
    if (rows.length > 400) listBox.append(el("div", { className: "mm-count", textContent: `And ${rows.length - 400} more. Search or pick a kind to narrow it.` }));
  }

  /** One note as a row: kind, number, title, then where it lives and its age. */
  function row(n, { inProject, why = null }) {
    const b = el("button", { className: "mm-row", type: "button" });
    b.dataset.row = `note-${n.id}`;
    b.append(kindChip(n.kind), el("span", { className: "mm-id", textContent: `#${n.id}` }),
      el("span", { className: "mm-title", textContent: n.title }));
    if (Number(n.pinned)) b.append(el("span", { className: "mm-pin", title: "Pinned" }, icon("pin", "xs")));
    if (why) b.append(whyChip(why));
    b.append(el("span", { className: "grow" }));
    const meta = el("span", { className: "mm-meta" });
    if (Number(n.associated)) meta.append(fromChip(n.project_id, n.home_name));
    else if (!inProject) meta.append(projectChip(n.project_id, n.home_name));
    meta.append(el("span", { className: "mm-age", textContent: age(n.updated_at) }));
    b.append(meta);
    b.setAttribute("aria-label", `${kindOf(n.kind).label} #${n.id}: ${n.title}${why ? `. ${why}` : ""}`);
    b.onclick = () => app.openNote(n);
    return b;
  }

  /** The heading, from MOUNTS. */
  function paint(s) {
    if (!s || s.query || s.view !== "memory") return;
    const title = $("title");
    const sub = $("subtitle");
    if (!title || !sub) return;
    title.textContent = "Memory";
    sub.textContent = s.projectId != null
      ? `What agents and you concluded in ${app.projectName(s.projectId) || "this project"}, kept past the task.`
      : "What agents and you concluded, across every project, kept past the task.";
  }

  // -------------------------------------------------------------------------
  // Cards with reasons, for a task

  async function relatedFor(taskId, { limit = 6 } = {}) {
    const r = await window.delphi.memory.relatedFor(Number(taskId), { limit });
    return r ? r.notes : [];
  }

  function cards(list, { onOpen = null } = {}) {
    const box = el("div", { className: "mm-cards" });
    for (const c of list) {
      const k = kindOf(c.kind);
      const card = el("button", { className: "mm-card", type: "button" });
      card.dataset.row = `note-${c.id}`;
      const ico = el("span", { className: `mm-ico k-${k.id}` }, icon(k.icon));
      const body = el("span", { className: "mm-card-body" }, el("span", { className: "mm-card-t", textContent: c.title }));
      const said = String(c.snippet || "").trim();
      if (said && !String(c.title).startsWith(said.replace(/…$/, ""))) body.append(el("span", { className: "mm-card-s", textContent: said }));
      const meta = el("span", { className: "mm-card-m" }, kindChip(c.kind), whyChip(c.why, c.reasons));
      if (c.project) meta.append(el("span", { className: "mm-card-p", textContent: c.project }));
      meta.append(el("span", { textContent: age(c.updated_at) }));
      body.append(meta);
      card.append(ico, body);
      card.setAttribute("aria-label", `${k.label}: ${c.title}. ${c.why}`);
      card.onclick = () => (onOpen ? onOpen(c) : app.openNote({ ...c, home_name: c.project }));
      box.append(card);
    }
    return box;
  }

  async function mountRelated(node, taskId, { limit = 6, title = "Related memory", onOpen = null } = {}) {
    const head = el("div", { className: "mm-sec-h" }, el("b", { textContent: title }), el("span", { className: "grow" }));
    const log = el("button", { className: "btn ghost sm", type: "button" }, icon("plus"), "Log a fact");
    log.onclick = () => openLogFact({ taskId: Number(taskId) });
    head.append(log);
    const slot = el("div", { className: "mm-cards-slot" });
    node.replaceChildren(head, slot);
    let list = [];
    try { list = await relatedFor(taskId, { limit }); } catch (error) {
      slot.append(el("div", { className: "mm-empty sm" }, el("p", { textContent: `Could not read related memory: ${error.message || error}` })));
      return [];
    }
    if (!list.length) {
      slot.append(el("div", { className: "mm-empty sm" }, el("b", { textContent: "Nothing remembered yet" }),
        el("p", { textContent: "Facts logged on this task, and notes that share its files, names or words, collect here." })));
      return [];
    }
    slot.append(cards(list, { onOpen }));
    return list;
  }

  // -------------------------------------------------------------------------
  // Log a fact

  let fact = null;   // the open dialog: { overlay, field, close }
  let opening = false;

  function onShortcut(e) {
    if (!app || !modKey(e) || e.altKey || String(e.key || "").toLowerCase() !== "l") return;
    // Behind a Focus break nothing opens: a window-level listener runs ahead of Focus's own.
    if (window.DelphiFocus && DelphiFocus.onBreak()) return;
    // A terminal's own: Ctrl+L clears the screen there, on Windows and Linux.
    if (e.target && e.target.closest && e.target.closest(".xterm")) return;
    if (fact) { e.preventDefault(); e.stopPropagation(); fact.field.focus(); return; }
    if (app.blocked() || window.DelphiPalette?.isOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    openLogFact();
  }

  async function openLogFact({ taskId = undefined, projectId = undefined } = {}) {
    if (fact) { fact.field.focus(); return; }
    // Set before the await below: a quick second Cmd+L would otherwise find
    // no dialog yet and open a second one under the first.
    if (opening) return;
    opening = true;
    try { await buildLogFact({ taskId, projectId }); } finally { opening = false; }
  }

  async function buildLogFact({ taskId, projectId }) {
    const s = app.state();
    const tid = taskId !== undefined ? taskId : app.openTaskId();
    let task = tid != null ? app.taskById(tid) : null;
    if (tid != null && !task) {
      try { const d = await window.delphi.tasks.detail(Number(tid)); task = d && d.task; } catch { task = null; }
    }
    let kind = KINDS.some((k) => k.id === store.get("kind", "")) ? store.get("kind", "note") : "note";
    let linked = Boolean(task);
    const homeProject = projectId !== undefined ? projectId : s.projectId;
    const returnTo = document.activeElement;

    const overlay = el("div", { className: "overlay mm-fact-overlay" });
    const box = el("div", { className: "mm-fact", role: "dialog" });
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Log a fact");

    const field = el("input", { className: "mm-fact-in", type: "text", maxLength: 2000,
      placeholder: "One line worth keeping: a trap, a decision, where something is" });
    field.setAttribute("aria-label", "The fact");
    const line = el("div", { className: "mm-fact-line" }, icon("memory"), field,
      el("span", { className: "mm-key", textContent: "Enter" }));

    const kinds = el("div", { className: "mm-fact-kinds", role: "radiogroup" });
    kinds.setAttribute("aria-label", "Kind");
    const paintKinds = () => {
      kinds.replaceChildren();
      for (const k of KINDS) {
        const b = el("button", { type: "button", className: `mm-fact-kind k-${k.id}` },
          icon(k.icon, "xs"), k.label, el("span", { className: "mm-key", textContent: altLabel(k.key) }));
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(kind === k.id));
        b.onclick = () => { kind = k.id; paintKinds(); field.focus(); };
        kinds.append(b);
      }
    };
    paintKinds();

    // Where it goes: the open task's project, this project, or a choice.
    const where = el("div", { className: "mm-fact-where" });
    let picker = null;
    const paintWhere = () => {
      where.replaceChildren();
      if (task) {
        const box2 = el("input", { type: "checkbox", checked: linked });
        box2.onchange = () => { linked = box2.checked; paintWhere(); field.focus(); };
        where.append(el("label", { className: "mm-fact-link" }, box2, "Link to ",
          el("b", { textContent: `#${task.id}` }), " ", el("span", { className: "mm-fact-task", textContent: task.title }),
          el("span", { className: "mm-key", textContent: altLabel("t") })));
      }
      const target = task && linked ? task.project_id : homeProject;
      if (target != null) {
        where.append(el("span", { className: "mm-fact-to" }, "Saves to ", projectChip(target, app.projectName(target))));
      } else {
        picker = el("select", { className: "mm-fact-pick" });
        picker.setAttribute("aria-label", "Which project");
        picker.append(el("option", { value: "", textContent: "Which project?" }));
        for (const p of (s.projects || []).filter((x) => !x.archived)) picker.append(el("option", { value: String(p.id), textContent: p.name }));
        const last = store.get("project", "");
        if (last && [...picker.options].some((o) => o.value === last)) picker.value = last;
        where.append(el("span", { className: "mm-fact-to" }, "Saves to ", picker));
      }
    };
    paintWhere();

    const msg = el("div", { className: "mm-fact-msg", role: "status" });
    const hint = el("div", { className: "mm-fact-hint", textContent: `${isMac() ? "⌥" : "Alt+"} and a letter picks the kind. Enter saves, Escape closes.` });
    box.append(line, kinds, where, msg, hint);
    overlay.append(box);

    let busy = false;
    const close = () => {
      if (!fact) return;
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      fact = null;
      if (returnTo && returnTo.isConnected && returnTo.focus) returnTo.focus();
    };
    const save = async () => {
      if (busy) return;
      const text = field.value.trim();
      if (!text) { msg.textContent = "Type the fact first."; msg.classList.add("err"); field.focus(); return; }
      const toTask = task && linked ? Number(task.id) : null;
      let pid = toTask ? null : homeProject;
      if (!toTask && pid == null) {
        pid = picker && picker.value ? Number(picker.value) : null;
        if (pid == null) { msg.textContent = "Pick the project it belongs to."; msg.classList.add("err"); picker && picker.focus(); return; }
      }
      busy = true;
      msg.classList.remove("err");
      msg.textContent = "Saving";
      try {
        const r = await window.delphi.memory.logFact({ text, kind, projectId: pid, taskId: toTask });
        store.set("kind", kind);
        if (pid != null && !toTask && homeProject == null) store.set("project", String(pid));
        close();
        const home = app.projectName(r.note.project_id) || "the project";
        app.notify(`Logged a ${kind} in ${home}${r.taskId ? `, from #${r.taskId}` : ""}.`);
        everyNote = null;
        if (app.afterFact) await app.afterFact(r);
        await app.refresh();
      } catch (error) {
        busy = false;
        msg.textContent = String((error && error.message) || error).replace(/^Error: /, "");
        msg.classList.add("err");
        field.focus();
      }
    };

    // On the window, in the capture phase: ahead of the task sheet's Escape
    // and the window's own, so Escape closes this and nothing under it.
    const onKey = (e) => {
      if (!fact) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
      // Enter on a kind, the link box or the project list is that control's own.
      const own = e.target && (e.target === picker || /^(BUTTON|SELECT)$/.test(e.target.tagName) || e.target.type === "checkbox");
      if (e.key === "Enter" && !e.isComposing && !own) { e.preventDefault(); e.stopImmediatePropagation(); save(); return; }
      if (e.altKey && !e.metaKey && !e.ctrlKey) {
        // The code, not the key: on a Mac, Alt+G types a copyright sign.
        const letter = /^Key([A-Z])$/.exec(e.code || "");
        const k = letter && letter[1].toLowerCase();
        const pick = KINDS.find((x) => x.key === k);
        if (pick) { e.preventDefault(); e.stopImmediatePropagation(); kind = pick.id; paintKinds(); return; }
        if (k === "t" && task) { e.preventDefault(); e.stopImmediatePropagation(); linked = !linked; paintWhere(); return; }
      }
    };
    window.addEventListener("keydown", onKey, true);
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    document.body.append(overlay);
    fact = { overlay, field, close, save };
    field.focus();
  }

  function commands() {
    return [
      { id: "log-fact", group: "Commands", title: "Log a fact", keys: shortcut("L"),
        keywords: "memory remember gotcha decision reference note capture", run: () => openLogFact() },
    ];
  }

  return { init, render, paint, commands, openLogFact, relatedFor, cards, mountRelated, KINDS, isOpen: () => Boolean(fact) };
})();
