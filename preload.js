const { contextBridge, ipcRenderer } = require("electron");

// Every call returns {ok, data} or {ok:false, error}. Unwrapping here means the
// renderer can await a plain value and handle failure in one place, rather than
// every call site repeating the same check.
const call = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};

contextBridge.exposeInMainWorld("delphi", {
  projects: {
    list: () => call("projects:list"),
    archived: () => call("projects:archived"),
    create: (payload) => call("projects:create", payload),
    update: (id, fields) => call("projects:update", id, fields),
    remove: (id, opts) => call("projects:delete", id, opts),
    contents: (id) => call("projects:contents", id),
  },
  tasks: {
    list: (opts) => call("tasks:list", opts),
    create: (payload) => call("tasks:create", payload),
    update: (id, fields) => call("tasks:update", id, fields),
    remove: (id) => call("tasks:delete", id),
    detail: (id) => call("tasks:detail", id),
    queue: (id, queue) => call("tasks:queue", id, queue),
    queueState: (queue, projectId) => call("queue:state", queue, projectId),
    queueRelease: (id, note) => call("queue:release", id, note),
    queueReclaim: (queue, projectId) => call("queue:reclaim", queue, projectId),
    comment: (id, body, author) => call("tasks:comment", id, body, author),
    uncomment: (id) => call("tasks:uncomment", id),
  },
  // A task's Sheet: its comments, each with a kind. Entries come back in one
  // shape whichever side wrote them; see sheet/store.js toEntry.
  sheets: {
    read: (taskId, opts) => call("sheet:read", taskId, opts),
    append: (taskId, payload) => call("sheet:append", taskId, payload),
    promote: (id, on) => call("sheet:promote", id, on),
    file: (id, kind, title) => call("sheet:file", id, kind, title),
    ask: (taskId, question, options) => call("sheet:ask", taskId, question, options),
    decide: (askId, choice, why) => call("sheet:decide", askId, choice, why),
    log: (id) => call("sheet:log", id),
    copy: (id, opts) => call("sheet:copy", id, opts),
    copyAll: (taskId, opts) => call("sheet:copyAll", taskId, opts),
    // Runs a command as a `$ ` entry. Resolves with the entry once it has
    // started or been refused; output arrives on onSheetRunOutput.
    run: (taskId, command) => call("sheet:run", taskId, command),
    interrupt: (entryId) => call("sheet:interrupt", entryId),
  },
  // A task's own folder and branch. Every call takes the Workbench id except
  // forTask, candidates, start and list. Start returns once the folder exists;
  // setup continues and reports on onWorkbenchEvent.
  workbench: {
    forTask: (taskId) => call("workbench:forTask", taskId),
    candidates: (taskId) => call("workbench:candidates", taskId),
    start: (taskId, opts) => call("workbench:start", taskId, opts),
    open: (id, target) => call("workbench:open", id, target),
    status: (id, opts) => call("workbench:status", id, opts),
    park: (id) => call("workbench:park", id),
    resume: (id) => call("workbench:resume", id),
    update: (id) => call("workbench:update", id),
    commit: (id, message) => call("workbench:commit", id, message),
    push: (id) => call("workbench:push", id),
    pr: (id, opts) => call("workbench:pr", id, opts),
    finish: (id) => call("workbench:finish", id),
    discardPlan: (id) => call("workbench:discardPlan", id),
    discard: (id, typed) => call("workbench:discard", id, typed),
    recreate: (id) => call("workbench:recreate", id),
    forget: (id) => call("workbench:forget", id),
    list: (opts) => call("workbench:list", opts),
    advanced: (id) => call("workbench:advanced", id),
  },
  notes: {
    list: (projectId) => call("notes:list", projectId),
    create: (payload) => call("notes:create", payload),
    update: (id, fields) => call("notes:update", id, fields),
    remove: (id) => call("notes:delete", id),
  },
  // The other agents. Turns come back on the same "ai-event" channel the built-in
  // chat uses, because from the window's side they are the same thing.
  harnesses: {
    list: (force) => call("harness:list", force),
    create: (payload) => call("harness:create", payload),
    update: (id, fields) => call("harness:update", id, fields),
    remove: (id) => call("harness:delete", id),
    start: (payload) => call("harness:start", payload),
    stop: (sessionId) => call("harness:stop", sessionId),
  },
  // One agent asking another, and the leases that stop two of them colliding.
  handoffs: {
    list: (opts) => call("handoffs:list", opts),
    create: (payload) => call("handoffs:create", payload),
    cancel: (id) => call("handoffs:cancel", id),
  },
  locks: {
    list: (projectId) => call("locks:list", projectId),
    release: (projectId, key, holder) => call("locks:release", projectId, key, holder),
  },
  pads: {
    list: (projectId) => call("pads:list", projectId),
    get: (id) => call("pads:get", id),
    create: (payload) => call("pads:create", payload),
    // write rather than update, because the body is the pad and replacing it is
    // the normal edit. The name is the one the MCP tool uses too.
    write: (id, fields) => call("pads:write", id, fields),
    append: (id, text) => call("pads:append", id, text),
    remove: (id) => call("pads:delete", id),
    tasks: (id) => call("pads:tasks", id),
  },
  links: {
    list: (projectId) => call("links:list", projectId),
    create: (payload) => call("links:create", payload),
    remove: (id) => call("links:delete", id),
  },
  organizers: {
    list: (projectId) => call("organizers:list", projectId),
    create: (payload) => call("organizers:create", payload),
    update: (id, fields) => call("organizers:update", id, fields),
    remove: (id) => call("organizers:delete", id),
  },
  vault: {
    export: () => call("vault:export"),
    reveal: () => call("vault:reveal"),
  },
  ai: {
    providers: (force) => call("ai:providers", force),
    hasKey: () => call("ai:hasKey"),
    setKey: (key) => call("ai:setKey", key),
    send: (payload) => call("ai:send", payload),
  },
  term: {
    start: (payload) => call("term:start", payload),
    write: (id, text) => call("term:write", id, text),
    stop: (id) => call("term:stop", id),
    sessions: () => call("term:sessions"),
  },
  git: {
    status: (folder) => call("git:status", folder),
    commit: (folder, message, opts) => call("git:commit", folder, message, opts),
    log: (folder, limit) => call("git:log", folder, limit),
  },
  workspaces: {
    list: () => call("workspaces:list"),
    create: (payload) => call("workspaces:create", payload),
    update: (id, fields) => call("workspaces:update", id, fields),
    remove: (id) => call("workspaces:delete", id),
    projects: (id) => call("workspaces:projects", id),
    forProject: (projectId) => call("workspaces:forProject", projectId),
    link: (projectId, workspaceId, opts) => call("workspaces:link", projectId, workspaceId, opts),
    unlink: (projectId, workspaceId) => call("workspaces:unlink", projectId, workspaceId),
  },
  sessions: {
    list: (projectId) => call("sessions:list", projectId),
    get: (id) => call("sessions:get", id),
    create: (payload) => call("sessions:create", payload),
    update: (id, fields) => call("sessions:update", id, fields),
    remove: (id) => call("sessions:delete", id),
    addUsage: (id, usage) => call("sessions:addUsage", id, usage),
  },
  messages: {
    list: (sessionId) => call("messages:list", sessionId),
    append: (payload) => call("messages:append", payload),
    update: (id, fields) => call("messages:update", id, fields),
  },
  fs: {
    createFolder: (parent, name) => call("fs:createFolder", parent, name),
    folderExists: (folder) => call("fs:folderExists", folder),
    reveal: (target) => call("fs:reveal", target),
  },
  dialog: {
    pickFolder: (title, options) => call("dialog:pickFolder", title, options),
  },
  alerts: {
    list: (opts) => call("alerts:list", opts),
    create: (payload) => call("alerts:create", payload),
    update: (id, fields) => call("alerts:update", id, fields),
    remove: (id) => call("alerts:delete", id),
    snooze: (id) => call("alerts:snooze", id),
    act: (id) => call("alerts:act", id),
  },
  repos: {
    list: (projectId) => call("repos:list", projectId),
    create: (payload) => call("repos:create", payload),
    setPrimary: (id) => call("repos:setPrimary", id),
    remove: (id) => call("repos:delete", id),
    // base_branch, setup_cmd and copy_files: the per repository Workbench settings.
    update: (id, fields) => call("repos:update", id, fields),
  },
  oracle: {
    stats: () => call("oracle:stats"),
    rebuild: () => call("oracle:rebuild"),
    context: (name) => call("oracle:context", name),
    graph: (opts) => call("oracle:graph", opts),
    nearest: (query, opts) => call("oracle:nearest", query, opts),
    reindex: (force) => call("oracle:reindex", force),
    provider: () => call("oracle:provider"),
  },
  audit: {
    list: (limit) => call("audit:list", limit),
    project: (projectId, limit) => call("audit:project", projectId, limit),
    undo: (id) => call("audit:undo", id),
    undoLast: (n) => call("audit:undoLast", n),
  },
  recent: (limit) => call("recent", limit),
  search: (q) => call("search", q),
  stats: () => call("stats"),
  settings: {
    get: () => call("settings:get"),
    set: (fields) => call("settings:set", fields),
    setHotkey: (accelerator) => call("settings:setHotkey", accelerator),
  },
  hide: () => ipcRenderer.send("hide"),
  openExternal: (url) => ipcRenderer.send("open-external", url),
  onShown: (fn) => ipcRenderer.on("shown", fn),
  onMode: (fn) => ipcRenderer.on("mode", (_e, payload) => fn(payload)),
  onAlertsChanged: (fn) => ipcRenderer.on("alerts-changed", fn),
  // Another process (an agent, the command line) wrote to the database.
  onDbChanged: (fn) => ipcRenderer.on("db-changed", () => fn()),
  onFocusTask: (fn) => ipcRenderer.on("focus-task", (_e, payload) => fn(payload)),
  // Progress of a Workbench Start: { workbenchId, taskId, phase, text }, phase
  // one of fetching, creating, copying, setup, ready, failed.
  // A composer run's output as it arrives, { entryId, taskId, chunk }, and its
  // finished entry, { entryId, taskId, entry }.
  onSheetRunOutput: (fn) => ipcRenderer.on("sheet-run-output", (_e, payload) => fn(payload)),
  onSheetRunDone: (fn) => ipcRenderer.on("sheet-run-done", (_e, payload) => fn(payload)),
  onWorkbenchEvent: (fn) => ipcRenderer.on("workbench-event", (_e, payload) => fn(payload)),
  // A task with a live Workbench was marked done in the app: offer Finish.
  // { taskId, workbenchId, taskTitle, path, branch, state }
  onWorkbenchPrompt: (fn) => ipcRenderer.on("workbench-prompt", (_e, payload) => fn(payload)),
  // A reply and command output both arrive a piece at a time, because the
  // renderer can neither make the request nor spawn the process. Register these
  // once, at module scope: none of the listeners in this file can be removed, so
  // one added inside a render would stack up another copy on every repaint.
  onAiEvent: (fn) => ipcRenderer.on("ai-event", (_e, payload) => fn(payload)),
  onTermEvent: (fn) => ipcRenderer.on("term-event", (_e, payload) => fn(payload)),
  // The application menu cannot touch the page directly, so every item that acts
  // on what is displayed arrives here as one message.
  onMenu: (fn) => ipcRenderer.on("menu", (_e, payload) => fn(payload)),
});
