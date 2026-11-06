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

if (typeof module !== "undefined" && module.exports) module.exports = { $, el, safeColour };
