// Focus mode, the main process's half: handing work to an agent, and the
// notice when a break ends.
//
// Delegation goes through the dispatcher's own create, the one the Hand to an
// agent dialog uses, so the folder checks, the harness checks, the History row
// and the Runs list are all the same. The one difference is hold: a job from
// Focus always waits in Needs you for a person's yes, even though a person
// typed it and even where the project auto-approves. Focus hands work over from
// a chat box where Enter sends, and the point of Focus is to be in the middle
// of something else; a stray Enter must cost a click, never a running agent.
//
// The break notice is shown from here because the window may be hidden when a
// break ends (the global hotkey hides it), and a hidden window's own
// notification would still work but would carry no app name on some systems.
//
// Required by main.js, and by tools/focus_test.js with stand-ins, so it takes
// what it touches as arguments.

// Notifications on screen, held so none is collected before it shows.
const shown = new Set();

/**
 * @param handle        main.js's IPC wrapper ({ok, data} on the way back)
 * @param dispatcher    agent/dispatch.js, as main.js made it
 * @param Notification  Electron's, or a stand-in
 */
function register(handle, { dispatcher, Notification = null }) {
  handle("focus:delegate", (payload = {}) => dispatcher.create({
    projectId: payload.projectId ?? null,
    harness: payload.harness,
    request: payload.request,
    taskId: payload.taskId ?? null,
    kind: payload.kind === "do" ? "do" : "ask",
    context: payload.context ?? null,
  }, { by: "you", type: "human", hold: true }));

  handle("focus:notify", (payload = {}) => {
    if (!Notification || (typeof Notification.isSupported === "function" && !Notification.isSupported())) return false;
    const title = String(payload.title || "Delphi").slice(0, 120);
    const body = String(payload.body || "").slice(0, 240);
    const note = new Notification({ title, body, silent: false });
    shown.add(note);
    setTimeout(() => shown.delete(note), 60000);
    note.show();
    return true;
  });
}

module.exports = { register };
