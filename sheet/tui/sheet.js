/**
 * The Sheet in a terminal: `delphi open <task>`.
 *
 * Built in three layers so that everything a person can do is testable without
 * a terminal:
 *
 *   layout, summaryFor, yankText   pure. Entries in, lines or text out.
 *   createSheetApp                 the state machine. Keys in, calls to the
 *                                  MCP client and to an injected io out, and a
 *                                  render() that returns the frame as lines.
 *                                  No terminal, no clock unless start() is called.
 *   openSheet                      the wiring: the real screen, raw keys, the
 *                                  real clipboard, $EDITOR and $PAGER.
 *
 * Every write goes through the MCP client, the one write path, so an entry
 * made here is attributed and audited exactly like one made by an agent. New
 * entries arrive by polling sheet_read with its cursor every 500 ms, which is
 * cheap and needs nothing the server does not already do.
 *
 * Yank never reads the screen. A single entry yanks as its source, the body as
 * stored (the command for a run), so an agent's reply pastes byte for byte as
 * the agent wrote it, braces and fences included. A range yanks as clean Sheet
 * text. That is the whole copy fix: what is on the screen is drawn for a
 * person, and what goes on the clipboard is the record.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { StringDecoder } = require("string_decoder");
const fmt = require("../format");
const scr = require("./screen");
const keys = require("./keys");

const POLL_MS = 500;
// How long a call to Delphi's server may take before the Sheet says so.
const CALL_MS = 15000;
// Bringing in the latest from a remote, which crosses a network.
const UPDATE_MS = 120000;
// The most one yank puts on the clipboard. A run's log can be gigabytes, and
// a terminal handed that much over OSC 52 stalls or drops it.
const YANK_MAX = 1024 * 1024;
// Workbench status shells out to git; the server caches it for ten seconds,
// so asking more often would only repeat the answer.
const WORKBENCH_MS = 10000;
const TAIL_KEEP = 400;
const LIVE_TAIL_ROWS = 3;
const OUTPUT_ROWS = 200;
const STATUSES = ["todo", "doing", "blocked", "done"];
const FILE_KINDS = { d: "decision", g: "gotcha", r: "reference", n: "note" };
const HINT = "y copies clean";

// --- pure helpers ----------------------------------------------------------------

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const firstLine = (text) => String(text == null ? "" : text).split("\n")[0];

/** Ids in the ledger: promoted, a decision, or a question that was decided. Matches the store's LEDGER_WHERE. */
function ledgerIds(entries) {
  const ids = new Set();
  for (const e of entries) {
    if (e.promoted) ids.add(e.id);
    if (e.kind === "decide" && e.ref_id != null) { ids.add(e.id); ids.add(e.ref_id); }
  }
  return ids;
}

/** The answer to each question, by the question's id. The latest wins. */
function decisions(entries) {
  const map = new Map();
  for (const e of entries) {
    if (e.kind === "decide" && e.ref_id != null) map.set(e.ref_id, e);
  }
  return map;
}

function metaOf(entry) {
  const m = entry && entry.meta;
  if (!m) return {};
  if (typeof m === "string") { try { return JSON.parse(m) || {}; } catch { return {}; } }
  return m;
}

function sigilOf(entry) {
  if (entry.kind === "run") return { ch: "$", role: "run" };
  if (entry.kind === "ask") return { ch: "?", role: "ask" };
  if (entry.kind === "decide") return { ch: "=", role: "decide" };
  if (entry.kind === "note") return { ch: "!", role: "note" };
  const type = entry.author_type || fmt.inferAuthorType(entry.author);
  return type === "human" ? { ch: ">", role: "say" } : { ch: "@", role: "agent" };
}

/**
 * The name in the author column. An agent's actor is harness:session, and
 * the session is noise in a column eight cells wide; History keeps it whole.
 */
function whoOf(entry) {
  const name = scr.sanitize(entry.author || "");
  const type = entry.author_type || fmt.inferAuthorType(entry.author);
  return type === "agent" && name.includes(":") ? name.slice(0, name.indexOf(":")) || name : name;
}

function bodyLines(entry) {
  return scr.sanitize(fmt.normaliseBody(entry.body)).split("\n");
}

/** Lines under the head that folding hides, not counting run output. */
function extraLines(entry) {
  return bodyLines(entry).length - 1;
}

function durText(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n >= 0 ? `${(n / 1000).toFixed(1)}s` : "";
}

/**
 * The dim right side of an entry as [role, text] parts: "ok 1.2s  340 lines"
 * for a run, the note kind for something filed, who wrote a question or an
 * answer when it was an agent, "3 more" for a folded body. Never the {} block.
 */
function summaryParts(entry, { decided = null, expanded = false } = {}) {
  const parts = [];
  const meta = metaOf(entry);
  if (entry.kind === "run") {
    const lines = Number(meta.lines);
    const lineText = Number.isFinite(lines) && lines >= 0 ? plural(lines, "line", "lines") : "";
    if (meta.state === "running" || !meta.state) {
      parts.push(["running", "running"]);
    } else if (meta.state === "ok") {
      parts.push(["ok", "ok"]);
    } else {
      parts.push(["fail", meta.code === null || meta.code === undefined ? "fail" : `fail:${meta.code}`]);
    }
    const dur = meta.state && meta.state !== "running" ? durText(meta.dur_ms) : "";
    if (dur) parts.push(["dim", ` ${dur}`]);
    if (lineText) parts.push(["dim", `  ${lineText}`]);
    return parts;
  }
  const words = [];
  if (entry.kind === "ask" && decided) words.push(`answered ${firstLine(decided.body).trim()}`);
  if (entry.note_kind) words.push(entry.note_kind);
  if (entry.kind !== "say" && (entry.author_type || fmt.inferAuthorType(entry.author)) === "agent" && entry.author) {
    words.push(whoOf(entry));
  }
  const more = extraLines(entry);
  if (!expanded && more > 0) words.push(`${more} more`);
  if (words.length) parts.push(["dim", words.join("  ")]);
  return parts;
}

function summaryFor(entry, options) {
  return summaryParts(entry, options).map((p) => p[1]).join("");
}

/**
 * Painted segments cut to width cells. Segments are [role, text]; the role is
 * a palette name or null for plain. The cut happens on the plain text, before
 * painting, so an escape code can never be sliced in half.
 */
function paintFit(segs, width, paint) {
  let out = "";
  let used = 0;
  for (const [role, raw] of segs) {
    const text = String(raw);
    if (!text) continue;
    const w = scr.displayWidth(text);
    if (used + w <= width) {
      out += role && paint ? paint(role, text) : text;
      used += w;
      continue;
    }
    const cut = scr.truncate(text, width - used);
    out += role && paint ? paint(role, cut) : cut;
    used += scr.displayWidth(cut);
    break;
  }
  return { text: out, used };
}

/**
 * The rows for a list of entries: [{ text, id }], where text is painted when
 * a painter is given and plain otherwise. Pure; everything it needs is passed.
 *
 *   width       cells per row
 *   all         every entry on the Sheet, for the ledger and the answers;
 *               defaults to entries
 *   ledgerOnly  only what is in the ledger
 *   expanded    Set of ids shown unfolded
 *   cursor      id the Walk cursor is on, or null
 *   selection   Set of ids in a v range
 *   outputs     { id: text } run output to show when a run is unfolded
 *   tails       { id: [line] } live output of runs this process started
 *   paint       (role, text) => text, or null for plain rows
 */
