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
  notes: {
    list: (projectId) => call("notes:list", projectId),
    create: (payload) => call("notes:create", payload),
    update: (id, fields) => call("notes:update", id, fields),
    remove: (id) => call("notes:delete", id),
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
    providers: () => call("ai:providers"),
    hasKey: () => call("ai:hasKey"),
    setKey: (key) => call("ai:setKey", key),
    send: (payload) => call("ai:send", payload),
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
  onFocusTask: (fn) => ipcRenderer.on("focus-task", (_e, payload) => fn(payload)),
  // A reply arrives a piece at a time, because the renderer cannot make the
  // request itself. Register this once, at module scope: none of the listeners
  // in this file can be removed, so one added inside a render would stack up
  // another copy on every repaint.
  onAiEvent: (fn) => ipcRenderer.on("ai-event", (_e, payload) => fn(payload)),
  // The application menu cannot touch the page directly, so every item that acts
  // on what is displayed arrives here as one message.
  onMenu: (fn) => ipcRenderer.on("menu", (_e, payload) => fn(payload)),
});
