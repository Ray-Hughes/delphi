// Add folder as project, and the bar that offers to fix a folder that moved.
//
// This is the way in for a new project with its Home folder: the switcher's
// "Add folder as project...", the Cmd+K command, or a folder dropped anywhere
// on the window. Each asks the main process what the folder is
// (main/folders.js inspect, which writes nothing) and shows one sheet: the
// repository root, the remote and default branch, a name and a key. Three
// answers change it, because they are the mistakes it exists to catch:
//
//   - projects already work in the folder: named, each a click away, and a
//     new one still allowed, since a folder can be several projects';
//   - a project with no folder has the folder's name: offer to link the two,
//     because it is probably the same work, filed before it had a folder;
//   - it is a subfolder or a Workbench: the project is the repository, and
//     the sheet says which.
//
// The fix-it bar is for a project whose folder is not on disk any more. It is
// a suggestion, not an alarm: a drive that is not mounted looks the same, so
// it offers to point the project somewhere else and is easy to put away.
//
// Builds DOM nodes only: folder names and remotes come from disk and from git.

globalThis.DelphiAddFolder = (() => {
  const I = (name, size) => DelphiIcons.icon(name, size);
  let app = null;
  let sheet = null;          // { overlay, close }
  const putAway = new Set(); // project ids whose fix-it bar was put away this run

  const say = (text, error = false) => (app && app.notify ? app.notify(text, { error }) : null);
  const plainError = (e) => String(e && e.message ? e.message : e);

  /** One sheet at a time, over the window, with Esc and the focus handled. */
  function openSheet(build, { label }) {
    closeSheet();
    const before = document.activeElement;
    const overlay = el("div", { className: "overlay af-overlay" });
    const box = el("div", { className: "ask af", role: "dialog" });
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", label);
    overlay.append(box);
    const close = () => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      if (sheet && sheet.overlay === overlay) sheet = null;
      if (before && before.isConnected) before.focus({ preventScroll: true });
    };
    // Captured, so one Escape closes this and nothing behind it.
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "Tab") {
        // The focus stays in the sheet while it is open.
        const stops = [...box.querySelectorAll("button, input")].filter((n) => !n.disabled);
        if (!stops.length) return;
        const first = stops[0];
        const last = stops[stops.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    sheet = { overlay, close };
    build(box, close);
    document.body.append(overlay);
    (box.querySelector("input") || box.querySelector(".btn.primary") || box.querySelector("button"))?.focus();
    return sheet;
  }
  function closeSheet() { if (sheet) sheet.close(); }

  const fact = (label, value, { mono = false, tone = "" } = {}) =>
    el("div", { className: "af-fact" }, el("span", { className: "af-k", textContent: label }),
      el("span", { className: `af-v${mono ? " mono" : ""}${tone ? ` ${tone}` : ""}`, textContent: value }));

  /**
   * Asks about a folder (null shows the picker) and then does the right one
   * of: switch, link, or the sheet. Resolves when the person is done.
   */
  async function open(folder = null) {
    let look;
    try { look = await window.delphi.folders.inspect(folder); } catch (e) { say(plainError(e), true); return; }
    if (!look || look.cancelled) return;
    if (!look.ok) { say(look.why || "That folder cannot be added.", true); return; }
    showSheet(look);
  }

  function showSheet(look) {
    const name = look.suggestedName;
    openSheet((box, close) => {
      const title = `Add ${name} as a project`;
      box.append(el("h3", { textContent: title }));

      const facts = el("div", { className: "af-facts" });
      facts.append(fact("Folder", look.shown, { mono: true }));
      if (look.isGit) {
        facts.append(fact("Repository", look.ownerRepo || look.remote || "No remote", { mono: Boolean(look.ownerRepo || look.remote) }));
        facts.append(fact("Default branch", look.defaultBranch || "Not known yet", { mono: Boolean(look.defaultBranch) }));
      } else {
        facts.append(fact("Repository", "Not a git repository. Workbenches will not be available.", { tone: "warn" }));
      }
      box.append(facts);
      if (look.subfolder) box.append(el("p", { className: "af-note", textContent: `You chose a folder inside a repository. The project is the repository itself, ${look.shown}.` }));
      if (look.worktreeOf) box.append(el("p", { className: "af-note", textContent: `${look.worktreeOf} is a Workbench (a second copy of a repository). The project is its main repository, ${look.shown}.` }));

      const msg = el("div", { className: "err-msg", role: "alert" });
      const actions = el("div", { className: "ask-actions" });
      const cancel = el("button", { className: "btn", type: "button", textContent: "Cancel" });
      cancel.onclick = close;

      // Projects that work in this folder already. A folder can be several
      // projects', so a new one is still allowed; each is a click away when it
      // is the one that was meant.
      const live = (look.holders || []).filter((h) => !h.archived);
      if (live.length) {
        const offer = el("div", { className: "af-match" });
        offer.append(I("folder", "sm"), el("span", { className: "grow", textContent: `${look.shown} is ${live.map((h) => h.name).join(" and ")}'s already. Add another project for different work in it, or open the one you meant.` }));
        for (const h of live.slice(0, 3)) {
          const go = el("button", { className: "btn sm", type: "button", textContent: `Open ${h.name}` });
          go.onclick = async () => { close(); await app.go({ projectId: h.id, view: "overview" }); };
          offer.append(go);
        }
        box.append(offer);
      }

      // A project with no folder and this folder's name: offered first.
      for (const m of look.matches || []) {
        const offer = el("div", { className: "af-match" });
        const link = el("button", { className: "btn sm primary", type: "button", textContent: `Use it for ${m.name}` });
        link.onclick = async () => {
          link.disabled = true;
          try {
            await window.delphi.folders.set(m.id, look.top);
            close();
            await app.refresh();
            await app.go({ projectId: m.id, view: "overview" });
            say(`${m.name} has a folder now: ${look.shown}.`);
          } catch (e) { msg.textContent = plainError(e); link.disabled = false; }
        };
        offer.append(I("folder", "sm"), el("span", { className: "grow", textContent: `${m.name} has no folder yet, and the same name. Is this its folder?` }), link);
        box.append(offer);
      }

      const nameIn = el("input", { className: "field", value: name, spellcheck: false });
      nameIn.setAttribute("aria-label", "Project name");
      const keyIn = el("input", { className: "field mono", value: look.suggestedKey, spellcheck: false });
      keyIn.setAttribute("aria-label", "Project key");
      box.append(el("div", { className: "af-fields" },
        el("label", { className: "af-field" }, el("span", { className: "af-k", textContent: "Name" }), nameIn),
        el("label", { className: "af-field af-keyfield" }, el("span", { className: "af-k", textContent: "Key" }), keyIn)));
      box.append(msg);

      const add = el("button", { className: "btn primary", type: "button", textContent: (look.matches || []).length ? "Add a new project instead" : "Add project" });
      if ((look.matches || []).length) add.className = "btn";
      const submit = async () => {
        if (!nameIn.value.trim()) { msg.textContent = "A project needs a name."; nameIn.focus(); return; }
        add.disabled = true;
        try {
          const made = await window.delphi.folders.create({ path: look.top, name: nameIn.value.trim(), key: keyIn.value.trim() });
          close();
          await app.refresh();
          await app.go({ projectId: made.id, view: "overview" });
          say(`${made.name} is a project now, in ${look.shown}.`);
        } catch (e) { msg.textContent = plainError(e); add.disabled = false; }
      };
      add.onclick = submit;
      for (const input of [nameIn, keyIn]) input.onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); } };
      actions.append(cancel, add);
      box.append(actions);
    }, { label: `Add ${name} as a project` });
  }

  // --- dropping a folder on the window ---------------------------------------

  const hasFiles = (e) => Boolean(e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files"));

  /**
   * A folder dropped anywhere on the window. Only drags that carry files are
   * touched, so moving a card between columns is left alone, and a dropped
   * file is refused with a sentence rather than opened, which is what
   * Electron does with a drop nobody handles.
   */
  function installDrop() {
    let depth = 0;
    let shade = null;
    const show = () => {
      if (shade) return;
      shade = el("div", { className: "af-drop" }, el("div", { className: "af-drop-card" }, I("folderplus"), el("b", { textContent: "Drop a folder to add it as a project" }),
        el("span", { textContent: "A folder that is already a project opens it instead." })));
      shade.setAttribute("aria-hidden", "true");
      document.body.append(shade);
    };
    const hide = () => { depth = 0; if (shade) { shade.remove(); shade = null; } };
    document.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; depth += 1; show(); });
    document.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) hide(); });
    document.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    document.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      hide();
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      const folder = file ? window.delphi.pathForFile(file) : null;
      if (!folder) { say("That drop did not carry a folder Delphi can read.", true); return; }
      open(folder);
    });
    window.addEventListener("blur", hide);
  }

  // --- the fix-it bar ----------------------------------------------------------

  /**
   * On every render: the bar for the project in view when its folder is not on
   * disk, above the page heading where the recovery banner goes, so a repaint
   * of the page never takes it away.
   */
  function paintFix(state) {
    const host = document.querySelector("main.main");
    const old = document.getElementById("folder-fix");
    const p = state.projectId != null ? state.projects.find((x) => x.id === state.projectId) : null;
    const want = p && p.path && p.folder_missing && !putAway.has(p.id) ? `${p.id}\n${p.path}` : null;
    if (old && old.dataset.for === want) return;
    if (old) old.remove();
    if (!want || !host) return;

    const tilde = String(p.path).replace(/^\/Users\/[^/]+/, "~");
    const bar = el("section", { id: "folder-fix", className: "folder-fix" });
    bar.dataset.for = want;
    bar.setAttribute("aria-label", `${p.name}'s folder is missing`);
    const msg = el("span", { className: "folder-fix-msg", role: "status" });
    const choose = el("button", { className: "btn sm primary", type: "button", textContent: "Choose where it is now" });
    const none = el("button", { className: "btn sm", type: "button", textContent: "Use no folder" });
    const later = el("button", { className: "btn sm ghost", type: "button", textContent: "Not now" });
    const busy = (on) => { choose.disabled = none.disabled = later.disabled = on; };
    choose.onclick = async () => {
      busy(true);
      try {
        const look = await window.delphi.folders.inspect(null);
        if (look && look.ok) {
          await window.delphi.folders.set(p.id, look.top);
          await app.refresh();
          say(`${p.name}'s folder is ${look.shown} now.`);
          return;
        }
        if (look && !look.cancelled) msg.textContent = look.why || "That folder cannot be used.";
      } catch (e) { msg.textContent = plainError(e); }
      busy(false);
    };
    none.onclick = async () => {
      busy(true);
      try {
        await window.delphi.folders.clear(p.id);
        await app.refresh();
        say(`${p.name} is under No folder now. History can put its folder back.`);
      } catch (e) { msg.textContent = plainError(e); busy(false); }
    };
    later.onclick = () => { putAway.add(p.id); bar.remove(); };
    const dot = el("span", { className: "folder-fix-dot" });
    dot.setAttribute("aria-hidden", "true");
    bar.append(dot,
      el("div", { className: "folder-fix-words" },
        el("b", { textContent: `${p.name}'s folder is not where it was.` }),
        el("span", {}, el("span", { className: "mono", textContent: tilde }), " is not there any more. If it moved, point the project at where it is now; if it is on a drive that is not connected, this goes away once it is."),
        msg),
      el("div", { className: "folder-fix-acts" }, choose, none, later));
    const banner = document.getElementById("recovery-banner");
    if (banner && banner.parentNode === host) banner.after(bar); else host.prepend(bar);
  }

  function init(lent) {
    app = lent;
    installDrop();
  }

  return { init, open, paintFix, closeSheet, isOpen: () => Boolean(sheet) };
})();
