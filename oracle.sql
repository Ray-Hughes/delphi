-- Knowledge graph over the brain.
--
-- Half of this graph already exists: projects, tasks, notes, repos and links are
-- entities with typed relationships, declared in schema.sql. A conventional
-- GraphRAG pipeline spends an expensive LLM pass discovering exactly that
-- structure from prose. Here it is free, so the work left is the entity layer:
-- the tickets, services, repositories, files and people mentioned inside the
-- text, which are what connect work across projects.
--
-- Deliberately NOT built: community detection and community summarisation. Those
-- earn their cost on a large unstructured corpus where nobody knows what the
-- themes are. This corpus is small and its themes are already named by the
-- projects, so clustering would produce a slower answer to a question already
-- answered.

PRAGMA foreign_keys = ON;

-- A thing worth connecting to. Kept separate from the rows that mention it, so
-- one ticket referenced by four notes is one node rather than four strings.
CREATE TABLE IF NOT EXISTS entities (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL
                CHECK (kind IN ('ticket', 'pr', 'repo', 'service', 'file', 'person', 'env', 'concept')),
  name        TEXT NOT NULL,          -- canonical form, e.g. PROJ-1234
  display     TEXT,                   -- what to show if different from the name
  summary     TEXT,                   -- filled in as things are learned about it
  mentions    INTEGER NOT NULL DEFAULT 0,
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, name)
);
CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);

-- An edge from a stored row to an entity, or between two entities.
--
-- source_type is the table the edge starts at, so a single table covers "this
-- note mentions PROJ-1234" and "this ticket blocks that ticket" without a
-- join table per pair.
CREATE TABLE IF NOT EXISTS edges (
  id          INTEGER PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('note', 'task', 'project', 'repo', 'link', 'entity')),
  source_id   INTEGER NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('note', 'task', 'project', 'repo', 'link', 'entity')),
  target_id   INTEGER NOT NULL,
  relation    TEXT NOT NULL,          -- mentions, belongs_to, blocks, touches, supersedes
  weight      REAL NOT NULL DEFAULT 1.0,
  evidence    TEXT,                   -- the sentence it was drawn from, for auditing
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_type, source_id, target_type, target_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);

-- Embeddings, stored as raw float32 bytes.
--
-- Vectors and the graph answer different questions and neither replaces the
-- other: the vector finds text that means something similar, the graph finds
-- things that are actually connected. Retrieval uses the vector to enter the
-- graph and the graph to expand from there.
CREATE TABLE IF NOT EXISTS embeddings (
  id          INTEGER PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('note', 'task', 'entity')),
  source_id   INTEGER NOT NULL,
  model       TEXT NOT NULL,
  dims        INTEGER NOT NULL,
  vector      BLOB NOT NULL,
  content_hash TEXT NOT NULL,         -- so unchanged rows are not re-embedded
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_type, source_id, model)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
