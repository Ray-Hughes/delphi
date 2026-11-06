// The cost and time ledger in the window: a Cost and time card in Runs, the
// same per project in its Overview, and one line per task for the drawer.
//
// The sums are ledger/ledger.js's (DelphiLedgerCore), the module the MCP
// server's cost_ledger uses, so the window and an agent never disagree about a
// number. Data comes through window.delphi.ledger only:
//
//   window.delphi.ledger.forTask(taskId)        -> main/ledger.js ledger:forTask
//   window.delphi.ledger.rollup({ projectId, weeks })
//
// For the drawer's Runs card (ui/drawer.js, built in its own slice):
//
//   DelphiLedger.taskLine(taskId)  returns a <div class="lg-line"> at once and
//                                  fills it when the answer arrives. Append it
//                                  where the Runs card wants it. Null-safe: a
//                                  task with no runs says so in one line.
//
// Each card is returned at once and filled when its answer arrives, from the
// last answer for the same thing when there is one, because Runs repaints on
// every runs-changed and a card that blanked each time would flicker.

(function () {
  const L = window.DelphiLedgerCore;
  const cache = new Map();

  function fetchInto(key, ask, paint) {
    if (cache.has(key)) paint(cache.get(key));
    ask().then((answer) => { cache.set(key, answer); paint(answer); })
      .catch((error) => { if (!cache.has(key)) paint(null, error); });
  }

  const missing = (text = "not reported") => el("span", { className: "lg-missing", textContent: text });

  const of = (got, runs) => (got < runs ? ` (${got} of ${runs})` : "");

  // One cell per measure. Null is "not reported", and a partial sum says how
  // many of the runs it covers, so a small number is never mistaken for a total.
  const MEASURES = [
    ["Runs", (t) => String(t.runs) + (t.running ? `, ${t.running} running` : "")],
    ["Agent time", (t) => (t.agent_seconds == null ? null : L.duration(t.agent_seconds) + of(t.timed, t.runs))],
    ["Tokens", (t) => (t.tokens_in == null ? null : L.tokens(t.tokens_in + t.tokens_out) + of(t.tokens_reported, t.runs))],
    ["API-equivalent cost", (t) => (t.cost_usd == null ? null : L.money(t.cost_usd) + of(t.cost_reported, t.runs))],
    ["Copilot premium requests", (t) => (t.premium_requests == null ? null : String(t.premium_requests))],
    ["Sent back", (t) => String(t.sent_backs)],
  ];

  /** Measures down, periods across. A period with no runs shows a dash rather than a row of "not reported". */
  function table(columns) {
    const t = el("table", { className: "lg-table" });
    const head = el("tr", {}, el("th", { scope: "col", className: "lg-k" }, el("span", { className: "lg-sr", textContent: "Measure" })));
    for (const [label] of columns) head.append(el("th", { scope: "col", textContent: label }));
    t.append(el("thead", {}, head));
    const body = el("tbody");
    for (const [name, value] of MEASURES) {
      // Premium requests only where some agent reports them.
      if (name.startsWith("Copilot") && !columns.some(([, tot]) => tot.premium_requests != null)) continue;
      const row = el("tr", {}, el("th", { scope: "row", className: "lg-k", textContent: name }));
      for (const [, tot] of columns) {
        const v = tot.jobs ? value(tot) : "·";
        row.append(el("td", {}, v == null ? missing() : v));
      }
      body.append(row);
    }
    t.append(body);
    return t;
  }

  /** "runs up 40%, agent time down 10%": this week so far against last week by the same point. */
  function weekOverWeek(a, b) {
    const parts = [["runs", a.runs, b.runs], ["agent time", a.agent_seconds, b.agent_seconds], ["cost", a.cost_usd, b.cost_usd]]
      .map(([k, x, y]) => { const c = L.change(x, y); return c ? `${k} ${c}` : null; }).filter(Boolean);
    return parts.length ? `Against last week by this point: ${parts.join(", ")}.` : "Nothing to compare with last week yet.";
  }

  /** One line per group: "Claude Code  3 runs, 1h agent time, $2.10 API-equivalent". */
  function groupRows(groups, labelOf) {
    const box = el("div", { className: "lg-groups" });
    for (const g of groups) {
      box.append(el("div", { className: "lg-group" },
        el("span", { className: "lg-group-name", textContent: labelOf(g), title: labelOf(g) }),
        el("span", { className: "lg-group-v", textContent: L.brief(g).join(", ") })));
    }
    return box;
  }

  /** Agent time per week as bars, oldest first, with the numbers in words for a screen reader. */
  function bars(series) {
    const max = Math.max(1, ...series.map((w) => w.agent_seconds || 0));
    const words = series.map((w) => `week of ${w.week}: ${w.runs ? `${w.runs} ${w.runs === 1 ? "run" : "runs"}, ${L.duration(w.agent_seconds) || "time not reported"}` : "no runs"}`).join("; ");
    const box = el("div", { className: "lg-bars" });
    box.setAttribute("role", "img");
    box.setAttribute("aria-label", `Agent time per week, oldest first: ${words}.`);
    for (const w of series) {
      const h = w.agent_seconds ? Math.max(6, Math.round((w.agent_seconds / max) * 100)) : 0;
      const bar = el("span", { className: "lg-bar" + (w.runs ? "" : " none") });
      bar.style.height = `${h}%`;
      const col = el("span", { className: "lg-bar-col", title: `Week of ${w.week}: ${L.phrases(w).join(", ")}` }, bar);
      box.append(col);
    }
    const axis = el("div", { className: "lg-bars-axis" }, el("span", { textContent: `week of ${series[0].week}` }), el("span", { textContent: "this week" }));
    axis.setAttribute("aria-hidden", "true");
    return el("div", {}, box, axis);
  }

  const note = (text) => el("div", { className: "lg-note", textContent: text });

  /**
   * The Cost and time card for Runs, every project: this week so far, last
   * week by this point and the whole of last week, then per agent and per
   * project this week, and agent time over eight weeks.
   */
  function runsCard() {
    const box = el("div", { className: "box lg-box" });
    const sec = el("div", { className: "sec lg" },
      el("div", { className: "sec-h" }, el("h2", { textContent: "Cost and time" }), el("span", { className: "grow" }),
        el("span", { className: "hint", textContent: "every project, every agent" })),
      box);
    box.append(note("Adding it up."));
    fetchInto("runs", () => window.delphi.ledger.rollup({ weeks: 8 }), (r, error) => {
      box.textContent = "";
      if (!r) { box.append(note(`The ledger could not be read: ${error ? error.message : "no answer"}.`)); return; }
      if (!r.totals.jobs && !r.tabs.length) { box.append(note("No agent has run in the last eight weeks, so there is nothing to add up yet.")); return; }
      box.append(table([["This week so far", r.this_week_totals], ["Last week by now", r.last_week_to_date], ["All last week", r.last_week_totals]]));
      box.append(note(weekOverWeek(r.this_week_totals, r.last_week_to_date)));
      if (r.this_week_by_harness.length) {
        box.append(el("div", { className: "lg-sub", textContent: "By agent, this week (dollars API-equivalent)" }), groupRows(r.this_week_by_harness, (g) => g.label || g.key));
      }
      const projects = r.by_project.filter((p) => p.runs);
      if (projects.length) {
        // Over the eight weeks, busiest first: this week alone is often one project.
        box.append(el("div", { className: "lg-sub", textContent: "By project, last eight weeks (dollars API-equivalent)" }),
          groupRows([...projects].sort((a, b) => b.runs - a.runs).slice(0, 5), (g) => g.label || "No project"));
      }
      box.append(el("div", { className: "lg-sub", textContent: "Agent time, last eight weeks" }), bars(r.series));
      box.append(note(`Dollars are ${L.COST_LABEL}. Copilot counts premium requests, kept apart from dollars. Agent time runs from a job's first start to its last finish.`));
    });
    return sec;
  }

  /** The same for one project, for its Overview: weeks, agents, its tasks' time in status, and its tabs' tokens. */
  function projectCard(projectId) {
    const c = el("section", { className: "card lg" });
    const body = el("div", { className: "card-body lg-body" });
    c.append(el("div", { className: "card-head" }, el("h2", { textContent: "Cost and time" })), body);
    body.append(note("Adding it up."));
    fetchInto(`project:${projectId}`, () => window.delphi.ledger.rollup({ projectId, weeks: 8 }), (r, error) => {
      body.textContent = "";
      if (!r) { body.append(note(`The ledger could not be read: ${error ? error.message : "no answer"}.`)); return; }
      if (!r.totals.jobs && !r.tabs.length) { body.append(note("No agent has run on this project in the last eight weeks.")); return; }
      body.append(table([["This week", r.this_week_totals], ["Last week", r.last_week_totals], ["8 weeks", r.totals]]));
      body.append(note(weekOverWeek(r.this_week_totals, r.last_week_to_date)));
      if (r.by_harness.length) body.append(el("div", { className: "lg-sub", textContent: "By agent, last eight weeks (dollars API-equivalent)" }), groupRows(r.by_harness, (g) => g.label || g.key));
      const st = L.statusPhrases(r.status_seconds);
      if (st.length) body.append(el("div", { className: "lg-sub", textContent: `Time in status, all time, of its ${r.agent_tasks === 1 ? "agent task" : `${r.agent_tasks} agent tasks`}` }), note(st.join(", ")));
      for (const t of r.tabs) body.append(note(`${t.harness_label} tabs and chat, all time: ${L.tokens(t.tokens_in + t.tokens_out)} tokens over ${t.sessions} ${t.sessions === 1 ? "session" : "sessions"}. Sessions keep a running total, so they are not split by week.`));
      body.append(note(`Dollars are ${L.COST_LABEL}.`));
    });
    return c;
  }

  /** One task's ledger as a line, for the drawer's Runs card. */
  function taskLine(taskId) {
    const line = el("div", { className: "lg-line" });
    line.title = `Dollars are ${L.COST_LABEL}.`;
    fetchInto(`task:${taskId}`, () => window.delphi.ledger.forTask(taskId), (r, error) => {
      line.textContent = "";
      if (!r) { line.append(missing(error ? `Ledger unavailable: ${error.message}` : "No such task.")); return; }
      line.append(el("span", { className: "lg-line-k", textContent: "Cost and time " }), r.totals.jobs ? `${L.phrases(r.totals).join(", ")}.` : "No agent runs yet.");
      const st = L.statusPhrases(r.status_seconds);
      if (st.length) line.append(" ", el("span", { className: "lg-line-st", textContent: `${st.join(", ")}.` }));
    });
    return line;
  }

  window.DelphiLedger = { runsCard, projectCard, taskLine, forget: () => cache.clear() };
})();
