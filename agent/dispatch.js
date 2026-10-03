/**
 * The dispatcher: runs jobs (agent/jobs.js) through one pool of workers.
 *
 * A job is a handoff an agent sent, a task a person queued for an agent, or a
 * person's own "have Codex do this". All three used to be different things,
 * and the one that ran inside the app ran serially: one thirty-minute Claude
 * turn held every other handoff in every project, in the project's own
 * checkout, with no tools. This replaces that.
 *
 * - Each job is its own promise in `live`, never awaited by the loop, so one
 *   long job never blocks another. Limits: a global number of jobs at once and
 *   a number per harness (subscriptions throttle), from settings. One job per
 *   task at a time, because a task has one Workbench.
 * - A job that changes code (kind do) runs in its task's Workbench and nowhere
 *   else; a job that only answers (kind ask) runs read only in the project's
 *   folder. No folder, no repository: refused with the sentence that says what
 *   to set.
 * - Real permissions, from the harness row's own template: {if:jobWrite} and
 *   friends (see harness.js). Claude Code changes code only with agent/guard.py
 *   installed as its hook, Codex only in its workspace-write sandbox, Copilot
 *   only where a project allows unguarded agents. Any bypass flag in the final
 *   argv refuses the job, whatever Settings says.
 * - A person in the loop: an agent's job waits in needs_approval until a person
 *   approves it, unless the project opts in to auto-approve. A question the
 *   agent asks on the Sheet (sheet_ask) leaves the job waiting_on_human, and
 *   the answer resumes it.
 * - The log is the task's Sheet, written exactly as `delphi chat` writes it
 *   (sheet/chat.js): `@` replies, `$` runs finished with their output, `!`
 *   edits, attributed to the job's own actor.
 *
 * No Electron here, and no database: it is handed sql() in the :p1 style, the
 * Workbench verbs and settings, so tools/dispatch_test.js runs it under a plain
 * Node with fake agents. Only the app runs it; the MCP server only writes and
 * reads job rows (agent/jobs.js).
 */

const os = require("os");
const harness = require("../harness");
const chat = require("../sheet/chat");
const fmt = require("../sheet/format");
const { makeSheetStore, pidAlive } = require("../sheet/store");
const launch = require("./launch");
const jobs = require("./jobs");

const ADAPTER_BY_PARSER = {
  "claude-stream-json": chat.ADAPTERS.claude,
  "copilot-json": chat.ADAPTERS.copilot,
  "codex-json": { name: "codex", harnessKey: "codex", label: "Codex", mapper: chat.codexSheetMapper },
};

// Flags that switch off a harness's own permission checks or sandbox. A job
// refuses to start with any of them, so an edited template cannot slip one in.
// --allow-all-tools is Copilot's only way to use tools unattended, and is
// allowed only where the project has said unguarded agents may run.
const DANGER = [/bypassPermissions/i, /^--dangerously/i, /danger-full-access/i, /^--yolo$/i, /^--allow-all-paths$/i, /^--allow-all$/i];

function dangerous(argv, unguarded) {
  for (const arg of argv) {
    if (DANGER.some((r) => r.test(arg))) return arg;
    if (arg === "--allow-all-tools" && !unguarded) return arg;
  }
  return null;
}

const DEFAULTS = { jobConcurrency: 3, jobHarnessLimit: 1, jobTimeoutMinutes: 60 };
const HOURLY_LIMIT = 12;
const SHEET_TAIL = 20;
const MAX_BRIEF_SHEET = 16000;

