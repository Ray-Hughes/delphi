// Renderer. Talks to the main process through window.delphi only.

const state = {
  projects: [],
  // The folders, and which one is open. null is the picker: every workspace
  // shown, nothing zoomed into.
  workspaces: [],
  workspaceId: null,
  // The projects inside the open workspace. Separate from state.projects, which
  // stays the whole set, because a project can belong to several folders and
  // filtering the whole list on every render would ask the database the same
  // question repeatedly.
  wsProjects: [],
  // Workspace id to the ids of the projects in it, for the sidebar's tree.
  wsMembers: new Map(),
  // Project id to the workspace it is drawn under in full: its primary one,
  // else the first that holds it. The others show a pointer row instead.
  wsHome: new Map(),
  projectId: null,     // null means the All view
  view: "today",       // today | new | overview | tasks | notes | links | history | settings
  showDone: false,
  // Set by the dashboard tiles, so a tile is a way into the list rather than a
  // number you then have to go and find yourself. Cleared whenever the list is
  // reached by any other route.
  // The open session, and the messages in it. Held here rather than fetched by
  // the chat renderer so a re-render, which happens on every alert tick, does
  // not blank a conversation mid-read.
  sessions: [],
  sessionId: null,
  // What this machine can talk to, asked once at boot. Probing spawns login
  // shells, which is far too slow to repeat on every render.
  providers: [],
  // Which half of the pane is showing. Not a view of its own: the chat and the
  // terminal are two faces of the same place, which is why Cmd+J flips between
  // them rather than navigating anywhere.
  // Which face of the pane is showing. "chat" is Delphi's own, "terminal" is the
  // command runner, and "h:<key>" is somebody else's agent running as a tab.
  pane: "chat",          // chat | terminal | h:claude-code | h:codex | ...
  // The registry, with whether each one is actually installed. Asked at boot for
  // the same reason providers is: resolving a binary spawns a login shell.
  harnesses: [],
  // What the running turn has done, this turn only. Tool calls go into the
  // message as they happen, so this is the live indicator rather than the record.
  turnTool: null,
  // Why it has gone quiet, when it has said. An API retrying under load is the
  // usual answer, and five silent minutes with no explanation is the worst thing
  // a tab can do.
  turnStatus: null,
  termLines: [],         // what the running command has said
  termBusy: false,
  termDraft: "",
  messages: [],
  // The scratchpads in the open project, and which one is being read. padDetail
  // is the parsed form the main process hands back: one entry per checkbox line
  // with the task behind it, plus the tasks the pad no longer mentions.
  pads: [],
  padId: null,
  padDetail: null,
  // Source rather than the projected view. Per session and not stored, unlike
  // the memory toggle: reading a pad is the normal case and editing it is the
  // errand you are on right now.
  padRaw: false,
  // Held here for the same reason draft is: render() rebuilds the pane
  // wholesale, and a body being typed into a textarea would not survive it.
  padDraft: null,
  // What is typed but not yet sent. render() rebuilds #content wholesale, so a
  // draft that lived only in the textarea would be destroyed by an alert
  // arriving while someone was still typing.
  draft: "",
  streaming: false,
  taskFilter: null,    // null | doing | blocked | overdue | done
  theme: "system",     // system | light | dark
  noteView: "formatted", // formatted | raw
  // Mirrored from settings.json so motionOff can answer without a round trip.
  // The CSS half of the same choice is the data-motion attribute on the root.
  animations: true,
  // Which single note is open for editing. Deliberately not persisted and
  // deliberately not noteView: editing one note says nothing about how you want
  // to read the rest of them.
  editingNoteId: null,
  query: "",
  tasks: [],
  notes: [],
  links: [],
  repos: [],
  organizers: [],
  // Which epic the board and the column layouts are narrowed to. null is all of
  // them, "none" is the work that is in none.
  epicFilter: null,
  allTasks: [],
  // Every reminder, live and spent, so the tab badge and the task sheet come
  // from one read rather than one each.
  alerts: [],
  // Where we have been, so Back can return. Holds the whole position rather than
  // just the project, because returning to the right project on the wrong tab is
  // not returning.
  history: [],
  oracleHits: [],
  oracleEntities: [],
  oracleError: null,
  provider: null,
  // Every job, newest first, from runs:list. Read by Runs, Needs you, the
  // sidebar, the title bar and a task's chip, and replaced whole on
  // runs-changed rather than patched, so none of them can disagree.
  runs: [],
  // Every task in every project, for the sidebar's late counts and its
  // "touched lately". The same list as allTasks when nothing narrows it.
  everyTask: [],
  // settings.json as last read, for the agent limits Runs draws.
  settings: {},
  pinned: [],
  // settings.hiddenFromActive as [{ id, at }]. See sidebarGroups.
  hidden: [],
  restOpen: (() => { try { return localStorage.getItem("delphi.sidebar.moreOpen") === "1"; } catch { return false; } })(),
  // The project whose whole session list is unfolded, if any. A project id
  // rather than a flag, so moving to another project folds its list again.
  sessionsAllFor: null,
  // The open project's archived sessions, and the project whose archive is
  // unfolded in the sidebar, kept the same way as sessionsAllFor.
  archivedSessions: [],
  archivedOpenFor: null,
  // Today opens All work until it is built; this says which of the two was clicked.
  todayPick: false,
  runsEarlier: false,
  inboxFilter: "all",     // all | approvals | questions
  inboxGroup: "urgency",  // urgency | project
  lastHandAgent: null,
  lastHandKind: "ask",
};

// $, el and safeColour live in ui/core.js, loaded before this file, so the
// modules under ui/ build DOM the same way this file does.

// Every stamp and day in this file goes through timefmt.js: stamps from the
// store are UTC, a due date is a day on the local calendar, and parsing either
// by hand is how "today" came to start at eight in the evening.
const TIME = window.delphiTime;
const today = () => TIME.localDay();
const isOverdue = (t) => t.status !== "done" && TIME.dueState(t.due) === "overdue";

/**
 * The status this version knows how to draw. A newer Delphi adds statuses
 * (In review), and a person who downgrades keeps that database; a task this
 * version cannot name is shown as in progress, because that is what it most
 * nearly is, and it then still appears in a column instead of in none. Only
 * what is drawn changes: the stored value is never rewritten from here.
 */
const KNOWN_STATUSES = new Set(["todo", "doing", "blocked", "done"]);
const statusOf = (t) => (KNOWN_STATUSES.has(t && t.status) ? t.status : "doing");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The system half of the motion question, read once and then kept current by a
// listener rather than queried at each call site. motionOff is called inside an
// animation frame loop, and matchMedia there is a style read per frame.
const motionQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
let reducedMotionNow = motionQuery ? motionQuery.matches : false;
motionQuery?.addEventListener("change", (e) => { reducedMotionNow = e.matches; });

/**
 * Whether motion should be suppressed, for the JavaScript that cannot be reached
 * by the blanket CSS rules in index.html.
 *
 * The setting and the system preference are independent off switches: turning
 * the setting on does not override someone's reduced motion preference.
 */
const motionOff = () => state.animations === false || reducedMotionNow;

/**
 * The small celebration when a task is ticked off.
 *
 * The row wiggles, washes green and pops its tick, and a handful of sparks fly
 * out of the checkbox. Then the row leaves, because the list hides finished
 * work. The point is the order: confirm, then remove. Removing first is what
 * made completing a task feel like losing one.
 *
 * Directions are set per spark as custom properties so a single keyframe throws
 * all of them outwards. Delays are jittered because six sparks leaving on
 * exactly the same frame reads as one shape rather than as a burst.
 */
function celebrateDone(row) {
  if (motionOff()) return;
  row.classList.add("celebrate");
  const directions = [[-24, -18], [-2, -28], [22, -20], [-22, 14], [20, 16], [3, 24]];
  for (const [dx, dy] of directions) {
    const spark = el("span", { className: "spark", textContent: "✦" });
    spark.style.setProperty("--dx", `${dx}px`);
    spark.style.setProperty("--dy", `${dy}px`);
    spark.style.animationDelay = `${Math.round(Math.random() * 90)}ms`;
    row.append(spark);
  }
}

// Open dialogs, newest last. Each listens on the document, so without this
// one Enter or Escape would answer every dialog stacked on the screen: a done
// prompt arriving over the commit message box, say. Only the top one answers.
const dialogStack = [];

/**
 * Asks for one line of text. Resolves to the string, or null if cancelled.
 *
 * This exists because Electron does not implement window.prompt. It does not
 * return null the way a browser does when you dismiss one, it throws outright,
 * and every caller here was an async click handler, so the throw became an
 * unhandled rejection and the button did nothing at all. Silent, and the same
 * shape as a dead onclick, which is why it survived: New Project, both epic
 * dialogs and Add Repository were all broken this way.
 *
 * alert and confirm are fine and are left alone. prompt is the only one Electron
 * refuses.
 */
function askText({ title, label, value = "", placeholder = "", confirmLabel = "Create", allowEmpty = false, pickFolder = false }) {
  return new Promise((resolve) => {
    const overlay = el("div", { className: "overlay" });
    const box = el("div", { className: "ask" });
    const input = el("input", { className: "field", value, placeholder, type: "text" });
    const error = el("div", { className: "err-msg", style: "display:none" });

    const me = {};
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      const at = dialogStack.indexOf(me);
      if (at >= 0) dialogStack.splice(at, 1);
      overlay.remove();
      resolve(result);
    };

    const submit = () => {
      const text = input.value.trim();
      // Empty is a legitimate answer where the field is being cleared rather than
      // set, so those callers get "" back and cancelling still gives them null.
      // The two have to stay distinguishable.
      if (!text && !allowEmpty) {
        error.style.display = "";
        error.textContent = "Needs a value.";
        input.focus();
        return;
      }
      finish(text);
    };

    // Captured on the document, because the window-level handler treats Escape as
    // "hide the window" and would take the whole app away instead of this box.
    const onKey = (event) => {
      if (dialogStack[dialogStack.length - 1] !== me) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        submit();
      }
    };
    dialogStack.push(me);
    document.addEventListener("keydown", onKey, true);

    const cancel = el("button", { className: "btn", textContent: "Cancel", type: "button" });
    const ok = el("button", { className: "btn primary", textContent: confirmLabel, type: "button" });
    cancel.onclick = () => finish(null);
    ok.onclick = submit;

    const actions = el("div", { className: "ask-actions" });

    // Typing an absolute path means going to look it up and retyping it without
    // a typo. The field stays, because pasting a path you already have is faster
    // than browsing to it, but it is no longer the only way in.
    if (pickFolder) {
      const browse = el("button", { className: "btn", textContent: "Choose folder…", type: "button" });
      browse.onclick = async () => {
        try {
          const picked = await window.delphi.dialog.pickFolder(title);
          if (!picked) return;          // cancelled in the native dialog
          input.value = picked;
          error.style.display = "none";
          input.focus();
        } catch (e) {
          error.style.display = "";
          error.textContent = e.message;
        }
      };
      actions.append(browse);
      actions.style.justifyContent = "space-between";
    }

    actions.append(el("div", { style: "display:flex; gap:8px" }, cancel, ok));

    box.append(el("h3", { textContent: title }));
    if (label) box.append(el("p", { className: "hint", textContent: label }));
    box.append(input, error, actions);
    overlay.append(box);
    overlay.onclick = (event) => { if (event.target === overlay) finish(null); };
    document.body.append(overlay);

    input.focus();
    input.select();
  });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Applies a theme choice.
 *
 * "system" removes the attribute rather than resolving the preference here, so
 * the media query stays in charge and the window follows the system if it
 * changes while open. The other two pin it.
 */
function applyTheme(theme) {
  const choice = ["light", "dark"].includes(theme) ? theme : "system";
  state.theme = choice;
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);
}

/**
 * Applies the animation choice.
 *
 * Off is the attribute, on is its absence, so the stylesheet needs one selector
 * and the ordinary case carries no marker. This is only the app's own switch: a
 * system reduced motion preference is answered by its own rule and is not
 * overridden by turning this on.
 */
function applyMotion(on) {
  state.animations = on !== false;
  if (state.animations) document.documentElement.removeAttribute("data-motion");
  else document.documentElement.setAttribute("data-motion", "off");
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/**
 * Renders the markdown subset the notes actually contain.
 *
 * Agents write these notes, and they write headings, tables, fenced code,
 * lists and links. Nothing here is a general markdown implementation; it is
 * the smallest thing that renders our own notes faithfully.
 *
 * Everything is built as DOM nodes rather than assembled into innerHTML. The
 * content is our own, but a renderer that pastes strings into the document is
 * one imported note away from being an injection point, and the page runs with
 * a strict CSP precisely so that cannot happen.
 */
function inlineMarkdown(text) {
  const out = [];
  // Emphasis may not be flanked by spaces, so arithmetic and shell globs in a
  // note ("2 * 3 * 4") are left alone rather than silently italicised.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*(?!\s)[^*\n]*?(?<!\s)\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(document.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      out.push(el("code", { textContent: token.slice(1, -1) }));
    } else if (token.startsWith("**")) {
      out.push(el("strong", { textContent: token.slice(2, -2) }));
    } else if (token.startsWith("*")) {
      out.push(el("em", { textContent: token.slice(1, -1) }));
    } else {
      const split = token.indexOf("](");
      const href = token.slice(split + 2, -1);
      const link = el("a", { textContent: token.slice(1, split), href: "#", title: href });
      // Only http(s) leaves the app, and it leaves through the main process
      // rather than navigating this window.
      link.onclick = (e) => {
        e.preventDefault();
        if (/^https?:\/\//i.test(href)) window.delphi.openExternal(href);
      };
      out.push(link);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

const isTableSeparator = (line) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
const splitRow = (line) => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

function renderMarkdown(source) {
  const root = el("div", { className: "md" });
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Where this pass started. Every branch below is supposed to consume at
    // least one line, and the one that stopped doing so locked the window hard
    // enough to need a force quit. A renderer for text people paste in should
    // degrade to an ugly paragraph, never to a spin, so the guarantee is made
    // structural at the bottom of the loop rather than trusted to each branch.
    const started = i;

    if (!line.trim()) { i += 1; continue; }

    // Fenced code. An unterminated fence runs to the end rather than throwing
    // away the rest of the note.
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;
      root.append(el("pre", {}, el("code", { textContent: body.join("\n") })));
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { root.append(el("hr")); i += 1; continue; }

    // Leading whitespace is allowed, and has to be, because the paragraph loop
    // below refuses any line matching /^\s*#{1,6}\s/. When this pattern was
    // anchored at column 0 the two disagreed about indented headings: an
    // indented "# text" was not a heading, was not any other block, and was
    // rejected by the paragraph loop, so i never advanced and the outer while
    // spun forever on that one line. A single line of " # x" hung the window.
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      root.append(el(`h${level}`, {}, inlineMarkdown(heading[2].trim())));
      i += 1;
      continue;
    }

    // Table: a pipe row followed by a dash rule.
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const table = el("table");
      const head = el("tr");
      splitRow(line).forEach((cell) => head.append(el("th", {}, inlineMarkdown(cell))));
      table.append(el("thead", {}, head));
      const tbody = el("tbody");
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        const tr = el("tr");
        splitRow(lines[i]).forEach((cell) => tr.append(el("td", {}, inlineMarkdown(cell))));
        tbody.append(tr);
        i += 1;
      }
      table.append(tbody);
      root.append(el("div", { className: "table-wrap" }, table));
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, "")); i += 1; }
      root.append(el("blockquote", {}, ...inlineMarkdown(body.join(" "))));
      continue;
    }

    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const marker = ordered ? numbered : bullet;
      const list = el(ordered ? "ol" : "ul");
      while (i < lines.length && marker.test(lines[i])) {
        list.append(el("li", {}, inlineMarkdown(lines[i].replace(marker, ""))));
        i += 1;
      }
      root.append(list);
      continue;
    }

    // Paragraph: runs until a blank line or the start of another block.
    const para = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^\s*(#{1,6}\s|>|```)/.test(lines[i]) &&
      !bullet.test(lines[i]) && !numbered.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) { para.push(lines[i].trim()); i += 1; }
    if (para.length) root.append(el("p", {}, ...inlineMarkdown(para.join(" "))));

    // Nothing above took the line. Render it as a paragraph and move on, so an
    // unforeseen combination costs one oddly formatted line instead of the app.
    if (i === started) {
      root.append(el("p", {}, ...inlineMarkdown(line.trim())));
      i += 1;
    }
  }

  return root;
}

/** "3 days ago" reads faster than a timestamp when scanning activity. */
const ago = (stamp) => TIME.ago(stamp);

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function refresh() {
  state.projects = await window.delphi.projects.list();
  state.workspaces = await window.delphi.workspaces.list();
  // One call per workspace rather than a new IPC, because there are a handful of
  // workspaces and the tree has to know which project sits under which.
  const members = await Promise.all(state.workspaces.map((w) => window.delphi.workspaces.projects(w.id)));
  state.wsMembers = new Map(state.workspaces.map((w, i) => [w.id, members[i].map((p) => p.id)]));
  state.wsHome = new Map();
  state.workspaces.forEach((w, i) => {
    for (const p of members[i]) if (p.is_primary && !state.wsHome.has(p.id)) state.wsHome.set(p.id, w.id);
  });
  state.workspaces.forEach((w, i) => {
    for (const p of members[i]) if (!state.wsHome.has(p.id)) state.wsHome.set(p.id, w.id);
  });
  state.wsProjects = state.workspaceId
    ? members[state.workspaces.findIndex((w) => w.id === state.workspaceId)] || []
    : [];
  state.alerts = await loadAlerts();

  if (state.query) {
    const { tasks, notes } = await window.delphi.search(state.query);
    state.tasks = tasks;
    state.notes = notes;
    state.links = [];
    state.repos = [];
    state.sessions = [];
    state.archivedSessions = [];
    state.sessionId = null;
    state.organizers = [];

    // Meaning-based ranking and the graph, in parallel with the literal match, so
    // the Oracle tab is ready rather than loading when it is opened.
    try {
      state.oracleError = null;
      state.provider = await window.delphi.oracle.provider();
      state.oracleHits = await window.delphi.oracle.nearest(state.query, { limit: 10 });
      const ctx = await window.delphi.oracle.context(state.query.split(/\s+/)[0]);
      state.oracleEntities = ctx ? ctx.related : [];
    } catch (error) {
      // The Oracle is an enhancement, so plain search must survive losing it.
      // The reason is kept rather than discarded: "nothing matched" and "the
      // Oracle never ran" look identical on screen otherwise.
      state.oracleHits = [];
      state.oracleEntities = [];
      state.oracleError = String(error.message || error);
    }
  } else {
    state.allTasks = await window.delphi.tasks.list({
      projectId: state.projectId,
      includeDone: true,
    });
    state.tasks = state.showDone
      ? state.allTasks
      : state.allTasks.filter((t) => t.status !== "done");
    if (state.projectId) {
      state.notes = await window.delphi.notes.list(state.projectId);
      state.pads = await window.delphi.pads.list(state.projectId);
      // Landing on the most recently written pad rather than on nothing, which is
      // what makes opening the tab feel like picking the work back up.
      if (!state.pads.some((p) => p.id === state.padId)) {
        state.padId = state.pads.length ? state.pads[0].id : null;
        state.padDraft = null;
      }
      state.padDetail = state.padId ? await window.delphi.pads.tasks(state.padId) : null;
      state.links = await window.delphi.links.list(state.projectId);
      state.repos = await window.delphi.repos.list(state.projectId);
      state.sessions = await window.delphi.sessions.list(state.projectId);
      state.archivedSessions = await window.delphi.sessions.archived(state.projectId);
      state.organizers = await window.delphi.organizers.list(state.projectId);
    } else {
      state.notes = [];
      state.pads = [];
      state.padId = null;
      state.padDetail = null;
      state.links = [];
      state.repos = [];
      state.sessions = [];
      state.archivedSessions = [];
      state.sessionId = null;
      state.organizers = [];
    }
  }
  state.everyTask = !state.query && !state.projectId
    ? state.allTasks
    : await window.delphi.tasks.list({ projectId: null, includeDone: true });
  try { state.runs = await window.delphi.runs.list({ limit: 300 }); } catch { state.runs = []; }
  if (window.DelphiNeeds) await DelphiNeeds.load();
  render();
  reloadFlags();
}

const currentProject = () => state.projects.find((p) => p.id === state.projectId) || null;

// The position the last render painted, so the next one can tell a repaint from
// a move and decide whether to keep the reader's scroll position.
let lastRenderedPosition = null;

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

/** Current position, as the thing Back restores. */
const position = () => ({ projectId: state.projectId, view: state.view, query: state.query });

const samePosition = (a, b) =>
  a.projectId === b.projectId && a.view === b.view && a.query === b.query;

/**
 * Moves to a new position, remembering the old one.
 *
 * Repeats are not pushed, so holding Back does not walk through a run of
 * identical entries, and the depth is capped because this is a panel, not a
 * browser: nobody needs to unwind fifty steps.
 */
function navigate(next) {
  const from = position();
  // A filter belongs to the trip that set it. Any other move into the task list,
  // or out of it, drops the filter rather than leaving a list quietly narrowed.
  if (next.view !== undefined) state.taskFilter = null;
  // A session belongs to one project, so moving to another has to let go of it.
  // Without this the chat tab opens showing the previous project's conversation
  // until something else happens to reload it.
  if (next.projectId !== undefined && next.projectId !== state.projectId) {
    state.sessionId = null;
    state.messages = [];
    state.draft = "";
  }
  Object.assign(state, next);
  // Arriving at a project from a chip or a search result, outside the workspace
  // that is open, leaves that workspace. Staying zoomed in would show a folder
  // the project is not in, with no row for the project you are looking at.
  if (state.projectId && state.workspaceId && !state.wsProjects.some((p) => p.id === state.projectId)) {
    state.workspaceId = null;
    state.wsProjects = [];
  }
  const to = position();
  if (samePosition(from, to)) return Promise.resolve();

  state.history.push(from);
  if (state.history.length > 50) state.history.shift();
  // The repaint is handed back so a caller can wait for it. The menu needs that:
  // the composer it wants to put the cursor in is created by the render and does
  // not exist in the document until this has finished.
  return refresh();
}

/**
 * Opens the task list narrowed to one slice of it.
 *
 * Done is the exception that needs showDone turned on, since the list hides
 * finished work by default and a Done tile that led to an empty list would
 * look broken.
 */
function showTasks(filter) {
  const already = state.view === "tasks";
  if (filter === "done") state.showDone = true;
  if (already) {
    state.taskFilter = filter;
    refresh();
    return;
  }
  navigate({ view: "tasks" });
  state.taskFilter = filter;
  refresh();
}

function goBack() {
  const previous = state.history.pop();
  if (!previous) return false;
  state.projectId = previous.projectId;
  state.view = previous.view;
  state.query = previous.query;
  $("search").value = previous.query || "";
  refresh();
  return true;
}



// The words for an agent, as the person picked it. Null is Delphi's own chat,
// which drives no CLI and so has no harness row to borrow a label from.
function sessionAgent(sn) {
  if (!sn.harness) return "Delphi chat";
  const h = state.harnesses.find((x) => x.key === sn.harness);
  return h ? h.label : sn.harness;
}

/** "2 months ago": a sidebar is scanned, and a day count past a week is arithmetic. */
function sessionAgo(stamp) {
  const s = TIME.secondsSince(stamp);
  if (!Number.isFinite(s)) return "";
  const say = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (s < 60) return "just now";
  if (s < 3600) return say(Math.round(s / 60), "minute");
  if (s < 86400) return say(Math.round(s / 3600), "hour");
  const days = Math.round(s / 86400);
  if (days < 14) return say(days, "day");
  if (days < 60) return say(Math.round(days / 7), "week");
  if (days < 365) return say(Math.round(days / 30), "month");
  return say(Math.round(days / 365), "year");
}

// The newest of the times a session can be said to have been used. Compared as
// times, because last_run_at is ISO and the rest are SQLite's own format, and
// the two do not sort together as text.
function sessionLastActive(sn) {
  let best = null;
  for (const v of [sn.last_message_at, sn.last_run_at, sn.updated_at, sn.created_at]) {
    const at = v ? TIME.parseStamp(v) : null;
    if (at && (!best || at > best.at)) best = { at, v };
  }
  return best ? best.v : null;
}

// More than this and the list folds, because the sessions sit between the
// open project and the rest of the sidebar and a long column pushes it away.
const SESSIONS_SHOWN = 3;

const SESSION_HELP = "A conversation with Delphi's chat or with Claude Code, Codex or Copilot, working in this project's folder. " +
  "Everything it changes is recorded under its name.";

/**
 * The open project's sessions, indented under it so the column reads as one
 * tree rather than as two lists that happen to be stacked.
 *
 * Labelled, because a bare "Session 1" under a project told nobody what it
 * was, and each row says which agent and how long ago, because that is how a
 * person tells two of them apart.
 */
function sessionKids() {
  const kids = el("div", { className: "gkids" });
  const info = el("button", { className: "gs-info", type: "button", textContent: "i", title: SESSION_HELP });
  info.setAttribute("aria-label", `About AI sessions. ${SESSION_HELP}`);
  kids.append(el("div", { className: "gs-head" }, el("span", { textContent: "AI sessions" }), info));

  const addSession = el("div", { className: "gs sub", tabIndex: 0, role: "button" },
    el("span", { className: "nm dim", textContent: "+ New AI session" }));
  addSession.dataset.row = "sess-new";
  const start = async () => { await newSession(); navigate({ view: "chat" }); };
  addSession.onclick = start;
  addSession.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); start(); } };
  kids.append(addSession);

  const all = state.sessions;
  const showAll = state.sessionsAllFor === state.projectId || all.length <= SESSIONS_SHOWN;
  // Folded, the open conversation still shows, for the reason the open project
  // does under More projects: the sidebar never hides where you are.
  const shown = showAll ? all
    : all.filter((sn, i) => i < SESSIONS_SHOWN || sn.id === state.sessionId);

  for (const sn of shown) {
    const srow = el("div", {
      className: "gs sub sess" + (sn.id === state.sessionId && state.view === "chat" ? " on" : ""),
      tabIndex: 0, role: "button",
    });
    srow.dataset.row = "sess-" + sn.id;
    const when = sessionAgo(sessionLastActive(sn));
    // The agent is left out when the title already is its name, which is what
    // a tab in the chat strip is called until someone renames it.
    const agent = sessionAgent(sn);
    const meta = [agent === sn.title ? null : agent, when].filter(Boolean).join(" · ");
    srow.title = `${sn.title || "Session"}\n${meta}`;
    srow.append(
      el("span", { className: "sd" + (state.streaming && sn.id === state.sessionId ? " live" : "") }),
      el("span", { className: "gs-txt" },
        el("span", { className: "nm", textContent: sn.title || "Session" }),
        el("span", { className: "gs-meta", textContent: meta })),
    );

    const openS = async () => {
      if (state.view !== "chat") { state.sessionId = sn.id; navigate({ view: "chat" }); return; }
      await openSession(sn.id);
    };

    const more = el("button", { className: "srow-btn more", type: "button", textContent: "⋯", title: "Rename, archive or delete" });
    more.setAttribute("aria-label", `Actions for ${sn.title || "this session"}`);
    more.setAttribute("aria-haspopup", "menu");
    more.onclick = (e) => { e.stopPropagation(); sessionMenu(sn, more, e.detail === 0); };
    more.onkeydown = (e) => e.stopPropagation();

    srow.append(el("span", { className: "srow-acts" }, more));
    srow.onclick = openS;
    srow.ondblclick = (e) => { e.preventDefault(); renameSession(sn); };
    srow.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openS(); }
      // The keyboard's own way to a context menu, so the row's actions are not
      // only for people with a pointer.
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); sessionMenu(sn, more, true); }
    };
    srow.oncontextmenu = (e) => { e.preventDefault(); sessionMenu(sn, more, false, e.clientX, e.clientY); };
    kids.append(srow);
  }

  if (all.length > SESSIONS_SHOWN) {
    const hidden = all.length - shown.length;
    const toggle = el("div", { className: "gs sub gs-more", tabIndex: 0, role: "button" },
      el("span", { className: "nm dim", textContent: showAll ? "Show fewer" : `Show all ${all.length} (${hidden} more)` }));
    toggle.dataset.row = "sess-all";
    toggle.setAttribute("aria-expanded", String(showAll));
    const flip = () => { state.sessionsAllFor = showAll ? null : state.projectId; renderSidebar(); };
    toggle.onclick = flip;
    toggle.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } };
    kids.append(toggle);
  }

  // Archive is only a safe thing to offer if it can be undone, so what was
  // archived is one click from here, drawn faintly with Restore beside it.
  const archived = state.archivedSessions || [];
  if (archived.length) {
    const open = state.archivedOpenFor === state.projectId;
    const toggle = el("div", { className: "gs sub gs-more", tabIndex: 0, role: "button" },
      el("span", { className: "nm dim", textContent: open ? "Hide archived" : `Show archived (${archived.length})` }));
    toggle.dataset.row = "sess-archived";
    toggle.setAttribute("aria-expanded", String(open));
    const flip = () => { state.archivedOpenFor = open ? null : state.projectId; renderSidebar(); };
    toggle.onclick = flip;
    toggle.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } };
    kids.append(toggle);
    if (open) {
      for (const sn of archived) {
        const row = el("div", { className: "gs sub sess archived" });
        row.dataset.row = "arch-" + sn.id;
        const agent = sessionAgent(sn);
        const when = sessionAgo(sessionLastActive(sn));
        row.append(
          el("span", { className: "sd" }),
          el("span", { className: "gs-txt" },
            el("span", { className: "nm", textContent: sn.title || "Session" }),
            el("span", { className: "gs-meta", textContent: [agent === sn.title ? null : agent, when ? `archived, last used ${when}` : "archived"].filter(Boolean).join(" \u00b7 ") })));
        // A real button, always visible: it is the only thing the row does.
        const restore = el("button", { className: "srow-btn restore", type: "button", textContent: "Restore" });
        restore.setAttribute("aria-label", `Restore ${sn.title || "this session"}`);
        restore.dataset.act = "restore-" + sn.id;
        restore.onclick = () => restoreSession(sn);
        row.append(restore);
        kids.append(row);
      }
    }
  }
  return kids;
}

/** Puts an archived session back in the list, and focus on it, where it now is. */
async function restoreSession(session) {
  try { await window.delphi.sessions.restore(session.id); } catch (error) { alert(error.message); return; }
  // The last one out folds the archive, so the next archive starts folded.
  if ((state.archivedSessions || []).length <= 1) state.archivedOpenFor = null;
  await refresh();
  // Folded past three, the restored row may not be drawn; the list's first
  // row is then the nearest place for focus.
  // The list is in the top area's sessions menu now, or the old sidebar.
  const back = document.querySelector(`.sessions-pop [data-row="sess-${session.id}"], #projects [data-row="sess-${session.id}"]`) ||
    document.querySelector('.sessions-pop [data-row="sess-new"], #projects [data-row="sess-new"]');
  if (back) back.focus({ preventScroll: true });
}

/**
 * Up and down between rows, so a long list is not a long run of Tabs. Home and
 * End go to the ends. Anything else is left to the row that has focus.
 */
function sidebarArrows(e) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const rows = [...e.currentTarget.querySelectorAll('[role="button"][tabindex="0"]')];
  const at = rows.indexOf(document.activeElement);
  if (at < 0) return;
  e.preventDefault();
  const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1
    : Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
  rows[next].focus();
}


/** Renames a session. Shared by the row, the menu and the double click. */
async function renameSession(session) {
  const title = await askText({
    title: "Rename session",
    label: "What should this be called?",
    value: session.title || "",
    confirmLabel: "Rename",
  });
  if (!title) return;
  await window.delphi.sessions.update(session.id, { title });
  await refresh();
}

/** Lets go of a session the window is showing, before it disappears from under it. */
function dropOpenSession(session) {
  if (state.sessionId !== session.id) return;
  state.sessionId = null;
  state.messages = [];
}

// After a session row is gone its menu button is too, and focus would fall to
// the page; the list's first row is the nearest thing still there.
function focusSessions() {
  const next = document.querySelector('#projects [data-row="sess-new"]');
  if (next) next.focus({ preventScroll: true });
}

/**
 * Archives a session: out of the sidebar and the chat strip, kept whole.
 *
 * Not asked for first, because nothing is lost; the row is still in the
 * database with its messages, and History keeps its name.
 */
async function archiveSession(session) {
  try { await window.delphi.sessions.archive(session.id); } catch (error) { alert(error.message); return; }
  dropOpenSession(session);
  await refresh();
  focusSessions();
}

/**
 * Deletes a session and its messages, after asking.
 *
 * Only ever offered for one that changed nothing in Delphi (see sessionMenu),
 * and main.js refuses the rest anyway, so the question here is only about the
 * conversation itself.
 */
async function deleteSession(session) {
  const n = session.message_count || 0;
  const ok = confirm(
    `Delete "${session.title || "this session"}"?\n\n` +
    (n ? `Its ${n} message${n === 1 ? "" : "s"} go with it. ` : "It has no messages. ") +
    "This cannot be undone. Nothing on disk is touched."
  );
  if (!ok) return;
  try { await window.delphi.sessions.remove(session.id); } catch (error) { alert(error.message); return; }
  dropOpenSession(session);
  await refresh();
  focusSessions();
}


/**
 * The repository state for a workspace, under its sessions.
 *
 * Half of these folders are not repositories, so nothing is drawn at all in that
 * case rather than an empty shell explaining its own emptiness.
 */
async function paintGit(box, folder) {
  if (!folder) return;
  let g;
  try {
    g = await window.delphi.git.status(folder);
  } catch {
    return;
  }
  if (!g || !g.repo) return;
  box.textContent = "";

  const head = el("div", { className: "gf-head" });
  head.append(el("span", {
    className: "gf-branch",
    textContent: g.unborn ? "no commits yet" : g.detached ? "detached" : (g.branch || "unknown"),
    title: g.upstream ? `tracking ${g.upstream}` : "no upstream set",
  }));

  // Unknown and zero are different answers. Without an upstream there is nothing
  // to be ahead or behind of, and showing 0 would claim we had checked.
  if (g.ahead === null || g.behind === null) {
    head.append(el("span", { className: "gf-sync none", textContent: "no upstream" }));
  } else {
    head.append(el("span", { className: "gf-sync" + (g.ahead || g.behind ? " on" : "") },
      el("span", { textContent: `↑${g.ahead}` }), el("span", { textContent: `↓${g.behind}` })));
  }
  box.append(head);

  const row = el("div", { className: "gf-row" });
  if (g.clean) {
    row.append(el("span", { className: "hint", textContent: "nothing to commit" }));
  } else {
    row.append(el("span", { className: "gf-count", textContent: `${g.changed} uncommitted` }));
    const commit = el("button", { className: "btn sm", textContent: "Commit" });
    commit.onclick = async () => {
      const message = await askText({
        title: "Commit",
        label: `${g.changed} file${g.changed === 1 ? "" : "s"} in ${folder.split("/").pop()}. Everything changed is staged.`,
        placeholder: "What changed, and why",
        confirmLabel: "Commit",
      });
      if (!message) return;
      try {
        const made = await window.delphi.git.commit(folder, message, { all: true });
        await paintGit(box, folder);
        state.termLines.push({ kind: "meta", text: `committed ${made.short} ${made.subject}` });
      } catch (error) {
        // Straight from git, which says useful things: nothing staged, no
        // identity configured, a hook that refused.
        await askText({
          title: "That did not commit",
          label: String(error.message || error),
          value: "", allowEmpty: true, confirmLabel: "Close",
        });
      }
    };
    row.append(commit);
  }
  box.append(row);
}

/**
 * Rename, Archive and Delete for one session, hung from its ⋯ button or opened
 * at the pointer.
 *
 * Delete is offered only for a session History does not name. One that changed
 * things is the author of those rows, and deleting it would leave them
 * pointing at nothing, so the menu says why and offers Archive instead. Asked
 * when the menu opens rather than carried on every row, because it is a count
 * over the audit table and the sidebar repaints often.
 */
async function sessionMenu(session, button, fromKeyboard = false, x = null, y = null) {
  let changed = 0;
  try { changed = await window.delphi.sessions.changes(session.id); } catch { changed = 1; }
  const items = [
    { label: "Rename", run: async () => renameSession(session) },
    { label: "Archive", run: async () => archiveSession(session) },
  ];
  if (changed) {
    items.push("-", el("div", { className: "ctx-note",
      textContent: `Delete is not offered: History records ${plural(changed, "change", "changes")} by this session, ` +
        `and ${changed === 1 ? "it" : "they"} would lose ${changed === 1 ? "its" : "their"} author. Archive hides the session and keeps that record.` }));
  } else {
    items.push("-", { label: "Delete…", danger: true, run: async () => deleteSession(session) });
  }
  keyedMenu(button, items, { fromKeyboard, x, y });
}

/**
 * A row menu hung from a button, with the keyboard handling the Workbench
 * menus have: focus moves in, the arrows move through it, Escape closes it and
 * hands focus back to the button, and Tab leaves. At a point instead when the
 * menu came from a right click.
 */
function keyedMenu(button, items, { fromKeyboard = false, x = null, y = null } = {}) {
  const box = button && button.isConnected ? button.getBoundingClientRect() : null;
  const left = x != null ? x : box ? box.left : 0;
  const top = y != null ? y : box ? box.bottom + 4 : 0;
  if (button) button.setAttribute("aria-expanded", "true");
  const menu = rowMenu(left, top, items, {
    onClose: () => {
      if (!button) return;
      button.setAttribute("aria-expanded", "false");
      if (button.isConnected && (!document.activeElement || document.activeElement === document.body)) button.focus({ preventScroll: true });
    },
  });
  menu.setAttribute("role", "menu");
  const choices = [...menu.querySelectorAll(".ctx-item")];
  for (const c of choices) c.setAttribute("role", "menuitem");
  menu.addEventListener("keydown", (e) => {
    const at = choices.indexOf(document.activeElement);
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); closeRowMenu(); if (button && button.isConnected) button.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); choices[(at + 1) % choices.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); choices[(at - 1 + choices.length) % choices.length].focus(); }
    else if (e.key === "Tab") closeRowMenu();
  });
  if (fromKeyboard) choices[0]?.focus();
  else { menu.tabIndex = -1; menu.focus(); }
  return menu;
}

function projectRow(p) {
  const row = el("div", {
    className: "proj" + (state.projectId === p.id ? " active" : ""),
    tabIndex: 0,
    role: "button",
  });
  row.append(el("span", { className: "dot", style: `background:${safeColour(p.colour)}` }));
  row.append(el("span", { className: "proj-name", textContent: p.name, title: p.summary || p.name }));
  if (p.open_count) row.append(el("span", { className: "count", textContent: String(p.open_count) }));

  const go = () => {
    $("search").value = "";
    // Landing on a project shows its dashboard; All has no dashboard to show.
    navigate({ projectId: p.id, view: p.id ? "overview" : "new", query: "" });
  };
  row.onclick = go;
  // Only the row itself. The actions button inside it is a real button and its
  // keydown bubbles here: unguarded, Enter on it would open the menu and navigate
  // away from under it in one keypress, and Space would do only the navigating,
  // because the preventDefault below cancels the button's own activation.
  row.onkeydown = (e) => {
    if (e.target !== row) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
  };

  // All work is a heading pretending to be a row: there is no project behind it
  // to rename, recolour or delete, so it gets no menu and no button.
  if (p.id) {
    const more = el("button", { className: "proj-more", textContent: "⋯", title: "Project actions" });
    more.setAttribute("aria-label", `Actions for ${p.name}`);
    more.onclick = (e) => {
      e.stopPropagation();
      const box = more.getBoundingClientRect();
      projectMenu(p, box.left - 40, box.bottom + 4);
    };
    row.append(more);
    row.oncontextmenu = (e) => { e.preventDefault(); projectMenu(p, e.clientX, e.clientY); };
  }

  return row;
}

function renderTabs() {
  const box = $("tabs");
  box.textContent = "";
  // Runs and Needs you are places of their own, not tabs of All work.
  if (onHomeView()) return;

  const tabs = state.query
    ? [["oracle", "Oracle", state.oracleHits.length], ["tasks", "Matches", state.tasks.length + state.notes.length]]
    : state.projectId
    // "project" rather than "settings", because the All view's own Settings tab
    // already owns that key and the two would fall through to each other.
    ? [["overview", "Overview"], ["chat", "Chat", state.sessions.length],
       ["tasks", "Tasks", state.tasks.length],
       ["queue", "Queue"],
       ["pads", "Pads", state.pads.length],
       ["notes", "Memory", state.notes.length], ["links", "Links", state.links.length],
       // Called History at every level because it is one thing, the audit log,
       // narrowed or not. The key stays "activity" so the narrowed view keeps
       // its own renderer and the All view's "history" route is untouched.
       ["activity", "History"]]
    : state.workspaceId
    ? [["new", "What's new"], ["tasks", "Tasks", state.tasks.length],
       ["queue", "Queue"], ["graph", "Mind map"], ["activity", "History"]]
    : [["new", "What's new"], ["tasks", "Tasks", state.tasks.length],
       ["queue", "Queue"],
       ["graph", "Mind map"],
       ["reminders", "Reminders", liveAlerts(state.alerts).length],
       ["history", "History"], ["settings", "Settings"]];

  for (const [key, label, count] of tabs) {
    const tab = el("div", { className: "tab" + (state.view === key ? " active" : ""), tabIndex: 0, role: "tab" });
    tab.append(label);
    if (count) tab.append(el("span", { className: "n", textContent: String(count) }));
    const go = () => navigate({ view: key });
    tab.onclick = go;
    tab.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    box.append(tab);
  }
}

/**
 * The breadcrumb over a view outside the six tabs: where it belongs, then its
 * own name. Hidden for every other view, whose heading already says where it is.
 */
function paintCrumbs(place) {
  const box = $("crumbs");
  if (!box) return;
  box.textContent = "";
  box.hidden = !place;
  if (!place) return;
  const sep = () => { const s = el("span", { className: "crumb-sep", textContent: "/" }); s.setAttribute("aria-hidden", "true"); return s; };
  for (const c of place.crumbs) {
    if (c.target) {
      const b = el("button", { className: "crumb", type: "button", textContent: c.label });
      b.onclick = () => goTo({ ...c.target, query: "" });
      box.append(b);
    } else {
      box.append(el("span", { className: "crumb-now", textContent: c.label }));
    }
    box.append(sep());
  }
  const now = el("span", { className: "crumb-now here", textContent: place.title });
  now.setAttribute("aria-current", "page");
  box.append(now);
}

/**
 * Oracle or Matches, on the search page. The tab strip that offered both went
 * with the sidebar, which left the full Matches list (every task and note the
 * words hit) with no way in. Switching keeps the query: only the view changes.
 */
function paintSearchViews() {
  const box = $("tabs");
  if (!box) return;
  box.textContent = "";
  if (!state.query) return;
  const seg = el("div", { className: "seg search-views", role: "group" });
  seg.setAttribute("aria-label", "Show the search as");
  for (const v of DelphiCommands.searchViews(state)) {
    const b = el("button", { type: "button" }, v.label);
    if (v.count) b.append(el("span", { className: "n", textContent: String(v.count) }));
    b.setAttribute("aria-pressed", String(v.on));
    b.onclick = () => { if (!v.on) navigate(v.target); };
    seg.append(b);
  }
  box.append(seg);
}

function render() {
  // Direction B draws no sidebar and no tab strip here; the top area does
  // both (MOUNTS below). renderSidebar() and renderTabs() stay, unused, until
  // the cleanup slice, so going back is putting the two calls back.

  // A view that does not exist for the current selection falls back rather than
  // rendering blank. Before the heading, which is named for the view it settles on.
  const valid = state.query
    ? ["oracle", "tasks"]
    : state.projectId
    ? ["overview", "chat", "tasks", "queue", "pads", "notes", "links", "activity", "project", "workspace"]
    : state.workspaceId
    ? ["new", "tasks", "queue", "graph", "activity", "workspace"]
    : ["new", "tasks", "queue", "graph", "reminders", "history", "settings", ...HOME_VIEWS];
  if (!valid.includes(state.view)) state.view = valid[0];

  const p = currentProject();
  const place = DelphiCommands.heading(state, p ? p.name : "");
  paintCrumbs(place);
  paintSearchViews();
  if (state.query) {
    $("title").textContent = "Search";
    $("subtitle").textContent =
      `${plural(state.tasks.length, "task", "tasks")} and ${plural(state.notes.length, "note", "notes")} matching “${state.query}”`;
  } else if (place) {
    $("title").textContent = place.title;
    $("subtitle").textContent = place.subtitle;
  } else if (p) {
    $("title").textContent = p.name;
    $("subtitle").textContent = p.summary || "";
  } else if (state.view === "runs") {
    $("title").textContent = "Runs";
    $("subtitle").textContent = "Agents working for you, across every project. Each run has its own Workbench and its own live Sheet; open one to watch it.";
  } else if (state.view === "inbox") {
    $("title").textContent = "Needs you";
    $("subtitle").textContent = "What waits on you, across all projects: agents paused until you answer, finished runs to review, and proposals about where an item belongs. Answering here clears it everywhere.";
  } else {
    $("title").textContent = "All work";
    $("subtitle").textContent = "Everything open, across every project";
  }

  // Hidden rather than disabled when there is nowhere to go: a button that is
  // always present but usually dead trains people to stop looking at it.
  $("back").hidden = state.history.length === 0;
  $("back").title = `Back (${isMac() ? "Command" : "Ctrl"} + [)`;

  renderMetrics();
  paintTitleLive();

  // --- MOUNTS ---
  // Where render() hands a part of the window to its module under ui/. One
  // line per module, added by the slice that builds it, so two slices working
  // at once collide on a line rather than on a function.
  if (window.DelphiRecovery) DelphiRecovery.remember({ projectId: state.projectId, view: state.view });
  if (window.DelphiTopbar) DelphiTopbar.paint();
  if (window.DelphiAddFolder) DelphiAddFolder.paintFix(state);
  if (window.DelphiToday) DelphiToday.paint(state);
  // --- end MOUNTS ---

  // Replaced rather than emptied, so that a slow async view cannot paint into a
  // pane that has moved on. Several views await an IPC call before appending,
  // and two renders close together would otherwise both append to the one
  // element: the second finishes first, the first lands on top of it, and the
  // view appears twice. Anything still holding the old node now writes into a
  // detached element that nobody sees.
  const previous = $("content");

  // Where the reader was, kept across a repaint that is not a move.
  //
  // #content is the scrolling element and it is replaced rather than emptied, so
  // every render used to put you back at the top. That is invisible when a render
  // means "you went somewhere", and maddening when it means "a note you were not
  // looking at changed": renaming a note, an agent writing one, or a reminder
  // firing all call refresh(), and all of them threw away your place halfway down
  // a long note. Restored only when the position is unchanged, because arriving
  // at a new project or tab part way down would be worse than the problem.
  const staying = lastRenderedPosition && samePosition(position(), lastRenderedPosition);
  const previousScroll = staying ? previous.scrollTop : 0;
  lastRenderedPosition = position();

  const content = el("div", { className: previous.className, id: "content" });
  previous.replaceWith(content);
  const view = ({
    new: renderWhatsNew,
    oracle: renderOracle,
    overview: renderOverview,
    chat: renderChat,
    tasks: renderTasks,
    pads: renderPads,
    notes: renderNotes,
    links: renderLinks,
    queue: renderQueue,
    graph: renderMindMap,
    reminders: renderReminders,
    history: renderHistory,
    activity: renderActivity,
    project: renderProjectSettings,
    workspace: renderWorkspaceSettings,
    settings: renderSettings,
    runs: renderRuns,
    inbox: renderInbox,
    today: (root) => DelphiToday.render(root),
  })[state.view];

  // Several views are async. Without this, a throw inside one leaves an empty
  // pane and an unhandled rejection nobody sees, which looks like the feature was
  // never built rather than like a bug.
  if (typeof view !== "function") {
    // A view listed in the tabs but missing from the table above. Say which,
    // rather than reporting that some anonymous value is not a function.
    showViewError(content, new Error(`No renderer is registered for the "${state.view}" view`));
    return;
  }

  // Restored after the view has put its content in, since scrollTop on an empty
  // element is silently clamped to zero. Applied twice for the async views: once
  // when their promise settles, and once more on the next frame, because a view
  // that appends and then measures can still be growing when the promise
  // resolves.
  const restoreScroll = () => {
    if (!previousScroll || content !== $("content")) return;
    content.scrollTop = previousScroll;
    requestAnimationFrame(() => {
      if (content === $("content")) content.scrollTop = previousScroll;
    });
  };

  try {
    const result = view(content);
    if (result && typeof result.then === "function") {
      const done = spinWhile(content);
      result
        .then(() => { done(); restoreScroll(); })
        .catch((error) => { done(); showViewError(content, error); });
    } else {
      restoreScroll();
    }
  } catch (error) {
    showViewError(content, error);
  }
}

/**
 * Shows a spinner over a pane while something is loading, and returns the way to
 * stop it.
 *
 * Held back for a moment first. Most of these views resolve in a few
 * milliseconds, and a spinner that appears and vanishes inside one frame is a
 * flicker that reads as a fault rather than as progress. Only work that is
 * actually slow enough to notice gets announced, which in practice means the
 * settings page, where finding out what this machine can talk to means starting
 * login shells.
 *
 * The pane keeps whatever the view has already put in it, so a partly built page
 * dims rather than disappearing and coming back.
 */
function spinWhile(pane, { delay = 140 } = {}) {
  let node = null;
  let cancelled = false;

  const timer = setTimeout(() => {
    if (cancelled) return;
    node = el("div", { className: "pane-loading", role: "status" });
    node.setAttribute("aria-live", "polite");
    node.append(el("span", { className: "spinner" }), el("span", { textContent: "Loading" }));
    pane.append(node);
  }, delay);

  return () => {
    cancelled = true;
    clearTimeout(timer);
    if (node) node.remove();
  };
}

// Counts for whatever is selected. Shown in the header on every view so the
// state of the work is always visible, not only on the dashboard.
function renderMetrics() {
  const box = $("metrics");
  box.textContent = "";
  if (state.query || onHomeView()) return;

  const open = state.allTasks.filter((t) => t.status !== "done");
  const figures = [
    ["Open", open.length, null],
    ["Doing", open.filter((t) => statusOf(t) === "doing").length, "good"],
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
  const doing = open.filter((t) => statusOf(t) === "doing").length;

  // Summary first: what needs attention before what merely exists.
  const stats = el("div", { className: "stats" });

  /**
   * One tile. Given a destination it becomes a button; given none, or a count
   * of zero, it stays the flat card it was. Promising a view and then showing
   * an empty one is worse than not offering the link.
   */
  const stat = (value, label, tone, go) => {
    const live = typeof go === "function" && value > 0;
    const node = el(live ? "button" : "div", {
      className: "stat" + (tone ? ` ${tone}` : "") + (live ? " act" : ""),
    });
    node.append(
      el("div", { className: "v", textContent: String(value) }),
      el("div", { className: "k", textContent: label })
    );
    if (live) {
      node.type = "button";
      node.title = `Show ${label.toLowerCase()}`;
      node.onclick = go;
    }
    return node;
  };

  stats.append(
    stat(open.length, "Open", null, () => showTasks(null)),
    stat(doing, "In progress", doing ? "good" : null, () => showTasks("doing")),
    stat(blocked, "Blocked", blocked ? "warn" : null, () => showTasks("blocked")),
    stat(overdue, "Overdue", overdue ? "crit" : null, () => showTasks("overdue")),
    stat(state.notes.length, "Memory", null, () => navigate({ view: "notes" })),
    stat(done, "Done", null, () => showTasks("done"))
  );
  root.append(stats);

  const cols = el("div", { className: "cols" });
  const left = el("div");
  const right = el("div");

  // --- what to do next -----------------------------------------------------
  const priority = [...open].sort((a, b) => {
    const rank = (t) => (isOverdue(t) ? 0 : statusOf(t) === "doing" ? 1 : t.status === "blocked" ? 2 : 3);
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
      link.onclick = (e) => { e.preventDefault(); navigate({ view: "tasks" }); };
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
      link.onclick = (e) => { e.preventDefault(); navigate({ view: "notes" }); };
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
    const path = await askText({
      title: "Add a repository",
      label: "Choose the folder, or paste its absolute path.",
      placeholder: "/Users/you/code/project",
      confirmLabel: "Add",
      pickFolder: true,
    });
    if (!path) return;
    const name = path.trim().replace(/\/+$/, "").split("/").pop();
    await window.delphi.repos.create({
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
      const acts = el("div", { className: "repo-acts" });
      row.append(el("div", { className: "grow" },
        el("div", { textContent: r.name }),
        el("div", { className: "mono repo-path", textContent: r.path }),
        // Under the path rather than beside it: three buttons beside a path in
        // the narrow column left the path a few characters wide.
        acts));
      if (!r.is_primary) {
        const mk = el("button", { className: "btn sm", textContent: "Make primary" });
        mk.onclick = async () => { await window.delphi.repos.setPrimary(r.id); refresh(); };
        acts.append(mk);
      }
      const wbSet = el("button", { className: "btn sm", textContent: "Workbench settings" });
      wbSet.onclick = async () => { if (await repoWorkbenchSettings(r)) refresh(); };
      acts.append(wbSet);
      const rm = el("button", { className: "btn sm", textContent: "Remove" });
      rm.onclick = async () => { await window.delphi.repos.remove(r.id); refresh(); };
      acts.append(rm);
      flush.append(row);
    });
    repoCard.card.append(flush);
  }
  right.append(repoCard.card);

  // --- workbenches ---------------------------------------------------------
  // The tasks with a folder and branch of their own, and how each one stands.
  // Each row opens its task, which is where the verbs are.
  let benches = [];
  try { benches = await window.delphi.workbench.list({ projectId: project.id }); } catch (error) { console.error("workbench list", error); }
  const benchCard = card("Workbenches");
  if (!benches.length) {
    benchCard.body.append(emptyState("No Workbenches yet", "Start one from a task."));
  } else {
    benchCard.card.querySelector(".card-head").append(el("span", { className: "ts-count", textContent: String(benches.length) }));
    benchCard.body.remove();
    const flush = el("div", { className: "card-body flush" });
    for (const wb of benches) {
      // The title is the row's one way in for the keyboard, a button of its
      // own, so Update beside it is a separate control and not a button
      // inside a button. A click anywhere else on the row still opens it.
      const row = el("div", { className: "list-row clickable wb-row" });
      const open = el("button", { className: "wb-row-title wb-row-open", type: "button", textContent: wb.task_title });
      open.setAttribute("aria-label", `Open task ${wb.task_id}, ${wb.task_title}: ${wbLook(wb).words}`);
      open.onclick = (e) => { e.stopPropagation(); openTaskSheet(wb.task_id); };
      row.append(el("div", { className: "grow" },
        open,
        el("div", { className: "wb-row-sub" },
          el("span", { className: "mono", textContent: wb.branch }),
          wb.task_status === "done" ? el("span", { className: "wb-flag", textContent: "task is done" }) : null)),
        wbChip(wb, async (act) => {
          act.disabled = true;
          await wbGuard(wb.task_id, () => wbUpdate(wb));
          refresh();
        }));
      row.onclick = (e) => { if (!e.target.closest("button")) openTaskSheet(wb.task_id); };
      flush.append(row);
    }
    benchCard.card.append(flush);
  }
  // In the wide column, after what needs attention: a row carries a title, a
  // branch and a sentence of status, and the narrow one wrapped all three.
  left.insertBefore(benchCard.card, memCard.card);

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
      a.onclick = (e) => { e.preventDefault(); window.delphi.openExternal(l.url); };
      row.append(a);
      flush.append(row);
    });
    linkCard.card.append(flush);
  }
  right.append(linkCard.card);
  if (window.DelphiLedger) right.append(DelphiLedger.projectCard(project.id));

  // --- handoffs ------------------------------------------------------------
  // Work one agent has handed to another. Here rather than on its own tab
  // because it is not a place you go, it is a thing you notice: most of the time
  // there is nothing in it, and when there is, it is either running or waiting
  // for somebody to read the answer.
  const handoffs = await window.delphi.handoffs.list({ projectId: project.id, limit: 8 })
    .catch(() => []);
  if (handoffs.length) {
    const hCard = card("Between agents");
    for (const h of handoffs) {
      const row = el("div", { className: "hoff" });
      row.append(el("span", { className: `hoff-s ${h.status}`, textContent: h.status }));
      const body = el("div", { className: "grow" });
      body.append(el("div", { className: "hoff-t",
        textContent: `${h.from_harness || "you"} → ${h.to_harness}` }));
      body.append(el("div", { className: "hint", textContent: h.request.slice(0, 120) }));
      // The reply is the point of the row, so it is shown rather than hidden
      // behind a click. Trimmed, because some of them are an essay.
      if (h.reply && (h.status === "ready" || h.status === "harvested" || h.status === "failed")) {
        body.append(el("div", { className: "hoff-r", textContent: h.reply.slice(0, 400) }));
      }
      row.append(body);
      if (h.to_session_id) {
        const open = el("button", { className: "btn sm", textContent: "Open" });
        open.onclick = async () => {
          await goTo({ projectId: project.id, view: "chat" });
          await openSession(h.to_session_id);
        };
        row.append(open);
      }
      if (h.status === "queued" || h.status === "running") {
        const stop = el("button", { className: "btn sm", textContent: "Cancel" });
        stop.onclick = async () => { await window.delphi.handoffs.cancel(h.id); refresh(); };
        row.append(stop);
      }
      hCard.body.append(row);
    }
    right.append(hCard.card);
  }

  // --- project settings ----------------------------------------------------
  // The editor itself moved to its own tab. It used to be a form at the bottom of
  // this column, which is a strange place to keep the only way to rename or
  // archive a project, and it left nowhere to put anything larger.
  const setCard = card("Project settings");
  setCard.body.append(el("div", { className: "row" },
    el("div", { className: "grow hint",
      textContent: "Name, summary, colour, status, how tasks are laid out, and deleting the project." }),
    (() => {
      const b = el("button", { className: "btn sm", textContent: "Open" });
      b.onclick = () => navigate({ view: "project" });
      return b;
    })()));
  right.append(setCard.card);

  cols.append(left, right);
  root.append(cols);
}

// ---------------------------------------------------------------------------
// Project settings
//
// Everything that is true of the project rather than of anything in it, in one
// place. Before this there were two unconnected surfaces: a form at the bottom of
// the Overview's right column, and the layout picker inside the Tasks tab, which
// writes a column on the same row and never mentioned the other.
//
// Built as .setting sections rather than a dl of labels, because most of these
// choices need a sentence to be safe to make: what archiving does, why the key
// cannot change, and what a delete takes with it.
// ---------------------------------------------------------------------------

const PROJECT_STATUSES = ["active", "paused", "blocked", "done", "archived"];

// The colours a project can be given without opening the picker. Free hex is
// still allowed, and the Settings pane still offers the full picker: this is the
// short list the sidebar menu shows, and the same list a new project is dealt
// from, so the two cannot drift into two different ideas of what a project looks
// like. Six, because that is one row of swatches at the width of a menu.
const PROJECT_COLOURS = ["#4a63d8", "#e0803a", "#2f8757", "#a86fd1", "#c9546b", "#3fa7a1"];

// What a project's status is called when it is being offered rather than listed.
// The select in Settings shows the bare word because the label above it says what
// the word is about; a menu item has to carry that context itself.
const PROJECT_STATUS_VERB = {
  active: "Mark active",
  paused: "Mark paused",
  blocked: "Mark blocked",
  done: "Mark done",
};

// Set by the archive gesture and cleared by the settings pane that honours it.
// Archiving sends you to Settings, and the archive is the last section of a long
// page: arriving at the top of it is arriving somewhere that looks unrelated to
// what you just did. One shot, because scrolling there on every later visit to
// Settings would be the opposite problem.
let revealArchived = false;

/**
 * Archives a project, having agreed it first. Answers true if it went ahead.
 *
 * Shared by the Settings pane and the sidebar menu because the two used to be
 * one gesture written once: the warning, the write and the move afterwards are
 * all part of the same promise, and a second copy of it in the menu is a second
 * copy that can be reworded without the first one noticing.
 *
 * Where it lands depends on where the archiving happened. Archiving the project
 * you are looking at has to move you, since the pane underneath is about to be
 * describing a project no list will admit exists, and Settings is where it went.
 * Archiving some other project from the sidebar moves nothing: being yanked out
 * of the project you were working in is a worse surprise than the row quietly
 * leaving the list you were not reading.
 */
async function archiveProject(project) {
  const leaving = state.projectId === project.id;
  const ok = confirm(
    `Archive “${project.name}”?\n\n` +
    "It leaves the project switcher and every list, and nothing in it is deleted: the tasks, notes, links and epics all stay exactly as they are.\n\n" +
    (leaving
      ? "You will land on Settings, under All work, where archived projects are listed with a button to bring each one back.\n\n"
      : "Archived projects are listed under Settings, in All work, with a button to bring each one back.\n\n") +
    "If what you want is for it to be gone rather than out of the way, delete it instead. That can be reversed from History."
  );
  if (!ok) return false;

  await window.delphi.projects.update(project.id, { status: "archived" });
  if (leaving) {
    state.projectId = null;
    state.view = "settings";
    revealArchived = true;
  }
  await refresh();
  return true;
}

/** A heading, a sentence saying what the choice means, then the control. */
function settingSection(heading, explanation, ...controls) {
  const box = el("div", { className: "setting" });
  box.append(el("h3", { textContent: heading }));
  box.append(el("p", { textContent: explanation }));
  controls.filter(Boolean).forEach((c) => box.append(c));
  return box;
}


// A small set rather than a full emoji picker. These are the shapes a folder of
// work actually is, and a short list you can scan beats a search box you have to
// think of a word for.
const WORKSPACE_ICONS = [
  "◆", "●", "▲", "■", "★", "✦", "⬢", "◈",
  "🗂", "📦", "🧭", "🛠", "⚙️", "🧪", "📊", "🔌",
  "🚀", "🩺", "🏛", "📄", "🔐", "🌐", "🧩", "💾",
];

/**
 * The workspace's own settings.
 *
 * Reached from the sidebar rather than from the row of tabs. Those tabs are
 * views of the work; this is the folder's configuration, and it is the only
 * place the letter on the rail tile can be replaced with something chosen.
 */
function renderWorkspaceSettings(root) {
  const workspace = state.workspaces.find((w) => w.id === state.workspaceId);
  if (!workspace) {
    root.append(emptyState("No workspace open", "Pick one from the rail first."));
    return;
  }

  const live = () => state.workspaces.find((w) => w.id === state.workspaceId) || workspace;

  // --- name ----------------------------------------------------------------
  const nameInput = el("input", { className: "field", value: workspace.name });
  nameInput.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); nameInput.blur(); } };
  nameInput.onblur = async () => {
    const value = nameInput.value.trim();
    const now = live();
    if (!value) { nameInput.value = now.name; return; }
    if (value === now.name) return;
    await window.delphi.workspaces.update(now.id, { name: value });
    await refresh();
  };
  root.append(settingSection("Name",
    "What this folder is called here. The folder on disk keeps its own name; this is only what Delphi shows.",
    el("div", { className: "row" }, nameInput)));

  // --- icon ----------------------------------------------------------------
  const grid = el("div", { className: "icon-grid" });
  const paintIcons = () => {
    grid.textContent = "";
    const now = live();

    // The letter is a choice too, not the absence of one, so it sits in the grid
    // as the first option rather than being what you get by clearing something.
    const letter = el("button", {
      className: "icon-opt" + (now.icon ? "" : " on"),
      type: "button",
      title: "Use the first letter",
      textContent: railLetter(now.name),
    });
    letter.onclick = async () => {
      await window.delphi.workspaces.update(now.id, { icon: null });
      await refresh();
    };
    grid.append(letter);

    for (const icon of WORKSPACE_ICONS) {
      const opt = el("button", {
        className: "icon-opt" + (now.icon === icon ? " on" : ""),
        type: "button",
        textContent: icon,
        title: icon,
      });
      opt.onclick = async () => {
        await window.delphi.workspaces.update(now.id, { icon });
        await refresh();
      };
      grid.append(opt);
    }
  };
  paintIcons();
  root.append(settingSection("Icon",
    "What shows on the rail. Pick one, or keep the first letter of the name.",
    grid));

  // --- folder --------------------------------------------------------------
  const folderRow = el("div", { className: "row" });
  const now = live();
  folderRow.append(el("span", { className: "mono grow", textContent: now.path, title: now.path }));
  const there = el("span", { className: "hint", textContent: "checking…" });
  folderRow.append(there);
  window.delphi.fs.folderExists(now.path).then((ok) => {
    there.className = ok ? "ok-msg" : "err-msg";
    there.textContent = ok ? "found" : "missing";
  }).catch(() => { there.textContent = ""; });
  const reveal = el("button", { className: "btn sm", textContent: "Reveal" });
  reveal.onclick = () => window.delphi.fs.reveal(now.path);
  folderRow.append(reveal);
  root.append(settingSection("Folder",
    "Where this workspace is on disk. It is fixed: a workspace is its folder, so pointing it somewhere else would make it a different workspace.",
    folderRow));

  // --- projects ------------------------------------------------------------
  const list = el("div", { className: "row wrap" });
  if (!state.wsProjects.length) {
    list.append(el("span", { className: "hint", textContent: "No projects here yet." }));
  }
  for (const p of state.wsProjects) {
    const chip = el("span", { className: "chip", textContent: p.name, title: "Open this project" });
    chip.onclick = () => navigate({ projectId: p.id, view: "overview" });
    list.append(chip);
  }
  root.append(settingSection("Projects",
    "The work happening in this folder. A project can also belong to other workspaces, which is set from the project's own settings.",
    list));

  // --- remove --------------------------------------------------------------
  const danger = el("button", { className: "btn danger", textContent: "Remove this workspace" });
  danger.onclick = async () => {
    // Worth spelling out. "Remove" beside a folder reads as deleting one, and
    // this deletes nothing on disk and keeps every project that used it.
    const ok = confirm(
      `Remove ${live().name} from Delphi?\n\n` +
      "The folder on disk is not touched, and projects that also live in other " +
      "workspaces keep working. Only the link from Delphi to this folder goes."
    );
    if (!ok) return;
    await window.delphi.workspaces.remove(live().id);
    await zoomOut();
  };
  root.append(settingSection("Remove",
    "Forgets this folder. Nothing on disk is deleted and no project is deleted; only the workspace and its links go.",
    el("div", { className: "row" }, danger)));
}

function renderProjectSettings(root) {
  const project = currentProject();
  if (!project) return;

  // Every handler re-reads the project rather than closing over this one. The
  // node lives as long as the pane does and refresh() replaces the row underneath
  // it, so a comparison against the captured copy is against a stale value: the
  // second edit in a sitting was the one that silently did nothing.
  const save = async (fields, msg) => {
    const live = currentProject();
    if (!live) return;
    try {
      await window.delphi.projects.update(live.id, fields);
    } catch (error) {
      // Only failures say anything. A success repaints this pane, so a "Saved"
      // written here would be discarded in the same frame; the new name in the
      // sidebar and the title is the confirmation, and it is a better one.
      if (msg) { msg.className = "err-msg"; msg.textContent = error.message; }
      return;
    }
    await refresh();
  };

  // Enter commits. The old form saved on blur alone, so pressing Enter appeared
  // to do nothing and hiding the window with the field still focused lost the
  // rename outright.
  const commitOnEnter = (input) => {
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } };
    return input;
  };

  // --- name ----------------------------------------------------------------
  const nameMsg = el("span", { className: "hint" });
  const nameInput = commitOnEnter(el("input", { className: "field", value: project.name }));
  nameInput.onblur = () => {
    const live = currentProject();
    const value = nameInput.value.trim();
    if (!value) { nameInput.value = live ? live.name : ""; return; }
    if (!live || value === live.name) return;
    save({ name: value }, nameMsg);
  };
  root.append(settingSection("Name",
    "What this project is called everywhere it appears: the project switcher, the title, and any task that belongs to it.",
    el("div", { className: "row" }, nameInput), nameMsg));

  // --- folder ----------------------------------------------------------------
  // The project's folder: where its jobs, runs, Workbenches and sessions work,
  // and the one place it is written (db.js updateProject). One folder is one
  // project's, so choosing a folder another project has is refused by name.
  // The refusal a job gives when a project has none sends people here, so it
  // has to be here.
  const folderMsg = el("span", { className: "hint" });
  const folderInput = commitOnEnter(el("input", { className: "field", value: project.path || "", placeholder: "/path/to/the/code" }));
  folderInput.onblur = () => {
    const live = currentProject();
    const value = folderInput.value.trim();
    if (!live || value === (live.path || "")) return;
    save({ path: value || null }, folderMsg);
  };
  const folderPick = el("button", { className: "btn", type: "button", textContent: "Choose folder…" });
  folderPick.onclick = async () => {
    try {
      const picked = await window.delphi.dialog.pickFolder("The project's folder");
      if (!picked) return;
      folderInput.value = picked;
      save({ path: picked }, folderMsg);
    } catch (error) { folderMsg.className = "err-msg"; folderMsg.textContent = error.message; }
  };
  const folderFacts = el("div", { className: "hint" });
  if (project.path) {
    folderFacts.textContent = [project.owner_repo || null, project.default_branch ? `default branch ${project.default_branch}` : null,
      project.folder_missing ? "not on disk right now" : null].filter(Boolean).join(" · ");
  }
  const folderBox = settingSection("Folder",
    "Where agents work on this project: its jobs, its runs and its sessions. A run that changes code still gets its own Workbench beside it; one that only answers reads from here. A folder belongs to one project.",
    el("div", { className: "row" }, folderInput, folderPick), folderFacts, folderMsg);
  folderBox.id = "project-folder";
  root.append(folderBox);

  // --- summary -------------------------------------------------------------
  const sumMsg = el("span", { className: "hint" });
  const sumInput = commitOnEnter(el("input", {
    className: "field",
    value: project.summary || "",
    placeholder: "One line: what this project is",
  }));
  sumInput.onblur = () => {
    const live = currentProject();
    if (!live || sumInput.value.trim() === (live.summary || "")) return;
    save({ summary: sumInput.value.trim() }, sumMsg);
  };
  root.append(settingSection("Summary",
    "One line, shown under the title, and in the project switcher when the project has no folder. Leave it empty if the name says enough.",
    el("div", { className: "row" }, sumInput), sumMsg));

  // --- key -----------------------------------------------------------------
  root.append(settingSection("Key",
    "The short slug this project is known by outside the window: to the agent tools, to the markdown vault, and to anything that imported work into it. It is fixed once the project exists, because everything already pointing at it would be pointing at nothing.",
    el("div", { className: "row" }, el("span", { className: "mono", textContent: project.key }))));

  // --- colour --------------------------------------------------------------
  const colourMsg = el("span", { className: "hint" });
  const colour = el("input", {
    type: "color", className: "field field-colour", value: project.colour || "#8d97a9",
  });
  // Chromium fires change on a colour input over and over while the picker is
  // being dragged, not once when it is put away. Saving on each one wrote a row
  // into the project's history for every shade passed through on the way to the
  // one wanted, and repainted this pane under the open picker while doing it, so
  // the write waits for the dragging to stop.
  let colourTimer;
  const commitColour = () => {
    const live = currentProject();
    // The timer can outlive the pane that started it. Without this, settling on a
    // colour and immediately switching projects paints the wrong one.
    if (!live || live.id !== project.id) return;
    if (colour.value === (live.colour || "")) return;
    save({ colour: colour.value }, colourMsg);
  };
  const queueColour = () => {
    clearTimeout(colourTimer);
    colourTimer = setTimeout(commitColour, 600);
  };
  colour.oninput = queueColour;
  colour.onchange = queueColour;
  root.append(settingSection("Colour",
    "The square beside this project in the project switcher, and the flash of colour on its tasks wherever they appear next to another project's.",
    el("div", { className: "row" }, colour, colourMsg)));

  // --- status --------------------------------------------------------------
  const statusMsg = el("span", { className: "hint" });
  const statusSel = el("select", { className: "field" });
  for (const s of PROJECT_STATUSES) {
    statusSel.append(el("option", { value: s, textContent: s, selected: s === project.status }));
  }
  statusSel.onchange = async () => {
    const live = currentProject();
    if (!live) return;
    const value = statusSel.value;
    // Archiving takes the project out of every list, this pane included, so the
    // move away happens inside archiveProject rather than leaving the pane
    // rendering a project the next refresh will not know about. The select is put
    // back by hand when the warning is declined, because a select that has already
    // repainted itself is showing a status nothing was ever told about.
    if (value === "archived") {
      const done = await archiveProject(live);
      if (!done) statusSel.value = live.status;
      return;
    }
    save({ status: value }, statusMsg);
  };
  root.append(settingSection("Status",
    "Where this project stands. The first four are labels and change nothing else. Archived is the exception: it hides the project everywhere, out of the way rather than gone. Archived projects are listed under Settings in All work, and restoring one from there puts it back as it was.",
    el("div", { className: "row" }, statusSel, statusMsg)));

  // --- task view -----------------------------------------------------------
  const viewSel = el("select", { className: "field" });
  const TASK_VIEW_LABELS = {
    list: "List, one column top to bottom",
    table: "Table, a row per task",
    columns: "Columns, one per status, side by side",
    board: "Board, one column per status, drag to move",
    calendar: "Calendar, tasks on the day they are due",
  };
  for (const [id, label] of Object.entries(TASK_VIEW_LABELS)) {
    viewSel.append(el("option", { value: id, textContent: label, selected: id === taskViewMode() }));
  }
  viewSel.onchange = () => setTaskViewMode(viewSel.value);
  root.append(settingSection("How tasks are laid out",
    "Remembered on the project rather than as a global preference, because a project with four tasks and one with forty want different answers. The picker above the task list writes the same choice.",
    el("div", { className: "row" }, viewSel)));

  // --- danger zone ---------------------------------------------------------
  const del = el("button", { className: "btn danger", textContent: "Delete this project…" });
  const delMsg = el("span", { className: "hint" });
  del.onclick = async () => {
    const live = currentProject();
    if (!live) return;
    await destroyProject(live, (error) => {
      delMsg.className = "err-msg";
      delMsg.textContent = error.message;
    });
  };
  // --- agents ----------------------------------------------------------------
  // Both off by default and both only ever set from this window: the MCP
  // server cannot write either, so no agent can approve its own work by
  // changing them. Each says what turning it on gives away, in the place it
  // is turned on, rather than in a document nobody reads first.
  const perms = el("div", { className: "setting", id: "agent-perms" });
  perms.append(el("h3", { textContent: "Agents" }),
    el("p", { textContent: "What agents may do in this project without asking you first. Work you hand to an agent yourself always starts straight away." }));
  const permRow = (key, label, off, on, confirmOn = null) => {
    const live = currentProject() || project;
    const checked = Number(live[key]) === 1;
    const id = `perm-${key}`;
    const row = el("div", { className: "agent-perm" + (checked ? " on" : "") });
    const box = el("input", { type: "checkbox", checked, id });
    const say = el("div", { className: "warn-say", textContent: checked ? on : off });
    const msg = el("span", { className: "hint" });
    box.onchange = async () => {
      if (box.checked && confirmOn) {
        const ok = await wbDialog({
          title: confirmOn.title, lead: confirmOn.lead,
          actions: [{ label: "Keep it off", value: false }, { label: confirmOn.yes, kind: "danger", value: true }],
          cancelValue: false,
        });
        if (!ok) { box.checked = false; return; }
      }
      await save({ [key]: box.checked }, msg);
    };
    row.append(box, el("div", {}, el("label", { className: "lbl", htmlFor: id, textContent: label }), say, msg));
    return row;
  };
  perms.append(
    permRow("auto_approve", "Let agents start work without asking",
      "Off: when an agent hands work to another agent here, it waits in Needs you until you approve it.",
      "On: an agent can set other agents working in this project, and you see it in Runs rather than being asked. Delphi still stops a project that runs away with itself after 12 jobs in an hour."),
    permRow("allow_unguarded", "Allow agents without Delphi's safety guard",
      "Off: an agent changes code here only with something checking its commands first: Claude Code with agent/guard.py installed, or Codex in its sandbox. Copilot is refused.",
      "On: Copilot, and Claude Code without the guard, may run commands that nothing checks first, so an irreversible one (a force push, a deleted folder) would not be stopped. Each run still works only in its own Workbench.",
      { title: "Allow agents without the safety guard?",
        lead: "Copilot, and Claude Code without agent/guard.py, would run commands in this project's Workbenches with nothing checking them first. A force push or a deleted folder would not be stopped. Turn this on only if you accept that for this project.",
        yes: "Allow it" }),
  );
  root.append(perms);

  root.append(settingSection("Misfiled items",
    "Looks through this project for notes, tasks and pads that seem to belong somewhere else, and proposes each move in Needs you. It flags; nothing moves until you approve it.",
    el("div", { className: "row" }, sweepButton(project.id))));

  root.append(settingSection("Delete this project",
    "Removes the project and, unless you say otherwise, hands its tasks back to All work. Everything it holds is copied first, so the whole thing can be put back from History afterwards.",
    el("div", { className: "row" }, del, delMsg)));
}

/**
 * Deletes a project, having agreed it first. Answers true if it went ahead.
 *
 * Shared by the Settings pane and the sidebar menu, for the same reason
 * archiveProject is: the counting, the agreement and the sentence said afterwards
 * are one gesture, and the second copy of it is the one that would quietly stop
 * offering the choice about the tasks.
 *
 * Where it lands is decided the same way too. Only the project on screen forces a
 * move; deleting some other project from the sidebar leaves you where you were.
 *
 * onError is passed in because the two callers have different places to put a
 * failure: the pane has a message line under its button, and a menu that has
 * already closed has nowhere at all.
 */
async function destroyProject(project, onError = (error) => alert(error.message)) {
  // Counted when the delete is asked for rather than when the pane was drawn. An
  // agent adds tasks while a settings pane sits open, and a confirmation quoting
  // numbers from ten minutes ago is worse than one quoting none.
  let counts = await window.delphi.projects.contents(project.id);
  // Items other projects still show go first, or not at all (owner decision
  // D7): a delete would take them from those projects too.
  if (counts.shared_out) {
    if (!(await rehomeBeforeDelete(project, counts))) return false;
    counts = await window.delphi.projects.contents(project.id);
  }
  const choice = await confirmDestroy({ project, counts });
  if (!choice) return false;
  try {
    const r = await window.delphi.projects.remove(project.id, { tasks: choice.tasks });
    if (state.projectId === project.id) {
      state.projectId = null;
      state.view = "new";
    }
    await refresh();
    // Said after the move, on the view that is now on screen, because the pane
    // that raised it has been replaced by then.
    alert(`“${r.name}” is gone. Reverse it from History if that was wrong.`);
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

/**
 * Agrees to a project delete, in proportion to what is being lost.
 *
 * confirm() is enough for an epic, which loses a shell. This loses a body of
 * work, so it says what is in it rather than asking in the abstract, makes the
 * fate of the tasks an explicit choice rather than a surprise, and asks for the
 * key to be typed: the point is to make it impossible to do by reflex, and the
 * key is short, immutable and printed a few lines above on the same pane.
 *
 * Escape is captured on the document exactly the way askText captures it. The
 * window-level handler treats Escape as "hide the window", so without this the
 * whole app disappears rather than the dialog.
 */
function confirmDestroy({ project, counts }) {
  return new Promise((resolve) => {
    const parts = [
      [counts.tasks, "task", "tasks"],
      [counts.notes, "note", "notes"],
      [counts.links, "link", "links"],
      [counts.organizers, "epic", "epics"],
      [counts.repos, "repository", "repositories"],
    ].filter(([n]) => n > 0).map(([n, one, many]) => plural(n, one, many));

    const holds = parts.length
      ? `It holds ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`}.`
      : "It is empty.";

    const overlay = el("div", { className: "overlay" });
    const box = el("div", { className: "ask" });

    const me = {};
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      const at = dialogStack.indexOf(me);
      if (at >= 0) dialogStack.splice(at, 1);
      overlay.remove();
      resolve(result);
    };

    box.append(el("h3", { textContent: `Delete “${project.name}”?` }));
    box.append(el("p", { textContent: holds }));

    // What happens to the tasks, spelled out under each option rather than left
    // to be discovered afterwards. Keeping them is the default because it is the
    // one that loses nothing, and because it is what the schema does anyway.
    let mode = "keep";
    const choices = el("div", { className: "destroy-choices" });
    if (counts.tasks) {
      for (const [value, label, detail] of [
        ["keep", "Keep the tasks",
         "They move to All work with no project, and stay in search, in the queue and on their reminders."],
        // Subtasks that were moved into another project still go with their
        // parent, because the cascade follows parent_id rather than project_id.
        // Said out loud here: it is the only part of the loss that lands outside
        // the project being deleted, so it is the part nobody expects.
        ["delete", "Delete the tasks too",
         "The work goes with the project, along with its comments, its history and any reminders set on it." +
         (counts.subtasks_elsewhere
           ? ` This includes ${plural(counts.subtasks_elsewhere, "subtask", "subtasks")} now filed under another project.`
           : "")],
      ]) {
        const id = `destroy-${value}`;
        const radio = el("input", { type: "radio", name: "destroy-tasks", id, value, checked: value === mode });
        radio.onchange = () => { if (radio.checked) mode = value; };
        const row = el("label", { className: "destroy-choice", htmlFor: id },
          radio,
          el("span", {},
            el("span", { className: "destroy-choice-label", textContent: label }),
            el("span", { className: "hint", textContent: detail })));
        choices.append(row);
      }
      box.append(choices);
    }

    const ok = el("button", { className: "btn danger", textContent: "Delete", type: "button", disabled: true });
    const input = el("input", {
      className: "field", type: "text", placeholder: project.key, spellcheck: false,
    });
    input.oninput = () => { ok.disabled = input.value.trim() !== project.key; };
    box.append(el("p", { className: "hint" },
      "Type the project key ", el("span", { className: "mono", textContent: project.key }), " to confirm."));
    box.append(input);

    const cancel = el("button", { className: "btn", textContent: "Cancel", type: "button" });
    cancel.onclick = () => finish(null);
    ok.onclick = () => { if (!ok.disabled) finish({ tasks: mode }); };

    const onKey = (event) => {
      if (dialogStack[dialogStack.length - 1] !== me) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (!ok.disabled) finish({ tasks: mode });
      }
    };
    dialogStack.push(me);
    document.addEventListener("keydown", onKey, true);

    const actions = el("div", { className: "ask-actions" });
    actions.append(cancel, ok);
    box.append(actions);

    overlay.append(box);
    overlay.onclick = (event) => { if (event.target === overlay) finish(null); };
    document.body.append(overlay);
    input.focus();
  });
}

/**
 * The menu a sidebar project row offers, from right click and from its ⋯ button.
 *
 * The project row was the last row type in the app with no menu on it, so every
 * change to a project meant selecting it first and then finding the Settings tab,
 * including the changes that are one word long. The short ones live here and the
 * ones that need a sentence of explanation stay on the pane, which is what
 * Settings is for and why this ends with a way into it.
 *
 * Everything acts on the project the menu was opened over, not on the selected
 * one. Renaming a project you are not in is the ordinary case from a sidebar, and
 * a menu that quietly retargeted itself at whatever is on screen would be the
 * worst kind of wrong.
 */
function projectMenu(p, x, y, button = null, fromKeyboard = false) {
  const set = async (fields) => {
    try {
      await window.delphi.projects.update(p.id, fields);
    } catch (error) {
      // No message line to write into: the menu is gone by the time this runs.
      alert(error.message);
      return;
    }
    await refresh();
  };

  const rename = async () => {
    const name = await askText({
      title: "Rename project",
      label: "What this project is called everywhere it appears. The key it is known by outside the window does not change.",
      value: p.name,
      confirmLabel: "Rename",
    });
    if (!name || name.trim() === p.name) return;
    await set({ name: name.trim() });
  };

  const describe = async () => {
    const summary = await askText({
      title: "Describe project",
      label: "One line: what this project is. Leave it empty to clear it.",
      value: p.summary || "",
      confirmLabel: "Save",
      allowEmpty: true,
    });
    if (summary === null) return;
    if (summary.trim() === (p.summary || "")) return;
    await set({ summary: summary.trim() || null });
  };

  // The status the project already has is left out rather than shown ticked,
  // because a menu item that does nothing is indistinguishable from one that
  // failed. Archived is not among them: it is not another label, it takes the
  // project out of every list, so it goes below the line with its own warning.
  const statuses = PROJECT_STATUSES
    .filter((s) => s !== "archived" && s !== p.status)
    .map((s) => ({ label: PROJECT_STATUS_VERB[s], run: () => set({ status: s }) }));

  const pinned = state.pinned.includes(p.id);
  // Hide and Show only where they mean something. A pinned project is above
  // both groups, and a project that is merely quiet is not hidden, so there is
  // nothing to show; pinning is how to keep one of those in sight.
  const groups = sidebarGroups();
  const where = groups.groupOf(p);
  const shelf = where === "active"
    ? [{ label: "Hide from Active", run: () => setHidden(p.id, true) }]
    : where === "rest" && groups.stillHidden(p)
    ? [{ label: "Show in Active", run: () => setHidden(p.id, false) }]
    : [];
  const items = [
    { label: pinned ? "Unpin" : "Pin to the top", run: () => setPinned(p.id, !pinned) },
    ...shelf,
    "-",
    { label: "Rename", run: rename },
    { label: p.summary ? "Edit the summary" : "Add a summary", run: describe },
    "-",
    { node: projectSwatchRow(p.colour, async (colour) => { closeRowMenu(); await set({ colour }); }) },
    "-",
    ...statuses,
    "-",
    // A project with no folder is offered one here, from the switcher's "..."
    // as well as its settings, through the same checks Add folder makes.
    p.path
      ? { label: "Change folder…", run: () => navigate({ projectId: p.id, view: "project", query: "" }).then(() => document.getElementById("project-folder")?.scrollIntoView({ block: "center" })) }
      : { label: "Give it a folder…", run: async () => {
        try {
          const look = await window.delphi.folders.inspect(null);
          if (!look || look.cancelled) return;
          if (!look.ok) { notify(look.why, { error: true }); return; }
          await window.delphi.folders.set(p.id, look.top);
          notify(`${p.name} has a folder now: ${look.shown}.`);
        } catch (error) { notifyError(error); }
        await refresh();
      } },
    // The field is cleared by hand the way the row's own click does it: navigate
    // drops the query from the state and the box goes on showing what was typed.
    { label: "Settings", run: () => { $("search").value = ""; return navigate({ projectId: p.id, view: "project", query: "" }); } },
    { label: "Archive…", run: () => archiveProject(p) },
    { label: "Delete the project…", danger: true, run: () => destroyProject(p) },
  ];
  if (button && x == null) keyedMenu(button, items, { fromKeyboard });
  else keyedMenu(button, items, { x, y });
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// What's new
// ---------------------------------------------------------------------------

async function renderWhatsNew(root) {
  const items = await window.delphi.recent(10);
  // The sweep's way in, on the page All work opens to. On demand only: it
  // flags what looks misfiled and moves nothing.
  root.append(el("div", { className: "add-row" },
    el("span", { className: "hint grow", textContent: "Notes, tasks and pads that look filed in the wrong project can be found and proposed for a move. Nothing moves until you approve it in Needs you." }),
    sweepButton(null)));

  if (!items.length) {
    root.append(emptyState("Nothing yet", "Tasks and notes will appear here as they are added."));
    return;
  }

  // Grouped by day rather than listed flat: "what changed today" is the question
  // being asked, and a bare list of timestamps makes that harder to see, not easier.
  const groups = new Map();
  for (const item of items) {
    const day = dayLabel(item.updated_at);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(item);
  }

  for (const [day, group] of groups) {
    root.append(el("div", { className: "side-label", textContent: day }));
    const list = el("section", { className: "card" });

    for (const item of group) {
      const row = el("div", { className: "list-row" });

      row.append(el("span", {
        className: item.item_type === "note" ? `kind ${item.kind || "note"}` : "kind",
        textContent: item.item_type === "note" ? (item.kind || "note") : "task",
      }));

      const body = el("div", { className: "grow" });
      body.append(el("div", { textContent: item.title }));

      const meta = el("div", { className: "t-meta" });
      if (item.project_name) {
        const chip = el("span", { className: "chip", textContent: item.project_name });
        if (item.project_colour) chip.style.color = safeColour(item.project_colour, "");
        meta.append(chip);
      }
      if (item.status && item.status !== "todo") {
        meta.append(el("span", { className: `chip ${item.status === "blocked" ? "blocked" : "doing"}`, textContent: item.status }));
      }
      if (item.priority === "high") meta.append(el("span", { className: "chip high", textContent: "high" }));
      if (item.ref) meta.append(el("span", { className: "chip ref", textContent: item.ref }));
      // Created and edited read differently, so say which this is.
      meta.append(el("span", { className: "hint",
        textContent: `${item.created_at === item.updated_at ? "added" : "edited"} ${ago(item.updated_at)}` }));
      body.append(meta);
      row.append(body);

      // The whole row is the target rather than a button at the end: the row is
      // what someone is already looking at, and a button makes them travel to the
      // edge to act on it. Keyboard users get the same target, which a hover-only
      // affordance would not give them.
      if (item.project_id) {
        row.classList.add("clickable");
        row.tabIndex = 0;
        row.setAttribute("role", "link");
        row.title = `Open in ${item.project_name}`;
        const go = () => navigate({
          projectId: item.project_id,
          view: item.item_type === "note" ? "notes" : "tasks",
        });
        row.onclick = go;
        row.onkeydown = (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
        };
      }
      list.append(row);
    }
    root.append(list);
  }
}

/** Today and Yesterday read faster than a date when scanning recent activity. */
const dayLabel = (stamp) => TIME.dayLabel(stamp);

// ---------------------------------------------------------------------------
// The Oracle
// ---------------------------------------------------------------------------

function renderOracle(root) {
  const bar = el("div", { className: "oracle-bar" });
  const provider = state.provider;
  bar.append(el("div", { className: "hint grow",
    textContent: "Ranked by meaning rather than words, then expanded through what each result connects to." }));
  if (provider) {
    bar.append(el("span", {
      className: "provider-tag" + (provider.neural ? " neural" : ""),
      title: provider.neural
        ? "A local model is producing the vectors"
        : "No model is running, so this is falling back to word matching",
      textContent: provider.neural ? `${provider.dims}d local model` : "word matching",
    }));
  }
  root.append(bar);

  if (state.oracleError) {
    root.append(emptyState("The Oracle could not answer", state.oracleError));
    return;
  }

  if (!state.oracleHits.length) {
    root.append(emptyState("The Oracle has nothing for that",
      "Try a fuller question. It matches meaning, so a sentence works better than a keyword."));
    return;
  }

  const list = el("section", { className: "card" });
  for (const h of state.oracleHits) {
    const row = el("div", { className: "hit" });

    // Scores cluster in a narrow band, so the bar is scaled across the range in
    // view rather than 0 to 1, which would make every result look identical.
    const scores = state.oracleHits.map((x) => x.score);
    const lo = Math.min(...scores), hi = Math.max(...scores);
    const pct = hi === lo ? 100 : Math.round(((h.score - lo) / (hi - lo)) * 88 + 12);
    row.append(el("div", { className: "score" },
      el("div", { className: "n", textContent: h.score.toFixed(2) }),
      el("div", { className: "bar" }, el("i", { style: `width:${pct}%` }))));

    const body = el("div", { className: "hit-body" });
    body.append(el("div", { className: "hit-title", textContent: h.title || h.name }));
    const meta = el("div", { className: "t-meta" });
    meta.append(el("span", { className: "chip", textContent: h.type }));
    if (h.project) meta.append(el("span", { className: "chip", textContent: h.project }));
    if (h.kind && h.type === "note") meta.append(el("span", { className: `kind ${h.kind}`, textContent: h.kind }));
    if (h.status) meta.append(el("span", { className: "chip", textContent: h.status }));
    if (h.ref) meta.append(el("span", { className: "chip ref", textContent: h.ref }));
    body.append(meta);
    if (h.body) body.append(el("div", { className: "hit-snip", textContent: h.body.slice(0, 200).replace(/\s+/g, " ") }));
    row.append(body);
    list.append(row);
  }
  root.append(list);

  if (state.oracleEntities.length) {
    root.append(el("div", { className: "side-label", textContent: "Connected to" }));
    const cloud = el("div", { className: "entity-cloud" });
    for (const e of state.oracleEntities) {
      const chip = el("div", { className: "ent" },
        el("b", { textContent: e.name }),
        el("span", { className: "c", textContent: String(Math.round(e.weight)) }));
      chip.title = `${e.kind}, appears alongside this in ${Math.round(e.weight)} places`;
      chip.onclick = () => { $("search").value = e.name; navigate({ query: e.name, view: "oracle" }); };
      cloud.append(chip);
    }
    root.append(cloud);
  }
}

// ---------------------------------------------------------------------------
// Mind map: the knowledge graph, drawn
//
// The entities and edges tables have been there since the Oracle was built and
// nothing has ever shown them. This is the picture: entities as nodes, the
// stored co-occurrence edges as links, sized by how often each thing is
// mentioned.
//
// Three decisions keep it readable at the size the graph actually is (111
// entities and 733 co-occurrence edges here, which drawn naively is a grey
// hairball):
//
//   Limit.   Only the strongest N entities are drawn, N chosen in the toolbar.
//            Everything past the cut is counted, not drawn, because a node with
//            one mention adds a dot and no information.
//   Thin.    An edge survives only if it is among the strongest few links of at
//            least one of its endpoints. That keeps the shape of the graph, and
//            the ones it drops are the weak pairs that made the mesh.
//   Cluster. Layout is grouped by entity kind, so services sit with services and
//            tickets with tickets. Colour says the same thing twice, which is
//            what makes the picture scannable before anything is hovered.
//
// The layout settles once and then holds still. A drifting graph is pleasant at
// fifteen nodes and unusable at a hundred: labels smear and every target moves
// while you aim at it. The only thing that moves afterwards is the single node
// nearest the pointer, which leans towards it to make itself easier to hit.
// ---------------------------------------------------------------------------

// Kind order, label, and the token each kind draws with. Canvas needs a literal
// colour, so these are token names resolved through the DOM rather than values
// copied out of the stylesheet, and the map follows a theme change for free.
const MIND_MAP_KINDS = [
  ["service", "Services", "--graph-service"],
  ["ticket", "Tickets", "--graph-ticket"],
  ["concept", "Concepts", "--graph-concept"],
  ["repo", "Repos", "--graph-repo"],
  ["file", "Files", "--graph-file"],
  ["env", "Environments", "--graph-env"],
  ["person", "People", "--graph-person"],
  ["pr", "Pull requests", "--graph-pr"],
  // Learned from the user's own rows rather than listed (oracle.js).
  ["project", "Projects", "--graph-project"],
  ["term", "Terms", "--graph-term"],
  ["code", "Code", "--graph-code"],
];

const MIND_MAP_LIMITS = [40, 60, 100, 250];

const kindToken = (kind) => {
  const found = MIND_MAP_KINDS.find(([k]) => k === kind);
  return found ? found[2] : "--ink-faint";
};

// Kept outside `state` because it survives a repaint of the view and nothing
// else in the app reads it. The graph is fetched once and reused, so switching
// tabs does not refetch and relayout.
const mindMap = {
  data: null,        // { nodes, edges, total, partial }
  error: null,
  limit: 60,
  hidden: new Set(), // kinds switched off in the legend
  selected: null,    // entity name
  context: null,     // the oracle:context payload for the selection
  contextError: null,
};

/**
 * The whole entity graph, or as much of it as the bridge can give.
 *
 * The direct call is one query and the honest answer. Without it the view falls
 * back to expanding the strongest entities through oracle:context, which is a
 * real graph but only the part reachable in one hop from the top twelve, so it
 * says so rather than passing itself off as the whole thing.
 */
async function loadGraphData() {
  if (window.delphi.oracle.graph) {
    const data = await window.delphi.oracle.graph({ limit: 250 });
    return { nodes: data.nodes, edges: data.edges, total: data.total, partial: false };
  }

  const { top } = await window.delphi.oracle.stats();
  const seeds = await Promise.all(top.map((t) => window.delphi.oracle.context(t.name).catch(() => null)));

  const nodes = new Map();
  const edges = [];
  const keep = (e) => {
    if (!e || !e.id) return null;
    if (!nodes.has(e.id)) nodes.set(e.id, { id: e.id, kind: e.kind, name: e.name, mentions: e.mentions || 1 });
    return nodes.get(e.id);
  };

  for (const ctx of seeds) {
    if (!ctx || !ctx.entity) continue;
    const from = keep(ctx.entity);
    for (const r of ctx.related || []) {
      const to = keep(r);
      if (to) edges.push({ a: from.id, b: to.id, weight: r.weight || 1 });
    }
  }
  return { nodes: [...nodes.values()], edges, total: nodes.size, partial: true };
}

/** The nodes the current limit and legend leave on screen, strongest first. */
function mindMapVisible() {
  const all = (mindMap.data && mindMap.data.nodes) || [];
  return all
    .filter((n) => !mindMap.hidden.has(n.kind))
    .sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name))
    .slice(0, mindMap.limit);
}

/**
 * Drops every edge that is not one of the strongest few at either end.
 *
 * Taken in descending weight, an edge is kept while either endpoint still has
 * room. That is what leaves a skeleton rather than a mesh: a node's important
 * links survive even when its neighbour is already full, and the weak pairs that
 * every entity has with every other entity never get drawn.
 */
function thinEdges(nodes, edges, perNode, cap) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const degree = new Map();
  const kept = new Map();

  const candidates = edges
    .filter((e) => byId.has(e.a) && byId.has(e.b) && e.a !== e.b)
    .sort((x, y) => y.weight - x.weight);

  for (const e of candidates) {
    const key = e.a < e.b ? `${e.a}:${e.b}` : `${e.b}:${e.a}`;
    if (kept.has(key)) continue;
    const da = degree.get(e.a) || 0;
    const db = degree.get(e.b) || 0;
    if (da >= perNode && db >= perNode) continue;
    kept.set(key, { a: byId.get(e.a), b: byId.get(e.b), weight: e.weight });
    degree.set(e.a, da + 1);
    degree.set(e.b, db + 1);
    if (kept.size >= cap) break;
  }
  return [...kept.values()];
}

/**
 * Relaxes the layout in place.
 *
 * Position based rather than velocity based, and run to completion before the
 * first frame, so the picture that appears is the finished one. Cooling means
 * the early passes untangle and the late ones only tidy.
 */
function relaxLayout(nodes, links, W, H, ticks) {
  // How much room each node can expect. Fixed distances jam a hundred nodes into
  // the middle and leave sixty adrift, so both the separation the nodes want and
  // the length a link settles at come from the space there actually is.
  const room = Math.sqrt((W * H) / Math.max(nodes.length, 1));
  const apart = Math.min(1.9, room / 40);
  const rest = Math.min(62, room * 0.8);

  for (let step = 0; step < ticks; step++) {
    const cool = 0.15 + 0.85 * (1 - step / ticks);

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const want = (a.r + b.r + 26) * apart;
        if (d < want) {
          const push = ((want - d) / d) * 0.2 * cool;
          dx *= push; dy *= push;
          a.x -= dx; a.y -= dy;
          b.x += dx; b.y += dy;
        }
      }
    }

    for (const l of links) {
      let dx = l.b.x - l.a.x;
      let dy = l.b.y - l.a.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const want = rest + l.a.r + l.b.r;
      const pull = ((d - want) / d) * 0.055 * l.k * cool;
      dx *= pull; dy *= pull;
      l.a.x += dx; l.a.y += dy;
      l.b.x -= dx; l.b.y -= dy;
    }

    for (const n of nodes) {
      // Cluster gravity is the strongest force here on purpose. Left to the
      // links alone every kind ends up in one blob around the busiest entity,
      // and the grouping that makes the picture legible disappears.
      n.x += (n.cx - n.x) * 0.06 * cool;
      n.y += (n.cy - n.y) * 0.06 * cool;
      // Labels sit above a node, so the top margin is deeper than the others.
      n.x = Math.max(n.r + 14, Math.min(W - n.r - 14, n.x));
      n.y = Math.max(n.r + 26, Math.min(H - n.r - 12, n.y));
    }
  }
}

/**
 * Centres the settled layout and opens it out to use the stage.
 *
 * Where a graph lands depends on which kinds happen to be in it, so without this
 * the picture drifts into a corner and half the panel is white space. Positions
 * are scaled but radii are not, so the gaps only ever grow.
 */
function fitToStage(nodes, W, H) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r);
    x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r);
  }
  const pad = 34;
  const width = Math.max(x1 - x0, 1);
  const height = Math.max(y1 - y0, 1);
  // Never below 1: the relaxation already respects the edges of the stage, and
  // shrinking to reach the padding would close the gaps it worked to open.
  const scale = Math.max(1, Math.min((W - pad * 2) / width, (H - pad * 2) / height, 1.4));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  for (const n of nodes) {
    n.x = W / 2 + (n.x - cx) * scale;
    n.y = H / 2 + (n.y - cy) * scale;
    n.x = Math.max(n.r + 14, Math.min(W - n.r - 14, n.x));
    n.y = Math.max(n.r + 26, Math.min(H - n.r - 12, n.y));
  }
}

/** rgb(a, b, c) with an alpha put on it. */
function fadeColour(colour, a) {
  const parts = String(colour).match(/[\d.]+/g);
  if (!parts || parts.length < 3) return colour;
  return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${a})`;
}


/**
 * Opens the map on the workspace you are in.
 *
 * Only when nothing else is selected, so it cannot pull the view back to the
 * workspace every time the pane repaints while someone is exploring. The name is
 * matched against the graph's own nodes rather than assumed to be there: a
 * workspace nothing has written about yet has no node, and selecting a name that
 * does not exist would leave the panel reporting an entity it cannot find.
 */
function focusWorkspaceNode() {
  if (mindMap.selected || !state.workspaceId || !mindMap.data) return;
  const workspace = state.workspaces.find((w) => w.id === state.workspaceId);
  if (!workspace) return;

  const wanted = [workspace.name, workspace.path.split("/").pop()]
    .filter(Boolean).map((x) => x.toLowerCase());
  const hit = (mindMap.data.nodes || []).find((n) => wanted.includes(String(n.name).toLowerCase()));
  if (hit) mindMap.selected = hit.name;
}

async function renderMindMap(root) {
  if (!mindMap.data && !mindMap.error) {
    try {
      mindMap.data = await loadGraphData();
    } catch (error) {
      mindMap.error = String(error.message || error);
    }
  }

  // The graph is always the whole graph: a connection that leaves the workspace
  // is the one worth seeing, and hiding it would make the map agree with the
  // sidebar rather than tell you anything the sidebar cannot. What the workspace
  // changes is where you start reading, so it opens on itself.
  focusWorkspaceNode();

  const bar = el("div", { className: "oracle-bar" });
  bar.append(el("div", { className: "hint grow", textContent:
    "Everything the notes and tasks mention, and what appears alongside what. Hover to name a thing and its connections, click to open it." }));

  const rebuild = el("button", { className: "btn sm", textContent: "Rebuild" });
  rebuild.title = "Read the notes and tasks again and rebuild the graph from them";
  rebuild.onclick = async () => {
    rebuild.disabled = true;
    try {
      await window.delphi.oracle.rebuild();
      mindMap.data = null;
      mindMap.error = null;
      mindMap.selected = null;
      mindMap.context = null;
    } catch (error) {
      mindMap.error = String(error.message || error);
    }
    render();
  };
  bar.append(rebuild);
  root.append(bar);

  if (mindMap.error) {
    root.append(emptyState("The graph could not be read", mindMap.error));
    return;
  }

  const all = mindMap.data.nodes;
  if (!all.length) {
    root.append(emptyState("Nothing in the graph yet",
      "Rebuild reads every note and task and extracts what they mention."));
    return;
  }

  // --- toolbar -------------------------------------------------------------
  const tools = el("div", { className: "mm-tools" });

  const counts = new Map();
  for (const n of all) counts.set(n.kind, (counts.get(n.kind) || 0) + 1);

  const legend = el("div", { className: "mm-legend", role: "group" });
  legend.setAttribute("aria-label", "Entity kinds");
  for (const [kind, label, token] of MIND_MAP_KINDS) {
    if (!counts.get(kind)) continue;
    const off = mindMap.hidden.has(kind);
    const chip = el("button", { className: "mm-key" + (off ? " off" : ""), type: "button" });
    chip.setAttribute("aria-pressed", String(!off));
    chip.append(
      el("i", { className: "mm-swatch", style: `background: var(${token})` }),
      el("span", { textContent: label }),
      el("span", { className: "c", textContent: String(counts.get(kind)) })
    );
    chip.title = off ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`;
    chip.onclick = () => {
      if (off) mindMap.hidden.delete(kind);
      else mindMap.hidden.add(kind);
      render();
    };
    legend.append(chip);
  }
  tools.append(legend);

  const limit = el("select", { className: "field mm-limit" });
  limit.setAttribute("aria-label", "How many entities to draw");
  const steps = MIND_MAP_LIMITS.filter((n) => n < all.length);
  steps.push(all.length);
  // "All" only when it really is all of them. The bridge caps what it sends, so
  // on a bigger graph than that cap the last option is still a top slice.
  const everything = !mindMap.data.total || mindMap.data.total <= all.length;
  for (const n of steps) {
    limit.append(el("option", {
      value: String(n),
      textContent: n === all.length && everything ? `All ${n}` : `Top ${n}`,
      selected: Math.min(mindMap.limit, all.length) === n,
    }));
  }
  limit.onchange = () => { mindMap.limit = Number(limit.value); render(); };
  tools.append(limit);
  root.append(tools);

  // --- the two panes -------------------------------------------------------
  const wrap = el("div", { className: "mm-wrap" });
  const stage = el("div", { className: "mm-stage" });
  const canvas = el("canvas", { className: "mm-canvas" });
  canvas.setAttribute("role", "img");
  const probe = el("span", { className: "mm-probe" });
  probe.setAttribute("aria-hidden", "true");
  const readout = el("div", { className: "mm-readout" });
  stage.append(canvas, probe, readout);
  wrap.append(stage);

  const panel = el("aside", { className: "mm-panel" });
  wrap.append(panel);
  root.append(wrap);

  const visible = mindMapVisible();
  const known = mindMap.data.total || all.length;
  const hiddenCount = known - visible.length;
  canvas.setAttribute("aria-label", `Knowledge graph, ${visible.length} of ${known} entities drawn`);

  if (!visible.length) {
    stage.replaceChildren(emptyState("Every kind is switched off", "Turn one back on above."));
  }

  const foot = el("div", { className: "mm-foot hint" });
  foot.append(
    `${plural(visible.length, "entity", "entities")} drawn`,
    hiddenCount > 0 ? `, ${hiddenCount} left out by the limit and the legend` : "",
    mindMap.data.partial
      ? ". Partial view: the strongest entities and what they connect to."
      : ""
  );
  root.append(foot);

  // --- the graph -----------------------------------------------------------
  if (!visible.length) {
    paintPanel(panel, null);
    return;
  }

  const links = thinEdges(visible, mindMap.data.edges || [], 3, 320);
  const maxWeight = links.reduce((m, l) => Math.max(m, l.weight), 1);
  for (const l of links) l.k = 0.35 + 0.65 * (l.weight / maxWeight);

  const adjacency = new Map(visible.map((n) => [n, new Set()]));
  for (const l of links) {
    adjacency.get(l.a).add(l.b);
    adjacency.get(l.b).add(l.a);
  }

  let hover = null;
  let named = null;   // what the readout is currently saying, so it is not rewritten every frame

  const select = async (name) => {
    mindMap.selected = name;
    mindMap.context = null;
    mindMap.contextError = null;
    paintPanel(panel, select);
    requestDraw();
    const token = name;
    try {
      const ctx = await window.delphi.oracle.context(name);
      if (mindMap.selected !== token) return;   // a second click landed while this was in flight
      mindMap.context = ctx;
    } catch (error) {
      if (mindMap.selected !== token) return;
      mindMap.contextError = String(error.message || error);
    }
    paintPanel(panel, select);
    requestDraw();
  };

  const ctx2d = canvas.getContext("2d");
  let W = 0;
  let H = 0;
  let palette = null;
  let fontStack = "system-ui, sans-serif";
  let dirty = true;
  let frame = 0;

  const requestDraw = () => { dirty = true; };

  const colours = () => {
    if (palette) return palette;
    const read = (token) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    fontStack = getComputedStyle(probe).fontFamily || fontStack;
    palette = {
      ink: read("--ink"),
      dim: read("--ink-dim"),
      faint: read("--ink-faint"),
      surface: read("--surface"),
      accent: read("--accent"),
      line: read("--line"),
      kind: Object.fromEntries(MIND_MAP_KINDS.map(([kind, , token]) => [kind, read(token)])),
    };
    return palette;
  };

  const layout = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    // The observer fires once on its own as well as on a real resize, and
    // settling the layout again for the same box would throw away a picture the
    // reader is already looking at.
    if (!w || !h || (w === W && h === H)) return;
    W = w;
    H = h;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Ring order comes from the kind table rather than from the data, so the
    // same kind sits in the same place whatever the limit is set to.
    const kinds = MIND_MAP_KINDS.map(([k]) => k).filter((k) => visible.some((n) => n.kind === k));
    const strongest = visible[0].mentions || 1;
    const many = kinds.length > 1 ? 1 : 0;

    visible.forEach((n, i) => {
      const group = kinds.indexOf(n.kind);
      const angle = -Math.PI / 2 + (group / kinds.length) * Math.PI * 2;
      n.cx = W / 2 + Math.cos(angle) * W * 0.31 * many;
      n.cy = H / 2 + Math.sin(angle) * H * 0.32 * many;
      // Seeded placement, not random: the same graph settles the same way every
      // time, so it can be recognised rather than relearned on each visit.
      const golden = i * 2.399963;
      n.x = n.cx + Math.cos(golden) * (18 + (i % 7) * 9);
      n.y = n.cy + Math.sin(golden) * (18 + (i % 5) * 9);
      n.r = 5 + 10 * Math.sqrt(n.mentions / strongest);
      n.ox = 0;
      n.oy = 0;
    });

    relaxLayout(visible, links, W, H, 260);
    fitToStage(visible, W, H);
    requestDraw();
  };

  const nodeAt = (px, py) => {
    let found = null;
    let best = Infinity;
    for (const n of visible) {
      const d = Math.hypot(n.x + n.ox - px, n.y + n.oy - py);
      // A generous reach, because an eight pixel circle is a target you aim at
      // rather than one you can simply arrive at.
      if (d < n.r + 16 && d < best) { best = d; found = n; }
    }
    return found;
  };

  const pointer = { x: -9999, y: -9999, inside: false };

  const draw = () => {
    if (!W || !H) return;
    const c = colours();
    const selected = mindMap.selected
      ? visible.find((n) => n.name === mindMap.selected) || null
      : null;
    const focus = hover || selected;
    const near = focus ? adjacency.get(focus) : null;

    ctx2d.clearRect(0, 0, W, H);
    ctx2d.lineCap = "round";

    for (const l of links) {
      const lit = focus && (l.a === focus || l.b === focus);
      if (lit) {
        ctx2d.strokeStyle = fadeColour(c.accent, 0.65);
        ctx2d.lineWidth = 1 + l.k * 1.6;
      } else if (focus) {
        ctx2d.strokeStyle = fadeColour(c.faint, 0.09);
        ctx2d.lineWidth = 0.7;
      } else {
        ctx2d.strokeStyle = fadeColour(c.faint, 0.3);
        ctx2d.lineWidth = 0.6 + l.k * 0.8;
      }
      ctx2d.beginPath();
      ctx2d.moveTo(l.a.x + l.a.ox, l.a.y + l.a.oy);
      ctx2d.lineTo(l.b.x + l.b.ox, l.b.y + l.b.oy);
      ctx2d.stroke();
    }

    for (const n of visible) {
      const dim = focus && n !== focus && !near.has(n);
      const x = n.x + n.ox;
      const y = n.y + n.oy;
      ctx2d.globalAlpha = dim ? 0.22 : 1;
      ctx2d.fillStyle = c.kind[n.kind] || c.dim;
      ctx2d.beginPath();
      ctx2d.arc(x, y, n.r * (n === focus ? 1.18 : 1), 0, Math.PI * 2);
      ctx2d.fill();

      if (n === selected || n === hover) {
        ctx2d.strokeStyle = n === selected ? c.accent : fadeColour(c.ink, 0.55);
        ctx2d.lineWidth = n === selected ? 2 : 1.2;
        ctx2d.beginPath();
        ctx2d.arc(x, y, n.r + 5, 0, Math.PI * 2);
        ctx2d.stroke();
      }
      ctx2d.globalAlpha = 1;
    }

    // Labels where they earn their place. With nothing held, the anchors of the
    // graph are named; holding a node names it and everything it connects to,
    // because "what is this connected to" answered with unlabelled lines is not
    // an answer.
    const labelled = new Set();
    if (focus) {
      labelled.add(focus);
      for (const n of near) labelled.add(n);
      if (selected) labelled.add(selected);
    } else {
      visible.slice(0, 8).forEach((n) => labelled.add(n));
    }

    // Most important first, because the loser of an overlap is the one that gets
    // dropped and two names written over each other are worth less than one.
    const order = [...labelled].sort((a, b) =>
      (b === focus) - (a === focus) || b.mentions - a.mentions);
    const plates = [];

    for (const n of order) {
      const strong = n === focus || n === selected;
      const y = n.y + n.oy - n.r - 9;
      ctx2d.font = `${strong ? 600 : 500} ${strong ? 12.5 : 11.5}px ${fontStack}`;
      ctx2d.textAlign = "center";
      ctx2d.textBaseline = "alphabetic";

      // A plate behind the text, or a label lands on top of an edge and neither
      // is readable.
      const w = ctx2d.measureText(n.name).width;
      // File paths are long enough to run off the side, so a label near an edge
      // slides back in rather than being cut in half.
      const x = Math.max(w / 2 + 6, Math.min(W - w / 2 - 6, n.x + n.ox));
      const plate = { x: x - w / 2 - 4, y: y - 11, w: w + 8, h: 15 };
      const clash = plates.some((p) =>
        plate.x < p.x + p.w && plate.x + plate.w > p.x &&
        plate.y < p.y + p.h && plate.y + plate.h > p.y);
      if (clash && !strong) continue;
      plates.push(plate);

      ctx2d.fillStyle = fadeColour(c.surface, focus ? 0.92 : 0.78);
      ctx2d.fillRect(plate.x, plate.y, plate.w, plate.h);
      ctx2d.fillStyle = strong ? c.ink : c.dim;
      ctx2d.fillText(n.name, x, y);
    }

    // The readout says in words what the picture says in dots, which is also the
    // only version of it a screen reader can reach.
    const wanted = focus ? focus.name : null;
    if (wanted !== named) {
      named = wanted;
      readout.textContent = "";
      if (focus) {
        const neighbours = [...adjacency.get(focus)].sort((a, b) => b.mentions - a.mentions);
        readout.append(el("b", { textContent: focus.name }));
        readout.append(el("span", { className: "mm-kind", textContent: focus.kind }));
        readout.append(el("span", { textContent: `${plural(focus.mentions, "mention", "mentions")}` }));
        readout.append(el("span", {
          textContent: neighbours.length
            ? `connects to ${neighbours.slice(0, 6).map((n) => n.name).join(", ")}${neighbours.length > 6 ? ` and ${neighbours.length - 6} more` : ""}`
            : "no drawn connections at this limit",
        }));
      }
    }
  };

  const tick = () => {
    if (!canvas.isConnected) { teardown(); return; }
    frame = requestAnimationFrame(tick);

    // Asked per frame rather than hoisted out of the loop, because the answer can
    // change while the graph is on screen and a graph drawn before the change
    // would otherwise keep moving until the view was rendered again.
    if (!motionOff()) {
      // Only one node is magnetic, and it is the one already under the pointer.
      // Making everything flee the cursor is fun for a second and then makes the
      // graph impossible to click.
      const magnet = pointer.inside ? hover : null;
      for (const n of visible) {
        const tx = magnet === n ? (pointer.x - n.x) * 0.28 : 0;
        const ty = magnet === n ? (pointer.y - n.y) * 0.28 : 0;
        const nx = n.ox + (Math.max(-14, Math.min(14, tx)) - n.ox) * 0.18;
        const ny = n.oy + (Math.max(-14, Math.min(14, ty)) - n.oy) * 0.18;
        if (Math.abs(nx - n.ox) > 0.05 || Math.abs(ny - n.oy) > 0.05) dirty = true;
        n.ox = nx;
        n.oy = ny;
      }
    }

    if (!dirty) return;
    dirty = false;
    draw();
  };

  const onMove = (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;
    pointer.inside = true;
    const next = nodeAt(pointer.x, pointer.y);
    if (next !== hover) {
      hover = next;
      canvas.style.cursor = hover ? "pointer" : "default";
      dirty = true;
    }
  };
  const onLeave = () => {
    pointer.inside = false;
    pointer.x = -9999;
    pointer.y = -9999;
    if (hover) { hover = null; canvas.style.cursor = "default"; dirty = true; }
  };
  const onClick = () => { if (hover) select(hover.name); };

  const resize = new ResizeObserver(() => layout());
  // A theme change repaints nothing by itself, and the canvas holds resolved
  // colours rather than tokens, so both routes into a theme change invalidate them.
  const themeWatch = new MutationObserver(() => { palette = null; dirty = true; });
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  const onSystemTheme = () => { palette = null; dirty = true; };

  function teardown() {
    cancelAnimationFrame(frame);
    resize.disconnect();
    themeWatch.disconnect();
    systemTheme.removeEventListener("change", onSystemTheme);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("click", onClick);
  }

  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("click", onClick);
  resize.observe(stage);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  systemTheme.addEventListener("change", onSystemTheme);

  layout();
  paintPanel(panel, select);
  // The loop runs even under reduced motion, where it moves nothing: it is what
  // notices the view has been replaced and takes the observers down with it.
  frame = requestAnimationFrame(tick);
}

/**
 * The side panel: what the selected entity connects to.
 *
 * Everything here is reachable by keyboard, which the canvas is not. With
 * nothing selected it lists the strongest entities as buttons, so the graph has
 * a text equivalent rather than being a picture with a mouse-only door.
 */
function paintPanel(panel, select) {
  panel.textContent = "";

  if (!mindMap.selected) {
    panel.append(el("div", { className: "side-label", textContent: "Strongest entities" }));
    const list = el("div", { className: "mm-list" });
    for (const n of mindMapVisible().slice(0, 12)) {
      const row = el("button", { className: "mm-row", type: "button" });
      row.append(
        el("span", { className: "mm-dot", style: `background: var(${kindToken(n.kind)})` }),
        el("span", { className: "grow", textContent: n.name }),
        el("span", { className: "c", textContent: String(n.mentions) })
      );
      row.onclick = () => select && select(n.name);
      list.append(row);
    }
    panel.append(list);
    panel.append(el("div", { className: "hint mm-note", textContent:
      "Pick one to see the notes and tasks it came from." }));
    return;
  }

  const head = el("div", { className: "mm-head" });
  head.append(el("h3", { textContent: mindMap.selected }));
  const close = el("button", { className: "btn sm", textContent: "Clear" });
  close.onclick = () => { mindMap.selected = null; mindMap.context = null; paintPanel(panel, select); };
  head.append(close);
  panel.append(head);

  const ctx = mindMap.context;
  if (mindMap.contextError) {
    panel.append(emptyState("Could not open that", mindMap.contextError));
    return;
  }
  if (!ctx) {
    panel.append(el("div", { className: "hint mm-note", textContent: "Reading the graph…" }));
    return;
  }
  if (!ctx.entity) {
    panel.append(emptyState("Nothing stored for that", "It may have been dropped by the last rebuild."));
    return;
  }

  const meta = el("div", { className: "t-meta" });
  meta.append(el("span", { className: "chip", textContent: ctx.entity.kind }));
  meta.append(el("span", { className: "hint", textContent: plural(ctx.entity.mentions, "mention", "mentions") }));
  panel.append(meta);

  const search = el("button", { className: "btn sm mm-search", textContent: "Ask the Oracle about this" });
  search.onclick = () => {
    $("search").value = ctx.entity.name;
    navigate({ query: ctx.entity.name, view: "oracle" });
  };
  panel.append(search);

  if (ctx.projects && ctx.projects.length) {
    panel.append(el("div", { className: "side-label", textContent: "Projects" }));
    const row = el("div", { className: "entity-cloud" });
    for (const p of ctx.projects) {
      const chip = el("div", { className: "ent" }, el("b", { textContent: p.name }));
      chip.onclick = () => navigate({ projectId: p.id, view: "overview" });
      row.append(chip);
    }
    panel.append(row);
  }

  const openIn = (projectName, view) => {
    const project = state.projects.find((p) => p.name === projectName);
    if (project) navigate({ projectId: project.id, view });
  };

  const openItem = async (r, view) => {
    if (!r.id) return openIn(r.project, view);
    if (view === "tasks") return openTaskSheet(r.id);
    const project = state.projects.find((p) => p.name === r.project);
    try {
      const notes = project ? await window.delphi.notes.list(project.id) : [];
      const note = (notes || []).find((n) => n.id === r.id);
      if (note) return openNoteSheet(note);
    } catch {}
    openIn(r.project, view);
  };

  const section = (label, rows, view) => {
    if (!rows || !rows.length) return;
    panel.append(el("div", { className: "side-label", textContent: label }));
    const list = el("div", { className: "mm-list" });
    for (const r of rows.slice(0, 8)) {
      const row = el("div", { className: "mm-item" });
      row.append(el("div", { className: "mm-item-title", textContent: r.title }));
      const foot = el("div", { className: "t-meta" });
      if (r.project) foot.append(el("span", { className: "chip", textContent: r.project }));
      if (r.status) foot.append(el("span", { className: "chip", textContent: r.status }));
      if (r.kind) foot.append(el("span", { className: `kind ${r.kind}`, textContent: r.kind }));
      row.append(foot);
      // The evidence is the sentence the edge was drawn from, which is the whole
      // argument for trusting the edge.
      if (r.evidence) row.append(el("div", { className: "mm-ev", textContent: r.evidence }));
      if (r.project) {
        row.classList.add("clickable");
        row.tabIndex = 0;
        row.setAttribute("role", "link");
        row.title = r.id ? `Open ${view === "tasks" ? "this task" : "this note"}` : `Open in ${r.project}`;
        // Open the very item that was clicked. Landing on the project's whole
        // list left the person searching for the thing they had just picked.
        const go = () => openItem(r, view);
        row.onclick = go;
        row.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
      }
      list.append(row);
    }
    panel.append(list);
  };

  section("Tasks", ctx.tasks, "tasks");
  section("Memory", ctx.notes, "notes");

  if (ctx.related && ctx.related.length) {
    panel.append(el("div", { className: "side-label", textContent: "Appears alongside" }));
    const cloud = el("div", { className: "entity-cloud" });
    for (const e of ctx.related) {
      const chip = el("div", { className: "ent" },
        el("b", { textContent: e.name }),
        el("span", { className: "c", textContent: String(Math.round(e.weight)) }));
      chip.title = `${e.kind}, appears alongside this in ${Math.round(e.weight)} places`;
      chip.onclick = () => select && select(e.name);
      cloud.append(chip);
    }
    panel.append(cloud);
  }

  if (!(ctx.tasks || []).length && !(ctx.notes || []).length) {
    panel.append(emptyState("Nothing cites this directly", "It was reached through what it appears alongside."));
  }
}

/* ---------------------------------------------------------------------------
   Three ways to look at the same tasks

   A flat list, the same list split into a column per status, and a board you can
   drag between. The choice is remembered on the project rather than in settings,
   because a project with four tasks and a project with forty want different
   answers and a global preference forces one of them to be wrong.

   The board is not a fourth data model. A column is a status, and dragging a card
   writes that status, which means it also writes a status event and shows up in
   the timeline like any other move. Nothing knows it came from a board.
--------------------------------------------------------------------------- */

const BOARD_COLUMNS = [
  ["todo", "To do"],
  ["doing", "In progress"],
  ["blocked", "Blocked"],
  ["done", "Done"],
];

/** The layout this project is set to, defaulting to the flat list. */
function taskViewMode() {
  const project = currentProject();
  return (project && project.task_view) || "list";
}

async function setTaskViewMode(mode) {
  const project = currentProject();
  if (!project) return;
  project.task_view = mode;           // so the repaint below is immediate
  await window.delphi.projects.update(project.id, { task_view: mode });
  refresh();
}

const VIEWS = [
  {
    id: "list", group: "popular", glyph: "rows", name: "List",
    desc: "Every open task in one column, top to bottom.",
  },
  {
    id: "board", group: "popular", glyph: "board", name: "Board",
    desc: "A column per status. Drag a card to move the work.",
  },
  {
    id: "table", group: "popular", glyph: "grid", name: "Table",
    desc: "A row per task. Compare down a column, select across.",
  },
  {
    id: "calendar", group: "popular", glyph: "cal", name: "Calendar",
    desc: "Tasks sitting on the day they are due.",
  },
  {
    id: "gantt", group: "popular", glyph: "gantt", name: "Gantt",
    desc: "Bars across a schedule, showing what blocks what.",
    why: "Needs start dates and dependencies. A task has a due date and no notion of what must finish first.",
  },
  {
    id: "doc", group: "popular", glyph: "doc", name: "Doc", tab: "notes",
    desc: "This project's memory: decisions, gotchas and references.",
  },

  {
    id: "columns", group: "more", glyph: "cols", name: "Columns",
    desc: "A column per status, side by side, without the dragging.",
  },
  {
    id: "dashboard", group: "more", glyph: "dash", name: "Dashboard", tab: "overview",
    desc: "Counts, what is moving, what is stuck, and where to go next.",
  },
  {
    id: "activity", group: "more", glyph: "feed", name: "History", tab: "activity",
    desc: "Every change, newest first, and a way to undo one.",
  },
  {
    id: "timeline", group: "more", glyph: "track", name: "Timeline",
    desc: "The same work laid left to right over dates.",
    why: "Needs start dates and dependencies, which tasks do not carry.",
  },
  {
    id: "form", group: "more", glyph: "form", name: "Form",
    desc: "A form that files whatever it collects as a task.",
    why: "Nothing can post into Delphi from outside it. Work arrives from agents over MCP.",
  },
  {
    id: "workload", group: "more", glyph: "bars", name: "Workload",
    desc: "Who is over capacity this week, and who is not.",
    why: "Needs people and capacity. An assignee here is free text, not an account with hours behind it.",
  },
  {
    id: "team", group: "more", glyph: "people", name: "Team",
    desc: "One lane per person, so a standup reads itself.",
    why: "Needs people. Delphi stores an assignee name and nothing behind it.",
  },
  {
    id: "mindmap", group: "more", glyph: "mind", name: "Mind Map", tab: "graph",
    desc: "The knowledge graph: what this work keeps mentioning, and what sits near what.",
  },
  {
    id: "whiteboard", group: "more", glyph: "canvas", name: "Whiteboard",
    desc: "A canvas to sketch on beside the work.",
    why: "Not built. There is nowhere to keep a drawing.",
  },
];

const VIEW_GROUPS = [["popular", "Popular"], ["more", "More"]];

const findView = (id) => VIEWS.find((v) => v.id === id) || null;

/**
 * The glyph beside each name.
 *
 * Drawn from empty elements and CSS rather than an icon font or an SVG file:
 * the page runs with a strict CSP and no build step, so the cheapest thing that
 * survives both is a handful of divs the stylesheet arranges. Each shape is a
 * count of marks here and a rule in index.html.
 */
const GLYPH_MARKS = {
  rows: 3, cols: 3, board: 3, grid: 9, cal: 12, doc: 4, dash: 3, feed: 3,
  gantt: 3, track: 3, form: 3, people: 3, bars: 3, mind: 3, canvas: 2,
};

function viewGlyph(shape) {
  const box = el("span", { className: `vp-glyph ${shape}` });
  box.setAttribute("aria-hidden", "true");
  for (let i = 0; i < (GLYPH_MARKS[shape] || 3); i++) box.append(el("i"));
  return box;
}

/**
 * Which view is showing.
 *
 * The tabs came first and still own state.view, so the three that became views
 * are translated back here rather than being renamed everywhere. Inside the
 * Tasks tab the answer is whatever layout the project is set to.
 */
function currentViewId() {
  if (state.view === "tasks") return taskViewMode();
  return { notes: "doc", overview: "dashboard", activity: "activity" }[state.view] || taskViewMode();
}

/** Switches to a view, whichever of the two mechanisms carries it. */
async function applyView(view) {
  if (view.why) return;
  if (view.id === currentViewId()) return;
  if (view.tab) return navigate({ view: view.tab });

  try {
    await setTaskViewMode(view.id);
  } catch (error) {
    // db.js validates task_view against a list of layouts. A layout offered
    // here but never added there fails loudly rather than leaving a row that
    // quietly does nothing, and the reload puts back the value the store
    // actually holds after the optimistic write.
    await refresh();
    alert(`Cannot switch to ${view.name}: ${error.message}`);
  }
}

/** One row of the popup: glyph, name, a line of prose, and a reason if it needs one. */
function viewRow(view, currentId, pick) {
  const chosen = view.id === currentId;
  const row = el("button", {
    type: "button",
    className: "vp-item" + (view.why ? " off" : "") + (chosen ? " on" : ""),
    tabIndex: -1,
  });
  row.dataset.name = view.name.toLowerCase();
  row.setAttribute("role", "menuitemradio");
  row.setAttribute("aria-checked", String(chosen));
  // aria-disabled rather than the disabled attribute, because a disabled button
  // cannot be focused and the reason it is disabled is the most useful thing on
  // the row. It stays reachable by keyboard and refuses to act instead.
  if (view.why) row.setAttribute("aria-disabled", "true");

  row.append(viewGlyph(view.glyph));

  const name = el("span", { className: "vp-name" }, view.name);
  if (view.why) name.append(el("span", { className: "chip vp-flag", textContent: "not built" }));
  else if (chosen) name.append(el("span", { className: "chip vp-now", textContent: "current" }));

  const text = el("span", { className: "vp-text" },
    name,
    el("span", { className: "vp-desc", textContent: view.desc }),
    view.why ? el("span", { className: "vp-why", textContent: view.why }) : null);

  row.append(text);
  row.onclick = () => pick(view);
  return row;
}

/**
 * Opens the popup under the trigger.
 *
 * Built on rowMenu, which already solves being a popup: one open at a time,
 * kept inside the viewport, and closed by a click anywhere else. A second
 * implementation of that would be a second set of the same bugs.
 */
function openViewMenu(trigger, land = "current") {
  const currentId = currentViewId();
  const rows = [];
  const nodes = [];

  for (const [group, heading] of VIEW_GROUPS) {
    nodes.push(el("div", { className: "vp-group", textContent: heading }));
    for (const view of VIEWS) {
      // A view that is not built stays in VIEWS, with the reason, as the record
      // of why. It is not offered: six rows advertising absence, out of fifteen,
      // were a third of the picker spent on things that do nothing when clicked.
      if (view.group !== group || view.why) continue;
      const row = viewRow(view, currentId, pick);
      rows.push(row);
      nodes.push(row);
    }
  }

  const box = trigger.getBoundingClientRect();
  // The class goes in rather than on, so the popup is measured at the size it
  // will actually be before rowMenu clamps it into the viewport.
  const menu = rowMenu(box.left, box.bottom + 6, nodes, { onClose: closed, className: "vp" });
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Choose a view");
  menu.onkeydown = onKey;
  trigger.setAttribute("aria-expanded", "true");

  const start = land === "last" ? rows.length - 1 : Math.max(0, rows.findIndex((r) => r.classList.contains("on")));
  rows[start].focus();

  // Runs however the menu closed, including the click away that rowMenu owns,
  // so the trigger cannot be left claiming to be expanded over nothing.
  function closed() {
    trigger.setAttribute("aria-expanded", "false");
  }

  function dismiss() {
    closeRowMenu();
    trigger.focus();
  }

  function pick(view) {
    // The unavailable rows are focusable and clickable so their reason can be
    // read. Acting on one does nothing, and closing the popup on the way would
    // hide the answer just as it was asked for.
    if (view.why) return;
    dismiss();
    applyView(view);
  }

  function step(from, by) {
    if (from < 0) return by > 0 ? rows[0] : rows[rows.length - 1];
    return rows[(from + by + rows.length) % rows.length];
  }

  function onKey(e) {
    const at = rows.indexOf(document.activeElement);

    if (e.key === "Escape") {
      // Escape reaches the window handler otherwise, and hides the whole panel
      // when all that was wanted was to shut this.
      e.preventDefault();
      e.stopPropagation();
      dismiss();
      return;
    }
    if (e.key === "Tab") {
      // Not prevented: focus is handed back to the trigger and Tab carries on
      // from there, which is where it would have been had this never opened.
      dismiss();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      step(at, e.key === "ArrowDown" ? 1 : -1).focus();
      return;
    }
    if (e.key === "Home") { e.preventDefault(); rows[0].focus(); return; }
    if (e.key === "End") { e.preventDefault(); rows[rows.length - 1].focus(); return; }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (at >= 0) rows[at].click();
      return;
    }

    // Type a letter to jump. Fifteen rows is enough that scanning with the
    // arrows is slower than saying which one you meant.
    if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const letter = e.key.toLowerCase();
      const order = rows.slice(at + 1).concat(rows.slice(0, at + 1));
      const hit = order.find((r) => r.dataset.name.startsWith(letter));
      if (hit) { e.preventDefault(); hit.focus(); }
    }
  }

  return menu;
}

/** The trigger: what is showing now, and the way to change it. */
function viewPicker() {
  const current = findView(currentViewId()) || VIEWS[0];

  const trigger = el("button", { type: "button", className: "btn vp-trigger", title: "Change view" });
  trigger.append(
    viewGlyph(current.glyph),
    el("span", { className: "vp-trigger-name", textContent: current.name }),
    el("span", { className: "vp-caret", textContent: "▾" }));
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");

  // Opened on mousedown rather than click, so that clicking the trigger while
  // the popup is open closes it and leaves it closed. On click it would not:
  // rowMenu's click away fires first on the same press, and the click that
  // followed would open it straight back up.
  trigger.onmousedown = (e) => {
    e.preventDefault();
    if (openMenu && openMenu.classList.contains("vp")) {
      // Focused by hand, because preventDefault above stopped the press doing
      // it, and the row that held focus is being removed from the document.
      closeRowMenu();
      trigger.focus();
      return;
    }
    openViewMenu(trigger);
  };

  trigger.onkeydown = (e) => {
    if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    // Prevented so the synthesised click does not arrive after the popup has
    // opened and land on whichever row is under the pointer.
    e.preventDefault();
    openViewMenu(trigger, e.key === "ArrowUp" ? "last" : "current");
  };

  return trigger;
}

/** Tasks grouped into the four statuses, in board order. */
function groupByStatus(tasks) {
  return BOARD_COLUMNS.map(([status, label]) => ({
    status,
    label,
    tasks: tasks.filter((t) => statusOf(t) === status),
  }));
}

/**
 * The colours a task may be given.
 *
 * A fixed set of names rather than a picker of arbitrary hex. The same value has
 * to stay legible on a light ground and a dark one, and a colour chosen against
 * either will fail on the other: a pastel disappears on white, a strong hue
 * turns to mud on the dark surface. So what is stored is the name, and each name
 * resolves to a different hex per theme in index.html.
 */
const TASK_COLOURS = [
  ["blue", "Blue"],
  ["teal", "Teal"],
  ["green", "Green"],
  ["amber", "Amber"],
  ["orange", "Orange"],
  ["red", "Red"],
  ["purple", "Purple"],
  ["slate", "Slate"],
];

const TASK_COLOUR_NAMES = new Map(TASK_COLOURS);

// An unrecognised name paints nothing rather than an unstyled element, so a
// colour written by an older or newer build degrades to no colour at all.
const hasColour = (t) => Boolean(t && TASK_COLOUR_NAMES.has(t.colour));
const colourClass = (t) => (hasColour(t) ? ` tinted c-${t.colour}` : "");
const colourLabel = (name) => TASK_COLOUR_NAMES.get(name) || "";

/**
 * Which project a task belongs to, said the way the sidebar says it.
 *
 * Only ever shown in the cross-project lists, where the project name used to be
 * one more piece of faint grey text among the ref and the counts and so read as
 * a label rather than as an owner. The colour is what the sidebar trained the
 * eye on, so reusing the same dot makes the row match up with the list on the
 * left without anyone having to read it. Falls back to the faint ink when a
 * project has no colour set, because an undefined background paints a black
 * circle, which looks like a deliberate colour choice.
 */
function projectOwner(t) {
  const owner = el("span", { className: "t-owner" });
  owner.append(el("span", { className: "dot", style: `background:${safeColour(t.project_colour)}` }));
  owner.append(el("span", { textContent: t.project_name }));
  return owner;
}

/**
 * The palette, as a row of swatches.
 *
 * Used both inside the task sheet and inside the right click menu, so a colour
 * is one gesture away wherever a task is shown. The last swatch clears it, which
 * is the only way back to no colour once one is set.
 */
function swatchRow(current, onPick) {
  const row = el("div", { className: "swatches", role: "group" });
  row.setAttribute("aria-label", "Task colour");
  for (const [value, label] of TASK_COLOURS) {
    const b = el("button", {
      className: `swatch c-${value}` + (current === value ? " on" : ""),
      type: "button", title: label,
    });
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-pressed", String(current === value));
    b.onclick = (e) => { e.stopPropagation(); onPick(value); };
    row.append(b);
  }
  const clear = el("button", {
    className: "swatch none" + (current ? "" : " on"),
    type: "button", title: "No colour",
  });
  clear.setAttribute("aria-label", "No colour");
  clear.setAttribute("aria-pressed", String(!current));
  clear.onclick = (e) => { e.stopPropagation(); onPick(null); };
  row.append(clear);
  return row;
}

/**
 * The same row of swatches, for a project.
 *
 * Projects store a raw hex rather than one of the palette names tasks use, so
 * the colour cannot arrive through a c-* class and is written straight onto the
 * custom property .swatch already paints itself from. There is no clearing
 * swatch: a project with no colour still draws a dot, in a grey nobody chose,
 * and offering that as a seventh option would be offering a colour that looks
 * like a mistake. The full picker in Settings remains the way to any other hue.
 */
function projectSwatchRow(current, onPick) {
  const row = el("div", { className: "swatches", role: "group" });
  row.setAttribute("aria-label", "Project colour");
  for (const hex of PROJECT_COLOURS) {
    const on = (current || "").toLowerCase() === hex;
    const b = el("button", {
      className: "swatch" + (on ? " on" : ""),
      type: "button", title: hex, style: `--task-colour:${hex}`,
    });
    b.setAttribute("aria-label", `Colour ${hex}`);
    b.setAttribute("aria-pressed", String(on));
    b.onclick = (e) => { e.stopPropagation(); onPick(hex); };
    row.append(b);
  }
  return row;
}

/** The swatches as a menu of their own, for anywhere without room to inline them. */
function colourMenu(x, y, task, onPick) {
  rowMenu(x, y, [{ node: swatchRow(task.colour, async (colour) => {
    closeRowMenu();
    await onPick(colour);
  }) }]);
}

/**
 * A card, for the column and board layouts.
 *
 * Deliberately quieter than a row: in a narrow column there is no room for meta,
 * so it carries the title and only what changes a decision.
 */
/**
 * Where a task came from, when it came from a pad.
 *
 * The board is a projection of the pads, and this is the way back to the
 * document being projected. It matters most for the task nobody remembers
 * filing, because an agent wrote the line rather than a person typing it here.
 */
function padChip(t) {
  const chip = el("span", { className: "t-pad", textContent: "pad", tabIndex: 0, role: "button" });
  chip.title = "Read out of a scratchpad. Open it.";
  const go = (e) => {
    if (e) e.stopPropagation();
    state.padId = t.pad_id;
    state.padDraft = null;
    goTo({ projectId: t.project_id || state.projectId, view: "pads" });
  };
  chip.onclick = go;
  chip.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); } };
  return chip;
}

function taskCard(t, { draggable = false, showDue = true } = {}) {
  const card = el("div", { className: "tcard" + (t.status === "done" ? " done" : "") + colourClass(t) });
  card.dataset.taskId = String(t.id);
  card.append(el("div", { className: "tcard-title", textContent: t.title }));

  const foot = el("div", { className: "tcard-foot" });
  if (t.priority === "high") foot.append(el("span", { className: "pill high", textContent: "high" }));
  // Inside a calendar cell the day is the cell, so repeating it on every card is
  // noise. Overdue still says so, because that is not a date, it is a warning.
  if (isOverdue(t)) foot.append(el("span", { className: "pill overdue", textContent: showDue ? t.due : "overdue" }));
  else if (showDue && t.due) foot.append(el("span", { className: "t-due", textContent: t.due }));
  if (t.subtask_count) foot.append(el("span", { className: "t-due", textContent: `${t.subtask_done}/${t.subtask_count}` }));
  if (t.ref) foot.append(el("span", { className: "t-ref", textContent: t.ref }));
  if (t.pad_id) foot.append(padChip(t));
  if (state.projectId && Number(t.associated)) foot.append(fromChip(itemOf("task", t)));
  if (t.assignee) {
    foot.append(el("span", {
      className: "avatar sm" + (isAgent(t.assignee) ? " agent" : ""),
      title: t.assignee,
      textContent: t.assignee.slice(0, 1).toUpperCase(),
    }));
  }
  if (foot.childNodes.length) card.append(foot);

  card.onclick = () => openTaskSheet(t.id);
  card.oncontextmenu = (e) => { e.preventDefault(); taskMenu(t, e.clientX, e.clientY); };
  card.tabIndex = 0;
  card.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); openTaskSheet(t.id); }
    if (e.key === " ") { e.preventDefault(); quickLook(t.id); }
  };

  if (draggable) {
    card.draggable = true;
    card.ondragstart = (e) => {
      e.dataTransfer.setData("text/plain", String(t.id));
      e.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    };
    card.ondragend = () => card.classList.remove("dragging");
  }
  return card;
}

/** One status column, used by both the columns layout and the board. */
function statusColumn(group, { board = false } = {}) {
  const column = el("div", { className: "tcol" });
  const head = el("div", { className: `tcol-head st-${group.status}` });
  head.append(el("span", { className: "tcol-dot" }));
  head.append(el("span", { className: "tcol-name", textContent: group.label }));
  head.append(el("span", { className: "tcol-n", textContent: String(group.tasks.length) }));
  column.append(head);

  const body = el("div", { className: "tcol-body" });
  for (const t of group.tasks) body.append(taskCard(t, { draggable: board }));

  if (!group.tasks.length) {
    body.append(el("div", { className: "tcol-empty", textContent: board ? "Drop here" : "Nothing" }));
  }

  // Adding into a column sets that status, which is what someone means by
  // typing into the Blocked column.
  const add = el("input", { className: "tcol-add", placeholder: "＋ Add" });
  add.onkeydown = async (e) => {
    if (e.key !== "Enter" || !add.value.trim()) return;
    let title = add.value.trim();
    let priority = "med";
    if (title.startsWith("!")) { priority = "high"; title = title.slice(1).trim(); }
    const created = await window.delphi.tasks.create({ projectId: state.projectId, title, priority });
    if (group.status !== "todo") await window.delphi.tasks.update(created.id, { status: group.status });
    add.value = "";
    refresh();
  };

  if (board) {
    const land = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; column.classList.add("over"); };
    column.ondragover = land;
    column.ondragenter = land;
    column.ondragleave = (e) => { if (!column.contains(e.relatedTarget)) column.classList.remove("over"); };
    column.ondrop = async (e) => {
      e.preventDefault();
      column.classList.remove("over");
      const id = Number(e.dataTransfer.getData("text/plain"));
      if (!id) return;
      const moved = state.tasks.find((t) => t.id === id);
      // Dropping a card back where it came from is not a status change, and
      // recording one would put a meaningless entry on the timeline.
      if (!moved || moved.status === group.status) return;
      await window.delphi.tasks.update(id, { status: group.status });
      refresh();
    };
  }

  column.append(body, add);
  return column;
}

/* ---------------------------------------------------------------------------
   The calendar

   A fifth way to look at the same tasks, and the only one that answers what a
   week is actually made of. It reads and writes one field, due, so a card
   dropped on a day is the same edit as typing the date into the sheet, and it
   lands on the timeline like any other change.

   Weeks start on Monday. Every date in the store is an ISO string and ISO weeks
   start there, so a locale-derived first day would put the grid and the data on
   two different calendars.
--------------------------------------------------------------------------- */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// A day with more than this many tasks shows a count instead, so one busy day
// cannot set the height of the whole week.
const CAL_STACK = 3;

// Which month the grid is showing, as YYYY-MM. Module level for the same reason
// the table's selection is: it is where the view is looking, not part of what
// the app loads. Null means the month containing today.
let calendarMonth = null;

const DAY_MS = 86400000;

// The arithmetic is done in UTC off the ISO strings the store already holds, so
// the grid, isOverdue and the Due column can never disagree about which day it
// is. Local components would drift by one whenever the clock is behind UTC.
const dayStamp = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const dayIso = (stamp) => new Date(stamp).toISOString().slice(0, 10);
const monthOf = (iso) => iso.slice(0, 7);

/** The month delta months away. Date.UTC rolls the year over on its own. */
function shiftMonth(month, delta) {
  return monthOf(dayIso(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 + delta, 1)));
}

const monthLabel = (month) =>
  new Date(dayStamp(`${month}-01`)).toLocaleDateString(undefined, {
    month: "long", year: "numeric", timeZone: "UTC",
  });

/**
 * Every day the grid shows, including the days either side that fill the first
 * and last week out. Those days are real due dates, so they carry their tasks
 * rather than being drawn as padding.
 */
function monthGrid(month) {
  const year = +month.slice(0, 4);
  const index = +month.slice(5, 7);
  const first = dayStamp(`${month}-01`);
  const lead = (new Date(first).getUTCDay() + 6) % 7;
  const length = new Date(Date.UTC(year, index, 0)).getUTCDate();
  const start = first - lead * DAY_MS;
  return Array.from({ length: Math.ceil((lead + length) / 7) * 7 }, (_, i) => dayIso(start + i * DAY_MS));
}

/** Tasks split by the day they are due, and the ones that are not due at all. */
function byDueDay(tasks) {
  const days = new Map();
  const undated = [];
  for (const t of tasks) {
    if (!t.due) { undated.push(t); continue; }
    const key = t.due.slice(0, 10);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(t);
  }
  return { days, undated };
}

// Inside a day the order is what is still to do, most urgent first. Finished
// work sinks, because the reason to look at a past day is what is left on it.
const dayOrder = (a, b) =>
  Number(a.status === "done") - Number(b.status === "done") ||
  Number(b.priority === "high") - Number(a.priority === "high") ||
  a.id - b.id;

/**
 * Writes a due date from a drop.
 *
 * Dropping a card back on the day it already has is not an edit, and recording
 * one would put a meaningless entry on the timeline. This is the same bargain
 * the board makes with status.
 */
async function setDue(id, due) {
  const moved = state.tasks.find((t) => t.id === id);
  if (!moved || (moved.due ? moved.due.slice(0, 10) : null) === due) return;
  await window.delphi.tasks.update(id, { due });
  refresh();
}

/** Makes a node a landing place for a card, the way a board column is. */
function acceptsDue(node, due) {
  const land = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; node.classList.add("over"); };
  node.ondragover = land;
  node.ondragenter = land;
  node.ondragleave = (e) => { if (!node.contains(e.relatedTarget)) node.classList.remove("over"); };
  node.ondrop = (e) => {
    e.preventDefault();
    node.classList.remove("over");
    const id = Number(e.dataTransfer.getData("text/plain"));
    if (id) setDue(id, due);
  };
}

/** One day. */
function calendarDay(iso, tasks, month) {
  const now = today();
  const cell = el("div", {
    className: "cal-day"
      + (monthOf(iso) === month ? "" : " out")
      + (iso === now ? " today" : iso < now ? " past" : ""),
  });
  cell.setAttribute("aria-label", iso);

  const head = el("div", { className: "cal-daynum" });
  head.append(el("span", { className: "cal-n", textContent: String(+iso.slice(8, 10)) }));
  if (iso === now) head.append(el("span", { className: "cal-mark", textContent: "today" }));
  head.append(el("span", { className: "grow" }));

  // Typing into a day sets that due date, which is what someone means by
  // starting a task on a Thursday, exactly as typing into a column sets status.
  const add = el("button", { className: "cal-add", textContent: "＋", title: `Add a task due ${iso}` });
  add.onclick = (e) => {
    e.stopPropagation();
    if (cell.querySelector(".cal-field")) return;
    const field = el("input", { className: "cal-field", placeholder: "Task" });
    field.onkeydown = async (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") { field.remove(); return; }
      if (ev.key !== "Enter" || !field.value.trim()) return;
      let title = field.value.trim();
      let priority = "med";
      if (title.startsWith("!")) { priority = "high"; title = title.slice(1).trim(); }
      await window.delphi.tasks.create({ projectId: state.projectId, title, priority, due: iso });
      refresh();
    };
    field.onblur = () => field.remove();
    cell.append(field);
    field.focus();
  };
  head.append(add);
  cell.append(head);

  const stack = el("div", { className: "cal-stack" });
  const ordered = [...tasks].sort(dayOrder);
  for (const t of ordered.slice(0, CAL_STACK)) stack.append(taskCard(t, { draggable: true, showDue: false }));

  const rest = ordered.slice(CAL_STACK);
  if (rest.length) {
    const more = el("button", { className: "cal-more", textContent: `${rest.length} more` });
    // Expanded in place rather than through a repaint: nothing in the store has
    // changed, and re-rendering to show three more cards would also throw away
    // every other cell someone had already opened.
    more.onclick = (e) => {
      e.stopPropagation();
      more.remove();
      for (const t of rest) stack.append(taskCard(t, { draggable: true, showDue: false }));
    };
    stack.append(more);
  }
  cell.append(stack);

  acceptsDue(cell, iso);
  return cell;
}

/**
 * The tasks with no due date.
 *
 * They sit under the grid rather than being left out of it. A calendar that can
 * only show dated work quietly hides everything that has not been scheduled,
 * which is the half most likely to need scheduling. Here they are visible,
 * countable, and a drag away from having a date. Dropping a card back on the
 * tray takes the date off again, so the move is reversible by the same gesture.
 */
function undatedTray(tasks) {
  const tray = el("section", { className: "cal-tray" });

  const head = el("div", { className: "cal-tray-head" });
  head.append(el("span", { className: "tcol-dot" }));
  head.append(el("span", { className: "tcol-name", textContent: "No due date" }));
  head.append(el("span", { className: "tcol-n", textContent: String(tasks.length) }));
  head.append(el("span", { className: "grow" }));
  head.append(el("span", { className: "cal-hint", textContent: "Drag onto a day to schedule" }));
  tray.append(head);

  const body = el("div", { className: "cal-tray-body" });
  if (!tasks.length) body.append(el("div", { className: "tcol-empty", textContent: "Drop here to clear a date" }));
  for (const t of tasks) body.append(taskCard(t, { draggable: true }));
  tray.append(body);

  acceptsDue(tray, null);
  return tray;
}

/** A chip that jumps to the month holding the nearest work outside this one. */
function calendarJump(label, month) {
  const chip = el("button", { className: "btn sm", textContent: label, title: `Go to ${monthLabel(month)}` });
  chip.onclick = () => { calendarMonth = month; render(); };
  return chip;
}

function renderTaskCalendar(root, tasks) {
  const month = calendarMonth || monthOf(today());
  calendarMonth = month;
  const { days, undated } = byDueDay(tasks);

  const head = el("div", { className: "cal-head" });
  head.append(el("div", { className: "cal-title", textContent: monthLabel(month) }));

  const nav = el("div", { className: "cal-nav" });
  const step = (label, title, delta) => {
    const b = el("button", { className: "btn sm icon", textContent: label, title });
    // Moving months changes nothing in the store and every task of the project
    // is already loaded, so this repaints rather than reloading.
    b.onclick = () => { calendarMonth = shiftMonth(month, delta); render(); };
    return b;
  };
  const home = el("button", { className: "btn sm", textContent: "Today", title: "Back to this month" });
  home.onclick = () => { calendarMonth = monthOf(today()); render(); };
  nav.append(step("‹", "Previous month", -1), home, step("›", "Next month", 1));
  head.append(el("span", { className: "grow" }), nav);
  root.append(head);

  const scroll = el("div", { className: "cal-scroll" });
  const grid = el("div", { className: "cal-grid" });
  for (const name of WEEKDAYS) grid.append(el("div", { className: "cal-dow", textContent: name }));
  for (const iso of monthGrid(month)) grid.append(calendarDay(iso, days.get(iso) || [], month));
  scroll.append(grid);
  root.append(scroll);

  // Work in another month is reachable by stepping, but only if someone knows it
  // is there. These say so, and land on the nearest month that has any.
  const outside = tasks.filter((t) => t.due && monthOf(t.due) !== month);
  const earlier = outside.filter((t) => monthOf(t.due) < month);
  const later = outside.filter((t) => monthOf(t.due) > month);
  if (earlier.length || later.length) {
    const foot = el("div", { className: "cal-foot" });
    if (earlier.length) {
      const nearest = earlier.reduce((a, b) => (a.due > b.due ? a : b)).due;
      foot.append(calendarJump(`‹ ${plural(earlier.length, "task", "tasks")} earlier`, monthOf(nearest)));
    }
    if (later.length) {
      const nearest = later.reduce((a, b) => (a.due < b.due ? a : b)).due;
      foot.append(calendarJump(`${plural(later.length, "task", "tasks")} later ›`, monthOf(nearest)));
    }
    root.append(foot);
  }

  root.append(undatedTray(undated));
}

/** The composer at the top of the flat list. */
function taskComposer() {
  const input = el("input", { className: "field", placeholder: "Add a task and press Enter. Start with ! for high priority." });
  // One quick-entry draft per place it can be typed in: a project, or all work.
  const draftId = state.projectId || "all";
  if (window.DelphiRecovery) DelphiRecovery.bindDraft(input, "quick", draftId);
  input.onkeydown = async (e) => {
    if (e.key !== "Enter" || !input.value.trim()) return;
    let title = input.value.trim();
    let priority = "med";
    if (title.startsWith("!")) { priority = "high"; title = title.slice(1).trim(); }
    const ref = (title.match(/\b([A-Z][A-Z0-9]+-\d+)\b/) || [])[1] || null;
    await window.delphi.tasks.create({ projectId: state.projectId, title, priority, ref });
    input.value = "";
    if (window.DelphiRecovery) DelphiRecovery.clearDraft("quick", draftId);
    refresh();
  };
  return input;
}

/* ---------------------------------------------------------------------------
   The table view, and selecting more than one thing

   A table is the layout for scanning many tasks against the same few fields:
   columns line up, so the eye compares down a column instead of reading every
   row. The row still opens the task, and the controls sit at the end where they
   do not compete with it.

   Selection exists because some jobs are about several tasks at once. Ticking
   rows one at a time and then repeating the same menu on each is the thing a
   floating bar removes.
--------------------------------------------------------------------------- */

const selected = new Set();

function clearSelection() {
  selected.clear();
  const bar = document.getElementById("bulk-bar");
  if (bar) bar.remove();
  for (const box of document.querySelectorAll(".row-check.on")) box.classList.remove("on");
  for (const row of document.querySelectorAll(".trow.picked")) row.classList.remove("picked");
}

/**
 * The bar that appears once something is selected.
 *
 * Floating rather than a toolbar at the top, so it is near the pointer that just
 * made the selection and does not push the table around when it appears.
 */
function paintBulkBar() {
  const existing = document.getElementById("bulk-bar");
  if (!selected.size) { if (existing) existing.remove(); return; }

  const bar = existing || el("div", { className: "bulk-bar", id: "bulk-bar" });
  bar.textContent = "";
  bar.append(el("span", { className: "bulk-count",
    textContent: `${selected.size} ${selected.size === 1 ? "task" : "tasks"} selected` }));

  const ids = () => [...selected];
  const act = async (fn, label) => {
    // Sequential rather than parallel: these are writes to one SQLite file, and
    // twenty at once would spend their time waiting on each other's locks.
    for (const id of ids()) await fn(id);
    clearSelection();
    refresh();
  };

  const button = (label, title, run, danger = false) => {
    const b = el("button", { className: "bulk-btn" + (danger ? " danger" : ""), textContent: label, title });
    b.onclick = run;
    return b;
  };

  bar.append(
    button("Done", "Mark every selected task done",
      () => act((id) => window.delphi.tasks.update(id, { status: "done" }))),
    button("Start", "Move every selected task to in progress",
      () => act((id) => window.delphi.tasks.update(id, { status: "doing" }))),
    button("Queue", "Send every selected task to the agent queue",
      () => act((id) => window.delphi.tasks.queue(id, "ready"))),
    button("Delete", "Delete every selected task",
      async () => {
        const n = selected.size;
        await act((id) => removeTask(id));
        setTimeout(() => alert(`${n} ${n === 1 ? "task" : "tasks"} deleted. Restore from this project's History tab.`), 30);
      }, true)
  );

  const close = el("button", { className: "bulk-close", textContent: "✕", title: "Clear selection" });
  close.onclick = clearSelection;
  bar.append(close);

  if (!existing) document.body.append(bar);
}

function toggleSelected(id, rowEl, boxEl) {
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  boxEl.classList.toggle("on", selected.has(id));
  rowEl.classList.toggle("picked", selected.has(id));
  paintBulkBar();
}

/** A tick box that selects rather than completes. */
function selectBox(t, row) {
  const box = el("span", { className: "row-check" + (selected.has(t.id) ? " on" : ""), role: "checkbox", tabIndex: 0 });
  box.setAttribute("aria-checked", String(selected.has(t.id)));
  const hit = (e) => { e.stopPropagation(); toggleSelected(t.id, row, box); };
  box.onclick = hit;
  box.onkeydown = (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); hit(e); } };
  return box;
}

const TABLE_COLUMNS = ["", "Task", "Status", "Assignee", "Due", "Priority", ""];

/** One task as a table row. */
function taskTableRow(t) {
  const row = el("div", { className: "trow" + (t.status === "done" ? " done" : "") + (selected.has(t.id) ? " picked" : "") + colourClass(t) });
  row.dataset.taskId = String(t.id);

  row.append(selectBox(t, row));

  const name = el("div", { className: "tcell tcell-name" });
  name.append(el("span", { className: "trow-title", textContent: t.title }));
  const under = el("span", { className: "trow-sub" });
  if (!state.projectId && t.project_name) under.append(projectOwner(t));
  if (t.ref) under.append(el("span", { className: "t-ref", textContent: t.ref }));
  if (t.subtask_count) under.append(el("span", { textContent: `${t.subtask_done}/${t.subtask_count}` }));
  if (t.comment_count) under.append(el("span", { textContent: `${t.comment_count} ✦` }));
  if (t.queue) under.append(el("span", { className: "queued-mark", textContent: t.claimed_by ? `◆ ${t.claimed_by}` : "◆ queued" }));
  if (under.childNodes.length) name.append(under);
  row.append(name);

  // Status is a control here rather than a label: in a table the whole point is
  // changing one field across many rows without opening any of them.
  const statusCell = el("div", { className: "tcell" });
  const status = el("select", { className: `cell-select st-${statusOf(t)}` });
  for (const [value, label] of BOARD_COLUMNS) {
    status.append(el("option", { value, textContent: label, selected: statusOf(t) === value }));
  }
  status.onclick = (e) => e.stopPropagation();
  status.onchange = async (e) => {
    e.stopPropagation();
    await window.delphi.tasks.update(t.id, { status: status.value });
    refresh();
  };
  statusCell.append(status);
  row.append(statusCell);

  const who = el("div", { className: "tcell" });
  if (t.assignee) {
    who.append(el("span", { className: "avatar sm" + (isAgent(t.assignee) ? " agent" : ""), textContent: t.assignee.slice(0, 1).toUpperCase() }));
    who.append(el("span", { className: "cell-text", textContent: t.assignee }));
  } else {
    who.append(el("span", { className: "cell-empty", textContent: "unassigned" }));
  }
  row.append(who);

  const due = el("div", { className: "tcell" });
  if (isOverdue(t)) due.append(el("span", { className: "pill overdue", textContent: t.due }));
  else if (t.due) due.append(el("span", { className: "cell-text", textContent: t.due }));
  else due.append(el("span", { className: "cell-empty", textContent: "no date" }));
  row.append(due);

  const priority = el("div", { className: "tcell" });
  priority.append(el("span", { className: "pill " + (t.priority === "high" ? "high" : "muted"), textContent: t.priority }));
  row.append(priority);

  const actions = el("div", { className: "tcell tcell-actions" });
  const open = el("button", { className: "row-btn", textContent: "Open", title: "Open the task" });
  open.onclick = (e) => { e.stopPropagation(); openTaskSheet(t.id); };
  const look = el("button", { className: "row-btn", textContent: "Look", title: "Quick look" });
  look.onclick = (e) => { e.stopPropagation(); quickLook(t.id); };
  const more = el("button", { className: "row-btn icon", textContent: "⋯", title: "Actions" });
  more.onclick = (e) => {
    e.stopPropagation();
    const box = more.getBoundingClientRect();
    taskMenu(t, box.left - 150, box.bottom + 4);
  };
  actions.append(open, look, more);
  row.append(actions);

  row.onclick = () => openTaskSheet(t.id);
  row.oncontextmenu = (e) => { e.preventDefault(); taskMenu(t, e.clientX, e.clientY); };
  return row;
}

/** The table, grouped by status the way the references group it. */
function renderTaskTable(root, tasks) {
  const table = el("section", { className: "ttable" });

  const header = el("div", { className: "trow thead" });
  header.append(el("span", { className: "row-check head", title: "Select all" }));
  for (const label of TABLE_COLUMNS.slice(1)) header.append(el("div", { className: "tcell", textContent: label }));
  // Select all is the one place the header box does something.
  const all = header.querySelector(".row-check");
  all.onclick = () => {
    const everyone = tasks.every((t) => selected.has(t.id));
    if (everyone) clearSelection();
    else { for (const t of tasks) selected.add(t.id); refreshSelectionMarks(); paintBulkBar(); }
  };
  table.append(header);

  for (const group of groupByStatus(tasks)) {
    if (!group.tasks.length) continue;
    const head = el("div", { className: `tgroup st-${group.status}` });
    head.append(el("span", { className: "tcol-dot" }));
    head.append(el("span", { className: "tgroup-name", textContent: group.label }));
    head.append(el("span", { className: "tcol-n", textContent: String(group.tasks.length) }));
    table.append(head);
    for (const t of group.tasks) table.append(taskTableRow(t));
  }

  root.append(table);
}

/** Marks every row as selected after a select all, without a full re-render. */
function refreshSelectionMarks() {
  for (const box of document.querySelectorAll(".trow:not(.thead) .row-check")) box.classList.add("on");
  for (const row of document.querySelectorAll(".trow:not(.thead)")) row.classList.add("picked");
}

function renderTasks(root) {
  const mode = state.projectId && !state.query ? taskViewMode() : "list";

  if (!state.query) {
    const bar = el("div", { className: "add-row" });
    // The composer belongs to the flat list. The other two put an input at the
    // foot of each column, where it also decides the status.
    if (mode === "list") bar.append(taskComposer());
    else bar.append(el("span", { className: "grow" }));
    const toggle = el("button", { className: "btn", textContent: state.showDone ? "Hide done" : "Show done" });
    toggle.onclick = () => { state.showDone = !state.showDone; refresh(); };
    bar.append(toggle);
    // Only inside a project: All work spans several and a per-project setting
    // has nothing to attach to.
    if (state.projectId) bar.append(viewPicker());
    if (state.projectId) bar.append(newEpicButton());
    root.append(bar);
  }

  // Applied here rather than in refresh so the tab count keeps reporting the
  // whole list, and clearing the filter is a render away rather than a reload.
  const filters = {
    doing: [(t) => statusOf(t) === "doing", "in progress"],
    blocked: [(t) => t.status === "blocked", "blocked"],
    overdue: [isOverdue, "overdue"],
    done: [(t) => t.status === "done", "done"],
  };
  const active = filters[state.taskFilter];
  let shown = active ? state.tasks.filter(active[0]) : state.tasks;

  if (active) {
    const clear = el("button", { className: "btn sm", textContent: "Clear filter" });
    clear.onclick = () => { state.taskFilter = null; refresh(); };
    root.append(el("div", { className: "filter-note" },
      el("span", { textContent: `Showing ${plural(shown.length, "task", "tasks")} ${active[1]}` }),
      clear));
  }

  // Epics separate the flat list into groups. The board and the two column
  // layouts already group by status, so there an epic narrows what is shown
  // rather than adding a second axis: a grid of mostly empty cells is harder to
  // read than either axis on its own.
  const epics = !state.query && state.projectId && state.organizers.length > 0;
  if (epics && mode !== "list") {
    root.append(epicStrip());
    if (validEpicFilter() !== null) shown = shown.filter(epicFilterOf(state.epicFilter));
  }

  // The columns and the board keep their shape when empty, because an empty
  // column is information and a board that vanishes when the last task moves is
  // disorienting.
  clearSelection();

  if (!shown.length && mode === "list" && !epics) {
    root.append(emptyState(
      state.query ? "Nothing matched" : active ? `Nothing ${active[1]}` : "No open tasks",
      state.query ? "Try a different word." : active ? "Clear the filter to see the rest." : "Add one above."));
    return;
  }

  if (mode === "list") {
    if (epics) {
      renderEpicList(root, shown);
    } else {
      const list = el("section", { className: "card" });
      shown.forEach((t) => list.append(taskRow(t)));
      root.append(list);
    }
  } else if (mode === "table") {
    renderTaskTable(root, shown);
  } else if (mode === "calendar") {
    renderTaskCalendar(root, shown);
  } else {
    // Done is hidden by default everywhere else, so a Done column that is always
    // empty would be a lie. It appears only when done work is being shown.
    const groups = groupByStatus(shown).filter((g) => g.status !== "done" || state.showDone || g.tasks.length);
    const wrap = el("div", { className: "tcols" + (mode === "board" ? " board" : "") });
    for (const group of groups) wrap.append(statusColumn(group, { board: mode === "board" }));
    root.append(wrap);
  }

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

/* ---------------------------------------------------------------------------
   Row menus and quick look

   The row used to carry eleven separate controls: a status cycler, a project
   dropdown, a notes toggle, a delete, and a chip for every attribute. Between
   them there was barely any row left to click, and the one thing anyone wants,
   opening the task, was the hardest target on it.

   The row now shows what you scan for and nothing else. Everything that was a
   button lives in a menu on right click, and a quick look reads the task without
   opening it.
--------------------------------------------------------------------------- */

let openMenu = null;
let onMenuClose = null;

function closeRowMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  // Read and cleared before it runs, so a handler that opens another menu
  // cannot have its own callback wiped by the one it replaced.
  const done = onMenuClose;
  onMenuClose = null;
  if (done) done();
}

/**
 * A menu at a point on screen.
 *
 * Kept inside the viewport rather than allowed to run off the bottom, because a
 * menu opened on the last row of a long list is exactly where that happens.
 *
 * An item is a verb, a separator, or a node the caller built itself. The verb
 * form stays the common case, because most menus are a list of things to do and
 * should not have to build anything to say so.
 */
function rowMenu(x, y, items, { onClose = null, className = "" } = {}) {
  closeRowMenu();
  // The extra class goes on before the measurement below, not after. It is what
  // sets the width and the height cap, so clamping first would fit the menu to
  // the viewport at a size it is about to stop being.
  const menu = el("div", { className: "ctx" + (className ? ` ${className}` : "") });
  for (const item of items) {
    if (item === "-") { menu.append(el("div", { className: "ctx-sep" })); continue; }
    if (item.nodeType) { menu.append(item); continue; }
    if (item.node) { menu.append(item.node); continue; }
    const b = el("button", { className: "ctx-item" + (item.danger ? " danger" : ""), textContent: item.label });
    b.onclick = async () => { closeRowMenu(); await item.run(); };
    menu.append(b);
  }
  menu.style.left = "0px";
  menu.style.top = "0px";
  document.body.append(menu);

  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - box.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - box.height - 8)}px`;

  openMenu = menu;
  onMenuClose = onClose;
  // Bound after this click finishes, or the click that opened it closes it.
  setTimeout(() => {
    const away = (e) => {
      if (!menu.contains(e.target)) { closeRowMenu(); document.removeEventListener("mousedown", away); }
    };
    document.addEventListener("mousedown", away);
  }, 0);
  return menu;
}

const STATUS_WORD = { todo: "To do", doing: "In progress", blocked: "Blocked", done: "Done" };

/**
 * The task at a glance, without opening it.
 *
 * Read only on purpose. It answers "what is this" in one keypress and gets out
 * of the way; anything that changes the task happens in the task.
 */
async function quickLook(taskId) {
  const detail = await window.delphi.tasks.detail(taskId);
  if (!detail) return;
  const t = detail.task;

  const overlay = el("div", { className: "overlay" });
  const card = el("div", { className: "qlook", role: "dialog" });
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", "Quick look");

  card.append(el("div", { className: "qlook-head" },
    el("span", { className: `dot-status st-${statusOf(t)}` }),
    el("h3", { textContent: t.title })));

  const rows = [
    ["Status", STATUS_WORD[statusOf(t)]],
    ["Priority", t.priority],
    ["Assignee", t.assignee || "unassigned"],
    ["Due", t.due || "no due date"],
    ["Project", detail.project ? detail.project.name : "none"],
    ["Reference", t.ref || "none"],
    ["Colour", colourLabel(t.colour) || "none"],
    ["Subtasks", detail.subtasks.length
      ? `${detail.subtasks.filter((s) => s.status === "done").length} of ${detail.subtasks.length} done`
      : "none"],
    ["Sheet", detail.comments.length ? plural(detail.comments.length, "entry", "entries") : "nothing yet"],
    ["Created", ago(t.created_at)],
  ];
  const grid = el("div", { className: "qlook-grid" });
  for (const [label, value] of rows) {
    grid.append(el("span", { className: "qlook-label", textContent: label }));
    grid.append(el("span", { className: "qlook-value", textContent: value }));
  }
  card.append(grid);

  if (t.detail) {
    const body = el("div", { className: "qlook-detail" });
    body.append(renderMarkdown(t.detail));
    card.append(body);
  }

  const close = async () => { overlay.remove(); openSheet = null; };
  const foot = el("div", { className: "qlook-foot" });
  const openIt = el("button", { className: "btn primary", textContent: "Open task" });
  openIt.onclick = async () => { await close(); openTaskSheet(taskId); };
  const shut = el("button", { className: "btn", textContent: "Close" });
  shut.onclick = close;
  foot.append(el("span", { className: "hint", textContent: "Escape to close" }), openIt, shut);
  card.append(foot);

  overlay.append(card);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.body.append(overlay);
  openSheet = { overlay, close };
  openIt.focus();
}

/** The menu a task row offers, used by right click and by the row's own button. */
function taskMenu(t, x, y, { after = null } = {}) {
  const repaint = async () => { refresh(); if (after) await after(); };
  const set = async (fields) => { await window.delphi.tasks.update(t.id, fields); await repaint(); };

  // Moving goes through the picker, which asks the store for a plan first: a
  // task carries its subtasks, its Sheet and maybe a Workbench, and a bare
  // project_id write would leave some of that behind.
  const item = itemOf("task", t);
  const moves = itemVerbs(item, { after, withIcons: false });

  const opener = document.activeElement;
  menuKeys(rowMenu(x, y, [
    { label: "Open", run: () => openTaskSheet(t.id) },
    { label: "Quick look", run: () => quickLook(t.id) },
    "-",
    { node: swatchRow(t.colour, async (colour) => { closeRowMenu(); await set({ colour }); }) },
    "-",
    ...(t.status === "done"
      ? [{ label: "Reopen", run: () => set({ status: "todo" }) }]
      : [{ label: "Mark done", run: () => set({ status: "done" }) }]),
    ...(statusOf(t) === "doing" ? [] : [{ label: "Start", run: () => set({ status: "doing" }) }]),
    ...(t.status === "blocked"
      ? [{ label: "Unblock", run: () => set({ status: "todo" }) }]
      : [{ label: "Block", run: () => set({ status: "blocked" }) }]),
    "-",
    ...(t.queue
      ? [{ label: "Take out of the agent queue", run: async () => { await window.delphi.tasks.queue(t.id, null); await repaint(); } }]
      : [{ label: "Send to the agent queue", run: async () => { await window.delphi.tasks.queue(t.id, "ready"); await repaint(); } }]),
    "-",
    ...epicMenuItems(t, repaint),
    ...moves,
    "-",
    // Said where it happened, because that is when someone needs to know it
    // is not final. deleteItem warns first when the task is only shown here.
    { label: "Delete", danger: true, run: () => deleteItem(item, { after }) },
  ]), opener);
}

// ---------------------------------------------------------------------------
// Epics
//
// Optional is the whole point. A project with no organizers renders exactly as
// it did before this existed, plus one button offering to start. There is no
// setting to turn them on, because a stored flag is a second answer to "does
// this project use epics" and the two can disagree: enabled with none made
// looks broken, disabled with some made hides work. Having one is the answer.
// ---------------------------------------------------------------------------

/** Collapsed epics, by id. Deliberately not persisted: it is a reading
    position, not a preference, and it should not follow you to tomorrow. */
const collapsedEpics = new Set();

/** An organizer's own colour, falling back to the project it lives in. */
function epicColour(o) {
  const project = currentProject();
  return o.colour || (project && project.colour) || "var(--ink-faint)";
}

/** Drops a filter left pointing at an epic that has since gone. */
function validEpicFilter() {
  if (state.epicFilter == null) return null;
  if (state.epicFilter === "none") return "none";
  if (!state.organizers.some((o) => o.id === state.epicFilter)) state.epicFilter = null;
  return state.epicFilter;
}

const epicFilterOf = (value) =>
  value === "none" ? (t) => t.organizer_id == null : (t) => t.organizer_id === value;

/**
 * Tasks split into their epics, in the project's own epic order.
 *
 * An epic holding nothing at all is kept, because an empty epic is a commitment
 * someone made and hiding it until it has work is how the same epic gets
 * created twice. An epic whose work is merely filtered out of view is dropped,
 * because that is not an empty epic, it is a hidden one, and a page of empty
 * headers after "Hide done" would say nothing.
 */
function groupByOrganizer(tasks) {
  const groups = state.organizers.map((o) => ({ organizer: o, tasks: [] }));
  const index = new Map(groups.map((g) => [g.organizer.id, g]));
  const loose = { organizer: null, tasks: [] };
  for (const t of tasks) {
    const group = t.organizer_id == null ? null : index.get(t.organizer_id);
    (group || loose).tasks.push(t);
  }
  const kept = groups.filter((g) => g.tasks.length || g.organizer.total_count === 0);
  return loose.tasks.length ? [...kept, loose] : kept;
}

/** The head of one epic: what it is, how far along, and what can be done to it. */
function epicHead(o) {
  const head = el("div", { className: "epic-head" });
  const shut = collapsedEpics.has(o.id);

  const fold = el("button", { className: "epic-fold", type: "button", textContent: shut ? "▸" : "▾" });
  fold.title = shut ? "Expand" : "Collapse";
  fold.setAttribute("aria-expanded", String(!shut));
  fold.setAttribute("aria-label", `${shut ? "Expand" : "Collapse"} ${o.name}`);
  // render rather than refresh: folding is a change to what is drawn, not to
  // anything the database knows, and a round trip would be a visible stutter.
  fold.onclick = (e) => {
    e.stopPropagation();
    if (shut) collapsedEpics.delete(o.id); else collapsedEpics.add(o.id);
    render();
  };
  head.append(fold);

  head.append(el("span", { className: "epic-dot", style: `background:${safeColour(epicColour(o))}` }));

  const naming = el("div", { className: "epic-naming" });
  naming.append(el("div", { className: "epic-name", textContent: o.name }));
  if (o.summary) naming.append(el("div", { className: "epic-sum", textContent: o.summary }));
  head.append(naming);

  const done = o.total_count - o.open_count;
  if (o.total_count) {
    head.append(el("span", { className: "epic-n", textContent: `${done}/${o.total_count}` }));
    const bar = el("span", { className: "epic-bar" });
    bar.append(el("span", { className: "epic-bar-fill", style: `width:${Math.round((done / o.total_count) * 100)}%` }));
    head.append(bar);
  } else {
    head.append(el("span", { className: "epic-n empty", textContent: "empty" }));
  }

  const more = el("button", { className: "epic-more", type: "button", textContent: "⋯", title: "Epic actions" });
  more.setAttribute("aria-label", `Actions for ${o.name}`);
  more.onclick = (e) => {
    e.stopPropagation();
    const box = more.getBoundingClientRect();
    epicMenu(o, box.left - 160, box.bottom + 4);
  };
  head.append(more);

  head.onclick = () => fold.click();
  return head;
}

/** The bucket for work that is in no epic. Quieter, and always last. */
function looseHead(count) {
  const head = el("div", { className: "epic-head loose" });
  head.append(el("span", { className: "epic-name", textContent: "Not in an epic" }));
  head.append(el("span", { className: "epic-n", textContent: String(count) }));
  return head;
}

/** Adding here files the task into this epic, which is what typing here means. */
function epicComposer(o) {
  const add = el("input", { className: "epic-add", placeholder: `＋ Add to ${o.name}` });
  add.setAttribute("aria-label", `Add a task to ${o.name}`);
  add.onkeydown = async (e) => {
    if (e.key !== "Enter" || !add.value.trim()) return;
    let title = add.value.trim();
    let priority = "med";
    if (title.startsWith("!")) { priority = "high"; title = title.slice(1).trim(); }
    const ref = (title.match(/\b([A-Z][A-Z0-9]+-\d+)\b/) || [])[1] || null;
    await window.delphi.tasks.create({
      projectId: state.projectId, title, priority, ref, organizerId: o.id,
    });
    add.value = "";
    refresh();
  };
  return add;
}

function epicMenu(o, x, y) {
  const rename = async () => {
    const name = await askText({
      title: "Rename epic",
      value: o.name,
      confirmLabel: "Rename",
    });
    if (!name || name.trim() === o.name) return;
    await window.delphi.organizers.update(o.id, { name: name.trim() });
    refresh();
  };
  const describe = async () => {
    const summary = await askText({
      title: "Describe epic",
      label: "One line: what this epic covers. Leave it empty to clear it.",
      value: o.summary || "",
      confirmLabel: "Save",
      allowEmpty: true,
    });
    if (summary === null) return;
    await window.delphi.organizers.update(o.id, { summary: summary.trim() || null });
    refresh();
  };
  const remove = async () => {
    // Asked before rather than reported after, which is the opposite of the way
    // a deleted task is handled. A task can be restored from the History tab
    // and an epic cannot, so this is the one delete that has to be agreed to.
    const warning = o.total_count
      ? `Delete the epic “${o.name}”?\n\nIts ${plural(o.total_count, "task", "tasks")} stay in the project and stop being grouped. The epic itself cannot be restored.`
      : `Delete the epic “${o.name}”?\n\nIt cannot be restored.`;
    if (!confirm(warning)) return;
    await window.delphi.organizers.remove(o.id);
    collapsedEpics.delete(o.id);
    if (state.epicFilter === o.id) state.epicFilter = null;
    refresh();
  };

  rowMenu(x, y, [
    { label: "Rename", run: rename },
    { label: o.summary ? "Edit the summary" : "Add a summary", run: describe },
    "-",
    { label: "Collapse every epic", run: () => { state.organizers.forEach((e) => collapsedEpics.add(e.id)); render(); } },
    { label: "Expand every epic", run: () => { collapsedEpics.clear(); render(); } },
    "-",
    { label: "Delete the epic", danger: true, run: remove },
  ]);
}

/** The flat list, separated into epics. */
function renderEpicList(root, tasks) {
  for (const group of groupByOrganizer(tasks)) {
    const o = group.organizer;
    const section = el("section", { className: "card epic" });
    section.append(o ? epicHead(o) : looseHead(group.tasks.length));

    if (o && collapsedEpics.has(o.id)) { root.append(section); continue; }

    group.tasks.forEach((t) => section.append(taskRow(t)));
    if (o) {
      if (!group.tasks.length) {
        section.append(el("div", { className: "epic-empty", textContent: "Nothing in this epic yet." }));
      }
      section.append(epicComposer(o));
    }
    root.append(section);
  }
}

/**
 * Epics as a filter, for the layouts that already group by something else.
 *
 * The board and the two column layouts group by status. Grouping by epic as
 * well would be a grid, and a grid of mostly empty cells is harder to read than
 * either axis alone. So there the epic narrows what is on the board rather than
 * adding a second dimension to it.
 */
function epicStrip() {
  const strip = el("div", { className: "epic-strip", role: "group" });
  strip.setAttribute("aria-label", "Narrow to one epic");
  const active = validEpicFilter();

  const chip = (label, value, count, colour) => {
    const on = active === value;
    const b = el("button", { className: "epic-chip" + (on ? " on" : ""), type: "button" });
    b.setAttribute("aria-pressed", String(on));
    if (colour) b.append(el("span", { className: "epic-dot", style: `background:${safeColour(colour)}` }));
    b.append(el("span", { textContent: label }));
    if (count != null) b.append(el("span", { className: "epic-chip-n", textContent: String(count) }));
    b.onclick = () => { state.epicFilter = on ? null : value; refresh(); };
    return b;
  };

  strip.append(chip("Everything", null, null, null));
  for (const o of state.organizers) strip.append(chip(o.name, o.id, o.open_count, epicColour(o)));
  const loose = state.tasks.filter((t) => t.organizer_id == null).length;
  if (loose) strip.append(chip("Not in an epic", "none", loose, null));
  return strip;
}

/**
 * The way in, and the way to add another.
 *
 * Worded as an offer the first time, because the first press is a decision
 * about how this project is going to be organised and the ones after it are
 * not.
 */
function newEpicButton() {
  const first = !state.organizers.length;
  const b = el("button", { className: "btn sm", textContent: first ? "Group into epics" : "New epic" });
  b.title = first
    ? "Wrap this project's tasks in epics. Nothing moves until you put something in one."
    : "Add another epic to this project";
  b.onclick = async () => {
    const name = await askText({
      title: first ? "Name the first epic" : "Name the epic",
      label: "Epics group a project's tasks. Nothing moves until you put something in one.",
    });
    if (!name) return;
    await window.delphi.organizers.create({ projectId: state.projectId, name: name.trim() });
    refresh();
  };
  return b;
}

/**
 * The epic entries for a task's right click menu.
 *
 * Empty for a project with no epics and for a subtask, so the menu never offers
 * to file something into nothing or to split a task from its parent.
 */
function epicMenuItems(t, repaint = refresh) {
  if (!state.organizers.length || t.parent_id) return [];
  const set = async (organizerId) => {
    await window.delphi.tasks.update(t.id, { organizer_id: organizerId });
    await repaint();
  };
  const items = state.organizers
    .filter((o) => o.id !== t.organizer_id)
    .slice(0, 8)
    .map((o) => ({ label: `File under ${o.name}`, run: () => set(o.id) }));
  if (t.organizer_id) items.push({ label: "Take out of its epic", run: () => set(null) });
  return items.length ? [...items, "-"] : [];
}

/**
 * One task, as a line.
 *
 * Only what someone scans for: whether it is done, what it is called, and the
 * two or three facts that decide whether to look closer. Everything else is a
 * right click away, so the row itself stays a target rather than a toolbar.
 */
function taskRow(t) {
  const row = el("div", { className: "task" + (t.status === "done" ? " done" : "") + colourClass(t) });
  row.dataset.taskId = String(t.id);

  const check = el("div", { className: "check", textContent: "✓", tabIndex: 0, role: "checkbox" });
  check.setAttribute("aria-checked", String(t.status === "done"));
  const toggle = async (e) => {
    if (e) e.stopPropagation();
    const completing = t.status !== "done";

    // Started before the animation, not after. What is being waited on is the
    // celebration, not the write: closing the window part way through has to
    // still leave the task done.
    const saved = window.delphi.tasks.update(t.id, { status: completing ? "done" : "todo" });

    if (!completing) {
      await saved;
      refresh();
      return;
    }

    celebrateDone(row);
    await saved;
    // Long enough to see it, short enough not to be in the way of ticking off
    // the next one. Skipped entirely when animations are turned off, since
    // there would be nothing to wait for.
    setTimeout(refresh, motionOff() ? 0 : 640);
  };
  check.onclick = toggle;
  check.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
  row.append(check);

  const body = el("div", { className: "t-body" });
  const heading = el("div", { className: "t-title", textContent: t.title });
  body.append(heading);

  // A second line only when there is something worth putting on it.
  const sub = el("div", { className: "t-sub" });
  if (!state.projectId && t.project_name) sub.append(projectOwner(t));
  if (state.projectId && Number(t.associated)) sub.append(fromChip(itemOf("task", t)));
  if (t.ref) sub.append(el("span", { className: "t-ref", textContent: t.ref }));
  if (t.pad_id) sub.append(padChip(t));
  if (t.subtask_count) sub.append(el("span", { textContent: `${t.subtask_done}/${t.subtask_count}` }));
  if (t.comment_count) sub.append(el("span", { textContent: `${t.comment_count} ✦` }));
  if (sub.childNodes.length) body.append(sub);
  row.append(body);

  const right = el("div", { className: "t-right" });
  if (t.priority === "high") right.append(el("span", { className: "pill high", textContent: "high" }));
  if (statusOf(t) === "doing") right.append(el("span", { className: "pill doing", textContent: "In progress" }));
  if (t.status === "blocked") right.append(el("span", { className: "pill blocked", textContent: "Blocked" }));
  if (isOverdue(t)) right.append(el("span", { className: "pill overdue", textContent: t.due }));
  else if (t.due) right.append(el("span", { className: "t-due", textContent: t.due }));
  if (t.queue) {
    right.append(el("span", {
      className: "pill queued",
      title: t.claimed_by ? `Claimed by ${t.claimed_by}` : "Waiting for an agent",
      textContent: t.claimed_by ? `◆ ${t.claimed_by}` : "◆ queued",
    }));
  }
  if (t.assignee) {
    right.append(el("span", {
      className: "avatar sm" + (isAgent(t.assignee) ? " agent" : ""),
      title: t.assignee,
      textContent: t.assignee.slice(0, 1).toUpperCase(),
    }));
  }

  const more = el("button", { className: "t-more", textContent: "⋯", title: "Actions" });
  more.setAttribute("aria-label", "Task actions");
  more.onclick = (e) => {
    e.stopPropagation();
    const box = more.getBoundingClientRect();
    taskMenu(t, box.left - 150, box.bottom + 4);
  };
  right.append(more);
  row.append(right);

  // The whole row opens the task, so the target is the row and not a word in it.
  row.onclick = () => openTaskSheet(t.id);
  row.oncontextmenu = (e) => { e.preventDefault(); taskMenu(t, e.clientX, e.clientY); };
  row.tabIndex = 0;
  row.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); openTaskSheet(t.id); }
    if (e.key === " ") { e.preventDefault(); quickLook(t.id); }
  };

  return row;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pads
//
// The working documents, and the board read out of them. A pad is markdown, and
// every checkbox line in it is a real task: ticking one here closes the task,
// closing the task rewrites the line.
//
// Which is why this is not just a markdown editor with a preview. The formatted
// view renders each checkbox line as the task it is, with its id and its status,
// so the projection is visible. Somebody reading a plan an agent wrote should be
// able to see, without being told, that the plan is the board.
// ---------------------------------------------------------------------------

function renderPads(root) {
  const project = currentProject();
  if (!project) return;

  const title = el("input", { className: "field", placeholder: "New pad title, then Enter" });
  title.onkeydown = async (e) => {
    if (e.key !== "Enter" || !title.value.trim()) return;
    const pad = await window.delphi.pads.create({ projectId: state.projectId, title: title.value.trim(), author: "you" });
    state.padId = pad.id;
    state.padDraft = null;
    title.value = "";
    refresh();
  };
  root.append(el("div", { className: "add-row" }, title));

  if (!state.pads.length) {
    root.append(emptyState(
      "No pads yet",
      "A pad is the working document for a piece of work: the plan, what you tried, what it did. " +
      "Agents write here through write_scratchpad, and every checkbox line becomes a task on the board."));
    return;
  }

  const wrap = el("div", { className: "pad-wrap" });
  wrap.append(padList(), padPane());
  root.append(wrap);
}

function padList() {
  const list = el("div", { className: "pad-list" });
  for (const pad of state.pads) {
    const row = el("div", {
      className: "pad-row" + (pad.id === state.padId ? " on" : ""),
      tabIndex: 0, role: "button",
    });
    row.append(el("div", { className: "pad-row-t", textContent: pad.title }));
    const meta = [pad.author || "you"];
    if (!pad.derives_tasks) meta.push("no tasks");
    if (Number(pad.associated)) meta.push(`from ${pad.home_name || "another project"}`);
    row.append(el("div", { className: "pad-row-m", textContent: meta.join(" · ") }));
    const go = () => {
      if (pad.id === state.padId) return;
      state.padId = pad.id;
      state.padDraft = null;
      refresh();
    };
    row.onclick = go;
    row.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    list.append(row);
  }
  return list;
}

function padPane() {
  const pad = state.pads.find((p) => p.id === state.padId);
  const pane = el("div", { className: "pad-pane" });
  if (!pad) return pane;

  // --- head ----------------------------------------------------------------
  const head = el("div", { className: "pad-head" });
  const name = el("input", { className: "pad-title", value: pad.title });
  name.onblur = async () => {
    if (name.value.trim() && name.value !== pad.title) {
      await window.delphi.pads.write(pad.id, { title: name.value.trim() });
      refresh();
    }
  };
  head.append(name);

  const seg = el("div", { className: "seg", role: "group" });
  seg.setAttribute("aria-label", "Pad display");
  for (const [raw, label] of [[false, "Board"], [true, "Markdown"]]) {
    const button = el("button", { type: "button", textContent: label });
    button.setAttribute("aria-pressed", String(state.padRaw === raw));
    button.onclick = () => { if (state.padRaw !== raw) { state.padRaw = raw; state.padDraft = null; render(); } };
    seg.append(button);
  }
  head.append(seg);

  // Off means the pad is a sketch: options nobody has agreed to should not fill
  // the board with work.
  const derive = el("button", {
    className: "btn sm" + (pad.derives_tasks ? " on" : ""),
    textContent: pad.derives_tasks ? "Files tasks" : "Notes only",
    title: "Whether checkbox lines in this pad become tasks",
  });
  derive.onclick = async () => {
    await window.delphi.pads.write(pad.id, { derives_tasks: pad.derives_tasks ? 0 : 1 });
    refresh();
  };
  head.append(derive);

  // Delete is in the Item menu, with Move, Copy, Also belongs to and Flag.
  const padItem = itemOf("scratchpad", pad);
  if (padItem.associated) head.insertBefore(fromChip(padItem), seg);
  head.append(itemMoreButton(padItem));
  pane.append(head);

  // --- body ----------------------------------------------------------------
  if (state.padRaw) {
    const box = el("textarea", {
      className: "pad-source",
      value: state.padDraft != null ? state.padDraft : pad.body,
      spellcheck: false,
    });
    box.oninput = () => { state.padDraft = box.value; };
    // On blur rather than per keystroke. Every write re-reads the board from the
    // pad, and doing that on each character would file a task for every prefix
    // of a line somebody was still typing.
    box.onblur = async () => {
      if (state.padDraft == null || state.padDraft === pad.body) return;
      const body = state.padDraft;
      state.padDraft = null;
      await window.delphi.pads.write(pad.id, { body, author: "you" });
      refresh();
    };
    pane.append(box);
    pane.append(el("div", { className: "hint", textContent:
      "The <!--d:123--> markers are how a line and its task stay the same thing. Edit around them." }));
    return pane;
  }

  pane.append(padBoard(pad));
  return pane;
}

/**
 * The pad as it reads, with its checkbox lines live.
 *
 * Prose is passed through the markdown renderer in runs, so a heading is still a
 * heading. A checkbox line is not: it is rendered as its task, because that is
 * what it is, and ticking it here goes through the same update the board uses.
 */
function padBoard(pad) {
  const box = el("div", { className: "pad-board" });
  const detail = state.padDetail && state.padDetail.padId !== undefined
    ? state.padDetail
    : state.padDetail || { lines: [], dropped: [] };

  const byLine = new Map((detail.lines || []).map((l) => [l.index, l]));
  const source = (pad.body || "").split("\n");
  let prose = [];

  const flush = () => {
    const text = prose.join("\n").trim();
    prose = [];
    if (text) box.append(el("div", { className: "pad-prose" }, renderMarkdown(text)));
  };

  source.forEach((line, index) => {
    const entry = byLine.get(index);
    if (!entry) { prose.push(line); return; }
    flush();
    box.append(padLine(entry));
  });
  flush();

  if (!source.join("").trim()) {
    box.append(el("div", { className: "hint", textContent:
      "Empty. Switch to Markdown and write the plan as checkbox lines." }));
  }

  if (detail.dropped && detail.dropped.length) {
    // Named rather than hidden. A rewrite that dropped six lines is the moment
    // somebody goes looking for where their tasks went, and this is the answer.
    box.append(el("div", { className: "pad-dropped" },
      el("div", { className: "pad-dropped-h", textContent:
        `${plural(detail.dropped.length, "task", "tasks")} no longer in this pad` }),
      el("div", { className: "hint", textContent:
        "Still on the board. A pad that stops mentioning a task does not close it." }),
      ...detail.dropped.map((t) => {
        const row = el("div", { className: "pad-drop", tabIndex: 0, role: "button" },
          el("span", { className: "pad-drop-s", textContent: t.status }),
          el("span", { textContent: t.title }));
        const go = () => goTo({ projectId: state.projectId, view: "tasks" });
        row.onclick = go;
        row.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
        return row;
      })));
  }

  return box;
}

function padLine(entry) {
  const task = entry.task;
  const row = el("div", {
    className: "pad-line d" + Math.min(entry.depth, 4) + (entry.done ? " done" : ""),
  });

  const tick = el("input", { type: "checkbox", checked: entry.done });
  tick.disabled = !task;
  tick.onchange = async () => {
    if (!task) return;
    // Through the task, not through the pad. updateTask writes the line back, so
    // there is one path that changes a status and one place that decides what a
    // status change means.
    await window.delphi.tasks.update(task.id, { status: tick.checked ? "done" : "todo" });
    refresh();
  };
  row.append(tick);

  row.append(el("span", { className: "pad-line-t", textContent: entry.title }));

  if (entry.assignee) row.append(el("span", { className: "chip", textContent: `@${entry.assignee}` }));
  if (entry.priority === "high") row.append(el("span", { className: "chip hi", textContent: "high" }));
  // The board's word for it, when the board and the checkbox disagree. A task
  // somebody moved to doing reads as doing here rather than as simply unticked.
  if (task && task.status !== "todo" && task.status !== "done") {
    row.append(el("span", { className: "chip st", textContent: task.status }));
  }
  if (task) {
    const id = el("span", { className: "pad-line-id", textContent: `#${task.id}`, tabIndex: 0, role: "button" });
    id.title = "Open on the board";
    const go = () => goTo({ projectId: state.projectId, view: "tasks" });
    id.onclick = go;
    id.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    row.append(id);
  } else {
    row.append(el("span", { className: "pad-line-id", textContent: "not filed", title:
      "This pad does not file tasks. Turn it on in the header." }));
  }

  return row;
}

function renderNotes(root) {
  const title = el("input", { className: "field", placeholder: "New memory note title, then Enter" });
  title.onkeydown = async (e) => {
    if (e.key !== "Enter" || !title.value.trim()) return;
    await window.delphi.notes.create({ projectId: state.projectId, title: title.value.trim() });
    title.value = "";
    refresh();
  };
  // The toggle sits beside the composer so it governs the whole list, which is
  // how it is used: you are either reading the notes or editing them.
  root.append(el("div", { className: "add-row" }, title, noteViewToggle()));

  if (!state.notes.length) {
    root.append(emptyState("Nothing stored yet",
      "This is for decisions and why the alternative was rejected, traps that cost time, and values that are hard to look up again."));
    return;
  }
  const borrowed = state.notes.filter((n) => Number(n.associated)).length;
  if (borrowed) {
    root.append(el("div", { className: "hint assoc-note",
      textContent: `${plural(state.notes.length - borrowed, "note", "notes")} here, and ${borrowed} from ${borrowed === 1 ? "another project" : "other projects"}.` }));
  }
  state.notes.forEach((n) => root.append(noteCard(n)));
  paintAlsoIn(root, state.notes.filter((n) => !Number(n.associated)));
}

// Where else a home note is shown, by note id, from items:where. The list
// query gives the "from" side only, so this is asked per note after the
// cards are drawn and patched into them in place; a move, an association or
// a flag fires flags-changed, which empties it.
const alsoInCache = new Map();
const ALSO_IN_MAX = 80;
async function paintAlsoIn(root, notes) {
  if (!window.delphi.items) return;
  for (const n of notes.slice(0, ALSO_IN_MAX)) {
    let also = alsoInCache.get(n.id);
    if (!also) {
      try { also = ((await window.delphi.items.where("note", n.id)).also) || []; } catch { also = []; }
      alsoInCache.set(n.id, also);
    }
    if (!also.length || !root.isConnected) continue;
    const card = root.querySelector(`[data-row="note-${n.id}"]`);
    const head = card && card.querySelector(".note-head");
    if (!head || head.querySelector(".also-tag")) continue;
    const tag = el("button", { className: "from-tag also-tag", type: "button" }, "also in ",
      ...also.slice(0, 2).flatMap((p, i) => [i ? ", " : null, dotFor(p.id, p.colour), el("b", { textContent: p.name })]),
      also.length > 2 ? ` and ${also.length - 2} more` : null);
    tag.title = `Also shown in ${also.map((p) => p.name).join(", ")}. Click for where else it is.`;
    const item = itemOf("note", n);
    tag.onclick = (e) => { e.stopPropagation(); const b = tag.getBoundingClientRect(); wherePopover(item, b.left, b.bottom + 4); };
    head.insertBefore(tag, head.querySelector("select"));
  }
}

/**
 * Switches memory between rendered markdown and the source.
 *
 * Notes are written as markdown by agents and read as prose by people, so both
 * are first-class: formatted to read, raw to edit. The choice is remembered
 * because it tracks what you are doing that session, not which note you are on.
 */
function noteViewToggle() {
  const seg = el("div", { className: "seg", role: "group" });
  seg.setAttribute("aria-label", "Memory display");
  for (const [value, label] of [["formatted", "Formatted"], ["raw", "Raw markdown"]]) {
    const button = el("button", { type: "button", textContent: label });
    button.setAttribute("aria-pressed", String(state.noteView === value));
    button.onclick = async () => {
      if (state.noteView === value) return;
      state.noteView = value;
      try { await window.delphi.settings.set({ noteView: value }); } catch {}
      refresh();
    };
    seg.append(button);
  }
  return seg;
}

function noteCard(n) {
  const wrap = el("article", { className: "note" });
  const head = el("div", { className: "note-head" });

  const pin = el("button", { className: "btn sm", textContent: n.pinned ? "★" : "☆", title: "Pin" });
  pin.onclick = async () => { await window.delphi.notes.update(n.id, { pinned: n.pinned ? 0 : 1 }); refresh(); };
  head.append(pin);

  const titleInput = el("input", { value: n.title });
  titleInput.onblur = async () => {
    if (titleInput.value.trim() && titleInput.value !== n.title) {
      await window.delphi.notes.update(n.id, { title: titleInput.value.trim() });
      refresh();
    }
  };
  head.append(titleInput);

  const kind = el("select", { className: "btn sm" });
  ["note", "decision", "gotcha", "reference", "contact"].forEach((k) =>
    kind.append(el("option", { value: k, textContent: k, selected: k === n.kind })));
  kind.onchange = async () => { await window.delphi.notes.update(n.id, { kind: kind.value }); refresh(); };
  head.append(kind);

  const expand = el("button", { className: "icon-btn", title: "Full view (Command + Enter while editing)" });
  expand.setAttribute("aria-label", "Open full view");
  expand.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  expand.onclick = () => openNoteSheet(n);
  head.append(expand);

  // Delete lives in the Item menu now, beside Move, Copy and Flag, so a note
  // shown here from another project says what deleting it would really do.
  const item = itemOf("note", n);
  if (item.associated) head.insertBefore(fromChip(item), kind);
  head.append(itemMoreButton(item));
  wrap.append(head);
  wrap.dataset.row = `note-${n.id}`;
  if (state.litItem && state.litItem.entity === "note" && state.litItem.id === n.id) {
    wrap.classList.add("lit");
    state.litItem = null;
    requestAnimationFrame(() => { if (wrap.isConnected) wrap.scrollIntoView({ block: "start", behavior: motionOff() ? "auto" : "smooth" }); });
  }
  if (item.associated) {
    // Borrowed from another project: one note in two places, so an edit here
    // is an edit there, and the bar says so before anyone makes one.
    wrap.classList.add("borrowed");
    const openHome = el("button", { className: "ts-linkbtn", type: "button", textContent: `Open in ${item.homeName}` });
    openHome.onclick = () => openItemHome(item);
    const stop = el("button", { className: "ts-linkbtn", type: "button", textContent: "Stop showing here" });
    stop.onclick = () => dissociateHere(item, state.projectId);
    wrap.append(el("div", { className: "prov" }, itemIcon("link"),
      el("span", { className: "grow" }, "Lives in ", el("b", { textContent: item.homeName }), ". Shown here because it also belongs to ",
        el("b", { textContent: projectNameOf(state.projectId) }), ". Edits made here are made there."),
      openHome, stop));
  }

  // Editing is per note and does not touch state.noteView.
  //
  // It used to: double clicking a formatted note set the global view to raw,
  // which put every other note on the page into source at the same time, and
  // left it that way for the next session. Editing one note is not a statement
  // about how you want to read all of them.
  const editing = state.editingNoteId === n.id;

  if (state.noteView === "formatted" && !editing) {
    const edit = el("button", { className: "btn sm", textContent: "Edit", title: "Edit this note" });
    edit.onclick = () => { state.editingNoteId = n.id; refresh(); };
    head.insertBefore(edit, expand);

    const rendered = renderMarkdown(n.body);
    rendered.title = "Click to edit";
    // A click that ends a drag is someone selecting text to copy, not someone
    // asking to edit. Swapping in a textarea there would drop the selection they
    // just made, which is the whole reason they clicked.
    rendered.onclick = () => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      state.editingNoteId = n.id;
      refresh();
    };
    wrap.append(el("div", { className: "note-body" },
      (n.body || "").trim()
        ? rendered
        : el("div", { className: "hint", textContent: "Empty. Click Edit to write something." })));
    return wrap;
  }

  const body = el("textarea", {
    className: "field",
    value: n.body,
    rows: Math.min(18, Math.max(4, (n.body || "").split("\n").length + 1)),
    placeholder: "What is worth remembering here",
  });

  const save = async () => {
    if (body.value === n.body) return;
    await window.delphi.notes.update(n.id, { body: body.value });
    n.body = body.value;
  };
  body.onblur = save;

  if (editing) {
    // Saved before the repaint rather than left to blur. Both fire, but blur is
    // async and the render that follows would read the old body and paint what
    // you just finished changing away.
    const done = el("button", { className: "btn sm primary", textContent: "Done", title: "Stop editing" });
    done.onclick = async () => {
      await save();
      state.editingNoteId = null;
      refresh();
    };
    head.insertBefore(done, expand);

    // Escape leaves the note rather than the window. Without this it reaches the
    // document handler, which hides the whole app.
    body.addEventListener("keydown", async (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      await save();
      state.editingNoteId = null;
      refresh();
    });

    // Focus after this render has landed, so clicking the text puts the caret in
    // it rather than leaving you looking at a box you still have to click.
    requestAnimationFrame(() => {
      if (!document.body.contains(body)) return;
      body.focus();
      body.setSelectionRange(body.value.length, body.value.length);
    });
  }
  // The moment you want more room is while typing in too little of it.
  body.onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      n.body = body.value;
      openNoteSheet(n);
    }
  };
  wrap.append(el("div", { className: "note-body" }, body));
  return wrap;
}

// ---------------------------------------------------------------------------
// Full view
// ---------------------------------------------------------------------------

let openSheet = null;

/**
 * Opens one note at full size.
 *
 * Saves on close rather than on every keystroke: this is a place to write at
 * length, and a write per character would fight the vault rebuild that follows
 * each change.
 */
/**
 * The editor for one harness definition.
 *
 * This is the escape hatch that makes the registry worth having. When Codex
 * renames a flag between releases, or somebody wants Delphi to drive Aider or
 * Goose or something written this afternoon, the answer is a row here rather
 * than a version of Delphi.
 *
 * Deliberately plain. The argv is a JSON list and it is shown as one, because
 * anything that hid it behind checkboxes could only express the flags somebody
 * thought of in advance, which is the problem this is solving.
 */
/**
 * An argv template, laid out to be read.
 *
 * One line per argument, with a group kept on its own line rather than exploded.
 * JSON.stringify with an indent puts every element of every nested list on a
 * line of its own, which turns a nine argument template into forty lines and
 * hides the shape it has.
 */
function formatArgv(list) {
  const lines = list.map((item) =>
    `  ${Array.isArray(item) ? `[${item.map((t) => JSON.stringify(t)).join(", ")}]` : JSON.stringify(item)}`);
  return `[\n${lines.join(",\n")}\n]`;
}

/**
 * Whether jobs may run a harness's command when it is not the agent's own
 * program: a wrapper script, a shim, something on a path Delphi does not
 * recognise. A wrapper can add any flag it likes after every check Delphi
 * makes, so the dispatcher refuses it until a person trusts that exact
 * command, and refuses again the moment the command changes. Shown under the
 * harness it belongs to, with the path it resolves to, because that file is
 * what is actually being trusted.
 */
function harnessTrustRow(h, repaint) {
  if (!h.command || !window.delphi.harnesses.trustCommand) return null;
  const real = h.real_path || h.realPath || h.path || null;
  const trusted = h.trusted_command && h.trusted_command === h.command;
  const stale = h.trusted_command && h.trusted_command !== h.command;
  const box = el("div", { className: "trust-row" + (trusted ? " on" : "") });
  const say = el("div", { className: "grow" });
  if (trusted) {
    say.append(el("span", {}, el("b", { textContent: "Trusted command. " }), "Jobs run ", el("code", { textContent: h.command }),
      real && real !== h.command ? el("span", {}, " (", el("code", { textContent: real }), ")") : null,
      " as it is, with nothing checking what it adds."));
  } else if (stale) {
    say.append(el("b", { textContent: "Not trusted. " }), "The trust was for ", el("code", { textContent: h.trusted_command }),
      ", and the command has changed since, so jobs will not run it until it is trusted again.");
  } else {
    say.append("Jobs run this agent only when its command is the agent's own program. If it is a wrapper you wrote or trust, mark it here.");
  }
  const b = el("button", { className: "btn sm", type: "button", textContent: trusted ? "Untrust" : "Trust this command…" });
  b.onclick = async () => {
    if (!trusted) {
      const ok = await wbDialog({
        title: `Trust ${h.label}'s command?`,
        lead: "Delphi cannot see what a wrapper does. Whatever this file runs, with whatever flags it adds, runs for every job given to this agent, in that job's Workbench, without the checks Delphi makes on the agent's own program.",
        body: [
          el("div", { className: "grp" }, el("div", { className: "grp-h", textContent: "The command" }), el("span", { className: "mono", textContent: h.command })),
          el("div", { className: "grp lost" }, el("div", { className: "grp-h", textContent: "The file it resolves to, which is what you are trusting" }),
            el("span", { className: "mono", textContent: real || "not found on this machine" })),
          el("p", { className: "wb-lead", textContent: "Editing the command later takes the trust away. Untrust here takes it away at once." }),
        ],
        actions: [{ label: "Cancel", value: false }, { label: "Trust it", kind: "danger", value: true }],
        cancelValue: false,
      });
      if (!ok) return;
    }
    let saved;
    try { saved = await window.delphi.harnesses.trustCommand(h.id, !trusted); }
    catch (error) { notifyError(error); return; }
    notify(trusted ? `${h.label}'s command is no longer trusted.` : `${h.label}'s command is trusted.`);
    // Redrawn from the row the store returned, in place: the list behind it
    // is re-probed through login shells, which is slow and can land after the
    // pane has moved on.
    const next = harnessTrustRow({ ...h, ...(saved || {}), path: h.path, trusted_command: saved ? saved.trusted_command : (trusted ? null : h.command) }, repaint);
    if (next && box.isConnected) box.replaceWith(next);
    else repaint();
  };
  box.append(say, b);
  return box;
}

function openHarnessSheet(harness, done) {
  if (openSheet) closeNoteSheet();

  const overlay = el("div", { className: "overlay" });
  const sheet = el("div", { className: "sheet", role: "dialog" });
  sheet.setAttribute("aria-modal", "true");

  const head = el("div", { className: "sheet-head" });
  const label = el("input", { value: harness ? harness.label : "", placeholder: "Name, e.g. Aider" });
  head.append(el("span", { className: "kind reference", textContent: harness ? harness.kind : "custom" }), label);
  const status = el("span", { className: "hint" });
  const close = el("button", { className: "icon-btn", title: "Close (Escape)" });
  close.setAttribute("aria-label", "Close");
  close.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  head.append(status, close);
  sheet.append(head);

  const body = el("div", { className: "sheet-body hsheet" });

  const field = (title, blurb, node) => {
    body.append(el("label", { className: "hfield" },
      el("b", { textContent: title }),
      el("span", { className: "hint", textContent: blurb }),
      node));
    return node;
  };

  const command = field("Command",
    "A bare name is looked up through a login shell, which is how a version manager's copy is found. An absolute path is used as given.",
    el("input", { className: "field", value: harness ? (harness.command || "") : "", placeholder: "codex", spellcheck: false }));

  const args = field("Arguments",
    "A JSON list. A nested list is a group that drops out when a placeholder in it has no value, so an optional flag and its value stay together. " +
    "{prompt} {model} {system} {resume} {cwd} are substituted, {mcpFlags} becomes however many arguments this agent needs to be told about Delphi's MCP server, " +
    "and {if:autoAllow} or {ifnot:autoAllow} gate a group.",
    el("textarea", {
      className: "hargs", spellcheck: false,
      value: harness ? formatArgv(JSON.parse(harness.args_json)) : '[\n  "-p", "{prompt}"\n]',
    }));

  const parser = field("Output",
    "How its output is read. Anything that just prints an answer is text.",
    el("select", { className: "btn sm" }));
  for (const [value, text] of [
    ["text", "Plain text"],
    ["claude-stream-json", "Claude Code stream-json"],
    ["codex-json", "Codex JSONL"],
    ["copilot-json", "Copilot JSONL"],
  ]) parser.append(el("option", { value, textContent: text, selected: harness && harness.parser === value }));

  const mcp = field("Delphi's MCP server",
    "How this agent is told about the tracker. Without it the tab still works, and the agent cannot see the pads, the board or anything else.",
    el("select", { className: "btn sm" }));
  for (const [value, text] of [
    ["none", "Not connected"],
    ["flag:--mcp-config", "A config file, via --mcp-config"],
    ["flag:--additional-mcp-config|@", "A config file, via --additional-mcp-config @path"],
    ["codex-config", "Codex style, via -c mcp_servers"],
  ]) mcp.append(el("option", { value, textContent: text, selected: harness && harness.mcp_style === value }));

  sheet.append(body);

  const foot = el("div", { className: "sheet-foot" });
  const save = el("button", { className: "btn primary", textContent: "Save" });
  save.onclick = async () => {
    try {
      // Parsed here as well as in db.js, so the error lands next to the box it
      // came from rather than as an exception from an IPC call.
      JSON.parse(args.value);
    } catch (error) {
      status.textContent = `The arguments are not valid JSON: ${error.message}`;
      return;
    }
    try {
      if (harness) {
        await window.delphi.harnesses.update(harness.id, {
          label: label.value.trim() || harness.label,
          command: command.value.trim(),
          args_json: args.value,
          parser: parser.value,
          mcp_style: mcp.value,
        });
      } else {
        await window.delphi.harnesses.create({
          key: label.value.trim(),
          label: label.value.trim(),
          command: command.value.trim(),
          args: JSON.parse(args.value),
          parser: parser.value,
          mcpStyle: mcp.value,
        });
      }
    } catch (error) {
      status.textContent = String(error.message || error);
      return;
    }
    shut();
    if (done) done();
  };
  foot.append(save);

  if (harness && harness.kind === "custom") {
    const remove = el("button", { className: "btn sm", textContent: "Delete" });
    remove.onclick = async () => {
      await window.delphi.harnesses.remove(harness.id);
      shut();
      if (done) done();
    };
    foot.append(remove);
  }
  // A built-in is never deleted, only turned off, so its definition can come
  // back. Said here rather than left as a missing button.
  if (harness && harness.kind === "builtin") {
    foot.append(el("span", { className: "hint", textContent:
      "A built-in agent is turned off rather than deleted. Leave it unedited and Delphi keeps its definition current." }));
  }
  sheet.append(foot);

  const shut = () => {
    overlay.remove();
    openSheet = null;
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); shut(); } };
  document.addEventListener("keydown", onKey);
  close.onclick = shut;
  overlay.onclick = (e) => { if (e.target === overlay) shut(); };

  overlay.append(sheet);
  document.body.append(overlay);
  openSheet = { close: shut };
  label.focus();
}

function openNoteSheet(note) {
  if (window.DelphiDrawer && !openNoteSheet.full) return DelphiDrawer.openNote(note);
  if (openSheet) closeNoteSheet();

  const overlay = el("div", { className: "overlay" });
  const sheet = el("div", { className: "sheet", role: "dialog" });
  sheet.setAttribute("aria-modal", "true");

  const head = el("div", { className: "sheet-head" });
  const title = el("input", { value: note.title });
  head.append(el("span", { className: `kind ${note.kind || "note"}`, textContent: note.kind || "note" }), title);

  const status = el("span", { className: "hint" });
  const close = el("button", { className: "icon-btn", title: "Close (Escape)" });
  close.setAttribute("aria-label", "Close full view");
  close.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  const area = el("textarea", { value: note.body || "", spellcheck: false });
  area.placeholder = "What is worth remembering here";

  const pane = el("div", { className: "sheet-body" });

  // Whether this sheet is being edited, as distinct from how notes are read.
  // Clicking the text drops into the source for this note only, and leaves the
  // Formatted/Raw preference alone.
  let editing = false;

  // Rendering reads from the textarea rather than from the note, so switching
  // to formatted shows what you have just typed and not what was last saved.
  const paint = () => {
    const wasScrolled = pane.scrollTop;
    pane.textContent = "";

    if (editing || state.noteView === "raw") {
      pane.append(area);
      area.focus();
      return;
    }

    const rendered = renderMarkdown(area.value);
    rendered.title = "Click to edit";
    // Ignored when a selection is open, so dragging to copy does not swap the
    // text out from under the drag.
    rendered.onclick = () => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      editing = true;
      paint();
    };
    pane.append(rendered);
    pane.scrollTop = wasScrolled;
  };

  const seg = el("div", { className: "seg", role: "group" });
  seg.setAttribute("aria-label", "Display");
  for (const [value, label] of [["formatted", "Formatted"], ["raw", "Raw"]]) {
    const button = el("button", { type: "button", textContent: label });
    button.setAttribute("aria-pressed", String(state.noteView === value));
    button.onclick = async () => {
      // Choosing Formatted is a request to read, so it ends an edit started by
      // clicking the text. Otherwise the button would appear to do nothing.
      if (value === "formatted") editing = false;
      if (state.noteView === value) { paint(); return; }
      state.noteView = value;
      for (const b of seg.children) b.setAttribute("aria-pressed", String(b.textContent.toLowerCase().startsWith(value)));
      try { await window.delphi.settings.set({ noteView: value }); } catch {}
      paint();
    };
    seg.append(button);
  }

  // The Item menu here too, closing the full view first: every verb in it
  // either repaints the list behind or opens a dialog of its own.
  const noteItem = itemOf("note", { ...note, associated: note.associated && state.projectId && note.project_id !== state.projectId ? 1 : 0 });
  const more = itemMoreButton(noteItem);
  more.onclick = async (e) => { e.stopPropagation(); const box = more.getBoundingClientRect(); await closeNoteSheet(); itemMenu(noteItem, box.right - 250, box.bottom + 4); };
  head.append(seg, status, more, close);

  const foot = el("div", { className: "sheet-foot" });
  const counts = () => {
    const text = area.value;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    foot.textContent = `${text.split("\n").length} lines, ${words} words   ·   Escape closes and saves`;
  };
  counts();
  area.oninput = counts;

  paint();
  sheet.append(head, pane, foot);
  overlay.append(sheet);
  // Clicking the backdrop closes, but a click inside must not bubble out to it.
  overlay.onclick = (e) => { if (e.target === overlay) closeNoteSheet(); };
  close.onclick = () => closeNoteSheet();
  document.body.append(overlay);

  openSheet = { overlay, note, title, area, status, close: closeNoteSheet };
  // Only the source pane can take a caret. In formatted mode the textarea is
  // detached, and focusing a node that is not in the document does nothing.
  if (state.noteView === "raw") {
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }
}

async function closeNoteSheet() {
  if (!openSheet) return;
  const { overlay, note, title, area } = openSheet;
  openSheet = null;

  const updates = {};
  if (title.value.trim() && title.value !== note.title) updates.title = title.value.trim();
  if (area.value !== (note.body || "")) updates.body = area.value;

  overlay.remove();

  if (Object.keys(updates).length) {
    await window.delphi.notes.update(note.id, updates);
    refresh();
  }
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
    await window.delphi.links.create({ projectId: state.projectId, label: label.value.trim(), url: url.value.trim(), kind });
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
    a.onclick = (e) => { e.preventDefault(); window.delphi.openExternal(l.url); };
    row.append(a);
    const item = itemOf("link", l);
    if (item.associated) row.append(fromChip(item));
    row.append(el("span", { className: "mono", textContent: l.url.slice(0, 46) }), itemMoreButton(item));
    row.dataset.row = `link-${l.id}`;
    list.append(row);
  });
  root.append(list);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * What has happened inside this project, and how to put it back.
 *
 * The same audit trail the History tab reads, narrowed to one project. It exists
 * because a task deleted inside a project could previously only be recovered from
 * the All view, which is not where anyone looks after deleting something.
 */
/**
 * Who made a History row, and its summary without the " (by X)" the writers
 * still append. From the actor and session columns where the row has them;
 * older rows have only the suffix, which is read as the fallback.
 */
function auditWho(e) {
  const m = / \(by ([^()]+)\)$/.exec(String(e.summary || ""));
  const actor = e.actor || (m ? m[1] : null);
  const summary = m && (!e.actor || m[1] === e.actor) ? e.summary.slice(0, m.index) : e.summary;
  const parts = [];
  if (actor && actor !== "you") parts.push(`by ${actor}`);
  if (e.session_id) parts.push(`session ${e.session_id}`);
  if (e.job_id) parts.push(`job ${e.job_id}`);
  return { summary, by: parts.join(", ") };
}

/** The undo control for a row that is not a delete: a button, or why there is none. */
function auditAction(e, label = "undo") {
  if (e.legacy) {
    return el("span", { className: "chip", textContent: "not recorded",
      title: "Recorded before Delphi kept the previous state, so it cannot be undone automatically." });
  }
  // A flag, a job's own row, a Workbench's note: nothing changed to put back.
  if (!e.restorable) return null;
  const b = el("button", { className: "btn sm", textContent: label });
  b.onclick = async () => {
    try { await window.delphi.audit.undo(e.id); } catch (err) { alert(err.message); }
    refresh();
  };
  return b;
}

async function renderActivity(root) {
  const entries = await window.delphi.audit.project(state.projectId, 200);

  if (!entries.length) {
    root.append(emptyState("Nothing has happened here yet",
      "Every change in this project is recorded, and every one of them can be put back."));
    return;
  }

  const deletes = entries.filter((e) => e.action === "delete" && !e.undone && e.restorable);
  if (deletes.length) {
    const bar = el("div", { className: "restore-bar" });
    bar.append(el("span", {
      textContent: `${plural(deletes.length, "deleted item", "deleted items")} can still be restored.`,
    }));
    const all = el("button", { className: "btn primary sm", textContent: "Restore all" });
    all.onclick = async () => {
      // Oldest first, so anything that depended on something else comes back
      // after the thing it depended on.
      for (const e of [...deletes].reverse()) {
        try { await window.delphi.audit.undo(e.id); } catch { /* keep going */ }
      }
      refresh();
    };
    bar.append(all);
    root.append(bar);
  }

  const list = el("section", { className: "card" });
  for (const e of entries) {
    const row = el("div", {
      className: "audit-row" + (e.undone ? " undone" : "") + (e.action === "delete" ? " deleted" : ""),
    });
    row.dataset.audit = String(e.id);
    row.append(el("span", { className: "audit-when", textContent: ago(e.at) }));

    const who = auditWho(e);
    const what = el("div", { className: "audit-what" },
      el("div", {}, el("span", { className: `act act-${e.action}`, textContent: e.action }),
                    el("span", { textContent: ` ${e.entity} ${who.summary}` }),
                    ...(who.by ? [el("span", { className: "audit-by", textContent: who.by })] : [])));
    if (e.label) what.append(el("div", { className: "lbl", textContent: e.label.slice(0, 140) }));
    row.append(what);

    if (e.undone) {
      row.append(el("span", { className: "chip", textContent: "restored" }));
    } else if (e.action === "delete" && !e.restorable) {
      // Honest rather than hopeful: with no stored copy there is nothing to put
      // back, and a button that cannot work is worse than no button.
      row.append(el("span", { className: "chip", textContent: "not recoverable" }));
    } else if (e.action === "delete") {
      const b = el("button", { className: "btn sm primary", textContent: "restore" });
      b.onclick = async () => {
        try { await window.delphi.audit.undo(e.id); } catch (err) { alert(err.message); }
        refresh();
      };
      row.append(b);
    } else {
      const control = auditAction(e);
      if (control) row.append(control);
    }
    list.append(row);
  }
  root.append(list);
}

async function renderHistory(root) {
  const bar = el("div", { className: "add-row" });
  const msg = el("span", { className: "hint" });
  const undo = (n, text) => {
    const b = el("button", { className: "btn", textContent: text });
    b.onclick = async () => {
      try {
        const { undone, stopped } = await window.delphi.audit.undoLast(n);
        // Reported together, because a run that stopped part way did do
        // something and saying only why it stopped reads as though it did not.
        if (stopped) {
          msg.className = "err-msg";
          msg.textContent = undone
            ? `Reversed ${plural(undone, "change", "changes")}, then stopped: ${stopped}`
            : stopped;
        } else {
          msg.className = "ok-msg";
          msg.textContent = undone ? `Reversed ${plural(undone, "change", "changes")}.` : "Nothing left to undo.";
        }
      } catch (e) { msg.className = "err-msg"; msg.textContent = e.message; }
      refresh();
    };
    return b;
  };
  bar.append(undo(1, "Undo last change"), undo(5, "Undo last 5"), msg);
  root.append(bar);

  const entries = await window.delphi.audit.list(200);
  if (!entries.length) {
    root.append(emptyState("Nothing recorded yet", "Every change from here on is logged and reversible."));
    return;
  }

  const list = el("section", { className: "card" });
  entries.forEach((e) => {
    const row = el("div", { className: "audit-row" + (e.undone ? " undone" : "") });
    row.dataset.audit = String(e.id);
    row.append(el("span", { className: "audit-when", textContent: ago(e.at) }));
    const who = auditWho(e);
    const what = el("div", { className: "audit-what" },
      el("div", {}, el("span", { textContent: `${e.entity} ${who.summary}` }),
                    ...(who.by ? [el("span", { className: "audit-by", textContent: who.by })] : [])));
    if (e.label) what.append(el("div", { className: "lbl", textContent: e.label.slice(0, 120) }));
    row.append(what);
    if (e.undone) {
      row.append(el("span", { className: "chip", textContent: "undone" }));
    } else if (e.action === "delete" && !e.restorable) {
      // The same honesty the project History tab has always had. This list used
      // to offer an undo button on every row, including deletes with no stored
      // copy, where pressing it can only produce an error.
      row.append(el("span", { className: "chip", textContent: "not recoverable" }));
    } else {
      const control = auditAction(e);
      if (control) row.append(control);
    }
    list.append(row);
  });
  root.append(list);
}

// ---------------------------------------------------------------------------
// Reminders
//
// The store, the scheduler and the notification were all here already and none
// of it could be reached from the window. This is the interface over what
// exists: a reminder is set from the task it belongs to, and every reminder in
// flight is listed in one place, because a snoozed one that is only a pending
// notification is a reminder you have already lost.
// ---------------------------------------------------------------------------

// SQLite writes and compares these in UTC, and Date reads a bare
// "2026-08-15 09:00:00" as local time. Left alone, a reminder set for nine in
// Berlin would be described as firing at eleven and the arithmetic under
// "in 20m" would be two hours out.
const parseFireAt = (text) => TIME.parseStamp(text) || new Date(NaN);
const toFireAt = (date) => TIME.toStamp(date);

const pad2 = (n) => String(n).padStart(2, "0");

/** What <input type="datetime-local"> wants: local wall clock, to the minute. */
const localInputValue = (date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
  `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

// Seconds are dropped so a reminder set at 10:31:47 reads back as 10:46 rather
// than as a time nobody chose.
const inMinutes = (n) => {
  const d = new Date(Date.now() + n * 60000);
  d.setSeconds(0, 0);
  return d;
};

const atHour = (daysAhead, hour) => {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  return d;
};

/** "in 20m", "in 3h", "12m ago". Relative, because that is the question. */
function whenLabel(fireAt) {
  const mins = Math.round((parseFireAt(fireAt).getTime() - Date.now()) / 60000);
  const n = Math.abs(mins);
  if (n < 1) return "now";
  const text = n < 60 ? `${n}m` : n < 2880 ? `${Math.round(n / 60)}h` : `${Math.round(n / 1440)}d`;
  return mins < 0 ? `${text} ago` : `in ${text}`;
}

/** The absolute time, for the row that has room for it. */
const clockLabel = (fireAt) =>
  parseFireAt(fireAt).toLocaleString([], {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });

const REMINDER_LIVE = ["pending", "fired", "snoozed"];
const REMINDER_WORD = {
  pending: "scheduled", fired: "ringing", snoozed: "snoozed", done: "acted on", dismissed: "dismissed",
};

/** Reminders still ahead of you. Tolerates being called before the first load. */
const liveAlerts = (list) => (list || []).filter((a) => REMINDER_LIVE.includes(a.status));

const nextAlert = (list) =>
  liveAlerts(list).slice().sort((a, b) => (a.fire_at < b.fire_at ? -1 : 1))[0] || null;

// Read once per load rather than per chip, because the presets are built while
// painting and a preset cannot wait on a round trip.
let reminderPrefs = { snoozeMinutes: 10, autoRemindBeforeDueHours: 24 };

/**
 * Loads every reminder, and the two settings the interface quotes back.
 *
 * Called from refresh so the tab badge, the list and the chip all come from one
 * read, and so a reminder fired by the scheduler appears without a click.
 */
async function loadAlerts() {
  const [alerts, settings] = await Promise.all([
    window.delphi.alerts.list(),
    window.delphi.settings.get(),
  ]);
  reminderPrefs = {
    snoozeMinutes: Number(settings.snoozeMinutes) || 10,
    autoRemindBeforeDueHours: Number(settings.autoRemindBeforeDueHours) || 24,
  };
  return alerts;
}

/** Every reminder on one task, newest life first. */
const alertsForTask = (taskId) => (state.alerts || []).filter((a) => a.task_id === taskId);

/**
 * The times worth offering as one click.
 *
 * "This evening" and "before it is due" are only offered while they are still
 * ahead of you: a preset that sets a reminder for this morning is a preset that
 * fires the moment you choose it.
 */
function reminderPresets(task) {
  const out = [
    ["m15", "In 15 minutes", () => inMinutes(15)],
    ["h1", "In an hour", () => inMinutes(60)],
    ["h3", "In three hours", () => inMinutes(180)],
  ];
  const evening = atHour(0, 18);
  if (evening.getTime() > Date.now() + 60000) out.push(["evening", "This evening", () => atHour(0, 18)]);
  out.push(["tomorrow", "Tomorrow morning", () => atHour(1, 9)]);
  out.push(["week", "Next week", () => atHour(7, 9)]);

  if (task && task.due) {
    const hours = reminderPrefs.autoRemindBeforeDueHours;
    const before = new Date(new Date(`${task.due}T09:00:00`).getTime() - hours * 3600000);
    if (before.getTime() > Date.now()) {
      out.push(["due", `${hours}h before it is due`, () => before]);
    }
  }
  return out;
}

const createAlertAt = (taskId, date, extra = {}) =>
  window.delphi.alerts.create({ taskId, fireAt: toFireAt(date), ...extra });

// ---------------------------------------------------------------------------
// The chip on the task sheet
// ---------------------------------------------------------------------------

/**
 * The spec for the reminder chip, for openTaskSheet's own chip() to build.
 *
 * Returned as a spec rather than an element because chip() owns the swap from
 * fact to control, and a second implementation of that would drift from the
 * rest of the row.
 */
function reminderChipSpec({ task, alerts, after, openList }) {
  const next = nextAlert(alerts);
  const extra = liveAlerts(alerts).length - 1;
  const overdue = next && parseFireAt(next.fire_at).getTime() <= Date.now();

  return {
    icon: "◷",
    value: next ? whenLabel(next.fire_at) + (extra > 0 ? ` +${extra}` : "") : "",
    empty: "no reminder",
    tone: overdue ? "tone-overdue" : "",
    build: (done) => {
      const presets = reminderPresets(task);
      const s = el("select", { className: "ts-inline" });
      s.append(el("option", { value: "", textContent: "Remind me..." }));
      for (const [key, label] of presets) s.append(el("option", { value: key, textContent: label }));
      s.append(el("option", { value: "custom", textContent: "Pick a date and time" }));
      if (next) s.append(el("option", { value: "manage", textContent: "See all reminders" }));
      if (next) s.append(el("option", { value: "clear", textContent: "Clear reminders" }));

      const finish = async () => { await after(); done(); };

      s.onchange = async () => {
        const choice = s.value;
        if (!choice) return;

        if (choice === "custom") {
          // The select's own blur repaints the chip row, which would take this
          // input with it the moment it replaces the select.
          s.onblur = null;
          const i = el("input", {
            className: "ts-inline", type: "datetime-local", value: localInputValue(inMinutes(60)),
          });
          i.onchange = async () => {
            if (i.value) { await createAlertAt(task.id, new Date(i.value)); await finish(); }
            else done();
          };
          i.onblur = done;
          s.replaceWith(i);
          i.focus();
          return;
        }

        if (choice === "manage") { openList(); return; }

        if (choice === "clear") {
          for (const a of liveAlerts(alerts)) await window.delphi.alerts.remove(a.id);
          await finish();
          return;
        }

        const preset = presets.find((p) => p[0] === choice);
        if (preset) await createAlertAt(task.id, preset[2]());
        await finish();
      };
      s.onblur = done;
      return s;
    },
  };
}

// ---------------------------------------------------------------------------
// A reminder, as a row
// ---------------------------------------------------------------------------

const REPEATS = [
  ["", "once"],
  ["60", "every hour"],
  ["1440", "every day"],
  ["10080", "every week"],
];

const repeatWord = (mins) =>
  (REPEATS.find(([v]) => Number(v) === Number(mins)) || [null, `every ${mins}m`])[1];

/**
 * One reminder.
 *
 * Snooze, done and delete are all offered on every live row: a reminder is
 * something you deal with where you find it, and sending someone to another
 * screen to silence one is how they end up ignored.
 */
function reminderRow(a, { onChange, showTask = true }) {
  const live = REMINDER_LIVE.includes(a.status);
  const row = el("div", { className: "rem-row" + (live ? "" : " spent") });

  row.append(el("span", { className: `rem-dot st-${a.status}`, title: REMINDER_WORD[a.status] || a.status }));

  const when = el("span", { className: "rem-when" });
  when.append(el("span", { className: "rem-rel", textContent: live ? whenLabel(a.fire_at) : REMINDER_WORD[a.status] }));
  when.append(el("span", { className: "hint", textContent: clockLabel(a.fire_at) }));
  row.append(when);

  const bodyBox = el("div", { className: "rem-body" });
  bodyBox.append(el("div", { className: "rem-title", textContent: a.message || a.task_title }));

  const sub = el("div", { className: "rem-sub" });
  if (showTask && a.project_name) {
    sub.append(el("span", { className: "dot", style: `background:${safeColour(a.project_colour)}` }));
    sub.append(el("span", { textContent: a.project_name }));
  }
  if (showTask && a.message) sub.append(el("span", { textContent: a.task_title }));
  if (a.repeat_every_minutes) sub.append(el("span", { className: "chip", textContent: repeatWord(a.repeat_every_minutes) }));
  if (a.snooze_count) sub.append(el("span", { className: "chip", textContent: `snoozed ${a.snooze_count}×` }));
  // A reminder on a finished task is skipped by the sweep, so it would sit here
  // looking scheduled forever without saying why.
  if (live && a.task_status === "done") sub.append(el("span", { className: "chip overdue", textContent: "task is done, will not fire" }));
  if (sub.children.length) bodyBox.append(sub);
  row.append(bodyBox);

  const actions = el("div", { className: "rem-actions" });
  if (live) {
    const snooze = el("button", { className: "btn sm", textContent: `Snooze ${reminderPrefs.snoozeMinutes}m` });
    snooze.title = "Put this off. The length is set under Settings, Reminders.";
    snooze.onclick = async () => { await window.delphi.alerts.snooze(a.id); await onChange(); };

    const act = el("button", { className: "btn sm", textContent: "Done" });
    act.title = "Close this reminder. It does not complete the task.";
    act.onclick = async () => { await window.delphi.alerts.act(a.id); await onChange(); };

    actions.append(snooze, act);
  }
  if (showTask) {
    const open = el("button", { className: "btn sm", textContent: "Open task" });
    open.onclick = () => openTaskSheet(a.task_id);
    actions.append(open);
  }
  const kill = el("button", { className: "ts-kill", textContent: "×", title: "Delete this reminder" });
  kill.onclick = async () => { await window.delphi.alerts.remove(a.id); await onChange(); };
  actions.append(kill);
  row.append(actions);

  return row;
}

/**
 * The control that sets one.
 *
 * A time field with the quick choices beside it rather than instead of it, so
 * "tomorrow morning" is one click and half past four on Thursday is still
 * possible without leaving the row.
 */
function reminderComposer({ task, onCreate }) {
  const box = el("div", { className: "rem-set" });
  const when = el("input", { type: "datetime-local", className: "field", value: localInputValue(inMinutes(60)) });
  when.setAttribute("aria-label", "When to remind you");

  const quick = el("select", { className: "field" });
  quick.setAttribute("aria-label", "Quick times");
  quick.append(el("option", { value: "", textContent: "Quick times" }));
  const presets = reminderPresets(task);
  for (const [key, label] of presets) quick.append(el("option", { value: key, textContent: label }));
  quick.onchange = () => {
    const preset = presets.find((p) => p[0] === quick.value);
    if (preset) when.value = localInputValue(preset[2]());
    quick.value = "";
  };

  const repeat = el("select", { className: "field" });
  repeat.setAttribute("aria-label", "How often");
  for (const [value, label] of REPEATS) repeat.append(el("option", { value, textContent: label }));

  const message = el("input", { className: "field", placeholder: "What to say when it fires (optional)" });
  message.setAttribute("aria-label", "Reminder message");

  const note = el("span", { className: "hint" });
  const add = el("button", { className: "btn primary sm", textContent: "Set reminder" });
  add.onclick = async () => {
    if (!when.value) {
      note.className = "err-msg";
      note.textContent = "Pick a time first.";
      return;
    }
    try {
      await createAlertAt(task.id, new Date(when.value), {
        message: message.value.trim() || null,
        repeatEveryMinutes: repeat.value ? Number(repeat.value) : null,
      });
      message.value = "";
      note.className = "hint";
      note.textContent = "";
      await onCreate();
    } catch (e) {
      note.className = "err-msg";
      note.textContent = e.message;
    }
  };

  box.append(el("div", { className: "row" }, when, quick, repeat));
  box.append(el("div", { className: "row" }, message, add));
  box.append(note);
  return box;
}

// ---------------------------------------------------------------------------
// The reminders pane on the task sheet
// ---------------------------------------------------------------------------

function paintTaskReminders(box, { task, alerts, after }) {
  const live = liveAlerts(alerts);
  const head = el("div", { className: "ts-sec-head" }, el("h4", { textContent: "Reminders" }));
  if (live.length) head.append(el("span", { className: "ts-count", textContent: String(live.length) }));
  box.append(head);

  if (!alerts.length) {
    box.append(el("div", { className: "hint pad",
      textContent: "Nothing set. A reminder arrives as a system notification, and stays on the Reminders tab until it is dealt with." }));
  }

  for (const a of alerts) box.append(reminderRow(a, { onChange: after, showTask: false }));
  box.append(reminderComposer({ task, onCreate: after }));
}

// ---------------------------------------------------------------------------
// The reminders view
// ---------------------------------------------------------------------------

const REMINDER_GROUPS = [
  ["fired", "Ringing now", "Shown already, and not yet dealt with."],
  ["snoozed", "Snoozed", "Put off, and coming back."],
  ["pending", "Scheduled", "Waiting for their time."],
];

async function renderReminders(root) {
  const alerts = state.alerts || [];
  const after = () => refresh();

  if (!alerts.length) {
    root.append(emptyState("No reminders yet",
      "Open a task and use the reminder chip beside its due date. Reminders arrive as a system notification and stay here until they are dealt with, so a snoozed one is not lost."));
    return;
  }

  for (const [status, title, blurb] of REMINDER_GROUPS) {
    const group = alerts.filter((a) => a.status === status);
    if (!group.length) continue;
    const { card: box, body } = card(title, el("span", { className: "hint", textContent: blurb }));
    body.className = "card-body flush";
    for (const a of group) body.append(reminderRow(a, { onChange: after }));
    root.append(box);
  }

  const spent = alerts.filter((a) => !REMINDER_LIVE.includes(a.status));
  if (spent.length) {
    const { card: box, body } = card("Finished",
      el("span", { className: "hint", textContent: `${plural(spent.length, "reminder", "reminders")} acted on or dismissed` }));
    body.className = "card-body flush";
    let shown = false;
    const toggle = el("button", { className: "btn sm", textContent: "Show" });
    toggle.onclick = () => {
      shown = !shown;
      toggle.textContent = shown ? "Hide" : "Show";
      body.textContent = "";
      if (shown) for (const a of spent) body.append(reminderRow(a, { onChange: after }));
    };
    box.querySelector(".card-head").append(toggle);
    root.append(box);
  }

  root.append(el("p", { className: "hint", style: "margin:var(--s4) 0 0",
    textContent: `Snooze puts a reminder off for ${plural(reminderPrefs.snoozeMinutes, "minute", "minutes")}. ` },
    configureLink("snoozeMinutes")));
}

// ---------------------------------------------------------------------------
// The reminders settings block
//
// Replaces the block that set snoozeMinutes and checkIntervalSeconds, and adds
// the third setting, which has been stored and honoured by nothing since the
// day it was added.
// ---------------------------------------------------------------------------

/** "Configure...", opening the Settings panel at one setting's row. */
function configureLink(key) {
  if (!window.DelphiSettingsPanel) return null;
  const a = el("button", { className: "linkish", type: "button", textContent: "Configure..." });
  a.onclick = () => DelphiSettingsPanel.configure(key);
  return a;
}

function remindersSettings(settings) {
  const rem = el("div", { className: "setting" });
  rem.append(el("h3", { textContent: "Reminders" }));
  rem.append(el("p", {
    textContent: "How long Snooze puts a reminder off for, how often the app looks for reminders that have come due, and how far ahead of a due date the task sheet offers to remind you.",
  }));

  const numberField = (label, key, suffix) => {
    const row = el("div", { className: "row", style: "margin-bottom:10px" });
    row.append(el("span", { textContent: label, style: "flex:0 0 210px" }));
    const input = el("input", { type: "number", min: "1", value: String(settings[key] ?? ""), className: "field", style: "width:92px" });
    const note = el("span", { className: "hint" });
    input.onchange = async () => {
      try {
        const updated = await window.delphi.settings.set({ [key]: Number(input.value) });
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
  rem.append(numberField("Offer to remind me", "autoRemindBeforeDueHours", "hours before a task is due"));
  rem.append(el("p", { className: "hint", style: "margin:12px 0 0",
    textContent: "The last one is a suggestion, not a rule: it sets the shortcut offered on a task that has a due date. Nothing is scheduled without you asking for it." }));
  return rem;
}

// ---------------------------------------------------------------------------
// The queue
//
// What agents can take, what they are holding, and what has come back out. The
// pool is not a status, so none of the other views show it: a task can be todo
// and queued, or doing and claimed, and folding that into the status column
// would mean a board column that only means something when an agent is watching.
//
// Reading the queue sweeps it first. claimNext already treats an expired lease
// as unclaimed, so a stale claim on screen is a claim that does not exist, and
// showing one would be a picture of a queue nobody would actually be handed.
//
// There is one pool, and a project narrows it rather than owning one of its own.
// The tab appears in both places for that reason: in All work it is the whole
// pool, in a project it is that project's share of the same pool. A queued task
// with no project belongs to no project's slice and shows only in All work.
// ---------------------------------------------------------------------------

const QUEUE_NAME = "ready";

/** Minutes left on a lease, or how long ago it lapsed. */
function leaseLeft(expires) {
  if (!expires) return { text: "no lease", late: false };
  const ms = (TIME.parseStamp(expires)?.getTime() ?? NaN) - Date.now();
  const mins = Math.round(Math.abs(ms) / 60000);
  const said = mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`;
  return ms >= 0 ? { text: `${said} left`, late: false } : { text: `${said} over`, late: true };
}

function queueSection(title, note, rows) {
  const box = el("section", { className: "card q-sec" });
  const head = el("div", { className: "q-head" });
  head.append(el("span", { className: "q-title", textContent: title }));
  head.append(el("span", { className: "q-n", textContent: String(rows.length) }));
  if (note) head.append(el("span", { className: "hint grow q-note", textContent: note }));
  box.append(head);
  return box;
}

function queueRow(t, extra) {
  const row = el("div", { className: "q-row" });
  const name = el("button", { className: "q-name", textContent: t.title, title: "Open the task" });
  name.onclick = () => openTaskSheet(t.id);
  row.append(name);
  const meta = el("span", { className: "q-meta" });
  for (const bit of extra) if (bit) meta.append(bit);
  row.append(meta);
  return row;
}

async function renderQueue(root) {
  const project = currentProject();
  const state_ = await window.delphi.tasks.queueState(QUEUE_NAME, state.projectId);

  const bar = el("div", { className: "oracle-bar" });
  bar.append(el("div", { className: "hint grow", textContent: project
    ? `${project.name}'s share of the '${QUEUE_NAME}' pool. An agent calls queue_next with this project to take the top of Waiting, and holds a lease it has to finish or renew before it lapses.`
    : `The whole '${QUEUE_NAME}' pool, every project. An agent calls queue_next to take the top of Waiting, and holds a lease it has to finish or renew before it lapses.` }));
  const sweep = el("button", { className: "btn sm", textContent: "Sweep" });
  sweep.title = project
    ? "Put any expired claim in this project back in the pool now"
    : "Put any expired claim back in the pool now";
  sweep.onclick = async () => { await window.delphi.tasks.queueReclaim(QUEUE_NAME, state.projectId); render(); };
  bar.append(sweep);
  root.append(bar);

  // Said rather than done silently: a task moving back to the pool on its own is
  // exactly the event someone wonders about later.
  if (state_.reclaimed && state_.reclaimed.length) {
    const back = el("div", { className: "filter-note" });
    back.append(el("span", { textContent:
      `${plural(state_.reclaimed.length, "lease", "leases")} had expired and went back in the pool: ` +
      state_.reclaimed.map((r) => `${r.title} (${r.agent})`).join(", ") }));
    root.append(back);
  }

  const waiting = queueSection("Waiting", "Highest priority first, oldest first within it", state_.waiting);
  if (!state_.waiting.length) {
    waiting.append(el("div", { className: "hint pad", textContent: project
      ? `Nothing from ${project.name} is queued. Send a task here from its right click menu.`
      : "Nothing queued. Send a task here from its right click menu." }));
  }
  for (const t of state_.waiting) {
    // Which project a piece of work belongs to is the thing the global view is
    // missing, and it is what tells you whether the agent about to take it is
    // sitting in the right checkout.
    const owner = !project && t.project_name;
    waiting.append(queueRow(t, [
      t.priority === "high" ? el("span", { className: "pill high", textContent: "high" }) : null,
      owner ? el("span", { className: "dot", style: `background:${safeColour(t.project_colour)}` }) : null,
      owner ? el("span", { className: "cell-text", textContent: t.project_name }) : null,
      t.ref ? el("span", { className: "t-ref", textContent: t.ref }) : null,
    ]));
  }
  root.append(waiting);

  const held = queueSection("In flight", "Claimed, with a lease running", state_.claimed);
  if (!state_.claimed.length) {
    held.append(el("div", { className: "hint pad", textContent: project
      ? "No agent is holding anything in this project."
      : "No agent is holding anything." }));
  }
  for (const t of state_.claimed) {
    const lease = leaseLeft(t.claim_expires);
    const give = el("button", { className: "row-btn", textContent: "Release" });
    give.title = "Put this back in the pool";
    give.onclick = async () => {
      await window.delphi.tasks.queueRelease(t.id, "Released by hand from the queue view.");
      render();
    };
    held.append(queueRow(t, [
      el("span", { className: "avatar sm agent", title: t.claimed_by, textContent: t.claimed_by.slice(0, 1).toUpperCase() }),
      el("span", { className: "cell-text", textContent: t.claimed_by }),
      el("span", { className: "pill " + (lease.late ? "overdue" : "muted"), textContent: lease.text }),
      give,
    ]));
  }
  root.append(held);

  // Not "left the pool", which is what this used to say and was never true.
  // Finishing a task nulls its queue, so nothing records that a done task was
  // ever queued and this list cannot be narrowed to the pool. It is every task
  // finished in the last week, said plainly.
  const done = queueSection("Finished", project
    ? "Finished in this project in the last week, queued or not"
    : "Finished anywhere in the last week, queued or not", state_.finished || []);
  if (!(state_.finished || []).length) {
    done.append(el("div", { className: "hint pad", textContent: project
      ? "Nothing in this project has been finished this week."
      : "Nothing has been finished this week." }));
  }
  for (const t of state_.finished || []) {
    done.append(queueRow(t, [
      t.assignee ? el("span", { className: "cell-text", textContent: t.assignee }) : null,
      el("span", { className: "t-due", textContent: ago(t.completed_at) }),
    ]));
  }
  root.append(done);
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
  const settings = await window.delphi.settings.get();

  // --- AI ------------------------------------------------------------------
  // Three ways in, and they are not equivalent. A CLI login spends a
  // subscription the person already pays for and this app never holds the
  // credential. An API key bills separately and has to be stored. Both are
  // offered rather than one being hidden, because which is right depends on what
  // they already have.
  const aiBox = el("div", { className: "setting" });
  aiBox.append(el("h3", { textContent: "AI" }));
  aiBox.append(el("p", {
    textContent: "Which agent the chat talks to. Signing in through a command line tool uses the subscription you already pay for, and no credential is stored here. An API key is billed separately and is kept encrypted by the operating system.",
  }));

  const providerList = el("div", { className: "provider-list" });
  aiBox.append(providerList);

  const paintProviders = async (force = false) => {
    providerList.textContent = "";
    // This is the slow one: it starts a login shell per tool to ask whether each
    // is signed in. Saying so beats an empty box that looks like the answer.
    providerList.append(el("div", { className: "provider-probing" },
      el("span", { className: "spinner" }),
      el("span", { textContent: "Checking what this machine can reach" })));
    let providers = [];
    try {
      providers = await window.delphi.ai.providers(force);
      state.providers = providers;
    } catch (error) {
      providerList.append(el("div", { className: "err-msg", textContent: String(error.message || error) }));
      return;
    }

    for (const p of providers) {
      const row = el("div", { className: "provider" });
      row.append(el("span", { className: "pdot" + (p.ready ? " on" : "") }));
      const text = el("div", { className: "grow" });
      text.append(el("div", { className: "pname", textContent: p.label }));
      text.append(el("div", { className: "hint", textContent: p.detail }));
      row.append(text);

      // Each unready provider says what would fix it, and gives the command
      // rather than describing it. Signing in needs a terminal in every case, so
      // the button copies the line instead of pretending it can do it here.
      if (!p.ready) {
        let fix = null;
        if (p.id === "claude-cli") fix = "claude";
        else if (p.id === "copilot" && p.host) fix = `gh auth login --hostname ${p.host} --web`;

        if (fix) {
          const copy = el("button", { className: "btn sm", textContent: "Copy command" });
          copy.onclick = async () => {
            await navigator.clipboard.writeText(fix);
            copy.textContent = "Copied";
            setTimeout(() => { copy.textContent = "Copy command"; }, 1400);
          };
          row.append(el("code", { className: "mono pfix", textContent: fix }), copy);
        }
      }
      providerList.append(row);
    }

    const recheck = el("button", { className: "btn sm", textContent: "Check again" });
    recheck.onclick = async () => { await paintProviders(true); };
    providerList.append(el("div", { className: "provider-foot" }, recheck));
  };
  await paintProviders();

  // --- the key -------------------------------------------------------------
  const keyMsg = el("span", { className: "hint" });
  const keyRow = el("div", { className: "row" });
  const keyField = el("input", {
    className: "field grow",
    type: "password",
    placeholder: "sk-ant-...",
    autocomplete: "off",
    spellcheck: false,
  });

  const paintKey = async () => {
    const has = await window.delphi.ai.hasKey();
    keyField.placeholder = has ? "A key is saved" : "sk-ant-...";
    keyField.value = "";
    clearBtn.style.display = has ? "" : "none";
  };

  const saveBtn = el("button", { className: "btn primary", textContent: "Save key" });
  saveBtn.onclick = async () => {
    const value = keyField.value.trim();
    if (!value) { keyMsg.className = "err-msg"; keyMsg.textContent = "Paste a key first."; return; }
    try {
      await window.delphi.ai.setKey(value);
      keyMsg.className = "ok-msg";
      keyMsg.textContent = "Saved, encrypted by the operating system.";
      await paintKey();
      await paintProviders();
    } catch (error) {
      keyMsg.className = "err-msg";
      keyMsg.textContent = String(error.message || error);
    }
  };

  const clearBtn = el("button", { className: "btn sm danger", textContent: "Remove" });
  clearBtn.onclick = async () => {
    await window.delphi.ai.setKey(null);
    keyMsg.className = "hint";
    keyMsg.textContent = "Key removed.";
    await paintKey();
    await paintProviders();
  };

  keyRow.append(keyField, saveBtn, clearBtn);
  await paintKey();

  aiBox.append(el("div", { className: "setting-sub" },
    el("h4", { textContent: "Anthropic API key" }),
    el("p", { className: "hint",
      textContent: "Only needed if you would rather not use a command line login. It never leaves this machine and is written to the keychain, not to settings.json." }),
    keyRow, keyMsg));

  root.append(aiBox);

  // --- harnesses -----------------------------------------------------------
  // The other agents, as rows you can edit. This is the difference between an
  // app that integrates with three tools and one that is a layer above any of
  // them: when a CLI renames a flag, the fix is here rather than in a release.
  const harnessBox = el("div", { className: "setting", id: "settings-agents" });
  harnessBox.append(el("h3", { textContent: "Agents" }));
  harnessBox.append(el("p", {
    textContent: "The coding agents that can run as a tab inside a project. Each one runs in the project's folder with Delphi's own MCP server attached, so it can read the pads, file tasks, and be seen doing it in History. Delphi never holds their credentials: each signs in its own way and Delphi only runs the binary.",
  }));

  const harnessList = el("div", { className: "provider-list" });
  harnessBox.append(harnessList);

  const paintHarnesses = async (force = false) => {
    harnessList.textContent = "";
    harnessList.append(el("div", { className: "provider-probing" },
      el("span", { className: "spinner" }),
      el("span", { textContent: "Looking for the agents on this machine" })));
    let rows = [];
    try {
      rows = await window.delphi.harnesses.list(force);
      state.harnesses = rows;
    } catch (error) {
      harnessList.append(el("div", { className: "err-msg", textContent: String(error.message || error) }));
      return;
    }
    harnessList.textContent = "";

    for (const h of rows) {
      const row = el("div", { className: "provider" });
      row.append(el("span", { className: "pdot" + (h.ready && h.enabled ? " on" : "") }));
      const text = el("div", { className: "grow" });
      text.append(el("div", { className: "pname", textContent: h.label }));
      text.append(el("div", { className: "hint", textContent: h.enabled ? (h.path || h.detail) : "turned off" }));
      row.append(text);

      const edit = el("button", { className: "btn sm", textContent: "Edit" });
      edit.onclick = () => openHarnessSheet(h, () => paintHarnesses(true));
      row.append(edit);

      const toggle = el("button", { className: "btn sm", textContent: h.enabled ? "Turn off" : "Turn on" });
      toggle.onclick = async () => {
        await window.delphi.harnesses.update(h.id, { enabled: h.enabled ? 0 : 1 });
        await paintHarnesses();
      };
      row.append(toggle);
      harnessList.append(row);
      const trust = harnessTrustRow(h, () => paintHarnesses(true));
      if (trust) harnessList.append(trust);
    }

    const add = el("button", { className: "btn sm", textContent: "Add an agent" });
    add.onclick = () => openHarnessSheet(null, () => paintHarnesses(true));
    const recheck = el("button", { className: "btn sm", textContent: "Check again" });
    recheck.onclick = async () => { await paintHarnesses(true); };
    harnessList.append(el("div", { className: "provider-foot" }, add, recheck));
  };
  await paintHarnesses();
  root.append(harnessBox);

  // --- appearance ----------------------------------------------------------
  const appearance = el("div", { className: "setting" });
  appearance.append(el("h3", { textContent: "Appearance" }));
  appearance.append(el("p", {
    textContent: "System follows whatever the Mac is set to and changes with it. Light and dark pin the window regardless.",
  }));

  const themes = el("div", { className: "seg", role: "group" });
  themes.setAttribute("aria-label", "Theme");
  for (const [value, label] of [["system", "System"], ["light", "Light"], ["dark", "Dark"]]) {
    const button = el("button", { type: "button", textContent: label });
    button.setAttribute("aria-pressed", String(state.theme === value));
    button.onclick = async () => {
      // Applied before the write so the window changes on the click rather than
      // after a round trip, and left applied if the write fails: the setting
      // not persisting is a smaller problem than the button looking dead.
      applyTheme(value);
      for (const b of themes.children) b.setAttribute("aria-pressed", String(b.textContent.toLowerCase() === value));
      try { await window.delphi.settings.set({ theme: value }); } catch {}
    };
    themes.append(button);
  }
  appearance.append(themes);
  root.append(appearance);

  // --- animation -----------------------------------------------------------
  const motion = el("div", { className: "setting" });
  motion.append(el("h3", { textContent: "Animation" }));
  motion.append(el("p", {
    textContent: "Covers the celebration when a task is ticked off, the bar that slides in when several are selected, the fade behind a dialog and every hover transition. Turning it off also removes the short pause before a completed task leaves the list. If your system is already set to reduce motion, that wins either way and this cannot switch it back on.",
  }));
  const motionRow = el("div", { className: "row" });
  const motionBox = el("input", { type: "checkbox", checked: settings.animations !== false, id: "animations" });
  const motionLbl = el("label", { htmlFor: "animations", textContent: "Animate the interface" });
  const motionMsg = el("span", { className: "hint" });
  motionBox.onchange = async () => {
    // Applied before the write, and not sent with anything else: the panelMode
    // branch of settings:set returns early when panel mode changes, so a batched
    // call would be dropped without an error.
    applyMotion(motionBox.checked);
    try {
      const updated = await window.delphi.settings.set({ animations: motionBox.checked });
      Object.assign(settings, updated);
      motionMsg.className = "ok-msg";
      motionMsg.textContent = "Saved";
    } catch (e) {
      motionMsg.className = "err-msg";
      motionMsg.textContent = e.message;
      motionBox.checked = !motionBox.checked;
      applyMotion(motionBox.checked);
    }
  };
  motionRow.append(motionBox, motionLbl, motionMsg);
  motion.append(motionRow);
  root.append(motion);

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
      await window.delphi.settings.setHotkey(accel);
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
      await window.delphi.settings.set({ panelMode: box.checked });
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
  root.append(remindersSettings(settings));

  // --- workbenches ---------------------------------------------------------
  // The two settings every Workbench reads. Saved on change, like the rest of
  // this page, and checked by the main process, whose refusal is shown as is.
  const benchBox = el("div", { className: "setting" });
  benchBox.append(el("h3", { textContent: "Workbenches" }));
  benchBox.append(el("p", {
    textContent: "A Workbench is a task's own folder and branch, so two pieces of work never share a checkout. These apply to every project; each repository's base branch, setup command and copied files are under Workbench settings on the project's Overview.",
  }));

  const benchField = ({ id, label, hint, value, placeholder, key }) => {
    const input = el("input", { className: "field mono-in", id, value: value || "", placeholder, spellcheck: false, autocomplete: "off" });
    const msg = el("span", { className: "hint" });
    let saved = value || "";
    input.onchange = async () => {
      try {
        const updated = await window.delphi.settings.set({ [key]: input.value.trim() || null });
        Object.assign(settings, updated);
        saved = input.value.trim();
        msg.className = "ok-msg";
        msg.textContent = "Saved";
      } catch (e) {
        msg.className = "err-msg";
        msg.textContent = e.message;
        input.value = saved;
      }
    };
    const sub = el("div", { className: "setting-sub" },
      el("h4", {}, el("label", { htmlFor: id, textContent: label })),
      el("p", { className: "hint", textContent: hint }),
      el("div", { className: "row" }, input, msg));
    return { sub, input };
  };

  const editor = benchField({
    id: "wb-editor", key: "workbenchEditor", value: settings.workbenchEditor, placeholder: "code",
    label: "Editor command",
    hint: "What Open and Open > Editor run, with the Workbench folder added on the end. Leave it empty for VS Code's code when it is installed, or else whatever the system opens a folder with. The terminal Sheet's W uses $VISUAL or $EDITOR instead.",
  });
  benchBox.append(editor.sub);

  const prefix = benchField({
    id: "wb-prefix", key: "workbenchBranchPrefix", value: settings.workbenchBranchPrefix, placeholder: settings.workbenchBranchPrefixDefault || "your username",
    label: "Branch prefix",
    hint: `What every Workbench branch starts with, so a shared remote shows whose branch is whose. Leave it empty for your username on this computer${settings.workbenchBranchPrefixDefault ? ` (${settings.workbenchBranchPrefixDefault})` : ""}.`,
  });
  // The same cleaning workbench/naming.js gives a prefix, so the example is
  // the name git will really be given.
  const cleanPrefix = (text) => String(text || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "").replace(/\.lock$/i, "").slice(0, 40);
  const example = el("p", { className: "hint wb-example" });
  const paintExample = () => {
    example.textContent = "";
    example.append("A task 42 called \"Fix the zip DLQ backlog\" gets ",
      el("span", { className: "mono", textContent: `${cleanPrefix(prefix.input.value) || settings.workbenchBranchPrefixDefault || "<your username>"}/42-fix-the-zip-dlq-backlog` }),
      ", or leads with its ticket, such as EF-1288, when it has one.");
  };
  prefix.input.addEventListener("input", paintExample);
  paintExample();
  prefix.sub.append(example);
  benchBox.append(prefix.sub);
  root.append(benchBox);

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
  openBtn.onclick = () => window.delphi.vault.reveal();
  exportBtn.onclick = async () => {
    try {
      const r = await window.delphi.vault.export();
      vmsg.className = "ok-msg";
      vmsg.textContent = `${r.notes} notes across ${r.projects} projects written`;
    } catch (e) { vmsg.className = "err-msg"; vmsg.textContent = e.message; }
  };
  vrow.append(openBtn, exportBtn, vmsg);
  v.append(vrow);
  v.append(el("p", { className: "hint", style: "margin-top:12px; margin-bottom:0",
    textContent: "The database stays the source of truth and the mirror is one way. Two way sync between a database and a folder is where these break, so edits made in Obsidian are not read back." }));
  root.append(v);

  // --- agent scratchpad ----------------------------------------------------
  const scratch = el("div", { className: "setting" });
  scratch.append(el("h3", { textContent: "Agent scratchpad" }));
  scratch.append(el("p", {
    textContent: "Agents write drafts, plans and working documents to temporary files by default, and those files are gone by the next session. Turn this on and every agent connected to this tracker is told to write them here as notes instead, where you and the next agent can both find them.",
  }));

  const scratchRow = el("div", { className: "row" });
  const scratchBox = el("input", { type: "checkbox", checked: settings.scratchpadMode === true, id: "scratchpad-mode" });
  const scratchLbl = el("label", { htmlFor: "scratchpad-mode", textContent: "Use this tracker as the scratchpad for connected agents" });
  const scratchMsg = el("span", { className: "hint" });
  scratchRow.append(scratchBox, scratchLbl, scratchMsg);
  scratch.append(scratchRow);

  // Where drafts land unless they plainly belong somewhere else. Offered whether
  // or not the checkbox is on, because choosing the destination first and then
  // switching it on is the order most people do it in.
  const destRow = el("div", { className: "row", style: "margin-top:12px" });
  destRow.append(el("label", { htmlFor: "scratchpad-project", textContent: "Default project" }));
  const dest = el("select", { className: "field", id: "scratchpad-project", style: "width:auto" });
  dest.append(el("option", { value: "", textContent: "No default, let the agent choose" }));
  for (const p of state.projects) {
    dest.append(el("option", { value: String(p.id), textContent: p.name, selected: settings.scratchpadProjectId === p.id }));
  }
  const destMsg = el("span", { className: "hint" });
  destRow.append(dest, destMsg);
  scratch.append(destRow);

  const saveScratch = async (fields, msg, node) => {
    try {
      const updated = await window.delphi.settings.set(fields);
      Object.assign(settings, updated);
      msg.className = "ok-msg";
      msg.textContent = "Saved";
    } catch (e) {
      msg.className = "err-msg";
      msg.textContent = e.message;
      if (node) node.checked = !node.checked;
    }
  };
  scratchBox.onchange = () => saveScratch({ scratchpadMode: scratchBox.checked }, scratchMsg, scratchBox);
  dest.onchange = () => saveScratch({ scratchpadProjectId: dest.value || null }, destMsg, null);

  scratch.append(el("p", { className: "hint", style: "margin:12px 0 0",
    textContent: "Agents already connected pick this up within a few seconds; there is nothing to restart. It does not apply to files that have to be files to work, such as scripts an agent runs or documents it generates." }));
  root.append(scratch);

  // --- second opinion ------------------------------------------------------
  const second = el("div", { className: "setting" });
  second.append(el("h3", { textContent: "Second opinion" }));
  second.append(el("p", {
    textContent: "Turn this on and every agent connected to this tracker is told to ask Copilot for a second opinion through the second_opinion tool: a review of the diff before a commit or pull request, and an independent diagnosis when it reaches a root cause. Copilot runs read only and can read this tracker's notes. Agents are told to verify what it says, to skip trivial work, and never to send it secrets or personal data.",
  }));
  const secondRow = el("div", { className: "row" });
  const secondBox = el("input", { type: "checkbox", checked: settings.secondOpinionMode === true, id: "second-opinion-mode" });
  const secondLbl = el("label", { htmlFor: "second-opinion-mode", textContent: "Ask Copilot for a second opinion on reviews and diagnoses" });
  const secondMsg = el("span", { className: "hint" });
  secondRow.append(secondBox, secondLbl, secondMsg);
  second.append(secondRow);
  secondBox.onchange = () => saveScratch({ secondOpinionMode: secondBox.checked }, secondMsg, secondBox);
  second.append(el("p", { className: "hint", style: "margin:12px 0 0",
    textContent: "The tool works whether or not this is on; this is whether agents are told to use it. Agents already connected are reminded through their next tool results. Copilot has to be installed and signed in on this machine." }));
  root.append(second);

  // --- mouse buttons -------------------------------------------------------
  const mouse = el("div", { className: "setting" });
  mouse.append(el("h3", { textContent: "Using a mouse button" }));
  mouse.append(el("p", { style: "margin-bottom:0",
    textContent: "A global shortcut can only be a keyboard combination, so a mouse button cannot be bound here directly. Do it the other way round: in your mouse software, map the side button to send the combination above. The panel cannot tell the difference. Logitech Options, SteerMouse and Razer Synapse all do this." }));
  root.append(mouse);

  // --- archived projects ---------------------------------------------------
  // Drawn even when the archive is empty. A heading that only appears once
  // something is hidden cannot be found by the person hunting for where their
  // project went, and that is the single moment anyone wants this section.
  const arch = el("div", { className: "setting" });
  arch.append(el("h3", { textContent: "Archived projects" }));
  arch.append(el("p", {
    textContent: "Archiving takes a project out of the project switcher and out of every list without deleting any of it, and this is the only place archived projects can be reached from. Restoring brings one back with everything it holds, marked active: nothing records whether it was paused or blocked before it was archived.",
  }));

  let archived = [];
  let archivedError = null;
  try {
    archived = await window.delphi.projects.archived();
  } catch (e) {
    // Reported in place rather than allowed to throw. The rest of this page has
    // nothing to do with the archive, and losing every other setting because one
    // query failed is a worse outcome than one section saying why it is empty.
    archivedError = e.message;
  }

  if (archivedError) {
    arch.append(el("p", { className: "err-msg", style: "margin:0", textContent: archivedError }));
  } else if (!archived.length) {
    arch.append(el("p", { className: "hint", style: "margin:0",
      textContent: "Nothing is archived. A project is archived from the Settings tab inside it, or from the ... menu on its row in the project switcher." }));
  } else {
    const box = el("div", { className: "list-box" });
    for (const p of archived) {
      const row = el("div", { className: "list-row" });
      row.append(el("span", { className: "dot", style: `background:${safeColour(p.colour)}` }));

      // What it still holds, so restoring is a decision rather than a guess. An
      // archived project that turns out to be empty is one you can leave alone.
      const parts = [
        p.total_count ? plural(p.total_count, "task", "tasks") : null,
        p.open_count ? `${p.open_count} still open` : null,
        p.note_count ? plural(p.note_count, "note", "notes") : null,
      ].filter(Boolean);
      row.append(el("div", { className: "grow" },
        el("div", { textContent: p.name }),
        el("span", { className: "hint", textContent: parts.length ? parts.join(", ") : "Empty" })));

      const msg = el("span", { className: "hint" });
      const restore = el("button", { className: "btn sm", textContent: "Restore" });
      restore.onclick = async () => {
        restore.disabled = true;
        try {
          await window.delphi.projects.update(p.id, { status: "active" });
        } catch (e) {
          msg.className = "err-msg";
          msg.textContent = e.message;
          restore.disabled = false;
          return;
        }
        // Nothing says "Saved". The row leaves this list and the project appears
        // in the sidebar in the same frame, which is a better confirmation than
        // any text this pane could show a moment before being replaced.
        await refresh();
      };
      row.append(msg, restore);
      box.append(row);
    }
    arch.append(box);
  }
  root.append(arch);

  // Next frame rather than now: the section has just been appended and the pane
  // is still growing, so a scroll measured here lands short.
  if (revealArchived) {
    revealArchived = false;
    requestAnimationFrame(() => arch.scrollIntoView({ block: "start" }));
  }

  // --- data ----------------------------------------------------------------
  const data = el("div", { className: "setting" });
  data.append(el("h3", { textContent: "Where your data lives" }));
  const dl = el("dl", { className: "kv" });
  data.append(dl);
  root.append(data);
  paintDataInfo(data, dl);
  if (window.DelphiBackups) DelphiBackups.paint(root);
}

/**
 * The database this window is really reading, asked of the main process.
 *
 * This used to be a hard-coded path, and it went on naming the checkout's
 * database while the app read another one. That is the split that left agents
 * writing handoffs to a file nothing dispatched from. So it says "unknown"
 * when it cannot ask rather than guess, and names a second database that is
 * being ignored, because that is the one someone will open by mistake.
 */
async function paintDataInfo(section, dl) {
  let info = null;
  try {
    const ask = window.delphi.app && window.delphi.app.dataInfo;
    info = typeof ask === "function" ? await ask() : null;
  } catch { info = null; }

  const pathRow = (label, value) => {
    const dd = el("dd", { className: "data-path" });
    dd.append(el("span", { className: "mono", textContent: value || "unknown" }));
    if (value) {
      const copy = el("button", { className: "btn sm", type: "button", textContent: "Copy", title: `Copy ${value}` });
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(value);
          copy.textContent = "Copied";
          setTimeout(() => { copy.textContent = "Copy"; }, 1200);
        } catch (error) { notifyError(error); }
      };
      dd.append(copy);
    }
    dl.append(el("dt", { textContent: label }), dd);
  };

  pathRow("Database", info && info.path);
  if (info && info.dbId) {
    dl.append(el("dt", { textContent: "Database id" }),
      el("dd", {}, el("span", { className: "mono", textContent: String(info.dbId).slice(0, 8), title: String(info.dbId) })));
  }
  const dir = info && info.dataDir;
  pathRow("Settings", dir ? `${dir.replace(/[\\/]+$/, "")}/settings.json` : null);
  dl.append(el("dt", { textContent: "History" }), el("dd", { textContent: "Every change is recorded and can be reversed." }));

  // Shown until acknowledged, then not again for that path. A notice on every
  // visit is one people learn to scroll past, which is worse than none. The
  // wording never says delete: the other file holds work this one lacks, and
  // removing it before merging is the one way to lose that work for good.
  if (info && info.checkoutNoticeDue && typeof info.checkoutDbIgnored === "string") {
    const other = info.checkoutDbIgnored;
    const note = el("div", { className: "data-warn", role: "status" });
    note.append(el("span", {
      textContent: `A second database at ${other} holds work this one doesn't have. It isn't used. Merge it in before removing it.`,
    }));
    const seen = el("button", { className: "btn sm", type: "button", textContent: "Got it" });
    seen.onclick = async () => {
      seen.disabled = true;
      try {
        await window.delphi.settings.set({ checkoutNoticeSeen: other });
        note.remove();
      } catch (error) {
        seen.disabled = false;
        notifyError(error);
      }
    };
    note.append(seen);
    section.append(note);
  }
}

// ---------------------------------------------------------------------------
// The task sheet
//
// A task in a list is a line of text. Opened, it is the whole story: what state
// it has been through and for how long, what was said about it, what it is made
// of, and who is holding it.
//
// Two things here are deliberate rather than decorative. The timeline shows
// durations rather than timestamps, because "blocked for four days" is the thing
// anyone actually wants to know and a pair of dates makes you do the arithmetic.
// And the handoff block turns the task into a brief an agent can act on, because
// the alternative is a person retyping the same context into a chat window.
// ---------------------------------------------------------------------------

const STATUSES = [
  ["todo", "To do"],
  ["doing", "In progress"],
  ["blocked", "Blocked"],
  ["done", "Done"],
];

/**
 * Names that belong to software rather than to a person.
 *
 * The same test as inferAuthorType in sheet/format.js. Keep the two identical,
 * or the rail and the text format will disagree about who said something. The
 * colon is what an actor launched by Delphi carries (claude-code:12).
 */
const isAgent = (name) => /claude|copilot|codex|cursor|agent|gpt|bot|runner|:/i.test(String(name || ""));

/** An entry's author is software. What the writer recorded wins over the name. */
const entryIsAgent = (entry) => entry.author_type ? entry.author_type !== "human" : isAgent(entry.author);

// The text format's sigils, so the rail reads the way `delphi cat` prints.
const SIGILS = { say: ">", agent: "@", run: "$", ask: "?", decide: "=", note: "!" };
const KIND_WORD = { say: "said", agent: "agent said", run: "ran", ask: "asked", decide: "decided", note: "note" };
const NOTE_KINDS = ["decision", "gotcha", "reference", "note"];

// Whether the rail shows the ledger or everything. Per window rather than per
// task: someone reviewing ledgers wants the next task opened the same way.
let railLedger = false;

/**
 * Terminal colour and cursor codes out of text that is about to be shown. The
 * main process strips logs already; this is for meta written by an agent,
 * which nothing upstream has to have cleaned.
 */
const stripAnsi = (text) => String(text == null ? "" : text)
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
  .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
  .replace(/\x1b[@-Z\\-_]/g, "")
  .replace(/\x1b/g, "");

/** How long a run has been going, to the second, for the clock on a running entry. */
function elapsed(fromIso) {
  const s = TIME.secondsSince(fromIso) || 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const isRunning = (entry) => entry.kind === "run" && !!entry.meta && entry.meta.state === "running";

/** A run's duration as a person would say it: 340ms, 1.2s, 3m 4s. */
function duration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Fixed markup, never anything from the database, which is why innerHTML is
// acceptable for these and nowhere near an entry's text.
const TS_ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  file: '<path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  caret: '<path d="M6 9l6 6 6-6"/>',
  dots: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
};
function tsIcon(name, width = 2) {
  const holder = document.createElement("span");
  holder.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TS_ICONS[name]}</svg>`;
  return holder.firstChild;
}

/** One Sheet entry as a line of a brief, by kind, so a run or an ask still reads. */
function entryBriefLine(entry, all) {
  const flat = (text) => String(text || "").replace(/\s+/g, " ").trim();
  if (entry.kind === "run") {
    const m = entry.meta || {};
    const result = m.state ? ` (${m.state}${m.state === "fail" && m.code != null ? `:${m.code}` : ""})` : "";
    return `${entry.author} ran: ${flat(entry.body)}${result}`;
  }
  if (entry.kind === "ask") {
    const options = (entry.meta && Array.isArray(entry.meta.options)) ? entry.meta.options : [];
    return `${entry.author} asked: ${flat(entry.body)} ${options.map((o) => `[${o.key}] ${o.label}`).join(" ")}`.trim();
  }
  if (entry.kind === "decide") {
    const lines = String(entry.body || "").split("\n");
    const ask = all.find((e) => e.id === entry.ref_id);
    const label = (entry.meta && entry.meta.label) || "";
    const why = flat(lines.slice(1).join(" "));
    return `${entry.author} decided [${(entry.meta && entry.meta.choice) || lines[0]}] ${label}` +
      `${ask ? ` on "${flat(ask.body)}"` : ""}${why ? `: ${why}` : ""}`;
  }
  return `${entry.author}${entry.kind === "note" ? " (note)" : ""}: ${flat(entry.body)}`;
}

/**
 * A gap in words.
 *
 * Rounded to one unit on purpose: this is read at a glance to answer "was that
 * recent", and "3d" answers it where "3 days 4 hours 12 minutes" does not.
 */
function gap(fromIso, toIso) {
  const from = TIME.parseStamp(fromIso)?.getTime() ?? NaN;
  const to = toIso ? (TIME.parseStamp(toIso)?.getTime() ?? NaN) : Date.now();
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 90) return "moments";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * The task as something an agent can be handed.
 *
 * Everything it would otherwise have to ask for, plus the exact calls that change
 * it, so the agent does not have to guess the tool names. Copied rather than sent
 * anywhere: which agent gets this is the person's decision, not the app's.
 */
function handoffText(detail) {
  const t = detail.task;
  const lines = [
    `Delphi task ${t.id}: ${t.title}`,
    detail.project ? `Project: ${detail.project.name}` : null,
    `Status: ${t.status}   Priority: ${t.priority}` +
      (t.due ? `   Due: ${t.due}` : "") +
      (t.assignee ? `   Assignee: ${t.assignee}` : ""),
    t.ref ? `Reference: ${t.ref}` : null,
    "",
    t.detail ? t.detail.trim() : "(no detail written)",
  ].filter((line) => line !== null);

  if (detail.subtasks.length) {
    lines.push("", "Subtasks:");
    for (const s of detail.subtasks) lines.push(`  [${s.status === "done" ? "x" : " "}] ${s.title}`);
  }

  if (detail.comments.length) {
    lines.push("", "Discussion so far:");
    for (const c of detail.comments) lines.push(`  ${entryBriefLine(c, detail.comments)}`);
  }

  if (detail.events.length > 1) {
    lines.push("", "How it got here:");
    for (let i = 0; i < detail.events.length; i++) {
      const e = detail.events[i];
      const next = detail.events[i + 1];
      lines.push(`  ${e.status} for ${gap(e.at, next ? next.at : null)}${e.actor ? ` (${e.actor})` : ""}`);
    }
  }

  lines.push(
    "",
    "To act on this through the Delphi MCP server:",
    `  update_task(id: ${t.id}, status: "doing")`,
    `  update_task(id: ${t.id}, status: "done")`,
    "  add_note(project, title, body, kind) for anything worth keeping afterwards"
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Workbenches
//
// A task's own folder and branch. The verbs live in workbench/workbench.js and
// arrive here as plain-English results or plain-English errors; the window's
// job is to ask before anything that could lose work and to show those words
// as they were written, never to translate them back into git.
// ---------------------------------------------------------------------------

// Kept at module scope rather than in the task panel, because a Start's setup
// can outlive the panel it was started from and should still read as Starting
// when the task is opened again. taskId -> { phase, text }.
const wbStarting = new Map();

/**
 * A message that has to be read, not glanced at: an error from git, a warning
 * from Start, the outcome of Finish. The header flash is gone in a second and a
 * half, which suits "saved" and not "the push was refused because...". Shown
 * over everything, including a dialog, and for longer the more there is to read.
 */
let toastTimer = null;
function notify(text, { error = false } = {}) {
  const words = String(text && text.message ? text.message : text || "").trim();
  if (!words) return;
  let toast = document.querySelector(".wb-toast");
  if (!toast) {
    toast = el("div", { className: "wb-toast" });
    toast.onclick = () => toast.remove();
    document.body.append(toast);
  }
  toast.className = "wb-toast" + (error ? " err" : "");
  toast.setAttribute("role", error ? "alert" : "status");
  toast.textContent = words;
  clearTimeout(toastTimer);
  const ms = Math.min(14000, 3000 + words.length * 45);
  toastTimer = setTimeout(() => toast.remove(), ms);
}
const notifyError = (error) => {
  // A CLOSING refusal that has gone on for minutes is probably an interrupted
  // Finish or Discard, and the Sheet's note says where the folder went.
  const closing = error && error.code === "CLOSING" && error.details ? error.details.closing : null;
  const hint = closing && closingLong(closing) ? " The Sheet says where the folder is." : "";
  notify(`${error && error.message ? error.message : error}${hint}`, { error: true });
};

// Long enough that a Finish or Discard is not just slow but was interrupted.
const CLOSING_LONG_MS = 3 * 60 * 1000;

/** Whether a closing began more than a few minutes ago. at is SQLite's UTC "YYYY-MM-DD HH:MM:SS". */
function closingLong(closing) {
  if (!closing || !closing.at) return false;
  const at = TIME.parseStamp(closing.at);
  return !!at && Date.now() - at.getTime() > CLOSING_LONG_MS;
}


/**
 * A question with buttons. Resolves to the chosen action's value, or to
 * cancelValue on Escape or a click outside.
 *
 * Enter does what it does on the focused control: a focused button presses
 * itself, so tabbing to Cancel and pressing Enter cancels. Only in a text
 * field does Enter mean the primary action, and only when it is enabled,
 * which is what keeps a typed-confirm Discard from going early. Focus stays
 * inside while it is open and goes back where it was when it closes.
 */
function wbDialog({ title, lead = null, body = [], actions, cancelValue = null, className = "" }) {
  return new Promise((resolve) => {
    const overlay = el("div", { className: "overlay" });
    const box = el("div", { className: `ask wb-dialog ${className}`.trim(), role: "dialog" });
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", title);
    const returnTo = document.activeElement;
    const me = { box };
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      const at = dialogStack.indexOf(me);
      if (at >= 0) dialogStack.splice(at, 1);
      overlay.remove();
      // The control that opened it may have been redrawn meanwhile (the
      // Workbench header is, after most verbs); its data-act finds the new one.
      let back = returnTo && returnTo.isConnected ? returnTo : null;
      if (!back && returnTo && returnTo.dataset && returnTo.dataset.act) {
        back = document.querySelector(`.wb [data-act="${CSS.escape(returnTo.dataset.act)}"]`);
      }
      if (back && typeof back.focus === "function") back.focus({ preventScroll: true });
      resolve(value);
    };
    const buttons = actions.map((a) => {
      const b = el("button", { className: `btn ${a.kind || ""}`.trim(), textContent: a.label, type: "button" });
      b.onclick = () => { if (!b.disabled) finish(a.value); };
      if (a.bind) a.bind(b);
      return b;
    });
    const primary = buttons[actions.findIndex((a) => a.kind === "primary" || a.kind === "danger")] || null;
    const focusables = () => [...box.querySelectorAll("button, input, select, textarea, [tabindex]")]
      .filter((n) => !n.disabled && n.tabIndex >= 0 && n.offsetParent !== null);
    const onKey = (event) => {
      if (dialogStack[dialogStack.length - 1] !== me) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(cancelValue);
      } else if (event.key === "Enter" && !event.isComposing) {
        event.stopPropagation();
        const t = event.target;
        const typing = t && t.tagName === "INPUT" && !["checkbox", "radio", "button", "submit"].includes(t.type);
        if (typing) {
          event.preventDefault();
          if (primary && !primary.disabled) primary.click();
        }
        // Anything else keeps its own Enter: a button presses itself.
      } else if (event.key === "Tab") {
        const list = focusables();
        if (!list.length) { event.preventDefault(); return; }
        const at = list.indexOf(document.activeElement);
        if (event.shiftKey && (at <= 0)) { event.preventDefault(); list[list.length - 1].focus(); }
        else if (!event.shiftKey && (at === -1 || at === list.length - 1)) { event.preventDefault(); list[0].focus(); }
      }
    };
    dialogStack.push(me);
    document.addEventListener("keydown", onKey, true);
    box.append(el("h3", { textContent: title }));
    if (lead) box.append(el("p", { className: "wb-lead", textContent: lead }));
    for (const node of body) if (node) box.append(node);
    box.append(el("div", { className: "ask-actions" }, buttons));
    overlay.append(box);
    overlay.onclick = (event) => { if (event.target === overlay) finish(cancelValue); };
    document.body.append(overlay);
    const focus = box.querySelector("input") || primary || buttons[buttons.length - 1];
    if (focus) focus.focus();
  });
}

/** A list of file names or commits, cut short with a count of the rest. */
function wbList(items, render, cap = 8) {
  const ul = el("ul");
  for (const item of items.slice(0, cap)) ul.append(el("li", {}, render(item)));
  if (items.length > cap) ul.append(el("li", { className: "hint", textContent: `and ${items.length - cap} more` }));
  return ul;
}

/** How long ago an ISO time was, for the chip's "checked" line. */
function agoWords(iso) {
  const s = TIME.secondsSince(iso);
  if (!Number.isFinite(s)) return "";
  if (s < 60) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** Which of the chip's looks a Workbench gets: one per state, in words, never git's. */
function wbLook(wb) {
  const st = wb.status || {};
  // A folder that is there but cannot be read: drawn like Missing, in the
  // module's own words, because Finish and Discard both refuse it. Asked
  // first, since the folder decides and not the row.
  // Mid Finish or Discard, or interrupted in one: nothing may be done to it
  // until that ends, so it is drawn plainly and offers nothing.
  if (wb.state === "closing" || st.state === "closing") return { cls: "closing", words: "Being put away", closing: wb.closing || st.closing || null };
  if (st.state === "unreadable") return { cls: "missing", words: st.words || "Unreadable", unreadable: true };
  if (wb.state === "missing" || st.state === "missing") return { cls: "missing", words: "Missing" };
  if (wb.state === "parked") return { cls: "parked", words: "Parked" };
  return { cls: st.state || "ready", words: st.words || "Ready" };
}

/**
 * The status chip. Update rides inside it when the branch is behind, because
 * that is the moment it means something; under More it is always there.
 */
function wbChip(wb, onUpdate) {
  const st = wb.status || {};
  const { cls, words } = wbLook(wb);
  const chip = el("span", { className: `wb-chip ${cls}` }, el("span", { className: "wb-words", textContent: words }));
  // The words in full as well, since a narrow row cuts them short. Worked
  // out again on hover and on each refresh, so "Checked 4s ago" stays true
  // without the chip being rebuilt; wbTitle takes the newest status.
  let latest = st;
  const closing = wbLook(wb).closing;
  chip.wbTitle = (next) => {
    if (next) latest = next;
    if (cls === "closing") {
      chip.title = `A ${closing ? closing.mode : "Finish or Discard"} is in progress${closing && closing.actor ? `, begun by ${closing.actor}` : ""}.${closingLong(closing) ? " The Sheet says where the folder is." : ""}`;
      return;
    }
    const checked = latest.checkedAt ? `Checked ${agoWords(latest.checkedAt)}` : "";
    chip.title = (cls === "parked" || cls === "missing") && latest.words && latest.words !== words ? `${latest.words}. ${checked}`
      : latest.message ? `${latest.message} ${checked}` : `${words}. ${checked}`;
  };
  chip.wbTitle();
  chip.addEventListener("mouseenter", () => chip.wbTitle());
  if (onUpdate && st.behind > 0 && cls !== "parked" && cls !== "missing" && cls !== "closing") {
    const act = el("button", { className: "wb-act", textContent: "Update", type: "button" });
    act.title = `Bring in the latest ${st.base || wb.base}`;
    act.onclick = (e) => { e.stopPropagation(); onUpdate(act); };
    chip.append(act);
  }
  return chip;
}

// Tasks whose Workbench has a verb running, from any surface: the task
// panel, a done prompt, the Overview. One flag per task, so a double click,
// or a Finish from a prompt while the panel has one going, starts nothing.
const wbBusyTasks = new Set();

/** Runs fn unless this task's Workbench is already busy; resolves to its result, or undefined when skipped. */
async function wbGuard(taskId, fn) {
  const key = Number(taskId);
  if (wbBusyTasks.has(key)) return undefined;
  wbBusyTasks.add(key);
  const repaint = () => { if (openSheet && openSheet.taskId === key && openSheet.wbRepaint) openSheet.wbRepaint(); };
  repaint();
  try { return await fn(); } finally {
    wbBusyTasks.delete(key);
    repaint();
  }
}

/** Update from base, said in the module's own words whichever way it went. */
async function wbUpdate(wb) {
  try {
    const r = await window.delphi.workbench.update(wb.id);
    if (r.ok) notify(`Updated from ${wb.base}. ${r.words}`);
    else notifyError(r.conflict && r.conflict.files && r.conflict.files.length
      ? `${r.words} Clashing: ${r.conflict.files.join(", ")}.` : r.words);
  } catch (error) { notifyError(error); }
}

/**
 * Finish, without ever losing work.
 *
 * The module refuses a Finish with unsaved changes or unshared commits, and it
 * is right to. This walks the person through each refusal before it happens,
 * asking at every step, so the folder is only removed once its work is safe on
 * the remote. Every step can be cancelled and nothing is done behind a dialog.
 */
function finishWorkbench(wbId, taskId, opts = {}) {
  return wbGuard(taskId, () => finishFlow(wbId, taskId, opts));
}

async function finishFlow(wbId, taskId, { title = "", after = null } = {}) {
  const done = async () => { if (after) await after(); };
  const wbApi = window.delphi.workbench;
  try {
    let st = await wbApi.status(wbId, { fresh: true });

    // Mid-rebase, commits on no branch, a folder git cannot read: nothing a
    // dialog here can fix. Finish refuses all three before it touches
    // anything, so asking it is how its own sentence reaches the person.
    if (st.state === "unreadable" || st.operation || st.lonely) {
      await wbApi.finish(wbId);
      return;
    }

    // A repository inside the folder, or a file Delphi cannot read, stops
    // Finish outright, and asked first: a nested repository looks like an
    // unsaved folder, and committing it would record a link to it and none
    // of its files.
    const first = await wbApi.finishPlan(wbId);
    if (first.blocked) { await wbStop(first.blocked.code === "NESTED" ? "Other repositories are inside this folder" : "Finish cannot go ahead", first.blocked.message, first.nested && first.nested.length ? first.nested : first.unreadable); return; }

    // Hidden changes (assume-unchanged, skip-worktree) are unsaved work that
    // an ordinary commit leaves behind, so committing here would not clear
    // them. Finish's own refusal explains them; it refuses before touching
    // anything, so asking it is safe.
    if (st.hidden && st.hidden.length) {
      try { await wbApi.finish(wbId); } catch (error) {
        if (error.code !== "UNSAVED") throw error;
        const hidden = (error.details && error.details.hidden) || st.hidden;
        await wbStop("Hidden changes in the folder", error.message, hidden);
      }
      return;
    }
    if (st.unsaved) {
      const files = el("div", { className: "grp" },
        el("div", { className: "grp-h" }, el("span", { className: "n", textContent: String(st.unsaved) }),
          st.unsaved === 1 ? "unsaved change" : "unsaved changes"),
        wbList(st.files || [], (f) => el("span", { className: "mono", textContent: f })));
      const go = await wbDialog({
        title: "Save the changes first?",
        lead: "Finish only removes a folder when everything in it is saved. Commit them to the branch, or cancel and keep working.",
        body: [files],
        actions: [{ label: "Cancel", value: null }, { label: "Commit them", value: "commit", kind: "primary" }],
      });
      if (go !== "commit") return;
      const message = await askText({
        title: "Commit message",
        label: "Every changed file goes into one commit on the Workbench's branch.",
        value: title, confirmLabel: "Commit",
      });
      if (!message) return;
      st = await wbApi.commit(wbId, message);
      await done();
    }

    if (st.ahead) {
      const go = await wbDialog({
        title: `${plural(st.ahead, "commit", "commits")} not shared yet`,
        lead: `Finish only removes a folder whose work is safe on the remote. Push the branch to share ${st.ahead === 1 ? "it" : "them"}.`,
        actions: [{ label: "Cancel", value: null }, { label: "Push", value: "push", kind: "primary" }],
      });
      if (go !== "push") return;
      const pushed = await wbApi.push(wbId);
      await done();
      if (!pushed.ok) { notifyError(pushed.reason); return; }
    }

    // Files git does not keep (a build, an .env that was edited) go with the
    // folder. Read again after the commit and push, before the pull request
    // is offered, so nobody opens one and then learns Finish cannot go ahead.
    const plan = await wbApi.finishPlan(wbId);
    if (plan.blocked) { await wbStop(plan.blocked.code === "NESTED" ? "Other repositories are inside this folder" : "Finish cannot go ahead", plan.blocked.message, plan.nested && plan.nested.length ? plan.nested : plan.unreadable); return; }

    const pr = await wbApi.pr(wbId);
    if (pr.via) {
      const go = await wbDialog({
        title: "Open a pull request?",
        lead: pr.via === "gh"
          ? "The branch is on the remote. GitHub's command line can open the pull request now, or find the one already open."
          : "The branch is on the remote. This opens the host's page for starting a pull request.",
        actions: [
          { label: "Cancel", value: null },
          { label: "Finish without one", value: "skip" },
          { label: "Open pull request", value: "pr", kind: "primary" },
        ],
      });
      if (!go) return;
      if (go === "pr") {
        const made = await wbApi.pr(wbId, { create: true });
        // No pull request and no page to open one on: stop here, with the
        // folder still in place, rather than finish as though it had worked.
        if (!made.url) { notifyError(made.reason || "Could not open a pull request."); return; }
        window.delphi.openExternal(made.url);
        if (made.reason) notify(made.reason);
      }
    }

    let confirm = null;
    if (plan.needsConfirm) {
      if (!(await confirmIgnored(plan))) return;
      confirm = plan.confirm;
    }
    // The token agrees to exactly the files that were shown. When the folder
    // changed since, Finish refuses with the new list and a new token, and the
    // person is asked again about what is there now.
    let r = null;
    for (let tries = 0; !r; tries++) {
      try {
        r = await wbApi.finish(wbId, confirm ? { confirm } : {});
      } catch (error) {
        if (error.code !== "IGNORED" || !error.details || !error.details.confirm || tries >= 4) throw error;
        if (!(await confirmIgnored(error.details, { changed: true }))) return;
        confirm = error.details.confirm;
      }
    }
    notify(`Finished. The folder is gone and the branch ${r.branch} is kept.${keptWords(r)}${cleanupWords(r)}`);
    noticeKept(r);
    await done();

    if (r.taskStatus === "doing") {
      const mark = await wbDialog({
        title: `Mark task ${taskId} done?`,
        lead: "The Workbench is finished and the task is still in progress.",
        actions: [{ label: "Leave it", value: null }, { label: "Mark done", value: "done", kind: "primary" }],
      });
      if (mark === "done") {
        await window.delphi.tasks.update(taskId, { status: "done" });
        await done();
      }
    }
  } catch (error) {
    if (error.code === "BUSY") await showBusy(taskId, error);
    else notifyError(error);
    await done();
  }
}

/**
 * What was kept, in a line. The command to get it back is long, and the
 * Sheet already carries it in the module's own note, so the toast points
 * there rather than repeating a path nobody can read in a toast.
 */
function keptWords(r) {
  if (!r || !r.recover) return "";
  const until = r.until || (/until (\S+)/.exec(r.recover) || [])[1];
  return ` A copy is kept${until ? ` until ${until}` : ""}; the Sheet says how to get it back.`;
}

/** The old folder is emptied in the background; said in passing, never waited on. */
function cleanupWords(r) {
  return r && r.cleanup && r.cleanup.pending ? " Removing the old folder in the background." : "";
}

/**
 * Something changed in the old folder after the copy was made, so it was
 * kept rather than deleted. Not an error, nothing was lost, but it is a
 * folder the person now has to look through, so it gets its own dialog
 * with where it is. The Sheet has the module's note too.
 */
function noticeKept(r) {
  const c = r && r.cleanup;
  if (!c || !c.kept) return;
  const changed = Array.isArray(c.changed) ? c.changed : [];
  wbDialog({
    title: "The old folder was kept",
    lead: `${changed.length ? `${changed.length === 1 ? "A file" : "Some files"} changed after the copy was made` : "Something changed after the copy was made"}, so the folder was not deleted. Look through it, then delete it yourself.`,
    body: [
      el("p", { className: "wb-lead" }, "It is at ", el("span", { className: "mono", textContent: String(c.kept) })),
      changed.length ? el("div", { className: "grp" }, el("div", { className: "grp-h" }, "Changed after the copy"),
        wbList(changed, (f) => el("span", { className: "mono", textContent: f }))) : null,
    ],
    actions: [{ label: "OK", value: null, kind: "primary" }],
  });
}

/**
 * BUSY because something is running in the folder: the module's sentence,
 * and each thing it names. A `$` run on this task can be shown or stopped
 * from here; anything else (an agent's claim, another task's run) is
 * listed so the person knows what to wait for.
 */
async function showBusy(taskId, error) {
  const running = (error.details && Array.isArray(error.details.running)) ? error.details.running : [];
  if (!running.length) { notifyError(error); return; }
  let mine = new Set();
  try {
    const d = await window.delphi.tasks.detail(taskId);
    mine = new Set(((d && d.comments) || []).filter(isRunning).map((c) => c.id));
  } catch {}
  let jump = null;
  const rows = running.map((text) => {
    const m = /\(entry (\d+)\)\s*$/.exec(String(text));
    const id = m ? Number(m[1]) : null;
    const li = el("li", {}, el("span", { className: "mono", textContent: String(text) }));
    if (id != null && mine.has(id)) {
      const show = el("button", { className: "ts-linkbtn", type: "button", textContent: "Show" });
      show.onclick = () => { jump = id; li.closest(".wb-dialog").querySelector(".ask-actions .btn").click(); };
      const stop = el("button", { className: "ts-linkbtn ts-stop", type: "button", textContent: "Stop" });
      stop.onclick = async () => {
        try {
          await window.delphi.sheets.interrupt(id);
          stop.textContent = "Stopping";
          stop.disabled = true;
        } catch (e) { notifyError(e); }
      };
      li.append(el("span", { className: "wb-li-acts" }, show, stop));
    }
    return li;
  });
  await wbDialog({
    title: "Something is still running in the folder",
    lead: error.message,
    body: [el("div", { className: "grp" }, el("ul", {}, rows))],
    actions: [{ label: "OK", value: null, kind: "primary" }],
  });
  if (jump != null) {
    if (!(openSheet && openSheet.taskId === Number(taskId))) await openTaskSheet(taskId);
    if (openSheet && openSheet.showEntry) openSheet.showEntry(jump);
  }
}

/** A byte count as a person reads it. */
function sizeWords(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** What a snapshot leaves out, said before anyone agrees to it. */
function notKeptGroup(notKept) {
  if (!notKept || !notKept.length) return null;
  // The only things a Finish or Discard loses for good, so they lead in the
  // danger colour and say so in as many words.
  return el("div", { className: "grp lost" },
    el("div", { className: "grp-h" }, "Not kept, gone for good"),
    wbList(notKept, (f) => [el("span", { className: "mono", textContent: f.path || f }), f.why ? el("span", { className: "hint", textContent: f.why }) : null]));
}

/** A refusal that nothing in a dialog can fix: the module's words, and what they name. */
function wbStop(title, message, items = []) {
  return wbDialog({
    title,
    lead: message,
    body: items && items.length ? [el("div", { className: "grp" }, wbList(items, (p) => el("span", { className: "mono", textContent: p })))] : [],
    actions: [{ label: "OK", value: null, kind: "primary" }],
  });
}

/**
 * The "these can go" step of Finish: the ignored folders and the copied files
 * that differ from the main checkout, named, with what is kept and for how long.
 */
function confirmIgnored(plan, { changed: again = false } = {}) {
  const body = [];
  if (again) body.push(el("p", { className: "wb-lead", textContent: "The folder changed since you were last asked. This is what is there now." }));
  body.push(notKeptGroup(plan.notKept));
  const ignored = plan.ignored || [];
  if (ignored.length) {
    body.push(el("div", { className: "grp" },
      el("div", { className: "grp-h" }, "Files git does not keep"),
      wbList(ignored, (g) => [el("span", { className: "mono", textContent: g.dir }),
        el("span", { className: "hint", textContent: `${plural(g.count, "file", "files")}, ${sizeWords(g.bytes)}` })])));
  }
  const changed = plan.changedCopies || [];
  if (changed.length) {
    body.push(el("div", { className: "grp" },
      el("div", { className: "grp-h" }, "Copied in at Start, and changed since"),
      wbList(changed, (f) => [el("span", { className: "mono", textContent: f }),
        el("span", { className: "hint", textContent: "differs from the main checkout" })])));
  }
  body.push(el("p", { className: "wb-lead", textContent: plan.notKept && plan.notKept.length
    ? "A copy of the rest is kept for 30 days, and Finish says how to get it back."
    : "A copy of them is kept for 30 days, and Finish says how to get it back." }));
  return wbDialog({
    title: "These go with the folder",
    lead: "The branch keeps your commits, but not these. Finishing removes them.",
    body,
    actions: [{ label: "Cancel", value: false }, { label: "These can go", value: true, kind: "primary" }],
    cancelValue: false,
  });
}

/** A recover command as a block that can be copied, from the module's own sentence. */
function recoverBlock(text) {
  const words = String(text || "");
  const at = words.indexOf("To get it back:");
  const command = at >= 0 ? words.slice(at + "To get it back:".length).trim() : words;
  const b = el("button", { className: "ts-act", type: "button", title: "Copy the command" });
  b.setAttribute("aria-label", "Copy the command");
  b.append(tsIcon("copy"));
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(command); b.classList.add("done"); setTimeout(() => b.classList.remove("done"), 1200); } catch (error) { notifyError(error); }
  };
  return el("div", { className: "wb-cmd" }, el("code", { textContent: command }), b);
}

/**
 * Discard: the one verb that throws work away. It shows everything that would
 * go, from the module's own plan, and stays disabled until the task's number
 * is typed exactly.
 */
function discardWorkbench(wbId, taskId, opts = {}) {
  return wbGuard(taskId, () => discardFlow(wbId, taskId, opts));
}

async function discardFlow(wbId, taskId, { after = null } = {}) {
  let plan;
  try { plan = await window.delphi.workbench.discardPlan(wbId); } catch (error) { notifyError(error); return; }
  // A folder git cannot read is left alone by Discard, which is right: there
  // is no way to keep a copy of what cannot be read. Said, with nothing to type.
  const blocked = plan.blocked || (plan.unreadable ? { message: plan.unreadable } : null);
  if (blocked) {
    await wbStop(`Task ${taskId}'s Workbench cannot be discarded now`, blocked.message,
      plan.nested && plan.nested.length ? plan.nested : []);
    return;
  }
  const count = (n, one, many) => el("div", { className: "grp-h" }, el("span", { className: "n", textContent: String(n) }), n === 1 ? one : many);
  const commitRow = (c) => [
    el("span", { className: "mono", style: "color:var(--ink-faint)", textContent: String(c.sha).slice(0, 7) }),
    el("span", { textContent: c.subject || "" }),
  ];
  const body = [];
  if (plan.folderGone) body.push(el("p", { className: "wb-lead", textContent: `The folder is already gone (${plan.path}). Discard closes the Workbench and keeps the branch's commits.` }));
  if (plan.operation) body.push(el("p", { className: "wb-lead", textContent: `The folder is in the middle of ${plan.operation}. Its state as it is now is what gets kept.` }));
  // What the copy cannot hold goes first: the one part of a Discard that
  // is not coming back.
  body.push(notKeptGroup(plan.notKept));
  const hidden = new Set(plan.hidden || []);
  if (plan.unsaved.length) body.push(el("div", { className: "grp" }, count(plan.unsaved.length, "unsaved change", "unsaved changes"),
    wbList(plan.unsaved, (f) => [el("span", { className: "mono", textContent: f }),
      hidden.has(f) ? el("span", { className: "hint", textContent: "hidden from git status" }) : null])));
  if (plan.commits.length) body.push(el("div", { className: "grp" }, count(plan.commits.length, "commit that exists only here", "commits that exist only here"),
    wbList(plan.commits, commitRow)));
  const detached = plan.detached || [];
  if (detached.length) body.push(el("div", { className: "grp" }, count(detached.length, "commit on no branch", "commits on no branch"),
    wbList(detached, commitRow)));
  const ignored = plan.ignored || [];
  if (ignored.length) body.push(el("div", { className: "grp" }, el("div", { className: "grp-h" }, "Files git does not keep"),
    wbList(ignored, (g) => [el("span", { className: "mono", textContent: g.dir }),
      el("span", { className: "hint", textContent: `${plural(g.count, "file", "files")}, ${sizeWords(g.bytes)}` })])));
  if (!plan.unsaved.length && !plan.commits.length && !detached.length && !ignored.length && !plan.folderGone) {
    body.push(el("p", { className: "wb-lead", textContent: "Nothing in it exists only here." }));
  }
  body.push(plan.branchPushed
    ? el("p", { className: "wb-lead" }, "The branch ", el("span", { className: "mono", textContent: plan.branch }),
        " is on the remote as ", el("span", { className: "mono", textContent: plan.remote }), ", so it is kept.")
    : el("p", { className: "wb-lead" }, "The branch ", el("span", { className: "mono", textContent: plan.branch }),
        " was never pushed, so it goes, with the rest kept in the copy."));
  if (plan.recover) {
    body.push(el("p", { className: "wb-lead" }, "Kept until ", el("strong", { textContent: plan.until }), "; to get it back:"), recoverBlock(plan.recover));
  }
  const want = String(taskId);
  const input = el("input", { className: "field", type: "text", autocomplete: "off", spellcheck: false });
  input.setAttribute("aria-label", `Type ${want} to confirm`);
  body.push(el("div", { className: "confirm" },
    el("label", {}, "Type ", el("strong", { textContent: want }), " to confirm"), input));
  let go = null;
  input.oninput = () => {
    const ok = input.value === want;
    go.disabled = !ok;
    input.classList.toggle("match", ok);
  };
  const choice = await wbDialog({
    title: `Discard the Workbench for task ${taskId}?`,
    lead: plan.notKept && plan.notKept.length
      ? "This deletes the folder. Everything in it except what is marked gone for good is copied aside first, so it can be got back for a while."
      : "This deletes the folder. Everything in it is copied aside first, so it can be got back for a while.",
    body,
    actions: [
      { label: "Cancel", value: null },
      { label: "Discard", value: "discard", kind: "danger", bind: (b) => { go = b; b.disabled = true; } },
    ],
  });
  if (choice !== "discard") return;
  try {
    const r = await window.delphi.workbench.discard(wbId, input.value, plan.confirm ? { confirm: plan.confirm } : {});
    // The Sheet has the same sentence, from the module's own note.
    notify(`Discarded.${keptWords(r)}${cleanupWords(r)}`);
    noticeKept(r);
  } catch (error) {
    if (error.code === "BUSY") { await showBusy(taskId, error); if (after) await after(); return; }
    // The folder changed since the plan was read, so what was agreed to is
    // not what is there. Said, then asked again from a fresh plan.
    notifyError(error);
    if (error.code === "IGNORED") return discardFlow(wbId, taskId, { after });
  }
  if (after) await after();
}

/**
 * A repository's Workbench settings: where a Workbench branches from, what
 * runs once its folder exists, and which untracked files are copied in.
 *
 * A null base branch or setup command means Delphi works it out at Start, and
 * the first Start writes the detected command back here. Each field says which
 * it is showing, so nobody edits a value thinking it was typed by a person.
 */
async function repoWorkbenchSettings(repo) {
  let refused = null;
  let values = { base: repo.base_branch || "", setup: repo.setup_cmd == null ? "" : repo.setup_cmd, copy: repo.copy_files == null ? "" : repo.copy_files };
  for (;;) {
    const field = (id, value, placeholder) => el("input", { className: "field mono-in", id, value, placeholder, spellcheck: false, autocomplete: "off" });
    const base = field("wb-base", values.base, "origin's default branch, then main");
    const setup = field("wb-setup", values.setup, repo.setup_cmd == null ? "worked out at the first Start" : "nothing runs");
    const copy = field("wb-copy", values.copy, ".env,.env.local");
    const tag = (text) => el("span", { className: "wb-tag", textContent: text });
    const row = (input, label, state, hint) => el("div", { className: "wb-field" },
      el("label", { htmlFor: input.id }, label, state ? tag(state) : null), input, el("div", { className: "hint", textContent: hint }));
    const choice = await wbDialog({
      title: `Workbench settings for ${repo.name}`,
      lead: repo.path,
      className: "wb-settings",
      body: [
        row(base, "Base branch", repo.base_branch ? null : "detected",
          "Where every Workbench branch starts from, and what Update brings in. Empty means detect: origin's default branch, then main, then master."),
        row(setup, "Setup command", repo.setup_cmd == null ? "detected at Start" : Number(repo.setup_cmd_detected) === 1 ? "detected" : null,
          repo.setup_cmd == null
            ? "Runs in a new Workbench once its folder exists. Delphi looks at the lockfiles at the first Start and writes what it finds here."
            : Number(repo.setup_cmd_detected) === 1
              ? "Runs in a new Workbench once its folder exists. This is what Delphi found; edit it and it is yours. Empty runs nothing."
              : "Runs in a new Workbench once its folder exists, as last set. Empty runs nothing."),
        row(copy, "Files to copy", repo.copy_files == null ? "default" : null,
          "Untracked files copied from the main checkout into each new Workbench, comma separated. Never overwrites, and only files inside the repository."),
        refused ? el("div", { className: "err-msg", role: "alert", textContent: refused }) : null,
      ],
      actions: [{ label: "Cancel", value: null }, { label: "Save", value: "save", kind: "primary" }],
    });
    if (choice !== "save") return false;
    values = { base: base.value.trim(), setup: setup.value.trim(), copy: copy.value.trim() };
    const fields = { base_branch: values.base || null, copy_files: values.copy || null };
    // An empty setup field means "run nothing" once something was detected or
    // typed, and leaves "detect at Start" alone when nothing ever was.
    if (!(repo.setup_cmd == null && !values.setup)) fields.setup_cmd = values.setup;
    try {
      await window.delphi.repos.update(repo.id, fields);
      notify(`Workbench settings saved for ${repo.name}.`);
      return true;
    } catch (error) {
      // Asked again with what was typed, and the refusal inside the dialog,
      // so a refused branch name is a fix rather than starting over.
      refused = String(error.message || error);
    }
  }
}

/** Which repository a Start should use, when the project has more than one. */
function pickRepo(list) {
  let chosen = list.find((c) => c.is_primary) || list[0];
  const choices = el("div", { className: "destroy-choices" });
  list.forEach((c, i) => {
    const id = `wb-repo-${i}`;
    const radio = el("input", { type: "radio", name: "wb-repo", id, checked: c === chosen });
    radio.onchange = () => { if (radio.checked) chosen = c; };
    choices.append(el("label", { className: "destroy-choice", htmlFor: id }, radio,
      el("span", {},
        el("span", { className: "destroy-choice-label" }, c.name, c.is_primary ? el("span", { className: "pill muted", textContent: "primary", style: "margin-left:6px" }) : null),
        el("span", { className: "mono", textContent: c.path }))));
  });
  return wbDialog({
    title: "Which repository?",
    lead: "This project has several. The Workbench gets its own folder and branch in the one you pick.",
    body: [choices],
    actions: [{ label: "Cancel", value: false }, { label: "Start working", value: true, kind: "primary" }],
    cancelValue: false,
  }).then((ok) => (ok ? chosen : null));
}

// Subscribed once, here, because preload has no way to unsubscribe. Starting
// is remembered per task; an open task panel is told so it can redraw.
window.delphi.onWorkbenchEvent((e) => {
  if (e.phase === "ready" || e.phase === "failed") wbStarting.delete(e.taskId);
  else wbStarting.set(e.taskId, e);
  if (e.phase === "failed") notifyError(e.text);
  if (openSheet && openSheet.taskId === e.taskId && openSheet.wbEvent) openSheet.wbEvent(e);
});

// Done prompts Finish. Not now changes nothing: the task stays done and the
// Workbench stays as it is.
// One at a time: marking several tasks done at once sends one prompt each,
// and stacked they would all be answered by the first keypress. Each waits
// for the one before it, and is skipped if its Workbench went meanwhile.
let promptQueue = Promise.resolve();
window.delphi.onWorkbenchPrompt((p) => {
  promptQueue = promptQueue.then(() => donePrompt(p)).catch((error) => notifyError(error));
});

async function donePrompt(p) {
  const still = await window.delphi.workbench.forTask(p.taskId).catch(() => null);
  if (!still || still.id !== p.workbenchId) return;
  const go = await wbDialog({
    title: "Finish the Workbench too?",
    lead: `Task ${p.taskId} is done, and its Workbench is still open.`,
    body: [el("div", { className: "grp" },
      el("div", { className: "wb-row-title", textContent: p.taskTitle }),
      el("div", { className: "mono", textContent: p.branch }),
      el("div", { className: "mono", style: "color:var(--ink-faint)", textContent: p.path }))],
    actions: [{ label: "Not now", value: null }, { label: "Finish", value: "finish", kind: "primary" }],
  });
  if (go !== "finish") return;
  await finishWorkbench(p.workbenchId, p.taskId, {
    title: p.taskTitle,
    after: async () => { if (openSheet && openSheet.live) await openSheet.live(); refresh(); },
  });
}

// ---------------------------------------------------------------------------
// Composer runs: live output
//
// Output arrives in pieces as it is written, for as long as the command runs,
// and a build can write tens of megabytes. Nothing here holds more than the
// last RUN_KEEP lines, and the DOM is written at most once a frame, so a
// runaway command cannot take the window down with it. The whole log is on
// disk regardless; this is only the view of its end.
// ---------------------------------------------------------------------------

const RUN_KEEP = 2000;
const RUN_PENDING_CAP = 4 * 1024 * 1024;
const RUN_PARTIAL_CAP = 64 * 1024;
const runBuffers = new Map();   // entryId -> buffer, for runs started in this window
const runKills = new Map();     // entryId -> presses of Stop so far
// Runs that ended, since a quick one can finish before sheets.run has even
// answered, and a buffer made after that would wait for an end already past.
const runsEnded = new Set();

function runBuffer(entryId, taskId) {
  let b = runBuffers.get(entryId);
  if (!b) {
    b = { entryId, taskId, lines: [], partial: "", dropped: 0, pending: [], size: 0, frame: 0, pre: null, follow: true, scroll: 0 };
    runBuffers.set(entryId, b);
  }
  return b;
}

// A carriage return redraws the line in a terminal, which is how progress
// bars work. Keeping only what follows the last one shows what a terminal
// would be showing, rather than every frame of the bar.
const runLine = (raw) => {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  const at = line.lastIndexOf("\r");
  return stripAnsi(at >= 0 ? line.slice(at + 1) : line);
};

function runTake(b) {
  if (!b.pending.length) return;
  let text = b.partial + b.pending.join("");
  b.pending = [];
  b.size = 0;
  // More arrived in one frame than will ever be shown. Everything before the
  // last stretch is counted and dropped without being split into lines.
  if (text.length > RUN_PENDING_CAP) {
    const cut = text.indexOf("\n", text.length - RUN_PENDING_CAP);
    const from = cut >= 0 ? cut + 1 : text.length - RUN_PENDING_CAP;
    for (let i = text.indexOf("\n"); i >= 0 && i < from; i = text.indexOf("\n", i + 1)) b.dropped += 1;
    b.dropped += b.lines.length;
    b.lines = [];
    text = text.slice(from);
  }
  const parts = text.split("\n");
  b.partial = parts.pop();
  if (b.partial.length > RUN_PARTIAL_CAP) b.partial = b.partial.slice(-RUN_PARTIAL_CAP);
  for (const p of parts) b.lines.push(runLine(p));
  if (b.lines.length > RUN_KEEP) {
    const over = b.lines.length - RUN_KEEP;
    b.lines.splice(0, over);
    b.dropped += over;
  }
}

function runPaint(b) {
  const pre = b.pre;
  if (!pre || !pre.isConnected) return;
  pre.textContent = "";
  if (b.truncated) {
    pre.append(el("span", { className: "cut", textContent: "Showing the last part. The full log opens when it finishes.\n" }));
  } else if (b.dropped) {
    pre.append(el("span", { className: "cut", textContent: `Showing the last ${plural(b.lines.length, "line", "lines")}. The whole log is kept.\n` }));
  }
  const tail = b.partial ? runLine(b.partial) : "";
  const text = b.lines.join("\n") + (tail ? (b.lines.length ? "\n" : "") + tail : "");
  if (text) pre.append(document.createTextNode(text));
  else pre.append(el("span", { className: "cut", textContent: "Waiting for output" }));
  if (b.follow) pre.scrollTop = pre.scrollHeight;
  else pre.scrollTop = b.scroll;
}

function runFlush(b) {
  b.frame = 0;
  runTake(b);
  runPaint(b);
}

/** The persistent output node for a live run, so a row rebuilt by the clock keeps it, scroll and all. */
function runPre(b) {
  if (!b.pre) {
    const pre = el("pre", { className: "ts-run-out full live" });
    pre.setAttribute("tabindex", "0");
    pre.setAttribute("aria-label", "Command output, live");
    pre.addEventListener("scroll", () => {
      b.follow = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
      b.scroll = pre.scrollTop;
    });
    b.pre = pre;
  }
  requestAnimationFrame(() => runPaint(b));
  return b.pre;
}

window.delphi.onSheetRunOutput(({ entryId, taskId, chunk, chunks, truncated }) => {
  const b = runBuffer(entryId, taskId);
  // The main process may batch pieces, and may skip some when they come too
  // fast; skipped output is in the log, which is read in full once it ends.
  chunk = Array.isArray(chunks) ? chunks.join("") : String(chunk || "");
  if (truncated) {
    // The batch was cut at its front, so it starts part way through a line,
    // and the line held over from before it never got its end. Both go.
    b.truncated = true;
    runTake(b);
    b.partial = "";
    const nl = chunk.indexOf("\n");
    chunk = nl >= 0 ? chunk.slice(nl + 1) : "";
    if (!chunk) return;
  }
  b.pending.push(chunk);
  b.size += chunk.length;
  // Folded in early when a single frame's worth is already more than will be
  // kept, so the pending list itself cannot grow without bound.
  if (b.size > RUN_PENDING_CAP * 2) runTake(b);
  if (!b.frame) b.frame = requestAnimationFrame(() => runFlush(b));
});

window.delphi.onSheetRunDone(({ entryId, taskId, entry }) => {
  const b = runBuffers.get(entryId);
  if (b) {
    if (b.frame) cancelAnimationFrame(b.frame);
    runFlush(b);
  }
  if (openSheet && openSheet.taskId === taskId && openSheet.runDone) openSheet.runDone(entryId, b, entry);
  runBuffers.delete(entryId);
  runKills.delete(entryId);
  runsEnded.add(entryId);
  if (runsEnded.size > 200) runsEnded.delete(runsEnded.values().next().value);
});

/**
 * Opens one task as a workspace.
 *
 * The first version of this was a form: labelled fields stacked in a column with
 * a segmented status control at the top. It worked and it was dull, and dull is
 * the wrong answer for the screen someone spends the most time in.
 *
 * This is laid out the way the tools people already use lay it out. The metadata
 * is a row of chips you click to edit rather than a grid of form controls, so the
 * task reads as a sentence and not as a settings page. Detail and history are
 * tabs rather than a scroll. The discussion sits beside the work instead of
 * underneath it, with the composer pinned where your hands already are.
 */
/** Deletes a task, and the drafts its boxes were keeping: there is nothing left to type them into. */
async function removeTask(id) {
  const done = await window.delphi.tasks.remove(id);
  if (window.DelphiRecovery) DelphiRecovery.clearTaskDrafts(id);
  return done;
}

async function openTaskSheet(taskId) {
  if (window.DelphiDrawer && !openTaskSheet.full && (state.settings || {}).taskOpenMode !== "centered") return DelphiDrawer.open(taskId);
  if (openSheet) await openSheet.close();

  let detail = await window.delphi.tasks.detail(taskId);
  if (!detail) return;
  // What this task's boxes keep their drafts under: its id and when it was
  // made, never the id alone (see ui/recovery.js).
  const draftOf = window.DelphiRecovery ? DelphiRecovery.taskDraftId(detail.task) || taskId : taskId;

  let pane = "details";   // details | activity
  let editingDesc = false;

  const overlay = el("div", { className: "overlay" });
  const sheet = el("div", { className: "sheet task-sheet", role: "dialog" });
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "Task");

  const top = el("div", { className: "ts-top" });
  const body = el("div", { className: "ts-body" });
  const main = el("div", { className: "ts-main" });
  const rail = el("div", { className: "ts-rail" });
  body.append(main, rail);
  sheet.append(top, body);

  const flashHost = el("span", { className: "hint" });
  // Where the Workbench controls go, between the flash and Copy brief. One
  // node kept across paintTop, so whatever paints it owns its own redraws and
  // a menu open on it survives a live refresh of the header.
  const wbSlot = el("div", { className: "wb" });
  // This task's newest run, live: its state, and the way to Runs. Kept across
  // paintTop for the same reason wbSlot is.
  const runSlot = el("div", { className: "run-slot" });
  const flash = (text) => {
    flashHost.textContent = text;
    setTimeout(() => { if (flashHost.textContent === text) flashHost.textContent = ""; }, 1500);
  };

  const reload = async () => {
    detail = await window.delphi.tasks.detail(taskId);
    if (!detail) return;
    paintAll();
  };

  const write = async (fields, note) => {
    await window.delphi.tasks.update(taskId, fields);
    flash(note);
    await reload();
    refresh();
  };

  // A reminder write repaints the sheet from the shared load rather than from a
  // second query, so the tab badge behind the sheet cannot disagree with it.
  const remindersChanged = async () => { await refresh(); paintAll(); };
  const openReminders = async () => {
    await closeSheet();
    goTo({ projectId: null, view: "reminders", query: "" });
  };

  // --- header ---------------------------------------------------------------

  function paintTop() {
    top.textContent = "";
    const crumbs = el("div", { className: "ts-crumbs" });
    if (detail.project) {
      const p = el("button", { className: "crumb", textContent: detail.project.name });
      p.onclick = async () => { await closeSheet(); goTo({ projectId: detail.project.id, view: "tasks", query: "" }); };
      crumbs.append(p, el("span", { className: "crumb-sep", textContent: "/" }));
    }
    if (detail.parent) {
      const up = el("button", { className: "crumb", textContent: detail.parent.title });
      up.onclick = () => openTaskSheet(detail.parent.id);
      crumbs.append(up, el("span", { className: "crumb-sep", textContent: "/" }));
      crumbs.append(el("span", { className: "crumb-now", textContent: "subtask" }));
    } else {
      crumbs.append(el("span", { className: "crumb-now", textContent: `task ${detail.task.id}` }));
    }
    top.append(crumbs, el("span", { className: "spacer" }), flashHost, runSlot, wbSlot, el("span", { className: "wb-sep" }));
    paintRun();

    const toAgent = el("button", { className: "btn sm", type: "button", textContent: "Hand to agent" });
    toAgent.title = "Ask an agent about this task, or have it do the work in the task's own Workbench";
    toAgent.onclick = async () => {
      const run = await handToAgent(detail);
      if (!run) return;
      flash(`handed to ${run.harness_label}`);
      // The list is asked for now rather than on the next runs-changed, so
      // the chip is there the moment the dialog closes.
      try { state.runs = await window.delphi.runs.list({ limit: 300 }); } catch {}
      paintRunsLive();
    };

    const hand = el("button", { className: "btn sm", textContent: "Copy brief" });
    hand.title = "Copies this task, its discussion and its history as a brief an agent can act on";
    hand.onclick = async () => {
      try {
        await navigator.clipboard.writeText(handoffText(detail));
        hand.textContent = "Copied";
      } catch { hand.textContent = "Could not copy"; }
      setTimeout(() => (hand.textContent = "Copy brief"), 1400);
    };

    const del = el("button", { className: "icon-btn", title: "Delete this task" });
    del.setAttribute("aria-label", "Delete task");
    del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>';
    del.onclick = async () => {
      await removeTask(taskId);
      await closeSheet();
      // Said at the moment it happens, because that is when someone needs to
      // know it can be taken back.
      refresh();
      setTimeout(() => alert("Task deleted. It can be restored from the project's History tab."), 30);
    };

    const close = el("button", { className: "icon-btn", title: "Close (Escape)" });
    close.setAttribute("aria-label", "Close");
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    close.onclick = () => closeSheet();

    // Where it lives, when the panel was opened from a project that only
    // shows it, and the Item menu: Move, Copy, Also belongs to and Flag.
    const taskItem = itemOf("task", {
      ...detail.task,
      project_name: detail.project ? detail.project.name : null,
      project_colour: detail.project ? detail.project.colour : null,
      associated: state.projectId && detail.task.project_id !== state.projectId && !detail.parent ? 1 : 0,
    });
    if (taskItem.associated) crumbs.append(fromChip(taskItem));
    const more = itemMoreButton(taskItem, { after: reload, onDelete: () => closeSheet() });
    top.append(toAgent, hand, more, del, close);
  }

  /**
   * The chip for this task's newest run: open ones always, finished ones on
   * the day they finished. A failure that names a setting gets the button to
   * it, the same as in Runs.
   */
  function paintRun() {
    runSlot.textContent = "";
    const run = state.runs.find((r) => r.task_id === taskId);
    if (!run) return;
    const open = RUN_OPEN.includes(run.state);
    if (!open && !isToday(run.finished_at || run.updated_at)) return;
    const chip = runStateChip(run, "button");
    chip.type = "button";
    chip.textContent = `${run.harness_label || run.harness} ${RUN_STATE_WORDS[run.state] || run.state}`;
    chip.title = [run.reply, run.request].filter(Boolean).join("\n\n");
    const toRuns = async () => {
      await closeSheet();
      goTo({ projectId: null, view: RUN_WAITING.includes(run.state) ? "inbox" : "runs", query: "" });
    };
    chip.onclick = toRuns;
    runSlot.append(chip);
    if (run.state === "failed") {
      const fix = settingFix(run.reply, run.project_id);
      if (fix) {
        const b = el("button", { className: "ts-linkbtn", type: "button", textContent: fix.label });
        b.onclick = fix.go;
        runSlot.append(b);
      }
    }
    const sheetLink = el("button", { className: "ts-linkbtn", type: "button", textContent: "Sheet", title: "The newest entries on this task's Sheet, where the run writes" });
    sheetLink.onclick = () => { railList.scrollTop = railList.scrollHeight; };
    const runsLink = el("button", { className: "ts-linkbtn", type: "button", textContent: "Runs" });
    runsLink.onclick = toRuns;
    runSlot.append(sheetLink, runsLink);
  }

  // --- workbench ------------------------------------------------------------

  // The advanced disclosure, when More has asked for it: { id, data }.
  let wbAdv = null;
  const advHost = el("div");
  // Whether a verb is running on this task's Workbench, here or from a
  // done prompt: the one flag every entry point checks (see wbGuard).
  const busyNow = () => wbBusyTasks.has(taskId);
  // The advanced section as the person left it: collapsed stays collapsed.
  let wbAdvOpen = true;

  const wbAfter = async () => { await reload(); refresh(); };

  /** Runs one Workbench verb with the cluster disabled, and says what went wrong in the module's words. */
  async function wbDo(fn) {
    const ran = await wbGuard(taskId, async () => {
      try { await fn(); } catch (error) { notifyError(error); }
      return true;
    });
    if (ran) await wbAfter();
  }

  function wbStart() {
    // Guarded from the first click, before the candidates are even asked
    // for, so a double click cannot open two pickers or start twice.
    return wbGuard(taskId, wbStartNow);
  }

  async function wbStartNow() {
    let opts = {};
    try {
      const list = await window.delphi.workbench.candidates(taskId);
      if (list.length > 1) {
        const pick = await pickRepo(list);
        if (!pick) return;
        opts = pick.repo_id != null ? { repoId: pick.repo_id } : { path: pick.path };
      }
    } catch (error) { notifyError(error); return; }
    // Set before the call, because the module's own phases arrive while it is
    // still running, and a Start with no setup is over before it returns.
    wbStarting.set(taskId, { phase: "starting", text: "Starting" });
    paintWorkbench();
    try {
      const made = await window.delphi.workbench.start(taskId, opts);
      if (made.warnings && made.warnings.length) notify(made.warnings.join(" "));
    } catch (error) {
      wbStarting.delete(taskId);
      notifyError(error);
    }
    await wbAfter();
  }

  /**
   * A menu under a button, right edges aligned, the way the mockup hangs
   * them. Keyboard handling is openFileMenu's: focus moves in, the arrows
   * move through it, Escape closes only the menu and hands focus back to its
   * button, and Tab leaves.
   */
  function wbMenu(button, items, fromKeyboard = false) {
    const box = button.getBoundingClientRect();
    button.setAttribute("aria-expanded", "true");
    const menu = rowMenu(box.left, box.bottom + 4, items, {
      className: "wb-menu",
      // Focus goes back to the button the menu hangs from, so a dialog an
      // item opens has somewhere to return focus to when it closes.
      onClose: () => {
        button.setAttribute("aria-expanded", "false");
        if (button.isConnected && (!document.activeElement || document.activeElement === document.body)) button.focus({ preventScroll: true });
      },
    });
    menu.setAttribute("role", "menu");
    menu.style.left = `${Math.max(8, box.right - menu.offsetWidth)}px`;
    const choices = [...menu.querySelectorAll(".ctx-item")];
    for (const c of choices) c.setAttribute("role", "menuitem");
    menu.addEventListener("keydown", (e) => {
      const at = choices.indexOf(document.activeElement);
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); closeRowMenu(); button.focus(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); choices[(at + 1) % choices.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); choices[(at - 1 + choices.length) % choices.length].focus(); }
      else if (e.key === "Tab") closeRowMenu();
    });
    if (fromKeyboard) choices[0]?.focus();
    else { menu.tabIndex = -1; menu.focus(); }
    return menu;
  }

  function wbMenuItem(label, hint, run, danger = false) {
    const b = el("button", { className: "ctx-item" + (danger ? " danger" : ""), type: "button" },
      el("span", { textContent: label }), hint ? el("span", { className: "hint", textContent: hint }) : null);
    b.onclick = async () => { closeRowMenu(); await run(); };
    return b;
  }

  async function wbOpen(wb, target) {
    try {
      const r = await window.delphi.workbench.open(wb.id, target);
      flash(`opened in ${r.via === "folder" ? "the file browser" : r.via}`);
    } catch (error) { notifyError(error); }
  }

  async function wbShowAdvanced(wb) {
    try {
      wbAdv = { id: wb.id, data: await window.delphi.workbench.advanced(wb.id) };
      wbAdvOpen = true;
    } catch (error) { notifyError(error); return; }
    paintAdvanced();
    advHost.scrollIntoView({ block: "nearest", behavior: motionOff() ? "auto" : "smooth" });
  }

  // What the cluster was last drawn from. A refresh that changes none of it
  // leaves the buttons alone, so focus and an open menu stay where they are.
  let wbSig = null;
  function paintWorkbench() {
    const wb0 = detail.workbench;
    const st0 = (wb0 && wb0.status) || {};
    const sig = JSON.stringify([wb0 && { ...wb0, status: { ...st0, checkedAt: null } }, wbStarting.get(taskId) || null,
      busyNow(), detail.project ? detail.project.id : null, detail.task.status]);
    if (sig === wbSig) {
      const chip = wbSlot.querySelector(".wb-chip");
      if (chip && chip.wbTitle) chip.wbTitle(st0);
      return;
    }
    wbSig = sig;
    const hadFocus = wbSlot.contains(document.activeElement) ? document.activeElement.dataset.act : null;
    buildWorkbench();
    if (hadFocus) {
      const again = wbSlot.querySelector(`[data-act="${hadFocus}"]`);
      if (again && !again.disabled) again.focus({ preventScroll: true });
    }
  }

  function buildWorkbench() {
    wbSlot.textContent = "";
    // Busy is aria-disabled rather than disabled: a disabled button drops
    // focus to the page, and the verb that made it busy is about to open a
    // dialog that hands focus back here. A second press is a no-op anyway,
    // since every verb goes through wbGuard.
    wbSlot.classList.toggle("busy", busyNow());
    wbSlot.setAttribute("aria-busy", String(busyNow()));
    const wb = detail.workbench;
    const starting = wbStarting.get(taskId);
    const btn = (label, cls, run, title) => {
      const b = el("button", { className: `btn sm ${cls}`.trim(), textContent: label, type: "button" });
      b.dataset.act = label;
      if (busyNow()) b.setAttribute("aria-disabled", "true");
      if (title) b.title = title;
      b.onclick = run;
      return b;
    };

    if (starting) {
      // The module says "Running npm ci"; the chip says which kind of running.
      const text = starting.phase === "setup" && /^Running /.test(starting.text || "")
        ? `Running setup: ${starting.text.slice(8)}` : starting.text || "Starting";
      wbSlot.append(el("span", { className: "wb-chip starting", role: "status" }, el("span", { className: "spinner" }), text),
        btn("Start working", "", null));
      wbSlot.lastChild.disabled = true;
      return;
    }
    if (!wb) {
      // A task outside every project has nowhere to start one, so it gets no button.
      if (detail.project && detail.task.status !== "done") {
        wbSlot.append(btn("Start working", "primary", wbStart,
          "A folder and a branch of its own for this task, so it never shares a checkout"));
      }
      return;
    }

    const look = wbLook(wb);
    const chip = wbChip(wb, () => wbDo(() => wbUpdate(wb)));
    if (busyNow()) chip.querySelector(".wb-act")?.setAttribute("aria-disabled", "true");
    wbSlot.append(chip);

    if (look.cls === "closing") {
      if (closingLong(look.closing)) wbSlot.append(el("span", { className: "hint", textContent: "The Sheet says where the folder is" }));
      return;
    }
    if (look.unreadable) {
      // No Recreate, Finish or Discard: the folder is there and may be full
      // of work. Opening it is the one useful thing, and the banner says why.
      wbSlot.append(btn("Open folder", "", () => wbOpen(wb, "folder")));
      return;
    }
    if (look.cls === "missing") {
      wbSlot.append(
        btn("Recreate", "primary", () => wbDo(async () => {
          await window.delphi.workbench.recreate(wb.id);
          flash("folder recreated");
        }), `Puts the folder back at ${wb.path}, on ${wb.branch}`),
        btn("Forget", "", async () => {
          const go = await wbDialog({
            title: "Forget this Workbench?",
            lead: `The folder is already gone. The branch ${wb.branch} is left exactly as it is.`,
            actions: [{ label: "Cancel", value: null }, { label: "Forget", value: "forget", kind: "primary" }],
          });
          if (go) wbDo(() => window.delphi.workbench.forget(wb.id));
        }));
      return;
    }

    const parked = wb.state === "parked";
    const tone = parked ? "" : "primary";
    const open = btn("Open", tone, () => wbOpen(wb, "editor"), "Open in your editor");
    const caret = el("button", { className: `btn sm ${tone}`.trim(), type: "button", title: "Editor, Terminal or Folder" });
    caret.dataset.act = "open-in";
    if (busyNow()) caret.setAttribute("aria-disabled", "true");
    caret.setAttribute("aria-haspopup", "menu");
    caret.setAttribute("aria-expanded", "false");
    caret.setAttribute("aria-label", "Open in");
    caret.append(tsIcon("caret", 2.6));
    const mac = document.body.classList.contains("mac");
    caret.onclick = (e) => {
      e.stopPropagation();
      wbMenu(caret, [
        wbMenuItem("Editor", "code", () => wbOpen(wb, "editor")),
        wbMenuItem("Terminal", "Terminal", () => wbOpen(wb, "terminal")),
        wbMenuItem("Folder", mac ? "Finder" : "files", () => wbOpen(wb, "folder")),
      ], e.detail === 0);
    };
    const split = el("span", { className: "wb-split" }, open, caret);

    if (parked) {
      wbSlot.append(btn("Resume", "primary", () => wbDo(async () => {
        await window.delphi.workbench.resume(wb.id);
        flash("resumed");
      })), split);
    } else {
      wbSlot.append(split, btn("Finish", "", () => finishWorkbench(wb.id, taskId, { title: detail.task.title, after: reload }),
        "Save, share and put the folder away. The branch is kept."));
    }

    const more = el("button", { className: "icon-btn", type: "button", title: "More" });
    more.dataset.act = "more";
    if (busyNow()) more.setAttribute("aria-disabled", "true");
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-label", "More Workbench actions");
    more.append(tsIcon("dots", 2.4));
    more.onclick = (e) => {
      e.stopPropagation();
      const showing = wbAdv && wbAdv.id === wb.id;
      wbMenu(more, [
        parked
          ? wbMenuItem("Resume", null, () => wbDo(() => window.delphi.workbench.resume(wb.id)))
          : wbMenuItem("Park", null, () => wbDo(async () => {
              await window.delphi.workbench.park(wb.id);
              flash("parked");
            })),
        wbMenuItem(`Update from ${wb.base}`, null, () => wbDo(() => wbUpdate(wb))),
        wbMenuItem(showing ? "Hide advanced" : "Show advanced", null, () => {
          if (showing) { wbAdv = null; paintAdvanced(); } else wbShowAdvanced(wb);
        }),
        "-",
        wbMenuItem("Discard...", null, () => discardWorkbench(wb.id, taskId, { after: wbAfter }), true),
      ], e.detail === 0);
    };
    wbSlot.append(more);
  }

  /**
   * What a Workbench is underneath, for the person learning it: the real
   * branch and folder, and the git commands each button stands for. Only from
   * More, never in the way.
   */
  let advSig = null;
  function paintAdvanced() {
    const wb = detail.workbench;
    // Redrawn only when what it shows changes, so a refresh keeps focus on a
    // copy button and never reopens a section the person collapsed.
    const st1 = (wb && wb.status) || {};
    const sig = JSON.stringify([wbAdv, wb ? wb.id : null, st1.state, st1.message, st1.words, st1.operation, wb ? wb.closing : null]);
    if (sig === advSig) return;
    advSig = sig;
    advHost.textContent = "";
    // The module's explanation, where it can be read, when the folder is
    // unreadable or stopped in the middle of something.
    const st = (wb && wb.status) || {};
    if (st.state === "unreadable" && st.message) {
      advHost.append(el("div", { className: "wb-banner err", role: "status", textContent: st.message }));
    } else if (wb && (wb.state === "closing" || st.state === "closing")) {
      // Shown without asking, since More is not offered while it lasts.
      const c = wb.closing || st.closing || {};
      const grid = el("div", { className: "wb-adv-grid" });
      for (const [k, v] of [["Doing", c.mode === "discard" ? "Discard" : c.mode === "finish" ? "Finish" : ""],
        ["Begun by", c.actor || ""], ["At", c.at ? `${c.at} UTC` : ""], ["Folder now at", c.trash || ""], ["Copy", c.ref || ""]]) {
        if (v) grid.append(el("span", { className: "k", textContent: k }), el("span", { className: "v", textContent: v }), el("span"));
      }
      advHost.append(el("div", { className: "wb-adv wb-closing" },
        el("div", { className: "wb-adv-body", style: "padding-top:var(--s3)" },
          el("p", { className: "wb-lead", textContent: closingLong(c)
            ? "Being put away for a while now, so it was probably interrupted. Housekeeping finishes or undoes it; the Sheet says where the folder is."
            : "Being put away. Nothing can be done to it until that ends." }),
          grid)));
    } else if (st.state === "busy" && st.operation) {
      advHost.append(el("div", { className: "wb-banner", role: "status",
        textContent: `${st.words}. Finish and Update wait until it is finished or stopped in the folder.` }));
    }
    if (!wbAdv || !wb || wb.id !== wbAdv.id) { wbAdv = null; return; }
    const a = wbAdv.data;
    const copyBtn = (text, label) => {
      const b = el("button", { className: "ts-act", title: label, type: "button" });
      b.setAttribute("aria-label", label);
      b.append(tsIcon("copy"));
      b.onclick = async () => {
        try { await navigator.clipboard.writeText(text); railCopied(b, "Copied"); } catch (error) { notifyError(error); }
      };
      return b;
    };
    const adv = el("details", { className: "wb-adv", open: wbAdvOpen });
    adv.addEventListener("toggle", () => { wbAdvOpen = adv.open; });
    const tw = el("span", { className: "tw", textContent: "▶" });
    tw.setAttribute("aria-hidden", "true");
    adv.append(el("summary", {}, tw, "Workbench, advanced", el("span", { className: "grow" }),
      el("span", { className: "wb-adv-why", textContent: "What Delphi did, in git's words" })));
    const grid = el("div", { className: "wb-adv-grid" });
    for (const [k, v] of [["Branch", a.branch], ["Folder", a.path], ["Based on", a.base], ["Repository", a.repo]]) {
      grid.append(el("span", { className: "k", textContent: k }), el("span", { className: "v", textContent: v || "" }),
        copyBtn(v || "", `Copy ${k.toLowerCase()}`));
    }
    const body = el("div", { className: "wb-adv-body" }, grid, el("h5", { textContent: "The git commands behind each button" }));
    const why = (cmd) => (/^cd /.test(cmd) ? "go to the folder"
      : / status$/.test(cmd) ? "the status words"
      : / push /.test(cmd) ? "Push, before Finish"
      : / worktree list$/.test(cmd) ? "every Workbench here"
      : / worktree remove /.test(cmd) ? "Finish" : "");
    for (const cmd of a.commands || []) {
      body.append(el("div", { className: "wb-cmd" }, el("code", { textContent: cmd }),
        el("span", { className: "why", textContent: why(cmd) }), copyBtn(cmd, "Copy command")));
    }
    if (a.unmanaged && a.unmanaged.length) {
      body.append(el("h5", { textContent: "Folders found here that Delphi does not manage" }));
      for (const u of a.unmanaged) {
        body.append(el("div", { className: "wb-cmd" }, el("code", { textContent: u.path }),
          el("span", { className: "why", textContent: u.branch || "" })));
      }
    }
    adv.append(body);
    advHost.append(adv);
  }

  // --- title ----------------------------------------------------------------

  // A textarea rather than an input, because a task title is often a sentence and
  // an input silently clips it to whatever fits.
  const title = el("textarea", { className: "ts-title", value: detail.task.title, rows: 1 });
  title.setAttribute("aria-label", "Task title");
  // The title is never empty, so a kept edit comes back only when it differs.
  if (window.DelphiRecovery) {
    const kept = DelphiRecovery.draft("title", draftOf);
    if (kept && kept !== detail.task.title) title.value = kept;
    title.addEventListener("input", () => DelphiRecovery.saveDraft("title", draftOf, title.value === detail.task.title ? "" : title.value));
  }
  const growTitle = () => {
    title.style.height = "auto";
    title.style.height = `${title.scrollHeight}px`;
  };
  title.oninput = growTitle;
  // Enter commits rather than adding a line: a title is one line of meaning even
  // when it wraps across two.
  title.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); title.blur(); } };

  const ring = el("button", { className: "ts-ring" });
  ring.setAttribute("aria-label", "Toggle done");
  ring.onclick = () => write({ status: detail.task.status === "done" ? "todo" : "done" },
                             detail.task.status === "done" ? "reopened" : "marked done");

  const titleRow = el("div", { className: "ts-title-row" }, ring, title);

  function paintRing() {
    ring.className = "ts-ring" + (detail.task.status === "done" ? " on" : "");
    ring.textContent = detail.task.status === "done" ? "✓" : "";
  }

  // --- metadata chips -------------------------------------------------------

  const meta = el("div", { className: "ts-meta" });

  /**
   * A chip that becomes its own editor when clicked.
   *
   * Chips rather than form fields because a task should read as a line of facts.
   * The control only appears when someone wants to change something, which is
   * rarely, and disappears again straight after.
   */
  function chip({ icon, value, empty, tone = "", build }) {
    const wrap = el("span", { className: `ts-chip ${tone}`.trim(), tabIndex: 0, role: "button" });
    wrap.append(el("span", { className: "ts-chip-icon", textContent: icon }));
    wrap.append(el("span", { className: value ? "" : "ts-chip-empty", textContent: value || empty }));
    const open = () => {
      const editor = build(() => paintMeta());
      wrap.replaceWith(editor);
      if (editor.focus) editor.focus();
    };
    wrap.onclick = open;
    wrap.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    return wrap;
  }

  const STATUS_LABEL = { todo: "To do", doing: "In progress", blocked: "Blocked", done: "Done" };

  function paintMeta() {
    meta.textContent = "";
    const t = detail.task;

    meta.append(chip({
      icon: "◍", value: STATUS_LABEL[statusOf(t)], tone: `tone-${statusOf(t)}`,
      build: (done) => {
        const s = el("select", { className: "ts-inline" });
        for (const [v, label] of Object.entries(STATUS_LABEL)) {
          s.append(el("option", { value: v, textContent: label, selected: statusOf(t) === v }));
        }
        s.onchange = () => write({ status: s.value }, "status saved").then(done);
        s.onblur = done;
        return s;
      },
    }));

    meta.append(chip({
      icon: "⚑", value: t.priority, tone: t.priority === "high" ? "tone-high" : "",
      build: (done) => {
        const s = el("select", { className: "ts-inline" });
        for (const v of ["high", "med", "low"]) s.append(el("option", { value: v, textContent: v, selected: t.priority === v }));
        s.onchange = () => write({ priority: s.value }, "priority saved").then(done);
        s.onblur = done;
        return s;
      },
    }));

    meta.append(chip({
      icon: "◔", value: t.due ? (isOverdue(t) ? `overdue ${t.due}` : t.due) : "",
      empty: "no due date", tone: isOverdue(t) ? "tone-overdue" : "",
      build: (done) => {
        const i = el("input", { className: "ts-inline", type: "date", value: t.due || "" });
        i.onchange = () => write({ due: i.value || null }, "due date saved").then(done);
        i.onblur = done;
        return i;
      },
    }));

    meta.append(chip(reminderChipSpec({
      task: t, alerts: alertsForTask(taskId), after: remindersChanged, openList: openReminders,
    })));

    meta.append(chip({
      icon: "◎", value: t.assignee || "", empty: "unassigned",
      tone: isAgent(t.assignee) ? "tone-agent" : "",
      build: (done) => {
        const i = el("input", { className: "ts-inline", value: t.assignee || "", placeholder: "name or agent" });
        i.onchange = () => write({ assignee: i.value.trim() || null }, "assignee saved").then(done);
        i.onblur = done;
        return i;
      },
    }));

    meta.append(chip({
      icon: "◆", value: colourLabel(t.colour), empty: "no colour",
      tone: t.colour ? `hue c-${t.colour}` : "",
      build: (done) => {
        // The swatches replace the chip in place, the same way every other
        // chip becomes its own control, so there is no popover to dismiss.
        const box = el("div", { className: "swatch-inline", tabIndex: -1 });
        box.append(swatchRow(t.colour, (colour) =>
          write({ colour }, colour ? "colour saved" : "colour cleared").then(done)));
        box.addEventListener("focusout", () => {
          // After the browser has moved focus, or a click on a swatch closes
          // the editor before it has run.
          setTimeout(() => { if (!box.contains(document.activeElement)) done(); }, 0);
        });
        return box;
      },
    }));

    if (t.ref) meta.append(el("span", { className: "ts-chip tone-ref" },
      el("span", { className: "ts-chip-icon", textContent: "⧉" }), el("span", { textContent: t.ref })));

    const total = detail.subtasks.length;
    if (total) {
      const done = detail.subtasks.filter((s) => s.status === "done").length;
      const box = el("span", { className: "ts-chip ts-progress" });
      box.append(el("span", { className: "ts-chip-icon", textContent: "▤" }));
      box.append(el("span", { textContent: `${done}/${total}` }));
      const bar = el("span", { className: "ts-bar" });
      bar.append(el("span", { className: "ts-bar-fill", style: `width:${Math.round((done / total) * 100)}%` }));
      box.append(bar);
      meta.append(box);
    }
  }

  // --- description ----------------------------------------------------------

  const desc = el("div", { className: "ts-desc" });

  function paintDesc() {
    desc.textContent = "";
    const text = detail.task.detail || "";
    if (editingDesc) {
      const area = el("textarea", { className: "ts-desc-edit", value: text, spellcheck: false });
      area.placeholder = "What does finishing this actually involve";
      if (window.DelphiRecovery) {
        const kept = DelphiRecovery.draft("desc", draftOf);
        if (kept != null && kept !== text) area.value = kept;
        area.addEventListener("input", () => DelphiRecovery.saveDraft("desc", draftOf, area.value === text ? "" : area.value));
      }
      const save = async () => {
        editingDesc = false;
        if (area.value !== text) await write({ detail: area.value }, "description saved");
        else paintDesc();
        if (window.DelphiRecovery) DelphiRecovery.clearDraft("desc", draftOf);
      };
      area.onblur = save;
      desc.append(area);
      setTimeout(() => area.focus(), 0);
      return;
    }
    // Not "empty": that class already exists for empty states and centres its text.
    const shown = el("div", { className: "ts-desc-read" + (text ? "" : " ts-desc-blank"), tabIndex: 0, role: "button" });
    if (text) shown.append(renderMarkdown(text));
    else shown.append(el("span", { textContent: "Add a description" }));
    const edit = () => { editingDesc = true; paintDesc(); };
    shown.onclick = edit;
    shown.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); edit(); } };
    desc.append(shown);
  }

  // --- tabs -----------------------------------------------------------------

  const tabs = el("div", { className: "ts-tabs", role: "tablist" });
  const paneBox = el("div", { className: "ts-pane" });

  function paintTabs() {
    tabs.textContent = "";
    const entries = [
      ["details", "Details", detail.subtasks.length || null],
      ["reminders", "Reminders", liveAlerts(alertsForTask(taskId)).length || null],
      ["activity", "History", detail.events.length || null],
    ];
    for (const [key, label, count] of entries) {
      const b = el("button", { className: "ts-tab" + (pane === key ? " on" : ""), textContent: label });
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(pane === key));
      if (count) b.append(el("span", { className: "ts-tab-n", textContent: String(count) }));
      b.onclick = () => { pane = key; paintTabs(); paintPane(); };
      tabs.append(b);
    }
  }

  function paintPane() {
    paneBox.textContent = "";
    if (pane === "details") paintSubtasks();
    else if (pane === "reminders") {
      paintTaskReminders(paneBox, {
        task: detail.task, alerts: alertsForTask(taskId), after: remindersChanged,
      });
    } else paintActivity();
  }

  /**
   * Subtasks, as cards.
   *
   * Rows made a subtask look like a line item, which is the one thing it is not:
   * it carries its own status, owner, description, discussion and colour, and a
   * row had space for none of that. A card gives each of them somewhere to sit.
   *
   * Status is a control here rather than a label, because moving a piece of work
   * along is the reason most people open a subtask at all, and doing it from the
   * parent means never leaving the place the work is being read from.
   */
  function paintSubtasks() {
    const subs = detail.subtasks;
    const finished = subs.filter((s) => s.status === "done").length;

    const head = el("div", { className: "ts-sec-head" }, el("h4", { textContent: "Subtasks" }));
    if (subs.length) {
      head.append(el("span", { className: "ts-count", textContent: `${finished}/${subs.length}` }));
      const bar = el("span", { className: "ts-bar wide" });
      bar.append(el("span", { className: "ts-bar-fill", style: `width:${Math.round((finished / subs.length) * 100)}%` }));
      head.append(bar);
    }
    paneBox.append(head);

    if (!subs.length) {
      paneBox.append(el("div", { className: "hint pad",
        textContent: "Nothing broken out yet. A subtask is a task, so each piece gets its own status, owner and discussion." }));
    } else {
      const grid = el("div", { className: "sub-grid" });
      for (const s of subs) grid.append(subtaskCard(s));
      paneBox.append(grid);
    }

    const add = el("input", { className: "ts-add", placeholder: "＋  Add a subtask" });
    add.onkeydown = async (e) => {
      if (e.key !== "Enter" || !add.value.trim()) return;
      await window.delphi.tasks.create({ title: add.value.trim(), parentId: taskId });
      add.value = "";
      await reload();
      refresh();
    };
    paneBox.append(add);
  }

  /** One subtask, as a card in the parent's Details tab. */
  function subtaskCard(s) {
    const card = el("div", { className: "subcard" + (s.status === "done" ? " done" : "") + colourClass(s) });

    // Named apart from the sheet's own write(), which takes a note to flash and
    // acts on the parent.
    const save = async (fields) => {
      await window.delphi.tasks.update(s.id, fields);
      await reload();
      refresh();
    };

    const head = el("div", { className: "subcard-head" });
    const name = el("button", { className: "subcard-title", textContent: s.title, title: "Open this subtask" });
    name.onclick = () => openTaskSheet(s.id);
    const more = el("button", { className: "t-more", textContent: "⋯", title: "Actions" });
    more.setAttribute("aria-label", "Subtask actions");
    more.onclick = (e) => {
      e.stopPropagation();
      const box = more.getBoundingClientRect();
      taskMenu(s, box.left - 150, box.bottom + 4, { after: reload });
    };
    head.append(name, more);
    card.append(head);

    // The first couple of lines of the description, as plain text. Markdown is for
    // the task itself; here it would be six words of formatting in a box the size
    // of a stamp.
    if (s.detail && s.detail.trim()) {
      card.append(el("p", { className: "subcard-note", textContent: s.detail.replace(/\s+/g, " ").trim() }));
    }

    const foot = el("div", { className: "subcard-foot" });

    const status = el("select", { className: `cell-select st-${statusOf(s)}`, title: "Status" });
    status.setAttribute("aria-label", "Subtask status");
    for (const [value, label] of BOARD_COLUMNS) {
      status.append(el("option", { value, textContent: label, selected: statusOf(s) === value }));
    }
    status.onchange = () => save({ status: status.value });
    foot.append(status);

    if (s.priority === "high") foot.append(el("span", { className: "pill high", textContent: "high" }));
    if (isOverdue(s)) foot.append(el("span", { className: "pill overdue", textContent: s.due }));
    else if (s.due) foot.append(el("span", { className: "t-due", textContent: s.due }));
    // Present only when db.subtasks() carries the counts, so a build without that
    // change shows nothing here rather than "undefined".
    if (s.subtask_count) foot.append(el("span", { className: "t-due", textContent: `${s.subtask_done}/${s.subtask_count}` }));
    if (s.comment_count) foot.append(el("span", { className: "t-due", textContent: `${s.comment_count} ✦` }));

    const named = hasColour(s) ? `Colour: ${colourLabel(s.colour)}` : "Set a colour";
    const hue = el("button", { className: "subcard-hue" + (hasColour(s) ? " on" : ""), title: named });
    hue.setAttribute("aria-label", named);
    hue.onclick = (e) => {
      e.stopPropagation();
      const box = hue.getBoundingClientRect();
      colourMenu(box.left - 120, box.bottom + 6, s, (colour) => save({ colour }));
    };
    foot.append(hue);

    const who = el("span", { className: "subcard-who" });
    if (s.assignee) {
      who.append(el("span", {
        className: "avatar sm" + (isAgent(s.assignee) ? " agent" : ""),
        title: s.assignee,
        textContent: s.assignee.slice(0, 1).toUpperCase(),
      }));
      who.append(el("span", { className: "cell-text", textContent: s.assignee }));
    } else {
      who.append(el("span", { className: "cell-empty", textContent: "unassigned" }));
    }
    foot.append(who);

    card.append(foot);
    card.oncontextmenu = (e) => { e.preventDefault(); taskMenu(s, e.clientX, e.clientY, { after: reload }); };
    return card;
  }

  function paintActivity() {
    paneBox.append(el("div", { className: "ts-sec-head" }, el("h4", { textContent: "How it got here" })));
    if (!detail.events.length) {
      paneBox.append(el("div", { className: "hint pad", textContent: "No status history yet." }));
      return;
    }
    const list = el("div", { className: "timeline" });
    detail.events.forEach((e, i) => {
      const next = detail.events[i + 1];
      const row = el("div", { className: "tl-row" + (next ? "" : " current") });
      row.append(el("span", { className: `tl-dot st-${e.status}` }));
      const b = el("div", { className: "tl-body" });
      b.append(el("div", { className: "tl-status" },
        el("span", { textContent: STATUS_LABEL[e.status] || e.status }),
        el("span", { className: "hint", textContent: next ? `for ${gap(e.at, next.at)}` : `for ${gap(e.at)} so far` })));
      b.append(el("div", { className: "tl-when" },
        el("span", { className: "hint", textContent: e.at }),
        e.actor ? el("span", { className: isAgent(e.actor) ? "agent-tag" : "hint", textContent: e.actor }) : null));
      row.append(b);
      list.append(row);
    });
    paneBox.append(list);
  }

  // --- rail: the Sheet ------------------------------------------------------

  const railHead = el("div", { className: "ts-rail-head" });
  const railList = el("div", { className: "ts-comments" });
  railList.setAttribute("role", "log");
  railList.setAttribute("aria-label", "Sheet entries");
  const railFoot = el("div", { className: "ts-composer" });

  // Per entry view state, kept across repaints so a live refresh does not
  // collapse output somebody was reading.
  const outputOpen = new Set();
  const outputText = new Map();   // id -> {text, truncated} or {error}
  // id -> {sig, node}. A row whose signature is unchanged keeps its node, so a
  // refresh leaves focus, hover and selection where they were.
  const rowCache = new Map();
  let railPainted = false;

  const entryById = (id) => detail.comments.find((c) => c.id === id) || null;

  function railCopied(button, label) {
    const before = button.title;
    button.title = label;
    button.classList.add("done");
    setTimeout(() => { button.title = before; button.classList.remove("done"); }, 1200);
  }

  async function loadOutput(id) {
    try {
      const log = await window.delphi.sheets.log(id);
      outputText.set(id, { text: stripAnsi(log.text || ""), truncated: !!log.truncated });
    } catch (error) {
      outputText.set(id, { error: String(error.message || error) });
    }
    paintRail();
  }

  function openFileMenu(button, row, entry, fromKeyboard) {
    const box = button.getBoundingClientRect();
    const items = [el("div", { className: "ctx-head", textContent: "File as" })];
    for (const kind of NOTE_KINDS) {
      items.push({
        label: kind[0].toUpperCase() + kind.slice(1),
        run: async () => {
          try {
            await window.delphi.sheets.file(entry.id, kind, null);
            flash(`filed as ${kind}`);
          } catch (error) { flash(String(error.message || error)); }
          await reload();
        },
      });
    }
    button.setAttribute("aria-expanded", "true");
    row.classList.add("menu-open");
    const menu = rowMenu(box.right - 168, box.bottom + 4, items, {
      className: "ts-entry-menu",
      onClose: () => {
        button.setAttribute("aria-expanded", "false");
        row.classList.remove("menu-open");
      },
    });
    menu.setAttribute("role", "menu");
    const choices = [...menu.querySelectorAll(".ctx-item")];
    for (const c of choices) c.setAttribute("role", "menuitem");
    // Escape is caught here, before it reaches the document handler that
    // closes the whole task panel.
    menu.addEventListener("keydown", (e) => {
      const at = choices.indexOf(document.activeElement);
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); closeRowMenu(); button.focus(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); choices[(at + 1) % choices.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); choices[(at - 1 + choices.length) % choices.length].focus(); }
      else if (e.key === "Tab") { closeRowMenu(); }
    });
    // Focus moves in only for the keyboard; a click leaves it where the
    // pointer is, so the first item does not light up as though chosen.
    if (fromKeyboard) choices[0]?.focus();
    else {
      // The menu itself takes focus instead, so Escape and the arrows still
      // reach its handler.
      menu.tabIndex = -1;
      menu.focus();
    }
  }

  function entryActions(entry, row) {
    const acts = el("span", { className: "ts-entry-acts" });
    const act = (key, label, icon, extra = "") => {
      const b = el("button", { className: `ts-act ${extra}`.trim(), title: label });
      b.setAttribute("aria-label", label);
      b.dataset.act = key;
      b.append(tsIcon(icon, icon === "plus" || icon === "minus" || icon === "x" ? 2.2 : 2));
      acts.append(b);
      return b;
    };

    const promoted = !!entry.promoted;
    const pro = act("promote", promoted ? "Take it out of the ledger" : "Promote to the ledger",
      promoted ? "minus" : "plus", promoted ? "on" : "");
    pro.setAttribute("aria-pressed", String(promoted));
    pro.onclick = async () => {
      try { await window.delphi.sheets.promote(entry.id, !promoted); } catch (error) { flash(String(error.message || error)); }
      await reload();
    };

    // Filing is once only: the entry keeps its note, and a second note from
    // the same words would be a duplicate in search and in the graph.
    if (!entry.note_id) {
      const file = act("file", "File as a project note", "file");
      file.setAttribute("aria-haspopup", "menu");
      file.setAttribute("aria-expanded", "false");
      file.onclick = (e) => { e.stopPropagation(); openFileMenu(file, row, entry, e.detail === 0); };
    }

    const copyLabel = entry.kind === "run" ? "Copy the command (Shift for output too)" : "Copy";
    const cp = act("copy", copyLabel, "copy");
    cp.onclick = async (e) => {
      try {
        await window.delphi.sheets.copy(entry.id, { withOutput: entry.kind === "run" && e.shiftKey });
        railCopied(cp, "Copied");
      } catch (error) { flash(String(error.message || error)); }
    };

    const kill = act("delete", "Delete entry", "x", "kill");
    kill.onclick = async () => { await window.delphi.tasks.uncomment(entry.id); await reload(); };
    return acts;
  }

  function runBody(entry, body) {
    const meta = entry.meta || {};
    // An agent's multi-line command is stored as its first line, with the
    // whole script in meta.script. The line stays short here; hovering, Copy
    // and Show output all give the script.
    const script = typeof (entry.meta || {}).script === "string" && entry.meta.script.trim() ? entry.meta.script : null;
    body.append(el("div", { className: "ts-run-cmd", textContent: entry.body, title: script || entry.body }));
    const line = el("div", { className: "ts-run-meta" });
    const state = meta.state;
    if (state === "ok" || state === "fail" || state === "running") {
      const code = meta.code === null || meta.code === undefined ? "" : `:${meta.code}`;
      line.append(el("span", { className: `ts-run-state ${state}`, textContent: state === "fail" ? `fail${code}` : state }));
    }
    if (state === "running") {
      // Ticked in place by the rail clock, never by rebuilding the row: a
      // rebuild a second would swallow a click on Stop and drop a selection.
      const clock = el("span", { className: "ts-run-clock", textContent: `${elapsed(entry.created_at)} so far` });
      clock.dataset.from = String(entry.created_at);
      line.append(clock);
    }
    // Only a run this window started can be stopped from it: the main process
    // holds its process group, and nobody else's run is this window's to end.
    const live = state === "running" ? runBuffers.get(entry.id) || null : null;
    if (live) {
      const presses = runKills.get(entry.id) || 0;
      const stop = el("button", { className: "ts-linkbtn ts-stop", type: "button", textContent: presses ? "Kill" : "Stop" });
      stop.dataset.act = "stop";
      stop.title = presses ? "It has not stopped. Kill it outright." : "Interrupt it, as Ctrl-C would";
      stop.onclick = async () => {
        try {
          await window.delphi.sheets.interrupt(entry.id);
          runKills.set(entry.id, presses + 1);
        } catch (error) { notifyError(error); }
        paintRail();
      };
      line.append(stop);
    }
    else {
      if (Number.isFinite(meta.dur_ms)) line.append(el("span", { textContent: duration(meta.dur_ms) }));
      if (Number.isFinite(meta.lines)) line.append(el("span", { textContent: plural(meta.lines, "line", "lines") }));
    }

    // Short output arrives inline in meta.out and is shown as is. Anything
    // longer stays in its log file until asked for, because a build log is
    // not something to pull into every repaint of the rail.
    // Not inline when there is a script: the log the main process returns
    // leads with it, so the expanded view shows what ran, then what it said.
    const inline = !script && typeof meta.out === "string" && meta.out ? stripAnsi(meta.out) : "";
    const open = outputOpen.has(entry.id);
    if (!inline && (meta.lines > 0 || state === "running" || script)) {
      const toggle = el("button", { className: "ts-linkbtn", textContent: open ? "Hide output" : "Show output" });
      toggle.dataset.act = "output";
      toggle.setAttribute("aria-expanded", String(open));
      toggle.onclick = () => {
        if (open) { outputOpen.delete(entry.id); paintRail(); return; }
        outputOpen.add(entry.id);
        outputText.delete(entry.id);
        paintRail();
        // A live run already has everything it said since it started.
        if (!runBuffers.has(entry.id)) loadOutput(entry.id);
      };
      line.append(toggle);
    }
    body.append(line);

    if (inline) body.append(el("pre", { className: "ts-run-out", textContent: inline }));
    else if (open && live) body.append(runPre(live));
    else if (open) {
      const got = outputText.get(entry.id);
      const pre = el("pre", { className: "ts-run-out full" });
      pre.setAttribute("tabindex", "0");
      pre.setAttribute("aria-label", "Command output");
      if (!got) pre.append(el("span", { className: "cut", textContent: "Reading the log" }));
      else if (got.error) pre.append(el("span", { className: "cut", textContent: `Could not read the log: ${got.error}` }));
      else {
        if (got.truncated) pre.append(el("span", { className: "cut", textContent: "Earlier output cut, this is the end of the log\n" }));
        pre.append(document.createTextNode(got.text || ""));
        // Opened at the end, because the end of a log is where the error is.
        requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
        if (!got.text) pre.append(el("span", { className: "cut", textContent: "No output was kept" }));
      }
      body.append(pre);
    }
  }

  function askBody(entry, body, answer) {
    body.append(el("div", { className: "ts-ask-q", textContent: entry.body }));
    const options = (entry.meta && Array.isArray(entry.meta.options)) ? entry.meta.options : [];
    const chosen = answer ? String((answer.meta && answer.meta.choice) || String(answer.body || "").split("\n")[0]).trim().toLowerCase() : null;
    const opts = el("div", { className: "ts-ask-opts" + (answer ? " decided" : "") });
    opts.setAttribute("role", "group");
    opts.setAttribute("aria-label", answer ? "Options, decided" : "Choose an answer");
    for (const option of options) {
      const key = String(option.key).toLowerCase();
      const isChosen = chosen === key;
      const b = el("button", { className: "ts-opt" + (isChosen ? " chosen" : "") },
        el("span", { className: "ts-opt-key", textContent: option.key }), String(option.label), isChosen ? " ✓" : null);
      b.dataset.act = `opt-${key}`;
      if (answer) {
        b.disabled = true;
        b.setAttribute("aria-label", `${option.label}${isChosen ? ", chosen" : ""}`);
      } else {
        b.title = `Decide: ${option.label}`;
        b.onclick = async () => {
          try { await window.delphi.sheets.decide(entry.id, option.key, null); } catch (error) { flash(String(error.message || error)); }
          await reload();
        };
      }
      opts.append(b);
    }
    body.append(opts);
    if (answer) {
      body.append(el("div", { className: "hint", style: "margin-top:5px",
        textContent: `Decided by ${answer.author} ${gap(answer.created_at)} ago` }));
    }
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
    const head = el("div", { className: "ts-decide-head" }, "Decided ",
      el("span", { className: "ts-opt-key", textContent: key }), label ? el("strong", { textContent: label }) : null);
    if (ask) {
      const ref = el("button", { className: "ts-linkbtn ts-ref", textContent: `on ${ask.body}` });
      ref.title = "Show the question";
      ref.dataset.act = "ref";
      ref.onclick = () => {
        const target = railList.querySelector(`.ts-entry[data-id="${ask.id}"]`);
        if (!target) return;
        target.scrollIntoView({ block: "center", behavior: motionOff() ? "auto" : "smooth" });
        target.classList.add("flash");
        setTimeout(() => target.classList.remove("flash"), 1400);
      };
      head.append(ref);
    }
    body.append(head);
    const why = lines.slice(1).join("\n").trim();
    if (why) body.append(renderMarkdown(why));
  }

  function entryNode(entry, ctx) {
    const agent = entryIsAgent(entry);
    const k = entry.kind === "say" ? (agent ? "agent" : "say") : (SIGILS[entry.kind] ? entry.kind : "say");
    const row = el("div", { className: `ts-entry k-${k}` });
    row.dataset.id = String(entry.id);
    const inLedger = ctx.ledgerIds.has(entry.id);
    const mark = el("span", { className: "ts-ledger-mark", textContent: inLedger ? "+" : "" });
    if (inLedger) { mark.title = "In the ledger"; mark.setAttribute("aria-label", "In the ledger"); }
    else mark.setAttribute("aria-hidden", "true");
    const sigil = el("span", { className: "ts-sigil", textContent: SIGILS[k] });
    sigil.setAttribute("aria-label", KIND_WORD[k]);
    sigil.title = KIND_WORD[k];
    row.append(mark, sigil);

    const main = el("div", { className: "ts-entry-main" });
    const tag = agent ? (entry.author_type === "tool" ? "tool" : "agent") : null;
    const when = isRunning(entry) ? "now" : `${gap(entry.created_at)} ago`;
    main.append(el("div", { className: "ts-entry-who" },
      el("span", { className: "ts-entry-author", textContent: entry.author || "?", title: entry.author || "" }),
      tag ? el("span", { className: "agent-tag", textContent: tag }) : null,
      el("span", { className: "hint", textContent: when, title: String(entry.created_at || "") }),
      entryActions(entry, row)));

    const body = el("div", { className: "ts-entry-body" });
    if (entry.kind === "run") runBody(entry, body);
    else if (entry.kind === "ask") askBody(entry, body, ctx.answers.get(entry.id) || null);
    else if (entry.kind === "decide") decideBody(entry, body);
    else body.append(renderMarkdown(entry.body));
    if (entry.note_id) {
      const where = detail.project ? `filed to ${detail.project.name} notes` : "filed as a note";
      body.append(el("div", { className: "ts-filed" },
        el("span", { className: `kind ${entry.note_kind || "note"}`, textContent: entry.note_kind || "note" }),
        el("span", { className: "hint", textContent: where })));
    }
    main.append(body);
    row.append(main);
    row.setAttribute("aria-label", `${KIND_WORD[k]} by ${entry.author || "unknown"}, ${when}`);
    return row;
  }

  function paintRail({ stick = false } = {}) {
    const entries = detail.comments;
    // The ledger by the store's rule (sheet/store.js LEDGER_WHERE): promoted
    // entries, every decision that answers a question, and the question each
    // answers. Worked out here from the entries already loaded, rather than a
    // second read on every refresh.
    const answers = new Map();
    for (const e of entries) if (e.kind === "decide" && e.ref_id) answers.set(e.ref_id, e);
    const ledgerIds = new Set();
    for (const e of entries) {
      if (e.promoted || (e.kind === "decide" && e.ref_id) || answers.has(e.id)) ledgerIds.add(e.id);
    }
    const ctx = { answers, ledgerIds };
    paintRailHead(entries.length, ledgerIds.size);
    paintRailList(entries, ctx, stick);
  }

  // Redrawn only when what it says changes, so the clock's ticks never take
  // focus off the toggle or the copy button.
  let railHeadSig = null;
  function paintRailHead(total, ledgerSize) {
    const sig = [total, ledgerSize, railLedger].join("/");
    if (sig === railHeadSig) return;
    const hadFocus = railHead.contains(document.activeElement) ? document.activeElement.dataset.act : null;
    railHeadSig = sig;
    railHead.textContent = "";
    const all = el("button", { textContent: "All" });
    all.setAttribute("aria-pressed", String(!railLedger));
    const led = el("button", {}, "Ledger ", el("span", { className: "ts-count", textContent: String(ledgerSize) }));
    led.setAttribute("aria-pressed", String(railLedger));
    all.dataset.act = "all";
    led.dataset.act = "ledger";
    all.onclick = () => { if (railLedger) { railLedger = false; paintRail({ stick: true }); } };
    led.onclick = () => { if (!railLedger) { railLedger = true; paintRail({ stick: true }); } };
    const seg = el("div", { className: "seg ts-ledger-toggle" }, all, led);
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Show");
    const copyAll = el("button", { className: "icon-btn" });
    const copyAllLabel = railLedger ? "Copy the ledger as clean text" : "Copy the whole Sheet as clean text";
    copyAll.title = copyAllLabel;
    copyAll.setAttribute("aria-label", copyAllLabel);
    copyAll.dataset.act = "copy-all";
    copyAll.append(tsIcon("copy"));
    copyAll.onclick = async () => {
      try {
        await window.delphi.sheets.copyAll(taskId, { ledger: railLedger });
        copyAll.classList.add("on");
        copyAll.title = "Copied";
        setTimeout(() => { copyAll.classList.remove("on"); copyAll.title = copyAllLabel; }, 1200);
      } catch (error) { flash(String(error.message || error)); }
    };
    railHead.append(el("h4", { textContent: "Sheet" }));
    if (total) railHead.append(el("span", { className: "ts-count", textContent: String(total) }));
    railHead.append(el("span", { className: "grow" }), seg, copyAll);
    if (hadFocus) railHead.querySelector(`[data-act="${hadFocus}"]`)?.focus();
  }

  const railHint = el("div", { className: "hint pad" });
  function paintRailList(entries, { answers, ledgerIds }, stick) {
    const ctx = { answers, ledgerIds };

    const shown = railLedger ? entries.filter((e) => ledgerIds.has(e.id)) : entries;
    const nearBottom = railList.scrollHeight - railList.scrollTop - railList.clientHeight < 40;
    const focused = railList.contains(document.activeElement) ? document.activeElement : null;
    const focusedRow = focused ? focused.closest(".ts-entry") : null;
    const focusedAct = focused && focused.dataset ? focused.dataset.act : null;

    const wanted = [];
    const keep = new Set();
    for (const entry of shown) {
      const answer = answers.get(entry.id);
      // Everything a row draws from, so an unchanged row is never rebuilt.
      // The time words are in it, which is what keeps "5m ago" honest.
      const sig = JSON.stringify([entry, ledgerIds.has(entry.id), answer ? [answer.id, answer.body, answer.meta, answer.author, gap(answer.created_at)] : null,
        isRunning(entry) ? "now" : gap(entry.created_at), outputOpen.has(entry.id),
        runBuffers.has(entry.id), runKills.get(entry.id) || 0, outputText.get(entry.id) || null,
        entry.ref_id ? (entryById(entry.ref_id) || {}).body : null, detail.project ? detail.project.name : null]);
      const cached = rowCache.get(entry.id);
      const node = cached && cached.sig === sig ? cached.node : entryNode(entry, ctx);
      rowCache.set(entry.id, { sig, node });
      keep.add(entry.id);
      wanted.push(node);
    }
    for (const id of [...rowCache.keys()]) if (!keep.has(id)) rowCache.delete(id);

    let hint = "";
    if (!shown.length) {
      hint = railLedger
        ? "Nothing in the ledger yet. Promote an entry to keep it here: the ledger is what the next agent reads first."
        : "Nothing written yet. Agents write here too, and what they leave is what the next one reads.";
    } else if (railLedger) {
      hint = "The ledger is what the next agent reads first. Promote an entry to keep it here.";
    }
    if (hint) {
      if (railHint.textContent !== hint) railHint.textContent = hint;
      wanted.push(railHint);
    }

    // Reconciled in place rather than cleared and refilled: an untouched row
    // keeps its node, so focus stays put and nothing visibly redraws.
    wanted.forEach((node, i) => {
      const at = railList.children[i];
      if (at !== node) railList.insertBefore(node, at || null);
    });
    while (railList.children.length > wanted.length) railList.lastElementChild.remove();

    if (focusedRow && !focusedRow.isConnected) {
      const again = railList.querySelector(`.ts-entry[data-id="${focusedRow.dataset.id}"]`);
      const target = again && (focusedAct ? again.querySelector(`[data-act="${focusedAct}"]`) : null);
      if (target) target.focus({ preventScroll: true });
      else if (again) again.querySelector("button")?.focus({ preventScroll: true });
    }
    if (!railPainted || stick || nearBottom) railList.scrollTop = railList.scrollHeight;
    railPainted = true;
  }

  // The rail's clocks. A running entry's elapsed time ticks every second,
  // written into its own text node; "5m ago" only needs keeping honest once
  // a minute, by the reconciling repaint, which rebuilds only the rows whose
  // words changed.
  let tickCount = 0;
  const railClock = setInterval(() => {
    if (!overlay.isConnected) { clearInterval(railClock); return; }
    tickCount += 1;
    for (const clock of railList.querySelectorAll(".ts-run-clock")) {
      const text = `${elapsed(clock.dataset.from)} so far`;
      if (clock.firstChild && clock.firstChild.data !== text) clock.firstChild.data = text;
    }
    if (tickCount % 60 === 0) paintRail();
  }, 1000);

  // --- composer ---

  const composerKind = el("div", { className: "ts-composer-kind" });
  composerKind.setAttribute("aria-live", "polite");
  const composer = el("textarea", { className: "ts-composer-box", placeholder: "Write to the Sheet" });
  composer.setAttribute("aria-label", "Write to the Sheet");
  if (window.DelphiRecovery) DelphiRecovery.bindDraft(composer, "sheet", draftOf);
  const send = el("button", { className: "btn primary sm", textContent: "Comment" });

  /**
   * What the box will post, read from its prefix. The same prefixes the text
   * format uses for the same kinds, so nothing new has to be learned.
   */
  function composed() {
    const v = composer.value;
    if (/^\$ /.test(v)) {
      const command = v.slice(2).trim();
      // Said before Enter, because where a command runs is the thing most
      // worth knowing about it. The main process picks the same way: the
      // Workbench, then the project's folders, then home.
      const wb = detail.workbench;
      const where = wb && wb.state !== "missing" ? "the Workbench folder"
        : detail.project ? "the project's folder" : "your home folder";
      return { kind: "run", ok: !!command, say: `Runs in ${where}, output is kept`, label: "Run", command };
    }
    if (/^! /.test(v)) {
      const text = v.slice(2).trim();
      return { kind: "note", ok: !!text, say: "Posts a note", label: "Note", body: text };
    }
    if (/^\? /.test(v)) {
      const parts = v.slice(2).split("|").map((s) => s.trim()).filter(Boolean);
      const n = parts.length - 1;
      const ok = n >= 2 && n <= 4;
      return {
        kind: "ask", ok, label: "Ask", question: parts[0], options: parts.slice(1),
        say: ok ? `Asks "${parts[0]}" with ${n} options, a to ${"abcd"[n - 1]}` : "An ask needs 2 to 4 options: ? question | a | b",
      };
    }
    return { kind: "say", ok: !!v.trim(), say: "Posts a comment", label: "Comment", body: v };
  }

  function senseComposer(error = null) {
    const c = composed();
    composerKind.textContent = "";
    composerKind.className = `ts-composer-kind k-${c.kind}`;
    composerKind.append(el("span", { className: "ts-sigil", textContent: SIGILS[c.kind] }), error || c.say);
    composer.classList.toggle("mono-in", c.kind === "run");
    send.textContent = c.label;
    send.disabled = !c.ok || sending;
  }

  // Set from the moment a send starts until it has landed, so Enter held
  // down or a double click cannot post twice or run a command twice.
  let sending = false;
  const post = async () => {
    if (sending) return;
    const c = composed();
    if (!c.ok) return;
    sending = true;
    send.disabled = true;
    try {
      if (c.kind === "run") {
        // Resolves once the command has started, or been refused by the
        // guard; its output follows on onSheetRunOutput. Opened straight
        // away, because whoever typed it is waiting to see what it says.
        const entry = await window.delphi.sheets.run(taskId, c.command);
        if (entry && entry.id != null) {
          outputOpen.add(entry.id);
          if (isRunning(entry) && !runsEnded.has(entry.id)) runBuffer(entry.id, taskId);
        }
      } else if (c.kind === "ask") await window.delphi.sheets.ask(taskId, c.question, c.options);
      else await window.delphi.sheets.append(taskId, { kind: c.kind, body: c.body });
    } catch (error) {
      sending = false;
      senseComposer(String(error.message || error));
      return;
    }
    sending = false;
    composer.value = "";
    if (window.DelphiRecovery) DelphiRecovery.clearDraft("sheet", draftOf);
    senseComposer();
    detail = await window.delphi.tasks.detail(taskId) || detail;
    paintAll({ stick: true });
  };
  composer.oninput = () => senseComposer();
  composer.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); post(); } };
  send.onclick = post;
  railFoot.append(composerKind, composer, el("div", { className: "ts-composer-row" },
    el("span", { className: "hint", textContent: "$ runs  ·  ! notes  ·  ? q | a | b asks" }), send));
  senseComposer();

  // --- assemble -------------------------------------------------------------

  function paintAll({ stick = false } = {}) {
    paintTop();
    paintWorkbench();
    paintAdvanced();
    paintRing();
    paintMeta();
    paintDesc();
    paintTabs();
    paintPane();
    paintRail({ stick });
    if (document.activeElement !== title) title.value = detail.task.title;
  }

  /**
   * A write from somewhere else: an agent, the CLI, another window.
   *
   * Only what changed is redrawn, and nothing that holds something being typed:
   * a description being edited, a chip's inline field, the subtask box. The
   * composer is never redrawn at all, so a draft survives any number of these.
   * Coalesced, because a busy agent can land several writes in one breath.
   */
  let liveBusy = false;
  let liveAgain = false;
  async function live() {
    if (liveBusy) { liveAgain = true; return; }
    liveBusy = true;
    try {
      do {
        liveAgain = false;
        const next = await window.delphi.tasks.detail(taskId);
        if (openSheet !== handle) return;
        if (!next) return;
        if (JSON.stringify(next) === JSON.stringify(detail)) continue;
        detail = next;
        const holding = (box) => box.contains(document.activeElement);
        paintTop();
        paintWorkbench();
        paintAdvanced();
        paintRing();
        if (!holding(meta)) paintMeta();
        if (!editingDesc) paintDesc();
        paintTabs();
        if (!holding(paneBox)) paintPane();
        paintRail();
        if (document.activeElement !== title) title.value = detail.task.title;
      } while (liveAgain);
    } finally {
      liveBusy = false;
    }
  }

  main.append(titleRow, meta, desc, advHost, tabs, paneBox);
  rail.append(railHead, railList, railFoot);
  overlay.append(sheet);
  document.body.append(overlay);
  paintAll();
  growTitle();

  const closeSheet = async () => {
    if (!openSheet) return;
    openSheet = null;
    if (window.DelphiRecovery) DelphiRecovery.taskClosed();
    const updates = {};
    if (title.value.trim() && title.value !== detail.task.title) updates.title = title.value.trim();
    overlay.remove();
    if (Object.keys(updates).length) {
      await window.delphi.tasks.update(taskId, updates);
      refresh();
    }
    if (window.DelphiRecovery) DelphiRecovery.clearDraft("title", draftOf);
  };

  overlay.onclick = (e) => { if (e.target === overlay) closeSheet(); };
  const handle = {
    overlay, close: closeSheet, live, taskId,
    wbRepaint: () => paintWorkbench(),
    runsRepaint: () => paintRun(),
    // From a BUSY refusal: bring a running entry into view with its output open.
    showEntry: (id) => {
      outputOpen.add(id);
      paintRail();
      const row = railList.querySelector(`.ts-entry[data-id="${id}"]`);
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: motionOff() ? "auto" : "smooth" });
      row.classList.add("flash");
      setTimeout(() => row.classList.remove("flash"), 1400);
      row.querySelector("[data-act=stop], button")?.focus({ preventScroll: true });
    },
    // A Start phase for this task: redraw the chip, and once it is over, the
    // whole panel, since the Workbench row now exists.
    wbEvent: (e) => { paintWorkbench(); if (e.phase === "ready" || e.phase === "failed") reload(); },
    // A run from this window finished. What was streamed stays on screen as
    // the expanded output, so finishing does not blank what was being read.
    runDone: (entryId, buffer) => {
      if (buffer && buffer.truncated && outputOpen.has(entryId)) {
        outputText.delete(entryId);
        loadOutput(entryId);
      } else if (buffer && outputOpen.has(entryId)) {
        const tail = buffer.partial ? runLine(buffer.partial) : "";
        outputText.set(entryId, { text: buffer.lines.join("\n") + (tail ? "\n" + tail : ""), truncated: buffer.dropped > 0 });
      }
      reload();
    },
  };
  openSheet = handle;
  if (window.DelphiRecovery) DelphiRecovery.taskOpened(taskId);
}

// ---------------------------------------------------------------------------
// Runs and Needs you
//
// One list of jobs (agent/jobs.js), read once and drawn in five places: the
// Runs page, the Needs you inbox, the sidebar's badges, the title bar, and the
// chip on a task. All five read state.runs, so answering something in one
// clears it from the others in the same repaint rather than whenever each
// next thinks to ask.
// ---------------------------------------------------------------------------

// The places that are not a project and have no tabs of their own.
const HOME_VIEWS = ["today", "runs", "inbox"];
const RUN_OPEN = ["queued", "needs_approval", "running", "waiting_on_human"];
const RUN_WAITING = ["needs_approval", "waiting_on_human"];

const runsIn = (states) => state.runs.filter((r) => states.includes(r.state));
const waitingRuns = () => runsIn(RUN_WAITING);
// Questions answered here, by run, with the updated_at the run had then. The
// dispatcher resumes an answered run on its next pass, which can be a minute
// away; until the run itself moves it is shown as answered and not counted.
const answeredRuns = new Map();
const isAnswered = (r) => answeredRuns.has(r.id) && answeredRuns.get(r.id) === r.updated_at;
const needsYouCount = () => waitingRuns().filter((r) => !isAnswered(r)).length;
// The sidebar badge counts everything Needs you shows: agents paused on you,
// finished runs nobody has reviewed, and flags waiting on a decision. The title
// bar keeps to the first, because "waiting on you" there means an agent is stuck.
const needsYouTotal = () => needsYouCount() + reviewRuns().length + (state.flagRows || []).length + (window.DelphiNeeds ? DelphiNeeds.count() : 0);
const onHomeView = () => !state.query && !state.projectId && HOME_VIEWS.includes(state.view);

/**
 * Asks for the list again, at most a few times a second.
 *
 * A running job reports activity once a second and every enabled agent can
 * have several going, so a trailing debounce could be starved for as long as
 * they run. This is a throttle instead: the first change starts a short timer
 * and every change inside it rides along. The comparison afterwards means a
 * ping that changed nothing anybody can see repaints nothing.
 */
let runsTimer = null;
let runsBusy = false;
let runsAgain = false;
function runsChanged() {
  if (runsTimer) return;
  runsTimer = setTimeout(() => { runsTimer = null; reloadRuns(); }, 400);
}
async function reloadRuns() {
  if (runsBusy) { runsAgain = true; return; }
  runsBusy = true;
  try {
    do {
      runsAgain = false;
      let next;
      try { next = await window.delphi.runs.list({ limit: 300 }); } catch { return; }
      if (JSON.stringify(next) === JSON.stringify(state.runs)) continue;
      state.runs = next;
      paintRunsLive();
    } while (runsAgain);
  } finally {
    runsBusy = false;
  }
}

/** Everything that shows a run, and nothing else: no tasks, notes or pads are asked for again. */
function paintRunsLive() {
  renderSidebar();
  paintTitleLive();
  if (onHomeView()) repaintKeepingFocus();
  if (openSheet && openSheet.runsRepaint) openSheet.runsRepaint();
}

/**
 * A name for the focused control that survives the node being rebuilt: its
 * data-keep when it has one, otherwise the row it is in (data-row) and what
 * it is (data-act, else its words). Only the sidebar and the page are named;
 * focus inside a dialog is never at risk from a repaint underneath it.
 */
function focusKey(node) {
  if (!node || node === document.body || !node.closest) return null;
  const scope = node.closest("#projects") ? "side" : node.closest("#content") ? "content" : null;
  if (!scope) return null;
  const sel = typeof node.selectionStart === "number" ? [node.selectionStart, node.selectionEnd] : null;
  if (node.dataset && node.dataset.keep) return { scope, keep: node.dataset.keep, sel };
  const row = node.closest("[data-row]");
  return {
    scope, sel, tag: node.tagName, row: row ? row.dataset.row : null, self: row === node,
    act: (node.dataset && node.dataset.act) || null, text: (node.textContent || "").trim().slice(0, 80),
  };
}

/** Focus the control a focusKey named, if it is still there and there is only one it could be. */
function restoreFocus(key) {
  if (!key) return;
  const root = key.scope === "side" ? $("projects") : $("content");
  if (!root) return;
  let target = null;
  if (key.keep) {
    target = root.querySelector(`[data-keep="${CSS.escape(key.keep)}"]`);
  } else {
    const within = key.row ? root.querySelector(`[data-row="${CSS.escape(key.row)}"]`) : root;
    if (!within) return;
    if (key.self) target = within;
    else {
      const all = [...within.querySelectorAll(key.tag)];
      const byAct = key.act ? all.filter((n) => n.dataset.act === key.act) : [];
      const byText = all.filter((n) => (n.textContent || "").trim().slice(0, 80) === key.text);
      // Without a row to narrow it, "Approve" could be any of several; a
      // wrong guess is worse than none.
      const pickFrom = byAct.length ? byAct : byText;
      if (pickFrom.length === 1) target = pickFrom[0];
    }
  }
  if (!target || target === document.activeElement || typeof target.focus !== "function") return;
  target.focus({ preventScroll: true });
  if (key.sel && target.setSelectionRange) { try { target.setSelectionRange(key.sel[0], key.sel[1]); } catch {} }
}

// A pointer held down on a control that a repaint replaces never becomes a
// click. Repaints that arrive mid-press wait for the release instead.
let pointerDown = false;
const afterPointer = new Set();
document.addEventListener("pointerdown", () => { pointerDown = true; }, true);
const pointerReleased = () => {
  pointerDown = false;
  const runs = [...afterPointer];
  afterPointer.clear();
  // After the click this release produces, not before it.
  if (runs.length) setTimeout(() => runs.forEach((run) => run()), 0);
};
// A drag ends in pointercancel or dragend rather than pointerup.
for (const type of ["pointerup", "pointercancel", "dragend"]) document.addEventListener(type, pointerReleased, true);

/**
 * A repaint that leaves the person where they were.
 *
 * render() replaces the pane, so focus would drop to the page on every
 * activity ping. Drafts live in runDrafts; the focused control, a field or a
 * button or a sidebar row, is found again by focusKey.
 */
function repaintKeepingFocus() {
  if (pointerDown) { afterPointer.add(repaintKeepingFocus); return; }
  const key = focusKey(document.activeElement);
  render();
  restoreFocus(key);
}

// What has been typed into a reply or a reason, by run, so a repaint keeps it.
const runDrafts = new Map();
// Sends in flight, by the same keys, so Enter pressed twice sends once. And
// the sentence a refusal came back with, shown under the field until the
// next send, because the repaint that follows a refusal would otherwise drop it.
const runSending = new Set();
const runRefused = new Map();

/**
 * Sends what a field holds, once. The draft is cleared only when the call
 * succeeds: a refused reply keeps its words and shows the refusal under them,
 * rather than leaving the person to type it again.
 */
async function sendDraft(key, fn) {
  if (runSending.has(key)) return false;
  runSending.add(key);
  runRefused.delete(key);
  try {
    await fn();
    runDrafts.delete(key);
    return true;
  } catch (error) {
    runRefused.set(key, refusalWords(error));
    return false;
  } finally {
    runSending.delete(key);
    reloadRuns();
    repaintKeepingFocus();
  }
}
/** The refusal under a field, when its last send was refused. */
const refusedLine = (key) => (runRefused.has(key) ? el("div", { className: "err-msg", role: "alert", textContent: runRefused.get(key) }) : null);
// When Stop was pressed, by run. A run still going well after that gets Kill.
const stopAsked = new Map();
const KILL_AFTER_MS = 8000;

// The clocks on the page move without asking the main process anything: the
// stamps are already here, and only their distance from now has changed.
setInterval(() => {
  if (!onHomeView()) return;
  for (const node of document.querySelectorAll("[data-since]")) node.textContent = spanWords(TIME.secondsSince(node.dataset.since));
  for (const node of document.querySelectorAll("[data-waiting]")) node.textContent = `waiting ${spanWords(TIME.secondsSince(node.dataset.waiting))}`;
}, 15000);

// ---------------------------------------------------------------------------
// Words and small parts

/** 4:21pm, the way the mockups and a person say it. */
function clockWords(stamp) {
  const at = TIME.parseStamp(stamp);
  if (!at) return "";
  const h = at.getHours();
  return `${h % 12 || 12}:${String(at.getMinutes()).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;
}

/** 40s, 19m, 2h 5m. */
function spanWords(seconds) {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const compactNumber = (n) => n < 1000 ? String(n) : n < 1e6 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`;

/**
 * What a run has cost, in the unit its agent reports. Claude Code reports
 * dollars and Codex reports tokens, and the two are never converted or added:
 * a total made of guesses would be worse than two honest numbers.
 */
function runCost(run) {
  if (run.cost_usd != null && run.cost_usd > 0) return `$${run.cost_usd.toFixed(2)}`;
  const tokens = (run.tokens_in || 0) + (run.tokens_out || 0);
  return tokens ? `${compactNumber(tokens)} tokens` : null;
}

const firstLineOf = (text, n = 160) => {
  const line = String(text || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  return line.length > n ? `${line.slice(0, n - 3)}...` : line;
};

// el() assigns props, and dataset is a getter that cannot be assigned to.
const withData = (node, data) => { Object.assign(node.dataset, data); return node; };

const AGENT_MARKS = { "claude-code": "C", codex: "X", copilot: "G" };

function agentAvatar(key, label) {
  const known = Object.prototype.hasOwnProperty.call(AGENT_MARKS, key);
  const letter = known ? AGENT_MARKS[key] : String(label || key || "?").trim().charAt(0).toUpperCase() || "?";
  return el("span", { className: `avatar lg ag-${known ? key : "other"}`, textContent: letter, title: label || key || "" });
}

function projectDot(projectId) {
  const p = state.projects.find((x) => x.id === projectId);
  return el("span", { className: "dot", style: `background:${safeColour(p && p.colour)}` });
}

/** "#155 The Foundry", or the request's first line for a job with no task yet. */
function runTitle(run) {
  const t = el("div", { className: "t" });
  if (run.task_id) {
    t.append(el("span", { className: "id", textContent: `#${run.task_id}` }), run.task_title || firstLineOf(run.request));
  } else {
    t.append(firstLineOf(run.request));
  }
  t.title = run.task_title || run.request || "";
  return t;
}

const runWho = (run) => run.actor || run.harness;

const RUN_STATE_WORDS = {
  queued: "queued", needs_approval: "needs approval", running: "running",
  waiting_on_human: "waiting on you", done: "done", failed: "failed", stopped: "stopped",
};
const RUN_STATE_CLASS = {
  queued: "queued", needs_approval: "waiting", running: "running",
  waiting_on_human: "waiting", done: "ok", failed: "fail", stopped: "stopped",
};
function runStateChip(run, tag = "span") {
  return el(tag, { className: `ts-run-state ${RUN_STATE_CLASS[run.state] || ""}`, textContent: RUN_STATE_WORDS[run.state] || run.state });
}

// Fixed markup only, never anything from the database.
const HOME_ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13L21 13v6H3v-6z"/>',
  runs: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  memory: '<path d="M12 3a6 6 0 0 0-4 10.5V17h8v-3.5A6 6 0 0 0 12 3z"/><path d="M9 21h6"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  open: '<path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};
function homeIcon(name, className = "") {
  const holder = document.createElement("span");
  holder.innerHTML = `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${HOME_ICONS[name]}</svg>`;
  return holder.firstChild;
}

// ---------------------------------------------------------------------------
// Limits

/** The limits the dispatcher works to, read the way agent/dispatch.js reads them. */
function runLimits() {
  const s = state.settings || {};
  const int = (v, fallback, lo, hi) => {
    const n = Number(v);
    return v != null && Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
  };
  const per = s.jobHarnessLimits && typeof s.jobHarnessLimits === "object" ? s.jobHarnessLimits : {};
  return { global: int(s.jobConcurrency, 3, 1, 16), harness: (key) => int(per[key], 1, 0, 16) };
}

const enabledAgents = () => state.harnesses.filter((h) => Number(h.enabled) === 1 || h.enabled === true);
const agentLabel = (key) => (state.harnesses.find((h) => h.key === key) || {}).label || key;

/** Why a queued run has not started, in the dispatcher's own order of checks. */
function whyQueued(run) {
  const lim = runLimits();
  const running = runsIn(["running"]);
  const label = run.harness_label || agentLabel(run.harness);
  const sameTask = run.task_id ? running.find((r) => r.task_id === run.task_id) : null;
  if (sameTask) return `Waits for run ${sameTask.id} on the same task, which has one Workbench.`;
  const cap = lim.harness(run.harness);
  if (cap === 0) return `${label} is set to 0 at a time, so it waits until that is raised.`;
  // The agent's own limit first when both bind: it is the more specific
  // answer, and raising the overall number alone would not start it.
  const mine = running.filter((r) => r.harness === run.harness).length;
  if (mine >= cap) return `Waits for a ${label} slot. ${mine} of ${cap} ${cap === 1 ? "is" : "are"} busy.`;
  if (running.length >= lim.global) return `Waits for a free slot. ${running.length} of ${lim.global} are busy.`;
  return "Starts in a moment.";
}

function slotsBar() {
  const lim = runLimits();
  const running = runsIn(["running"]);
  const bar = el("div", { className: "slots" });
  const pips = el("span", { className: "slot-pips", title: `${running.length} of ${lim.global} slots in use` });
  for (let i = 0; i < lim.global; i += 1) pips.append(el("i", { className: i < running.length ? "on" : "" }));
  const busy = running.length >= lim.global ? `All ${lim.global} are busy.`
    : running.length ? `${running.length} busy, ${lim.global - running.length} free.`
    : lim.global === 1 ? "It is free." : `All ${lim.global} are free.`;
  const per = el("span", { className: "per" });
  enabledAgents().forEach((h, i) => {
    const n = running.filter((r) => r.harness === h.key).length;
    per.append(i ? ", " : "", `${h.label} `, el("b", { textContent: `${n} of ${lim.harness(h.key)}` }));
  });
  if (per.childNodes.length) per.append(".");
  const change = el("button", { className: "btn sm", textContent: "Change", type: "button" });
  change.onclick = () => limitsDialog();
  bar.append(pips,
    el("span", {}, el("b", { textContent: `${plural(lim.global, "agent", "agents")} at a time.` }), ` ${busy} `, per),
    el("span", { className: "grow" }),
    el("span", { className: "hint", textContent: "A run waiting on you gives its slot back." }),
    change);
  return bar;
}

/**
 * How many agents at once, overall and per agent. Written through
 * settings:set, then read back: a value the main process did not keep is said
 * to have not been kept, rather than shown as saved.
 */
async function limitsDialog() {
  const lim = runLimits();
  let global = lim.global;
  const per = Object.fromEntries(enabledAgents().map((h) => [h.key, lim.harness(h.key)]));
  const say = el("div", { className: "lim-say" });
  const paintSay = () => {
    say.textContent = "";
    const top = Object.entries(per).filter(([, n]) => n > 0 && n < global).sort((a, b) => b[1] - a[1])[0];
    say.append("Up to ", el("b", { textContent: plural(global, "agent", "agents") }), " run at once");
    if (top) say.append(", and no more than ", el("b", { textContent: `${top[1]} of them ${agentLabel(top[0])}` }));
    say.append(". The next queued run starts the moment a slot frees. A run that is paused on you does not count.");
  };
  const stepper = (get, set, lo, hi) => {
    const value = el("span", { textContent: String(get()) });
    const less = el("button", { type: "button", textContent: "-", title: "Fewer" });
    const more = el("button", { type: "button", textContent: "+", title: "More" });
    const sync = () => { value.textContent = String(get()); less.disabled = get() <= lo; more.disabled = get() >= hi; paintSay(); };
    less.onclick = () => { set(Math.max(lo, get() - 1)); sync(); };
    more.onclick = () => { set(Math.min(hi, get() + 1)); sync(); };
    sync();
    return el("span", { className: "step" }, less, value, more);
  };
  const row = (avatar, label, note, step) => el("div", { className: "lim-row" }, avatar,
    el("div", {}, el("div", { textContent: label }), note ? el("div", { className: "hint", textContent: note }) : null), step);
  const rows = [row(el("span", { className: "avatar lg ag-other", textContent: "#" }), "All agents together", "Across every project",
    stepper(() => global, (n) => { global = n; }, 1, 16))];
  for (const h of enabledAgents()) {
    rows.push(row(agentAvatar(h.key, h.label), h.label, h.key === "claude-code" ? "A subscription throttles past about 2" : null,
      stepper(() => per[h.key], (n) => { per[h.key] = n; }, 0, 16)));
  }
  paintSay();
  const ok = await wbDialog({
    title: "How many agents at once",
    body: [...rows, say],
    actions: [...(window.DelphiSettingsPanel ? [{ label: "Configure...", value: "configure" }] : []), { label: "Cancel", value: false }, { label: "Save", kind: "primary", value: true }],
    cancelValue: false,
  });
  if (ok === "configure") { if (window.DelphiSettingsPanel) DelphiSettingsPanel.configure("jobConcurrency"); return; }
  if (!ok) return;
  try {
    const saved = await window.delphi.settings.set({ jobConcurrency: global, jobHarnessLimits: per });
    const kept = saved && Number(saved.jobConcurrency) === global;
    state.settings = saved || state.settings;
    if (!kept) notify("Delphi did not keep that: this version does not accept agent limits from the window yet. They can be set in settings.json as jobConcurrency and jobHarnessLimits.", { error: true });
  } catch (error) { notifyError(error); }
  paintRunsLive();
}

// ---------------------------------------------------------------------------
// Acting on a run

async function openRunSheet(run) {
  if (!run.task_id) { notify("This run has no task yet. It gets one, and a Sheet, when it starts."); return; }
  await openTaskSheet(run.task_id);
}

/** Does something to a run, says what went wrong in the dispatcher's words, and asks for the list again. */
async function runAct(fn) {
  try { await fn(); } catch (error) { notifyError(error); }
  reloadRuns();
}

async function stopRun(run) {
  if (stopAsked.has(run.id) && Date.now() - stopAsked.get(run.id) >= KILL_AFTER_MS) {
    // A second stop on a live run is the dispatcher's kill: SIGKILL to the
    // agent's whole process group, no grace period.
    return runAct(() => window.delphi.runs.stop(run.id));
  }
  const label = run.harness_label || run.harness;
  const where = run.workbench && run.workbench.branch ? el("div", { className: "grp" },
    el("div", { className: "grp-h" }, "Left in ", el("code", { textContent: run.workbench.branch })),
    el("div", { className: "hint", textContent: run.workbench.path || "" })) : null;
  const ok = await wbDialog({
    title: `Stop ${label}${run.task_id ? ` on #${run.task_id}` : ""}?`,
    lead: "It stops now, mid-step. Nothing is thrown away: the Workbench stays exactly as it is, and a Sheet entry records who stopped it and when.",
    body: [where, el("p", { className: "wb-lead", textContent: "Afterwards you can hand it back to an agent, finish it yourself, or discard it from the task." })],
    actions: [{ label: "Keep running", value: false }, { label: "Stop the run", kind: "danger", value: true }],
    cancelValue: false,
  });
  if (!ok) return;
  stopAsked.set(run.id, Date.now());
  // Repainted once the grace period is over, so Stop turns into Kill without
  // anything else having to happen first.
  setTimeout(() => { if (onHomeView()) repaintKeepingFocus(); }, KILL_AFTER_MS + 100);
  await runAct(() => window.delphi.runs.stop(run.id));
}

function stopButton(run) {
  const asked = stopAsked.get(run.id);
  const kill = asked && Date.now() - asked >= KILL_AFTER_MS;
  const b = el("button", { className: "btn stop" + (kill ? " kill" : ""), type: "button" });
  b.dataset.act = "stop";
  if (kill) {
    b.textContent = "Kill";
    b.title = "It has not stopped. Kill ends the agent and everything it started at once.";
  } else if (asked) {
    b.textContent = "Stopping";
    b.disabled = true;
  } else {
    b.append(homeIcon("stop"), "Stop");
  }
  b.onclick = () => stopRun(run);
  return b;
}

/**
 * The button that goes with a refusal, when the refusal names a setting.
 * Matched on the setting the sentence names, so a sentence that says only
 * what went wrong gets no button rather than a wrong one.
 */
function settingFix(text, projectId) {
  const t = String(text || "");
  if (projectId && /project\b[^.]*settings|Allow unguarded agents/i.test(t)) {
    const anchor = /\bFolder\b/.test(t) ? "project-folder" : "agent-perms";
    return { label: "Open project settings", go: () => openProjectSettingsAt(projectId, anchor) };
  }
  if (/Settings, under Agents/i.test(t)) {
    return { label: "Open Settings", go: async () => {
      if (openSheet) await openSheet.close();
      await goTo({ projectId: null, view: "settings", query: "" });
      // The refusal names Agents, so that is where it lands.
      for (let i = 0; i < 40 && !document.getElementById("settings-agents"); i += 1) await new Promise((r) => setTimeout(r, 50));
      const box = document.getElementById("settings-agents");
      if (box) box.scrollIntoView({ block: "start", behavior: motionOff() ? "auto" : "smooth" });
    } };
  }
  return null;
}

/** Project settings, scrolled to the section a refusal named, with its first field ready. */
async function openProjectSettingsAt(projectId, anchor) {
  if (openSheet) await openSheet.close();
  await goTo({ projectId, view: "project", query: "" });
  const box = document.getElementById(anchor);
  if (!box) return;
  box.scrollIntoView({ block: "start", behavior: motionOff() ? "auto" : "smooth" });
  const field = box.querySelector("input");
  if (field) field.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Rows

function runningRow(run) {
  const row = el("div", { className: "run" });
  row.dataset.row = `run-${run.id}`;
  const s = el("div", { className: "s" }, projectDot(run.project_id),
    el("span", { textContent: run.project_name || "" }), el("span", { className: "who", textContent: runWho(run) }));
  if (run.workbench && run.workbench.branch) s.append(el("span", { className: "wbn", textContent: run.workbench.branch, title: run.workbench.path || "" }));
  const main = el("div", { style: "min-width:0" }, runTitle(run), s);
  if (run.last_activity) main.append(el("div", { className: "last", textContent: run.last_activity, title: run.last_activity }));
  const since = run.started_at || run.created_at;
  const cost = runCost(run);
  const nums = el("div", { className: "nums" }, runStateChip(run), el("br"),
    withData(el("b", { textContent: spanWords(TIME.secondsSince(since)) }), { since }), ` since ${clockWords(since)}`);
  if (cost) nums.append(el("br"), el("span", { className: "c", textContent: `${cost} so far` }));
  const sheet = el("button", { className: "btn", type: "button" }, homeIcon("open"), "Sheet");
  sheet.onclick = () => openRunSheet(run);
  row.append(agentAvatar(run.harness, run.harness_label), main, nums, el("div", { className: "acts" }, sheet, stopButton(run)));
  return row;
}

function queuedRow(run, index = 0, queue = []) {
  const row = withData(el("div", { className: "run two" }), { row: `run-${run.id}` });
  const s = el("div", { className: "s" }, projectDot(run.project_id), el("span", { textContent: run.project_name || "" }),
    runStateChip(run), el("span", { textContent: whyQueued(run) }));
  const remove = withData(el("button", { className: "ts-linkbtn", type: "button", textContent: "Remove", title: "Take it out of the queue. Nothing has run." }), { act: "remove" });
  remove.onclick = () => runAct(() => window.delphi.runs.stop(run.id));
  const acts = el("div", { className: "acts" });
  const lead = [agentAvatar(run.harness, run.harness_label)];
  if (reorderOn() && queue.length > 1) {
    // First to run first. The whole order goes to the dispatcher, so what the
    // list shows and what it starts next cannot drift apart.
    const ids = queue.map((r) => r.id);
    const up = withData(el("button", { className: "ts-linkbtn", type: "button", textContent: "Move up", disabled: index === 0 }), { act: "up" });
    up.onclick = () => {
      if (index === 0) return;
      const next = [...ids];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      reorderQueue(next);
    };
    acts.append(up);
    row.draggable = true;
    row.title = "Drag to change the order";
    row.ondragstart = (e) => { queueDragId = run.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(run.id)); row.classList.add("dragging"); };
    row.ondragend = () => { queueDragId = null; row.classList.remove("dragging"); for (const n of document.querySelectorAll(".run.drop-above")) n.classList.remove("drop-above"); };
    row.ondragover = (e) => { if (queueDragId == null || queueDragId === run.id) return; e.preventDefault(); row.classList.add("drop-above"); };
    row.ondragleave = () => row.classList.remove("drop-above");
    row.ondrop = (e) => {
      e.preventDefault();
      row.classList.remove("drop-above");
      const moving = queueDragId;
      queueDragId = null;
      if (moving == null || moving === run.id) return;
      const next = ids.filter((id) => id !== moving);
      next.splice(next.indexOf(run.id), 0, moving);
      reorderQueue(next);
    };
  }
  acts.append(remove);
  row.append(...lead, el("div", { style: "min-width:0" }, runTitle(run), s), acts);
  return row;
}

function finishedRow(run) {
  const row = el("div", { className: "run two" });
  row.dataset.row = `run-${run.id}`;
  const rejected = run.approval === "rejected";
  const res = run.state === "done" ? ["ok", "done"] : run.state === "failed" ? ["fail", "failed"] : ["stopped", rejected ? "rejected" : "stopped"];
  const s = el("div", { className: "s wrap" }, el("span", { className: `res ${res[0]}`, textContent: res[1] }),
    el("span", { className: "who", textContent: runWho(run) }));
  const began = TIME.parseStamp(run.started_at);
  const ended = TIME.parseStamp(run.finished_at);
  const when = clockWords(run.finished_at);
  if (began && ended) s.append(el("span", { textContent: `${when}, took ${spanWords((ended - began) / 1000)}` }));
  else if (when) s.append(el("span", { textContent: when }));
  const cost = runCost(run);
  if (cost) s.append(el("span", { textContent: cost }));
  const main = el("div", { style: "min-width:0" }, runTitle(run), s);
  if (run.reply) main.append(el("div", { className: "result", textContent: firstLineOf(run.reply, 240), title: run.reply }));

  const acts = el("div", { className: "acts" });
  if (run.state === "failed") {
    const fix = settingFix(run.reply, run.project_id);
    if (fix) {
      const b = el("button", { className: "ts-linkbtn", type: "button", textContent: fix.label });
      b.onclick = fix.go;
      acts.append(b);
    }
    // The dispatcher's own way to carry on: a reply queues the job again,
    // resuming the agent's session when it has one.
    const retry = el("button", { className: "ts-linkbtn", type: "button", textContent: "Retry" });
    retry.onclick = () => runAct(() => window.delphi.runs.reply(run.id, "Try again from where you stopped."));
    acts.append(retry);
  }
  if (run.review) {
    const sent = run.review === "sent_back";
    main.append(el("div", { className: "review-say" }, el("b", { textContent: sent ? "Sent back" : "Accepted" }),
      ` by ${run.reviewed_by || "you"}${run.review_note ? `: ${firstLineOf(run.review_note, 160)}` : "."}`));
  }
  if (run.needs_review && reviewOn()) {
    // Done means the agent stopped, not that anyone has read what it did.
    const review = withData(el("button", { className: "btn", type: "button", textContent: "Review" }), { act: "review" });
    review.onclick = () => reviewRunDialog(run);
    acts.append(review);
  }
  const open = withData(el("button", { className: "ts-linkbtn", type: "button", textContent: "Sheet" }), { act: "sheet" });
  open.disabled = !run.task_id;
  open.onclick = () => openRunSheet(run);
  acts.append(open);
  row.append(agentAvatar(run.harness, run.harness_label), main, acts);
  return row;
}

/** The context an agent attached, as one readable line, whatever shape it came in. */
function contextWords(context) {
  if (context == null) return "";
  if (typeof context === "string") return context;
  for (const key of ["why", "reason", "summary", "note"]) if (typeof context[key] === "string") return context[key];
  return "";
}

function waitingSide(run, buttons) {
  const since = run.updated_at || run.created_at;
  return el("div", { className: "side" },
    withData(el("div", { className: "when", textContent: `waiting ${spanWords(TIME.secondsSince(since))}` }), { waiting: since }),
    el("div", { className: "acts" }, buttons));
}

function approvalRow(run) {
  const row = el("div", { className: "wr approve" });
  row.dataset.row = `run-${run.id}`;
  const label = run.harness_label || run.harness;
  const t = el("div", { className: "t" }, el("b", { textContent: label }),
    run.kind === "do" ? " wants to change code for " : " wants to look into ");
  if (run.task_id) t.append(el("b", { textContent: `#${run.task_id}` }), ` ${run.task_title || ""}`);
  else t.append(`project ${run.project_name || ""}`);
  const main = el("div", { style: "min-width:0" }, el("span", { className: "k", textContent: "Approval" }), t,
    el("div", { className: "cmd", textContent: run.request || "" }));
  const why = contextWords(run.context);
  if (why) main.append(el("div", { className: "why", textContent: why }));
  const s = el("div", { className: "s" }, projectDot(run.project_id), el("span", { textContent: run.project_name || "" }));
  if (run.requested_by) s.append(el("span", { className: "who", textContent: `asked by ${run.requested_by}` }));
  s.append(el("span", { textContent: run.kind === "do" ? "in its own Workbench" : "read only, in the project's folder" }));
  main.append(s);

  // Reject asks why, inline, so the reason goes on the Sheet with the
  // refusal. Empty is allowed: a reason is a courtesy, not a gate.
  const reasonKey = `reject-${run.id}`;
  const rejecting = runDrafts.has(reasonKey);
  if (rejecting) {
    const field = withData(el("input", { className: "field", placeholder: "Why not? Optional. It goes on the Sheet.", value: runDrafts.get(reasonKey) || "" }), { keep: reasonKey });
    field.oninput = () => runDrafts.set(reasonKey, field.value);
    const send = withData(el("button", { className: "btn no", type: "button", textContent: "Reject", disabled: runSending.has(reasonKey) }), { act: "send-reject" });
    const go = () => {
      const why = field.value.trim();
      send.disabled = true;
      sendDraft(reasonKey, () => window.delphi.runs.reject(run.id, why || null));
    };
    send.onclick = go;
    field.onkeydown = (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); go(); }
      if (e.key === "Escape") { e.stopPropagation(); runDrafts.delete(reasonKey); runRefused.delete(reasonKey); repaintKeepingFocus(); }
    };
    main.append(el("div", { className: "reject-why" }, field, send), refusedLine(reasonKey));
    requestAnimationFrame(() => { if (field.isConnected && !document.activeElement?.dataset?.keep) field.focus(); });
  }

  const approveKey = `approve-${run.id}`;
  const approve = withData(el("button", { className: "btn ok", type: "button", textContent: "Approve", disabled: runSending.has(approveKey) }), { act: "approve" });
  // The agent as this row showed it: a harness edited between the look and
  // the click is refused rather than approved unseen. Sent once the run
  // carries it; until then the dispatcher compares at spawn as before.
  const seen = run.harness_hash_now || null;
  approve.onclick = () => { approve.disabled = true; sendDraft(approveKey, () => window.delphi.runs.approve(run.id, seen ? { harnessHash: seen } : {})); };
  if (runRefused.has(approveKey)) main.append(refusedLine(approveKey));
  const reject = withData(el("button", { className: "btn no", type: "button", textContent: rejecting ? "Cancel" : "Reject" }), { act: "reject" });
  reject.onclick = () => {
    if (rejecting) runDrafts.delete(reasonKey); else runDrafts.set(reasonKey, "");
    repaintKeepingFocus();
  };
  const buttons = [approve, reject];
  if (run.task_id) {
    const sheet = el("button", { className: "btn", type: "button", textContent: "Open Sheet" });
    sheet.onclick = () => openRunSheet(run);
    buttons.push(sheet);
  }
  row.append(agentAvatar(run.harness, label), main, waitingSide(run, buttons));
  return row;
}

/**
 * The question a waiting run's agent asked: the newest unanswered ask on its
 * task's Sheet, by the job's own actor. Cached by the run's updated_at, so the
 * Sheet is read again only when the run itself has moved.
 */
const askCache = new Map();
async function askFor(run) {
  const key = `${run.id}:${run.updated_at}`;
  const hit = askCache.get(run.id);
  if (hit && hit.key === key) return hit.ask;
  if (!run.task_id) return null;
  let ask = null;
  try {
    const read = await window.delphi.sheets.read(run.task_id, { mode: "tail", n: 80 });
    const entries = (read && read.entries) || [];
    const answered = new Set(entries.filter((e) => e.kind === "decide" && e.ref_id).map((e) => e.ref_id));
    ask = [...entries].reverse().find((e) => e.kind === "ask" && !answered.has(e.id) && (!run.actor || e.author === run.actor)) || null;
  } catch { ask = null; }
  askCache.set(run.id, { key, ask });
  return ask;
}

function questionRow(run) {
  const row = el("div", { className: "wr question" });
  row.dataset.row = `run-${run.id}`;
  const cached = askCache.get(run.id);
  const fresh = cached && cached.key === `${run.id}:${run.updated_at}`;
  const ask = fresh ? cached.ask : null;
  if (!fresh) {
    // Drawn with what the run already says, then again once the Sheet has
    // answered, in place, so the rest of the page is not repainted for it.
    askFor(run).then(() => { if (row.isConnected) row.replaceWith(questionRow(run)); });
  }

  const t = el("div", { className: "t" });
  if (run.task_id) t.append(el("b", { textContent: `#${run.task_id}` }), " ");
  t.append(ask ? ask.body : (run.reply ? firstLineOf(run.reply, 400) : `${run.harness_label} is waiting for an answer on the Sheet.`));
  const main = el("div", { style: "min-width:0" }, el("span", { className: "k", textContent: "Question" }), t);

  const options = ask && ask.meta && Array.isArray(ask.meta.options) ? ask.meta.options : [];
  if (isAnswered(run)) {
    main.append(el("div", { className: "why", textContent: "Answered. The run carries on the next time Delphi checks, within a minute." }));
    row.append(agentAvatar(run.harness, run.harness_label), main, waitingSide(run, []));
    return row;
  }
  if (options.length) {
    const opts = el("div", { className: "opts" });
    for (const o of options) {
      const b = el("button", { className: "ts-opt", type: "button" },
        el("span", { className: "ts-opt-key", textContent: String(o.key) }), String(o.label || o.text || o.key));
      b.onclick = () => {
        for (const x of opts.querySelectorAll("button")) x.disabled = true;
        // Answering on the Sheet is what resumes the job: the dispatcher sees
        // the decision against its agent's question and queues the next turn.
        runAct(async () => {
          await window.delphi.sheets.decide(ask.id, o.key, null);
          answeredRuns.set(run.id, run.updated_at);
          paintRunsLive();
        });
      };
      opts.append(b);
    }
    main.append(opts);
  }

  const replyKey = `reply-${run.id}`;
  const field = withData(el("input", {
    className: "field",
    placeholder: options.length ? "Or reply in your own words. It goes on the Sheet and the run carries on." : "Reply in your own words. It goes on the Sheet and the run carries on.",
    value: runDrafts.get(replyKey) || "",
  }), { keep: replyKey });
  field.oninput = () => runDrafts.set(replyKey, field.value);
  const send = withData(el("button", { className: "btn", type: "button", textContent: "Reply", disabled: runSending.has(replyKey) }), { act: "send-reply" });
  const go = () => {
    const text = field.value.trim();
    if (!text) { field.focus(); return; }
    send.disabled = true;
    sendDraft(replyKey, () => window.delphi.runs.reply(run.id, text));
  };
  send.onclick = go;
  field.onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); go(); } };
  main.append(el("div", { className: "reply" }, field, send), refusedLine(replyKey));

  const s = el("div", { className: "s" }, projectDot(run.project_id), el("span", { textContent: run.project_name || "" }),
    el("span", { className: "who", textContent: runWho(run) }));
  const asked = (ask && ask.created_at) || run.finished_at || run.updated_at;
  if (asked) s.append(el("span", { textContent: `asked at ${clockWords(asked)}` }));
  main.append(s);

  const buttons = [];
  if (run.task_id) {
    const sheet = el("button", { className: "btn", type: "button", textContent: "Open Sheet" });
    sheet.onclick = () => openRunSheet(run);
    buttons.push(sheet);
  }
  row.append(agentAvatar(run.harness, run.harness_label), main, waitingSide(run, buttons));
  return row;
}

const waitingRow = (run) => (run.state === "needs_approval" ? approvalRow(run) : questionRow(run));

/** Oldest first: whoever has been waiting longest is answered first. */
const byWaitAge = (a, b) => String(a.updated_at || a.created_at).localeCompare(String(b.updated_at || b.created_at));

// ---------------------------------------------------------------------------
// The two pages

function section(title, count, hint, ...nodes) {
  const head = el("div", { className: "sec-h" }, el("h2", { textContent: title }));
  if (count != null) head.append(el("span", { className: "ts-count", textContent: String(count) }));
  head.append(el("span", { className: "grow" }));
  if (hint) head.append(typeof hint === "string" ? el("span", { className: "hint", textContent: hint }) : hint);
  return el("div", { className: "sec" }, head, ...nodes);
}

const isToday = (stamp) => TIME.dayOf(stamp) === today();

function renderRuns(root) {
  const page = el("div", { className: "home-page" });
  page.append(slotsBar());

  const running = runsIn(["running"]);
  const queued = runsIn(["queued"]).sort(byQueueOrder);
  const waiting = waitingRuns().sort(byWaitAge);
  const finishedAll = runsIn(["done", "failed", "stopped"]);
  const finished = state.runsEarlier ? finishedAll : finishedAll.filter((r) => isToday(r.finished_at || r.updated_at));

  const box = (rows, empty) => el("div", { className: "box" }, rows.length ? rows : el("div", { className: "empty-line", textContent: empty }));

  const left = el("div");
  left.append(section("Running", running.length, "each in its own Workbench",
    box(running.map(runningRow), "Nothing is running. Hand a task to an agent from its panel, or approve one waiting on you.")));
  if (queued.length) {
    const hint = reorderOn() && queued.length > 1 ? "start in this order as slots free; drag to change it" : "start in this order as slots free";
    left.append(section("Queued", queued.length, hint, box(queued.map((r, i) => queuedRow(r, i, queued)), "")));
  }
  const earlier = el("button", { className: "ts-linkbtn", type: "button", textContent: state.runsEarlier ? "Today only" : "Earlier" });
  earlier.onclick = () => { state.runsEarlier = !state.runsEarlier; render(); };
  left.append(section(state.runsEarlier ? "Finished" : "Finished today", finished.length, earlier,
    box(finished.map(finishedRow), state.runsEarlier ? "Nothing has finished yet." : "Nothing has finished today.")));

  // Each agent's own unit, summed per agent and never across them.
  const totals = new Map();
  for (const r of [...running, ...finishedAll.filter((x) => isToday(x.finished_at || x.updated_at))]) {
    const t = totals.get(r.harness) || { label: r.harness_label || r.harness, usd: 0, tokens: 0 };
    if (r.cost_usd) t.usd += r.cost_usd;
    else t.tokens += (r.tokens_in || 0) + (r.tokens_out || 0);
    totals.set(r.harness, t);
  }
  const spent = [...totals.values()].filter((t) => t.usd || t.tokens);
  if (spent.length) {
    const note = el("div", { className: "rule-note" }, "Today so far: ");
    spent.forEach((t, i) => note.append(i ? ", " : "", el("b", { textContent: `${t.label} ${t.usd ? `$${t.usd.toFixed(2)}` : `${compactNumber(t.tokens)} tokens`}` })));
    note.append(". Each agent reports its own unit, so they are not added together.");
    left.lastChild.append(note);
  }

  const right = el("div", { className: "waiting-col" });
  right.append(section("Waiting on you", waiting.length, "paused until you answer",
    box(waiting.map(waitingRow), "Nothing is waiting on you.")));
  if (window.DelphiLedger) right.append(DelphiLedger.runsCard());

  page.append(el("div", { className: "runs-cols" }, left, right));
  root.append(page);
}

function renderInbox(root) {
  const page = el("div", { className: "home-page narrow" });
  const all = waitingRuns().sort(byWaitAge);
  const approvals = all.filter((r) => r.state === "needs_approval");
  const questions = all.filter((r) => r.state === "waiting_on_human");
  const reviews = reviewRuns().sort((a, b) => String(a.finished_at || a.updated_at).localeCompare(String(b.finished_at || b.updated_at)));
  const flags = flagRowsNow();
  // The folder questions (ui/needs.js) sit above everything else under All.
  const folderQs = window.DelphiNeeds ? DelphiNeeds.count() : 0;
  const total = all.length + reviews.length + flags.length + folderQs;

  const group = el("div", { className: "seg-sm", role: "group" });
  for (const [key, label] of [["urgency", "By urgency"], ["project", "By project"]]) {
    const b = el("button", { type: "button", textContent: label });
    b.setAttribute("aria-pressed", String(state.inboxGroup === key));
    b.dataset.act = `group-${key}`;
    b.onclick = () => { state.inboxGroup = key; render(); };
    group.append(b);
  }
  const filters = [
    ["all", "All", total, ""],
    ["proposals", "Proposals", flags.length, "proposal"],
    ["approvals", "Approvals", approvals.length, "approve"],
    ["questions", "Questions", questions.length, "question"],
    ...(reviewOn() ? [["reviews", "Reviews", reviews.length, "review"]] : []),
  ];
  if (!filters.some(([key]) => key === state.inboxFilter)) state.inboxFilter = "all";
  const chips = el("div", { className: "chips" });
  for (const [key, label, n, cls] of filters) {
    const b = el("button", { className: `chipf ${cls}`.trim(), type: "button" });
    b.setAttribute("aria-pressed", String(state.inboxFilter === key));
    b.dataset.act = `filter-${key}`;
    if (cls) b.append(el("span", { className: "sw" }));
    b.append(`${label} `, el("b", { textContent: String(n) }));
    b.onclick = () => { state.inboxFilter = key; render(); };
    chips.append(b);
  }
  chips.append(el("span", { className: "grow" }), group);
  page.append(chips);

  const f = state.inboxFilter;
  const runsShown = f === "approvals" ? approvals : f === "questions" ? questions : f === "all" ? all : [];
  const reviewsShown = f === "all" || f === "reviews" ? reviews : [];
  const flagsShown = f === "all" || f === "proposals" ? flags : [];
  const shownCount = runsShown.length + reviewsShown.length + flagsShown.length;
  if (f === "all" && folderQs) DelphiNeeds.mount(page);

  if (!shownCount && !(f === "all" && folderQs)) {
    page.append(emptyState(total ? "Nothing of this kind" : "Nothing needs you",
      "When an agent asks to start work or asks a question, when a run finishes and wants a look, or when someone flags an item as filed in the wrong place, it waits here until you answer."));
  } else {
    const box = el("div", { className: "box" });
    if (state.inboxGroup === "project") {
      // One list of everything, keyed by project, whichever kind it is.
      const byProject = new Map();
      const add = (pid, name, node) => {
        if (!byProject.has(pid)) byProject.set(pid, { name, nodes: [] });
        byProject.get(pid).nodes.push(node);
      };
      for (const r of runsShown) add(r.project_id, r.project_name, () => waitingRow(r));
      for (const r of reviewsShown) add(r.project_id, r.project_name, () => reviewRow(r));
      for (const row of flagsShown) add(row.project_id, projectNameOf(row.project_id, "No project"), () => flagNode(row));
      for (const [, g] of byProject) {
        box.append(el("div", { className: "sub-h" }, g.name || "No project", el("span", { className: "r", textContent: plural(g.nodes.length, "waiting", "waiting") })));
        g.nodes.forEach((make) => box.append(make()));
      }
    } else {
      if (runsShown.length) {
        box.append(el("div", { className: "sub-h" }, "Agents are paused on these", el("span", { className: "r", textContent: "longest waiting first" })));
        runsShown.forEach((r) => box.append(waitingRow(r)));
      }
      if (reviewsShown.length) {
        box.append(el("div", { className: "sub-h" }, "Ready for your review", el("span", { className: "r", textContent: "oldest first" })));
        reviewsShown.forEach((r) => box.append(reviewRow(r)));
      }
      const singles = flagsShown.filter((r) => !r.group);
      const groups = flagsShown.filter((r) => r.group);
      if (singles.length) {
        box.append(withData(el("div", { className: "sub-h" }, "Proposals", el("span", { className: "r", textContent: "from things you and agents flagged" })), { section: "proposals" }));
        singles.forEach((row) => box.append(flagNode(row)));
      }
      if (groups.length) {
        box.append(el("div", { className: "sub-h" }, "Found by the sweep", el("span", { className: "r", textContent: "grouped by where they would go" })));
        groups.forEach((row) => box.append(flagNode(row)));
      }
    }
    if (box.childNodes.length) page.append(box);
  }
  page.append(el("div", { className: "rule-note" },
    el("b", { textContent: "What is here: " }), "things an agent is blocked on you for, finished runs nobody has reviewed, and proposals about where an item belongs. Your own tasks are in All work. ",
    el("b", { textContent: "What leaves: " }), "answering, approving, rejecting or reviewing clears it everywhere at once."));
  root.append(page);
}

/** The title bar's line: how many agents are working and how many things wait on you. */
function paintTitleLive() {
  const box = $("tb-live");
  if (!box) return;
  const running = runsIn(["running"]).length;
  const waiting = needsYouCount();
  box.textContent = "";
  box.hidden = !running && !waiting;
  if (box.hidden) return;
  if (running) box.append(el("span", { className: "live-dot" }), el("b", { textContent: String(running) }), running === 1 ? " agent working" : " agents working");
  if (waiting) box.append(el("span", { className: "tbask", textContent: `${waiting} waiting on you` }));
  box.title = waiting ? "Open Needs you" : "Open Runs";
  box.onclick = () => goTo({ projectId: null, view: waiting ? "inbox" : "runs", query: "" });
}

// ---------------------------------------------------------------------------
// Hand to agent, from a task

/**
 * A small composer: which agent, ask or do, and what for. Resolves to the new
 * run, or null. A refusal is shown as the dispatcher wrote it, word for word,
 * with a button to the setting it names when it names one, and the dialog
 * stays open so the request is not lost.
 */
async function handToAgent(detail) {
  if (!state.harnesses.length) {
    try { state.harnesses = await window.delphi.harnesses.list(); } catch {}
  }
  const agents = enabledAgents();
  const projectId = detail.project ? detail.project.id : detail.task.project_id;
  return new Promise((resolve) => {
    const overlay = el("div", { className: "overlay" });
    const box = el("div", { className: "ask wb-dialog hand-dialog", role: "dialog" });
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Hand to an agent");
    const me = { box };
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      const at = dialogStack.indexOf(me);
      if (at >= 0) dialogStack.splice(at, 1);
      overlay.remove();
      resolve(value);
    };

    const picker = el("select", { className: "field", id: "hand-agent" });
    for (const h of agents) {
      const o = el("option", { value: h.key, textContent: h.ready === false ? `${h.label} (${h.detail || "not installed"})` : h.label });
      picker.append(o);
    }
    const last = state.lastHandAgent && agents.some((h) => h.key === state.lastHandAgent) ? state.lastHandAgent : null;
    if (last) picker.value = last;

    let kind = state.lastHandKind === "do" ? "do" : "ask";
    const kindSay = el("div", { className: "kind-say" });
    const seg = el("div", { className: "seg-sm", role: "group" });
    const paintKind = () => {
      for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.kind === kind));
      kindSay.textContent = kind === "do"
        ? "Changes code in this task's own Workbench, a separate folder and branch. Nothing is merged or pushed without you."
        : "Reads the project and answers on this task's Sheet. Changes nothing.";
    };
    for (const [key, label] of [["ask", "Ask"], ["do", "Do"]]) {
      const b = withData(el("button", { type: "button", textContent: label }), { kind: key });
      b.onclick = () => { kind = key; paintKind(); };
      seg.append(b);
    }
    paintKind();

    const request = el("textarea", { className: "field", id: "hand-request", placeholder: "What should it do? It also reads this task and its Sheet." });
    const refusal = el("div", { className: "refusal", role: "alert" });
    refusal.hidden = true;

    const cancel = el("button", { className: "btn", type: "button", textContent: "Cancel" });
    const go = el("button", { className: "btn primary", type: "button", textContent: "Hand it over" });
    cancel.onclick = () => finish(null);
    const submit = async () => {
      if (go.disabled) return;
      if (!agents.length) return;
      go.disabled = true;
      refusal.hidden = true;
      try {
        const run = await window.delphi.runs.create({ projectId, harness: picker.value, request: request.value, taskId: detail.task.id, kind });
        state.lastHandAgent = picker.value;
        state.lastHandKind = kind;
        finish(run);
      } catch (error) {
        go.disabled = false;
        refusal.textContent = "";
        const words = String(error && error.message ? error.message : error);
        refusal.append(el("div", { textContent: words }));
        const fix = settingFix(words, projectId);
        if (fix) {
          const b = el("button", { className: "btn sm", type: "button", textContent: fix.label });
          b.onclick = async () => { finish(null); await fix.go(); };
          refusal.append(b);
        }
        refusal.hidden = false;
      }
    };
    go.onclick = submit;
    const onKey = (e) => {
      if (dialogStack[dialogStack.length - 1] !== me) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); submit(); }
    };
    dialogStack.push(me);
    document.addEventListener("keydown", onKey, true);

    box.append(el("h3", { textContent: "Hand to an agent" }),
      el("p", { className: "wb-lead", textContent: `#${detail.task.id} ${detail.task.title}` }));
    if (!agents.length) {
      box.append(el("div", { className: "refusal" }, el("div", { textContent: "No agent is turned on here. Turn one on in Settings, under Agents." })));
      go.disabled = true;
    } else {
      box.append(el("label", { className: "lab", htmlFor: "hand-agent", textContent: "Agent" }), picker,
        el("label", { className: "lab", textContent: "Kind" }), seg, kindSay,
        el("label", { className: "lab", htmlFor: "hand-request", textContent: "Request" }), request);
    }
    box.append(refusal, el("div", { className: "ask-actions" }, el("span", { className: "hint", textContent: "Command + Enter to hand it over" }),
      el("div", { style: "display:flex; gap:8px" }, cancel, go)));
    box.querySelector(".ask-actions").style.justifyContent = "space-between";
    overlay.append(box);
    overlay.onclick = (e) => { if (e.target === overlay) finish(null); };
    document.body.append(overlay);
    (agents.length ? request : cancel).focus();
  });
}

// ---------------------------------------------------------------------------
// Items across projects
//
// Move, copy, also belongs to, and flag for review, on every note, task, pad
// and link. items/store.js owns every rule. This side asks it for a plan
// before anything is pressed and shows the plan's own sentences, refusals
// word for word, so the window never decides by itself what a move would do:
// two sets of rules about where a task's subtasks go would disagree within a
// month, and the disagreement would surface as a task in the wrong project.
// ---------------------------------------------------------------------------

const ITEM_NOUN = { task: "task", note: "note", scratchpad: "pad", link: "link", organizer: "epic", session: "session" };
const ITEM_TAB = { task: "tasks", note: "notes", scratchpad: "pads", link: "links" };

// Fixed markup only, never anything from the database.
const ITEM_ICONS = {
  move: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  out: '<path d="M15 12H4M8 8l-4 4 4 4"/><path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/>',
};
function itemIcon(name) {
  const holder = document.createElement("span");
  holder.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ITEM_ICONS[name]}</svg>`;
  return holder.firstChild;
}

const projectById = (id) => (id == null ? null : state.projects.find((p) => p.id === Number(id)) || null);
const projectNameOf = (id, fallback = null) => {
  const p = projectById(id);
  if (p) return p.name;
  if (fallback) return fallback;
  return id == null ? "no project" : `project ${id}`;
};
const projectColourOf = (id) => (projectById(id) || {}).colour || "var(--ink-faint)";
const dotFor = (id, colour = null) => el("span", { className: "dot", style: `background:${safeColour(colour || projectColourOf(id))}` });
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * One shape for anything the Item menu acts on, from whichever row it was
 * drawn from. associated is true only when the row was shown in a project
 * that is not its home, which is what the "from" mark and "Stop showing
 * here" both hang off.
 */
function itemOf(entity, row) {
  const homeId = row.project_id == null ? null : Number(row.project_id);
  return {
    entity,
    id: Number(row.id),
    label: (entity === "link" ? row.label : row.title) || `${ITEM_NOUN[entity]} ${row.id}`,
    kind: entity === "note" ? row.kind || "note" : null,
    homeId,
    homeName: row.home_name || row.project_name || projectNameOf(homeId),
    homeColour: row.home_colour || row.project_colour || null,
    associated: Boolean(Number(row.associated || 0)),
    parentId: row.parent_id == null ? null : Number(row.parent_id),
  };
}

// A refusal from the store carries its sentences; anything else is an error.
function notifyRefusal(error) {
  const list = error && error.code === "REFUSED" && error.details && Array.isArray(error.details.refusals) ? error.details.refusals : null;
  if (list && list.length) notify(list.join(" "), { error: true });
  else notifyError(error);
}

/** A toast with one button in it: Undo, or the way to where the result went. */
function notifyAction(text, label, run) {
  notify(text);
  const toast = document.querySelector(".wb-toast");
  if (!toast || !label) return;
  const b = el("button", { className: "ts-linkbtn toast-act", type: "button", textContent: label });
  b.style.marginLeft = "10px";
  b.style.fontSize = "12.5px";
  b.style.fontWeight = "600";
  b.onclick = async (e) => { e.stopPropagation(); toast.remove(); await run(); };
  toast.append(b);
}

/**
 * Says what changed, with Undo. Undo walks the audit rows backwards, so a
 * move followed by an association comes apart in the order it went together,
 * and the store refuses rather than guesses when something has moved since.
 */
function notifyUndo(text, auditIds, after = null) {
  const ids = (auditIds || []).filter((id) => id != null);
  notifyAction(text, ids.length ? "Undo" : null, async () => {
    try {
      for (const id of [...ids].reverse()) await window.delphi.audit.undo(id);
      notify("Undone.");
    } catch (error) {
      notifyError(error);
    }
    await refresh();
    reloadFlags();
    if (after) await after();
  });
}

/**
 * A dialog shell: an overlay, a box, Escape to close, and a place on the
 * dialog stack so only the top one answers a key. The picker and the Flag
 * dialog lay themselves out; wbDialog's fixed title, body and buttons would
 * not hold either.
 */
function openModal({ className, label, onKey = null }) {
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  const overlay = el("div", { className: "overlay" });
  const box = el("div", { className: `ask ${className}`, role: "dialog" });
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", label);
  const returnTo = document.activeElement;
  const me = { box };
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    document.removeEventListener("keydown", key, true);
    const at = dialogStack.indexOf(me);
    if (at >= 0) dialogStack.splice(at, 1);
    overlay.remove();
    if (returnTo && returnTo.isConnected && typeof returnTo.focus === "function") returnTo.focus({ preventScroll: true });
    settle(value);
  };
  // Captured on the document, as askText does: the window's own handler
  // treats Escape as "hide the window".
  const key = (event) => {
    if (dialogStack[dialogStack.length - 1] !== me) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(null); return; }
    if (onKey) onKey(event);
  };
  dialogStack.push(me);
  document.addEventListener("keydown", key, true);
  overlay.append(box);
  overlay.onclick = (event) => { if (event.target === overlay) finish(null); };
  document.body.append(overlay);
  return { box, finish, promise };
}

// ---------------------------------------------------------------------------
// The Item menu

/** The ⋯ button that opens it, for a card head or a panel header. */
function itemMoreButton(item, opts = {}) {
  const b = el("button", { className: "more-btn", type: "button", textContent: "⋯", title: "Move, copy, flag or delete" });
  b.setAttribute("aria-label", `${capFirst(ITEM_NOUN[item.entity])} actions`);
  b.setAttribute("aria-haspopup", "menu");
  b.onclick = (e) => {
    e.stopPropagation();
    const box = b.getBoundingClientRect();
    b.setAttribute("aria-expanded", "true");
    itemMenu(item, box.right - 250, box.bottom + 4, { ...opts, onClose: () => b.setAttribute("aria-expanded", "false") });
  };
  return b;
}

/** The verbs a menu shows for an item, in the shape rowMenu takes. */
function itemVerbs(item, { after = null, withIcons = true } = {}) {
  const noun = ITEM_NOUN[item.entity];
  const verb = (icon, label, desc, run, cls = "") => {
    if (!withIcons) return { label, run, danger: cls === "danger" };
    const b = el("button", { className: `ctx-item ${cls}`.trim(), type: "button" },
      itemIcon(icon), el("span", { textContent: label }), desc ? el("span", { className: "d", textContent: desc }) : null);
    b.onclick = async () => { closeRowMenu(); await run(); };
    return { node: b };
  };
  const here = item.associated && state.projectId ? state.projectId : null;
  return [
    verb("move", "Move to…", "change its home", () => openItemPicker(item, "move", { after })),
    verb("copy", "Copy to…", `a separate ${noun}`, () => openItemPicker(item, "copy", { after })),
    verb("link", "Also belongs to…", "show it elsewhere", () => openItemPicker(item, "associate", { after })),
    ...(here ? [verb("out", `Stop showing in ${projectNameOf(here)}`, "it stays home", () => dissociateHere(item, here, after))] : []),
    "-",
    verb("flag", "Flag for review…", "ask, then decide", () => openFlagDialog(item, { after })),
  ];
}

/**
 * A menu a keyboard can drive: role menu with menuitems, focus moved into it,
 * arrows, Home and End to move, Escape to close and Tab to leave. Focus goes
 * back to whatever opened it, unless a verb has opened a dialog that took it.
 */
function menuKeys(menu, opener) {
  if (!menu) return;
  menu.setAttribute("role", "menu");
  const choices = [...menu.querySelectorAll(".ctx-item")];
  for (const c of choices) { c.setAttribute("role", "menuitem"); c.tabIndex = -1; }
  for (const h of menu.querySelectorAll(".ctx-head")) h.setAttribute("role", "presentation");
  for (const sep of menu.querySelectorAll(".ctx-sep")) sep.setAttribute("role", "separator");
  const back = () => { if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true }); };
  menu.addEventListener("keydown", (e) => {
    const at = choices.indexOf(document.activeElement);
    const go = (i) => { e.preventDefault(); choices[(i + choices.length) % choices.length].focus(); };
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeRowMenu(); back(); }
    else if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Tab") { closeRowMenu(); back(); }
  });
  if (choices.length) choices[0].focus({ preventScroll: true });
}

function itemMenu(item, x, y, { after = null, onClose = null, onDelete = null } = {}) {
  const opener = document.activeElement;
  const head = el("div", { className: "ctx-head", textContent: `${ITEM_NOUN[item.entity]} #${item.id}` });
  const del = el("button", { className: "ctx-item danger", type: "button" },
    itemIcon("trash"), el("span", { textContent: "Delete" }), el("span", { className: "d", textContent: "undo in History" }));
  del.onclick = async () => { closeRowMenu(); await deleteItem(item, { after, onDelete }); };
  menuKeys(rowMenu(x, y, [head, ...itemVerbs(item, { after }), "-", { node: del }], { className: "item-menu", onClose }), opener);
}

async function dissociateHere(item, projectId, after = null) {
  try {
    const r = await window.delphi.items.dissociate(item.entity, item.id, projectId);
    notifyUndo(`No longer shown in ${projectNameOf(projectId)}. It still lives in ${item.homeName}.`, [r && r.auditId], after);
  } catch (error) {
    notifyRefusal(error);
  }
  await refresh();
  if (after) await after();
}

/**
 * Deletes an item. Shown from another project, it is still one item, so
 * deleting it here deletes it in its home too; that is said first, with the
 * way to take it out of this project only.
 */
async function deleteItem(item, { after = null, onDelete = null } = {}) {
  const noun = ITEM_NOUN[item.entity];
  if (item.associated) {
    const ok = confirm(`This ${noun} lives in ${item.homeName}. Deleting it here deletes it there too.\n\nTo take it out of this project only, use "Stop showing in ${projectNameOf(state.projectId)}" instead.`);
    if (!ok) return;
  }
  try {
    if (item.entity === "task") await removeTask(item.id);
    else if (item.entity === "note") await window.delphi.notes.remove(item.id);
    else if (item.entity === "link") await window.delphi.links.remove(item.id);
    else if (item.entity === "scratchpad") {
      if (!item.associated && !confirm(`Delete "${item.label}"? The tasks it filed stay on the board.`)) return;
      await window.delphi.pads.remove(item.id);
      if (state.padId === item.id) { state.padId = null; state.padDraft = null; }
    }
  } catch (error) {
    notifyError(error);
    return;
  }
  if (onDelete) await onDelete();
  await refresh();
  if (after) await after();
  notify(`${capFirst(noun)} deleted. Restore it from History.`);
}

// ---------------------------------------------------------------------------
// The "from <home>" mark

function fromChip(item) {
  const b = el("button", { className: "from-tag", type: "button" },
    dotFor(item.homeId, item.homeColour), "from ", el("b", { textContent: item.homeName || "no project" }));
  b.title = `Lives in ${item.homeName}. Click for where else it is.`;
  b.onclick = (e) => {
    e.stopPropagation();
    const box = b.getBoundingClientRect();
    wherePopover(item, box.left, box.bottom + 4);
  };
  return b;
}

/** Opens an item where it lives: the task's panel, or its home project's tab with it lit. */
async function openItemHome(item, projectId = null) {
  closeRowMenu();
  if (item.entity === "task") { await openTaskSheet(item.id); return; }
  const pid = projectId != null ? projectId : item.homeId;
  if (pid == null) return;
  state.litItem = { entity: item.entity, id: item.id };
  if (item.entity === "scratchpad") state.padId = item.id;
  await goTo({ projectId: pid, view: ITEM_TAB[item.entity] || "overview", query: "" });
}

/** Where an item lives, everywhere else it shows, where it was copied from, its copies, and a live flag. */
async function wherePopover(item, x, y) {
  let w;
  try { w = await window.delphi.items.where(item.entity, item.id); } catch (error) { notifyError(error); return; }
  const line = (label, ...value) => el("div", { className: "wl" }, el("span", { textContent: label }), el("div", { className: "wv" }, ...value));
  const projectLink = (p) => {
    const b = el("button", { className: "ts-linkbtn", type: "button" }, dotFor(p.id, p.colour), ` ${p.name}`);
    b.onclick = () => { closeRowMenu(); goTo({ projectId: p.id, view: ITEM_TAB[item.entity] || "overview", query: "" }); };
    return b;
  };
  const copyLink = (c) => {
    const text = `${c.label || `${ITEM_NOUN[item.entity]} ${c.id}`}${c.project ? `, in ${c.project.name}` : ""}${c.exists === false ? " (deleted since)" : ""}`;
    if (c.exists === false) return el("span", { textContent: text });
    const b = el("button", { className: "ts-linkbtn", type: "button", textContent: text });
    b.onclick = () => openItemHome({ ...item, id: c.id, homeId: c.project ? c.project.id : null });
    return b;
  };
  const nodes = [line("Home", w.home ? projectLink(w.home) : el("span", { textContent: "no project" }))];
  nodes.push(line("Also in", ...(w.also && w.also.length ? w.also.map(projectLink) : [el("span", { textContent: "nowhere else" })])));
  if (w.copiedFrom) nodes.push(line("Copied from", copyLink(w.copiedFrom)));
  if (w.copies && w.copies.length) nodes.push(line("Copies", ...w.copies.map(copyLink)));
  if (w.flag) {
    const open = el("button", { className: "ts-linkbtn", type: "button", textContent: "Open in Needs you" });
    open.onclick = () => { closeRowMenu(); goTo({ projectId: null, view: "inbox", query: "" }); };
    nodes.push(line("Flag", el("span", { textContent: w.flag.proposal_summary || `${w.flag.status}: ${w.flag.note || "flagged for review"}` }), open));
  }
  rowMenu(x, y, nodes, { className: "where-pop" });
}

// ---------------------------------------------------------------------------
// The picker: Move to, Copy to, Also belongs to

/**
 * Where an item belongs. One list of projects with a Home column and an Also
 * in column, because a move and an association are the same question asked
 * of different columns. Every change is planned by the store first, and its
 * summary, notices and refusals are what the box under the list says.
 *
 * decide, when given, is a proposal being changed in Needs you: the ops go
 * to it instead of being applied here, so the flag records what was chosen.
 */
async function openItemPicker(item, mode = "move", { after = null, decide = null, preset = null } = {}) {
  let where;
  try { where = await window.delphi.items.where(item.entity, item.id); } catch (error) { notifyError(error); return; }
  const noun = ITEM_NOUN[item.entity];
  const home = where.home ? where.home.id : item.homeId;
  const homeName = where.home ? where.home.name : item.homeName;
  const also = new Set((where.also || []).map((p) => p.id));
  const associable = ["task", "note", "scratchpad", "link"].includes(item.entity);
  const st = {
    mode, target: null, query: "", alsoNext: new Set(also), keepHome: false,
    opts: { detach: false, pad: "keep", tasks: "follow", subtasks: true, ledger: true, derive: false },
    plans: [], seq: 0, busy: false, seenSubtasks: 0, seenPadTasks: 0, lockKeep: false,
  };
  if (preset && preset.length) {
    const first = preset[0];
    st.mode = first.op === "associate" || first.op === "dissociate" ? "associate" : first.op;
    if (first.op === "move" || first.op === "copy") st.target = first.to;
    for (const o of preset) {
      if (o.op === "move" && o.options && o.options.keepInSource) st.keepHome = true;
      if (o.op === "move" && o.options) Object.assign(st.opts, o.options);
      if (o.op === "associate") st.alsoNext.add(o.to);
      if (o.op === "dissociate") st.alsoNext.delete(o.to);
    }
  }

  const { box, finish } = openModal({
    className: "pk", label: `Where this ${noun} belongs`,
    onKey: (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); go(); }
    },
  });

  const seg = el("div", { className: "seg", role: "group" });
  seg.setAttribute("aria-label", "What to do with it");
  const modes = [["move", "Move to"], ["copy", "Copy to"], ...(associable ? [["associate", "Also belongs to"]] : [])];
  for (const [key, label] of modes) {
    const b = el("button", { type: "button", textContent: label });
    b.onclick = () => { if (st.mode === key) return; st.mode = key; if (key === "associate") st.target = null; paint(); replan(); };
    seg.append(b);
  }
  const sub = el("div", { className: "sub" });
  sub.append(el("span", { className: `kind sm ${item.kind || ""}`.trim(), textContent: item.kind || noun }), el("span", { textContent: item.label }));
  box.append(el("div", { className: "pk-head" },
    el("h3", { textContent: decide ? "Change the proposal" : `Where this ${noun} belongs` }), sub, seg));

  const search = el("input", { className: "field", type: "search", placeholder: "Find a project" });
  search.oninput = () => { st.query = search.value; paintList(); };
  search.onkeydown = (e) => {
    if (e.key !== "Enter" || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    const shown = visibleProjects();
    if (shown.length === 1) pick(shown[0].id);
  };
  box.append(el("div", { className: "pk-search" }, search));

  const colHome = el("span", { textContent: "Home" });
  const colAlso = el("span", { textContent: "Also in" });
  box.append(el("div", { className: "pk-cols" }, el("span", { textContent: "Project" }), colHome, colAlso));
  const list = el("div", { className: "pk-list", role: "listbox" });
  box.append(list);
  const optsBox = el("div", { className: "pk-opts" });
  const say = el("div", { className: "pk-say", role: "status" });
  box.append(optsBox, say);

  const ok = el("button", { className: "btn primary", type: "button" });
  const cancel = el("button", { className: "btn", type: "button", textContent: "Cancel" });
  cancel.onclick = () => finish(null);
  ok.onclick = () => go();
  box.append(el("div", { className: "pk-foot" },
    el("span", { className: "hint" }, el("span", { className: "kbd", textContent: "Esc" }), "cancel"),
    el("span", { className: "grow" }), cancel, ok));

  const visibleProjects = () => {
    const q = st.query.trim().toLowerCase();
    return state.projects.filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.key || "").toLowerCase().includes(q));
  };
  const countWord = (p) => {
    if (p.id === home) return "current home";
    if (item.entity === "note" && p.note_count) return plural(p.note_count, "note", "notes");
    if (item.entity === "task" && p.open_count) return `${p.open_count} open`;
    return "";
  };
  const pick = (pid) => {
    if (st.mode === "associate") return;
    if (st.mode === "move" && pid === home) return;
    st.target = pid;
    // Moving into a project it was shown in makes that its home, so the
    // association goes rather than being kept beside the home.
    paint();
    replan();
  };
  const toggleAlso = (pid, on) => {
    if (st.mode === "move" && pid === home) st.keepHome = on;
    else if (on) st.alsoNext.add(pid);
    else st.alsoNext.delete(pid);
    paint();
    replan();
  };

  function paintList() {
    list.textContent = "";
    const shown = visibleProjects();
    if (!shown.length) { list.append(el("div", { className: "empty-line", textContent: "No project matches." })); return; }
    for (const p of shown) {
      const row = el("div", { className: "pk-row" + ((st.mode !== "associate" && p.id === st.target) ? " sel" : ""), role: "option" });
      const nm = el("div", { className: "nm" }, dotFor(p.id, p.colour), el("span", { textContent: p.name }));
      const small = countWord(p);
      if (small) nm.append(el("small", { textContent: small }));
      const radio = el("input", { type: "radio", name: "pk-home" });
      radio.setAttribute("aria-label", `Make ${p.name} its home`);
      const box2 = el("input", { type: "checkbox" });
      box2.setAttribute("aria-label", `Also show it in ${p.name}`);
      if (st.mode === "associate") {
        radio.checked = p.id === home;
        radio.disabled = true;
        radio.style.visibility = "hidden";
        box2.checked = p.id === home || st.alsoNext.has(p.id);
        box2.disabled = p.id === home;
      } else if (st.mode === "copy") {
        radio.checked = p.id === st.target;
        box2.style.visibility = "hidden";
      } else {
        radio.checked = p.id === st.target;
        radio.disabled = p.id === home;
        box2.checked = p.id === home ? st.keepHome || st.lockKeep : st.alsoNext.has(p.id) && p.id !== st.target;
        box2.disabled = !associable || p.id === st.target || (p.id === home && (st.lockKeep || st.target == null));
        if (p.id === home && st.lockKeep) box2.title = "Its Workbench keeps it shown here";
      }
      radio.onchange = () => pick(p.id);
      box2.onchange = () => toggleAlso(p.id, box2.checked);
      row.onclick = (e) => {
        if (e.target === radio || e.target === box2) return;
        if (st.mode === "associate") { if (!box2.disabled) toggleAlso(p.id, !box2.checked); return; }
        if (!radio.disabled) pick(p.id);
      };
      row.append(nm, el("span", { className: "c" }, radio), el("span", { className: "c" }, box2));
      list.append(row);
    }
    // Clearing the search after choosing must not hide the choice.
    const chosen = list.querySelector(".pk-row.sel");
    if (chosen) requestAnimationFrame(() => chosen.scrollIntoView({ block: "nearest" }));
  }

  /** The ops the dialog stands for right now, in the order they are applied. */
  function ops() {
    const out = [];
    const base = { entity: item.entity, id: item.id };
    if (st.mode === "move" && st.target != null) {
      const options = {};
      if (st.keepHome || st.lockKeep) options.keepInSource = true;
      if (item.entity === "task") {
        if (st.opts.detach) options.detach = true;
        if (st.opts.pad === "carry") options.pad = "carry";
      }
      if (item.entity === "scratchpad" && st.opts.tasks === "stay") options.tasks = "stay";
      out.push({ op: "move", ...base, to: st.target, options });
      if (associable) {
        for (const pid of st.alsoNext) if (!also.has(pid) && pid !== st.target && pid !== home) out.push({ op: "associate", ...base, to: pid });
        for (const pid of also) if (!st.alsoNext.has(pid) && pid !== st.target) out.push({ op: "dissociate", ...base, to: pid });
      }
    } else if (st.mode === "copy" && st.target != null) {
      const options = {};
      if (item.entity === "task") { options.subtasks = st.opts.subtasks; options.ledger = st.opts.ledger; }
      if (item.entity === "scratchpad") options.derive = st.opts.derive;
      out.push({ op: "copy", ...base, to: st.target, options });
    } else if (st.mode === "associate") {
      for (const pid of st.alsoNext) if (!also.has(pid) && pid !== home) out.push({ op: "associate", ...base, to: pid });
      for (const pid of also) if (!st.alsoNext.has(pid)) out.push({ op: "dissociate", ...base, to: pid });
    }
    return out;
  }

  async function replan() {
    const mine = ++st.seq;
    const list2 = ops();
    if (!list2.length) { st.plans = []; paintOpts(); paintSay(); paintOk(); return; }
    let plans;
    try {
      plans = await Promise.all(list2.map((op) => window.delphi.items.plan(op)));
    } catch (error) {
      plans = [{ ok: false, refusals: [String(error.message || error)], notices: [] }];
    }
    if (mine !== st.seq) return;
    st.plans = plans;
    const first = plans[0];
    if (first && first.ok !== undefined && first.op) {
      if (first.op.op === "move" && first.workbench) {
        // The store keeps the old home shown when a Workbench pins it there
        // (owner decision D3), so the box says so rather than offering a
        // choice the move would ignore.
        st.lockKeep = true;
      } else if (first.op.op === "move") {
        st.lockKeep = false;
      }
      if (first.counts && first.counts.subtasks) st.seenSubtasks = Math.max(st.seenSubtasks, first.counts.subtasks);
      if (first.op.op === "move" && item.entity === "scratchpad" && first.counts && first.counts.tasks) st.seenPadTasks = Math.max(st.seenPadTasks, first.counts.tasks);
    }
    paintList();
    paintOpts();
    paintSay();
    paintOk();
  }

  /** The choices the plan says this item has: a parent, a pad line, subtasks, a pad's tasks. */
  function paintOpts() {
    optsBox.textContent = "";
    const p = st.plans[0];
    if (!p || !p.op) return;
    const check = (on, text, set) => {
      const input = el("input", { type: "checkbox", checked: on });
      input.onchange = () => { set(input.checked); replan(); };
      return el("label", {}, input, el("span", {}, ...[].concat(text)));
    };
    const radio = (name, on, text, set) => {
      const input = el("input", { type: "radio", name, checked: on });
      input.onchange = () => { if (input.checked) { set(); replan(); } };
      return el("label", {}, input, el("span", {}, ...[].concat(text)));
    };
    if (p.op.op === "move" && item.entity === "task") {
      if (p.item && p.item.parent_id != null) {
        optsBox.append(check(st.opts.detach, ["Take it out of its parent, ", el("b", { textContent: `task #${p.item.parent_id}` }), ", so it moves on its own"], (v) => { st.opts.detach = v; }));
      }
      if (p.pad && p.pad.from) {
        const to = p.pad.to ? p.pad.to.title : `a new plan pad in ${p.target ? p.target.name : "the project"}`;
        optsBox.append(
          radio("pk-pad", st.opts.pad !== "carry", ["Leave its line in ", el("b", { textContent: p.pad.from.title }), ", which keeps syncing it"], () => { st.opts.pad = "keep"; }),
          radio("pk-pad", st.opts.pad === "carry", ["Carry its line to ", el("b", { textContent: to })], () => { st.opts.pad = "carry"; }));
      }
    }
    if (p.op.op === "move" && item.entity === "scratchpad" && (st.seenPadTasks || st.opts.tasks === "stay")) {
      optsBox.append(
        radio("pk-padtasks", st.opts.tasks !== "stay", ["Its tasks come with it"], () => { st.opts.tasks = "follow"; }),
        radio("pk-padtasks", st.opts.tasks === "stay", ["Its tasks stay in ", el("b", { textContent: homeName }), " and keep syncing"], () => { st.opts.tasks = "stay"; }));
    }
    if (p.op.op === "copy" && item.entity === "task") {
      if (st.seenSubtasks || st.opts.subtasks === false) {
        optsBox.append(check(st.opts.subtasks, [`With its ${plural(st.seenSubtasks, "subtask", "subtasks")}`], (v) => { st.opts.subtasks = v; }));
      }
      optsBox.append(check(st.opts.ledger, ["With its ledger: the decisions and the entries marked as key"], (v) => { st.opts.ledger = v; }));
    }
    if (p.op.op === "copy" && item.entity === "scratchpad") {
      optsBox.append(check(st.opts.derive, ["Turn its checkboxes into tasks in ", el("b", { textContent: p.target ? p.target.name : "the project" })], (v) => { st.opts.derive = v; }));
    }
  }

  function paintSay() {
    say.textContent = "";
    if (!st.plans.length) {
      const words = st.mode === "move" ? `Pick the project it should live in. Tick Also in to keep it showing somewhere else as well.`
        : st.mode === "copy" ? `Pick where the copy goes. A copy is a separate ${noun} from then on: editing one leaves the other alone.`
        : `Tick every project it should also show in. It keeps living in ${homeName}; nothing is copied.`;
      say.append(el("p", { textContent: words }));
      return;
    }
    for (const p of st.plans) {
      if (p.ok) say.append(el("p", { textContent: p.summary }));
      else for (const r of p.refusals || []) say.append(el("p", { className: "refusal", textContent: r }));
    }
    const moving = st.plans[0] && st.plans[0].op && st.plans[0].op.op;
    if (st.plans.every((p) => p.ok)) {
      if (moving === "move" && (st.keepHome || st.lockKeep)) {
        say.append(el("p", {}, `One ${noun} in two places, not a copy: an edit in either is the same edit, and History records the move as one change you can undo.`));
      } else if (moving === "associate" || moving === "dissociate") {
        say.append(el("p", {}, `One ${noun}, shown wherever it is ticked: an edit anywhere is the same edit.`));
      }
    }
  }

  function paintOk() {
    const list2 = ops();
    const targetName = st.target != null ? projectNameOf(st.target) : "";
    const label = !list2.length ? (st.mode === "associate" ? "Save" : st.mode === "copy" ? "Copy" : "Move")
      : st.mode === "move" ? ((st.keepHome || st.lockKeep) ? `Move, and keep it in ${homeName}` : `Move to ${targetName}`)
      : st.mode === "copy" ? `Copy to ${targetName}`
      : "Save where it shows";
    ok.textContent = decide ? `Approve: ${label.charAt(0).toLowerCase()}${label.slice(1)}` : label;
    ok.disabled = st.busy || !list2.length || st.plans.length !== list2.length || st.plans.some((p) => !p.ok);
  }

  function paint() {
    for (const [i, b] of [...seg.children].entries()) b.setAttribute("aria-pressed", String(modes[i][0] === st.mode));
    colHome.style.visibility = st.mode === "associate" ? "hidden" : "";
    colHome.textContent = st.mode === "copy" ? "To" : "Home";
    colAlso.style.visibility = st.mode === "copy" ? "hidden" : "";
    paintList();
    paintOpts();
    paintSay();
    paintOk();
  }

  async function go() {
    if (ok.disabled) return;
    const list2 = ops();
    st.busy = true;
    paintOk();
    if (decide) {
      try {
        await decide(list2);
        finish(true);
      } catch (error) {
        st.busy = false;
        say.prepend(el("p", { className: "refusal", textContent: refusalWords(error) }));
        paintOk();
      }
      return;
    }
    const auditIds = [];
    const done = [];
    for (const op of list2) {
      try {
        let r;
        if (op.op === "move") r = await window.delphi.items.move(op.entity, op.id, op.to, op.options);
        else if (op.op === "copy") r = await window.delphi.items.copy(op.entity, op.id, op.to, op.options);
        else if (op.op === "associate") r = await window.delphi.items.associate(op.entity, op.id, op.to);
        else r = await window.delphi.items.dissociate(op.entity, op.id, op.to);
        if (r && r.auditId != null) auditIds.push(r.auditId);
        done.push(op);
      } catch (error) {
        st.busy = false;
        say.textContent = "";
        if (done.length) say.append(el("p", { textContent: `${plural(done.length, "change was", "changes were")} made before this one was refused. Undo puts ${done.length === 1 ? "it" : "them"} back.` }));
        say.append(el("p", { className: "refusal", textContent: refusalWords(error) }));
        paintOk();
        if (done.length) notifyUndo("Part of that was done.", auditIds, after);
        await refresh();
        return;
      }
    }
    finish(true);
    await refresh();
    if (after) await after();
    notifyUndo(doneWords(list2), auditIds, after);
  }

  function doneWords(list2) {
    const first = list2[0];
    if (first.op === "move") {
      const keep = first.options && first.options.keepInSource;
      return `Moved to ${projectNameOf(first.to)}${keep ? `, still shown in ${homeName}` : ""}.`;
    }
    if (first.op === "copy") return `Copied to ${projectNameOf(first.to)}.`;
    const added = list2.filter((o) => o.op === "associate").map((o) => projectNameOf(o.to));
    const removed = list2.filter((o) => o.op === "dissociate").map((o) => projectNameOf(o.to));
    return [added.length ? `Now also shown in ${added.join(", ")}.` : "", removed.length ? `No longer shown in ${removed.join(", ")}.` : ""].filter(Boolean).join(" ");
  }

  paint();
  replan();
  requestAnimationFrame(() => search.focus());
  return true;
}

/** A refusal's own sentences, or an error's message. */
function refusalWords(error) {
  const list = error && error.code === "REFUSED" && error.details && Array.isArray(error.details.refusals) ? error.details.refusals : null;
  return list && list.length ? list.join(" ") : String((error && error.message) || error);
}

// ---------------------------------------------------------------------------
// Flag for review

/**
 * What a flag's text points at, read as it is typed: links, #ids (with the
 * word before them when there is one: note #76, pad 3), ranges like #150 to
 * #154, and file names. Purely here, in the window: nothing is looked up that
 * is not already on screen, and what is found goes to the store as evidence
 * chips beside the text, which is sent whole either way.
 */
// Linear in the text: each pattern runs once over the original, and a match
// inside one an earlier pattern took is skipped by looking at a byte per
// character, where rebuilding the string per match made a long paste
// quadratic. The titles are indexed once rather than searched per match.
const EVIDENCE_CAP = 60;
// An id the store will take: "#0" or a twenty-digit number stays plain text
// rather than becoming a chip that gets the whole flag refused.
const goodId = (n) => Number.isSafeInteger(n) && n > 0;
function readEvidence(text) {
  const rest = String(text || "");
  const taken = new Uint8Array(rest.length);
  const chips = [];
  const seen = new Set();
  const free = (m) => { for (let i = m.index, end = m.index + m[0].length; i < end; i += 1) if (taken[i]) return false; return true; };
  const mask = (m) => { taken.fill(1, m.index, m.index + m[0].length); };
  const add = (key, chip) => { if (seen.has(key) || chips.length >= EVIDENCE_CAP) return; seen.add(key); chips.push(chip); };
  const titles = (list, label = "title") => new Map((list || []).map((x) => [x.id, x[label]]));
  const tasks = titles(state.everyTask);
  for (const t of state.tasks || []) if (!tasks.has(t.id)) tasks.set(t.id, t.title);
  const notes = titles(state.notes);
  const padsById = titles(state.pads);
  const taskTitle = (id) => tasks.get(id) || null;
  const noteTitle = (id) => notes.get(id) || null;
  const padTitle = (id) => padsById.get(id) || null;
  const all = (re) => [...rest.matchAll(re)].filter(free);

  for (const m of all(/\bhttps?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?]/g)) {
    add(`url:${m[0]}`, { cls: "url", ty: "link", label: m[0].replace(/^https?:\/\//, ""), evidence: [{ type: "url", value: m[0] }] });
    mask(m);
  }
  // A bare domain with a path, such as github.com/owner/repo. Tried once per
  // word, anchored at its start: unanchored, "a.a.a.a..." pasted whole made
  // the engine retry the dotted run from every position, which is quadratic.
  const domainAt = /^((?:[a-z0-9-]+\.)+(?:com|org|io|net|dev|app|co)\/[^\s<>()"'`]*[^\s<>()"'`.,;:!?])/i;
  const bare = [];
  for (const w of rest.matchAll(/[^\s(`'"<>]+/g)) {
    if (w[0].length > 2000 || w[0].indexOf("/") < 0) continue;
    const hit = domainAt.exec(w[0]);
    if (hit) bare.push(Object.assign([hit[1]], { index: w.index }));
  }
  for (const m of bare.filter(free)) {
    add(`url:https://${m[0]}`, { cls: "url", ty: "link", label: m[0], evidence: [{ type: "url", value: `https://${m[0]}` }] });
    mask(m);
  }
  for (const m of all(/(?:\btasks?\s+)?#(\d+)\s*(?:to|through|\.\.|-)\s*#?(\d+)\b/gi)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!goodId(a) || !goodId(b) || !(b > a) || b - a > 19) continue;
    const ids = [];
    for (let id = a; id <= b; id += 1) ids.push(id);
    add(`range:${a}:${b}`, { cls: "task", ty: "tasks", label: `#${a} to #${b}, ${ids.length} tasks`, evidence: ids.map((id) => ({ type: "task", id })) });
    mask(m);
  }
  for (const m of all(/\b(task|note|pad|project)s?\s+#?(\d+)\b/gi)) {
    const type = m[1].toLowerCase();
    const id = Number(m[2]);
    if (!goodId(id)) continue;
    const title = type === "task" ? taskTitle(id) : type === "note" ? noteTitle(id) : type === "pad" ? padTitle(id) : projectNameOf(id, null);
    add(`${type}:${id}`, { cls: type, ty: type, label: `#${id}${title ? ` ${title}` : ""}`, evidence: [{ type, id }] });
    mask(m);
  }
  for (const m of all(/(^|[^\w&/])#(\d+)\b/g)) {
    const id = Number(m[2]);
    if (!goodId(id)) continue;
    const title = taskTitle(id);
    add(`task:${id}`, { cls: "task", ty: "task", label: `#${id}${title ? ` ${title}` : ""}`, evidence: [{ type: "task", id }] });
    mask(m);
  }
  for (const m of all(/(?:^|[\s(`'"])((?:[\w.-]+\/)*[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|md|json|sql|html|css|ya?ml|toml|sh|erb|java|kt|swift|cpp|txt))(?=$|[\s)`'".,;:!?])/g)) {
    add(`file:${m[1]}`, { cls: "file", ty: "file", label: m[1], evidence: [{ type: "text", value: `file: ${m[1]}` }] });
  }
  return chips;
}

/**
 * The Flag dialog: a big box for what should happen and why, the evidence
 * recognised out of it as it is typed, and who looks at it. Nothing moves
 * from here. The evaluator can only propose, and the proposal waits in Needs
 * you for a person.
 */
async function openFlagDialog(item, { after = null } = {}) {
  const noun = ITEM_NOUN[item.entity];
  let chips = [];
  let evaluator = "oracle";
  // The agent evaluator is a hook the store leaves off (owner decision D6).
  // Offered only once the backend says it is on; until then it is shown, off,
  // with the reason, so nobody wonders where it went.
  const agentOn = Boolean(state.settings && state.settings.flagAgentEvaluator === true);

  const { box, finish } = openModal({
    className: "fl-dlg", label: "Flag for review",
    onKey: (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); send(); }
    },
  });

  const top = el("div", { className: "fl-top" },
    el("h3", {}, itemIcon("flag"), "Flag for review"), el("span", { className: "grow" }),
    el("span", { className: "hint", textContent: "Nothing changes until you approve" }));

  const subj = el("div", { className: "fl-subj" },
    el("span", { className: `kind sm ${item.kind || ""}`.trim(), textContent: item.kind || noun }),
    el("span", { className: "t", textContent: item.label, title: item.label }),
    el("span", { className: "hint" }, dotFor(item.homeId, item.homeColour), item.homeName || "no project"));
  const text = el("textarea", { className: "fl-text", rows: 10, spellcheck: true,
    placeholder: `What should happen to this ${noun}, why, and what shows it. Name the project it belongs in, write #ids, paste links and file names.` });
  const refs = el("div", { className: "refs", "aria-live": "polite" });
  const paintRefs = () => {
    chips = readEvidence(text.value);
    refs.textContent = "";
    for (const c of chips) refs.append(el("span", { className: `ref ${c.cls}` }, el("span", { className: "ty", textContent: c.ty }), el("span", { textContent: c.label })));
  };
  // Read a moment after typing stops rather than on every key, and at once
  // when sent, so what goes as evidence is always what the text says.
  let refsTimer = null;
  text.oninput = () => { clearTimeout(refsTimer); refsTimer = setTimeout(paintRefs, 120); };
  const err = el("div", { className: "err-msg", hidden: true });
  const left = el("div", { className: "fl-l" }, subj,
    el("div", { className: "fx-label", textContent: "What should happen, why, and your evidence" }), text,
    el("div", { className: "hint", style: "margin-top:8px", textContent: "Recognised as you type. Paste links, write #ids or file names." }),
    refs, err);

  const sendBtn = el("button", { className: "btn primary", type: "button", textContent: "Send to the Oracle" });
  const option = (key, title, desc, avatar, enabled, offSay) => {
    const input = el("input", { type: "radio", name: "fl-eval", checked: key === evaluator, disabled: !enabled });
    const card = el("label", { className: "evo" + (key === evaluator ? " on" : "") + (enabled ? "" : " off") }, input,
      el("div", {}, el("div", { className: "t" }, avatar, title), el("div", { className: "d", textContent: desc }),
        offSay ? el("div", { className: "off-say", textContent: offSay }) : null));
    input.onchange = () => {
      if (!input.checked) return;
      evaluator = key;
      for (const c of evalBox.querySelectorAll(".evo")) c.classList.toggle("on", c === card);
      sendBtn.textContent = key === "agent" ? "Send to an agent" : "Send to the Oracle";
    };
    return card;
  };
  const evalBox = el("div", { className: "ev" },
    option("oracle", "The Oracle", "Reads memory, tasks and the graph, and the links you gave. Answers in seconds. Runs nothing.",
      el("span", { className: "avatar sm agent", textContent: "O" }), true, null),
    option("agent", "An agent", "Can open the code and the repositories you cite, in a read-only run. A few minutes.",
      el("span", { className: "avatar sm ag-other", textContent: "A" }), agentOn,
      agentOn ? null : "Not turned on in this version. The Oracle evaluates every flag for now."));
  const right = el("div", { className: "fl-r" },
    el("div", { className: "fx-label", textContent: "Who evaluates it" }), evalBox,
    el("div", { className: "lim2" }, "It can only ", el("b", { textContent: "propose" }),
      ": move, copy or also belongs to. The proposal comes to ", el("b", { textContent: "Needs you" }),
      " with its reasons and your evidence cited, and you approve or reject it there."));

  const cancel = el("button", { className: "btn", type: "button", textContent: "Cancel" });
  cancel.onclick = () => finish(null);
  sendBtn.onclick = () => send();
  const foot = el("div", { className: "fl-foot" },
    el("span", { className: "hint" }, el("span", { className: "kbd", textContent: "Esc" }), "cancel ",
      el("span", { className: "kbd", textContent: isMac() ? "\u2318 Enter" : "Ctrl Enter" }), "send"),
    el("span", { className: "grow" }), cancel, sendBtn);

  box.append(top, el("div", { className: "fl-body" }, left, right), foot);
  requestAnimationFrame(() => text.focus());

  let sending = false;
  async function send() {
    if (sending) return;
    clearTimeout(refsTimer);
    paintRefs();
    sending = true;
    sendBtn.disabled = true;
    err.hidden = true;
    const evidence = [];
    const keys = new Set();
    for (const c of chips) {
      for (const e of c.evidence) {
        const k = JSON.stringify(e);
        if (keys.has(k) || evidence.length >= 20) continue;
        keys.add(k);
        evidence.push(e);
      }
    }
    let r;
    try {
      r = await window.delphi.items.flag(item.entity, item.id, text.value.trim(), evidence, evaluator);
    } catch (error) {
      sending = false;
      sendBtn.disabled = false;
      err.hidden = false;
      err.textContent = refusalWords(error);
      return;
    }
    finish(true);
    reloadFlags();
    if (after) await after();
    const f = r && r.flag;
    const words = r && r.appended ? `Added to the open flag on this ${noun}.`
      : f && f.status === "proposed" ? `${f.proposal_summary || "The Oracle has a proposal"}. It is waiting in Needs you.`
      : `The Oracle found no clear home for it, so the flag is in Needs you for you to decide.`;
    notifyAction(words, "Open Needs you", () => goTo({ projectId: null, view: "inbox", query: "" }));
  }
}

// ---------------------------------------------------------------------------
// Flags in Needs you
//
// flags:list({needsYou: true}) gives one row per decision or question, the
// sweep's grouped by where they would go. Each row's flag is read whole
// (flags:get) with where its item is now (items:where), so a proposal card can
// draw Now and After from the store's answer rather than from a guess.
// ---------------------------------------------------------------------------

const flagDetails = new Map();
// Sweep groups opened with Review, by title: the ids in one change as they
// are decided, the sentence that names the group does not.
const openSweeps = new Set();
let flagsTimer = null;
let flagsBusy = false;
let flagsAgain = false;
let flagsSig = "";

function flagsChanged() {
  alsoInCache.clear();
  if (flagsTimer) return;
  flagsTimer = setTimeout(() => { flagsTimer = null; reloadFlags(); }, 250);
}

async function reloadFlags() {
  if (!window.delphi.flags) return;
  if (flagsBusy) { flagsAgain = true; return; }
  flagsBusy = true;
  try {
    do {
      flagsAgain = false;
      let rows;
      try { rows = await window.delphi.flags.list({ needsYou: true }); } catch { return; }
      const ids = new Set();
      for (const r of rows) {
        if (r.group) { if (openSweeps.has(r.title)) for (const id of r.ids) ids.add(id); }
        else if (r.id != null) ids.add(r.id);
      }
      const details = new Map();
      await Promise.all([...ids].map(async (id) => {
        try {
          const d = await window.delphi.flags.get(id);
          let where = null;
          try { where = await window.delphi.items.where(d.flag.entity, d.flag.entity_id); } catch {}
          details.set(id, { ...d, where });
        } catch {}
      }));
      const sig = JSON.stringify([rows, [...details.entries()]]);
      if (sig === flagsSig) continue;
      flagsSig = sig;
      state.flagRows = rows;
      const live = new Set(rows.flatMap((r) => (r.group ? [`group:${r.title}`, ...r.ids] : [r.id])));
      for (const k of [...flagUi.keys()]) if (!live.has(k)) flagUi.delete(k);
      flagDetails.clear();
      for (const [k, v] of details) flagDetails.set(k, v);
      paintRunsLive();
    } while (flagsAgain);
  } finally {
    flagsBusy = false;
  }
}

const flagRowsNow = () => state.flagRows || [];

// What a card is doing, by flag id: { pending, error, stale }. Kept outside
// the card because runs-changed repaints Needs you about once a second, and a
// disabled Approve or the sentence a refusal came back with must not vanish
// with the node that drew it. Sweep groups are keyed "group:<title>".
const flagUi = new Map();

/**
 * Approves the proposal a card showed, by its entry. STALE means a newer
 * proposal arrived since: the card is drawn again with the new one and says
 * so, rather than applying either without a second look.
 */
async function approveFlag(flagId, entryId, chosen, ops, homeName) {
  const now = flagUi.get(flagId) || {};
  if (now.pending) return;
  flagUi.set(flagId, { pending: true });
  repaintKeepingFocus();
  let r;
  try {
    r = await window.delphi.flags.approve(flagId, chosen ? { entryId, ops: chosen } : { entryId });
  } catch (error) {
    flagUi.set(flagId, error && error.code === "STALE" ? { stale: true } : { error: refusalWords(error) });
    flagsSig = "";
    await reloadFlags();
    repaintKeepingFocus();
    return;
  }
  flagUi.delete(flagId);
  await refresh();
  reloadFlags();
  notifyUndo(`Approved: ${proposalTitle(ops, homeName).replace(/^./, (c) => c.toLowerCase())}.`, (r && r.auditIds) || []);
}

/** Does something to a flag, says what went wrong in the store's words, and asks again. */
async function flagAct(fn) {
  try { await fn(); } catch (error) { notifyRefusal(error); }
  await refresh();
  reloadFlags();
}

/** "Move to Delphi: the task system, and also show it in Offerworks", from a proposal's ops. */
function proposalTitle(ops, homeName) {
  const words = (ops || []).map((o) => {
    const there = projectNameOf(o.to);
    if (o.op === "move") return `move to ${there}${o.options && o.options.keepInSource ? `, and also show it in ${homeName}` : ""}`;
    if (o.op === "copy") return `copy to ${there}`;
    if (o.op === "associate") return `also show it in ${there}`;
    return `take it out of ${there}`;
  });
  return capFirst(words.join("; ")) || "No change proposed";
}

/** Where the item is now, and where it would be after the proposal, as two small boxes. */
function nowAfter(f, where, ops) {
  const homeId = where && where.home ? where.home.id : f.project ? f.project.id : null;
  const names = new Map();
  if (where && where.home) names.set(where.home.id, where.home.name);
  for (const p of (where && where.also) || []) names.set(p.id, p.name);
  const nameOf = (id) => names.get(id) || projectNameOf(id);
  const alsoNow = ((where && where.also) || []).map((p) => p.id);
  let afterHome = homeId;
  const afterAlso = new Set(alsoNow);
  const copies = [];
  for (const o of ops || []) {
    if (o.op === "move") {
      if (o.options && o.options.keepInSource && afterHome != null) afterAlso.add(afterHome);
      afterAlso.delete(o.to);
      afterHome = o.to;
    } else if (o.op === "associate") afterAlso.add(o.to);
    else if (o.op === "dissociate") afterAlso.delete(o.to);
    else if (o.op === "copy") copies.push(o.to);
  }
  const shortHome = (id) => nameOf(id).split(":")[0];
  const line = (id, right, home = false) => el("div", { className: "l" }, dotFor(id), el("span", { textContent: nameOf(id) }),
    el("span", { className: "r" + (home ? " home" : ""), textContent: right }));
  const now = el("div", { className: "pm" }, el("div", { className: "h", textContent: "Now" }));
  if (homeId != null) now.append(line(homeId, "home", true));
  for (const id of alsoNow) now.append(line(id, "shown"));
  const after = el("div", { className: "pm after" }, el("div", { className: "h", textContent: "After" }));
  if (afterHome != null) after.append(line(afterHome, "home", true));
  for (const id of afterAlso) after.append(line(id, `shown, from ${shortHome(afterHome)}`));
  for (const id of copies) after.append(line(id, "a copy"));
  return el("div", { className: "prop-mv" }, now, el("div", { className: "prop-arr", textContent: "→" }), after);
}

/** The flag's own words and evidence, and the neighbours the Oracle leaned on, numbered. */
function flagCites(f, signals) {
  const out = [];
  if (f.note) out.push([f.source === "sweep" ? "The sweep" : f.source === "person" ? "Your flag" : `${f.created_by || "An agent"}'s flag`, `"${firstLineOf(f.note, 140)}"`]);
  // A run of task ids, as "#150 to #154" was typed, is one citation, so five
  // handoffs do not push the link and the file out of the six shown.
  const evidence = [];
  for (const c of f.evidence || []) {
    const last = evidence[evidence.length - 1];
    if (c.type === "task" && last && last.type === "taskRange" && c.id === last.to + 1) last.to = c.id;
    else if (c.type === "task" && last && last.type === "task" && c.id === last.id + 1) evidence[evidence.length - 1] = { type: "taskRange", from: last.id, to: c.id };
    else evidence.push(c);
  }
  for (const c of evidence) {
    if (c.type === "taskRange") out.push([`Tasks #${c.from} to #${c.to}`, plural(c.to - c.from + 1, "task", "tasks")]);
    else if (c.type === "url") out.push([c.value.replace(/^https?:\/\//, "").slice(0, 60), ""]);
    else if (c.type === "text") out.push([/^file: /.test(c.value) ? "File" : "Evidence", c.value.replace(/^file: /, "")]);
    else if (c.type === "task") { const t = state.everyTask.find((x) => x.id === c.id); out.push([`Task #${c.id}`, t ? `"${t.title}"` : ""]); }
    else if (c.type === "project") out.push(["Project", projectNameOf(c.id)]);
    else out.push([`${capFirst(ITEM_NOUN[c.type === "pad" ? "scratchpad" : c.type] || c.type)} #${c.id}`, ""]);
  }
  for (const n of ((signals && signals.neighbours) || []).slice(0, 3)) {
    const [entity, id, title, pid] = n;
    out.push([`${capFirst(ITEM_NOUN[entity] || entity)} #${id}`, `"${title}" in ${projectNameOf(pid)}`]);
  }
  if (!out.length) return null;
  return el("div", { className: "cites" }, out.slice(0, 6).map(([src, q], i) =>
    el("div", { className: "cite" }, el("span", { className: "n", textContent: String(i + 1) }),
      el("span", { className: "src", textContent: src }), el("span", { className: "q", textContent: q, title: q }))));
}

/** Which other projects scored, so a person can see what was weighed and not chosen. */
function consideredLine(f, signals, ops) {
  const knn = (signals && signals.knn) || [];
  const chosen = new Set((ops || []).map((o) => o.to));
  const homeId = f.project ? f.project.id : null;
  const others = knn.filter(([pid]) => !chosen.has(pid) && pid !== homeId).slice(0, 2);
  const homeScore = knn.find(([pid]) => pid === homeId);
  if (!others.length && !homeScore) return null;
  const line = el("div", { className: "prop-alt" });
  if (others.length) {
    line.append("Also considered ");
    others.forEach(([pid, s], i) => line.append(i ? " and " : "", el("b", { textContent: projectNameOf(pid) }), ` (${s})`));
    line.append(". ");
  }
  if (homeScore) line.append("Where it lives now scored ", el("b", { textContent: String(homeScore[1]) }), ".");
  return line;
}

/** The newest entry of a kind on a flag's thread, optionally only those carrying a proposal. */
const lastEntry = (entries, kind, test = () => true) => [...(entries || [])].reverse().find((e) => e.kind === kind && test(e)) || null;

/**
 * Who a proposal came from when the Oracle only checked it: a proposal driven
 * by an agent's own words is that agent's suggestion, at lower confidence, and
 * the card says so in the agent's name rather than in the Oracle's voice.
 * The store writes suggested_by and nothing else; null when the Oracle's own.
 */
function suggestedBy(f) {
  const p = f && f.proposal;
  return p && p.suggested_by ? { name: String(p.suggested_by), type: p.suggested_by_type || null } : null;
}

// An actor name is whatever the writer chose, so it is never shown alone:
// "agent Ray" cannot be read as Ray the person.
const suggesterKind = (type) => (type === "agent" ? "agent " : type === "human" ? "" : "unmarked writer ");

function suggestedTag(f) {
  const who = suggestedBy(f);
  if (!who) return null;
  const conf = f.proposal && f.proposal.confidence != null ? ` (${Number(f.proposal.confidence).toFixed(2)})` : "";
  const kind = suggesterKind(who.type);
  // The Oracle checked it only when the Oracle wrote it up; an agent's own
  // propose_move went straight onto the flag.
  const checked = f.proposal.oracle_checked === true;
  return el("span", { className: "suggested-tag", title: `${kind}${who.name} suggested this${checked ? " from its own words; the Oracle checked it against what it can see" : " itself; the Oracle did not write it"}${conf ? `, at confidence ${Number(f.proposal.confidence).toFixed(2)}` : ""}.` },
    kind, el("b", { textContent: who.name }), checked ? " suggested, the Oracle checked" : " suggested", conf);
}

function flagSourceWords(f) {
  const by = suggestedBy(f) ? null : f.proposed_by === "oracle" || (f.proposal && f.proposal.evaluator === "oracle@1") ? "the Oracle" : f.proposed_by || null;
  const whose = f.source === "sweep" ? "found by the sweep" : f.source === "person" ? "on your flag" : `on ${f.created_by || "an agent"}'s flag`;
  return `${by ? `from ${by}, ` : ""}${whose} at ${clockWords(f.created_at)}`;
}

/**
 * One flag in Needs you: a proposal with Now and After, the reasoning and
 * what it cites, or a question, or a flag nobody has found a home for yet.
 * Approve applies it through the store and offers Undo; Reject asks why,
 * because the store keeps the reason so the next look does not propose the
 * same thing; Reply and Withdraw are always there.
 */
function flagCard(row, d) {
  const f = d && d.flag;
  if (!f) {
    const card = el("div", { className: "wr flagged" }, el("span", { className: "avatar lg agent", textContent: "O" }),
      el("div", { className: "prop" }, el("span", { className: "k", textContent: "Flag" }), el("div", { className: "t", textContent: row.title }),
        el("div", { className: "why", textContent: row.summary || "" })));
    card.style.gridTemplateColumns = "26px minmax(0, 1fr)";
    return card;
  }
  const kind = f.needs === "decision" || f.status === "proposed" ? "decision" : f.needs === "question" ? "question" : "review";
  const card = el("div", { className: `wr ${kind === "decision" ? "proposal" : kind === "question" ? "question" : "flagged"}` });
  card.dataset.row = `flag-${f.id}`;
  card.style.gridTemplateColumns = "26px minmax(0, 1fr)";
  const noun = ITEM_NOUN[f.entity] || f.entity;
  const item = {
    entity: f.entity, id: f.entity_id, label: f.label, kind: null,
    homeId: d.where && d.where.home ? d.where.home.id : f.project ? f.project.id : null,
    homeName: d.where && d.where.home ? d.where.home.name : f.project ? f.project.name : "no project",
    homeColour: null, associated: false,
  };
  const ops = f.proposal && Array.isArray(f.proposal.ops) ? f.proposal.ops : [];
  const p = el("div", { className: "prop" });
  const label = kind === "decision" ? "Proposal" : kind === "question" ? "Question" : "Flagged";
  p.append(el("div", { className: "row" }, el("span", { className: "k", textContent: label }),
    kind === "decision" ? suggestedTag(f) : null,
    el("span", { className: "hint", textContent: kind === "decision" ? flagSourceWords(f) : `${f.source === "sweep" ? "the sweep flagged it" : f.source === "person" ? "you flagged it" : `flagged by ${f.created_by || "an agent"}`} at ${clockWords(f.created_at)}` }),
    el("span", { className: "grow" }),
    withData(el("span", { className: "hint", textContent: spanWords(TIME.secondsSince(f.updated_at || f.created_at)) }), { since: f.updated_at || f.created_at })));
  p.append(el("div", { className: "t", textContent: kind === "decision" ? proposalTitle(ops, item.homeName) : f.label }));
  p.append(el("div", { className: "s" }, el("span", { className: "kind sm", textContent: noun }), el("span", { textContent: `#${f.entity_id} ${f.label}` })));

  const proposalEntry = lastEntry(d.entries, "note", (e) => e.meta && e.meta.proposal);
  const oracleNote = lastEntry(d.entries, "note");
  const signals = (f.proposal && f.proposal.signals) || (oracleNote && oracleNote.meta && oracleNote.meta.signals) || null;
  if (kind === "decision") {
    p.append(nowAfter(f, d.where, ops));
    const why = (f.proposal && f.proposal.reasoning) || (proposalEntry && proposalEntry.body) || "";
    if (why) p.append(el("div", { className: "prop-why", textContent: why }));
    const cites = flagCites(f, signals);
    if (cites) p.append(cites);
    const alt = consideredLine(f, signals, ops);
    if (alt) p.append(alt);
    const stale = (d.plan || []).flatMap((x) => (x && x.refusals) || []);
    if (stale.length) p.append(el("div", { className: "prop-stale", textContent: `It cannot be applied as it stands: ${stale.join(" ")}` }));
  } else if (kind === "question") {
    const ask = lastEntry(d.entries, "ask");
    p.append(el("div", { className: "prop-why", textContent: ask ? ask.body : row.summary || "The evaluator has a question." }));
  } else {
    if (f.note) p.append(el("div", { className: "prop-why", textContent: f.note }));
    if (oracleNote && oracleNote.body && (oracleNote.author === "oracle" || oracleNote.author_type === "tool")) {
      p.append(el("div", { className: "prop-alt", textContent: oracleNote.body }));
    }
    const cites = flagCites({ ...f, note: null }, signals);
    if (cites) p.append(cites);
  }

  // Inline answers, kept across repaints the way a run's reply is.
  const rejectKey = `freject-${f.id}`;
  const replyKey = `freply-${f.id}`;
  const againKey = `fagain-${f.id}`;
  const err = el("div", { className: "err-msg", hidden: true });
  const fail = (error) => { err.hidden = false; err.textContent = refusalWords(error); };
  if (runDrafts.has(rejectKey)) {
    const field = withData(el("input", { className: "field", placeholder: "Why not? Needed: it stops the next look proposing the same thing.", value: runDrafts.get(rejectKey) || "" }), { keep: rejectKey });
    field.oninput = () => runDrafts.set(rejectKey, field.value);
    const again = el("input", { type: "checkbox", checked: runDrafts.get(againKey) === true });
    again.onchange = () => runDrafts.set(againKey, again.checked);
    const send = el("button", { className: "btn no", type: "button", textContent: "Reject", disabled: runSending.has(rejectKey) });
    const go = async () => {
      const note = field.value.trim();
      if (!note) { field.focus(); err.hidden = false; err.textContent = "Say why, so the next look does not propose the same thing."; return; }
      send.disabled = true;
      const looked = again.checked;
      const ok = await sendDraft(rejectKey, () => window.delphi.flags.reject(f.id, { note, reevaluate: looked, entryId: f.proposal_entry_id ?? row.entryId ?? null }));
      if (!ok) return;
      runDrafts.delete(againKey);
      notify(looked ? "Rejected. The Oracle has looked again with your reason." : "Rejected. Nothing was changed.");
      await refresh();
      reloadFlags();
    };
    send.onclick = go;
    field.onkeydown = (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); go(); }
      if (e.key === "Escape") { e.stopPropagation(); runDrafts.delete(rejectKey); runRefused.delete(rejectKey); repaintKeepingFocus(); }
    };
    p.append(el("div", { className: "reject-why" }, field, el("label", {}, again, "Have the Oracle look again"), send), refusedLine(rejectKey));
    requestAnimationFrame(() => { if (field.isConnected && !document.activeElement?.dataset?.keep) field.focus(); });
  }
  if (runDrafts.has(replyKey) || kind === "question") {
    const field = withData(el("input", { className: "field", placeholder: kind === "question" ? "Answer it. The Oracle looks again with your answer." : "Add to the thread. It stays with the flag.", value: runDrafts.get(replyKey) || "" }), { keep: replyKey });
    field.oninput = () => {
      runDrafts.set(replyKey, field.value);
      if (window.DelphiRecovery) DelphiRecovery.saveDraft("flag", f.id, field.value);
    };
    const send = el("button", { className: "btn", type: "button", textContent: "Reply", disabled: runSending.has(replyKey) });
    const go = async () => {
      const body = field.value.trim();
      if (!body) { field.focus(); return; }
      send.disabled = true;
      if (await sendDraft(replyKey, () => window.delphi.flags.reply(f.id, body))) {
        if (window.DelphiRecovery) DelphiRecovery.clearDraft("flag", f.id);
        reloadFlags();
      }
    };
    send.onclick = go;
    field.onkeydown = (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); go(); }
      if (e.key === "Escape" && kind !== "question") { e.stopPropagation(); runDrafts.delete(replyKey); runRefused.delete(replyKey); if (window.DelphiRecovery) DelphiRecovery.clearDraft("flag", f.id); repaintKeepingFocus(); }
    };
    p.append(el("div", { className: "reply" }, field, send), refusedLine(replyKey));
  }
  p.append(err);

  const acts = el("div", { className: "prop-acts" });
  const button = (text, cls, run) => { const b = el("button", { className: `btn ${cls}`.trim(), type: "button", textContent: text }); b.onclick = run; return b; };
  // The proposal this card shows, by its entry. Approve and reject name it, so
  // a newer proposal arriving while the card was open is refused (STALE)
  // rather than applied in its place.
  const entryId = f.proposal_entry_id != null ? f.proposal_entry_id : row.entryId != null ? row.entryId : null;
  const ui = flagUi.get(f.id) || {};
  if (ui.stale) p.insertBefore(el("div", { className: "prop-stale", role: "alert", textContent: "This proposal changed since you looked. This is the new one." }), err);
  if (ui.error) { err.hidden = false; err.setAttribute("role", "alert"); err.textContent = ui.error; }
  if (kind === "decision") {
    const approve = withData(button(ui.pending ? "Approving…" : "Approve", "ok", () => approveFlag(f.id, entryId, null, ops, item.homeName)), { act: "approve" });
    approve.disabled = Boolean(ui.pending) || entryId == null;
    if (entryId == null) approve.title = "This proposal has no entry to approve against yet; ask the Oracle again.";
    acts.append(approve,
      withData(button(runDrafts.has(rejectKey) ? "Cancel" : "Reject", "no", () => {
        if (runDrafts.has(rejectKey)) runDrafts.delete(rejectKey); else runDrafts.set(rejectKey, "");
        repaintKeepingFocus();
      }), { act: "reject" }),
      withData(button("Change it…", "", () => openItemPicker(item, ops[0] ? (ops[0].op === "associate" || ops[0].op === "dissociate" ? "associate" : ops[0].op) : "move", {
        preset: ops,
        decide: async (chosen) => {
          const r = await window.delphi.flags.approve(f.id, { entryId, ops: chosen });
          flagUi.delete(f.id);
          await refresh();
          reloadFlags();
          notifyUndo("Approved with your change.", (r && r.auditIds) || []);
        },
      })), { act: "change" }));
  } else if (kind === "review") {
    acts.append(
      button("Ask the Oracle again", "", () => flagAct(async () => {
        const r = await window.delphi.flags.evaluate(f.id, { mode: "oracle" });
        notify(r && r.flag && r.flag.status === "proposed" ? r.flag.proposal_summary || "The Oracle has a proposal." : "Still no clear home. Say where in a reply, or decide it yourself.");
      })),
      // With no proposal there is no entry to approve against, so the ops
      // chosen in the picker are the decision: one call applies exactly them
      // and closes the flag as decided by you, so the change and the flag's
      // record land together, with Undo.
      button("Decide it myself…", "", () => openItemPicker(item, "move", {
        decide: async (chosen) => {
          const r = await window.delphi.flags.approve(f.id, { ops: chosen });
          flagUi.delete(f.id);
          await refresh();
          reloadFlags();
          notifyUndo("Done, and the flag is closed as decided by you.", (r && r.auditIds) || []);
        },
      })));
  }
  if (kind !== "question") {
    acts.append(button(runDrafts.has(replyKey) ? "Cancel reply" : "Reply", "", () => {
      if (runDrafts.has(replyKey)) runDrafts.delete(replyKey); else runDrafts.set(replyKey, "");
      repaintKeepingFocus();
    }));
  }
  const withdraw = el("button", { className: "ts-linkbtn", type: "button", textContent: "Withdraw", title: "Close the flag without changing anything" });
  withdraw.onclick = () => flagAct(async () => { await window.delphi.flags.withdraw(f.id); notify("Withdrawn. Nothing was changed."); });
  const open = el("button", { className: "ts-linkbtn", type: "button", textContent: `Open the ${noun}` });
  open.onclick = () => openItemHome(item);
  acts.append(el("span", { className: "grow" }), withdraw, open);
  p.append(acts);

  const avatar = kind === "decision" && f.proposed_by && f.proposed_by !== "oracle"
    ? agentAvatar(String(f.proposed_by).split(":")[0], f.proposed_by)
    : el("span", { className: "avatar lg agent", textContent: "O", title: "The Oracle" });
  card.append(avatar, p);
  return card;
}

/** The sweep's suggestions for one destination, as one row with Approve all. */
function sweepGroupRow(row) {
  const card = el("div", { className: "wr sweep" });
  card.dataset.row = `sweep-${row.title}`;
  card.style.gridTemplateColumns = "26px minmax(0, 1fr)";
  const p = el("div", { className: "prop" });
  p.append(el("div", { className: "row" }, el("span", { className: "k", textContent: "Sweep" }),
    el("span", { className: "hint", textContent: plural(row.ids.length, "suggestion", "suggestions") }), el("span", { className: "grow" }),
    withData(el("span", { className: "hint", textContent: spanWords(TIME.secondsSince(row.created_at)) }), { since: row.created_at })));
  p.append(el("div", { className: "t", textContent: row.title }));
  if (row.summary) p.append(el("div", { className: "prop-why", textContent: row.summary }));
  const err = el("div", { className: "err-msg", hidden: true });
  const acts = el("div", { className: "prop-acts" });
  // Each suggestion is approved against the proposal entry this row was
  // drawn with, so one that changed since is refused (STALE) and left for a
  // second look rather than applied unseen.
  const key = `group:${row.title}`;
  const ui = flagUi.get(key) || {};
  if (ui.error) { err.hidden = false; err.setAttribute("role", "alert"); err.textContent = ui.error; }
  const entries = Array.isArray(row.entries) && row.entries.length ? row.entries : row.ids.map((id) => ({ id, entryId: null }));
  const all = withData(el("button", { className: "btn ok", type: "button", textContent: ui.pending ? "Approving…" : "Approve all" }), { act: "approve-all" });
  all.disabled = Boolean(ui.pending);
  all.onclick = async () => {
    if ((flagUi.get(key) || {}).pending) return;
    flagUi.set(key, { pending: true });
    repaintKeepingFocus();
    const auditIds = [];
    const failed = [];
    let stale = 0;
    for (const { id, entryId } of entries) {
      try { const r = await window.delphi.flags.approve(id, { entryId }); auditIds.push(...((r && r.auditIds) || [])); }
      catch (error) {
        if (error && error.code === "STALE") { stale += 1; flagUi.set(id, { stale: true }); }
        else failed.push(`Flag ${id}: ${refusalWords(error)}`);
      }
    }
    const said = [stale ? `${plural(stale, "suggestion", "suggestions")} changed since you looked and ${stale === 1 ? "was" : "were"} left for another look.` : "", ...failed].filter(Boolean).join(" ");
    if (said) flagUi.set(key, { error: said }); else flagUi.delete(key);
    if (stale) openSweeps.add(row.title);
    flagsSig = "";
    await refresh();
    await reloadFlags();
    const done = entries.length - failed.length - stale;
    notifyUndo(`Approved ${plural(done, "suggestion", "suggestions")}${failed.length + stale ? `; ${failed.length + stale} not` : ""}.`, auditIds);
  };
  const opened = openSweeps.has(row.title);
  const review = el("button", { className: "btn", type: "button", textContent: opened ? "Hide them" : "Review each" });
  review.onclick = () => { if (opened) openSweeps.delete(row.title); else openSweeps.add(row.title); flagsSig = ""; reloadFlags(); repaintKeepingFocus(); };
  acts.append(all, review);
  p.append(acts, err);
  if (opened) {
    const inner = el("div", { className: "prop-group" });
    for (const id of row.ids) {
      const d = flagDetails.get(id);
      inner.append(d ? flagCard({ id, title: d.flag.label }, d) : el("div", { className: "empty-line", textContent: "Loading…" }));
    }
    p.append(inner);
  }
  card.append(el("span", { className: "avatar lg agent", textContent: "O", title: "The Oracle" }), p);
  return card;
}

const flagNode = (row) => (row.group ? sweepGroupRow(row) : flagCard(row, flagDetails.get(row.id)));

// ---------------------------------------------------------------------------
// The sweep

/**
 * Looks for items filed in the wrong place, on demand only (owner decision
 * D5). It flags; it never moves anything, and says so, with the way to the
 * proposals it made.
 */
async function runSweep(projectId = null, button = null) {
  const was = button ? button.textContent : null;
  if (button) { button.disabled = true; button.textContent = "Looking…"; }
  let r;
  try {
    r = await window.delphi.flags.sweep(projectId == null ? {} : { projectId });
  } catch (error) {
    notifyError(error);
    return;
  } finally {
    if (button) { button.disabled = false; button.textContent = was; }
  }
  reloadFlags();
  const made = (r && r.created) || [];
  const proposed = made.filter((f) => f.status === "proposed").length;
  const where = projectId == null ? "across every project" : `in ${projectNameOf(projectId)}`;
  const lead = made.length
    ? `${plural(proposed, "proposal", "proposals")} made ${where}${made.length > proposed ? `, and ${plural(made.length - proposed, "flag", "flags")} the Oracle was not sure enough about to propose anything` : ""}. Nothing has moved: each waits in Needs you for you to approve or reject.`
    : `Nothing looks misfiled ${where}.`;
  const skipped = r && r.skipped ? el("p", { className: "wb-lead", textContent: `${plural(r.skipped, "item was", "items were")} passed over: already flagged, a suggestion you rejected in the last 90 days, or past the limit of 20 at a time.` }) : null;
  const go = await wbDialog({
    title: made.length ? "The sweep is done" : "Nothing found",
    lead,
    body: [skipped],
    actions: made.length ? [{ label: "Close", value: false }, { label: "Open Needs you", kind: "primary", value: true }] : [{ label: "Close", kind: "primary", value: false }],
    cancelValue: false,
  });
  if (go) goTo({ projectId: null, view: "inbox", query: "" });
}

function sweepButton(projectId = null) {
  const b = el("button", { className: "btn", type: "button", textContent: "Find misfiled items" });
  b.title = "Flags notes, tasks and pads that look filed in the wrong project. It proposes; nothing moves until you approve.";
  b.onclick = () => runSweep(projectId, b);
  return b;
}

// ---------------------------------------------------------------------------
// D7: deleting a project whose items other projects still show

/**
 * Before a project goes, the items homed in it that other projects also
 * show. Deleting would take them from those projects too, so the choice is
 * to rehome them first or not to delete. Resolves true when the delete may
 * go on.
 */
async function rehomeBeforeDelete(project, counts) {
  if (!counts || !counts.shared_out || !window.delphi.items) return true;
  let planned;
  try { planned = await window.delphi.items.rehomePlan(project.id); } catch (error) { notifyError(error); return false; }
  const items = (planned && planned.items) || [];
  if (!items.length) return true;
  const ul = el("ul", { className: "rehome-list" });
  for (const it of items.slice(0, 12)) {
    const li = el("li", {}, el("span", { className: "kind sm", textContent: ITEM_NOUN[it.entity] || it.entity }),
      el("span", { textContent: it.label || `#${it.id}` }),
      el("span", { className: "hint", textContent: it.to ? `to ${it.to.name}` : "nowhere to go" }));
    ul.append(li);
    if (!it.ok) for (const r of it.refusals || []) ul.append(el("li", { className: "refusal", textContent: r }));
  }
  if (items.length > 12) ul.append(el("li", { className: "hint", textContent: `and ${items.length - 12} more` }));
  const blocked = items.filter((it) => !it.ok).length;
  const choice = await wbDialog({
    title: `${plural(items.length, "item", "items")} in ${project.name} ${items.length === 1 ? "is" : "are"} shown elsewhere`,
    lead: `Deleting ${project.name} would take ${items.length === 1 ? "it" : "them"} from those projects too. Rehome moves each one to the first other project that shows it, then the delete goes on.`,
    body: [el("div", { className: "grp" }, ul),
      blocked ? el("p", { className: "wb-lead", textContent: `${plural(blocked, "item cannot", "items cannot")} be moved yet, for the reasons above. Rehome stops before the delete if any are left.` }) : null],
    actions: [{ label: "Cancel", value: null }, { label: "Rehome, then delete", kind: "primary", value: "rehome" }],
    cancelValue: null,
  });
  if (choice !== "rehome") return false;
  let r;
  try { r = await window.delphi.items.rehome(project.id); } catch (error) { notifyRefusal(error); return false; }
  await refresh();
  if (r && r.refused && r.refused.length) {
    notify(`${plural(r.moved.length, "item was", "items were")} rehomed, but ${plural(r.refused.length, "was", "were")} refused, so ${project.name} was not deleted. ${r.refused.map((x) => x.reason).join(" ")}`, { error: true });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Reviewing a finished run, and the order of the queue

const reviewOn = () => Boolean(window.delphi.runs && typeof window.delphi.runs.review === "function");
const reorderOn = () => Boolean(window.delphi.runs && typeof window.delphi.runs.reorder === "function");
const reviewRuns = () => (reviewOn() ? state.runs.filter((r) => r.needs_review) : []);

/** Accept or Send back, with a note. Sending back needs one: it is the agent's next turn. */
async function reviewRunDialog(run) {
  const note = el("textarea", { className: "field", placeholder: "A note. Optional to accept; sending back needs one, and it becomes the agent's next turn." });
  let sendBack = null;
  const sync = () => { if (sendBack) sendBack.disabled = !note.value.trim(); };
  note.oninput = sync;
  const what = run.reply ? el("div", { className: "grp" }, el("div", { className: "grp-h", textContent: "What it said when it finished" }),
    el("div", { className: "wb-lead", style: "white-space:pre-wrap;max-height:180px;overflow-y:auto", textContent: run.reply })) : null;
  const bench = run.workbench && run.workbench.branch ? el("div", { className: "grp" },
    el("div", { className: "grp-h" }, "Its Workbench ", el("code", { textContent: run.workbench.branch })),
    el("div", { className: "hint", textContent: run.workbench.path || "" })) : null;
  const choice = await wbDialog({
    title: `Review ${run.task_id ? `#${run.task_id} ` : ""}${run.task_title || firstLineOf(run.request, 60)}`,
    lead: `${run.harness_label || run.harness} ${run.state === "failed" ? "stopped with a failure" : "finished"}${run.finished_at ? ` at ${clockWords(run.finished_at)}` : ""}. Accept clears it from Needs you; Send back gives it your note as its next turn.`,
    body: [what, bench, el("div", { className: "review-box" }, note)],
    actions: [
      { label: "Cancel", value: null },
      { label: "Send back", value: "back", bind: (b) => { sendBack = b; sync(); } },
      { label: "Accept", kind: "primary", value: "accept" },
    ],
    cancelValue: null,
    className: "review-dialog",
  });
  if (!choice) return;
  const text = note.value.trim() || null;
  let r;
  try {
    r = await window.delphi.runs.review(run.id, { accepted: choice === "accept", note: text });
  } catch (error) {
    notifyRefusal(error);
    reloadRuns();
    return;
  }
  reloadRuns();
  if (choice === "accept") { notify("Accepted."); return; }
  // Sending back records the note on the Sheet. Whether an agent carries on
  // now, and in which Workbench, is the next decision, and the dispatcher
  // hands over the request that would do it rather than starting one itself.
  const next = r && r.continue;
  if (!next || !next.available || !next.create) {
    notify(`Sent back, and your note is on the Sheet. ${next && next.why ? next.why : ""}`.trim());
    return;
  }
  const label = run.harness_label || agentLabel(run.harness);
  const carry = await wbDialog({
    title: "Sent back",
    lead: `Your note is on the Sheet. Hand it back to ${label} now, to carry on in the same Workbench${next.workbench && next.workbench.branch ? ` (${next.workbench.branch})` : ""} with your note as its next instruction?`,
    actions: [{ label: "Not now", value: false }, { label: `Hand it back to ${label}`, kind: "primary", value: true }],
    cancelValue: false,
  });
  if (!carry) return;
  await runAct(async () => {
    await window.delphi.runs.create(next.create);
    notify(`Handed back to ${label}. It starts when a slot is free.`);
  });
}

/** A finished run nobody has looked at, as Needs you shows it. */
function reviewRow(run) {
  const row = el("div", { className: "wr review" });
  row.dataset.row = `review-${run.id}`;
  const t = el("div", { className: "t" });
  if (run.task_id) t.append(el("b", { textContent: `#${run.task_id}` }), ` ${run.task_title || ""}`);
  else t.append(firstLineOf(run.request));
  const s = el("div", { className: "s" }, projectDot(run.project_id), el("span", { textContent: run.project_name || "" }),
    el("span", { className: "who", textContent: runWho(run) }));
  const began = TIME.parseStamp(run.started_at);
  const ended = TIME.parseStamp(run.finished_at);
  if (ended) s.append(el("span", { textContent: `${run.state === "failed" ? "failed" : "finished"} ${clockWords(run.finished_at)}${began ? ` in ${spanWords((ended - began) / 1000)}` : ""}` }));
  const main = el("div", { style: "min-width:0" }, el("span", { className: "k", textContent: run.state === "failed" ? "Problem" : "Review" }), t, s);
  if (run.reply) main.append(el("div", { className: "why", textContent: firstLineOf(run.reply, 240), title: run.reply }));
  const review = el("button", { className: "btn", type: "button", textContent: "Review" });
  review.onclick = () => reviewRunDialog(run);
  const buttons = [review];
  if (run.task_id) {
    const sheet = el("button", { className: "btn", type: "button", textContent: "Open Sheet" });
    sheet.onclick = () => openRunSheet(run);
    buttons.push(sheet);
  }
  const since = run.finished_at || run.updated_at;
  row.append(agentAvatar(run.harness, run.harness_label), main, el("div", { className: "side" },
    withData(el("div", { className: "when", textContent: spanWords(TIME.secondsSince(since)) }), { since }),
    el("div", { className: "acts" }, buttons)));
  return row;
}

/** Queued, first to run first: a person's ranking, then oldest. agent/jobs.js PICK_ORDER. */
const byQueueOrder = (a, b) => {
  const ra = a.queue_rank == null ? Infinity : a.queue_rank;
  const rb = b.queue_rank == null ? Infinity : b.queue_rank;
  return ra === rb ? a.id - b.id : ra - rb;
};

async function reorderQueue(ids) {
  await runAct(() => window.delphi.runs.reorder(ids));
}

// Which queued run is being dragged, by id. One at a time, page wide.
let queueDragId = null;

// ---------------------------------------------------------------------------
// Pins

// Pins live in settings.json as pinnedProjects. This window's storage held
// them before settings:set accepted the key, so any pins found there are
// handed to the setting once (migratePins) and the local copy is then
// dropped; until the main process keeps the key, the local copy stays the
// fallback rather than losing anyone's pins.
const PIN_KEY = "delphi.pinnedProjects";
const PIN_MOVED_KEY = "delphi.pinnedProjects.moved";
const cleanPins = (list) => (Array.isArray(list) ? list.map(Number).filter(Number.isInteger) : []);
const localPins = () => { try { return cleanPins(JSON.parse(localStorage.getItem(PIN_KEY) || "[]")); } catch { return []; } };
const pinsMoved = () => { try { return localStorage.getItem(PIN_MOVED_KEY) === "1"; } catch { return false; } };
function readPins(settings) {
  const kept = settings && Array.isArray(settings.pinnedProjects) ? cleanPins(settings.pinnedProjects) : null;
  if (kept && (kept.length || pinsMoved())) return kept;
  return localPins();
}
/** Hands this window's pins to the setting, once, if the main process will keep them. */
async function migratePins(settings) {
  if (pinsMoved()) return;
  const local = localPins();
  const kept = settings && Array.isArray(settings.pinnedProjects) ? cleanPins(settings.pinnedProjects) : null;
  if (kept && kept.length) {
    // The setting already has pins: it wins, and the local copy is history.
    try { localStorage.setItem(PIN_MOVED_KEY, "1"); localStorage.removeItem(PIN_KEY); } catch {}
    return;
  }
  if (!local.length) {
    if (kept) { try { localStorage.setItem(PIN_MOVED_KEY, "1"); } catch {} }
    return;
  }
  try {
    const saved = await window.delphi.settings.set({ pinnedProjects: local });
    if (saved && Array.isArray(saved.pinnedProjects) && cleanPins(saved.pinnedProjects).join(",") === local.join(",")) {
      state.settings = saved;
      try { localStorage.setItem(PIN_MOVED_KEY, "1"); localStorage.removeItem(PIN_KEY); } catch {}
    }
  } catch {}
}
async function setPinned(projectId, on) {
  const next = state.pinned.filter((id) => id !== projectId);
  if (on) next.push(projectId);
  state.pinned = next;
  if (!pinsMoved()) { try { localStorage.setItem(PIN_KEY, JSON.stringify(next)); } catch {} }
  renderSidebar();
  try {
    const saved = await window.delphi.settings.set({ pinnedProjects: next });
    if (saved) state.settings = saved;
    if (saved && Array.isArray(saved.pinnedProjects) && cleanPins(saved.pinnedProjects).join(",") === next.join(",") && !pinsMoved()) {
      try { localStorage.setItem(PIN_MOVED_KEY, "1"); localStorage.removeItem(PIN_KEY); } catch {}
    }
  } catch {}
}

// Hidden from Active. Kept in settings.json as [{ id, at }], written whole.
const cleanHidden = (list) => (Array.isArray(list) ? list : [])
  .filter((h) => h && Number.isInteger(Number(h.id)) && typeof h.at === "string")
  .map((h) => ({ id: Number(h.id), at: h.at }));

async function setHidden(projectId, on) {
  const next = state.hidden.filter((h) => h.id !== projectId);
  if (on) next.push({ id: projectId, at: TIME.toStamp(new Date()) });
  state.hidden = next;
  renderSidebar();
  try {
    const saved = await window.delphi.settings.set({ hiddenFromActive: next });
    if (saved) { state.settings = saved; state.hidden = cleanHidden(saved.hiddenFromActive); renderSidebar(); }
  } catch (error) { alert(error.message); }
}

// ---------------------------------------------------------------------------
// The sidebar

const ACTIVE_DAYS = 14;

/**
 * Which group each project is drawn in: Pinned, Active, or More projects.
 *
 * Active is worked out, not chosen: anything with an open job, or touched in
 * the last ACTIVE_DAYS. Hide from Active is the one way to overrule it, and it
 * lasts only until the project is touched again after the hide, so a project
 * someone put away comes back the moment there is something new in it rather
 * than staying lost. A pin outranks both.
 */
function sidebarGroups() {
  const { late, touched } = projectPulse();
  const busy = new Set();
  const running = new Set();
  for (const r of state.runs) {
    if (RUN_OPEN.includes(r.state)) busy.add(r.project_id);
    if (r.state === "running") running.add(r.project_id);
  }
  const cutoff = TIME.toStamp(new Date(Date.now() - ACTIVE_DAYS * 86400000));
  const hiddenAt = new Map(state.hidden.map((h) => [h.id, h.at]));
  // An agent working there now counts as touching it, so a project is never
  // tucked away while something is changing in it.
  const stillHidden = (p) => hiddenAt.has(p.id) && !running.has(p.id) && String(touched.get(p.id) || "") <= hiddenAt.get(p.id);
  const isActive = (p) => !stillHidden(p) && (busy.has(p.id) || String(touched.get(p.id) || "") >= cutoff);

  const byId = new Map(state.projects.map((p) => [p.id, p]));
  const pinned = state.pinned.map((id) => byId.get(id)).filter(Boolean);
  const pinnedIds = new Set(pinned.map((p) => p.id));
  const active = state.projects.filter((p) => !pinnedIds.has(p.id) && isActive(p));
  const activeIds = new Set(active.map((p) => p.id));
  const rest = state.projects.filter((p) => !pinnedIds.has(p.id) && !activeIds.has(p.id));
  return { pinned, active, rest, late, touched, stillHidden, groupOf: (p) =>
    pinnedIds.has(p.id) ? "pinned" : activeIds.has(p.id) ? "active" : "rest" };
}

/** Per project: open tasks overdue, and the newest time anything in it was touched. */
function projectPulse() {
  const late = new Map();
  const touched = new Map();
  for (const t of state.everyTask) {
    if (isOverdue(t)) late.set(t.project_id, (late.get(t.project_id) || 0) + 1);
    const at = t.updated_at || t.created_at;
    if (at && String(at) > String(touched.get(t.project_id) || "")) touched.set(t.project_id, at);
  }
  for (const p of state.projects) {
    if (p.updated_at && String(p.updated_at) > String(touched.get(p.id) || "")) touched.set(p.id, p.updated_at);
  }
  return { late, touched };
}

function sidebarPlace() {
  if (state.query || state.projectId) return null;
  if (state.view === "runs") return "runs";
  if (state.view === "inbox") return "inbox";
  if (state.view === "graph") return "memory";
  return state.todayPick ? "today" : "all";
}

/**
 * The sidebar, repainted only when what it shows has changed.
 *
 * Every runs-changed used to rebuild it, about once a second while any agent
 * was working, and each rebuild dropped keyboard focus to the page and could
 * swallow a click that landed mid-rebuild. Its inputs are few, so they are
 * compared first, and a repaint that does happen puts focus back on the same
 * row.
 */
let sidebarSig = null;
function renderSidebar() {
  // Direction B: the sidebar is not drawn, and the one part of it still in use,
  // a project's AI sessions, lives in the top area's menu. Every caller that
  // repainted the sidebar repaints that instead. Remove this line to go back.
  if (window.DelphiTopbar) { DelphiTopbar.refreshSessions(); return; }
  const { late, touched } = projectPulse();
  const sig = JSON.stringify([
    state.projects, state.pinned, state.hidden, state.sessionsAllFor, state.archivedOpenFor, (state.archivedSessions || []).map((x) => [x.id, x.title]), state.harnesses.map((h) => h.label), !!state.restOpen, state.projectId, state.view, state.query, sidebarPlace(),
    state.runs.map((r) => [r.project_id, r.state]), needsYouTotal(),
    [...late], [...touched], (state.sessions || []).map((x) => [x.id, x.title, x.run_state, x.harness, sessionAgo(sessionLastActive(x))]), state.sessionId, state.pane,
    state.workspaces, state.workspaceId,
  ]);
  if (sig === sidebarSig && $("projects").childNodes.length) return;
  if (pointerDown && $("projects").childNodes.length) { afterPointer.add(renderSidebar); return; }
  sidebarSig = sig;
  const key = focusKey(document.activeElement);
  paintSidebar();
  if (key && key.scope === "side") restoreFocus(key);
}

function paintSidebar() {
  const box = $("projects");
  const foot = $("sidebar-foot");
  box.textContent = "";
  foot.textContent = "";
  box.parentElement.classList.add("home");
  foot.classList.add("home");
  box.onkeydown = sidebarArrows;

  const place = sidebarPlace();
  const running = runsIn(["running"]);
  const waiting = needsYouTotal();
  // The same count All work's header gives, from the same list.
  const openTasks = state.everyTask.filter((t) => t.status !== "done").length;
  const notes = state.projects.reduce((n, p) => n + (p.note_count || 0), 0);

  const navRow = (key, icon, label, right, go) => {
    const row = el("div", { className: "proj" + (place === key ? " active" : ""), tabIndex: 0, role: "button" });
    row.dataset.row = "nav-" + key;
    if (place === key) row.setAttribute("aria-current", "page");
    row.append(el("span", { className: "ico" }, homeIcon(icon)), el("span", { className: "proj-name", textContent: label }));
    if (right) row.append(right);
    const open = () => { $("search").value = ""; go(); };
    row.onclick = open;
    row.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    return row;
  };
  const count = (n) => (n ? el("span", { className: "count", textContent: String(n) }) : null);
  const nav = el("div", { className: "nav" });
  nav.append(
    // Today is not built yet; until it is, it opens All work rather than an
    // empty page, and says so on hover.
    Object.assign(navRow("today", "sun", "Today", null, () => navigate({ projectId: null, view: "new", query: "", todayPick: true })),
      { title: "Today is on its way. For now it opens All work." }),
    navRow("inbox", "inbox", "Needs you", waiting ? el("span", { className: "badge hot", textContent: String(waiting) }) : null,
      () => navigate({ projectId: null, view: "inbox", query: "" })),
    navRow("runs", "runs", "Runs", running.length ? el("span", { className: "badge live" }, el("span", { className: "live-dot" }), String(running.length)) : null,
      () => navigate({ projectId: null, view: "runs", query: "" })),
    navRow("all", "list", "All work", count(openTasks), () => navigate({ projectId: null, view: "new", query: "", todayPick: false })),
    navRow("memory", "memory", "Memory", count(notes), () => navigate({ projectId: null, view: "graph", query: "", todayPick: false })),
  );
  box.append(nav, el("div", { className: "side-sep" }));

  if (!state.projects.length) {
    box.append(el("div", { className: "pp-empty", textContent: "No projects yet. Make one with New project below, or file a task from an agent." }));
  }

  const { pinned, active, rest, late } = sidebarGroups();
  const agentsOn = new Map();
  for (const r of state.runs) {
    if (r.state === "running") agentsOn.set(r.project_id, (agentsOn.get(r.project_id) || 0) + 1);
  }

  const row = (p, { outside = false } = {}) => {
    const on = p.id === state.projectId;
    const r = el("div", { className: "proj sb-proj" + (p.open_count ? "" : " quiet") + (on ? " active" : "") + (outside ? " outside" : ""), tabIndex: 0, role: "button" });
    if (on) r.setAttribute("aria-current", "page");
    r.dataset.row = "proj-" + p.id;
    r.title = p.open_count ? `${p.name}\n${plural(p.open_count, "open task", "open tasks")}` : p.name;
    r.append(el("span", { className: "dot", style: `background:${safeColour(p.colour)}` }),
      el("span", { className: "proj-name", textContent: p.name }));
    // The folder icon gives way to the open tag there, so the name keeps room.
    if (p.path && !outside) { const f = homeIcon("folder", "fold"); f.append(Object.assign(document.createElementNS("http://www.w3.org/2000/svg", "title"), { textContent: p.path })); r.append(f); }
    const n = agentsOn.get(p.id);
    if (n) r.append(el("span", { className: "ag", title: `${plural(n, "agent", "agents")} working here now` }, el("span", { className: "live-dot" }), String(n)));
    // Said in words, because the open project drawn under a folded More
    // projects otherwise looks as if it belonged to the group above the fold.
    if (outside) {
      r.append(el("span", { className: "open-tag", textContent: "open" }));
      r.title += "\nOpen now. It lives under More projects.";
    }
    const od = late.get(p.id);
    if (od) r.append(el("span", { className: "od", textContent: `${od} late` }));
    r.append(el("span", { className: "count", textContent: p.open_count ? String(p.open_count) : "" }));
    // Its Overview, never its chat. Landing on chat used to put a "+ New
    // session" row right under the pointer that had just clicked, and a
    // session made by a stray click is clutter nobody knew how to remove.
    const open = () => { $("search").value = ""; navigate({ projectId: p.id, view: "overview", query: "" }); };
    r.onclick = open;
    r.onkeydown = (e) => {
      if (e.target !== r) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); projectMenu(p, null, null, more, true); }
    };
    r.oncontextmenu = (e) => { e.preventDefault(); projectMenu(p, e.clientX, e.clientY, more); };
    const more = el("button", { className: "proj-more", type: "button", textContent: "\u22ef", title: "Pin, hide or more" });
    more.setAttribute("aria-label", `Actions for ${p.name}`);
    more.setAttribute("aria-haspopup", "menu");
    more.onclick = (e) => { e.stopPropagation(); projectMenu(p, null, null, more, e.detail === 0); };
    r.append(more);
    if (!on) return [r];
    // The open project keeps its sessions under it, so a conversation is one
    // click away from wherever the project was opened.
    const kids = sessionKids();
    kids.className = "sb-kids";
    return [r, kids];
  };

  if (pinned.length) {
    box.append(el("div", { className: "side-label" }, "Pinned"));
    pinned.forEach((p) => box.append(...row(p)));
  }
  if (active.length) {
    box.append(el("div", { className: "side-label" }, "Active", el("span", { className: "grow" }), el("span", { className: "n", textContent: `last ${ACTIVE_DAYS} days` })));
    active.forEach((p) => box.append(...row(p)));
  }
  if (rest.length) {
    const fold = el("div", { className: "fold-row" + (state.restOpen ? " open" : ""), tabIndex: 0, role: "button" });
    fold.dataset.row = "fold";
    fold.setAttribute("aria-expanded", String(!!state.restOpen));
    // "More projects (14)" rather than "Everything else" and a bare number,
    // which read as a place of its own rather than as the rest of this list.
    const word = pinned.length || active.length ? "More projects" : "Projects";
    fold.append(el("span", { className: "car", textContent: "▸" }), el("span", { className: "grow", textContent: `${word} (${rest.length})` }));
    fold.title = `Projects with nothing new in the last ${ACTIVE_DAYS} days, or hidden from Active. Right click a project to pin or hide it.`;
    const lateInside = rest.reduce((n, p) => n + (late.get(p.id) || 0), 0);
    // Folded only: open, each row below says its own.
    if (!state.restOpen && lateInside) fold.append(el("span", { className: "od", textContent: `${lateInside} late` }));
    // Remembered in this window's storage: it is a view preference, and losing
    // it to private storage costs nothing worse than a closed fold.
    const toggle = () => {
      state.restOpen = !state.restOpen;
      try { localStorage.setItem("delphi.sidebar.moreOpen", state.restOpen ? "1" : "0"); } catch {}
      renderSidebar();
    };
    fold.onclick = toggle;
    fold.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
    box.append(fold);
    if (state.restOpen) rest.forEach((p) => box.append(...row(p)));
    // Folded, the open project still shows, so the sidebar never hides where
    // you are; marked, so it is plain why it is there.
    else rest.filter((p) => p.id === state.projectId).forEach((p) => box.append(...row(p, { outside: true })));
  }

  const add = el("button", { className: "btn wide", type: "button" }, homeIcon("plus"), "New project");
  add.onclick = () => createProject();
  const gear = el("button", { className: "btn gear", type: "button", title: state.projectId ? "Settings for this project" : "Settings" }, homeIcon("gear"));
  gear.setAttribute("aria-label", gear.title);
  gear.onclick = () => navigate(state.projectId ? { view: "project" } : { projectId: null, view: "settings", query: "" });
  foot.append(add, gear);
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
    if (state.query) state.view = "oracle";
    else state.view = state.projectId ? "overview" : "new";
    refresh();
  }, 140);
});


// ---------------------------------------------------------------------------
// Project rail
//
// The far-left column of project tiles, the way Slack and Granular both do it.
// It is painted from renderSidebar so the rail and the sidebar list are built in
// one pass and cannot end up disagreeing about which project is open.

/** The letter shown when a project has no icon of its own. */
const railLetter = (name) => {
  const first = String(name || "?").trim()[0];
  return (first || "?").toUpperCase();
};

/**
 * The rail, which has two states.
 *
 * Zoomed out, it shows every workspace: the picker. Zoomed in, the chosen one
 * has moved to the top under the mark and the rest are gone. That movement is
 * the whole point of the interaction, so it is animated rather than swapped:
 * the tile you clicked travels to where it is going, which is what tells you
 * the others were put away rather than lost.
 *
 * Done with FLIP. The tiles are measured where they are, the rail is rebuilt in
 * its new state, and each surviving tile is transformed back to where it was and
 * released. That way the animation always matches the layout, however the layout
 * was reached.
 */
// Which workspace is being dragged, if any. Module scope rather than state,
// because it lives and dies inside one gesture and nothing renders from it.
let dragging = null;

function renderRail() {
  const rail = $("rail");
  if (!rail) return;

  // Where every tile is now, before anything moves.
  const before = new Map();
  for (const node of rail.querySelectorAll("[data-ws]")) {
    before.set(node.dataset.ws, node.getBoundingClientRect().top);
  }

  rail.textContent = "";

  const home = el("button", {
    className: "rail-mark" + (state.workspaceId === null ? " on" : ""),
    type: "button",
    title: "Every workspace and project",
  });
  home.append(el("img", { src: "assets/mark-64.png", width: 26, height: 26, alt: "Delphi" }));
  home.onclick = () => zoomOut();
  rail.append(home, el("div", { className: "rail-div" }));

  const open = state.workspaces.find((w) => w.id === state.workspaceId) || null;
  // Zoomed in shows only the one that is open, so the column reads as "you are
  // here" rather than as a list with one item highlighted.
  const shown = open ? [open] : state.workspaces;

  for (const w of shown) {
    const tile = el("div", {
      className: "rail-tile" + (w.id === state.workspaceId ? " on" : ""),
      tabIndex: 0,
      role: "button",
      title: open ? `${w.name}\n${w.path}\nClick to switch workspace` : `${w.name}\n${w.path}`,
    });
    tile.dataset.ws = String(w.id);
    tile.dataset.name = w.name;
    tile.textContent = w.icon || railLetter(w.name);

    // Draggable only in the picker. Zoomed in there is one tile, and dragging it
    // could only ever put it back where it was.
    if (!open) {
      tile.draggable = true;
      tile.ondragstart = (e) => {
        beginDrag(rail, w.id);
        tile.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        // Firefox refuses to start a drag unless something is on the transfer.
        e.dataTransfer.setData("text/plain", String(w.id));
      };
      tile.ondragend = () => endDrag(rail);
    }
    if (w.colour && !w.icon) tile.style.color = safeColour(w.colour, "");

    // Clicking the open one goes back to the picker, which is how you switch
    // without a separate control taking up room in a 48px column.
    const go = () => (w.id === state.workspaceId ? zoomOut() : zoomInto(w.id));
    tile.onclick = go;
    tile.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    tile.oncontextmenu = (e) => { e.preventDefault(); workspaceMenu(w, e.clientX, e.clientY); };
    rail.append(tile);

    window.delphi.fs.folderExists(w.path)
      .then((there) => { if (!there) tile.classList.add("lost"); })
      .catch(() => {});
  }

  // The column reacts to the drag as a whole. Per-tile handlers could only draw
  // a line on the tile under the pointer, which is not enough to see where the
  // thing will land; the tiles move aside instead, which is.
  if (!open && state.workspaces.length > 1) {
    rail.ondragover = (e) => {
      if (dragging === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      shiftForDrop(rail, dropIndexAt(e.clientY));
    };
    rail.ondragleave = (e) => {
      // Only when the pointer has actually left the rail, not when it crosses
      // from one tile to the next inside it.
      if (e.relatedTarget && rail.contains(e.relatedTarget)) return;
      shiftForDrop(rail, null);
    };
    rail.ondrop = async (e) => {
      if (dragging === null) return;
      e.preventDefault();
      const at = dropIndexAt(e.clientY);
      const moved = dragging;
      endDrag(rail);
      await reorderWorkspaceTo(moved, at);
    };
  }

  const add = el("div", {
    className: "rail-tile rail-add",
    tabIndex: 0,
    role: "button",
    title: "Add a workspace",
  });
  add.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  add.onclick = addWorkspace;
  add.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); addWorkspace(); } };
  rail.append(el("div", { className: "rail-sp" }), el("div", { className: "rail-div" }), add);

  // Second half of the FLIP: put each surviving tile back where it was, then let
  // it travel. Skipped entirely when motion is off, in which case the layout
  // simply changes, which is the correct behaviour rather than a lesser one.
  if (motionOff()) return;
  for (const node of rail.querySelectorAll("[data-ws]")) {
    const was = before.get(node.dataset.ws);
    if (was === undefined) continue;
    const delta = was - node.getBoundingClientRect().top;
    if (!delta) continue;
    node.style.transform = `translateY(${delta}px)`;
    node.style.transition = "none";
    requestAnimationFrame(() => {
      node.style.transition = "transform 260ms cubic-bezier(.2,.7,.3,1)";
      node.style.transform = "";
    });
  }
}



// A tile is 36px square with 8px between them, so one step is a whole slot.
const RAIL_STEP = 44;

// Measured once, when the drag starts. The tiles move while it is happening, so
// reading their live positions to decide where the pointer is would be reading
// the effect of the last decision: the gap chases the pointer and jitters.
let dragBase = null;   // [{ id, mid }] in column order, unshifted
let dragFrom = null;   // the dragged tile's index in that column

function beginDrag(rail, id) {
  dragging = id;
  const tiles = [...rail.querySelectorAll("[data-ws]")];
  dragBase = tiles.map((n) => {
    const box = n.getBoundingClientRect();
    return { id: Number(n.dataset.ws), mid: box.top + box.height / 2 };
  });
  dragFrom = dragBase.findIndex((t) => t.id === id);
}

/**
 * Where the dragged tile would land, as an index among the tiles that are not it.
 *
 * Against the baseline midpoints, so crossing halfway past a tile is what moves
 * the gap, and the answer does not depend on how far things have already slid.
 */
function dropIndexAt(y) {
  if (!dragBase) return 0;
  const others = dragBase.filter((t) => t.id !== dragging);
  for (let i = 0; i < others.length; i++) {
    if (y < others[i].mid) return i;
  }
  return others.length;
}

/**
 * Moves the tiles that the drop would displace, and only those.
 *
 * The dragged tile stays where it is, faded, still taking up its slot. That is
 * the part the first attempt got wrong: it opened a gap at the target while the
 * original slot was still occupied, so the column showed two gaps and something
 * appeared to move the instant anything was picked up.
 *
 * Each tile is asked where it sits now and where it would sit afterwards, and
 * moved by the difference. When the drop would not change the order, every
 * difference is zero and nothing moves, which is the behaviour you actually want:
 * the column is still until hovering somewhere that means something.
 */
function shiftForDrop(rail, at) {
  if (dragFrom === null) return;
  const others = [...rail.querySelectorAll("[data-ws]")]
    .filter((n) => Number(n.dataset.ws) !== dragging);

  others.forEach((node, i) => {
    node.classList.add("shifting");
    if (at === null) { node.style.transform = ""; return; }
    // Its slot now, and its slot after the move. Tiles before the dragged one
    // keep their index; tiles after it sit one lower than their index suggests.
    const now = i < dragFrom ? i : i + 1;
    const next = i < at ? i : i + 1;
    const delta = next - now;
    node.style.transform = delta ? `translateY(${delta * RAIL_STEP}px)` : "";
  });
}

/** Puts everything back and forgets the drag. */
function endDrag(rail) {
  dragging = null;
  dragBase = null;
  dragFrom = null;
  for (const node of rail.querySelectorAll("[data-ws]")) {
    node.classList.remove("dragging", "shifting");
    node.style.transform = "";
  }
}

/** Moves a workspace to a position in the column. */
async function reorderWorkspaceTo(movedId, index) {
  const order = state.workspaces.map((w) => w.id).filter((id) => id !== movedId);
  order.splice(Math.max(0, Math.min(index, order.length)), 0, movedId);
  // The whole column is renumbered rather than the moved row alone. Nudging one
  // value works until two rows share an order, and then the sequence depends on
  // whatever the database returns second.
  await Promise.all(order.map((id, i) =>
    window.delphi.workspaces.update(id, { sort_order: (i + 1) * 10 })));
  await refresh();
}

/** Opens a workspace, and lands on the project you were last in if it fits. */
async function zoomInto(workspaceId) {
  mindMap.selected = null;
  mindMap.context = null;
  state.workspaceId = workspaceId;
  const inside = await window.delphi.workspaces.projects(workspaceId);
  state.wsProjects = inside;
  // Staying on a project that does not belong to this folder would show its
  // sessions under a workspace they have nothing to do with.
  if (!inside.some((p) => p.id === state.projectId)) {
    state.projectId = inside.length === 1 ? inside[0].id : null;
    state.sessionId = null;
    state.messages = [];
  }
  state.view = state.projectId ? "chat" : "new";
  await refresh();
}

/** Back to the picker. */
async function zoomOut() {
  // So the map does not stay pinned to the workspace that was just left.
  mindMap.selected = null;
  mindMap.context = null;
  state.workspaceId = null;
  state.wsProjects = [];
  state.projectId = null;
  state.sessionId = null;
  state.messages = [];
  state.view = "new";
  await refresh();
}

/** Adds a folder as a workspace. */
async function addWorkspace() {
  const folder = await window.delphi.dialog.pickFolder(
    "Choose a folder, or make a new one",
    { defaultPath: lastWorkspaceParent(), buttonLabel: "Use this folder" }
  );
  if (!folder) return;
  const created = await window.delphi.workspaces.create({ path: folder });
  await refresh();
  await zoomInto(created.id);
}

/** Where the picker should open: beside the workspaces already known. */
function lastWorkspaceParent() {
  for (let i = state.workspaces.length - 1; i >= 0; i--) {
    const cut = state.workspaces[i].path.lastIndexOf("/");
    if (cut > 0) return state.workspaces[i].path.slice(0, cut);
  }
  return null;
}

function workspaceMenu(w, x, y) {
  rowMenu(x, y, [
    { label: "Reveal in Finder", run: async () => window.delphi.fs.reveal(w.path) },
    {
      label: "Rename",
      run: async () => {
        const name = await askText({
          title: "Rename workspace", label: "What should this folder be called here?",
          value: w.name, confirmLabel: "Rename",
        });
        if (!name) return;
        await window.delphi.workspaces.update(w.id, { name });
        await refresh();
      },
    },
    "-",
    {
      label: "Remove from Delphi",
      danger: true,
      run: async () => {
        // Says what it does not do, because "remove" next to a folder reads as
        // deleting one.
        await window.delphi.workspaces.remove(w.id);
        if (state.workspaceId === w.id) await zoomOut(); else await refresh();
      },
    },
  ]);
}
// ---------------------------------------------------------------------------
// Chat
//
// A session is a conversation held against a project. The layout is Granular's:
// a stream where only the person's turns are bubbles, a composer with no send
// button, a row of model and permission chips, and a token meter.

// The personas, and what each one actually changes.
//
// A persona is a system prompt and nothing more. It is worth being plain about
// that: it does not give an agent different abilities, it tells the same agent
// what kind of help is wanted, which is the difference between a reply that
// starts writing code and one that starts asking what the goal is.
const AGENTS = [
  {
    id: "boss",
    label: "Boss Agent",
    blurb: "Plans the work and hands it out",
    prompt:
      "You coordinate work rather than doing all of it yourself. Start by making sure you " +
      "understand what is actually being asked, and say what you would do before doing it. " +
      "Break a large request into pieces, name which piece you are on, and say plainly when " +
      "a piece is blocked or belongs to someone else. Prefer asking one sharp question over " +
      "guessing at an ambiguous requirement.",
  },
  {
    id: "builder",
    label: "Builder",
    blurb: "Writes and changes code",
    prompt:
      "You write and change code in this project. Match the surrounding style rather than " +
      "importing your own. Explain why a change is the right one, not what the lines do. " +
      "When something is risky or irreversible, say so before doing it. If you cannot verify " +
      "a change, say that rather than implying it works.",
  },
  {
    id: "designer",
    label: "Designer",
    blurb: "Interface, layout and visual detail",
    prompt:
      "You work on how things look and how they are used. Reason about hierarchy, spacing, " +
      "contrast and state before reaching for colour. Respect the design tokens already in " +
      "the project instead of introducing new values. Consider the empty, loading, error and " +
      "too-much-content cases, which is where interfaces usually fail.",
  },
  {
    id: "content",
    label: "Content creator",
    blurb: "Writing, docs and copy",
    prompt:
      "You write prose: documentation, copy, release notes, explanations. Write plainly, in " +
      "the voice already used in this project. Lead with what the reader needs. Do not pad, " +
      "and do not use em dashes or en dashes; plain hyphens only.",
  },
  {
    id: "data",
    label: "Data analyst",
    blurb: "Queries, numbers and what they mean",
    prompt:
      "You work with data. State the question before the answer, show the query or the method " +
      "you used, and give the numbers with enough context to judge them. Be explicit about " +
      "what a figure does not tell us and where it could be misleading.",
  },
  {
    id: "assistant",
    label: "Personal assistant",
    blurb: "Errands, summaries and tracking",
    prompt:
      "You handle the small things: summarising, drafting, chasing, keeping track. Be brief. " +
      "Give the answer first and the detail underneath, and offer to do the next obvious step " +
      "rather than describing how it could be done.",
  },
];

const agentById = (id) => AGENTS.find((a) => a.id === id) || AGENTS[0];

const STARTERS = [
  ["Design System", "Colors, type, spacing, defined once"],
  ["Project Brain", "A living roadmap from your docs"],
  ["Live Dashboard", "Your daily numbers on one page"],
  ["Deep Research", "A sourced point of view"],
];

const currentSession = () => state.sessions.find((x) => x.id === state.sessionId) || null;

async function openSession(id) {
  resetHistory();
  state.sessionId = id;
  state.messages = id ? await window.delphi.messages.list(id) : [];
  // The strip follows the session, not the other way around. Picking a Codex
  // conversation out of the sidebar has to land on the Codex tab, or the tab
  // showing and the conversation showing disagree.
  const session = state.sessions.find((x) => x.id === id);
  if (state.pane !== "terminal") state.pane = session && session.harness ? `h:${session.harness}` : "chat";
  render();
}

/**
 * Opens the tab for one harness, making its session if there is not one yet.
 *
 * A tab is a session, so switching to Codex means finding this project's most
 * recent Codex conversation rather than starting a new one every time. That is
 * what makes the strip feel like tabs instead of like a launcher.
 */
async function openHarness(key) {
  const project = currentProject();
  if (!project) return;
  state.pane = `h:${key}`;
  const existing = state.sessions.find((x) => x.harness === key);
  if (existing) { await openSession(existing.id); return; }

  const harness = state.harnesses.find((h) => h.key === key);
  const created = await window.delphi.sessions.create({
    projectId: project.id,
    title: harness ? harness.label : key,
    harness: key,
    cwd: sessionFolder({ project_id: project.id }),
  });
  state.sessions = await window.delphi.sessions.list(project.id);
  await openSession(created.id);
}


/**
 * The folder a session runs in: the one it was started in, then its
 * project's. The rule workbench/folders.js gives the main process, less the
 * disk check, which the window cannot make; the main process makes it when the
 * session starts. A session that recorded only a workspace had that folder
 * written into its cwd by the folder migration.
 */
function sessionFolder(session) {
  if (session && session.cwd) return session.cwd;
  const project = (session && session.project_id != null ? projectById(session.project_id) : null) || currentProject();
  return project && project.path ? project.path : null;
}

async function newSession() {
  const project = currentProject();
  if (!project) return;
  const created = await window.delphi.sessions.create({
    projectId: project.id,
    // The Boss is the safe default: it plans and asks before it acts, which is
    // the right first behaviour when nobody has chosen anything yet.
    agent: "boss",
    provider: null,
    // The folder it runs in: the project's, written down now so the session
    // keeps it if the project's folder changes later.
    cwd: sessionFolder({ project_id: project.id }),
  });
  state.sessions = await window.delphi.sessions.list(project.id);
  await openSession(created.id);
}


// Aliases the CLI understands, plus the explicit ids. "Auto" means send nothing
// and let the tool pick, which is what it does best.
const MODELS = [
  [null, "Auto"],
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
];

/** The folder a session runs in, named for a sentence. */
function runningInLabel(session) {
  const folder = sessionFolder(session);
  return folder ? folder.split("/").pop() : "this project";
}


// ---------------------------------------------------------------------------
// Terminal
//
// Not a real terminal, and it says so. A true one needs a pty, which needs a
// native module, and this app deliberately has none: the README's claim that
// there is nothing to rebuild when Electron updates is the reason it keeps
// working. So this runs commands and shows what they print. Anything that draws
// its own screen, vim or top, will not work here.

/** The id the running command is filed under, one per session. */
const termId = () => `s${state.sessionId || 0}`;

async function runCommand(command) {
  const text = String(command || "").trim();
  if (!text || state.termBusy) return;
  const folder = sessionFolder(currentSession());
  if (!folder) {
    state.termLines.push({ kind: "err", text: "This project has no folder, so there is nowhere to run a command." });
    render();
    return;
  }

  state.termDraft = "";
  resetHistory();
  state.termLines.push({ kind: "cmd", text });
  state.termBusy = true;
  render();

  try {
    await window.delphi.term.start({ id: termId(), cwd: folder, command: text });
  } catch (error) {
    state.termBusy = false;
    state.termLines.push({ kind: "err", text: String(error.message || error) });
    render();
  }
}

// Registered once, at module scope, for the same reason the model stream is.
let termPaint = null;
window.delphi.onTermEvent((event) => {
  if (event.id !== termId()) return;

  if (event.type === "output") {
    const last = state.termLines[state.termLines.length - 1];
    // Appended to the previous chunk rather than pushed as a new line, because a
    // stream arrives in arbitrary pieces and one write is not one line.
    if (last && last.kind === "out") last.text += event.text;
    else state.termLines.push({ kind: "out", text: event.text });
  } else if (event.type === "error") {
    state.termLines.push({ kind: "err", text: event.message });
  } else if (event.type === "exit") {
    state.termBusy = false;
    const bits = [];
    if (event.code !== 0) bits.push(`exit ${event.code}`);
    if (event.signal) bits.push(event.signal);
    if (event.dropped) bits.push(`${Math.round(event.dropped / 1024)}KB of output dropped`);
    if (bits.length) state.termLines.push({ kind: "meta", text: bits.join(" · ") });
  }

  // On a frame, not per chunk. A build printing thousands of lines would
  // otherwise re-render the window for each one.
  if (!termPaint) {
    termPaint = requestAnimationFrame(() => {
      termPaint = null;
      if (state.view === "chat" && state.pane === "terminal") render();
    });
  }
});

/** ~/va/caseflow rather than the whole path, which is what a shell shows. */
function shortPath(folder) {
  if (!folder) return "";
  const home = "/Users/";
  if (!folder.startsWith(home)) return folder;
  const rest = folder.slice(home.length).split("/").slice(1).join("/");
  return rest ? `~/${rest}` : "~";
}

function renderTerminal(wrap) {
  const folder = sessionFolder(currentSession());
  const where = shortPath(folder);

  // One dark surface holding the scrollback and the prompt, rather than an
  // output box with a form field under it. A terminal is a single screen you
  // type into, and the separation was the thing making it read as chat.
  const screen = el("div", { className: "term" });
  const out = el("div", { className: "term-out" });

  if (!state.termLines.length) {
    out.append(el("div", { className: "term-empty" },
      el("div", { textContent: folder
        ? "Real commands, real output."
        : "No folder linked to this workspace, so there is nothing to run in." }),
      el("div", { textContent: "Anything that draws its own screen, like vim or top, will not work here." })));
  }

  for (const line of state.termLines) {
    if (line.kind === "cmd") {
      out.append(el("div", { className: "term-cmd" },
        el("span", { className: "term-where", textContent: where }),
        el("span", { className: "term-sigil", textContent: "%" }),
        el("span", { className: "term-typed", textContent: line.text })));
    } else {
      out.append(el("pre", { className: `term-line ${line.kind}`, textContent: line.text }));
    }
  }

  // The prompt is the last line of the scrollback, not a separate control, so
  // the caret sits where the next output will appear.
  const prompt = el("div", { className: "term-prompt-row" });
  prompt.append(
    el("span", { className: "term-where", textContent: where }),
    el("span", { className: "term-sigil", textContent: state.termBusy ? "…" : "%" })
  );

  const box = el("textarea", {
    className: "term-input",
    rows: 1,
    placeholder: state.termBusy ? "" : "",
    value: state.termDraft,
    spellcheck: false,
    disabled: !folder,
  });
  box.oninput = () => {
    state.termDraft = box.value;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  };
  box.onkeydown = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); box.blur(); return; }
    const ran = state.termLines.filter((l) => l.kind === "cmd").map((l) => l.text).reverse();
    if (!state.termBusy && recallHistory(e, box, ran, (text) => { state.termDraft = text; })) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // While something runs, Enter feeds it a line rather than starting a
      // second command on top of the first.
      if (state.termBusy) {
        window.delphi.term.write(termId(), `${box.value}\n`);
        box.value = "";
        state.termDraft = "";
        return;
      }
      runCommand(box.value);
    }
  };
  prompt.append(box);

  if (state.termBusy) {
    const stop = el("button", { className: "term-stop", textContent: "stop" });
    stop.title = "Stop the running command";
    stop.onclick = () => window.delphi.term.stop(termId());
    prompt.append(stop);
  }

  out.append(prompt);
  screen.append(out);
  screen.onmousedown = (e) => {
    // Only when the click was on the surface itself. Selecting output text has
    // to keep working, so a click that landed on a line is left alone.
    if (e.target === screen || e.target === out) {
      e.preventDefault();
      box.focus();
    }
  };
  wrap.append(screen);

  requestAnimationFrame(() => {
    out.scrollTop = out.scrollHeight;
    if (folder) box.focus();
  });
}

// ---------------------------------------------------------------------------
// Recalling what you typed
//
// Up walks back through what you sent, Down walks forward, and coming back past
// the newest restores whatever you were part way through writing. That last part
// is the one people notice when it is missing: without it, pressing Up once
// destroys an unsent message.
//
// Only from the first line, so Up still moves the caret inside a reply being
// composed over several lines, which is what it does in every other text box.

let histIndex = -1;      // -1 is "not browsing"
let histSaved = "";      // the draft that was in progress when browsing started

/** Resets the walk. Called whenever the composer's contents come from elsewhere. */
function resetHistory() {
  histIndex = -1;
  histSaved = "";
}

/**
 * Handles Up and Down in a composer.
 *
 * Returns true when it took the key, so the caller can leave it alone otherwise.
 * `entries` is newest first. `apply` is given the text to show.
 */
function recallHistory(e, box, entries, apply) {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;
  if (!entries.length) return false;

  const caret = box.selectionStart;
  const before = box.value.slice(0, caret);
  const onFirstLine = !before.includes("\n");
  const onLastLine = !box.value.slice(caret).includes("\n");

  if (e.key === "ArrowUp") {
    if (!onFirstLine) return false;
    if (histIndex === -1) histSaved = box.value;
    if (histIndex >= entries.length - 1) return false;
    histIndex += 1;
  } else {
    if (!onLastLine || histIndex === -1) return false;
    histIndex -= 1;
  }

  const text = histIndex === -1 ? histSaved : entries[histIndex];
  e.preventDefault();
  apply(text);
  box.value = text;
  // Caret to the end, which is where you want it when the point is to edit and
  // send again rather than to read.
  requestAnimationFrame(() => {
    box.focus();
    box.setSelectionRange(text.length, text.length);
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
  });
  return true;
}


/**
 * Shown between asking and the first word coming back.
 *
 * A model can take several seconds to start, and an empty element for that long
 * reads as a question that went nowhere. After a few seconds it starts counting,
 * because a wait you can see the length of is a wait rather than a hang.
 */
function thinkingIndicator() {
  const box = el("div", { className: "thinking" });
  const dots = el("span", { className: "thinking-dots" });
  dots.append(el("i"), el("i"), el("i"));
  const label = el("span", { className: "thinking-label", textContent: "Thinking" });
  box.append(dots, label);

  const started = Date.now();
  const tick = setInterval(() => {
    // Removed from the document the moment the first text lands, since the
    // stream replaces the whole node, so this is how the timer learns to stop.
    if (!box.isConnected) { clearInterval(tick); return; }
    const seconds = Math.round((Date.now() - started) / 1000);
    // What it is doing, when it has said. A harness that has been quiet for
    // ninety seconds because it is running a test suite looks identical to one
    // that has hung, and the tool name is the difference.
    if (state.turnStatus) { label.textContent = `${state.turnStatus}, ${seconds}s`; return; }
    const doing = state.turnTool && state.turnTool !== "thinking" ? `Running ${state.turnTool}` : "Thinking";
    label.textContent = seconds >= 4 ? `${doing}, ${seconds}s` : doing;
  }, 1000);

  return box;
}

function renderChat(root) {
  const project = currentProject();
  if (!project) return;

  // Opening the tab lands on the most recent conversation rather than on
  // nothing, which is what makes it feel like coming back to a session.
  if (!state.sessionId && state.sessions.length) {
    openSession(state.sessions[0].id);
    return;
  }

  const wrap = el("div", { className: "chat" });

  // Faces of one place, so this is a switch rather than navigation. Delphi's own
  // chat, then one tab per agent that is actually installed, then the terminal.
  //
  // A tab is a session. Clicking Codex opens this project's Codex conversation,
  // or starts one, and every one of them runs in the same folder with the same
  // tracker wired in. That is the whole idea: the harnesses are the tabs, and
  // Delphi is the thing above them.
  const tabs = el("div", { className: "pane-tabs" });

  const paneTab = (id, label, { busy = false, on = false, run = null } = {}) => {
    const t = el("div", {
      className: "pane-tab" + (state.pane === id ? " on" : ""),
      tabIndex: 0, role: "button",
    }, el("span", { textContent: label }));
    if (busy) t.append(el("span", { className: "sd live" }));
    if (run === "failed") t.append(el("span", { className: "sd bad", title: "The last turn failed" }));
    const go = () => {
      if (on) { on(); return; }
      state.pane = id;
      render();
    };
    t.onclick = go;
    t.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    tabs.append(t);
    return t;
  };

  paneTab("chat", "Delphi", {
    on: () => {
      state.pane = "chat";
      // Back to a conversation this tab owns, rather than leaving a Codex
      // transcript on screen under Delphi's own name.
      const own = state.sessions.find((x) => !x.harness);
      if (own && own.id !== state.sessionId) { openSession(own.id); return; }
      render();
    },
  });

  for (const h of state.harnesses) {
    if (!h.enabled || !h.ready) continue;
    const session = state.sessions.find((x) => x.harness === h.key);
    paneTab(`h:${h.key}`, h.label, {
      // state.streaming as well as the stored state, because a turn in flight
      // has not been written back to the row yet and the dot is the only thing
      // saying the tab you are not looking at is working.
      busy: Boolean(session && (session.run_state === "running" ||
                                (state.streaming && session.id === state.sessionId))),
      run: session ? session.run_state : null,
      on: () => openHarness(h.key),
    });
  }

  paneTab("terminal", "Terminal", { busy: state.termBusy });

  // The ones that are not installed, said once rather than as dead tabs. A tab
  // that is always there and never works teaches people to stop reading the row.
  const missing = state.harnesses.filter((h) => h.enabled && !h.ready);
  if (missing.length) {
    const note = el("span", {
      className: "pane-miss",
      textContent: `${missing.length} not installed`,
      title: missing.map((h) => `${h.label}: ${h.detail}`).join("\n"),
      tabIndex: 0, role: "button",
    });
    const go = () => goTo({ projectId: null, view: "settings" });
    note.onclick = go;
    note.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    tabs.append(note);
  }

  tabs.append(el("span", { className: "pane-kbd", textContent: shortcut("J") }));
  wrap.append(tabs);

  if (state.pane === "terminal") {
    renderTerminal(wrap);
    root.append(wrap);
    return;
  }

  // --- stream -------------------------------------------------------------
  const stream = el("div", { className: "gstream" });
  if (!state.sessionId) {
    stream.append(emptyState(
      "No session yet",
      "Start one from the AI sessions menu beside the Chat tab. It will belong to this project, and run in this workspace."));
  } else if (!state.messages.length) {
    const empty = el("div", { className: "gempty" });
    empty.append(
      el("div", { className: "ge-k", textContent: "delphi agent" }),
      el("div", { className: "ge-t", textContent: "Ask in plain English. The work runs against this project's folder." })
    );
    const cards = el("div", { className: "ge-cards" });
    for (const [title, blurb] of STARTERS) {
      const card = el("div", { className: "ge-card", tabIndex: 0, role: "button" },
        el("b", { textContent: title }), el("span", { textContent: blurb }));
      const use = () => { state.draft = title; render(); };
      card.onclick = use;
      card.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); use(); } };
      cards.append(card);
    }
    empty.append(cards);
    empty.append(el("div", { className: "ge-conn", textContent: project.path || "No folder linked yet" }));
    stream.append(empty);
  } else {
    for (const m of state.messages) {
      if (m.error) {
        stream.append(el("div", { className: "gmsg err", textContent: m.error }));
        continue;
      }
      if (m.role === "user") {
        stream.append(el("div", { className: "gmsg you", textContent: m.content }));
      } else {
        // The agent's turn is markdown, rendered with the same renderer the
        // memory notes use rather than a second one that would drift from it.
        const body = el("div", { className: "gmsg ai" });
        const live = m.id === streamingMessageId;
        if (live && !streamShown) {
          // Nothing has come back yet. Without this the turn is an empty
          // element, so the window looks like it did not hear the question.
          body.append(thinkingIndicator());
        } else {
          body.append(renderMarkdown(live ? streamShown : (m.content || "")));
        }
        stream.append(body);
        // The one still arriving is handed to the stream, so it can grow this
        // node rather than asking for a repaint per token.
        if (live) adoptStreamNode(body);
      }
    }
  }
  wrap.append(stream);

  // --- composer -----------------------------------------------------------
  const comp = el("div", { className: "gcomp" });
  const box = el("textarea", {
    rows: 1,
    placeholder: state.streaming ? "Waiting for a reply…" : "Ask for anything…",
    value: state.draft,
    spellcheck: false,
  });
  const grow = () => { box.style.height = "auto"; box.style.height = `${Math.min(box.scrollHeight, 160)}px`; };
  box.oninput = () => { state.draft = box.value; grow(); };
  box.onkeydown = (e) => {
    // Enter sends, Shift+Enter breaks the line. Escape is swallowed rather than
    // hiding the whole window, which is what it does everywhere else.
    if (e.key === "Escape") { e.stopPropagation(); box.blur(); return; }
    // Newest first, which is the order Up walks.
    const sent = state.messages.filter((m) => m.role === "user").map((m) => m.content).reverse();
    if (recallHistory(e, box, sent, (text) => { state.draft = text; })) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };
  comp.append(box);
  wrap.append(comp);

  // --- model row and meter ------------------------------------------------
  const session = currentSession();
  const model = el("div", { className: "gmodel" });
  // Named from what this machine can actually reach rather than from what the
  // session recorded, so a chip never claims a connection that is not there.
  // A harness session does not use a provider: it drives a CLI of its own, and
  // offering to switch it to an API key would be offering something that does
  // nothing. The chip names the harness instead, and where it is running.
  const harness = session && session.harness
    ? state.harnesses.find((h) => h.key === session.harness) || null
    : null;

  if (harness) {
    const conn = el("div", {
      className: "gconn" + (harness.ready ? "" : " open"),
      title: harness.ready
        ? `${harness.path || harness.command}, resumed by session id`
        : harness.detail,
    },
      el("span", { className: "mk", textContent: harness.ready ? "✦" : "!" }),
      el("span", { textContent: harness.label }));
    model.append(conn);
  } else {
    const ready = state.providers.filter((x) => x.ready);
    const chosen = (session && session.provider && ready.find((x) => x.id === session.provider))
      || ready[0] || null;
    const conn = el("div", {
      className: "gconn" + (chosen ? "" : " open"),
      tabIndex: 0, role: "button",
      title: chosen ? chosen.detail : "Nothing is connected yet. Click to choose.",
    },
      el("span", { className: "mk", textContent: chosen ? "✦" : "!" }),
      el("span", { textContent: chosen ? chosen.label : "Not connected" }),
      el("span", { className: "cv", textContent: "▾" }));
    conn.onclick = (e) => providerMenu(e.clientX, e.clientY);
    model.append(conn);
  }
  // Every chip does something. Two of the ones here before were decoration, and
  // a control that looks live and is not is worse than no control.
  const autoAllow = session && session.auto_allow === 1;
  // "Ask first" is the honest label for Delphi's own chat, where a refused tool
  // comes back and can be allowed. A harness runs headless: there is nobody to
  // ask, so the same switch is the difference between an agent that can only
  // read and one that can change the folder. Saying "ask first" there would be
  // promising a prompt that never arrives.
  const tools = el("div", {
    className: "gpill bd" + (autoAllow ? " hot" : ""),
    tabIndex: 0, role: "button",
    title: harness
      ? autoAllow
        ? `${harness.label} may read and change files in this folder without asking`
        : `${harness.label} can read this folder but not change it. There is no prompt in a tab: click to allow.`
      : autoAllow
      ? "The agent may read and write files in this folder without asking"
      : "The agent can talk, but cannot touch files. Click to allow tools.",
  }, el("span", {
    textContent: harness
      ? (autoAllow ? "Full access" : "Read only")
      : (autoAllow ? "Auto-allow" : "Ask first"),
  }));
  tools.onclick = async () => {
    if (!session) return;
    // Turning it on is the dangerous direction, so that is the one that asks.
    if (!autoAllow) {
      const ok = confirm(
        "Let the agent use tools without asking?\n\n" +
        `It will be able to read and change files in ${runningInLabel(session)} on its own. ` +
        "Turn this off again from the same chip."
      );
      if (!ok) return;
    }
    await window.delphi.sessions.update(session.id, { auto_allow: autoAllow ? 0 : 1 });
    await refresh();
  };
  model.append(tools);

  // A persona is a system prompt, and only a harness whose template has a
  // {system} placeholder can carry one. Offering the menu on the others would be
  // offering a choice that changes nothing.
  const takesPersona = !harness || /\{system\}/.test(String(harness.args_json || ""));
  const persona = agentById(session && session.agent);
  const personaPill = takesPersona ? el("div", {
    className: "gpill bd", tabIndex: 0, role: "button", title: persona.blurb,
  }, el("span", { textContent: persona.label }), el("span", { className: "cv", textContent: "▾" })) : null;
  if (personaPill) {
    personaPill.onclick = (e) => {
      rowMenu(e.clientX, e.clientY, AGENTS.map((a) => ({
        label: `${a.label}  ${a.blurb}`,
        run: async () => {
          if (!session) return;
          await window.delphi.sessions.update(session.id, { agent: a.id });
          await refresh();
        },
      })));
    };
    model.append(personaPill);
  }

  const chosenModel = (session && session.model) || "Auto";
  const modelPill = el("div", {
    className: "gpill", tabIndex: 0, role: "button", title: "Which model answers",
  }, el("span", { className: "mono2", textContent: chosenModel }), el("span", { className: "cv", textContent: "▾" }));
  modelPill.onclick = (e) => {
    rowMenu(e.clientX, e.clientY, MODELS.map(([value, label]) => ({
      label,
      run: async () => {
        if (!session) return;
        await window.delphi.sessions.update(session.id, { model: value });
        await refresh();
      },
    })));
  };
  model.append(modelPill);
  wrap.append(model);

  const used = session ? (session.tokens_in || 0) + (session.tokens_out || 0) : 0;
  const meter = el("div", { className: "gmeter" });
  const runningIn = sessionFolder(session);
  meter.append(el("span", {
    textContent: runningIn ? `${project.name} · ${runningIn.split("/").pop()}` : `${project.name} (no folder)`,
    title: runningIn || "No folder linked, so an agent has no working directory",
  }));
  const right = el("div", { className: "ml" });
  right.append(
    el("span", { textContent: used ? `${(used / 1000).toFixed(1)}k tokens` : "0 tokens" }),
    el("div", { className: "bar" }, el("span", { style: `width:${Math.min(100, used / 5000)}%` }))
  );
  meter.append(right);
  wrap.append(meter);

  root.append(wrap);

  // Focus and caret restored after the rebuild, or typing into a chat while an
  // alert ticks would move the cursor to the front of the draft.
  if (state.draft || state.sessionId) {
    requestAnimationFrame(() => {
      grow();
      if (document.activeElement !== box && state.draft) {
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      }
      stream.scrollTop = stream.scrollHeight;
    });
  }
}

/** Which agent this session talks to. */
function providerMenu(x, y) {
  const session = currentSession();
  const items = state.providers.map((p) => ({
    label: p.ready ? p.label : `${p.label}  (${p.detail})`,
    run: async () => {
      if (!p.ready) {
        // Saying why beats refusing silently, and the reason is usually one
        // command away from being fixed.
        await askText({ title: p.label, label: p.detail, value: "", allowEmpty: true, confirmLabel: "Close" });
        return;
      }
      if (session) await window.delphi.sessions.update(session.id, { provider: p.id });
      await refresh();
    },
  }));
  rowMenu(x, y, items.length ? items : [{ label: "Nothing available", run: async () => {} }]);
}

async function sendMessage() {
  const text = state.draft.trim();
  if (!text || state.streaming) return;
  let sessionId = state.sessionId;
  if (!sessionId) {
    await newSession();
    sessionId = state.sessionId;
    if (!sessionId) return;
  }

  // Checked before the turn is written, so a message is not left hanging with no
  // reply and no reason. The error goes into the transcript rather than into an
  // alert, because that is where the person is looking.
  //
  // A harness session is checked against the registry instead, since it does not
  // use any of the providers: it drives a CLI of its own.
  const harnessKey = (currentSession() || {}).harness || null;
  const ready = harnessKey
    ? state.harnesses.filter((h) => h.key === harnessKey && h.enabled && h.ready)
    : state.providers.filter((p) => p.ready);
  if (!ready.length) {
    state.draft = "";
    await window.delphi.messages.append({ sessionId, role: "user", content: text });
    const harness = harnessKey ? state.harnesses.find((h) => h.key === harnessKey) : null;
    const why = harness
      ? `${harness.label}: ${harness.enabled ? harness.detail : "turned off in Settings"}`
      : state.providers.length
      ? state.providers.map((p) => `${p.label}: ${p.detail}`).join("\n")
      : "Nothing was found on this machine.";
    await window.delphi.messages.append({
      sessionId, role: "assistant", content: "",
      error: (harness
        ? `${harness.label} cannot run, so there is nothing to answer.`
        : "No AI is configured, so there is nothing to answer.") +
             `\n\n${why}\n\n` +
             "Set one up in All Work, then Settings, then AI.",
    });
    state.messages = await window.delphi.messages.list(sessionId);
    state.sessions = await window.delphi.sessions.list(state.projectId);
    render();
    return;
  }

  state.draft = "";
  resetHistory();
  await window.delphi.messages.append({ sessionId, role: "user", content: text });

  // The first thing said names the session, so the list reads as a set of
  // topics rather than a column of "New session".
  const session = currentSession();
  if (session && (!session.title || session.title === "New session")) {
    const title = text.length > 48 ? `${text.slice(0, 45)}…` : text;
    await window.delphi.sessions.update(sessionId, { title });
  }

  state.messages = await window.delphi.messages.list(sessionId);
  state.sessions = await window.delphi.sessions.list(state.projectId);

  // The assistant's row is created empty and grown as the reply arrives, so an
  // interrupted stream leaves what it managed to say rather than nothing.
  const reply = await window.delphi.messages.append({ sessionId, role: "assistant", content: "" });
  state.messages.push(reply);
  streamingMessageId = reply.id;
  state.streaming = true;
  render();

  const project = currentProject();
  const open = currentSession();
  const folder = sessionFolder(open);
  try {
    if (harnessKey) {
      // Only the new turn goes over. The CLI keeps its own conversation and is
      // resumed by id, which is both cheaper and better than folding the
      // transcript into one prompt the way the built-in path has to.
      //
      // The persona goes with it on the first turn only, since it is a system
      // prompt and a resumed conversation already has one. A harness whose
      // template has no {system} placeholder drops it, which is why the pill is
      // hidden for those.
      await window.delphi.harnesses.start({
        sessionId,
        prompt: text,
        system: open && open.native_id ? null : [
          agentById(open && open.agent).prompt,
          folder
            ? `You are working on the project "${project.name}", in ${folder}. Delphi's MCP server is connected: keep your working document there with write_scratchpad, and its checkbox lines become tasks on the board.`
            : `You are working on the project "${project.name}".`,
        ].join("\n\n"),
      });
      return;
    }
    await window.delphi.ai.send({
      sessionId,
      provider: open && open.provider ? open.provider : "claude-cli",
      model: open && open.model ? open.model : null,
      system: [
        agentById(open && open.agent).prompt,
        folder
          ? `You are helping with the project "${project.name}", working in ${folder}.`
          : `You are helping with the project "${project.name}". It has no folder linked, so do not assume a working directory.`,
      ].join("\n\n"),
      messages: state.messages
        .filter((m) => m.id !== reply.id && !m.error)
        .map((m) => ({ role: m.role, content: m.content })),
      cwd: folder,
      autoAllow: open ? open.auto_allow === 1 : false,
    });
  } catch (error) {
    await window.delphi.messages.update(reply.id, { error: String(error.message || error) });
    state.streaming = false;
    streamingMessageId = null;
    state.messages = await window.delphi.messages.list(sessionId);
    render();
  }
}

// ---------------------------------------------------------------------------
// The reply, arriving
//
// Registered once, at module scope. The bridge offers no way to remove a
// listener, so registering inside a renderer would add another copy on every
// repaint and each token would be handled as many times as the view had been
// drawn.

let streamingMessageId = null;
let streamBuffer = "";      // everything received so far
let streamShown = "";       // everything put on screen so far
let streamUsage = { input: 0, output: 0 };
let streamTimer = null;
let streamNode = null;      // the message element being grown
let streamDone = false;     // the stream has ended, the drain may not have

/**
 * Registers the element a reply is being written into.
 *
 * Held so the stream can update that one node instead of asking the whole window
 * to repaint. That was the real cause of the choppiness: every token ran
 * render(), which rebuilds the rail, the sidebar, the tabs and the entire content
 * pane. The text was arriving smoothly and the window could not keep up with
 * drawing it.
 */
function adoptStreamNode(node) {
  streamNode = node;
}

/**
 * Puts a little more of the reply on screen, once per frame.
 *
 * The buffer does not empty in one go even when it could. A model reply arrives
 * in bursts, several hundred characters at a time, and writing each burst whole
 * is what makes it read as lurching rather than as typing. Releasing a share of
 * what is waiting spreads a burst over a few frames while still draining fast
 * when a lot is queued, so it never falls behind.
 */
function drainStream() {
  streamTimer = null;
  if (!streamNode) return;

  const waiting = streamBuffer.length - streamShown.length;
  if (waiting > 0) {
    // A proportion, with a floor so short bursts still move, and a ceiling so a
    // very large one does not arrive as a single jump.
    const take = Math.max(3, Math.min(220, Math.ceil(waiting / 5)));
    streamShown = streamBuffer.slice(0, streamShown.length + take);

    streamNode.textContent = "";
    streamNode.append(renderMarkdown(streamShown));

    // Kept at the bottom only if it was already there, so reading back through a
    // long reply is not fought by the reply still arriving.
    const stream = streamNode.closest(".gstream");
    if (stream && stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120) {
      stream.scrollTop = stream.scrollHeight;
    }
  }

  if (streamBuffer.length > streamShown.length) {
    streamTimer = requestAnimationFrame(drainStream);
  } else if (streamDone) {
    finishStream();
  }
}

async function finishStream() {
  const id = streamingMessageId;
  if (!id) return;
  streamingMessageId = null;
  streamNode = null;
  streamDone = false;
  state.streaming = false;

  if (streamBuffer) await window.delphi.messages.update(id, { content: streamBuffer });
  if (streamUsage.input || streamUsage.output) {
    await window.delphi.sessions.addUsage(state.sessionId, streamUsage);
  }
  streamBuffer = "";
  streamShown = "";
  streamUsage = { input: 0, output: 0 };

  state.messages = await window.delphi.messages.list(state.sessionId);
  state.sessions = await window.delphi.sessions.list(state.projectId);
  render();
}

window.delphi.onAiEvent(async (event) => {
  if (!streamingMessageId || event.sessionId !== state.sessionId) return;

  if (event.type === "text") {
    streamBuffer += event.text;
    const row = state.messages.find((m) => m.id === streamingMessageId);
    if (row) row.content = streamBuffer;
    if (!streamTimer) streamTimer = requestAnimationFrame(drainStream);
    return;
  }

  if (event.type === "usage") {
    streamUsage = { input: event.input || 0, output: event.output || streamUsage.output };
    return;
  }

  // What it did, in the transcript, where it happened. Written into the message
  // rather than kept beside it, because in a month the useful question is "what
  // did Codex actually run", and an answer that only existed while the turn was
  // live is no answer.
  if (event.type === "tool") {
    state.turnTool = event.name;
    const detail = event.detail ? ` \`${String(event.detail).replace(/`/g, "")}\`` : "";
    const gap = streamBuffer && !streamBuffer.endsWith("\n\n") ? "\n\n" : "";
    streamBuffer += `${gap}> ▸ **${event.name}**${detail}\n\n`;
    const row = state.messages.find((m) => m.id === streamingMessageId);
    if (row) row.content = streamBuffer;
    if (!streamTimer) streamTimer = requestAnimationFrame(drainStream);
    return;
  }

  // Reasoning is shown while it happens and not kept. It is long, it is not the
  // answer, and a transcript full of it is harder to read afterwards, not easier.
  if (event.type === "thinking") {
    state.turnTool = "thinking";
    return;
  }

  // Why it has gone quiet. Not kept either, for the same reason, but it is the
  // difference between a tab that looks busy and one that looks broken.
  if (event.type === "status") {
    state.turnStatus = event.text;
    return;
  }

  // The CLI's own conversation id. Recorded by the main process; nothing here
  // has to do anything with it beyond not treating it as an error.
  if (event.type === "session") return;

  if (event.type === "error") {
    await window.delphi.messages.update(streamingMessageId, { error: event.message });
    return;
  }

  if (event.type === "done") {
    state.turnTool = null;
    state.turnStatus = null;
    // The stream is over, the drain may not be. Letting it finish is what stops
    // the last few words being replaced by the final render before they appear.
    streamDone = true;
    if (!streamTimer && streamBuffer.length <= streamShown.length) await finishStream();
  }
});


/**
 * Makes a project, which now means making or choosing a folder.
 *
 * Two ways in, because there are two situations. The work already exists in a
 * folder, in which case pointing at it is the whole job. Or it does not exist
 * yet, in which case a name is typed and the folder is made, and the only thing
 * still to decide is where to put it.
 */
/**
 * Makes a project inside a workspace.
 *
 * The folder question moved up a level: a workspace is a folder, and a project
 * is a piece of work happening in one or more of them. So this asks for a name,
 * which is the only thing a project is, and links it to the workspace it was
 * started from. It can be linked to others afterwards, which is the whole point
 * of the join: SSNR is one project across four repos, not four projects.
 */
async function createProject(workspace) {
  const ws = workspace || state.workspaces.find((w) => w.id === state.workspaceId);
  // Reachable from the application menu, which does not know whether a workspace
  // is open. Saying so beats a menu item that appears to do nothing.
  // With no rail there is no workspace open, and a project no longer needs one:
  // a folder is something a project has. It is made on its own and opened at
  // its settings, where the folder is the next thing to set.
  if (!ws) {
    const name = await askText({
      title: "New project",
      label: "What is this piece of work called? Its folder is set on the next screen.",
      placeholder: "SSNR / MPI Person Update",
      confirmLabel: "Create",
    });
    if (!name) return null;
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    let key = base || `p${Date.now()}`;
    for (let n = 2; state.projects.some((p) => p.key === key); n += 1) key = `${base}-${n}`;
    try {
      const created = await window.delphi.projects.create({
        key, name, colour: PROJECT_COLOURS[state.projects.length % PROJECT_COLOURS.length],
      });
      $("search").value = "";
      await navigate({ projectId: created.id, view: "project", query: "" });
      return created;
    } catch (error) {
      alert(`Could not create the project: ${error.message}`);
      return null;
    }
  }

  const name = await askText({
    title: `New project in ${ws.name}`,
    label: "What is this piece of work called? It can span other workspaces later.",
    placeholder: "SSNR / MPI Person Update",
    confirmLabel: "Create",
  });
  if (!name) return null;

  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  let key = base || `p${Date.now()}`;
  if (state.projects.some((p) => p.key === key)) {
    let n = 2;
    while (state.projects.some((p) => p.key === `${base}-${n}`)) n += 1;
    key = `${base}-${n}`;
  }

  try {
    const created = await window.delphi.projects.create({
      key,
      name,
      colour: PROJECT_COLOURS[state.projects.length % PROJECT_COLOURS.length],
    });
    await window.delphi.workspaces.link(created.id, ws.id, { primary: true });
    state.projectId = created.id;
    state.view = "chat";
    await refresh();
    return created;
  } catch (error) {
    alert(`Could not create the project: ${error.message}`);
    return null;
  }
}
$("back").onclick = () => goBack();

// The side buttons on a mouse, which people expect to mean back and forward.
// Bound on mouseup because Chromium fires auxclick inconsistently for these.
window.addEventListener("mouseup", (e) => {
  if (e.button === 3) { e.preventDefault(); goBack(); }
});

document.addEventListener("keydown", (e) => {
  // Every key of an IME composition, Escape included, is the input method's.
  if (e.isComposing) return;
  // While the sheet is open it owns the keyboard apart from Escape. Navigating
  // behind it would leave it orphaned over a page it does not belong to, and
  // lose whatever was being written.
  if (openSheet && e.key !== "Escape") {
    if (modKey(e) && ["[", "ArrowLeft", "f"].includes(e.key)) e.preventDefault();
    return;
  }

  // The shortcuts macOS already uses for Back, so there is nothing new to learn.
  if (modKey(e) && (e.key === "[" || e.key === "ArrowLeft")) {
    e.preventDefault();
    goBack();
    return;
  }

  if (e.key === "Escape" && openMenu) {
    // A menu is innermost of all: Escape closes it and nothing behind it.
    closeRowMenu();
    return;
  }
  if (e.key === "Escape") {
    // The sheet is the innermost thing open, so it closes first. Without this,
    // Escape would hide the whole window and lose unsaved edits.
    if (openSheet) { openSheet.close(); return; }
    if ($("search").value) {
      $("search").value = "";
      state.query = "";
      state.view = state.projectId ? "overview" : "new";
      refresh();
      return;
    }
    window.delphi.hide();
  }
  // Only where there are two panes to flip between.
  if ((e.metaKey || e.ctrlKey) && e.key === "j" && state.view === "chat") {
    e.preventDefault();
    state.pane = state.pane === "chat" ? "terminal" : "chat";
    render();
    return;
  }
});

// Frameless panel mode has no traffic lights, so the title bar does not need to
// leave room for them. Which side needs the room at all is a platform question:
// macOS puts its traffic lights on the left of our bar, Windows puts the system
// control overlay on the right of it.
window.delphi.onMode(({ panelMode, platform, overlay }) => {
  document.body.classList.toggle("panel", panelMode);
  document.body.classList.toggle("mac", platform === "darwin");
  document.body.classList.toggle("overlay", overlay === true);
});

// ---------------------------------------------------------------------------
// The application menu
//
// The menu is built in the main process, which owns no part of the page, so every
// item that acts on what is displayed arrives here as one message. Anything that
// puts the cursor in a composer waits for the repaint first: those fields are
// created by the render and are not in the document until it has run.
// ---------------------------------------------------------------------------

function focusComposer() {
  const place = () => {
    const field = document.querySelector(".add-row .field");
    if (!field) return null;
    field.focus();
    field.select();
    return field;
  };

  const field = place();
  if (!field) return;

  // A repaint that was still in flight replaces this field with a new one and the
  // cursor is left nowhere. Two menu items in quick succession is the case that
  // does it: the first is still rendering when the second arrives. Cheap to check
  // whether that happened, so it is checked rather than assumed not to.
  requestAnimationFrame(() => {
    if (!document.contains(field)) place();
  });
}

// --- COMMANDS ---
// Every place and action the Cmd+K bar and the G-then-letter keys can reach,
// one row each: { id, title, keys, run }. The bar and the keys read this list
// rather than keeping their own, so a place cannot be reachable from one and
// missing from the other.
// The places and actions themselves live in ui/commands.js, which a Node test
// can load; this is where app.js lends them its functions.
const themeIs = () => (state.theme === "system"
  ? (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  : state.theme);
/** The project Pads and Chat open from All projects: the last one open, else the default. */
function projectFor() {
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem("delphi.recentProjects") || "[]"); } catch {}
  const id = recent.find((x) => projectById(x)) ?? state.settings.scratchpadProjectId;
  return projectById(id) ? id : (state.projects[0] ? state.projects[0].id : null);
}
/** How many of the items fall under each key, as a Map. */
function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) { const k = keyOf(item); counts.set(k, (counts.get(k) || 0) + 1); }
  return counts;
}

const shell = {
  state: () => state,
  go: (target) => goTo({ query: "", ...target }),
  goTab: (id) => goTo({ query: "", ...DelphiCommands.tabTarget(id, state, projectFor) }),
  projectFor,
  openBar: () => openBar(),
  openSwitcher: () => DelphiTopbar.openSwitcher(),
  newTask: async () => { await goTo({ view: "tasks", query: "" }); focusComposer(); },
  newNote: async () => {
    const projectId = someProjectId();
    if (!projectId) { await createProject(); return; }
    await goTo({ projectId, view: "notes", query: "" });
    focusComposer();
  },
  newProject: () => createProject(),
  addFolder: () => DelphiAddFolder.open(),
  // The floating panel (ui/settings.js). An anchor means the old page, which
  // still holds what has not moved yet: archived projects, the AI providers.
  // It lives in the All view, so getting there leaves whichever project is open.
  openSettings: (anchor) => {
    if (!anchor && window.DelphiSettingsPanel) return DelphiSettingsPanel.open();
    if (anchor === "archived") revealArchived = true;
    return goTo({ projectId: null, view: "settings", query: "" });
  },
  themeIs,
  toggleTheme: async () => {
    const next = themeIs() === "dark" ? "light" : "dark";
    applyTheme(next);
    render();
    try { await window.delphi.settings.set({ theme: next }); } catch (error) { notifyError(error); }
  },
  undoLast: async () => {
    try {
      const { undone, stopped } = await window.delphi.audit.undoLast(1);
      if (stopped) alert(stopped); else if (!undone) alert("Nothing to undo.");
    } catch (error) { alert(`Nothing to undo: ${error.message}`); }
    await refresh();
  },
  scrollTop: () => { const c = $("content"); if (c) c.scrollTop = 0; },
  needsYou: () => needsYouTotal(),
  // Per project, counted in one pass each, for a switcher that draws a row
  // per project: asked per row, each was a pass over every task or run.
  runningByProject: () => countBy(runsIn(["running"]), (r) => r.project_id),
  lateByProject: () => countBy(state.everyTask.filter(isOverdue), (t) => t.project_id),
  tabCount: (id) => {
    const inProject = state.projectId != null;
    switch (id) {
      case "today": return needsYouTotal();
      case "tasks": return state.query ? 0 : state.allTasks.filter((t) => t.status !== "done").length;
      case "memory": return inProject ? state.notes.length : state.projects.reduce((n, p) => n + (p.note_count || 0), 0);
      case "pads": return inProject ? state.pads.length : 0;
      case "chat": return inProject ? state.sessions.length : 0;
      case "runs": return runsIn(["running"]).length;
      default: return 0;
    }
  },
  projectMenu: (p, button) => projectMenu(p, null, null, button),
  sessionKids: () => sessionKids(),
};
const COMMANDS = DelphiCommands.make(shell);
// Every setting is a command too, and the panel borrows the harness sheet, the
// trust row and the theme from here.
if (window.DelphiSettingsPanel) {
  COMMANDS.push({ id: "settings-old", group: "Commands", title: "Settings: the old page", place: "settings-old", run: () => shell.openSettings("old") },
    ...DelphiSettingsPanel.commands());
  DelphiSettingsPanel.init({
    state: () => state,
    saved: (settings, fields) => {
      state.settings = settings;
      if ("theme" in fields) applyTheme(settings.theme);
      if ("animations" in fields) applyMotion(settings.animations !== false);
      if ("noteView" in fields) state.noteView = settings.noteView;
      if ("pinnedProjects" in fields) state.pinned = readPins(settings);
      render();
    },
    refresh: () => refresh(),
    openOld: (anchor) => shell.openSettings(anchor || "old"),
    openProject: (id) => goTo({ projectId: id || someProjectId(), view: "project", query: "" }),
    addFolder: () => shell.addFolder(),
    notify: (text) => notify(text, { error: true }),
    go: (target) => shell.go(target),
    harnessSheet: (h, done) => openHarnessSheet(h, done),
    trustRow: (h, repaint) => harnessTrustRow(h, repaint),
  });
  DelphiSettingsPanel.checkBroken();
}

/** The Cmd+K bar, lent what it needs to search, open and run. */
function openBar(query = "") {
  // Not over an open panel, from the menu or anywhere else: see ui/keys.js.
  if (openSheet || document.querySelector("body > .overlay")) return;
  DelphiTopbar.closePop();
  DelphiPalette.open({
    commands: () => COMMANDS,
    state: () => state,
    projectName: (id) => (projectById(id) || {}).name || "",
    openTask: (id) => openTaskSheet(id),
    openNote: (n) => (window.DelphiDrawer ? DelphiDrawer.openNote(n) : goTo({ projectId: n.project_id, view: "notes", query: "" })),
    // The results page the search field used to lead to, Oracle answers and all.
    searchAll: (q) => { $("search").value = q; return navigate({ query: q, view: "oracle" }); },
    ask: (q) => { $("search").value = q; return navigate({ query: q, view: "oracle" }); },
  }, { query });
}

DelphiTopbar.init(shell);
DelphiAddFolder.init({ ...shell, refresh: () => refresh(), notify: (text, o) => notify(text, o) });
DelphiNeeds.init({ refresh: () => refresh(), notify: (text) => notify(text) });
// Today (ui/today.js), lent the Needs you rows and the hand-off dialog rather
// than drawing its own, so an approval looks and works the same on both pages.
DelphiToday.init({
  ...shell, refresh: () => refresh(), repaint: () => { if (onHomeView()) repaintKeepingFocus(); },
  notify: (text) => notify(text), openTask: (id) => openTaskSheet(id), isAgent,
  projectName: (id) => (projectById(id) || {}).name || "",
  needs: () => ({ waiting: waitingRuns().sort(byWaitAge), reviews: reviewRuns(), flags: flagRowsNow() }),
  rows: { waiting: (r) => waitingRow(r), review: (r) => reviewRow(r), flag: (r) => flagNode(r) },
  handTo: async (id, request) => {
    const detail = await window.delphi.tasks.detail(id);
    // Loaded first so the dialog is built in this tick and its request can be
    // filled in; Do, since the ask is to carry the work forward. A cancel
    // puts back whichever kind was last used.
    if (!state.harnesses.length) { try { state.harnesses = await window.delphi.harnesses.list(); } catch {} }
    const kindWas = state.lastHandKind;
    state.lastHandKind = "do";
    const pending = handToAgent(detail);
    const field = document.getElementById("hand-request");
    if (field && !field.value) field.value = request;
    const run = await pending;
    if (!run) state.lastHandKind = kindWas;
    if (run) { notify(`Handed #${id} to an agent.`); await refresh(); }
    return run;
  },
});
COMMANDS.push(...DelphiToday.commands());
DelphiKeys.install({
  commands: () => COMMANDS,
  // A panel, a menu, a dialog or a popover owns the keyboard while it is open.
  // body > .overlay, not .overlay: on Windows the body itself carries an
  // "overlay" class for the window controls, and would make every key dead.
  busy: () => Boolean(openSheet || openMenu || DelphiTopbar.isOpen() || document.querySelector("body > .overlay")),
  openBar: () => openBar(),
  openSwitcher: () => DelphiTopbar.openSwitcher(),
  openTask: async (id, how) => {
    // Shift+Enter is the view the setting does not choose.
    if (how === "full") {
      if ((state.settings || {}).taskOpenMode === "centered" && window.DelphiDrawer) await DelphiDrawer.open(id);
      else await openTaskFull(id);
      return;
    }
    await openTaskSheet(id);
    if (how === "edit") { if (window.DelphiDrawer && DelphiDrawer.isOpen()) DelphiDrawer.editTitle(); else document.querySelector(".ts-title")?.focus(); }
  },
});
/** The centered view of a task, whatever taskOpenMode says: Shift+Enter and the drawer's Open full view. */
async function openTaskFull(id) { openTaskSheet.full = true; try { await openTaskSheet(id); } finally { openTaskSheet.full = false; } }
// The drawer (ui/drawer.js), lent what it draws with. It registers itself as
// openSheet, so the live updates that reached the old panel reach it too.
DelphiDrawer.init({
  state: () => state, sheet: () => openSheet, setSheet: (h) => { openSheet = h; },
  refresh, goTo, renderMarkdown, handToAgent, handoffText, itemOf, itemVerbs, itemMenu, deleteItem, fromChip,
  taskMenu, swatchRow, epicMenuItems, rowMenu, closeRowMenu, menuKeys, notify, notifyError, motionOff,
  statusOf, isOverdue, isAgent, hasColour, colourLabel, gap,
  reminderChipSpec, alertsForTask, liveAlerts, paintTaskReminders,
  openFull: (id) => openTaskFull(id),
  openNoteFull: (n) => { openNoteSheet.full = true; try { openNoteSheet(n); } finally { openNoteSheet.full = false; } },
  wb: { guard: wbGuard, starting: wbStarting, busy: wbBusyTasks, look: wbLook, chip: wbChip, update: wbUpdate, dialog: wbDialog,
    closingLong, finish: finishWorkbench, discard: discardWorkbench, pickRepo },
  runs: { OPEN: RUN_OPEN, WAITING: RUN_WAITING, words: RUN_STATE_WORDS, stateChip: runStateChip, settingFix, open: openRunSheet,
    buffers: runBuffers, kills: runKills, ended: runsEnded, buffer: runBuffer, pre: runPre, line: runLine,
    reload: async () => { try { state.runs = await window.delphi.runs.list({ limit: 300 }); } catch {} paintRunsLive(); } },
  kit: { SIGILS, KIND_WORD, NOTE_KINDS, entryIsAgent, isRunning, elapsed, duration, stripAnsi },
});
// --- end COMMANDS ---

/** Navigating from the menu empties the search box with the query, so the field
 *  cannot sit there showing a search the view no longer reflects. */
function goTo(next) {
  if (next.query === "") $("search").value = "";
  return navigate(next);
}

/** Notes and dashboards belong to a project, so the menu needs one to open. */
const someProjectId = () => state.projectId || (state.projects[0] && state.projects[0].id) || null;

window.delphi.onMenu(async ({ action, view, theme }) => {
  if (window.DelphiSettingsPanel && DelphiSettingsPanel.handleMenu(action)) return;
  switch (action) {
    case "search":
      openBar();
      return;

    case "back":
      goBack();
      return;

    case "theme":
      applyTheme(theme);
      render();
      return;

    case "settings":
      shell.openSettings();
      return;

    case "new-project":
      await createProject();
      return;

    case "new-task":
      await goTo({ view: "tasks", query: "" });
      focusComposer();
      return;

    case "new-note": {
      const projectId = someProjectId();
      // Memory is stored per project, so with none in the tracker yet the useful
      // thing to do is make one rather than to fail quietly.
      if (!projectId) {
        if (!(await createProject())) return;
      } else {
        await goTo({ projectId, view: "notes", query: "" });
      }
      focusComposer();
      return;
    }

    case "undo-last": {
      try {
        const { undone, stopped } = await window.delphi.audit.undoLast(1);
        if (stopped) alert(stopped);
        else if (!undone) alert("Nothing to undo.");
      } catch (error) {
        alert(`Nothing to undo: ${error.message}`);
      }
      await refresh();
      return;
    }

    case "view": {
      // What's new and History are the All view's tabs; Memory only exists inside
      // a project. Sending the wrong one would land on a tab that is not there.
      if (view === "new" || view === "history") {
        await goTo({ projectId: null, view, query: "" });
      } else if (view === "notes") {
        const projectId = someProjectId();
        if (projectId) await goTo({ projectId, view: "notes", query: "" });
      } else {
        await goTo({ view, query: "" });
      }
      return;
    }
  }
});

window.delphi.onShown(() => { refresh(); $("search").focus(); });
// A job moved. Only the list of runs is asked for again, throttled; see runsChanged.
window.delphi.onRunsChanged(() => runsChanged());
// A flag changed, here or by an agent: Needs you, the sidebar's count and
// any "from" marks are read again. Moves made from here fire it too.
if (window.delphi.onFlagsChanged) window.delphi.onFlagsChanged(() => flagsChanged());
window.delphi.onAlertsChanged(() => refresh());
// Subscribed once, here, because preload has no way to unsubscribe: an open
// task panel exposes live() and anything else open ignores it.
window.delphi.onDbChanged(() => { if (openSheet && openSheet.live) openSheet.live(); });
// Coming back to the window is when someone has been editing in the
// Workbench, so its status words are asked again then. The module caches each
// answer for ten seconds, so this never turns into git in a loop.
window.addEventListener("focus", () => { if (openSheet && openSheet.live) openSheet.live(); });
window.delphi.onFocusTask(({ projectId }) => {
  if (projectId) { state.projectId = projectId; state.view = "tasks"; }
  refresh();
});

/**
 * Reads the stored preferences before the first paint.
 *
 * The theme is applied here rather than inside render so the window never shows
 * one theme and then swaps to the other. A failure is survivable: the defaults
 * are the behaviour the app had before these settings existed.
 */
async function boot() {
  // Asked once, here. Probing spawns login shells, so it cannot be done per
  // render, and leaving it to the settings page meant the chat reported "not
  // connected" until someone happened to open settings.
  window.delphi.ai.providers()
    .then((p) => { state.providers = p; if (state.view === "chat") render(); })
    .catch(() => {});
  // Same reason, same once: resolving a binary through a login shell is far too
  // slow to do on a render, and the strip needs to know which agents exist
  // before it can draw a tab for each of them.
  window.delphi.harnesses.list()
    .then((h) => { state.harnesses = h; if (state.view === "chat" || onHomeView()) render(); })
    .catch(() => {});

  try {
    const settings = await window.delphi.settings.get();
    state.settings = settings || {};
    state.pinned = readPins(settings);
    state.hidden = cleanHidden(settings.hiddenFromActive);
    migratePins(settings).then(() => { state.pinned = readPins(state.settings); renderSidebar(); });
    applyTheme(settings.theme);
    applyMotion(settings.animations !== false);
    if (window.DelphiSettingsPanel) DelphiSettingsPanel.applyLook(settings);
    if (["formatted", "raw"].includes(settings.noteView)) state.noteView = settings.noteView;
  } catch {
    applyTheme("system");
    applyMotion(true);
    state.pinned = readPins(null);
  }
  await reopen();
}

/**
 * The first paint, at the place the last run was left: the project, the view,
 * the scroll and the open task, whatever ended that run. A place that no longer
 * exists falls back to the start. Then, after an unclean exit, the banner.
 */
async function reopen() {
  const R = window.DelphiRecovery;
  if (!R) return refresh();
  R.pruneDrafts();
  // The launch after a restore: what was typed before it belonged to the file
  // that was replaced. Only drafts older than the restore go, so a reload of
  // the window later in the same run keeps what was typed since.
  try {
    const info = await window.delphi.backups.list();
    const last = info && info.lastRestore;
    if (last && last.ok) R.dropDraftsBefore(Date.parse(last.at) || Date.now());
  } catch {}
  // Replies to flags are drawn only while they hold something, so a kept one
  // is put back where that check looks.
  for (const d of R.draftsOf("flag")) runDrafts.set(`freply-${d.id}`, d.text);
  // The switcher is the only scope now; a workspace scope from an older run
  // would narrow every list with no way in the window to widen it.
  state.workspaceId = null;
  const back = R.lastPlace();
  if (back.view) {
    state.projectId = back.projectId ?? null;
    state.view = back.view;
  }
  await refresh();
  if (state.projectId && !state.projects.some((p) => p.id === state.projectId)) {
    state.projectId = null;
    state.view = "new";
    await refresh();
  }
  R.watchScroll(document, "content");
  // After the view's own asynchronous paint, which the first frame is not.
  if (back.scroll && back.projectId === state.projectId && back.view === state.view) {
    setTimeout(() => { const c = $("content"); if (c) c.scrollTop = back.scroll; }, 400);
  }
  if (back.taskId) openTaskSheet(back.taskId).catch(() => R.taskClosed());
  R.showBanner(document.querySelector("main.main"), { onChange: () => reloadRuns() });
}

boot();
