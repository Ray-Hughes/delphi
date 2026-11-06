// The weekly review, the window's half: the review itself (today/weekly.js,
// which the MCP server's weekly_review shares), and the three things a person
// does from it that an agent asking weekly_review cannot. Park and Drop a
// stale task, and save next week's objectives.
//
// Park and Drop each hand back the History rows they wrote, so the review can
// offer Undo on the row itself rather than sending a person to History to find
// them. Undo goes through db.undo, newest first, with every check it makes, and
// stops at the first refusal so a half-undone Drop says which half is left.
//
// db.undo puts the status back but not the status_events row the change wrote,
// so a Park undone would still read as a step back to To do in next week's
// review, and as time spent in To do in the ledger. Undo here takes that row
// away too, once every History row is undone: the change did not happen. The
// window holds only a receipt number; what it covers stays in this process.
//
// Required by main.js, and by tools/weekly_test.js under a plain Node, so it
// takes everything it touches as arguments.

const weekly = require("../today/weekly");
const brief = require("../today/brief");

const { DROP_PREFIX } = weekly;

/**
 * @param db       db.js: updateTask, createNote, undo, sqlP
 * @param sheets   the window's Sheet store, for the note a Drop leaves
 * @param after    called after every write (the vault export)
 * @param clock    () => ms, so a test can move time
 */
function createWeekly({ db, sheets, after = () => {}, clock = () => Date.now() }) {
  const sql = db.sqlP;
  const top = (table) => Number((sql(`SELECT COALESCE(max(id), 0) AS id FROM ${table}`, [])[0] || {}).id || 0);
  const mark = () => ({ audit: top("audit"), events: top("status_events") });
  // What this call wrote on the task: History rows by the window's own actor
  // (an agent writing to the same task in the same moment is someone else's
  // change, never ours to undo), and status events with no actor, which is how
  // the window's updateTask writes them.
  const since = (from, taskId, actorOf) => ({
    audit: sql(`SELECT id FROM audit WHERE id > :p1 AND entity = 'task' AND entity_id = :p2
                  AND COALESCE(actor, '') = :p3 ORDER BY id`, [from.audit, Number(taskId), actorOf]).map((r) => Number(r.id)),
    events: sql("SELECT id FROM status_events WHERE id > :p1 AND task_id = :p2 AND actor IS NULL ORDER BY id",
      [from.events, Number(taskId)]).map((r) => Number(r.id)),
  });
  // The actor the window's writes carry, read off the newest row on the task
  // straight after this call's own write returned: nothing else in this
  // process runs between the two, so it is ours.
  const ourActor = (from, taskId) => {
    const row = sql(`SELECT COALESCE(actor, '') AS actor FROM audit WHERE id > :p1 AND entity = 'task' AND entity_id = :p2
                     ORDER BY id DESC LIMIT 1`, [from.audit, Number(taskId)])[0];
    return row ? row.actor : "";
  };
  const taskOf = (id) => {
    const t = sql("SELECT id, title, status FROM tasks WHERE id = :p1", [Number(id)])[0];
    if (!t) throw new Error(`There is no task #${id} any more.`);
    return t;
  };

  // What each Park and Drop wrote, kept here and handed to the window as a
  // receipt number, so Undo can only ever take back what this process wrote.
  const receipts = new Map();
  let nextReceipt = 1;
  const receipt = (taskId, was, kind, wrote) => {
    const id = nextReceipt++;
    receipts.set(id, { taskId, ...wrote });
    for (const k of [...receipts.keys()].slice(0, Math.max(0, receipts.size - 200))) receipts.delete(k);
    return { receipt: id, task_id: taskId, was, kind, audit: wrote.audit };
  };

  function view({ projectId = null, days = 7 } = {}) {
    return weekly.review(sql, { now: clock(), projectId, days });
  }

  /** The Today card's one question, without running the whole review. */
  function status() {
    const row = sql(`SELECT created_at FROM notes WHERE kind = 'decision' AND title LIKE :p1
                     ORDER BY datetime(created_at) DESC, id DESC LIMIT 1`, [`${weekly.OBJECTIVES_TITLE}%`])[0];
    const stamp = row ? brief.stamp(row.created_at) : null;
    const at = stamp ? Date.parse(`${stamp.replace(" ", "T")}Z`) : NaN;
    return { savedAt: stamp, savedThisWeek: Number.isFinite(at) && clock() - at < 6 * 86400000 };
  }

  /** Park: back to To do, off the stale list, and History can undo it. */
  function park(taskId) {
    const t = taskOf(taskId);
    if (t.status === "todo") throw new Error(`#${t.id} is already in To do.`);
    const from = mark();
    db.updateTask(t.id, { status: "todo" });
    const wrote = since(from, t.id, ourActor(from, t.id));
    after();
    return receipt(t.id, t.status, "park", wrote);
  }

  /**
   * Drop: done with a note saying why, so the Sheet records that it was let
   * go rather than finished. The note first, then the status, so an undo of
   * the status alone (from History) still leaves the reason on the Sheet. If
   * the status cannot be set, the note is taken back: a reason for a Drop
   * that did not happen would be a false record.
   */
  function drop(taskId, why = "") {
    const t = taskOf(taskId);
    if (t.status === "done") throw new Error(`#${t.id} is already done.`);
    const reason = String(why || "").replace(/\s+/g, " ").trim().slice(0, 500);
    const from = mark();
    sheets.append({ taskId: t.id, kind: "note", body: reason ? `${DROP_PREFIX}: ${reason}` : `${DROP_PREFIX}, not finished.` });
    try {
      db.updateTask(t.id, { status: "done" });
    } catch (error) {
      for (const r of sql("SELECT id FROM audit WHERE id > :p1 AND entity = 'task' AND entity_id = :p2 AND undone = 0 ORDER BY id DESC", [from.audit, t.id])) {
        try { db.undo(r.id); } catch {}
      }
      after();
      throw error;
    }
    const wrote = since(from, t.id, ourActor(from, t.id));
    after();
    return receipt(t.id, t.status, "drop", wrote);
  }

  /** Undoes what a Park or Drop wrote, by its receipt, newest first. */
  function undo({ receipt: id } = {}) {
    const r = receipts.get(Number(id));
    if (!r) throw new Error("That change was made before Delphi last started, so undo it from History.");
    const list = r.audit.slice().sort((a, b) => b - a);
    const undone = [];
    for (const auditId of list) {
      const row = sql("SELECT undone FROM audit WHERE id = :p1", [auditId])[0];
      if (row && Number(row.undone) === 1) continue;
      try { db.undo(auditId); undone.push(auditId); } catch (error) {
        after();
        const left = list.length - undone.length;
        throw new Error(undone.length ? `${error.message} (${undone.length} undone, ${left} left)` : error.message);
      }
    }
    for (const e of r.events) sql("DELETE FROM status_events WHERE id = :p1 AND task_id = :p2", [e, r.taskId]);
    receipts.delete(Number(id));
    after();
    return { undone };
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
    const note = db.createNote({
      projectId: pid, kind: "decision", title: `${weekly.OBJECTIVES_TITLE}${week}`,
      body: weekly.objectivesBody(list, { week, on: weekly.localDate(now) }),
    });
    after();
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

module.exports = { createWeekly, register, DROP_PREFIX };
