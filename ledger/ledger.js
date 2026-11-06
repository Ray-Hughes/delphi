// The cost and time ledger: what agent work on a task, a project or a week
// took, in tokens, API-equivalent dollars, Copilot premium requests, wall-clock
// time, runs and sent-backs, and how long each task sat in each status.
//
// Shared, the same pattern as sheet/store.js: SQL text and arithmetic that never
// open a database. makeLedger is handed a sql(query, params) function in the
// server's :p1 style. The app passes db.sqlP, the MCP server its own (which may
// be shelling out), so every query here is one statement and nothing relies on
// last_insert_rowid or a transaction. The renderer loads this file too, with a
// <script> tag, for the formatting half only, so the window and cost_ledger say
// a number the same way.
//
// Honesty rules, which are the point of the module:
// - A null column is "not reported", never zero. A harness that reports no
//   cost has no cost here, not a free run, and a partial sum says how many runs
//   it covers.
// - Dollars are what the agent itself reported (Claude Code's total_cost_usd),
//   which is the API price of the tokens. On a subscription nobody is billed
//   that, so every dollar figure carries COST_LABEL.
// - Copilot's premium requests are their own unit and are never added to
//   dollars or converted into them.
// - Agent time is the job's wall clock from its first start to its last finish,
//   which includes any time it sat waiting on a person between turns.
// - Session tokens (agent tabs and Delphi's chat) are running totals with no
//   dates per turn, so they are shown all time and never split by week.

