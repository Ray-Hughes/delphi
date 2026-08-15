#!/usr/bin/env node
/**
 * MCP server over the brain.
 *
 * Speaks JSON-RPC 2.0 on stdin and stdout, which is the stdio transport every
 * MCP client supports. That is what lets Claude Code and Copilot agent mode use
 * the same store: neither is talking to the other, they are both talking to this.
 *
 * Written against the protocol directly rather than an SDK so it has no
 * dependencies. It runs under whatever Node the editor launched it with, which
 * is the awkward part: that Node may or may not have node:sqlite, so there are
 * two ways in and the better one is tried first. See openDatabase below.
 */

const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

/**
 * Finds the database.
 *
 * A checkout keeps it beside the source, an installed copy keeps it in the
 * per-user data directory, and the same server file is used by both: from a
 * checkout it is agent/mcp_server.js, and from an installed app it is the copy in
 * Resources. Looking for the neighbour first is what tells the two apart, since
 * only a checkout has one. This duplicates paths.js on purpose, because that file
 * ends up inside app.asar and a plain Node process cannot read in there.
 */
function findDatabase() {
  if (process.env.DELPHI_DB) return path.resolve(process.env.DELPHI_DB);

  const beside = path.join(__dirname, "..", "delphi.db");
  if (fs.existsSync(beside)) return beside;

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Delphi", "delphi.db");
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "Delphi", "delphi.db");
}

const DB = findDatabase();
const ACTOR = process.env.DELPHI_ACTOR || "agent";

/**
 * Finds the sqlite3 binary, for when node:sqlite is not available.
 *
 * An MCP client launches this without a login shell, so PATH may not carry the
 * one the user sees in a terminal. The system copy on macOS is checked first
 * because it is always present and always adequate here. Windows ships no sqlite3
 * at all, which is why this is now the fallback rather than the only route.
 */
function findSqlite() {
  const candidates = [
    process.env.DELPHI_SQLITE,
    ...(process.platform === "win32"
      ? [
          path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "sqlite3.exe"),
          "C:\\ProgramData\\chocolatey\\bin\\sqlite3.exe",
          "sqlite3.exe",
        ]
      : ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"]),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return process.platform === "win32" ? "sqlite3.exe" : "sqlite3";
}

/**
 * Opens the database the best way this Node allows.
 *
 * node:sqlite is preferred wherever it exists. It is in process, so there is no
 * temporary file and no subprocess per query, and it is the only route that works
 * on Windows out of the box: Windows ships no sqlite3 command, so a server that
 * can only shell out is a server that cannot start there.
 *
 * It is not always there. It landed in Node 22.5 behind a flag and only became
 * available unflagged later, so requiring it throws on plenty of the versions an
 * editor might be running. That throw is the whole test.
 */
function openDatabase() {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const handle = new DatabaseSync(DB);
    // Wait for another writer rather than failing on contention. Two agents
    // claiming from the same queue at the same moment is the normal case here,
    // not the edge one.
    handle.exec("PRAGMA busy_timeout = 5000");
    return {
      kind: "node:sqlite",
      query(statement) {
        // all() rather than run() for everything. It returns rows for a SELECT
        // and an empty list for a write, which is exactly the shape the shelling
        // out version produced, so nothing downstream has to know which is in use.
        return handle.prepare(statement).all();
      },
    };
  } catch {
    const binary = findSqlite();
    return {
      kind: binary,
      query(statement) {
        // Written to a file rather than bound through ".parameter set", which is
        // a dot command and therefore line-oriented: a note body containing a
        // newline silently breaks it halfway through. A quoted SQL literal inside
        // a script file spans lines happily.
        // The sqlite3 binary has no busy timeout by default: a locked database
        // is an immediate error rather than a wait, and two agents claiming at
        // once hit exactly that.
        //
        // The dot command rather than the pragma. PRAGMA busy_timeout prints the
        // value it set, and that line lands in stdout ahead of the results,
        // where it makes the JSON unparseable and every query look empty.
        const lines = [".timeout 5000", ".mode json", ".headers on", statement];
        const file = path.join(os.tmpdir(), `delphi-${process.pid}-${Date.now()}.sql`);
        fs.writeFileSync(file, lines.join("\n"));
        try {
          const out = execFileSync(binary, [DB], {
            input: `.read ${file}\n`,
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
          });
          const trimmed = out.trim();
          if (!trimmed) return [];
          try {
            return JSON.parse(trimmed);
          } catch {
            return [];
          }
        } finally {
          try { fs.unlinkSync(file); } catch {}
        }
      },
    };
  }
}

