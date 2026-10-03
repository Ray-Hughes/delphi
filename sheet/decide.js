/**
 * Who answers a question asked on a Sheet.
 *
 * For now a person does, which is the manual provider. The interface is here
 * anyway because the spec has an automated decider coming, and a provider that
 * has to fit a shape that already has callers is easier to get right than one
 * that gets to invent the shape. Pure apart from the store it is handed.
 *
 *   provider = {
 *     name,
 *     propose(context, question, options) -> { question, options },
 *     resolve(askId, choice, by, { store, why }) -> Entry,
 *   }
 */

const manual = {
  name: "manual",
  // A person writes their own question; nothing to improve on.
  propose(_context, question, options) {
    return { question, options };
  },
  resolve(askId, choice, by, { store, why = null } = {}) {
    if (!store || typeof store.decide !== "function") throw new Error("The manual provider needs a sheet store to write the decision to.");
    return store.decide(askId, choice, why, by ? { author: by } : {});
  },
};

const PROVIDERS = { manual };

function getProvider(name = "manual") {
  const provider = PROVIDERS[String(name || "manual")];
  if (!provider) throw new Error("Only the manual provider exists yet");
  return provider;
}

function bodyLines(entry) {
  return String((entry && entry.body) || "").split("\n");
}

function optionsOf(entry) {
  const meta = entry && entry.meta;
  const options = meta && typeof meta === "object" ? meta.options : null;
  return Array.isArray(options) ? options : [];
}

/**
 * The note a decision becomes when it is filed.
 *
 * Written out in full rather than as "a", because a project note is read long
 * after the Sheet it came from, by someone who never saw the question. The
 * options that were turned down are part of the decision, so they are kept.
 */
function decisionNoteBody(askEntry, decideEntry) {
  const question = bodyLines(askEntry)[0] || "(question not recorded)";
  const options = optionsOf(askEntry);
  const decided = bodyLines(decideEntry);
  const meta = (decideEntry && decideEntry.meta && typeof decideEntry.meta === "object") ? decideEntry.meta : {};
  const key = String(meta.choice || decided[0] || "").trim().toLowerCase();
  const chosen = options.find((o) => String(o.key).toLowerCase() === key);
  const label = chosen ? chosen.label : (meta.label || "");
  const why = decided.slice(1).join("\n").trim();

  const lines = [question, ""];
  for (const option of options) lines.push(`[${option.key}] ${option.label}`);
  if (options.length) lines.push("");
  lines.push(`Chosen: [${key}]${label ? ` ${label}` : ""}`);
  if (why) lines.push("", why);
  return lines.join("\n");
}

module.exports = { manual, getProvider, decisionNoteBody };
