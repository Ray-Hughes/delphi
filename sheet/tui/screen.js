/**
 * Drawing the Sheet in a terminal: the alternate screen, colour, and getting
 * the terminal back exactly as it was found.
 *
 * The last part matters more than the rest. A program that leaves raw mode on
 * or the alternate screen up has broken the person's shell, and they will not
 * know why. So the restore is one idempotent function, written with a
 * synchronous write so it works from inside an 'exit' handler, and it runs on
 * every way out: a normal leave, process exit, SIGINT, SIGTERM, SIGHUP, an
 * uncaught exception and an unhandled rejection.
 *
 * Width is display width, not string length. A CJK character or an emoji takes
 * two cells and a combining accent none, and getting that wrong is what makes a
 * right aligned column wander off the edge on one line in ten.
 */

const fs = require("fs");

// Copied from the tokens in index.html, light from :root and dark from the
// dark blocks, so a Sheet in the terminal reads as the same Sheet as the rail.
// say is --ink-dim, agent --tc-purple, run --tc-teal, ask --tc-amber, decide
// --tc-green, note and ledger --accent, ok --good, fail --crit, running --warn,
// dim --ink-faint. If those tokens move, move these.
const PALETTE = {
  light: {
    say: "#5f6156", agent: "#7b4bd1", run: "#0f7a80", ask: "#8a6a00", decide: "#2f8757",
    note: "#c2410c", ledger: "#c2410c", ok: "#1a7a48", fail: "#b4283f", running: "#a8700f",
    dim: "#8e9086", accent: "#c2410c",
  },
  dark: {
    say: "#a4a69d", agent: "#b48bf0", run: "#4fc4c0", ask: "#e0b95c", decide: "#4fb477",
    note: "#f4762e", ledger: "#f4762e", ok: "#96e3a6", fail: "#e2685f", running: "#e0a458",
    dim: "#76786f", accent: "#f4762e",
  },
};

/**
 * Which palette suits the terminal's ground. DELPHI_THEME says outright;
 * otherwise COLORFGBG, which rxvt, Konsole and iTerm2 set to "fg;bg" with bg 0
 * to 6 or 8 dark and 7 or 15 light. Dark when nothing says, because most
 * terminals are.
 */
function detectTheme(env = process.env) {
  const asked = String(env.DELPHI_THEME || "").toLowerCase();
  if (asked === "light" || asked === "dark") return asked;
  const fgbg = String(env.COLORFGBG || "").split(";");
  const bg = Number(fgbg[fgbg.length - 1]);
  if (fgbg.length > 1 && Number.isInteger(bg)) return bg === 7 || bg >= 9 ? "light" : "dark";
  return "dark";
}

/**
 * How much colour to use: "none" under NO_COLOR (any non-empty value, as
 * no-color.org says), "truecolor" when COLORTERM says so, else "256". Terminal.app
 * has no truecolor, and an RGB code there comes out as the wrong colour rather
 * than none, so the 256 colour fallback is the safe default.
 */
function colorDepth(env = process.env) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (env.TERM === "dumb") return "none";
  const ct = String(env.COLORTERM || "").toLowerCase();
  return ct === "truecolor" || ct === "24bit" ? "truecolor" : "256";
}

function hexRgb(hex) {
  const n = parseInt(String(hex).replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The nearest colour in xterm's 6x6x6 cube or grey ramp. */
function to256([r, g, b]) {
  const level = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  const steps = [0, 95, 135, 175, 215, 255];
  const [ri, gi, bi] = [level(r), level(g), level(b)];
  const cube = [steps[ri], steps[gi], steps[bi]];
  const grey = Math.round(((r + g + b) / 3 - 8) / 10);
  const gi2 = Math.max(0, Math.min(23, grey));
  const greyValue = 8 + gi2 * 10;
  const dist = (a) => (a[0] - r) ** 2 + (a[1] - g) ** 2 + (a[2] - b) ** 2;
  return dist([greyValue, greyValue, greyValue]) < dist(cube) ? 232 + gi2 : 16 + 36 * ri + 6 * gi + bi;
}

/**
 * A painter: paint(role, text) wraps text in that role's colour. Roles are the
 * palette keys plus "bold", "dim" and "inverse", which are not colour and so
 * survive NO_COLOR. Every painted run ends in a full reset, so nothing a body
 * contains can carry a style past its own line.
 */
function makePainter({ theme = "dark", depth = "256" } = {}) {
  const colors = PALETTE[theme] || PALETTE.dark;
  return function paint(role, text) {
    const s = String(text);
    if (!s) return s;
    if (role === "bold") return `\x1b[1m${s}\x1b[0m`;
    if (role === "inverse") return `\x1b[7m${s}\x1b[0m`;
    if (role === "dim" && depth === "none") return `\x1b[2m${s}\x1b[0m`;
    const hex = colors[role];
    if (!hex || depth === "none") return s;
    const rgb = hexRgb(hex);
    const code = depth === "truecolor" ? `38;2;${rgb.join(";")}` : `38;5;${to256(rgb)}`;
    return `\x1b[${code}m${s}\x1b[0m`;
  };
}

// --- width -------------------------------------------------------------------

// Wide (two cell) ranges from Unicode's East Asian Width W and F classes, and
// the emoji blocks that terminals draw two cells wide.
const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4], [0x17000, 0x18cff], [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f202], [0x1f210, 0x1f23b], [0x1f240, 0x1f248],
  [0x1f250, 0x1f251], [0x1f260, 0x1f265], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

// Zero width: combining marks, joiners, variation selectors, and the rest of
// what modifies the character before it.
const ZERO = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f], [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x2064], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff],
  [0x1f3fb, 0x1f3ff], [0xe0000, 0xe0fff],
];

