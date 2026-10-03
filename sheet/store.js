/**
 * The Sheet's rows: every read and write of the entries on a task.
 *
 * Shared by the app and the MCP server rather than twinned. CLAUDE.md explains
 * why the server duplicates db.js: it cannot load node:sqlite. That stays true,
 * but this module never touches a database itself. It is SQL text and rules,
 * and it is handed a sql(query, params) function in the server's :p1 style. The
 * server passes its own, which substitutes literals and may be shelling out to
 * sqlite3; db.js passes sqlP, which binds. One implementation, two routes, and
 * the rules about what a valid entry is cannot drift between them.
 *
 * Two consequences for anything written here:
 *
 * - Every insert uses RETURNING. On the sqlite3 route each sql() call is its own
 *   process, so last_insert_rowid() is always 0 there.
 * - Nothing may assume a transaction spans two calls, for the same reason.
 *
 * Comments keep their table. An entry is a comment with a kind, so everything
 * that already reads comments (the vault, undo, the importers) keeps working.
 */

const fmt = require("./format");
const decide = require("./decide");

const KINDS = ["say", "run", "ask", "decide", "note"];
const NOTE_KINDS = ["decision", "gotcha", "reference", "note"];
// How many of the most recent entries an agent is shown beside the ledger. A
// constant rather than a setting: a setting would change what every agent sees
// per database, which is the lesson the scratchpad switch taught. Revisit with
// data.
const LEDGER_TAIL = 20;
const MAX_READ = 500;
const AUTHOR_TYPES = ["human", "agent", "tool"];

const ENTRY_COLUMNS = `c.id, c.task_id, c.kind, c.author, c.author_type, c.body, c.meta, c.promoted,
       c.ref_id, c.note_id, n.kind AS note_kind, c.created_at, c.updated_at`;
const ENTRY_FROM = "FROM comments c LEFT JOIN notes n ON n.id = c.note_id";

// What is in a task's ledger, as a condition on comments aliased c with the
// task id at :p1. The spec's rule: promoted entries, plus every resolved
// decision, plus the question each answers. A decision is in whatever its
// promoted flag says, because unpromoting one would otherwise leave the next
// agent reopening a question that was settled; the question comes too, so an
// answer is never shown without it.
const LEDGER_WHERE = `(c.promoted = 1
   OR (c.kind = 'decide' AND c.ref_id IS NOT NULL)
   OR c.id IN (SELECT d.ref_id FROM comments d
                WHERE d.task_id = :p1 AND d.kind = 'decide' AND d.ref_id IS NOT NULL))`;

const clip = (text, limit) => {
  const value = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
};

