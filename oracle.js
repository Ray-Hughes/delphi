// Building and querying the knowledge graph.
//
// Extraction is deterministic. An LLM pass would find more, but it would also
// invent entities, and an invented node in a graph an agent trusts is worse than
// a missing one: a missing node makes a query return less, a wrong node makes it
// return something false. Patterns here only match things with an unambiguous
// shape, and everything else is learned from the user's own rows by tests a
// person could check by hand (see learnVocabulary).

const crypto = require("crypto");
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
// How many rows a step of the rebuild handles before it may hand the thread
// back. A step is a few milliseconds; pace() decides when a pause is due.
const STEP_ROWS = 100;
const STEP_WRITES = 300;

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
function* countCorpusSteps(texts) {
  const lower = new Map();
  const cased = new Map();      // lc -> { n, rows:Set, forms:Map }
  const code = new Map();       // exact -> { rows:Set, marked }
  const phrases = new Map();    // exact -> Set of rows
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  for (let row = 0; row < texts.length; row++) {
    const text = texts[row];
    if (row % STEP_ROWS === 0) yield;
    if (!text) continue;
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
  }
  return { lower, cased, code, phrases };
}

/**
 * Which of the candidate phrases also appear written in lower case.
 *
 * One pass over the tokens, looking each run of two or three lower-case words
 * up in the candidates. It used to be a substring search of every row for every
 * candidate, which is rows times phrases: 4,000 notes took five seconds, on the
 * main thread, after every change.
 */
