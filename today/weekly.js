/**
 * The weekly review, in the Sunsama shape: look back at the week, tidy what
 * it left behind, and pick next week's few objectives.
 *
 * Shared by the app (main/weekly.js) and the MCP server (weekly_review), the
 * pattern today/brief.js follows: SQL text handed a sql(query, params)
 * function in the server's :p1 style, one statement per call, no database
 * opened here and no transaction assumed. It requires only its neighbours and
 * workbench/keep.js's constants, so it loads under a plain Node from
 * Resources/ beside the server.
 *
 * Read only. Park, Drop and saving the objectives are the window's, in
 * main/weekly.js, because they are a person's choices; an agent asking
 * weekly_review sees the same rows and changes nothing.
 *
 * The week is the seven days up to now, not the calendar week. A review is
 * held on whichever day a person picked (Friday by default), and "since last
 * Monday" would be four days on a Friday and one on a Monday.
 */

const brief = require("./brief");
const ledgerCore = require("../ledger/ledger");
const keep = require("../workbench/keep");

const DAY_MS = 86400000;
const CHARS_PER_TOKEN = 4;
// A Workbench with nothing done in it for this long is offered for Finish.
const IDLE_DAYS = 7;
// Kept copies expiring this soon are worth one last look.
const EXPIRING_DAYS = 7;
const OBJECTIVES_MIN = 3;
const OBJECTIVES_MAX = 5;
const OBJECTIVES_TITLE = "Objectives for the week of ";
// How a Drop's note begins (main/weekly.js writes it), so the look back can
// count a task let go apart from one finished.
const DROP_PREFIX = "Dropped in the weekly review";

// How far along a status is, so a change can be called a step back. Blocked
// sits beside in progress: being blocked is not undoing anything, but being
// sent back from review or reopened from done is. A status this version does
// not know reads as in progress, the rule slice 0 set.
const RANK = { todo: 0, doing: 1, blocked: 1, review: 2, done: 3 };
const RANK_SQL = (col) => `CASE ${col} WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 WHEN 'blocked' THEN 1 WHEN 'review' THEN 2 WHEN 'done' THEN 3 ELSE 1 END`;

const LIVE_PROJECT = "(p.id IS NULL OR p.status != 'archived')";
const inScope = (alias, n) => `(:p${n} IS NULL OR ${alias}.project_id = :p${n})`;
const num = (v) => (v == null || v === "" ? null : Number(v));
const msOf = (text) => { const s = brief.stamp(text); return s ? Date.parse(`${s.replace(" ", "T")}Z`) : NaN; };
const clip = (text, n) => {
  const v = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return v.length <= n ? v : `${v.slice(0, n - 3)}...`;
};
const parseMeta = (text) => { try { const v = JSON.parse(text); return v && typeof v === "object" ? v : null; } catch { return null; } };
const shellQuote = (p) => (/^[A-Za-z0-9_./:@+-]+$/.test(String(p)) ? String(p) : `'${String(p).replace(/'/g, "'\\''")}'`);

/** A local calendar date, YYYY-MM-DD. */
function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The Monday the objectives are for: the coming one from Friday to Sunday,
 * when the week is all but over, and this week's own from Monday to Thursday.
 */
function objectivesWeek(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const dow = d.getDay(); // 0 Sunday
  const back = (dow + 6) % 7; // days since Monday
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
  if (dow === 5 || dow === 6 || dow === 0) monday.setDate(monday.getDate() + 7);
  return localDate(monday.getTime());
}

/** The objectives a saved note lists, one per numbered line, with any task it names. */
function parseObjectives(body) {
  const out = [];
  for (const line of String(body || "").split("\n")) {
    const m = /^\s*\d+\.\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const task = /^#(\d+)\b/.exec(m[1]);
    out.push({ text: m[1], task_id: task ? Number(task[1]) : null });
  }
  return out;
}

/** The note's body for a list of objectives, the shape parseObjectives reads. */
function objectivesBody(objectives, { week, on }) {
  const lines = objectives.map((o, i) => `${i + 1}. ${String(o.text).replace(/\s+/g, " ").trim()}`);
  return `Picked in the weekly review on ${on}, for the week of ${week}.\n\n${lines.join("\n")}\n`;
}