(function (root) {
  const COST_LABEL = "API-equivalent; subscription plans don't bill per token";
  const STATUS_WORDS = { todo: "To do", doing: "In progress", review: "In review", blocked: "Blocked", done: "Done" };

  // Monday on or before a stamp, in local time. SQLite stores UTC, and a week
  // a person reads starts at their own midnight.
  const weekOf = (col) => `date(${col}, 'localtime', '-6 days', 'weekday 1')`;
  const STATE = "COALESCE(h.state, h.status)";
  const AT = "COALESCE(h.finished_at, h.started_at, h.created_at)";

  // One row per job. seconds runs to now for a job still running, and to its
  // last update for one paused between turns, so a long job is not invisible
  // until it ends. A queued job that never started has no time at all.
  const JOB_COLUMNS = `
    h.id, h.task_id, h.project_id, p.name AS project_name, h.to_harness AS harness,
    COALESCE(hr.label, h.to_harness) AS harness_label, ${STATE} AS state, h.kind,
    h.tokens_in, h.tokens_out, h.cost_usd, h.premium_requests, h.turns, h.review,
    h.started_at, h.finished_at,
    CASE WHEN h.started_at IS NULL THEN NULL ELSE
      CAST(ROUND((julianday(COALESCE(h.finished_at, CASE WHEN ${STATE} = 'running' THEN datetime('now') ELSE h.updated_at END))
                  - julianday(h.started_at)) * 86400) AS INTEGER) END AS seconds,
    (SELECT COUNT(*) FROM audit a WHERE a.entity = 'handoff' AND a.entity_id = h.id AND a.summary LIKE 'sent back%') AS sent_back_count,
    ${weekOf(AT)} AS week,
    datetime(${AT}) AS at
    FROM handoffs h
    LEFT JOIN harnesses hr ON hr.key = h.to_harness
    LEFT JOIN projects p ON p.id = h.project_id`;

  const num = (v) => (v == null || v === "" ? null : Number(v));

  /**
   * Totals over job rows. Every measure keeps how many runs reported it, so a
   * reader can tell "$0.00" from "nobody said".
   */
  function total(rows) {
    const t = { jobs: 0, runs: 0, running: 0, turns: 0, tokens_in: 0, tokens_out: 0, tokens_reported: 0,
                cost_usd: 0, cost_reported: 0, premium_requests: 0, premium_reported: 0,
                agent_seconds: 0, timed: 0, sent_backs: 0, accepted: 0 };
    for (const r of rows) {
      t.jobs += 1;
      if (r.started_at) t.runs += 1;
      if (r.state === "running") t.running += 1;
      t.turns += num(r.turns) || 0;
      if (r.tokens_in != null || r.tokens_out != null) {
        t.tokens_reported += 1;
        t.tokens_in += num(r.tokens_in) || 0;
        t.tokens_out += num(r.tokens_out) || 0;
      }
      if (r.cost_usd != null) { t.cost_reported += 1; t.cost_usd += num(r.cost_usd); }
      if (r.premium_requests != null) { t.premium_reported += 1; t.premium_requests += num(r.premium_requests); }
      if (r.seconds != null && num(r.seconds) >= 0) { t.timed += 1; t.agent_seconds += num(r.seconds); }
      // The audit row is the record that survives a reply; the review column is
      // cleared when the job runs again. Whichever saw more.
      t.sent_backs += Math.max(num(r.sent_back_count) || 0, r.review === "sent_back" ? 1 : 0);
      if (r.review === "accepted") t.accepted += 1;
    }
    if (!t.tokens_reported) { t.tokens_in = null; t.tokens_out = null; }
    if (!t.cost_reported) t.cost_usd = null;
    else t.cost_usd = Math.round(t.cost_usd * 10000) / 10000;
    if (!t.premium_reported) t.premium_requests = null;
    else t.premium_requests = Math.round(t.premium_requests * 100) / 100;
    if (!t.timed) t.agent_seconds = null;
    return t;
  }

  function groupBy(rows, key, label) {
    const groups = new Map();
    for (const r of rows) {
      const k = r[key] == null ? "" : String(r[key]);
      if (!groups.has(k)) groups.set(k, { key: r[key], label: label ? r[label] : r[key], rows: [] });
      groups.get(k).rows.push(r);
    }
    return [...groups.values()].map((g) => ({ key: g.key, label: g.label, ...total(g.rows) }));
  }

  /**
   * Seconds in each status, from a task's events in order, up to now. A final
   * done stops the clock; a done the task was reopened from counts as Done.
   */
  function statusSeconds(events, nowStamp) {
    const out = {};
    const t = (s) => Date.parse(String(s).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z"));
    const now = t(nowStamp);
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.status === "done" && i === events.length - 1) break;
      const next = i + 1 < events.length && events[i + 1].task_id === e.task_id ? t(events[i + 1].at) : (e.status === "done" ? null : now);
      if (next == null) continue;
      const span = Math.max(0, Math.round((next - t(e.at)) / 1000));
      if (Number.isFinite(span)) out[e.status] = (out[e.status] || 0) + span;
    }
    return out;
  }

  /** statusSeconds summed over several tasks' events, ordered by task then time. */
  function statusSecondsMany(events, nowStamp) {
    const out = {};
    let start = 0;
    for (let i = 1; i <= events.length; i++) {
      if (i === events.length || events[i].task_id !== events[start].task_id) {
        const one = statusSeconds(events.slice(start, i), nowStamp);
        for (const [k, v] of Object.entries(one)) out[k] = (out[k] || 0) + v;
        start = i;
      }
    }
    return out;
  }

  function makeLedger({ sql }) {
    if (typeof sql !== "function") throw new Error("makeLedger needs a sql(query, params) function.");

    // All of it from one instant, which a test can set. week_point is the same
    // local wall-clock time a week ago, turned back into UTC: across a DST
    // change that is 167 or 169 hours ago, not 168, and "last week by now"
    // means the clock on the wall, not a count of hours.
    const clock = (at = null) => sql(`SELECT datetime(COALESCE(:p1, 'now')) AS now,
                                    ${weekOf("datetime(COALESCE(:p1, 'now'))")} AS this_week,
                                    date(COALESCE(:p1, 'now'), 'localtime', '-13 days', 'weekday 1') AS last_week,
                                    datetime(COALESCE(:p1, 'now'), 'localtime', '-7 days', 'utc') AS week_point`, [at])[0];

    function events(where, params) {
      return sql(`SELECT task_id, status, at FROM status_events WHERE ${where} ORDER BY task_id, at, id`, params);
    }

    /**
     * Everything the ledger knows about one task: totals, the same per agent,
     * each job in one line, and the time the task spent in each status.
     * Null when there is no such task.
     */
    function forTask(taskId) {
      const id = Number(taskId);
      if (!Number.isInteger(id)) throw new Error("ledger.forTask needs a task id.");
      const task = sql("SELECT id, title, status, project_id FROM tasks WHERE id = :p1", [id])[0];
      if (!task) return null;
      const now = clock();
      const rows = sql(`SELECT ${JOB_COLUMNS} WHERE h.task_id = :p1 ORDER BY h.id`, [id]);
      return {
        task_id: id,
        title: task.title,
        status: task.status,
        project_id: task.project_id,
        cost_label: COST_LABEL,
        totals: total(rows),
        by_harness: groupBy(rows, "harness", "harness_label"),
        status_seconds: statusSeconds(events("task_id = :p1", [id]), now.now),
        jobs: rows.map((r) => ({
          id: r.id, harness: r.harness, harness_label: r.harness_label, state: r.state, kind: r.kind,
          tokens_in: num(r.tokens_in), tokens_out: num(r.tokens_out), cost_usd: num(r.cost_usd),
          premium_requests: num(r.premium_requests), turns: num(r.turns) || 0, seconds: num(r.seconds),
          review: r.review || null, sent_back_count: num(r.sent_back_count) || 0, started_at: r.started_at, finished_at: r.finished_at,
        })),
      };
    }

    /**
     * Totals over the last `weeks` weeks (this one included), for one project
     * or all of them: per week, per agent, per project, this week against last,
     * and last week up to this same moment, which is the fair comparison while
     * this week is still going.
     */
    function rollup({ projectId = null, weeks = 8, now: at = null } = {}) {
      const n = Math.max(1, Math.min(52, Math.floor(Number(weeks) || 8)));
      const now = clock(at);
      // Read at least two weeks whatever was asked for: the comparison with
      // last week is always made, and weeks: 1 must not compare with nothing.
      const read = Math.max(n, 2);
      const scope = (count) => {
        const params = [now.this_week];
        let where = `${weekOf(AT)} >= date(:p1, '-${(count - 1) * 7} days')`;
        if (projectId != null) { params.push(Number(projectId)); where += ` AND h.project_id = :p${params.length}`; }
        return { where, params };
      };
      const { where, params } = scope(n);
      const wide = scope(read);
      const all = sql(`SELECT ${JOB_COLUMNS} WHERE ${wide.where} ORDER BY h.id`, wide.params);
      const first = new Date(Date.parse(`${now.this_week}T00:00:00Z`) - (n - 1) * 7 * 86400000).toISOString().slice(0, 10);
      const rows = all.filter((r) => r.week >= first);

      const thisWeek = all.filter((r) => r.week === now.this_week);
      const lastWeek = all.filter((r) => r.week === now.last_week);
      const byWeek = new Map(groupBy(rows, "week").map((w) => [w.key, w]));
      const series = [];
      // Plain calendar dates, so UTC arithmetic on them is exact.
      const monday = Date.parse(`${now.this_week}T00:00:00Z`);
      for (let i = n - 1; i >= 0; i--) {
        const week = new Date(monday - i * 7 * 86400000).toISOString().slice(0, 10);
        const { key, label, ...w } = byWeek.get(week) || total([]);
        series.push({ week, ...w });
      }

      // Sessions carry running totals only, so they are all time and never weekly.
      const tabParams = [];
      let tabWhere = "(s.tokens_in > 0 OR s.tokens_out > 0)";
      if (projectId != null) { tabParams.push(Number(projectId)); tabWhere += " AND s.project_id = :p1"; }
      const tabs = sql(`SELECT COALESCE(s.harness, 'chat') AS harness,
                               COALESCE(hr.label, s.harness, 'Delphi chat') AS harness_label,
                               COUNT(*) AS sessions, SUM(s.tokens_in) AS tokens_in, SUM(s.tokens_out) AS tokens_out
                        FROM sessions s LEFT JOIN harnesses hr ON hr.key = s.harness
                        WHERE ${tabWhere} GROUP BY 1, 2 ORDER BY 1`, tabParams)
        .map((t) => ({ harness: t.harness, harness_label: t.harness_label, sessions: num(t.sessions), tokens_in: num(t.tokens_in), tokens_out: num(t.tokens_out) }));

      const out = {
        project_id: projectId == null ? null : Number(projectId),
        cost_label: COST_LABEL,
        weeks: n,
        this_week: now.this_week,
        last_week: now.last_week,
        // The cut for last_week_to_date: this wall-clock time a week ago, in UTC.
        week_point: now.week_point,
        totals: total(rows),
        this_week_totals: total(thisWeek),
        last_week_totals: total(lastWeek),
        last_week_to_date: total(lastWeek.filter((r) => r.at <= now.week_point)),
        series,
        by_harness: groupBy(rows, "harness", "harness_label"),
        this_week_by_harness: groupBy(thisWeek, "harness", "harness_label"),
        by_project: groupBy(rows, "project_id", "project_name"),
        tabs,
      };
      if (projectId != null) {
        // Only the tasks agents worked on, inside the window: how long agent
        // work sat in review or blocked is the question; the whole backlog is not.
        // A subquery rather than a list of ids, so a busy project is not one
        // very long statement on the binary route. Lifetime time for each
        // task, since a status that began before the window still ran in it.
        out.agent_tasks = new Set(rows.map((r) => r.task_id).filter((v) => v != null)).size;
        out.status_seconds = out.agent_tasks
          ? statusSecondsMany(events(`task_id IN (SELECT DISTINCT h.task_id FROM handoffs h WHERE ${where} AND h.task_id IS NOT NULL)`, params), now.now)
          : {};
      }
      return out;
    }

    return { forTask, rollup };
  }

  // ---------------------------------------------------------------------------
  // Saying it. Shared by the window and cost_ledger.

  function tokens(n) {
    if (n == null) return null;
    const v = Number(n);
    // Rounded first, so 999,999 is 1M and not 1000k.
    const k = Number((v / 1000).toFixed(v < 10000 ? 1 : 0));
    return v < 1000 ? String(v) : k < 1000 ? `${String(k)}k` : `${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  }

  function money(usd) {
    if (usd == null) return null;
    const v = Number(usd);
    if (v > 0 && v < 0.005) return "under $0.01";
    return `$${v.toFixed(2)}`;
  }

  function duration(seconds) {
    if (seconds == null) return null;
    const s = Math.max(0, Math.round(Number(seconds)));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const partial = (got, of) => (got < of ? ` (${got} of ${of} runs reported)` : "");

  /**
   * The measures of one totals object as short phrases, nulls said as "not
   * reported". Copilot's premium requests are their own phrase, never a sum
   * with dollars.
   */
  function phrases(t) {
    if (!t || !t.jobs) return ["no agent runs"];
    if (!t.runs) return [`no runs yet (${plural(t.jobs, "job", "jobs")} not started)`];
    const out = [plural(t.runs, "run", "runs")];
    if (t.running) out.push(`${t.running} running`);
    out.push(t.agent_seconds == null ? "time not reported" : `${duration(t.agent_seconds)} agent time${partial(t.timed, t.runs)}`);
    if (t.tokens_in == null) out.push("tokens not reported");
    else out.push(`${tokens(t.tokens_in + t.tokens_out)} tokens (${tokens(t.tokens_in)} in, ${tokens(t.tokens_out)} out)${partial(t.tokens_reported, t.runs)}`);
    if (t.cost_usd == null) out.push("cost not reported");
    else out.push(`${money(t.cost_usd)} API-equivalent${partial(t.cost_reported, t.runs)}`);
    if (t.premium_requests != null) out.push(`${t.premium_requests} premium ${t.premium_requests === 1 ? "request" : "requests"}`);
    if (t.sent_backs) out.push(`${t.sent_backs} sent back`);
    return out;
  }

  /**
   * The same, shorter, for a row under a heading that already says the
   * dollars are API-equivalent: total tokens only, and "(4 of 7)" for a
   * partial sum.
   */
  function brief(t) {
    if (!t || !t.jobs) return ["no agent runs"];
    if (!t.runs) return [`no runs yet (${plural(t.jobs, "job", "jobs")} not started)`];
    const of = (got) => (got < t.runs ? ` (${got} of ${t.runs})` : "");
    const out = [plural(t.runs, "run", "runs"), t.agent_seconds == null ? "time not reported" : `${duration(t.agent_seconds)}${of(t.timed)}`];
    out.push(t.tokens_in == null ? "tokens not reported" : `${tokens(t.tokens_in + t.tokens_out)} tokens${of(t.tokens_reported)}`);
    out.push(t.cost_usd == null ? "cost not reported" : `${money(t.cost_usd)}${of(t.cost_reported)}`);
    if (t.premium_requests != null) out.push(`${t.premium_requests} premium ${t.premium_requests === 1 ? "request" : "requests"}`);
    if (t.sent_backs) out.push(`${t.sent_backs} sent back`);
    return out;
  }

  /** "Claude Code tabs", or "Delphi chat" for the built-in chat, which has no tabs. */
  const tabLabel = (t) => (t.harness === "chat" ? "Delphi chat" : `${t.harness_label} tabs`);

  function statusPhrases(seconds) {
    return Object.entries(seconds || {})
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${STATUS_WORDS[k] || k} ${duration(v)}`);
  }

  /** A change from b to a in words, or null when there is nothing to compare. */
  function change(a, b) {
    if (a == null || b == null) return null;
    if (!b) return a ? "new this week" : null;
    const pct = Math.round(((a - b) / b) * 100);
    if (pct === 0) return "level";
    return pct > 0 ? `up ${pct}%` : `down ${-pct}%`;
  }

  /**
   * The ledger as a few lines of text inside a token budget (four characters a
   * token, the estimate agent/recall.js makes). For cost_ledger's compact
   * answer. Says when it trimmed.
   */
  function compact(answer, { budget = 400 } = {}) {
    const lines = [];
    if (answer.task_id != null) {
      lines.push(`Task ${answer.task_id} ${answer.title}: ${phrases(answer.totals).join(", ")}.`);
      const st = statusPhrases(answer.status_seconds);
      if (st.length) lines.push(`Time in status: ${st.join(", ")}.`);
      if (answer.by_harness.length > 1) for (const h of answer.by_harness) lines.push(`${h.label}: ${brief(h).join(", ")}.`);
      for (const j of answer.jobs.slice(-5).reverse()) {
        const said = j.started_at ? phrases(total([j])).slice(1).join(", ") : "not started";
        lines.push(`Job ${j.id} (${j.harness_label}, ${String(j.state).replace(/_/g, " ")}${j.review ? `, ${j.review.replace("_", " ")}` : ""}): ${said}.`);
      }
    } else {
      const tw = answer.this_week_totals, lw = answer.last_week_to_date;
      lines.push(`This week so far (from ${answer.this_week}): ${phrases(tw).join(", ")}.`);
      lines.push(`Last week by this point: ${phrases(lw).join(", ")}. Whole of last week: ${phrases(answer.last_week_totals).join(", ")}.`);
      const vs = [["runs", tw.runs, lw.runs], ["agent time", tw.agent_seconds, lw.agent_seconds], ["cost", tw.cost_usd, lw.cost_usd]]
        .map(([k, a, b]) => { const c = change(a, b); return c ? `${k} ${c}` : null; }).filter(Boolean);
      if (vs.length) lines.push(`Week over week: ${vs.join(", ")}.`);
      lines.push(`Last ${answer.weeks} weeks: ${phrases(answer.totals).join(", ")}.`);
      for (const h of answer.by_harness) lines.push(`${h.label}: ${brief(h).join(", ")}.`);
      if (answer.project_id == null) {
        for (const p of [...answer.by_project].sort((a, b) => b.runs - a.runs).slice(0, 8)) lines.push(`Project ${p.label || (p.key == null ? "none" : p.key)}: ${brief(p).join(", ")}.`);
      }
      const st = statusPhrases(answer.status_seconds);
      if (st.length) lines.push(`Its ${plural(answer.agent_tasks, "agent task", "agent tasks")} spent: ${st.join(", ")}.`);
      for (const t of answer.tabs) lines.push(`${tabLabel(t)}, all time: ${tokens(t.tokens_in + t.tokens_out)} tokens over ${plural(t.sessions, "session", "sessions")}.`);
    }
    const max = Math.max(100, Number(budget) || 400) * 4;
    const kept = [];
    let used = COST_LABEL.length + 40;
    let trimmed = false;
    for (const line of lines) {
      if (used + line.length + 1 > max) { trimmed = true; break; }
      kept.push(line);
      used += line.length + 1;
    }
    return { lines: kept, cost_note: COST_LABEL, trimmed };
  }

  const api = { COST_LABEL, STATUS_WORDS, makeLedger, total, statusSeconds, statusSecondsMany, tokens, money, duration, phrases, brief, tabLabel, statusPhrases, change, compact };
  root.DelphiLedgerCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
