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
  -- The folder on disk this project is. A project is a place, not just a label:
  -- agents run in it, its files are the work. Nullable because every project
  -- that existed before this column predates the idea, and a project without a
  -- folder is still a perfectly good list of tasks.
  path        TEXT,
  -- What shows in the project rail. An emoji if one is chosen; null falls back
  -- to the first letter of the name, which is why it can stay empty.
  icon        TEXT,
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
  -- The scratchpad this task was read out of, when it was read out of one. The
  -- board is a projection of the pads, and this is the link that makes the
  -- projection go both ways. SET NULL rather than CASCADE for the reason the
  -- organizer above gives: deleting the document must never delete the work.
  pad_id       INTEGER REFERENCES scratchpads(id) ON DELETE SET NULL,
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
  -- Widened once, for scratchpads and the agent coordination rows. An existing
  -- database cannot get this by ALTER TABLE, so db.js rebuilds the table when it
  -- finds the narrower constraint. Adding a value here means adding it there too.
  entity      TEXT NOT NULL CHECK (entity IN ('task', 'note', 'project', 'link',
                                              'scratchpad', 'session', 'handoff')),
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

-- The same pool, sliced by project. The claim is one UPDATE with a subselect, so
-- a queue read narrowed to a project is on the hot path of every agent asking for
-- work, and project_id leads because it is the equality that removes the most
-- rows once more than one project is using the pool.
CREATE INDEX IF NOT EXISTS idx_tasks_queue_project ON tasks(project_id, queue, status);

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

-- Sessions: a conversation with an agent, inside a project.
--
-- Granular's model, which this follows: you do not chat with the app, you open a
-- session against a project and an agent works there. Several can run at once,
-- which is why the session rather than the project holds the agent and model.
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  -- Which persona was chosen. Free text rather than a CHECK because the set of
  -- personas is a product decision that will change, and a constraint here would
  -- mean a migration every time one is added.
  agent       TEXT,
  provider    TEXT,                        -- anthropic | claude-cli | copilot
  model       TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'done', 'archived')),
  -- Running totals, kept on the session so the token meter does not have to add
  -- up every message on every render.
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, updated_at DESC);

-- Messages: the turns of a session, in order.
--
-- Stored rather than held in memory so a session survives a restart, which is
-- the whole reason it is called a session and not a chat window.
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     TEXT NOT NULL,
  -- Set once the turn is complete. A streaming reply is written as it arrives,
  -- so a row can exist with content still growing and no token count yet.
  tokens      INTEGER,
  -- Non-null when a turn failed, so a broken reply reads as an error in place
  -- rather than as an assistant that mysteriously said nothing.
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

-- Workspaces: a folder on disk, as a thing in its own right.
--
-- The relationship to projects is many to many in both directions, which is why
-- this is a table and not a column. One folder holds several separate pieces of
-- work: caseflow carries SSNR, the Central Office address fix and the version
-- drift checks. And one piece of work spans several folders: SSNR touches
-- caseflow, caseflow-efolder, the MPI person update service and the veteran API.
--
-- projects.path was the first attempt and could only say one of those two
-- things. It stays for now so nothing breaks mid-migration, but the join below
-- is the answer.
CREATE TABLE IF NOT EXISTS workspaces (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  -- Unique because two rows pointing at one folder are two names for the same
  -- place, and every question asked of a workspace would then have two answers.
  path        TEXT NOT NULL UNIQUE,
  icon        TEXT,
  colour      TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_workspaces (
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Where the work mainly lives, when it spans several. Used to pick a folder
  -- for a session that did not name one.
  is_primary   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_pw_workspace ON project_workspaces(workspace_id);
CREATE INDEX IF NOT EXISTS idx_pw_project   ON project_workspaces(project_id);

-- Scratchpads: the working document an agent keeps while it thinks.
--
-- Every harness already keeps one, and until now it kept it somewhere Delphi
-- could not see: a file in /tmp, a heading in its own context, a plan that dies
-- with the session. A pad is that document, stored, so the next session and
-- every other agent can read it.
--
-- Its own table rather than a kind of note, for two reasons. notes.kind carries
-- a CHECK constraint and ALTER TABLE cannot extend one, which is the same trap
-- projects.task_view documents above. And a pad is not a note: a note is
-- something you decided and want to keep, a pad is something you are still
-- working out, rewritten twenty times in an afternoon and read by whoever picks
-- the work up next.
--
-- derives_tasks is what makes the board a projection of the pads rather than a
-- second list somebody has to maintain. A checkbox line in the body is a task,
-- and the pad line and the task row stay in step in both directions. Per pad
-- rather than global, because a pad that is a design sketch full of unchecked
-- options should not fill the board with work nobody agreed to.
CREATE TABLE IF NOT EXISTS scratchpads (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Short slug, so an agent can address a pad by name across sessions without
  -- first having to look up an id it has no way of remembering.
  key           TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  -- Who wrote last. Free text for the same reason comments.author is: agents and
  -- people both write here and neither is the special case.
  author        TEXT,
  -- The session this pad belongs to, when it is a session's own working
  -- document rather than one the project keeps. SET NULL so ending a session
  -- does not take its thinking with it.
  session_id    INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  pinned        INTEGER NOT NULL DEFAULT 0,
  derives_tasks INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- Two pads with one name in one project are two answers to "open the plan".
  UNIQUE (project_id, key)
);

CREATE INDEX IF NOT EXISTS idx_scratchpads_project ON scratchpads(project_id, pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_scratchpads_session ON scratchpads(session_id);

-- Same arrangement as notes_fts, so search finds what an agent was working on
-- and not only what it concluded.
CREATE VIRTUAL TABLE IF NOT EXISTS pads_fts USING fts5(
  title, body, content='scratchpads', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS pads_ai AFTER INSERT ON scratchpads BEGIN
  INSERT INTO pads_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS pads_ad AFTER DELETE ON scratchpads BEGIN
  INSERT INTO pads_fts(pads_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS pads_au AFTER UPDATE ON scratchpads BEGIN
  INSERT INTO pads_fts(pads_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO pads_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE INDEX IF NOT EXISTS idx_tasks_pad ON tasks(pad_id);
