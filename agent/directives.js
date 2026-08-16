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
    "This tracker is the scratchpad for this session. Drafts, working documents,",
    "research summaries, plans, analyses and intermediate output go into it as",
    "notes, through add_note.",
    "",
    "Do not write them to a temporary directory, a scratchpad folder, /tmp, or an",
    "untracked file beside the source. Those are invisible to the next session and",
    "to every other agent sharing this tracker. A note is not.",
    "",
    destination,
    "",
    'Use kind "reference" for a document meant to be used, pasted or handed over,',
    'and "note", "decision" or "gotcha" when it is knowledge rather than a',
    "deliverable. Open the body with its provenance: when it was written, what it",
    "was derived from, what is still unresolved or still a placeholder.",
    "",
    "This is about prose and drafts, not about build output. Keep using real files",
    "for things that have to be files to work at all: scripts you are going to",
    "execute, generated documents, anything a command needs a path for.",
    "",
    "Report back the note id and title, since there is no file path to hand over.",
  ].join("\n");
}

/** The short form, appended to the descriptions of the tools it bears on. */
function scratchpadToolNote(project) {
  const where = project
    ? `Default destination is the "${project.name}" project, project_id ${project.id}, ` +
      `unless the draft plainly belongs to another project's work.`
    : `No default project is set, so pick the project that fits.`;
  return (
    ` SCRATCHPAD MODE IS ON: this tracker is the scratchpad for this session. ` +
    `Drafts, working documents and intermediate output belong here as notes, not in ` +
    `a temp directory, a scratchpad folder or /tmp. ${where}`
  );
}

/** The reminder returned alongside a tool's result. */
function scratchpadReminder(project) {
  const where = project ? `"${project.name}" (project_id ${project.id})` : "the project that fits";
  return (
    `[delphi] Scratchpad mode is on. Write drafts and working documents here with ` +
    `add_note, against ${where}, rather than to a file in a temp directory. ` +
    `Executable scripts and generated documents are the exception and stay as real files.`
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
