// Local embeddings for the Oracle.
//
// Two providers, chosen at run time. Ollama gives real neural embeddings and is
// preferred when it is running. When it is not, a lexical vector is used instead
// so retrieval degrades rather than disappears: a tool that stops working
// because a background service is down is worse than one that answers slightly
// less well.
//
// Everything stays on this machine either way. Nothing is sent anywhere.

const crypto = require("crypto");
const http = require("http");

const OLLAMA = process.env.DELPHI_OLLAMA || "http://127.0.0.1:11434";
const MODEL = process.env.DELPHI_EMBED_MODEL || "nomic-embed-text";
const LEXICAL_DIMS = 384;

// --- provider detection -----------------------------------------------------

let providerCache = null;
let providerCheckedAt = 0;

function post(url, body, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Which provider to use.
 *
 * Cached briefly rather than per call, so a batch of a hundred rows does not
 * make a hundred probe requests, but a model that starts up mid-session is still
 * picked up without a restart.
 */
async function provider() {
  if (providerCache && Date.now() - providerCheckedAt < 30000) return providerCache;
  try {
    const r = await post(`${OLLAMA}/api/embeddings`, { model: MODEL, prompt: "probe" }, 4000);
    if (Array.isArray(r.embedding) && r.embedding.length) {
      providerCache = { name: `ollama:${MODEL}`, dims: r.embedding.length, neural: true };
      providerCheckedAt = Date.now();
      return providerCache;
    }
  } catch {
    // Not running, or the model is not pulled. Fall through to lexical.
  }
  providerCache = { name: "lexical", dims: LEXICAL_DIMS, neural: false };
  providerCheckedAt = Date.now();
  return providerCache;
}

// --- lexical fallback -------------------------------------------------------

const STOP = new Set(("the a an and or but if then than that this these those is are was were be been being to of in on at " +
  "for with from by as it its into over under so we our you your they their he she them not no yes can will would should " +
  "could may might do does did done have has had").split(" "));

function tokenise(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/**
 * A hashed bag-of-words vector.
 *
 * Not a semantic embedding: it matches words, not meaning. It exists so search
 * keeps working with no model installed, and because at this corpus size, word
 * overlap plus the graph answers most of what is asked. Sub-tokens of dotted and
 * hyphenated names are included so "instantclient" finds
 * "instantclient_23_6".
 */
function lexicalVector(text) {
  const v = new Float32Array(LEXICAL_DIMS);
  const tokens = tokenise(text);
  for (const token of tokens) {
    const pieces = [token, ...token.split(/[._-]/).filter((p) => p.length > 2)];
    for (const piece of pieces) {
      const h = crypto.createHash("md5").update(piece).digest();
      const index = h.readUInt32BE(0) % LEXICAL_DIMS;
      // Sign from a second byte so unrelated words cancel rather than accumulate.
      v[index] += h[4] & 1 ? 1 : -1;
    }
  }
  return normalise(v);
}

function normalise(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const mag = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= mag;
  return v;
}

// --- embedding --------------------------------------------------------------

async function embed(text) {
  const p = await provider();
  if (p.neural) {
    const r = await post(`${OLLAMA}/api/embeddings`, { model: MODEL, prompt: String(text).slice(0, 8000) });
    return { vector: normalise(Float32Array.from(r.embedding)), model: p.name, dims: r.embedding.length };
  }
  return { vector: lexicalVector(text), model: p.name, dims: LEXICAL_DIMS };
}

const toBlob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

// Both vectors are normalised, so the dot product is the cosine.
function similarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

const hash = (text) => crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 32);

// --- index ------------------------------------------------------------------

/** What gets embedded for each kind of row. */
function textFor(kind, row) {
  if (kind === "note") return `${row.title}\n${row.body || ""}`;
  if (kind === "task") return `${row.title}\n${row.detail || ""}`;
  return `${row.name} ${row.summary || ""}`;
}

/**
 * Brings the index up to date.
 *
 * Rows whose content hash is unchanged are skipped, so this is cheap to call on
 * every edit. A model change re-embeds everything, because vectors from
 * different models are not comparable and mixing them silently returns nonsense.
 */
async function reindex(db, { force = false } = {}) {
  const p = await provider();
  const sources = [
    ["note", db.prepare("SELECT id, title, body FROM notes").all()],
    ["task", db.prepare("SELECT id, title, detail FROM tasks").all()],
    ["entity", db.prepare("SELECT id, name, summary FROM entities").all()],
  ];

  let embedded = 0;
  let skipped = 0;

  for (const [kind, rows] of sources) {
    for (const row of rows) {
      const text = textFor(kind, row);
      const h = hash(text);
      const existing = db
        .prepare("SELECT content_hash, model FROM embeddings WHERE source_type = :k AND source_id = :id")
        .get({ k: kind, id: row.id });

      if (!force && existing && existing.content_hash === h && existing.model === p.name) {
        skipped++;
        continue;
      }

      const { vector, model, dims } = await embed(text);
      db.prepare(
        `INSERT INTO embeddings (source_type, source_id, model, dims, vector, content_hash)
         VALUES (:k, :id, :model, :dims, :vector, :hash)
         ON CONFLICT(source_type, source_id, model) DO UPDATE SET
           vector = excluded.vector, dims = excluded.dims,
           content_hash = excluded.content_hash, created_at = datetime('now')`
      ).run({ k: kind, id: row.id, model, dims, vector: toBlob(vector), hash: h });
      embedded++;
    }
  }

  // Rows deleted from the app leave their vectors behind otherwise.
  const pruned = db.prepare(`
    DELETE FROM embeddings WHERE
      (source_type = 'note'   AND source_id NOT IN (SELECT id FROM notes)) OR
      (source_type = 'task'   AND source_id NOT IN (SELECT id FROM tasks)) OR
      (source_type = 'entity' AND source_id NOT IN (SELECT id FROM entities))
  `).run();

  return { provider: p.name, neural: p.neural, embedded, skipped, pruned: pruned.changes };
}

/**
 * Nearest rows to a query.
 *
 * A linear scan. At a few hundred vectors that is well under a millisecond, and
 * an approximate index would add a dependency and a failure mode to save time
 * nobody would notice.
 */
async function nearest(db, query, { limit = 10, kinds = ["note", "task", "entity"] } = {}) {
  const p = await provider();
  const { vector } = await embed(query);

  const placeholders = kinds.map((_, i) => `:k${i}`).join(", ");
  const params = Object.fromEntries(kinds.map((k, i) => [`k${i}`, k]));
  const rows = db
    .prepare(`SELECT * FROM embeddings WHERE model = :model AND source_type IN (${placeholders})`)
    .all({ model: p.name, ...params });

  const scored = rows
    .map((r) => ({ ...r, score: similarity(vector, fromBlob(r.vector)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((r) => {
    if (r.source_type === "note") {
      const n = db.prepare(`SELECT n.id, n.title, n.kind, n.body, p.name AS project
                            FROM notes n LEFT JOIN projects p ON p.id = n.project_id WHERE n.id = :id`)
        .get({ id: r.source_id });
      return { type: "note", score: r.score, ...n };
    }
    if (r.source_type === "task") {
      const t = db.prepare(`SELECT t.id, t.title, t.status, t.ref, p.name AS project
                            FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = :id`)
        .get({ id: r.source_id });
      return { type: "task", score: r.score, ...t };
    }
    const e = db.prepare("SELECT id, kind, name, mentions FROM entities WHERE id = :id").get({ id: r.source_id });
    return { type: "entity", score: r.score, ...e };
  });
}

function status(db) {
  const rows = db.prepare("SELECT model, COUNT(*) AS n, MAX(created_at) AS last FROM embeddings GROUP BY model").all();
  return { models: rows, total: rows.reduce((n, r) => n + r.n, 0) };
}

module.exports = { embed, reindex, nearest, similarity, provider, status, fromBlob };
