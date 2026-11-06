// The top of the window: the project switcher, the Cmd+K bar, and the tabs.
//
// Direction B has no rail and no sidebar. What the sidebar held moves here:
// the projects into the switcher (pinned first, then recent, then by folder,
// then those with no folder), the places into the six tabs, and a project's
// AI sessions into a menu beside the Chat tab. Everything else is one Cmd+K
// away (ui/palette.js). The sidebar's code is left in app.js, unused, until
// the cleanup slice, so going back is one line in render().
//
// render() calls paint() on every repaint, so it is cheap and keeps whatever
// is open: a popover being typed into is never rebuilt under the person.
//
// The switcher and the sessions menu are listboxes: the arrow keys move, Enter
// chooses, Esc closes, and the focus goes back to the button that opened them.

globalThis.DelphiTopbar = (() => {
  const I = (name, size) => DelphiIcons.icon(name, size);
  const RECENT = "delphi.recentProjects";
  const NO_FOLDER_SHOWN = 6;
  let app = null;
  let pop = null;          // { kind, node, button, repaint }
  let lastProject = undefined;

  const readRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT) || "[]").filter(Number.isFinite); } catch { return []; } };
  function noteRecent(id) {
    if (id == null) return;
    const list = [id, ...readRecent().filter((x) => x !== id)].slice(0, 8);
    try { localStorage.setItem(RECENT, JSON.stringify(list)); } catch {}
  }

  /** A project's square: its colour and first letter, or All projects' mark. */
  function square(p, size = "") {
    const sq = el("span", { className: `sq${size ? ` ${size}` : ""}` });
    if (!p) {
      sq.classList.add("all");
      sq.append(I("sparkle", "xs"));
      return sq;
    }
    sq.style.background = safeColour(p.colour, "var(--accent)");
    sq.textContent = (String(p.name || "?").trim()[0] || "?").toUpperCase();
    return sq;
  }
  const folderName = (path) => String(path || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();

  // --- the switcher -----------------------------------------------------------

  function switcherButton(state) {
    const p = state.projects.find((x) => x.id === state.projectId) || null;
    const b = el("button", { className: "scope" + (pop && pop.kind === "switcher" ? " open" : ""), type: "button" });
    b.setAttribute("aria-haspopup", "listbox");
    b.setAttribute("aria-expanded", String(Boolean(pop && pop.kind === "switcher")));
    b.title = `Switch project (${shortcut("P")})`;
    const chip = p
      ? (p.path ? el("span", { className: "chip mono", title: p.path }, I("folder", "xs"), folderName(p.path)) : el("span", { className: "chip quiet", textContent: "No folder" }))
      : el("span", { className: "chip", textContent: `${state.projects.length} projects` });
    b.append(square(p), el("span", { className: "nm", textContent: p ? p.name : "All projects" }), chip, I("down", "sm"));
    b.onclick = () => (pop && pop.kind === "switcher" ? closePop() : openSwitcher(b));
    return b;
  }

  function projectRow(p, state, { onPick, counts }) {
    const on = state.projectId === p.id;
    const row = el("div", { className: "opt" + (on ? " cur" : ""), role: "option", tabIndex: -1 });
    if (on) row.setAttribute("aria-current", "true");
    row.dataset.pick = String(p.id);
    const l1 = el("div", { className: "l1" }, el("span", { className: "nm", textContent: p.name }));
    if (on) l1.append(el("span", { className: "on" }, I("check", "xs")));
    const l2 = el("div", { className: "l2" });
    if (p.path) l2.append(I("folder", "xs"), el("span", { className: "mono", textContent: tilde(p.path) }));
    else l2.append(el("span", { textContent: p.summary ? `No folder · ${p.summary}` : "No folder" }));
    const r = el("div", { className: "r" });
    const agents = counts.running.get(p.id) || 0;
    if (agents) r.append(el("span", { className: "agents", title: `${agents} working here now` }, el("span", { className: "live-dot" }), String(agents)));
    r.append(el("span", { textContent: `${p.open_count || 0} open` }));
    const late = counts.late.get(p.id) || 0;
    if (late) r.append(el("span", { className: "tag red", title: `${late} late`, textContent: String(late) }));
    const more = el("button", { className: "icon-btn more", type: "button", title: "Overview, settings, pin, archive" }, I("more", "sm"));
    more.setAttribute("aria-label", `More for ${p.name}`);
    more.onclick = (e) => { e.stopPropagation(); app.projectMenu(p, more); };
    r.append(more);
    row.append(square(p), el("div", { className: "txt" }, l1, l2), r);
    row.onclick = () => onPick(p.id);
    return row;
  }

  function openSwitcher(button = document.querySelector("#switcher .scope")) {
    closePop();
    const node = el("div", { className: "pop switcher", role: "dialog" });
    node.setAttribute("aria-label", "Switch project");
    const find = el("input", { className: "pop-find", placeholder: "Find a project or folder", spellcheck: false });
    find.setAttribute("role", "combobox");
    find.setAttribute("aria-controls", "switcher-list");
    find.setAttribute("aria-expanded", "true");
    find.setAttribute("aria-label", "Find a project or folder");
    const listBox = el("div", { className: "pop-body", id: "switcher-list", role: "listbox" });
    listBox.setAttribute("aria-label", "Projects");
    let showAllUnlinked = false;
    const foot = el("div", { className: "foot" });
    const fresh = el("button", { className: "btn sm", type: "button" }, I("plus", "sm"), "New project without a folder");
    fresh.onclick = () => { closePop(); app.newProject(); };
    foot.append(fresh);
    // Slice 4's module, once it exists. Until then the entry is not shown at
    // all, rather than shown and doing nothing.
    if (globalThis.DelphiAddFolder) {
      const add = el("button", { className: "btn sm", type: "button" }, I("folderplus", "sm"), "Add folder as project...");
      add.onclick = () => { closePop(); globalThis.DelphiAddFolder.open(); };
      foot.prepend(add);
    }
    node.append(el("div", { className: "pop-search" }, I("search", "sm"), find, el("kbd", { textContent: modLabel() }), el("kbd", { textContent: "P" })), listBox, foot);

    // The same place in the new scope, where there is one: the tab that is
    // lit, mapped the way the tab itself maps it. Elsewhere, the start.
    const pick = (id) => {
      closePop();
      const now = app.state();
      const tab = DelphiCommands.tabOf(now);
      const there = { ...now, projectId: id };
      const target = tab && tab !== "today" && tab !== "runs" ? DelphiCommands.tabTarget(tab, there, () => id) : null;
      app.go({ ...(target || { view: id == null ? "new" : "overview" }), projectId: id });
    };

    function paintList() {
      const state = app.state();
      // Once per paint, not once per row: see app.js.
      const counts = { running: app.runningByProject(), late: app.lateByProject() };
      const q = find.value.trim().toLowerCase();
      const hit = (p) => !q || p.name.toLowerCase().includes(q) || String(p.path || "").toLowerCase().includes(q) || String(p.key || "").toLowerCase().includes(q);
      listBox.textContent = "";
      const seen = new Set();
      const group = (label, projects, right = null) => {
        const shown = projects.filter((p) => p && !seen.has(p.id) && hit(p));
        if (!shown.length) return [];
        listBox.append(el("div", { className: "lab" }, label, el("span", { className: "grow" }), right ? el("span", { className: "lab-note", textContent: right }) : ""));
        const items = el("div", { className: "items" });
        listBox.append(items);
        for (const p of shown) seen.add(p.id);
        return [items, shown];
      };

      if (!q || "all projects".includes(q)) {
        const all = el("div", { className: "items" });
        const on = state.projectId == null;
        const row = el("div", { className: "opt" + (on ? " cur" : ""), role: "option", tabIndex: -1 });
        if (on) row.setAttribute("aria-current", "true");
        const open = state.projects.reduce((n, p) => n + (p.open_count || 0), 0);
        const l1 = el("div", { className: "l1" }, el("span", { className: "nm", textContent: "All projects" }));
        if (on) l1.append(el("span", { className: "on" }, I("check", "xs")));
        row.append(square(null), el("div", { className: "txt" }, l1, el("div", { className: "l2", textContent: `Everything, across ${state.projects.length} projects` })),
          el("div", { className: "r" }, el("span", { textContent: `${open} open` })));
        row.onclick = () => pick(null);
        all.append(row);
        listBox.append(all);
      }
      const byId = new Map(state.projects.map((p) => [p.id, p]));
      const draw = ([items, shown] = []) => { if (items) for (const p of shown) items.append(projectRow(p, state, { onPick: pick, counts })); };
      draw(group("PINNED", (state.pinned || []).map((id) => byId.get(id))));
      draw(group("RECENT", readRecent().filter((id) => id !== state.projectId).slice(0, 4).map((id) => byId.get(id))));
      draw(group("FOLDERS", state.projects.filter((p) => p.path), "A project is a folder"));
      const unlinked = state.projects.filter((p) => !p.path);
      const g = group("NO FOLDER", unlinked);
      if (g.length) {
        const [items, shown] = g;
        const cut = q || showAllUnlinked ? shown : shown.slice(0, NO_FOLDER_SHOWN);
        for (const p of cut) items.append(projectRow(p, state, { onPick: pick, counts }));
        if (cut.length < shown.length) {
          const more = el("div", { className: "opt more-row", role: "option", tabIndex: -1, textContent: `${shown.length - cut.length} more` });
          more.onclick = () => { showAllUnlinked = true; paintList(); };
          items.append(more);
        }
      }
      if (!listBox.querySelector(".opt")) listBox.append(el("div", { className: "pal-empty", textContent: "No project or folder by that name." }));
      highlight(listBox, 0, find);
    }

    find.oninput = paintList;
    find.onkeydown = (e) => listKeys(e, listBox, find);
    pop = { kind: "switcher", node, button, repaint: paintList };
    document.body.classList.add("pop-open");
    document.body.append(node);
    place(node, button);
    paintList();
    find.focus();
    paintTop();
  }

  // --- the AI sessions menu ------------------------------------------------------

  function openSessions(button) {
    closePop();
    const node = el("div", { className: "pop sessions-pop", role: "dialog" });
    node.setAttribute("aria-label", "AI sessions");
    const body = el("div", { className: "pop-body" });
    node.append(body);
    // Repainted when the list changes, with the focus put back on the same
    // row, so a session appearing never throws someone out of the menu.
    const repaint = () => {
      const row = node.contains(document.activeElement) ? document.activeElement.closest("[data-row]")?.dataset.row : null;
      body.textContent = "";
      body.append(app.sessionKids());
      if (row) body.querySelector(`[data-row="${row}"]`)?.focus({ preventScroll: true });
    };
    node.onkeydown = (e) => { if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); e.stopPropagation(); closePop(); } };
    pop = { kind: "sessions", node, button, repaint };
    document.body.classList.add("pop-open");
    document.body.append(node);
    repaint();
    place(node, button, "right");
    body.querySelector("[tabindex]")?.focus();
  }

  // --- popover plumbing -------------------------------------------------------

  function place(node, button, align = "left") {
    if (!button) return;
    const r = button.getBoundingClientRect();
    node.style.top = `${Math.round(r.bottom + 6)}px`;
    if (align === "right") node.style.right = `${Math.round(window.innerWidth - r.right)}px`;
    else node.style.left = `${Math.round(r.left)}px`;
  }

  function closePop() {
    if (!pop) return;
    const { node, button } = pop;
    pop = null;
    node.remove();
    document.body.classList.remove("pop-open");
    paintTop();
    if (button && button.isConnected) button.focus({ preventScroll: true });
  }

  /** The highlight, told to assistive tech through the box it is driven from. */
  function highlight(box, i, owner = null) {
    const opts = [...box.querySelectorAll(".opt")];
    opts.forEach((o, n) => {
      if (!o.id) o.id = `sw-opt-${n}`;
      o.classList.toggle("hi", n === i);
      o.setAttribute("aria-selected", String(n === i));
    });
    const lit = opts[i];
    if (lit) lit.scrollIntoView({ block: "nearest" });
    if (owner) { if (lit) owner.setAttribute("aria-activedescendant", lit.id); else owner.removeAttribute("aria-activedescendant"); }
  }
  function listKeys(e, box, owner) {
    const opts = [...box.querySelectorAll(".opt")];
    const at = opts.findIndex((o) => o.classList.contains("hi"));
    if (e.key === "ArrowDown") { e.preventDefault(); highlight(box, Math.min(opts.length - 1, at + 1), owner); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlight(box, Math.max(0, at - 1), owner); }
    else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); opts[Math.max(0, at)]?.click(); }
    else if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); e.stopPropagation(); closePop(); }
  }

  // Escape closes a popover wherever the focus is. Without this, after a click
  // left the focus on the page, it reached app.js, whose Escape hides the window.
  document.addEventListener("keydown", (e) => {
    // During an IME composition Escape is the input method's: kept from
    // app.js (which would hide the window) but not acted on.
    if (pop && e.key === "Escape" && e.isComposing) { e.stopPropagation(); return; }
    if (pop && e.key === "Escape" && !document.querySelector(".ctx")) {
      e.preventDefault();
      e.stopPropagation();
      closePop();
    }
  }, true);

  // A click outside an open popover closes it, the way every menu here does.
  document.addEventListener("mousedown", (e) => {
    if (!pop) return;
    if (pop.node.contains(e.target) || (pop.button && pop.button.contains(e.target))) return;
    // The project menu a "..." opens lives outside the popover and acts on it.
    if (e.target.closest && e.target.closest(".row-menu, .menu, .ctx")) return;
    closePop();
  }, true);

  // --- the bar, the tabs and the right-hand buttons ------------------------------

  function paintTop() {
    if (!app) return;
    const state = app.state();
    const sw = document.getElementById("switcher");
    if (!sw) return;
    const had = sw.contains(document.activeElement);
    sw.textContent = "";
    const b = switcherButton(state);
    sw.append(b);
    if (pop && pop.kind === "switcher") pop.button = b;
    if (had) b.focus({ preventScroll: true });
  }

  function paintBar() {
    const bar = document.getElementById("bar");
    if (!bar || bar.firstChild) return;
    const b = el("button", { className: "searchbtn", type: "button" }, I("search", "sm"),
      el("span", { className: "grow", textContent: "Search, jump, or run a command" }), el("kbd", { textContent: modLabel() }), el("kbd", { textContent: "K" }));
    b.setAttribute("aria-label", `Search, jump, or run a command (${isMac() ? "Command" : "Control"} K)`);
    b.onclick = () => app.openBar();
    bar.append(b);
  }

  function paintActs(state) {
    const box = document.getElementById("top-acts");
    if (!box) return;
    box.textContent = "";
    const iconBtn = (name, title, run, badge = null) => {
      const b = el("button", { className: "icon-btn", type: "button", title }, I(name));
      b.setAttribute("aria-label", title);
      if (badge) b.append(el("span", { className: "n", textContent: String(badge) }));
      b.onclick = run;
      return b;
    };
    const waiting = app.needsYou();
    box.append(
      iconBtn("inbox", waiting ? `Needs you: ${waiting}` : "Needs you", () => app.go({ projectId: null, view: "inbox" }), waiting || null),
      iconBtn("gear", `Settings (${shortcut(",")})`, () => app.openSettings()),
      iconBtn(app.themeIs() === "dark" ? "sun" : "moon", app.themeIs() === "dark" ? "Switch to light" : "Switch to dark", () => app.toggleTheme()));
    const neu = el("button", { className: "btn primary", type: "button", title: `New task (${shortcut("N")})` }, I("plus", "sm"),
      el("span", { className: "neu-label", textContent: "New" }), el("kbd", { textContent: shortcut("N") }));
    neu.setAttribute("aria-label", "New task");
    neu.onclick = () => app.newTask();
    box.append(neu);
  }

  function paintTabs(state) {
    const box = document.getElementById("viewtabs");
    if (!box) return;
    // Rebuilt on every render, so the focus is carried across by name: a
    // keyboard user who chose a tab is still on it afterwards.
    const focused = box.contains(document.activeElement) ? document.activeElement.dataset.tab || null : null;
    box.textContent = "";
    const current = DelphiCommands.tabOf(state);
    for (const t of DelphiCommands.TABS) {
      // Buttons that go places, not ARIA tabs: there is no tab panel to name.
      const b = el("button", { className: "vt" + (current === t.id ? " on" : ""), type: "button", textContent: t.label });
      b.dataset.tab = t.id;
      if (current === t.id) b.setAttribute("aria-current", "page");
      b.title = `G then ${t.chord.toUpperCase()}`;
      const n = app.tabCount(t.id);
      if (n) b.append(el("span", { className: t.id === "today" ? "count hot" : "count", textContent: String(n) }));
      b.onclick = () => app.goTab(t.id);
      box.append(b);
    }
    box.append(el("span", { className: "grow" }));
    if (state.view === "chat" && state.projectId != null) {
      const s = el("button", { className: "btn sm ghost sessions-btn", type: "button" }, "AI sessions", I("down", "xs"));
      s.dataset.tab = "sessions";
      s.setAttribute("aria-haspopup", "dialog");
      s.onclick = () => (pop && pop.kind === "sessions" ? closePop() : openSessions(s));
      box.append(s);
      if (pop && pop.kind === "sessions") pop.button = s;
    } else if (pop && pop.kind === "sessions") {
      // Its project's chat is no longer what is showing.
      closePop();
    }
    box.append(el("span", { className: "hint keys-hint" }, el("kbd", { textContent: "G" }), " then ",
      ...DelphiCommands.TABS.map((t) => el("kbd", { textContent: t.chord.toUpperCase() }))));
    if (focused) box.querySelector(`[data-tab="${focused}"]`)?.focus({ preventScroll: true });
  }

  /** On every render. Cheap, and never rebuilds an open popover. */
  function paint() {
    if (!app) return;
    const state = app.state();
    if (state.projectId !== lastProject) { noteRecent(state.projectId); lastProject = state.projectId; }
    paintTop();
    paintBar();
    paintActs(state);
    paintTabs(state);
    // New sessions show up in an open menu; repaint keeps the focus where it was.
    if (pop && pop.kind === "sessions" && pop.repaint) pop.repaint();
  }

  function init(lent) { app = lent; }

  return {
    init, paint, openSwitcher: () => openSwitcher(),
    /** A session list toggle inside the menu repaints the menu, not the old sidebar. */
    refreshSessions: () => { if (pop && pop.kind === "sessions") pop.repaint(); },
    closePop, isOpen: () => Boolean(pop),
  };
})();
