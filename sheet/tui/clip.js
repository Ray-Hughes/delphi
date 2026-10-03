/**
 * Putting text on the clipboard from a terminal program.
 *
 * OSC 52 first: an escape sequence asking the terminal itself to set the
 * clipboard. It works in iTerm2, kitty, WezTerm, Windows Terminal, foot and
 * tmux with set-clipboard, and it works over SSH, where a local pbcopy would
 * put the text on the wrong machine. But a terminal that does not support it
 * says nothing, so the local tool runs as well whenever one exists, and the
 * result says which routes were taken.
 *
 * Tools are spawned with an argv and the text on stdin. Nothing goes through a
 * shell, so nothing in the text is ever read as a command.
 */

const { spawn } = require("child_process");

/** The OSC 52 sequence for text. Pure. tmux needs it wrapped to pass it on. */
function osc52(text, { tmux = false } = {}) {
  const body = `\x1b]52;c;${Buffer.from(String(text), "utf8").toString("base64")}\x07`;
  if (!tmux) return body;
  // Inside tmux's passthrough every ESC is doubled.
  return `\x1bPtmux;${body.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

/** Local clipboard tools to try, in order, for this platform. */
function candidates(platform = process.platform, env = process.env) {
  if (platform === "darwin") return [{ via: "pbcopy", argv: ["pbcopy"] }];
  if (platform === "win32") return [{ via: "clip.exe", argv: ["clip.exe"] }];
  const list = [];
  // WSL: the Windows clipboard is the one the person pastes from.
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) list.push({ via: "clip.exe", argv: ["clip.exe"] });
  if (env.WAYLAND_DISPLAY) list.push({ via: "wl-copy", argv: ["wl-copy"] });
  if (env.DISPLAY) list.push({ via: "xclip", argv: ["xclip", "-selection", "clipboard"] });
  return list;
}

// pbcopy decides how to read its input from the locale, and in a C or POSIX
// locale (an ssh session, a launchd job, a bare env) it reads bytes as Mac
// Roman and the clipboard gets mojibake. The text is always UTF-8, so it says so.
const UTF8_ENV = { LANG: "en_US.UTF-8", LC_CTYPE: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };

// Past this, OSC 52 is not attempted: terminals that take it at all cap it
// (some at 100 KB), and pushing megabytes of base64 at one stalls it.
const OSC52_MAX = 1024 * 1024;

function pipeTo(argv, text, { timeoutMs = 3000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "ignore", "ignore"], windowsHide: true, env });
    } catch {
      resolve(false);
      return;
    }
    // xclip and wl-copy stay running to serve the selection; they have taken
    // the text once stdin closes, so a timeout is success for them, not failure.
    const timer = setTimeout(() => resolve(true), timeoutMs);
    if (timer.unref) timer.unref();
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
    child.stdin.on("error", () => {});
    child.stdin.end(String(text));
  });
}

/**
 * Copies text. Returns { via } naming what carried it: "osc52+pbcopy" when
 * both, a tool name when only that, "osc52" when only the terminal was asked.
 * OSC 52 is skipped when out is not a terminal, where it would just be noise.
 */
async function copy(text, { out = process.stdout, env = process.env, platform = process.platform, run = pipeTo } = {}) {
  let sent = false;
  if (out && out.isTTY && env.DELPHI_NO_OSC52 !== "1" && Buffer.byteLength(String(text)) <= OSC52_MAX) {
    try { out.write(osc52(text, { tmux: Boolean(env.TMUX) })); sent = true; } catch {}
  }
  for (const c of candidates(platform, env)) {
    if (await run(c.argv, text, { env: c.via === "pbcopy" ? { ...process.env, ...env, ...UTF8_ENV } : { ...process.env, ...env } })) return { via: sent ? `osc52+${c.via}` : c.via };
  }
  return { via: sent ? "osc52" : null };
}

module.exports = { osc52, copy, candidates, OSC52_MAX, UTF8_ENV };