/** A row as every surface sees it, from MCP and IPC alike. */
function toEntry(row) {
  if (!row) return null;
  let meta = null;
  if (row.meta !== null && row.meta !== undefined && row.meta !== "") {
    try {
      const parsed = JSON.parse(row.meta);
      meta = parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      meta = null;
    }
  }
  return {
    id: Number(row.id),
    task_id: Number(row.task_id),
    kind: row.kind || "say",
    author: row.author,
    // Resolved here so no reader has to know the rule. Stored null means the
    // writer did not know, and the name is the next best evidence.
    author_type: row.author_type || fmt.inferAuthorType(row.author),
    body: row.body,
    meta,
    promoted: Number(row.promoted) ? 1 : 0,
    ref_id: row.ref_id === null || row.ref_id === undefined ? null : Number(row.ref_id),
    note_id: row.note_id === null || row.note_id === undefined ? null : Number(row.note_id),
    note_kind: row.note_kind || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** A whole number id, or a plain sentence saying what was wrong with it. */
function idOf(value, what) {
  const n = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${what} must be a whole number, got '${value}'.`);
  }
  return n;
}

/**
 * A body as it is stored: line endings made \n and blank lines at either end
 * dropped, the same normalising the text format does. Stored that way so a
 * single entry yanked from the Sheet is byte for byte what was written.
 */
function cleanBody(body) {
  return fmt.normaliseBody(body);
}

function makeSheetStore({ sql, actor = "agent", authorType = null } = {}) {
  if (typeof sql !== "function") throw new Error("makeSheetStore needs a sql(query, params) function");
  const writer = String(actor || "agent");
  const writerType = AUTHOR_TYPES.includes(authorType) ? authorType : null;

  const taskRow = (id) => sql("SELECT * FROM tasks WHERE id = :p1", [id])[0] || null;

  function requireTask(taskId) {
    const id = idOf(taskId, "task_id");
    const task = taskRow(id);
    if (!task) throw new Error(`No task ${id}.`);
    return task;
  }

  // Comments are not in the audit table's entity list, so the task carries the
  // trail, as add_comment and db.createComment already do. That keeps History
  // readable: "promoted entry 812" belongs against the task, not against a row
  // nobody can navigate to.
  function audit(task, summary) {
    sql(`INSERT INTO audit (action, entity, entity_id, summary, label)
         VALUES ('update', 'task', :p1, :p2, :p3)`,
        [task.id, `${summary} (by ${writer})`, task.title]);
  }

  function get(id) {
    const entryId = idOf(id, "Entry id");
    const row = sql(`SELECT ${ENTRY_COLUMNS} ${ENTRY_FROM} WHERE c.id = :p1`, [entryId])[0];
    if (!row) throw new Error(`No entry ${entryId}.`);
    return toEntry(row);
  }

  /**
   * A task from whatever a person or agent has to hand: the id, the old
   * T-number, or the ticket ref. Ambiguity is an error naming the candidates,
   * never a guess, because the wrong task is worse than none.
   */
  function resolveTask(ref) {
    const text = String(ref == null ? "" : ref).trim().replace(/^#/, "");
    if (!text) throw new Error("Which task? Give an id, a legacy id, or a ref.");
    if (/^\d+$/.test(text)) {
      const task = taskRow(Number(text));
      if (task) return task;
    }
    const legacy = sql("SELECT * FROM tasks WHERE legacy_id = :p1 ORDER BY id", [text]);
    if (legacy.length === 1) return legacy[0];
    const byRef = legacy.length ? legacy : sql("SELECT * FROM tasks WHERE lower(ref) = lower(:p1) ORDER BY id", [text]);
    if (byRef.length === 1) return byRef[0];
    if (byRef.length > 1) {
      throw new Error(`Several tasks match '${text}': ${byRef.map((t) => `${t.id} (${t.title})`).join(", ")}. Use the id.`);
    }
    throw new Error(`No task matches '${text}'. Use its id, its legacy id or its ref.`);
  }

  function header(taskId) {
    const task = requireTask(taskId);
    const project = task.project_id != null
      ? sql("SELECT key FROM projects WHERE id = :p1", [task.project_id])[0]
      : null;
    return { task: Number(task.id), title: task.title, project: project ? project.key : null, status: task.status };
  }

  /** The ledger: see LEDGER_WHERE. */
  function ledger(taskId) {
    const task = requireTask(taskId);
    return sql(`SELECT ${ENTRY_COLUMNS} ${ENTRY_FROM} WHERE c.task_id = :p1 AND ${LEDGER_WHERE} ORDER BY c.id`, [task.id])
      .map(toEntry);
  }

  /**
   * Entries in id order.
   *
   * mode full is everything, ledger is ledger(), tail is the last n. With a
   * cursor (afterId, since, or both) only entries newer than it come back, OR'd,
   * because a poller wants new rows and rows edited since it last looked, and
   * dedupes by id. A cursor read is never cut to n: a poller that fell behind
   * by more than n would otherwise lose the difference silently.
   */
  function entries(taskId, { mode = "full", n = LEDGER_TAIL, afterId = null, since = null } = {}) {
    if (!["full", "ledger", "tail"].includes(mode)) throw new Error(`mode must be full, ledger or tail, got '${mode}'.`);
    const task = requireTask(taskId);
    const params = [task.id];
    const where = ["c.task_id = :p1"];
    const cursor = [];
    if (afterId !== null && afterId !== undefined && afterId !== "") {
      const after = Number(afterId);
      if (!Number.isSafeInteger(after) || after < 0) throw new Error(`after_id must be a whole number, got '${afterId}'.`);
      params.push(after);
      cursor.push(`c.id > :p${params.length}`);
    }
    if (since !== null && since !== undefined && since !== "") {
      params.push(String(since));
      cursor.push(`c.updated_at >= :p${params.length}`);
    }
    if (cursor.length) where.push(`(${cursor.join(" OR ")})`);
    if (mode === "ledger") where.push(LEDGER_WHERE);
    if (mode === "tail" && !cursor.length) {
      const limit = Math.max(1, Math.min(MAX_READ, Math.floor(Number(n)) || LEDGER_TAIL));
      params.push(limit);
      return sql(
        `SELECT * FROM (SELECT ${ENTRY_COLUMNS} ${ENTRY_FROM} WHERE ${where.join(" AND ")}
                        ORDER BY c.id DESC LIMIT :p${params.length})
          ORDER BY id`,
        params
      ).map(toEntry);
    }
    return sql(`SELECT ${ENTRY_COLUMNS} ${ENTRY_FROM} WHERE ${where.join(" AND ")} ORDER BY c.id`, params).map(toEntry);
  }

  /**
   * What an agent is handed about a task: the ledger, then the last few entries,
   * in id order, as entries and as clean text. total and shown say how much was
   * left out, so an agent knows when to ask for the full Sheet.
   */
  function context(taskId) {
    const task = requireTask(taskId);
    const list = sql(
      `SELECT ${ENTRY_COLUMNS} ${ENTRY_FROM}
        WHERE c.task_id = :p1
          AND (${LEDGER_WHERE}
               OR c.id IN (SELECT t.id FROM comments t WHERE t.task_id = :p1 ORDER BY t.id DESC LIMIT :p2))
        ORDER BY c.id`,
      [task.id, LEDGER_TAIL]
    ).map(toEntry);
    const total = Number(sql("SELECT COUNT(*) AS n FROM comments WHERE task_id = :p1", [task.id])[0].n);
    return {
      entries: list,
      text: fmt.format({ header: header(task.id), entries: list }, { clean: true }),
      total,
      shown: list.length,
    };
  }

  /**
   * One read of a Sheet, as sheet_read and the sheet:read channel both serve
   * it. The cursor's since is the database's own clock, taken before the
   * read, so a poller passing it back cannot miss a write that landed while
   * this one ran; since is inclusive and pollers dedupe by id.
   */
  function read(taskId, { mode = "tail", n = LEDGER_TAIL, afterId = null, since = null } = {}) {
    const task = requireTask(taskId);
    const now = sql("SELECT datetime('now') AS now")[0].now;
    const list = entries(task.id, { mode, n, afterId, since });
    const counts = sql(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN ${LEDGER_WHERE} THEN 1 ELSE 0 END) AS ledger
         FROM comments c WHERE c.task_id = :p1`, [task.id])[0];
    const last = list.length ? list[list.length - 1].id : null;
    const after = afterId === null || afterId === undefined || afterId === "" ? 0 : Number(afterId);
    return {
      entries: list,
      total: Number(counts.total) || 0,
      ledger_count: Number(counts.ledger) || 0,
      cursor: { after_id: Math.max(after, last || 0), since: now },
    };
  }

  function sheet(taskId, { mode = "full" } = {}) {
    return { header: header(taskId), entries: entries(taskId, { mode }) };
  }

  function validateBody(kind, body) {
    const text = cleanBody(body);
    if (!text.trim()) throw new Error("An entry needs something in it.");
    if (kind === "run" && text.includes("\n")) {
      throw new Error("A command is one line. Put a longer one in a script and run that.");
    }
    return text;
  }

  function insert({ task, kind, body, meta = null, refId = null, promote = false, author = null, authorType: type = null }) {
    let ref = null;
    if (refId !== null && refId !== undefined && refId !== "") {
      ref = get(refId);
      if (ref.task_id !== Number(task.id)) {
        throw new Error(`Entry ${ref.id} is on task ${ref.task_id}, not task ${task.id}. A reference has to stay on its own Sheet.`);
      }
    }
    if (meta !== null && meta !== undefined && (typeof meta !== "object" || Array.isArray(meta))) {
      throw new Error("meta must be an object.");
    }
    const who = author === null || author === undefined || author === "" ? writer : String(author);
    const resolvedType = AUTHOR_TYPES.includes(type) ? type : writerType;
    const row = sql(
      `INSERT INTO comments (task_id, author, body, kind, author_type, meta, promoted, ref_id)
       VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7, :p8)
       RETURNING id`,
      [task.id, who, body, kind, resolvedType, meta ? JSON.stringify(meta) : null, promote ? 1 : 0, ref ? ref.id : null]
    )[0];
    return get(row.id);
  }

  /**
   * Writes a say, run or note. author and authorType are for trusted in
   * process callers (an import, the chat mapper); the MCP tools and the IPC
   * handlers never pass them through from their input, so an entry is always
   * attributed to whoever the store was made for.
   */
  function append({ taskId, kind = "say", body, meta = null, refId = null, promote = false, author = null, authorType: type = null } = {}) {
    if (kind === "ask" || kind === "decide") {
      // Their rules (options, a choice that matches one) live in ask() and
      // decide(); a raw append would skip them and write a question nothing
      // can answer.
      throw new Error(`Use ${kind}() for a${kind === "ask" ? "n ask" : " decide"} entry, not append().`);
    }
    if (!KINDS.includes(kind)) throw new Error(`kind must be one of say, run, note, got '${kind}'.`);
    const task = requireTask(taskId);
    const text = validateBody(kind, body);
    const entry = insert({ task, kind, body: text, meta, refId, promote, author, authorType: type });
    audit(task, kind === "run" ? `ran ${clip(text, 60)}` : kind === "note" ? "noted" : "commented");
    return entry;
  }

  /**
   * Changes an entry's meta, its body, or both. Meta is merged one level deep,
   * so finishing a run does not have to restate its cwd.
   */
  function update(id, { meta = undefined, body = undefined } = {}) {
    const before = get(id);
    const task = requireTask(before.task_id);
    if (meta !== undefined && meta !== null && (typeof meta !== "object" || Array.isArray(meta))) {
      throw new Error("meta must be an object.");
    }
    const changes = (key) => meta && Object.prototype.hasOwnProperty.call(meta, key)
      && JSON.stringify(meta[key]) !== JSON.stringify((before.meta || {})[key]);
    let text = body === undefined ? before.body : validateBody(before.kind, body);
    // An edit keeps the kind's rules, or it could make an entry that the text
    // format, or an ask's answer, can no longer read.
    if (before.kind === "ask") {
      if (changes("options")) throw new Error("The options of a question cannot change once asked. Ask again instead.");
      if (body !== undefined) text = validateQuestion(text);
    }
    if (before.kind === "decide") {
      if (changes("choice") || changes("label")) {
        throw new Error("A decision's choice cannot change. Answer the question again instead.");
      }
      if (body !== undefined) {
        // Only the why is editable; the first line is the choice and stays it.
        const why = text.split("\n")[0] === String(before.meta && before.meta.choice) ? text.split("\n").slice(1).join("\n") : text;
        const reason = cleanBody(why);
        text = reason ? `${before.meta.choice}\n${reason}` : String(before.meta.choice);
      }
    }
    const merged = meta === undefined ? before.meta : { ...(before.meta || {}), ...(meta || {}) };
    sql(`UPDATE comments SET meta = :p1, body = :p2, updated_at = datetime('now') WHERE id = :p3`,
        [merged ? JSON.stringify(merged) : null, text, before.id]);
    const after = get(before.id);

    const wasRunning = !before.meta || before.meta.state === "running" || before.meta.state === undefined;
    const finished = before.kind === "run" && after.meta && (after.meta.state === "ok" || after.meta.state === "fail") && wasRunning;
    if (finished) {
      const code = after.meta.code === null || after.meta.code === undefined ? "" : `:${after.meta.code}`;
      audit(task, `finished ${clip(after.body, 40)}: ${after.meta.state === "ok" ? "ok" : `fail${code}`}`);
    } else {
      audit(task, `edited entry ${after.id}`);
    }
    return after;
  }

  function promote(id, on = true) {
    const before = get(id);
    const task = requireTask(before.task_id);
    const flag = on === false || on === 0 || on === "false" ? 0 : 1;
    sql("UPDATE comments SET promoted = :p1, updated_at = datetime('now') WHERE id = :p2", [flag, before.id]);
    audit(task, `${flag ? "promoted" : "unpromoted"} entry ${before.id}`);
    return get(before.id);
  }

  /**
   * Turns an entry into a project note, so the graph and search can find it on
   * other tasks. Filing promotes too: something worth keeping for the project is
   * worth the next agent on this task reading first.
   *
   * Filing twice returns the note from the first time rather than a second copy.
   */
  function file(id, kind, title = null) {
    if (!NOTE_KINDS.includes(kind)) throw new Error(`kind must be one of ${NOTE_KINDS.join(", ")}, got '${kind}'.`);
    const entry = get(id);
    const task = requireTask(entry.task_id);
    if (entry.note_id) {
      const existing = sql("SELECT id, title, kind, project_id FROM notes WHERE id = :p1", [entry.note_id])[0];
      if (existing) return { entry, note: existing };
    }

    let body = entry.body;
    if (entry.kind === "decide" && entry.ref_id) {
      let ask = null;
      try { ask = get(entry.ref_id); } catch { ask = null; }
      if (ask) body = decide.decisionNoteBody(ask, entry);
    } else if (entry.kind === "ask") {
      const options = (entry.meta && Array.isArray(entry.meta.options)) ? entry.meta.options : [];
      body = [entry.body, "", ...options.map((o) => `[${o.key}] ${o.label}`)].join("\n").trim();
    }
    body = `${body}\n\nFrom task #${task.id}, entry ${entry.id}`;
    const noteTitle = clip(title && String(title).trim() ? title : body.split("\n")[0], 80) || `Entry ${entry.id}`;

    const note = sql(
      `INSERT INTO notes (project_id, title, body, kind) VALUES (:p1, :p2, :p3, :p4)
       RETURNING id, title, kind, project_id`,
      [task.project_id ?? null, noteTitle, body, kind]
    )[0];
    sql(`UPDATE comments SET note_id = :p1, promoted = 1, updated_at = datetime('now') WHERE id = :p2`,
        [note.id, entry.id]);
    audit(task, `filed entry ${entry.id} as ${kind}`);
    sql(`INSERT INTO audit (action, entity, entity_id, summary, label) VALUES ('create', 'note', :p1, :p2, :p3)`,
        [note.id, `created (by ${writer})`, note.title]);
    return { entry: get(entry.id), note };
  }

  /**
   * A question with two to four answers. Keys a to d because that is what the
   * terminal answers with, e being edit. A label may not contain [x], since that
   * is how the text format finds where one option ends.
   */
  function validateQuestion(question) {
    const q = cleanBody(question);
    if (!q.trim()) throw new Error("A question needs something in it.");
    if (q.includes("\n")) throw new Error("A question is one line. Put the background in a say entry first.");
    if (q.includes(": [a] ")) throw new Error("A question cannot contain ': [a] ', which is how the text format finds the options.");
    return q;
  }

  function ask(taskId, question, options, { author = null } = {}) {
    const task = requireTask(taskId);
    const q = validateQuestion(question);
    if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
      throw new Error("An ask needs two to four options.");
    }
    const keys = ["a", "b", "c", "d"];
    const list = options.map((option, i) => {
      const label = String(option == null ? "" : option).trim();
      if (!label) throw new Error(`Option ${keys[i]} is empty.`);
      if (/[\r\n]/.test(label)) throw new Error(`Option ${keys[i]} is more than one line.`);
      if (/\[[A-Za-z]\]/.test(label)) throw new Error(`Option ${keys[i]} cannot contain [${keys[i]}]-style brackets.`);
      return { key: keys[i], label };
    });
    const entry = insert({ task, kind: "ask", body: q, meta: { options: list }, author });
    audit(task, `asked "${clip(q, 60)}"`);
    return entry;
  }

  /** Answers an ask. Promoted, because a decision is what the next agent most needs. */
  function decideAsk(askId, choice, why = null, { author = null } = {}) {
    const askEntry = get(askId);
    if (askEntry.kind !== "ask") throw new Error(`Entry ${askEntry.id} is a ${askEntry.kind}, not a question.`);
    const options = (askEntry.meta && Array.isArray(askEntry.meta.options)) ? askEntry.meta.options : [];
    const key = String(choice == null ? "" : choice).trim().toLowerCase();
    const option = options.find((o) => String(o.key).toLowerCase() === key);
    if (!option) {
      throw new Error(`Choose one of ${options.map((o) => o.key).join(", ")} for entry ${askEntry.id}, not '${choice}'.`);
    }
    const reason = why === null || why === undefined ? "" : cleanBody(why);
    const task = requireTask(askEntry.task_id);
    const entry = insert({
      task, kind: "decide",
      body: reason ? `${option.key}\n${reason}` : option.key,
      meta: { choice: option.key, label: option.label },
      refId: askEntry.id, promote: true, author,
    });
    audit(task, `decided ${option.key} on ${askEntry.id}`);
    return entry;
  }

  /** Tasks done more than `days` ago, whose run logs can go. */
  function prunable(days = 30) {
    const n = Math.max(0, Math.floor(Number(days)));
    if (!Number.isFinite(n)) throw new Error("days must be a number.");
    return sql(
      `SELECT id FROM tasks WHERE status = 'done' AND completed_at IS NOT NULL
         AND completed_at < datetime('now', :p1) ORDER BY id`,
      [`-${n} days`]
    ).map((r) => Number(r.id));
  }

  return {
    resolveTask, header, entries, read, ledger, context, append, update, promote, file, ask,
    decide: decideAsk, get, sheet, prunable,
  };
}

module.exports = { KINDS, NOTE_KINDS, LEDGER_TAIL, makeSheetStore, toEntry };
