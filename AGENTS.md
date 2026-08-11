# Working with agents

This describes how to connect an AI agent to the brain so it keeps the tracker
current on its own, rather than waiting to be told.

The idea is simple. The brain is a small MCP server over a SQLite file. Any agent
that speaks MCP can read and write it, so two agents working on the same
codebase share one memory instead of each keeping its own. Neither agent talks to
the other. They both talk to this.

## What the agent gets

| Tool | What it does |
| --- | --- |
| `list_projects` | Every project with open task counts. Call first to find a `project_id` |
| `list_tasks` | Tasks, optionally filtered by project or status |
| `add_task` | Create a task |
| `update_task` | Change status, priority, detail, or move between projects |
| `add_note` | Store a decision, gotcha or reference against a project |
| `search` | Search tasks and notes |
| `recent_activity` | What changed lately and which agent changed it |

Every write is attributed. Set `BRAIN_ACTOR` in the server's environment to name
the agent, and its changes appear in the History tab labelled with that name.

## Connecting Claude Code

**Claude Code** — register it with the CLI, which writes to `~/.claude.json`:

```bash
claude mcp add brain --scope user -e BRAIN_ACTOR=claude -- \
  /absolute/path/to/node /absolute/path/to/second-brain/agent/mcp_server.js
```

Confirm with `claude mcp list`; it should report `brain ... ✔ Connected`. Restart Claude Code
afterwards, because servers are loaded at startup.

Use an absolute path to `node`. A version manager shim such as asdf's needs the manager itself on
`PATH`, and an MCP client does not launch with your shell's `PATH`.

## Connecting GitHub Copilot

Copilot agent mode reads `.vscode/mcp.json` in the workspace:

```json
{
  "servers": {
    "brain": {
      "command": "node",
      "args": ["/Users/YOU/va/brain/agent/mcp_server.js"],
      "env": { "BRAIN_ACTOR": "copilot" }
    }
  }
}
```

Give each agent a different `BRAIN_ACTOR`. That is the only thing making the
History tab useful when more than one is working.

## The prompt

Paste this into `CLAUDE.md`, `.github/copilot-instructions.md`, or whatever your
agent reads as standing instructions. It is written to be pasted as is.

---

**Tracker**

You have a project tracker available through the `brain` MCP tools. Use it
without being asked. Keeping it current is part of the work, not an extra step
that waits for an instruction.

At the start of a session, call `list_projects`, then `list_tasks` for whichever
project the work belongs to, so you know what is already open and do not raise
something that is already tracked.

Before searching a repository for background, call `search` first. A previous
session may have already worked the answer out, and reading a stored note is
faster and more reliable than re-deriving it.

During the work:

- When you find work that will not be finished in this session, call `add_task`.
  Put enough in `detail` that someone picking it up cold knows why it matters and
  how they would verify it is done.
- When you finish something that was tracked, call `update_task` with status
  `done`. When you are waiting on another person or team, set `blocked` and say
  in the detail what is being waited for.
- When you learn something a future session would otherwise rediscover, call
  `add_note`. This is the important one and the one most easily skipped. Good
  candidates: a decision and the reasoning behind it, a trap that cost time, why
  an obvious approach was rejected, an exact value that is hard to find again.
  Use `kind` of `decision`, `gotcha` or `reference` as appropriate.

Do not ask permission before recording any of this. Record it, then mention in
one line what you recorded.

What not to store: secrets, tokens, anything that belongs in a password manager,
and restatements of what the code already says plainly.

---

## A note on delegation

An agent cannot drive another agent through this. There is no message passing
here. What there is, is shared state: one agent writes a task, another sees it
and picks it up, and both leave a trail in `recent_activity`. That covers most of
what people mean by delegation and needs no coordination protocol.

If you want a genuine handoff, create a task, set its detail to what needs doing
and how it will be checked, and let the other agent poll `list_tasks`.

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
        "hooks": [{ "type": "command", "command": "python3 /Users/YOU/va/brain/agent/guard.py" }]
      }
    ]
  }
}
```

It denies rather than prompts, and has no override flag on purpose. If something
genuinely needs doing that it blocks, run it yourself in a terminal. Run
`python3 agent/guard_test.py` to see exactly what it stops and what it lets past.
