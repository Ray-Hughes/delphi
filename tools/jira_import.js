#!/usr/bin/env node
// Brings a Jira export into Delphi, and can be run again over the same export
// without duplicating anything.
//
// A script rather than a screen: an import happens a handful of times, usually
// with a JQL query you are still refining, and every round of that is faster in
// a terminal than behind a file picker. It writes through db.js, so an import
// lands in the audit trail and the status timeline like any other change, and
// the History tab shows who did it.
//
// Identity is the Jira key, held in tasks.external_key as "jira:HELIO-14",
// rather than in ref. ref is free text, it is in updateTask's allowlist and the
// app lets anyone edit it, so an identity built on it survives exactly until
// somebody tidies one up. tasks.legacy_id is here for the same reason: this
// codebase has already decided once that an imported row needs its own handle.
// ref still gets the bare key, because that is what people read.
//
// Requires a Node with node:sqlite (22.5 or newer), because it goes through
// db.js. It is deliberately not wired into the MCP server, which cannot.
//
//   node tools/jira_import.js --file export.json
//   node tools/jira_import.js --file export.json --dry-run
//   node tools/jira_import.js --jql "project = HELIO ORDER BY created"
//
// Point it at a throwaway database while you are working it out:
//   DELPHI_DATA_DIR=/tmp/jira-trial node tools/jira_import.js --file export.json

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/**
 * db.js with its database open, or a second run of this script under a runtime
 * that can manage it.
 *
 * Two things go wrong on a system Node and neither is the reader's fault:
 * node:sqlite arrived behind --experimental-sqlite and only lost the flag later,
 * and a stock Node build has no fts5, which schema.sql needs for the note index.
 * Electron's bundled Node has both, which is why the app never notices any of
 * this. So rather than document a shell incantation, the script hands its own
 * arguments to the next runtime along until one of them works.
 */
function loadDb() {
  const stage = process.env.DELPHI_IMPORT_STAGE || "";
  try {
    const loaded = require(path.join(__dirname, "..", "db.js"));
    // Opening is where a missing fts5 shows up, so it happens here rather than
    // three functions into an import that has already started writing.
    loaded.handle();
    return loaded;
  } catch (error) {
    const message = String((error && error.message) || error);
    if (!/node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE|fts5/.test(message)) throw error;

    const rerun = (nextStage, command, args, env = {}) => {
      const again = spawnSync(command, args, {
        stdio: "inherit",
        env: { ...process.env, ...env, DELPHI_IMPORT_STAGE: nextStage },
      });
      process.exit(again.status === null ? 1 : again.status);
    };
    const argv = process.argv.slice(2);

    if (stage === "" && /node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE/.test(message)) {
      // --no-warnings because the only warning this run can produce is the one
      // the flag we just added asks for.
      rerun("flag", process.execPath, ["--experimental-sqlite", "--no-warnings", __filename, ...argv]);
    }

    let electron = null;
    try {
      // Under a plain Node this resolves to the path of the binary rather than
      // the API, which is exactly what is wanted here. See paths.js.
      const resolved = require(path.join(__dirname, "..", "node_modules", "electron"));
      if (typeof resolved === "string" && fs.existsSync(resolved)) electron = resolved;
    } catch { /* not installed, fall through to the advice below */ }

    if (stage !== "electron" && electron) {
      rerun("electron", electron, [__filename, ...argv], { ELECTRON_RUN_AS_NODE: "1" });
    }

    console.error(`Could not open the database with this runtime: ${message}`);
    console.error("It needs node:sqlite with fts5. Run it from the checkout, where Electron is installed:");
    console.error("  npm install && node tools/jira_import.js --file export.json");
    process.exit(2);
  }
}

const db = loadDb();

// Every key this script writes is namespaced, so a second importer can share the
// column later without either having to guess whose key it is looking at.
const NAMESPACE = "jira";
const ACTOR = process.env.DELPHI_ACTOR || "jira-import";

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