function layoutRows(entries, {
  width = 80, all = null, ledgerOnly = false, expanded = new Set(), cursor = null, selection = null,
  outputs = {}, tails = {}, paint = null, cache = null,
} = {}) {
  const every = all || entries;
  const ledger = ledgerIds(every);
  const answers = decisions(every);
  const asks = new Map(every.filter((e) => e.kind === "ask").map((e) => [e.id, e]));
  const shown = ledgerOnly ? entries.filter((e) => ledger.has(e.id)) : entries;
  const cap = width >= 100 ? 12 : width >= 60 ? 11 : 6;
  const authorWidth = Math.min(cap, Math.max(3,
    ...shown.filter((e) => e.kind === "say" || !e.kind).map((e) => scr.displayWidth(whoOf(e)))));
  const p = (role, text) => (paint && role ? paint(role, text) : text);
  const rows = [];

  for (const e of shown) {
    const isOpen = expanded.has(e.id);
    const decided = e.kind === "ask" ? answers.get(e.id) || null : null;
    const markCh = cursor === e.id ? "›" : selection && selection.has(e.id) ? "|" : " ";
    // An entry's rows depend on the entry and on these, nothing else, so a
    // long Sheet is laid out once and then only where something changed.
    // Entries are replaced, never mutated, when the server sends a new copy.
    const tail = tails[e.id];
    const key = cache ? [
      width, isOpen, markCh, ledger.has(e.id), decided ? decided.id : "", authorWidth,
      e.kind === "decide" && asks.has(e.ref_id) ? "q" : "", tail ? `${tail.version || 0}:${tail.length}` : "",
      isOpen && outputs[e.id] != null ? String(outputs[e.id]).length : "", Boolean(paint),
    ].join("|") : null;
    const hit = cache && cache.get(e.id);
    if (hit && hit.ref === e && hit.key === key) { rows.push(...hit.rows); continue; }
    const first = rows.length;
    const sig = sigilOf(e);
    const lines = bodyLines(e);
    const meta = metaOf(e);
    const mark = markCh === " " ? " " : p("accent", markCh);
    const gutter = ledger.has(e.id) ? p("ledger", "+") : " ";
    const prefix = `${mark}${gutter}${p(sig.role, sig.ch)} `;

    const segs = [];
    if (e.kind === "run" || e.kind === "note") {
      segs.push([null, lines[0]]);
    } else if (e.kind === "ask") {
      segs.push([null, lines[0]]);
      const options = Array.isArray(meta.options) ? meta.options : [];
      const chosen = decided ? firstLine(decided.body).trim() : null;
      options.forEach((o, i) => {
        segs.push([null, i === 0 ? "   " : "  "]);
        const label = `[${scr.sanitize(o.key)}] ${scr.sanitize(o.label)}`;
        segs.push([chosen === o.key ? "decide" : null, label]);
      });
    } else if (e.kind === "decide") {
      const choice = lines[0].trim();
      const ask = asks.get(e.ref_id);
      const option = ask && Array.isArray(metaOf(ask).options) ? metaOf(ask).options.find((o) => o.key === choice) : null;
      segs.push([null, option ? `${choice}  ${scr.sanitize(option.label)}` : choice]);
    } else {
      segs.push([sig.role, scr.fit(whoOf(e), authorWidth)]);
      segs.push([null, " "]);
      segs.push([null, lines[0]]);
    }

    const sumParts = summaryParts(e, { decided, expanded: isOpen });
    const sumWidth = scr.displayWidth(sumParts.map((x) => x[1]).join(""));
    const room = Math.max(0, width - 4);
    let row;
    // A run's result is worth squeezing the command for; a name or a count is
    // not worth hiding most of a question or a note.
    const natural = scr.displayWidth(segs.map((x) => x[1]).join(""));
    const floor = e.kind === "run" ? Math.min(12, Math.floor(room / 2)) : Math.min(natural, Math.floor(room * 0.6));
    if (sumWidth && room - sumWidth - 2 >= floor) {
      const contentWidth = room - sumWidth - 2;
      const content = paintFit(segs, contentWidth, paint);
      const summary = paintFit(sumParts, sumWidth, paint);
      row = prefix + content.text + " ".repeat(contentWidth - content.used + 2) + summary.text;
    } else {
      row = prefix + paintFit(segs, room, paint).text;
    }
    rows.push({ text: row, id: e.id });

    // What sits under the head: the rest of the body when unfolded, a run's
    // output when unfolded, and the live end of a run this process started.
    const contMark = selection && selection.has(e.id) ? p("accent", "|") : " ";
    const indent = `${contMark}   `;
    const push = (line, role) => {
      for (const piece of scr.wrap(line, Math.max(1, width - 4))) {
        rows.push({ text: indent + p(role, piece), id: e.id });
      }
    };
    if (isOpen) {
      // The rest of a command recorded by its first line.
      const rest = e.kind === "run" && meta.script ? scr.sanitize(String(meta.script)).split("\n").slice(1) : lines.slice(1);
      for (const line of rest) push(line, null);
      if (e.kind === "run") {
        const text = outputs[e.id] !== undefined && outputs[e.id] !== null
          ? outputs[e.id]
          : tails[e.id] ? tails[e.id].join("\n") : meta.out || "";
        const out = scr.sanitize(text).split("\n");
        while (out.length && out[out.length - 1] === "") out.pop();
        if (out.length > OUTPUT_ROWS) {
          rows.push({ text: indent + p("dim", `${out.length - OUTPUT_ROWS} earlier lines; o opens the whole log`), id: e.id });
        }
        for (const line of out.slice(-OUTPUT_ROWS)) push(line, "dim");
        if (!out.length) rows.push({ text: indent + p("dim", "no output"), id: e.id });
      }
    } else if (e.kind === "run" && tails[e.id] && (meta.state === "running" || !meta.state)) {
      for (const line of tails[e.id].slice(-LIVE_TAIL_ROWS)) push(scr.sanitize(line), "dim");
    }
    if (cache) cache.set(e.id, { ref: e, key, rows: rows.slice(first) });
  }
  return rows;
}

/** The rows as strings. */
function layout(entries, options = {}) {
  return layoutRows(entries, options).map((r) => r.text);
}

/**
 * What a yank puts on the clipboard.
 *
 * One entry is its source: the body exactly as stored for a remark, note or
 * decision, the command for a run, and for a question its clean line, since
 * the options are not in its body. withOutput adds a run's full output,
 * colour codes stripped. Several entries are clean Sheet text, the same as
 * `delphi cat` in a pipe. logs is { id: text } read by the caller, so this
 * stays pure.
 */
function yankText(entries, { withOutput = false, logs = {} } = {}) {
  const list = entries || [];
  const outputOf = (e) => {
    const text = logs[e.id] !== undefined && logs[e.id] !== null ? logs[e.id] : metaOf(e).out || "";
    return fmt.stripAnsi(String(text)).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  };
  if (list.length === 1) {
    const e = list[0];
    if (e.kind === "ask") return fmt.formatEntry(e, { clean: true });
    // A run's source is the whole command, which for one of several lines is
    // in meta.script rather than the body.
    const body = e.kind === "run" ? fmt.runCommand(e) : e.body == null ? "" : String(e.body);
    if (e.kind === "run" && withOutput) {
      const out = outputOf(e);
      return out ? `${body}\n${out}` : body;
    }
    return body;
  }
  const shaped = list.map((e) => {
    if (e.kind !== "run") return e;
    const meta = { ...metaOf(e) };
    if (withOutput) meta.out = outputOf(e);
    return { ...e, meta };
  });
  return fmt.format({ entries: shaped }, { clean: true });
}

/**
 * What was typed at the prompt, read. Pure.
 *   { kind: "say" | "note" | "run" | "ask" | "command" | "empty" | "error", ... }
 */
