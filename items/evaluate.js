/**
 * The Oracle's answer to "where does this belong", with no model at all.
 *
 * Shared by the app and the MCP server through items/store.js, and handed the
 * same sql(). It reads the person's words for named intent first, then lets an
 * item's nearest neighbours vote for their own projects, then counts the
 * evidence a person attached. Milliseconds and no tokens, which is why it runs
 * on every flag and an agent is only a hook for the unclear cases (off, owner
 * decision D6).
 *
 * The vectors are the lexical ones embeddings.js makes, computed here rather
 * than read from the embeddings table: every row has one, pads are not in that
 * table at all, and the owner's own case was answered by them (design section
 * 5.1: note 78's neighbours vote 1.07 for the app's project against 0.54).
 */

const { lexicalVector } = require("../embeddings");

const NEIGHBOURS = 8;
// The best project must beat the home by this much and hold this share of
// every vote before anything is proposed, so a near tie stays a question.
const BEAT_HOME = 1.6;
const SHARE = 0.5;
const NAMED_CONFIDENCE = 0.9;
// Projects that hold work nobody filed properly. Their rows are misfiled more
// often than anything else, so letting them vote would vote for the misfiling.
const FALLBACK_KEYS = ["claude", "general"];
const PROMPT_CHARS = 10000; // 2,500 tokens at the four characters a token the plan uses

const MOVE_WORDS = /\b(move|moved|moving|belongs?|should (?:be|live) in|refile|wrong project|misfiled|lives? in)\b/i;
const COPY_WORDS = /\b(copy|copied|duplicate|also need (?:it|this) in)\b/i;
const KEEP_WORDS = /\b(also|spans?|spanning|keep (?:it|this) in|still show|as well|both)\b/i;

const clip = (text, limit) => {
  const value = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
};
const round = (n) => Math.round(n * 100) / 100;
const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const parseJson = (text, fallback = null) => {
  if (text === null || text === undefined || text === "") return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
};

