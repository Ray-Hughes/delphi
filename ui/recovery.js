// Picking up where you were, whatever ended the last run.
//
// Three things, all per viewer and all in localStorage, never the database:
//
// - The place: the project, the view, the open task and how far down the list
//   was scrolled, saved as it changes and returned to at launch.
// - Drafts: what was typed into a box and not yet saved, one key per box, so a
//   crash, a reload or a closed window costs nothing that was being written.
//   Cleared the moment the write succeeds; dropped after 30 days unopened.
// - The banner after an unclean exit, from the main process (main/recovery.js),
//   with the runs it interrupted.
//
// Every storage call is wrapped: a private window, a full disk or a blocked
// store makes these features quietly absent, never the window broken.
//
// Loaded after ui/core.js (it builds DOM with el) and before app.js. Under Node
// (tools/recovery_test.js) only the storage halves are used, against a stub.

globalThis.DelphiRecovery = (() => {
  const PLACE = "delphi.place";
  const DRAFT = "delphi.draft.";
  const DRAFT_DAYS = 30;
  const store = () => { try { return globalThis.localStorage || null; } catch { return null; } };
  const read = (key) => { try { const v = store()?.getItem(key); return v == null ? null : JSON.parse(v); } catch { return null; } };
  const write = (key, value) => { try { store()?.setItem(key, JSON.stringify(value)); } catch {} };
  const remove = (key) => { try { store()?.removeItem(key); } catch {} };

  // --- the place ------------------------------------------------------------

  let place = read(PLACE) || {};

  /** The view and project, from render(). The open task and scroll are kept. */
  function remember({ projectId = null, view = null }) {
    if (place.projectId === projectId && place.view === view) return;
    // A different place starts at the top; the scroll belonged to the old one.
    place = { ...place, projectId, view, scroll: 0, at: Date.now() };
    write(PLACE, place);
  }
  function taskOpened(taskId) { place = { ...place, taskId: Number(taskId) || null, at: Date.now() }; write(PLACE, place); }
  function taskClosed() { place = { ...place, taskId: null, at: Date.now() }; write(PLACE, place); }

  let scrollTimer = null;
  /**
   * Follows the scroll of the element with this id, written at most every
   * 300ms. Listened for on the document, in the capture phase, because render()
   * replaces #content with a new element on every paint and a listener on the
   * old one would go with it.
   */
  function watchScroll(root, id) {
    if (!root) return;
    root.addEventListener("scroll", (e) => {
      const node = e.target;
      if (!node || node.id !== id) return;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => { place = { ...place, scroll: Math.round(node.scrollTop) }; write(PLACE, place); }, 300);
    }, { passive: true, capture: true });
  }

  /** Where the last run was, as saved; the caller checks it still exists. */
  const lastPlace = () => ({ ...place });

  // --- drafts ---------------------------------------------------------------

  const draftKey = (kind, id) => `${DRAFT}${kind}.${id}`;
  function saveDraft(kind, id, text) {
    if (text == null || !String(text).trim()) { remove(draftKey(kind, id)); return; }
    write(draftKey(kind, id), { text: String(text), at: Date.now() });
  }
  function draft(kind, id) { const d = read(draftKey(kind, id)); return d && typeof d.text === "string" ? d.text : null; }
  function clearDraft(kind, id) { remove(draftKey(kind, id)); }

  /** Every draft of one kind, for boxes that are only drawn when they hold something. */
  function draftsOf(kind) {
    const out = [];
    const s = store();
    if (!s) return out;
    const prefix = `${DRAFT}${kind}.`;
    try {
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i);
        if (!key || !key.startsWith(prefix)) continue;
        const d = read(key);
        if (d && typeof d.text === "string") out.push({ id: key.slice(prefix.length), text: d.text });
      }
    } catch {}
    return out;
  }

  /** At launch: a draft nobody came back to in 30 days is not coming back. */
  function pruneDrafts(now = Date.now()) {
    const s = store();
    if (!s) return 0;
    const old = [];
    try {
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i);
        if (!key || !key.startsWith(DRAFT)) continue;
        const d = read(key);
        if (!d || !(now - Number(d.at || 0) < DRAFT_DAYS * 24 * 3600 * 1000)) old.push(key);
      }
    } catch {}
    for (const key of old) remove(key);
    return old.length;
  }

  /**
   * A box that keeps what is typed into it. An empty box with a draft waiting
   * gets the draft back, with a quiet note saying so; typing is saved 300ms
   * after it stops. The box's own handlers are left alone.
   */
  function bindDraft(field, kind, id) {
    if (!field || id == null) return field;
    const waiting = draft(kind, id);
    if (waiting && !field.value) {
      field.value = waiting;
      const hint = el("span", { className: "draft-hint", textContent: "Draft restored", role: "status" });
      requestAnimationFrame(() => {
        if (!field.isConnected) return;
        field.insertAdjacentElement("afterend", hint);
        setTimeout(() => hint.remove(), 4000);
      });
      field.dispatchEvent(new Event("input"));
    }
    let timer = null;
    field.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => saveDraft(kind, id, field.value), 300);
    });
    return field;
  }

  // --- the banner -----------------------------------------------------------

  /**
   * "Delphi closed unexpectedly. Nothing was lost." and the runs that stopped,
   * each with Resume and Dismiss. Placed above the page heading, outside what
   * render() replaces, so a repaint never takes it away. Never says crash: the
   * point is that nothing is broken.
   */
  async function showBanner(host, { onChange = () => {} } = {}) {
    let state = null;
    try { state = await window.delphi.recovery.state(); } catch { return; }
    const old = document.getElementById("recovery-banner");
    if (old) old.remove();
    if (!state || !host) return;

    const box = el("section", { id: "recovery-banner", className: "recovery" });
    box.setAttribute("aria-label", "Delphi closed unexpectedly");
    const head = el("div", { className: "recovery-head" });
    const words = el("div", { className: "recovery-words" },
      el("b", { textContent: "Delphi closed unexpectedly. Nothing was lost." }),
      el("span", { textContent: state.runs.length
        ? `${state.runs.length === 1 ? "One run was" : `${state.runs.length} runs were`} stopped part way. Resume picks up where it left off; nothing runs again on its own.`
        : "Everything you had saved is here, and anything you were typing has been kept." }));
    const close = el("button", { className: "btn sm ghost", type: "button", textContent: "Dismiss" });
    close.onclick = async () => {
      close.disabled = true;
      try { await window.delphi.recovery.dismiss(); } catch {}
      box.remove();
    };
    const dot = el("span", { className: "recovery-dot" });
    dot.setAttribute("aria-hidden", "true");
    head.append(dot, words, close);
    box.append(head);

    const list = el("div", { className: "recovery-runs" });
    for (const run of state.runs) {
      const row = el("div", { className: "recovery-run" });
      const resume = el("button", { className: "btn sm primary", type: "button", textContent: "Resume" });
      const drop = el("button", { className: "btn sm", type: "button", textContent: "Dismiss" });
      const why = el("span", { className: "recovery-why" });
      if (run.agentAlive) {
        resume.disabled = true;
        why.textContent = "Its agent may still be running. Resume once it has exited.";
      }
      resume.onclick = async () => {
        resume.disabled = drop.disabled = true;
        try {
          await window.delphi.recovery.resume(run.id);
          onChange();
          showBanner(host, { onChange });
        } catch (error) {
          why.textContent = String(error.message || error);
          resume.disabled = drop.disabled = false;
        }
      };
      drop.onclick = async () => {
        resume.disabled = drop.disabled = true;
        try { await window.delphi.recovery.dismissRun(run.id); } catch {}
        showBanner(host, { onChange });
      };
      row.append(
        el("span", { className: "recovery-id mono", textContent: `#${run.id}` }),
        el("span", { className: "recovery-title", textContent: run.title || "A job" }),
        el("span", { className: "recovery-who", textContent: run.harness || "" }),
        why, resume, drop);
      list.append(row);
    }
    if (state.runs.length) box.append(list);
    host.prepend(box);
  }

  return { remember, taskOpened, taskClosed, watchScroll, lastPlace, saveDraft, draft, clearDraft, draftsOf, pruneDrafts, bindDraft, showBanner };
})();

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.DelphiRecovery;
