const { contextBridge, ipcRenderer } = require("electron");

// Every call returns {ok, data} or {ok:false, error}. Unwrapping here means the
// renderer can await a plain value and handle failure in one place, rather than
// every call site repeating the same check.
const call = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};

contextBridge.exposeInMainWorld("brain", {
  projects: {
    list: () => call("projects:list"),
    create: (payload) => call("projects:create", payload),
    update: (id, fields) => call("projects:update", id, fields),
  },
  tasks: {
    list: (opts) => call("tasks:list", opts),
    create: (payload) => call("tasks:create", payload),
    update: (id, fields) => call("tasks:update", id, fields),
    remove: (id) => call("tasks:delete", id),
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
  audit: {
    list: (limit) => call("audit:list", limit),
    undo: (id) => call("audit:undo", id),
    undoLast: (n) => call("audit:undoLast", n),
  },
  search: (q) => call("search", q),
  stats: () => call("stats"),
  settings: {
    get: () => call("settings:get"),
    setHotkey: (accelerator) => call("settings:setHotkey", accelerator),
  },
  hide: () => ipcRenderer.send("hide"),
  openExternal: (url) => ipcRenderer.send("open-external", url),
  onShown: (fn) => ipcRenderer.on("shown", fn),
});