// The epic link on a company-managed project lives in a custom field whose id is
// per site. These are the ids Atlassian's own defaults hand out; anything else
// needs --epic-field. A team-managed project uses fields.parent instead and none
// of this applies.
const KNOWN_EPIC_FIELDS = ["customfield_10014", "customfield_10008", "customfield_10011"];

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    file: null,
    jql: null,
    dryRun: false,
    json: false,
    comments: true,
    backlink: true,
    epicField: null,
    projectPrefix: "",
    limit: 500,
  };
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) { rest.push(token); continue; }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    // A flag with no "=" takes the next token only when it needs one, so
    // "--dry-run --file x" does not eat "--file" as dry-run's value.
    const takesValue = ["file", "jql", "epic-field", "project-prefix", "limit"].includes(name);
    const value = eq !== -1 ? token.slice(eq + 1) : takesValue ? argv[++i] : true;

    switch (name) {
      case "file": args.file = value; break;
      case "jql": args.jql = value; break;
      case "dry-run": args.dryRun = true; break;
      case "json": args.json = true; break;
      case "no-comments": args.comments = false; break;
      case "no-backlink": args.backlink = false; break;
      case "epic-field": args.epicField = value; break;
      case "project-prefix": args.projectPrefix = String(value); break;
      case "limit": args.limit = Number(value) || 500; break;
      case "help": args.help = true; break;
      default: throw new Error(`Unknown option --${name}`);
    }
  }

  // A bare path is the common case, so accept it without the flag.
  if (!args.file && rest.length) args.file = rest[0];
  return args;
}

const USAGE = `
Import a Jira search export into Delphi. Running it twice updates rather than duplicates.

  node tools/jira_import.js --file export.json [options]
  node tools/jira_import.js --jql "project = HELIO"     (needs JIRA_* in the environment)

  --file PATH           a Jira REST search response, saved to disk
  --jql QUERY           fetch instead, using JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
  --dry-run             say what would change, write nothing
  --json                report as JSON rather than prose
  --no-comments         skip Jira comments
  --no-backlink         do not append the Jira URL to a task's detail
  --epic-field FIELD    the epic link custom field, e.g. customfield_10014
  --project-prefix S    prefix every project key this creates, to dodge a clash
  --limit N             stop after N issues when fetching (default 500)
`.trim();

// ---------------------------------------------------------------------------
// Reading issues
// ---------------------------------------------------------------------------

function issuesFromFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
  // A search response, a single issue, or a bare array of issues. All three are
  // things people actually have on disk, and telling them apart is cheaper than
  // making them reshape it first.
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.issues)) return parsed.issues;
  if (parsed.key && parsed.fields) return [parsed];
  throw new Error(`${file} has no issues in it`);
}

/**
 * Fetches issues from the API.
 *
 * Cloud takes an email and an API token as basic auth; Data Center takes a
 * personal access token as a bearer. Which one you have is decided by whether
 * JIRA_EMAIL is set, because nothing in the token itself says.
 *
 * The paged search endpoint moved to /search/jql with a page token, so the older
 * startAt form is kept as a fallback for sites that have not been moved yet.
 */
