// Suggest tidy, the window's half: asking a model (or the rules) for
// suggestions on the weekly review's stale and idle work, keeping them, and
// applying the ones a person approves.
//
// The rules about what may be suggested, and how strictly an answer is read,
// are today/tidy.js, which the MCP server's read-only tidy_suggestions shares.
// This file knows what only the window may: which model to ask, and how to
// apply a suggestion. Applying goes through main/weekly.js act(), the same
// write lock, exact-id receipt and Undo as Park and Drop, so a tidy action is
// one undo away and lands in History as the person's, with who suggested it
// in the meta of the Sheet note each one leaves.
//
// The model only ever reads: Claude Code is run with no tools and no MCP
// servers, in an empty folder, and handed a prompt; Ollama is handed the same
// prompt over its HTTP API. What the prompt holds is today/tidy.js payload():
// ids, scrubbed titles, status, ages, subtask counts and project names, and a
// task's description only when "Include task details in Suggest tidy" is on.
//
// Required by main.js, and by tools/tidy_test.js under a plain Node with a
// fake model, so it takes everything it touches as arguments.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const weekly = require("../today/weekly");
const tidy = require("../today/tidy");
const pads = require("../pads");

const MODEL_TIMEOUT_MS = 2 * 60 * 1000;
const OLLAMA = process.env.DELPHI_OLLAMA || "http://127.0.0.1:11434";
// "Local model" is a promise: the prompt stays on this computer. So only a
// loopback Ollama counts, and never one of its cloud-hosted models.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const isLocalOllama = (base) => { try { return LOOPBACK.has(new URL(base).hostname); } catch { return false; } };
const CLOUD_MODEL = /(?:^|[-:])cloud\b/i;

// ---------------------------------------------------------------------------
// The models

/**
 * Claude Code, print mode: no tools, no MCP servers, no user settings or
 * hooks, no saved session, in an empty folder. The prompt goes on stdin, so
 * it is never in the process list for another user to read.
 */