function parseInput(text) {
  const raw = String(text == null ? "" : text);
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty" };
  if (trimmed.startsWith("//")) return { kind: "say", body: trimmed.slice(1) };
  if (trimmed.startsWith("/")) {
    const [name, ...rest] = trimmed.slice(1).split(/\s+/);
    return { kind: "command", name: name.toLowerCase(), arg: rest.join(" ").trim() };
  }
  if (/^\$(\s|$)/.test(trimmed)) {
    const command = trimmed.slice(1).trim();
    if (!command) return { kind: "error", message: "Put the command after the $, as in $ npm test." };
    if (/[\r\n]/.test(command)) return { kind: "error", message: "A command is one line. Put several in a script and run that." };
    return { kind: "run", command };
  }
  if (/^!(\s|$)/.test(trimmed)) {
    const body = trimmed.slice(1).trim();
    return body ? { kind: "note", body } : { kind: "error", message: "Put the note after the !, as in ! deployed to staging." };
  }
  if (/^\?(\s|$)/.test(trimmed)) {
    const parts = trimmed.slice(1).split("|").map((s) => s.trim());
    const question = parts[0];
    const options = parts.slice(1).filter(Boolean);
    if (!question || options.length < 2 || options.length > 4) {
      return { kind: "error", message: "Ask as  ? question | first | second, with two to four answers." };
    }
    return { kind: "ask", question, options };
  }
  return { kind: "say", body: raw.replace(/^\s+|\s+$/g, "") };
}

/** The header chip for a Workbench: "wb: 2 unsaved", in the fewest words that are still true. */
function workbenchChip(read) {
  if (!read || !read.workbench) return null;
  const wb = read.workbench;
  const s = read.status || {};
  if (wb.state === "missing" || s.state === "missing") return { text: "wb: missing", role: "fail" };
  if (wb.state === "parked") return { text: "wb: parked", role: "dim" };
  const parts = [];
  if (s.unsaved) parts.push(`${s.unsaved} unsaved`);
  if (s.ahead) parts.push(`${s.ahead} unshared`);
  if (s.behind) parts.push(`behind ${s.behind}`);
  if (!parts.length) return { text: "wb: ready", role: "ok" };
  return { text: `wb: ${parts.join(", ")}`, role: "running" };
}

// --- the app ------------------------------------------------------------------------

/**
 * The Sheet as a state machine.
 *
 *   client    the MCP client: call(tool, args) -> Promise
 *   resolved  what sheet_resolve said about the task
 *   io        the outside world, all optional:
 *     clip(text) -> Promise<{ via }>          the clipboard
 *     readLog(entry, { tail }) -> string|null a run's log, colour stripped; tail is
 *                                             the end only, for drawing, where a
 *                                             100 MB log must not be read twice a second
 *     edit(text, entry) -> Promise<string|null>  $EDITOR, null when unchanged or abandoned
 *     pager(entry) -> Promise                 $PAGER on a run's output
 *     openFolder(dir) -> Promise              $EDITOR on a folder
 *     suspend(fn) -> Promise                  give the terminal back while fn runs
 *     runEntry(options) -> Promise<entry>     sheet/run.js runEntry
 *     redraw()                                something changed, draw it
 *     hooks: { work(taskId), finish(taskId) } the command line's own flows
 *   paint     (role, text) => text, or null for plain frames
 *   size      () => { cols, rows }
 */
