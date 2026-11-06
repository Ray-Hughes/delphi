// The weekly review, the window's half: the review itself (today/weekly.js,
// which the MCP server's weekly_review shares), and the three things a person
// does from it that an agent asking weekly_review cannot. Park and Drop a
// stale task, and save next week's objectives.
//
// Every write here runs inside BEGIN IMMEDIATE. The MCP server is another
// process on the same file, and an agent can write to the same task at any
// moment; holding the write lock from before the check to after the write
// means the status read is still true when it is changed, and every audit and
// status_events row numbered after the mark, on that task, is this action's
// and nobody else's. Those exact ids are what Undo later takes back.
//
// Park and Drop hand the window a receipt number; the ids it covers stay in
// this process, so Undo can only ever reach what this window wrote. Undo runs
// db.undo on each History row, newest first, in one transaction, and also
// deletes the status_events rows the action wrote, which db.undo leaves: a
// Park undone would otherwise still read as a step back to To do next week,
// and as time spent in To do in the ledger. Any refusal rolls the whole Undo
// back and is said word for word.
//
// Required by main.js, and by tools/weekly_test.js under a plain Node, so it
// takes everything it touches as arguments.

const weekly = require("../today/weekly");
const brief = require("../today/brief");

const { DROP_PREFIX, DROP_META } = weekly;

/**
 * @param db       db.js: updateTask, createNote, updateNote, undo, sqlP, handle
 * @param sheets   the window's Sheet store, for the note a Drop leaves
 * @param after    called after every write (the vault export)
 * @param clock    () => ms, so a test can move time
 */
