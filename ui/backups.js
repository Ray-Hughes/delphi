// Settings: the database's snapshots, and putting one back.
//
// A restore replaces everything, so nothing here restores in one click. Each
// snapshot opens a preview first: its date and what it holds (projects, tasks,
// notes, pads, Sheet entries) beside what is here now, so the difference is
// seen before it is chosen. Restoring then says what happens (a copy of now is
// kept, and Delphi restarts) and does it. The rules are in main/backups.js.
//
// Mounted from app.js's Settings view, under "Where your data lives", until
// Settings becomes its own panel.

globalThis.DelphiBackups = (() => {
  const COUNTS = [["projects", "Projects"], ["tasks", "Tasks"], ["notes", "Notes"], ["pads", "Pads"], ["entries", "Sheet entries"]];

  const when = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };
  const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  /** What a snapshot is, in words: the daily ones by day, the others by why. */
  const label = (b) => {
    if (b.kind === "daily") return "Daily snapshot";
    if (/^pre-restore-/.test(b.name)) return "Before a restore";
    if (/^update-/.test(b.name)) return "Before an update";
    return "Snapshot";
  };

  async function paint(root) {
    const section = el("div", { className: "setting backups" });
    section.append(
      el("h3", { textContent: "Backups" }),
      el("p", { className: "hint", textContent: "A copy of the whole database every day, the last seven kept, and one before anything big such as an update. Restoring one keeps a copy of what is here now first." }));
    const body = el("div", { className: "backup-list" });
    section.append(body);
    root.append(section);

    let info = null;
    try { info = await window.delphi.backups.list(); } catch (error) {
      body.append(el("div", { className: "err-msg", textContent: String(error.message || error) }));
      return;
    }
    const last = info.lastRestore;
    if (last && last.ok) body.append(el("div", { className: "ok-msg", role: "status", textContent: "Restored. What was here before is kept as a backup below." }));
    if (last && !last.ok) body.append(el("div", { className: "err-msg", role: "alert", textContent: `The restore did not happen: ${last.error}. Nothing was changed.` }));
    if (!info.backups.length) {
      body.append(el("div", { className: "hint", textContent: "The first one is taken a few seconds after Delphi starts." }));
      return;
    }
    for (const b of info.backups) body.append(row(b));
  }

  function row(b) {
    const item = el("div", { className: "backup" });
    const line = el("div", { className: "backup-line" });
    const open = el("button", { className: "btn sm", type: "button", textContent: "Preview" });
    line.append(
      el("span", { className: "backup-when", textContent: when(b.at) }),
      el("span", { className: "backup-kind", textContent: label(b) }),
      el("span", { className: "backup-size mono", textContent: size(b.size) }),
      open);
    item.append(line);
    let shown = null;
    open.onclick = async () => {
      if (shown) { shown.remove(); shown = null; open.textContent = "Preview"; return; }
      open.disabled = true;
      try {
        shown = preview(b, await window.delphi.backups.preview(b.name));
        item.append(shown);
        open.textContent = "Close";
      } catch (error) {
        item.append(el("div", { className: "err-msg", textContent: String(error.message || error) }));
      } finally {
        open.disabled = false;
      }
    };
    return item;
  }

  /** The snapshot beside now, then the one button that restores it. */
  function preview(b, p) {
    const box = el("div", { className: "backup-preview" });
    const table = el("table", { className: "backup-compare" });
    const head = el("tr", {}, el("th", {}), el("th", { textContent: "In this backup" }), el("th", { textContent: "Now" }));
    table.append(head);
    for (const [key, name] of COUNTS) {
      const then = p.snapshot[key];
      const now = p.current[key];
      const tr = el("tr", { className: then !== now ? "differs" : "" },
        el("th", { textContent: name }),
        el("td", { className: "mono", textContent: then == null ? "-" : String(then) }),
        el("td", { className: "mono", textContent: now == null ? "-" : String(now) }));
      table.append(tr);
    }
    const restore = el("button", { className: "btn sm primary", type: "button", textContent: "Restore this backup" });
    const say = el("p", { className: "hint", textContent: `Everything goes back to ${when(b.at)}. A copy of what is here now is kept first, and Delphi restarts to finish. Agents that are running need their sessions restarted afterwards.` });
    restore.onclick = async () => {
      restore.disabled = true;
      restore.textContent = "Restoring";
      try {
        await window.delphi.backups.restore(b.name);
        say.textContent = "Saved a copy of now. Restarting.";
      } catch (error) {
        restore.disabled = false;
        restore.textContent = "Restore this backup";
        say.textContent = String(error.message || error);
      }
    };
    box.append(table, say, el("div", { className: "backup-acts" }, restore));
    return box;
  }

  return { paint };
})();
