// A project's folders, and the work Delphi filed into a shared one.
//
// A folder may be several projects' and a project several folders' (slice
// 4b). Three things here follow from that:
//
//   The Folders list, on the project's Settings and its Overview: each folder
//   with its remote and branch, Home marked, and who else works in it. Add,
//   take off, and make Home. Home is projects.path, so making one Home is a
//   project update History can undo; adding and taking off are recorded too.
//
//   The "Filed under" chip. When an agent filed something without naming a
//   project and Delphi had to choose between the projects sharing its folder
//   (workbench/route.js), the item says so, "Filed under SSNR, from branch",
//   with a Move to each of the other projects there, through the item store
//   like every other move, and "That's right", which keeps it where it is.
//
//   The folder picker in the drawer's Workbench section: which of the
//   project's folders a task's Workbench starts in, shown only when there is a
//   choice to make. It writes tasks.repo_id.
//
// It owns no data and reads through window.delphi; what it needs from app.js
// is lent through init(). Nodes are built, never innerHTML, because every
// word here came from the database.

globalThis.DelphiFolderList = (() => {
  const I = (name, size) => DelphiIcons.icon(name, size);
  let app = null;
  let routes = new Map();

  const ownerRepo = (remote) => {
    if (!remote) return null;
    const m = String(remote).trim().replace(/\.git$/, "").match(/[:/]([^/:]+)\/([^/]+)$/);
    return m ? `${m[1]}/${m[2]}` : String(remote);
  };
  const plainError = (e) => String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

  // --- the Folders list -----------------------------------------------------

  function folderRow(project, f, { onChange, say }) {
    const row = el("div", { className: "list-row fl-row" + (f.home ? " home" : "") });
    row.dataset.folder = f.path;
    const badge = f.home
      ? el("span", { className: "kind decision fl-home", textContent: "Home" })
      : el("span", { className: "kind fl-linked", textContent: "Linked" });
    if (f.home) badge.title = `${project.name}'s Home: where its jobs, runs and sessions work unless a task says otherwise.`;
    const facts = [];
    const repo = ownerRepo(f.remote_url);
    if (repo) facts.push(repo);
    if (f.default_branch) facts.push(`branch ${f.default_branch}`);
    if (!f.exists) facts.push("not on disk right now");
    const meta = el("div", { className: "fl-meta" });
    if (facts.length) meta.append(el("span", { textContent: facts.join(" · ") }));
    if (f.also && f.also.length) {
      meta.append(el("span", { className: "fl-also", textContent: `Also ${f.also.map((h) => h.name).join(", ")}` }));
    }
    const acts = el("div", { className: "repo-acts" });
    const act = (label, run, title = "") => {
      const b = el("button", { className: "btn sm", type: "button", textContent: label });
      if (title) b.title = title;
      b.onclick = async () => {
        b.disabled = true;
        let done;
        try { done = await run(); } catch (e) { say(plainError(e), true); b.disabled = false; return; }
        if (done === false) { b.disabled = false; b.focus(); return; }
        await onChange();
      };
      acts.append(b);
      return b;
    };
    if (!f.home) {
      act("Make Home", async () => { await window.delphi.folders.home(project.id, f.path); app.notify(`${f.shown} is ${project.name}'s Home now. History can put it back.`); },
        "Where this project's jobs, runs and sessions work. The current Home stays, as a linked folder.");
    }
    if (f.repo_id != null && app.repoRow && app.repoSettings) {
      const b = el("button", { className: "btn sm", type: "button", textContent: "Workbench settings" });
      b.onclick = async () => { const r = app.repoRow(f.repo_id); if (r && await app.repoSettings(r)) await onChange(); };
      acts.append(b);
    }
    if (!f.home) {
      act("Remove", async () => {
        const ok = await app.confirm({
          title: `Take ${f.shown} off ${project.name}?`,
          lead: "The folder and everything in it stay as they are. Tasks that worked in it go back to the project's Home. History can put it back.",
          confirm: "Take it off",
        });
        if (!ok) return false;
        await window.delphi.folders.remove(project.id, f.path);
        app.notify(`${f.shown} is off ${project.name}. History can put it back.`);
      });
    }
    row.append(badge, el("div", { className: "grow" },
      el("div", { className: "fl-name", textContent: f.name }),
      el("div", { className: "mono repo-path", textContent: f.shown, title: f.path }),
      meta, acts));
    return row;
  }

  /**
   * Draws the list into `box`, and again after every change. Resolves once
   * it is drawn, so a caller (or a test) can wait for it.
   */
  async function mount(box, project, { onChanged = null } = {}) {
    box.classList.add("fl-list");
    box.dataset.project = String(project.id);
    const msg = el("div", { className: "hint fl-msg", role: "status" });
    const say = (text, error = false) => { msg.className = error ? "err-msg fl-msg" : "hint fl-msg"; msg.textContent = text; };
    let list = [];
    const paint = () => {
      box.textContent = "";
      if (!list.length) {
        box.append(el("div", { className: "fl-empty" },
          el("p", { textContent: `${project.name} has no folder yet. Add the repository its code is in, and any others its work spans.` })));
      }
      for (const f of list) box.append(folderRow(project, f, { onChange: reload, say }));
      const add = el("button", { className: "btn sm", type: "button" }, I("folderplus", "sm"), el("span", { textContent: list.length ? "Add a folder" : "Add its folder" }));
      add.dataset.act = "add-folder";
      add.onclick = async () => {
        add.disabled = true;
        let done = null;
        try { done = await window.delphi.folders.add(project.id, null); } catch (e) { say(plainError(e), true); add.disabled = false; return; }
        if (!done || done.cancelled) { add.disabled = false; add.focus(); return; }
        app.notify(done.added ? `${done.shown} is ${done.home ? `${project.name}'s Home` : `one of ${project.name}'s folders`} now. History can put it back.` : `${done.shown} is one of ${project.name}'s folders already.`);
        await reload();
      };
      box.append(el("div", { className: "fl-foot" }, add, msg));
    };
    async function reload() {
      try { list = await window.delphi.folders.list(project.id); } catch (e) { list = []; say(plainError(e), true); }
      paint();
      if (onChanged) await onChanged();
    }
    try { list = await window.delphi.folders.list(project.id); } catch { list = []; }
    paint();
    return box;
  }

  // --- the "Filed under" chip -------------------------------------------------

  /** Read with everything else on a refresh; one list for every chip. */
  async function load() {
    try {
      const rows = await window.delphi.folders.routes();
      routes = new Map(rows.map((r) => [`${r.entity}:${r.entity_id}`, r]));
    } catch { routes = new Map(); }
  }
  const routeOf = (entity, id) => routes.get(`${entity}:${Number(id)}`) || null;

  /** The chip for an item Delphi filed by a guess, or null. */
  function chip(entity, item) {
    const r = item ? routeOf(entity, item.id) : null;
    if (!r) return null;
    const b = el("button", { className: "route-chip", type: "button" }, I("folder", "xs"), el("span", { textContent: r.words }));
    b.dataset.route = `${entity}:${item.id}`;
    b.title = `An agent filed this from ${r.shown} without naming a project, and ${r.shown} is ${[r.project_name, ...r.others.map((o) => o.name)].join(" and ")}'s. Click to move it or keep it here.`;
    b.setAttribute("aria-haspopup", "menu");
    b.onclick = (e) => {
      e.stopPropagation();
      const items = [
        ...r.others.map((o) => ({ label: `Move to ${o.name}`, run: async () => {
          try { await window.delphi.items.move(entity, item.id, o.id); app.notify(`Moved to ${o.name}. History can put it back.`); }
          catch (error) { app.notifyError(error); }
          await app.refresh();
        } })),
        ...(r.others.length ? ["-"] : []),
        { label: `That's right, keep it in ${r.project_name}`, run: async () => {
          try { await window.delphi.folders.settleRoute(entity, item.id); } catch (error) { app.notifyError(error); }
          await app.refresh();
        } },
      ];
      app.menu(b, items);
    };
    return b;
  }

  // --- the drawer's folder picker --------------------------------------------

  /**
   * Which folder a task's Workbench starts in, for a project with more than
   * one. Null otherwise: one folder is no choice. `onPicked` runs after the
   * task is written, so the drawer can read it again.
   */
  async function picker(detail, { onPicked = null } = {}) {
    if (!detail || !detail.project) return null;
    let list = [];
    try { list = await window.delphi.folders.list(detail.project.id); } catch { return null; }
    if (list.length < 2) return null;
    const sel = el("select", { className: "field sm wb-folder-pick" });
    sel.setAttribute("aria-label", "Folder this task's Workbench starts in");
    const own = detail.task.repo_id != null ? Number(detail.task.repo_id) : null;
    const homeRow = list.find((f) => f.home) || null;
    for (const f of list) {
      const value = f.home ? "" : String(f.repo_id);
      if (!f.home && f.repo_id == null) continue;
      const on = f.home ? own === null || (homeRow && homeRow.repo_id === own) : f.repo_id === own;
      sel.append(el("option", { value, textContent: `${f.name}${f.home ? " (Home)" : ""}`, selected: on }));
    }
    sel.onchange = async () => {
      try { await window.delphi.tasks.update(detail.task.id, { repo_id: sel.value === "" ? null : Number(sel.value) }); }
      catch (error) { app.notifyError(error); return; }
      if (onPicked) await onPicked();
    };
    return el("label", { className: "wb-folder" }, el("span", { className: "wb-folder-k", textContent: "Folder" }), sel);
  }

  function init(lent) { app = lent; }

  return { init, mount, load, chip, routeOf, picker, ownerRepo };
})();

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.DelphiFolderList;
