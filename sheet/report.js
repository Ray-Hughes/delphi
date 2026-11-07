/**
 * A pull request description and a status report, written from the Sheet.
 *
 * A description written from the diff says what changed. The Sheet holds why:
 * the questions that were asked, what was chosen and what was turned down, the
 * checks that passed. So this reads those and writes Markdown a person edits
 * before anything is posted. Nothing here posts, and nothing here runs git; the
 * diff stat is handed in by whoever can read the folder (workbench/).
 *
 * Shared by the app and the MCP server, the same pattern as sheet/store.js: SQL
 * text and rules, handed a sql(query, params) function in the server's :p1
 * style, one statement per call, nothing that needs a transaction.
 *
 * What is left out matters more than what goes in, because the text goes to
 * GitHub and the owner works somewhere a stray detail is a real problem:
 *
 * - An entry whose meta says private is never read into either report, and a
 *   decision whose question is private goes with it, since an answer without
 *   its question is still the question's content.
 * - A run is its command, whether it passed and how long it took. Never its
 *   output, its log or its folder: those are what a person did not look at.
 * - HTML comments are dropped from everything copied in. The preview hides
 *   them and so does GitHub, so they would be text nobody saw being sent.
 */

const ledgerCore = require("../ledger/ledger");

// GitHub refuses a body over 65536 characters. Said before gh is asked, so the
// refusal is a sentence rather than an API error.
const MAX_BODY = 65536;
// Enough files to see the shape of a change; the rest is a count.
const MAX_FILES = 25;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A whole number id or a sentence. Only an integer or a string of digits, the
 * rule sheet/store.js idOf keeps: Number() would take "1e0" and true as 1.
 */
function idOf(value, what) {
  const ok = (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    || (typeof value === "string" && /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)) && Number(value) > 0);
  if (!ok) throw new Error(`${what} must be a whole number, got '${value}'.`);
  return Number(value);
}

// Meta that is there but cannot be read. Not {}: an entry whose meta nobody
// can read might be saying it is private.
const UNREADABLE = Object.freeze({ unreadable: true });

