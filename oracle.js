// Building and querying the knowledge graph.
//
// Extraction is deterministic. An LLM pass would find more, but it would also
// invent entities, and an invented node in a graph an agent trusts is worse than
// a missing one: a missing node makes a query return less, a wrong node makes it
// return something false. Patterns here only match things with an unambiguous
// shape, and everything else is learned from the user's own rows by tests a
// person could check by hand (see learnVocabulary).

const fs = require("fs");
const path = require("path");

// Things with a shape that cannot be mistaken for prose.
const PATTERNS = [
  { kind: "ticket", re: /\b([A-Z][A-Z0-9]{1,9}-\d{2,6})\b/g },
  { kind: "file", re: /\b([\w./-]+\.(?:rb|js|py|ya?ml|sql|sh|java|json|tf|md))\b/g },
  { kind: "repo", re: /\b(bip-appeals-[a-z0-9-]+)\b/g },
];

// Shapes the ticket pattern matches that are standards and algorithms, not
// tickets. SHA-256 was the graph's fourth most mentioned "ticket".
const NOT_TICKETS = new Set(["SHA", "UTF", "ISO", "AES", "RSA", "TLS", "SSL", "HTTP", "IPV", "X", "MD", "CVE"]);

// The seed: names from the domain the graph was first built for, which have no
// distinctive shape and were too rare in its notes to be learned. Kept because
// those projects are still in the database; a term no row mentions costs nothing.
// Learning is what covers every other domain, so this list should not grow.
const SEED = {
  service: [
    "MPI", "Caseflow", "VACOLS", "BGS", "VBMS", "Vault", "Harness", "ArgoCD",
    "Kubernetes", "Redis", "Postgres", "Oracle", "DataPower", "Grafana", "Prometheus",
    "eFolder Express", "Decision Review API", "Veteran API",
  ],
  env: ["devtest", "prodtest", "staging", "production", "uat", "demo"],
  concept: [
    "truststore", "keystore", "circuit breaker", "Add Correlation", "Register Interest",
    "orchestration", "Authority to Operate", "acknowledgement", "correlation",
  ],
};

// Words that are capitalised for grammar rather than because they name
// something. The proper-noun test below rejects most of the rest by itself,
// because a common word also turns up in lower case; these are the ones too
// often capitalised (headings, sentence starts after a colon) for that to work.
const STOPWORDS = new Set((
  "a about above after again against all also always an and any are as at be because been before being below " +
  "between both but by can could did do does doing done down during each else even every few first for from " +
  "further get gets got had has have having he her here hers him his how however i if in into is it its itself " +
  "just last let like made make many may me might more most much must my need needs never new next no nor not " +
  "now of off often on once one only or other our out over own per please put rather really same see seems set " +
  "should since so some still such sure take than that the their them then there these they thing things this " +
  "those though through thus to too two three four five under until up upon us use used uses using very via want " +
  "was way we well were what when where whether which while who whom whose why will with within without would " +
  "yes yet you your why how what monday tuesday wednesday thursday friday saturday sunday january february march " +
  "april may june july august september october november december today tomorrow yesterday todo done note notes " +
  "task tasks step steps phase see example problem fix fixed result results summary update updated status open " +
  "closed question answer why root cause test tests testing check checks run runs works working general " +
  "jan feb mar apr jun jul aug sep sept oct nov dec mon tue wed thu fri sat sun "
).split(/\s+/).filter(Boolean));

// Acronyms that are vocabulary rather than names: in a note about anything,
// "the API" and "the PR" say nothing about which one.
const GENERIC_ACRONYMS = new Set((
  "OK ID IDS TODO FIXME NOTE TBD FYI ETA AM PM UTC GMT EOD ASAP PR PRS API APIS URL URLS URI JSON YAML HTML CSS " +
  "HTTP HTTPS CLI UI UX DB MD PDF CSV TSV II III IV NB RCA FAQ TLDR TL DR WIP N A NA I AND OR NOT THE DO DON " +
  "CI CD AI ML OS GET POST PUT PATCH DELETE HEAD " +
  // Shouted words: log levels, outcomes and emphasis, written in capitals but
  // naming nothing. "CASEFLOW SUCCESS" was being learned as a phrase.
  "SUCCESS FAIL FAILED FAILURE ERROR WARN WARNING INFO DEBUG TRACE TRUE FALSE NULL NONE YES NO NEVER ALWAYS MUST " +
  "IMPORTANT MORNING DONE OPEN CLOSED NEW OLD WHY HOW WHAT ONLY ALL"
).split(/\s+/));

