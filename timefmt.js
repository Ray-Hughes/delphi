/*
 * Reading and writing the times the store holds.
 *
 * Two kinds of value live in the database and they mean different things:
 *
 * - A stamp, from SQLite's datetime('now'): "2026-10-03 21:14:09". It is UTC
 *   with no marker saying so, and Date reads a bare "YYYY-MM-DDTHH:MM:SS" as
 *   local time. Left alone, everything written in the last four hours reads
 *   "just now" in New York and the rest is four hours too young.
 * - A day, such as a due date: "2026-10-03". It is a calendar date on the wall
 *   where the person is, not an instant. Date reads a bare date as UTC
 *   midnight, which in New York is the evening before.
 *
 * So there are two helpers and nothing else should parse either kind:
 * parseStamp for stamps and localDay for "what day is it here". Every
 * comparison of a due date is a string comparison between two days, never an
 * instant against an instant, so it cannot drift across midnight.
 *
 * Pure, with no requires, because it is loaded twice: by index.html as a plain
 * script (there is no bundler) and by tools/time_test.js under Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.delphiTime = api;
})(typeof self !== "undefined" ? self : this, function () {
  const pad2 = (n) => String(n).padStart(2, "0");
  const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  const HAS_ZONE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

  /**
   * A stored stamp as a Date, or null when there is nothing usable.
   *
   * A stamp with no zone is UTC, because that is what SQLite wrote. One that
   * already carries a zone (an ISO string from toISOString, or a value an agent
   * wrote with an offset) is taken at its word. A bare day is local midnight,
   * since a day is a place on the calendar, not a moment in Greenwich.
   */
  function parseStamp(value) {
    if (value == null || value === "") return null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
    if (typeof value === "number") return Number.isFinite(value) ? new Date(value) : null;
    const text = String(value).trim();
    let at;
    if (DAY_ONLY.test(text)) {
      at = new Date(+text.slice(0, 4), +text.slice(5, 7) - 1, +text.slice(8, 10));
    } else {
      const iso = text.replace(" ", "T");
      at = new Date(HAS_ZONE.test(iso) ? iso : `${iso}Z`);
    }
    return Number.isFinite(at.getTime()) ? at : null;
  }

  /** A Date as SQLite writes one: UTC, to the second, no marker. */
  const toStamp = (date) => date.toISOString().slice(0, 19).replace("T", " ");

  /** The calendar day a moment falls on where this person is. */
  const localDay = (date = new Date()) =>
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

  /**
   * The local day a stored value belongs to. A due date is already a day and is
   * returned as it is, rather than round-tripped through an instant.
   */
  function dayOf(value) {
    if (value == null || value === "") return null;
    const text = String(value).trim();
    if (DAY_ONLY.test(text)) return text;
    const at = parseStamp(value);
    return at ? localDay(at) : null;
  }

  /**
   * A day n days from another. Done on the calendar with Date.UTC rather than by
   * adding 86400000 to a local time, because a day with a clock change in it is
   * 23 or 25 hours long and the sum would land on the wrong date.
   */
  function shiftDay(day, n) {
    const at = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + n));
    return at.toISOString().slice(0, 10);
  }

  /**
   * Where a due date stands against today: "overdue", "today", "upcoming", or
   * null with no date. Done work is never overdue; the caller decides that,
   * because it knows the status and this does not.
   */
  function dueState(due, now = new Date()) {
    const day = dayOf(due);
    if (!day) return null;
    const here = localDay(now instanceof Date ? now : new Date(now));
    return day < here ? "overdue" : day === here ? "today" : "upcoming";
  }

  /** "3d ago" reads faster than a timestamp when scanning activity. */
  function ago(value, now = Date.now()) {
    const then = parseStamp(value);
    if (!then) return "";
    const mins = Math.round((now - then.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return days < 30 ? `${days}d ago` : localDay(then);
  }

  /** Whole seconds since a stored value, never negative, NaN when unreadable. */
  function secondsSince(value, now = Date.now()) {
    const then = parseStamp(value);
    return then ? Math.max(0, Math.round((now - then.getTime()) / 1000)) : NaN;
  }

  /** Today and Yesterday read faster than a date when grouping recent activity. */
  function dayLabel(value, now = new Date()) {
    const day = dayOf(value);
    if (!day) return "Earlier";
    const here = localDay(now instanceof Date ? now : new Date(now));
    if (day === here) return "Today";
    if (day === shiftDay(here, -1)) return "Yesterday";
    return day;
  }

  return { parseStamp, toStamp, localDay, dayOf, shiftDay, dueState, ago, secondsSince, dayLabel };
});
