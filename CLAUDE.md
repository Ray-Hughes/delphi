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
npm test           # the scratchpad sync, round tripped. No framework
```

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
| `schema.sql` | The store. Projects hold tasks, notes, pads and links |

## Things that will catch you out

**`settings:set` uses an allowlist.** A field that is not named in the handler is
silently dropped, so adding a setting means editing `main.js` as well as the
renderer. Add it to the defaults object too, or the first read returns undefined.

**The MCP server cannot use `node:sqlite`.** It runs under whatever Node an MCP
client launches it with, so it shells out to the `sqlite3` binary. Parameters are
written into a temporary SQL file rather than bound through `.parameter set`,
because that is a line-oriented dot command and a note body containing a newline
breaks it halfway through.

**The database runs in WAL mode.** A write is durable but may still be sitting in
`delphi.db-wal`. Run `PRAGMA wal_checkpoint(TRUNCATE)` before committing
`delphi.db`, or the committed copy will be missing recent rows.

**`pads.js` is required by both the app and the MCP server.** It is the only
file that is, and it works because it has no dependencies at all. Everything else
the server needs it duplicates on purpose, since it runs under a plain Node with
no `node:sqlite` and cannot read inside `app.asar`. The grammar is shared instead
of copied because two copies of it would disagree within a month, and the
disagreement would surface as duplicated tasks in somebody's board rather than as
an error anyone could read. It is in `files` and in `extraResources` in
`electron-builder.config.js` for that reason. Run `npm test` after touching it.

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
`project`, `link`, `scratchpad`, `session` and `handoff`. Adding to that list
means editing `schema.sql` *and* `widenAuditEntities` in `db.js`, which rebuilds
the table on an existing database because a CHECK cannot be altered. Every write
through the MCP server records an audit row attributed to `DELPHI_ACTOR`, which
is what makes the History tab worth reading when more than one agent is working.

## Theming

Design tokens live in `:root` in `index.html`. Light is the base set. The dark set
is declared twice on purpose: once under `@media (prefers-color-scheme: dark)`
guarded by `:root:not([data-theme="light"])`, and once under
`:root[data-theme="dark"]`. That is what lets the Appearance setting pin a theme
while "System" still follows the OS live. Components reference tokens only, so
neither theme can end up with one theme's ink on the other's ground.
