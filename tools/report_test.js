#!/usr/bin/env node
// The PR description and the status report (sheet/report.js), on both routes
// a shared store is handed, and workbench_pr's body, in process and through
// the real MCP server on both of its routes.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/report_test.js
//
// What matters most here is what is left out. The text goes to GitHub, so
// every case seeds something that must never reach it (a private entry, a
// run's output, its log, its folder, an HTML comment) and checks the words
// are nowhere in what comes back.
//
// Every database and repository is in a temp directory. git sees none of the
// owner's configuration, and gh is never run: the in-process cases hand the
// Workbench a git whose gh is a recorder, and the server is told DELPHI_GH=none.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delphi-report-")));
process.env.DELPHI_DATA_DIR = path.join(dir, "data");
delete process.env.DELPHI_DB_ID;
process.env.DELPHI_DB = path.join(dir, "data", "delphi.db");
fs.mkdirSync(process.env.DELPHI_DATA_DIR);
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}
const home = path.join(dir, "home");
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, ".gitconfig"),
  "[user]\n\tname = Delphi Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
Object.assign(process.env, {
  HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"), XDG_CONFIG_HOME: path.join(home, ".config"),
  GIT_AUTHOR_NAME: "Delphi Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Delphi Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
  DELPHI_GH: "none",
});
for (const name of ["DELPHI_WORKBENCH_DIR", "DELPHI_BRANCH_PREFIX", "GIT_DIR", "GIT_WORK_TREE", "DELPHI_ACTOR", "DELPHI_SESSION", "DELPHI_CLIENT", "DELPHI_SQLITE_ROUTE"]) delete process.env[name];

