// The pull request description and the status report in the window: an editor
// with a live preview and Copy, used by Finish, by the drawer's "PR
// description" button, and by "Write status" on Runs and a project's Overview.
//
// The text is written by sheet/report.js in the main process, the builder the
// MCP server's workbench_pr uses too, so an agent and the window draft the
// same description. Here it is only shown and edited. Nothing here posts: the
// title and text a person leaves in the editor are what Finish hands to gh,
// and Copy is the only other way out.
//
// What leaves is redacted whoever wrote it (sheet/scrub.js, loaded here as
// DelphiScrub): the main process redacts what it is sent, and Copy copies the
// redacted text. What is probably fine but is the person's call (an internal
// host, a private address, a home folder) is never changed: it is named above
// the editor and highlighted in the preview, so they can edit before sending.
//
// The preview goes through ui/markdown.js (renderMarkdown in app.js), which
// builds nodes and never assigns HTML, so what an agent wrote on a Sheet
// cannot become markup in this window.
//
//   DelphiReport.editor(text, { title })               -> { node, area, value(), titleValue(), set(), confirmDiscard() }
//   DelphiReport.describe(wbId, taskId)                the drawer's button: the draft, to read and copy
//   DelphiReport.keep({ title, reason, body, prTitle }) a text that could not be sent, shown to copy
//   DelphiReport.statusCard(projectId)                 a card for a project's Overview
//   DelphiReport.statusButton(projectId, { projects }) the button alone, for Runs
//   DelphiReport.writeStatus(projectId, { projects })  the dialog those open