const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const firstLine = (text, n = 200) => {
  const line = String(text || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  return line.length > n ? `${line.slice(0, n - 3)}...` : line;
};
const int = (v, fallback, min, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/** The Sheet writer's MCP client, answered in process by a store made for the agent. */
function storeClient(store) {
  return {
    async call(tool, a = {}) {
      if (tool === "sheet_append") {
        return store.append({ taskId: a.task_id, kind: a.kind, body: a.body, meta: a.meta ?? null, refId: a.ref_id ?? null, promote: a.promote === true });
      }
      if (tool === "sheet_update") return store.update(a.id, { meta: a.meta, body: a.body });
      throw new Error(`${tool} is not something a job's writer does.`);
    },
  };
}

function createDispatcher({
  sql,
  // workbench/workbench.js createWorkbench(...), for jobs that change code.
  benches = null,
  logDir = null,
  dbPath = null,
  dbId = null,              // a value, or a function returning one
  settings = () => ({}),
  // ({ id, state, project_id }) whenever a job changes, for the Runs panel.
  onChange = () => {},
  // (run) when a job ends a turn, for the wake (main.js).
  onFinished = () => {},
  host = os.hostname(),
  pid = process.pid,
  isAlive = pidAlive,
  runTurn = chat.chatTurn,
  guardStatus = launch.guardStatus,
  hourlyLimit = HOURLY_LIMIT,
  log = (...parts) => console.error(...parts),
} = {}) {
  if (typeof sql !== "function") throw new Error("createDispatcher needs a sql(query, params) function");
  const tool = makeSheetStore({ sql, actor: "delphi", authorType: "tool" });
  const live = new Map();
  let closed = false;
  let ticking = false;

  const limits = () => {
    const s = (typeof settings === "function" ? settings() : settings) || {};
    const perHarness = s.jobHarnessLimits && typeof s.jobHarnessLimits === "object" ? s.jobHarnessLimits : {};
    return {
      global: int(s.jobConcurrency, DEFAULTS.jobConcurrency, 1, 16),
      harness: (key) => int(perHarness[key], DEFAULTS.jobHarnessLimit, 0, 16),
      timeoutMs: int(s.jobTimeoutMinutes, DEFAULTS.jobTimeoutMinutes, 1, 24 * 60) * 60 * 1000,
    };
  };

  const changed = (run) => {
    if (!run) return;
    try { onChange({ id: run.id, state: run.state, project_id: run.project_id }); } catch {}
  };

  function audit(id, summary, label, by = "delphi") {
    try {
      sql(`INSERT INTO audit (action, entity, entity_id, summary, label) VALUES ('update', 'handoff', :p1, :p2, :p3)`,
          [Number(id), `${summary} (by ${by})`, label ? String(label).slice(0, 80) : null]);
    } catch (error) { log("job audit", error.message); }
  }

  // A note never fails the job: the row is the record, the note is the account.
  function note(taskId, body) {
    if (!taskId) return null;
    try { return tool.append({ taskId, kind: "note", body }); } catch (error) { log("job note", error.message); return null; }
  }

  // ---------------------------------------------------------------------------
  // Creating and moving jobs

  function projectRow(id) {
    return sql("SELECT * FROM projects WHERE id = :p1", [Number(id)])[0] || null;
  }

  /**
   * A job a person asked for, from the window. Refused at once, with the
   * reason, when it could never run: nothing to run it with, or nowhere.
   */
  function create({ projectId, harness: key, request, taskId = null, kind = "ask", context = null, wake = false, fromSessionId = null } = {}, { by = "you", type = "human" } = {}) {
    if (!projectId) throw new Error("A job needs a project.");
    const project = projectRow(projectId);
    if (!project) throw new Error(`There is no project ${projectId}.`);
    const row = sql("SELECT key, label, enabled FROM harnesses WHERE key = :p1", [String(key || "")])[0];
    if (!row || !Number(row.enabled)) throw new Error(`There is no agent called "${key}" turned on here. Turn it on in Settings, under Agents.`);
    const problem = jobs.folderProblem(sql, project.id);
    if (problem) throw new Error(problem);
    if (taskId != null) {
      const task = sql("SELECT id, project_id FROM tasks WHERE id = :p1", [Number(taskId)])[0];
      if (!task) throw new Error(`There is no task ${taskId}.`);
    }
    const { state, approval } = jobs.approvalFor({ requesterType: type, autoApprove: Number(project.auto_approve) === 1 });
    const run = jobs.insert(sql, {
      projectId: project.id, toHarness: row.key, request, taskId, context, wake, kind, source: "person",
      requestedBy: by, requesterType: type, fromSessionId, state, approval,
    });
    audit(run.id, `asked ${row.key} (${kind})`, run.request, by);
    changed(run);
    soon();
    return run;
  }

  function approve(id, { by = "you" } = {}) {
    const run = jobs.update(sql, id, { state: "queued", approval: "approved", approved_by: by, approved_at: stamp() }, { from: "needs_approval" });
    if (!run) throw notIn(id, "waiting for approval");
    audit(run.id, "approved", run.request, by);
    note(run.task_id, `Job ${run.id} approved by ${by}: ${run.harness_label} may start.`);
    changed(run);
    soon();
    return run;
  }

  function reject(id, { by = "you", why = null } = {}) {
    const reason = why && String(why).trim() ? `: ${String(why).trim()}` : ".";
    const run = jobs.update(sql, id, { state: "stopped", approval: "rejected", approved_by: by, approved_at: stamp(), reply: `Rejected by ${by}${reason}` }, { from: "needs_approval" });
    if (!run) throw notIn(id, "waiting for approval");
    audit(run.id, "rejected", run.request, by);
    note(run.task_id, `Job ${run.id} rejected by ${by}${reason}`);
    changed(run);
    return run;
  }

  function notIn(id, what) {
    const run = jobs.get(sql, id);
    if (!run) return new Error(`There is no job ${id}.`);
    return new Error(`Job ${id} is not ${what}; it is ${run.state.replace(/_/g, " ")}.`);
  }

  /**
   * Stops a job. A running one has its agent's whole process group ended
   * (SIGTERM, then SIGKILL), its open commands finished on the Sheet, and its
   * Workbench left exactly as it is for a person to review.
   */
  function stop(id, { by = "you" } = {}) {
    const entry = live.get(Number(id));
    if (entry) {
      entry.stopReason = "person";
      entry.stoppedBy = by;
      if (entry.stop) entry.stop("stopped");
      audit(entry.id, "stop asked", null, by);
      return jobs.get(sql, id);
    }
    const run = jobs.get(sql, id);
    if (!run) throw new Error(`There is no job ${id}.`);
    if (["queued", "needs_approval", "waiting_on_human"].includes(run.state)) {
      const after = jobs.update(sql, id, { state: "stopped", followup: null, reply: run.reply || `Stopped by ${by} before it ran.` }, { from: run.state });
      if (!after) return stop(id, { by });
      audit(id, `stopped while ${run.state.replace(/_/g, " ")}`, run.request, by);
      note(run.task_id, `Job ${id} stopped by ${by}.${after.workbench ? ` Its Workbench at ${after.workbench.path} is left as it is.` : ""}`);
      changed(after);
      return after;
    }
    if (run.state === "running") {
      throw new Error(`Job ${id} is being run by another Delphi (pid ${run.runner_pid || "?"} on ${run.runner_host || "another machine"}); stop it there.`);
    }
    throw new Error(`Job ${id} has already finished (${run.state}).`);
  }

  /**
   * A person's follow-up. Written on the Sheet as theirs, and sent to the
   * agent as its next turn, resuming the harness's own session when there is
   * one. Allowed whenever the job is not running or waiting to.
   */
  function reply(id, message, { by = "you" } = {}) {
    const text = String(message == null ? "" : message).trim();
    if (!text) throw new Error("A reply needs something in it.");
    const run = jobs.get(sql, id);
    if (!run) throw new Error(`There is no job ${id}.`);
    if (run.state === "needs_approval") throw new Error(`Job ${id} has not been approved yet. Approve it first, then reply.`);
    if (run.state === "running" || run.state === "queued") throw new Error(`Job ${id} is ${run.state}; reply once its turn has finished.`);
    if (run.approval === "rejected") throw new Error(`Job ${id} was rejected. Ask again to start a new one.`);
    if (run.task_id) {
      makeSheetStore({ sql, actor: by, authorType: "human" }).append({ taskId: run.task_id, kind: "say", body: text });
    }
    const after = jobs.update(sql, id, { state: "queued", followup: text }, { from: run.state });
    if (!after) throw notIn(id, "finished its turn");
    audit(id, "replied to", run.request, by);
    changed(after);
    soon();
    return after;
  }

  const get = (id) => jobs.get(sql, id);
  const list = (opts = {}) => jobs.list(sql, opts);

  // ---------------------------------------------------------------------------
  // Recovery and shutdown

  /**
   * Jobs this machine's Delphi was running when it died are failed as
   * interrupted, with a note, and never run again on their own: rerunning an
   * agent somebody stopped looking at is how work gets done twice.
   */
  function recover() {
    const out = [];
    for (const row of sql("SELECT id FROM handoffs WHERE state = 'running' ORDER BY id")) {
      if (live.has(Number(row.id))) continue;
      const run = jobs.get(sql, row.id);
      const raw = sql("SELECT runner_pid, runner_host, agent_pid FROM handoffs WHERE id = :p1", [run.id])[0] || {};
      if (raw.runner_host && raw.runner_host !== host) continue;
      if (raw.runner_pid && Number(raw.runner_pid) !== pid && isAlive(Number(raw.runner_pid))) continue;
      const still = raw.agent_pid && isAlive(Number(raw.agent_pid))
        ? ` Its agent process (pid ${raw.agent_pid}) may still be running; it is no longer watched.` : "";
      const reason = `interrupted: Delphi stopped while this job was running, so it never finished. It is not run again on its own; reply to it to carry on.` +
        `${run.workbench ? ` Its Workbench at ${run.workbench.path} is left as it was.` : ""}${still}`;
      const after = jobs.update(sql, run.id, { state: "failed", reply: reason }, { from: "running" });
      if (!after) continue;
      audit(run.id, "interrupted", run.request);
      note(run.task_id, `Job ${run.id} ${reason}`);
      out.push(run.id);
      changed(after);
    }
    return out;
  }

  /**
   * Stops everything on the way out. The rows are written first, at once,
   * because the process may be gone before the agents have finished dying.
   */
  function shutdown(reason = "Delphi quit") {
    closed = true;
    for (const entry of live.values()) {
      entry.stopReason = "shutdown";
      const msg = `interrupted: ${reason} while this job was running. It is not run again on its own; reply to it to carry on.`;
      try {
        const after = jobs.update(sql, entry.id, { state: "failed", reply: msg }, { from: "running" });
        if (after) note(after.task_id, `Job ${entry.id} ${msg}`);
      } catch {}
      if (entry.stop) { try { entry.stop("quit"); } catch {} }
    }
  }

  // ---------------------------------------------------------------------------
  // The pass

  let soonTimer = null;
  function soon() {
    if (soonTimer || closed) return;
    soonTimer = setTimeout(() => { soonTimer = null; tick(); }, 20);
    if (soonTimer.unref) soonTimer.unref();
  }

  /** Rows an older server wrote, given the state they would have had. */
  function adopt() {
    for (const row of sql("SELECT h.id, p.auto_approve FROM handoffs h JOIN projects p ON p.id = h.project_id WHERE h.state IS NULL AND h.status = 'queued'")) {
      const { state, approval } = jobs.approvalFor({ requesterType: "agent", autoApprove: Number(row.auto_approve) === 1 });
      sql(`UPDATE handoffs SET state = :p1, status = :p2, approval = :p3, requester_type = COALESCE(requester_type, 'agent'), updated_at = datetime('now')
            WHERE id = :p4 AND state IS NULL`, [state, jobs.LEGACY[state], approval, Number(row.id)]);
      changed(jobs.get(sql, row.id));
    }
  }

  /**
   * Tasks in a queue named after a harness become jobs for it. Taken out of
   * the queue in the same statement, so neither a second pass nor an agent
   * calling queue_next can take it as well.
   */
  function fileQueued() {
    const rows = sql(
      `SELECT t.id, t.project_id, t.title, t.queue, t.queued_by, t.queued_by_type, p.auto_approve
         FROM tasks t JOIN harnesses h ON h.key = t.queue AND h.enabled = 1
         JOIN projects p ON p.id = t.project_id
        WHERE t.status NOT IN ('done', 'blocked')
          AND (t.claimed_by IS NULL OR t.claim_expires < datetime('now'))
          AND NOT EXISTS (SELECT 1 FROM handoffs j WHERE j.task_id = t.id AND j.state IN (${jobs.OPEN_SQL}))
        ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, t.id`, []);
    for (const t of rows) {
      const took = sql("UPDATE tasks SET queue = NULL, updated_at = datetime('now') WHERE id = :p1 AND queue = :p2 RETURNING id", [t.id, t.queue])[0];
      if (!took) continue;
      const type = t.queued_by_type || "agent";
      const { state, approval } = jobs.approvalFor({ requesterType: type, autoApprove: Number(t.auto_approve) === 1 });
      const run = jobs.insert(sql, {
        projectId: t.project_id, toHarness: t.queue, request: `Work task ${t.id}: ${t.title}`, taskId: t.id, kind: "do",
        source: "queue", requestedBy: t.queued_by || null, requesterType: type, state, approval, wake: false,
        context: { queue: t.queue },
      });
      sql(`INSERT INTO audit (action, entity, entity_id, summary, label) VALUES ('update', 'task', :p1, :p2, :p3)`,
          [t.id, `taken from the ${t.queue} queue as job ${run.id} (by delphi)`, t.title]);
      if (state === "needs_approval") note(t.id, `Job ${run.id}: queued for ${run.harness_label} by ${t.queued_by || "an unknown writer"}, waiting for a person to approve it.`);
      changed(run);
    }
  }

  /** A question the agent asked is answered: the job goes back to its agent. */
  function resumeAnswered() {
    for (const row of sql("SELECT id, task_id, actor, updated_at FROM handoffs WHERE state = 'waiting_on_human' AND task_id IS NOT NULL AND actor IS NOT NULL")) {
      const open = sql(`SELECT COUNT(*) AS n FROM comments c WHERE c.task_id = :p1 AND c.kind = 'ask' AND c.author = :p2
                         AND NOT EXISTS (SELECT 1 FROM comments d WHERE d.kind = 'decide' AND d.ref_id = c.id)`, [row.task_id, row.actor])[0].n;
      if (Number(open)) continue;
      const answers = sql(`SELECT a.body AS question, d.meta AS meta, d.body AS body FROM comments d JOIN comments a ON a.id = d.ref_id
                            WHERE d.kind = 'decide' AND a.task_id = :p1 AND a.author = :p2 AND d.created_at >= :p3 ORDER BY d.id`,
                          [row.task_id, row.actor, row.updated_at || "0"]);
      if (!answers.length) continue;
      const lines = answers.map((a) => {
        let m = {};
        try { m = JSON.parse(a.meta) || {}; } catch {}
        const why = String(a.body || "").split("\n").slice(1).join(" ").trim();
        return `- "${a.question}": ${m.choice || "?"}) ${m.label || ""}${why ? `. ${why}` : ""}`;
      });
      const after = jobs.update(sql, row.id, { state: "queued", followup: `A person answered on the Sheet:\n${lines.join("\n")}\n\nCarry on from there.` }, { from: "waiting_on_human" });
      if (after) changed(after);
    }
  }

  const harnessCount = (key) => [...live.values()].filter((e) => e.harness === key).length;
  const taskBusy = (taskId) => taskId != null && (
    [...live.values()].some((e) => e.taskId === Number(taskId)) ||
    Number(sql("SELECT COUNT(*) AS n FROM handoffs WHERE task_id = :p1 AND state = 'running'", [Number(taskId)])[0].n) > 0);

  /**
   * One pass: adopt, file the queues, resume answered jobs, then start what
   * the limits allow. Synchronous and quick; every job it starts runs on its own.
   */
  function tick() {
    if (closed || ticking) return;
    ticking = true;
    try {
      adopt();
      fileQueued();
      resumeAnswered();
      const lim = limits();
      for (const row of sql("SELECT id, project_id, to_harness, task_id, requester_type FROM handoffs WHERE state = 'queued' ORDER BY id")) {
        if (live.size >= lim.global) break;
        if (harnessCount(row.to_harness) >= lim.harness(row.to_harness)) continue;
        if (taskBusy(row.task_id)) continue;
        if (jobs.finishedSince(sql, row.project_id) >= hourlyLimit) {
          // A person's own request waits for the hour to pass; an agent's,
          // which is how a loop between two agents shows up, is stopped.
          if (row.requester_type === "human") {
            const why = `Waiting: ${hourlyLimit} jobs finished in this project in the last hour, so this starts when that drops.`;
            const was = sql("SELECT last_activity FROM handoffs WHERE id = :p1", [row.id])[0];
            if (!was || was.last_activity !== why) changed(jobs.update(sql, row.id, { last_activity: why }));
            continue;
          }
          const after = jobs.update(sql, row.id, {
            state: "failed",
            reply: `Delphi stopped this one. ${hourlyLimit} jobs have already finished in this project in the last hour, which usually means agents are handing work back and forth. Nothing is lost: reply to it to run it again.`,
          }, { from: "queued" });
          changed(after);
          continue;
        }
        begin(row.id);
      }
    } catch (error) {
      log("dispatch pass", error);
    } finally {
      ticking = false;
    }
  }

  function begin(id) {
    const claimed = jobs.update(sql, id, { state: "running", runner_pid: pid, runner_host: host, agent_pid: null }, { from: "queued" });
    if (!claimed) return;
    const entry = { id: claimed.id, harness: claimed.harness, taskId: claimed.task_id, stop: null, stopReason: null, stoppedBy: null, timer: null, lastPing: 0 };
    live.set(claimed.id, entry);
    changed(claimed);
    entry.promise = run(claimed, entry)
      .catch((error) => end(entry, { state: "failed", reply: `Delphi could not run this job: ${error.message}` }))
      .finally(() => {
        clearTimeout(entry.timer);
        live.delete(entry.id);
        soon();
      });
  }

  /** Ends a turn. Conditional on the job still running, so a quit that already wrote it is not written twice. */
  function end(entry, { state, reply: text, fields = {}, noteText = null }) {
    const after = jobs.update(sql, entry.id, { ...fields, state, reply: text }, { from: "running" });
    if (!after) return null;
    audit(after.id, state.replace(/_/g, " "), after.request);
    note(after.task_id, noteText || `Job ${after.id} ${state === "failed" ? "failed" : state.replace(/_/g, " ")}: ${text}`);
    changed(after);
    try { onFinished(after); } catch (error) { log("job finished hook", error); }
    return after;
  }

  function activity(entry, action) {
    try {
      if (action.type === "usage") {
        sql(`UPDATE handoffs SET tokens_in = COALESCE(tokens_in, 0) + :p1, tokens_out = COALESCE(tokens_out, 0) + :p2,
               cost_usd = CASE WHEN :p3 IS NULL THEN cost_usd ELSE COALESCE(cost_usd, 0) + :p3 END WHERE id = :p4`,
            [Number(action.input) || 0, Number(action.output) || 0, typeof action.cost === "number" ? action.cost : null, entry.id]);
      } else if (action.type === "say" || action.type === "run" || action.type === "edited") {
        const text = action.type === "say" ? firstLine(action.text) : action.type === "run" ? `$ ${firstLine(action.command)}` : `edited ${action.path}`;
        sql("UPDATE handoffs SET last_activity = :p1, updated_at = datetime('now') WHERE id = :p2", [text, entry.id]);
      } else return;
      // At most once a second per job: a stream of tool calls is not a stream of repaints.
      const now = Date.now();
      if (now - entry.lastPing > 1000) { entry.lastPing = now; changed(jobs.get(sql, entry.id)); }
    } catch (error) { log("job activity", error.message); }
  }

  function ensureTask(job, project) {
    if (job.task_id) return job.task_id;
    const title = firstLine(job.request, 120) || `Job ${job.id}`;
    const row = sql(`INSERT INTO tasks (project_id, title, detail, priority, source) VALUES (:p1, :p2, :p3, 'med', :p4) RETURNING id`,
                    [project.id, title, String(job.request), job.requested_by || "delphi"])[0];
    sql("INSERT INTO status_events (task_id, status, actor) VALUES (:p1, 'todo', :p2)", [row.id, job.requested_by || "delphi"]);
    sql(`INSERT INTO audit (action, entity, entity_id, summary, label) VALUES ('create', 'task', :p1, :p2, :p3)`,
        [row.id, `created for job ${job.id}, which had no task (by delphi)`, title]);
    return Number(row.id);
  }

  function startTask(taskId, actor) {
    const t = sql("UPDATE tasks SET status = 'doing', updated_at = datetime('now') WHERE id = :p1 AND status = 'todo' RETURNING id, title", [taskId])[0];
    if (t) sql("INSERT INTO status_events (task_id, status, actor) VALUES (:p1, 'doing', :p2)", [taskId, actor]);
  }

  function sheetText(taskId) {
    const store = tool;
    const ledger = store.read(taskId, { mode: "ledger" }).entries || [];
    const tail = store.read(taskId, { mode: "tail", n: SHEET_TAIL }).entries || [];
    const byId = new Map();
    for (const e of [...ledger, ...tail]) byId.set(e.id, e);
    const text = fmt.format({ entries: [...byId.values()].sort((a, b) => a.id - b.id) }, { clean: true }).trim();
    return text.length > MAX_BRIEF_SHEET ? `[older entries cut]\n${text.slice(-MAX_BRIEF_SHEET)}` : text;
  }

  function brief({ job, task, project, label, actor, workbench, cwd, followup }) {
    const lines = [
      `You are ${label}, running job ${job.id} for Delphi on task ${task.id}: ${task.title} (project ${project.name}).`,
      `${job.requested_by ? `${job.requested_by} asked for it` : "It was asked for"}${job.approved_by ? `, and ${job.approved_by} approved it` : ""}.`,
      "",
      "## What is asked",
      String(job.request).trim(),
    ];
    if (job.context && job.source !== "queue") lines.push("", "Context:", typeof job.context === "string" ? job.context : JSON.stringify(job.context, null, 2));
    if (task.detail && String(task.detail).trim() && String(task.detail).trim() !== String(job.request).trim()) {
      lines.push("", "## The task", String(task.detail).trim());
    }
    const sheet = sheetText(task.id);
    lines.push("", "## The task's Sheet",
      "Its ledger and latest entries, oldest first. A line starting > is a person, @ an agent, $ a command, ! a note, ? a question and = its answer.",
      "", sheet || "(Nothing on the Sheet yet.)");
    lines.push("", "## Where you are working");
    if (workbench) {
      lines.push(
        `This folder (${cwd}) is the task's Workbench: its own copy of the repository on the branch ${workbench.branch}, so nothing you do here touches anyone else's work.`,
        "Change files only here. Do not switch branches, push, or remove the folder. Commit on this branch if you can, or leave the changes uncommitted: a person reviews the Workbench and finishes it either way.");
    } else {
      lines.push(`You are in the project's folder (${cwd}) to read and answer. Do not change files; this job only reads.`);
    }
    lines.push("", "## How to finish",
      `What you say, the commands you run and the files you edit are written onto the task's Sheet as you go, as ${actor}. Do not copy your reply into it with sheet_append.`,
      "If you need a decision from a person, ask it with sheet_ask and end your turn: the job waits for them, and you are resumed with the answer.",
      "Your final message is the record: what you found or changed, how you checked it, and anything the next person needs. Use sheet_promote on anything they should read first.");
    if (followup) lines.push("", "## Since then", followup);
    return lines.join("\n");
  }

  async function run(job, entry) {
    const fail = (reason) => end(entry, { state: "failed", reply: reason });
    const followup = job.followup || null;
    if (followup) jobs.update(sql, job.id, { followup: null });

    const row = sql("SELECT * FROM harnesses WHERE key = :p1", [job.harness])[0];
    if (!row || !Number(row.enabled)) {
      return fail(`There is no agent called "${job.harness}" turned on here. Turn it on in Delphi's Settings, under Agents, then reply to this job.`);
    }
    const base = ADAPTER_BY_PARSER[row.parser];
    if (!base) return fail(`${row.label} speaks a format Delphi cannot follow as a job (${row.parser}). Jobs run Claude Code, Codex or Copilot.`);
    const adapter = { ...base, harnessKey: row.key, label: row.label || base.label };
    const label = adapter.label;
    const project = projectRow(job.project_id);
    if (!project) return fail(`Its project (${job.project_id}) no longer exists.`);
    const problem = jobs.folderProblem(sql, project.id);
    if (problem) return fail(problem);

    const taskId = ensureTask(job, project);
    entry.taskId = taskId;
    const actor = job.actor || `${row.key}:job-${job.id}`;
    job = jobs.update(sql, job.id, { task_id: taskId, actor });
    startTask(taskId, actor);

    let cwd;
    let workbench = null;
    if (job.kind === "do") {
      if (!benches) return fail("This Delphi cannot start Workbenches, so it cannot run a job that changes code.");
      let made;
      try {
        made = await benches.start(taskId, { runSetup: true, background: false });
      } catch (error) {
        return fail(`A job that changes code runs only in its task's own Workbench, and task ${taskId}'s could not be started: ${error.message}`);
      }
      const wb = made.workbench;
      if (wb.state === "parked") return fail(`Task ${taskId}'s Workbench is parked: a person set it aside. Resume it, then reply to this job.`);
      if (wb.state === "closing") return fail(`Task ${taskId}'s Workbench is being put away (a Finish or Discard). A person decides what happens to it.`);
      if (wb.state === "missing") return fail(`Task ${taskId}'s Workbench folder (${wb.path}) is gone. Recreate it, then reply to this job.`);
      const setup = made.setup_entry;
      if (setup && setup.meta && setup.meta.state !== "ok") {
        return fail(`Setting up the Workbench failed (entry ${setup.id} on the Sheet). The folder is kept at ${wb.path}.`);
      }
      workbench = wb;
      cwd = wb.path;
    } else {
      cwd = jobs.readFolder(sql, project.id);
    }

    // Permissions, from the harness row's own template. See harness.js.
    let template;
    try { template = typeof row.args_json === "string" ? JSON.parse(row.args_json) : row.args_json; } catch { template = null; }
    if (!Array.isArray(template)) return fail(`${label}'s command line in Settings is not a list Delphi can read. Reset it in Settings, under Agents.`);
    const text = JSON.stringify(template);
    const values = { jobWrite: job.kind === "do", jobRead: job.kind === "ask", jobUnguarded: false };
    let unguarded = false;
    const allowUnguarded = Number(project.allow_unguarded) === 1;
    const setting = `turn on "Allow unguarded agents" in project ${project.name}'s settings`;
    if (job.kind === "do") {
      if (row.parser === "copilot-json") {
        if (!allowUnguarded) {
          return fail(`${label} would change code with nothing watching its commands: agent/guard.py is a Claude Code hook and cannot see ${label}'s. ` +
            `If you accept that, ${setting}, then reply to this job; or hand it to Claude Code or Codex.`);
        }
        if (!text.includes("{if:jobUnguarded}")) return fail(`${label}'s command line in Settings has no {if:jobUnguarded} group, so Delphi cannot give it tools. Reset it in Settings, under Agents.`);
        unguarded = true;
        values.jobUnguarded = true;
      } else {
        if (!text.includes("{if:jobWrite}")) {
          return fail(`${label}'s command line in Settings has no {if:jobWrite} group, so Delphi cannot give it tools that stay inside the Workbench. Reset it to the built-in definition in Settings, under Agents, then reply to this job.`);
        }
        if (row.parser === "claude-stream-json" && !guardStatus(cwd).installed) {
          if (!allowUnguarded) {
            return fail(`${label} would run commands in the Workbench, and agent/guard.py is not installed as its PreToolUse hook for Bash, so nothing would stop an irreversible one. ` +
              `Install the guard (the Safety section of AGENTS.md), or ${setting}, then reply to this job.`);
          }
          unguarded = true;
        }
      }
    }
    const bad = dangerous(harness.expand(template, { ...values, prompt: "x", cwd, autoAllow: false, mcpFlags: [] }), unguarded);
    if (bad) return fail(`Refusing to start ${label} with ${bad}: a job never switches off an agent's own permission checks. Check its command line in Settings, under Agents.`);

    job = jobs.update(sql, job.id, { cwd, workbench_id: workbench ? workbench.id : null, unguarded: unguarded ? 1 : 0, turns: (job.turns || 0) + 1 });
    if (entry.stopReason) return end(entry, { state: "stopped", reply: `Stopped by ${entry.stoppedBy || "you"} before it started.` });

    const task = sql("SELECT * FROM tasks WHERE id = :p1", [taskId])[0];
    if (!followup) {
      note(taskId, `Job ${job.id} started: ${label} ${job.kind === "do" ? `changing code in the Workbench at ${cwd} on ${workbench.branch}` : `reading in ${cwd}`}, as ${actor}.`);
    }
    if (unguarded) {
      note(taskId, `Job ${job.id} is running unguarded: agent/guard.py cannot see ${label}'s commands here, and project ${project.name} allows unguarded agents.`);
    }

    const client = storeClient(makeSheetStore({ sql, actor, authorType: "agent" }));
    const firstEntry = Number(sql("SELECT COALESCE(MAX(id), 0) AS n FROM comments", [])[0].n);
    const harnessRow = { label, command: row.command, args: template, parser: row.parser, mcp_style: row.mcp_style };
    const id = typeof dbId === "function" ? dbId() : dbId;
    let errorSeen = null;
    const turn = (resume, prompt) => runTurn({
      adapter, harness: harnessRow, prompt, cwd, resume, autoAllow: false, values, agentClient: client, taskId,
      projectId: project.id, actor, logDir, dbPath, dbId: id,
      env: { DELPHI_JOB: String(job.id), DELPHI_PROJECT: String(project.id), ...(dbPath ? { DELPHI_DB: dbPath } : {}), ...(id ? { DELPHI_DB_ID: id } : {}) },
      onStart: (control) => {
        entry.stop = control.stop;
        try { jobs.update(sql, job.id, { agent_pid: control.pid || null }); } catch {}
        if (entry.stopReason) control.stop(entry.stopReason === "shutdown" ? "quit" : "stopped");
      },
      onAction: (action) => {
        if (action.type === "error") errorSeen = action.message;
        activity(entry, action);
      },
      onError: (error) => log(`job ${job.id} sheet`, error.message),
    });

    const timeoutMs = limits().timeoutMs;
    entry.timer = setTimeout(() => {
      entry.stopReason = entry.stopReason || "timeout";
      if (entry.stop) entry.stop("timeout");
    }, timeoutMs);
    if (entry.timer.unref) entry.timer.unref();

    const resume = followup && job.native_session ? job.native_session : null;
    const opening = () => brief({ job, task, project, label, actor, workbench, cwd, followup });
    let result;
    try {
      result = await turn(resume, resume ? followup : opening());
      // A session the harness no longer has fails before saying anything:
      // start fresh rather than leave the job stuck behind it.
      if (resume && result.code !== 0 && !result.written.length && !result.interrupted && !entry.stopReason) {
        result = await turn(null, opening());
      }
    } catch (error) {
      return fail(error.message);
    }
    clearTimeout(entry.timer);

    const said = result.written.filter((e) => e.kind === "say");
    const last = said.length ? said[said.length - 1].body : null;
    const fields = { native_session: result.sessionId || job.native_session || null, agent_pid: null };
    const where = workbench ? ` Its Workbench at ${workbench.path} (${workbench.branch}) is left as it is, for you to review, then Finish or Discard.` : "";

    if (entry.stopReason === "person") {
      return end(entry, { state: "stopped", fields, reply: `Stopped by ${entry.stoppedBy || "you"}.${where}` });
    }
    if (entry.stopReason === "timeout") {
      const minutes = Math.round(timeoutMs / 60000);
      return end(entry, { state: "failed", fields, reply: `Stopped after ${minutes} minutes, the longest a job may run (jobTimeoutMinutes in settings).${where}` });
    }
    if (entry.stopReason === "shutdown") {
      return end(entry, { state: "failed", fields, reply: "interrupted: Delphi quit while this job was running." });
    }
    if (!said.length && (result.code !== 0 || errorSeen)) {
      const tail = String(result.stderr || "").trim().split("\n").slice(-4).join("\n");
      return end(entry, { state: "failed", fields, reply: errorSeen || tail || `${label} exited with code ${result.code} and said nothing.` });
    }
    const asked = Number(sql(`SELECT COUNT(*) AS n FROM comments c WHERE c.task_id = :p1 AND c.kind = 'ask' AND c.author = :p2 AND c.id > :p3
                                 AND NOT EXISTS (SELECT 1 FROM comments d WHERE d.kind = 'decide' AND d.ref_id = c.id)`,
                             [taskId, actor, firstEntry])[0].n);
    if (asked) {
      return end(entry, { state: "waiting_on_human", fields, reply: last,
        noteText: `Job ${job.id} is waiting on a person: ${label} asked a question on this Sheet. Answer it, and the job carries on.` });
    }
    return end(entry, { state: "done", fields, reply: last || `${label} finished and said nothing.`,
      noteText: `Job ${job.id} done.${where}` });
  }

  return {
    tick, create, approve, reject, stop, reply, get, list, recover, shutdown,
    running: () => [...live.keys()],
    /** Resolves once every job running now has ended. For tests and quitting. */
    idle: () => Promise.all([...live.values()].map((e) => e.promise)),
  };
}

module.exports = { createDispatcher, dangerous, storeClient, ADAPTER_BY_PARSER, DEFAULTS };