function createSheetApp({ client, resolved, io = {}, paint = null, size = () => ({ cols: 80, rows: 24 }), callMs = CALL_MS } = {}) {
  const state = {
    resolved,
    task: { id: resolved.task.id, title: resolved.task.title, status: resolved.task.status, project: resolved.project ? resolved.project.key : null },
    entries: [],
    cursor: null,
    mode: "type",
    input: "",
    caret: 0,
    history: [],
    historyAt: null,
    walk: null,
    anchor: null,
    pending: null,
    confirm: null,
    ledgerOnly: false,
    expanded: new Set(),
    outputs: {},
    scroll: 0,
    follow: true,
    message: null,
    workbench: null,
    quitting: false,
  };
  const runs = new Map();
  const rowCache = new Map();
  let chat = null;
  let chatQueue = Promise.resolve();
  let agentBusy = false;
  let finished = null;
  const done = new Promise((r) => { finished = r; });
  const timers = [];
  let polling = false;
  let redrawTimer = null;

  const redraw = () => { if (io.redraw) io.redraw(); };

  /**
   * A call to Delphi's server with a time limit. The person is watching the
   * screen: a server that stopped answering is said in the status line after
   * CALL_MS rather than shown as a Sheet that has frozen. The limit is asked of
   * the client too, so it gives up on the request, and enforced here as well,
   * for a client that does not take one.
   */
  function ask(tool, args, ms = callMs) {
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(
        `Delphi's server did not answer within ${Math.round(ms / 1000)}s (${tool}). Nothing new was saved; try again, or q to leave.`)), ms);
      if (timer.unref) timer.unref();
    });
    const answer = Promise.resolve().then(() => client.call(tool, args, { timeoutMs: ms + 1000 }));
    return Promise.race([answer, late]).finally(() => clearTimeout(timer));
  }
  const soonRedraw = () => {
    if (redrawTimer) return;
    redrawTimer = setTimeout(() => { redrawTimer = null; redraw(); }, 40);
    if (redrawTimer.unref) redrawTimer.unref();
  };
  const say = (text, role = null) => { state.message = { text, role }; };

  // --- data --------------------------------------------------------------------

  function merge(list) {
    if (!list || !list.length) return;
    const byId = new Map(state.entries.map((e) => [e.id, e]));
    for (const e of list) if (e && e.task_id === state.task.id) byId.set(e.id, e);
    state.entries = [...byId.values()].sort((a, b) => a.id - b.id);
  }

  async function load() {
    const read = await ask("sheet_read", { task_id: state.task.id, mode: "full" });
    state.entries = [];
    merge(read.entries);
    state.task = { ...state.task, ...read.task };
    state.cursor = read.cursor || null;
    await refreshWorkbench();
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const args = { task_id: state.task.id, mode: "full" };
      if (state.cursor) { args.after_id = state.cursor.after_id; args.since = state.cursor.since; }
      const taskId = state.task.id;
      const read = await ask("sheet_read", args);
      // A switch to another task while this was in flight makes it stale.
      if (taskId !== state.task.id) return;
      merge(read.entries);
      if (read.task) state.task = { ...state.task, ...read.task };
      if (read.cursor) state.cursor = read.cursor;
      refreshOutputs();
      if (read.entries && read.entries.length) redraw();
    } catch (error) {
      say(`Could not read the Sheet: ${plainError(error)}`, "fail");
      redraw();
    } finally {
      polling = false;
    }
  }

  async function refreshWorkbench() {
    try {
      state.workbench = await ask("workbench_status", { task_id: state.task.id });
    } catch {
      state.workbench = null;
    }
  }

  /** Output for unfolded runs that this process is not tailing itself. */
  function refreshOutputs() {
    if (!io.readLog) return;
    for (const id of state.expanded) {
      if (runOf(id)) continue;
      const e = state.entries.find((x) => x.id === id);
      if (!e || e.kind !== "run") continue;
      const running = metaOf(e).state === "running";
      if (state.outputs[id] !== undefined && !running) continue;
      try { state.outputs[id] = io.readLog(e, { tail: true }); } catch { state.outputs[id] = null; }
    }
  }

  const visible = () => {
    if (!state.ledgerOnly) return state.entries;
    const ledger = ledgerIds(state.entries);
    return state.entries.filter((e) => ledger.has(e.id));
  };
  const entryAt = (id) => state.entries.find((e) => e.id === id) || null;
  const current = () => (state.walk == null ? null : entryAt(state.walk));

  function selected() {
    const list = visible();
    if (state.anchor == null) { const e = current(); return e ? [e] : []; }
    const a = list.findIndex((e) => e.id === state.anchor);
    const b = list.findIndex((e) => e.id === state.walk);
    if (a < 0 || b < 0) { const e = current(); return e ? [e] : []; }
    return list.slice(Math.min(a, b), Math.max(a, b) + 1);
  }

  function tails() {
    const out = {};
    for (const r of runs.values()) {
      if (r.id == null) continue;
      out[r.id] = r.partial ? [...r.lines, r.partial] : [...r.lines];
      // Counted, because a capped tail of a repeating line looks the same twice.
      out[r.id].version = r.version;
    }
    return out;
  }

  // --- writes ----------------------------------------------------------------------

  async function call(tool, args, ms) {
    try {
      return await ask(tool, args, ms);
    } catch (error) {
      say(plainError(error), "fail");
      return null;
    }
  }

  /** A failed call, in words for the person at the Sheet. */
  function plainError(error) {
    const text = String(error && error.message || error);
    if (/^MCP server (exited|stopped reading|could not start)/.test(text)) {
      return `Delphi's server has stopped (${text}). Nothing new can be saved; q leaves, and delphi open starts it again.`;
    }
    return text;
  }

  async function startRun(command) {
    const runEntry = io.runEntry || require("../run").runEntry;
    const store = {
      append: (f) => ask("sheet_append", { task_id: f.taskId, kind: f.kind, body: f.body, meta: f.meta }),
      update: (id, f) => ask("sheet_update", { id, meta: f.meta, body: f.body }),
    };
    // Tracked from before the entry exists, so a Ctrl-C while the guard is
    // still being asked stops the run instead of being lost.
    const abort = new AbortController();
    const record = {
      id: null, control: null, abort, lines: [], partial: "", version: 0, decoder: new StringDecoder("utf8"), promise: null,
    };
    const runKey = Symbol("run");
    runs.set(runKey, record);
    const taskId = state.task.id;
    const cwd = state.resolved.cwd || process.cwd();
    record.promise = Promise.resolve().then(() => runEntry({
      store, taskId, command, cwd, logDir: state.resolved.log_dir, signal: abort.signal,
      onStart: ({ entry, interrupt, kill }) => {
        record.id = entry.id;
        record.control = { interrupt, kill };
        merge([entry]);
        soonRedraw();
      },
      onChunk: (chunk) => {
        record.version++;
        const text = fmt.stripAnsi(record.decoder.write(chunk));
        // A lone \r is a progress bar redrawing its line: keep the latest.
        const pieces = (record.partial + text).replace(/\r\n/g, "\n").split("\n");
        record.partial = pieces.pop().split("\r").pop();
        for (const piece of pieces) record.lines.push(piece.split("\r").pop());
        if (record.lines.length > TAIL_KEEP) record.lines.splice(0, record.lines.length - TAIL_KEEP);
        soonRedraw();
      },
    })).then((entry) => {
      runs.delete(runKey);
      if (entry) {
        merge([entry]);
        delete state.outputs[entry.id];
        const meta = metaOf(entry);
        const verdict = meta.state === "ok" ? "ok" : `fail:${meta.code}`;
        const timing = meta.dur_ms !== undefined ? ` in ${durText(meta.dur_ms)}` : "";
        say(`$ ${scr.truncate(command, 40)}: ${verdict}${timing}`, meta.state === "ok" ? "ok" : "fail");
        if (meta.code === "guard" || meta.code === "error") say(firstLine(meta.out) || "Not run.", "fail");
      }
      redraw();
      return entry;
    }, (error) => {
      runs.delete(runKey);
      say(`The command could not be recorded: ${error.message}`, "fail");
      redraw();
      return null;
    });
    if (taskId === state.task.id) state.follow = true;
    return record;
  }

  const runOf = (entryId) => [...runs.values()].find((r) => r.id === entryId) || null;

  /**
   * Ctrl-C on a run: the CLI's escalation, because it is runEntry's own. The
   * first sends SIGINT to the command's process group and the entry ends as
   * fail:130; a second, or three seconds unheeded, is SIGKILL.
   */
  function interrupt(entryId) {
    const target = entryId != null ? runOf(entryId) : [...runs.values()].pop();
    if (!target) return false;
    target.interrupts = (target.interrupts || 0) + 1;
    if (target.control) target.control.interrupt();
    else target.abort.abort();
    say(target.interrupts === 1 ? "Interrupted. Ctrl-C again kills it." : "Killed.", "running");
    return true;
  }

  /**
   * Ends every command this process started and waits until each entry is
   * finished, so none is left saying "running" after the Sheet has gone.
   * With a reason (SIGHUP, SIGTERM, crash) they are killed and the entry says
   * why; without one they are interrupted, as Ctrl-C would.
   */
  async function abortRuns(reason = null) {
    const pending = [];
    for (const r of runs.values()) {
      try {
        if (reason && r.control) r.control.kill(reason);
        else if (r.control) r.control.interrupt();
        else r.abort.abort();
      } catch {}
      pending.push(r.promise);
    }
    await Promise.allSettled(pending);
  }

  async function switchTask(ref) {
    const next = await call("sheet_resolve", { task: String(ref) });
    if (!next) return;
    // A chat belongs to its task: the agent was told about this Sheet, not the next.
    if (chat) await detachAgent();
    state.resolved = next;
    state.task = { id: next.task.id, title: next.task.title, status: next.task.status, project: next.project ? next.project.key : null };
    Object.assign(state, {
      entries: [], cursor: null, walk: null, anchor: null, expanded: new Set(), outputs: {},
      scroll: 0, follow: true, ledgerOnly: false, workbench: null,
    });
    try { await load(); } catch (error) { say(error.message, "fail"); return; }
    say(`Task ${state.task.id}: ${state.task.title}`);
  }

  async function reresolve() {
    const next = await call("sheet_resolve", { task: String(state.task.id) });
    if (next) state.resolved = next;
    await refreshWorkbench();
  }

  async function suspendFor(fn) {
    const wrap = io.suspend || ((f) => f());
    try { return await wrap(fn); } catch (error) { say(error.message, "fail"); return null; }
  }

  async function finishWorkbench() {
    if (!io.hooks || !io.hooks.finish) { say("Finish from the shell: delphi finish " + state.task.id, "fail"); return; }
    await suspendFor(() => io.hooks.finish(state.task.id));
    await reresolve();
    await poll();
  }

  async function command({ name, arg }) {
    switch (name) {
      case "ledger":
        state.ledgerOnly = !state.ledgerOnly;
        say(state.ledgerOnly ? "Ledger only. /ledger again shows everything." : "Showing everything.");
        return;
      case "status": {
        const status = arg.toLowerCase();
        if (!STATUSES.includes(status)) { say(`/status takes ${STATUSES.join(", ")}.`, "fail"); return; }
        const after = await call("update_task", { id: state.task.id, status });
        if (!after) return;
        state.task.status = after.status || status;
        say(`Task ${state.task.id} is ${state.task.status}.`, "ok");
        if (status === "done" && after.workbench) {
          state.confirm = { question: "Finish the Workbench now? y/n", yes: finishWorkbench };
        }
        return;
      }
      case "task":
        if (!arg) { say("/task takes a task: its id, legacy id or ref.", "fail"); return; }
        await switchTask(arg);
        return;
      case "work":
        if (!io.hooks || !io.hooks.work) { say("Start it from the shell: delphi work " + state.task.id, "fail"); return; }
        await suspendFor(() => io.hooks.work(state.task.id));
        await reresolve();
        await poll();
        return;
      case "finish":
        if (!state.workbench || !state.workbench.workbench) { say(`Task ${state.task.id} has no Workbench to finish.`, "fail"); return; }
        await finishWorkbench();
        return;
      case "park": {
        if (!state.workbench || !state.workbench.workbench) { say(`Task ${state.task.id} has no Workbench to park.`, "fail"); return; }
        const parked = await call("workbench_park", { task_id: state.task.id });
        if (parked) say(`Parked. /work picks it up again.`, "ok");
        await refreshWorkbench();
        return;
      }
      case "update": {
        if (!state.workbench || !state.workbench.workbench) { say(`Task ${state.task.id} has no Workbench to update.`, "fail"); return; }
        say("Bringing in the latest...", "running");
        redraw();
        // Fetching from the remote can honestly take a while.
        const result = await call("workbench_update", { task_id: state.task.id }, UPDATE_MS);
        if (result) say(result.words, result.ok ? "ok" : "fail");
        await refreshWorkbench();
        return;
      }
      case "agent": {
        const [which, ...flags] = arg.split(/\s+/).filter(Boolean);
        if (!which || which === "off") {
          if (!chat) { say("No agent is attached. /agent claude or /agent copilot attaches one."); return; }
          await detachAgent();
          say("The agent is detached. What you type is only said.");
          return;
        }
        if (!io.hooks || !io.hooks.attachAgent) { say("No agent can be attached here.", "fail"); return; }
        await detachAgent();
        say(`Starting ${which}...`, "running");
        redraw();
        try {
          chat = await io.hooks.attachAgent(which, state.resolved, {
            allowUnguarded: flags.includes("--allow-unguarded"),
            onEntry: (entry) => { merge([entry]); soonRedraw(); },
            onError: (error) => { say(`Could not write ${which}'s entry: ${error.message}`, "fail"); soonRedraw(); },
          });
          if (chat.notice) say(chat.notice, "running");
          say(`${chat.row.label} is listening${chat.resume ? ", picking up where it left off" : ""}. What you type now goes to it too. /agent off detaches.`, "ok");
        } catch (error) {
          chat = null;
          say(error.message, "fail");
        }
        return;
      }
      case "q": case "quit":
        await quit();
        return;
      case "help": case "?":
        say("Type to say. $ runs, ! notes, ? q | a | b asks. /agent claude /ledger /status /task /work /finish /park /update. Esc walks.");
        return;
      default:
        say(`No command /${name}. /help lists them.`, "fail");
    }
  }

  async function submit() {
    const text = state.input;
    const parsed = parseInput(text);
    if (parsed.kind === "empty") return;
    if (parsed.kind === "error") { say(parsed.message, "fail"); return; }
    const done = () => {
      state.history.push(text);
      state.historyAt = null;
      // Only what was typed is cleared, in case more was typed while the
      // write was on its way.
      if (state.input === text) { state.input = ""; state.caret = 0; }
      state.follow = true;
    };
    const task = state.task.id;
    if (parsed.kind === "command") { done(); return command(parsed); }
    if (parsed.kind === "run") { done(); await startRun(parsed.command); return; }
    // A remark stays at the prompt until it is saved: if the server does not
    // take it, the person still has what they wrote.
    let written = null;
    if (parsed.kind === "say") written = await call("sheet_append", { task_id: task, kind: "say", body: parsed.body });
    else if (parsed.kind === "note") written = await call("sheet_append", { task_id: task, kind: "note", body: parsed.body });
    else if (parsed.kind === "ask") written = await call("sheet_ask", { task_id: task, question: parsed.question, options: parsed.options });
    if (!written) return;
    done();
    merge([written]);
    if (parsed.kind === "say" && chat) sendToAgent(parsed.body, written.id);
  }

  /**
   * A turn for the attached agent, in the background so the Sheet stays live
   * while it works; turns queue rather than overlap. What it writes arrives
   * through onEntry and through the poll, whichever is first.
   */
  function sendToAgent(message, skipId) {
    const session = chat;
    chatQueue = chatQueue.then(async () => {
      if (chat !== session) return;
      agentBusy = true;
      soonRedraw();
      try {
        const result = await session.send(message, { skip: [skipId] });
        if (result.interrupted) say(`${session.row.label} was stopped.`, "running");
        else if (result.code !== 0 && !result.written.length) {
          say(`${session.row.label} exited ${result.code} and said nothing. ${firstLine(result.stderr.trim().split("\n").pop())}`, "fail");
        }
      } catch (error) {
        say(error.message, "fail");
      } finally {
        agentBusy = false;
        redraw();
      }
    });
    return chatQueue;
  }

  /** reason: null for a person's /agent off or quit, or the signal the process is ending on. */
  async function detachAgent(reason = null) {
    const session = chat;
    if (!session) return;
    chat = null;
    session.stop(reason);
    await chatQueue.catch(() => {});
    session.close();
  }

  /**
   * The process is ending (SIGHUP, SIGTERM, a crash): the agent and every
   * command started here are stopped and their entries finished, so nothing
   * is left running with nobody reading it.
   */
  async function shutdown(reason) {
    await Promise.all([detachAgent(reason || "SIGTERM"), abortRuns(reason)]);
  }

  async function yank(withOutput) {
    const list = selected();
    if (!list.length) { say("Nothing to yank.", "fail"); return; }
    const logs = {};
    let cut = false;
    if (withOutput && io.readLog) {
      for (const e of list) {
        if (e.kind !== "run") continue;
        const live = runOf(e.id);
        // Only the end of a log is read: the clipboard takes YANK_MAX at most.
        try { logs[e.id] = io.readLog(e, { tail: true, bytes: YANK_MAX }); } catch {}
        try { if (io.logSize && io.logSize(e) > YANK_MAX) cut = true; } catch {}
        if ((logs[e.id] === null || logs[e.id] === undefined) && live) logs[e.id] = live.lines.join("\n");
      }
    }
    let text = yankText(list, { withOutput, logs });
    if (Buffer.byteLength(text) > YANK_MAX) {
      // The command is kept whole and the end of the output, where the
      // answer usually is, fills the rest.
      const head = list.length === 1 && list[0].kind === "run" ? `${fmt.runCommand(list[0])}\n` : "";
      let tail = Buffer.from(text).subarray(-(YANK_MAX - Buffer.byteLength(head))).toString("utf8");
      tail = tail.slice(tail.indexOf("\n") + 1);
      text = head + tail;
      cut = true;
    }
    let via = null;
    try { via = io.clip ? (await io.clip(text)).via : null; } catch {}
    state.anchor = null;
    const what = list.length === 1 ? `entry ${list[0].id}` : `${list.length} entries`;
    if (via && cut) say(`Copied ${what} with the last ${Math.round(YANK_MAX / 1024 / 1024)} MB of its output, clean (${via}); o shows the whole log.`, "ok");
    else if (via) say(`Copied ${what}${withOutput ? " with output" : ""}, clean (${via}).`, "ok");
    else say("No clipboard to copy to: this terminal ignores OSC 52 and no pbcopy, wl-copy or xclip was found.", "fail");
  }

  async function quit() {
    if (agentBusy && !state.quitting) {
      state.confirm = {
        question: `${chat ? chat.row.label : "The agent"} is still working. Stop it and quit? y/n`,
        yes: async () => { state.quitting = true; say("Stopping..."); redraw(); await detachAgent(); await abortRuns(); finish(); },
      };
      return;
    }
    if (runs.size && !state.quitting) {
      state.confirm = {
        question: `${plural(runs.size, "command is", "commands are")} still running. Stop and quit? y/n`,
        yes: async () => { state.quitting = true; say("Stopping..."); redraw(); await abortRuns(); finish(); },
      };
      return;
    }
    finish();
  }

  function finish() {
    if (chat) { const c = chat; chat = null; c.stop(); c.close(); }
    for (const t of timers) clearInterval(t);
    timers.length = 0;
    finished();
  }

  // --- keys ----------------------------------------------------------------------------

  function moveWalk(delta) {
    const list = visible();
    if (!list.length) { state.walk = null; return; }
    let i = list.findIndex((e) => e.id === state.walk);
    if (i < 0) i = list.length - 1;
    i = Math.max(0, Math.min(list.length - 1, i + delta));
    state.walk = list[i].id;
  }

  function enterWalk() {
    state.mode = "walk";
    state.pending = null;
    const list = visible();
    if (!list.some((e) => e.id === state.walk)) state.walk = list.length ? list[list.length - 1].id : null;
  }

  const graphemes = (text) => scr.graphemes(text).map((x) => x.g);

  function insert(text) {
    const g = graphemes(state.input);
    const add = graphemes(text);
    g.splice(state.caret, 0, ...add);
    state.input = g.join("");
    state.caret += add.length;
  }

  function editInput(k) {
    const g = graphemes(state.input);
    if (k.name === "backspace" && !k.meta) {
      if (state.caret > 0) { g.splice(state.caret - 1, 1); state.caret--; }
    } else if (k.name === "delete" || (k.ctrl && k.name === "d" && g.length)) {
      g.splice(state.caret, 1);
    } else if (k.name === "left" || (k.ctrl && k.name === "b")) {
      state.caret = Math.max(0, state.caret - 1);
    } else if (k.name === "right" || (k.ctrl && k.name === "f")) {
      state.caret = Math.min(g.length, state.caret + 1);
    } else if (k.name === "home" || (k.ctrl && k.name === "a")) {
      state.caret = 0;
    } else if (k.name === "end" || (k.ctrl && k.name === "e")) {
      state.caret = g.length;
    } else if (k.ctrl && k.name === "u") {
      g.splice(0, state.caret); state.caret = 0;
    } else if (k.ctrl && k.name === "k") {
      g.splice(state.caret);
    } else if ((k.ctrl && k.name === "w") || (k.meta && k.name === "backspace")) {
      let i = state.caret;
      while (i > 0 && /\s/.test(g[i - 1])) i--;
      while (i > 0 && !/\s/.test(g[i - 1])) i--;
      g.splice(i, state.caret - i); state.caret = i;
    } else {
      return false;
    }
    state.input = g.join("");
    return true;
  }

  function recall(delta) {
    if (!state.history.length) return;
    let at = state.historyAt == null ? state.history.length : state.historyAt;
    at = Math.max(0, Math.min(state.history.length, at + delta));
    state.historyAt = at;
    state.input = at === state.history.length ? "" : state.history[at];
    state.caret = graphemes(state.input).length;
  }

  async function typeKey(k) {
    if (k.name === "escape") { enterWalk(); return; }
    if (k.name === "enter" && !k.meta) { await submit(); return; }
    if (k.name === "enter" && k.meta) { insert("\n"); return; }
    if (k.name === "paste") { insert(k.text); return; }
    if (k.name === "up") { recall(-1); return; }
    if (k.name === "down") { recall(1); return; }
    if (k.name === "pageup") { state.follow = false; state.scroll -= pageSize(); return; }
    if (k.name === "pagedown") { state.scroll += pageSize(); return; }
    if (editInput(k)) return;
    if (k.ch) insert(k.ch);
  }

  async function walkKey(k) {
    if (state.pending === "file") {
      state.pending = null;
      const kind = !k.ctrl && !k.meta ? FILE_KINDS[k.name] : null;
      const e = current();
      if (!kind || !e) { say("Not filed."); return; }
      const result = await call("sheet_file", { id: e.id, kind });
      if (result) {
        merge([result.entry]);
        say(`Filed entry ${e.id} as ${result.note.kind} note ${result.note.id}.`, "ok");
      }
      return;
    }
    const e = current();
    switch (k.name) {
      case "j": case "down": moveWalk(1); return;
      case "k": case "up": moveWalk(-1); return;
      case "pagedown": moveWalk(Math.max(1, Math.floor(pageSize() / 2))); return;
      case "pageup": moveWalk(-Math.max(1, Math.floor(pageSize() / 2))); return;
      case "g": case "home": moveWalk(-Infinity); return;
      case "G": case "end": moveWalk(Infinity); return;
      case "enter":
        if (!e) return;
        if (state.expanded.has(e.id)) state.expanded.delete(e.id);
        else { state.expanded.add(e.id); delete state.outputs[e.id]; refreshOutputs(); }
        return;
      case "escape":
        if (state.anchor != null) { state.anchor = null; say("Range dropped."); }
        return;
      case "v":
        if (!e) return;
        state.anchor = state.anchor == null ? e.id : null;
        if (state.anchor != null) say("Range: move to the other end, then y.");
        return;
      case "y": await yank(false); return;
      case "Y": await yank(true); return;
      case "p": {
        if (!e) return;
        const on = !e.promoted;
        const r = await call("sheet_promote", { id: e.id, on });
        if (r) { merge([r]); say(on ? `Entry ${e.id} is in the ledger.` : `Entry ${e.id} is out of the ledger.`, "ok"); }
        return;
      }
      case "f":
        if (!e) return;
        state.pending = "file";
        return;
      case "a": case "b": case "c": case "d": {
        if (!e || e.kind !== "ask") return;
        const options = Array.isArray(metaOf(e).options) ? metaOf(e).options : [];
        if (!options.some((o) => o.key === k.name)) { say(`This question has no answer ${k.name}.`, "fail"); return; }
        const r = await call("sheet_decide", { ask_id: e.id, choice: k.name });
        if (r) { merge([r]); say(`Decided ${k.name}.`, "ok"); }
        return;
      }
      case "r":
        if (!e || e.kind !== "run") { say("r reruns a $ entry.", "fail"); return; }
        if (metaOf(e).script) { say("That command was several lines, and only its first is on the Sheet. o shows it all.", "fail"); return; }
        await startRun(e.body);
        return;
      case "e": {
        if (!e) return;
        if (e.kind !== "say" && e.kind !== "note") { say("Only remarks and notes are edited; a run, question or answer is a record.", "fail"); return; }
        if (!io.edit) { say("No editor here.", "fail"); return; }
        const text = await suspendFor(() => io.edit(e.body, e));
        if (text === null || text === undefined) { say("Not changed."); return; }
        const body = fmt.normaliseBody(text);
        if (!body) { say("An empty body is not saved. Nothing changed.", "fail"); return; }
        if (body === e.body) { say("Not changed."); return; }
        const r = await call("sheet_update", { id: e.id, body });
        if (r) { merge([r]); say(`Entry ${e.id} saved.`, "ok"); }
        return;
      }
      case "o":
        if (!e || e.kind !== "run") { say("o opens a run's output.", "fail"); return; }
        if (!io.pager) return;
        await suspendFor(() => io.pager(e));
        return;
      case "W": {
        const wb = state.workbench && state.workbench.workbench;
        if (!wb) { say("This task has no Workbench. /work starts one.", "fail"); return; }
        if (!io.openFolder) return;
        await suspendFor(() => io.openFolder(wb.path));
        return;
      }
      case "L":
        state.ledgerOnly = !state.ledgerOnly;
        if (state.ledgerOnly && !visible().some((x) => x.id === state.walk)) moveWalk(Infinity);
        say(state.ledgerOnly ? "Ledger only. L again shows everything." : "Showing everything.");
        return;
      case "i": state.mode = "type"; state.anchor = null; return;
      case "/":
        state.mode = "type"; state.anchor = null; insert("/");
        return;
      case "q": await quit(); return;
      default:
    }
  }

  async function key(k) {
    if (!k) return;
    state.message = state.confirm ? state.message : null;
    if (state.confirm) {
      const c = state.confirm;
      state.confirm = null;
      if (!k.ctrl && (k.name === "y" || k.name === "Y")) await c.yes();
      else if (c.no) await c.no();
      else say("Left as it is.");
      redraw();
      return;
    }
    if (k.ctrl && k.name === "c") {
      const target = state.mode === "walk" && current() && runOf(current().id) ? current().id : null;
      if (interrupt(target)) { redraw(); return; }
      if (chat && agentBusy && chat.stop()) { say(`Stopping ${chat.row.label}. Ctrl-C again kills it.`, "running"); redraw(); return; }
      if (state.mode === "type" && state.input) { state.input = ""; state.caret = 0; redraw(); return; }
      await quit();
      redraw();
      return;
    }
    if (k.ctrl && k.name === "d" && state.mode === "type" && !state.input) { await quit(); redraw(); return; }
    if (k.ctrl && k.name === "l") { redraw(); return; }
    if (state.mode === "type") await typeKey(k);
    else await walkKey(k);
    redraw();
  }

  let chain = Promise.resolve();
  let busy = 0;
  let stuckCtrlC = false;
  /**
   * Keys in order, each finished before the next, whatever it awaited. Except
   * Ctrl-C while something is still in flight: queued, it would wait behind the
   * very call it is meant to get the person out of. It interrupts what can be
   * interrupted at once, and a second one leaves.
   */
  function enqueue(k) {
    if (k && k.ctrl && k.name === "c" && busy) {
      const target = state.mode === "walk" && current() && runOf(current().id) ? current().id : null;
      if (interrupt(target)) { redraw(); return chain; }
      if (chat && agentBusy && chat.stop()) { say(`Stopping ${chat.row.label}. Ctrl-C again kills it.`, "running"); redraw(); return chain; }
      if (stuckCtrlC) { finish(); return chain; }
      // Armed, and also queued: if what is ahead finishes, this Ctrl-C does
      // what it always does; if it does not, the next one leaves.
      stuckCtrlC = true;
      const notice = setTimeout(() => {
        if (busy && stuckCtrlC) { say("Still waiting on Delphi's server. Ctrl-C again leaves the Sheet.", "running"); redraw(); }
      }, 300);
      if (notice.unref) notice.unref();
    }
    // Counted from the moment it is queued, not when it starts: keys that
    // arrived in one read are all queued before the first has begun.
    busy++;
    chain = chain.then(() => key(k)).catch((error) => { say(error.message, "fail"); redraw(); })
      .finally(() => { busy--; if (!busy) stuckCtrlC = false; });
    return chain;
  }

  // --- the frame ---------------------------------------------------------------------

  function pageSize() {
    return Math.max(1, size().rows - 5);
  }

  function headerLine(cols) {
    const t = state.task;
    const chip = workbenchChip(state.workbench);
    const parts = [];
    if (t.project) parts.push({ text: scr.sanitize(t.project), role: "dim", weight: 0 });
    if (t.status) parts.push({ text: scr.sanitize(t.status), role: "dim", weight: 2 });
    parts.push({ text: `ledger ${ledgerIds(state.entries).size}`, role: "dim", weight: 1 });
    if (chip) parts.push({ ...chip, weight: 3 });
    const left = ` ${t.id}  `;
    const titleMin = Math.min(12, scr.displayWidth(scr.sanitize(t.title)));
    const rightWidth = () => scr.displayWidth(parts.map((x) => x.text).join(" · "));
    while (parts.length && scr.displayWidth(left) + titleMin + 2 + rightWidth() + 1 > cols) {
      let low = 0;
      parts.forEach((x, i) => { if (x.weight < parts[low].weight) low = i; });
      parts.splice(low, 1);
    }
    const rw = parts.length ? rightWidth() : 0;
    const titleRoom = Math.max(0, cols - scr.displayWidth(left) - (rw ? rw + 3 : 0));
    const title = scr.truncate(scr.sanitize(t.title), titleRoom);
    const leftText = (paint ? paint("bold", left) : left) + title;
    const gap = Math.max(1, cols - scr.displayWidth(left) - scr.displayWidth(title) - rw - 1);
    const right = parts.map((x) => (paint ? paint(x.role, x.text) : x.text)).join(paint ? paint("dim", " · ") : " · ");
    const line = rw ? leftText + " ".repeat(gap) + right : leftText;
    return scr.visibleWidth(line) > cols ? scr.truncate(left + title, cols) : line;
  }

  function promptLine(cols) {
    if (state.confirm) {
      const q = scr.truncate(` ${state.confirm.question} `, cols);
      return { text: paint ? paint("ask", q) : q, cursor: { col: Math.min(cols - 1, scr.displayWidth(q)) } };
    }
    if (state.mode === "walk") {
      const hint = state.pending === "file"
        ? " file as: d decision  g gotcha  r reference  n note"
        : state.anchor != null
          ? " range: j k to extend, y copies clean, Y with output, Esc drops it"
          : " walk  j k move  Enter fold  y Y v yank  p promote  f file  a-d answer  r rerun  e edit  o output  L ledger  W bench  i type  q quit";
      const text = scr.truncate(hint, cols);
      return { text: paint ? paint("dim", text) : text, cursor: null };
    }
    const label = ` ${state.task.id}› `;
    const room = Math.max(1, cols - scr.displayWidth(label) - 1);
    const shown = graphemes(state.input).map((g) => (g === "\n" ? "↵" : scr.sanitize(g)));
    // Scrolled sideways so the caret is always on screen.
    let start = 0;
    const widthOf = (from, to) => scr.displayWidth(shown.slice(from, to).join(""));
    while (start < state.caret && widthOf(start, state.caret) > room) start++;
    let end = start;
    while (end < shown.length && widthOf(start, end + 1) <= room) end++;
    const text = shown.slice(start, end).join("");
    const col = scr.displayWidth(label) + widthOf(start, state.caret);
    return { text: (paint ? paint("accent", label) : label) + text, cursor: { col: Math.min(cols - 1, col) } };
  }

  function statusLine(cols) {
    if (state.message) {
      const text = scr.truncate(` ${scr.sanitize(state.message.text)}`, cols);
      return paint && state.message.role ? paint(state.message.role, text) : text;
    }
    const agent = chat ? (agentBusy ? `${chat.row.label} is working, Ctrl-C stops  ·  ` : `talking to ${chat.row.label}  ·  `) : "";
    const running = agent + (runs.size ? `${plural(runs.size, "command", "commands")} running, Ctrl-C stops  ·  ` : "");
    const base = state.mode === "walk"
      ? ` ${running}${HINT}  ·  Y with output  ·  i to type`
      : ` ${running}Esc to walk  ·  ${HINT}${state.ledgerOnly ? "  ·  ledger only" : ""}`;
    const text = scr.truncate(base, cols);
    return paint ? paint("dim", text) : text;
  }

  /** The whole frame: { lines, cursor }, cursor null when it should be hidden. */
  function render() {
    const { cols, rows } = size();
    const bodyHeight = Math.max(1, rows - 5);
    const rule = "─".repeat(cols);
    const list = visible();
    const sel = state.anchor != null ? new Set(selected().map((e) => e.id)) : null;
    const body = layoutRows(list, {
      width: cols, all: state.entries, expanded: state.expanded,
      cursor: state.mode === "walk" ? state.walk : null, selection: sel,
      outputs: state.outputs, tails: tails(), paint, cache: rowCache,
    });

    const maxScroll = Math.max(0, body.length - bodyHeight);
    if (state.mode === "walk" && state.walk != null) {
      const first = body.findIndex((r) => r.id === state.walk);
      let last = first;
      while (last + 1 < body.length && body[last + 1].id === state.walk) last++;
      if (first >= 0) {
        if (last >= state.scroll + bodyHeight) state.scroll = last - bodyHeight + 1;
        if (first < state.scroll) state.scroll = first;
      }
    } else if (state.follow) {
      state.scroll = maxScroll;
    }
    state.scroll = Math.max(0, Math.min(maxScroll, state.scroll));
    if (state.mode === "type" && state.scroll >= maxScroll) state.follow = true;

    const lines = [headerLine(cols), paint ? paint("dim", rule) : rule];
    const slice = body.slice(state.scroll, state.scroll + bodyHeight);
    if (!list.length) {
      const empty = state.ledgerOnly ? " Nothing in the ledger yet. p in Walk promotes an entry." : " Nothing on this Sheet yet. Type to start it.";
      slice.push({ text: paint ? paint("dim", scr.truncate(empty, cols)) : scr.truncate(empty, cols) });
    }
    for (let i = 0; i < bodyHeight; i++) lines.push(slice[i] ? slice[i].text : "");
    lines.push(paint ? paint("dim", rule) : rule);
    const prompt = promptLine(cols);
    lines.push(prompt.text);
    lines.push(statusLine(cols));
    const cursor = prompt.cursor ? { row: lines.length - 2, col: prompt.cursor.col } : null;
    // A terminal too short for the frame keeps the prompt and status, which
    // are what a person needs to get out.
    if (lines.length > rows) {
      const keep = lines.slice(lines.length - rows);
      return { lines: keep, cursor: cursor ? { row: cursor.row - (lines.length - rows), col: cursor.col } : null };
    }
    return { lines, cursor };
  }

  /** Feeds raw bytes as a person would type them, and waits until each key is handled. */
  function feed(bytes) {
    let last = chain;
    for (const k of keys.decode(Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8"))) last = enqueue(k);
    return last;
  }

  function start() {
    const p = setInterval(() => { poll(); }, POLL_MS);
    const w = setInterval(() => { refreshWorkbench().then(redraw); }, WORKBENCH_MS);
    timers.push(p, w);
  }

  return {
    state, runs, done, load, poll, start, render, feed, key: enqueue, abortRuns, finish, shutdown,
    /** Settles when every key and every agent turn so far has been handled. */
    idle: () => Promise.all([chain, chatQueue]).then(() => {}),
    get chain() { return chain; },
  };
}

// --- the wiring ----------------------------------------------------------------------

function editorArgv(env = process.env) {
  const { splitCommand } = require("../../agent/launch");
  const text = env.VISUAL || env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
  return splitCommand(text);
}

function spawnWait(argv, extra) {
  const { spawn } = require("child_process");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], [...argv.slice(1), ...extra], { stdio: "inherit" });
    } catch (error) {
      resolve({ code: 1, error });
      return;
    }
    child.on("error", (error) => resolve({ code: 1, error }));
    child.on("close", (code) => resolve({ code }));
  });
}

