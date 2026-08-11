#!/usr/bin/env node
/**
 * MCP server over the brain.
 *
 * Speaks JSON-RPC 2.0 on stdin and stdout, which is the stdio transport every
 * MCP client supports. That is what lets Claude Code and Copilot agent mode use
 * the same store: neither is talking to the other, they are both talking to this.
 *
 * Written against the protocol directly rather than an SDK so it has no
 * dependencies. It runs under the system Node, which does not have node:sqlite,
 * so the database is reached through the sqlite3 binary. Parameters are bound
 * through a temporary file rather than interpolated, because an agent will
 * eventually pass a note containing a quote.
 */

const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const DB = path.join(__dirname, "..", "brain.db");

/**
 * Finds the sqlite3 binary.
 *
 * An MCP client launches this without a login shell, so PATH may not carry the
 * one the user sees in a terminal. The system copy on macOS is checked first
 * because it is always present and always adequate here.
 */
function findSqlite() {
  const candidates = [
    process.env.BRAIN_SQLITE,
    "/usr/bin/sqlite3",
    "/opt/homebrew/bin/sqlite3",
    "/usr/local/bin/sqlite3",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return "sqlite3"; // fall back to PATH and let it fail loudly
}

const SQLITE = findSqlite();
const ACTOR = process.env.BRAIN_ACTOR || "agent";

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
  // Values are substituted into the statement rather than bound through
  // ".parameter set", which is a dot-command and therefore line-oriented: a note
  // body containing a newline silently breaks it halfway through. A quoted SQL
  // literal inside a script file spans lines happily.
  //
  // Placeholders are replaced highest-numbered first so :p10 is not eaten by the
  // pattern for :p1.
  let statement = query;
  params.forEach((_, i) => {
    const index = params.length - 1 - i;
    statement = statement.replaceAll(`:p${index + 1}`, literal(params[index]));
  });

  const lines = [".mode json", ".headers on", statement.endsWith(";") ? statement : statement + ";"];

  const file = path.join(os.tmpdir(), `brain-${process.pid}-${Date.now()}.sql`);
  fs.writeFileSync(file, lines.join("\n"));
  try {
    const out = execFileSync(SQLITE, [DB], {
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
      },
    },
    run: (a) => {
      sql(
        `INSERT INTO tasks (project_id, title, detail, priority, due, ref, source)
         VALUES (:p1, :p2, :p3, :p4, :p5, :p6, :p7)`,
        [a.project_id ?? null, a.title, a.detail ?? null, a.priority || "med", a.due ?? null, a.ref ?? null, ACTOR]
      );
      const row = sql("SELECT id, title FROM tasks ORDER BY id DESC LIMIT 1")[0];
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
      },
    },
    run: (a) => {
      const before = sql("SELECT * FROM tasks WHERE id = :p1", [a.id])[0];
      if (!before) throw new Error(`No task ${a.id}`);
      const fields = ["title", "detail", "status", "priority", "due", "project_id"].filter((f) => a[f] !== undefined);
      if (!fields.length) return before;
      const params = fields.map((f) => a[f]);
      const sets = fields.map((f, i) => `${f} = :p${i + 1}`).join(", ");
      params.push(a.id);
      const done = a.status === "done" ? ", completed_at = datetime('now')" : a.status ? ", completed_at = NULL" : "";
      sql(`UPDATE tasks SET ${sets}, updated_at = datetime('now')${done} WHERE id = :p${params.length}`, params);
      const after = sql("SELECT * FROM tasks WHERE id = :p1", [a.id])[0];
      audit("update", "task", a.id, a.status ? `status to ${a.status}` : "updated", after.title);
      return after;
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

  graph_context: {
    description:
      "Everything connected to a thing: a ticket, service, repository, file or concept. Returns the notes and tasks that mention it, the projects it spans, and the entities it appears alongside. Use this before reading a repository: it answers 'what do we already know about X' in one call, including connections nobody wrote down explicitly.",
    schema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", description: "e.g. truststore, MPI, APPEALS-128303, Veteran API" } },
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

  graph_entities: {
    description:
      "List the things the graph knows about, most referenced first. Useful for orienting at the start of a session, or finding the exact name to pass to graph_context.",
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
