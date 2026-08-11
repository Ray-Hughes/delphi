# Brain

A project tracker that lives behind a hotkey. Projects hold tasks, memory notes
and links, so work has a home rather than sitting in one long list.

## Running it

```
~/va/brain/brain
```

Then press **Control+T** to show or hide it. There is no dock icon; it lives in
the menu bar and appears centred on whichever display your pointer is on.

Clicking away hides it, and so does Escape.

To start it automatically at login: System Settings, General, Login Items, add
`~/va/brain/brain`.

## Changing the hotkey

Control+T is also the macOS "transpose characters" binding inside text fields, so
if that bothers you, change it. Edit `settings.json` in this folder:

```json
{ "hotkey": "Alt+Space" }
```

Restart the app afterwards. Anything Electron accepts as an accelerator works,
for example `Command+Shift+Space`, `Alt+Space`, `Control+Shift+T`. If the
combination is already owned by another application the app logs that it could
not register and keeps the previous one rather than failing silently.

## What is where

| File | What it does |
| --- | --- |
| `schema.sql` | Tables. Applied on every open, so it is safe to re-run |
| `db.js` | All database access, main process only |
| `main.js` | Window, tray, global hotkey, IPC handlers |
| `preload.js` | The only bridge the interface gets to the database |
| `app.js` | The interface |
| `import.py` | Seeds from the old `~/va/worklog/tasks.json` |
| `seed_memory.js` | Seeds the memory notes from recent work |
| `brain.db` | Your data. Everything lives here |

## The data model

**Projects** are the unit. A flat task list stops being useful past about thirty
items because nothing tells you which of them belong to the same problem.

**Tasks** belong to a project and behave the way you expect: status cycles
todo, doing, blocked, done, and completion time is derived from status rather
than stored separately so the two cannot disagree.

**Notes** are the memory spots, kept deliberately separate from tasks. A note is
something you want to remember, not something you want to finish. Forcing them
into one table is how task lists turn into junk drawers. Each note has a kind:
note, decision, gotcha, reference or contact.

**Links** are pull requests, tickets and dashboards per project.

## Using it

- Type in the box at the top to search tasks and notes across every project.
  Notes go through a full text index; Cmd+F focuses the box.
- On the Tasks tab, type and press Enter to add. Start with `!` for high
  priority. Any `APPEALS-1234` in the text is picked up as the reference.
- Hover a task for status, move-to-project and delete.
- The Memory tab is per project. Titles and bodies save when you click away.
- Pin a note with the star to keep it at the top.

## Re-importing from the old tracker

`python3 import.py` is rerunnable. Tasks match on their old T-number, so it
updates rather than duplicating, and anything you created in the app is left
alone.

Note that the old `~/va/worklog/task` CLI still writes to `tasks.json`, so the
two will drift apart once you use both. Either keep using the CLI and re-import,
or stop using it. Porting the CLI onto this database is the obvious next step and
has not been done.

## Backups

Everything is one SQLite file. To back it up:

```
cp ~/va/brain/brain.db ~/Dropbox/brain-$(date +%F).db
```

The database uses write-ahead logging, so copy `brain.db-wal` alongside it if the
app is running, or quit the app first for a clean single-file copy.

## Not built yet

Free-form capture outside a project, tags across projects, reminders, and syncing
Jira status automatically. The schema has room for all of it; none of it is
written.
