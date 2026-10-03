/**
 * Getting a fresh Workbench into a state where the code runs.
 *
 * The thing that trips newcomers is a new folder with no dependencies in it:
 * the tests fail, the app will not start, and nothing says why. So the setup
 * command is detected once per repo from its lock files, stored on the repo
 * row where a person can change it, and run as a `$ ` entry so its output is on
 * the Sheet like any other command.
 *
 * And the files git does not carry: .env and friends. Copied from the main
 * checkout, and never over anything already there, because a Workbench's own
 * .env may have been edited on purpose and a copy that replaced it would be a
 * silent loss of exactly the kind Workbenches exist to prevent.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_COPY = ".env,.env.local";

// One row per ecosystem, first lock file found wins within it. Order inside a
// row is most specific first: a repo with both poetry.lock and
// requirements.txt is a poetry project that also exports requirements.
const DETECT = [
  [["package-lock.json", "npm ci"],
   ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
   ["yarn.lock", "yarn install --frozen-lockfile"]],
  [["Gemfile.lock", "bundle install"]],
  [["uv.lock", "uv sync"],
   ["poetry.lock", "poetry install"],
   ["requirements.txt", "python3 -m pip install -r requirements.txt"]],
];

/**
 * The setup command for a checkout, or "" when there is nothing to run. A repo
 * with two ecosystems (a Rails app with a JS front end) gets both, joined so
 * the second only runs when the first worked.
 */
function detectSetup(repoPath) {
  const commands = [];
  for (const row of DETECT) {
    const hit = row.find(([file]) => {
      try { return fs.statSync(path.join(repoPath, file)).isFile(); } catch { return false; }
    });
    if (hit) commands.push(hit[1]);
  }
  return commands.join(" && ");
}

/** The copy list as given (comma separated text or an array), trimmed, empties dropped. */
function copyList(list) {
  const items = Array.isArray(list) ? list : String(list == null ? DEFAULT_COPY : list).split(",");
  return items.map((s) => String(s).trim()).filter(Boolean);
}

/**
 * Copies each listed file that exists in `from` into `to`.
 *
 * Never overwrites: COPYFILE_EXCL makes the refusal the filesystem's, so a file
 * that appears between a check and the copy is still not replaced. Only plain
 * files, and only paths that stay inside both folders, because the list is
 * typed by a person into a settings field and "../../.ssh/id_rsa" should be a
 * skipped line rather than a copy.
 */
function copyFiles(from, to, list) {
  const copied = [];
  const skipped = [];
  for (const rel of copyList(list)) {
    const source = path.resolve(from, rel);
    const target = path.resolve(to, rel);
    const inside = (root, p) => p === root || p.startsWith(root + path.sep);
    if (path.isAbsolute(rel) || !inside(path.resolve(from), source) || !inside(path.resolve(to), target)) {
      skipped.push({ file: rel, reason: "not a path inside the repository" });
      continue;
    }
    let stat;
    try { stat = fs.statSync(source); } catch { continue; }   // not there: nothing to copy, not worth a line
    if (!stat.isFile()) { skipped.push({ file: rel, reason: "not a file" }); continue; }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      copied.push(rel);
    } catch (error) {
      skipped.push({ file: rel, reason: error.code === "EEXIST" ? "already there, left as it is" : error.message });
    }
  }
  return { copied, skipped };
}

module.exports = { DEFAULT_COPY, DETECT, detectSetup, copyList, copyFiles };
