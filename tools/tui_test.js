#!/usr/bin/env node
// The Sheet in a terminal, without a terminal.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/tui_test.js
//
// A pseudo terminal needs a native dependency, so sheet/tui/sheet.js is built
// for this instead: the state machine takes keys as bytes and returns frames as
// lines, and the clipboard, $EDITOR, $PAGER and the runner are injected. So
// this drives it with the bytes a terminal would send and reads what it would
// draw and what it would copy.
//
// The milestone's test is here by name: yanking an agent's reply puts its
// stored body on the clipboard byte for byte, braces, fences and all. It is
// proved twice, against a fake client and against the real MCP server on a
// throwaway database.
//
// Then the terminal itself: every way out of the process (exit, crash, SIGINT,
// SIGTERM, SIGHUP) puts the screen back, and delphi open with no terminal
// refuses without writing a single escape code.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-tui-"));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");
for (const real of [path.join(os.homedir(), "va", "delphi", "delphi.db"),
                    path.join(os.homedir(), "Library", "Application Support", "Delphi", "delphi.db")]) {
  if (path.resolve(process.env.DELPHI_DB) === real) { console.error("refusing to run against a real database"); process.exit(1); }
}

const keys = require("../sheet/tui/keys");
const scr = require("../sheet/tui/screen");
const clip = require("../sheet/tui/clip");
const tui = require("../sheet/tui/sheet");
const fmt = require("../sheet/format");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bin", "delphi");

let failures = 0;
let checks = 0;
function check(what, got, want) {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}
function section(name) { console.log(`\n${name}`); }
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const names = (list) => list.map((k) => `${k.ctrl ? "C-" : ""}${k.meta ? "M-" : ""}${k.name}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fixtures ------------------------------------------------------------------

const TRICKY = "Done. The status line reads  {id:1 ok}";
const FENCED = [
  "Here is the fix:",
  "",
  "```js",
  "const x = { a: 1 };",
  "$ not a run",
  "  indented  {id:2}",
  "```",
  "",
  "Then run it.  {}",
].join("\n");

function entry(id, fields) {
  return {
    id, task_id: 42, kind: "say", author: "ray", author_type: "human", body: "", meta: null,
    promoted: 0, ref_id: null, note_id: null, note_kind: null,
    created_at: "2026-10-01 10:00:00", updated_at: "2026-10-01 10:00:00", ...fields,
  };
}

function seed() {
  return [
    entry(806, { body: "why is the DLQ filling up?" }),
    entry(807, { author: "claude-code:7", author_type: "agent", body: TRICKY }),
    entry(808, { kind: "run", author: "ray", body: "aws sqs get-queue-attributes --queue-url https://example.invalid/q",
      meta: { state: "ok", code: 0, dur_ms: 1200, lines: 340, out: "line one\nline two" } }),
    entry(809, { kind: "ask", author: "claude-code:7", author_type: "agent", body: "retry strategy",
      meta: { options: [{ key: "a", label: "exponential" }, { key: "b", label: "fixed" }] } }),
    entry(810, { author: "claude-code:7", author_type: "agent", body: FENCED }),
    entry(811, { kind: "note", body: "bump timeout to 15m before deploy", promoted: 1, note_kind: "gotcha", note_id: 5 }),
  ];
}

/**
 * A client that answers the tools the Sheet calls, from memory, and records
 * every call. Close enough to the server's shapes for the state machine, which
 * is all it is for; the real server gets its own section below.
 */
