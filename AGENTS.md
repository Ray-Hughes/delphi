# Working with agents

Delphi is a small MCP server over a SQLite file. Any agent that speaks MCP can read
and write it, so two agents working on the same codebase share one memory instead of
each keeping its own. Neither agent talks to the other. They both talk to this.

For how to work on delphi itself, see `CLAUDE.md`.

## Tools

| Tool | What it does |
| --- | --- |
| `list_projects` | Every project with open task counts. Call first to find a `project_id` |
| `add_project` | Create a project when work fits none of the existing ones |
| `list_tasks` | Tasks, optionally filtered by project or status |
| `add_task` | Create a task |
| `update_task` | Change status, priority, detail, or move between projects |
| `add_note` | Store a decision, gotcha or reference against a project |
| `list_scratchpads` | The working documents in a project. Call before writing one |
| `read_scratchpad` | One pad in full: what the last session was in the middle of |
| `write_scratchpad` | Write the working document. Checkbox lines in it become tasks |
| `append_scratchpad` | Add to the end of a pad without reading it first |
| `patch_scratchpad` | Replace one section, found by its heading |
| `list_agents` | The other agents on this machine that work can be handed to |
| `handoff_send` | Hand a piece of work to another agent. You are woken with the reply |
| `handoff_status` | What has been handed to and from you, and the replies |
| `lock_acquire` | Take a lease on a file, a branch, a migration, so two agents do not collide |
| `lock_release` | Give one back |
| `lock_status` | What is held in a project, and by whom |
| `timer_set` | Ask to be given a turn later, instead of waiting in a loop |
| `search` | Text matching across tasks and notes |
| `oracle_context` | Everything connected to a ticket, service, repo, file or concept |
| `oracle_entities` | What the graph knows about, most referenced first |
| `oracle_ask` | Meaning and connections together. The main way to ask what we know |
| `recent_activity` | What changed lately and which agent changed it |
| `get_task` | One task in full: detail, subtasks, discussion, every status it has been through |
| `add_comment` | Leave your reasoning on a task, for whoever picks it up next |
| `queue_status` | What is waiting for an agent and what other agents are holding |
| `queue_next` | Claim the next piece of work and get everything needed to do it |
| `queue_complete` | Finish a claimed task with a summary |
| `queue_release` | Give a claimed task back, with a reason |
| `queue_extend` | Push your lease out because you are still working |

Every write is attributed. Set `DELPHI_ACTOR` in the server's environment to name the
agent, and its changes appear in the History tab labelled with that name. Give each
agent a different one. That is the only thing making History useful when more than one
is working.

## Which database it writes to

An installed copy keeps its database in the per-user data directory
(`~/Library/Application Support/Delphi` on macOS, `%APPDATA%\Delphi` on Windows,
`$XDG_CONFIG_HOME/Delphi` otherwise). A checkout keeps one beside the source. If you
have both, the installed one wins, because that is the one the app you are looking at
is reading.

This ordering matters more than it sounds. The server is registered by its path inside
the checkout, so it used to find the neighbouring database first and write there, while
the app read the other one. Nothing errors in that state: notes and tasks are written,
and simply never appear. If two databases exist, the server says which it chose on
stderr, which your client will have in its MCP log.

Set `DELPHI_DB` to an absolute path to override, which is how you point the server at a
checkout on purpose.

## Connecting

**Claude Code** writes to `~/.claude.json`:

```bash
claude mcp add delphi --scope user -e DELPHI_ACTOR=claude -- \
  /absolute/path/to/node /absolute/path/to/delphi/agent/mcp_server.js
```

Confirm with `claude mcp list`. Restart afterwards, because servers load at startup.

Use an absolute path to `node`. A version manager shim such as asdf's needs the
manager itself on `PATH`, and an MCP client does not launch with your shell's `PATH`.

**GitHub Copilot** agent mode reads `.vscode/mcp.json` in the workspace:

```json
{
  "servers": {
    "delphi": {
      "command": "node",
      "args": ["/Users/YOU/va/delphi/agent/mcp_server.js"],
      "env": { "DELPHI_ACTOR": "copilot" }
    }
  }
}
```

## The prompt

Paste this into `CLAUDE.md`, `.github/copilot-instructions.md`, or whatever your agent
reads as standing instructions. It is written to be pasted as is.

---

**Tracker**

You have a project tracker available through the delphi MCP tools. Use it without
being asked. Keeping it current is part of the work, not an extra step that waits for
an instruction.

