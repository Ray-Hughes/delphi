// The pull request description and the status report in the window: an editor
// with a live preview and Copy, used by Finish, by the drawer's "PR
// description" button, and by "Write status" on a project's Overview.
//
// The text is written by sheet/report.js in the main process, the builder the
// MCP server's workbench_pr uses too, so an agent and the window draft the
// same description. Here it is only shown and edited. Nothing here posts: the
// text a person leaves in the editor is what Finish hands to gh, and Copy is
// the only other way out.
//
// The preview goes through ui/markdown.js (renderMarkdown in app.js), which
// builds nodes and never assigns HTML, so what an agent wrote on a Sheet
// cannot become markup in this window.
//
//   DelphiReport.editor(text)            -> { node, value() }
//   DelphiReport.describe(wbId, taskId)  the drawer's button: the draft, to read and copy
//   DelphiReport.statusCard(projectId)                a card for a project's Overview
//   DelphiReport.statusButton(projectId, { projects }) the button alone, for Runs
//   DelphiReport.writeStatus(projectId, { projects }) the dialog that card opens

(function () {
  // Long enough to read "Copied", short enough not to look stuck.
  const COPIED_MS = 1400;
  // A preview redrawn on every key is a full Markdown parse per key; this is
  // under what a person notices.
  const PREVIEW_MS = 120;

  function copyButton(get, label = "Copy") {
    const b = el("button", { className: "btn sm", type: "button", textContent: label });
    b.dataset.act = "report-copy";
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(get());
        b.textContent = "Copied";
        setTimeout(() => { b.textContent = label; }, COPIED_MS);
      } catch (error) { notifyError(error); }
    };
    return b;
  }

  /**
   * The text and its preview side by side, with Copy above. value() is the
   * text as the person left it, which is what Finish sends.
   */
  function editor(text, { label = "PR description", hint = "Markdown. Edit freely; this is what is sent." } = {}) {
    const area = el("textarea", { className: "rp-text", spellcheck: true });
    area.value = text || "";
    area.setAttribute("aria-label", label);
    const preview = el("div", { className: "rp-preview md" });
    preview.setAttribute("aria-label", `${label}, preview`);
    let timer = null;
    const paint = () => {
      timer = null;
      preview.textContent = "";
      if (area.value.trim()) preview.append(renderMarkdown(area.value));
      else preview.append(el("p", { className: "rp-empty", textContent: "Nothing to preview." }));
    };
    area.addEventListener("input", () => { if (!timer) timer = setTimeout(paint, PREVIEW_MS); });
    paint();
    const head = el("div", { className: "rp-head" },
      el("b", { textContent: label }), el("span", { className: "rp-hint", textContent: hint }), el("span", { className: "grow" }),
      copyButton(() => area.value));
    const node = el("div", { className: "rp" }, head,
      el("div", { className: "rp-panes" },
        el("div", { className: "rp-pane" }, el("div", { className: "rp-pane-k", textContent: "Text" }), area),
        el("div", { className: "rp-pane" }, el("div", { className: "rp-pane-k", textContent: "Preview" }), preview)));
    return { node, area, value: () => area.value, set: (t) => { area.value = t || ""; paint(); } };
  }

  /** The drawer's one button: the draft Finish would offer, to read, edit and copy now. */
  async function describe(wbId, taskId) {
    let pr;
    try { pr = await window.delphi.workbench.pr(wbId); } catch (error) { notifyError(error); return; }
    const ed = editor(pr.body);
    await wbDialog({
      title: `PR description for task ${taskId}`,
      lead: "Written from the Sheet: its decisions and the questions they answered, the checks that passed, open questions and the diff. Edits here are not kept; Finish writes it again and lets you edit it before anything is sent.",
      body: [ed.node],
      className: "rp-dialog",
      actions: [{ label: "Close", value: null, kind: "primary" }],
    });
  }

  /** YYYY-MM-DD for a local day, days before today. */
  function localDay(daysBack = 0) {
    const d = new Date();
    d.setDate(d.getDate() - daysBack);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /**
   * Write status: a date range, the report it writes, and Copy. With
   * opts.projects (a function giving [{ id, name }]) it has a project picker
   * too, for Runs, which is not inside any one project.
   */
  async function writeStatus(projectId, { projects = null } = {}) {
    const from = el("input", { type: "date", className: "rp-date", value: localDay(6) });
    const to = el("input", { type: "date", className: "rp-date", value: localDay(0) });
    from.setAttribute("aria-label", "From");
    to.setAttribute("aria-label", "To");
    let pick = null;
    const list = projects ? projects() : [];
    if (list.length) {
      pick = el("select", { className: "rp-date" });
      pick.setAttribute("aria-label", "Project");
      for (const p of list) pick.append(el("option", { value: String(p.id), textContent: p.name }));
      pick.value = String(projectId != null && list.some((p) => p.id === projectId) ? projectId : list[0].id);
    }
    const ed = editor("", { label: "Status report", hint: "Markdown. Edit, then Copy; nothing is posted." });
    const said = el("p", { className: "rp-msg", role: "status" });
    let asked = 0;
    const write = async () => {
      const mine = ++asked;
      said.textContent = "";
      const pid = pick ? Number(pick.value) : projectId;
      if (pid == null) { said.textContent = "Choose a project."; return; }
      if (!from.value || !to.value) { said.textContent = "Choose both dates."; return; }
      try {
        const text = await window.delphi.report.status(pid, { from: from.value, to: to.value });
        if (mine === asked) ed.set(text);
      } catch (error) {
        if (mine === asked) said.textContent = error.message || String(error);
      }
    };
    from.onchange = write;
    to.onchange = write;
    if (pick) pick.onchange = write;
    const range = el("div", { className: "rp-range" },
      pick ? el("label", {}, "Project ", pick) : null,
      el("label", {}, "From ", from), el("label", {}, "To ", to),
      el("span", { className: "rp-hint", textContent: "Both days included, in your time zone. Changing one writes it again." }));
    const shown = wbDialog({
      title: "Write status",
      lead: "What was finished, decided and checked over these dates, what is in progress now, and the questions still open, written from the Sheets.",
      body: [range, said, ed.node],
      className: "rp-dialog",
      actions: [{ label: "Done", value: null, kind: "primary" }],
    });
    await write();
    return shown;
  }

  /**
   * The button alone, for Runs, which draws its own section; with
   * opts.projects the dialog has a project picker. A projectId given as a
   * function is asked at the click, so it is the project open then.
   */
  function statusButton(projectId, opts = {}) {
    const go = el("button", { className: "btn sm", type: "button", textContent: "Write status" });
    go.dataset.act = "write-status";
    go.onclick = () => writeStatus(typeof projectId === "function" ? projectId() : projectId, opts);
    return go;
  }

  /** A small card for a project's Overview, for that project. */
  function statusCard(projectId, opts = {}) {
    const go = statusButton(projectId, opts);
    const c = el("section", { className: "card rp-card" });
    c.append(el("div", { className: "card-head" }, el("h2", { textContent: "Status report" }), go),
      el("div", { className: "card-body" }, el("p", { className: "rp-hint", textContent: "A summary of a date range, written from this project's Sheets, to edit and copy." })));
    return c;
  }

  window.DelphiReport = { editor, describe, writeStatus, statusButton, statusCard };
})();
