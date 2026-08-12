const { app, BrowserWindow, globalShortcut, ipcMain, shell, screen, Tray, Menu, nativeImage, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const db = require("./db");
const vault = require("./vault");
const oracle = require("./oracle");
const embeddings = require("./embeddings");

const SETTINGS_PATH = path.join(__dirname, "settings.json");
const DEFAULT_HOTKEY = "Control+T";

let win = null;
let tray = null;
let settings = {
  hotkey: DEFAULT_HOTKEY,
  snoozeMinutes: 10,
  // Off by default: a window you can full screen and switch to like any other
  // app is the better default. Panel mode is for people who want it to appear
  // over their work and vanish again.
  panelMode: false,
  vaultEnabled: true,
  vaultPath: null,   // null means the default folder beside the app
  // How often the scheduler looks for due reminders. A minute is frequent enough
  // for reminders measured in minutes and cheap enough to ignore.
  checkIntervalSeconds: 60,
  autoRemindBeforeDueHours: 24,
};
let schedulerTimer = null;
let vaultTimer = null;
let lastSeenDbChange = 0;

// The vault is a mirror, so it is rebuilt after changes rather than kept in step
// edit by edit. Debounced because typing in a note fires an update per blur and
// a full rewrite per keystroke would be silly.
function scheduleVaultExport() {
  if (settings.vaultEnabled === false) return;
  if (vaultTimer) clearTimeout(vaultTimer);
  vaultTimer = setTimeout(() => {
    try {
      vault.exportAll(db, settings.vaultPath || vault.DEFAULT_VAULT);
    } catch (error) {
      console.error("vault export failed", error);
    }
    // The graph is derived, so it is rebuilt rather than patched. Doing it here
    // means it can never be staler than the notes it was built from.
    try {
      oracle.rebuild(db.handle());
    } catch (error) {
      console.error("oracle rebuild failed", error);
    }

    // Embedding is asynchronous and can be slow when a model is warming up, so it
    // is not awaited. Rows whose text is unchanged are skipped, so this settles
    // quickly after the first pass regardless of how often it is triggered.
    embeddings
      .reindex(db.handle())
      .then((r) => {
        if (r.embedded) console.log(`oracle: embedded ${r.embedded} via ${r.provider}`);
      })
      .catch((error) => console.error("embedding failed", error));
  }, 1500);
}

function loadSettings() {
  let existing = null;
  try {
    existing = fs.readFileSync(SETTINGS_PATH, "utf8");
    settings = { ...settings, ...JSON.parse(existing) };
  } catch (error) {
    if (existing !== null) {
      // The file is there but is not valid JSON, which means it was hand edited
      // into something broken. Keep it and run on defaults rather than
      // overwriting whatever was being typed.
      console.error(`settings.json is not valid JSON (${error.message}), using defaults`);
      return;
    }
  }
  // Write the file on first run so it exists to be edited. A setting you are
  // told to change in a file that was never created is not a setting.
  if (existing === null) saveSettings();
}

function saveSettings() {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const panel = settings.panelMode === true;

  win = new BrowserWindow({
    width: Math.min(1320, Math.round(width * 0.85)),
    height: Math.min(880, Math.round(height * 0.88)),
    minWidth: 860,
    minHeight: 560,
    show: !panel,                  // a normal app opens; a panel waits for the key
    frame: false,
    titleBarStyle: "hiddenInset",  // keeps the traffic lights, drops the heavy bar
    // In panel mode it floats over the work and cannot be full screened, because
    // a full screen panel is just a window with extra rules.
    alwaysOnTop: panel,
    fullscreenable: !panel,
    skipTaskbar: panel,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile("index.html");
  if (panel) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.webContents.on("did-finish-load", () => {
    win.webContents.send("mode", { panelMode: panel });
  });

  // Closing hides rather than quits in both modes, so the shortcut and the tray
  // can bring it back without a cold start.
  win.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      hide();
    }
  });

  // Only a panel dismisses itself on losing focus. Doing that to a normal window
  // would make it impossible to work alongside anything else.
  if (panel) {
    win.on("blur", () => {
      if (!win.webContents.isDevToolsOpened()) hide();
    });
  }
}

function show() {
  if (!win || win.isDestroyed()) createWindow();

  // A panel re-centres on whichever display the pointer is on, so it appears
  // where you are looking. A normal window stays where you put it, because
  // moving someone's window for them is rude.
  if (settings.panelMode === true) {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const [w, h] = win.getSize();
    win.setPosition(
      Math.round(display.workArea.x + (display.workArea.width - w) / 2),
      Math.round(display.workArea.y + (display.workArea.height - h) / 2)
    );
  }
  win.show();
  win.focus();
  win.webContents.send("shown");
}