/**
 * Opens a task's Sheet in this terminal and resolves when the person quits.
 * Refuses, writing nothing to the terminal, when either end is not a TTY.
 */
async function openSheet({
  client, task, stdin = process.stdin, stdout = process.stdout, theme = scr.detectTheme(), hooks = {},
  clip = null,
} = {}) {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("delphi open needs a terminal at both ends. To read a Sheet in a pipe, use delphi cat.");
  }
  const resolved = await client.call("sheet_resolve", { task: String(task) });
  const { logPathFor } = require("../run");
  const clipboard = clip || require("./clip").copy;
  const screen = scr.createScreen({ out: stdout, theme });
  let stopKeys = null;
  let app = null;

  const restore = () => {
    if (stopKeys) { stopKeys(); stopKeys = null; }
    screen.leave();
  };
  const unguard = scr.guardTerminal(restore, { beforeExit: (reason) => (app ? app.shutdown(reason) : null) });

  const draw = () => {
    if (!screen.active || !app) return;
    const frame = app.render();
    screen.draw(frame.lines, frame.cursor);
  };
  const keysOn = () => { stopKeys = keys.listen(stdin, (k) => app.key(k)); };

  const suspend = async (fn) => {
    restore();
    unguard.childOwnsTerminal(true);
    try {
      return await fn();
    } finally {
      unguard.childOwnsTerminal(false);
      screen.enter();
      keysOn();
      draw();
    }
  };

  const TAIL_BYTES = 256 * 1024;
  const logSize = (entry) => {
    try { return fs.statSync(logPathFor(app.state.resolved.log_dir, entry.task_id, entry.id)).size; } catch { return 0; }
  };
  const readLog = (entry, { tail = false, bytes = TAIL_BYTES } = {}) => {
    const file = logPathFor(app.state.resolved.log_dir, entry.task_id, entry.id);
    let stat;
    try { stat = fs.statSync(file); } catch { return null; }
    // A log older than its entry belongs to an earlier entry that had the
    // same id, the same rule delphi out applies.
    const created = Date.parse(String(entry.created_at || "").replace(" ", "T") + "Z");
    if (Number.isFinite(created) && stat.mtimeMs < created - 2000) return null;
    let data;
    try {
      if (tail && stat.size > bytes) {
        const fd = fs.openSync(file, "r");
        try {
          data = Buffer.alloc(bytes);
          fs.readSync(fd, data, 0, bytes, stat.size - bytes);
        } finally {
          fs.closeSync(fd);
        }
        // The cut lands mid line, and maybe mid character: start at the next line.
        const text = data.toString("utf8");
        return fmt.stripAnsi(text.slice(text.indexOf("\n") + 1));
      }
      data = fs.readFileSync(file);
    } catch {
      return null;
    }
    return fmt.stripAnsi(data.toString("utf8"));
  };

  const io = {
    clip: (text) => clipboard(text, { out: stdout }),
    readLog,
    logSize,
    redraw: draw,
    suspend,
    hooks,
    async edit(body, entry) {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-edit-")), `entry-${entry.id}.md`);
      fs.writeFileSync(file, body == null ? "" : String(body));
      try {
        const r = await spawnWait(editorArgv(), [file]);
        if (r.error || r.code !== 0) return null;
        return fs.readFileSync(file, "utf8");
      } finally {
        try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch {}
      }
    },
    async pager(entry) {
      const { splitCommand } = require("../../agent/launch");
      let file = logPathFor(app.state.resolved.log_dir, entry.task_id, entry.id);
      let tmp = null;
      const script = metaOf(entry).script;
      const log = readLog(entry);
      if (log === null || script) {
        // Composed when there is no log, or when the command was several
        // lines and only its first is on the Sheet: the whole of it goes on top.
        const out = log !== null ? log : metaOf(entry).out;
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-out-"));
        file = path.join(tmp, `entry-${entry.id}.txt`);
        fs.writeFileSync(file, `${script ? `$ ${script}\n\n` : ""}${out ? `${String(out).replace(/\n$/, "")}\n` : "No output was recorded.\n"}`);
      }
      try {
        const pager = splitCommand(stdout.isTTY ? (process.env.PAGER || "less -R") : "cat");
        await spawnWait(pager.length ? pager : ["less", "-R"], [file]);
      } finally {
        if (tmp) try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      }
    },
    async openFolder(dir) {
      await spawnWait(editorArgv(), [dir]);
    },
  };

  app = createSheetApp({
    client, resolved, io,
    paint: screen.paint,
    size: () => { const s = screen.size(); return { cols: s.cols, rows: s.rows }; },
  });

  try {
    await app.load();
    screen.enter();
    screen.onResize(draw);
    keysOn();
    draw();
    app.start();
    await app.done;
  } finally {
    app.finish();
    restore();
    unguard();
  }
}

module.exports = {
  layout, layoutRows, summaryFor, summaryParts, yankText, parseInput, workbenchChip, ledgerIds,
  createSheetApp, openSheet, POLL_MS,
};