function* writtenLower(texts, candidates) {
  const seen = new Set();
  if (!candidates.size) return seen;
  for (let row = 0; row < texts.length; row++) {
    const text = texts[row];
    if (row % STEP_ROWS === 0) yield;
    if (!text) continue;
    const toks = tokens(text);
    for (let k = 0; k + 1 < toks.length; k++) {
      let phrase = toks[k].t;
      if (phrase !== phrase.toLowerCase()) continue;
      for (let n = 1; n < 3 && k + n < toks.length; n++) {
        const prev = toks[k + n - 1];
        const next = toks[k + n];
        if (next.t !== next.t.toLowerCase() || text.slice(prev.i + prev.t.length, next.i) !== " ") break;
        phrase += " " + next.t;
        if (candidates.has(phrase)) seen.add(phrase);
      }
    }
  }
  return seen;
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
function learnVocabulary(input) {
  return drain(learnSteps(input));
}

/** learnVocabulary as steps, so rebuildAsync can let the event loop in. */
function* learnSteps({ projects = [], repos = [], people = [], texts = [] } = {}) {
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

  const counts = yield* countCorpusSteps(texts);
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
  let n = 0;
  for (const [lc, c] of counts.cased) {
    if (++n % 5000 === 0) yield;
    const form = mostCommon(c.forms);
    if (c.rows.size < (isAcronym(form) ? MIN_ROWS : MIN_WORD_ROWS)) continue;
    if (isAcronym(form) ? GENERIC_ACRONYMS.has(form) || form.length < 2 : form.length < 3) continue;
    if (!proper(counts, form)) continue;
    terms.push({ name: form, rows: c.rows.size, caseSensitive: !isAcronym(form) && (counts.lower.get(lc) || 0) > 0 });
  }
  const phrases = [...counts.phrases].filter(([phrase, rows]) => rows.size >= MIN_PHRASE_ROWS &&
    !phrase.split(" ").every((w) => isAcronym(w) && GENERIC_ACRONYMS.has(w)));
  // Written in lower case anywhere, it is a description rather than a name.
  const lowered = yield* writtenLower(texts, new Set(phrases.map(([phrase]) => phrase.toLowerCase())));
  for (const [phrase, rows] of phrases) {
    if (lowered.has(phrase.toLowerCase())) continue;
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

/**
 * Every row a query returns, a page at a time by id, yielding between pages so
 * reading tens of megabytes of notes never holds the thread in one go. The query
 * takes :after and :limit and orders by id.
 */
function* paged(db, query, out, size = 500) {
  let after = -Infinity;
  const statement = db.prepare(query);
  for (;;) {
    const rows = statement.all({ after: after === -Infinity ? -1 : after, limit: size });
    for (const row of rows) out.push(row);
    if (rows.length < size) return out;
    after = rows[rows.length - 1].id;
    yield;
  }
}

/** Everything learnVocabulary needs, read from a database. */
function* vocabularyInputSteps(db) {
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
  const page = function* (query) {
    try { return yield* paged(db, query, []); } catch { return []; }
  };
  const texts = [
    ...(yield* page("SELECT id, title, body FROM notes WHERE id > :after ORDER BY id LIMIT :limit")).map((n) => `${n.title}\n${n.body || ""}`),
    ...(yield* page("SELECT id, title, detail FROM tasks WHERE id > :after ORDER BY id LIMIT :limit")).map((t) => `${t.title}\n${t.detail || ""}`),
    ...(yield* page("SELECT id, body FROM scratchpads WHERE id > :after ORDER BY id LIMIT :limit")).map((p) => p.body || ""),
    ...(yield* page(`SELECT id, body FROM comments WHERE (promoted = 1 OR kind = 'decide') AND id > :after
                     ORDER BY id LIMIT :limit`)).map((c) => c.body || ""),
  ];
  return { projects, repos: [...new Set(repos)], people: [...new Set(people)], texts };
}

function vocabularyFrom(db) {
  return learnVocabulary(drain(vocabularyInputSteps(db)));
}

/** Runs steps to the end at once. */
function drain(steps) {
  let r;
  do { r = steps.next(); } while (!r.done);
  return r.value;
}

/** Runs steps, handing the thread back whenever one run of them passes sliceMs. */
async function pace(steps, sliceMs = 25) {
  let started = Date.now();
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    if (Date.now() - started >= sliceMs) {
      await new Promise((resolve) => setImmediate(resolve));
      started = Date.now();
    }
  }
}

// What the last rebuild wrote, per database handle: the vocabulary's signature
// and each source row's text hash and mentions. It is what makes a rebuild
// incremental. A row whose text and vocabulary are unchanged is not extracted
// again, and a row whose mentions came out the same is not written again, so
// a running job that touches one task costs one task's worth of work. Without
// it (a new process, or a table just remade) everything is written once.
const MEMORY = new WeakMap();
// Bumped by every rebuild, so a paced one that a newer rebuild overtook stops
// rather than writing over it.
const GENERATION = new WeakMap();

const sha = (text) => crypto.createHash("sha1").update(text).digest("base64");
const STRUCTURAL = ["belongs_to", "primary_repo_of", "helper_repo_of"];

/**
 * Rebuilds the graph from the current rows, as steps.
 *
 * The result is the same as a full rebuild from scratch: the vocabulary is
 * relearned every time (a project added an hour ago is a name the graph should
 * know now), and every count and weight is recomputed from the rows rather than
 * patched. What changed is how it is written. Entities keep their ids, each row's
 * mentions are replaced only when they differ, and edges are diffed rather than
 * deleted and reinserted, so the graph is never empty part way and an unchanged
 * store is written not at all.
 *
 * Writes go in transactions of STEP_WRITES and nothing is held open across a
 * yield, because rebuildAsync gives the thread back between steps and the app
 * writes through the same connection meanwhile.
 */
function* rebuildSteps(db, generation) {
  const started = Date.now();
  open(db);
  let memory = MEMORY.get(db);
  const declared = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'entities'").get() || {}).sql || "";
  if (!declared.includes("'term'")) {
    // Made before the learned kinds; every row in it is derived, so start over.
    db.exec("DROP TABLE IF EXISTS entities");
    db.exec("DELETE FROM edges");
    open(db);
    memory = null;
  }
  const overtaken = () => GENERATION.get(db) !== generation;

  const vocab = yield* learnSteps(yield* vocabularyInputSteps(db));
  yield;
  const vocabSig = sha(JSON.stringify([...vocab.ci.entries(), ...vocab.cs.entries()]
    .map(([k, a]) => [k, a.caseSensitive, a.atOnly, a.entity.kind, a.entity.name]).sort()));
  const fresh = !memory || memory.vocabSig !== vocabSig;

  const notes = yield* paged(db, "SELECT id, project_id, title, body FROM notes WHERE id > :after ORDER BY id LIMIT :limit", []);
  const tasks = yield* paged(db, "SELECT id, project_id, title, detail, ref FROM tasks WHERE id > :after ORDER BY id LIMIT :limit", []);
  const repos = db.prepare("SELECT * FROM repos").all();
  const links = db.prepare("SELECT id, project_id FROM links").all();
  let promoted = [];
  try {
    promoted = db.prepare("SELECT task_id, body FROM comments WHERE promoted = 1 OR kind = 'decide' ORDER BY id").all();
  } catch {}

  // One text per source row. A promoted Sheet entry is what the task
  // concluded, so what it names is what the task is about; edges have no
  // comment type, so the task stands in for it.
  const texts = new Map();
  for (const n of notes) texts.set(`note:${n.id}`, `${n.title}\n${n.body || ""}`);
  for (const t of tasks) texts.set(`task:${t.id}`, `${t.title}\n${t.detail || ""}\n${t.ref || ""}`);
  for (const c of promoted) {
    const key = `task:${c.task_id}`;
    if (texts.has(key)) texts.set(key, `${texts.get(key)}\n${c.body || ""}`);
  }
  for (const r of repos) texts.set(`repo:${r.id}`, `${r.name} ${r.path}`);

  // What is already written, for a process with no memory of writing it: the
  // app's first rebuild after a restart compares against the table instead of
  // rewriting a graph that is already right.
  let prior = memory ? memory.sources : null;
  if (!prior) {
    prior = new Map();
    const page = db.prepare(
      `SELECT e.id, e.source_type || ':' || e.source_id AS source, e.evidence, x.kind, x.name
       FROM edges e JOIN entities x ON x.id = e.target_id
       WHERE e.relation = 'mentions' AND e.target_type = 'entity' AND e.id > :after
       ORDER BY e.id LIMIT 5000`);
    let after = -1;
    for (;;) {
      const rows = page.all({ after });
      for (const r of rows) {
        let entry = prior.get(r.source);
        if (!entry) prior.set(r.source, (entry = { hash: null, hits: new Map() }));
        entry.hits.set(`${r.kind}:${String(r.name).toLowerCase()}`, { kind: r.kind, name: r.name, evidence: r.evidence });
      }
      if (rows.length < 5000) break;
      after = rows[rows.length - 1].id;
      yield;
    }
  }

  const sources = new Map();    // source -> { hash, hits: Map(entityKey -> { kind, name, evidence }) }
  const changed = [];
  let k = 0;
  for (const [source, text] of texts) {
    if (++k % STEP_ROWS === 0) yield;
    const hash = sha(text);
    const before = prior.get(source);
    if (!fresh && before && before.hash === hash) { sources.set(source, before); continue; }
    const hits = new Map();
    for (const hit of extract(text, vocab)) {
      const key = `${hit.kind}:${hit.name.toLowerCase()}`;
      if (!hits.has(key)) hits.set(key, { kind: hit.kind, name: hit.name, evidence: hit.evidence });
    }
    sources.set(source, { hash, hits });
    const same = before && before.hits.size === hits.size &&
      [...hits].every(([key, h]) => before.hits.has(key) && before.hits.get(key).evidence === h.evidence &&
                                     before.hits.get(key).name === h.name);
    if (!same) changed.push(source);
  }
  if (overtaken()) return null;

  // Entities: what the rows mention, plus every project, which oracle_context
  // reaches through its rows even when no text names it.
  const wanted = new Map();     // entityKey -> { kind, name, mentions }
  for (const { hits } of sources.values()) {
    for (const [key, h] of hits) {
      const e = wanted.get(key);
      if (e) e.mentions++; else wanted.set(key, { kind: h.kind, name: h.name, mentions: 1 });
    }
  }
  for (const e of vocab.entries) {
    const key = `${e.kind}:${e.name.toLowerCase()}`;
    if (e.kind === "project" && !wanted.has(key)) wanted.set(key, { kind: e.kind, name: e.name, mentions: 0 });
  }

  // Writes, in short transactions. A caller already inside one gets its writes
  // folded into it, and is never handed the thread mid-way (see rebuild).
  const own = !db.isTransaction;
  // Each op is [write, how many rows it writes], so one note naming forty
  // things counts as forty writes when the batch is sized.
  const ops = [];
  function* flush() {
    let i = 0;
    while (i < ops.length) {
      if (overtaken()) return false;
      if (own) db.exec("BEGIN");
      try {
        let weight = 0;
        while (i < ops.length && (weight === 0 || weight + ops[i][1] <= STEP_WRITES)) {
          ops[i][0]();
          weight += ops[i][1];
          i++;
        }
        if (own) db.exec("COMMIT");
      } catch (error) {
        if (own) { try { db.exec("ROLLBACK"); } catch {} }
        throw error;
      }
      yield;
    }
    ops.length = 0;
    return true;
  }

  const existing = new Map();
  for (const row of db.prepare("SELECT id, kind, name, mentions FROM entities").all()) {
    existing.set(`${row.kind}\u0000${row.name}`, row);
  }
  const insertEntity = db.prepare("INSERT INTO entities (kind, name, mentions) VALUES (:kind, :name, :mentions)");
  const setMentions = db.prepare("UPDATE entities SET mentions = :mentions, last_seen = datetime('now') WHERE id = :id");
  for (const e of wanted.values()) {
    const row = existing.get(`${e.kind}\u0000${e.name}`);
    if (row) {
      e.id = Number(row.id);
      if (Number(row.mentions) !== e.mentions) ops.push([() => setMentions.run({ id: e.id, mentions: e.mentions }), 1]);
    } else {
      ops.push([() => { e.id = Number(insertEntity.run({ kind: e.kind, name: e.name, mentions: e.mentions }).lastInsertRowid); }, 1]);
    }
  }
  if (!(yield* flush())) return null;

  const insertEdge = db.prepare(
    `INSERT INTO edges (source_type, source_id, target_type, target_id, relation, weight, evidence)
     VALUES (:st, :sid, :tt, :tid, :rel, :w, :ev)
     ON CONFLICT(source_type, source_id, target_type, target_id, relation)
     DO UPDATE SET weight = excluded.weight, evidence = excluded.evidence`
  );
  const dropMentions = db.prepare("DELETE FROM edges WHERE source_type = :st AND source_id = :sid AND relation = 'mentions'");
  const split = (source) => { const i = source.indexOf(":"); return [source.slice(0, i), Number(source.slice(i + 1))]; };

  // Mention edges, for the rows whose mentions changed, and none for rows gone.
  const gone = [...prior.keys()].filter((source) => !sources.has(source));
  for (const source of gone) {
    const [st, sid] = split(source);
    ops.push([() => dropMentions.run({ st, sid }), 1]);
  }
  for (const source of changed) {
    const [st, sid] = split(source);
    const { hits } = sources.get(source);
    ops.push([() => {
      dropMentions.run({ st, sid });
      for (const [key, h] of hits) {
        insertEdge.run({ st, sid, tt: "entity", tid: wanted.get(key).id, rel: "mentions", w: 1.0, ev: h.evidence });
      }
    }, 1 + hits.size * 2]);
  }
  if (!(yield* flush())) return null;

  // Structural edges. These come from the schema, so they are facts rather
  // than inferences and carry full weight.
  const facts = new Map();
  const fact = (st, sid, tid, rel) => facts.set(`${st}:${sid}:${tid}:${rel}`, { st, sid: Number(sid), tid: Number(tid), rel });
  for (const n of notes) if (n.project_id) fact("note", n.id, n.project_id, "belongs_to");
  for (const t of tasks) if (t.project_id) fact("task", t.id, t.project_id, "belongs_to");
  for (const r of repos) fact("repo", r.id, r.project_id, r.is_primary ? "primary_repo_of" : "helper_repo_of");
  for (const l of links) fact("link", l.id, l.project_id, "belongs_to");
  const dropEdge = db.prepare("DELETE FROM edges WHERE id = :id");
  let kept = 0;
  for (const row of db.prepare(`SELECT id, source_type, source_id, target_id, relation FROM edges
                                WHERE target_type = 'project' AND relation IN (${STRUCTURAL.map((r) => `'${r}'`).join(",")})`).all()) {
    const key = `${row.source_type}:${row.source_id}:${row.target_id}:${row.relation}`;
    if (facts.has(key)) { facts.delete(key); kept++; } else ops.push([() => dropEdge.run({ id: row.id }), 1]);
  }
  const structural = facts.size + kept;
  for (const f of facts.values()) {
    ops.push([() => insertEdge.run({ st: f.st, sid: f.sid, tt: "project", tid: f.tid, rel: f.rel, w: 1.0, ev: null }), 1]);
  }
  if (!(yield* flush())) return null;

  // Entity-to-entity edges, inferred from co-occurrence in the same row. This
  // is what makes traversal useful: it is how "the truststore work" reaches
  // "the Veteran API" without either note naming the connection outright.
  let mentionCount = 0;
  const pairs = new Map();
  k = 0;
  for (const { hits } of sources.values()) {
    if (++k % STEP_ROWS === 0) yield;
    const ids = [...hits.keys()].map((key) => wanted.get(key).id).sort((a, b) => a - b);
    mentionCount += ids.length;
    const focused = ids.length <= FOCUSED_ROW;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const pk = `${ids[i]}:${ids[j]}`;
        const p = pairs.get(pk);
        if (p) { p.n++; p.focused = p.focused || focused; } else pairs.set(pk, { n: 1, focused });
      }
    }
  }
  k = 0;
  for (const [pk, p] of pairs) {
    if (++k % 20000 === 0) yield;
    if (p.n < 2 && !p.focused) pairs.delete(pk);
  }
  const pairCount = pairs.size;
  for (const row of db.prepare("SELECT id, source_id, target_id, weight FROM edges WHERE relation = 'co_occurs'").all()) {
    const pk = `${row.source_id}:${row.target_id}`;
    const p = pairs.get(pk);
    if (!p) ops.push([() => dropEdge.run({ id: row.id }), 1]);
    else if (Number(row.weight) === p.n) pairs.delete(pk);
  }
  for (const [pk, { n }] of pairs) {
    const [a, b] = pk.split(":").map(Number);
    ops.push([() => insertEdge.run({ st: "entity", sid: a, tt: "entity", tid: b, rel: "co_occurs", w: n,
                                     ev: `appears together in ${n} place${n === 1 ? "" : "s"}` }), 1]);
  }
  if (!(yield* flush())) return null;

  // Entities nothing mentions any more, with whatever still points at them.
  const keep = new Set([...wanted.values()].map((e) => e.id));
  const dropTouching = db.prepare(
    "DELETE FROM edges WHERE (target_type = 'entity' AND target_id = :id) OR (source_type = 'entity' AND source_id = :id)");
  const dropEntity = db.prepare("DELETE FROM entities WHERE id = :id");
  for (const row of existing.values()) {
    const id = Number(row.id);
    if (!keep.has(id)) ops.push([() => { dropTouching.run({ id }); dropEntity.run({ id }); }, 20]);
  }
  if (!(yield* flush())) return null;

  MEMORY.set(db, { vocabSig, sources });
  const learned = {};
  for (const e of vocab.entries) learned[e.kind] = (learned[e.kind] || 0) + 1;
  return {
    entities: wanted.size,
    // Counted rather than asked: COUNT(*) over a million edges is a pause of its own.
    edges: mentionCount + structural + pairCount,
    mentions: mentionCount,
    pairs: pairCount,
    rewritten: changed.length + gone.length,
    learned,
    ms: Date.now() - started,
  };
}

