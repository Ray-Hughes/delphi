// Building and querying the knowledge graph.
//
// Extraction is deterministic. An LLM pass would find more, but it would also
// invent entities, and an invented node in a graph an agent trusts is worse than
// a missing one: a missing node makes a query return less, a wrong node makes it
// return something false. Patterns here only match things with an unambiguous
// shape, and the vocabulary list is curated rather than guessed.

const fs = require("fs");
const path = require("path");

// Things with a shape that cannot be mistaken for prose.
const PATTERNS = [
  { kind: "ticket", re: /\b([A-Z][A-Z0-9]{1,9}-\d{2,6})\b/g },
  { kind: "file", re: /\b([\w./-]+\.(?:rb|js|py|ya?ml|sql|sh|java|json|tf|md))\b/g },
  { kind: "repo", re: /\b(bip-appeals-[a-z0-9-]+)\b/g },
];

// Names that matter in this domain but do not have a distinctive shape, so they
// are listed rather than pattern matched. Add to this rather than loosening a
// pattern: a loose pattern produces confident nonsense.
const VOCABULARY = {
  service: [
    "MPI", "Caseflow", "VACOLS", "BGS", "VBMS", "Vault", "Harness", "ArgoCD",
    "Kubernetes", "Redis", "Postgres", "Oracle", "DataPower", "Grafana", "Prometheus",
    "eFolder Express", "Decision Review API", "Veteran API",
  ],
  env: ["devtest", "prodtest", "staging", "production", "uat", "demo"],
  concept: [
    "truststore", "keystore", "circuit breaker", "Add Correlation", "Register Interest",
    "orchestration", "Authority to Operate", "acknowledgement", "correlation",
  ],
};

function open(db) {
  db.exec(fs.readFileSync(path.join(__dirname, "oracle.sql"), "utf8"));
}

/** Case-insensitive word match that will not fire inside a longer word. */
function vocabRegex(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "gi");
}

/** A short window around a match, so an edge can be audited later. */
function evidenceFor(text, index, length) {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 60);
  return (start ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
}

function extract(text) {
  if (!text) return [];
  const found = new Map();
  const add = (kind, name, index, length) => {
    const key = `${kind}:${name.toLowerCase()}`;
    if (!found.has(key)) {
      found.set(key, { kind, name, evidence: evidenceFor(text, index, length) });
    }
  };

  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) add(kind, m[1], m.index, m[0].length);
  }

  for (const [kind, terms] of Object.entries(VOCABULARY)) {
    for (const term of terms) {
      const re = vocabRegex(term);
      let m;
      while ((m = re.exec(text))) add(kind, term, m.index, m[0].length);
    }
  }

  return [...found.values()];
}

function upsertEntity(db, kind, name) {
  db.prepare(
    `INSERT INTO entities (kind, name, mentions) VALUES (:kind, :name, 1)
     ON CONFLICT(kind, name) DO UPDATE SET
       mentions = mentions + 1,
       last_seen = datetime('now')`
  ).run({ kind, name });
  return db.prepare("SELECT * FROM entities WHERE kind = :kind AND name = :name").get({ kind, name });
}

function addEdge(db, edge) {
  db.prepare(
    `INSERT INTO edges (source_type, source_id, target_type, target_id, relation, weight, evidence)
     VALUES (:sourceType, :sourceId, :targetType, :targetId, :relation, :weight, :evidence)
     ON CONFLICT(source_type, source_id, target_type, target_id, relation)
     DO UPDATE SET weight = weight + 0.5`
  ).run({
    weight: 1.0,
    evidence: null,
    ...edge,
  });
}

/**
 * Rebuilds the graph from the current rows.
 *
 * A full rebuild rather than an incremental update. Mention counts and edge
 * weights are derived, so patching them on every edit accumulates drift, and the
 * corpus is small enough that correctness is worth more than the milliseconds.
 */