function inRanges(cp, ranges) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function codeWidth(cp) {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (inRanges(cp, ZERO)) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}

const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/**
 * What the eye reads as one character, each with its width. A family emoji is
 * seven code points joined and two cells; a flag is two regional indicators and
 * two cells; a keycap is a digit, a selector and a mark.
 */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function graphemes(text) {
  const s = String(text);
  // Most of a Sheet is plain ASCII, one cell a character, and the segmenter
  // is slow enough that skipping it is the difference on a long Sheet.
  if (PRINTABLE_ASCII.test(s)) return Array.from(s, (g) => ({ g, w: 1 }));
  const parts = segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
  return parts.map((g) => {
    const cps = Array.from(g, (c) => c.codePointAt(0));
    let w = codeWidth(cps[0]);
    if (cps.length > 1) {
      // Emoji presentation asked for, or a flag, is two cells. A joiner is
      // two only when what it joins is: a ZWJ between plain letters (which a
      // segmenter glues to the letter before it) leaves that letter one cell.
      if (cps.includes(0xfe0f) || (cps[0] >= 0x1f1e6 && cps[0] <= 0x1f1ff)) w = 2;
      else w = Math.max(...cps.map(codeWidth));
    } else if (cps[0] >= 0x1f1e6 && cps[0] <= 0x1f1ff) {
      w = 1;
    }
    return { g, w };
  });
}

/** Cells text takes. Expects text without escape codes; see visibleWidth for painted text. */
function displayWidth(text) {
  if (PRINTABLE_ASCII.test(text)) return String(text).length;
  let w = 0;
  for (const { w: cw } of graphemes(text)) w += cw;
  return w;
}

const SGR = /\x1b\[[0-9;]*m/g;

function visibleWidth(painted) {
  return displayWidth(String(painted).replace(SGR, ""));
}

/**
 * Text cut to fit width cells, with an ellipsis when anything was cut. Never
 * splits a wide character: one that would straddle the edge is left out and
 * the gap padded, so the next column starts where it should.
 */
function truncate(text, width, { ellipsis = "…" } = {}) {
  const s = String(text);
  if (width <= 0) return "";
  if (displayWidth(s) <= width) return s;
  const room = width - displayWidth(ellipsis);
  let out = "";
  let used = 0;
  for (const { g, w } of graphemes(s)) {
    if (used + w > room) break;
    out += g;
    used += w;
  }
  return out + " ".repeat(Math.max(0, room - used)) + (room >= 0 ? ellipsis : "");
}

/** Pads with spaces to exactly width cells, truncating first if it is longer. */
function fit(text, width) {
  const t = truncate(text, width);
  return t + " ".repeat(Math.max(0, width - displayWidth(t)));
}

/** Hard wraps one line to width cells, by grapheme. An empty line stays one empty line. */
function wrap(line, width) {
  if (width <= 0) return [""];
  const out = [];
  let cur = "";
  let used = 0;
  for (const { g, w } of graphemes(line)) {
    if (used + w > width && cur) { out.push(cur); cur = ""; used = 0; }
    cur += g;
    used += w;
  }
  out.push(cur);
  return out;
}

/**
 * Text that is safe to put on the screen. Anything stored can hold escape
 * codes (a log, a pasted reply), and drawn as is they would move the cursor,
 * retitle the window or worse. Codes are stripped, tabs expanded, and any other
 * control character shown as a visible placeholder rather than obeyed.
 */
function sanitize(text) {
  return String(text == null ? "" : text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]?/g, "")
    .replace(/\x1b./g, "")
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g, "·");
}

