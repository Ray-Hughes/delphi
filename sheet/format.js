/**
 * The Sheet as text.
 *
 * What `delphi cat`, yank, export and the vault mirror produce, and what the
 * terminal view draws minus the {} blocks. Pure functions, no I/O and no
 * requires, so the app, the MCP server and the command line can all load it
 * without caring which Node they are under, the same way pads.js is shared.
 *
 *   ---
 *   task: 42
 *   title: fix zip DLQ backlog
 *   project: efolder
 *   status: doing
 *   ---
 *   > ray: why is the DLQ filling up?
 *   @ claude: visibility timeout is under p95 job time  {id:806}
 *   $ aws sqs get-queue-attributes --queue-url ...  {id:807 by:ray ok dur:1.2s lines:340}
 *
 * The promise is narrow on purpose: format(parse(t)) === t for anything format
 * produced, full or clean. Hand written text in another order or spacing is
 * read as well as it can be, but not promised back byte for byte. Parsing is for
 * import and for tests, never a sync channel, so the grammar is free to be
 * strict where that keeps it unambiguous.
 */

const SIGILS = { say_human: ">", say_agent: "@", run: "$", ask: "?", decide: "=", note: "!" };
const META_ORDER = ["id", "by", "ref", "+", "note", "state", "dur", "lines", "cwd"];