async function issuesFromApi({ jql, limit, comments }) {
  const base = (process.env.JIRA_BASE_URL || "").replace(/\/+$/, "");
  const token = process.env.JIRA_API_TOKEN;
  const email = process.env.JIRA_EMAIL;
  if (!base) throw new Error("JIRA_BASE_URL is not set");
  if (!token) throw new Error("JIRA_API_TOKEN is not set");

  const auth = email
    ? "Basic " + Buffer.from(`${email}:${token}`).toString("base64")
    : `Bearer ${token}`;
  const headers = { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" };

  const fields = ["summary", "description", "issuetype", "status", "priority", "assignee",
                  "reporter", "duedate", "parent", "project", "created", "updated"];
  if (comments) fields.push("comment");
  for (const f of KNOWN_EPIC_FIELDS) fields.push(f);

  const request = async (url, init) => {
    const response = await fetch(url, { ...init, headers });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = new Error(`Jira said ${response.status} ${response.statusText}. ${body.slice(0, 400)}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };

  const issues = [];

  try {
    let pageToken = null;
    do {
      const page = await request(`${base}/rest/api/3/search/jql`, {
        method: "POST",
        body: JSON.stringify({ jql, fields, maxResults: 100, nextPageToken: pageToken || undefined }),
      });
      issues.push(...(page.issues || []));
      pageToken = page.nextPageToken || null;
    } while (pageToken && issues.length < limit);
  } catch (error) {
    if (error.status !== 404 && error.status !== 410) throw error;
    let startAt = 0;
    let total = Infinity;
    while (issues.length < Math.min(total, limit)) {
      const query = new URLSearchParams({ jql, startAt: String(startAt), maxResults: "100", fields: fields.join(",") });
      const page = await request(`${base}/rest/api/3/search?${query}`, { method: "GET" });
      total = page.total ?? 0;
      if (!page.issues || !page.issues.length) break;
      issues.push(...page.issues);
      startAt += page.issues.length;
    }
  }

  // Search does not always return comments even when they are asked for, so any
  // issue that came back without them is topped up one at a time. That is a
  // request per issue, which is why it only happens when it has to.
  if (comments) {
    for (const issue of issues) {
      if (issue.fields && issue.fields.comment) continue;
      const full = await request(`${base}/rest/api/3/issue/${encodeURIComponent(issue.key)}?fields=comment`, { method: "GET" });
      issue.fields = { ...issue.fields, comment: full.fields ? full.fields.comment : null };
    }
  }

  return issues.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Atlassian Document Format
//
// Descriptions and comments arrive as a tree on API v3 and as a string of wiki
// markup on v2, and Delphi stores plain text. Only the node types carrying
// something a reader would miss are handled; everything else falls through to
// its children, so an unrecognised node loses its formatting rather than its
// words.
// ---------------------------------------------------------------------------

function adfToText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");

  const kids = () => (node.content || []).map(adfToText).join("");

  switch (node.type) {
    case "text": return markedText(node);
    case "hardBreak": return "\n";
    case "paragraph": return kids() + "\n\n";
    case "heading": return "#".repeat(node.attrs && node.attrs.level ? node.attrs.level : 1) + " " + kids() + "\n\n";
    case "codeBlock": return "```\n" + kids().replace(/\n+$/, "") + "\n```\n\n";
    case "blockquote": return prefixLines(kids().trim(), "> ") + "\n\n";
    case "rule": return "---\n\n";
    case "bulletList": return listToText(node, () => "- ") + "\n";
    case "orderedList": return listToText(node, (i) => `${i + 1}. `) + "\n";
    case "listItem": return kids();
    case "mention": return "@" + String((node.attrs && (node.attrs.text || node.attrs.displayName)) || "someone").replace(/^@/, "");
    case "emoji": return (node.attrs && (node.attrs.text || node.attrs.shortName)) || "";
    case "date": return (node.attrs && node.attrs.timestamp) || "";
    case "inlineCard": return (node.attrs && node.attrs.url) || "";
    case "status": return (node.attrs && node.attrs.text) ? `[${node.attrs.text}]` : "";
    case "table": return kids() + "\n";
    case "tableRow": return (node.content || []).map((cell) => adfToText(cell).trim().replace(/\n+/g, " ")).join(" | ") + "\n";
    case "tableCell":
    case "tableHeader": return kids();
    // Attachments, embeds and panels of images have no text to carry across.
    // See the notes: files are not imported.
    case "media":
    case "mediaGroup":
    case "mediaSingle":
    case "mediaInline": return "";
    default: return kids();
  }
}

function markedText(node) {
  let text = node.text || "";
  for (const mark of node.marks || []) {
    if (mark.type === "code") text = "`" + text + "`";
    if (mark.type === "link" && mark.attrs && mark.attrs.href && mark.attrs.href !== text) {
      text = `${text} (${mark.attrs.href})`;
    }
  }
  return text;
}

function listToText(node, marker) {
  return (node.content || [])
    .map((item, i) => prefixLines(adfToText(item).trim(), marker(i), "  "))
    .join("\n");
}

function prefixLines(text, first, rest = first) {
  return text.split("\n").map((line, i) => (i === 0 ? first : rest) + line).join("\n");
}

function bodyText(value) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : adfToText(value);
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

// Jira lets a site invent as many statuses as it likes, but every one of them
// belongs to a category, and the category is the part that means the same thing
// everywhere. Names are only consulted for "blocked", which has no category of
// its own and is the one distinction Delphi would otherwise lose.
const STATUS_BY_CATEGORY = { new: "todo", indeterminate: "doing", done: "done" };
const BLOCKED_NAMES = new Set([
  "blocked", "impeded", "on hold", "paused", "waiting", "waiting for support",
  "waiting on customer", "waiting for customer", "pending",
]);

function mapStatus(field) {
  const name = String((field && field.name) || "").trim().toLowerCase();
  if (BLOCKED_NAMES.has(name)) return "blocked";
  const category = String((field && field.statusCategory && field.statusCategory.key) || "").toLowerCase();
  return STATUS_BY_CATEGORY[category] || "todo";
}

const PRIORITIES = {
  highest: "high", high: "high", blocker: "high", critical: "high", major: "high",
  medium: "med", normal: "med",
  low: "low", lowest: "low", minor: "low", trivial: "low",
};

function mapPriority(field) {
  const name = String((field && field.name) || "").trim().toLowerCase();
  return PRIORITIES[name] || "med";
}

const person = (field) => (field && (field.displayName || field.name || field.emailAddress)) || null;

// Jira timestamps carry an offset; every datetime in this database is UTC in
// SQLite's own text format, which is what datetime('now') writes.
function sqliteTime(value) {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 19).replace("T", " ");
}

function isEpic(issue) {
  const type = (issue && issue.fields && issue.fields.issuetype) || {};
  if (typeof type.hierarchyLevel === "number") return type.hierarchyLevel >= 1;
  return String(type.name || "").toLowerCase() === "epic";
}

function isSubtask(issue) {
  const type = (issue && issue.fields && issue.fields.issuetype) || {};
  if (type.subtask === true) return true;
  if (typeof type.hierarchyLevel === "number") return type.hierarchyLevel < 0;
  return /sub-?task/.test(String(type.name || "").toLowerCase());
}

/** The epic an issue hangs off, whichever of the three places this site keeps it. */
function epicKeyOf(issue, epicField, warn) {
  const fields = issue.fields || {};

  if (epicField && typeof fields[epicField] === "string" && ISSUE_KEY.test(fields[epicField])) {
    return fields[epicField];
  }
  if (fields.epic && fields.epic.key) return fields.epic.key;
  if (fields.parent && isEpic(fields.parent)) return fields.parent.key;

  for (const id of KNOWN_EPIC_FIELDS) {
    const value = fields[id];
    if (typeof value === "string" && ISSUE_KEY.test(value)) {
      warn(`${issue.key}: read the epic link from ${id}. Pass --epic-field to be sure.`);
      return value;
    }
  }
  return null;
}

/** The browse URL, worked out from the API URL the export already carries. */
function browseUrl(issue) {
  const self = issue.self || (issue.fields && issue.fields.project && issue.fields.project.self);
  if (!self) return null;
  try {
    return `${new URL(self).origin}/browse/${issue.key}`;
  } catch {
    return null;
  }
}

const slug = (text) =>
  String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

// ---------------------------------------------------------------------------
// The import
// ---------------------------------------------------------------------------

// A dry run still has to be able to say "the epic is here" and "the parent is
// here", which means the rows it decided not to write need an id anyway. These
// are negative so that one leaking into a query finds nothing rather than
// something.
let pretendId = 0;
const pretend = () => --pretendId;

function makeReport() {
  return {
    projects: { created: [], updated: [], unchanged: [] },
    organizers: { created: [], updated: [], unchanged: [] },
    tasks: { created: [], updated: [], unchanged: [] },
    comments: { created: 0, updated: 0, skipped: 0 },
    links: { created: 0 },
    warnings: [],
    dropped: {},
  };
}

function run(issues, args) {
  const report = makeReport();
  const warn = (message) => report.warnings.push(message);
  const write = !args.dryRun;

  noteDropped(issues, report);

  const byKey = new Map();
  for (const issue of issues) {
    if (!issue || !issue.key || !issue.fields) { warn("Skipped an entry with no key or no fields"); continue; }
    byKey.set(issue.key, issue);
  }

  // Epics first, because a story needs the project it is going into to exist,
  // then stories, then subtasks, which need their parent task's id.
  const epics = [...byKey.values()].filter(isEpic);
  const subtasks = [...byKey.values()].filter((i) => !isEpic(i) && isSubtask(i));
  const stories = [...byKey.values()].filter((i) => !isEpic(i) && !isSubtask(i));

  // Jira project key to Delphi project id, and Jira epic key to organizer id.
  // Two maps rather than one, because they are two different things now: the
  // project is where the work lives, the epic is how it is grouped inside it.
  const projects = new Map();
  const organizers = new Map();
  const tasks = new Map();
  // Where each imported task ended up, so a subtask can be told the same answer
  // rather than working out its own and disagreeing.
  const taskProjects = new Map();

  // The Jira project is the initiative, so it is the Delphi project. Every issue
  // goes through here, including the epics themselves, because an organizer has
  // to be created inside something.
  const projectFor = (issue) => {
    const jiraProject = issue.fields.project;
    if (!jiraProject || !jiraProject.key) {
      warn(`${issue.key}: no project on the issue, importing it unfiled`);
      return null;
    }
    if (projects.has(jiraProject.key)) return projects.get(jiraProject.key);
    const id = ensureProject({
      key: jiraProject.key,
      name: jiraProject.name || jiraProject.key,
      summary: null,
      url: browseUrl(issue) ? `${new URL(browseUrl(issue)).origin}/browse/${jiraProject.key}` : null,
    }, args, report, write);
    if (id) projects.set(jiraProject.key, id);
    return id;
  };

  for (const epic of epics) {
    const projectId = projectFor(epic);
    const id = ensureOrganizer({
      key: epic.key,
      projectId,
      name: epic.fields.summary || epic.key,
      summary: firstLine(bodyText(epic.fields.description)),
    }, args, report, write);
    if (id) organizers.set(epic.key, id);
  }

  /** The epic a story is filed under, if it was exported alongside it. */
  const organizerFor = (issue) => {
    const epicKey = epicKeyOf(issue, args.epicField, warn);
    if (!epicKey) return null;
    if (organizers.has(epicKey)) return organizers.get(epicKey);
    const known = db.organizerByExternalKey(`${NAMESPACE}:${epicKey}`);
    if (known) { organizers.set(epicKey, known.id); return known.id; }
    // Nothing is invented from a bare key: an epic named HELIO-1 in the sidebar
    // is worse than a task that is simply not grouped yet, and the next import
    // that includes the epic will file it.
    warn(`${issue.key}: epic ${epicKey} is not in the export, importing it ungrouped`);
    return null;
  };

  for (const issue of stories) {
    const projectId = projectFor(issue);
    const organizerId = projectId && projectId > 0 ? organizerFor(issue) : null;
    const id = upsertTask(issue, { projectId, parentId: null, organizerId }, args, report, write);
    if (id) { tasks.set(issue.key, id); taskProjects.set(issue.key, projectId); }
  }

  for (const issue of subtasks) {
    const parentKey = issue.fields.parent && issue.fields.parent.key;
    let parentId = parentKey ? tasks.get(parentKey) : null;
    let parentProject = parentKey && taskProjects.has(parentKey) ? taskProjects.get(parentKey) : undefined;
    if (!parentId && parentKey) {
      const known = db.taskByExternalKey(`${NAMESPACE}:${parentKey}`);
      parentId = known ? known.id : null;
      if (known) parentProject = known.project_id;
    }
    if (!parentId) {
      // Better a task at the top level than one dropped on the floor. A later
      // import that includes the parent will re-parent it, because the diff sees
      // parent_id change like any other field.
      warn(`${issue.key}: parent ${parentKey || "unknown"} is not in the export or the database, imported at the top level`);
    }
    // A subtask lives wherever its parent lives, which is what createTask
    // enforces on the way in. Working it out independently here would mean the
    // diff on every later run seeing a project change that is never going to
    // stick.
    const projectId = parentId && parentProject !== undefined ? parentProject : projectFor(issue);
    const id = upsertTask(issue, { projectId, parentId }, args, report, write);
    if (id) { tasks.set(issue.key, id); taskProjects.set(issue.key, projectId); }
  }

  if (args.comments) {
    for (const [key, taskId] of tasks) {
      importComments(byKey.get(key), taskId, report, write);
    }
  }

  return report;
}

/**
 * A Jira epic becomes a project, because Delphi has no organiser above a project
 * yet. Identity is projects.key, which is unique and, unlike ref, is not in
 * updateProject's allowlist, so nothing in the app can change it out from under
 * a re-import.
 */
/**
 * The epic, as an organizer inside the project the issues already live in.
 *
 * An epic used to become a project here, because organizers did not exist. They
 * do, and a project per epic was the wrong shape: it split one tracker across a
 * sidebar full of entries and left nothing holding them together. Matched on the
 * namespaced key rather than the name, so renaming an epic upstream moves the
 * shell rather than leaving the old one behind and building a second.
 */
function ensureOrganizer({ key, projectId, name, summary }, args, report, write) {
  const externalKey = `${NAMESPACE}:${key}`;
  const existing = db.organizerByExternalKey(externalKey);

  if (!existing) {
    report.organizers.created.push(key);
    if (!write || !projectId || projectId < 0) return pretend();
    return db.createExternalOrganizer({ externalKey, projectId, name, summary }).id;
  }

  const changed = {};
  if (existing.name !== name) changed.name = name;
  // Only fills a gap, the same bargain ensureProject makes: a summary written
  // here says more than the first line of a Jira description.
  if (summary && !existing.summary) changed.summary = summary;
  if (Object.keys(changed).length) {
    report.organizers.updated.push(key);
    if (write) db.updateOrganizer(existing.id, changed);
  } else {
    report.organizers.unchanged.push(key);
  }
  return existing.id;
}

function ensureProject({ key, name, summary, url }, args, report, write) {
  // Run through db's own normaliser as well as slug(), because --project-prefix
  // is whatever was typed on the command line and createProject stores the
  // normalised form. A prefix with an underscore in it would otherwise be looked
  // up in one shape and written in another, so every run after the first would
  // find nothing and then collide on the key it had already created.
  const projectKey = db.slugKey(args.projectPrefix + slug(key));
  const existing = db.projectByKey(projectKey);

  if (!existing) {
    report.projects.created.push(projectKey);
    if (!write) return pretend();
    const created = db.createProject({ key: projectKey, name, summary });
    if (url) { db.createLink({ projectId: created.id, label: key, url, kind: "jira" }); report.links.created++; }
    return created.id;
  }

  const changed = {};
  if (existing.name !== name) changed.name = name;
  // Only fills a gap. A summary written in Delphi says more than the first line
  // of a Jira description, and an import should not talk over it.
  if (summary && !existing.summary) changed.summary = summary;

  if (Object.keys(changed).length) {
    report.projects.updated.push(projectKey);
    if (write) db.updateProject(existing.id, changed);
  } else {
    report.projects.unchanged.push(projectKey);
  }

  if (url && write && !db.listLinks(existing.id).some((l) => l.url === url)) {
    db.createLink({ projectId: existing.id, label: key, url, kind: "jira" });
    report.links.created++;
  }
  return existing.id;
}

function upsertTask(issue, { projectId, parentId, organizerId = null }, args, report, write) {
  const fields = issue.fields;
  const externalKey = `${NAMESPACE}:${issue.key}`;
  const url = browseUrl(issue);

  let detail = bodyText(fields.description);
  if (args.backlink && url) detail = detail ? `${detail}\n\nJira: ${url}` : `Jira: ${url}`;

  const wanted = {
    title: fields.summary || issue.key,
    detail: detail || null,
    status: mapStatus(fields.status),
    priority: mapPriority(fields.priority),
    due: fields.duedate || null,
    assignee: person(fields.assignee),
    owner: person(fields.reporter),
    ref: issue.key,
    project_id: projectId ?? null,
    parent_id: parentId ?? null,
    // A subtask never carries one: it takes its parent's, which db.js enforces
    // on the way in, so sending one here would be a diff that never sticks.
    organizer_id: parentId ? null : (organizerId ?? null),
  };

  const existing = db.taskByExternalKey(externalKey);

  if (!existing) {
    report.tasks.created.push(issue.key);
    if (!write) return pretend();
    const created = db.createExternalTask({
      externalKey,
      source: NAMESPACE,
      projectId: wanted.project_id,
      parentId: wanted.parent_id,
      organizerId: wanted.organizer_id,
      title: wanted.title,
      detail: wanted.detail,
      status: wanted.status,
      priority: wanted.priority,
      due: wanted.due,
      assignee: wanted.assignee,
      owner: wanted.owner,
      ref: wanted.ref,
      completedAt: sqliteTime(fields.resolutiondate),
      actor: ACTOR,
    });
    return created.id;
  }

  // Only what actually differs, so a re-import that changes nothing leaves no
  // audit rows and no status events behind it.
  const changed = {};
  for (const [key, value] of Object.entries(wanted)) {
    if (String(existing[key] ?? "") !== String(value ?? "")) changed[key] = value;
  }
  // A subtask whose parent was not in this export keeps the parent it already
  // has, rather than being flattened by an export that knew less.
  if (changed.parent_id === null && existing.parent_id != null) delete changed.parent_id;
  // Same bargain for the grouping: an export that did not include the epic
  // should not un-file work that a fuller export already filed.
  if (changed.organizer_id === null && existing.organizer_id != null) delete changed.organizer_id;

  if (Object.keys(changed).length) {
    report.tasks.updated.push(`${issue.key} (${Object.keys(changed).join(", ")})`);
    if (write) db.updateTask(existing.id, changed, { actor: ACTOR });
  } else {
    report.tasks.unchanged.push(issue.key);
  }
  return existing.id;
}

function importComments(issue, taskId, report, write) {
  const container = issue && issue.fields && issue.fields.comment;
  const comments = (container && container.comments) || [];

  if (container && typeof container.total === "number" && container.total > comments.length) {
    report.warnings.push(`${issue.key}: the export carries ${comments.length} of ${container.total} comments`);
  }

  for (const comment of comments) {
    const body = bodyText(comment.body);
    if (!body) { report.comments.skipped++; continue; }
    // Jira comment ids are unique across the site, but the issue key is kept in
    // the identity anyway so a human can read what a row came from.
    const externalKey = `${NAMESPACE}:${issue.key}/comment/${comment.id}`;
    const author = person(comment.author) || person(comment.updateAuthor) || "unknown";

    const existing = db.commentByExternalKey(externalKey);
    if (!existing) {
      report.comments.created++;
      if (write) db.createExternalComment({ taskId, externalKey, body, author });
    } else if (existing.body !== body) {
      report.comments.updated++;
      if (write) db.updateExternalComment(existing.id, body);
    }
  }
}

const firstLine = (text) => {
  const line = String(text || "").split("\n").map((l) => l.trim()).find(Boolean);
  return line ? line.slice(0, 200) : null;
};

// Counts the fields Delphi has nowhere to put, so the run says what it left
// behind rather than letting someone find out months later.
const UNREPRESENTABLE = {
  labels: "labels",
  components: "components",
  fixVersions: "fix versions",
  versions: "affects versions",
  issuelinks: "issue links",
  attachment: "attachments",
  worklog: "worklogs",
  timetracking: "time tracking",
  watches: "watchers",
  votes: "votes",
  environment: "environment",
  resolution: "resolution reason",
  security: "security level",
};

function noteDropped(issues, report) {
  const count = (what) => { report.dropped[what] = (report.dropped[what] || 0) + 1; };
  for (const issue of issues) {
    const fields = (issue && issue.fields) || {};
    for (const [name, label] of Object.entries(UNREPRESENTABLE)) {
      const value = fields[name];
      if (value == null) continue;
      if (Array.isArray(value) ? value.length : typeof value === "object" ? Object.keys(value).length : true) count(label);
    }
    for (const name of Object.keys(fields)) {
      if (!/^customfield_/.test(name)) continue;
      if (fields[name] == null) continue;
      if (KNOWN_EPIC_FIELDS.includes(name)) continue;
      count("custom fields");
    }
    if (fields.status && fields.status.name && !STATUS_BY_CATEGORY[String((fields.status.statusCategory || {}).key || "")]) {
      count(`unmapped status "${fields.status.name}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printReport(report, args) {
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const line = (label, list) => {
    if (!list.length) return;
    console.log(`  ${label} ${list.length}`);
    for (const item of list.slice(0, 40)) console.log(`    ${item}`);
    if (list.length > 40) console.log(`    ... and ${list.length - 40} more`);
  };

  console.log(args.dryRun ? "\nDry run, nothing was written.\n" : "\nImported.\n");
  console.log("Projects");
  line("created", report.projects.created);
  line("updated", report.projects.updated);
  if (report.projects.unchanged.length) console.log(`  unchanged ${report.projects.unchanged.length}`);
  if (report.organizers.created.length || report.organizers.updated.length || report.organizers.unchanged.length) {
    console.log("Epics");
    line("created", report.organizers.created);
    line("updated", report.organizers.updated);
    if (report.organizers.unchanged.length) console.log(`  unchanged ${report.organizers.unchanged.length}`);
  }
  console.log("Tasks");
  line("created", report.tasks.created);
  line("updated", report.tasks.updated);
  if (report.tasks.unchanged.length) console.log(`  unchanged ${report.tasks.unchanged.length}`);
  console.log(`Comments\n  created ${report.comments.created}, updated ${report.comments.updated}, empty and skipped ${report.comments.skipped}`);
  if (report.links.created) console.log(`Links\n  created ${report.links.created}`);

  const dropped = Object.entries(report.dropped);
  if (dropped.length) {
    console.log("Not imported, because Delphi has nowhere to put it");
    for (const [what, count] of dropped.sort((a, b) => b[1] - a[1])) console.log(`  ${what} on ${count} issue(s)`);
  }
  if (report.warnings.length) {
    console.log("Warnings");
    for (const warning of report.warnings) console.log(`  ${warning}`);
  }
  console.log("");
}

// ---------------------------------------------------------------------------

/**
 * Stops before writing anything if the identity column is missing.
 *
 * Without it every lookup returns nothing, every issue looks new, and a second
 * run silently doubles the tracker. Failing here costs a message; failing later
 * costs an afternoon of deleting rows.
 */
function checkSchema() {
  const columns = (table) => db.handle().prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const missing = [];
  if (!columns("tasks").includes("external_key")) missing.push("tasks.external_key");
  if (!columns("comments").includes("external_key")) missing.push("comments.external_key");
  if (missing.length) {
    throw new Error(
      `${missing.join(" and ")} missing. Add the column to schema.sql and to LATER_COLUMNS in db.js, ` +
      "then open the app once so the column is applied. Without it a second import would duplicate everything."
    );
  }
  for (const fn of ["projectByKey", "taskByExternalKey", "createExternalTask", "commentByExternalKey",
                    "createExternalComment", "updateExternalComment"]) {
    if (typeof db[fn] !== "function") throw new Error(`db.js has no ${fn}. See docs alongside this script.`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.file && !args.jql)) { console.log(USAGE); return; }

  checkSchema();

  const issues = args.file
    ? issuesFromFile(path.resolve(args.file))
    : await issuesFromApi({ jql: args.jql, limit: args.limit, comments: args.comments });

  if (!issues.length) { console.log("Nothing to import."); return; }

  printReport(run(issues, args), args);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