function makeEvaluator({ sql, settings = () => ({}) } = {}) {
  /** Every project, with what a person might call it. */
  function projects() {
    return sql("SELECT id, key, name, summary, status FROM projects ORDER BY id").map((p) => ({ ...p, id: Number(p.id) }));
  }

  function fallbackIds(all) {
    const ids = new Set(all.filter((p) => FALLBACK_KEYS.includes(String(p.key).toLowerCase())).map((p) => p.id));
    let s = {};
    try { s = settings() || {}; } catch {}
    if (s.scratchpadProjectId != null) ids.add(Number(s.scratchpadProjectId));
    return ids;
  }

  /** The text an item is judged by. */
  function itemText(entity, id) {
    const n = Number(id);
    if (entity === "task") {
      const t = sql("SELECT id, title, detail, project_id FROM tasks WHERE id = :p1", [n])[0];
      if (!t) return null;
      const subs = sql("SELECT title FROM tasks WHERE parent_id = :p1 ORDER BY id LIMIT 10", [n]).map((s) => s.title);
      return { title: t.title, text: `${t.title}\n${t.detail || ""}\n${subs.join("\n")}`, project_id: t.project_id };
    }
    const shapes = {
      note: "SELECT title, body AS text, project_id FROM notes WHERE id = :p1",
      scratchpad: "SELECT title, body AS text, project_id FROM scratchpads WHERE id = :p1",
      link: "SELECT label AS title, url AS text, project_id FROM links WHERE id = :p1",
      organizer: "SELECT name AS title, summary AS text, project_id FROM organizers WHERE id = :p1",
      session: "SELECT title, '' AS text, project_id FROM sessions WHERE id = :p1",
    };
    if (!shapes[entity]) return null;
    const r = sql(shapes[entity], [n])[0];
    return r ? { title: r.title, text: `${r.title}\n${r.text || ""}`, project_id: r.project_id } : null;
  }

  /** Top-level tasks, notes and pads, each with its vector. Built once per call. */
  function corpus() {
    const docs = [];
    const add = (entity, r, text) => docs.push({
      entity, id: Number(r.id), title: r.title, project_id: r.project_id == null ? null : Number(r.project_id), vec: lexicalVector(text),
    });
    for (const r of sql("SELECT id, title, detail, project_id FROM tasks WHERE parent_id IS NULL")) add("task", r, `${r.title}\n${r.detail || ""}`);
    for (const r of sql("SELECT id, title, body, project_id FROM notes")) add("note", r, `${r.title}\n${r.body || ""}`);
    for (const r of sql("SELECT id, title, body, project_id FROM scratchpads")) add("scratchpad", r, `${r.title}\n${r.body || ""}`);
    return docs;
  }

  /**
   * The neighbour vote for one vector. Each of the nearest rows votes its home
   * project with its similarity, divided by the square root of that project's
   * share of the voters, so one large project does not attract everything.
   */
  function vote(vec, docs, { skip, voters, shares }) {
    const scored = [];
    for (const d of docs) {
      if (skip(d) || !voters.has(d.project_id)) continue;
      let dot = 0;
      for (let i = 0; i < vec.length; i++) dot += vec[i] * d.vec[i];
      if (dot > 0) scored.push([d, dot]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    const near = scored.slice(0, NEIGHBOURS);
    const scores = new Map();
    for (const [d, s] of near) scores.set(d.project_id, (scores.get(d.project_id) || 0) + s / Math.sqrt(shares.get(d.project_id) || 1));
    return { near, scores };
  }

  function votingSetup(all, docs) {
    const fallback = fallbackIds(all);
    const voters = new Set(all.filter((p) => p.status !== "archived" && !fallback.has(p.id)).map((p) => p.id));
    const counts = new Map();
    let total = 0;
    for (const d of docs) if (voters.has(d.project_id)) { counts.set(d.project_id, (counts.get(d.project_id) || 0) + 1); total++; }
    const shares = new Map([...counts].map(([pid, n]) => [pid, n / (total || 1)]));
    return { fallback, voters, shares };
  }

  /**
   * Project names in a person's words. A full name or a key is a match; the
   * head of a name ("Delphi" of "Delphi: the task system") is a match only if
   * it names one project, and when it names several it is reported as
   * ambiguous rather than guessed (owner decision D1 is about exactly this).
   */
  function namedProjects(text, all) {
    const lower = String(text || "").toLowerCase();
    // Every place a phrase occurs, as [start, end], at word boundaries.
    const spans = (phrase) => {
      const out = [];
      if (!phrase || phrase.length < 3) return out;
      const re = new RegExp(`(^|[^a-z0-9])(${escape(phrase.toLowerCase())})(?=$|[^a-z0-9])`, "g");
      for (let m = re.exec(lower); m; m = re.exec(lower)) {
        const start = m.index + m[1].length;
        out.push([start, start + m[2].length]);
        re.lastIndex = start + 1;
      }
      return out;
    };
    const hits = new Map();
    const add = (p, list) => { if (list.length) hits.set(p.id, [...(hits.get(p.id) || []), ...list]); };
    for (const p of all) {
      add(p, [...spans(p.name), ...spans(p.key)]);
      const byId = new RegExp(`\\bproject\\s*#?${p.id}\\b`, "i").exec(text || "");
      if (byId) add(p, [[byId.index, byId.index + byId[0].length]]);
    }
    const heads = new Map();
    for (const p of all) {
      const head = String(p.name).split(/\s*(?::|\(| - )\s*/)[0].trim();
      if (!head || head.toLowerCase() === String(p.name).toLowerCase()) continue;
      if (!heads.has(head.toLowerCase())) heads.set(head.toLowerCase(), []);
      heads.get(head.toLowerCase()).push(p);
    }
    const ambiguous = [];
    for (const [head, list] of heads) {
      const where = spans(head);
      if (!where.length || list.some((p) => hits.has(p.id))) continue;
      if (list.length === 1) add(list[0], where);
      else ambiguous.push({ word: head, projects: list.map((p) => p.id), spans: where });
    }
    // A name inside a longer name is not a mention of its own: "IPC" in "IPC
    // there" names the second project, not both.
    const found = [...hits.entries()];
    const inside = (a, b) => b[0] <= a[0] && a[1] <= b[1] && (b[1] - b[0]) > (a[1] - a[0]);
    const named = found.filter(([pid, list]) => !list.every((span) => found.some(([other, olist]) => other !== pid && olist.some((o) => inside(span, o)))))
      .map(([pid]) => all.find((p) => p.id === pid));
    return { named, ambiguous: ambiguous.filter((a) => !a.spans.every((span) => found.some(([, olist]) => olist.some((o) => inside(span, o)))))
      .map(({ word, projects: ids }) => ({ word, projects: ids })) };
  }

  /**
   * The project a phrase names, after "in", "with", "to" and the like: one
   * project, several (ambiguous, so a person is asked), or none. A phrase is
   * the object of an instruction, so here the first word of a longer name
   * counts too ("Delphi" for "Delphi tracker"), which would be too loose
   * against a whole note.
   */
  function resolvePhrase(phrase, all) {
    const { named, ambiguous } = namedProjects(phrase, all);
    if (named.length) return { projects: named.slice(0, 1), ambiguous: [] };
    const words = String(phrase).toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) || [];
    const first = words.find((w) => w.length >= 3 && !/^(the|this|that|its|our|project|projects|here|there|both|too|also)$/.test(w));
    const byHead = first ? all.filter((p) => String(p.name).toLowerCase().split(/[^a-z0-9_-]+/)[0] === first && p.status !== "archived") : [];
    const merged = new Map([...byHead, ...ambiguous.flatMap((a) => a.projects.map((id) => all.find((p) => p.id === id)))].filter(Boolean).map((p) => [p.id, p]));
    if (merged.size === 1) return { projects: [...merged.values()], ambiguous: [] };
    if (merged.size > 1) return { projects: [], ambiguous: [{ word: first || ambiguous[0].word, projects: [...merged.keys()] }] };
    return { projects: [], ambiguous: [] };
  }

  /**
   * What the person told it to do, read before anything is counted, because
   * an instruction beats a guess. Each finding keeps the words it came from,
   * so the reasoning can quote them back. The item's own text is read for
   * keep phrases only ("it spans Offerworks" is the item saying where else it
   * belongs); where it should move is the person's to say.
   */
  function readInstructions(said, itemText, all, home) {
    const OBJ = "([^.,;:!?\\n]+)";
    const out = { move: null, copy: null, keep: [], keepHome: null, ask: [] };
    const clause = (text, re) => {
      const found = [];
      const g = new RegExp(re.source, "gi");
      for (let m = g.exec(text); m; m = g.exec(text)) {
        // The object ends where the next instruction starts: in "move it to
        // Beta and keep it in Offerworks", the move's target is Beta alone.
        const object = String(m[1] || "").split(/\s+(?:and|but|so|then|while|or|though|keep|also|plus|where|which|because|since)\b/i)[0];
        const quote = m[0].trim().slice(0, m[0].trim().length - String(m[1] || "").trim().length) + object.trim();
        found.push({ quote: quote.trim(), object });
      }
      return found;
    };
    const take = (hit, apply, kind) => {
      const r = resolvePhrase(hit.object, all);
      if (r.ambiguous.length) out.ask.push({ quote: hit.quote, kind, ...r.ambiguous[0] });
      else if (r.projects.length) apply(r.projects[0], hit.quote);
      return r;
    };
    const keepRes = [
      new RegExp(`\\bkeep(?:ing)?\\s+(?:it|this|them)?\\s*(?:visible|shown|showing|listed|around|too|as well)?\\s*(?:in|under|on)\\s+${OBJ}`),
      new RegExp(`\\b(?:also|still)\\s+(?:show|keep|list|appear|visible|be visible|be shown)\\w*\\s*(?:it|this)?\\s*(?:in|under|on)\\s+${OBJ}`),
      new RegExp(`\\b(?:visible|shown)\\s+(?:in|under|on)\\s+${OBJ}\\s+(?:too|as well)\\b`),
      new RegExp(`\\bspan(?:s|ning)?\\s+(?:to|into|across)?\\s*${OBJ}`),
    ];
    const keepPhrase = (text, fromItem) => {
      for (const re of keepRes) {
        for (const hit of clause(text, re)) {
          const r = take(hit, (p, quote) => {
            if (p.id === home) { if (!out.keepHome) out.keepHome = { quote, fromItem }; }
            else if (!fromItem && !out.keep.some((k) => k.project.id === p.id)) out.keep.push({ project: p, quote });
          }, "keep");
          if (fromItem && r.ambiguous.length) out.ask.pop();
        }
      }
    };
    keepPhrase(said, false);
    // "In both", "here too": keep, with no project named, means here.
    const bare = /\b(?:in both|both places|keep it here|here too|here as well|keep (?:it|this) (?:visible|shown) too)\b/i.exec(said);
    if (bare && !out.keepHome) out.keepHome = { quote: bare[0], fromItem: false };
    if (!out.keepHome) keepPhrase(itemText, true);
    const copyRe = new RegExp(`\\b(?:cop(?:y|ied)|duplicate|also need (?:it|this))\\b[^.,;!?\\n]*?\\b(?:in|to|into|under)\\s+${OBJ}`);
    const moveRe = new RegExp(`\\b(?:move|moved|moving|belongs?|should (?:be|live)|refile|goes|go|lives?|file it|wrong project)\\b[^.,;!?\\n]*?\\b(?:in|to|into|with|under)\\s+${OBJ}`);
    for (const hit of clause(said, copyRe)) if (!out.copy) take(hit, (p, quote) => { if (p.id !== home) out.copy = { project: p, quote }; }, "copy");
    for (const hit of clause(said, moveRe)) {
      if (out.move) break;
      take(hit, (p, quote) => { if (p.id !== home && !(out.copy && out.copy.project.id === p.id)) out.move = { project: p, quote }; }, "move");
    }
    // A target a keep phrase already named is where it is kept, not where it goes.
    out.keep = out.keep.filter((k) => !(out.move && k.project.id === out.move.project.id) && !(out.copy && k.project.id === out.copy.project.id));
    return out;
  }

  /**
   * One flag's answer: a proposal or none, the reasoning in plain sentences,
   * and the signals behind it, which are stored so a person can see why.
   */
  function evaluate(flag, { entries = [] } = {}) {
    const all = projects();
    const home = flag.project_id == null ? null : Number(flag.project_id);
    const homeName = (all.find((p) => p.id === home) || { name: "no project" }).name;
    const item = itemText(flag.entity, flag.entity_id);
    if (!item) return { proposal: null, reasoning: "The item is gone.", confidence: 0, signals: {} };
    const words = [flag.note, ...entries.filter((e) => e.kind === "say").map((e) => e.body)].filter(Boolean).join("\n");
    const name = (pid) => (all.find((p) => p.id === pid) || { name: `project ${pid}` }).name;
    const { named, ambiguous } = namedProjects(words, all);
    const targets = named.filter((p) => p.id !== home && p.status !== "archived");
    const homeNamed = named.some((p) => p.id === home);
    const wantsMove = MOVE_WORDS.test(words);
    const wantsCopy = COPY_WORDS.test(words);
    const wantsKeep = KEEP_WORDS.test(words);
    const signals = {
      named: named.map((p) => p.id), ambiguous, verbs: { move: wantsMove, copy: wantsCopy, keep: wantsKeep },
    };
    const op = (kind, to, extra = {}) => ({ op: kind, entity: flag.entity, id: Number(flag.entity_id), to, ...extra });
    const associable = ["task", "note", "scratchpad", "link"].includes(flag.entity);

    // 0. The person's own instructions, first, quoted back.
    const told = readInstructions(words, item.text, all, home);
    // A question already asked is answered by the person's replies after it:
    // a project named by name, key or id settles it, and the instruction it
    // was asked about goes ahead with that project. A question is never asked
    // twice; a reply that settles nothing is said so, as a note.
    const lastAsk = entries.map((e) => e.kind).lastIndexOf("ask");
    const answers = lastAsk >= 0 ? entries.slice(lastAsk + 1).filter((e) => e.kind === "say" && e.author_type !== "tool").map((e) => String(e.body || "")) : [];
    const answerFor = (a) => {
      for (const text of answers.slice().reverse()) {
        const byId = [...text.matchAll(/(?:#|\(|\bproject\s+)(\d+)\b/gi)].map((m) => Number(m[1])).filter((id) => all.some((p) => p.id === id));
        const byName = namedProjects(text, all).named.map((p) => p.id);
        const phrase = resolvePhrase(text, all).projects.map((p) => p.id);
        const among = [...new Set([...byId, ...byName, ...phrase])];
        const inChoices = among.filter((id) => a.projects.includes(id));
        const pick = inChoices.length === 1 ? inChoices[0] : !inChoices.length && among.length === 1 ? among[0] : null;
        if (pick != null && pick !== home) return { project: all.find((p) => p.id === pick), quote: clip(text, 80) };
      }
      return null;
    };
    const unanswered = [];
    for (const a of told.ask) {
      const settled = answerFor(a);
      if (!settled) { unanswered.push(a); continue; }
      if (a.kind === "copy" && !told.copy) told.copy = settled;
      else if (a.kind === "keep") { if (!told.keep.some((k) => k.project.id === settled.project.id)) told.keep.push(settled); }
      else if (!told.move) told.move = settled;
    }
    told.ask = unanswered;
    signals.instructions = {
      move: told.move && [told.move.project.id, told.move.quote], copy: told.copy && [told.copy.project.id, told.copy.quote],
      keep: told.keep.map((k) => [k.project.id, k.quote]), keep_home: told.keepHome && told.keepHome.quote,
    };
    const keepOps = associable ? told.keep.slice(0, 2).map((k) => op("associate", k.project.id)) : [];
    const keepWords = (keepHome) => [
      keepHome && associable ? ` ${told.keepHome.fromItem ? "The item itself says" : "You wrote"} "${clip(told.keepHome.quote, 80)}", so it stays shown in ${homeName}.` : "",
      ...told.keep.slice(0, keepOps.length).map((k) => ` You wrote "${clip(k.quote, 80)}", so it is also shown in ${k.project.name}.`),
    ].join("");
    if (told.ask.length && !told.move && !told.copy && lastAsk >= 0) {
      const a = told.ask[0];
      const choices = a.projects.map((pid) => `${name(pid)} (${pid})`).join(", ");
      return {
        proposal: null, confidence: 0, signals,
        reasoning: clip(answers.length
          ? `Your reply did not name one of ${choices}, so nothing is proposed yet. Reply with one of them by name or number.`
          : `Waiting for your answer: "${a.word}" could be ${choices}.`, 600),
      };
    }
    if (told.ask.length && !told.move && !told.copy) {
      const a = told.ask[0];
      const choices = a.projects.map((pid) => `${name(pid)} (${pid})`);
      return {
        proposal: null, confidence: 0,
        signals: { ...signals, ambiguous: [...ambiguous.filter((x) => x.word !== a.word), { word: a.word, projects: a.projects }] },
        ask: clip(`You wrote "${a.quote}", and "${a.word}" could be ${choices.slice(0, -1).join(", ")} or ${choices.slice(-1)}. Which one?`, 600),
        reasoning: clip(`"${a.word}" names more than one project, so it was not guessed.`, 600),
      };
    }
    if (told.copy && ["task", "note", "scratchpad", "link"].includes(flag.entity)) {
      return {
        proposal: { ops: [op("copy", told.copy.project.id), ...keepOps].slice(0, 3) }, confidence: NAMED_CONFIDENCE, signals,
        reasoning: clip(`You wrote "${clip(told.copy.quote, 80)}", so a copy goes to ${told.copy.project.name} and the original stays.${keepWords(false)}`, 600),
      };
    }
    if (told.move) {
      const keepHome = Boolean(told.keepHome) && associable;
      return {
        proposal: { ops: [op("move", told.move.project.id, keepHome ? { keepInSource: true } : {}), ...keepOps].slice(0, 3) },
        confidence: NAMED_CONFIDENCE, signals,
        reasoning: clip(`You wrote "${clip(told.move.quote, 80)}", so it moves to ${told.move.project.name}.${keepWords(keepHome)}`, 600),
      };
    }
    if (keepOps.length && !told.keepHome && !wantsMove) {
      return {
        proposal: { ops: keepOps }, confidence: NAMED_CONFIDENCE, signals,
        reasoning: clip(keepWords(false).trim(), 600),
      };
    }

    // 1. Named intent: one target and one verb is a clear instruction.
    if (targets.length === 1 && (wantsMove || wantsCopy || wantsKeep)) {
      const t = targets[0];
      let chosen;
      if (wantsCopy && !wantsMove && ["task", "note", "scratchpad", "link"].includes(flag.entity)) chosen = op("copy", t.id);
      else if (wantsMove || !associable) chosen = op("move", t.id, wantsKeep && homeNamed && associable ? { keepInSource: true } : {});
      else chosen = op("associate", t.id);
      const said = chosen.op === "copy" ? `a copy in ${t.name}` : chosen.op === "associate" ? `it shown in ${t.name} as well` : `it in ${t.name}${chosen.keepInSource ? `, still shown in ${homeName}` : ""}`;
      return {
        proposal: { ops: [chosen] }, confidence: NAMED_CONFIDENCE, signals,
        reasoning: clip(`The flag asks for ${said}, naming ${t.name} and no other project.`, 600),
      };
    }

    // 2 and 3. The neighbour vote, with the evidence a person attached.
    const docs = corpus();
    const setup = votingSetup(all, docs);
    const vec = lexicalVector(item.text);
    const { near, scores } = vote(vec, docs, {
      ...setup, skip: (d) => d.entity === flag.entity && d.id === Number(flag.entity_id),
    });
    const evidence = parseJson(flag.evidence, []) || [];
    const evidenceProjects = [];
    for (const chip of evidence) {
      let pid = null;
      if (chip.type === "project") pid = Number(chip.id);
      else if (chip.type === "task" || chip.type === "note" || chip.type === "pad") {
        const table = chip.type === "pad" ? "scratchpads" : `${chip.type}s`;
        const r = sql(`SELECT project_id FROM ${table} WHERE id = :p1`, [Number(chip.id)])[0];
        pid = r && r.project_id != null ? Number(r.project_id) : null;
      }
      if (pid != null) { scores.set(pid, (scores.get(pid) || 0) + 1); evidenceProjects.push(pid); }
    }
    // A target the person named but gave no verb for counts as one vote too.
    for (const t of targets) scores.set(t.id, (scores.get(t.id) || 0) + 1);
    const ranked = [...scores].filter(([pid]) => all.some((p) => p.id === pid && p.status !== "archived")).sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((s, [, v]) => s + v, 0);
    signals.knn = ranked.slice(0, 5).map(([pid, v]) => [pid, round(v)]);
    signals.neighbours = near.slice(0, 5).map(([d, s]) => [d.entity, d.id, d.title, d.project_id, round(s)]);
    signals.evidence_projects = evidenceProjects;
    const homeScore = scores.get(home) || 0;
    const [best, bestScore] = ranked[0] || [null, 0];
    const lead = near.slice(0, 2).map(([d, s]) => `${d.entity} ${d.id} "${clip(d.title, 60)}" in ${name(d.project_id)} (${round(s)})`).join(" and ");
    const ambiguity = ambiguous.length ? ` "${ambiguous.map((a) => a.word).join("\", \"")}" names more than one project, so it was not taken as a target.` : "";
    if (best == null || best === home || bestScore < BEAT_HOME * homeScore || bestScore < SHARE * total) {
      return {
        proposal: null, confidence: total ? round(bestScore / total) : 0, signals,
        reasoning: clip(best == null
          ? `Nothing similar enough was found to say where it belongs.${ambiguity}`
          : `No clear home: ${name(best)} scores ${round(bestScore)} against ${round(homeScore)} for ${homeName}${lead ? `; its nearest are ${lead}` : ""}.${ambiguity}`, 600),
      };
    }
    // Keeping it where it is comes from the person's words (or the item's
    // own), quoted, never from the vote.
    const keep = associable && (Boolean(told.keepHome) || (wantsKeep && homeNamed));
    const confidence = Math.min(0.95, round(bestScore / (total || 1)));
    const quoted = told.keepHome ? keepWords(true) : keep ? ` The flag says it spans ${homeName}, so it stays shown there.` : "";
    return {
      proposal: { ops: [op("move", best, keep ? { keepInSource: true } : {}), ...keepOps.filter((o) => o.to !== best)].slice(0, 3) }, confidence, signals,
      reasoning: clip(`${quoted.trim() ? `${quoted.trim()} ` : ""}Its nearest are ${lead}. ${name(best)} scores ${round(bestScore)} against ${round(homeScore)} for ${homeName}.` + ambiguity, 600),
    };
  }

  /** Every top-level task, note and pad that looks filed in the wrong place, surest first. */
  function sweep({ projectId = null } = {}) {
    const all = projects();
    const docs = corpus();
    const setup = votingSetup(all, docs);
    const name = (pid) => (all.find((p) => p.id === pid) || { name: `project ${pid}` }).name;
    const out = [];
    for (const d of docs) {
      if (projectId != null && d.project_id !== Number(projectId)) continue;
      const home = all.find((p) => p.id === d.project_id);
      if (!home || home.status === "archived") continue;
      const { near, scores } = vote(d.vec, docs, { ...setup, skip: (x) => x === d });
      const ranked = [...scores].sort((a, b) => b[1] - a[1]);
      const total = ranked.reduce((s, [, v]) => s + v, 0);
      const [best, bestScore] = ranked[0] || [null, 0];
      const homeScore = scores.get(d.project_id) || 0;
      if (best == null || best === d.project_id || bestScore < BEAT_HOME * homeScore || bestScore < SHARE * total) continue;
      const lead = near.slice(0, 2).map(([x, s]) => `${x.entity} ${x.id} "${clip(x.title, 50)}" in ${name(x.project_id)} (${round(s)})`).join(" and ");
      out.push({
        entity: d.entity, id: d.id, from: d.project_id, to: best, confidence: Math.min(0.95, round(bestScore / (total || 1))),
        reasoning: clip(`Its nearest are ${lead}. ${name(best)} scores ${round(bestScore)} against ${round(homeScore)} for ${name(d.project_id)}.`, 600),
        signals: { knn: ranked.slice(0, 5).map(([pid, v]) => [pid, round(v)]), neighbours: near.slice(0, 5).map(([x, s]) => [x.entity, x.id, x.title, x.project_id, round(s)]) },
      });
    }
    return out.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * What an agent evaluator would be given, packed to 2,500 tokens. The hook
   * is off (D6); this is here so turning it on is a dispatcher change, not a
   * design one, and so the budget is tested now.
   */
  function prompt(flag) {
    const all = projects().filter((p) => p.status !== "archived");
    const item = itemText(flag.entity, flag.entity_id) || { title: flag.label || "", text: "" };
    const evidence = (parseJson(flag.evidence, []) || []).map((c) => (c.type === "text" || c.type === "url" ? `${c.type}: ${clip(c.value, 300)}` : `${c.type} ${c.id}`));
    const head = [
      "Decide which Delphi project this item belongs in. Answer with JSON only:",
      '{"ops":[{"op":"move|copy|associate","entity":"<entity>","id":<id>,"to":<project id>,"keepInSource":true|false}],"reasoning":"<plain sentences, 600 characters at most>","confidence":0.0}',
      'or {"ask":"<one question for the person>"} when you cannot tell. Never more than 3 ops.',
    ].join("\n");
    const itemPart = clip(`Item: ${flag.entity} ${flag.entity_id}, "${item.title}", home ${flag.project_id ?? "none"}.\n${item.text}`, 1500);
    const askPart = clip(`The person said: ${flag.note || "(nothing)"}${evidence.length ? `\nEvidence: ${evidence.join("; ")}` : ""}`, 2000);
    let used = head.length + itemPart.length + askPart.length + 200;
    const rows = [];
    for (const p of all) {
      const line = clip(`${p.id} ${p.key}: ${p.name}${p.summary ? `, ${p.summary}` : ""}`, 120);
      if (used + line.length + 1 > PROMPT_CHARS - 1200) break;
      rows.push(line);
      used += line.length + 1;
    }
    const text = [head, itemPart, askPart, `Projects:\n${rows.join("\n")}`].join("\n\n");
    return text.length > PROMPT_CHARS ? text.slice(0, PROMPT_CHARS) : text;
  }

  return { evaluate, sweep, prompt, namedProjects, readInstructions, resolvePhrase };
}

module.exports = { makeEvaluator, FALLBACK_KEYS, BEAT_HOME, SHARE };