/**
 * Rebuilds the graph at once. For a caller that needs the answer now: the
 * menu item, the tests, and anything already inside a transaction.
 */
function rebuild(db) {
  const generation = (GENERATION.get(db) || 0) + 1;
  GENERATION.set(db, generation);
  return drain(rebuildSteps(db, generation));
}

/**
 * Rebuilds the graph a few milliseconds at a time, so the window stays live.
 * The app calls this after every external write; on a store of thousands of
 * long notes the learning alone is seconds of work, and the main process is
 * also the one drawing the window. Resolves to null if a newer rebuild
 * overtook it, since that one wrote the up-to-date graph.
 */
function rebuildAsync(db, { sliceMs = 25 } = {}) {
  const generation = (GENERATION.get(db) || 0) + 1;
  GENERATION.set(db, generation);
  return pace(rebuildSteps(db, generation), sliceMs);
}

/**
 * When the app should rebuild: at once after a quiet spell, and at most once
 * every gapMs while changes keep coming. A running job writes about once a
 * second, and rebuilding after each would keep the main thread busy with
 * nothing but the graph. The last change of a burst is always followed by a
 * rebuild, so the graph is never left behind once things settle.
 */
function makeRebuildScheduler(run, { gapMs = 30000, now = () => Date.now() } = {}) {
  let last = -Infinity;
  let timer = null;
  let running = null;
  let again = false;
  const fire = () => {
    timer = null;
    if (running) { again = true; return; }
    last = now();
    running = Promise.resolve().then(run).catch(() => {}).finally(() => {
      running = null;
      if (again) { again = false; poke(); }
    });
  };
  function poke() {
    if (timer) return;
    const wait = Math.max(0, last + gapMs - now());
    if (wait === 0 && !running) fire();
    else timer = setTimeout(fire, wait || 0);
  }
  return { poke, pending: () => Boolean(timer || running) };
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
  open, rebuild, rebuildAsync, makeRebuildScheduler, extract, learnVocabulary, vocabularyFrom, seedVocabulary, KINDS,
  findEntities, neighbourhood, connection, stats, graph,
};
