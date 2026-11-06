// Focus mode: one task, the way to get through it, and the two ways out of it
// that are not quitting (an interruption, and a break).
//
// Everything else in the window is put behind it and made inert, so the one
// task is all there is to look at and all the keyboard can reach. What it
// shows:
//   - the task: its project, title, why it is first, its subtasks (ticking one
//     saves it), its notes, the pad line it came from and its Sheet's ledger
//   - Done, which marks it done the way every other surface does (tasks:update,
//     so History, the status event and the pad write-back all happen), then
//     brings the next one in, with Undo
//   - Interruption: three questions in order, and one outcome from them
//   - a composer that hands this task, or the interruption, to an agent. Every
//     job from here waits in Needs you for a person's yes (main/focus.js)
//   - Break: 15, 30 or 60 minutes behind a blur nothing gets through, which
//     survives a restart because its end is a setting
//
// Which task is first is the one order Delphi has for a person's work:
// priority, then due date (none last), then oldest first, with a rank in
// between that sorts the way agent/jobs.js PICK_ORDER does (queue_rank, nulls
// last). Tasks carry no queue_rank column today, so in practice it is oldest
// first. Today's "Up next in Focus" and its Your day list read the same order
// through order() below, so the card, F, Cmd+K and Done all agree.
// Only a person's own work: nothing assigned to an agent, claimed by one, left
// in an agent's queue, or with an agent's job open on it.
//
// The pure half (rank, pick, triage, the break's arithmetic) has no DOM and no
// window.delphi, so tools/focus_test.js loads this file under Node.