/** The one command that puts a kept Workbench back, named the way keep.js names a recovery. */
function restoreCommand({ repo, folder, branch, id, ref }) {
  const tail = `recovered-${Number(id)}`;
  return `git -C ${shellQuote(repo)} worktree add -b ${shellQuote(`${branch}-${tail}`)} ${shellQuote(`${folder}-${tail}`)} ${shellQuote(ref)}`;
}

/**
 * Everything the review shows, for one project or all of them.
 *
 * look_back   decisions with the question each answered, cost and agent
 *             time from the ledger, tasks that went backwards, and what got done
 * tidy        stale tasks (today/brief.js's stuck rule), Workbenches idle for
 *             IDLE_DAYS, and kept copies expiring within EXPIRING_DAYS
 * next_week   tasks worth picking, and the last objectives with how they went
 */
function review(sql, { now = new Date(), projectId = null, days = 7 } = {}) {
  const until = brief.stamp(now);
  const span = Math.max(1, Math.min(31, Math.floor(Number(days) || 7)));
  const since = brief.stamp(msOf(until) - span * DAY_MS);
  const scope = projectId == null ? null : Number(projectId);

  // Every decision, a person's too: a review is about what was settled, not
  // only what was settled without you (that is the daily brief's question).
  const decisions = sql(
    `SELECT c.id AS entry_id, c.author, c.author_type, c.body, c.meta, c.created_at AS at,
            q.body AS question, t.id AS task_id, t.title AS task_title, t.project_id, p.name AS project_name
       FROM comments c
       JOIN tasks t ON t.id = c.task_id
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN comments q ON q.id = c.ref_id
      WHERE c.kind = 'decide' AND datetime(c.created_at) > datetime(:p1) AND datetime(c.created_at) <= datetime(:p2)
        AND ${LIVE_PROJECT} AND ${inScope("t", 3)}
      ORDER BY datetime(c.created_at) DESC, c.id DESC LIMIT 200`, [since, until, scope])
    .map((r) => {
      const meta = parseMeta(r.meta) || {};
      const lines = String(r.body || "").split("\n");
      return {
        entry_id: Number(r.entry_id), at: brief.stamp(r.at), who: r.author || null,
        author_type: r.author_type || null,
        choice: clip(meta.label || meta.choice || lines[0], 120),
        why: clip(lines.slice(1).join(" "), 200) || null,
        question: r.question ? clip(r.question, 200) : null,
        task_id: num(r.task_id), task_title: r.task_title, project_id: num(r.project_id), project_name: r.project_name || null,
      };
    });

  const cost = ledgerCore.makeLedger({ sql }).between({ since, until, projectId: scope });
  const titles = new Map();
  if (cost.by_task.length) {
    for (const r of sql(`SELECT t.id, t.title FROM tasks t WHERE t.id IN (SELECT DISTINCT h.task_id FROM handoffs h
                           WHERE datetime(COALESCE(h.finished_at, h.started_at, h.created_at)) > datetime(:p1)
                             AND datetime(COALESCE(h.finished_at, h.started_at, h.created_at)) <= datetime(:p2))`, [since, until])) {
      titles.set(Number(r.id), r.title);
    }
  }
  const topTasks = cost.by_task
    .filter((t) => t.runs > 0)
    .map((t) => ({ ...t, task_id: num(t.key), title: titles.get(num(t.key)) || null }))
    .sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0) || (b.agent_seconds || 0) - (a.agent_seconds || 0) || b.runs - a.runs)
    .slice(0, 5)
    .map(({ key, label, ...t }) => t);
  const { by_task: byTask, ...costRest } = cost;

  // A step back is a status event whose status ranks below the one before it.
  // LAG needs SQLite 3.25, inside the 3.35 the binary route already requires.
  const backwards = sql(
    `SELECT x.task_id, x.status AS to_status, x.prev AS from_status, x.actor, x.at,
            t.title, t.status AS now_status, t.project_id, p.name AS project_name
       FROM (SELECT e.id, e.task_id, e.status, e.actor, e.at,
                    LAG(e.status) OVER (PARTITION BY e.task_id ORDER BY datetime(e.at), e.id) AS prev
               FROM status_events e) x
       JOIN tasks t ON t.id = x.task_id
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE x.prev IS NOT NULL AND ${RANK_SQL("x.status")} < ${RANK_SQL("x.prev")}
        AND datetime(x.at) > datetime(:p1) AND datetime(x.at) <= datetime(:p2)
        AND ${LIVE_PROJECT} AND ${inScope("t", 3)}
      ORDER BY datetime(x.at) DESC, x.id DESC LIMIT 100`, [since, until, scope])
    .map((r) => ({
      task_id: Number(r.task_id), title: r.title, from: r.from_status, to: r.to_status, now: r.now_status,
      who: r.actor || null, at: brief.stamp(r.at), project_id: num(r.project_id), project_name: r.project_name || null,
    }));

  // Done means done now and finished inside the week, so a task reopened
  // since is not counted as an achievement it no longer is. A Drop is done
  // with a note, and is counted apart: letting go is not finishing.
  const doneRows = sql(
    `SELECT t.id, t.title, t.completed_at AS at, t.project_id, p.name AS project_name, t.parent_id,
            EXISTS (SELECT 1 FROM comments c WHERE c.task_id = t.id AND c.kind = 'note' AND c.body LIKE :p4
                      AND datetime(c.created_at) > datetime(:p1)) AS dropped
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.status = 'done' AND t.completed_at IS NOT NULL
        AND datetime(t.completed_at) > datetime(:p1) AND datetime(t.completed_at) <= datetime(:p2)
        AND ${LIVE_PROJECT} AND ${inScope("t", 3)}
      ORDER BY datetime(t.completed_at) DESC, t.id DESC`, [since, until, scope, `${DROP_PREFIX}%`]);
  const finished = doneRows.filter((r) => Number(r.dropped) !== 1);
  const done = {
    count: finished.length,
    subtasks: finished.filter((r) => r.parent_id != null).length,
    dropped: doneRows.length - finished.length,
    tasks: finished.slice(0, 12).map((r) => ({ id: Number(r.id), title: r.title, at: brief.stamp(r.at), project_id: num(r.project_id), project_name: r.project_name || null })),
  };

  const stale = brief.stuck(sql, { now: until, projectId: scope });

  // Idle: nothing recorded in it, by Delphi or a run, for IDLE_DAYS. A done
  // task still holding a Workbench is the likeliest Finish, so it says so.
  const idle = sql(
    `SELECT * FROM (
       SELECT w.id, w.task_id, w.branch, w.path, w.state, t.title, t.status AS task_status, t.project_id, p.name AS project_name,
              max(COALESCE(datetime(w.updated_at), ''), COALESCE(datetime(w.created_at), ''),
                  COALESCE((SELECT max(datetime(COALESCE(h.last_activity, h.finished_at, h.updated_at, h.created_at)))
                              FROM handoffs h WHERE h.workbench_id = w.id), '')) AS last_at
         FROM workbenches w
         JOIN tasks t ON t.id = w.task_id
         LEFT JOIN projects p ON p.id = t.project_id
        WHERE w.state IN ('active', 'parked') AND ${LIVE_PROJECT} AND ${inScope("t", 2)})
      WHERE last_at != '' AND julianday(:p1) - julianday(last_at) >= ${IDLE_DAYS}
      ORDER BY last_at, id`, [until, scope])
    .map((r) => ({
      workbench_id: Number(r.id), task_id: Number(r.task_id), title: r.title, task_status: r.task_status,
      branch: r.branch, path: r.path, state: r.state, last_at: brief.stamp(r.last_at),
      days: Math.floor((msOf(until) - msOf(r.last_at)) / DAY_MS),
      project_id: num(r.project_id), project_name: r.project_name || null,
    }));

  // The copy is dated by its commit, made as the closing began, so expiry
  // counts from closing_at; closed_at is the fallback for a row that has none.
  // Housekeeping is what deletes it, so the date is "kept until", not a promise
  // the ref is still there: a person may have deleted it by hand.
  const expiring = sql(
    `SELECT * FROM (
       SELECT w.id, w.task_id, w.branch, w.path, w.state, w.closing_ref AS ref, r.path AS repo,
              t.title, t.project_id, p.name AS project_name,
              datetime(COALESCE(w.closing_at, w.closed_at), '+${keep.KEEP_DAYS} days') AS expires_at
         FROM workbenches w
         JOIN tasks t ON t.id = w.task_id
         JOIN repos r ON r.id = w.repo_id
         LEFT JOIN projects p ON p.id = t.project_id
        WHERE w.state IN ('finished', 'discarded') AND w.closing_ref IS NOT NULL
          AND COALESCE(w.closing_at, w.closed_at) IS NOT NULL AND ${LIVE_PROJECT} AND ${inScope("t", 2)})
      WHERE datetime(expires_at) > datetime(:p1) AND julianday(expires_at) - julianday(:p1) <= ${EXPIRING_DAYS}
      ORDER BY expires_at, id`, [until, scope])
    .map((r) => {
      const left = (msOf(r.expires_at) - msOf(until)) / DAY_MS;
      return {
        workbench_id: Number(r.id), task_id: Number(r.task_id), title: r.title, kind: r.state,
        branch: r.branch, ref: r.ref, repo: r.repo, expires_at: brief.stamp(r.expires_at),
        // Whole days still to go; 0 is "under a day".
        days_left: left < 1 ? 0 : Math.round(left), project_id: num(r.project_id), project_name: r.project_name || null,
        restore: restoreCommand({ repo: r.repo, folder: r.path, branch: r.branch, id: r.id, ref: r.ref }),
      };
    });

  // Worth picking: what is under way, then what falls due soon, then high
  // priority, then whatever moved last. Top level only: an objective is a
  // piece of work, and a subtask is a step in one.
  const candidates = sql(
    `SELECT t.id, t.title, t.status, t.priority, t.due, t.project_id, p.name AS project_name, t.updated_at
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.status != 'done' AND t.parent_id IS NULL AND ${LIVE_PROJECT} AND ${inScope("t", 2)}
      ORDER BY CASE WHEN t.status IN ('doing', 'review') THEN 0
                    WHEN t.due IS NOT NULL AND date(t.due) <= date(:p1, '+7 days') THEN 1
                    WHEN t.priority = 'high' THEN 2 ELSE 3 END,
               CASE t.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END,
               datetime(t.updated_at) DESC, t.id DESC
      LIMIT 20`, [until, scope])
    .map((r) => {
      const why = [];
      if (r.status === "doing" || r.status === "review") why.push(r.status === "review" ? "In review" : "In progress");
      if (r.status === "blocked") why.push("Blocked");
      const due = r.due ? String(r.due).slice(0, 10) : null;
      if (due && due < localDate(msOf(until))) why.push(`Overdue since ${due}`);
      else if (due && due <= localDate(msOf(until) + 7 * DAY_MS)) why.push(`Due ${due}`);
      if (r.priority === "high") why.push("High priority");
      return { id: Number(r.id), title: r.title, status: r.status, priority: r.priority, due: r.due || null,
               project_id: num(r.project_id), project_name: r.project_name || null, why };
    });

  // The last objectives, with how each one went, which is the first thing a
  // Sunsama review asks: did you do what you said you would.
  const lastRow = sql(
    `SELECT n.id, n.title, n.body, n.created_at, n.project_id, p.name AS project_name
       FROM notes n LEFT JOIN projects p ON p.id = n.project_id
      WHERE n.kind = 'decision' AND n.title LIKE :p1 AND ${inScope("n", 2)}
      ORDER BY datetime(n.created_at) DESC, n.id DESC LIMIT 1`, [`${OBJECTIVES_TITLE}%`, scope])[0];
  let last = null;
  if (lastRow) {
    const items = parseObjectives(lastRow.body);
    const statuses = new Map();
    for (const o of items) {
      if (o.task_id == null || statuses.has(o.task_id)) continue;
      const t = sql("SELECT status FROM tasks WHERE id = :p1", [o.task_id])[0];
      statuses.set(o.task_id, t ? t.status : null);
    }
    last = {
      note_id: Number(lastRow.id), title: lastRow.title, created_at: brief.stamp(lastRow.created_at),
      week: String(lastRow.title).slice(OBJECTIVES_TITLE.length, OBJECTIVES_TITLE.length + 10),
      project_id: num(lastRow.project_id), project_name: lastRow.project_name || null,
      objectives: items.map((o) => ({ ...o, status: o.task_id == null ? null : statuses.get(o.task_id) || "missing" })),
    };
  }

  return {
    since, until, days: span, project_id: scope,
    look_back: { decisions, cost: { ...costRest, top_tasks: topTasks }, backwards, done },
    tidy: { stale, idle_workbenches: idle, expiring },
    next_week: {
      week: objectivesWeek(msOf(until)), min: OBJECTIVES_MIN, max: OBJECTIVES_MAX,
      candidates, last,
      saved_this_week: Boolean(last && msOf(until) - msOf(last.created_at) < 6 * DAY_MS),
    },
  };
}

