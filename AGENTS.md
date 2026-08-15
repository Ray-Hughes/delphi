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

Do not ask permission before recording any of this. Record it, then mention in one line
what you recorded.

What not to store: secrets, tokens, anything that belongs in a password manager, and
restatements of what the code already says plainly.

---

## Taking work from the queue

Tasks placed in the queue are work someone has decided is ready for an agent. Nobody
will hand them to you: you take them.

**At the start of a session, and again after finishing anything, call `queue_next`.**
If it returns a task, work it. If it returns nothing, the queue is empty and you should
say so and stop, rather than inventing work to look busy.

A claim is a lease, not an assignment. It lasts thirty minutes, and when it lapses the
task returns to the pool for someone else. That is deliberate: an agent that dies
holding a task should not take it with it.

```
queue_next()                      claim the next one, and get its brief
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