function claudeRunner({ findCli }) {
  return {
    id: "claude", source: tidy.SOURCES.claude, harness: "claude-code",
    async available() { return Boolean(findCli()); },
    run(text) {
      return new Promise((resolve, reject) => {
        const cli = findCli();
        if (!cli) { reject(new Error("Claude Code is not installed.")); return; }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-tidy-"));
        const child = spawn(cli, ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config",
          "--no-session-persistence", "--setting-sources", "local"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        let err = "";
        const tidyUp = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
        let killer = null;
        // SIGTERM, then SIGKILL: a child that ignores the first must not hold the window's one write slot.
        const timer = setTimeout(() => {
          try { child.kill("SIGTERM"); } catch {}
          killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
        }, MODEL_TIMEOUT_MS);
        child.stdout.on("data", (d) => { if (out.length < 1024 * 1024) out += d; });
        child.stderr.on("data", (d) => { if (err.length < 64 * 1024) err += d; });
        child.stdin.on("error", () => {});
        child.stdin.end(text);
        child.on("error", (e) => { clearTimeout(timer); clearTimeout(killer); tidyUp(); reject(e); });
        child.on("close", (code) => {
          clearTimeout(timer);
          clearTimeout(killer);
          tidyUp();
          let parsed = null;
          try { parsed = JSON.parse(out); } catch {}
          if (code !== 0 || !parsed || parsed.is_error) {
            reject(new Error((parsed && parsed.result) || err.trim() || `Claude Code stopped with code ${code}.`));
            return;
          }
          const u = parsed.usage || {};
          resolve({
            text: String(parsed.result || ""),
            tokens_in: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
            tokens_out: u.output_tokens || 0,
            cost_usd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
          });
        });
      });
    },
  };
}

function ollama(base, method, route, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, base);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(url, { method, timeout: timeoutMs, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { if (text.length < 2 * 1024 * 1024) text += d; });
      res.on("end", () => { try { resolve(JSON.parse(text)); } catch { reject(new Error("The local model's answer was not JSON.")); } });
    });
    req.on("timeout", () => req.destroy(new Error("The local model did not answer in time.")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** A local model through Ollama: DELPHI_TIDY_MODEL, else the first one that is not for embeddings. */
function localRunner({ base = OLLAMA } = {}) {
  // Only a found model is remembered: Ollama started after Delphi is found next time.
  let model = null;
  const pick = async () => {
    if (model) return model;
    if (!isLocalOllama(base)) return null;
    try {
      const tags = await ollama(base, "GET", "/api/tags", null, 1500);
      const names = (tags.models || []).map((m) => m.name).filter((n) => !/embed/i.test(n) && !CLOUD_MODEL.test(n));
      const want = process.env.DELPHI_TIDY_MODEL;
      model = want && !CLOUD_MODEL.test(want) ? want : names[0] || null;
    } catch { model = null; }
    return model;
  };
  return {
    id: "local", source: tidy.SOURCES.local, harness: "ollama",
    async available() { return Boolean(await pick()); },
    async run(text) {
      const name = await pick();
      if (!name) throw new Error("No local model is running.");
      const r = await ollama(base, "POST", "/api/generate", { model: name, prompt: text, format: "json", stream: false, options: { num_ctx: 16384 } }, MODEL_TIMEOUT_MS);
      return { text: String(r.response || ""), tokens_in: r.prompt_eval_count ?? null, tokens_out: r.eval_count ?? null, cost_usd: null, model: name };
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * @param db        db.js
 * @param weeklyApi main/weekly.js createWeekly(): act, park, drop, undo, locked
 * @param sheets    the window's Sheet store
 * @param settings  () => the settings object
 * @param models    { claude, local }: runners, replaced by a fake in tests
 * @param clock     () => ms
 */
function createTidy({ db, weeklyApi, sheets, settings = () => ({}), models = null, clock = () => Date.now() }) {
  const sql = db.sqlP;
  const runners = models || { claude: claudeRunner({ findCli: () => require("../ai").findClaudeCli() }), local: localRunner() };
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const today = () => weekly.localDate(clock());

  /** Which model to ask, from the setting: auto tries Claude Code, then a local model, then the rules. */
  async function chooseModel() {
    const want = (settings() || {}).tidySuggester || "auto";
    if (want === "rules") return null;
    const order = want === "claude" ? ["claude"] : want === "local" ? ["local"] : ["claude", "local"];
    for (const id of order) {
      const r = runners[id];
      try { if (r && await r.available()) return r; } catch {}
    }
    return null;
  }

  /** A model run in the cost ledger: a finished, already reviewed job, so it is counted and never waits on anyone. */
  function ledger(runner, items, result, text, startedMs, failed = false) {
    const counts = new Map();
    for (const it of items) if (it.project_id != null) counts.set(it.project_id, (counts.get(it.project_id) || 0) + 1);
    let pid = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    pid = pid ? pid[0] : (sql("SELECT id FROM projects ORDER BY id LIMIT 1", [])[0] || {}).id;
    if (pid == null) return null;
    // Tokens as the model reported them; an estimate, four characters a
    // token, only where it reported none, and the context says which.
    const estimated = result.tokens_in == null || result.tokens_out == null;
    const tin = result.tokens_in != null ? result.tokens_in : Math.ceil(text.length / 4);
    const tout = result.tokens_out != null ? result.tokens_out : Math.ceil(String(result.text || "").length / 4);
    const row = sql(`INSERT INTO handoffs (project_id, to_harness, request, context_json, status, state, kind, source,
                       requested_by, requester_type, approval, started_at, finished_at, updated_at, tokens_in, tokens_out,
                       cost_usd, turns, reviewed_at, reviewed_by)
                     VALUES (:p1, :p2, :p3, :p4, :p10, :p11, 'ask', 'tidy', 'you', 'human', 'not_needed',
                       :p5, :p6, :p6, :p7, :p8, :p9, 1, :p6, 'suggest-tidy') RETURNING id`,
      [Number(pid), runner.harness, `Suggest tidy on ${items.length} ${items.length === 1 ? "task" : "tasks"}`,
       JSON.stringify({ suggest_tidy: true, model: result.model || null, tokens_estimated: estimated }),
       stamp(startedMs), stamp(clock()), tin, tout, result.cost_usd, failed ? "failed" : "ready", failed ? "failed" : "done"])[0];
    return row ? Number(row.id) : null;
  }

  /**
   * Asks for suggestions and keeps them. Earlier open cards are replaced; a
   * suggestion a person denied for the same task and action in the last 30
   * days is left out. A model that fails or answers nonsense falls back to
   * the rules, and the answer says why.
   */
  async function suggest() {
    const details = (settings() || {}).tidyIncludeDetails === true;
    const review = weekly.review(sql, { now: clock() });
    const cand = tidy.candidates(sql, review, { details });
    const runId = crypto.randomBytes(6).toString("hex");
    const dropOpen = () => sql("UPDATE tidy_suggestions SET state = 'dropped', decided_at = :p1 WHERE state = 'open'", [stamp(clock())]);
    if (!cand.items.length) {
      weeklyApi.locked(dropOpen);
      return { run_id: runId, source: null, suggestions: [], note: "Nothing is stale or idle, so there is nothing to tidy." };
    }
    const week = weekly.objectivesWeek(clock());
    const endedNow = () => { try { return Boolean(sql("SELECT 1 FROM weekly_reviews WHERE week = :p1", [week])[0]); } catch { return false; } };
    const endedBefore = endedNow();

    let source = tidy.SOURCES.rule;
    let found = null;
    let fallback = null;
    let rejected = [];
    let jobId = null;
    const runner = await chooseModel();
    if (runner) {
      const text = tidy.prompt(tidy.payload(cand, { details }), { today: today() });
      const started = clock();
      try {
        const result = await runner.run(text);
        // The ledger's own failure never costs the answer.
        try { jobId = ledger(runner, cand.items, result, text, started); } catch (error) { console.error("tidy ledger", error); }
        // Reviewed here means "nobody needs to look at this job": it is the
        // person's own request, answered as cards they decide one by one.
        const checked = tidy.validate(result.text, cand, { sql, today: today() });
        rejected = checked.rejected;
        if (checked.ok) { found = checked.suggestions; source = runner.source; }
        else fallback = `${runner.source} did not answer with suggestions, so these are from the rules.`;
      } catch (error) {
        // A failed run still spent what it sent; it is in the ledger as failed.
        try { jobId = ledger(runner, cand.items, { tokens_in: null, tokens_out: 0, cost_usd: null, text: "" }, text, started, true); } catch {}
        fallback = `${runner.source} could not be asked (${String(error.message || error).slice(0, 200)}), so these are from the rules.`;
      }
    }
    // The rules' output is checked like a model's, so a card that could never
    // be applied (a done task, a twin in no project) is never shown.
    if (!found) found = tidy.validate({ suggestions: tidy.rules(sql, cand) }, cand, { sql, today: today() }).suggestions;
    const kept = found.filter((s) => !tidy.denied(sql, s.task_id, s.action, { now: stamp(clock()) }));

    // A review ended while the model was thinking keeps nothing from it.
    if (!endedBefore && endedNow()) return { run_id: runId, source, suggestions: [], note: "The review was ended while this was being asked, so nothing was kept." };
    weeklyApi.locked(() => {
      dropOpen();
      for (const s of kept) {
        sql(`INSERT INTO tidy_suggestions (run_id, task_id, action, detail, reason, source, created_at)
             VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7) RETURNING id`,
          [runId, s.task_id, s.action, JSON.stringify(s.detail || {}), s.reason || "", source, stamp(clock())]);
      }
    });
    return {
      run_id: runId, source, fallback, job_id: jobId, rejected: rejected.length,
      left_out: found.length - kept.length, suggestions: tidy.open(sql),
    };
  }

  function suggestionOf(id) {
    const s = tidy.open(sql).find((x) => x.id === Number(id));
    if (!s) throw new Error("That suggestion is no longer open: it was decided, or a newer Suggest tidy replaced it.");
    return s;
  }

  /**
   * A suggestion as a person left it after Edit: the same strict check as a
   * model's, against the task as it is now, so an edit cannot name a project
   * that is gone or a date that is not one.
   */
  function edited(s, edits) {
    const t = sql("SELECT id, title, status, project_id FROM tasks WHERE id = :p1", [s.task_id])[0];
    if (!t) throw new Error(`There is no task #${s.task_id} any more.`);
    const c = sql(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done FROM tasks WHERE parent_id = :p1`, [t.id])[0];
    const item = { id: Number(t.id), title: t.title, status: t.status, project_id: t.project_id == null ? null : Number(t.project_id), subtasks: { total: Number(c.total), done: Number(c.done) } };
    const projects = sql("SELECT id, name FROM projects WHERE status != 'archived'", []).map((p) => ({ id: Number(p.id), name: p.name }));
    const e = edits || {};
    const d = s.detail || {};
    const raw = {
      task_id: item.id, action: e.action || s.action, reason: e.reason != null ? e.reason : s.reason,
      project_id: e.project_id != null ? e.project_id : d.project_id, due: e.due != null ? e.due : d.due,
      merge_into: e.merge_into != null ? e.merge_into : d.merge_into, subtasks: e.subtasks != null ? e.subtasks : d.subtasks,
    };
    const checked = tidy.validate({ suggestions: [raw] }, { items: [item], projects }, { sql, today: today() });
    if (!checked.suggestions.length) throw new Error(`That cannot be applied: ${(checked.rejected[0] || {}).why || "it did not check out"}.`);
    const v = checked.suggestions[0];
    // Edited only when something differs from what was suggested.
    const same = v.action === s.action && (v.reason || "") === (s.reason || "") && JSON.stringify(v.detail || {}) === JSON.stringify(s.detail || {});
    return { ...v, edited: !same };
  }

  // Which suggestion each receipt applied, so its Undo can offer the card again.
  const applied = new Map();

  /**
   * Applies one suggestion, as edited, the person's act. Returns weekly's
   * receipt. That the card is still open is checked inside the write lock,
   * and it is marked approved in the same transaction as the change, so a
   * card replaced or decided meanwhile is never applied, and an applied one
   * is never left looking open.
   */
  function approve(id, edits = null) {
    const s = suggestionOf(id);
    const v = edited(s, edits);
    const meta = { tidy: { suggestion_id: s.id, suggested_by: s.source, action: v.action, edited: v.edited } };
    // The model's words in quotes, as its words: the note is the person's
    // act, the reason is what was suggested to them.
    const why = v.reason ? `: "${v.reason.replace(/"/g, "'")}"` : ".";
    const by = `suggested by ${s.source}${v.edited ? ", edited by you" : ""}`;
    const note = (what) => ({ taskId: s.task_id, kind: "note", meta, body: `${what} in the weekly review (${by})${why}` });
    const stillOpen = () => {
      const row = sql("SELECT state FROM tidy_suggestions WHERE id = :p1", [s.id])[0];
      if (!row || row.state !== "open") throw new Error("That suggestion is no longer open: it was decided, or a newer Suggest tidy replaced it.");
    };
    const mark = () => sql("UPDATE tidy_suggestions SET state = 'approved', decided_at = :p1 WHERE id = :p2 AND state = 'open'", [stamp(clock()), s.id]);
    const notDone = (t) => { stillOpen(); if (t.status === "done") throw new Error(`#${t.id} is already done.`); };
    let r;
    switch (v.action) {
      case "park":
        r = weeklyApi.park(s.task_id, { note: note("Parked").body, meta, check: stillOpen, also: mark });
        break;
      case "drop":
        r = weeklyApi.drop(s.task_id, `"${(v.reason || "not finished").replace(/"/g, "'")}" (${by})`, { meta, check: stillOpen, also: mark });
        break;
      case "done":
        r = weeklyApi.act(s.task_id, "done", notDone, (t) => { sheets.append(note("Marked done")); db.updateTask(t.id, { status: "done" }); mark(); });
        break;
      case "move":
        r = weeklyApi.act(s.task_id, "move", stillOpen, (t) => {
          sheets.append(note(`Moved to ${v.detail.project}`));
          db.updateTask(t.id, { project_id: v.detail.project_id });
          mark();
        });
        break;
      case "due":
        r = weeklyApi.act(s.task_id, "due", stillOpen, (t) => { sheets.append(note(`Due date set to ${v.detail.due}`)); db.updateTask(t.id, { due: v.detail.due }); mark(); });
        break;
      case "merge":
        r = weeklyApi.act(s.task_id, "merge", (t) => {
          notDone(t);
          const into = sql("SELECT status FROM tasks WHERE id = :p1", [v.detail.merge_into])[0];
          if (!into || into.status === "done") throw new Error(`#${v.detail.merge_into} is not open, so nothing can be merged into it.`);
        }, (t) => {
          // The link both ways, on both Sheets, so either task leads to the other.
          sheets.append({ ...note(`Merged into #${v.detail.merge_into}`), meta: { ...meta, merged_into: v.detail.merge_into } });
          sheets.append({ taskId: v.detail.merge_into, kind: "note", meta: { ...meta, merged_from: t.id },
            body: `#${t.id} ${String(t.title).replace(/\s+/g, " ").trim()} was merged into this in the weekly review (${by})${why}` });
          db.updateTask(t.id, { status: "done" });
          mark();
        });
        break;
      case "split":
        r = weeklyApi.act(s.task_id, "split", notDone, (t) => {
          splitInto(t.id, v.detail.subtasks);
          sheets.append(note(`Split into ${v.detail.subtasks.length} subtasks`));
          mark();
        });
        break;
      default:
        throw new Error(`Unknown action ${v.action}.`);
    }
    applied.set(r.receipt, s.id);
    return { ...r, suggestion_id: s.id, action: v.action };
  }

  /**
   * Subtasks under a task. In its pad when it came from one, as indented
   * lines under its own, so the pad stays the source and derives them; on the
   * board otherwise.
   */
  function splitInto(taskId, titles) {
    const t = sql("SELECT id, pad_id FROM tasks WHERE id = :p1", [taskId])[0];
    const pad = t && t.pad_id != null ? sql("SELECT id, body, derives_tasks FROM scratchpads WHERE id = :p1", [t.pad_id])[0] : null;
    if (pad && Number(pad.derives_tasks) === 1) {
      const entries = pads.parse(pad.body);
      const at = entries.findIndex((e) => e.taskId === Number(taskId));
      if (at !== -1) {
        const lines = String(pad.body).split("\n");
        const me = entries[at];
        let last = me.index;
        for (const e of entries.slice(at + 1)) { if (e.depth > me.depth) last = e.index; else break; }
        const indent = `${me.indent}  `;
        const clean = (title) => String(title).replace(/<!--[\s\S]*?-->/g, "").replace(/[\r\n]+/g, " ").trim();
        lines.splice(last + 1, 0, ...titles.map((title) => `${indent}${me.marker} [ ] ${clean(title)}`));
        db.writeScratchpad(pad.id, { body: lines.join("\n"), author: "you" });
        return;
      }
    }
    for (const title of titles) db.createTask({ parentId: taskId, title });
  }

  /** A denial, remembered for 30 days for this task and action. */
  function deny(id) {
    const s = suggestionOf(id);
    weeklyApi.locked(() => sql("UPDATE tidy_suggestions SET state = 'denied', decided_at = :p1 WHERE id = :p2 AND state = 'open'", [stamp(clock()), s.id]));
    return { id: s.id, denied: true };
  }

  /** Undo of an applied suggestion: weekly's Undo, then the card is offered again. */
  function undo({ receipt }) {
    const out = weeklyApi.undo({ receipt });
    const sid = applied.get(Number(receipt));
    let reopened = false;
    if (sid != null) {
      // Offered again, unless a newer run already offers the same thing.
      reopened = weeklyApi.locked(() => sql(`UPDATE tidy_suggestions SET state = 'open', decided_at = NULL WHERE id = :p1 AND state = 'approved'
                                    AND NOT EXISTS (SELECT 1 FROM tidy_suggestions n JOIN tidy_suggestions o ON o.id = :p1
                                                     WHERE n.state = 'open' AND n.task_id = o.task_id AND n.action = o.action) RETURNING id`, [sid]).length > 0);
      applied.delete(Number(receipt));
    }
    return { ...out, suggestion_id: sid ?? null, reopened };
  }

  return { suggest, list: () => tidy.open(sql), approve, deny, undo, chooseModel };
}

function register(handle, { tidy: t }) {
  handle("tidy:suggest", () => t.suggest());
  handle("tidy:list", () => t.list());
  handle("tidy:approve", (id, edits) => t.approve(id, edits || null));
  handle("tidy:deny", (id) => t.deny(id));
  handle("tidy:undo", (what) => t.undo(what || {}));
}

module.exports = { createTidy, register, claudeRunner, localRunner };