function rebuild(db) {
  open(db);
  db.exec("DELETE FROM edges");
  db.exec("DELETE FROM entities");

  const notes = db.prepare("SELECT * FROM notes").all();
  const tasks = db.prepare("SELECT * FROM tasks").all();
  const repos = db.prepare("SELECT * FROM repos").all();
  const links = db.prepare("SELECT * FROM links").all();

  // Structural edges. These come from the schema, so they are facts rather than
  // inferences and carry full weight.
  for (const n of notes) {
    if (n.project_id) {
      addEdge(db, { sourceType: "note", sourceId: n.id, targetType: "project", targetId: n.project_id, relation: "belongs_to", weight: 1.0 });
    }
  }
  for (const t of tasks) {
    if (t.project_id) {
      addEdge(db, { sourceType: "task", sourceId: t.id, targetType: "project", targetId: t.project_id, relation: "belongs_to", weight: 1.0 });
    }
  }
  for (const r of repos) {
    addEdge(db, { sourceType: "repo", sourceId: r.id, targetType: "project", targetId: r.project_id, relation: r.is_primary ? "primary_repo_of" : "helper_repo_of", weight: 1.0 });
  }
  for (const l of links) {
    addEdge(db, { sourceType: "link", sourceId: l.id, targetType: "project", targetId: l.project_id, relation: "belongs_to", weight: 1.0 });
  }

  // Mention edges, from the text.
  let mentionCount = 0;
  const scan = (sourceType, row, text) => {
    for (const hit of extract(text)) {
      const entity = upsertEntity(db, hit.kind, hit.name);
      addEdge(db, {
        sourceType, sourceId: row.id,
        targetType: "entity", targetId: entity.id,
        relation: "mentions", weight: 1.0, evidence: hit.evidence,
      });
      mentionCount++;
    }
  };

  for (const n of notes) scan("note", n, `${n.title}\n${n.body || ""}`);
  for (const t of tasks) scan("task", t, `${t.title}\n${t.detail || ""}\n${t.ref || ""}`);
  for (const r of repos) scan("repo", r, `${r.name} ${r.path}`);

  // Entity-to-entity edges, inferred from co-occurrence in the same row. This is
  // the part that makes traversal useful: it is how "the truststore work" reaches
  // "the Veteran API" without either note naming the connection outright.
  const coOccur = db.prepare(`
    SELECT a.target_id AS a_id, b.target_id AS b_id, COUNT(*) AS n
    FROM edges a
    JOIN edges b ON a.source_type = b.source_type AND a.source_id = b.source_id
                AND a.target_id < b.target_id
    WHERE a.relation = 'mentions' AND b.relation = 'mentions'
      AND a.target_type = 'entity' AND b.target_type = 'entity'
    GROUP BY a.target_id, b.target_id
  `).all();

  for (const pair of coOccur) {
    addEdge(db, {
      sourceType: "entity", sourceId: pair.a_id,
      targetType: "entity", targetId: pair.b_id,
      relation: "co_occurs", weight: pair.n,
      evidence: `appears together in ${pair.n} place${pair.n === 1 ? "" : "s"}`,
    });
  }

  const entities = db.prepare("SELECT COUNT(*) AS n FROM entities").get().n;
  const edgeCount = db.prepare("SELECT COUNT(*) AS n FROM edges").get().n;
  return { entities, edges: edgeCount, mentions: mentionCount, pairs: coOccur.length };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function findEntities(db, query, limit = 20) {
  return db.prepare(`
    SELECT * FROM entities
    WHERE name LIKE :q OR display LIKE :q
    ORDER BY mentions DESC LIMIT :limit
  `).all({ q: `%${query}%`, limit });
}

/**
 * Everything within a couple of steps of an entity.
 *
 * Depth is capped at two on purpose. Three hops in a graph this connected
 * returns most of the database, which is the same as returning nothing.
 */
function neighbourhood(db, entityId, depth = 1) {
  const entity = db.prepare("SELECT * FROM entities WHERE id = :id").get({ id: entityId });
  if (!entity) return null;

  const rows = db.prepare(`
    SELECT e.source_type, e.source_id, e.relation, e.evidence, e.weight
    FROM edges e
    WHERE e.target_type = 'entity' AND e.target_id = :id AND e.relation = 'mentions'
    ORDER BY e.weight DESC
  `).all({ id: entityId });

  const notes = [];
  const tasks = [];
  for (const r of rows) {
    if (r.source_type === "note") {
      const n = db.prepare(`
        SELECT n.id, n.title, n.kind, n.body, p.name AS project
        FROM notes n LEFT JOIN projects p ON p.id = n.project_id WHERE n.id = :id
      `).get({ id: r.source_id });
      if (n) notes.push({ ...n, evidence: r.evidence });
    } else if (r.source_type === "task") {
      const t = db.prepare(`
        SELECT t.id, t.title, t.status, t.priority, t.ref, p.name AS project
        FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = :id
      `).get({ id: r.source_id });
      if (t) tasks.push({ ...t, evidence: r.evidence });
    }
  }

  const related = db.prepare(`
    SELECT other.*, e.weight FROM edges e
    JOIN entities other ON other.id = CASE WHEN e.source_id = :id THEN e.target_id ELSE e.source_id END
    WHERE e.relation = 'co_occurs'
      AND (e.source_id = :id OR e.target_id = :id)
      AND e.source_type = 'entity' AND e.target_type = 'entity'
    ORDER BY e.weight DESC LIMIT 12
  `).all({ id: entityId });

  const projects = db.prepare(`
    SELECT DISTINCT p.id, p.name FROM edges e
    JOIN notes n ON e.source_type = 'note' AND n.id = e.source_id
    JOIN projects p ON p.id = n.project_id
    WHERE e.target_type = 'entity' AND e.target_id = :id
    UNION
    SELECT DISTINCT p.id, p.name FROM edges e
    JOIN tasks t ON e.source_type = 'task' AND t.id = e.source_id
    JOIN projects p ON p.id = t.project_id
    WHERE e.target_type = 'entity' AND e.target_id = :id
  `).all({ id: entityId });

  return { entity, projects, notes, tasks, related };
}

/** The shortest chain of co-occurrence between two entities, if there is one. */
function connection(db, fromId, toId, maxDepth = 3) {
  const seen = new Set([fromId]);
  let frontier = [[fromId]];

  for (let depth = 0; depth < maxDepth; depth++) {
    const next = [];
    for (const chain of frontier) {
      const tip = chain[chain.length - 1];
      const neighbours = db.prepare(`
        SELECT CASE WHEN source_id = :id THEN target_id ELSE source_id END AS other, weight
        FROM edges
        WHERE relation = 'co_occurs' AND source_type = 'entity' AND target_type = 'entity'
          AND (source_id = :id OR target_id = :id)
        ORDER BY weight DESC
      `).all({ id: tip });

      for (const n of neighbours) {
        if (n.other === toId) {
          const ids = [...chain, toId];
          return ids.map((id) => db.prepare("SELECT id, kind, name FROM entities WHERE id = :id").get({ id }));
        }
        if (!seen.has(n.other)) {
          seen.add(n.other);
          next.push([...chain, n.other]);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return null;
}

function stats(db) {
  open(db);
  const byKind = db.prepare("SELECT kind, COUNT(*) AS n FROM entities GROUP BY kind ORDER BY n DESC").all();
  const byRelation = db.prepare("SELECT relation, COUNT(*) AS n FROM edges GROUP BY relation ORDER BY n DESC").all();
  const top = db.prepare("SELECT kind, name, mentions FROM entities ORDER BY mentions DESC LIMIT 12").all();
  return { byKind, byRelation, top };
}

module.exports = { open, rebuild, extract, findEntities, neighbourhood, connection, stats };