// Who changes rows without being anyone: sources and generic roles.
const NOT_PEOPLE = new Set(["app", "self", "pad", "session", "jira", "system", "systems", "agent", "tool", "human",
  "user", "measure", "import", "importer", "delphi", "unknown", "anonymous", "admin", "root"]);

// How much the learned layer may add. Generous for a personal store, and a hard
// ceiling so a store full of pasted logs cannot make the rebuild quadratic.
const MAX_TERMS = 300;
const MAX_CODE = 200;
// A learned name must recur, because once is an accident of phrasing. Phrases
// need more, since "Next Steps" recurs too.
// A capitalised word needs a row more than an acronym or an identifier, because
// title case and error messages capitalise ordinary words too.
const MIN_ROWS = 2;
const MIN_WORD_ROWS = 3;
const MIN_PHRASE_ROWS = 3;
// Of the times a word appears outside a sentence start, the share that must be
// capitalised for it to count as a name. "Offerworks" is always capitalised;
// "Board" is capitalised in titles and lower case everywhere else.
const PROPER_RATIO = 0.7;
// A long note names dozens of things, and pairing each with each once says
// nothing about any two of them. A pair seen once counts only from a row this
// focused; seen twice it counts from anywhere.
const FOCUSED_ROW = 12;

// Kinds the entities table accepts. project, term and code arrived with the
// learned vocabulary; a table made before them is rebuilt by rebuild(), which
// is free because every row in it is derived.
const KINDS = ["ticket", "pr", "repo", "service", "file", "person", "env", "concept", "project", "term", "code"];

function open(db) {
  db.exec(fs.readFileSync(path.join(__dirname, "oracle.sql"), "utf8"));
}

/** A short window around a match, so an edge can be audited later. */
function evidenceFor(text, index, length) {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 60);
  return (start ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
}

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

// A word, with the dots, hyphens and underscores a name can carry inside it.
// Matching walks these rather than running a regex per term, which is what
// keeps a rebuild linear in the text however many names are learned.
const TOKEN = /[A-Za-z0-9][A-Za-z0-9_.\-]*[A-Za-z0-9]|[A-Za-z0-9]/g;

function tokens(text) {
  const out = [];
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(text))) out.push({ t: m[0], i: m.index });
  return out;
}

/**
 * Whether a word sits where grammar capitalises it anyway: the start of a line,
 * a sentence, a list item or a table cell. Capitals there are no evidence of a
 * name. A hyphen counts, which also catches "foo - Bar"; being wrong that way
 * only costs a learned name one piece of evidence.
 */
function sentenceStart(text, index) {
  let j = index - 1;
  while (j >= 0 && " \t*_\"'([`".includes(text[j])) j--;
  return j < 0 || "\n.!?:;|>#-".includes(text[j]);
}

