// The keyboard: Cmd+K, G then a letter, and J, K, Enter and E in a list.
//
// G then a letter goes to a place (ui/commands.js says which letter is which):
// the second key has to come within 1.5 seconds, or the G is forgotten. In a
// list, J and K move a highlight down and up the tasks, Enter opens the one
// highlighted (Shift and Enter in the view taskOpenMode does not choose), and
// E opens it to edit its title. F (or whichever key the
// focusLetter setting names) opens Focus mode, on the highlighted row's task when
// there is one; ui/focus.js decides, through app.singleKey, so this file never
// needs to know the setting.
//
// No single key fires while the focus is in somewhere to type, or while a
// panel, a menu or the bar is open over the page: those own the keyboard. The
// menu's accelerators (Cmd+1 to 4, Cmd+N, Cmd+,) are the main process's and
// are left alone.
//
// The modifier is Cmd on macOS and Ctrl elsewhere, and only that one (modKey
// in ui/core.js): on a Mac, Ctrl+K, Ctrl+P and Ctrl+F belong to the text box
// the focus is in, and a key with Ctrl held is never a single-key shortcut.

globalThis.DelphiKeys = (() => {
  const CHORD_MS = 1500;
  let gAt = 0;

  const typing = (node) => Boolean(node && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)));

  /** The task rows on screen, in the order they are drawn. */
  const rows = () => [...document.querySelectorAll("#content [data-task-id]")].filter((n) => n.offsetParent !== null);

  function move(by) {
    const all = rows();
    if (!all.length) return;
    const at = all.findIndex((n) => n.classList.contains("kbd-hi"));
    const next = all[Math.max(0, Math.min(all.length - 1, at < 0 ? 0 : at + by))];
    for (const n of all) n.classList.remove("kbd-hi");
    next.classList.add("kbd-hi");
    next.scrollIntoView({ block: "nearest" });
  }
  const lit = () => document.querySelector("#content [data-task-id].kbd-hi");

  /**
   * @param app.commands()       the registry
   * @param app.busy()           true while a panel or menu owns the keyboard
   * @param app.openBar()        the Cmd+K bar
   * @param app.openSwitcher()   the project switcher (Cmd+P)
   * @param app.openTask(id, how) how is "open" or "edit"
   * @param app.singleKey(key, taskId) optional; true when it took the key
   */
  function install(app) {
    document.addEventListener("keydown", (e) => {
      const mod = modKey(e);
      // Not over an open panel: what the bar opens would land behind it, and
      // the panel would be left over a page it does not belong to.
      const lower = String(e.key || "").toLowerCase();
      if (mod && !e.shiftKey && !e.altKey && (lower === "k" || lower === "f")) {
        if (app.busy()) return;
        e.preventDefault();
        e.stopPropagation();
        app.openBar();
        return;
      }
      // Cmd+P is the switcher, from anywhere a panel is not open.
      if (mod && !e.shiftKey && !e.altKey && lower === "p" && !app.busy() && !window.DelphiPalette?.isOpen()) {
        e.preventDefault();
        app.openSwitcher();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || app.busy() || window.DelphiPalette?.isOpen()) return;
      // Shift on its own is the first half of a capital, not a key of its own:
      // it must not cancel a G waiting for its letter.
      if (["Shift", "Meta", "Control", "Alt", "CapsLock"].includes(e.key)) return;

      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (gAt && Date.now() - gAt <= CHORD_MS) {
        gAt = 0;
        const c = DelphiCommands.chord(app.commands(), key);
        if (c) { e.preventDefault(); c.run(); }
        return;
      }
      gAt = 0;
      if (key === "g" && !e.shiftKey) { gAt = Date.now(); return; }
      if (app.singleKey && !e.shiftKey) {
        const row = lit();
        if (app.singleKey(key, row ? Number(row.dataset.taskId) : null)) { e.preventDefault(); return; }
      }
      if (key === "j") { e.preventDefault(); move(1); return; }
      if (key === "k") { e.preventDefault(); move(-1); return; }
      const row = lit();
      if (!row) return;
      // Only with nothing else focused: Enter on a button or a checkbox is that
      // control's own, whatever row the keyboard last stopped on.
      const focus = document.activeElement;
      if (focus && focus !== document.body && !row.contains(focus)) return;
      const how = e.key === "Enter" ? (e.shiftKey ? "full" : "open") : key === "e" ? "edit" : null;
      if (how) { e.preventDefault(); app.openTask(Number(row.dataset.taskId), how); }
    });
  }

  return { install, CHORD_MS };
})();
