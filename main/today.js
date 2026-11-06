// Today, the window's half: when you were last here, and the IPC that hands the
// page its stuck tasks and the brief.
//
// The rules and the SQL are today/brief.js, which the MCP server shares, so an
// agent's daily_brief and the window's brief are the same rows. This file only
// knows what an agent cannot: when a person was looking.
//
// "Away" is the plan's definition (slice 7a): since the last time the window
// was focused for more than a minute, or since yesterday's first launch when
// there is no such time yet. A glance under a minute does not count as having
// read anything. While focused past that minute the moment is written every
// minute, so a crash loses at most one minute of it.
//
// The brief the page shows keeps its own start (shownSince) and moves it only
// when you come back after being away for a while (AWAY_MS) or press "Mark as
// seen". Otherwise switching to another app for ten seconds and back would
// empty the brief you were halfway through reading.
//
// Kept in DATA_DIR/today.json, not the database: it is about this machine's
// window, and a write to the database every minute would look to every other
// connection like somebody changing something.
//
// Required by main.js, and by tools/today_test.js under a plain Node, so it
// takes everything it touches as arguments.

const fs = require("fs");
const path = require("path");
const brief = require("../today/brief");

const LOOKED_MS = 60 * 1000;
const AWAY_MS = 15 * 60 * 1000;
const DAY_MS = 86400000;

/** The local calendar day of a moment, for "yesterday's first launch". */
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * @param sql      db.sqlP, or any sql(query, params) in the :p1 style
 * @param dataDir  where today.json lives
 * @param clock    () => ms, so a test can move time
 */
function createToday({ sql, dataDir, clock = () => Date.now() }) {
  const file = path.join(dataDir, "today.json");
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { saved = {}; }
  if (!saved.launches || typeof saved.launches !== "object") saved.launches = {};

  const write = () => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(saved, null, 2));
      fs.renameSync(tmp, file);
    } catch (error) { console.error("today.json", error); }
  };

  // This launch, and the first launch of each of the last few days.
  const started = clock();
  const day = localDay(started);
  if (!saved.launches[day]) saved.launches[day] = brief.stamp(started);
  for (const k of Object.keys(saved.launches).sort().slice(0, -7)) delete saved.launches[k];
  write();

  // Never looked yet: yesterday's first launch, else a day back, so a first
  // morning still has something to say.
  function fallbackSince(now) {
    return saved.launches[localDay(now - DAY_MS)] || brief.stamp(now - DAY_MS);
  }
  let shownSince = saved.lastSeen || fallbackSince(started);

  let focusedAt = null;
  let blurredAt = null;
  let ticker = null;
  const looked = () => {
    const now = clock();
    if (focusedAt != null && now - focusedAt >= LOOKED_MS) { saved.lastSeen = brief.stamp(now); write(); }
  };

  function focused() {
    const now = clock();
    if (blurredAt != null && now - blurredAt >= AWAY_MS) shownSince = saved.lastSeen || fallbackSince(now);
    focusedAt = now;
    blurredAt = null;
    clearInterval(ticker);
    ticker = setInterval(looked, LOOKED_MS);
    if (ticker.unref) ticker.unref();
  }
  function blurred() {
    looked();
    clearInterval(ticker);
    ticker = null;
    focusedAt = null;
    blurredAt = clock();
  }

  /** Everything Today draws that needs SQL, in one round trip. */
  function view({ projectId = null } = {}) {
    const now = clock();
    const stuck = brief.stuck(sql, { now, projectId });
    return {
      since: shownSince,
      lastSeen: saved.lastSeen || null,
      firstRun: !saved.lastSeen,
      stuck,
      review: brief.inReview(sql, { now, projectId }),
      banner: brief.bannerOf(stuck),
      brief: brief.brief(sql, { since: shownSince, now, projectId, stuckRows: stuck }),
    };
  }

  /**
   * "Mark as seen": the brief starts again from the newest thing the window
   * showed (brief.seenUpTo), never from the click, so what arrived after the
   * last repaint is not lost. Clamped to now, and never moved backwards.
   */
  function seen(upTo = null) {
    const now = brief.stamp(clock());
    // No time given is "now" (nothing was on screen yet). A time that does not
    // parse moves nothing: falling back to now would lose what it was hiding.
    let at = upTo == null ? now : brief.stamp(upTo);
    if (!at) return view();
    if (at > now) at = now;
    if (at < shownSince) at = shownSince;
    shownSince = at;
    saved.lastSeen = shownSince;
    write();
    return view();
  }

  /** Window focus and blur, from Electron's app events. */
  function watch(app) {
    if (!app || typeof app.on !== "function") return;
    app.on("browser-window-focus", () => focused());
    app.on("browser-window-blur", () => blurred());
  }

  return { view, seen, watch, focused, blurred, since: () => shownSince };
}

function register(handle, { today }) {
  handle("today:view", (opts) => today.view(opts || {}));
  handle("today:seen", (upTo) => today.seen(upTo || null));
}

module.exports = { createToday, register, LOOKED_MS, AWAY_MS };