const DATABASE = openDatabase();

// --- database ---------------------------------------------------------------

/**
 * Renders one value as a SQL literal.
 *
 * Doubling the single quote is the whole of the escaping SQLite needs: unlike
 * MySQL it gives no special meaning to a backslash inside a string literal, so
 * there is no second escape to get wrong.
 */
function literal(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function sql(query, params = []) {
  // Values are substituted into the statement rather than bound. Both routes take
  // the statement as text, so doing it once here keeps them interchangeable.
  //
  // Placeholders are replaced highest-numbered first so :p10 is not eaten by the
  // pattern for :p1.
  let statement = query;
  params.forEach((_, i) => {
    const index = params.length - 1 - i;
    statement = statement.replaceAll(`:p${index + 1}`, literal(params[index]));
  });

  return DATABASE.query(statement.endsWith(";") ? statement : statement + ";");
}

const audit = (action, entity, entityId, summary, label) =>
  sql(
    `INSERT INTO audit (action, entity, entity_id, summary, label)
     VALUES (:p1, :p2, :p3, :p4, :p5)`,
    [action, entity, entityId, `${summary} (by ${ACTOR})`, label]
  );

// --- tools ------------------------------------------------------------------

const TOOLS = {
  list_projects: {
    description:
      "List every project with its open task count. Call this first to find the right project_id.",
    schema: { type: "object", properties: {} },
    run: () =>
      sql(`SELECT p.id, p.key, p.name, p.summary, p.status,
                  (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status != 'done') AS open_tasks,
                  (SELECT COUNT(*) FROM notes n WHERE n.project_id = p.id) AS notes
           FROM projects p WHERE p.status != 'archived' ORDER BY p.sort_order`),
  },

  add_project: {
    description:
      "Create a project. Use this when work does not belong to any existing project rather than filing it under General, so its tasks and notes have a home. Call list_projects first to check one does not already exist.",
    schema: {
      type: "object",
      required: ["key", "name"],
      properties: {
        key: { type: "string", description: "Short slug, e.g. co-hearing-address" },
        name: { type: "string" },
        summary: { type: "string", description: "One line: what this project is" },
        colour: { type: "string", description: "Accent for the sidebar dot, e.g. #4A90D9" },
      },
    },
    run: (a) => {
      // The slug is the one column with a uniqueness constraint, so it is
      // normalised here rather than trusting the caller to pass a clean one.
      const key = String(a.key).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (!key) throw new Error("key must contain at least one alphanumeric character");

      const clash = sql("SELECT id, key, name FROM projects WHERE key = :p1", [key])[0];
      if (clash) throw new Error(`Project ${clash.id} already uses key '${key}' (${clash.name})`);

      // Sit above General, which is pinned at 99 as the catch-all. New projects
      // slot in behind the last real one so the sidebar keeps its order.
      const below = sql("SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM projects WHERE sort_order < 99")[0];
      sql(
        `INSERT INTO projects (key, name, summary, colour, sort_order)
         VALUES (:p1, :p2, :p3, :p4, :p5)`,
        [key, a.name, a.summary ?? null, a.colour ?? null, below.next]
      );
      const row = sql("SELECT id, key, name, summary, status, sort_order FROM projects WHERE key = :p1", [key])[0];
      audit("create", "project", row.id, "created", row.name);
      return row;
    },
  },

  list_tasks: {
    description:
      "List tasks. Omit project_id for every project. Done tasks are excluded unless include_done is true.",
    schema: {
      type: "object",
      properties: {
        project_id: { type: "number" },
        include_done: { type: "boolean" },
        status: { type: "string", enum: ["todo", "doing", "blocked", "done"] },
      },
    },
    run: (a) => {
      const where = [];
      const params = [];
      if (a.project_id != null) { params.push(a.project_id); where.push(`t.project_id = :p${params.length}`); }
      if (a.status) { params.push(a.status); where.push(`t.status = :p${params.length}`); }
      else if (!a.include_done) where.push("t.status != 'done'");
      return sql(
        `SELECT t.id, t.title, t.detail, t.status, t.priority, t.due, t.ref, p.name AS project
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY CASE t.status WHEN 'doing' THEN 0 WHEN 'blocked' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END,
                  CASE t.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, t.id DESC
         LIMIT 200`,
        params
      );
    },
  },

  add_task: {
    description:
      "Create a task. Use this whenever work is identified that will not be finished immediately, without waiting to be asked.",
    schema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        project_id: { type: "number" },
        detail: { type: "string", description: "Why it matters and how to verify it" },
        priority: { type: "string", enum: ["high", "med", "low"] },
        due: { type: "string", description: "YYYY-MM-DD" },
        ref: { type: "string", description: "Ticket or pull request reference" },
        parent_id: { type: "number", description: "Make this a subtask of that task" },
      },
    },
    run: (a) => {
      // A subtask lives in its parent's project whatever was passed, because a
      // subtask filed somewhere else is not a subtask.
      let projectId = a.project_id ?? null;
      if (a.parent_id) {
        const parent = sql("SELECT project_id FROM tasks WHERE id = :p1", [a.parent_id])[0];
        if (!parent) throw new Error(`No task ${a.parent_id} to hang this from`);
        projectId = parent.project_id;
      }
      sql(
        `INSERT INTO tasks (project_id, title, detail, priority, due, ref, parent_id, source)
         VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7, :p8)`,
        [projectId, a.title, a.detail ?? null, a.priority || "med", a.due ?? null, a.ref ?? null, a.parent_id ?? null, ACTOR]
      );
      const row = sql("SELECT id, title FROM tasks ORDER BY id DESC LIMIT 1")[0];
      sql("INSERT INTO status_events (task_id, status, actor) VALUES (:p1, 'todo', :p2)", [row.id, ACTOR]);
      audit("create", "task", row.id, "created", row.title);
      return row;
    },
  },

  update_task: {
    description:
      "Change a task. Set status to done when work is finished, blocked when waiting on someone.",
    schema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "number" },
        title: { type: "string" },
        detail: { type: "string" },
        status: { type: "string", enum: ["todo", "doing", "blocked", "done"] },
        priority: { type: "string", enum: ["high", "med", "low"] },
        due: { type: "string" },
        project_id: { type: "number" },
        assignee: { type: "string", description: "Who is holding this. Your own actor name if you are taking it." },
      },
    },
    run: (a) => {
      const before = sql("SELECT * FROM tasks WHERE id = :p1", [a.id])[0];
      if (!before) throw new Error(`No task ${a.id}`);
      const fields = ["title", "detail", "status", "priority", "due", "project_id", "assignee"].filter((f) => a[f] !== undefined);
      if (!fields.length) return before;
      const params = fields.map((f) => a[f]);
      const sets = fields.map((f, i) => `${f} = :p${i + 1}`).join(", ");
      params.push(a.id);
      const done = a.status === "done" ? ", completed_at = datetime('now')" : a.status ? ", completed_at = NULL" : "";
      sql(`UPDATE tasks SET ${sets}, updated_at = datetime('now')${done} WHERE id = :p${params.length}`, params);
      const after = sql("SELECT * FROM tasks WHERE id = :p1", [a.id])[0];
      // The timeline should not be able to tell whether a person or an agent
      // moved a task, only who it was. Recorded here for the same reason the app
      // records it: so the history cannot disagree with the column.
      if (after.status !== before.status) {
        sql("INSERT INTO status_events (task_id, status, actor) VALUES (:p1, :p2, :p3)",
            [a.id, after.status, ACTOR]);
      }
      audit("update", "task", a.id, a.status ? `status to ${a.status}` : "updated", after.title);
      return after;
    },
  },

  queue_next: {
    description:
      "Claim the next piece of work from the queue and get everything needed to do it. Call this when you are ready to work rather than waiting to be given something. Returns null when the queue is empty, which means there is nothing to do and you should stop rather than invent work.",
    schema: {
      type: "object",
      properties: {
        queue: { type: "string", description: "Which pool. Defaults to ready." },
        minutes: { type: "number", description: "How long to hold it before the claim lapses. Defaults to 30." },
      },
    },
    run: (a) => {
      const queue = a.queue || "ready";
      const minutes = a.minutes || 30;
      // One statement, because two with a gap between them is exactly where two
      // agents both win. An expired claim counts as unclaimed, so a task held by
      // an agent that died comes back on its own.
      const claimed = sql(
        `UPDATE tasks
            SET claimed_by = :p1,
                claim_expires = datetime('now', '+' || :p2 || ' minutes'),
                status = CASE WHEN status = 'todo' THEN 'doing' ELSE status END,
                updated_at = datetime('now')
          WHERE id = (
            SELECT id FROM tasks
             WHERE queue = :p3
               -- Blocked work is not available work: something outside the task
               -- is being waited on, and an agent given it can only hand it back.
               AND status NOT IN ('done', 'blocked')
               AND (claimed_by IS NULL OR claim_expires < datetime('now'))
             ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, id
             LIMIT 1)
          RETURNING *`,
        [ACTOR, minutes, queue]
      )[0];

      if (!claimed) return { claimed: null, message: `Nothing waiting in the ${queue} queue.` };

      // Only when the claim moved it. Nothing but todo is claimable, so this is
      // always a real transition rather than a repeat of the current status.
      if (claimed.status === "doing") {
        sql("INSERT INTO status_events (task_id, status, actor) VALUES (:p1, :p2, :p3)",
            [claimed.id, claimed.status, ACTOR]);
      }
      audit("update", "task", claimed.id, `claimed by ${ACTOR}`, claimed.title);

      return {
        claimed: claimed.id,
        expires: claimed.claim_expires,
        task: claimed,
        project: claimed.project_id
          ? sql("SELECT id, key, name FROM projects WHERE id = :p1", [claimed.project_id])[0]
          : null,
        subtasks: sql("SELECT id, title, status FROM tasks WHERE parent_id = :p1 ORDER BY id", [claimed.id]),
        comments: sql("SELECT author, body, created_at FROM comments WHERE task_id = :p1 ORDER BY id", [claimed.id]),
        next_steps:
          "Work it, comment what you did with add_comment, then queue_complete. " +
          "If you cannot finish it, queue_release with a reason so someone else can pick it up.",
      };
    },
  },

  queue_release: {
    description:
      "Give a claimed task back without finishing it. Always say why: the next agent reads that reason before starting, and an unexplained release is a task that gets picked up and abandoned again.",
    schema: {
      type: "object",
      required: ["task_id", "reason"],
      properties: {
        task_id: { type: "number" },
        reason: { type: "string", description: "What stopped you, specifically." },
      },
    },
    run: (a) => {
      const before = sql("SELECT * FROM tasks WHERE id = :p1", [a.task_id])[0];
      if (!before) throw new Error(`No task ${a.task_id}`);
      sql(`UPDATE tasks SET claimed_by = NULL, claim_expires = NULL,
             status = CASE WHEN status = 'doing' THEN 'todo' ELSE status END,
             updated_at = datetime('now') WHERE id = :p1`, [a.task_id]);
      sql("INSERT INTO comments (task_id, author, body) VALUES (:p1, :p2, :p3)",
          [a.task_id, ACTOR, `Released: ${a.reason}`]);
      const after = sql("SELECT * FROM tasks WHERE id = :p1", [a.task_id])[0];
      if (after.status !== before.status) {
        sql("INSERT INTO status_events (task_id, status, actor) VALUES (:p1, :p2, :p3)",
            [a.task_id, after.status, ACTOR]);
      }
      audit("update", "task", a.task_id, `released by ${ACTOR}`, after.title);
      return after;
    },
  },

  queue_extend: {
    description:
      "Push your claim's expiry out because you are still working. A lease is short so a dead agent's task comes back quickly, which makes a slow but healthy agent the awkward case. Call this rather than letting the lease lapse: once it has, the task may already belong to someone else.",
    schema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "number" },
        minutes: { type: "number", description: "How much longer you need. Defaults to another full lease." },
      },
    },
    run: (a) => {
      const minutes = a.minutes && a.minutes > 0 ? Math.round(a.minutes) : 30;
      const task = sql("SELECT * FROM tasks WHERE id = :p1", [a.task_id])[0];
      if (!task) throw new Error(`No task ${a.task_id}`);
      if (!task.claimed_by) throw new Error(`Task ${a.task_id} is not claimed`);
      // Whoever is holding it is the only one who may move its expiry, and an
      // expired claim is refused outright rather than quietly renewed, because
      // by then it may be someone else's and extending would take it from them.
      if (task.claimed_by !== ACTOR) throw new Error(`Task ${a.task_id} is held by ${task.claimed_by}`);
      const stale = sql("SELECT datetime('now') AS now")[0].now;
      if (task.claim_expires && task.claim_expires < stale) {
        throw new Error("That claim has already expired. Call queue_next again rather than extending it.");
      }
      sql(`UPDATE tasks SET claim_expires = datetime('now', '+' || :p2 || ' minutes'),
             updated_at = datetime('now') WHERE id = :p1`, [a.task_id, minutes]);
      const after = sql("SELECT * FROM tasks WHERE id = :p1", [a.task_id])[0];
      audit("update", "task", a.task_id, `claim extended by ${ACTOR} to ${after.claim_expires}`, after.title);
      return after;
    },
  },

  queue_complete: {
    description:
      "Finish a claimed task. The summary is left as a comment and is what the next person or agent reads to know what actually happened, so write it for them rather than for a changelog.",
    schema: {
      type: "object",
      required: ["task_id", "summary"],
      properties: {
        task_id: { type: "number" },
        summary: { type: "string", description: "What you did, and anything the next person needs to know." },
      },
    },
    run: (a) => {
      const before = sql("SELECT * FROM tasks WHERE id = :p1", [a.task_id])[0];
      if (!before) throw new Error(`No task ${a.task_id}`);
      sql("INSERT INTO comments (task_id, author, body) VALUES (:p1, :p2, :p3)",
          [a.task_id, ACTOR, a.summary]);
      sql(`UPDATE tasks SET status = 'done', completed_at = datetime('now'),
             claimed_by = NULL, claim_expires = NULL, queue = NULL,
             updated_at = datetime('now') WHERE id = :p1`, [a.task_id]);
      if (before.status !== "done") {
        sql("INSERT INTO status_events (task_id, status, actor) VALUES (:p1, 'done', :p2)", [a.task_id, ACTOR]);
      }
      audit("update", "task", a.task_id, "status to done", before.title);
      return sql("SELECT * FROM tasks WHERE id = :p1", [a.task_id])[0];
    },
  },

  queue_status: {
    description: "What is waiting in the queue and what other agents are already holding. Read it before claiming if you want to know whether it is worth starting.",
    schema: {
      type: "object",
      properties: { queue: { type: "string" } },
    },
    run: (a) => {
      const queue = a.queue || "ready";
      return {
        queue,
        waiting: sql(
          `SELECT id, title, priority FROM tasks
            WHERE queue = :p1 AND status NOT IN ('done', 'blocked')
              AND (claimed_by IS NULL OR claim_expires < datetime('now'))
            ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, id`,
          [queue]
        ),
        in_flight: sql(
          `SELECT id, title, claimed_by, claim_expires FROM tasks
            WHERE queue = :p1 AND status != 'done'
              AND claimed_by IS NOT NULL AND claim_expires >= datetime('now')
            ORDER BY claim_expires`,
          [queue]
        ),
      };
    },
  },

  get_task: {
    description:
      "Everything about one task: its detail, subtasks, the discussion on it, and every status it has been through. Read this before starting work on a task, because the last agent probably left you something.",
    schema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "number" } },
    },
    run: (a) => {
      const task = sql("SELECT * FROM tasks WHERE id = :p1", [a.id])[0];
      if (!task) throw new Error(`No task ${a.id}`);
      return {
        task,
        project: task.project_id
          ? sql("SELECT id, key, name FROM projects WHERE id = :p1", [task.project_id])[0]
          : null,
        subtasks: sql("SELECT id, title, status FROM tasks WHERE parent_id = :p1 ORDER BY id", [a.id]),
        comments: sql("SELECT author, body, created_at FROM comments WHERE task_id = :p1 ORDER BY id", [a.id]),
        history: sql("SELECT status, actor, at FROM status_events WHERE task_id = :p1 ORDER BY at, id", [a.id]),
      };
    },
  },

  add_comment: {
    description:
      "Leave a comment on a task. Use it for what you found, what you tried, and what you would do next, so the agent that picks this up after you does not start from nothing.",
    schema: {
      type: "object",
      required: ["task_id", "body"],
      properties: {
        task_id: { type: "number" },
        body: { type: "string", description: "Markdown. Be specific: an unread comment is better than a vague one." },
      },
    },
    run: (a) => {
      const task = sql("SELECT id, title FROM tasks WHERE id = :p1", [a.task_id])[0];
      if (!task) throw new Error(`No task ${a.task_id}`);
      if (!a.body || !String(a.body).trim()) throw new Error("A comment needs something in it");
      sql("INSERT INTO comments (task_id, author, body) VALUES (:p1, :p2, :p3)",
          [a.task_id, ACTOR, String(a.body).trim()]);
      audit("update", "task", a.task_id, "commented", task.title);
      return sql("SELECT * FROM comments WHERE task_id = :p1 ORDER BY id DESC LIMIT 1", [a.task_id])[0];
    },
  },

  add_note: {
    description:
      "Store something worth remembering against a project: a decision and why, a gotcha, a reference. Use this for anything a future session would otherwise have to rediscover. Prefer this over leaving knowledge only in chat.",
    schema: {
      type: "object",
      required: ["project_id", "title", "body"],
      properties: {
        project_id: { type: "number" },
        title: { type: "string" },
        body: { type: "string" },
        kind: { type: "string", enum: ["note", "decision", "gotcha", "reference", "contact"] },
      },
    },
    run: (a) => {
      sql(`INSERT INTO notes (project_id, title, body, kind) VALUES (:p1, :p2, :p3, :p4)`,
          [a.project_id, a.title, a.body, a.kind || "note"]);
      const row = sql("SELECT id, title FROM notes ORDER BY id DESC LIMIT 1")[0];
      audit("create", "note", row.id, "created", row.title);
      return row;
    },
  },

  search: {
    description:
      "Search tasks and memory notes. Check here before searching a repository: a previous session may have already worked out the answer.",
    schema: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
    run: (a) => {
      const like = `%${a.query}%`;
      return {
        tasks: sql(
          `SELECT t.id, t.title, t.status, p.name AS project FROM tasks t
           LEFT JOIN projects p ON p.id = t.project_id
           WHERE t.title LIKE :p1 OR t.detail LIKE :p1 OR t.ref LIKE :p1 LIMIT 30`, [like]),
        notes: sql(
          `SELECT n.id, n.title, n.kind, n.body, p.name AS project FROM notes n
           LEFT JOIN projects p ON p.id = n.project_id
           WHERE n.title LIKE :p1 OR n.body LIKE :p1 LIMIT 30`, [like]),
      };
    },
  },

  oracle_context: {
    description:
      "Everything connected to a thing: a ticket, service, repository, file or concept. Returns the notes and tasks that mention it, the projects it spans, and the entities it appears alongside. Use this before reading a repository: it answers 'what do we already know about X' in one call, including connections nobody wrote down explicitly.",
    schema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", description: "e.g. deploy pipeline, auth service, PROJ-1234, billing API" } },
    },
    run: (a) => {
      const like = `%${a.name}%`;
      const entity = sql(
        "SELECT * FROM entities WHERE name LIKE :p1 ORDER BY mentions DESC LIMIT 1", [like]
      )[0];
      if (!entity) {
        return { found: false, suggestions: sql(
          "SELECT kind, name, mentions FROM entities ORDER BY mentions DESC LIMIT 15") };
      }
      return {
        entity,
        projects: sql(`
          SELECT DISTINCT p.name FROM edges e
          JOIN notes n ON e.source_type='note' AND n.id=e.source_id
          JOIN projects p ON p.id=n.project_id
          WHERE e.target_type='entity' AND e.target_id=:p1
          UNION
          SELECT DISTINCT p.name FROM edges e
          JOIN tasks t ON e.source_type='task' AND t.id=e.source_id
          JOIN projects p ON p.id=t.project_id
          WHERE e.target_type='entity' AND e.target_id=:p1`, [entity.id]),
        notes: sql(`
          SELECT n.id, n.title, n.kind, n.body, p.name AS project, e.evidence
          FROM edges e JOIN notes n ON n.id=e.source_id
          LEFT JOIN projects p ON p.id=n.project_id
          WHERE e.source_type='note' AND e.target_type='entity'
            AND e.target_id=:p1 AND e.relation='mentions' LIMIT 20`, [entity.id]),
        tasks: sql(`
          SELECT t.id, t.title, t.status, t.priority, t.ref, p.name AS project
          FROM edges e JOIN tasks t ON t.id=e.source_id
          LEFT JOIN projects p ON p.id=t.project_id
          WHERE e.source_type='task' AND e.target_type='entity'
            AND e.target_id=:p1 AND e.relation='mentions'
          ORDER BY t.status!='done' DESC LIMIT 20`, [entity.id]),
        related: sql(`
          SELECT o.kind, o.name, e.weight FROM edges e
          JOIN entities o ON o.id = CASE WHEN e.source_id=:p1 THEN e.target_id ELSE e.source_id END
          WHERE e.relation='co_occurs' AND (e.source_id=:p1 OR e.target_id=:p1)
          ORDER BY e.weight DESC LIMIT 12`, [entity.id]),
      };
    },
  },

  oracle_entities: {
    description:
      "List the things the graph knows about, most referenced first. Useful for orienting at the start of a session, or finding the exact name to pass to oracle_context.",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["ticket", "pr", "repo", "service", "file", "person", "env", "concept"] },
        limit: { type: "number" },
      },
    },
    run: (a) => {
      const params = [];
      let where = "";
      if (a.kind) { params.push(a.kind); where = "WHERE kind = :p1"; }
      params.push(Math.min(a.limit || 40, 200));
      return sql(
        `SELECT kind, name, mentions FROM entities ${where} ORDER BY mentions DESC LIMIT :p${params.length}`,
        params
      );
    },
  },

  oracle_ask: {
    description:
      "The main way to ask what we know. Combines meaning and connections: finds text that means something similar even with no words in common, then expands through the graph to what those things are connected to. Prefer this over reading a repository, and over plain search when you are not sure of the exact words.",
    schema: {
      type: "object",
      required: ["question"],
      properties: {
        question: { type: "string" },
        limit: { type: "number", description: "How many results, default 8" },
      },
    },
    run: (a) => {
      // Semantic scoring needs the vector runtime, which this process does not
      // have, so it delegates to the app's helper. Lexical and graph results are
      // produced here so the tool still answers when that is unavailable.
      const limit = Math.min(a.limit || 8, 30);
      const words = String(a.question).toLowerCase()
        .split(/[^a-z0-9_.-]+/).filter((w) => w.length > 3);

      const scoreClause = words.length
        ? words.map((w, i) => `(CASE WHEN lower(t.title || ' ' || COALESCE(t.detail,'')) LIKE :p${i + 1} THEN 1 ELSE 0 END)`).join(" + ")
        : "0";
      const params = words.map((w) => `%${w}%`);

      const tasks = words.length ? sql(
        `SELECT t.id, t.title, t.status, t.ref, p.name AS project, (${scoreClause}) AS hits
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         WHERE (${scoreClause}) > 0 ORDER BY hits DESC, t.status != 'done' DESC LIMIT :p${params.length + 1}`,
        [...params, limit]) : [];

      const noteClause = words.length
        ? words.map((w, i) => `(CASE WHEN lower(n.title || ' ' || n.body) LIKE :p${i + 1} THEN 1 ELSE 0 END)`).join(" + ")
        : "0";
      const notes = words.length ? sql(
        `SELECT n.id, n.title, n.kind, n.body, p.name AS project, (${noteClause}) AS hits
         FROM notes n LEFT JOIN projects p ON p.id = n.project_id
         WHERE (${noteClause}) > 0 ORDER BY hits DESC LIMIT :p${params.length + 1}`,
        [...params, limit]) : [];

      // Expand through the graph: entities mentioned by the best matches, and
      // what those entities travel with. This is the part plain search cannot do.
      const seedIds = notes.slice(0, 4).map((n) => n.id);
      const connected = seedIds.length ? sql(
        `SELECT DISTINCT e2.kind, e2.name, e2.mentions FROM edges ed
         JOIN entities e2 ON e2.id = ed.target_id
         WHERE ed.source_type = 'note' AND ed.relation = 'mentions'
           AND ed.source_id IN (${seedIds.join(",")})
         ORDER BY e2.mentions DESC LIMIT 12`) : [];

      return {
        note: "Lexical and graph results. For meaning-based ranking the app exposes oracle.nearest; this tool covers what is reachable without the vector runtime.",
        tasks, notes, connected,
      };
    },
  },

  recent_activity: {
    description: "What changed recently, and who changed it. Useful for picking up where another agent left off.",
    schema: { type: "object", properties: { limit: { type: "number" } } },
    run: (a) =>
      sql(`SELECT at, action, entity, entity_id, summary, label, undone
           FROM audit ORDER BY id DESC LIMIT :p1`, [Math.min(a.limit || 30, 200)]),
  },
};

// --- JSON-RPC ---------------------------------------------------------------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

function handle(req) {
  const { id, method, params } = req;

  if (method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "brain", version: "1.0.0" },
    };
  }

  if (method === "tools/list") {
    return {
      tools: Object.entries(TOOLS).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: t.schema,
      })),
    };
  }

  if (method === "tools/call") {
    const tool = TOOLS[params.name];
    if (!tool) throw new Error(`Unknown tool ${params.name}`);
    const result = tool.run(params.arguments || {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  if (method === "ping") return {};
  throw new Error(`Unknown method ${method}`);
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;

    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }

    try {
      const result = handle(req);
      // Notifications have no id and must not be answered.
      if (req.id !== undefined) send({ jsonrpc: "2.0", id: req.id, result });
    } catch (error) {
      if (req.id !== undefined) {
        send({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: String(error.message || error) } });
      }
    }
  }
});

process.stdin.on("end", () => process.exit(0));
