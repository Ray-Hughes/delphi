// What the window says after Delphi stopped without quitting.
//
// There is no new marker. The app already writes a heartbeat file while it runs
// (agent/identity.js writeAlive, every 30 seconds) and removes it on the way out
// (clearAlive in will-quit). So a heartbeat still there at launch, written on
// this machine by a process that is no longer alive, is the record of an exit
// that never ran will-quit: a crash, a force quit, a power cut. It has to be
// read before this launch writes its own over it.
//
// The window then shows one calm banner and the jobs that were running, which
// are exactly the ones dispatcher.recover() failed as interrupted at this
// launch. Each can be resumed, which is a reply to that job asking it to carry
// on (the continuation recover()'s own note asks for), never a new job: a new
// one would do the work twice. Or dismissed, which leaves it failed.

/**
 * Whether the last exit was clean, from the heartbeat file as found.
 *
 * Another machine's heartbeat says nothing about this one (a database on a
 * shared drive). A live pid means the writer is still running, and that is a
 * second app on this database, not a crash. Only a dead pid on this host is an
 * unclean exit. After a reboot the old pid can belong to something else and
 * read as alive; that costs the banner, never a wrong one.
 */
function lastExit(beat, { host, isAlive }) {
  if (!beat || typeof beat !== "object") return { unclean: false };
  if (beat.host && beat.host !== host) return { unclean: false };
  if (beat.pid && isAlive(Number(beat.pid))) return { unclean: false };
  return { unclean: true, lastSeen: beat.last_seen || null, version: beat.version || null };
}

/**
 * @param sql      the app's sql(query, params), :p1 style
 * @param isAlive  pid => boolean
 */
function createRecovery({ sql, isAlive }) {
  let state = { unclean: false, lastSeen: null, runs: [], dismissed: false };

  /** At launch, before the heartbeat is rewritten and after recover(). */
  function start(beat, interruptedIds, { host }) {
    const exit = lastExit(beat, { host, isAlive });
    state = { unclean: exit.unclean, lastSeen: exit.lastSeen || null, runs: exit.unclean ? [...interruptedIds].map(Number) : [], dismissed: false };
    return view();
  }

  /**
   * What the window draws, read fresh each time: a job's title, and whether
   * its agent process is still alive, which can change while the banner is up.
   */
  function view() {
    if (!state.unclean || state.dismissed) return null;
    const runs = [];
    for (const id of state.runs) {
      const row = sql(
        `SELECT h.id, h.state, h.task_id, h.to_harness, h.agent_pid, h.request, t.title AS task_title
           FROM handoffs h LEFT JOIN tasks t ON t.id = h.task_id WHERE h.id = :p1`, [id])[0];
      if (!row) continue;
      const agentAlive = Boolean(row.agent_pid && isAlive(Number(row.agent_pid)));
      runs.push({
        id: Number(row.id), state: row.state, taskId: row.task_id == null ? null : Number(row.task_id),
        harness: row.to_harness, title: row.task_title || String(row.request || "").split("\n")[0].slice(0, 120),
        agentAlive,
      });
    }
    return { lastSeen: state.lastSeen, runs };
  }

  /** One run handled (resumed or dismissed): it leaves the list. */
  function done(id) {
    state.runs = state.runs.filter((r) => r !== Number(id));
  }

  function dismiss() { state.dismissed = true; }

  return { start, view, done, dismiss };
}

/**
 * The window's half. Resume refuses while the old agent process is alive,
 * because a reply then starts a second agent in the same Workbench as one
 * nobody is watching.
 */
function register(handle, { recovery, dispatcher }) {
  handle("recovery:state", () => recovery.view());
  handle("recovery:resume", (id) => {
    const view = recovery.view();
    const run = view && view.runs.find((r) => r.id === Number(id));
    if (!run) throw new Error("That run is not waiting to be resumed.");
    if (run.agentAlive) throw new Error("Its agent may still be running. Resume once it has exited.");
    const after = dispatcher.reply(run.id, "Carry on from where you stopped. Delphi closed unexpectedly while you were working.", { by: "you" });
    recovery.done(run.id);
    return after;
  });
  handle("recovery:dismissRun", (id) => { recovery.done(id); return recovery.view(); });
  handle("recovery:dismiss", () => { recovery.dismiss(); return null; });
}

module.exports = { lastExit, createRecovery, register };
