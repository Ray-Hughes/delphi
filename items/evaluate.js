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
    const keep = associable && wantsKeep && homeNamed;
    const confidence = Math.min(0.95, round(bestScore / (total || 1)));
    return {
      proposal: { ops: [op("move", best, keep ? { keepInSource: true } : {})] }, confidence, signals,
      reasoning: clip(`Its nearest are ${lead}. ${name(best)} scores ${round(bestScore)} against ${round(homeScore)} for ${homeName}.` +
        (keep ? ` The flag says it spans ${homeName}, so it stays shown there.` : "") + ambiguity, 600),
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

  return { evaluate, sweep, prompt, namedProjects };
}

module.exports = { makeEvaluator, FALLBACK_KEYS, BEAT_HOME, SHARE };
