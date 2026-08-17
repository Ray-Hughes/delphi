// Markdown mirror of the memory notes.
//
// The database is the source of truth. This writes a plain-file copy of it that
// Obsidian, ripgrep, git or any editor can read, so the knowledge is not trapped
// in a file only this application understands.
//
// One way on purpose. Two-way sync between a database and a folder of files
// sounds better and is where these things break: two edits, no merge story, and
// whichever wrote last silently wins. If it turns out the writing happens mostly
// in Obsidian, we make that direction authoritative deliberately rather than by
// accident.

const fs = require("fs");
const path = require("path");
const os = require("os");
const paths = require("./paths");

// A folder beside the source in a checkout, and in Documents once installed. The
// whole point of the mirror is that a person opens it in Obsidian or an editor,
// and nobody browses to Application Support to do that.
const DEFAULT_VAULT = paths.defaultVault();

/** Turns a note title into something safe on disk without losing readability. */
function slug(text) {
  return String(text)
    .replace(/[\/\\:*?"<>|]/g, "-")   // characters filesystems reject
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "untitled";
}

function frontMatter(fields) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined || value === "") continue;
    // Quote anything that could be read as YAML syntax.
    const needsQuote = typeof value === "string" && /[:#\-{}\[\]&*!|>%@`]/.test(value);
    lines.push(`${key}: ${needsQuote ? JSON.stringify(value) : value}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * Turns references to other note titles into wiki links.
 *
 * Only exact title matches are linked, and longest titles first so a short title
 * that is a substring of a longer one does not steal the match. Anything already
 * inside brackets is left alone.
 */
function linkify(body, titles, selfTitle) {
  let out = body;
  const others = titles.filter((t) => t !== selfTitle).sort((a, b) => b.length - a.length);
  for (const title of others) {
    if (title.length < 8) continue; // too short to match safely
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<!\\[\\[)\\b${escaped}\\b(?!\\]\\])`, "g"), `[[${title}]]`);
  }
  return out;
}

function noteFile(vault, projectName, title) {
  return path.join(vault, slug(projectName || "General"), `${slug(title)}.md`);
}

/**
 * Writes the whole vault.
 *
 * A full rewrite rather than a diff: the dataset is small, and a rewrite cannot
 * drift out of step the way incremental updates do when one of them fails.
 * Files for notes that no longer exist are removed, so a deletion in the app is
 * a deletion here.
 */
function exportAll(db, vaultPath = DEFAULT_VAULT) {
  const vault = vaultPath.replace(/^~(?=$|\/)/, os.homedir());
  fs.mkdirSync(vault, { recursive: true });

  // Archived projects are written too. listProjects hides them, and the sweep at
  // the end removes every .md this pass did not write, so leaving them out meant
  // the first export after archiving deleted the project's notes from disk. The
  // rows survive in the database, but Settings tells the reader that archiving
  // deletes nothing and that restoring brings a project back with everything it
  // holds, and the copy they actually read in their editor was gone.
  const projects = [...db.listProjects(), ...db.listArchivedProjects()];
  const written = new Set();
  let notes = 0;

  const allTitles = [];
  for (const project of projects) {
    for (const note of db.listNotes(project.id)) allTitles.push(note.title);
  }

  for (const project of projects) {
    const projectNotes = db.listNotes(project.id);
    const dir = path.join(vault, slug(project.name));
    fs.mkdirSync(dir, { recursive: true });

    for (const note of projectNotes) {
      const file = noteFile(vault, project.name, note.title);
      const content = [
        frontMatter({
          title: note.title,
          project: project.name,
          kind: note.kind,
          pinned: note.pinned ? true : undefined,
          created: note.created_at,
          updated: note.updated_at,
          id: `note-${note.id}`,
        }),
        "",
        `# ${note.title}`,
        "",
        linkify(note.body || "", allTitles, note.title),
        "",
      ].join("\n");
      fs.writeFileSync(file, content);
      written.add(path.resolve(file));
      notes++;
    }

    // An index per project, so the vault is navigable rather than a flat pile,
    // and so open work is visible next to the knowledge about it.
    const tasks = db.listTasks({ projectId: project.id });
    const repos = db.listRepos ? db.listRepos(project.id) : [];
    const index = [
      frontMatter({ title: project.name, kind: "project-index", updated: new Date().toISOString().slice(0, 19).replace("T", " ") }),
      "",
      `# ${project.name}`,
      "",
      project.summary || "",
      "",
      repos.length ? "## Repositories\n" : "",
      ...repos.map((r) => `- ${r.is_primary ? "**" + r.name + "**" : r.name} - \`${r.path}\``),
      repos.length ? "" : "",
      "## Memory",
      "",
      ...projectNotes.map((n) => `- [[${n.title}]]${n.kind !== "note" ? ` - ${n.kind}` : ""}`),
      projectNotes.length ? "" : "_Nothing stored yet._\n",
      "## Open tasks",
      "",
      ...tasks.map((t) => {
        const bits = [t.priority === "high" ? "**high**" : null, t.status !== "todo" ? t.status : null, t.due ? `due ${t.due}` : null]
          .filter(Boolean).join(", ");
        return `- [ ] ${t.title}${bits ? ` _(${bits})_` : ""}`;
      }),
      tasks.length ? "" : "_None._\n",
    ].join("\n");

    const indexFile = path.join(dir, `${slug(project.name)}.md`);
    fs.writeFileSync(indexFile, index);
    written.add(path.resolve(indexFile));
  }

  // Remove files for notes that were deleted in the app.
  let removed = 0;
  const sweep = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sweep(full);
      else if (entry.name.endsWith(".md") && !written.has(path.resolve(full))) {
        fs.unlinkSync(full);
        removed++;
      }
    }
  };
  sweep(vault);

  return { vault, projects: projects.length, notes, removed };
}

module.exports = { exportAll, DEFAULT_VAULT };