At the start of a session, call `list_projects`, then `list_tasks` for whichever
project the work belongs to, so you know what is already open and do not raise
something that is already tracked.

Before searching a repository for background, call `oracle_context` with the thing you
are about to investigate: a ticket, a service, a file, a concept. It returns the notes
and tasks that mention it, the projects it spans, and the things it appears alongside.
That last part is the reason to prefer it over plain search: it surfaces connections
nobody wrote down, such as a database concern reaching a version ticket through the
build pipeline.

Use `search` when you want text matching rather than connections, and `oracle_entities`
when you need the exact name to ask about.

During the work:

- When you find work that will not be finished in this session, call `add_task`. Put
  enough in `detail` that someone picking it up cold knows why it matters and how they
  would verify it is done.
- When you finish something that was tracked, call `update_task` with status `done`.
  When you are waiting on another person or team, set `blocked` and say in the detail
  what is being waited for.
- When work does not belong to any existing project, call `add_project` rather than
  filing it under General, so its tasks and notes have a home.
- When you learn something a future session would otherwise rediscover, call `add_note`.
  This is the important one and the one most easily skipped. Good candidates: a decision
  and the reasoning behind it, a trap that cost time, why an obvious approach was
  rejected, an exact value that is hard to find again. Use `kind` of `decision`,
  `gotcha` or `reference` as appropriate.
- Keep your working document in a scratchpad, through `write_scratchpad`, and write the
  plan in it as checkbox lines. They become real tasks, so a plan in a pad is a plan on
  the board. Do not also call `add_task` for work that is already in the pad: that files
  it twice.

Do not ask permission before recording any of this. Record it, then mention in one line
what you recorded.

What not to store: secrets, tokens, anything that belongs in a password manager, and
restatements of what the code already says plainly.

---

## Scratchpads, and the board read out of them

A scratchpad is the working document for a piece of work: the plan, what was
tried, what it did, what is still open. Every agent already keeps one. Until
these existed it kept it somewhere Delphi could not see, which meant it died
with the session.

`write_scratchpad` puts it in the tracker instead, and `list_scratchpads` is how
you find the one that is already there rather than starting a second one beside
it. `append_scratchpad` and `patch_scratchpad` are the safe writes when another
agent may be working the same pad: neither can overwrite what the other added.

The part worth understanding is that the board is a projection of the pads. A
checkbox line is a task:

```
- [ ] wire the codex adapter @ray !high
- [x] a finished one
  - [ ] an indented line is a subtask of the one above
```

`@name` sets the assignee, `!high` the priority, indentation the parent. Ticking
a line closes its task; closing the task rewrites the line. So the plan and the
board cannot drift, and nobody has to file anything twice.

Delphi marks each line it has filed with an `<!--d:123-->` comment. It is
invisible when the markdown renders and it is how a line and its task stay the
same thing across a rewording. Edit around them. If you drop them, lines are
matched back to their tasks by exact text, which recovers most of it but not a
line you reworded in the same pass.

Two rules exist so this cannot lose work. A line that disappears from a pad does
not delete its task; it stays on the board, and the pad shows what it dropped.
And an unticked box does not drag a task out of `doing` or `blocked`: the pad
owns done or not done, the board owns the rest.

A pad can be turned off as a source with `derives_tasks: false`, for a sketch
full of options nobody has agreed to yet.

Notes are still notes. A pad is where you are thinking; a note is what you
concluded, and `add_note` still owns those.

### The scratchpad switch

Settings has a switch called **Agent scratchpad**. Off by default. Turned on,
every agent connected to this database is told to keep its plans and working
documents here rather than in temporary files, and given a default project to
put them in.

The point is that the default is otherwise a temp directory, which is emptied
between sessions and invisible to every other agent sharing this tracker. You
ask for a draft, you get one, and the next session has no idea it existed.

A setting only changes behaviour if it reaches the model, and no agent reads
`settings.json`. An MCP server has three ways into a model's context, and the
switch writes to all of them:

| Channel | When it is read | Weight |
| --- | --- | --- |
| `initialize` → `instructions` | Once, on connect | Varies by client; some ignore it |
| `tools/list` → tool descriptions | Whenever the model considers a tool | Where the behaviour comes from |
| `tools/call` → result | While the agent is already working | Last chance to correct course |

The middle one does the work. A directive sitting in `write_scratchpad`'s own description
is read at the moment the model is deciding where to put something.

