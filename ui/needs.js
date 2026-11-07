// The folder questions in Needs you (Today, at the top).
//
// When two projects shared a folder, the folder migration gave it to the one
// holding more and moved the other to No folder (workbench/folders.js). That
// was a guess, made for the person, so it is put to them once: keep it, give
// the folder to the other project, or merge the other into the one that kept
// it. All three are the window's alone, as every decision is; there is no MCP
// tool that answers one. Give and Merge write History rows, so either can be
// undone there, and an answered question never comes back.
//
// The words are drawn from what each project holds now, not what it held when
// the migration ran.
//
// Below those, "Add this folder?": a folder an agent session worked in that is
// no project's (workbench/discover.js). The server only asks; the three
// answers are here. Add as a new project opens Add folder on that folder, so
// the sheet shows the remote and branch git reports now. Attach offers only
// projects with no folder, because a folder is one project's. Not a project
// is kept for good.

globalThis.DelphiNeeds = (() => {
  const I = (name, size) => DelphiIcons.icon(name, size);
  let app = null;
  let items = [];
  let found = [];

  async function load() {
    try { items = await window.delphi.folders.conflicts(); } catch { items = []; }
    try { found = await window.delphi.folders.discoveries(); } catch { found = []; }
    return items;
  }
  const count = () => items.length + found.length;

  /**
   * The short name a button can carry: "SSNR / MPI Person Update" is SSNR,
   * "Central Office hearing address (APREQ-987)" is Central Office. The full
   * name is in the sentence above the buttons.
   */
  function short(name) {
    const plain = String(name || "").replace(/\s*\([^)]*\)\s*/g, " ").split(" / ")[0].trim();
    const words = plain.split(/\s+/);
    return words.length > 3 ? words.slice(0, 2).join(" ") : plain;
  }

  /** A name in a sentence that puts its own brackets after it: the ticket in brackets goes. */
  const prose = (name) => String(name || "").replace(/\s*\([^)]*\)\s*$/, "").trim() || String(name || "");

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  /** "67 tasks", "1 note", "2 notes and a pad": the two things it holds most of. */
  function holds(p) {
    const parts = [];
    if (p.tasks) parts.push(plural(p.tasks, "task", "tasks"));
    if (p.notes) parts.push(plural(p.notes, "note", "notes"));
    if (p.pads) parts.push(plural(p.pads, "pad", "pads"));
    if (!parts.length && p.sessions) parts.push(plural(p.sessions, "conversation", "conversations"));
    if (!parts.length) return "nothing yet";
    return parts.slice(0, 2).join(" and ");
  }
  const moveWords = (p) => {
    const parts = [];
    if (p.tasks) parts.push(plural(p.tasks, "task", "tasks"));
    if (p.notes) parts.push(plural(p.notes, "note", "notes"));
    if (p.pads) parts.push(plural(p.pads, "pad", "pads"));
    if (p.sessions) parts.push(plural(p.sessions, "conversation", "conversations"));
    return parts.length ? parts.join(", ") : "nothing";
  };

  function itemNode(c) {
    const kept = c.kept;
    const node = el("div", { className: "fc" });
    node.dataset.folderQuestion = String(c.id);
    const msg = el("div", { className: "fc-msg", role: "status" });
    const lead = el("div", { className: "fc-head" }, I("folder", "sm"),
      el("b", {}, el("span", { className: "mono", textContent: c.shown }), ` belonged to ${c.moved.length + (kept ? 1 : 0)} projects.`));
    const told = [];
    if (kept) told.push(`${prose(kept.name)} kept it (${holds(kept)}).`);
    for (const m of c.moved) told.push(`${prose(m.name)} (${holds(m)}) is now in No folder.`);
    node.append(lead, el("p", { className: "fc-words", textContent: told.join(" ") }));

    const acts = el("div", { className: "fc-acts" });
    const all = [];
    const button = (text, cls = "btn sm") => { const b = el("button", { className: cls, type: "button", textContent: text }); all.push(b); return b; };
    const busy = (on) => all.forEach((b) => { b.disabled = on; });
    const fail = (e) => { msg.className = "fc-msg err-msg"; msg.textContent = String(e && e.message ? e.message : e); busy(false); };
    const finish = async (words) => { await load(); await app.refresh(); app.notify(words); };

    const keep = button("Keep it this way");
    keep.onclick = async () => {
      busy(true);
      try { await window.delphi.folders.keep(c.id); await finish(kept ? `${c.shown} stays with ${kept.name}.` : "Kept as it is."); } catch (e) { fail(e); }
    };
    acts.append(keep);

    for (const m of c.moved) {
      const give = button(`Give the folder to ${short(m.name)}`);
      give.title = `${m.name} takes ${c.shown}. ${kept ? kept.name : "The project that has it"} moves to No folder.`;
      give.onclick = async () => {
        busy(true);
        try {
          await window.delphi.folders.give(c.id, m.id);
          await finish(`${m.name} has ${c.shown} now${kept ? `, and ${kept.name} is in No folder` : ""}. History can put it back.`);
        } catch (e) { fail(e); }
      };
      acts.append(give);
      if (!kept) continue;
      const merge = button(`Merge ${short(m.name)} into ${short(kept.name)}`);
      merge.onclick = () => {
        // Said once more before it runs: a merge moves everything and archives
        // the project, and the buttons alone do not say that.
        busy(true);
        const sure = el("div", { className: "fc-confirm" },
          el("span", { className: "grow", textContent: `Moves ${prose(m.name)}'s ${moveWords(m)} into ${prose(kept.name)}, then archives ${short(m.name)}. Nothing is deleted, and each move can be undone in History.` }));
        const go = el("button", { className: "btn sm primary", type: "button", textContent: "Merge" });
        const back = el("button", { className: "btn sm ghost", type: "button", textContent: "Cancel" });
        back.onclick = () => { sure.remove(); busy(false); merge.focus(); };
        go.onclick = async () => {
          go.disabled = back.disabled = true;
          try {
            const r = await window.delphi.folders.merge(c.id, m.id);
            if (!r.merged) {
              sure.remove();
              fail(`Stopped before archiving ${m.name}: ${r.refused.why} What moved so far stays moved.`);
              await app.refresh();
              return;
            }
            await finish(`${m.name} is merged into ${kept.name} and archived.`);
          } catch (e) { sure.remove(); fail(e); }
        };
        sure.append(back, go);
        node.append(sure);
        go.focus();
      };
      acts.append(merge);
    }
    node.append(acts, msg);
    return node;
  }

  /** "Today at 2:14 PM", "on 3 Nov": when an agent was last there, from SQLite's UTC text. */
  function when(text) {
    if (!text) return "";
    const d = new Date(String(text).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? "" : "Z"));
    if (Number.isNaN(d.getTime())) return "";
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return `today at ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    return `on ${d.toLocaleDateString([], { day: "numeric", month: "short" })}`;
  }

  function foundNode(d) {
    const node = el("div", { className: "fc fd" });
    node.dataset.folderFound = String(d.id);
    const msg = el("div", { className: "fc-msg", role: "status" });
    const who = d.via === "migration" ? "A workspace from before folders became projects is" : `${d.harness || "An agent"} worked in`;
    const lead = el("div", { className: "fc-head" }, I("folderplus", "sm"),
      el("b", {}, "Add this folder? "),
      el("span", {}, `${who} `, el("span", { className: "mono", textContent: d.shown }), d.via === "migration" ? ", and it isn't a project yet." : ", which isn't a project yet."));
    const facts = [];
    if (d.ownerRepo || d.remote) facts.push(`${d.ownerRepo || d.remote}${d.branch ? `, branch ${d.branch}` : ""}.`);
    else if (d.via !== "migration") facts.push("Not a git repository.");
    if (d.via !== "migration") {
      const times = d.seen_count > 1 ? `${d.seen_count} sessions, the last ${when(d.last_seen)}` : `Seen ${when(d.last_seen)}`;
      facts.push(`${times}.`);
    }
    facts.push("Nothing was made: it is yours to decide.");
    node.append(lead, el("p", { className: "fc-words", textContent: facts.join(" ") }));

    const acts = el("div", { className: "fc-acts" });
    const all = [];
    const button = (text, cls = "btn sm") => { const b = el("button", { className: cls, type: "button", textContent: text }); all.push(b); return b; };
    const busy = (on) => all.forEach((b) => { b.disabled = on; });
    const fail = (e) => { msg.className = "fc-msg err-msg"; msg.textContent = String(e && e.message ? e.message : e); busy(false); };
    const finish = async (words) => { await load(); await app.refresh(); if (words) app.notify(words); };

    const add = button("Add as a new project", "btn sm primary");
    add.onclick = async () => {
      // Add folder asks git again and writes nothing until its own Add, which
      // settles this question in the main process and refreshes the window. A
      // sheet cancelled leaves the question where it was.
      await DelphiAddFolder.open(d.path);
    };
    acts.append(add);

    const attach = button("Attach to a project");
    const none = !d.attachable || !d.attachable.length;
    if (none) {
      attach.disabled = true;
      attach.title = "Every project has a folder already, and a folder belongs to one project.";
      all.pop();
    }
    attach.onclick = () => {
      busy(true);
      const pick = el("select", { className: "field" });
      pick.setAttribute("aria-label", "Project to attach the folder to");
      for (const p of d.attachable) pick.append(el("option", { value: String(p.id), textContent: p.name }));
      const sure = el("div", { className: "fc-confirm" },
        el("span", { className: "grow", textContent: "Only projects with no folder are listed: a project has one folder." }), pick);
      const go = el("button", { className: "btn sm primary", type: "button", textContent: "Attach" });
      const back = el("button", { className: "btn sm ghost", type: "button", textContent: "Cancel" });
      back.onclick = () => { sure.remove(); busy(false); attach.focus(); };
      go.onclick = async () => {
        go.disabled = back.disabled = true;
        const chosen = d.attachable.find((p) => String(p.id) === pick.value);
        try {
          await window.delphi.folders.attach(d.id, Number(pick.value));
          await finish(`${chosen ? chosen.name : "That project"} has a folder now: ${d.shown}. History can put it back.`);
        } catch (e) { sure.remove(); fail(e); }
      };
      sure.append(back, go);
      node.append(sure);
      pick.focus();
    };
    acts.append(attach);

    const ignore = button("Not a project", "btn sm ghost");
    ignore.title = `Delphi will not ask about ${d.shown} again.`;
    ignore.onclick = async () => {
      busy(true);
      try { await window.delphi.folders.ignore(d.id); await finish(`Delphi won't ask about ${d.shown} again.`); } catch (e) { fail(e); }
    };
    acts.append(ignore);
    if (none) acts.append(el("span", { className: "fd-none", textContent: "Every project has a folder, so there is none to attach it to." }));
    node.append(acts, msg);
    return node;
  }

  /** Into the Needs you page, above everything else on it. */
  function mount(page) {
    if (!items.length && !found.length) return;
    const box = el("div", { className: "box fc-box" });
    box.append(el("div", { className: "sub-h" }, "Folders", el("span", { className: "r", textContent: "each folder is one project" })));
    for (const c of items) box.append(itemNode(c));
    for (const d of found) box.append(foundNode(d));
    page.append(box);
  }

  function init(lent) { app = lent; }

  return { init, load, count, mount, short };
})();

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.DelphiNeeds;
