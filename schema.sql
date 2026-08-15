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
  -- How this project's tasks are laid out: a flat list, one column per status
  -- side by side, or a board you can drag between. Per project rather than a
  -- setting, because two projects can reasonably want different answers.
  -- No CHECK on purpose. schema.sql can give a fresh database one and ALTER
  -- TABLE cannot add it to an existing database, so the constraint would reject
  -- a value on a new install and accept it on an old one. Validated in db.js,
  -- where every database behaves the same.
  task_view   TEXT NOT NULL DEFAULT 'list',
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
  -- Identity for a row an importer owns, namespaced: "jira:HELIO-14". Not ref,
  -- which is free text anyone can edit, so a re-import matching on it would
  -- duplicate the moment someone tidied one up.
  external_key TEXT,
  -- A subtask is a task with a parent rather than a row in a second table, so
  -- everything that already works on a task works on a subtask: search, the
  -- audit trail, status events, the MCP tools, all of it.
  parent_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  -- The epic this task is filed under, if the project uses them. SET NULL
  -- rather than CASCADE: deleting the shell must never delete the work, or
  -- nobody can safely try epics and change their mind.
  organizer_id INTEGER REFERENCES organizers(id) ON DELETE SET NULL,
  -- Free text until there is a people table. An agent name goes here too, which
  -- is what lets the queue show who is holding a piece of work.
  assignee     TEXT,
  -- The pool an agent may pull this from. Membership rather than a status,
  -- deliberately: "ready for an agent" is a different question from "what state
  -- is this in", and folding them together would mean a board column that only
  -- means something when an agent is watching.
  queue        TEXT,
  -- A claim, which is not the same as an assignee. An assignee is a decision
  -- someone made; a claim is a lease an agent took and can lose.
  claimed_by   TEXT,
  claim_expires TEXT,
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

-- Conversation about a task, kept on the task.
--
-- The author is free text rather than a reference to a people table, because
-- agents and people both write here and neither should be the special case. When
-- people management arrives it can backfill from these names rather than the
-- other way around.
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author     TEXT NOT NULL DEFAULT 'you',
  body       TEXT NOT NULL,
  external_key TEXT,                        -- see tasks.external_key
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id, id);

-- Every status a task has been in, and when it entered it.
--
-- The task keeps its current status as a column, so nothing that reads a task
-- has to change. This is the history behind that column, and it is what makes
-- "how long was this blocked" a question with an answer. Written by the update
-- path rather than by callers, so it cannot drift from the status it describes.
CREATE TABLE IF NOT EXISTS status_events (
  id      INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status  TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'blocked', 'done')),
  actor   TEXT,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_status_events_task ON status_events(task_id, at);

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

CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(queue, status);

-- Organizers: the optional epic shell.
--
-- A project is the initiative and an organizer is a piece of it big enough to
-- have its own name. Optional is the point: a project with none of these looks
-- exactly as it did before they existed, and there is no flag to set, because
-- having one is what "this project uses epics" means. A stored flag would be a
-- second answer to that question and the two would eventually disagree.
--
-- Its own table rather than a kind of task with a parent, because an organizer
-- is not something anyone finishes. It has no status, no assignee and no due
-- date; its progress is whatever its tasks add up to. A task with a parent gets
-- search, claims, status events and the queue for free, and a shell wearing
-- those would be claimable by an agent that then has nothing to do. The row it
-- resembles is a project, and a project is a table.
CREATE TABLE IF NOT EXISTS organizers (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  summary     TEXT,                        -- one line: what this epic covers
  colour      TEXT,                        -- falls back to the project's colour
  sort_order  INTEGER NOT NULL DEFAULT 0,
  external_key TEXT,                       -- see tasks.external_key
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_organizers_project ON organizers(project_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_tasks_organizer ON tasks(organizer_id);

-- One row per imported thing. Partial, because every row Delphi created itself
-- has no external key and those are not the rows this is protecting.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external_key
  ON tasks(external_key) WHERE external_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_external_key
  ON comments(external_key) WHERE external_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizers_external_key
  ON organizers(external_key) WHERE external_key IS NOT NULL;