function fakeClient({ entries = seed(), workbench = null } = {}) {
  let rows = entries.map((e) => ({ ...e }));
  let nextId = Math.max(0, ...rows.map((e) => e.id)) + 1;
  const calls = [];
  const tasks = {
    42: { id: 42, title: "fix zip DLQ backlog", status: "doing", project_id: 1 },
    57: { id: 57, title: "中文のタスク with a long title 🚀🚀", status: "todo", project_id: 1 },
  };
  let bench = workbench;
  const byId = (id) => rows.find((e) => e.id === id);
  const add = (fields) => { const e = entry(nextId++, { author: "you", ...fields }); rows.push(e); return e; };
  const client = {
    calls,
    rows: () => rows,
    addExternal(fields) { return add(fields); },
    async call(tool, args) {
      calls.push([tool, args]);
      switch (tool) {
        case "sheet_resolve": {
          const id = Number(String(args.task).replace(/^#/, ""));
          if (!tasks[id]) throw new Error(`No task matches '${args.task}'.`);
          return { task: tasks[id], project: { id: 1, key: "efolder", name: "eFolder" }, workbench: bench && bench.workbench, cwd: dir, cwd_source: "folder", log_dir: path.join(dir, "logs") };
        }
        case "sheet_read": {
          const t = tasks[args.task_id];
          let list = rows.filter((e) => e.task_id === args.task_id);
          if (args.after_id !== undefined) list = list.filter((e) => e.id > args.after_id);
          const last = list.length ? list[list.length - 1].id : 0;
          return {
            task: { id: t.id, title: t.title, status: t.status, project: "efolder" },
            entries: list.map((e) => ({ ...e })),
            total: list.length,
            ledger_count: 0,
            cursor: { after_id: Math.max(args.after_id || 0, last), since: "2026-10-01 10:00:00" },
          };
        }
        case "sheet_append": return add({ task_id: args.task_id, kind: args.kind, body: args.body, meta: args.meta || null, promoted: args.promote ? 1 : 0 });
        case "sheet_ask": return add({ task_id: args.task_id, kind: "ask", body: args.question, meta: { options: args.options.map((label, i) => ({ key: "abcd"[i], label })) } });
        case "sheet_decide": return add({ task_id: byId(args.ask_id).task_id, kind: "decide", body: args.choice, ref_id: args.ask_id, promoted: 1 });
        case "sheet_promote": { const e = byId(args.id); e.promoted = args.on === false ? 0 : 1; return { ...e }; }
        case "sheet_update": { const e = byId(args.id); if (args.body !== undefined) e.body = args.body; if (args.meta) e.meta = { ...(e.meta || {}), ...args.meta }; return { ...e }; }
        case "sheet_file": { const e = byId(args.id); e.note_kind = args.kind; e.note_id = 99; e.promoted = 1; return { entry: { ...e }, note: { id: 99, kind: args.kind, title: e.body.split("\n")[0] } }; }
        case "update_task": { tasks[args.id].status = args.status; return { ...tasks[args.id], ...(args.status === "done" && bench ? { workbench: bench.workbench } : {}) }; }
        case "workbench_status": return bench || { workbench: null };
        case "workbench_park": bench = { ...bench, workbench: { ...bench.workbench, state: "parked" } }; return bench.workbench;
        case "workbench_update": return { ok: true, words: "Up to date with main." };
        default: throw new Error(`fake client has no ${tool}`);
      }
    },
  };
  return client;
}

/** An app on the fake client with every piece of io recorded. */
async function makeApp({ client = fakeClient(), cols = 100, rows = 30, paint = null, io = {} } = {}) {
  const resolved = await client.call("sheet_resolve", { task: "42" });
  const seen = { clip: [], edit: [], pager: [], folder: [], runs: [], hooks: [] };
  const dims = { cols, rows };
  const app = tui.createSheetApp({
    client, resolved, paint,
    size: () => dims,
    io: {
      clip: async (text) => { seen.clip.push(text); return { via: "osc52+pbcopy" }; },
      readLog: (e) => (e.id === 808 ? "\x1b[32mfull log line 1\x1b[0m\nfull log line 2\n" : null),
      edit: async (body) => { seen.edit.push(body); return "edited body\n\n"; },
      pager: async (e) => { seen.pager.push(e.id); },
      openFolder: async (d) => { seen.folder.push(d); },
      suspend: async (fn) => fn(),
      hooks: { finish: async (id) => { seen.hooks.push(["finish", id]); }, work: async (id) => { seen.hooks.push(["work", id]); } },
      runEntry: async (opts) => {
        seen.runs.push(opts.command);
        const e = await opts.store.append({ taskId: opts.taskId, kind: "run", body: opts.command, meta: { state: "running" } });
        let interrupted = 0;
        let stop;
        const stopped = new Promise((r) => { stop = r; });
        opts.onStart({ entry: e, interrupt: () => { interrupted++; seen.interrupts = interrupted; stop(); }, kill: (why) => { seen.killed = why; stop(); } });
        opts.onChunk(Buffer.from("building\r50%\r100%\nstep two\n\x1b[31mred\x1b[0m"));
        if (opts.command.includes("forever")) await stopped;
        return opts.store.update(e.id, { meta: { state: interrupted ? "fail" : "ok", code: interrupted ? 130 : 0, dur_ms: 50, lines: 3 } });
      },
      ...io,
    },
  });
  await app.load();
  return { app, client, seen, dims };
}

const frame = (app) => app.render().lines.map(strip);

async function main() {
  // --- keys ----------------------------------------------------------------------
  section("keys: decoding what a terminal sends");
  check("arrows, CSI and SS3", names(keys.decode("\x1b[A\x1b[B\x1bOC\x1bOD")), ["up", "down", "right", "left"]);
  check("ctrl and shift arrows", names(keys.decode("\x1b[1;5C\x1b[1;2A")), ["C-right", "up"]);
  check("shift is read", keys.decode("\x1b[1;2A")[0].shift, true);
  check("home end delete pages", names(keys.decode("\x1b[H\x1b[F\x1b[3~\x1b[5~\x1b[6~\x1b[1~\x1b[4~")),
    ["home", "end", "delete", "pageup", "pagedown", "home", "end"]);
  check("a lone Esc at the end is Esc", names(keys.decode("\x1b")), ["escape"]);
  check("Esc Esc is two", names(keys.decode("\x1b\x1b")), ["escape", "escape"]);
  check("Alt-x", names(keys.decode("\x1bx")), ["M-x"]);
  check("Alt-x has no ch, so it is never typed", keys.decode("\x1bx")[0].ch, null);
  check("Alt-Backspace", names(keys.decode("\x1b\x7f")), ["M-backspace"]);
  check("Ctrl-C, Enter, Backspace, Tab", names(keys.decode("\x03\r\x7f\t")), ["C-c", "enter", "backspace", "tab"]);
  check("Ctrl-J is Enter too", names(keys.decode("\n")), ["enter"]);
  check("shift-tab", names(keys.decode("\x1b[Z")), ["tab"]);
  check("UTF-8: accent, CJK, emoji", keys.decode("é中😀").map((k) => k.ch), ["é", "中", "😀"]);
  check("Alt with a multibyte character", keys.decode("\x1bé")[0], { name: "é", ch: null, ctrl: false, meta: true, shift: false });
  check("upper case is shift", keys.decode("Y")[0].shift, true);
  check("stray continuation byte skipped", keys.decode(Buffer.from([0x80, 0x61])).map((k) => k.ch), ["a"]);
  {
    const paste = keys.decode("x\x1b[200~line one\r\nline two\x1b[A\x1b[201~y");
    check("bracketed paste is one key", names(paste), ["x", "paste", "y"]);
    check("its text, line endings made \\n, escapes kept as text", paste[1].text, "line one\nline two\x1b[A");
  }

  section("keys: a live stream, split anywhere");
  {
    const got = [];
    const d = keys.createDecoder({ escMs: 20, onKeys: (ks) => got.push(...ks) });
    const emoji = Buffer.from("😀", "utf8");
    got.push(...d.push(emoji.subarray(0, 2)));
    check("half an emoji waits", got.length, 0);
    got.push(...d.push(emoji.subarray(2)));
    check("then arrives whole", got.map((k) => k.ch), ["😀"]);
    got.length = 0;
    got.push(...d.push(Buffer.from("\x1b[")));
    got.push(...d.push(Buffer.from("1;5A")));
    check("a CSI split in two", names(got), ["C-up"]);
    got.length = 0;
    got.push(...d.push(Buffer.from("\x1b")));
    check("a lone Esc is not decided at once", got.length, 0);
    await wait(60);
    check("and is Esc after the wait", names(got), ["escape"]);
    got.length = 0;
    got.push(...d.push(Buffer.from("\x1b")));
    got.push(...d.push(Buffer.from("j")));
    check("Esc then j quickly is Alt-j", names(got), ["M-j"]);
    got.length = 0;
    got.push(...d.push(Buffer.from("\x1b[200~first half ")));
    await wait(60);
    check("a paste still arriving is not cut by the wait", got.length, 0);
    got.push(...d.push(Buffer.from("second half\x1b[201~")));
    check("a paste split across reads", got.map((k) => k.text), ["first half second half"]);
  }

  // --- width ------------------------------------------------------------------------
  section("screen: display width");
  check("ascii", scr.displayWidth("abc"), 3);
  check("CJK is two cells each", scr.displayWidth("中文"), 4);
  check("emoji", scr.displayWidth("🚀"), 2);
  check("joined family emoji is one glyph", scr.displayWidth("👨‍👩‍👧"), 2);
  check("flag", scr.displayWidth("🇬🇧"), 2);
  check("combining accent adds nothing", scr.displayWidth("é"), 1);
  check("variation selector emoji", scr.displayWidth("❤️"), 2);
  for (const w of [1, 2, 3, 5, 9]) {
    const t = scr.truncate("中文中文🚀abc", w);
    check(`truncate to ${w} never overflows`, scr.displayWidth(t) <= w, true);
  }
  check("truncate pads a split wide char", scr.truncate("中文中", 4), "中 …");
  check("fit pads to width", scr.displayWidth(scr.fit("中", 5)), 5);
  check("wrap by width", scr.wrap("中文中文ab", 4), ["中文", "中文", "ab"]);
  check("sanitize strips codes and shows controls", scr.sanitize("a\x1b[31mred\x1b[0m\x1b]0;title\x07\x07b\tc"), "ared·b    c");

  section("screen: theme and colour");
  check("DELPHI_THEME wins", scr.detectTheme({ DELPHI_THEME: "light", COLORFGBG: "15;0" }), "light");
  check("COLORFGBG light ground", scr.detectTheme({ COLORFGBG: "0;15" }), "light");
  check("COLORFGBG dark ground", scr.detectTheme({ COLORFGBG: "15;0" }), "dark");
  check("dark by default", scr.detectTheme({}), "dark");
  check("NO_COLOR", scr.colorDepth({ NO_COLOR: "1", COLORTERM: "truecolor" }), "none");
  check("empty NO_COLOR is not set", scr.colorDepth({ NO_COLOR: "", COLORTERM: "truecolor" }), "truecolor");
  check("256 by default", scr.colorDepth({}), "256");
  check("truecolor agent in dark is the app's purple", scr.makePainter({ theme: "dark", depth: "truecolor" })("agent", "@"), "\x1b[38;2;180;139;240m@\x1b[0m");
  check("light run is the app's teal", scr.makePainter({ theme: "light", depth: "truecolor" })("run", "$"), "\x1b[38;2;15;122;128m$\x1b[0m");
  check("256 colour fallback", /^\x1b\[38;5;\d+m\$\x1b\[0m$/.test(scr.makePainter({ depth: "256" })("run", "$")), true);
  check("NO_COLOR paints no colour", scr.makePainter({ depth: "none" })("agent", "@"), "@");
  check("palettes have the same roles", Object.keys(scr.PALETTE.light), Object.keys(scr.PALETTE.dark));
  {
    // The palette is copied from index.html; this keeps the copy honest.
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    const light = scr.PALETTE.light;
    check("light agent matches --tc-purple", html.includes(`--tc-purple: ${light.agent}`), true);
    check("light run matches --tc-teal", html.includes(`--tc-teal:   ${light.run}`), true);
    check("dark decide matches --tc-green", html.includes(`--tc-green:  ${scr.PALETTE.dark.decide}`), true);
  }

  // --- clipboard -----------------------------------------------------------------------
  section("clip: OSC 52 and the fallbacks");
  check("osc52 is base64 of the UTF-8", clip.osc52("hé 🚀"), `\x1b]52;c;${Buffer.from("hé 🚀").toString("base64")}\x07`);
  check("osc52 in tmux is wrapped", clip.osc52("x", { tmux: true }), "\x1bPtmux;\x1b\x1b]52;c;eA==\x07\x1b\\");
  check("macOS uses pbcopy", clip.candidates("darwin", {}).map((c) => c.via), ["pbcopy"]);
  check("Windows uses clip.exe", clip.candidates("win32", {}).map((c) => c.via), ["clip.exe"]);
  check("Linux by display", clip.candidates("linux", { WAYLAND_DISPLAY: "w", DISPLAY: ":0" }).map((c) => c.via), ["wl-copy", "xclip"]);
  check("WSL goes to the Windows clipboard", clip.candidates("linux", { WSL_DISTRO_NAME: "u" }).map((c) => c.via), ["clip.exe"]);
  {
    const written = [];
    const piped = [];
    const out = { isTTY: true, write: (t) => written.push(t) };
    const r = await clip.copy("payload", { out, env: {}, platform: "darwin", run: async (argv, text) => { piped.push([argv, text]); return true; } });
    check("both routes taken", r.via, "osc52+pbcopy");
    check("terminal asked", written, [clip.osc52("payload")]);
    check("pbcopy given the text on stdin, as argv", piped, [[["pbcopy"], "payload"]]);
    const none = await clip.copy("x", { out: { isTTY: false, write: () => written.push("no") }, env: {}, platform: "linux", run: async () => false });
    check("no terminal and no tool", none.via, null);
    const onlyTerm = await clip.copy("x", { out, env: {}, platform: "linux", run: async () => false });
    check("only the terminal", onlyTerm.via, "osc52");
  }

  // --- yank -----------------------------------------------------------------------------
  section("yankText: what goes on the clipboard");
  {
    const s = seed();
    check("agent reply ending in braces is its body, byte for byte", tui.yankText([s[1]]), TRICKY);
    check("fenced multi-line body, byte for byte", tui.yankText([s[4]]), FENCED);
    check("a run is its command", tui.yankText([s[2]]), s[2].body);
    check("Y adds the whole log, colour stripped", tui.yankText([s[2]], { withOutput: true, logs: { 808: "\x1b[1mlog\x1b[0m\nmore\n\n" } }), `${s[2].body}\nlog\nmore`);
    check("Y without a log uses the short output", tui.yankText([s[2]], { withOutput: true }), `${s[2].body}\nline one\nline two`);
    check("a question is its clean line", tui.yankText([s[3]]), "? retry strategy: [a] exponential [b] fixed");
    const range = tui.yankText(s.slice(0, 3));
    check("a range is clean text", range, fmt.format({ entries: s.slice(0, 3) }, { clean: true }));
    check("with no metadata braces of its own", /\{id:80/.test(range), false);
    check("but the braces the agent wrote", range.includes(TRICKY), true);
    const back = fmt.parse(range, { clean: true });
    check("and it reads back as the same bodies", back.entries.map((e) => e.body), [s[0].body, TRICKY, s[2].body]);
    const fencedRange = tui.yankText([s[4], s[5]]);
    check("a fenced range reads back intact", fmt.parse(fencedRange, { clean: true }).entries[0].body, FENCED);
  }

  section("summaryFor: the dim right side, never braces");
  {
    const s = seed();
    check("a finished run", tui.summaryFor(s[2]), "ok 1.2s  340 lines");
    check("a failed run", tui.summaryFor(entry(1, { kind: "run", meta: { state: "fail", code: 1, dur_ms: 300, lines: 1 } })), "fail:1 0.3s  1 line");
    check("a running run", tui.summaryFor(entry(1, { kind: "run", meta: { state: "running", lines: 12 } })), "running  12 lines");
    check("a filed note", tui.summaryFor(s[5]), "gotcha");
    check("an agent's question", tui.summaryFor(s[3]), "claude-code");
    check("an answered one", tui.summaryFor(s[3], { decided: entry(2, { kind: "decide", body: "a" }) }), "answered a  claude-code");
    check("a folded body", tui.summaryFor(s[4]), "8 more");
    check("unfolded", tui.summaryFor(s[4], { expanded: true }), "");
  }

  section("layout: widths, themes, wide text");
  {
    const s = seed();
    s.push(entry(812, { author: "小林", body: "中文の返信です。絵文字も 🚀👨‍👩‍👧 あります。とても長い行は切り詰められます。" }));
    for (const width of [40, 60, 120]) {
      for (const theme of ["light", "dark"]) {
        const paint = scr.makePainter({ theme, depth: "truecolor" });
        const rows = tui.layout(s, { width, paint, expanded: new Set([808, 810]) });
        check(`every row fits at ${width} (${theme})`, rows.filter((r) => scr.visibleWidth(r) > width).map(strip), []);
        check(`painting changes no text at ${width} (${theme})`, rows.map(strip), tui.layout(s, { width, expanded: new Set([808, 810]) }));
      }
    }
    const rows = tui.layout(s, { width: 60 });
    check("one row per folded entry", rows.length, s.length);
    check("say: sigil, author column, text", rows[0], "  > ray         why is the DLQ filling up?");
    check("agent reply shows its own braces as text", rows[1], "  @ claude-code Done. The status line reads  {id:1 ok}");
    check("a run row is the command and the summary", rows[2], "  $ aws sqs get-queue-attributes --queu…  ok 1.2s  340 lines");
    check("a question shows its options", rows[3].startsWith("  ? retry strategy   [a] exponential  [b] fixed"), true);
    check("the ledger gutter", rows[5].slice(0, 4), " +! ");
    check("filed note kind on the right", rows[5].endsWith("gotcha"), true);
    check("no metadata block anywhere", rows.some((r) => /\{(id|by|ref):/.test(r.replace("{id:1 ok}", ""))), false);
    const narrow = tui.layout(s, { width: 40 });
    check("narrow keeps the summary when it fits", narrow[2].endsWith("ok 1.2s  340 lines"), true);
    check("wide text cut by width at 40", scr.displayWidth(narrow[6]) <= 40, true);
    const open = tui.layout(s, { width: 60, expanded: new Set([810, 808]), outputs: { 808: "out 1\nout 2" } });
    check("unfolded fenced body keeps its lines", open.filter((r) => r.startsWith("    ")).length >= 10, true);
    check("unfolded run shows its output", open.includes("    out 2"), true);
    check("the cursor mark", tui.layout(s, { width: 60, cursor: 807 })[1].startsWith("› "), true);
    check("ledger view", tui.layout(s, { width: 60, ledgerOnly: true }).length, 1);
  }

  section("parseInput: the Type mode prefixes");
  check("say", tui.parseInput("hello there"), { kind: "say", body: "hello there" });
  check("run", tui.parseInput("$ npm test"), { kind: "run", command: "npm test" });
  check("note", tui.parseInput("! deployed"), { kind: "note", body: "deployed" });
  check("ask", tui.parseInput("? which way | left | right"), { kind: "ask", question: "which way", options: ["left", "right"] });
  check("ask needs two answers", tui.parseInput("? which | left").kind, "error");
  check("ask allows four at most", tui.parseInput("? q | a | b | c | d | e").kind, "error");
  check("command", tui.parseInput("/status done"), { kind: "command", name: "status", arg: "done" });
  check("// says a slash", tui.parseInput("//etc is a folder"), { kind: "say", body: "/etc is a folder" });
  check("a $ with two lines is refused", tui.parseInput("$ echo a\necho b").kind, "error");
  check("$5 is a say", tui.parseInput("$5 is cheap").kind, "say");

  // --- the app, driven by keys -----------------------------------------------------------
  section("the app: Type mode");
  {
    const { app, client, seen } = await makeApp();
    let f = frame(app);
    check("header names the task", f[0].startsWith(" 42  fix zip DLQ backlog"), true);
    check("header right side", f[0].endsWith("efolder · doing · ledger 1"), true);
    check("status line says y copies clean", f[f.length - 1].includes("y copies clean"), true);
    check("prompt", f[f.length - 2], " 42› ");
    await app.feed("hello 世界\r");
    check("plain text says", client.calls.filter((c) => c[0] === "sheet_append").map((c) => c[1]), [{ task_id: 42, kind: "say", body: "hello 世界" }]);
    f = frame(app);
    check("and shows up", f.some((l) => l.includes("hello 世界")), true);
    await app.feed("! shipped\r");
    check("! notes", client.rows().pop().kind, "note");
    await app.feed("? which | left | right\r");
    check("? asks", client.rows().pop().meta.options.map((o) => o.label), ["left", "right"]);
    await app.feed("$ echo hi\r");
    await app.chain;
    await wait(10);
    check("$ runs", seen.runs, ["echo hi"]);
    const run = client.rows().find((e) => e.kind === "run" && e.body === "echo hi");
    check("the run is finished through the one write path", run.meta.state, "ok");
    await app.feed("abc\x7f\x7fx\x1b[D\x1b[DZ\x01Q\x05!\r");
    check("line editing: backspace, arrows, home, end", client.rows().pop().body, "QZax!");
    await app.feed("\x1b[200~pasted\nsecond line\x1b[201~\r");
    check("a paste keeps its newlines", client.rows().pop().body, "pasted\nsecond line");
    await app.feed("\x1b[A");
    check("up recalls the last input", app.state.input, "pasted\nsecond line");
    await app.feed("\x15");
    check("Ctrl-U clears", app.state.input, "");
    await app.feed("/ledger\r");
    check("/ledger", app.state.ledgerOnly, true);
    await app.feed("/ledger\r/status blocked\r");
    check("/status", client.calls.filter((c) => c[0] === "update_task").pop()[1], { id: 42, status: "blocked" });
    await app.feed("/status nope\r");
    check("a bad status says what is allowed", frame(app).pop().includes("todo, doing, blocked, done"), true);
    await app.feed("/bogus\r");
    check("unknown command", frame(app).pop().includes("No command /bogus"), true);
    await app.feed("/task 57\r");
    check("/task switches", app.state.task.id, 57);
    f = frame(app);
    check("to the other Sheet", f.some((l) => l.includes("Nothing on this Sheet yet")), true);
    await app.feed("/task 42\r");
    check("and back", app.state.entries.length > 6, true);
  }

  section("the app: Walk mode");
  {
    const { app, client, seen } = await makeApp();
    await app.feed("\x1b");
    check("Esc walks", app.state.mode, "walk");
    check("cursor starts on the last entry", app.state.walk, 811);
    await app.feed("kkkk");
    check("k moves up", app.state.walk, 807);
    await app.feed("y");
    check("y on an agent reply copies its stored body byte for byte", seen.clip.pop(), TRICKY);
    check("the status line says so", frame(app).pop().includes("Copied entry 807, clean"), true);
    await app.feed("jjj");
    check("j moves down", app.state.walk, 810);
    await app.feed("y");
    check("fenced multi-line reply, byte for byte", seen.clip.pop(), FENCED);
    await app.feed("\r");
    check("Enter unfolds", app.state.expanded.has(810), true);
    check("showing the fence", frame(app).some((l) => l.includes("    ```js")), true);
    await app.feed("\r");
    check("Enter folds again", app.state.expanded.has(810), false);
    await app.feed("kk");
    check("on the run", app.state.walk, 808);
    await app.feed("Y");
    check("Y copies the command and the full log, clean", seen.clip.pop(), `${seed()[2].body}\nfull log line 1\nfull log line 2`);
    await app.feed("vky");
    check("v then y copies a range, clean", seen.clip.pop(), tui.yankText(client.rows().filter((e) => e.id === 807 || e.id === 808)));
    check("and the range is dropped", app.state.anchor, null);
    await app.feed("j");
    await app.feed("p");
    check("p promotes", client.rows().find((e) => e.id === 808).promoted, 1);
    check("and the gutter shows it at once, not a cached row", frame(app).some((l) => l.startsWith("›+$ ")), true);
    await app.feed("p");
    check("p again demotes", client.rows().find((e) => e.id === 808).promoted, 0);
    await app.feed("fg");
    check("f then g files a gotcha", client.calls.filter((c) => c[0] === "sheet_file").pop()[1], { id: 808, kind: "gotcha" });
    await app.feed("fx");
    check("f then anything else files nothing", client.calls.filter((c) => c[0] === "sheet_file").length, 1);
    await app.feed("r");
    check("r reruns the command as a new entry", seen.runs, [seed()[2].body]);
    await app.chain;
    await wait(10);
    await app.feed("o");
    check("o pages the output", seen.pager.length >= 0, true);
    app.state.walk = 808;
    await app.feed("o");
    check("o pages the run's output", seen.pager.pop(), 808);
    app.state.walk = 809;
    await app.feed("b");
    check("b answers the question under the cursor", client.calls.filter((c) => c[0] === "sheet_decide").pop()[1], { ask_id: 809, choice: "b" });
    check("and the question shows it", frame(app).some((l) => l.includes("answered b")), true);
    await app.feed("d");
    check("an answer it does not have is refused", frame(app).pop().includes("no answer d"), true);
    app.state.walk = 806;
    await app.feed("e");
    check("e edits in $EDITOR", seen.edit.pop(), "why is the DLQ filling up?");
    check("and saves the normalised body", client.calls.filter((c) => c[0] === "sheet_update").pop()[1], { id: 806, body: "edited body" });
    app.state.walk = 809;
    await app.feed("e");
    check("a question is not edited", frame(app).pop().includes("Only remarks and notes"), true);
    await app.feed("L");
    check("L shows the ledger", app.state.ledgerOnly, true);
    check("only ledger rows", frame(app).filter((l) => /^ ?[› ]\+/.test(l)).length, app.state.entries.filter((e) => tui.ledgerIds(app.state.entries).has(e.id)).length);
    await app.feed("L");
    await app.feed("W");
    check("W without a Workbench says so", frame(app).pop().includes("no Workbench"), true);
    await app.feed("i");
    check("i types again", app.state.mode, "type");
    await app.feed("\x1b");
    await app.feed("q");
    await app.done;
    check("q quits", true, true);
  }

  section("the app: Workbench, status and finish");
  {
    const client = fakeClient({ workbench: { workbench: { id: 3, task_id: 42, state: "active", path: path.join(dir, "bench"), branch: "ray/42-fix" }, status: { state: "unsaved", unsaved: 2, ahead: 1, behind: 0, words: "2 unsaved changes" } } });
    const { app, seen } = await makeApp({ client });
    check("the chip", frame(app)[0].includes("wb: 2 unsaved, 1 unshared"), true);
    await app.feed("\x1b");
    await app.feed("W");
    check("W opens the folder", seen.folder, [path.join(dir, "bench")]);
    await app.feed("i/status done\r");
    check("done with a live Workbench asks", frame(app).slice(-2)[0].includes("Finish the Workbench now? y/n"), true);
    await app.feed("y");
    check("y finishes through the command line's flow", seen.hooks, [["finish", 42]]);
    await app.feed("/update\r");
    check("/update says what happened", frame(app).pop().includes("Up to date with main."), true);
    await app.feed("/work\r");
    check("/work hands over to the shell flow", seen.hooks.pop(), ["work", 42]);
    await app.feed("/park\r");
    check("/park", frame(app)[0].includes("wb: parked"), true);
    await app.feed("/status done\r");
    await app.feed("n");
    check("n leaves it", frame(app).pop().includes("Left as it is."), true);
    check("and does not finish", seen.hooks.filter((h) => h[0] === "finish").length, 1);
  }

  section("the app: Ctrl-C and the live tail");
  {
    const { app, client, seen } = await makeApp();
    await app.feed("$ forever\r");
    await wait(10);
    const f = frame(app);
    check("the live tail shows the latest line of a redrawn progress bar", f.some((l) => l.trim() === "100%"), true);
    check("colour codes stripped from the tail", f.some((l) => l.trim() === "red"), true);
    check("status line says how to stop it", f.pop().includes("Ctrl-C stops"), true);
    await app.feed("\x03");
    await wait(10);
    check("Ctrl-C interrupts the running entry", seen.interrupts, 1);
    const run = client.rows().find((e) => e.body === "forever");
    check("which ends fail:130", [run.meta.state, run.meta.code], ["fail", 130]);
    await app.feed("$ forever\r");
    await wait(10);
    await app.feed("\x1b");
    await app.feed("q");
    check("q with a run going asks first", frame(app).slice(-2)[0].includes("still running. Stop and quit? y/n"), true);
    await app.feed("y");
    await app.done;
    check("and stops it before quitting", client.rows().filter((e) => e.body === "forever").every((e) => e.meta.state !== "running"), true);
  }

  section("the app: polling and resize");
  {
    const { app, client, dims } = await makeApp();
    client.addExternal({ task_id: 42, author: "copilot", author_type: "agent", body: "arrived from elsewhere" });
    await app.poll();
    check("a new entry arrives by polling", frame(app).some((l) => l.includes("arrived from elsewhere")), true);
    const read = client.calls.filter((c) => c[0] === "sheet_read").pop()[1];
    check("polling passes the cursor back", [read.after_id, read.since, read.mode], [811, "2026-10-01 10:00:00", "full"]);
    await app.poll();
    check("and the next poll asks after the new one", client.calls.filter((c) => c[0] === "sheet_read").pop()[1].after_id, 812);
    await app.feed("/task 57\r");
    for (const cols of [40, 33, 120]) {
      dims.cols = cols;
      const lines = app.render().lines;
      check(`a ${cols} column frame fits, wide title and all`, lines.filter((l) => scr.visibleWidth(l) > cols).map(strip), []);
    }
    dims.rows = 4;
    const tiny = frame(app);
    check("a very short terminal keeps the prompt and status", [tiny.length, tiny[tiny.length - 2].startsWith(" 57›")], [4, true]);
  }

  section("the app: painted frame in both themes");
  for (const theme of ["light", "dark"]) {
    const paint = scr.makePainter({ theme, depth: "256" });
    const { app } = await makeApp({ paint, cols: 72 });
    await app.feed("\x1b");
    await app.feed("kk");
    const lines = app.render().lines;
    check(`${theme}: coloured`, lines.some((l) => l.includes("\x1b[38;5;")), true);
    check(`${theme}: every row fits`, lines.filter((l) => scr.visibleWidth(l) > 72).length, 0);
    const plain = (await makeApp({ cols: 72 })).app;
    await plain.feed("\x1b");
    await plain.feed("kk");
    check(`${theme}: same text as the plain frame`, lines.map(strip), plain.render().lines);
  }

  // --- the real server ----------------------------------------------------------------------
  section("against the real MCP server: yank pastes the stored body byte for byte");
  {
    const db = require("../db");
    const { openServer } = require("../sheet/client");
    const project = db.createProject({ key: "tui", name: "TUI", path: dir });
    const task = db.createTask({ projectId: project.id, title: "yank test 中文" });
    const agent = openServer({ actor: "claude-code:9", env: { DELPHI_AUTHOR_TYPE: "agent" }, warn: () => {} });
    await agent.start();
    const bodies = [TRICKY, FENCED, "  leading spaces kept\nand a trailing brace }", "emoji 👨‍👩‍👧 and 中文  {by:me +}"];
    const written = [];
    for (const body of bodies) written.push(await agent.call("sheet_append", { task_id: task.id, kind: "say", body }));
    agent.close();

    const person = openServer({ actor: "tester", env: { DELPHI_AUTHOR_TYPE: "human" }, warn: () => {} });
    await person.start();
    const resolved = await person.call("sheet_resolve", { task: String(task.id) });
    const copied = [];
    const app = tui.createSheetApp({ client: person, resolved, io: { clip: async (t) => { copied.push(t); return { via: "osc52" }; } } });
    await app.load();
    await app.feed("\x1b");
    for (let i = written.length - 1; i >= 0; i--) {
      app.state.walk = written[i].id;
      await app.feed("y");
    }
    copied.reverse();
    for (let i = 0; i < bodies.length; i++) {
      const stored = await person.call("sheet_get", { id: written[i].id });
      check(`entry ${i + 1}: clipboard equals the stored body`, Buffer.from(copied[i]).equals(Buffer.from(stored.body)), true);
      check(`entry ${i + 1}: which is what the agent wrote`, stored.body, bodies[i]);
    }
    const rows = app.render().lines;
    check("the server's entries draw as agent replies", rows.filter((l) => /^. @ claude-code /.test(l)).length, 4);
    await app.feed("i a person replies\r");
    const latest = await person.call("sheet_read", { task_id: task.id, mode: "tail", n: 1 });
    check("a say from the Sheet is the person's", [latest.entries[0].author, latest.entries[0].author_type, latest.entries[0].body], ["tester", "human", "a person replies"]);
    person.close();
  }

  // --- the terminal itself ---------------------------------------------------------------------
  section("the terminal is restored on every way out");
  {
    const script = `
      const scr = require(${JSON.stringify(path.join(ROOT, "sheet", "tui", "screen.js"))});
      const s = scr.createScreen({ out: process.stdout, depth: "none" });
      s.enter();
      scr.guardTerminal(() => s.leave(), { log: () => {} });
      process.stdout.write("READY\\n");
      const how = process.argv[1];
      if (how === "crash") setTimeout(() => { throw new Error("boom"); }, 20);
      else if (how === "reject") setTimeout(() => Promise.reject(new Error("nope")), 20);
      else if (how === "exit") setTimeout(() => process.exit(3), 20);
      else setInterval(() => {}, 1000);
    `;
    const runChild = (how, signal) => new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", script, how], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
        if (signal && out.includes("READY")) child.kill(signal);
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.on("close", (code, sig) => { clearTimeout(timer); resolve({ out, code, sig }); });
    });
    for (const [how, signal, code] of [["crash", null, 1], ["reject", null, 1], ["exit", null, 3], ["wait", "SIGINT", 130], ["wait", "SIGTERM", 143], ["wait", "SIGHUP", 129], ["wait", "SIGQUIT", 131]]) {
      const r = await runChild(how, signal);
      const label = signal || how;
      check(`${label}: entered the alternate screen`, r.out.startsWith(scr.ENTER), true);
      check(`${label}: left it again`, r.out.endsWith(scr.LEAVE), true);
      check(`${label}: exit code`, r.code, code);
    }
  }

  section("delphi open in a real terminal, through script(1)");
  {
    // script gives the child a pseudo terminal with nothing installed. Its
    // flags differ between BSD and util-linux, and some systems lack it, so
    // this is a skip there rather than a failure; everything above runs anyway.
    const db = require("../db");
    const project = db.createProject({ key: "pty", name: "PTY", path: dir });
    const task = db.createTask({ projectId: project.id, title: "pty check" });
    const argv = [process.execPath, CLI, "open", String(task.id)];
    const quote = (a) => `'${a.replace(/'/g, "'\\''")}'`;
    // Through cat, because Node's pipes are sockets and script asks its stdin
    // for terminal settings, which a socket refuses; a pipe from cat answers.
    const inner = process.platform === "darwin"
      ? `script -q /dev/null ${argv.map(quote).join(" ")}`
      : `script -qec ${quote(argv.map(quote).join(" "))} /dev/null`;
    const how = process.platform === "darwin" || process.platform === "linux" ? ["sh", ["-c", `cat | ${inner}`]] : null;
    const has = how && spawnSync("sh", ["-c", "command -v script"], { stdio: "ignore" }).status === 0;
    if (!has) {
      console.log("  skipped: no script(1) here to make a terminal with");
    } else {
      const child = spawn(how[0], how[1], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DELPHI_ACTOR: "pty-person", DELPHI_AUTHOR_TYPE: "human" } });
      let out = Buffer.alloc(0);
      child.stdout.on("data", (d) => { out = Buffer.concat([out, d]); });
      const closed = new Promise((r) => child.on("close", (code) => r(code)));
      const until = async (test, ms = 15000) => { const end = Date.now() + ms; while (!test() && Date.now() < end) await wait(50); return test(); };
      const drew = await until(() => out.toString("utf8").includes("pty check"));
      check("it draws the Sheet", drew, true);
      child.stdin.write("said in a real terminal 中文\r");
      await until(() => out.toString("utf8").includes("said in a real terminal"));
      child.stdin.write("\x1b");
      await wait(300);
      child.stdin.write("q");
      // cat holds script open until its own input ends, which is ours.
      await until(() => out.toString("latin1").includes(scr.LEAVE));
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      const code = await closed;
      clearTimeout(timer);
      const text = out.toString("latin1");
      check("it quits cleanly on q", code, 0);
      check("it took the alternate screen", text.includes(scr.ENTER), true);
      check("and gave it back last", text.trimEnd().endsWith(scr.LEAVE), true);
      const { openServer } = require("../sheet/client");
      const reader = openServer({ actor: "reader", warn: () => {} });
      await reader.start();
      const read = await reader.call("sheet_read", { task_id: task.id, mode: "full" });
      reader.close();
      check("what was typed is on the Sheet, as the person", read.entries.map((e) => [e.author, e.body]), [["pty-person", "said in a real terminal 中文"]]);
    }
  }

  section("G4: Ctrl-C gets out while a call hangs");
  {
    const resolved = { task: { id: 1, title: "t", status: "todo" }, project: null, cwd: dir, log_dir: dir };
    const hung = { call: (tool) => (tool === "sheet_append" ? new Promise(() => {}) : Promise.resolve({ entries: [], cursor: null, workbench: null })) };
    const app = tui.createSheetApp({ client: hung, resolved });
    await app.load();
    app.feed("hi\r");
    app.feed("\x03");
    app.feed("\x03");
    const out = await Promise.race([app.done.then(() => "quit"), wait(2000).then(() => "stuck")]);
    check("two Ctrl-C leave even though a write never answers", out, "quit");
  }

  section("G4: a call that does not answer says so, and keeps what was typed");
  {
    const resolved = { task: { id: 1, title: "t", status: "todo" }, project: null, cwd: dir, log_dir: dir };
    const hung = { call: (tool) => (tool === "sheet_append" ? new Promise(() => {}) : Promise.resolve({ entries: [], cursor: null, workbench: null })) };
    const app = tui.createSheetApp({ client: hung, resolved, callMs: 100 });
    await app.load();
    await app.feed("a careful remark\r");
    check("the status line says the server did not answer", /did not answer within 0s \(sheet_append\)/.test(app.state.message.text), true);
    check("the remark is still at the prompt", app.state.input, "a careful remark");
    check("and not in history as if sent", app.state.history, []);
    const dead = { call: (tool) => (tool === "sheet_append" ? Promise.reject(new Error("MCP server exited (SIGKILL)")) : Promise.resolve({ entries: [], cursor: null, workbench: null })) };
    const app2 = tui.createSheetApp({ client: dead, resolved });
    await app2.load();
    await app2.feed("kept\r");
    check("a stopped server is said plainly", [app2.state.input, /Delphi's server has stopped/.test(app2.state.message.text)], ["kept", true]);
  }

  section("G4: Y on a huge log is capped");
  {
    const { app, seen } = await makeApp({ io: {
      readLog: (e, opts = {}) => (e.id === 808 ? `${"x".repeat(1023)}\n`.repeat(opts.tail ? opts.bytes / 1024 : 4096) : null),
      logSize: (e) => (e.id === 808 ? 4 * 1024 * 1024 : 0),
    } });
    await app.feed("\x1b");
    app.state.walk = 808;
    await app.feed("Y");
    const copied = seen.clip.pop();
    check("at most 1 MB goes to the clipboard", Buffer.byteLength(copied) <= 1024 * 1024, true);
    check("the command first, whole", copied.startsWith(seed()[2].body + "\n"), true);
    check("and the status says it was cut", /last 1 MB of its output/.test(app.state.message.text), true);
  }

  section("G4: the clipboard");
  {
    let envSeen = null;
    await clip.copy("na\u00efve", { out: { isTTY: false }, env: { PATH: "/usr/bin" }, platform: "darwin", run: async (argv, text, opts) => { envSeen = opts.env; return true; } });
    check("pbcopy is told the text is UTF-8", [envSeen.LANG, envSeen.LC_CTYPE, envSeen.LC_ALL], ["en_US.UTF-8", "en_US.UTF-8", "en_US.UTF-8"]);
    const written = [];
    const r = await clip.copy("x".repeat(2 * 1024 * 1024), { out: { isTTY: true, write: (t) => written.push(t) }, env: {}, platform: "none", run: async () => false });
    check("OSC 52 is not pushed megabytes", [written.length, r.via], [0, null]);
  }

  section("G4: keys and width");
  {
    check("CR LF is one Enter", names(keys.decode("a\r\nb")), ["a", "enter", "b"]);
    check("Ctrl-C ends a paste that never closes", names(keys.decode("\x1b[200~oops\x03q")), ["paste", "C-c", "q"]);
    const got = [];
    const d = keys.createDecoder({ escMs: 20, pasteMs: 80, onKeys: (ks) => got.push(...ks) });
    got.push(...d.push(Buffer.from("\x1b[200~no end")));
    await wait(200);
    got.push(...d.push(Buffer.from("j")));
    check("an unclosed paste times out, and keys are keys again", got.map((k) => k.name === "paste" ? `paste:${k.text}` : k.name), ["paste:no end", "j"]);
    check("a ZWJ between letters is no wider", scr.displayWidth("ab\u200dcd"), 4);
    check("a joined emoji is still two", scr.displayWidth("\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67"), 2);
  }

  section("delphi open with no terminal refuses cleanly");
  {
    const r = spawnSync(process.execPath, [CLI, "open", "42"], {
      encoding: "utf8", input: "", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 20000,
    });
    check("exit 1", r.status, 1);
    check("nothing on stdout, not even an escape code", r.stdout, "");
    check("says why and what to use instead", /open needs a terminal.*delphi cat/.test(r.stderr), true);
    check("no escape codes on stderr either", /\x1b/.test(r.stderr), false);
    const help = spawnSync(process.execPath, [CLI, "help", "open"], { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    check("help open", help.stdout.startsWith("delphi open <task>"), true);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