const db = require("../db");
const { makeSheetStore } = require("../sheet/store");
const { makeReport, checkBody, checkTitle, MAX_BODY, firstParagraph } = require("../sheet/report");
const scrub = require("../sheet/scrub");
const redact = (t) => scrub.redact(t).text;
const wgit = require("../workbench/git");
const { makeWorkbenchStore } = require("../workbench/store");
const { createWorkbench } = require("../workbench/workbench");
const { openServer } = require("../sheet/client");
const GIT = require("../git").findGit();

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
  return ok;
}
async function rejects(what, fn, pattern) {
  checks++;
  try { await fn(); } catch (error) {
    if (pattern.test(String(error.message))) return;
    failures++;
    console.error(`  FAIL ${what}\n       threw ${JSON.stringify(error.message)}\n       want  ${pattern}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${what}\n       did not throw`);
}
function section(name) { console.log(`\n${name}`); }
const has = (text, part) => String(text).includes(part);

// The binary route as the server takes it: literals in one pass, one sqlite3
// process a query, JSON back.
function findSqlite() {
  for (const c of [process.env.DELPHI_SQLITE, "/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"]) {
    if (c && fs.existsSync(c)) return c;
  }
  return "sqlite3";
}
const SQLITE = findSqlite();
const literal = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
};
function binarySql(query, params = []) {
  const statement = String(query).replace(/:p(\d+)/g, (m, n) => (Number(n) - 1 < params.length ? literal(params[Number(n) - 1]) : m));
  const file = path.join(dir, `q-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  fs.writeFileSync(file, [".timeout 5000", ".mode json", ".headers on", statement.endsWith(";") ? statement : statement + ";"].join("\n"));
  try {
    const out = execFileSync(SQLITE, [process.env.DELPHI_DB], { input: `.read ${file}\n`, encoding: "utf8" }).trim();
    return out ? JSON.parse(out) : [];
  } finally {
    fs.rmSync(file, { force: true });
  }
}

const git = (cwd, ...args) => execFileSync(GIT, ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// ---------------------------------------------------------------------------
// A repository with a local bare origin, so a branch can be pushed somewhere
// that is not anywhere.

const origin = path.join(dir, "origin.git");
const app = path.join(dir, "code", "app");
execFileSync(GIT, ["init", "--quiet", "--bare", "-b", "main", origin]);
fs.mkdirSync(path.dirname(app), { recursive: true });
execFileSync(GIT, ["clone", "--quiet", origin, app], { stdio: "ignore" });
write(path.join(app, "README.md"), "hello\n");
git(app, "add", "-A");
git(app, "commit", "--quiet", "-m", "first");
git(app, "push", "--quiet", "origin", "main");

// ---------------------------------------------------------------------------
// The Sheet

const project = db.createProject({ key: "rp", name: "Report test", path: app });
const sheets = makeSheetStore({ sql: db.sqlP, batch: db.batchP, actor: "tester", authorType: "human" });
const task = db.createTask({
  projectId: project.id, title: "Retry uploads",
  detail: "Uploads fail on a flaky VPN.<!--d:9 HIDDEN-COMMENT-->\n\nSecond paragraph, SHOULD-NOT-APPEAR.",
});
const empty = db.createTask({ projectId: project.id, title: "Nothing on its Sheet" });
// The reviewer's synthetic secrets, in every field that reaches the text.
const SECRETS = {
  aws: "AKIAIOSFODNN7EXAMPLE", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  vault: "hvs.CAESIJlFakeVaultTokenValue1234", npm: "npm_abcdefghijklmnopqrstuvwxyz0123456789", slack: "xoxb-123456789012-abcdefghij",
  gitlab: "glpat-abcdefghijklmnopqrst", ssn: "123-45-6789", cfile: "C12345678", filenum: "file number 87654321",
};
// Round five's leaks, through the whole report on both routes: a title, a
// question, an answer and a run, each carrying one.
const r5 = db.createTask({ projectId: project.id, title: "Fix login for dbpass=Hunter2x", detail: "curl https://api.va.gov/x?access_token=SEKRET12345 and SSN-123-45-6789" });
const r5ask = sheets.ask(r5.id, "Keep --verbose --password Hunter3x?", ["yes", "no"]);
sheets.decide(r5ask.id, "a", "API_TOKEN_PROD=Ab12Cd34Ef56 stays in the vault");
sheets.append({ taskId: r5.id, kind: "run", body: "mysql -pS3cret9 -e 'select 1'", meta: { state: "ok", code: 0, dur_ms: 5, ran_by: "delphi" } });
const R5_SECRETS = ["Hunter2x", "SEKRET12345", "6789", "Hunter3x", "Ab12Cd34Ef56", "S3cret9"];
const leaky = db.createTask({ projectId: project.id, title: `Rotate ${SECRETS.aws} for SSN ${SECRETS.ssn}`,
  detail: `Key ${SECRETS.jwt} on host api.va.gov in /Users/ray/notes\n## Checks\n- \`npm audit\` passed\n<!-\u0001-HIDDEN-REBUILT-->\u202eRTL\u200bZW and a dash \u2014 here` });
const lk = sheets.ask(leaky.id, `Use ${SECRETS.vault}?`, [`Yes ${SECRETS.npm}`, `No, C-file ${SECRETS.cfile}`]);
const lkd = sheets.decide(lk.id, "a", `because ${SECRETS.filenum} and ${SECRETS.slack}`);
sheets.update(lkd.id, { meta: { rejected: [{ label: `No ${SECRETS.gitlab}`, why: "mysql -u root -phunter2 db" }] } });
sheets.append({ taskId: leaky.id, kind: "run", body: `curl https://user:pw@10.0.0.5/x -H "Authorization: Bearer ${SECRETS.jwt}"`, meta: { state: "ok", code: 0, dur_ms: 5, ran_by: "delphi" } });

const ask1 = sheets.ask(task.id, "Which retry strategy?", ["exponential", "fixed"]);
sheets.decide(ask1.id, "a", "simpler to reason about");
const ask2 = sheets.ask(task.id, "Where should the limit live?", ["config", "code", "env"]);
const d2 = sheets.decide(ask2.id, "b");
sheets.update(d2.id, { meta: { rejected: [{ label: "config", why: "one more file to ship" }] } });
sheets.ask(task.id, "Ship behind a flag?", ["yes", "no"]);
// Private, three ways: an open question, a question whose answer is public,
// and an answer to a public question.
const ask4 = sheets.ask(task.id, "PRIVATE-OPEN-QUESTION?", ["a1", "a2"]);
sheets.update(ask4.id, { meta: { private: true } });
const ask5 = sheets.ask(task.id, "PRIVATE-ASKED?", ["b1", "b2"]);
sheets.update(ask5.id, { meta: { private: true } });
sheets.decide(ask5.id, "a", "PRIVATE-BY-ITS-QUESTION");
const ask6 = sheets.ask(task.id, "Public question, private answer?", ["c1", "c2"]);
const d6 = sheets.decide(ask6.id, "b", "PRIVATE-ANSWER-WHY");
sheets.update(d6.id, { meta: { private: true } });
sheets.append({ taskId: task.id, body: "PRIVATE-SAY", meta: { private: true } });
// Private however it is spelled, and meta nobody can read counts as private.
const ask7 = sheets.ask(task.id, "PRIVATE-SPELLED-TRUE?", ["d1", "d2"]);
sheets.update(ask7.id, { meta: { private: "TRUE" } });
db.handle().prepare("INSERT INTO comments (task_id, author, body, kind, meta) VALUES (?, 'tester', 'PRIVATE-UNREADABLE-META?', 'ask', '{not json')").run(task.id);
// An @handle an agent wrote is quoted, so the pull request notifies nobody.
const ask8 = sheets.ask(task.id, "Who reviews?", ["the team", "nobody"]);
sheets.decide(ask8.id, "a", "ask @octocat and @org/team, mail a@b.example, see #12 and acme/web#7");

const run = (body, meta) => sheets.append({ taskId: task.id, kind: "run", body, meta });
// What sheet/run.js writes on a run it ran itself; the only kind of pass the
// description calls "passed" without saying who said so.
const RUNNER = { ran_by: "delphi", runner_pid: 4242, runner_host: "test-host" };
run("GITHUB_TOKEN=ghp_SECRETSECRETSECRETSECRET1234 npm run deploy -- --password hunter2SECRET", { state: "ok", code: 0, exit: 0, dur_ms: 5 });
run("npm test", { state: "ok", code: 0, exit: 0, dur_ms: 4200, out: "SECRET-OUTPUT", log: "/tmp/SECRET-LOG.log", cwd: "/Users/SECRET-CWD", ...RUNNER });
// A forged pass: ok, but exit code 1. And a pass with no duration, then one
// still running after a pass, which has no result yet.
run("npm run forged", { state: "ok", code: 1, exit: 1, dur_ms: 10 });
run("npm run nodur", { state: "ok", code: 0, exit: 0, dur_ms: null, ...RUNNER });
run("npm run again", { state: "ok", code: 0, exit: 0, dur_ms: 10, ...RUNNER });
run("npm run again", { state: "running", ...RUNNER });
run("npm run lint", { state: "fail", code: 1, exit: 1, dur_ms: 900, out: "SECRET-LINT-OUTPUT" });
run("make build", { state: "ok", code: 0, exit: 0, dur_ms: 61000 });
run("make build", { state: "fail", code: 2, exit: 2, dur_ms: 3000 });
run("npm run e2e", { state: "running" });
run("curl PRIVATE-RUN-COMMAND", { state: "ok", code: 0, exit: 0, dur_ms: 10, private: true });
// A public pass, then a private failure of the same command: the pass is not
// the latest result, so it is not reported either.
run("npm run audit", { state: "ok", code: 0, exit: 0, dur_ms: 10 });
run("npm run audit", { state: "fail", code: 1, exit: 1, dur_ms: 10, private: true });
db.handle().prepare(`INSERT INTO handoffs (task_id, project_id, to_harness, request, kind, state, status, cost_usd, tokens_in, tokens_out,
                     started_at, finished_at, updated_at)
                     VALUES (?, ?, 'claude-code', 'w', 'do', 'done', 'harvested', 1.25, 30000, 10000,
                     datetime('now', '-20 minutes'), datetime('now', '-8 minutes'), datetime('now', '-8 minutes'))`).run(task.id, project.id);
db.updateTask(task.id, { status: "done" });
const doing = db.createTask({ projectId: project.id, title: "Still going" });
db.updateTask(doing.id, { status: "doing" });
sheets.ask(doing.id, "Which region first?", ["east", "west"]);
db.handle().exec("PRAGMA wal_checkpoint(TRUNCATE)");

const STAT = { files: [{ path: "src/upload.js", added: 10, deleted: 2 }, { path: "test/upload_test.js", added: 2, deleted: 1 }, { path: "logo.png", added: null, deleted: null }] };
const NEVER = ["PRIVATE", "SECRET", "HIDDEN-COMMENT", "<!--", "SHOULD-NOT-APPEAR", "npm run lint", "make build", "npm run e2e", "npm run audit", "npm run again", "npm run forged` passed"];

// ---------------------------------------------------------------------------

const quiet = db.createProject({ key: "rp-quiet", name: "Quiet" });
async function reports() {
const answers = {};
for (const [route, sql] of [["node:sqlite", db.sqlP], ["sqlite3 binary", binarySql]]) {
  const report = makeReport({ sql });

  section(`${route}: the PR description`);
  const text = report.prDescription(task.id, { diffStat: STAT });
  answers[route] = text;
  check("starts with the Summary and the title", text.startsWith("## Summary\n\nRetry uploads\n\nUploads fail on a flaky VPN.\n"), true);
  check("each section, in order", ["## Summary", "## Why", "## Checks", "## Open questions", "## Changes", "## Cost (estimate)"].map((h) => text.indexOf(h)).every((n, i, a) => n >= 0 && (i === 0 || n > a[i - 1])), true);
  check("a decision with its question and why", has(text, "- **Which retry strategy?** exponential. simpler to reason about\n  Not chosen: fixed."), true);
  check("rejected alternatives from the decide entry", has(text, "- **Where should the limit live?** code.\n  Not chosen: config: one more file to ship."), true);
  check("a pass Delphi ran: command and duration", has(text, "- `npm test` passed in 4s\n"), true);
  check("a pass an agent reported says who, and its credentials are taken out", has(text, "## Checks\n\n- `GITHUB_TOKEN=[redacted] npm run deploy -- --password [redacted]` reported passing by tester in 0s\n"), true);
  check("an unknown duration is left out, not 0s", has(text, "- `npm run nodur` passed\n"), true);
  check("ok with a nonzero exit code is not a pass", has(text, "npm run forged"), false);
  check("a run still going after a pass has no result yet", has(text, "npm run again"), false);
  check("@handles are quoted, an email is not", has(text, "ask `@octocat` and `@org/team`, mail a@b.example, see `#12` and `acme/web#7`"), true);
  check("redaction, more shapes", ["curl -u me:pw1 -H 'X-Api-Key: 4f9a2c7e1b0d4f9a2c7e' -H 'Cookie: a=b; c=d' https://h"].map(redact),
    ["curl -u me:[redacted] -H 'X-Api-Key: [redacted]' -H 'Cookie: [redacted]' https://h"]);

  section(`${route}: secrets, numbers and what is flagged`);
  const r5Draft = report.prDraft(r5.id);
  check("round five's leaks are redacted in the title, description, decision and run", R5_SECRETS.filter((v) => has(`${r5Draft.title}\n${r5Draft.body}`, v)), []);
  check("and the internal host is still there to be flagged", has(r5Draft.body, "api.va.gov"), true);
  const lkDraft = report.prDraft(leaky.id, { prefix: "ABC-1" });
  const lkAll = `${lkDraft.title}\n${lkDraft.body}`;
  answers[`${route} leaky`] = lkAll;
  check("no secret or number in the title or body", Object.entries(SECRETS).filter(([, v]) => has(lkAll, v.replace(/^file number /, ""))).map(([k]) => k), []);
  check("nor the password in a URL or a mysql flag", [has(lkAll, "user:pw@"), has(lkAll, "hunter2")], [false, false]);
  check("the title is one line, with its prefix, redacted", lkDraft.title, "ABC-1 Rotate [redacted] for SSN [redacted]");
  check("flagged things are kept, for the person to judge", [has(lkAll, "api.va.gov"), has(lkAll, "/Users/ray/notes"), has(lkAll, "10.0.0.5")], [true, true, true]);
  check("and flagged", scrub.flagWords(scrub.flag(lkAll)), "1 internal host, 1 private address, 1 home folder");
  check("a heading in the detail is escaped, not a section", [has(lkDraft.body, "\n\\## Checks\n"), lkDraft.body.split("\n").filter((l) => l === "## Checks").length], [true, 1]);
  check("a comment rebuilt from a control character is gone", has(lkAll, "HIDDEN-REBUILT"), false);
  check("bidi and zero-width characters are gone", /[\u202e\u200b]/.test(lkAll), false);
  check("dashes are hyphens", has(lkAll, "a dash - here"), true);
  check("an unclosed fence in the first paragraph is cut", firstParagraph("Intro\n```js\nconst a = 1;\n\nmore"), "Intro");
  check("control characters are dropped", firstParagraph("a\u001b]0;evil\u0007b\u009bc\tok"), "a]0;evilbc\tok");
  check("a closed one is kept", firstParagraph("Intro\n```\nx\n```\n\nmore"), "Intro\n```\nx\n```");
  check("an open question with its options", has(text, "- Ship behind a flag? (yes / no)"), true);
  check("the diff stat", has(text, "3 files changed, +12 -3.\n\n- `src/upload.js` +10 -2\n- `test/upload_test.js` +2 -1\n- `logo.png` (binary)"), true);
  check("the cost, called an estimate", has(text, "Estimate from Delphi's ledger, not a bill: 1 run, 12m agent time, 40k tokens (30k in, 10k out), $1.25 API-equivalent."), true);
  check("ends with where it came from", text.endsWith(`From Delphi task ${task.id}.\n`), true);
  check("nothing private, no output, no log, no comment, no failing or running run", NEVER.filter((w) => has(text, w)), []);
  check("the question of a private answer is not shown as decided", has(text, "Public question, private answer?"), false);
  check("no em or en dashes", /[\u2013\u2014\u2212]/.test(text), false);

  section(`${route}: the empty Sheet`);
  const bare = report.prDescription(empty.id);
  check("a summary and a sentence", bare, `## Summary\n\nNothing on its Sheet\n\nNothing was decided, asked or checked on this task's Sheet yet.\n\nFrom Delphi task ${empty.id}.\n`);
  check("a string diff stat is fenced", has(report.prDescription(empty.id, { diffStat: " 1 file changed, 2 insertions(+)" }), "## Changes\n\n```\n1 file changed, 2 insertions(+)\n```"), true);
  await rejects("an unknown task", () => report.prDescription(999999), /No task 999999/);
  await rejects("a task id that is not one", () => report.prDescription("1e0"), /whole number/);

  section(`${route}: the status report`);
  const today = sql("SELECT date('now', 'localtime') AS d")[0].d;
  const st = report.statusReport(project.id, { from: today, to: today });
  answers[`${route} status`] = st;
  check("a title with the range", st.startsWith(`# Report test: status, ${today} to ${today}\n`), true);
  check("done in the range, no #N to link a GitHub issue", has(st, `## Done\n\n- Retry uploads (task ${task.id})\n`), true);
  check("in progress", has(st, `## In progress now\n\n- Still going (task ${doing.id})\n`), true);
  check("decisions, with their task", has(st, `- **Which retry strategy?** exponential. simpler to reason about (task ${task.id}, Retry uploads)`), true);
  check("runs counted, private ones too, and who ran them", has(st, "## Checks\n\n- Delphi ran 5 runs: 5 passed, 0 failed.\n- Agents reported 8 runs: 4 passing, 4 failing.\n- Across 3 tasks.\n"), true);
  check("open questions now, on open tasks only", [has(st, `## Open questions now\n\n`), has(st, `- Which region first? (task ${doing.id}, Still going)`), has(st, "Ship behind a flag?")], [true, true, false]);
  check("no secret in the status report either", Object.values(SECRETS).filter((v) => has(st, v.replace(/^file number /, ""))), []);
  check("the cost, called an estimate", has(st, "## Cost (estimate)\n\nEstimate from Delphi's ledger"), true);
  check("nothing private, no output", ["PRIVATE", "SECRET", "<!--"].filter((w) => has(st, w)), []);
  check("defaults to the last seven days", report.statusReport(project.id).startsWith(`# Report test: status, ${sql("SELECT date('now', 'localtime', '-6 days') AS d")[0].d} to ${today}`), true);
  check("a past range: what is in progress now, and no question asked after it", report.statusReport(project.id, { from: "2001-01-01", to: "2001-01-02" }),
    `# Report test: status, 2001-01-01 to 2001-01-02\n\n## In progress now\n\n- Still going (task ${doing.id})\n\n## Open questions now\n\n- Which region first? (task ${doing.id}, Still going)\n`);
  check("and a project with nothing says so", report.statusReport(quiet.id, { from: today, to: today }),
    `# Quiet: status, ${today} to ${today}\n\nNothing was finished, started, decided or run in this project in these dates.\n`);
  await rejects("a date that is not one", () => report.statusReport(project.id, { from: "last week" }), /date like/);
  await rejects("a day that does not exist", () => report.statusReport(project.id, { from: "2026-13-45", to: "2026-12-01" }), /real date/);
  await rejects("from after to", () => report.statusReport(project.id, { from: "2026-02-02", to: "2026-02-01" }), /after/);
  await rejects("an unknown project", () => report.statusReport(999999), /No project/);
}
section("both routes");
check("write the same description", answers["node:sqlite"], answers["sqlite3 binary"]);
check("and the same status report", answers["node:sqlite status"], answers["sqlite3 binary status"]);
check("and redact the same", answers["node:sqlite leaky"], answers["sqlite3 binary leaky"]);
check("a body a person wrote is redacted too", checkBody(`see ${SECRETS.aws}`), "see [redacted]");
check("so is a title, made one line", checkTitle(`Fix\nfor ${SECRETS.ssn}`), "Fix for [redacted]");
check("a look-alike hyphen or a zero-width character does not hide one", [checkBody("123\u201145\u20116789"), checkBody("AKIAIOSFODNN7\u200bEXAMPLE")], ["[redacted]", "[redacted]"]);
check("nor does JSON, YAML or a bare bearer token", ['{"password": "hunter2!"}', "client_secret: 9f8e7d6c5b4a39281706f5e4", "Bearer abcdefghij0123456789xyz", "db_password: hunter22", '"Authorization": "Basic dXNlcjpwYXNz"', "ssn 123.45.6789"].map(redact),
  ['{"password": [redacted]}', "client_secret: [redacted]", "Bearer [redacted]", "db_password: [redacted]", '"Authorization": "Basic [redacted]"', "ssn [redacted]"]);

section("high confidence only: what must never be redacted");
// Real titles and settings the first version mangled. A guess is flagged,
// never blanked: damaging a real title is a bug.
const KEEP = ["Perf pass: cut the board's paint time", "Refine session: decide the layout", "bypass: true", "compass: north",
  "max_tokens: 4096", "tokens: 40k", "token_count: 1200", "session_id: 4f9a2c", "AUTH_MODE=oauth", "AWS_REGION=us-east-1",
  "oauth=enabled", "C1234567", "pip install sk-learn", "mysql -port 3306", "password: <your password>", "token: ${GITHUB_TOKEN}",
  "secret: true", "adminPassword: x", "see 123 45 6789", "build 123456789",
  "PWD=/home/runner/work/app", "password: (none)", "password: not-set", "password: same-as-above", "token: stored-in-vault-now",
  "x\u00b2 at 10\u207b\u00b3, Delphi\u2122, \u00bd done", "code `&#65;` and `a\\_b` stays", "Authorization: required",
  "Authorization: add-role-checks", "secret = process.env.SECRET_KEY_V2",
  "pip install sk-learn-extras-2", "file 20261106", "emoji \u26a0\ufe0f and \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 stay",
  "Bearer $TOKEN", "curl -u me:$PASS", "password: ${DB_PASS}", "password: {{ vault.pw }}", "password: <your password>", "\u4fee\u6b63\uff1a\u8a8d\u8a3c\uff08\u6e08\uff09"];
check("each is left exactly as written", KEEP.filter((t) => scrub.scrub(t) !== t), []);
check("credentials named with hyphens, dots or a _pass suffix, and a bare Authorization value, are redacted",
  ["api-key: 4f9a2c7e1b0d4f9a2c7e", "spring.datasource.password=S3cr3t!x", "Authorization: 4f9a2c7e1b0d4f9a2c7e9b1c", "DB_PASS=Xk9#mQ2v!"].map((t) => scrub.scrub(t)),
  ["api-key: [redacted]", "spring.datasource.password=[redacted]", "Authorization: [redacted]", "DB_PASS=[redacted]"]);
// Built at run time, so nothing committed looks like a live token.
const ghTok = ["gh", "p_"].join("") + "A1b2C3d4E5f6G7h8I9j0K1l2";
check("camelCase and run-together key names are credentials too",
  ["adminPassword: Hunter2x", "clientSecret=abc123XYZ", "accessToken: 9f8e7d6c", "PGPASSWORD=Hunter2x", "SecretKey=Ab12Cd34", "accesskey=abcd1234"].map((t) => scrub.scrub(t)),
  ["adminPassword: [redacted]", "clientSecret=[redacted]", "accessToken: [redacted]", "PGPASSWORD=[redacted]", "SecretKey=[redacted]", "accesskey=[redacted]"]);
check("prefixed, capital-run and run-together names, flags and => are credentials too",
  ["'password' => 'Hunter2x'", "_authToken=abc123def", "2fa_token=abc123", "-Dspring.datasource.password=Hunter2x", "--client-secret abc123",
   "DBPassword=Hunter2x", "JWTSecret=abc123", "pgpassword=Hunter2x", "githubtoken=abc123x", "DBPASS=Xk9mQ2v"].map((t) => scrub.scrub(t)),
  ["'password' => [redacted]", "_authToken=[redacted]", "2fa_token=[redacted]", "-Dspring.datasource.password=[redacted]", "--client-secret [redacted]",
   "DBPassword=[redacted]", "JWTSecret=[redacted]", "pgpassword=[redacted]", "githubtoken=[redacted]", "DBPASS=[redacted]"]);
check("a number after \"number is\" is still one", ["social security number is 123456789", "file number is 12345678"].map((t) => scrub.scrub(t)),
  ["social security number is [redacted]", "file number is [redacted]"]);
check("but BYPASS, a header phrase and a flag that is not one stay",
  ["BYPASS=1x", "Authorization: Add role checks", "--token-file ./x", "--max-tokens 4096", "--password --other"].filter((t) => scrub.scrub(t) !== t), []);
section("round five");
check("a query string's credential is not swallowed by the name before it", ["curl https://api.va.gov/x?access_token=SEKRET12345", "https://h/cb?code=abc&client_secret=Zx9yW8vU7t", "a=b&password=Hunter2x"].map((t) => scrub.scrub(t)),
  ["curl https://api.va.gov/x?access_token=[redacted]", "https://h/cb?code=abc&client_secret=[redacted]", "a=b&password=[redacted]"]);
check("nor a flag's value by the flag before it", ["--verbose --password Hunter2x", "-v --token Ab12Cd34Ef56"].map((t) => scrub.scrub(t)), ["--verbose --password [redacted]", "-v --token [redacted]"]);
check("mysql and mariadb with -p first", ["mysql -pHunter2", "mysqldump -pS3cret db", "mysqlcheck -u r -pS3cret9", "mariadb -pS3cret9", "mariadb-dump -pS3cret9"].map((t) => scrub.scrub(t)),
  ["mysql -p[redacted]", "mysqldump -p[redacted] db", "mysqlcheck -u r -p[redacted]", "mariadb -p[redacted]", "mariadb-dump -p[redacted]"]);
check("a key word with a qualifier after it is still one", ["SECRET_KEY_BASE=Ab12Cd34Ef56", "password2=Hunter2x", "API_TOKEN_PROD=Ab12Cd34Ef56", "dbpass=Hunter2x", "bypass=Hunter2x"].map((t) => scrub.scrub(t)),
  ["SECRET_KEY_BASE=[redacted]", "password2=[redacted]", "API_TOKEN_PROD=[redacted]", "dbpass=[redacted]", "bypass=Hunter2x"]);
check("split shapes are rejoined", ["password\u200d=Hunter2x", "SSN-123-45-6789", "SSN\u2014123-45-6789", `${ghTok}_old`, "password: <Hunter2x>", "SSN 123\u300045\u30006789", `Pasted\u2014${ghTok}`].map((t) => scrub.scrub(t)),
  ["password=[redacted]", "SSN-[redacted]", "SSN-[redacted]", "[redacted]_old", "password: [redacted]", "SSN [redacted]", "Pasted-[redacted]"]);
check("prose after a label is flagged, not redacted", ["Token: Refresh flow", "Password: Reset link", "Token: JWT", "token: 4096 max", "Token:\nRefresh flow"].filter((t) => scrub.scrub(t) !== t), []);
check("and flagged", scrub.flag("Token: Refresh flow").map((f) => f.kind), ["credential"]);
check("a private key's header mentioned in prose keeps the text after it", scrub.scrub("-----BEGIN PRIVATE KEY----- is the header line\nand this text stays"), "-----BEGIN PRIVATE KEY----- is the header line\nand this text stays");
check("a key with its END goes to the END; one without, to the end of its body", [
  scrub.scrub("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nabc\n-----END PRIVATE KEY-----\nafter"),
  scrub.scrub("-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\nZZZZ\n\nnext para")], ["[redacted]\nafter", "[redacted]\n\nnext para"]);
check("a fullwidth colon is matched as a colon and never changed in the text", [scrub.scrub("password\uff1aHunter2x"), scrub.strip("\u5bc6\u7801A\uff1a\u786e\u8ba4")], ["password\uff1a[redacted]", "\u5bc6\u7801A\uff1a\u786e\u8ba4"]);
// Copilot's pass on round five. The JWT is built from parts at run time.
const jwtTok = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].join(".");
check("a JWT after a word and a hyphen, or two hyphens", [`token-${jwtTok}`, `--${jwtTok}`].map((t) => scrub.scrub(t)), ["token-[redacted]", "--[redacted]"]);
check("a fullwidth colon after a number's label or a header name", ["file number\uff1a87654321", "C-file\uff1aC12345678", "SSN\uff1a123 45 6789", "Authorization\uff1aBearer abcdef0123456789abcdef01"].map((t) => scrub.scrub(t)),
  ["file number\uff1a[redacted]", "C-file\uff1a[redacted]", "SSN\uff1a[redacted]", "Authorization\uff1aBearer [redacted]"]);
check("a key with no END stops at its last whole line", scrub.scrub("-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\nand this text stays"), "[redacted]\nand this text stays");
check("second opinion's shape catches a key with no END too", (() => { const re = new RegExp(scrub.SECRET_SHAPES[4].source); return re.test("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nabc"); })(), true);
section("round six");
check("an SSN or file number under its own key", ["ssn=123456789", '"ssn": "123456789"', "file_number: 123456789"].map((t) => scrub.scrub(t)),
  ["ssn=[redacted]", '"ssn": [redacted]', "file_number: [redacted]"]);
check("pw, pwd and pass alone, AccountKey and password_confirmation, when the value is secret-shaped",
  ["Server=db;Uid=sa;Pwd=Hunter2x;", "pw=Hunter2x", "pass=Hunter2x", "AccountKey=Ab12Cd34Ef56Gh78==", "password_confirmation=Hunter2x"].map((t) => scrub.scrub(t)),
  ["Server=db;Uid=sa;Pwd=[redacted];", "pw=[redacted]", "pass=[redacted]", "AccountKey=[redacted]", "password_confirmation=[redacted]"]);
check("and pass in prose is neither redacted nor flagged", [scrub.scrub("Perf pass: cut the time"), scrub.flag("Perf pass: cut the time").length], ["Perf pass: cut the time", 0]);
check("a YAML block under a credential key is redacted whole, and an aligned value",
  ["password: |\n  Hunter2x\n  more\nnext: 1", "  db:\n    password: >-\n      abc\n      def9\n    user: x", "password:        Hunter2x"].map((t) => scrub.scrub(t)),
  ["password: |\n[redacted]\nnext: 1", "  db:\n    password: >-\n[redacted]\n    user: x", "password:        [redacted]"]);
const pemBody = ["MIIEvQIBADANBgkqhkiG9w0BAQEF", "AASCBKcwggSjAgEAAoIBAQC7"].join("");
check("JSON-escaped values, one-line and escaped keys, camelCase qualifiers and Stripe keys", [
  '{\\"password\\":\\"Hunter2x\\"}', `-----BEGIN PRIVATE KEY-----${pemBody} after`, `x "-----BEGIN PRIVATE KEY-----\\n${pemBody}\\nabc" y`,
  "secretKeyBase=Ab12Cd34Ef56", ["sk", "live", "abcd1234efgh5678ijkl"].join("_"), ["rk", "test", "abcd1234efgh5678ijkl"].join("_")].map((t) => scrub.scrub(t)),
  ['{\\"password\\":[redacted]}', "[redacted] after", 'x "[redacted]" y', "secretKeyBase=[redacted]", "[redacted]", "[redacted]"]);
check("ordinary text keeps its shape", ["[x](https://h?token=Ab12Cd34Ef56)", "Token: OAuth2", "Max token: 128000", "use -----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY----- around the body"].map((t) => scrub.scrub(t)),
  ["[x](https://h?token=[redacted])", "Token: OAuth2", "Max token: 128000", "use -----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY----- around the body"]);
check("and the label-shaped ones are flagged", ["Token: OAuth2", "Max token: 128000"].map((t) => scrub.flag(t).map((f) => f.kind)), [["credential"], ["credential"]]);
check("a ) inside a password is part of it; one closing a link is not", ["password=Ab)12xyz9Q", "[x](https://h?token=Ab12Cd34Ef56)"].map((t) => scrub.scrub(t)),
  ["password=[redacted]", "[x](https://h?token=[redacted])"]);
check("a word and a number under a secret key is a password, a thing's name is not", ["secret: Welcome1", "client_secret=Summer24", "API_TOKEN=Passw0rd", "token: SHA256"].map((t) => scrub.scrub(t)),
  ["secret: [redacted]", "client_secret=[redacted]", "API_TOKEN=[redacted]", "token: SHA256"]);
check("second_opinion catches a JWT after a hyphen", require("../agent/second_opinion").redact(`token-${jwtTok}`).text, "token-[redacted]");
{
  const big = "password: Hunter2x and api.va.gov, /Users/ray/x, Token: OAuth2 ".repeat(1100).slice(0, 65536);
  const t0 = process.hrtime.bigint();
  const ready = scrub.prepare(big);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check(`a preview's whole pass over 64KB is under 50ms (${ms.toFixed(1)}ms)`, ms < 50 && ready.count > 0 && ready.found.length > 0, true);
}
check("a keycap keeps its selector", scrub.strip("1\ufe0f\u20e3 \u26a0\ufe0f"), "1\ufe0f\u20e3 \u26a0\ufe0f");
check("under a credential key, anything but a reference or a plain word is redacted",
  ["password: Admin.Pa55word", "password=get(Hunter2x)", "token = self.get_token_v2()"].map((t) => scrub.scrub(t)),
  ["password: [redacted]", "password=[redacted]", "token = [redacted]"]);
check("a token after a hyphen, an em dash or a fullwidth colon is still a token",
  [`- ${ghTok}`, `\u2014${ghTok}`, "password\uff1aHunter2x"].map((t) => scrub.scrub(t)), ["- [redacted]", "-[redacted]", "password\uff1a[redacted]"]);
check("a backtick in one paragraph does not shelter a comment from one in another",
  scrub.strip("a `x\n\n<!--hidden-->\n\ny` b"), "a `x\n\n\n\ny` b");
check("a reference is flagged, not redacted", scrub.flag("Bearer $TOKEN").map((f) => [f.kind, f.text, f.index]), [["credential", "$TOKEN", 7]]);
check("a doubtful value is flagged where it is, not at its first occurrence",
  scrub.flag("hunter and then password: hunter").filter((f) => f.kind === "credential").map((f) => f.index), [26]);
check("the doubtful ones are flagged instead", scrub.flagWords(scrub.flag("password: wordpass, see 123 45 6789, C1234567, build 123456789")),
  "1 possible credential, 3 possible SSNs or file numbers");
check("a code span holding <!-- keeps it and everything after it", scrub.strip("use `<!-- x` here\n\nand the rest stays"), "use `<!-- x` here\n\nand the rest stays");
check("and so does a fence", scrub.strip("```\n<!-- in code\n```\nafter"), "```\n<!-- in code\n```\nafter");
check("an opener with no closer loses only itself", scrub.strip("a <!-- b"), "a  b");

section("evasions folded before matching");
check("look-alike dashes make a comment, which goes", scrub.strip("<!\u2010\u2010hidden-->shown"), "shown");
check("fullwidth, entities, soft hyphens and escaped underscores", [
  "\uff21\uff2b\uff29\uff21\uff29\uff2f\uff33\uff26\uff2f\uff24\uff2e\uff2e\uff17\uff25\uff38\uff21\uff2d\uff30\uff2c\uff25",
  "&#65;KIAIOSFODNN7EXAMPLE", "AKIA\u00adIOSFODNN7\ufe0fEXAMPLE", "github\\_pat\\_11ABCDEFGHIJKLMNOPQRSTUV_xyz"].map((t) => scrub.scrub(t)),
  ["[redacted]", "[redacted]", "[redacted]", "[redacted]"]);
check("Google keys, Slack webhooks and S3 signatures", ["AIza" + "Sy" + "A1234567890abcdefghijklmnopqrstuv",
  "https://hooks.slack.com/services/" + ["T", "0".repeat(8), "/B", "0".repeat(8), "/", "x".repeat(24)].join(""), "u?X-Amz-Signature=" + "ab12".repeat(16)].map((t) => scrub.scrub(t)),
  ["[redacted]", "[redacted]", "u?X-Amz-Signature=[redacted]"]);
check("a URL password goes and its internal host is still flagged", [scrub.scrub("push https://u:pw@va.ghe.com/x"), scrub.flagWords(scrub.flag(firstParagraph("push https://u:pw@va.ghe.com/x")))],
  ["push https://u:[redacted]@va.ghe.com/x", "1 internal host"]);
check("the length is checked after redaction", (() => { try { checkBody("password: hunter2! ".repeat(Math.ceil(MAX_BODY / 19))); return "no"; } catch (e) { return /at most/.test(e.message); } })(), true);

section("a 64KB hostile line, every rule, in time");
// Each pattern is bounded and anchored; one that is not takes seconds here.
const HOSTILE = ["-----BEGIN PRIVATE KEY-----AAAA", "-----BEGIN PRIVATE KEY-----\\n", "password: |\n", "password: |\n ", '\\"password\\":', "ssn=", "pw=", "-eyJa", "a-eyJaaaaaaaaa.eyJ", "eyJaaaaaaaa.", "--eyJ", "x=", "a:", "a=b&", "--v ", "mysql -p", "-----BEGIN PRIVATE KEY-----\n", "SSN-1", " -u a:b", "a:b@", "password: ", "-eyJ", "+eyJ", "eyJ.", "a", "a.", "password=", "@", "<!--", "`", "-", "1", "/Users/", "a_", "x-", "cookie: ", "mysql ", "http://", "a:", "&#65;", "``a", "1-", " ~/", "bearer ", "x-api-key: ", "<!-\u2010", "\uff21"]
  .map((unit) => unit.repeat(Math.ceil(65536 / unit.length)).slice(0, 65536));
let slowest = { ms: 0, what: null };
for (const line of HOSTILE) {
  for (const fn of ["strip", "redact", "flag"]) {
    const t0 = process.hrtime.bigint();
    scrub[fn](line);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms > slowest.ms) slowest = { ms, what: `${fn}(${JSON.stringify(line.slice(0, 10))}...)` };
  }
}
for (const line of ["a.".repeat(32768), "@a".repeat(32768), "#1/".repeat(21846), "--eyJ".repeat(13108), "x=".repeat(32768)]) {
  const t0 = process.hrtime.bigint();
  firstParagraph(line);
  // Its time is the point here, not whether it fits GitHub's limit.
  try { checkBody(line.slice(0, 65000)); } catch {}
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (ms > slowest.ms) slowest = { ms, what: `firstParagraph(${JSON.stringify(line.slice(0, 10))}...)` };
}
check(`the slowest takes under 50ms (${slowest.what}, ${slowest.ms.toFixed(1)}ms)`, slowest.ms < 50, true);
check("a body over GitHub's limit is refused", (() => { try { checkBody("x".repeat(MAX_BODY + 1)); return "no"; } catch (e) { return /at most/.test(e.message); } })(), true);
}