const isAcronym = (t) => /^[A-Z][A-Z0-9]{1,9}$/.test(t) && /[A-Z].*[A-Z]/.test(t);
const isCapitalised = (t) => /^[A-Z][a-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(t);
// camelCase, PascalCase with a second hump, snake_case and SCREAMING_SNAKE.
// GitHub and OpenSSL have this shape too, so shape alone only makes a name;
// codeLike below decides whether it is an identifier.
const isCode = (t) =>
  /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(t) ||
  /^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*$/.test(t) ||
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(t) ||
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(t);

// An identifier rather than a brand: it has an underscore, it was written as
// code (in backticks, or called), it starts with a lower-case word, or it has
// three humps. PushPriorityAppealsToJudgesJob is code; GitHub is a name.
const codeLike = (t, marked) =>
  marked || t.includes("_") || /^[a-z]{2,}[A-Z]/.test(t) || (t.match(/[a-z0-9][A-Z]/g) || []).length >= 2;

/**
 * Counts what the proper-noun test needs, over every row of text at once.
 *
 * For each word in lower case: how often it appears in lower case, how often
 * capitalised away from a sentence start, and in which rows. For code-shaped
 * words and short capitalised phrases, the rows they appear in. Rows are what
 * a threshold is set on, because one long note repeating a word is not a sign
 * it names anything.
 */
function countCorpus(texts) {
  const lower = new Map();
  const cased = new Map();      // lc -> { n, rows:Set, forms:Map }
  const code = new Map();       // exact -> { rows:Set, marked }
  const phrases = new Map();    // exact -> Set of rows
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  texts.forEach((text, row) => {
    if (!text) return;
    const toks = tokens(text);
    for (let k = 0; k < toks.length; k++) {
      const { t, i } = toks[k];
      const lc = t.toLowerCase();
      if (t === lc) { bump(lower, lc); }
      else if (isAcronym(t) || (isCapitalised(t) && !sentenceStart(text, i))) {
        let c = cased.get(lc);
        if (!c) cased.set(lc, (c = { n: 0, rows: new Set(), forms: new Map() }));
        c.n++;
        c.rows.add(row);
        bump(c.forms, t);
      }
      if (isCode(t) && !isAcronym(t)) {
        let c = code.get(t);
        if (!c) code.set(t, (c = { rows: new Set(), marked: false }));
        c.rows.add(row);
        if (text[i - 1] === "`" || text[i + t.length] === "(") c.marked = true;
      }
    }

    // Runs of two or three capitalised words on one line, like "Veteran API".
    // Headings and table rows are skipped: they are title case by convention,
    // and "Next Steps" is not a thing anybody needs a node for.
    let offset = 0;
    for (const line of text.split("\n")) {
      const lineStart = offset;
      offset += line.length + 1;
      if (/^\s*(#|\|)/.test(line)) continue;
      const lt = tokens(line);
      let run = [];
      const flush = () => {
        if (run.length >= 2 && run.length <= 3 &&
            !STOPWORDS.has(run[0].t.toLowerCase()) && !STOPWORDS.has(run[run.length - 1].t.toLowerCase()) &&
            !sentenceStart(text, lineStart + run[0].i)) {
          const phrase = run.map((r) => r.t).join(" ");
          if (!phrases.has(phrase)) phrases.set(phrase, new Set());
          phrases.get(phrase).add(row);
        }
        run = [];
      };
      // A shouted word ends a run, so "VBMS FAIL" is not learned as a name.
      const word = (t) => isCapitalised(t) || (isAcronym(t) && !GENERIC_ACRONYMS.has(t));
      for (const tok of lt) {
        const joined = run.length && line.slice(run[run.length - 1].i + run[run.length - 1].t.length, tok.i) === " ";
        if (word(tok.t) && (!run.length || joined)) run.push(tok);
        else { flush(); if (word(tok.t)) run.push(tok); }
      }
      flush();
    }
  });
  return { lower, cased, code, phrases };
}

/** Whether a capitalised word is a name here, by how this corpus writes it. */
function proper(counts, word) {
  const lc = word.toLowerCase();
  if (STOPWORDS.has(lc)) return false;
  const c = counts.cased.get(lc);
  const capital = c ? c.n : 0;
  const small = counts.lower.get(lc) || 0;
  if (!capital) return small === 0;
  return capital / (capital + small) >= PROPER_RATIO;
}

const mostCommon = (forms) => [...forms.entries()].sort((a, b) => b[1] - a[1])[0][0];
const basename = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();

/**
 * The names this graph matches, learned from the user's own rows.
 *
 * Given plain arrays so it can be tested without a database. Earlier sources
 * win a clash: the seed, then projects, repositories and people (which are
 * facts from the schema), then names learned from text, which are inferences.
 *
 * Returns { entries, ci, cs, maxWords }. ci is keyed by lower case and matches
 * whatever the case; cs matches only as written, which is how a learned name
 * like "Board" would stay out of "the board" if it ever passed the test.
 */
function learnVocabulary({ projects = [], repos = [], people = [], texts = [] } = {}) {
  const entries = [];
  const ci = new Map();
  const cs = new Map();
  const byKey = new Map();
  const taken = (alias) => ci.has(alias.toLowerCase()) || cs.has(alias);

  const entity = (kind, name) => {
    const key = `${kind}:${name.toLowerCase()}`;
    let e = byKey.get(key);
    if (!e) { e = { kind, name, aliases: [] }; byKey.set(key, e); entries.push(e); }
    return e;
  };
  const alias = (e, text, { caseSensitive = false, atOnly = false } = {}) => {
    const t = String(text || "").trim();
    if (!t || taken(t)) return false;
    const a = { text: t, caseSensitive, atOnly, entity: e };
    e.aliases.push(a);
    if (caseSensitive) cs.set(t, a); else ci.set(t.toLowerCase(), a);
    return true;
  };

  for (const [kind, terms] of Object.entries(SEED)) {
    for (const term of terms) alias(entity(kind, term), term);
  }

  const counts = countCorpus(texts);
  const projectNamed = new Map();

  for (const p of projects) {
    if (!p || !p.name) continue;
    // "Delphi: the task system" and "Delphi: the agent queue" are both Delphi.
    const head = String(p.name).split(/[:(]|\s-\s/)[0].trim() || String(p.name).trim();
    const e = entity("project", head);
    const key = String(p.key || "");
    projectNamed.set(head.toLowerCase(), e);
    if (key) projectNamed.set(key.toLowerCase(), e);
    // A one-word name that is also written in lower case ("offerworks" in a
    // path) still names the project when capitalised, so it matches as written.
    // One that is an ordinary word (General, Test) names nothing in prose.
    if (head.split(/\s+/).length > 1 || proper(counts, head)) alias(e, head);
    else if (!STOPWORDS.has(head.toLowerCase())) alias(e, head, { caseSensitive: true });
    // A slug like ssnr-mpi never occurs as an English word; a bare one like
    // "general" or "platform" does, so it only counts when the name agrees.
    if (key.length >= 4 && (/[-\d]/.test(key) || (key === head.toLowerCase() && proper(counts, head)))) alias(e, key);
    // An acronym inside the name is how people refer to the work: SSNR.
    for (const w of tokens(String(p.name))) {
      if (isAcronym(w.t) && w.t.length >= 3 && !GENERIC_ACRONYMS.has(w.t)) alias(e, w.t);
    }
  }

  for (const r of repos) {
    const name = String(r || "").trim();
    if (name.length < 4 || STOPWORDS.has(name.toLowerCase()) || /^(src|app|code|work|tmp|temp|projects?)$/i.test(name)) continue;
    // A project's own folder is the project, not a second thing beside it.
    const owner = projectNamed.get(name.toLowerCase());
    alias(owner || entity("repo", name), name);
  }

  for (const raw of people) {
    // A harness actor is "claude-code:42"; the session is not the person.
    const name = String(raw || "").split(":")[0].trim();
    if (!name || NOT_PEOPLE.has(name.toLowerCase()) || !/[a-z]/i.test(name)) continue;
    // A short name is only trusted as an @mention: "ray" and "tl" are words
    // and fragments far more often than they are somebody.
    const e = entity("person", name);
    alias(e, name, { atOnly: name.length < 4 });
    // claude-code is written "Claude Code" in prose.
    if (name.includes("-")) alias(e, name.replace(/-/g, " "));
  }

  // Learned from text. Rows, not occurrences, decide the order, and the
  // ceilings keep a store of pasted logs from flooding the graph.
  const terms = [];
  for (const [lc, c] of counts.cased) {
    const form = mostCommon(c.forms);
    if (c.rows.size < (isAcronym(form) ? MIN_ROWS : MIN_WORD_ROWS)) continue;
    if (isAcronym(form) ? GENERIC_ACRONYMS.has(form) || form.length < 2 : form.length < 3) continue;
    if (!proper(counts, form)) continue;
    terms.push({ name: form, rows: c.rows.size, caseSensitive: !isAcronym(form) && (counts.lower.get(lc) || 0) > 0 });
  }
  for (const [phrase, rows] of counts.phrases) {
    if (rows.size < MIN_PHRASE_ROWS) continue;
    const words = phrase.split(" ");
    if (words.every((w) => isAcronym(w) && GENERIC_ACRONYMS.has(w))) continue;
    // Written in lower case anywhere, it is a description rather than a name.
    const lowered = phrase.toLowerCase();
    if (texts.some((t) => t && t.includes(lowered))) continue;
    terms.push({ name: phrase, rows: rows.size + 1, caseSensitive: false });
  }
  for (const [name, c] of counts.code) {
    if (!codeLike(name, c.marked) && c.rows.size >= MIN_ROWS) terms.push({ name, rows: c.rows.size, caseSensitive: true });
  }
  terms.sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name));
  let added = 0;
  for (const t of terms) {
    if (added >= MAX_TERMS) break;
    if (alias(entity("term", t.name), t.name, { caseSensitive: t.caseSensitive })) added++;
  }

  const code = [...counts.code.entries()]
    .filter(([name, c]) => c.rows.size >= MIN_ROWS && name.length >= 4 && codeLike(name, c.marked))
    .sort((a, b) => b[1].rows.size - a[1].rows.size || a[0].localeCompare(b[0]));
  added = 0;
  for (const [name] of code) {
    if (added >= MAX_CODE) break;
    if (alias(entity("code", name), name, { caseSensitive: true })) added++;
  }

  const maxWords = Math.max(1, ...[...ci.keys(), ...cs.keys()].map((k) => k.split(" ").length));
  // Entities whose every alias was taken by an earlier source match nothing.
  return { entries: entries.filter((e) => e.aliases.length || e.kind === "project"), ci, cs, maxWords };
}

let seedOnly = null;
/** The seed alone, for a caller with no rows to learn from. */
function seedVocabulary() {
  if (!seedOnly) seedOnly = learnVocabulary({});
  return seedOnly;
}

/**
 * The entities a piece of text mentions, each once, with the sentence around
 * its first mention as evidence.
 */
function extract(text, vocab = seedVocabulary()) {
  if (!text) return [];
  const found = new Map();
  const add = (kind, name, index, length) => {
    const key = `${kind}:${name.toLowerCase()}`;
    if (!found.has(key)) found.set(key, { kind, name, evidence: evidenceFor(text, index, length) });
  };

  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (kind === "ticket" && NOT_TICKETS.has(m[1].split("-")[0])) continue;
      add(kind, m[1], m.index, m[0].length);
    }
  }

  const toks = tokens(text);
  for (let k = 0; k < toks.length; k++) {
    // Longest first, so "Decision Review API" wins over a learned "Review".
    for (let n = Math.min(vocab.maxWords, toks.length - k); n >= 1; n--) {
      const last = toks[k + n - 1];
      let ok = true;
      for (let j = k; j < k + n - 1 && ok; j++) {
        ok = text.slice(toks[j].i + toks[j].t.length, toks[j + 1].i) === " ";
      }
      if (!ok) continue;
      const phrase = text.slice(toks[k].i, last.i + last.t.length);
      const hit = vocab.cs.get(phrase) || vocab.ci.get(phrase.toLowerCase());
      if (!hit || (hit.atOnly && text[toks[k].i - 1] !== "@")) continue;
      add(hit.entity.kind, hit.entity.name, toks[k].i, phrase.length);
      k += n - 1;
      break;
    }
  }

  return [...found.values()];
}

