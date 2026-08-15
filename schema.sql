-- Delphi: projects hold tasks, notes and links.
--
-- The unit of thought here is the project, not the task. A flat task list stops
-- being useful past about thirty items because nothing tells you which of them
-- belong to the same problem. Projects give tasks a home, and give notes a place
-- to sit that is not a task pretending to be a note.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,        -- short slug, e.g. ssnr-mpi
  name        TEXT NOT NULL,
  summary     TEXT,                        -- one line: what this project is
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'paused', 'blocked', 'done', 'archived')),
  colour      TEXT,                        -- accent for the sidebar dot
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  legacy_id    TEXT,                       -- the old T-number, so notes still line up
  title        TEXT NOT NULL,
  detail       TEXT,
  status       TEXT NOT NULL DEFAULT 'todo'
                 CHECK (status IN ('todo', 'doing', 'blocked', 'done')),
  priority     TEXT NOT NULL DEFAULT 'med'
                 CHECK (priority IN ('high', 'med', 'low')),
  owner        TEXT,
  due          TEXT,
  source       TEXT,
  ref          TEXT,                       -- PROJ-123, PR number, whatever
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- The memory spots. Kept separate from tasks on purpose: a note is a thing you
-- want to remember, not a thing you want to finish, and forcing them into one
-- table is how task lists turn into junk drawers.
CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT 'note'
               CHECK (kind IN ('note', 'decision', 'gotcha', 'reference', 'contact')),
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS links (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  url        TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'link'
               CHECK (kind IN ('link', 'pr', 'jira', 'dashboard', 'doc')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id);
CREATE INDEX IF NOT EXISTS idx_links_project ON links(project_id);

-- Full text search over notes, so v2 search does not need a schema change.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, body, content='notes', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

-- Audit trail. Every mutation records what changed, with enough of the previous
-- row to put it back. Undo is not a separate mechanism: it replays the stored
-- "before" state, so anything auditable is also reversible.
CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  action      TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  entity      TEXT NOT NULL CHECK (entity IN ('task', 'note', 'project', 'link')),
  entity_id   INTEGER,
  summary     TEXT NOT NULL,          -- human readable, e.g. "marked done"
  label       TEXT,                   -- what it was, so the list reads without a join
  before_json TEXT,                   -- null for create
  after_json  TEXT,                   -- null for delete
  undone      INTEGER NOT NULL DEFAULT 0,
  undone_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at DESC);

-- Reminders.
--
-- An alert is a separate row rather than a flag on the task, because one task can
-- warrant several nudges and because a fired alert has a life of its own: it can
-- be snoozed, acted on, or dismissed without touching the task it points at.
CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  fire_at     TEXT NOT NULL,           -- when it should next appear
  message     TEXT,                    -- overrides the task title if set
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'fired', 'snoozed', 'done', 'dismissed')),
  repeat_every_minutes INTEGER,        -- null for one-shot
  snooze_count INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  fired_at    TEXT,
  acted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_due ON alerts(status, fire_at);

-- Repositories attached to a project. One is marked primary; the rest are the
-- helper repositories that get searched alongside it.
CREATE TABLE IF NOT EXISTS repos (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_repos_project ON repos(project_id);
