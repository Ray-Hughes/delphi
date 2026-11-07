# Working in this repository

Delphi is a project tracker with a knowledge graph, kept current by the AI agents
that use it rather than by hand. It is an Electron app over a SQLite file, plus an
MCP server that exposes the same store to any agent that speaks MCP.

## House rules

**No em dashes or en dashes. Ever.** Not in prose, code comments, commit messages,
generated documents, chat replies, or anything else. Plain hyphens only. Normalise
the unicode minus too. Scan generated output before saving it.

Match the surrounding code. This codebase writes comments that explain *why* a
thing is the way it is, not what the line does. Keep that. A comment that restates
the code is worse than no comment.

## Running it

```
npm start          # electron .
npm test           # every tools/*_test.js and agent/*_test.py. Four to six minutes
```

`npm test` is `tools/test_all.js`, which finds the tests by name, so a new one
is picked up by existing. Each runs under Electron's binary with
`ELECTRON_RUN_AS_NODE=1`: the Node the app ships, with `node:sqlite` and no
window. A test that needs something else says so in its first lines
(`// test-runtime: node` or `electron`). There is no framework: each test prints
its checks and exits non-zero on a failure. `npm test -- sheet` runs only the
files whose names match.

There is no build step and no bundler. `index.html`, `app.js`, `main.js` and
`preload.js` are loaded as written, so a change is visible on restart. Electron
loads all of them at startup, so a renderer change needs a restart, not a reload.

## Shape

| File | Role |
| --- | --- |
| `main.js` | Electron main process. Owns settings, the tray, the hotkey, the scheduler and every IPC handler |
| `preload.js` | The only bridge. Exposes `window.delphi` and unwraps `{ok, data}` so the renderer can await plain values |
| `app.js` | Renderer. Talks to the main process through `window.delphi` only |
| `index.html` | All styling. Design tokens at the top, components below |
| `pads.js` | The scratchpad grammar. Pure text in, text out, no database and no dependencies |
| `ai.js` | Talking to a model directly, for Delphi's own chat |
| `harness.js` | Running somebody else's agent CLI as a session. Templates, parsers, MCP wiring |
| `agent/mcp_server.js` | JSON-RPC 2.0 MCP server over stdio, no dependencies |
| `agent/schema_later.js` | Columns and tables added after a database was made. Run by the app and the server alike |
| `agent/second_opinion.js` | Running another agent's CLI read only and waiting for its answer, for the `second_opinion` tool. Copilot only for now |
| `agent/binaries.js` | Whether an agent's command is the real binary an installer put there, or one a person trusted. Shared by the dispatcher and `second_opinion` |
| `agent/launch.js` | Splitting a command line, finding a binary, and whether the guard is wired in. Shared by the runner, `delphi chat` and `sheet/run.js` |
| `sheet/` | Sheets: the text format, the shared store, the MCP client, `run.js`, `decide.js` and `chat.js` |
| `sheet/tui/` | The Sheet in a terminal (`delphi open`): keys, screen, clipboard and the view itself |
| `workbench/` | Workbenches: naming, git, setup, the shared store, `keep.js` and the verbs in `workbench.js` |
| `bin/delphi` | The command line. Drives the MCP server over stdio rather than opening the database |
| `schema.sql` | The store. Projects hold tasks, notes, pads and links |

## Things that will catch you out

**A setting is one entry in `settings/schema.js`.** The defaults, `settings:set`'s
checks, the Settings panel's form, its search and the Cmd+K entries are all built
from it, and a field it does not name is refused by name rather than dropped.
A write is all or nothing. An entry's `effect` is what `main.js` runs after a
change (`SETTING_EFFECTS`), and `tools/settings_test.js` checks that every key
the renderer saves is in the schema.

**The MCP server has two routes to the database.** It runs under whatever Node
an MCP client launches it with, so it uses `node:sqlite` when that Node has it
and otherwise shells out to the `sqlite3` binary. Two rules follow, and code that
only ever ran on one route will break on the other:

- On the `node:sqlite` route a query is `prepare(s).all()`, which silently runs
  only the first statement of a multi-statement string. One statement per call.
- On the binary route each call is its own process, so `last_insert_rowid()` is
  always 0 and no transaction spans two calls. Inserts use `RETURNING`, which
  needs sqlite3 3.35 or newer; the server says so on stderr when it finds an
  older one.

`DELPHI_SQLITE_ROUTE=binary` forces the binary route, which is how the tests
prove both on a machine that always has `node:sqlite`. On the binary route,
parameters are written into a temporary SQL file rather than bound through
`.parameter set`, because that is a line-oriented dot command and a note body
containing a newline breaks it halfway through.

**The database runs in WAL mode.** A write is durable but may still be sitting in
`delphi.db-wal`. Run `PRAGMA wal_checkpoint(TRUNCATE)` before committing
`delphi.db`, or the committed copy will be missing recent rows.

**What a crash can lose, and what a power cut can.** Every connection sets
`PRAGMA synchronous = FULL`: `db.js` at open, the server at connect on the
`node:sqlite` route, and the first line of every script on the binary route,
because each of those is a new connection and Apple's `sqlite3` defaults to
NORMAL. Said on purpose so the routes agree, rather than by whatever each was
compiled with. So when the app or an agent crashes or is killed, no committed
write is lost on either route: the WAL is in the operating system's cache and
the next open replays it. A power cut or a kernel panic is different. macOS
`fsync` does not flush the drive's own cache and `fullfsync` is left off (it
costs 10 to 20ms a commit), so the very last commit can be lost, though the file
is never corrupted. What covers that is the copies: a snapshot every day in
`DATA_DIR/backups/` (seven kept, by SQLite's online backup, so it includes
the WAL) and a named one before anything big (an update, the folder migration,
a restore), each with a `restore_points` row. Settings, "Where your data lives",
restores one: the current file is snapshotted first, then the app relaunches and
puts the chosen one in place before anything opens it.

**Some modules are shared by the app and the MCP server, and the rest are
twinned.** The older code the server needs is duplicated from `db.js` on purpose,
because the server may have no `node:sqlite` and cannot read inside `app.asar`.
Duplicating stopped being the answer once the rules got bigger than a query: two
copies of a grammar or a store disagree within a month, and the disagreement
surfaces as duplicated tasks or a lost entry rather than an error anyone can
read. So these are shared:

- `pads.js` and `sheet/format.js`: pure text in, text out, no requires.
- `agent/schema_later.js`: the migrations, handed a one-statement query function.
- `sheet/store.js`, `workbench/store.js` and `workbench/workbench.js`: SQL text
  and rules that never open a database. Each is handed a `sql(query, params)`
  function in the server's `:p1` style. The server passes its own, which may be
  shelling out; `db.js` passes `db.sqlP`, which binds. One implementation, two
  routes.

A shared module must load under a plain Node with no dependencies, and every one
of them has to be in `files` and in `OUTSIDE_TOO` in `tools/after-pack.js` (see
packaging below).
Old twins are not being refactored onto this; new shared code follows it.

**New columns go in `schema.sql` and `agent/schema_later.js`, not `db.js`.**
SQLite has no `ADD COLUMN IF NOT EXISTS`, so `schema.sql` declares the column
for a fresh database and `schema_later.js` adds it to an existing one. The
server runs `schema_later` too, once at startup, because an agent can meet a
database the app has not opened since an upgrade.

**Comments are Sheet entries.** A task's discussion is its Sheet: rows in
`comments` with a `kind` (`say`, `run`, `ask`, `decide`, `note`), a `meta` JSON
block, and a `promoted` flag. The ledger is the promoted entries plus every
decision and the question it answers, and it is what an agent reads first:
`get_task` and `queue_next` return the ledger plus the last 20 entries. The
table kept its name so everything that already read comments (the vault, undo,
the importers) kept working. The vault mirrors each Sheet as a clean `.sheet`
file beside the project's pads.

