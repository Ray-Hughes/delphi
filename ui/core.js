// The helpers every renderer script shares.
//
// Loaded by index.html before app.js and every ui/ module. They are classic
// scripts, so a top-level const here is a global the others call by name: app.js
// kept its calls to $ and el unchanged when these moved out of it. Nothing here
// reads the store or talks to the main process; a module that needs data asks
// window.delphi itself.
//
// Under Node (tools/commands_test.js) there is no document, and only the pure
// helpers are used.

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) {
    if (k == null) continue;
    node.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return node;
};

/**
 * A colour from the database, fit to put in a style attribute, or the
 * fallback. Project and epic colours are written by agents over MCP, and a
 * value such as "red; background-image: url(...)" would otherwise carry CSS of
 * its choosing into the window. Only a hex value, a var() token, or a bare
 * colour name gets through.
 */
const safeColour = (value, fallback = "var(--ink-faint)") => {
  const v = String(value == null ? "" : value).trim();
  return /^#[0-9a-f]{3,8}$/i.test(v) || /^var\(--[a-z0-9-]+\)$/i.test(v) || /^[a-z]{3,20}$/i.test(v) ? v : fallback;
};

/**
 * The platform the window runs on, from the preload (process.platform), which
 * is there before any page script runs. navigator.platform only as a fallback,
 * for a page opened outside Electron.
 */
const PLATFORM = (() => {
  try { if (globalThis.window && window.delphi && window.delphi.platform) return window.delphi.platform; } catch {}
  try { return /Mac/i.test(globalThis.navigator.platform) ? "darwin" : "other"; } catch { return "other"; }
})();
const isMac = () => PLATFORM === "darwin";

/**
 * The command modifier, held alone: Cmd on macOS and Ctrl everywhere else.
 * Never either on either. On macOS Ctrl+K, Ctrl+P and Ctrl+F are the text
 * system's own (kill to the end of the line, up a line, forward a character),
 * and a shortcut that answered to them would eat those keys in every box.
 */
const modKey = (e, mac = isMac()) => (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

/** How that modifier is written on a key cap or in a tooltip. */
const modLabel = (mac = isMac()) => (mac ? "\u2318" : "Ctrl");
/** A shortcut as this platform writes it: "⌘K" on a Mac, "Ctrl+K" elsewhere. */
const shortcut = (key, mac = isMac()) => (mac ? `\u2318${key}` : `Ctrl+${key}`);

/**
 * A path with the home folder written as ~, on every platform's layout: macOS
 * /Users/name, Linux /home/name (and /root), Windows C:\Users\name. Only a
 * whole folder name: /Users/ann is ~, /Users/annabel/x is not ~bel/x.
 */
const tilde = (path) => String(path || "").replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=[\\/]|$)/i, "~");

/**
 * The pointing hand on rows and chips that only have an onclick assigned after
 * they were made, which no stylesheet selector can see. On the way up from
 * whatever the pointer is over, the first element with an onclick gets
 * .has-click, once; styles/pointer.css turns that into the hand, and gives the
 * arrow back while it is disabled or busy. Only in a window: this file is also
 * loaded by tests under plain Node.
 */
if (typeof document !== "undefined") {
  const isBackdrop = (node) => {
    if (getComputedStyle(node).position !== "fixed") return false;
    const r = node.getBoundingClientRect();
    return r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9;
  };
  document.addEventListener("mouseover", (e) => {
    for (let node = e.target; node && node !== document.body && node.nodeType === 1; node = node.parentElement) {
      if (node.dataset.pointerChecked) return;
      // A dialog's backdrop closes on a click that lands on the backdrop
      // itself, so it carries an onclick, but nothing inside it is clickable
      // for that reason. A fixed layer covering the window is a backdrop:
      // stop there, and never pass the hand down to what it holds.
      if (node.classList.contains("overlay") || isBackdrop(node)) return;
      if (typeof node.onclick === "function") {
        node.dataset.pointerChecked = "1";
        node.classList.add("has-click");
        return;
      }
    }
  }, { passive: true });
}

if (typeof module !== "undefined" && module.exports) module.exports = { $, el, safeColour, PLATFORM, isMac, modKey, modLabel, shortcut, tilde };
