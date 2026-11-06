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

globalThis.DelphiNeeds = (() => {
  const I = (name, size) => DelphiIcons.icon(name, size);
  let app = null;
  let items = [];

  async function load() {
    try { items = await window.delphi.folders.conflicts(); } catch { items = []; }
    return items;
  }
  const count = () => items.length;

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

  /** Into the Needs you page, above everything else on it. */
  function mount(page) {
    if (!items.length) return;
    const box = el("div", { className: "box fc-box" });
    box.append(el("div", { className: "sub-h" }, "Folders", el("span", { className: "r", textContent: "each folder is one project now" })));
    for (const c of items) box.append(itemNode(c));
    page.append(box);
  }

  function init(lent) { app = lent; }

  return { init, load, count, mount, short };
})();

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.DelphiNeeds;