// ---------------------------------------------------------------------------
// workbench_pr's body

async function workbenches() {
  section("workbench pr, in process");
  const sent = [];
  // gh as a recorder: available, signed in, and keeping what it was asked.
  const fakeGit = { ...wgit, gh: () => ({ available: true, authed: true, path: "/nowhere/gh" }),
                    prCreate: async (_dir, opts) => { sent.push(opts); return { ok: true, url: "https://example.invalid/pr/1", reason: null }; } };
  const store = makeWorkbenchStore({ sql: db.sqlP, actor: "tester" });
  const report = makeReport({ sql: db.sqlP });
  const benches = createWorkbench({ store, sheet: sheets, git: fakeGit, report, settings: () => ({ workbenchBranchPrefix: "ray" }) });
  const t = db.createTask({ projectId: project.id, title: "Wire the PR body", ref: "ABC-12" });
  const s = makeSheetStore({ sql: db.sqlP, batch: db.batchP, actor: "tester", authorType: "human" });
  s.decide(s.ask(t.id, "Body from the Sheet?", ["yes", "no"]).id, "a", "the diff says what, the Sheet says why");
  s.append({ taskId: t.id, kind: "run", body: "npm test -- report", meta: { state: "ok", code: 0, exit: 0, dur_ms: 1500, out: "SECRET-OUTPUT" } });
  const made = await benches.start(t.id, { runSetup: false });
  const wb = made.workbench;
  write(path.join(wb.path, "src", "report.js"), "one\ntwo\nthree\n");
  await benches.commit(wb.id, "Add the report");
  check("pushed", (await benches.push(wb.id)).ok, true);

  const both = await benches.prDraft(wb.id);
  const draft = both.body;
  check("the draft's title carries the ticket", both.title, "ABC-12 Wire the PR body");
  check("the draft has the Sheet's why", has(draft, "- **Body from the Sheet?** yes. the diff says what, the Sheet says why"), true);
  check("and the branch's diff stat from git", has(draft, "## Changes\n\n1 file changed, +3 -0.\n\n- `src/report.js` +3 -0"), true);
  check("and no run output", has(draft, "SECRET"), false);
  const look = await benches.pr(wb.id);
  check("without create, nothing is sent and the title and body are shown", [look.via, look.title, look.body === draft, sent.length], ["gh", "ABC-12 Wire the PR body", true, 0]);
  const auto = await benches.pr(wb.id, { create: true });
  check("with no body, gh is given the Sheet's draft", [auto.url, sent[0] && sent[0].body === draft, auto.body === draft], ["https://example.invalid/pr/1", true, true]);
  check("and the drafted title", sent[0] && sent[0].title, "ABC-12 Wire the PR body");
  await benches.pr(wb.id, { create: true, body: "Edited by hand.\n\n- one change <!-- kept -->", title: "A title of my own" });
  check("with a title and body, gh is given them, less what nobody would see", [sent[1] && sent[1].title, sent[1] && sent[1].body], ["A title of my own", "Edited by hand.\n\n- one change "]);
  await benches.pr(wb.id, { create: true, body: "key AKIAIOSFODNN7EXAMPLE", title: "SSN 123-45-6789" });
  check("but a secret a person typed is still redacted", [sent[2].title, sent[2].body], ["SSN [redacted]", "key [redacted]"]);
  sent.splice(1, 2);
  await benches.pr(wb.id, { create: true, body: "" });
  check("an emptied body is sent empty, not replaced", sent[1] && sent[1].body, "");
  await rejects("a body that is not text", () => benches.pr(wb.id, { body: 5 }), /body must be text/);
  await rejects("a body over the limit", () => benches.pr(wb.id, { body: "x".repeat(MAX_BODY + 1) }), /at most/);
  await rejects("an empty title", () => benches.pr(wb.id, { title: "  " }), /needs a title/);
  const plain = createWorkbench({ store, sheet: sheets, git: fakeGit, settings: () => ({}) });
  check("without a report, one line", await plain.prDraft(wb.id), { title: "ABC-12 Wire the PR body", body: `From Delphi task ${t.id}.\n` });

  section("gh is handed the body on stdin");
  // A stand-in gh that records its arguments and its stdin, so the real
  // prCreate is tested without the network or the owner's gh.
  const fakeGh = path.join(dir, "fake-gh.js");
  const record = path.join(dir, "gh-record.json");
  fs.writeFileSync(fakeGh, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args[1] === "view") { process.stdout.write(""); process.exit(1); }
const input = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, input }));
process.stdout.write("https://example.invalid/pull/9\\n");
`);
  fs.chmodSync(fakeGh, 0o755);
  const longBody = `${"word ".repeat(12000)}end`;
  const viaGh = await wgit.prCreate(wb.path, { base: "main", branch: "-dash-branch", title: "T", body: longBody }, { available: true, authed: true, path: fakeGh });
  const rec = JSON.parse(fs.readFileSync(record, "utf8"));
  check("opened", [viaGh.ok, viaGh.url, viaGh.existing], [true, "https://example.invalid/pull/9", false]);
  check("the body came on stdin, whole", [rec.input === longBody, rec.args.includes("--body-file"), rec.args.includes(longBody)], [true, true, false]);
  db.handle().exec("PRAGMA wal_checkpoint(TRUNCATE)");

  delete process.env.ELECTRON_RUN_AS_NODE;
  section("workbench_pr is the command line's");
  const agent = openServer({ actor: "claude-code:1", clientName: "test", env: { DELPHI_AUTHOR_TYPE: "agent", DELPHI_GH: "none" }, warn: () => {} });
  await agent.start();
  try {
    check("not offered to an agent", (await agent.request("tools/list", {})).tools.some((x) => x.name === "workbench_pr"), false);
    await rejects("nor callable by one, body or not", () => agent.call("workbench_pr", { task_id: t.id, create: true, body: "x" }), /Unknown tool workbench_pr/);
    await rejects("an agent cannot write the runner's keys", () => agent.call("sheet_append", { task_id: empty.id, kind: "run", body: "npm test", meta: { state: "ok", ran_by: "delphi" } }), /Delphi's own runner/);
    const ranHere = s.append({ taskId: empty.id, kind: "run", body: "npm run lint", meta: { state: "fail", code: 1, ran_by: "delphi" } });
    await rejects("nor change the result of a run Delphi ran", () => agent.call("sheet_update", { id: ranHere.id, meta: { state: "ok", code: 0 } }), /run by Delphi/);
    await rejects("nor its command", () => agent.call("sheet_update", { id: ranHere.id, body: "npm run other" }), /run by Delphi/);
    const said = await agent.call("sheet_append", { task_id: empty.id, kind: "say", body: "kept out" });
    s.update(said.id, { meta: { private: true } });
    await rejects("an agent cannot undo Keep out", () => agent.call("sheet_update", { id: said.id, meta: { private: false } }), /person's choice/);
    check("and it stays out", s.get(said.id).meta.private, true);
    check("writing the same value back is not a change, and is let through",
      (await agent.call("sheet_update", { id: said.id, meta: { private: true } })).meta.private, true);
    const own = await agent.call("sheet_append", { task_id: empty.id, kind: "run", body: "npm run own", meta: { state: "ok", code: 0, runner_pid: 1, runner_host: "h" } });
    check("its own report is still taken, with the pid delphi chat records", own.meta.state, "ok");
  } finally {
    agent.close();
  }
  for (const [route, env] of [["node:sqlite", {}], ["sqlite3 binary", { DELPHI_SQLITE_ROUTE: "binary" }]]) {
    section(`workbench_pr through the server, ${route}`);
    // The command line's client name, because workbench_pr is one of its tools.
    const client = openServer({ actor: "tester", env: { DELPHI_AUTHOR_TYPE: "human", DELPHI_GH: "none", ...env }, warn: () => {} });
    await client.start();
    try {
      const none = await client.call("workbench_pr", { task_id: t.id });
      check("no body: the Sheet's draft, the same one the app writes", none.body, draft);
      const given = await client.call("workbench_pr", { task_id: t.id, body: "From the agent." });
      check("a body: that one", given.body, "From the agent.");
      const create = await client.call("workbench_pr", { task_id: t.id, create: true, body: "From the agent." });
      check("create with a local origin has nowhere to go, and keeps the body", [create.url, create.via, create.body], [null, null, "From the agent."]);
      check("a title: that one, redacted", (await client.call("workbench_pr", { task_id: t.id, title: "Mine AKIAIOSFODNN7EXAMPLE" })).title, "Mine [redacted]");
      await rejects("a body that is not text", () => client.call("workbench_pr", { task_id: t.id, body: 7 }), /body must be text/);
    } finally {
      client.close();
    }
  }
}

reports().then(workbenches).then(() => {
  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}, (error) => {
  console.error(error);
  process.exit(1);
});