/** Everything learnVocabulary needs, read from a database. */
function vocabularyFrom(db) {
  const rows = (s) => { try { return db.prepare(s).all(); } catch { return []; } };
  const projects = rows("SELECT key, name FROM projects");
  const repos = [
    ...rows("SELECT name FROM repos").map((r) => r.name),
    ...rows("SELECT path FROM repos").map((r) => basename(r.path)),
    ...rows("SELECT path FROM workspaces").map((r) => basename(r.path)),
    ...rows("SELECT path FROM projects WHERE path IS NOT NULL").map((r) => basename(r.path)),
  ];
  const people = [
    ...rows("SELECT DISTINCT owner AS n FROM tasks WHERE owner IS NOT NULL"),
    ...rows("SELECT DISTINCT assignee AS n FROM tasks WHERE assignee IS NOT NULL"),
    ...rows("SELECT DISTINCT author AS n FROM comments WHERE author IS NOT NULL"),
    ...rows("SELECT DISTINCT actor AS n FROM status_events WHERE actor IS NOT NULL"),
  ].map((r) => r.n);
  const texts = [
    ...rows("SELECT title, body FROM notes").map((n) => `${n.title}\n${n.body || ""}`),
    ...rows("SELECT title, detail FROM tasks").map((t) => `${t.title}\n${t.detail || ""}`),
    ...rows("SELECT body FROM scratchpads").map((p) => p.body || ""),
    ...rows("SELECT body FROM comments WHERE promoted = 1 OR kind = 'decide'").map((c) => c.body || ""),
  ];
  return learnVocabulary({ projects, repos: [...new Set(repos)], people: [...new Set(people)], texts });
}

