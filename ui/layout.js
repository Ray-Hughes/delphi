// Edit this page: bounded layout customization for Today, Tasks and Runs.
//
// A page is a few named regions, and each region a few named sections, all
// declared in code by the page itself (register below) with ids that never
// change. A person can show or hide a section, move it within its own region,
// and make it narrower or wider. Nothing more: a section never leaves its
// region, nothing is added that the page did not declare, and there is no
// free-form canvas. That is the whole of the owner's decision, and it is what
// keeps every arrangement one a page can still draw.
//
// A layout is versioned JSON, stored one row per screen for everyone and one
// per screen per project (db.js, layouts table), never in localStorage, so a
// change is in History as "Layout changed" and undo puts the last one back.
// Reading one is lenient on purpose: an id the page no longer has is
// ignored, a section the page has gained appears in its default place, and a
// layout from a newer Delphi is read for what this one understands. A layout
// cannot stop a page from drawing.
//
// The page builds its sections as it always did and hands them to mount(),
// which arranges them. Editing moves those same nodes about in place, so no
// keypress or drag refetches anything or repaints the page. The stored
// layouts are read once before the first paint (app.js boot), so a page is
// never drawn in its default order and then jumps.
//
// The model (resolve, move, resize, presets) is plain functions with no DOM,
// exported for tools/layout_test.js. Everything below "The window" needs one.

