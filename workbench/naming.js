/**
 * What a Workbench's folder and branch are called.
 *
 * Pure, so the rules can be tested without a repository and so the app, the
 * MCP server and the command line can never name the same task's branch two
 * ways. Housekeeping depends on that: an orphaned worktree is only adopted back
 * when its branch matches ADOPTABLE, which is the shape branchName makes.
 */

const os = require("os");
const path = require("path");

const SLUG_MAX = 40;

/**
 * A title as a branch-safe word run: ASCII, lowercase, hyphen separated.
 *
 * NFKD first, so "Café déjà vu" becomes "cafe-deja-vu" rather than losing its
 * letters; whatever still is not ASCII after that (CJK, emoji) is dropped
 * rather than transliterated, because a guessed transliteration is a branch
 * name nobody can type. Clipped at a hyphen when one is close, so the name does
 * not end in half a word.
 */
function slug(text, max = SLUG_MAX) {
  const ascii = String(text == null ? "" : text)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (ascii.length <= max) return ascii;
  let cut = ascii.slice(0, max);
  const lastBreak = cut.lastIndexOf("-");
  if (lastBreak >= max / 2) cut = cut.slice(0, lastBreak);
  return cut.replace(/-+$/g, "");
}

/**
 * The username, made safe for a ref. Branches are prefixed with it so that a
 * shared remote shows whose work each branch is, and so two people working the
 * same task never push to one branch by accident.
 */
function defaultPrefix() {
  let name = "";
  try { name = os.userInfo().username || ""; } catch {}
  return cleanPrefix(name) || "delphi";
}

/** A prefix as git will accept it, or "" when nothing usable is left. */
function cleanPrefix(text) {
  return String(text || "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    .replace(/\.lock$/i, "")
    .slice(0, 40);
}

// A ticket key such as ABC-1234. Anything else in tasks.ref (a PR number, a
// URL, free text) is not a name a person would recognise in a branch list, so
// it does not lead.
const TICKET = /^[A-Za-z][A-Za-z0-9]+-\d+$/;

/** The ticket key a branch should lead with, upper cased, or null. */
function ticketOf(ref) {
  const text = String(ref || "").trim();
  return TICKET.test(text) ? text.toUpperCase() : null;
}

/**
 * `<prefix>/<ref>-<slug>` when the task has a ticket key, else
 * `<prefix>/<id>-<slug>`. A title with nothing ASCII in it gets "task" as its
 * slug, so the name still matches ADOPTABLE.
 */
function branchName({ prefix, taskId, title, ref }) {
  const lead = ticketOf(ref) || String(Number(taskId));
  const words = slug(title) || "task";
  return `${cleanPrefix(prefix) || defaultPrefix()}/${lead}-${words}`;
}

/** The folder's own name: always the task id, so a folder leads back to its task. */
function folderName({ taskId, title }) {
  return `${Number(taskId)}-${slug(title) || "task"}`;
}

/**
 * Where a repo's Workbenches live. A sibling of the checkout, never inside it
 * (it would show up in git status and every editor's file tree) and never in
 * the data folder (Application Support has a space in it and editors hide it).
 * DELPHI_WORKBENCH_DIR moves them all, one folder per repo underneath.
 */
function rootFor({ repoTop, overrideDir }) {
  const name = path.basename(repoTop);
  return overrideDir
    ? path.join(path.resolve(overrideDir), name)
    : path.join(path.dirname(repoTop), `${name}.workbenches`);
}

function folderFor({ repoTop, taskId, title, overrideDir }) {
  return path.join(rootFor({ repoTop, overrideDir }), folderName({ taskId, title }));
}

// What branchName makes. Housekeeping adopts an orphaned worktree only when
// its branch has this shape, so a worktree someone made by hand for other
// reasons is reported and left alone.
const ADOPTABLE = /^[^/]+\/(?:[A-Z][A-Z0-9]+-\d+|\d+)-[a-z0-9-]+$/;

module.exports = { SLUG_MAX, slug, defaultPrefix, cleanPrefix, ticketOf, branchName, folderName, rootFor, folderFor, ADOPTABLE };