function createWeekly({ db, sheets, after = () => {}, clock = () => Date.now() }) {
  const sql = db.sqlP;
  const top = (table) => Number((sql(`SELECT COALESCE(max(id), 0) AS id FROM ${table}`, [])[0] || {}).id || 0);

  /** fn inside BEGIN IMMEDIATE: committed whole, or rolled back whole and the error rethrown. */
  function locked(fn) {
    const conn = db.handle();
    // Every IPC handler in the main process runs to completion before the
    // next, so none should be holding a transaction here. If one is, nesting
    // would silently lose the lock this depends on, so it refuses instead.
    if (conn.isTransaction) throw new Error("Another change is still being written. Try again in a moment.");
    conn.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      conn.exec("COMMIT");
      return result;
    } catch (error) {
      // A failed COMMIT too: a transaction left open on the app's one
      // connection would refuse every write after it.
      if (conn.isTransaction) { try { conn.exec("ROLLBACK"); } catch (rollback) { console.error("weekly review rollback", rollback); } }
      throw error;
    }
  }

  /**
   * The rows a write made, read before the lock is let go. Every row past the
   * mark, on any task or entity: under the lock nobody else can have written
   * one, and a status change can reach past its task (a parent, the pad).
   */
  function wrote(write) {
    const from = { audit: top("audit"), events: top("status_events") };
    write();
    return {
      audit: sql("SELECT id FROM audit WHERE id > :p1 ORDER BY id", [from.audit]).map((r) => Number(r.id)),
      events: sql("SELECT id, task_id FROM status_events WHERE id > :p1 ORDER BY id", [from.events])
        .map((r) => ({ id: Number(r.id), task_id: Number(r.task_id) })),
    };
  }
  // The vault export after a write that has already landed: its failure is
  // logged, never turned into an error that would lose the Undo receipt.
  const done = () => { try { after(); } catch (error) { console.error("weekly review, after a write", error); } };

  const taskOf = (id) => {
    const t = sql("SELECT id, title, status FROM tasks WHERE id = :p1", [Number(id)])[0];
    if (!t) throw new Error(`There is no task #${id} any more.`);
    return t;
  };

  const receipts = new Map();
  let nextReceipt = 1;
  const receipt = (taskId, was, kind, rows) => {
    const id = nextReceipt++;
    receipts.set(id, { taskId, ...rows });
    for (const k of [...receipts.keys()].slice(0, Math.max(0, receipts.size - 200))) receipts.delete(k);
    return { receipt: id, task_id: taskId, was, kind, audit: rows.audit };
  };

  function view({ projectId = null, days = 7 } = {}) {
    return weekly.review(sql, { now: clock(), projectId, days });
  }

  /** The Today card's one question, without running the whole review. */
  // Whether the objectives a save now would write already exist: the same
  // week rule review() uses for saved_this_week.
  function status() {
    const week = weekly.objectivesWeek(clock());
    const row = sql(`SELECT updated_at FROM notes WHERE kind = 'decision' AND title = :p1 ORDER BY id LIMIT 1`,
      [`${weekly.OBJECTIVES_TITLE}${week}`])[0];
    return { week, savedAt: row ? brief.stamp(row.updated_at) : null, savedThisWeek: Boolean(row) };
  }

  /** Park: back to To do, off the stale list, and History can undo it. */
  function park(taskId) {
    const out = locked(() => {
      const t = taskOf(taskId);
      if (t.status === "todo") throw new Error(`#${t.id} is already in To do.`);
      return { t, rows: wrote(() => db.updateTask(t.id, { status: "todo" })) };
    });
    done();
    // The receipt only once the rows are committed: a rolled back write's ids
    // would be handed out again to the next writer.
    return receipt(out.t.id, out.t.status, "park", out.rows);
  }

  /**
   * Drop: done with a note saying why, so the Sheet records that it was let
   * go rather than finished. The note carries DROP_META, which is what the
   * look back counts; the words are for people and may be edited. Note and
   * status are one transaction, so a status that cannot be set leaves no note.
   */
  function drop(taskId, why = "") {
    const reason = String(why || "").replace(/\s+/g, " ").trim().slice(0, 500);
    const out = locked(() => {
      const t = taskOf(taskId);
      if (t.status === "done") throw new Error(`#${t.id} is already done.`);
      return { t, rows: wrote(() => {
        sheets.append({ taskId: t.id, kind: "note", meta: { ...DROP_META },
          body: reason ? `${DROP_PREFIX}: ${reason}` : `${DROP_PREFIX}, not finished.` });
        db.updateTask(t.id, { status: "done" });
      }) };
    });
    done();
    return receipt(out.t.id, out.t.status, "drop", out.rows);
  }

  /** Undoes what a Park or Drop wrote, by its receipt: all of it, or none of it. */
  function undo({ receipt: id } = {}) {
    const r = receipts.get(Number(id));
    if (!r) throw new Error("This window no longer holds that change, so undo it from History.");
    const out = locked(() => {
      const undone = [];
      for (const auditId of r.audit.slice().sort((a, b) => b - a)) {
        const row = sql("SELECT undone FROM audit WHERE id = :p1", [auditId])[0];
        if (!row) throw new Error(`History row ${auditId} is gone, so this cannot be undone from here.`);
        if (Number(row.undone) === 1) continue;
        db.undo(auditId);
        undone.push(auditId);
      }
      for (const e of r.events) sql("DELETE FROM status_events WHERE id = :p1 AND task_id = :p2", [e.id, e.task_id]);
      return { undone };
    });
    receipts.delete(Number(id));
    done();
    return out;
  }

  /**
   * Next week's objectives, as a decision note in one project. Three to five,
   * the Sunsama number: fewer is not a plan, more is a backlog.
   */
  function save({ projectId, objectives }) {
    const pid = Number(projectId);
    if (!Number.isInteger(pid) || !sql("SELECT id FROM projects WHERE id = :p1", [pid])[0]) throw new Error("Pick the project the objectives are kept in.");
    const list = (Array.isArray(objectives) ? objectives : [])
      .map((o) => ({ text: String((o && o.text) || "").replace(/\s+/g, " ").trim().slice(0, 200) }))
      .filter((o) => o.text);
    if (list.length < weekly.OBJECTIVES_MIN || list.length > weekly.OBJECTIVES_MAX) {
      throw new Error(`Pick ${weekly.OBJECTIVES_MIN} to ${weekly.OBJECTIVES_MAX} objectives; ${list.length} ${list.length === 1 ? "is" : "are"} picked.`);
    }
    const now = clock();
    const week = weekly.objectivesWeek(now);
    const title = `${weekly.OBJECTIVES_TITLE}${week}`;
    const text = weekly.objectivesBody(list, { week, on: weekly.localDate(now) });
    // One note per week: saving again (a second review, a save that landed
    // after the panel closed) rewrites that week's note, wherever it is kept,
    // rather than leaving two that disagree.
    const note = locked(() => {
      const had = sql(`SELECT id FROM notes WHERE kind = 'decision' AND title = :p1 ORDER BY id LIMIT 1`, [title])[0];
      if (had) return { ...db.updateNote(Number(had.id), { body: text }), updated: true };
      return { ...db.createNote({ projectId: pid, kind: "decision", title, body: text }), updated: false };
    });
    done();
    return note;
  }

  return { view, status, park, drop, undo, save };
}

function register(handle, { weekly: w }) {
  handle("weekly:view", (opts) => w.view(opts || {}));
  handle("weekly:status", () => w.status());
  handle("weekly:park", (taskId) => w.park(taskId));
  handle("weekly:drop", (taskId, why) => w.drop(taskId, why));
  handle("weekly:undo", (what) => w.undo(what || {}));
  handle("weekly:save", (payload) => w.save(payload || {}));
}

module.exports = { createWeekly, register };