globalThis.DelphiFocus = (() => {
  // -------------------------------------------------------------------------
  // The rules

  const PRI = { high: 0, med: 1, low: 2 };
  const OPEN_JOB = ["queued", "needs_approval", "running", "waiting_on_human"];
  const BREAK_MINUTES = [15, 30, 60];
  const looksLikeAgent = (name) => /claude|copilot|codex|cursor|agent|gpt|bot|runner|:/i.test(String(name || ""));
  const sqlNow = (now) => new Date(now).toISOString().slice(0, 19).replace("T", " ");

  /**
   * Why an agent has this task, or null when it is a person's. The job check
   * is left out for the task already on screen (opts.current): delegating part
   * of what you are doing must not take it away from you mid-sentence.
   */
  function heldBy(t, { isAgent = looksLikeAgent, now = Date.now(), busy = null, current = false } = {}) {
    if (t.claimed_by && (!t.claim_expires || String(t.claim_expires) >= sqlNow(now))) return `claimed by ${t.claimed_by}`;
    if (isAgent(t.assignee || t.owner || "")) return `assigned to ${t.assignee || t.owner}`;
    if (t.queue) return `waiting in the ${t.queue} queue for an agent`;
    if (!current && busy && busy.has(Number(t.id))) return "an agent has a job open on it";
    return null;
  }

  const isOpen = (t) => Boolean(t) && (t.status === "todo" || t.status === "doing") && !t.parent_id;
  const eligible = (t, opts) => isOpen(t) && !heldBy(t, opts);

  const rankOf = (t) => (t.queue_rank == null ? null : Number(t.queue_rank));
  /** priority, due, then PICK_ORDER: queue_rank IS NULL, queue_rank, id. */
  function compare(a, b) {
    const ra = rankOf(a);
    const rb = rankOf(b);
    return ((PRI[a.priority] ?? 1) - (PRI[b.priority] ?? 1))
      || String(a.due || "9999-99-99").localeCompare(String(b.due || "9999-99-99"))
      || (Number(ra == null) - Number(rb == null))
      || ((ra ?? 0) - (rb ?? 0))
      || (Number(a.id) - Number(b.id));
  }

  /** A person's open top-level tasks, first to do first. */
  const rank = (tasks, opts = {}) => (tasks || []).filter((t) => eligible(t, opts)).sort(compare);

  /** The task ids an open job is working on, from runs:list. */
  const busyTasks = (runs) => new Set((runs || []).filter((r) => OPEN_JOB.includes(r.state) && r.task_id != null).map((r) => Number(r.task_id)));

  /**
   * What Focus shows. stack is the ids a person switched to, newest last: the
   * newest still open is the task, the one under it is parked. With nothing on
   * the stack it is the first of the ranking. next is the rest, in order.
   */
  function pick(tasks, { stack = [], ...opts } = {}) {
    const byId = new Map((tasks || []).map((t) => [Number(t.id), t]));
    const live = stack.map(Number).filter((id, i, all) => all.lastIndexOf(id) === i)
      .filter((id) => { const t = byId.get(id); return isOpen(t) && !heldBy(t, { ...opts, current: true }); });
    const ranked = rank(tasks, opts);
    let task = live.length ? byId.get(live[live.length - 1]) : null;
    const parked = live.length > 1 ? byId.get(live[live.length - 2]) : null;
    const next = ranked.filter((t) => (!task || t.id !== task.id) && (!parked || t.id !== parked.id));
    if (!task) task = next.shift() || null;
    return { task, parked, next, stack: live };
  }

  /**
   * The outcome of the three questions, asked in order. Null until all three
   * have an answer. AI first, because work an agent can do should never take
   * a person's focus; then urgent and load bearing, which takes it now; and
   * everything else waits as a task.
   */
  function triage({ wait = null, keeps = null, ai = null } = {}) {
    if (wait == null || keeps == null || ai == null) return null;
    if (ai === true) return "delegate";
    if (wait === false && keeps === true) return "switch";
    return "later";
  }
  /** A task filed for later that cannot wait three hours is high, so it comes next. */
  const laterPriority = ({ wait = null } = {}) => (wait === false ? "high" : "med");

  /** What an outcome will do, said before it is chosen. */
  function preview(outcome, { current = "", wait = null } = {}) {
    const now = current ? `"${short(current)}"` : "your focus";
    if (outcome === "later") return wait === false
      ? `It becomes a high priority task, so it is next after ${now}. Your focus stays put.`
      : `It becomes a task for later. Your focus stays on ${now}.`;
    if (outcome === "switch") return `It becomes your focus now. ${current ? now : "What you were on"} is parked, still doing, and comes back after.`;
    if (outcome === "delegate") return "The chat box opens with it filled in. Whatever you send waits for your approval in Needs you.";
    return "Answer the three questions in order, and where it goes shows here.";
  }
  /** What happened, in one line, once it has. */
  function outcomeLine(outcome, { id = null, current = "", agent = "", job = null } = {}) {
    if (outcome === "later") return `Filed #${id} for later. You are still on "${short(current)}".`;
    if (outcome === "switch") return `Switched to #${id}. "${short(current)}" is parked, still doing, and comes back next.`;
    if (outcome === "delegate") return "Delegation is open with the interruption filled in. Send it and it waits for your approval.";
    if (outcome === "sent") return `Sent to ${agent} as job #${job}. It waits in Needs you until you approve it.`;
    return "";
  }

  function short(text, n = 48) {
    const s = String(text || "");
    return s.length > n ? `${s.slice(0, n - 3).replace(/\s+\S*$/, "")}...` : s;
  }

  /** When a break started now ends. Only the three lengths offered. */
  function breakEnd(minutes, now = Date.now()) {
    const m = Number(minutes);
    if (!BREAK_MINUTES.includes(m)) throw new Error(`A break is ${BREAK_MINUTES.join(", ")} minutes.`);
    return now + m * 60000;
  }
  const breakLeft = (endsAt, now = Date.now()) => Math.max(0, Number(endsAt) - now);
  /**
   * What a stored end means at startup: still running (pick it back up),
   * ended while Delphi was closed (clear it), or no break at all.
   */
  function resumeBreak(stored, now = Date.now()) {
    const end = Number(stored);
    if (stored == null || !Number.isInteger(end) || end <= 0) return { state: "none" };
    return end > now ? { state: "running", endsAt: end, left: end - now } : { state: "ended", endsAt: end };
  }
  /** 29:05, or 1:00:00 for the hour. Rounds up, so it reads 0:00 only at the end. */
  function clock(ms) {
    const total = Math.max(0, Math.ceil(Number(ms) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  }

  /** "Done" count: tasks finished on this computer's today. completed_at is UTC. */
  function doneToday(tasks, now = Date.now()) {
    const day = new Date(now).toDateString();
    return (tasks || []).filter((t) => t.status === "done" && t.completed_at
      && new Date(`${String(t.completed_at).replace(" ", "T")}Z`).toDateString() === day).length;
  }

  /** Why this task is where it is, in a sentence, against the one after it. */
  function whyText(t, after, { now = Date.now() } = {}) {
    if (!t) return "";
    const pri = { high: "High priority", med: "Medium priority", low: "Low priority" }[t.priority] || "Medium priority";
    const bits = [pri];
    if (t.due) {
      const today = new Date(now); today.setHours(0, 0, 0, 0);
      const due = new Date(`${String(t.due).slice(0, 10)}T00:00:00`);
      const days = Math.round((due - today) / 86400000);
      bits.push(days < 0 ? `overdue by ${-days} ${-days === 1 ? "day" : "days"}` : days === 0 ? "due today" : days === 1 ? "due tomorrow" : `due in ${days} days`);
    } else bits.push("no due date");
    let tail = "";
    if (after && after.priority === t.priority && String(after.due || "") === String(t.due || "")) tail = ", and it was filed before the next one";
    else if (!after) tail = ", and nothing else of yours is open";
    return `${bits.join(", ")}${tail}.`;
  }

  const pure = { PRI, BREAK_MINUTES, heldBy, rank, compare, busyTasks, pick, triage, laterPriority, preview, outcomeLine, breakEnd, breakLeft, resumeBreak, clock, doneToday, whyText, short };

  // -------------------------------------------------------------------------
  // The window. Nothing below runs under Node: init is never called there.

  let app = null;
  const S = {
    open: false, data: [], runs: [], stack: [], view: null, detail: null, pad: null,
    why: "first", spent: new Map(), since: 0, agents: [], harness: null, kind: "ask",
    draft: "", deleg: null, jobs: new Map(), brk: null, pop: false, dialog: null,
    busy: false, returnTo: null, inerted: [],
  };
  let root = null;
  let view = null;
  let tick = null;
  let observer = null;
  const I = (name, size) => DelphiIcons.icon(name, size);
  const errOf = (e) => String(e && e.message ? e.message : e);
  const still = () => (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) || document.documentElement.getAttribute("data-motion") === "off";
  const wait = (ms) => new Promise((r) => setTimeout(r, still() ? 0 : ms));
  const settings = () => (app && app.state().settings) || {};
  const focusLetter = () => String(settings().focusLetter || "f");
  const typing = (n) => Boolean(n && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)));
  const btn = (text, cls = "btn", props = {}) => el("button", { className: cls, type: "button", textContent: text, ...props });
  const kbd = (k) => el("kbd", { className: "fx-kbd", textContent: k });

  function init(lent) {
    app = lent;
    // On the window, in the capture phase: ahead of every document listener,
    // so a break or Focus hears a key before any page or dialog behind it.
    window.addEventListener("keydown", onKey, true);
    window.delphi.onDbChanged(() => { if (S.open && !S.busy) reload(); });
    paintEntry();
    // A break that was running when Delphi closed. Its end is a setting, so the
    // window comes back behind the blur, counting down to the same moment.
    window.delphi.settings.get().then((s) => {
      const r = resumeBreak(s && s.focusBreakUntil);
      // The blur first, at once, and Focus loads underneath it: waiting for
      // the tasks first would leave the window usable for that long.
      if (r.state === "running") { startBreak(null, r.endsAt); enter(); }
      else if (r.state === "ended") window.delphi.settings.set({ focusBreakUntil: null }).catch(() => {});
    }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // In and out

  /** The button on the top bar, beside the others on the right. */
  function paintEntry() {
    const slot = document.getElementById("focus-entry");
    if (!slot) return;
    slot.textContent = "";
    const b = el("button", { className: "btn fx-enter", type: "button" }, I("focus", "sm"), el("span", { textContent: "Focus" }));
    const k = focusLetter();
    if (k !== "off") b.append(kbd(k.toUpperCase()));
    b.title = k !== "off" ? `Focus mode (${k.toUpperCase()})` : "Focus mode";
    b.onclick = () => enter();
    slot.append(b);
  }

  /** Reads what Focus needs: every task (done ones for the count) and the open jobs. */
  async function load() {
    const [tasks, runs] = await Promise.all([
      window.delphi.tasks.list({ projectId: null, includeDone: true }),
      // By state, not the newest few hundred: an old job still open holds its task.
      window.delphi.runs.list({ states: OPEN_JOB, limit: 500 }).catch(() => []),
    ]);
    S.data = tasks || [];
    S.runs = runs || [];
  }
  const opts = () => ({ isAgent: app.isAgent || looksLikeAgent, busy: busyTasks(S.runs) });

  /** Picks the task and loads what it carries: subtasks, Sheet, pad. */
  async function choose() {
    const was = S.view && S.view.task ? S.view.task.id : null;
    S.view = pick(S.data, { stack: S.stack, ...opts() });
    S.stack = S.view.stack.length ? S.view.stack : (S.view.task ? [S.view.task.id] : []);
    const t = S.view.task;
    if (t && t.id !== was) { pauseClock(was); S.since = Date.now(); }
    S.detail = null;
    S.pad = null;
    if (!t) return;
    try { S.detail = await window.delphi.tasks.detail(t.id); } catch { S.detail = null; }
    const padId = S.detail && S.detail.task ? S.detail.task.pad_id : null;
    if (padId) { try { S.pad = await window.delphi.pads.get(padId); } catch { S.pad = null; } }
  }

  /** Another writer changed something: keep the task, refresh what it shows. */
  async function reload() {
    try { await load(); await choose(); paint(); } catch {}
  }

  /** Into Focus, on this task if it is a person's and open, else the first. */
  let entering = false;
  async function enter(taskId = null) {
    // Asked twice before the first has finished (F and the button, or the
    // restart resume), the second would record Focus itself as where to go back to.
    if (S.open || entering) return;
    entering = true;
    try { await enterNow(taskId); } finally { entering = false; }
  }
  async function enterNow(taskId) {
    ensureRoot();
    try { await load(); } catch (error) { app.notify(`Focus could not read your tasks: ${errOf(error)}`); return; }
    if (taskId != null && Number.isFinite(Number(taskId))) {
      const t = S.data.find((x) => x.id === Number(taskId));
      const why = t ? (isOpen(t) ? heldBy(t, opts()) : `${t.status === "done" ? "done" : t.parent_id ? "a subtask" : "not open"}`) : "gone";
      if (why) app.notify(`Focus starts on the top task instead: #${taskId} is ${why}.`);
      else S.stack = [Number(taskId)];
    }
    await choose();
    if (!S.agents.length) {
      try { S.agents = (await window.delphi.harnesses.list()).filter((h) => Number(h.enabled) === 1 || h.enabled === true); } catch { S.agents = []; }
    }
    if (!S.harness || !S.agents.some((h) => h.key === S.harness)) S.harness = S.agents[0] ? S.agents[0].key : null;
    S.open = true;
    S.why = "first";
    // The clock was stopped on the way out; it runs again from now, even on the same task.
    if (S.view.task) S.since = Date.now();
    S.returnTo = document.activeElement;
    for (const node of [document.getElementById("top"), document.querySelector("body > .body")]) {
      // Taken even when a break already made it inert (a restart starts the
      // blur before Focus), so the end of the break does not hand it back.
      if (node && !S.inerted.includes(node)) { node.inert = true; S.inerted.push(node); }
    }
    document.body.classList.add("in-focus");
    root.hidden = false;
    paint({ arrive: true });
    if (!tick) tick = setInterval(paintClock, 1000);
    const t = S.view.task;
    say(t ? `Focus. Now: ${t.title}.` : "Focus. Nothing of yours is open.");
    requestAnimationFrame(() => { const d = root.querySelector('[data-act="done"]') || root.querySelector('[data-act="exit"]'); if (d) d.focus(); });
  }

  /** Out of Focus. Never during a break: that is the point of a strict one. */
  function exit() {
    if (!S.open || S.brk) return false;
    closePop();
    closeDialog();
    pauseClock(S.view && S.view.task ? S.view.task.id : null);
    S.open = false;
    clearInterval(tick);
    tick = null;
    root.hidden = true;
    for (const n of root.querySelectorAll(".fx-toast")) n.remove();
    document.body.classList.remove("in-focus");
    for (const node of S.inerted.splice(0)) node.inert = false;
    const back = S.returnTo;
    S.returnTo = null;
    if (back && document.contains(back) && typeof back.focus === "function") back.focus();
    app.refresh();
    return true;
  }

  // -------------------------------------------------------------------------
  // The clock: time on this task, stopped on a break and outside Focus

  function pauseClock(id) {
    if (id == null || !S.since) return;
    S.spent.set(id, (S.spent.get(id) || 0) + (Date.now() - S.since));
    S.since = 0;
  }
  const spentOn = (id) => (S.spent.get(id) || 0) + (S.since && !S.brk ? Date.now() - S.since : 0);
  function paintClock() {
    if (!S.open || !root) return;
    const t = S.view && S.view.task;
    const b = root.querySelector(".fx-clock b");
    if (b && t) b.textContent = clock(spentOn(t.id));
  }

  // -------------------------------------------------------------------------
  // Painting

  function ensureRoot() {
    if (root) return;
    root = el("div", { className: "fx", id: "focus" });
    root.hidden = true;
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Focus");
    // Only view is repainted. The live region, the toasts and a dialog sit
    // beside it, so a repaint (another agent writing, a subtask ticked) never
    // cuts off an announcement or closes the Interruption under the person.
    view = el("div", { className: "fx-view" });
    const live = el("div", { className: "fx-live fx-sr", role: "status" });
    live.setAttribute("aria-live", "polite");
    root.append(view, live);
    document.body.append(root);
  }

  /** Announced to a screen reader, once, politely. */
  function say(text) {
    // During a break everything but the blur is inert, and an inert live
    // region is never read, so the break has its own.
    const live = S.brk && S.brk.node ? S.brk.node.querySelector(".fx-live") : root && root.querySelector(".fx-live");
    if (!live) return;
    live.textContent = "";
    setTimeout(() => { live.textContent = text; }, 30);
  }

  function paint({ arrive = false } = {}) {
    if (!root) return;
    // The draft is S.draft, kept by the box's own input handler. Never read
    // back from the box here: a send or a cancel clears S.draft and then
    // repaints, and reading the old box first would put the text straight back.
    const hadFocus = document.activeElement && root.contains(document.activeElement) ? document.activeElement.dataset.act || null : null;
    const was = view.querySelector(".fx-stage");
    const scroll = was && !arrive ? was.scrollTop : 0;
    view.textContent = "";
    view.append(top(), stage(arrive), dock());
    if (scroll) view.querySelector(".fx-stage").scrollTop = scroll;
    if (hadFocus) { const n = view.querySelector(`[data-act="${hadFocus}"]`); if (n) n.focus(); }
  }

  function top() {
    const bar = el("header", { className: "fx-top" });
    const mark = el("img", { className: "fx-mark", src: "assets/mark-64.png", alt: "" });
    bar.append(el("div", { className: "fx-brand" }, mark, el("span", { textContent: "Focus" })), el("span", { className: "fx-sep" }));
    const t = S.view && S.view.task;
    if (t) {
      const c = el("span", { className: `fx-clock${S.brk ? " paused" : ""}`, title: "Time on this task in Focus" },
        I("clock", "sm"), el("b", { textContent: clock(spentOn(t.id)) }), el("span", { textContent: S.brk ? "paused" : "on this task" }));
      bar.append(c);
    }
    const n = doneToday(S.data);
    bar.append(el("span", { className: "fx-today", textContent: `${n} done today` }), el("span", { className: "grow" }));

    const brkWrap = el("span", { className: "fx-pop-anchor" });
    const brk = el("button", { className: `fx-tbtn${S.pop ? " on" : ""}`, type: "button", title: "Take a break (B)" }, I("cup", "sm"), el("span", { textContent: "Break" }), kbd("B"));
    brk.dataset.act = "break";
    brk.setAttribute("aria-expanded", String(S.pop));
    brk.setAttribute("aria-haspopup", "dialog");
    brk.onclick = () => (S.pop ? closePop() : openPop());
    brkWrap.append(brk);
    if (S.pop) brkWrap.append(breakPop());
    const intr = el("button", { className: "fx-tbtn interrupt", type: "button", title: "Something came up (I)" }, I("bolt", "sm"), el("span", { textContent: "Interruption" }), kbd("I"));
    intr.dataset.act = "interrupt";
    intr.setAttribute("aria-haspopup", "dialog");
    intr.onclick = () => openInterruption();
    const out = el("button", { className: "fx-tbtn quiet", type: "button", title: "Leave Focus (Esc)" }, el("span", { textContent: "Exit focus" }), kbd("Esc"));
    out.dataset.act = "exit";
    out.onclick = () => exit();
    bar.append(brkWrap, intr, el("span", { className: "fx-sep" }), out);
    return bar;
  }

  function stage(arrive) {
    const st = el("div", { className: "fx-stage" });
    const col = el("main", { className: `fx-col${arrive && !still() ? " arriving" : ""}` });
    const t = S.view && S.view.task;
    if (!t) {
      col.append(el("div", { className: "fx-empty-all" },
        el("h1", { className: "fx-title", textContent: "Nothing of yours is open." }),
        el("p", { className: "fx-dim", textContent: "Everything left is done, blocked, or with an agent. Something came up? Interruption files it." })));
      st.append(col);
      return st;
    }
    const parked = S.view.parked;
    if (parked) {
      const resume = btn("Resume it now", "btn sm");
      resume.dataset.act = "resume";
      resume.onclick = () => resumeParked();
      col.append(el("div", { className: "fx-parked" }, I("pause", "sm"),
        el("div", { className: "grow" }, "Parked with its place kept: ", el("b", { textContent: parked.title }), ". Still doing; it comes back when this one is done."), resume));
    }
    const brow = el("div", { className: "fx-eyebrow" });
    const pc = el("span", { className: "dot" });
    pc.style.background = safeColour(t.project_colour, "var(--accent)");
    const place = S.view.next.length + 1 + (parked ? 1 : 0);
    brow.append(pc, el("span", { textContent: t.project_name || "No project" }), el("span", { className: "sl", textContent: "/" }),
      el("span", { className: "fx-now", textContent: "Now" }), el("span", { textContent: `1 of ${place} for you` }),
      el("span", { className: "fx-ref", textContent: `#${t.id}` }));
    const title = el("h1", { className: "fx-title", id: "fx-title", tabIndex: -1, textContent: t.title });
    col.append(brow, title);

    const label = { first: "Why this is first", next: "Why this one is next", switched: "Why this replaced your focus", back: "Back to where you were" }[S.why] || "Why this is first";
    const whyCard = el("section", { className: `fx-why${S.why === "next" || S.why === "switched" ? " fresh" : ""}` });
    whyCard.setAttribute("aria-label", label);
    const subs = (S.detail && S.detail.subtasks) || [];
    const subsDone = subs.filter((s) => s.status === "done").length;
    const words = S.why === "switched" ? "You said it cannot wait three hours and it keeps the business running." : whyText(t, S.view.next[0]);
    const chips = el("div", { className: "fx-tris" },
      chip("Priority", t.priority || "med", t.priority === "high" ? "hot" : ""),
      chip("Due", t.due ? TIME_label(t.due) : "none"),
      chip("Status", t.status === "doing" ? "doing" : "to do", t.status === "doing" ? "biz" : ""));
    if (subs.length) chips.append(chip("Subtasks", `${subsDone} of ${subs.length}`));
    whyCard.append(el("div", { className: "fx-label", textContent: label }), el("p", { textContent: words }), chips);
    col.append(whyCard);

    const acts = el("div", { className: "fx-acts" });
    const done = el("button", { className: "btn primary", type: "button" }, I("check", "sm"), el("span", { textContent: "Done" }), kbd("D"));
    done.dataset.act = "done";
    done.onclick = () => markDone();
    const open = btn("Open the task", "btn");
    open.dataset.act = "open";
    open.onclick = () => app.openTask(t.id);
    acts.append(done, open, el("span", { className: "grow" }));
    if (subs.length) {
      const bar = el("span", { className: "fx-bar" }, el("span", { className: "fx-bar-fill" }));
      bar.firstChild.style.width = `${Math.round((subsDone / subs.length) * 100)}%`;
      acts.append(el("span", { className: "fx-prog" }, bar, `${subsDone} of ${subs.length} subtasks`));
    }
    col.append(acts);

    col.append(subtasks(subs), context(t));
    st.append(col, el("aside", { className: "fx-side", ariaLabel: "Up next" }, upNext()));
    return st;
  }

  // Dates as a person says them, from timefmt.js when it is loaded.
  function TIME_label(due) {
    const d = new Date(`${String(due).slice(0, 10)}T00:00:00`);
    if (Number.isNaN(d.getTime())) return String(due);
    return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  }
  const chip = (k, v, cls = "") => el("span", { className: `tri ${cls}`.trim() }, `${k} `, el("b", { textContent: v }));

  function subtasks(subs) {
    const sec = el("section", { className: "fx-sec" });
    sec.append(el("div", { className: "fx-sec-head" }, el("h2", { textContent: "Subtasks" }), subs.length ? el("span", { className: "fx-count", textContent: String(subs.length) }) : null));
    if (!subs.length) {
      sec.append(el("div", { className: "fx-empty", textContent: "No subtasks on this one. Open the task to add some, or ask an agent below to break it down." }));
      return sec;
    }
    for (const s of subs) {
      const on = s.status === "done";
      const row = el("button", { className: `fx-step${on ? " done" : ""}`, type: "button" },
        el("span", { className: "check", ariaHidden: "true", textContent: on ? "\u2713" : "" }), el("span", { className: "txt", textContent: s.title }));
      row.setAttribute("role", "checkbox");
      row.setAttribute("aria-checked", String(on));
      row.dataset.act = `sub-${s.id}`;
      row.onclick = async () => {
        if (row.disabled) return;
        row.disabled = true;
        try {
          await window.delphi.tasks.update(s.id, { status: on ? "todo" : "done" });
          s.status = on ? "todo" : "done";
          say(`${s.title}: ${on ? "not done" : "done"}.`);
        } catch (error) { toast(errOf(error), { error: true }); }
        paint();
      };
      sec.append(row);
    }
    return sec;
  }

  /** Where the task came from: its notes, the pad line it was read out of, and its Sheet's ledger. */
  function context(t) {
    const box = el("div");
    const detailText = S.detail && S.detail.task ? String(S.detail.task.detail || "").trim() : "";
    if (detailText) {
      box.append(el("section", { className: "fx-sec" }, el("div", { className: "fx-sec-head" }, el("h2", { textContent: "Notes" })),
        el("div", { className: "fx-note", textContent: detailText.length > 1400 ? `${detailText.slice(0, 1397)}...` : detailText })));
    }
    if (S.pad) {
      const lines = String(S.pad.body || "").split("\n");
      const at = lines.findIndex((l) => l.includes(`<!--d:${t.id}-->`));
      let heading = "";
      for (let i = at; i >= 0; i--) if (/^#{1,6}\s/.test(lines[i])) { heading = lines[i].replace(/^#+\s*/, ""); break; }
      const line = at >= 0 ? lines[at].replace(/<!--d:\d+-->/g, "").replace(/^\s*[-*]\s*\[[ xX]\]\s*/, "").trim() : "";
      const sec = el("section", { className: "fx-sec" }, el("div", { className: "fx-sec-head" }, el("h2", { textContent: "From the pad" })));
      const card = el("div", { className: "fx-pad" }, el("div", { className: "fx-pad-name" }, I("pad", "sm"), el("b", { textContent: S.pad.title || S.pad.key || "Pad" }), heading ? el("span", { className: "fx-dim", textContent: ` / ${heading}` }) : null));
      if (line) card.append(el("div", { className: "fx-pad-line", textContent: line }));
      sec.append(card);
      box.append(sec);
    }
    const entries = (S.detail && S.detail.comments) || [];
    const ledger = entries.filter((e) => e.promoted || e.kind === "decide");
    const recent = entries.filter((e) => !ledger.includes(e)).slice(-3);
    const shown = [...ledger.slice(-4), ...recent];
    const sec = el("section", { className: "fx-sec" });
    const head = el("div", { className: "fx-sec-head" }, el("h2", { textContent: "Sheet" }), entries.length ? el("span", { className: "fx-count", textContent: String(entries.length) }) : null, el("span", { className: "grow" }));
    if (entries.length) {
      const all = btn(`Open the full Sheet`, "ts-linkbtn");
      all.dataset.act = "sheet";
      all.onclick = () => app.openTask(t.id);
      head.append(all);
    }
    sec.append(head);
    if (!shown.length) sec.append(el("div", { className: "fx-empty", textContent: "Nothing on its Sheet yet. What you ask an agent below lands there." }));
    else {
      const list = el("div", { className: "fx-ledger" });
      const SIG = { say: ">", run: "$", ask: "?", decide: "=", note: "!" };
      for (const e of shown) {
        const text = String(e.body || "").replace(/\s+/g, " ").trim();
        list.append(el("div", { className: `fx-entry k-${e.kind}` },
          el("span", { className: "fx-sig", ariaHidden: "true", textContent: SIG[e.kind] || ">" }),
          el("div", { className: "fx-entry-main" },
            el("div", { className: "fx-entry-who" }, el("b", { textContent: e.author || "someone" }), ledger.includes(e) ? el("span", { className: "fx-led", textContent: "ledger" }) : null),
            el("div", { className: "fx-entry-body", textContent: text.length > 280 ? `${text.slice(0, 277)}...` : text }))));
      }
      sec.append(list);
    }
    box.append(sec);
    return box;
  }

  function upNext() {
    const wrap = el("div", { className: "fx-next" }, el("div", { className: "fx-label", textContent: "Up next" }));
    const list = [S.view.parked, ...S.view.next].filter(Boolean);
    if (!list.length) { wrap.append(el("div", { className: "fx-peek-foot", textContent: "Nothing after this one." })); return wrap; }
    for (const t of list.slice(0, 2)) {
      const d = el("span", { className: "dot" });
      d.style.background = safeColour(t.project_colour, "var(--ink-faint)");
      const why = t === S.view.parked ? "Parked" : t.priority === "high" ? "High" : t.due ? `Due ${TIME_label(t.due)}` : t.priority === "low" ? "Low" : "Medium";
      wrap.append(el("div", { className: "fx-peek" }, el("div", { className: "t", textContent: t.title }),
        el("div", { className: "m" }, d, el("span", { textContent: t.project_name || "No project" }), el("span", { textContent: "\u00b7" }), el("span", { textContent: why }))));
    }
    if (list.length > 2) wrap.append(el("div", { className: "fx-peek-foot", textContent: `${list.length - 2} more for you` }));
    return wrap;
  }

  // -------------------------------------------------------------------------
  // The composer: hand the task, or the interruption, to an agent

  function dock() {
    const d = el("footer", { className: "fx-dock" });
    const inner = el("div", { className: "fx-dock-in" });
    const t = S.view && S.view.task;
    let job = S.deleg ? null : (t ? S.jobs.get(t.id) : null);
    // Shown only while it is still waiting: approved, rejected or finished, it is Runs' to show.
    const live = job && S.runs.find((r) => r.id === job.id);
    if (live && live.state !== "needs_approval") { S.jobs.delete(t.id); job = null; }
    if (job) {
      const go = btn("Open Needs you", "ts-linkbtn");
      go.dataset.act = "needs";
      go.onclick = () => { exit(); app.go({ projectId: null, view: "inbox" }); };
      inner.append(el("div", { className: "fx-deleg wait", role: "status" }, el("span", { className: "pulse", ariaHidden: "true" }),
        el("span", { className: "grow" }, el("b", { textContent: job.label }), ` has job #${job.id} waiting for your approval.`), go));
    }
    if (S.deleg) {
      const back = btn("Back to this task", "ts-linkbtn");
      back.dataset.act = "undeleg";
      back.onclick = () => { S.deleg = null; S.draft = ""; for (const n of root.querySelectorAll(".fx-toast")) n.remove(); paint(); focusComposer(); };
      inner.append(el("div", { className: "fx-deleg", role: "status" }, I("bolt", "sm"),
        el("span", { className: "grow" }, "Delegating the interruption: ", el("b", { textContent: short(S.deleg.title, 70) })), back));
    }
    if (!t && !S.deleg) { d.append(inner, keysRow()); return d; }

    const comp = el("div", { className: "fx-comp" });
    const ta = el("textarea", { rows: 2, placeholder: S.deleg ? "What should the agent do about it?" : "Ask, or hand part of this to an agent", value: S.draft });
    ta.setAttribute("aria-label", S.deleg ? "Delegate the interruption to an agent" : "Ask, or hand part of this task to an agent");
    ta.dataset.act = "composer";
    const send = el("button", { className: "fx-send", type: "button" }, I("send", "sm"));
    send.setAttribute("aria-label", "Send to the agent, for your approval");
    send.dataset.act = "send";
    send.disabled = !S.draft.trim() || !S.harness;
    ta.oninput = () => { S.draft = ta.value; send.disabled = !ta.value.trim() || !S.harness; };
    ta.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); delegate(); } };
    send.onclick = () => delegate();
    const row = el("div", { className: "fx-comp-row" });
    if (S.agents.length) {
      const pickH = el("select", { className: "fx-pick" });
      pickH.setAttribute("aria-label", "Agent");
      for (const h of S.agents) pickH.append(el("option", { value: h.key, textContent: h.label || h.key }));
      pickH.value = S.harness;
      pickH.onchange = () => { S.harness = pickH.value; };
      const wb = el("button", { className: `fx-pick wb${S.kind === "do" ? " on" : ""}`, type: "button" }, el("span", { className: "tick", ariaHidden: "true", textContent: "\u2713" }), "Own Workbench");
      wb.setAttribute("aria-pressed", String(S.kind === "do"));
      wb.title = "On: it changes code in the task's own Workbench. Off: it only reads and answers on the Sheet.";
      wb.dataset.act = "kind";
      wb.onclick = () => { S.kind = S.kind === "do" ? "ask" : "do"; paint(); };
      row.append(pickH, wb);
    } else {
      row.append(el("span", { className: "fx-dim", textContent: "No agent is turned on. Turn one on in Settings, under Agents." }));
    }
    row.append(el("span", { className: "grow" }), el("span", { className: "hint", textContent: "Enter sends. It waits for your approval." }), send);
    comp.append(ta, row);
    const refusal = el("div", { className: "fx-refusal", role: "alert" });
    refusal.hidden = true;
    inner.append(comp, refusal, keysRow());
    d.append(inner);
    return d;
  }
  function keysRow() {
    const k = (key, words) => el("span", {}, kbd(key), words);
    return el("div", { className: "fx-keys", ariaHidden: "true" }, k("I", "Interruption"), k("B", "Break"), k("D", "Done"), k("Esc", "Exit focus"));
  }
  function focusComposer() {
    requestAnimationFrame(() => { const ta = root && root.querySelector(".fx-comp textarea"); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } });
  }

  async function delegate() {
    const text = S.draft.trim();
    const t = S.view && S.view.task;
    if (!text || !S.harness || S.busy || (!t && !S.deleg)) return;
    S.busy = true;
    const refusal = root.querySelector(".fx-refusal");
    const h = S.agents.find((x) => x.key === S.harness);
    const label = (h && h.label) || S.harness;
    const deleg = S.deleg;
    // The interruption goes with no task: the dispatcher files one for the job,
    // in the project it was captured into, so it never lands on this task's Sheet.
    const payload = deleg
      ? { projectId: deleg.projectId, harness: S.harness, request: text, taskId: null, kind: S.kind, context: `Interruption: ${deleg.title}. ${deleg.context}` }
      : { projectId: t.project_id, harness: S.harness, request: text, taskId: t.id, kind: S.kind };
    try {
      const run = await window.delphi.focus.delegate(payload);
      S.draft = "";
      S.deleg = null;
      if (!deleg) S.jobs.set(t.id, { id: run.id, label });
      const line = outcomeLine("sent", { agent: label, job: run.id });
      paint();
      toast(line);
      say(line);
      app.refresh();
    } catch (error) {
      if (refusal) { refusal.textContent = errOf(error); refusal.hidden = false; }
    } finally {
      S.busy = false;
    }
  }

  // -------------------------------------------------------------------------
  // Done, and what comes after

  async function markDone() {
    const t = S.view && S.view.task;
    if (!t || S.busy) return;
    S.busy = true;
    const was = t.status;
    try {
      await window.delphi.tasks.update(t.id, { status: "done" });
    } catch (error) {
      S.busy = false;
      toast(errOf(error), { error: true });
      return;
    }
    pauseClock(t.id);
    const spent = S.spent.get(t.id) || 0;
    S.stack = S.stack.filter((id) => id !== t.id);
    const col = root.querySelector(".fx-col");
    if (!still() && col) {
      const ring = el("div", { className: "fx-done", ariaHidden: "true" }, el("div", { className: "fx-done-in" },
        el("div", { className: "ring", textContent: "\u2713" }), el("div", { className: "big", textContent: "Done" }),
        el("div", { className: "small", textContent: `${Math.max(1, Math.round(spent / 60000))} min on it.` })));
      root.append(ring);
      col.classList.add("dim");
      await wait(750);
      col.classList.remove("dim");
      col.classList.add("leaving");
      await wait(320);
      ring.remove();
    }
    try { await load(); } catch {}
    const parkedBack = S.view && S.view.parked;
    await choose();
    S.why = parkedBack && S.view.task && S.view.task.id === parkedBack.id ? "back" : "next";
    S.busy = false;
    paint({ arrive: true });
    const n = S.view.task;
    say(`Done: ${t.title}. ${n ? `Now: ${n.title}.` : "Nothing of yours is left open."}`);
    toast(`Done: #${t.id} ${short(t.title, 40)}`, { label: "Undo", run: () => undoDone(t, was) });
    requestAnimationFrame(() => { const d = root.querySelector('[data-act="done"]'); if (d) d.focus(); });
    app.refresh();
  }

  async function undoDone(t, was) {
    if (S.busy) return;
    S.busy = true;
    for (const n of root.querySelectorAll(".fx-toast")) n.remove();
    try {
      await window.delphi.tasks.update(t.id, { status: was === "doing" ? "doing" : "todo" });
    } catch (error) { S.busy = false; toast(errOf(error), { error: true }); return; }
    S.stack.push(t.id);
    S.busy = false;
    await reload();
    S.why = "back";
    paint({ arrive: true });
    say(`Undone. Back to: ${t.title}.`);
    app.refresh();
  }

  async function resumeParked() {
    const p = S.view && S.view.parked;
    const t = S.view && S.view.task;
    if (!p || !t) return;
    S.stack = [...S.stack.filter((id) => id !== p.id && id !== t.id), t.id, p.id];
    await choose();
    S.why = "back";
    paint({ arrive: true });
    say(`Back to: ${p.title}. ${t.title} is parked.`);
  }

  // -------------------------------------------------------------------------
  // Toasts, inside Focus so they are not behind it

  let toastTimer = null;
  function toast(text, { error = false, label = null, run = null } = {}) {
    if (!root) return;
    const old = root.querySelector(".fx-toast");
    if (old) old.remove();
    const n = el("div", { className: `fx-toast${error ? " err" : ""}`, role: error ? "alert" : "status" }, el("span", { textContent: text }));
    if (label && run) {
      const b = btn(label, "fx-toast-act");
      b.dataset.act = "toast";
      b.onclick = () => { n.remove(); run(); };
      n.append(b);
    }
    root.append(n);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => n.remove(), label ? 10000 : Math.min(9000, 3500 + text.length * 40));
  }

  // -------------------------------------------------------------------------
  // Interruption

  /** A dialog inside Focus that keeps the Tab key to itself. */
  function openDialog(node, { label, onKey: own }) {
    closeDialog();
    const scrim = el("div", { className: "fx-scrim" }, node);
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-modal", "true");
    node.setAttribute("aria-label", label);
    // A click outside closes it only when nothing has been typed: an
    // interruption half written is not lost to a stray click.
    scrim.onmousedown = (e) => { if (e.target !== scrim) return; const f = node.querySelector("input, textarea"); if (!f || !f.value.trim()) closeDialog(); };
    S.dialog = { scrim, node, own, back: document.activeElement };
    view.inert = true;
    root.append(scrim);
  }
  function closeDialog() {
    if (!S.dialog) return;
    const { scrim, back } = S.dialog;
    S.dialog = null;
    scrim.remove();
    view.inert = false;
    if (back && document.contains(back)) back.focus();
  }
  const focusables = (node) => [...node.querySelectorAll("button, input, select, textarea, [tabindex]")].filter((n) => !n.disabled && n.tabIndex >= 0 && n.offsetParent !== null);
  function trapTab(e, node) {
    const all = focusables(node);
    if (!all.length) { e.preventDefault(); return; }
    const at = all.indexOf(document.activeElement);
    const next = e.shiftKey ? (at <= 0 ? all.length - 1 : at - 1) : (at < 0 || at === all.length - 1 ? 0 : at + 1);
    e.preventDefault();
    all[next].focus();
  }

  function openInterruption() {
    if (!S.open || S.brk) return;
    closePop();
    const ask = settings().focusTriage !== false;
    const t = S.view && S.view.task;
    const projects = (app.state().projects || []);
    const st = { title: "", a: { wait: null, keeps: null, ai: null }, outcome: null, projectId: t ? t.project_id : app.projectFor(), busy: false };
    const card = el("div", { className: "fcard ic" });
    const titleIn = el("input", { className: "ic-title", type: "text", placeholder: "What came up?", maxLength: 300 });
    titleIn.setAttribute("aria-label", "What came up");
    const where = el("select", { className: "fx-pick" });
    where.setAttribute("aria-label", "Into which project");
    for (const p of projects) where.append(el("option", { value: String(p.id), textContent: p.name }));
    if (st.projectId != null) where.value = String(st.projectId);
    // A default the list does not hold (no project, or an archived one) shows
    // the first option; the interruption goes where the dropdown says.
    st.projectId = where.value ? Number(where.value) : null;
    where.onchange = () => { st.projectId = Number(where.value); };
    const left = el("div", { className: "ic-left" }, titleIn, el("div", { className: "ic-hand" }, el("span", { textContent: "Into" }), where));
    const verdict = el("div", { className: "verdict" });
    const sayLine = el("p", { className: "ic-say" });
    sayLine.setAttribute("aria-live", "polite");
    const rules = el("div", { className: "ic-rules" });
    const right = el("div", { className: "ic-right" }, el("div", { className: "fx-label", textContent: "Where it goes" }), verdict, sayLine, rules);
    const go = el("button", { className: "btn primary", type: "button", textContent: "Answer all three" });
    go.dataset.act = "ic-go";
    const cancel = btn("Cancel");
    cancel.onclick = () => closeDialog();

    const QS = [
      { k: "wait", q: "Can this wait 3 hours?", sub: () => `Until about ${new Date(Date.now() + 3 * 3600000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` },
      { k: "keeps", q: "Does it keep the business running?", sub: () => "Something stops or breaks if nobody does it" },
      { k: "ai", q: "Can AI do it?", sub: () => "An agent, through a job you approve" },
    ];
    const OUT = {
      later: { name: "Can wait", rule: "Filed as a task for later. You stay in focus.", go: "File it for later" },
      switch: { name: "Keeps business running", rule: "Becomes your focus now. The current task is parked and stays doing.", go: "Switch to it now" },
      delegate: { name: "AI can do it", rule: "Opens the chat box with it filled in, to hand to an agent.", go: "Delegate it" },
    };
    const qRows = [];
    if (ask) {
      QS.forEach((q, i) => {
        const seg = el("div", { className: "seg", role: "group" });
        seg.setAttribute("aria-label", q.q);
        const row = el("div", { className: "ic-q" }, el("div", { className: "lab", id: `ic-q-${q.k}` }, q.q, el("small", { textContent: q.sub() })), seg);
        for (const [val, word] of [[true, "Yes"], [false, "No"]]) {
          const b = btn(word, val ? "y" : "n");
          b.dataset.q = q.k;
          b.dataset.v = String(val);
          b.onclick = () => answer(i, val);
          seg.append(b);
        }
        qRows.push(row);
      });
      left.append(...qRows);
    } else {
      const pickRow = el("div", { className: "ic-direct", role: "group" });
      pickRow.setAttribute("aria-label", "Outcome");
      for (const key of ["later", "switch", "delegate"]) {
        const b = btn(OUT[key].go, "btn");
        b.dataset.out = key;
        b.onclick = () => { st.outcome = key; refresh(); };
        pickRow.append(b);
      }
      left.append(pickRow);
    }
    function answer(i, val) {
      st.a[QS[i].k] = val;
      // In order: changing an earlier answer asks the later ones again.
      for (let j = i + 1; j < QS.length; j++) st.a[QS[j].k] = null;
      st.outcome = triage(st.a);
      refresh();
      const nextRow = qRows[i + 1];
      if (nextRow) { const b = nextRow.querySelector("button"); if (b) b.focus(); }
      else go.focus();
    }
    function refresh() {
      if (ask) {
        qRows.forEach((row, i) => {
          const live = i === 0 || st.a[QS[i - 1].k] != null;
          row.classList.toggle("off", !live);
          for (const b of row.querySelectorAll("button")) {
            b.disabled = !live;
            b.setAttribute("aria-pressed", String(st.a[QS[i].k] === (b.dataset.v === "true")));
          }
        });
      } else {
        for (const b of left.querySelectorAll("[data-out]")) b.setAttribute("aria-pressed", String(b.dataset.out === st.outcome));
      }
      const o = st.outcome;
      verdict.className = `verdict${o ? ` v-${o}` : " v-none"}`;
      verdict.textContent = o ? OUT[o].name : ask ? "Three questions" : "Pick one";
      sayLine.textContent = preview(o, { current: t ? t.title : "", wait: st.a.wait });
      rules.textContent = "";
      for (const key of ["later", "switch", "delegate"]) {
        rules.append(el("div", { className: `rule${key === o ? ` on v-${key}` : ""}` }, el("b", { textContent: OUT[key].name }), el("span", { textContent: OUT[key].rule })));
      }
      go.textContent = o ? OUT[o].go : ask ? "Answer all three" : "Pick an outcome";
      go.disabled = !o || !titleIn.value.trim() || st.busy || (o === "switch" && !st.projectId && st.projectId !== 0);
    }
    titleIn.oninput = () => { st.title = titleIn.value; refresh(); };
    go.onclick = () => confirmInterruption(st, go);
    const head = el("div", { className: "ic-head" }, el("h2", { id: "ic-h" }, I("bolt", "sm"), "Interruption"), el("span", { className: "grow" }), el("span", { className: "hint", textContent: "Your focus stays put until you choose" }));
    const foot = el("div", { className: "ic-foot" }, el("span", { className: "hint" }, kbd("Esc"), " cancel ", kbd("Enter"), " confirm"), el("span", { className: "grow" }), cancel, go);
    const err = el("div", { className: "fx-refusal", role: "alert" });
    err.hidden = true;
    st.err = err;
    card.append(head, el("div", { className: "ic-body" }, left, right), err, foot);
    refresh();
    openDialog(card, {
      label: "Interruption",
      onKey: (e) => {
        if (e.key === "Escape") { e.preventDefault(); closeDialog(); return; }
        if (e.key === "Enter" && !e.isComposing && !(e.target && e.target.tagName === "BUTTON")) {
          e.preventDefault();
          if (!go.disabled) go.click();
          else if (titleIn.value.trim()) { const n = card.querySelector(".ic-q:not(.off) button:not([aria-pressed='true'])") || card.querySelector("[data-out]"); if (n) n.focus(); }
          return;
        }
        // Y and N answer the question the keyboard is on, once past the title.
        if (ask && !typing(e.target) && /^[yn]$/i.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const i = qRows.findIndex((r, j) => !r.classList.contains("off") && st.a[QS[j].k] == null);
          if (i >= 0) { e.preventDefault(); answer(i, e.key.toLowerCase() === "y"); }
        }
      },
    });
    titleIn.focus();
  }

  async function confirmInterruption(st, go) {
    const o = st.outcome;
    const title = st.title.trim();
    const t = S.view && S.view.task;
    if (!o || !title || st.busy) return;
    const why = `Came up during Focus${t ? ` on #${t.id}` : ""}. ${st.a.wait == null ? "" : `${st.a.wait ? "Can" : "Cannot"} wait 3 hours. ${st.a.keeps ? "Keeps" : "Does not keep"} the business running. ${st.a.ai ? "AI can" : "AI cannot"} do it.`}`.trim();
    if (o === "delegate") {
      closeDialog();
      S.deleg = { title, projectId: st.projectId, context: why };
      S.draft = title;
      paint();
      focusComposer();
      const line = outcomeLine("delegate");
      toast(line);
      say(line);
      return;
    }
    st.busy = true;
    S.busy = true;
    go.disabled = true;
    try {
      if (o === "later") {
        const made = await window.delphi.tasks.create({ projectId: st.projectId, title, priority: laterPriority(st.a), detail: why });
        closeDialog();
        const line = outcomeLine("later", { id: made.id, current: t ? t.title : "" });
        await reload();
        toast(line);
        say(line);
      } else {
        // Parked means still doing: it was being worked on, and is not dropped.
        // Before the new task is made, so a refusal here leaves nothing to
        // duplicate when the person tries again.
        if (t && t.status !== "doing") await window.delphi.tasks.update(t.id, { status: "doing" });
        const made = await window.delphi.tasks.create({ projectId: st.projectId, title, priority: "high", status: "doing", detail: why });
        closeDialog();
        if (t && !S.stack.includes(t.id)) S.stack.push(t.id);
        S.stack.push(made.id);
        const col = root.querySelector(".fx-col");
        if (col && !still()) { col.classList.add("leaving"); await wait(320); }
        await load();
        await choose();
        S.why = "switched";
        paint({ arrive: true });
        const line = outcomeLine("switch", { id: made.id, current: t ? t.title : "" });
        toast(line);
        say(line);
      }
      S.busy = false;
      app.refresh();
    } catch (error) {
      S.busy = false;
      st.busy = false;
      go.disabled = false;
      if (S.dialog && st.err) { st.err.textContent = errOf(error); st.err.hidden = false; }
      else toast(errOf(error), { error: true });
    }
  }

  // -------------------------------------------------------------------------
  // Break

  function openPop() {
    if (!S.open || S.brk) return;
    S.pop = true;
    paint();
    const pref = String(settings().focusBreakMinutes || "30");
    requestAnimationFrame(() => { const b = root.querySelector(`[data-brk="${pref}"]`); if (b) b.focus(); });
  }
  function closePop() {
    if (!S.pop) return;
    S.pop = false;
    if (S.open) { paint(); const b = root.querySelector('[data-act="break"]'); if (b) b.focus(); }
  }
  function breakPop() {
    const pop = el("div", { className: "fcard bp", role: "dialog" });
    pop.setAttribute("aria-label", "Take a break");
    const pref = String(settings().focusBreakMinutes || "30");
    const opts = el("div", { className: "bp-opts" });
    for (const m of BREAK_MINUTES) {
      const back = new Date(Date.now() + m * 60000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const b = el("button", { className: `bp-opt${String(m) === pref ? " pref" : ""}`, type: "button" },
        el("span", { className: "m", textContent: String(m) }), el("span", { className: "u", textContent: "minutes" }), el("span", { className: "b", textContent: `back at ${back}` }));
      b.dataset.brk = String(m);
      b.setAttribute("aria-label", `${m} minute break, back at ${back}`);
      b.onclick = () => startBreak(m);
      opts.append(b);
    }
    pop.append(el("h3", { textContent: "Take a break" }), opts,
      el("p", { className: "bp-hint", textContent: "Strict: Delphi is hidden until it is over, and the task clock stops. Agents keep going; anything they ask waits for you. Cancel break ends it early." }));
    return pop;
  }

  /** Starts a break of minutes, or picks one back up that ends at endsAt. */
  async function startBreak(minutes, endsAt = null) {
    // A break picked back up after a restart is enforced even if Focus itself
    // could not read the tasks: a strict break that quietly did not happen is
    // the one failure that matters here.
    if (S.brk || (!S.open && !endsAt)) return;
    ensureRoot();
    const end = endsAt || breakEnd(minutes);
    // Picked back up after a restart, the planned length is not stored: the
    // smallest offered that covers what is left draws the ring nearly right.
    const total = endsAt ? (BREAK_MINUTES.find((m) => m * 60000 >= breakLeft(end)) || 60) * 60000 : Number(minutes) * 60000;
    S.pop = false;
    closeDialog();
    pauseClock(S.view && S.view.task ? S.view.task.id : null);
    S.brk = { endsAt: end, total, confirm: false, over: false, shut: [] };
    const node = el("div", { className: "fx-brk", id: "fx-brk" });
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-modal", "true");
    node.setAttribute("aria-label", "On a break");
    S.brk.node = node;
    document.body.append(node);
    // Strict means unreachable: every other thing in the window, and anything
    // added while the break runs (a task sheet a notification opens, a toast),
    // is inert, so neither the pointer nor Tab can get to it.
    const shut = (n) => { if (n !== node && n.nodeType === 1 && !n.inert) { n.inert = true; S.brk.shut.push(n); } };
    for (const kid of document.body.children) shut(kid);
    observer = new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) shut(n); });
    observer.observe(document.body, { childList: true });
    // inert stops the pointer and Tab, not a document listener: a folder
    // dropped on the blur would still reach Add folder's drop handler.
    for (const type of SHUT_EVENTS) window.addEventListener(type, blockDuringBreak, true);
    if (S.open) paint();
    paintBreak();
    // Its own timer, not Focus's clock: a break resumed after a restart in
    // which Focus could not open still has to count down and end.
    S.brk.timer = setInterval(paintBreakTime, 1000);
    // Saved only once the overlay is up, so nothing is reachable while it saves.
    if (!endsAt) { try { await window.delphi.settings.set({ focusBreakUntil: end }); } catch {} }
    const t = S.view && S.view.task;
    say(`On a break until ${backAt(end)}.${t ? ` Then back to ${t.title}.` : ""}`);
  }
  const SHUT_EVENTS = ["drop", "dragover", "dragenter", "paste", "contextmenu", "wheel"];
  function blockDuringBreak(e) {
    if (!S.brk || (S.brk.node && S.brk.node.contains(e.target) && e.type === "contextmenu")) return;
    if (e.type === "wheel") { if (!S.brk.node.contains(e.target)) e.stopImmediatePropagation(); return; }
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  const backAt = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  function paintBreak() {
    const b = S.brk;
    if (!b) return;
    const node = b.node;
    let live = node.querySelector(".fx-live");
    if (!live) { live = el("div", { className: "fx-live fx-sr", role: "status" }); live.setAttribute("aria-live", "polite"); }
    node.textContent = "";
    node.append(live);
    const t = S.view && S.view.task;
    const inner = el("div", { className: `brk-in${b.over ? " brk-over" : ""}` });
    if (b.over) {
      const back = el("button", { className: "btn primary", type: "button" }, el("span", { textContent: "Back to it" }), kbd("Enter"));
      back.dataset.act = "brk-back";
      back.onclick = () => endBreak(false);
      inner.append(el("div", { className: "brk-eye", textContent: "Break" }), el("h2", { className: "brk-t", textContent: "Break's over." }),
        el("div", { className: "back-to", textContent: "Back to:" }), el("div", { className: "back-title", textContent: t ? t.title : "your work" }), back);
      node.append(inner);
      back.focus();
      return;
    }
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 340 340");
    svg.setAttribute("aria-hidden", "true");
    const circ = (cls) => { const c = document.createElementNS(NS, "circle"); for (const [k, v] of Object.entries({ class: cls, cx: 170, cy: 170, r: 160, fill: "none", "stroke-width": 4 })) c.setAttribute(k, String(v)); return c; };
    const trk = circ("trk");
    const arc = circ("arc");
    const C = 2 * Math.PI * 160;
    arc.setAttribute("stroke-linecap", "round");
    arc.setAttribute("stroke-dasharray", String(C));
    svg.append(trk, arc);
    const time = el("div", { className: "brk-t", id: "brk-t" });
    time.setAttribute("role", "timer");
    time.setAttribute("aria-label", "Time left on the break");
    const ring = el("div", { className: "brk-ring" }, svg, el("div", {}, el("div", { className: "brk-eye", textContent: "On a break" }), time,
      el("div", { className: "brk-sub", textContent: `Back at ${backAt(b.endsAt)}${t ? ", to the same task" : ""}` })));
    inner.append(ring, el("p", { className: "brk-line", textContent: `Nothing here needs you for ${Math.round(b.total / 60000)} minutes. Agents keep going; anything they ask waits for you.` }));
    if (b.confirm) {
      const keep = btn("Keep resting");
      keep.dataset.act = "brk-keep";
      keep.onclick = () => { b.confirm = false; paintBreak(); };
      const end = btn("End break", "btn primary");
      end.dataset.act = "brk-end";
      end.onclick = () => endBreak(true);
      const left = Math.ceil(breakLeft(b.endsAt) / 60000);
      inner.append(el("div", { className: "fcard brk-confirm" }, el("h3", { textContent: "End your break early?" }),
        el("p", { textContent: `You planned ${Math.round(b.total / 60000)} minutes; ${left} ${left === 1 ? "is" : "are"} left.` }),
        el("div", { className: "row" }, keep, end)));
      node.append(inner);
      keep.focus();
    } else {
      const cancel = btn("Cancel break", "brk-end");
      cancel.dataset.act = "brk-cancel";
      cancel.onclick = () => { b.confirm = true; paintBreak(); };
      inner.append(cancel);
      node.append(inner);
      cancel.focus();
    }
    b.arc = arc;
    b.C = C;
    paintBreakTime();
  }

  function paintBreakTime() {
    const b = S.brk;
    if (!b || b.over || !b.node) return;
    const left = breakLeft(b.endsAt);
    const time = b.node.querySelector("#brk-t");
    if (time) time.textContent = clock(left);
    if (b.arc) b.arc.setAttribute("stroke-dashoffset", String(b.C * (1 - left / b.total)));
    if (left <= 0) {
      b.over = true;
      clearInterval(b.timer);
      window.delphi.settings.set({ focusBreakUntil: null }).catch(() => {});
      const t = S.view && S.view.task;
      window.delphi.focus.notify({ title: "Break's over", body: t ? `Back to: ${t.title}` : "Back to your work." }).catch(() => {});
      paintBreak();
      say("Break's over.");
    }
  }

  function endBreak(early) {
    const b = S.brk;
    if (!b) return;
    if (observer) { observer.disconnect(); observer = null; }
    for (const type of SHUT_EVENTS) window.removeEventListener(type, blockDuringBreak, true);
    clearInterval(b.timer);
    for (const n of b.shut) n.inert = false;
    // Focus keeps the window behind it out of reach once the break is over.
    if (S.open) for (const n of S.inerted) n.inert = true;
    b.node.remove();
    S.brk = null;
    if (!b.over) window.delphi.settings.set({ focusBreakUntil: null }).catch(() => {});
    S.since = Date.now();
    if (S.open) paint();
    const line = early ? "Break ended early. The clock is running again on this task." : "Welcome back. The clock is running again on this task.";
    toast(line);
    say(line);
    const d = root.querySelector('[data-act="done"]');
    if (d) d.focus();
  }

  // -------------------------------------------------------------------------
  // The keyboard. Capture phase on the document, so Focus hears a key before
  // ui/keys.js and every page behind it, and can keep it from them.

  function onKey(e) {
    if (S.brk) return breakKey(e);
    if (!S.open) return;
    // A task sheet, the settings panel or a dialog opened from Focus owns the
    // keyboard while it is up; its Escape closes it, not Focus.
    if (app.busy()) return;
    const swallow = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    const lower = String(e.key || "").toLowerCase();
    const mod = e.metaKey || e.ctrlKey;
    // The bar and the switcher would open behind Focus and lead somewhere it hides.
    if (mod && !e.altKey && ["k", "p", "f"].includes(lower)) return swallow();
    // Outside a text box, a chord the page behind binds (Cmd+J in Chat, Cmd+Enter
    // on a row) is kept from it. In a box every chord is the box's (line moves,
    // delete to start). Copy, select all, the system's own (quit, close,
    // minimise, hide) and the menu's places (Settings, New task, Back, Cmd+1 to
    // 4) always go through: menu() leaves Focus for those that go somewhere.
    if (mod && !S.dialog && !typing(e.target) && (lower.length === 1 || lower === "enter") && !["a", "c", "q", "w", "m", "h", ",", "n", "[", "1", "2", "3", "4"].includes(lower)) return swallow();
    if (S.dialog) {
      if (e.key === "Tab") { e.stopImmediatePropagation(); trapTab(e, S.dialog.node); return; }
      if (S.dialog.own) S.dialog.own(e);
      e.stopImmediatePropagation();
      return;
    }
    if (e.key === "Escape" && !e.isComposing) {
      swallow();
      if (S.pop) closePop(); else exit();
      return;
    }
    if (mod || e.altKey || e.isComposing || typing(e.target)) return;
    if (["Shift", "Meta", "Control", "Alt", "CapsLock", "Tab", "Enter", " "].includes(e.key)) { e.stopImmediatePropagation(); return; }
    // Plain letters are Focus's own here; the list keys behind it must not move.
    e.stopImmediatePropagation();
    if (lower === "i") { e.preventDefault(); openInterruption(); }
    else if (lower === "b") { e.preventDefault(); S.pop ? closePop() : openPop(); }
    else if (lower === "d") { e.preventDefault(); markDone(); }
  }

  function breakKey(e) {
    const node = S.brk.node;
    if (e.key === "Tab") { e.preventDefault(); e.stopImmediatePropagation(); trapTab(e, node); return; }
    // Quit, hide and minimise are the computer's, not Delphi's: kept from the
    // page, never from the system. A break picks back up after a quit.
    if ((e.metaKey || e.ctrlKey) && ["q", "h", "m"].includes(String(e.key || "").toLowerCase())) { e.stopImmediatePropagation(); return; }
    // Over, Enter is Back to it wherever the focus is: the one thing left to do.
    if (e.key === "Enter" && S.brk.over) { e.preventDefault(); e.stopImmediatePropagation(); endBreak(false); return; }
    const onButton = e.target && node.contains(e.target) && e.target.tagName === "BUTTON";
    if ((e.key === "Enter" || e.key === " ") && onButton) { e.stopImmediatePropagation(); return; }
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  /**
   * The application menu, from main. During a break nothing gets through.
   * Otherwise an item that goes somewhere leaves Focus first, so the place it
   * opens is not hidden behind it; the theme and Settings work in place.
   */
  function menu(action) {
    if (S.brk) return true;
    if (S.open && !["theme", "settings"].includes(action)) exit();
    return false;
  }

  /** From ui/keys.js: the Focus key, on the lit row's task when there is one. */
  function key(k, taskId) {
    const want = focusLetter();
    if (S.open || want === "off" || k !== want) return false;
    enter(taskId);
    return true;
  }

  /**
   * What Focus would show, in order, for Today's card and list: the same pick,
   * with the stack a person built by switching, against the open jobs Today has.
   */
  function order(tasks, runs = []) {
    const p = pick(tasks, { stack: S.stack, isAgent: (app && app.isAgent) || looksLikeAgent, busy: busyTasks(runs) });
    return [p.task, p.parked, ...p.next].filter(Boolean);
  }

  /** For Cmd+K. */
  function commands() {
    return [
      { id: "focus-mode", group: "Commands", title: "Focus mode", keywords: "focus deep work one task single", get keys() { const k = focusLetter(); return k === "off" ? undefined : k.toUpperCase(); }, run: () => enter() },
    ];
  }

  return {
    ...pure, pure, init, enter, order, exit, key, menu, commands, paintEntry,
    isOpen: () => S.open, onBreak: () => Boolean(S.brk),
    // For tools/focus_test.js in a hidden window.
    _state: () => S,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.DelphiFocus;
