// The Cmd+K bar: search everything, run any command, or ask the Oracle.
//
// One box for three jobs, because the old window had three places to type
// (the search field, the Oracle tab, the menus) and people had to know which.
// What is typed decides: "?" first asks the Oracle; a number opens that task;
// anything else searches tasks and notes through the same IPC the search
// field used, and filters the command registry (ui/commands.js) beside them.
//
// A combobox over a listbox, with the focus kept in the box: the arrow keys
// move the highlight, Enter chooses, Tab narrows to the current project or
// widens to all of them, and Esc closes it and nothing behind it.
//
// app.js lends it what it needs (see open()); it reads data only through
// window.delphi.

globalThis.DelphiPalette = (() => {
  let current = null;

  /** Text with each typed word marked, built as nodes rather than markup. */
  function marked(text, words) {
    const frag = document.createDocumentFragment();
    const s = String(text || "");
    if (!words.length) { frag.append(s); return frag; }
    const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
    let last = 0;
    for (const m of s.matchAll(re)) {
      if (m.index > last) frag.append(s.slice(last, m.index));
      frag.append(el("mark", { textContent: m[0] }));
      last = m.index + m[0].length;
    }
    if (last < s.length) frag.append(s.slice(last));
    return frag;
  }

  /**
   * @param app.commands()        the registry
   * @param app.state()           the renderer's state
   * @param app.projectName(id)   a project's name, for the scope chip and rows
   * @param app.openTask(id)      the task's panel
   * @param app.openNote(note)    the note, in its project's Memory
   * @param app.searchAll(q)      the full results page for q
   * @param app.ask(q)            the Oracle's answer to q
   */
  function open(app, { query = "" } = {}) {
    if (current) {
      if (query) { current.input.value = query; current.input.dispatchEvent(new Event("input")); }
      current.input.focus();
      current.input.select();
      return;
    }
    const before = document.activeElement;
    const state = app.state();
    let scope = state.projectId != null ? state.projectId : null;
    let items = [];
    let hi = 0;
    let seq = 0;

    const scrim = el("div", { className: "pal-scrim" });
    const pop = el("div", { className: "pop cmdk", role: "dialog" });
    pop.setAttribute("aria-modal", "true");
    pop.setAttribute("aria-label", "Search, jump, or run a command");
    const input = el("input", { className: "pal-input", placeholder: "Search, jump, or run a command", value: query, spellcheck: false });
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", "pal-list");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-label", "Search, jump, or run a command");
    const chip = el("button", { className: "chip pal-scope", type: "button", title: "Tab: this project or all of them" });
    const list = el("div", { className: "pal-list", id: "pal-list", role: "listbox" });
    list.setAttribute("aria-label", "Results");
    const foot = el("div", { className: "foot" },
      el("span", { className: "hint" }, el("kbd", { textContent: "↑" }), el("kbd", { textContent: "↓" }), " move ",
        el("kbd", { textContent: "Enter" }), " open ", el("kbd", { textContent: "Tab" }), " scope"),
      el("span", { className: "grow" }),
      el("span", { className: "hint" }, "Oracle: ", el("kbd", { textContent: "?" }), " asks a question"));
    pop.append(el("div", { className: "pop-search" }, DelphiIcons.icon("search"), input, chip), list, foot);

    const paintChip = () => {
      chip.textContent = scope == null ? "All projects" : app.projectName(scope) || "This project";
      chip.hidden = state.projectId == null;
    };

    // Back where it was when the bar closes without choosing; a choice moves
    // the focus itself.
    function close({ chose = false } = {}) {
      if (!current) return;
      current = null;
      scrim.remove();
      pop.remove();
      document.body.classList.remove("pop-open");
      document.removeEventListener("keydown", trap, true);
      if (!chose && before && before.isConnected && before.focus) before.focus({ preventScroll: true });
    }

    function choose(i = hi) {
      const item = items[i];
      if (!item) return;
      close({ chose: true });
      item.run();
    }

    /** Moves the highlight without rebuilding the list under the pointer. */
    function light(i) {
      hi = i;
      list.querySelectorAll(".opt").forEach((row) => {
        const on = row.id === `pal-${i}`;
        row.classList.toggle("hi", on);
        row.setAttribute("aria-selected", String(on));
      });
      input.setAttribute("aria-activedescendant", `pal-${i}`);
      const lit = list.querySelector(".opt.hi");
      if (lit) lit.scrollIntoView({ block: "nearest" });
    }

    function paint() {
      list.textContent = "";
      let group = null;
      let box = null;
      items.forEach((item, i) => {
        if (item.group !== group) {
          group = item.group;
          // A labelled group, so the listbox holds options and groups only.
          box = el("div", { className: "pal-group", role: "group" });
          box.setAttribute("aria-label", group);
          const lab = el("div", { className: "lab", textContent: group.toUpperCase() });
          lab.setAttribute("aria-hidden", "true");
          box.append(lab);
          list.append(box);
        }
        const row = el("div", { className: "opt" + (i === hi ? " hi" : ""), id: `pal-${i}`, role: "option" });
        row.setAttribute("aria-selected", String(i === hi));
        const ic = el("span", { className: "ic" });
        ic.append(item.icon ? DelphiIcons.icon(item.icon, "sm") : "");
        const l1 = el("div", { className: "l1" });
        l1.append(marked(item.title, item.words || []));
        const r = el("div", { className: "r" });
        if (item.keys) r.append(el("kbd", { textContent: item.keys }));
        else if (item.right) r.append(item.right);
        row.append(ic, l1, r);
        row.onmousemove = () => { if (hi !== i) light(i); };
        row.onclick = () => choose(i);
        box.append(row);
      });
      if (!items.length) list.append(el("div", { className: "pal-empty", textContent: "Nothing matches. Enter searches everything." }));
      if (items.length) input.setAttribute("aria-activedescendant", `pal-${hi}`);
      else input.removeAttribute("aria-activedescendant");
      const lit = list.querySelector(".opt.hi");
      if (lit) lit.scrollIntoView({ block: "nearest" });
    }

    let moved = false;
    async function update() {
      const mine = ++seq;
      moved = false;
      const q = input.value.trim();
      const words = q.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
      const next = [];
      if (q.startsWith("?")) {
        const ask = q.slice(1).trim();
        next.push({ group: "Oracle", icon: "sparkle", title: ask ? `Ask the Oracle: ${ask}` : "Type a question after the ?", run: () => ask && app.ask(ask) });
        items = next; hi = 0; paint();
        return;
      }
      const num = q.match(/^#?(\d+)$/);
      const byNumber = num ? [{ group: "Tasks", icon: "tasks", title: `Open task #${num[1]}`, run: () => app.openTask(Number(num[1])) }] : [];
      const commands = DelphiCommands.match(app.commands(), q, app.state()).slice(0, q ? 8 : 40).map((c) => ({
        group: c.group, icon: c.place ? "right" : "plus", title: c.title, words,
        keys: c.keys || (c.chord ? `G ${c.chord.toUpperCase()}` : ""), run: c.run,
      }));
      const everything = q ? [{ group: "Search", icon: "search", title: `Search everything for "${q}"`, run: () => app.searchAll(q) }] : [];
      next.push(...byNumber, ...commands, ...everything);
      items = next;
      if (hi >= items.length) hi = 0;
      paint();
      if (!q || q.length < 2) return;

      // Tasks and notes after the commands are drawn, so typing never waits on
      // the search. A slower answer for an older query is dropped.
      let found = null;
      try { found = await window.delphi.search(q); } catch { return; }
      if (mine !== seq || !current) return;
      const inScope = (row) => scope == null || row.project_id === scope;
      const tasks = (found.tasks || []).filter(inScope).slice(0, 6).map((t) => ({
        group: "Tasks", icon: t.status === "done" ? "check" : "tasks", title: `#${t.id} ${t.title}`, words,
        right: el("span", { textContent: t.project_name || app.projectName(t.project_id) || "" }),
        run: () => app.openTask(t.id),
      }));
      const notes = (found.notes || []).filter(inScope).slice(0, 4).map((n) => ({
        group: "Memory", icon: "memory", title: n.title, words,
        right: el("span", { textContent: app.projectName(n.project_id) || "" }),
        run: () => app.openNote(n),
      }));
      // Found work first, then the commands, then the full search, in the
      // order the bar's own example in the design draws them. Unless what was
      // typed is the start of a command's name: "runs" is a trip to Runs far
      // more often than a search for tasks that mention runs.
      const named = commands.some((c) => c.title.toLowerCase().startsWith(q.toLowerCase()));
      // The highlight stays on what it was on when the arrows already moved
      // it, so Enter runs what was chosen rather than what arrived last.
      const was = moved ? items[hi] : null;
      items = named
        ? [...byNumber, ...commands, ...tasks, ...notes, ...everything]
        : [...byNumber, ...tasks, ...notes, ...commands, ...everything];
      hi = was ? Math.max(0, items.indexOf(was)) : 0;
      paint();
    }

    // Capture, so nothing behind the bar sees these keys: app.js's Escape
    // hides the whole window when nothing else is open.
    function trap(e) {
      if (!current) return;
      // Escape while an input method is composing cancels the composition and
      // is the IME's; it must not close the bar, nor reach app.js and hide the
      // window.
      if (e.key === "Escape" && e.isComposing) { e.stopPropagation(); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.target !== input) return;
      if (e.key === "ArrowDown") { e.preventDefault(); moved = true; light(Math.min(items.length - 1, hi + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moved = true; light(Math.max(0, hi - 1)); }
      else if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        // Typed and Enter pressed before the pause: what is listed is for the
        // words before the last few keys, so the list catches up first.
        if (timer) { clearTimeout(timer); timer = null; update(); }
        if (items.length) choose(); else if (input.value.trim()) { close(); app.searchAll(input.value.trim()); }
      } else if (e.key === "Tab") {
        e.preventDefault();
        if (state.projectId != null) { scope = scope == null ? state.projectId : null; paintChip(); update(); }
      }
      e.stopPropagation();
    }

    let timer = null;
    input.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { timer = null; update(); }, 90); };
    chip.onclick = () => { scope = scope == null ? state.projectId : null; paintChip(); update(); input.focus(); };
    scrim.onclick = close;
    document.addEventListener("keydown", trap, true);
    document.body.append(scrim, pop);
    // The top row is a window drag region, which takes clicks before the page
    // does; while the bar is open it has to let the scrim have them.
    document.body.classList.add("pop-open");
    current = { input, close };
    paintChip();
    update();
    input.focus();
    input.select();
  }

  return { open, close: () => current && current.close(), isOpen: () => Boolean(current) };
})();
