// The drawer: a task, a note or a pad as one document at the right of the
// window (Direction B).
//
// A task reads top to bottom: where it lives, its title, its status and the
// few facts that change often, three cards that say at a glance where the work
// is (Workbench, Runs, Sheet), then folding sections, with the Sheet's composer
// pinned at the bottom of the drawer rather than of the Sheet section, because
// writing to the Sheet is what people do most and it should never scroll away.
//
// Everything the old task panel could do is still here, often behind a fold or
// in the More menu rather than on the surface. tools/drawer_test.js holds the
// list of those features and checks each one is reachable, so a clean drawer
// cannot quietly become a smaller one. "Open full view" keeps the old panel
// until the cleanup slice, as the fallback.
//
// It owns no data. It reads through window.delphi, and everything it needs
// from app.js (the menus, the dialogs, the Workbench verbs, the run buffers)
// is lent to it in app.js's COMMANDS region through init(). The open drawer is
// registered as app.js's openSheet, with the same handle the old panel had
// (live, wbRepaint, runsRepaint, showEntry, wbEvent, runDone), so every live
// update that reached the panel reaches the drawer without a second route.
//
// Per-viewer conveniences (which sections are folded, Write or Preview, a
// subtask order) are kept in localStorage, wrapped, because a private window
// or blocked storage must still give a working drawer.