// Any line at column 0 that starts with one of these and a space begins an
// entry. ~ and # are reserved by the spec for links and headings: they are read
// as raw entries and written back untouched, so nothing is lost and nothing is
// imported that this version does not understand.
const ENTRY_START = /^[>@$?=!~#] /;
const RAW_SIGILS = new Set(["~", "#"]);

// Agent actor names carry a tool name or a colon (claude-code:12). app.js has
// the same test in isAgent; keep the two identical, or the rail and the text
// will disagree about who said something.
const AGENT_NAME = /claude|copilot|codex|cursor|agent|gpt|bot|runner|:/i;

function inferAuthorType(author) {
  return AGENT_NAME.test(String(author == null ? "" : author)) ? "agent" : "human";
}

/** One line of text, for places a newline would end the entry or the header. */
const oneLine = (value) => String(value == null ? "" : value).replace(/\r\n|\r|\n/g, " ");

/**
 * A body as it will be written: line endings made \n, and blank lines at either
 * end dropped. The parser drops trailing empty lines of an entry, so a body that
 * kept them could never come back the same; leading spaces on the first line are
 * content and are kept.
 */
function normaliseBody(body) {
  const lines = String(body == null ? "" : body).replace(/\r\n?/g, "\n").split("\n");
  const blank = (line) => /^\s*$/.test(line);
  while (lines.length && blank(lines[0])) lines.shift();
  while (lines.length && blank(lines[lines.length - 1])) lines.pop();
  return lines.join("\n");
}

/** Strips terminal colour and cursor codes, for logs shown or stored as text. */
function stripAnsi(text) {
  return String(text == null ? "" : text)
    // OSC: ESC ] ... terminated by BEL or ESC \ (window titles, hyperlinks).
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI: ESC [ parameters, intermediates, one final byte. Also the 8-bit form.
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    // Everything else ESC introduces is two bytes long.
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\x1b/g, "");
}

// --- the metadata block -------------------------------------------------------

/**
 * A value as it appears in a block: bare unless something in it would end the
 * token or the block early, then quoted with the three escapes a single line
 * needs. \r is escaped as well as \n, because a lone CR in a line is a line
 * ending to half the tools that will ever read this.
 */
function quote(value) {
  const text = String(value);
  if (text !== "" && !/[\s"\\{}]/.test(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

/** A whole number at or above zero, or null. ids and counts only. */
function count(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** An exit code as it was given: a number stays a number, a signal name a string. */
function readCode(text) {
  return /^-?\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : text;
}

function parseMetaObject(meta) {
  if (!meta) return {};
  if (typeof meta === "string") {
    try { return JSON.parse(meta) || {}; } catch { return {}; }
  }
  return typeof meta === "object" ? meta : {};
}

/**
 * The tokens for one entry, in META_ORDER.
 *
 * Every token emitted here has to be one parseMeta accepts, because a single
 * bad token turns the whole block back into head text. That is why each value is
 * checked rather than trusted: a negative duration or a fractional id is left
 * out instead of written.
 */
function metaTokens(entry) {
  const kind = entry.kind || "say";
  const meta = parseMetaObject(entry.meta);
  const tokens = [];
  const id = count(entry.id);
  if (id !== null) tokens.push(`id:${id}`);
  // A say shows its author in the head; everything else needs telling.
  if (kind !== "say" && entry.author !== null && entry.author !== undefined) tokens.push(`by:${quote(entry.author)}`);
  const ref = count(entry.ref_id);
  if (ref !== null) tokens.push(`ref:${ref}`);
  if (entry.promoted === 1 || entry.promoted === true || entry.promoted === "1") tokens.push("+");
  if (entry.note_kind) tokens.push(`note:${quote(entry.note_kind)}`);
  if (kind === "run") {
    if (meta.state === "running") tokens.push("running");
    else if (meta.state === "ok") tokens.push("ok");
    else if (meta.state === "fail") {
      tokens.push(meta.code === null || meta.code === undefined ? "fail" : `fail:${quote(meta.code)}`);
    }
    if (meta.state !== "running") {
      const ms = Number(meta.dur_ms);
      // toFixed switches to exponent notation at 1e21; nothing runs that long,
      // but a corrupt value must not produce a token the parser refuses.
      if (meta.dur_ms !== null && meta.dur_ms !== undefined && meta.dur_ms !== "" &&
          Number.isFinite(ms) && ms >= 0 && ms < 1e15) {
        tokens.push(`dur:${(ms / 1000).toFixed(1)}s`);
      }
      const lines = count(meta.lines);
      if (lines !== null) tokens.push(`lines:${lines}`);
    }
    if (meta.cwd !== null && meta.cwd !== undefined && meta.cwd !== "") tokens.push(`cwd:${quote(meta.cwd)}`);
  }
  return tokens;
}

/** "{id:807 by:ray ok dur:1.2s lines:340}", or "" when there is nothing to say. */
function formatMeta(entry) {
  const tokens = metaTokens(entry || {});
  return tokens.length ? `{${tokens.join(" ")}}` : "";
}

const FLAG_KEYS = new Set(["+", "running", "ok"]);
const VALUE_KEYS = new Set(["id", "by", "ref", "note", "dur", "lines", "cwd"]);

/**
 * Reads a {} block, or returns null when it is not one.
 *
 * Null for anything unexpected: an unknown key, a malformed value, a repeated
 * key, a double space. Null means the braces were text that happened to be at
 * the end of a line, so they stay in the head, which is the safe reading. This
 * strictness is also what makes the "last block that parses" rule unambiguous: a
 * stretch that starts inside a quoted value can never parse, because inside one
 * every quote is escaped.
 *
 * Returns { id, by, ref, promoted, note, state, code, dur_ms, lines, cwd }, with
 * only the keys that were present. An empty block {} is valid and empty.
 */
function parseMeta(block) {
  if (typeof block !== "string" || block.length < 2 || block[0] !== "{" || block[block.length - 1] !== "}") return null;
  const inner = block.slice(1, -1);
  const out = {};
  if (inner === "") return out;
  const seen = new Set();
  let i = 0;
  for (;;) {
    let j = i;
    while (j < inner.length && inner[j] !== ":" && inner[j] !== " ") j++;
    const key = inner.slice(i, j);
    let value;
    if (inner[j] === ":") {
      j++;
      if (inner[j] === '"') {
        j++;
        let text = "";
        for (;;) {
          if (j >= inner.length) return null;
          const ch = inner[j];
          if (ch === "\\") {
            const next = inner[j + 1];
            if (next === "\\") text += "\\";
            else if (next === '"') text += '"';
            else if (next === "n") text += "\n";
            else if (next === "r") text += "\r";
            else return null;
            j += 2;
            continue;
          }
          if (ch === '"') { j++; break; }
          text += ch;
          j++;
        }
        value = text;
      } else {
        let k = j;
        while (k < inner.length && inner[k] !== " ") k++;
        value = inner.slice(j, k);
        if (value === "" || /["\\{}]/.test(value)) return null;
        j = k;
      }
    }

    // One state token per block: ok, fail and running are one fact.
    const slot = key === "ok" || key === "fail" || key === "running" ? "state" : key;
    if (!key || seen.has(slot)) return null;
    seen.add(slot);

    if (FLAG_KEYS.has(key)) {
      if (value !== undefined) return null;
      if (key === "+") out.promoted = true;
      else out.state = key;
    } else if (key === "fail") {
      out.state = "fail";
      if (value !== undefined) out.code = readCode(value);
    } else if (VALUE_KEYS.has(key)) {
      if (value === undefined) return null;
      if (key === "id" || key === "ref" || key === "lines") {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return null;
        out[key] = Number(value);
      } else if (key === "dur") {
        if (!/^\d+(?:\.\d+)?s$/.test(value)) return null;
        out.dur_ms = Math.round(parseFloat(value) * 1000);
      } else {
        out[key] = value;
      }
    } else {
      return null;
    }

    if (j === inner.length) break;
    if (inner[j] !== " ") return null;
    j++;
    if (j === inner.length) return null;
    i = j;
  }
  return out;
}

/**
 * Splits a head into its text and its block: the last "  {" whose remainder
 * parses. Null when there is no block, which is different from an empty one.
 */
function splitMeta(text) {
  let at = text.lastIndexOf("  {");
  while (at >= 0) {
    const meta = parseMeta(text.slice(at + 2));
    if (meta) return { text: text.slice(0, at), meta };
    if (at === 0) break;
    at = text.lastIndexOf("  {", at - 1);
  }
  return null;
}

// --- writing ------------------------------------------------------------------

function headerLines(header) {
  const h = header || {};
  const lines = ["---", `task: ${oneLine(h.task)}`, `title: ${oneLine(h.title)}`];
  // The project key, left out entirely for a task with no project rather than
  // written empty, so "project:" never has to mean two things.
  if (h.project !== null && h.project !== undefined && oneLine(h.project) !== "") lines.push(`project: ${oneLine(h.project)}`);
  lines.push(`status: ${oneLine(h.status)}`, "---");
  return lines;
}

function askOptions(meta) {
  const options = parseMetaObject(meta).options;
  return Array.isArray(options) ? options.filter((o) => o && o.key !== undefined) : [];
}

/**
 * One entry: its head line, then its continuation lines, no trailing newline.
 *
 * Continuation lines carry exactly two spaces, and an empty line is written
 * empty rather than as two spaces of nothing. That indent is the whole of how a
 * fenced block survives: a "$ " line inside a fence is "  $ ", which no longer
 * starts at column 0, so it can never be read as an entry.
 */
function formatEntry(entry, { clean = false } = {}) {
  const e = entry || {};
  if (e.kind === "raw") return String(e.text == null ? "" : e.text);

  const kind = e.kind || "say";
  const lines = normaliseBody(e.body).split("\n");
  let sigil;
  let head;
  let rest;

  if (kind === "run") {
    sigil = SIGILS.run;
    head = lines[0];
    // A command is one line, enforced where it is written. Should one arrive
    // with more, the extra lines are still shown rather than dropped, at the
    // cost of reading back as output.
    const out = normaliseBody(parseMetaObject(e.meta).out);
    rest = [...lines.slice(1), ...(out ? out.split("\n") : [])];
  } else if (kind === "ask") {
    sigil = SIGILS.ask;
    const options = askOptions(e.meta);
    head = lines[0] + (options.length ? ": " + options.map((o) => `[${oneLine(o.key)}] ${oneLine(o.label)}`).join(" ") : "");
    rest = lines.slice(1);
  } else if (kind === "decide" || kind === "note") {
    sigil = SIGILS[kind];
    head = lines[0];
    rest = lines.slice(1);
  } else {
    // say, and anything this version does not know, which is shown as said
    // rather than hidden.
    const type = e.author_type || inferAuthorType(e.author);
    sigil = type === "human" ? SIGILS.say_human : SIGILS.say_agent;
    head = `${oneLine(e.author)}:${lines[0] ? ` ${lines[0]}` : ""}`;
    rest = lines.slice(1);
  }

  let line = `${sigil} ${head}`;
  const tokens = clean ? [] : metaTokens({ ...e, kind });
  if (tokens.length) {
    line += `  {${tokens.join(" ")}}`;
  } else if (splitMeta(head)) {
    // The text itself ends in something that reads as a block (a quoted Sheet
    // line, usually). With no block of our own after it, the parser would take
    // that one, so an empty block goes on the end to say "the block is here,
    // and it is empty". The one place clean output carries braces.
    line += "  {}";
  }
  return [line, ...rest.map((l) => (l === "" ? "" : `  ${l}`))].join("\n");
}

/** The whole Sheet. Always ends with exactly one newline, or is empty. */
function format(sheet, { clean = false } = {}) {
  const s = sheet || {};
  const out = [];
  if (s.header) out.push(...headerLines(s.header));
  for (const entry of s.entries || []) out.push(formatEntry(entry, { clean }));
  return out.length ? `${out.join("\n")}\n` : "";
}

// --- reading ------------------------------------------------------------------

function parseHeader(lines) {
  const header = { task: null, title: "", project: null, status: "" };
  for (const line of lines) {
    const m = /^([A-Za-z_]+): ?(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2];
    if (key === "task") header.task = /^\d+$/.test(value) ? Number(value) : (value === "" ? null : value);
    else if (key === "title") header.title = value;
    else if (key === "project") header.project = value === "" ? null : value;
    else if (key === "status") header.status = value;
  }
  return header;
}

const blankEntry = () => ({
  id: null, kind: "say", author: null, author_type: null, body: "", meta: null,
  promoted: 0, ref_id: null, note_id: null, note_kind: null,
});

function buildEntry(head, continuation) {
  // Trailing empty lines belong to nobody: format never writes them.
  const cont = continuation.slice();
  while (cont.length && cont[cont.length - 1] === "") cont.pop();

  const sigil = head[0];
  if (head === "---" || RAW_SIGILS.has(sigil) || !ENTRY_START.test(head)) {
    return { kind: "raw", text: [head, ...cont].join("\n") };
  }

  const body = cont.map((l) => l.replace(/^ {1,2}/, ""));
  const split = splitMeta(head.slice(2));
  const text = split ? split.text : head.slice(2);
  const block = split ? split.meta : null;
  const entry = blankEntry();
  const meta = {};

  if (sigil === SIGILS.say_human || sigil === SIGILS.say_agent) {
    entry.kind = "say";
    entry.author_type = sigil === SIGILS.say_human ? "human" : "agent";
    const colon = text.indexOf(": ");
    if (colon >= 0) {
      entry.author = text.slice(0, colon);
      entry.body = [text.slice(colon + 2), ...body].join("\n");
    } else if (text.endsWith(":")) {
      entry.author = text.slice(0, -1);
      entry.body = body.join("\n");
    } else {
      entry.body = [text, ...body].join("\n");
    }
  } else if (sigil === SIGILS.run) {
    entry.kind = "run";
    entry.body = text;
    if (body.length) meta.out = body.join("\n");
  } else if (sigil === SIGILS.ask) {
    entry.kind = "ask";
    const at = text.indexOf(": [a] ");
    let question = text;
    if (at >= 0) {
      question = text.slice(0, at);
      let remaining = text.slice(at + ": [a] ".length);
      const options = [];
      let key = "a";
      for (const next of ["b", "c", "d"]) {
        const cut = remaining.indexOf(` [${next}] `);
        if (cut < 0) break;
        options.push({ key, label: remaining.slice(0, cut) });
        remaining = remaining.slice(cut + ` [${next}] `.length);
        key = next;
      }
      options.push({ key, label: remaining });
      meta.options = options;
    }
    entry.body = [question, ...body].join("\n");
  } else {
    entry.kind = sigil === SIGILS.decide ? "decide" : "note";
    entry.body = [text, ...body].join("\n");
  }

  if (block) {
    if (block.id !== undefined) entry.id = block.id;
    if (block.by !== undefined && entry.kind !== "say") entry.author = block.by;
    if (block.ref !== undefined) entry.ref_id = block.ref;
    if (block.promoted) entry.promoted = 1;
    if (block.note !== undefined) entry.note_kind = block.note;
    if (block.state !== undefined) meta.state = block.state;
    if (block.code !== undefined) meta.code = block.code;
    if (block.dur_ms !== undefined) meta.dur_ms = block.dur_ms;
    if (block.lines !== undefined) meta.lines = block.lines;
    if (block.cwd !== undefined) meta.cwd = block.cwd;
  }
  if (entry.kind !== "say" && entry.author !== null) entry.author_type = inferAuthorType(entry.author);
  entry.meta = Object.keys(meta).length ? meta : null;
  return entry;
}

/**
 * Text back into a header and entries.
 *
 * An entry runs until the next line at column 0 that starts an entry, or the
 * end. Anything at column 0 that does not start one, before the first entry or
 * a stray "---", becomes a raw entry: kept and written back, never imported.
 */
function parse(text) {
  const lines = String(text == null ? "" : text).replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  let header = null;
  let i = 0;
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close > 0) {
      header = parseHeader(lines.slice(1, close));
      i = close + 1;
    }
  }

  const entries = [];
  let head = null;
  let cont = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    const starts = ENTRY_START.test(line) || line === "---";
    if (starts || head === null) {
      if (head !== null) entries.push(buildEntry(head, cont));
      head = line;
      cont = [];
    } else {
      cont.push(line);
    }
  }
  if (head !== null) entries.push(buildEntry(head, cont));
  return { header, entries };
}

/** Clean text: every {} block stripped and nothing else. Idempotent. */
function clean(textOrSheet) {
  const sheet = typeof textOrSheet === "string" ? parse(textOrSheet) : textOrSheet;
  return format(sheet, { clean: true });
}

module.exports = {
  SIGILS, META_ORDER,
  inferAuthorType, format, formatEntry, parse, clean, parseMeta, formatMeta, stripAnsi,
  normaliseBody,
};