/**
 * Rebuilds the graph from the current rows.
 *
 * A full rebuild rather than an incremental update. Mention counts and edge
 * weights are derived, so patching them on every edit accumulates drift, and the
 * corpus is small enough that correctness is worth more than the milliseconds.
 * The vocabulary is relearned each time for the same reason: a project added
 * an hour ago is a name the graph should know now.
 *
 * Counted in memory and written in one transaction with prepared statements,
 * because the rebuild runs after every external write and a statement per
 * mention made it the slowest thing the app did on a busy store.
 */
function rebuild(db) {
  const started = Date.now();
  open(db);
  const declared = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'entities'").get() || {}).sql || "";
  if (!declared.includes("'term'")) {
    db.exec("DROP TABLE IF EXISTS entities");
    open(db);
  }

  const vocab = vocabularyFrom(db);
  const notes = db.prepare("SELECT id, project_id, title, body FROM notes").all();
  const tasks = db.prepare("SELECT id, project_id, title, detail, ref FROM tasks").all();
  const repos = db.prepare("SELECT * FROM repos").all();
  const links = db.prepare("SELECT id, project_id FROM links").all();
  let promoted = [];
  try {
    promoted = db.prepare("SELECT task_id, body FROM comments WHERE promoted = 1 OR kind = 'decide'").all();
  } catch {}

  const entities = new Map();   // kind:lower -> { kind, name, mentions, id }
  const mentions = new Map();   // source -> Map(entityKey -> evidence)
  const scan = (sourceType, id, text) => {
    const source = `${sourceType}:${id}`;
    let seen = mentions.get(source);
    for (const hit of extract(text, vocab)) {
      const key = `${hit.kind}:${hit.name.toLowerCase()}`;
      if (!seen) mentions.set(source, (seen = new Map()));
      if (seen.has(key)) continue;
      seen.set(key, hit.evidence);
      const e = entities.get(key);
      if (e) e.mentions++;
      else entities.set(key, { kind: hit.kind, name: hit.name, mentions: 1 });
    }
  };
  for (const n of notes) scan("note", n.id, `${n.title}\n${n.body || ""}`);
  for (const t of tasks) scan("task", t.id, `${t.title}\n${t.detail || ""}\n${t.ref || ""}`);
  // A promoted Sheet entry is what the task concluded, so what it names is
  // what the task is about. Edges have no comment type; the task stands in.
  for (const c of promoted) scan("task", c.task_id, c.body || "");
  for (const r of repos) scan("repo", r.id, `${r.name} ${r.path}`);
  // A project the text never names is still a thing to ask about: oracle_context
  // reaches its rows through the project, so it gets a node with no mentions.
  for (const e of vocab.entries) {
    const key = `${e.kind}:${e.name.toLowerCase()}`;
    if (e.kind === "project" && !entities.has(key)) entities.set(key, { kind: e.kind, name: e.name, mentions: 0 });
  }

  const own = !db.isTransaction;
  if (own) db.exec("BEGIN");
  try {
    db.exec("DELETE FROM edges");
    db.exec("DELETE FROM entities");
    const insertEntity = db.prepare("INSERT INTO entities (kind, name, mentions) VALUES (:kind, :name, :mentions)");
    const insertEdge = db.prepare(
      `INSERT INTO edges (source_type, source_id, target_type, target_id, relation, weight, evidence)
       VALUES (:st, :sid, :tt, :tid, :rel, :w, :ev)
       ON CONFLICT(source_type, source_id, target_type, target_id, relation) DO UPDATE SET weight = weight + 0.5`
    );
    const edge = (st, sid, tt, tid, rel, w, ev = null) => insertEdge.run({ st, sid, tt, tid, rel, w, ev });

    for (const e of entities.values()) {
      e.id = Number(insertEntity.run({ kind: e.kind, name: e.name, mentions: e.mentions }).lastInsertRowid);
    }

    // Structural edges. These come from the schema, so they are facts rather
    // than inferences and carry full weight.
    for (const n of notes) if (n.project_id) edge("note", n.id, "project", n.project_id, "belongs_to", 1.0);
    for (const t of tasks) if (t.project_id) edge("task", t.id, "project", t.project_id, "belongs_to", 1.0);
    for (const r of repos) edge("repo", r.id, "project", r.project_id, r.is_primary ? "primary_repo_of" : "helper_repo_of", 1.0);
    for (const l of links) edge("link", l.id, "project", l.project_id, "belongs_to", 1.0);

    // Mention edges, and entity-to-entity edges inferred from co-occurrence in
    // the same row. The second is what makes traversal useful: it is how "the
    // truststore work" reaches "the Veteran API" without either note naming the
    // connection outright.
    let mentionCount = 0;
    const pairs = new Map();
    for (const [source, seen] of mentions) {
      const [st, sid] = source.split(":");
      const ids = [];
      for (const [key, evidence] of seen) {
        const target = entities.get(key);
        edge(st, Number(sid), "entity", target.id, "mentions", 1.0, evidence);
        ids.push(target.id);
        mentionCount++;
      }
      ids.sort((a, b) => a - b);
      const focused = ids.length <= FOCUSED_ROW;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const k = `${ids[i]}:${ids[j]}`;
          const p = pairs.get(k);
          if (p) { p.n++; p.focused = p.focused || focused; } else pairs.set(k, { n: 1, focused });
        }
      }
    }
    for (const [k, { n, focused }] of pairs) {
      if (n < 2 && !focused) continue;
      const [a, b] = k.split(":").map(Number);
      edge("entity", a, "entity", b, "co_occurs", n, `appears together in ${n} place${n === 1 ? "" : "s"}`);
    }
    if (own) db.exec("COMMIT");

    const learned = {};
    for (const e of vocab.entries) learned[e.kind] = (learned[e.kind] || 0) + 1;
    return {
      entities: entities.size,
      edges: db.prepare("SELECT COUNT(*) AS n FROM edges").get().n,
      mentions: mentionCount,
      pairs: pairs.size,
      learned,
      ms: Date.now() - started,
    };
  } catch (error) {
    if (own) { try { db.exec("ROLLBACK"); } catch {} }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function findEntities(db, query, limit = 20) {
  return db.prepare(`
    SELECT * FROM entities
    WHERE name LIKE :q OR display LIKE :q
    ORDER BY mentions DESC LIMIT :limit
  `).all({ q: `%${query}%`, limit });
}

/**
 * Everything within a couple of steps of an entity.
 *
 * Depth is capped at two on purpose. Three hops in a graph this connected
 * returns most of the database, which is the same as returning nothing.
 */
function neighbourhood(db, entityId, depth = 1) {
  const entity = db.prepare("SELECT * FROM entities WHERE id = :id").get({ id: entityId });
  if (!entity) return null;

  const rows = db.prepare(`
    SELECT e.source_type, e.source_id, e.relation, e.evidence, e.weight
    FROM edges e
    WHERE e.target_type = 'entity' AND e.target_id = :id AND e.relation = 'mentions'
    ORDER BY e.weight DESC
  `).all({ id: entityId });

  const notes = [];
  const tasks = [];
  for (const r of rows) {
    if (r.source_type === "note") {
      const n = db.prepare(`
        SELECT n.id, n.title, n.kind, n.body, p.name AS project
        FROM notes n LEFT JOIN projects p ON p.id = n.project_id WHERE n.id = :id
      `).get({ id: r.source_id });
      if (n) notes.push({ ...n, evidence: r.evidence });
    } else if (r.source_type === "task") {
      const t = db.prepare(`
        SELECT t.id, t.title, t.status, t.priority, t.ref, p.name AS project
        FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = :id
      `).get({ id: r.source_id });
      if (t) tasks.push({ ...t, evidence: r.evidence });
    }
  }

  const related = db.prepare(`
    SELECT other.*, e.weight FROM edges e
    JOIN entities other ON other.id = CASE WHEN e.source_id = :id THEN e.target_id ELSE e.source_id END
    WHERE e.relation = 'co_occurs'
      AND (e.source_id = :id OR e.target_id = :id)
      AND e.source_type = 'entity' AND e.target_type = 'entity'
    ORDER BY e.weight DESC LIMIT 12
  `).all({ id: entityId });

  const projects = db.prepare(`
    SELECT DISTINCT p.id, p.name FROM edges e
    JOIN notes n ON e.source_type = 'note' AND n.id = e.source_id
    JOIN projects p ON p.id = n.project_id
    WHERE e.target_type = 'entity' AND e.target_id = :id
    UNION
    SELECT DISTINCT p.id, p.name FROM edges e
    JOIN tasks t ON e.source_type = 'task' AND t.id = e.source_id
    JOIN projects p ON p.id = t.project_id
    WHERE e.target_type = 'entity' AND e.target_id = :id
  `).all({ id: entityId });

  return { entity, projects, notes, tasks, related };
}

/** The shortest chain of co-occurrence between two entities, if there is one. */
function connection(db, fromId, toId, maxDepth = 3) {
  const seen = new Set([fromId]);
  let frontier = [[fromId]];

  for (let depth = 0; depth < maxDepth; depth++) {
    const next = [];
    for (const chain of frontier) {
      const tip = chain[chain.length - 1];
      const neighbours = db.prepare(`
        SELECT CASE WHEN source_id = :id THEN target_id ELSE source_id END AS other, weight
        FROM edges
        WHERE relation = 'co_occurs' AND source_type = 'entity' AND target_type = 'entity'
          AND (source_id = :id OR target_id = :id)
        ORDER BY weight DESC
      `).all({ id: tip });

      for (const n of neighbours) {
        if (n.other === toId) {
          const ids = [...chain, toId];
          return ids.map((id) => db.prepare("SELECT id, kind, name FROM entities WHERE id = :id").get({ id }));
        }
        if (!seen.has(n.other)) {
          seen.add(n.other);
          next.push([...chain, n.other]);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return null;
}

function stats(db) {
  open(db);
  const byKind = db.prepare("SELECT kind, COUNT(*) AS n FROM entities GROUP BY kind ORDER BY n DESC").all();
  const byRelation = db.prepare("SELECT relation, COUNT(*) AS n FROM edges GROUP BY relation ORDER BY n DESC").all();
  const top = db.prepare("SELECT kind, name, mentions FROM entities ORDER BY mentions DESC LIMIT 12").all();
  return { byKind, byRelation, top };
}

/**
 * The graph as a drawing needs it: the strongest entities, and the entity to
 * entity edges among them.
 *
 * Thinning for legibility is left to the caller. Which nodes are on screen
 * changes every time a filter is switched, and rethinning there is instant
 * where another round trip would not be.
 */
function graph(db, { limit = 250, edgeLimit = 4000 } = {}) {
  open(db);
  const nodes = db.prepare(`
    SELECT id, kind, name, display, mentions FROM entities
    ORDER BY mentions DESC, name LIMIT :limit
  `).all({ limit });

  const ids = new Set(nodes.map((n) => n.id));
  const edges = db.prepare(`
    SELECT source_id AS a, target_id AS b, weight FROM edges
    WHERE relation = 'co_occurs' AND source_type = 'entity' AND target_type = 'entity'
    ORDER BY weight DESC LIMIT :edgeLimit
  `).all({ edgeLimit }).filter((e) => ids.has(e.a) && ids.has(e.b));

  const total = db.prepare("SELECT COUNT(*) AS n FROM entities").get().n;
  return { nodes, edges, total };
}

module.exports = {
  open, rebuild, extract, learnVocabulary, vocabularyFrom, seedVocabulary, KINDS,
  findEntities, neighbourhood, connection, stats, graph,
};
