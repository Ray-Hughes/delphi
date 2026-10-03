/**
 * What the tracker tells agents to do, and how a setting reaches them.
 *
 * A checkbox in a settings pane changes a value in settings.json. No agent has
 * ever read settings.json and none ever will, so on its own that checkbox does
 * nothing. An MCP server has exactly three ways into a model's context, and a
 * setting that is meant to change behaviour has to be written into them:
 *
 *   1. initialize -> instructions   Read once when the client connects. Clients
 *                                   differ in how prominently they surface it,
 *                                   and some ignore it, so this is the weakest.
 *   2. tools/list -> descriptions   In context every time the model considers a
 *                                   tool. This is the one that does the work.
 *   3. tools/call -> result         In context at the moment of acting, which is
 *                                   the last point anything can be corrected.
 *
 * Writing to all three is the difference between a preference and a rule. Two is
 * where the behaviour actually comes from: a directive sitting in a tool's own
 * description is read at the moment of choosing that tool, by a model that is
 * already deciding where to put something.
 *
 * Dependency-free and requireable from a plain Node process, because the MCP
 * server runs under whatever Node the editor launched it with.
 */

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  scratchpadMode: false,
  scratchpadProjectId: null,
  // Read by the MCP server's Workbenches, so a branch an agent starts carries
  // the same prefix as one started in the app.
  workbenchBranchPrefix: null,
};

/**
 * Reads settings, cheaply enough to call on every request.
 *
 * Cached against the file's mtime rather than held forever, because the toggle
 * is expected to be flipped while an agent is connected. A missing or unparseable
 * file is the defaults: a broken settings file should leave agents behaving as
 * they did before the setting existed, not stop them working.
 */
function makeSettingsReader(settingsPath) {
  let cached = { ...DEFAULTS };
  let stamp = -1;

  return function read() {
    try {
      const { mtimeMs } = fs.statSync(settingsPath);
      if (mtimeMs !== stamp) {
        cached = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath, "utf8")) };
        stamp = mtimeMs;
      }
    } catch {
      cached = { ...DEFAULTS };
      stamp = -1;
    }
    return cached;
  };
}

/** Where settings.json sits, given where the database was found. */
const settingsBesideDatabase = (databasePath) =>
  path.join(path.dirname(databasePath), "settings.json");

/**
 * The full statement of the rule, for initialize.
 *
 * Written as instructions to an agent rather than as a description of a feature,
 * because that is what it has to be at the point it is read. The exclusions
 * matter as much as the rule: an agent told to put everything in the tracker
 * will eventually put a build artefact in it.
 */
function scratchpadInstructions(project) {
  const destination = project
    ? `Default destination: the "${project.name}" project, project_id ${project.id}.\n` +
      `File a draft against a more specific project when it plainly belongs to that\n` +
      `project's work. "${project.name}" is the fallback, not a dumping ground.`
    : `No default project is set for this. Call list_projects and file the draft\n` +
      `against whichever project fits, or ask which one to use.`;

  return [
    "SCRATCHPAD MODE IS ON.",
    "",
    "This tracker holds the scratchpad for this session. Your working document,",
    "the plan, the findings, what you tried and what it did, goes into it through",
    "write_scratchpad.",
    "",
    "Do not write it to a temporary directory, a scratchpad folder, /tmp, or an",
    "untracked file beside the source. Those are invisible to the next session and",
    "to every other agent sharing this tracker. A pad is not.",
    "",
    "Call list_scratchpads first and add to the pad that already exists, rather",
    "than starting a second one beside it. append_scratchpad and patch_scratchpad",
    "are the safe writes when another agent may be working the same pad.",
    "",
    destination,
    "",
    "Write the plan as checkboxes, because they become real tasks on the board:",
    "",
    "  - [ ] the thing to do @who !high",
    "  - [x] the thing already done",
    "    - [ ] an indented line is a subtask of the one above",
    "",
    "Ticking a line closes its task, and closing the task ticks the line. So do",
    "not also call add_task for work that is already in the pad: that files it",
    "twice. Delphi marks each filed line with an <!--d:123--> comment; edit around",
    "those and leave them alone.",
    "",
    "Notes are a different thing and add_note still owns them: a decision and why,",
    "a gotcha, a reference. Knowledge that outlives this piece of work. The pad is",
    "where you are thinking; a note is what you concluded.",
    "",
    "This is about prose and plans, not about build output. Keep using real files",
    "for things that have to be files to work at all: scripts you are going to",
    "execute, generated documents, anything a command needs a path for.",
    "",
    "Report back the pad id and key, since there is no file path to hand over.",
  ].join("\n");
}

/** The short form, appended to the descriptions of the tools it bears on. */
function scratchpadToolNote(project) {
  const where = project
    ? `Default destination is the "${project.name}" project, project_id ${project.id}, ` +
      `unless the draft plainly belongs to another project's work.`
    : `No default project is set, so pick the project that fits.`;
  return (
    ` SCRATCHPAD MODE IS ON: this tracker holds the scratchpad for this session. ` +
    `Your plan and working document belong here, through write_scratchpad, not in ` +
    `a temp directory, a scratchpad folder or /tmp. Checkbox lines in a pad become ` +
    `tasks, so write the plan as checkboxes rather than calling add_task as well. ` +
    `${where}`
  );
}

/** The reminder returned alongside a tool's result. */
function scratchpadReminder(project) {
  const where = project ? `"${project.name}" (project_id ${project.id})` : "the project that fits";
  return (
    `[delphi] Scratchpad mode is on. Keep your plan and working document here with ` +
    `write_scratchpad, against ${where}, rather than in a file in a temp directory. ` +
    `Checkbox lines become tasks, so the board follows the pad. Executable scripts ` +
    `and generated documents are the exception and stay as real files.`
  );
}

module.exports = {
  DEFAULTS,
  makeSettingsReader,
  settingsBesideDatabase,
  scratchpadInstructions,
  scratchpadToolNote,
  scratchpadReminder,
};
