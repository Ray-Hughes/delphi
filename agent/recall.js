/**
 * Recall for agents: ranking, snippets, a budget, and an answer with no model.
 *
 * The MCP server used to answer "what do we know" by returning whole note
 * bodies, up to thirty of them, which cost an agent 10k to 25k tokens a call and
 * grew with every note filed. Memory that is expensive to consult is memory an
 * agent learns to skip. So the default here is the shortest thing that lets an
 * agent decide what to read: an id, a title, a score and one sentence, inside a
 * token budget, with get_note and get_task as the way to say more.
 *
 * Handed sql(query, params) in the server's :p1 style and never opens a
 * database, so it runs on either of the server's routes. No requires: it has to
 * load from Resources/ under whatever Node an editor launched the server with.
 *
 * Ranking is reciprocal rank fusion over up to four lists: the exact phrase,
 * BM25 over titles and bodies, cosine against the stored embeddings when a
 * model answers in time, and the graph (rows that mention an entity the query
 * names). Fusion rather than a weighted sum, because the four scores are on
 * scales that have nothing to do with each other and any weighting would be
 * tuned to one corpus.
 */

// Words that carry no meaning in a question. Kept short on purpose: a ranking
// that ignores "not" or "without" answers the opposite question.
const STOP = new Set((
  "a an and are as at be been but by can could did do does doing for from had has have how i if in into is it its " +
  "me my of on or our so than that the their them then there these they this those to was we were what when where " +
  "which who why will with would you your about any all also just should does there here its get got"
).split(" "));

const RRF_K = 20;
const CHARS_PER_TOKEN = 4;

const tokenRe = /[a-z0-9][a-z0-9_.\-]*[a-z0-9]|[a-z0-9]/g;

