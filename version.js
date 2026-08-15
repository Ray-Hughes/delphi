// Comparing two version strings.
//
// Its own file because it is pure, and because a version comparison that is
// subtly wrong fails in the direction nobody notices: it says you are up to date
// when you are not. Worth being able to test without booting an app.

/**
 * True when `a` is a later version than `b`.
 *
 * Compared part by part as numbers, so 1.10.0 beats 1.9.0, which string
 * comparison gets backwards. A leading v is ignored, since git tags carry one
 * and package.json does not. Anything unparseable counts as zero rather than
 * throwing: a malformed tag should not stop an app from starting.
 */
function isNewer(a, b) {
  const parse = (v) => String(v).replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

module.exports = { isNewer };
