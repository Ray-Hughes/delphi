// Today, the home tab: what is on today, what needs you, what went quiet, and
// what happened while you were away.
//
// Direction B's Today, with the earlier Layout A's capture line and its "up
// next" card. Top to bottom:
//   - quick capture, which files a task without leaving the page
//   - While you were away: the daily brief, grouped by task (today/brief.js)
//   - Needs you: the rows the Needs you page draws, lent by app.js
//   - one banner, for the single most important task with no movement
//   - Your day: overdue, due today and in progress, in Focus order, with the
//     first of them as "Up next" and a Start focus entry
//   - Gone quiet: every stuck task, fading toward grey the longer it sits
//
// The rules (what counts as stuck, which task the banner names, what goes in
// the brief) are all today/brief.js, behind today:view in main/today.js, so
// the window and an agent's daily_brief cannot disagree. This file only draws.
//
// Painted from the last answer it had, synchronously, and asks again in the
// background at most every few seconds: Today is a home view, so every run
// that reports progress repaints it, and an IPC round trip on each of those
// would make the page flicker and the database work for nothing.

globalThis.DelphiToday = (() => {
  const I = (name, size) => DelphiIcons.icon(name, size);
  let app = null;

  let data = null;
  let loadedAt = 0;
  let loading = null;
  let sig = "";
  const STALE_MS = 3000;

  let draft = "";
  let captureBusy = false;
  let captureMsg = null;
  const lineMsg = new Map();
  let bannerMsg = null;
  let bannerBusy = false;

  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(`delphi.today.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(`delphi.today.${key}`, JSON.stringify(value)); } catch {} },
  };
  let briefOpen = store.get("briefOpen", false);
  // A dismissed banner is dismissed for that stretch of quiet: the task id and
  // when it last moved. If it moves and then goes quiet again, it may come back.
  const bannerKey = (b) => `${b.id}:${b.last_at}`;

  function init(lent) { app = lent; }

  const onToday = () => { const s = app && app.state(); return Boolean(s && !s.query && !s.projectId && s.view === "today"); };

  // What a repaint compares, without the brief's end, which is "now" and so
  // differs every time: compared with it, every fetch would repaint.
  const sigOf = (d) => JSON.stringify({ ...d, brief: d && d.brief ? { ...d.brief, until: null } : null });

  /**
   * The newest line on screen, else the end of the window shown: where Mark
   * as seen starts the next brief. Mirrors today/brief.js seenUpTo, which the
   * window cannot require.
   */
  function shownUpTo() {
    const b = data && data.brief;
    if (!b) return null;
    let newest = null;
    for (const g of b.groups || []) for (const l of g.lines || []) if (!newest || String(l.at) > newest) newest = String(l.at);
    return newest || b.until || null;
  }

  /** Asks main for the stuck tasks and the brief; repaints only when they changed. */
  function load({ force = false } = {}) {
    if (loading) return loading;
    if (!force && data && Date.now() - loadedAt < STALE_MS) return Promise.resolve(data);
    loading = (async () => {
      try {
        const next = await window.delphi.today.view({});
        loadedAt = Date.now();
        const nextSig = sigOf(next);
        const changed = nextSig !== sig;
        sig = nextSig;
        data = next;
        if (changed && onToday()) app.repaint();
      } catch (error) {
        loadedAt = Date.now();
        if (!data) data = { error: String(error && error.message ? error.message : error), stuck: [], brief: null, banner: null };
      } finally {
        loading = null;
      }
      return data;
    })();
    return loading;
  }

  // -------------------------------------------------------------------------
  // Small pieces

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const msOf = (text) => {
    const s = String(text || "").trim();
    if (!s) return NaN;
    return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  };
  const short = (text) => {
    const ms = msOf(text);
    if (!Number.isFinite(ms)) return "";
    const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    if (mins < 1440) return `${Math.round(mins / 60)}h`;
    return `${Math.round(mins / 1440)}d`;
  };
  const sinceWords = (text) => {
    const ms = msOf(text);
    if (!Number.isFinite(ms)) return "";
    const d = new Date(ms);
    const day = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `since ${day}, ${time}`;
  };
  const button = (text, cls = "btn sm", props = {}) => el("button", { className: cls, type: "button", textContent: text, ...props });
  const iconButton = (icon, label, cls = "btn sm") => {
    const b = el("button", { className: `${cls} td-ib`, type: "button" }, I(icon, "sm"), el("span", { textContent: label }));
    return b;
  };
  const errOf = (e) => String(e && e.message ? e.message : e);

  /** The mark on a row: amber "Idle 4d" or red "9d", always words as well as colour. */
  function stuckTag(s) {
    if (!s) return null;
    const t = el("span", { className: `td-tag ${s.level}`, textContent: s.mark, title: s.words });
    t.setAttribute("aria-label", s.words);
    return t;
  }

  /**
   * How far a quiet task has faded, 0 at three days and all the way at thirty,
   * the way Linear lets a stale issue go grey rather than shouting about it.
   */
  const fadeOf = (s) => (s ? Math.max(0, Math.min(1, (s.days - 3) / 27)) : 0);

  const STATUS_WORD = { todo: "To do", doing: "In progress", review: "In review", blocked: "Blocked", done: "Done" };
  const statusWord = (status) => STATUS_WORD[status] || "In progress";

  /** One task as a row you can click: status, number, title, project, marks, age. */
  function taskRow(t, { stuck = null, tags = [], age = null } = {}) {
    const row = el("button", { className: "td-row", type: "button" });
    row.dataset.row = `today-${t.id}`;
    const status = STATUS_WORD[t.status] ? t.status : "doing";
    const dot = el("span", { className: `td-st ${status}`, title: statusWord(t.status) });
    dot.setAttribute("aria-hidden", "true");
    row.append(dot, el("span", { className: "td-id", textContent: `#${t.id}` }),
      el("span", { className: "td-title", textContent: t.title }));
    if (t.project_name) row.append(el("span", { className: "td-proj", textContent: t.project_name }));
    row.append(el("span", { className: "grow" }));
    for (const tag of tags) if (tag) row.append(tag);
    if (stuck) {
      row.classList.add("quiet", stuck.level);
      row.style.setProperty("--td-fade", `${Math.round(fadeOf(stuck) * 100)}%`);
      row.append(stuckTag(stuck));
    } else if (age) {
      row.append(el("span", { className: "td-age", textContent: age }));
    }
    row.setAttribute("aria-label", `#${t.id} ${t.title}, ${statusWord(t.status)}${stuck ? `, ${stuck.words}` : ""}`);
    row.onclick = () => app.openTask(t.id);
    return row;
  }

  /** A task in review, under Needs you: what it is and how long it has waited on you. */
  function reviewTaskRow(t) {
    const tag = el("span", { className: "td-tag review", textContent: t.days ? `Review ${t.days}d` : "Review", title: t.words });
    tag.setAttribute("aria-label", t.words);
    const row = taskRow(t, { tags: [tag] });
    row.setAttribute("aria-label", `#${t.id} ${t.title}, in review. ${t.words}`);
    return row;
  }

  function section(title, count, hint, ...nodes) {
    const head = el("div", { className: "td-h" }, el("h2", { textContent: title }));
    if (count != null) head.append(el("span", { className: "td-n", textContent: String(count) }));
    if (hint) head.append(typeof hint === "string" ? el("span", { className: "td-hint", textContent: hint }) : hint);
    return el("section", { className: "td-sec" }, head, ...nodes);
  }

  // -------------------------------------------------------------------------
  // What is on today, in Focus order

  const dueState = (t) => (t.due ? TIME.dueState(t.due) : null);
  const PRI = { high: 0, med: 1, low: 2 };
  const pri = (t) => PRI[t.priority] ?? 1;
  /** Yours or nobody's: Today is your day, and an agent's work is on Runs. */
  const mine = (t) => !app.isAgent(t.assignee || t.owner || "");

  /**
   * The Focus queue: overdue first (the oldest due date first), then due
   * today, then in progress that is yours or unowned; priority breaks ties.
   * Until Focus mode exists this order is the whole of it, and Start focus
   * opens the first.
   */
  function focusQueue(tasks) {
    const open = tasks.filter((t) => t.status !== "done" && !t.parent_id);
    const seen = new Set();
    const take = (list) => list.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
    const overdue = take(open.filter((t) => dueState(t) === "overdue")
      .sort((a, b) => String(a.due).localeCompare(String(b.due)) || pri(a) - pri(b)));
    const due = take(open.filter((t) => dueState(t) === "today").sort((a, b) => pri(a) - pri(b) || a.id - b.id));
    // Not review: that is finished work waiting on your look, and it is under
    // Needs you, not in the queue of things you are doing.
    const doing = take(open.filter((t) => !["todo", "review", "blocked", "done"].includes(t.status) && mine(t))
      .sort((a, b) => pri(a) - pri(b) || String(b.updated_at).localeCompare(String(a.updated_at))));
    return [...overdue.map((t) => ({ t, why: "overdue" })), ...due.map((t) => ({ t, why: "due" })), ...doing.map((t) => ({ t, why: "doing" }))];
  }

  function whyTag(item) {
    if (item.why === "overdue") {
      const days = Math.max(1, Math.round((Date.now() - new Date(`${TIME.dayOf(item.t.due)}T00:00:00`).getTime()) / 86400000));
      return el("span", { className: "td-tag red", textContent: `Overdue ${days}d` });
    }
    if (item.why === "due") return el("span", { className: "td-tag amber", textContent: "Due today" });
    return null;
  }

  function upNext(item, rest, stuckById) {
    const t = item.t;
    const card = el("div", { className: "td-next" });
    const lead = el("div", { className: "td-next-main" });
    lead.append(el("div", { className: "td-kicker", textContent: "Up next in Focus" }));
    const title = el("button", { className: "td-next-title", type: "button", textContent: t.title });
    title.onclick = () => app.openTask(t.id);
    lead.append(title);
    const meta = el("div", { className: "td-next-meta" }, el("span", { className: "td-id", textContent: `#${t.id}` }));
    if (t.project_name) meta.append(el("span", { textContent: t.project_name }));
    meta.append(el("span", { textContent: statusWord(t.status) }));
    const w = whyTag(item);
    if (w) meta.append(w);
    const s = stuckById.get(t.id);
    if (s) meta.append(stuckTag(s));
    lead.append(meta);
    if (rest.length) {
      const then = el("div", { className: "td-then" }, "Then ");
      const named = rest.slice(0, 2);
      named.forEach((r, i) => {
        if (i) then.append(rest.length > 2 ? ", " : " and ");
        then.append(el("b", { textContent: r.t.title.length > 48 ? `${r.t.title.slice(0, 45)}...` : r.t.title }));
      });
      if (rest.length > 2) then.append(` and ${rest.length - 2} more`);
      then.append(".");
      lead.append(then);
    }
    const go = el("button", { className: "btn primary td-focus td-ib", type: "button" }, I("focus", "sm"), el("span", { textContent: "Start focus" }));
    go.title = "Opens the first task in your Focus order";
    go.onclick = () => startFocus();
    card.append(lead, el("div", { className: "td-next-side" }, go));
    return card;
  }

  function startFocus() {
    const q = focusQueue((app.state().everyTask) || []);
    if (!q.length) { app.notify("Nothing is due or in progress for you, so there is nothing to focus on yet."); return; }
    app.openTask(q[0].t.id);
  }

  // -------------------------------------------------------------------------
  // Quick capture

  /** "Fix the login page !high @codex": the priority and who, the rest is the title. */
  function parseCapture(text) {
    let priority = "med";
    let assignee = null;
    const title = String(text).replace(/(^|\s)!(high|med|low)\b/gi, (m, sp, p) => { priority = p.toLowerCase(); return sp; })
      .replace(/(^|\s)@([\w:.-]+)/g, (m, sp, who) => { assignee = who; return sp; })
      .replace(/\s+/g, " ").trim();
    return { title, priority, assignee };
  }

  function capture() {
    const target = app.projectFor();
    const name = target != null ? app.projectName(target) : "";
    const wrap = el("div", { className: "td-capture" });
    const field = el("input", {
      className: "td-capture-in", type: "text", value: draft,
      placeholder: "Capture a task. Enter adds it; !high and @who work too.",
    });
    field.dataset.keep = "today-capture";
    field.setAttribute("aria-label", "Capture a task");
    field.oninput = () => { draft = field.value; captureMsg = null; };
    field.onkeydown = async (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      const { title, priority, assignee } = parseCapture(field.value);
      if (!title || captureBusy) return;
      if (target == null) { captureMsg = { error: true, text: "Make a project first: a task needs one to live in." }; app.repaint(); return; }
      captureBusy = true;
      try {
        const t = await window.delphi.tasks.create({ projectId: target, title, priority, assignee });
        draft = "";
        captureMsg = { error: false, text: `Added #${t.id} to ${name || "the project"}.` };
        await app.refresh();
      } catch (error) {
        captureMsg = { error: true, text: errOf(error) };
        app.repaint();
      } finally {
        captureBusy = false;
      }
    };
    wrap.append(I("plus", "sm"), field);
    if (name) wrap.append(el("span", { className: "td-capture-to", textContent: `to ${name}` }));
    const box = el("div", { className: "td-capture-box" }, wrap);
    if (captureMsg) box.append(el("div", { className: captureMsg.error ? "td-msg err" : "td-msg", role: "status", textContent: captureMsg.text }));
    return box;
  }

  // -------------------------------------------------------------------------
  // While you were away

  const KIND = {
    decision: { icon: "check", word: "Decided without you" },
    ask: { icon: "chat", word: "Asked, still open" },
    job: { icon: "runs", word: "Finished, not reviewed" },
    workbench: { icon: "branch", word: "Not pushed" },
    stuck: { icon: "clock", word: "Went quiet" },
  };

  function briefCounts(b) {
    const parts = [];
    const c = b.counts || {};
    if (c.decision) parts.push(plural(c.decision, "decision made without you", "decisions made without you"));
    if (c.ask) parts.push(plural(c.ask, "open ask", "open asks"));
    if (c.job) parts.push(plural(c.job, "unreviewed run", "unreviewed runs"));
    if (c.workbench) parts.push(plural(c.workbench, "unpushed Workbench", "unpushed Workbenches"));
    if (c.stuck) parts.push(plural(c.stuck, "task went quiet", "tasks went quiet"));
    return parts;
  }

  /** History, scrolled to the row and lit for a moment. */
  async function showHistory(auditId) {
    await app.go({ projectId: null, view: "history" });
    for (let i = 0; i < 40; i++) {
      const row = document.querySelector(`#content [data-audit="${Number(auditId)}"]`);
      if (row) {
        row.scrollIntoView({ block: "center" });
        row.classList.add("td-flash");
        setTimeout(() => row.classList.remove("td-flash"), 2400);
        return;
      }
      await new Promise((r) => setTimeout(r, 75));
    }
    app.notify("That change is further back than History lists.");
  }

  async function undo(line) {
    lineMsg.delete(line.audit_id);
    try {
      await window.delphi.audit.undo(line.audit_id);
      app.notify("Undone. History has the row, and can put it back.");
      await app.refresh();
      await load({ force: true });
    } catch (error) {
      lineMsg.set(line.audit_id, errOf(error));
      app.repaint();
    }
  }

  function briefLine(line) {
    const k = KIND[line.kind] || KIND.stuck;
    // k- because .ask is already the dialog shell in app.css.
    const row = el("div", { className: `td-bl k-${line.kind}` });
    const icon = el("span", { className: "td-bl-i", title: k.word }, I(k.icon, "sm"));
    const words = el("div", { className: "td-bl-t" });
    if (line.who) words.append(el("b", { textContent: line.who }), " ");
    words.append(line.text);
    if (line.kind === "stuck" && line.mark) words.append(" ", stuckTag({ level: line.level, mark: line.mark, words: `No movement in ${line.days} days` }));
    const side = el("div", { className: "td-bl-side" }, el("span", { className: "td-age", textContent: short(line.at) }));
    if (line.audit_id) {
      const h = button("History", "btn sm ghost");
      h.title = `Show History row ${line.audit_id}`;
      h.onclick = () => showHistory(line.audit_id);
      side.append(h);
    }
    if (line.audit_id && line.undoable) {
      const u = button("Undo");
      u.onclick = () => { u.disabled = true; undo(line); };
      side.append(u);
    }
    row.append(icon, words, side);
    const out = [row];
    if (line.audit_id && lineMsg.has(line.audit_id)) out.push(el("div", { className: "td-msg err td-bl-msg", role: "alert", textContent: lineMsg.get(line.audit_id) }));
    return out;
  }

  function briefSection(d) {
    const b = d.brief;
    const wrap = el("section", { className: "td-sec td-brief" });
    wrap.setAttribute("aria-label", "While you were away");
    const head = el("div", { className: "td-h" }, el("h2", { textContent: "While you were away" }),
      el("span", { className: "td-hint", textContent: sinceWords(b.since) }));
    head.append(el("span", { className: "grow" }));
    if (b.total) {
      const toggle = button(briefOpen ? "Hide" : `Show ${b.total}`, "btn sm ghost");
      toggle.setAttribute("aria-expanded", String(briefOpen));
      toggle.onclick = () => { briefOpen = !briefOpen; store.set("briefOpen", briefOpen); app.repaint(); };
      head.append(toggle);
    }
    const seen = button("Mark as seen", "btn sm ghost");
    seen.title = "Start the brief again after the newest thing shown here";
    seen.onclick = async () => {
      try { data = await window.delphi.today.seen(shownUpTo()); sig = sigOf(data); loadedAt = Date.now(); } catch (error) { app.notify(errOf(error)); }
      app.repaint();
    };
    head.append(seen);
    wrap.append(head);

    if (!b.total) {
      wrap.append(el("div", { className: "td-quiet-line", textContent: "Nothing happened that needs you. No agent decided anything for you, nothing is waiting to be reviewed, and nothing went quiet." }));
      return wrap;
    }
    const summary = el("button", { className: "td-brief-sum", type: "button" });
    summary.setAttribute("aria-expanded", String(briefOpen));
    const parts = briefCounts(b);
    summary.append(el("span", { textContent: `${parts.join(", ")}, across ${plural(b.groups.length, "task", "tasks")}.` }));
    summary.onclick = () => { briefOpen = !briefOpen; store.set("briefOpen", briefOpen); app.repaint(); };
    if (!briefOpen) { wrap.append(summary); return wrap; }

    const box = el("div", { className: "td-box" });
    for (const g of b.groups) {
      const gh = el("div", { className: "td-bg" });
      if (g.task_id != null) {
        const open = el("button", { className: "td-bg-t", type: "button" },
          el("span", { className: "td-id", textContent: `#${g.task_id}` }), el("span", { textContent: g.title || "" }));
        open.onclick = () => app.openTask(g.task_id);
        gh.append(open);
      } else {
        gh.append(el("span", { className: "td-bg-t plain", textContent: "Runs with no task" }));
      }
      if (g.project_name) gh.append(el("span", { className: "td-proj", textContent: g.project_name }));
      box.append(gh);
      for (const line of g.lines) box.append(...briefLine(line));
    }
    wrap.append(box);
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Needs you

  function needsSection(root) {
    const n = app.needs();
    const folders = window.DelphiNeeds ? DelphiNeeds.count() : 0;
    // Tasks in review are a person's turn by definition, so they wait here
    // with how long they have waited, never under Gone quiet.
    const inReview = (data && data.review) || [];
    const total = n.waiting.length + n.reviews.length + n.flags.length + inReview.length + folders;
    const all = button(total ? `All ${total} in Needs you` : "Open Needs you", "btn sm ghost");
    all.onclick = () => app.go({ projectId: null, view: "inbox" });
    const sec = section("Needs you", total, null);
    sec.querySelector(".td-h").append(el("span", { className: "grow" }), all);
    sec.id = "today-needs";
    if (folders) DelphiNeeds.mount(sec);
    const LIMIT = 4;
    const rows = [
      ...n.waiting.map((r) => () => app.rows.waiting(r)),
      ...n.reviews.map((r) => () => app.rows.review(r)),
      ...inReview.map((t) => () => reviewTaskRow(t)),
      ...n.flags.map((r) => () => app.rows.flag(r)),
    ];
    if (rows.length) {
      const box = el("div", { className: "box td-needs" });
      rows.slice(0, LIMIT).forEach((make) => box.append(make()));
      if (rows.length > LIMIT) {
        const left = rows.length - LIMIT;
        const more = button(`${left} more ${left === 1 ? "waits" : "wait"} in Needs you`, "td-more");
        more.onclick = () => app.go({ projectId: null, view: "inbox" });
        box.append(more);
      }
      sec.append(box);
    } else if (!folders) {
      sec.append(el("div", { className: "td-quiet-line", textContent: "Nothing needs you. Agents ask here when they need an answer or a look at what they did." }));
    }
    root.append(sec);
  }

  // -------------------------------------------------------------------------
  // The banner

  // The open menu's own cleanup, so every way it closes (a pick, Escape, a
  // click away, another menu) takes its document listener with it.
  let closeMenu = null;
  function closeMenus() {
    if (closeMenu) { const c = closeMenu; closeMenu = null; c(); }
    for (const m of document.querySelectorAll(".td-menu")) m.remove();
  }

  function reassignMenu(anchor, task) {
    closeMenus();
    const menu = el("div", { className: "td-menu", role: "menu" });
    menu.setAttribute("aria-label", `Re-assign #${task.id}`);
    const pick = async (assignee, words) => {
      closeMenus();
      anchor.focus();
      try {
        await window.delphi.tasks.update(task.id, { assignee });
        app.notify(`#${task.id} is now ${words}. History can undo it.`);
        await app.refresh();
        await load({ force: true });
      } catch (error) { bannerMsg = errOf(error); app.repaint(); }
    };
    const item = (label, fn) => {
      const b = el("button", { type: "button", role: "menuitem", textContent: label });
      b.onclick = fn;
      menu.append(b);
      return b;
    };
    const first = item("You", () => pick(null, "yours"));
    (async () => {
      let agents = [];
      try { agents = (await window.delphi.harnesses.list()).filter((h) => Number(h.enabled) === 1 || h.enabled === true); } catch {}
      for (const h of agents) item(h.label || h.key, () => pick(h.key, `assigned to ${h.label || h.key}`));
    })();
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    document.body.append(menu);
    first.focus();
    const away = (e) => {
      if (menu.contains(e.target) || anchor.contains(e.target)) return;
      closeMenus();
    };
    document.addEventListener("mousedown", away, true);
    closeMenu = () => document.removeEventListener("mousedown", away, true);
    menu.onkeydown = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); closeMenus(); anchor.focus(); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...menu.querySelectorAll("button")];
        const at = items.indexOf(document.activeElement);
        items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
      }
    };
  }

  function banner(d, task) {
    const b = d.banner;
    const more = d.stuck.filter((s) => s.level === "red").length - 1;
    const box = el("div", { className: "td-banner", role: "region" });
    box.setAttribute("aria-label", "A task with no movement");
    const pulse = el("span", { className: "td-pulse" });
    pulse.setAttribute("aria-hidden", "true");
    const words = el("div", { className: "td-banner-t" });
    const lead = el("div", {}, el("b", { textContent: `${b.words}:` }), " ");
    const open = el("button", { className: "td-linkish", type: "button", textContent: `#${b.id} ${b.title}` });
    open.onclick = () => app.openTask(b.id);
    lead.append(open, ". Archive, re-assign, or ask AI to execute?");
    words.append(lead);
    const since = new Date(msOf(b.last_at)).toLocaleDateString([], { month: "short", day: "numeric" });
    const sub = el("div", { className: "td-banner-s" }, `${statusWord(b.status)}${b.project_name ? ` in ${b.project_name}` : ""}${b.assignee ? `, assigned to ${b.assignee}` : ""}, last moved ${since}.`);
    if (more > 0) {
      const all = el("button", { className: "td-linkish", type: "button", textContent: `${plural(more, "more", "more")} with no movement` });
      all.onclick = () => { const q = document.getElementById("today-quiet"); if (q) q.scrollIntoView({ block: "start", behavior: "smooth" }); };
      sub.append(" ", all);
    }
    words.append(sub);
    if (bannerMsg) words.append(el("div", { className: "td-msg err", role: "alert", textContent: bannerMsg }));

    const acts = el("div", { className: "td-banner-a" });
    const archive = iconButton("archive", "Archive");
    archive.title = "Move it back to To do, out of Today and off the stuck list. History can undo it.";
    archive.onclick = async () => {
      if (bannerBusy) return;
      bannerBusy = true;
      bannerMsg = null;
      try {
        await window.delphi.tasks.update(b.id, { status: "todo" });
        app.notify(`#${b.id} is back in To do. History can undo it.`);
        await app.refresh();
        await load({ force: true });
      } catch (error) { bannerMsg = errOf(error); app.repaint(); } finally { bannerBusy = false; }
    };
    const reassign = iconButton("down", "Re-assign");
    reassign.setAttribute("aria-haspopup", "menu");
    reassign.onclick = () => reassignMenu(reassign, b);
    const ask = el("button", { className: "btn sm primary td-ib", type: "button" }, I("sparkle", "sm"), el("span", { textContent: "Ask AI to execute" }));
    ask.title = "Hand it to an agent as a Do run, in the task's own Workbench. It waits for your approval if the project asks for one.";
    ask.onclick = () => app.handTo(b.id, `${b.words}. Pick this task up where it stopped: read its Sheet and its Workbench first, then carry it forward and say on the Sheet what is left.`);
    const off = el("button", { className: "td-x", type: "button", title: "Hide this banner" }, I("x", "sm"));
    off.setAttribute("aria-label", "Hide this banner");
    off.onclick = () => {
      const hidden = store.get("bannerOff", []);
      hidden.push(bannerKey(b));
      store.set("bannerOff", hidden.slice(-50));
      app.repaint();
    };
    acts.append(archive, reassign, ask, off);
    box.append(pulse, words, acts);
    return box;
  }

  // -------------------------------------------------------------------------
  // The page

  function render(root) {
    if (!app) return;
    load();
    const s = app.state();
    const tasks = s.everyTask || [];
    const page = el("div", { className: "td-page" });
    page.append(capture());

    if (!tasks.length && !(data && data.stuck && data.stuck.length)) {
      // The first run: nothing filed anywhere yet.
      const first = el("div", { className: "td-first" });
      first.append(el("div", { className: "td-first-i" }, I("today")),
        el("h2", { textContent: "Nothing on today yet" }),
        el("p", { textContent: "Today gathers what is due, what you are in the middle of, what agents need from you, and anything that has gone quiet. Type a task above, or give Delphi a folder to work in." }));
      const add = el("button", { className: "btn primary td-ib", type: "button" }, I("folderplus", "sm"), el("span", { textContent: "Add a folder as a project" }));
      add.onclick = () => app.addFolder();
      first.append(el("div", { className: "td-first-a" }, add));
      page.append(first);
      needsSection(page);
      root.append(page);
      return;
    }

    if (window.DelphiWeekly) { const wk = DelphiWeekly.card(); if (wk) page.append(wk); }
    if (data && data.brief) page.append(briefSection(data));
    else if (data && data.error) page.append(el("div", { className: "td-msg err", role: "alert", textContent: `The brief could not be read: ${data.error}` }));

    needsSection(page);

    const stuckList = (data && data.stuck) || [];
    const stuckById = new Map(stuckList.map((x) => [x.id, x]));
    const hidden = new Set(store.get("bannerOff", []));
    if (data && data.banner && !hidden.has(bannerKey(data.banner))) page.append(banner(data));

    const queue = focusQueue(tasks);
    const day = section("Your day", queue.length, "Overdue, due today, then in progress: yours or nobody's, in Focus order");
    if (queue.length) {
      day.append(upNext(queue[0], queue.slice(1), stuckById));
      if (queue.length > 1) {
        const box = el("div", { className: "td-box" });
        for (const item of queue.slice(1, 12)) {
          box.append(taskRow(item.t, { stuck: stuckById.get(item.t.id), tags: [whyTag(item)], age: item.why === "doing" ? short(item.t.updated_at) : null }));
        }
        if (queue.length > 12) box.append(el("div", { className: "td-quiet-line", textContent: `${plural(queue.length - 12, "more", "more")} in Tasks.` }));
        day.append(box);
      }
    } else {
      day.append(el("div", { className: "td-quiet-line", textContent: "Nothing is due and nothing is in progress for you. Pick something from Tasks, or capture one above." }));
    }
    page.append(day);

    if (stuckList.length) {
      const quiet = section("Gone quiet", stuckList.length, "No movement in 3 days or more, or due within a day. Blocked work stays amber; to-do is never counted.");
      quiet.id = "today-quiet";
      const box = el("div", { className: "td-box" });
      for (const st of stuckList) box.append(taskRow(st, { stuck: st }));
      quiet.append(box);
      page.append(quiet);
    }
    root.append(page);
  }

  /** The heading over the page, from MOUNTS: the day, and how much is on it. */
  function paint(s) {
    if (!s || s.query || s.projectId || s.view !== "today") return;
    const title = $("title");
    const sub = $("subtitle");
    if (!title || !sub) return;
    title.textContent = "Today";
    const day = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    const q = app ? focusQueue(s.everyTask || []).length : 0;
    const n = app ? app.needs() : { waiting: [], reviews: [], flags: [] };
    const waiting = n.waiting.length + n.reviews.length + n.flags.length + ((data && data.review) || []).length;
    const bits = [day];
    if (q) bits.push(`${plural(q, "thing", "things")} for you`);
    if (waiting) bits.push(`${waiting} waiting on you`);
    sub.textContent = bits.join(". ") + ".";
  }

  /** For Cmd+K and the G keys. */
  function commands() {
    return [
      { id: "start-focus", group: "Commands", title: "Start focus", place: "focus", run: () => startFocus() },
      { id: "brief-seen", group: "Commands", title: "Mark the daily brief as seen",
        run: async () => { try { data = await window.delphi.today.seen(shownUpTo()); sig = sigOf(data); } catch {} if (onToday()) app.repaint(); } },
    ];
  }

  /** A task's stuck mark, for any other surface that wants to draw it. */
  const stuckOf = (id) => ((data && data.stuck) || []).find((x) => x.id === Number(id)) || null;

  return { init, render, paint, load, commands, stuckOf, focusQueue, parseCapture };
})();