Turning it on or off reaches agents that are already connected, within a few
seconds and with nothing to restart: the server declares `tools.listChanged` and
pushes `notifications/tools/list_changed` when the setting changes, so the client
re-reads the descriptions. Wording lives in `agent/directives.js`.

It deliberately does not cover files that have to be files to work: scripts an
agent executes, generated documents, anything a command needs a path for.

## Working alongside other agents

Delphi can run Claude Code, Codex and Copilot as tabs in the same project, and
they all speak to this same server. Three tools exist because of that.

`handoff_send` gives a piece of work to another agent: "have Codex review this
branch". It returns immediately with an id. Delphi runs the request in that
agent's own session, keeps the reply, and gives you a fresh turn with the answer
when it lands. So hand it over and finish your turn. Do not poll, do not sleep,
do not wait in a loop: your turn ending is the normal and expected thing, and you
will be woken.

`timer_set` is the same idea for anything else that finishes on its own clock: a
build, a deploy, a long test run. Start it, set a timer, end your turn. It only
works from inside a Delphi tab, because there has to be a session to wake.

`lock_acquire` is a lease on something two of you could collide over: a file, a
branch, a migration, the dev server. It expires, because an agent that takes one
and dies must not hold it forever, and you extend it by asking again. Check the
answer before you carry on: `held: false` means somebody else has it and says
who and until when.

Delphi stops running handoffs by itself after twelve finish in one project in an
hour. Two agents that each wake the other are a loop that spends money at machine
speed with nobody watching, and the limit is the thing that notices.

## Taking work from the queue

Tasks placed in the queue are work someone has decided is ready for an agent. Nobody
will hand them to you: you take them.

**At the start of a session, and again after finishing anything, call `queue_next`.**
If it returns a task, work it. If it returns nothing, the queue is empty and you should
say so and stop, rather than inventing work to look busy.

A claim is a lease, not an assignment. It lasts thirty minutes, and when it lapses the
task returns to the pool for someone else. That is deliberate: an agent that dies
holding a task should not take it with it.

There is one pool, shared by every project. `queue_next(project: "key")` narrows it to
one project's share of that pool, which is what you want whenever you can only work on
one of them, most often because you are running in that project's checkout. Left out,
you get whatever is at the top, whichever project it belongs to. A queued task with no
project is only ever offered to an unnarrowed call.

```
queue_next()                      claim the next one, and get its brief
queue_next(project: "key")        the same, but only from that project
add_comment(task_id, body)        what you found, tried, decided
queue_extend(task_id, minutes)    still working, give me longer
queue_complete(task_id, summary)  finished, with what happened
queue_release(task_id, reason)    could not finish, and why
```

Four rules that make this work when more than one agent is doing it:

**Read before starting.** The claim returns the discussion and the history along with
the task. Someone may have already tried this and left you the reason it failed.

**Write before finishing.** `queue_complete` takes a summary, and that summary is what
the next person reads. Write it for them, not for a changelog. "Fixed" tells them
nothing; "the provider ignores the idempotency key on refunds, so this needs the same
change in the refund path" saves them the afternoon you just spent.

**Release honestly.** If you are stuck, `queue_release` with the specific reason. A task
released without one gets picked up and abandoned again by the next agent, and then the
one after that.

**Renew before you lapse, not after.** If a task is going to take longer than the lease,
call `queue_extend` while you still hold it. Once the lease has expired the task is back
in the pool and may already be someone else's, so extending is refused at that point
rather than quietly taking it back from them. A lapse is visible rather than a task that
mysteriously reset itself: the queue view reports the sweep, and the task's own timeline
records which agent lost the claim.

Do not claim more than one task at a time. Finish or release before taking another.

## Delegation

An agent cannot drive another agent through this. There is no message passing here.
What there is, is shared state: one agent writes a task, another sees it and picks it
up, and both leave a trail in `recent_activity`. That covers most of what people mean
by delegation and needs no coordination protocol.

If you want a genuine handoff, create a task, set its detail to what needs doing and
how it will be checked, and let the other agent poll `list_tasks`.

## Safety

`agent/guard.py` is a PreToolUse hook that denies destructive commands. It keeps
working when permission prompts are turned off, which is the case it exists for.
Install it by pointing a `PreToolUse` hook at it in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "python3 /Users/YOU/va/delphi/agent/guard.py" }]
      }
    ]
  }
}
```

It denies rather than prompts, and has no override flag on purpose. If something
genuinely needs doing that it blocks, run it yourself in a terminal. Run
`python3 agent/guard_test.py` to see exactly what it stops and what it lets past.