**Run logs live in `DATA_DIR/sheets/<task>/<entry>.log`**, beside the database,
so they inherit its never-in-git rule. `/sheets/` is in `.gitignore` anyway, for
a data folder pointed at the checkout on purpose. `make prune-logs` drops the logs of tasks
done over 30 days ago, opening the database read-only through `sqlite3`.
`make cli` links `bin/delphi` onto PATH.

**A Workbench is a git worktree, and is never called that where a person can
see it.** One folder and one branch per task, in `<repo>.workbenches/` beside the
repository (or under `DELPHI_WORKBENCH_DIR`). The verbs are Start, Open, Park,
Finish and Discard, and git's own words stay in `workbench/git.js`, which turns
its errors into sentences. It has nothing to do with the older `workspaces` and
`project_workspaces` tables, which the folder migration read once and nothing
reads now; a Workbench is attached to a task.

**A project is a folder, and a folder is one project's.** `projects.path` is
the folder, normalised (`workbench/folders.js normalise`) and unique where it is
set, by an index the migration makes once no two projects share one; it is not
in `schema.sql`, which runs first and would fail on a database that still has a
shared folder. Every caller that needs a folder asks `folderFor` or
`projectFolders` there: jobs, `$ ` runs, Workbench Start, `sheet_resolve` and
sessions. A primary `repos` row counts only through the project's own folder, so
a project in No folder resolves nowhere. The folder is written in one place,
`db.js updateProject`, which moves the primary repos row with it.

**The never-lose-work rules are why `workbench/` refuses more than it does.**
Finish removes the folder only when nothing is unsaved and nothing is unpushed,
never forces, never stashes, and always keeps the branch. Files git does not keep
(an edited `.env`, notes in `build/`) are named first and only go on an explicit
yes. Discard removes the folder, but `workbench/keep.js` first commits everything
in it onto a ref no branch points at: `refs/delphi/discarded/<task>-<id>`, and
`refs/delphi/finished/` for what Finish removed. They are kept 30 days and
expired by housekeeping, and the Sheet entry prints the `git worktree add`
command that brings one back. A folder git cannot read is Unreadable, never
Missing, and nothing touches it. A folder deleted by hand is Missing, never
silently forgotten.

**The board is a projection of the scratchpads.** A checkbox line in a pad is a
task, anchored to it by an `<!--d:123-->` comment written into the line. The sync
runs both ways: `db.deriveInPlace` reads pad to board, `db.writeBackToPad` writes
board to pad, and a module-level `deriving` flag is what stops them calling each
other forever. Two rules are load bearing and both are there to stop an agent
losing work: a line that disappears never deletes its task, and an unticked box
never drags a task out of `doing`. See the comments in `db.js` and `pads.js`.

**A harness is a row, not a code path.** Claude Code, Codex and Copilot are
seeded into the `harnesses` table from `harness.BUILTINS`, argv template and all,
so a flag that moves in one of their releases is an edit in Settings rather than
a release of this. `seedHarnesses` keeps an untouched built-in current and leaves
an edited one alone, by remembering what it last seeded in `seeded_json`. The
template language is two rules: a nested list is a group that drops out when a
placeholder in it has no value, and `{mcpFlags}` splices. Both are tested.

