<div align="center">

# Delphi

**A project tracker with a knowledge graph, that your AI agents keep current themselves.**

The app is Delphi. The thing you ask is the Oracle.

Projects hold tasks, memory notes and links. Press a key, it appears. Press it again, it is gone.
Claude Code and GitHub Copilot can both read and write it through MCP, so what one of them
learns is still there for the next session.

[Why](#why) · [Install](#install) · [Use](#use) · [Agents](#connecting-an-ai-agent) · [Safety](#safety-guard) · [Data](#your-data)

</div>

---

## Why

Two problems, one tool.

**Flat task lists stop working.** Past thirty items, nothing tells you which entries belong to the
same piece of work. Delphi makes the project the unit: each one holds its own tasks, its own
notes, and links to the pull requests and tickets that go with it.

**Agents forget.** Every session an AI agent works out the same things again: why an approach was
rejected, which value was wrong last time, what the gotcha was. Those findings live in a chat log
nobody reads again. Here they go into the project as notes, and any agent can search them before it
starts digging through a repository.

Notes are deliberately not tasks. A note is something you want to remember; a task is something you
want to finish. Collapsing the two is how trackers turn into junk drawers.

---

## Install

Requires macOS and Node 18 or newer. Everything else is bundled.

```bash
git clone https://github.com/Ray-Hughes/second-brain.git
cd second-brain
make install
make start
```

`make start` brings up both pieces: the local embedding model and the app.
`make stop` takes both down, and `make status` says what is running.

| Command | What it does |
| --- | --- |
| `make start` / `make stop` | Everything, up or down |
| `make restart` | Both, cleanly |
| `make status` | What is running, and what is indexed |
| `make app` / `make app-restart` | Just the app |
| `make model` | Just the local embedding model |
| `make reindex` | Re-embed everything, after changing model |
| `make rebuild` | Rebuild the knowledge graph |
| `make backup` | Copy the database somewhere safe |
| `make doctor` | Check the pieces are wired up |
| `make mcp` | Register the Oracle with Claude Code |

Then press **Alt+Space** to show and hide the panel. There is no dock icon; it lives in the menu bar
and opens centred on whichever display your pointer is on.

To change the shortcut, open the panel, go to **Settings**, click the recorder and press the
combination you want. It registers immediately and tells you if another application already owns it.

**Start it at login:** System Settings → General → Login Items → add `second-brain/brain`.

### Bringing in existing tasks

If you already track work in JSON, adapt `import.py` and run it. It matches on your existing
identifiers, so it can be run repeatedly without creating duplicates.

---

## Use

| Action | How |
| --- | --- |
| Show or hide | Your hotkey, or click the menu bar icon |
| Add a task | Type on the Tasks tab and press Enter |
| High priority | Start the task with `!` |
| Link a ticket | Include a reference like `ABC-1234`; it is picked up automatically |
| Search everything | Type in the top box, or press <kbd>Cmd</kbd>+<kbd>F</kbd> |
| Change status | Hover a task and click **status** to cycle todo → doing → blocked → done |
| Move between projects | Hover a task and use the **move to** menu |
| Store a finding | The **Memory** tab, per project |
| Undo a mistake | The **History** tab. Every change is reversible |
| Dismiss | <kbd>Esc</kbd>, or click away |

### Memory notes

Each note has a kind, which is the difference between a useful store and a pile of text:

- **decision** — what was chosen and, more importantly, why the alternative was not
- **gotcha** — something that cost time once and should not cost it twice
- **reference** — a value, path or piece of protocol that is hard to look up again
- **contact** — who owns a thing
- **note** — everything else

Pin the ones you reread.

---

## Connecting an AI agent

Delphi ships an MCP server. Any agent that speaks MCP can use it, and several agents can share
one store, because none of them talk to each other; they all talk to this.

**Claude Code** — register it with the CLI, which writes to `~/.claude.json`:

```bash
claude mcp add brain --scope user -e DELPHI_ACTOR=claude -- \
  /absolute/path/to/node /absolute/path/to/delphi/agent/mcp_server.js
```

Confirm with `claude mcp list`; it should report `brain ... ✔ Connected`. Restart Claude Code
afterwards, because servers are loaded at startup.

Use an absolute path to `node`. A version manager shim such as asdf's needs the manager itself on
`PATH`, and an MCP client does not launch with your shell's `PATH`.

**GitHub Copilot** — a `.vscode/mcp.json` is already in the repository and works as is.

Give each agent a different `DELPHI_ACTOR`. That name appears against every change it makes, which is
what makes the History tab readable when more than one agent is working.

### Making the agent do it unprompted

Connecting the server is not enough on its own. Paste the prompt in
[AGENTS.md](AGENTS.md) into your agent's standing instructions — `CLAUDE.md`,
`.github/copilot-instructions.md`, or wherever yours reads from. It tells the agent to check the
tracker at the start of a session, search stored notes before searching a repository, and record
tasks and findings as it goes rather than waiting to be asked.

### Available tools

| Tool | Purpose |
| --- | --- |
| `list_projects` | Projects with open task counts |
| `list_tasks` | Tasks, filtered by project or status |
| `add_task` | Create a task |
| `update_task` | Change status, priority, detail or project |
| `add_note` | Store a decision, gotcha or reference |
| `search` | Search tasks and notes |
| `oracle_context` | Everything connected to a ticket, service, repo, file or concept |
| `oracle_entities` | What the graph knows about, most referenced first |
| `recent_activity` | What changed, and which agent changed it |

### On delegation

Agents coordinate through shared state, not messages. One writes a task, another sees it and picks it
up, and both leave a trail. There is no mechanism here for one agent to command another, and the
documentation does not pretend otherwise.

---

## The knowledge graph

Notes and tasks are also indexed as a graph, so an agent can ask what connects to
a thing rather than only what reads similarly to it.

Half the graph is free. Projects, tasks, notes, repositories and links are already
typed relationships in the schema, which is the structure a conventional GraphRAG
pipeline pays an expensive extraction pass to discover from prose. What is added
on top is the entity layer: the tickets, services, repositories, files and
concepts mentioned inside the text, plus edges between entities that appear
together.

Extraction is deterministic. Patterns match only shapes that cannot be mistaken
for prose, and everything else comes from a curated vocabulary in `graph.js`. An
invented node is worse than a missing one: a missing node makes a query return
less, a wrong node makes it return something false.

The payoff is multi-hop. Asking about a database concern can return a version
ticket it never mentions, because both were discussed alongside the build
pipeline. That is the question a vector search cannot answer.

Community detection and community summarisation are deliberately not built. They
earn their cost on a large corpus whose themes nobody knows; here the themes are
already named by the projects.

The graph rebuilds itself whenever notes or tasks change. To extend it, add to
the vocabulary rather than loosening a pattern.

---

## Safety guard

If you run an agent with permission prompts turned off, nothing stands between a bad command and your
disk. `agent/guard.py` is a `PreToolUse` hook that denies destructive commands. It keeps working when
prompts are disabled, because that is the case it exists for.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "python3 /absolute/path/to/delphi/agent/guard.py" }]
      }
    ]
  }
}
```

It stops recursive deletes of root and home paths, deletes of unexpanded variables, removal of
`.git`, `git clean` without a dry run, force pushes without `--force-with-lease`, repository deletion,
`DROP TABLE`, `DELETE FROM` with no `WHERE`, namespace deletion, untargeted `terraform destroy`,
piping a download into a shell, and disk-level commands. It also refuses edits to its own hook
configuration.

It matches on intent rather than exact spelling, so flags written separately or with unusual spacing
are still caught, and each command in a compound is judged on its own so a flag belonging to one is
not read as belonging to another.

Its limit is stated rather than hidden: this inspects the text of commands, so it stops accidents,
not a determined agent. A shell redirect can still overwrite the guard itself, and closing that would
mean blocking ordinary file writes.

```bash
python3 agent/guard_test.py
```

That prints every command it blocks and every command it deliberately allows. Read it before trusting
it. There is no override flag: if something it blocks genuinely needs doing, run it yourself in a
terminal.

---

## Your data

One SQLite file, `delphi.db`, next to the application. Nothing is sent anywhere.

```bash
cp delphi.db ~/backups/brain-$(date +%F).db
```

The database uses write-ahead logging, so either quit the application first or copy `delphi.db-wal`
alongside it.

Every change is recorded with the row as it was before, which is what makes the History tab able to
reverse any change rather than only the most recent one.

---

## How it is built

| File | Role |
| --- | --- |
| `schema.sql` | Tables, applied on every open so it is safe to re-run |
| `db.js` | All database access, main process only |
| `main.js` | Window, tray, global shortcut, IPC |
| `preload.js` | The only bridge the interface has to the data |
| `app.js` | The interface |
| `agent/mcp_server.js` | MCP server for AI agents |
| `agent/guard.py` | Destructive command guard |

Storage is SQLite through `node:sqlite`, which ships inside Electron. There is no native module to
compile and nothing to rebuild when Electron updates, which is the usual reason small tools like this
quietly stop working.

---

## Status

Working today: projects, tasks, memory notes, links, search, history with undo, the MCP server and
the safety guard.

Being built: desktop reminders with snooze, project dashboards with linked repositories, local vector
search over project material, an agent activity view, and a skills browser.

## Contributing

Issues and pull requests are welcome. If you add a rule to the guard, add a case to `guard_test.py`
on both sides: one command it must block, and one nearby command it must not.

## Licence

MIT
