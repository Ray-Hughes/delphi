// Memory, the window's half: the Memory tab's list and search, a task's
// related notes with their reasons, and Log a fact.
//
//   memory:list(projectId)          a project's notes (its own and those shown
//                                   in it), or every note when projectId is null
//   memory:search(query, projectId) the notes a search finds, each with why
//   memory:relatedFor(taskId, opts) { task, notes: [card], total }, each card
//                                   with why and reasons. Null for no such task
//   memory:logFact(payload)         { text, kind, projectId, taskId }
//
// The ranking and the reasons are agent/recall.js, which the MCP server's
// related_notes shares, so the cards an agent is handed and the cards a person
// sees beside a task say the same thing.
//
// A fact linked to a task is written the way the Sheet files one: a note entry
// on the task, then filed (sheet/store.js file), so the note says which task
// and entry it came from, the entry points at the note, and the task's ledger
// carries it. Without a task it is a plain note. Either way it is a row in
// notes like any other, which is what puts it in the graph and in recall.
//
// Required by main.js, and by tools/memory_fact_test.js under a plain Node, so
// it takes the database and the Sheet store as arguments.

const { makeRecall, clip } = require("../agent/recall");
const embeddings = require("../embeddings");
const schemaLater = require("../agent/schema_later");

const FACT_KINDS = ["gotcha", "decision", "reference", "note"];
const MAX_FACT = 2000;

/**
 * @param db      db.js, or anything with sqlP, createNote
 * @param sheets  a sheet/store.js store, for a fact linked to a task
 */
function createMemory({ db, sheets }) {
  const recall = makeRecall({
    sql: db.sqlP,
    hasTable: (name) => schemaLater.hasTable((s) => db.sqlP(s), name),
    // Search ranks by meaning too when a model answers in time, as the
    // server's does. Related cards never ask: they read stored vectors only.
    embedQuery: (text) => embeddings.embedQuery(text),
  });

  /** Every note in a project, or in all of them, newest first, with its home. */
  function list(projectId = null) {
    if (projectId != null) return db.listNotes(Number(projectId));
    return db.sqlP(
      `SELECT n.id, n.project_id, n.title, n.kind, n.pinned, n.created_at, n.updated_at, substr(n.body, 1, 400) AS body,
              0 AS associated, p.name AS home_name, p.colour AS home_colour
         FROM notes n LEFT JOIN projects p ON p.id = n.project_id
        ORDER BY n.pinned DESC, n.updated_at DESC, n.id DESC LIMIT 1000`);
  }

  /**
   * One line, cleaned: a fact is a sentence somebody typed, so a pasted
   * newline is a space rather than a second paragraph nobody meant.
   */
  function cleanFact(text) {
    const line = String(text == null ? "" : text).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
    if (!line) throw new Error("A fact needs something in it.");
    if (line.length > MAX_FACT) throw new Error(`A fact is one line, at most ${MAX_FACT} characters. Write a note for more.`);
    return line;
  }

  function logFact({ text, kind = "note", projectId = null, taskId = null } = {}) {
    const line = cleanFact(text);
    if (!FACT_KINDS.includes(kind)) throw new Error(`kind must be one of ${FACT_KINDS.join(", ")}, got '${kind}'.`);
    const title = clip(line, 80);
    if (taskId != null) {
      const task = db.sqlP("SELECT id, project_id FROM tasks WHERE id = :p1", [Number(taskId)])[0];
      if (!task) throw new Error(`No task ${taskId}.`);
      // The task's project, whatever scope the window was in: a note filed from
      // a Sheet lives where its task lives.
      // Two writes, not one batch: the Sheet store owns both. If filing fails,
      // the entry stays on the Sheet with the text in it, which is the
      // never-lose-work answer; the error says so, and filing it again from the
      // Sheet makes the note.
      const entry = sheets.append({ taskId: Number(task.id), kind: "note", body: line });
      let filed;
      try { filed = sheets.file(entry.id, kind, title); } catch (error) {
        throw new Error(`Kept on #${task.id}'s Sheet as entry ${entry.id}, but not filed as a note: ${error.message}`);
      }
      const note = db.sqlP("SELECT * FROM notes WHERE id = :p1", [Number(filed.note.id)])[0];
      return { note, entryId: Number(entry.id), taskId: Number(task.id) };
    }
    if (projectId == null) throw new Error("Which project? A fact needs one to live in.");
    const project = db.sqlP("SELECT id FROM projects WHERE id = :p1", [Number(projectId)])[0];
    if (!project) throw new Error(`No project ${projectId}.`);
    const note = db.createNote({ projectId: Number(project.id), title, body: line, kind });
    return { note, entryId: null, taskId: null };
  }

  return {
    list,
    logFact,
    relatedFor: (taskId, opts = {}) => recall.related(taskId, { limit: Number(opts.limit) || 6 }),
    search: (query, projectId = null) => recall.searchNotes(String(query || ""), { projectId }),
    FACT_KINDS,
  };
}

function register(handle, { memory, afterWrite = () => {} }) {
  handle("memory:list", (projectId) => memory.list(projectId ?? null));
  handle("memory:search", (query, projectId) => memory.search(query, projectId ?? null));
  handle("memory:relatedFor", (taskId, opts) => memory.relatedFor(taskId, opts || {}));
  handle("memory:logFact", (payload) => { const r = memory.logFact(payload || {}); afterWrite(); return r; });
  return memory;
}

module.exports = { createMemory, register, FACT_KINDS };