function metaOf(row) {
  if (!row || row.meta === null || row.meta === undefined || row.meta === "") return {};
  if (typeof row.meta === "object") return row.meta || {};
  try {
    const parsed = JSON.parse(row.meta);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

/**
 * Whether an entry is to be kept out. Any spelling of yes counts, in any case,
 * and so does meta that cannot be read: leaving an entry out is the safe
 * mistake, and the person can add it back by hand.
 */
function isPrivate(row) {
  const meta = metaOf(row);
  if (meta === UNREADABLE) return true;
  const flag = meta.private;
  if (flag === true || (typeof flag === "number" && flag !== 0)) return true;
  return typeof flag === "string" && ["1", "true", "yes", "on", "y"].includes(flag.trim().toLowerCase());
}

/**
 * Text as it may go out: comments gone (again until none are left, so one
 * hidden inside another cannot leave an opener behind), line endings plain,
 * no control characters, ends trimmed.
 */
function clean(text) {
  let out = String(text == null ? "" : text);
  for (let before = null; before !== out;) {
    before = out;
    out = out.replace(/<!--[\s\S]*?(-->|$)/g, "");
  }
  // Control characters other than tab and newline go too. Nothing on a Sheet
  // needs them, and printed by the command line before its "open the pull
  // request?" question, an escape sequence could redraw what the person reads.
  return out.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").trim();
}

/**
 * An @handle in code, so a pull request does not notify whoever an agent
 * happened to name on a Sheet. An email address is left alone: its @ follows
 * a word character.
 */
const quiet = (text) => text
  .replace(/(^|[^\w`@])@([A-Za-z0-9][\w-]*(?:\/[\w-]+)?)/g, "$1`@$2`")
  // #123 and owner/repo#123 too: GitHub links them and leaves a "mentioned
  // this" on that issue, which is somebody else's piece of work.
  .replace(/(^|[^\w`#&])((?:[\w.-]+\/[\w.-]+)?#\d+)\b/g, "$1`$2`");

/** One line, for a list item: a body's line breaks would end the item early. */
const oneLine = (text) => quiet(clean(text).replace(/\s+/g, " ").trim());

/**
 * A command with what looks like a credential taken out. The person sees the
 * command in the preview before anything is sent, but a token pasted into a
 * curl line weeks ago is easy to read past, so the obvious shapes go first:
 * an Authorization header or one named for a key, token or cookie, a
 * NAME=value whose name says it is secret, a --password or --token option,
 * curl's -u user:password, a URL with a password in it, and GitHub's own token
 * prefixes. A shape not listed here still goes out, which is why the person
 * reads the preview before anything is sent.
 */
const SECRET_NAME = /token|secret|passw(or)?d|pass$|^pass|api_?key|auth|credential|private_?key/i;

function redact(command) {
  return String(command)
    .replace(/((?:proxy-)?authorization:\s*)(?:bearer\s+|token\s+|basic\s+)?[^\s'"]+/gi, "$1[redacted]")
    .replace(/((?:x-[\w-]*)?(?:api-?key|token|secret|cookie|session)[\w-]*:\s*)[^\s'"]+/gi, "$1[redacted]")
    .replace(/((?:^|\s)(?:-u|--user)(?:=|\s+)['"]?[^\s:'"]+:)[^\s'"]+/g, "$1[redacted]")
    .replace(/\b([A-Za-z_]\w*)=("[^"]*"|'[^']*'|\S+)/g, (all, name) => (SECRET_NAME.test(name) ? `${name}=[redacted]` : all))
    .replace(/(--?(?:password|passwd|token|secret|api-?key)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]")
    .replace(/(\b[a-z][\w+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1[redacted]@")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]");
}

/** The first paragraph, for the Summary: a long detail is the task's, not the PR's. */
function firstParagraph(text) {
  const body = clean(text);
  if (!body) return "";
  let para = body.split(/\n[ \t]*\n/)[0].trim();
  // A fence opened in the first paragraph and closed after it would turn
  // every section below into code. Cut at an unclosed fence instead.
  const fences = para.split("\n").map((line, i) => [i, /^\s*(```|~~~)/.test(line)]).filter(([, f]) => f);
  if (fences.length % 2) para = para.split("\n").slice(0, fences[fences.length - 1][0]).join("\n").trim();
  return quiet(para);
}

/** Backticks that cannot be closed by what is inside them. */
function code(text) {
  const t = clean(text).replace(/\s+/g, " ").trim();
  const longest = Math.max(0, ...(t.match(/`+/g) || []).map((m) => m.length));
  const fence = "`".repeat(longest + 1);
  return longest ? `${fence} ${t} ${fence}` : `${fence}${t}${fence}`;
}

function optionsOf(ask) {
  const list = metaOf(ask).options;
  return Array.isArray(list) ? list.filter((o) => o && o.key != null) : [];
}

/**
 * A decision in words, with its question. The alternatives are what the decide
 * entry says was rejected when it says so (meta.rejected), and otherwise the
 * options the question offered that were not chosen.
 */
function decisionLines(ask, decision) {
  const meta = metaOf(decision);
  const options = optionsOf(ask);
  const lines = String(decision.body || "").split("\n");
  const key = String(meta.choice || lines[0] || "").trim().toLowerCase();
  const chosen = options.find((o) => String(o.key).toLowerCase() === key);
  const label = oneLine(chosen ? chosen.label : meta.label || key);
  const why = oneLine(lines.slice(1).join(" "));
  const question = ask ? oneLine(ask.body) : "";
  let rejected = Array.isArray(meta.rejected) ? meta.rejected : null;
  rejected = rejected
    ? rejected.map((r) => oneLine(r && typeof r === "object" ? [r.label, r.why].filter(Boolean).join(": ") : r)).filter(Boolean)
    : options.filter((o) => o !== chosen).map((o) => oneLine(o.label)).filter(Boolean);
  const head = question ? `**${question}** ${label}.` : `**Decided:** ${label}.`;
  const out = [`- ${head}${why ? ` ${why}` : ""}`];
  if (rejected.length) out.push(`  Not chosen: ${rejected.join("; ")}.`);
  return out;
}

/**
 * What the Sheet says, in parts: decisions with their questions, open
 * questions, and the commands whose latest run passed. Latest, because a
 * command that passed on Monday and failed on Tuesday has not passed.
 */
function readSheet(rows) {
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const hidden = new Set(rows.filter(isPrivate).map((r) => Number(r.id)));
  const answered = new Set();
  const decisions = [];
  for (const r of rows) {
    if (r.kind !== "decide") continue;
    const ask = r.ref_id == null ? null : byId.get(Number(r.ref_id)) || null;
    if (ask) answered.add(Number(ask.id));
    if (hidden.has(Number(r.id)) || (ask && hidden.has(Number(ask.id)))) continue;
    decisions.push({ ask, decision: r });
  }
  const open = rows.filter((r) => r.kind === "ask" && !answered.has(Number(r.id)) && !hidden.has(Number(r.id)));
  const latest = new Map();
  for (const r of rows) {
    if (r.kind !== "run") continue;
    const meta = metaOf(r);
    // A run still going, or one lost with its runner, has no result to report.
    if (meta.state !== "ok" && meta.state !== "fail") continue;
    const command = redact(clean(r.body).replace(/\s+/g, " ").trim());
    if (!command) continue;
    // A private run hides its command but still counts as the latest, so an
    // earlier public pass cannot stand in for a private failure.
    latest.set(command, { row: r, meta, hidden: hidden.has(Number(r.id)) });
  }
  const passed = [...latest.entries()]
    .filter(([, v]) => v.meta.state === "ok" && !v.hidden)
    .map(([command, v]) => ({ command, ms: Number.isFinite(Number(v.meta.dur_ms)) ? Number(v.meta.dur_ms) : null, task_id: v.row.task_id }));
  return { decisions, open, passed };
}

/** The diff stat as Markdown, from a string or { files: [{ path, added, deleted }] }. */
function changesLines(stat) {
  if (!stat) return [];
  if (typeof stat === "string") {
    const text = clean(stat);
    return text ? ["```", text.replace(/```/g, "'''"), "```"] : [];
  }
  const files = Array.isArray(stat.files) ? stat.files : [];
  if (!files.length) return [];
  const sum = (k) => files.reduce((n, f) => n + (Number.isFinite(Number(f[k])) ? Number(f[k]) : 0), 0);
  const out = [`${files.length} ${files.length === 1 ? "file" : "files"} changed, +${sum("added")} -${sum("deleted")}.`, ""];
  for (const f of files.slice(0, MAX_FILES)) {
    const binary = f.added == null && f.deleted == null;
    out.push(`- ${code(f.path)} ${binary ? "(binary)" : `+${Number(f.added) || 0} -${Number(f.deleted) || 0}`}`);
  }
  if (files.length > MAX_FILES) out.push(`- and ${files.length - MAX_FILES} more`);
  return out;
}

/** The ledger's totals as one line, always called an estimate, or null when it has nothing. */
function costLine(totals) {
  if (!totals || !totals.runs) return null;
  return `Estimate from Delphi's ledger, not a bill: ${ledgerCore.phrases(totals).join(", ")}. Dollars are ${ledgerCore.COST_LABEL}.`;
}

const section = (title, lines) => (lines.length ? [`## ${title}`, "", ...lines, ""] : []);
const checkLine = (p) => `- ${code(p.command)} passed${p.ms == null ? "" : ` in ${ledgerCore.duration(p.ms / 1000)}`}`;

function makeReport({ sql } = {}) {
  if (typeof sql !== "function") throw new Error("makeReport needs a sql(query, params) function.");
  const ledger = ledgerCore.makeLedger({ sql });

  // A failed read of the ledger costs the Cost section, never the report.
  const safely = (fn) => { try { return fn(); } catch { return null; } };

  /**
   * The pull request description for a task, as Markdown. opts.diffStat is
   * the caller's, since git is not read here.
   */
  function prDescription(taskId, { diffStat = null } = {}) {
    const id = idOf(taskId, "task_id");
    const task = sql("SELECT id, title, detail FROM tasks WHERE id = :p1", [id])[0];
    if (!task) throw new Error(`No task ${id}.`);
    const rows = sql(`SELECT id, task_id, kind, body, meta, ref_id FROM comments
                       WHERE task_id = :p1 AND kind IN ('ask', 'decide', 'run') ORDER BY id`, [id]);
    const { decisions, open, passed } = readSheet(rows);

    const summary = [oneLine(task.title)];
    const para = firstParagraph(task.detail);
    if (para) summary.push("", para);
    if (!decisions.length && !open.length && !passed.length) {
      summary.push("", "Nothing was decided, asked or checked on this task's Sheet yet.");
    }
    const totals = safely(() => { const t = ledger.forTask(id); return t ? t.totals : null; });
    const cost = costLine(totals);
    const out = [
      ...section("Summary", summary),
      ...section("Why", decisions.flatMap((d) => decisionLines(d.ask, d.decision))),
      ...section("Checks", passed.map(checkLine)),
      ...section("Open questions", open.map((a) => {
        const opts = optionsOf(a).map((o) => oneLine(o.label)).filter(Boolean);
        return `- ${oneLine(a.body)}${opts.length ? ` (${opts.join(" / ")})` : ""}`;
      })),
      ...section("Changes", changesLines(diffStat)),
      ...section("Cost (estimate)", cost ? [cost] : []),
      // No "#": in a pull request #623 is a link to the repository's own
      // issue 623, which is some other piece of work.
      `From Delphi task ${id}.`,
    ];
    return out.join("\n").trim() + "\n";
  }

  /**
   * A project's status over [from, to], as Markdown. Both are local calendar
   * days (YYYY-MM-DD) and both are included; the default is the last seven
   * days, today among them.
   */
  function statusReport(projectId, { from = null, to = null } = {}) {
    const pid = idOf(projectId, "project_id");
    for (const [name, v] of [["from", from], ["to", to]]) {
      if (v != null && v !== "" && !DAY.test(String(v))) throw new Error(`${name} must be a date like 2026-11-06, got '${v}'.`);
    }
    // The window in UTC, worked out by the database, which stores UTC and
    // knows the local zone the same way the ledger does.
    const w = sql(`SELECT COALESCE(:p1, date('now', 'localtime', '-6 days')) AS d_from,
                          COALESCE(:p2, date('now', 'localtime')) AS d_to`, [from || null, to || null])[0];
    // date() of a day that does not exist (2026-13-45) is NULL, and a NULL
    // window would quietly match nothing.
    const u = sql(`SELECT date(:p1) AS d_from, date(:p2) AS d_to,
                          datetime(:p1, 'utc') AS since, datetime(:p2, '+1 day', 'utc') AS until`, [w.d_from, w.d_to])[0];
    if (!u.d_from || u.d_from !== w.d_from) throw new Error(`from must be a real date, got '${w.d_from}'.`);
    if (!u.d_to || u.d_to !== w.d_to) throw new Error(`to must be a real date, got '${w.d_to}'.`);
    if (w.d_from > w.d_to) throw new Error(`from (${w.d_from}) is after to (${w.d_to}).`);
    const project = sql("SELECT id, name FROM projects WHERE id = :p1", [pid])[0];
    if (!project) throw new Error(`No project ${pid}.`);

    const tasks = sql(`SELECT id, title, status, completed_at FROM tasks WHERE project_id = :p1 ORDER BY id`, [pid]);
    const title = new Map(tasks.map((t) => [Number(t.id), oneLine(t.title)]));
    const inRange = (stamp) => stamp != null && stamp >= u.since && stamp < u.until;
    const done = tasks.filter((t) => t.status === "done" && inRange(t.completed_at));
    const doing = tasks.filter((t) => t.status === "doing");
    const blocked = tasks.filter((t) => t.status === "blocked");

    // Every ask, decide and run on the project's tasks, then cut to the window
    // here: an open question asked last month is still open now, and a
    // decision's question may be older than the window.
    const rows = sql(`SELECT c.id, c.task_id, c.kind, c.body, c.meta, c.ref_id, c.created_at
                        FROM comments c JOIN tasks t ON t.id = c.task_id
                       WHERE t.project_id = :p1 AND c.kind IN ('ask', 'decide', 'run') AND c.created_at < :p2
                       ORDER BY c.id`, [pid, u.until]);
    const sheet = readSheet(rows);
    const ref = (taskId) => `#${taskId} ${title.get(Number(taskId)) || ""}`.trim();
    const decided = sheet.decisions.filter((d) => inRange(d.decision.created_at));
    // Finished runs only: one still going has neither passed nor failed.
    const ran = rows.filter((r) => r.kind === "run" && inRange(r.created_at) && !isPrivate(r) && ["ok", "fail"].includes(metaOf(r).state));
    const okRuns = ran.filter((r) => metaOf(r).state === "ok").length;
    const failRuns = ran.filter((r) => metaOf(r).state === "fail").length;
    const openDone = new Set(tasks.filter((t) => t.status === "done").map((t) => Number(t.id)));
    const open = sheet.open.filter((a) => !openDone.has(Number(a.task_id)));
    const cost = costLine(safely(() => ledger.between({ since: u.since, until: u.until, projectId: pid }).totals));

    const taskLine = (t) => `- ${ref(t.id)}`;
    const out = [
      `# ${oneLine(project.name)}: status, ${w.d_from} to ${w.d_to}`,
      "",
      ...section("Done", done.map(taskLine)),
      // Now, not over the range: a task does not record when it was last in
      // progress, and saying it was then would be a guess.
      ...section("In progress now", doing.map(taskLine)),
      ...section("Blocked now", blocked.map(taskLine)),
      ...section("Decisions", decided.flatMap((d) => {
        const [head, ...rest] = decisionLines(d.ask, d.decision);
        return [`${head} (${ref(d.decision.task_id)})`, ...rest];
      })),
      ...section("Checks", ran.length ? [`${okRuns} ${okRuns === 1 ? "run" : "runs"} passed and ${failRuns} failed, across ${new Set(ran.map((r) => r.task_id)).size} ${new Set(ran.map((r) => r.task_id)).size === 1 ? "task" : "tasks"}.`] : []),
      ...section("Open questions", open.map((a) => `- ${oneLine(a.body)} (${ref(a.task_id)})`)),
      ...section("Cost (estimate)", cost ? [cost] : []),
    ];
    if (out.length === 2) out.push("Nothing was finished, started, decided or run in this project in these dates.");
    return out.join("\n").trim() + "\n";
  }

  return { prDescription, statusReport };
}

/** A body for gh, or a sentence saying why not. null means none was given. */
function checkBody(body) {
  if (body === null || body === undefined) return null;
  if (typeof body !== "string") throw new Error("body must be text.");
  if (body.length > MAX_BODY) throw new Error(`The description is ${body.length} characters; GitHub takes at most ${MAX_BODY}. Shorten it.`);
  return body;
}

module.exports = { MAX_BODY, makeReport, checkBody, isPrivate, clean, firstParagraph, redact };