**Every harness Delphi launches gets Delphi's MCP server**, scoped to the
project and named `<harness>:<sessionId>` in `DELPHI_ACTOR`. That attribution is
the point: it is what makes History a log of which agent did what. The server is
launched as `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, because there is no
guarantee of a `node` on PATH and Electron in that mode can read inside
`app.asar`.

**The renderer runs under a strict CSP**: `default-src 'self'; script-src 'self'`.
No external scripts, no CDN, no `eval`. Build DOM nodes rather than assigning
`innerHTML` for anything that came from the database.

**The audit table has a CHECK constraint** on `entity`: `task`, `note`,
`project`, `link`, `scratchpad`, `session`, `handoff` and `layout`. Adding to
that list means editing `schema.sql` *and* `AUDIT_ENTITIES` in
`agent/schema_later.js`, whose `widenAudit` rebuilds the table on an existing
database because a CHECK cannot be altered. The app (through `db.js`) and the
server run the same rebuild, copying columns by name so a column added later is
never dropped. Sheet and
Workbench writes are recorded as an `update` on their `task`, which is where
History shows them anyway, so they needed no widening. Every write through the
MCP server records an audit row attributed to `DELPHI_ACTOR`, which is what makes
the History tab worth reading when more than one agent is working.

**Three environment variables say who is calling the server.** `DELPHI_ACTOR`
names the writer. `DELPHI_AUTHOR_TYPE` (`human`, `agent` or `tool`) says what
kind, so a person whose username looks like an agent's is still drawn as a
person; `bin/delphi` defaults the actor to the OS username and the type to
`human` when neither is set. `DELPHI_CLIENT=delphi-cli` unlocks the Workbench
tools only the command line uses (park, update, commit, push, recreate and the
rest), which are left out of `tools/list` and refused without it. That is a
courtesy, not a boundary: no tool removes a folder with anything in it without
keeping a copy first, and there is no Discard tool at all.

**The guard blocks `delphi discard` and setting `DELPHI_CLIENT`**, in command
position however they are reached, because both are an agent stepping into a
person's role. The guard is a Claude Code `PreToolUse` hook, so it cannot see
commands Copilot or Codex run; that is why `delphi chat --auto` with Copilot needs
`--allow-unguarded`. `sheet/run.js` asks it before every `$ ` run, a person's or
an agent's, and fails closed when python3 or `guard.py` cannot be found.

**What a job may run is a tripwire, not a boundary.** `agent/dispatch.js`
refuses a job whose argv carries a flag off its per-harness allowlist, whose
harness row changed after approval, or whose command is not the agent as an
installer put it (under the npm global root, Homebrew, or Claude's own install
folders, in folders nobody else can write) unless a person clicked "Trust this
command", which stores the real file it resolved to. The guard's database rule
blocks writing the real `delphi.db` from a shell (sqlite3 without `-readonly`
among its options, or an interpreter naming it), and leaves any other
`delphi.db` alone. These catch accidents, casual edits and an agent doing it in
passing. They do not stop a determined process running as the same user, which
can write those folders and that file; copying the database, editing the copy
and copying it back, or a script file that opens it, are out of scope.

**Approving or rejecting a flag happens only in the window.** `flags:approve`
and `flags:reject` in `main.js` are the one caller of `items/store.js` decide,
and the only one that passes `via: "window"`, which decide requires. The command
line cannot tell a person from an agent that sets `DELPHI_ACTOR` and
`DELPHI_AUTHOR_TYPE` to look like one, and the guard can be spelled around, so
there is no decide tool in the MCP server and `delphi flags approve` and `reject`
only say "Approve or reject this in the Delphi window." The guard still blocks
those commands, as a courtesy. An Approve names the proposal entry the person
saw (`entryId`), and decide refuses with code `STALE` when a newer one exists.

**A module the app and the server both need goes in `files` and in
`OUTSIDE_TOO`, never in `extraResources`.** The server and the CLI run under a
plain Node outside `app.asar`, from `Resources/`, and find their modules by
relative require, so the layout there mirrors the checkout. electron-builder
leaves out of the archive anything `extraResources` copies, without a word, which
is how 1.6.0 shipped an app that could not start: `db.js` could not find
`./pads`. So shared modules are listed in `files` only, and `tools/after-pack.js`
copies them out to `Resources/` before signing. `extraResources` keeps only what
the app itself never loads. Every build from 1.3.0 to 1.5.0 had the opposite gap,
a server missing `agent/directives.js`.

`tools/package_test.js` reads the real `app.asar` and follows every require and
`<script src>` from the app, follows every require from the server and the CLI
in `Resources/`, starts both, and launches the packaged app with
`DELPHI_SMOKE=1` against an old database to prove it opens and migrates. The
release workflow runs it on macOS and Windows before anything is published.

**There is one database, and everything finds it the same way.**
`agent/locate.js` is the only resolver: `DELPHI_DB`, then `DELPHI_DATA_DIR`,
then the per-user data folder, whether the app is packaged or run from the
checkout. A `delphi.db` beside the source is never opened, only reported, because
the app once preferred it when unpackaged while agents used the installed one, and
each wrote to a database the other never read. Every database carries a `db_id` in
its `meta` table; agents Delphi launches get it as `DELPHI_DB_ID` and the server
refuses to start on a mismatch. `whoami` and `delphi doctor` report which database
is in use. A second copy of the app on the same data folder only brings the first
forward. `make dev` runs the checkout on a separate database in `~/.delphi-dev`.

**The job dispatcher refuses more than it runs.** `agent/dispatch.js` runs every
job (a handoff, a queued task, a person's request) from rows in `handoffs`, which
`agent/jobs.js` writes for the app and the server alike. Three rules hold. A job's
real argv is checked against an allowlist per harness (`POLICY`) immediately
before every spawn, follow-ups included, so a flag nobody listed fails closed;
adding a flag to a built-in template means adding it there too. An agent's job
waits in `needs_approval` until a person approves it, unless the project has
`auto_approve`; no MCP tool approves one. A `do` job runs only in its task's
Workbench and an `ask` job only reads, in the project's folder. Limits come from
`jobConcurrency` and `jobHarnessLimits`, bounded by `dispatch.BOUNDS` and read on
every pass, and the order of queued jobs from `queue_rank`.

**`items/` is one shared store, and agents never apply.** Moving, copying,
associating and flagging items across projects all go through `items/store.js`,
handed `sql` and a `batch`, so the app and the server write the same History
rows and a move lands as one batch on either route. An agent may flag an item or
propose a move; only a person's decision applies one, and the store refuses an
agent's decision whatever reached it. The one move an agent makes itself is a task
it filed in the last 24 hours (`update_task`, owner decision D2).

**Memory is compact by default.** `search`, `oracle_ask` and `oracle_context`
answer through `agent/recall.js`: one line per hit inside a token budget, with
`get_note` and `get_task` to read more. `detail: "full"` returns the old
whole-body answer unchanged, for clients written against it. A new recall tool
follows the same rule: the brief answer by default, the full one on request.

**Tests never touch a real database.** Not the one in
`~/Library/Application Support/Delphi`, not a stray one in the checkout. Each test
makes a temp directory and sets `DELPHI_DATA_DIR` and `DELPHI_DB` inside it. `test_all.js` sets both to
a temp folder before each test and strips the `DELPHI_*` variables an agent
session carries, as a floor under that, not instead of it.

## Theming

Design tokens live in `:root` in `styles/tokens.css`. Light is the base set.
Paper, a warm light theme after Muster's, is `:root[data-theme="paper"]` and is
pinned only: System reaches it because `applyTheme` in `app.js` writes
`data-theme="paper"` when the computer is light and "In System, light means" is
Paper. The dark set is declared twice on purpose: once under
`@media (prefers-color-scheme: dark)` guarded by
`:root:not([data-theme="light"]):not([data-theme="paper"])`, and once under
`:root[data-theme="dark"]`. That is what lets the Appearance setting pin a theme
while "System" still follows the OS live. Components reference tokens only, so
no theme can end up with another theme's ink on its ground. Focus rings use
`--focus-ring`, never `--accent` directly, because dark draws them in the
accent's ink. `tools/contrast_test.js` checks every theme, including the "Soft"
dark kept in a comment at the end of the file as a candidate.
