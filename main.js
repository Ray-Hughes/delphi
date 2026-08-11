const { app, BrowserWindow, globalShortcut, ipcMain, shell, screen, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const db = require("./db");

const SETTINGS_PATH = path.join(__dirname, "settings.json");
const DEFAULT_HOTKEY = "Control+T";

let win = null;
let tray = null;
let settings = { hotkey: DEFAULT_HOTKEY };

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
  win = new BrowserWindow({
    width: Math.min(1100, Math.round(width * 0.8)),
    height: Math.min(760, Math.round(height * 0.85)),
    show: false,
    frame: false,
    transparent: false,
    vibrancy: "under-window",
    visualEffectState: "active",
    titleBarStyle: "hiddenInset",
    // Panel-like: floats above other windows so it can be consulted while
    // working, rather than being another window to hunt for.
    alwaysOnTop: true,
    fullscreenable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile("index.html");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Hiding rather than closing keeps the render state, so reopening is instant
  // and you land back where you were rather than at the top of the list.
  win.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      hide();
    }
  });

  // Clicking away dismisses it, which is the behaviour people expect from
  // something summoned by a hotkey.
  win.on("blur", () => {
    if (!win.webContents.isDevToolsOpened()) hide();
  });
}

function show() {
  if (!win) createWindow();
  // Re-centre on the display the pointer is on, so on a multi-monitor desk it
  // appears where you are looking rather than where it was last time.
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const [w, h] = win.getSize();
  win.setPosition(
    Math.round(display.workArea.x + (display.workArea.width - w) / 2),
    Math.round(display.workArea.y + (display.workArea.height - h) / 2)
  );
  win.show();
  win.focus();
  win.webContents.send("shown");
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
  tray.setToolTip("Brain");
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

  // A dock icon would make this feel like an application to manage. It is meant
  // to behave like a panel that is either there or not.
  if (app.dock) app.dock.hide();
});

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
handle("tasks:create", (payload) => db.createTask(payload));
handle("tasks:update", (id, fields) => db.updateTask(id, fields));
handle("tasks:delete", (id) => db.deleteTask(id));

handle("notes:list", (projectId) => db.listNotes(projectId));
handle("notes:create", (payload) => db.createNote(payload));
handle("notes:update", (id, fields) => db.updateNote(id, fields));
handle("notes:delete", (id) => db.deleteNote(id));

handle("links:list", (projectId) => db.listLinks(projectId));
handle("links:create", (payload) => db.createLink(payload));
handle("links:delete", (id) => db.deleteLink(id));

handle("audit:list", (limit) => db.listAudit(limit));
handle("audit:undo", (id) => db.undo(id));
handle("audit:undoLast", (n) => db.undoLast(n));

handle("search", (q) => db.search(q));
handle("stats", () => db.stats());

handle("settings:get", () => settings);
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