(function () {
  const S = window.DelphiScrub;
  // Long enough to read "Copied", short enough not to look stuck.
  const COPIED_MS = 1400;
  // A preview redrawn on every key is a full Markdown parse per key; this is
  // under what a person notices.
  const PREVIEW_MS = 120;

  const outgoing = (text) => (S ? S.redact(text).text : text);

  function copyButton(get, label = "Copy", onCopied = null) {
    const b = el("button", { className: "btn sm", type: "button", textContent: label });
    b.dataset.act = "report-copy";
    b.onclick = async () => {
      const text = outgoing(get());
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = "Copied";
        if (onCopied) onCopied(text);
        setTimeout(() => { b.textContent = label; }, COPIED_MS);
      } catch (error) { notifyError(`Could not copy: ${error.message || error}. Select the text and copy it by hand.`); }
    };
    return b;
  }

  /** The flagged words in a rendered preview, wrapped in <mark>, text node by text node. */
  function highlight(rootNode) {
    if (!S) return;
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    for (const node of nodes) {
      const found = S.flag(node.nodeValue);
      if (!found.length) continue;
      const frag = document.createDocumentFragment();
      let at = 0;
      for (const f of found) {
        if (f.index < at) continue;
        frag.append(node.nodeValue.slice(at, f.index), el("mark", { className: "rp-flag", textContent: f.text, title: `Check before sending: ${f.kind === "host" ? "an internal host" : f.kind === "ip" ? "a private address" : "a home folder"}` }));
        at = f.index + f.text.length;
      }
      frag.append(node.nodeValue.slice(at));
      node.replaceWith(frag);
    }
  }

  /**
   * The warning above the editor: what the text mentions that is worth a look,
   * and what will be redacted on the way out. Empty, and hidden, when neither.
   */
  function paintWarning(box, text) {
    box.textContent = "";
    if (!S) return;
    const found = S.flag(text);
    const secrets = S.redact(text).count;
    if (found.length) {
      const names = [...new Set(found.map((f) => f.text))];
      box.append(el("div", {}, el("b", { textContent: `This text mentions: ${S.flagWords(found)}.` }),
        " Highlighted in the preview. Edit them out if they should not leave, then send."),
        el("div", { className: "rp-warn-list" }, names.slice(0, 12).map((n) => el("mark", { className: "rp-flag", textContent: n })),
          names.length > 12 ? el("span", { textContent: ` and ${names.length - 12} more` }) : null));
    }
    if (secrets) box.append(el("div", { textContent: `${secrets === 1 ? "1 secret or number" : `${secrets} secrets or numbers`} will be replaced with [redacted] when this is sent or copied.` }));
    box.hidden = !box.childNodes.length;
  }

  /**
   * The text and its preview side by side, with Copy above, and with a title
   * field above both when opts.title is given (a pull request). value() and
   * titleValue() are what the person left, which is what Finish sends.
   */
  function editor(text, { title = null, label = "PR description", hint = "Markdown. Edit freely; this is what is sent." } = {}) {
    const area = el("textarea", { className: "rp-text", spellcheck: true });
    area.value = text || "";
    area.setAttribute("aria-label", label);
    let titleField = null;
    if (title !== null) {
      titleField = el("input", { type: "text", className: "rp-title", value: title, maxLength: 256 });
      titleField.setAttribute("aria-label", "Pull request title");
    }
    const preview = el("div", { className: "rp-preview md", tabIndex: 0 });
    preview.setAttribute("aria-label", `${label}, preview`);
    const warn = el("div", { className: "rp-warn", role: "status" });
    let original = { text: area.value, title };
    let copied = null;
    let timer = null;
    const paint = () => {
      timer = null;
      preview.textContent = "";
      if (area.value.trim()) { preview.append(renderMarkdown(area.value)); highlight(preview); }
      else preview.append(el("p", { className: "rp-empty", textContent: "Nothing to preview." }));
      paintWarning(warn, `${titleField ? `${titleField.value}\n` : ""}${area.value}`);
    };
    area.addEventListener("input", () => { if (!timer) timer = setTimeout(paint, PREVIEW_MS); });
    if (titleField) titleField.addEventListener("input", () => { if (!timer) timer = setTimeout(paint, PREVIEW_MS); });
    paint();
    const head = el("div", { className: "rp-head" },
      el("b", { textContent: label }), el("span", { className: "rp-hint", textContent: hint }), el("span", { className: "grow" }),
      copyButton(() => area.value, "Copy", (t) => { copied = t; }));
    const node = el("div", { className: "rp" },
      titleField ? el("label", { className: "rp-title-row" }, el("span", { className: "rp-pane-k", textContent: "Title" }), titleField) : null,
      warn, head,
      el("div", { className: "rp-panes" },
        el("div", { className: "rp-pane" }, el("div", { className: "rp-pane-k", textContent: "Text" }), area),
        el("div", { className: "rp-pane" }, el("div", { className: "rp-pane-k", textContent: "Preview" }), preview)));
    const edited = () => (area.value !== original.text && outgoing(area.value) !== copied) || (titleField && titleField.value !== original.title);
    /** True when nothing edited would be lost, or the person says it can go. */
    async function confirmDiscard() {
      if (!edited()) return true;
      const go = await wbDialog({
        title: "Discard your edits?",
        lead: "The text you changed is not kept anywhere else. Copy it first if you want it.",
        actions: [{ label: "Keep editing", value: false }, { label: "Discard", value: true, kind: "danger" }],
        cancelValue: false,
      });
      return go === true;
    }
    return {
      node, area, confirmDiscard, edited,
      value: () => area.value,
      titleValue: () => (titleField ? titleField.value : null),
      // A new draft, as the one edits are measured against.
      set: (t) => { area.value = t || ""; original = { text: area.value, title: titleField ? titleField.value : null }; copied = null; paint(); },
    };
  }

  /** The drawer's one button: the draft Finish would offer, to read, edit and copy now. */
  async function describe(wbId, taskId) {
    let pr;
    try { pr = await window.delphi.workbench.pr(wbId); } catch (error) { notifyError(error); return; }
    const ed = editor(pr.body, { title: pr.title });
    await wbDialog({
      title: `PR description for task ${taskId}`,
      lead: "Written from the Sheet: its decisions and the questions they answered, the checks that passed, open questions and the diff. Edits here are not kept; Finish writes it again and lets you edit it before anything is sent.",
      body: [ed.node],
      className: "rp-dialog",
      focus: ed.area,
      beforeClose: () => ed.confirmDiscard(),
      actions: [{ label: "Close", value: null, kind: "primary" }],
    });
  }

  /**
   * A title and text that could not be sent, shown so nothing the person
   * wrote is lost with the dialog it was in: the clipboard is not trusted to
   * hold it, since it may be the thing that failed.
   */
  async function keep({ title, reason, body, prTitle = null }) {
    const ed = editor(body, { title: prTitle });
    await wbDialog({
      title, lead: reason, body: [ed.node], className: "rp-dialog", focus: ed.area,
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
    // What the controls said when the text was last written, so a change the
    // person takes back after declining to discard their edits is undone.
    let shown = { from: from.value, to: to.value, pick: pick ? pick.value : null };
    let asked = 0;
    const write = async () => {
      // A new range rewrites the text, so edits are asked about first.
      if (!(await ed.confirmDiscard())) {
        from.value = shown.from; to.value = shown.to; if (pick) pick.value = shown.pick;
        return;
      }
      const mine = ++asked;
      said.textContent = "";
      const pid = pick ? Number(pick.value) : projectId;
      if (pid == null) { said.textContent = "Choose a project."; return; }
      if (!from.value || !to.value) { said.textContent = "Choose both dates."; return; }
      try {
        const text = await window.delphi.report.status(pid, { from: from.value, to: to.value });
        if (mine === asked) { ed.set(text); shown = { from: from.value, to: to.value, pick: pick ? pick.value : null }; }
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
    const dialog = wbDialog({
      title: "Write status",
      lead: "What was finished, decided and checked over these dates, what is in progress now, and the questions still open, written from the Sheets.",
      body: [range, said, ed.node],
      className: "rp-dialog",
      focus: ed.area,
      beforeClose: () => ed.confirmDiscard(),
      actions: [{ label: "Done", value: null, kind: "primary" }],
    });
    await write();
    return dialog;
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

  window.DelphiReport = { editor, describe, keep, writeStatus, statusButton, statusCard };
})();
