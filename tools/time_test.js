#!/usr/bin/env node
// timefmt.js: stored stamps are UTC, due dates are local days.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/time_test.js
//
// The bugs this guards were invisible in UTC and four hours wide in New York,
// so the checks run under zones either side of Greenwich rather than whatever
// the machine happens to be set to. Node rereads TZ when it is assigned, which
// is what lets one process stand in two places.

const path = require("path");
const T = require(path.join(__dirname, "..", "timefmt.js"));

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks += 1;
  if (got === want) { console.log(`ok   ${what}`); return; }
  failures += 1;
  console.log(`FAIL ${what}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
}

function inZone(tz, fn) {
  const was = process.env.TZ;
  process.env.TZ = tz;
  try { fn(); } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
}

inZone("America/New_York", () => {
  // 2026-10-03 is daylight time there, UTC minus four.
  check("the zone took", new Date(Date.UTC(2026, 9, 3, 12)).getHours(), 8);

  const now = Date.UTC(2026, 9, 3, 21, 0, 0); // 17:00 in New York
  check("a stamp from 6 minutes ago is 6m, not just now", T.ago("2026-10-03 20:54:00", now), "6m ago");
  check("a stamp from 3 hours ago is 3h", T.ago("2026-10-03 18:00:00", now), "3h ago");
  check("a stamp with a Z is taken at its word", T.ago("2026-10-03T20:30:00Z", now), "30m ago");
  check("a stamp with an offset is taken at its word", T.ago("2026-10-03T16:50:00-04:00", now), "10m ago");
  check("a stamp with fractional seconds parses", T.ago("2026-10-03 20:50:00.123", now), "10m ago");
  check("nothing is nothing", T.ago(null, now), "");
  check("garbage is nothing", T.ago("not a time", now), "");
  check("a stamp past 30 days shows its local day",
    T.ago("2026-08-01 02:00:00", now), "2026-07-31");

  check("parseStamp reads SQLite as UTC",
    T.parseStamp("2026-10-03 20:54:00").toISOString(), "2026-10-03T20:54:00.000Z");
  check("toStamp writes what SQLite writes",
    T.toStamp(new Date(Date.UTC(2026, 9, 3, 20, 54, 7))), "2026-10-03 20:54:07");
  check("a day parses as local midnight", T.parseStamp("2026-10-03").getHours(), 0);

  // 21:30 on the 3rd in New York is 01:30 on the 4th in UTC. The old today()
  // said the 4th from eight in the evening on.
  const lateEvening = new Date(Date.UTC(2026, 9, 4, 1, 30));
  check("today is the local day late in the evening", T.localDay(lateEvening), "2026-10-03");
  check("due today is today, not overdue, at 21:30", T.dueState("2026-10-03", lateEvening), "today");
  check("due tomorrow is upcoming at 21:30", T.dueState("2026-10-04", lateEvening), "upcoming");
  check("due yesterday is overdue", T.dueState("2026-10-02", lateEvening), "overdue");
  check("no due date has no state", T.dueState(null, lateEvening), null);

  const justBeforeMidnight = new Date(2026, 9, 3, 23, 59, 59);
  const justAfterMidnight = new Date(2026, 9, 4, 0, 0, 1);
  check("23:59 local: due today is still today", T.dueState("2026-10-03", justBeforeMidnight), "today");
  check("00:00 local: yesterday's due is now overdue", T.dueState("2026-10-03", justAfterMidnight), "overdue");
  check("00:00 local: today's due is today", T.dueState("2026-10-04", justAfterMidnight), "today");

  // A write at 23:00 local is stored as the next UTC day.
  check("a late write groups under its local day",
    T.dayLabel("2026-10-04 03:00:00", lateEvening), "Today");
  check("the evening before groups as Yesterday",
    T.dayLabel("2026-10-03 01:00:00", lateEvening), "Yesterday");
  check("older days show the local date",
    T.dayLabel("2026-10-01 02:00:00", lateEvening), "2026-09-30");
  check("dayOf leaves a due date alone", T.dayOf("2026-10-03"), "2026-10-03");

  // Date rolls an impossible day into the next month. A stored typo has to read
  // as nothing, not as a different deadline.
  check("31 February is not a day", T.parseStamp("2026-02-31"), null);
  check("30 February is not a stamp either", T.parseStamp("2026-02-30 10:00:00"), null);
  check("31 April with a zone is not a stamp", T.parseStamp("2026-04-31T09:00:00Z"), null);
  check("month 13 is not a day", T.parseStamp("2026-13-01"), null);
  check("day 00 is not a day", T.parseStamp("2026-10-00"), null);
  check("29 February in a common year is not a day", T.dayOf("2026-02-29"), null);
  check("29 February in a leap year is", T.dayOf("2028-02-29"), "2028-02-29");
  check("dayOf refuses an impossible due date", T.dayOf("2026-02-31"), null);
  check("an impossible due date has no due state", T.dueState("2026-02-31", lateEvening), null);
  check("an impossible stamp reads as nothing", T.ago("2026-02-31 10:00:00", now), "");
  check("a real day round-trips", T.localDay(T.parseStamp("2026-12-31")), "2026-12-31");

  check("secondsSince reads UTC", T.secondsSince("2026-10-03 20:59:30", now), 30);
  check("secondsSince never goes negative", T.secondsSince("2026-10-03 21:05:00", now), 0);
  check("secondsSince of garbage is NaN", Number.isNaN(T.secondsSince("nope", now)), true);

  // The clocks go back on 1 November 2026 there: a 25 hour day.
  check("shiftDay crosses a clock change", T.shiftDay("2026-11-01", 1), "2026-11-02");
  check("shiftDay crosses a month", T.shiftDay("2026-03-01", -1), "2026-02-28");
  check("shiftDay crosses a year", T.shiftDay("2026-12-31", 1), "2027-01-01");
});

inZone("Pacific/Auckland", () => {
  // Ahead of UTC, where the old code got the morning wrong instead of the evening.
  const morning = new Date(Date.UTC(2026, 9, 3, 20, 0)); // 09:00 on the 4th there
  check("Auckland: the zone took", morning.getHours(), 9);
  check("Auckland: today is the local day in the morning", T.localDay(morning), "2026-10-04");
  check("Auckland: due on the 3rd is overdue in the morning of the 4th", T.dueState("2026-10-03", morning), "overdue");
  check("Auckland: a stamp 5 minutes old is 5m", T.ago("2026-10-03 19:55:00", morning.getTime()), "5m ago");
});

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
