<div align="center">

<img src="docs/icon.png" width="132" alt="Delphi" />

<h1>Delphi</h1>

### A project tracker with a knowledge graph, that your AI agents keep current themselves

**The app is Delphi. The thing you ask is the Oracle.**

<br>

[![Download](https://img.shields.io/badge/download-macOS%20%26%20Windows-0B7285?style=for-the-badge&labelColor=1B2B34)](https://ray-hughes.github.io/delphi/)
[![CI](https://img.shields.io/github/actions/workflow/status/Ray-Hughes/delphi/ci.yml?branch=main&style=for-the-badge&label=tests&labelColor=1B2B34&logo=githubactions&logoColor=white)](https://github.com/Ray-Hughes/delphi/actions/workflows/ci.yml)
[![Licence](https://img.shields.io/badge/licence-MIT-0B7285?style=for-the-badge&labelColor=1B2B34)](#licence)
[![Data stays local](https://img.shields.io/badge/data-never%20leaves%20your%20machine-1B2B34?style=for-the-badge)](#your-data)

<br>

<img src="https://img.shields.io/badge/macOS-11+-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS 11 or newer">
<img src="https://img.shields.io/badge/Windows-10%20%26%2011-0078D4?style=flat-square&logo=windows&logoColor=white" alt="Windows 10 and 11">
<img src="https://img.shields.io/badge/Electron-43-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron 43">
<img src="https://img.shields.io/badge/SQLite-node:sqlite-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite via node:sqlite">
<img src="https://img.shields.io/badge/MCP-stdio-6E56CF?style=flat-square" alt="Model Context Protocol over stdio">
<img src="https://img.shields.io/badge/Claude_Code-supported-D97757?style=flat-square&logo=anthropic&logoColor=white" alt="Claude Code supported">
<img src="https://img.shields.io/badge/Copilot-supported-24292E?style=flat-square&logo=githubcopilot&logoColor=white" alt="GitHub Copilot supported">
<img src="https://img.shields.io/badge/embeddings-Ollama-000000?style=flat-square&logo=ollama&logoColor=white" alt="Local embeddings via Ollama">

<br><br>

Projects hold tasks, memory notes and links. Press a key, it appears. Press it again, it is gone.
Claude Code and GitHub Copilot can both read and write it through MCP, so what one of them
learns is still there for the next session.

<br>

[**Why**](#why) · [**Install**](#install) · [**Use**](#use) · [**Agents**](#connecting-an-ai-agent) · [**Graph**](#the-knowledge-graph) · [**Safety**](#safety-guard) · [**Data**](#your-data)

</div>

> [!TIP]
> No terminal needed. [Download the installer](https://ray-hughes.github.io/delphi/),
> open it, and connect your AI agent afterwards with one command.

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

**[Download for macOS or Windows](https://ray-hughes.github.io/delphi/)**, or take
a file directly:

| | | |
| --- | --- | --- |
| **macOS**, Apple Silicon | [Delphi-mac-arm64.dmg](https://github.com/Ray-Hughes/delphi/releases/latest/download/Delphi-mac-arm64.dmg) | Any Mac since 2020 |
| **macOS**, Intel | [Delphi-mac-x64.dmg](https://github.com/Ray-Hughes/delphi/releases/latest/download/Delphi-mac-x64.dmg) | |
| **Windows** | [Delphi-Setup.exe](https://github.com/Ray-Hughes/delphi/releases/latest/download/Delphi-Setup.exe) | 64 bit, Windows 10 or 11 |

Nothing else is needed to run it. Node is required only to connect an AI agent,
because your editor launches the MCP server with its own Node rather than with
the app.

### The first launch will stop you once

Delphi is not signed with a paid developer certificate yet, so both systems ask
before running it the first time. This is expected and it happens once.

**macOS.** Drag Delphi into Applications and open it. macOS says it could not
verify the app is free of malware. Click **Done**, not Move to Trash: that button
is the highlighted one and it deletes the app. Then open **System Settings**,
**Privacy and Security**, scroll to Security where it now says Delphi was
blocked, and click **Open Anyway**. It opens normally from then on.

One line does the same thing, by clearing the quarantine flag rather than
approving it:

```bash
xattr -dr com.apple.quarantine /Applications/Delphi.app
```

Older advice for unsigned apps is to right click and choose Open. Apple removed
that route in macOS 15, so on a current Mac it does nothing that double clicking
does not.

**Windows.** SmartScreen shows a blue box saying it protected your PC. Click
**More info**, then **Run anyway**. The Run anyway button only appears after
More info, which is why the box looks like a dead end. The installer is per
user, so it never asks for administrator rights.

### Opening it

Three ways in, and they all reach the same window:

- **The application**, from Launchpad, the Start menu or the desktop shortcut.
- **The keyboard.** **Ctrl+T** shows and hides it from anywhere.
- **The menu bar icon** on macOS, or the **system tray icon** on Windows.

To change the shortcut, open **Settings**, click the recorder and press the
combination you want. It registers immediately and tells you if another
application already owns it.

By default Delphi is an ordinary window. Turn on **panel mode** in Settings, or
in **View**, and it floats above your work and vanishes when you click away.

### From source

For running the development copy, which is also the only way to get the
`make` targets and the Desktop launcher.

```bash
git clone https://github.com/Ray-Hughes/delphi.git ~/delphi
cd ~/delphi
make setup     # dependencies, AI agents, Desktop icon
make start
```

A checkout keeps its database, settings and vault beside the source, so it does
not touch anything an installed copy is using and the two can be run side by
side.

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
| `make setup` | First run: dependencies, agents and Desktop icon |
| `make mcp` | Connect the Oracle to Claude Code and Copilot |
| `make desktop` | Put a Delphi icon on the Desktop |

Building the installers yourself needs `npm run dist:mac` or `npm run dist:win`.
Each has to run on its own platform: a Windows installer built on macOS needs
Wine, and a dmg cannot be made anywhere but macOS.

### Opening it at login

**macOS**: System Settings, then General, then Login Items, then **+**, and
choose Delphi. **Windows**: press <kbd>Win</kbd>+<kbd>R</kbd>, run
`shell:startup`, and put a shortcut to Delphi in the folder that opens.

---

## Use

| Action | How |
| --- | --- |
| Show or hide | Your hotkey, or click the menu bar icon |
| Add a task | Type on the Tasks tab and press Enter |
| High priority | Start the task with `!` |
| Link a ticket | Include a reference like `ABC-1234`; it is picked up automatically |
| Search everything | Type in the top box, or press <kbd>Cmd</kbd>+<kbd>F</kbd> |
| Change status | Hover a task and click **status** to cycle todo, doing, blocked, done |
| Move between projects | Hover a task and use the **move to** menu |
| Store a finding | The **Memory** tab, per project |
| Read a note as prose | **Memory** tab, switch **Formatted** and **Raw markdown** |
| Filter the task list | Click any count on a project's **Overview** |
| Light or dark | **Settings**, then **Appearance**. System follows the Mac |
| Undo a mistake | The **History** tab. Every change is reversible |
| Dismiss | <kbd>Esc</kbd>, or click away |

### Memory notes

Each note has a kind, which is the difference between a useful store and a pile of text:

- **decision** - what was chosen and, more importantly, why the alternative was not
- **gotcha** - something that cost time once and should not cost it twice
- **reference** - a value, path or piece of protocol that is hard to look up again
- **contact** - who owns a thing
- **note** - everything else

Pin the ones you reread. Notes are written as markdown and render as prose by default.
Switch to **Raw markdown** to edit the source, or double click a rendered note.

---

## Connecting an AI agent

Delphi ships an MCP server. Any agent that speaks MCP can use it, and several agents can share
one store, because none of them talk to each other; they all talk to this.

One command connects both, and skips whichever you do not have installed:

```bash
bash install/mcp.sh                                        # macOS
powershell -ExecutionPolicy Bypass -File install\mcp.ps1   # Windows
```

From a checkout, `make mcp` runs the first of those for you. The
`-ExecutionPolicy Bypass` on Windows is not optional advice: Windows refuses to
run unsigned scripts by default, and the error it gives says nothing about what
to do about it.

Restart your editor afterwards. MCP servers are loaded at startup, so a server
registered mid-session does not appear until the editor is restarted. This is
the single most common reason people think the connection failed.

<details>
<summary>What that command does, and how to do it by hand</summary>

**Claude Code** is registered through the CLI, which writes to `~/.claude.json`:

```bash
claude mcp add delphi --scope user -e DELPHI_ACTOR=claude -- \
  /absolute/path/to/node /absolute/path/to/delphi/agent/mcp_server.js
```

Confirm with `claude mcp list`; it should report `delphi ... ✔ Connected`.

**GitHub Copilot in VS Code** is registered at user level, in
`~/Library/Application Support/Code/User/mcp.json`, so Copilot can reach the
tracker from any project rather than only from this folder:

```json
{
  "servers": {
    "delphi": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/delphi/agent/mcp_server.js"],
      "env": { "DELPHI_ACTOR": "copilot" }
    }
  }
}
```

`make mcp` merges into that file rather than replacing it, so any other servers
already registered survive. Insiders and VSCodium are handled too.

A `.vscode/mcp.json` is also in the repository, for anyone who prefers the
server scoped to this checkout instead. Copilot needs **Agent mode** to use MCP
tools; Ask mode ignores them.

Use an absolute path to `node` in both. A version manager shim such as asdf's
needs the manager itself on `PATH`, and an editor does not launch its MCP
servers with your shell's `PATH`. `make mcp` resolves the real binary for you.

</details>

Give each agent a different `DELPHI_ACTOR`. That name appears against every change it makes, which is
what makes the History tab readable when more than one agent is working.

### Making the agent do it unprompted

Connecting the server is not enough on its own. Paste the prompt in
[AGENTS.md](AGENTS.md) into your agent's standing instructions, whether that is `CLAUDE.md`,
`.github/copilot-instructions.md`, or wherever yours reads from. It tells the agent to check the
tracker at the start of a session, search stored notes before searching a repository, and record
tasks and findings as it goes rather than waiting to be asked.

### Available tools

| Tool | Purpose |
| --- | --- |
| `list_projects` | Projects with open task counts |
| `add_project` | Create a project when work fits none of the existing ones |
| `list_tasks` | Tasks, filtered by project or status |
| `add_task` | Create a task |
| `update_task` | Change status, priority, detail or project |
| `add_note` | Store a decision, gotcha or reference |
| `search` | Search tasks and notes |
| `oracle_context` | Everything connected to a ticket, service, repo, file or concept |
| `oracle_entities` | What the graph knows about, most referenced first |
| `oracle_ask` | Meaning and connections together. The main way to ask what we know |
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

Embeddings are local: Ollama when it is running, and a lexical fallback when it is
not, so retrieval degrades rather than disappears. An input the model will not accept
falls back for that row alone rather than stopping the whole index.

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

One SQLite file, `delphi.db`. Nothing is sent anywhere.

Where it lives depends on how Delphi was installed, because a packaged
application is a read-only archive and cannot keep a database inside itself:

| | Database and settings | Markdown vault |
| --- | --- | --- |
| **Installed, macOS** | `~/Library/Application Support/Delphi` | `~/Documents/Delphi` |
| **Installed, Windows** | `%APPDATA%\Delphi` | `Documents\Delphi` |
| **From a checkout** | beside the source, as before | `vault/`, beside the source |

**Help**, then **Show Data Folder** opens whichever applies. The first time an
installed copy starts it looks for a checkout's database in the usual places and
brings it across, so upgrading from a source install does not present you with an
empty tracker. Set `DELPHI_DATA_DIR` to override the location entirely.

Back up from **File**, then **Back Up Database**. That runs `VACUUM INTO` rather
than copying the file, which matters: the database uses write-ahead logging, so
recent rows can still be sitting in `delphi.db-wal` and a plain copy produces a
backup quietly missing the last session.

```bash
make backup     # from a checkout
```

The database is deliberately not tracked in git. It holds your work, not code,
and a populated `delphi.db` in a shared repository publishes every note in it.
Clone the repository to share the app; the schema is created on first run, so a
colleague starts with an empty tracker.

> [!WARNING]
> Naming the database in `.gitignore` does nothing if git is already tracking it.
> That happened here. The file was renamed from `brain.db` to `delphi.db`, the
> ignore rule was updated but the tracked file was never removed, and the database
> rode along in eleven commits before anyone noticed. If you cloned or forked an
> older copy, check with `git ls-files | grep '\.db'` and untrack it with
> `git rm --cached delphi.db delphi.db-wal delphi.db-shm`.

Keep anything private in the database rather than in a file beside it. The database
is untracked; a markdown file next to it is not.

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
| `paths.js` | Where things live, which differs once packaged |
| `main.js` | Window, tray, menu, global shortcut, IPC |
| `preload.js` | The only bridge the interface has to the data |
| `app.js` | The interface |
| `embeddings.js` | Local vectors: Ollama when present, lexical when not |
| `agent/mcp_server.js` | MCP server for AI agents |
| `agent/guard.py` | Destructive command guard |
| `install/mcp.sh`, `install/mcp.ps1` | Connects the server to Claude Code and Copilot |
| `install/desktop.sh` | Builds the Desktop launcher for a checkout |
| `electron-builder.yml` | How the installers are packaged |
| `tools/make_icons.py` | Rebuilds every icon from the artwork in `build/source` |
| `docs/` | The download page, served by GitHub Pages |

Storage is SQLite through `node:sqlite`, which ships inside Electron. There is no native module to
compile and nothing to rebuild when Electron updates, which is the usual reason small tools like this
quietly stop working. The MCP server is the exception: it runs under whatever Node an editor launches
it with, which may not have `node:sqlite`, so it shells out to the `sqlite3` binary instead.

---

## Status

Working today: projects, tasks, memory notes with markdown rendering, links, search,
project dashboards with linked repositories, local vector search over project material,
history with undo, light and dark themes, the MCP server and the safety guard. Signed
installers for macOS and Windows are the next thing, rather than a certificate being
in place already.

Being built: desktop reminders with snooze, an agent activity view, and a skills browser.

## Contributing

Issues and pull requests are welcome. If you add a rule to the guard, add a case to `guard_test.py`
on both sides: one command it must block, and one nearby command it must not.

CI runs the guard suite, syntax-checks every script, and fails if a database file is ever tracked.
That last check exists because a populated `delphi.db` reached a public repository once, through a
`.gitignore` that still named the file by its old name.

## Licence

MIT
