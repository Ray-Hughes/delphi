// Settings, as a panel that floats over the window.
//
// Every row here is drawn from settings/schema.js, the one list of settings,
// and saved through settings:set, which checks it against the same list. So
// the form, the search, "changed from default", reset, export and the Cmd+K
// entries cannot disagree with what the main process will accept: they are all
// read off the same entries. The few sections that are not settings (agents,
// backups, where the data lives) are panels of their own, painted here from the
// IPC that already serves them, reusing app.js's harness sheet and trust row and
// ui/backups.js's list rather than drawing second copies.
//
// It floats in the same window rather than opening a second one, because a
// second BrowserWindow would need its own page and preload, and settings kept
// in step across two renderers. Focus is kept inside it while it is open, and
// Esc clears the search or closes it.
//
// The old Settings page stays reachable (Advanced, and Cmd+K) until the
// cleanup slice, for the panels that have not moved here yet.

globalThis.DelphiSettingsPanel = (() => {
  const SS = globalThis.DelphiSettingsSchema;
  // ui/core.js's isMac(), read once: the platform does not change while open.
  const MAC = isMac();

  // The icons Direction B's set (ui/icons.js) does not have yet, in its own
  // grid and stroke, so they sit beside the others unseen.
  const SVG = "http://www.w3.org/2000/svg";
  const SHAPES = {
    palette: [["circle", { cx: "12", cy: "12", r: "8.5" }], ["circle", { cx: "8.5", cy: "10", r: "1.1", fill: "currentColor", stroke: "none" }], ["circle", { cx: "12", cy: "7.5", r: "1.1", fill: "currentColor", stroke: "none" }], ["circle", { cx: "15.5", cy: "10", r: "1.1", fill: "currentColor", stroke: "none" }], ["path", { d: "M12 20.5a2 2 0 0 1 0-4h1.5a2.5 2.5 0 0 0 2.5-2.5" }]],
    keyboard: [["rect", { x: "2.5", y: "6", width: "19", height: "12", rx: "2.5" }], ["path", { d: "M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9" }]],
    shield: [["path", { d: "M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6z" }]],
    db: [["ellipse", { cx: "12", cy: "6", rx: "7.5", ry: "3" }], ["path", { d: "M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" }]],
    lock: [["rect", { x: "5", y: "10.5", width: "14", height: "10", rx: "2.5" }], ["path", { d: "M8 10.5V8a4 4 0 0 1 8 0v2.5" }]],
    wrench: [["path", { d: "M14.5 6.5a4 4 0 0 0 5 5l-8.8 8.8a2.1 2.1 0 0 1-3-3z" }], ["path", { d: "M14.5 6.5a4 4 0 0 1 5-3l-2.5 2.5.5 2 2 .5 2.5-2.5a4 4 0 0 1-3 5" }]],
    info: [["circle", { cx: "12", cy: "12", r: "8.5" }], ["path", { d: "M12 11v5.5M12 7.5h.01" }]],
    reset: [["path", { d: "M4 12a8 8 0 1 0 2.4-5.7" }], ["path", { d: "M4 4v4.5h4.5" }]],
    copy: [["rect", { x: "8.5", y: "8.5", width: "12", height: "12", rx: "2.5" }], ["path", { d: "M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" }]],
    ext: [["path", { d: "M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" }]],
    filter: [["path", { d: "M4 5h16l-6 7.5V19l-4 1.5v-8z" }]],
    file: [["path", { d: "M14 3H6.5A2.5 2.5 0 0 0 4 5.5v13A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V9z" }], ["path", { d: "M14 3v6h6" }]],
    up: [["path", { d: "m6 15 6-6 6 6" }]],
    upload: [["path", { d: "M12 16V4M7 9l5-5 5 5M4.5 16.5v2A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-2" }]],
  };
  function I(name, size = "") {
    if (!SHAPES[name] && globalThis.DelphiIcons) return DelphiIcons.icon(name, size);
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", `i${size ? ` ${size}` : ""}`);
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of SHAPES[name] || []) {
      const node = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      svg.append(node);
    }
    return svg;
  }
  const kbd = (text) => el("kbd", { textContent: text });

  // What app.js lends: { state, saved(settings, fields), openOld(anchor),
  // openProject(id), harnessSheet(h, done), trustRow(h, repaint), go(target),
  // commands() }. Set by init(); every use is guarded, so the panel still opens
  // in a test page that lends nothing.
  let lent = {};
  let P = null;

  // --- the look ------------------------------------------------------------

  /** A hex fill as rgba with an alpha, for the soft and line variants. */
  const alpha = (hex, a) => {
    const h = hex.replace("#", "");
    return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${a})`;
  };
  const lum = (hex) => {
    const h = hex.replace("#", "");
    const f = (i) => { const c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4);
  };
  const ratioOnWhite = (hex) => 1.05 / (lum(hex) + 0.05);

  /**
   * The accent, density and text size. The theme is app.js's applyTheme,
   * which this does not touch.
   *
   * The accent is written as a stylesheet rather than as properties on the
   * root, because each theme needs its own pair and "System" switches between
   * them live: the same three selectors styles/tokens.css uses, later in the
   * document, so they win at equal specificity. --btn-primary (white text's
   * ground) is the fill itself, which every curated fill passes 4.5:1 under. From the schema's palette only,
   * never from the value as stored, so nothing typed into settings.json can
   * carry CSS of its own in.
   */
  function applyLook(settings) {
    const s = settings || {};
    const root = document.documentElement;
    const a = SS.ACCENTS.find((x) => x.id === s.accent) || SS.ACCENTS[0];
    let tag = document.getElementById("delphi-accent");
    if (!tag) { tag = document.createElement("style"); tag.id = "delphi-accent"; document.head.append(tag); }
    const vars = ([fill, ink], dark) =>
      `--accent: ${fill}; --accent-ink: ${ink}; --btn-primary: ${fill}; --accent-soft: ${alpha(fill, dark ? 0.16 : 0.10)}; --accent-line: ${alpha(fill, dark ? 0.5 : 0.38)};`;
    tag.textContent = `:root { ${vars(a.light, false)} }\n`
      + `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${vars(a.dark, true)} } }\n`
      + `:root[data-theme="dark"] { ${vars(a.dark, true)} }`;
    if (s.density && s.density !== "comfortable" && SS.BY_KEY.density.choices.some(([c]) => c === s.density)) root.dataset.density = s.density;
    else delete root.dataset.density;
    const size = Number(s.fontSize);
    root.style.zoom = Number.isInteger(size) && size >= 12 && size <= 16 && size !== 13 ? String(size / 13) : "";
  }

  // --- values --------------------------------------------------------------

  const val = (key) => (P && P.settings && key in P.settings ? P.settings[key] : SS.BY_KEY[key].default);
  const listed = () => SS.SETTINGS.filter((s) => !s.internal);
  const modified = () => listed().filter((s) => SS.isModified(s.key, val(s.key)));
  const sectionOf = (id) => SS.SECTIONS.find((x) => x.id === id) || SS.SECTIONS[0];

  /** An accelerator as keycaps: Control+Shift+T as the three a Mac shows. */
  function capsOf(accel) {
    const map = { Command: "⌘", Cmd: "⌘", CommandOrControl: MAC ? "⌘" : "Ctrl", CmdOrCtrl: MAC ? "⌘" : "Ctrl", Control: MAC ? "⌃" : "Ctrl", Ctrl: MAC ? "⌃" : "Ctrl", Alt: MAC ? "⌥" : "Alt", Option: "⌥", Shift: "⇧", Super: MAC ? "⌘" : "Win", Meta: MAC ? "⌘" : "Win" };
    return String(accel || "").split("+").filter(Boolean).map((p) => map[p] || p);
  }
  /** A value as the panel shows it: a shortcut as its keycaps, the rest as the schema says. */
  const shown = (key, v) => (SS.BY_KEY[key] && SS.BY_KEY[key].type === "shortcut" ? capsOf(v).join(" ") : SS.describe(key, v));
  const keysEl = (accel) => el("span", { className: "sp-caps" }, ...capsOf(accel).map(kbd));

  /** Words from what was typed, and whether it asked for changed settings only. */
  function parseQuery(q) {
    const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    return { mod: words.includes("@modified"), words: words.filter((w) => w !== "@modified") };
  }

  // --- the shortcuts inside the window -------------------------------------

  // Read from the same places the keys are bound (main.js's menu, ui/keys.js
  // and the command registry), so the list says what the window does. Not
  // settings: only the show and hide shortcut can be changed.
  function shortcuts() {
    const rows = [
      { group: "In the window", label: "Search, jump or run a command", keys: "CmdOrCtrl+K" },
      { group: "In the window", label: "Switch project", keys: "CmdOrCtrl+P" },
      { group: "In the window", label: "New task", keys: "CmdOrCtrl+N" },
      { group: "In the window", label: "New note", keys: "CmdOrCtrl+Shift+N" },
      { group: "In the window", label: "New project", keys: "CmdOrCtrl+Shift+P" },
      { group: "In the window", label: "Settings", keys: "CmdOrCtrl+," },
      { group: "In the window", label: "Search everything", keys: "CmdOrCtrl+F", note: "in Settings, searches settings" },
      { group: "In the window", label: "Back", keys: "CmdOrCtrl+[" },
      { group: "In the window", label: "What's new, Tasks, Memory, History", keys: "CmdOrCtrl+1", to: "CmdOrCtrl+4" },
      { group: "In the window", label: "Quit Delphi", keys: "CmdOrCtrl+Q" },
    ];
    const tabs = globalThis.DelphiCommands ? DelphiCommands.TABS : [];
    for (const t of tabs) rows.push({ group: "Go to", label: t.label, chord: t.chord });
    rows.push({ group: "Go to", label: "Needs you", chord: "i" });
    rows.push(
      { group: "In lists", label: "Next and previous row", plain: ["J", "K"] },
      { group: "In lists", label: "Open the row", plain: ["Enter"] },
      { group: "In lists", label: "Edit its title", plain: ["E"] },
      { group: "In lists", label: "Focus on it", plain: ["F"] },
      { group: "In Settings", label: "Search settings", keys: "CmdOrCtrl+F" },
      { group: "In Settings", label: "Move between sections", plain: ["↑", "↓"] },
      { group: "In Settings", label: "Clear the search, then close", plain: ["Esc"] });
    return rows;
  }
  /** The in-window accelerators, lower case with CmdOrCtrl resolved, for conflicts. */
  const norm = (accel) => String(accel || "").split("+").map((p) => {
    const l = p.toLowerCase();
    if (["commandorcontrol", "cmdorctrl"].includes(l)) return MAC ? "command" : "control";
    if (l === "cmd") return "command";
    if (l === "ctrl") return "control";
    if (l === "option") return "alt";
    return l;
  }).sort().join("+");
  function conflictOf(accel) {
    const n = norm(accel);
    const hit = shortcuts().find((r) => r.keys && norm(r.keys) === n);
    return hit ? hit.label : null;
  }

  /** The accelerator a key press spells, or null while only modifiers are down. */
  function accelOf(e) {
    const code = e.code || "";
    let key = null;
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit\d$/.test(code)) key = code.slice(5);
    else if (/^F\d{1,2}$/.test(code)) key = code;
    else {
      key = ({ Space: "Space", Enter: "Return", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Escape: null,
        ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
        Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`" })[code] ?? null;
    }
    if (!key) return null;
    const mods = [];
    if (e.metaKey) mods.push(MAC ? "Command" : "Super");
    if (e.ctrlKey) mods.push("Control");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (!mods.length && !/^F\d/.test(key)) return { accel: null, why: "Hold at least one of Command, Control, Option or Shift, so typing a letter never shows Delphi." };
    return { accel: [...mods, key].join("+") };
  }

  // --- saving --------------------------------------------------------------

  /**
   * One write. Asks first when the schema says the new value needs a yes,
   * shows a refusal on the row it came from, and repaints from what the main
   * process kept, which is the only version that is true.
   */
  async function save(fields, { confirmed = false } = {}) {
    if (!P) return false;
    if (!confirmed) {
      for (const [key, value] of Object.entries(fields)) {
        if (!SS.needsConfirm(key, value)) continue;
        const s = SS.BY_KEY[key];
        const ok = await ask({ title: s.danger.title, body: s.danger.body, bullets: s.notChanged ? [`Does not change: ${s.notChanged}`] : [], confirm: s.danger.confirm, kind: "danger" });
        if (!ok) { repaint(); return false; }
      }
    }
    let saved;
    try {
      saved = await window.delphi.settings.set(fields);
    } catch (error) {
      if (!P) return false;
      for (const key of Object.keys(fields)) P.errors[key] = String(error.message || error);
      status(String(error.message || error), "crit");
      repaint();
      return false;
    }
    // The window takes the change even if the panel closed while it was saving.
    applyLook(saved);
    if (lent.saved) lent.saved(saved, fields);
    if (!P) return true;
    // settings:get adds the username prefix a branch defaults to; a set does not.
    P.settings = { workbenchBranchPrefixDefault: P.settings && P.settings.workbenchBranchPrefixDefault, ...saved };
    for (const key of Object.keys(fields)) delete P.errors[key];
    status(fields.panelMode !== undefined ? "Saved. The window is being rebuilt." : "Saved.", "good");
    repaint();
    return true;
  }
  const reset = (s) => save({ [s.key]: SS.BY_KEY[s.key].default });

  function status(text, kind = "") {
    if (!P) return;
    P.saved.className = `saved ${kind}`.trim();
    P.saved.textContent = "";
    P.saved.append(kind === "good" ? I("check", "xs") : kind === "crit" ? I("alert", "xs") : "", text);
    clearTimeout(P.statusTimer);
    P.statusTimer = setTimeout(() => { if (P) idleStatus(); }, 5000);
  }
  function idleStatus() {
    P.saved.className = "saved";
    P.saved.textContent = "";
    P.saved.append(I("check", "xs"), "Saved as you change it. Reset puts back one setting.");
  }

  // --- a question over the panel -------------------------------------------

  /** A yes or no, with Cancel focused and Esc meaning no. Resolves true or false. */
  function ask({ title, body, bullets = [], confirm = "Continue", cancel = "Cancel", kind = "danger", extra = null }) {
    return new Promise((resolve) => {
      const returnTo = document.activeElement;
      const scrim = el("div", { className: "sp-dlg-scrim" });
      const box = el("div", { className: "sp-dlg", role: "alertdialog" });
      box.setAttribute("aria-modal", "true");
      const titleId = `sp-dlg-${Date.now()}`;
      box.setAttribute("aria-labelledby", titleId);
      const no = el("button", { className: "sp-btn", type: "button" }, cancel, kbd("Esc"));
      const yes = el("button", { className: `sp-btn ${kind === "danger" ? "danger solid" : "primary"}`, type: "button", textContent: confirm });
      const done = (answer) => {
        document.removeEventListener("keydown", onKey, true);
        scrim.remove();
        if (P) P.dialog = false;
        if (returnTo && returnTo.isConnected) returnTo.focus({ preventScroll: true });
        resolve(answer);
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
        else if (e.key === "Tab") {
          e.preventDefault(); e.stopPropagation();
          const all = [...box.querySelectorAll("button, input, select")].filter((n) => !n.disabled);
          const at = all.indexOf(document.activeElement);
          all[(at + (e.shiftKey ? -1 : 1) + all.length) % all.length].focus();
        } else e.stopPropagation();
      };
      no.onclick = () => done(false);
      yes.onclick = () => done(true);
      scrim.onmousedown = (e) => { if (e.target === scrim) done(false); };
      box.append(
        el("div", { className: "dh" },
          el("span", { className: `ic${kind === "danger" ? "" : " info"}` }, I(kind === "danger" ? "shield" : "info")),
          el("div", {},
            el("h3", { id: titleId, textContent: title }),
            body ? el("p", { textContent: body }) : null,
            bullets.length ? el("ul", {}, ...bullets.map((b) => el("li", {}, b))) : null,
            extra)),
        el("div", { className: "df" }, no, yes));
      scrim.append(box);
      document.body.append(scrim);
      if (P) P.dialog = true;
      document.addEventListener("keydown", onKey, true);
      no.focus();
    });
  }

  // --- controls ------------------------------------------------------------

  function toggle(s, on, onChange) {
    const b = el("button", { className: `sp-toggle${s && s.danger ? " care" : ""}`, type: "button", role: "switch" });
    b.setAttribute("aria-checked", String(Boolean(on)));
    if (s) b.setAttribute("aria-label", s.label);
    b.onclick = () => onChange(!on);
    return b;
  }

  function seg(s, value, onPick) {
    const g = el("div", { className: "sp-seg", role: "radiogroup" });
    g.setAttribute("aria-label", s.label);
    for (const [v, label] of s.choices) {
      const b = el("button", { type: "button", role: "radio", textContent: label });
      b.setAttribute("aria-checked", String(v === value));
      b.tabIndex = v === value ? 0 : -1;
      b.onclick = () => onPick(v);
      g.append(b);
    }
    // Arrow keys move the choice, as a radio group's do.
    g.onkeydown = (e) => {
      if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
      e.preventDefault();
      const at = s.choices.findIndex(([v]) => v === value);
      const next = s.choices[(at + (e.key === "ArrowRight" ? 1 : -1) + s.choices.length) % s.choices.length][0];
      onPick(next);
    };
    return g;
  }

  function select(s, value, options, onPick) {
    const wrap = el("label", { className: "sp-field" });
    const sel = el("select", {});
    sel.setAttribute("aria-label", s.label);
    for (const [v, label] of options) sel.append(el("option", { value: String(v ?? ""), textContent: label, selected: String(v ?? "") === String(value ?? "") }));
    sel.onchange = () => onPick(sel.value);
    wrap.append(sel);
    return wrap;
  }

  function number(s, value, onSet, { label = null, min = s.min, max = s.max, unit = s.unit } = {}) {
    const wrap = el("label", { className: `sp-field${P.errors[s.key] ? " bad" : ""}` });
    if (label) wrap.append(el("span", { className: "lab", textContent: label }));
    const input = el("input", { type: "number", min: String(min), max: String(max), step: "1", value: String(value ?? "") });
    input.setAttribute("aria-label", label ? `${s.label}: ${label}` : s.label);
    input.onchange = () => onSet(input.value);
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } };
    wrap.append(input);
    if (unit) wrap.append(el("span", { className: "u", textContent: unit }));
    return wrap;
  }

  function text(s, value, onSet, placeholder = s.placeholder || "") {
    const wrap = el("label", { className: `sp-field${P.errors[s.key] ? " bad" : ""}` });
    const input = el("input", { type: "text", value: value || "", placeholder, spellcheck: false, autocomplete: "off" });
    input.setAttribute("aria-label", s.label);
    input.onchange = () => onSet(input.value);
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } };
    wrap.append(input);
    return wrap;
  }

  /** The control a schema type gets, unless its section draws its own. */
  function control(s) {
    const v = val(s.key);
    const set = (x) => save({ [s.key]: x });
    switch (s.type) {
      case "bool": return toggle(s, v === true, set);
      case "enum": return s.choices.length <= 3 ? seg(s, v, set) : select(s, v, s.choices, set);
      case "int": return number(s, v, set);
      case "text": return text(s, v, set);
      case "branchPrefix": return text(s, v, set, (P.settings && P.settings.workbenchBranchPrefixDefault) || "your username");
      case "projectId": {
        const projects = (lent.state && lent.state().projects) || [];
        return select(s, v, [["", "No default, let the agent choose"], ...projects.map((p) => [p.id, p.name])], (x) => set(x === "" ? null : Number(x)));
      }
      case "harnessKey": {
        const rows = (P.harnesses || []).filter((h) => h.enabled);
        const opts = rows.map((h) => [h.key, h.label]);
        if (!opts.some(([k]) => k === v)) opts.unshift([v, `${v} (not set up here)`]);
        return select(s, v, opts, set);
      }
      case "harnessLimits": return harnessLimits(s, v);
      case "path": return vaultPath(s, v);
      case "shortcut": return recorder(s, v);
      default: return el("span", { className: "hint", textContent: shown(s.key, v) });
    }
  }

  function harnessLimits(s, v) {
    const box = el("div", { className: "c" });
    const rows = (P.harnesses || []).filter((h) => h.enabled);
    if (!rows.length) return el("span", { className: "hint", textContent: P.harnesses ? "No agents are on." : "Looking for agents..." });
    for (const h of rows) {
      const now = v && h.key in v ? v[h.key] : 1;
      box.append(number(s, now, (x) => {
        // The whole map, as the main process stores it: an agent left at 1 is
        // left out, which is what 1 already means.
        const next = { ...(v || {}) };
        const n = Number(x);
        if (n === 1) delete next[h.key]; else next[h.key] = x;
        return save({ [s.key]: next });
      }, { label: h.label.replace(/^GitHub /, ""), unit: "" }));
    }
    return box;
  }

  function vaultPath(s, v) {
    const box = el("div", { className: "c" });
    const where = homeShort(v || (P.doctor && P.doctor.vaultPath) || "") || "the default folder";
    box.append(el("span", { className: "sp-field path", title: where, textContent: where }));
    const pick = el("button", { className: "sp-btn sm", type: "button", textContent: "Choose..." });
    pick.onclick = async () => {
      let chosen = null;
      try { chosen = await window.delphi.dialog.pickFolder("Choose the vault folder", { buttonLabel: "Use this folder", defaultPath: v || undefined }); } catch (error) { status(String(error.message || error), "crit"); }
      if (chosen) save({ [s.key]: chosen });
    };
    box.append(pick);
    return box;
  }

  /** The show and hide shortcut: press Record, then the keys. */
  function recorder(s, v) {
    const box = el("div", { className: "c" });
    if (P.rec && P.rec.key === s.key) {
      const live = el("span", { className: "sp-binding rec", role: "status" });
      live.setAttribute("aria-live", "polite");
      if (P.rec.accel) live.append(keysEl(P.rec.accel)); else live.append("Press the keys...");
      const cancel = el("button", { className: "sp-x sm", type: "button", title: "Cancel (Esc)" }, I("x", "sm"));
      cancel.setAttribute("aria-label", "Cancel recording");
      cancel.onclick = () => { P.rec = null; repaint(); };
      box.append(live, cancel);
      return box;
    }
    box.append(el("span", { className: "sp-binding", title: v }, keysEl(v)));
    const rec = el("button", { className: "sp-btn sm", type: "button", textContent: "Record" });
    rec.onclick = () => { P.rec = { key: s.key, accel: null, conflict: null, why: null }; repaint(); };
    box.append(rec);
    return box;
  }

  /** A recorded shortcut, checked against the window's own before it is kept. */
  async function recorded(accel) {
    const clash = conflictOf(accel);
    if (clash) { P.rec = { ...P.rec, accel, conflict: clash }; repaint(); return; }
    P.rec = null;
    await save({ hotkey: accel });
  }

  // --- rows and groups -----------------------------------------------------

  function resetButton(s) {
    const b = el("button", { className: "sp-rst", type: "button", title: `Back to ${shown(s.key, s.default)}` }, I("reset", "xs"), "Reset");
    b.setAttribute("aria-label", `Reset ${s.label} to ${shown(s.key, s.default)}`);
    b.onclick = () => reset(s);
    return b;
  }

  function range(s) {
    if (s.rangeLabel) return ` ${s.rangeLabel}.`;
    if (s.type === "int") return ` ${s.min} to ${s.max}${s.unit === "px" ? "" : ` ${s.unit === "an hour" ? "" : s.unit}`}.`.replace(/ +\./, ".");
    if (s.type === "harnessLimits") return ` ${s.min} to ${s.max}.`;
    return "";
  }

  /** A setting's row: name, sentence, what it leaves alone, and its control. */
  function row(s, { controlEl = null, block = false, after = [] } = {}) {
    const v = val(s.key);
    const r = el("div", { className: `sp-row${SS.isModified(s.key, v) ? " mod" : ""}${block ? " block" : ""}` });
    r.dataset.key = s.key;
    const l = el("div", { className: "l" });
    l.append(el("div", { className: "n" }, s.label));
    l.append(el("div", { className: "d", textContent: s.desc + range(s) }));
    if (s.notChanged) l.append(el("div", { className: "nc", textContent: `Does not change: ${s.notChanged}` }));
    if (P.errors[s.key]) l.append(el("div", { className: "err", role: "alert", textContent: P.errors[s.key] }));
    const c = el("div", { className: "c" });
    if (SS.isModified(s.key, v)) c.append(resetButton(s));
    if (!block) c.append(controlEl || control(s));
    if (block) {
      const top = el("div", { style: "display:flex;align-items:flex-start;gap:16px" }, l, c);
      r.append(top, ...(controlEl ? [controlEl] : []));
    } else {
      r.append(l, c);
    }
    for (const a of after) if (a) r.append(a);
    return r;
  }

  function group(label, rows, { care = false } = {}) {
    const g = el("div", { className: "sp-group" });
    g.append(el("div", { className: `gl${care ? " care" : ""}` }, care ? I("alert", "xs") : null, label));
    const card = el("div", { className: `sp-card${care ? " care" : ""}` });
    for (const r of rows.flat()) if (r) card.append(r);
    g.append(card);
    return g;
  }

  /** The section's settings in their groups, the ones that need care last. */
  function schemaGroups(section, { except = [], custom = {} } = {}) {
    const out = [];
    const entries = SS.SETTINGS.filter((s) => s.section === section && !except.includes(s.key));
    const groups = [...new Set(entries.map((s) => s.group))];
    for (const g of groups) {
      out.push(group(g, entries.filter((s) => s.group === g).map((s) => (custom[s.key] ? custom[s.key](s) : row(s)))));
    }
    return out;
  }

  /** A row that is not a setting: a fact, an action, a link. */
  function infoRow(label, desc, ...controls) {
    const r = el("div", { className: "sp-row" });
    const l = el("div", { className: "l" }, el("div", { className: "n" }, label));
    if (desc) l.append(el("div", { className: "d" }, desc));
    r.append(l, el("div", { className: "c" }, ...controls));
    return r;
  }
  const btn = (label, onClick, cls = "") => {
    const b = el("button", { className: `sp-btn sm ${cls}`.trim(), type: "button" });
    b.append(...[].concat(label));
    b.onclick = onClick;
    return b;
  };
  const tag = (label, kind = "plain") => el("span", { className: `sp-tag ${kind}`, textContent: label });
  const copyBtn = (value) => btn([I("copy", "xs"), "Copy"], async (e) => {
    try { await navigator.clipboard.writeText(value); e.currentTarget.lastChild.textContent = "Copied"; } catch {}
  });

  // --- the sections --------------------------------------------------------

  const harnessInitials = (h) => ({ "claude-code": "CC", codex: "Cx", copilot: "Co" })[h.key] || (h.label || "?").slice(0, 2);
  const harnessClass = (h) => ({ "claude-code": "claude", codex: "codex", copilot: "copilot" })[h.key] || "custom";
  const homeShort = (p) => tilde(p);

  const PAINT = {
    overview(root) {
      const d = P.doctor;
      const hs = P.harnesses;
      const tile = (icon, k, ok, v, s, { mono = false, smono = false } = {}) => el("div", { className: "sp-tile" },
        el("div", { className: "k" }, I(icon, "xs"), k),
        el("div", { className: `v${mono ? " mono" : ""}` }, ok == null ? null : el("span", { className: `ic ${ok === true ? "good" : ok === "warn" ? "warn" : "crit"}` }, I(ok === true ? "check" : "alert", "sm")), v),
        s ? el("div", { className: `s${smono ? " mono" : ""}`, textContent: s }) : null);
      const tiles = el("div", { className: "sp-tiles" });
      if (!d) tiles.append(tile("db", "Database", null, "Checking...", ""));
      else {
        const ready = hs ? hs.filter((h) => h.enabled && h.ready) : [];
        const on = hs ? hs.filter((h) => h.enabled) : [];
        const off = hs ? hs.filter((h) => !h.enabled).map((h) => h.label) : [];
        const lb = d.lastBackup;
        tiles.append(
          tile("db", "Database", true, "Open", homeShort(d.dbPath), { smono: true }),
          tile("info", "Database id", true, String(d.dbId || "").slice(0, 8), "Agents launched from here are told this id, and refuse any other database.", { mono: true }),
          tile("sparkle", "Agents", hs ? (ready.length === on.length && on.length ? true : "warn") : null,
            hs ? `${ready.length} of ${hs.length} ready` : "Looking...",
            hs ? [ready.map((h) => h.label).join(", "), off.length ? `${off.join(", ")} ${off.length === 1 ? "is" : "are"} off.` : ""].filter(Boolean).join(". ") : ""),
          tile("shield", "Guard", d.guard && d.guard.installed ? true : "warn",
            d.guard && d.guard.installed ? "Wired into Claude Code" : "Not wired in",
            d.guard && d.guard.installed ? "Copilot and Codex commands are not seen by it." : "agent/guard.py is not a PreToolUse hook in ~/.claude/settings.json, so unattended runs are unguarded."),
          tile("clock", "Last backup", lb ? true : "warn", lb ? when(lb.at) : "None yet", lb ? `${lb.kind === "daily" ? "Daily" : "Named"}, ${d.backupCount} kept. ${size(lb.size)}.` : "The first one is taken a few seconds after Delphi starts."),
          d.checkoutDbIgnored
            ? tile("alert", "Checkout database", "warn", "Ignored", `${homeShort(d.checkoutDbIgnored)} exists and is never opened.`)
            : tile("file", "Found by", true, d.resolvedBy === "default" ? "The per-user folder" : String(d.resolvedBy || ""), homeShort(d.dataDir), { smono: true }));
      }
      root.append(tiles);
      const mods = modified();
      const g = el("div", { className: "sp-group" }, el("div", { className: "gl" }, "Changed from default"));
      const card = el("div", { className: "sp-card" });
      if (!mods.length) card.append(el("div", { className: "sp-empty" }, el("span", { className: "ic" }, I("check", "sm")), "Nothing is changed from its default."));
      for (const s of mods) {
        const r = el("div", { className: "sp-row mod" });
        r.dataset.key = s.key;
        r.append(
          el("div", { className: "l" }, el("div", { className: "n", textContent: s.label }),
            el("div", { className: "d", textContent: `${sectionOf(s.section).label}. Now ${shown(s.key, val(s.key))}; default ${shown(s.key, s.default)}.` })),
          el("div", { className: "c" }, resetButton(s), btn(["Show", I("right", "xs")], () => jump(s.key), "")));
        card.append(r);
      }
      g.append(card);
      root.append(g);
    },

    general(root) { root.append(...schemaGroups("general")); },

    appearance(root) {
      root.append(livePreview());
      const theme = SS.BY_KEY.theme;
      const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      const cards = el("div", { className: "sp-themes", role: "radiogroup" });
      cards.setAttribute("aria-label", "Theme");
      const pane = (kind) => el("div", { className: `pane ${kind}` },
        el("div", { className: "tb" }, el("i", { className: "a" }), el("i")),
        el("div", { className: "bd" }, el("i", { style: "width:80%" }), el("i", { style: "width:55%" }), el("i", { className: "a", style: "width:40%" }), el("i", { style: "width:66%" })));
      for (const [v, label] of theme.choices) {
        const on = val("theme") === v;
        const b = el("button", { className: "sp-thm", type: "button", role: "radio" });
        b.setAttribute("aria-checked", String(on));
        b.tabIndex = on ? 0 : -1;
        b.append(
          el("div", { className: `shot${v === "system" ? " half" : ""}` }, ...(v === "system" ? [pane("light"), pane("dark")] : [pane(v)])),
          el("div", { className: "cap" }, el("span", { className: "sp-radio" }), label, v === "system" ? el("span", { className: "hint", textContent: `Now ${dark ? "dark" : "light"}` }) : null));
        b.onclick = () => save({ theme: v });
        cards.append(b);
      }
      cards.onkeydown = (e) => arrowRadio(e, theme.choices.map(([c]) => c), val("theme"), (x) => save({ theme: x }));
      const swatches = el("div", { className: "sp-swatches", role: "radiogroup" });
      swatches.setAttribute("aria-label", "Accent colour");
      const ids = SS.ACCENTS.map((a) => a.id);
      for (const a of SS.ACCENTS) {
        const on = val("accent") === a.id;
        const fill = document.documentElement.dataset.theme === "dark" || (document.documentElement.dataset.theme !== "light" && dark) ? a.dark[0] : a.light[0];
        const aa = Math.min(ratioOnWhite(a.light[0]), ratioOnWhite(a.dark[0]));
        const b = el("button", { className: "sp-sw", type: "button", role: "radio", title: `${a.label}: white text on it is ${aa.toFixed(1)} to 1 or better in both themes` });
        b.setAttribute("aria-checked", String(on));
        b.tabIndex = on ? 0 : -1;
        b.append(el("span", { className: "sw-dot", style: `background:${fill}` }, on ? I("check", "sm") : null), a.label, el("span", { className: "aa", textContent: `AA ${aa.toFixed(1)}` }));
        b.onclick = () => save({ accent: a.id });
        swatches.append(b);
      }
      swatches.onkeydown = (e) => arrowRadio(e, ids, val("accent"), (x) => save({ accent: x }));
      const size = SS.BY_KEY.fontSize;
      const slider = el("div", { className: "sp-range" });
      const input = el("input", { type: "range", min: String(size.min), max: String(size.max), step: "1", value: String(val("fontSize")) });
      input.setAttribute("aria-label", "Text size");
      input.setAttribute("aria-valuetext", `${val("fontSize")} pixels`);
      // Previewed while it moves, saved when it is let go, so dragging across
      // the scale is one write rather than five.
      input.oninput = () => applyLook({ ...P.settings, fontSize: Number(input.value) });
      input.onchange = () => save({ fontSize: Number(input.value) });
      const ticks = el("div", { className: "ticks" });
      for (let n = size.min; n <= size.max; n++) ticks.append(n === Number(val("fontSize")) ? el("b", { textContent: String(n) }) : el("span", { textContent: String(n) }));
      slider.append(input, ticks);
      root.append(
        group("Theme", [row(theme, { block: true, controlEl: cards })]),
        group("Accent", [row(SS.BY_KEY.accent, { block: true, controlEl: swatches })]),
        group("Text and spacing", [row(SS.BY_KEY.density), row(size, { controlEl: slider })]),
        ...schemaGroups("appearance", { except: ["theme", "accent", "density", "fontSize"] }));
    },

    shortcuts(root) {
      const s = SS.BY_KEY.hotkey;
      const after = [];
      if (P.rec && P.rec.why) after.push(el("div", { className: "warn", role: "alert" }, I("alert", "xs"), P.rec.why));
      const hotRow = row(s);
      const card = [hotRow];
      if (P.rec && P.rec.conflict) {
        const box = el("div", { className: "sp-conflict", role: "alert" },
          el("span", { className: "ic" }, I("alert", "sm")),
          el("div", { className: "grow" },
            el("div", { style: "display:flex;align-items:center;gap:6px;flex-wrap:wrap" }, keysEl(P.rec.accel), el("b", { textContent: `already opens ${P.rec.conflict} inside Delphi.` })),
            el("div", { className: "d", textContent: `As the system-wide shortcut it would take those keys from ${P.rec.conflict} while Delphi is in front. Nothing changes until you choose.` })),
          btn("Cancel", () => { P.rec = null; repaint(); }),
          btn("Record another", () => { P.rec = { key: s.key, accel: null }; repaint(); }),
          btn("Use it anyway", async () => { const a = P.rec.accel; P.rec = null; await save({ hotkey: a }); }, "danger"));
        card.push(box);
      }
      for (const a of after) hotRow.querySelector(".l").append(a);
      root.append(group("Everywhere", card));
      const rows = shortcuts();
      for (const g of [...new Set(rows.map((r) => r.group))]) {
        const table = el("table", { className: "sp-keys" });
        for (const r of rows.filter((x) => x.group === g)) {
          const k = el("td", { className: "k" });
          if (r.keys) { k.append(keysEl(r.keys)); if (r.to) k.append(el("span", { className: "then", textContent: "to" }), keysEl(r.to)); }
          else if (r.chord) k.append(kbd("G"), el("span", { className: "then", textContent: "then" }), kbd(r.chord.toUpperCase()));
          else if (r.plain) r.plain.forEach((p, i) => { if (i) k.append(" "); k.append(kbd(p)); });
          table.append(el("tr", {}, el("td", {}, r.label, r.note ? el("span", { className: "w", textContent: r.note }) : null), k));
        }
        const g2 = el("div", { className: "sp-group" }, el("div", { className: "gl", textContent: g }), el("div", { className: "sp-card" }, table));
        root.append(g2);
      }
    },

    agents(root) {
      const card = el("div", { className: "sp-card" });
      const hs = P.harnesses;
      if (!hs) card.append(el("div", { className: "sp-empty" }, "Looking for the agents on this machine..."));
      for (const h of hs || []) {
        const trusted = h.trusted_command && h.trusted_command === h.command;
        const open = P.expanded === h.id;
        const state = !h.enabled ? tag("Off") : !h.ready ? tag(h.detail === "no command set" ? "No command" : "Not found", "warn") : trusted ? tag("Trusted command", "good") : tag("Found", "good");
        const p = el("div", { className: "p" });
        if (h.command) p.append(el("span", { className: "mono", textContent: h.command }), h.path && h.path !== h.command ? ` resolves to ${homeShort(h.path)}` : "", h.ready ? "" : `. ${h.detail}`);
        else p.append("Any agent command line that speaks MCP. Set one up to use it.");
        const details = btn(open ? "Close" : "Details", () => { P.expanded = open ? null : h.id; repaint(); });
        details.setAttribute("aria-expanded", String(open));
        const on = toggle({ label: `${h.label} on`, danger: null }, Boolean(h.enabled), async (next) => {
          try { await window.delphi.harnesses.update(h.id, { enabled: next ? 1 : 0 }); } catch (error) { status(String(error.message || error), "crit"); }
          await loadHarnesses(true);
        });
        on.setAttribute("aria-label", `${h.label}: ${h.enabled ? "on" : "off"}`);
        card.append(el("div", { className: "sp-agent" },
          el("span", { className: `sp-logo ${harnessClass(h)}`, textContent: harnessInitials(h) }),
          el("div", { className: "who" }, el("b", {}, h.label, state), p),
          details, on));
        if (open) {
          let args = "";
          try { args = JSON.parse(h.args_json || "[]").map((a) => (Array.isArray(a) ? `[${a.join(" ")}]` : a)).join(" "); } catch { args = h.args_json || ""; }
          card.append(el("div", { className: "sp-argv" },
            el("div", {}, el("b", { textContent: "Command " }), h.command || "none"),
            el("div", {}, el("b", { textContent: "Arguments " }), args || "none"),
            el("div", {}, el("b", { textContent: "Reads output as " }), h.parser || "text", "   ", el("b", { textContent: "MCP " }), h.mcp_style || "none"),
            el("div", { style: "margin-top:8px;font-family:var(--font);font-size:12px" },
              h.seeded_json ? "A built-in agent: Delphi keeps it current with each release until you edit it. " : "",
              "A flag not on this agent's allowlist is refused before every run.",
              " ", btn("Edit command line...", () => lent.harnessSheet && lent.harnessSheet(h, () => loadHarnesses(true))))));
          const trust = lent.trustRow ? lent.trustRow(h, () => loadHarnesses(true)) : null;
          if (trust) card.append(el("div", { className: "sp-trust" }, trust));
        }
      }
      if (hs) {
        card.append(el("div", { className: "sp-agent" },
          el("span", { className: "sp-logo custom" }, I("plus", "sm")),
          el("div", { className: "who" }, el("b", {}, "Add an agent"),
            el("div", { className: "p", textContent: "Any agent command line that speaks MCP. A command outside the npm, Homebrew or Claude install folders needs Trust this command before jobs can run it." })),
          btn("Set up...", () => lent.harnessSheet && lent.harnessSheet(null, () => loadHarnesses(true))),
          btn("Check again", () => loadHarnesses(true))));
      }
      root.append(el("div", { className: "sp-group" }, el("div", { className: "gl", textContent: "Agents on this machine" }), card));
      root.append(...schemaGroups("agents"));
    },

    jobs(root) {
      root.append(...schemaGroups("jobs"));
      const projects = (lent.state && lent.state().projects) || [];
      const perProject = (field, label, desc, title, bullets) => {
        const onIn = projects.filter((p) => Number(p[field]) === 1);
        const open = P.expanded === field;
        const r = el("div", { className: "sp-row block" });
        r.dataset.key = field;
        r.append(el("div", { style: "display:flex;align-items:center;gap:16px" },
          el("div", { className: "l" }, el("div", { className: "n", textContent: label }), el("div", { className: "d", textContent: desc })),
          el("div", { className: "c" },
            el("span", { className: "hint", textContent: onIn.length ? `On in ${onIn.map((p) => p.name).join(", ")}` : `Off in all ${projects.length} projects` }),
            btn(open ? "Done" : "Choose projects", () => { P.expanded = open ? null : field; repaint(); }, "danger"))));
        if (open) {
          const list = el("div", { className: "sp-plist", style: "margin-top:10px" });
          for (const p of projects) {
            list.append(el("div", { className: "sp-prow" },
              el("span", { className: "sq", style: `background:${safeColour(p.colour, "var(--ink-faint)")}`, textContent: (p.name || "?")[0] }),
              el("span", { className: "pn", textContent: p.name }),
              toggle({ label: `${label} in ${p.name}`, danger: true }, Number(p[field]) === 1, async (next) => {
                if (next && !(await ask({ title: title(p), body: desc, bullets, confirm: label === "Allow unguarded runs" ? "Allow unguarded runs" : "Start without asking" }))) return;
                try { await window.delphi.projects.update(p.id, { [field]: next ? 1 : 0 }); p[field] = next ? 1 : 0; status("Saved.", "good"); }
                catch (error) { status(String(error.message || error), "crit"); }
                if (lent.refresh) lent.refresh();
                repaint();
              })));
          }
          r.append(list);
        }
        return r;
      };
      root.append(group("Needs care, per project", [
        perProject("auto_approve", "Start agent jobs without asking",
          "An agent's job normally waits in Needs you until you approve it. On here, it starts as soon as it is filed.",
          (p) => `Let agents start jobs in ${p.name} without asking?`,
          ["A Do job still runs only in its task's Workbench, and its flags are still checked.", "Every job still shows in Runs, and History says which agent asked."]),
        perProject("allow_unguarded", "Allow unguarded runs",
          "The guard is a Claude Code hook, so Copilot and Codex in auto mode run without it. On here, delphi chat --auto may run them anyway.",
          (p) => `Let agents run unguarded in ${p.name}?`,
          ["Nothing checks the commands Copilot or Codex run in this project's auto mode.", "Claude Code is still guarded."]),
      ], { care: true }));
    },

    workbenches(root) {
      root.append(...schemaGroups("workbenches"));
      // Each project's folder: one folder, one project. Changed through
      // folders:set, which makes the same checks Add folder does.
      const projects = (lent.state && lent.state().projects) || [];
      const rows = projects.map((p) => {
        const r = el("div", { className: "sp-prow" });
        r.dataset.key = `folder-${p.id}`;
        const change = btn(p.path ? "Change..." : "Choose...", async () => {
          let chosen = null;
          try { chosen = await window.delphi.dialog.pickFolder(`The folder for ${p.name}`, { buttonLabel: "Use this folder", defaultPath: p.path || undefined }); } catch {}
          if (!chosen) return;
          try { await window.delphi.folders.set(p.id, chosen); p.path = chosen; status(`${p.name} now uses ${homeShort(chosen)}.`, "good"); }
          catch (error) { status(String(error.message || error), "crit"); }
          if (lent.refresh) lent.refresh();
          repaint();
        });
        r.append(
          el("span", { className: "sq", style: `background:${safeColour(p.colour, "var(--ink-faint)")}`, textContent: (p.name || "?")[0] }),
          el("span", { className: "pn", textContent: p.name, style: "flex:0 0 230px" }),
          el("span", { className: `pn mono${p.path ? "" : " hint"}`, textContent: p.path ? homeShort(p.path) : "No folder", title: p.path || "" }),
          change);
        if (p.path) {
          r.append(btn("Clear", async () => {
            const ok = await ask({ title: `Take ${p.name} off its folder?`, body: "The folder and everything in it stay as they are, and so do the project's tasks and its Workbench settings. Jobs then have nowhere to run until it has a folder again.", confirm: "Clear the folder" });
            if (!ok) return;
            try { await window.delphi.folders.clear(p.id); p.path = null; status(`${p.name} has no folder now.`, "good"); }
            catch (error) { status(String(error.message || error), "crit"); }
            if (lent.refresh) lent.refresh();
            repaint();
          }));
        }
        return r;
      });
      const add = infoRow("Add folder as project", "A repository on this computer becomes a project, with its remote and default branch. One folder belongs to one project.",
        btn([I("folderplus", "xs"), "Add folder..."], () => { close(); if (lent.addFolder) lent.addFolder(); }));
      root.append(group("Projects and their folders", [add, ...rows]));
      root.append(group("Per repository", [infoRow("Base branch, setup command and files to copy",
        "These belong to each repository, so they are on the project's own settings, under Workbench.",
        btn(["Project settings", I("right", "xs")], () => { const id = lent.state && lent.state().projectId; close(); if (lent.openProject) lent.openProject(id); }))]));
    },

    memory(root) {
      root.append(...schemaGroups("memory"));
      root.append(group("The vault, now", [infoRow("Rebuild or open it",
        `Rebuilt shortly after every change while it is on. ${P.doctor ? homeShort(P.doctor.vaultPath) : ""}`,
        btn("Export now", async () => {
          try { const r = await window.delphi.vault.export(); status(`Exported ${r && r.notes != null ? `${r.notes} notes` : "the vault"}.`, "good"); } catch (error) { status(String(error.message || error), "crit"); }
        }),
        btn([I("ext", "xs"), "Open the folder"], () => window.delphi.vault.reveal().catch(() => {})))]));
    },

    focus(root) { root.append(...schemaGroups("focus")); },

    data(root) {
      const d = P.doctor;
      const kv = el("dl", { className: "sp-kv" });
      const line = (k, v, act, plain = false) => kv.append(el("dt", { textContent: k }), el("dd", { className: plain ? "plain" : "", textContent: v || "" }), el("div", { className: "sp-act" }, act || ""));
      if (d) {
        line("Database", homeShort(d.dbPath), copyBtn(d.dbPath));
        line("Database id", d.dbId, copyBtn(d.dbId));
        line("Found by", d.resolvedBy === "default" ? "The per-user data folder. No DELPHI_DB or DELPHI_DATA_DIR is set." : `${d.resolvedBy}`, null, true);
        line("Settings", homeShort(d.settingsPath), btn([I("ext", "xs"), "Reveal"], () => window.delphi.fs.reveal(d.settingsPath)));
      } else line("Database", "Checking...");
      const card = el("div", { className: "sp-card" }, kv);
      if (P.data && P.data.checkoutNoticeDue) {
        card.append(el("div", { className: "sp-notice", role: "status" },
          el("span", { className: "ic" }, I("alert", "sm")),
          el("div", { className: "grow" }, el("b", { textContent: "A database in the checkout is being ignored" }),
            el("div", { className: "d", textContent: `${homeShort(P.data.checkoutDbIgnored)} exists and is never opened, so nothing an agent writes there reaches this window. Agents check with whoami or delphi doctor.` })),
          btn("Got it", () => save({ checkoutNoticeSeen: P.data.checkoutDbIgnored }).then(() => loadData()))));
      }
      root.append(el("div", { className: "sp-group" }, el("div", { className: "gl", textContent: "Where your data lives" }), card));

      const bk = el("div", { className: "sp-card sp-backups" });
      if (globalThis.DelphiBackups) DelphiBackups.paint(bk);
      root.append(el("div", { className: "sp-group" }, el("div", { className: "gl", textContent: "Backups" }),
        el("p", { className: "lede", style: "margin:0 0 8px", textContent: "A copy of the whole database every day, the last seven kept, and one before anything big such as an update. Restoring one keeps a copy of what is here now first." }), bk));

      root.append(group("Settings file", [infoRow("Export and import settings",
        "Every setting on these pages as JSON, without secrets: the API key stays in the keychain and trusted agent commands stay in the database. Import shows what will change first.",
        btn([I("upload", "xs"), "Import..."], importSettings), btn([I("up", "xs"), "Export..."], exportSettings))]));
      root.append(group("Elsewhere", [infoRow("History, undo and archived projects",
        "Still on the old Settings page and the History tab, until they move here.",
        btn("Archived projects", () => { close(); if (lent.openOld) lent.openOld("archived"); }),
        btn("History", () => { close(); if (lent.go) lent.go({ projectId: null, view: "history" }); }))]));
    },

    privacy(root) {
      const second = val("secondOpinionMode");
      const ready = (P.harnesses || []).filter((h) => h.enabled && h.ready).length;
      root.append(group("What leaves this computer", [
        infoRow("Agents you launch", "Each agent sends your prompts and the files it reads to its own provider, under that provider's terms. Delphi does not proxy them or add to what they send.", tag(`${ready} agent${ready === 1 ? "" : "s"}`)),
        infoRow("Second opinions", "The question and the files named in it go to the second opinion agent. Never the first agent's answer.", tag(second ? "On" : "Off", second ? "warn" : "plain")),
        infoRow("Delphi's own chat", "What you type in a project's chat goes to the provider it uses: a command line you are signed in to, or the API with your key.", null),
        infoRow("Checking for updates", "Asks GitHub for the latest release. Nothing about you or your data is sent with it.", null),
      ]));
      const keyTag = el("span", { className: "hint", textContent: "Checking..." });
      const keyRow = infoRow("Anthropic API key", "Kept encrypted by the operating system's keychain, never in settings.json, and never in an export.", keyTag);
      window.delphi.ai.hasKey().then((has) => {
        keyTag.replaceWith(has
          ? el("span", { className: "c" }, tag("In the keychain", "good"), btn("Remove", async () => {
            if (!(await ask({ title: "Remove the API key?", body: "Delphi's chat falls back to a command line login, if there is one.", confirm: "Remove it" }))) return;
            try { await window.delphi.ai.setKey(null); status("Key removed.", "good"); } catch (error) { status(String(error.message || error), "crit"); }
            repaint();
          }, "danger"))
          : tag("None saved"));
      }).catch(() => keyTag.replaceWith(tag("Unknown")));
      root.append(group("Never sent", [
        infoRow("Delphi itself sends nothing else", "No analytics, no crash reports, no account. Memory search uses Ollama on this computer when it is running, and plain word matching when it is not.", tag("Local", "good")),
        keyRow,
      ]));
      root.append(group("Export", [infoRow("Settings exports carry no secrets", "No keys, no tokens, no trusted commands, and nothing that only means something here (the vault folder, the default project).",
        btn(["Data and backups", I("right", "xs")], () => show("data")))]));
    },

    advanced(root) {
      root.append(...schemaGroups("advanced"));
      const d = P.doctor;
      root.append(group("Files", [
        infoRow("settings.json", el("span", {}, "Everything on these pages is stored here. A file that is not valid JSON is kept, and Delphi runs on defaults. ", d ? el("span", { className: "mono", textContent: homeShort(d.settingsPath) }) : ""),
          d ? btn([I("ext", "xs"), "Reveal"], () => window.delphi.fs.reveal(d.settingsPath)) : null),
        infoRow("Agent command lines", "Each agent's command, arguments, output parser and how it is handed Delphi's MCP server.", btn(["Agents", I("right", "xs")], () => show("agents"))),
        infoRow("The old Settings page", "Delphi's own AI providers, the mouse button and Hand to an agent are still there, until they move here.", btn([I("ext", "xs"), "Open it"], () => { close(); if (lent.openOld) lent.openOld(); })),
      ]));
      root.append(group("Needs care", [infoRow("Reset every setting to its default",
        "Settings only: projects, tasks, notes, pads and agents are kept. The window is rebuilt if panel mode was on.",
        btn("Reset all...", async () => {
          const mods = modified();
          if (!mods.length) { status("Nothing is changed from its default.", "good"); return; }
          const ok = await ask({ title: `Reset ${mods.length} setting${mods.length === 1 ? "" : "s"} to default?`, body: "Each goes back to what a new install has.", bullets: mods.map((s) => `${s.label}: ${shown(s.key, val(s.key))} back to ${shown(s.key, s.default)}`), confirm: "Reset them" });
          if (ok) await save(Object.fromEntries(mods.map((s) => [s.key, s.default])), { confirmed: true });
        }, "danger"))], { care: true }));
    },

    about(root) {
      const d = P.doctor;
      const kv = el("dl", { className: "sp-kv" });
      const line = (k, v, act) => kv.append(el("dt", { textContent: k }), el("dd", { textContent: v || "" }), el("div", { className: "sp-act" }, act || ""));
      line("Version", d ? d.version : "...");
      line("Database id", d ? d.dbId : "...", d ? copyBtn(d.dbId) : null);
      line("Data folder", d ? homeShort(d.dataDir) : "...", d ? btn([I("ext", "xs"), "Reveal"], () => window.delphi.fs.reveal(d.dataDir)) : null);
      root.append(el("div", { className: "sp-group" }, el("div", { className: "gl", textContent: "This Delphi" }), el("div", { className: "sp-card" }, kv)));
      root.append(group("More", [
        infoRow("What's new", "What changed across every project since you last looked.", btn(["Open", I("right", "xs")], () => { close(); if (lent.go) lent.go({ projectId: null, view: "new" }); })),
        infoRow("Source and releases", "github.com/Ray-Hughes/delphi", btn([I("ext", "xs"), "Open"], () => window.delphi.openExternal("https://github.com/Ray-Hughes/delphi"))),
      ]));
    },
  };

  function arrowRadio(e, values, current, pick) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const at = values.indexOf(current);
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    pick(values[(at + step + values.length) % values.length]);
  }

  /** A strip of the window in miniature, drawn with the live tokens, so every change shows here as it does everywhere. */
  function livePreview() {
    const tasks = ((lent.state && lent.state().allTasks) || []).filter((t) => t.status !== "done").slice(0, 3);
    const sample = tasks.length ? tasks.map((t) => [t.id, t.title]) : [[149, "Write the testing section"], [279, "Get the Slack bot approved"], [292, "Find the app approver"]];
    const rows = el("div", { className: "rows" }, ...sample.map(([id, t], i) => el("div", { className: `pr${i === 1 ? " sel" : ""}` },
      el("span", { className: "id", textContent: `#${id}` }), el("span", { className: "t", textContent: t }), el("span", { className: "age", textContent: `${33 + i * 7}d` }))));
    const on = el("span", { className: "sp-toggle", role: "presentation" });
    on.setAttribute("aria-checked", "true");
    const live = el("div", { className: "sp-live" },
      el("div", { className: "lt" }, el("span", { className: "lab", textContent: "Live preview" }), el("span", { className: "hint", textContent: "Changes apply to the whole window as you pick them. Nothing to save." })),
      el("div", { className: "lb" }, rows,
        el("div", { className: "side" },
          el("div", { className: "acts" }, el("span", { className: "sp-btn sm primary" }, I("runs", "xs"), "Run an agent"), el("span", { className: "sp-btn sm", textContent: "Park" }), on, tag("Trusted", "good")),
          el("div", { className: "ptabs" }, el("span", { className: "on", textContent: "Today" }), el("span", { textContent: "Tasks" }), el("span", { textContent: "Memory" })),
          el("div", { className: "pfind" }, I("search", "xs"), "Focus ring and selection"))));
    // A picture of the window, not controls: a screen reader skips it.
    live.setAttribute("aria-hidden", "true");
    return live;
  }

  const when = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const today = new Date().toDateString() === d.toDateString();
    return (today ? "Today, " : `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, `) + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  };
  const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  // --- export and import ---------------------------------------------------

  async function exportSettings() {
    try {
      const r = await window.delphi.settings.export();
      if (r) status(`Exported ${r.count} settings to ${homeShort(r.path)}.`, "good");
    } catch (error) { status(String(error.message || error), "crit"); }
  }

  async function importSettings() {
    let r;
    try { r = await window.delphi.settings.importRead(); } catch (error) { status(String(error.message || error), "crit"); return; }
    if (!r) return;
    const changes = Object.entries(r.apply);
    const careful = changes.filter(([k, v]) => SS.needsConfirm(k, v)).map(([k]) => SS.BY_KEY[k].label);
    if (!changes.length) {
      await ask({ title: "Nothing to import", body: r.skipped.length ? `Every setting in it is already the same here, or was left out: ${r.skipped.map((s) => `${s.key} (${s.why})`).join("; ")}` : "Every setting in it is already the same here.", confirm: "OK", kind: "info" });
      return;
    }
    const bullets = changes.map(([k, v]) => `${SS.BY_KEY[k].label}: ${shown(k, val(k))} to ${shown(k, v)}`);
    for (const s of r.skipped) bullets.push(`Left out ${s.key}: ${s.why}`);
    const ok = await ask({
      title: `Import ${changes.length} setting${changes.length === 1 ? "" : "s"}?`,
      body: `From ${homeShort(r.path)}.${careful.length ? ` ${careful.join(" and ")} change${careful.length === 1 ? "s" : ""} how every connected agent works.` : ""}`,
      bullets, confirm: "Import them", kind: careful.length ? "danger" : "info",
    });
    if (ok) await save(r.apply, { confirmed: true });
  }

  // --- search --------------------------------------------------------------

  /** Settings and shortcuts matching what was typed, with the words to mark. */
  function results() {
    const { mod, words } = parseQuery(P.query);
    const out = [];
    for (const s of listed()) {
      if (mod && !SS.isModified(s.key, val(s.key))) continue;
      const hay = SS.searchText(s) + " " + shown(s.key, val(s.key)).toLowerCase();
      if (words.every((w) => hay.includes(w))) out.push({ kind: "setting", s, section: s.section, label: s.label, desc: s.desc, value: shown(s.key, val(s.key)) });
    }
    if (!mod && words.length) {
      for (const k of shortcuts()) {
        const hay = `${k.label} ${k.group} shortcut keyboard ${capsOf(k.keys || "").join(" ")} ${(k.plain || []).join(" ")} ${k.chord ? `g ${k.chord}` : ""}`.toLowerCase();
        if (words.every((w) => hay.includes(w))) out.push({ kind: "shortcut", k, section: "shortcuts", label: k.label, desc: k.group, value: k.keys ? capsOf(k.keys).join("") : k.chord ? `G then ${k.chord.toUpperCase()}` : (k.plain || []).join(" ") });
      }
    }
    return { out, words, mod };
  }

  /** Text with each searched word marked, as nodes. */
  function marked(textIn, words) {
    const t = String(textIn || "");
    if (!words.length) return [t];
    const lower = t.toLowerCase();
    const hits = [];
    for (const w of words) { let i = lower.indexOf(w); while (i >= 0) { hits.push([i, i + w.length]); i = lower.indexOf(w, i + w.length); } }
    hits.sort((a, b) => a[0] - b[0]);
    const out = []; let at = 0;
    for (const [a, b] of hits) { if (a < at) continue; out.push(t.slice(at, a), el("mark", { textContent: t.slice(a, b) })); at = b; }
    out.push(t.slice(at));
    return out;
  }

  function paintResults(root) {
    const { out, words, mod } = results();
    P.found = out;
    if (P.hot >= out.length) P.hot = Math.max(0, out.length - 1);
    const title = mod && !words.length
      ? `${out.length} setting${out.length === 1 ? "" : "s"} changed from default`
      : `${out.length} ${out.length === 1 ? "match" : "matches"} for "${P.query.trim()}"`;
    root.append(el("h3", { className: "sec", id: "sp-sec-title" }, title,
      el("span", { className: "sp-caps", style: "margin-left:10px;font-size:12px;font-weight:400;color:var(--ink-faint)" }, kbd("↑"), " ", kbd("↓"), " choose, ", kbd("↵"), " jump to it, ", kbd("Esc"), " clear")));
    root.append(el("p", { className: "lede", textContent: mod ? "Each has a bar at its edge and its own Reset where it lives." : "Names, sentences, other words for each setting, and shortcuts." }));
    if (!out.length) {
      root.append(el("div", { className: "sp-card" }, el("div", { className: "sp-empty", textContent: mod ? "Nothing is changed from its default." : "Nothing matches. Try another word, or @modified for what you have changed." })));
      return;
    }
    const sections = [...new Set(out.map((r) => r.section))];
    let i = 0;
    const list = el("div", { className: "sp-results", role: "listbox", id: "sp-results" });
    list.setAttribute("aria-label", "Matching settings");
    for (const sec of sections) {
      const card = el("div", { className: "sp-card" });
      for (const r of out.filter((x) => x.section === sec)) {
        const at = i++;
        const b = el("button", { className: `sp-res${at === P.hot ? " hot" : ""}`, type: "button", role: "option", id: `sp-res-${at}` });
        b.setAttribute("aria-selected", String(at === P.hot));
        b.append(
          el("div", { className: "l" },
            el("div", { className: "sp-crumb" }, sectionOf(sec).label, I("right", "xs"), r.kind === "setting" ? r.s.group : r.desc),
            el("div", { className: "n" }, ...marked(r.label, words)),
            r.kind === "setting" ? el("div", { className: "d" }, ...marked(r.desc + range(r.s), words)) : null),
          r.value ? el("span", { className: "val", textContent: r.value }) : null,
          at === P.hot ? el("span", { className: "go" }, kbd("↵"), "Jump") : I("right", "sm"));
        b.onclick = () => choose(at);
        b.onmousemove = () => { if (P.hot !== at) { P.hot = at; markHot(); } };
        card.append(b);
      }
      list.append(el("div", { className: "sp-group" }, el("div", { className: "gl", textContent: sectionOf(sec).label }), card));
    }
    root.append(list);
    P.input.setAttribute("aria-activedescendant", `sp-res-${P.hot}`);
  }

  function markHot() {
    P.content.querySelectorAll(".sp-res").forEach((b, i) => {
      b.classList.toggle("hot", i === P.hot);
      b.setAttribute("aria-selected", String(i === P.hot));
    });
    const lit = P.content.querySelector(".sp-res.hot");
    if (lit) lit.scrollIntoView({ block: "nearest" });
    P.input.setAttribute("aria-activedescendant", `sp-res-${P.hot}`);
  }

  function choose(i) {
    const r = P.found && P.found[i];
    if (!r) return;
    if (r.kind === "setting") jump(r.s.key);
    else { setQuery(""); show("shortcuts"); }
  }

  function setQuery(q) {
    P.query = q;
    P.input.value = q;
    P.hot = 0;
    P.find.classList.toggle("on", Boolean(q));
    repaint();
  }

  // --- painting ------------------------------------------------------------

  function paintNav() {
    const nav = P.nav;
    nav.textContent = "";
    const searching = Boolean(P.query.trim());
    const counts = searching ? results().out.reduce((m, r) => ((m[r.section] = (m[r.section] || 0) + 1), m), {}) : {};
    const mods = modified();
    let groupName = null;
    for (const sec of SS.SECTIONS) {
      if (sec.group !== groupName) { groupName = sec.group; if (groupName) nav.append(el("div", { className: "gl", textContent: groupName })); }
      const b = el("button", { className: `sp-nv${searching && !counts[sec.id] ? " dim" : ""}`, type: "button" }, I(sec.icon, "sm"), sec.label);
      b.dataset.sec = sec.id;
      if (!searching && P.section === sec.id) b.setAttribute("aria-current", "page");
      if (searching && counts[sec.id]) b.append(el("span", { className: "hits", textContent: String(counts[sec.id]), title: `${counts[sec.id]} matching` }));
      else if (!searching && mods.some((s) => s.section === sec.id)) b.append(el("span", { className: "mod", title: "Something here is changed from its default" }));
      b.onclick = () => { if (P.query) setQuery(""); show(sec.id); };
      nav.append(b);
    }
    const foot = el("div", { className: "foot" });
    const modBtn = el("button", { className: "sp-nv", type: "button" }, I("filter", "sm"), "Changed from default", el("span", { className: "n", textContent: String(mods.length) }));
    if (parseQuery(P.query).mod) modBtn.setAttribute("aria-current", "page");
    modBtn.onclick = () => { setQuery(parseQuery(P.query).mod ? "" : "@modified"); P.input.focus(); };
    const old = el("button", { className: "sp-nv", type: "button" }, I("file", "sm"), "Old Settings page");
    old.onclick = () => { close(); if (lent.openOld) lent.openOld(); };
    foot.append(modBtn, old);
    nav.append(foot);
  }

  function paintContent() {
    const root = P.content;
    const keepScroll = P.lastPainted === `${P.section}|${P.query}` ? root.scrollTop : 0;
    const focusKey = document.activeElement && P.box.contains(document.activeElement) ? focusToken(document.activeElement) : null;
    root.textContent = "";
    if (P.query.trim()) paintResults(root);
    else {
      const sec = sectionOf(P.section);
      root.append(el("h3", { className: "sec", id: "sp-sec-title", textContent: sec.label }), el("p", { className: "lede", textContent: sec.lede }));
      try { PAINT[sec.id](root); } catch (error) { root.append(el("div", { className: "err-msg", textContent: String(error.message || error) })); console.error(error); }
    }
    root.setAttribute("aria-labelledby", "sp-sec-title");
    P.lastPainted = `${P.section}|${P.query}`;
    root.scrollTop = keepScroll;
    if (focusKey) restoreFocus(focusKey);
  }

  /** Where the focus was, as something that survives a repaint: the row and the control's place in it. */
  function focusToken(node) {
    if (node === P.input) return { input: true };
    const r = node.closest("[data-key]");
    if (!r) { const nv = node.closest("[data-sec]"); return nv ? { sec: nv.dataset.sec } : null; }
    const all = [...r.querySelectorAll("button, input, select")];
    return { key: r.dataset.key, at: all.indexOf(node) };
  }
  function restoreFocus(t) {
    if (t.input) { P.input.focus({ preventScroll: true }); return; }
    if (t.sec) { const b = P.nav.querySelector(`[data-sec="${t.sec}"]`); if (b) b.focus({ preventScroll: true }); return; }
    const r = P.content.querySelector(`[data-key="${t.key}"]`);
    if (!r) return;
    const all = [...r.querySelectorAll("button, input, select")];
    const n = all[Math.min(Math.max(t.at, 0), all.length - 1)];
    if (n) n.focus({ preventScroll: true });
  }

  function repaint() {
    if (!P) return;
    paintNav();
    paintContent();
  }

  function show(section) {
    if (!P) return;
    P.section = section;
    P.expanded = null;
    P.rec = null;
    repaint();
    P.content.scrollTop = 0;
  }

  /** A setting's own row, scrolled to and lit, with the focus on its control. */
  function jump(key) {
    const s = SS.BY_KEY[key];
    if (!s || !P) return;
    if (P.query) { P.query = ""; P.input.value = ""; P.find.classList.remove("on"); }
    show(s.section || "overview");
    const r = P.content.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!r) return;
    r.scrollIntoView({ block: "center" });
    r.classList.remove("flash");
    void r.offsetWidth;
    r.classList.add("flash");
    const c = r.querySelector("button:not(.sp-rst), input, select");
    if (c) c.focus({ preventScroll: true });
  }

  // --- loading -------------------------------------------------------------

  async function loadHarnesses(force = false) {
    try { const rows = await window.delphi.harnesses.list(force); if (P) { P.harnesses = rows; repaint(); } } catch { if (P) { P.harnesses = []; repaint(); } }
  }
  async function loadDoctor() {
    try { const d = await window.delphi.settings.doctor(); if (P) { P.doctor = d; repaint(); } } catch (error) { console.error("settings:doctor", error); }
  }
  async function loadData() {
    try { const d = await window.delphi.app.dataInfo(); if (P) { P.data = d; repaint(); } } catch {}
  }

  // --- the keyboard --------------------------------------------------------

  function onKey(e) {
    if (!P || P.dialog) return;
    // Another panel opened over this one (the harness sheet, the trust
    // dialog) owns the keys until it closes.
    const overlays = document.querySelectorAll("body > .overlay");
    if (overlays.length && overlays[overlays.length - 1] !== P.scrim) return;
    const own = () => { e.preventDefault(); e.stopPropagation(); };

    if (P.rec) {
      if (e.key === "Escape") { own(); P.rec = null; repaint(); return; }
      if (["Shift", "Meta", "Control", "Alt"].includes(e.key)) { own(); return; }
      if (e.key === "Tab") return;
      own();
      if (P.rec.conflict) return;
      const got = accelOf(e);
      if (!got) return;
      if (!got.accel) { P.rec = { ...P.rec, why: got.why }; repaint(); return; }
      P.rec = { ...P.rec, accel: got.accel, why: null };
      recorded(got.accel);
      return;
    }
    if (e.key === "Escape") {
      own();
      if (P.query) { setQuery(""); P.input.focus(); } else close();
      return;
    }
    if (modKey(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") { own(); focusSearch(); return; }
    if (modKey(e) && e.key === ",") { own(); focusSearch(); return; }
    if (e.key === "Tab") {
      // The focus stays inside the panel.
      const all = [...P.box.querySelectorAll("button, input, select, [tabindex]:not([tabindex='-1'])")]
        .filter((n) => !n.disabled && n.offsetParent !== null && n.tabIndex >= 0);
      if (!all.length) return;
      const at = all.indexOf(document.activeElement);
      const next = e.shiftKey ? (at <= 0 ? all.length - 1 : at - 1) : (at === all.length - 1 ? 0 : at + 1);
      own();
      all[next].focus();
      return;
    }
    const inSearch = document.activeElement === P.input;
    if (inSearch && P.query.trim() && P.found && P.found.length) {
      if (e.key === "ArrowDown") { own(); P.hot = Math.min(P.found.length - 1, P.hot + 1); markHot(); return; }
      if (e.key === "ArrowUp") { own(); P.hot = Math.max(0, P.hot - 1); markHot(); return; }
      if (e.key === "Enter") { own(); choose(P.hot); return; }
    }
    if (inSearch && !P.query.trim() && e.key === "ArrowDown") { own(); const b = P.nav.querySelector("[aria-current='page']"); if (b) b.focus(); return; }
    const navBtn = document.activeElement && document.activeElement.closest && document.activeElement.closest(".sp-nav .sp-nv[data-sec]");
    if (navBtn && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      own();
      const ids = SS.SECTIONS.map((x) => x.id);
      const at = ids.indexOf(navBtn.dataset.sec);
      const next = ids[(at + (e.key === "ArrowDown" ? 1 : -1) + ids.length) % ids.length];
      show(next);
      const b = P.nav.querySelector(`[data-sec="${next}"]`);
      if (b) b.focus();
      return;
    }
    // Everything else is the panel's own: nothing behind it (J and K, the G
    // chords, Enter on a lit row) may act on a page the panel is covering. A
    // key aimed inside the panel still reaches its control first (the radio
    // groups' arrows, Enter in a number); the scrim stops it on the way back
    // up, in stopBehind.
    if (!P.box.contains(e.target)) e.stopPropagation();
  }
  const stopBehind = (e) => e.stopPropagation();

  function focusSearch() {
    if (!P) return;
    P.input.focus();
    P.input.select();
  }

  // --- open and close ------------------------------------------------------

  /**
   * Opens the panel: at a section, at one setting's row (key), or searching.
   * Opening it again while it is open moves it there.
   */
  async function open({ section = null, key = null, query = "" } = {}) {
    if (P) {
      if (key) jump(key);
      else if (query) { setQuery(query); focusSearch(); }
      else if (section) show(section);
      else focusSearch();
      return;
    }
    const returnTo = document.activeElement;
    const scrim = el("div", { className: "overlay sp-scrim" });
    const box = el("div", { className: "sp", role: "dialog" });
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "sp-title");
    const input = el("input", { type: "search", placeholder: `Search ${listed().length} settings and shortcuts, or @modified`, spellcheck: false, autocomplete: "off" });
    input.setAttribute("aria-label", "Search settings");
    input.setAttribute("aria-controls", "sp-content");
    const find = el("label", { className: "sp-find" }, I("search", "sm"), input);
    const count = el("span", { className: "cnt" });
    find.append(count, el("span", { className: "sp-caps" }, kbd(modLabel()), kbd("F")));
    const closeBtn = el("button", { className: "sp-x", type: "button", title: "Close (Esc)" }, I("x"));
    closeBtn.setAttribute("aria-label", "Close settings");
    closeBtn.onclick = () => close();
    const head = el("header", { className: "sp-head" }, el("h2", { id: "sp-title", textContent: "Settings" }), el("span", { className: "vr" }), find,
      el("span", { className: "sp-caps", title: "Settings opens with" }, kbd(modLabel()), kbd(",")), closeBtn);
    const nav = el("nav", { className: "sp-nav" });
    nav.setAttribute("aria-label", "Settings sections");
    const content = el("div", { className: "sp-content", id: "sp-content", role: "region", tabIndex: -1 });
    const saved = el("span", { className: "saved", role: "status" });
    saved.setAttribute("aria-live", "polite");
    const foot = el("footer", { className: "sp-foot" },
      el("span", {}, kbd("↑"), kbd("↓"), "sections"), el("span", {}, kbd("Tab"), "into settings"),
      el("span", {}, kbd(modLabel()), kbd("F"), "search"), el("span", {}, kbd("Esc"), "close"), saved);
    box.append(head, el("div", { className: "sp-body" }, nav, content), foot);
    scrim.append(box);
    scrim.onmousedown = (e) => { if (e.target === scrim) close(); };
    scrim.addEventListener("keydown", stopBehind);

    P = {
      scrim, box, nav, content, input, find, count, saved, returnTo,
      section: section || (key && SS.BY_KEY[key] ? SS.BY_KEY[key].section : "overview"),
      query: "", hot: 0, found: [], errors: {}, expanded: null, rec: null, dialog: false,
      settings: (lent.state && lent.state().settings) || {}, harnesses: (lent.state && lent.state().harnesses) || null, doctor: null, data: null,
    };
    input.oninput = () => {
      P.query = input.value;
      P.hot = 0;
      find.classList.toggle("on", Boolean(P.query));
      const n = P.query.trim() ? results().out.length : null;
      count.textContent = n == null ? "" : `${n} result${n === 1 ? "" : "s"}`;
      repaint();
    };
    document.body.append(scrim);
    document.body.classList.add("sp-open");
    document.addEventListener("keydown", onKey, true);
    idleStatus();
    repaint();
    try { const got = await window.delphi.settings.get(); if (P) P.settings = got; } catch {}
    if (!P) return;
    if (query) setQuery(query);
    if (key) jump(key); else { repaint(); focusSearch(); }
    loadDoctor();
    loadData();
    loadHarnesses(false);
  }

  function close() {
    if (!P) return;
    const back = P.returnTo;
    document.removeEventListener("keydown", onKey, true);
    clearTimeout(P.statusTimer);
    P.scrim.remove();
    document.body.classList.remove("sp-open");
    P = null;
    if (back && back.isConnected && typeof back.focus === "function") back.focus({ preventScroll: true });
  }

  /**
   * The menu's own keys while the panel is open. Cmd+F and Cmd+, are menu
   * accelerators, so they arrive as actions rather than as key presses.
   * Returns true when the panel took the action.
   */
  function handleMenu(action) {
    if (!P) return false;
    if (action === "search" || action === "settings") { focusSearch(); return true; }
    if (action === "theme") return false;
    close();
    return false;
  }

  /**
   * Every setting as a Cmd+K command, found by its name, its sentence and its
   * other words, showing its value, and opening the panel at its row. Quiet:
   * listed only once something is typed, so the empty bar is not a wall of
   * settings.
   */
  function commands() {
    return listed().map((s) => ({
      id: `setting-${s.key}`, group: "Settings", quiet: true, place: "setting",
      title: s.label,
      keywords: [s.desc, ...(s.synonyms || []), sectionOf(s.section).label, "setting"].join(" "),
      get keys() { const st = lent.state && lent.state().settings; return shown(s.key, st && s.key in st ? st[s.key] : s.default); },
      run: () => open({ key: s.key }),
    }));
  }

  return { init: (app) => { lent = app || {}; }, open, close, isOpen: () => Boolean(P), configure: (key) => open({ key }), applyLook, handleMenu, commands, accelOf, conflictOf };
})();