/** How many of each, for a heading or the Today card. */
function counts(r) {
  return {
    decisions: r.look_back.decisions.length, backwards: r.look_back.backwards.length, done: r.look_back.done.count,
    runs: r.look_back.cost.totals.runs, stale: r.tidy.stale.length, idle_workbenches: r.tidy.idle_workbenches.length,
    expiring: r.tidy.expiring.length,
  };
}

/**
 * The review for an agent: lines in three sections inside a token budget, the
 * way agent/recall.js answers. The longest section gives up its last line
 * first, so a busy week trims its tail evenly and says it did.
 */
function compact(r, { budget = 1200 } = {}) {
  const dayOf = (at) => String(at || "").slice(0, 10);
  const lb = r.look_back;
  const look = [];
  look.push(`Done: ${lb.done.count}${lb.done.subtasks ? ` (${lb.done.subtasks} subtasks)` : ""}${lb.done.dropped ? `, and ${lb.done.dropped} dropped` : ""}.`);
  look.push(`Agent work: ${ledgerCore.phrases(lb.cost.totals).join(", ")}.`);
  for (const t of lb.cost.top_tasks) look.push(`Cost: #${t.task_id} ${clip(t.title, 60)}: ${ledgerCore.brief(t).join(", ")}.`);
  for (const d of lb.decisions) {
    look.push(`Decided on #${d.task_id} ${clip(d.task_title, 50)}: "${clip(d.choice, 70)}"${d.question ? ` for "${clip(d.question, 80)}"` : ""}${d.who ? ` by ${d.who}` : ""}, ${dayOf(d.at)} (entry ${d.entry_id}).`);
  }
  for (const b of lb.backwards) look.push(`Back: #${b.task_id} ${clip(b.title, 60)} went ${b.from} to ${b.to}${b.who ? ` (${b.who})` : ""}, ${dayOf(b.at)}.`);
  for (const t of lb.done.tasks) look.push(`Done: #${t.id} ${clip(t.title, 70)}, ${dayOf(t.at)}.`);
  const tidy = [];
  for (const s of r.tidy.stale) tidy.push(`Stale: #${s.id} ${clip(s.title, 60)} (${s.status}), ${s.words.toLowerCase()}.`);
  for (const w of r.tidy.idle_workbenches) tidy.push(`Idle Workbench ${w.workbench_id} ${w.branch} on #${w.task_id} (task ${w.task_status}), ${w.days} days.`);
  for (const e of r.tidy.expiring) tidy.push(`Expiring ${e.expires_at.slice(0, 10)}: ${e.kind} Workbench ${e.workbench_id} on #${e.task_id} as ${e.ref}. Restore: ${e.restore}`);
  const next = [];
  if (r.next_week.last) {
    const l = r.next_week.last;
    next.push(`Last objectives (week of ${l.week}, note ${l.note_id}): ${l.objectives.map((o) => `${clip(o.text, 50)}${o.status ? ` [${o.status}]` : ""}`).join("; ")}.`);
  }
  for (const c of r.next_week.candidates.slice(0, 10)) next.push(`Candidate: #${c.id} ${clip(c.title, 60)}${c.why.length ? ` (${c.why.join(", ")})` : ""}.`);
  const out = {
    since: r.since, until: r.until, counts: counts(r), cost_note: lb.cost.cost_label,
    look_back: look, tidy, next_week: next,
    note: "Read only. Park, Drop and saving objectives happen in the Delphi window.",
  };
  const limit = Math.max(200, Number(budget) || 1200) * CHARS_PER_TOKEN;
  const parts = [out.look_back, out.tidy, out.next_week];
  // The first two lines of look back are the totals, kept to the end.
  while (JSON.stringify(out).length > limit) {
    const longest = parts.reduce((a, b) => (b.length > a.length ? b : a));
    if (longest.length <= (longest === out.look_back ? 2 : 0)) break;
    longest.pop();
    out.trimmed = true;
  }
  if (out.trimmed) out.more = "Trimmed to the budget. Pass a project, a larger budget, or detail: \"full\".";
  return out;
}

module.exports = {
  IDLE_DAYS, EXPIRING_DAYS, OBJECTIVES_MIN, OBJECTIVES_MAX, OBJECTIVES_TITLE, DROP_PREFIX, RANK,
  review, counts, compact, objectivesWeek, parseObjectives, objectivesBody, restoreCommand, localDate,
};