/** A crude stem: enough that "handoffs" finds "handoff", nothing cleverer. */
function stem(word) {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

/** Search terms: words, and the pieces of a dotted or hyphenated name. */
function terms(text) {
  const out = [];
  const lower = String(text || "").toLowerCase();
  tokenRe.lastIndex = 0;
  let m;
  while ((m = tokenRe.exec(lower))) {
    const t = m[0];
    if (!STOP.has(t)) out.push(stem(t));
    if (/[._-]/.test(t)) for (const piece of t.split(/[._-]+/)) if (piece.length > 1 && !STOP.has(piece)) out.push(stem(piece));
  }
  return out;
}

/**
 * Markdown down to the words a person would read aloud, one paragraph or list
 * item per line. Notes are hard wrapped, so a line is not a sentence: lines are
 * joined back into their paragraph, and only a blank line, a heading, a list
 * item or a table row starts a new one. Underscores inside a word stay, because
 * they are usually an identifier (add_correlation) rather than emphasis.
 */
function plain(text) {
  const out = [];
  let para = [];
  const flush = () => { if (para.length) out.push(para.join(" ")); para = []; };
  const body = String(text || "")
    .replace(/```[\s\S]*?```/g, "\n\n")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || /^\|.*\|$/.test(line) || /^[-=*_]{3,}$/.test(line)) { flush(); continue; }
    const heading = /^#{1,6}\s/.test(line);
    const item = /^([-*+]|\d+[.)])\s/.test(line);
    if (heading || item) flush();
    para.push(line
      .replace(/^#{1,6}\s*/, "")
      .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")
      .replace(/^>+\s*/, "")
      .replace(/[*`]+/g, "")
      .replace(/(^|\s)_+|_+(?=\s|$|[.,;:])/g, "$1"));
    if (heading) flush();
  }
  flush();
  return out.join("\n");
}

/** Sentences, with each list item and heading a sentence in its own right. */
function sentences(text) {
  const out = [];
  for (const line of plain(text).split("\n")) {
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z0-9"(])/)) {
      const v = s.trim();
      if (v.length >= 3) out.push(v);
    }
  }
  return out;
}

function clip(text, limit) {
  const value = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return (space > limit * 0.6 ? cut.slice(0, space) : cut) + "…";
}

const round = (n) => Math.round(n * 100) / 100;

/** A stored vector, from the hex SQLite hands back on either route. */
function decode(hex) {
  const bytes = Buffer.from(String(hex), "hex");
  const v = new Float32Array(bytes.length / 4);
  for (let j = 0; j < v.length; j++) v[j] = bytes.readFloatLE(j * 4);
  return v;
}

/**
 * Cosine, not the dot product the query ranking uses: a query vector comes
 * back normalised from the model, but two stored vectors were written by
 * whichever model was configured at the time and are not promised to be.
 */
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// How near a note's stored vector has to be to the task's before "Similar
// meaning" is said. Embedding models put almost any two notes in the same
// language near 0.6: on a real tracker, a task about Prometheus scored 0.63 to
// 0.64 against five unrelated notes, while a devtest retest scored 0.7 to 0.77
// against the devtest runbooks it should find.
const SIMILAR_MIN = 0.68;

// How much of a task's rare words a note must share before "Similar wording"
// is said. Measured on a real tracker: at 0.3 the cards were the ones a person
// would have picked; below it, notes sharing two common words crept in.
const WORDS_MIN = 0.3;

// Strongest first. The card says the first reason it has; the rest go in its
// tooltip. A fact about where the note came from outranks a guess from its
// words, and the project's own decisions come last because they are filler.
const SIGNAL_ORDER = ["sheet", "link", "file", "entity", "workbench", "seen", "meaning", "words", "project"];

/**
 * One signal as the few words a card shows. Pure, so the window, the server
 * and a test all say it the same way.
 */
function whyRelated(signal) {
  const s = signal || {};
  switch (s.kind) {
    case "sheet": return "From this task's Sheet";
    case "link": return "Linked to this task";
    case "file": return `Same file: ${clip(s.name, 40)}`;
    case "entity": return `Both name ${clip(s.name, 40)}`;
    case "workbench": return s.task != null ? `Same Workbench, #${s.task}` : "Same Workbench";
    case "seen": return s.task != null ? `Seen on #${s.task}` : "Seen on a nearby task";
    case "meaning": return "Similar meaning";
    case "words": return "Similar wording";
    case "project": return `Same project, ${s.noteKind || "note"}`;
    default: return "Related";
  }
}

/** The sentence in a body that best matches the query, or its first one. */
function snippet(body, queryTerms, limit = 160) {
  const list = sentences(body);
  if (!list.length) return "";
  if (queryTerms.size) {
    let best = null;
    let bestScore = 0;
    for (const s of list) {
      let score = 0;
      for (const t of new Set(terms(s))) if (queryTerms.has(t)) score++;
      if (score > bestScore) { best = s; bestScore = score; }
    }
    if (best) return clip(best, limit);
  }
  return clip(list[0], limit);
}

/**
 * Trims a result until its JSON fits the budget. Each round shortens whichever
 * is bigger: the longest list, from its end since every list is in rank order,
 * or the longest single string anywhere in the result, cut in half. A list alone
 * was not enough: one huge note title or Sheet text sailed through any budget.
 * Says so, so an agent knows to ask for more rather than assume there is none.
 */
function fit(result, budgetTokens, lists = []) {
  const limit = budgetTokens * CHARS_PER_TOKEN;
  let size = JSON.stringify(result).length;
  while (size > limit) {
    let longest = null;
    let longestSize = 0;
    for (const key of lists) {
      const list = result[key];
      if (!Array.isArray(list) || !list.length) continue;
      const s = JSON.stringify(list).length;
      if (s > longestSize) { longest = key; longestSize = s; }
    }
    const field = longestString(result);
    if (field && field.length > 80 && field.length >= longestSize) {
      const cut = Math.max(80, Math.floor(field.length / 2));
      field.holder[field.key] = field.value.slice(0, cut) + "…";
    } else if (longest) {
      result[longest].pop();
    } else {
      break;
    }
    result.trimmed = true;
    size = JSON.stringify(result).length;
  }
  return result;
}

/** The longest string in a result, and where it sits, so fit can shorten it. */
function longestString(value, best = null) {
  if (!value || typeof value !== "object") return best;
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (typeof v === "string") {
      if (!best || v.length > best.length) best = { holder: value, key, value: v, length: v.length };
    } else if (v && typeof v === "object") {
      best = longestString(v, best);
    }
  }
  return best;
}

/**
 * Builds the recall functions over one database.
 *
 * embedQuery(text) resolves to { model, vector } or null, and must give up
 * quickly: it is asked on every call, and a model that is not running has to
 * cost an agent nothing more than a lexical answer.
 */
function makeRecall({ sql, hasTable = () => true, embedQuery = async () => null } = {}) {
  let corpus = null;
  const vectors = new Map();

  /** Notes and tasks, indexed for BM25, rebuilt only when a row changed. */
  function load() {
    const sig = sql(`SELECT
        (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) || ':' || COALESCE(MAX(updated_at), '') || ':' ||
                COALESCE(SUM(length(body)), 0) FROM notes) || '|' ||
        (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) || ':' || COALESCE(MAX(updated_at), '') || ':' ||
                COALESCE(SUM(length(COALESCE(detail, '')) + length(title)), 0) FROM tasks) AS sig`)[0].sig;
    if (corpus && corpus.sig === sig) return corpus;

    const notes = sql(`SELECT n.id, n.title, n.kind, n.body, n.project_id, p.name AS project, n.updated_at
                       FROM notes n LEFT JOIN projects p ON p.id = n.project_id`);
    const tasks = sql(`SELECT t.id, t.title, t.detail, t.status, t.priority, t.ref, t.project_id,
                              p.name AS project, t.updated_at
                       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id`);
    const docs = [];
    const df = new Map();
    const add = (type, row, title, body) => {
      const tf = new Map();
      // The title counts three times: it is what the writer said the row is about.
      const words = [...terms(title), ...terms(title), ...terms(title), ...terms(body)];
      for (const w of words) tf.set(w, (tf.get(w) || 0) + 1);
      for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
      docs.push({ type, id: Number(row.id), row, tf, len: words.length, haystack: `${title}\n${body}`.toLowerCase() });
    };
    for (const n of notes) add("note", n, n.title, n.body || "");
    for (const t of tasks) add("task", t, t.title, `${t.detail || ""} ${t.ref || ""}`);
    const avg = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1);
    corpus = { sig, docs, df, avg, byKey: new Map(docs.map((d) => [`${d.type}:${d.id}`, d])) };
    return corpus;
  }

  function idf(c, term) {
    const n = c.df.get(term) || 0;
    return Math.log(1 + (c.docs.length - n + 0.5) / (n + 0.5));
  }

  function bm25(c, queryTerms) {
    const k1 = 1.2;
    const b = 0.75;
    const scored = [];
    for (const d of c.docs) {
      let s = 0;
      for (const t of queryTerms) {
        const f = d.tf.get(t);
        if (!f) continue;
        s += idf(c, t) * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / c.avg));
      }
      if (s > 0) scored.push([d, s]);
    }
    return scored.sort((a, b2) => b2[1] - a[1]).map(([d]) => d);
  }

  /** Stored vectors for one model, decoded once and kept while unchanged. */
  function storedVectors(model) {
    const rows = sql(`SELECT id, source_type, source_id, created_at, content_hash FROM embeddings
                      WHERE model = :p1 AND source_type IN ('note', 'task')`, [model]);
    const want = [];
    const live = new Set();
    for (const r of rows) {
      const key = `${model}|${r.source_type}:${r.source_id}`;
      live.add(key);
      const stamp = `${r.created_at}|${r.content_hash}`;
      const have = vectors.get(key);
      if (!have || have.stamp !== stamp) want.push({ id: Number(r.id), key, stamp });
    }
    for (let i = 0; i < want.length; i += 200) {
      const batch = want.slice(i, i + 200);
      const byId = new Map(batch.map((w) => [w.id, w]));
      const got = sql(`SELECT id, hex(vector) AS hex FROM embeddings WHERE id IN (${batch.map((w) => w.id).join(",")})`);
      for (const g of got) {
        const w = byId.get(Number(g.id));
        vectors.set(w.key, { stamp: w.stamp, vec: decode(g.hex) });
      }
    }
    for (const key of vectors.keys()) if (key.startsWith(`${model}|`) && !live.has(key)) vectors.delete(key);
    return [...vectors.entries()].filter(([k]) => k.startsWith(`${model}|`)).map(([k, v]) => [k.slice(model.length + 1), v.vec]);
  }

  /** Rows nearest the query by meaning, or null when no model answered. */
  async function semantic(c, text) {
    if (!hasTable("embeddings")) return { list: null, why: "no embeddings table" };
    let q = null;
    try { q = await embedQuery(text); } catch { q = null; }
    if (!q || !q.vector) return { list: null, why: "no embedding model answered" };
    const stored = storedVectors(q.model);
    if (!stored.length) return { list: null, why: `nothing embedded with ${q.model}` };
    const scored = [];
    for (const [key, vec] of stored) {
      if (vec.length !== q.vector.length) continue;
      let dot = 0;
      for (let i = 0; i < vec.length; i++) dot += vec[i] * q.vector[i];
      const d = c.byKey.get(key);
      if (d) scored.push([d, dot]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    return { list: scored.slice(0, 30).map(([d]) => d), model: q.model };
  }

  /** Rows that mention an entity the text names, most entities first. */
  function graphHits(c, text) {
    if (!hasTable("entities") || !hasTable("edges")) return { list: [], entities: [] };
    const named = sql(
      `SELECT id, kind, name FROM entities
       WHERE length(name) >= 3 AND instr(lower(:p1), lower(name)) > 0
       ORDER BY length(name) DESC, mentions DESC LIMIT 8`, [String(text)]);
    // A name inside a longer matched name is the same mention: "API" in "Veteran API".
    const kept = named.filter((e, i) => !named.slice(0, i).some((o) => o.name.toLowerCase().includes(e.name.toLowerCase())));
    if (!kept.length) return { list: [], entities: [] };
    const rows = sql(
      `SELECT source_type, source_id, COUNT(*) AS n FROM edges
       WHERE relation = 'mentions' AND target_type = 'entity' AND source_type IN ('note', 'task')
         AND target_id IN (${kept.map((e) => Number(e.id)).join(",")})
       GROUP BY source_type, source_id ORDER BY n DESC LIMIT 60`);
    const list = rows.map((r) => c.byKey.get(`${r.source_type}:${r.source_id}`)).filter(Boolean);
    return { list, entities: kept };
  }

  /** Reciprocal rank fusion. Returns [doc, score 0..1] in order. */
  function fuse(lists) {
    const score = new Map();
    for (const { list, weight = 1 } of lists) {
      if (!list) continue;
      list.forEach((d, rank) => score.set(d, (score.get(d) || 0) + weight / (RRF_K + rank + 1)));
    }
    const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked.length ? ranked[0][1] : 1;
    return ranked.map(([d, s]) => [d, s / top]);
  }

  async function rank(text, { exact = false } = {}) {
    const c = load();
    const queryTerms = [...new Set(terms(text))];
    const lexical = bm25(c, queryTerms);
    const lists = [{ list: lexical }];
    if (exact) {
      // search has always meant "where is this written", so a row containing
      // the query as typed comes first however the other lists rank it.
      const needle = String(text).toLowerCase().trim();
      if (needle) lists.push({ list: c.docs.filter((d) => d.haystack.includes(needle)), weight: 2 });
    }
    const sem = await semantic(c, text);
    if (sem.list) lists.push({ list: sem.list });
    const graph = graphHits(c, text);
    if (graph.list.length) lists.push({ list: graph.list, weight: 0.5 });
    const methods = ["lexical", ...(sem.list ? ["semantic"] : []), ...(graph.list.length ? ["graph"] : [])];
    return {
      c, queryTerms: new Set(queryTerms), ranked: fuse(lists), graph,
      ranking: methods.join("+") + (sem.list ? ` (${sem.model})` : ""),
      semantic_off: sem.list ? undefined : sem.why,
    };
  }

  /**
   * The other projects each note and task is shown in, read fresh per answer:
   * an association is one row and changes without touching the item, so the
   * corpus signature would not see it.
   */
  function alsoIn() {
    if (!hasTable("item_projects")) return new Map();
    const rows = sql(`SELECT ip.entity, ip.entity_id, GROUP_CONCAT(p.name, ', ') AS names FROM item_projects ip
                      JOIN projects p ON p.id = ip.project_id WHERE ip.entity IN ('note', 'task')
                      GROUP BY ip.entity, ip.entity_id`);
    return new Map(rows.map((r) => [`${r.entity}:${r.entity_id}`, r.names]));
  }
  let also = new Map();
  const alsoFor = (d) => also.get(`${d.type}:${d.id}`) || undefined;

  const noteItem = (d, score, qt) => ({
    id: d.id, title: d.row.title, kind: d.row.kind || undefined, project: d.row.project || undefined,
    also_in: alsoFor(d), score: round(score), snippet: snippet(d.row.body, qt) || undefined,
  });
  const taskItem = (d, score, qt) => {
    const item = { id: d.id, title: d.row.title, status: d.row.status, project: d.row.project || undefined, also_in: alsoFor(d), score: round(score) };
    if (d.row.ref) item.ref = d.row.ref;
    // A task's title is its summary; the detail only earns a line when it is
    // where the match was.
    if (d.row.detail && [...qt].some((t) => terms(d.row.detail).includes(t)) &&
        ![...qt].every((t) => terms(d.row.title).includes(t))) item.snippet = snippet(d.row.detail, qt, 120);
    return item;
  };

  /** search, compact: the rows that match, best first, one line each. */
  async function search(query, { limit = 8, budget = 1500 } = {}) {
    const r = await rank(query, { exact: true });
    also = alsoIn();
    // Only rows some list actually matched: fusion puts every graph neighbour
    // in the running, and a search that returns rows without the word in them
    // reads as broken.
    const matched = r.ranked.filter(([d]) => d.haystack.includes(String(query).toLowerCase().trim()) ||
      [...r.queryTerms].some((t) => d.tf.has(t)) || r.ranking.includes("semantic"));
    const notes = matched.filter(([d]) => d.type === "note");
    const tasks = matched.filter(([d]) => d.type === "task");
    return fit({
      query,
      ranking: r.ranking,
      ...(r.semantic_off ? { semantic_off: r.semantic_off } : {}),
      total: { notes: notes.length, tasks: tasks.length },
      notes: notes.slice(0, limit).map(([d, s]) => noteItem(d, s, r.queryTerms)),
      tasks: tasks.slice(0, limit).map(([d, s]) => taskItem(d, s, r.queryTerms)),
      more: "get_note {id} or get_task {id} for one in full; detail: \"full\" for the old whole-body answer.",
    }, budget, ["notes", "tasks"]);
  }

  /**
   * An answer assembled from the best notes' own sentences, each cited.
   *
   * Extractive on purpose: no model is called, so it costs nothing and cannot
   * say anything the notes do not. A sentence scores by the rarity of the
   * question's words it contains, and a little by the rank of its note, so the
   * best note leads unless a lower one says the thing more directly.
   */
  function answer(question, top, c, queryTerms) {
    const picked = [];
    top.slice(0, 4).forEach(([d], rank) => {
      sentences(`${d.row.body || ""}`).forEach((s, position) => {
        if (s.length < 25) return;
        const words = new Set(terms(s));
        let score = 0;
        for (const t of queryTerms) if (words.has(t)) score += idf(c, t);
        if (score <= 0) return;
        score = score / Math.sqrt(Math.max(8, words.size) / 8) + 0.5 / (rank + 1);
        picked.push({ id: d.id, rank, position, text: clip(s, 240), words, score });
      });
    });
    picked.sort((a, b) => b.score - a.score);
    const chosen = [];
    let chars = 0;
    for (const p of picked) {
      if (chosen.length >= 3 || chars > 520) break;
      // Two notes often say the same thing; the second copy is no answer.
      const dup = chosen.some((o) => {
        let shared = 0;
        for (const w of p.words) if (o.words.has(w)) shared++;
        return shared / Math.min(p.words.size, o.words.size) > 0.6;
      });
      if (dup) continue;
      chosen.push(p);
      chars += p.text.length;
    }
    if (!chosen.length) {
      const lead = top.slice(0, 2).map(([d]) => ({ id: d.id, text: clip(sentences(d.row.body || "")[0] || d.row.title, 200) }));
      if (!lead.length) return { answer: null, answer_basis: "nothing matched" };
      return { answer: lead.map((l) => `${l.text} [note ${l.id}]`).join(" "), answer_basis: "lead sentences of the best notes; none uses the question's words" };
    }
    chosen.sort((a, b) => a.rank - b.rank || a.position - b.position);
    return { answer: chosen.map((p) => `${p.text} [note ${p.id}]`).join(" "), answer_basis: "sentences from the notes cited" };
  }

  /** oracle_ask, compact: a cited answer, then what it came from. */
  async function ask(question, { limit = 6, budget = 1500 } = {}) {
    const r = await rank(question);
    also = alsoIn();
    const notes = r.ranked.filter(([d]) => d.type === "note");
    const tasks = r.ranked.filter(([d]) => d.type === "task");
    const said = answer(question, notes, r.c, r.queryTerms);

    // What the best notes are connected to: the part plain search cannot do.
    let connected = [];
    const seeds = notes.slice(0, 4).map(([d]) => d.id);
    if (seeds.length && hasTable("edges") && hasTable("entities")) {
      connected = sql(
        `SELECT e2.kind, e2.name, MAX(e2.mentions) AS mentions FROM edges ed
         JOIN entities e2 ON e2.id = ed.target_id
         WHERE ed.source_type = 'note' AND ed.target_type = 'entity' AND ed.relation = 'mentions'
           AND ed.source_id IN (${seeds.join(",")})
         GROUP BY e2.id ORDER BY mentions DESC LIMIT 10`).map((e) => `${e.name} (${e.kind})`);
    }
    return fit({
      ...said,
      ranking: r.ranking,
      ...(r.semantic_off ? { semantic_off: r.semantic_off } : {}),
      notes: notes.slice(0, limit).map(([d, s]) => noteItem(d, s, r.queryTerms)),
      tasks: tasks.slice(0, limit).map(([d, s]) => taskItem(d, s, r.queryTerms)),
      connected,
      more: "get_note {id} for a note in full; oracle_context {name} for everything about one thing; detail: \"full\" for whole bodies.",
    }, budget, ["connected", "tasks", "notes"]);
  }

  /** The entity a name means: an exact name first, a project before a mention. */
  function findEntity(name) {
    const exact = sql(
      `SELECT id, kind, name, mentions FROM entities WHERE lower(name) = lower(:p1)
       ORDER BY kind = 'project' DESC, mentions DESC LIMIT 1`, [name])[0];
    if (exact) return exact;
    return sql(
      `SELECT id, kind, name, mentions FROM entities WHERE name LIKE :p1
       ORDER BY kind = 'project' DESC, mentions DESC LIMIT 1`, [`%${name}%`])[0] || null;
  }

  /** The projects a project entity stands for: "Delphi" is two of them. */
  function projectsNamed(name) {
    return sql(
      `SELECT id, name FROM projects
       WHERE lower(name) = lower(:p1) OR lower(key) = lower(:p1)
          OR lower(name) LIKE lower(:p1) || ':%' OR lower(name) LIKE lower(:p1) || ' (%'
          OR lower(name) LIKE lower(:p1) || ' - %'`, [name]);
  }

  /** oracle_context, compact. With no name, the entities the graph knows. */
  function context(name, { limit = 8, budget = 1500, kind = null } = {}) {
    const graphed = hasTable("entities") && hasTable("edges");
    if (!name) {
      if (!graphed) return { entities: [], note: "The graph has not been built yet: open the Delphi app once." };
      const params = kind ? [kind, 60] : [60];
      const rows = sql(`SELECT kind, name, mentions FROM entities ${kind ? "WHERE kind = :p1" : ""}
                        ORDER BY mentions DESC LIMIT :p${params.length}`, params);
      return fit({ entities: rows.map((e) => `${e.name} (${e.kind}, ${e.mentions})`),
        more: "oracle_context {name} for any of these." }, budget, ["entities"]);
    }

    let entity = graphed ? findEntity(name) : null;
    let projects = projectsNamed(entity && entity.kind === "project" ? entity.name : name);
    if (!entity && projects.length) entity = { id: null, kind: "project", name: projects[0].name, mentions: 0 };
    if (!entity) {
      const similar = graphed ? sql(
        `SELECT kind, name FROM entities WHERE name LIKE :p1 OR :p2 LIKE '%' || name || '%'
         ORDER BY mentions DESC LIMIT 10`, [`%${String(name).slice(0, 3)}%`, String(name)]) : [];
      const fallback = similar.length ? similar : graphed
        ? sql("SELECT kind, name FROM entities ORDER BY mentions DESC LIMIT 10") : [];
      return { found: false, name, suggestions: fallback.map((e) => `${e.name} (${e.kind})`),
        more: "search {query} looks for the words instead." };
    }
    if (entity.kind !== "project") projects = [];

    // Mentions, and for a project every row filed under it. A row that names
    // the thing in its title is about it; one that names it in passing is not.
    const notes = new Map();
    const tasks = new Map();
    if (entity.id != null) {
      for (const n of sql(
        `SELECT n.id, n.title, n.kind, n.updated_at, p.name AS project, e.evidence
         FROM edges e JOIN notes n ON n.id = e.source_id LEFT JOIN projects p ON p.id = n.project_id
         WHERE e.source_type = 'note' AND e.target_type = 'entity' AND e.target_id = :p1 AND e.relation = 'mentions'`,
        [entity.id])) notes.set(Number(n.id), n);
      for (const t of sql(
        `SELECT t.id, t.title, t.status, t.ref, t.updated_at, p.name AS project
         FROM edges e JOIN tasks t ON t.id = e.source_id LEFT JOIN projects p ON p.id = t.project_id
         WHERE e.source_type = 'task' AND e.target_type = 'entity' AND e.target_id = :p1 AND e.relation = 'mentions'`,
        [entity.id])) tasks.set(Number(t.id), t);
    }
    if (projects.length) {
      const ids = projects.map((p) => Number(p.id)).join(",");
      // Filed under the project, or shown in it from another: an association
      // is a person saying it is this project's business too.
      const shown = (entity, alias) => (hasTable("item_projects")
        ? ` OR ${alias}.id IN (SELECT entity_id FROM item_projects WHERE entity = '${entity}' AND project_id IN (${ids}))` : "");
      for (const n of sql(`SELECT n.id, n.title, n.kind, n.updated_at, p.name AS project, substr(n.body, 1, 600) AS body
                           FROM notes n LEFT JOIN projects p ON p.id = n.project_id WHERE n.project_id IN (${ids})${shown("note", "n")}`)) {
        if (!notes.has(Number(n.id))) notes.set(Number(n.id), n);
      }
      for (const t of sql(`SELECT t.id, t.title, t.status, t.ref, t.updated_at, p.name AS project
                           FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.project_id IN (${ids})${shown("task", "t")}`)) {
        if (!tasks.has(Number(t.id))) tasks.set(Number(t.id), t);
      }
    }
    const lname = entity.name.toLowerCase();
    const kindRank = { decision: 0, gotcha: 1, reference: 2 };
    const noteList = [...notes.values()].sort((a, b) =>
      (b.title.toLowerCase().includes(lname) - a.title.toLowerCase().includes(lname)) ||
      ((kindRank[a.kind] ?? 3) - (kindRank[b.kind] ?? 3)) ||
      String(b.updated_at).localeCompare(String(a.updated_at)));
    // In review ranks just after doing: finished work waiting on a look. A
    // status missing here is one a newer Delphi wrote, which reads as in
    // progress and ranks with review rather than with todo.
    const statusRank = { doing: 0, review: 1, blocked: 2, todo: 3, done: 4 };
    const taskList = [...tasks.values()].sort((a, b) =>
      ((statusRank[a.status] ?? 1) - (statusRank[b.status] ?? 1)) ||
      String(b.updated_at).localeCompare(String(a.updated_at)));

    const spans = entity.id != null ? sql(`
      SELECT DISTINCT p.name FROM edges e JOIN notes n ON e.source_type = 'note' AND n.id = e.source_id
      JOIN projects p ON p.id = n.project_id WHERE e.target_type = 'entity' AND e.target_id = :p1
      UNION
      SELECT DISTINCT p.name FROM edges e JOIN tasks t ON e.source_type = 'task' AND t.id = e.source_id
      JOIN projects p ON p.id = t.project_id WHERE e.target_type = 'entity' AND e.target_id = :p1`, [entity.id]).map((p) => p.name) : [];
    // "Spans" is true by declaration too, not only by mention: the projects the
    // rows found are shown in count as projects this thing reaches.
    if (hasTable("item_projects") && (noteList.length || taskList.length)) {
      const pick = (list) => list.map((r) => Number(r.id)).join(",") || "0";
      for (const r of sql(`SELECT DISTINCT p.name FROM item_projects ip JOIN projects p ON p.id = ip.project_id
                            WHERE (ip.entity = 'note' AND ip.entity_id IN (${pick(noteList)}))
                               OR (ip.entity = 'task' AND ip.entity_id IN (${pick(taskList)}))`)) {
        if (!spans.includes(r.name)) spans.push(r.name);
      }
    }
    const related = entity.id != null ? sql(`
      SELECT o.kind, o.name FROM edges e
      JOIN entities o ON o.id = CASE WHEN e.source_id = :p1 THEN e.target_id ELSE e.source_id END
      WHERE e.relation = 'co_occurs' AND e.source_type = 'entity' AND e.target_type = 'entity'
        AND (e.source_id = :p1 OR e.target_id = :p1)
      ORDER BY e.weight DESC LIMIT 10`, [entity.id]).map((e) => `${e.name} (${e.kind})`) : [];

    also = alsoIn();
    return fit({
      entity: { id: entity.id, kind: entity.kind, name: entity.name, mentions: entity.mentions },
      projects: [...new Set([...projects.map((p) => p.name), ...spans])],
      total: { notes: noteList.length, tasks: taskList.length },
      notes: noteList.slice(0, limit).map((n) => ({
        id: Number(n.id), title: n.title, kind: n.kind || undefined, project: n.project || undefined,
        also_in: also.get(`note:${n.id}`) || undefined,
        evidence: n.evidence ? clip(n.evidence, 140) : (n.body ? snippet(n.body, new Set(), 140) : undefined),
      })),
      tasks: taskList.slice(0, limit).map((t) => ({
        id: Number(t.id), title: t.title, status: t.status, project: t.project || undefined,
        also_in: also.get(`task:${t.id}`) || undefined, ...(t.ref ? { ref: t.ref } : {}),
      })),
      related,
      more: "get_note {id} or get_task {id} to read one; limit for more rows; detail: \"full\" for whole bodies.",
    }, budget, ["related", "tasks", "notes"]);
  }


  /**
   * The notes worth having beside a task, each with the reason it is there.
   *
   * No model is called. Every reason is a fact the database already holds, so a
   * card can say it in a few words and a person can check it: the note was
   * filed from this task's Sheet, an edge joins the two, both mention the same
   * file or name, it was filed in the same Workbench or on a task next to this
   * one, its stored vector is near the task's, or its words are. Only when those
   * run out do the project's own decisions and gotchas fill the list, and they
   * say that is all they are. A card shown for no stated reason is a card a
   * person learns to skip, which is the whole point of slice 15.
   */
  function related(taskId, { limit = 6 } = {}) {
    const id = Number(taskId);
    if (!Number.isInteger(id)) throw new Error("task_id must be a number.");
    const task = sql(`SELECT id, title, detail, ref, project_id, parent_id FROM tasks WHERE id = :p1`, [id])[0];
    if (!task) return null;
    const c = load();
    const found = new Map();
    const add = (noteId, signal) => {
      const d = c.byKey.get(`note:${Number(noteId)}`);
      if (!d) return;
      const list = found.get(d) || [];
      if (!list.some((s) => s.kind === signal.kind)) list.push(signal);
      list.hits = (list.hits || 0) + 1;
      found.set(d, list);
    };
    const n = (v) => (v == null ? null : Number(v));

    // Filed from this task's own Sheet: the strongest claim there is.
    for (const r of sql(`SELECT DISTINCT note_id FROM comments WHERE task_id = :p1 AND note_id IS NOT NULL`, [id])) {
      add(r.note_id, { kind: "sheet" });
    }

    const graphed = hasTable("edges") && hasTable("entities");
    if (graphed) {
      // An edge between the two, whichever way round it was drawn.
      for (const r of sql(
        `SELECT source_id AS note FROM edges WHERE source_type = 'note' AND target_type = 'task' AND target_id = :p1
         UNION SELECT target_id FROM edges WHERE target_type = 'note' AND source_type = 'task' AND source_id = :p1`, [id])) {
        add(r.note, { kind: "link" });
      }
      // The things both name. The graph's own edges from the task are trusted;
      // the task's words are read only when the graph has not reached the task
      // yet, and then as whole words, so "COR" is not found in "correct". A
      // project entity is left out, and so is any name most notes mention,
      // because a name on every row explains none of them. The rarest shared
      // name is the one the card says; each one shared counts toward its order.
      const text = `${task.title || ""}\n${task.detail || ""}\n${task.ref || ""}`;
      const indexed = sql(`SELECT COUNT(*) AS n FROM edges WHERE source_type = 'task' AND source_id = :p1
                            AND target_type = 'entity' AND relation = 'mentions'`, [id])[0];
      const byGraph = Number(indexed && indexed.n) > 0;
      const noteCount = c.docs.filter((d) => d.type === "note").length;
      const tooCommon = Math.max(4, Math.ceil(noteCount * 0.12));
      const rows = sql(
        `SELECT e.source_id AS note, en.kind, en.name,
                (SELECT COUNT(*) FROM edges x WHERE x.target_type = 'entity' AND x.target_id = en.id
                   AND x.source_type = 'note' AND x.relation = 'mentions') AS spread
           FROM edges e JOIN entities en ON en.id = e.target_id
          WHERE e.source_type = 'note' AND e.target_type = 'entity' AND e.relation = 'mentions' AND en.kind != 'project'
            AND ${byGraph
              ? "e.target_id IN (SELECT target_id FROM edges WHERE source_type = 'task' AND source_id = :p1 AND target_type = 'entity' AND relation = 'mentions')"
              : "length(en.name) >= 3 AND instr(lower(:p1), lower(en.name)) > 0"}
          ORDER BY spread ASC, length(en.name) DESC`, [byGraph ? id : text]);
      const escape = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const r of rows) {
        if (Number(r.spread) > tooCommon) continue;
        if (!byGraph && !new RegExp(`(^|[^A-Za-z0-9_])${escape(r.name)}(?![A-Za-z0-9_])`, "i").test(text)) continue;
        add(r.note, r.kind === "file" ? { kind: "file", name: r.name } : { kind: "entity", name: r.name });
      }
    }

    // Filed in the same Workbench: another task on this task's branch.
    if (hasTable("workbenches")) {
      for (const r of sql(
        `SELECT DISTINCT c.note_id, c.task_id, w2.branch FROM workbenches w1
         JOIN workbenches w2 ON w2.repo_id = w1.repo_id AND w2.branch = w1.branch AND w2.task_id != w1.task_id
         JOIN comments c ON c.task_id = w2.task_id AND c.note_id IS NOT NULL
         WHERE w1.task_id = :p1`, [id])) {
        add(r.note_id, { kind: "workbench", branch: r.branch, task: n(r.task_id) });
      }
    }

    // Filed on the task above this one, below it, or beside it.
    for (const r of sql(
      `SELECT c.note_id, c.task_id FROM comments c JOIN tasks t ON t.id = c.task_id
       WHERE c.note_id IS NOT NULL AND t.id != :p1
         AND (t.id = :p2 OR t.parent_id = :p1 OR (:p2 IS NOT NULL AND t.parent_id = :p2))
       ORDER BY c.id DESC`, [id, n(task.parent_id)])) {
      add(r.note_id, { kind: "seen", task: n(r.task_id) });
    }

    // Near in meaning, from the vectors already stored for both. The task's own
    // vector is read, never asked for, so this costs no model call; with none
    // stored the list is words alone.
    if (hasTable("embeddings")) {
      // The newest, when more than one model has embedded the task: it is the
      // one the notes were most likely embedded with too.
      const mine = sql(`SELECT model, hex(vector) AS hex FROM embeddings WHERE source_type = 'task' AND source_id = :p1
                         ORDER BY created_at DESC, id DESC LIMIT 1`, [id])[0];
      if (mine) {
        const q = decode(mine.hex);
        const scored = [];
        for (const [key, vec] of storedVectors(mine.model)) {
          if (!key.startsWith("note:") || vec.length !== q.length) continue;
          const s = cosine(q, vec);
          if (s >= SIMILAR_MIN) scored.push([key.slice(5), s]);
        }
        scored.sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([noteId, s]) => add(noteId, { kind: "meaning", score: round(s) }));
      }
    }

    // Near in wording: BM25 over the notes alone, against the task's words.
    // Two shared words at least, carrying a fair share of what is rare in the
    // task (WORDS_MIN of its idf), so a long task title that happens to share
    // "handoff" and "send" with a note does not make it "similar".
    const qt = [...new Set(terms(`${task.title || ""} ${task.detail || ""}`))];
    if (qt.length) {
      let kept = 0;
      const whole = qt.reduce((sum, t) => sum + idf(c, t), 0);
      for (const d of bm25(c, qt)) {
        if (d.type !== "note") continue;
        const shared = qt.filter((t) => d.tf.has(t));
        if (shared.length < Math.min(2, qt.length)) continue;
        if (shared.reduce((sum, t) => sum + idf(c, t), 0) < WORDS_MIN * whole) continue;
        add(d.id, { kind: "words", shared: shared.slice(0, 3) });
        if (++kept >= 5) break;
      }
    }

    // What fills the list when the reasons run out: this project's decisions
    // and gotchas, newest first. They say so, rather than borrowing a reason.
    if (found.size < limit && task.project_id != null) {
      for (const r of sql(
        `SELECT id, kind FROM notes WHERE project_id = :p1 AND kind IN ('decision', 'gotcha')
         ORDER BY updated_at DESC, id DESC LIMIT :p2`, [Number(task.project_id), limit * 2])) {
        if (found.size >= limit) break;
        const d = c.byKey.get(`note:${Number(r.id)}`);
        if (d && !found.has(d)) add(r.id, { kind: "project", noteKind: r.kind });
      }
    }

    also = alsoIn();
    const cards = [...found.entries()].map(([d, signals]) => {
      signals.sort((a, b) => SIGNAL_ORDER.indexOf(a.kind) - SIGNAL_ORDER.indexOf(b.kind));
      return {
        id: d.id, title: d.row.title, kind: d.row.kind || "note", project: d.row.project || undefined,
        project_id: d.row.project_id == null ? null : Number(d.row.project_id), updated_at: d.row.updated_at,
        also_in: alsoFor(d), why: whyRelated(signals[0]),
        reasons: signals.map((s) => whyRelated(s)),
        // The trailer a filed note carries says where it came from, which the
        // reason already does.
        signal: signals[0].kind, snippet: snippet(String(d.row.body || "").replace(/\s*From task #\d+, entry \d+\s*$/, ""), new Set(qt), 140) || undefined,
        _rank: SIGNAL_ORDER.indexOf(signals[0].kind), _n: signals.hits,
      };
    });
    cards.sort((a, b) => (a._rank - b._rank) || (b._n - a._n) || String(b.updated_at).localeCompare(String(a.updated_at)));
    return {
      task: id,
      notes: cards.slice(0, Math.max(1, Math.min(Number(limit) || 6, 30))).map(({ _rank, _n, ...card }) => card),
      total: cards.length,
    };
  }

  /** Why a search found a note, in a few words, for the window's Memory search. */
  function searchWhy(d, r, needle) {
    const title = String(d.row.title || "").toLowerCase();
    if (needle && title.includes(needle)) return "In the title";
    if (needle && d.haystack.includes(needle)) return "In the text";
    const named = r.graph.entities.find((e) => d.haystack.includes(String(e.name).toLowerCase()));
    if (named && r.graph.list.includes(d)) return `Names ${named.name}`;
    if ([...r.queryTerms].some((t) => d.tf.has(t))) return "Similar wording";
    return "Similar meaning";
  }

  /**
   * search, for the window: the notes only, each with its reason. Scoped to a
   * project (its own notes and those shown in it) when one is named.
   */
  async function searchNotes(query, { limit = 30, projectId = null } = {}) {
    const r = await rank(query, { exact: true });
    also = alsoIn();
    const needle = String(query).toLowerCase().trim();
    let inScope = null;
    if (projectId != null) {
      const pid = Number(projectId);
      inScope = new Set(sql(`SELECT id FROM notes WHERE project_id = :p1`, [pid]).map((x) => Number(x.id)));
      if (hasTable("item_projects")) {
        for (const x of sql(`SELECT entity_id FROM item_projects WHERE entity = 'note' AND project_id = :p1`, [pid])) inScope.add(Number(x.entity_id));
      }
    }
    const notes = r.ranked.filter(([d]) => d.type === "note" && (!inScope || inScope.has(d.id)) &&
      (d.haystack.includes(needle) || [...r.queryTerms].some((t) => d.tf.has(t)) || r.ranking.includes("semantic")));
    return {
      query,
      total: notes.length,
      notes: notes.slice(0, limit).map(([d, s]) => ({
        ...noteItem(d, s, r.queryTerms), project_id: d.row.project_id == null ? null : Number(d.row.project_id),
        updated_at: d.row.updated_at, why: searchWhy(d, r, needle),
      })),
    };
  }

  return { search, ask, context, load, related, searchNotes };
}

module.exports = { makeRecall, whyRelated, SIGNAL_ORDER, terms, sentences, snippet, clip, fit, plain };
