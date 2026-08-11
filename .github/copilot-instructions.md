# Copilot instructions

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