// Several window options cannot be changed after creation, so switching mode
// rebuilds the window rather than pretending to toggle them.
function rebuildWindow() {
  const old = win;
  win = null;
  if (old && !old.isDestroyed()) {
    old.removeAllListeners("close");
    old.destroy();
  }
  createWindow();
  if (settings.panelMode !== true) show();
  if (app.dock) settings.panelMode === true ? app.dock.hide() : app.dock.show();
}

function hide() {
  if (win && win.isVisible()) win.hide();
}

function toggle() {
  if (win && win.isVisible()) hide();
  else show();
}

function registerHotkey(accelerator) {
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(accelerator, toggle);
  if (!ok) {
    // Another app owns it. Say so rather than failing silently, which would look
    // like the app is broken.
    console.error(`Could not register ${accelerator}. Another application is probably using it.`);
  }
  return ok;
}

function createTray() {
  // A 16pt template image renders correctly in both light and dark menu bars.
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64," +
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAlUlEQVQ4jaWTQQ7AIAgEF///Z3po" +
      "TCMKuvVEIjOsQERElEBEUlUFAKhqZuYFAOB9773vAWDbtq7ruq6qqmVZAGBmZuacc0RkZgAws7uu" +
      "6wIAM1NVAJiZmXV3d0TEzAAgIu6+7wsAmJmZubu7uyMiZgYAM3P3fV8AwMzM3d3d3RERMwOAmbn7" +
      "vi8AYGbm7u7ujoiYGQD8AItqHkzq2QLLAAAAAElFTkSuQmCC"
  );
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Delphi");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show / hide", accelerator: settings.hotkey, click: toggle },
      { type: "separator" },
      {
        label: "Open database folder",
        click: () => shell.showItemInFolder(db.DB_PATH),
      },
      { label: "Reload", click: () => win && win.reload() },
      { label: "Toggle developer tools", click: () => win && win.webContents.toggleDevTools() },
      { type: "separator" },
      {
        label: "Quit",
        accelerator: "Command+Q",
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("click", toggle);
}

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  createTray();
  registerHotkey(settings.hotkey);
  startScheduler();
  scheduleVaultExport();

  // A panel has no dock presence; a normal application does.
  if (app.dock && settings.panelMode === true) app.dock.hide();
});

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

function showAlert(alert) {
  const title = alert.project_name ? `${alert.project_name}` : "Reminder";
  const body = alert.message || alert.task_title;

  const notification = new Notification({
    title,
    body,
    // Buttons rather than a text reply, so snoozing is one click.
    actions: [{ type: "button", text: "Snooze" }],
    closeButtonText: "Dismiss",
    silent: false,
  });

  // Clicking the body takes you to the task and closes the reminder. Acting on it
  // does not complete the task: opening something is not finishing it.
  notification.on("click", () => {
    db.actOnAlert(alert.id);
    show();
    if (win) win.webContents.send("focus-task", { taskId: alert.task_id, projectId: alert.project_id });
  });

  notification.on("action", () => {
    db.snoozeAlert(alert.id, settings.snoozeMinutes);
    if (win) win.webContents.send("alerts-changed");
  });

  notification.on("close", () => {
    // Closing without acting leaves a one-shot alert finished, so it does not
    // reappear on the next sweep and nag.
    const current = db.listAlerts().find((a) => a.id === alert.id);
    if (current && current.status === "fired" && !current.repeat_every_minutes) {
      db.updateAlert(alert.id, { status: "dismissed" });
      if (win) win.webContents.send("alerts-changed");
    }
  });

  notification.show();
  db.markFired(alert.id);
  if (win) win.webContents.send("alerts-changed");
}

function sweep() {
  try {
    for (const alert of db.dueAlerts()) showAlert(alert);
  } catch (error) {
    // A failing sweep must not take the app down; it runs every minute forever.
    console.error("reminder sweep failed", error);
  }
}

// The vault export and the graph rebuild are triggered by this app's own write
// handlers, so anything written directly to the database is invisible to both. An
// agent writing through the MCP server is exactly that case: the note is stored,
// but it never reaches the markdown mirror and the Oracle cannot find it, which
// defeats the point of letting agents record what they learn.
//
// Watching the file covers every external writer rather than only the one we know
// about, and costs a stat call a minute.
function checkForExternalWrites() {
  try {
    const stat = fs.statSync(db.DB_PATH);
    const changed = stat.mtimeMs;
    if (lastSeenDbChange === 0) {
      lastSeenDbChange = changed;
      return;
    }
    if (changed > lastSeenDbChange) {
      lastSeenDbChange = changed;
      scheduleVaultExport();
      if (win && !win.isDestroyed()) win.webContents.send("alerts-changed");
    }
  } catch (error) {
    console.error("could not check the database for external writes", error);
  }
}

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(() => {
    sweep();
    checkForExternalWrites();
  }, Math.max(15, settings.checkIntervalSeconds) * 1000);
  // Sweep shortly after launch so anything that came due while the app was closed
  // appears rather than waiting for the first interval.
  setTimeout(sweep, 3000);
}

