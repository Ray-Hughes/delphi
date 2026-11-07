// The folder question in Needs you (Today, at the top): "Add this folder?".
//
// A folder an agent session worked in that is no project's
// (workbench/discover.js). The server only asks; the three answers are here.
// Add as a new project opens Add folder on that folder, so the sheet shows
// the remote and branch git reports now. Add to project offers every active
// project, several at once, because a folder may be several projects', with
// the one Delphi thinks it is ticked first and the reason said. Not a project
// is kept for good.
//
// There is no shared-folder question any more. Slice 4 asked one when two
// projects had the same folder; a folder may be several projects' now, and
// which one an agent's work belongs to is Delphi's to work out
// (workbench/route.js), not a person's to be asked.

globalThis.DelphiNeeds = (() => {
  const I = (name, size) => DelphiIcons.icon(name, size);
  let app = null;
  let found = [];

  async function load() {
    try { found = await window.delphi.folders.discoveries(); } catch { found = []; }
    return found;
  }
  const count = () => found.length;

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
    if (d.suggested && d.suggestedWhy) {
      const likely = d.attachable.find((p) => p.id === d.suggested);
      if (likely) facts.push(`Probably ${likely.name}'s, ${d.suggestedWhy}.`);
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

    const attach = button("Add to project");
    attach.onclick = () => {
      busy(true);
      // A tick per project, the likely one first and ticked, so the common
      // answer is one click and a folder several projects share is one more.
      const ordered = [...d.attachable].sort((x, y) => Number(y.id === d.suggested) - Number(x.id === d.suggested));
      const boxes = el("div", { className: "fd-picks", role: "group" });
      boxes.setAttribute("aria-label", "Projects to add the folder to");
      for (const p of ordered) {
        const tick = el("input", { type: "checkbox", value: String(p.id), checked: p.id === d.suggested });
        const label = el("label", { className: "fd-pick" + (p.id === d.suggested ? " likely" : "") }, tick, el("span", { textContent: p.name }));
        if (p.id === d.suggested && d.suggestedWhy) label.append(el("span", { className: "fd-why", textContent: `likely, ${d.suggestedWhy}` }));
        else if (p.has_folder) label.append(el("span", { className: "fd-why", textContent: "has other folders" }));
        boxes.append(label);
      }
      const sure = el("div", { className: "fc-confirm fd-confirm" },
        el("span", { className: "grow", textContent: "A folder can belong to several projects. Tick each one it is for." }));
      const go = el("button", { className: "btn sm primary", type: "button", textContent: "Add" });
      const back = el("button", { className: "btn sm ghost", type: "button", textContent: "Cancel" });
      back.onclick = () => { sure.remove(); boxes.remove(); busy(false); attach.focus(); };
      go.onclick = async () => {
        const ids = [...boxes.querySelectorAll("input:checked")].map((i) => Number(i.value));
        if (!ids.length) { msg.className = "fc-msg err-msg"; msg.textContent = "Tick a project first."; return; }
        go.disabled = back.disabled = true;
        const names = d.attachable.filter((p) => ids.includes(p.id)).map((p) => p.name);
        try {
          await window.delphi.folders.attach(d.id, ids);
          await finish(`${d.shown} is ${names.join(" and ")}'s now. History can put it back.`);
        } catch (e) { sure.remove(); boxes.remove(); fail(e); }
      };
      sure.append(back, go);
      node.append(boxes, sure);
      (boxes.querySelector("input:checked") || boxes.querySelector("input"))?.focus();
    };
    if (!d.attachable || !d.attachable.length) { attach.disabled = true; all.pop(); }
    acts.append(attach);

    const ignore = button("Not a project", "btn sm ghost");
    ignore.title = `Delphi will not ask about ${d.shown} again.`;
    ignore.onclick = async () => {
      busy(true);
      try { await window.delphi.folders.ignore(d.id); await finish(`Delphi won't ask about ${d.shown} again.`); } catch (e) { fail(e); }
    };
    acts.append(ignore);
    node.append(acts, msg);
    return node;
  }

  /** Into the Needs you page, above everything else on it. */
  function mount(page) {
    if (!found.length) return;
    const box = el("div", { className: "box fc-box" });
    box.append(el("div", { className: "sub-h" }, "Folders", el("span", { className: "r", textContent: "a folder can be several projects'" })));
    for (const d of found) box.append(foundNode(d));
    page.append(box);
  }

  function init(lent) { app = lent; }

  return { init, load, count, mount, short };
})();

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.DelphiNeeds;