(function (root) {
  "use strict";

  // -------------------------------------------------------------------------
  // The model, with no DOM

  const VERSION = 1;
  // Twelfths of a region. settings/schema.js LAYOUT_SIZES is the same list,
  // and tools/layout_test.js checks they agree.
  const SIZES = ["third", "half", "two-thirds", "full"];
  const SPAN = { third: 4, half: 6, "two-thirds": 8, full: 12 };
  const SIZE_WORDS = { third: "a third wide", half: "half width", "two-thirds": "two thirds wide", full: "full width" };
  const ID = /^[a-z][a-z0-9-]{0,39}$/;

  const isPlain = (v) => v != null && typeof v === "object" && !Array.isArray(v);
  const sectionsOf = (spec) => spec.regions.flatMap((r) => r.sections);
  const sectionOf = (spec, id) => sectionsOf(spec).find((s) => s.id === id) || null;
  const regionOf = (spec, id) => spec.regions.find((r) => r.sections.some((s) => s.id === id)) || null;
  const sizesOf = (section) => (Array.isArray(section.sizes) && section.sizes.length ? section.sizes : SIZES).filter((s) => SIZES.includes(s));
  const sizeOf = (section) => (sizesOf(section).includes(section.size) ? section.size : sizesOf(section).includes("full") ? "full" : sizesOf(section).slice(-1)[0]);

  /**
   * A page's declaration, checked once when it registers, so a typo in an id
   * is an error at load rather than a layout that silently never applies.
   */
  function checkSpec(spec) {
    if (!spec || !ID.test(spec.id)) throw new Error(`A layout needs a screen id, got ${spec && spec.id}`);
    if (!Array.isArray(spec.regions) || !spec.regions.length) throw new Error(`${spec.id}: a layout needs regions`);
    const seen = new Set();
    for (const r of spec.regions) {
      if (!ID.test(r.id) || seen.has(`r:${r.id}`)) throw new Error(`${spec.id}: region "${r.id}" is not a fresh id`);
      seen.add(`r:${r.id}`);
      if (!Array.isArray(r.sections) || !r.sections.length) throw new Error(`${spec.id}: region ${r.id} has no sections`);
      for (const s of r.sections) {
        if (!ID.test(s.id) || seen.has(s.id)) throw new Error(`${spec.id}: section "${s.id}" is not a fresh id`);
        if (!s.label) throw new Error(`${spec.id}: section ${s.id} needs a label`);
        seen.add(s.id);
      }
    }
    for (const p of spec.presets || []) if (!ID.test(p.id) || !p.label) throw new Error(`${spec.id}: preset "${p.id}" needs an id and a label`);
    return spec;
  }

  /** The page as declared: every section in its order, visible, at its own size. */
  function defaults(spec) {
    return {
      v: VERSION,
      regions: Object.fromEntries(spec.regions.map((r) => [r.id, r.sections.map((s) => s.id)])),
      hidden: [],
      sizes: Object.fromEntries(sectionsOf(spec).map((s) => [s.id, sizeOf(s)])),
    };
  }

  /**
   * Puts id into order where the declared order would have it: just after
   * the nearest section declared before it that order holds, or first when
   * none of those is there. So a section a page gains later lands beside the
   * neighbour it was declared after, wherever that one has been moved.
   */
  function insertAtDefault(order, declared, id) {
    const out = order.filter((x) => x !== id);
    for (let i = declared.indexOf(id) - 1; i >= 0; i--) {
      const j = out.indexOf(declared[i]);
      if (j >= 0) { out.splice(j + 1, 0, id); return out; }
    }
    out.unshift(id);
    return out;
  }

  /**
   * A stored layout, made whole for this page. Never throws: anything it
   * cannot use is left out and the page's own choice fills the gap. A newer
   * version is read the same way, for the fields this one knows.
   */
  function resolve(spec, saved) {
    const base = defaults(spec);
    if (!isPlain(saved)) return base;
    const out = { v: VERSION, regions: {}, hidden: [], sizes: { ...base.sizes } };
    const savedRegions = isPlain(saved.regions) ? saved.regions : {};
    for (const region of spec.regions) {
      const own = new Set(region.sections.map((s) => s.id));
      const declared = base.regions[region.id];
      const list = Array.isArray(savedRegions[region.id]) ? savedRegions[region.id] : [];
      // Only this region's own ids, once each. An id saved under another
      // region is ignored here and takes its default place in its own.
      let order = [];
      for (const id of list) if (typeof id === "string" && own.has(id) && !order.includes(id)) order.push(id);
      for (const id of declared) if (!order.includes(id)) order = insertAtDefault(order, declared, id);
      out.regions[region.id] = order;
    }
    const hidden = Array.isArray(saved.hidden) ? saved.hidden : [];
    for (const s of sectionsOf(spec)) if (!s.keep && hidden.includes(s.id)) out.hidden.push(s.id);
    const sizes = isPlain(saved.sizes) ? saved.sizes : {};
    for (const s of sectionsOf(spec)) if (sizesOf(s).includes(sizes[s.id])) out.sizes[s.id] = sizes[s.id];
    return out;
  }

  /** What is stored: whole orders, the hidden ids, and only the sizes a person changed. */
  function compact(spec, layout) {
    const L = resolve(spec, layout);
    const base = defaults(spec);
    const sizes = {};
    for (const [id, size] of Object.entries(L.sizes)) if (size !== base.sizes[id]) sizes[id] = size;
    return { v: VERSION, regions: L.regions, hidden: L.hidden, sizes };
  }

  const same = (spec, a, b) => JSON.stringify(compact(spec, a)) === JSON.stringify(compact(spec, b));
  const isDefault = (spec, layout) => same(spec, layout, defaults(spec));
  const copy = (L) => ({ v: L.v, regions: Object.fromEntries(Object.entries(L.regions).map(([k, v]) => [k, v.slice()])), hidden: L.hidden.slice(), sizes: { ...L.sizes } });

  /** id moved to index within its own region; any index is clamped to the region. */
  function moveTo(spec, layout, id, index) {
    const region = regionOf(spec, id);
    const L = copy(resolve(spec, layout));
    if (!region) return L;
    const order = L.regions[region.id].filter((x) => x !== id);
    order.splice(Math.max(0, Math.min(order.length, Number(index) || 0)), 0, id);
    L.regions[region.id] = order;
    return L;
  }

  /** id moved by delta places, earlier when negative, never out of its region. */
  function move(spec, layout, id, delta) {
    const region = regionOf(spec, id);
    const L = resolve(spec, layout);
    if (!region) return copy(L);
    return moveTo(spec, L, id, L.regions[region.id].indexOf(id) + delta);
  }

  /** One size step narrower (delta < 0) or wider, within the sizes the section allows. */
  function resize(spec, layout, id, delta) {
    const s = sectionOf(spec, id);
    const L = copy(resolve(spec, layout));
    if (!s) return L;
    const sizes = sizesOf(s);
    const at = Math.max(0, sizes.indexOf(L.sizes[id]));
    L.sizes[id] = sizes[Math.max(0, Math.min(sizes.length - 1, at + Math.sign(delta)))];
    return L;
  }

  /** Shown or hidden. A section the page keeps (the task list itself) cannot be hidden. */
  function setHidden(spec, layout, id, hide) {
    const s = sectionOf(spec, id);
    const L = copy(resolve(spec, layout));
    if (!s || (s.keep && hide)) return L;
    L.hidden = L.hidden.filter((x) => x !== id);
    if (hide) L.hidden.push(id);
    L.hidden.sort((a, b) => sectionsOf(spec).findIndex((x) => x.id === a) - sectionsOf(spec).findIndex((x) => x.id === b));
    return L;
  }

  /** Reset this section: back to its declared place and size, and shown. */
  function resetSection(spec, layout, id) {
    const region = regionOf(spec, id);
    const L = setHidden(spec, layout, id, false);
    if (!region) return L;
    L.regions[region.id] = insertAtDefault(L.regions[region.id], defaults(spec).regions[region.id], id);
    L.sizes[id] = sizeOf(sectionOf(spec, id));
    return L;
  }

  /** A preset as a whole layout. A preset names only what it changes; the rest is the default. */
  function preset(spec, id) {
    const p = (spec.presets || []).find((x) => x.id === id);
    return p ? resolve(spec, { v: VERSION, ...p.layout }) : null;
  }

  /**
   * The layout a page draws with, and where it came from: this project's own
   * row, else the global one, else the page's defaults. A row whose layout is
   * NULL has been reset, and counts as no row.
   */
  function effective(spec, rows, projectId) {
    const list = Array.isArray(rows) ? rows : [];
    const live = (r) => r && r.screen === spec.id && r.layout != null;
    if (spec.scoped && projectId != null) {
      const own = list.find((r) => live(r) && Number(r.project_id) === Number(projectId));
      if (own) return { layout: resolve(spec, own.layout), source: "project" };
    }
    const global = list.find((r) => live(r) && r.project_id == null);
    if (global) return { layout: resolve(spec, global.layout), source: "global" };
    return { layout: defaults(spec), source: "default" };
  }

  /** The words a screen reader hears after each change, and the section's own name. */
  function describe(spec, layout, id) {
    const s = sectionOf(spec, id);
    const region = regionOf(spec, id);
    if (!s || !region) return "";
    const L = resolve(spec, layout);
    const order = L.regions[region.id];
    const bits = [`${s.label}, ${order.indexOf(id) + 1} of ${order.length} in ${region.label}`, SIZE_WORDS[L.sizes[id]]];
    if (L.hidden.includes(id)) bits.push("hidden");
    return bits.join(", ");
  }

  const pure = { VERSION, SIZES, SPAN, SIZE_WORDS, checkSpec, defaults, insertAtDefault, resolve, compact, same, isDefault, move, moveTo, resize, setHidden, resetSection, preset, effective, describe, sectionOf, regionOf };

  // -------------------------------------------------------------------------
  // The window

  const registry = new Map();
  let app = null;
  let rows = [];
  // While a page is being edited: which page, which project it is on, which
  // scope Done saves to (null is every project), the arrangement so far, and
  // the one it started from, which Cancel goes back to.
  let editing = null;
  let drag = null;
  let mounted = null;

  const I = (name, size) => (root.DelphiIcons ? DelphiIcons.icon(name, size) : document.createElement("span"));
  const errText = (e) => String(e && e.message ? e.message : e);

  function register(spec) {
    registry.set(spec.id, checkSpec(spec));
    return spec;
  }

  /**
   * @param lent.state()       app.js's state
   * @param lent.repaint()     draws the window again from what it holds
   * @param lent.notify(text, { error })
   * @param lent.projectName(id)
   */
  function init(lent) { app = lent; }

  /** Every stored layout, from main. Called before the first paint and on every refresh. */
  async function load() {
    try {
      const got = await window.delphi.layout.list();
      if (Array.isArray(got)) rows = got;
    } catch {}
    return rows;
  }

  const editingHere = (screen, projectId) => Boolean(editing && editing.screen === screen && editing.projectId === (projectId ?? null));

  /** The scope a save goes to by default: the project's own when it has one. */
  function defaultTarget(spec, projectId) {
    return spec.scoped && projectId != null && effective(spec, rows, projectId).source === "project" ? projectId : null;
  }

  /** What is stored for one scope exactly, without falling back: null for none. */
  function storedFor(spec, target) {
    const row = rows.find((r) => r.screen === spec.id && r.layout != null && (target == null ? r.project_id == null : Number(r.project_id) === Number(target)));
    return row ? resolve(spec, row.layout) : null;
  }

  // -- the announcer --------------------------------------------------------

  function announce(text) {
    if (typeof document === "undefined") return;
    let live = document.getElementById("ly-live");
    if (!live) {
      live = el("div", { id: "ly-live", className: "ly-sr" });
      live.setAttribute("role", "status");
      live.setAttribute("aria-live", "polite");
      document.body.append(live);
    }
    // Emptied first, so the same words twice (two moves to the end) are read twice.
    live.textContent = "";
    setTimeout(() => { live.textContent = text; }, 30);
  }

  // -- drawing ----------------------------------------------------------------

  /**
   * Arranges a page's sections by its layout and returns the node to append.
   *
   * @param screen     a registered screen id
   * @param parts      { sectionId: Node | null }. Null is a section with nothing
   *                   to show right now (no banner today): left out, except
   *                   while editing, when it is a placeholder that can still be
   *                   moved, so the arrangement does not depend on the day.
   * @param projectId  the project the page is showing, for a scoped screen
   */
  function mount(screen, parts, { projectId = null } = {}) {
    const spec = registry.get(screen);
    const page = el("div", { className: "ly-page" });
    page.dataset.lyScreen = screen;
    if (!spec) {
      for (const node of Object.values(parts)) if (node) page.append(node);
      return page;
    }
    const here = editingHere(screen, projectId);
    // A repaint mid-drag (an agent's write) replaces the cell being dragged;
    // the drag ends where it was rather than holding a node nobody sees.
    if (drag) dragEnd(false);
    const L = here ? editing.draft : effective(spec, rows, projectId).layout;
    if (here) {
      noteFocus();
      page.classList.add("ly-editing");
      page.append(editBar(spec, projectId));
    } else {
      const chip = overrideChip(spec, projectId);
      if (chip) page.append(chip);
    }
    const box = el("div", { className: `ly-regions${spec.regionsClass ? ` ${spec.regionsClass}` : ""}` });
    for (const region of spec.regions) {
      const area = el("div", { className: `ly-region${region.className ? ` ${region.className}` : ""}` });
      area.dataset.lyRegion = region.id;
      if (here) {
        area.setAttribute("role", "group");
        area.setAttribute("aria-label", `${region.label}: sections move only within it`);
        area.append(el("div", { className: "ly-region-name", textContent: region.label }));
      }
      for (const id of L.regions[region.id]) {
        const part = parts[id] == null ? null : parts[id];
        const hidden = L.hidden.includes(id);
        if (!here && (hidden || !part)) continue;
        area.append(cell(spec, sectionOf(spec, id), part, L, here));
      }
      box.append(area);
    }
    page.append(box);
    mounted = { screen, projectId: projectId ?? null };
    showEntry(spec, projectId);
    if (here) setTimeout(() => refocus(page), 0);
    return page;
  }

  function cell(spec, section, part, L, here) {
    const id = section.id;
    const c = el("div", { className: "ly-cell" });
    c.dataset.lyId = id;
    c.style.setProperty("--ly-span", String(SPAN[L.sizes[id]] || 12));
    if (!here) { c.append(part); return c; }

    c.tabIndex = 0;
    c.setAttribute("role", "group");
    c.setAttribute("aria-roledescription", "movable section");
    const tag = el("span", { className: "ly-tag" }, el("span", { className: "ly-grip" }), el("span", { className: "ly-tag-name", textContent: section.label }),
      el("span", { className: "ly-tag-size" }));
    // Mouse only: the keyboard has a key for each, on the section itself, so
    // Tab goes from section to section rather than through four buttons each.
    const tool = (text, label, fn) => {
      const b = el("button", { className: "ly-tool", type: "button", textContent: text, tabIndex: -1 });
      b.setAttribute("aria-label", label);
      b.title = label;
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      return b;
    };
    const narrower = tool("-", "Narrower (Shift and Left)", () => change(resize(spec, editing.draft, id, -1), id));
    const wider = tool("+", "Wider (Shift and Right)", () => change(resize(spec, editing.draft, id, 1), id));
    const hide = tool("Hide", "Hide or show (H)", () => toggle(spec, id));
    hide.classList.add("ly-tool-word", "ly-hide");
    const reset = tool("Reset", "Reset this section (R)", () => change(resetSection(spec, editing.draft, id), id, `${section.label} is back in its own place.`));
    reset.classList.add("ly-tool-word");
    if (section.keep) hide.disabled = true;
    const tools = el("div", { className: "ly-tools" }, tag, el("span", { className: "grow" }), narrower, wider, hide, reset);
    const body = el("div", { className: "ly-body" });
    // inert: what is inside a section is for looking at while arranging, not
    // for clicking, and out of the Tab order so Tab goes section to section.
    body.inert = true;
    body.append(part || el("div", { className: "ly-empty", textContent: section.empty || `${section.label} shows here when there is something in it.` }));
    const strip = el("div", { className: "ly-strip", textContent: "Hidden from this page. Press H, or Show, to bring it back." });
    c.append(tools, body, strip);
    paintCell(spec, c, L);

    c.addEventListener("focus", () => { if (editing) editing.focusKey = `cell:${id}`; });
    c.addEventListener("keydown", (e) => onKey(e, spec, id));
    c.addEventListener("pointerdown", (e) => dragStart(e, spec, c));
    return c;
  }

  /** The parts of a cell that follow the layout: width, hidden, the words. */
  function paintCell(spec, c, L) {
    const id = c.dataset.lyId;
    const s = sectionOf(spec, id);
    const hidden = L.hidden.includes(id);
    c.style.setProperty("--ly-span", String(SPAN[L.sizes[id]] || 12));
    c.classList.toggle("ly-hidden", hidden);
    c.setAttribute("aria-label", describe(spec, L, id));
    const size = c.querySelector(".ly-tag-size");
    if (size) size.textContent = hidden ? "Hidden" : SIZE_WORDS[L.sizes[id]];
    const hide = c.querySelector(".ly-hide");
    if (hide) hide.textContent = hidden ? "Show" : "Hide";
    const sizes = sizesOf(s);
    const at = sizes.indexOf(L.sizes[id]);
    const [narrower, wider] = c.querySelectorAll(".ly-tool:not(.ly-tool-word)");
    if (narrower) narrower.disabled = at <= 0;
    if (wider) wider.disabled = at >= sizes.length - 1;
  }

  /**
   * The draft changed: the cells already on the page are put in the new order
   * and repainted where they stand. Nothing is drawn again and nothing is
   * asked of main, so a keypress costs a few DOM moves.
   */
  function change(next, id, words) {
    // Every edit goes through here (keys, drags, the tools, Reset this page,
    // Save for), so one check holds them all while a save is in flight.
    if (!editing || editing.saving) return;
    const spec = registry.get(editing.screen);
    editing.draft = next;
    const page = document.querySelector(`.ly-page.ly-editing[data-ly-screen="${editing.screen}"]`);
    if (page) {
      const focused = document.activeElement && document.activeElement.closest ? document.activeElement.closest(".ly-cell") : null;
      for (const area of page.querySelectorAll(".ly-region")) {
        const cells = new Map([...area.querySelectorAll(":scope > .ly-cell")].map((c) => [c.dataset.lyId, c]));
        for (const cid of next.regions[area.dataset.lyRegion] || []) {
          const c = cells.get(cid);
          if (!c) continue;
          area.append(c);
          paintCell(spec, c, next);
        }
      }
      // Moving a node takes the focus off it; it goes back, without a scroll jump.
      if (focused && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
      const moved = id && page.querySelector(`.ly-cell[data-ly-id="${id}"]`);
      if (moved && moved.scrollIntoView) moved.scrollIntoView({ block: "nearest" });
    }
    paintBarState();
    if (id) announce(words || `${describe(spec, next, id)}.`);
  }

  function toggle(spec, id) {
    const s = sectionOf(spec, id);
    if (s.keep) { announce(`${s.label} always shows on this page.`); return; }
    const hide = !editing.draft.hidden.includes(id);
    change(setHidden(spec, editing.draft, id, hide), id, `${s.label} ${hide ? "hidden" : "shown"}. ${describe(spec, setHidden(spec, editing.draft, id, hide), id)}.`);
  }

  /**
   * After a repaint while editing (an agent's write), the focus goes back to
   * whatever had it, a section or one of the bar's buttons, by its key: never
   * from the bar onto a section. Only a fresh edit starts on the first section.
   */
  function refocus(page) {
    if (!editing || !page.isConnected) return;
    const a = document.activeElement;
    if (a && a !== document.body && document.contains(a)) return;
    const key = editing.focusKey;
    const target = !key ? page.querySelector(".ly-cell")
      : key.startsWith("cell:") ? page.querySelector(`.ly-cell[data-ly-id="${key.slice(5)}"]`)
      : page.querySelector(`.ly-bar [data-ly-act="${key}"]`);
    if (target) target.focus({ preventScroll: true });
  }

  /** Out of edit mode, the focus lands on the way back in rather than on nothing. */
  function focusEntry() {
    setTimeout(() => {
      const b = document.getElementById("ly-entry");
      const a = document.activeElement;
      if (b && !b.hidden && (!a || a === document.body || !document.contains(a))) b.focus({ preventScroll: true });
    }, 0);
  }

  // -- the keyboard -----------------------------------------------------------

  function onKey(e, spec, id) {
    if (!editing || e.target !== e.currentTarget) return;
    // While a save is on its way nothing changes the draft, but Tab still moves.
    if (editing.saving) { if (e.key !== "Tab") { e.preventDefault(); e.stopPropagation(); } return; }
    const key = e.key;
    const mod = e.metaKey || e.ctrlKey;
    let handled = true;
    if (key === "Escape") cancel();
    else if (mod && key === "Enter") done();
    else if (mod || e.altKey) handled = false;
    else if (e.shiftKey && (key === "ArrowLeft" || key === "ArrowUp")) change(resize(spec, editing.draft, id, -1), id);
    else if (e.shiftKey && (key === "ArrowRight" || key === "ArrowDown")) change(resize(spec, editing.draft, id, 1), id);
    else if (key === "ArrowLeft" || key === "ArrowUp") change(move(spec, editing.draft, id, -1), id);
    else if (key === "ArrowRight" || key === "ArrowDown") change(move(spec, editing.draft, id, 1), id);
    else if (key === "Home") change(moveTo(spec, editing.draft, id, 0), id);
    else if (key === "End") change(moveTo(spec, editing.draft, id, 99), id);
    else if (key === "h" || key === "H") toggle(spec, id);
    else if (key === "r" || key === "R") change(resetSection(spec, editing.draft, id), id, `${sectionOf(spec, id).label} is back in its own place. ${describe(spec, resetSection(spec, editing.draft, id), id)}.`);
    else handled = false;
    // Kept from ui/keys.js, whose single letters (G, J, K, F) would otherwise
    // act on the page behind the arrangement.
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  // Esc from anywhere while editing (the bar's buttons too), and before
  // anything else hears it: a drag in progress first, then the edit.
  function onEscape(e) {
    if (!editing || e.key !== "Escape") return;
    if (document.querySelector("body > .overlay") || (root.DelphiPalette && DelphiPalette.isOpen && DelphiPalette.isOpen())) return;
    e.preventDefault();
    e.stopPropagation();
    if (drag && drag.active) { dragEnd(false); announce("Drag cancelled."); return; }
    cancel();
  }

  // -- dragging -----------------------------------------------------------------

  function dragStart(e, spec, c) {
    if (!editing || editing.saving || e.button !== 0 || (e.target.closest && e.target.closest("button"))) return;
    drag = { spec, cell: c, id: c.dataset.lyId, area: c.parentElement, x0: e.clientX, y0: e.clientY, active: false, index: null };
    try { c.setPointerCapture(e.pointerId); } catch {}
    c.addEventListener("pointermove", dragMove);
    c.addEventListener("pointerup", dragUp);
    c.addEventListener("pointercancel", dragCancel);
  }

  /** Where the pointer would drop, as an index among the region's other cells. */
  function dropIndex(area, dragged, x, y) {
    const others = [...area.querySelectorAll(":scope > .ly-cell")].filter((c) => c !== dragged && !c.classList.contains("ly-slot"));
    const before = others.filter((c) => {
      const r = c.getBoundingClientRect();
      return y > r.bottom || (y >= r.top && x > r.left + r.width / 2);
    }).length;
    return { others, index: before };
  }

  function dragMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < 4) return;
      drag.active = true;
      // The section folds to its name and follows the pointer, and a dashed
      // slot keeps its place, so nothing else on the page moves until the drop.
      const r = drag.cell.getBoundingClientRect();
      drag.slot = el("div", { className: "ly-cell ly-slot" });
      drag.slot.setAttribute("aria-hidden", "true");
      drag.slot.style.setProperty("--ly-span", drag.cell.style.getPropertyValue("--ly-span") || "12");
      drag.slot.style.height = `${r.height}px`;
      drag.cell.before(drag.slot);
      drag.width = Math.min(r.width, 420);
      drag.dx = Math.min(Math.max(0, drag.x0 - r.left), drag.width - 24);
      drag.dy = Math.min(Math.max(0, drag.y0 - r.top), 30);
      drag.cell.style.setProperty("--ly-drag-w", `${drag.width}px`);
      drag.cell.classList.add("ly-dragging");
      drag.area.classList.add("ly-region-live");
    }
    drag.cell.style.left = `${e.clientX - drag.dx}px`;
    drag.cell.style.top = `${e.clientY - drag.dy}px`;
    const { others, index } = dropIndex(drag.area, drag.cell, e.clientX, e.clientY);
    for (const c of others) c.classList.remove("ly-drop-before", "ly-drop-after");
    if (others.length) {
      if (index < others.length) others[index].classList.add("ly-drop-before");
      else others[others.length - 1].classList.add("ly-drop-after");
    }
    drag.index = index;
  }

  function dragUp() { dragEnd(true); }
  function dragCancel() { dragEnd(false); }

  function dragEnd(keep) {
    if (!drag) return;
    const { cell: c, area, active, index, spec, id, slot } = drag;
    drag = null;
    c.removeEventListener("pointermove", dragMove);
    c.removeEventListener("pointerup", dragUp);
    c.removeEventListener("pointercancel", dragCancel);
    c.classList.remove("ly-dragging");
    c.style.left = "";
    c.style.top = "";
    if (slot) slot.remove();
    area.classList.remove("ly-region-live");
    for (const o of area.querySelectorAll(".ly-drop-before, .ly-drop-after")) o.classList.remove("ly-drop-before", "ly-drop-after");
    if (keep && active && index != null && editing) change(moveTo(spec, editing.draft, id, index), id);
  }

  // -- the bar, the chip and the entry -----------------------------------------

  const btn = (text, cls, fn) => {
    const b = el("button", { className: cls, type: "button", textContent: text });
    b.onclick = fn;
    return b;
  };

  const act = (key, b) => { b.dataset.lyAct = key; return b; };

  function editBar(spec, projectId) {
    const bar = el("div", { className: "ly-bar" });
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", `Edit ${spec.label}`);
    const top = el("div", { className: "ly-bar-row" },
      el("span", { className: "ly-bar-t" }, I("sliders", "sm"), el("span", { textContent: `Editing ${spec.label}` })),
      el("span", { className: "ly-bar-hint", textContent: "Drag a section within its area, or Tab to one: arrows move it, Shift and arrows resize, H hides, R resets, Esc cancels." }),
      el("span", { className: "grow" }),
      act("cancel", btn("Cancel", "btn sm", () => cancel())),
      act("done", btn("Done", "btn sm primary ly-done", () => done())));
    const presets = el("div", { className: "ly-presets" }, el("span", { className: "ly-bar-k", textContent: "Presets" }));
    for (const p of spec.presets || []) {
      const b = act(`preset-${p.id}`, btn(p.label, "ly-preset", () => applyPreset(spec.id, p.id)));
      if (p.desc) b.title = p.desc;
      b.dataset.preset = p.id;
      presets.append(b);
    }
    const second = el("div", { className: "ly-bar-row ly-bar-row2" }, presets);
    if (spec.scoped && projectId != null) {
      const seg = el("div", { className: "seg-sm ly-scope", role: "group" });
      seg.setAttribute("aria-label", "Save this layout for");
      const name = (app && app.projectName ? app.projectName(projectId) : "") || "this project";
      for (const [target, label] of [[null, "All projects"], [projectId, `Only ${name}`]]) {
        const b = btn(label, "", () => setTarget(spec, target));
        b.dataset.target = target == null ? "all" : "project";
        act(`scope-${b.dataset.target}`, b);
        seg.append(b);
      }
      second.append(el("span", { className: "ly-bar-k", textContent: "Save for" }), seg);
    }
    second.append(el("span", { className: "grow" }),
      act("reset-page", btn("Reset this page", "btn sm ly-reset-page", () => resetPage())),
      act("reset-all", btn("Reset everything", "btn sm ly-reset-all", () => resetEverything())));
    bar.append(top, second);
    bar.addEventListener("focusin", (e) => {
      const k = e.target.closest && e.target.closest("[data-ly-act]");
      if (editing && k) editing.focusKey = k.dataset.lyAct;
    });
    setTimeout(paintBarState, 0);
    return bar;
  }

  /** The pressed states in the bar, from the draft. */
  function paintBarState() {
    if (!editing || typeof document === "undefined") return;
    const spec = registry.get(editing.screen);
    for (const b of document.querySelectorAll(".ly-bar .ly-preset")) {
      const p = preset(spec, b.dataset.preset);
      b.setAttribute("aria-pressed", String(Boolean(p && same(spec, p, editing.draft))));
    }
    for (const b of document.querySelectorAll(".ly-bar .ly-scope button")) {
      b.setAttribute("aria-pressed", String((b.dataset.target === "all") === (editing.target == null)));
    }
  }

  function overrideChip(spec, projectId) {
    if (!spec.scoped || projectId == null || effective(spec, rows, projectId).source !== "project") return null;
    const name = (app && app.projectName ? app.projectName(projectId) : "") || "this project";
    const use = btn("Use global", "ly-chip-b", () => useGlobal(spec.id, projectId));
    return el("div", { className: "ly-chip-row" },
      el("span", { className: "ly-chip" }, I("sliders", "sm"), el("span", { textContent: `Custom layout for ${name}.` }), use));
  }

  /** "Edit this page" in the heading, on a page that has a layout and is not being edited. */
  function showEntry(spec, projectId) {
    if (typeof document === "undefined") return;
    const head = document.querySelector(".head-top");
    if (!head) return;
    let b = document.getElementById("ly-entry");
    if (!b) {
      b = el("button", { id: "ly-entry", className: "btn sm ly-entry", type: "button" }, I("sliders", "sm"), el("span", { textContent: "Edit this page" }));
      const metrics = document.getElementById("metrics");
      head.insertBefore(b, metrics && metrics.parentElement === head ? metrics : null);
    }
    b.hidden = Boolean(editing);
    b.onclick = () => start(spec.id, projectId);
  }

  /**
   * What has the focus on the editing page, by key, read while it is still
   * there, so refocus can put it back on the new page. Not left to focus
   * events alone, which a window without the system's focus does not send.
   */
  function noteFocus() {
    if (!editing || typeof document === "undefined") return;
    const a = document.activeElement;
    if (!a || !a.closest || !a.closest(".ly-page.ly-editing")) return;
    const bar = a.closest("[data-ly-act]");
    const cellOf = a.closest(".ly-cell[data-ly-id]");
    if (bar) editing.focusKey = bar.dataset.lyAct;
    else if (cellOf) editing.focusKey = `cell:${cellOf.dataset.lyId}`;
  }

  /** From MOUNTS, before the page draws: the entry hides unless a mount shows it again. */
  function paint(state) {
    noteFocus();
    const b = typeof document !== "undefined" ? document.getElementById("ly-entry") : null;
    if (b) b.hidden = true;
    mounted = null;
    if (editing && state && screenOf(state) !== `${editing.screen}:${editing.projectId ?? ""}`) {
      // Left the page mid-edit: nothing was saved, and nothing is kept.
      stopEditing();
    }
  }

  /** Which layout screen a state shows, as "screen:project", or null. */
  function screenOf(s) {
    if (!s || s.query) return null;
    if (s.view === "today" && !s.projectId) return "today:";
    if (s.view === "runs" && !s.projectId) return "runs:";
    if (s.view === "tasks") return `tasks:${s.projectId ?? ""}`;
    return null;
  }

  // -- the verbs -----------------------------------------------------------------

  function start(screen, projectId = null) {
    const spec = registry.get(screen);
    if (!spec) return;
    const target = defaultTarget(spec, projectId);
    const now = effective(spec, rows, projectId).layout;
    editing = { screen, projectId: projectId ?? null, target, draft: now, start: now, focusKey: null, saving: false };
    document.addEventListener("keydown", onEscape, true);
    if (app) app.repaint();
    announce(`Editing ${spec.label}. Tab to a section; arrows move it, Shift and arrows resize it, H hides it. Done saves, Esc cancels.`);
  }

  function stopEditing() {
    if (drag) dragEnd(false);
    editing = null;
    if (typeof document !== "undefined") document.removeEventListener("keydown", onEscape, true);
  }

  function cancel() {
    if (!editing) return;
    // A Done already on its way to main is not taken back by an Esc that
    // arrives before the answer: what is saved and what the page says agree.
    if (editing.saving) { announce("Saving the layout."); return; }
    stopEditing();
    if (app) app.repaint();
    focusEntry();
    announce("Edit cancelled. Nothing was changed.");
  }

  /** Switching who Done saves for. An untouched draft follows to that scope's own layout. */
  function setTarget(spec, target) {
    if (!editing || editing.saving) return;
    const untouched = same(spec, editing.draft, editing.start);
    editing.target = target;
    if (untouched) {
      const next = storedFor(spec, target) || (target == null ? defaults(spec) : effective(spec, rows, null).layout);
      editing.start = next;
      change(next, null);
    }
    paintBarState();
    announce(target == null ? "Done saves this layout for every project." : `Done saves this layout for ${app && app.projectName ? app.projectName(target) : "this project"} only.`);
  }

  /**
   * What a scope stores for a layout: nothing (a reset) when it is what that
   * scope would inherit anyway, so a later change to the global layout, or a
   * later version's defaults, still reaches it; otherwise the compact JSON.
   */
  function toStore(spec, target, layout) {
    const inherited = target == null ? defaults(spec) : effective(spec, rows, null).layout;
    return same(spec, layout, inherited) ? null : compact(spec, layout);
  }

  async function save(spec, target, layout, note) {
    rows = await window.delphi.layout.save({ screen: spec.id, projectId: target, layout, note });
    return rows;
  }

  async function done() {
    if (!editing || editing.saving) return;
    const spec = registry.get(editing.screen);
    const { target, draft } = editing;
    const stored = storedFor(spec, target);
    // With nothing stored for this scope, unchanged means the same as what it
    // inherits: the page's own for everyone, the global layout for a project,
    // so Done on an untouched page never writes an override nobody made.
    const inherited = target == null ? defaults(spec) : effective(spec, rows, null).layout;
    const unchanged = same(spec, stored || inherited, draft);
    const was = editing;
    was.saving = true;
    try {
      if (!unchanged) await save(spec, target, toStore(spec, target, draft), null);
    } catch (error) {
      was.saving = false;
      if (app) app.notify(`The layout was not saved: ${errText(error)}`, { error: true });
      return;
    }
    was.saving = false;
    if (editing === was) stopEditing();
    if (app) {
      app.repaint();
      if (!unchanged) app.notify("Layout saved. History can undo it.");
    }
    focusEntry();
    announce(unchanged ? "Nothing changed." : "Layout saved.");
  }

  /** A preset, saved at once: one click, one History row, no Done needed. */
  async function applyPreset(screen, id) {
    const spec = registry.get(screen);
    const p = spec && (spec.presets || []).find((x) => x.id === id);
    if (!p || (editing && editing.saving)) return;
    const projectId = editing ? editing.projectId : (mounted ? mounted.projectId : null);
    const target = editing ? editing.target : defaultTarget(spec, projectId);
    const L = preset(spec, id);
    const value = toStore(spec, target, L);
    if (value == null && !storedFor(spec, target)) {
      // Already what this scope draws: nothing to save, and nothing for History.
      stopEditing();
      if (app) { app.repaint(); app.notify(`${spec.label} already looks like ${p.label}.`); }
      focusEntry();
      return;
    }
    const was = editing;
    if (was) was.saving = true;
    try {
      await save(spec, target, value, `${p.label} preset`);
    } catch (error) {
      if (was) was.saving = false;
      if (app) app.notify(`The ${p.label} layout was not applied: ${errText(error)}`, { error: true });
      return;
    }
    if (was) was.saving = false;
    // Only the edit this preset was applied from: one started since is not its to end.
    if (editing === was) stopEditing();
    if (app) { app.repaint(); app.notify(`${p.label} layout applied. History can undo it.`); }
    focusEntry();
    announce(`${p.label} layout applied.`);
  }

  /** Reset this page: in the editor, the draft goes back to the page's own; from Cmd+K, saved at once. */
  async function resetPage() {
    if (editing) {
      const spec = registry.get(editing.screen);
      change(defaults(spec), null);
      announce("Every section is back in its own place. Done saves it, Esc keeps the old one.");
      return;
    }
    if (!mounted) return;
    const spec = registry.get(mounted.screen);
    const target = defaultTarget(spec, mounted.projectId);
    if (!storedFor(spec, target)) { if (app) app.notify(`${spec.label} already has its own layout.`); return; }
    try { await save(spec, target, null, "page reset"); } catch (error) { if (app) app.notify(errText(error), { error: true }); return; }
    if (app) { app.repaint(); app.notify(`${spec.label} is back to its own layout. History can undo it.`); }
    focusEntry();
  }

  async function resetEverything() {
    if (editing && editing.saving) return;
    if (!confirm("Reset the layout of every page, for every project? Each one is in History and can be undone there.")) return;
    // Held like a Done, so nothing edited while main resets is quietly lost.
    const was = editing;
    if (was) was.saving = true;
    try { rows = await window.delphi.layout.resetAll(); } catch (error) {
      if (was) was.saving = false;
      if (app) app.notify(errText(error), { error: true });
      return;
    }
    if (was) was.saving = false;
    if (editing === was) stopEditing();
    if (app) { app.repaint(); app.notify("Every page is back to its own layout. History can undo it."); }
    focusEntry();
    announce("Every page's layout was reset.");
  }

  async function useGlobal(screen, projectId) {
    const spec = registry.get(screen);
    if (!spec || !storedFor(spec, projectId)) return;
    try { await save(spec, projectId, null, "back to the global layout"); } catch (error) { if (app) app.notify(errText(error), { error: true }); return; }
    if (app) { app.repaint(); app.notify(`${app.projectName ? app.projectName(projectId) || "This project" : "This project"} uses the global layout again. History can undo it.`); }
    focusEntry();
    announce("Using the global layout.");
  }

  /** For Cmd+K. Each acts on the page in front, and says so when it has no layout. */
  function commands() {
    const here = (fn) => () => {
      if (!mounted || !registry.has(mounted.screen)) { if (app) app.notify("This page has no sections to arrange."); return; }
      return fn(registry.get(mounted.screen));
    };
    return [
      { id: "layout-edit", group: "Commands", title: "Edit this page", run: here((spec) => start(spec.id, mounted.projectId)) },
      { id: "layout-focus", group: "Commands", title: "Layout: Focus preset for this page",
        run: here((spec) => ((spec.presets || []).some((p) => p.id === "focus") ? applyPreset(spec.id, "focus") : app && app.notify("This page has no Focus preset."))) },
      { id: "layout-reset-page", group: "Commands", title: "Layout: reset this page", run: here(() => resetPage()) },
      { id: "layout-reset-all", group: "Commands", title: "Layout: reset every page", run: () => resetEverything() },
    ];
  }

  /**
   * Whether a section is shown by the stored layout, for a page that keeps
   * state behind one. The draft is not asked: an edit not yet saved, and
   * maybe cancelled, must not make a page let go of anything.
   */
  function shown(screen, id, projectId = null) {
    const spec = registry.get(screen);
    if (!spec) return true;
    return !effective(spec, rows, projectId).layout.hidden.includes(id);
  }

  /** A page drew without its layout (Today's first run): an edit of it ends, unsaved. */
  function leave(screen) {
    if (editing && editing.screen === screen) stopEditing();
  }

  const api = {
    ...pure, pure, register, init, load, mount, paint, commands, shown, leave, start, cancel, done, applyPreset, resetPage, resetEverything, useGlobal,
    spec: (id) => registry.get(id) || null, screens: () => [...registry.keys()], isEditing: () => Boolean(editing),
    rows: () => rows,
  };
  root.DelphiLayout = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