// --- the screen ----------------------------------------------------------------

const ENTER = "\x1b[?1049h\x1b[?2004h\x1b[H\x1b[2J";
const LEAVE = "\x1b[?2026l\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l";

function writeSync(out, text) {
  // Synchronous where there is a descriptor, because the exit handler runs
  // after the event loop has stopped and an ordinary write would never land.
  if (out && typeof out.fd === "number") {
    try { fs.writeSync(out.fd, text); return; } catch {}
  }
  try { out.write(text); } catch {}
}

/**
 * The screen. enter() takes over the terminal, leave() gives it back and is
 * safe to call any number of times. draw(lines, cursor) repaints the whole
 * frame; cursor is { row, col } to show the cursor there, or null to hide it.
 */
function createScreen({ out = process.stdout, theme = detectTheme(), depth = colorDepth() } = {}) {
  let active = false;
  const resizeHandlers = new Set();
  const paint = makePainter({ theme, depth });
  const onResize = () => { for (const fn of resizeHandlers) { try { fn(); } catch {} } };
  return {
    theme,
    depth,
    paint,
    get active() { return active; },
    enter() {
      if (active) return;
      active = true;
      writeSync(out, ENTER);
      if (out.on) out.on("resize", onResize);
    },
    leave() {
      if (!active) return;
      active = false;
      if (out.removeListener) out.removeListener("resize", onResize);
      writeSync(out, LEAVE);
    },
    size() {
      return { cols: Math.max(1, out.columns || 80), rows: Math.max(1, out.rows || 24) };
    },
    draw(lines, cursor = null) {
      if (!active) return;
      const { rows } = this.size();
      // Synchronised output, so a terminal that supports it shows the frame
      // whole instead of tearing; the rest ignore the request.
      let frame = "\x1b[?2026h\x1b[?25l\x1b[H";
      for (let r = 0; r < rows; r++) {
        frame += `\x1b[${r + 1};1H${lines[r] || ""}\x1b[0m\x1b[K`;
      }
      if (cursor) frame += `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h`;
      frame += "\x1b[?2026l";
      try { out.write(frame); } catch {}
    },
    onResize(fn) { resizeHandlers.add(fn); return () => resizeHandlers.delete(fn); },
  };
}

/**
 * Runs restore() on every way out of the process, once. Signals and crashes
 * then end the process themselves, with the conventional code, after
 * beforeExit(reason) has had its chance (the Sheet uses it to finish a running
 * command's entry rather than leave it "running"). Returns an uninstall.
 */
function guardTerminal(restore, { beforeExit = null, log = (t) => process.stderr.write(t) } = {}) {
  let restored = false;
  const once = () => { if (restored) return; restored = true; try { restore(); } catch {} };
  let ending = false;
  const end = async (reason, code, detail) => {
    once();
    if (detail) log(`${detail}\n`);
    if (ending) { process.exit(code); return; }
    ending = true;
    if (beforeExit) {
      const cap = new Promise((r) => { const t = setTimeout(r, 8000); if (t.unref) t.unref(); });
      try { await Promise.race([Promise.resolve(beforeExit(reason)), cap]); } catch {}
    }
    process.exit(code);
  };
  // While a child has the terminal ($EDITOR, $PAGER, a shell), Ctrl-C there
  // reaches this process too, because it shares the foreground process group.
  // It was meant for the child, so it is left to the child.
  let childHasTerminal = false;
  const handlers = {
    SIGINT: () => { if (!childHasTerminal) end("SIGINT", 130); },
    SIGTERM: () => end("SIGTERM", 143),
    SIGHUP: () => end("SIGHUP", 129),
    // Ctrl-\ at a terminal not in raw mode, or kill -QUIT: the default would
    // dump core and leave the terminal raw.
    SIGQUIT: () => end("SIGQUIT", 131),
  };
  const onCrash = (error) => end("crash", 1, `delphi: ${error && error.stack ? error.stack : error}`);
  for (const [sig, fn] of Object.entries(handlers)) process.on(sig, fn);
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
  process.on("exit", once);
  const uninstall = () => {
    for (const [sig, fn] of Object.entries(handlers)) process.removeListener(sig, fn);
    process.removeListener("uncaughtException", onCrash);
    process.removeListener("unhandledRejection", onCrash);
    process.removeListener("exit", once);
  };
  uninstall.childOwnsTerminal = (on) => { childHasTerminal = Boolean(on); };
  return uninstall;
}

module.exports = {
  PALETTE, detectTheme, colorDepth, makePainter, to256,
  displayWidth, visibleWidth, truncate, fit, wrap, sanitize, graphemes,
  createScreen, guardTerminal, ENTER, LEAVE,
};
