// The weekly review, in the Sunsama shape: three steps a person walks
// through, then closes.
//   1. Look back: what got done, what was decided and on which question, what
//      agent work cost and took (the ledger), and what went backwards.
//   2. Tidy: stale tasks with Park and Drop, Workbenches idle for a week with
//      Open and Finish, and kept copies about to expire with the command that
//      brings each back.
//   3. Next week: three to five objectives, from tasks, pinned projects or
//      your own words, saved as a decision note.
//
// The rows are today/weekly.js behind weekly:view (main/weekly.js), the same
// review an agent's weekly_review reads, so the two cannot disagree. This
// file only draws and asks.
//
// A panel over the window rather than a page, so it can be opened from
// anywhere (Today's card and Cmd+K) and closed back to where you were.

globalThis.DelphiWeekly = (() => {
  const I = (name, size) => DelphiIcons.icon(name, size);
  const L = () => globalThis.DelphiLedgerCore;
  let app = null;
  let P = null;
  // Picks, typed text and the project, kept when the panel closes (a task
  // opened from it, a click outside, Finish) so coming back loses nothing.
  // Cleared once the objectives are saved.
  let draft = null;

  const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const STEPS = [
    { id: "look", label: "Look back" },
    { id: "tidy", label: "Tidy" },
    { id: "next", label: "Next week" },
  ];
  const STATUS_WORD = { todo: "To do", doing: "In progress", review: "In review", blocked: "Blocked", done: "Done" };
  const statusWord = (s) => STATUS_WORD[s] || "In progress";

  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(`delphi.weekly.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(`delphi.weekly.${key}`, JSON.stringify(value)); } catch {} },
  };

  function init(lent) { app = lent; }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const errOf = (e) => String(e && e.message ? e.message : e);
  const msOf = (text) => {
    const s = String(text || "").trim();
    return s ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`) : NaN;
  };
  const dayWords = (text) => {
    const ms = msOf(text);
    return Number.isFinite(ms) ? new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : "";
  };
  const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const button = (text, cls = "btn sm", props = {}) => el("button", { className: cls, type: "button", textContent: text, ...props });
  const withIcon = (icon, text, cls = "btn sm") => el("button", { className: `${cls} wk-ib`, type: "button" }, I(icon, "sm"), el("span", { textContent: text }));

  // ---------------------------------------------------------------------------
  // The Today card

  let status = null;
  let statusAt = 0;
  let statusLoading = false;
  const settings = () => ((app && app.state && app.state().settings) || {});
  const reviewDay = () => (DAYS.includes(settings().weeklyReviewDay) ? settings().weeklyReviewDay : "friday");
  const isReviewDay = (now = new Date()) => DAYS[now.getDay()] === reviewDay();

  function loadStatus() {
    if (statusLoading || (status && Date.now() - statusAt < 60000)) return;
    statusLoading = true;
    window.delphi.weekly.status().then((s) => {
      const changed = !status || status.savedThisWeek !== s.savedThisWeek || status.ended !== s.ended;
      status = s;
      statusAt = Date.now();
      if (changed && app && app.repaint) app.repaint();
    }).catch(() => { statusAt = Date.now(); }).finally(() => { statusLoading = false; });
  }

  /**
   * Which card Today shows, from the setting, the day, the week's row in the
   * database and whether a review was started here and closed without ending:
   * "offer" on the review day, "resume" on any day while one is in progress,
   * and nothing once the week is finished or ended. Pure, for the tests.
   */
  function cardState({ enabled, reviewDay: today, status: st, draft: started }) {
    if (!enabled) return null;
    if (st && st.ended) return null;
    if (started) return "resume";
    if (!today) return null;
    if (st && st.savedThisWeek) return null;
    return "offer";
  }

  function card() {
    if (!app) return null;
    loadStatus();
    if (!status) return null;
    // A draft from a week that has since rolled over is let go.
    if (draft && draft.week && status.week && draft.week !== status.week) draft = null;
    const state = cardState({ enabled: settings().weeklyReviewEnabled !== false, reviewDay: isReviewDay(), status, draft: Boolean(draft) });
    if (!state) return null;
    if (state === "offer" && store.get("skipped", null) === localDay()) return null;
    const box = el("section", { className: `wk-card${state === "resume" ? " resume" : ""}`, role: "region" });
    box.setAttribute("aria-label", "Weekly review");
    if (state === "resume") {
      const words = el("div", { className: "wk-card-t" },
        el("div", { className: "wk-kicker", textContent: "In progress" }),
        el("b", { textContent: "Weekly review in progress." }),
        el("div", { className: "wk-card-s", textContent: "Resume where you left off, or End it: finish it, or end it without saving." }));
      const resume = withIcon("right", "Resume", "btn primary");
      resume.onclick = () => open({ step: draft && draft.step ? draft.step : "look" });
      const end = button("End", "btn sm");
      end.title = "Finish the review, or end it without saving";
      end.onclick = () => { open({ step: draft && draft.step ? draft.step : "look" }); askEnd(); };
      box.append(el("span", { className: "wk-card-i" }, I("today")), words, el("div", { className: "wk-card-a" }, end, resume));
      return box;
    }
    const words = el("div", { className: "wk-card-t" },
      el("div", { className: "wk-kicker", textContent: `It is ${reviewDay()[0].toUpperCase()}${reviewDay().slice(1)}` }),
      el("b", { textContent: "Weekly review" }),
      el("div", { className: "wk-card-s", textContent: "Look back at the week, tidy what went quiet, and pick three to five objectives for next week. About ten minutes." }));
    const go = withIcon("check", "Start the review", "btn primary");
    go.onclick = () => open();
    const later = button("Not today", "btn sm ghost");
    later.title = "Hide the card until your next review day. Cmd+K still has it.";
    later.onclick = () => { store.set("skipped", localDay()); app.repaint(); };
    box.append(el("span", { className: "wk-card-i" }, I("today")), words, el("div", { className: "wk-card-a" }, later, go));
    return box;
  }

  // ---------------------------------------------------------------------------
  // The panel

  async function load() {
    const was = P;
    let data = null;
    let error = null;
    try { data = await window.delphi.weekly.view({}); } catch (e) { error = errOf(e); }
    // Closed, or closed and opened again, while it was reading.
    if (!P || P !== was) return;
    P.data = data || P.data;
    P.error = error;
    if (P.data) seedPicks();
    paint();
  }

  /** Last week's unfinished objectives are offered again, not picked for you. */
  function seedPicks() {
    P.carry = ((P.data.next_week.last && P.data.next_week.last.objectives) || [])
      // Done needs no carrying, and a task that no longer exists cannot be.
      .filter((o) => o.status !== "done" && o.status !== "missing")
      .map((o) => ({ key: o.task_id != null ? `t${o.task_id}` : `x${o.text}`, text: o.text, task_id: o.task_id, project_id: P.data.next_week.last.project_id }));
  }

  function open({ step = "look" } = {}) {
    if (P) { show(step); return; }
    const returnTo = document.activeElement;
    const scrim = el("div", { className: "overlay wk-scrim" });
    const box = el("div", { className: "wk", role: "dialog" });
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "wk-title");
    const head = el("header", { className: "wk-head" });
    const body = el("div", { className: "wk-body", tabIndex: -1 });
    body.setAttribute("role", "region");
    body.setAttribute("aria-label", "Review step");
    const foot = el("footer", { className: "wk-foot" });
    box.append(head, body, foot);
    scrim.append(box);
    scrim.onmousedown = (e) => { if (e.target === scrim) close(); };
    scrim.addEventListener("keydown", onKey);
    P = { scrim, box, head, body, foot, returnTo, step, focusNext: null, links: 0, data: null, error: null, picks: [], carry: [], acted: new Map(), rowMsg: new Map(), dropping: null, busy: false, saved: null, saveMsg: null, projectId: null, own: "",
      tidy: { cards: null, applied: new Map(), editing: null, edit: null, busy: false, msg: null, source: null, fallback: null, cardMsg: new Map() }, ending: false, endMsg: null };
    // A draft from a week that has rolled over is let go here too, for Cmd+K.
    if (draft && draft.week && status && status.week && draft.week !== status.week) draft = null;
    if (draft) Object.assign(P, draft);
    P.week = (draft && draft.week) || (status && status.week) || null;
    P.busy = inflight;
    document.body.append(scrim);
    paint();
    box.querySelector(".wk-x").focus();
    load();
    loadTidy();
  }

  function close() {
    if (!P) return;
    const back = P.returnTo;
    const changed = P.acted.size || P.saved || P.tidy.applied.size;
    // After a save the picks are spent, but what was Parked or Dropped keeps
    // its Undo for the next time the panel opens.
    const week = P.week || (status && status.week) || null;
    draft = P.saved ? { acted: P.acted, tidy: P.tidy, step: P.step, week } : { picks: P.picks, own: P.own, projectId: P.projectId, acted: P.acted, tidy: P.tidy, step: P.step, week };
    status = null;
    P.scrim.remove();
    P = null;
    // Today's card changes either way: it now offers Resume or End.
    if (changed) { if (app && app.refresh) app.refresh(); } else if (app && app.repaint) app.repaint();
    if (back && back.isConnected && typeof back.focus === "function") back.focus({ preventScroll: true });
  }

  function show(step) {
    if (!P || !STEPS.some((s) => s.id === step)) return;
    P.step = step;
    paint();
    P.body.scrollTop = 0;
    const tab = P.head.querySelector(`[data-wk="step-${step}"]`);
    if (tab) tab.focus();
  }

  function onKey(e) {
    if (!P) return;
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (P.ending) { P.ending = false; P.endMsg = null; P.focusNext = "end"; paint(); return; }
      if (P.tidy.editing != null) { P.focusNext = `tedit-${P.tidy.editing}`; P.tidy.editing = null; paint(); return; }
      if (P.dropping != null) { P.focusNext = `drop-${P.dropping}`; P.dropping = null; paint(); return; }
      close();
      return;
    }
    // Focus stays inside the panel, which is modal.
    if (e.key === "Tab") {
      const items = [...P.box.querySelectorAll("button, input, select, [tabindex='0']")].filter((n) => !n.disabled && n.offsetParent !== null && !n.closest("[inert]"));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  /** Repaints the panel, putting focus back on the same control when it is still there. */
  function paint() {
    if (!P) return;
    let was = P.focusNext || (document.activeElement && P.box.contains(document.activeElement) ? document.activeElement.dataset.wk : null);
    // While the End choice is up, focus stays in it whatever finished behind.
    if (P.ending && !(was && was.startsWith("end-"))) was = "end-keep";
    P.focusNext = null;
    P.links = 0;
    const scroll = P.body.scrollTop;
    paintHead();
    P.body.replaceChildren(...bodyOf());
    paintFoot();
    const old = P.box.querySelector(".wk-end");
    if (old) old.remove();
    for (const n of [P.head, P.body, P.foot]) n.inert = Boolean(P.ending);
    if (P.ending) P.box.append(endChoice());
    P.body.scrollTop = scroll;
    if (was) { const n = P.box.querySelector(`[data-wk="${CSS.escape(was)}"]`); if (n) n.focus({ preventScroll: true }); }
  }

  function paintHead() {
    const d = P.data;
    const range = d ? `${dayWords(d.since)} to ${dayWords(d.until)}` : "The last seven days";
    const steps = el("nav", { className: "wk-steps" });
    steps.setAttribute("aria-label", "Review steps");
    STEPS.forEach((s, i) => {
      const b = el("button", { className: "wk-step", type: "button" }, el("span", { className: "wk-step-n", textContent: String(i + 1) }), el("span", { textContent: s.label }));
      b.dataset.wk = `step-${s.id}`;
      if (P.step === s.id) b.setAttribute("aria-current", "step");
      b.onclick = () => show(s.id);
      steps.append(b);
    });
    const x = el("button", { className: "wk-x", type: "button", title: "Close (Esc)" }, I("x", "sm"));
    x.setAttribute("aria-label", "Close the weekly review");
    x.dataset.wk = "close";
    x.onclick = () => close();
    P.head.replaceChildren(
      el("div", { className: "wk-head-t" }, el("h2", { id: "wk-title", textContent: "Weekly review" }), el("span", { className: "wk-range", textContent: range })),
      steps, x);
  }

  function paintFoot() {
    const at = STEPS.findIndex((s) => s.id === P.step);
    const back = button("Back", "btn sm ghost");
    back.dataset.wk = "back";
    back.disabled = at === 0;
    back.onclick = () => show(STEPS[at - 1].id);
    const kids = [back, el("span", { className: "grow" })];
    if (at < STEPS.length - 1) {
      const next = button(`Next: ${STEPS[at + 1].label}`, "btn sm primary");
      next.dataset.wk = "next";
      next.onclick = () => show(STEPS[at + 1].id);
      kids.push(next);
    } else {
      const done = button(P.saved ? "Done" : "Close", "btn sm");
      done.dataset.wk = "done";
      done.onclick = () => close();
      kids.push(done);
    }
    const end = button("End review", "btn sm");
    end.dataset.wk = "end";
    end.title = "Finish the review, or end it without saving";
    end.setAttribute("aria-haspopup", "dialog");
    end.onclick = () => askEnd();
    P.foot.replaceChildren(el("span", { className: "wk-keys" }, el("kbd", { textContent: "Esc" }), " close"), end, ...kids);
  }

  function bodyOf() {
    if (P.error) return [el("div", { className: "wk-msg err", role: "alert", textContent: `The review could not be read: ${P.error}` })];
    if (!P.data) return [el("div", { className: "wk-quiet", textContent: "Reading the week..." })];
    if (P.step === "look") return lookBack(P.data);
    if (P.step === "tidy") return tidy(P.data);
    return nextWeek(P.data);
  }

  function section(title, count, hint, ...nodes) {
    const head = el("div", { className: "wk-h" }, el("h3", { textContent: title }));
    if (count != null) head.append(el("span", { className: "wk-n", textContent: String(count) }));
    if (hint) head.append(el("span", { className: "wk-hint", textContent: hint }));
    return el("section", { className: "wk-sec" }, head, ...nodes);
  }
  const quiet = (text) => el("div", { className: "wk-quiet", textContent: text });

  /** A task named in a row, as a button that opens it over the review. */
  function taskLink(id, title) {
    const b = el("button", { className: "wk-task", type: "button" }, el("span", { className: "wk-id", textContent: `#${id}` }), el("span", { className: "wk-tt", textContent: title || "" }));
    b.dataset.wk = `task-${id}-${P.links++}`;
    b.onclick = () => { close(); app.openTask(id); };
    return b;
  }

  // ---------------------------------------------------------------------------
  // 1. Look back

  function stat(label, value, sub = null, tone = "") {
    return el("div", { className: `wk-stat ${tone}` }, el("div", { className: "wk-stat-v", textContent: value }),
      el("div", { className: "wk-stat-l", textContent: label }), sub ? el("div", { className: "wk-stat-s", textContent: sub }) : null);
  }

  function lookBack(d) {
    const lb = d.look_back;
    const t = lb.cost.totals;
    const Lc = L();
    const strip = el("div", { className: "wk-stats" },
      stat("Done", String(lb.done.count), lb.done.subtasks ? `${plural(lb.done.subtasks, "subtask", "subtasks")} among them` : null, "good"),
      stat("Decisions", String(lb.decisions.length), lb.decisions.length ? `on ${plural(new Set(lb.decisions.map((x) => x.task_id)).size, "task", "tasks")}` : null),
      stat("Went backwards", String(lb.backwards.length), null, lb.backwards.length ? "warn" : ""),
      stat("Agent time", t.agent_seconds == null ? "None" : Lc.duration(t.agent_seconds), plural(t.runs, "run", "runs")),
      stat("Cost", !t.runs ? "None" : t.cost_usd == null ? "Not reported" : Lc.money(t.cost_usd), "API-equivalent"));
    const out = [strip];

    const last = d.next_week.last;
    if (last && last.objectives.length) {
      const done = last.objectives.filter((o) => o.status === "done").length;
      const box = el("div", { className: "wk-box" });
      for (const o of last.objectives) {
        const row = el("div", { className: "wk-row" });
        const mark = el("span", { className: `wk-tick ${o.status === "done" ? "on" : ""}`, title: o.status ? statusWord(o.status) : "Not a task" });
        mark.setAttribute("aria-hidden", "true");
        row.append(mark);
        if (o.task_id != null) row.append(taskLink(o.task_id, o.text.replace(/^#\d+\s*/, "")));
        else row.append(el("span", { className: "wk-tt", textContent: o.text }));
        row.append(el("span", { className: "grow" }), el("span", { className: "wk-dim", textContent: o.status === "missing" ? "No longer exists" : o.status ? statusWord(o.status) : "" }));
        box.append(row);
      }
      out.push(section("Last week's objectives", `${done} of ${last.objectives.length} done`, `Week of ${last.week}`, box));
    }

    if (lb.decisions.length) {
      const box = el("div", { className: "wk-box" });
      for (const x of lb.decisions.slice(0, 30)) {
        const row = el("div", { className: "wk-dec" });
        const top = el("div", { className: "wk-dec-q" });
        top.append(x.question ? x.question : "A decision with no question recorded");
        const ans = el("div", { className: "wk-dec-a" }, I("check", "sm"), el("b", { textContent: x.choice }));
        if (x.why) ans.append(el("span", { className: "wk-dim", textContent: ` ${x.why}` }));
        const meta = el("div", { className: "wk-dec-m" }, taskLink(x.task_id, x.task_title));
        if (x.project_name) meta.append(el("span", { className: "wk-proj", textContent: x.project_name }));
        meta.append(el("span", { className: "grow" }));
        if (x.who) meta.append(el("span", { className: `wk-who ${x.author_type === "agent" || (app.isAgent && app.isAgent(x.who)) ? "agent" : ""}`, textContent: x.who }));
        meta.append(el("span", { className: "wk-dim", textContent: dayWords(x.at) }));
        row.append(top, ans, meta);
        box.append(row);
      }
      if (lb.decisions.length > 30) box.append(quiet(`${lb.decisions.length - 30} more, on their tasks' Sheets.`));
      out.push(section("Decisions", lb.decisions.length, "Each with the question it answered", box));
    } else {
      out.push(section("Decisions", 0, null, quiet("No decisions were recorded on any Sheet this week.")));
    }

    // The ledger, in the ledger's own words.
    const cost = el("div", { className: "wk-box wk-pad" });
    const said = Lc.phrases(t).join(", ");
    cost.append(el("div", { className: "wk-line", textContent: `${said[0].toUpperCase()}${said.slice(1)}.` }));
    for (const h of lb.cost.by_harness) cost.append(el("div", { className: "wk-line dim" }, el("b", { textContent: h.label || h.key }), ` ${Lc.brief(h).join(", ")}`));
    if (lb.cost.top_tasks.length) {
      cost.append(el("div", { className: "wk-sub", textContent: "Where it went" }));
      for (const x of lb.cost.top_tasks) cost.append(el("div", { className: "wk-line dim" }, taskLink(x.task_id, x.title), ` ${Lc.brief(x).join(", ")}`));
    }
    out.push(section("Agent cost and time", null, lb.cost.cost_label, cost));

    if (lb.backwards.length) {
      const box = el("div", { className: "wk-box" });
      for (const b of lb.backwards) {
        const row = el("div", { className: "wk-row" }, taskLink(b.task_id, b.title), el("span", { className: "grow" }),
          el("span", { className: "wk-move" }, el("span", { textContent: statusWord(b.from) }), I("right", "sm"), el("b", { textContent: statusWord(b.to) })),
          b.who ? el("span", { className: "wk-who", textContent: b.who }) : null,
          el("span", { className: "wk-dim wk-when", textContent: dayWords(b.at) }));
        box.append(row);
      }
      out.push(section("Went backwards", lb.backwards.length, "Reopened, sent back from review, or returned to To do", box));
    }

    if (lb.done.tasks.length) {
      const box = el("div", { className: "wk-box" });
      for (const x of lb.done.tasks) {
        const mark = el("span", { className: "wk-tick on" });
        mark.setAttribute("aria-hidden", "true");
        box.append(el("div", { className: "wk-row" }, mark, taskLink(x.id, x.title),
          x.project_name ? el("span", { className: "wk-proj", textContent: x.project_name }) : null,
          el("span", { className: "grow" }), el("span", { className: "wk-dim wk-when", textContent: dayWords(x.at) })));
      }
      if (lb.done.count > lb.done.tasks.length) box.append(quiet(`and ${lb.done.count - lb.done.tasks.length} more.`));
      out.push(section("Done", lb.done.count, null, box));
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 2. Tidy

  // A write in flight, whichever panel started it. Module level, not on the
  // panel, because closing and reopening makes a new panel while the first
  // write is still on its way, and a second click must not start a second one.
  let inflight = false;
  // The panel the answer belongs to: the one that asked, if it is still open,
  // else the one open now (the same Map of what was done rides in the draft).
  const target = () => P;
  /** After a write that finished with no panel open: Today and the lists catch up. */
  const settled = (mine) => { if (P !== mine) { status = null; if (app && app.refresh) app.refresh(); } };

  async function act(taskId, kind, why) {
    if (inflight) return;
    const mine = P;
    inflight = true;
    mine.busy = true;
    mine.rowMsg.delete(taskId);
    paint();
    try {
      const r = kind === "park" ? await window.delphi.weekly.park(taskId) : await window.delphi.weekly.drop(taskId, why);
      mine.acted.set(taskId, { kind, receipt: r.receipt, was: r.was, row: (mine.data && mine.data.tidy.stale.find((x) => x.id === taskId)) || null });
      mine.why = null;
      const now = target(mine);
      if (now) { now.dropping = null; now.focusNext = `undo-${taskId}`; }
    } catch (error) {
      const now = target(mine);
      if (now) now.rowMsg.set(taskId, errOf(error)); else if (app) app.notify(errOf(error));
    } finally {
      inflight = false;
      mine.busy = false;
      settled(mine);
      if (P) { P.busy = false; paint(); }
    }
  }

  async function undoAct(taskId) {
    const mine = P;
    const a = mine.acted.get(taskId);
    if (!a || inflight) return;
    inflight = true;
    mine.busy = true;
    paint();
    try {
      await window.delphi.weekly.undo({ receipt: a.receipt });
      mine.acted.delete(taskId);
      const now = target(mine);
      if (now) { now.focusNext = `park-${taskId}`; now.rowMsg.set(taskId, { ok: true, text: `Put back to ${statusWord(a.was)}.` }); }
    } catch (error) {
      const now = target(mine);
      if (now) now.rowMsg.set(taskId, errOf(error)); else if (app) app.notify(errOf(error));
    } finally {
      inflight = false;
      mine.busy = false;
      settled(mine);
      if (P) { P.busy = false; paint(); }
    }
  }

  function staleRow(s) {
    const wrap = el("div", { className: "wk-tidy" });
    const row = el("div", { className: "wk-row" });
    const tag = el("span", { className: `wk-tag ${s.level}`, textContent: s.mark, title: s.words });
    tag.setAttribute("aria-label", s.words);
    row.append(taskLink(s.id, s.title));
    if (s.project_name) row.append(el("span", { className: "wk-proj", textContent: s.project_name }));
    row.append(el("span", { className: "grow" }), el("span", { className: "wk-dim", textContent: statusWord(s.status) }), tag);
    const done = P.acted.get(s.id);
    const acts = el("div", { className: "wk-acts" });
    let form = null;
    if (done) {
      row.classList.add("settled");
      acts.append(el("span", { className: "wk-done", textContent: done.kind === "park" ? "Parked in To do" : "Dropped, with a note on its Sheet" }));
      const u = button("Undo");
      u.dataset.wk = `undo-${s.id}`;
      u.disabled = P.busy;
      u.onclick = () => undoAct(s.id);
      acts.append(u);
    } else if (P.dropping === s.id) {
      // On a line of its own under the row, so the title keeps its width.
      const field = el("input", { className: "wk-in", type: "text", placeholder: "Why let it go? Optional, kept on its Sheet", maxLength: 500 });
      field.dataset.wk = `why-${s.id}`;
      // Kept on the panel, so a Drop that fails and repaints keeps the words.
      field.value = P.why && P.why.id === s.id ? P.why.text : "";
      field.oninput = () => { P.why = { id: s.id, text: field.value }; };
      field.setAttribute("aria-label", `Why drop #${s.id}`);
      const go = button("Drop it", "btn sm danger");
      go.dataset.wk = `dropgo-${s.id}`;
      go.disabled = P.busy;
      go.onclick = () => act(s.id, "drop", field.value);
      field.onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); go.click(); } };
      const no = button("Cancel", "btn sm ghost");
      no.dataset.wk = `dropno-${s.id}`;
      no.onclick = () => { P.dropping = null; P.focusNext = `drop-${s.id}`; paint(); };
      form = el("div", { className: "wk-dropform" }, el("span", { className: "wk-dim", textContent: "Drop it:" }), field, go, no);
    } else {
      const park = button("Park");
      park.dataset.wk = `park-${s.id}`;
      park.title = "Back to To do, off the stale list. Undo puts it back.";
      park.disabled = P.busy || s.status === "todo";
      park.onclick = () => act(s.id, "park");
      const drop = button("Drop");
      drop.dataset.wk = `drop-${s.id}`;
      drop.title = "Mark it done with a note saying it was let go, not finished. Undo puts it back.";
      drop.disabled = P.busy;
      drop.onclick = () => { P.dropping = s.id; P.focusNext = `why-${s.id}`; paint(); };
      acts.append(park, drop);
    }
    if (!form) row.append(acts);
    wrap.append(row);
    if (form) { row.classList.add("dropping"); wrap.append(form); }
    const msg = P.rowMsg.get(s.id);
    if (msg) wrap.append(el("div", { className: msg.ok ? "wk-msg" : "wk-msg err", role: msg.ok ? "status" : "alert", textContent: msg.ok ? msg.text : msg }));
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Ending the review

  function askEnd() {
    if (!P) return;
    P.ending = true;
    P.endMsg = null;
    P.focusNext = "end-keep";
    paint();
  }

  /** The End choice: Finish, End without saving, or Keep it open, which has the focus. */
  function endChoice() {
    const n = P.picks.length;
    // Finish saves three to five; any other count cannot be saved, so it says so first.
    const short = n > 0 && (n < MIN() || n > MAX());
    const box = el("div", { className: "wk-end", role: "alertdialog" });
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "wk-end-t");
    box.setAttribute("aria-describedby", "wk-end-d");
    const fin = el("button", { className: "wk-end-o", type: "button" }, el("b", { textContent: "Finish review" }),
      el("span", { textContent: short ? `${plural(n, "objective is", "objectives are")} picked; saving needs ${MIN()} to ${MAX()}. Change the picks in Next week, or end without saving.`
        : n ? `Saves your ${plural(n, "objective", "objectives")} and marks this week reviewed.` : "Marks this week reviewed. No objectives are picked, so none are saved." }));
    fin.dataset.wk = "end-finish";
    fin.disabled = inflight || short;
    fin.onclick = () => endAs("reviewed");
    const skip = el("button", { className: "wk-end-o", type: "button" }, el("b", { textContent: "End without saving" }),
      el("span", { textContent: n ? `Lets go of ${plural(n, "picked objective", "picked objectives")}. You can undo this for a moment.` : "Marks this week skipped. You can undo this for a moment." }));
    skip.dataset.wk = "end-skip";
    skip.disabled = inflight;
    skip.onclick = () => endAs("skipped");
    const keep = button("Keep it open", "btn sm primary");
    keep.dataset.wk = "end-keep";
    keep.onclick = () => { P.ending = false; P.endMsg = null; P.focusNext = "end"; paint(); };
    box.append(el("h3", { id: "wk-end-t", textContent: "End the weekly review?" }),
      el("p", { id: "wk-end-d", className: "wk-dim", textContent: "Anything you approved in Tidy stays done. Suggestions you have not approved are dropped." }),
      fin, skip);
    if (P.endMsg) box.append(el("div", { className: "wk-msg err", role: "alert", textContent: P.endMsg }));
    box.append(el("div", { className: "wk-end-a" }, keep));
    return box;
  }

  async function endAs(state) {
    if (inflight || !P) return;
    const mine = P;
    inflight = true;
    mine.busy = true;
    paint();
    const was = { picks: mine.picks, own: mine.own, projectId: mine.projectId, week: mine.week || (status && status.week) || null };
    try {
      const r = await window.delphi.weekly.end({ state, projectId: chosenProject(), objectives: mine.picks.map((p) => ({ text: p.text })) });
      // Ended: the panel goes, and with it the draft, so Cmd+K starts afresh.
      draft = null;
      status = null;
      if (P === mine) { P.scrim.remove(); P = null; }
      const back = mine.returnTo && mine.returnTo.isConnected ? mine.returnTo : document.getElementById("content");
      if (back && typeof back.focus === "function") { if (back.id === "content" && back.tabIndex < 0) back.tabIndex = -1; back.focus({ preventScroll: true }); }
      if (app && app.refresh) app.refresh();
      if (state === "reviewed") toast(r.note ? `Weekly review finished. ${plural(was.picks.length, "objective", "objectives")} saved.` : "Weekly review finished.", r.receipt, null);
      else toast("Weekly review ended without saving.", r.receipt, was);
    } catch (error) {
      if (P === mine) { mine.endMsg = errOf(error); }
      else if (app) app.notify(errOf(error));
    } finally {
      inflight = false;
      mine.busy = false;
      if (P) { P.busy = false; paint(); }
    }
  }

  /** A note at the bottom of the window with Undo, which puts the week back and, for an End without saving, the picks. */
  function toast(text, receipt, restore) {
    for (const t of document.querySelectorAll(".wk-toast")) t.remove();
    const box = el("div", { className: "wk-toast", role: "status" }, el("span", { textContent: text }));
    const undo = button("Undo", "btn sm");
    undo.dataset.wk = "toast-undo";
    undo.onclick = async () => {
      undo.disabled = true;
      try {
        await window.delphi.weekly.undo({ receipt });
        if (restore) draft = { ...restore, acted: new Map(), step: "next", week: restore.week };
        status = null;
        box.remove();
        if (app && app.refresh) app.refresh();
      } catch (error) {
        box.replaceChildren(el("span", { textContent: errOf(error) }));
        box.setAttribute("role", "alert");
      }
    };
    const x = el("button", { className: "wk-x", type: "button", title: "Dismiss" }, I("x", "sm"));
    x.setAttribute("aria-label", "Dismiss");
    x.onclick = () => box.remove();
    box.append(undo, x);
    document.body.append(box);
    // Twenty seconds, and never while the pointer or the focus is on it.
    const later = () => setTimeout(() => { if (!box.isConnected) return; if (box.matches(":hover, :focus-within")) later(); else box.remove(); }, 20000);
    later();
  }

  // ---------------------------------------------------------------------------
  // Suggest tidy

  const ACTION_WORDS = { park: "Park", drop: "Drop", done: "Mark done", move: "Move", due: "Set due date", merge: "Merge", split: "Split" };

  async function loadTidy() {
    const mine = P;
    if (!mine || mine.tidy.cards) return;
    try { const list = await window.delphi.tidy.list(); if (P === mine && !mine.tidy.cards) { mine.tidy.cards = list; paint(); } } catch {}
  }

  // Asking can take a minute or two; End and the rest stay usable meanwhile.
  let suggesting = false;
  async function runSuggest() {
    if (suggesting || inflight || !P) return;
    const mine = P;
    suggesting = true;
    mine.tidy.busy = true;
    mine.tidy.msg = null;
    paint();
    try {
      const r = await window.delphi.tidy.suggest();
      // Cards already applied stay listed with their Undo; the new ones follow.
      const kept = [...mine.tidy.applied.values()].map((a) => a.card).filter((c) => !r.suggestions.some((x) => x.id === c.id));
      mine.tidy.cards = [...kept, ...r.suggestions];
      mine.tidy.source = r.source;
      mine.tidy.fallback = r.fallback || r.note || null;
      mine.tidy.cardMsg = new Map();
      if (P === mine) mine.focusNext = r.suggestions.length ? `tapprove-${r.suggestions[0].id}` : "suggest";
    } catch (error) {
      mine.tidy.msg = errOf(error);
    } finally {
      suggesting = false;
      mine.tidy.busy = false;
      if (P) paint();
    }
  }

  /** One card's Approve (with the edit when Edit is open). Resolves true when applied. */
  async function approveCard(c, edits = null) {
    const mine = P;
    try {
      const r = await window.delphi.tidy.approve(c.id, edits);
      mine.tidy.applied.set(c.id, { receipt: r.receipt, card: c, action: r.action });
      mine.tidy.cardMsg.delete(c.id);
      if (mine.tidy.editing === c.id) mine.tidy.editing = null;
      return true;
    } catch (error) {
      mine.tidy.cardMsg.set(c.id, errOf(error));
      return false;
    }
  }

  async function approveOne(c, edits = null) {
    if (inflight) return;
    const mine = P;
    inflight = true;
    mine.tidy.busy = true;
    paint();
    try { if (await approveCard(c, edits)) mine.focusNext = `tundo-${c.id}`; } finally {
      inflight = false;
      mine.tidy.busy = false;
      settled(mine);
      if (P === mine) load(); else if (P) paint();
    }
  }

  /** Approve all shown: the visible open cards, one by one, each its own Undo. */
  async function approveAll() {
    if (inflight) return;
    const mine = P;
    const shown = openCards(mine);
    inflight = true;
    mine.tidy.busy = true;
    paint();
    let ok = 0;
    try {
      for (const c of shown) {
        // Closed or ended meanwhile: the rest are not applied behind the person's back.
        if (P !== mine) break;
        if (await approveCard(c)) ok++;
        if (P === mine) paint();
      }
      mine.tidy.msg = ok === shown.length ? null : `${ok} of ${shown.length} applied; the others say why.`;
      mine.focusNext = "suggest";
    } finally {
      inflight = false;
      mine.tidy.busy = false;
      settled(mine);
      if (P === mine) load(); else if (P) paint();
    }
  }

  async function denyCard(c) {
    if (inflight) return;
    const mine = P;
    inflight = true;
    try {
      await window.delphi.tidy.deny(c.id);
      mine.tidy.cards = mine.tidy.cards.filter((x) => x.id !== c.id);
      mine.tidy.msg = null;
      mine.focusNext = "suggest";
    } catch (error) { mine.tidy.cardMsg.set(c.id, errOf(error)); } finally {
      inflight = false;
      if (P) paint();
    }
  }

  async function undoCard(sid) {
    if (inflight) return;
    const mine = P;
    const a = mine.tidy.applied.get(sid);
    if (!a) return;
    inflight = true;
    mine.tidy.busy = true;
    paint();
    try {
      const r = await window.delphi.tidy.undo({ receipt: a.receipt });
      mine.tidy.applied.delete(sid);
      // A newer run already offers the same thing, so this card is not reopened.
      if (r && r.reopened === false) mine.tidy.cards = (mine.tidy.cards || []).filter((c) => c.id !== sid);
      mine.focusNext = r && r.reopened === false ? "suggest" : `tapprove-${sid}`;
    } catch (error) { mine.tidy.cardMsg.set(sid, errOf(error)); } finally {
      inflight = false;
      mine.tidy.busy = false;
      settled(mine);
      if (P === mine) load(); else if (P) paint();
    }
  }

  const openCards = (p) => (p.tidy.cards || []).filter((c) => !p.tidy.applied.has(c.id));

  function startEdit(c) {
    const d = c.detail || {};
    P.tidy.editing = c.id;
    P.tidy.edit = { action: c.action, project_id: d.project_id || null, due: d.due || "", merge_into: d.merge_into || "", subtasks: (d.subtasks || []).join("\n"), reason: c.reason || "" };
    P.focusNext = `taction-${c.id}`;
    paint();
  }

  /** The inline controls Edit opens: action, then only the fields that action takes, then the reason. */
  function editor(c) {
    const e = P.tidy.edit;
    const box = el("div", { className: "wk-tedit" });
    const field = (label, control) => el("label", { className: "wk-tf" }, el("span", { textContent: label }), control);
    const action = el("select", { className: "wk-sel" });
    action.dataset.wk = `taction-${c.id}`;
    for (const a of Object.keys(ACTION_WORDS)) action.append(el("option", { value: a, textContent: ACTION_WORDS[a], selected: a === e.action }));
    action.onchange = () => { e.action = action.value; P.focusNext = `taction-${c.id}`; paint(); };
    box.append(field("Action", action));
    if (e.action === "move") {
      const sel = el("select", { className: "wk-sel" });
      sel.dataset.wk = `tproject-${c.id}`;
      sel.append(el("option", { value: "", textContent: "Choose a project" }));
      for (const p of livingProjects()) if (Number(p.id) !== Number(c.project_id)) sel.append(el("option", { value: String(p.id), textContent: p.name, selected: Number(p.id) === Number(e.project_id) }));
      sel.onchange = () => { e.project_id = sel.value ? Number(sel.value) : null; };
      box.append(field("To project", sel));
    }
    if (e.action === "due") {
      const d = el("input", { className: "wk-in", type: "date", value: e.due || "" });
      d.dataset.wk = `tdue-${c.id}`;
      d.oninput = () => { e.due = d.value; };
      box.append(field("Due", d));
    }
    if (e.action === "merge") {
      const m = el("input", { className: "wk-in", type: "number", min: "1", value: String(e.merge_into || ""), placeholder: "Task number to keep" });
      m.dataset.wk = `tmerge-${c.id}`;
      m.oninput = () => { e.merge_into = m.value ? Number(m.value) : ""; };
      box.append(field("Into task #", m));
    }
    if (e.action === "split") {
      const t = el("textarea", { className: "wk-in wk-ta", rows: 4, value: e.subtasks, placeholder: "One subtask per line, 2 to 5" });
      t.dataset.wk = `tsplit-${c.id}`;
      t.oninput = () => { e.subtasks = t.value; };
      box.append(field("Subtasks", t));
    }
    const r = el("input", { className: "wk-in", type: "text", value: e.reason, maxLength: 300, placeholder: "Why, kept on its Sheet" });
    r.dataset.wk = `treason-${c.id}`;
    r.oninput = () => { e.reason = r.value; };
    box.append(field("Reason", r));
    const go = button("Approve as edited", "btn sm primary");
    go.dataset.wk = `tsave-${c.id}`;
    go.disabled = P.tidy.busy;
    go.onclick = () => approveOne(c, {
      action: e.action, reason: e.reason, project_id: e.project_id, due: e.due || undefined,
      merge_into: e.merge_into === "" ? undefined : e.merge_into,
      subtasks: e.action === "split" ? e.subtasks.split("\n").map((x) => x.trim()).filter(Boolean) : undefined,
    });
    const no = button("Cancel", "btn sm ghost");
    no.dataset.wk = `tcancel-${c.id}`;
    no.onclick = () => { P.tidy.editing = null; P.focusNext = `tedit-${c.id}`; paint(); };
    box.append(el("div", { className: "wk-acts" }, go, no));
    return box;
  }

  function actionLine(c, action = c.action) {
    const d = c.detail || {};
    switch (action) {
      case "move": return `Move to ${d.project || "another project"}`;
      case "due": return `Due ${d.due}`;
      case "merge": return `Merge into #${d.merge_into}${d.merge_title ? ` ${d.merge_title}` : ""}`;
      case "split": return `Split into ${(d.subtasks || []).length}: ${(d.subtasks || []).join("; ")}`;
      default: return ACTION_WORDS[action] || action;
    }
  }

  function tidyCard(c) {
    const applied = P.tidy.applied.get(c.id);
    const box = el("div", { className: `wk-sug${applied ? " applied" : ""}` });
    const top = el("div", { className: "wk-row bare" }, taskLink(c.task_id, c.title));
    if (c.project_name) top.append(el("span", { className: "wk-proj", textContent: c.project_name }));
    top.append(el("span", { className: "grow" }), el("span", { className: `wk-src ${c.source === "rule" ? "rule" : ""}`, textContent: c.source === "rule" ? "Rule" : c.source }));
    const what = el("div", { className: "wk-sug-a" }, el("b", { textContent: actionLine(c, applied ? applied.action : c.action) }));
    if (c.reason) what.append(el("span", { className: "wk-dim", textContent: ` ${c.reason}` }));
    box.append(top, what);
    const acts = el("div", { className: "wk-acts" });
    if (applied) {
      acts.append(el("span", { className: "wk-done", textContent: "Applied" }));
      const u = button("Undo");
      u.dataset.wk = `tundo-${c.id}`;
      u.disabled = P.tidy.busy;
      u.onclick = () => undoCard(c.id);
      acts.append(u);
      box.append(acts);
    } else if (P.tidy.editing === c.id) {
      box.append(editor(c));
    } else {
      const ok = button("Approve", "btn sm primary");
      ok.dataset.wk = `tapprove-${c.id}`;
      ok.disabled = P.tidy.busy;
      ok.onclick = () => approveOne(c);
      const no = button("Deny");
      no.dataset.wk = `tdeny-${c.id}`;
      no.title = "Not offered again for this task for 30 days";
      no.disabled = P.tidy.busy;
      no.onclick = () => denyCard(c);
      const ed = button("Edit", "btn sm ghost");
      ed.dataset.wk = `tedit-${c.id}`;
      ed.disabled = P.tidy.busy;
      ed.onclick = () => startEdit(c);
      acts.append(ok, no, ed);
      box.append(acts);
    }
    const msg = P.tidy.cardMsg.get(c.id);
    if (msg) box.append(el("div", { className: "wk-msg err", role: "alert", textContent: msg }));
    return box;
  }

  function suggestSection() {
    const t = P.tidy;
    const head = el("div", { className: "wk-sugbar" });
    const go = withIcon("sparkle", t.busy && !t.cards ? "Asking..." : t.cards && t.cards.length ? "Suggest again" : "Suggest tidy", "btn sm");
    go.dataset.wk = "suggest";
    go.disabled = t.busy || inflight || suggesting;
    go.title = "Ask for a suggestion on each stale or idle task. Nothing changes until you approve it.";
    go.onclick = () => runSuggest();
    head.append(go);
    const shown = openCards(P);
    if (shown.length > 1) {
      const all = button(`Approve all ${shown.length} shown`, "btn sm primary");
      all.dataset.wk = "approve-all";
      all.disabled = t.busy;
      all.onclick = () => approveAll();
      head.append(all);
    }
    head.append(el("span", { className: "grow" }));
    if (t.source) head.append(el("span", { className: "wk-dim", textContent: t.source === "rule" ? "From the rules" : `From ${t.source}` }));
    const nodes = [head];
    if (t.fallback) nodes.push(el("div", { className: "wk-msg warn", role: "status", textContent: t.fallback }));
    if (t.msg) nodes.push(el("div", { className: "wk-msg err", role: "alert", textContent: t.msg }));
    const cards = t.cards || [];
    if (cards.length) {
      const box = el("div", { className: "wk-sugs" });
      for (const c of cards) box.append(tidyCard(c));
      nodes.push(box);
    } else if (t.cards) {
      nodes.push(quiet(t.source ? "No suggestions: nothing here has an obvious next step." : "Suggest tidy asks for one action per stale or idle task: park, drop, done, move, a due date, merge or split. You approve, deny or edit each."));
    }
    const sends = settings().tidyIncludeDetails === true
      ? "Task numbers, titles, status, ages, projects and descriptions (scrubbed) are sent"
      : "Only task numbers, titles, status, ages and projects are sent";
    return section("Suggestions", cards.length ? openCards(P).length : null, sends, ...nodes);
  }

  function tidy(d) {
    const out = [suggestSection()];
    // What was Parked or Dropped from here stays listed with its Undo, even
    // after a reload no longer finds it stale.
    const listed = new Set(d.tidy.stale.map((x) => x.id));
    const stale = [...d.tidy.stale, ...[...P.acted.values()].map((a) => a.row).filter((x) => x && !listed.has(x.id))];
    if (stale.length) {
      const box = el("div", { className: "wk-box" });
      for (const s of stale) box.append(staleRow(s));
      out.push(section("Stale tasks", stale.length, "No movement in 3 days or more. Park sends it to To do; Drop closes it with a note.", box));
    } else {
      out.push(section("Stale tasks", 0, null, quiet("Nothing has gone quiet. Every task in progress moved in the last three days.")));
    }

    const idle = d.tidy.idle_workbenches;
    if (idle.length) {
      const box = el("div", { className: "wk-box" });
      for (const w of idle) {
        const row = el("div", { className: "wk-row" }, el("span", { className: "wk-branch" }, I("branch", "sm"), el("span", { textContent: w.branch })),
          taskLink(w.task_id, w.title), el("span", { className: "grow" }),
          el("span", { className: "wk-dim", textContent: `${w.state === "parked" ? "Parked, " : ""}idle ${w.days} days${w.task_status === "done" ? ", task done" : ""}` }));
        const openB = button("Open");
        openB.dataset.wk = `wbopen-${w.workbench_id}`;
        openB.title = "Open the folder in your editor";
        openB.onclick = async () => {
          try { await window.delphi.workbench.open(w.workbench_id); } catch (error) { P.rowMsg.set(`w${w.workbench_id}`, errOf(error)); paint(); }
        };
        const fin = button("Finish");
        fin.dataset.wk = `wbfin-${w.workbench_id}`;
        fin.title = "Walk through Finish: nothing is removed while anything is unsaved or unpushed";
        // Finish asks its own questions in dialogs of its own, so the review
        // steps aside for them and comes back on this step once it is done.
        fin.onclick = () => {
          if (!app.finishWorkbench) return;
          close();
          app.finishWorkbench(w.workbench_id, w.task_id, { title: w.title, after: () => open({ step: "tidy" }) });
        };
        row.append(el("div", { className: "wk-acts" }, openB, fin));
        box.append(row);
        const msg = P.rowMsg.get(`w${w.workbench_id}`);
        if (msg) box.append(el("div", { className: "wk-msg err", role: "alert", textContent: msg }));
      }
      out.push(section("Idle Workbenches", idle.length, "Nothing done in them for a week", box));
    } else {
      out.push(section("Idle Workbenches", 0, null, quiet("Every open Workbench has had work in the last week.")));
    }

    const exp = d.tidy.expiring;
    if (exp.length) {
      const box = el("div", { className: "wk-box" });
      for (const e of exp) {
        const row = el("div", { className: "wk-exp" });
        row.append(el("div", { className: "wk-row bare" },
          el("span", { className: `wk-tag ${e.days_left <= 2 ? "red" : "amber"}`, textContent: e.days_left ? `${e.days_left}d left` : "Under a day" }),
          el("span", { className: "wk-dim", textContent: e.kind === "discarded" ? "Discarded" : "Finished" }),
          taskLink(e.task_id, e.title), el("span", { className: "grow" }),
          el("span", { className: "wk-dim", textContent: `kept until ${dayWords(e.expires_at)}` })));
        const code = el("code", { className: "wk-cmd", textContent: e.restore });
        const copy = button("Copy");
        copy.dataset.wk = `copy-${e.workbench_id}`;
        copy.setAttribute("aria-label", `Copy the restore command for #${e.task_id}`);
        copy.onclick = async () => {
          try { await navigator.clipboard.writeText(e.restore); copy.textContent = "Copied"; setTimeout(() => { if (copy.isConnected) copy.textContent = "Copy"; }, 1400); } catch (error) { app.notify(errOf(error)); }
        };
        row.append(el("div", { className: "wk-cmd-row" }, code, copy));
        box.append(row);
      }
      out.push(section("Kept copies expiring", exp.length, "Finished and discarded Workbenches are kept 30 days. Run the command to bring one back.", box));
    } else {
      out.push(section("Kept copies expiring", 0, null, quiet("No kept copy of a finished or discarded Workbench expires in the next week.")));
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 3. Next week

  const MIN = () => (P.data ? P.data.next_week.min : 3);
  const MAX = () => (P.data ? P.data.next_week.max : 5);
  const picked = (key) => P.picks.some((p) => p.key === key);

  function toggle(item) {
    if (picked(item.key)) P.picks = P.picks.filter((p) => p.key !== item.key);
    else if (P.picks.length < MAX()) P.picks.push(item);
    P.saveMsg = null;
    paint();
  }

  function pickRow(item, { why = [], sub = null } = {}) {
    const on = picked(item.key);
    const b = el("button", { className: `wk-pick${on ? " on" : ""}`, type: "button" });
    b.dataset.wk = `pick-${item.key}`;
    b.setAttribute("aria-pressed", String(on));
    b.disabled = !on && P.picks.length >= MAX();
    const box = el("span", { className: "wk-check" }, on ? I("check", "sm") : null);
    box.setAttribute("aria-hidden", "true");
    b.append(box);
    if (item.task_id != null) b.append(el("span", { className: "wk-id", textContent: `#${item.task_id}` }));
    b.append(el("span", { className: "wk-tt", textContent: item.label || item.text }));
    if (sub) b.append(el("span", { className: "wk-proj", textContent: sub }));
    b.append(el("span", { className: "grow" }));
    for (const w of why) b.append(el("span", { className: "wk-chip", textContent: w }));
    b.onclick = () => toggle(item);
    return b;
  }

  /** The project the note goes in: the one most picks belong to, else the one last open. */
  function defaultProject() {
    const counts = new Map();
    for (const p of P.picks) if (p.project_id != null) counts.set(p.project_id, (counts.get(p.project_id) || 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : (app.projectFor ? app.projectFor() : null);
  }

  const livingProjects = () => ((app.state && app.state().projects) || []).filter((p) => p.status !== "archived");
  /** The project the note will go in, always one the menu lists, so what it shows is what Save uses. */
  function chosenProject() {
    const list = livingProjects();
    const want = P.projectId != null ? P.projectId : defaultProject();
    const hit = list.find((p) => Number(p.id) === Number(want));
    return hit ? hit.id : (list[0] ? list[0].id : null);
  }

  async function save() {
    if (inflight) return;
    const mine = P;
    const projectId = chosenProject();
    inflight = true;
    mine.busy = true;
    mine.saveMsg = null;
    paint();
    try {
      const note = await window.delphi.weekly.save({ projectId, objectives: mine.picks.map((p) => ({ text: p.text })) });
      // Saved, whichever panel is showing now: the draft is spent, so a panel
      // opened again does not offer the same picks to save a second time.
      draft = { acted: mine.acted };
      status = null;
      mine.saved = note;
      const now = target(mine);
      if (now) { now.saved = note; now.picks = mine.picks; now.focusNext = "open-note"; }
    } catch (error) {
      const now = target(mine);
      if (now) now.saveMsg = errOf(error); else if (app) app.notify(errOf(error));
    } finally {
      inflight = false;
      mine.busy = false;
      settled(mine);
      if (P) { P.busy = false; paint(); }
    }
  }

  function nextWeek(d) {
    const nw = d.next_week;
    const out = [];
    if (P.saved) {
      const name = app.projectName ? app.projectName(P.saved.project_id) : "";
      const openNote = button("Open the note", "btn sm");
      openNote.dataset.wk = "open-note";
      openNote.onclick = () => { const pid = P.saved.project_id; close(); app.go({ projectId: pid, view: "notes" }); };
      out.push(el("div", { className: "wk-saved", role: "status" }, el("span", { className: "wk-saved-i" }, I("check")),
        el("div", { className: "grow" }, el("b", { textContent: `${P.saved.updated ? "Updated" : "Saved"} ${plural(P.picks.length, "objective", "objectives")} for the week of ${nw.week}` }),
          el("div", { className: "wk-dim", textContent: `${P.saved.updated ? "The week's decision note" : "As a decision note"} in ${name || "the project"}. Next week's review starts by checking them.` })),
        openNote));
    }

    const list = el("ol", { className: "wk-picked" });
    P.picks.forEach((p, i) => {
      const li = el("li", { className: "wk-picked-i" }, el("span", { className: "wk-picked-n", textContent: String(i + 1) }), el("span", { className: "wk-tt", textContent: p.text }));
      if (!P.saved) {
        const rm = el("button", { className: "wk-rm", type: "button", title: "Take it off" }, I("x", "sm"));
        rm.setAttribute("aria-label", `Take off ${p.text}`);
        rm.dataset.wk = `rm-${p.key}`;
        rm.onclick = () => { P.focusNext = "own"; toggle(p); };
        li.append(el("span", { className: "grow" }), rm);
      }
      list.append(li);
    });
    for (let i = P.picks.length; i < MIN(); i++) list.append(el("li", { className: "wk-picked-i empty" }, el("span", { className: "wk-picked-n", textContent: String(i + 1) }), el("span", { textContent: "Pick one below, or write your own" })));
    out.push(section("Objectives", `${P.picks.length} of ${MIN()} to ${MAX()}`, `For the week of ${nw.week}`, list));
    if (P.saved) return out;

    const own = el("div", { className: "wk-own" });
    const field = el("input", { className: "wk-in", type: "text", value: P.own, placeholder: "Write an objective of your own, then Enter", maxLength: 200 });
    field.dataset.wk = "own";
    field.setAttribute("aria-label", "An objective of your own");
    field.disabled = P.picks.length >= MAX();
    field.oninput = () => { P.own = field.value; };
    field.onkeydown = (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      const text = field.value.replace(/\s+/g, " ").trim();
      if (!text || P.picks.length >= MAX() || picked(`x${text}`)) return;
      P.own = "";
      P.picks.push({ key: `x${text}`, text, task_id: null, project_id: null });
      if (P.picks.length >= MAX()) P.focusNext = "save";
      paint();
    };
    own.append(I("plus", "sm"), field);
    out.push(own);

    if (P.carry.length) {
      const box = el("div", { className: "wk-box" });
      for (const c of P.carry) box.append(pickRow({ ...c, label: c.task_id != null ? c.text.replace(/^#\d+\s*/, "") : c.text }, { why: ["Not done last week"] }));
      out.push(section("Carry over", P.carry.length, "Last week's objectives that are not done", box));
    }

    const pins = ((app.state && app.state().pinned) || []).map((id) => ({ id, name: app.projectName ? app.projectName(id) : "" })).filter((p) => p.name);
    if (pins.length) {
      const box = el("div", { className: "wk-box" });
      for (const p of pins) box.append(pickRow({ key: `p${p.id}`, text: `Project: ${p.name}`, label: p.name, task_id: null, project_id: p.id }, { why: ["Pinned project"] }));
      out.push(section("Pinned projects", pins.length, "A whole project as one objective", box));
    }

    const box = el("div", { className: "wk-box" });
    const carryKeys = new Set(P.carry.map((c) => c.key));
    const cands = nw.candidates.filter((c) => !carryKeys.has(`t${c.id}`));
    for (const c of cands) {
      box.append(pickRow({ key: `t${c.id}`, text: `#${c.id} ${c.title}${c.project_name ? ` (${c.project_name})` : ""}`, label: c.title, task_id: c.id, project_id: c.project_id },
        { why: c.why, sub: c.project_name }));
    }
    out.push(section("Tasks", cands.length, "In progress first, then due soon, then high priority", cands.length ? box : quiet("No open tasks to pick from. Write your own above.")));

    // Where it is kept, and saving.
    const projects = livingProjects();
    const sel = el("select", { className: "wk-sel" });
    sel.dataset.wk = "project";
    sel.setAttribute("aria-label", "Project the objectives are kept in");
    const want = chosenProject();
    for (const p of projects) sel.append(el("option", { value: String(p.id), textContent: p.name, selected: Number(p.id) === Number(want) }));
    sel.onchange = () => { P.projectId = Number(sel.value); };
    const go = button(`Save ${P.picks.length ? plural(P.picks.length, "objective", "objectives") : "objectives"}`, "btn primary");
    go.dataset.wk = "save";
    go.disabled = P.busy || P.picks.length < MIN() || P.picks.length > MAX() || !projects.length;
    go.title = P.picks.length < MIN() ? `Pick at least ${MIN()}` : "Saved as a decision note";
    go.onclick = () => save();
    const bar = el("div", { className: "wk-savebar" }, el("span", { className: "wk-dim", textContent: "Keep them in" }), sel, el("span", { className: "grow" }), go);
    out.push(bar);
    if (P.saveMsg) out.push(el("div", { className: "wk-msg err", role: "alert", textContent: P.saveMsg }));
    return out;
  }

  /** For Cmd+K. */
  function commands() {
    return [
      { id: "weekly-review", group: "Commands", title: "Weekly review", keywords: "week review retro plan objectives tidy stale sunsama", run: () => open() },
    ];
  }

  return { init, open, close, card, cardState, commands, isOpen: () => Boolean(P), isReviewDay, askEnd };
})();