app.on("window-all-closed", (e) => e.preventDefault());
app.on("will-quit", () => globalShortcut.unregisterAll());

// ---------------------------------------------------------------------------
// IPC. Every handler is a thin wrapper so the renderer never touches the
// database directly and the schema stays in one place.
// ---------------------------------------------------------------------------

const handle = (channel, fn) =>
  ipcMain.handle(channel, (_event, ...args) => {
    try {
      return { ok: true, data: fn(...args) };
    } catch (error) {
      // Returning the message rather than throwing keeps the renderer able to
      // show what went wrong instead of a rejected promise with no detail.
      console.error(channel, error);
      return { ok: false, error: String(error.message || error) };
    }
  });

handle("projects:list", () => db.listProjects());
handle("projects:create", (payload) => db.createProject(payload));
handle("projects:update", (id, fields) => db.updateProject(id, fields));

handle("tasks:list", (opts) => db.listTasks(opts));
handle("tasks:create", (payload) => { const r = db.createTask(payload); scheduleVaultExport(); return r; });
handle("tasks:update", (id, fields) => { const r = db.updateTask(id, fields); scheduleVaultExport(); return r; });
handle("tasks:delete", (id) => { const r = db.deleteTask(id); scheduleVaultExport(); return r; });

handle("notes:list", (projectId) => db.listNotes(projectId));
handle("notes:create", (payload) => { const r = db.createNote(payload); scheduleVaultExport(); return r; });
handle("notes:update", (id, fields) => { const r = db.updateNote(id, fields); scheduleVaultExport(); return r; });
handle("notes:delete", (id) => { const r = db.deleteNote(id); scheduleVaultExport(); return r; });

handle("links:list", (projectId) => db.listLinks(projectId));
handle("links:create", (payload) => db.createLink(payload));
handle("links:delete", (id) => db.deleteLink(id));

handle("oracle:stats", () => ({
  ...oracle.stats(db.handle()),
  embeddings: embeddings.status(db.handle()),
}));
handle("oracle:reindex", (force) => embeddings.reindex(db.handle(), { force: !!force }));
handle("oracle:nearest", (query, opts) => embeddings.nearest(db.handle(), query, opts || {}));
handle("oracle:provider", () => embeddings.provider());
handle("oracle:rebuild", () => oracle.rebuild(db.handle()));
handle("oracle:context", (name) => {
  const found = oracle.findEntities(db.handle(), name, 1)[0];
  return found ? oracle.neighbourhood(db.handle(), found.id) : null;
});

handle("vault:export", () => vault.exportAll(db, settings.vaultPath || vault.DEFAULT_VAULT));
handle("vault:reveal", () => {
  const target = settings.vaultPath || vault.DEFAULT_VAULT;
  shell.openPath(target);
  return target;
});

handle("alerts:list", (opts) => db.listAlerts(opts));
handle("alerts:create", (payload) => db.createAlert(payload));
handle("alerts:update", (id, fields) => db.updateAlert(id, fields));
handle("alerts:delete", (id) => db.deleteAlert(id));
handle("alerts:snooze", (id) => db.snoozeAlert(id, settings.snoozeMinutes));
handle("alerts:act", (id) => db.actOnAlert(id));

handle("repos:list", (projectId) => db.listRepos(projectId));
handle("repos:create", (payload) => db.createRepo(payload));
handle("repos:setPrimary", (id) => db.setPrimaryRepo(id));
handle("repos:delete", (id) => db.deleteRepo(id));

handle("recent", (limit) => db.recentItems(limit));
handle("audit:list", (limit) => db.listAudit(limit));
handle("audit:undo", (id) => db.undo(id));
handle("audit:undoLast", (n) => db.undoLast(n));

handle("search", (q) => db.search(q));
handle("stats", () => db.stats());

handle("settings:get", () => settings);
handle("settings:set", (fields) => {
  if (fields.panelMode !== undefined) {
    const next = fields.panelMode === true;
    if (next !== (settings.panelMode === true)) {
      settings.panelMode = next;
      saveSettings();
      rebuildWindow();
      return settings;
    }
  }
  const numeric = ["snoozeMinutes", "checkIntervalSeconds", "autoRemindBeforeDueHours"];
  for (const key of numeric) {
    if (fields[key] !== undefined) {
      const value = Number(fields[key]);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number`);
      settings[key] = value;
    }
  }
  saveSettings();
  if (fields.checkIntervalSeconds !== undefined) startScheduler();
  return settings;
});

handle("settings:setHotkey", (accelerator) => {
  const previous = settings.hotkey;
  if (!registerHotkey(accelerator)) {
    registerHotkey(previous);
    throw new Error(`${accelerator} is already taken by another application`);
  }
  settings.hotkey = accelerator;
  saveSettings();
  return settings;
});

ipcMain.on("hide", hide);
ipcMain.on("open-external", (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});