globalThis.DelphiDrawer = (() => {
  let host = null;
  let cur = null;
  // Each open takes a number; one that finds a newer number after its awaits
  // stands down, so two quick clicks cannot mount two drawers.
  let opening = 0;
  let lastClose = null;

  // --- small things --------------------------------------------------------

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  };
  const FOLDS_KEY = "delphi.drawer.folds";
  const DEFAULT_FOLDS = { subtasks: true, description: true };
  const folds = () => ({ ...DEFAULT_FOLDS, ...store.get(FOLDS_KEY, {}) });
  const setFold = (key, open) => store.set(FOLDS_KEY, { ...store.get(FOLDS_KEY, {}), [key]: open });
  const MODES = ["write", "preview", "split"];
  const modeOf = (kind) => {
    const m = store.get(`delphi.drawer.mode.${kind}`, /^pad/.test(kind) ? "write" : "preview");
    return MODES.includes(m) ? m : "preview";
  };
  const setMode = (kind, m) => store.set(`delphi.drawer.mode.${kind}`, m);

  const STATUS_LABEL = { todo: "To do", doing: "In progress", blocked: "Blocked", done: "Done" };
  const PRIORITY_LABEL = { high: "High", med: "Medium", low: "Low" };

  // The drawer's own icons, beside the shell's set in ui/icons.js: same grid,
  // same stroke, built as nodes because the renderer never assigns innerHTML.
  const SVG = "http://www.w3.org/2000/svg";
  const SHAPES = {
    share: [["circle", { cx: "18", cy: "5.5", r: "2.5" }], ["circle", { cx: "6", cy: "12", r: "2.5" }], ["circle", { cx: "18", cy: "18.5", r: "2.5" }], ["path", { d: "m8.2 10.8 7.6-4.1M8.2 13.2l7.6 4.1" }]],
    trash: [["path", { d: "M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5" }]],
    grip: [["circle", { cx: "9", cy: "6", r: "1.2", fill: "currentColor", stroke: "none" }], ["circle", { cx: "15", cy: "6", r: "1.2", fill: "currentColor", stroke: "none" }], ["circle", { cx: "9", cy: "12", r: "1.2", fill: "currentColor", stroke: "none" }], ["circle", { cx: "15", cy: "12", r: "1.2", fill: "currentColor", stroke: "none" }], ["circle", { cx: "9", cy: "18", r: "1.2", fill: "currentColor", stroke: "none" }], ["circle", { cx: "15", cy: "18", r: "1.2", fill: "currentColor", stroke: "none" }]],
    write: [["path", { d: "M4 20h4L19 9l-4-4L4 16z" }], ["path", { d: "m13.5 6.5 4 4" }]],
    split: [["rect", { x: "3.5", y: "4.5", width: "17", height: "15", rx: "2.5" }], ["path", { d: "M12 4.5v15" }]],
    ext: [["path", { d: "M14 4h6v6M20 4l-8 8M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" }]],
    play: [["path", { d: "M7 5.5v13l11-6.5z" }]],
    send: [["path", { d: "M12 19V5M6 11l6-6 6 6" }]],
    star: [["path", { d: "m12 4 2.4 5 5.4.6-4 3.7 1.1 5.3L12 16l-4.9 2.6 1.1-5.3-4-3.7 5.4-.6z" }]],
    flag: [["path", { d: "M5 21V4.5M5 4.5h11l-2 4 2 4H5" }]],
    copy: [["rect", { x: "9", y: "9", width: "11", height: "11", rx: "2" }], ["path", { d: "M5 15V6a2 2 0 0 1 2-2h8" }]],
    expand: [["path", { d: "M15 3.5h5.5V9M9 20.5H3.5V15M20.5 3.5 14 10M3.5 20.5 10 14" }]],
    gotcha: [["path", { d: "M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" }], ["path", { d: "M12 9.5v4M12 17h.01" }]],
  };
  function icon(name, size = "sm") {
    if (!SHAPES[name]) return globalThis.DelphiIcons ? DelphiIcons.icon(name, size) : document.createElement("span");
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", `i${size ? ` ${size}` : ""}`);
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of SHAPES[name]) {
      const node = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      svg.append(node);
    }
    return svg;
  }
  /** Three bars, as many filled as the priority is high. */
  function bars(priority) {
    const lit = priority === "high" ? 3 : priority === "low" ? 1 : 2;
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("class", "i sm dw-bars");
    svg.setAttribute("aria-hidden", "true");
    [[2, 10, 3], [6.5, 7, 6], [11, 3, 10]].forEach(([x, y, h], i) => {
      const r = document.createElementNS(SVG, "rect");
      for (const [k, v] of Object.entries({ x, y, width: 3, height: h, rx: 0.8 })) r.setAttribute(k, String(v));
      r.setAttribute("class", i < lit ? "on" : "off");
      svg.append(r);
    });
    return svg;
  }
  /** The status mark: an empty ring, half a ring, a stop, or a tick. */
  function statusMark(status) {
    const s = host ? host.statusOf({ status }) : status;
    const span = el("span", { className: `dw-st st-${s}` });
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  const button = (cls, label, onclick, { title = "", text = null, kids = [] } = {}) => {
    const b = el("button", { className: cls, type: "button" }, ...kids);
    if (text != null) b.append(text);
    if (label) b.setAttribute("aria-label", label);
    if (title || label) b.title = title || label;
    if (onclick) b.onclick = onclick;
    return b;
  };
  const iconBtn = (name, label, onclick, act) => {
    const b = button("dw-ib", label, onclick, { kids: [icon(name)] });
    if (act) b.dataset.act = act;
    return b;
  };

  const parse = (stamp) => (stamp && window.delphiTime ? window.delphiTime.parseStamp(stamp) : null);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  /** "Sep 20", or "Sep 20, 2025" for another year: a date at a glance. */
  function shortDate(stamp) {
    const d = parse(stamp);
    if (!d || Number.isNaN(d.getTime())) return "";
    const now = new Date();
    return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() === now.getFullYear() ? "" : `, ${d.getFullYear()}`}`;
  }
  const ago = (stamp) => (host ? host.gap(stamp) : "");
  const agoWords = (stamp) => { const g = ago(stamp); return g === "moments" ? "moments ago" : `${g} ago`; };

  /** Initials and a colour for whoever wrote something: an agent's own mark, or a person's. */
  function avatar(name, size = "") {
    const who = String(name || "").trim();
    const lower = who.toLowerCase();
    const agent = /claude/.test(lower) ? "claude" : /codex/.test(lower) ? "codex" : /copilot/.test(lower) ? "copilot" : null;
    const letters = agent === "claude" && /code/.test(lower) ? "CC"
      : agent === "codex" ? "Cx" : agent === "copilot" ? "Co"
      : (who.match(/[A-Za-z0-9]/g) || ["?"]).slice(0, 2).join("").replace(/^./, (c) => c.toUpperCase());
    const node = el("span", { className: `dw-av ${agent ? `a-${agent}` : host && host.isAgent(who) ? "a-other" : "a-person"} ${size}`.trim(), textContent: letters });
    node.setAttribute("aria-hidden", "true");
    return node;
  }

  /** Text for the clipboard, said in the button's own title for a moment. */
  async function copyText(text, b, done = "Copied") {
    try {
      await navigator.clipboard.writeText(text);
      flashTitle(b, done);
    } catch { flashTitle(b, "Could not copy"); }
  }
  function flashTitle(b, words) {
    if (!b) return;
    const before = b.title;
    b.title = words;
    b.classList.add("done");
    setTimeout(() => { b.title = before; b.classList.remove("done"); }, 1400);
  }

  // --- stuck, related, order: pure, so the test can check them -------------

  /**
   * Days since anything moved on a task, when that is long enough to say so,
   * else null. Movement is an edit, a status change, a Sheet entry or a run.
   * To do and Done never count as stuck, by the owner's rule; doing,
   * blocked and (from slice 11) in review are amber from 3 days, and all but
   * blocked are red from 7. today/brief.js is the store's reading of the
   * same rule; this one covers a drawer opened before Today has loaded.
   */
  function stuck(detail, runs = [], now = Date.now()) {
    const t = detail && detail.task;
    if (!t || !["doing", "blocked", "review"].includes(t.status)) return null;
    const stamps = [t.updated_at, t.created_at];
    for (const e of detail.events || []) stamps.push(e.at);
    for (const c of detail.comments || []) stamps.push(c.created_at);
    for (const r of runs) if (r.task_id === t.id) stamps.push(r.updated_at || r.created_at);
    let last = 0;
    for (const s of stamps) {
      const d = parse(s);
      if (d && !Number.isNaN(d.getTime())) last = Math.max(last, d.getTime());
    }
    if (!last) return null;
    const days = Math.floor((now - last) / 86400000);
    if (days < 3) return null;
    return { days, level: t.status !== "blocked" && days >= 7 ? "red" : "amber", words: `No movement in ${days} ${days === 1 ? "day" : "days"}` };
  }

  /**
   * Why a note belongs in a task's Memory, in words, or null when it does not.
   * Filed from this task's Sheet, named in its description, or mentioning it.
   */
  function related(task, note, filedIds = new Set()) {
    if (filedIds.has(note.id)) return "Filed from this Sheet";
    const desc = String(task.detail || "");
    if (new RegExp(`\\bnote\\s*#?${note.id}\\b`, "i").test(desc)) return "Named in the description";
    const text = `${note.title || ""}\n${note.body || ""}`;
    if (new RegExp(`(^|[^\\w&])#${task.id}\\b`).test(text)) return `Mentions #${task.id}`;
    return null;
  }

  /** Subtasks in the order this viewer dragged them into, new ones last. */
  function ordered(subtasks, saved) {
    const at = new Map((saved || []).map((id, i) => [id, i]));
    return subtasks.slice().sort((a, b) => (at.has(a.id) ? at.get(a.id) : 1e9 + a.id) - (at.has(b.id) ? at.get(b.id) : 1e9 + b.id));
  }

  /**
   * What saving a box should do, from three texts: the stored text the box
   * last took (base), the stored text now (theirs) and the box (mine). Agents
   * write the same rows while a person types, so a save that ignored theirs
   * would put the person's older copy over an agent's newer one.
   *   "none"     nothing to write: mine is what was taken
   *   "take"     nothing typed here, and it moved: show theirs
   *   "same"     it moved to exactly what is typed here: nothing to write
   *   "write"    only this box moved: write mine
   *   "conflict" both moved: a person has to choose
   */
  function reconcile(base, theirs, mine) {
    const b = String(base == null ? "" : base);
    const t = theirs == null ? b : String(theirs);
    const m = String(mine == null ? "" : mine);
    if (m === b) return t === b ? "none" : "take";
    if (t === b) return "write";
    return t === m ? "same" : "conflict";
  }

  /** A person's choice when both copies moved: theirs, mine, or neither yet (null). */
  async function chooseCopy(label) {
    if (!host || !host.wb || !host.wb.dialog) return null;
    return host.wb.dialog({
      title: `${label} changed while you were writing`,
      lead: "It was saved from somewhere else, often an agent, after you began. Keep yours over it, or take theirs. Until you choose, yours is kept as a draft and nothing is written.",
      actions: [{ label: "Not now", value: null }, { label: "Take theirs", value: "theirs" }, { label: "Keep mine", value: "mine", kind: "primary" }],
      cancelValue: null,
    });
  }

  /** What the composer will post, read from its mode and any prefix typed. */
  function composed(raw, mode, { openAsk = null, where = "" } = {}) {
    let v = String(raw || "");
    let kind = mode;
    const slash = /^\/(say|run|ask|decide|note)\b ?/.exec(v);
    if (slash) { kind = slash[1]; v = v.slice(slash[0].length); }
    else if (/^\$ /.test(v)) { kind = "run"; v = v.slice(2); }
    else if (/^! /.test(v)) { kind = "note"; v = v.slice(2); }
    else if (/^\? /.test(v)) { kind = "ask"; v = v.slice(2); }
    if (kind === "run") {
      const command = v.trim();
      return { kind, ok: !!command, command, say: `Runs in ${where || "the project's folder"}, output is kept` };
    }
    if (kind === "note") return { kind, ok: !!v.trim(), body: v.trim(), say: "Posts a note" };
    if (kind === "ask") {
      const parts = v.split("|").map((s) => s.trim()).filter(Boolean);
      const n = parts.length - 1;
      const ok = n >= 2 && n <= 4;
      return { kind, ok, question: parts[0], options: parts.slice(1),
        say: ok ? `Asks "${parts[0]}" with ${n} options, a to ${"abcd"[n - 1]}` : "An ask is a question and 2 to 4 options: question | a | b" };
    }
    if (kind === "decide") {
      if (!openAsk) return { kind, ok: false, say: "Nothing to decide: no question on this Sheet is open" };
      const [first, ...rest] = v.trim().split(/\s+/);
      const options = (openAsk.meta && Array.isArray(openAsk.meta.options)) ? openAsk.meta.options : [];
      const hit = options.find((o) => String(o.key).toLowerCase() === String(first || "").toLowerCase());
      return { kind, ok: !!hit, askId: openAsk.id, choice: hit ? hit.key : null, why: rest.join(" ").trim() || null,
        say: hit ? `Decides "${openAsk.body}": ${hit.label}` : `Decides "${openAsk.body}": type ${options.map((o) => o.key).join(", ")}, then why` };
    }
    return { kind: "say", ok: !!v.trim(), body: v, say: "Posts a comment" };
  }

  // --- the frame -----------------------------------------------------------

  /**
   * The drawer element, mounted, with focus moved in and a trap on Tab. The
   * caller fills head, body and foot. close() runs the caller's own save
   * first, then puts focus back where it was before the drawer opened.
   */
  function frame({ label, onClose }) {
    const opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    // Named as well as held: the row that opened the drawer is often redrawn
    // by the write the drawer made, and the new node is the one to go back to.
    const openerKey = opener ? (opener.closest && opener.closest("[data-task-id]") ? `[data-task-id="${opener.closest("[data-task-id]").dataset.taskId}"]`
      : opener.dataset && opener.dataset.act ? `[data-act="${CSS.escape(opener.dataset.act)}"]` : opener.id ? `#${CSS.escape(opener.id)}` : null) : null;
    const root = el("aside", { className: "dw", tabIndex: -1 });
    root.setAttribute("role", "dialog");
    // Not aria-modal: the page beside it stays live to the pointer. Tab is
    // kept inside, and focus comes back where it was on close.
    root.setAttribute("aria-label", label);
    const head = el("div", { className: "dw-head" });
    const body = el("div", { className: "dw-body" });
    const foot = el("div", { className: "dw-foot" });
    root.append(head, body, foot);
    if (host.motionOff()) root.classList.add("still");
    document.body.append(root);
    requestAnimationFrame(() => root.classList.add("on"));

    const focusables = () => [...root.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")]
      .filter((n) => !n.disabled && n.offsetParent !== null);
    root.addEventListener("keydown", (e) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const all = focusables();
      if (!all.length) return;
      const first = all[0];
      const last = all[all.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    // A click on the page beside the drawer closes it, except on a task row,
    // whose own click opens that task here instead; and never from inside a
    // menu, a dialog or a toast the drawer opened.
    // A repaint can drop focus to the page; the next Tab comes back in here
    // rather than wandering off behind the drawer.
    const stray = (e) => {
      if (e.key !== "Tab" || !root.isConnected) return;
      const a = document.activeElement;
      if (a && a !== document.body) return;
      if (document.querySelector("body > .overlay, .ctx")) return;
      e.preventDefault();
      (focusables()[0] || root).focus({ preventScroll: true });
    };
    document.addEventListener("keydown", stray, true);
    const away = (e) => {
      const t = e.target;
      if (!t || !t.closest || root.contains(t)) return;
      if (t.closest(".ctx, .overlay, .wb-toast, .pop, [data-task-id]")) return;
      close();
    };
    let closed = false;
    const arm = setTimeout(() => { if (!closed) document.addEventListener("mousedown", away, true); }, 0);
    let closing = null;
    function close() {
      if (closed) return closing;
      closed = true;
      closing = shut();
      // The next drawer waits for this one's saves (and any question they
      // ask) before it reads anything, so it never opens on a stale row.
      lastClose = closing;
      return closing;
    }
    async function shut() {
      clearTimeout(arm);
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("keydown", stray, true);
      if (host.sheet() === me.handle) host.setSheet(null);
      if (cur === me) cur = null;
      try { if (onClose) await onClose(); } finally {
        root.remove();
        // Not over a field somebody has just clicked into.
        const now = document.activeElement;
        const busy = now && now !== document.body && !root.contains(now);
        let back = opener && opener.isConnected ? opener : null;
        if (!back && openerKey) back = [...document.querySelectorAll(`#content ${openerKey}, ${openerKey}`)].find((n) => n.offsetParent !== null) || null;
        if (!busy && back && typeof back.focus === "function") back.focus({ preventScroll: true });
      }
    }
    const me = { root, head, body, foot, close, handle: null, focusFirst: () => (focusables()[0] || root).focus({ preventScroll: true }) };
    return me;
  }

  /** The row at the top: where it lives, then the actions, then close. */
  function topRow(crumbs, actions, flashHost, close) {
    const row = el("div", { className: "dw-top" });
    const crumb = el("nav", { className: "dw-crumb" });
    crumb.setAttribute("aria-label", "Where this lives");
    crumbs.forEach((c, i) => {
      if (i) crumb.append(icon("right", "xs"));
      crumb.append(c);
    });
    const closeBtn = iconBtn("x", "Close (Escape)", close, "close");
    row.append(crumb, el("span", { className: "grow" }), flashHost, ...actions, el("span", { className: "dw-sep" }), closeBtn);
    return row;
  }
  function projectCrumb(project, onclick) {
    if (!project) return el("span", { className: "dw-crumb-now", textContent: "No project" });
    const b = button("dw-crumb-p", `Open ${project.name}`, onclick, { kids: [el("span", { className: "dw-sw", style: `background:${safeColour(project.colour, "var(--accent)")}` }), el("b", { textContent: project.name })] });
    return b;
  }

  /** A section that folds, remembered per viewer. */
  function foldSection(key, title, { onToggle } = {}) {
    const wrap = el("section", { className: "dw-fold" });
    wrap.dataset.fold = key;
    const head = el("button", { className: "dw-fold-h", type: "button" });
    const id = `dw-fold-${key}-${Math.random().toString(36).slice(2, 7)}`;
    head.setAttribute("aria-controls", id);
    const ct = el("span", { className: "ct" });
    const sum = el("span", { className: "sum" });
    head.append(el("span", { className: "chev" }, icon("right", "xs")), el("b", { textContent: title }), ct, sum);
    const body = el("div", { className: "dw-fold-b", id });
    wrap.append(head, body);
    const api = {
      wrap, body, key,
      isOpen: () => wrap.classList.contains("open"),
      set(open, { save = true, quiet = false } = {}) {
        wrap.classList.toggle("open", open);
        head.setAttribute("aria-expanded", String(open));
        body.hidden = !open;
        if (save) setFold(key, open);
        if (onToggle && !quiet) onToggle(open);
      },
      meta(count, summary) {
        ct.textContent = count == null || count === "" ? "" : String(count);
        sum.textContent = api.isOpen() ? "" : summary || "";
        api._summary = summary || "";
      },
    };
    head.onclick = () => { api.set(!api.isOpen()); sum.textContent = api.isOpen() ? "" : api._summary || ""; };
    api.set(Boolean(folds()[key]), { save: false, quiet: true });
    return api;
  }

  const SPLIT_MIN = 0.2;
  const SPLIT_MAX = 0.8;
  const splitOf = (kind) => {
    const r = Number(store.get(`delphi.drawer.split.${kind}`, 0.5));
    return Number.isFinite(r) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, r)) : 0.5;
  };
  // Typing in Split repaints the preview after a pause rather than per key:
  // a 2,000-line pad renders in a few milliseconds, but not forty times a
  // second while somebody types a sentence.
  const PREVIEW_WAIT = 90;

  /**
   * Write, Preview and Split over one text, rendered with the app's markdown
   * renderer (ui/markdown.js). The one editor for every long text a person
   * edits: a task's description, a note and a pad, here and in the Pads tab
   * (app.js), which is why it is exported.
   *
   * kind names the surface, and each surface remembers its own mode and its
   * own split. A checkbox ticked in the preview edits its line of the text by
   * line number (DelphiMarkdown.toggleTask), never by matching its words, and
   * is saved straight away. A surface with its own route for a tick (a pad's
   * task goes through the board's update) passes toggle(tick, api).
   */
  function editor({ label, kind, value, onSave, current = null, placeholder = "", draftKey = null, onMode = null, preview = (s) => s, toggle = null, tickStore = null }) {
    let mode = modeOf(kind);
    // Line endings as a textarea has them. A textarea turns CRLF into LF, so a
    // CRLF pad compared with what it was given would never look saved; every
    // copy of the stored text is read through this before it is compared.
    const lf = (v) => DelphiMarkdown.lf(v);
    let text = lf(value || "");
    // The stored text this box last took. A save compares the store against
    // it (reconcile), and a write from elsewhere waits in pending while the
    // box is being typed in, to be taken on blur when nothing was typed.
    let saved = text;
    let remote = null;
    // A draft restored from an earlier run was typed against an older copy,
    // so it is only written once somebody types here again.
    let restored = false;
    let ratio = splitOf(kind);
    const wrap = el("div", { className: "dw-ed" });
    wrap.dataset.kind = kind;
    const bar = el("div", { className: "dw-ed-bar" }, el("span", { className: "lbl", textContent: label }), el("span", { className: "grow" }));
    const seg = el("div", { className: "dw-seg", role: "group" });
    seg.setAttribute("aria-label", `${label} display`);
    const segButtons = {};
    for (const [m, name, ic] of [["write", "Write", "write"], ["preview", "Preview", "eye"], ["split", "Split", "split"]]) {
      const b = button("", null, () => setTo(m), { kids: [icon(ic, "xs")], text: name });
      b.dataset.act = `mode-${m}`;
      segButtons[m] = b;
      seg.append(b);
    }
    bar.append(seg);
    const bodyBox = el("div", { className: "dw-ed-body" });
    const area = el("textarea", { className: "dw-raw", spellcheck: false, value: text, placeholder });
    area.setAttribute("aria-label", label);
    const prev = el("div", { className: "dw-prev", tabIndex: 0 });
    prev.setAttribute("aria-label", `${label}, formatted. Press Enter to edit.`);
    // The handle between the two halves of Split: a drag, or the arrow keys.
    const handle = el("div", { className: "dw-split", tabIndex: 0, role: "separator" });
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", `Resize the ${label.toLowerCase()} source and preview`);
    handle.setAttribute("aria-valuemin", String(SPLIT_MIN * 100));
    handle.setAttribute("aria-valuemax", String(SPLIT_MAX * 100));
    const setRatio = (r, { save = true } = {}) => {
      ratio = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, r));
      handle.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
      if (mode === "split") bodyBox.style.gridTemplateColumns = `minmax(0, ${ratio}fr) 7px minmax(0, ${1 - ratio}fr)`;
      if (save) store.set(`delphi.drawer.split.${kind}`, Number(ratio.toFixed(3)));
    };
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("drag");
      const box = bodyBox.getBoundingClientRect();
      const move = (ev) => setRatio((ev.clientX - box.left) / Math.max(1, box.width), { save: false });
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        handle.classList.remove("drag");
        setRatio(ratio);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
    handle.addEventListener("keydown", (e) => {
      const step = { ArrowLeft: -0.05, ArrowRight: 0.05 }[e.key];
      if (step) { e.preventDefault(); e.stopPropagation(); setRatio(ratio + step); }
      else if (e.key === "Home" || e.key === "End") { e.preventDefault(); setRatio(e.key === "Home" ? SPLIT_MIN : SPLIT_MAX); }
    });
    handle.addEventListener("dblclick", () => setRatio(0.5));

    if (draftKey && window.DelphiRecovery) {
      const kept = DelphiRecovery.draft(draftKey[0], draftKey[1]);
      if (kept != null && kept !== "" && kept !== text) { area.value = kept; text = kept; restored = true; }
      area.addEventListener("input", () => DelphiRecovery.saveDraft(draftKey[0], draftKey[1], area.value === saved ? "" : area.value));
    }
    const grow = () => {
      if (mode === "split") { area.style.height = ""; return; }
      area.style.height = "auto";
      area.style.height = `${Math.max(120, area.scrollHeight + 2)}px`;
    };
    let pending = null;
    const paintPreview = () => {
      if (pending) { clearTimeout(pending); pending = null; }
      const src = preview(area.value);
      // The checkboxes carry line numbers into this text, so they are live
      // only while the preview is drawn from it unchanged.
      const live = src === area.value;
      const node = src.trim()
        ? host.renderMarkdown(src, live ? { onToggle: (tick) => ticked(tick) } : {})
        : el("span", { className: "dw-blank", textContent: placeholder || "Nothing written yet" });
      prev.replaceChildren(node);
    };
    const paintSoon = () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(paintPreview, PREVIEW_WAIT);
    };
    area.addEventListener("input", () => { restored = false; text = area.value; if (mode === "split") paintSoon(); grow(); });
    const take = (v) => {
      saved = v == null ? "" : lf(v);
      remote = null;
      area.value = saved;
      text = saved;
      if (mode !== "write") paintPreview();
      grow();
    };
    let inflight = null;
    const commit = async () => {
      // Waits out a save already going, refused or not, so one text is never
      // sent twice and a refusal does not throw out of the next caller.
      while (inflight) { try { await inflight; } catch {} }
      const next = area.value;
      if (next === saved) {
        if (remote != null && document.activeElement !== area) take(remote);
        return;
      }
      if (restored) return;
      const run = (async () => {
        // The stored copy, read now. Unreadable means nothing is written: a
        // save that cannot check is the one that loses an agent's work.
        const read = async () => {
          if (!current) return remote == null ? saved : remote;
          try { const v = await current(); return v == null ? undefined : lf(v); } catch { return undefined; }
        };
        let theirs = await read();
        if (theirs === undefined) { host.notify(`${label} could not be checked against the stored copy, so it was not saved. It is kept here.`); return "kept"; }
        let what = reconcile(saved, theirs, next);
        // Asked again if it moved once more while the question was open, so
        // "Keep mine" never lands on a copy nobody saw.
        for (let round = 0; what === "conflict" && round < 3; round++) {
          const pick = await chooseCopy(label);
          // Theirs, chosen: the box shows it, even over words typed while the
          // question was open, or the next blur would write them over it.
          if (pick === "theirs") { take(theirs); return "done"; }
          if (pick !== "mine") return "kept";
          const again = await read();
          if (again === undefined) return "kept";
          if (again === theirs) { what = "write"; break; }
          theirs = again;
          what = reconcile(saved, theirs, next) === "same" ? "same" : "conflict";
        }
        if (what === "conflict") return "kept";
        if (what === "same") { saved = next; remote = null; return "done"; }
        // Marked saved only once it is, so a refused write is tried again on
        // the next blur or close rather than taken as done. What the store
        // kept (a pad with its <!--d:N--> anchors) becomes the box's text,
        // unless more was typed meanwhile.
        const stored = await onSave(next);
        const now = stored == null ? next : lf(stored);
        if (area.value === next) take(now); else { saved = now; remote = null; }
        return "done";
      })();
      inflight = run;
      let outcome = null;
      try { outcome = await run; } catch (error) { host.notifyError(error); return; } finally { inflight = null; }
      if (outcome === "done" && draftKey && window.DelphiRecovery && area.value === saved) DelphiRecovery.clearDraft(draftKey[0], draftKey[1]);
    };
    area.addEventListener("blur", commit);

    /** The text as stored now, put in place without losing what is being typed. */
    function replace(next, tick = null) {
      // tick is the box just written to the stored text; null when nothing
      // was, so typing here is kept as it is.
      next = lf(next || "");
      if (area.value === saved) {
        area.value = next;
      } else if (tick) {
        // Somebody typed while the tick was saving. Their text stays, with the
        // same box ticked in it, so the save their blur makes cannot untick it.
        const local = DelphiMarkdown.toggleTask(area.value, tick.line, tick.checked, tick.text);
        if (local != null) area.value = local;
      }
      saved = next;
      remote = null;
      text = area.value;
      if (mode !== "write") paintPreview();
      grow();
    }
    let ticking = Promise.resolve();
    function ticked(tick) {
      // One at a time and in order, so two quick ticks cannot save over each
      // other.
      ticking = ticking.then(() => tickNow(tick)).catch((error) => { host.notifyError(error); paintPreview(); });
      return ticking;
    }
    async function tickNow(tick) {
      const api = { dirty: () => area.value !== saved, replace: (next, { ticked = true } = {}) => replace(next, ticked ? tick : null), local: () => tickLocal(tick) };
      if (tickStore) return tickStored(tick);
      if (toggle) return toggle(tick, api);
      return tickLocal(tick);
    }
    const REFUSED = {
      changed: "That line changed since it was shown, so nothing was ticked. Try again.",
      ambiguous: "That line is in the text twice and the text moved since it was shown, so nothing was ticked. Try again.",
    };
    /**
     * A tick written to the stored text in one step in the main process
     * (db.toggleLine), never by saving this box: the stored copy is read,
     * the line placed and written inside one transaction. What is stored
     * after comes back and is taken in, with any typing here kept and the same
     * box ticked in it.
     */
    async function tickStored(tick) {
      const { line, checked, text: words, source } = tick;
      let got;
      try { got = await tickStore({ line, checked, text: words, source }); } catch (error) { host.notifyError(error); paintPreview(); return; }
      if (!got) { paintPreview(); return; }
      if (got.refused) {
        replace(got.body, null);
        host.notify(REFUSED[got.refused] || REFUSED.changed);
        return;
      }
      replace(got.body, tick);
      if (draftKey && window.DelphiRecovery && area.value === saved) DelphiRecovery.clearDraft(draftKey[0], draftKey[1]);
    }
    async function tickLocal(tick) {
      // Nothing typed here and the stored text moved (an agent wrote it): the
      // tick goes onto the stored text, never onto this older copy, and only
      // if its line is still the line that was drawn.
      if (current && area.value === saved) {
        let fresh;
        try { fresh = await current(); } catch { fresh = undefined; }
        if (fresh === undefined || fresh === null) { host.notify(`${label} could not be read, so nothing was ticked.`); paintPreview(); return; }
        if (fresh !== saved) {
          const onTheirs = DelphiMarkdown.toggleTask(fresh, tick.line, tick.checked, tick.text);
          if (onTheirs == null) { take(fresh); host.notify("That line changed since it was shown, so nothing was ticked. Try again."); return; }
          const stored = await onSave(onTheirs);
          take(stored == null ? onTheirs : stored);
          if (draftKey && window.DelphiRecovery) DelphiRecovery.clearDraft(draftKey[0], draftKey[1]);
          return;
        }
      }
      const next = DelphiMarkdown.toggleTask(area.value, tick.line, tick.checked, tick.text);
      if (next == null) {
        // The line moved or changed since the preview was drawn. Redrawn
        // rather than guessed at.
        paintPreview();
        host.notify("That line changed since it was shown. Try again.");
        return;
      }
      area.value = next;
      text = next;
      if (draftKey && window.DelphiRecovery) DelphiRecovery.saveDraft(draftKey[0], draftKey[1], next === saved ? "" : next);
      await commit();
      if (mode !== "write") paintPreview();
    }

    // A click on the formatted text is a request to edit it, unless it was a
    // drag to select something to copy.
    prev.addEventListener("click", (e) => {
      if (e.target.closest("a, button, input, label")) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      if (mode === "preview") { setTo("write"); area.focus(); }
    });
    prev.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || mode !== "preview" || e.target !== prev) return;
      e.preventDefault();
      setTo("write");
      area.focus();
    });
    function setTo(m) {
      mode = m;
      setMode(kind, m);
      paint();
      if (onMode) onMode(m);
    }
    function paint() {
      for (const [m, b] of Object.entries(segButtons)) { b.classList.toggle("on", m === mode); b.setAttribute("aria-pressed", String(m === mode)); }
      bodyBox.className = `dw-ed-body ${mode}`;
      bodyBox.style.gridTemplateColumns = "";
      bodyBox.textContent = "";
      if (mode !== "preview") bodyBox.append(area);
      if (mode === "split") { bodyBox.append(handle); setRatio(ratio, { save: false }); }
      if (mode !== "write") { paintPreview(); bodyBox.append(prev); }
      requestAnimationFrame(grow);
    }
    wrap.append(bar, bodyBox);
    paint();
    return {
      node: wrap, area, commit, mode: () => mode,
      // A write from elsewhere: taken now when nobody is typing here, else
      // kept until blur (taken if nothing was typed) or a save (reconciled).
      update(next) {
        const v = next == null ? "" : lf(next);
        if (v === saved) { remote = null; return; }
        if (document.activeElement === area || area.value !== saved) { remote = v; return; }
        take(v);
      },
      setTo,
    };
  }

  /**
   * A pad in the editor, for the drawer and the Pads tab alike.
   *
   * A tick in a pad is a task changing, so it takes the route the board's own
   * tick takes when the line is a task this pad files: tasks.update, whose
   * write-back (db.writeBackToPad) rewrites the line. That is the same rule an
   * agent-held task or one In review meets on the board, and the same Finish
   * prompt when a task with a Workbench is done. A line that is not filed yet,
   * or a pad that files nothing, is plain text: the line is flipped in the
   * pad as stored now and written through pads.write, whose derivation files
   * it. Either way the stored pad is read first and the line checked against
   * what was drawn, so a pad an agent appended to since it was opened is not
   * written back over with the copy this window holds.
   */
  function padEditor(pad, { label = "Pad", kind = "pad", onSaved = null, onMode = null, value = null, draftKey = null } = {}) {
    const after = (row) => { if (row && typeof row.body === "string") pad.body = row.body; if (onSaved) onSaved(pad); return pad.body; };
    const ed = editor({
      label, kind, value: value != null ? value : pad.body || "", draftKey: draftKey || ["padbody", pad.id], onMode,
      placeholder: "The plan, as checkbox lines: - [ ] the thing to do",
      // Every save is checked against the pad as stored (reconcile in the
      // editor), so an agent's append or a status the board wrote back into
      // a line is never written over with the copy this box holds.
      current: async () => { const f = await window.delphi.pads.get(pad.id); return f ? f.body || "" : null; },
      // What comes back is the pad with the anchors the derive wrote into new
      // lines, and the box takes it, so the next save keeps them and a renamed
      // line stays the same task.
      onSave: async (body) => {
        const row = await window.delphi.pads.write(pad.id, { body, author: "you" });
        // No body back means no anchors to take: keep what was sent.
        if (!row || typeof row.body !== "string") { pad.body = body; if (onSaved) onSaved(pad); return body; }
        return after(row);
      },
      // A tick is read, placed and written in one unit in the main process
      // (db.toggleLine): a task this pad files goes through the board's own
      // update, any other line through the pad's write and its derivation.
      tickStore: async (t) => {
        const r = await window.delphi.markdown.tick("pad", pad.id, t);
        if (r && typeof r.body === "string" && !r.refused) { pad.body = r.body; if (onSaved) onSaved(pad); host.refresh(); }
        return r;
      },
    });
    return ed;
  }

  /** A small inline editor that replaces a chip until it is done. */
  function inlineEdit(chip, field, done) {
    chip.replaceWith(field);
    field.focus();
    let over = false;
    const finish = async (save) => {
      if (over) return;
      over = true;
      if (save) await save();
      done();
    };
    return finish;
  }

  /**
   * A title that reads as a heading, cut at a few lines, and becomes its
   * textarea on a click or on focus. A textarea cannot be cut short with an
   * ellipsis, and a long agent-written title would otherwise push the whole
   * document down the drawer.
   */
  function titleField(area, cls = "", { revert = null } = {}) {
    // A heading for the reader and a button for the editor: focus alone never
    // starts an edit, so Tab and Shift+Tab pass through it.
    const btn = el("button", { className: "dw-title-btn", type: "button" });
    const view = el("h2", { className: `dw-title view ${cls}`.trim() }, btn);
    const wrap = el("div", { className: "dw-title-box" }, view, area);
    const show = () => {
      btn.textContent = area.value;
      btn.setAttribute("aria-label", `${area.getAttribute("aria-label") || "Title"}: ${area.value}. Press Enter to edit`);
      btn.title = "Click to edit";
      view.hidden = false;
      area.hidden = true;
    };
    const edit = () => {
      view.hidden = true;
      area.hidden = false;
      area.focus();
      area.style.height = "auto";
      area.style.height = `${area.scrollHeight}px`;
    };
    btn.addEventListener("click", edit);
    area.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== area) show(); }, 0));
    // Enter and Escape end an edit with focus back on the title, never on the page.
    area.addEventListener("keydown", (e) => {
      // Enter while an input method is composing belongs to the composition.
      if (e.isComposing) return;
      if (e.key === "Enter" || e.key === "Escape") {
        // Escape cancels: the task's saved title comes back, and the draft goes.
        if (e.key === "Escape") { e.stopPropagation(); if (revert) area.value = revert(); }
        e.preventDefault();
        area.blur();
        show();
        btn.focus({ preventScroll: true });
      }
    });
    show();
    return { node: wrap, show, edit, view, button: btn };
  }

  /**
   * A note's or a pad's title, kept against the stored one the way the task
   * title and every editor are: an untouched box takes a rename from
   * elsewhere, and a typed one that meets a rename asks before writing.
   */
  function titleKeeper(area, { label, fetch, write, onTake }) {
    let base = area.value;
    let touched = false;
    let busy = null;
    area.addEventListener("input", () => { touched = true; });
    const take = (v) => { base = v; area.value = v; touched = false; if (onTake) onTake(); };
    async function save() {
      // One at a time, and words typed while one ran get their own turn.
      if (busy) { await busy; return save(); }
      busy = (async () => {
        await null;
        try {
          const next = area.value.trim();
          if (!next || next === String(base).trim() || !touched) return;
          let theirs;
          try { theirs = await fetch(); } catch { return; }
          if (theirs == null) return;
          const what = reconcile(base, theirs, next);
          if (what === "same") { base = next; touched = false; return; }
          if (what === "conflict") {
            const pick = await chooseCopy(label);
            if (pick === "theirs") { take(theirs); return; }
            if (pick !== "mine") return;
          }
          await write(next);
          base = next;
          touched = false;
        } catch (error) { host.notifyError(error); }
        finally { busy = null; }
      })();
      return busy;
    }
    return {
      save,
      base: () => base,
      update(v) { if (v != null && v !== base && document.activeElement !== area && area.value === base) take(v); },
    };
  }

  // --- the task ------------------------------------------------------------

  async function open(taskId, { focus = null } = {}) {
    if (!host) return;
    const ticket = ++opening;
    const before = host.sheet();
    if (before) await before.close();
    if (lastClose) await lastClose.catch(() => {});
    let detail = await window.delphi.tasks.detail(taskId);
    if (!detail || ticket !== opening) return;
    taskId = detail.task.id;

    const S = host.state();
    // Drafts are kept under the task's id and its created_at, so a draft can
    // only come back into the task it was typed for (ui/recovery.js).
    let gone = false;
    const draftOf = (window.DelphiRecovery && DelphiRecovery.taskDraftId && DelphiRecovery.taskDraftId(detail.task)) || taskId;
    const me = frame({ label: `Task ${taskId}: ${detail.task.title}`, onClose: async () => {
      if (window.DelphiRecovery) DelphiRecovery.taskClosed();
      // Deleted elsewhere: there is nothing to save into, and typing stays as
      // a recovery draft rather than an error.
      if (gone) return;
      await saveTitle();
      // Closing takes the focused box away without a dependable blur, so the
      // description is saved here as well as on blur.
      if (desc) await desc.commit();
    } });
    cur = me;
    me.root.classList.add("dw-task");
    me.root.dataset.task = String(taskId);

    const flashHost = el("span", { className: "dw-flash", role: "status" });
    const flash = (text) => {
      flashHost.textContent = text;
      setTimeout(() => { if (flashHost.textContent === text) flashHost.textContent = ""; }, 1600);
    };
    const reload = async () => {
      const next = await window.delphi.tasks.detail(taskId);
      if (!next) { me.close(); return; }
      detail = next;
      paintAll();
    };
    const write = async (fields, note) => {
      try { await window.delphi.tasks.update(taskId, fields); } catch (error) { host.notifyError(error); return; }
      if (note) flash(note);
      await reload();
      host.refresh();
    };
    const runsHere = () => (host.state().runs || []).filter((r) => r.task_id === taskId);
    const projectRow = () => (detail.project ? (host.state().projects || []).find((p) => p.id === detail.project.id) || detail.project : null);

    // --- header ---
    const taskItem = () => host.itemOf("task", {
      ...detail.task,
      project_name: detail.project ? detail.project.name : null,
      project_colour: detail.project ? detail.project.colour : null,
      associated: S.projectId && detail.task.project_id !== S.projectId && !detail.parent ? 1 : 0,
    });
    const top = el("div");
    function paintTop() {
      const crumbs = [projectCrumb(detail.project, async () => { await me.close(); host.goTo({ projectId: detail.project.id, view: "tasks", query: "" }); })];
      if (detail.parent) {
        const up = button("dw-crumb-up", `Open the parent task, #${detail.parent.id}`, () => host.openTask(detail.parent.id), { text: `#${detail.parent.id}` });
        crumbs.push(up);
      }
      crumbs.push(el("span", { className: "dw-crumb-now", textContent: `#${taskId}` }));
      const item = taskItem();
      if (item.associated) crumbs.push(host.fromChip(item));
      const full = iconBtn("expand", "Open full view (Shift and Enter)", () => host.openFull(taskId), "full");
      full.setAttribute("aria-keyshortcuts", "Shift+Enter");
      const share = iconBtn("share", "Share via MCP: copy a brief an agent can act on", (e) => copyText(host.handoffText(detail), e.currentTarget, "Brief copied"), "share");
      const del = iconBtn("trash", "Delete this task", () => host.deleteItem(taskItem(), { onDelete: () => me.close() }), "delete");
      const more = iconBtn("more", "More: hand to agent, full view, colour, queue, move, copy, flag", (e) => moreMenu(e.currentTarget), "more");
      more.setAttribute("aria-haspopup", "menu");
      top.textContent = "";
      // No pin: tasks have no pinned list yet. The button arrives with one.
      top.append(topRow(crumbs, [full, share, del, more], flashHost, () => me.close()));
    }

    function moreMenu(anchor) {
      const t = detail.task;
      const box = anchor.getBoundingClientRect();
      const repaint = async () => { await reload(); host.refresh(); };
      const set = async (fields) => { await window.delphi.tasks.update(taskId, fields); await repaint(); };
      const verb = (label, run, hint = "") => {
        const b = el("button", { className: "ctx-item", type: "button" }, el("span", { textContent: label }), hint ? el("span", { className: "d", textContent: hint }) : null);
        b.onclick = async () => { host.closeRowMenu(); await run(); };
        return { node: b };
      };
      anchor.setAttribute("aria-expanded", "true");
      const items = [
        el("div", { className: "ctx-head", textContent: `Task #${taskId}` }),
        verb("Hand to agent...", () => handToAgent(), "ask or do"),
        verb("Copy brief", () => copyText(host.handoffText(detail), anchor, "Brief copied"), "for any agent"),
        verb("Open full view", () => host.openFull(taskId), "the full panel"),
        "-",
        { node: host.swatchRow(t.colour, async (colour) => { host.closeRowMenu(); await set({ colour }); }) },
        "-",
        ...(t.queue
          ? [verb("Take out of the agent queue", async () => { await window.delphi.tasks.queue(taskId, null); await repaint(); })]
          : [verb("Send to the agent queue", async () => { await window.delphi.tasks.queue(taskId, "ready"); await repaint(); })]),
        ...host.epicMenuItems(t, repaint),
        ...host.itemVerbs(taskItem(), { after: reload }),
        "-",
        verb("History", async () => { await me.close(); host.goTo({ projectId: t.project_id || null, view: t.project_id ? "activity" : "history", query: "" }); }, "every change"),
      ];
      const menu = host.rowMenu(box.right - 260, box.bottom + 4, items, { className: "item-menu dw-menu", onClose: () => anchor.setAttribute("aria-expanded", "false") });
      host.menuKeys(menu, anchor);
    }

    // --- title ---
    const title = el("textarea", { className: "dw-title", rows: 1, value: detail.task.title, spellcheck: false });
    // The title the box last took from the task. A repaint replaces the box's
    // words only while they still are that, so a restored draft or an edit
    // whose save is on its way is never put back to the old title.
    let titleFrom = detail.task.title;
    title.setAttribute("aria-label", "Task title");
    // A restored draft was typed against an older title, so it is written
    // only once somebody types here again.
    let titleTouched = false;
    title.addEventListener("input", () => { titleTouched = true; });
    if (window.DelphiRecovery) {
      const kept = DelphiRecovery.draft("title", draftOf);
      if (kept && kept !== detail.task.title) title.value = kept;
      title.addEventListener("input", () => DelphiRecovery.saveDraft("title", draftOf, title.value === titleFrom ? "" : title.value));
    }
    const growTitle = () => { title.style.height = "auto"; title.style.height = `${title.scrollHeight}px`; };
    title.addEventListener("input", growTitle);
    title.addEventListener("focus", () => requestAnimationFrame(growTitle));
    title.addEventListener("blur", () => { saveTitle(); requestAnimationFrame(growTitle); });
    // Enter commits rather than adding a line: a title is one line of meaning
    // even when it wraps.
    let titleSaving = null;
    async function saveTitle() {
      if (titleSaving) { await titleSaving; return saveTitle(); }
      titleSaving = (async () => {
        // A turn first, so the finally below can never run before this
        // promise is stored, and leave a settled one in place for good.
        await null;
        try {
          const next = title.value.trim();
          const focused = document.activeElement === title;
          // Untouched since the task last gave it its words: take whatever
          // the task says now, which may be a rename that arrived meanwhile.
          if (!next || next === String(titleFrom).trim()) {
            if (!focused) { title.value = detail.task.title; titleFrom = detail.task.title; titleBox.show(); }
            if (window.DelphiRecovery) DelphiRecovery.clearDraft("title", draftOf);
            return;
          }
          if (!titleTouched) return;
          let theirs;
          // Unreadable means not written: the draft stays.
          try { const fresh = await window.delphi.tasks.detail(taskId); if (!fresh) return; theirs = fresh.task.title; } catch { return; }
          const what = reconcile(titleFrom, theirs, next);
          if (what === "same") { titleFrom = next; detail.task.title = next; return; }
          if (what === "conflict") {
            const pick = await chooseCopy("The title");
            if (pick === "theirs") {
              titleFrom = theirs; detail.task.title = theirs; titleTouched = false;
              title.value = theirs;
              if (document.activeElement !== title) titleBox.show();
              if (window.DelphiRecovery) DelphiRecovery.clearDraft("title", draftOf);
              return;
            }
            if (pick !== "mine") return;
          }
          await window.delphi.tasks.update(taskId, { title: next });
          detail.task.title = next;
          titleFrom = next;
          titleTouched = false;
          if (document.activeElement !== title) { title.value = next; titleBox.show(); }
          // Only a save that landed lets the draft go; a refused one keeps it.
          if (window.DelphiRecovery) DelphiRecovery.clearDraft("title", draftOf);
          host.refresh();
        } catch (error) { host.notifyError(error); }
        finally { titleSaving = null; }
      })();
      return titleSaving;
    }
    const ring = el("button", { className: "dw-ring", type: "button" });
    ring.dataset.act = "done";
    ring.onclick = () => write({ status: detail.task.status === "done" ? "todo" : "done" }, detail.task.status === "done" ? "reopened" : "marked done");
    const titleBox = titleField(title, "", { revert: () => { if (window.DelphiRecovery) DelphiRecovery.clearDraft("title", draftOf); return detail.task.title; } });
    const titleRow = el("div", { className: "dw-title-row" }, ring, titleBox.node);

    // --- status and props ---
    const statusBox = el("div", { className: "dw-statusbar", role: "group" });
    statusBox.setAttribute("aria-label", "Status. Keys 1 to 4");
    const props = el("div", { className: "dw-props" });
    const banners = el("div");

    function paintStatus() {
      const s = host.statusOf(detail.task);
      ring.className = `dw-ring st-${s}`;
      ring.setAttribute("aria-label", s === "done" ? "Reopen" : "Mark done");
      ring.title = ring.getAttribute("aria-label");
      statusBox.textContent = "";
      // In review joins these when slice 11 adds it; until then Blocked waits
      // behind the overflow, where it is still one key (3) away.
      for (const [v, key] of [["todo", "1"], ["doing", "2"], ["done", "4"]]) {
        const b = button(s === v ? "on" : "", null, () => { if (statusOf() !== v) write({ status: v }, `${STATUS_LABEL[v].toLowerCase()}`); },
          { kids: [statusMark(v)], text: STATUS_LABEL[v] });
        b.dataset.status = v;
        b.setAttribute("aria-pressed", String(s === v));
        b.setAttribute("aria-keyshortcuts", key);
        statusBox.append(b);
      }
      const blocked = s === "blocked";
      const over = button(`dw-st-more${blocked ? " on" : ""}`, blocked ? "Blocked. More statuses" : "More statuses: Blocked", (e) => {
        const box = e.currentTarget.getBoundingClientRect();
        const m = host.rowMenu(box.right - 180, box.bottom + 4, [
          blocked ? { label: "Unblock (back to To do)", run: () => write({ status: "todo" }, "unblocked") }
            : { label: "Blocked", run: () => write({ status: "blocked" }, "blocked") },
        ], { className: "dw-menu" });
        host.menuKeys(m, e.currentTarget);
      }, { kids: blocked ? [statusMark("blocked"), document.createTextNode("Blocked")] : [icon("more", "sm")] });
      over.dataset.status = "blocked";
      over.setAttribute("aria-pressed", String(blocked));
      over.setAttribute("aria-keyshortcuts", "3");
      over.setAttribute("aria-haspopup", "menu");
      statusBox.append(over);
    }
    const statusOf = () => host.statusOf(detail.task);

    function prop(cls, label, kids, onclick, act) {
      const b = button(`dw-prop ${cls}`.trim(), label, onclick, { kids });
      if (act) b.dataset.act = act;
      return b;
    }
    function paintProps() {
      if (props.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
      const t = detail.task;
      props.textContent = "";
      props.append(prop("", `Priority: ${PRIORITY_LABEL[t.priority] || t.priority}. Key P`, [bars(t.priority), document.createTextNode(PRIORITY_LABEL[t.priority] || t.priority)],
        (e) => priorityMenu(e.currentTarget), "priority"));
      const who = t.assignee;
      const assign = prop(who ? "" : "muted", who ? `Assigned to ${who}. Key A` : "Assign. Key A",
        who ? [avatar(who), document.createTextNode(agentLabel(who))] : [el("span", { className: "dw-av none" }, icon("plus", "xs")), document.createTextNode("Assign")],
        () => editAssignee(assign), "assign");
      props.append(assign);
      const overdue = host.isOverdue(t);
      const due = prop(t.due ? (overdue ? "crit" : "") : "muted", t.due ? `Due ${t.due}${overdue ? ", overdue" : ""}` : "Set a due date",
        [icon("clock", "sm"), document.createTextNode(t.due ? (overdue ? `Overdue ${t.due}` : `Due ${t.due}`) : "Due")], () => editDue(due), "due");
      props.append(due);
      // The reminder chip is the app's, so its presets and its list stay one
      // implementation; it becomes its own select, like every chip here.
      const spec = host.reminderChipSpec({
        task: t, alerts: host.alertsForTask(taskId),
        after: async () => { await host.refresh(); paintProps(); },
        openList: async () => { await me.close(); host.goTo({ projectId: null, view: "reminders", query: "" }); },
      });
      const remind = prop(spec.value ? "" : "muted", spec.value ? `Reminder ${spec.value}` : "Set a reminder",
        [icon("today", "sm"), document.createTextNode(spec.value || "Remind")], () => {
          const editor0 = spec.build(() => paintProps());
          remind.replaceWith(editor0);
          if (editor0.focus) editor0.focus();
        }, "remind");
      props.append(remind);
      if (t.ref) props.append(el("span", { className: "dw-prop static mono ref", title: `Reference: ${t.ref}` }, t.ref));
      if (host.hasColour(t)) props.append(el("span", { className: `dw-prop static hue c-${t.colour}`, title: "Colour, changed from More" }, el("span", { className: "dw-dot" }), host.colourLabel(t.colour)));
      // Today's rows are the store's own reading (today/brief.js), with the
      // audit and the Workbench counted; the local reading covers the drawer
      // opened before Today has loaded.
      const s = (window.DelphiToday && DelphiToday.stuckOf && DelphiToday.stuckOf(taskId)) || stuck(detail, host.state().runs || []);
      if (s) props.append(el("span", { className: `dw-tag ${s.level}`, role: "status", textContent: s.words }));
    }
    function agentLabel(name) {
      const h = (host.state().harnesses || []).find((x) => x.name === name || x.key === name || x.label === name);
      return h ? h.label || h.name : name;
    }
    function priorityMenu(anchor) {
      const box = anchor.getBoundingClientRect();
      const m = host.rowMenu(box.left, box.bottom + 4, ["high", "med", "low"].map((p) => ({
        label: `${PRIORITY_LABEL[p]}${detail.task.priority === p ? "  (now)" : ""}`, run: () => write({ priority: p }, "priority saved"),
      })), { className: "dw-menu" });
      host.menuKeys(m, anchor);
    }
    function editAssignee(chip) {
      const list = el("datalist", { id: `dw-agents-${taskId}` });
      for (const h of host.state().harnesses || []) list.append(el("option", { value: h.name || h.key || "" }));
      const i = el("input", { className: "dw-inline", value: detail.task.assignee || "", placeholder: "a name or an agent" });
      i.setAttribute("aria-label", "Assignee");
      i.setAttribute("list", list.id);
      const wrap = el("span", { className: "dw-inline-wrap" }, i, list);
      chip.replaceWith(wrap);
      i.focus();
      i.select();
      let over = false;
      const end = async (save) => {
        if (over) return;
        over = true;
        const v = i.value.trim() || null;
        if (save && v !== (detail.task.assignee || null)) await write({ assignee: v }, "assignee saved");
        else paintProps();
      };
      i.onkeydown = (e) => {
        if (e.isComposing) return;
        if (e.key === "Enter") { e.preventDefault(); end(true); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); end(false); props.querySelector("[data-act=assign]")?.focus(); }
      };
      i.onblur = () => end(true);
    }
    function editDue(chip) {
      const i = el("input", { className: "dw-inline", type: "date", value: detail.task.due || "" });
      i.setAttribute("aria-label", "Due date");
      const finish = inlineEdit(chip, i, () => paintProps());
      i.onchange = () => finish(() => write({ due: i.value || null }, i.value ? "due date saved" : "due date cleared"));
      i.onkeydown = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); } };
      i.onblur = () => finish();
    }

    // --- the three cards ---
    const cards = el("div", { className: "dw-cards" });
    function card(key, iconName, label, value, { mono = false, muted = false, tone = "" } = {}) {
      const b = button("dw-card", `${label}: ${value}. Show the ${label} section`, () => reveal(key), {
        kids: [el("div", { className: "k" }, icon(iconName, "xs"), label), el("div", { className: `v${mono ? " mono" : ""}${muted ? " muted" : ""}${tone ? ` ${tone}` : ""}`, textContent: value })],
      });
      b.dataset.card = key;
      return b;
    }
    function wbValue() {
      const wb = detail.workbench;
      const starting = host.wb.starting.get(taskId);
      if (starting) return { value: starting.text || "Starting", tone: "busy" };
      if (wb) {
        const look = host.wb.look(wb);
        if (look.cls === "missing" || look.cls === "closing" || look.cls === "parked") return { value: `${look.words}, ${wb.branch}`, mono: false, tone: look.cls === "missing" ? "crit" : "" };
        return { value: wb.branch, mono: true };
      }
      const p = projectRow();
      if (!detail.project) return { value: "No project", muted: true };
      return { value: p && p.path ? "Not started" : "No folder", muted: true };
    }
    function runsValue() {
      const runs = runsHere();
      if (!runs.length) return { value: "None yet", muted: true };
      const open = runs.filter((r) => host.runs.OPEN.includes(r.state));
      const latest = open[0] || runs[0];
      const words = host.runs.words[latest.state] || latest.state;
      return { value: runs.length === 1 ? `1 ${words}` : `${runs.length}, latest ${words}`, tone: host.runs.WAITING.includes(latest.state) ? "warn" : latest.state === "failed" ? "crit" : "" };
    }
    function sheetValue() {
      const c = detail.comments;
      if (!c.length) return { value: "Empty", muted: true };
      return { value: `${c.length} ${c.length === 1 ? "entry" : "entries"}, ${agoWords(c[c.length - 1].created_at)}` };
    }
    function paintCards() {
      cards.textContent = "";
      const w = wbValue(); const r = runsValue(); const s = sheetValue();
      cards.append(card("workbench", "branch", "Workbench", w.value, w), card("runs", "runs", "Runs", r.value, r), card("sheet", "pad", "Sheet", s.value, s));
    }
    function reveal(key) {
      const f = sections[key];
      if (!f) return;
      if (!f.isOpen()) { f.set(true); paintSection(key); }
      f.wrap.scrollIntoView({ block: "start", behavior: host.motionOff() ? "auto" : "smooth" });
      f.wrap.querySelector(".dw-fold-h").focus({ preventScroll: true });
    }

    // --- sections ---
    const sections = {};
    const order = ["subtasks", "description", "sheet", "workbench", "runs", "memory", "reminders", "activity"];
    const titles = { subtasks: "Subtasks", description: "Description", sheet: "Sheet", workbench: "Workbench", runs: "Runs", memory: "Memory", reminders: "Reminders", activity: "Activity" };
    for (const key of order) {
      sections[key] = foldSection(key, titles[key], {
        onToggle: (openNow) => {
          if (openNow && key === "memory") loadMemory();
          if (openNow && sections[key]) paintSection(key);
          if (key === "description") widen();
        },
      });
    }
    const widen = () => me.root.classList.toggle("wide", Boolean(sections.description && sections.description.isOpen() && desc && desc.mode() === "split"));

    // Subtasks
    const orderKey = `delphi.drawer.order.${taskId}`;
    let addText = "";
    let composingAdd = false;
    function paintSubtasks({ force = false } = {}) {
      const box = sections.subtasks.body;
      const act = document.activeElement;
      const inAdd = Boolean(act && act.classList && act.classList.contains("dw-addsub-in") && box.contains(act));
      const holding = box.contains(act) && /^(INPUT|TEXTAREA)$/.test(act.tagName) && !inAdd;
      const subs = ordered(detail.subtasks, store.get(orderKey, []));
      // Never in the middle of an input method's composition: a rebuild would end it.
      if ((holding || (inAdd && composingAdd)) && !force) return;
      if (force) composingAdd = false;
      const focusedId = box.contains(document.activeElement) ? document.activeElement.closest("[data-sub]")?.dataset.sub : null;
      const focusedAct = focusedId ? document.activeElement.dataset.act : null;
      box.textContent = "";
      const list = el("div", { className: "dw-subs", role: "list" });
      list.setAttribute("aria-label", "Subtasks. Drag, or Alt and an arrow, to reorder");
      let dragging = null;
      const drop = el("div", { className: "dw-dropline" });
      for (const s of subs) {
        const done = s.status === "done";
        const row = el("div", { className: `dw-sub${done ? " done" : ""}`, role: "listitem", draggable: true });
        row.dataset.sub = String(s.id);
        const grip = el("span", { className: "grip", title: "Drag to reorder" }, icon("grip", "sm"));
        grip.setAttribute("aria-hidden", "true");
        const cb = button(`dw-cb${done ? " on" : ""}`, done ? `Reopen #${s.id}` : `Mark #${s.id} done`, async () => {
          await window.delphi.tasks.update(s.id, { status: done ? "todo" : "done" });
          await reload();
          host.refresh();
        });
        cb.setAttribute("role", "checkbox");
        cb.setAttribute("aria-checked", String(done));
        cb.dataset.act = "tick";
        const name = button("t", `Open subtask #${s.id}: ${s.title}`, () => host.openTask(s.id), { text: s.title });
        name.dataset.act = "open";
        name.title = s.title;
        row.append(grip, cb, name);
        if (s.subtask_count) row.append(el("span", { className: "dw-mini", textContent: `${s.subtask_done}/${s.subtask_count}` }));
        if (s.status !== "done" && s.status !== "todo") row.append(el("span", { className: `dw-mini st-${host.statusOf(s)}`, textContent: STATUS_LABEL[host.statusOf(s)] || s.status }));
        row.append(el("span", { className: "tid", textContent: `#${s.id}` }));
        if (s.assignee) { const a = avatar(s.assignee); a.title = s.assignee; row.append(a); }
        const more = iconBtn("more", `Subtask #${s.id} actions`, (e) => {
          e.stopPropagation();
          const b = e.currentTarget.getBoundingClientRect();
          host.taskMenu(s, b.right - 200, b.bottom + 4, { after: reload });
        }, "menu");
        more.setAttribute("aria-haspopup", "menu");
        row.append(more);
        row.oncontextmenu = (e) => { e.preventDefault(); host.taskMenu(s, e.clientX, e.clientY, { after: reload }); };
        row.addEventListener("keydown", (e) => {
          if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          e.preventDefault();
          const ids = subs.map((x) => x.id);
          const at = ids.indexOf(s.id);
          const to = at + (e.key === "ArrowUp" ? -1 : 1);
          if (to < 0 || to >= ids.length) return;
          ids.splice(at, 1);
          ids.splice(to, 0, s.id);
          store.set(orderKey, ids);
          paintSubtasks();
          box.querySelector(`[data-sub="${s.id}"] [data-act=open]`)?.focus();
        });
        row.addEventListener("dragstart", (e) => {
          dragging = s.id;
          row.classList.add("lift");
          try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(s.id)); } catch {}
        });
        row.addEventListener("dragend", () => { dragging = null; row.classList.remove("lift"); drop.remove(); });
        row.addEventListener("dragover", (e) => {
          if (dragging == null || dragging === s.id) return;
          e.preventDefault();
          const r = row.getBoundingClientRect();
          const after = e.clientY > r.top + r.height / 2;
          row.parentNode.insertBefore(drop, after ? row.nextSibling : row);
        });
        list.append(row);
      }
      list.addEventListener("dragover", (e) => { if (dragging != null) e.preventDefault(); });
      list.addEventListener("drop", (e) => {
        if (dragging == null) return;
        e.preventDefault();
        // No drop line means it was let go over no row: nothing moves.
        if (!drop.isConnected) { dragging = null; return; }
        const ids = [];
        for (const n of list.children) {
          if (n === drop) ids.push(dragging);
          else if (n.dataset.sub && Number(n.dataset.sub) !== dragging) ids.push(Number(n.dataset.sub));
        }
        if (!ids.includes(dragging)) ids.push(dragging);
        store.set(orderKey, ids);
        dragging = null;
        paintSubtasks();
      });
      box.append(list);

      // Add inline. Enter adds and stays for the next; Tab nests the new one
      // under the subtask above it and Shift+Tab lifts it out to sit beside
      // this task, the way an outline works. With nothing typed, Tab is Tab.
      // What is typed in the box outlives the box: a repaint (an agent's write,
      // a tick, a reorder) rebuilds it, and the words go into the new one.
      const add = el("input", { className: "dw-addsub-in", placeholder: "Add subtask", value: addText });
      add.addEventListener("input", () => { addText = add.value; });
      add.addEventListener("compositionstart", () => { composingAdd = true; });
      add.addEventListener("compositionend", () => { composingAdd = false; });
      add.setAttribute("aria-label", "Add a subtask. Enter adds, Tab nests it under the one above, Shift and Tab lifts it out");
      const addRow = el("label", { className: "dw-addsub" }, icon("plus", "sm"), add,
        el("span", { className: "hint" }, el("kbd", { textContent: "Tab" }), "nest", el("kbd", { textContent: "⇧" }), el("kbd", { textContent: "Tab" }), "lift out"));
      let adding = false;
      add.onkeydown = async (e) => {
        const text = add.value.trim();
        if (e.isComposing) return;
        if (e.key === "Escape" && add.value) { e.preventDefault(); e.stopPropagation(); add.value = ""; addText = ""; return; }
        if (!text || adding) return;
        let parentId = null;
        if (e.key === "Enter") parentId = taskId;
        else if (e.key === "Tab" && !e.shiftKey) parentId = subs.length ? subs[subs.length - 1].id : taskId;
        else if (e.key === "Tab" && e.shiftKey) parentId = detail.task.parent_id || null;
        else return;
        e.preventDefault();
        adding = true;
        const sent = add.value;
        try {
          const made = await window.delphi.tasks.create({ title: text, parentId, projectId: detail.task.project_id });
          // Cleared only if it still holds what was sent; more typed meanwhile stays.
          const live = box.querySelector(".dw-addsub-in");
          const nowText = live ? live.value : addText;
          addText = nowText === sent ? "" : nowText;
          if (live && live.value === sent) live.value = "";
          if (parentId !== taskId) flash(parentId ? `nested under #${parentId}` : `#${made && made.id ? made.id : ""} added beside this task`);
        } catch (error) { host.notifyError(error); }
        adding = false;
        detail = await window.delphi.tasks.detail(taskId) || detail;
        paintSectionMeta();
        paintSubtasks({ force: true });
        paintProps();
        box.querySelector(".dw-addsub-in")?.focus();
        host.refresh();
      };
      box.append(addRow);
      if (!subs.length) box.append(el("p", { className: "dw-fine", textContent: "A subtask is a task, so each piece gets its own status, owner and Sheet." }));
      if (inAdd) { add.focus({ preventScroll: true }); add.setSelectionRange(add.value.length, add.value.length); }
      if (focusedId) {
        const again = box.querySelector(`[data-sub="${focusedId}"] [data-act="${focusedAct || "open"}"]`);
        if (again) again.focus({ preventScroll: true });
      }
    }

    // Description
    let desc = null;
    function paintDescription() {
      const box = sections.description.body;
      if (desc) { desc.update(detail.task.detail || ""); if (desc.node.isConnected) return; }
      desc = editor({
        label: "Markdown", kind: "task", value: detail.task.detail || "", placeholder: "What does finishing this actually involve",
        draftKey: ["desc", draftOf],
        current: async () => { const f = await window.delphi.tasks.detail(taskId); return f ? f.task.detail || "" : null; },
        onSave: async (next) => { await window.delphi.tasks.update(taskId, { detail: next }); detail.task.detail = next; flash("description saved"); paintSectionMeta(); host.refresh(); return next; },
        tickStore: async (t) => {
          const r = await window.delphi.markdown.tick("task", taskId, t);
          if (r && !r.refused) { detail.task.detail = r.body; flash("description saved"); paintSectionMeta(); host.refresh(); }
          return r;
        },
        onMode: () => widen(),
      });
      box.textContent = "";
      box.append(desc.node);
      widen();
    }

    // Sheet
    let ledgerOnly = false;
    const outputOpen = new Set();
    const outputText = new Map();
    const rowCache = new Map();
    const entryById = (id) => detail.comments.find((c) => c.id === id) || null;
    const sheetList = el("div", { className: "dw-entries" });
    sheetList.setAttribute("role", "log");
    sheetList.setAttribute("aria-label", "Sheet entries, newest first");
    // A log, but not read aloud on every repaint: the composer says what it posted.
    sheetList.setAttribute("aria-live", "off");
    const sheetHead = el("div", { className: "dw-ledger" });
    function ledgerOf() {
      const answers = new Map();
      for (const e of detail.comments) if (e.kind === "decide" && e.ref_id) answers.set(e.ref_id, e);
      const ids = new Set();
      for (const e of detail.comments) if (e.promoted || (e.kind === "decide" && e.ref_id) || answers.has(e.id)) ids.add(e.id);
      return { answers, ids };
    }
    const openAsk = () => {
      const { answers } = ledgerOf();
      return detail.comments.slice().reverse().find((e) => e.kind === "ask" && !answers.has(e.id)) || null;
    };
    async function loadOutput(id) {
      try {
        const log = await window.delphi.sheets.log(id);
        outputText.set(id, { text: host.kit.stripAnsi(log.text || ""), truncated: !!log.truncated });
      } catch (error) { outputText.set(id, { error: String(error.message || error) }); }
      paintSheet();
    }
    function paintSheet() {
      const box = sections.sheet.body;
      if (!box.contains(sheetHead)) { box.textContent = ""; box.append(sheetHead, sheetList); }
      const { answers, ids } = ledgerOf();
      const focusAct = sheetHead.contains(document.activeElement) ? document.activeElement.dataset.act : null;
      sheetHead.textContent = "";
      const seg = el("div", { className: "dw-seg", role: "group" });
      seg.setAttribute("aria-label", "Show");
      for (const [on, name] of [[false, "All"], [true, `Ledger ${ids.size}`]]) {
        const b = button(ledgerOnly === on ? "on" : "", null, () => { if (ledgerOnly !== on) { ledgerOnly = on; paintSheet(); } }, { text: name });
        b.setAttribute("aria-pressed", String(ledgerOnly === on));
        b.dataset.act = on ? "ledger" : "all";
        seg.append(b);
      }
      const copyAll = iconBtn("copy", ledgerOnly ? "Copy the ledger as clean text" : "Copy the whole Sheet as clean text", async (e) => {
        const b = e.currentTarget;
        try { await window.delphi.sheets.copyAll(taskId, { ledger: ledgerOnly }); flashTitle(b, "Copied"); } catch (error) { flash(String(error.message || error)); }
      }, "copy-all");
      sheetHead.append(icon("star", "xs"), el("span", { className: "grow", textContent: "Agents read the ledger first, then the last 20 entries." }), seg, copyAll);
      if (focusAct) sheetHead.querySelector(`[data-act="${focusAct}"]`)?.focus();

      const shown = (ledgerOnly ? detail.comments.filter((e) => ids.has(e.id)) : detail.comments).slice().reverse();
      const focused = sheetList.contains(document.activeElement) ? document.activeElement : null;
      const fRow = focused ? focused.closest("[data-entry]") : null;
      const fAct = focused ? focused.dataset.act : null;
      const wanted = [];
      const keep = new Set();
      for (const entry of shown) {
        const answer = answers.get(entry.id);
        const sig = JSON.stringify([entry, ids.has(entry.id), answer ? [answer.id, answer.body, answer.meta, answer.author] : null,
          host.kit.isRunning(entry) ? "now" : shortDate(entry.created_at) + ago(entry.created_at), outputOpen.has(entry.id),
          host.runs.buffers.has(entry.id), host.runs.kills.get(entry.id) || 0, outputText.get(entry.id) || null,
          entry.ref_id ? (entryById(entry.ref_id) || {}).body : null]);
        const cached = rowCache.get(entry.id);
        const node = cached && cached.sig === sig ? cached.node : entryNode(entry, { answers, ids });
        rowCache.set(entry.id, { sig, node });
        keep.add(entry.id);
        wanted.push(node);
      }
      for (const id of [...rowCache.keys()]) if (!keep.has(id)) rowCache.delete(id);
      if (!shown.length) {
        wanted.push(el("div", { className: "dw-empty" }, el("div", { className: "ill" }, icon("pad", "")),
          el("h4", { textContent: ledgerOnly ? "Nothing in the ledger yet" : "The Sheet is empty" }),
          el("p", { textContent: ledgerOnly ? "Promote an entry to keep it here: the ledger is what the next agent reads first."
            : "Each task keeps a typed record: what was said, run, asked and decided. Agents read the ledger first, so a line here steers them." })));
      }
      wanted.forEach((node, i) => { const at = sheetList.children[i]; if (at !== node) sheetList.insertBefore(node, at || null); });
      while (sheetList.children.length > wanted.length) sheetList.lastElementChild.remove();
      if (fRow && !fRow.isConnected) {
        const again = sheetList.querySelector(`[data-entry="${fRow.dataset.entry}"]`);
        const target = again && (fAct ? again.querySelector(`[data-act="${fAct}"]`) : null);
        (target || (again && again.querySelector("button")))?.focus({ preventScroll: true });
      }
    }
    function entryMenu(anchor, entry) {
      const box = anchor.getBoundingClientRect();
      const promoted = !!entry.promoted;
      const items = [
        { label: promoted ? "Take out of the ledger" : "Promote to the ledger", run: async () => {
          try { await window.delphi.sheets.promote(entry.id, !promoted); } catch (error) { flash(String(error.message || error)); }
          await reload();
        } },
      ];
      // Filing is once only: a second note from the same words would be a
      // duplicate in search and in the graph.
      if (!entry.note_id) {
        items.push("-", el("div", { className: "ctx-head", textContent: "File as a project note" }));
        for (const kind of host.kit.NOTE_KINDS) {
          items.push({ label: kind[0].toUpperCase() + kind.slice(1), run: async () => {
            try { await window.delphi.sheets.file(entry.id, kind, null); flash(`filed as ${kind}`); } catch (error) { flash(String(error.message || error)); }
            await reload();
          } });
        }
      }
      items.push("-", { label: entry.kind === "run" ? "Copy the command" : "Copy", run: async () => {
        try { await window.delphi.sheets.copy(entry.id, { withOutput: false }); flash("copied"); } catch (error) { flash(String(error.message || error)); }
      } });
      if (entry.kind === "run") items.push({ label: "Copy the command and its output", run: async () => {
        try { await window.delphi.sheets.copy(entry.id, { withOutput: true }); flash("copied"); } catch (error) { flash(String(error.message || error)); }
      } });
      items.push("-", { label: "Delete entry", danger: true, run: async () => { await window.delphi.tasks.uncomment(entry.id); await reload(); } });
      anchor.setAttribute("aria-expanded", "true");
      const m = host.rowMenu(box.right - 220, box.bottom + 4, items, { className: "dw-menu ts-entry-menu", onClose: () => anchor.setAttribute("aria-expanded", "false") });
      host.menuKeys(m, anchor);
    }
    function entryNode(entry, { answers, ids }) {
      const H = host.kit;
      const agent = H.entryIsAgent(entry);
      const k = entry.kind === "say" ? (agent ? "agent" : "say") : (H.SIGILS[entry.kind] ? entry.kind : "say");
      const row = el("article", { className: `dw-entry k-${k}` });
      row.dataset.entry = String(entry.id);
      const when = H.isRunning(entry) ? "now" : shortDate(entry.created_at);
      const who = el("div", { className: "who" }, el("b", { textContent: entry.author || "?" }), el("span", { className: `dw-kind ${entry.kind}`, textContent: entry.kind }));
      // The avatar already says an agent wrote it; only a tool is named.
      if (agent && entry.author_type === "tool") who.append(el("span", { className: "dw-agent", textContent: "tool" }));
      if (ids.has(entry.id)) { const st = el("span", { className: "dw-star", title: "In the ledger" }, icon("star", "xs")); st.setAttribute("aria-label", "In the ledger"); who.append(st); }
      who.append(el("span", { className: "grow" }), el("span", { className: "when", textContent: when, title: `${entry.created_at || ""} (${agoWords(entry.created_at)})` }));
      const more = iconBtn("more", "Entry actions: promote, file, copy, delete", (e) => { e.stopPropagation(); entryMenu(e.currentTarget, entry); }, "entry-menu");
      more.setAttribute("aria-haspopup", "menu");
      who.append(more);
      const body = el("div", { className: "dw-entry-body" });
      if (entry.kind === "run") runBody(entry, body);
      else if (entry.kind === "ask") askBody(entry, body, answers.get(entry.id) || null);
      else if (entry.kind === "decide") decideBody(entry, body);
      else body.append(host.renderMarkdown(entry.body));
      if (entry.note_id) {
        body.append(el("div", { className: "dw-filed" }, el("span", { className: `kind ${entry.note_kind || "note"}`, textContent: entry.note_kind || "note" }),
          el("span", { textContent: detail.project ? `filed to ${detail.project.name} notes` : "filed as a note" })));
      }
      row.append(avatar(entry.author), el("div", { className: "dw-entry-main" }, who, body));
      row.setAttribute("aria-label", `${H.KIND_WORD[k]} by ${entry.author || "unknown"}, ${when}`);
      return row;
    }
    function runBody(entry, body) {
      const H = host.kit;
      const meta = entry.meta || {};
      const script = typeof meta.script === "string" && meta.script.trim() ? meta.script : null;
      body.append(el("div", { className: "dw-cmd", textContent: `$ ${entry.body}`, title: script || entry.body }));
      const line = el("div", { className: "dw-run-meta" });
      const st = meta.state;
      if (st === "ok" || st === "fail" || st === "running") {
        const code = meta.code == null ? "" : `:${meta.code}`;
        line.append(el("span", { className: `ts-run-state ${st}`, textContent: st === "fail" ? `fail${code}` : st }));
      }
      if (st === "running") {
        const clock = el("span", { className: "dw-clock", textContent: `${H.elapsed(entry.created_at)} so far` });
        clock.dataset.from = String(entry.created_at);
        line.append(clock);
      }
      // Only a run this window started can be stopped from it: the main
      // process holds its process group.
      const live = st === "running" ? host.runs.buffers.get(entry.id) || null : null;
      if (live) {
        const presses = host.runs.kills.get(entry.id) || 0;
        const stop = button("dw-link", null, async () => {
          try { await window.delphi.sheets.interrupt(entry.id); host.runs.kills.set(entry.id, presses + 1); } catch (error) { host.notifyError(error); }
          paintSheet();
        }, { text: presses ? "Kill" : "Stop", title: presses ? "It has not stopped. Kill it outright." : "Interrupt it, as Ctrl-C would" });
        stop.dataset.act = "stop";
        line.append(stop);
      } else {
        if (Number.isFinite(meta.dur_ms)) line.append(el("span", { textContent: H.duration(meta.dur_ms) }));
        if (Number.isFinite(meta.lines)) line.append(el("span", { textContent: `${meta.lines} ${meta.lines === 1 ? "line" : "lines"}` }));
      }
      const inline = !script && typeof meta.out === "string" && meta.out ? H.stripAnsi(meta.out) : "";
      const isOpen = outputOpen.has(entry.id);
      if (!inline && (meta.lines > 0 || st === "running" || script)) {
        const toggle = button("dw-link", null, () => {
          if (isOpen) { outputOpen.delete(entry.id); paintSheet(); return; }
          outputOpen.add(entry.id);
          outputText.delete(entry.id);
          paintSheet();
          if (!host.runs.buffers.has(entry.id)) loadOutput(entry.id);
        }, { text: isOpen ? "Hide output" : "Show output" });
        toggle.dataset.act = "output";
        toggle.setAttribute("aria-expanded", String(isOpen));
        line.append(toggle);
      }
      body.append(line);
      if (inline) body.append(el("pre", { className: "ts-run-out", textContent: inline }));
      else if (isOpen && live) body.append(host.runs.pre(live));
      else if (isOpen) {
        const got = outputText.get(entry.id);
        const pre = el("pre", { className: "ts-run-out full", tabIndex: 0 });
        pre.setAttribute("aria-label", "Command output");
        if (!got) pre.append(el("span", { className: "cut", textContent: "Reading the log" }));
        else if (got.error) pre.append(el("span", { className: "cut", textContent: `Could not read the log: ${got.error}` }));
        else {
          if (got.truncated) pre.append(el("span", { className: "cut", textContent: "Earlier output cut, this is the end of the log\n" }));
          pre.append(document.createTextNode(got.text || ""));
          if (!got.text) pre.append(el("span", { className: "cut", textContent: "No output was kept" }));
          requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
        }
        body.append(pre);
      }
    }
    function askBody(entry, body, answer) {
      body.append(el("div", { className: "dw-ask-q", textContent: entry.body }));
      const options = (entry.meta && Array.isArray(entry.meta.options)) ? entry.meta.options : [];
      const chosen = answer ? String((answer.meta && answer.meta.choice) || String(answer.body || "").split("\n")[0]).trim().toLowerCase() : null;
      const opts = el("div", { className: `ts-ask-opts${answer ? " decided" : ""}`, role: "group" });
      opts.setAttribute("aria-label", answer ? "Options, decided" : "Choose an answer");
      for (const option of options) {
        const key = String(option.key).toLowerCase();
        const isChosen = chosen === key;
        const b = el("button", { className: `ts-opt${isChosen ? " chosen" : ""}`, type: "button" },
          el("span", { className: "ts-opt-key", textContent: option.key }), String(option.label), isChosen ? " ✓" : null);
        b.dataset.act = `opt-${key}`;
        if (answer) { b.disabled = true; b.setAttribute("aria-label", `${option.label}${isChosen ? ", chosen" : ""}`); }
        else {
          b.title = `Decide: ${option.label}`;
          b.onclick = async () => {
            try { await window.delphi.sheets.decide(entry.id, option.key, null); } catch (error) { flash(String(error.message || error)); }
            await reload();
          };
        }
        opts.append(b);
      }
      body.append(opts);
      if (answer) body.append(el("div", { className: "dw-fine", textContent: `Decided by ${answer.author} ${agoWords(answer.created_at)}` }));
    }
    function decideBody(entry, body) {
      const meta = entry.meta || {};
      const lines = String(entry.body || "").split("\n");
      const key = String(meta.choice || lines[0] || "").trim();
      const ask = entry.ref_id ? entryById(entry.ref_id) : null;
      let label = meta.label || "";
      if (!label && ask && ask.meta && Array.isArray(ask.meta.options)) {
        const hit = ask.meta.options.find((o) => String(o.key).toLowerCase() === key.toLowerCase());
        if (hit) label = hit.label;
      }
      const head = el("div", { className: "dw-decide" }, "Decided ", el("span", { className: "ts-opt-key", textContent: key }), label ? el("strong", { textContent: label }) : null);
      if (ask) {
        const ref = button("dw-link", "Show the question", () => {
          const target = sheetList.querySelector(`[data-entry="${ask.id}"]`);
          if (!target) return;
          target.scrollIntoView({ block: "center", behavior: host.motionOff() ? "auto" : "smooth" });
          target.classList.add("flash");
          setTimeout(() => target.classList.remove("flash"), 1400);
        }, { text: `on ${ask.body}` });
        ref.dataset.act = "ref";
        head.append(ref);
      }
      body.append(head);
      const why = lines.slice(1).join("\n").trim();
      if (why) body.append(host.renderMarkdown(why));
    }
    const clock = setInterval(() => {
      if (!me.root.isConnected) { clearInterval(clock); return; }
      for (const c of sheetList.querySelectorAll(".dw-clock")) {
        const text = `${host.kit.elapsed(c.dataset.from)} so far`;
        if (c.firstChild && c.firstChild.data !== text) c.firstChild.data = text;
      }
    }, 1000);

    // Workbench
    let wbAdv = null;
    let wbAdvOpen = true;
    let wbSig = null;
    const wbBox = el("div");
    const busyNow = () => host.wb.busy.has(taskId);
    const wbAfter = async () => { await reload(); host.refresh(); };
    async function wbDo(fn) {
      const ran = await host.wb.guard(taskId, async () => { try { await fn(); } catch (error) { host.notifyError(error); } return true; });
      if (ran) await wbAfter();
    }
    const wbStart = () => host.wb.guard(taskId, async () => {
      let opts = {};
      try {
        const list = await window.delphi.workbench.candidates(taskId);
        if (list.length > 1) {
          const pick = await host.wb.pickRepo(list);
          if (!pick) return;
          opts = pick.repo_id != null ? { repoId: pick.repo_id } : { path: pick.path };
        }
      } catch (error) { host.notifyError(error); return; }
      host.wb.starting.set(taskId, { phase: "starting", text: "Starting" });
      paintWorkbench();
      try {
        const made = await window.delphi.workbench.start(taskId, opts);
        if (made.warnings && made.warnings.length) host.notify(made.warnings.join(" "));
      } catch (error) { host.wb.starting.delete(taskId); host.notifyError(error); }
      await wbAfter();
    });
    async function wbOpen(wb, target) {
      try { const r = await window.delphi.workbench.open(wb.id, target); flash(`opened in ${r.via === "folder" ? "the file browser" : r.via}`); }
      catch (error) { host.notifyError(error); }
    }
    function paintWorkbench() {
      const wb0 = detail.workbench;
      const st0 = (wb0 && wb0.status) || {};
      const sig = JSON.stringify([wb0 && { ...wb0, status: { ...st0, checkedAt: null } }, host.wb.starting.get(taskId) || null, busyNow(),
        detail.project ? detail.project.id : null, detail.task.status, wbAdv, wbAdvOpen]);
      paintCards();
      if (!sections.workbench.isOpen()) return;
      if (sig === wbSig && sections.workbench.body.contains(wbBox)) {
        // Unchanged but for when it was checked: the chip's words in full stay
        // true ("Checked 4s ago") without rebuilding what may hold focus.
        const chip = wbBox.querySelector(".wb-chip");
        if (chip && chip.wbTitle) chip.wbTitle(st0);
        return;
      }
      wbSig = sig;
      const hadFocus = wbBox.contains(document.activeElement) ? document.activeElement.dataset.act : null;
      buildWorkbench();
      if (!sections.workbench.body.contains(wbBox)) { sections.workbench.body.textContent = ""; sections.workbench.body.append(wbBox); }
      if (hadFocus) wbBox.querySelector(`[data-act="${hadFocus}"]`)?.focus({ preventScroll: true });
    }
    function wbButton(label, cls, run, title, act = label) {
      const b = el("button", { className: `btn sm ${cls}`.trim(), type: "button", textContent: label });
      b.dataset.act = act;
      if (busyNow()) b.setAttribute("aria-disabled", "true");
      if (title) b.title = title;
      b.onclick = run;
      return b;
    }
    function wbMenuOn(anchor, items) {
      const box = anchor.getBoundingClientRect();
      anchor.setAttribute("aria-expanded", "true");
      const m = host.rowMenu(box.left, box.bottom + 4, items, { className: "wb-menu dw-menu", onClose: () => anchor.setAttribute("aria-expanded", "false") });
      host.menuKeys(m, anchor);
    }
    function buildWorkbench() {
      wbBox.textContent = "";
      wbBox.setAttribute("aria-busy", String(busyNow()));
      const wb = detail.workbench;
      const starting = host.wb.starting.get(taskId);
      if (starting) {
        const text = starting.phase === "setup" && /^Running /.test(starting.text || "") ? `Running setup: ${starting.text.slice(8)}` : starting.text || "Starting";
        wbBox.append(el("div", { className: "dw-panel" }, el("div", { className: "dw-panel-h" }, icon("branch", "sm"), el("b", { textContent: "Workbench" }),
          el("span", { className: "wb-chip starting", role: "status" }, el("span", { className: "spinner" }), text))));
        return;
      }
      if (!wb) {
        const p = projectRow();
        const can = detail.project && detail.task.status !== "done";
        const lead = !detail.project ? "This task is in no project, so there is nowhere to make one."
          : detail.task.status === "done" ? "This task is done. A Workbench is for work still going."
          : p && p.path ? `Start makes a folder and a branch for this task beside ${p.name}'s repository, so it never shares a checkout.`
          : `A Workbench is a folder and a branch for this task. ${detail.project.name} has no folder yet; Start asks which repository to use.`;
        const acts = can ? [wbButton("Start Workbench", "primary", wbStart, "A folder and a branch of its own for this task", "start")] : [];
        wbBox.append(emptyBlock("branch", "No Workbench yet", lead, acts));
        return;
      }
      const look = host.wb.look(wb);
      const st = wb.status || {};
      const chip = host.wb.chip(wb, () => wbDo(() => host.wb.update(wb)));
      const panel = el("div", { className: "dw-panel" });
      panel.append(el("div", { className: "dw-panel-h" }, icon("branch", "sm"), el("b", { textContent: "Workbench" }), chip, el("span", { className: "grow" })));
      const kv = el("dl", { className: "dw-kv" });
      const row = (k, v, mono = true) => kv.append(el("dt", { textContent: k }), el("dd", { className: mono ? "mono" : "", textContent: v, title: v }));
      row("Folder", String(wb.path || "").replace(/^\/Users\/[^/]+/, "~"));
      row("Branch", wb.branch || "");
      row("Based on", wb.base || "");
      if (st.ahead != null || st.behind != null) {
        const parts = [];
        parts.push(st.ahead ? `${st.ahead} ${st.ahead === 1 ? "commit" : "commits"} not shared` : "nothing unshared");
        parts.push(st.behind ? `behind ${wb.base} by ${st.behind}` : `level with ${wb.base}`);
        row("Ahead", parts.join(", "), false);
      }
      panel.append(kv);
      const f = el("div", { className: "dw-panel-f" });
      if (look.cls === "closing") {
        f.append(el("span", { className: "dw-fine", textContent: host.wb.closingLong(look.closing) ? "Being put away for a while now, so it was probably interrupted. Housekeeping finishes or undoes it; the Sheet says where the folder is." : "Being put away. Nothing can be done to it until that ends." }));
        // What the old panel showed without asking: who began it, when, where
        // the folder went, and the ref that keeps a copy, with Copy on each.
        const c = look.closing || {};
        const grid = el("dl", { className: "dw-kv" });
        for (const [k, v] of [["Doing", c.mode === "discard" ? "Discard" : c.mode === "finish" ? "Finish" : ""], ["Begun by", c.actor || ""],
          ["At", c.at ? `${c.at} UTC` : ""], ["Folder now at", c.trash || ""], ["Copy", c.ref || ""]]) {
          if (!v) continue;
          const dd = el("dd", { className: "mono", title: v }, v);
          if (k === "Copy" || k === "Folder now at") {
            const b = iconBtn("copy", `Copy ${k === "Copy" ? "the ref" : "the folder"}`, (e) => copyText(v, e.currentTarget), k === "Copy" ? "copy-ref" : "copy-trash");
            dd.append(" ", b);
          }
          grid.append(el("dt", { textContent: k }), dd);
        }
        if (grid.childNodes.length) panel.append(grid);
      } else if (look.unreadable) {
        f.append(wbButton("Open folder", "", () => wbOpen(wb, "folder"), null, "open-folder"));
      } else if (look.cls === "missing") {
        f.append(wbButton("Recreate", "primary", () => wbDo(async () => { await window.delphi.workbench.recreate(wb.id); flash("folder recreated"); }), `Puts the folder back at ${wb.path}, on ${wb.branch}`),
          wbButton("Forget", "", async () => {
            const go = await host.wb.dialog({ title: "Forget this Workbench?", lead: `The folder is already gone. The branch ${wb.branch} is left exactly as it is.`,
              actions: [{ label: "Cancel", value: null }, { label: "Forget", value: "forget", kind: "primary" }] });
            if (go) wbDo(() => window.delphi.workbench.forget(wb.id));
          }));
      } else {
        const parked = wb.state === "parked";
        const openBtn = wbButton("Open", parked ? "" : "primary", () => wbOpen(wb, "editor"), "Open in your editor");
        openBtn.prepend(icon("ext", "xs"));
        const caret = el("button", { className: `btn sm ${parked ? "" : "primary"}`.trim(), type: "button", title: "Editor, Terminal or Folder" });
        caret.dataset.act = "open-in";
        caret.setAttribute("aria-haspopup", "menu");
        caret.setAttribute("aria-label", "Open in");
        caret.append(icon("down", "xs"));
        const mac = document.body.classList.contains("mac");
        caret.onclick = (e) => { e.stopPropagation(); wbMenuOn(caret, [
          { label: "Editor", run: () => wbOpen(wb, "editor") },
          { label: "Terminal", run: () => wbOpen(wb, "terminal") },
          { label: mac ? "Folder, in Finder" : "Folder", run: () => wbOpen(wb, "folder") },
        ]); };
        f.append(el("span", { className: "dw-splitbtn" }, openBtn, caret));
        if (parked) f.append(wbButton("Resume", "", () => wbDo(async () => { await window.delphi.workbench.resume(wb.id); flash("resumed"); })));
        else f.append(wbButton("Park", "", () => wbDo(async () => { await window.delphi.workbench.park(wb.id); flash("parked"); }), "Put it aside; the folder and branch stay"),
          wbButton("Finish", "", () => host.wb.finish(wb.id, taskId, { title: detail.task.title, after: reload }), "Save, share and put the folder away. The branch is kept."));
        const showing = wbAdv && wbAdv.id === wb.id;
        const more = el("button", { className: "dw-ib", type: "button", title: "More Workbench actions" });
        more.setAttribute("aria-label", "More Workbench actions");
        more.setAttribute("aria-haspopup", "menu");
        more.dataset.act = "wb-more";
        more.append(icon("more", "sm"));
        more.onclick = (e) => { e.stopPropagation(); wbMenuOn(more, [
          { label: `Update from ${wb.base}`, run: () => wbDo(() => host.wb.update(wb)) },
          { label: showing ? "Hide advanced" : "Show advanced", run: async () => {
            if (showing) { wbAdv = null; paintWorkbench(); return; }
            try { wbAdv = { id: wb.id, data: await window.delphi.workbench.advanced(wb.id) }; wbAdvOpen = true; } catch (error) { host.notifyError(error); return; }
            paintWorkbench();
          } },
        ]); };
        f.append(more, el("span", { className: "grow" }),
          wbButton("Discard...", "ghost danger", () => host.wb.discard(wb.id, taskId, { after: wbAfter }), "Commits everything to a ref kept 30 days, then removes the folder", "discard"));
      }
      panel.append(f);
      wbBox.append(panel);
      // The module's own explanation, where it can be read.
      if (st.state === "unreadable" && st.message) wbBox.append(el("div", { className: "wb-banner err", role: "status", textContent: st.message }));
      else if (st.state === "busy" && st.operation) wbBox.append(el("div", { className: "wb-banner", role: "status", textContent: `${st.words}. Finish and Update wait until it is finished or stopped in the folder.` }));
      if (wbAdv && wbAdv.id === wb.id) wbBox.append(advanced(wbAdv.data));
      wbBox.append(el("p", { className: "dw-fine", textContent: "Finish removes the folder only when nothing is unsaved or unpushed, and always keeps the branch. Discard asks you to type the task number, then commits everything to a ref kept 30 days." }));
    }
    function advanced(a) {
      const adv = el("details", { className: "wb-adv dw-adv", open: wbAdvOpen });
      adv.addEventListener("toggle", () => { wbAdvOpen = adv.open; });
      adv.append(el("summary", {}, "Workbench, advanced", el("span", { className: "grow" }), el("span", { className: "wb-adv-why", textContent: "What Delphi did, in git's words" })));
      const copyBtn = (text, label) => iconBtn("copy", label, (e) => copyText(text, e.currentTarget));
      const grid = el("div", { className: "wb-adv-grid" });
      for (const [k, v] of [["Branch", a.branch], ["Folder", a.path], ["Based on", a.base], ["Repository", a.repo]]) {
        grid.append(el("span", { className: "k", textContent: k }), el("span", { className: "v", textContent: v || "" }), copyBtn(v || "", `Copy ${k.toLowerCase()}`));
      }
      const body = el("div", { className: "wb-adv-body" }, grid, el("h5", { textContent: "The git commands behind each button" }));
      for (const cmd of a.commands || []) body.append(el("div", { className: "wb-cmd" }, el("code", { textContent: cmd }), copyBtn(cmd, "Copy command")));
      if (a.unmanaged && a.unmanaged.length) {
        body.append(el("h5", { textContent: "Folders found here that Delphi does not manage" }));
        for (const u of a.unmanaged) body.append(el("div", { className: "wb-cmd" }, el("code", { textContent: u.path }), el("span", { className: "why", textContent: u.branch || "" })));
      }
      adv.append(body);
      return adv;
    }

    // Runs
    function paintRuns() {
      const box = sections.runs.body;
      if (!sections.runs.isOpen()) return;
      const runs = runsHere();
      box.textContent = "";
      if (runs.length) {
        const panel = el("div", { className: "dw-panel" });
        for (const r of runs) {
          const label = r.harness_label || r.harness || "agent";
          const rowB = el("div", { className: "dw-run" });
          const head = el("button", { className: "dw-run-t", type: "button", title: "Open this run" },
            avatar(label), el("b", { textContent: label }), r.kind ? el("span", { className: "dw-kind", textContent: r.kind }) : null,
            el("span", { className: "what", textContent: String(r.request || r.title || "").replace(/\s+/g, " ").slice(0, 90) }));
          head.dataset.act = "run-open";
          head.onclick = () => host.runs.open(r);
          const chip = host.runs.stateChip(r);
          rowB.append(head, chip);
          const said = String(r.reply || "").replace(/\s+/g, " ").trim();
          rowB.append(el("div", { className: "s", textContent: `${said ? `${said.slice(0, 200)}${said.length > 200 ? "..." : ""} · ` : ""}${shortDate(r.updated_at || r.created_at)}` }));
          if (r.state === "failed") {
            const fix = host.runs.settingFix(r.reply, r.project_id);
            if (fix) rowB.append(button("dw-link", null, fix.go, { text: fix.label }));
          }
          if (host.runs.WAITING.includes(r.state)) {
            rowB.append(button("dw-link", null, async () => { await me.close(); host.goTo({ projectId: null, view: "inbox", query: "" }); }, { text: "Answer in Needs you" }));
          }
          panel.append(rowB);
        }
        box.append(panel);
      }
      if (!runs.length) {
        const go = button("btn sm primary", "Hand to agent: choose an agent, Ask or Do", () => handToAgent(), { kids: [icon("play", "xs")], text: "Run an agent" });
        go.dataset.act = "hand";
        box.append(emptyBlock("runs", "No runs yet", "Hand this task to an agent. An Ask only reads; a Do works in this task's Workbench. Either waits for your approval unless the project auto-approves.", [go]));
        return;
      }
      const starter = el("div", { className: "dw-panel dw-starter" },
        el("div", { className: "dw-panel-h" }, el("b", { textContent: "Run an agent on this" }), el("span", { className: "grow" }),
          button("btn sm primary", "Hand to agent: choose an agent, Ask or Do", () => handToAgent(), { kids: [icon("play", "xs")], text: "Run" })),
        el("p", { className: "dw-fine pad", textContent: "An Ask only reads; a Do works in this task's Workbench. Either waits for your approval unless the project auto-approves." }));
      starter.querySelector("button").dataset.act = "hand";
      box.append(starter);
      const all = button("dw-link", null, async () => { await me.close(); host.goTo({ projectId: null, view: "runs", query: "" }); }, { text: "Every run, in Runs" });
      box.append(all);
    }
    async function handToAgent() {
      const run = await host.handToAgent(detail);
      if (!run) return;
      flash(`handed to ${run.harness_label}`);
      await host.runs.reload();
      paintRuns();
      paintCards();
    }

    // Memory
    let memory = { notes: [], pad: null, loaded: false };
    async function loadMemory() {
      const filed = new Set(detail.comments.filter((c) => c.note_id).map((c) => c.note_id));
      let notes = [];
      if (detail.task.project_id) { try { notes = await window.delphi.notes.list(detail.task.project_id); } catch {} }
      let pad = null;
      if (detail.task.pad_id) { try { pad = await window.delphi.pads.get(detail.task.pad_id); } catch {} }
      memory = {
        loaded: true,
        pad,
        notes: notes.map((n) => ({ n, why: related(detail.task, n, filed) })).filter((x) => x.why),
      };
      paintSectionMeta();
      if (sections.memory.isOpen()) paintMemory();
    }
    function paintMemory() {
      const box = sections.memory.body;
      if (box.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
      box.textContent = "";
      const log = button("btn ghost sm", "Log a fact about this task as a project note", () => {
        const i = el("input", { className: "dw-inline wide", placeholder: "The fact, in a sentence. Enter saves it" });
        i.setAttribute("aria-label", "A fact to remember");
        log.replaceWith(i);
        i.focus();
        i.onkeydown = async (e) => {
          if (e.isComposing) return;
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); paintMemory(); return; }
          if (e.key !== "Enter" || !i.value.trim()) return;
          e.preventDefault();
          try {
            await window.delphi.notes.create({ projectId: detail.task.project_id, title: i.value.trim(), body: `Logged from #${taskId}.`, kind: "note" });
            flash("fact logged");
          } catch (error) { host.notifyError(error); }
          await loadMemory();
          host.refresh();
        };
        i.onblur = () => { if (!i.value.trim()) paintMemory(); };
      }, { kids: [icon("plus", "sm")], text: "Log a fact" });
      log.dataset.act = "log-fact";
      if (!detail.task.project_id) log.disabled = true;
      box.append(el("div", { className: "dw-sec-h" }, el("b", { textContent: "Knowledge and context" }), el("span", { className: "grow" }), log));
      if (!memory.loaded) { box.append(el("p", { className: "dw-fine", textContent: "Reading" })); return; }
      if (!memory.notes.length && !memory.pad) {
        box.append(emptyBlock("memory", "Nothing remembered yet", "Notes filed from this Sheet, notes that mention this task, and the pad it came from collect here.", []));
        return;
      }
      if (memory.notes.length) {
        const panel = el("div", { className: "dw-panel" });
        for (const { n, why } of memory.notes) {
          const b = el("button", { className: "dw-mem", type: "button", title: "Open this note here" },
            el("span", { className: `ico ${n.kind}` }, icon(n.kind === "gotcha" ? "gotcha" : n.kind === "decision" ? "check" : "memory", "sm")),
            el("span", { className: "txt" }, el("span", { className: "t", textContent: n.title }),
              el("span", { className: "s", textContent: String(n.body || "").replace(/^#[^\n]*\n+/, "").replace(/[#*`>]/g, "").replace(/\s+/g, " ").slice(0, 180) }),
              el("span", { className: "m" }, el("span", { className: `dw-kchip ${n.kind}`, textContent: n.kind }), el("span", { className: "dw-why", textContent: why }), el("span", { textContent: shortDate(n.updated_at) }))));
          b.dataset.note = String(n.id);
          b.onclick = () => openNote(n);
          panel.append(b);
        }
        box.append(panel);
      }
      if (memory.pad) {
        box.append(el("div", { className: "dw-sec-h top" }, el("b", { textContent: "The pad this task came from" })));
        const p = memory.pad;
        const b = el("button", { className: "dw-mem", type: "button", title: "Open this pad here" },
          el("span", { className: "ico pad" }, icon("pad", "sm")),
          el("span", { className: "txt" }, el("span", { className: "t", textContent: p.title }), el("span", { className: "m" }, el("span", { className: "mono", textContent: p.key || "" }), el("span", { textContent: shortDate(p.updated_at) }))));
        b.dataset.pad = String(p.id);
        b.onclick = () => openPad(p);
        const panel = el("div", { className: "dw-panel" }, b);
        box.append(panel);
      }
    }

    // Reminders: the app's own list and composer, so there is one of each.
    function paintReminders() {
      const box = sections.reminders.body;
      if (box.contains(document.activeElement)) return;
      box.textContent = "";
      host.paintTaskReminders(box, { task: detail.task, alerts: host.alertsForTask(taskId), after: async () => { await host.refresh(); paintReminders(); paintProps(); paintSectionMeta(); } });
    }

    // Activity
    function paintActivity() {
      const box = sections.activity.body;
      box.textContent = "";
      if (!detail.events.length) { box.append(el("p", { className: "dw-fine", textContent: "No status changes yet." })); }
      else {
        const list = el("ol", { className: "dw-timeline" });
        detail.events.slice().reverse().forEach((e, i, all) => {
          const prevAt = i === 0 ? null : all[i - 1].at;
          const li = el("li", { className: i === 0 ? "current" : "" }, statusMark(e.status),
            el("span", { className: "what" }, el("b", { textContent: STATUS_LABEL[e.status] || e.status }),
              el("span", { className: "dw-fine", textContent: i === 0 ? ` for ${host.gap(e.at)} so far` : ` for ${host.gap(e.at, prevAt)}` })),
            el("span", { className: "when" }, e.actor ? el("span", { className: host.isAgent(e.actor) ? "dw-agent" : "", textContent: e.actor }) : null, el("span", { textContent: shortDate(e.at) })));
          list.append(li);
        });
        box.append(list);
      }
      box.append(button("dw-link", null, async () => { await me.close(); host.goTo({ projectId: detail.task.project_id || null, view: detail.task.project_id ? "activity" : "history", query: "" }); }, { text: "Every change, in History" }));
    }

    function paintSection(key) {
      if (!sections[key] || !sections[key].isOpen()) return;
      if (key === "subtasks") paintSubtasks();
      else if (key === "description") paintDescription();
      else if (key === "sheet") paintSheet();
      else if (key === "workbench") { wbSig = null; paintWorkbench(); }
      else if (key === "runs") paintRuns();
      else if (key === "memory") paintMemory();
      else if (key === "reminders") paintReminders();
      else if (key === "activity") paintActivity();
    }
    function paintSectionMeta() {
      const subs = detail.subtasks;
      const done = subs.filter((s) => s.status === "done").length;
      sections.subtasks.meta(subs.length ? `${done}/${subs.length}` : "", subs.length ? "" : "None");
      const head = sections.subtasks.wrap.querySelector(".dw-fold-h");
      head.querySelector(".dw-progress")?.remove();
      if (subs.length) {
        const bar = el("span", { className: "dw-progress", role: "progressbar" }, el("i", { style: `width:${Math.round((done / subs.length) * 100)}%` }));
        bar.setAttribute("aria-valuenow", String(done));
        bar.setAttribute("aria-valuemax", String(subs.length));
        bar.setAttribute("aria-label", `${done} of ${subs.length} done`);
        head.querySelector(".ct").after(bar);
      }
      const first = String(detail.task.detail || "").split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) || "Empty";
      sections.description.meta("", first);
      const { ids } = ledgerOf();
      sections.sheet.meta(detail.comments.length || "", detail.comments.length ? `${ids.size} in the ledger` : "Empty");
      sections.workbench.meta("", wbValue().value);
      const runs = runsHere();
      sections.runs.meta(runs.length || "", runs.length ? runsValue().value : "None yet");
      const memN = memory.notes.length + (memory.pad ? 1 : 0);
      sections.memory.meta(memN || "", memory.loaded ? (memN ? `${memN} related` : "Nothing yet") : "");
      const alerts = host.liveAlerts(host.alertsForTask(taskId));
      sections.reminders.meta(alerts.length || "", alerts.length ? "" : "None set");
      sections.activity.meta(detail.events.length || "", detail.events.length ? `${STATUS_LABEL[detail.task.status] || detail.task.status} since ${shortDate(detail.events[detail.events.length - 1].at)}` : "");
    }

    // --- composer ---
    let kindMode = "say";
    let sending = false;
    const box = el("textarea", { className: "dw-compose-in", rows: 1, placeholder: "Write to the Sheet, or type / for run, ask, decide, note" });
    box.setAttribute("aria-label", "Write to the Sheet");
    if (window.DelphiRecovery) DelphiRecovery.bindDraft(box, "sheet", draftOf);
    const kindsBox = el("div", { className: "dw-kinds", role: "group" });
    kindsBox.setAttribute("aria-label", "Kind of entry");
    const sense = el("span", { className: "dw-sense" });
    sense.setAttribute("aria-live", "polite");
    const send = button("dw-send", "Post (Enter)", () => post(), { kids: [icon("send", "sm")] });
    send.dataset.act = "send";
    const where = () => {
      const wb = detail.workbench;
      return wb && wb.state !== "missing" ? "the Workbench folder" : detail.project ? "the project's folder" : "your home folder";
    };
    const current = () => composed(box.value, kindMode, { openAsk: openAsk(), where: where() });
    function paintKinds() {
      const c = current();
      kindsBox.textContent = "";
      for (const k of ["say", "run", "ask", "decide", "note"]) {
        const b = button(c.kind === k ? "on" : "", null, () => { kindMode = k; box.value = box.value.replace(/^(\/(say|run|ask|decide|note)\b ?|[$!?] )/, ""); paintKinds(); box.focus(); }, { text: k });
        b.setAttribute("aria-pressed", String(c.kind === k));
        b.dataset.kind = k;
        b.title = { say: "A comment", run: "Run a command; its output is kept", ask: "Ask: question | a | b", decide: "Answer the open question", note: "A note" }[k];
        if (k === "decide" && !openAsk()) b.title = "Nothing to decide: no question is open";
        kindsBox.append(b);
      }
      sense.classList.remove("err");
      sense.removeAttribute("role");
      sense.textContent = box.value.trim() ? c.say : "";
      box.classList.toggle("mono", c.kind === "run");
      send.disabled = !c.ok || sending;
    }
    async function post() {
      if (sending) return;
      const c = current();
      if (!c.ok) return;
      const sentRaw = box.value;
      sending = true;
      send.disabled = true;
      try {
        if (c.kind === "run") {
          const entry = await window.delphi.sheets.run(taskId, c.command);
          if (entry && entry.id != null) {
            outputOpen.add(entry.id);
            if (host.kit.isRunning(entry) && !host.runs.ended.has(entry.id)) host.runs.buffer(entry.id, taskId);
          }
        } else if (c.kind === "ask") await window.delphi.sheets.ask(taskId, c.question, c.options);
        else if (c.kind === "decide") await window.delphi.sheets.decide(c.askId, c.choice, c.why);
        else await window.delphi.sheets.append(taskId, { kind: c.kind, body: c.body });
      } catch (error) {
        sending = false;
        paintKinds();
        sense.textContent = String(error.message || error);
        sense.classList.add("err");
        sense.setAttribute("role", "alert");
        return;
      }
      sending = false;
      // Only what was sent goes; words typed while it was sending stay.
      if (box.value === sentRaw) { box.value = ""; kindMode = "say"; }
      if (window.DelphiRecovery && !box.value) DelphiRecovery.clearDraft("sheet", draftOf);
      detail = await window.delphi.tasks.detail(taskId) || detail;
      if (!sections.sheet.isOpen()) sections.sheet.set(true);
      paintAll();
      growBox();
    }
    const growBox = () => { box.style.height = "auto"; box.style.height = `${Math.min(160, box.scrollHeight)}px`; };
    box.addEventListener("input", () => { paintKinds(); growBox(); });
    box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); post(); } });
    const composer = el("div", { className: "dw-compose" }, box,
      el("div", { className: "row2" }, kindsBox, sense, el("span", { className: "grow" }), el("kbd", { textContent: "Enter" }), send));

    // --- assemble ---
    function paintAll() {
      // The head is rebuilt; whatever in it had focus gets it back.
      const f = document.activeElement;
      const keep = f && me.head.contains(f) ? (f.dataset.status ? `[data-status="${f.dataset.status}"]` : f.dataset.act ? `[data-act="${f.dataset.act}"]` : null) : null;
      paintTop();
      paintStatus();
      paintProps();
      paintCards();
      paintSectionMeta();
      for (const key of order) paintSection(key);
      paintKinds();
      if (document.activeElement !== title) {
        // The base moves only with the box: an edit waiting to be saved keeps
        // the title it was typed against, so a rename meanwhile is a conflict.
        if (title.value === titleFrom) { title.value = detail.task.title; titleFrom = detail.task.title; }
        titleBox.show();
      }
      me.root.setAttribute("aria-label", `Task ${taskId}: ${detail.task.title}`);
      if (keep && !me.head.contains(document.activeElement)) me.head.querySelector(keep)?.focus({ preventScroll: true });
    }
    function emptyBlock(iconName, h, p, acts) {
      return el("div", { className: "dw-empty" }, el("div", { className: "ill" }, icon(iconName, "")), el("h4", { textContent: h }), el("p", { textContent: p }), acts.length ? el("div", { className: "acts" }, ...acts) : null);
    }

    me.head.append(top, titleRow, el("div", { className: "dw-props-wrap" }, statusBox, props), banners, cards);
    for (const key of order) me.body.append(sections[key].wrap);
    me.foot.append(composer);
    me.foot.classList.add("composer");
    paintAll();
    requestAnimationFrame(growTitle);
    loadMemory();

    // The keys: 1 to 4 set the status, P opens priority, A assigns. Never
    // while typing, so a digit in the composer is a digit.
    me.root.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      // A key pressed on a subtask, a Sheet entry (an ask's options are a to d)
      // or the composer belongs to that, never to the task above it.
      if (t && t.closest && t.closest("[data-sub], [data-entry], .dw-foot, .ctx")) return;
      const k = e.key.toLowerCase();
      // Shift and Enter on a button is that button's; anywhere else it is the full view.
      if (e.key === "Enter" && e.shiftKey) { if (t.closest && t.closest("button, a, [role=button]")) return; e.preventDefault(); host.openFull(taskId); return; }
      // Digits by the key, so a layout that needs Shift for them still works.
      const digit = /^Digit[1-4]$/.test(e.code || "") ? e.code.slice(5) : e.key;
      const to = { 1: "todo", 2: "doing", 3: "blocked", 4: "done" }[digit];
      if (!to && e.shiftKey) return;
      if (to) { e.preventDefault(); if (statusOf() !== to) write({ status: to }, STATUS_LABEL[to].toLowerCase()); return; }
      if (k === "p") { e.preventDefault(); const b = props.querySelector("[data-act=priority]"); if (b) priorityMenu(b); return; }
      if (k === "a") { e.preventDefault(); const b = props.querySelector("[data-act=assign]"); if (b) editAssignee(b); }
    });

    // --- the handle app.js routes live updates through ---
    let liveBusy = false;
    let liveAgain = false;
    const handle = {
      taskId, drawer: true, root: me.root,
      close: () => me.close(),
      async live() {
        if (liveBusy) { liveAgain = true; return; }
        liveBusy = true;
        try {
          do {
            liveAgain = false;
            const next = await window.delphi.tasks.detail(taskId);
            if (host.sheet() !== handle) return;
            // Deleted elsewhere: nothing left to show, and nothing to save into.
            if (!next) { gone = true; host.notify(`Task #${taskId} was deleted. Restore it from History.`); await me.close(); return; }
            if (JSON.stringify(next) === JSON.stringify(detail)) continue;
            detail = next;
            paintAll();
            // A whole project's notes are not asked for again on every write
            // an agent makes; only while someone is looking at them.
            if (sections.memory.isOpen()) loadMemory();
          } while (liveAgain);
        } finally { liveBusy = false; }
      },
      wbRepaint: () => paintWorkbench(),
      runsRepaint: () => { paintCards(); paintSectionMeta(); paintRuns(); paintProps(); },
      showEntry: (id) => {
        outputOpen.add(id);
        if (!sections.sheet.isOpen()) sections.sheet.set(true);
        ledgerOnly = false;
        paintSheet();
        const row = sheetList.querySelector(`[data-entry="${id}"]`);
        if (!row) return;
        row.scrollIntoView({ block: "center", behavior: host.motionOff() ? "auto" : "smooth" });
        row.classList.add("flash");
        setTimeout(() => row.classList.remove("flash"), 1400);
        row.querySelector("[data-act=stop], button")?.focus({ preventScroll: true });
      },
      wbEvent: (e) => { paintWorkbench(); if (e.phase === "ready" || e.phase === "failed") reload(); },
      runDone: (entryId, buffer) => {
        if (buffer && buffer.truncated && outputOpen.has(entryId)) { outputText.delete(entryId); loadOutput(entryId); }
        else if (buffer && outputOpen.has(entryId)) {
          const tail = buffer.partial ? host.runs.line(buffer.partial) : "";
          outputText.set(entryId, { text: buffer.lines.join("\n") + (tail ? `\n${tail}` : ""), truncated: buffer.dropped > 0 });
        }
        reload();
      },
    };
    me.handle = handle;
    host.setSheet(handle);
    if (window.DelphiRecovery) DelphiRecovery.taskOpened(taskId);
    if (focus === "title") { titleBox.edit(); title.select(); }
    else me.focusFirst();
    return handle;
  }

  // --- a note --------------------------------------------------------------

  async function openNote(note) {
    if (!host || !note) return;
    const ticket = ++opening;
    const before = host.sheet();
    if (before) await before.close();
    if (lastClose) await lastClose.catch(() => {});
    if (ticket !== opening) return;
    const S = host.state();
    let n = { ...note };
    const project = (S.projects || []).find((p) => p.id === n.project_id) || null;
    let ed = null;
    const nameIn = el("textarea", { className: "dw-title plain", rows: 1, value: n.title, spellcheck: false });
    nameIn.setAttribute("aria-label", "Note title");
    // The note as the store has it now: a row from a list or a search can be
    // stale or cut short, and every save is checked against this.
    const fetchNote = async () => {
      const list = await window.delphi.notes.list(n.project_id == null ? null : n.project_id);
      return (list || []).find((x) => x.id === n.id) || null;
    };
    try { const fresh = await fetchNote(); if (fresh) n = { ...n, ...fresh }; } catch {}
    if (ticket !== opening) return;
    nameIn.value = n.title;
    let nameBox = null;
    const nameKeep = titleKeeper(nameIn, {
      label: "The note's title",
      fetch: async () => { const f = await fetchNote(); return f ? f.title : null; },
      write: async (title) => { await window.delphi.notes.update(n.id, { title }); n.title = title; host.refresh(); },
      onTake: () => nameBox && nameBox.show(),
    });
    // The title and the body save apart, each on its own blur, so a title
    // change never sends the body again.
    const saveAll = async () => { await nameKeep.save(); if (ed) await ed.commit(); };
    const me = frame({ label: `Note ${n.id}: ${n.title}`, onClose: saveAll });
    cur = me;
    me.root.classList.add("dw-note");
    const flashHost = el("span", { className: "dw-flash", role: "status" });
    const item = () => host.itemOf("note", { ...n, associated: n.associated && S.projectId && n.project_id !== S.projectId ? 1 : 0 });

    const pin = iconBtn("pin", n.pinned ? "Unpin this note" : "Pin this note", async () => {
      await window.delphi.notes.update(n.id, { pinned: n.pinned ? 0 : 1 });
      n.pinned = n.pinned ? 0 : 1;
      pin.classList.toggle("on", !!n.pinned);
      pin.setAttribute("aria-pressed", String(!!n.pinned));
      host.refresh();
    }, "pin");
    pin.classList.toggle("on", !!n.pinned);
    pin.setAttribute("aria-pressed", String(!!n.pinned));
    const share = iconBtn("share", "Share via MCP: copy this note for an agent", (e) => copyText(`Delphi note ${n.id} (${n.kind}): ${n.title}\nRead it with get_note ${n.id}.\n\n${ed ? ed.area.value : n.body || ""}`, e.currentTarget), "share");
    const del = iconBtn("trash", "Delete this note", () => host.deleteItem(item(), { onDelete: () => me.close() }), "delete");
    const moreB = iconBtn("more", "More: move, copy, also belongs, flag, full view", (e) => noteMenu(e.currentTarget), "more");
    moreB.setAttribute("aria-haspopup", "menu");
    function noteMenu(anchor) {
      const box = anchor.getBoundingClientRect();
      const full = el("button", { className: "ctx-item", type: "button" }, el("span", { textContent: "Open full view" }));
      full.onclick = async () => { host.closeRowMenu(); await me.close(); host.openNoteFull(n); };
      host.menuKeys(host.rowMenu(box.right - 260, box.bottom + 4, [el("div", { className: "ctx-head", textContent: `Note #${n.id}` }), { node: full }, "-", ...host.itemVerbs(item(), { after: () => host.refresh() })], { className: "item-menu dw-menu" }), anchor);
    }
    const crumbs = [projectCrumb(project, async () => { await me.close(); host.goTo({ projectId: project.id, view: "notes", query: "" }); }),
      el("span", { textContent: "Memory" }), el("span", { className: "dw-crumb-now", textContent: `#${n.id}` })];
    const kindSel = el("select", { className: `dw-kchip sel ${n.kind}` });
    kindSel.setAttribute("aria-label", "Kind of note");
    for (const k of ["note", "decision", "gotcha", "reference", "contact"]) kindSel.append(el("option", { value: k, textContent: k, selected: k === n.kind }));
    kindSel.onchange = async () => { await window.delphi.notes.update(n.id, { kind: kindSel.value }); n.kind = kindSel.value; kindSel.className = `dw-kchip sel ${n.kind}`; host.refresh(); };
    const chips = el("div", { className: "dw-chips" }, kindSel, el("span", { className: "dw-kchip", textContent: shortDate(n.updated_at || n.created_at), title: `Updated ${n.updated_at || ""}` }));
    if (n.associated && n.home_name) chips.append(host.fromChip(item()));
    const growName = () => { nameIn.style.height = "auto"; nameIn.style.height = `${nameIn.scrollHeight}px`; };
    nameIn.addEventListener("input", growName);
    nameIn.addEventListener("blur", () => nameKeep.save());
    nameBox = titleField(nameIn, "plain", { revert: () => nameKeep.base() });
    me.head.append(topRow(crumbs, [pin, share, del, moreB], flashHost, () => me.close()), chips, nameBox.node);

    ed = editor({ label: "Note", kind: "note", value: n.body || "", placeholder: "What is worth remembering here",
      draftKey: ["notebody", n.id],
      current: async () => { const f = await fetchNote(); return f ? f.body || "" : null; },
      onSave: async (body) => { const r = await window.delphi.notes.update(n.id, { body }); n.body = r && r.body != null ? r.body : body; host.refresh(); paintLinked(); return n.body; },
      tickStore: async (t) => {
        const r = await window.delphi.markdown.tick("note", n.id, t);
        if (r && !r.refused) { n.body = r.body; host.refresh(); }
        return r;
      },
      onMode: (m) => me.root.classList.toggle("wide", m === "split") });
    me.root.classList.toggle("wide", ed.mode() === "split");
    me.body.append(el("div", { className: "dw-sec" }, ed.node));

    // Linked: the tasks this note names as #N, each opening here.
    const linked = el("div", { className: "dw-sec" });
    function paintLinked() {
      linked.textContent = "";
      const text = ed ? ed.area.value : n.body || "";
      const ids = [...new Set([...String(text).matchAll(/(^|[^\w&])#(\d+)\b/g)].map((m) => Number(m[2])))];
      const tasks = ids.map((id) => (host.state().everyTask || []).find((t) => t.id === id)).filter(Boolean);
      const linkB = button("btn ghost sm", "Link a task: names it in this note", () => {
        const i = el("input", { className: "dw-inline", placeholder: "Task number", inputMode: "numeric" });
        i.setAttribute("aria-label", "Task number to link");
        linkB.replaceWith(i);
        i.focus();
        i.onkeydown = async (e) => {
          if (e.isComposing) return;
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); paintLinked(); return; }
          if (e.key !== "Enter") return;
          e.preventDefault();
          const id = Number(String(i.value).replace(/^#/, ""));
          if (!id) return;
          const body = `${(ed.area.value || "").replace(/\s+$/, "")}\n\nLinked to #${id}.`;
          await window.delphi.notes.update(n.id, { body });
          n.body = body;
          ed.update(body);
          host.refresh();
          paintLinked();
        };
        i.onblur = () => { if (!i.value.trim()) paintLinked(); };
      }, { kids: [icon("link", "sm")], text: "Link a task" });
      linkB.dataset.act = "link";
      linked.append(el("div", { className: "dw-sec-h" }, el("b", { textContent: "Linked" }), el("span", { className: "grow" }), linkB));
      if (!tasks.length) { linked.append(el("p", { className: "dw-fine", textContent: "No task is named here yet. A #number in the note links it." })); return; }
      const panel = el("div", { className: "dw-panel" });
      for (const t of tasks) {
        const b = el("button", { className: "dw-mem row", type: "button", title: "Open this task here" }, statusMark(host.statusOf(t)), el("span", { className: "t plain", textContent: `#${t.id} ${t.title}` }));
        b.dataset.open = String(t.id);
        b.onclick = () => host.openTask(t.id);
        panel.append(b);
      }
      linked.append(panel);
    }
    paintLinked();
    me.body.append(linked);

    // Projects: home, and the Item menu's verbs as buttons.
    const verbs = host.itemVerbs(item(), { after: () => host.refresh(), withIcons: false });
    const pick = (label) => verbs.find((v) => v && v.label && v.label.startsWith(label));
    const also = pick("Also belongs");
    const flagV = pick("Flag");
    const projRow = el("div", { className: "dw-chips" });
    if (project) projRow.append(el("span", { className: "dw-pchip" }, el("span", { className: "dw-sw", style: `background:${safeColour(project.colour, "var(--accent)")}` }), project.name), el("span", { className: "dw-fine", textContent: "Home" }));
    if (also) { const b = button("btn ghost sm", null, () => also.run(), { kids: [icon("plus", "sm")], text: "Also belongs to..." }); b.dataset.act = "also"; projRow.append(b); }
    if (flagV) { const b = button("btn ghost sm", null, () => flagV.run(), { kids: [icon("flag", "sm")], text: "Flag for review" }); b.dataset.act = "flag"; projRow.append(b); }
    me.body.append(el("div", { className: "dw-sec" }, el("div", { className: "dw-sec-h" }, el("b", { textContent: "Projects" })), projRow));

    me.foot.append(el("span", {}, el("kbd", { textContent: "E" }), " edit"), el("span", {}, el("kbd", { textContent: "M" }), " move"), el("span", {}, el("kbd", { textContent: "L" }), " link"),
      el("span", { className: "grow" }), el("span", {}, el("kbd", { textContent: "Esc" }), " close"));
    me.foot.classList.add("keys");
    me.root.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === "e") { e.preventDefault(); ed.setTo("write"); ed.area.focus(); }
      else if (k === "m") { e.preventDefault(); const mv = pick("Move"); if (mv) mv.run(); }
      else if (k === "l") { e.preventDefault(); linked.querySelector("[data-act=link]")?.click(); }
    });
    let noteLive = false;
    let noteAgain = false;
    const handle = {
      drawer: true, note: n, root: me.root, close: () => me.close(),
      // An agent's write to the note while it is open here.
      // One read at a time, the newest last, so an older read finishing late
      // never puts an older body back in the box.
      async live() {
        if (noteLive) { noteAgain = true; return; }
        noteLive = true;
        try {
          do {
            noteAgain = false;
            let f = null;
            try { f = await fetchNote(); } catch { return; }
            if (host.sheet() !== handle) return;
            // Not in its project's list is not proof it is gone (it may live
            // elsewhere now), so the drawer is left as it is.
            if (!f) return;
            nameKeep.update(f.title);
            ed.update(f.body || "");
            n = { ...n, ...f };
            handle.note = n;
            paintLinked();
          } while (noteAgain);
        } finally { noteLive = false; }
      },
    };
    me.handle = handle;
    host.setSheet(handle);
    requestAnimationFrame(growName);
    me.focusFirst();
    return handle;
  }

  // --- a pad ---------------------------------------------------------------

  async function openPad(padOrId) {
    if (!host || padOrId == null) return;
    const ticket = ++opening;
    const before = host.sheet();
    if (before) await before.close();
    if (lastClose) await lastClose.catch(() => {});
    let pad = typeof padOrId === "object" ? padOrId : await window.delphi.pads.get(padOrId);
    if (pad && pad.body == null && pad.id) pad = await window.delphi.pads.get(pad.id);
    if (!pad || ticket !== opening) return;
    const S = host.state();
    const project = (S.projects || []).find((p) => p.id === pad.project_id) || null;
    let ed = null;
    const nameIn = el("textarea", { className: "dw-title plain", rows: 1, value: pad.title, spellcheck: false });
    nameIn.setAttribute("aria-label", "Pad title");
    let nameBox = null;
    const nameKeep = titleKeeper(nameIn, {
      label: "The pad's title",
      fetch: async () => { const f = await window.delphi.pads.get(pad.id); return f ? f.title : null; },
      write: async (title) => { await window.delphi.pads.write(pad.id, { title }); pad.title = title; host.refresh(); },
      onTake: () => nameBox && nameBox.show(),
    });
    // Title and body save apart. The body is the whole pad, so its save is
    // checked against the stored pad (reconcile) and never puts an older copy
    // over an agent's append or a status the board wrote back into a line.
    let padGone = false;
    const save = async () => { if (padGone) return; await nameKeep.save(); if (ed) await ed.commit(); };
    const me = frame({ label: `Pad ${pad.key || pad.id}: ${pad.title}`, onClose: save });
    cur = me;
    me.root.classList.add("dw-pad");
    const flashHost = el("span", { className: "dw-flash", role: "status" });
    const item = () => host.itemOf("scratchpad", pad);
    const pin = iconBtn("pin", pad.pinned ? "Unpin this pad" : "Pin this pad", async () => {
      await window.delphi.pads.write(pad.id, { pinned: pad.pinned ? 0 : 1 });
      pad.pinned = pad.pinned ? 0 : 1;
      pin.classList.toggle("on", !!pad.pinned);
      pin.setAttribute("aria-pressed", String(!!pad.pinned));
      host.refresh();
    }, "pin");
    pin.classList.toggle("on", !!pad.pinned);
    pin.setAttribute("aria-pressed", String(!!pad.pinned));
    const share = iconBtn("share", "Share via MCP: copy how an agent reads this pad", (e) => copyText(`Delphi pad "${pad.title}" (key ${pad.key}). Read it with read_scratchpad key="${pad.key}", add to it with append_scratchpad.`, e.currentTarget), "share");
    const del = iconBtn("trash", "Delete this pad", () => host.deleteItem(item(), { onDelete: () => me.close() }), "delete");
    const moreB = iconBtn("more", "More: move, copy, also belongs, flag", (e) => {
      const box = e.currentTarget.getBoundingClientRect();
      host.itemMenu(item(), box.right - 250, box.bottom + 4, { after: () => host.refresh(), onDelete: () => me.close() });
    }, "more");
    moreB.setAttribute("aria-haspopup", "menu");
    const crumbs = [projectCrumb(project, async () => { await me.close(); host.goTo({ projectId: project.id, view: "pads", query: "" }); }),
      el("span", { textContent: "Pads" }), el("span", { className: "dw-crumb-now mono", textContent: pad.key || `#${pad.id}` })];
    const growName = () => { nameIn.style.height = "auto"; nameIn.style.height = `${nameIn.scrollHeight}px`; };
    nameIn.addEventListener("input", growName);
    nameIn.addEventListener("blur", () => nameKeep.save());
    const checks = () => ((ed ? ed.area.value : pad.body || "").match(/^\s*[-*] \[[ xX]\]/gm) || []).length;
    const checksChip = el("span", { className: "dw-prop static" });
    const paintChecks = () => { checksChip.textContent = ""; checksChip.append(icon("tasks", "sm"), `${checks()} ${checks() === 1 ? "checkbox" : "checkboxes"}`); };
    const props = el("div", { className: "dw-props" },
      el("span", { className: "dw-prop static" }, avatar(pad.author || "you"), pad.author || "you"),
      el("span", { className: "dw-prop static muted" }, icon("clock", "sm"), shortDate(pad.updated_at || pad.created_at)), checksChip);
    // Off means the pad is a sketch: options nobody has agreed to should not
    // fill the board with work.
    const toggle = el("button", { className: "dw-toggle", type: "button" });
    toggle.setAttribute("role", "switch");
    toggle.dataset.act = "derive";
    const toggleWords = el("span", { className: "grow" });
    const paintToggle = () => {
      toggle.setAttribute("aria-checked", String(!!pad.derives_tasks));
      toggle.setAttribute("aria-label", "Checkboxes become tasks");
      toggleWords.textContent = "";
      toggleWords.append(el("b", { textContent: "Checkboxes become tasks" }), ` · ${pad.derives_tasks ? "on, so each checkbox line is a task on the board" : "off for this pad, so its plan stays prose"}`);
    };
    toggle.onclick = async () => {
      await window.delphi.pads.write(pad.id, { derives_tasks: pad.derives_tasks ? 0 : 1 });
      pad.derives_tasks = pad.derives_tasks ? 0 : 1;
      paintToggle();
      host.refresh();
    };
    paintToggle();
    nameBox = titleField(nameIn, "plain", { revert: () => nameKeep.base() });
    me.head.append(topRow(crumbs, [pin, share, del, moreB], flashHost, () => me.close()), nameBox.node, props, el("div", { className: "dw-note-line" }, toggle, toggleWords));
    // The <!--d:N--> markers are how a line and its task stay the same thing.
    // Kept in the source, and left out of the formatted view by the renderer,
    // which drops HTML comments, so the preview keeps the source line numbers
    // a tick needs.
    ed = padEditor(pad, {
      onSaved: () => { host.refresh(); paintChecks(); },
      onMode: (m) => me.root.classList.toggle("wide", m === "split") });
    ed.area.addEventListener("input", paintChecks);
    paintChecks();
    me.root.classList.toggle("wide", ed.mode() === "split");
    me.body.append(ed.node, el("p", { className: "dw-fine", textContent: "The <!--d:123--> markers are how a line and its task stay the same thing. Edit around them." }));
    me.foot.append(el("span", { textContent: "Agents write here with append_scratchpad" }), el("span", { className: "grow" }), el("span", {}, el("kbd", { textContent: "Esc" }), " close"));
    me.foot.classList.add("keys");
    let padLive = false;
    let padAgain = false;
    const handle = {
      drawer: true, pad, root: me.root, close: () => me.close(),
      // An agent's append, or a status written back into a line by the board.
      async live() {
        if (padLive) { padAgain = true; return; }
        padLive = true;
        try {
          do {
            padAgain = false;
            let f = null;
            try { f = await window.delphi.pads.get(pad.id); } catch { return; }
            if (host.sheet() !== handle) return;
            if (!f) { padGone = true; host.notify("This pad was deleted. Restore it from History."); await me.close(); return; }
            nameKeep.update(f.title);
            ed.update(f.body || "");
            Object.assign(pad, { derives_tasks: f.derives_tasks, pinned: f.pinned, updated_at: f.updated_at });
            paintChecks();
          } while (padAgain);
        } finally { padLive = false; }
      },
    };
    me.handle = handle;
    host.setSheet(handle);
    requestAnimationFrame(growName);
    me.focusFirst();
    return handle;
  }

  return {
    init: (h) => { host = h; },
    open, openNote, openPad,
    // The one Write, Preview and Split editor, for the Pads tab (app.js).
    editor, padEditor,
    close: () => (cur ? cur.close() : undefined),
    editTitle: () => { const b = document.querySelector(".dw .dw-title-btn"); if (b) b.click(); },
    isOpen: () => Boolean(cur),
    // The task open here, for Log a fact (ui/memory.js) and anything else that
    // files against "the task on screen".
    taskId: () => { const h = host && host.sheet(); return h && h.drawer && h.taskId ? h.taskId : null; },
    // Pure, for tools/drawer_test.js.
    stuck, related, ordered, composed, reconcile,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.DelphiDrawer;
